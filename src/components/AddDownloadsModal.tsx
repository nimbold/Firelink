import { useCallback, useState, useEffect, useRef } from 'react';
import {
  useDownloadStore,
  getSiteLogin,
  getProxyArgs,
  type AddDownloadAction,
  type PendingAddRequestContext
} from '../store/useDownloadStore';
import { useSettingsStore } from '../store/useSettingsStore';
import type { DownloadItem } from '../bindings/DownloadItem';
import type { MediaPlaylistMetadata } from '../bindings/MediaPlaylistMetadata';
import { FolderPlus, Save, Settings, Shield, RefreshCw, FileText, HardDrive, Database, Link, ArrowRight, Play, ChevronDown, ChevronRight, Video, Film, Music, Copy, type LucideIcon } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { invokeCommand as invoke } from '../ipc';
import { DuplicateResolutionModal, DuplicateConflict } from './DuplicateResolutionModal';
import { canonicalizeDownloadFileName, categoryForFileName, downloadFileNameWithSuffix, downloadFileNamesMatch, downloadMediaKindsMatch, isValidTorrentExcludeTrackerList, isValidTorrentTrackerList, MAX_TORRENT_STOP_TIMEOUT, MAX_TORRENT_TRACKER_INTERVAL, MAX_TORRENT_TRACKER_TIMEOUT, normalizeSpeedLimitForBackend, normalizeTorrentWebSeedDrafts, normalizeTorrentTrackerInterval, normalizeTorrentTrackerTimeout, serializeTorrentPreviewPriority, TORRENT_ENCRYPTION_POLICY_DISABLED, TORRENT_ENCRYPTION_POLICY_FORCE_ENCRYPTION, TORRENT_ENCRYPTION_POLICY_REQUIRE_CRYPTO, type TorrentEncryptionPolicy, type TorrentFileAllocation } from '../utils/downloads';
import { fetchMediaMetadataDeduped, fetchMediaPlaylistMetadataDeduped } from '../utils/mediaMetadata';
import {
  expandTilde,
  resolveCategoryDestination,
  deriveBatchFolderName,
  resolveDownloadFilePath,
  resolveSubfolderDestination,
  sanitizeBatchFolderName,
  downloadLocationEquals,
  resolveInitialAddWindowLocation
} from '../utils/downloadLocations';
import { getPlatformInfo } from '../utils/platform';
import { isTransferLocked } from '../utils/downloadActions';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from 'react-i18next';
import { localeDirection, localePluralVariant, resolveAppLocale } from '../i18n/locales';
import {
  canSubmitMetadataRows,
  appendRequestUrlsAfterVersion,
  commonMediaFormatsForRows,
  commonMediaQualitiesForRows,
  durableDownloadUrl,
  mediaFileNameForSelectedFormat,
  mediaFormatForFormat,
  mediaQualityForFormat,
  mediaQualityForRow,
  mediaTypeForFormat,
  mediaFormatSelectorForRow,
  metadataSummaryState,
  playlistFilePrefix,
  reconcileDownloadRows,
  refreshFailedMetadataRows,
  selectExactMediaSelection,
  updateRowIfCurrent,
  type AddDownloadDraftRow,
  type MediaSelection
} from '../utils/addDownloadMetadata';
import { isTopmostModal, useModalFocus } from '../hooks/useModalFocus';
import { TorrentWebSeedEditor } from './TorrentWebSeedEditor';
import { copyTorrentFilePath as writeTorrentFilePath } from '../utils/torrentFilePath';

const formatBytes = (bytes: number) => {
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const normalizeComparableUrl = (rawUrl: string) => {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith('/') || /^[a-z]:[\\/]/i.test(trimmed)) return trimmed;
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
};

const urlsHaveDifferentOrigins = (sourceUrl: string, targetUrl: string) => {
  try {
    const source = new URL(sourceUrl);
    const target = new URL(targetUrl);
    return source.protocol !== target.protocol
      || source.hostname.toLowerCase() !== target.hostname.toLowerCase()
      || source.port !== target.port;
  } catch {
    return false;
  }
};

const cookieScopeForUrl = (context: PendingAddRequestContext | undefined, targetUrl: string) => {
  if (!context?.cookieScopes?.length) return '';
  try {
    const target = new URL(targetUrl);
    return context.cookieScopes.find(scope => {
      try {
        const scopeUrl = new URL(scope.url);
        const sameGoogleusercontentSite = scopeUrl.protocol === target.protocol
          && scopeUrl.port === target.port
          && scopeUrl.hostname.toLowerCase() === 'googleusercontent.com'
          && target.hostname.toLowerCase().endsWith('.googleusercontent.com');
        return sameGoogleusercontentSite || (scopeUrl.protocol === target.protocol
          && scopeUrl.hostname.toLowerCase() === target.hostname.toLowerCase()
          && scopeUrl.port === target.port);
      } catch {
        return false;
      }
    })?.cookies.trim() || '';
  } catch {
    return '';
  }
};

const isGoogleAuthenticatedCaptureUrl = (rawUrl: string) => {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname === 'mail.google.com'
      || hostname === 'accounts.google.com'
      || hostname === 'googleusercontent.com'
      || hostname.endsWith('.googleusercontent.com');
  } catch {
    return false;
  }
};

const extensionHeaders = (context: PendingAddRequestContext | undefined) => [
  context?.referer ? `Referer: ${context.referer.replace(/[\r\n]/g, '')}` : '',
  context?.media
    ? (context.headers || '')
        .split(/\r?\n/)
        .filter(line => {
          const separator = line.indexOf(':');
          return separator < 0 || line.slice(0, separator).trim().toLowerCase() !== 'cookie';
        })
        .join('\n')
    : context?.headers
].filter(Boolean).join('\n');

export const AddDownloadsModal = () => {
  const { t, i18n } = useTranslation();
  const isRtl = localeDirection(resolveAppLocale(i18n.language)) === 'rtl';
  const { addToast } = useToast();
  const {
    isAddModalOpen,
    pendingAddUrls,
    pendingAddReferer,
    pendingAddFilename,
    pendingAddHeaders,
    pendingAddCookies,
    pendingAddMediaUrls,
    pendingAddTorrentUrls,
    pendingAddBatchName,
    pendingAddRequestContexts,
    pendingAddRequestVersion,
    toggleAddModal,
    addDownload,
    queues
  } = useDownloadStore();
  const {
    baseDownloadFolder,
    rememberLastUsedDownloadDirectory,
    lastUsedDownloadDirectory,
    perServerConnections,
    keychainAccessReady,
    keychainPromptDismissed,
    showKeychainModal
  } = useSettingsStore();

  const [urls, setUrls] = useState('');
  const [selectedItemIndex, setSelectedItemIndex] = useState<number | null>(null);
  const [parsedItems, setParsedItems] = useState<AddDownloadDraftRow[]>([]);
  const parsedItemsRef = useRef<AddDownloadDraftRow[]>([]);
  const addModalOpenRef = useRef(isAddModalOpen);
  const metadataRequestsRef = useRef(new Set<string>());
  const playlistRequestsRef = useRef(new Set<string>());
  const latestPlaylistRequestRef = useRef(new Map<string, string>());
  const cachedTorrentDraftIdsRef = useRef(new Set<string>());
  const [playlistExpansions, setPlaylistExpansions] = useState<Record<string, MediaPlaylistMetadata>>({});

  parsedItemsRef.current = parsedItems;
  addModalOpenRef.current = isAddModalOpen;

  const cleanupDraftTorrentCache = useCallback((ids?: Iterable<string>) => {
    const idsToRemove = ids
      ? Array.from(ids)
      : Array.from(cachedTorrentDraftIdsRef.current);
    idsToRemove.forEach(id => cachedTorrentDraftIdsRef.current.delete(id));
    idsToRemove.forEach(id => {
      void invoke('remove_torrent_metadata', { id }).catch(error => {
        console.warn('Failed to remove temporary torrent metadata:', error);
      });
    });
  }, []);

  const copyTorrentFilePath = useCallback(async (path: string) => {
    try {
      await writeTorrentFilePath(path, writeClipboardText);
      addToast({ message: t($ => $.logs.copied), variant: 'success' });
    } catch (error) {
      console.warn('Failed to copy Torrent file path:', error);
      addToast({ message: t($ => $.downloadTable.copyPathFailed), variant: 'error', isActionable: true });
    }
  }, [addToast, t]);

  useEffect(() => {
    if (!isAddModalOpen) cleanupDraftTorrentCache();
  }, [cleanupDraftTorrentCache, isAddModalOpen]);

  useEffect(() => {
    const activeDraftIds = new Set<string>();
    for (const row of parsedItems) {
      if (!row.isTorrent) continue;
      activeDraftIds.add(row.torrentCacheId || row.id);
      activeDraftIds.add(`${row.id}-${row.generation}`);
    }
    const staleDraftIds = Array.from(cachedTorrentDraftIdsRef.current)
      .filter(id => !activeDraftIds.has(id));
    if (staleDraftIds.length > 0) cleanupDraftTorrentCache(staleDraftIds);
  }, [cleanupDraftTorrentCache, parsedItems]);

  useEffect(() => cleanupDraftTorrentCache, [cleanupDraftTorrentCache]);

  const [conflicts, setConflicts] = useState<DuplicateConflict[]>([]);
  const [showingDuplicates, setShowingDuplicates] = useState(false);
  const modalRef = useModalFocus(isAddModalOpen);
  const [pendingAction, setPendingAction] = useState<AddDownloadAction>({ type: 'start-now' });
  const [pendingUseSharedDestination, setPendingUseSharedDestination] = useState(false);
  const [pendingDestinationOverrides, setPendingDestinationOverrides] = useState<Record<number, string>>({});
  const [resolvedLocation, setResolvedLocation] = useState('');
  const [isQueueMenuOpen, setIsQueueMenuOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  // Right Form
  const [saveLocation, setSaveLocation] = useState(baseDownloadFolder);
  const [isSaveLocationManual, setIsSaveLocationManual] = useState(false);
  const [saveInDedicatedFolder, setSaveInDedicatedFolder] = useState(false);
  const [dedicatedFolderName, setDedicatedFolderName] = useState('');
  const dedicatedFolderNameEditedRef = useRef(false);
  const locationResolutionRequestRef = useRef(0);
  const folderPickerRequestRef = useRef(0);
  const pendingLastUsedDownloadDirectoryRef = useRef<string | null>(null);
  const [connections, setConnections] = useState(perServerConnections);
  const [speedLimitEnabled, setSpeedLimitEnabled] = useState(false);
  const [speedLimit, setSpeedLimit] = useState('1024');
  const [torrentSeedingEnabled, setTorrentSeedingEnabled] = useState(false);
  const [torrentSeedTime, setTorrentSeedTime] = useState('60');
  const [torrentSeedRatio, setTorrentSeedRatio] = useState('1.0');
  const [torrentUploadLimitEnabled, setTorrentUploadLimitEnabled] = useState(false);
  const [torrentUploadLimit, setTorrentUploadLimit] = useState('1024');
  const [torrentMaxPeers, setTorrentMaxPeers] = useState('');
  const [torrentPeerSpeedLimit, setTorrentPeerSpeedLimit] = useState('');
  const [torrentCheckIntegrity, setTorrentCheckIntegrity] = useState(false);
  const [torrentRemoveUnselectedFile, setTorrentRemoveUnselectedFile] = useState(false);
  const [torrentEncryptionPolicy, setTorrentEncryptionPolicy] = useState<TorrentEncryptionPolicy>(TORRENT_ENCRYPTION_POLICY_DISABLED);
  const [torrentTrackers, setTorrentTrackers] = useState('');
  const [torrentExcludeTrackers, setTorrentExcludeTrackers] = useState('');
  const [torrentTrackerConnectTimeout, setTorrentTrackerConnectTimeout] = useState('');
  const [torrentTrackerTimeout, setTorrentTrackerTimeout] = useState('');
  const [torrentTrackerInterval, setTorrentTrackerInterval] = useState('0');
  const [torrentStopTimeout, setTorrentStopTimeout] = useState('0');
  const [torrentFileAllocation, setTorrentFileAllocation] = useState<TorrentFileAllocation>('prealloc');
  const [torrentPreviewHeadEnabled, setTorrentPreviewHeadEnabled] = useState(false);
  const [torrentPreviewHeadSize, setTorrentPreviewHeadSize] = useState('1M');
  const [torrentPreviewTailEnabled, setTorrentPreviewTailEnabled] = useState(false);
  const [torrentPreviewTailSize, setTorrentPreviewTailSize] = useState('1M');
  const torrentPreviewPriority = serializeTorrentPreviewPriority(
    torrentPreviewHeadEnabled,
    torrentPreviewHeadSize,
    torrentPreviewTailEnabled,
    torrentPreviewTailSize
  );
  const [freeSpace, setFreeSpace] = useState('Unknown');
  const freeSpaceRequestRef = useRef(0);

  const addTorrentFiles = async () => {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        title: 'Choose torrent files',
        filters: [{ name: 'Torrent', extensions: ['torrent'] }]
      });
      const paths = Array.isArray(selected)
        ? selected
        : selected
          ? [selected]
          : [];
      if (paths.length === 0) return;
      setUrls(current => [...current.split('\n').map(line => line.trim()).filter(Boolean), ...paths]
        .filter((value, index, values) => values.indexOf(value) === index)
        .join('\n'));
    } catch (error) {
      console.error('Failed to select torrent files:', error);
    }
  };

  const [useAuth, setUseAuth] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [sftpHostKeyMd, setSftpHostKeyMd] = useState('');

  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [playlistQualityExpanded, setPlaylistQualityExpanded] = useState(true);
  const playlistMediaSelectionsRef = useRef(new Map<string, MediaSelection>());
  const [playlistMediaTypeSelections, setPlaylistMediaTypeSelections] = useState<Record<string, MediaSelection['mediaType']>>({});
  const [checksumEnabled, setChecksumEnabled] = useState(false);
  const [checksumAlgo, setChecksumAlgo] = useState('SHA-256');
  const [checksumValue, setChecksumValue] = useState('');
  const [headers, setHeaders] = useState('');
  const [cookies, setCookies] = useState('');
  const headersManuallyEditedRef = useRef(false);
  const cookiesManuallyEditedRef = useRef(false);
  const modalSessionRef = useRef(false);
  const observedRequestVersionRef = useRef(0);
  const [mirrors, setMirrors] = useState('');

  const requestContextForUrl = (url: string) =>
    pendingAddRequestContexts[normalizeComparableUrl(url)];
  const hasExtensionRequestContext = Object.keys(pendingAddRequestContexts).length > 0;
  const headersForRow = (sourceUrl: string) => {
    if (headersManuallyEditedRef.current) return headers.trim();
    const context = requestContextForUrl(sourceUrl);
    if (context) return extensionHeaders(context).trim();
    return hasExtensionRequestContext ? '' : headers.trim();
  };
  const cookiesForRow = (sourceUrl: string, targetUrl = sourceUrl) => {
    if (cookiesManuallyEditedRef.current) return cookies.trim();
    const context = requestContextForUrl(sourceUrl);
    const scopedCookies = cookieScopeForUrl(context, targetUrl);
    if (scopedCookies) return scopedCookies;
    if (context && urlsHaveDifferentOrigins(sourceUrl, targetUrl)) return '';
    if (context) return context.cookies.trim();
    return hasExtensionRequestContext ? '' : cookies.trim();
  };
  const shouldDeferCookiesForRow = (sourceUrl: string) =>
    !cookiesManuallyEditedRef.current
      && Boolean(requestContextForUrl(sourceUrl))
      && !isGoogleAuthenticatedCaptureUrl(sourceUrl);
  const suggestedFilenameForRow = (sourceUrl: string) => {
    const context = requestContextForUrl(sourceUrl);
    if (context?.filename) return context.filename;
    return hasExtensionRequestContext ? '' : pendingAddFilename;
  };
  const requestContextUrlForRow = (row: AddDownloadDraftRow) =>
    row.playlistSourceUrl || row.sourceUrl;

  const closeModalFromDismissAction = useCallback(() => {
    if (isSubmitting || isSubmittingRef.current || showKeychainModal) return;
    const hasPendingInput = Boolean(
      urls.trim() || pendingAddUrls.trim() || parsedItems.some(item => item.selected !== false) || headers.trim() || cookies.trim()
    );
    if (hasPendingInput && !window.confirm(t($ => $.addDownloads.discardSetup))) return;
    toggleAddModal(false);
  }, [cookies, headers, isSubmitting, parsedItems, pendingAddUrls, showKeychainModal, toggleAddModal, urls]);

  useEffect(() => {
    if (!isAddModalOpen) {
      modalSessionRef.current = false;
      ++folderPickerRequestRef.current;
      pendingLastUsedDownloadDirectoryRef.current = null;
      setUrls('');
      setPlaylistExpansions({});
      playlistRequestsRef.current.clear();
      latestPlaylistRequestRef.current.clear();
      playlistMediaSelectionsRef.current.clear();
      setPlaylistMediaTypeSelections({});
      setPlaylistQualityExpanded(true);
      return;
    }

    if (modalSessionRef.current) return;
    modalSessionRef.current = true;
    const initialUrls = pendingAddUrls || '';
    const initialUrlLines = initialUrls.split('\n').map(url => url.trim()).filter(Boolean);
    observedRequestVersionRef.current = pendingAddRequestVersion;
    const initialContext = initialUrlLines.length === 1
      ? requestContextForUrl(initialUrlLines[0])
      : undefined;

    const initialLocation = resolveInitialAddWindowLocation(
      baseDownloadFolder,
      rememberLastUsedDownloadDirectory,
      lastUsedDownloadDirectory
    );
    setSaveLocation(initialLocation.path);
    setIsSaveLocationManual(initialLocation.isManual);
    setSaveInDedicatedFolder(false);
    dedicatedFolderNameEditedRef.current = false;
    setDedicatedFolderName(deriveBatchFolderName(pendingAddBatchName, pendingAddReferer));
    setUrls(initialUrls);
    setParsedItems([]);
    setPlaylistExpansions({});
    metadataRequestsRef.current.clear();
    playlistRequestsRef.current.clear();
    latestPlaylistRequestRef.current.clear();
    playlistMediaSelectionsRef.current.clear();
    setPlaylistMediaTypeSelections({});
    setPlaylistQualityExpanded(true);
    setSelectedItemIndex(null);
    setPendingUseSharedDestination(false);
    setPendingDestinationOverrides({});
    setConnections(perServerConnections);
    setFreeSpace('Unknown');
    setSpeedLimitEnabled(false);
    setSpeedLimit('1024');
    setTorrentSeedingEnabled(false);
    setTorrentSeedTime('60');
    setTorrentSeedRatio('1.0');
    setTorrentUploadLimitEnabled(false);
    setTorrentUploadLimit('1024');
    setTorrentMaxPeers('');
    setTorrentPeerSpeedLimit('');
    setTorrentCheckIntegrity(false);
    setTorrentTrackers('');
    setTorrentExcludeTrackers('');
    setTorrentTrackerConnectTimeout('');
    setTorrentTrackerTimeout('');
    setTorrentTrackerInterval('0');
    setTorrentStopTimeout('0');
    setTorrentFileAllocation('prealloc');
    setTorrentPreviewHeadEnabled(false);
    setTorrentPreviewHeadSize('1M');
    setTorrentPreviewTailEnabled(false);
    setTorrentPreviewTailSize('1M');
    setUseAuth(false);
    setUsername('');
    setPassword('');
    setSftpHostKeyMd('');
    setAdvancedExpanded(false);
    setChecksumEnabled(false);
    setChecksumAlgo('SHA-256');
    setChecksumValue('');
    setHeaders(initialContext ? extensionHeaders(initialContext) : [
      pendingAddReferer ? `Referer: ${pendingAddReferer.replace(/[\r\n]/g, '')}` : '',
      pendingAddHeaders
    ].filter(Boolean).join('\n'));
    headersManuallyEditedRef.current = false;
    setCookies(initialContext?.cookies || pendingAddCookies);
    cookiesManuallyEditedRef.current = false;
    setMirrors('');
    setIsQueueMenuOpen(false);
    isSubmittingRef.current = false;
    setIsSubmitting(false);
  }, [
    isAddModalOpen,
    pendingAddUrls,
    pendingAddReferer,
    pendingAddHeaders,
    pendingAddCookies,
    pendingAddMediaUrls,
    pendingAddBatchName,
    baseDownloadFolder,
    rememberLastUsedDownloadDirectory,
    lastUsedDownloadDirectory,
    perServerConnections
  ]);

  useEffect(() => {
    if (!isAddModalOpen || !modalSessionRef.current
      || observedRequestVersionRef.current === pendingAddRequestVersion) return;
    const observedVersion = observedRequestVersionRef.current;
    observedRequestVersionRef.current = pendingAddRequestVersion;
    // Playlist membership and entry access can depend on the handoff's
    // browser context. Re-discover playlists when a newer extension context
    // arrives instead of reusing entries extracted under stale cookies.
    setPlaylistExpansions({});
    latestPlaylistRequestRef.current.clear();
    playlistMediaSelectionsRef.current.clear();
    setPlaylistMediaTypeSelections({});
    setUrls(current => appendRequestUrlsAfterVersion(
      current,
      pendingAddRequestContexts,
      observedVersion
    ));
  }, [isAddModalOpen, pendingAddRequestContexts, pendingAddRequestVersion]);

  useEffect(() => {
    if (!isQueueMenuOpen) return;
    const closeMenu = (event: PointerEvent) => {
      if (!actionMenuRef.current?.contains(event.target as Node)) {
        setIsQueueMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', closeMenu);
    return () => window.removeEventListener('pointerdown', closeMenu);
  }, [isQueueMenuOpen]);

  useEffect(() => {
    if (!isAddModalOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!isTopmostModal(modalRef.current)) return;
      if (showKeychainModal) return;
      event.preventDefault();
      if (showingDuplicates) {
        setShowingDuplicates(false);
      } else if (isQueueMenuOpen) {
        setIsQueueMenuOpen(false);
      } else {
        closeModalFromDismissAction();
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [closeModalFromDismissAction, isAddModalOpen, isQueueMenuOpen, showKeychainModal, showingDuplicates]);

  useEffect(() => {
    const requestId = ++freeSpaceRequestRef.current;
    if (!isAddModalOpen || !saveLocation) return;

    invoke('get_free_space', { path: saveLocation })
      .then(space => {
        if (freeSpaceRequestRef.current === requestId) {
          setFreeSpace(space);
        }
      })
      .catch(() => {
        if (freeSpaceRequestRef.current === requestId) {
          setFreeSpace('Unknown');
        }
      });
  }, [saveLocation, isAddModalOpen]);

  useEffect(() => {
    const activeUrls = new Set(
      urls.split('\n').map(url => url.trim()).filter(Boolean).map(normalizeComparableUrl)
    );
    for (const sourceUrl of latestPlaylistRequestRef.current.keys()) {
      if (!activeUrls.has(sourceUrl)) {
        latestPlaylistRequestRef.current.delete(sourceUrl);
      }
    }
    for (const sourceUrl of playlistMediaSelectionsRef.current.keys()) {
      if (!activeUrls.has(sourceUrl)) {
        playlistMediaSelectionsRef.current.delete(sourceUrl);
      }
    }
    setPlaylistMediaTypeSelections(current => {
      const retained = Object.fromEntries(
        Object.entries(current).filter(([sourceUrl]) => activeUrls.has(sourceUrl))
      );
      return Object.keys(retained).length === Object.keys(current).length ? current : retained;
    });
    setPlaylistExpansions(current => {
      const retained = Object.fromEntries(
        Object.entries(current).filter(([sourceUrl]) => activeUrls.has(sourceUrl))
      );
      return Object.keys(retained).length === Object.keys(current).length ? current : retained;
    });

    const forcedMediaUrls = new Set(pendingAddMediaUrls.map(normalizeComparableUrl));
    const forcedTorrentUrls = new Set(pendingAddTorrentUrls.map(normalizeComparableUrl));
    const requestFilenames = Object.fromEntries(
      Object.entries(pendingAddRequestContexts)
        .filter(([, context]) => Boolean(context.filename))
        .map(([url, context]) => [url, context.filename])
    );
    const requestContextVersions = Object.fromEntries(
      Object.entries(pendingAddRequestContexts)
        .map(([url, context]) => [url, context.version])
    );
    setParsedItems(current => {
      const selectedBySourceUrl = Object.fromEntries(
        current.map(row => [row.sourceUrl, row.selected !== false])
      );
      for (const row of current) {
        if (row.playlistSourceUrl && !(row.playlistSourceUrl in selectedBySourceUrl)) {
          selectedBySourceUrl[row.playlistSourceUrl] = row.selected !== false;
        }
      }
      return reconcileDownloadRows(
        urls,
        current,
        hasExtensionRequestContext ? undefined : pendingAddFilename || undefined,
        forcedMediaUrls,
        undefined,
        requestFilenames,
        requestContextVersions,
        playlistExpansions,
        selectedBySourceUrl,
        forcedTorrentUrls
      );
    });
  }, [
    urls,
    pendingAddFilename,
    pendingAddMediaUrls,
    pendingAddTorrentUrls,
    pendingAddRequestContexts,
    hasExtensionRequestContext,
    playlistExpansions
  ]);

  useEffect(() => {
    const maxConcurrentMetadataRequests = 4;
    for (const row of parsedItems) {
      if (row.status !== 'loading' || row.selected === false) continue;
      const requestKey = `${row.id}:${row.generation}`;
      const requestSet = row.isPlaylist ? playlistRequestsRef.current : metadataRequestsRef.current;
      if (requestSet.has(requestKey)) continue;
      if (metadataRequestsRef.current.size + playlistRequestsRef.current.size >= maxConcurrentMetadataRequests) {
        break;
      }
      requestSet.add(requestKey);
      if (row.isPlaylist) {
        // Invalidate stale playlist requests before any asynchronous settings,
        // keychain, or network work can yield. Otherwise an old request can
        // become the latest request again after the URL or browser context
        // has already changed.
        latestPlaylistRequestRef.current.set(row.sourceUrl, requestKey);
      }

      void (async () => {
        try {
          const settingsStore = useSettingsStore.getState();
          const login = getSiteLogin(row.sourceUrl, settingsStore);
          const contextUrl = requestContextUrlForRow(row);
          const requestContext = requestContextForUrl(contextUrl);
          if (row.isTorrent) {
            const torrentCacheId = row.torrentCacheId || `${row.id}-${row.generation}`;
            const proxy = await getProxyArgs(settingsStore);
            const torrentData = await invoke('inspect_torrent', {
              source: row.sourceUrl,
              id: torrentCacheId,
              cache: true,
              proxy: proxy ?? undefined,
              headers: headersForRow(contextUrl) || undefined,
              cookies: cookiesForRow(contextUrl, row.sourceUrl) || undefined,
              cookieScopes: requestContext?.cookieScopes || undefined,
              torrent: true
            });
            const isCurrentTorrentDraft = addModalOpenRef.current
              && parsedItemsRef.current.some(currentRow =>
                currentRow.id === row.id
                && currentRow.sourceUrl === row.sourceUrl
                && currentRow.generation === row.generation
                && (currentRow.torrentCacheId || `${currentRow.id}-${currentRow.generation}`) === torrentCacheId
              );
            if (torrentData.torrentPath && isCurrentTorrentDraft) {
              cachedTorrentDraftIdsRef.current.add(torrentCacheId);
            } else if (torrentData.torrentPath) {
              void invoke('remove_torrent_metadata', { id: torrentCacheId }).catch(error => {
                console.warn('Failed to remove stale torrent metadata:', error);
              });
            }
            const totalBytes = torrentData.totalBytes || undefined;
            setParsedItems(current => updateRowIfCurrent(
              current,
              row.id,
              row.sourceUrl,
              row.generation,
              currentRow => ({
                ...currentRow,
                downloadUrl: !row.sourceUrl.trim().toLowerCase().startsWith('magnet:')
                  ? 'torrent:' + torrentData.infoHash
                  : row.sourceUrl,
                file: canonicalizeDownloadFileName(torrentData.name),
                size: totalBytes ? formatBytes(totalBytes) : undefined,
                sizeBytes: totalBytes,
                status: 'ready',
                isTorrent: true,
                torrentPath: torrentData.torrentPath,
                torrentCacheId,
                torrentInfoHash: torrentData.infoHash,
                torrentFiles: torrentData.files,
                selectedTorrentFileIndices: currentRow.selectedTorrentFileIndices
                  ?.filter(index => torrentData.files.some(file => file.index === index))
              })
            ));
            return;
          }
          const proxy = await getProxyArgs(settingsStore);
          if (login && !useAuth && !keychainAccessReady && !keychainPromptDismissed) {
            settingsStore.setShowKeychainModal(true);
            return;
          }
          if (row.isMedia) {
            const { mediaCookieSource } = settingsStore;
            const browserArg = mediaCookieSource !== 'none' ? mediaCookieSource : null;
            let keychainPassword = null;
            if (login && !useAuth && keychainAccessReady) {
              try {
                keychainPassword = await invoke('get_keychain_password', { id: login.id });
              } catch (e) {
                console.warn("Could not fetch keychain password:", e);
              }
            }

            const rowHeaders = headersForRow(contextUrl);
            const rowCookies = cookiesForRow(contextUrl, row.sourceUrl);
            const mediaMetadataArgs = {
              url: row.sourceUrl,
              cookieBrowser: browserArg,
              userAgent: settingsStore.customUserAgent.trim() || null,
              username: useAuth ? username.trim() || null : login?.username || null,
              password: useAuth ? password || null : keychainPassword,
              headers: rowHeaders || null,
              cookies: rowCookies || null,
              proxy
            };

            if (row.isPlaylist) {
              if (playlistExpansions[row.sourceUrl]) return;
              const playlistData = await fetchMediaPlaylistMetadataDeduped({
                ...mediaMetadataArgs,
                url: contextUrl
              });
              if (latestPlaylistRequestRef.current.get(row.sourceUrl) !== requestKey) return;
              if (!playlistData.entries.length) {
                throw new Error(t($ => $.addDownloads.playlistNoEntries));
              }
              setPlaylistExpansions(current => ({
                ...current,
                [row.sourceUrl]: playlistData
              }));
              return;
            }

            const mediaData = await fetchMediaMetadataDeduped(mediaMetadataArgs);
            if (mediaData && mediaData.formats.length > 0) {
              const mappedFormats = mediaData.formats.map(f => {
                const quality = f.resolution || 'Video';
                const container = f.ext.toUpperCase();
                const exactBytes = f.filesize || 0;
                const approxBytes = f.filesize_approx || 0;
                const bytes = exactBytes || approxBytes;
                const isApproximate = !exactBytes && approxBytes > 0;
                return {
                  name: `${quality} ${container}`,
                  quality,
                  ext: f.ext,
                  bytes,
                  isApproximate,
                  formatLabel: f.format_label || f.ext.toUpperCase(),
                  detail: bytes ? `${isApproximate ? '~' : ''}${formatBytes(bytes)}` : t($ => $.addDownloads.unknownSize),
                  selector: f.format_id,
                  type: quality.toLowerCase().includes('audio') ? 'Audio' : 'Video'
                };
              });
              const requestedSelection = row.playlistSourceUrl
                ? playlistMediaSelectionsRef.current.get(row.playlistSourceUrl)
                : undefined;
              const requestedFormatIndex = requestedSelection
                ? mappedFormats.findIndex(format =>
                    mediaTypeForFormat(format) === requestedSelection.mediaType
                    && mediaFormatForFormat(format) === requestedSelection.format
                    && mediaQualityForFormat(format) === requestedSelection.quality
                  )
                : -1;
              const fallbackFormatIndex = requestedSelection
                ? mappedFormats.findIndex(format =>
                    mediaTypeForFormat(format) === requestedSelection.mediaType
                    && mediaQualityForFormat(format) === requestedSelection.quality
                  )
                : -1;
              const selectedFormatIndex = requestedFormatIndex >= 0
                ? requestedFormatIndex
                : fallbackFormatIndex >= 0 ? fallbackFormatIndex : 0;
              const selectedFormat = mappedFormats[selectedFormatIndex];
              setParsedItems(current => updateRowIfCurrent(
                current,
                row.id,
                row.sourceUrl,
                row.generation,
                currentRow => ({
                  ...currentRow,
                  downloadUrl: row.sourceUrl,
                  file: canonicalizeDownloadFileName(
                    `${playlistFilePrefix(row.playlistIndex, row.playlistCount)}${mediaData.title}.${selectedFormat.ext}`
                  ),
                  size: selectedFormat.bytes ? selectedFormat.detail : undefined,
                  sizeBytes: selectedFormat.bytes || undefined,
                  status: 'ready',
                  formats: mappedFormats,
                  selectedFormat: selectedFormatIndex,
                  playlistError: undefined
                })
              ));
            } else {
              throw new Error(t($ => $.addDownloads.invalidMediaMetadata));
            }
          } else {
            let keychainPassword = null;
            if (login && !useAuth && keychainAccessReady) {
              try {
                keychainPassword = await invoke('get_keychain_password', { id: login.id });
              } catch (e) {
                console.warn("Could not fetch keychain password:", e);
              }
            }
            const meta = await invoke('fetch_metadata', {
              url: row.sourceUrl,
              userAgent: settingsStore.customUserAgent.trim() || null,
              username: useAuth ? username.trim() || null : login?.username || null,
              password: useAuth ? password || null : keychainPassword,
              headers: headersForRow(contextUrl) || null,
              cookies: cookiesForRow(contextUrl, row.sourceUrl) || null,
              cookieScopes: requestContext?.cookieScopes || null,
              proxy,
              deferCookies: shouldDeferCookiesForRow(row.sourceUrl)
            });
            // Persist the stable source URL, not the resolved redirect. A
            // redirect target may be a short-lived signed URL (for example,
            // GitHub release assets) and would make later resumes fail after
            // its expiry. The metadata response remains useful for filename,
            // size, and resumability.
            const nextDownloadUrl = durableDownloadUrl(row.sourceUrl);
            setParsedItems(current => updateRowIfCurrent(
              current,
              row.id,
              row.sourceUrl,
              row.generation,
              currentRow => ({
                ...currentRow,
                downloadUrl: nextDownloadUrl || currentRow.downloadUrl,
                file: canonicalizeDownloadFileName(
                  current.length === 1 && suggestedFilenameForRow(contextUrl)
                    ? suggestedFilenameForRow(contextUrl)
                    : meta.filename
                ),
                size: meta.size_bytes ? meta.size : undefined,
                sizeBytes: meta.size_bytes || undefined,
                status: 'ready',
                resumable: meta.resumable,
                metadataBlockedReason: undefined
              })
            ));
          }
        } catch (e) {
          console.error("Meta fetch failed", e);
          const errorMessage = e instanceof Error ? e.message : String(e);
          const metadataBlockedReason = [
            'SSRF blocked: Invalid URL',
            'SSRF blocked: No host',
            'SSRF blocked: DNS resolution failed',
            'SSRF blocked: No DNS records',
            'SSRF blocked: Private/local IP not allowed'
          ].some(prefix => errorMessage.startsWith(prefix))
            ? 'unsafe-url' as const
            : undefined;
          setParsedItems(current => updateRowIfCurrent(
            current,
            row.id,
            row.sourceUrl,
            row.generation,
            currentRow => ({
              ...currentRow,
              downloadUrl: currentRow.sourceUrl,
              size: undefined,
              sizeBytes: undefined,
              status: 'metadata-error',
              formats: undefined,
              selectedFormat: undefined,
              metadataBlockedReason,
              playlistError: row.isPlaylist
                ? errorMessage
                : undefined
            })
          ));
        } finally {
          requestSet.delete(requestKey);
        }
      })();
    }
  }, [
    keychainAccessReady,
    keychainPromptDismissed,
    parsedItems,
    pendingAddFilename,
    pendingAddMediaUrls,
    playlistExpansions,
    useAuth
  ]);

  useEffect(() => {
    if (!rememberLastUsedDownloadDirectory) {
      pendingLastUsedDownloadDirectoryRef.current = null;
    }
  }, [rememberLastUsedDownloadDirectory]);

  useEffect(() => {
    const requestId = ++locationResolutionRequestRef.current;
    if (parsedItems.length === 0) {
      setSelectedItemIndex(null);
      return;
    }
    setSelectedItemIndex(current =>
      current === null || current >= parsedItems.length ? 0 : current
    );
    if (isSaveLocationManual) return;
    if (parsedItems.length > 1) {
      const baseFolder = useSettingsStore.getState().baseDownloadFolder || '~/Downloads';
      void expandTilde(baseFolder).then(location => {
        if (requestId === locationResolutionRequestRef.current) {
          setSaveLocation(location);
        }
      });
      return;
    }
    const first = parsedItems[0];
    if (first.status !== 'ready' && first.status !== 'metadata-error') return;
    void resolveCategoryDestination(
      useSettingsStore.getState(),
      categoryForFileName(first.file, first.isTorrent === true)
    ).then(location => {
      if (requestId === locationResolutionRequestRef.current) {
        setSaveLocation(location);
      }
    });
  }, [isSaveLocationManual, parsedItems]);

  useEffect(() => {
    if (
      !isAddModalOpen
      || parsedItems.length < 2
      || dedicatedFolderNameEditedRef.current
    ) {
      return;
    }
    setDedicatedFolderName(deriveBatchFolderName(
      pendingAddBatchName,
      pendingAddReferer,
      new Date(),
      parsedItems.map(item => item.file)
    ));
  }, [isAddModalOpen, parsedItems, pendingAddBatchName, pendingAddReferer]);

  if (!isAddModalOpen) return null;

  const handleBrowse = async () => {
    try {
      const requestId = ++folderPickerRequestRef.current;
      const defaultPath = await expandTilde(saveLocation);
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath
    });
    if (requestId !== folderPickerRequestRef.current) return;
    if (selected && typeof selected === 'string') {
      ++locationResolutionRequestRef.current;
      const approvedPath = await useSettingsStore.getState().approveDownloadRoot(selected);
      if (requestId !== folderPickerRequestRef.current) return;
      setSaveLocation(approvedPath);
      setIsSaveLocationManual(true);
      const settings = useSettingsStore.getState();
      if (settings.rememberLastUsedDownloadDirectory) {
        pendingLastUsedDownloadDirectoryRef.current = approvedPath;
      }
    }
    } catch (e) {
      console.error("Failed to select folder:", e);
    }
  };

  const categoryLocationForFile = (fileName: string, isTorrent = false) => {
    const category = categoryForFileName(fileName, isTorrent);
    return resolveCategoryDestination(useSettingsStore.getState(), category);
  };

  const commitDedicatedFolderName = () => {
    const safeName = sanitizeBatchFolderName(dedicatedFolderName);
    if (!safeName) {
      addToast({
        message: t($ => $.addDownloads.dedicatedFolderNameRequired),
        variant: 'error',
        isActionable: true
      });
      return;
    }
    dedicatedFolderNameEditedRef.current = true;
    setDedicatedFolderName(safeName);
  };

  const destinationForFile = async (
    fileName: string,
    finalLocation: string,
    useSharedDestination: boolean,
    destinationOverride?: string,
    isTorrent = false
  ): Promise<string> => {
    if (destinationOverride) return destinationOverride;
    const root = useSharedDestination
      ? finalLocation
      : await categoryLocationForFile(fileName, isTorrent);
    return saveInDedicatedFolder
      ? resolveSubfolderDestination(root, dedicatedFolderName)
      : root;
  };

  const revealTorrentAdvanced = (preferredIndex?: number) => {
    setAdvancedExpanded(true);
    setSelectedItemIndex(current => {
      const preferredIsSelectedTorrent = preferredIndex !== undefined
        && parsedItems[preferredIndex]?.selected !== false
        && parsedItems[preferredIndex]?.isTorrent;
      if (preferredIsSelectedTorrent) return preferredIndex;

      const currentIsSelectedTorrent = current !== null
        && parsedItems[current]?.selected !== false
        && parsedItems[current]?.isTorrent;
      if (currentIsSelectedTorrent) return current;

      const firstSelectedTorrentIndex = parsedItems.findIndex(item => item.selected !== false && item.isTorrent);
      return firstSelectedTorrentIndex >= 0 ? firstSelectedTorrentIndex : current;
    });
  };

  const handleAction = async (action: AddDownloadAction) => {
    if (isSubmitting || isSubmittingRef.current || !canSubmitMetadataRows(parsedItems)) {
      return;
    }
    if (speedLimitEnabled && (!Number.isFinite(Number(speedLimit)) || Number(speedLimit) <= 0)) {
      addToast({ message: t($ => $.addDownloads.speedInvalid), variant: 'error', isActionable: true });
      return;
    }
    const hasSelectedTorrent = parsedItems.some(item => item.selected !== false && item.isTorrent);
    if (hasSelectedTorrent && torrentSeedingEnabled && (!Number.isFinite(Number(torrentSeedTime)) || Number(torrentSeedTime) <= 0)) {
      addToast({ message: t($ => $.addDownloads.torrentSeedTimeInvalid), variant: 'error', isActionable: true });
      return;
    }
    if (hasSelectedTorrent && torrentSeedingEnabled && (!Number.isFinite(Number(torrentSeedRatio)) || Number(torrentSeedRatio) < 0)) {
      addToast({ message: t($ => $.addDownloads.torrentSeedRatioInvalid), variant: 'error', isActionable: true });
      return;
    }
    if (hasSelectedTorrent && torrentUploadLimitEnabled && (!Number.isFinite(Number(torrentUploadLimit)) || Number(torrentUploadLimit) <= 0)) {
      addToast({ message: t($ => $.addDownloads.torrentUploadLimitInvalid), variant: 'error', isActionable: true });
      return;
    }
    if (
      hasSelectedTorrent
      && torrentMaxPeers.trim()
      && (!Number.isInteger(Number(torrentMaxPeers)) || Number(torrentMaxPeers) < 0 || Number(torrentMaxPeers) > 1000)
    ) {
      revealTorrentAdvanced();
      addToast({ message: t($ => $.addDownloads.torrentMaxPeersInvalid), variant: 'error', isActionable: true });
      return;
    }
    if (hasSelectedTorrent && torrentPeerSpeedLimit.trim() && !normalizeSpeedLimitForBackend(torrentPeerSpeedLimit)) {
      revealTorrentAdvanced();
      addToast({ message: t($ => $.addDownloads.torrentPeerSpeedLimitInvalid), variant: 'error', isActionable: true });
      return;
    }
    if (hasSelectedTorrent && !isValidTorrentTrackerList(torrentTrackers)) {
      revealTorrentAdvanced();
      addToast({ message: t($ => $.addDownloads.torrentTrackersInvalid), variant: 'error', isActionable: true });
      return;
    }
    if (hasSelectedTorrent && !isValidTorrentExcludeTrackerList(torrentExcludeTrackers)) {
      revealTorrentAdvanced();
      addToast({ message: t($ => $.addDownloads.torrentExcludeTrackersInvalid), variant: 'error', isActionable: true });
      return;
    }
    if (hasSelectedTorrent && torrentTrackerConnectTimeout.trim() && !normalizeTorrentTrackerTimeout(torrentTrackerConnectTimeout)) {
      revealTorrentAdvanced();
      addToast({ message: t($ => $.addDownloads.torrentTrackerTimeoutInvalid), variant: 'error', isActionable: true });
      return;
    }
    if (hasSelectedTorrent && torrentTrackerTimeout.trim() && !normalizeTorrentTrackerTimeout(torrentTrackerTimeout)) {
      revealTorrentAdvanced();
      addToast({ message: t($ => $.addDownloads.torrentTrackerTimeoutInvalid), variant: 'error', isActionable: true });
      return;
    }
    if (hasSelectedTorrent && torrentTrackerInterval.trim() && normalizeTorrentTrackerInterval(torrentTrackerInterval) === undefined) {
      revealTorrentAdvanced();
      addToast({ message: t($ => $.addDownloads.torrentTrackerIntervalInvalid), variant: 'error', isActionable: true });
      return;
    }
    if (hasSelectedTorrent && (torrentPreviewHeadEnabled || torrentPreviewTailEnabled) && !torrentPreviewPriority) {
      revealTorrentAdvanced();
      addToast({ message: t($ => $.addDownloads.torrentPrioritizePieceInvalid), variant: 'error', isActionable: true });
      return;
    }
    for (const [itemIndex, item] of parsedItems.entries()) {
      if (item.selected === false || !item.isTorrent || !item.torrentFiles?.length) continue;
      const rows = item.torrentWebSeedRows ?? [];
      if (!normalizeTorrentWebSeedDrafts(rows, item.torrentFiles)) {
        revealTorrentAdvanced(itemIndex);
        addToast({ message: t($ => $.properties.torrentWebSeedsFailed), variant: 'error', isActionable: true });
        return;
      }
    }
    if (
      hasSelectedTorrent
      && torrentStopTimeout.trim()
      && (!Number.isInteger(Number(torrentStopTimeout)) || Number(torrentStopTimeout) < 0 || Number(torrentStopTimeout) > MAX_TORRENT_STOP_TIMEOUT)
    ) {
      revealTorrentAdvanced();
      addToast({ message: t($ => $.addDownloads.torrentStopTimeoutInvalid), variant: 'error', isActionable: true });
      return;
    }
    const removableTorrentFileCount = parsedItems.reduce((total, item) => {
      if (item.selected === false || !item.isTorrent || !item.torrentFiles?.length) return total;
      const selected = item.selectedTorrentFileIndices;
      if (!selected || selected.length === 0 || selected.length >= item.torrentFiles.length) return total;
      return total + item.torrentFiles.length - selected.length;
    }, 0);
    if (
      torrentRemoveUnselectedFile
      && removableTorrentFileCount > 0
      && !window.confirm(t($ => $.addDownloads.torrentRemoveUnselectedFileConfirm, {
        count: removableTorrentFileCount
      }))
    ) {
      return;
    }
    if (saveInDedicatedFolder && !sanitizeBatchFolderName(dedicatedFolderName)) {
      addToast({
        message: t($ => $.addDownloads.dedicatedFolderNameRequired),
        variant: 'error',
        isActionable: true
      });
      return;
    }
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    ++folderPickerRequestRef.current;
    let finalLocation = saveLocation;
    let useSharedDestination = isSaveLocationManual;
    const destinationOverrides: Record<number, string> = {};
    const settings = useSettingsStore.getState();
    const platform = await getPlatformInfo().catch(() => ({ os: 'unknown' }));
    if (settings.askWhereToSaveEachFile && parsedItems.length > 0) {
      for (const [index, item] of parsedItems.entries()) {
        if (item.selected === false) continue;
        try {
          const suggestedLocation = await destinationForFile(
            item.file,
            finalLocation,
            isSaveLocationManual,
            undefined,
            item.isTorrent === true
          );
          const selected = await open({
            directory: true,
            multiple: false,
            title: `Choose a folder for ${item.file}`,
            defaultPath: await expandTilde(suggestedLocation)
          });
          if (selected && typeof selected === 'string') {
            const approvedPath = await useSettingsStore.getState().approveDownloadRoot(selected);
            destinationOverrides[index] = approvedPath;
            const currentSettings = useSettingsStore.getState();
            if (currentSettings.rememberLastUsedDownloadDirectory) {
              pendingLastUsedDownloadDirectoryRef.current = approvedPath;
            }
          } else {
            pendingLastUsedDownloadDirectoryRef.current = null;
            isSubmittingRef.current = false;
            setIsSubmitting(false);
            return;
          }
        } catch (e) {
          console.error("Failed to select folder:", e);
          pendingLastUsedDownloadDirectoryRef.current = null;
          isSubmittingRef.current = false;
          setIsSubmitting(false);
          return;
        }
      }
    }

    setResolvedLocation(finalLocation);
    const store = useDownloadStore.getState();
    const newConflicts: DuplicateConflict[] = [];
    const plannedTargets: Array<{ location: string; fileName: string }> = [];
    const reservedFilenameMatchIds = new Set<string>();

    for (let i = 0; i < parsedItems.length; i++) {
      const item = parsedItems[i];
      if (item.selected === false) continue;
      let finalFile = item.isMedia
        ? mediaFileNameForSelectedFormat(item.file, item)
        : canonicalizeDownloadFileName(item.file);
      const itemLocation = await destinationForFile(
        finalFile,
        finalLocation,
        useSharedDestination,
        destinationOverrides[i],
        item.isTorrent === true
      );

      const urlMatch = store.downloads.find(d =>
        normalizeComparableUrl(d.url) === normalizeComparableUrl(item.downloadUrl)
        && d.status !== 'failed'
        && d.status !== 'completed'
      );
      const hasBatchConflict = plannedTargets.some(target =>
        downloadLocationEquals(
          target.location,
          target.fileName,
          itemLocation,
          finalFile,
          platform.os
        )
      );
      if (urlMatch) {
        newConflicts.push({
          id: i.toString(),
          fileName: finalFile,
          reason: { type: 'url', msg: t($ => $.addDownloads.urlAlreadyQueued) },
          resolution: 'rename',
          replaceAllowed: !isTransferLocked(urlMatch.status),
          existingDownloadId: urlMatch.id
        });
      } else if (hasBatchConflict) {
        newConflicts.push({
          id: i.toString(),
          fileName: finalFile,
          reason: { type: 'file', msg: t($ => $.addDownloads.destinationConflict) },
          resolution: 'rename',
          replaceAllowed: false
        });
      } else {
        const filenameCandidates: Array<{
          download: DownloadItem;
          sameDestination: boolean;
        }> = [];
        for (const download of store.downloads) {
          if (
            download.status === 'completed'
            || !downloadMediaKindsMatch(download.isMedia, item.isMedia)
            || !downloadFileNamesMatch(download.fileName, finalFile)
          ) {
            continue;
          }
          const destination = download.destination ||
            await resolveCategoryDestination(settings, download.category);
          filenameCandidates.push({
            download,
            sameDestination: downloadLocationEquals(
              destination,
              download.fileName,
              itemLocation,
              finalFile,
              platform.os
            )
          });
        }
        filenameCandidates.sort((left, right) =>
          Number(right.sameDestination) - Number(left.sameDestination)
          || Number(reservedFilenameMatchIds.has(left.download.id)) - Number(reservedFilenameMatchIds.has(right.download.id))
          || (right.download.downloadedBytes ?? 0) - (left.download.downloadedBytes ?? 0)
          || (right.download.fraction ?? 0) - (left.download.fraction ?? 0)
          || left.download.dateAdded.localeCompare(right.download.dateAdded)
        );
        const filenameMatch = filenameCandidates.find(candidate =>
          !reservedFilenameMatchIds.has(candidate.download.id)
        )?.download || filenameCandidates[0]?.download;

        if (filenameMatch) {
          const canReplace = !reservedFilenameMatchIds.has(filenameMatch.id)
            && !isTransferLocked(filenameMatch.status);
          newConflicts.push({
            id: i.toString(),
            fileName: finalFile,
            reason: { type: 'file', msg: t($ => $.addDownloads.matchingDownloadFilename) },
            resolution: canReplace ? 'replace' : 'rename',
            replaceAllowed: canReplace,
            existingDownloadId: filenameMatch.id
          });
          reservedFilenameMatchIds.add(filenameMatch.id);
          plannedTargets.push({ location: itemLocation, fileName: finalFile });
          continue;
        }

        let existingDownload;
        for (const download of store.downloads) {
          const destination = download.destination ||
            await resolveCategoryDestination(settings, download.category);
          if (
            downloadLocationEquals(
              destination,
              download.fileName,
              itemLocation,
              finalFile,
              platform.os
            )
          ) {
            existingDownload = download;
            break;
          }
        }

        let fileExistsOnDisk = false;
        try {
          fileExistsOnDisk = await invoke('check_file_exists', {
            path: await resolveDownloadFilePath(itemLocation, finalFile)
          });
        } catch (e) {
          console.error("Failed to check if file exists on disk:", e);
        }

        if (existingDownload || fileExistsOnDisk) {
          newConflicts.push({
            id: i.toString(),
            fileName: finalFile,
            reason: {
              type: 'file',
              msg: existingDownload
                ? t($ => $.addDownloads.existingDownloadDestination)
                : t($ => $.addDownloads.fileExistsOnDisk)
            },
            resolution: 'rename',
            replaceAllowed: Boolean(existingDownload),
            existingDownloadId: existingDownload?.id
          });
        }
      }
      plannedTargets.push({ location: itemLocation, fileName: finalFile });
    }

    if (newConflicts.length > 0) {
      setConflicts(newConflicts);
      setPendingAction(action);
      setPendingUseSharedDestination(useSharedDestination);
      setPendingDestinationOverrides(destinationOverrides);
      setShowingDuplicates(true);
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      return;
    }

    try {
      await executeAddDownloads(action, finalLocation, useSharedDestination, undefined, destinationOverrides);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const executeAddDownloads = async (
    action: AddDownloadAction,
    finalLocation: string,
    useSharedDestination: boolean,
    resolutions?: { id: string, resolution: 'rename' | 'replace' | 'skip' }[],
    destinationOverrides: Record<number, string> = {}
  ) => {
      let itemsToAdd: Array<AddDownloadDraftRow | null> = parsedItems.map(item =>
        item.selected === false ? null : item
      );
      const platform = await getPlatformInfo().catch(() => ({ os: 'unknown' }));
      let updatedCount = 0;

      if (resolutions) {
         for (const res of resolutions) {
             const idx = parseInt(res.id);
             const item = itemsToAdd[idx];
             if (!item) continue;
             const conflict = conflicts.find(c => c.id === res.id);

             if (res.resolution === 'skip') {
                 itemsToAdd[idx] = null;
             } else if (res.resolution === 'rename') {
                 let finalFile = item.isMedia
                   ? mediaFileNameForSelectedFormat(item.file, item)
                   : canonicalizeDownloadFileName(item.file);
        const itemLocation = await destinationForFile(
          finalFile,
          finalLocation,
          useSharedDestination,
          destinationOverrides[idx],
          item.isTorrent === true
        );
                 
                 let count = 1;
                 let newName = finalFile;
                 let exists = true;
                 const batchTargets: Array<{ location: string; fileName: string }> = [];
                 for (const [candidateIndex, candidate] of itemsToAdd.entries()) {
                   if (!candidate || candidateIndex === idx) continue;
                   const candidateFile = candidate.isMedia
                     ? mediaFileNameForSelectedFormat(candidate.file, candidate)
                     : canonicalizeDownloadFileName(candidate.file);
                   const candidateLocation = await destinationForFile(
                     candidateFile,
                     finalLocation,
                     useSharedDestination,
                     destinationOverrides[candidateIndex],
                     candidate.isTorrent === true
                   );
                   batchTargets.push({ location: candidateLocation, fileName: candidateFile });
                 }
                 
                 while (exists && count < 1000) {
          newName = downloadFileNameWithSuffix(finalFile, ` (${count})`);
          let storeHas = false;
          const currentSettings = useSettingsStore.getState();
          for (const download of useDownloadStore.getState().downloads) {
            const destination = download.destination ||
              await resolveCategoryDestination(currentSettings, download.category);
            if (
              downloadLocationEquals(
                destination,
                download.fileName,
                itemLocation,
                newName,
                platform.os
              ) &&
              download.status !== 'failed'
            ) {
              storeHas = true;
              break;
            }
          }
                     let diskHas = false;
                     try {
                       diskHas = await invoke('check_file_exists', {
                         path: await resolveDownloadFilePath(itemLocation, newName)
                       });
                     } catch(e) {}
                     const batchHas = batchTargets.some(target => downloadLocationEquals(
                         target.location,
                         target.fileName,
                         itemLocation,
                         newName,
                         platform.os
                       ));
                     exists = storeHas || diskHas || batchHas;
                     count++;
                 }
                 if (exists) {
                   throw new Error(t($ => $.addDownloads.noAvailableName, { file: finalFile }));
                 }
                 
                 itemsToAdd[idx] = { ...item, file: newName };
             } else if (res.resolution === 'replace') {
              if (!conflict?.replaceAllowed) {
                const finalFile = item.isMedia
                  ? mediaFileNameForSelectedFormat(item.file, item)
                  : canonicalizeDownloadFileName(item.file);
                throw new Error(t($ => $.addDownloads.cannotReplace, { file: finalFile }));
              }
              const finalFile = item.isMedia
                ? mediaFileNameForSelectedFormat(item.file, item)
                : canonicalizeDownloadFileName(item.file);
        const itemLocation = await destinationForFile(
          finalFile,
          finalLocation,
          useSharedDestination,
          destinationOverrides[idx],
          item.isTorrent === true
        );
        const store = useDownloadStore.getState();
        let existingItem = conflict?.existingDownloadId
          ? store.downloads.find(download => download.id === conflict.existingDownloadId)
          : undefined;
        const currentSettings = useSettingsStore.getState();
        if (!existingItem && !conflict?.existingDownloadId) {
          for (const download of store.downloads) {
            const destination = download.destination ||
              await resolveCategoryDestination(currentSettings, download.category);
            if (
              downloadLocationEquals(
                destination,
                download.fileName,
                itemLocation,
                finalFile,
                platform.os
              )
            ) {
              existingItem = download;
              break;
            }
          }
        }

                 if (existingItem && isTransferLocked(existingItem.status)) {
                   throw new Error(t($ => $.addDownloads.pauseBeforeReplace, { file: existingItem.fileName }));
                 }

                 if (!existingItem) {
                   throw new Error(t($ => $.addDownloads.cannotReplace, { file: finalFile }));
                 }
                const incomingMediaFormat = mediaFormatSelectorForRow(item);
                const mediaFormatChanged = item.isMedia
                  && existingItem.mediaFormatSelector !== incomingMediaFormat;
                const torrentReplacement = Boolean(item.isTorrent) || Boolean(existingItem.isTorrent);
                if (existingItem.status === 'completed' || mediaFormatChanged || torrentReplacement) {
                  // Completed replacements must remove the old file so the
                  // new transfer cannot be treated as an already-complete
                  // aria2 target. A torrent replacement also needs a fresh
                  // identity because its cached metadata is keyed by the
                  // new row ID and its output contract differs from a normal
                  // file transfer. Unfinished ordinary rows use the in-place
                  // path to preserve their resumable assets and progress.
                  await store.removeDownload(existingItem.id, true, false);
                 } else {
                   const contextUrl = requestContextUrlForRow(item);
                   const replaced = await store.replaceDownload(existingItem.id, {
                     url: item.downloadUrl,
                     username: useAuth ? username.trim() : undefined,
                     password: useAuth ? password.trim() : undefined,
                     headers: headersForRow(contextUrl) || undefined,
                     cookies: cookiesForRow(contextUrl, item.downloadUrl) || undefined,
                     mirrors: mirrors.trim() || undefined,
                     lastError: undefined
                   }, pendingAction);
                   if (!replaced) {
                     throw new Error(t($ => $.addDownloads.backendRejectedStart));
                   }

                   // The existing row was updated in place; do not create a
                   // second identity for the same filename.
                   itemsToAdd[idx] = null;
                   updatedCount += 1;
                   continue;
                 }
             }
         }
      }

      let addedCount = 0;
      const failures: string[] = [];

      for (const [itemIndex, item] of itemsToAdd.entries()) {
        if (!item) continue;
        let allocatedId: string | null = null;
        try {
          const id = crypto.randomUUID();
          allocatedId = id;
          const contextUrl = requestContextUrlForRow(item);
          let torrentPath = item.torrentPath;
          if (item.isTorrent) {
            if (item.torrentPath) {
              torrentPath = await invoke('rekey_torrent_metadata', {
                sourceId: item.torrentCacheId || item.id,
                targetId: id
              });
              cachedTorrentDraftIdsRef.current.delete(item.torrentCacheId || item.id);
            } else {
              // Keep a safe fallback for rows restored from an older draft
              // shape that did not retain the preview cache identity.
              const proxy = item.sourceUrl.trim().toLowerCase().startsWith('magnet:')
                ? await getProxyArgs(useSettingsStore.getState())
                : undefined;
              const torrentData = await invoke('inspect_torrent', {
                source: item.sourceUrl,
                id,
                cache: true,
                proxy: proxy ?? undefined,
                headers: headersForRow(contextUrl) || undefined,
                cookies: cookiesForRow(contextUrl, item.sourceUrl) || undefined,
                cookieScopes: requestContextForUrl(contextUrl)?.cookieScopes || undefined,
                torrent: true
              });
              torrentPath = torrentData.torrentPath;
            }
          }
          let finalFile = item.isMedia
            ? mediaFileNameForSelectedFormat(item.file, item)
            : canonicalizeDownloadFileName(item.file);
          let formatSelector = mediaFormatSelectorForRow(item);
        const category = categoryForFileName(finalFile, item.isTorrent === true);
        const added = await addDownload({
          id,
          url: item.downloadUrl,
          fileName: finalFile,
          category,
          dateAdded: new Date().toISOString(),
          // HTTP connections and yt-dlp fragment concurrency are separate
          // from BitTorrent peer limits. Torrent rows use bt-max-peers below
          // and must not inherit the generic 1–16 HTTP setting.
          connections: item.isTorrent ? undefined : Number(connections),
          speedLimit: speedLimitEnabled ? `${speedLimit}K` : undefined,
          username: useAuth ? username.trim() : undefined,
          password: useAuth ? password.trim() : undefined,
          sftpHostKeyMd: !item.isTorrent && item.sourceUrl.trim().toLowerCase().startsWith('sftp:')
            ? sftpHostKeyMd.trim() || undefined
            : undefined,
          headers: headersForRow(contextUrl) || undefined,
          checksum: checksumEnabled && checksumValue.trim()
            ? `${checksumAlgo}=${checksumValue.trim()}`
            : undefined,
          cookies: cookiesForRow(contextUrl, item.downloadUrl) || undefined,
          mirrors: mirrors.trim() || undefined,
          destination: useSharedDestination || saveInDedicatedFolder || destinationOverrides[itemIndex]
            ? await destinationForFile(
                finalFile,
                finalLocation,
                useSharedDestination,
                destinationOverrides[itemIndex],
                item.isTorrent === true
              )
            : undefined,
          isMedia: item.isMedia,
          resumable: item.resumable,
          mediaFormatSelector: formatSelector,
          mediaQuality: mediaQualityForRow(item),
          isTorrent: item.isTorrent,
          torrentPath,
          torrentInfoHash: item.torrentInfoHash,
          torrentFileIndices: item.selectedTorrentFileIndices,
          torrentSeedTime: item.isTorrent && torrentSeedingEnabled ? Number(torrentSeedTime) : undefined,
          torrentSeedRatio: item.isTorrent && torrentSeedingEnabled ? Number(torrentSeedRatio) : undefined,
          torrentUploadLimit: item.isTorrent && torrentUploadLimitEnabled ? `${torrentUploadLimit}K` : undefined,
          torrentMaxPeers: item.isTorrent && torrentMaxPeers.trim() ? Number(torrentMaxPeers) : undefined,
          torrentPeerSpeedLimit: item.isTorrent
            ? normalizeSpeedLimitForBackend(torrentPeerSpeedLimit) || undefined
            : undefined,
          torrentCheckIntegrity: item.isTorrent ? torrentCheckIntegrity : undefined,
          torrentRemoveUnselectedFile: item.isTorrent && torrentRemoveUnselectedFile && hasPartialTorrentSelection(item)
            ? true
            : undefined,
          torrentEncryptionPolicy: item.isTorrent && torrentEncryptionPolicy !== TORRENT_ENCRYPTION_POLICY_DISABLED
            ? torrentEncryptionPolicy
            : undefined,
          torrentTrackers: item.isTorrent ? torrentTrackers.trim() || undefined : undefined,
          torrentExcludeTrackers: item.isTorrent ? torrentExcludeTrackers.trim() || undefined : undefined,
          torrentTrackerConnectTimeout: item.isTorrent && torrentTrackerConnectTimeout.trim()
            ? Number(torrentTrackerConnectTimeout)
            : undefined,
          torrentTrackerTimeout: item.isTorrent && torrentTrackerTimeout.trim()
            ? Number(torrentTrackerTimeout)
            : undefined,
          torrentTrackerInterval: item.isTorrent && torrentTrackerInterval.trim()
            ? Number(torrentTrackerInterval)
            : undefined,
          torrentStopTimeout: item.isTorrent && torrentStopTimeout.trim() ? Number(torrentStopTimeout) : undefined,
          torrentPrioritizePiece: item.isTorrent ? torrentPreviewPriority || undefined : undefined,
          torrentFileAllocation: item.isTorrent ? torrentFileAllocation : undefined,
          torrentWebSeeds: item.isTorrent && item.torrentFiles
            ? normalizeTorrentWebSeedDrafts(item.torrentWebSeedRows ?? [], item.torrentFiles) || undefined
            : undefined,
          size: item.size || (item.sizeBytes ? formatBytes(item.sizeBytes) : undefined),
          sizeBytes: item.sizeBytes
        }, action);
        if (!added) {
          throw new Error(t($ => $.addDownloads.backendRejectedStart));
        }
        addedCount += 1;
        } catch (e) {
          if (item.isTorrent && allocatedId) {
            await invoke('remove_torrent_metadata', { id: allocatedId }).catch(error => {
              console.warn('Failed to remove cached torrent metadata after add failure:', error);
            });
          }
          console.error("Invalid URL or failed to add:", e);
          failures.push(`${item.file}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const currentSettings = useSettingsStore.getState();
      if (
        addedCount > 0
        && currentSettings.rememberLastUsedDownloadDirectory
        && pendingLastUsedDownloadDirectoryRef.current
      ) {
        currentSettings.setLastUsedDownloadDirectory(
          pendingLastUsedDownloadDirectoryRef.current
        );
      }
      pendingLastUsedDownloadDirectoryRef.current = null;
      toggleAddModal(false);
      if (failures.length > 0) {
        addToast({
          message: t($ => $.addDownloads.addedWithFailures, { added: addedCount, failed: failures.length, detail: failures[0] }),
          variant: 'error',
          isActionable: true
        });
      } else if (addedCount > 0) {
        addToast({
          message: addedCount === 1
            ? t($ => $.addDownloads.addedOne)
            : t($ => $.addDownloads.addedMany, { count: addedCount }),
          variant: 'success'
        });
      } else if (updatedCount > 0) {
        addToast({
          message: updatedCount === 1
            ? t($ => $.addDownloads.updatedOne)
            : t($ => $.addDownloads.updatedMany, { count: updatedCount }),
          variant: 'success'
        });
      }
  };

  const SummaryBox = ({ title, value, icon: Icon, color }: {
    title: string;
    value: string | number;
    icon: LucideIcon;
    color: string;
  }) => (
    <div className="add-download-summary-card flex flex-col">
      <div className="flex items-center gap-1.5 text-text-muted mb-1">
        <Icon size={12} className={color} />
        <span className="text-[10px] font-semibold uppercase tracking-wider">{title}</span>
      </div>
      <span className="text-sm font-semibold text-text-primary truncate">{value}</span>
    </div>
  );

  const toggleRowSelection = (index: number) => {
    setParsedItems(items => items.map((item, itemIndex) =>
      itemIndex === index ? { ...item, selected: item.selected === false } : item
    ));
  };

  const toggleAllRows = () => {
    setParsedItems(items => {
      const shouldSelect = items.some(item => item.selected === false);
      return items.map(item => ({ ...item, selected: shouldSelect }));
    });
  };

  const clearPlaylistMediaSelection = (sourceUrl: string | undefined) => {
    if (!sourceUrl) return;
    playlistMediaSelectionsRef.current.delete(sourceUrl);
    setPlaylistMediaTypeSelections(current => {
      if (!(sourceUrl in current)) return current;
      const next = { ...current };
      delete next[sourceUrl];
      return next;
    });
  };

  const selectMediaFormat = (index: number) => {
    if (selectedItemIndex === null) return;
    const selectedItem = parsedItems[selectedItemIndex];
    const format = selectedItem?.formats?.[index];
    if (!selectedItem || !format) return;
    clearPlaylistMediaSelection(selectedItem.playlistSourceUrl);

    setParsedItems(items => items.map((item, itemIndex) =>
      itemIndex === selectedItemIndex
        ? {
            ...item,
            selectedFormat: index,
            size: format.bytes ? format.detail : undefined,
            sizeBytes: format.bytes || undefined,
            file: mediaFileNameForSelectedFormat(item.file, {
              formats: item.formats,
              selectedFormat: index
            })
          }
        : item
    ));
  };

  const toggleTorrentFile = (index: number) => {
    if (selectedItemIndex === null) return;
    setParsedItems(items => items.map((item, itemIndex) => {
      if (itemIndex !== selectedItemIndex || !item.torrentFiles?.length) return item;
      const allIndices = item.torrentFiles.map(file => file.index);
      const selectedIndices = item.selectedTorrentFileIndices ?? allIndices;
      if (selectedIndices.length === 1 && selectedIndices[0] === index) return item;
      const next = selectedIndices.includes(index)
        ? selectedIndices.filter(value => value !== index)
        : [...selectedIndices, index].sort((left, right) => left - right);
      return {
        ...item,
        selectedTorrentFileIndices: next.length === allIndices.length ? undefined : next
      };
    }));
  };

  const selectedItems = parsedItems.filter(item => item.selected !== false);
  const hasPartialTorrentSelection = (item: AddDownloadDraftRow): boolean => {
    if (!item.isTorrent || !item.torrentFiles?.length) return false;
    const selected = item.selectedTorrentFileIndices;
    return Boolean(selected && selected.length > 0 && selected.length < item.torrentFiles.length);
  };
  const selectedItem = selectedItemIndex === null ? undefined : parsedItems[selectedItemIndex];
  const selectedItemIsTorrent = selectedItem?.isTorrent === true;
  const hasSftpRows = parsedItems.some(item => item.selected !== false
    && !item.isTorrent
    && item.sourceUrl.trim().toLowerCase().startsWith('sftp:'));
  const selectedPlaylistSourceUrl = selectedItem?.playlistSourceUrl;
  const selectedPlaylistRows = selectedPlaylistSourceUrl
    ? parsedItems.filter(item => item.playlistSourceUrl === selectedPlaylistSourceUrl && item.selected !== false)
    : [];
  const selectedPlaylistReadyRows = selectedPlaylistRows.filter(item =>
    item.isMedia && item.status === 'ready' && Boolean(item.formats?.length)
  );
  const selectedPlaylistFormatObject = selectedItem?.formats?.[selectedItem.selectedFormat ?? -1]
    || selectedPlaylistReadyRows[0]?.formats?.[selectedPlaylistReadyRows[0].selectedFormat ?? -1];
  const detectedPlaylistMediaType = selectedPlaylistFormatObject
    ? mediaTypeForFormat(selectedPlaylistFormatObject)
    : 'Video';
  const playlistVideoFormatOptions = commonMediaFormatsForRows(selectedPlaylistRows, 'Video');
  const playlistAudioFormatOptions = commonMediaFormatsForRows(selectedPlaylistRows, 'Audio');
  const requestedPlaylistMediaType = selectedPlaylistSourceUrl
    ? playlistMediaTypeSelections[selectedPlaylistSourceUrl]
    : undefined;
  const selectedPlaylistMediaType = requestedPlaylistMediaType === 'Audio' && playlistAudioFormatOptions.length > 0
    ? 'Audio'
      : requestedPlaylistMediaType === 'Video' && playlistVideoFormatOptions.length > 0
      ? 'Video'
      : detectedPlaylistMediaType === 'Audio' && playlistAudioFormatOptions.length > 0
        ? 'Audio'
        : playlistVideoFormatOptions.length > 0 ? 'Video' : 'Audio';
  const playlistFormatOptions = selectedPlaylistMediaType === 'Audio'
    ? playlistAudioFormatOptions
    : playlistVideoFormatOptions;
  const hasPlaylistFormatOptions = playlistVideoFormatOptions.length > 0
    || playlistAudioFormatOptions.length > 0;
  const currentPlaylistFormat = selectedPlaylistFormatObject
    ? mediaFormatForFormat(selectedPlaylistFormatObject)
    : undefined;
  const selectedPlaylistFormat = currentPlaylistFormat && playlistFormatOptions.includes(currentPlaylistFormat)
    ? currentPlaylistFormat
    : playlistFormatOptions[0];
  const playlistQualityOptions = selectedPlaylistFormat
    ? commonMediaQualitiesForRows(
        selectedPlaylistRows,
        selectedPlaylistMediaType,
        selectedPlaylistFormat
      )
    : [];
  const playlistSelectionForRow = (row: AddDownloadDraftRow): MediaSelection | undefined => {
    const format = row.formats?.[row.selectedFormat ?? -1];
    return format ? {
      mediaType: mediaTypeForFormat(format),
      format: mediaFormatForFormat(format),
      quality: mediaQualityForFormat(format)
    } : undefined;
  };
  const appliedPlaylistSelection = selectedPlaylistReadyRows.length > 0
    ? (() => {
        const firstSelection = playlistSelectionForRow(selectedPlaylistReadyRows[0]);
        return firstSelection && selectedPlaylistReadyRows.every(row => {
          const selection = playlistSelectionForRow(row);
          return selection?.mediaType === firstSelection.mediaType
            && selection.format === firstSelection.format
            && selection.quality === firstSelection.quality;
        })
          ? firstSelection
          : undefined;
      })()
    : undefined;
  const appliedPlaylistFormat = selectedPlaylistReadyRows.length > 0
    ? (() => {
        const firstSelection = playlistSelectionForRow(selectedPlaylistReadyRows[0]);
        return firstSelection
          && firstSelection.mediaType === selectedPlaylistMediaType
          && selectedPlaylistReadyRows.every(row => {
            const selection = playlistSelectionForRow(row);
            return selection?.mediaType === selectedPlaylistMediaType
              && selection.format === firstSelection.format;
          })
          ? firstSelection.format
          : undefined;
      })()
    : undefined;
  const applyPlaylistMediaSelection = (selection: MediaSelection) => {
    if (!selectedPlaylistSourceUrl) return;
    playlistMediaSelectionsRef.current.set(selectedPlaylistSourceUrl, selection);
    setPlaylistMediaTypeSelections(current => ({
      ...current,
      [selectedPlaylistSourceUrl]: selection.mediaType
    }));
    const selectedIds = selectedPlaylistReadyRows.map(item => item.id);
    setParsedItems(items => selectExactMediaSelection(items, selectedIds, selection));
  };
  const applyPlaylistMediaQuality = (quality: string) => {
    if (!selectedPlaylistFormat) return;
    applyPlaylistMediaSelection({
      mediaType: selectedPlaylistMediaType,
      format: selectedPlaylistFormat,
      quality
    });
  };
  const applyPlaylistMediaFormat = (format: string) => {
    const qualityOptions = commonMediaQualitiesForRows(
      selectedPlaylistRows,
      selectedPlaylistMediaType,
      format
    );
    const currentQuality = appliedPlaylistSelection?.quality
      || mediaQualityForRow(selectedPlaylistReadyRows[0]);
    const quality = currentQuality && qualityOptions.includes(currentQuality)
      ? currentQuality
      : qualityOptions[0];
    if (!quality) return;
    applyPlaylistMediaSelection({
      mediaType: selectedPlaylistMediaType,
      format,
      quality
    });
  };
  const allRowsSelected = parsedItems.length > 0 && selectedItems.length === parsedItems.length;
  const requiredBytes = selectedItems.reduce((acc, item) => acc + (item.sizeBytes || 0), 0);
  const hasApproximateSize = selectedItems.some(item =>
    item.formats?.[item.selectedFormat ?? -1]?.isApproximate
  );
  const requiredStr = requiredBytes > 0
    ? `${hasApproximateSize ? '~' : ''}${requiredBytes < 1024 * 1024 ? `${(requiredBytes / 1024).toFixed(1)} KB`
       : requiredBytes < 1024 * 1024 * 1024 ? `${(requiredBytes / 1024 / 1024).toFixed(1)} MB`
       : `${(requiredBytes / 1024 / 1024 / 1024).toFixed(2)} GB`}`
    : 'Unknown';
  const canSubmit = canSubmitMetadataRows(parsedItems);
  const failedMetadataCount = selectedItems.filter(item => item.status === 'metadata-error').length;
  const failedMediaMetadataCount = selectedItems.filter(
    item => item.status === 'metadata-error' && item.isMedia
  ).length;
  const blockedMetadataCount = selectedItems.filter(
    item => item.metadataBlockedReason === 'unsafe-url'
  ).length;
  const fallbackMetadataCount = failedMetadataCount - failedMediaMetadataCount - blockedMetadataCount;
  const readyMetadataCount = selectedItems.filter(item => item.status === 'ready').length;
  const hasCustomTorrentOptions = Boolean(
    torrentMaxPeers.trim()
    || torrentPeerSpeedLimit.trim()
    || torrentCheckIntegrity
    || torrentRemoveUnselectedFile
    || torrentEncryptionPolicy !== TORRENT_ENCRYPTION_POLICY_DISABLED
    || torrentTrackers.trim()
    || torrentExcludeTrackers.trim()
    || torrentTrackerConnectTimeout.trim()
    || torrentTrackerTimeout.trim()
    || (torrentTrackerInterval.trim() && normalizeTorrentTrackerInterval(torrentTrackerInterval) !== 0)
    || (torrentStopTimeout.trim() && Number(torrentStopTimeout) !== 0)
    || torrentFileAllocation !== 'prealloc'
    || torrentPreviewHeadEnabled
    || torrentPreviewTailEnabled
    || parsedItems.some(item => item.selected !== false && item.isTorrent && (item.torrentWebSeedRows?.length ?? 0) > 0)
  );
  const localizedSelectedSummary = t($ => $.addDownloads.selectedSummary, {
    ready: readyMetadataCount,
    fallback: fallbackMetadataCount,
    mediaRetry: failedMediaMetadataCount,
    blocked: blockedMetadataCount,
  });
  const activePlaylistUrls = new Set(
    urls.split('\n').map(url => url.trim()).filter(Boolean).map(normalizeComparableUrl)
  );
  const playlistSummaries = Object.entries(playlistExpansions)
    .filter(([sourceUrl]) => activePlaylistUrls.has(sourceUrl));
  const pluralMessage = (
    count: number,
    one: () => string,
    few: () => string,
    many: () => string
  ): string => {
    switch (localePluralVariant(i18n.language, count)) {
      case 'one': return one();
      case 'few': return few();
      case 'many': return many();
    }
  };
  const metadataSummary = (() => {
    const summary = metadataSummaryState(parsedItems);
    switch (summary.type) {
      case 'empty': return t($ => $.addDownloads.pasteOneOrMore);
      case 'none-selected': return t($ => $.addDownloads.selectAtLeastOne);
      case 'invalid': return pluralMessage(
        summary.count,
        () => t($ => $.addDownloads.correctInvalidOne, { count: summary.count }),
        () => t($ => $.addDownloads.correctInvalidFew, { count: summary.count }),
        () => t($ => $.addDownloads.correctInvalidMany, { count: summary.count })
      );
      case 'loading': return pluralMessage(
        summary.count,
        () => t($ => $.addDownloads.waitingForMetadataOne, { count: summary.count }),
        () => t($ => $.addDownloads.waitingForMetadataFew, { count: summary.count }),
        () => t($ => $.addDownloads.waitingForMetadataMany, { count: summary.count })
      );
      case 'unsafe': return pluralMessage(
        summary.count,
        () => t($ => $.addDownloads.removeUnsafeOne, { count: summary.count }),
        () => t($ => $.addDownloads.removeUnsafeFew, { count: summary.count }),
        () => t($ => $.addDownloads.removeUnsafeMany, { count: summary.count })
      );
      case 'media-error': return pluralMessage(
        summary.count,
        () => t($ => $.addDownloads.mediaMetadataUnavailableSummaryOne, { count: summary.count }),
        () => t($ => $.addDownloads.mediaMetadataUnavailableSummaryFew, { count: summary.count }),
        () => t($ => $.addDownloads.mediaMetadataUnavailableSummaryMany, { count: summary.count })
      );
      case 'all-error': return t($ => $.addDownloads.metadataUnavailableFallback);
      case 'fallback': return pluralMessage(
        summary.ready,
        () => t($ => $.addDownloads.fallbackReadyOne, { ready: summary.ready, failed: summary.failed }),
        () => t($ => $.addDownloads.fallbackReadyFew, { ready: summary.ready, failed: summary.failed }),
        () => t($ => $.addDownloads.fallbackReadyMany, { ready: summary.ready, failed: summary.failed })
      );
      case 'ready': return pluralMessage(
        summary.count,
        () => t($ => $.addDownloads.readyToAddOne, { count: summary.count }),
        () => t($ => $.addDownloads.readyToAddFew, { count: summary.count }),
        () => t($ => $.addDownloads.readyToAddMany, { count: summary.count })
      );
    }
  })();

  return (
    <>
      {showingDuplicates && (
        <DuplicateResolutionModal 
          conflicts={conflicts} 
          onConfirm={(resolutions) => {
            if (isSubmittingRef.current) return;
            isSubmittingRef.current = true;
            setShowingDuplicates(false);
            setIsSubmitting(true);
            void executeAddDownloads(
              pendingAction,
              resolvedLocation,
              pendingUseSharedDestination,
              resolutions,
              pendingDestinationOverrides
            )
              .catch(error => {
                addToast({
                  message: t($ => $.addDownloads.duplicateResolveFailed, { detail: String(error) }),
                  variant: 'error',
                  isActionable: true
                });
              })
              .finally(() => {
                isSubmittingRef.current = false;
                setIsSubmitting(false);
              });
          }} 
          onCancel={() => setShowingDuplicates(false)} 
        />
      )}
    <div
      className="app-modal-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) closeModalFromDismissAction();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-downloads-modal-title"
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        data-modal-surface="true"
        className="app-modal add-download-modal flex flex-col overflow-hidden text-sm"
      >

        {/* Main Content Split */}
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* Left Column: URLs and Preview */}
          <div className="add-download-left w-[55%] flex flex-col">
            <div className="add-download-pane p-5 flex-1 min-h-0 min-w-0 flex flex-col gap-5">

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="add-download-section-title flex items-center gap-2">
                    <Link size={16} className="text-blue-500" />
                    <span id="add-downloads-modal-title">{t($ => $.addDownloads.downloadLinks)}</span>
                  </div>
                </div>
                <textarea
                  id="add-download-links-input"
                  aria-describedby="add-download-links-hint"
                  className={`add-download-control add-download-links-input w-full h-24 p-3 text-[13px] resize-none ${
                    isRtl ? 'add-download-links-input--rtl' : ''
                  }`}
                  placeholder={t($ => $.addDownloads.pastePlaceholder)}
                  value={urls}
                  onChange={(e) => setUrls(e.target.value)}
                />
                <div className="add-download-url-meta px-1">
                  <p id="add-download-links-hint" className="add-download-input-hint min-w-0 flex-1 text-[10px] leading-4 text-text-muted">
                    {t($ => $.addDownloads.pasteHint)}
                  </p>
                  <button
                    type="button"
                    onClick={() => void addTorrentFiles()}
                    className="add-download-link-button flex items-center gap-1.5 text-[11px] font-medium"
                  >
                    <FolderPlus size={12} /> {t($ => $.addDownloads.chooseTorrentFiles)}
                  </button>
                </div>
                {playlistSummaries.map(([sourceUrl, playlist]) => {
                  const total = playlist.entry_count || playlist.entries.length;
                  return (
                    <p key={sourceUrl} className="px-1 text-[11px] text-purple-500 dark:text-purple-400">
                      {t($ => $.addDownloads.playlistSummary, {
                        title: playlist.title,
                        loaded: playlist.entries.length,
                        total: total > playlist.entries.length ? ` of ${total}` : '',
                        truncated: playlist.truncated ? t($ => $.addDownloads.safeEntryLimit) : '',
                        skipped: playlist.skipped_entries > 0 ? `; ${playlist.skipped_entries} skipped, unavailable, duplicated, or outside the safe limit` : '',
                      })}.
                    </p>
                  );
                })}
                <div
                  className="add-download-selection-summary px-1"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <span className="sr-only">{localizedSelectedSummary}</span>
                  <div className="add-download-selection-status" aria-hidden="true">
                    <span className="add-download-status-chip" data-tone="ready">
                      <strong>{readyMetadataCount}</strong>
                      <span>{t($ => $.addDownloads.selectedSummaryReady)}</span>
                    </span>
                    <span className="add-download-status-chip" data-tone="fallback">
                      <strong>{fallbackMetadataCount}</strong>
                      <span>{t($ => $.addDownloads.selectedSummaryFallback)}</span>
                    </span>
                    <span className="add-download-status-chip" data-tone="media-retry">
                      <strong>{failedMediaMetadataCount}</strong>
                      <span>{t($ => $.addDownloads.selectedSummaryMediaRetry)}</span>
                    </span>
                    <span className="add-download-status-chip" data-tone="blocked">
                      <strong>{blockedMetadataCount}</strong>
                      <span>{t($ => $.addDownloads.selectedSummaryBlocked)}</span>
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-3">
                <SummaryBox title={t($ => $.addDownloads.files)} value={selectedItems.length === parsedItems.length ? parsedItems.length : `${selectedItems.length}/${parsedItems.length}`} icon={FileText} color="text-blue-500" />
                <SummaryBox title={t($ => $.addDownloads.required)} value={requiredStr === 'Unknown' ? t($ => $.addDownloads.unknown) : requiredStr} icon={Database} color="text-orange-500" />
                <SummaryBox title={t($ => $.addDownloads.free)} value={freeSpace === 'Unknown' ? t($ => $.addDownloads.unknown) : freeSpace} icon={HardDrive} color="text-green-500" />
                <SummaryBox title={t($ => $.addDownloads.unknown)} value={selectedItems.filter(i => !i.sizeBytes).length} icon={FileText} color="text-purple-500" />
              </div>

              <div className="flex flex-col gap-2 flex-1 min-h-0 min-w-0 overflow-hidden">
                <div className="add-download-preview-heading flex flex-wrap items-center justify-between gap-2">
                  <div className="add-download-section-title flex items-center gap-2">
                    <ArrowRight size={16} className="text-blue-500" />
                    {t($ => $.addDownloads.preview)}
                  </div>
                  <div className="add-download-preview-actions flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setParsedItems(refreshFailedMetadataRows)}
                      disabled={failedMetadataCount === 0}
                      className="add-download-link-button flex items-center gap-1.5 text-[11px] font-medium"
                    >
                      <RefreshCw size={12} /> {t($ => $.addDownloads.refreshMetadata)}
                    </button>
                    <button
                      type="button"
                      onClick={toggleAllRows}
                      disabled={parsedItems.length === 0}
                      className="add-download-link-button text-[11px] font-medium"
                    >
                      {allRowsSelected ? t($ => $.addDownloads.clearSelection) : t($ => $.addDownloads.selectAll)}
                    </button>
                  </div>
                </div>
                <div className="add-download-preview flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col">
                  <div className="add-download-preview-header px-3 py-2 flex text-[11px] font-semibold text-text-muted uppercase tracking-wider">
                    <div className="flex-[2]">{t($ => $.addDownloads.file)}</div>
                    <div className="flex-1">{t($ => $.addDownloads.size)}</div>
                    <div className="flex-[1.5]">{t($ => $.addDownloads.status)}</div>
                  </div>
                  <div className="flex-1 min-h-0 min-w-0 overflow-y-auto p-2 space-y-1" role="listbox" aria-label={t($ => $.addDownloads.downloadPreview)}>
                    {parsedItems.length === 0 ? (
                      <div className="add-download-empty h-full flex items-center justify-center text-text-muted text-xs">
                        {t($ => $.addDownloads.noLinks)}
                      </div>
                    ) : (
                      parsedItems.map((item, i) => (
                        <div
                          key={item.id}
                          onClick={() => setSelectedItemIndex(i)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setSelectedItemIndex(i);
                            }
                          }}
                          role="option"
                          aria-selected={selectedItemIndex === i}
                          tabIndex={0}
                          className={`add-download-preview-row flex flex-col text-xs px-2 py-2 cursor-pointer rounded-md group ${
                            selectedItemIndex === i
                              ? 'is-selected border'
                              : 'border border-transparent'
                          }`}
                          >
                            <div className="flex items-center w-full">
                            <input
                              type="checkbox"
                              checked={item.selected !== false}
                              onChange={() => toggleRowSelection(i)}
                              onClick={event => event.stopPropagation()}
                              aria-label={t($ => $.addDownloads.selectItem, { file: item.file })}
                              className="me-2 shrink-0 accent-purple-500"
                            />
                            <div className="flex-[2] min-w-0 flex items-center gap-2 text-text-primary font-medium truncate pe-2" title={item.file}>
                              <span className="truncate">{item.file}</span>
                              {item.isMedia && item.status === 'ready' && mediaQualityForRow(item) ? (
                                <span className="add-download-quality-chip shrink-0" title={t($ => $.addDownloads.quality)}>
                                  {mediaQualityForRow(item)}
                                </span>
                              ) : null}
                            </div>
                            <div className={`flex-1 font-mono ${item.status === 'loading' ? 'text-text-muted/50' : 'text-text-muted'}`}>{item.size || t($ => $.addDownloads.unknown)}</div>
                            <div className={`flex-[1.5] font-medium ${item.status === 'metadata-error' || item.status === 'invalid' ? 'text-red-500' : item.status === 'loading' ? 'text-orange-400' : 'text-blue-500'}`}>
                              {item.status === 'loading' ? (
                                <div className="flex items-center gap-1.5">
                                  <RefreshCw size={12} className="animate-spin" /> {item.isPlaylist ? t($ => $.addDownloads.fetchingPlaylist) : t($ => $.addDownloads.fetching)}
                                </div>
                              ) : (
                                item.status === 'metadata-error'
                                  ? item.metadataBlockedReason === 'unsafe-url' ? t($ => $.addDownloads.unsafeUrl) : item.isPlaylist ? t($ => $.addDownloads.playlistFailed) : item.isMedia ? t($ => $.addDownloads.metadataFailed) : t($ => $.addDownloads.fallback)
                                  : item.status === 'invalid'
                                    ? t($ => $.addDownloads.invalid)
                                    : t($ => $.addDownloads.ready)
                              )}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

            </div>
          </div>

          {/* Right Column: Settings */}
          <div className="add-download-settings w-[45%] flex flex-col overflow-y-auto">
            <div className="p-6 space-y-5">

              {selectedItemIndex !== null && parsedItems[selectedItemIndex]?.isTorrent && (
                <section className="add-download-section relative overflow-hidden p-4">
                  <div className="add-download-section-title flex items-center gap-2 mb-3">
                    <FileText size={16} className="text-blue-500" /> {t($ => $.addDownloads.torrentFiles)}
                  </div>
                  {parsedItems[selectedItemIndex].torrentFiles?.length ? (
                    <div
                      className="flex flex-col gap-1 max-h-64 overflow-y-auto pe-1"
                      role="group"
                      aria-label={t($ => $.addDownloads.torrentFiles)}
                    >
                      {parsedItems[selectedItemIndex].torrentFiles!.map(file => {
                        const selectedIndices = parsedItems[selectedItemIndex!].selectedTorrentFileIndices;
                        const checked = !selectedIndices || selectedIndices.includes(file.index);
                        return (
                          <div
                            key={file.index}
                            className="flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-xs text-text-secondary hover:bg-surface-hover"
                          >
                            <label className="flex min-w-0 flex-1 items-center gap-2">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleTorrentFile(file.index)}
                                aria-label={file.path}
                                className="accent-blue-500"
                              />
                              <span className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap" dir="ltr" title={file.path}>{file.path}</span>
                              <span className="font-mono text-text-muted shrink-0">{formatBytes(file.length)}</span>
                            </label>
                            <button
                              type="button"
                              className="app-icon-button shrink-0"
                              aria-label={t($ => $.downloadTable.copyFilePath)}
                              title={t($ => $.downloadTable.copyFilePath)}
                              onClick={event => {
                                event.preventDefault();
                                event.stopPropagation();
                                void copyTorrentFilePath(file.path);
                              }}
                            >
                              <Copy size={13} aria-hidden="true" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-text-muted">
                      {t($ => $.addDownloads.torrentMetadataPending)}
                    </p>
                  )}
                </section>
              )}

              {selectedItemIndex !== null && parsedItems[selectedItemIndex]?.isTorrent && (
                <section className="add-download-section relative overflow-hidden p-4">
                  <div className="add-download-section-title flex items-center gap-2 mb-3">
                    <HardDrive size={16} className="text-blue-500" /> {t($ => $.addDownloads.torrentSeeding)}
                  </div>
                  <div className="space-y-3 text-xs">
                    <label className="flex items-center gap-2 text-text-primary">
                      <input
                        type="checkbox"
                        checked={torrentSeedingEnabled}
                        onChange={event => setTorrentSeedingEnabled(event.target.checked)}
                        className="accent-blue-500"
                      />
                      {t($ => $.addDownloads.seedAfterDownload)}
                    </label>
                    {torrentSeedingEnabled ? (
                      <div className="grid grid-cols-[1fr_auto] gap-2 items-center">
                        <label htmlFor="torrent-seed-time" className="text-text-muted">{t($ => $.addDownloads.seedTime)}</label>
                        <div className="flex items-center gap-1.5">
                          <input
                            id="torrent-seed-time"
                            type="number"
                            min={1}
                            step={1}
                            value={torrentSeedTime}
                            onChange={event => setTorrentSeedTime(event.target.value)}
                            dir="ltr"
                            className="app-control w-20 px-2 py-1 text-end font-mono"
                          />
                          <span className="text-text-muted">{t($ => $.addDownloads.minutes)}</span>
                        </div>
                        <label htmlFor="torrent-seed-ratio" className="text-text-muted">{t($ => $.addDownloads.seedRatio)}</label>
                        <input
                          id="torrent-seed-ratio"
                          type="number"
                          min={0}
                          step={0.1}
                          value={torrentSeedRatio}
                          onChange={event => setTorrentSeedRatio(event.target.value)}
                          dir="ltr"
                          className="app-control w-20 px-2 py-1 text-end font-mono"
                          aria-describedby="torrent-seed-ratio-hint"
                        />
                        <span id="torrent-seed-ratio-hint" className="col-span-2 text-[10px] text-text-muted">
                          {t($ => $.addDownloads.seedRatioHint)}
                        </span>
                      </div>
                    ) : null}
                    <label className="flex items-center gap-2 text-text-primary">
                      <input
                        type="checkbox"
                        checked={torrentUploadLimitEnabled}
                        onChange={event => setTorrentUploadLimitEnabled(event.target.checked)}
                        className="accent-blue-500"
                      />
                      {t($ => $.addDownloads.limitTorrentUpload)}
                    </label>
                    {torrentUploadLimitEnabled ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          step={128}
                          value={torrentUploadLimit}
                          onChange={event => setTorrentUploadLimit(event.target.value)}
                          dir="ltr"
                          className="app-control w-24 px-2 py-1 text-end font-mono"
                          aria-label={t($ => $.addDownloads.torrentUploadLimit)}
                        />
                        <span className="text-text-muted">KiB/s</span>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setAdvancedExpanded(expanded => !expanded)}
                      className="add-download-torrent-advanced-toggle flex w-full items-center justify-between gap-3 border-t border-border-modal/50 pt-3 text-start"
                      aria-expanded={advancedExpanded}
                      aria-controls="add-torrent-advanced-options add-transfer-advanced-options"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {advancedExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span>{t($ => $.addDownloads.torrentAdvancedOptions)}</span>
                      </span>
                      {!advancedExpanded && hasCustomTorrentOptions && (
                        <span className="shrink-0 text-[10px] font-medium text-blue-400">
                          {t($ => $.addDownloads.torrentAdvancedOptionsCustom)}
                        </span>
                      )}
                    </button>
                    {advancedExpanded && (
                      <div id="add-torrent-advanced-options" className="add-download-torrent-advanced-fields space-y-4">
                        <div className="border-b border-border-modal/50 pb-3">
                          <div className="add-download-advanced-group-title">{t($ => $.properties.torrentWebSeeds)}</div>
                          <p className="mt-1 mb-3 text-[10px] text-text-muted">{t($ => $.properties.torrentWebSeedsHint)}</p>
                          <TorrentWebSeedEditor
                            files={parsedItems[selectedItemIndex!].torrentFiles ?? []}
                            rows={parsedItems[selectedItemIndex!].torrentWebSeedRows ?? []}
                            onChange={rows => setParsedItems(items => items.map((item, index) => index === selectedItemIndex
                              ? { ...item, torrentWebSeedRows: rows }
                              : item
                            ))}
                            idPrefix="add-torrent-web-seed"
                          />
                        </div>
                    <label className="flex items-start gap-2 text-text-primary pt-2 border-t border-border-modal/50">
                      <input
                        type="checkbox"
                        checked={torrentCheckIntegrity}
                        onChange={event => setTorrentCheckIntegrity(event.target.checked)}
                        className="accent-blue-500 mt-0.5"
                      />
                      <span>
                        <span className="block">{t($ => $.addDownloads.torrentVerifyIntegrity)}</span>
                        <span className="block text-[10px] text-text-muted">
                          {t($ => $.addDownloads.torrentVerifyIntegrityHint)}
                        </span>
                      </span>
                    </label>
                    <div className="grid grid-cols-[1fr_auto] gap-2 items-center pt-2 border-t border-border-modal/50">
                      <label htmlFor="torrent-file-allocation" className="text-text-muted">
                        {t($ => $.properties.torrentFileAllocation)}
                      </label>
                      <select
                        id="torrent-file-allocation"
                        value={torrentFileAllocation}
                        onChange={event => setTorrentFileAllocation(event.currentTarget.value as TorrentFileAllocation)}
                        aria-describedby="torrent-file-allocation-hint"
                        className="app-control max-w-56 px-2 py-1 text-xs"
                      >
                        <option value="prealloc">{t($ => $.properties.torrentFileAllocationPrealloc)}</option>
                        <option value="none">{t($ => $.properties.torrentFileAllocationNone)}</option>
                      </select>
                      <p id="torrent-file-allocation-hint" className="col-span-2 text-[10px] text-text-muted">
                        {t($ => $.properties.torrentFileAllocationHint)}
                      </p>
                    </div>
                    <div className="space-y-2 pt-2 border-t border-border-modal/50">
                      <span className="block text-text-muted">{t($ => $.properties.torrentPrioritizePiece)}</span>
                      <label className="flex items-center gap-2 text-text-primary">
                        <input
                          type="checkbox"
                          checked={torrentPreviewHeadEnabled}
                          onChange={event => setTorrentPreviewHeadEnabled(event.target.checked)}
                          className="accent-blue-500"
                        />
                        {t($ => $.properties.torrentPrioritizePieceHead)}
                        <input
                          type="text"
                          value={torrentPreviewHeadSize}
                          onChange={event => setTorrentPreviewHeadSize(event.currentTarget.value)}
                          disabled={!torrentPreviewHeadEnabled}
                          aria-label={t($ => $.properties.torrentPrioritizePieceSize)}
                          className="app-control w-20 px-2 py-1 text-end font-mono disabled:opacity-50"
                        />
                      </label>
                      <label className="flex items-center gap-2 text-text-primary">
                        <input
                          type="checkbox"
                          checked={torrentPreviewTailEnabled}
                          onChange={event => setTorrentPreviewTailEnabled(event.target.checked)}
                          className="accent-blue-500"
                        />
                        {t($ => $.properties.torrentPrioritizePieceTail)}
                        <input
                          type="text"
                          value={torrentPreviewTailSize}
                          onChange={event => setTorrentPreviewTailSize(event.currentTarget.value)}
                          disabled={!torrentPreviewTailEnabled}
                          aria-label={t($ => $.properties.torrentPrioritizePieceSize)}
                          className="app-control w-20 px-2 py-1 text-end font-mono disabled:opacity-50"
                        />
                      </label>
                      <p id="torrent-prioritize-piece-hint" className="text-[10px] text-text-muted">
                        {t($ => $.properties.torrentPrioritizePieceHint)}
                      </p>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] gap-2 items-center pt-2 border-t border-border-modal/50">
                      <label htmlFor="torrent-encryption-policy" className="text-text-muted">
                        {t($ => $.addDownloads.torrentEncryptionPolicy)}
                      </label>
                      <select
                        id="torrent-encryption-policy"
                        value={torrentEncryptionPolicy}
                        onChange={event => setTorrentEncryptionPolicy(event.currentTarget.value as TorrentEncryptionPolicy)}
                        aria-describedby="torrent-encryption-policy-hint"
                        className="app-control max-w-56 px-2 py-1 text-xs"
                      >
                        <option value={TORRENT_ENCRYPTION_POLICY_DISABLED}>
                          {t($ => $.addDownloads.torrentEncryptionDisabled)}
                        </option>
                        <option value={TORRENT_ENCRYPTION_POLICY_REQUIRE_CRYPTO}>
                          {t($ => $.addDownloads.torrentEncryptionRequireCrypto)}
                        </option>
                        <option value={TORRENT_ENCRYPTION_POLICY_FORCE_ENCRYPTION}>
                          {t($ => $.addDownloads.torrentEncryptionForceEncryption)}
                        </option>
                      </select>
                      <p id="torrent-encryption-policy-hint" className="col-span-2 text-[10px] text-text-muted">
                        {t($ => $.addDownloads.torrentEncryptionPolicyHint)}
                      </p>
                    </div>
                    <label className="flex items-start gap-2 text-text-primary pt-2 border-t border-border-modal/50">
                      <input
                        type="checkbox"
                        checked={torrentRemoveUnselectedFile}
                        onChange={event => setTorrentRemoveUnselectedFile(event.target.checked)}
                        disabled={parsedItems.every(item => !hasPartialTorrentSelection(item))}
                        className="accent-red-500 mt-0.5 disabled:opacity-50"
                      />
                      <span>
                        <span className="block">{t($ => $.addDownloads.torrentRemoveUnselectedFile)}</span>
                        <span className="block text-[10px] text-text-muted">
                          {t($ => $.addDownloads.torrentRemoveUnselectedFileHint)}
                        </span>
                      </span>
                    </label>
                    <div className="pt-2 border-t border-border-modal/50">
                      <label htmlFor="torrent-trackers" className="block text-text-muted">
                        {t($ => $.addDownloads.torrentTrackers)}
                      </label>
                      <textarea
                        id="torrent-trackers"
                        rows={3}
                        value={torrentTrackers}
                        onChange={event => setTorrentTrackers(event.currentTarget.value)}
                        dir="ltr"
                        placeholder="https://tracker.example/announce"
                        aria-describedby="torrent-trackers-hint"
                        className="app-control mt-1 min-h-20 w-full resize-y px-2.5 py-1.5 text-xs font-mono"
                      />
                      <p id="torrent-trackers-hint" className="mt-1 text-[10px] text-text-muted">
                        {t($ => $.addDownloads.torrentTrackersHint)}
                      </p>
                    </div>
                    <div className="pt-2 border-t border-border-modal/50">
                      <label htmlFor="torrent-exclude-trackers" className="block text-text-muted">
                        {t($ => $.addDownloads.torrentExcludeTrackers)}
                      </label>
                      <textarea
                        id="torrent-exclude-trackers"
                        rows={3}
                        value={torrentExcludeTrackers}
                        onChange={event => setTorrentExcludeTrackers(event.currentTarget.value)}
                        dir="ltr"
                        placeholder="https://tracker.example/announce or *"
                        aria-describedby="torrent-exclude-trackers-hint"
                        className="app-control mt-1 min-h-20 w-full resize-y px-2.5 py-1.5 text-xs font-mono"
                      />
                      <p id="torrent-exclude-trackers-hint" className="mt-1 text-[10px] text-text-muted">
                        {t($ => $.addDownloads.torrentExcludeTrackersHint)}
                      </p>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] gap-2 items-center pt-2 border-t border-border-modal/50">
                      <label htmlFor="torrent-tracker-connect-timeout" className="text-text-muted">
                        {t($ => $.addDownloads.torrentTrackerConnectTimeout)}
                      </label>
                      <div className="flex items-center gap-1">
                        <input
                          id="torrent-tracker-connect-timeout"
                          type="number"
                          min={1}
                          max={MAX_TORRENT_TRACKER_TIMEOUT}
                          step={1}
                          value={torrentTrackerConnectTimeout}
                          onChange={event => setTorrentTrackerConnectTimeout(event.currentTarget.value)}
                          placeholder="60"
                          dir="ltr"
                          className="app-control w-24 px-2 py-1 text-end font-mono"
                          aria-describedby="torrent-tracker-timing-hint"
                        />
                        <span className="text-[10px] text-text-muted">{t($ => $.addDownloads.seconds)}</span>
                      </div>
                      <label htmlFor="torrent-tracker-timeout" className="text-text-muted">
                        {t($ => $.addDownloads.torrentTrackerTimeout)}
                      </label>
                      <div className="flex items-center gap-1">
                        <input
                          id="torrent-tracker-timeout"
                          type="number"
                          min={1}
                          max={MAX_TORRENT_TRACKER_TIMEOUT}
                          step={1}
                          value={torrentTrackerTimeout}
                          onChange={event => setTorrentTrackerTimeout(event.currentTarget.value)}
                          placeholder="60"
                          dir="ltr"
                          className="app-control w-24 px-2 py-1 text-end font-mono"
                          aria-describedby="torrent-tracker-timing-hint"
                        />
                        <span className="text-[10px] text-text-muted">{t($ => $.addDownloads.seconds)}</span>
                      </div>
                      <label htmlFor="torrent-tracker-interval" className="text-text-muted">
                        {t($ => $.addDownloads.torrentTrackerInterval)}
                      </label>
                      <div className="flex items-center gap-1">
                        <input
                          id="torrent-tracker-interval"
                          type="number"
                          min={0}
                          max={MAX_TORRENT_TRACKER_INTERVAL}
                          step={1}
                          value={torrentTrackerInterval}
                          onChange={event => setTorrentTrackerInterval(event.currentTarget.value)}
                          dir="ltr"
                          className="app-control w-24 px-2 py-1 text-end font-mono"
                          aria-describedby="torrent-tracker-timing-hint"
                        />
                        <span className="text-[10px] text-text-muted">{t($ => $.addDownloads.seconds)}</span>
                      </div>
                      <p id="torrent-tracker-timing-hint" className="col-span-2 text-[10px] text-text-muted">
                        {t($ => $.addDownloads.torrentTrackerTimingHint)}
                      </p>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] gap-2 items-center pt-2 border-t border-border-modal/50">
                      <label htmlFor="torrent-max-peers" className="text-text-muted">
                        {t($ => $.addDownloads.torrentMaxPeers)}
                      </label>
                      <input
                        id="torrent-max-peers"
                        type="number"
                        min={0}
                        max={1000}
                        step={1}
                        value={torrentMaxPeers}
                        onChange={event => setTorrentMaxPeers(event.target.value)}
                        placeholder="55"
                        dir="ltr"
                        className="app-control w-24 px-2 py-1 text-end font-mono"
                        aria-describedby="torrent-peer-options-hint"
                      />
                      <label htmlFor="torrent-peer-speed-limit" className="text-text-muted">
                        {t($ => $.addDownloads.torrentPeerSpeedLimit)}
                      </label>
                      <input
                        id="torrent-peer-speed-limit"
                        type="text"
                        inputMode="decimal"
                        value={torrentPeerSpeedLimit}
                        onChange={event => setTorrentPeerSpeedLimit(event.target.value)}
                        placeholder="50K"
                        dir="ltr"
                        className="app-control w-24 px-2 py-1 text-end font-mono"
                        aria-describedby="torrent-peer-options-hint"
                      />
                      <p id="torrent-peer-options-hint" className="col-span-2 text-[10px] text-text-muted">
                        {t($ => $.addDownloads.torrentPeerOptionsHint)}
                      </p>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] gap-2 items-center pt-2 border-t border-border-modal/50">
                      <label htmlFor="torrent-stop-timeout" className="text-text-muted">
                        {t($ => $.addDownloads.torrentStopTimeout)}
                      </label>
                      <div className="flex items-center gap-1">
                        <input
                          id="torrent-stop-timeout"
                          type="number"
                          min={0}
                          max={MAX_TORRENT_STOP_TIMEOUT}
                          step={1}
                          value={torrentStopTimeout}
                          onChange={event => setTorrentStopTimeout(event.currentTarget.value)}
                          dir="ltr"
                          className="app-control w-24 px-2 py-1 text-end font-mono"
                          aria-describedby="torrent-stop-timeout-hint"
                        />
                        <span className="text-[10px] text-text-muted">{t($ => $.addDownloads.seconds)}</span>
                      </div>
                      <p id="torrent-stop-timeout-hint" className="col-span-2 text-[10px] text-text-muted">
                        {t($ => $.addDownloads.torrentStopTimeoutHint)}
                      </p>
                    </div>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* Media Format (Dynamic) */}
              {selectedItemIndex !== null && parsedItems[selectedItemIndex]?.isMedia && (
                <section className="add-download-section add-download-media-section relative overflow-hidden p-4">
                  <div className="absolute top-0 end-0 p-2 opacity-10">
                    <Video size={48} />
                  </div>
                  <div className="add-download-section-title flex items-center gap-2 mb-3 relative z-10">
                    <Video size={16} className="text-purple-500" /> {t($ => $.addDownloads.mediaFormat)}
                    {parsedItems[selectedItemIndex].playlistSourceUrl && (
                      <span className="text-[10px] font-normal text-text-muted">
                        {t($ => $.addDownloads.playlistItem, { index: parsedItems[selectedItemIndex].playlistIndex || '?' })}
                      </span>
                    )}
                  </div>

                  {parsedItems[selectedItemIndex].status === 'loading' ? (
                    <div className="flex flex-col items-center justify-center py-6 gap-3 relative z-10">
                      <RefreshCw size={24} className="animate-spin text-purple-500" />
                      <span className="text-xs text-text-muted font-medium animate-pulse">{t($ => $.addDownloads.fetchingMediaStreams)}</span>
                    </div>
                  ) : parsedItems[selectedItemIndex].formats ? (
                    <div className="space-y-3 relative z-10">
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[10px] uppercase font-bold tracking-wider text-text-muted">{t($ => $.addDownloads.availableStreams)}</label>
                        <div className="flex flex-col gap-1 max-h-48 overflow-y-auto pe-1" role="radiogroup" aria-label={t($ => $.addDownloads.availableMediaStreams)}>
                          {parsedItems[selectedItemIndex].formats!.map((f, idx) => {
                          const isSelected = parsedItems[selectedItemIndex].selectedFormat === idx;
                          const Icon = f.type === 'Audio' ? Music : Film;
                          return (
                            <div
                              key={idx}
                              onClick={() => selectMediaFormat(idx)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault();
                                  selectMediaFormat(idx);
                                }
                              }}
                              role="radio"
                              aria-checked={isSelected}
                              tabIndex={0}
                              className={`add-download-format-row flex items-center justify-between px-3 py-2 cursor-pointer text-xs border ${
                                isSelected ? 'is-selected text-purple-600 dark:text-purple-400 font-semibold' : 'text-text-secondary'
                              }`}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <Icon size={14} className={isSelected ? 'text-purple-500' : 'text-text-muted'} />
                                <div className="flex flex-col min-w-0">
                                  <span className="truncate">{f.name}</span>
                                  <span className="text-[10px] font-normal text-text-muted truncate">{f.formatLabel}</span>
                                </div>
                              </div>
                              <span className="font-mono text-[11px] opacity-80 shrink-0">{f.detail}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-4 relative z-10">
                      <span className="text-xs text-red-400 font-medium">{t($ => $.addDownloads.metadataUnavailable)}</span>
                    </div>
                  )}

                  {selectedPlaylistSourceUrl && selectedPlaylistReadyRows.length > 0 ? (
                    <div className="add-download-playlist-quality relative z-10">
                      <button
                        type="button"
                        className="add-download-playlist-quality-toggle"
                        aria-expanded={playlistQualityExpanded}
                        onClick={() => setPlaylistQualityExpanded(expanded => !expanded)}
                      >
                        <span className="min-w-0 text-start">
                          <span className="block text-xs font-semibold text-text-primary">
                            {t($ => $.addDownloads.playlistQuality)}
                          </span>
                          <span className="mt-0.5 block text-[10px] text-text-muted">
                            {t($ => $.addDownloads.playlistQualitySelected, {
                              selected: selectedPlaylistRows.length,
                              total: parsedItems.filter(item => item.playlistSourceUrl === selectedPlaylistSourceUrl).length
                            })}
                          </span>
                        </span>
                        {playlistQualityExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      </button>

                      {playlistQualityExpanded ? (
                        hasPlaylistFormatOptions ? (
                          <>
                            {playlistVideoFormatOptions.length > 0 && playlistAudioFormatOptions.length > 0 ? (
                              <div className="add-download-playlist-media-type" role="tablist" aria-label={t($ => $.addDownloads.mediaFormat)}>
                                <button
                                  type="button"
                                  role="tab"
                                  aria-selected={selectedPlaylistMediaType === 'Video'}
                                  onClick={() => selectedPlaylistSourceUrl && setPlaylistMediaTypeSelections(current => ({
                                    ...current,
                                    [selectedPlaylistSourceUrl]: 'Video'
                                  }))}
                                  className={`add-download-playlist-media-type-option ${selectedPlaylistMediaType === 'Video' ? 'is-selected' : ''}`}
                                >
                                  <Film size={13} /> {t($ => $.addDownloads.video)}
                                </button>
                                <button
                                  type="button"
                                  role="tab"
                                  aria-selected={selectedPlaylistMediaType === 'Audio'}
                                  onClick={() => selectedPlaylistSourceUrl && setPlaylistMediaTypeSelections(current => ({
                                    ...current,
                                    [selectedPlaylistSourceUrl]: 'Audio'
                                  }))}
                                  className={`add-download-playlist-media-type-option ${selectedPlaylistMediaType === 'Audio' ? 'is-selected' : ''}`}
                                >
                                  <Music size={13} /> {t($ => $.addDownloads.audio)}
                                </button>
                              </div>
                            ) : null}

                            <div className="add-download-playlist-quality-options mt-2">
                              <div className="add-download-playlist-quality-column">
                                <div className="add-download-playlist-quality-label">{t($ => $.addDownloads.quality)}</div>
                                {playlistQualityOptions.length > 0 ? (
                                  <div className="add-download-playlist-quality-list" role="radiogroup" aria-label={t($ => $.addDownloads.quality)}>
                                    {playlistQualityOptions.map(quality => {
                                      const isApplied = appliedPlaylistSelection?.mediaType === selectedPlaylistMediaType
                                        && appliedPlaylistSelection.format === selectedPlaylistFormat
                                        && appliedPlaylistSelection.quality === quality;
                                      return (
                                        <button
                                          key={quality}
                                          type="button"
                                          role="radio"
                                          aria-checked={isApplied}
                                          onClick={() => applyPlaylistMediaQuality(quality)}
                                          className={`add-download-quality-option ${isApplied ? 'is-selected' : ''}`}
                                        >
                                          <span className="add-download-quality-option-radio" aria-hidden="true" />
                                          <span className="flex-1 text-start">{quality}</span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <span className="text-[10px] text-text-muted">
                                    {t($ => $.addDownloads.noCommonQuality)}
                                  </span>
                                )}
                              </div>

                              {playlistFormatOptions.length > 0 ? (
                                <div className="add-download-playlist-quality-column">
                                  <div className="add-download-playlist-quality-label">{t($ => $.addDownloads.format)}</div>
                                  <div className="add-download-playlist-quality-list" role="radiogroup" aria-label={t($ => $.addDownloads.format)}>
                                    {playlistFormatOptions.map(format => {
                                      const isApplied = appliedPlaylistFormat === format;
                                      return (
                                        <button
                                          key={format}
                                          type="button"
                                          role="radio"
                                          aria-checked={isApplied}
                                          onClick={() => applyPlaylistMediaFormat(format)}
                                          className={`add-download-quality-option ${isApplied ? 'is-selected' : ''}`}
                                        >
                                          <span className="add-download-quality-option-radio" aria-hidden="true" />
                                          <span className="flex-1 text-start font-mono">{format}</span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </>
                        ) : (
                          <div className="px-3 py-2 text-[10px] text-text-muted">
                            {t($ => $.addDownloads.noCommonFormat)}
                          </div>
                        )
                      ) : null}
                    </div>
                  ) : null}
                </section>
              )}

              {/* Save Location */}
              <section className="add-download-section">
                <div className="add-download-section-title flex items-center gap-2 mb-3">
                  <FolderPlus size={16} className="text-blue-500" /> {t($ => $.addDownloads.saveLocation)}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={saveLocation}
                    className="add-download-control flex-1 px-3 py-1.5 text-xs text-text-muted font-mono"
                    aria-label={t($ => $.addDownloads.saveLocation)}
                  />
                  <button
                    type="button"
                    onClick={handleBrowse}
                    disabled={isSubmitting}
                    className="add-download-button add-download-button-secondary px-3 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t($ => $.addDownloads.browse)}
                  </button>
                </div>
                {parsedItems.length > 1 && (
                  <div className="mt-3">
                    <label className="flex items-center gap-2 text-xs text-text-secondary font-medium cursor-pointer">
                      <input
                        type="checkbox"
                        checked={saveInDedicatedFolder}
                        onChange={event => {
                          const enabled = event.target.checked;
                          if (enabled && !sanitizeBatchFolderName(dedicatedFolderName)) {
                            dedicatedFolderNameEditedRef.current = false;
                            setDedicatedFolderName(deriveBatchFolderName(
                              pendingAddBatchName,
                              pendingAddReferer,
                              new Date(),
                              parsedItems.map(item => item.file)
                            ));
                          }
                          setSaveInDedicatedFolder(enabled);
                        }}
                        className="add-download-checkbox"
                      />
                      {t($ => $.addDownloads.dedicatedFolder)}
                    </label>
                    {saveInDedicatedFolder && (
                      <>
                        <div className="flex gap-2 mt-2">
                          <input
                            type="text"
                            value={dedicatedFolderName}
                            onChange={event => {
                              dedicatedFolderNameEditedRef.current = true;
                              setDedicatedFolderName(event.target.value);
                            }}
                            placeholder={t($ => $.addDownloads.dedicatedFolderName)}
                            aria-label={t($ => $.addDownloads.dedicatedFolderName)}
                            className="add-download-control flex-1 px-3 py-1.5 text-xs"
                            disabled={isSubmitting}
                          />
                          <button
                            type="button"
                            onClick={commitDedicatedFolderName}
                            disabled={isSubmitting}
                            className="add-download-button add-download-button-secondary px-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                            aria-label={t($ => $.addDownloads.saveFolderName)}
                            title={t($ => $.addDownloads.saveFolderName)}
                          >
                            <Save size={14} />
                          </button>
                        </div>
                        <p className="mt-2 text-[11px] text-text-muted">
                          {t(isSaveLocationManual
                            ? $ => $.addDownloads.dedicatedFolderManualDescription
                            : $ => $.addDownloads.dedicatedFolderDescription)}
                        </p>
                      </>
                    )}
                  </div>
                )}
                {parsedItems.length > 1 && !isSaveLocationManual && (
                  <p className="mt-2 text-[11px] text-text-muted">
                    {t($ => $.addDownloads.categoryFolders)}
                  </p>
                )}
                {isSaveLocationManual && !saveInDedicatedFolder && (
                  <p className="mt-2 text-[11px] text-text-muted">
                    {t($ => $.addDownloads.sharedFolder)}
                  </p>
                )}
              </section>

              {/* Transfer Settings */}
              <section className="add-download-section">
                <div className="add-download-section-title flex items-center gap-2 mb-3">
                  <Settings size={16} className="text-blue-500" /> {t($ => $.addDownloads.transferSettings)}
                </div>
                  <div className="flex flex-col gap-3">
                    {!(selectedItemIndex !== null && parsedItems[selectedItemIndex]?.isTorrent) && (
                      <div className="flex items-center justify-between">
                        <label className="text-xs text-text-secondary font-medium">{t($ => $.addDownloads.connectionsPerFile)}</label>
                        <div className="flex items-center gap-2">
                          <input type="range" min="1" max="16" value={connections} onChange={e=>setConnections(Number(e.target.value))} className="add-download-range w-24 accent-blue-500 cursor-pointer" aria-label={t($ => $.addDownloads.connectionsPerFileAria)} />
                          <span className="add-download-value text-xs text-text-primary font-mono w-6 text-center">{connections}</span>
                        </div>
                      </div>
                    )}

                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-xs text-text-secondary font-medium cursor-pointer">
                      <input type="checkbox" checked={speedLimitEnabled} onChange={e=>setSpeedLimitEnabled(e.target.checked)} className="add-download-checkbox" />
                      {t($ => $.addDownloads.limitSpeedPerFile)}
                    </label>
                    {speedLimitEnabled && (
                      <div className="flex items-center gap-1.5">
                        <input type="number" value={speedLimit} onChange={e=>setSpeedLimit(e.target.value)} className="add-download-control w-16 px-2 py-1 text-xs font-mono" aria-label={t($ => $.addDownloads.speedLimitPerFileAria)} />
                        <span className="text-[10px] text-text-muted">KiB/s</span>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* Authorization */}
              <section className="add-download-section">
                <div className="add-download-section-title flex items-center gap-2 mb-3">
                  <Shield size={16} className="text-blue-500" /> {t($ => $.addDownloads.authorization)}
                </div>
                <label className="flex items-center gap-2 text-xs text-text-secondary font-medium cursor-pointer mb-3">
                  <input type="checkbox" checked={useAuth} onChange={e=>setUseAuth(e.target.checked)} className="add-download-checkbox" />
                  {t($ => $.addDownloads.useAuthorization)}
                </label>

                {useAuth && (
                  <div className="add-download-nested-fields space-y-2.5">
                    <input type="text" value={username} onChange={e=>setUsername(e.target.value)} placeholder={t($ => $.addDownloads.username)} className="add-download-control w-full px-3 py-1.5 text-xs" />
                    <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder={t($ => $.addDownloads.password)} className="add-download-control w-full px-3 py-1.5 text-xs" />
                  </div>
                )}
              </section>

              {/* Advanced */}
              {(!selectedItemIsTorrent || advancedExpanded) && (
                <section className="add-download-section add-download-advanced">
                  {selectedItemIsTorrent ? (
                    <div className="add-download-section-title flex items-center gap-2 mb-3">
                      <Settings size={16} className="text-blue-500" /> {t($ => $.addDownloads.advancedTransfer)}
                    </div>
                  ) : (
                    <button
                      onClick={() => setAdvancedExpanded(!advancedExpanded)}
                      className="add-download-advanced-toggle flex items-center gap-2 text-sm font-semibold text-text-primary w-full"
                      aria-expanded={advancedExpanded}
                      aria-controls="add-transfer-advanced-options"
                    >
                      {advancedExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      {t($ => $.addDownloads.advancedTransfer)}
                    </button>
                  )}

                  {advancedExpanded && (
                    <div id="add-transfer-advanced-options" className="add-download-advanced-fields mt-4 space-y-4">
                    <label className="flex items-center gap-2 text-xs text-text-secondary font-medium cursor-pointer">
                      <input type="checkbox" checked={checksumEnabled} onChange={e=>setChecksumEnabled(e.target.checked)} className="add-download-checkbox" />
                      {t($ => $.addDownloads.verifyChecksum)}
                    </label>

                    {checksumEnabled && (
                      <div className="flex gap-2">
                        <select value={checksumAlgo} onChange={e=>setChecksumAlgo(e.target.value)} className="add-download-control add-download-select w-24 px-2 text-xs" aria-label={t($ => $.addDownloads.checksumAlgorithm)}>
                          <option>MD5</option><option>SHA-1</option><option>SHA-256</option>
                        </select>
                        <input type="text" value={checksumValue} onChange={e=>setChecksumValue(e.target.value)} placeholder={t($ => $.addDownloads.expectedDigest)} className="add-download-control flex-1 px-3 py-1.5 text-xs font-mono" />
                      </div>
                    )}

                    {hasSftpRows && (
                      <div>
                        <label className="block text-[10px] uppercase font-bold tracking-wider text-text-muted mb-1">
                          {t($ => $.addDownloads.sftpHostKeyMd)}
                        </label>
                        <input
                          type="text"
                          value={sftpHostKeyMd}
                          onChange={event => setSftpHostKeyMd(event.target.value)}
                          placeholder={t($ => $.addDownloads.sftpHostKeyMdHint)}
                          className="add-download-control w-full px-3 py-1.5 text-xs font-mono"
                          autoComplete="off"
                        />
                        <p className="mt-1 text-[11px] text-text-muted">{t($ => $.addDownloads.sftpHostKeyMdDescription)}</p>
                      </div>
                    )}

                    <div>
                      <label className="block text-[10px] uppercase font-bold tracking-wider text-text-muted mb-1">{t($ => $.addDownloads.headers)}</label>
                      <textarea
                        value={headers}
                        onChange={e => {
                          headersManuallyEditedRef.current = true;
                          setHeaders(e.target.value);
                        }}
                        className="add-download-control w-full h-12 px-3 py-1.5 text-xs font-mono resize-none"
                        aria-label={t($ => $.addDownloads.requestHeaders)}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase font-bold tracking-wider text-text-muted mb-1">{t($ => $.addDownloads.cookies)}</label>
                      <input
                        type="password"
                        value={cookies}
                        onChange={e => {
                          cookiesManuallyEditedRef.current = true;
                          setCookies(e.target.value);
                        }}
                        placeholder={t($ => $.addDownloads.cookiePlaceholder)}
                        autoComplete="off"
                        className="add-download-control w-full px-3 py-1.5 text-xs font-mono"
                        aria-label={t($ => $.addDownloads.cookies)}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase font-bold tracking-wider text-text-muted mb-1">{t($ => $.addDownloads.mirrors)}</label>
                      <textarea value={mirrors} onChange={e=>setMirrors(e.target.value)} className="add-download-control w-full h-12 px-3 py-1.5 text-xs font-mono resize-none" aria-label={t($ => $.addDownloads.mirrors)} />
                    </div>
                    </div>
                  )}
                </section>
              )}

            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="add-download-footer p-4 flex items-center shrink-0">
          <div className="text-[11px] text-text-muted font-medium flex-1">
            {metadataSummary}
          </div>
          <div className="flex gap-2.5">
            <button onClick={closeModalFromDismissAction} disabled={isSubmitting || showKeychainModal} className="add-download-button add-download-button-secondary px-4 text-xs">
              {t($ => $.addDownloads.cancel)}
            </button>
            <div ref={actionMenuRef} className="relative flex gap-2.5">
              <button
                onClick={() => handleAction({ type: 'start-now' })}
                disabled={!canSubmit || isSubmitting}
                className="add-download-button add-download-button-primary px-5 text-xs"
              >
                <Play size={12} fill="currentColor" /> {t($ => $.addDownloads.startDownloads)}
              </button>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsQueueMenuOpen(open => !open)}
                  disabled={!canSubmit || isSubmitting}
                  className="add-download-button add-download-button-secondary px-4 text-xs"
                  aria-label={t($ => $.addDownloads.addToQueue)}
                  aria-haspopup="menu"
                  aria-expanded={isQueueMenuOpen}
                >
                  {t($ => $.addDownloads.addToQueue)} <ChevronDown size={14} className="ms-1" />
                </button>
                {isQueueMenuOpen && (
                  <div
                    role="menu"
                    className="add-download-queue-menu app-modal absolute bottom-full z-[70] mb-2 min-w-[200px] overflow-visible py-1.5 text-xs"
                  >
                    {queues.map(queue => (
                      <button
                        key={queue.id}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setIsQueueMenuOpen(false);
                          void handleAction({ type: 'add-to-queue', queueId: queue.id });
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-start hover:bg-item-hover"
                      >
                        <span className="truncate">{queue.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
    </>
  );
};

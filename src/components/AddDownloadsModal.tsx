import { useCallback, useState, useEffect, useRef } from 'react';
import {
  useDownloadStore,
  getSiteLogin,
  getProxyArgs,
  type AddDownloadAction,
  type PendingAddRequestContext
} from '../store/useDownloadStore';
import { useSettingsStore } from '../store/useSettingsStore';
import type { MediaPlaylistMetadata } from '../bindings/MediaPlaylistMetadata';
import { FolderPlus, Settings, Shield, RefreshCw, FileText, HardDrive, Database, Link, ArrowRight, Play, ChevronDown, ChevronRight, Video, Film, Music, type LucideIcon } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { invokeCommand as invoke } from '../ipc';
import { DuplicateResolutionModal, DuplicateConflict } from './DuplicateResolutionModal';
import { canonicalizeDownloadFileName, categoryForFileName } from '../utils/downloads';
import { fetchMediaMetadataDeduped, fetchMediaPlaylistMetadataDeduped } from '../utils/mediaMetadata';
import {
  resolveCategoryDestination,
  resolveDownloadFilePath,
  downloadLocationEquals
} from '../utils/downloadLocations';
import { getPlatformInfo } from '../utils/platform';
import { isTransferLocked } from '../utils/downloadActions';
import { useToast } from '../contexts/ToastContext';
import {
  canSubmitMetadataRows,
  appendRequestUrlsAfterVersion,
  mediaFileNameForSelectedFormat,
  mediaFormatSelectorForRow,
  metadataSummaryMessage,
  playlistFilePrefix,
  reconcileDownloadRows,
  refreshFailedMetadataRows,
  updateRowIfCurrent,
  type AddDownloadDraftRow
} from '../utils/addDownloadMetadata';

const formatBytes = (bytes: number) => {
  if (bytes === 0) return 'Unknown size';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const normalizeComparableUrl = (rawUrl: string) => {
  try {
    return new URL(rawUrl).href;
  } catch {
    return rawUrl.trim();
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
  const { addToast } = useToast();
  const {
    isAddModalOpen,
    pendingAddUrls,
    pendingAddReferer,
    pendingAddFilename,
    pendingAddHeaders,
    pendingAddCookies,
    pendingAddMediaUrls,
    pendingAddRequestContexts,
    pendingAddRequestVersion,
    toggleAddModal,
    addDownload,
    queues
  } = useDownloadStore();
  const {
    baseDownloadFolder,
    perServerConnections,
    keychainAccessReady,
    keychainPromptDismissed,
    showKeychainModal
  } = useSettingsStore();

  const [urls, setUrls] = useState('');
  const [selectedItemIndex, setSelectedItemIndex] = useState<number | null>(null);
  const [parsedItems, setParsedItems] = useState<AddDownloadDraftRow[]>([]);
  const metadataRequestsRef = useRef(new Set<string>());
  const playlistRequestsRef = useRef(new Set<string>());
  const latestPlaylistRequestRef = useRef(new Map<string, string>());
  const [playlistExpansions, setPlaylistExpansions] = useState<Record<string, MediaPlaylistMetadata>>({});

  const [conflicts, setConflicts] = useState<DuplicateConflict[]>([]);
  const [showingDuplicates, setShowingDuplicates] = useState(false);
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
  const [connections, setConnections] = useState(perServerConnections);
  const [speedLimitEnabled, setSpeedLimitEnabled] = useState(false);
  const [speedLimit, setSpeedLimit] = useState('1024');
  const [freeSpace, setFreeSpace] = useState('Unknown');
  const freeSpaceRequestRef = useRef(0);

  const [useAuth, setUseAuth] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [advancedExpanded, setAdvancedExpanded] = useState(false);
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
      urls.trim() || pendingAddUrls.trim() || parsedItems.length || headers.trim() || cookies.trim()
    );
    if (hasPendingInput && !window.confirm('Discard this download setup?')) return;
    toggleAddModal(false);
  }, [cookies, headers, isSubmitting, parsedItems.length, pendingAddUrls, showKeychainModal, toggleAddModal, urls]);

  useEffect(() => {
    if (!isAddModalOpen) {
      modalSessionRef.current = false;
      setUrls('');
      setPlaylistExpansions({});
      playlistRequestsRef.current.clear();
      latestPlaylistRequestRef.current.clear();
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

    setSaveLocation(baseDownloadFolder);
    setIsSaveLocationManual(false);
    setUrls(initialUrls);
    setParsedItems([]);
    setPlaylistExpansions({});
    metadataRequestsRef.current.clear();
    playlistRequestsRef.current.clear();
    latestPlaylistRequestRef.current.clear();
    setSelectedItemIndex(null);
    setPendingUseSharedDestination(false);
    setPendingDestinationOverrides({});
    setConnections(perServerConnections);
    setFreeSpace('Unknown');
    setSpeedLimitEnabled(false);
    setSpeedLimit('1024');
    setUseAuth(false);
    setUsername('');
    setPassword('');
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
    baseDownloadFolder,
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
      if (showKeychainModal) return;
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
    setPlaylistExpansions(current => {
      const retained = Object.fromEntries(
        Object.entries(current).filter(([sourceUrl]) => activeUrls.has(sourceUrl))
      );
      return Object.keys(retained).length === Object.keys(current).length ? current : retained;
    });

    const forcedMediaUrls = new Set(pendingAddMediaUrls.map(url => {
      try {
        return new URL(url).href;
      } catch {
        return url;
      }
    }));
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
        selectedBySourceUrl
      );
    });
  }, [
    urls,
    pendingAddFilename,
    pendingAddMediaUrls,
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
          const proxy = await getProxyArgs(settingsStore);
          const login = getSiteLogin(row.sourceUrl, settingsStore);
          const contextUrl = requestContextUrlForRow(row);
          const requestContext = requestContextForUrl(contextUrl);
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
                throw new Error('Playlist contains no downloadable entries');
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
                  ext: f.ext,
                  bytes,
                  isApproximate,
                  formatLabel: f.format_label || f.ext.toUpperCase(),
                  detail: bytes ? `${isApproximate ? '~' : ''}${formatBytes(bytes)}` : 'Unknown size',
                  selector: f.format_id,
                  type: quality.toLowerCase().includes('audio') ? 'Audio' : 'Video'
                };
              });
              setParsedItems(current => updateRowIfCurrent(
                current,
                row.id,
                row.sourceUrl,
                row.generation,
                currentRow => ({
                  ...currentRow,
                  downloadUrl: row.sourceUrl,
                  file: canonicalizeDownloadFileName(
                    `${playlistFilePrefix(row.playlistIndex, row.playlistCount)}${mediaData.title}.${mediaData.formats[0].ext}`
                  ),
                  size: mappedFormats[0].bytes ? mappedFormats[0].detail : undefined,
                  sizeBytes: mappedFormats[0].bytes || undefined,
                  status: 'ready',
                  formats: mappedFormats,
                  selectedFormat: 0,
                  playlistError: undefined
                })
              ));
            } else {
              throw new Error("Invalid media metadata or no formats found");
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
            const nextDownloadUrl = meta.url || row.sourceUrl;
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
    if (parsedItems.length === 0) {
      setSelectedItemIndex(null);
      return;
    }
    setSelectedItemIndex(current =>
      current === null || current >= parsedItems.length ? 0 : current
    );
    if (isSaveLocationManual) return;
    if (parsedItems.length > 1) {
      setSaveLocation(useSettingsStore.getState().baseDownloadFolder || '~/Downloads');
      return;
    }
    const first = parsedItems[0];
    if (first.status !== 'ready' && first.status !== 'metadata-error') return;
    void resolveCategoryDestination(
      useSettingsStore.getState(),
      categoryForFileName(first.file)
    ).then(setSaveLocation);
  }, [isSaveLocationManual, parsedItems]);

  if (!isAddModalOpen) return null;

  const handleBrowse = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: saveLocation.startsWith('~') ? undefined : saveLocation
    });
    if (selected && typeof selected === 'string') {
      const approvedPath = await useSettingsStore.getState().approveDownloadRoot(selected);
      setSaveLocation(approvedPath);
      setIsSaveLocationManual(true);
    }
    } catch (e) {
      console.error("Failed to select folder:", e);
    }
  };

  const categoryLocationForFile = (fileName: string) => {
    const category = categoryForFileName(fileName);
    return resolveCategoryDestination(useSettingsStore.getState(), category);
  };

  const handleAction = async (action: AddDownloadAction) => {
    if (isSubmitting || isSubmittingRef.current || !canSubmitMetadataRows(parsedItems)) {
      return;
    }
    if (speedLimitEnabled && (!Number.isFinite(Number(speedLimit)) || Number(speedLimit) <= 0)) {
      addToast({ message: 'Speed limit must be greater than zero', variant: 'error', isActionable: true });
      return;
    }
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    let finalLocation = saveLocation;
    let useSharedDestination = isSaveLocationManual;
    const destinationOverrides: Record<number, string> = {};
    const settings = useSettingsStore.getState();
    const platform = await getPlatformInfo().catch(() => ({ os: 'unknown' }));
    if (settings.askWhereToSaveEachFile && parsedItems.length > 0) {
      for (const [index, item] of parsedItems.entries()) {
        if (item.selected === false) continue;
        try {
          const suggestedLocation = isSaveLocationManual
            ? finalLocation
            : await categoryLocationForFile(item.file);
          const selected = await open({
            directory: true,
            multiple: false,
            title: `Choose a folder for ${item.file}`,
            defaultPath: suggestedLocation.startsWith('~') ? undefined : suggestedLocation
          });
          if (selected && typeof selected === 'string') {
            const approvedPath = await useSettingsStore.getState().approveDownloadRoot(selected);
            destinationOverrides[index] = approvedPath;
          } else {
            isSubmittingRef.current = false;
            setIsSubmitting(false);
            return;
          }
        } catch (e) {
          console.error("Failed to select folder:", e);
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

    for (let i = 0; i < parsedItems.length; i++) {
      const item = parsedItems[i];
      if (item.selected === false) continue;
      let finalFile = item.isMedia
        ? mediaFileNameForSelectedFormat(item.file, item)
        : canonicalizeDownloadFileName(item.file);
      const itemLocation = useSharedDestination
        ? finalLocation
        : destinationOverrides[i] || await categoryLocationForFile(finalFile);

      const isUrlDupe = store.downloads.some(d => d.url === item.downloadUrl && d.status !== 'failed' && d.status !== 'completed');
      const hasBatchConflict = plannedTargets.some(target =>
        downloadLocationEquals(
          target.location,
          target.fileName,
          itemLocation,
          finalFile,
          platform.os
        )
      );
      if (isUrlDupe) {
        newConflicts.push({ id: i.toString(), fileName: finalFile, reason: { type: 'url', msg: 'URL already in queue' }, resolution: 'rename' });
      } else if (hasBatchConflict) {
        newConflicts.push({
          id: i.toString(),
          fileName: finalFile,
          reason: { type: 'file', msg: 'Another selected download uses this destination' },
          resolution: 'rename',
          replaceAllowed: false
        });
      } else {
        let fileExistsInStore = false;
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
            fileExistsInStore = true;
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

        if (fileExistsInStore || fileExistsOnDisk) {
          newConflicts.push({
            id: i.toString(),
            fileName: finalFile,
            reason: {
              type: 'file',
              msg: fileExistsInStore
                ? 'Existing Firelink download uses this destination'
                : 'File exists on disk; rename or skip to avoid deleting unrelated data'
            },
            resolution: 'rename',
            replaceAllowed: fileExistsInStore
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
        const itemLocation = useSharedDestination
          ? finalLocation
          : destinationOverrides[idx] || await categoryLocationForFile(finalFile);
                 
                 let count = 1;
                 const base = finalFile.substring(0, finalFile.lastIndexOf('.')) || finalFile;
                 const ext = finalFile.includes('.') ? finalFile.substring(finalFile.lastIndexOf('.')) : '';
                 let newName = finalFile;
                 let exists = true;
                 const batchTargets: Array<{ location: string; fileName: string }> = [];
                 for (const [candidateIndex, candidate] of itemsToAdd.entries()) {
                   if (!candidate || candidateIndex === idx) continue;
                   const candidateFile = candidate.isMedia
                     ? mediaFileNameForSelectedFormat(candidate.file, candidate)
                     : canonicalizeDownloadFileName(candidate.file);
                   const candidateLocation = useSharedDestination
                     ? finalLocation
                     : destinationOverrides[candidateIndex] || await categoryLocationForFile(candidateFile);
                   batchTargets.push({ location: candidateLocation, fileName: candidateFile });
                 }
                 
                 while (exists && count < 1000) {
          newName = `${base} (${count})${ext}`;
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
                   throw new Error(`Could not find an available name for ${finalFile}.`);
                 }
                 
                 itemsToAdd[idx] = { ...item, file: newName };
             } else if (res.resolution === 'replace') {
              if (conflict?.reason.type !== 'file' || !conflict.replaceAllowed) {
                itemsToAdd[idx] = null;
                continue;
              }
              let finalFile = item.isMedia
                ? mediaFileNameForSelectedFormat(item.file, item)
                : canonicalizeDownloadFileName(item.file);
        const itemLocation = useSharedDestination
          ? finalLocation
          : destinationOverrides[idx] || await categoryLocationForFile(finalFile);
        const store = useDownloadStore.getState();
        let existingItem;
        const currentSettings = useSettingsStore.getState();
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

                 if (existingItem && isTransferLocked(existingItem.status)) {
                   throw new Error(`Pause ${existingItem.fileName} before replacing it.`);
                 }

                 if (!existingItem) {
                   throw new Error(`Cannot replace ${finalFile}: file is not owned by a Firelink download.`);
                 }
                 // Let the backend decide whether resumable sidecars still
                 // exist after stopping the old transfer. This avoids a race
                 // where a paused item finishes while the replacement is
                 // being prepared.
                 await store.removeDownload(existingItem.id, true, existingItem.status !== 'completed');
             }
         }
      }

      let addedCount = 0;
      const failures: string[] = [];

      for (const [itemIndex, item] of itemsToAdd.entries()) {
        if (!item) continue;
        try {
          const id = crypto.randomUUID();
          let finalFile = item.isMedia
            ? mediaFileNameForSelectedFormat(item.file, item)
            : canonicalizeDownloadFileName(item.file);
          let formatSelector = mediaFormatSelectorForRow(item);
        const contextUrl = requestContextUrlForRow(item);

        const category = categoryForFileName(finalFile);
        const added = await addDownload({
          id,
          url: item.downloadUrl,
          fileName: finalFile,
          category,
          dateAdded: new Date().toISOString(),
          connections: Number(connections),
          speedLimit: speedLimitEnabled ? `${speedLimit}K` : undefined,
          username: useAuth ? username.trim() : undefined,
          password: useAuth ? password.trim() : undefined,
          headers: headersForRow(contextUrl) || undefined,
          checksum: checksumEnabled && checksumValue.trim()
            ? `${checksumAlgo}=${checksumValue.trim()}`
            : undefined,
          cookies: cookiesForRow(contextUrl, item.downloadUrl) || undefined,
          mirrors: mirrors.trim() || undefined,
          destination: useSharedDestination
            ? finalLocation
            : destinationOverrides[itemIndex],
          isMedia: item.isMedia,
          resumable: item.resumable,
          mediaFormatSelector: formatSelector,
          size: item.size || (item.sizeBytes ? formatBytes(item.sizeBytes) : undefined)
        }, action);
        if (!added) {
          throw new Error('Backend rejected download start.');
        }
        addedCount += 1;
        } catch (e) {
          console.error("Invalid URL or failed to add:", e);
          failures.push(`${item.file}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      toggleAddModal(false);
      if (failures.length > 0) {
        addToast({
          message: `${addedCount} added, ${failures.length} failed. ${failures[0]}`,
          variant: 'error',
          isActionable: true
        });
      } else if (addedCount > 0) {
        addToast({
          message: `${addedCount} download${addedCount === 1 ? '' : 's'} added`,
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

  const selectMediaFormat = (index: number) => {
    if (selectedItemIndex === null) return;
    const selectedItem = parsedItems[selectedItemIndex];
    const format = selectedItem?.formats?.[index];
    if (!selectedItem || !format) return;

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

  const selectedItems = parsedItems.filter(item => item.selected !== false);
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
  const activePlaylistUrls = new Set(
    urls.split('\n').map(url => url.trim()).filter(Boolean).map(normalizeComparableUrl)
  );
  const playlistSummaries = Object.entries(playlistExpansions)
    .filter(([sourceUrl]) => activePlaylistUrls.has(sourceUrl));

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
                  message: `Could not resolve duplicate downloads: ${String(error)}`,
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
    >
      <div className="app-modal add-download-modal flex flex-col overflow-hidden text-sm">

        {/* Main Content Split */}
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* Left Column: URLs and Preview */}
          <div className="add-download-left w-[55%] border-r border-border-modal flex flex-col">
            <div className="add-download-pane p-5 flex-1 min-h-0 min-w-0 flex flex-col gap-5">

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="add-download-section-title flex items-center gap-2">
                    <Link size={16} className="text-blue-500" />
                    Download Links
                  </div>
                </div>
                <textarea
                  className="add-download-control add-download-links-input w-full h-32 p-3 text-[13px] resize-none"
                  placeholder={"Paste HTTP, HTTPS, FTP, or SFTP URLs here...\n\nFor media downloads, paste links from Youtube, X, TikTok, Instagram, Reddit, etc."}
                  value={urls}
                  onChange={(e) => setUrls(e.target.value)}
                />
                {playlistSummaries.map(([sourceUrl, playlist]) => {
                  const total = playlist.entry_count || playlist.entries.length;
                  return (
                    <p key={sourceUrl} className="px-1 text-[11px] text-purple-500 dark:text-purple-400">
                      Playlist “{playlist.title}”: {playlist.entries.length}{total > playlist.entries.length ? ` of ${total}` : ''} entries loaded
                      {playlist.truncated ? ' (safe entry limit reached)' : ''}
                      {playlist.skipped_entries > 0 ? `; ${playlist.skipped_entries} skipped, unavailable, duplicated, or outside the safe limit` : ''}.
                    </p>
                  );
                })}
                <div className="flex justify-between items-center px-1">
                  <span className="text-[11px] text-text-muted font-medium">
                    {selectedItems.filter(item => item.status === 'ready').length} selected ready, {fallbackMetadataCount} fallback, {failedMediaMetadataCount} media retry, {blockedMetadataCount} blocked
                  </span>
                    <button
                      type="button"
                      onClick={() => setParsedItems(refreshFailedMetadataRows)}
                      disabled={failedMetadataCount === 0}
                      className="add-download-link-button flex items-center gap-1.5 text-[11px] font-medium"
                    >
                      <RefreshCw size={12} /> Refresh Metadata
                    </button>
                    <button
                      type="button"
                      onClick={toggleAllRows}
                      disabled={parsedItems.length === 0}
                      className="add-download-link-button ml-3 text-[11px] font-medium"
                    >
                      {allRowsSelected ? 'Clear selection' : 'Select all'}
                    </button>
                  </div>
              </div>

              <div className="grid grid-cols-4 gap-3">
                <SummaryBox title="Files" value={selectedItems.length === parsedItems.length ? parsedItems.length : `${selectedItems.length}/${parsedItems.length}`} icon={FileText} color="text-blue-500" />
                <SummaryBox title="Required" value={requiredStr} icon={Database} color="text-orange-500" />
                <SummaryBox title="Free" value={freeSpace} icon={HardDrive} color="text-green-500" />
                <SummaryBox title="Unknown" value={selectedItems.filter(i => !i.sizeBytes).length} icon={FileText} color="text-purple-500" />
              </div>

              <div className="flex flex-col gap-2 flex-1 min-h-0 min-w-0 overflow-hidden">
                <div className="add-download-section-title flex items-center gap-2">
                  <ArrowRight size={16} className="text-blue-500" />
                  Preview
                </div>
                <div className="add-download-preview flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col">
                  <div className="add-download-preview-header px-3 py-2 flex text-[11px] font-semibold text-text-muted uppercase tracking-wider">
                    <div className="flex-[2]">File</div>
                    <div className="flex-1">Size</div>
                    <div className="flex-[1.5]">Status</div>
                  </div>
                  <div className="flex-1 min-h-0 min-w-0 overflow-y-auto p-2 space-y-1" role="listbox" aria-label="Download preview">
                    {parsedItems.length === 0 ? (
                      <div className="add-download-empty h-full flex items-center justify-center text-text-muted text-xs">
                        No links added yet.
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
                              aria-label={`Select ${item.file}`}
                              className="mr-2 shrink-0 accent-purple-500"
                            />
                            <div className="flex-[2] text-text-primary font-medium truncate pr-2" title={item.file}>{item.file}</div>
                            <div className={`flex-1 font-mono ${item.status === 'loading' ? 'text-text-muted/50' : 'text-text-muted'}`}>{item.size || 'Unknown'}</div>
                            <div className={`flex-[1.5] font-medium ${item.status === 'metadata-error' || item.status === 'invalid' ? 'text-red-500' : item.status === 'loading' ? 'text-orange-400' : 'text-blue-500'}`}>
                              {item.status === 'loading' ? (
                                <div className="flex items-center gap-1.5">
                                  <RefreshCw size={12} className="animate-spin" /> {item.isPlaylist ? 'Fetching playlist...' : 'Fetching...'}
                                </div>
                              ) : (
                                item.status === 'metadata-error'
                                  ? item.metadataBlockedReason === 'unsafe-url' ? 'Unsafe URL' : item.isPlaylist ? 'Playlist failed' : item.isMedia ? 'Metadata failed' : 'Fallback'
                                  : item.status === 'invalid'
                                    ? 'Invalid'
                                    : 'Ready'
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

              {/* Media Format (Dynamic) */}
              {selectedItemIndex !== null && parsedItems[selectedItemIndex]?.isMedia && (
                <section className="add-download-section add-download-media-section relative overflow-hidden p-4">
                  <div className="absolute top-0 right-0 p-2 opacity-10">
                    <Video size={48} />
                  </div>
                  <div className="add-download-section-title flex items-center gap-2 mb-3 relative z-10">
                    <Video size={16} className="text-purple-500" /> Media Format
                    {parsedItems[selectedItemIndex].playlistSourceUrl && (
                      <span className="text-[10px] font-normal text-text-muted">
                        Playlist item {parsedItems[selectedItemIndex].playlistIndex || '?'}
                      </span>
                    )}
                  </div>

                  {parsedItems[selectedItemIndex].status === 'loading' ? (
                    <div className="flex flex-col items-center justify-center py-6 gap-3 relative z-10">
                      <RefreshCw size={24} className="animate-spin text-purple-500" />
                      <span className="text-xs text-text-muted font-medium animate-pulse">Fetching media streams...</span>
                    </div>
                  ) : parsedItems[selectedItemIndex].formats ? (
                    <div className="space-y-3 relative z-10">
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[10px] uppercase font-bold tracking-wider text-text-muted">Available Streams</label>
                        <div className="flex flex-col gap-1 max-h-48 overflow-y-auto pr-1" role="radiogroup" aria-label="Available media streams">
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
                      <span className="text-xs text-red-400 font-medium">Metadata unavailable. Refresh metadata before adding this media.</span>
                    </div>
                  )}
                </section>
              )}

              {/* Save Location */}
              <section className="add-download-section">
                <div className="add-download-section-title flex items-center gap-2 mb-3">
                  <FolderPlus size={16} className="text-blue-500" /> Save Location
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={saveLocation}
                    className="add-download-control flex-1 px-3 py-1.5 text-xs text-text-muted font-mono"
                    aria-label="Save location"
                  />
                  <button
                    onClick={handleBrowse}
                    className="add-download-button add-download-button-secondary px-3 text-xs font-medium"
                  >
                    Browse
                  </button>
                </div>
                {parsedItems.length > 1 && !isSaveLocationManual && (
                  <p className="mt-2 text-[11px] text-text-muted">
                    Files will be organized into category folders.
                  </p>
                )}
                {isSaveLocationManual && (
                  <p className="mt-2 text-[11px] text-text-muted">
                    All selected downloads will use this folder.
                  </p>
                )}
              </section>

              {/* Transfer Settings */}
              <section className="add-download-section">
                <div className="add-download-section-title flex items-center gap-2 mb-3">
                  <Settings size={16} className="text-blue-500" /> Transfer Settings
                </div>
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-text-secondary font-medium">Connections per File</label>
                    <div className="flex items-center gap-2">
                      <input type="range" min="1" max="16" value={connections} onChange={e=>setConnections(Number(e.target.value))} className="add-download-range w-24 accent-blue-500 cursor-pointer" aria-label="Connections per file" />
                      <span className="add-download-value text-xs text-text-primary font-mono w-6 text-center">{connections}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-xs text-text-secondary font-medium cursor-pointer">
                      <input type="checkbox" checked={speedLimitEnabled} onChange={e=>setSpeedLimitEnabled(e.target.checked)} className="add-download-checkbox" />
                      Limit speed per file
                    </label>
                    {speedLimitEnabled && (
                      <div className="flex items-center gap-1.5">
                        <input type="number" value={speedLimit} onChange={e=>setSpeedLimit(e.target.value)} className="add-download-control w-16 px-2 py-1 text-xs font-mono" aria-label="Speed limit per file" />
                        <span className="text-[10px] text-text-muted">KiB/s</span>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* Authorization */}
              <section className="add-download-section">
                <div className="add-download-section-title flex items-center gap-2 mb-3">
                  <Shield size={16} className="text-blue-500" /> Authorization
                </div>
                <label className="flex items-center gap-2 text-xs text-text-secondary font-medium cursor-pointer mb-3">
                  <input type="checkbox" checked={useAuth} onChange={e=>setUseAuth(e.target.checked)} className="add-download-checkbox" />
                  Use authorization
                </label>

                {useAuth && (
                  <div className="space-y-2.5 pl-5 border-l-2 border-border-modal/50">
                    <input type="text" value={username} onChange={e=>setUsername(e.target.value)} placeholder="Username" className="add-download-control w-full px-3 py-1.5 text-xs" />
                    <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password" className="add-download-control w-full px-3 py-1.5 text-xs" />
                  </div>
                )}
              </section>

              {/* Advanced */}
              <section className="add-download-section add-download-advanced">
                <button
                  onClick={() => setAdvancedExpanded(!advancedExpanded)}
                  className="add-download-advanced-toggle flex items-center gap-2 text-sm font-semibold text-text-primary w-full"
                  aria-expanded={advancedExpanded}
                >
                  {advancedExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  Advanced Transfer
                </button>

                {advancedExpanded && (
                  <div className="mt-4 space-y-4 pl-6">
                    <label className="flex items-center gap-2 text-xs text-text-secondary font-medium cursor-pointer">
                      <input type="checkbox" checked={checksumEnabled} onChange={e=>setChecksumEnabled(e.target.checked)} className="add-download-checkbox" />
                      Verify Checksum
                    </label>

                    {checksumEnabled && (
                      <div className="flex gap-2">
                        <select value={checksumAlgo} onChange={e=>setChecksumAlgo(e.target.value)} className="add-download-control add-download-select w-24 px-2 text-xs" aria-label="Checksum algorithm">
                          <option>MD5</option><option>SHA-1</option><option>SHA-256</option>
                        </select>
                        <input type="text" value={checksumValue} onChange={e=>setChecksumValue(e.target.value)} placeholder="Expected digest" className="add-download-control flex-1 px-3 py-1.5 text-xs font-mono" />
                      </div>
                    )}

                    <div>
                      <label className="block text-[10px] uppercase font-bold tracking-wider text-text-muted mb-1">Headers</label>
                      <textarea
                        value={headers}
                        onChange={e => {
                          headersManuallyEditedRef.current = true;
                          setHeaders(e.target.value);
                        }}
                        className="add-download-control w-full h-12 px-3 py-1.5 text-xs font-mono resize-none"
                        aria-label="Request headers"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase font-bold tracking-wider text-text-muted mb-1">Cookies</label>
                      <input
                        type="text"
                        value={cookies}
                        onChange={e => {
                          cookiesManuallyEditedRef.current = true;
                          setCookies(e.target.value);
                        }}
                        placeholder="name=value; other=value"
                        className="add-download-control w-full px-3 py-1.5 text-xs font-mono"
                        aria-label="Cookies"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase font-bold tracking-wider text-text-muted mb-1">Mirrors</label>
                      <textarea value={mirrors} onChange={e=>setMirrors(e.target.value)} className="add-download-control w-full h-12 px-3 py-1.5 text-xs font-mono resize-none" aria-label="Mirrors" />
                    </div>
                  </div>
                )}
              </section>

            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="add-download-footer p-4 flex items-center shrink-0">
          <div className="text-[11px] text-text-muted font-medium flex-1">
            {metadataSummaryMessage(parsedItems)}
          </div>
          <div className="flex gap-2.5">
            <button onClick={closeModalFromDismissAction} disabled={isSubmitting || showKeychainModal} className="add-download-button add-download-button-cancel px-4 text-xs">
              Cancel
            </button>
            <div ref={actionMenuRef} className="relative flex gap-2.5">
              <button
                onClick={() => handleAction({ type: 'start-now' })}
                disabled={!canSubmit || isSubmitting}
                className="add-download-button add-download-button-primary px-5 text-xs"
              >
                <Play size={12} fill="currentColor" /> Start Downloads
              </button>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsQueueMenuOpen(open => !open)}
                  disabled={!canSubmit || isSubmitting}
                  className="add-download-button add-download-button-secondary px-4 text-xs"
                  aria-label="Add to queue"
                  aria-haspopup="menu"
                  aria-expanded={isQueueMenuOpen}
                >
                  Add to queue <ChevronDown size={14} className="ml-1" />
                </button>
                {isQueueMenuOpen && (
                  <div
                    role="menu"
                    className="app-modal absolute bottom-full right-0 z-[70] mb-2 min-w-[200px] overflow-visible py-1.5 text-xs"
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
                        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-item-hover"
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

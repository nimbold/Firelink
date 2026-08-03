import { useState, useEffect, useRef } from 'react';
import { useDownloadStore, DownloadItem } from '../store/useDownloadStore';
import { useDownloadProgressStore } from '../store/downloadProgressStore';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore } from '../store/useSettingsStore';
import type { TorrentPeerDiagnostics } from '../bindings/TorrentPeerDiagnostics';
import type { TorrentFileProgressSnapshot } from '../bindings/TorrentFileProgressSnapshot';
import type { TorrentPieceProgressSnapshot } from '../bindings/TorrentPieceProgressSnapshot';
import type { TorrentFileSelectionSnapshot } from '../bindings/TorrentFileSelectionSnapshot';
import type { TorrentDetails } from '../bindings/TorrentDetails';
import type { TorrentWebSeed } from '../bindings/TorrentWebSeed';
import { invokeCommand as invoke } from '../ipc';
import { ChevronDown, ChevronRight, FolderPlus, Info, CheckCircle, AlertCircle, Play, Pause } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { resolveCategoryDestination } from '../utils/downloadLocations';
import {
  getPauseResumeAction,
  isIdentityLocked as getIdentityLocked,
  isTransferLocked as getTransferLocked
} from '../utils/downloadActions';
import {
  downloadProgressColorClass,
  formatDownloadBytes,
  formatDownloadTotal,
  resolveDownloadSizeDisplay
} from '../utils/downloadProgress';
import { isValidTorrentExcludeTrackerList, isValidTorrentTrackerList, MAX_TORRENT_STOP_TIMEOUT, MAX_TORRENT_TRACKER_INTERVAL, MAX_TORRENT_TRACKER_TIMEOUT, normalizeSpeedLimitForBackend, normalizeTorrentEncryptionPolicy, normalizeTorrentFileAllocation, normalizeTorrentPrioritizePiece, normalizeTorrentTrackerInterval, normalizeTorrentTrackerTimeout, resolveDownloadConnections, TORRENT_ENCRYPTION_POLICY_DISABLED, TORRENT_ENCRYPTION_POLICY_FORCE_ENCRYPTION, TORRENT_ENCRYPTION_POLICY_REQUIRE_CRYPTO, type TorrentEncryptionPolicy, type TorrentFileAllocation } from '../utils/downloads';
import { useTranslation } from 'react-i18next';
import { formatDateTime, type CalendarPreference } from '../utils/dateTime';
import { isTopmostModal, useModalFocus } from '../hooks/useModalFocus';

type LoginMode = 'matching' | 'custom' | 'none';

const formatLastTry = (
  value: string | undefined,
  locale: string,
  calendar: CalendarPreference
): string => {
  if (!value) return '-';
  return formatDateTime(value, {
    locale,
    calendar,
    options: { dateStyle: 'medium', timeStyle: 'short' }
  });
};

const isPeerDiagnosticsStatus = (status: string): boolean =>
  ['downloading', 'verifying', 'seeding', 'retrying'].includes(status);

const isTorrentFileProgressStatus = (status: string): boolean =>
  ['downloading', 'verifying', 'seeding', 'waitingToSeed', 'retrying', 'paused'].includes(status);

const formatPeerSpeed = (bytesPerSecond: number): string =>
  `${formatDownloadBytes(bytesPerSecond)}/s`;

export const PropertiesModal = () => {
  const { t, i18n } = useTranslation();
  const categoryLabel = (category: string) => {
    switch (category) {
      case 'Musics': return t($ => $.navigation.categories.musics);
      case 'Movies': return t($ => $.navigation.categories.movies);
      case 'Compressed': return t($ => $.navigation.categories.compressed);
      case 'Documents': return t($ => $.navigation.categories.documents);
      case 'Pictures': return t($ => $.navigation.categories.pictures);
      case 'Applications': return t($ => $.navigation.categories.applications);
      default: return t($ => $.navigation.categories.other);
    }
  };
  const selectedPropertiesDownloadId = useDownloadStore(state => state.selectedPropertiesDownloadId);
  const setSelectedPropertiesDownloadId = useDownloadStore(state => state.setSelectedPropertiesDownloadId);
  const item = useDownloadStore(useShallow(state =>
    selectedPropertiesDownloadId
      ? state.downloads.find(d => d.id === selectedPropertiesDownloadId) ?? null
      : null
  ));
  const liveProgress = useDownloadProgressStore(useShallow(state =>
    selectedPropertiesDownloadId
      ? state.progressMap[selectedPropertiesDownloadId]
      : undefined
  ));

  const { baseDownloadFolder, perServerConnections, calendarPreference } = useSettingsStore();

  // Form states
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [saveLocation, setSaveLocation] = useState('');
  const [connections, setConnections] = useState(() => resolveDownloadConnections(undefined, perServerConnections));
  const [connectionsDirty, setConnectionsDirty] = useState(false);
  
  const [speedLimitEnabled, setSpeedLimitEnabled] = useState(false);
  const [speedLimitValue, setSpeedLimitValue] = useState('1024'); // KiB/s
  const [liveSpeedLimitValue, setLiveSpeedLimitValue] = useState('');
  const [liveTorrentUploadLimitValue, setLiveTorrentUploadLimitValue] = useState('');
  const [liveTorrentMaxPeersValue, setLiveTorrentMaxPeersValue] = useState('');
  const [liveTorrentPeerSpeedLimitValue, setLiveTorrentPeerSpeedLimitValue] = useState('');
  const [torrentCheckIntegrity, setTorrentCheckIntegrity] = useState(false);
  const [torrentRemoveUnselectedFile, setTorrentRemoveUnselectedFile] = useState(false);
  const [torrentEncryptionPolicy, setTorrentEncryptionPolicy] = useState<TorrentEncryptionPolicy>(TORRENT_ENCRYPTION_POLICY_DISABLED);
  const [torrentFileAllocation, setTorrentFileAllocation] = useState<TorrentFileAllocation>('prealloc');
  const [torrentTrackers, setTorrentTrackers] = useState('');
  const [torrentExcludeTrackers, setTorrentExcludeTrackers] = useState('');
  const [torrentTrackerConnectTimeout, setTorrentTrackerConnectTimeout] = useState('');
  const [torrentTrackerTimeout, setTorrentTrackerTimeout] = useState('');
  const [torrentTrackerInterval, setTorrentTrackerInterval] = useState('0');
  const [torrentStopTimeout, setTorrentStopTimeout] = useState('0');
  const [torrentPrioritizePiece, setTorrentPrioritizePiece] = useState('');
  const [torrentPeerDiagnostics, setTorrentPeerDiagnostics] = useState<TorrentPeerDiagnostics | null>(null);
  const [torrentPeerDiagnosticsError, setTorrentPeerDiagnosticsError] = useState(false);
  const [isTorrentPeerDiagnosticsPending, setIsTorrentPeerDiagnosticsPending] = useState(false);
  const [torrentFileProgress, setTorrentFileProgress] = useState<TorrentFileProgressSnapshot | null>(null);
  const [torrentFileSelection, setTorrentFileSelection] = useState<TorrentFileSelectionSnapshot | null>(null);
  const [torrentDetails, setTorrentDetails] = useState<TorrentDetails | null>(null);
  const [torrentDetailsError, setTorrentDetailsError] = useState(false);
  const [isTorrentDetailsPending, setIsTorrentDetailsPending] = useState(false);
  const [isTorrentVerifyPending, setIsTorrentVerifyPending] = useState(false);
  const [torrentFileProgressError, setTorrentFileProgressError] = useState(false);
  const [isTorrentFileProgressPending, setIsTorrentFileProgressPending] = useState(false);
  const [torrentPieceProgress, setTorrentPieceProgress] = useState<TorrentPieceProgressSnapshot | null>(null);
  const [torrentPieceProgressError, setTorrentPieceProgressError] = useState(false);
  const [isTorrentPieceProgressPending, setIsTorrentPieceProgressPending] = useState(false);
  const [isLiveSpeedLimitPending, setIsLiveSpeedLimitPending] = useState(false);
  const [isLiveTorrentUploadLimitPending, setIsLiveTorrentUploadLimitPending] = useState(false);
  const [isLiveTorrentPeerOptionsPending, setIsLiveTorrentPeerOptionsPending] = useState(false);
  const [torrentWebSeedsText, setTorrentWebSeedsText] = useState('');
  const [torrentWebSeedsError, setTorrentWebSeedsError] = useState(false);
  const [isTorrentWebSeedsPending, setIsTorrentWebSeedsPending] = useState(false);

  const [loginMode, setLoginMode] = useState<LoginMode>('matching');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [checksumEnabled, setChecksumEnabled] = useState(false);
  const [checksumAlgorithm, setChecksumAlgorithm] = useState('SHA-256');
  const [checksumValue, setChecksumValue] = useState('');
  const [cookies, setCookies] = useState('');
  const [headers, setHeaders] = useState('');
  const [mirrors, setMirrors] = useState('');

  const [errorMessage, setErrorMessage] = useState('');
  const [isPauseResumePending, setIsPauseResumePending] = useState(false);
  const torrentFileProgressByIndex = new Map(
    (torrentFileProgress?.files ?? []).map(file => [file.index, file])
  );
  const actionRequestRef = useRef(0);
  const peerDiagnosticsRequestRef = useRef(0);
  const torrentFileProgressRequestRef = useRef(0);
  const torrentFileSelectionRequestRef = useRef(0);
  const torrentDetailsRequestRef = useRef(0);
  const torrentPieceProgressRequestRef = useRef(0);
  const torrentWebSeedsRequestRef = useRef(0);
  const modalRef = useModalFocus(Boolean(selectedPropertiesDownloadId && item));

  useEffect(() => {
    // Invalidate native pickers and transfer-control results when the modal
    // switches items, closes, or reopens for the same download.
    actionRequestRef.current += 1;
    setIsLiveSpeedLimitPending(false);
    setIsLiveTorrentUploadLimitPending(false);
    setIsLiveTorrentPeerOptionsPending(false);
    peerDiagnosticsRequestRef.current += 1;
    setTorrentPeerDiagnostics(null);
    setTorrentPeerDiagnosticsError(false);
    setIsTorrentPeerDiagnosticsPending(false);
    torrentFileProgressRequestRef.current += 1;
    setTorrentFileProgress(null);
    setTorrentFileProgressError(false);
    setIsTorrentFileProgressPending(false);
    torrentDetailsRequestRef.current += 1;
    setTorrentDetails(null);
    setTorrentDetailsError(false);
    setIsTorrentDetailsPending(false);
    torrentPieceProgressRequestRef.current += 1;
    setTorrentPieceProgress(null);
    setTorrentPieceProgressError(false);
    setIsTorrentPieceProgressPending(false);
    torrentWebSeedsRequestRef.current += 1;
    setTorrentWebSeedsError(false);
    setIsTorrentWebSeedsPending(false);
  }, [selectedPropertiesDownloadId]);

  useEffect(() => {
    if (selectedPropertiesDownloadId) {
      const activeItem = useDownloadStore.getState().downloads.find(d => d.id === selectedPropertiesDownloadId);
      if (activeItem) {
        setUrl(activeItem.url);
        setFileName(activeItem.fileName);
        if (activeItem.destination) {
          setSaveLocation(activeItem.destination);
        } else {
          const propertiesDownloadId = selectedPropertiesDownloadId;
          const requestId = actionRequestRef.current;
          void resolveCategoryDestination(
            useSettingsStore.getState(),
            activeItem.category
          ).then(location => {
            if (
              requestId === actionRequestRef.current
              && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
            ) {
              setSaveLocation(location);
            }
          });
        }
        setConnections(resolveDownloadConnections(activeItem.connections, perServerConnections));
        setConnectionsDirty(false);
        
        if (activeItem.speedLimit) {
           setSpeedLimitEnabled(true);
           setSpeedLimitValue(activeItem.speedLimit.replace(/[^0-9]/g, ''));
        } else {
           setSpeedLimitEnabled(false);
        }

        if (activeItem.username || activeItem.password) {
           setLoginMode('custom');
           setUsername(activeItem.username || '');
           setPassword(activeItem.password || '');
        } else {
           setLoginMode('matching');
           setUsername('');
           setPassword('');
        }

        setHeaders(activeItem.headers || '');
        setChecksumEnabled(!!activeItem.checksum);
        if (activeItem.checksum) {
           const [algo, val] = activeItem.checksum.split('=');
           if (val) {
               setChecksumAlgorithm(algo);
               setChecksumValue(val);
           }
        } else {
           setChecksumAlgorithm('SHA-256');
           setChecksumValue('');
        }
        setCookies(activeItem.cookies || '');
        setMirrors(activeItem.mirrors || '');
        setLiveTorrentMaxPeersValue(
          activeItem.torrentMaxPeers === undefined ? '' : String(activeItem.torrentMaxPeers)
        );
        setLiveTorrentPeerSpeedLimitValue(activeItem.torrentPeerSpeedLimit || '');
        setTorrentCheckIntegrity(activeItem.torrentCheckIntegrity === true);
        setTorrentRemoveUnselectedFile(activeItem.torrentRemoveUnselectedFile === true);
        setTorrentEncryptionPolicy(normalizeTorrentEncryptionPolicy(activeItem.torrentEncryptionPolicy) || TORRENT_ENCRYPTION_POLICY_DISABLED);
        setTorrentFileAllocation(normalizeTorrentFileAllocation(activeItem.torrentFileAllocation) || 'prealloc');
        setTorrentTrackers(activeItem.torrentTrackers || '');
        setTorrentExcludeTrackers(activeItem.torrentExcludeTrackers || '');
        setTorrentTrackerConnectTimeout(activeItem.torrentTrackerConnectTimeout === undefined ? '' : String(activeItem.torrentTrackerConnectTimeout));
        setTorrentTrackerTimeout(activeItem.torrentTrackerTimeout === undefined ? '' : String(activeItem.torrentTrackerTimeout));
        setTorrentTrackerInterval(activeItem.torrentTrackerInterval === undefined ? '0' : String(activeItem.torrentTrackerInterval));
        setTorrentStopTimeout(activeItem.torrentStopTimeout === undefined ? '0' : String(activeItem.torrentStopTimeout));
        setTorrentPrioritizePiece(activeItem.torrentPrioritizePiece || '');
        setTorrentWebSeedsText((activeItem.torrentWebSeeds || [])
          .map(seed => `${seed.fileIndex}|${seed.uri}`)
          .join('\n'));
        setErrorMessage('');
      } else {
        setSelectedPropertiesDownloadId(null);
      }
    }
  }, [selectedPropertiesDownloadId, setSelectedPropertiesDownloadId]);

  useEffect(() => {
    torrentFileSelectionRequestRef.current += 1;
    setTorrentFileSelection(null);
    if (!selectedPropertiesDownloadId || !item?.isTorrent) return;
    const requestId = torrentFileSelectionRequestRef.current;
    const propertiesDownloadId = item.id;
    void invoke('get_torrent_file_selection', { id: propertiesDownloadId })
      .then(snapshot => {
        if (
          requestId === torrentFileSelectionRequestRef.current
          && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
        ) {
          setTorrentFileSelection(snapshot);
        }
      })
      .catch(() => {
        if (requestId === torrentFileSelectionRequestRef.current) setTorrentFileSelection(null);
      });
  }, [item?.id, item?.isTorrent, item?.torrentPath, selectedPropertiesDownloadId]);

  useEffect(() => {
    torrentDetailsRequestRef.current += 1;
    setTorrentDetails(null);
    setTorrentDetailsError(false);
    setIsTorrentDetailsPending(false);
    if (!selectedPropertiesDownloadId || !item?.isTorrent || !item.torrentPath) return;

    const requestId = torrentDetailsRequestRef.current;
    const propertiesDownloadId = item.id;
    setIsTorrentDetailsPending(true);
    void invoke('get_torrent_details', { id: propertiesDownloadId })
      .then(details => {
        if (
          requestId === torrentDetailsRequestRef.current
          && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
        ) {
          setTorrentDetails(details);
        }
      })
      .catch(() => {
        if (
          requestId === torrentDetailsRequestRef.current
          && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
        ) {
          setTorrentDetailsError(true);
        }
      })
      .finally(() => {
        if (requestId === torrentDetailsRequestRef.current) setIsTorrentDetailsPending(false);
      });
  }, [item?.id, item?.isTorrent, item?.torrentPath, selectedPropertiesDownloadId]);

  useEffect(() => {
    const activeLimit = item?.speedLimit?.trim();
    setLiveSpeedLimitValue(activeLimit && activeLimit !== '0' ? activeLimit : '');
  }, [item?.speedLimit, selectedPropertiesDownloadId]);

  useEffect(() => {
    const activeLimit = item?.torrentUploadLimit?.trim();
    setLiveTorrentUploadLimitValue(activeLimit && activeLimit !== '0' ? activeLimit : '');
  }, [item?.torrentUploadLimit, selectedPropertiesDownloadId]);

  useEffect(() => {
    peerDiagnosticsRequestRef.current += 1;
    setTorrentPeerDiagnostics(null);
    setTorrentPeerDiagnosticsError(false);
    setIsTorrentPeerDiagnosticsPending(false);
  }, [item?.id, item?.isTorrent, item?.lastTry, item?.status]);

  useEffect(() => {
    torrentFileProgressRequestRef.current += 1;
    setTorrentFileProgress(null);
    setTorrentFileProgressError(false);
    setIsTorrentFileProgressPending(false);
    if (
      !selectedPropertiesDownloadId
      || !item?.isTorrent
      || !isTorrentFileProgressStatus(item.status)
    ) return;

    const requestId = torrentFileProgressRequestRef.current;
    const propertiesDownloadId = item.id;
    setIsTorrentFileProgressPending(true);
    void invoke('get_torrent_file_progress', { id: propertiesDownloadId })
      .then(snapshot => {
        const currentItem = useDownloadStore.getState().downloads.find(download => download.id === propertiesDownloadId);
        if (
          requestId === torrentFileProgressRequestRef.current
          && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
          && currentItem?.isTorrent
          && isTorrentFileProgressStatus(currentItem.status)
        ) {
          setTorrentFileProgress(snapshot);
        }
      })
      .catch(() => {
        const currentItem = useDownloadStore.getState().downloads.find(download => download.id === propertiesDownloadId);
        if (
          requestId === torrentFileProgressRequestRef.current
          && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
          && currentItem?.isTorrent
          && isTorrentFileProgressStatus(currentItem.status)
        ) {
          setTorrentFileProgressError(true);
        }
      })
      .finally(() => {
        if (requestId === torrentFileProgressRequestRef.current) {
          setIsTorrentFileProgressPending(false);
        }
      });
  }, [item?.id, item?.isTorrent, item?.lastTry, item?.status, selectedPropertiesDownloadId]);

  useEffect(() => {
    torrentWebSeedsRequestRef.current += 1;
    setTorrentWebSeedsError(false);
    setIsTorrentWebSeedsPending(false);
    if (!selectedPropertiesDownloadId || !item?.isTorrent || !isTorrentFileProgressStatus(item.status)) return;
    const requestId = torrentWebSeedsRequestRef.current;
    const propertiesDownloadId = item.id;
    setIsTorrentWebSeedsPending(true);
    void invoke('get_torrent_web_seeds', { id: propertiesDownloadId })
      .then(seeds => {
        if (
          requestId === torrentWebSeedsRequestRef.current
          && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
        ) {
          setTorrentWebSeedsText(seeds.map(seed => `${seed.fileIndex}|${seed.uri}`).join('\n'));
          useDownloadStore.getState().updateDownload(propertiesDownloadId, { torrentWebSeeds: seeds });
        }
      })
      .catch(() => {
        if (requestId === torrentWebSeedsRequestRef.current) setTorrentWebSeedsError(true);
      })
      .finally(() => {
        if (requestId === torrentWebSeedsRequestRef.current) setIsTorrentWebSeedsPending(false);
      });
  }, [item?.id, item?.isTorrent, item?.status, selectedPropertiesDownloadId]);

  useEffect(() => {
    torrentPieceProgressRequestRef.current += 1;
    setTorrentPieceProgress(null);
    setTorrentPieceProgressError(false);
    setIsTorrentPieceProgressPending(false);
    if (
      !selectedPropertiesDownloadId
      || !item?.isTorrent
      || !isTorrentFileProgressStatus(item.status)
    ) return;

    const requestId = torrentPieceProgressRequestRef.current;
    const propertiesDownloadId = item.id;
    setIsTorrentPieceProgressPending(true);
    void invoke('get_torrent_piece_progress', { id: propertiesDownloadId })
      .then(snapshot => {
        const currentItem = useDownloadStore.getState().downloads.find(download => download.id === propertiesDownloadId);
        if (
          requestId === torrentPieceProgressRequestRef.current
          && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
          && currentItem?.isTorrent
          && isTorrentFileProgressStatus(currentItem.status)
        ) {
          setTorrentPieceProgress(snapshot);
        }
      })
      .catch(() => {
        const currentItem = useDownloadStore.getState().downloads.find(download => download.id === propertiesDownloadId);
        if (
          requestId === torrentPieceProgressRequestRef.current
          && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
          && currentItem?.isTorrent
          && isTorrentFileProgressStatus(currentItem.status)
        ) {
          setTorrentPieceProgressError(true);
        }
      })
      .finally(() => {
        if (requestId === torrentPieceProgressRequestRef.current) {
          setIsTorrentPieceProgressPending(false);
        }
      });
  }, [item?.id, item?.isTorrent, item?.lastTry, item?.status, selectedPropertiesDownloadId]);

  useEffect(() => {
    setLiveTorrentMaxPeersValue(
      item?.torrentMaxPeers === undefined ? '' : String(item.torrentMaxPeers)
    );
    setLiveTorrentPeerSpeedLimitValue(item?.torrentPeerSpeedLimit || '');
  }, [item?.torrentMaxPeers, item?.torrentPeerSpeedLimit, selectedPropertiesDownloadId]);

  useEffect(() => {
    if (!selectedPropertiesDownloadId || connectionsDirty) return;
    const activeItem = useDownloadStore.getState().downloads.find(d => d.id === selectedPropertiesDownloadId);
    if (activeItem && activeItem.connections === undefined) {
      setConnections(resolveDownloadConnections(undefined, perServerConnections));
    }
  }, [selectedPropertiesDownloadId, perServerConnections, connectionsDirty]);

  useEffect(() => {
    if (!selectedPropertiesDownloadId) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isTopmostModal(modalRef.current)) {
        event.preventDefault();
        setSelectedPropertiesDownloadId(null);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [selectedPropertiesDownloadId, setSelectedPropertiesDownloadId]);

  if (!selectedPropertiesDownloadId || !item) return null;

  const handleBrowse = async () => {
    if (identityLocked) return;
    const requestId = ++actionRequestRef.current;
    const propertiesDownloadId = item.id;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: saveLocation.startsWith('~') ? undefined : saveLocation
      });
      if (
        selected
        && typeof selected === 'string'
        && requestId === actionRequestRef.current
        && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
      ) {
        setSaveLocation(selected);
      }
    } catch (e) {
      console.error("Failed to select folder:", e);
    }
  };

  const handleRefreshTorrentPeers = async () => {
    if (
      isTorrentPeerDiagnosticsPending
      || !item.isTorrent
      || !isPeerDiagnosticsStatus(item.status)
    ) return;

    const requestId = ++peerDiagnosticsRequestRef.current;
    const propertiesDownloadId = item.id;
    setIsTorrentPeerDiagnosticsPending(true);
    setTorrentPeerDiagnosticsError(false);
    try {
      const diagnostics = await invoke('get_torrent_peers', { id: propertiesDownloadId });
      const currentItem = useDownloadStore.getState().downloads.find(download => download.id === propertiesDownloadId);
      if (
        requestId === peerDiagnosticsRequestRef.current
        && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
        && currentItem?.isTorrent
        && isPeerDiagnosticsStatus(currentItem.status)
      ) {
        setTorrentPeerDiagnostics(diagnostics);
      }
    } catch {
      const currentItem = useDownloadStore.getState().downloads.find(download => download.id === propertiesDownloadId);
      if (
        requestId === peerDiagnosticsRequestRef.current
        && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
        && currentItem?.isTorrent
        && isPeerDiagnosticsStatus(currentItem.status)
      ) {
        setTorrentPeerDiagnosticsError(true);
        setTorrentPeerDiagnostics(null);
      }
    } finally {
      if (requestId === peerDiagnosticsRequestRef.current) {
        setIsTorrentPeerDiagnosticsPending(false);
      }
    }
  };

  const handleRefreshTorrentFileProgress = async () => {
    if (
      isTorrentFileProgressPending
      || !item.isTorrent
      || !isTorrentFileProgressStatus(item.status)
    ) return;

    const requestId = ++torrentFileProgressRequestRef.current;
    const propertiesDownloadId = item.id;
    setIsTorrentFileProgressPending(true);
    setTorrentFileProgressError(false);
    try {
      const snapshot = await invoke('get_torrent_file_progress', { id: propertiesDownloadId });
      const currentItem = useDownloadStore.getState().downloads.find(download => download.id === propertiesDownloadId);
      if (
        requestId === torrentFileProgressRequestRef.current
        && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
        && currentItem?.isTorrent
        && isTorrentFileProgressStatus(currentItem.status)
      ) {
        setTorrentFileProgress(snapshot);
      }
    } catch {
      if (
        requestId === torrentFileProgressRequestRef.current
        && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
      ) {
        setTorrentFileProgressError(true);
        setTorrentFileProgress(null);
      }
    } finally {
      if (requestId === torrentFileProgressRequestRef.current) {
        setIsTorrentFileProgressPending(false);
      }
    }
  };

  const handleRefreshTorrentPieceProgress = async () => {
    if (
      isTorrentPieceProgressPending
      || !item.isTorrent
      || !isTorrentFileProgressStatus(item.status)
    ) return;

    const requestId = ++torrentPieceProgressRequestRef.current;
    const propertiesDownloadId = item.id;
    setIsTorrentPieceProgressPending(true);
    setTorrentPieceProgressError(false);
    try {
      const snapshot = await invoke('get_torrent_piece_progress', { id: propertiesDownloadId });
      const currentItem = useDownloadStore.getState().downloads.find(download => download.id === propertiesDownloadId);
      if (
        requestId === torrentPieceProgressRequestRef.current
        && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
        && currentItem?.isTorrent
        && isTorrentFileProgressStatus(currentItem.status)
      ) {
        setTorrentPieceProgress(snapshot);
      }
    } catch {
      if (
        requestId === torrentPieceProgressRequestRef.current
        && useDownloadStore.getState().selectedPropertiesDownloadId === propertiesDownloadId
      ) {
        setTorrentPieceProgressError(true);
        setTorrentPieceProgress(null);
      }
    } finally {
      if (requestId === torrentPieceProgressRequestRef.current) {
        setIsTorrentPieceProgressPending(false);
      }
    }
  };

  const handleTorrentWebSeedsSave = async () => {
    if (!item?.isTorrent || isTorrentWebSeedsPending) return;
    const seeds: TorrentWebSeed[] = [];
    for (const line of torrentWebSeedsText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const separator = trimmed.indexOf('|');
      const fileIndex = Number(separator >= 0 ? trimmed.slice(0, separator).trim() : '');
      const uri = separator >= 0 ? trimmed.slice(separator + 1).trim() : '';
      if (!Number.isInteger(fileIndex) || fileIndex < 0 || !uri) {
        setTorrentWebSeedsError(true);
        return;
      }
      seeds.push({ fileIndex, uri });
    }
    setIsTorrentWebSeedsPending(true);
    setTorrentWebSeedsError(false);
    try {
      const normalized = await invoke('set_torrent_web_seeds', { id: item.id, seeds });
      setTorrentWebSeedsText(normalized.map(seed => `${seed.fileIndex}|${seed.uri}`).join('\n'));
      useDownloadStore.getState().updateDownload(item.id, { torrentWebSeeds: normalized });
    } catch {
      setTorrentWebSeedsError(true);
    } finally {
      setIsTorrentWebSeedsPending(false);
    }
  };

  const handleVerifyTorrentData = async () => {
    if (!item?.isTorrent || isTorrentVerifyPending) return;
    const restoreStatus = item.status;
    const previousVerifyOnly = item.torrentVerifyOnly;
    const previousRestoreStatus = item.torrentVerifyRestoreStatus;
    // Mark the maintenance lifecycle before invoking the command so a very
    // fast queued/completed event cannot be mistaken for the normal download
    // lifecycle. The backend persists the same markers before dispatching.
    useDownloadStore.getState().updateDownload(item.id, {
      torrentVerifyOnly: true,
      torrentVerifyRestoreStatus: restoreStatus
    });
    setIsTorrentVerifyPending(true);
    try {
      await invoke('verify_torrent_data', { id: item.id });
    } catch (error) {
      useDownloadStore.getState().updateDownload(item.id, {
        torrentVerifyOnly: previousVerifyOnly,
        torrentVerifyRestoreStatus: previousRestoreStatus
      });
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTorrentVerifyPending(false);
    }
  };

  const handleSave = async () => {
    if (!url.trim()) {
      setErrorMessage(t($ => $.properties.enterValidUrl));
      return;
    }
    if (!fileName.trim()) {
      setErrorMessage(t($ => $.properties.fileNameEmpty));
      return;
    }

    const normalizedMaxPeers = liveTorrentMaxPeersValue.trim()
      ? Number(liveTorrentMaxPeersValue)
      : undefined;
    if (
      item.isTorrent
      && normalizedMaxPeers !== undefined
      && (!Number.isInteger(normalizedMaxPeers) || normalizedMaxPeers < 0 || normalizedMaxPeers > 1000)
    ) {
      setErrorMessage(t($ => $.properties.torrentMaxPeersInvalid));
      return;
    }
    const normalizedPeerSpeedLimit = normalizeSpeedLimitForBackend(liveTorrentPeerSpeedLimitValue);
    if (item.isTorrent && liveTorrentPeerSpeedLimitValue.trim() && !normalizedPeerSpeedLimit) {
      setErrorMessage(t($ => $.properties.torrentPeerSpeedLimitInvalid));
      return;
    }
    if (item.isTorrent && !isValidTorrentTrackerList(torrentTrackers)) {
      setErrorMessage(t($ => $.properties.torrentTrackersInvalid));
      return;
    }
    if (item.isTorrent && !isValidTorrentExcludeTrackerList(torrentExcludeTrackers)) {
      setErrorMessage(t($ => $.properties.torrentExcludeTrackersInvalid));
      return;
    }
    if (item.isTorrent && torrentTrackerConnectTimeout.trim() && !normalizeTorrentTrackerTimeout(torrentTrackerConnectTimeout)) {
      setErrorMessage(t($ => $.properties.torrentTrackerTimeoutInvalid));
      return;
    }
    if (item.isTorrent && torrentTrackerTimeout.trim() && !normalizeTorrentTrackerTimeout(torrentTrackerTimeout)) {
      setErrorMessage(t($ => $.properties.torrentTrackerTimeoutInvalid));
      return;
    }
    if (item.isTorrent && torrentTrackerInterval.trim() && normalizeTorrentTrackerInterval(torrentTrackerInterval) === undefined) {
      setErrorMessage(t($ => $.properties.torrentTrackerIntervalInvalid));
      return;
    }
    if (item.isTorrent && torrentPrioritizePiece.trim() && !normalizeTorrentPrioritizePiece(torrentPrioritizePiece)) {
      setErrorMessage(t($ => $.properties.torrentPrioritizePieceInvalid));
      return;
    }
    const normalizedStopTimeout = torrentStopTimeout.trim()
      ? Number(torrentStopTimeout)
      : undefined;
    if (
      item.isTorrent
      && normalizedStopTimeout !== undefined
      && (!Number.isInteger(normalizedStopTimeout) || normalizedStopTimeout < 0 || normalizedStopTimeout > MAX_TORRENT_STOP_TIMEOUT)
    ) {
      setErrorMessage(t($ => $.properties.torrentStopTimeoutInvalid));
      return;
    }
    if (item.isTorrent && torrentRemoveUnselectedFile && !item.torrentFileIndices?.length) {
      setErrorMessage(t($ => $.properties.torrentRemoveUnselectedFileSelectionRequired));
      return;
    }
    if (item.isTorrent && !normalizeTorrentEncryptionPolicy(torrentEncryptionPolicy)) {
      setErrorMessage(t($ => $.properties.torrentEncryptionPolicyInvalid));
      return;
    }
    const selectedTorrentIndices = torrentFileSelection
      ? torrentFileSelection.files.filter(file => file.selected).map(file => file.index)
      : [];
    const allTorrentFilesSelected = Boolean(
      torrentFileSelection
      && selectedTorrentIndices?.length === torrentFileSelection.files.length
    );
    if (torrentFileSelection && selectedTorrentIndices?.length === 0) {
      setErrorMessage(t($ => $.properties.torrentFileSelectionRequired));
      return;
    }
    if (item.isTorrent && torrentRemoveUnselectedFile && torrentFileSelection && allTorrentFilesSelected) {
      setErrorMessage(t($ => $.properties.torrentRemoveUnselectedFileSelectionRequired));
      return;
    }
    if (
      item.isTorrent
      && torrentRemoveUnselectedFile
      && !item.torrentRemoveUnselectedFile
      && !window.confirm(t($ => $.properties.torrentRemoveUnselectedFileConfirm))
    ) {
      return;
    }

    const updates: Partial<DownloadItem> = {
      url,
      fileName,
      destination: saveLocation,
      speedLimit: speedLimitEnabled && speedLimitValue ? `${speedLimitValue}K` : undefined,
      username: loginMode === 'custom' ? username.trim() : undefined,
      password: loginMode === 'custom' ? password.trim() : undefined,
      headers: headers.trim() || undefined,
      checksum: checksumEnabled && checksumValue.trim() ? `${checksumAlgorithm}=${checksumValue.trim()}` : undefined,
      cookies: cookies.trim() || undefined,
      mirrors: mirrors.trim() || undefined,
      ...(item.isTorrent
        ? {
            torrentMaxPeers: normalizedMaxPeers,
            torrentPeerSpeedLimit: normalizedPeerSpeedLimit || undefined,
            torrentCheckIntegrity,
            torrentTrackers: torrentTrackers.trim() || undefined,
            torrentExcludeTrackers: torrentExcludeTrackers.trim() || undefined,
            torrentTrackerConnectTimeout: torrentTrackerConnectTimeout.trim()
              ? Number(torrentTrackerConnectTimeout)
              : undefined,
            torrentTrackerTimeout: torrentTrackerTimeout.trim()
              ? Number(torrentTrackerTimeout)
              : undefined,
            torrentTrackerInterval: torrentTrackerInterval.trim()
              ? Number(torrentTrackerInterval)
              : undefined,
            torrentStopTimeout: normalizedStopTimeout,
            torrentPrioritizePiece: normalizeTorrentPrioritizePiece(torrentPrioritizePiece) || undefined,
            torrentFileIndices: torrentFileSelection
              ? (allTorrentFilesSelected ? undefined : selectedTorrentIndices)
              : item.torrentFileIndices,
            torrentRemoveUnselectedFile: (torrentFileSelection
              ? !allTorrentFilesSelected
              : item.torrentFileIndices !== undefined)
              ? torrentRemoveUnselectedFile
              : undefined,
            torrentEncryptionPolicy: torrentEncryptionPolicy !== TORRENT_ENCRYPTION_POLICY_DISABLED
              ? torrentEncryptionPolicy
              : undefined,
            torrentFileAllocation,
          }
        : {}),
      ...(connectionsDirty
        ? { connections: resolveDownloadConnections(connections, perServerConnections) }
        : {}),
    };
    
    const requestId = ++actionRequestRef.current;
    try {
      setErrorMessage('');
      await useDownloadStore.getState().applyProperties(item.id, updates);
      if (
        requestId === actionRequestRef.current
        && useDownloadStore.getState().selectedPropertiesDownloadId === item.id
      ) {
        setSelectedPropertiesDownloadId(null);
      }
    } catch (e) {
      if (requestId === actionRequestRef.current && useDownloadStore.getState().selectedPropertiesDownloadId === item.id) {
        setErrorMessage(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const handlePauseResume = async () => {
    const currentItem = useDownloadStore.getState().downloads.find(download => download.id === item.id);
    const action = currentItem ? getPauseResumeAction(currentItem.status) : null;
    if (!currentItem || !action || isPauseResumePending) return;

    if (action === 'pause' && currentItem.resumable === false) {
      const confirmPause = window.confirm(t($ => $.downloadTable.nonResumableOne));
      if (!confirmPause) return;
    }

    setErrorMessage('');
    const requestId = ++actionRequestRef.current;
    setIsPauseResumePending(true);
    try {
      if (action === 'pause') {
        await useDownloadStore.getState().pauseDownload(currentItem.id);
      } else {
        const resumed = await useDownloadStore.getState().resumeDownload(currentItem.id);
        if (!resumed) {
          throw new Error(t($ => $.downloadTable.backendRejectedStart));
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = action === 'pause'
        ? t($ => $.downloadTable.pauseFailed)
        : t($ => $.downloadTable.resumeFailed, { fileName: currentItem.fileName });
      if (requestId === actionRequestRef.current && useDownloadStore.getState().selectedPropertiesDownloadId === item.id) {
        setErrorMessage(t($ => $.downloadTable.interactionError, { message, detail }));
      }
    } finally {
      if (requestId === actionRequestRef.current && useDownloadStore.getState().selectedPropertiesDownloadId === item.id) {
        setIsPauseResumePending(false);
      }
    }
  };

  const handleLiveSpeedLimit = async (limit: string | null) => {
    if (isLiveSpeedLimitPending || item.isMedia || !['downloading', 'retrying'].includes(item.status)) return;

    setErrorMessage('');
    const requestId = ++actionRequestRef.current;
    setIsLiveSpeedLimitPending(true);
    try {
      await useDownloadStore.getState().setDownloadSpeedLimit(item.id, limit);
      if (
        limit === null
        && requestId === actionRequestRef.current
        && useDownloadStore.getState().selectedPropertiesDownloadId === item.id
      ) {
        setLiveSpeedLimitValue('');
      }
    } catch (error) {
      if (requestId === actionRequestRef.current && useDownloadStore.getState().selectedPropertiesDownloadId === item.id) {
        setErrorMessage(t($ => $.properties.liveSpeedLimitFailed, {
          detail: error instanceof Error ? error.message : String(error)
        }));
      }
    } finally {
      if (requestId === actionRequestRef.current && useDownloadStore.getState().selectedPropertiesDownloadId === item.id) {
        setIsLiveSpeedLimitPending(false);
      }
    }
  };

  const handleLiveTorrentUploadLimit = async (limit: string | null) => {
    if (
      isLiveTorrentUploadLimitPending
      || !item.isTorrent
      || !['downloading', 'seeding', 'retrying'].includes(item.status)
    ) return;

    setErrorMessage('');
    const requestId = ++actionRequestRef.current;
    setIsLiveTorrentUploadLimitPending(true);
    try {
      await useDownloadStore.getState().setTorrentUploadLimit(item.id, limit);
      if (
        limit === null
        && requestId === actionRequestRef.current
        && useDownloadStore.getState().selectedPropertiesDownloadId === item.id
      ) {
        setLiveTorrentUploadLimitValue('');
      }
    } catch (error) {
      if (requestId === actionRequestRef.current && useDownloadStore.getState().selectedPropertiesDownloadId === item.id) {
        setErrorMessage(t($ => $.properties.liveTorrentUploadLimitFailed, {
          detail: error instanceof Error ? error.message : String(error)
        }));
      }
    } finally {
      if (requestId === actionRequestRef.current && useDownloadStore.getState().selectedPropertiesDownloadId === item.id) {
        setIsLiveTorrentUploadLimitPending(false);
      }
    }
  };

  const handleLiveTorrentPeerOptions = async () => {
    if (
      isLiveTorrentPeerOptionsPending
      || !item.isTorrent
      || !['downloading', 'seeding', 'retrying'].includes(item.status)
    ) return;

    setErrorMessage('');
    const requestId = ++actionRequestRef.current;
    setIsLiveTorrentPeerOptionsPending(true);
    try {
      await useDownloadStore.getState().setTorrentPeerOptions(
        item.id,
        liveTorrentMaxPeersValue,
        liveTorrentPeerSpeedLimitValue
      );
    } catch (error) {
      if (requestId === actionRequestRef.current && useDownloadStore.getState().selectedPropertiesDownloadId === item.id) {
        setErrorMessage(t($ => $.properties.liveTorrentPeerOptionsFailed, {
          detail: error instanceof Error ? error.message : String(error)
        }));
      }
    } finally {
      if (requestId === actionRequestRef.current && useDownloadStore.getState().selectedPropertiesDownloadId === item.id) {
        setIsLiveTorrentPeerOptionsPending(false);
      }
    }
  };

  const identityLocked = getIdentityLocked(item.status);
  const transferLocked = getTransferLocked(item.status);
  const liveSpeedLimitAvailable = !item.isMedia && ['downloading', 'retrying'].includes(item.status);
  const liveSpeedLimitUnavailable = item.isMedia && ['downloading', 'processing', 'retrying'].includes(item.status);
  const liveTorrentUploadLimitAvailable = item.isTorrent && ['downloading', 'seeding', 'retrying'].includes(item.status);
  const liveTorrentPeerOptionsAvailable = item.isTorrent && ['downloading', 'seeding', 'retrying'].includes(item.status);
  const torrentPeerDiagnosticsAvailable = item.isTorrent && isPeerDiagnosticsStatus(item.status);
  const torrentFileSelectionIsEmpty = item.isTorrent
    && torrentFileSelection !== null
    && !torrentFileSelection.files.some(file => file.selected);
  const configuredConnections = resolveDownloadConnections(item.connections, perServerConnections);
  const observedConnectionTotal = Math.max(
    1,
    liveProgress?.requested_connections ?? configuredConnections
  );
  const observedActiveConnections = liveProgress?.active_connections;
  const connectionTelemetryActive = item.status === 'downloading' ||
    item.status === 'processing' ||
    item.status === 'seeding' ||
    item.status === 'retrying';
  const connectionStatus = (() => {
    if (!connectionTelemetryActive) return String(configuredConnections);
    // yt-dlp exposes the configured fragment limit through Firelink, but its
    // progress stream does not expose a reliable active-worker count. Keep
    // the selected limit visible without presenting it as an active count.
    if (item.isMedia) {
      return t($ => $.properties.connectionCountUnknown, {
        total: configuredConnections,
      });
    }
    if (typeof observedActiveConnections === 'number') {
      return t($ => $.properties.connectionCount, {
        active: observedActiveConnections,
        total: observedConnectionTotal,
      });
    }
    if (item.status === 'downloading') {
      return t($ => $.properties.connectionCountUnknown, { total: observedConnectionTotal });
    }
    return t($ => $.properties.connectionCount, {
      active: 0,
      total: observedConnectionTotal,
    });
  })();
  const displayedFraction = item.status === 'completed'
    ? 1
    : liveProgress?.fraction ?? item.fraction ?? 0;
  const displayedSpeed = item.status === 'completed'
    ? '-'
    : item.status === 'seeding'
      ? liveProgress?.upload_speed ?? '-'
    : liveProgress?.speed ?? item.speed ?? '-';
  const displayedEta = item.status === 'completed'
    ? '-'
    : item.status === 'seeding'
      ? '-'
    : liveProgress?.eta ?? item.eta ?? '-';
  const sizeDisplay = resolveDownloadSizeDisplay({
    downloadedBytes: liveProgress?.downloaded_bytes ?? item.downloadedBytes,
    totalBytes: liveProgress?.total_bytes ?? item.totalBytes,
    totalIsEstimate: liveProgress?.total_is_estimate ?? item.totalIsEstimate,
    fallbackSize: item.size
  });
  const hasDownloadedAmount = item.status !== 'completed' &&
    Boolean(sizeDisplay.downloaded && sizeDisplay.total);
  const completedSizeLabel = (() => {
    const value = item.status === 'completed' ? formatDownloadTotal(sizeDisplay) : sizeDisplay.fallback;
    return value === 'Unknown' ? t($ => $.addDownloads.unknown) : value;
  })();
  const statusLabel = t($ => $.downloads.status[item.status]);
  const pauseResumeAction = getPauseResumeAction(item.status);
  const pauseResumeLabel = pauseResumeAction === 'pause'
    ? t($ => $.downloadTable.pause)
    : t($ => $.downloadTable.resume);
  const PauseResumeIcon = pauseResumeAction === 'pause' ? Pause : Play;
  const sizeDescription = sizeDisplay.totalIsEstimate
    ? t($ => $.downloads.size.downloadedOfApproximate, {
      downloaded: sizeDisplay.downloaded ?? '',
      total: sizeDisplay.total ?? '',
      unit: sizeDisplay.unit ?? '',
    })
    : t($ => $.downloads.size.downloadedOf, {
      downloaded: sizeDisplay.downloaded ?? '',
      total: sizeDisplay.total ?? '',
      unit: sizeDisplay.unit ?? '',
    });

  let statusColor = 'text-text-secondary';
  let StatusIcon = Info;
  if (item.status === 'completed') { statusColor = 'text-green-500'; StatusIcon = CheckCircle; }
  else if (item.status === 'downloading' || item.status === 'verifying' || item.status === 'seeding' || item.status === 'retrying') { statusColor = 'text-blue-500'; StatusIcon = Play; }
  else if (item.status === 'processing') { statusColor = 'text-sky-500'; StatusIcon = Play; }
  else if (item.status === 'paused') { statusColor = 'text-orange-500'; StatusIcon = Pause; }
  else if (item.status === 'failed') { statusColor = 'text-red-500'; StatusIcon = AlertCircle; }

  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) setSelectedPropertiesDownloadId(null);
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="properties-modal-title"
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        data-modal-surface="true"
        className="app-modal properties-modal w-[720px] h-[580px] flex flex-col overflow-hidden text-sm"
      >
        
        {/* Header Summary */}
        <div className="p-4 px-5 bg-sidebar-bg/50">
          <div className="flex items-center justify-between mb-3">
            <h2 id="properties-modal-title" className="text-base font-semibold truncate text-text-primary pr-4">{item.fileName}</h2>
            <span className={`flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase ${statusColor}`}>
              <StatusIcon size={14} />
              {statusLabel}
            </span>
          </div>
          
          <div className="w-full bg-border-color rounded-full h-1.5 overflow-hidden mb-4">
            <div className={`h-1.5 rounded-full transition-all duration-300 ${item.status === 'completed' ? 'bg-green-500' : item.status === 'paused' ? 'bg-orange-500' : item.status === 'failed' ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${displayedFraction * 100}%` }}></div>
          </div>
          
            <div className="grid grid-cols-4 gap-y-2 gap-x-4 text-[11px] leading-tight">
              <div className="flex gap-1.5 min-w-0"><span className="text-text-muted font-medium w-[90px] shrink-0">{t($ => $.properties.progress)}</span><span className="text-text-secondary truncate">{`${(displayedFraction * 100).toFixed(0)}%`}</span></div>
              <div className="flex gap-1.5 min-w-0">
                <span className="text-text-muted font-medium w-[40px] shrink-0">{t($ => $.properties.size)}</span>
                <span
                  className="truncate"
                  title={hasDownloadedAmount
                    ? sizeDescription
                    : completedSizeLabel}
                >
                  {hasDownloadedAmount ? (
                    <>
                      <span className={downloadProgressColorClass(item.status)}>{sizeDisplay.downloaded}</span>
                      <span className="text-text-muted"> / </span>
                      <span className="text-text-secondary">
                        {sizeDisplay.totalIsEstimate ? '~' : ''}{sizeDisplay.total} {sizeDisplay.unit}
                      </span>
                    </>
                  ) : completedSizeLabel}
                </span>
              </div>
              <div className="flex gap-1.5 min-w-0"><span className="text-text-muted font-medium w-[40px] shrink-0">{t($ => $.properties.speed)}</span><span className="text-text-secondary truncate">{displayedSpeed}</span></div>
              <div className="flex gap-1.5 min-w-0"><span className="text-text-muted font-medium w-[30px] shrink-0">{t($ => $.properties.eta)}</span><span className="text-text-secondary truncate">{displayedEta}</span></div>

              <div className="flex gap-1.5 min-w-0"><span className="text-text-muted font-medium shrink-0 whitespace-nowrap">{t($ => $.properties.connections)}</span><span className="text-text-secondary truncate whitespace-nowrap" title={item.connections !== undefined ? t($ => $.properties.savedTooltip) : t($ => $.properties.defaultTooltip)}><bdi>{connectionStatus}</bdi></span></div>
              <div className="flex gap-1.5 min-w-0"><span className="text-text-muted font-medium w-[60px] shrink-0">{t($ => $.properties.speedCap)}</span><span className="text-text-secondary truncate">{item.speedLimit || '-'}</span></div>
              <div className="flex gap-1.5 min-w-0"><span className="text-text-muted font-medium w-[55px] shrink-0">{t($ => $.properties.category)}</span><span className="text-text-secondary truncate">{categoryLabel(item.category)}</span></div>
            <div className="flex gap-1.5"><span className="text-text-muted font-medium w-[50px]">{t($ => $.properties.lastTry)}</span><span className="text-text-secondary truncate">{formatLastTry(item.lastTry, i18n.language, calendarPreference)}</span></div>
            
              <div className="flex gap-1.5 col-span-2"><span className="text-text-muted font-medium w-[90px]">{t($ => $.properties.dateAdded)}</span><span className="text-text-secondary truncate">{formatDateTime(item.dateAdded, { locale: i18n.language, calendar: calendarPreference, options: { dateStyle: 'medium', timeStyle: 'short' } })}</span></div>
              <div className="flex gap-1.5 col-span-2"><span className="text-text-muted font-medium w-[70px]">{t($ => $.properties.destination)}</span><span className="text-text-secondary truncate" title={saveLocation}>{saveLocation || baseDownloadFolder}</span></div>
            {item.lastError && (item.status === 'failed' || item.status === 'retrying') && (
              <div className="flex gap-1.5 col-span-4 min-w-0">
                <span className="text-text-muted font-medium w-[90px] shrink-0">{t($ => $.properties.lastError)}</span>
                <span className="text-red-400 truncate" title={item.lastError}>{item.lastError}</span>
              </div>
            )}
          </div>
        </div>

        <div className="h-[1px] bg-border-modal w-full shrink-0"></div>

        {/* Scrollable Form Content */}
        <div className="flex-1 overflow-y-auto bg-main-bg/30 p-5 space-y-7">
          
          {identityLocked && (
            <div className="flex gap-2.5 items-center text-xs text-text-secondary bg-border-color/30 p-3 rounded-md border border-border-modal">
              {item.status === 'completed' ? <CheckCircle size={16} className="text-green-500" /> : <AlertCircle size={16} className="text-blue-500" />}
              <span>
                {item.status === 'completed' 
                  ? t($ => $.properties.identityReadOnly)
                  : t($ => $.properties.transferSettings)}
              </span>
            </div>
          )}

          {/* Download Section */}
          <section>
            <h3 className="text-sm font-semibold text-text-primary mb-4 pb-1 border-b border-border-modal/50">{t($ => $.properties.download)}</h3>
            <div className="grid grid-cols-[100px_1fr] gap-y-3.5 gap-x-4 items-center">
              <label className="text-xs text-text-muted text-right">{t($ => $.properties.url)}</label>
              <input type="text" value={url} onChange={e => setUrl(e.target.value)} disabled={identityLocked} className="bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-accent disabled:opacity-50" />
              
              <label className="text-xs text-text-muted text-right">{t($ => $.properties.fileName)}</label>
              <input type="text" value={fileName} onChange={e => setFileName(e.target.value)} disabled={identityLocked} className="bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-50" />
              
              <label className="text-xs text-text-muted text-right">{t($ => $.properties.saveLocation)}</label>
              <div className="flex gap-2">
                <input type="text" value={saveLocation} readOnly disabled={identityLocked} className="flex-1 bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-accent disabled:opacity-50" />
                <button onClick={handleBrowse} disabled={identityLocked} className="bg-item-hover hover:bg-item-hover/80 text-text-primary border border-border-modal px-3 py-1.5 rounded text-xs transition-colors disabled:opacity-40 flex items-center gap-1.5">
                  <FolderPlus size={14} /> {t($ => $.properties.select)}
                </button>
              </div>
              
              <label className="text-xs text-text-muted text-right">{t($ => $.properties.connections)}</label>
              <div className="flex items-center gap-2">
                <input type="number" value={connections} min={1} max={16} onChange={e=>{ setConnections(Number(e.target.value)); setConnectionsDirty(true); }} disabled={transferLocked} className="w-16 bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-50" />
                <span className="text-xs text-text-muted">{t($ => $.properties.perFile)}</span>
                <span className="text-xs text-text-secondary font-mono" aria-live="polite"><bdi>{connectionStatus}</bdi></span>
                {!transferLocked && item.connections !== undefined && item.connections !== perServerConnections && (
                  <button
                    type="button"
                    onClick={() => { setConnections(perServerConnections); setConnectionsDirty(true); }}
                    className="text-[11px] text-accent hover:underline whitespace-nowrap"
                  >
                    {t($ => $.properties.useCurrentDefault, { count: perServerConnections })}
                  </button>
                )}
              </div>
              <div className="col-start-2 text-[11px] text-text-muted">
                {t($ => $.properties.savedPerDownload)}
              </div>
              
              <label className="text-xs text-text-muted text-right">{t($ => $.properties.speedCap)}</label>
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex min-h-7 items-center gap-2 rounded-md border border-border-modal bg-bg-input px-2.5 py-1.5 text-xs text-text-primary">
                  <input
                    type="checkbox"
                    checked={speedLimitEnabled}
                    onChange={e => setSpeedLimitEnabled(e.target.checked)}
                    disabled={transferLocked}
                    className="accent-accent disabled:opacity-50"
                  />
                  {t($ => $.properties.limit)}
                </label>
                {speedLimitEnabled && (
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={speedLimitValue}
                      min={1}
                      step={128}
                      onChange={e => setSpeedLimitValue(e.target.value)}
                      disabled={transferLocked}
                      className="app-control w-24 px-2.5 py-1.5 text-end text-xs font-mono disabled:opacity-50"
                    />
                    <span className="text-xs text-text-muted">KiB/s</span>
                  </div>
                )}
              </div>
              <div className="col-start-2 text-[11px] text-text-muted">
                {t($ => $.properties.savedPerDownload)}
              </div>
              {item.isTorrent && (
                <>
                  <label className="text-xs text-text-muted text-right">{t($ => $.properties.torrentMaxPeers)}</label>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    step={1}
                    value={liveTorrentMaxPeersValue}
                    onChange={event => setLiveTorrentMaxPeersValue(event.currentTarget.value)}
                    placeholder="55"
                    disabled={transferLocked}
                    className="app-control w-24 px-2.5 py-1.5 text-end text-xs font-mono disabled:opacity-50"
                  />
                  <label className="text-xs text-text-muted text-right">{t($ => $.properties.torrentPeerSpeedLimit)}</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={liveTorrentPeerSpeedLimitValue}
                    onChange={event => setLiveTorrentPeerSpeedLimitValue(event.currentTarget.value)}
                    placeholder="50K"
                    disabled={transferLocked}
                    className="app-control w-24 px-2.5 py-1.5 text-end text-xs font-mono disabled:opacity-50"
                  />
                  <div className="col-start-2 text-[11px] text-text-muted">
                    {t($ => $.properties.torrentPeerOptionsSavedHint)}
                  </div>
                  {torrentFileSelection && (
                    <div className="col-start-2 rounded-lg border border-border-modal bg-bg-input/30 p-3 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-text-primary">
                          {t($ => $.properties.torrentFileSelection)}
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="app-button px-2.5 text-[11px] disabled:opacity-50"
                            disabled={transferLocked || torrentFileSelection.files.length === 0}
                            onClick={() => setTorrentFileSelection(current => current
                              ? { ...current, files: current.files.map(file => ({ ...file, selected: true })) }
                              : current)}
                          >
                            {t($ => $.properties.torrentFileSelectionAll)}
                          </button>
                          <button
                            type="button"
                            className="app-button px-2.5 text-[11px] disabled:opacity-50"
                            disabled={transferLocked || torrentFileSelection.files.length === 0}
                            onClick={() => setTorrentFileSelection(current => current
                              ? { ...current, files: current.files.map(file => ({ ...file, selected: false })) }
                              : current)}
                          >
                            {t($ => $.properties.torrentFileSelectionClear)}
                          </button>
                        </div>
                      </div>
                      <p className="text-[11px] text-text-muted">
                        {t($ => $.properties.torrentFileSelectionHint)}
                      </p>
                      <div className="max-h-48 overflow-auto rounded border border-border-modal/60">
                        {torrentFileSelection.files.map(file => (
                          <label key={file.index} className="flex items-center gap-2 border-b border-border-modal/40 px-2 py-1.5 text-[11px] last:border-b-0">
                            <input
                              type="checkbox"
                              checked={file.selected}
                              disabled={transferLocked}
                              onChange={event => setTorrentFileSelection(current => current
                                ? {
                                    ...current,
                                    files: current.files.map(candidate => candidate.index === file.index
                                      ? { ...candidate, selected: event.currentTarget.checked }
                                      : candidate)
                                  }
                                : current)}
                              className="accent-accent disabled:opacity-50"
                            />
                            <span className="font-mono text-text-muted">{file.index}</span>
                            <span className="min-w-0 flex-1 truncate" dir="auto" title={file.relativePath}>{file.relativePath}</span>
                            <span className="text-end text-text-muted whitespace-nowrap">
                              {(() => {
                                const progress = torrentFileProgressByIndex.get(file.index);
                                const completedLength = progress?.completedLength ?? file.completedLength ?? 0;
                                const percentage = file.length === 0
                                  ? 100
                                  : Math.round((completedLength / file.length) * 100);
                                return `${formatDownloadBytes(completedLength)} / ${formatDownloadBytes(file.length)} (${percentage}%)`;
                              })()}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="col-start-2 rounded-lg border border-border-modal bg-bg-input/30 p-3 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-text-primary">
                        {t($ => $.properties.torrentPieceProgress)}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleRefreshTorrentPieceProgress()}
                        disabled={!isTorrentFileProgressStatus(item.status) || isTorrentPieceProgressPending}
                        className="app-button px-3 text-xs disabled:opacity-50"
                      >
                        {isTorrentPieceProgressPending
                          ? t($ => $.properties.torrentPieceProgressLoading)
                          : t($ => $.properties.torrentPieceProgressRefresh)}
                      </button>
                    </div>
                    <p className="text-[11px] text-text-muted">
                      {t($ => $.properties.torrentPieceProgressHint)}
                    </p>
                    {!isTorrentFileProgressStatus(item.status) && (
                      <p className="text-[11px] text-text-muted">
                        {t($ => $.properties.torrentPieceProgressUnavailable)}
                      </p>
                    )}
                    {torrentPieceProgressError && (
                      <p className="text-[11px] text-red-400">
                        {t($ => $.properties.torrentPieceProgressFailed)}
                      </p>
                    )}
                    {torrentPieceProgress && (
                      <>
                        <div className="text-[11px] text-text-secondary">
                          {t($ => $.properties.torrentPieceProgressSummary, {
                            completed: torrentPieceProgress.completedPieces,
                            total: torrentPieceProgress.numPieces,
                            size: formatDownloadBytes(torrentPieceProgress.pieceLength),
                          })}
                        </div>
                        <div
                          className="grid gap-0.5 rounded border border-border-modal/60 bg-bg-input p-1"
                          style={{ gridTemplateColumns: `repeat(${Math.min(16, Math.max(1, torrentPieceProgress.buckets.length))}, minmax(0, 1fr))` }}
                          role="img"
                          aria-label={t($ => $.properties.torrentPieceProgressMap)}
                        >
                          {torrentPieceProgress.buckets.map((percentage, index) => (
                            <span
                              key={index}
                              className="aspect-square min-w-1 rounded-sm bg-blue-500 motion-safe:transition-opacity motion-reduce:transition-none"
                              style={{ opacity: Math.max(0.15, percentage / 100) }}
                              title={`${percentage}%`}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="col-start-2 rounded-lg border border-border-modal bg-bg-input/30 p-3 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-text-primary">
                        {t($ => $.properties.torrentFileProgress)}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleRefreshTorrentFileProgress()}
                        disabled={!isTorrentFileProgressStatus(item.status) || isTorrentFileProgressPending}
                        className="app-button px-3 text-xs disabled:opacity-50"
                      >
                        {isTorrentFileProgressPending
                          ? t($ => $.properties.torrentFileProgressLoading)
                          : t($ => $.properties.torrentFileProgressRefresh)}
                      </button>
                    </div>
                    <p className="text-[11px] text-text-muted">
                      {t($ => $.properties.torrentFileProgressHint)}
                    </p>
                    {!isTorrentFileProgressStatus(item.status) && (
                      <p className="text-[11px] text-text-muted">
                        {t($ => $.properties.torrentFileProgressUnavailable)}
                      </p>
                    )}
                    {torrentFileProgressError && (
                      <p className="text-[11px] text-red-400">
                        {t($ => $.properties.torrentFileProgressFailed)}
                      </p>
                    )}
                    {torrentFileProgress && (
                      <div className="max-h-48 overflow-auto rounded border border-border-modal/60">
                        <table className="w-full text-[10px]">
                          <thead className="sticky top-0 bg-bg-input text-text-muted">
                            <tr>
                              <th className="px-2 py-1 text-start">#</th>
                              <th className="px-2 py-1 text-start">{t($ => $.properties.torrentFileProgressPath)}</th>
                              <th className="px-2 py-1 text-start">{t($ => $.properties.torrentFileProgressCompleted)}</th>
                              <th className="px-2 py-1 text-start">{t($ => $.properties.torrentFileProgressSelected)}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {torrentFileProgress.files.map(file => {
                              const percentage = file.length === 0
                                ? 100
                                : Math.round((file.completedLength / file.length) * 100);
                              return (
                                <tr key={file.index} className="border-t border-border-modal/40 text-text-primary">
                                  <td className="px-2 py-1 font-mono">{file.index}</td>
                                  <td className="px-2 py-1 max-w-[220px] truncate" title={file.relativePath} dir="auto">{file.relativePath}</td>
                                  <td className="px-2 py-1 font-mono whitespace-nowrap">
                                    {formatDownloadBytes(file.completedLength)} / {formatDownloadBytes(file.length)} ({percentage}%)
                                  </td>
                                  <td className="px-2 py-1">
                                    {file.selected
                                      ? t($ => $.properties.torrentFileProgressSelected)
                                      : t($ => $.properties.torrentFileProgressUnselected)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  <div className="col-start-2 rounded-lg border border-border-modal bg-bg-input/30 p-3 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-text-primary">
                        {t($ => $.properties.torrentPeerDiagnostics)}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleRefreshTorrentPeers()}
                        disabled={!torrentPeerDiagnosticsAvailable || isTorrentPeerDiagnosticsPending}
                        className="app-button px-3 text-xs disabled:opacity-50"
                      >
                        {isTorrentPeerDiagnosticsPending
                          ? t($ => $.properties.torrentPeerDiagnosticsLoading)
                          : t($ => $.properties.torrentPeerDiagnosticsRefresh)}
                      </button>
                    </div>
                    <p className="text-[11px] text-text-muted">
                      {t($ => $.properties.torrentPeerDiagnosticsHint)}
                    </p>
                    {!torrentPeerDiagnosticsAvailable && (
                      <p className="text-[11px] text-text-muted">
                        {t($ => $.properties.torrentPeerDiagnosticsUnavailable)}
                      </p>
                    )}
                    {torrentPeerDiagnosticsError && (
                      <p className="text-[11px] text-red-400">
                        {t($ => $.properties.torrentPeerDiagnosticsFailed)}
                      </p>
                    )}
                    {torrentPeerDiagnostics && (
                      <>
                        <div className="text-[11px] font-medium text-text-primary">
                          {t($ => $.properties.torrentPeerCount, {
                            total: torrentPeerDiagnostics.totalPeers,
                            seeders: torrentPeerDiagnostics.totalSeeders
                          })}
                        </div>
                        <div className="max-h-48 overflow-auto rounded border border-border-modal/60">
                          <table className="w-full text-[10px]">
                            <thead className="sticky top-0 bg-bg-input text-text-muted">
                              <tr>
                                <th className="px-2 py-1 text-start">#</th>
                                <th className="px-2 py-1 text-start">{t($ => $.properties.torrentPeerDownload)}</th>
                                <th className="px-2 py-1 text-start">{t($ => $.properties.torrentPeerUpload)}</th>
                                <th className="px-2 py-1 text-start">{t($ => $.properties.torrentPeerSeeder)}</th>
                                <th className="px-2 py-1 text-start">{t($ => $.properties.torrentPeerAmChoking)}</th>
                                <th className="px-2 py-1 text-start">{t($ => $.properties.torrentPeerChoking)}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {torrentPeerDiagnostics.peers.map((peer, index) => (
                                <tr key={`${index}-${peer.downloadSpeed}-${peer.uploadSpeed}`} className="border-t border-border-modal/40 text-text-primary">
                                  <td className="px-2 py-1 font-mono">{index + 1}</td>
                                  <td className="px-2 py-1 font-mono">{formatPeerSpeed(peer.downloadSpeed)}</td>
                                  <td className="px-2 py-1 font-mono">{formatPeerSpeed(peer.uploadSpeed)}</td>
                                  <td className="px-2 py-1">{peer.seeder ? '✓' : '—'}</td>
                                  <td className="px-2 py-1">{peer.amChoking ? '✓' : '—'}</td>
                                  <td className="px-2 py-1">{peer.peerChoking ? '✓' : '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {torrentPeerDiagnostics.truncated && (
                          <p className="text-[11px] text-text-muted">
                            {t($ => $.properties.torrentPeerShowing, {
                              shown: torrentPeerDiagnostics.peers.length,
                              total: torrentPeerDiagnostics.totalPeers
                            })}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  <label className="text-xs text-text-muted text-right" htmlFor="torrent-trackers-properties">
                    {t($ => $.properties.torrentTrackers)}
                  </label>
                  <div>
                    <textarea
                      id="torrent-trackers-properties"
                      rows={3}
                      value={torrentTrackers}
                      onChange={event => setTorrentTrackers(event.currentTarget.value)}
                      placeholder="https://tracker.example/announce"
                      disabled={transferLocked}
                      aria-describedby="torrent-trackers-properties-hint"
                      className="app-control min-h-20 w-full resize-y px-2.5 py-1.5 text-xs font-mono disabled:opacity-50"
                    />
                    <p id="torrent-trackers-properties-hint" className="mt-1 text-[11px] text-text-muted">
                      {t($ => $.properties.torrentTrackersHint)}
                    </p>
                  </div>
                  <label className="text-xs text-text-muted text-right" htmlFor="torrent-exclude-trackers-properties">
                    {t($ => $.properties.torrentExcludeTrackers)}
                  </label>
                  <div>
                    <textarea
                      id="torrent-exclude-trackers-properties"
                      rows={3}
                      value={torrentExcludeTrackers}
                      onChange={event => setTorrentExcludeTrackers(event.currentTarget.value)}
                      placeholder="https://tracker.example/announce or *"
                      disabled={transferLocked}
                      aria-describedby="torrent-exclude-trackers-properties-hint"
                      className="app-control min-h-20 w-full resize-y px-2.5 py-1.5 text-xs font-mono disabled:opacity-50"
                    />
                    <p id="torrent-exclude-trackers-properties-hint" className="mt-1 text-[11px] text-text-muted">
                      {t($ => $.properties.torrentExcludeTrackersHint)}
                    </p>
                  </div>
                  <label className="text-xs text-text-muted text-right" htmlFor="torrent-tracker-connect-timeout-properties">
                    {t($ => $.properties.torrentTrackerConnectTimeout)}
                  </label>
                  <div>
                    <div className="flex items-center gap-2">
                      <input
                        id="torrent-tracker-connect-timeout-properties"
                        type="number"
                        min={1}
                        max={MAX_TORRENT_TRACKER_TIMEOUT}
                        step={1}
                        value={torrentTrackerConnectTimeout}
                        onChange={event => setTorrentTrackerConnectTimeout(event.currentTarget.value)}
                        placeholder="60"
                        disabled={transferLocked}
                        aria-describedby="torrent-tracker-timing-properties-hint"
                        className="app-control w-24 px-2.5 py-1.5 text-end text-xs font-mono disabled:opacity-50"
                      />
                      <span className="text-[11px] text-text-muted">{t($ => $.properties.seconds)}</span>
                    </div>
                  </div>
                  <label className="text-xs text-text-muted text-right" htmlFor="torrent-tracker-timeout-properties">
                    {t($ => $.properties.torrentTrackerTimeout)}
                  </label>
                  <div>
                    <div className="flex items-center gap-2">
                      <input
                        id="torrent-tracker-timeout-properties"
                        type="number"
                        min={1}
                        max={MAX_TORRENT_TRACKER_TIMEOUT}
                        step={1}
                        value={torrentTrackerTimeout}
                        onChange={event => setTorrentTrackerTimeout(event.currentTarget.value)}
                        placeholder="60"
                        disabled={transferLocked}
                        aria-describedby="torrent-tracker-timing-properties-hint"
                        className="app-control w-24 px-2.5 py-1.5 text-end text-xs font-mono disabled:opacity-50"
                      />
                      <span className="text-[11px] text-text-muted">{t($ => $.properties.seconds)}</span>
                    </div>
                  </div>
                  <label className="text-xs text-text-muted text-right" htmlFor="torrent-tracker-interval-properties">
                    {t($ => $.properties.torrentTrackerInterval)}
                  </label>
                  <div>
                    <div className="flex items-center gap-2">
                      <input
                        id="torrent-tracker-interval-properties"
                        type="number"
                        min={0}
                        max={MAX_TORRENT_TRACKER_INTERVAL}
                        step={1}
                        value={torrentTrackerInterval}
                        onChange={event => setTorrentTrackerInterval(event.currentTarget.value)}
                        disabled={transferLocked}
                        aria-describedby="torrent-tracker-timing-properties-hint"
                        className="app-control w-24 px-2.5 py-1.5 text-end text-xs font-mono disabled:opacity-50"
                      />
                      <span className="text-[11px] text-text-muted">{t($ => $.properties.seconds)}</span>
                    </div>
                    <p id="torrent-tracker-timing-properties-hint" className="mt-1 text-[11px] text-text-muted">
                      {t($ => $.properties.torrentTrackerTimingHint)}
                    </p>
                  </div>
                  <label className="text-xs text-text-muted text-right" htmlFor="torrent-stop-timeout-properties">
                    {t($ => $.properties.torrentStopTimeout)}
                  </label>
                  <div>
                    <div className="flex items-center gap-2">
                      <input
                        id="torrent-stop-timeout-properties"
                        type="number"
                        min={0}
                        max={MAX_TORRENT_STOP_TIMEOUT}
                        step={1}
                        value={torrentStopTimeout}
                        onChange={event => setTorrentStopTimeout(event.currentTarget.value)}
                        disabled={transferLocked}
                        aria-describedby="torrent-stop-timeout-properties-hint"
                        className="app-control w-24 px-2.5 py-1.5 text-end text-xs font-mono disabled:opacity-50"
                      />
                      <span className="text-[11px] text-text-muted">{t($ => $.properties.seconds)}</span>
                    </div>
                    <p id="torrent-stop-timeout-properties-hint" className="mt-1 text-[11px] text-text-muted">
                      {t($ => $.properties.torrentStopTimeoutHint)}
                    </p>
                  </div>
                  <label className="text-xs text-text-muted text-right" htmlFor="torrent-prioritize-piece-properties">
                    {t($ => $.properties.torrentPrioritizePiece)}
                  </label>
                  <div>
                    <input
                      id="torrent-prioritize-piece-properties"
                      type="text"
                      value={torrentPrioritizePiece}
                      onChange={event => setTorrentPrioritizePiece(event.currentTarget.value)}
                      placeholder="head=1M,tail=1M"
                      disabled={transferLocked}
                      aria-describedby="torrent-prioritize-piece-properties-hint"
                      className="app-control w-full px-2.5 py-1.5 text-xs font-mono disabled:opacity-50"
                    />
                    <p id="torrent-prioritize-piece-properties-hint" className="mt-1 text-[11px] text-text-muted">
                      {t($ => $.properties.torrentPrioritizePieceHint)}
                    </p>
                  </div>
                  <label className="text-xs text-text-muted text-right" htmlFor="torrent-file-allocation-properties">
                    {t($ => $.properties.torrentFileAllocation)}
                  </label>
                  <div>
                    <select
                      id="torrent-file-allocation-properties"
                      value={torrentFileAllocation}
                      onChange={event => setTorrentFileAllocation(event.currentTarget.value as TorrentFileAllocation)}
                      disabled={transferLocked}
                      aria-describedby="torrent-file-allocation-properties-hint"
                      className="app-control max-w-56 px-2.5 py-1.5 text-xs disabled:opacity-50"
                    >
                      <option value="prealloc">{t($ => $.properties.torrentFileAllocationPrealloc)}</option>
                      <option value="none">{t($ => $.properties.torrentFileAllocationNone)}</option>
                    </select>
                    <p id="torrent-file-allocation-properties-hint" className="mt-1 text-[11px] text-text-muted">
                      {t($ => $.properties.torrentFileAllocationHint)}
                    </p>
                  </div>
                  <label className="text-xs text-text-muted text-right" htmlFor="torrent-encryption-policy-properties">
                    {t($ => $.properties.torrentEncryptionPolicy)}
                  </label>
                  <div>
                    <select
                      id="torrent-encryption-policy-properties"
                      value={torrentEncryptionPolicy}
                      onChange={event => setTorrentEncryptionPolicy(event.currentTarget.value as TorrentEncryptionPolicy)}
                      disabled={transferLocked}
                      aria-describedby="torrent-encryption-policy-properties-hint"
                      className="app-control max-w-56 px-2.5 py-1.5 text-xs disabled:opacity-50"
                    >
                      <option value={TORRENT_ENCRYPTION_POLICY_DISABLED}>
                        {t($ => $.properties.torrentEncryptionDisabled)}
                      </option>
                      <option value={TORRENT_ENCRYPTION_POLICY_REQUIRE_CRYPTO}>
                        {t($ => $.properties.torrentEncryptionRequireCrypto)}
                      </option>
                      <option value={TORRENT_ENCRYPTION_POLICY_FORCE_ENCRYPTION}>
                        {t($ => $.properties.torrentEncryptionForceEncryption)}
                      </option>
                    </select>
                    <p id="torrent-encryption-policy-properties-hint" className="mt-1 text-[11px] text-text-muted">
                      {t($ => $.properties.torrentEncryptionPolicyHint)}
                    </p>
                  </div>
                  <label className="text-xs text-text-muted text-right" htmlFor="torrent-check-integrity">
                    {t($ => $.properties.torrentVerifyIntegrity)}
                  </label>
                  <label className="flex items-start gap-2 text-xs text-text-primary">
                    <input
                      id="torrent-check-integrity"
                      type="checkbox"
                      checked={torrentCheckIntegrity}
                      onChange={event => setTorrentCheckIntegrity(event.currentTarget.checked)}
                      disabled={transferLocked}
                      className="accent-accent mt-0.5 disabled:opacity-50"
                      aria-describedby="torrent-check-integrity-hint"
                    />
                    <span id="torrent-check-integrity-hint" className="text-[11px] text-text-muted">
                      {t($ => $.properties.torrentVerifyIntegrityHint)}
                    </span>
                  </label>
                  <div className="col-start-2">
                    <button
                      type="button"
                      onClick={() => void handleVerifyTorrentData()}
                      disabled={isTorrentVerifyPending || getTransferLocked(item.status) || !['completed', 'paused', 'failed'].includes(item.status)}
                      className="app-button px-3 text-xs disabled:opacity-50"
                    >
                      {isTorrentVerifyPending
                        ? t($ => $.properties.torrentVerifyNowLoading)
                        : t($ => $.properties.torrentVerifyNow)}
                    </button>
                  </div>
                  <label className="text-xs text-text-muted text-right" htmlFor="torrent-remove-unselected-file">
                    {t($ => $.properties.torrentRemoveUnselectedFile)}
                  </label>
                  <label className="flex items-start gap-2 text-xs text-text-primary">
                    <input
                      id="torrent-remove-unselected-file"
                      type="checkbox"
                      checked={torrentRemoveUnselectedFile}
                      onChange={event => setTorrentRemoveUnselectedFile(event.currentTarget.checked)}
                      disabled={transferLocked || !item.torrentFileIndices?.length}
                      className="accent-red-500 mt-0.5 disabled:opacity-50"
                      aria-describedby="torrent-remove-unselected-file-hint"
                    />
                    <span id="torrent-remove-unselected-file-hint" className="text-[11px] text-text-muted">
                      {item.torrentFileIndices?.length
                        ? t($ => $.properties.torrentRemoveUnselectedFileHint)
                        : t($ => $.properties.torrentRemoveUnselectedFileSelectionRequired)}
                    </span>
                  </label>
                </>
              )}
              {(liveSpeedLimitAvailable || liveSpeedLimitUnavailable) && (
                <div className="col-start-2 rounded-lg border border-border-modal bg-bg-input/30 p-3 space-y-2">
                  {liveSpeedLimitAvailable ? (
                    <>
                      <label htmlFor="live-speed-limit" className="block text-xs font-semibold text-text-primary">
                        {t($ => $.properties.liveSpeedLimit)}
                      </label>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          id="live-speed-limit"
                          type="text"
                          inputMode="decimal"
                          value={liveSpeedLimitValue}
                          onChange={event => setLiveSpeedLimitValue(event.currentTarget.value)}
                          placeholder={t($ => $.properties.liveSpeedLimitPlaceholder)}
                          disabled={isLiveSpeedLimitPending}
                          aria-describedby="live-speed-limit-hint"
                          className="app-control w-32 px-2.5 py-1.5 text-xs font-mono disabled:opacity-50"
                        />
                        <button
                          type="button"
                          onClick={() => void handleLiveSpeedLimit(liveSpeedLimitValue)}
                          disabled={isLiveSpeedLimitPending}
                          className="app-button app-button-primary px-3 text-xs disabled:opacity-50"
                        >
                          {t($ => $.properties.liveSpeedLimitApply)}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleLiveSpeedLimit(null)}
                          disabled={isLiveSpeedLimitPending || !liveSpeedLimitValue}
                          className="app-button px-3 text-xs disabled:opacity-50"
                        >
                          {t($ => $.properties.liveSpeedLimitClear)}
                        </button>
                      </div>
                      <p id="live-speed-limit-hint" className="text-[11px] text-text-muted">
                        {t($ => $.properties.liveSpeedLimitHint)}
                      </p>
                    </>
                  ) : (
                    <p className="text-[11px] text-text-muted">
                      {t($ => $.properties.liveSpeedLimitUnavailable)}
                    </p>
                  )}
                </div>
              )}
              {liveTorrentUploadLimitAvailable && (
                <div className="col-start-2 rounded-lg border border-border-modal bg-bg-input/30 p-3 space-y-2">
                  <label htmlFor="live-torrent-upload-limit" className="block text-xs font-semibold text-text-primary">
                    {t($ => $.properties.liveTorrentUploadLimit)}
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      id="live-torrent-upload-limit"
                      type="text"
                      inputMode="decimal"
                      value={liveTorrentUploadLimitValue}
                      onChange={event => setLiveTorrentUploadLimitValue(event.currentTarget.value)}
                      placeholder={t($ => $.properties.liveTorrentUploadLimitPlaceholder)}
                      disabled={isLiveTorrentUploadLimitPending}
                      aria-describedby="live-torrent-upload-limit-hint"
                      className="app-control w-32 px-2.5 py-1.5 text-xs font-mono disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={() => void handleLiveTorrentUploadLimit(liveTorrentUploadLimitValue)}
                      disabled={isLiveTorrentUploadLimitPending}
                      className="app-button app-button-primary px-3 text-xs disabled:opacity-50"
                    >
                      {t($ => $.properties.liveSpeedLimitApply)}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleLiveTorrentUploadLimit(null)}
                      disabled={isLiveTorrentUploadLimitPending || !liveTorrentUploadLimitValue}
                      className="app-button px-3 text-xs disabled:opacity-50"
                    >
                      {t($ => $.properties.liveSpeedLimitClear)}
                    </button>
                  </div>
                  <p id="live-torrent-upload-limit-hint" className="text-[11px] text-text-muted">
                    {t($ => $.properties.liveTorrentUploadLimitHint)}
                  </p>
                </div>
              )}
              {liveTorrentPeerOptionsAvailable && (
                <div className="col-start-2 rounded-lg border border-border-modal bg-bg-input/30 p-3 space-y-2">
                  <div className="text-xs font-semibold text-text-primary">
                    {t($ => $.properties.liveTorrentPeerOptions)}
                  </div>
                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <label htmlFor="live-torrent-max-peers" className="text-[11px] text-text-muted">
                      {t($ => $.properties.torrentMaxPeers)}
                    </label>
                    <input
                      id="live-torrent-max-peers"
                      type="number"
                      min={0}
                      max={1000}
                      step={1}
                      value={liveTorrentMaxPeersValue}
                      onChange={event => setLiveTorrentMaxPeersValue(event.currentTarget.value)}
                      placeholder="55"
                      disabled={isLiveTorrentPeerOptionsPending}
                      aria-describedby="live-torrent-peer-options-hint"
                      className="app-control w-24 px-2.5 py-1.5 text-end text-xs font-mono disabled:opacity-50"
                    />
                    <label htmlFor="live-torrent-peer-speed-limit" className="text-[11px] text-text-muted">
                      {t($ => $.properties.torrentPeerSpeedLimit)}
                    </label>
                    <input
                      id="live-torrent-peer-speed-limit"
                      type="text"
                      inputMode="decimal"
                      value={liveTorrentPeerSpeedLimitValue}
                      onChange={event => setLiveTorrentPeerSpeedLimitValue(event.currentTarget.value)}
                      placeholder="50K"
                      disabled={isLiveTorrentPeerOptionsPending}
                      aria-describedby="live-torrent-peer-options-hint"
                      className="app-control w-24 px-2.5 py-1.5 text-end text-xs font-mono disabled:opacity-50"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleLiveTorrentPeerOptions()}
                    disabled={isLiveTorrentPeerOptionsPending}
                    className="app-button app-button-primary px-3 text-xs disabled:opacity-50"
                  >
                    {t($ => $.properties.liveTorrentPeerOptionsApply)}
                  </button>
                  <p id="live-torrent-peer-options-hint" className="text-[11px] text-text-muted">
                    {t($ => $.properties.liveTorrentPeerOptionsHint)}
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Site Login Section */}
          <section>
            <h3 className="text-sm font-semibold text-text-primary mb-4 pb-1 border-b border-border-modal/50">
              {item.status === 'completed' ? t($ => $.properties.siteLoginRedownload) : t($ => $.properties.siteLogin)}
            </h3>
            
            <div className="flex gap-1 p-1 bg-border-color rounded-lg mb-4 w-fit mx-auto md:mx-0">
              {(['matching', 'custom', 'none'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => !transferLocked && setLoginMode(mode)}
                  disabled={transferLocked}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${loginMode === mode ? 'bg-bg-modal text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'}`}
                >
                  {mode === 'matching' ? t($ => $.properties.matchingSiteLogin) : mode === 'custom' ? t($ => $.properties.customCredentials) : t($ => $.properties.noLogin)}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-[100px_1fr] gap-y-3.5 gap-x-4 items-center">
              {loginMode === 'matching' && (
                <div className="col-start-2 text-xs text-text-secondary italic">
                  {t($ => $.properties.useSavedLogin)}
                </div>
              )}
              {loginMode === 'custom' && (
                <>
                  <label className="text-xs text-text-muted text-right">{t($ => $.properties.username)}</label>
                  <input type="text" value={username} onChange={e=>setUsername(e.target.value)} disabled={transferLocked} placeholder={t($ => $.properties.username)} className="max-w-[250px] bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-50" />
                  
                  <label className="text-xs text-text-muted text-right">{t($ => $.properties.password)}</label>
                  <input type="password" value={password} onChange={e=>setPassword(e.target.value)} disabled={transferLocked} placeholder={t($ => $.properties.password)} className="max-w-[250px] bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-50" />
                </>
              )}
            </div>
          </section>

          {item.isTorrent && (
            <section>
              <h3 className="text-sm font-semibold text-text-primary mb-4 pb-1 border-b border-border-modal/50">
                {t($ => $.properties.torrentDetails)}
              </h3>
              {isTorrentDetailsPending && (
                <p className="text-xs text-text-muted">{t($ => $.properties.torrentDetailsLoading)}</p>
              )}
              {torrentDetailsError && (
                <p className="text-xs text-red-400">{t($ => $.properties.torrentDetailsUnavailable)}</p>
              )}
              {torrentDetails && (
                <div className="grid grid-cols-[100px_1fr] gap-x-4 gap-y-2 rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs">
                  <span className="text-text-muted text-right">{t($ => $.properties.torrentDetailsDisplayName)}</span>
                  <span className="text-text-primary break-words" dir="auto">{torrentDetails.displayName}</span>
                  <span className="text-text-muted text-right">{t($ => $.properties.torrentDetailsInfoHash)}</span>
                  <span className="font-mono text-text-primary break-all">{torrentDetails.infoHash}</span>
                  <span className="text-text-muted text-right">{t($ => $.properties.torrentDetailsSize)}</span>
                  <span className="text-text-primary">{formatDownloadBytes(torrentDetails.totalBytes)}</span>
                  <span className="text-text-muted text-right">{t($ => $.properties.torrentDetailsFiles)}</span>
                  <span className="text-text-primary">{torrentDetails.fileCount}</span>
                  <span className="text-text-muted text-right">{t($ => $.properties.torrentDetailsPieces)}</span>
                  <span className="text-text-primary">{torrentDetails.pieceCount} × {formatDownloadBytes(torrentDetails.pieceLength)}</span>
                  <span className="text-text-muted text-right">{t($ => $.properties.torrentDetailsPrivate)}</span>
                  <span className="text-text-primary">{torrentDetails.private
                    ? t($ => $.properties.torrentDetailsPrivateYes)
                    : t($ => $.properties.torrentDetailsPrivateNo)}</span>
                  {torrentDetails.creationDate && (
                    <>
                      <span className="text-text-muted text-right">{t($ => $.properties.torrentDetailsCreated)}</span>
                      <span className="text-text-primary">{formatDateTime(torrentDetails.creationDate, {
                        locale: i18n.language,
                        calendar: calendarPreference,
                        options: { dateStyle: 'medium', timeStyle: 'short' }
                      })}</span>
                    </>
                  )}
                  {torrentDetails.creator && (
                    <>
                      <span className="text-text-muted text-right">{t($ => $.properties.torrentDetailsCreator)}</span>
                      <span className="text-text-primary break-words" dir="auto">{torrentDetails.creator}</span>
                    </>
                  )}
                  {torrentDetails.comment && (
                    <>
                      <span className="text-text-muted text-right">{t($ => $.properties.torrentDetailsComment)}</span>
                      <span className="whitespace-pre-wrap break-words text-text-primary" dir="auto">{torrentDetails.comment}</span>
                    </>
                  )}
                  <span className="text-text-muted text-right">{t($ => $.properties.torrentDetailsTrackers)}</span>
                  <span className="text-text-primary break-words" dir="auto">
                    {torrentDetails.trackers.length > 0 ? torrentDetails.trackers.join(', ') : '—'}
                  </span>
                  <span className="text-text-muted text-right">{t($ => $.properties.torrentDetailsWebSeeds)}</span>
                  <span className="text-text-primary break-words" dir="auto">
                    {torrentDetails.webSeeds.length > 0 ? torrentDetails.webSeeds.join(', ') : '—'}
                  </span>
                  {torrentDetails.private && (
                    <p className="col-span-2 text-[11px] text-text-muted">
                      {t($ => $.properties.torrentDetailsPrivateHint)}
                    </p>
                  )}
                </div>
              )}
            </section>
          )}

          {item.isTorrent && (
            <section>
              <h3 className="text-sm font-semibold text-text-primary mb-4 pb-1 border-b border-border-modal/50">
                {t($ => $.properties.torrentWebSeeds)}
              </h3>
              <p className="text-xs text-text-muted mb-2">{t($ => $.properties.torrentWebSeedsHint)}</p>
              <textarea
                value={torrentWebSeedsText}
                onChange={event => setTorrentWebSeedsText(event.target.value)}
                placeholder={t($ => $.properties.torrentWebSeedsPlaceholder)}
                disabled={isTorrentWebSeedsPending}
                aria-label={t($ => $.properties.torrentWebSeeds)}
                className="w-full h-20 bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-accent disabled:opacity-50 resize-none"
              />
              <div className="flex items-center justify-between mt-2 gap-2">
                <span className="text-xs text-red-500">
                  {torrentWebSeedsError ? t($ => $.properties.torrentWebSeedsFailed) : ''}
                </span>
                <button
                  type="button"
                  onClick={() => void handleTorrentWebSeedsSave()}
                  disabled={isTorrentWebSeedsPending}
                  className="app-button px-3 text-xs"
                >
                  {isTorrentWebSeedsPending ? t($ => $.properties.torrentWebSeedsLoading) : t($ => $.properties.torrentWebSeedsApply)}
                </button>
              </div>
            </section>
          )}

          {/* Advanced Transfer Section */}
          <section>
             <button 
                onClick={() => setAdvancedExpanded(!advancedExpanded)}
                className="flex items-center gap-2 text-sm font-semibold text-text-primary w-full pb-1 border-b border-border-modal/50 hover:text-blue-400 transition-colors"
              >
                {advancedExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                {item.status === 'completed' ? t($ => $.properties.advancedTransferRedownload) : t($ => $.properties.advancedTransfer)}
             </button>
             
             {advancedExpanded && (
               <div className="mt-4 grid grid-cols-[100px_1fr] gap-y-3.5 gap-x-4 items-center pl-6">
                 <label className="text-xs text-text-muted text-right">{t($ => $.properties.checksum)}</label>
                 <label className="flex items-center gap-2 text-xs text-text-primary">
                    <input type="checkbox" checked={checksumEnabled} onChange={e => setChecksumEnabled(e.target.checked)} disabled={transferLocked} className="rounded border-border-modal text-blue-500 focus:ring-blue-500/20 bg-bg-input" />
                    {t($ => $.properties.verify)}
                 </label>

                 {checksumEnabled && (
                    <>
                      <label className="text-xs text-text-muted text-right">{t($ => $.properties.algorithm)}</label>
                      <select value={checksumAlgorithm} onChange={e=>setChecksumAlgorithm(e.target.value)} disabled={transferLocked} className="max-w-[150px] bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-50">
                        <option value="MD5">MD5</option>
                        <option value="SHA-1">SHA-1</option>
                        <option value="SHA-256">SHA-256</option>
                        <option value="SHA-512">SHA-512</option>
                      </select>

                      <label className="text-xs text-text-muted text-right">{t($ => $.properties.digest)}</label>
                      <input type="text" value={checksumValue} onChange={e=>setChecksumValue(e.target.value)} disabled={transferLocked} placeholder={t($ => $.properties.expectedDigest)} className="bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-accent disabled:opacity-50" />
                    </>
                 )}

                 <label className="text-xs text-text-muted text-right">{t($ => $.properties.cookies)}</label>
                 <input type="password" value={cookies} onChange={e=>setCookies(e.target.value)} disabled={transferLocked} autoComplete="off" placeholder={t($ => $.properties.cookies)} className="bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-accent disabled:opacity-50" />
                 
                 <div className="col-span-2 mt-2">
                   <label className="block text-xs text-text-muted mb-1.5">{t($ => $.properties.headers)}</label>
                   <textarea value={headers} onChange={e=>setHeaders(e.target.value)} disabled={transferLocked} className="w-full h-16 bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-accent disabled:opacity-50 resize-none"></textarea>
                 </div>

                 <div className="col-span-2">
                   <label className="block text-xs text-text-muted mb-1.5">{t($ => $.properties.mirrors)}</label>
                   <textarea value={mirrors} onChange={e=>setMirrors(e.target.value)} disabled={transferLocked} className="w-full h-16 bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-accent disabled:opacity-50 resize-none"></textarea>
                 </div>
               </div>
             )}
          </section>

        </div>

        <div className="h-[1px] bg-border-modal w-full shrink-0"></div>

        {/* Footer */}
        <div className="p-3 px-4 bg-sidebar-bg flex items-center justify-between shrink-0">
          <div className="text-red-500 text-xs truncate max-w-[400px]">
             {errorMessage}
          </div>
          <div className="flex gap-2">
            <button 
              type="button"
              onClick={() => setSelectedPropertiesDownloadId(null)} 
              className="app-button px-4 text-xs"
            >
              {t($ => $.properties.cancel)}
            </button>
            {pauseResumeAction && (
              <button
                type="button"
                onClick={() => void handlePauseResume()}
                disabled={isPauseResumePending}
                aria-label={pauseResumeLabel}
                title={pauseResumeLabel}
                className={`app-button px-4 text-xs ${isPauseResumePending ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <PauseResumeIcon size={14} fill="currentColor" />
                {pauseResumeLabel}
              </button>
            )}
            <button 
              type="button"
              onClick={handleSave} 
              disabled={transferLocked || torrentFileSelectionIsEmpty}
              className={`app-button app-button-primary px-4 text-xs ${transferLocked || torrentFileSelectionIsEmpty ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <CheckCircle size={14} />
              {t($ => $.properties.save)}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};

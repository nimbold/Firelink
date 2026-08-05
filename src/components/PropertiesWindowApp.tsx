import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Activity, Copy, Download, FileDown, FolderOpen, Gauge, MapPin, MoreHorizontal, Pause, Play, RefreshCw, Save, Timer, Upload, Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TorrentAvailabilitySnapshot } from '../bindings/TorrentAvailabilitySnapshot';
import type { TorrentDetails } from '../bindings/TorrentDetails';
import type { TorrentFileProgressSnapshot } from '../bindings/TorrentFileProgressSnapshot';
import type { TorrentPeerDiagnostics } from '../bindings/TorrentPeerDiagnostics';
import { invokeCommand as invoke } from '../ipc';
import {
  PROPERTIES_WINDOW_ACTION_RESULT,
  PROPERTIES_WINDOW_REMOVED,
  PROPERTIES_WINDOW_SNAPSHOT,
  attachAsyncPropertiesListener,
  DEFAULT_PROPERTIES_WINDOW_CHROME,
  formatPropertiesQueuePlacement,
  getPropertiesLifecycleAction,
  propertiesTorrentPeerLimit,
  propertiesDiagnosticRequestState,
  sendPropertiesActionRequest,
  sendPropertiesReady,
  isExpectedPropertiesDiagnosticUnavailable,
  nextPropertiesRequestId,
  propertiesDiagnosticPhase,
  propertiesActionRequestKey,
  resetPropertiesActionState,
  type PropertiesAction,
  type PropertiesActionRequest,
  type PropertiesActionResult,
  type PropertiesPatch,
  type PropertiesDiagnosticPhase,
  type PropertiesSnapshot,
  type PropertiesSnapshotEvent,
} from '../propertiesBridge';
import { formatDownloadBytes, formatTorrentRatio } from '../utils/downloadProgress';
import { changeAppLocale } from '../i18n';
import { synchronizeDocumentAppearance } from '../utils/documentAppearance';
import { getWindowControlRevealOffset } from '../utils/windowControlStyle';
import { getPropertiesFooterActions } from '../utils/propertiesFooter';
import { WindowControls } from './WindowControls';
import {
  TORRENT_ENCRYPTION_POLICY_DISABLED,
  TORRENT_ENCRYPTION_POLICY_FORCE_ENCRYPTION,
  TORRENT_ENCRYPTION_POLICY_REQUIRE_CRYPTO,
  type TorrentEncryptionPolicy,
  type TorrentFileAllocation,
} from '../utils/downloads';

type PropertiesTab = 'overview' | 'files' | 'trackers' | 'peers' | 'options' | 'transfer' | 'advanced';
type SecretName = 'username' | 'password' | 'cookies' | 'headers';
type SecretDraft = { value: string; touched: boolean; clear: boolean };
const SECRET_NAMES: SecretName[] = ['username', 'password', 'cookies', 'headers'];
const isTorrentDiagnosticsStatus = (status: string) =>
  ['downloading', 'verifying', 'seeding', 'waitingToSeed', 'retrying', 'paused', 'completed'].includes(status);

const isTorrentPollingStatus = (status: string) =>
  ['downloading', 'verifying', 'seeding', 'waitingToSeed', 'retrying', 'paused'].includes(status);

const isEditableStatus = (status: string) => !['downloading', 'processing', 'verifying', 'seeding', 'waitingToSeed', 'retrying', 'moving'].includes(status);

const isTorrentFileSelectionEditable = (status: string) =>
  ['ready', 'staged', 'queued', 'paused', 'failed'].includes(status);

const safeTitle = (name: string) => {
  const bounded = name.replace(/[\r\n\u0000]/g, ' ').trim().slice(0, 160);
  return `${bounded || 'Download'} - Properties - Firelink`;
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const propertiesStatusTone = (status: string) => {
  if (status === 'paused') return 'paused';
  if (status === 'seeding') return 'seeding';
  if (status === 'failed') return 'failed';
  if (status === 'processing' || status === 'verifying' || status === 'moving') return 'processing';
  if (status === 'queued' || status === 'staged') return 'queued';
  if (status === 'retrying') return 'retrying';
  if (status === 'completed') return 'completed';
  return 'downloading';
};

const propertiesDiagnosticLifecycleKey = (snapshot: PropertiesSnapshot): string => [
  snapshot.id,
  snapshot.status,
  snapshot.lastTry ?? '',
  snapshot.hasBeenDispatched === true,
  snapshot.destination ?? '',
  snapshot.torrentInfoHash ?? '',
  snapshot.torrentFileIndices?.join(',') ?? '',
  snapshot.torrentMoveDestination ?? '',
  snapshot.torrentMoveRestoreStatus ?? '',
  snapshot.torrentVerifyOnly === true,
  snapshot.torrentRelocationCheckPending === true,
].join('\u0000');

export const PropertiesWindowApp = () => {
  const { t } = useTranslation();
  const currentWindow = useMemo(() => getCurrentWindow(), []);
  const windowLabel = currentWindow.label;
  const sessionId = useMemo(() => crypto.randomUUID(), []);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PropertiesSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<PropertiesTab>('overview');
  const [pendingTab, setPendingTab] = useState<PropertiesTab | null>(null);
  const [closePrompt, setClosePrompt] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingAction, setPendingAction] = useState<PropertiesAction | null>(null);
  const [pendingTorrentCommand, setPendingTorrentCommand] = useState<'magnet' | 'export' | 'move' | null>(null);
  const [fileProgress, setFileProgress] = useState<TorrentFileProgressSnapshot | null>(null);
  const [peers, setPeers] = useState<TorrentPeerDiagnostics | null>(null);
  const [availability, setAvailability] = useState<TorrentAvailabilitySnapshot | null>(null);
  const [details, setDetails] = useState<TorrentDetails | null>(null);
  const [diagnosticError, setDiagnosticError] = useState('');
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsRefreshing, setDiagnosticsRefreshing] = useState(false);
  const [diagnosticPhase, setDiagnosticPhase] = useState<PropertiesDiagnosticPhase>('idle');
  // null means the Files tab has no local selection draft yet; [] is an
  // explicit user choice to clear every file and must remain visually empty.
  const [selectedFiles, setSelectedFiles] = useState<number[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [destination, setDestination] = useState('');
  const [connections, setConnections] = useState('');
  const [trackers, setTrackers] = useState('');
  const [excludedTrackers, setExcludedTrackers] = useState('');
  const [downloadLimit, setDownloadLimit] = useState('');
  const [uploadLimit, setUploadLimit] = useState('');
  const [maxPeers, setMaxPeers] = useState('');
  const [peerSpeedLimit, setPeerSpeedLimit] = useState('');
  const [seedTime, setSeedTime] = useState('');
  const [seedRatio, setSeedRatio] = useState('');
  const [checkIntegrity, setCheckIntegrity] = useState(false);
  const [removeUnselectedFile, setRemoveUnselectedFile] = useState(false);
  const [stopTimeout, setStopTimeout] = useState('');
  const [prioritizePiece, setPrioritizePiece] = useState('');
  const [encryptionPolicy, setEncryptionPolicy] = useState<TorrentEncryptionPolicy>(TORRENT_ENCRYPTION_POLICY_DISABLED);
  const [fileAllocation, setFileAllocation] = useState<TorrentFileAllocation>('prealloc');
  const [trackerConnectTimeout, setTrackerConnectTimeout] = useState('');
  const [trackerTimeout, setTrackerTimeout] = useState('');
  const [trackerInterval, setTrackerInterval] = useState('');
  const [secretDrafts, setSecretDrafts] = useState<Record<SecretName, SecretDraft>>({
    username: { value: '', touched: false, clear: false },
    password: { value: '', touched: false, clear: false },
    cookies: { value: '', touched: false, clear: false },
    headers: { value: '', touched: false, clear: false },
  });
  const [draftTab, setDraftTab] = useState<PropertiesTab | null>(null);
  const draftTabRef = useRef<PropertiesTab | null>(null);
  const closeAfterSaveRef = useRef(false);
  const switchAfterSaveRef = useRef<PropertiesTab | null>(null);
  const requestIdRef = useRef(0);
  const pendingActionRequestRef = useRef<PropertiesActionRequest | null>(null);
  const pendingActionRef = useRef<PropertiesAction | null>(null);
  const pendingActionSendKeyRef = useRef<string | null>(null);
  const latestSnapshotRevisionRef = useRef(0);
  const latestBridgeGenerationRef = useRef<number | null>(null);
  const appearanceCleanupRef = useRef<(() => void) | null>(null);
  const hasRevealedWindowRef = useRef(false);
  const revealInFlightRef = useRef(false);
  const diagnosticsInFlightRef = useRef(new Set<string>());
  const snapshotRef = useRef(snapshot);
  const activeTabRef = useRef(activeTab);
  const downloadIdRef = useRef(downloadId);
  const fileProgressRef = useRef(fileProgress);
  const peersRef = useRef(peers);
  const availabilityRef = useRef(availability);
  const detailsRef = useRef(details);
  const diagnosticAttemptsRef = useRef(new Set<string>());
  const diagnosticLifecycleKeyRef = useRef('');
  const diagnosticLifecycleEpochRef = useRef(0);
  const allowWindowCloseRef = useRef(false);
  const isDirtyRef = useRef(false);
  const windowChromeRef = useRef(DEFAULT_PROPERTIES_WINDOW_CHROME);
  snapshotRef.current = snapshot;
  activeTabRef.current = activeTab;
  downloadIdRef.current = downloadId;
  fileProgressRef.current = fileProgress;
  peersRef.current = peers;
  availabilityRef.current = availability;
  detailsRef.current = details;

  const isTorrent = snapshot?.isTorrent === true;
  const tabs = useMemo<PropertiesTab[]>(() => isTorrent
    ? ['overview', 'files', 'trackers', 'peers', 'options']
    : ['overview', 'transfer', 'advanced'], [isTorrent]);
  const isDirty = draftTab !== null;
  isDirtyRef.current = isDirty;
  if (isDirty && allowWindowCloseRef.current) {
    // A programmatic close is only authorized for the close request it
    // immediately follows. If the native close was vetoed by another owner
    // and the user starts editing again, restore the dirty-state guard.
    allowWindowCloseRef.current = false;
  }

  const closeCurrentWindow = useCallback(async (allowDirtyClose = false) => {
    allowWindowCloseRef.current = allowDirtyClose;
    try {
      await currentWindow.close();
    } catch (error) {
      setErrorMessage(errorText(error));
      allowWindowCloseRef.current = false;
    }
  }, [currentWindow]);

  useEffect(() => {
    draftTabRef.current = draftTab;
  }, [draftTab]);

  const hydrateDraft = useCallback((next: PropertiesSnapshot) => {
    setFileName(next.fileName);
    setDestination(next.destination ?? '');
    setConnections(next.connections === undefined ? '' : String(next.connections));
    setTrackers(next.torrentTrackers ?? '');
    setExcludedTrackers(next.torrentExcludeTrackers ?? '');
    setSelectedFiles(next.torrentFileIndices ? [...next.torrentFileIndices] : null);
    setDownloadLimit(next.speedLimit ?? '');
    setUploadLimit(next.torrentUploadLimit ?? '');
    setMaxPeers(next.torrentMaxPeers === undefined ? '' : String(next.torrentMaxPeers));
    setPeerSpeedLimit(next.torrentPeerSpeedLimit ?? '');
    setSeedTime(next.torrentSeedTime === undefined ? '' : String(next.torrentSeedTime));
    setSeedRatio(next.torrentSeedRatio === undefined ? '' : String(next.torrentSeedRatio));
    setCheckIntegrity(next.torrentCheckIntegrity === true);
    setRemoveUnselectedFile(next.torrentRemoveUnselectedFile === true);
    setStopTimeout(next.torrentStopTimeout === undefined ? '' : String(next.torrentStopTimeout));
    setPrioritizePiece(next.torrentPrioritizePiece ?? '');
    setEncryptionPolicy((next.torrentEncryptionPolicy as TorrentEncryptionPolicy | undefined) ?? TORRENT_ENCRYPTION_POLICY_DISABLED);
    setFileAllocation((next.torrentFileAllocation as TorrentFileAllocation | undefined) ?? 'prealloc');
    setTrackerConnectTimeout(next.torrentTrackerConnectTimeout === undefined ? '' : String(next.torrentTrackerConnectTimeout));
    setTrackerTimeout(next.torrentTrackerTimeout === undefined ? '' : String(next.torrentTrackerTimeout));
    setTrackerInterval(next.torrentTrackerInterval === undefined ? '' : String(next.torrentTrackerInterval));
    setSecretDrafts({
      username: { value: '', touched: false, clear: false },
      password: { value: '', touched: false, clear: false },
      cookies: { value: '', touched: false, clear: false },
      headers: { value: '', touched: false, clear: false },
    });
  }, []);

  const refreshDiagnostics = useCallback(async (tab: PropertiesTab, id: string, manual = false) => {
    if (!isTorrentDiagnosticsStatus(snapshotRef.current?.status ?? '')) return;
    const diagnosticTabKey = `${id}:${tab}`;
    const requestLifecycleEpoch = diagnosticLifecycleEpochRef.current;
    const requestKey = `${diagnosticTabKey}:${requestLifecycleEpoch}`;
    if (diagnosticsInFlightRef.current.has(requestKey)) return;
    diagnosticsInFlightRef.current.add(requestKey);
    const isCurrent = () => downloadIdRef.current === id
      && activeTabRef.current === tab
      && isTorrentDiagnosticsStatus(snapshotRef.current?.status ?? '')
      && diagnosticLifecycleEpochRef.current === requestLifecycleEpoch;
    const hasCachedResult = () => tab === 'files'
      ? fileProgressRef.current !== null
      : tab === 'peers'
        ? peersRef.current !== null || availabilityRef.current !== null
        : detailsRef.current !== null;
    const hasPreviousAttempt = diagnosticAttemptsRef.current.has(diagnosticTabKey);
    diagnosticAttemptsRef.current.add(diagnosticTabKey);
    if (isCurrent()) {
      const cached = hasCachedResult();
      const requestState = propertiesDiagnosticRequestState(cached, hasPreviousAttempt, manual);
      setDiagnosticsLoading(requestState.loading);
      setDiagnosticsRefreshing(requestState.refreshing);
      // A silent refresh with no cached result must not replace a stable
      // unavailable/error message between polling requests. Cached results
      // remain visible while their request is refreshed in the background.
      if (requestState.resetMessage) {
        setDiagnosticError('');
        setDiagnosticPhase(requestState.phase);
      }
    }
    try {
      if (tab === 'overview') {
        const nextDetails = await invoke('get_torrent_details', { id });
        if (isCurrent()) {
          setDetails(nextDetails);
          setDiagnosticPhase(propertiesDiagnosticPhase(false, 'success'));
        }
      } else if (tab === 'files') {
        const nextProgress = await invoke('get_torrent_file_progress', { id });
        if (isCurrent()) {
          setFileProgress(nextProgress);
          setDiagnosticPhase(propertiesDiagnosticPhase(false, 'success'));
        }
      } else if (tab === 'peers') {
        const [peerResult, availabilityResult] = await Promise.allSettled([
          invoke('get_torrent_peers', { id }),
          invoke('get_torrent_availability', { id }),
        ]);
        if (isCurrent()) {
          if (peerResult.status === 'fulfilled') setPeers(peerResult.value);
          if (availabilityResult.status === 'fulfilled') setAvailability(availabilityResult.value);
          const rejectedResults = [peerResult, availabilityResult]
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map(result => result.reason);
          const unexpectedErrors = rejectedResults
            .filter(error => !isExpectedPropertiesDiagnosticUnavailable(error));
          setDiagnosticError(unexpectedErrors.length > 0 ? errorText(unexpectedErrors[0]) : '');
          if (rejectedResults.length > 0) {
            const hasPeerResult = hasCachedResult()
              || peerResult.status === 'fulfilled'
              || availabilityResult.status === 'fulfilled';
            setDiagnosticPhase(propertiesDiagnosticPhase(
              hasPeerResult,
              unexpectedErrors.length > 0 ? 'unexpected-error' : 'expected-unavailable',
            ));
          } else setDiagnosticPhase(propertiesDiagnosticPhase(false, 'success'));
        }
      }
    } catch (error) {
      if (isCurrent()) {
        const message = errorText(error);
        // A paused row may not have a retained Aria2 GID (for example when it
        // was paused before its first dispatch). That is an expected absence,
        // not a diagnostic failure, and must not flash a raw backend error.
        if (isExpectedPropertiesDiagnosticUnavailable(error)) {
          setDiagnosticError('');
          setDiagnosticPhase(propertiesDiagnosticPhase(hasCachedResult(), 'expected-unavailable'));
        } else {
          setDiagnosticError(message);
          setDiagnosticPhase(propertiesDiagnosticPhase(hasCachedResult(), 'unexpected-error'));
        }
      }
    } finally {
      diagnosticsInFlightRef.current.delete(requestKey);
      if (downloadIdRef.current === id
        && activeTabRef.current === tab
        && diagnosticLifecycleEpochRef.current === requestLifecycleEpoch) {
        setDiagnosticsLoading(false);
        setDiagnosticsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let readyRetryTimer: number | undefined;
    let readyHeartbeatTimer: number | undefined;
    let unlistenSnapshot: UnlistenFn | undefined;
    let unlistenResult: UnlistenFn | undefined;
    let unlistenRemoved: UnlistenFn | undefined;
    const start = async () => {
      try {
        const id = await invoke('get_properties_window_download_id');
        if (cancelled) return;
        setDownloadId(id);
        const snapshotListener = await listen<PropertiesSnapshotEvent>(PROPERTIES_WINDOW_SNAPSHOT, async event => {
          if (cancelled) return;
          if (event.payload.windowLabel !== windowLabel
            || event.payload.downloadId !== id
            || event.payload.sessionId !== sessionId) return;
          if (latestBridgeGenerationRef.current !== null
            && event.payload.bridgeGeneration < latestBridgeGenerationRef.current) return;
          if (latestBridgeGenerationRef.current !== event.payload.bridgeGeneration) {
            latestBridgeGenerationRef.current = event.payload.bridgeGeneration;
            latestSnapshotRevisionRef.current = 0;
            diagnosticLifecycleEpochRef.current += 1;
            diagnosticLifecycleKeyRef.current = '';
            diagnosticAttemptsRef.current.clear();
            const lostAction = pendingActionRef.current;
            const lostDraftAction = lostAction === 'apply-properties'
              || lostAction === 'set-torrent-file-selection';
            // A main-webview restart can lose both the action-result event and
            // the store transition event while the child Properties window
            // remains alive. No result from the dead bridge can be correlated
            // safely after this point, so release the UI lock after adopting
            // the next snapshot and require any retry to be an explicit user
            // action. This never replays a possibly completed lifecycle
            // request, and also recovers when the native request failed while
            // its failure event was lost.
            const resetActionState = resetPropertiesActionState(requestIdRef.current);
            requestIdRef.current = resetActionState.requestId;
            pendingActionRequestRef.current = resetActionState.request;
            pendingActionRef.current = resetActionState.pendingAction;
            setPendingAction(null);
            closeAfterSaveRef.current = false;
            switchAfterSaveRef.current = null;
            if (lostDraftAction) {
              // A completed property action is represented by the fresh
              // snapshot, not by the stale draft that produced the request.
              draftTabRef.current = null;
              setDraftTab(null);
              setPendingTab(null);
              setClosePrompt(false);
            }
            setPendingTorrentCommand(null);
          }
          if (event.payload.revision <= latestSnapshotRevisionRef.current) return;
          latestSnapshotRevisionRef.current = event.payload.revision;
          const nextDiagnosticLifecycleKey = propertiesDiagnosticLifecycleKey(event.payload.snapshot);
          if (diagnosticLifecycleKeyRef.current !== nextDiagnosticLifecycleKey) {
            diagnosticLifecycleKeyRef.current = nextDiagnosticLifecycleKey;
            diagnosticLifecycleEpochRef.current += 1;
            diagnosticAttemptsRef.current.clear();
          }
          await changeAppLocale(event.payload.snapshot.appearance.locale);
          if (cancelled
            || event.payload.bridgeGeneration !== latestBridgeGenerationRef.current
            || event.payload.revision !== latestSnapshotRevisionRef.current) return;
          appearanceCleanupRef.current?.();
          appearanceCleanupRef.current = synchronizeDocumentAppearance(
            window,
            event.payload.snapshot.appearance,
          );
          windowChromeRef.current = event.payload.snapshot.windowChrome ?? DEFAULT_PROPERTIES_WINDOW_CHROME;
          setSnapshot(event.payload.snapshot);
          if (draftTabRef.current === null) hydrateDraft(event.payload.snapshot);
          void currentWindow.setTitle(safeTitle(event.payload.snapshot.fileName)).catch(() => undefined);
          if (!hasRevealedWindowRef.current && !revealInFlightRef.current) {
            revealInFlightRef.current = true;
            try {
              await invoke('properties_window_reveal');
              hasRevealedWindowRef.current = true;
              if (readyRetryTimer !== undefined) {
                window.clearInterval(readyRetryTimer);
                readyRetryTimer = undefined;
              }
            } finally {
              revealInFlightRef.current = false;
            }
          }
        });
        if (cancelled) {
          snapshotListener();
          return;
        }
        unlistenSnapshot = snapshotListener;
        const resultListener = await listen<PropertiesActionResult>(PROPERTIES_WINDOW_ACTION_RESULT, event => {
          if (cancelled) return;
          if (event.payload.windowLabel !== windowLabel
            || event.payload.downloadId !== id
            || event.payload.sessionId !== sessionId) return;
          if (event.payload.requestId !== requestIdRef.current) return;
          if (pendingActionRef.current === null) return;
          const completedAction = pendingActionRef.current;
          pendingActionRef.current = null;
          pendingActionRequestRef.current = null;
          setPendingAction(null);
          if (!event.payload.ok) {
            setErrorMessage(event.payload.error ?? 'The action failed');
            closeAfterSaveRef.current = false;
            switchAfterSaveRef.current = null;
          } else {
            const commitsDraft = completedAction === 'apply-properties'
              || completedAction === 'set-torrent-file-selection';
            const nextTab = switchAfterSaveRef.current;
            const shouldClose = closeAfterSaveRef.current;
            switchAfterSaveRef.current = null;
            closeAfterSaveRef.current = false;
            setErrorMessage('');
            setNotice(completedAction === 'apply-properties' ? t($ => $.properties.saved) : '');
            if (commitsDraft) {
              draftTabRef.current = null;
              setDraftTab(null);
              setClosePrompt(false);
              if (nextTab) {
                setActiveTab(nextTab);
                setPendingTab(null);
              }
              if (shouldClose) {
                void closeCurrentWindow(true);
              }
            }
          }
        });
        if (cancelled) {
          resultListener();
          return;
        }
        unlistenResult = resultListener;
        const removedListener = await listen<{ windowLabel: string; downloadId: string }>(PROPERTIES_WINDOW_REMOVED, event => {
          if (cancelled) return;
          if (event.payload.windowLabel === windowLabel && event.payload.downloadId === id) {
            if (readyRetryTimer !== undefined) {
              window.clearInterval(readyRetryTimer);
              readyRetryTimer = undefined;
            }
            if (readyHeartbeatTimer !== undefined) {
              window.clearInterval(readyHeartbeatTimer);
              readyHeartbeatTimer = undefined;
            }
            diagnosticLifecycleEpochRef.current += 1;
            diagnosticLifecycleKeyRef.current = '';
            diagnosticAttemptsRef.current.clear();
            setSnapshot(null);
            draftTabRef.current = null;
            isDirtyRef.current = false;
            setDraftTab(null);
            setPendingTab(null);
            setClosePrompt(false);
            closeAfterSaveRef.current = false;
            switchAfterSaveRef.current = null;
            pendingActionRequestRef.current = null;
            pendingActionRef.current = null;
            pendingActionSendKeyRef.current = null;
            allowWindowCloseRef.current = false;
            setPendingAction(null);
            setNotice(t($ => $.downloadTable.noDownloads));
          }
        });
        if (cancelled) {
          removedListener();
          return;
        }
        unlistenRemoved = removedListener;
        await sendPropertiesReady(sessionId);
        if (cancelled) return;
        // Tauri event listeners are registered asynchronously. If the main
        // bridge was still installing its listener, the first ready event can
        // legitimately be missed; retry until the first snapshot confirms
        // the handshake rather than leaving a permanently hidden window.
        readyRetryTimer = window.setInterval(() => {
          if (cancelled || hasRevealedWindowRef.current) return;
          void sendPropertiesReady(sessionId).catch(() => undefined);
        }, 500);
        // The main webview can restart independently of this child window.
        // Keep the registration alive so a fresh Properties bridge can send a
        // new snapshot and recover action state without replaying a request.
        readyHeartbeatTimer = window.setInterval(() => {
          if (cancelled) return;
          void sendPropertiesReady(sessionId).catch(() => undefined);
        }, 2000);
      } catch (error) {
        if (!cancelled) setErrorMessage(errorText(error));
      }
    };
    void start();
    return () => {
      cancelled = true;
      if (readyRetryTimer !== undefined) window.clearInterval(readyRetryTimer);
      if (readyHeartbeatTimer !== undefined) window.clearInterval(readyHeartbeatTimer);
      unlistenSnapshot?.();
      unlistenResult?.();
      unlistenRemoved?.();
      pendingActionRequestRef.current = null;
      pendingActionSendKeyRef.current = null;
      allowWindowCloseRef.current = false;
      appearanceCleanupRef.current?.();
      appearanceCleanupRef.current = null;
    };
  }, [closeCurrentWindow, currentWindow, hydrateDraft, sessionId, t, windowLabel]);

  useEffect(() => {
    if (!snapshot || draftTab !== null) return;
    hydrateDraft(snapshot);
  }, [draftTab, hydrateDraft, snapshot]);

  useEffect(() => {
    if (!downloadId || !snapshot || !isTorrent || !isTorrentDiagnosticsStatus(snapshot.status)) {
      setDetails(null);
      setFileProgress(null);
      setPeers(null);
      setAvailability(null);
      setDiagnosticError('');
      setDiagnosticsLoading(false);
      setDiagnosticsRefreshing(false);
      diagnosticLifecycleEpochRef.current += 1;
      diagnosticLifecycleKeyRef.current = '';
      diagnosticAttemptsRef.current.clear();
      setDiagnosticPhase('idle');
      return;
    }
    if (!isTorrentPollingStatus(snapshot.status)) {
      setFileProgress(null);
      setPeers(null);
      setAvailability(null);
      diagnosticAttemptsRef.current.clear();
      setDiagnosticPhase('idle');
    }
    void refreshDiagnostics(activeTab, downloadId);
    if (!isTorrentPollingStatus(snapshot.status) || !['files', 'peers'].includes(activeTab)) return;
    // Match the 1-second cadence of the normal Aria2 progress poll. The
    // diagnostics request itself is still single-flight, so a slow RPC cannot
    // create overlapping refreshes.
    const interval = window.setInterval(() => void refreshDiagnostics(activeTab, downloadId), 1000);
    return () => window.clearInterval(interval);
  }, [activeTab, downloadId, isTorrent, refreshDiagnostics, snapshot?.status]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    attachAsyncPropertiesListener(currentWindow.onCloseRequested(event => {
      if (allowWindowCloseRef.current) {
        allowWindowCloseRef.current = false;
        return;
      }
      if (!isDirtyRef.current) return;
      event.preventDefault();
      setClosePrompt(true);
    }), () => disposed, value => { unlisten = value; });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [currentWindow]);

  const sendPendingAction = useCallback(async (reportError: boolean) => {
    const request = pendingActionRequestRef.current;
    if (!request || pendingActionRef.current === null) return;
    const requestKey = propertiesActionRequestKey(request);
    if (pendingActionSendKeyRef.current === requestKey) return;
    pendingActionSendKeyRef.current = requestKey;
    try {
      await sendPropertiesActionRequest(request);
    } catch (error) {
      // A rejected IPC promise does not prove that the host did not receive
      // the request. Keep the exact request pending so the idempotent host can
      // replay its result on the next attempt.
      if (reportError) setErrorMessage(errorText(error));
    } finally {
      if (pendingActionSendKeyRef.current === requestKey) {
        pendingActionSendKeyRef.current = null;
      }
    }
  }, []);

  const requestAction = useCallback(async (
    action: PropertiesAction,
    payload?: PropertiesActionRequest['payload'],
  ) => {
    if (!downloadId || pendingActionRef.current !== null) return;
    const requestId = nextPropertiesRequestId(requestIdRef.current);
    requestIdRef.current = requestId;
    pendingActionRef.current = action;
    setPendingAction(action);
    const request: PropertiesActionRequest = {
      windowLabel,
      downloadId,
      sessionId,
      requestId,
      action,
      payload,
    };
    pendingActionRequestRef.current = request;
    await sendPendingAction(true);
  }, [downloadId, sendPendingAction, sessionId, windowLabel]);

  useEffect(() => {
    if (pendingAction === null) return;
    const retryTimer = window.setInterval(() => {
      void sendPendingAction(false);
    }, 2500);
    return () => window.clearInterval(retryTimer);
  }, [pendingAction, sendPendingAction]);

  const updateSecretDraft = (name: SecretName, value: string) => {
    setSecretDrafts(current => ({
      ...current,
      [name]: { value, touched: true, clear: false },
    }));
    setDraftTab('advanced');
  };

  const clearSecretDraft = (name: SecretName) => {
    setSecretDrafts(current => ({
      ...current,
      [name]: { value: '', touched: true, clear: true },
    }));
    setDraftTab('advanced');
  };

  const applyActiveTab = useCallback(async () => {
    if (!snapshot || !isEditableStatus(snapshot.status)) {
      closeAfterSaveRef.current = false;
      switchAfterSaveRef.current = null;
      setErrorMessage(t($ => $.properties.editingUnavailable));
      return;
    }
    const patch: PropertiesPatch = {};
    if (activeTab === 'overview') {
      if (fileName !== snapshot.fileName) patch.fileName = fileName;
      if (destination !== (snapshot.destination ?? '')) patch.destination = destination || undefined;
      if (!isTorrent && connections.trim() && Number(connections) !== snapshot.connections) {
        patch.connections = Number(connections);
      }
    } else if (activeTab === 'files' && isTorrent) {
      const nextSelectedFiles = selectedFiles
        ?? fileProgress?.files.filter(file => file.selected).map(file => file.index)
        ?? [];
      if (!isTorrentFileSelectionEditable(snapshot.status)) {
        setErrorMessage(t($ => $.properties.editingUnavailable));
        closeAfterSaveRef.current = false;
        switchAfterSaveRef.current = null;
        return;
      }
      if (nextSelectedFiles.length === 0) {
        setErrorMessage(t($ => $.properties.torrentFileSelectionRequired));
        closeAfterSaveRef.current = false;
        switchAfterSaveRef.current = null;
        return;
      }
      await requestAction('set-torrent-file-selection', { selectedIndices: nextSelectedFiles });
      return;
    } else if (activeTab === 'trackers') {
      if (trackers !== (snapshot.torrentTrackers ?? '')) patch.torrentTrackers = trackers;
      if (excludedTrackers !== (snapshot.torrentExcludeTrackers ?? '')) patch.torrentExcludeTrackers = excludedTrackers;
      if (trackerConnectTimeout !== String(snapshot.torrentTrackerConnectTimeout ?? '')) {
        patch.torrentTrackerConnectTimeout = trackerConnectTimeout.trim() ? Number(trackerConnectTimeout) : undefined;
      }
      if (trackerTimeout !== String(snapshot.torrentTrackerTimeout ?? '')) {
        patch.torrentTrackerTimeout = trackerTimeout.trim() ? Number(trackerTimeout) : undefined;
      }
      if (trackerInterval !== String(snapshot.torrentTrackerInterval ?? '')) {
        patch.torrentTrackerInterval = trackerInterval.trim() ? Number(trackerInterval) : undefined;
      }
    } else if (activeTab === 'options' || activeTab === 'transfer') {
      if (downloadLimit !== (snapshot.speedLimit ?? '')) patch.speedLimit = downloadLimit;
      if (activeTab === 'transfer' && !isTorrent && connections.trim()) {
        const nextConnections = Number(connections);
        if (nextConnections !== snapshot.connections) patch.connections = nextConnections;
      }
      if (isTorrent) {
        if (removeUnselectedFile && (!snapshot.torrentFileIndices || snapshot.torrentFileIndices.length === 0)) {
          setErrorMessage(t($ => $.properties.torrentRemoveUnselectedFileSelectionRequired));
          closeAfterSaveRef.current = false;
          switchAfterSaveRef.current = null;
          return;
        }
        if (uploadLimit !== (snapshot.torrentUploadLimit ?? '')) patch.torrentUploadLimit = uploadLimit;
        if (maxPeers !== String(snapshot.torrentMaxPeers ?? '')) {
          patch.torrentMaxPeers = maxPeers.trim() ? Number(maxPeers) : undefined;
        }
        if (peerSpeedLimit !== (snapshot.torrentPeerSpeedLimit ?? '')) patch.torrentPeerSpeedLimit = peerSpeedLimit;
        if (seedTime !== String(snapshot.torrentSeedTime ?? '')) {
          patch.torrentSeedTime = seedTime.trim() ? Number(seedTime) : undefined;
        }
        if (seedRatio !== String(snapshot.torrentSeedRatio ?? '')) {
          patch.torrentSeedRatio = seedRatio.trim() ? Number(seedRatio) : undefined;
        }
        if (checkIntegrity !== (snapshot.torrentCheckIntegrity === true)) patch.torrentCheckIntegrity = checkIntegrity;
        if (removeUnselectedFile !== (snapshot.torrentRemoveUnselectedFile === true)) patch.torrentRemoveUnselectedFile = removeUnselectedFile;
        if (stopTimeout !== String(snapshot.torrentStopTimeout ?? '')) {
          patch.torrentStopTimeout = stopTimeout.trim() ? Number(stopTimeout) : undefined;
        }
        if (prioritizePiece !== (snapshot.torrentPrioritizePiece ?? '')) patch.torrentPrioritizePiece = prioritizePiece.trim() || undefined;
        const snapshotEncryptionPolicy = (snapshot.torrentEncryptionPolicy as TorrentEncryptionPolicy | undefined) ?? TORRENT_ENCRYPTION_POLICY_DISABLED;
        if (encryptionPolicy !== snapshotEncryptionPolicy) {
          patch.torrentEncryptionPolicy = encryptionPolicy === TORRENT_ENCRYPTION_POLICY_DISABLED ? undefined : encryptionPolicy;
        }
        if (fileAllocation !== ((snapshot.torrentFileAllocation as TorrentFileAllocation | undefined) ?? 'prealloc')) patch.torrentFileAllocation = fileAllocation;
      }
    } else if (activeTab === 'advanced') {
      for (const name of SECRET_NAMES) {
        const draft = secretDrafts[name];
        if (!draft.touched) continue;
        patch[name] = draft.clear ? { kind: 'clear' } : { kind: 'replace', value: draft.value };
      }
    }
    await requestAction('apply-properties', patch);
  }, [activeTab, checkIntegrity, connections, destination, downloadLimit, encryptionPolicy, excludedTrackers, fileAllocation, fileName, fileProgress, isTorrent, maxPeers, peerSpeedLimit, prioritizePiece, removeUnselectedFile, requestAction, secretDrafts, seedRatio, seedTime, selectedFiles, snapshot, stopTimeout, trackerConnectTimeout, trackerInterval, trackerTimeout, trackers, t, uploadLimit]);

  const chooseTab = (tab: PropertiesTab) => {
    if (tab === activeTab) return;
    if (isDirty) setPendingTab(tab);
    else setActiveTab(tab);
  };

  const discardDraft = () => {
    if (pendingActionRef.current !== null) return;
    const shouldClose = closePrompt;
    if (snapshot) hydrateDraft(snapshot);
    draftTabRef.current = null;
    setDraftTab(null);
    if (pendingTab) setActiveTab(pendingTab);
    setPendingTab(null);
    setClosePrompt(false);
    if (shouldClose) void closeCurrentWindow(true);
  };

  const closeWindow = async () => {
    if (isDirtyRef.current) {
      setClosePrompt(true);
      return;
    }
    await closeCurrentWindow();
  };

  const performTorrentAction = async (action: 'magnet' | 'export' | 'move' | 'verify') => {
    if (!downloadId) return;
    if (action === 'verify') {
      await requestAction('verify-torrent');
      return;
    }
    if (pendingTorrentCommand !== null) return;
    setPendingTorrentCommand(action);
    try {
      if (action === 'magnet') {
        await writeClipboardText(await invoke('get_torrent_magnet_link', { id: downloadId }));
        setNotice(t($ => $.properties.torrentMagnetCopied));
      } else if (action === 'export') {
        const destinationPath = await save({ defaultPath: `${snapshot?.fileName || 'download'}.torrent` });
        if (destinationPath) {
          await invoke('export_torrent_metadata', { id: downloadId, destination: destinationPath });
          setNotice(t($ => $.properties.torrentMetadataExported));
        }
      } else if (action === 'move') {
        const selected = await open({ directory: true, multiple: false });
        if (selected && typeof selected === 'string') {
          await invoke('move_torrent_data', { id: downloadId, destination: selected });
          setNotice(t($ => $.properties.torrentMoveCompleted));
        }
      }
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setPendingTorrentCommand(null);
    }
  };

  const windowChrome = snapshot?.windowChrome ?? windowChromeRef.current;
  const windowControlRevealOffset = getWindowControlRevealOffset(windowChrome.controlStyle);
  if (!downloadId || !snapshot) {
    return (
      <main
        className={`properties-window-shell properties-window-shell--controls-${windowChrome.side} flex h-screen min-h-0 flex-col bg-main-bg text-text-primary`}
        style={{ '--window-control-reveal-offset': `${windowControlRevealOffset}px` } as CSSProperties}
        aria-labelledby="properties-window-title"
      >
        <WindowControls side={windowChrome.side} controlStyle={windowChrome.controlStyle} />
        <div className="properties-window-titlebar" data-tauri-drag-region>
          <span id="properties-window-title" data-tauri-drag-region>{t($ => $.downloadTable.properties)} - Firelink</span>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center p-6" role="status">
          {errorMessage || t($ => $.app.loading)}
        </div>
      </main>
    );
  }

  const progress = Math.max(0, Math.min(1, snapshot.fraction ?? 0));
  const lifecycleAction = getPropertiesLifecycleAction(snapshot.status);
  const editingEnabled = pendingAction === null && isEditableStatus(snapshot.status);
  const footerActions = getPropertiesFooterActions({
    isDirty,
    hasUnsavedNavigation: pendingTab !== null || closePrompt,
  });
  const isPromptFooter = footerActions.includes('keepEditing');
  const fileSelectionEditingEnabled = editingEnabled && isTorrentFileSelectionEditable(snapshot.status);
  const total = snapshot.size || (snapshot.totalBytes === undefined
    ? t($ => $.addDownloads.unknownSize)
    : `${snapshot.totalIsEstimate ? '~' : ''}${formatDownloadBytes(snapshot.totalBytes)}`);
  const statusLabel = t($ => $.downloads.status[snapshot.status]);
  const connectionMetric = isTorrent
    ? String(snapshot.connectedPeers ?? '—')
    : snapshot.isMedia === true
      ? `${snapshot.connections ?? '—'} ${t($ => $.properties.configuredConcurrency)}`
      : `${snapshot.activeConnections ?? '—'} / ${snapshot.requestedConnections ?? snapshot.connections ?? '—'} ${t($ => $.properties.connections)}`;
  const queuePlacement = formatPropertiesQueuePlacement(
    snapshot.queueName,
    snapshot.queuePosition,
    position => t($ => $.properties.queuePosition, { position }),
  );
  const progressPercent = `${Math.round(progress * 100)}%`;
  const statusTone = propertiesStatusTone(snapshot.status);
  const lifecycleLabel = lifecycleAction === 'pause'
    ? t($ => $.downloads.actions.pause)
    : lifecycleAction === 'resume'
      ? t($ => $.downloads.actions.resume)
      : lifecycleAction === 'retry'
        ? t($ => $.downloads.actions.retry)
        : t($ => $.downloads.actions.start);
  const tabLabel = (tab: PropertiesTab) => {
    switch (tab) {
      case 'overview': return t($ => $.properties.details);
      case 'files': return t($ => $.properties.torrentFileProgress);
      case 'trackers': return t($ => $.properties.torrentTrackers);
      case 'peers': return t($ => $.properties.torrentPeerDiagnostics);
      case 'options': return t($ => $.downloads.actions.options);
      case 'transfer': return t($ => $.properties.connections);
      case 'advanced': return t($ => $.properties.advancedTransfer);
    }
  };

  return (
    <main
      className={`properties-window-shell properties-window-shell--controls-${windowChrome.side} flex h-screen min-h-0 flex-col bg-main-bg text-text-primary`}
      style={{ '--window-control-reveal-offset': `${windowControlRevealOffset}px` } as CSSProperties}
      aria-labelledby="properties-window-title"
    >
      <WindowControls side={windowChrome.side} controlStyle={windowChrome.controlStyle} />
      <div className="properties-window-titlebar" data-tauri-drag-region>
        <span data-tauri-drag-region>{snapshot.fileName} - {t($ => $.downloadTable.properties)} - Firelink</span>
      </div>
      <header className="properties-window-header shrink-0 border-b border-border-modal bg-sidebar-bg px-5 py-4">
        <div className="properties-window-hero-top">
          <div className="properties-window-title-block min-w-0">
            <div className="properties-window-title-line">
              <h1 id="properties-window-title" className="truncate text-base font-semibold" title={snapshot.fileName}>{snapshot.fileName}</h1>
              <span className={`properties-status-pill properties-status-${statusTone}`}>{statusLabel}</span>
            </div>
            <p className="properties-window-queue text-xs text-text-muted" title={queuePlacement}>{queuePlacement}</p>
          </div>
          <div className="properties-window-command-bar" aria-label={t($ => $.actions.continue)}>
            {lifecycleAction && <button
              type="button"
              className="app-button app-button-primary properties-primary-action px-3 text-xs"
              disabled={pendingAction !== null}
              title={lifecycleLabel}
              aria-label={lifecycleLabel}
              onClick={() => {
                if (lifecycleAction === 'pause'
                  && snapshot.resumable === false
                  && !window.confirm(t($ => $.downloadTable.nonResumableOne))) {
                  return;
                }
                void requestAction('pause-resume');
              }}
            >
              {lifecycleAction === 'pause' ? <Pause size={14} /> : <Play size={14} />}
              <span className="properties-command-label">{lifecycleLabel}</span>
            </button>}
            {isTorrent && <>
              <div className="properties-secondary-actions">
                <button type="button" className="app-button properties-command-button px-3 text-xs" disabled={pendingTorrentCommand === 'magnet'} onClick={() => void performTorrentAction('magnet')} title={t($ => $.properties.torrentCopyMagnet)}><Copy size={14} /><span className="properties-command-label">{t($ => $.properties.torrentCopyMagnet)}</span></button>
                <button type="button" className="app-button properties-command-button px-3 text-xs" disabled={pendingTorrentCommand === 'export'} onClick={() => void performTorrentAction('export')} title={t($ => $.properties.torrentExportMetadata)}><FileDown size={14} /><span className="properties-command-label">{t($ => $.properties.torrentExportMetadata)}</span></button>
                <button type="button" className="app-button properties-command-button px-3 text-xs" disabled={pendingTorrentCommand === 'move'} onClick={() => void performTorrentAction('move')} title={t($ => $.properties.torrentMove)}><FolderOpen size={14} /><span className="properties-command-label">{t($ => $.properties.torrentMove)}</span></button>
              </div>
              <details className="properties-command-overflow">
                <summary className="app-icon-button" title={t($ => $.downloads.actions.options)} aria-label={t($ => $.downloads.actions.options)}><MoreHorizontal size={16} /></summary>
                <div className="properties-command-menu">
                  <button type="button" disabled={pendingTorrentCommand === 'magnet'} onClick={() => void performTorrentAction('magnet')}><Copy size={14} />{t($ => $.properties.torrentCopyMagnet)}</button>
                  <button type="button" disabled={pendingTorrentCommand === 'export'} onClick={() => void performTorrentAction('export')}><FileDown size={14} />{t($ => $.properties.torrentExportMetadata)}</button>
                  <button type="button" disabled={pendingTorrentCommand === 'move'} onClick={() => void performTorrentAction('move')}><FolderOpen size={14} />{t($ => $.properties.torrentMove)}</button>
                </div>
              </details>
            </>}
          </div>
        </div>
        <div className="properties-window-progress-row" dir="ltr">
          <div className="properties-window-progress-track" aria-label={t($ => $.properties.progress)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <div className={`properties-window-progress-fill properties-progress-${statusTone}`} style={{ width: `${progress * 100}%` }} />
          </div>
          <span className="properties-window-progress-percent">{progressPercent}</span>
        </div>
        <div className="properties-window-metrics" dir="ltr">
          <div className="properties-metric-card"><Download size={14} /><div><span>{t($ => $.properties.size)}</span><strong>{formatDownloadBytes(snapshot.downloadedBytes ?? 0)} / {total}</strong></div></div>
          <div className="properties-metric-card"><Gauge size={14} /><div><span>{t($ => $.properties.speed)}</span><strong>{snapshot.speed || '—'}</strong></div></div>
          <div className="properties-metric-card"><Timer size={14} /><div><span>{t($ => $.properties.eta)}</span><strong>{snapshot.eta || '—'}</strong></div></div>
          <div className="properties-metric-card"><Users size={14} /><div><span>{isTorrent ? t($ => $.properties.torrentConnectedPeers) : t($ => $.properties.connections)}</span><strong>{connectionMetric}</strong></div></div>
          {isTorrent && <>
            <div className="properties-metric-card"><Upload size={14} /><div><span>{t($ => $.properties.torrentUploaded)}</span><strong>{formatDownloadBytes(snapshot.torrentUploadedBytes ?? 0)}</strong></div></div>
            <div className="properties-metric-card"><Activity size={14} /><div><span>{t($ => $.properties.torrentRatio)}</span><strong>{formatTorrentRatio(snapshot.torrentUploadedBytes ?? 0, snapshot.downloadedBytes ?? 0, 'en-US')}</strong></div></div>
          </>}
        </div>
        <div className="properties-window-destination" title={snapshot.destination || undefined}><MapPin size={13} /><span>{snapshot.destination || '—'}</span></div>
      </header>

      <nav className="properties-window-tabs flex shrink-0 gap-1 overflow-x-auto border-b border-border-modal px-4" role="tablist" aria-label={t($ => $.downloadTable.properties)}>
        {tabs.map(tab => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`properties-panel-${tab}`}
            tabIndex={activeTab === tab ? 0 : -1}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium ${activeTab === tab ? 'border-accent text-text-primary' : 'border-transparent text-text-muted hover:text-text-primary'}`}
            onClick={() => chooseTab(tab)}
            onKeyDown={event => {
              const index = tabs.indexOf(tab);
              const nextIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
              if (nextIndex >= 0) {
                event.preventDefault();
                const next = tabs[nextIndex];
                chooseTab(next);
                window.setTimeout(() => document.getElementById(`properties-tab-${next}`)?.focus(), 0);
              }
            }}
            id={`properties-tab-${tab}`}
          >{tabLabel(tab)}</button>
        ))}
      </nav>

      <section id={`properties-panel-${activeTab}`} role="tabpanel" aria-labelledby={`properties-tab-${activeTab}`} className="properties-window-panel min-h-0 flex-1 overflow-auto p-5" data-diagnostic-phase={diagnosticPhase} tabIndex={0}>
        {activeTab === 'overview' && <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-text-muted">{t($ => $.properties.fileName)}<input className="app-control mt-1 w-full" value={fileName} onChange={event => { setFileName(event.target.value); setDraftTab('overview'); }} disabled={!editingEnabled} /></label>
            <label className="text-xs text-text-muted">{t($ => $.properties.destination)}<input className="app-control mt-1 w-full" value={destination} onChange={event => { setDestination(event.target.value); setDraftTab('overview'); }} disabled={!editingEnabled} /></label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs"><span className="text-text-muted">{t($ => $.properties.url)}</span><p className="mt-1 break-all" dir="ltr">{snapshot.url}</p></div>
            <div className="rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs"><span className="text-text-muted">{t($ => $.properties.category)}</span><p className="mt-1">{snapshot.category}</p></div>
          </div>
          <div className="grid gap-2 rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs sm:grid-cols-2">
            <span className="text-text-muted">{t($ => $.properties.dateAdded)}</span><span dir="ltr">{snapshot.dateAdded || '—'}</span>
            <span className="text-text-muted">{t($ => $.properties.lastTry)}</span><span dir="ltr">{snapshot.lastTry || '—'}</span>
            <span className="text-text-muted">{t($ => $.properties.queueId)}</span><span title={queuePlacement}>{queuePlacement}</span>
            <span className="text-text-muted">{t($ => $.properties.resumable)}</span><span>{snapshot.resumable === false ? '—' : '✓'}</span>
            {snapshot.lastError && <>
              <span className="text-text-muted">{t($ => $.properties.lastError)}</span>
              <div className="space-y-1 break-words text-red-300">
                {snapshot.lastErrorKind === 'nameResolution' && (
                  <p className="font-medium text-text-primary">
                    {snapshot.status === 'retrying'
                      ? snapshot.lastResolverFallback === true
                        ? t($ => $.downloads.errors.nameResolutionRetrying)
                        : t($ => $.downloads.status.retrying)
                      : t($ => $.downloads.errors.nameResolutionFailed)}
                  </p>
                )}
                <span>{snapshot.lastError}</span>
              </div>
            </>}
          </div>
          {snapshot.isMedia === true && <div className="grid gap-2 rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs sm:grid-cols-2">
            <span className="text-text-muted">{t($ => $.addDownloads.format)}</span><span className="break-all font-mono">{snapshot.mediaFormatSelector || '—'}</span>
            <span className="text-text-muted">{t($ => $.addDownloads.quality)}</span><span>{snapshot.mediaQuality || '—'}</span>
            <span className="text-text-muted">{t($ => $.properties.configuredConcurrency)}</span><span>{snapshot.connections ?? '—'}</span>
          </div>}
          {isTorrent && details && <div className="grid gap-2 rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs sm:grid-cols-2">
            <span className="text-text-muted">{t($ => $.properties.torrentDetailsDisplayName)}</span><span>{details.displayName || '—'}</span>
            <span className="text-text-muted">{t($ => $.properties.torrentDetailsInfoHash)}</span><span className="font-mono break-all">{details.infoHash}</span>
            <span className="text-text-muted">{t($ => $.properties.torrentDetailsSize)}</span><span>{formatDownloadBytes(details.totalBytes)}</span>
            <span className="text-text-muted">{t($ => $.properties.torrentDetailsFiles)}</span><span>{details.fileCount}</span>
            <span className="text-text-muted">{t($ => $.properties.torrentDetailsPieces)}</span><span>{details.pieceCount} × {formatDownloadBytes(details.pieceLength)}</span>
            <span className="text-text-muted">{t($ => $.properties.torrentDetailsPrivate)}</span><span>{details.private ? t($ => $.properties.torrentDetailsPrivateYes) : t($ => $.properties.torrentDetailsPrivateNo)}</span>
            <span className="text-text-muted">{t($ => $.properties.torrentDetailsCreated)}</span><span>{details.creationDate || '—'}</span>
            <span className="text-text-muted">{t($ => $.properties.torrentDetailsCreator)}</span><span>{details.creator || '—'}</span>
            <span className="text-text-muted">{t($ => $.properties.torrentDetailsComment)}</span><span className="break-words">{details.comment || '—'}</span>
          </div>}
          {isTorrent && <div className="flex flex-wrap gap-2"><button type="button" className="app-button px-3 text-xs" disabled={pendingAction !== null || !['paused', 'completed', 'failed'].includes(snapshot.status)} onClick={() => void performTorrentAction('verify')}><RefreshCw size={14} />{t($ => $.properties.torrentVerifyNow)}</button></div>}
        </div>}

        {activeTab === 'files' && isTorrent && <div className="space-y-3">
          <div className="flex flex-wrap gap-2"><button type="button" className="app-button px-3 text-xs" disabled={!fileSelectionEditingEnabled} onClick={() => { const all = fileProgress?.files.map(file => file.index) ?? []; setSelectedFiles(all); setDraftTab('files'); }}>{t($ => $.properties.torrentFileSelectionAll)}</button><button type="button" className="app-button px-3 text-xs" disabled={!fileSelectionEditingEnabled} onClick={() => { setSelectedFiles([]); setDraftTab('files'); }}>{t($ => $.properties.torrentFileSelectionClear)}</button><button type="button" className="app-button px-3 text-xs" aria-busy={diagnosticsLoading || diagnosticsRefreshing} onClick={() => downloadId && void refreshDiagnostics('files', downloadId, true)}><RefreshCw size={14} className={diagnosticsLoading || diagnosticsRefreshing ? 'animate-spin motion-reduce:animate-none' : undefined} />{t($ => $.properties.torrentFileProgressRefresh)}</button></div>
          <div className="overflow-auto rounded-lg border border-border-modal"><table className="w-full min-w-[640px] text-xs" dir="ltr"><thead className="sticky top-0 bg-sidebar-bg text-left text-text-muted"><tr><th className="p-2">{t($ => $.properties.torrentFileProgressSelected)}</th><th className="p-2">#</th><th className="p-2">{t($ => $.properties.torrentFileProgressPath)}</th><th className="p-2">{t($ => $.properties.size)}</th><th className="p-2">{t($ => $.properties.torrentFileProgressCompleted)}</th></tr></thead><tbody>{fileProgress?.files.map(file => { const checked = selectedFiles === null ? file.selected : selectedFiles.includes(file.index); return <tr key={file.index} className="border-t border-border-modal/60"><td className="p-2"><input type="checkbox" checked={checked} disabled={!fileSelectionEditingEnabled} onChange={() => { const current = selectedFiles ?? fileProgress.files.filter(candidate => candidate.selected).map(candidate => candidate.index); const next = checked ? current.filter(index => index !== file.index) : [...current, file.index]; setSelectedFiles(next); setDraftTab('files'); }} aria-label={`${file.index + 1} ${file.relativePath}`} /></td><td className="p-2">{file.index + 1}</td><td className="max-w-[420px] truncate p-2" dir="auto">{file.relativePath}</td><td className="p-2">{formatDownloadBytes(file.length)}</td><td className="p-2">{formatDownloadBytes(file.completedLength)} ({file.length ? Math.round(file.completedLength / file.length * 100) : 0}%)</td></tr>; })}</tbody></table></div>
          {diagnosticPhase === 'initial' && diagnosticsLoading && !fileProgress && <p className="text-xs text-text-muted">{t($ => $.properties.torrentFileProgressLoading)}</p>}
          {diagnosticPhase === 'unavailable' && !fileProgress && !diagnosticError && <p className="text-xs text-text-muted">{t($ => $.properties.torrentFileProgressUnavailable)}</p>}
          {diagnosticError && <p className="text-xs text-red-400" role="alert">{diagnosticError}</p>}
        </div>}

        {activeTab === 'trackers' && isTorrent && <div className="space-y-4">
          <label className="block text-xs text-text-muted">{t($ => $.properties.torrentTrackers)}<textarea className="app-control mt-1 min-h-28 w-full font-mono" value={trackers} disabled={!editingEnabled} onChange={event => { setTrackers(event.target.value); setDraftTab('trackers'); }} /></label>
          <label className="block text-xs text-text-muted">{t($ => $.properties.torrentExcludeTrackers)}<textarea className="app-control mt-1 min-h-28 w-full font-mono" value={excludedTrackers} disabled={!editingEnabled} onChange={event => { setExcludedTrackers(event.target.value); setDraftTab('trackers'); }} /></label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-text-muted">{t($ => $.properties.torrentTrackerConnectTimeout)}<input className="app-control mt-1 w-full" value={trackerConnectTimeout} disabled={!editingEnabled} onChange={event => { setTrackerConnectTimeout(event.target.value); setDraftTab('trackers'); }} inputMode="numeric" placeholder="60" /></label>
            <label className="text-xs text-text-muted">{t($ => $.properties.torrentTrackerTimeout)}<input className="app-control mt-1 w-full" value={trackerTimeout} disabled={!editingEnabled} onChange={event => { setTrackerTimeout(event.target.value); setDraftTab('trackers'); }} inputMode="numeric" placeholder="60" /></label>
            <label className="text-xs text-text-muted">{t($ => $.properties.torrentTrackerInterval)}<input className="app-control mt-1 w-full" value={trackerInterval} disabled={!editingEnabled} onChange={event => { setTrackerInterval(event.target.value); setDraftTab('trackers'); }} inputMode="numeric" placeholder="0" /></label>
          </div>
          <p className="text-xs text-text-muted">{t($ => $.properties.torrentTrackersHint)}</p>
          {details && <div className="rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs"><strong>{t($ => $.properties.torrentDetailsTrackers)}</strong><p className="mt-1 break-words" dir="auto">{details.trackers.join(', ') || '—'}</p></div>}
        </div>}

        {activeTab === 'peers' && isTorrent && <div className="space-y-4">
          <div className="flex items-center justify-between"><p className="text-sm">{peers ? t($ => $.properties.torrentPeerCount, { total: peers.totalPeers, seeders: peers.totalSeeders }) : diagnosticsLoading ? t($ => $.properties.torrentPeerDiagnosticsLoading) : t($ => $.properties.torrentPeerDiagnosticsUnavailable)}</p><button type="button" className="app-button px-3 text-xs" aria-busy={diagnosticsLoading || diagnosticsRefreshing} onClick={() => downloadId && void refreshDiagnostics('peers', downloadId, true)}><RefreshCw size={14} className={diagnosticsLoading || diagnosticsRefreshing ? 'animate-spin motion-reduce:animate-none' : undefined} />{t($ => $.properties.torrentPeerDiagnosticsRefresh)}</button></div>
          <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs"><span className="text-text-muted">{t($ => $.properties.torrentAvailability)}</span><p className="mt-1">{availability ? `${availability.availability} · ${availability.pieceCount} ${t($ => $.properties.torrentDetailsPieces)}` : '—'}</p></div><div className="rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs"><span className="text-text-muted">{t($ => $.properties.torrentPeerDiagnosticsHint)}</span><p className="mt-1">{peers?.truncated ? t($ => $.properties.torrentPeerShowing, { shown: peers.peers.length, total: peers.totalPeers }) : peers?.peers.length ?? 0}</p></div></div>
          <div className="overflow-auto rounded-lg border border-border-modal"><table className="w-full min-w-[640px] text-xs" dir="ltr"><thead className="bg-sidebar-bg text-left text-text-muted"><tr><th className="p-2">{t($ => $.properties.torrentPeerAddress)}</th><th className="p-2">{t($ => $.properties.torrentPeerDownload)}</th><th className="p-2">{t($ => $.properties.torrentPeerUpload)}</th><th className="p-2">{t($ => $.properties.torrentPeerSeeder)}</th><th className="p-2">{t($ => $.properties.torrentPeerChoking)}</th></tr></thead><tbody>{peers?.peers.map((peer, index) => <tr key={`${peer.ip ?? 'peer'}-${peer.port ?? 'unknown'}-${index}`} className="border-t border-border-modal/60"><td className="p-2 font-mono">{peer.ip ? `${peer.ip.includes(':') ? `[${peer.ip}]` : peer.ip}${peer.port == null ? '' : `:${peer.port}`}` : '—'}</td><td className="p-2">{formatDownloadBytes(peer.downloadSpeed)}/s</td><td className="p-2">{formatDownloadBytes(peer.uploadSpeed)}/s</td><td className="p-2">{peer.seeder ? '✓' : '—'}</td><td className="p-2">{peer.peerChoking ? '✓' : '—'}</td></tr>)}</tbody></table></div>
          {diagnosticError && <p className="text-xs text-red-400" role="alert">{diagnosticError}</p>}
        </div>}

        {activeTab === 'transfer' && <div className="space-y-4">
          <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
            <label className="text-xs text-text-muted">{t($ => $.properties.speedCap)}<input className="app-control mt-1 w-full" value={downloadLimit} onChange={event => { setDownloadLimit(event.target.value); setDraftTab('transfer'); }} placeholder="1024K" disabled={!editingEnabled} /></label>
            <div className="rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs"><span className="text-text-muted">{snapshot.isMedia === true ? t($ => $.properties.configuredConcurrency) : t($ => $.properties.connections)}</span><p className="mt-1">{snapshot.isMedia === true ? snapshot.connections ?? '—' : `${snapshot.activeConnections ?? '—'} / ${snapshot.requestedConnections ?? snapshot.connections ?? '—'}`}</p></div>
          </div>
          <label className="block max-w-2xl text-xs text-text-muted">{snapshot.isMedia === true ? t($ => $.properties.configuredConcurrency) : t($ => $.properties.connections)}<div className="mt-2 flex items-center gap-3"><input type="range" min="1" max="16" value={connections || '1'} onChange={event => { setConnections(event.target.value); setDraftTab('transfer'); }} disabled={!editingEnabled} className="min-w-0 flex-1 accent-blue-500" aria-label={t($ => $.properties.connections)} /><span className="w-8 text-center font-mono text-text-primary">{connections || '1'}</span></div></label>
          <p className="text-xs text-text-muted">{t($ => $.properties.transferSettings)}</p>
        </div>}

        {activeTab === 'options' && isTorrent && <div className="space-y-5 text-xs">
          <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
            <label className="text-text-muted">{t($ => $.properties.speedCap)}<input className="app-control mt-1 w-full" value={downloadLimit} onChange={event => { setDownloadLimit(event.target.value); setDraftTab('options'); }} placeholder="1024K" disabled={!editingEnabled} /></label>
            <label className="text-text-muted">{t($ => $.properties.liveTorrentUploadLimit)}<input className="app-control mt-1 w-full" value={uploadLimit} onChange={event => { setUploadLimit(event.target.value); setDraftTab('options'); }} placeholder="1024K" disabled={!editingEnabled} /></label>
            <label className="text-text-muted">{t($ => $.properties.torrentMaxPeers)}<input className="app-control mt-1 w-full" value={maxPeers} onChange={event => { setMaxPeers(event.target.value); setDraftTab('options'); }} inputMode="numeric" placeholder={String(propertiesTorrentPeerLimit(undefined))} disabled={!editingEnabled} /></label>
            <label className="text-text-muted">{t($ => $.properties.torrentPeerSpeedLimit)}<input className="app-control mt-1 w-full" value={peerSpeedLimit} onChange={event => { setPeerSpeedLimit(event.target.value); setDraftTab('options'); }} placeholder="50K" disabled={!editingEnabled} /></label>
            <label className="text-text-muted">{t($ => $.addDownloads.seedTime)}<input className="app-control mt-1 w-full" value={seedTime} onChange={event => { setSeedTime(event.target.value); setDraftTab('options'); }} inputMode="decimal" placeholder={t($ => $.properties.defaultValue)} disabled={!editingEnabled} /></label>
            <label className="text-text-muted">{t($ => $.addDownloads.seedRatio)}<input className="app-control mt-1 w-full" value={seedRatio} onChange={event => { setSeedRatio(event.target.value); setDraftTab('options'); }} inputMode="decimal" placeholder="0" disabled={!editingEnabled} /></label>
            <label className="text-text-muted">{t($ => $.properties.torrentStopTimeout)}<input className="app-control mt-1 w-full" value={stopTimeout} onChange={event => { setStopTimeout(event.target.value); setDraftTab('options'); }} inputMode="numeric" placeholder="0" disabled={!editingEnabled} /></label>
            <label className="text-text-muted">{t($ => $.properties.torrentPrioritizePiece)}<input className="app-control mt-1 w-full" value={prioritizePiece} onChange={event => { setPrioritizePiece(event.target.value); setDraftTab('options'); }} placeholder="head=1M,tail=1M" disabled={!editingEnabled} /></label>
          </div>
          <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2"><input type="checkbox" checked={checkIntegrity} onChange={event => { setCheckIntegrity(event.target.checked); setDraftTab('options'); }} disabled={!editingEnabled} />{t($ => $.properties.torrentVerifyIntegrity)}</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={removeUnselectedFile} onChange={event => { setRemoveUnselectedFile(event.target.checked); setDraftTab('options'); }} disabled={!editingEnabled || (!removeUnselectedFile && (!snapshot.torrentFileIndices || snapshot.torrentFileIndices.length === 0))} />{t($ => $.properties.torrentRemoveUnselectedFile)}</label>
            <label className="flex items-center gap-2 text-text-muted">{t($ => $.properties.torrentFileAllocation)}<select className="app-control" value={fileAllocation} onChange={event => { setFileAllocation(event.target.value as TorrentFileAllocation); setDraftTab('options'); }} disabled={!editingEnabled}><option value="prealloc">{t($ => $.properties.torrentFileAllocationPrealloc)}</option><option value="none">{t($ => $.properties.torrentFileAllocationNone)}</option></select></label>
            <label className="flex items-center gap-2 text-text-muted">{t($ => $.properties.torrentEncryptionPolicy)}<select className="app-control" value={encryptionPolicy} onChange={event => { setEncryptionPolicy(event.target.value as TorrentEncryptionPolicy); setDraftTab('options'); }} disabled={!editingEnabled}><option value={TORRENT_ENCRYPTION_POLICY_DISABLED}>{t($ => $.properties.torrentEncryptionDisabled)}</option><option value={TORRENT_ENCRYPTION_POLICY_REQUIRE_CRYPTO}>{t($ => $.properties.torrentEncryptionRequireCrypto)}</option><option value={TORRENT_ENCRYPTION_POLICY_FORCE_ENCRYPTION}>{t($ => $.properties.torrentEncryptionForceEncryption)}</option></select></label>
          </div>
          <p className="max-w-3xl text-text-muted">{t($ => $.properties.torrentPeerOptionsSavedHint)}</p>
        </div>}

        {activeTab === 'advanced' && <div className="space-y-4">
          <p className="text-xs text-text-muted">{t($ => $.properties.advancedTransfer)}</p>
          <div className="grid max-w-2xl gap-3 rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs sm:grid-cols-2">
            <div><span className="text-text-muted">{t($ => $.properties.connections)}</span><p className="mt-1">{snapshot.isMedia === true ? `${snapshot.connections ?? '—'} ${t($ => $.properties.configuredConcurrency)}` : `${snapshot.activeConnections ?? '—'} / ${snapshot.requestedConnections ?? snapshot.connections ?? '—'}`}</p></div>
            <div><span className="text-text-muted">{t($ => $.properties.speedCap)}</span><p className="mt-1">{snapshot.speedLimit || '—'}</p></div>
            <div><span className="text-text-muted">{t($ => $.properties.username)}</span><p className="mt-1">{snapshot.hasUsername ? '✓' : '—'}</p></div>
            <div><span className="text-text-muted">{t($ => $.properties.password)}</span><p className="mt-1">{snapshot.hasPassword ? '✓' : '—'}</p></div>
            <div><span className="text-text-muted">{t($ => $.properties.cookies)}</span><p className="mt-1">{snapshot.hasCookies ? '✓' : '—'}</p></div>
            <div><span className="text-text-muted">{t($ => $.properties.headers)}</span><p className="mt-1">{snapshot.hasHeaders ? '✓' : '—'}</p></div>
          </div>
          <div className="grid max-w-2xl gap-3 text-xs">
            {(['username', 'password'] as const).map(name => <label key={name} className="text-text-muted">{t($ => $.properties[name])}<div className="mt-1 flex gap-2"><input className="app-control min-w-0 flex-1" type={name === 'password' ? 'password' : 'text'} value={secretDrafts[name].value} placeholder={snapshot[name === 'username' ? 'hasUsername' : 'hasPassword'] ? '••••••' : ''} onChange={event => updateSecretDraft(name, event.target.value)} disabled={!editingEnabled} /><button type="button" className="app-button shrink-0 px-2 text-xs" onClick={() => clearSecretDraft(name)} disabled={!editingEnabled}>{t($ => $.properties.clear)}</button></div></label>)}
            {(['cookies', 'headers'] as const).map(name => <label key={name} className="text-text-muted">{t($ => $.properties[name])}<div className="mt-1 flex gap-2"><textarea className="app-control min-w-0 flex-1" value={secretDrafts[name].value} placeholder={snapshot[name === 'cookies' ? 'hasCookies' : 'hasHeaders'] ? '••••••' : ''} onChange={event => updateSecretDraft(name, event.target.value)} disabled={!editingEnabled} /><button type="button" className="app-button h-fit shrink-0 px-2 text-xs" onClick={() => clearSecretDraft(name)} disabled={!editingEnabled}>{t($ => $.properties.clear)}</button></div></label>)}
          </div>
          <p className="text-xs text-text-muted">{t($ => $.properties.transferSettings)}</p>
        </div>}
      </section>

      {(isDirty || errorMessage || notice || pendingTab || closePrompt) && <div className="shrink-0 border-t border-border-modal bg-sidebar-bg px-4 py-2" aria-live="polite">
        {isPromptFooter ? <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span>{t($ => $.scheduler.unsavedChanges)}</span><div className="flex gap-2"><button type="button" className="app-button px-3 text-xs" disabled={pendingAction !== null} onClick={discardDraft}>{t($ => $.properties.discardChanges)}</button><button type="button" className="app-button app-button-primary px-3 text-xs" disabled={pendingAction !== null} onClick={() => { closeAfterSaveRef.current = closePrompt; switchAfterSaveRef.current = pendingTab; void applyActiveTab(); }}>{t($ => $.properties.save)}</button><button type="button" className="app-button px-3 text-xs" onClick={() => { switchAfterSaveRef.current = null; closeAfterSaveRef.current = false; setPendingTab(null); setClosePrompt(false); }}>{t($ => $.properties.keepEditing)}</button></div></div> : <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className={errorMessage ? 'text-red-400' : 'text-text-muted'}>{errorMessage || notice}</span><div className="flex gap-2">{footerActions.includes('discardChanges') && <><button type="button" className="app-button px-3 text-xs" disabled={pendingAction !== null} onClick={discardDraft}>{t($ => $.properties.discardChanges)}</button><button type="button" className="app-button app-button-primary px-3 text-xs" disabled={pendingAction !== null} onClick={() => void applyActiveTab()}><Save size={14} />{t($ => $.properties.save)}</button></>}<button type="button" className="app-button px-3 text-xs" onClick={() => void closeWindow()}><X size={14} />{t($ => $.window.close)}</button></div></div>}
      </div>}
    </main>
  );
};

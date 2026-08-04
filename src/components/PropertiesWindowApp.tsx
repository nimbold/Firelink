import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Copy, FileDown, FolderOpen, Pause, Play, RefreshCw, Save, X } from 'lucide-react';
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
  getPropertiesLifecycleAction,
  sendPropertiesActionRequest,
  sendPropertiesReady,
  isExpectedPropertiesDiagnosticUnavailable,
  type PropertiesAction,
  type PropertiesActionRequest,
  type PropertiesActionResult,
  type PropertiesPatch,
  type PropertiesSnapshot,
  type PropertiesSnapshotEvent,
} from '../propertiesBridge';
import { formatDownloadBytes, formatTorrentRatio } from '../utils/downloadProgress';
import { changeAppLocale } from '../i18n';
import { synchronizeDocumentAppearance } from '../utils/documentAppearance';

type PropertiesTab = 'overview' | 'files' | 'trackers' | 'peers' | 'options' | 'transfer' | 'advanced';

const isTorrentDiagnosticsStatus = (status: string) =>
  ['downloading', 'verifying', 'seeding', 'waitingToSeed', 'retrying', 'paused', 'completed'].includes(status);

const isTorrentPollingStatus = (status: string) =>
  ['downloading', 'verifying', 'seeding', 'waitingToSeed', 'retrying', 'paused'].includes(status);

const isEditableStatus = (status: string) => !['downloading', 'processing', 'verifying', 'seeding', 'retrying', 'moving'].includes(status);

const safeTitle = (name: string) => {
  const bounded = name.replace(/[\r\n\u0000]/g, ' ').trim().slice(0, 160);
  return `${bounded || 'Download'} - Properties - Firelink`;
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

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
  const [isSaving, setIsSaving] = useState(false);
  const [fileProgress, setFileProgress] = useState<TorrentFileProgressSnapshot | null>(null);
  const [peers, setPeers] = useState<TorrentPeerDiagnostics | null>(null);
  const [availability, setAvailability] = useState<TorrentAvailabilitySnapshot | null>(null);
  const [details, setDetails] = useState<TorrentDetails | null>(null);
  const [diagnosticError, setDiagnosticError] = useState('');
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
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
  const [draftTab, setDraftTab] = useState<PropertiesTab | null>(null);
  const draftTabRef = useRef<PropertiesTab | null>(null);
  const closeAfterSaveRef = useRef(false);
  const switchAfterSaveRef = useRef<PropertiesTab | null>(null);
  const requestIdRef = useRef(0);
  const pendingActionRef = useRef<PropertiesAction | null>(null);
  const latestSnapshotRevisionRef = useRef(0);
  const appearanceCleanupRef = useRef<(() => void) | null>(null);
  const hasRevealedWindowRef = useRef(false);
  const revealInFlightRef = useRef(false);
  const diagnosticsInFlightRef = useRef(new Set<string>());
  const snapshotRef = useRef(snapshot);
  const activeTabRef = useRef(activeTab);
  const downloadIdRef = useRef(downloadId);
  snapshotRef.current = snapshot;
  activeTabRef.current = activeTab;
  downloadIdRef.current = downloadId;

  const isTorrent = snapshot?.isTorrent === true;
  const tabs = useMemo<PropertiesTab[]>(() => isTorrent
    ? ['overview', 'files', 'trackers', 'peers', 'options']
    : ['overview', 'transfer', 'advanced'], [isTorrent]);
  const isDirty = draftTab !== null;

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
  }, []);

  const refreshDiagnostics = useCallback(async (tab: PropertiesTab, id: string) => {
    if (!isTorrentDiagnosticsStatus(snapshotRef.current?.status ?? '')) return;
    const requestKey = `${id}:${tab}`;
    if (diagnosticsInFlightRef.current.has(requestKey)) return;
    diagnosticsInFlightRef.current.add(requestKey);
    const isCurrent = () => downloadIdRef.current === id
      && activeTabRef.current === tab
      && isTorrentDiagnosticsStatus(snapshotRef.current?.status ?? '');
    if (isCurrent()) {
      setDiagnosticError('');
      setDiagnosticsLoading(true);
    }
    try {
      if (tab === 'overview') {
        const nextDetails = await invoke('get_torrent_details', { id });
        if (isCurrent()) setDetails(nextDetails);
      } else if (tab === 'files') {
        const nextProgress = await invoke('get_torrent_file_progress', { id });
        if (isCurrent()) setFileProgress(nextProgress);
      } else if (tab === 'peers') {
        const [peerResult, availabilityResult] = await Promise.allSettled([
          invoke('get_torrent_peers', { id }),
          invoke('get_torrent_availability', { id }),
        ]);
        if (isCurrent()) {
          if (peerResult.status === 'fulfilled') setPeers(peerResult.value);
          else setPeers(null);
          if (availabilityResult.status === 'fulfilled') setAvailability(availabilityResult.value);
          else setAvailability(null);
          const unexpectedErrors = [peerResult, availabilityResult]
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map(result => result.reason)
            .filter(error => !isExpectedPropertiesDiagnosticUnavailable(error));
          setDiagnosticError(unexpectedErrors.length > 0 ? errorText(unexpectedErrors[0]) : '');
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
          if (tab === 'files') setFileProgress(null);
          if (tab === 'peers') {
            setPeers(null);
            setAvailability(null);
          }
        } else {
          setDiagnosticError(message);
        }
      }
    } finally {
      diagnosticsInFlightRef.current.delete(requestKey);
      if (downloadIdRef.current === id && activeTabRef.current === tab) {
        setDiagnosticsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let readyRetryTimer: number | undefined;
    let unlistenSnapshot: UnlistenFn | undefined;
    let unlistenResult: UnlistenFn | undefined;
    let unlistenRemoved: UnlistenFn | undefined;
    const start = async () => {
      try {
        const id = await invoke('get_properties_window_download_id');
        if (cancelled) return;
        setDownloadId(id);
        const snapshotListener = await listen<PropertiesSnapshotEvent>(PROPERTIES_WINDOW_SNAPSHOT, async event => {
          if (event.payload.windowLabel !== windowLabel
            || event.payload.downloadId !== id
            || event.payload.sessionId !== sessionId) return;
          if (event.payload.revision <= latestSnapshotRevisionRef.current) return;
          latestSnapshotRevisionRef.current = event.payload.revision;
          await changeAppLocale(event.payload.snapshot.appearance.locale);
          if (event.payload.revision !== latestSnapshotRevisionRef.current) return;
          appearanceCleanupRef.current?.();
          appearanceCleanupRef.current = synchronizeDocumentAppearance(
            window,
            event.payload.snapshot.appearance,
          );
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
          if (event.payload.windowLabel !== windowLabel
            || event.payload.downloadId !== id
            || event.payload.sessionId !== sessionId) return;
          if (event.payload.requestId !== requestIdRef.current) return;
          setIsSaving(false);
          const completedAction = pendingActionRef.current;
          pendingActionRef.current = null;
          if (!event.payload.ok) setErrorMessage(event.payload.error ?? 'The action failed');
          else {
            const nextTab = switchAfterSaveRef.current;
            const shouldClose = closeAfterSaveRef.current;
            switchAfterSaveRef.current = null;
            closeAfterSaveRef.current = false;
            setErrorMessage('');
            setNotice(completedAction === 'apply-properties' ? t($ => $.properties.saved) : '');
            draftTabRef.current = null;
            setDraftTab(null);
            if (nextTab) {
              setActiveTab(nextTab);
              setPendingTab(null);
            }
            if (shouldClose) {
              setClosePrompt(false);
              void currentWindow.close().catch(error => setErrorMessage(errorText(error)));
            }
          }
        });
        if (cancelled) {
          resultListener();
          return;
        }
        unlistenResult = resultListener;
        const removedListener = await listen<{ windowLabel: string; downloadId: string }>(PROPERTIES_WINDOW_REMOVED, event => {
          if (event.payload.windowLabel === windowLabel && event.payload.downloadId === id) {
            if (readyRetryTimer !== undefined) {
              window.clearInterval(readyRetryTimer);
              readyRetryTimer = undefined;
            }
            setSnapshot(null);
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
      } catch (error) {
        if (!cancelled) setErrorMessage(errorText(error));
      }
    };
    void start();
    return () => {
      cancelled = true;
      if (readyRetryTimer !== undefined) window.clearInterval(readyRetryTimer);
      unlistenSnapshot?.();
      unlistenResult?.();
      unlistenRemoved?.();
      appearanceCleanupRef.current?.();
      appearanceCleanupRef.current = null;
    };
  }, [currentWindow, hydrateDraft, sessionId, t, windowLabel]);

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
      return;
    }
    if (!isTorrentPollingStatus(snapshot.status)) {
      setFileProgress(null);
      setPeers(null);
      setAvailability(null);
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
    if (!isDirty) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    attachAsyncPropertiesListener(currentWindow.onCloseRequested(event => {
      event.preventDefault();
      setClosePrompt(true);
    }), () => disposed, value => { unlisten = value; });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [currentWindow, isDirty]);

  const requestAction = useCallback(async (
    action: PropertiesAction,
    payload?: PropertiesActionRequest['payload'],
  ) => {
    if (!downloadId) return;
    if (pendingActionRef.current !== null) return;
    const requestId = ++requestIdRef.current;
    pendingActionRef.current = action;
    setIsSaving(true);
    try {
      await sendPropertiesActionRequest({
        windowLabel,
        downloadId,
        sessionId,
        requestId,
        action,
        payload,
      });
    } catch (error) {
      setIsSaving(false);
      pendingActionRef.current = null;
      closeAfterSaveRef.current = false;
      switchAfterSaveRef.current = null;
      setErrorMessage(errorText(error));
    }
  }, [downloadId, sessionId, windowLabel]);

  const applyActiveTab = useCallback(async () => {
    if (!snapshot || !isEditableStatus(snapshot.status)) {
      closeAfterSaveRef.current = false;
      switchAfterSaveRef.current = null;
      setErrorMessage(t($ => $.properties.editingUnavailable));
      return;
    }
    const patch: PropertiesPatch = {};
    if (activeTab === 'overview') {
      patch.fileName = fileName;
      patch.destination = destination || undefined;
      if (connections.trim()) patch.connections = Number(connections);
    } else if (activeTab === 'files' && isTorrent) {
      const nextSelectedFiles = selectedFiles
        ?? fileProgress?.files.filter(file => file.selected).map(file => file.index)
        ?? [];
      if (nextSelectedFiles.length === 0) {
        setErrorMessage(t($ => $.properties.torrentFileSelectionRequired));
        closeAfterSaveRef.current = false;
        switchAfterSaveRef.current = null;
        return;
      }
      patch.torrentFileIndices = nextSelectedFiles;
    } else if (activeTab === 'trackers') {
      patch.torrentTrackers = trackers;
      patch.torrentExcludeTrackers = excludedTrackers;
    } else if (activeTab === 'options' || activeTab === 'transfer') {
      if (downloadLimit !== snapshot.speedLimit) patch.speedLimit = downloadLimit;
      if (isTorrent) {
        patch.torrentUploadLimit = uploadLimit;
        patch.torrentMaxPeers = maxPeers.trim() ? Number(maxPeers) : undefined;
        patch.torrentPeerSpeedLimit = peerSpeedLimit;
      }
    }
    await requestAction('apply-properties', patch);
  }, [activeTab, connections, destination, downloadLimit, excludedTrackers, fileName, fileProgress, isTorrent, maxPeers, peerSpeedLimit, requestAction, selectedFiles, snapshot, t, trackers, uploadLimit]);

  const chooseTab = (tab: PropertiesTab) => {
    if (tab === activeTab) return;
    if (isDirty) setPendingTab(tab);
    else setActiveTab(tab);
  };

  const discardDraft = () => {
    const shouldClose = closePrompt;
    if (snapshot) hydrateDraft(snapshot);
    draftTabRef.current = null;
    setDraftTab(null);
    if (pendingTab) setActiveTab(pendingTab);
    setPendingTab(null);
    setClosePrompt(false);
    if (shouldClose) void currentWindow.close().catch(error => setErrorMessage(errorText(error)));
  };

  const closeWindow = async () => {
    if (!downloadId) return;
    try {
      await invoke('close_download_properties_window', { id: downloadId });
    } catch (error) {
      setErrorMessage(errorText(error));
    }
  };

  const performTorrentAction = async (action: 'magnet' | 'export' | 'move' | 'verify') => {
    if (!downloadId) return;
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
      } else {
        await requestAction('verify-torrent');
      }
    } catch (error) {
      setErrorMessage(errorText(error));
    }
  };

  if (!downloadId) {
    return <main className="properties-window-shell p-6" role="status">{errorMessage || t($ => $.app.loading)}</main>;
  }
  if (!snapshot) {
    return <main className="properties-window-shell p-6" role="status">{errorMessage || t($ => $.app.loading)}</main>;
  }

  const progress = Math.max(0, Math.min(1, snapshot.fraction ?? 0));
  const lifecycleAction = getPropertiesLifecycleAction(snapshot.status);
  const total = snapshot.size || (snapshot.totalBytes === undefined
    ? t($ => $.addDownloads.unknownSize)
    : `${snapshot.totalIsEstimate ? '~' : ''}${formatDownloadBytes(snapshot.totalBytes)}`);
  const statusLabel = t($ => $.downloads.status[snapshot.status]);
  const tabLabel = (tab: PropertiesTab) => {
    switch (tab) {
      case 'overview': return t($ => $.properties.torrentDetails);
      case 'files': return t($ => $.properties.torrentFileProgress);
      case 'trackers': return t($ => $.properties.torrentTrackers);
      case 'peers': return t($ => $.properties.torrentPeerDiagnostics);
      case 'options': return t($ => $.properties.advancedTransfer);
      case 'transfer': return t($ => $.properties.connections);
      case 'advanced': return t($ => $.properties.advancedTransfer);
    }
  };

  return (
    <main className="properties-window-shell flex h-screen min-h-0 flex-col bg-main-bg text-text-primary" aria-labelledby="properties-window-title">
      <header className="shrink-0 border-b border-border-modal bg-sidebar-bg px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 id="properties-window-title" className="truncate text-base font-semibold" title={snapshot.fileName}>{snapshot.fileName}</h1>
            <p className="mt-1 text-xs text-text-muted" role="status">{statusLabel} · {Math.round(progress * 100)}% · {total}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2" aria-label={t($ => $.actions.continue)}>
            {lifecycleAction && <button
              type="button"
              className="app-button px-3 text-xs"
              disabled={isSaving}
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
              {lifecycleAction === 'pause'
                ? t($ => $.downloads.actions.pause)
                : lifecycleAction === 'resume'
                  ? t($ => $.downloads.actions.resume)
                  : lifecycleAction === 'retry'
                    ? t($ => $.downloads.actions.retry)
                    : t($ => $.downloads.actions.start)}
            </button>}
            {isTorrent && <>
              <button type="button" className="app-button px-3 text-xs" disabled={isSaving} onClick={() => void performTorrentAction('magnet')}><Copy size={14} />{t($ => $.properties.torrentCopyMagnet)}</button>
              <button type="button" className="app-button px-3 text-xs" disabled={isSaving} onClick={() => void performTorrentAction('export')}><FileDown size={14} />{t($ => $.properties.torrentExportMetadata)}</button>
              <button type="button" className="app-button px-3 text-xs" disabled={isSaving} onClick={() => void performTorrentAction('move')}><FolderOpen size={14} />{t($ => $.properties.torrentMove)}</button>
            </>}
          </div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-item-hover" aria-label={t($ => $.properties.progress)}>
          <div className="h-full rounded-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${progress * 100}%` }} />
        </div>
        <div className="mt-3 grid min-w-0 grid-cols-2 gap-2 text-[11px] text-text-muted sm:grid-cols-4" dir="ltr">
          <span>{formatDownloadBytes(snapshot.downloadedBytes ?? 0)} / {total}</span>
          <span>{snapshot.speed || '—'}</span>
          <span>{snapshot.eta || '—'}</span>
          <span>{snapshot.activeConnections ?? '—'} / {snapshot.requestedConnections ?? snapshot.connections ?? '—'} {t($ => $.properties.connections)}</span>
          {isTorrent && <span>{formatTorrentRatio(snapshot.torrentUploadedBytes ?? 0, snapshot.downloadedBytes ?? 0, 'en-US')}</span>}
        </div>
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

      <section id={`properties-panel-${activeTab}`} role="tabpanel" aria-labelledby={`properties-tab-${activeTab}`} className="min-h-0 flex-1 overflow-auto p-5" tabIndex={0}>
        {activeTab === 'overview' && <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-text-muted">{t($ => $.properties.fileName)}<input className="app-control mt-1 w-full" value={fileName} onChange={event => { setFileName(event.target.value); setDraftTab('overview'); }} disabled={!isEditableStatus(snapshot.status)} /></label>
            <label className="text-xs text-text-muted">{t($ => $.properties.destination)}<input className="app-control mt-1 w-full" value={destination} onChange={event => { setDestination(event.target.value); setDraftTab('overview'); }} disabled={!isEditableStatus(snapshot.status)} /></label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs"><span className="text-text-muted">{t($ => $.properties.url)}</span><p className="mt-1 break-all" dir="ltr">{snapshot.url}</p></div>
            <div className="rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs"><span className="text-text-muted">{t($ => $.properties.category)}</span><p className="mt-1">{snapshot.category}</p></div>
          </div>
          {isTorrent && details && <div className="grid gap-2 rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs sm:grid-cols-2">
            <span className="text-text-muted">{t($ => $.properties.torrentDetailsInfoHash)}</span><span className="font-mono break-all">{details.infoHash}</span>
            <span className="text-text-muted">{t($ => $.properties.torrentDetailsPieces)}</span><span>{details.pieceCount} × {formatDownloadBytes(details.pieceLength)}</span>
            <span className="text-text-muted">{t($ => $.properties.torrentDetailsPrivate)}</span><span>{details.private ? t($ => $.properties.torrentDetailsPrivateYes) : t($ => $.properties.torrentDetailsPrivateNo)}</span>
          </div>}
          {isTorrent && <div className="flex flex-wrap gap-2"><button type="button" className="app-button px-3 text-xs" disabled={isSaving || !['paused', 'completed', 'failed'].includes(snapshot.status)} onClick={() => void performTorrentAction('verify')}><RefreshCw size={14} />{t($ => $.properties.torrentVerifyNow)}</button></div>}
        </div>}

        {activeTab === 'files' && isTorrent && <div className="space-y-3">
          <div className="flex flex-wrap gap-2"><button type="button" className="app-button px-3 text-xs" onClick={() => { const all = fileProgress?.files.map(file => file.index) ?? []; setSelectedFiles(all); setDraftTab('files'); }}>{t($ => $.properties.torrentFileSelectionAll)}</button><button type="button" className="app-button px-3 text-xs" onClick={() => { setSelectedFiles([]); setDraftTab('files'); }}>{t($ => $.properties.torrentFileSelectionClear)}</button><button type="button" className="app-button px-3 text-xs" onClick={() => downloadId && void refreshDiagnostics('files', downloadId)}><RefreshCw size={14} />{t($ => $.properties.torrentFileProgressRefresh)}</button></div>
          <div className="overflow-auto rounded-lg border border-border-modal"><table className="w-full min-w-[640px] text-xs" dir="ltr"><thead className="sticky top-0 bg-sidebar-bg text-left text-text-muted"><tr><th className="p-2">{t($ => $.properties.torrentFileProgressSelected)}</th><th className="p-2">#</th><th className="p-2">{t($ => $.properties.torrentFileProgressPath)}</th><th className="p-2">{t($ => $.properties.size)}</th><th className="p-2">{t($ => $.properties.torrentFileProgressCompleted)}</th></tr></thead><tbody>{fileProgress?.files.map(file => { const checked = selectedFiles === null ? file.selected : selectedFiles.includes(file.index); return <tr key={file.index} className="border-t border-border-modal/60"><td className="p-2"><input type="checkbox" checked={checked} onChange={() => { const current = selectedFiles ?? fileProgress.files.filter(candidate => candidate.selected).map(candidate => candidate.index); const next = checked ? current.filter(index => index !== file.index) : [...current, file.index]; setSelectedFiles(next); setDraftTab('files'); }} aria-label={`${file.index + 1} ${file.relativePath}`} /></td><td className="p-2">{file.index + 1}</td><td className="max-w-[420px] truncate p-2" dir="auto">{file.relativePath}</td><td className="p-2">{formatDownloadBytes(file.length)}</td><td className="p-2">{formatDownloadBytes(file.completedLength)} ({file.length ? Math.round(file.completedLength / file.length * 100) : 0}%)</td></tr>; })}</tbody></table></div>
          {diagnosticsLoading && <p className="text-xs text-text-muted">{t($ => $.properties.torrentPeerDiagnosticsLoading)}</p>}
          {!diagnosticsLoading && !fileProgress && !diagnosticError && <p className="text-xs text-text-muted">{t($ => $.properties.torrentFileProgressUnavailable)}</p>}
          {diagnosticError && <p className="text-xs text-red-400" role="alert">{diagnosticError}</p>}
        </div>}

        {activeTab === 'trackers' && isTorrent && <div className="space-y-4">
          <label className="block text-xs text-text-muted">{t($ => $.properties.torrentTrackers)}<textarea className="app-control mt-1 min-h-28 w-full font-mono" value={trackers} onChange={event => { setTrackers(event.target.value); setDraftTab('trackers'); }} /></label>
          <label className="block text-xs text-text-muted">{t($ => $.properties.torrentExcludeTrackers)}<textarea className="app-control mt-1 min-h-28 w-full font-mono" value={excludedTrackers} onChange={event => { setExcludedTrackers(event.target.value); setDraftTab('trackers'); }} /></label>
          <p className="text-xs text-text-muted">{t($ => $.properties.torrentTrackersHint)}</p>
          {details && <div className="rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs"><strong>{t($ => $.properties.torrentDetailsTrackers)}</strong><p className="mt-1 break-words" dir="auto">{details.trackers.join(', ') || '—'}</p></div>}
        </div>}

        {activeTab === 'peers' && isTorrent && <div className="space-y-4">
          <div className="flex items-center justify-between"><p className="text-sm">{peers ? t($ => $.properties.torrentPeerCount, { total: peers.totalPeers, seeders: peers.totalSeeders }) : diagnosticsLoading ? t($ => $.properties.torrentPeerDiagnosticsLoading) : t($ => $.properties.torrentPeerDiagnosticsUnavailable)}</p><button type="button" className="app-button px-3 text-xs" onClick={() => downloadId && void refreshDiagnostics('peers', downloadId)}><RefreshCw size={14} />{t($ => $.properties.torrentPeerDiagnosticsRefresh)}</button></div>
          <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs"><span className="text-text-muted">{t($ => $.properties.torrentAvailability)}</span><p className="mt-1">{availability ? `${availability.availability} · ${availability.pieceCount} ${t($ => $.properties.torrentDetailsPieces)}` : '—'}</p></div><div className="rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs"><span className="text-text-muted">{t($ => $.properties.torrentPeerDiagnosticsHint)}</span><p className="mt-1">{peers?.truncated ? t($ => $.properties.torrentPeerShowing, { shown: peers.peers.length, total: peers.totalPeers }) : peers?.peers.length ?? 0}</p></div></div>
          <div className="overflow-auto rounded-lg border border-border-modal"><table className="w-full min-w-[820px] text-xs" dir="ltr"><thead className="bg-sidebar-bg text-left text-text-muted"><tr><th className="p-2">{t($ => $.properties.torrentPeerAddress)}</th><th className="p-2">{t($ => $.properties.torrentPeerId)}</th><th className="p-2">{t($ => $.properties.torrentPeerDownload)}</th><th className="p-2">{t($ => $.properties.torrentPeerUpload)}</th><th className="p-2">{t($ => $.properties.torrentPeerSeeder)}</th><th className="p-2">{t($ => $.properties.torrentPeerChoking)}</th></tr></thead><tbody>{peers?.peers.map((peer, index) => <tr key={`${peer.ip ?? 'peer'}-${peer.port ?? 'unknown'}-${index}`} className="border-t border-border-modal/60"><td className="p-2 font-mono">{peer.ip ? `${peer.ip.includes(':') ? `[${peer.ip}]` : peer.ip}${peer.port == null ? '' : `:${peer.port}`}` : '—'}</td><td className="max-w-[220px] truncate p-2 font-mono" title={peer.peerId ?? undefined}>{peer.peerId || '—'}</td><td className="p-2">{formatDownloadBytes(peer.downloadSpeed)}/s</td><td className="p-2">{formatDownloadBytes(peer.uploadSpeed)}/s</td><td className="p-2">{peer.seeder ? '✓' : '—'}</td><td className="p-2">{peer.peerChoking ? '✓' : '—'}</td></tr>)}</tbody></table></div>
          {diagnosticError && <p className="text-xs text-red-400" role="alert">{diagnosticError}</p>}
        </div>}

        {(activeTab === 'transfer' || activeTab === 'options') && <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <label className="text-xs text-text-muted">{t($ => $.properties.speedCap)}<input className="app-control mt-1 w-full" value={downloadLimit} onChange={event => { setDownloadLimit(event.target.value); setDraftTab(activeTab); }} placeholder="1024K" disabled={!isEditableStatus(snapshot.status)} /></label>
          {isTorrent && <label className="text-xs text-text-muted">{t($ => $.properties.liveTorrentUploadLimit)}<input className="app-control mt-1 w-full" value={uploadLimit} onChange={event => { setUploadLimit(event.target.value); setDraftTab(activeTab); }} placeholder="1024K" disabled={!isEditableStatus(snapshot.status)} /></label>}
          {isTorrent && <label className="text-xs text-text-muted">{t($ => $.properties.torrentMaxPeers)}<input className="app-control mt-1 w-full" value={maxPeers} onChange={event => { setMaxPeers(event.target.value); setDraftTab(activeTab); }} inputMode="numeric" disabled={!isEditableStatus(snapshot.status)} /></label>}
          {isTorrent && <label className="text-xs text-text-muted">{t($ => $.properties.torrentPeerSpeedLimit)}<input className="app-control mt-1 w-full" value={peerSpeedLimit} onChange={event => { setPeerSpeedLimit(event.target.value); setDraftTab(activeTab); }} placeholder="50K" disabled={!isEditableStatus(snapshot.status)} /></label>}
        </div>}

        {activeTab === 'advanced' && <div className="space-y-4"><p className="text-xs text-text-muted">{t($ => $.properties.advancedTransfer)}</p><div className="grid max-w-2xl gap-3 rounded-lg border border-border-modal bg-bg-input/30 p-3 text-xs sm:grid-cols-2"><div><span className="text-text-muted">{t($ => $.properties.connections)}</span><p className="mt-1">{snapshot.activeConnections ?? '—'} / {snapshot.requestedConnections ?? snapshot.connections ?? '—'}</p></div><div><span className="text-text-muted">{t($ => $.properties.speedCap)}</span><p className="mt-1">{snapshot.speedLimit || '—'}</p></div><div><span className="text-text-muted">{t($ => $.properties.cookies)}</span><p className="mt-1">{snapshot.hasCookies ? '✓' : '—'}</p></div><div><span className="text-text-muted">{t($ => $.properties.headers)}</span><p className="mt-1">{snapshot.hasHeaders ? '✓' : '—'}</p></div></div><p className="text-xs text-text-muted">{t($ => $.properties.liveSpeedLimitHint)}</p></div>}
      </section>

      {(isDirty || errorMessage || notice || pendingTab || closePrompt) && <div className="shrink-0 border-t border-border-modal bg-sidebar-bg px-4 py-2" aria-live="polite">
        {pendingTab || closePrompt ? <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span>{t($ => $.scheduler.unsavedChanges)}</span><div className="flex gap-2"><button type="button" className="app-button px-3 text-xs" onClick={discardDraft}>{t($ => $.actions.cancel)}</button><button type="button" className="app-button app-button-primary px-3 text-xs" disabled={isSaving} onClick={() => { closeAfterSaveRef.current = closePrompt; switchAfterSaveRef.current = pendingTab; void applyActiveTab(); }}>{t($ => $.properties.save)}</button><button type="button" className="app-button px-3 text-xs" onClick={() => { switchAfterSaveRef.current = null; closeAfterSaveRef.current = false; setPendingTab(null); setClosePrompt(false); }}>{t($ => $.properties.cancel)}</button></div></div> : <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className={errorMessage ? 'text-red-400' : 'text-text-muted'}>{errorMessage || notice}</span><div className="flex gap-2">{isDirty && <><button type="button" className="app-button px-3 text-xs" onClick={discardDraft}>{t($ => $.actions.cancel)}</button><button type="button" className="app-button app-button-primary px-3 text-xs" disabled={isSaving} onClick={() => void applyActiveTab()}><Save size={14} />{t($ => $.properties.save)}</button></>}<button type="button" className="app-button px-3 text-xs" onClick={() => void closeWindow()}><X size={14} />{t($ => $.properties.cancel)}</button></div></div>}
      </div>}
    </main>
  );
};

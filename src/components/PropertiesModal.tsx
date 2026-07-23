import { useState, useEffect } from 'react';
import { useDownloadStore, DownloadItem } from '../store/useDownloadStore';
import { useDownloadProgressStore } from '../store/downloadProgressStore';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore } from '../store/useSettingsStore';
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
  formatDownloadTotal,
  resolveDownloadSizeDisplay
} from '../utils/downloadProgress';
import { resolveDownloadConnections } from '../utils/downloads';
import { useTranslation } from 'react-i18next';
import { formatDateTime, type CalendarPreference } from '../utils/dateTime';

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
  const [isLiveSpeedLimitPending, setIsLiveSpeedLimitPending] = useState(false);

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

  useEffect(() => {
    if (selectedPropertiesDownloadId) {
      const activeItem = useDownloadStore.getState().downloads.find(d => d.id === selectedPropertiesDownloadId);
      if (activeItem) {
        setUrl(activeItem.url);
        setFileName(activeItem.fileName);
        if (activeItem.destination) {
          setSaveLocation(activeItem.destination);
        } else {
          void resolveCategoryDestination(
            useSettingsStore.getState(),
            activeItem.category
          ).then(setSaveLocation);
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
        setErrorMessage('');
      } else {
        setSelectedPropertiesDownloadId(null);
      }
    }
  }, [selectedPropertiesDownloadId, setSelectedPropertiesDownloadId]);

  useEffect(() => {
    const activeLimit = item?.speedLimit?.trim();
    setLiveSpeedLimitValue(activeLimit && activeLimit !== '0' ? activeLimit : '');
  }, [item?.speedLimit, selectedPropertiesDownloadId]);

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
      if (event.key === 'Escape') setSelectedPropertiesDownloadId(null);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [selectedPropertiesDownloadId, setSelectedPropertiesDownloadId]);

  if (!selectedPropertiesDownloadId || !item) return null;

  const handleBrowse = async () => {
    if (identityLocked) return;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: saveLocation.startsWith('~') ? undefined : saveLocation
      });
      if (selected && typeof selected === 'string') {
        setSaveLocation(selected);
      }
    } catch (e) {
      console.error("Failed to select folder:", e);
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
      ...(connectionsDirty
        ? { connections: resolveDownloadConnections(connections, perServerConnections) }
        : {}),
    };
    
    try {
      setErrorMessage('');
      await useDownloadStore.getState().applyProperties(item.id, updates);
      setSelectedPropertiesDownloadId(null);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
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
      setErrorMessage(t($ => $.downloadTable.interactionError, { message, detail }));
    } finally {
      setIsPauseResumePending(false);
    }
  };

  const handleLiveSpeedLimit = async (limit: string | null) => {
    if (isLiveSpeedLimitPending || item.isMedia || !['downloading', 'retrying'].includes(item.status)) return;

    setErrorMessage('');
    setIsLiveSpeedLimitPending(true);
    try {
      await useDownloadStore.getState().setDownloadSpeedLimit(item.id, limit);
      if (limit === null) setLiveSpeedLimitValue('');
    } catch (error) {
      setErrorMessage(t($ => $.properties.liveSpeedLimitFailed, {
        detail: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setIsLiveSpeedLimitPending(false);
    }
  };

  const identityLocked = getIdentityLocked(item.status);
  const transferLocked = getTransferLocked(item.status);
  const liveSpeedLimitAvailable = !item.isMedia && ['downloading', 'retrying'].includes(item.status);
  const liveSpeedLimitUnavailable = item.isMedia && ['downloading', 'processing', 'retrying'].includes(item.status);
  const configuredConnections = resolveDownloadConnections(item.connections, perServerConnections);
  const observedConnectionTotal = Math.max(
    1,
    liveProgress?.requested_connections ?? configuredConnections
  );
  const observedActiveConnections = liveProgress?.active_connections;
  const connectionTelemetryActive = item.status === 'downloading' ||
    item.status === 'processing' ||
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
    : liveProgress?.speed ?? item.speed ?? '-';
  const displayedEta = item.status === 'completed'
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
  else if (item.status === 'downloading' || item.status === 'retrying') { statusColor = 'text-blue-500'; StatusIcon = Play; }
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
    >
      <div className="app-modal w-[720px] h-[580px] flex flex-col overflow-hidden text-sm">
        
        {/* Header Summary */}
        <div className="p-4 px-5 bg-sidebar-bg/50">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold truncate text-text-primary pr-4">{item.fileName}</h2>
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
              
              <label className="text-xs text-text-muted text-right">{t($ => $.properties.speed)}</label>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-text-primary">
                      <input type="checkbox" checked={speedLimitEnabled} onChange={e => setSpeedLimitEnabled(e.target.checked)} disabled={transferLocked} className="rounded border-border-modal text-blue-500 focus:ring-blue-500/20 bg-bg-input disabled:opacity-50" />
                  {t($ => $.properties.limit)}
                </label>
                {speedLimitEnabled && (
                  <div className="flex items-center gap-2">
                          <input type="number" value={speedLimitValue} min={1} step={128} onChange={e=>setSpeedLimitValue(e.target.value)} disabled={transferLocked} className="w-20 bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-50" />
                    <span className="text-xs text-text-muted">KiB/s</span>
                  </div>
                )}
              </div>
              {(liveSpeedLimitAvailable || liveSpeedLimitUnavailable) && (
                <div className="col-start-2 rounded-md border border-border-modal/60 bg-border-color/20 p-3 space-y-2">
                  {liveSpeedLimitAvailable ? (
                    <>
                      <label htmlFor="live-speed-limit" className="block text-xs font-medium text-text-primary">
                        {t($ => $.properties.liveSpeedLimit)}
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          id="live-speed-limit"
                          type="text"
                          inputMode="decimal"
                          value={liveSpeedLimitValue}
                          onChange={event => setLiveSpeedLimitValue(event.currentTarget.value)}
                          placeholder={t($ => $.properties.liveSpeedLimitPlaceholder)}
                          disabled={isLiveSpeedLimitPending}
                          aria-describedby="live-speed-limit-hint"
                          className="w-28 bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-50"
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
              disabled={transferLocked}
              className={`app-button app-button-primary px-4 text-xs ${transferLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
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

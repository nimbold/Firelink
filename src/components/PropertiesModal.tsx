import { useState, useEffect } from 'react';
import { useDownloadStore, DownloadItem } from '../store/useDownloadStore';
import { useDownloadProgressStore } from '../store/downloadProgressStore';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore } from '../store/useSettingsStore';
import { ChevronDown, ChevronRight, FolderPlus, Info, CheckCircle, AlertCircle, Play, Pause } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { resolveCategoryDestination } from '../utils/downloadLocations';
import {
  isIdentityLocked as getIdentityLocked,
  isTransferLocked as getTransferLocked
} from '../utils/downloadActions';
import {
  downloadProgressColorClass,
  formatDownloadTotal,
  resolveDownloadSizeDisplay
} from '../utils/downloadProgress';
import { resolveDownloadConnections } from '../utils/downloads';

type LoginMode = 'matching' | 'custom' | 'none';

const formatLastTry = (value?: string): string => {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '-'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export const PropertiesModal = () => {
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

  const { baseDownloadFolder, perServerConnections } = useSettingsStore();

  // Form states
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [saveLocation, setSaveLocation] = useState('');
  const [connections, setConnections] = useState(() => resolveDownloadConnections(undefined, perServerConnections));
  const [connectionsDirty, setConnectionsDirty] = useState(false);
  
  const [speedLimitEnabled, setSpeedLimitEnabled] = useState(false);
  const [speedLimitValue, setSpeedLimitValue] = useState('1024'); // KiB/s

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
      setErrorMessage("Enter a valid URL.");
      return;
    }
    if (!fileName.trim()) {
      setErrorMessage("File name cannot be empty.");
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

  const identityLocked = getIdentityLocked(item.status);
  const transferLocked = getTransferLocked(item.status);
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
  const completedSizeLabel = item.status === 'completed'
    ? formatDownloadTotal(sizeDisplay)
    : sizeDisplay.fallback;

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
              {item.status}
            </span>
          </div>
          
          <div className="w-full bg-border-color rounded-full h-1.5 overflow-hidden mb-4">
            <div className={`h-1.5 rounded-full transition-all duration-300 ${item.status === 'completed' ? 'bg-green-500' : item.status === 'paused' ? 'bg-orange-500' : item.status === 'failed' ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${displayedFraction * 100}%` }}></div>
          </div>
          
            <div className="grid grid-cols-4 gap-y-2 gap-x-4 text-[11px] leading-tight">
              <div className="flex gap-1.5 min-w-0"><span className="text-text-muted font-medium w-[90px] shrink-0">Progress</span><span className="text-text-secondary truncate">{`${(displayedFraction * 100).toFixed(0)}%`}</span></div>
              <div className="flex gap-1.5 min-w-0">
                <span className="text-text-muted font-medium w-[40px] shrink-0">Size</span>
                <span
                  className="truncate"
                  title={hasDownloadedAmount
                    ? `${sizeDisplay.downloaded} downloaded of ${sizeDisplay.totalIsEstimate ? 'approximately ' : ''}${sizeDisplay.total} ${sizeDisplay.unit}`
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
              <div className="flex gap-1.5 min-w-0"><span className="text-text-muted font-medium w-[40px] shrink-0">Speed</span><span className="text-text-secondary truncate">{displayedSpeed}</span></div>
              <div className="flex gap-1.5 min-w-0"><span className="text-text-muted font-medium w-[30px] shrink-0">ETA</span><span className="text-text-secondary truncate">{displayedEta}</span></div>

              <div className="flex gap-1.5 min-w-0"><span className="text-text-muted font-medium w-[90px] shrink-0">Connections</span><span className="text-text-secondary truncate" title={item.connections !== undefined ? 'Saved for this download; Settings changes apply to new downloads.' : 'Using the current default for new downloads.'}>{resolveDownloadConnections(item.connections, perServerConnections)}{item.connections !== undefined ? ' (saved)' : ' (default)'}</span></div>
              <div className="flex gap-1.5 min-w-0"><span className="text-text-muted font-medium w-[60px] shrink-0">Speed cap</span><span className="text-text-secondary truncate">{item.speedLimit || '-'}</span></div>
              <div className="flex gap-1.5 min-w-0"><span className="text-text-muted font-medium w-[55px] shrink-0">Category</span><span className="text-text-secondary truncate">{item.category}</span></div>
            <div className="flex gap-1.5"><span className="text-text-muted font-medium w-[50px]">Last try</span><span className="text-text-secondary truncate">{formatLastTry(item.lastTry)}</span></div>
            
              <div className="flex gap-1.5 col-span-2"><span className="text-text-muted font-medium w-[90px]">Date added</span><span className="text-text-secondary truncate">{new Date(item.dateAdded).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span></div>
              <div className="flex gap-1.5 col-span-2"><span className="text-text-muted font-medium w-[70px]">Destination</span><span className="text-text-secondary truncate" title={saveLocation}>{saveLocation || baseDownloadFolder}</span></div>
            {item.lastError && (item.status === 'failed' || item.status === 'retrying') && (
              <div className="flex gap-1.5 col-span-4 min-w-0">
                <span className="text-text-muted font-medium w-[90px] shrink-0">Last error</span>
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
                  ? "File identity is read-only. Transfer settings are saved for redownload." 
                  : "Transfer settings can be changed after stopping or pausing. Current transfers keep their existing backend options."}
              </span>
            </div>
          )}

          {/* Download Section */}
          <section>
            <h3 className="text-sm font-semibold text-text-primary mb-4 pb-1 border-b border-border-modal/50">Download</h3>
            <div className="grid grid-cols-[100px_1fr] gap-y-3.5 gap-x-4 items-center">
              <label className="text-xs text-text-muted text-right">URL</label>
              <input type="text" value={url} onChange={e => setUrl(e.target.value)} disabled={identityLocked} className="bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-accent disabled:opacity-50" />
              
              <label className="text-xs text-text-muted text-right">File name</label>
              <input type="text" value={fileName} onChange={e => setFileName(e.target.value)} disabled={identityLocked} className="bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-50" />
              
              <label className="text-xs text-text-muted text-right">Save location</label>
              <div className="flex gap-2">
                <input type="text" value={saveLocation} readOnly disabled={identityLocked} className="flex-1 bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-accent disabled:opacity-50" />
                <button onClick={handleBrowse} disabled={identityLocked} className="bg-item-hover hover:bg-item-hover/80 text-text-primary border border-border-modal px-3 py-1.5 rounded text-xs transition-colors disabled:opacity-40 flex items-center gap-1.5">
                  <FolderPlus size={14} /> Select
                </button>
              </div>
              
              <label className="text-xs text-text-muted text-right">Connections</label>
              <div className="flex items-center gap-2">
                <input type="number" value={connections} min={1} max={16} onChange={e=>{ setConnections(Number(e.target.value)); setConnectionsDirty(true); }} disabled={transferLocked} className="w-16 bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-50" />
                <span className="text-xs text-text-muted">per file</span>
                {!transferLocked && item.connections !== undefined && item.connections !== perServerConnections && (
                  <button
                    type="button"
                    onClick={() => { setConnections(perServerConnections); setConnectionsDirty(true); }}
                    className="text-[11px] text-accent hover:underline whitespace-nowrap"
                  >
                    Use current default ({perServerConnections})
                  </button>
                )}
              </div>
              <div className="col-start-2 text-[11px] text-text-muted">
                Saved per download. The Settings default applies to new downloads.
              </div>
              
              <label className="text-xs text-text-muted text-right">Speed</label>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-text-primary">
                      <input type="checkbox" checked={speedLimitEnabled} onChange={e => setSpeedLimitEnabled(e.target.checked)} disabled={transferLocked} className="rounded border-border-modal text-blue-500 focus:ring-blue-500/20 bg-bg-input disabled:opacity-50" />
                  Limit
                </label>
                {speedLimitEnabled && (
                  <div className="flex items-center gap-2">
                          <input type="number" value={speedLimitValue} min={1} step={128} onChange={e=>setSpeedLimitValue(e.target.value)} disabled={transferLocked} className="w-20 bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-50" />
                    <span className="text-xs text-text-muted">KiB/s</span>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Site Login Section */}
          <section>
            <h3 className="text-sm font-semibold text-text-primary mb-4 pb-1 border-b border-border-modal/50">
              {item.status === 'completed' ? 'Site Login for Redownload' : 'Site Login'}
            </h3>
            
            <div className="flex gap-1 p-1 bg-border-color rounded-lg mb-4 w-fit mx-auto md:mx-0">
              {(['matching', 'custom', 'none'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => !transferLocked && setLoginMode(mode)}
                  disabled={transferLocked}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${loginMode === mode ? 'bg-bg-modal text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'}`}
                >
                  {mode === 'matching' ? 'Matching site login' : mode === 'custom' ? 'Custom credentials' : 'No login'}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-[100px_1fr] gap-y-3.5 gap-x-4 items-center">
              {loginMode === 'matching' && (
                <div className="col-start-2 text-xs text-text-secondary italic">
                  Will use saved login if available.
                </div>
              )}
              {loginMode === 'custom' && (
                <>
                  <label className="text-xs text-text-muted text-right">Username</label>
                  <input type="text" value={username} onChange={e=>setUsername(e.target.value)} disabled={transferLocked} placeholder="Username" className="max-w-[250px] bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-50" />
                  
                  <label className="text-xs text-text-muted text-right">Password</label>
                  <input type="password" value={password} onChange={e=>setPassword(e.target.value)} disabled={transferLocked} placeholder="Password" className="max-w-[250px] bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-50" />
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
                {item.status === 'completed' ? 'Advanced Transfer for Redownload' : 'Advanced Transfer'}
             </button>
             
             {advancedExpanded && (
               <div className="mt-4 grid grid-cols-[100px_1fr] gap-y-3.5 gap-x-4 items-center pl-6">
                 <label className="text-xs text-text-muted text-right">Checksum</label>
                 <label className="flex items-center gap-2 text-xs text-text-primary">
                    <input type="checkbox" checked={checksumEnabled} onChange={e => setChecksumEnabled(e.target.checked)} disabled={transferLocked} className="rounded border-border-modal text-blue-500 focus:ring-blue-500/20 bg-bg-input" />
                    Verify
                 </label>

                 {checksumEnabled && (
                    <>
                      <label className="text-xs text-text-muted text-right">Algorithm</label>
                      <select value={checksumAlgorithm} onChange={e=>setChecksumAlgorithm(e.target.value)} disabled={transferLocked} className="max-w-[150px] bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-50">
                        <option value="MD5">MD5</option>
                        <option value="SHA-1">SHA-1</option>
                        <option value="SHA-256">SHA-256</option>
                        <option value="SHA-512">SHA-512</option>
                      </select>

                      <label className="text-xs text-text-muted text-right">Digest</label>
                      <input type="text" value={checksumValue} onChange={e=>setChecksumValue(e.target.value)} disabled={transferLocked} placeholder="Expected digest" className="bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-accent disabled:opacity-50" />
                    </>
                 )}

                 <label className="text-xs text-text-muted text-right">Cookies</label>
                 <input type="text" value={cookies} onChange={e=>setCookies(e.target.value)} disabled={transferLocked} placeholder="Cookies" className="bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-accent disabled:opacity-50" />
                 
                 <div className="col-span-2 mt-2">
                   <label className="block text-xs text-text-muted mb-1.5">Headers</label>
                   <textarea value={headers} onChange={e=>setHeaders(e.target.value)} disabled={transferLocked} className="w-full h-16 bg-bg-input border border-border-modal rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-accent disabled:opacity-50 resize-none"></textarea>
                 </div>

                 <div className="col-span-2">
                   <label className="block text-xs text-text-muted mb-1.5">Mirrors</label>
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
              onClick={() => setSelectedPropertiesDownloadId(null)} 
              className="app-button px-4 text-xs"
            >
              Cancel
            </button>
            <button 
              onClick={handleSave} 
              disabled={transferLocked}
              className={`app-button app-button-primary px-4 text-xs ${transferLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <CheckCircle size={14} />
              Save
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};

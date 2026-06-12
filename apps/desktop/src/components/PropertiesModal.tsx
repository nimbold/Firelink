import { useState, useEffect } from 'react';
import { useDownloadStore, DownloadItem } from '../store/useDownloadStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { ChevronDown, ChevronRight, FolderPlus, Info, CheckCircle, AlertCircle, Play, Pause } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';

type LoginMode = 'matching' | 'custom' | 'none';

export const PropertiesModal = () => {
  const { 
    selectedPropertiesDownloadId, 
    setSelectedPropertiesDownloadId, 
    downloads, 
    updateDownload 
  } = useDownloadStore();

  const { defaultDownloadPath } = useSettingsStore();

  const [item, setItem] = useState<DownloadItem | null>(null);

  // Form states
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [saveLocation, setSaveLocation] = useState('');
  const [connections, setConnections] = useState(16);
  
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
      const activeItem = downloads.find(d => d.id === selectedPropertiesDownloadId);
      if (activeItem) {
        setItem(activeItem);
        setUrl(activeItem.url);
        setFileName(activeItem.fileName);
        setSaveLocation(activeItem.destination || defaultDownloadPath || '~/Downloads');
        setConnections(activeItem.connections || 16);
        
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
        setErrorMessage('');
      } else {
        setItem(null);
      }
    } else {
      setItem(null);
    }
  }, [selectedPropertiesDownloadId, downloads, defaultDownloadPath]);

  if (!selectedPropertiesDownloadId || !item) return null;

  const handleBrowse = async () => {
    if (isLocked) return;
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

  const handleSave = () => {
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
      connections: Number(connections),
      speedLimit: speedLimitEnabled && speedLimitValue ? `${speedLimitValue}K` : null,
      username: loginMode === 'custom' ? username.trim() : null,
      password: loginMode === 'custom' ? password.trim() : null,
      headers: headers.trim() || null,
    };
    
    updateDownload(item.id, updates);
    setSelectedPropertiesDownloadId(null);
  };

  const isLocked = ['downloading', 'completed'].includes(item.status);
  const isTransferLocked = item.status === 'downloading';

  let statusColor = 'text-text-secondary';
  let StatusIcon = Info;
  if (item.status === 'completed') { statusColor = 'text-green-500'; StatusIcon = CheckCircle; }
  else if (item.status === 'downloading') { statusColor = 'text-blue-500'; StatusIcon = Play; }
  else if (item.status === 'paused') { statusColor = 'text-orange-500'; StatusIcon = Pause; }
  else if (item.status === 'failed') { statusColor = 'text-red-500'; StatusIcon = AlertCircle; }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[720px] h-[580px] bg-bg-modal border border-border-modal rounded-xl shadow-2xl flex flex-col overflow-hidden text-sm">
        
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
            <div className={`h-1.5 rounded-full transition-all duration-300 ${item.status === 'completed' ? 'bg-green-500' : item.status === 'paused' ? 'bg-orange-500' : item.status === 'failed' ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${(item.status === 'completed' ? 1 : item.fraction || 0) * 100}%` }}></div>
          </div>
          
          <div className="grid grid-cols-4 gap-y-2 gap-x-4 text-[11px] leading-tight">
            <div className="flex gap-1.5"><span className="text-text-muted font-medium w-[90px]">Progress</span><span className="text-text-secondary truncate">{item.status === 'completed' ? '100%' : ((item.fraction || 0) * 100).toFixed(0) + '%'}</span></div>
            <div className="flex gap-1.5"><span className="text-text-muted font-medium w-[40px]">Size</span><span className="text-text-secondary truncate">-</span></div>
            <div className="flex gap-1.5"><span className="text-text-muted font-medium w-[40px]">Speed</span><span className="text-text-secondary truncate">{item.status === 'completed' ? '-' : item.speed || '-'}</span></div>
            <div className="flex gap-1.5"><span className="text-text-muted font-medium w-[30px]">ETA</span><span className="text-text-secondary truncate">{item.status === 'completed' ? '-' : item.eta || '-'}</span></div>
            
            <div className="flex gap-1.5"><span className="text-text-muted font-medium w-[90px]">Live connections</span><span className="text-text-secondary truncate">-</span></div>
            <div className="flex gap-1.5"><span className="text-text-muted font-medium w-[60px]">Speed cap</span><span className="text-text-secondary truncate">{item.speedLimit || '-'}</span></div>
            <div className="flex gap-1.5"><span className="text-text-muted font-medium w-[55px]">Category</span><span className="text-text-secondary truncate">{item.category}</span></div>
            <div className="flex gap-1.5"><span className="text-text-muted font-medium w-[50px]">Last try</span><span className="text-text-secondary truncate">-</span></div>
            
            <div className="flex gap-1.5 col-span-2"><span className="text-text-muted font-medium w-[90px]">Date added</span><span className="text-text-secondary truncate">{new Date(item.dateAdded).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span></div>
            <div className="flex gap-1.5 col-span-2"><span className="text-text-muted font-medium w-[70px]">Destination</span><span className="text-text-secondary truncate" title={item.destination}>{item.destination || defaultDownloadPath}</span></div>
          </div>
        </div>

        <div className="h-[1px] bg-border-modal w-full shrink-0"></div>

        {/* Scrollable Form Content */}
        <div className="flex-1 overflow-y-auto bg-main-bg/30 p-5 space-y-7">
          
          {isLocked && (
            <div className="flex gap-2.5 items-center text-xs text-text-secondary bg-border-color/30 p-3 rounded-md border border-border-modal">
              {item.status === 'completed' ? <CheckCircle size={16} className="text-green-500" /> : <AlertCircle size={16} className="text-blue-500" />}
              <span>
                {item.status === 'completed' 
                  ? "File identity is read-only. Transfer settings are saved for redownload." 
                  : "Only the speed limit applies to the current transfer. Other settings can be changed after stopping or pausing."}
              </span>
            </div>
          )}

          {/* Download Section */}
          <section>
            <h3 className="text-sm font-semibold text-text-primary mb-4 pb-1 border-b border-border-modal/50">Download</h3>
            <div className="grid grid-cols-[100px_1fr] gap-y-3.5 gap-x-4 items-center">
              <label className="text-xs text-text-muted text-right">URL</label>
              <input type="text" value={url} onChange={e => setUrl(e.target.value)} disabled={isLocked} className="bg-bg-input border border-border-modal rounded px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-blue-500 disabled:opacity-50" />
              
              <label className="text-xs text-text-muted text-right">File name</label>
              <input type="text" value={fileName} onChange={e => setFileName(e.target.value)} disabled={isLocked} className="bg-bg-input border border-border-modal rounded px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-blue-500 disabled:opacity-50" />
              
              <label className="text-xs text-text-muted text-right">Save location</label>
              <div className="flex gap-2">
                <input type="text" value={saveLocation} readOnly disabled={isLocked} className="flex-1 bg-bg-input border border-border-modal rounded px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-blue-500 disabled:opacity-50" />
                <button onClick={handleBrowse} disabled={isLocked} className="bg-item-hover hover:bg-item-hover/80 text-text-primary border border-border-modal px-3 py-1.5 rounded text-xs transition-colors disabled:opacity-40 flex items-center gap-1.5">
                  <FolderPlus size={14} /> Select
                </button>
              </div>
              
              <label className="text-xs text-text-muted text-right">Connections</label>
              <div className="flex items-center gap-2">
                <input type="number" value={connections} min={1} max={16} onChange={e=>setConnections(Number(e.target.value))} disabled={isTransferLocked} className="w-16 bg-bg-input border border-border-modal rounded px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-blue-500 disabled:opacity-50" />
                <span className="text-xs text-text-muted">per file</span>
              </div>
              
              <label className="text-xs text-text-muted text-right">Speed</label>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-text-primary">
                  <input type="checkbox" checked={speedLimitEnabled} onChange={e => setSpeedLimitEnabled(e.target.checked)} className="rounded border-border-modal text-blue-500 focus:ring-blue-500/20 bg-bg-input" />
                  Limit
                </label>
                {speedLimitEnabled && (
                  <div className="flex items-center gap-2">
                    <input type="number" value={speedLimitValue} min={1} step={128} onChange={e=>setSpeedLimitValue(e.target.value)} className="w-20 bg-bg-input border border-border-modal rounded px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-blue-500" />
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
                  onClick={() => !isTransferLocked && setLoginMode(mode)}
                  disabled={isTransferLocked}
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
                  <input type="text" value={username} onChange={e=>setUsername(e.target.value)} disabled={isTransferLocked} placeholder="Username" className="max-w-[250px] bg-bg-input border border-border-modal rounded px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-blue-500 disabled:opacity-50" />
                  
                  <label className="text-xs text-text-muted text-right">Password</label>
                  <input type="password" value={password} onChange={e=>setPassword(e.target.value)} disabled={isTransferLocked} placeholder="Password" className="max-w-[250px] bg-bg-input border border-border-modal rounded px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-blue-500 disabled:opacity-50" />
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
                    <input type="checkbox" checked={checksumEnabled} onChange={e => setChecksumEnabled(e.target.checked)} disabled={isTransferLocked} className="rounded border-border-modal text-blue-500 focus:ring-blue-500/20 bg-bg-input" />
                    Verify
                 </label>

                 {checksumEnabled && (
                    <>
                      <label className="text-xs text-text-muted text-right">Algorithm</label>
                      <select value={checksumAlgorithm} onChange={e=>setChecksumAlgorithm(e.target.value)} disabled={isTransferLocked} className="max-w-[150px] bg-bg-input border border-border-modal rounded px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-blue-500 disabled:opacity-50">
                        <option value="MD5">MD5</option>
                        <option value="SHA-1">SHA-1</option>
                        <option value="SHA-256">SHA-256</option>
                        <option value="SHA-512">SHA-512</option>
                      </select>

                      <label className="text-xs text-text-muted text-right">Digest</label>
                      <input type="text" value={checksumValue} onChange={e=>setChecksumValue(e.target.value)} disabled={isTransferLocked} placeholder="Expected digest" className="bg-bg-input border border-border-modal rounded px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-blue-500 disabled:opacity-50" />
                    </>
                 )}

                 <label className="text-xs text-text-muted text-right">Cookies</label>
                 <input type="text" value={cookies} onChange={e=>setCookies(e.target.value)} disabled={isTransferLocked} placeholder="Cookies" className="bg-bg-input border border-border-modal rounded px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-blue-500 disabled:opacity-50" />
                 
                 <div className="col-span-2 mt-2">
                   <label className="block text-xs text-text-muted mb-1.5">Headers</label>
                   <textarea value={headers} onChange={e=>setHeaders(e.target.value)} disabled={isTransferLocked} className="w-full h-16 bg-bg-input border border-border-modal rounded px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-blue-500 disabled:opacity-50 resize-none"></textarea>
                 </div>

                 <div className="col-span-2">
                   <label className="block text-xs text-text-muted mb-1.5">Mirrors</label>
                   <textarea value={mirrors} onChange={e=>setMirrors(e.target.value)} disabled={isTransferLocked} className="w-full h-16 bg-bg-input border border-border-modal rounded px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-blue-500 disabled:opacity-50 resize-none"></textarea>
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
              className="px-4 py-1.5 rounded border border-border-modal text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-item-hover transition-colors"
            >
              Cancel
            </button>
            <button 
              onClick={handleSave} 
              className="px-4 py-1.5 rounded text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white shadow-sm transition-all active:scale-95 flex items-center gap-1.5"
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

import { useState, useEffect } from 'react';
import { useDownloadStore } from '../store/useDownloadStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { X, FolderPlus, Settings, Shield, Globe, RefreshCw, FileText, HardDrive, Database, Link, ArrowRight, CheckCircle2, Play, ChevronDown, ChevronRight } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

export const AddDownloadsModal = () => {
  const { isAddModalOpen, toggleAddModal, addDownload } = useDownloadStore();
  const { defaultDownloadPath } = useSettingsStore();
  
  const [urls, setUrls] = useState('');
  const [parsedItems, setParsedItems] = useState<{url: string, file: string, size?: string, sizeBytes?: number, status?: string}[]>([]);
  
  // Right Form
  const [saveLocation, setSaveLocation] = useState(defaultDownloadPath);
  const [connections, setConnections] = useState(16);
  const [speedLimitEnabled, setSpeedLimitEnabled] = useState(false);
  const [speedLimit, setSpeedLimit] = useState('1024');
  const [freeSpace, setFreeSpace] = useState('Unknown');
  
  const [useAuth, setUseAuth] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [checksumEnabled, setChecksumEnabled] = useState(false);
  const [checksumAlgo, setChecksumAlgo] = useState('SHA-256');
  const [checksumValue, setChecksumValue] = useState('');
  const [headers, setHeaders] = useState('');
  const [cookies, setCookies] = useState('');
  const [mirrors, setMirrors] = useState('');

  useEffect(() => {
    if (isAddModalOpen) {
      setSaveLocation(defaultDownloadPath);
      setUrls('');
      setParsedItems([]);
    }
  }, [isAddModalOpen, defaultDownloadPath]);

  useEffect(() => {
    if (!saveLocation) return;
    invoke<string>('get_free_space', { path: saveLocation })
      .then(space => setFreeSpace(space))
      .catch(() => setFreeSpace('Unknown'));
  }, [saveLocation, isAddModalOpen]);

  // Metadata parser
  useEffect(() => {
    const lines = urls.split('\n').map(u => u.trim()).filter(u => u.length > 0);
    
    // Immediately display items in loading state
    const initialItems = lines.map(url => {
      let fallbackFile = 'URL';
      try { fallbackFile = new URL(url).pathname.split('/').pop() || 'download'; } catch {}
      return { url, file: fallbackFile, size: '-', status: 'Loading' };
    });
    setParsedItems(initialItems);

    if (lines.length === 0) return;

    const timer = setTimeout(async () => {
      const updatedItems = [...initialItems];
      for (let i = 0; i < lines.length; i++) {
        const url = lines[i];
        try {
          new URL(url);
          const meta = await invoke<{filename: string, size: string, size_bytes: number}>('fetch_metadata', { url });
          updatedItems[i] = { url, file: meta.filename, size: meta.size, sizeBytes: meta.size_bytes, status: 'Ready' };
        } catch (e) {
          console.error("Meta fetch failed", e);
          updatedItems[i] = { ...updatedItems[i], size: 'Unknown', sizeBytes: 0, status: 'Error' };
        }
        // Progressively update the UI as each fetch completes
        setParsedItems([...updatedItems]);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [urls]);
  
  if (!isAddModalOpen) return null;

  const handleBrowse = async () => {
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

  const handleStart = async (startImmediately: boolean) => {
    let finalLocation = saveLocation;
    const settings = useSettingsStore.getState();
    if (settings.askWhereToSaveEachFile && parsedItems.length > 0) {
      try {
        const selected = await open({
          directory: true,
          multiple: false,
          defaultPath: finalLocation.startsWith('~') ? undefined : finalLocation
        });
        if (selected && typeof selected === 'string') {
          finalLocation = selected;
        } else {
          return; // Cancelled
        }
      } catch (e) {
        console.error("Failed to select folder:", e);
      }
    }

    for (const item of parsedItems) {
      try {
        const id = crypto.randomUUID();
        addDownload({
          id,
          url: item.url,
          fileName: item.file,
          status: startImmediately ? 'queued' : 'paused',
          category: 'Other',
          dateAdded: new Date().toISOString(),
          connections: Number(connections),
          speedLimit: speedLimitEnabled ? `${speedLimit}K` : undefined,
          username: useAuth ? username.trim() : undefined,
          password: useAuth ? password.trim() : undefined,
          headers: headers.trim() || undefined,
          destination: finalLocation,
        });
      } catch (e) {
        console.error("Invalid URL or failed to add:", e);
      }
    }
    toggleAddModal(false);
  };

  const SummaryBox = ({ title, value, icon: Icon, color }: any) => (
    <div className="flex flex-col bg-bg-input/50 border border-border-modal/40 rounded-lg p-2.5 shadow-sm">
      <div className="flex items-center gap-1.5 text-text-muted mb-1">
        <Icon size={12} className={color} />
        <span className="text-[10px] font-bold uppercase tracking-wider">{title}</span>
      </div>
      <span className="text-sm font-semibold text-text-primary truncate">{value}</span>
    </div>
  );

  const requiredBytes = parsedItems.reduce((acc, item) => acc + (item.sizeBytes || 0), 0);
  const requiredStr = requiredBytes > 0 
    ? (requiredBytes < 1024 * 1024 ? `${(requiredBytes / 1024).toFixed(1)} KB` 
       : requiredBytes < 1024 * 1024 * 1024 ? `${(requiredBytes / 1024 / 1024).toFixed(1)} MB`
       : `${(requiredBytes / 1024 / 1024 / 1024).toFixed(2)} GB`)
    : 'Unknown';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md">
      <div className="w-[900px] h-[650px] bg-bg-modal border border-border-modal rounded-xl shadow-2xl flex flex-col overflow-hidden text-sm">
        
        {/* Main Content Split */}
        <div className="flex flex-1 overflow-hidden">
          
          {/* Left Column: URLs and Preview */}
          <div className="w-[55%] border-r border-border-modal flex flex-col bg-main-bg/50">
            <div className="p-5 flex-1 flex flex-col gap-5">
              
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-text-primary font-semibold">
                  <Link size={16} className="text-blue-500" />
                  Download Links
                </div>
                <textarea 
                  className="w-full h-32 bg-bg-input/80 border border-border-modal rounded-lg p-3 text-[13px] text-text-primary focus:outline-none focus:border-blue-500 resize-none font-mono shadow-inner transition-colors"
                  placeholder="Paste HTTP, HTTPS, FTP, or SFTP URLs here..."
                  value={urls}
                  onChange={(e) => setUrls(e.target.value)}
                />
                <div className="flex justify-between items-center px-1">
                  <span className="text-[11px] text-text-muted font-medium">{parsedItems.length} valid link(s) detected</span>
                  <button className="flex items-center gap-1.5 text-[11px] text-blue-500 hover:text-blue-400 font-medium">
                    <RefreshCw size={12} /> Refresh Metadata
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-3">
                <SummaryBox title="Files" value={parsedItems.length} icon={FileText} color="text-blue-500" />
                <SummaryBox title="Required" value={requiredStr} icon={Database} color="text-orange-500" />
                <SummaryBox title="Free" value={freeSpace} icon={HardDrive} color="text-green-500" />
                <SummaryBox title="Unknown" value={parsedItems.filter(i => !i.sizeBytes).length} icon={FileText} color="text-purple-500" />
              </div>

              <div className="flex flex-col gap-2 flex-1 overflow-hidden">
                <div className="flex items-center gap-2 text-text-primary font-semibold">
                  <ArrowRight size={16} className="text-blue-500" />
                  Preview
                </div>
                <div className="flex-1 border border-border-modal rounded-lg overflow-hidden bg-bg-input/30 flex flex-col">
                  <div className="bg-sidebar-bg/50 border-b border-border-modal px-3 py-2 flex text-[11px] font-semibold text-text-muted uppercase tracking-wider">
                    <div className="flex-[2]">File</div>
                    <div className="flex-1">Size</div>
                    <div className="flex-[1.5]">Status</div>
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {parsedItems.length === 0 ? (
                      <div className="h-full flex items-center justify-center text-text-muted text-xs italic">
                        No links added yet.
                      </div>
                    ) : (
                      parsedItems.map((item, i) => (
                        <div key={i} className="flex items-center text-xs px-2 py-1.5 hover:bg-item-hover rounded-md transition-colors">
                          <div className="flex-[2] text-text-primary font-medium truncate pr-2" title={item.file}>{item.file}</div>
                          <div className={`flex-1 font-mono ${item.status === 'Loading' ? 'text-text-muted/50' : 'text-text-muted'}`}>{item.size || 'Unknown'}</div>
                          <div className={`flex-[1.5] font-medium ${item.status === 'Error' ? 'text-red-500' : item.status === 'Loading' ? 'text-orange-400' : 'text-blue-500'}`}>
                            {item.status === 'Loading' ? (
                              <div className="flex items-center gap-1.5">
                                <RefreshCw size={12} className="animate-spin" /> Fetching...
                              </div>
                            ) : (
                              item.status || 'Ready'
                            )}
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
          <div className="w-[45%] flex flex-col overflow-y-auto bg-bg-modal">
            <div className="p-6 space-y-7">
              
              {/* Save Location */}
              <section>
                <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-3">
                  <FolderPlus size={16} className="text-blue-500" /> Save Location
                </div>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    readOnly 
                    value={saveLocation} 
                    className="flex-1 bg-bg-input border border-border-modal rounded-md px-3 py-1.5 text-xs text-text-muted font-mono" 
                  />
                  <button 
                    onClick={handleBrowse}
                    className="bg-item-hover hover:bg-item-hover/80 text-text-primary border border-border-modal px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                  >
                    Browse
                  </button>
                </div>
              </section>

              {/* Transfer Settings */}
              <section>
                <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-3">
                  <Settings size={16} className="text-blue-500" /> Transfer Settings
                </div>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-text-secondary font-medium">Connections per File</label>
                    <div className="flex items-center gap-2">
                      <input type="range" min="1" max="16" value={connections} onChange={e=>setConnections(Number(e.target.value))} className="w-24 accent-blue-500" />
                      <span className="text-xs text-text-primary font-mono w-4 text-right">{connections}</span>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-xs text-text-secondary font-medium cursor-pointer">
                      <input type="checkbox" checked={speedLimitEnabled} onChange={e=>setSpeedLimitEnabled(e.target.checked)} className="rounded border-border-modal text-blue-500 focus:ring-blue-500/20" />
                      Limit speed per file
                    </label>
                    {speedLimitEnabled && (
                      <div className="flex items-center gap-1.5">
                        <input type="number" value={speedLimit} onChange={e=>setSpeedLimit(e.target.value)} className="w-16 bg-bg-input border border-border-modal rounded px-2 py-1 text-xs font-mono text-text-primary focus:border-blue-500 focus:outline-none" />
                        <span className="text-[10px] text-text-muted">KiB/s</span>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* Authorization */}
              <section>
                <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-3">
                  <Shield size={16} className="text-blue-500" /> Authorization
                </div>
                <label className="flex items-center gap-2 text-xs text-text-secondary font-medium cursor-pointer mb-3">
                  <input type="checkbox" checked={useAuth} onChange={e=>setUseAuth(e.target.checked)} className="rounded border-border-modal text-blue-500 focus:ring-blue-500/20" />
                  Use authorization
                </label>
                
                {useAuth && (
                  <div className="space-y-2.5 pl-5 border-l-2 border-border-modal/50">
                    <input type="text" value={username} onChange={e=>setUsername(e.target.value)} placeholder="Username" className="w-full bg-bg-input border border-border-modal rounded-md px-3 py-1.5 text-xs text-text-primary focus:border-blue-500 focus:outline-none" />
                    <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password" className="w-full bg-bg-input border border-border-modal rounded-md px-3 py-1.5 text-xs text-text-primary focus:border-blue-500 focus:outline-none" />
                  </div>
                )}
              </section>

              {/* Advanced */}
              <section className="pt-2 border-t border-border-modal/50">
                <button 
                  onClick={() => setAdvancedExpanded(!advancedExpanded)}
                  className="flex items-center gap-2 text-sm font-semibold text-text-primary w-full hover:text-blue-500 transition-colors"
                >
                  {advancedExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  Advanced Transfer
                </button>
                
                {advancedExpanded && (
                  <div className="mt-4 space-y-4 pl-6">
                    <label className="flex items-center gap-2 text-xs text-text-secondary font-medium cursor-pointer">
                      <input type="checkbox" checked={checksumEnabled} onChange={e=>setChecksumEnabled(e.target.checked)} className="rounded border-border-modal text-blue-500 focus:ring-blue-500/20" />
                      Verify Checksum
                    </label>
                    
                    {checksumEnabled && (
                      <div className="flex gap-2">
                        <select value={checksumAlgo} onChange={e=>setChecksumAlgo(e.target.value)} className="w-24 bg-bg-input border border-border-modal rounded-md px-2 text-xs text-text-primary focus:border-blue-500 focus:outline-none">
                          <option>MD5</option><option>SHA-1</option><option>SHA-256</option>
                        </select>
                        <input type="text" value={checksumValue} onChange={e=>setChecksumValue(e.target.value)} placeholder="Expected digest" className="flex-1 bg-bg-input border border-border-modal rounded-md px-3 py-1.5 text-xs font-mono text-text-primary focus:border-blue-500 focus:outline-none" />
                      </div>
                    )}

                    <div>
                      <label className="block text-[10px] uppercase font-bold tracking-wider text-text-muted mb-1">Headers</label>
                      <textarea value={headers} onChange={e=>setHeaders(e.target.value)} className="w-full h-12 bg-bg-input border border-border-modal rounded-md px-3 py-1.5 text-xs font-mono text-text-primary focus:border-blue-500 focus:outline-none resize-none" />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase font-bold tracking-wider text-text-muted mb-1">Cookies</label>
                      <input type="text" value={cookies} onChange={e=>setCookies(e.target.value)} placeholder="name=value; other=value" className="w-full bg-bg-input border border-border-modal rounded-md px-3 py-1.5 text-xs font-mono text-text-primary focus:border-blue-500 focus:outline-none" />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase font-bold tracking-wider text-text-muted mb-1">Mirrors</label>
                      <textarea value={mirrors} onChange={e=>setMirrors(e.target.value)} className="w-full h-12 bg-bg-input border border-border-modal rounded-md px-3 py-1.5 text-xs font-mono text-text-primary focus:border-blue-500 focus:outline-none resize-none" />
                    </div>
                  </div>
                )}
              </section>

            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-sidebar-bg/50 border-t border-border-modal flex items-center shrink-0">
          <div className="text-[11px] text-text-muted font-medium flex-1">
            {parsedItems.length === 0 ? "Paste one or more links." : `Ready to add ${parsedItems.length} download(s).`}
          </div>
          <div className="flex gap-2.5">
            <button onClick={() => toggleAddModal(false)} className="px-4 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-item-hover transition-colors">
              Cancel
            </button>
            <button 
              onClick={() => handleStart(false)} 
              disabled={parsedItems.length === 0}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-item-hover text-text-primary border border-border-modal hover:bg-border-modal/40 transition-colors disabled:opacity-50"
            >
              Add to Queue
            </button>
            <button 
              onClick={() => handleStart(true)} 
              disabled={parsedItems.length === 0}
              className="px-5 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-500/20 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1.5"
            >
              <Play size={12} fill="currentColor" /> Start Downloads
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};

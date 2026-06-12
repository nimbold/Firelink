import { useState, useEffect } from 'react';
import { useDownloadStore } from '../store/useDownloadStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { X, FolderPlus, Settings, Shield, Globe, RefreshCw, FileText, HardDrive, Database, Link, ArrowRight, CheckCircle2, Play, ChevronDown, ChevronRight, Video } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

interface RawMediaFormat {
  format_id?: string;
  ext?: string;
  resolution?: string;
  format_note?: string;
  vcodec?: string;
  acodec?: string;
  height?: number;
  filesize?: number;
  filesize_approx?: number;
}

const isVideo = (f: RawMediaFormat) => {
  const vcodec = f.vcodec?.toLowerCase();
  return vcodec && vcodec !== 'none';
};

const isAudio = (f: RawMediaFormat) => {
  const acodec = f.acodec?.toLowerCase();
  const vcodec = f.vcodec?.toLowerCase();
  return acodec && acodec !== 'none' && (!vcodec || vcodec === 'none');
};

const formatSize = (f: RawMediaFormat) => f.filesize ?? f.filesize_approx ?? 0;

const matchesHeight = (f: RawMediaFormat, height: number | null) => {
  if (height === null) return true;
  
  const note = f.format_note || "";
  if (height === 2160 && (note.includes("2160p") || note.toLowerCase().includes("4k"))) return true;
  if (height === 1440 && note.includes("1440p")) return true;
  if (height === 1080 && note.includes("1080p")) return true;
  if (height === 720 && note.includes("720p")) return true;
  if (height === 480 && note.includes("480p")) return true;
  if (height === 360 && note.includes("360p")) return true;

  if (f.resolution) {
    const parts = f.resolution.split('x').map(n => parseInt(n, 10));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      const maxDim = Math.max(parts[0], parts[1]);
      switch (height) {
        case 2160: if (maxDim >= 3800) return true; break;
        case 1440: if (maxDim >= 2500 && maxDim < 3800) return true; break;
        case 1080: if (maxDim >= 1900 && maxDim < 2500) return true; break;
        case 720:  if (maxDim >= 1200 && maxDim < 1900) return true; break;
        case 480:  if (maxDim >= 800 && maxDim < 1200) return true; break;
        case 360:  if (maxDim >= 600 && maxDim < 800) return true; break;
      }
    }
  }

  const formatHeight = f.height;
  if (!formatHeight) return false;

  let tolerance = 100;
  if (height >= 2160) tolerance = 600;
  else if (height >= 1440) tolerance = 400;
  else if (height >= 1080) tolerance = 300;
  else if (height >= 720) tolerance = 200;

  return formatHeight <= height && formatHeight >= height - tolerance;
};

const hasVideoFormat = (formats: RawMediaFormat[], height: number | null, container: string) => {
  return formats.some(f => {
    if (!isVideo(f) || !matchesHeight(f, height)) return false;
    return container === 'mkv' || f.ext?.toLowerCase() === container.toLowerCase();
  });
};

const hasAudioFormat = (formats: RawMediaFormat[], ext: string | null) => {
  return formats.some(f => {
    if (!isAudio(f)) return false;
    if (!ext) return true;
    return f.ext?.toLowerCase() === ext.toLowerCase();
  });
};

const estimatedVideoBytes = (formats: RawMediaFormat[], height: number | null, container: string) => {
  let maxVideo = 0;
  for (const f of formats) {
    if (isVideo(f) && matchesHeight(f, height) && (container === 'mkv' || f.ext?.toLowerCase() === container.toLowerCase())) {
      const size = formatSize(f);
      if (size > maxVideo) maxVideo = size;
    }
  }
  if (maxVideo === 0) return null;

  let maxAudio = estimatedAudioBytes(formats, container === 'webm' ? 'webm' : 'm4a') || estimatedAudioBytes(formats, null) || 0;
  return maxVideo + maxAudio;
};

const estimatedAudioBytes = (formats: RawMediaFormat[], ext: string | null): number | null => {
  let maxPreferred = 0;
  for (const f of formats) {
    if (isAudio(f)) {
      if (!ext || f.ext?.toLowerCase() === ext.toLowerCase()) {
        const size = formatSize(f);
        if (size > maxPreferred) maxPreferred = size;
      }
    }
  }
  if (maxPreferred > 0 || !ext) return maxPreferred > 0 ? maxPreferred : null;
  return estimatedAudioBytes(formats, null);
};

const formatBytes = (bytes: number) => {
  if (bytes === 0) return 'Unknown size';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const parseMediaFormats = (jsonStr: string) => {
  try {
    const data = JSON.parse(jsonStr);
    let title = data.title || 'Media';
    title = title.replace(/[\/\\?%*:|"<>]/g, '-');
    const rawFormats: RawMediaFormat[] = data.formats || [];

    const options = [];

    const standardResolutions = [
      { h: 2160, name: "4K" },
      { h: 1440, name: "1440p" },
      { h: 1080, name: "1080p" },
      { h: 720, name: "720p" },
      { h: 480, name: "480p" },
      { h: 360, name: "360p" }
    ];

    const availableResolutions = standardResolutions.filter(res => 
      rawFormats.some(f => isVideo(f) && matchesHeight(f, res.h))
    );

    const videoQualities: { h: number | null, name: string }[] = [{ h: null, name: "Best" }, ...availableResolutions];
    const videoContainers = [
      { ext: "mp4", name: "MP4" },
      { ext: "mkv", name: "MKV" },
      { ext: "webm", name: "WebM" }
    ];

    for (const q of videoQualities) {
      for (const c of videoContainers) {
        if (!hasVideoFormat(rawFormats, q.h, c.ext)) continue;
        const est = estimatedVideoBytes(rawFormats, q.h, c.ext);
        const filter = q.h ? `[height<=${q.h}]` : '';
        
        let selector = `bestvideo${filter}+bestaudio/best${filter}`;
        if (c.ext === 'mp4') {
          selector = `bestvideo${filter}[ext=mp4]+bestaudio[ext=m4a]/best${filter}[ext=mp4]/bestvideo${filter}+bestaudio/best${filter}`;
        } else if (c.ext === 'webm') {
          selector = `bestvideo${filter}[ext=webm]+bestaudio[ext=webm]/best${filter}[ext=webm]/bestvideo${filter}+bestaudio/best${filter}`;
        }

        options.push({
          name: `${q.name} ${c.name}`,
          selector,
          ext: c.ext,
          detail: est ? `~${formatBytes(est)}` : '',
          type: 'Video',
          bytes: est || 0
        });
      }
    }

    if (hasAudioFormat(rawFormats, null)) {
      const est = estimatedAudioBytes(rawFormats, null);
      options.push({
        name: "Audio MP3",
        selector: "bestaudio/best",
        ext: "mp3",
        detail: est ? `~${formatBytes(est)}` : '',
        type: 'Audio',
        bytes: est || 0
      });
    }

    if (hasAudioFormat(rawFormats, "m4a")) {
      const est = estimatedAudioBytes(rawFormats, "m4a");
      options.push({
        name: "Audio M4A",
        selector: "bestaudio[ext=m4a]/bestaudio/best",
        ext: "m4a",
        detail: est ? `~${formatBytes(est)}` : '',
        type: 'Audio',
        bytes: est || 0
      });
    }

    if (hasAudioFormat(rawFormats, "webm") || hasAudioFormat(rawFormats, "opus")) {
      const est = estimatedAudioBytes(rawFormats, "webm") || estimatedAudioBytes(rawFormats, "opus");
      options.push({
        name: "Audio Opus",
        selector: "bestaudio[ext=webm]/bestaudio/best",
        ext: "opus",
        detail: est ? `~${formatBytes(est)}` : '',
        type: 'Audio',
        bytes: est || 0
      });
    }

    return { title, formats: options };
  } catch (e) {
    return null;
  }
};


export const AddDownloadsModal = () => {
  const { isAddModalOpen, toggleAddModal, addDownload } = useDownloadStore();
  const { defaultDownloadPath } = useSettingsStore();
  
  const [urls, setUrls] = useState('');
  const [extractMedia, setExtractMedia] = useState(false);
  const [parsedItems, setParsedItems] = useState<{
    url: string, 
    file: string, 
    size?: string, 
    sizeBytes?: number, 
    status?: string,
    isMedia?: boolean,
    formats?: { name: string, selector: string, ext: string, detail: string, type: string, bytes: number }[],
    selectedFormat?: number
  }[]>([]);
  
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
      setExtractMedia(false);
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
          if (extractMedia) {
            const { mediaCookieSource } = useSettingsStore.getState();
            const browserArg = mediaCookieSource !== 'none' ? mediaCookieSource : null;

            const jsonStr = await invoke<string>('fetch_media_metadata', { url, cookieBrowser: browserArg });
            const mediaData = parseMediaFormats(jsonStr);
            if (mediaData && mediaData.formats.length > 0) {
              updatedItems[i] = { 
                url, 
                file: `${mediaData.title}.${mediaData.formats[0].ext}`, 
                size: mediaData.formats[0].detail || 'Unknown (Media)', 
                sizeBytes: mediaData.formats[0].bytes, 
                status: 'Ready',
                isMedia: true,
                formats: mediaData.formats,
                selectedFormat: 0
              };
            } else {
              throw new Error("Invalid media metadata or no formats found");
            }
          } else {
            const meta = await invoke<{filename: string, size: string, size_bytes: number}>('fetch_metadata', { url });
            updatedItems[i] = { url, file: meta.filename, size: meta.size, sizeBytes: meta.size_bytes, status: 'Ready' };
          }
        } catch (e) {
          console.error("Meta fetch failed", e);
          updatedItems[i] = { ...updatedItems[i], size: 'Unknown', sizeBytes: 0, status: 'Error' };
        }
        setParsedItems([...updatedItems]);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [urls, extractMedia]); // Re-fetch if extractMedia toggles
  
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
        let finalFile = item.file;
        let formatSelector = undefined;
        
        if (item.isMedia && item.formats && item.selectedFormat !== undefined) {
          const selectedFormat = item.formats[item.selectedFormat];
          formatSelector = selectedFormat.selector;
          // Update extension if user selected a different format
          const baseName = finalFile.substring(0, finalFile.lastIndexOf('.')) || finalFile;
          finalFile = `${baseName}.${selectedFormat.ext}`;
        }

        addDownload({
          id,
          url: item.url,
          fileName: finalFile,
          status: startImmediately ? 'queued' : 'paused',
          category: item.isMedia ? 'Video' : 'Other',
          dateAdded: new Date().toISOString(),
          connections: Number(connections),
          speedLimit: speedLimitEnabled ? `${speedLimit}K` : undefined,
          username: useAuth ? username.trim() : undefined,
          password: useAuth ? password.trim() : undefined,
          headers: headers.trim() || undefined,
          destination: finalLocation,
          isMedia: item.isMedia,
          mediaFormatSelector: formatSelector
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
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-text-primary font-semibold">
                    <Link size={16} className="text-blue-500" />
                    Download Links
                  </div>
                  <label className="flex items-center gap-2 text-xs text-text-primary font-medium bg-item-hover px-2 py-1 rounded-md border border-border-modal cursor-pointer hover:bg-item-hover/80 transition-colors">
                    <input 
                      type="checkbox" 
                      checked={extractMedia} 
                      onChange={e => setExtractMedia(e.target.checked)} 
                      className="rounded border-border-modal text-blue-500 focus:ring-blue-500/20" 
                    />
                    <Video size={14} className="text-purple-500" />
                    Extract Media
                  </label>
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
                        <div key={i} className="flex flex-col text-xs px-2 py-1.5 hover:bg-item-hover rounded-md transition-colors group">
                          <div className="flex items-center w-full">
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
                          {item.isMedia && item.formats && (
                            <div className="mt-2 pl-2">
                              <select 
                                className="w-full bg-bg-input border border-border-modal rounded px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-purple-500"
                                value={item.selectedFormat}
                                onChange={(e) => {
                                  const newItems = [...parsedItems];
                                  const selIdx = parseInt(e.target.value, 10);
                                  newItems[i].selectedFormat = selIdx;
                                  newItems[i].size = newItems[i].formats?.[selIdx].detail || 'Unknown';
                                  newItems[i].sizeBytes = newItems[i].formats?.[selIdx].bytes || 0;
                                  setParsedItems(newItems);
                                }}
                              >
                                {item.formats.map((f, idx) => (
                                  <option key={idx} value={idx}>{f.name} {f.detail ? `(${f.detail})` : ''}</option>
                                ))}
                              </select>
                            </div>
                          )}
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
                      <input type="range" min="1" max="16" value={connections} onChange={e=>setConnections(Number(e.target.value))} className="w-24 accent-blue-500" disabled={extractMedia} />
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

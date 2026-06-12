import { useState, useEffect } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { 
  X, Download, Palette, Globe, Folder, Key, 
  Moon, Terminal, Puzzle, Info, Plus, Trash2, Copy, RefreshCw
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

type TabType = 'downloads' | 'lookandfeel' | 'network' | 'locations' | 'sitelogins' | 'power' | 'engine' | 'integrations' | 'about';

export const SettingsModal = () => {
  const settings = useSettingsStore();
  const [activeTab, setActiveTab] = useState<TabType>('downloads');

  // Local state for versions
  const [aria2Version, setAria2Version] = useState('Checking...');
  const [ytdlpVersion, setYtdlpVersion] = useState('Checking...');
  const [ffmpegVersion, setFfmpegVersion] = useState('Checking...');

  // Local state for adding site login
  const [loginPattern, setLoginPattern] = useState('');
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginError, setLoginError] = useState('');

  // Toast notifications
  const [toastMessage, setToastMessage] = useState('');

  useEffect(() => {
    if (toastMessage) {
      const t = setTimeout(() => setToastMessage(''), 2000);
      return () => clearTimeout(t);
    }
  }, [toastMessage]);

  // Fetch engine versions when Engine tab is opened
  useEffect(() => {
    if (settings.isSettingsModalOpen && activeTab === 'engine') {
      invoke<string>('test_aria2c')
        .then(v => setAria2Version(v))
        .catch(e => setAria2Version('Error: ' + e));

      invoke<string>('test_ytdlp')
        .then(v => setYtdlpVersion(v))
        .catch(e => setYtdlpVersion('Error: ' + e));

      invoke<string>('test_ffmpeg')
        .then(v => setFfmpegVersion(v))
        .catch(e => setFfmpegVersion('Error: ' + e));
    }
  }, [settings.isSettingsModalOpen, activeTab]);

  if (!settings.isSettingsModalOpen) return null;

  const showToast = (msg: string) => {
    setToastMessage(msg);
  };

  const handleBrowseCategory = async (category: string) => {
    const currentPath = (settings.downloadDirectories || {})[category] || '';
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: currentPath.startsWith('~') ? undefined : currentPath
      });
      if (selected && typeof selected === 'string') {
        settings.setCategoryDirectory(category, selected);
      }
    } catch (e) {
      console.error(`Failed to select folder for ${category}:`, e);
    }
  };

  const handleBrowseBulk = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false
      });
      if (selected && typeof selected === 'string') {
        // Automatically populate all category folders
        const cleanBase = selected.endsWith('/') ? selected.slice(0, -1) : selected;
        settings.setCategoryDirectory('Video', `${cleanBase}/Video`);
        settings.setCategoryDirectory('Audio', `${cleanBase}/Audio`);
        settings.setCategoryDirectory('Documents', `${cleanBase}/Documents`);
        settings.setCategoryDirectory('Apps', `${cleanBase}/Apps`);
        settings.setCategoryDirectory('Images', `${cleanBase}/Images`);
        settings.setCategoryDirectory('Archives', `${cleanBase}/Archives`);
        settings.setCategoryDirectory('Other', `${cleanBase}/Other`);
        showToast("Created subfolders for all categories");
      }
    } catch (e) {
      console.error("Failed to browse base path:", e);
    }
  };

  const handleAddLogin = () => {
    if (!loginPattern.trim() || !loginUser.trim()) {
      setLoginError("Please enter a URL pattern and a username.");
      return;
    }
    const id = crypto.randomUUID();
    settings.addSiteLogin({
      id,
      urlPattern: loginPattern.trim(),
      username: loginUser.trim(),
      password: loginPass
    });
    setLoginPattern('');
    setLoginUser('');
    setLoginPass('');
    setLoginError('');
    showToast("Added site credential");
  };

  const copyToken = () => {
    navigator.clipboard.writeText(settings.extensionPairingToken);
    showToast("Token copied to clipboard!");
  };

  const TabButton = ({ type, icon: Icon, label }: { type: TabType; icon: any; label: string }) => {
    const active = activeTab === type;
    return (
      <button
        onClick={() => setActiveTab(type)}
        className={`flex flex-col items-center justify-center p-2 rounded-lg transition-all text-center min-w-[76px] cursor-default ${
          active 
            ? 'bg-blue-600/15 text-blue-500 font-semibold' 
            : 'text-text-secondary hover:bg-item-hover hover:text-text-primary'
        }`}
      >
        <Icon size={18} className="mb-1" />
        <span className="text-[10px] whitespace-nowrap">{label}</span>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[840px] h-[640px] bg-bg-modal border border-border-modal rounded-xl shadow-2xl flex flex-col overflow-hidden relative">
        
        {/* Toast Notification */}
        {toastMessage && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[13px] font-medium py-2 px-4 rounded-full shadow-lg z-50 animate-bounce">
            {toastMessage}
          </div>
        )}

        {/* Header (Horizontal Tab Bar) */}
        <div className="flex flex-col border-b border-border-modal bg-sidebar-bg/50">
          <div className="flex items-center justify-between p-3 pl-4 border-b border-border-modal/50">
            <h2 className="text-sm font-semibold tracking-wide text-text-primary">Preferences</h2>
            <button onClick={() => settings.toggleSettingsModal(false)} className="text-text-muted hover:text-text-primary transition-colors">
              <X size={18} />
            </button>
          </div>
          <div className="flex items-center gap-1.5 p-2 overflow-x-auto justify-center">
            <TabButton type="downloads" icon={Download} label="Downloads" />
            <TabButton type="lookandfeel" icon={Palette} label="Look & Feel" />
            <TabButton type="network" icon={Globe} label="Network" />
            <TabButton type="locations" icon={Folder} label="Locations" />
            <TabButton type="sitelogins" icon={Key} label="Site Logins" />
            <TabButton type="power" icon={Moon} label="Power" />
            <TabButton type="engine" icon={Terminal} label="Engine" />
            <TabButton type="integrations" icon={Puzzle} label="Integrations" />
            <TabButton type="about" icon={Info} label="About" />
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6 bg-main-bg/10">
          
          {/* Downloads Pane */}
          {activeTab === 'downloads' && (
            <div className="space-y-6 max-w-xl mx-auto">
              <h3 className="text-base font-bold text-text-primary border-b border-border-color/30 pb-2">Download Options</h3>
              
              <div className="grid grid-cols-[180px_1fr] items-center gap-4 text-[13px]">
                <label className="text-text-secondary font-medium">Parallel downloads:</label>
                <div className="flex items-center gap-4">
                  <input 
                    type="range" min="1" max="12" 
                    value={settings.maxConcurrentDownloads}
                    onChange={(e) => settings.setMaxConcurrentDownloads(Number(e.target.value))}
                    className="flex-1 accent-blue-500"
                  />
                  <span className="w-8 text-center font-mono font-bold bg-item-hover px-2 py-1 rounded border border-border-modal text-text-secondary">
                    {settings.maxConcurrentDownloads}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-[180px_1fr] items-center gap-4 text-[13px]">
                <label className="text-text-secondary font-medium">Default connections:</label>
                <div className="flex items-center gap-4">
                  <input 
                    type="number" min="1" max="16" 
                    value={settings.perServerConnections}
                    onChange={(e) => settings.setPerServerConnections(Number(e.target.value))}
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-24 text-text-primary focus:outline-none focus:border-blue-500"
                  />
                  <span className="text-text-muted text-xs">For new downloads (1 to 16)</span>
                </div>
              </div>

              <div className="grid grid-cols-[180px_1fr] items-center gap-4 text-[13px]">
                <label className="text-text-secondary font-medium">Global speed limit:</label>
                <div className="flex items-center gap-4">
                  <input 
                    type="text" 
                    value={settings.globalSpeedLimit}
                    onChange={(e) => settings.setGlobalSpeedLimit(e.target.value)}
                    placeholder="Unlimited"
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-32 font-mono text-text-primary focus:outline-none focus:border-blue-500"
                  />
                  <span className="text-text-muted text-xs">e.g. 500K, 1M, or 0 for unlimited</span>
                </div>
              </div>

              <div className="grid grid-cols-[180px_1fr] items-center gap-4 text-[13px]">
                <label className="text-text-secondary font-medium">Automatic retries:</label>
                <div className="flex items-center gap-4">
                  <input 
                    type="number" min="0" max="10" 
                    value={settings.maxAutomaticRetries}
                    onChange={(e) => settings.setMaxAutomaticRetries(Number(e.target.value))}
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-24 text-text-primary focus:outline-none focus:border-blue-500"
                  />
                  <span className="text-text-muted text-xs">If a connection fails (0 to 10)</span>
                </div>
              </div>

              <div className="border-t border-border-color/30 pt-4 space-y-3">
                <label className="flex items-start gap-3 cursor-default select-none text-[13px] text-text-secondary">
                  <input 
                    type="checkbox" 
                    checked={settings.showNotifications}
                    onChange={(e) => settings.setShowNotifications(e.target.checked)}
                    className="mt-0.5 rounded accent-blue-500"
                  />
                  <div>
                    <p className="font-semibold text-text-primary">Show notification when download completes</p>
                    <p className="text-text-muted text-xs mt-0.5">Alerts you in the System Notification Center</p>
                  </div>
                </label>

                <label className="flex items-start gap-3 cursor-default select-none text-[13px] text-text-secondary pl-6">
                  <input 
                    type="checkbox" 
                    checked={settings.playCompletionSound && settings.showNotifications}
                    disabled={!settings.showNotifications}
                    onChange={(e) => settings.setPlayCompletionSound(e.target.checked)}
                    className="mt-0.5 rounded accent-blue-500 disabled:opacity-40"
                  />
                  <div>
                    <p className={`font-semibold ${settings.showNotifications ? 'text-text-primary' : 'text-text-muted'}`}>Play sound when download completes</p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* Look & Feel Pane */}
          {activeTab === 'lookandfeel' && (
            <div className="space-y-6 max-w-xl mx-auto">
              <h3 className="text-base font-bold text-text-primary border-b border-border-color/30 pb-2">Appearance Settings</h3>
              
              <div className="grid grid-cols-[180px_1fr] items-start gap-4 text-[13px]">
                <label className="text-text-secondary font-medium pt-1">App Theme:</label>
                <div className="space-y-2">
                  {['system', 'dark', 'light', 'dracula', 'nord'].map((t) => (
                    <label key={t} className="flex items-center gap-2 cursor-default select-none text-text-secondary capitalize">
                      <input 
                        type="radio" 
                        name="themeRadio" 
                        value={t}
                        checked={settings.theme === t}
                        onChange={() => settings.setTheme(t as any)}
                        className="accent-blue-500"
                      />
                      {t === 'system' ? 'System Default' : t}
                    </label>
                  ))}
                  <p className="text-text-muted text-xs mt-2">Select a color palette for the app's user interface.</p>
                </div>
              </div>

              <div className="grid grid-cols-[180px_1fr] items-center gap-4 text-[13px]">
                <label className="text-text-secondary font-medium">Font Size:</label>
                <select 
                  value={settings.appFontSize} 
                  onChange={(e) => settings.setAppFontSize(e.target.value as any)}
                  className="bg-bg-input border border-border-modal rounded-lg p-2 text-[13px] text-text-primary focus:outline-none focus:border-blue-500 max-w-[200px]"
                >
                  <option value="standard">Standard</option>
                  <option value="large">Large</option>
                  <option value="extra-large">Extra Large</option>
                </select>
              </div>

              <div className="grid grid-cols-[180px_1fr] items-center gap-4 text-[13px]">
                <label className="text-text-secondary font-medium">List Row Density:</label>
                <select 
                  value={settings.listRowDensity} 
                  onChange={(e) => settings.setListRowDensity(e.target.value as any)}
                  className="bg-bg-input border border-border-modal rounded-lg p-2 text-[13px] text-text-primary focus:outline-none focus:border-blue-500 max-w-[200px]"
                >
                  <option value="compact">Compact</option>
                  <option value="standard">Standard</option>
                  <option value="spacious">Spacious</option>
                </select>
              </div>

              <div className="border-t border-border-color/30 pt-4 space-y-3">
                <label className="flex items-start gap-3 cursor-default select-none text-[13px] text-text-secondary">
                  <input 
                    type="checkbox" 
                    checked={settings.showNotifications} // mapped to dock badge placeholder
                    className="mt-0.5 rounded accent-blue-500"
                  />
                  <div>
                    <p className="font-semibold text-text-primary">Show badge on Dock/Taskbar icon</p>
                    <p className="text-text-muted text-xs mt-0.5">Displays the number of active downloads on the icon badge.</p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* Network Pane */}
          {activeTab === 'network' && (
            <div className="space-y-6 max-w-xl mx-auto">
              <h3 className="text-base font-bold text-text-primary border-b border-border-color/30 pb-2">Proxy & User Agent</h3>
              
              <div className="grid grid-cols-[180px_1fr] items-start gap-4 text-[13px]">
                <label className="text-text-secondary font-medium pt-1">Proxy Mode:</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-default select-none text-text-secondary">
                    <input 
                      type="radio" name="proxyMode" value="none"
                      checked={settings.proxyMode === 'none'}
                      onChange={() => settings.setProxyMode('none')}
                      className="accent-blue-500"
                    />
                    No proxy
                  </label>
                  <label className="flex items-center gap-2 cursor-default select-none text-text-secondary">
                    <input 
                      type="radio" name="proxyMode" value="system"
                      checked={settings.proxyMode === 'system'}
                      onChange={() => settings.setProxyMode('system')}
                      className="accent-blue-500"
                    />
                    Use system proxy
                  </label>
                  <label className="flex items-center gap-2 cursor-default select-none text-text-secondary">
                    <input 
                      type="radio" name="proxyMode" value="custom"
                      checked={settings.proxyMode === 'custom'}
                      onChange={() => settings.setProxyMode('custom')}
                      className="accent-blue-500"
                    />
                    Set proxy
                  </label>
                </div>
              </div>

              {settings.proxyMode === 'custom' && (
                <div className="bg-item-hover/30 border border-border-modal rounded-lg p-4 pl-6 space-y-4 max-w-[420px] ml-[180px]">
                  <div className="grid grid-cols-[80px_1fr] items-center gap-2 text-[13px]">
                    <label className="text-text-secondary">Host:</label>
                    <input 
                      type="text" 
                      value={settings.proxyHost} 
                      onChange={(e) => settings.setProxyHost(e.target.value)} 
                      placeholder="127.0.0.1" 
                      className="bg-bg-input border border-border-modal rounded-md px-3 py-1 text-text-primary font-mono text-xs focus:outline-none"
                    />
                  </div>
                  <div className="grid grid-cols-[80px_1fr] items-center gap-2 text-[13px]">
                    <label className="text-text-secondary">Port:</label>
                    <input 
                      type="number" 
                      value={settings.proxyPort} 
                      onChange={(e) => settings.setProxyPort(Number(e.target.value))} 
                      className="bg-bg-input border border-border-modal rounded-md px-3 py-1 text-text-primary font-mono text-xs w-[100px] focus:outline-none"
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-[180px_1fr] items-center gap-4 text-[13px] border-t border-border-color/30 pt-4">
                <label className="text-text-secondary font-medium">User Agent:</label>
                <div className="space-y-1">
                  <input 
                    type="text" 
                    value={settings.customUserAgent}
                    onChange={(e) => settings.setCustomUserAgent(e.target.value)}
                    placeholder="e.g. Mozilla/5.0..."
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-full font-mono text-[11px] text-text-primary focus:outline-none focus:border-blue-500"
                  />
                  <p className="text-text-muted text-xs">Spoofs browser User-Agent to bypass download restrictions. Leave blank for default.</p>
                </div>
              </div>
            </div>
          )}

          {/* Locations Pane */}
          {activeTab === 'locations' && (
            <div className="space-y-6 max-w-xl mx-auto">
              <h3 className="text-base font-bold text-text-primary border-b border-border-color/30 pb-2">Download Directories</h3>

              <label className="flex items-start gap-3 cursor-default select-none text-[13px] text-text-secondary">
                <input 
                  type="checkbox" 
                  checked={settings.askWhereToSaveEachFile}
                  onChange={(e) => settings.setAskWhereToSaveEachFile(e.target.checked)}
                  className="mt-0.5 rounded accent-blue-500"
                />
                <div>
                  <p className="font-semibold text-text-primary">Ask where to save each file before downloading</p>
                  <p className="text-text-muted text-xs mt-0.5">When enabled, you choose the download location each time you add links.</p>
                </div>
              </label>

              <div className="space-y-4 border-t border-border-color/30 pt-4">
                <h4 className="text-[13px] font-bold text-text-primary">Default Categories Paths</h4>

                {/* Bulk Directory Selector */}
                <div className="grid grid-cols-[150px_1fr] items-center gap-4 text-[13px] bg-item-hover/35 p-3 rounded-lg border border-border-modal/40">
                  <label className="font-semibold text-text-primary">All Categories Base:</label>
                  <div className="flex gap-2">
                    <input 
                      type="text" readOnly placeholder="Choose base folder to sub-categorize..."
                      className="flex-1 bg-bg-input border border-border-modal rounded-md px-3 py-1 text-xs text-text-muted"
                    />
                    <button 
                      onClick={handleBrowseBulk}
                      className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded-md text-xs font-semibold shadow transition-colors"
                    >
                      Choose Base
                    </button>
                  </div>
                </div>

                {Object.keys(settings.downloadDirectories || {}).map((category) => (
                  <div key={category} className="grid grid-cols-[150px_1fr] items-center gap-4 text-[13px]">
                    <label className="text-text-secondary capitalize">{category} folder:</label>
                    <div className="flex gap-2">
                      <input 
                        type="text" 
                        value={(settings.downloadDirectories || {})[category]} 
                        onChange={(e) => settings.setCategoryDirectory(category, e.target.value)}
                        className="flex-1 bg-bg-input border border-border-modal rounded-md px-3 py-1 text-xs text-text-primary font-mono"
                      />
                      <button 
                        onClick={() => handleBrowseCategory(category)}
                        className="bg-item-hover hover:bg-item-hover/80 text-text-primary border border-border-modal px-2.5 py-1 rounded-md text-xs"
                      >
                        Choose
                      </button>
                    </div>
                  </div>
                ))}

                <div className="flex justify-end gap-2 pt-2 border-t border-border-color/30">
                  <button 
                    onClick={() => {
                      settings.resetCategoryDirectories();
                      showToast("Reset directories to default");
                    }}
                    className="bg-item-hover hover:bg-item-hover/80 text-text-primary border border-border-modal px-4 py-1.5 rounded-md text-xs"
                  >
                    Reset Defaults
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Site Logins Pane */}
          {activeTab === 'sitelogins' && (
            <div className="space-y-6 max-w-xl mx-auto">
              <h3 className="text-base font-bold text-text-primary border-b border-border-color/30 pb-2">Site Credentials</h3>
              
              {/* Site Logins List */}
              <div className="space-y-2 max-h-[200px] overflow-y-auto border border-border-modal rounded-lg p-2 bg-item-hover/10">
                {(settings.siteLogins || []).length === 0 ? (
                  <p className="text-center text-text-muted text-[13px] py-6">No saved logins.</p>
                ) : (
                  (settings.siteLogins || []).map((login) => (
                    <div key={login.id} className="flex justify-between items-center p-2 rounded bg-bg-modal border border-border-modal/40">
                      <div className="text-[13px] space-y-0.5">
                        <p className="font-bold text-text-primary font-mono text-[11px]">{login.urlPattern}</p>
                        <p className="text-text-secondary text-xs">User: {login.username}</p>
                      </div>
                      <button 
                        onClick={() => {
                          settings.removeSiteLogin(login.id);
                          showToast("Deleted credential");
                        }}
                        className="p-1.5 hover:bg-item-hover rounded-md text-text-muted hover:text-red-500"
                        title="Delete credential"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Add Site Login Form */}
              <div className="border-t border-border-color/30 pt-4 space-y-4">
                <h4 className="text-[13px] font-bold text-text-primary">Add Site Credentials</h4>
                
                {loginError && (
                  <p className="text-red-500 text-xs">{loginError}</p>
                )}

                <div className="grid grid-cols-[150px_1fr] items-center gap-4 text-[13px]">
                  <label className="text-text-secondary">URL Pattern:</label>
                  <input 
                    type="text" 
                    value={loginPattern}
                    onChange={(e) => setLoginPattern(e.target.value)}
                    placeholder="e.g. *.example.com or example.com/downloads"
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-full text-text-primary focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-[150px_1fr] items-center gap-4 text-[13px]">
                  <label className="text-text-secondary">Username:</label>
                  <input 
                    type="text" 
                    value={loginUser}
                    onChange={(e) => setLoginUser(e.target.value)}
                    placeholder="Username"
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-full text-text-primary focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-[150px_1fr] items-center gap-4 text-[13px]">
                  <label className="text-text-secondary">Password:</label>
                  <input 
                    type="password" 
                    value={loginPass}
                    onChange={(e) => setLoginPass(e.target.value)}
                    placeholder="Password"
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-full text-text-primary focus:outline-none"
                  />
                </div>

                <div className="flex justify-end pt-2">
                  <button 
                    onClick={handleAddLogin}
                    className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-lg text-xs font-semibold shadow flex items-center gap-1.5"
                  >
                    <Plus size={14} /> Add Login
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Power Pane */}
          {activeTab === 'power' && (
            <div className="space-y-6 max-w-xl mx-auto">
              <h3 className="text-base font-bold text-text-primary border-b border-border-color/30 pb-2">Power Management</h3>
              
              <label className="flex items-start gap-3 cursor-default select-none text-[13px] text-text-secondary">
                <input 
                  type="checkbox" 
                  checked={settings.preventsSleepWhileDownloading}
                  onChange={(e) => settings.setPreventsSleepWhileDownloading(e.target.checked)}
                  className="mt-0.5 rounded accent-blue-500"
                />
                <div>
                  <p className="font-semibold text-text-primary">Prevent system sleep while downloads are active</p>
                  <p className="text-text-muted text-xs mt-0.5">The display may still turn off. Firelink only keeps the device awake enough to complete active transfers.</p>
                </div>
              </label>
            </div>
          )}

          {/* Engine Pane */}
          {activeTab === 'engine' && (
            <div className="space-y-6 max-w-xl mx-auto">
              <h3 className="text-base font-bold text-text-primary border-b border-border-color/30 pb-2">Media Downloader & Engines</h3>
              
              <div className="space-y-4">
                <div className="border border-border-modal rounded-lg p-4 space-y-3 bg-item-hover/5">
                  <h4 className="text-[13px] font-bold text-text-primary flex items-center gap-2 border-b border-border-modal pb-1">
                    <Terminal size={14} className="text-blue-500" /> Core Downloader (Aria2)
                  </h4>
                  <div className="grid grid-cols-[120px_1fr] text-[13px]">
                    <span className="text-text-secondary">Version:</span>
                    <span className="font-mono text-xs text-text-muted select-all">{aria2Version}</span>
                  </div>
                  <div className="grid grid-cols-[120px_1fr] text-[13px] items-center">
                    <span className="text-text-secondary">Status:</span>
                    <span className="text-green-500 font-medium">Ready</span>
                  </div>
                </div>

                <div className="border border-border-modal rounded-lg p-4 space-y-3 bg-item-hover/5">
                  <h4 className="text-[13px] font-bold text-text-primary flex items-center gap-2 border-b border-border-modal pb-1">
                    <Terminal size={14} className="text-orange-500" /> Media Extractors
                  </h4>
                  <div className="grid grid-cols-[120px_1fr] text-[13px] pb-1">
                    <span className="text-text-secondary font-semibold">yt-dlp:</span>
                    <span className="font-mono text-xs text-text-muted select-all">{ytdlpVersion}</span>
                  </div>
                  <div className="grid grid-cols-[120px_1fr] text-[13px] pb-1">
                    <span className="text-text-secondary font-semibold">FFmpeg:</span>
                    <span className="font-mono text-xs text-text-muted select-all">{ffmpegVersion}</span>
                  </div>
                  <div className="grid grid-cols-[120px_1fr] text-[13px] pb-1">
                    <span className="text-text-secondary font-semibold">Deno:</span>
                    <span className="text-red-500 text-xs font-semibold">Not Installed (Local Extension Only)</span>
                  </div>

                  <div className="grid grid-cols-[180px_1fr] items-center gap-4 text-[13px] border-t border-border-modal/50 pt-3 mt-2">
                    <label className="text-text-secondary font-semibold">Browser Cookies Source:</label>
                    <select 
                      value={settings.mediaCookieSource} 
                      onChange={(e) => settings.setMediaCookieSource(e.target.value as any)}
                      className="bg-bg-input border border-border-modal rounded-lg p-1.5 text-[13px] text-text-primary focus:outline-none focus:border-blue-500"
                    >
                      <option value="none">None</option>
                      <option value="safari">Safari</option>
                      <option value="chrome">Chrome</option>
                      <option value="firefox">Firefox</option>
                      <option value="edge">Edge</option>
                      <option value="brave">Brave</option>
                    </select>
                  </div>
                  <p className="text-text-muted text-xs mt-1">yt-dlp reads browser cookies to bypass video download limits or access restricted media. Firelink does not save browser cookies.</p>
                </div>
              </div>
            </div>
          )}

          {/* Integrations Pane */}
          {activeTab === 'integrations' && (
            <div className="space-y-6 max-w-xl mx-auto">
              <div className="flex items-center gap-3 border-b border-border-color/30 pb-3">
                <Puzzle size={28} className="text-orange-500" />
                <div>
                  <h3 className="text-base font-bold text-text-primary">Connect Browser Extension</h3>
                  <p className="text-text-secondary text-xs">Capture downloads directly from your browser in three easy steps.</p>
                </div>
              </div>

              {/* Step Guide Cards */}
              <div className="grid grid-cols-3 gap-4">
                
                {/* Step 1 */}
                <div className="border border-border-modal rounded-lg p-4 bg-item-hover/5 flex flex-col justify-between h-[190px]">
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <span className="bg-blue-600/25 text-blue-500 font-bold rounded-full w-5 h-5 flex items-center justify-center text-xs">1</span>
                      <Copy size={16} className="text-blue-500" />
                    </div>
                    <h4 className="text-[13px] font-bold text-text-primary mb-1">Copy Token</h4>
                    <p className="text-text-muted text-[11px] leading-relaxed">This secure token authorizes your browser extension.</p>
                  </div>
                  <div className="space-y-2">
                    <button 
                      onClick={copyToken}
                      className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 shadow transition-colors"
                    >
                      <Copy size={11} /> Copy Token
                    </button>
                    <button 
                      onClick={() => {
                        settings.regeneratePairingToken();
                        showToast("Pairing token regenerated");
                      }}
                      className="w-full bg-item-hover hover:bg-item-hover/80 text-text-primary border border-border-modal font-medium py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 transition-colors"
                    >
                      <RefreshCw size={11} /> Regenerate
                    </button>
                  </div>
                </div>

                {/* Step 2 */}
                <div className="border border-border-modal rounded-lg p-4 bg-item-hover/5 flex flex-col justify-between h-[190px]">
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <span className="bg-orange-600/25 text-orange-500 font-bold rounded-full w-5 h-5 flex items-center justify-center text-xs">2</span>
                      <Globe size={16} className="text-orange-500" />
                    </div>
                    <h4 className="text-[13px] font-bold text-text-primary mb-1">Get Extension</h4>
                    <p className="text-text-muted text-[11px] leading-relaxed">Install the Firelink Companion extension on your browser.</p>
                  </div>
                  <div className="space-y-2">
                    <a 
                      href="https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/" 
                      target="_blank" rel="noreferrer"
                      className="w-full bg-item-hover hover:bg-item-hover/80 text-text-primary border border-border-modal font-medium py-1 px-2 rounded text-[11px] block text-center transition-colors"
                    >
                      Firefox Add-ons
                    </a>
                    <a 
                      href="https://github.com/nimbold/Firelink-Extension/releases" 
                      target="_blank" rel="noreferrer"
                      className="w-full bg-item-hover hover:bg-item-hover/80 text-text-primary border border-border-modal font-medium py-1 px-2 rounded text-[11px] block text-center transition-colors"
                    >
                      GitHub Releases
                    </a>
                  </div>
                </div>

                {/* Step 3 */}
                <div className="border border-border-modal rounded-lg p-4 bg-item-hover/5 flex flex-col h-[190px]">
                  <div className="flex justify-between items-center mb-2">
                    <span className="bg-green-600/25 text-green-500 font-bold rounded-full w-5 h-5 flex items-center justify-center text-xs">3</span>
                    <Puzzle size={16} className="text-green-500" />
                  </div>
                  <h4 className="text-[13px] font-bold text-text-primary mb-1">Paste & Connect</h4>
                  <p className="text-text-muted text-[11px] leading-relaxed">Click the Firelink icon in your browser's toolbar and paste thecopied token.</p>
                </div>
              </div>

              {/* Status Info */}
              <div className="border border-border-modal/70 rounded-lg p-3 bg-item-hover/10 flex justify-between items-center text-[12px]">
                <span className="text-text-secondary font-medium">Extension Server Status:</span>
                <span className="text-green-500 font-semibold flex items-center gap-1">
                  ● Listening on 127.0.0.1:23522 (Active)
                </span>
              </div>
            </div>
          )}

          {/* About Pane */}
          {activeTab === 'about' && (
            <div className="space-y-6 max-w-md mx-auto text-center py-6">
              <div className="w-16 h-16 bg-blue-600 text-white font-extrabold text-2xl flex items-center justify-center rounded-2xl mx-auto shadow-lg shadow-blue-500/20">
                FL
              </div>
              <div className="space-y-2">
                <h3 className="text-lg font-bold text-text-primary">Firelink Desktop</h3>
                <p className="text-text-secondary text-sm">Version 0.8.0-rewrite (Tauri v2)</p>
                <p className="text-text-muted text-xs leading-relaxed max-w-sm mx-auto">
                  A high-speed, cross-platform download engine rebuilt in Rust, React, and Tailwind, replicating the premium SwiftUI native look.
                </p>
              </div>

              <div className="border-t border-border-color/30 pt-4 flex justify-center gap-4 text-xs text-blue-500">
                <a href="https://github.com/nimbold/Firelink" target="_blank" rel="noreferrer" className="hover:underline">GitHub Repository</a>
                <span>•</span>
                <a href="https://github.com/nimbold/Firelink/issues" target="_blank" rel="noreferrer" className="hover:underline">Report Issues</a>
              </div>
              <p className="text-[10px] text-text-muted pt-2">© 2026 Firelink Project. Released under the MIT License.</p>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border-modal bg-sidebar-bg/50 flex justify-end gap-3">
          <button 
            onClick={() => settings.toggleSettingsModal(false)} 
            className="px-5 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20 transition-all active:scale-95"
          >
            Done
          </button>
        </div>

      </div>
    </div>
  );
};

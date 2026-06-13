import { useState, useEffect } from 'react';
import { SettingsTab, useSettingsStore } from '../store/useSettingsStore';
import {
  Download, Palette, Globe, Folder, Key,
  Moon, Terminal, Puzzle, Info, Plus, Trash2, Copy, RefreshCw, Code
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { WindowDragRegion } from './WindowDragRegion';
import appIcon from '../assets/app-icon.png';

const settingsTabs: { type: SettingsTab; label: string; icon: typeof Download }[] = [
  { type: 'downloads', label: 'Downloads', icon: Download },
  { type: 'lookandfeel', label: 'Look and feel', icon: Palette },
  { type: 'network', label: 'Network', icon: Globe },
  { type: 'locations', label: 'Locations', icon: Folder },
  { type: 'sitelogins', label: 'Site Logins', icon: Key },
  { type: 'power', label: 'Power', icon: Moon },
  { type: 'engine', label: 'Engine', icon: Terminal },
  { type: 'integrations', label: 'Integrations', icon: Puzzle },
  { type: 'about', label: 'About', icon: Info },
];

interface AvailableReleaseUpdate {
  version: string;
  tag_name: string;
  title: string;
  release_notes: string;
  release_url: string;
  published_at: string | null;
}

type ReleaseCheckOutcome =
  | { type: 'UpdateAvailable'; update: AvailableReleaseUpdate }
  | { type: 'UpToDate'; latest_version: string; local_version: string };

export default function SettingsView() {
  const settings = useSettingsStore();
  const activeTab = settings.activeSettingsTab;

  // Local state for versions
  const [aria2Version, setAria2Version] = useState<string>('Checking...');
  const [ytdlpVersion, setYtdlpVersion] = useState<string>('Checking...');
  const [ffmpegVersion, setFfmpegVersion] = useState<string>('Checking...');
  const [denoVersion, setDenoVersion] = useState<string>('Checking...');

  const getEngineStatus = (v: string) => {
    if (v === 'Checking...') return <span className="text-text-muted font-medium">Checking...</span>;
    if (v.startsWith('Error')) return <span className="text-red-500 font-medium">Error / Missing</span>;
    return <span className="text-green-500 font-medium">Ready</span>;
  };

  // Local state for adding site login
  const [loginPattern, setLoginPattern] = useState('');
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginError, setLoginError] = useState('');

  // Toast notifications
  const [toastMessage, setToastMessage] = useState('');
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false);

  useEffect(() => {
    if (toastMessage) {
      const t = setTimeout(() => setToastMessage(''), 2000);
      return () => clearTimeout(t);
    }
  }, [toastMessage]);

  // Fetch engine versions when Engine tab is opened
  useEffect(() => {
    if (settings.activeView === 'settings' && activeTab === 'engine') {
      invoke<string>('test_aria2c')
        .then(v => setAria2Version(v))
        .catch(e => setAria2Version('Error: ' + e));

      invoke<string>('test_ytdlp')
        .then(v => setYtdlpVersion(v))
        .catch(e => setYtdlpVersion('Error: ' + e));

      invoke<string>('test_ffmpeg')
        .then(v => setFfmpegVersion(v))
        .catch(e => setFfmpegVersion('Error: ' + e));

      invoke<string>('test_deno')
        .then(v => setDenoVersion(v))
        .catch(e => setDenoVersion('Error: ' + e));
    }
  }, [settings.activeView, activeTab]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
  };

  const handleCheckForUpdates = async () => {
    if (isCheckingForUpdates) return;

    setIsCheckingForUpdates(true);
    showToast('Checking for updates...');

    try {
      const result = await invoke<ReleaseCheckOutcome>('check_for_updates');

      if (result.type === 'UpToDate') {
        showToast(`Firelink ${result.latest_version} is up to date`);
      } else if (result.type === 'UpdateAvailable') {
        showToast(`Firelink ${result.update.version} is available`);
      } else {
        showToast('The update check returned an unexpected response');
      }
    } catch (error) {
      showToast(`Update check failed: ${String(error)}`);
    } finally {
      setIsCheckingForUpdates(false);
    }
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
      const base = await open({
        directory: true,
        multiple: false
      });
      if (base && typeof base === 'string') {
        const cleanBase = base.replace(/\/$/, '');
        settings.setCategoryDirectory('Musics', `${cleanBase}/Musics`);
        settings.setCategoryDirectory('Movies', `${cleanBase}/Movies`);
        settings.setCategoryDirectory('Compressed', `${cleanBase}/Compressed`);
        settings.setCategoryDirectory('Documents', `${cleanBase}/Documents`);
        settings.setCategoryDirectory('Pictures', `${cleanBase}/Pictures`);
        settings.setCategoryDirectory('Applications', `${cleanBase}/Applications`);
        settings.setCategoryDirectory('Other', `${cleanBase}/Other`);
        showToast("Updated all categories to use base folder");
      }
    } catch (e) {
      console.error("Failed to browse base path:", e);
    }
  };

  const handleAddLogin = async () => {
    if (!loginPattern.trim() || !loginUser.trim()) {
      setLoginError("Please enter a URL pattern and a username.");
      return;
    }
    const id = crypto.randomUUID();
    
    if (loginPass) {
      try {
        await invoke('set_keychain_password', { id, password: loginPass });
      } catch (e) {
        console.error("Failed to save password to keychain:", e);
        setLoginError("Failed to save password securely.");
        return;
      }
    }

    settings.addSiteLogin({
      id,
      urlPattern: loginPattern.trim(),
      username: loginUser.trim()
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

  const activeTabLabel = settingsTabs.find(tab => tab.type === activeTab)?.label ?? 'Downloads';

  const TabButton = ({ type, icon: Icon, label }: { type: SettingsTab; icon: typeof Download; label: string }) => {
    const active = activeTab === type;
    return (
      <button
        type="button"
        data-active={active}
        onClick={() => settings.setActiveSettingsTab(type)}
        className={`settings-tab-button flex min-w-0 flex-1 flex-col items-center justify-center rounded-lg px-1 py-2 text-center cursor-default transition-colors ${
          active
            ? 'text-text-primary'
            : 'text-text-secondary hover:bg-item-hover hover:text-text-primary'
        }`}
      >
        <Icon size={15} strokeWidth={active ? 2.2 : 1.8} className={active ? 'text-accent' : ''} />
        <span className="settings-tab-label mt-1 w-full whitespace-nowrap font-medium">{label}</span>
      </button>
    );
  };

  return (
    <div className="settings-view flex-1 flex flex-col relative h-full overflow-hidden">
        <WindowDragRegion />

        {/* Toast Notification */}
        {toastMessage && (
          <div className="app-toast absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 text-[12px] font-medium">
            {toastMessage}
          </div>
        )}

        {/* SwiftUI SettingsPaneContainer-style horizontal tab strip */}
        <div className="settings-toolbar">
          <div className="settings-tab-strip mx-6 mb-3 flex items-stretch gap-1 rounded-xl p-1">
            {settingsTabs.map(tab => (
              <TabButton key={tab.type} {...tab} />
            ))}
          </div>
        </div>

        {/* Content Area */}
        <div className="settings-scroll flex-1 overflow-y-auto">
          <div className="w-full p-7">
            <h1 className="mb-6 text-[22px] font-semibold tracking-tight text-text-primary">{activeTabLabel}</h1>
            <div className="settings-content max-w-[760px]">

          {/* Downloads Pane */}
          {activeTab === 'downloads' && (
            <div className="settings-pane space-y-6 max-w-[760px]">
              <h3 className="text-base font-bold text-text-primary border-b border-border-color/30 pb-2">Download Options</h3>

              <div className="grid grid-cols-[180px_1fr] items-center gap-4 text-[13px]">
                <label className="text-text-secondary font-medium">Parallel downloads:</label>
                <div className="flex items-center gap-4">
                  <input
                    type="range" min="1" max="12"
                    value={settings.maxConcurrentDownloads}
                    onChange={(e) => settings.setMaxConcurrentDownloads(Number(e.target.value))}
                    className="flex-1 accent-accent"
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
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-24 text-text-primary focus:outline-none focus:border-accent"
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
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-32 font-mono text-text-primary focus:outline-none focus:border-accent"
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
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-24 text-text-primary focus:outline-none focus:border-accent"
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
                    className="mt-0.5 rounded accent-accent"
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
                    className="mt-0.5 rounded accent-accent disabled:opacity-40"
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
            <div className="settings-pane space-y-6 max-w-[760px]">
              <h3 className="text-base font-semibold text-text-primary border-b border-border-color pb-2">App Theme</h3>

              <div className="grid grid-cols-[180px_1fr] items-start gap-4 text-[13px]">
                <label className="text-text-secondary font-medium pt-1">Theme:</label>
                <div className="space-y-2">
                  {[
                    { value: 'system', label: 'System Default' },
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                    { value: 'dracula', label: 'Dracula' },
                    { value: 'nord', label: 'Nord' },
                  ].map(({ value, label }) => (
                    <label key={value} className="flex items-center gap-2 cursor-default select-none text-text-primary">
                      <input
                        type="radio"
                        name="themeRadio"
                        value={value}
                        checked={settings.theme === value}
                        onChange={() => settings.setTheme(value as typeof settings.theme)}
                        className="accent-accent"
                      />
                      {label}
                    </label>
                  ))}
                  <p className="text-text-muted text-xs mt-2">Select a color palette for the app's user interface.</p>
                </div>
              </div>

              <h3 className="text-base font-semibold text-text-primary border-b border-border-color pb-2 pt-2">Display</h3>

              <div className="grid grid-cols-[180px_1fr] items-center gap-4 text-[13px]">
                <label className="text-text-secondary font-medium">Font Size:</label>
                <select
                  value={settings.appFontSize}
                  onChange={(e) => settings.setAppFontSize(e.target.value as any)}
                  className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 text-[13px] text-text-primary focus:outline-none focus:border-accent max-w-[200px]"
                >
                  <option value="small">Small</option>
                  <option value="standard">Standard</option>
                  <option value="large">Large</option>
                </select>
              </div>

              <div className="grid grid-cols-[180px_1fr] items-center gap-4 text-[13px]">
                <label className="text-text-secondary font-medium">List Row Density:</label>
                <select
                  value={settings.listRowDensity}
                  onChange={(e) => settings.setListRowDensity(e.target.value as any)}
                  className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 text-[13px] text-text-primary focus:outline-none focus:border-accent max-w-[200px]"
                >
                  <option value="compact">Compact</option>
                  <option value="standard">Standard</option>
                  <option value="relaxed">Relaxed</option>
                </select>
              </div>

              <h3 className="text-base font-semibold text-text-primary border-b border-border-color pb-2 pt-2">macOS Integration</h3>

              <div className="space-y-4">
                <label className="flex items-start gap-3 cursor-default select-none text-[13px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={settings.showDockBadge}
                    onChange={(e) => settings.setShowDockBadge(e.target.checked)}
                    className="mt-0.5 rounded accent-accent"
                  />
                  <div>
                    <p className="font-semibold text-text-primary">Show badge on Dock/Taskbar icon</p>
                    <p className="text-text-muted text-xs mt-0.5">Displays the number of active downloads on the icon badge.</p>
                  </div>
                </label>
                <label className="flex items-start gap-3 cursor-default select-none text-[13px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={settings.showMenuBarIcon}
                    onChange={(e) => settings.setShowMenuBarIcon(e.target.checked)}
                    className="mt-0.5 rounded accent-accent"
                  />
                  <div>
                    <p className="font-semibold text-text-primary">Show menu bar icon</p>
                    <p className="text-text-muted text-xs mt-0.5">Provides quick access to downloads and queues from the system menu bar.</p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* Network Pane */}
          {activeTab === 'network' && (
            <div className="settings-pane space-y-6 max-w-[760px]">
              <h3 className="text-base font-bold text-text-primary border-b border-border-color/30 pb-2">Proxy & User Agent</h3>

              <div className="grid grid-cols-[180px_1fr] items-start gap-4 text-[13px]">
                <label className="text-text-secondary font-medium pt-1">Proxy Mode:</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-default select-none text-text-secondary">
                    <input
                      type="radio" name="proxyMode" value="none"
                      checked={settings.proxyMode === 'none'}
                      onChange={() => settings.setProxyMode('none')}
                      className="accent-accent"
                    />
                    No proxy
                  </label>
                  <label className="flex items-center gap-2 cursor-default select-none text-text-secondary">
                    <input
                      type="radio" name="proxyMode" value="system"
                      checked={settings.proxyMode === 'system'}
                      onChange={() => settings.setProxyMode('system')}
                      className="accent-accent"
                    />
                    Use system proxy
                  </label>
                  <label className="flex items-center gap-2 cursor-default select-none text-text-secondary">
                    <input
                      type="radio" name="proxyMode" value="custom"
                      checked={settings.proxyMode === 'custom'}
                      onChange={() => settings.setProxyMode('custom')}
                      className="accent-accent"
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
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-full font-mono text-[11px] text-text-primary focus:outline-none focus:border-accent"
                  />
                  <p className="text-text-muted text-xs">Spoofs browser User-Agent to bypass download restrictions. Leave blank for default.</p>
                </div>
              </div>
            </div>
          )}

          {/* Locations Pane */}
          {activeTab === 'locations' && (
            <div className="settings-pane space-y-6 max-w-[760px]">
              <h3 className="text-base font-bold text-text-primary border-b border-border-color/30 pb-2">Download Directories</h3>

              <label className="flex items-start gap-3 cursor-default select-none text-[13px] text-text-secondary">
                <input
                  type="checkbox"
                  checked={settings.askWhereToSaveEachFile}
                  onChange={(e) => settings.setAskWhereToSaveEachFile(e.target.checked)}
                  className="mt-0.5 rounded accent-accent"
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
                      className="bg-accent hover:bg-accent text-white px-3 py-1 rounded-md text-xs font-semibold shadow transition-colors"
                    >
                      Choose Base
                    </button>
                  </div>
                </div>

                {['Musics', 'Movies', 'Compressed', 'Documents', 'Pictures', 'Applications', 'Other'].map((category) => (
                  <div key={category} className="grid grid-cols-[150px_1fr] items-center gap-4 text-[13px]">
                    <label className="text-text-secondary capitalize">{category} folder:</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={(settings.downloadDirectories || {})[category] || ''}
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
            <div className="settings-pane space-y-6 max-w-[760px]">
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
                        onClick={async () => {
                          try {
                            await invoke('delete_keychain_password', { id: login.id });
                          } catch (e) {
                            console.warn("Could not delete password from keychain:", e);
                          }
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
                    className="bg-accent hover:bg-accent text-white px-4 py-1.5 rounded-lg text-xs font-semibold shadow flex items-center gap-1.5"
                  >
                    <Plus size={14} /> Add Login
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Power Pane */}
          {activeTab === 'power' && (
            <div className="settings-pane space-y-6 max-w-[760px]">
              <h3 className="text-base font-bold text-text-primary border-b border-border-color/30 pb-2">Power Management</h3>

              <label className="flex items-start gap-3 cursor-default select-none text-[13px] text-text-secondary">
                <input
                  type="checkbox"
                  checked={settings.preventsSleepWhileDownloading}
                  onChange={(e) => settings.setPreventsSleepWhileDownloading(e.target.checked)}
                  className="mt-0.5 rounded accent-accent"
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
            <div className="settings-pane space-y-6 max-w-[760px]">
              <h3 className="text-base font-bold text-text-primary border-b border-border-color/30 pb-2">Media Downloader & Engines</h3>

              <div className="space-y-4">
                <div className="border border-border-modal rounded-lg p-4 space-y-3 bg-item-hover/5">
                  <h4 className="text-[13px] font-bold text-text-primary flex items-center gap-2 border-b border-border-modal pb-1">
                    <Terminal size={14} className="text-accent" /> Core Downloader (Aria2)
                  </h4>
                  <div className="grid grid-cols-[120px_1fr] text-[13px]">
                    <span className="text-text-secondary">Version:</span>
                    <span className="font-mono text-xs text-text-muted select-all">{aria2Version}</span>
                  </div>
                  <div className="grid grid-cols-[120px_1fr] text-[13px] items-center">
                    <span className="text-text-secondary">Status:</span>
                    {getEngineStatus(aria2Version)}
                  </div>
                </div>

                <div className="border border-border-modal rounded-lg p-4 space-y-3 bg-item-hover/5">
                  <h4 className="text-[13px] font-bold text-text-primary flex items-center gap-2 border-b border-border-modal pb-1">
                    <Terminal size={14} className="text-orange-500" /> Media Extractors
                  </h4>
                  
                  <div className="grid grid-cols-[120px_1fr_80px] text-[13px] pb-1 items-center">
                    <span className="text-text-secondary font-semibold">yt-dlp:</span>
                    <span className="font-mono text-xs text-text-muted select-all truncate pr-4">{ytdlpVersion}</span>
                    {getEngineStatus(ytdlpVersion)}
                  </div>
                  
                  <div className="grid grid-cols-[120px_1fr_80px] text-[13px] pb-1 items-center">
                    <span className="text-text-secondary font-semibold">FFmpeg:</span>
                    <span className="font-mono text-xs text-text-muted select-all truncate pr-4">{ffmpegVersion}</span>
                    {getEngineStatus(ffmpegVersion)}
                  </div>
                  
                  <div className="grid grid-cols-[120px_1fr_80px] text-[13px] pb-1 items-center">
                    <span className="text-text-secondary font-semibold">Deno:</span>
                    <span className="font-mono text-xs text-text-muted select-all truncate pr-4">{denoVersion}</span>
                    {getEngineStatus(denoVersion)}
                  </div>

                  <div className="grid grid-cols-[180px_1fr] items-center gap-4 text-[13px] border-t border-border-modal/50 pt-3 mt-2">
                    <label className="text-text-secondary font-semibold">Browser Cookies Source:</label>
                    <select
                      value={settings.mediaCookieSource}
                      onChange={(e) => settings.setMediaCookieSource(e.target.value as any)}
                      className="bg-bg-input border border-border-modal rounded-lg p-1.5 text-[13px] text-text-primary focus:outline-none focus:border-accent"
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
            <div className="settings-pane space-y-6 max-w-[760px]">
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
                      <span className="bg-accent/25 text-accent font-bold rounded-full w-5 h-5 flex items-center justify-center text-xs">1</span>
                      <Copy size={16} className="text-accent" />
                    </div>
                    <h4 className="text-[13px] font-bold text-text-primary mb-1">Copy Token</h4>
                    <p className="text-text-muted text-[11px] leading-relaxed">This secure token authorizes your browser extension.</p>
                  </div>
                  <div className="space-y-2">
                    <button
                      onClick={copyToken}
                      className="w-full bg-accent hover:bg-accent text-white font-medium py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 shadow transition-colors"
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
                  <p className="text-text-muted text-[11px] leading-relaxed">Click the Firelink icon in your browser's toolbar and paste the copied token.</p>
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
            <div className="settings-pane space-y-6 max-w-[760px]">
              {/* Header Box */}
              <div className="bg-bg-modal border border-border-modal/40 rounded-xl p-6 flex items-center gap-4">
                <img src={appIcon} alt="Firelink Icon" className="w-[72px] h-[72px] drop-shadow-md rounded-xl" />
                <div className="space-y-1">
                  <h3 className="text-[17px] font-bold text-text-primary">Firelink</h3>
                  <p className="text-text-secondary text-[12px] font-medium">Version 0.7.3</p>
                  <p className="text-text-muted text-[11px]">
                    A native macOS download manager for fast, organized, segmented transfers.
                  </p>
                </div>
              </div>

              {/* Updates Section */}
              <div className="space-y-2">
                <h4 className="text-[12px] font-bold text-text-primary px-1">Updates</h4>
                <div className="bg-bg-modal border border-border-modal/40 rounded-xl overflow-hidden">
                  <div className="p-4 flex items-center justify-between border-b border-border-modal/40">
                    <div>
                      <p className="text-[13px] font-bold text-text-primary">Check for Updates</p>
                      <p className="text-text-muted text-[11px] mt-0.5">Firelink checks GitHub Releases for new versions.</p>
                    </div>
                    <button
                      onClick={handleCheckForUpdates}
                      disabled={isCheckingForUpdates}
                      className="app-button px-4 text-xs disabled:opacity-50"
                    >
                      {isCheckingForUpdates ? (
                        <>
                          <RefreshCw size={13} className="animate-spin" />
                          Checking...
                        </>
                      ) : 'Check Now'}
                    </button>
                  </div>
                  <label className="p-4 flex items-center justify-between cursor-default">
                    <span className="text-[13px] font-bold text-text-primary">Automatically check for updates</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={settings.autoCheckUpdates}
                      onClick={() => settings.setAutoCheckUpdates(!settings.autoCheckUpdates)}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-default items-center rounded-full transition-colors duration-200 ease-in-out border border-transparent ${settings.autoCheckUpdates ? 'bg-accent' : 'bg-border-color'}`}
                    >
                      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200 ease-in-out ${settings.autoCheckUpdates ? 'translate-x-4' : 'translate-x-0'}`} />
                    </button>
                  </label>
                </div>
              </div>

              {/* Credits Footer */}
              <div className="bg-bg-modal border border-border-modal/40 rounded-xl p-4 text-[11px] space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-text-primary font-bold">Created by NimBold</span>
                  <a href="https://github.com/nimbold/Firelink" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-text-secondary hover:text-accent transition-colors font-medium">
                    <Code size={14} /> Source Code
                  </a>
                </div>
                <div className="flex justify-between items-center text-text-muted">
                  <span>Powered by <span className="text-accent">aria2</span> • <span className="text-accent">yt-dlp</span> • <span className="text-accent">ffmpeg</span> • <span className="text-accent">Deno</span></span>
                  <a href="https://github.com/nimbold/Firelink/blob/main/LICENSE" target="_blank" rel="noreferrer" className="text-accent hover:underline">MIT License</a>
                </div>
                <div className="text-text-muted pt-1 border-t border-border-modal/40">
                  Copyright © 2026 NimBold. All rights reserved.
                </div>
              </div>
            </div>
          )}

            </div>
          </div>
        </div>

    </div>
  );
};

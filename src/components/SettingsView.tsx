import { useCallback, useRef, useState, useEffect } from 'react';
import {
  type AppFontSize,
  type ListRowDensity,
  type SettingsState,
  SettingsTab,
  runSettingsPersistenceTransaction,
  useSettingsStore
} from '../store/useSettingsStore';
import {
  Download, Palette, Globe, Folder, Key,
  Moon, Terminal, Puzzle, Info, Plus, Trash2, Copy, RefreshCw, Code, ShieldAlert, Check,
  ExternalLink, BadgeCheck, AlertCircle
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invokeCommand as invoke } from '../ipc';

import { useToast, ToastVariant } from '../contexts/ToastContext';
import type { EngineStatusItem } from '../bindings/EngineStatusItem';
import { WindowDragRegion } from './WindowDragRegion';
import appIcon from '../assets/app-icon.png';
import {
  DEFAULT_CATEGORY_SUBFOLDERS,
  DOWNLOAD_CATEGORIES,
  formatDerivedCategoryPath,
  normalizeCategorySubfolder,
  subfolderFromDerivedCategoryPath
} from '../utils/downloadLocations';
import { usePlatformInfo } from '../utils/platform';
import { isTrustedFirelinkReleaseUrl } from '../utils/releaseUrls';
import { normalizeCustomProxy } from '../store/useDownloadStore';

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

const engineChecks = [
  { kind: 'aria2', name: 'Aria2', command: 'get_aria2_engine_status' },
  { kind: 'ytdlp', name: 'yt-dlp', command: 'get_ytdlp_engine_status' },
  { kind: 'ffmpeg', name: 'FFmpeg', command: 'get_ffmpeg_engine_status' },
  { kind: 'deno', name: 'Deno', command: 'get_deno_engine_status' },
] as const;

const browserCookieSourceOptions = [
  { value: 'none', label: 'None' },
  { value: 'safari', label: 'Safari' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'chromium', label: 'Chromium' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'edge', label: 'Edge' },
  { value: 'brave', label: 'Brave' },
  { value: 'opera', label: 'Opera' },
  { value: 'vivaldi', label: 'Vivaldi' },
  { value: 'whale', label: 'Whale' },
] as const;

type EngineCheck = typeof engineChecks[number];

const FIRELINK_SOURCE_URL = 'https://github.com/nimbold/Firelink';
const FIRELINK_LICENSE_URL = 'https://github.com/nimbold/Firelink/blob/main/LICENSE';
const FIRELINK_FIREFOX_ADDON_URL = 'https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/';
const FIRELINK_EXTENSION_RELEASES_URL = 'https://github.com/nimbold/Firelink-Extension/releases';

type ManualUpdateStatus =
  | { type: 'idle' }
  | { type: 'checking' }
  | { type: 'up-to-date'; latestVersion: string; localVersion: string }
  | { type: 'update-available'; version: string; releaseUrl: string }
  | { type: 'error'; message: string };

type SystemProxyStatus = 'idle' | 'checking' | 'detected' | 'none' | 'error';

const engineStatusCache = new Map<string, EngineStatusItem>();
const engineStatusInFlight = new Map<string, Promise<EngineStatusItem>>();

const upsertEngineStatus = (items: EngineStatusItem[], item: EngineStatusItem) => {
  const next = items.filter(existing => existing.kind !== item.kind);
  next.push(item);
  return next;
};

const USER_AGENT_SUGGESTIONS = [
  {
    label: 'Chrome (Windows)',
    detail: 'Windows desktop',
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
  },
  {
    label: 'Chrome (macOS)',
    detail: 'macOS desktop',
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
  },
  {
    label: 'Edge (Windows)',
    detail: 'Windows desktop',
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0'
  },
  {
    label: 'Firefox (Windows)',
    detail: 'Windows desktop',
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0'
  },
  {
    label: 'Firefox (macOS)',
    detail: 'macOS desktop',
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0'
  },
  {
    label: 'Safari (macOS)',
    detail: 'macOS desktop',
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
  }
] as const;

const buildEngineStatusError = (check: EngineCheck, error: unknown): EngineStatusItem => ({
  name: check.name,
  kind: check.kind,
  expected_sidecar: '',
  resolved_path: null,
  version: null,
  ready: false,
  error: String(error),
  stderr_tail: null,
  remediation_hint: null,
  rpc_port: null,
  daemon_alive: null,
  rpc_ready: null,
  last_stderr_tail: null,
  expects_internal_dir: null,
  has_internal_dir: null,
  has_python_framework: null,
});

const runEngineStatusCheck = (check: EngineCheck, force: boolean) => {
  if (!force) {
    const cached = engineStatusCache.get(check.kind);
    if (cached) return Promise.resolve(cached);
  }

  if (!force) {
    const inFlight = engineStatusInFlight.get(check.kind);
    if (inFlight) return inFlight;
  }

  if (force) engineStatusCache.delete(check.kind);

  const promise = invoke(check.command)
    .then(item => {
      if (item.ready) engineStatusCache.set(item.kind, item);
      return item;
    })
    .catch(error => buildEngineStatusError(check, error))
    .finally(() => {
      if (engineStatusInFlight.get(check.kind) === promise) {
        engineStatusInFlight.delete(check.kind);
      }
    });

  engineStatusInFlight.set(check.kind, promise);
  return promise;
};

const CategoryFolderInput = ({
  category,
  settings,
  onBrowse,
  disabled = false
}: {
  category: string;
  settings: SettingsState;
  onBrowse: () => void;
  disabled?: boolean;
}) => {
  const base = settings.baseDownloadFolder || '~/Downloads';
  const sub = Object.prototype.hasOwnProperty.call(settings.categorySubfolders, category)
    ? settings.categorySubfolders[category]
    : DEFAULT_CATEGORY_SUBFOLDERS[category as keyof typeof DEFAULT_CATEGORY_SUBFOLDERS];
  const override = settings.categoryDirectoryOverrides[category];
  const displayPath = override ?? formatDerivedCategoryPath(base, sub);

  const [localValue, setLocalValue] = useState<string | null>(null);

  const value = localValue !== null ? localValue : displayPath;

  return (
    <div className="flex items-center gap-2 flex-1 justify-end">
      <input
        type="text"
        value={value}
        disabled={disabled}
        onFocus={() => setLocalValue(displayPath)}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={() => {
          const val = localValue ?? displayPath;
          const derivedSubfolder = subfolderFromDerivedCategoryPath(val, base);

          if (!val.trim()) {
            settings.setCategoryDirectoryOverride(category, undefined);
            settings.setCategorySubfolder(category, '');
          } else if (derivedSubfolder !== null) {
            settings.setCategoryDirectoryOverride(category, undefined);
            settings.setCategorySubfolder(
              category,
              normalizeCategorySubfolder(
                derivedSubfolder,
                DEFAULT_CATEGORY_SUBFOLDERS[category as keyof typeof DEFAULT_CATEGORY_SUBFOLDERS]
              )
            );
          } else {
            settings.setCategoryDirectoryOverride(category, val.trim());
          }
          setLocalValue(null);
        }}
        className="app-control flex-1 max-w-[280px] text-[12px] px-3 py-1.5 bg-surface-overlay/50 border-border-color/50 focus:border-accent-color focus:bg-surface-overlay disabled:opacity-60 disabled:cursor-not-allowed"
        aria-label={`${category} subfolder`}
      />
      <button
        onClick={onBrowse}
        disabled={disabled}
        className="app-button px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-overlay disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-secondary"
      >
        Custom folder
      </button>
      {override && (
        <button
          onClick={() => {
            settings.setCategoryDirectoryOverride(category, undefined);
            setLocalValue(null);
          }}
          className="app-button px-3 py-1.5 text-xs text-text-secondary hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/30"
        >
          Use automatic
        </button>
      )}
    </div>
  );
};

export default function SettingsView() {
  const settings = useSettingsStore();
  const activeTab = settings.activeSettingsTab;
  const platform = usePlatformInfo();
  const platformName =
    platform.os === 'macos'
      ? 'macOS'
      : platform.os === 'windows'
        ? 'Windows'
        : platform.os === 'linux'
          ? 'Linux'
          : 'this OS';
  const trayIconLabel =
    platform.os === 'macos'
      ? 'Show menu bar icon'
      : platform.os === 'linux'
        ? 'Show status indicator icon'
        : 'Show system tray icon';
  const trayIconDescription =
    platform.os === 'macos'
      ? 'Provides quick access from the macOS menu bar.'
      : platform.os === 'windows'
        ? 'Provides quick access from the Windows notification area.'
        : platform.os === 'linux'
          ? 'Provides quick access from the desktop tray or status area when available.'
          : 'Provides quick access from the OS tray area when available.';
  const userAgentMenuRef = useRef<HTMLDivElement>(null);
  const [isUserAgentMenuOpen, setIsUserAgentMenuOpen] = useState(false);

  // Local state for engine status
const [engineStatus, setEngineStatus] = useState<EngineStatusItem[] | null>(null);
const [expandedEngine, setExpandedEngine] = useState<string | null>(null);
const [isRecheckingEngines, setIsRecheckingEngines] = useState(false);
const engineRunId = useRef(0);
  const [appVersion, setAppVersion] = useState('Unknown');
  const [extensionServerPort, setExtensionServerPort] = useState<number | null>(null);
  const [systemProxyStatus, setSystemProxyStatus] = useState<SystemProxyStatus>('idle');

  // Local state for adding site login
  const [loginPattern, setLoginPattern] = useState('');
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isSavingLogin, setIsSavingLogin] = useState(false);
  const saveLoginInFlight = useRef(false);
  const [loginFieldErrors, setLoginFieldErrors] = useState<{
    pattern?: string;
    username?: string;
    password?: string;
  }>({});

  // Toast notifications
  const { addToast } = useToast();
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false);
  const [manualUpdateStatus, setManualUpdateStatus] = useState<ManualUpdateStatus>({ type: 'idle' });

useEffect(() => {
getVersion().then(setAppVersion).catch(() => undefined);
}, []);

useEffect(() => {
  if (settings.activeView !== 'settings' || activeTab !== 'integrations') return;

  let active = true;
  const refresh = () => {
    invoke('get_extension_server_port')
      .then(port => {
        if (active) setExtensionServerPort(port);
      })
      .catch(() => {
        if (active) setExtensionServerPort(null);
      });
  };
  refresh();
  const timer = window.setInterval(refresh, 3000);
  return () => {
    active = false;
    window.clearInterval(timer);
  };
}, [settings.activeView, activeTab]);

useEffect(() => {
  if (settings.activeView !== 'settings' || activeTab !== 'network' || settings.proxyMode !== 'system') {
    setSystemProxyStatus('idle');
    return;
  }

  let active = true;
  setSystemProxyStatus('checking');
  invoke('get_system_proxy')
    .then(proxy => {
      if (active) setSystemProxyStatus(typeof proxy === 'string' && proxy.trim() ? 'detected' : 'none');
    })
    .catch(() => {
      if (active) setSystemProxyStatus('error');
    });

  return () => {
    active = false;
  };
}, [settings.activeView, settings.proxyMode, activeTab]);

const runEngineChecks = useCallback((force = false) => {
const runId = ++engineRunId.current;
const cached = engineChecks
.map(check => engineStatusCache.get(check.kind))
.filter((item): item is EngineStatusItem => Boolean(item));
setEngineStatus(force ? [] : cached);
setExpandedEngine(null);

const checksToRun = force
? engineChecks
: engineChecks.filter(check => !engineStatusCache.has(check.kind));

if (checksToRun.length === 0) {
setIsRecheckingEngines(false);
return;
}

setIsRecheckingEngines(true);
let remaining = checksToRun.length;

checksToRun.forEach(check => {
runEngineStatusCheck(check, force)
.then(item => {
if (engineRunId.current === runId) {
setEngineStatus(current => upsertEngineStatus(current ?? [], item));
}
})
.finally(() => {
remaining -= 1;
if (remaining === 0 && engineRunId.current === runId) {
setIsRecheckingEngines(false);
}
});
});
}, []);

// Fetch engine status when Engine tab is opened
useEffect(() => {
if (settings.activeView === 'settings' && activeTab === 'engine') {
runEngineChecks(false);
}
}, [settings.activeView, activeTab, runEngineChecks]);

  const showToast = (msg: string, variant: ToastVariant = 'info') => {
    addToast({ message: msg, variant });
  };

  const openExternalUrl = async (url: string, label: string) => {
    try {
      await openUrl(url);
    } catch (error) {
      showToast(`Could not open ${label}: ${String(error)}`, 'error');
    }
  };

  const findEngine = (kind: string) => engineStatus?.find(e => e.kind === kind) ?? null;

  const renderEngineStatus = (item: EngineStatusItem | null) => {
    if (!item) return <span className="text-text-muted font-medium">Checking...</span>;
    if (item.ready) return <span className="text-green-500 font-medium">Ready</span>;
    return <span className="text-red-500 font-medium">Error / Missing</span>;
  };

  const renderEngineVersion = (item: EngineStatusItem | null) => {
    if (!item) return 'Checking...';
    if (item.version) return item.version;
    if (item.error) return `Error: ${item.error.length > 80 ? item.error.substring(0, 80) + '…' : item.error}`;
    return 'Unknown';
  };

  const renderEngineDetails = (item: EngineStatusItem | null) => {
    if (!item || item.ready || (!item.error && !item.remediation_hint && !item.stderr_tail)) return null;
    const isExpanded = expandedEngine === item.kind;
    return (
      <>
        <button
          onClick={() => setExpandedEngine(isExpanded ? null : item.kind)}
          className="text-accent text-[11px] font-medium hover:underline mt-1"
        >
          {isExpanded ? 'Hide technical details' : 'Show technical details'}
        </button>
        {isExpanded && (
          <div className="mt-2 p-2 bg-bg-modal rounded text-[11px] font-mono text-text-muted space-y-1 leading-relaxed">
            {item.resolved_path && <p>Binary: {item.resolved_path}</p>}
            {item.expected_sidecar && <p>Expected: {item.expected_sidecar}</p>}
            {item.error && <p className="text-red-400">Error: {item.error}</p>}
            {item.remediation_hint && <p className="text-yellow-500">Tip: {item.remediation_hint}</p>}
            {item.stderr_tail && <details><summary className="cursor-pointer text-text-muted">stderr</summary><pre className="mt-1 whitespace-pre-wrap">{item.stderr_tail}</pre></details>}
            {item.daemon_alive != null && <p>Daemon process alive: {String(item.daemon_alive)}</p>}
            {item.rpc_ready != null && <p>RPC ready: {String(item.rpc_ready)}</p>}
            {item.rpc_port != null && <p>RPC port: {item.rpc_port}</p>}
            {item.last_stderr_tail && <details><summary className="cursor-pointer text-text-muted">daemon stderr</summary><pre className="mt-1 whitespace-pre-wrap">{item.last_stderr_tail}</pre></details>}
            {item.expects_internal_dir === true && <p>Packaging: PyInstaller onedir (_internal required)</p>}
            {item.has_internal_dir === true && <p>_internal directory found: true</p>}
            {item.has_python_framework != null && <p>Python runtime found: {String(item.has_python_framework)}</p>}
          </div>
        )}
      </>
    );
  };

  const handleCheckForUpdates = async () => {
    if (isCheckingForUpdates) return;

    setIsCheckingForUpdates(true);
    setManualUpdateStatus({ type: 'checking' });

    try {
      const result = await invoke('check_for_updates');

      if (result.type === 'UpToDate') {
        setManualUpdateStatus({
          type: 'up-to-date',
          latestVersion: result.latest_version,
          localVersion: result.local_version
        });
      } else if (result.type === 'UpdateAvailable') {
        if (!isTrustedFirelinkReleaseUrl(result.update.release_url)) {
          throw new Error('The update check returned an untrusted release URL.');
        }
        setManualUpdateStatus({
          type: 'update-available',
          version: result.update.version,
          releaseUrl: result.update.release_url
        });
      } else {
        setManualUpdateStatus({
          type: 'error',
          message: 'The update check returned an unexpected response.'
        });
      }
    } catch (error) {
      setManualUpdateStatus({
        type: 'error',
        message: `Update check failed: ${String(error)}`
      });
    } finally {
      setIsCheckingForUpdates(false);
    }
  };

  const handleBrowseCategory = async (category: string) => {
    const currentPath = settings.categoryDirectoryOverrides[category] || settings.baseDownloadFolder;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: currentPath.startsWith('~') ? undefined : currentPath
      });
      if (selected && typeof selected === 'string') {
        const approvedPath = await settings.approveDownloadRoot(selected);
        settings.setCategoryDirectoryOverride(category, approvedPath);
      }
    } catch (e) {
      console.error(`Failed to select folder for ${category}:`, e);
    }
  };

  const handleBrowseBase = async () => {
    try {
      const base = await open({
        directory: true,
        multiple: false,
        defaultPath: settings.baseDownloadFolder.startsWith('~')
          ? undefined
          : settings.baseDownloadFolder
      });
      if (base && typeof base === 'string') {
        const approvedBase = await settings.approveDownloadRoot(base);
        settings.setBaseDownloadFolder(approvedBase);
        try {
          if (settings.categorySubfoldersEnabled) {
            const safeSubfolders = Object.fromEntries(
              DOWNLOAD_CATEGORIES.map(category => [
                category,
                normalizeCategorySubfolder(
                  Object.prototype.hasOwnProperty.call(settings.categorySubfolders, category)
                    ? settings.categorySubfolders[category]
                    : DEFAULT_CATEGORY_SUBFOLDERS[category],
                  DEFAULT_CATEGORY_SUBFOLDERS[category]
                )
              ])
            );
            await invoke('create_category_directories', {
              baseFolder: approvedBase,
              subfolders: safeSubfolders
            });
          }
        } catch (e) {
          console.error("Failed to create directories on disk:", e);
          showToast(`Base folder saved, but category folders could not be created: ${String(e)}`, 'warning');
          return;
        }
        showToast("Base download folder updated", 'success');
      }
    } catch (e) {
      console.error("Failed to browse base path:", e);
    }
  };

  const handleAddLogin = async () => {
    if (saveLoginInFlight.current) return;
    const fieldErrors: typeof loginFieldErrors = {};
    if (!loginPattern.trim()) {
      fieldErrors.pattern = 'URL pattern is required.';
    } else if (/\s/.test(loginPattern.trim())) {
      fieldErrors.pattern = 'URL pattern cannot contain whitespace.';
    }
    if (!loginUser.trim()) {
      fieldErrors.username = 'Username is required.';
    }
    if (!loginPass) {
      fieldErrors.password = 'Password is required.';
    }
    if (Object.keys(fieldErrors).length > 0) {
      setLoginFieldErrors(fieldErrors);
      setLoginError('');
      return;
    }
    setLoginFieldErrors({});
    const id = crypto.randomUUID();

    if (!settings.keychainAccessReady) {
      settings.setShowKeychainModal(true);
      setLoginError('Grant credential-store access before saving a site login.');
      return;
    }
    saveLoginInFlight.current = true;
    setIsSavingLogin(true);
    try {
      await runSettingsPersistenceTransaction(async () => {
        await invoke('save_site_login', {
          id,
          urlPattern: loginPattern.trim(),
          username: loginUser.trim(),
          password: loginPass
        });
        settings.addSiteLogin({
          id,
          urlPattern: loginPattern.trim(),
          username: loginUser.trim()
        });
      });
    } catch (e) {
      console.error("Failed to save site login:", e);
      setLoginError("Failed to save site credential securely.");
      return;
    } finally {
      saveLoginInFlight.current = false;
      setIsSavingLogin(false);
    }

    setLoginPattern('');
    setLoginUser('');
    setLoginPass('');
    setLoginError('');
    showToast("Added site credential", 'success');
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(settings.extensionPairingToken);
      showToast("Token copied to clipboard!", 'success');
    } catch (error) {
      showToast(`Could not copy token: ${String(error)}`, 'error');
    }
  };

  const activeTabLabel = settingsTabs.find(tab => tab.type === activeTab)?.label ?? 'Downloads';

  const TabButton = ({ type, icon: Icon, label }: { type: SettingsTab; icon: typeof Download; label: string }) => {
    const active = activeTab === type;
    return (
      <button
        type="button"
        data-active={active}
        onClick={() => settings.setActiveSettingsTab(type)}
        className={`settings-tab-button flex min-w-0 flex-1 flex-col items-center justify-center px-1 text-center cursor-default ${
          active
            ? 'text-white'
            : 'text-text-primary hover:bg-item-hover'
        }`}
      >
        <Icon size={16} strokeWidth={2} />
        <span className="settings-tab-label mt-1 w-full whitespace-nowrap font-medium">{label}</span>
      </button>
    );
  };

  return (
    <div className="settings-view flex-1 flex flex-col relative h-full overflow-hidden">
        <WindowDragRegion />

        {/* SwiftUI SettingsPaneContainer-style horizontal tab strip */}
        <div className="settings-toolbar">
          <div className="settings-tab-strip flex items-stretch gap-1">
            {settingsTabs.map(tab => (
              <TabButton key={tab.type} {...tab} />
            ))}
          </div>
        </div>

        {/* Content Area */}
        <div className="settings-scroll flex-1 overflow-y-auto">
          <div className="settings-content-shell w-full">
            <h1 className="settings-title text-text-primary">{activeTabLabel}</h1>
            <div className="settings-content max-w-[720px]">

          {/* Downloads Pane */}
          {activeTab === 'downloads' && (
            <div className="settings-pane max-w-[720px]">
              <div className="mac-settings-group">
                <div className="mac-settings-row">
                  <div className="settings-row-label">
                    <span>Default connections:</span>
                    <small>New downloads; existing items keep their saved value</small>
                  </div>
                  <input
                    type="number" min="1" max="16"
                    value={settings.perServerConnections}
                    onChange={(e) => settings.setPerServerConnections(Number(e.target.value))}
                    onBlur={(e) => {
                      const val = Number(e.target.value);
                      if (val < 1) settings.setPerServerConnections(1);
                      if (val > 16) settings.setPerServerConnections(16);
                    }}
                    className="app-control w-24 text-center"
                  />
                </div>
                <div className="mac-settings-row">
                  <div className="settings-row-label">
                    <span>Parallel downloads:</span>
                    <small>Max simultaneous active files</small>
                  </div>
                  <input
                    type="number" min="1" max="12"
                    value={settings.maxConcurrentDownloads}
                    onChange={(e) => settings.setMaxConcurrentDownloads(Number(e.target.value))}
                    onBlur={(e) => {
                      const val = Number(e.target.value);
                      if (val < 1) settings.setMaxConcurrentDownloads(1);
                      if (val > 12) settings.setMaxConcurrentDownloads(12);
                    }}
                    className="app-control w-24 text-center"
                  />
                </div>
                <div className="mac-settings-row">
                  <div className="settings-row-label">
                    <span>Automatic retries:</span>
                    <small>If a connection fails</small>
                  </div>
                  <input
                    type="number" min="0" max="10"
                    value={settings.maxAutomaticRetries}
                    onChange={(e) => settings.setMaxAutomaticRetries(Number(e.target.value))}
                    onBlur={(e) => {
                      const val = Number(e.target.value);
                      if (val < 0) settings.setMaxAutomaticRetries(0);
                      if (val > 10) settings.setMaxAutomaticRetries(10);
                    }}
                    className="app-control w-24 text-center"
                  />
                </div>
              </div>

              <div className="mac-settings-group">
                <label className="mac-settings-row cursor-default">
                  <div className="settings-row-label">
                    <span>Show system notification when download completes</span>
                    <small>Uses your operating system notification settings</small>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.showNotifications}
                    onChange={(e) => settings.setShowNotifications(e.target.checked)}
                    className="mac-switch"
                  />
                </label>
                <label className="mac-settings-row cursor-default">
                    <div className="settings-row-label">
                      <span>Play in-app completion chime</span>
                      <small>Optional Firelink sound, independent of system notifications</small>
                    </div>
                  <input
                    type="checkbox"
                    checked={settings.playCompletionSound}
                    onChange={(e) => settings.setPlayCompletionSound(e.target.checked)}
                    className="mac-switch"
                  />
                </label>
                <label className="mac-settings-row cursor-default">
                  <div className="settings-row-label">
                    <span>Add clipboard links when Firelink becomes active</span>
                    <small>Opens supported copied links in the Add window. Off by default.</small>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.autoAddClipboardLinks}
                    onChange={(e) => settings.setAutoAddClipboardLinks(e.target.checked)}
                    className="mac-switch"
                  />
                </label>
              </div>
            </div>
          )}

          {/* Look & Feel Pane */}
          {activeTab === 'lookandfeel' && (
            <div className="settings-pane max-w-[720px]">
              <h2 className="settings-section-title">App Theme</h2>
              <div className="mac-settings-group">
                <div className="mac-settings-row settings-choice-row">
                  <span className="text-[13px] text-text-primary pt-0.5">Theme</span>
                  <div className="theme-option-grid" role="radiogroup" aria-label="App theme">
                    {[
                      { value: 'system', label: 'System', colors: ['#f4f4f5', '#252525'] },
                      { value: 'light', label: 'Light', colors: ['#ffffff', '#e9e9ec'] },
                      { value: 'dark', label: 'Dark', colors: ['#1a1a1a', '#292929'] },
                      { value: 'dracula', label: 'Dracula', colors: ['#282a36', '#ff79c6'] },
                      { value: 'nord', label: 'Nord', colors: ['#2e3440', '#88c0d0'] },
                    ].map(({ value, label, colors }) => (
                      <label
                        key={value}
                        className="theme-option"
                        data-active={settings.theme === value}
                      >
                        <input
                          type="radio"
                          name="app-theme"
                          checked={settings.theme === value}
                          onChange={() => settings.setTheme(value as typeof settings.theme)}
                        />
                        <span className="theme-option-preview" aria-hidden="true">
                          <span style={{ background: colors[0] }} />
                          <span style={{ background: colors[1] }} />
                        </span>
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <p className="settings-group-footer">System follows the current {platformName} light or dark appearance.</p>
              </div>

              <h2 className="settings-section-title">Display</h2>
              <div className="mac-settings-group">
                <div className="mac-settings-row">
                  <div className="settings-row-label">
                    <span>Font size</span>
                    <small>Scales the download list and compact controls.</small>
                  </div>
                  <select
                    value={settings.appFontSize}
                    onChange={(e) => settings.setAppFontSize(e.target.value as AppFontSize)}
                    className="app-control w-40"
                  >
                    <option value="small">Small</option>
                    <option value="standard">Standard</option>
                    <option value="large">Large</option>
                  </select>
                </div>
                <div className="mac-settings-row">
                  <div className="settings-row-label">
                    <span>List density</span>
                    <small>Changes row height, spacing, and progress bar scale.</small>
                  </div>
                  <select
                    value={settings.listRowDensity}
                    onChange={(e) => settings.setListRowDensity(e.target.value as ListRowDensity)}
                    className="app-control w-40"
                  >
                    <option value="compact">Compact</option>
                    <option value="standard">Comfortable</option>
                    <option value="relaxed">Relaxed</option>
                  </select>
                </div>
              </div>

              <h2 className="settings-section-title">OS Integration</h2>
              <div className="mac-settings-group">
                {platform.os === 'macos' && (
                  <label className="mac-settings-row cursor-default">
                    <div className="settings-row-label">
                      <span>Show badge on Dock icon</span>
                      <small>Displays active download count on Firelink Dock icon.</small>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.showDockBadge}
                      onChange={(e) => settings.setShowDockBadge(e.target.checked)}
                      className="mac-switch"
                    />
                  </label>
                )}
                <label className="mac-settings-row cursor-default">
                  <div className="settings-row-label">
                    <span>{trayIconLabel}</span>
                    <small>{trayIconDescription}</small>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.showMenuBarIcon}
                    onChange={(e) => settings.setShowMenuBarIcon(e.target.checked)}
                    className="mac-switch"
                  />
                </label>
              </div>
            </div>
          )}

          {/* Network Pane */}
          {activeTab === 'network' && (
            <div className="settings-pane max-w-[720px]">
              <h2 className="settings-section-title">Proxy</h2>
              <div className="mac-settings-group">
                <div className="mac-settings-row settings-network-row settings-choice-row">
                  <div className="settings-row-label">
                    <span>Mode</span>
                    <small>Controls proxy use for new download requests.</small>
                  </div>
                  <div className="settings-radio-group">
                    {[
                      ['none', 'No Proxy'],
                      ['system', 'System Proxy'],
                      ['custom', 'Custom Proxy'],
                    ].map(([value, label]) => (
                      <label key={value}>
                        <input
                          type="radio"
                          name="proxy-mode"
                          checked={settings.proxyMode === value}
                          onChange={() => settings.setProxyMode(value as typeof settings.proxyMode)}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
                {settings.proxyMode === 'custom' && (
                  <>
                    <div className="mac-settings-row settings-network-row">
                      <div className="settings-row-label">
                        <span>Proxy host</span>
                        <small>Host name, IP address, or HTTP proxy URL.</small>
                      </div>
                      <input
                        type="text"
                        value={settings.proxyHost}
                        onChange={(e) => settings.setProxyHost(e.target.value)}
                        placeholder="127.0.0.1 or http://127.0.0.1"
                        className="app-control settings-network-input font-mono"
                      />
                    </div>
                    <div className="mac-settings-row settings-network-row">
                      <div className="settings-row-label">
                        <span>Proxy port</span>
                        <small>Valid range is 1 to 65535.</small>
                      </div>
                      <input
                        type="number" min="1" max="65535"
                        value={settings.proxyPort}
                        onChange={(e) => settings.setProxyPort(Number(e.target.value))}
                        className="app-control settings-port-input text-center"
                      />
                    </div>
                  </>
                )}
                <p className="settings-group-footer">
                  {settings.proxyMode === 'none' && 'Downloads ignore configured proxies.'}
                  {settings.proxyMode === 'system' && `Downloads use the detected ${platform.os === 'macos' ? 'macOS' : platform.os === 'windows' ? 'Windows' : 'desktop'} system proxy. Normal file downloads require an HTTP or HTTPS proxy endpoint; media downloads can use SOCKS.`}
                  {settings.proxyMode === 'custom' && (normalizeCustomProxy(settings.proxyHost, settings.proxyPort)
                    ? 'Downloads use the configured HTTP proxy endpoint for metadata and download engines.'
                    : settings.proxyHost
                      ? 'Enter a valid HTTP proxy host and port to enable the custom proxy.'
                      : 'Enter a proxy host and port to enable the custom proxy.')}
                </p>
                {settings.proxyMode === 'system' && (
                  <p className="settings-group-footer" role="status">
                    {systemProxyStatus === 'checking' && 'Checking system proxy configuration…'}
                    {systemProxyStatus === 'detected' && 'A system proxy was detected. Normal file downloads require an HTTP or HTTPS endpoint; media downloads can use SOCKS.'}
                    {systemProxyStatus === 'none' && 'No usable system proxy was detected. Downloads will use no proxy.'}
                    {systemProxyStatus === 'error' && 'System proxy configuration could not be read. Choose No Proxy or try again when it is available.'}
                  </p>
                )}
              </div>

              <h2 className="settings-section-title">Identity</h2>
              <div className="mac-settings-group settings-popup-group">
                <div className="mac-settings-row settings-network-row">
                  <div className="settings-row-label">
                    <span>Custom User-Agent</span>
                    <small>Applied to metadata fetches and download engines.</small>
                  </div>
                  <div
                    className="settings-combobox"
                    ref={userAgentMenuRef}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setIsUserAgentMenuOpen(false);
                      }
                    }}
                  >
                    <input
                      type="text"
                      value={settings.customUserAgent}
                      onChange={(e) => settings.setCustomUserAgent(e.target.value)}
                      onFocus={() => setIsUserAgentMenuOpen(true)}
                      placeholder="Leave blank for Firelink default"
                      className="app-control settings-network-input font-mono"
                      role="combobox"
                      aria-expanded={isUserAgentMenuOpen}
                      aria-controls="user-agent-suggestions"
                    />
                    {isUserAgentMenuOpen && (
                      <div id="user-agent-suggestions" className="settings-combobox-menu" role="listbox">
                        {USER_AGENT_SUGGESTIONS.map(option => (
                          <button
                            key={option.label}
                            type="button"
                            className="settings-combobox-option"
                            role="option"
                            aria-selected={settings.customUserAgent === option.value}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              settings.setCustomUserAgent(option.value);
                              setIsUserAgentMenuOpen(false);
                            }}
                          >
                            <span className="settings-combobox-value">{option.value}</span>
                            <span className="settings-combobox-meta">{option.label} · {option.detail}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <p className="settings-group-footer">Overrides the outbound User-Agent header. Leave blank for Firelink defaults.</p>
              </div>
            </div>
          )}

          {/* Locations Pane */}
          {activeTab === 'locations' && (
            <div className="settings-pane max-w-[760px]">
              <div className="mac-settings-group">
                <div className="mac-settings-row">
                  <div>
                    <span className="text-[13px] font-semibold text-text-primary">Base Download Folder</span>
                    <p className="mt-0.5 text-[11px] text-text-muted">Automatic category folders are created inside this folder.</p>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={settings.baseDownloadFolder}
                      onChange={(e) => settings.setBaseDownloadFolder(e.target.value)}
                      onBlur={() => {
                        settings.setBaseDownloadFolder(settings.baseDownloadFolder.trim() || '~/Downloads');
                      }}
                      className="app-control w-64 text-[11px] px-2"
                      placeholder="~/Downloads"
                    />
                    <button
                      onClick={handleBrowseBase}
                      className="app-button px-3 text-xs text-text-secondary hover:bg-item-hover"
                    >
                      Browse
                    </button>
                  </div>
                </div>
              </div>

              <div className="mac-settings-group">
                <label className="mac-settings-row cursor-default">
                  <span className="text-[13px] text-text-primary">Ask where to save when adding downloads</span>
                  <input
                    type="checkbox"
                    checked={settings.askWhereToSaveEachFile}
                    onChange={(e) => settings.setAskWhereToSaveEachFile(e.target.checked)}
                    className="mac-switch"
                  />
                </label>
              </div>

              <div className="mac-settings-group">
                <label className="mac-settings-row cursor-default">
                  <div>
                    <span className="text-[13px] text-text-primary">Automatically save files to category subfolders</span>
                    <p className="mt-0.5 text-[11px] text-text-muted">When off, automatic downloads use the base folder.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.categorySubfoldersEnabled}
                    onChange={(e) => settings.setCategorySubfoldersEnabled(e.target.checked)}
                    className="mac-switch"
                  />
                </label>
              </div>

              <div className="mac-settings-group">
                <div className="mac-settings-row bg-item-hover/20">
                  <span className="text-[13px] font-semibold text-text-primary">Category Subfolders</span>
                  <span className="text-[11px] text-text-muted">
                    {settings.categorySubfoldersEnabled ? 'Relative to the base folder' : 'Disabled'}
                  </span>
                </div>


                <div
                  className={`flex flex-col divide-y divide-border-color/30 ${
                    settings.categorySubfoldersEnabled ? '' : 'opacity-50'
                  }`}
                  aria-disabled={!settings.categorySubfoldersEnabled}
                >
                  {DOWNLOAD_CATEGORIES.map((category) => (
                    <div
                      key={category}
                      className={`flex flex-col gap-2 px-4 py-3 transition-colors ${
                        settings.categorySubfoldersEnabled ? 'hover:bg-item-hover/20' : ''
                      }`}
                    >
                      <div className="flex justify-between items-center">
                        <span className="text-[13px] font-medium text-text-primary w-32 shrink-0">{category}</span>
                        <CategoryFolderInput
                          category={category}
                          settings={settings}
                          onBrowse={() => handleBrowseCategory(category)}
                          disabled={!settings.categorySubfoldersEnabled}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                
                <div className="mac-settings-row justify-end border-t-0">
                  <button
                    onClick={() => {
                      settings.resetCategoryLocations();
                      showToast("Reset category locations to default", 'success');
                    }}
                    disabled={!settings.categorySubfoldersEnabled}
                    className="app-control hover:bg-item-hover text-text-secondary px-4 py-1 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
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
                          if (!settings.keychainAccessReady) {
                            settings.setShowKeychainModal(true);
                            return;
                          }
                          try {
                            await runSettingsPersistenceTransaction(async () => {
                              await invoke('delete_site_login', { id: login.id });
                              settings.removeSiteLogin(login.id);
                            });
                            showToast("Deleted credential", 'success');
                          } catch (error) {
                            showToast(`Could not delete credential: ${String(error)}`, 'error');
                          }
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
                    onChange={(e) => {
                      setLoginPattern(e.target.value);
                      setLoginFieldErrors(current => ({ ...current, pattern: undefined }));
                    }}
                    placeholder="e.g. *.example.com or example.com/downloads"
                    aria-invalid={Boolean(loginFieldErrors.pattern)}
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-full text-text-primary focus:outline-none"
                  />
                  {loginFieldErrors.pattern && <p className="text-red-500 text-xs mt-1">{loginFieldErrors.pattern}</p>}
                </div>

                <div className="grid grid-cols-[150px_1fr] items-center gap-4 text-[13px]">
                  <label className="text-text-secondary">Username:</label>
                  <input
                    type="text"
                    value={loginUser}
                    onChange={(e) => {
                      setLoginUser(e.target.value);
                      setLoginFieldErrors(current => ({ ...current, username: undefined }));
                    }}
                    placeholder="Username"
                    aria-invalid={Boolean(loginFieldErrors.username)}
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-full text-text-primary focus:outline-none"
                  />
                  {loginFieldErrors.username && <p className="text-red-500 text-xs mt-1">{loginFieldErrors.username}</p>}
                </div>

                <div className="grid grid-cols-[150px_1fr] items-center gap-4 text-[13px]">
                  <label className="text-text-secondary">Password:</label>
                  <input
                    type="password"
                    value={loginPass}
                    onChange={(e) => {
                      setLoginPass(e.target.value);
                      setLoginFieldErrors(current => ({ ...current, password: undefined }));
                    }}
                    placeholder="Password"
                    aria-invalid={Boolean(loginFieldErrors.password)}
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-full text-text-primary focus:outline-none"
                  />
                  {loginFieldErrors.password && <p className="text-red-500 text-xs mt-1">{loginFieldErrors.password}</p>}
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    type="button"
                    onClick={handleAddLogin}
                    disabled={isSavingLogin}
                    className="bg-accent hover:bg-accent text-white px-4 py-1.5 rounded-lg text-xs font-semibold shadow flex items-center gap-1.5"
                  >
                    <Plus size={14} /> {isSavingLogin ? 'Saving…' : 'Add Login'}
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
<div className="flex items-center justify-between gap-3 border-b border-border-color/30 pb-2">
<div>
<h3 className="text-base font-bold text-text-primary">Media Downloader & Engines</h3>
<p className="text-[11px] text-text-muted mt-0.5">Successful results are reused for this app session. Recheck runs real validation again.</p>
</div>
<button
type="button"
onClick={() => runEngineChecks(true)}
disabled={isRecheckingEngines}
className="app-button px-3 py-1.5 text-[12px] flex items-center gap-1.5 disabled:opacity-60"
>
<RefreshCw size={13} className={isRecheckingEngines ? 'animate-spin' : ''} />
{isRecheckingEngines ? 'Checking…' : 'Recheck engines'}
</button>
</div>

{(() => {
                const a2 = findEngine('aria2'); const yt = findEngine('ytdlp');
                const ff = findEngine('ffmpeg'); const dn = findEngine('deno');
                return (
                  <div className="space-y-4">
                    {/* aria2 card */}
                    <div className="border border-border-modal rounded-lg p-4 space-y-2 bg-item-hover/5">
                      <h4 className="text-[13px] font-bold text-text-primary flex items-center gap-2 border-b border-border-modal pb-1">
                        <Terminal size={14} className="text-accent" /> Core Downloader (Aria2)
                      </h4>
                      <div className="grid grid-cols-[100px_1fr] text-[13px] items-center gap-x-2">
                        <span className="text-text-secondary">Version:</span>
                        <span className="font-mono text-xs text-text-muted select-all truncate">{renderEngineVersion(a2)}</span>
                      </div>
                      <div className="grid grid-cols-[100px_1fr] text-[13px] items-center gap-x-2">
                        <span className="text-text-secondary">Status:</span>
                        {renderEngineStatus(a2)}
                      </div>
                      {renderEngineDetails(a2)}
                    </div>

                    {/* yt-dlp / ffmpeg / deno card */}
                    <div className="border border-border-modal rounded-lg p-4 space-y-2 bg-item-hover/5">
                      <h4 className="text-[13px] font-bold text-text-primary flex items-center gap-2 border-b border-border-modal pb-1">
                        <Terminal size={14} className="text-orange-500" /> Media Extractors
                      </h4>
                      {[
                        { key: 'ytdlp', item: yt, label: 'yt-dlp' },
                        { key: 'ffmpeg', item: ff, label: 'FFmpeg' },
                        { key: 'deno', item: dn, label: 'Deno' },
                      ].map(({ key, item, label }) => (
                        <div key={key}>
                          <div className="grid grid-cols-[100px_1fr_80px] text-[13px] items-center gap-x-2">
                            <span className="text-text-secondary font-semibold">{label}:</span>
                            <span className="font-mono text-xs text-text-muted select-all truncate">{renderEngineVersion(item)}</span>
                            {renderEngineStatus(item)}
                          </div>
                          {renderEngineDetails(item)}
                        </div>
                      ))}

                      <div className="grid grid-cols-[180px_1fr] items-center gap-4 text-[13px] border-t border-border-modal/50 pt-3 mt-2">
                        <label className="text-text-secondary font-semibold pt-1.5">Browser Cookies Source:</label>
                        <select
                          value={browserCookieSourceOptions.some(option => option.value === settings.mediaCookieSource) ? settings.mediaCookieSource : 'none'}
                          onChange={(e) => settings.setMediaCookieSource(e.target.value)}
                          className="bg-bg-input border border-border-modal rounded-lg p-1.5 text-[13px] text-text-primary focus:outline-none focus:border-accent w-full"
                        >
                          {browserCookieSourceOptions.map(option => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </div>
                    <p className="text-text-muted text-xs mt-1">yt-dlp reads browser cookies to bypass video download limits or access restricted media. Firelink does not save browser cookies.</p>
                    </div>
                  </div>
                );
              })()}
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

              {settings.isPairingTokenPersistent ? (
                <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 flex items-center gap-3">
                  <div className="p-1.5 bg-green-500/20 rounded-full text-green-500 flex-shrink-0">
                    <Check size={16} strokeWidth={2.5} />
                  </div>
                  <div className="flex-1">
                    <h4 className="text-sm font-semibold text-green-500 m-0">
                      {platform.portable ? 'Portable Pairing Enabled' : 'Pairing Token Persisted'}
                    </h4>
                    <p className="text-xs text-text-secondary m-0 mt-0.5">
                      {platform.portable
                        ? 'Your pairing token is stored with this portable Firelink folder and will persist when the folder is moved. Treat the folder as sensitive.'
                        : 'Your pairing token is stored in the system credential store and will persist across restarts.'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-4 flex items-start gap-3">
                  <ShieldAlert className="w-5 h-5 text-orange-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h4 className="text-sm font-semibold text-text-primary mb-1">
                      {platform.portable ? 'Portable Pairing Available' : 'Credential Storage Needed'}
                    </h4>
                    <p className="text-xs text-text-secondary mb-3">
                      {platform.portable
                        ? 'Your pairing token is stored with this portable Firelink folder and will persist across restarts. Enable it here to review the portable-storage warning.'
                        : "Firelink needs access to this system's credential store to securely save your pairing token across app restarts. Currently, your extension will only stay connected for this session."}
                    </p>
                    <button 
                      onClick={() => settings.setShowKeychainModal(true)}
                      className="px-4 py-1.5 rounded-md text-xs font-medium transition-colors bg-accent text-white hover:bg-accent/90 shadow-sm"
                    >
                    {platform.portable ? 'Review Portable Pairing' : 'Grant Credential Access'}
                    </button>
                  </div>
                </div>
              )}

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
                      onClick={() => void copyToken()}
                      className="w-full bg-accent hover:bg-accent text-white font-medium py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 shadow transition-colors"
                    >
                      <Copy size={11} /> Copy Token
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          await settings.regeneratePairingToken();
                          showToast("Pairing token regenerated", 'success');
                        } catch (error) {
                          showToast(`Could not regenerate pairing token: ${String(error)}`, 'error');
                        }
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
                    <p className="text-text-muted text-[11px] leading-relaxed">Install Firelink Companion for Firefox or Chromium browsers.</p>
                  </div>
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => void openExternalUrl(FIRELINK_FIREFOX_ADDON_URL, 'Firefox Add-ons')}
                      className="w-full bg-item-hover hover:bg-item-hover/80 text-text-primary border border-border-modal font-medium py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 transition-colors"
                    >
                      Firefox Add-ons
                      <ExternalLink size={11} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void openExternalUrl(FIRELINK_EXTENSION_RELEASES_URL, 'Chromium release ZIP')}
                      className="w-full bg-item-hover hover:bg-item-hover/80 text-text-primary border border-border-modal font-medium py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 transition-colors"
                    >
                      Chromium ZIP
                      <ExternalLink size={11} />
                    </button>
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
                <span className={`${extensionServerPort ? 'text-green-500' : 'text-orange-400'} font-semibold flex items-center gap-1`}>
                  {extensionServerPort
                    ? `● Listening on 127.0.0.1:${extensionServerPort}`
                    : '● Server unavailable'}
                </span>
              </div>
            </div>
          )}

          {/* About Pane */}
          {activeTab === 'about' && (
            <div className="settings-pane space-y-6 max-w-[760px]">
              <div className="bg-bg-modal border border-border-modal/40 rounded-lg p-5 flex items-center justify-between gap-5">
                <div className="flex items-center gap-4 min-w-0">
                  <img src={appIcon} alt="Firelink Icon" className="w-[68px] h-[68px] drop-shadow-md rounded-xl shrink-0" />
                  <div className="space-y-1 min-w-0">
                    <h3 className="text-[18px] font-bold text-text-primary leading-tight">Firelink</h3>
                    <p className="text-text-secondary text-[12px] font-medium">Version {appVersion}</p>
                    <p className="text-text-muted text-[11px]">
                      Cross-platform download manager for macOS, Windows, and Linux.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void openExternalUrl(FIRELINK_SOURCE_URL, 'Source Code')}
                  className="app-button px-3 py-1.5 text-xs shrink-0 flex items-center gap-1.5"
                >
                  <Code size={13} />
                  Source
                  <ExternalLink size={12} />
                </button>
              </div>

              {manualUpdateStatus.type !== 'idle' && manualUpdateStatus.type !== 'checking' && (
                <div
                  className={`rounded-lg border px-4 py-3 flex items-center justify-between gap-3 text-[12px] ${
                    manualUpdateStatus.type === 'up-to-date'
                      ? 'bg-green-500/10 border-green-500/20 text-green-500'
                      : manualUpdateStatus.type === 'update-available'
                        ? 'bg-blue-500/10 border-blue-500/20 text-blue-400'
                        : 'bg-red-500/10 border-red-500/20 text-red-400'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {manualUpdateStatus.type === 'up-to-date' ? (
                      <BadgeCheck size={16} className="shrink-0" />
                    ) : manualUpdateStatus.type === 'update-available' ? (
                      <Info size={16} className="shrink-0" />
                    ) : (
                      <AlertCircle size={16} className="shrink-0" />
                    )}
                    <span className="font-medium">
                      {manualUpdateStatus.type === 'up-to-date' &&
                        `Firelink ${manualUpdateStatus.latestVersion} is up to date.`}
                      {manualUpdateStatus.type === 'update-available' &&
                        `Firelink ${manualUpdateStatus.version} is available.`}
                      {manualUpdateStatus.type === 'error' && manualUpdateStatus.message}
                    </span>
                  </div>
                  {manualUpdateStatus.type === 'update-available' && (
                    <button
                      type="button"
                      onClick={() => void openExternalUrl(manualUpdateStatus.releaseUrl, 'latest release')}
                      className="app-button px-3 py-1 text-xs text-text-primary shrink-0 flex items-center gap-1.5"
                    >
                      View release
                      <ExternalLink size={12} />
                    </button>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <h4 className="text-[12px] font-bold text-text-primary px-1">Updates</h4>
                <div className="bg-bg-modal border border-border-modal/40 rounded-lg overflow-hidden">
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

              <div className="bg-bg-modal border border-border-modal/40 rounded-lg p-4 text-[11px] space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-text-primary font-bold">Created by NimBold</span>
                  <button
                    type="button"
                    onClick={() => void openExternalUrl(FIRELINK_LICENSE_URL, 'MIT License')}
                    className="flex items-center gap-1.5 text-text-secondary hover:text-accent transition-colors font-medium"
                  >
                    MIT License
                    <ExternalLink size={12} />
                  </button>
                </div>
                <div className="text-text-muted">
                  Credits: aria2, yt-dlp, FFmpeg, and Deno.
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

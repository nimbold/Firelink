import { useCallback, useRef, useState, useEffect } from 'react';
import {
  type AppFontSize,
  type ListRowDensity,
  type SidebarPosition,
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
import { useTranslation } from 'react-i18next';

const settingsTabs: { type: SettingsTab; icon: typeof Download }[] = [
  { type: 'downloads', icon: Download },
  { type: 'lookandfeel', icon: Palette },
  { type: 'network', icon: Globe },
  { type: 'locations', icon: Folder },
  { type: 'sitelogins', icon: Key },
  { type: 'power', icon: Moon },
  { type: 'engine', icon: Terminal },
  { type: 'integrations', icon: Puzzle },
  { type: 'about', icon: Info },
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
  categoryLabel,
  settings,
  onBrowse,
  disabled = false
}: {
  category: string;
  categoryLabel: string;
  settings: SettingsState;
  onBrowse: () => void;
  disabled?: boolean;
}) => {
  const { t } = useTranslation();
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
        aria-label={t($ => $.settings.locations.categorySubfolder, { category: categoryLabel })}
      />
      <button
        onClick={onBrowse}
        disabled={disabled}
        className="app-button px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-overlay disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-secondary"
      >
        {t($ => $.settings.locations.customFolder)}
      </button>
      {override && (
        <button
          onClick={() => {
            settings.setCategoryDirectoryOverride(category, undefined);
            setLocalValue(null);
          }}
          className="app-button px-3 py-1.5 text-xs text-text-secondary hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/30"
        >
          {t($ => $.settings.locations.useAutomatic)}
        </button>
      )}
    </div>
  );
};

export default function SettingsView() {
  const { t } = useTranslation();
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
          : t($ => $.settings.common.thisOs);
  const trayIconLabel =
    platform.os === 'macos'
      ? t($ => $.settings.lookAndFeel.menuBarIcon)
      : platform.os === 'linux'
        ? t($ => $.settings.lookAndFeel.statusIndicatorIcon)
        : t($ => $.settings.lookAndFeel.systemTrayIcon);
  const trayIconDescription =
    platform.os === 'macos'
      ? t($ => $.settings.lookAndFeel.macosTrayDescription)
      : platform.os === 'windows'
        ? t($ => $.settings.lookAndFeel.windowsTrayDescription)
        : platform.os === 'linux'
          ? t($ => $.settings.lookAndFeel.linuxTrayDescription)
          : t($ => $.settings.lookAndFeel.defaultTrayDescription);
  const userAgentMenuRef = useRef<HTMLDivElement>(null);
  const [isUserAgentMenuOpen, setIsUserAgentMenuOpen] = useState(false);

  // Local state for engine status
const [engineStatus, setEngineStatus] = useState<EngineStatusItem[] | null>(null);
const [expandedEngine, setExpandedEngine] = useState<string | null>(null);
const [isRecheckingEngines, setIsRecheckingEngines] = useState(false);
const engineRunId = useRef(0);
  const [appVersion, setAppVersion] = useState('');
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
      showToast(t($ => $.settings.common.externalOpenFailed, { label, detail: String(error) }), 'error');
    }
  };

  const findEngine = (kind: string) => engineStatus?.find(e => e.kind === kind) ?? null;

  const renderEngineStatus = (item: EngineStatusItem | null) => {
    if (!item) return <span className="text-text-muted font-medium">{t($ => $.settings.common.checking)}</span>;
    if (item.ready) return <span className="text-green-500 font-medium">{t($ => $.settings.common.ready)}</span>;
    return <span className="text-red-500 font-medium">{t($ => $.settings.common.errorMissing)}</span>;
  };

  const renderEngineVersion = (item: EngineStatusItem | null) => {
    if (!item) return t($ => $.settings.common.checking);
    if (item.version) return item.version;
    if (item.error) return `${t($ => $.settings.common.error)}: ${item.error.length > 80 ? item.error.substring(0, 80) + '…' : item.error}`;
    return t($ => $.addDownloads.unknown);
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
          {isExpanded ? t($ => $.settings.common.hideTechnicalDetails) : t($ => $.settings.common.showTechnicalDetails)}
        </button>
        {isExpanded && (
          <div className="mt-2 p-2 bg-bg-modal rounded text-[11px] font-mono text-text-muted space-y-1 leading-relaxed">
            {item.resolved_path && <p>{t($ => $.settings.common.binary)}: {item.resolved_path}</p>}
            {item.expected_sidecar && <p>{t($ => $.settings.common.expected)}: {item.expected_sidecar}</p>}
            {item.error && <p className="text-red-400">{t($ => $.settings.common.error)}: {item.error}</p>}
            {item.remediation_hint && <p className="text-yellow-500">{t($ => $.settings.common.tip)}: {item.remediation_hint}</p>}
            {item.stderr_tail && <details><summary className="cursor-pointer text-text-muted">{t($ => $.settings.common.stderr)}</summary><pre className="mt-1 whitespace-pre-wrap">{item.stderr_tail}</pre></details>}
            {item.daemon_alive != null && <p>{t($ => $.settings.common.daemonProcessAlive)}: {String(item.daemon_alive)}</p>}
            {item.rpc_ready != null && <p>{t($ => $.settings.common.rpcReady)}: {String(item.rpc_ready)}</p>}
            {item.rpc_port != null && <p>{t($ => $.settings.common.rpcPort)}: {item.rpc_port}</p>}
            {item.last_stderr_tail && <details><summary className="cursor-pointer text-text-muted">{t($ => $.settings.common.daemonStderr)}</summary><pre className="mt-1 whitespace-pre-wrap">{item.last_stderr_tail}</pre></details>}
            {item.expects_internal_dir === true && <p>{t($ => $.settings.common.packaging)}</p>}
            {item.has_internal_dir === true && <p>{t($ => $.settings.common.internalDirectoryFound)}: true</p>}
            {item.has_python_framework != null && <p>{t($ => $.settings.common.pythonRuntimeFound)}: {String(item.has_python_framework)}</p>}
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
          throw new Error(t($ => $.settings.common.updateUntrustedReleaseUrl));
        }
        setManualUpdateStatus({
          type: 'update-available',
          version: result.update.version,
          releaseUrl: result.update.release_url
        });
      } else {
        setManualUpdateStatus({
          type: 'error',
          message: t($ => $.settings.common.updateUnexpectedResponse)
        });
      }
    } catch (error) {
      setManualUpdateStatus({
        type: 'error',
        message: t($ => $.settings.common.updateFailed, { detail: String(error) })
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
          showToast(t($ => $.settings.locations.baseFolderCreateFailed, { detail: String(e) }), 'warning');
          return;
        }
        showToast(t($ => $.settings.locations.baseFolderUpdated), 'success');
      }
    } catch (e) {
      console.error("Failed to browse base path:", e);
    }
  };

  const handleAddLogin = async () => {
    if (saveLoginInFlight.current) return;
    const fieldErrors: typeof loginFieldErrors = {};
    if (!loginPattern.trim()) {
      fieldErrors.pattern = t($ => $.settings.siteLogins.urlPatternRequired);
    } else if (/\s/.test(loginPattern.trim())) {
      fieldErrors.pattern = t($ => $.settings.siteLogins.urlPatternWhitespace);
    }
    if (!loginUser.trim()) {
      fieldErrors.username = t($ => $.settings.siteLogins.usernameRequired);
    }
    if (!loginPass) {
      fieldErrors.password = t($ => $.settings.siteLogins.passwordRequired);
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
      setLoginError(t($ => $.settings.siteLogins.accessBeforeSave));
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
      setLoginError(t($ => $.settings.siteLogins.saveFailed));
      return;
    } finally {
      saveLoginInFlight.current = false;
      setIsSavingLogin(false);
    }

    setLoginPattern('');
    setLoginUser('');
    setLoginPass('');
    setLoginError('');
    showToast(t($ => $.settings.siteLogins.addedCredential), 'success');
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(settings.extensionPairingToken);
      showToast(t($ => $.settings.integrations.tokenCopied), 'success');
    } catch (error) {
      showToast(t($ => $.settings.integrations.tokenCopyFailed, { detail: String(error) }), 'error');
    }
  };

  const tabLabels: Record<SettingsTab, string> = {
    downloads: t($ => $.settings.tabs.downloads),
    lookandfeel: t($ => $.settings.tabs.lookAndFeel),
    network: t($ => $.settings.tabs.network),
    locations: t($ => $.settings.tabs.locations),
    sitelogins: t($ => $.settings.tabs.siteLogins),
    power: t($ => $.settings.tabs.power),
    engine: t($ => $.settings.tabs.engine),
    integrations: t($ => $.settings.tabs.integrations),
    about: t($ => $.settings.tabs.about),
  };
  const activeTabLabel = tabLabels[activeTab] ?? t($ => $.settings.tabs.downloads);
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
  const languageOptions = [
    { value: 'system', label: t($ => $.settings.lookAndFeel.languageSystem) },
    { value: 'en', label: t($ => $.settings.lookAndFeel.languageEnglish) },
    { value: 'zh-CN', label: t($ => $.settings.lookAndFeel.languageChinese) },
    { value: 'he', label: t($ => $.settings.lookAndFeel.languageHebrew) },
    { value: 'fa', label: t($ => $.settings.lookAndFeel.languagePersian) },
    { value: 'uk', label: t($ => $.settings.lookAndFeel.languageUkrainian) },
    { value: 'ru', label: t($ => $.settings.lookAndFeel.languageRussian) },
  ] as const;

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
              <TabButton key={tab.type} {...tab} label={tabLabels[tab.type]} />
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
                    <span>{t($ => $.settings.downloads.defaultConnections)}</span>
                    <small>{t($ => $.settings.downloads.defaultConnectionsDescription)}</small>
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
                    <span>{t($ => $.settings.downloads.parallelDownloads)}</span>
                    <small>{t($ => $.settings.downloads.parallelDownloadsDescription)}</small>
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
                    <span>{t($ => $.settings.downloads.automaticRetries)}</span>
                    <small>{t($ => $.settings.downloads.automaticRetriesDescription)}</small>
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
                    <span>{t($ => $.settings.downloads.systemNotification)}</span>
                    <small>{t($ => $.settings.downloads.systemNotificationDescription)}</small>
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
                      <span>{t($ => $.settings.downloads.completionChime)}</span>
                      <small>{t($ => $.settings.downloads.completionChimeDescription)}</small>
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
                    <span>{t($ => $.settings.downloads.clipboardLinks)}</span>
                    <small>{t($ => $.settings.downloads.clipboardLinksDescription)}</small>
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
              <h2 className="settings-section-title">{t($ => $.settings.lookAndFeel.language)}</h2>
              <div className="mac-settings-group">
                <div className="mac-settings-row">
                  <div className="settings-row-label">
                    <span>{t($ => $.settings.lookAndFeel.language)}</span>
                    <small>{t($ => $.settings.lookAndFeel.languageDescription)}</small>
                  </div>
                  <select
                    value={settings.language}
                    onChange={(event) => settings.setLanguage(event.target.value as typeof settings.language)}
                    className="app-control w-48"
                  >
                    {languageOptions.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="mac-settings-row">
                  <div className="settings-row-label">
                    <span>{t($ => $.settings.lookAndFeel.sidebarPosition)}</span>
                    <small>{t($ => $.settings.lookAndFeel.sidebarPositionDescription)}</small>
                  </div>
                  <select
                    value={settings.sidebarPosition}
                    onChange={(event) => settings.setSidebarPosition(event.target.value as SidebarPosition)}
                    className="app-control w-48"
                  >
                    <option value="auto">{t($ => $.settings.lookAndFeel.sidebarPositionAutomatic)}</option>
                    <option value="left">{t($ => $.settings.lookAndFeel.sidebarPositionLeft)}</option>
                    <option value="right">{t($ => $.settings.lookAndFeel.sidebarPositionRight)}</option>
                  </select>
                </div>
              </div>

              <h2 className="settings-section-title">{t($ => $.settings.lookAndFeel.appTheme)}</h2>
              <div className="mac-settings-group">
                <div className="mac-settings-row settings-choice-row">
                  <span className="text-[13px] text-text-primary pt-0.5">{t($ => $.settings.lookAndFeel.theme)}</span>
                  <div className="theme-option-grid" role="radiogroup" aria-label={t($ => $.settings.lookAndFeel.ariaLabel)}>
                    {[
                      { value: 'system', label: t($ => $.settings.lookAndFeel.system), colors: ['#f4f4f5', '#252525'] },
                      { value: 'light', label: t($ => $.settings.lookAndFeel.light), colors: ['#ffffff', '#e9e9ec'] },
                      { value: 'dark', label: t($ => $.settings.lookAndFeel.dark), colors: ['#1a1a1a', '#292929'] },
                      { value: 'dracula', label: t($ => $.settings.lookAndFeel.dracula), colors: ['#282a36', '#ff79c6'] },
                      { value: 'nord', label: t($ => $.settings.lookAndFeel.nord), colors: ['#2e3440', '#88c0d0'] },
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
                <p className="settings-group-footer">{t($ => $.settings.lookAndFeel.systemAppearance, { platform: platformName })}</p>
              </div>

              <h2 className="settings-section-title">{t($ => $.settings.lookAndFeel.display)}</h2>
              <div className="mac-settings-group">
                <div className="mac-settings-row">
                  <div className="settings-row-label">
                    <span>{t($ => $.settings.lookAndFeel.fontSize)}</span>
                    <small>{t($ => $.settings.lookAndFeel.fontSizeDescription)}</small>
                  </div>
                  <select
                    value={settings.appFontSize}
                    onChange={(e) => settings.setAppFontSize(e.target.value as AppFontSize)}
                    className="app-control w-40"
                  >
                    <option value="small">{t($ => $.settings.lookAndFeel.small)}</option>
                    <option value="standard">{t($ => $.settings.lookAndFeel.standard)}</option>
                    <option value="large">{t($ => $.settings.lookAndFeel.large)}</option>
                  </select>
                </div>
                <div className="mac-settings-row">
                  <div className="settings-row-label">
                    <span>{t($ => $.settings.lookAndFeel.listDensity)}</span>
                    <small>{t($ => $.settings.lookAndFeel.listDensityDescription)}</small>
                  </div>
                  <select
                    value={settings.listRowDensity}
                    onChange={(e) => settings.setListRowDensity(e.target.value as ListRowDensity)}
                    className="app-control w-40"
                  >
                    <option value="compact">{t($ => $.settings.lookAndFeel.compact)}</option>
                    <option value="standard">{t($ => $.settings.lookAndFeel.comfortable)}</option>
                    <option value="relaxed">{t($ => $.settings.lookAndFeel.relaxed)}</option>
                  </select>
                </div>
              </div>

              <h2 className="settings-section-title">{t($ => $.settings.lookAndFeel.osIntegration)}</h2>
              <div className="mac-settings-group">
                {platform.os === 'macos' && (
                  <label className="mac-settings-row cursor-default">
                    <div className="settings-row-label">
                      <span>{t($ => $.settings.lookAndFeel.dockBadge)}</span>
                      <small>{t($ => $.settings.lookAndFeel.dockBadgeDescription)}</small>
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
              <h2 className="settings-section-title">{t($ => $.settings.network.proxy)}</h2>
              <div className="mac-settings-group">
                <div className="mac-settings-row settings-network-row settings-choice-row">
                  <div className="settings-row-label">
                    <span>{t($ => $.settings.network.mode)}</span>
                    <small>{t($ => $.settings.network.modeDescription)}</small>
                  </div>
                  <div className="settings-radio-group">
                    {[
                      ['none', t($ => $.settings.network.noProxy)],
                      ['system', t($ => $.settings.network.systemProxy)],
                      ['custom', t($ => $.settings.network.customProxy)],
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
                        <span>{t($ => $.settings.network.proxyHost)}</span>
                        <small>{t($ => $.settings.network.proxyHostDescription)}</small>
                      </div>
                      <input
                        type="text"
                        value={settings.proxyHost}
                        onChange={(e) => settings.setProxyHost(e.target.value)}
                        placeholder={t($ => $.settings.network.proxyHostPlaceholder)}
                        className="app-control settings-network-input font-mono"
                      />
                    </div>
                    <div className="mac-settings-row settings-network-row">
                      <div className="settings-row-label">
                        <span>{t($ => $.settings.network.proxyPort)}</span>
                        <small>{t($ => $.settings.network.proxyPortDescription)}</small>
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
                  {settings.proxyMode === 'none' && t($ => $.settings.network.noProxyDescription)}
                  {settings.proxyMode === 'system' && t($ => $.settings.network.systemProxyDescription, { platform: platform.os === 'macos' ? 'macOS' : platform.os === 'windows' ? 'Windows' : 'desktop' })}
                  {settings.proxyMode === 'custom' && (normalizeCustomProxy(settings.proxyHost, settings.proxyPort)
                    ? t($ => $.settings.network.customProxyDescription)
                    : settings.proxyHost
                      ? t($ => $.settings.network.invalidCustomProxy)
                      : t($ => $.settings.network.incompleteCustomProxy))}
                </p>
                {settings.proxyMode === 'system' && (
                  <p className="settings-group-footer" role="status">
                    {systemProxyStatus === 'checking' && t($ => $.settings.network.checkingSystemProxy)}
                    {systemProxyStatus === 'detected' && t($ => $.settings.network.detectedSystemProxy)}
                    {systemProxyStatus === 'none' && t($ => $.settings.network.noSystemProxy)}
                    {systemProxyStatus === 'error' && t($ => $.settings.network.systemProxyReadFailed)}
                  </p>
                )}
              </div>

              <h2 className="settings-section-title">{t($ => $.settings.network.identity)}</h2>
              <div className="mac-settings-group settings-popup-group">
                <div className="mac-settings-row settings-network-row">
                  <div className="settings-row-label">
                    <span>{t($ => $.settings.network.customUserAgent)}</span>
                    <small>{t($ => $.settings.network.userAgentDescription)}</small>
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
                      placeholder={t($ => $.settings.network.userAgentPlaceholder)}
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
                            <span className="settings-combobox-meta">{
                              (option.label === 'Chrome (Windows)' ? t($ => $.settings.network.chromeWindows)
                                : option.label === 'Chrome (macOS)' ? t($ => $.settings.network.chromeMacos)
                                  : option.label === 'Edge (Windows)' ? t($ => $.settings.network.edgeWindows)
                                    : option.label === 'Firefox (Windows)' ? t($ => $.settings.network.firefoxWindows)
                                      : option.label === 'Firefox (macOS)' ? t($ => $.settings.network.firefoxMacos)
                                        : t($ => $.settings.network.safariMacos))
                              } · {
                                option.detail === 'Windows desktop'
                                  ? t($ => $.settings.network.windowsDesktop)
                                  : t($ => $.settings.network.macosDesktop)
                              }</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <p className="settings-group-footer">{t($ => $.settings.network.userAgentOverrides)}</p>
              </div>
            </div>
          )}

          {/* Locations Pane */}
          {activeTab === 'locations' && (
            <div className="settings-pane max-w-[760px]">
              <div className="mac-settings-group">
                <div className="mac-settings-row">
                  <div>
                    <span className="text-[13px] font-semibold text-text-primary">{t($ => $.settings.locations.baseDownloadFolder)}</span>
                    <p className="mt-0.5 text-[11px] text-text-muted">{t($ => $.settings.locations.baseDownloadFolderDescription)}</p>
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
                      {t($ => $.settings.locations.browse)}
                    </button>
                  </div>
                </div>
              </div>

              <div className="mac-settings-group">
                <label className="mac-settings-row cursor-default">
                  <span className="text-[13px] text-text-primary">{t($ => $.settings.locations.askWhereToSave)}</span>
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
                    <span className="text-[13px] text-text-primary">{t($ => $.settings.locations.rememberLastUsedDownloadDirectory)}</span>
                    <p className="mt-0.5 text-[11px] text-text-muted">{t($ => $.settings.locations.rememberLastUsedDownloadDirectoryDescription)}</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.rememberLastUsedDownloadDirectory}
                    onChange={(e) => settings.setRememberLastUsedDownloadDirectory(e.target.checked)}
                    className="mac-switch"
                  />
                </label>
              </div>

              <div className="mac-settings-group">
                <label className="mac-settings-row cursor-default">
                  <div>
                    <span className="text-[13px] text-text-primary">{t($ => $.settings.locations.automaticCategorySubfolders)}</span>
                    <p className="mt-0.5 text-[11px] text-text-muted">{t($ => $.settings.locations.automaticCategorySubfoldersDescription)}</p>
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
                  <span className="text-[13px] font-semibold text-text-primary">{t($ => $.settings.locations.categorySubfolders)}</span>
                  <span className="text-[11px] text-text-muted">
                    {settings.categorySubfoldersEnabled ? t($ => $.settings.locations.relativeToBase) : t($ => $.settings.locations.disabled)}
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
                        <span className="text-[13px] font-medium text-text-primary w-32 shrink-0">{categoryLabel(category)}</span>
                        <CategoryFolderInput
                          category={category}
                          categoryLabel={categoryLabel(category)}
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
                      showToast(t($ => $.settings.locations.resetToast), 'success');
                    }}
                    disabled={!settings.categorySubfoldersEnabled}
                    className="app-control hover:bg-item-hover text-text-secondary px-4 py-1 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    {t($ => $.settings.locations.resetDefaults)}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Site Logins Pane */}
          {activeTab === 'sitelogins' && (
            <div className="settings-pane space-y-6 max-w-[760px]">
              <h3 className="text-base font-bold text-text-primary border-b border-border-color/30 pb-2">{t($ => $.settings.siteLogins.title)}</h3>

              {/* Site Logins List */}
              <div className="space-y-2 max-h-[200px] overflow-y-auto border border-border-modal rounded-lg p-2 bg-item-hover/10">
                {(settings.siteLogins || []).length === 0 ? (
                  <p className="text-center text-text-muted text-[13px] py-6">{t($ => $.settings.siteLogins.noSavedLogins)}</p>
                ) : (
                  (settings.siteLogins || []).map((login) => (
                    <div key={login.id} className="flex justify-between items-center p-2 rounded bg-bg-modal border border-border-modal/40">
                      <div className="text-[13px] space-y-0.5">
                        <p className="font-bold text-text-primary font-mono text-[11px]">{login.urlPattern}</p>
                        <p className="text-text-secondary text-xs">{t($ => $.settings.siteLogins.user, { username: login.username })}</p>
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
                            showToast(t($ => $.settings.siteLogins.deletedCredential), 'success');
                          } catch (error) {
                            showToast(t($ => $.settings.siteLogins.deleteFailed, { detail: String(error) }), 'error');
                          }
                        }}
                        className="p-1.5 hover:bg-item-hover rounded-md text-text-muted hover:text-red-500"
                        title={t($ => $.settings.siteLogins.deleteCredential)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Add Site Login Form */}
              <div className="border-t border-border-color/30 pt-4 space-y-4">
                <h4 className="text-[13px] font-bold text-text-primary">{t($ => $.settings.siteLogins.addTitle)}</h4>

                {loginError && (
                  <p className="text-red-500 text-xs">{loginError}</p>
                )}

                <div className="grid grid-cols-[150px_1fr] items-center gap-4 text-[13px]">
                  <label className="text-text-secondary">{t($ => $.settings.siteLogins.urlPattern)}</label>
                  <input
                    type="text"
                    value={loginPattern}
                    onChange={(e) => {
                      setLoginPattern(e.target.value);
                      setLoginFieldErrors(current => ({ ...current, pattern: undefined }));
                    }}
                    placeholder={t($ => $.settings.siteLogins.urlPatternPlaceholder)}
                    aria-invalid={Boolean(loginFieldErrors.pattern)}
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-full text-text-primary focus:outline-none"
                  />
                  {loginFieldErrors.pattern && <p className="text-red-500 text-xs mt-1">{loginFieldErrors.pattern}</p>}
                </div>

                <div className="grid grid-cols-[150px_1fr] items-center gap-4 text-[13px]">
                  <label className="text-text-secondary">{t($ => $.settings.siteLogins.username)}</label>
                  <input
                    type="text"
                    value={loginUser}
                    onChange={(e) => {
                      setLoginUser(e.target.value);
                      setLoginFieldErrors(current => ({ ...current, username: undefined }));
                    }}
                    placeholder={t($ => $.settings.siteLogins.usernamePlaceholder)}
                    aria-invalid={Boolean(loginFieldErrors.username)}
                    className="bg-bg-input border border-border-modal rounded-md px-3 py-1.5 w-full text-text-primary focus:outline-none"
                  />
                  {loginFieldErrors.username && <p className="text-red-500 text-xs mt-1">{loginFieldErrors.username}</p>}
                </div>

                <div className="grid grid-cols-[150px_1fr] items-center gap-4 text-[13px]">
                  <label className="text-text-secondary">{t($ => $.settings.siteLogins.password)}</label>
                  <input
                    type="password"
                    value={loginPass}
                    onChange={(e) => {
                      setLoginPass(e.target.value);
                      setLoginFieldErrors(current => ({ ...current, password: undefined }));
                    }}
                    placeholder={t($ => $.settings.siteLogins.passwordPlaceholder)}
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
                    <Plus size={14} /> {isSavingLogin ? t($ => $.settings.siteLogins.saving) : t($ => $.settings.siteLogins.addLogin)}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Power Pane */}
          {activeTab === 'power' && (
            <div className="settings-pane space-y-6 max-w-[760px]">
              <h3 className="text-base font-bold text-text-primary border-b border-border-color/30 pb-2">{t($ => $.settings.power.title)}</h3>

              <label className="flex items-start gap-3 cursor-default select-none text-[13px] text-text-secondary">
                <input
                  type="checkbox"
                  checked={settings.preventsSleepWhileDownloading}
                  onChange={(e) => settings.setPreventsSleepWhileDownloading(e.target.checked)}
                  className="mt-0.5 rounded accent-accent"
                />
                <div>
                  <p className="font-semibold text-text-primary">{t($ => $.settings.power.preventSleep)}</p>
                  <p className="text-text-muted text-xs mt-0.5">{t($ => $.settings.power.preventSleepDescription)}</p>
                </div>
              </label>
            </div>
          )}

          {/* Engine Pane */}
          {activeTab === 'engine' && (
<div className="settings-pane space-y-6 max-w-[760px]">
<div className="flex items-center justify-between gap-3 border-b border-border-color/30 pb-2">
<div>
<h3 className="text-base font-bold text-text-primary">{t($ => $.settings.engine.title)}</h3>
<p className="text-[11px] text-text-muted mt-0.5">{t($ => $.settings.engine.description)}</p>
</div>
<button
type="button"
onClick={() => runEngineChecks(true)}
disabled={isRecheckingEngines}
className="app-button px-3 py-1.5 text-[12px] flex items-center gap-1.5 disabled:opacity-60"
>
<RefreshCw size={13} className={isRecheckingEngines ? 'animate-spin' : ''} />
{isRecheckingEngines ? t($ => $.settings.common.checking) : t($ => $.settings.engine.recheck)}
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
                        <Terminal size={14} className="text-accent" /> {t($ => $.settings.engine.coreDownloader)}
                      </h4>
                      <div className="grid grid-cols-[100px_1fr] text-[13px] items-center gap-x-2">
                        <span className="text-text-secondary">{t($ => $.settings.engine.version)}</span>
                        <span className="font-mono text-xs text-text-muted select-all truncate">{renderEngineVersion(a2)}</span>
                      </div>
                      <div className="grid grid-cols-[100px_1fr] text-[13px] items-center gap-x-2">
                        <span className="text-text-secondary">{t($ => $.settings.engine.status)}</span>
                        {renderEngineStatus(a2)}
                      </div>
                      {renderEngineDetails(a2)}
                    </div>

                    {/* yt-dlp / ffmpeg / deno card */}
                    <div className="border border-border-modal rounded-lg p-4 space-y-2 bg-item-hover/5">
                      <h4 className="text-[13px] font-bold text-text-primary flex items-center gap-2 border-b border-border-modal pb-1">
                        <Terminal size={14} className="text-orange-500" /> {t($ => $.settings.engine.mediaExtractors)}
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
                        <label className="text-text-secondary font-semibold pt-1.5">{t($ => $.settings.engine.browserCookiesSource)}</label>
                        <select
                          value={browserCookieSourceOptions.some(option => option.value === settings.mediaCookieSource) ? settings.mediaCookieSource : 'none'}
                          onChange={(e) => settings.setMediaCookieSource(e.target.value)}
                          className="bg-bg-input border border-border-modal rounded-lg p-1.5 text-[13px] text-text-primary focus:outline-none focus:border-accent w-full"
                        >
                          {browserCookieSourceOptions.map(option => (
                            <option key={option.value} value={option.value}>{option.value === 'none' ? t($ => $.settings.engine.none) : option.label}</option>
                          ))}
                        </select>
                      </div>
                    <p className="text-text-muted text-xs mt-1">{t($ => $.settings.engine.cookieDescription)}</p>
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
                  <h3 className="text-base font-bold text-text-primary">{t($ => $.settings.integrations.title)}</h3>
                  <p className="text-text-secondary text-xs">{t($ => $.settings.integrations.description)}</p>
                </div>
              </div>

              {settings.isPairingTokenPersistent ? (
                <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 flex items-center gap-3">
                  <div className="p-1.5 bg-green-500/20 rounded-full text-green-500 flex-shrink-0">
                    <Check size={16} strokeWidth={2.5} />
                  </div>
                  <div className="flex-1">
                    <h4 className="text-sm font-semibold text-green-500 m-0">
                      {platform.portable ? t($ => $.settings.integrations.portablePairingEnabled) : t($ => $.settings.integrations.pairingTokenPersisted)}
                    </h4>
                    <p className="text-xs text-text-secondary m-0 mt-0.5">
                      {platform.portable
                        ? t($ => $.settings.integrations.portablePersistedDescription)
                        : t($ => $.settings.integrations.systemPersistedDescription)}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-4 flex items-start gap-3">
                  <ShieldAlert className="w-5 h-5 text-orange-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h4 className="text-sm font-semibold text-text-primary mb-1">
                      {platform.portable ? t($ => $.settings.integrations.portablePairingAvailable) : t($ => $.settings.integrations.credentialStorageNeeded)}
                    </h4>
                    <p className="text-xs text-text-secondary mb-3">
                      {platform.portable
                        ? t($ => $.settings.integrations.portableAvailableDescription)
                        : t($ => $.settings.integrations.credentialStorageDescription)}
                    </p>
                    <button 
                      onClick={() => settings.setShowKeychainModal(true)}
                      className="px-4 py-1.5 rounded-md text-xs font-medium transition-colors bg-accent text-white hover:bg-accent/90 shadow-sm"
                    >
                    {platform.portable ? t($ => $.settings.integrations.reviewPortablePairing) : t($ => $.settings.integrations.grantCredentialAccess)}
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
                    <h4 className="text-[13px] font-bold text-text-primary mb-1">{t($ => $.settings.integrations.copyToken)}</h4>
                    <p className="text-text-muted text-[11px] leading-relaxed">{t($ => $.settings.integrations.tokenDescription)}</p>
                  </div>
                  <div className="space-y-2">
                    <button
                      onClick={() => void copyToken()}
                      className="w-full bg-accent hover:bg-accent text-white font-medium py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 shadow transition-colors"
                    >
                      <Copy size={11} /> {t($ => $.settings.integrations.copyToken)}
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          await settings.regeneratePairingToken();
                          showToast(t($ => $.settings.integrations.pairingTokenRegenerated), 'success');
                        } catch (error) {
                          showToast(t($ => $.settings.integrations.regenerateFailed, { detail: String(error) }), 'error');
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
                    <h4 className="text-[13px] font-bold text-text-primary mb-1">{t($ => $.settings.integrations.getExtension)}</h4>
                    <p className="text-text-muted text-[11px] leading-relaxed">{t($ => $.settings.integrations.extensionDescription)}</p>
                  </div>
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => void openExternalUrl(FIRELINK_FIREFOX_ADDON_URL, t($ => $.settings.integrations.firefoxAddons))}
                      className="w-full bg-item-hover hover:bg-item-hover/80 text-text-primary border border-border-modal font-medium py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 transition-colors"
                    >
                      {t($ => $.settings.integrations.firefoxAddons)}
                      <ExternalLink size={11} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void openExternalUrl(FIRELINK_EXTENSION_RELEASES_URL, t($ => $.settings.integrations.chromiumZip))}
                      className="w-full bg-item-hover hover:bg-item-hover/80 text-text-primary border border-border-modal font-medium py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 transition-colors"
                    >
                      {t($ => $.settings.integrations.chromiumZip)}
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
                  <h4 className="text-[13px] font-bold text-text-primary mb-1">{t($ => $.settings.integrations.pasteConnect)}</h4>
                  <p className="text-text-muted text-[11px] leading-relaxed">{t($ => $.settings.integrations.pasteConnectDescription)}</p>
                </div>
              </div>

              {/* Status Info */}
              <div className="border border-border-modal/70 rounded-lg p-3 bg-item-hover/10 flex justify-between items-center text-[12px]">
                <span className="text-text-secondary font-medium">{t($ => $.settings.integrations.extensionServerStatus)}</span>
                <span className={`${extensionServerPort ? 'text-green-500' : 'text-orange-400'} font-semibold flex items-center gap-1`}>
                  {extensionServerPort
                    ? t($ => $.settings.integrations.listening, { port: extensionServerPort })
                    : t($ => $.settings.integrations.unavailable)}
                </span>
              </div>
            </div>
          )}

          {/* About Pane */}
          {activeTab === 'about' && (
            <div className="settings-pane space-y-6 max-w-[760px]">
              <div className="bg-bg-modal border border-border-modal/40 rounded-lg p-5 flex items-center justify-between gap-5">
                <div className="flex items-center gap-4 min-w-0">
                  <img src={appIcon} alt={t($ => $.settings.about.firelinkIcon)} className="w-[68px] h-[68px] drop-shadow-md rounded-xl shrink-0" />
                  <div className="space-y-1 min-w-0">
                    <h3 className="text-[18px] font-bold text-text-primary leading-tight">Firelink</h3>
                    <p className="text-text-secondary text-[12px] font-medium">{t($ => $.settings.about.version, { version: appVersion || t($ => $.settings.about.unknown) })}</p>
                    <p className="text-text-muted text-[11px]">{t($ => $.settings.about.description)}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void openExternalUrl(FIRELINK_SOURCE_URL, t($ => $.settings.about.sourceCode))}
                  className="app-button px-3 py-1.5 text-xs shrink-0 flex items-center gap-1.5"
                >
                  <Code size={13} />
                  {t($ => $.settings.about.source)}
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
                        t($ => $.settings.about.upToDate, { version: manualUpdateStatus.latestVersion })}
                      {manualUpdateStatus.type === 'update-available' &&
                        t($ => $.settings.about.updateAvailable, { version: manualUpdateStatus.version })}
                      {manualUpdateStatus.type === 'error' && manualUpdateStatus.message}
                    </span>
                  </div>
                  {manualUpdateStatus.type === 'update-available' && (
                    <button
                      type="button"
                      onClick={() => void openExternalUrl(manualUpdateStatus.releaseUrl, t($ => $.settings.about.viewRelease))}
                      className="app-button px-3 py-1 text-xs text-text-primary shrink-0 flex items-center gap-1.5"
                    >
                      {t($ => $.settings.about.viewRelease)}
                      <ExternalLink size={12} />
                    </button>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <h4 className="text-[12px] font-bold text-text-primary px-1">{t($ => $.settings.about.updates)}</h4>
                <div className="bg-bg-modal border border-border-modal/40 rounded-lg overflow-hidden">
                  <div className="p-4 flex items-center justify-between border-b border-border-modal/40">
                    <div>
                      <p className="text-[13px] font-bold text-text-primary">{t($ => $.settings.about.checkForUpdates)}</p>
                      <p className="text-text-muted text-[11px] mt-0.5">{t($ => $.settings.about.updateDescription)}</p>
                    </div>
                    <button
                      onClick={handleCheckForUpdates}
                      disabled={isCheckingForUpdates}
                      className="app-button px-4 text-xs disabled:opacity-50"
                    >
                      {isCheckingForUpdates ? (
                        <>
                          <RefreshCw size={13} className="animate-spin" />
                          {t($ => $.settings.about.checking)}
                        </>
                      ) : t($ => $.settings.about.checkNow)}
                    </button>
                  </div>
                  <label className="p-4 flex items-center justify-between cursor-default">
                    <span className="text-[13px] font-bold text-text-primary">{t($ => $.settings.about.automaticUpdates)}</span>
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
                  <span className="text-text-primary font-bold">{t($ => $.settings.about.createdBy)}</span>
                  <button
                    type="button"
                    onClick={() => void openExternalUrl(FIRELINK_LICENSE_URL, t($ => $.settings.about.mitLicense))}
                    className="flex items-center gap-1.5 text-text-secondary hover:text-accent transition-colors font-medium"
                  >
                    {t($ => $.settings.about.mitLicense)}
                    <ExternalLink size={12} />
                  </button>
                </div>
                <div className="text-text-muted">
                  {t($ => $.settings.about.credits)}
                </div>
                <div className="text-text-muted pt-1 border-t border-border-modal/40">
                  {t($ => $.settings.about.copyright)}
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

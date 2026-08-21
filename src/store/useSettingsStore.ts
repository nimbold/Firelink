import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import { invokeCommand as invoke } from '../ipc';
import { info } from '../utils/logger';
import type { ActiveView } from '../bindings/ActiveView';
import type { AppFontSize } from '../bindings/AppFontSize';
import type { FontFamily } from '../bindings/FontFamily';
import type { ListRowDensity } from '../bindings/ListRowDensity';
import type { MediaCookieSource } from '../bindings/MediaCookieSource';
import type { PostQueueAction } from '../bindings/PostQueueAction';
import type { PersistedSettings } from '../bindings/PersistedSettings';
import type { PairingTokenHydration } from '../bindings/PairingTokenHydration';
import type { ProxyMode } from '../bindings/ProxyMode';
import type { SchedulerSettings } from '../bindings/SchedulerSettings';
import type { SettingsTab } from '../bindings/SettingsTab';
import type { SiteLogin } from '../bindings/SiteLogin';
import type { Theme } from '../bindings/Theme';
import type { WindowControlStyle } from '../bindings/WindowControlStyle';
import {
  DEFAULT_CATEGORY_SUBFOLDERS,
  normalizeDownloadLocationSettings
} from '../utils/downloadLocations';
import {
  DEFAULT_TORRENT_MAX_OPEN_FILES,
  MAX_TORRENT_MAX_OPEN_FILES,
  MIN_TORRENT_MAX_OPEN_FILES,
  DEFAULT_TORRENT_DHT_MESSAGE_TIMEOUT,
  DEFAULT_TORRENT_MAX_CONCURRENT_SEEDS,
  normalizeSpeedLimitForBackend,
  normalizeTorrentDhtMessageTimeout,
  normalizeTorrentMaxOpenFiles
} from '../utils/downloads';
import i18n from '../i18n';
import { isAppLocalePreference, type AppLocalePreference } from '../i18n/locales';
import {
  DEFAULT_CALENDAR_PREFERENCE,
  isCalendarPreference,
  type CalendarPreference
} from '../utils/dateTime';
import type { MainWindowSize } from '../bindings/MainWindowSize';
import { normalizeMainWindowSize } from '../utils/mainWindowState';

let settingsQueue: Promise<void> = Promise.resolve();
let torrentMaxOpenFilesQueue: Promise<void> = Promise.resolve();
let torrentOverallUploadLimitQueue: Promise<void> = Promise.resolve();
let pairingTokenHydrationRequest: Promise<PairingTokenHydration> | null = null;
let shouldPersistLegacyFoldersFallback = false;
const settingsPersistenceErrorListeners = new Set<() => void>();
let settingsPersistenceFailed = false;
const DEFAULT_SCHEDULER_QUEUE_ID = '00000000-0000-0000-0000-000000000001';
const LEGACY_FOLDERS_COLLAPSED_KEY = 'firelink-folders-collapsed';
export const DEFAULT_SPEED_LIMIT_PRESET_VALUES = [1, 5, 10];

const readLegacyFoldersCollapsed = (): boolean | undefined => {
  if (typeof window === 'undefined') return undefined;
  try {
    const value = window.localStorage.getItem(LEGACY_FOLDERS_COLLAPSED_KEY);
    return value === null ? undefined : value === 'true';
  } catch {
    return undefined;
  }
};

const initialFoldersCollapsed = readLegacyFoldersCollapsed() ?? false;

export const subscribeToSettingsPersistenceErrors = (listener: () => void): (() => void) => {
  settingsPersistenceErrorListeners.add(listener);
  if (settingsPersistenceFailed) listener();
  return () => settingsPersistenceErrorListeners.delete(listener);
};

const enqueueSettingsTask = <T>(task: () => Promise<T>): Promise<T> => {
  const result = settingsQueue.then(task, task);
  settingsQueue = result.then(() => undefined, () => undefined);
  return result;
};

const requestPairingTokenHydration = (): Promise<PairingTokenHydration> => {
  if (!pairingTokenHydrationRequest) {
    pairingTokenHydrationRequest = invoke('hydrate_extension_pairing_token')
      .finally(() => {
        pairingTokenHydrationRequest = null;
      });
  }
  return pairingTokenHydrationRequest;
};

export const runSettingsPersistenceTransaction = <T>(
  operation: () => Promise<T>
): Promise<T> => enqueueSettingsTask(operation);

export const waitForSettingsPersistence = (): Promise<void> => settingsQueue;

const notifySettingsPersistenceError = () => {
  if (settingsPersistenceFailed) return;
  settingsPersistenceFailed = true;
  for (const listener of settingsPersistenceErrorListeners) {
    try {
      listener();
    } catch (error) {
      console.error('Settings persistence error listener failed', error);
    }
  }
};

const THEME_VALUES = ['system', 'light', 'dark', 'dracula', 'nord'] as const;
const FONT_FAMILY_VALUES = [
  'system',
  'inter',
  'outfit',
  'vazirmatn',
  'noto-sans-hebrew',
  'noto-sans-sc',
  'roboto',
  'serif',
  'monospace',
] as const;
const WINDOW_CONTROL_STYLE_VALUES = ['auto', 'macos', 'windows', 'gnome', 'minimal'] as const;
const APP_FONT_SIZE_VALUES = ['small', 'standard', 'large'] as const;
const LIST_ROW_DENSITY_VALUES = ['compact', 'standard', 'relaxed'] as const;
const SIDEBAR_POSITION_VALUES = ['auto', 'left', 'right'] as const;
const PROXY_MODE_VALUES = ['none', 'system', 'custom'] as const;
const MEDIA_COOKIE_SOURCE_VALUES = [
  'none', 'safari', 'chrome', 'chromium', 'firefox', 'edge', 'brave', 'opera', 'vivaldi', 'whale'
] as const;
const SETTINGS_TAB_VALUES = [
  'downloads', 'lookandfeel', 'network', 'locations', 'sitelogins', 'power', 'engine', 'integrations', 'about'
] as const;

type PersistedSettingsSnapshot = PersistedSettings & {
  language: AppLocalePreference;
  keychainPromptDismissed: boolean;
  keychainAccessVersion: string;
};

const clampSettingInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
) => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
};

const isAllowedSetting = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && values.includes(value as T);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const sanitizeSiteLogins = (value: unknown): SiteLogin[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).filter((login): login is SiteLogin =>
    typeof login.id === 'string'
      && typeof login.urlPattern === 'string'
      && typeof login.username === 'string'
  );
};

const persistedBoolean = (value: unknown, fallback: boolean) =>
  typeof value === 'boolean' ? value : fallback;

const persistedString = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

const persistedFiniteInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return fallback;
  }
  return value >= minimum && value <= maximum ? value : fallback;
};

const tauriStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (name === 'firelink-settings') {
      try {
        return await invoke('db_load_settings');
      } catch (e) {
        console.error("Failed to load settings from DB", e);
        return null;
      }
    }
    return null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    if (name === 'firelink-settings') {
      await enqueueSettingsTask(async () => {
        try {
          await invoke('db_save_settings', { data: value });
          settingsPersistenceFailed = false;
        } catch {
          console.error('Failed to save settings to DB');
          notifySettingsPersistenceError();
        }
      });
    }
  },
  removeItem: async (_name: string): Promise<void> => {
    // no-op for now
  },
};

/**
 * Keychain identifier for the browser-extension pairing token. The token is an
 * HMAC shared secret and is therefore persisted via the OS keychain rather
 * than the user-data database. Legacy plaintext values are migrated into the
 * Keychain before being removed from persisted settings. Portable mode is the
 * explicit exception: its pairing token is persisted with the portable folder
 * so extension pairing follows that folder.
 */
export type {
  ActiveView,
  AppFontSize,
  FontFamily,
  CalendarPreference,
  ListRowDensity,
  MediaCookieSource,
  PostQueueAction,
  ProxyMode,
  SchedulerSettings,
  SettingsTab,
  SiteLogin,
  Theme,
  WindowControlStyle
};

export type SidebarPosition = 'auto' | 'left' | 'right';

export interface SettingsState {
  theme: Theme;
  fontFamily: FontFamily;
  windowControlStyle: WindowControlStyle;
  calendarPreference: CalendarPreference;
  language: AppLocalePreference;
  baseDownloadFolder: string;
  categorySubfoldersEnabled: boolean;
  categorySubfolders: Record<string, string>;
  categoryDirectoryOverrides: Record<string, string>;
  rememberLastUsedDownloadDirectory: boolean;
  /** Session-only path selected in the Add window; intentionally not persisted. */
  lastUsedDownloadDirectory: string | null;
  approvedDownloadRoots: string[];
  maxConcurrentDownloads: number;
  globalSpeedLimit: string;
  torrentOverallUploadLimit: string;
  speedLimitPresetValues: number[];
  logsEnabled: boolean;
  isSidebarVisible: boolean;
  isFoldersCollapsed: boolean;
  sidebarPosition: SidebarPosition;
  mainWindowSize: MainWindowSize | null;
  activeView: ActiveView;
  activeSettingsTab: SettingsTab;
  scheduler: SchedulerSettings;
  schedulerRunning: boolean;
  schedulerActiveDownloadIds: string[];
  schedulerLastStartKey: string;
  schedulerLastStopKey: string;
  lastCustomSpeedLimitKiB: number;
  lastCustomSpeedLimitUnit: string;

  // Replicated SwiftUI App Settings
  perServerConnections: number;
  maxAutomaticRetries: number;
  minimumNormalDownloadSpeedKiB: number;
  retryNotFoundErrors: boolean;
  adaptiveMirrorSelection: boolean;
  showNotifications: boolean;
  playCompletionSound: boolean;
  autoAddClipboardLinks: boolean;
  appFontSize: AppFontSize;
  listRowDensity: ListRowDensity;
  showDockBadge: boolean;
  /** Forces the App-level badge effect to run for every toggle request. */
  dockBadgeSyncVersion: number;
  showMenuBarIcon: boolean;
  proxyMode: ProxyMode;
  proxyHost: string;
  proxyPort: number;
  torrentEnableDht: boolean;
  torrentEnableDht6: boolean;
  torrentEnablePex: boolean;
  torrentEnableLpd: boolean;
  torrentMaxOpenFiles: number;
  torrentDhtMessageTimeout: number;
  torrentSeparateSeedSlots: boolean;
  torrentMaxConcurrentSeeds: number;
  torrentIpv6Enabled: boolean;
  torrentListenPort: string;
  torrentDhtListenPort: string;
  torrentExternalIp: string;
  torrentDhtEntryPoint: string;
  torrentDhtEntryPoint6: string;
  torrentDhtListenAddr6: string;
  torrentLpdInterface: string;
  torrentPeerIdPrefix: string;
  torrentPeerAgent: string;
  torrentBindAddress: string;
  aria2DiskCache: string;
  customUserAgent: string;
  askWhereToSaveEachFile: boolean;
  preventsSleepWhileDownloading: boolean;
  preventsDisplaySleepWhileDownloading: boolean;
  mediaCookieSource: MediaCookieSource;
  siteLogins: SiteLogin[];
  extensionPairingToken: string;
  isPairingTokenPersistent: boolean;
  keychainAccessGranted: boolean;
  keychainAccessVersion: string;
  keychainAccessReady: boolean;
  keychainPromptDismissed: boolean;
  autoCheckUpdates: boolean;
  showKeychainModal: boolean;

  setTheme: (theme: Theme) => void;
  setFontFamily: (fontFamily: FontFamily) => void;
  setWindowControlStyle: (style: WindowControlStyle) => void;
  setCalendarPreference: (calendarPreference: CalendarPreference) => void;
  setLanguage: (language: AppLocalePreference) => void;
  setBaseDownloadFolder: (path: string) => void;
  approveDownloadRoot: (path: string) => Promise<string>;
  setMaxConcurrentDownloads: (count: number) => void;
  setGlobalSpeedLimit: (limit: string) => Promise<void>;
  setTorrentOverallUploadLimit: (limit: string) => Promise<void>;
  setSpeedLimitPresetValues: (values: number[]) => void;
  setLogsEnabled: (enabled: boolean) => void;
  setSidebarPosition: (position: SidebarPosition) => void;
  setFoldersCollapsed: (collapsed: boolean) => void;
  toggleFoldersCollapsed: () => void;
  setMainWindowSize: (size: MainWindowSize) => void;
  setActiveView: (view: ActiveView) => void;
  setActiveSettingsTab: (tab: SettingsTab) => void;
  setScheduler: (settings: SchedulerSettings) => void;
  setSchedulerRunning: (running: boolean) => void;
  setSchedulerActiveDownloadIds: (ids: string[]) => void;
  setSchedulerLastStartKey: (key: string) => void;
  setSchedulerLastStopKey: (key: string) => void;
  setLastCustomSpeedLimitKiB: (limit: number) => void;
  setLastCustomSpeedLimitUnit: (unit: string) => void;
  toggleSidebar: () => void;

  setPerServerConnections: (count: number) => void;
  setMaxAutomaticRetries: (count: number) => void;
  setMinimumNormalDownloadSpeedKiB: (speed: number) => void;
  setRetryNotFoundErrors: (enabled: boolean) => void;
  setAdaptiveMirrorSelection: (enabled: boolean) => void;
  setShowNotifications: (show: boolean) => void;
  setPlayCompletionSound: (play: boolean) => void;
  setAutoAddClipboardLinks: (enabled: boolean) => void;
  setAppFontSize: (size: AppFontSize) => void;
  setListRowDensity: (density: ListRowDensity) => void;
  setShowDockBadge: (show: boolean) => void;
  setShowMenuBarIcon: (show: boolean) => void;
  setProxyMode: (mode: ProxyMode) => void;
  setProxyHost: (host: string) => void;
  setProxyPort: (port: number) => void;
  setTorrentEnableDht: (enabled: boolean) => void;
  setTorrentEnableDht6: (enabled: boolean) => void;
  setTorrentEnablePex: (enabled: boolean) => void;
  setTorrentEnableLpd: (enabled: boolean) => void;
  setTorrentMaxOpenFiles: (value: number) => Promise<void>;
  setTorrentDhtMessageTimeout: (value: number) => void;
  setTorrentSeparateSeedSlots: (enabled: boolean) => void;
  setTorrentMaxConcurrentSeeds: (value: number) => void;
  setTorrentIpv6Enabled: (enabled: boolean) => void;
  setTorrentListenPort: (value: string) => void;
  setTorrentDhtListenPort: (value: string) => void;
  setTorrentExternalIp: (value: string) => void;
  setTorrentDhtEntryPoint: (value: string) => void;
  setTorrentDhtEntryPoint6: (value: string) => void;
  setTorrentDhtListenAddr6: (value: string) => void;
  setTorrentLpdInterface: (value: string) => void;
  setTorrentPeerIdPrefix: (value: string) => void;
  setTorrentPeerAgent: (value: string) => void;
  setTorrentBindAddress: (value: string) => boolean;
  setAria2DiskCache: (value: string) => void;
  setCustomUserAgent: (userAgent: string) => void;
  setAskWhereToSaveEachFile: (ask: boolean) => void;
  setPreventsSleepWhileDownloading: (prevent: boolean) => void;
  setPreventsDisplaySleepWhileDownloading: (prevent: boolean) => void;
  setMediaCookieSource: (source: MediaCookieSource) => void;
  setRememberLastUsedDownloadDirectory: (enabled: boolean) => void;
  setLastUsedDownloadDirectory: (path: string) => void;
  setCategorySubfoldersEnabled: (enabled: boolean) => void;
  setCategorySubfolder: (category: string, subfolder: string) => void;
  setCategoryDirectoryOverride: (category: string, path?: string) => void;
  resetCategoryLocations: () => void;
  addSiteLogin: (login: SiteLogin) => void;
  removeSiteLogin: (id: string) => void;
  regeneratePairingToken: () => Promise<void>;
  setAutoCheckUpdates: (autoCheckUpdates: boolean) => void;
  hydratePairingToken: (isCurrent?: () => boolean) => Promise<boolean>;
  setShowKeychainModal: (show: boolean) => void;
  setKeychainAccessReady: (ready: boolean) => void;
  dismissKeychainPrompt: (version?: string) => void;
  hydrateSessionPairingToken: (isCurrent?: () => boolean) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      fontFamily: 'system',
      windowControlStyle: 'auto',
      calendarPreference: DEFAULT_CALENDAR_PREFERENCE,
      language: 'system',
      baseDownloadFolder: '~/Downloads',
      categorySubfoldersEnabled: true,
      categorySubfolders: { ...DEFAULT_CATEGORY_SUBFOLDERS },
      categoryDirectoryOverrides: {},
      rememberLastUsedDownloadDirectory: false,
      lastUsedDownloadDirectory: null,
      approvedDownloadRoots: [],
      maxConcurrentDownloads: 3,
      globalSpeedLimit: '',
      torrentOverallUploadLimit: '',
      speedLimitPresetValues: DEFAULT_SPEED_LIMIT_PRESET_VALUES,
      logsEnabled: false,
      activeView: 'downloads',
      activeSettingsTab: 'downloads',
      isSidebarVisible: true,
      isFoldersCollapsed: initialFoldersCollapsed,
      mainWindowSize: null,
      sidebarPosition: 'auto',
      scheduler: {
        enabled: false,
        startTime: '00:00',
        stopTimeEnabled: false,
        stopTime: '08:00',
        everyday: true,
        selectedDays: [0, 1, 2, 3, 4, 5, 6],
        selectedQueueIds: [DEFAULT_SCHEDULER_QUEUE_ID],
        postQueueAction: 'none'
      },
      schedulerRunning: false,
      schedulerActiveDownloadIds: [],
      schedulerLastStartKey: '',
      schedulerLastStopKey: '',
      lastCustomSpeedLimitKiB: 1024,
      lastCustomSpeedLimitUnit: 'MB/s',

      // Replicated SwiftUI defaults
      perServerConnections: 16,
      maxAutomaticRetries: 3,
      minimumNormalDownloadSpeedKiB: 0,
      retryNotFoundErrors: false,
      adaptiveMirrorSelection: true,
      showNotifications: true,
      playCompletionSound: false,
      autoAddClipboardLinks: false,
      appFontSize: 'standard',
      listRowDensity: 'standard',
      showDockBadge: true,
      dockBadgeSyncVersion: 0,
      showMenuBarIcon: true,
      proxyMode: 'none',
      proxyHost: '',
      proxyPort: 8080,
      torrentEnableDht: true,
      torrentEnableDht6: false,
      torrentEnablePex: true,
      torrentEnableLpd: false,
      torrentMaxOpenFiles: DEFAULT_TORRENT_MAX_OPEN_FILES,
      torrentDhtMessageTimeout: DEFAULT_TORRENT_DHT_MESSAGE_TIMEOUT,
      torrentSeparateSeedSlots: false,
      torrentMaxConcurrentSeeds: DEFAULT_TORRENT_MAX_CONCURRENT_SEEDS,
      torrentIpv6Enabled: true,
      torrentListenPort: '',
      torrentDhtListenPort: '',
      torrentExternalIp: '',
      torrentDhtEntryPoint: '',
      torrentDhtEntryPoint6: '',
      torrentDhtListenAddr6: '',
      torrentLpdInterface: '',
      torrentPeerIdPrefix: '',
      torrentPeerAgent: '',
      torrentBindAddress: '',
      aria2DiskCache: '16M',
      customUserAgent: '',
      askWhereToSaveEachFile: false,
      preventsSleepWhileDownloading: true,
      preventsDisplaySleepWhileDownloading: false,
      mediaCookieSource: 'none',
      siteLogins: [],
      extensionPairingToken: '',
      isPairingTokenPersistent: false,
      keychainAccessGranted: false,
      keychainAccessVersion: '',
      keychainAccessReady: false,
      keychainPromptDismissed: false,
      autoCheckUpdates: true,
      showKeychainModal: false,

      setTheme: (theme) => { info('Settings updated: theme'); set({ theme }); },
      setFontFamily: (fontFamily) => {
        info('Settings updated: fontFamily');
        set({ fontFamily });
      },
      setWindowControlStyle: (windowControlStyle) => {
        info('Settings updated: windowControlStyle');
        set({ windowControlStyle });
      },
      setCalendarPreference: (calendarPreference) => {
        info('Settings updated: calendarPreference');
        set({ calendarPreference });
      },
      setLanguage: (language) => { info('Settings updated: language'); set({ language }); },
      setBaseDownloadFolder: (path) => {
        info('Settings updated: baseDownloadFolder');
        set({ baseDownloadFolder: path });
      },
      approveDownloadRoot: async (path) => {
        const approvedPath = await invoke('approve_download_root', { path });
        set(state => ({
          approvedDownloadRoots: state.approvedDownloadRoots.includes(approvedPath)
            ? state.approvedDownloadRoots
            : [...state.approvedDownloadRoots, approvedPath]
        }));
        return approvedPath;
      },
      setMaxConcurrentDownloads: (max) => {
        info('Settings updated: maxConcurrentDownloads');
        set({
          maxConcurrentDownloads: clampSettingInteger(max, 1, 12, 3)
        });
      },
      setGlobalSpeedLimit: async (limit) => {
        const normalized = normalizeSpeedLimitForBackend(limit);
        if (limit.trim() && !normalized) {
          return Promise.reject(new Error('Global speed limit is invalid'));
        }
        await invoke('set_global_speed_limit', {
          limit: normalized
        });
        info('Settings updated: globalSpeedLimit');
        set({ globalSpeedLimit: normalized ?? '' });
      },
      setTorrentOverallUploadLimit: (limit) => {
        const normalizedLimit = normalizeSpeedLimitForBackend(limit);
        if (limit.trim() && !normalizedLimit) {
          return Promise.reject(new Error('Torrent overall upload limit is invalid'));
        }
        const normalized = normalizedLimit ?? '';
        const apply = async () => {
          await invoke('set_torrent_overall_upload_limit', {
            limit: normalized || null
          });
          info('Settings updated: torrentOverallUploadLimit');
          set({ torrentOverallUploadLimit: normalized });
        };
        const result = torrentOverallUploadLimitQueue.then(apply, apply);
        torrentOverallUploadLimitQueue = result.then(() => undefined, () => undefined);
        return result;
      },
      setSpeedLimitPresetValues: (speedLimitPresetValues) => set({ speedLimitPresetValues }),
      setLogsEnabled: (logsEnabled) => set({ logsEnabled }),
      setSidebarPosition: (sidebarPosition) => set({ sidebarPosition }),
      setFoldersCollapsed: (isFoldersCollapsed) => set({ isFoldersCollapsed }),
      toggleFoldersCollapsed: () => set(state => ({ isFoldersCollapsed: !state.isFoldersCollapsed })),
      setMainWindowSize: (size) => {
        const normalized = normalizeMainWindowSize(size);
        if (normalized) set({ mainWindowSize: normalized });
      },
      setActiveView: (view) => set({ activeView: view }),
      setActiveSettingsTab: (activeSettingsTab) => set({ activeSettingsTab }),
      setScheduler: (scheduler) => set({ scheduler }),
      setSchedulerRunning: (schedulerRunning) => set({ schedulerRunning }),
      setSchedulerActiveDownloadIds: (schedulerActiveDownloadIds) => set({ schedulerActiveDownloadIds }),
      setSchedulerLastStartKey: (schedulerLastStartKey) => set({ schedulerLastStartKey }),
      setSchedulerLastStopKey: (schedulerLastStopKey) => set({ schedulerLastStopKey }),
      setLastCustomSpeedLimitKiB: (lastCustomSpeedLimitKiB) => set({ lastCustomSpeedLimitKiB }),
      setLastCustomSpeedLimitUnit: (lastCustomSpeedLimitUnit) => set({ lastCustomSpeedLimitUnit }),
      toggleSidebar: () => set((state) => ({ isSidebarVisible: !state.isSidebarVisible })),

      setPerServerConnections: (perServerConnections) => set({
        perServerConnections: clampSettingInteger(perServerConnections, 1, 16, 16)
      }),
      setMaxAutomaticRetries: (maxAutomaticRetries) => set({
        maxAutomaticRetries: clampSettingInteger(maxAutomaticRetries, 0, 10, 3)
      }),
      setMinimumNormalDownloadSpeedKiB: (minimumNormalDownloadSpeedKiB) => set({
        minimumNormalDownloadSpeedKiB: clampSettingInteger(
          minimumNormalDownloadSpeedKiB,
          0,
          1_048_576,
          0
        )
      }),
      setRetryNotFoundErrors: (retryNotFoundErrors) => set({ retryNotFoundErrors }),
      setAdaptiveMirrorSelection: (adaptiveMirrorSelection) => set({ adaptiveMirrorSelection }),
      setShowNotifications: (showNotifications) => set({ showNotifications }),
      setPlayCompletionSound: (playCompletionSound) => set({ playCompletionSound }),
      setAutoAddClipboardLinks: (autoAddClipboardLinks) => set({ autoAddClipboardLinks }),
      setAppFontSize: (appFontSize) => set({ appFontSize }),
      setListRowDensity: (listRowDensity) => set({ listRowDensity }),
      setShowDockBadge: (showDockBadge) => {
        set(state => ({
          showDockBadge,
          dockBadgeSyncVersion: state.dockBadgeSyncVersion + 1
        }));
      },
      setShowMenuBarIcon: (showMenuBarIcon) => set({ showMenuBarIcon }),
      setProxyMode: (proxyMode) => set({ proxyMode }),
      setProxyHost: (proxyHost) => set({ proxyHost }),
      setProxyPort: (proxyPort) => set({
        proxyPort: Number.isFinite(proxyPort)
          ? Math.min(65535, Math.max(1, Math.trunc(proxyPort)))
          : 8080
      }),
      setTorrentEnableDht: (torrentEnableDht) => set({ torrentEnableDht }),
      setTorrentEnableDht6: (torrentEnableDht6) => set({ torrentEnableDht6 }),
      setTorrentEnablePex: (torrentEnablePex) => set({ torrentEnablePex }),
      setTorrentEnableLpd: (torrentEnableLpd) => set({ torrentEnableLpd }),
      setTorrentListenPort: (torrentListenPort) => set({ torrentListenPort }),
      setTorrentDhtListenPort: (torrentDhtListenPort) => set({ torrentDhtListenPort }),
      setTorrentExternalIp: (torrentExternalIp) => set({ torrentExternalIp }),
      setTorrentDhtEntryPoint: (torrentDhtEntryPoint) => set({ torrentDhtEntryPoint }),
      setTorrentDhtEntryPoint6: (torrentDhtEntryPoint6) => set({ torrentDhtEntryPoint6 }),
      setTorrentDhtListenAddr6: (torrentDhtListenAddr6) => set({ torrentDhtListenAddr6 }),
      setTorrentLpdInterface: (torrentLpdInterface) => set({ torrentLpdInterface }),
      setTorrentPeerIdPrefix: (torrentPeerIdPrefix) => set({ torrentPeerIdPrefix }),
      setTorrentPeerAgent: (torrentPeerAgent) => set({ torrentPeerAgent }),
      setTorrentBindAddress: (torrentBindAddress) => {
        let accepted = true;
        set(state => {
          if (!state.torrentIpv6Enabled && torrentBindAddress.includes(':')) {
            accepted = false;
            return state;
          }
          return { torrentBindAddress };
        });
        return accepted;
      },
      setAria2DiskCache: (aria2DiskCache) => set({ aria2DiskCache }),
      setTorrentMaxOpenFiles: (value) => {
        const normalized = normalizeTorrentMaxOpenFiles(value);
        if (normalized === undefined) {
          return Promise.reject(new Error(
            `Torrent maximum open files must be between ${MIN_TORRENT_MAX_OPEN_FILES} and ${MAX_TORRENT_MAX_OPEN_FILES}`
          ));
        }
        const apply = async () => {
          await invoke('set_torrent_max_open_files', { max_open_files: normalized });
          info('Settings updated: torrentMaxOpenFiles');
          set({ torrentMaxOpenFiles: normalized });
        };
        const result = torrentMaxOpenFilesQueue.then(apply, apply);
        torrentMaxOpenFilesQueue = result.then(() => undefined, () => undefined);
        return result;
      },
      setTorrentDhtMessageTimeout: (value) => {
        const normalized = normalizeTorrentDhtMessageTimeout(value);
        set({
          torrentDhtMessageTimeout: normalized
            ?? DEFAULT_TORRENT_DHT_MESSAGE_TIMEOUT
        });
      },
      setTorrentSeparateSeedSlots: (torrentSeparateSeedSlots) => set({ torrentSeparateSeedSlots }),
      setTorrentMaxConcurrentSeeds: (value) => set({
        torrentMaxConcurrentSeeds: Number.isInteger(value) && value >= 1 && value <= 64
          ? value
          : DEFAULT_TORRENT_MAX_CONCURRENT_SEEDS
      }),
      setTorrentIpv6Enabled: (torrentIpv6Enabled) => set(state => ({
        torrentIpv6Enabled,
        // An IPv6 bind address is invalid once IPv6 transport is disabled.
        // Clear it as part of the same state transition so the next durable
        // settings save cannot fail on a cross-field contradiction.
        ...(torrentIpv6Enabled || !state.torrentBindAddress.includes(':')
          ? {}
          : { torrentBindAddress: '' })
      })),
      setCustomUserAgent: (customUserAgent) => set({ customUserAgent }),
      setAskWhereToSaveEachFile: (askWhereToSaveEachFile) => set({ askWhereToSaveEachFile }),
      setPreventsSleepWhileDownloading: (preventsSleepWhileDownloading) => {
        info('Settings updated: preventsSleepWhileDownloading');
        set({ preventsSleepWhileDownloading });
      },
      setPreventsDisplaySleepWhileDownloading: (preventsDisplaySleepWhileDownloading) => {
        info('Settings updated: preventsDisplaySleepWhileDownloading');
        set({ preventsDisplaySleepWhileDownloading });
      },
      setMediaCookieSource: (mediaCookieSource) => { info('Settings updated: mediaCookieSource'); set({ mediaCookieSource }); },
      setRememberLastUsedDownloadDirectory: (rememberLastUsedDownloadDirectory) => {
        info('Settings updated: rememberLastUsedDownloadDirectory');
        set({
          rememberLastUsedDownloadDirectory,
          ...(rememberLastUsedDownloadDirectory ? {} : { lastUsedDownloadDirectory: null })
        });
      },
      setLastUsedDownloadDirectory: (path) => {
        const trimmedPath = path.trim();
        if (!trimmedPath) return;
        set({ lastUsedDownloadDirectory: trimmedPath });
      },
      setCategorySubfoldersEnabled: (categorySubfoldersEnabled) => {
        info('Settings updated: categorySubfoldersEnabled');
        set({ categorySubfoldersEnabled });
      },
      setCategorySubfolder: (category, subfolder) => {
        info(`Settings updated: category subfolder ${category}`);
        set((state) => ({
          categorySubfolders: { ...state.categorySubfolders, [category]: subfolder }
        }));
      },
      setCategoryDirectoryOverride: (category, path) => {
        info(`Settings updated: category directory override ${category}`);
        set((state) => {
          const next = { ...state.categoryDirectoryOverrides };
          if (path?.trim()) next[category] = path.trim();
          else delete next[category];
          return { categoryDirectoryOverrides: next };
        });
      },
      resetCategoryLocations: () => {
        info('Settings updated: resetCategoryLocations');
        set({
          categorySubfolders: { ...DEFAULT_CATEGORY_SUBFOLDERS },
          categoryDirectoryOverrides: {}
        });
      },
      addSiteLogin: (login) => set((state) => ({
        siteLogins: [...state.siteLogins, login]
      })),
      removeSiteLogin: (id) => set((state) => ({
        siteLogins: state.siteLogins.filter((login) => login.id !== id)
      })),
      regeneratePairingToken: async () => {
        const current = get();
        if (!current.keychainAccessReady && !current.isPairingTokenPersistent) {
          set({ showKeychainModal: true });
          throw new Error(i18n.t($ => $.keychain.accessRequired));
        }
        const result = await invoke('regenerate_pairing_token');
        if (!result.persistent) {
          throw new Error(result.error || i18n.t($ => $.keychain.storeUnavailable));
        }
        set({
          extensionPairingToken: result.token,
          isPairingTokenPersistent: true,
          showKeychainModal: false
        });
      },
      hydratePairingToken: async (isCurrent) => {
        // The backend migrates legacy settings copies and reads the token from
        // the credential store after the app state is ready to receive it.
        // Portable mode remains the explicit folder-contained exception.
        const result = await requestPairingTokenHydration();
        if (isCurrent && !isCurrent()) return false;
        set({ 
          extensionPairingToken: result.token,
          isPairingTokenPersistent: result.persistent,
          showKeychainModal: !result.persistent && !get().keychainPromptDismissed
        });
        return result.tokenChanged;
      },
      hydrateSessionPairingToken: async (isCurrent) => {
        const result = await invoke('get_session_pairing_token');
        if (isCurrent && !isCurrent()) return;
        set({
          extensionPairingToken: result.token,
          isPairingTokenPersistent: false,
          keychainAccessReady: false
        });
      },
      setAutoCheckUpdates: (autoCheckUpdates: boolean) => set({ autoCheckUpdates }),
      setShowKeychainModal: (show: boolean) => set({ showKeychainModal: show }),
      setKeychainAccessReady: (ready: boolean) => set({ keychainAccessReady: ready }),
      dismissKeychainPrompt: (version?: string) => set(state => ({
        keychainAccessGranted: false,
        isPairingTokenPersistent: false,
        keychainAccessReady: false,
        keychainAccessVersion: version || state.keychainAccessVersion,
        keychainPromptDismissed: true,
        showKeychainModal: false
      })),
    }),
    {
      name: 'firelink-settings',
      storage: createJSONStorage(() => tauriStorage),
      version: 6,
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return persistedState as SettingsState;
        }
        const persisted = persistedState as Partial<SettingsState>;
        const locations = normalizeDownloadLocationSettings(
          persisted as Partial<SettingsState> & {
            defaultDownloadPath?: unknown;
            downloadDirectories?: unknown;
          }
        );
        return {
          ...persisted,
          ...locations,
          scheduler: persisted.scheduler
            ? {
                ...persisted.scheduler,
                selectedQueueIds: Array.isArray(persisted.scheduler.selectedQueueIds)
                  && persisted.scheduler.selectedQueueIds.length > 0
                  ? persisted.scheduler.selectedQueueIds
                  : [DEFAULT_SCHEDULER_QUEUE_ID]
              }
            : persisted.scheduler,
          siteLogins: Array.isArray(persisted.siteLogins) ? persisted.siteLogins : [],
          approvedDownloadRoots: Array.isArray(persisted.approvedDownloadRoots)
            ? persisted.approvedDownloadRoots
            : [],
          speedLimitPresetValues: Array.isArray(persisted.speedLimitPresetValues)
            ? persisted.speedLimitPresetValues
            : DEFAULT_SPEED_LIMIT_PRESET_VALUES,
          logsEnabled: persisted.logsEnabled === true
        } as SettingsState;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) {
          shouldPersistLegacyFoldersFallback = false;
          return;
        }
        if (!shouldPersistLegacyFoldersFallback) return;
        shouldPersistLegacyFoldersFallback = false;
        state.setFoldersCollapsed(state.isFoldersCollapsed);
      },
      partialize: (state): PersistedSettingsSnapshot => ({
        theme: state.theme,
        fontFamily: state.fontFamily,
        windowControlStyle: state.windowControlStyle,
        calendarPreference: state.calendarPreference,
        language: state.language,
        baseDownloadFolder: state.baseDownloadFolder,
        categorySubfoldersEnabled: state.categorySubfoldersEnabled,
        categorySubfolders: state.categorySubfolders,
        categoryDirectoryOverrides: state.categoryDirectoryOverrides,
        rememberLastUsedDownloadDirectory: state.rememberLastUsedDownloadDirectory,
        approvedDownloadRoots: state.approvedDownloadRoots,
        maxConcurrentDownloads: state.maxConcurrentDownloads,
        globalSpeedLimit: state.globalSpeedLimit,
        torrentOverallUploadLimit: state.torrentOverallUploadLimit,
        speedLimitPresetValues: state.speedLimitPresetValues,
        logsEnabled: state.logsEnabled,
        isSidebarVisible: state.isSidebarVisible,
        isFoldersCollapsed: state.isFoldersCollapsed,
        mainWindowSize: state.mainWindowSize ?? undefined,
        sidebarPosition: state.sidebarPosition,
        activeSettingsTab: state.activeSettingsTab,
        scheduler: state.scheduler,
        schedulerRunning: state.schedulerRunning,
        schedulerActiveDownloadIds: state.schedulerActiveDownloadIds,
        schedulerLastStartKey: state.schedulerLastStartKey,
        schedulerLastStopKey: state.schedulerLastStopKey,
        lastCustomSpeedLimitKiB: state.lastCustomSpeedLimitKiB,
        lastCustomSpeedLimitUnit: state.lastCustomSpeedLimitUnit,
        
        perServerConnections: state.perServerConnections,
        maxAutomaticRetries: state.maxAutomaticRetries,
        minimumNormalDownloadSpeedKiB: state.minimumNormalDownloadSpeedKiB,
        retryNotFoundErrors: state.retryNotFoundErrors,
        adaptiveMirrorSelection: state.adaptiveMirrorSelection,
        showNotifications: state.showNotifications,
        playCompletionSound: state.playCompletionSound,
        autoAddClipboardLinks: state.autoAddClipboardLinks,
        appFontSize: state.appFontSize,
        listRowDensity: state.listRowDensity,
        showDockBadge: state.showDockBadge,
        showMenuBarIcon: state.showMenuBarIcon,
        proxyMode: state.proxyMode,
        proxyHost: state.proxyHost,
        proxyPort: state.proxyPort,
        torrentEnableDht: state.torrentEnableDht,
        torrentEnableDht6: state.torrentEnableDht6,
        torrentEnablePex: state.torrentEnablePex,
        torrentEnableLpd: state.torrentEnableLpd,
        torrentMaxOpenFiles: state.torrentMaxOpenFiles,
        torrentDhtMessageTimeout: state.torrentDhtMessageTimeout,
        torrentSeparateSeedSlots: state.torrentSeparateSeedSlots,
        torrentMaxConcurrentSeeds: state.torrentMaxConcurrentSeeds,
        torrentIpv6Enabled: state.torrentIpv6Enabled,
        torrentListenPort: state.torrentListenPort,
        torrentDhtListenPort: state.torrentDhtListenPort,
        torrentExternalIp: state.torrentExternalIp,
        torrentDhtEntryPoint: state.torrentDhtEntryPoint,
        torrentDhtEntryPoint6: state.torrentDhtEntryPoint6,
        torrentDhtListenAddr6: state.torrentDhtListenAddr6,
        torrentLpdInterface: state.torrentLpdInterface,
        torrentPeerIdPrefix: state.torrentPeerIdPrefix,
        torrentPeerAgent: state.torrentPeerAgent,
        torrentBindAddress: state.torrentBindAddress,
        aria2DiskCache: state.aria2DiskCache,
        customUserAgent: state.customUserAgent,
        askWhereToSaveEachFile: state.askWhereToSaveEachFile,
        preventsSleepWhileDownloading: state.preventsSleepWhileDownloading,
        preventsDisplaySleepWhileDownloading: state.preventsDisplaySleepWhileDownloading,
        mediaCookieSource: state.mediaCookieSource,
        siteLogins: state.siteLogins,
        keychainAccessGranted: state.keychainAccessGranted,
        keychainAccessVersion: state.keychainAccessVersion,
        keychainPromptDismissed: state.keychainPromptDismissed,
        autoCheckUpdates: state.autoCheckUpdates
      }),
      merge: (persistedState: unknown, currentState) => {
        const persisted = persistedState && typeof persistedState === 'object'
          ? persistedState as Partial<SettingsState>
          : {};
        shouldPersistLegacyFoldersFallback = false;
        const legacyFoldersCollapsed = readLegacyFoldersCollapsed();
        if (typeof persisted.isFoldersCollapsed !== 'boolean' && legacyFoldersCollapsed !== undefined) {
          shouldPersistLegacyFoldersFallback = true;
        }
        const foldersCollapsedFallback = legacyFoldersCollapsed
          ?? currentState.isFoldersCollapsed;
        const locations = normalizeDownloadLocationSettings(persisted);
        return ({
          ...currentState,
          ...persisted,
          ...locations,
          extensionPairingToken: currentState.extensionPairingToken,
          // Never hydrate the remembered Add-window path from persisted data.
          lastUsedDownloadDirectory: currentState.lastUsedDownloadDirectory,
          keychainAccessReady: currentState.keychainAccessReady,
          theme: isAllowedSetting(THEME_VALUES, persisted.theme)
            ? persisted.theme
            : currentState.theme,
          fontFamily: isAllowedSetting(FONT_FAMILY_VALUES, persisted.fontFamily)
            ? persisted.fontFamily
            : currentState.fontFamily,
          windowControlStyle: isAllowedSetting(WINDOW_CONTROL_STYLE_VALUES, persisted.windowControlStyle)
            ? persisted.windowControlStyle
            : currentState.windowControlStyle,
          calendarPreference: isCalendarPreference(persisted.calendarPreference)
            ? persisted.calendarPreference
            : currentState.calendarPreference,
          language: isAppLocalePreference(persisted.language)
            ? persisted.language
            : currentState.language,
          isFoldersCollapsed: persistedBoolean(
            persisted.isFoldersCollapsed,
            foldersCollapsedFallback
          ),
          isSidebarVisible: persistedBoolean(
            persisted.isSidebarVisible,
            currentState.isSidebarVisible
          ),
          mainWindowSize: normalizeMainWindowSize(persisted.mainWindowSize)
            ?? currentState.mainWindowSize,
          appFontSize: isAllowedSetting(APP_FONT_SIZE_VALUES, persisted.appFontSize)
            ? persisted.appFontSize
            : currentState.appFontSize,
          listRowDensity: isAllowedSetting(LIST_ROW_DENSITY_VALUES, persisted.listRowDensity)
            ? persisted.listRowDensity
            : currentState.listRowDensity,
          torrentEnableDht: persistedBoolean(persisted.torrentEnableDht, currentState.torrentEnableDht),
          torrentEnableDht6: persistedBoolean(persisted.torrentEnableDht6, currentState.torrentEnableDht6),
          torrentEnablePex: persistedBoolean(persisted.torrentEnablePex, currentState.torrentEnablePex),
          torrentEnableLpd: persistedBoolean(persisted.torrentEnableLpd, currentState.torrentEnableLpd),
          torrentMaxOpenFiles: normalizeTorrentMaxOpenFiles(persisted.torrentMaxOpenFiles)
            ?? currentState.torrentMaxOpenFiles,
          torrentDhtMessageTimeout: normalizeTorrentDhtMessageTimeout(persisted.torrentDhtMessageTimeout)
            ?? currentState.torrentDhtMessageTimeout,
          torrentSeparateSeedSlots: persistedBoolean(
            persisted.torrentSeparateSeedSlots,
            currentState.torrentSeparateSeedSlots
          ),
          torrentMaxConcurrentSeeds: typeof persisted.torrentMaxConcurrentSeeds === 'number'
            && Number.isInteger(persisted.torrentMaxConcurrentSeeds)
            && persisted.torrentMaxConcurrentSeeds >= 1
            && persisted.torrentMaxConcurrentSeeds <= 64
            ? persisted.torrentMaxConcurrentSeeds
            : currentState.torrentMaxConcurrentSeeds,
          torrentIpv6Enabled: persistedBoolean(
            persisted.torrentIpv6Enabled,
            currentState.torrentIpv6Enabled
          ),
          torrentListenPort: typeof persisted.torrentListenPort === 'string'
            ? persisted.torrentListenPort
            : currentState.torrentListenPort,
          torrentDhtListenPort: typeof persisted.torrentDhtListenPort === 'string'
            ? persisted.torrentDhtListenPort
            : currentState.torrentDhtListenPort,
          torrentExternalIp: typeof persisted.torrentExternalIp === 'string'
            ? persisted.torrentExternalIp
            : currentState.torrentExternalIp,
          torrentDhtEntryPoint: typeof persisted.torrentDhtEntryPoint === 'string'
            ? persisted.torrentDhtEntryPoint
            : currentState.torrentDhtEntryPoint,
          torrentDhtEntryPoint6: typeof persisted.torrentDhtEntryPoint6 === 'string'
            ? persisted.torrentDhtEntryPoint6
            : currentState.torrentDhtEntryPoint6,
          torrentDhtListenAddr6: typeof persisted.torrentDhtListenAddr6 === 'string'
            ? persisted.torrentDhtListenAddr6
            : currentState.torrentDhtListenAddr6,
          torrentLpdInterface: typeof persisted.torrentLpdInterface === 'string'
            ? persisted.torrentLpdInterface
            : currentState.torrentLpdInterface,
          torrentPeerIdPrefix: typeof persisted.torrentPeerIdPrefix === 'string'
            ? persisted.torrentPeerIdPrefix
            : currentState.torrentPeerIdPrefix,
          torrentPeerAgent: typeof persisted.torrentPeerAgent === 'string'
            ? persisted.torrentPeerAgent
            : currentState.torrentPeerAgent,
          torrentBindAddress: typeof persisted.torrentBindAddress === 'string'
            ? persisted.torrentBindAddress
            : currentState.torrentBindAddress,
          aria2DiskCache: persistedString(persisted.aria2DiskCache, currentState.aria2DiskCache),
          customUserAgent: persistedString(persisted.customUserAgent, currentState.customUserAgent),
          sidebarPosition: isAllowedSetting(SIDEBAR_POSITION_VALUES, persisted.sidebarPosition)
            ? persisted.sidebarPosition
            : currentState.sidebarPosition,
          proxyMode: isAllowedSetting(PROXY_MODE_VALUES, persisted.proxyMode)
            ? persisted.proxyMode
            : currentState.proxyMode,
          proxyHost: persistedString(persisted.proxyHost, currentState.proxyHost),
          proxyPort: persistedFiniteInteger(persisted.proxyPort, 1, 65_535, currentState.proxyPort),
          mediaCookieSource: isAllowedSetting(MEDIA_COOKIE_SOURCE_VALUES, persisted.mediaCookieSource)
            ? persisted.mediaCookieSource
            : 'none',
          activeSettingsTab: isAllowedSetting(SETTINGS_TAB_VALUES, persisted.activeSettingsTab)
            ? persisted.activeSettingsTab
            : currentState.activeSettingsTab,
          showNotifications: persistedBoolean(persisted.showNotifications, currentState.showNotifications),
          playCompletionSound: persistedBoolean(persisted.playCompletionSound, currentState.playCompletionSound),
          autoAddClipboardLinks: persistedBoolean(
            persisted.autoAddClipboardLinks,
            currentState.autoAddClipboardLinks
          ),
          rememberLastUsedDownloadDirectory: persistedBoolean(
            persisted.rememberLastUsedDownloadDirectory,
            currentState.rememberLastUsedDownloadDirectory
          ),
          showDockBadge: persistedBoolean(persisted.showDockBadge, currentState.showDockBadge),
          showMenuBarIcon: persistedBoolean(persisted.showMenuBarIcon, currentState.showMenuBarIcon),
          askWhereToSaveEachFile: persistedBoolean(
            persisted.askWhereToSaveEachFile,
            currentState.askWhereToSaveEachFile
          ),
          preventsSleepWhileDownloading: persistedBoolean(
            persisted.preventsSleepWhileDownloading,
            currentState.preventsSleepWhileDownloading
          ),
          preventsDisplaySleepWhileDownloading: persistedBoolean(
            persisted.preventsDisplaySleepWhileDownloading,
            currentState.preventsDisplaySleepWhileDownloading
          ),
          keychainAccessGranted: persistedBoolean(
            persisted.keychainAccessGranted,
            currentState.keychainAccessGranted
          ),
          keychainAccessVersion: typeof persisted.keychainAccessVersion === 'string'
            ? persisted.keychainAccessVersion
            : currentState.keychainAccessVersion,
          keychainPromptDismissed: persistedBoolean(
            persisted.keychainPromptDismissed,
            currentState.keychainPromptDismissed
          ),
          autoCheckUpdates: persistedBoolean(persisted.autoCheckUpdates, currentState.autoCheckUpdates),
          maxConcurrentDownloads: clampSettingInteger(
            persisted.maxConcurrentDownloads,
            1,
            12,
            currentState.maxConcurrentDownloads
          ),
          torrentOverallUploadLimit: typeof persisted.torrentOverallUploadLimit === 'string'
            ? normalizeSpeedLimitForBackend(persisted.torrentOverallUploadLimit) ?? ''
            : currentState.torrentOverallUploadLimit,
          globalSpeedLimit: typeof persisted.globalSpeedLimit === 'string'
            ? normalizeSpeedLimitForBackend(persisted.globalSpeedLimit) ?? ''
            : currentState.globalSpeedLimit,
          perServerConnections: clampSettingInteger(
            persisted.perServerConnections,
            1,
            16,
            currentState.perServerConnections
          ),
          maxAutomaticRetries: clampSettingInteger(
            persisted.maxAutomaticRetries,
            0,
            10,
            currentState.maxAutomaticRetries
          ),
          minimumNormalDownloadSpeedKiB: clampSettingInteger(
            persisted.minimumNormalDownloadSpeedKiB,
            0,
            1_048_576,
            currentState.minimumNormalDownloadSpeedKiB
          ),
          retryNotFoundErrors: persistedBoolean(
            persisted.retryNotFoundErrors,
            currentState.retryNotFoundErrors
          ),
          adaptiveMirrorSelection: persistedBoolean(
            persisted.adaptiveMirrorSelection,
            currentState.adaptiveMirrorSelection
          ),
          speedLimitPresetValues: Array.isArray(persisted.speedLimitPresetValues)
            ? persisted.speedLimitPresetValues.filter(
              (value): value is number => typeof value === 'number' && Number.isFinite(value)
            )
            : currentState.speedLimitPresetValues,
          lastCustomSpeedLimitKiB: persistedFiniteInteger(
            persisted.lastCustomSpeedLimitKiB,
            1,
            10_485_760,
            currentState.lastCustomSpeedLimitKiB
          ),
          lastCustomSpeedLimitUnit: persisted.lastCustomSpeedLimitUnit === 'KB/s'
            || persisted.lastCustomSpeedLimitUnit === 'MB/s'
            ? persisted.lastCustomSpeedLimitUnit
            : currentState.lastCustomSpeedLimitUnit,
          logsEnabled: persisted.logsEnabled === true,
          approvedDownloadRoots: Array.isArray(persisted.approvedDownloadRoots)
            ? persisted.approvedDownloadRoots.filter((root): root is string => typeof root === 'string')
            : currentState.approvedDownloadRoots,
        scheduler: {
          ...currentState.scheduler,
          ...persisted.scheduler,
          selectedQueueIds: Array.isArray(persisted.scheduler?.selectedQueueIds)
            && persisted.scheduler.selectedQueueIds.length > 0
            ? persisted.scheduler.selectedQueueIds
            : currentState.scheduler.selectedQueueIds
        },
        siteLogins: Array.isArray(persisted.siteLogins)
          ? sanitizeSiteLogins(persisted.siteLogins)
          : currentState.siteLogins
        });
      }
    }
  )
);

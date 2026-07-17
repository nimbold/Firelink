import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import { invokeCommand as invoke } from '../ipc';
import { info } from '../utils/logger';
import type { ActiveView } from '../bindings/ActiveView';
import type { AppFontSize } from '../bindings/AppFontSize';
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
import {
  DEFAULT_CATEGORY_SUBFOLDERS,
  normalizeDownloadLocationSettings
} from '../utils/downloadLocations';
import { normalizeSpeedLimitForBackend } from '../utils/downloads';

let settingsQueue: Promise<void> = Promise.resolve();
let pairingTokenHydrationRequest: Promise<PairingTokenHydration> | null = null;
const settingsPersistenceErrorListeners = new Set<() => void>();
let settingsPersistenceFailed = false;
const DEFAULT_SCHEDULER_QUEUE_ID = '00000000-0000-0000-0000-000000000001';
export const DEFAULT_SPEED_LIMIT_PRESET_VALUES = [1, 5, 10];

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
const APP_FONT_SIZE_VALUES = ['small', 'standard', 'large'] as const;
const LIST_ROW_DENSITY_VALUES = ['compact', 'standard', 'relaxed'] as const;
const PROXY_MODE_VALUES = ['none', 'system', 'custom'] as const;
const MEDIA_COOKIE_SOURCE_VALUES = [
  'none', 'safari', 'chrome', 'chromium', 'firefox', 'edge', 'brave', 'opera', 'vivaldi', 'whale'
] as const;
const SETTINGS_TAB_VALUES = [
  'downloads', 'lookandfeel', 'network', 'locations', 'sitelogins', 'power', 'engine', 'integrations', 'about'
] as const;

type PersistedSettingsSnapshot = PersistedSettings & {
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
  ListRowDensity,
  MediaCookieSource,
  PostQueueAction,
  ProxyMode,
  SchedulerSettings,
  SettingsTab,
  SiteLogin,
  Theme
};

export interface SettingsState {
  theme: Theme;
  baseDownloadFolder: string;
  categorySubfoldersEnabled: boolean;
  categorySubfolders: Record<string, string>;
  categoryDirectoryOverrides: Record<string, string>;
  approvedDownloadRoots: string[];
  maxConcurrentDownloads: number;
  globalSpeedLimit: string;
  speedLimitPresetValues: number[];
  logsEnabled: boolean;
  isSidebarVisible: boolean;
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
  showNotifications: boolean;
  playCompletionSound: boolean;
  autoAddClipboardLinks: boolean;
  appFontSize: AppFontSize;
  listRowDensity: ListRowDensity;
  showDockBadge: boolean;
  showMenuBarIcon: boolean;
  proxyMode: ProxyMode;
  proxyHost: string;
  proxyPort: number;
  customUserAgent: string;
  askWhereToSaveEachFile: boolean;
  preventsSleepWhileDownloading: boolean;
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
  setBaseDownloadFolder: (path: string) => void;
  approveDownloadRoot: (path: string) => Promise<string>;
  setMaxConcurrentDownloads: (count: number) => void;
  setGlobalSpeedLimit: (limit: string) => Promise<void>;
  setSpeedLimitPresetValues: (values: number[]) => void;
  setLogsEnabled: (enabled: boolean) => void;
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
  setCustomUserAgent: (userAgent: string) => void;
  setAskWhereToSaveEachFile: (ask: boolean) => void;
  setPreventsSleepWhileDownloading: (prevent: boolean) => void;
  setMediaCookieSource: (source: MediaCookieSource) => void;
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
      baseDownloadFolder: '~/Downloads',
      categorySubfoldersEnabled: true,
      categorySubfolders: { ...DEFAULT_CATEGORY_SUBFOLDERS },
      categoryDirectoryOverrides: {},
      approvedDownloadRoots: [],
      maxConcurrentDownloads: 3,
      globalSpeedLimit: '',
      speedLimitPresetValues: DEFAULT_SPEED_LIMIT_PRESET_VALUES,
      logsEnabled: false,
      activeView: 'downloads',
      activeSettingsTab: 'downloads',
      isSidebarVisible: true,
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
      showNotifications: true,
      playCompletionSound: false,
      autoAddClipboardLinks: false,
      appFontSize: 'standard',
      listRowDensity: 'standard',
      showDockBadge: true,
      showMenuBarIcon: true,
      proxyMode: 'none',
      proxyHost: '',
      proxyPort: 8080,
      customUserAgent: '',
      askWhereToSaveEachFile: false,
      preventsSleepWhileDownloading: true,
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
        await invoke('set_global_speed_limit', {
          limit: normalizeSpeedLimitForBackend(limit)
        });
        info('Settings updated: globalSpeedLimit');
        set({ globalSpeedLimit: limit });
      },
      setSpeedLimitPresetValues: (speedLimitPresetValues) => set({ speedLimitPresetValues }),
      setLogsEnabled: (logsEnabled) => set({ logsEnabled }),
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
      setShowNotifications: (showNotifications) => set({ showNotifications }),
      setPlayCompletionSound: (playCompletionSound) => set({ playCompletionSound }),
      setAutoAddClipboardLinks: (autoAddClipboardLinks) => set({ autoAddClipboardLinks }),
      setAppFontSize: (appFontSize) => set({ appFontSize }),
      setListRowDensity: (listRowDensity) => set({ listRowDensity }),
      setShowDockBadge: (showDockBadge) => {
        set({ showDockBadge });
        if (!showDockBadge) invoke('update_dock_badge', { count: 0 }).catch(console.error);
      },
      setShowMenuBarIcon: (showMenuBarIcon) => set({ showMenuBarIcon }),
      setProxyMode: (proxyMode) => set({ proxyMode }),
      setProxyHost: (proxyHost) => set({ proxyHost }),
      setProxyPort: (proxyPort) => set({
        proxyPort: Number.isFinite(proxyPort)
          ? Math.min(65535, Math.max(1, Math.trunc(proxyPort)))
          : 8080
      }),
      setCustomUserAgent: (customUserAgent) => set({ customUserAgent }),
      setAskWhereToSaveEachFile: (askWhereToSaveEachFile) => set({ askWhereToSaveEachFile }),
      setPreventsSleepWhileDownloading: (preventsSleepWhileDownloading) => {
        info('Settings updated: preventsSleepWhileDownloading');
        set({ preventsSleepWhileDownloading });
      },
      setMediaCookieSource: (mediaCookieSource) => { info('Settings updated: mediaCookieSource'); set({ mediaCookieSource }); },
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
          throw new Error('Grant credential-store access before regenerating the pairing token.');
        }
        const result = await invoke('regenerate_pairing_token');
        if (!result.persistent) {
          throw new Error(result.error || 'Credential store access is unavailable.');
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
      version: 3,
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
      partialize: (state): PersistedSettingsSnapshot => ({
        theme: state.theme,
        baseDownloadFolder: state.baseDownloadFolder,
        categorySubfoldersEnabled: state.categorySubfoldersEnabled,
        categorySubfolders: state.categorySubfolders,
        categoryDirectoryOverrides: state.categoryDirectoryOverrides,
        approvedDownloadRoots: state.approvedDownloadRoots,
        maxConcurrentDownloads: state.maxConcurrentDownloads,
        globalSpeedLimit: state.globalSpeedLimit,
        speedLimitPresetValues: state.speedLimitPresetValues,
        logsEnabled: state.logsEnabled,
        isSidebarVisible: state.isSidebarVisible,
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
        customUserAgent: state.customUserAgent,
        askWhereToSaveEachFile: state.askWhereToSaveEachFile,
        preventsSleepWhileDownloading: state.preventsSleepWhileDownloading,
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
        const locations = normalizeDownloadLocationSettings(persisted);
        return ({
          ...currentState,
          ...persisted,
          ...locations,
          extensionPairingToken: currentState.extensionPairingToken,
          keychainAccessReady: currentState.keychainAccessReady,
          theme: isAllowedSetting(THEME_VALUES, persisted.theme)
            ? persisted.theme
            : currentState.theme,
          appFontSize: isAllowedSetting(APP_FONT_SIZE_VALUES, persisted.appFontSize)
            ? persisted.appFontSize
            : currentState.appFontSize,
          listRowDensity: isAllowedSetting(LIST_ROW_DENSITY_VALUES, persisted.listRowDensity)
            ? persisted.listRowDensity
            : currentState.listRowDensity,
          proxyMode: isAllowedSetting(PROXY_MODE_VALUES, persisted.proxyMode)
            ? persisted.proxyMode
            : currentState.proxyMode,
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
          speedLimitPresetValues: Array.isArray(persisted.speedLimitPresetValues)
            ? persisted.speedLimitPresetValues
            : currentState.speedLimitPresetValues,
          lastCustomSpeedLimitUnit: persisted.lastCustomSpeedLimitUnit === 'KB/s'
            || persisted.lastCustomSpeedLimitUnit === 'MB/s'
            ? persisted.lastCustomSpeedLimitUnit
            : currentState.lastCustomSpeedLimitUnit,
          logsEnabled: persisted.logsEnabled === true,
          approvedDownloadRoots: Array.isArray(persisted.approvedDownloadRoots)
            ? persisted.approvedDownloadRoots
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

import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';

const tauriStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (name === 'firelink-settings') {
      try {
        const data = await invoke<string | null>('db_load_settings');
        return data;
      } catch (e) {
        console.error("Failed to load settings from DB", e);
        return null;
      }
    }
    return null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    if (name === 'firelink-settings') {
      try {
        await invoke('db_save_settings', { data: value });
      } catch (e) {
        console.error("Failed to save settings to DB", e);
      }
    }
  },
  removeItem: async (name: string): Promise<void> => {
    // no-op for now
  },
};

export interface SiteLogin {
  id: string;
  urlPattern: string;
  username: string;
}

export type AppFontSize = 'small' | 'standard' | 'large';
export type ListRowDensity = 'compact' | 'standard' | 'relaxed';
export type SettingsTab = 'downloads' | 'lookandfeel' | 'network' | 'locations' | 'sitelogins' | 'power' | 'engine' | 'integrations' | 'about';
export type ActiveView = 'downloads' | 'settings' | 'scheduler' | 'speedLimiter';
export type PostQueueAction = 'none' | 'sleep' | 'restart' | 'shutdown';

export interface SchedulerSettings {
  enabled: boolean;
  startTime: string;
  stopTimeEnabled: boolean;
  stopTime: string;
  everyday: boolean;
  selectedDays: number[];
  postQueueAction: PostQueueAction;
}

export interface SettingsState {
  theme: 'dark' | 'light' | 'system' | 'dracula' | 'nord';
  defaultDownloadPath: string;
  maxConcurrentDownloads: number;
  globalSpeedLimit: string;
  isSidebarVisible: boolean;
  activeView: ActiveView;
  activeSettingsTab: SettingsTab;
  scheduler: SchedulerSettings;
  schedulerRunning: boolean;
  schedulerLastStartKey: string;
  schedulerLastStopKey: string;
  lastCustomSpeedLimitKiB: number;

  // Replicated SwiftUI App Settings
  perServerConnections: number;
  maxAutomaticRetries: number;
  showNotifications: boolean;
  playCompletionSound: boolean;
  appFontSize: AppFontSize;
  listRowDensity: ListRowDensity;
  showDockBadge: boolean;
  showMenuBarIcon: boolean;
  proxyMode: 'none' | 'system' | 'custom';
  proxyHost: string;
  proxyPort: number;
  customUserAgent: string;
  askWhereToSaveEachFile: boolean;
  preventsSleepWhileDownloading: boolean;
  mediaCookieSource: 'none' | 'safari' | 'chrome' | 'firefox' | 'edge' | 'brave';
  downloadDirectories: Record<string, string>;
  siteLogins: SiteLogin[];
  extensionPairingToken: string;
  autoCheckUpdates: boolean;

  setTheme: (theme: 'dark' | 'light' | 'system' | 'dracula' | 'nord') => void;
  setDefaultDownloadPath: (path: string) => void;
  setMaxConcurrentDownloads: (count: number) => void;
  setGlobalSpeedLimit: (limit: string) => void;
  setActiveView: (view: ActiveView) => void;
  setActiveSettingsTab: (tab: SettingsTab) => void;
  setScheduler: (settings: SchedulerSettings) => void;
  setSchedulerRunning: (running: boolean) => void;
  setSchedulerLastStartKey: (key: string) => void;
  setSchedulerLastStopKey: (key: string) => void;
  setLastCustomSpeedLimitKiB: (limit: number) => void;
  toggleSidebar: () => void;

  setPerServerConnections: (count: number) => void;
  setMaxAutomaticRetries: (count: number) => void;
  setShowNotifications: (show: boolean) => void;
  setPlayCompletionSound: (play: boolean) => void;
  setAppFontSize: (size: AppFontSize) => void;
  setListRowDensity: (density: ListRowDensity) => void;
  setShowDockBadge: (show: boolean) => void;
  setShowMenuBarIcon: (show: boolean) => void;
  setProxyMode: (mode: 'none' | 'system' | 'custom') => void;
  setProxyHost: (host: string) => void;
  setProxyPort: (port: number) => void;
  setCustomUserAgent: (userAgent: string) => void;
  setAskWhereToSaveEachFile: (ask: boolean) => void;
  setPreventsSleepWhileDownloading: (prevent: boolean) => void;
  setMediaCookieSource: (source: 'none' | 'safari' | 'chrome' | 'firefox' | 'edge' | 'brave') => void;
  setCategoryDirectory: (category: string, path: string) => void;
  resetCategoryDirectories: () => void;
  addSiteLogin: (login: SiteLogin) => void;
  removeSiteLogin: (id: string) => void;
  regeneratePairingToken: () => void;
  setAutoCheckUpdates: (autoCheckUpdates: boolean) => void;
}

const defaultDirectories = {
  Musics: '~/Downloads/Musics',
  Movies: '~/Downloads/Movies',
  Compressed: '~/Downloads/Compressed',
  Documents: '~/Downloads/Documents',
  Pictures: '~/Downloads/Pictures',
  Applications: '~/Downloads/Applications',
  Other: '~/Downloads/Other'
};

const normalizeDownloadDirectories = (directories: unknown): Record<string, string> => {
  if (!directories || typeof directories !== 'object') {
    return { ...defaultDirectories };
  }

  const values = directories as Record<string, unknown>;
  const directory = (current: string, legacy?: string) => {
    const value = values[current] ?? (legacy ? values[legacy] : undefined);
    return typeof value === 'string' && value.length > 0
      ? value
      : defaultDirectories[current as keyof typeof defaultDirectories];
  };

  return {
    Musics: directory('Musics', 'Audio'),
    Movies: directory('Movies', 'Video'),
    Compressed: directory('Compressed', 'Archives'),
    Documents: directory('Documents'),
    Pictures: directory('Pictures', 'Images'),
    Applications: directory('Applications', 'Apps'),
    Other: directory('Other')
  };
};

const generateSecureToken = () => {
  try {
    const cryptoObj = typeof window !== 'undefined' ? (window.crypto || (window as any).msCrypto) : null;
    if (cryptoObj && cryptoObj.getRandomValues) {
      const arr = new Uint8Array(24);
      cryptoObj.getRandomValues(arr);
      let binary = '';
      for (let i = 0; i < arr.byteLength; i++) {
        binary += String.fromCharCode(arr[i]);
      }
      return btoa(binary);
    }
  } catch (e) {
    console.warn("Secure token generation failed, falling back to random characters", e);
  }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      defaultDownloadPath: '~/Downloads',
      maxConcurrentDownloads: 3,
      globalSpeedLimit: '',
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
        postQueueAction: 'none'
      },
      schedulerRunning: false,
      schedulerLastStartKey: '',
      schedulerLastStopKey: '',
      lastCustomSpeedLimitKiB: 1024,

      // Replicated SwiftUI defaults
      perServerConnections: 16,
      maxAutomaticRetries: 3,
      showNotifications: true,
      playCompletionSound: true,
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
      downloadDirectories: { ...defaultDirectories },
      siteLogins: [],
      extensionPairingToken: generateSecureToken(),
      autoCheckUpdates: true,

      setTheme: (theme) => set({ theme }),
      setDefaultDownloadPath: (path) => set({ defaultDownloadPath: path }),
      setMaxConcurrentDownloads: (max) => {
        set({ maxConcurrentDownloads: max });
        invoke('set_concurrent_limit', { limit: max }).catch(console.error);
      },
      setGlobalSpeedLimit: (limit) => set({ globalSpeedLimit: limit }),
      setActiveView: (view) => set({ activeView: view }),
      setActiveSettingsTab: (activeSettingsTab) => set({ activeSettingsTab }),
      setScheduler: (scheduler) => set({ scheduler }),
      setSchedulerRunning: (schedulerRunning) => set({ schedulerRunning }),
      setSchedulerLastStartKey: (schedulerLastStartKey) => set({ schedulerLastStartKey }),
      setSchedulerLastStopKey: (schedulerLastStopKey) => set({ schedulerLastStopKey }),
      setLastCustomSpeedLimitKiB: (lastCustomSpeedLimitKiB) => set({ lastCustomSpeedLimitKiB }),
      toggleSidebar: () => set((state) => ({ isSidebarVisible: !state.isSidebarVisible })),

      setPerServerConnections: (perServerConnections) => set({ perServerConnections }),
      setMaxAutomaticRetries: (maxAutomaticRetries) => set({ maxAutomaticRetries }),
      setShowNotifications: (showNotifications) => set({ showNotifications }),
      setPlayCompletionSound: (playCompletionSound) => set({ playCompletionSound }),
      setAppFontSize: (appFontSize) => set({ appFontSize }),
      setListRowDensity: (listRowDensity) => set({ listRowDensity }),
      setShowDockBadge: (showDockBadge) => set({ showDockBadge }),
      setShowMenuBarIcon: (showMenuBarIcon) => set({ showMenuBarIcon }),
      setProxyMode: (proxyMode) => set({ proxyMode }),
      setProxyHost: (proxyHost) => set({ proxyHost }),
      setProxyPort: (proxyPort) => set({ proxyPort }),
      setCustomUserAgent: (customUserAgent) => set({ customUserAgent }),
      setAskWhereToSaveEachFile: (askWhereToSaveEachFile) => set({ askWhereToSaveEachFile }),
      setPreventsSleepWhileDownloading: (preventsSleepWhileDownloading) => set({ preventsSleepWhileDownloading }),
      setMediaCookieSource: (mediaCookieSource) => set({ mediaCookieSource }),
      setCategoryDirectory: (category, path) => set((state) => ({
        downloadDirectories: { ...state.downloadDirectories, [category]: path }
      })),
      resetCategoryDirectories: () => set({ downloadDirectories: { ...defaultDirectories } }),
      addSiteLogin: (login) => set((state) => ({
        siteLogins: [...state.siteLogins, login]
      })),
      removeSiteLogin: (id) => set((state) => ({
        siteLogins: state.siteLogins.filter((login) => login.id !== id)
      })),
      regeneratePairingToken: () => set({ extensionPairingToken: generateSecureToken() }),
      setAutoCheckUpdates: (autoCheckUpdates) => set({ autoCheckUpdates }),
    }),
    {
      name: 'firelink-settings',
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        theme: state.theme,
        defaultDownloadPath: state.defaultDownloadPath,
        maxConcurrentDownloads: state.maxConcurrentDownloads,
        globalSpeedLimit: state.globalSpeedLimit,
        isSidebarVisible: state.isSidebarVisible,
        activeSettingsTab: state.activeSettingsTab,
        scheduler: state.scheduler,
        schedulerLastStartKey: state.schedulerLastStartKey,
        schedulerLastStopKey: state.schedulerLastStopKey,
        lastCustomSpeedLimitKiB: state.lastCustomSpeedLimitKiB,
        
        perServerConnections: state.perServerConnections,
        maxAutomaticRetries: state.maxAutomaticRetries,
        showNotifications: state.showNotifications,
        playCompletionSound: state.playCompletionSound,
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
        downloadDirectories: state.downloadDirectories,
        siteLogins: state.siteLogins,
        extensionPairingToken: state.extensionPairingToken,
        autoCheckUpdates: state.autoCheckUpdates
      }),
      merge: (persistedState: any, currentState) => ({
        ...currentState,
        ...persistedState,
        appFontSize: persistedState?.appFontSize === 'extra-large' ? 'large' : (persistedState?.appFontSize || currentState.appFontSize),
        listRowDensity: persistedState?.listRowDensity === 'spacious' ? 'relaxed' : (persistedState?.listRowDensity || currentState.listRowDensity),
        downloadDirectories: normalizeDownloadDirectories(persistedState?.downloadDirectories),
        siteLogins: (persistedState && typeof persistedState === 'object' && Array.isArray(persistedState.siteLogins))
          ? persistedState.siteLogins
          : currentState.siteLogins
      })
    }
  )
);

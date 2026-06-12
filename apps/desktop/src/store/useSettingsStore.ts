import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface SiteLogin {
  id: string;
  urlPattern: string;
  username: string;
  password?: string;
}

export interface SettingsState {
  theme: 'dark' | 'light' | 'system' | 'dracula' | 'nord';
  defaultDownloadPath: string;
  maxConcurrentDownloads: number;
  globalSpeedLimit: string;
  isSidebarVisible: boolean;
  activeView: 'downloads' | 'settings';

  // Replicated SwiftUI App Settings
  perServerConnections: number;
  maxAutomaticRetries: number;
  showNotifications: boolean;
  playCompletionSound: boolean;
  appFontSize: 'standard' | 'large' | 'extra-large';
  listRowDensity: 'compact' | 'standard' | 'spacious';
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

  setTheme: (theme: 'dark' | 'light' | 'system' | 'dracula' | 'nord') => void;
  setDefaultDownloadPath: (path: string) => void;
  setMaxConcurrentDownloads: (count: number) => void;
  setGlobalSpeedLimit: (limit: string) => void;
  setActiveView: (view: 'downloads' | 'settings') => void;
  toggleSidebar: () => void;

  setPerServerConnections: (count: number) => void;
  setMaxAutomaticRetries: (count: number) => void;
  setShowNotifications: (show: boolean) => void;
  setPlayCompletionSound: (play: boolean) => void;
  setAppFontSize: (size: 'standard' | 'large' | 'extra-large') => void;
  setListRowDensity: (density: 'compact' | 'standard' | 'spacious') => void;
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
}

const defaultDirectories = {
  Video: '~/Downloads/Video',
  Audio: '~/Downloads/Audio',
  Documents: '~/Downloads/Documents',
  Apps: '~/Downloads/Apps',
  Images: '~/Downloads/Images',
  Archives: '~/Downloads/Compressed',
  Other: '~/Downloads/Other'
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
      isSidebarVisible: true,

      // Replicated SwiftUI defaults
      perServerConnections: 16,
      maxAutomaticRetries: 3,
      showNotifications: true,
      playCompletionSound: true,
      appFontSize: 'standard',
      listRowDensity: 'standard',
      proxyMode: 'none',
      proxyHost: '',
      proxyPort: 8080,
      customUserAgent: '',
      askWhereToSaveEachFile: false,
      preventsSleepWhileDownloading: true,
      mediaCookieSource: 'none',
      downloadDirectories: {
        'Video': '~/Downloads/Video',
        'Audio': '~/Downloads/Audio',
        'Documents': '~/Downloads/Documents',
        'Apps': '~/Downloads/Apps',
        'Images': '~/Downloads/Images',
        'Archives': '~/Downloads/Compressed',
        'Other': '~/Downloads/Other'
      },
      siteLogins: [],
      extensionPairingToken: generateSecureToken(),

      setTheme: (theme) => set({ theme }),
      setDefaultDownloadPath: (path) => set({ defaultDownloadPath: path }),
      setMaxConcurrentDownloads: (max) => set({ maxConcurrentDownloads: max }),
      setGlobalSpeedLimit: (limit) => set({ globalSpeedLimit: limit }),
      setActiveView: (view) => set({ activeView: view }),
      toggleSidebar: () => set((state) => ({ isSidebarVisible: !state.isSidebarVisible })),

      setPerServerConnections: (perServerConnections) => set({ perServerConnections }),
      setMaxAutomaticRetries: (maxAutomaticRetries) => set({ maxAutomaticRetries }),
      setShowNotifications: (showNotifications) => set({ showNotifications }),
      setPlayCompletionSound: (playCompletionSound) => set({ playCompletionSound }),
      setAppFontSize: (appFontSize) => set({ appFontSize }),
      setListRowDensity: (listRowDensity) => set({ listRowDensity }),
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
    }),
    {
      name: 'firelink-settings',
      partialize: (state) => ({
        theme: state.theme,
        defaultDownloadPath: state.defaultDownloadPath,
        maxConcurrentDownloads: state.maxConcurrentDownloads,
        globalSpeedLimit: state.globalSpeedLimit,
        isSidebarVisible: state.isSidebarVisible,
        
        perServerConnections: state.perServerConnections,
        maxAutomaticRetries: state.maxAutomaticRetries,
        showNotifications: state.showNotifications,
        playCompletionSound: state.playCompletionSound,
        appFontSize: state.appFontSize,
        listRowDensity: state.listRowDensity,
        proxyMode: state.proxyMode,
        proxyHost: state.proxyHost,
        proxyPort: state.proxyPort,
        customUserAgent: state.customUserAgent,
        askWhereToSaveEachFile: state.askWhereToSaveEachFile,
        preventsSleepWhileDownloading: state.preventsSleepWhileDownloading,
        mediaCookieSource: state.mediaCookieSource,
        downloadDirectories: state.downloadDirectories,
        siteLogins: state.siteLogins,
        extensionPairingToken: state.extensionPairingToken
      }),
      merge: (persistedState: any, currentState) => ({
        ...currentState,
        ...persistedState,
        downloadDirectories: (persistedState && typeof persistedState === 'object' && persistedState.downloadDirectories)
          ? persistedState.downloadDirectories
          : currentState.downloadDirectories,
        siteLogins: (persistedState && typeof persistedState === 'object' && Array.isArray(persistedState.siteLogins))
          ? persistedState.siteLogins
          : currentState.siteLogins
      })
    }
  )
);

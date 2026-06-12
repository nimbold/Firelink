import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from './useSettingsStore';

const getProxyArgs = (settings: ReturnType<typeof useSettingsStore.getState>) => {
  if (settings.proxyMode === 'custom' && settings.proxyHost) {
    return `http://${settings.proxyHost}:${settings.proxyPort}`;
  }
  return null;
};

const getSiteLogin = (url: string, settings: ReturnType<typeof useSettingsStore.getState>) => {
  try {
    const urlObj = new URL(url);
    const host = urlObj.hostname.toLowerCase();
    for (const login of settings.siteLogins) {
      let pattern = login.urlPattern.toLowerCase().trim();
      if (pattern.startsWith('*.')) {
        const suffix = pattern.substring(2);
        if (host === suffix || host.endsWith('.' + suffix)) return login;
      } else if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        if (regex.test(host)) return login;
      } else if (host === pattern) {
        return login;
      }
    }
  } catch (e) {}
  return null;
};

const syncSystemIntegrations = () => {
  const settings = useSettingsStore.getState();
  const activeCount = useDownloadStore.getState().downloads.filter(d => d.status === 'downloading').length;
  invoke('update_dock_badge', { count: activeCount }).catch(() => {});
  if (settings.preventsSleepWhileDownloading) {
    invoke('set_prevent_sleep', { prevent: activeCount > 0 }).catch(() => {});
  } else {
    invoke('set_prevent_sleep', { prevent: false }).catch(() => {});
  }
};

export type DownloadStatus = 'downloading' | 'paused' | 'completed' | 'failed' | 'queued';
export type DownloadCategory = 'Documents' | 'Images' | 'Audio' | 'Video' | 'Apps' | 'Archives' | 'Other';

export interface DownloadItem {
  id: string;
  url: string;
  fileName: string;
  status: DownloadStatus;
  fraction?: number;
  speed?: string;
  eta?: string;
  category: DownloadCategory;
  dateAdded: string;
  // Advanced Settings
  connections?: number | null;
  speedLimit?: string | null;
  username?: string | null;
  password?: string | null;
  headers?: string | null;
  destination?: string;
  isMedia?: boolean;
  mediaFormatSelector?: string;
}

interface DownloadState {
  downloads: DownloadItem[];
  isAddModalOpen: boolean;
  selectedPropertiesDownloadId: string | null;
  toggleAddModal: (isOpen: boolean) => void;
  setSelectedPropertiesDownloadId: (id: string | null) => void;
  addDownload: (item: DownloadItem) => void;
  updateDownload: (id: string, updates: Partial<DownloadItem>) => void;
  removeDownload: (id: string) => Promise<void>;
  clearFinished: () => void;
  redownload: (id: string) => void;
  processQueue: () => void;
}

export const useDownloadStore = create<DownloadState>((set, get) => ({
  downloads: [],
  isAddModalOpen: false,
  selectedPropertiesDownloadId: null,
  toggleAddModal: (isOpen) => set({ isAddModalOpen: isOpen }),
  setSelectedPropertiesDownloadId: (id) => set({ selectedPropertiesDownloadId: id }),
  addDownload: (item) => {
    set((state) => ({ downloads: [...state.downloads, item] }));
    get().processQueue();
  },
  updateDownload: (id, updates) => {
    set((state) => ({
      downloads: state.downloads.map(d => {
        if (d.id === id) {
          let newFraction = updates.fraction;
          if (newFraction === 0 && d.fraction && d.fraction > 0) {
            newFraction = d.fraction;
          }
          return { 
            ...d, 
            ...updates,
            fraction: newFraction !== undefined ? newFraction : updates.fraction !== undefined ? updates.fraction : d.fraction
          };
        }
        return d;
      })
    }));
    
    // If status changed to something that frees up a slot, process queue
    if (updates.status && ['completed', 'failed', 'paused'].includes(updates.status)) {
      get().processQueue();
      syncSystemIntegrations();
    } else if (updates.status === 'downloading') {
      syncSystemIntegrations();
    }
  },
  removeDownload: async (id) => {
    const item = get().downloads.find(d => d.id === id);
    if (item && item.status === 'downloading') {
      try {
        await invoke('pause_download', { id });
      } catch (e) {
        console.error("Failed to terminate download on deletion:", e);
      }
    }
    set((state) => ({
      downloads: state.downloads.filter(d => d.id !== id)
    }));
    get().processQueue();
    syncSystemIntegrations();
  },
  clearFinished: () => {
    set((state) => ({
      downloads: state.downloads.filter(d => !['completed', 'failed'].includes(d.status))
    }));
  },
  redownload: (id) => {
    set((state) => ({
      downloads: state.downloads.map(d => 
        d.id === id 
          ? { ...d, status: 'queued', fraction: 0, speed: '-', eta: '-' } 
          : d
      )
    }));
    get().processQueue();
  },
  processQueue: async () => {
    const { downloads, updateDownload } = get();
    const { maxConcurrentDownloads, globalSpeedLimit, defaultDownloadPath } = useSettingsStore.getState();
    
    const activeCount = downloads.filter(d => d.status === 'downloading').length;
    if (activeCount >= maxConcurrentDownloads) return;

    const queuedItems = downloads.filter(d => d.status === 'queued');
    const slotsAvailable = maxConcurrentDownloads - activeCount;
    
    const itemsToStart = queuedItems.slice(0, slotsAvailable);
    
    for (const item of itemsToStart) {
      updateDownload(item.id, { status: 'downloading' });
      try {
        const settings = useSettingsStore.getState();
        const login = getSiteLogin(item.url, settings);
        
        const destPath = item.destination || 
                         (settings.downloadDirectories && settings.downloadDirectories[item.category]) || 
                         settings.defaultDownloadPath || 
                         '~/Downloads';

        if (item.isMedia) {
          await invoke('start_media_download', {
            id: item.id,
            url: item.url,
            destination: destPath,
            filename: item.fileName,
            formatSelector: item.mediaFormatSelector || null
          });
        } else {
          await invoke('start_download', {
            id: item.id,
            url: item.url,
            destination: destPath,
            filename: item.fileName,
            connections: item.connections || settings.perServerConnections || null,
            speedLimit: item.speedLimit || settings.globalSpeedLimit || null,
            username: item.username || (login ? login.username : null),
            password: item.password || (login ? login.password : null),
            headers: item.headers || null,
            userAgent: settings.customUserAgent || null,
            maxTries: settings.maxAutomaticRetries,
            proxy: getProxyArgs(settings)
          });
        }
      } catch (e) {
        console.error("Failed to start queued download:", e);
        updateDownload(item.id, { status: 'failed' });
      }
    }
  }
}));

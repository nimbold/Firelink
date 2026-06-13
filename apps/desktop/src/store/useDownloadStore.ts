import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from './useSettingsStore';
import {
  categoryForFileName,
  fileNameFromUrl,
  isMediaUrl,
  type DownloadCategory
} from '../utils/downloads';

export type { DownloadCategory } from '../utils/downloads';

const getProxyArgs = (settings: ReturnType<typeof useSettingsStore.getState>) => {
  if (settings.proxyMode === 'custom' && settings.proxyHost) {
    return `http://${settings.proxyHost}:${settings.proxyPort}`;
  }
  return null;
};

export const getSiteLogin = (url: string, settings: ReturnType<typeof useSettingsStore.getState>) => {
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
  invoke('update_dock_badge', { count: settings.showDockBadge ? activeCount : 0 }).catch(() => {});
  if (settings.preventsSleepWhileDownloading) {
    invoke('set_prevent_sleep', { prevent: activeCount > 0 }).catch(() => {});
  } else {
    invoke('set_prevent_sleep', { prevent: false }).catch(() => {});
  }
};

// Legacy manual speed limit math removed

export type DownloadStatus = 'downloading' | 'paused' | 'completed' | 'failed' | 'queued';
export const MAIN_QUEUE_ID = '00000000-0000-0000-0000-000000000001';

export interface Queue {
  id: string;
  name: string;
  isMain: boolean;
}

export interface DownloadItem {
  id: string;
  url: string;
  fileName: string;
  status: DownloadStatus;
  fraction?: number;
  speed?: string;
  eta?: string;
  size?: string;
  category: DownloadCategory;
  dateAdded: string;
  // Advanced Settings
  connections?: number | null;
  speedLimit?: string | null;
  username?: string | null;
  password?: string | null;
  headers?: string | null;
  checksum?: string | null;
  cookies?: string | null;
  mirrors?: string | null;
  destination?: string;
  isMedia?: boolean;
  mediaFormatSelector?: string;
  queueId: string;
  _dispatched?: boolean;
}

export interface ExtensionDownloadRequest {
  urls: string[];
  referer?: string | null;
  silent?: boolean;
  filename?: string | null;
}

interface DownloadState {
  downloads: DownloadItem[];
  queues: Queue[];
  isAddModalOpen: boolean;
  pendingAddUrls: string;
  pendingAddReferer: string;
  pendingAddFilename: string;
  selectedPropertiesDownloadId: string | null;
  toggleAddModal: (isOpen: boolean) => void;
  openAddModalWithUrls: (urls: string, referer?: string | null, filename?: string | null) => void;
  handleExtensionDownload: (request: ExtensionDownloadRequest) => void;
  setSelectedPropertiesDownloadId: (id: string | null) => void;
  addDownload: (item: DownloadItem) => void;
  updateDownload: (id: string, updates: Partial<DownloadItem>) => void;
  removeDownload: (id: string) => Promise<void>;
  clearFinished: () => void;
  redownload: (id: string) => void;
  processQueue: () => Promise<void>;
  startQueue: (queueId: string) => Promise<number>;
  pauseQueue: (queueId: string) => Promise<number>;
  addQueue: (name: string) => void;
  renameQueue: (id: string, name: string) => void;
  removeQueue: (id: string) => void;
  initDB: () => Promise<void>;
}

export const useDownloadStore = create<DownloadState>((set, get) => ({
  downloads: [],
  queues: [{ id: MAIN_QUEUE_ID, name: 'Main Queue', isMain: true }],
  isAddModalOpen: false,
  pendingAddUrls: '',
  pendingAddReferer: '',
  pendingAddFilename: '',
  selectedPropertiesDownloadId: null,
  toggleAddModal: (isOpen) => set({
    isAddModalOpen: isOpen,
    pendingAddUrls: '',
    pendingAddReferer: '',
    pendingAddFilename: ''
  }),
  openAddModalWithUrls: (urls, referer, filename) => set({
    isAddModalOpen: true,
    pendingAddUrls: urls,
    pendingAddReferer: referer?.trim() || '',
    pendingAddFilename: filename?.trim() || ''
  }),
  handleExtensionDownload: (request) => {
    const urls = [...new Set(request.urls.map(url => url.trim()).filter(Boolean))];
    if (urls.length === 0) return;

    const settings = useSettingsStore.getState();
    if (!request.silent || settings.askWhereToSaveEachFile) {
      get().openAddModalWithUrls(
        urls.join('\n'),
        request.referer,
        urls.length === 1 ? request.filename : null
      );
      return;
    }

    const referer = request.referer?.trim();
    const headers = referer ? `Referer: ${referer}` : undefined;
    const dateAdded = new Date().toISOString();
    const downloads = urls.map((url, index): DownloadItem => {
      const fileName = index === 0 && urls.length === 1 && request.filename?.trim()
        ? request.filename.trim()
        : fileNameFromUrl(url);
      return {
        id: crypto.randomUUID(),
        url,
        fileName,
        status: 'queued',
        category: categoryForFileName(fileName),
        dateAdded,
        connections: settings.perServerConnections,
        headers,
        isMedia: isMediaUrl(url),
        queueId: MAIN_QUEUE_ID
      };
    });

    set(state => ({ downloads: [...state.downloads, ...downloads] }));
    downloads.forEach(item => {
      const toSave = { ...item };
      delete toSave.fraction; delete toSave.speed; delete toSave.eta;
      invoke('db_save_download', { id: item.id, status: item.status, queueId: item.queueId, data: JSON.stringify(toSave) }).catch(console.error);
    });
    void get().processQueue();
  },
  setSelectedPropertiesDownloadId: (id) => set({ selectedPropertiesDownloadId: id }),
  addDownload: (item) => {
    set((state) => ({ downloads: [...state.downloads, item] }));
    const toSave = { ...item };
    delete toSave.fraction; delete toSave.speed; delete toSave.eta;
    invoke('db_save_download', { id: item.id, status: item.status, queueId: item.queueId, data: JSON.stringify(toSave) }).catch(console.error);
    get().processQueue();
  },
  updateDownload: (id, updates) => {
    let updatedItem: DownloadItem | null = null;
    set((state) => ({
      downloads: state.downloads.map(d => {
        if (d.id === id) {
          let newFraction = updates.fraction;
          if (newFraction === 0 && d.fraction && d.fraction > 0) {
            newFraction = d.fraction;
          }
          const updated = { 
            ...d, 
            ...updates,
            fraction: newFraction !== undefined ? newFraction : updates.fraction !== undefined ? updates.fraction : d.fraction
          };
          updatedItem = updated;
          return updated;
        }
        return d;
      })
    }));
    
    if (updatedItem && Object.keys(updates).some(k => !['fraction', 'speed', 'eta'].includes(k))) {
      const toSave = { ...(updatedItem as DownloadItem) };
      delete toSave.fraction; delete toSave.speed; delete toSave.eta;
      invoke('db_save_download', { id: toSave.id, status: toSave.status, queueId: toSave.queueId, data: JSON.stringify(toSave) }).catch(console.error);
    }
    
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
    invoke('db_delete_download', { id }).catch(console.error);
    get().processQueue();
    syncSystemIntegrations();
  },
  clearFinished: () => {
    const downloads = get().downloads;
    const toRemove = downloads.filter(d => ['completed', 'failed'].includes(d.status));
    set((state) => ({
      downloads: state.downloads.filter(d => !['completed', 'failed'].includes(d.status))
    }));
    toRemove.forEach(d => {
      invoke('db_delete_download', { id: d.id }).catch(console.error);
    });
  },
  redownload: (id) => {
    let updatedItem: DownloadItem | null = null;
    set((state) => ({
      downloads: state.downloads.map(d => {
        if (d.id === id) {
          const updated: DownloadItem = { ...d, status: 'queued', _dispatched: false, fraction: 0, speed: '-', eta: '-' };
          updatedItem = updated;
          return updated;
        }
        return d;
      })
    }));
    if (updatedItem) {
      const toSave = { ...(updatedItem as DownloadItem) };
      delete toSave.fraction; delete toSave.speed; delete toSave.eta;
      invoke('db_save_download', { id: toSave.id, status: toSave.status, queueId: toSave.queueId, data: JSON.stringify(toSave) }).catch(console.error);
    }
    get().processQueue();
  },
  startQueue: async (queueId) => {
    const runnableIds = get().downloads
      .filter(item => item.queueId === queueId && (item.status === 'queued' || item.status === 'paused' || item.status === 'failed'))
      .map(item => item.id);

    if (runnableIds.length === 0) return 0;

    set((state) => ({
      downloads: state.downloads.map(item =>
        runnableIds.includes(item.id)
          ? { ...item, status: 'queued', _dispatched: false, speed: '-', eta: '-' }
          : item
      )
    }));
    await get().processQueue();
    return runnableIds.length;
  },
  pauseQueue: async (queueId) => {
    const activeIds = get().downloads
      .filter(item => item.queueId === queueId && item.status === 'downloading')
      .map(item => item.id);

    if (activeIds.length === 0) return 0;

    set((state) => ({
      downloads: state.downloads.map(item =>
        activeIds.includes(item.id)
          ? { ...item, status: 'paused', speed: '-', eta: '-' }
          : item
      )
    }));
    await Promise.all(activeIds.map(id => invoke('pause_download', { id }).catch(() => {})));
    syncSystemIntegrations();
    return activeIds.length;
  },
  addQueue: (name) => {
    const id = crypto.randomUUID();
    const q = { id, name, isMain: false };
    set((state) => ({
      queues: [...state.queues, q]
    }));
    invoke('db_save_queue', { id, data: JSON.stringify(q) }).catch(console.error);
  },
  renameQueue: (id, name) => {
    let updatedQ: Queue | null = null;
    set((state) => ({
      queues: state.queues.map(q => {
        if (q.id === id) {
          const newQ = { ...q, name };
          updatedQ = newQ;
          return newQ;
        }
        return q;
      })
    }));
    if (updatedQ) {
      invoke('db_save_queue', { id, data: JSON.stringify(updatedQ) }).catch(console.error);
    }
  },
  removeQueue: (id) => {
    if (id === MAIN_QUEUE_ID) return;
    set((state) => ({
      queues: state.queues.filter(q => q.id !== id),
      downloads: state.downloads.map(d => 
        d.queueId === id ? { ...d, queueId: MAIN_QUEUE_ID } : d
      )
    }));
    invoke('db_delete_queue', { id }).catch(console.error);
    
    // Also we need to save the updated downloads to DB
    const downloads = get().downloads.filter(d => d.queueId === id);
    downloads.forEach(d => {
      const toSave = { ...d, queueId: MAIN_QUEUE_ID };
      delete toSave.fraction; delete toSave.speed; delete toSave.eta;
      invoke('db_save_download', { id: toSave.id, status: toSave.status, queueId: MAIN_QUEUE_ID, data: JSON.stringify(toSave) }).catch(console.error);
    });
  },
  initDB: async () => {
    try {
      const queuesStr = await invoke<string[]>('db_get_all_queues');
      const queues = queuesStr.map(q => JSON.parse(q));
      
      const downloadsStr = await invoke<string[]>('db_get_all_downloads');
      const downloads = downloadsStr.map(d => JSON.parse(d));
      
      set(state => ({
        queues: queues.length > 0 ? queues : state.queues,
        downloads: downloads.length > 0 ? downloads : state.downloads
      }));
      
      // Auto resume downloads that were active
      const active = get().downloads.filter(d => d.status === 'downloading');
      active.forEach(item => {
        if (item.isMedia) {
          invoke('start_media_download', {
            id: item.id, url: item.url, destination: item.destination,
            filename: item.fileName, format_selector: item.mediaFormatSelector,
            proxy: null
          }).catch(console.error);
        } else {
          invoke('start_download', {
            id: item.id, url: item.url, destination: item.destination, filename: item.fileName,
            connections: item.connections, speed_limit: item.speedLimit, username: item.username,
            password: item.password, headers: item.headers, checksum: item.checksum, cookies: item.cookies,
            mirrors: item.mirrors, user_agent: null, max_tries: null, proxy: null
          }).catch(console.error);
        }
      });
      
      void get().processQueue();
    } catch (e) {
      console.error("Failed to init DB", e);
    }
  },
  processQueue: async () => {
    const { downloads, updateDownload } = get();
    
    // Find all queued items that haven't been dispatched to the backend yet
    const itemsToStart = downloads.filter(d => d.status === 'queued' && !d._dispatched);
    
    for (const item of itemsToStart) {
      // Mark as dispatched so we don't send it again on the next pass
      updateDownload(item.id, { _dispatched: true });
      try {
        const settings = useSettingsStore.getState();
        const login = getSiteLogin(item.url, settings);
        let keychainPassword = null;
        if (login) {
          try {
            keychainPassword = await invoke<string>('get_keychain_password', { id: login.id });
          } catch (e) {
            console.warn("Could not fetch keychain password for login:", e);
          }
        }
        
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
            formatSelector: item.mediaFormatSelector || null,
            cookieSource: settings.mediaCookieSource !== 'none' ? settings.mediaCookieSource : null,
            speedLimit: item.speedLimit || null,
            username: item.username || (login ? login.username : null),
            password: item.password || keychainPassword,
            headers: item.headers || null,
            proxy: getProxyArgs(settings),
            userAgent: settings.customUserAgent || null,
            maxTries: settings.maxAutomaticRetries
          });
        } else {
          await invoke('start_download', {
            id: item.id,
            url: item.url,
            destination: destPath,
            filename: item.fileName,
            connections: item.connections || settings.perServerConnections || null,
            speedLimit: item.speedLimit || null,
            username: item.username || (login ? login.username : null),
            password: item.password || keychainPassword,
            headers: item.headers || null,
            checksum: item.checksum || null,
            cookies: item.cookies || null,
            mirrors: item.mirrors || null,
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

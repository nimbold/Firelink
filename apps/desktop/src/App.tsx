import { useEffect, useRef, useState } from "react";
import { Sidebar, SidebarFilter } from "./components/Sidebar";
import { DownloadTable } from "./components/DownloadTable";
import { AddDownloadsModal } from "./components/AddDownloadsModal";
import SettingsView from "./components/SettingsView";
import { PropertiesModal } from "./components/PropertiesModal";
import { listen } from "@tauri-apps/api/event";
import { useDownloadStore, MAIN_QUEUE_ID } from './store/useDownloadStore';
import { useSettingsStore } from "./store/useSettingsStore";
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { invoke } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import SchedulerView from "./components/SchedulerView";
import SpeedLimiterView from "./components/SpeedLimiterView";

const localDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const handleDeepLinks = (deepLinks: string[]) => {
  for (const rawDeepLink of deepLinks) {
    try {
      const deepLink = new URL(rawDeepLink);
      if (deepLink.protocol !== 'firelink:' || deepLink.hostname !== 'add') continue;
      const urls = deepLink.searchParams.get('url') || '';
      if (urls.length > 0 && urls.length < 65_536) {
        useDownloadStore.getState().openAddModalWithUrls(urls);
        return;
      }
    } catch (error) {
      console.warn('Ignored invalid Firelink deep link:', error);
    }
  }
};

function App() {
  const [filter, setFilter] = useState<SidebarFilter>('all');
  const updateDownload = useDownloadStore(state => state.updateDownload);
  const theme = useSettingsStore(state => state.theme);
  const isSidebarVisible = useSettingsStore(state => state.isSidebarVisible);
  const activeView = useSettingsStore(state => state.activeView);
  const appFontSize = useSettingsStore(state => state.appFontSize);
  const showDockBadge = useSettingsStore(state => state.showDockBadge);
  const showMenuBarIcon = useSettingsStore(state => state.showMenuBarIcon);
  const extensionPairingToken = useSettingsStore(state => state.extensionPairingToken);
  const downloads = useDownloadStore(state => state.downloads);
  const activeDownloadCount = downloads.filter(download => download.status === 'downloading').length;
  const queuedCount = downloads.filter(download => download.status === 'queued').length;
  const doneCount = downloads.filter(download => download.status === 'completed').length;
  const schedulerRunning = useSettingsStore(state => state.schedulerRunning);
  const globalSpeedLimit = useSettingsStore(state => state.globalSpeedLimit);
  const previousSpeedLimit = useRef(globalSpeedLimit);
  const maxConcurrentDownloads = useSettingsStore(state => state.maxConcurrentDownloads);

  useEffect(() => {
    window.document.documentElement.setAttribute('data-font-size', appFontSize);
  }, [appFontSize]);

  useEffect(() => {
    invoke('set_concurrent_limit', { limit: maxConcurrentDownloads }).catch(console.error);
  }, [maxConcurrentDownloads]);

  useEffect(() => {
    invoke('update_dock_badge', { count: showDockBadge ? activeDownloadCount : 0 }).catch(() => {});
  }, [showDockBadge, activeDownloadCount]);

  useEffect(() => {
    invoke('toggle_tray_icon', { show: showMenuBarIcon }).catch(console.error);
  }, [showMenuBarIcon]);

  useEffect(() => {
    invoke('set_extension_pairing_token', { token: extensionPairingToken }).catch(error => {
      console.error('Failed to configure browser extension pairing token:', error);
    });
  }, [extensionPairingToken]);

  useEffect(() => {
    const unlisten = onOpenUrl(handleDeepLinks);
    getCurrent()
      .then(urls => {
        if (urls) handleDeepLinks(urls);
      })
      .catch(error => console.error('Failed to read startup deep link:', error));

    return () => {
      unlisten.then(dispose => dispose());
    };
  }, []);

  useEffect(() => {
    if (previousSpeedLimit.current === globalSpeedLimit) return;
    previousSpeedLimit.current = globalSpeedLimit;
    const timeout = window.setTimeout(() => {
      useDownloadStore.getState().restartActiveDownloads().catch(error => {
        console.error('Failed to apply global speed limit:', error);
      });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [globalSpeedLimit]);

  useEffect(() => {
    const checkSchedule = async () => {
      const state = useSettingsStore.getState();
      const scheduler = state.scheduler;
      if (!scheduler.enabled) return;

      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const allowedToday = scheduler.everyday || scheduler.selectedDays.includes(now.getDay());
      if (!allowedToday) return;

      const dateKey = localDateKey(now);
      if (scheduler.startTime === currentTime) {
        const triggerKey = `${dateKey}-${currentTime}`;
        if (state.schedulerLastStartKey !== triggerKey) {
          state.setSchedulerLastStartKey(triggerKey);
          const started = await useDownloadStore.getState().startQueue(MAIN_QUEUE_ID);
          state.setSchedulerRunning(started > 0);
        }
      }

      if (scheduler.stopTimeEnabled && scheduler.stopTime === currentTime) {
        const triggerKey = `${dateKey}-${currentTime}`;
        if (state.schedulerLastStopKey !== triggerKey) {
          state.setSchedulerLastStopKey(triggerKey);
          await useDownloadStore.getState().pauseQueue(MAIN_QUEUE_ID);
          state.setSchedulerRunning(false);
        }
      }
    };

    void checkSchedule();
    const interval = window.setInterval(() => void checkSchedule(), 10_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!schedulerRunning) return;
    const hasPendingScheduledWork = downloads.some(download =>
      download.status === 'queued' || download.status === 'downloading'
    );
    if (hasPendingScheduledWork) return;

    const settings = useSettingsStore.getState();
    settings.setSchedulerRunning(false);
    if (settings.scheduler.postQueueAction !== 'none') {
      invoke('perform_system_action', { action: settings.scheduler.postQueueAction }).catch(error => {
        console.error('Scheduled post action failed:', error);
      });
    }
  }, [downloads, schedulerRunning]);

  useEffect(() => {
    // Request notification permissions
    const initNotifications = async () => {
      let permissionGranted = await isPermissionGranted();
      if (!permissionGranted) {
        await requestPermission();
      }
    };
    initNotifications();
  }, []);

  useEffect(() => {
    const root = window.document.documentElement;
    
    const applyTheme = () => {
      // Remove all theme classes first
      root.classList.remove('theme-dark', 'theme-light', 'theme-dracula', 'theme-nord', 'dark');
      
      if (theme === 'system') {
        const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        root.classList.add(systemDark ? 'theme-dark' : 'theme-light');
      } else {
        root.classList.add(`theme-${theme}`);
      }
    };

    applyTheme();

    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => applyTheme();
      mediaQuery.addEventListener('change', listener);
      return () => mediaQuery.removeEventListener('change', listener);
    }
  }, [theme]);

  useEffect(() => {
    const unlistenProgress = listen('download-progress', (event: any) => {
      const { id, fraction, speed, eta } = event.payload;
      updateDownload(id, { fraction, speed, eta });
    });

    const unlistenComplete = listen('download-complete', (event: any) => {
      updateDownload(event.payload, { status: 'completed', fraction: 1.0, speed: '-', eta: '-' });
      
      const settings = useSettingsStore.getState();
      if (settings.showNotifications) {
        const item = useDownloadStore.getState().downloads.find(d => d.id === event.payload);
        const fileName = item?.fileName || 'A file';
        
        sendNotification({
          title: 'Download Complete',
          body: `${fileName} has finished downloading.`,
          sound: settings.playCompletionSound ? 'default' : undefined
        });
      }
    });

    const unlistenFailed = listen('download-failed', (event: any) => {
      // If it's already paused, don't mark as failed (since we aborted it)
      const current = useDownloadStore.getState().downloads.find(d => d.id === event.payload);
      if (current && current.status !== 'paused') {
        updateDownload(event.payload, { status: 'failed', speed: '-', eta: '-' });
      }
    });

    const unlistenExtension = listen('extension-add-download', (event: any) => {
      useDownloadStore.getState().handleExtensionDownload(event.payload);
    });
    unlistenExtension
      .then(() => invoke('set_extension_frontend_ready', { ready: true }))
      .catch(error => console.error('Failed to activate browser extension integration:', error));

    return () => {
      invoke('set_extension_frontend_ready', { ready: false }).catch(() => {});
      unlistenProgress.then(f => f());
      unlistenComplete.then(f => f());
      unlistenFailed.then(f => f());
      unlistenExtension.then(f => f());
    };
  }, []);

  return (
    <div className="app-shell flex h-screen w-screen text-text-primary overflow-hidden">
      
      {/* Left Side Panel - Curved Second Layer on Top */}
      <div
        className={`app-sidebar flex flex-col overflow-hidden relative z-20 shrink-0 transition-all duration-300 ease-in-out ${
          isSidebarVisible ? 'w-[244px] opacity-100' : 'w-0 opacity-0'
        }`}
      >
        <div className="w-[244px] h-full flex flex-col shrink-0">
          <Sidebar selectedFilter={filter} onSelectFilter={(f) => { setFilter(f); useSettingsStore.getState().setActiveView('downloads'); }} />
        </div>
      </div>
      
      {/* Main Content - Base Layer */}
      <div className="app-workspace flex-1 flex flex-col h-full relative z-0">
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {activeView === 'downloads' && <DownloadTable filter={filter} />}
          {activeView === 'settings' && <SettingsView />}
          {activeView === 'scheduler' && <SchedulerView />}
          {activeView === 'speedLimiter' && <SpeedLimiterView />}
        </div>
        
        {/* Status Bar */}
        <div className="app-statusbar h-8 px-5 flex items-center justify-between text-[10px] text-text-muted font-medium shrink-0 border-t border-border-color">
          <span className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
            Ready
          </span>
          <div className="flex gap-3 tabular-nums">
            <span className="flex items-center gap-1.5">
              <span className="text-text-primary">{activeDownloadCount}</span> active
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-text-primary">{queuedCount}</span> queued
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-text-primary">{doneCount}</span> done
            </span>
          </div>
        </div>
      </div>
      
      <AddDownloadsModal />
      <PropertiesModal />
    </div>
  );
}

export default App;

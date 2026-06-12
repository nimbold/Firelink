import { useEffect, useState } from "react";
import { Sidebar, SidebarFilter } from "./components/Sidebar";
import { DownloadTable } from "./components/DownloadTable";
import { AddDownloadsModal } from "./components/AddDownloadsModal";
import { SettingsModal } from "./components/SettingsModal";
import { PropertiesModal } from "./components/PropertiesModal";
import { listen } from "@tauri-apps/api/event";
import { useDownloadStore } from "./store/useDownloadStore";
import { useSettingsStore } from "./store/useSettingsStore";
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

function App() {
  const [filter, setFilter] = useState<SidebarFilter>('all');
  const updateDownload = useDownloadStore(state => state.updateDownload);
  const theme = useSettingsStore(state => state.theme);
  const isSidebarVisible = useSettingsStore(state => state.isSidebarVisible);
  const appFontSize = useSettingsStore(state => state.appFontSize);

  useEffect(() => {
    window.document.documentElement.setAttribute('data-font-size', appFontSize);
  }, [appFontSize]);

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

    return () => {
      unlistenProgress.then(f => f());
      unlistenComplete.then(f => f());
      unlistenFailed.then(f => f());
    };
  }, []);

  return (
    <div className="flex h-screen w-screen bg-main-bg text-text-primary overflow-hidden">
      {isSidebarVisible && <Sidebar selectedFilter={filter} onSelectFilter={setFilter} />}
      <DownloadTable filter={filter} />
      <AddDownloadsModal />
      <SettingsModal />
      <PropertiesModal />
    </div>
  );
}

export default App;

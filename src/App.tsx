import { initMediaDomains, isActiveDownloadStatus, isTransferActiveStatus } from './utils/downloads';
import { schedulerCompletionState } from './utils/schedulerCompletion';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Sidebar, SidebarFilter } from "./components/Sidebar";
import { DownloadTable, type DownloadTableStatusSummary } from "./components/DownloadTable";
// Keep the primary Add action eager so the modal cannot disappear behind a
// null Suspense fallback while its development chunk is being transformed.
import { AddDownloadsModal } from './components/AddDownloadsModal';
import { KeychainPermissionModal } from './components/KeychainPermissionModal';
import { extractValidDownloadUrls } from './utils/url';
import { readClipboardDownloadUrls } from './utils/clipboard';
import { listenEvent as listen, invokeCommand as invoke } from "./ipc";
import { useDownloadStore, MAIN_QUEUE_ID, type ExtensionDownloadRequest } from './store/useDownloadStore';
import { initDownloadListener } from './store/downloadStore';
import { subscribeToSettingsPersistenceErrors, useSettingsStore } from "./store/useSettingsStore";
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { WindowControls } from "./components/WindowControls";
import { useToast } from "./contexts/ToastContext";
import { setLogStreamActive } from './utils/logger';
import { updateDockBadge } from './utils/dockBadge';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getPlatformInfo, shouldUseCustomWindowControls, usePlatformInfo } from './utils/platform';
import { resolveWindowControlStyle } from './utils/windowControlStyle';
import {
  getKeychainAccessReady,
  getKeychainConsentVersion,
  getKeychainStartupDecision
} from './utils/keychainStartup';
import { getVersion } from '@tauri-apps/api/app';
import type { PostQueueAction } from './bindings/PostQueueAction';
import { PanelLeft } from 'lucide-react';
import { isTrustedFirelinkReleaseUrl } from './utils/releaseUrls';
import { changeAppLocale, localeDirection, resolveAppLocale, syncDocumentLocale } from './i18n';
import { useTranslation } from 'react-i18next';
import { formatDownloadBytes } from './utils/downloadProgress';

const loadSettingsView = () => import('./components/SettingsView');
const loadSchedulerView = () => import('./components/SchedulerView');
const loadSpeedLimiterView = () => import('./components/SpeedLimiterView');
const loadLogsView = () => import('./components/LogsView');
const pageChunkLoaders = [
  loadSettingsView,
  loadSchedulerView,
  loadSpeedLimiterView,
  loadLogsView,
] as const;

const SettingsView = lazy(loadSettingsView);
const SchedulerView = lazy(loadSchedulerView);
const SpeedLimiterView = lazy(loadSpeedLimiterView);
const LogsView = lazy(loadLogsView);
const PropertiesModal = lazy(() => import('./components/PropertiesModal').then(module => ({
  default: module.PropertiesModal,
})));
const DeleteConfirmationModal = lazy(() => import('./components/DeleteConfirmationModal').then(module => ({
  default: module.DeleteConfirmationModal,
})));
const preloadPageChunks = async () => {
  for (const load of pageChunkLoaders) {
    try {
      await load();
    } catch (error) {
      console.warn('Failed to preload page chunk:', error);
    }
  }
};

const scheduleAfterFirstPaint = (task: () => void): (() => void) => {
  const idleWindow = window as typeof window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (idleWindow.requestIdleCallback) {
    const handle = idleWindow.requestIdleCallback(task, { timeout: 1000 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }

  let timeoutHandle: number | null = null;
  const frameHandle = window.requestAnimationFrame(() => {
    timeoutHandle = window.setTimeout(task, 0);
  });
  return () => {
    window.cancelAnimationFrame(frameHandle);
    if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
  };
};

const PageLoadingFallback = () => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-1 items-center justify-center bg-main-bg" role="status" aria-live="polite">
      <span className="sr-only">{t($ => $.app.loading)}</span>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-item-hover" aria-hidden="true">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
      </div>
    </div>
  );
};

let automaticUpdateCheckStarted = false;
const processingScheduleKeys = new Set<string>();
let powerPreferencesSync: Promise<void> = Promise.resolve();

const waitForSettingsHydration = (): Promise<void> => {
  if (useSettingsStore.persist.hasHydrated()) return Promise.resolve();
  return new Promise(resolve => {
    const unsubscribe = useSettingsStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
};

let downloadStateInitialization: Promise<void> | null = null;
const initializeDownloadState = (): Promise<void> => {
  if (!downloadStateInitialization) {
    downloadStateInitialization = (async () => {
      await waitForSettingsHydration();
      await useDownloadStore.getState().initDB();
    })().catch(error => {
      downloadStateInitialization = null;
      throw error;
    });
  }
  return downloadStateInitialization;
};

const getScheduledQueueIds = () => {
  const downloadState = useDownloadStore.getState();
  const availableQueueIds = new Set(downloadState.queues.map(queue => queue.id));
  const selectedQueueIds = useSettingsStore.getState().scheduler.selectedQueueIds
    .filter(queueId => availableQueueIds.has(queueId));
  return selectedQueueIds;
};

type AudioContextConstructor = typeof AudioContext;

const playCompletionChime = async () => {
  const AudioCtor =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  if (!AudioCtor) return;

  const context = new AudioCtor();
  if (context.state === 'suspended') {
    await context.resume();
  }

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(880, context.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(1320, context.currentTime + 0.12);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.24);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.24);
  oscillator.onended = () => {
    void context.close();
  };
};

function App() {
  const { i18n, t } = useTranslation();
  const platform = usePlatformInfo();
  const [filter, setFilter] = useState<SidebarFilter>('all');
  const [downloadTableSummary, setDownloadTableSummary] = useState<DownloadTableStatusSummary | null>(null);
  const [coreReady, setCoreReady] = useState(false);
  const [keychainConsentVersion, setKeychainConsentVersion] = useState('');

  useEffect(() => {
    const handleLanguageChanged = (language?: string) => {
      syncDocumentLocale(language ?? i18n.language);
    };

    handleLanguageChanged();
    i18n.on('languageChanged', handleLanguageChanged);
    return () => i18n.off('languageChanged', handleLanguageChanged);
  }, [i18n]);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem('firelink-sidebar-width'));
    return Number.isFinite(stored) && stored >= 190 && stored <= 260 ? stored : 220;
  });

  const theme = useSettingsStore(state => state.theme);
  const windowControlStylePreference = useSettingsStore(state => state.windowControlStyle);
  const languagePreference = useSettingsStore(state => state.language);
  const isSidebarVisible = useSettingsStore(state => state.isSidebarVisible);
  const sidebarPosition = useSettingsStore(state => state.sidebarPosition);
  const toggleSidebar = useSettingsStore(state => state.toggleSidebar);
  const activeView = useSettingsStore(state => state.activeView);
  const fontFamily = useSettingsStore(state => state.fontFamily);
  const appFontSize = useSettingsStore(state => state.appFontSize);
  const listRowDensity = useSettingsStore(state => state.listRowDensity);

  useEffect(() => {
    const locale = languagePreference === 'system'
      ? resolveAppLocale(typeof navigator === 'undefined' ? undefined : navigator.language)
      : languagePreference;
    if (i18n.language !== locale) {
      void changeAppLocale(locale);
    }
  }, [i18n, languagePreference]);
  const autoCheckUpdates = useSettingsStore(state => state.autoCheckUpdates);
  const autoAddClipboardLinks = useSettingsStore(state => state.autoAddClipboardLinks);
  const showNotifications = useSettingsStore(state => state.showNotifications);
  const showDockBadge = useSettingsStore(state => state.showDockBadge);
  const dockBadgeSyncVersion = useSettingsStore(state => state.dockBadgeSyncVersion);
  const showMenuBarIcon = useSettingsStore(state => state.showMenuBarIcon);
  const extensionPairingToken = useSettingsStore(state => state.extensionPairingToken);
  const showKeychainModal = useSettingsStore(state => state.showKeychainModal);
  const isAddModalOpen = useDownloadStore(state => state.isAddModalOpen);
  const selectedPropertiesDownloadId = useDownloadStore(state => state.selectedPropertiesDownloadId);
  const isDeleteModalOpen = useDownloadStore(state => state.deleteModalState.isOpen);
  const downloads = useDownloadStore(state => state.downloads);
  const activeDownloadCount = downloads.filter(download => isTransferActiveStatus(download.status)).length;
  const queuedCount = downloads.filter(download =>
    download.status === 'queued' || download.status === 'staged'
  ).length;
  const doneCount = downloads.filter(download => download.status === 'completed').length;
  const handleDownloadTableSummaryChange = useCallback((summary: DownloadTableStatusSummary | null) => {
    setDownloadTableSummary(summary);
  }, []);
  const formatStatusSummaryBytes = (value: number | null, isEstimated = false): string => {
    if (value === null) return t($ => $.downloadTable.summary.unknown);
    const formatted = formatDownloadBytes(value);
    return isEstimated
      ? t($ => $.downloadTable.summary.estimated, { value: formatted })
      : formatted;
  };
  const schedulerRunning = useSettingsStore(state => state.schedulerRunning);
  const schedulerActiveDownloadIds = useSettingsStore(state => state.schedulerActiveDownloadIds);
  const pendingPostActionTimer = useRef<number | null>(null);
  const startupResumeStarted = useRef(false);
  const startupInputReady = useRef(false);
  const frontendReadyUpdate = useRef<Promise<void>>(Promise.resolve());
  const pendingStartupInputs = useRef<Array<
    | { type: 'extension'; payload: ExtensionDownloadRequest }
    | { type: 'deep-link'; payload: string }
  >>([]);
  const maxConcurrentDownloads = useSettingsStore(state => state.maxConcurrentDownloads);
  const preventsSleepWhileDownloading = useSettingsStore(state => state.preventsSleepWhileDownloading);
  const preventsDisplaySleepWhileDownloading = useSettingsStore(
    state => state.preventsDisplaySleepWhileDownloading
  );
  const activeTransferCount = downloads.filter(download => isTransferActiveStatus(download.status)).length;
  const { addToast, removeToast } = useToast();
  const isMacUserAgent = navigator.userAgent.includes('Mac');
  const usesCustomWindowControls = shouldUseCustomWindowControls(platform.os, navigator.userAgent);
  const windowControlStyle = resolveWindowControlStyle(windowControlStylePreference, platform.os, navigator.userAgent);
  const isRtl = localeDirection(resolveAppLocale(i18n.language)) === 'rtl';
  const isSidebarOnRight = sidebarPosition === 'right' || (sidebarPosition === 'auto' && isRtl);
  // Keep dialogs out of the titlebar area while platform detection is still
  // resolving. The conservative fallback prevents a startup handoff from
  // briefly rendering underneath native or custom window controls.
  const hasWindowChrome = isMacUserAgent || ['macos', 'windows', 'linux', 'unknown'].includes(platform.os);

  useEffect(() => scheduleAfterFirstPaint(preloadPageChunks), []);

  useEffect(() => subscribeToSettingsPersistenceErrors(() => {
    addToast({
      message: t($ => $.app.settingsSaveFailed),
      variant: 'error',
      isActionable: true
    });
  }), [addToast]);

  const acknowledgePairingTokenChange = () => {
    invoke('acknowledge_pairing_token_change').catch(error => {
      console.error('Failed to acknowledge pairing token migration notice:', error);
    });
  };

  const clearPendingPostActionTimer = useCallback(() => {
    if (pendingPostActionTimer.current !== null) {
      window.clearTimeout(pendingPostActionTimer.current);
      pendingPostActionTimer.current = null;
    }
  }, []);

  const queueFrontendReadyUpdate = useCallback((ready: boolean) => {
    const update = frontendReadyUpdate.current
      .catch(() => undefined)
      .then(() => invoke('set_extension_frontend_ready', { ready }));
    frontendReadyUpdate.current = update;
    return update;
  }, []);

  const schedulePostQueueAction = useCallback((action: Exclude<PostQueueAction, 'none'>) => {
    clearPendingPostActionTimer();

    const actionLabel = t($ => $.scheduler.postActions[action]);
    let timerId: number | null = null;
    let toastId: string | null = null;
    const cancel = () => {
      clearPendingPostActionTimer();
      timerId = null;
      if (toastId !== null) {
        removeToast(toastId);
        toastId = null;
      }
    };

    toastId = addToast({
      variant: 'warning',
      isActionable: true,
      onDismiss: clearPendingPostActionTimer,
      message: (
        <div className="flex items-center gap-3">
          <span>{t($ => $.app.systemActionCountdown, { action: actionLabel })}</span>
          <button
            type="button"
            className="app-button px-2 py-1"
            onClick={cancel}
          >
            {t($ => $.actions.cancel)}
          </button>
        </div>
      )
    });

    timerId = window.setTimeout(() => {
      if (toastId !== null) {
        removeToast(toastId);
        toastId = null;
      }
      if (pendingPostActionTimer.current === timerId) {
        pendingPostActionTimer.current = null;
      }
      timerId = null;

      const activeTransfers = useDownloadStore.getState().downloads.some(download =>
        isActiveDownloadStatus(download.status)
      );
      if (activeTransfers) {
        addToast({
          message: t($ => $.app.systemActionCancelled),
          variant: 'warning',
          isActionable: true
        });
        return;
      }
      invoke('perform_system_action', { action }).catch(error => {
        console.error('Scheduled post action failed:', error);
        addToast({
          message: t($ => $.app.systemActionFailed, { detail: String(error) }),
          variant: 'error',
          isActionable: true
        });
      });
    }, 10_000);
    pendingPostActionTimer.current = timerId;
  }, [addToast, clearPendingPostActionTimer, removeToast]);

  const startSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = isSidebarOnRight
        ? startX - moveEvent.clientX
        : moveEvent.clientX - startX;
      const nextWidth = Math.min(260, Math.max(190, startWidth + delta));
      setSidebarWidth(nextWidth);
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      document.body.classList.remove('is-resizing');
    };

    document.body.classList.add('is-resizing');
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  useEffect(() => {
    return clearPendingPostActionTimer;
  }, [clearPendingPostActionTimer]);

  useEffect(() => {
    if (activeTransferCount > 0) {
      clearPendingPostActionTimer();
    }
  }, [activeTransferCount, clearPendingPostActionTimer]);

  useEffect(() => {
    initMediaDomains();
    window.localStorage.setItem('firelink-sidebar-width', String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    let active = true;
    let cleanupListeners: (() => void) | null = null;
    const initialize = async () => {
      let unlistenDownload: (() => void) | null = null;
      let unlistenTerminalState: (() => void) | null = null;
      let unlistenExtension: (() => void) | null = null;
      let unlistenDeepLink: (() => void) | null = null;
      const disposeListeners = () => {
        void queueFrontendReadyUpdate(false).catch(() => {});
        unlistenTerminalState?.();
        unlistenTerminalState = null;
        unlistenExtension?.();
        unlistenExtension = null;
        unlistenDeepLink?.();
        unlistenDeepLink = null;
        unlistenDownload?.();
        unlistenDownload = null;
      };

      // Establish the consent barrier before registering listeners or loading
      // persisted downloads. Those later startup steps can cause user-facing
      // work to begin; the explanation must already be committed before any
      // path is allowed to reach the credential store.
      await waitForSettingsHydration();
      if (!active) return;
      const [currentAppVersion, currentPlatform] = await Promise.all([
        getVersion().catch(() => ''),
        getPlatformInfo().catch(() => null)
      ]);
      if (!active) return;
      const currentKeychainConsentVersion = getKeychainConsentVersion(currentAppVersion);
      setKeychainConsentVersion(currentKeychainConsentVersion);

      try {
        const settings = useSettingsStore.getState();
        const isStartupActive = () => active;
        const { deferKeychainHydration, showKeychainPrompt } = getKeychainStartupDecision({
          portable: currentPlatform?.portable === true,
          appVersion: currentKeychainConsentVersion,
          approvedVersion: settings.keychainAccessVersion,
          accessGranted: settings.keychainAccessGranted,
          promptDismissed: settings.keychainPromptDismissed
        });
        let changed = false;
        if (deferKeychainHydration) {
          settings.setKeychainAccessReady(false);
          if (showKeychainPrompt) settings.setShowKeychainModal(true);
          await settings.hydrateSessionPairingToken(isStartupActive);
          if (!active) return;
        } else {
          await invoke('authorize_keychain_access');
          if (!active) return;
          changed = await settings.hydratePairingToken(isStartupActive);
          if (!active) return;
          const currentSettings = useSettingsStore.getState();
          settings.setKeychainAccessReady(getKeychainAccessReady({
            portable: currentPlatform?.portable === true,
            accessGranted: currentSettings.keychainAccessGranted,
            persistent: currentSettings.isPairingTokenPersistent
          }));
        }
        if (changed) {
          addToast({
            variant: 'warning',
            isActionable: true,
            message: (
              <div className="flex flex-col gap-2">
                <p>{t($ => $.app.extensionDisconnected)}</p>
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    className="app-button px-2 py-1 bg-surface-raised border border-border-color rounded"
                    onClick={async () => {
                      const token = useSettingsStore.getState().extensionPairingToken;
                      try {
                        if (token) await navigator.clipboard.writeText(token);
                        acknowledgePairingTokenChange();
                      } catch (error) {
                        addToast({
                          message: t($ => $.app.copyTokenFailed, { detail: String(error) }),
                          variant: 'error',
                          isActionable: true
                        });
                      }
                    }}
                  >
                    {t($ => $.app.copyToken)}
                  </button>
                  <button
                    type="button"
                    className="app-button px-2 py-1 bg-surface-raised border border-border-color rounded"
                    onClick={() => {
                      const settings = useSettingsStore.getState();
                      settings.setActiveSettingsTab('integrations');
                      settings.setActiveView('settings');
                      acknowledgePairingTokenChange();
                    }}
                  >
                    {t($ => $.app.integrations)}
                  </button>
                </div>
              </div>
            )
          });
        }
      } catch (error) {
        console.error('Failed to hydrate extension pairing token:', error);
        addToast({
          message: t($ => $.app.credentialPersistenceFailed, { detail: String(error) }),
          variant: 'error',
          isActionable: true
        });
      }

      try {
        unlistenDownload = await initDownloadListener();
        unlistenTerminalState = await listen('download-state', (event) => {
          if (event.payload.status !== 'completed' && event.payload.status !== 'failed') return;
          const settings = useSettingsStore.getState();
          if (event.payload.status === 'completed' && settings.playCompletionSound) {
            playCompletionChime().catch(error => {
              console.error('Completion sound failed:', error);
            });
          }
          if (!settings.showNotifications) return;

          const item = useDownloadStore.getState().downloads.find(d => d.id === event.payload.id);
          const fileName = item?.fileName || t($ => $.app.unknownFile);
          if (event.payload.status === 'completed') {
            try {
              sendNotification({
                title: t($ => $.app.downloadCompleteTitle),
                body: t($ => $.app.downloadCompleteBody, { fileName })
              });
            } catch (error) {
              console.error('Completion notification failed:', error);
            }
          } else {
            try {
              sendNotification({
                title: t($ => $.app.downloadFailedTitle),
                body: t($ => $.app.downloadFailedBody, { fileName }),
              });
            } catch (error) {
              console.error('Failure notification failed:', error);
            }
          }
        });
        unlistenExtension = await listen('extension-add-download', (event) => {
          if (event.payload.request_id) {
            void invoke('ack_extension_download', { requestId: event.payload.request_id }).catch(error => {
              console.error('Failed to acknowledge browser extension download:', error);
            });
          }
          if (!startupInputReady.current || useSettingsStore.getState().showKeychainModal) {
            pendingStartupInputs.current.push({ type: 'extension', payload: event.payload });
            return;
          }
          useDownloadStore.getState().handleExtensionDownload(event.payload).catch(error => {
            console.error('Failed to handle browser extension download:', error);
          });
        });
        unlistenDeepLink = await listen('deep-link-add-download', (event) => {
          if (!startupInputReady.current || useSettingsStore.getState().showKeychainModal) {
            pendingStartupInputs.current.push({ type: 'deep-link', payload: event.payload });
            return;
          }
          useDownloadStore.getState().openAddModalWithUrls(event.payload);
        });

        cleanupListeners = disposeListeners;
        if (!active) {
          disposeListeners();
          cleanupListeners = null;
          return;
        }
      } catch (error) {
        disposeListeners();
        cleanupListeners = null;
        if (!active) return;
        console.error('Failed to initialize Firelink listeners:', error);
        addToast({
          message: t($ => $.app.initializeDownloadsFailed, { detail: String(error) }),
          variant: 'error',
          isActionable: true
        });
        return;
      }

      try {
        await initializeDownloadState();
        if (!active) return;
      } catch (error) {
        disposeListeners();
        cleanupListeners = null;
        if (!active) return;
        console.error('Failed to initialize Firelink state:', error);
        addToast({
          message: t($ => $.app.initializeDownloadsFailed, { detail: String(error) }),
          variant: 'error',
          isActionable: true
        });
        return;
      }

      if (!active) return;
      setCoreReady(true);
    };
    void initialize();
    return () => {
      active = false;
      startupInputReady.current = false;
      pendingStartupInputs.current = [];
      cleanupListeners?.();
      cleanupListeners = null;
    };
  }, [addToast, queueFrontendReadyUpdate]);

  useEffect(() => {
    if (!coreReady) return;
    // The backend must not emit extension/deep-link handoffs while the
    // explanatory Keychain dialog is active. Deep links are buffered by the
    // coordinator, and extension callers receive a retryable 503 instead.
    void queueFrontendReadyUpdate(!showKeychainModal).catch(error => {
      console.error('Failed to update browser extension readiness:', error);
    });
  }, [coreReady, queueFrontendReadyUpdate, showKeychainModal]);

  useEffect(() => {
    if (!coreReady || showKeychainModal) {
      startupInputReady.current = false;
      return;
    }
    if (startupInputReady.current) return;
    startupInputReady.current = true;
    const pendingInputs = pendingStartupInputs.current.splice(0);
    for (const input of pendingInputs) {
      if (input.type === 'extension') {
        useDownloadStore.getState().handleExtensionDownload(input.payload).catch(error => {
          console.error('Failed to handle queued browser extension download:', error);
        });
      } else {
        useDownloadStore.getState().openAddModalWithUrls(input.payload);
      }
    }
  }, [coreReady, showKeychainModal]);

  useEffect(() => {
    if (!coreReady || showKeychainModal || startupResumeStarted.current) return;
    startupResumeStarted.current = true;
    useDownloadStore.getState().resumePendingDownloads().catch(error => {
      console.error('Failed to resume saved downloads after startup:', error);
      addToast({
        message: t($ => $.app.resumeDownloadsFailed, { detail: String(error) }),
        variant: 'error',
        isActionable: true
      });
    });
  }, [addToast, coreReady, showKeychainModal]);

  useEffect(() => {
    window.document.documentElement.setAttribute('data-font-family', fontFamily);
  }, [fontFamily]);

  useEffect(() => {
    window.document.documentElement.setAttribute('data-font-size', appFontSize);
  }, [appFontSize]);

  useEffect(() => {
    window.document.documentElement.setAttribute('data-list-density', listRowDensity);
  }, [listRowDensity]);

  useEffect(() => {
    const checkForUpdate = () => {
      if (!useSettingsStore.getState().autoCheckUpdates || automaticUpdateCheckStarted) return;
      automaticUpdateCheckStarted = true;

      invoke('check_for_updates')
        .then(result => {
          if (result.type !== 'UpdateAvailable') return;
          if (!isTrustedFirelinkReleaseUrl(result.update.release_url)) {
            throw new Error(t($ => $.settings.common.updateUntrustedReleaseUrl));
          }
          addToast({
            variant: 'info',
            isActionable: true,
            message: (
              <div className="flex items-center gap-3">
                <span>{t($ => $.app.updateAvailable, { version: result.update.version })}</span>
                <button
                  type="button"
                  className="app-button px-2 py-1"
                  onClick={() => {
                    void openUrl(result.update.release_url);
                  }}
                >
                  {t($ => $.app.viewRelease)}
                </button>
              </div>
            )
          });
        })
        .catch(error => {
          automaticUpdateCheckStarted = false;
          console.error('Automatic update check failed:', error);
        });
    };

    if (useSettingsStore.persist.hasHydrated()) {
      checkForUpdate();
      return;
    }
    return useSettingsStore.persist.onFinishHydration(checkForUpdate);
  }, [addToast, autoCheckUpdates]);

  useEffect(() => {
    invoke('set_concurrent_limit', { limit: maxConcurrentDownloads }).catch(console.error);
  }, [maxConcurrentDownloads]);

  useEffect(() => {
    if (platform.os === 'macos') {
      updateDockBadge(showDockBadge ? activeDownloadCount : 0).catch(() => {});
    }
  }, [platform.os, showDockBadge, dockBadgeSyncVersion, activeDownloadCount]);

  useEffect(() => {
    const sync = () => {
      powerPreferencesSync = powerPreferencesSync
        .catch(() => undefined)
        .then(() => invoke('set_power_preferences', {
          preventSystemSleep: preventsSleepWhileDownloading,
          preventDisplaySleep: preventsDisplaySleepWhileDownloading
        }))
        .catch(error => {
          console.error('Failed to update power prevention:', error);
          addToast({
            message: t($ => $.app.sleepPreventionFailed, { detail: String(error) }),
            variant: 'error',
            isActionable: true
          });
        });
    };

    if (useSettingsStore.persist.hasHydrated()) {
      sync();
      return;
    }
    return useSettingsStore.persist.onFinishHydration(sync);
  }, [
    addToast,
    preventsDisplaySleepWhileDownloading,
    preventsSleepWhileDownloading,
    t
  ]);

  useEffect(() => {
    invoke('toggle_tray_icon', { show: showMenuBarIcon }).catch(console.error);
  }, [showMenuBarIcon]);

  useEffect(() => {
    if (activeView !== 'logs') {
      setLogStreamActive(false).catch(console.error);
    }
  }, [activeView]);

  useEffect(() => {
    if (!extensionPairingToken) return;
    invoke('set_extension_pairing_token', { token: extensionPairingToken }).catch(error => {
      console.error('Failed to configure browser extension pairing token:', error);
    });
  }, [extensionPairingToken]);

  useEffect(() => {
    if (!coreReady) return;
    const unlisten = listen('schedule-trigger', async (event) => {
      const state = useSettingsStore.getState();
      const payload = event.payload;
      if (processingScheduleKeys.has(payload.key)) return;
      processingScheduleKeys.add(payload.key);
      try {
        if (payload.action === 'start') {
          clearPendingPostActionTimer();
          const scheduledQueueIds = getScheduledQueueIds();
          if (scheduledQueueIds.length === 0) {
            state.setSchedulerActiveDownloadIds([]);
            state.setSchedulerRunning(false);
            addToast({
              message: t($ => $.app.schedulerNoQueues),
              variant: 'warning',
              isActionable: true
            });
            await invoke('ack_schedule_trigger', { action: 'start', key: payload.key });
            return;
          }
          const previouslyTrackedIds = new Set(state.schedulerActiveDownloadIds);
          const startedResults = await Promise.all(
            scheduledQueueIds.map(queueId => useDownloadStore.getState().startQueue(queueId))
          );
          const acceptedIds = startedResults.flat();
          const scheduledQueueSet = new Set(scheduledQueueIds);
          const trackedIds = useDownloadStore.getState().downloads
            .filter(download =>
              previouslyTrackedIds.has(download.id) &&
              scheduledQueueSet.has(download.queueId || MAIN_QUEUE_ID) &&
              isActiveDownloadStatus(download.status)
            )
            .map(download => download.id);
          const activeIds = [...new Set([...acceptedIds, ...trackedIds])];
          state.setSchedulerActiveDownloadIds(activeIds);
          state.setSchedulerRunning(activeIds.length > 0);
          await invoke('ack_schedule_trigger', { action: 'start', key: payload.key });
        } else if (payload.action === 'stop') {
          const trackedIds = state.schedulerActiveDownloadIds;
          if (trackedIds.length > 0) {
            clearPendingPostActionTimer();
            const pauseResults = await Promise.allSettled(
              trackedIds.map(id => useDownloadStore.getState().pauseDownload(id))
            );
            const failedPauses = pauseResults.filter(result => result.status === 'rejected').length;
            if (failedPauses > 0) {
              addToast({
                message: failedPauses === 1
                  ? t($ => $.app.schedulerPauseOneFailed)
                  : t($ => $.app.schedulerPauseManyFailed, { count: failedPauses }),
                variant: 'error',
                isActionable: true
              });
            }
          }
          state.setSchedulerActiveDownloadIds([]);
          state.setSchedulerRunning(false);
          await invoke('ack_schedule_trigger', { action: 'stop', key: payload.key });
        }
      } finally {
        processingScheduleKeys.delete(payload.key);
      }
    });
    
    return () => {
      unlisten.then(f => f()).catch(console.error);
    };
  }, [addToast, clearPendingPostActionTimer, coreReady]);

  useEffect(() => {
    if (!coreReady) return;
    if (!schedulerRunning) return;
    if (schedulerActiveDownloadIds.length === 0) return;
    clearPendingPostActionTimer();
    const settings = useSettingsStore.getState();
    const completionState = schedulerCompletionState(downloads, schedulerActiveDownloadIds);
    if (completionState === 'active') return;

    settings.setSchedulerActiveDownloadIds([]);
    settings.setSchedulerRunning(false);

    if (completionState !== 'completed') {
      addToast({
        message: t($ => $.app.scheduledIncomplete),
        variant: 'warning',
        isActionable: true
      });
    } else if (settings.scheduler.postQueueAction !== 'none') {
      if (downloads.some(download => isActiveDownloadStatus(download.status))) {
        addToast({
          message: t($ => $.app.scheduledActionSkippedActive),
          variant: 'warning',
          isActionable: true
        });
      } else {
        schedulePostQueueAction(settings.scheduler.postQueueAction);
      }
    }
  }, [
    addToast,
    clearPendingPostActionTimer,
    coreReady,
    downloads,
    schedulePostQueueAction,
    schedulerRunning,
    schedulerActiveDownloadIds
  ]);

  useEffect(() => {
    const initNotifications = async () => {
      if (!useSettingsStore.getState().showNotifications) return;
      try {
        const permissionGranted = await isPermissionGranted();
        if (!permissionGranted) {
          const permission = await requestPermission();
          if (permission !== 'granted') {
            addToast({
              message: t($ => $.app.notificationsDisabled),
              variant: 'warning',
              isActionable: true
            });
          }
        }
      } catch (error) {
        addToast({
          message: t($ => $.app.notificationsFailed, { detail: String(error) }),
          variant: 'error',
          isActionable: true
        });
      }
    };

    if (useSettingsStore.persist.hasHydrated()) {
      void initNotifications();
      return;
    }
    return useSettingsStore.persist.onFinishHydration(() => {
      void initNotifications();
    });
  }, [addToast, showNotifications]);

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (!coreReady || useSettingsStore.getState().showKeychainModal) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }
      const text = e.clipboardData?.getData('text/plain');
      if (text && text.trim().length > 0) {
        const urls = extractValidDownloadUrls(text);
        if (urls.length > 0) {
          useDownloadStore.getState().openAddModalWithUrls(urls.join('\n'));
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [coreReady, showKeychainModal]);

  useEffect(() => {
    if (!coreReady || showKeychainModal || !autoAddClipboardLinks) return;

    let active = true;
    let wasForeground = false;
    let readInFlight = false;
    let lastClipboardKey: string | null = null;

    const isForeground = () =>
      document.visibilityState === 'visible' &&
      (typeof document.hasFocus !== 'function' || document.hasFocus());

    const readClipboardOnForeground = async () => {
      if (!active || readInFlight || !isForeground()) return;

      const storeBeforeRead = useDownloadStore.getState();
      const requestVersionBeforeRead = storeBeforeRead.pendingAddRequestVersion;
      readInFlight = true;
      try {
        const clipboardUrls = await readClipboardDownloadUrls();
        if (!active) return;

        const currentSettings = useSettingsStore.getState();
        const currentStore = useDownloadStore.getState();
        // A user action or extension handoff won while the native clipboard
        // read was pending. Let that newer Add-modal request win unchanged.
        if (
          !currentSettings.autoAddClipboardLinks ||
          currentSettings.showKeychainModal ||
          currentStore.pendingAddRequestVersion !== requestVersionBeforeRead
        ) {
          return;
        }

        const clipboardKey = [...clipboardUrls].sort().join('\n');
        if (clipboardKey === lastClipboardKey) return;
        lastClipboardKey = clipboardKey;
        if (clipboardUrls.length === 0) return;

        const existingUrls = new Set(extractValidDownloadUrls(currentStore.pendingAddUrls));
        const newUrls = clipboardUrls.filter(url => !existingUrls.has(url));
        if (newUrls.length > 0) {
          currentStore.openAddModalWithUrls(newUrls.join('\n'));
        }
      } catch (error) {
        // Clipboard permissions are optional and this feature is explicitly
        // opt-in, so a read failure should not interrupt normal app use.
        console.warn('Automatic clipboard capture failed:', error);
      } finally {
        readInFlight = false;
      }
    };

    const handleForegroundChange = () => {
      const foreground = isForeground();
      if (!foreground) {
        wasForeground = false;
        return;
      }
      if (!wasForeground) {
        wasForeground = true;
        void readClipboardOnForeground();
      }
    };

    window.addEventListener('focus', handleForegroundChange);
    window.addEventListener('blur', handleForegroundChange);
    document.addEventListener('visibilitychange', handleForegroundChange);
    handleForegroundChange();

    return () => {
      active = false;
      window.removeEventListener('focus', handleForegroundChange);
      window.removeEventListener('blur', handleForegroundChange);
      document.removeEventListener('visibilitychange', handleForegroundChange);
    };
  }, [autoAddClipboardLinks, coreReady, showKeychainModal]);

  useEffect(() => {
    const root = window.document.documentElement;
    
    const applyTheme = () => {
      // Remove all theme classes first
      root.classList.remove('theme-dark', 'theme-light', 'theme-dracula', 'theme-nord', 'dark');
      
    if (theme === 'system') {
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.add(systemDark ? 'theme-dark' : 'theme-light');
      root.dataset.resolvedTheme = systemDark ? 'dark' : 'light';
      root.style.colorScheme = systemDark ? 'dark' : 'light';
      if (systemDark) root.classList.add('dark');
    } else {
      root.classList.add(`theme-${theme}`);
      if (['dark', 'dracula', 'nord'].includes(theme)) {
        root.classList.add('dark');
      }
      root.dataset.resolvedTheme = ['dark', 'dracula', 'nord'].includes(theme) ? 'dark' : 'light';
      root.style.colorScheme = ['dark', 'dracula', 'nord'].includes(theme) ? 'dark' : 'light';
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

  return (
    <div className={`app-shell flex h-screen w-screen overflow-hidden text-text-primary ${
      isSidebarOnRight ? 'app-shell--sidebar-right' : 'app-shell--sidebar-left'
    } ${
      hasWindowChrome ? 'app-shell--window-chrome' : ''
    }`}>
      {usesCustomWindowControls && (
        <WindowControls
          side={isSidebarOnRight ? 'right' : 'left'}
          controlStyle={windowControlStyle}
        />
      )}
      <div
        className={`app-sidebar-shell relative z-20 shrink-0 transition-[width,margin-inline-start,margin-inline-end,opacity] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
          isSidebarOnRight ? 'app-sidebar-shell--right' : 'app-sidebar-shell--left'
        } ${
          isSidebarVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        style={{ 
          width: sidebarWidth,
          marginInlineStart: isSidebarVisible || isSidebarOnRight ? 0 : -sidebarWidth,
          marginInlineEnd: isSidebarVisible || !isSidebarOnRight ? 0 : -sidebarWidth
        }}
      >
        <div
          className="app-sidebar-panel h-full w-full"
          dir={isSidebarOnRight ? undefined : 'ltr'}
        >
          <Sidebar
            selectedFilter={filter}
            onSelectFilter={(f) => {
              setFilter(f);
              useSettingsStore.getState().setActiveView('downloads');
            }}
          />
        </div>
        <div
          className="sidebar-resize-handle"
          onPointerDown={startSidebarResize}
          title={t($ => $.actions.resizeSidebar)}
        />
      </div>

      <div
        className={`app-workspace relative z-0 flex-1 flex flex-col h-full overflow-hidden ${
          isSidebarOnRight ? 'app-workspace--sidebar-right' : 'app-workspace--sidebar-left'
        } ${
          !isSidebarVisible ? 'app-workspace--sidebar-collapsed' : ''
        } ${usesCustomWindowControls ? 'app-workspace--custom-window-controls' : ''}`}
      >
        {!isSidebarVisible && (
          <button
            type="button"
            onClick={toggleSidebar}
            className="app-icon-button app-sidebar-reveal-button h-7 w-7"
            title={t($ => $.actions.showSidebar)}
            aria-label={t($ => $.actions.showSidebar)}
          >
            <PanelLeft size={16} strokeWidth={2} />
          </button>
        )}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          <Suspense fallback={<PageLoadingFallback />}>
            {activeView === 'downloads' && (
              <DownloadTable
                filter={filter}
                onSummaryChange={handleDownloadTableSummaryChange}
              />
            )}
            {activeView === 'settings' && <SettingsView />}
            {activeView === 'scheduler' && <SchedulerView />}
            {activeView === 'speedLimiter' && <SpeedLimiterView />}
            {activeView === 'logs' && <LogsView />}
          </Suspense>
        </div>
        
        {/* Status Bar */}
        <div className="app-statusbar px-[14px] flex items-center justify-between text-text-muted shrink-0">
          <span>{t($ => $.status.ready)}</span>
          {activeView === 'downloads' && downloadTableSummary ? (
            <div className="app-statusbar-summary" dir="ltr" aria-live="polite">
              <span className="app-statusbar-summary-metric">
                <span dir="auto">{t($ => $.downloadTable.summary.downloaded)}</span>
                <strong dir="auto">{formatStatusSummaryBytes(downloadTableSummary.summary.downloadedBytes)}</strong>
              </span>
              <span className="app-statusbar-summary-metric">
                <span dir="auto">{t($ => $.downloadTable.summary.remaining)}</span>
                <strong dir="auto">{formatStatusSummaryBytes(
                  downloadTableSummary.summary.remainingBytes,
                  downloadTableSummary.summary.remainingIsEstimated
                )}</strong>
              </span>
            </div>
          ) : null}
          <div className="flex gap-3 tabular-nums">
            <span>{t($ => $.status.active, { count: activeDownloadCount })}</span>
            <span>{t($ => $.status.queued, { count: queuedCount })}</span>
            <span>{t($ => $.status.done, { count: doneCount })}</span>
          </div>
        </div>
      </div>
      
      {isAddModalOpen && <AddDownloadsModal />}

      {selectedPropertiesDownloadId !== null && (
        <Suspense fallback={null}>
          <PropertiesModal />
        </Suspense>
      )}
      {isDeleteModalOpen && (
        <Suspense fallback={null}>
          <DeleteConfirmationModal />
        </Suspense>
      )}
      {showKeychainModal && <KeychainPermissionModal consentVersion={keychainConsentVersion} />}

    </div>
  );
}

export default App;

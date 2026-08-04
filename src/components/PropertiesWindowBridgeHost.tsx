import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useDownloadStore } from '../store/useDownloadStore';
import type { DownloadItem } from '../store/useDownloadStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useDownloadProgressStore } from '../store/downloadProgressStore';
import {
  isValidTorrentExcludeTrackerList,
  isValidTorrentTrackerList,
  normalizeSpeedLimitForBackend,
} from '../utils/downloads';
import {
  PROPERTIES_WINDOW_ACTION_REQUEST,
  PROPERTIES_WINDOW_CLOSED,
  PROPERTIES_WINDOW_READY,
  applySecretPatch,
  beginExclusivePropertiesAction,
  createFrameCoalescer,
  getPropertiesLifecycleAction,
  sanitizePropertiesSnapshot,
  sendPropertiesActionResult,
  sendPropertiesRemoved,
  sendPropertiesSnapshot,
  type PropertiesActionRequest,
  type PropertiesPatch,
  type PropertiesWindowReady,
} from '../propertiesBridge';
import { invokeCommand as invoke } from '../ipc';
import i18n, { resolveAppLocale } from '../i18n';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const normalizeOptionalSpeed = (value: unknown, label: string): string | undefined => {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const normalized = normalizeSpeedLimitForBackend(trimmed);
  if (!normalized) throw new Error(`Invalid ${label}`);
  return normalized;
};

const copyEditablePatch = (rawPatch: PropertiesPatch): Partial<DownloadItem> => {
  const safePatch: Partial<DownloadItem> = {};
  const copy = (key: keyof PropertiesPatch) => {
    if (Object.prototype.hasOwnProperty.call(rawPatch, key)) {
      (safePatch as Record<string, unknown>)[key] = rawPatch[key];
    }
  };
  for (const key of [
    'fileName',
    'destination',
    'connections',
    'speedLimit',
    'torrentFileIndices',
    'torrentTrackers',
    'torrentExcludeTrackers',
    'torrentUploadLimit',
    'torrentMaxPeers',
    'torrentPeerSpeedLimit',
  ] as const) copy(key);

  if (safePatch.fileName !== undefined && typeof safePatch.fileName !== 'string') {
    throw new Error('Invalid file name');
  }
  if (safePatch.destination !== undefined && typeof safePatch.destination !== 'string') {
    throw new Error('Invalid destination');
  }

  if (safePatch.connections !== undefined
    && (!Number.isInteger(safePatch.connections) || safePatch.connections < 1 || safePatch.connections > 16)) {
    throw new Error('Connections must be a whole number from 1 to 16');
  }
  if (safePatch.speedLimit !== undefined) {
    safePatch.speedLimit = normalizeOptionalSpeed(safePatch.speedLimit, 'download speed limit');
  }
  if (safePatch.torrentUploadLimit !== undefined) {
    safePatch.torrentUploadLimit = normalizeOptionalSpeed(safePatch.torrentUploadLimit, 'Torrent upload limit');
  }
  if (safePatch.torrentPeerSpeedLimit !== undefined) {
    safePatch.torrentPeerSpeedLimit = normalizeOptionalSpeed(safePatch.torrentPeerSpeedLimit, 'Torrent peer speed limit');
  }
  if (safePatch.torrentMaxPeers !== undefined
    && (!Number.isInteger(safePatch.torrentMaxPeers) || safePatch.torrentMaxPeers < 0 || safePatch.torrentMaxPeers > 1000)) {
    throw new Error('Torrent maximum peers must be a whole number from 0 to 1000');
  }
  if (safePatch.torrentTrackers !== undefined
    && (typeof safePatch.torrentTrackers !== 'string' || !isValidTorrentTrackerList(safePatch.torrentTrackers))) {
    throw new Error('Invalid Torrent tracker list');
  }
  if (typeof safePatch.torrentTrackers === 'string' && !safePatch.torrentTrackers.trim()) {
    safePatch.torrentTrackers = undefined;
  }
  if (safePatch.torrentExcludeTrackers !== undefined
    && (typeof safePatch.torrentExcludeTrackers !== 'string' || !isValidTorrentExcludeTrackerList(safePatch.torrentExcludeTrackers))) {
    throw new Error('Invalid excluded Torrent tracker list');
  }
  if (typeof safePatch.torrentExcludeTrackers === 'string' && !safePatch.torrentExcludeTrackers.trim()) {
    safePatch.torrentExcludeTrackers = undefined;
  }
  if (safePatch.torrentFileIndices !== undefined
    && (!Array.isArray(safePatch.torrentFileIndices)
      || safePatch.torrentFileIndices.length === 0
      || safePatch.torrentFileIndices.some(index => !Number.isInteger(index) || index < 0))) {
    throw new Error('Torrent file selection must contain at least one valid file');
  }
  return safePatch;
};

export const PropertiesWindowBridgeHost = () => {
  useEffect(() => {
    const windows = new Map<string, string>();
    const snapshotRevisions = new Map<string, number>();
    const actionsInFlight = new Set<string>();
    let disposed = false;
    let unlistenReady: UnlistenFn | undefined;
    let unlistenAction: UnlistenFn | undefined;
    let unlistenClosed: UnlistenFn | undefined;
    const snapshotCoalescer = createFrameCoalescer(
      windowLabel => {
        const downloadId = windows.get(windowLabel);
        if (downloadId) void sendFor(windowLabel, downloadId).catch(() => undefined);
      },
      callback => window.requestAnimationFrame(callback),
      handle => window.cancelAnimationFrame(handle),
    );

    const sendFor = async (windowLabel: string, downloadId: string) => {
      const item = useDownloadStore.getState().downloads.find(download => download.id === downloadId);
      if (!item || disposed) return false;
      const settings = useSettingsStore.getState();
      const progress = useDownloadProgressStore.getState();
      const revision = (snapshotRevisions.get(windowLabel) ?? 0) + 1;
      snapshotRevisions.set(windowLabel, revision);
      await sendPropertiesSnapshot(windowLabel, {
        windowLabel,
        downloadId,
        revision,
        snapshot: sanitizePropertiesSnapshot(item, {
          theme: settings.theme,
          fontFamily: settings.fontFamily,
          appFontSize: settings.appFontSize,
          listRowDensity: settings.listRowDensity,
          locale: resolveAppLocale(i18n.language),
        }, {
          progress: progress.progressMap[downloadId],
          moveProgress: progress.moveProgressMap[downloadId],
        }),
      });
      return true;
    };

    const handleReady = async (payload: PropertiesWindowReady) => {
      try {
        await invoke('validate_properties_window_request', payload);
        const item = useDownloadStore.getState().downloads.find(download => download.id === payload.downloadId);
        if (!item) {
          await sendPropertiesRemoved(payload.windowLabel, payload.downloadId);
          return;
        }
        windows.set(payload.windowLabel, payload.downloadId);
        if (!snapshotRevisions.has(payload.windowLabel)) snapshotRevisions.set(payload.windowLabel, 0);
        await sendFor(payload.windowLabel, payload.downloadId);
      } catch {
        // The child will show its own unavailable state. Do not log bridge
        // payloads because they may contain URLs or other user data.
      }
    };

    const handleAction = async (request: PropertiesActionRequest) => {
      let ok = false;
      let error: string | undefined;
      const actionKey = `${request.windowLabel}:${request.downloadId}`;
      let releaseAction: (() => void) | undefined;
      try {
        await invoke('validate_properties_window_request', request);
        if (windows.get(request.windowLabel) !== request.downloadId) {
          throw new Error('Properties window is no longer registered');
        }
        releaseAction = beginExclusivePropertiesAction(actionsInFlight, actionKey);
        const store = useDownloadStore.getState();
        const item = store.downloads.find(download => download.id === request.downloadId);
        if (!item) throw new Error('Download no longer exists');

        switch (request.action) {
          case 'apply-properties': {
            const rawPatch = (request.payload ?? {}) as PropertiesPatch;
            const safePatch = copyEditablePatch(rawPatch);
            if ('password' in rawPatch) {
              safePatch.password = applySecretPatch(rawPatch.password, item.password);
            }
            if ('cookies' in rawPatch) {
              safePatch.cookies = applySecretPatch(rawPatch.cookies, item.cookies);
            }
            if ('headers' in rawPatch) {
              safePatch.headers = applySecretPatch(rawPatch.headers, item.headers);
            }
            if ('username' in rawPatch) {
              safePatch.username = applySecretPatch(rawPatch.username, item.username);
            }
            await store.applyProperties(request.downloadId, safePatch);
            break;
          }
          case 'pause-resume': {
            const lifecycleAction = getPropertiesLifecycleAction(item.status);
            if (!lifecycleAction) {
              throw new Error('This download has no available lifecycle action');
            }
            if (lifecycleAction === 'pause') {
              await store.pauseDownload(request.downloadId);
              const current = useDownloadStore.getState().downloads.find(download => download.id === request.downloadId);
              if (!current) throw new Error('Download was removed while pausing');
              if (!['paused', 'completed', 'failed'].includes(current.status)) {
                throw new Error('The download did not reach a paused or terminal state');
              }
            } else {
              const resumed = await store.resumeDownload(request.downloadId);
              if (!resumed) {
                throw new Error(i18n.t($ => $.downloadTable.backendRejectedStart));
              }
              const current = useDownloadStore.getState().downloads.find(download => download.id === request.downloadId);
              if (!current) throw new Error('Download was removed while starting');
              // A fast completion is a valid outcome of a successful resume;
              // only a status that proves the request never left its
              // pre-action state is a rejected start. Preserve failed as an
              // error so a real backend failure is not reported as success.
              if (['paused', 'ready', 'staged', 'failed'].includes(current.status)) {
                throw new Error(i18n.t($ => $.downloadTable.backendRejectedStart));
              }
            }
            break;
          }
          case 'verify-torrent': {
            if (item.isTorrent !== true
              || !['paused', 'completed', 'failed'].includes(item.status)) {
              throw new Error('Pause the Torrent before verifying its data');
            }
            const previousVerifyOnly = item.torrentVerifyOnly;
            const previousRestoreStatus = item.torrentVerifyRestoreStatus;
            store.updateDownload(request.downloadId, {
              torrentVerifyOnly: true,
              torrentVerifyRestoreStatus: item.status,
            });
            try {
              await invoke('verify_torrent_data', { id: request.downloadId });
            } catch (verifyError) {
              useDownloadStore.getState().updateDownload(request.downloadId, {
                torrentVerifyOnly: previousVerifyOnly,
                torrentVerifyRestoreStatus: previousRestoreStatus,
              });
              throw verifyError;
            }
            break;
          }
          case 'set-download-limit':
            await store.setDownloadSpeedLimit(request.downloadId, request.payload && 'limit' in request.payload ? request.payload.limit : null);
            break;
          case 'set-torrent-upload-limit':
            await store.setTorrentUploadLimit(request.downloadId, request.payload && 'limit' in request.payload ? request.payload.limit : null);
            break;
          case 'set-torrent-peer-options': {
            if (!request.payload || !('maxPeers' in request.payload)) throw new Error('Invalid Torrent peer options');
            await store.setTorrentPeerOptions(request.downloadId, request.payload.maxPeers, request.payload.peerSpeedLimit);
            break;
          }
          default:
            throw new Error('Invalid Properties action');
        }
        if (!useDownloadStore.getState().downloads.some(download => download.id === request.downloadId)) {
          throw new Error('Download was removed while applying the action');
        }
        ok = true;
      } catch (caught) {
        error = errorText(caught);
      } finally {
        releaseAction?.();
      }
      if (ok) {
        try {
          await sendFor(request.windowLabel, request.downloadId);
        } catch {
          // Snapshot delivery is best effort across a close/reopen race.
        }
      }
      try {
        await sendPropertiesActionResult(request.windowLabel, {
          windowLabel: request.windowLabel,
          downloadId: request.downloadId,
          requestId: request.requestId,
          ok,
          ...(error ? { error } : {}),
        });
      } catch {
        // The window may have closed between the request and its result.
        return;
      }
    };

    void listen<PropertiesWindowReady>(PROPERTIES_WINDOW_READY, event => void handleReady(event.payload)).then(value => { unlistenReady = value; });
    void listen<PropertiesActionRequest>(PROPERTIES_WINDOW_ACTION_REQUEST, event => void handleAction(event.payload)).then(value => { unlistenAction = value; });
    void listen<string>(PROPERTIES_WINDOW_CLOSED, event => {
      const downloadId = windows.get(event.payload);
      windows.delete(event.payload);
      snapshotRevisions.delete(event.payload);
      snapshotCoalescer.cancel(event.payload);
      if (downloadId) actionsInFlight.delete(`${event.payload}:${downloadId}`);
    }).then(value => { unlistenClosed = value; });

    const unsubscribeStore = useDownloadStore.subscribe((state, previous) => {
      for (const [windowLabel, downloadId] of windows) {
        const next = state.downloads.find(download => download.id === downloadId);
        const before = previous.downloads.find(download => download.id === downloadId);
        if (!next) {
          snapshotCoalescer.cancel(windowLabel);
          void sendPropertiesRemoved(windowLabel, downloadId).catch(() => undefined);
          windows.delete(windowLabel);
          snapshotRevisions.delete(windowLabel);
          void invoke('properties_window_registry_remove_for_download', { id: downloadId }).catch(() => undefined);
        } else if (next !== before) {
          snapshotCoalescer.schedule(windowLabel);
        }
      }
    });
    const unsubscribeProgress = useDownloadProgressStore.subscribe((state, previous) => {
      for (const [windowLabel, downloadId] of windows) {
        if (state.progressMap[downloadId] !== previous.progressMap[downloadId]
          || state.moveProgressMap[downloadId] !== previous.moveProgressMap[downloadId]) {
          snapshotCoalescer.schedule(windowLabel);
        }
      }
    });
    const unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
      if (state.theme === previous.theme
        && state.fontFamily === previous.fontFamily
        && state.appFontSize === previous.appFontSize
        && state.listRowDensity === previous.listRowDensity
        && state.language === previous.language) {
        return;
      }
      for (const windowLabel of windows.keys()) {
        snapshotCoalescer.schedule(windowLabel);
      }
    });
    const handleLanguageChanged = () => {
      for (const windowLabel of windows.keys()) {
        snapshotCoalescer.schedule(windowLabel);
      }
    };
    i18n.on('languageChanged', handleLanguageChanged);

    return () => {
      disposed = true;
      snapshotCoalescer.cancelAll();
      unsubscribeStore();
      unsubscribeProgress();
      unsubscribeSettings();
      i18n.off('languageChanged', handleLanguageChanged);
      unlistenReady?.();
      unlistenAction?.();
      unlistenClosed?.();
    };
  }, []);

  return null;
};

import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useDownloadStore } from '../store/useDownloadStore';
import type { DownloadItem } from '../store/useDownloadStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useDownloadProgressStore } from '../store/downloadProgressStore';
import {
  MAX_TORRENT_STOP_TIMEOUT,
  isValidTorrentExcludeTrackerList,
  isValidTorrentTrackerList,
  normalizeSpeedLimitForBackend,
  normalizeTorrentEncryptionPolicy,
  normalizeTorrentFileAllocation,
  normalizeTorrentPrioritizePiece,
  normalizeTorrentTrackerInterval,
  normalizeTorrentTrackerTimeout,
} from '../utils/downloads';
import {
  PROPERTIES_WINDOW_ACTION_REQUEST,
  PROPERTIES_WINDOW_CLOSED,
  PROPERTIES_WINDOW_READY,
  applySecretPatch,
  attachAsyncPropertiesListener,
  beginExclusivePropertiesAction,
  classifyPropertiesActionRequest,
  createFrameCoalescer,
  decodePropertiesPatchValue,
  enqueuePropertiesAction,
  getPropertiesLifecycleAction,
  propertiesActionRequestKey,
  PROPERTIES_PATCH_CLEARABLE_KEYS,
  sanitizePropertiesSnapshot,
  sendPropertiesActionResult,
  sendPropertiesRemoved,
  sendPropertiesSnapshot,
  propertiesWindowEventTarget,
  type PropertiesActionRequest,
  type PropertiesActionResult,
  type PropertiesPatch,
  type PropertiesWindowRegistration,
  type PropertiesWindowReady,
} from '../propertiesBridge';
import { invokeCommand as invoke } from '../ipc';
import { getPlatformInfo } from '../utils/platform';
import { resolveWindowControlSide, resolveWindowControlStyle } from '../utils/windowControlStyle';
import i18n, { localeDirection, resolveAppLocale } from '../i18n';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
let lastPropertiesBridgeGeneration = 0;

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
    'torrentTrackers',
    'torrentExcludeTrackers',
    'torrentSeedTime',
    'torrentSeedRatio',
    'torrentCheckIntegrity',
    'torrentRemoveUnselectedFile',
    'torrentUploadLimit',
    'torrentMaxPeers',
    'torrentPeerSpeedLimit',
    'torrentTrackerConnectTimeout',
    'torrentTrackerTimeout',
    'torrentTrackerInterval',
    'torrentStopTimeout',
    'torrentPrioritizePiece',
    'torrentEncryptionPolicy',
    'torrentFileAllocation',
  ] as const) copy(key);

  for (const key of PROPERTIES_PATCH_CLEARABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(rawPatch, key)) {
      const value = (rawPatch as Record<string, unknown>)[key];
      (safePatch as Record<string, unknown>)[key] = decodePropertiesPatchValue(value);
    }
  }

  if (safePatch.fileName !== undefined && typeof safePatch.fileName !== 'string') {
    throw new Error('Invalid file name');
  }
  if (safePatch.destination !== undefined && typeof safePatch.destination !== 'string') {
    throw new Error('Invalid destination');
  }
  if (safePatch.sftpHostKeyMd !== undefined) {
    if (typeof safePatch.sftpHostKeyMd !== 'string') throw new Error('Invalid SFTP host-key fingerprint');
    const fingerprint = safePatch.sftpHostKeyMd.trim().toLowerCase();
    const valid = /^(md5|sha-1)=[0-9a-f]+$/.test(fingerprint)
      && ((fingerprint.startsWith('md5=') && fingerprint.length === 36)
        || (fingerprint.startsWith('sha-1=') && fingerprint.length === 45));
    if (!valid) throw new Error('Invalid SFTP host-key fingerprint');
    safePatch.sftpHostKeyMd = fingerprint;
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
  for (const [key, minimum] of [
    ['torrentSeedTime', 0],
    ['torrentSeedRatio', 0],
  ] as const) {
    const value = safePatch[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < minimum)) {
      throw new Error(`Invalid ${key}`);
    }
  }
  for (const key of ['torrentTrackerConnectTimeout', 'torrentTrackerTimeout'] as const) {
    const value = safePatch[key];
    if (value !== undefined && normalizeTorrentTrackerTimeout(value) === undefined) {
      throw new Error(`Invalid ${key}`);
    }
  }
  if (safePatch.torrentTrackerInterval !== undefined
    && normalizeTorrentTrackerInterval(safePatch.torrentTrackerInterval) === undefined) {
    throw new Error('Invalid torrentTrackerInterval');
  }
  if (safePatch.torrentStopTimeout !== undefined
    && (!Number.isInteger(safePatch.torrentStopTimeout)
      || safePatch.torrentStopTimeout < 0
      || safePatch.torrentStopTimeout > MAX_TORRENT_STOP_TIMEOUT)) {
    throw new Error('Invalid torrentStopTimeout');
  }
  if (safePatch.torrentPrioritizePiece !== undefined
    && normalizeTorrentPrioritizePiece(safePatch.torrentPrioritizePiece) == null) {
    throw new Error('Invalid torrentPrioritizePiece');
  }
  if (safePatch.torrentEncryptionPolicy !== undefined
    && normalizeTorrentEncryptionPolicy(safePatch.torrentEncryptionPolicy) === undefined) {
    throw new Error('Invalid torrentEncryptionPolicy');
  }
  if (safePatch.torrentFileAllocation !== undefined
    && normalizeTorrentFileAllocation(safePatch.torrentFileAllocation) === undefined) {
    throw new Error('Invalid torrentFileAllocation');
  }
  for (const key of ['torrentCheckIntegrity', 'torrentRemoveUnselectedFile'] as const) {
    if (safePatch[key] !== undefined && typeof safePatch[key] !== 'boolean') {
      throw new Error(`Invalid ${key}`);
    }
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
    const mainWindowTarget = propertiesWindowEventTarget(getCurrentWindow().label);
    const windows = new Map<string, PropertiesWindowRegistration>();
    const snapshotRevisions = new Map<string, number>();
    const actionsInFlight = new Set<string>();
    const actionChains = new Map<string, Promise<void>>();
    const actionOperations = new Map<string, Promise<void>>();
    const actionResults = new Map<string, PropertiesActionResult>();
    let platformOs = 'unknown';
    const bridgeGeneration = Math.max(Date.now(), lastPropertiesBridgeGeneration + 1);
    lastPropertiesBridgeGeneration = bridgeGeneration;
    let disposed = false;
    let unlistenReady: UnlistenFn | undefined;
    let unlistenAction: UnlistenFn | undefined;
    let unlistenClosed: UnlistenFn | undefined;
    const snapshotCoalescer = createFrameCoalescer(
      windowLabel => {
        const registration = windows.get(windowLabel);
        if (registration) void sendFor(windowLabel, registration.downloadId).catch(() => undefined);
      },
      callback => window.requestAnimationFrame(callback),
      handle => window.cancelAnimationFrame(handle),
    );

    const clearWindowActionState = (windowLabel: string) => {
      const resultPrefix = `${windowLabel}\u0000`;
      for (const key of actionResults.keys()) {
        if (key.startsWith(resultPrefix)) actionResults.delete(key);
      }
      for (const key of actionOperations.keys()) {
        if (key.startsWith(resultPrefix)) actionOperations.delete(key);
      }
      // A renderer session can be replaced while an accepted mutation is
      // still running. Keep the download-scoped chain so the next session
      // cannot start a second mutation concurrently with that operation.
      // Completed chains remove themselves; host teardown clears the map.
    };

    const clearSessionActionResults = (windowLabel: string, sessionId: string) => {
      const resultPrefix = `${windowLabel}\u0000${sessionId}\u0000`;
      for (const key of actionResults.keys()) {
        if (key.startsWith(resultPrefix)) actionResults.delete(key);
      }
    };

    const cacheActionResult = (key: string, result: PropertiesActionResult) => {
      // A child can have only one pending action per session. Retain the most
      // recent completed result for that session until a newer request is
      // accepted, so a lost result can always be replayed without allowing an
      // unbounded per-action cache.
      const separator = key.lastIndexOf('\u0000');
      const sessionPrefixEnd = separator >= 0 ? key.lastIndexOf('\u0000', separator - 1) : -1;
      if (sessionPrefixEnd >= 0) {
        const sessionPrefix = key.slice(0, sessionPrefixEnd + 1);
        for (const existingKey of actionResults.keys()) {
          if (existingKey.startsWith(sessionPrefix)) actionResults.delete(existingKey);
        }
      }
      actionResults.set(key, result);
    };

    const sendFor = async (windowLabel: string, downloadId: string) => {
      const registration = windows.get(windowLabel);
      if (!registration || registration.downloadId !== downloadId || disposed) return false;
      const store = useDownloadStore.getState();
      const item = store.downloads.find(download => download.id === downloadId);
      if (!item) return false;
      const queue = store.queues.find(candidate => candidate.id === item.queueId)
        ?? store.queues.find(candidate => candidate.isMain);
      const settings = useSettingsStore.getState();
      const progress = useDownloadProgressStore.getState();
      const windowChrome = {
        controlStyle: resolveWindowControlStyle(
          settings.windowControlStyle,
          platformOs,
          navigator.userAgent,
        ),
        side: resolveWindowControlSide(
          settings.sidebarPosition,
          localeDirection(resolveAppLocale(i18n.language)),
        ),
      };
      const revision = (snapshotRevisions.get(windowLabel) ?? 0) + 1;
      snapshotRevisions.set(windowLabel, revision);
      await sendPropertiesSnapshot(windowLabel, {
        windowLabel,
        downloadId,
        sessionId: registration.sessionId,
        bridgeGeneration,
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
        }, {
          queueName: queue?.name,
          windowChrome,
        }),
      });
      return true;
    };

    const synchronizeRegistration = (
      windowLabel: string,
      downloadId: string,
      sessionId: string,
    ) => {
      const previous = windows.get(windowLabel);
      const sessionChanged = previous?.downloadId !== downloadId || previous.sessionId !== sessionId;
      if (sessionChanged) clearWindowActionState(windowLabel);
      windows.set(windowLabel, {
        downloadId,
        sessionId,
        latestRequestId: sessionChanged ? 0 : (previous?.latestRequestId ?? 0),
      });
      if (sessionChanged) {
        snapshotRevisions.set(windowLabel, 0);
      } else if (!snapshotRevisions.has(windowLabel)) {
        snapshotRevisions.set(windowLabel, 0);
      }
    };

    const assertCurrentAction = async (request: PropertiesActionRequest) => {
      await invoke('validate_properties_window_request', {
        windowLabel: request.windowLabel,
        downloadId: request.downloadId,
        sessionId: request.sessionId,
        requestId: request.requestId,
      });
      if (disposed) throw new Error('Properties bridge is no longer active');
      const registration = windows.get(request.windowLabel);
      if (!registration
        || registration.downloadId !== request.downloadId
        || registration.sessionId !== request.sessionId
        || registration.latestRequestId !== request.requestId) {
        throw new Error('Properties action is stale');
      }
    };

    const handleReady = async (payload: PropertiesWindowReady) => {
      if (disposed) return;
      try {
        await invoke('validate_properties_window_request', payload);
        if (disposed) return;
        const item = useDownloadStore.getState().downloads.find(download => download.id === payload.downloadId);
        if (!item) {
          // The store subscription cannot see a window that never completed
          // registration. Tear down the native registry entry here as well,
          // otherwise a late ready event can leave an empty child window and
          // a permanently reserved label for a deleted download.
          void sendPropertiesRemoved(payload.windowLabel, payload.downloadId).catch(() => undefined);
          await invoke('properties_window_registry_remove_for_download', { id: payload.downloadId });
          return;
        }
        synchronizeRegistration(payload.windowLabel, payload.downloadId, payload.sessionId);
        await sendFor(payload.windowLabel, payload.downloadId);
      } catch {
        // The child will show its own unavailable state. Do not log bridge
        // payloads because they may contain URLs or other user data.
      }
    };

    const processAction = async (request: PropertiesActionRequest) => {
      let ok = false;
      let error: string | undefined;
      const actionKey = `${request.windowLabel}:${request.downloadId}`;
      let releaseAction: (() => void) | undefined;
      try {
        // The request may have waited behind another action. Revalidate the
        // native session and request ordering at dequeue time so a closed,
        // reopened, or reloaded Properties window cannot apply stale work.
        await assertCurrentAction(request);
        releaseAction = beginExclusivePropertiesAction(actionsInFlight, actionKey);
        const store = useDownloadStore.getState();
        const item = store.downloads.find(download => download.id === request.downloadId);
        if (!item) throw new Error('Download no longer exists');

        switch (request.action) {
          case 'apply-properties': {
            await assertCurrentAction(request);
            const rawPatch = (request.payload ?? {}) as PropertiesPatch;
            if (Object.prototype.hasOwnProperty.call(rawPatch, 'torrentFileIndices')) {
              throw new Error('Torrent file selection requires the dedicated selection action');
            }
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
            const torrentOptionKeys = [
              'torrentFileIndices',
              'torrentTrackers',
              'torrentExcludeTrackers',
              'torrentSeedTime',
              'torrentSeedRatio',
              'torrentCheckIntegrity',
              'torrentRemoveUnselectedFile',
              'torrentUploadLimit',
              'torrentMaxPeers',
              'torrentPeerSpeedLimit',
              'torrentTrackerConnectTimeout',
              'torrentTrackerTimeout',
              'torrentTrackerInterval',
              'torrentStopTimeout',
              'torrentPrioritizePiece',
              'torrentEncryptionPolicy',
              'torrentFileAllocation',
            ] as const;
            if (item.isTorrent !== true && torrentOptionKeys.some(key => Object.prototype.hasOwnProperty.call(rawPatch, key))) {
              throw new Error('Torrent properties are only available for Torrent downloads');
            }
            if (item.isTorrent === true && Object.prototype.hasOwnProperty.call(rawPatch, 'connections')) {
              throw new Error('Generic connection settings are not available for Torrent downloads');
            }
            await store.applyProperties(request.downloadId, safePatch);
            break;
          }
          case 'set-torrent-file-selection': {
            if (item.isTorrent !== true
              || !request.payload
              || !('selectedIndices' in request.payload)) {
              throw new Error('Torrent file selection is unavailable for this download');
            }
            const selectedIndices = request.payload.selectedIndices;
            if (selectedIndices !== null
              && (!Array.isArray(selectedIndices)
                || selectedIndices.length === 0
                || selectedIndices.some(index => !Number.isInteger(index) || index < 1))) {
              throw new Error('Torrent file selection must contain at least one valid file');
            }
            const selection = await invoke('set_torrent_file_selection', {
              id: request.downloadId,
              selected_indices: selectedIndices,
            });
            const selected = selection.files.filter(file => file.selected).map(file => file.index);
            const allSelected = selection.files.length > 0 && selected.length === selection.files.length;
            store.updateDownload(request.downloadId, {
              torrentFileIndices: allSelected ? undefined : selected,
            });
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
              // resumeDownload returns after the lifecycle request has been
              // accepted, while the backend may still be admitting a queue
              // slot, rebinding a retained GID, or emitting the first active
              // state. Do not inspect the store synchronously here: an event
              // from the previous lifecycle can still leave the row paused
              // for one turn even though the request was accepted.
              if (!useDownloadStore.getState().downloads.some(download => download.id === request.downloadId)) {
                throw new Error('Download was removed while starting');
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
      if (ok) void sendFor(request.windowLabel, request.downloadId).catch(() => undefined);
      const result: PropertiesActionResult = {
        windowLabel: request.windowLabel,
        downloadId: request.downloadId,
        sessionId: request.sessionId,
        requestId: request.requestId,
        ok,
        ...(error ? { error } : {}),
      };
      cacheActionResult(propertiesActionRequestKey(request), result);
      try {
        await sendPropertiesActionResult(request.windowLabel, result);
      } catch {
        // The result remains cached so a same-request retry can replay it.
      }
    };

    const sendRejectedActionResult = async (request: PropertiesActionRequest, reason: unknown) => {
      const result: PropertiesActionResult = {
        windowLabel: request.windowLabel,
        downloadId: request.downloadId,
        sessionId: request.sessionId,
        requestId: request.requestId,
        ok: false,
        error: errorText(reason),
      };
      // Validation failures did not enter the mutation queue, so do not cache
      // them as a completed request. A same-ID retry must be able to recover
      // from a transient registry/session race.
      try {
        await sendPropertiesActionResult(request.windowLabel, result);
      } catch {
        // The child may have closed while the validation error was delivered.
      }
    };

    const handleAction = async (request: PropertiesActionRequest) => {
      if (disposed) return;
      try {
        // The native command validates the caller, download binding, and
        // renderer session. If a ready event is delayed or lost, this valid
        // action can also establish the main-window registration.
        await invoke('validate_properties_window_request', request);
        if (disposed) return;
        synchronizeRegistration(request.windowLabel, request.downloadId, request.sessionId);
      } catch (error) {
        // Stale renderer actions are deliberately ignored. The current child
        // session cannot safely consume a result for a superseded renderer,
        // but an active child still needs a terminal result to unlock its
        // request state and decide whether to retry.
        sendRejectedActionResult(request, error);
        return;
      }

      const registration = windows.get(request.windowLabel);
      if (!registration) {
        sendRejectedActionResult(request, new Error('Properties window is no longer registered'));
        return;
      }
      const requestKey = propertiesActionRequestKey(request);
      const disposition = classifyPropertiesActionRequest(
        registration,
        request,
        actionResults.has(requestKey),
        actionOperations.has(requestKey),
      );
      if (disposition === 'replay') {
        const result = actionResults.get(requestKey);
        if (result) void sendPropertiesActionResult(request.windowLabel, result).catch(() => undefined);
        return;
      }
      if (disposition === 'pending') return;
      if (disposition === 'ignore') {
        sendRejectedActionResult(request, new Error('Properties action is stale'));
        return;
      }
      clearSessionActionResults(request.windowLabel, request.sessionId);
      registration.latestRequestId = request.requestId;
      const actionKey = `${request.windowLabel}:${request.downloadId}`;

      // Preserve user order for accepted requests. This keeps a pause from an
      // earlier request from running after a newer resume, while still
      // allowing the newer request to run after an already-started operation.
      const operation = enqueuePropertiesAction(actionChains, actionKey, () => processAction(request));
      actionOperations.set(requestKey, operation);
      const clearOperation = () => {
        if (actionOperations.get(requestKey) === operation) actionOperations.delete(requestKey);
      };
      // Consume either outcome while removing the in-flight marker. An
      // unexpected host exception must not become an unhandled rejection.
      void operation.then(clearOperation, clearOperation);
    };

    attachAsyncPropertiesListener(
      listen<PropertiesWindowReady>(PROPERTIES_WINDOW_READY, event => {
        if (!disposed) void handleReady(event.payload);
      }, { target: mainWindowTarget }),
      () => disposed,
      value => { unlistenReady = value; },
    );
    attachAsyncPropertiesListener(
      listen<PropertiesActionRequest>(PROPERTIES_WINDOW_ACTION_REQUEST, event => {
        if (!disposed) void handleAction(event.payload);
      }, { target: mainWindowTarget }),
      () => disposed,
      value => { unlistenAction = value; },
    );
    attachAsyncPropertiesListener(
      listen<string>(PROPERTIES_WINDOW_CLOSED, event => {
        if (disposed) return;
        const registration = windows.get(event.payload);
        windows.delete(event.payload);
        snapshotRevisions.delete(event.payload);
        clearWindowActionState(event.payload);
        snapshotCoalescer.cancel(event.payload);
        if (registration) actionsInFlight.delete(`${event.payload}:${registration.downloadId}`);
      }, { target: mainWindowTarget }),
      () => disposed,
      value => { unlistenClosed = value; },
    );

    const unsubscribeStore = useDownloadStore.subscribe((state, previous) => {
      for (const [windowLabel, registration] of windows) {
        const { downloadId } = registration;
        const next = state.downloads.find(download => download.id === downloadId);
        const before = previous.downloads.find(download => download.id === downloadId);
        if (!next) {
          snapshotCoalescer.cancel(windowLabel);
          void sendPropertiesRemoved(windowLabel, downloadId).catch(() => undefined);
          windows.delete(windowLabel);
          snapshotRevisions.delete(windowLabel);
          clearWindowActionState(windowLabel);
          void invoke('properties_window_registry_remove_for_download', { id: downloadId }).catch(() => undefined);
        } else if (next !== before) {
          snapshotCoalescer.schedule(windowLabel);
        }
      }
    });
    const unsubscribeProgress = useDownloadProgressStore.subscribe((state, previous) => {
      for (const [windowLabel, registration] of windows) {
        const { downloadId } = registration;
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
        && state.language === previous.language
        && state.windowControlStyle === previous.windowControlStyle
        && state.sidebarPosition === previous.sidebarPosition) {
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

    void getPlatformInfo().then(info => {
      if (disposed) return;
      platformOs = info.os;
      for (const windowLabel of windows.keys()) snapshotCoalescer.schedule(windowLabel);
    }).catch(() => undefined);

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
      actionOperations.clear();
      actionResults.clear();
      actionChains.clear();
    };
  }, []);

  return null;
};

import type { UnlistenFn } from '@tauri-apps/api/event';
import type { DownloadStatus } from '../bindings/DownloadStatus';
import { listenEvent as listen } from '../ipc';
import type { DownloadItem } from '../bindings/DownloadItem';
import { categoryForFileName } from '../utils/downloads';
import { useDownloadProgressStore } from './downloadProgressStore';

import {
  clearDownloadControlIntent,
  downloadControlIntentFor,
  hasStaleTemporaryMediaEstimate,
  useDownloadStore
} from './useDownloadStore';

export { useDownloadProgressStore } from './downloadProgressStore';

let unlistenProgress: UnlistenFn | null = null;
let unlistenState: UnlistenFn | null = null;
let unlistenMoveProgress: UnlistenFn | null = null;
let unlistenTray: UnlistenFn | null = null;
let listenerSetup: Promise<void> | null = null;
let listenerConsumers = 0;

const disposeDownloadListeners = () => {
  unlistenProgress?.();
  unlistenProgress = null;
  unlistenState?.();
  unlistenState = null;
  unlistenMoveProgress?.();
  unlistenMoveProgress = null;
  unlistenTray?.();
  unlistenTray = null;
  listenerSetup = null;
};

const startDownloadListeners = async () => {
  const registrations = await Promise.allSettled([
    listen('download-progress', (event) => {
      const payload = event.payload;
      const mainStore = useDownloadStore.getState();
      const current = mainStore.downloads.find(d => d.id === payload.id);
      if (!current) {
        // A removed row can still have one queued sidecar event in flight.
        // Do not let that event recreate an orphaned progress entry.
        useDownloadProgressStore.getState().clearDownloadProgress(payload.id);
        return;
      }
      // A sidecar can flush one last progress chunk after a pause, failure,
      // completion, or lifecycle reset. Do not let that stale chunk repopulate
      // the live progress map or overwrite a later lifecycle's first frame.
      if (!['downloading', 'processing', 'verifying', 'seeding'].includes(current.status)) {
        useDownloadProgressStore.getState().clearDownloadProgress(payload.id);
        return;
      }
      useDownloadProgressStore.getState().updateDownloadProgress(payload.id, payload);
      const shouldUpdateSize = Boolean(payload.size && (!current.isMedia || payload.size_is_final));
      const updates: Partial<DownloadItem> = {};
      if (current.status === 'downloading' || current.status === 'processing' || current.status === 'verifying' || current.status === 'seeding') {
        updates.fraction = payload.fraction;
        updates.speed = current.status === 'seeding'
          ? payload.upload_speed ?? '-'
          : payload.speed;
        updates.eta = current.status === 'seeding' ? '-' : payload.eta;
      }
      if (shouldUpdateSize && current.size !== payload.size) {
        updates.size = payload.size!;
      }
      if (payload.downloaded_bytes !== null && payload.downloaded_bytes !== undefined) {
        updates.downloadedBytes = payload.downloaded_bytes;
      }
      if (payload.total_bytes !== null && payload.total_bytes !== undefined) {
        updates.totalBytes = payload.total_bytes;
      }
      if (payload.total_is_estimate !== null && payload.total_is_estimate !== undefined) {
        updates.totalIsEstimate = payload.total_is_estimate;
      }
      if (current.isTorrent) {
        if (payload.uploaded_bytes !== null
            && payload.uploaded_bytes !== undefined
            && Number.isSafeInteger(payload.uploaded_bytes)
            && payload.uploaded_bytes >= 0) {
          updates.torrentUploadedBytes = payload.uploaded_bytes;
        }
        if (payload.torrent_seeded_seconds !== null
            && payload.torrent_seeded_seconds !== undefined
            && Number.isSafeInteger(payload.torrent_seeded_seconds)
            && payload.torrent_seeded_seconds >= 0) {
          updates.torrentSeededSeconds = payload.torrent_seeded_seconds;
        }
      }
      const observedDownloadedBytes = Math.max(
        current.downloadedBytes ?? 0,
        payload.downloaded_bytes ?? 0
      );
      // Older lifecycles may have persisted yt-dlp's temporary fragmented
      // estimate (often 1 KiB). Once actual bytes exceed it and the current
      // progress frame has no reliable total, discard that stale denominator
      // so it cannot survive a pause, queue transition, or app restart.
      if (payload.total_bytes == null && hasStaleTemporaryMediaEstimate({
        isMedia: current.isMedia,
        downloadedBytes: observedDownloadedBytes,
        totalBytes: current.totalBytes,
        totalIsEstimate: current.totalIsEstimate,
        size: current.size
      })) {
        updates.size = undefined;
        updates.totalBytes = undefined;
        updates.totalIsEstimate = undefined;
      }
      if (Object.keys(updates).length > 0) {
        mainStore.updateDownload(payload.id, updates);
      }
    }),
    listen('download-state', (event) => {
      const payload = event.payload;
      const mainStore = useDownloadStore.getState();
      const current = mainStore.downloads.find(d => d.id === payload.id);
      if (!current) {
        useDownloadProgressStore.getState().clearDownloadProgress(payload.id);
        return;
      }
      const status = payload.status as DownloadStatus;
      if (status !== 'moving') {
        useDownloadProgressStore.getState().clearMoveProgress(payload.id);
      }

      // resume_download queues the row before the backend can emit its new
      // active state. Paused events already emitted by the old lifecycle may
      // arrive in that gap, and more than one can be queued before the new
      // lifecycle reports its state. Do not let any of them overwrite the
      // queued transition; otherwise a duplicate stale event can leave the
      // row visibly paused and make dispatch reject it before IPC.
      if (status === 'paused' &&
          current.status === 'queued' &&
          downloadControlIntentFor(payload.id) === 'resume' &&
          !payload.error) {
        // Keep the resume intent until an active or terminal event proves
        // that the new lifecycle has taken over. An explicit pause replaces
        // this intent in pauseDownload, so a genuine user pause is still
        // applied while the transition is in flight.
        return;
      }
      if (status === 'downloading' || status === 'processing' || status === 'moving' ||
          status === 'verifying' || status === 'seeding' || status === 'waitingToSeed' ||
          status === 'completed' || status === 'failed') {
        clearDownloadControlIntent(payload.id, 'resume');
      }
      if (status === 'paused') {
        clearDownloadControlIntent(payload.id, 'pause');
        if (payload.error) clearDownloadControlIntent(payload.id, 'resume');
      }

      // Prevent stale lifecycle events from moving a paused row back into an
      // active state. A pause request can finish before one already-emitted
      // worker event reaches the frontend. Resume paths set the row to queued
      // before asking the backend to resume, so an active event arriving while
      // the row is still paused cannot represent a new lifecycle.
      if ((current.status === 'completed' || current.status === 'failed') &&
          status !== current.status && status !== 'moving') {
        return;
      }
      if (current.status === 'paused' &&
          status !== 'paused' &&
          status !== 'completed' &&
          status !== 'failed' &&
          status !== 'moving') {
        return;
      }
      if (current.status === 'seeding' &&
          status !== 'seeding' &&
          status !== 'waitingToSeed' &&
          status !== 'paused' &&
          status !== 'completed' &&
          status !== 'failed' &&
          status !== 'moving') {
        return;
      }

      const progress = useDownloadProgressStore.getState().progressMap[payload.id];
      if (['queued', 'retrying', 'completed', 'failed', 'paused', 'waitingToSeed'].includes(status)) {
        useDownloadProgressStore.getState().clearDownloadProgress(payload.id);
      }
      const moveRestoreStatus = status === 'moving'
        ? current.status === 'paused' || current.status === 'completed' || current.status === 'failed'
          ? current.status
          : current.torrentMoveRestoreStatus
        : undefined;
      const updates: Partial<DownloadItem> = {
        status,
        torrentMoveRestoreStatus: moveRestoreStatus,
        ...(progress ? {
          fraction: progress.fraction,
          ...(progress.downloaded_bytes != null
            ? { downloadedBytes: progress.downloaded_bytes }
            : {}),
          ...(progress.total_bytes != null
            ? { totalBytes: progress.total_bytes }
            : {}),
          ...(progress.total_is_estimate != null
            ? { totalIsEstimate: progress.total_is_estimate }
            : {})
        } : {}),
        ...(payload.error ? { lastError: payload.error } : {}),
        ...((status === 'downloading' || status === 'verifying' || status === 'retrying')
          ? { lastTry: new Date().toISOString() }
          : {})
      };
      if (payload.torrentSeedRemaining != null) {
        updates.torrentSeedRemaining = payload.torrentSeedRemaining;
      } else if (status === 'seeding' || status === 'completed' || status === 'failed') {
        updates.torrentSeedRemaining = undefined;
      }
      if (!payload.error && status !== 'failed' && status !== 'retrying') {
        updates.lastError = undefined;
      }
      if (payload.fileName && payload.fileName !== current.fileName) {
        updates.fileName = payload.fileName;
        updates.category = categoryForFileName(payload.fileName);
      }
      if (status !== 'downloading' && status !== 'verifying') {
        updates.speed = '-';
        updates.eta = '-';
      }
      if (
        current.torrentVerifyOnly === true &&
        ['ready', 'staged', 'paused', 'completed', 'failed'].includes(status)
      ) {
        // Verification is a maintenance lifecycle layered over the existing
        // row. Clear its markers once Aria2 has reached the restored terminal
        // state so restart cannot replay verification indefinitely.
        updates.torrentVerifyOnly = undefined;
        updates.torrentVerifyRestoreStatus = undefined;
      }
      mainStore.updateDownload(payload.id, updates);

      if (status === 'completed' || status === 'failed' || status === 'paused' || status === 'seeding' || status === 'waitingToSeed') {
        useDownloadStore.setState(state => ({
          pendingOrder: state.pendingOrder.filter(id => id !== payload.id)
        }));
      } else if (status === 'queued') {
        useDownloadStore.setState(state => state.pendingOrder.includes(payload.id)
          ? {}
          : { pendingOrder: [...state.pendingOrder, payload.id] });
      }

      if (status === 'queued' || status === 'downloading' || status === 'processing' || status === 'verifying' || status === 'seeding' || status === 'waitingToSeed' || status === 'retrying') {
        mainStore.registerBackendIds([payload.id]);
      } else if (status === 'completed' || status === 'failed') {
        mainStore.unregisterBackendIds([payload.id]);
      }
    }),
    listen('torrent-move-progress', (event) => {
      const payload = event.payload;
      const current = useDownloadStore.getState().downloads.find(d => d.id === payload.id);
      if (!current || current.status !== 'moving') {
        useDownloadProgressStore.getState().clearMoveProgress(payload.id);
        return;
      }
      if (Number.isFinite(payload.fraction) && payload.fraction >= 0 && payload.fraction <= 1) {
        useDownloadProgressStore.getState().setMoveProgress(payload.id, payload.fraction);
      }
    }),
    listen('tray-action', (event) => {
      const mainStore = useDownloadStore.getState();
      if (event.payload === 'pause-all') {
        void mainStore.pauseAll();
      } else if (event.payload === 'resume-all') {
        void mainStore.startAll();
      }
    }),
  ]);

  const failedRegistration = registrations.find(
    (registration): registration is PromiseRejectedResult => registration.status === 'rejected'
  );
  if (failedRegistration) {
    for (const registration of registrations) {
      if (registration.status === 'fulfilled') registration.value();
    }
    throw failedRegistration.reason;
  }

  const [progress, state, moveProgress, tray] = registrations as [
    PromiseFulfilledResult<UnlistenFn>,
    PromiseFulfilledResult<UnlistenFn>,
    PromiseFulfilledResult<UnlistenFn>,
    PromiseFulfilledResult<UnlistenFn>,
  ];
  unlistenProgress = progress.value;
  unlistenState = state.value;
  unlistenMoveProgress = moveProgress.value;
  unlistenTray = tray.value;
};

export async function initDownloadListener(): Promise<() => void> {
  listenerConsumers += 1;
  if (!listenerSetup) {
    listenerSetup = startDownloadListeners().catch(error => {
      disposeDownloadListeners();
      throw error;
    });
  }

  try {
    await listenerSetup;
  } catch (error) {
    listenerConsumers -= 1;
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    listenerConsumers -= 1;
    if (listenerConsumers === 0) disposeDownloadListeners();
  };
}

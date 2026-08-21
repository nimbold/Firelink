import type { UnlistenFn } from '@tauri-apps/api/event';
import type { DownloadStatus } from '../bindings/DownloadStatus';
import { listenEvent as listen } from '../ipc';
import type { DownloadItem } from '../bindings/DownloadItem';
import type { DownloadProgressEvent } from '../bindings/DownloadProgressEvent';
import { categoryForDownload } from '../utils/downloads';
import { useDownloadProgressStore } from './downloadProgressStore';

import {
  clearDownloadControlIntent,
  commitDownloadState,
  currentDownloadLifecycleGeneration,
  downloadControlIntentFor,
  hasStaleTemporaryMediaEstimate,
  useDownloadStore
} from './useDownloadStore';

export { useDownloadProgressStore } from './downloadProgressStore';

let unlistenProgress: UnlistenFn | null = null;
let unlistenAllocation: UnlistenFn | null = null;
let unlistenState: UnlistenFn | null = null;
let unlistenMoveProgress: UnlistenFn | null = null;
let unlistenTray: UnlistenFn | null = null;
let listenerSetup: Promise<void> | null = null;
let listenerConsumers = 0;

type ProgressFields = {
  fraction?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  totalIsEstimate?: boolean;
};

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const sanitizeProgressPayload = (
  payload: DownloadProgressEvent,
): DownloadProgressEvent | null => {
  if (typeof payload.fraction !== 'number'
    || !Number.isFinite(payload.fraction)
    || payload.fraction < 0
    || payload.fraction > 1) {
    return null;
  }

  const sanitized = { ...payload };
  const numericFields: Array<keyof DownloadProgressEvent> = [
    'downloaded_bytes',
    'total_bytes',
    'active_connections',
    'requested_connections',
    'effective_connections',
    'uploaded_bytes',
    'num_seeders',
    'torrent_seeded_seconds',
  ];
  for (const field of numericFields) {
    if (sanitized[field] !== undefined && !finiteNonNegative(sanitized[field])) {
      delete sanitized[field];
    }
  }
  if (sanitized.total_is_estimate !== undefined
    && typeof sanitized.total_is_estimate !== 'boolean') {
    delete sanitized.total_is_estimate;
  }
  return sanitized;
};

const progressFields = (source: unknown): ProgressFields => {
  if (!source || typeof source !== 'object') return {};
  const value = source as Record<string, unknown>;
  const downloadedBytes = value.downloadedBytes ?? value.downloaded_bytes;
  const totalBytes = value.totalBytes ?? value.total_bytes;
  const totalIsEstimate = value.totalIsEstimate ?? value.total_is_estimate;
  return {
    ...(finiteNonNegative(value.fraction) ? { fraction: value.fraction } : {}),
    ...(finiteNonNegative(downloadedBytes) ? { downloadedBytes } : {}),
    ...(finiteNonNegative(totalBytes) ? { totalBytes } : {}),
    ...(typeof totalIsEstimate === 'boolean' ? { totalIsEstimate } : {})
  };
};

const mergeTerminalProgress = (
  current: DownloadItem,
  status: DownloadStatus,
  nativeSnapshot: unknown,
  retainedSnapshot: unknown,
  liveSnapshot: unknown
): ProgressFields => {
  const ordered = [nativeSnapshot, retainedSnapshot, liveSnapshot]
    .map(progressFields);
  const row = progressFields({
    fraction: current.fraction,
    downloadedBytes: current.downloadedBytes,
    totalBytes: current.totalBytes,
    totalIsEstimate: current.totalIsEstimate
  });
  const all = [...ordered, row];
  const downloadedCandidates = all
    .map(snapshot => snapshot.downloadedBytes)
    .filter((value): value is number => finiteNonNegative(value));
  const downloadedBytes = downloadedCandidates.length > 0
    ? Math.max(...downloadedCandidates)
    : undefined;

  const exactTotals = all
    .filter(snapshot => snapshot.totalIsEstimate === false && finiteNonNegative(snapshot.totalBytes))
    .map(snapshot => snapshot.totalBytes!);
  const anyTotals = all
    .map(snapshot => snapshot.totalBytes)
    .filter((value): value is number => finiteNonNegative(value));
  const totalBytes = exactTotals[0] ?? anyTotals[0];
  const fractions = all
    .map(snapshot => snapshot.fraction)
    .filter((value): value is number => finiteNonNegative(value));
  if (downloadedBytes !== undefined && totalBytes !== undefined && totalBytes > 0) {
    fractions.push(Math.min(downloadedBytes, totalBytes) / totalBytes);
  }
  if (status === 'completed') fractions.push(1);
  const fraction = fractions.length > 0
    ? Math.min(1, Math.max(0, Math.max(...fractions)))
    : undefined;
  return {
    ...(fraction !== undefined ? { fraction } : {}),
    ...(downloadedBytes !== undefined ? { downloadedBytes } : {}),
    ...(totalBytes !== undefined ? { totalBytes } : {}),
    ...(exactTotals.length > 0
      ? { totalIsEstimate: false }
      : ordered.find(snapshot => snapshot.totalIsEstimate !== undefined)?.totalIsEstimate !== undefined
        ? { totalIsEstimate: ordered.find(snapshot => snapshot.totalIsEstimate !== undefined)!.totalIsEstimate }
        : {})
  };
};

const disposeDownloadListeners = () => {
  unlistenProgress?.();
  unlistenProgress = null;
  unlistenAllocation?.();
  unlistenAllocation = null;
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
        useDownloadProgressStore.getState().resetDownloadProgress(payload.id);
        return;
      }
      // A sidecar can flush one last progress chunk after a pause, failure,
      // completion, or lifecycle reset. Do not let that stale chunk repopulate
      // the live progress map or overwrite a later lifecycle's first frame.
      if (!['downloading', 'processing', 'verifying', 'seeding'].includes(current.status)) {
        useDownloadProgressStore.getState().clearDownloadProgress(payload.id);
        return;
      }
      const sanitizedPayload = sanitizeProgressPayload(payload);
      if (!sanitizedPayload) {
        return;
      }
      useDownloadProgressStore.getState().updateDownloadProgress(payload.id, sanitizedPayload);
      const shouldUpdateSize = Boolean(sanitizedPayload.size && (!current.isMedia || sanitizedPayload.size_is_final));
      const updates: Partial<DownloadItem> = {};
      if (current.status === 'downloading' || current.status === 'processing' || current.status === 'verifying' || current.status === 'seeding') {
        updates.fraction = sanitizedPayload.fraction;
        updates.speed = current.status === 'seeding'
          ? sanitizedPayload.upload_speed ?? '-'
          : sanitizedPayload.speed;
        updates.eta = current.status === 'seeding' ? '-' : sanitizedPayload.eta;
      }
      if (shouldUpdateSize && current.size !== sanitizedPayload.size) {
        updates.size = sanitizedPayload.size!;
      }
      if (sanitizedPayload.downloaded_bytes !== null && sanitizedPayload.downloaded_bytes !== undefined) {
        updates.downloadedBytes = sanitizedPayload.downloaded_bytes;
      }
      if (sanitizedPayload.total_bytes !== null && sanitizedPayload.total_bytes !== undefined) {
        updates.totalBytes = sanitizedPayload.total_bytes;
      }
      if (sanitizedPayload.total_is_estimate !== null && sanitizedPayload.total_is_estimate !== undefined) {
        updates.totalIsEstimate = sanitizedPayload.total_is_estimate;
      }
      if (current.isTorrent) {
        if (sanitizedPayload.uploaded_bytes !== null
            && sanitizedPayload.uploaded_bytes !== undefined
            && Number.isSafeInteger(sanitizedPayload.uploaded_bytes)
            && sanitizedPayload.uploaded_bytes >= 0) {
          updates.torrentUploadedBytes = sanitizedPayload.uploaded_bytes;
        }
        if (sanitizedPayload.torrent_seeded_seconds !== null
            && sanitizedPayload.torrent_seeded_seconds !== undefined
            && Number.isSafeInteger(sanitizedPayload.torrent_seeded_seconds)
            && sanitizedPayload.torrent_seeded_seconds >= 0) {
          updates.torrentSeededSeconds = sanitizedPayload.torrent_seeded_seconds;
        }
      }
      const observedDownloadedBytes = Math.max(
        current.downloadedBytes ?? 0,
        sanitizedPayload.downloaded_bytes ?? 0
      );
      // Older lifecycles may have persisted yt-dlp's temporary fragmented
      // estimate (often 1 KiB). Once actual bytes exceed it and the current
      // progress frame has no reliable total, discard that stale denominator
      // so it cannot survive a pause, queue transition, or app restart.
      if (sanitizedPayload.total_bytes == null && hasStaleTemporaryMediaEstimate({
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
    listen('download-allocation', (event) => {
      const payload = event.payload;
      const mainStore = useDownloadStore.getState();
      const current = mainStore.downloads.find(download => download.id === payload.id);
      if (!current) {
        // Keep a validated native marker until persisted startup state or a
        // just-admitted row is projected. Dropping it here makes allocation
        // invisible when the event wins the hydration race.
        mainStore.setAllocationPending(
          payload.id,
          payload.pending,
          payload.lifecycleGeneration
        );
        return;
      }
      // Allocation events are native lifecycle markers. A late marker from an
      // older GID/queue lifecycle must never hide the current lifecycle's
      // phase or clear its pending state.
      if (payload.lifecycleGeneration !== currentDownloadLifecycleGeneration(payload.id)) {
        return;
      }
      mainStore.setAllocationPending(
        payload.id,
        payload.pending,
        payload.lifecycleGeneration
      );
    }),
    listen('download-state', async (event) => {
      const payload = event.payload;
      const mainStore = useDownloadStore.getState();
      const current = mainStore.downloads.find(d => d.id === payload.id);
      if (!current) {
        useDownloadProgressStore.getState().resetDownloadProgress(payload.id);
        return;
      }
      const status = payload.status as DownloadStatus;
      // A move terminal event carries its authoritative destination. Older
      // lifecycle events do not, so they must not overwrite an active move or
      // clear its progress while the native relocation still owns the row.
      if (current.status === 'moving' && status !== 'moving' && payload.destination == null) {
        return;
      }
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
          status !== 'verifying' &&
          status !== 'paused' &&
          status !== 'completed' &&
          status !== 'failed' &&
          status !== 'moving') {
        return;
      }

      const progressState = useDownloadProgressStore.getState();
      const liveProgress = progressState.progressMap[payload.id];
      const retainedProgress = progressState.retainedProgressMap[payload.id];
      const isTerminalOrPaused = ['completed', 'failed', 'paused', 'retrying', 'waitingToSeed'].includes(status);
      const terminalProgress = isTerminalOrPaused
        ? mergeTerminalProgress(
            current,
            status,
            payload.progress,
            retainedProgress,
            liveProgress
          )
        : undefined;
      if (status === 'queued') {
        // A queued event can represent either a genuinely new admission or a
        // same-GID resume of a paused Aria2 transfer. Lifecycle-changing
        // callers reset the retained snapshot before admission; this event
        // only ends the old live frame so a same-GID resume keeps its bytes.
        useDownloadProgressStore.getState().clearDownloadProgress(payload.id);
      } else if (['retrying', 'completed', 'failed', 'paused', 'waitingToSeed'].includes(status)) {
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
        ...(terminalProgress ? {
          ...(terminalProgress.fraction !== undefined
            ? { fraction: terminalProgress.fraction }
            : {}),
          ...(terminalProgress.downloadedBytes !== undefined
            ? { downloadedBytes: terminalProgress.downloadedBytes }
            : {}),
          ...(terminalProgress.totalBytes !== undefined
            ? { totalBytes: terminalProgress.totalBytes }
            : {}),
          ...(terminalProgress.totalIsEstimate !== undefined
            ? { totalIsEstimate: terminalProgress.totalIsEstimate }
            : {})
        } : {}),
        ...(payload.error ? {
          lastError: payload.error,
          lastErrorKind: payload.errorKind,
          lastResolverFallback: payload.resolverFallback,
        } : {}),
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
        updates.lastErrorKind = undefined;
        updates.lastResolverFallback = undefined;
      }
      if (payload.fileName && payload.fileName !== current.fileName) {
        updates.fileName = payload.fileName;
        updates.category = categoryForDownload(
          payload.fileName,
          current.isTorrent === true,
          current.category
        );
      }
      if (payload.destination && payload.destination !== current.destination) {
        updates.destination = payload.destination;
      }
      if (status !== 'downloading' && status !== 'verifying') {
        updates.speed = '-';
        updates.eta = '-';
      }
      const verificationRestoreStatus = current.torrentVerifyRestoreStatus;
      const verificationNeedsAcknowledgement = current.torrentVerifyOnly === true &&
        typeof verificationRestoreStatus === 'string' &&
        ['ready', 'staged', 'paused', 'completed', 'failed'].includes(status);
      mainStore.updateDownload(payload.id, updates);

      if (status === 'queued') {
        useDownloadStore.setState(state => state.pendingOrder.includes(payload.id)
          ? {}
          : { pendingOrder: [...state.pendingOrder, payload.id] });
      } else {
        useDownloadStore.setState(state => ({
          pendingOrder: state.pendingOrder.filter(id => id !== payload.id)
        }));
      }

      if (status === 'queued' || status === 'downloading' || status === 'processing' || status === 'verifying' || status === 'seeding' || status === 'waitingToSeed' || status === 'retrying') {
        mainStore.registerBackendIds([payload.id]);
      } else if (status === 'completed' || status === 'failed') {
        mainStore.unregisterBackendIds([payload.id]);
      }

      if (verificationNeedsAcknowledgement) {
        try {
          // The native persistence marker is intentionally acknowledged in a
          // separate durable snapshot before the renderer clears its copy.
          // Coalescing both updates into one snapshot would let the native
          // marker protect an already-finished verification forever.
          await commitDownloadState();
          const acknowledged = useDownloadStore.getState().downloads.find(
            download => download.id === payload.id
          );
          if (
            !acknowledged ||
            acknowledged.status !== status ||
            acknowledged.torrentVerifyOnly !== true ||
            acknowledged.torrentVerifyRestoreStatus !== verificationRestoreStatus
          ) {
            return;
          }
          mainStore.updateDownload(payload.id, {
            torrentVerifyOnly: undefined,
            torrentVerifyRestoreStatus: undefined
          });
          await commitDownloadState();
        } catch (error) {
          // Keep the marker in the durable/native path when the acknowledgement
          // cannot be committed. Restarting verification is safer than losing
          // the integrity-maintenance lifecycle.
          console.error('Failed to acknowledge Torrent verification:', error);
        }
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

  const [progress, allocation, state, moveProgress, tray] = registrations as [
    PromiseFulfilledResult<UnlistenFn>,
    PromiseFulfilledResult<UnlistenFn>,
    PromiseFulfilledResult<UnlistenFn>,
    PromiseFulfilledResult<UnlistenFn>,
    PromiseFulfilledResult<UnlistenFn>,
  ];
  unlistenProgress = progress.value;
  unlistenAllocation = allocation.value;
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

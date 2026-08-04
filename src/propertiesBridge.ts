import { emitTo } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { DownloadProgressEvent } from './bindings/DownloadProgressEvent';
import type { DownloadStatus } from './bindings/DownloadStatus';
import type { DownloadItem } from './store/useDownloadStore';
import { canPauseDownload } from './utils/downloadActions';
import type { DocumentAppearance } from './utils/documentAppearance';
import { invokeCommand as invoke } from './ipc';

export const PROPERTIES_WINDOW_READY = 'properties-window-ready' as const;
export const PROPERTIES_WINDOW_SNAPSHOT = 'properties-window-snapshot' as const;
export const PROPERTIES_WINDOW_ACTION_REQUEST = 'properties-window-action-request' as const;
export const PROPERTIES_WINDOW_ACTION_RESULT = 'properties-window-action-result' as const;
export const PROPERTIES_WINDOW_REMOVED = 'properties-window-removed' as const;
export const PROPERTIES_WINDOW_CLOSED = 'properties-window-closed' as const;

const PROPERTIES_SNAPSHOT_KEYS = [
  'id',
  'url',
  'fileName',
  'status',
  'fraction',
  'speed',
  'eta',
  'size',
  'downloadedBytes',
  'totalBytes',
  'totalIsEstimate',
  'category',
  'dateAdded',
  'resumable',
  'connections',
  'speedLimit',
  'checksum',
  'destination',
  'isMedia',
  'mediaFormatSelector',
  'mediaQuality',
  'queueId',
  'queuePosition',
  'hasBeenDispatched',
  'lastError',
  'lastTry',
  'isTorrent',
  'torrentFileIndices',
  'torrentInfoHash',
  'torrentSeedTime',
  'torrentSeedRatio',
  'torrentSeedRemaining',
  'torrentUploadedBytes',
  'torrentSeededSeconds',
  'torrentRelocationCheckPending',
  'torrentMoveDestination',
  'torrentMoveRestoreStatus',
  'torrentWebSeeds',
  'torrentUploadLimit',
  'torrentMaxPeers',
  'torrentPeerSpeedLimit',
  'torrentCheckIntegrity',
  'torrentTrackers',
  'torrentExcludeTrackers',
  'torrentTrackerConnectTimeout',
  'torrentTrackerTimeout',
  'torrentTrackerInterval',
  'torrentStopTimeout',
  'torrentPrioritizePiece',
  'torrentRemoveUnselectedFile',
  'torrentEncryptionPolicy',
  'torrentFileAllocation',
  'torrentVerifyOnly',
  'torrentVerifyRestoreStatus',
] as const satisfies readonly (keyof DownloadItem)[];

export const isExpectedPropertiesDiagnosticUnavailable = (error: unknown): boolean => {
  const message = (error instanceof Error ? error.message : String(error)).trim().toLowerCase();
  if (message.startsWith('torrent lifecycle changed while reading ')) return true;
  return [
    'torrent peer diagnostics are unavailable for this lifecycle',
    'torrent availability is unavailable for this lifecycle',
    'live torrent file progress is unavailable',
    'live torrent piece progress is unavailable',
    'active torrent transfer has no gid',
    'active torrent transfer has no current gid mapping',
    'active torrent transfer has a stale control epoch',
    'active torrent has no gid',
    'active torrent has no current gid mapping',
    'active torrent has a stale control epoch',
  ].includes(message);
};

type SafePropertiesFields = Pick<DownloadItem, (typeof PROPERTIES_SNAPSHOT_KEYS)[number]>;

export type PropertiesSnapshot = SafePropertiesFields & {
  appearance: DocumentAppearance;
  activeConnections?: number;
  requestedConnections?: number;
  uploadSpeed?: string;
  torrentSeeders?: number;
  moveProgress?: number;
  hasPassword: boolean;
  hasCookies: boolean;
  hasHeaders: boolean;
  hasUsername: boolean;
  hasMirrors: boolean;
};

export type SecretPatch =
  | { kind: 'unchanged' }
  | { kind: 'replace'; value: string }
  | { kind: 'clear' };

export type PropertiesPatch = Partial<Omit<DownloadItem, 'password' | 'cookies' | 'headers' | 'username'>> & {
  username?: SecretPatch;
  password?: SecretPatch;
  cookies?: SecretPatch;
  headers?: SecretPatch;
};

export type PropertiesAction =
  | 'apply-properties'
  | 'pause-resume'
  | 'verify-torrent'
  | 'set-download-limit'
  | 'set-torrent-upload-limit'
  | 'set-torrent-peer-options';

export type PropertiesLifecycleAction = 'pause' | 'resume' | 'start' | 'retry';

export const getPropertiesLifecycleAction = (
  status: DownloadStatus,
): PropertiesLifecycleAction | null => {
  if (status === 'ready' || status === 'staged') return 'start';
  if (canPauseDownload(status)) return 'pause';
  if (status === 'paused') return 'resume';
  if (status === 'failed') return 'retry';
  return null;
};

export const beginExclusivePropertiesAction = (
  inFlight: Set<string>,
  key: string,
): (() => void) => {
  if (inFlight.has(key)) {
    throw new Error('Another Properties action is still in progress');
  }
  inFlight.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight.delete(key);
  };
};

export type PropertiesWindowReady = {
  windowLabel: string;
  downloadId: string;
  sessionId: string;
};

export type PropertiesActionRequest = {
  windowLabel: string;
  downloadId: string;
  sessionId: string;
  requestId: number;
  action: PropertiesAction;
  payload?: PropertiesPatch | { limit: string | null } | { maxPeers: string | null; peerSpeedLimit: string | null };
};

export type PropertiesActionResult = {
  windowLabel: string;
  downloadId: string;
  sessionId: string;
  requestId: number;
  ok: boolean;
  error?: string;
};

export type PropertiesSnapshotEvent = {
  windowLabel: string;
  downloadId: string;
  sessionId: string;
  revision: number;
  snapshot: PropertiesSnapshot;
};

export type PropertiesWindowRegistration = {
  downloadId: string;
  sessionId: string;
  latestRequestId: number;
};

export const shouldAcceptPropertiesActionRequest = (
  registration: PropertiesWindowRegistration | undefined,
  request: Pick<PropertiesActionRequest, 'downloadId' | 'sessionId' | 'requestId'>,
): boolean => registration !== undefined
  && registration.downloadId === request.downloadId
  && registration.sessionId === request.sessionId
  && Number.isSafeInteger(request.requestId)
  && request.requestId > registration.latestRequestId;

export const enqueuePropertiesAction = (
  chains: Map<string, Promise<void>>,
  key: string,
  action: () => Promise<void>,
): Promise<void> => {
  const previous = chains.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(action);
  let tracked: Promise<void>;
  tracked = operation.finally(() => {
    if (chains.get(key) === tracked) chains.delete(key);
  });
  chains.set(key, tracked);
  return tracked;
};

const copyWithoutSecrets = (
  item: DownloadItem,
  appearance: DocumentAppearance,
  live?: {
    progress?: DownloadProgressEvent;
    moveProgress?: number;
  },
): PropertiesSnapshot => {
  const safeItem = Object.fromEntries(
    PROPERTIES_SNAPSHOT_KEYS.flatMap(key => (
      Object.prototype.hasOwnProperty.call(item, key) ? [[key, item[key]]] : []
    )),
  ) as SafePropertiesFields;
  return {
    ...safeItem,
    appearance,
    ...(live?.progress ? {
      fraction: live.progress.fraction,
      speed: item.status === 'seeding'
        ? live.progress.upload_speed ?? live.progress.speed
        : live.progress.speed,
      eta: item.status === 'seeding' ? '-' : live.progress.eta,
      ...(live.progress.size ? { size: live.progress.size } : {}),
      ...(live.progress.downloaded_bytes !== undefined
        ? { downloadedBytes: live.progress.downloaded_bytes }
        : {}),
      ...(live.progress.total_bytes !== undefined
        ? { totalBytes: live.progress.total_bytes }
        : {}),
      ...(live.progress.total_is_estimate !== undefined
        ? { totalIsEstimate: live.progress.total_is_estimate }
        : {}),
      ...(live.progress.active_connections !== undefined
        ? { activeConnections: live.progress.active_connections }
        : {}),
      ...(live.progress.requested_connections !== undefined
        ? { requestedConnections: live.progress.requested_connections }
        : {}),
      ...(live.progress.uploaded_bytes !== undefined
        ? { torrentUploadedBytes: live.progress.uploaded_bytes }
        : {}),
      ...(live.progress.upload_speed !== undefined
        ? { uploadSpeed: live.progress.upload_speed }
        : {}),
      ...(live.progress.num_seeders !== undefined
        ? { torrentSeeders: live.progress.num_seeders }
        : {}),
      ...(live.progress.torrent_seeded_seconds !== undefined
        ? { torrentSeededSeconds: live.progress.torrent_seeded_seconds }
        : {}),
    } : {}),
    ...(live?.moveProgress !== undefined ? { moveProgress: live.moveProgress } : {}),
    hasPassword: Boolean(item.password),
    hasCookies: Boolean(item.cookies),
    hasHeaders: Boolean(item.headers),
    hasUsername: Boolean(item.username),
    hasMirrors: Boolean(item.mirrors),
  };
};

export const sanitizePropertiesSnapshot = copyWithoutSecrets;

export const createFrameCoalescer = (
  callback: (key: string) => void,
  requestFrame: (callback: FrameRequestCallback) => number,
  cancelFrame: (handle: number) => void,
) => {
  const pending = new Map<string, number>();
  return {
    schedule(key: string) {
      if (pending.has(key)) return;
      const handle = requestFrame(() => {
        pending.delete(key);
        callback(key);
      });
      pending.set(key, handle);
    },
    cancel(key: string) {
      const handle = pending.get(key);
      if (handle === undefined) return;
      pending.delete(key);
      cancelFrame(handle);
    },
    cancelAll() {
      for (const handle of pending.values()) cancelFrame(handle);
      pending.clear();
    },
  };
};

// Tauri listener registration is asynchronous. React StrictMode can unmount
// an effect before `listen()` resolves; in that case assigning the late
// unlisten callback after cleanup leaks a second bridge listener. A leaked
// Properties host can process one click twice, observe the queued state from
// the first action, and turn the intended resume into an immediate pause.
export const attachAsyncPropertiesListener = <T extends UnlistenFn>(
  listener: Promise<T>,
  isDisposed: () => boolean,
  assign: (unlisten: T) => void,
): void => {
  void listener.then(unlisten => {
    if (isDisposed()) {
      unlisten();
      return;
    }
    assign(unlisten);
  }).catch(() => undefined);
};

export const openPropertiesWindow = (downloadId: string): Promise<string> =>
  invoke('open_download_properties_window', { id: downloadId });

export const sendPropertiesReady = (sessionId: string): Promise<void> =>
  invoke('properties_window_send_ready', { sessionId });

export const sendPropertiesActionRequest = (payload: PropertiesActionRequest): Promise<void> =>
  invoke('properties_window_send_action', {
    sessionId: payload.sessionId,
    requestId: payload.requestId,
    action: payload.action,
    payload: payload.payload,
  });

export const sendPropertiesSnapshot = (windowLabel: string, payload: PropertiesSnapshotEvent): Promise<void> =>
  emitTo(windowLabel, PROPERTIES_WINDOW_SNAPSHOT, payload);

export const sendPropertiesActionResult = (windowLabel: string, payload: PropertiesActionResult): Promise<void> =>
  emitTo(windowLabel, PROPERTIES_WINDOW_ACTION_RESULT, payload);

export const sendPropertiesRemoved = (windowLabel: string, downloadId: string): Promise<void> =>
  emitTo(windowLabel, PROPERTIES_WINDOW_REMOVED, { windowLabel, downloadId });

export const applySecretPatch = (
  patch: unknown,
  existing: string | undefined,
): string | undefined => {
  if (patch === undefined) return existing;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Invalid secret patch');
  }
  const candidate = patch as Record<string, unknown>;
  switch (candidate.kind) {
    case 'unchanged':
      return existing;
    case 'clear':
      return undefined;
    case 'replace':
      if (typeof candidate.value !== 'string') throw new Error('Invalid secret value');
      return candidate.value;
    default:
      throw new Error('Invalid secret patch');
  }
};

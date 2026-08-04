import { create } from 'zustand';
import { info } from '../utils/logger';
import { invokeCommand as invoke } from '../ipc';

import type { DownloadItem } from '../bindings/DownloadItem';
import type { DownloadStatus } from '../bindings/DownloadStatus';
import type { ExtensionDownload } from '../bindings/ExtensionDownload';
import type { ExtensionCookieScope } from '../bindings/ExtensionCookieScope';
import type { Queue } from '../bindings/Queue';
import { useSettingsStore } from './useSettingsStore';
import { useDownloadProgressStore } from './downloadProgressStore';
import { canonicalizeDownloadFileName, categoryForFileName, isActiveDownloadStatus, isTransferActiveStatus, isValidTorrentExcludeTrackerList, isValidTorrentTrackerList, MAX_TORRENT_STOP_TIMEOUT, normalizeSpeedLimitForBackend, normalizeTorrentEncryptionPolicy, normalizeTorrentFileAllocation, normalizeTorrentPrioritizePiece, normalizeTorrentTrackerInterval, normalizeTorrentTrackerTimeout, redactDownloadForPersistence, resolveDownloadConnections } from '../utils/downloads';
import {
  resolveCategoryDestination
} from '../utils/downloadLocations';
import { canPauseDownload, canStartDownload } from '../utils/downloadActions';
import { updateDockBadge } from '../utils/dockBadge';
import {
  moveSelectedBlockToIndex,
  targetIndexForDesiredOrder
} from '../utils/queueOrdering';
import i18n from '../i18n';

export type { DownloadCategory } from '../utils/downloads';

const backendDispatchPromises = new Map<string, Promise<boolean>>();
const downloadLifecycleGenerations = new Map<string, bigint>();
const queueReorderPromises = new Map<string, Promise<void>>();
const queueStartPromises = new Map<string, Promise<string[]>>();
const queueControlGenerations = new Map<string, number>();
let queueConfigurationQueue: Promise<void> = Promise.resolve();
type DownloadLifecycleOperation = {
  kind: string;
  promise: Promise<unknown>;
};
const downloadLifecycleOperations = new Map<string, DownloadLifecycleOperation>();
const preemptDispatch = ['dispatch'] as const;
const preemptStartSelected = ['dispatch', 'start-selected'] as const;
let pendingStartupResume: Promise<void> | null = null;

type DownloadControlIntent = 'pause' | 'resume';
const downloadControlIntents = new Map<string, DownloadControlIntent>();

export interface ResumeDownloadOptions {
  preserveQueuePosition?: boolean;
  forceRequeue?: boolean;
}

// State events do not carry a lifecycle generation. Keep the intent that
// initiated a control transition long enough for the listener to discard an
// already-emitted event from the previous transition.
export const setDownloadControlIntent = (id: string, intent: DownloadControlIntent): void => {
  downloadControlIntents.set(id, intent);
};

export const clearDownloadControlIntent = (id: string, intent?: DownloadControlIntent): void => {
  if (intent === undefined || downloadControlIntents.get(id) === intent) {
    downloadControlIntents.delete(id);
  }
};

export const downloadControlIntentFor = (id: string): DownloadControlIntent | undefined =>
  downloadControlIntents.get(id);

export const clearDownloadControlIntents = (): void => {
  downloadControlIntents.clear();
};

const runDownloadLifecycleOperation = <T>(
  id: string,
  kind: string,
  operation: () => Promise<T>,
  coalesce = true,
  preemptKinds: readonly string[] = []
): Promise<T> => {
  const current = downloadLifecycleOperations.get(id);
  if (coalesce && current?.kind === kind) {
    return current.promise as Promise<T>;
  }

  const operationPromise = current && !preemptKinds.includes(current.kind)
    ? current.promise.catch(() => undefined).then(operation)
    : operation();
  const trackedOperation = operationPromise.finally(() => {
    if (downloadLifecycleOperations.get(id)?.promise === trackedOperation) {
      downloadLifecycleOperations.delete(id);
    }
  });
  downloadLifecycleOperations.set(id, { kind, promise: trackedOperation });
  return trackedOperation;
};

const runDownloadLifecycleOperations = <T>(
  ids: string[],
  kind: string,
  operation: () => Promise<T>
): Promise<T> => {
  const orderedIds = [...new Set(ids)].sort();
  const runNext = (index: number): Promise<T> => {
    if (index === orderedIds.length) return operation();
    return runDownloadLifecycleOperation(
      orderedIds[index],
      kind,
      () => runNext(index + 1),
      false,
      preemptDispatch
    );
  };
  return runNext(0);
};

const waitForPendingStartupResume = async (): Promise<void> => {
  const pending = pendingStartupResume;
  if (pending) await pending.catch(() => undefined);
};

const currentQueueControlGeneration = (queueId: string): number =>
  queueControlGenerations.get(queueId) ?? 0;

const advanceQueueControlGeneration = (queueId: string): number => {
  const nextGeneration = currentQueueControlGeneration(queueId) + 1;
  queueControlGenerations.set(queueId, nextGeneration);
  return nextGeneration;
};

const isCurrentQueueControlGeneration = (queueId: string, generation: number): boolean =>
  currentQueueControlGeneration(queueId) === generation;

const comparableQueuePosition = (download: DownloadItem): number => {
  const position = download.queuePosition;
  return typeof position === 'number' && Number.isFinite(position) && position >= 0
    ? position
    : Number.MAX_SAFE_INTEGER;
};

const queuePositionComparator = (left: DownloadItem, right: DownloadItem): number =>
  comparableQueuePosition(left) - comparableQueuePosition(right) ||
  left.id.localeCompare(right.id);

const queueItemsForReordering = (downloads: DownloadItem[], queueId: string): DownloadItem[] =>
  downloads
    .filter(download =>
      (download.queueId || MAIN_QUEUE_ID) === queueId &&
      download.status !== 'completed' &&
      !(isActiveDownloadStatus(download.status) && download.status !== 'queued')
    )
    .sort(queuePositionComparator);

const activeQueueItems = (downloads: DownloadItem[], queueId: string): DownloadItem[] =>
  downloads
    .filter(download =>
      (download.queueId || MAIN_QUEUE_ID) === queueId &&
      download.status !== 'completed' &&
      isActiveDownloadStatus(download.status) &&
      download.status !== 'queued'
    )
    .sort(queuePositionComparator);

const applyQueueOrder = (
  downloads: DownloadItem[],
  queueId: string,
  pendingItems: DownloadItem[]
): DownloadItem[] => {
  const orderedItems = [...activeQueueItems(downloads, queueId), ...pendingItems];
  const positions = new Map(orderedItems.map((download, position) => [download.id, position]));
  return downloads.map(download => positions.has(download.id)
    ? { ...download, queuePosition: positions.get(download.id) }
    : download);
};

// Paused downloads remain part of the queue, but they must not be interleaved
// with the queue's non-paused rows. Keep the partition in the store so
// the table, persistence, and later queue operations all observe the same
// order instead of each deriving a different one.
const reorderQueueWithPausedAtEnd = (downloads: DownloadItem[], queueId: string): DownloadItem[] => {
  const queueItems = queueItemsForReordering(downloads, queueId);
  const nonPausedItems = queueItems.filter(download => download.status !== 'paused');
  const pausedItems = queueItems.filter(download => download.status === 'paused');
  return applyQueueOrder(downloads, queueId, [...nonPausedItems, ...pausedItems]);
};

const advanceDownloadLifecycle = (id: string): bigint => {
  const nextGeneration = (downloadLifecycleGenerations.get(id) ?? 0n) + 1n;
  downloadLifecycleGenerations.set(id, nextGeneration);
  return nextGeneration;
};

const currentDownloadLifecycle = (id: string): bigint =>
  downloadLifecycleGenerations.get(id) ?? 0n;

type DispatchInvalidation = {
  generation: bigint;
  pendingDispatch?: Promise<boolean>;
};

const invalidateDispatch = async (id: string): Promise<DispatchInvalidation> => {
  const generation = currentDownloadLifecycle(id);
  const nextGeneration = advanceDownloadLifecycle(id);
  try {
    await invoke('cancel_enqueue_generation', { id, generation: generation.toString() });
  } catch (error) {
    console.warn(`Failed to cancel stale backend enqueue for ${id}:`, error);
  }
  return { generation: nextGeneration, pendingDispatch: backendDispatchPromises.get(id) };
};

const invalidateAndWaitForDispatch = async (id: string): Promise<boolean> => {
  const { pendingDispatch } = await invalidateDispatch(id);
  if (!pendingDispatch) return false;
  await pendingDispatch;
  return true;
};

const isCurrentDownloadLifecycle = (id: string, generation: bigint): boolean =>
  currentDownloadLifecycle(id) === generation &&
  useDownloadStore.getState().downloads.some(download => download.id === id);

const removeStaleBackendDispatch = async (id: string): Promise<void> => {
  try {
    await invoke('remove_download', { id, deleteAssets: false });
  } catch (error) {
    // The original remove request may already have won this race. Either way,
    // never allow a stale enqueue to make the deleted row live again.
    console.warn(`Failed to remove stale backend dispatch for ${id}:`, error);
  }
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class SystemProxyResolutionError extends Error {
  constructor(reason: string) {
    super(`System proxy configuration could not be read: ${reason}. Choose No Proxy or try again.`);
    this.name = 'SystemProxyResolutionError';
  }
}

const isSystemProxyConfigurationError = (error: unknown): boolean =>
  error instanceof SystemProxyResolutionError;

const stripSensitiveMediaHeaders = (value: string | null | undefined): string =>
  (value || '')
    .split(/\r?\n/)
    .filter(line => {
      const separator = line.indexOf(':');
      if (separator < 0) return true;
      const name = line.slice(0, separator).trim().toLowerCase();
      return ![
        'authorization',
        'cookie',
        'cookie2',
        'proxy-authorization',
        'set-cookie',
        'set-cookie2'
      ].includes(name);
    })
    .join('\n')
    .trim();

const explicitSpeedLimitForDispatch = (itemSpeedLimit: string | undefined): string | null => {
  const explicitLimit = itemSpeedLimit?.trim();
  if (explicitLimit) {
    return normalizeSpeedLimitForBackend(explicitLimit) || (explicitLimit === '0' ? '0' : null);
  }
  return null;
};

const speedLimitForDispatch = (
  itemSpeedLimit: string | undefined,
  globalSpeedLimit: string,
  isMedia: boolean | undefined
): string | null => {
  // Older Add-window rows used "0" as the no-override sentinel. Media
  // downloads do not have aria2's daemon-wide cap, so preserve the intended
  // inherit-global behavior when dispatching those persisted rows.
  if (isMedia && itemSpeedLimit?.trim() === '0') {
    return normalizeSpeedLimitForBackend(globalSpeedLimit);
  }
  const explicitLimit = explicitSpeedLimitForDispatch(itemSpeedLimit);
  if (explicitLimit !== null || !isMedia) return explicitLimit;
  return normalizeSpeedLimitForBackend(globalSpeedLimit);
};

async function dispatchItemInternal(id: string, proxyOverride?: string | null): Promise<boolean> {
  await waitForPendingStartupResume();
  if (backendDispatchPromises.has(id)) return backendDispatchPromises.get(id)!;

  const promise = (async () => {
    let lifecycleGeneration: bigint | null = null;
    let backendAccepted = false;
    try {
      const state = useDownloadStore.getState();
      const item = state.downloads.find(d => d.id === id);
      if (!item) return false;
      if (state.backendRegisteredIds.has(id)) return true;
      if (!['ready', 'staged', 'failed', 'queued'].includes(item.status)) return false;
      lifecycleGeneration = currentDownloadLifecycle(id);

      const settings = useSettingsStore.getState();
      const destination = item.destination ||
        await resolveCategoryDestination(settings, item.category);
      if (!isCurrentDownloadLifecycle(id, lifecycleGeneration)) return false;

      const login = getSiteLogin(item.url, settings);
      if (login && !item.password && !settings.keychainAccessReady && !settings.keychainPromptDismissed) {
        settings.setShowKeychainModal(true);
        return false;
      }
      let keychainPassword = null;
      if (login && !item.password && settings.keychainAccessReady) {
        try {
          keychainPassword = await invoke('get_keychain_password', { id: login.id });
        } catch (e) {
          console.warn("Failed to retrieve keychain password for dispatch:", e);
        }
      }
      if (!isCurrentDownloadLifecycle(id, lifecycleGeneration)) return false;

      const proxy = proxyOverride === undefined
        ? await getProxyArgs(settings)
        : proxyOverride;
      if (!isCurrentDownloadLifecycle(id, lifecycleGeneration)) return false;

      const enqueueItem = {
        id: item.id,
        queue_id: item.queueId || MAIN_QUEUE_ID,
        url: item.url,
        destination,
        filename: item.fileName,
        connections: resolveDownloadConnections(item.connections, settings.perServerConnections),
        speed_limit: speedLimitForDispatch(item.speedLimit, settings.globalSpeedLimit, item.isMedia),
        username: item.username || (login ? login.username : null),
        password: item.password || keychainPassword,
        headers: item.headers || null,
        checksum: item.checksum || null,
        cookies: item.cookies || null,
        mirrors: item.mirrors || null,
        user_agent: settings.customUserAgent.trim() || null,
        max_tries: settings.maxAutomaticRetries,
        proxy,
        format_selector: item.mediaFormatSelector || null,
        cookie_source: settings.mediaCookieSource !== 'none' ? settings.mediaCookieSource : null,
        is_media: item.isMedia || false,
        is_torrent: item.isTorrent || false,
        torrent_path: item.torrentPath || undefined,
        torrent_file_indices: item.torrentFileIndices || undefined,
        torrent_info_hash: item.torrentInfoHash || undefined,
        torrent_seed_time: item.torrentSeedTime,
        torrent_seed_ratio: item.torrentSeedRatio,
        torrent_seed_remaining: item.torrentSeedRemaining,
        torrent_web_seeds: item.torrentWebSeeds,
        torrent_upload_limit: item.torrentUploadLimit || undefined,
        torrent_max_peers: item.torrentMaxPeers,
        torrent_peer_speed_limit: item.torrentPeerSpeedLimit || undefined,
        torrent_check_integrity: item.torrentCheckIntegrity || item.torrentRelocationCheckPending,
        torrent_trackers: item.torrentTrackers || undefined,
        torrent_exclude_trackers: item.torrentExcludeTrackers || undefined,
        torrent_tracker_connect_timeout: item.torrentTrackerConnectTimeout,
        torrent_tracker_timeout: item.torrentTrackerTimeout,
        torrent_tracker_interval: item.torrentTrackerInterval,
        torrent_stop_timeout: item.torrentStopTimeout,
        torrent_prioritize_piece: item.torrentPrioritizePiece || undefined,
        torrent_remove_unselected_file: item.torrentRemoveUnselectedFile,
        torrent_encryption_policy: item.torrentEncryptionPolicy || undefined,
        torrent_file_allocation: item.torrentFileAllocation || undefined,
        torrent_verify_only: item.torrentVerifyOnly,
        torrent_verify_restore_status: item.torrentVerifyRestoreStatus,
        lifecycle_generation: lifecycleGeneration.toString(),
      };

      useDownloadStore.getState().updateDownload(id, {
        lastTry: new Date().toISOString()
      });
      const accepted = await invoke('enqueue_download', { item: enqueueItem });
      backendAccepted = true;
      if (!isCurrentDownloadLifecycle(id, lifecycleGeneration)) {
        await removeStaleBackendDispatch(id);
        return false;
      }

      const acceptedFilename = accepted?.filename || item.fileName;
      if (acceptedFilename !== item.fileName) {
        useDownloadStore.getState().updateDownload(id, {
          fileName: acceptedFilename,
          category: categoryForFileName(acceptedFilename)
        });
      }
      const order = await invoke('get_pending_order', { queueId: item.queueId || MAIN_QUEUE_ID });
      if (!isCurrentDownloadLifecycle(id, lifecycleGeneration)) {
        await removeStaleBackendDispatch(id);
        return false;
      }

      useDownloadStore.getState().setPendingOrder(order);
      useDownloadStore.getState().registerBackendIds([id]);
      useDownloadStore.getState().updateDownload(id, { lastError: undefined });
      return true;
    } catch (e) {
      console.error(`Failed to dispatch ${id}:`, e);
      if (backendAccepted && lifecycleGeneration !== null) {
        await removeStaleBackendDispatch(id);
      }
      if (lifecycleGeneration !== null && isCurrentDownloadLifecycle(id, lifecycleGeneration)) {
        const proxyBlocked = isSystemProxyConfigurationError(e);
        useDownloadStore.getState().updateDownload(id, {
          status: proxyBlocked ? 'queued' : 'failed',
          lastError: errorMessage(e)
        });
      }
      return false;
    } finally {
      backendDispatchPromises.delete(id);
    }
  })();

  backendDispatchPromises.set(id, promise);
  return promise;
}

export function dispatchItem(id: string, proxyOverride?: string | null): Promise<boolean> {
  const current = downloadLifecycleOperations.get(id);
  if (current && current.kind !== 'dispatch') {
    return current.promise.then(() => false, () => false);
  }
  return runDownloadLifecycleOperation(
    id,
    'dispatch',
    () => dispatchItemInternal(id, proxyOverride)
  );
}

export const normalizeCustomProxy = (host: string, port: number): string | null => {
  const trimmedHost = host.trim();
  const normalizedPort = Number.isFinite(port) ? Math.trunc(port) : NaN;
  if (!trimmedHost || !Number.isFinite(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedHost)) {
    try {
      const parsed = new URL(trimmedHost);
      if (parsed.protocol !== 'http:') return null;
      if (!parsed.hostname) return null;
      if (!parsed.port) parsed.port = String(normalizedPort);
      return parsed.toString().replace(/\/$/, '');
    } catch {
      return null;
    }
  }

  try {
    const parsed = new URL(`http://${trimmedHost}:${normalizedPort}`);
    if (
      !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || (parsed.port && Number(parsed.port) !== normalizedPort)
      || (!parsed.port && normalizedPort !== 80)
    ) {
      return null;
    }
    return `http://${trimmedHost}:${normalizedPort}`;
  } catch {
    return null;
  }
};

export const getProxyArgs = async (settings: ReturnType<typeof useSettingsStore.getState>) => {
  if (settings.proxyMode === 'system') {
    try {
      const sysProxy = await invoke('get_system_proxy');
      return typeof sysProxy === 'string' && sysProxy ? sysProxy : "none";
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new SystemProxyResolutionError(reason);
    }
  }
  if (settings.proxyMode === 'custom') {
    return normalizeCustomProxy(settings.proxyHost, settings.proxyPort) ?? "none";
  }
  if (settings.proxyMode === 'none') {
    return "none";
  }
  return null;
};

const escapeRegex = (value: string): string =>
  value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

const wildcardToRegex = (pattern: string): RegExp =>
  new RegExp(`^${escapeRegex(pattern).replace(/\*+/g, '.*')}$`);

const patternSpecificity = (pattern: string): number =>
  pattern.replace(/\*/g, '').length;

const hostPatternScore = (pattern: string, host: string): number | null => {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.substring(2);
    return host === suffix || host.endsWith(`.${suffix}`)
      ? 1000 + patternSpecificity(pattern)
      : null;
  }

  if (pattern.includes('*')) {
    return wildcardToRegex(pattern).test(host)
      ? 1000 + patternSpecificity(pattern)
      : null;
  }

  return host === pattern ? 2000 + patternSpecificity(pattern) : null;
};

const urlPatternScore = (pattern: string, url: URL): number | null => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pattern)) {
    const normalizedPattern = pattern.toLowerCase().replace(/\/+$/, '');
    const normalizedUrl = url.toString().toLowerCase().replace(/\/+$/, '');
    return wildcardToRegex(normalizedPattern).test(normalizedUrl)
      ? 4000 + patternSpecificity(normalizedPattern)
      : null;
  }

  if (pattern.includes('/')) {
    const normalizedPattern = pattern.toLowerCase().replace(/^\/+/, '');
    const normalizedTarget = `${url.hostname}${url.pathname}`.toLowerCase().replace(/\/+$/, '');
    return wildcardToRegex(normalizedPattern).test(normalizedTarget)
      ? 3000 + patternSpecificity(normalizedPattern)
      : null;
  }

  return hostPatternScore(pattern, url.hostname.toLowerCase());
};

export const getSiteLogin = (url: string, settings: ReturnType<typeof useSettingsStore.getState>) => {
  try {
    const urlObj = new URL(url);
    let bestMatch: { login: typeof settings.siteLogins[number]; score: number } | null = null;
    for (const login of settings.siteLogins) {
      const pattern = login.urlPattern.toLowerCase().trim();
      const score = pattern ? urlPatternScore(pattern, urlObj) : null;
      if (score !== null && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { login, score };
      }
    }
    return bestMatch?.login ?? null;
  } catch (e) {}
  return null;
};

const syncSystemIntegrations = () => {
  const settings = useSettingsStore.getState();
  const activeCount = useDownloadStore.getState().downloads.filter(d => isTransferActiveStatus(d.status)).length;
  updateDockBadge(settings.showDockBadge ? activeCount : 0).catch(() => {});
};

const effectiveDestinationForItem = async (
  item: Pick<DownloadItem, 'destination' | 'category'>,
  settings: ReturnType<typeof useSettingsStore.getState>
): Promise<string> =>
  item.destination || resolveCategoryDestination(settings, item.category);

const normalizeQueuePositions = (downloads: DownloadItem[]): DownloadItem[] => {
  const nextPosition = new Map<string, number>();
  const normalized: DownloadItem[] = downloads.map(download => {
    const queueId = download.queueId || MAIN_QUEUE_ID;
    const position = nextPosition.get(queueId) || 0;
    nextPosition.set(queueId, position + 1);
    const persistedPosition = download.queuePosition;
    const queuePosition = typeof persistedPosition === 'number' &&
      Number.isFinite(persistedPosition) && persistedPosition >= 0
      ? Math.trunc(persistedPosition)
      : position;
    return {
      ...download,
      queueId,
      queuePosition
    };
  });

  let ordered = normalized;
  for (const queueId of new Set(normalized.map(download => download.queueId || MAIN_QUEUE_ID))) {
    ordered = reorderQueueWithPausedAtEnd(ordered, queueId);
  }
  return ordered;
};

const TEMPORARY_MEDIA_ESTIMATE_MAX_BYTES = 1024;
const DISPLAYED_SIZE_UNIT_MULTIPLIERS: Record<string, number> = {
  B: 1,
  KB: 1024,
  KIB: 1024,
  MB: 1024 ** 2,
  MIB: 1024 ** 2,
  GB: 1024 ** 3,
  GIB: 1024 ** 3,
  TB: 1024 ** 4,
  TIB: 1024 ** 4
};

const displayedSizeBytes = (size: string | undefined): number | undefined => {
  const match = size?.trim().match(/^~\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KB|KIB|MB|MIB|GB|GIB|TB|TIB)$/i);
  if (!match) return undefined;

  const bytes = Number(match[1]) * DISPLAYED_SIZE_UNIT_MULTIPLIERS[match[2].toUpperCase()];
  return Number.isFinite(bytes) ? bytes : undefined;
};

export const hasStaleTemporaryMediaEstimate = (
  download: Pick<DownloadItem, 'isMedia' | 'downloadedBytes' | 'totalBytes' | 'totalIsEstimate' | 'size'>
): boolean => {
  if (download.isMedia !== true) return false;

  const hasImpossibleNumericEstimate = download.totalIsEstimate === true &&
    typeof download.totalBytes === 'number' &&
    Number.isFinite(download.totalBytes) &&
    download.totalBytes > 0 &&
    download.totalBytes <= TEMPORARY_MEDIA_ESTIMATE_MAX_BYTES &&
    typeof download.downloadedBytes === 'number' &&
    Number.isFinite(download.downloadedBytes) &&
    download.downloadedBytes > download.totalBytes;
  const visibleEstimateBytes = displayedSizeBytes(download.size);
  const hasImpossibleVisibleEstimate = visibleEstimateBytes !== undefined &&
    visibleEstimateBytes <= TEMPORARY_MEDIA_ESTIMATE_MAX_BYTES &&
    typeof download.downloadedBytes === 'number' &&
    Number.isFinite(download.downloadedBytes) &&
    download.downloadedBytes > visibleEstimateBytes &&
    (download.totalBytes == null || download.totalBytes <= TEMPORARY_MEDIA_ESTIMATE_MAX_BYTES);

  return hasImpossibleNumericEstimate || hasImpossibleVisibleEstimate;
};

export const normalizePersistedDownloadProgress = (download: DownloadItem): DownloadItem => {
  const rawSeedRemaining = download.torrentSeedRemaining as unknown;
  const normalizedSeedRemaining = typeof rawSeedRemaining === 'number' &&
    Number.isFinite(rawSeedRemaining) &&
    rawSeedRemaining >= 0
    ? rawSeedRemaining
    : undefined;
  const rawUploadedBytes = download.torrentUploadedBytes as unknown;
  const normalizedUploadedBytes = typeof rawUploadedBytes === 'number'
    && Number.isSafeInteger(rawUploadedBytes)
    && rawUploadedBytes >= 0
    ? rawUploadedBytes
    : rawUploadedBytes === undefined ? undefined : 0;
  const rawSeededSeconds = download.torrentSeededSeconds as unknown;
  const normalizedSeededSeconds = typeof rawSeededSeconds === 'number'
    && Number.isSafeInteger(rawSeededSeconds)
    && rawSeededSeconds >= 0
    ? rawSeededSeconds
    : rawSeededSeconds === undefined ? undefined : 0;
  const rawMaxPeers = download.torrentMaxPeers as unknown;
  const normalizedMaxPeers = typeof rawMaxPeers === 'number' &&
    Number.isInteger(rawMaxPeers) &&
    rawMaxPeers >= 0 &&
    rawMaxPeers <= 1000
    ? rawMaxPeers
    : undefined;
  const rawWebSeeds = download.torrentWebSeeds as unknown;
  const normalizedWebSeeds = Array.isArray(rawWebSeeds)
    ? rawWebSeeds.filter((seed): seed is { fileIndex: number; uri: string } =>
      !!seed && typeof seed === 'object' &&
      typeof (seed as { fileIndex?: unknown }).fileIndex === 'number' &&
      Number.isInteger((seed as { fileIndex: number }).fileIndex) &&
      (seed as { fileIndex: number }).fileIndex >= 0 &&
      typeof (seed as { uri?: unknown }).uri === 'string' &&
      (seed as { uri: string }).uri.length <= 2048
    ).slice(0, 256)
    : undefined;
  const rawNativeWebSeeds = download.torrentWebSeedsNative as unknown;
  const normalizedNativeWebSeeds = Array.isArray(rawNativeWebSeeds)
    ? rawNativeWebSeeds.filter((seed): seed is { fileIndex: number; uri: string } =>
      !!seed && typeof seed === 'object' &&
      typeof (seed as { fileIndex?: unknown }).fileIndex === 'number' &&
      Number.isInteger((seed as { fileIndex: number }).fileIndex) &&
      (seed as { fileIndex: number }).fileIndex >= 0 &&
      typeof (seed as { uri?: unknown }).uri === 'string' &&
      (seed as { uri: string }).uri.length <= 2048
    ).slice(0, 256)
    : undefined;
  const rawPeerSpeedLimit = download.torrentPeerSpeedLimit as unknown;
  const normalizedPeerSpeedLimit = typeof rawPeerSpeedLimit === 'string'
    ? normalizeSpeedLimitForBackend(rawPeerSpeedLimit) || undefined
    : undefined;
  const rawCheckIntegrity = download.torrentCheckIntegrity as unknown;
  const normalizedCheckIntegrity = typeof rawCheckIntegrity === 'boolean'
    ? rawCheckIntegrity
    : undefined;
  const rawTrackers = download.torrentTrackers as unknown;
  const normalizedTrackers = typeof rawTrackers === 'string' && rawTrackers.trim() && isValidTorrentTrackerList(rawTrackers)
    ? rawTrackers.trim()
    : undefined;
  const rawExcludeTrackers = download.torrentExcludeTrackers as unknown;
  const normalizedExcludeTrackers = typeof rawExcludeTrackers === 'string' && rawExcludeTrackers.trim() && isValidTorrentExcludeTrackerList(rawExcludeTrackers)
    ? rawExcludeTrackers.trim()
    : undefined;
  const rawTrackerConnectTimeout = download.torrentTrackerConnectTimeout as unknown;
  const normalizedTrackerConnectTimeout = normalizeTorrentTrackerTimeout(rawTrackerConnectTimeout);
  const rawTrackerTimeout = download.torrentTrackerTimeout as unknown;
  const normalizedTrackerTimeout = normalizeTorrentTrackerTimeout(rawTrackerTimeout);
  const rawTrackerInterval = download.torrentTrackerInterval as unknown;
  const normalizedTrackerInterval = normalizeTorrentTrackerInterval(rawTrackerInterval);
  const rawStopTimeout = download.torrentStopTimeout as unknown;
  const normalizedStopTimeout = typeof rawStopTimeout === 'number' &&
    Number.isInteger(rawStopTimeout) &&
    rawStopTimeout >= 0 &&
    rawStopTimeout <= MAX_TORRENT_STOP_TIMEOUT
    ? rawStopTimeout
    : undefined;
  const rawPrioritizePiece = download.torrentPrioritizePiece as unknown;
  const normalizedPrioritizePiece = typeof rawPrioritizePiece === 'string'
    ? normalizeTorrentPrioritizePiece(rawPrioritizePiece) || undefined
    : undefined;
  const rawRemoveUnselectedFile = download.torrentRemoveUnselectedFile as unknown;
  const normalizedRemoveUnselectedFile = typeof rawRemoveUnselectedFile === 'boolean'
    ? rawRemoveUnselectedFile
    : undefined;
  const rawEncryptionPolicy = download.torrentEncryptionPolicy as unknown;
  const normalizedEncryptionPolicy = normalizeTorrentEncryptionPolicy(rawEncryptionPolicy);
  const rawFileAllocation = download.torrentFileAllocation as unknown;
  const normalizedFileAllocation = normalizeTorrentFileAllocation(rawFileAllocation);
  const rawVerifyOnly = download.torrentVerifyOnly as unknown;
  const normalizedVerifyOnly = rawVerifyOnly === true ? true : undefined;
  const rawRelocationCheckPending = download.torrentRelocationCheckPending as unknown;
  const normalizedRelocationCheckPending = rawRelocationCheckPending === true ? true : undefined;
  const rawMoveDestination = download.torrentMoveDestination as unknown;
  const normalizedMoveDestination = typeof rawMoveDestination === 'string'
    && rawMoveDestination.trim()
    ? rawMoveDestination
    : undefined;
  const rawMoveRestoreStatus = download.torrentMoveRestoreStatus as unknown;
  const normalizedMoveRestoreStatus: DownloadStatus | undefined = download.status === 'moving' && (
    rawMoveRestoreStatus === 'paused'
    || rawMoveRestoreStatus === 'completed'
    || rawMoveRestoreStatus === 'failed'
  )
    ? rawMoveRestoreStatus as DownloadStatus
    : undefined;
  const recoveredMoveStatus = download.status === 'moving'
    ? normalizedMoveRestoreStatus || 'failed'
    : download.status;
  const rawVerifyRestoreStatus = download.torrentVerifyRestoreStatus as unknown;
  const normalizedVerifyRestoreStatus = normalizedVerifyOnly === true
    && typeof rawVerifyRestoreStatus === 'string'
    && ['paused', 'failed', 'completed'].includes(rawVerifyRestoreStatus)
    ? rawVerifyRestoreStatus
    : undefined;
  const normalizedOptions = rawSeedRemaining !== normalizedSeedRemaining ||
    rawUploadedBytes !== normalizedUploadedBytes ||
    rawSeededSeconds !== normalizedSeededSeconds ||
    rawWebSeeds !== normalizedWebSeeds ||
    rawNativeWebSeeds !== normalizedNativeWebSeeds ||
    rawMaxPeers !== normalizedMaxPeers ||
    rawPeerSpeedLimit !== normalizedPeerSpeedLimit ||
    rawCheckIntegrity !== normalizedCheckIntegrity ||
    rawTrackers !== normalizedTrackers ||
    rawExcludeTrackers !== normalizedExcludeTrackers ||
    rawTrackerConnectTimeout !== normalizedTrackerConnectTimeout ||
    rawTrackerTimeout !== normalizedTrackerTimeout ||
    rawTrackerInterval !== normalizedTrackerInterval ||
    rawStopTimeout !== normalizedStopTimeout ||
    rawPrioritizePiece !== normalizedPrioritizePiece ||
    rawRemoveUnselectedFile !== normalizedRemoveUnselectedFile ||
    rawEncryptionPolicy !== normalizedEncryptionPolicy ||
    rawFileAllocation !== normalizedFileAllocation ||
    rawVerifyOnly !== normalizedVerifyOnly ||
    rawRelocationCheckPending !== normalizedRelocationCheckPending ||
    rawMoveDestination !== normalizedMoveDestination ||
    rawMoveRestoreStatus !== normalizedMoveRestoreStatus ||
    recoveredMoveStatus !== download.status ||
    rawVerifyRestoreStatus !== normalizedVerifyRestoreStatus
      ? {
        ...download,
        status: recoveredMoveStatus,
        torrentSeedRemaining: normalizedSeedRemaining,
        torrentUploadedBytes: normalizedUploadedBytes,
        torrentSeededSeconds: normalizedSeededSeconds,
        torrentWebSeeds: normalizedWebSeeds,
        torrentWebSeedsNative: normalizedNativeWebSeeds,
        torrentMaxPeers: normalizedMaxPeers,
        torrentPeerSpeedLimit: normalizedPeerSpeedLimit,
        torrentCheckIntegrity: normalizedCheckIntegrity,
        torrentTrackers: normalizedTrackers,
        torrentExcludeTrackers: normalizedExcludeTrackers,
        torrentTrackerConnectTimeout: normalizedTrackerConnectTimeout,
        torrentTrackerTimeout: normalizedTrackerTimeout,
        torrentTrackerInterval: normalizedTrackerInterval,
        torrentStopTimeout: normalizedStopTimeout,
        torrentPrioritizePiece: normalizedPrioritizePiece,
        torrentRemoveUnselectedFile: normalizedRemoveUnselectedFile,
        torrentEncryptionPolicy: normalizedEncryptionPolicy,
        torrentFileAllocation: normalizedFileAllocation,
        torrentVerifyOnly: normalizedVerifyOnly,
        torrentRelocationCheckPending: normalizedRelocationCheckPending,
        torrentMoveDestination: normalizedMoveDestination,
        torrentMoveRestoreStatus: normalizedMoveRestoreStatus,
        torrentVerifyRestoreStatus: normalizedVerifyRestoreStatus
      }
    : recoveredMoveStatus !== download.status
      ? { ...download, status: recoveredMoveStatus, torrentMoveRestoreStatus: normalizedMoveRestoreStatus }
      : download;

  return hasStaleTemporaryMediaEstimate(normalizedOptions)
    ? {
        ...normalizedOptions,
        // The old lifecycle could persist yt-dlp's temporary HLS estimate as
        // both the numeric denominator and the visible size. Neither value is
        // recoverable after the fact, so remove the false claim on startup.
        size: undefined,
        totalBytes: undefined,
        totalIsEstimate: undefined
      }
    : normalizedOptions;
};

export type { DownloadStatus };
export const MAIN_QUEUE_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_MAIN_QUEUE_NAME = 'Main Queue';
const MAX_QUEUE_CONCURRENT = 12;

const queueNameKey = (name: string): string => name.trim().toLowerCase();

const normalizeQueueConcurrency = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return value >= 1 && value <= MAX_QUEUE_CONCURRENT ? value : undefined;
};

type PersistedQueue = Omit<Queue, 'maxConcurrent'> & {
  maxConcurrent?: number | null;
};

const queueWithNormalizedConcurrency = (queue: PersistedQueue): Queue => {
  const maxConcurrent = normalizeQueueConcurrency(queue.maxConcurrent);
  return maxConcurrent === undefined
    ? { id: queue.id, name: queue.name, isMain: queue.isMain }
    : { id: queue.id, name: queue.name, isMain: queue.isMain, maxConcurrent };
};

export const normalizePersistedQueueState = (queues: PersistedQueue[]) => {
  const validQueues = queues.filter(queue =>
    queue && typeof queue.id === 'string' && typeof queue.name === 'string'
  ).map(queueWithNormalizedConcurrency);
  const persistedMain = validQueues.find(queue => queue.id === MAIN_QUEUE_ID)
    || validQueues.find(queue => queue.isMain);
  const persistedMainId = persistedMain?.id.trim();
  const mainName = persistedMain?.name.trim() || DEFAULT_MAIN_QUEUE_NAME;
  const normalizedMain: Queue = { id: MAIN_QUEUE_ID, name: mainName, isMain: true };
  if (persistedMain?.maxConcurrent !== undefined) {
    normalizedMain.maxConcurrent = persistedMain.maxConcurrent;
  }
  const normalized: Queue[] = [normalizedMain];
  const seenIds = new Set([MAIN_QUEUE_ID]);
  const seenNames = new Set([queueNameKey(mainName)]);
  const queueIdRemap = new Map<string, string>();
  if (persistedMainId && persistedMainId !== MAIN_QUEUE_ID) {
    queueIdRemap.set(persistedMainId, MAIN_QUEUE_ID);
  }

  for (const queue of validQueues) {
    const id = queue.id.trim();
    if (!id || id === MAIN_QUEUE_ID || id === persistedMainId || seenIds.has(id)) continue;
    if (queue.isMain) {
      queueIdRemap.set(id, MAIN_QUEUE_ID);
      continue;
    }
    let name = queue.name.trim() || `Queue ${id.slice(0, 8)}`;
    const baseName = name;
    let suffix = 2;
    while (seenNames.has(queueNameKey(name))) {
      name = `${baseName} (${suffix})`;
      suffix += 1;
    }
    seenIds.add(id);
    seenNames.add(queueNameKey(name));
    const normalizedQueue = { id, name, isMain: false } as Queue;
    if (queue.maxConcurrent !== undefined) {
      const maxConcurrent = normalizeQueueConcurrency(queue.maxConcurrent);
      if (maxConcurrent !== undefined) normalizedQueue.maxConcurrent = maxConcurrent;
    }
    normalized.push(normalizedQueue);
  }

  return { queues: normalized, queueIdRemap };
};

export const normalizePersistedQueues = (queues: PersistedQueue[]): Queue[] =>
  normalizePersistedQueueState(queues).queues;

const synchronizeQueueConcurrencyLimits = async (queues: Queue[]): Promise<void> => {
  await invoke('set_queue_concurrency_limits', {
    limits: queues.map(queue => ({
      id: queue.id,
      maxConcurrent: queue.maxConcurrent ?? null
    }))
  });
};

const sameQueueConcurrencyConfig = (left: Queue[], right: Queue[]): boolean =>
  left.length === right.length && left.every((queue, index) => {
    const other = right[index];
    return other !== undefined
      && queue.id === other.id
      && (queue.maxConcurrent ?? null) === (other.maxConcurrent ?? null);
  });

export type { DownloadItem, Queue };
export type ExtensionDownloadRequest = ExtensionDownload;
export type AddDownloadAction =
  | { type: 'start-now' }
  | { type: 'add-to-queue'; queueId: string };
export type DownloadDraft = Omit<DownloadItem, 'status' | 'queueId' | 'hasBeenDispatched'> & {
  /** Numeric format estimate supplied by the media Add window. */
  sizeBytes?: number;
};
export type PendingAddRequestContext = {
  version: number;
  referer: string;
  filename: string;
  headers: string;
  cookies: string;
  cookieScopes?: ExtensionCookieScope[];
  media: boolean;
};

export type DeleteModalState = {
  isOpen: boolean;
  downloadIds?: string[];
};

interface DownloadState {
  downloads: DownloadItem[];
  queues: Queue[];
  pendingOrder: string[];
  setPendingOrder: (order: string[]) => void;
  backendRegisteredIds: Set<string>;
  registerBackendIds: (ids: string[]) => void;
  unregisterBackendIds: (ids: string[]) => void;
  applyProperties: (id: string, updates: Partial<DownloadItem>) => Promise<void>;
  moveInQueue: (ids: string | string[], direction: 'up' | 'down') => Promise<void>;
  moveManyInQueueToPosition: (
    ids: string | string[],
    queueId: string,
    targetIndex: number,
    beforeId?: string | null,
    selectedOrder?: readonly string[]
  ) => Promise<void>;
  removeFromQueue: (id: string) => Promise<void>;
  isAddModalOpen: boolean;
  pendingAddUrls: string;
  pendingAddReferer: string;
  pendingAddFilename: string;
  pendingAddHeaders: string;
  pendingAddCookies: string;
  pendingAddMediaUrls: string[];
  pendingAddBatch: boolean;
  pendingAddBatchName: string;
  pendingAddRequestContexts: Record<string, PendingAddRequestContext>;
  pendingAddRequestVersion: number;
  selectedPropertiesDownloadId: string | null;
  toggleAddModal: (isOpen: boolean) => void;
  openAddModalWithUrls: (
    urls: string,
    referer?: string | null,
    filename?: string | null,
    headers?: string | null,
    cookies?: string | null,
    media?: boolean,
    cookieScopes?: ExtensionCookieScope[] | null,
    batch?: boolean,
    batchName?: string | null
  ) => void;
  handleExtensionDownload: (request: ExtensionDownloadRequest) => Promise<void>;
  deleteModalState: DeleteModalState;
  openDeleteModal: (downloadIds?: string | string[]) => void;
  closeDeleteModal: () => void;
  setSelectedPropertiesDownloadId: (id: string | null) => void;
  addDownload: (item: DownloadDraft, action: AddDownloadAction) => Promise<boolean>;
  replaceDownload: (id: string, updates: Partial<DownloadItem>, action: AddDownloadAction) => Promise<boolean>;
  updateDownload: (id: string, updates: Partial<DownloadItem>) => void;
  removeDownload: (id: string, deleteFile?: boolean, preserveResumable?: boolean) => Promise<void>;
  pauseDownload: (id: string) => Promise<void>;
  redownload: (id: string) => Promise<void>;
  resumeDownload: (id: string, options?: ResumeDownloadOptions) => Promise<boolean>;
  startSelected: (ids: string[]) => Promise<number>;
  startQueue: (queueId: string) => Promise<string[]>;
  pauseQueue: (queueId: string) => Promise<number>;
  startAll: () => Promise<number>;
  pauseAll: () => Promise<number>;
  assignToQueue: (ids: string[], queueId: string) => Promise<void>;
  setDownloadSpeedLimit: (id: string, limit: string | null) => Promise<void>;
  setTorrentUploadLimit: (id: string, limit: string | null) => Promise<void>;
  setTorrentPeerOptions: (
    id: string,
    maxPeers: string | null,
    peerSpeedLimit: string | null
  ) => Promise<void>;
  setQueueConcurrency: (id: string, maxConcurrent: number | null) => Promise<void>;
  addQueue: (name: string) => boolean;
  renameQueue: (id: string, name: string) => boolean;
  removeQueue: (id: string) => Promise<void>;
  resumePendingDownloads: () => Promise<void>;
  initDB: () => Promise<void>;
  
}

export const useDownloadStore = create<DownloadState>((set, get) => {
  const applyPropertiesInternal = async (id: string, updates: Partial<DownloadItem>): Promise<void> => {
    await waitForPendingStartupResume();
    const wasDispatching = await invalidateAndWaitForDispatch(id);
    const state = get();
    const item = state.downloads.find(d => d.id === id);
    if (!item) return;
    const normalizedUpdates = updates.fileName === undefined
      ? updates
      : { ...updates, fileName: canonicalizeDownloadFileName(updates.fileName) };
    const disablingTorrentRemoval = item.isTorrent === true
      && normalizedUpdates.torrentRemoveUnselectedFile === false
      && item.torrentRemoveUnselectedFile !== false;

    if (item.status === 'downloading' || item.status === 'processing' || item.status === 'verifying' || item.status === 'seeding' || item.status === 'retrying') {
      throw new Error(i18n.t($ => $.downloadTable.transferActive));
    }

    if (item.status === 'ready' || item.status === 'staged' || item.status === 'completed' || item.status === 'failed') {
      if (disablingTorrentRemoval) {
        await invoke('clear_torrent_removal_paths', { id });
      }
      state.updateDownload(id, normalizedUpdates);
      return;
    }

    // Queued or Paused
    const isRegistered = state.backendRegisteredIds.has(id);

    if (item.status === 'queued') {
      if (isRegistered) {
        await invoke('detach_download_for_reconfigure', { id });
        state.unregisterBackendIds([id]);
        set(current => ({ pendingOrder: current.pendingOrder.filter(value => value !== id) }));
      }
      if (disablingTorrentRemoval) {
        await invoke('clear_torrent_removal_paths', { id });
      }
      state.updateDownload(id, normalizedUpdates);
      if (isRegistered || wasDispatching) {
        const dispatched = await dispatchItemInternal(id);
        if (dispatched) {
          state.updateDownload(id, { hasBeenDispatched: true });
        } else {
          state.removeFromQueue(id);
        }
      }
    } else if (item.status === 'paused') {
      // The frontend deliberately removes paused rows from
      // backendRegisteredIds, but the backend keeps a paused Aria2 GID and
      // its old payload alive for an in-place resume. Any property change,
      // especially Torrent selection/output changes, must retire that
      // lifecycle or resume will silently use stale daemon options.
      try {
        await invoke('detach_download_for_reconfigure', { id });
      } catch (e) {
        console.error("Failed to detach for reconfigure:", e);
        throw e; // Preserve old properties if detach fails
      }
      if (isRegistered) state.unregisterBackendIds([id]);
      if (disablingTorrentRemoval) {
        await invoke('clear_torrent_removal_paths', { id });
      }
      state.updateDownload(id, normalizedUpdates);
    }
  };

  const resumeDownloadInternal = async (
    id: string,
    options: ResumeDownloadOptions = {}
  ): Promise<boolean> => {
    await waitForPendingStartupResume();
    let targetItem = get().downloads.find(d => d.id === id);
    if (!targetItem) return false;

    setDownloadControlIntent(id, 'resume');
    let previousStatus = targetItem.status;
    try {
      if (options.forceRequeue) {
        // Fence any older enqueue before replacing a paused backend lifecycle.
        // Otherwise a late addUri result can win the race and make this
        // selection start outside the requested order.
        const { pendingDispatch } = await invalidateDispatch(id);
        if (pendingDispatch) await pendingDispatch;
        targetItem = get().downloads.find(download => download.id === id);
        if (!targetItem || !canStartDownload(targetItem.status)) {
          clearDownloadControlIntent(id, 'resume');
          return false;
        }
        previousStatus = targetItem.status;
      }

      const currentTargetItem = targetItem;

      if (
        options.forceRequeue &&
        currentTargetItem.status === 'paused' &&
        get().backendRegisteredIds.has(id)
      ) {
        await invoke('detach_download_for_reconfigure', { id });
        get().unregisterBackendIds([id]);
      }

      if (options.forceRequeue) {
        set(state => ({
          pendingOrder: state.pendingOrder.filter(value => value !== id)
        }));
      }

      if (currentTargetItem.status === 'ready' || currentTargetItem.status === 'staged') {
        get().updateDownload(id, { status: 'queued', hasBeenDispatched: true });
        if (await dispatchItemInternal(id)) {
          return true;
        }
        get().updateDownload(id, { status: currentTargetItem.status });
        clearDownloadControlIntent(id, 'resume');
        return false;
      }

      const prevStatus = currentTargetItem.status;
      const queueItems = get().downloads.filter(d =>
        (d.queueId || MAIN_QUEUE_ID) === (currentTargetItem.queueId || MAIN_QUEUE_ID)
      );
      const maxPos = queueItems.reduce((max, d) => Math.max(max, d.queuePosition ?? 0), -1);
      const queuePosition = options.preserveQueuePosition
        ? currentTargetItem.queuePosition
        : maxPos + 1;

      get().updateDownload(id, {
        status: 'queued',
        speed: '-',
        eta: '-',
        ...(queuePosition === undefined ? {} : { queuePosition }),
        lastTry: new Date().toISOString()
      });

      const resumedExisting = options.forceRequeue
        ? false
        : await invoke('resume_download', {
            id,
            queueId: currentTargetItem.queueId || MAIN_QUEUE_ID
          });

      let dispatchSucceeded = resumedExisting;
      if (!dispatchSucceeded) {
        get().unregisterBackendIds([id]);
        // A terminal aria2 gid is intentionally re-enqueued as a new
        // lifecycle. Advance and cancel the old generation before dispatching
        // so QueueManager does not reject the legitimate user retry as stale.
        await invalidateAndWaitForDispatch(id);
        dispatchSucceeded = await dispatchItemInternal(id);
      }

      if (dispatchSucceeded) {
        get().updateDownload(id, { hasBeenDispatched: true });
        return true;
      } else {
        const dispatchError = get().downloads.find(download => download.id === id)?.lastError;
        console.error("Failed to re-enqueue for resume:", dispatchError || "backend rejected the enqueue request");
        get().updateDownload(id, {
          status: prevStatus,
          ...(dispatchError ? { lastError: dispatchError } : {})
        });
        clearDownloadControlIntent(id, 'resume');
        return false;
      }
    } catch (e) {
      console.error("Failed to resume download:", e);
      const current = get().downloads.find(download => download.id === id);
      if (current?.status === 'queued') {
        get().updateDownload(id, { status: previousStatus });
      }
      clearDownloadControlIntent(id, 'resume');
      return false;
    }
  };

  return {
  downloads: [],
  queues: [{ id: MAIN_QUEUE_ID, name: 'Main Queue', isMain: true }],
  pendingOrder: [],
  setPendingOrder: (order) => set({ pendingOrder: order }),
  moveInQueue: (idOrIds, direction) => {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    if (ids.length === 0) return Promise.resolve();

    // Queue moves must be serialized per queue. Otherwise two optimistic
    // moves can calculate from the same order and the last RPC silently wins.
    const firstItem = get().downloads.find(download => ids.includes(download.id));
    if (!firstItem) return Promise.resolve();
    const queueId = firstItem.queueId || MAIN_QUEUE_ID;
    const previousOperation = queueReorderPromises.get(queueId) ?? Promise.resolve();
    const operation = previousOperation.catch(() => undefined).then(async () => {
      const allDownloads = get().downloads;
      const queueItems = queueItemsForReordering(allDownloads, queueId);

      const selectedItems = queueItems.filter(item => ids.includes(item.id));
      if (selectedItems.length === 0) return;

      const previousPositions = new Map([
        ...activeQueueItems(allDownloads, queueId),
        ...queueItems
      ].map(item => [item.id, item.queuePosition]));
      const unselectedItems = queueItems.filter(item => !ids.includes(item.id));
      const selectedIndices = selectedItems.map(item => queueItems.findIndex(d => d.id === item.id));

      let insertIndex = 0;
      if (direction === 'up') {
        const firstSelectedIndex = Math.min(...selectedIndices);
        insertIndex = Math.max(0, firstSelectedIndex - 1);
      } else {
        const lastSelectedIndex = Math.max(...selectedIndices);
        insertIndex = Math.min(unselectedItems.length, lastSelectedIndex - selectedItems.length + 2);
      }

      const reordered = [
        ...unselectedItems.slice(0, insertIndex),
        ...selectedItems,
        ...unselectedItems.slice(insertIndex)
      ];
      set(state => ({ downloads: applyQueueOrder(state.downloads, queueId, reordered) }));

      const registeredIdsToMove = selectedItems
        .filter(item => get().backendRegisteredIds.has(item.id))
        .map(item => item.id);
      if (registeredIdsToMove.length === 0) return;

      try {
        const order = await invoke('move_many_in_queue', {
          ids: registeredIdsToMove,
          queueId,
          direction
        }) as string[];
        if (Array.isArray(order)) {
          const globalOrder = await invoke('get_pending_order', { queueId: null })
            .catch(() => null) as string[] | null;
          set(state => ({
            pendingOrder: Array.isArray(globalOrder)
              ? globalOrder
              : [
                  ...state.pendingOrder.filter(id => !order.includes(id)),
                  ...order
                ]
          }));
        }
      } catch (error) {
        console.error("Failed to move in queue backend:", error);
        // The backend operation is atomic. Restore only queue positions so a
        // progress/state event received while the RPC was in flight survives.
        set(state => ({
          downloads: state.downloads.map(download => previousPositions.has(download.id)
            ? { ...download, queuePosition: previousPositions.get(download.id) }
            : download)
        }));
        throw error;
      }
    });
    const trackedOperation = operation.finally(() => {
      if (queueReorderPromises.get(queueId) === trackedOperation) {
        queueReorderPromises.delete(queueId);
      }
    });
    queueReorderPromises.set(queueId, trackedOperation);
    return trackedOperation;
  },
  moveManyInQueueToPosition: (idOrIds, queueId, targetIndex, beforeId, selectedOrder) => {
    const requestedIds = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    const ids = [...new Set(requestedIds)];
    const normalizedSelectedOrder = selectedOrder
      ? [...new Set(selectedOrder)].filter(id => ids.includes(id))
      : undefined;
    if (ids.length === 0) return Promise.resolve();

    // Dragging must be one serialized, atomic queue operation. This prevents
    // a second drag or a keyboard move from calculating against stale order
    // while the backend is still applying the first drop.
    const previousOperation = queueReorderPromises.get(queueId) ?? Promise.resolve();
    const operation = previousOperation.catch(() => undefined).then(async () => {
      const allDownloads = get().downloads;
      const queueItems = queueItemsForReordering(allDownloads, queueId);
      const selectedItems = normalizedSelectedOrder
        ? normalizedSelectedOrder
          .map(id => queueItems.find(item => item.id === id))
          .filter((item): item is DownloadItem => Boolean(item))
        : queueItems.filter(item => ids.includes(item.id));
      if (selectedItems.length === 0) return;

      const selectedIds = new Set(selectedItems.map(item => item.id));
      const previousPositions = new Map([
        ...activeQueueItems(allDownloads, queueId),
        ...queueItems
      ].map(item => [item.id, item.queuePosition]));
      const unselectedItems = queueItems.filter(item => !selectedIds.has(item.id));
      const anchoredTargetIndex = beforeId
        ? unselectedItems.findIndex(item => item.id === beforeId)
        : -1;
      const resolvedTargetIndex = anchoredTargetIndex >= 0
        ? anchoredTargetIndex
        : Math.max(0, Math.min(targetIndex, unselectedItems.length));
      const reordered = normalizedSelectedOrder
        ? [
            ...unselectedItems.slice(0, resolvedTargetIndex),
            ...selectedItems,
            ...unselectedItems.slice(resolvedTargetIndex)
          ]
        : moveSelectedBlockToIndex(queueItems, selectedIds, resolvedTargetIndex);
      set(state => ({ downloads: applyQueueOrder(state.downloads, queueId, reordered) }));

      const registeredIdsToMove = selectedItems
        .filter(item => get().backendRegisteredIds.has(item.id))
        .map(item => item.id);
      if (registeredIdsToMove.length === 0) return;

      // Staged rows are deliberately not registered with the backend. Convert
      // the desired local order to a registered-only target before IPC so a
      // staged row never shifts the backend insertion index.
      const registeredItems = queueItems.filter(item => get().backendRegisteredIds.has(item.id));
      const registeredSelectedIds = new Set(registeredIdsToMove);
      const registeredDesiredOrder = reordered.filter(item => get().backendRegisteredIds.has(item.id));
      const backendTargetIndex = targetIndexForDesiredOrder(
        registeredItems,
        registeredSelectedIds,
        registeredDesiredOrder
      );

      try {
        const order = await invoke('move_many_in_queue', {
          ids: registeredIdsToMove,
          queueId,
          direction: 'up',
          targetIndex: backendTargetIndex
        }) as string[];
        if (Array.isArray(order)) {
          const globalOrder = await invoke('get_pending_order', { queueId: null })
            .catch(() => null) as string[] | null;
          set(state => ({
            pendingOrder: Array.isArray(globalOrder)
              ? globalOrder
              : [
                  ...state.pendingOrder.filter(id => !order.includes(id)),
                  ...order
                ]
          }));
        }
      } catch (error) {
        console.error("Failed to move queue block to position:", error);
        // The backend operation is atomic. Restore only queue positions so a
        // progress/state event received while the RPC was in flight survives.
        set(state => ({
          downloads: state.downloads.map(download => previousPositions.has(download.id)
            ? { ...download, queuePosition: previousPositions.get(download.id) }
            : download)
        }));
        throw error;
      }
    });
    const trackedOperation = operation.finally(() => {
      if (queueReorderPromises.get(queueId) === trackedOperation) {
        queueReorderPromises.delete(queueId);
      }
    });
    queueReorderPromises.set(queueId, trackedOperation);
    return trackedOperation;
  },
  removeFromQueue: async (id) => {
    try {
      await invoke('remove_from_queue', { id });
      set((state) => ({
        pendingOrder: state.pendingOrder.filter(x => x !== id)
      }));
    } catch (e) {
      console.error("Failed to remove item from queue:", e);
    }
  },
  backendRegisteredIds: new Set(),
  registerBackendIds: (ids) => set((state) => {
    const nextSet = new Set(state.backendRegisteredIds);
    for (const id of ids) nextSet.add(id);
    return { backendRegisteredIds: nextSet };
  }),
  unregisterBackendIds: (ids) => set((state) => {
    const nextSet = new Set(state.backendRegisteredIds);
    for (const id of ids) nextSet.delete(id);
    return { backendRegisteredIds: nextSet };
  }),
  isAddModalOpen: false,
  pendingAddUrls: '',
  pendingAddReferer: '',
  pendingAddFilename: '',
  pendingAddHeaders: '',
  pendingAddCookies: '',
  pendingAddMediaUrls: [],
  pendingAddBatch: false,
  pendingAddBatchName: '',
  pendingAddRequestContexts: {},
  pendingAddRequestVersion: 0,
  selectedPropertiesDownloadId: null,
  deleteModalState: { isOpen: false },
  openDeleteModal: (downloadIds) => set({ 
    deleteModalState: { 
      isOpen: true, 
      downloadIds: Array.isArray(downloadIds) ? downloadIds : (downloadIds ? [downloadIds] : undefined) 
    } 
  }),
  closeDeleteModal: () => set({ deleteModalState: { isOpen: false } }),
  toggleAddModal: (isOpen) => set((state) => ({
    isAddModalOpen: isOpen,
    pendingAddUrls: '',
    pendingAddReferer: '',
    pendingAddFilename: '',
    pendingAddHeaders: '',
    pendingAddCookies: '',
    pendingAddMediaUrls: [],
    pendingAddBatch: false,
    pendingAddBatchName: '',
    pendingAddRequestContexts: {},
    // Invalidate any in-flight Add-modal handoff even when the modal is
    // opened or closed without URLs.
    pendingAddRequestVersion: state.pendingAddRequestVersion + 1
  })),
  openAddModalWithUrls: (
    urls,
    referer,
    filename,
    headers,
    cookies,
    media = false,
    cookieScopes,
    batch = false,
    batchName
  ) => set((state) => {
    const isAppending = state.isAddModalOpen && Boolean(state.pendingAddUrls);
    const existingUrls = isAppending ? state.pendingAddUrls : '';
    const mergedUrls = existingUrls ? `${existingUrls}\n${urls}` : urls;
    const cleanReferer = referer?.trim() || '';
    const cleanFilename = filename?.trim() || '';
    const cleanHeaders = headers?.trim() || '';
    const cleanCookies = cookies?.trim() || '';
    // Keep the first modal request's grouping decision stable while later
    // handoffs append URLs. This avoids moving an already-visible destination
    // when a second request races with the user's Add-window setup.
    const nextBatch = isAppending ? state.pendingAddBatch : batch;
    const nextBatchName = nextBatch
      ? (isAppending ? state.pendingAddBatchName : batchName?.trim() || '')
      : '';
    const cleanCookieScopes = cookieScopes
      ?.map(scope => ({
        url: scope.url.trim(),
        cookies: scope.cookies.trim()
      }))
      .filter(scope => scope.url && scope.cookies);
    const requestVersion = state.pendingAddRequestVersion + 1;
    const pendingAddRequestContexts = isAppending
      ? { ...state.pendingAddRequestContexts }
      : {};
    // Every handoff gets a versioned row context, including an intentionally
    // empty one. Otherwise a later request for the same URL cannot clear stale
    // cookies/headers from an earlier capture, and batched React renders can
    // lose all but the most recent appended URL.
    for (const rawUrl of urls.split('\n')) {
      const trimmedUrl = rawUrl.trim();
      if (!trimmedUrl) continue;
      let key = trimmedUrl;
      try {
        key = new URL(trimmedUrl).href;
      } catch {
        // The Add modal will mark malformed input invalid; retain its original key here.
      }
      pendingAddRequestContexts[key] = {
        version: requestVersion,
        referer: cleanReferer,
        filename: cleanFilename,
        headers: cleanHeaders,
        cookies: cleanCookies,
        ...(cleanCookieScopes?.length ? { cookieScopes: cleanCookieScopes } : {}),
        media
      };
    }
    const pendingAddMediaUrls = Object.entries(pendingAddRequestContexts)
      .filter(([, context]) => context.media)
      .map(([url]) => url);
    return {
      isAddModalOpen: true,
      pendingAddUrls: mergedUrls,
      pendingAddReferer: cleanReferer,
      pendingAddFilename: cleanFilename,
      pendingAddHeaders: cleanHeaders,
      pendingAddCookies: cleanCookies,
      pendingAddMediaUrls,
      pendingAddBatch: nextBatch,
      pendingAddBatchName: nextBatchName,
      pendingAddRequestContexts,
      pendingAddRequestVersion: requestVersion
    };
  }),
  handleExtensionDownload: async (request) => {
    const urls = [...new Set(request.urls.map(url => url.trim()).filter(Boolean))];
    if (urls.length === 0) return;

    // Explicit media authentication belongs to yt-dlp's configured browser
    // cookie source. Keep this frontend guard for events from older desktop or
    // extension builds; ordinary captured downloads retain their cookies.
    const cookies = request.media === true ? null : request.cookies;
    const headers = request.media === true
      ? stripSensitiveMediaHeaders(request.headers) || null
      : request.headers;

    get().openAddModalWithUrls(
      urls.join('\n'),
      request.referer,
      urls.length === 1 ? request.filename : null,
      headers,
      cookies,
      request.media === true,
      request.media === true ? undefined : request.cookie_scopes,
      request.batch === true && urls.length >= 2,
      request.batch_name
    );
  },
  setSelectedPropertiesDownloadId: (id) => set({ selectedPropertiesDownloadId: id }),
  addDownload: async (item, action) => {
    const settings = useSettingsStore.getState();
    const normalizedItem = {
      ...item,
      fileName: canonicalizeDownloadFileName(item.fileName)
    };
    const destPath = await effectiveDestinationForItem(normalizedItem, settings);
    const queueId = action.type === 'add-to-queue' ? action.queueId : MAIN_QUEUE_ID;
    const queueItems = get().downloads.filter(download =>
      (download.queueId || MAIN_QUEUE_ID) === queueId
    );
    const maxPos = queueItems.reduce((max, d) => Math.max(max, d.queuePosition ?? 0), -1);
    const queuePosition = maxPos + 1;
    const { sizeBytes, ...downloadDraft } = normalizedItem;
    const ownedItem: DownloadItem = {
      ...downloadDraft,
      totalBytes: normalizedItem.totalBytes ?? sizeBytes,
      totalIsEstimate: normalizedItem.totalIsEstimate ?? (
        normalizedItem.isMedia === true && normalizedItem.size?.trim().startsWith('~')
      ),
      connections: resolveDownloadConnections(normalizedItem.connections, settings.perServerConnections),
      destination: destPath,
      status: action.type === 'add-to-queue' ? 'staged' : 'ready',
      queueId,
      queuePosition,
      hasBeenDispatched: false
    };
    advanceDownloadLifecycle(item.id);
    set((state) => ({
      downloads: reorderQueueWithPausedAtEnd([...state.downloads, ownedItem], queueId)
    }));

    if (action.type === 'add-to-queue') {
      info(`Download ${item.id} added to queue ${action.queueId}`);
      return true;
    } else if (action.type === 'start-now') {
      if (await dispatchItem(item.id)) {
        get().updateDownload(item.id, { hasBeenDispatched: true });
        info(`Download ${item.id} started`);
        return true;
      }
      return false;
    }
    return false;
  },
  replaceDownload: (id, updates, action) => runDownloadLifecycleOperation(
    id,
    'replace',
    async () => {
      if (!get().downloads.some(download => download.id === id)) return false;
      await applyPropertiesInternal(id, updates);
      if (!get().downloads.some(download => download.id === id)) return false;
      if (action.type === 'start-now') {
        const resumed = await resumeDownloadInternal(id);
        if (resumed) get().updateDownload(id, { hasBeenDispatched: true });
        return resumed;
      }
      return true;
    },
    false,
    preemptDispatch
  ),
  applyProperties: (id, updates) => runDownloadLifecycleOperation(
    id,
    'properties',
    () => applyPropertiesInternal(id, updates),
    false,
    preemptDispatch
  ),
  updateDownload: (id, updates) => {
    set((state) => {
      const current = state.downloads.find(download => download.id === id);
      if (!current) return { downloads: state.downloads };

      const downloads = state.downloads.map(d => d.id === id
        ? {
            ...d,
            ...updates,
            fraction: updates.fraction !== undefined ? updates.fraction : d.fraction
          }
        : d
      );
      const shouldNormalizeQueue = updates.status === 'paused' ||
        updates.status === 'queued' ||
        updates.status === 'staged';
      const updated = downloads.find(download => download.id === id) ?? current;

      return {
        downloads: shouldNormalizeQueue
          ? reorderQueueWithPausedAtEnd(downloads, updated.queueId || MAIN_QUEUE_ID)
          : downloads,
        ...(updates.status === 'paused'
          ? { pendingOrder: state.pendingOrder.filter(value => value !== id) }
          : {})
      };
    });
    
    if (updates.status && ['completed', 'failed', 'paused'].includes(updates.status)) {
      info(`Download ${id} status changed to ${updates.status}`);
      syncSystemIntegrations();
    } else if (updates.status === 'downloading' || updates.status === 'seeding') {
      info(`Download ${id} status changed to ${updates.status}`);
      syncSystemIntegrations();
    }
  },
  removeDownload: (id, deleteFile = false, preserveResumable = false) => runDownloadLifecycleOperation(
    id,
    `remove:${deleteFile}:${preserveResumable}`,
    async () => {
    await waitForPendingStartupResume();
    clearDownloadControlIntent(id);
    const { pendingDispatch } = await invalidateDispatch(id);
    if (pendingDispatch) {
      await pendingDispatch;
    }
    const item = get().downloads.find(d => d.id === id);

    if (item) {
      await invoke('remove_download', {
        id,
        deleteAssets: deleteFile,
        preserveResumable
      });
    }

    set((state) => ({
      downloads: state.downloads.filter(d => d.id !== id),
      pendingOrder: state.pendingOrder.filter(x => x !== id),
      backendRegisteredIds: new Set(
        Array.from(state.backendRegisteredIds).filter(registeredId => registeredId !== id)
      )
    }));
    useDownloadProgressStore.getState().clearDownloadProgress(id);
    info(`Download ${id} removed`);
    syncSystemIntegrations();
    },
    true,
    preemptDispatch
  ),
  pauseDownload: (id) => runDownloadLifecycleOperation(id, 'pause', async () => {
    await waitForPendingStartupResume();
    if (!get().downloads.some(download => download.id === id)) return;
    setDownloadControlIntent(id, 'pause');
    const { generation, pendingDispatch } = await invalidateDispatch(id);
    try {
      if (pendingDispatch) {
        await pendingDispatch;
      }

      await invoke('pause_download', { id });

      if (!isCurrentDownloadLifecycle(id, generation)) return;
      const current = get().downloads.find(download => download.id === id);
      if (current && current.status !== 'completed' && current.status !== 'failed') {
        get().updateDownload(id, { status: 'paused', speed: '-', eta: '-' });
      }
    } finally {
      clearDownloadControlIntent(id, 'pause');
    }
  }, true, preemptStartSelected),
  redownload: (id) => runDownloadLifecycleOperation(id, 'redownload', async () => {
    await waitForPendingStartupResume();
    const targetItem = get().downloads.find(d => d.id === id);
    if (!targetItem) {
      throw new Error(i18n.t($ => $.downloadTable.redownloadNotFound));
    }

    if (!['completed', 'failed', 'paused'].includes(targetItem.status)) {
      throw new Error(i18n.t($ => $.downloadTable.redownloadActive, {
        status: i18n.t($ => $.downloads.status[targetItem.status])
      }));
    }

    const url = targetItem.url?.trim();
    if (!url) throw new Error(i18n.t($ => $.downloadTable.originalUrlMissing));

    setDownloadControlIntent(id, 'resume');
    await invalidateAndWaitForDispatch(id);

    // Remove from backend to clear its state and delete the existing file so we can overwrite
    try {
      await invoke('remove_download', { id, deleteAssets: true });
      get().unregisterBackendIds([id]);
    } catch (e) {
      console.warn("Could not remove old download from backend", e);
      clearDownloadControlIntent(id, 'resume');
      throw e;
    }

    get().updateDownload(id, {
      status: 'queued',
      fraction: 0,
      speed: '-',
      eta: '-',
      downloadedBytes: undefined,
      totalBytes: undefined,
      totalIsEstimate: undefined,
      hasBeenDispatched: false,
      dateAdded: new Date().toISOString()
    });

    if (!await dispatchItemInternal(id)) {
      console.error("Failed to enqueue redownload");
      get().updateDownload(id, { status: 'failed' });
      clearDownloadControlIntent(id, 'resume');
    } else {
      get().updateDownload(id, { hasBeenDispatched: true });
      info(`Download ${id} redownloaded (queued)`);
    }
  }, true, preemptDispatch),
  resumeDownload: (id, options) => runDownloadLifecycleOperation(
    id,
    'resume',
    () => resumeDownloadInternal(id, options),
    true,
    preemptDispatch
  ),
  startSelected: (ids) => {
    const orderedIds = [...new Set(ids)];
    if (orderedIds.length === 0) return Promise.resolve(0);

    return runDownloadLifecycleOperations(orderedIds, 'start-selected', async () => {
      await waitForPendingStartupResume();
      const selectedByQueue = new Map<string, string[]>();
      for (const id of orderedIds) {
        const item = get().downloads.find(download => download.id === id);
        if (!item || !canStartDownload(item.status)) continue;
        const queueId = item.queueId || MAIN_QUEUE_ID;
        const queueIds = selectedByQueue.get(queueId) || [];
        queueIds.push(id);
        selectedByQueue.set(queueId, queueIds);
      }

      const selectedQueueGenerations = new Map(
        Array.from(selectedByQueue.keys(), queueId => [
          queueId,
          advanceQueueControlGeneration(queueId)
        ] as const)
      );

      // Make the selection's order explicit before any capacity becomes
      // available. This keeps the frontend projection and backend pending
      // queue aligned even when the selected rows were not adjacent.
      for (const [queueId, queueIds] of selectedByQueue) {
        const generation = selectedQueueGenerations.get(queueId);
        if (generation === undefined || !isCurrentQueueControlGeneration(queueId, generation)) {
          continue;
        }
        await get().moveManyInQueueToPosition(queueIds, queueId, 0, null, queueIds);
      }

      let startedCount = 0;
      const startedByQueue = new Map<string, string[]>();
      for (const id of orderedIds) {
        const current = get().downloads.find(download => download.id === id);
        if (!current || !canStartDownload(current.status)) continue;
        const queueId = current.queueId || MAIN_QUEUE_ID;
        const generation = selectedQueueGenerations.get(queueId);
        if (generation === undefined || !isCurrentQueueControlGeneration(queueId, generation)) {
          continue;
        }
        const resumed = await resumeDownloadInternal(id, {
          preserveQueuePosition: true,
          forceRequeue: true
        });
        if (resumed && !isCurrentQueueControlGeneration(queueId, generation)) {
          // A queue pause can win while this item's requeue is in flight. The
          // pause action is allowed to preempt this bulk-start operation so
          // this item cannot remain running after the user's pause request.
          await get().pauseDownload(id);
          continue;
        }
        if (resumed) {
          startedCount += 1;
          const startedIds = startedByQueue.get(queueId) || [];
          startedIds.push(id);
          startedByQueue.set(queueId, startedIds);

          // A requeued paused item is appended by the backend. Move the
          // started prefix immediately so a newly available slot cannot let
          // older pending work overtake the remaining selection while it is
          // still being requeued.
          if (isCurrentQueueControlGeneration(queueId, generation)) {
            await get().moveManyInQueueToPosition(
              startedIds,
              queueId,
              0,
              null,
              startedIds
            );
          }
        }
      }

      // Newly dispatched rows are now visible to the backend pending list.
      // Reapply the same ordered block so existing pending work cannot remain
      // ahead of a user-selected start request.
      for (const [queueId, queueIds] of selectedByQueue) {
        const generation = selectedQueueGenerations.get(queueId);
        if (generation === undefined || !isCurrentQueueControlGeneration(queueId, generation)) {
          continue;
        }
        await get().moveManyInQueueToPosition(queueIds, queueId, 0, null, queueIds);
      }
      return startedCount;
    });
  },
  startQueue: (queueId) => {
    const requestedGeneration = currentQueueControlGeneration(queueId);
    const previousOperation = queueStartPromises.get(queueId) ?? Promise.resolve([]);
    const operation = previousOperation.catch(() => []).then(async () => {
      await waitForPendingStartupResume();
      const runnable = get().downloads
        .filter(item =>
          (item.queueId || MAIN_QUEUE_ID) === queueId &&
          (item.status === 'queued' || canStartDownload(item.status))
        )
        .sort(queuePositionComparator);

      if (runnable.length === 0 || !isCurrentQueueControlGeneration(queueId, requestedGeneration)) return [];

      const needsNewDispatch = runnable.some(item => {
        const currentItem = get().downloads.find(download => download.id === item.id);
        if (!currentItem) return false;
        // Paused rows must go through resumeDownload. This includes rows that
        // were paused before their first dispatch, for which dispatchItem
        // would reject the paused status before reaching the backend.
        if (currentItem.status === 'paused') return false;
        const backendRegistered = get().backendRegisteredIds.has(item.id);
        const backendPending = get().pendingOrder.includes(item.id);
        if (currentItem.status === 'queued' && backendRegistered && !backendPending) {
          return false;
        }
        return currentItem.status === 'ready' ||
          currentItem.status === 'staged' ||
          currentItem.status === 'failed' ||
          !currentItem.hasBeenDispatched ||
          !backendRegistered;
      });
      let queueProxy: string | null | undefined;
      if (needsNewDispatch) {
        try {
          queueProxy = await getProxyArgs(useSettingsStore.getState());
        } catch (error) {
          const message = errorMessage(error);
          console.error(`Could not safely resolve the proxy for queue ${queueId}:`, error);
          const runnableIds = new Set(runnable.map(item => item.id));
          set(state => ({
            downloads: state.downloads.map(item =>
              runnableIds.has(item.id) && item.status !== 'completed'
                ? { ...item, lastError: message }
                : item
            )
          }));
          return [];
        }
      }

      const acceptedIds: string[] = [];
      for (const item of runnable) {
        if (!isCurrentQueueControlGeneration(queueId, requestedGeneration)) break;

        const currentItem = get().downloads.find(download => download.id === item.id);
        if (!currentItem || currentItem.status === 'completed') continue;
        const backendRegistered = get().backendRegisteredIds.has(item.id);
        const backendPending = get().pendingOrder.includes(item.id);

        if (currentItem.status === 'paused') {
          const resumed = await get().resumeDownload(item.id, { preserveQueuePosition: true });
          if (!resumed) continue;
          if (!isCurrentQueueControlGeneration(queueId, requestedGeneration)) {
            const afterResume = get().downloads.find(download => download.id === item.id);
            if (
              backendDispatchPromises.has(item.id) ||
              get().backendRegisteredIds.has(item.id) ||
              (afterResume && canPauseDownload(afterResume.status))
            ) {
              await get().pauseDownload(item.id);
            }
            continue;
          }
          acceptedIds.push(item.id);
          continue;
        }

        if (currentItem.status === 'queued' && backendRegistered && !backendPending) {
          if (await get().resumeDownload(item.id, { preserveQueuePosition: true })) {
            acceptedIds.push(item.id);
          }
          continue;
        }

        if (
          currentItem.status === 'ready' ||
          currentItem.status === 'staged' ||
          currentItem.status === 'failed' ||
          !currentItem.hasBeenDispatched ||
          !backendRegistered
        ) {
          if (await dispatchItem(item.id, queueProxy)) {
            if (!isCurrentQueueControlGeneration(queueId, requestedGeneration)) {
              const afterDispatch = get().downloads.find(download => download.id === item.id);
              if (
                backendDispatchPromises.has(item.id) ||
                get().backendRegisteredIds.has(item.id) ||
                (afterDispatch && canPauseDownload(afterDispatch.status))
              ) {
                await get().pauseDownload(item.id);
              }
              continue;
            }
            const current = get().downloads.find(download => download.id === item.id);
            get().updateDownload(item.id, {
              hasBeenDispatched: true,
              ...(current?.status === item.status ? { status: 'queued' as const } : {})
            });
            acceptedIds.push(item.id);
          }
        } else if (currentItem.status === 'queued') {
          // If it's queued but already dispatched, it might be waiting.
          acceptedIds.push(item.id);
        }
      }

      info(`Queue ${queueId} started, ${acceptedIds.length} items dispatched/resumed`);
      return acceptedIds;
    });
    const trackedOperation = operation.finally(() => {
      if (queueStartPromises.get(queueId) === trackedOperation) {
        queueStartPromises.delete(queueId);
      }
    });
    queueStartPromises.set(queueId, trackedOperation);
    return trackedOperation;
  },
  pauseQueue: async (queueId) => {
    await waitForPendingStartupResume();
    // Invalidate queued starts before taking the snapshot. This prevents a
    // start loop that is waiting on metadata/IPC from dispatching later rows
    // after the user has already requested Pause Queue.
    advanceQueueControlGeneration(queueId);
    const activeIds = get().downloads
      .filter(item =>
        (item.queueId || MAIN_QUEUE_ID) === queueId &&
        (canPauseDownload(item.status) || backendDispatchPromises.has(item.id))
      )
      .map(item => item.id);

    if (activeIds.length === 0) return 0;

    const results = await Promise.allSettled(activeIds.map(id => get().pauseDownload(id)));
    const pausedCount = results.filter(result => result.status === 'fulfilled').length;
    const failedCount = activeIds.length - pausedCount;
    if (failedCount > 0) {
      console.error(`Failed to pause ${failedCount} downloads in queue ${queueId}`);
    }
    info(`Queue ${queueId} paused, ${pausedCount} items paused`);
    syncSystemIntegrations();
    return pausedCount;
  },
  startAll: async () => {
    set(state => ({
      downloads: state.downloads.map(item =>
        item.queueId ? item : { ...item, queueId: MAIN_QUEUE_ID }
      )
    }));
    const queueIds = new Set(
      get().downloads
        .filter(item => item.status === 'queued' || canStartDownload(item.status))
        .map(item => item.queueId || MAIN_QUEUE_ID)
    );
    const results = await Promise.all(Array.from(queueIds, queueId => get().startQueue(queueId)));
    return results.reduce((total, ids) => total + ids.length, 0);
  },
  pauseAll: async () => {
    await waitForPendingStartupResume();
    const queueIds = new Set(
      get().downloads.map(item => item.queueId || MAIN_QUEUE_ID)
    );
    for (const queueId of queueIds) {
      advanceQueueControlGeneration(queueId);
    }
    const activeIds = get().downloads
      .filter(item => canPauseDownload(item.status) || backendDispatchPromises.has(item.id))
      .map(item => item.id);
    if (activeIds.length === 0) return 0;

    const results = await Promise.allSettled(activeIds.map(id => get().pauseDownload(id)));
    const pausedCount = results.filter(result => result.status === 'fulfilled').length;
    syncSystemIntegrations();
    return pausedCount;
  },
  assignToQueue: async (ids, queueId) => {
    await waitForPendingStartupResume();
    const lockedIds = ids.filter(id => get().downloads.some(item => item.id === id));
    return runDownloadLifecycleOperations(lockedIds, 'assign-to-queue', async () => {
      const selectedIds = new Set(ids);
      const selected = get().downloads.filter(item => selectedIds.has(item.id));
      const locked = selected.find(item => isActiveDownloadStatus(item.status) && item.status !== 'queued');
      if (locked) {
        throw new Error(i18n.t($ => $.downloadTable.pauseBeforeMove, { file: locked.fileName }));
      }

      const movableSelected = selected.filter(item => item.status !== 'completed');
      const movableIds = new Set(movableSelected.map(item => item.id));
      await Promise.all(movableSelected.map(item => invalidateAndWaitForDispatch(item.id)));

      for (const item of get().downloads.filter(item => movableIds.has(item.id))) {
        if (!get().backendRegisteredIds.has(item.id)) continue;
        // The UI can still say queued while a dispatch has already reached
        // Aria2/media. Detach through the backend lifecycle owner for every
        // registered item; remove_from_queue only handles the pending list.
        await invoke('detach_download_for_reconfigure', { id: item.id });
        get().unregisterBackendIds([item.id]);
        set(state => ({ pendingOrder: state.pendingOrder.filter(value => value !== item.id) }));
      }

      const queueItems = get().downloads.filter(item =>
        !movableIds.has(item.id) &&
        (item.queueId || MAIN_QUEUE_ID) === queueId
      );
      const maxPos = queueItems.reduce((max, d) => Math.max(max, d.queuePosition ?? 0), -1);
      const nextPosition = maxPos + 1;
      set(state => {
        const downloads = state.downloads.map(item =>
          movableIds.has(item.id) && item.status !== 'completed'
            ? {
                ...item,
                queueId,
                queuePosition: nextPosition + movableSelected.findIndex(selectedItem => selectedItem.id === item.id),
                status: 'staged' as const,
                hasBeenDispatched: false
              }
            : item
        );
        return { downloads: reorderQueueWithPausedAtEnd(downloads, queueId) };
      });
    });
  },
  setDownloadSpeedLimit: (id, limit) => runDownloadLifecycleOperation(
    id,
    'speed-limit',
    async () => {
      await waitForPendingStartupResume();
      const item = get().downloads.find(download => download.id === id);
      if (!item) throw new Error('Download no longer exists.');
      if (item.isMedia) {
        throw new Error('Live speed control is unavailable for media downloads.');
      }
      if (!['downloading', 'retrying'].includes(item.status)) {
        throw new Error('Live speed control requires an active download.');
      }

      const trimmed = limit?.trim() || '';
      const normalizedLimit = trimmed
        ? normalizeSpeedLimitForBackend(trimmed)
        : null;
      if (trimmed && normalizedLimit === null) {
        throw new Error('Enter a valid speed limit.');
      }

      await invoke('set_download_speed_limit', {
        id,
        limit: normalizedLimit
      });
      if (get().downloads.some(download => download.id === id)) {
        get().updateDownload(id, { speedLimit: normalizedLimit ?? undefined });
      }
    },
    true,
    preemptDispatch
  ),
  setTorrentUploadLimit: (id, limit) => runDownloadLifecycleOperation(
    id,
    'torrent-upload-limit',
    async () => {
      await waitForPendingStartupResume();
      const item = get().downloads.find(download => download.id === id);
      if (!item) throw new Error('Download no longer exists.');
      if (!item.isTorrent) {
        throw new Error('Live upload control is available only for Torrent downloads.');
      }
      if (!['downloading', 'seeding', 'retrying'].includes(item.status)) {
        throw new Error('Live upload control requires an active Torrent.');
      }

      const trimmed = limit?.trim() || '';
      const normalizedLimit = trimmed
        ? normalizeSpeedLimitForBackend(trimmed)
        : null;
      if (trimmed && normalizedLimit === null) {
        throw new Error('Enter a valid Torrent upload limit.');
      }

      await invoke('set_torrent_upload_limit', {
        id,
        limit: normalizedLimit
      });
      if (get().downloads.some(download => download.id === id)) {
        get().updateDownload(id, { torrentUploadLimit: normalizedLimit ?? undefined });
      }
    },
    true,
    preemptDispatch
  ),
  setTorrentPeerOptions: (id, maxPeers, peerSpeedLimit) => runDownloadLifecycleOperation(
    id,
    'torrent-peer-options',
    async () => {
      await waitForPendingStartupResume();
      const item = get().downloads.find(download => download.id === id);
      if (!item) throw new Error('Download no longer exists.');
      if (!item.isTorrent) {
        throw new Error('Live peer control is available only for Torrent downloads.');
      }
      if (!['downloading', 'seeding', 'retrying'].includes(item.status)) {
        throw new Error('Live peer control requires an active Torrent.');
      }

      const trimmedMaxPeers = maxPeers?.trim() || '';
      const parsedMaxPeers = trimmedMaxPeers ? Number(trimmedMaxPeers) : null;
      if (
        parsedMaxPeers !== null
        && (!Number.isInteger(parsedMaxPeers) || parsedMaxPeers < 0 || parsedMaxPeers > 1000)
      ) {
        throw new Error('Torrent maximum peers must be an integer between 0 and 1000.');
      }
      const normalizedPeerSpeedLimit = peerSpeedLimit?.trim()
        ? normalizeSpeedLimitForBackend(peerSpeedLimit)
        : null;
      if (peerSpeedLimit?.trim() && normalizedPeerSpeedLimit === null) {
        throw new Error('Enter a valid Torrent peer speed limit.');
      }

      await invoke('set_torrent_peer_options', {
        id,
        max_peers: parsedMaxPeers,
        peer_speed_limit: normalizedPeerSpeedLimit
      });
      if (get().downloads.some(download => download.id === id)) {
        get().updateDownload(id, {
          torrentMaxPeers: parsedMaxPeers === null ? undefined : parsedMaxPeers,
          torrentPeerSpeedLimit: normalizedPeerSpeedLimit ?? undefined
        });
      }
    },
    true,
    preemptDispatch
  ),
  setQueueConcurrency: (id, maxConcurrent) => {
    const operation = queueConfigurationQueue.then(async () => {
      if (
        maxConcurrent !== null
        && (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > MAX_QUEUE_CONCURRENT)
      ) {
        throw new Error('Queue concurrency must be between 1 and 12.');
      }
      const currentQueues = get().queues;
      if (!currentQueues.some(queue => queue.id === id)) {
        throw new Error('Queue no longer exists.');
      }
      const nextQueues = currentQueues.map(queue =>
        queue.id === id
          ? maxConcurrent === null
            ? { id: queue.id, name: queue.name, isMain: queue.isMain }
            : { ...queue, maxConcurrent }
          : queue
      );
      await synchronizeQueueConcurrencyLimits(nextQueues);
      const latestQueues = get().queues;
      if (!latestQueues.some(queue => queue.id === id)) {
        await synchronizeQueueConcurrencyLimits(latestQueues);
        throw new Error('Queue no longer exists.');
      }
      const rebasedQueues = latestQueues.map(queue =>
        queue.id === id
          ? maxConcurrent === null
            ? { id: queue.id, name: queue.name, isMain: queue.isMain }
            : { ...queue, maxConcurrent }
          : queue
      );
      if (!sameQueueConcurrencyConfig(nextQueues, rebasedQueues)) {
        await synchronizeQueueConcurrencyLimits(rebasedQueues);
      }
      set({ queues: rebasedQueues });
    });
    queueConfigurationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  },
  addQueue: (name) => {
    const normalizedName = name.trim();
    if (!normalizedName) return false;
    const duplicate = get().queues.some(queue =>
      queueNameKey(queue.name) === queueNameKey(normalizedName)
    );
    if (duplicate) return false;
    const id = crypto.randomUUID();
    const q = { id, name: normalizedName, isMain: false };
    set((state) => ({
      queues: [...state.queues, q]
    }));
    return true;
  },
  renameQueue: (id, name) => {
    const normalizedName = name.trim();
    if (!normalizedName) return false;
    const duplicate = get().queues.some(queue =>
      queue.id !== id
      && queueNameKey(queue.name) === queueNameKey(normalizedName)
    );
    if (duplicate || !get().queues.some(queue => queue.id === id)) return false;
    set((state) => ({
      queues: state.queues.map(q => {
        if (q.id === id) {
          const newQ = { ...q, name: normalizedName };
          return newQ;
        }
        return q;
      })
    }));
    return true;
  },
  removeQueue: async (id) => {
    if (id === MAIN_QUEUE_ID) return;
    await waitForPendingStartupResume();
    const unfinishedIds = get().downloads
      .filter(download => download.queueId === id && download.status !== 'completed')
      .map(download => download.id);
    if (unfinishedIds.length > 0) {
      await get().assignToQueue(unfinishedIds, MAIN_QUEUE_ID);
    }
    set((state) => ({
      queues: state.queues.filter(q => q.id !== id),
      downloads: state.downloads.map(d => 
        d.queueId === id ? { ...d, queueId: MAIN_QUEUE_ID } : d
      )
    }));
    const settings = useSettingsStore.getState();
    if (settings.scheduler.selectedQueueIds.includes(id)) {
      const selectedQueueIds = settings.scheduler.selectedQueueIds.filter(queueId => queueId !== id);
      settings.setScheduler({
        ...settings.scheduler,
        enabled: selectedQueueIds.length > 0 ? settings.scheduler.enabled : false,
        selectedQueueIds
      });
    }
  },
  resumePendingDownloads: () => {
    if (pendingStartupResume) return pendingStartupResume;

    const operation = (async () => {
      // WaitingToSeed is a paused Aria2 GID owned by the previous process;
      // that GID cannot survive an app restart. Reconstruct the row as a
      // queued Torrent using its persisted remaining seed budget, then let
      // the normal backend admission path assign a fresh lifecycle/GID.
      const waitingToSeedIds = get().downloads
        .filter(download => download.status === 'waitingToSeed')
        .map(download => download.id);
      if (waitingToSeedIds.length > 0) {
        set(state => ({
          downloads: state.downloads.map(download => waitingToSeedIds.includes(download.id)
            ? { ...download, status: 'queued' }
            : download)
        }));
      }
      const active = get().downloads
        .filter(d => d.status === 'queued')
        .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
      if (active.length === 0) return;

      try {
        const settings = useSettingsStore.getState();
        let proxy: string | null;
        try {
          proxy = await getProxyArgs(settings);
        } catch (error) {
          const message = errorMessage(error);
          console.error('Could not safely resolve the system proxy during startup resume:', error);
          const activeIds = new Set(active.map(item => item.id));
          set(state => ({
            downloads: state.downloads.map(item =>
              activeIds.has(item.id) && item.status === 'queued'
                ? { ...item, lastError: message }
                : item
            )
          }));
          return;
        }
        const itemsToEnqueue = [];
        for (const pendingItem of active) {
          const item = get().downloads.find(download => download.id === pendingItem.id);
          if (!item || item.status !== 'queued' || get().backendRegisteredIds.has(item.id)) continue;

          const login = getSiteLogin(item.url, settings);
          let keychainPassword = null;
          if (login && !item.password && settings.keychainAccessReady) {
            try {
              keychainPassword = await invoke('get_keychain_password', { id: login.id });
            } catch (e) {
              console.warn("Could not fetch keychain password for login:", e);
            }
          }
          const destPath = item.destination ||
            await resolveCategoryDestination(settings, item.category);
          itemsToEnqueue.push({
            id: item.id,
            queue_id: item.queueId || MAIN_QUEUE_ID,
            url: item.url,
            destination: destPath,
            filename: item.fileName,
            connections: resolveDownloadConnections(item.connections, settings.perServerConnections),
            speed_limit: speedLimitForDispatch(item.speedLimit, settings.globalSpeedLimit, item.isMedia),
            username: item.username || (login ? login.username : null),
            password: item.password || keychainPassword,
            headers: item.headers || null,
            checksum: item.checksum || null,
            cookies: item.cookies || null,
            mirrors: item.mirrors || null,
            user_agent: settings.customUserAgent.trim() || null,
            max_tries: settings.maxAutomaticRetries,
            proxy,
            format_selector: item.mediaFormatSelector || null,
            cookie_source: settings.mediaCookieSource !== 'none' ? settings.mediaCookieSource : null,
            is_media: item.isMedia || false,
            is_torrent: item.isTorrent || false,
            torrent_path: item.torrentPath || undefined,
            torrent_file_indices: item.torrentFileIndices || undefined,
            torrent_info_hash: item.torrentInfoHash || undefined,
            torrent_seed_time: item.torrentSeedTime,
            torrent_seed_ratio: item.torrentSeedRatio,
            torrent_seed_remaining: item.torrentSeedRemaining,
            torrent_web_seeds: item.torrentWebSeeds,
            torrent_upload_limit: item.torrentUploadLimit || undefined,
            torrent_max_peers: item.torrentMaxPeers,
            torrent_peer_speed_limit: item.torrentPeerSpeedLimit || undefined,
            torrent_check_integrity: item.torrentCheckIntegrity || item.torrentRelocationCheckPending,
            torrent_trackers: item.torrentTrackers || undefined,
            torrent_exclude_trackers: item.torrentExcludeTrackers || undefined,
            torrent_tracker_connect_timeout: item.torrentTrackerConnectTimeout,
            torrent_tracker_timeout: item.torrentTrackerTimeout,
            torrent_tracker_interval: item.torrentTrackerInterval,
            torrent_stop_timeout: item.torrentStopTimeout,
            torrent_prioritize_piece: item.torrentPrioritizePiece || undefined,
            torrent_remove_unselected_file: item.torrentRemoveUnselectedFile,
            torrent_encryption_policy: item.torrentEncryptionPolicy || undefined,
            torrent_file_allocation: item.torrentFileAllocation || undefined,
            torrent_verify_only: item.torrentVerifyOnly,
            torrent_verify_restore_status: item.torrentVerifyRestoreStatus,
            lifecycle_generation: currentDownloadLifecycle(item.id).toString(),
          });
        }

        const currentItems = new Map(get().downloads.map(item => [item.id, item]));
        const dispatchableItems = itemsToEnqueue.filter(item => {
          const current = currentItems.get(item.id);
          return current &&
            current.status === 'queued' &&
            !get().backendRegisteredIds.has(item.id) &&
            !backendDispatchPromises.has(item.id) &&
            currentDownloadLifecycle(item.id).toString() === item.lifecycle_generation;
        });
        if (dispatchableItems.length === 0) return;

        const results = await invoke('enqueue_many', { items: dispatchableItems });
        const registeredIds = results.filter(result => result.success).map(result => result.id);
        const failedErrors = new Map(
          results
            .filter(result => !result.success)
            .map(result => [result.id, result.error || 'Backend rejected the queued download.'])
        );
        const acceptedFilenames = new Map(
          results
            .filter(result => result.success && Boolean(result.filename))
            .map(result => [result.id, result.filename!])
        );
        const acceptedIdSet = new Set(registeredIds);
        const generationById = new Map(dispatchableItems.map(item => [item.id, item.lifecycle_generation]));

        // Commit backend ownership as soon as enqueue_many accepts an item.
        // The order query is a separate best-effort view read; if it fails,
        // forgetting these registrations would let a later queue start
        // enqueue the same backend lifecycle a second time.
        set(state => {
          // A very fast backend transfer can emit a terminal event before
          // this batch result is merged. Preserve that event's ownership
          // cleanup instead of re-registering an already-terminal ID.
          const liveAcceptedIds = new Set(
            state.downloads
              .filter(download =>
                acceptedIdSet.has(download.id) &&
                download.status !== 'completed' &&
                download.status !== 'failed' &&
                currentDownloadLifecycle(download.id).toString() === generationById.get(download.id)
              )
              .map(download => download.id)
          );
          return {
            backendRegisteredIds: new Set([
              ...state.backendRegisteredIds,
              ...liveAcceptedIds
            ]),
            downloads: state.downloads.map(download =>
              failedErrors.has(download.id)
                ? {
                    ...download,
                    status: 'failed' as const,
                    lastError: failedErrors.get(download.id)
                  }
                : liveAcceptedIds.has(download.id)
                  ? {
                      ...download,
                      ...(acceptedFilenames.has(download.id)
                        ? {
                            fileName: acceptedFilenames.get(download.id),
                            category: categoryForFileName(acceptedFilenames.get(download.id)!)
                          }
                        : {}),
                      hasBeenDispatched: true,
                      lastError: undefined
                    }
                  : download
            )
          };
        });

        // A cancellation can race with the batch RPC. Use the lifecycle-aware
        // cancellation command for any accepted generation that is no longer
        // current; never remove by ID because a newer lifecycle could already
        // own that same download row.
        await Promise.all(registeredIds
          .filter(id => !get().backendRegisteredIds.has(id))
          .map(id => {
            const generation = generationById.get(id);
            if (generation === undefined) return Promise.resolve();
            return invoke('cancel_enqueue_generation', {
              id,
              generation
            }).catch(error => {
              console.warn(`Failed to cancel stale startup enqueue for ${id}:`, error);
            });
          }));

        try {
          const order = await invoke('get_pending_order', { queueId: null });
          set({ pendingOrder: order });
        } catch (e) {
          console.error("Failed to refresh pending order after auto-resume:", e);
        }
      } catch (e) {
        console.error("Failed to auto-resume active downloads:", e);
        throw e;
      }
    })();
    const trackedOperation = operation.finally(() => {
      if (pendingStartupResume === trackedOperation) pendingStartupResume = null;
    });
    pendingStartupResume = trackedOperation;
    return trackedOperation;
  },
  initDB: async () => {
    try {
      const persistedQueues = (await invoke('db_get_all_queues')).flatMap(value => {
        try {
          return [JSON.parse(value) as PersistedQueue];
        } catch {
          console.warn('Skipping malformed persisted queue record during startup');
          return [];
        }
      });
      const normalizedQueueState = normalizePersistedQueueState(persistedQueues);
      const queues = normalizedQueueState.queues;
      const knownQueueIds = new Set(queues.map(queue => queue.id));
      const downloads = (await invoke('db_get_all_downloads')).flatMap(value => {
        try {
          const parsed: unknown = JSON.parse(value);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('persisted download is not an object');
          }
          return [parsed as DownloadItem];
        } catch {
          console.warn('Skipping malformed persisted download record during startup');
          return [];
        }
      }).map(download => {
        const persistedQueueId = download.queueId || MAIN_QUEUE_ID;
        const queueId = normalizedQueueState.queueIdRemap.get(persistedQueueId)
          || (knownQueueIds.has(persistedQueueId) ? persistedQueueId : MAIN_QUEUE_ID);
        return normalizePersistedDownloadProgress({ ...download, queueId });
      });
      
      set(state => ({
        queues,
        downloads: downloads.length > 0
          ? normalizeQueuePositions(downloads)
          : state.downloads
      }));

      // A process can die after Aria2 has removed the unselected files but
      // before the terminal event clears Firelink's reservation. Reclaim
      // only the conservative terminal cases in the backend before queued
      // downloads are allowed to claim paths on startup.
      try {
        await invoke('reconcile_torrent_removal_reservations');
      } catch (error) {
        console.warn('Could not reconcile Torrent removal reservations during startup:', error);
      }

      // The backend dispatcher is live before the frontend finishes startup.
      // Synchronize the normalized queue policy before any saved download is
      // allowed to claim a permit.
      await synchronizeQueueConcurrencyLimits(queues);
      
      // Reset interrupted active downloads to queued.
      set((state) => ({
        downloads: normalizeQueuePositions(state.downloads.map(d =>
          isActiveDownloadStatus(d.status) && d.status !== 'queued'
            ? { ...d, status: 'queued' as const }
            : d
        ))
      }));

    } catch (e) {
      console.error("Failed to init DB", e);
      throw e;
    }
  }
  };
});

let lastSavedDownloads = '';
let isSavingDownloads = false;
let nextDownloadsData: string | null = null;

async function processDownloadsSave() {
  if (isSavingDownloads || !nextDownloadsData) return;
  isSavingDownloads = true;
  while (nextDownloadsData) {
    const data = nextDownloadsData;
    nextDownloadsData = null;
    try {
      await invoke('db_replace_downloads', { data });
    } catch (error) {
      console.error('Failed to persist downloads:', error);
    }
  }
  isSavingDownloads = false;
}

let lastSavedQueues = '';
let isSavingQueues = false;
let nextQueuesData: string | null = null;

async function processQueuesSave() {
  if (isSavingQueues || !nextQueuesData) return;
  isSavingQueues = true;
  while (nextQueuesData) {
    const data = nextQueuesData;
    nextQueuesData = null;
    try {
      await invoke('db_replace_queues', { data });
    } catch (error) {
      console.error('Failed to persist queues:', error);
    }
  }
  isSavingQueues = false;
}

let downloadPersistenceUnsubscribe: (() => void) | null = null;

/**
 * Persistence is a main-webview service. Properties windows import the
 * download types and bridge helpers but must never install this subscription
 * or write whole-store snapshots from a child webview.
 */
export const initializeDownloadPersistence = (windowLabel: string): (() => void) => {
  if (windowLabel !== 'main' || downloadPersistenceUnsubscribe) return () => undefined;

  downloadPersistenceUnsubscribe = useDownloadStore.subscribe((state, prevState) => {
    if (state.queues !== prevState.queues) {
      const data = JSON.stringify(state.queues);
      if (data !== lastSavedQueues) {
        lastSavedQueues = data;
        nextQueuesData = data;
        void processQueuesSave();
      }
    }

    if (state.downloads !== prevState.downloads) {
      // Strip secret fields (password/cookies/headers) and volatile progress
      // before writing to disk. Secrets remain on the in-memory item for the
      // active session only.
      const staticDownloads = state.downloads.map(redactDownloadForPersistence);
      const currentSerialized = JSON.stringify(staticDownloads);
      if (currentSerialized !== lastSavedDownloads) {
        lastSavedDownloads = currentSerialized;
        nextDownloadsData = currentSerialized;
        void processDownloadsSave();
      }
    }
  });

  return () => {
    downloadPersistenceUnsubscribe?.();
    downloadPersistenceUnsubscribe = null;
  };
};

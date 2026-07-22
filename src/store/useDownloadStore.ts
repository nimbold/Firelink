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
import { categoryForFileName, isActiveDownloadStatus, isTransferActiveStatus, normalizeSpeedLimitForBackend, redactDownloadForPersistence, resolveDownloadConnections } from '../utils/downloads';
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
type DownloadLifecycleOperation = {
  kind: string;
  promise: Promise<unknown>;
};
const downloadLifecycleOperations = new Map<string, DownloadLifecycleOperation>();
const preemptDispatch = ['dispatch'] as const;
let pendingStartupResume: Promise<void> | null = null;

type DownloadControlIntent = 'pause' | 'resume';
const downloadControlIntents = new Map<string, DownloadControlIntent>();

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

const queuePositionComparator = (left: DownloadItem, right: DownloadItem): number =>
  (left.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.queuePosition ?? Number.MAX_SAFE_INTEGER) ||
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
  return downloads.map(download => {
    const queueId = download.queueId || MAIN_QUEUE_ID;
    const position = nextPosition.get(queueId) || 0;
    nextPosition.set(queueId, position + 1);
    return {
      ...download,
      queueId,
      queuePosition: download.queuePosition ?? position
    };
  });
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

export const normalizePersistedDownloadProgress = (download: DownloadItem): DownloadItem =>
  hasStaleTemporaryMediaEstimate(download)
    ? {
        ...download,
        // The old lifecycle could persist yt-dlp's temporary HLS estimate as
        // both the numeric denominator and the visible size. Neither value is
        // recoverable after the fact, so remove the false claim on startup.
        size: undefined,
        totalBytes: undefined,
        totalIsEstimate: undefined
      }
    : download;

export type { DownloadStatus };
export const MAIN_QUEUE_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_MAIN_QUEUE_NAME = 'Main Queue';

const queueNameKey = (name: string): string => name.trim().toLowerCase();

export const normalizePersistedQueueState = (queues: Queue[]) => {
  const validQueues = queues.filter(queue =>
    queue && typeof queue.id === 'string' && typeof queue.name === 'string'
  );
  const persistedMain = validQueues.find(queue => queue.id === MAIN_QUEUE_ID)
    || validQueues.find(queue => queue.isMain);
  const persistedMainId = persistedMain?.id.trim();
  const mainName = persistedMain?.name.trim() || DEFAULT_MAIN_QUEUE_NAME;
  const normalized: Queue[] = [{ id: MAIN_QUEUE_ID, name: mainName, isMain: true }];
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
    normalized.push({ id, name, isMain: false });
  }

  return { queues: normalized, queueIdRemap };
};

export const normalizePersistedQueues = (queues: Queue[]): Queue[] =>
  normalizePersistedQueueState(queues).queues;

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
  moveManyInQueueToPosition: (ids: string | string[], queueId: string, targetIndex: number) => Promise<void>;
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
  resumeDownload: (id: string) => Promise<boolean>;
  startQueue: (queueId: string) => Promise<string[]>;
  pauseQueue: (queueId: string) => Promise<number>;
  startAll: () => Promise<number>;
  pauseAll: () => Promise<number>;
  assignToQueue: (ids: string[], queueId: string) => Promise<void>;
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

    if (item.status === 'downloading' || item.status === 'processing' || item.status === 'retrying') {
      throw new Error(i18n.t($ => $.downloadTable.transferActive));
    }

    if (item.status === 'ready' || item.status === 'staged' || item.status === 'completed' || item.status === 'failed') {
      state.updateDownload(id, updates);
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
      state.updateDownload(id, updates);
      if (isRegistered || wasDispatching) {
        const dispatched = await dispatchItemInternal(id);
        if (dispatched) {
          state.updateDownload(id, { hasBeenDispatched: true });
        } else {
          state.removeFromQueue(id);
        }
      }
    } else if (item.status === 'paused') {
      if (isRegistered) {
        try {
          await invoke('detach_download_for_reconfigure', { id });
        } catch (e) {
          console.error("Failed to detach for reconfigure:", e);
          throw e; // Preserve old properties if detach fails
        }
        state.unregisterBackendIds([id]);
      }
      state.updateDownload(id, updates);
    }
  };

  const resumeDownloadInternal = async (id: string): Promise<boolean> => {
    await waitForPendingStartupResume();
    const targetItem = get().downloads.find(d => d.id === id);
    if (!targetItem) return false;

    setDownloadControlIntent(id, 'resume');
    try {
      if (targetItem.status === 'ready' || targetItem.status === 'staged') {
        get().updateDownload(id, { status: 'queued', hasBeenDispatched: true });
        if (await dispatchItemInternal(id)) {
          return true;
        }
        get().updateDownload(id, { status: targetItem.status });
        clearDownloadControlIntent(id, 'resume');
        return false;
      }

      const prevStatus = targetItem.status;
      const queueItems = get().downloads.filter(d =>
        (d.queueId || MAIN_QUEUE_ID) === (targetItem.queueId || MAIN_QUEUE_ID)
      );
      const maxPos = queueItems.reduce((max, d) => Math.max(max, d.queuePosition ?? 0), -1);

      get().updateDownload(id, {
        status: 'queued',
        speed: '-',
        eta: '-',
        queuePosition: maxPos + 1,
        lastTry: new Date().toISOString()
      });

      const resumedExisting = await invoke('resume_download', { id });

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
        return true;
      } else {
        console.error("Failed to re-enqueue for resume");
        get().updateDownload(id, { status: prevStatus });
        clearDownloadControlIntent(id, 'resume');
        return false;
      }
    } catch (e) {
      console.error("Failed to resume download:", e);
      get().updateDownload(id, { status: targetItem.status });
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
  moveManyInQueueToPosition: (idOrIds, queueId, targetIndex) => {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    if (ids.length === 0) return Promise.resolve();

    // Dragging must be one serialized, atomic queue operation. This prevents
    // a second drag or a keyboard move from calculating against stale order
    // while the backend is still applying the first drop.
    const previousOperation = queueReorderPromises.get(queueId) ?? Promise.resolve();
    const operation = previousOperation.catch(() => undefined).then(async () => {
      const allDownloads = get().downloads;
      const queueItems = queueItemsForReordering(allDownloads, queueId);
      const selectedItems = queueItems.filter(item => ids.includes(item.id));
      if (selectedItems.length === 0) return;

      const selectedIds = new Set(selectedItems.map(item => item.id));
      const previousPositions = new Map([
        ...activeQueueItems(allDownloads, queueId),
        ...queueItems
      ].map(item => [item.id, item.queuePosition]));
      const reordered = moveSelectedBlockToIndex(queueItems, selectedIds, targetIndex);
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
    const destPath = await effectiveDestinationForItem(item, settings);
    const queueId = action.type === 'add-to-queue' ? action.queueId : MAIN_QUEUE_ID;
    const queueItems = get().downloads.filter(download =>
      (download.queueId || MAIN_QUEUE_ID) === queueId
    );
    const maxPos = queueItems.reduce((max, d) => Math.max(max, d.queuePosition ?? 0), -1);
    const queuePosition = maxPos + 1;
    const { sizeBytes, ...downloadDraft } = item;
    const ownedItem: DownloadItem = {
      ...downloadDraft,
      totalBytes: item.totalBytes ?? sizeBytes,
      totalIsEstimate: item.totalIsEstimate ?? (
        item.isMedia === true && item.size?.trim().startsWith('~')
      ),
      connections: resolveDownloadConnections(item.connections, settings.perServerConnections),
      destination: destPath,
      status: action.type === 'add-to-queue' ? 'staged' : 'ready',
      queueId,
      queuePosition,
      hasBeenDispatched: false
    };
    advanceDownloadLifecycle(item.id);
    set((state) => ({ downloads: [...state.downloads, ownedItem] }));

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
    set((state) => ({
      downloads: state.downloads.map(d => {
        if (d.id === id) {
          const updated = { 
            ...d, 
            ...updates,
            fraction: updates.fraction !== undefined ? updates.fraction : d.fraction
          };
          return updated;
        }
        return d;
      })
    }));
    
    if (updates.status && ['completed', 'failed', 'paused'].includes(updates.status)) {
      info(`Download ${id} status changed to ${updates.status}`);
      syncSystemIntegrations();
    } else if (updates.status === 'downloading') {
      info(`Download ${id} status changed to downloading`);
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
  }, true, preemptDispatch),
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
  resumeDownload: (id) => runDownloadLifecycleOperation(
    id,
    'resume',
    () => resumeDownloadInternal(id),
    true,
    preemptDispatch
  ),
  startQueue: (queueId) => {
    const requestedGeneration = currentQueueControlGeneration(queueId);
    const previousOperation = queueStartPromises.get(queueId) ?? Promise.resolve([]);
    const operation = previousOperation.catch(() => []).then(async () => {
      await waitForPendingStartupResume();
      const runnable = get().downloads
        .filter(item => item.queueId === queueId && (item.status === 'queued' || canStartDownload(item.status)))
        .sort(queuePositionComparator);

      if (runnable.length === 0 || !isCurrentQueueControlGeneration(queueId, requestedGeneration)) return [];

      const needsNewDispatch = runnable.some(item => {
        const currentItem = get().downloads.find(download => download.id === item.id);
        if (!currentItem) return false;
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

        if (currentItem.status === 'queued' && backendRegistered && !backendPending) {
          if (await get().resumeDownload(item.id)) {
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
        } else if (currentItem.status === 'paused' || currentItem.status === 'queued') {
          // If it's queued but already dispatched, it might be waiting.
          // If it's paused, we resume it.
          if (currentItem.status === 'paused') {
            if (!await get().resumeDownload(item.id)) continue;
          }
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
        item.queueId === queueId &&
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
      set(state => ({
        downloads: state.downloads.map(item =>
          movableIds.has(item.id) && item.status !== 'completed'
            ? {
                ...item,
                queueId,
                queuePosition: nextPosition + movableSelected.findIndex(selectedItem => selectedItem.id === item.id),
                status: 'staged' as const,
                hasBeenDispatched: false
              }
            : item
        )
      }));
    });
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
                  ? { ...download, hasBeenDispatched: true, lastError: undefined }
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
          return [JSON.parse(value) as Queue];
        } catch {
          console.warn('Skipping malformed persisted queue record during startup');
          return [];
        }
      });
      const normalizedQueueState = normalizePersistedQueueState(persistedQueues);
      const queues = normalizedQueueState.queues;
      const knownQueueIds = new Set(queues.map(queue => queue.id));
      const downloads = (await invoke('db_get_all_downloads')).map(
        value => JSON.parse(value) as DownloadItem
      ).map(download => {
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
      
      // Reset interrupted active downloads to queued.
      set((state) => ({
        downloads: state.downloads.map(d =>
          isActiveDownloadStatus(d.status) && d.status !== 'queued'
            ? { ...d, status: 'queued' as const }
            : d
        )
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

useDownloadStore.subscribe((state, prevState) => {
  if (state.queues !== prevState.queues) {
    const data = JSON.stringify(state.queues);
    if (data !== lastSavedQueues) {
      lastSavedQueues = data;
      nextQueuesData = data;
      processQueuesSave();
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
      processDownloadsSave();
    }
  }
});

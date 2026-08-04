import { emitTo } from '@tauri-apps/api/event';
import type { DownloadItem } from './store/useDownloadStore';
import { invokeCommand as invoke } from './ipc';

export const PROPERTIES_WINDOW_READY = 'properties-window-ready' as const;
export const PROPERTIES_WINDOW_SNAPSHOT = 'properties-window-snapshot' as const;
export const PROPERTIES_WINDOW_ACTION_REQUEST = 'properties-window-action-request' as const;
export const PROPERTIES_WINDOW_ACTION_RESULT = 'properties-window-action-result' as const;
export const PROPERTIES_WINDOW_REMOVED = 'properties-window-removed' as const;
export const PROPERTIES_WINDOW_CLOSED = 'properties-window-closed' as const;

export type PropertiesSnapshot = Omit<DownloadItem, 'password' | 'cookies' | 'headers' | 'username'> & {
  hasPassword: boolean;
  hasCookies: boolean;
  hasHeaders: boolean;
  hasUsername: boolean;
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
  | 'set-download-limit'
  | 'set-torrent-upload-limit'
  | 'set-torrent-peer-options';

export type PropertiesWindowReady = {
  windowLabel: string;
  downloadId: string;
};

export type PropertiesActionRequest = {
  windowLabel: string;
  downloadId: string;
  requestId: number;
  action: PropertiesAction;
  payload?: PropertiesPatch | { limit: string | null } | { maxPeers: string | null; peerSpeedLimit: string | null };
};

export type PropertiesActionResult = {
  windowLabel: string;
  downloadId: string;
  requestId: number;
  ok: boolean;
  error?: string;
};

export type PropertiesSnapshotEvent = {
  windowLabel: string;
  downloadId: string;
  revision: number;
  snapshot: PropertiesSnapshot;
};

const copyWithoutSecrets = (item: DownloadItem): PropertiesSnapshot => {
  const {
    password,
    cookies,
    headers,
    username,
    ...safeItem
  } = item;
  return {
    ...safeItem,
    hasPassword: Boolean(password),
    hasCookies: Boolean(cookies),
    hasHeaders: Boolean(headers),
    hasUsername: Boolean(username),
  };
};

export const sanitizePropertiesSnapshot = copyWithoutSecrets;

export const openPropertiesWindow = (downloadId: string): Promise<string> =>
  invoke('open_download_properties_window', { id: downloadId });

export const sendPropertiesReady = (): Promise<void> =>
  invoke('properties_window_send_ready');

export const sendPropertiesActionRequest = (payload: PropertiesActionRequest): Promise<void> =>
  invoke('properties_window_send_action', {
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

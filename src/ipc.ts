import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { error as logError } from './utils/logger';
import { listen as tauriListen, type Event, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event';
import type { DownloadCategory } from './bindings/DownloadCategory';
import type { DownloadProgressEvent } from './bindings/DownloadProgressEvent';
import type { DownloadStateEvent } from './bindings/DownloadStateEvent';
import type { ExtensionDownload } from './bindings/ExtensionDownload';
import type { ExtensionCookieScope } from './bindings/ExtensionCookieScope';
import type { MediaMetadata } from './bindings/MediaMetadata';
import type { MediaPlaylistMetadata } from './bindings/MediaPlaylistMetadata';
import type { MetadataResponse } from './bindings/MetadataResponse';
import type { EngineStatusItem } from './bindings/EngineStatusItem';
import type { PostQueueAction } from './bindings/PostQueueAction';
import type { ReleaseCheckOutcome } from './bindings/ReleaseCheckOutcome';
import type { PairingTokenHydration } from './bindings/PairingTokenHydration';
import type { KeychainGrantStatus } from './bindings/KeychainGrantStatus';
import type { EnqueueItem } from './bindings/EnqueueItem';
import type { EnqueueAccepted } from './bindings/EnqueueAccepted';
import type { PlatformInfo } from './bindings/PlatformInfo';
import type { QueueConcurrencyConfig } from './bindings/QueueConcurrencyConfig';
import type { TorrentMetadata } from './bindings/TorrentMetadata';
import type { TorrentPeerDiagnostics } from './bindings/TorrentPeerDiagnostics';
import type { TorrentFileProgressSnapshot } from './bindings/TorrentFileProgressSnapshot';
import type { TorrentPieceProgressSnapshot } from './bindings/TorrentPieceProgressSnapshot';
import type { TorrentWebSeed } from './bindings/TorrentWebSeed';
import type { TorrentDetails } from './bindings/TorrentDetails';
import type { TorrentFileSelectionSnapshot } from './bindings/TorrentFileSelectionSnapshot';
import type { TorrentAvailabilitySnapshot } from './bindings/TorrentAvailabilitySnapshot';

type CommandMap = {
  fetch_metadata: {
    args: { url: string; userAgent: string | null; username: string | null; password: string | null; headers: string | null; cookies: string | null; cookieScopes: Array<ExtensionCookieScope> | null; proxy: string | null; deferCookies?: boolean };
    result: MetadataResponse;
  };
  fetch_media_metadata: {
    args: { url: string; cookieBrowser: string | null; userAgent: string | null; username: string | null; password: string | null; headers: string | null; cookies: string | null; proxy: string | null };
    result: MediaMetadata;
  };
  fetch_media_playlist_metadata: {
    args: { url: string; cookieBrowser: string | null; userAgent: string | null; username: string | null; password: string | null; headers: string | null; cookies: string | null; proxy: string | null };
    result: MediaPlaylistMetadata;
  };
  inspect_torrent: {
    args: {
      source: string;
      id: string;
      cache?: boolean;
      proxy?: string;
      headers?: string;
      cookies?: string;
      cookieScopes?: Array<ExtensionCookieScope>;
      torrent?: boolean;
    };
    result: TorrentMetadata;
  };
  rekey_torrent_metadata: {
    args: { sourceId: string; targetId: string };
    result: string;
  };
  remove_torrent_metadata: {
    args: { id: string };
    result: void;
  };
 get_aria2_engine_status: { args: undefined; result: EngineStatusItem };
 get_ytdlp_engine_status: { args: undefined; result: EngineStatusItem };
 get_ffmpeg_engine_status: { args: undefined; result: EngineStatusItem };
 get_deno_engine_status: { args: undefined; result: EngineStatusItem };
  reveal_in_file_manager: { args: { path: string }; result: void };
  open_downloaded_file: { args: { path: string }; result: void };
  pause_download: { args: { id: string }; result: void };
  resume_download: { args: { id: string; queueId: string }; result: boolean };
  remove_download: { args: { id: string; deleteAssets: boolean; preserveResumable?: boolean }; result: void };
  get_download_primary_path: { args: { id: string }; result: string | null };
  detach_download_for_reconfigure: { args: { id: string }; result: void };
  clear_torrent_removal_paths: { args: { id: string }; result: void };
  reconcile_torrent_removal_reservations: { args: undefined; result: number };
  begin_dock_badge_session: { args: undefined; result: number };
  update_dock_badge: { args: { count: number; generation: number; session: number }; result: void };
  get_platform_info: { args: undefined; result: PlatformInfo };
  approve_download_root: { args: { path: string }; result: string };
  set_prevent_sleep: { args: { prevent: boolean }; result: void };
  set_power_preferences: {
    args: { preventSystemSleep: boolean; preventDisplaySleep: boolean };
    result: void;
  };
  perform_system_action: { args: { action: PostQueueAction; force: boolean }; result: void };
  ack_schedule_trigger: { args: { action: 'start' | 'stop'; key: string }; result: void };
  set_concurrent_limit: { args: { limit: number }; result: void };
  set_queue_concurrency_limits: { args: { limits: QueueConcurrencyConfig[] }; result: void };
  set_download_speed_limit: { args: { id: string; limit: string | null }; result: void };
  set_torrent_upload_limit: { args: { id: string; limit: string | null }; result: void };
  set_torrent_peer_options: {
    args: { id: string; max_peers: number | null; peer_speed_limit: string | null };
    result: void;
  };
  get_torrent_peers: { args: { id: string }; result: TorrentPeerDiagnostics };
  get_torrent_file_progress: { args: { id: string }; result: TorrentFileProgressSnapshot };
  get_torrent_piece_progress: { args: { id: string }; result: TorrentPieceProgressSnapshot };
  get_torrent_file_selection: { args: { id: string }; result: TorrentFileSelectionSnapshot };
  set_torrent_file_selection: { args: { id: string; selected_indices: number[] | null }; result: TorrentFileSelectionSnapshot };
  get_torrent_details: { args: { id: string }; result: TorrentDetails };
  get_torrent_availability: { args: { id: string }; result: TorrentAvailabilitySnapshot };
  verify_torrent_data: { args: { id: string }; result: void };
  get_torrent_magnet_link: { args: { id: string }; result: string };
  export_torrent_metadata: { args: { id: string; destination: string }; result: void };
  move_torrent_data: { args: { id: string; destination: string; sessionId?: string }; result: void };
  cancel_torrent_move_data: { args: { id: string; sessionId?: string }; result: void };
  get_torrent_web_seeds: { args: { id: string }; result: TorrentWebSeed[] };
  set_torrent_web_seeds: { args: { id: string; seeds: TorrentWebSeed[] }; result: TorrentWebSeed[] };
  set_torrent_max_open_files: { args: { max_open_files: number }; result: void };
  set_torrent_overall_upload_limit: { args: { limit: string | null }; result: void };
  set_global_speed_limit: { args: { limit: string | null }; result: void };
  request_automation_permission: { args: undefined; result: void };
  check_automation_permission: { args: undefined; result: void };
  open_automation_settings: { args: undefined; result: void };
  get_free_space: { args: { path: string }; result: string };
  set_keychain_password: { args: { id: string; password: string }; result: void };
  get_keychain_password: { args: { id: string }; result: string };
  delete_keychain_password: { args: { id: string }; result: void };
  save_site_login: {
    args: { id: string; urlPattern: string; username: string; password: string };
    result: void;
  };
  delete_site_login: { args: { id: string }; result: void };
  check_file_exists: { args: { path: string }; result: boolean };
  toggle_tray_icon: { args: { show: boolean }; result: void };
  set_extension_pairing_token: { args: { token: string }; result: void };
  get_extension_server_port: { args: undefined; result: number | null };
  hydrate_extension_pairing_token: { args: undefined; result: PairingTokenHydration };
  get_session_pairing_token: { args: undefined; result: PairingTokenHydration };
  authorize_keychain_access: { args: undefined; result: void };
  regenerate_pairing_token: { args: undefined; result: PairingTokenHydration };
  grant_keychain_access: { args: { requestId: string }; result: void };
  get_keychain_grant_status: { args: { requestId: string }; result: KeychainGrantStatus };
  accept_keychain_grant: { args: { requestId: string }; result: PairingTokenHydration };
  abandon_keychain_grant: { args: { requestId: string }; result: PairingTokenHydration | null };
  acknowledge_pairing_token_change: { args: undefined; result: void };
  set_extension_frontend_ready: { args: { ready: boolean }; result: void };
  ack_frontend_exit: { args: undefined; result: void };
  ack_extension_download: { args: { requestId: string }; result: void };
  get_system_proxy: { args: undefined; result: string | null };
  get_file_category: { args: { filename: string }; result: DownloadCategory };
  check_for_updates: { args: undefined; result: ReleaseCheckOutcome };
  get_supported_media_domains: { args: undefined; result: string[] };
  db_save_settings: { args: { data: string }; result: void };
  db_load_settings: { args: undefined; result: string | null };
  db_get_all_downloads: { args: undefined; result: string[] };
  db_replace_downloads: { args: { data: string }; result: void };
  db_commit_download_state: {
    args: { downloadsData: string; queuesData: string };
    result: void;
  };
  db_get_all_queues: { args: undefined; result: string[] };
  db_replace_queues: { args: { data: string }; result: void };
  create_category_directories: {
    args: { baseFolder: string; subfolders: Record<string, string> };
    result: void;
  };
  export_logs: { args: { destination?: string }; result: string };
  read_logs: { args: { limit: number }; result: string[] };
  clear_logs: { args: undefined; result: void };
  toggle_log_pause: { args: { pause: boolean }; result: void };
  is_log_paused: { args: undefined; result: boolean };
  set_log_stream_active: { args: { active: boolean }; result: void };
  get_pending_order: { args: { queueId: string | null }; result: string[] };
  enqueue_download: { args: { item: EnqueueItem }; result: EnqueueAccepted };
  cancel_enqueue_generation: { args: { id: string; generation: string }; result: void };
  enqueue_many: { args: { items: EnqueueItem[] }; result: import('./bindings/EnqueueResult').EnqueueResult[] };
  move_in_queue: { args: { id: string; queueId: string; direction: 'up' | 'down' }; result: string[] };
  move_many_in_queue: { args: { ids: string[]; queueId: string; direction: 'up' | 'down'; targetIndex?: number }; result: string[] };
  remove_from_queue: { args: { id: string }; result: boolean };
  open_download_properties_window: { args: { id: string }; result: string };
  get_properties_window_download_id: { args: undefined; result: string };
  properties_window_send_ready: { args: { sessionId: string }; result: void };
  properties_window_reveal: { args: { sessionId?: string }; result: void };
  properties_window_send_action: { args: { sessionId: string; requestId: number; action: string; payload?: unknown }; result: void };
  validate_properties_window_request: { args: { windowLabel: string; downloadId: string; sessionId: string; requestId?: number }; result: void };
  close_download_properties_window: { args: { id: string }; result: void };
  properties_window_registry_remove_for_download: { args: { id: string }; result: void };
};

type CommandName = keyof CommandMap;
type CommandArgs<K extends CommandName> = CommandMap[K]['args'];
type CommandResult<K extends CommandName> = CommandMap[K]['result'];

export function invokeCommand<K extends CommandName>(
  command: K,
  ...args: CommandArgs<K> extends undefined ? [] : [args: CommandArgs<K>]
): Promise<CommandResult<K>> {
  return tauriInvoke<CommandResult<K>>(command, args[0]).catch(err => {
    void logError(`Invoke command ${command} failed: ${err}`).catch(() => undefined);
    throw err;
  });
}

type EventMap = {
  'schedule-trigger': { action: 'start' | 'stop'; key: string };
  'download-progress': DownloadProgressEvent;
  'download-state': DownloadStateEvent;
  'torrent-move-progress': import('./bindings/TorrentMoveProgressEvent').TorrentMoveProgressEvent;
  'download-complete': string;
  'download-failed': string;
  'extension-add-download': ExtensionDownload;
  'deep-link-add-download': string;
  'tray-action': 'pause-all' | 'resume-all';
  'app-exit-requested': null;
};

export function listenEvent<K extends keyof EventMap>(
  event: K,
  handler: EventCallback<EventMap[K]>,
): Promise<UnlistenFn> {
  return tauriListen<EventMap[K]>(event, handler);
}

export type IpcEvent<K extends keyof EventMap> = Event<EventMap[K]>;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ts_rs::TS;

fn default_speed_limit_unit() -> String {
    "MB/s".to_string()
}

fn default_language_preference() -> String {
    "system".to_string()
}

fn default_sidebar_position() -> String {
    "auto".to_string()
}

fn default_torrent_enable_dht() -> bool {
    true
}

fn default_torrent_enable_dht6() -> bool {
    false
}

fn default_torrent_enable_pex() -> bool {
    true
}

fn default_torrent_enable_lpd() -> bool {
    false
}

fn default_torrent_max_open_files() -> u32 {
    crate::queue::DEFAULT_TORRENT_MAX_OPEN_FILES
}

fn default_torrent_dht_message_timeout() -> u32 {
    crate::queue::DEFAULT_TORRENT_DHT_MESSAGE_TIMEOUT
}

fn default_torrent_separate_seed_slots() -> bool {
    false
}

fn default_torrent_max_concurrent_seeds() -> u32 {
    crate::queue::DEFAULT_TORRENT_MAX_CONCURRENT_SEEDS
}

fn default_torrent_ipv6_enabled() -> bool {
    true
}

fn default_aria2_disk_cache() -> String {
    crate::queue::DEFAULT_ARIA2_DISK_CACHE.to_string()
}

fn default_adaptive_mirror_selection() -> bool {
    true
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum DownloadStatus {
    /// Added to the download list but not assigned to a queue or dispatched.
    Ready,
    /// Assigned to a queue but intentionally not registered with the backend.
    Staged,
    Downloading,
    /// Post-download media processing such as yt-dlp/ffmpeg merging or
    /// extraction. The queue permit is still held.
    Processing,
    /// A BitTorrent download has all selected data and is still seeding.
    /// The Aria2 GID and queue permit remain live until seeding ends.
    Seeding,
    /// A BitTorrent download is complete but paused while waiting for a
    /// Firelink-owned seeding slot.
    #[serde(rename = "waitingToSeed")]
    WaitingToSeed,
    Paused,
    Completed,
    Failed,
    Queued,
    /// Transient state: a connection-aware retry is in progress with
    /// exponential backoff. The download slot/permit is still held.
    Retrying,
    /// Aria2 is verifying already-present Torrent data before transfer or
    /// after an explicit integrity check.
    Verifying,
    /// Firelink is moving owned Torrent data between managed destinations.
    Moving,
}

impl DownloadStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Staged => "staged",
            Self::Downloading => "downloading",
            Self::Processing => "processing",
            Self::Seeding => "seeding",
            Self::WaitingToSeed => "waitingToSeed",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Queued => "queued",
            Self::Retrying => "retrying",
            Self::Verifying => "verifying",
            Self::Moving => "moving",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub enum DownloadCategory {
    Musics,
    Movies,
    Compressed,
    Documents,
    Pictures,
    Applications,
    Torrents,
    Other,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Queue {
    pub id: String,
    pub name: String,
    pub is_main: bool,
    #[serde(default)]
    #[ts(optional)]
    pub max_concurrent: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct QueueConcurrencyConfig {
    pub id: String,
    #[serde(default)]
    pub max_concurrent: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum DownloadErrorKind {
    NameResolution,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct DownloadItem {
    pub id: String,
    pub url: String,
    pub file_name: String,
    pub status: DownloadStatus,
    #[ts(optional)]
    pub fraction: Option<f64>,
    #[ts(optional)]
    pub speed: Option<String>,
    #[ts(optional)]
    pub eta: Option<String>,
    #[ts(optional)]
    pub size: Option<String>,
    #[ts(optional)]
    pub downloaded_bytes: Option<f64>,
    #[ts(optional)]
    pub total_bytes: Option<f64>,
    #[ts(optional)]
    pub total_is_estimate: Option<bool>,
    pub category: DownloadCategory,
    pub date_added: String,
    #[ts(optional)]
    pub resumable: Option<bool>,
    #[ts(optional)]
    pub connections: Option<i32>,
    #[ts(optional)]
    pub speed_limit: Option<String>,
    #[ts(optional)]
    pub username: Option<String>,
    #[ts(optional)]
    pub password: Option<String>,
    #[ts(optional)]
    pub sftp_host_key_md: Option<String>,
    #[ts(optional)]
    pub headers: Option<String>,
    #[ts(optional)]
    pub checksum: Option<String>,
    #[ts(optional)]
    pub cookies: Option<String>,
    #[ts(optional)]
    pub mirrors: Option<String>,
    #[ts(optional)]
    pub destination: Option<String>,
    #[ts(optional)]
    pub is_media: Option<bool>,
    #[ts(optional)]
    pub media_format_selector: Option<String>,
    #[ts(optional)]
    pub media_quality: Option<String>,
    #[ts(optional)]
    pub queue_id: Option<String>,
    #[ts(optional)]
    pub queue_position: Option<i32>,
    #[ts(optional)]
    pub has_been_dispatched: Option<bool>,
    #[ts(optional)]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub credentials_required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_error_kind: Option<DownloadErrorKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_resolver_fallback: Option<bool>,
    #[ts(optional)]
    pub last_try: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub is_torrent: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_path: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_file_indices: Option<Vec<u32>>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_info_hash: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_seed_time: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_seed_ratio: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_seed_remaining: Option<f64>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub torrent_uploaded_bytes: Option<u64>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub torrent_seeded_seconds: Option<u64>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_relocation_check_pending: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_move_destination: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_move_restore_status: Option<DownloadStatus>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_web_seeds: Option<Vec<TorrentWebSeed>>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_web_seeds_native: Option<Vec<TorrentWebSeed>>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_upload_limit: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_max_peers: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_peer_speed_limit: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_check_integrity: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_trackers: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_exclude_trackers: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_tracker_connect_timeout: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_tracker_timeout: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_tracker_interval: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_stop_timeout: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_prioritize_piece: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_remove_unselected_file: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_encryption_policy: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_file_allocation: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_verify_only: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_verify_restore_status: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentPeer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub port: Option<u16>,
    #[ts(type = "number")]
    pub download_speed: u64,
    #[ts(type = "number")]
    pub upload_speed: u64,
    pub seeder: bool,
    pub am_choking: bool,
    pub peer_choking: bool,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentPeerDiagnostics {
    #[ts(type = "number")]
    pub total_peers: u32,
    #[ts(type = "number")]
    pub total_seeders: u32,
    pub peers: Vec<TorrentPeer>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentFileProgress {
    pub index: u32,
    pub relative_path: String,
    #[ts(type = "number")]
    pub length: u64,
    #[ts(type = "number")]
    pub completed_length: u64,
    pub selected: bool,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentFileProgressSnapshot {
    pub files: Vec<TorrentFileProgress>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentPieceProgressSnapshot {
    #[ts(type = "number")]
    pub piece_length: u64,
    #[ts(type = "number")]
    pub num_pieces: u64,
    #[ts(type = "number")]
    pub completed_pieces: u64,
    pub buckets: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentFileSelectionEntry {
    pub index: u32,
    pub relative_path: String,
    #[ts(type = "number")]
    pub length: u64,
    pub selected: bool,
    #[ts(type = "number")]
    #[ts(optional)]
    pub completed_length: Option<u64>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentFileSelectionSnapshot {
    pub files: Vec<TorrentFileSelectionEntry>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentDetails {
    pub info_hash: String,
    pub display_name: String,
    #[ts(type = "number")]
    pub total_bytes: u64,
    #[ts(type = "number")]
    pub file_count: u32,
    #[ts(type = "number")]
    pub piece_length: u64,
    #[ts(type = "number")]
    pub piece_count: u64,
    pub private: bool,
    pub creation_date: Option<String>,
    pub creator: Option<String>,
    pub comment: Option<String>,
    pub trackers: Vec<String>,
    pub web_seeds: Vec<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentAvailabilityBucket {
    #[ts(type = "number")]
    pub minimum_copies: u16,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentAvailabilitySnapshot {
    #[ts(type = "number")]
    pub piece_count: u64,
    pub availability: f64,
    #[ts(type = "number")]
    pub connected_peers: u32,
    pub buckets: Vec<TorrentAvailabilityBucket>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentMoveProgressEvent {
    pub id: String,
    pub fraction: f64,
    #[ts(type = "number")]
    pub copied_bytes: u64,
    #[ts(type = "number")]
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentWebSeed {
    #[ts(type = "number")]
    pub file_index: u32,
    pub uri: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentFile {
    pub index: u32,
    pub path: String,
    #[ts(type = "number")]
    pub length: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentMetadata {
    pub name: String,
    #[ts(type = "number")]
    pub total_bytes: u64,
    pub files: Vec<TorrentFile>,
    pub info_hash: String,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EnqueueResult {
    pub id: String,
    pub success: bool,
    #[ts(optional)]
    pub filename: Option<String>,
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EnqueueAccepted {
    pub id: String,
    pub filename: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct SiteLogin {
    pub id: String,
    pub url_pattern: String,
    pub username: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum AppFontSize {
    Small,
    Standard,
    Large,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum ListRowDensity {
    Compact,
    Standard,
    Relaxed,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum PostQueueAction {
    None,
    Sleep,
    Restart,
    Shutdown,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum Theme {
    Dark,
    Light,
    System,
    Dracula,
    Nord,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum FontFamily {
    #[default]
    System,
    Inter,
    Outfit,
    Vazirmatn,
    NotoSansHebrew,
    NotoSansSc,
    Roboto,
    Serif,
    Monospace,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum WindowControlStyle {
    #[default]
    Auto,
    Macos,
    Windows,
    Gnome,
    Minimal,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum CalendarPreference {
    #[default]
    Gregorian,
    Persian,
    Hebrew,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum ActiveView {
    Downloads,
    Settings,
    Scheduler,
    #[serde(rename = "speedLimiter")]
    SpeedLimiter,
    Logs,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum SettingsTab {
    Downloads,
    Lookandfeel,
    Network,
    Locations,
    Sitelogins,
    Power,
    Engine,
    Integrations,
    About,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum ProxyMode {
    None,
    System,
    Custom,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct MediaCookieSource(#[ts(type = "string")] pub String);

impl Default for MediaCookieSource {
    fn default() -> Self {
        Self("none".to_string())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct SchedulerSettings {
    pub enabled: bool,
    pub start_time: String,
    pub stop_time_enabled: bool,
    pub stop_time: String,
    pub everyday: bool,
    pub selected_days: Vec<u32>,
    pub selected_queue_ids: Vec<String>,
    pub post_queue_action: PostQueueAction,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct PersistedSettings {
    pub theme: Theme,
    #[serde(default)]
    pub font_family: FontFamily,
    #[serde(default)]
    pub window_control_style: WindowControlStyle,
    #[serde(default)]
    pub calendar_preference: CalendarPreference,
    #[serde(default = "default_language_preference")]
    pub language: String,
    pub base_download_folder: String,
    pub category_subfolders_enabled: bool,
    pub category_subfolders: HashMap<String, String>,
    pub category_directory_overrides: HashMap<String, String>,
    pub approved_download_roots: Vec<String>,
    pub max_concurrent_downloads: usize,
    pub global_speed_limit: String,
    #[serde(default)]
    pub torrent_overall_upload_limit: String,
    pub speed_limit_preset_values: Vec<f64>,
    pub logs_enabled: bool,
    pub is_sidebar_visible: bool,
    #[serde(default = "default_sidebar_position")]
    pub sidebar_position: String,
    pub active_settings_tab: SettingsTab,
    pub scheduler: SchedulerSettings,
    pub scheduler_running: bool,
    pub scheduler_active_download_ids: Vec<String>,
    pub scheduler_last_start_key: String,
    pub scheduler_last_stop_key: String,
    pub last_custom_speed_limit_ki_b: u32,
    #[serde(default = "default_speed_limit_unit")]
    pub last_custom_speed_limit_unit: String,
    pub per_server_connections: i32,
    pub max_automatic_retries: i32,
    #[serde(default)]
    pub minimum_normal_download_speed_ki_b: u32,
    #[serde(default)]
    pub retry_not_found_errors: bool,
    #[serde(default = "default_adaptive_mirror_selection")]
    pub adaptive_mirror_selection: bool,
    pub show_notifications: bool,
    pub play_completion_sound: bool,
    #[serde(default)]
    pub auto_add_clipboard_links: bool,
    pub app_font_size: AppFontSize,
    pub list_row_density: ListRowDensity,
    pub show_dock_badge: bool,
    pub show_menu_bar_icon: bool,
    pub proxy_mode: ProxyMode,
    pub proxy_host: String,
    pub proxy_port: u16,
    #[serde(default = "default_torrent_enable_dht")]
    pub torrent_enable_dht: bool,
    #[serde(default = "default_torrent_enable_dht6")]
    pub torrent_enable_dht6: bool,
    #[serde(default = "default_torrent_enable_pex")]
    pub torrent_enable_pex: bool,
    #[serde(default = "default_torrent_enable_lpd")]
    pub torrent_enable_lpd: bool,
    #[serde(default = "default_torrent_max_open_files")]
    pub torrent_max_open_files: u32,
    #[serde(default = "default_torrent_dht_message_timeout")]
    pub torrent_dht_message_timeout: u32,
    #[serde(default = "default_torrent_separate_seed_slots")]
    pub torrent_separate_seed_slots: bool,
    #[serde(default = "default_torrent_max_concurrent_seeds")]
    pub torrent_max_concurrent_seeds: u32,
    #[serde(default = "default_torrent_ipv6_enabled")]
    pub torrent_ipv6_enabled: bool,
    #[serde(default)]
    pub torrent_listen_port: String,
    #[serde(default)]
    pub torrent_dht_listen_port: String,
    #[serde(default)]
    pub torrent_external_ip: String,
    #[serde(default)]
    pub torrent_dht_entry_point: String,
    #[serde(default)]
    pub torrent_dht_entry_point6: String,
    #[serde(default)]
    pub torrent_dht_listen_addr6: String,
    #[serde(default)]
    pub torrent_lpd_interface: String,
    #[serde(default)]
    pub torrent_peer_id_prefix: String,
    #[serde(default)]
    pub torrent_peer_agent: String,
    #[serde(default)]
    pub torrent_bind_address: String,
    #[serde(default = "default_aria2_disk_cache")]
    pub aria2_disk_cache: String,
    pub custom_user_agent: String,
    pub ask_where_to_save_each_file: bool,
    pub remember_last_used_download_directory: bool,
    pub prevents_sleep_while_downloading: bool,
    #[serde(default)]
    pub prevents_display_sleep_while_downloading: bool,
    pub media_cookie_source: MediaCookieSource,
    pub site_logins: Vec<SiteLogin>,
    pub auto_check_updates: bool,
    #[serde(default)]
    pub keychain_access_granted: bool,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
    pub target_triple: String,
    pub portable: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum QueueDirection {
    Up,
    Down,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct DownloadStateEvent {
    pub id: String,
    pub status: String,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error_kind: Option<DownloadErrorKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resolver_fallback: Option<bool>,
    #[ts(optional)]
    pub file_name: Option<String>,
    #[ts(optional)]
    pub torrent_seed_remaining: Option<f64>,
}

impl DownloadStateEvent {
    pub fn new(id: impl Into<String>, status: DownloadStatus) -> Self {
        Self {
            id: id.into(),
            status: status.as_str().to_string(),
            error: None,
            error_kind: None,
            resolver_fallback: None,
            file_name: None,
            torrent_seed_remaining: None,
        }
    }

    pub fn failed(id: impl Into<String>, error: impl Into<String>) -> Self {
        let (error, error_kind) = Self::safe_error(error);
        Self {
            id: id.into(),
            status: DownloadStatus::Failed.as_str().to_string(),
            error: Some(error),
            error_kind,
            resolver_fallback: None,
            file_name: None,
            torrent_seed_remaining: None,
        }
    }

    pub fn paused_with_error(id: impl Into<String>, error: impl Into<String>) -> Self {
        let (error, error_kind) = Self::safe_error(error);
        Self {
            id: id.into(),
            status: DownloadStatus::Paused.as_str().to_string(),
            error: Some(error),
            error_kind,
            resolver_fallback: None,
            file_name: None,
            torrent_seed_remaining: None,
        }
    }

    pub fn paused_with_seed_remaining(id: impl Into<String>, remaining: Option<f64>) -> Self {
        Self {
            id: id.into(),
            status: DownloadStatus::Paused.as_str().to_string(),
            error: None,
            error_kind: None,
            resolver_fallback: None,
            file_name: None,
            torrent_seed_remaining: remaining,
        }
    }

    pub fn completed_with_file(id: impl Into<String>, file_name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            status: DownloadStatus::Completed.as_str().to_string(),
            error: None,
            error_kind: None,
            resolver_fallback: None,
            file_name: Some(file_name.into()),
            torrent_seed_remaining: None,
        }
    }

    /// Transient retry state. Carries the human-readable reason so the UI can
    /// surface "network dropped, retrying in 5s…". The slot is still held.
    pub fn retrying(id: impl Into<String>, reason: impl Into<String>) -> Self {
        let (reason, error_kind) = Self::safe_error(reason);
        Self {
            id: id.into(),
            status: DownloadStatus::Retrying.as_str().to_string(),
            error: Some(reason),
            error_kind,
            resolver_fallback: None,
            file_name: None,
            torrent_seed_remaining: None,
        }
    }

    pub fn waiting_to_seed(id: impl Into<String>, remaining: Option<f64>) -> Self {
        Self {
            id: id.into(),
            status: DownloadStatus::WaitingToSeed.as_str().to_string(),
            error: None,
            error_kind: None,
            resolver_fallback: None,
            file_name: None,
            torrent_seed_remaining: remaining,
        }
    }

    pub fn retrying_with_resolver_fallback(
        id: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        let mut event = Self::retrying(id, reason);
        event.resolver_fallback = Some(true);
        event
    }

    fn safe_error(error: impl Into<String>) -> (String, Option<DownloadErrorKind>) {
        let error = crate::redact_sensitive_text(&error.into());
        let error_kind = crate::retry::is_aria2_name_resolution_error(&error)
            .then_some(DownloadErrorKind::NameResolution);
        (error, error_kind)
    }
}

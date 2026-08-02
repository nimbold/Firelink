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
    Paused,
    Completed,
    Failed,
    Queued,
    /// Transient state: a connection-aware retry is in progress with
    /// exponential backoff. The download slot/permit is still held.
    Retrying,
}

impl DownloadStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Staged => "staged",
            Self::Downloading => "downloading",
            Self::Processing => "processing",
            Self::Seeding => "seeding",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Queued => "queued",
            Self::Retrying => "retrying",
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
    pub torrent_stop_timeout: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_prioritize_piece: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TorrentPeer {
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
    #[ts(optional)]
    pub file_name: Option<String>,
}

impl DownloadStateEvent {
    pub fn new(id: impl Into<String>, status: DownloadStatus) -> Self {
        Self {
            id: id.into(),
            status: status.as_str().to_string(),
            error: None,
            file_name: None,
        }
    }

    pub fn failed(id: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            status: DownloadStatus::Failed.as_str().to_string(),
            error: Some(error.into()),
            file_name: None,
        }
    }

    pub fn paused_with_error(id: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            status: DownloadStatus::Paused.as_str().to_string(),
            error: Some(error.into()),
            file_name: None,
        }
    }

    pub fn completed_with_file(id: impl Into<String>, file_name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            status: DownloadStatus::Completed.as_str().to_string(),
            error: None,
            file_name: Some(file_name.into()),
        }
    }

    /// Transient retry state. Carries the human-readable reason so the UI can
    /// surface "network dropped, retrying in 5s…". The slot is still held.
    pub fn retrying(id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            status: DownloadStatus::Retrying.as_str().to_string(),
            error: Some(reason.into()),
            file_name: None,
        }
    }
}

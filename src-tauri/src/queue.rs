use base64::Engine as _;
use crate::ipc::{DownloadStateEvent, DownloadStatus, QueueDirection};
use crate::power::PowerManager;
use crate::retry::{backoff_and_emit, is_transient_network_error, BackoffOutcome, MAX_RETRIES};
use log;
use serde::Deserialize;
use serde_json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, Notify, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};
use ts_rs::TS;

/// Default capacity when no setting is read yet.
pub const DEFAULT_MAX_CONCURRENT: usize = 3;
pub const MAX_QUEUE_CONCURRENT: usize = 12;
pub const MEDIA_RUN_CANCELLED: &str = "__firelink_media_run_cancelled__";
pub const DOWNLOAD_CONNECTIONS_MIN: i32 = 1;
pub const DOWNLOAD_CONNECTIONS_MAX: i32 = 16;
pub const MAX_TORRENT_PIECE_PRIORITY_SIZE_MIB: u64 = 1024;
pub const MAX_TORRENT_TRACKER_TIMEOUT: u32 = 604_800;
pub const MAX_TORRENT_TRACKER_INTERVAL: u32 = 604_800;
pub const DEFAULT_TORRENT_MAX_OPEN_FILES: u32 = 100;
pub const MIN_TORRENT_MAX_OPEN_FILES: u32 = 1;
pub const MAX_TORRENT_MAX_OPEN_FILES: u32 = 4_096;
pub const MAX_TORRENT_NETWORK_VALUE_LENGTH: usize = 256;
pub const MAX_TORRENT_PEER_ID_PREFIX_BYTES: usize = 20;
pub const MAX_TORRENT_PEER_AGENT_LENGTH: usize = 128;
pub const MIN_TORRENT_LISTEN_PORT: u16 = 1024;
pub const DEFAULT_TORRENT_LISTEN_PORT_SPEC: &str = "6881-6999";

pub fn clamp_download_connections(connections: i32) -> i32 {
    connections.clamp(DOWNLOAD_CONNECTIONS_MIN, DOWNLOAD_CONNECTIONS_MAX)
}

pub fn normalize_torrent_max_open_files(value: u32) -> Result<u32, String> {
    if !(MIN_TORRENT_MAX_OPEN_FILES..=MAX_TORRENT_MAX_OPEN_FILES).contains(&value) {
        return Err(format!(
            "torrent maximum open files must be between {MIN_TORRENT_MAX_OPEN_FILES} and {MAX_TORRENT_MAX_OPEN_FILES}"
        ));
    }
    Ok(value)
}

fn normalize_optional_torrent_network_value(
    value: Option<&str>,
    field: &str,
) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.len() > MAX_TORRENT_NETWORK_VALUE_LENGTH
        || value.chars().any(|character| character.is_control())
    {
        return Err(format!("{field} is too long or contains control characters"));
    }
    Ok(Some(value.to_string()))
}

fn normalize_torrent_port(value: &str, field: &str) -> Result<u16, String> {
    let port = value
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("{field} contains an invalid port"))?;
    if !(1..=u16::MAX as u32).contains(&port) {
        return Err(format!("{field} ports must be between 1 and 65535"));
    }
    Ok(port as u16)
}

fn normalize_torrent_listen_port(value: &str, field: &str) -> Result<u16, String> {
    let port = normalize_torrent_port(value, field)?;
    if port < MIN_TORRENT_LISTEN_PORT {
        return Err(format!(
            "{field} ports must be between {MIN_TORRENT_LISTEN_PORT} and 65535"
        ));
    }
    Ok(port)
}

pub(crate) fn normalize_torrent_port_spec(
    value: Option<&str>,
    field: &str,
) -> Result<Option<String>, String> {
    let Some(value) = normalize_optional_torrent_network_value(value, field)? else {
        return Ok(None);
    };
    let mut normalized = Vec::new();
    for entry in value.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            return Err(format!("{field} contains an empty port entry"));
        }
        if let Some((start, end)) = entry.split_once('-') {
            let start = normalize_torrent_listen_port(start, field)?;
            let end = normalize_torrent_listen_port(end, field)?;
            if start > end {
                return Err(format!("{field} contains a reversed port range"));
            }
            normalized.push(format!("{start}-{end}"));
        } else {
            normalized.push(normalize_torrent_listen_port(entry, field)?.to_string());
        }
    }
    Ok(Some(normalized.join(",")))
}

pub(crate) fn torrent_port_spec_contains(spec: &str, port: u16) -> bool {
    spec.split(',').any(|entry| {
        let entry = entry.trim();
        if let Some((start, end)) = entry.split_once('-') {
            matches!((start.parse::<u16>(), end.parse::<u16>()), (Ok(start), Ok(end)) if start <= port && port <= end)
        } else {
            entry.parse::<u16>() == Ok(port)
        }
    })
}

pub(crate) fn normalize_torrent_external_ip(
    value: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(value) = normalize_optional_torrent_network_value(value, "Torrent external IP")?
    else {
        return Ok(None);
    };
    let address = value
        .parse::<std::net::IpAddr>()
        .map_err(|_| "Torrent external IP must be a valid IPv4 or IPv6 address".to_string())?;
    Ok(Some(address.to_string()))
}

pub(crate) fn normalize_torrent_dht_entry_point(
    value: Option<&str>,
    ipv6: bool,
) -> Result<Option<String>, String> {
    let field = if ipv6 {
        "IPv6 DHT entry point"
    } else {
        "IPv4 DHT entry point"
    };
    let Some(value) = normalize_optional_torrent_network_value(value, field)? else {
        return Ok(None);
    };
    let (host, port) = if let Some(rest) = value.strip_prefix('[') {
        let (host, port) = rest
            .split_once(']')
            .and_then(|(host, suffix)| suffix.strip_prefix(':').map(|port| (host, port)))
            .ok_or_else(|| format!("{field} must use host:port syntax"))?;
        if host.parse::<std::net::Ipv6Addr>().is_err() {
            return Err(format!("{field} has an invalid IPv6 host"));
        }
        (format!("[{host}]"), normalize_torrent_port(port, field)?)
    } else {
        let (host, port) = value
            .rsplit_once(':')
            .ok_or_else(|| format!("{field} must use host:port syntax"))?;
        if host.is_empty() || host.contains(':') || host.contains(['/', '\\', '@']) {
            return Err(format!("{field} has an invalid host"));
        }
        if url::Host::parse(host).is_err() {
            return Err(format!("{field} has an invalid host"));
        }
        (host.to_ascii_lowercase(), normalize_torrent_port(port, field)?)
    };
    if ipv6 && !host.starts_with('[') {
        return Err(format!("{field} must use an IPv6 host"));
    }
    if !ipv6 && host.starts_with('[') {
        return Err(format!("{field} must use an IPv4 or hostname host"));
    }
    Ok(Some(format!("{host}:{port}")))
}

pub(crate) fn normalize_torrent_dht_listen_addr6(
    value: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(value) = normalize_optional_torrent_network_value(value, "IPv6 DHT listen address")?
    else {
        return Ok(None);
    };
    let address = value
        .parse::<std::net::Ipv6Addr>()
        .map_err(|_| "IPv6 DHT listen address must be a valid IPv6 address".to_string())?;
    Ok(Some(address.to_string()))
}

pub(crate) fn normalize_torrent_lpd_interface(
    value: Option<&str>,
) -> Result<Option<String>, String> {
    normalize_optional_torrent_network_value(value, "Torrent LPD interface")
}

pub(crate) fn normalize_torrent_peer_id_prefix(
    value: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(value) = normalize_optional_torrent_network_value(value, "Torrent peer ID prefix")?
    else {
        return Ok(None);
    };
    if !value.is_ascii() || value.len() > MAX_TORRENT_PEER_ID_PREFIX_BYTES {
        return Err(format!(
            "Torrent peer ID prefix must be printable ASCII and at most {MAX_TORRENT_PEER_ID_PREFIX_BYTES} bytes"
        ));
    }
    Ok(Some(value))
}

pub(crate) fn normalize_torrent_peer_agent(
    value: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(value) = normalize_optional_torrent_network_value(value, "Torrent peer agent")?
    else {
        return Ok(None);
    };
    if value.len() > MAX_TORRENT_PEER_AGENT_LENGTH {
        return Err(format!(
            "Torrent peer agent must be at most {MAX_TORRENT_PEER_AGENT_LENGTH} bytes"
        ));
    }
    Ok(Some(value))
}

fn reorder_selected_queue_tasks(
    queue_tasks: &[QueuedTask],
    ids: &[String],
    target_index: usize,
) -> Option<Vec<QueuedTask>> {
    let selected_ids = ids.iter().collect::<HashSet<_>>();
    let selected_tasks = queue_tasks
        .iter()
        .filter(|task| selected_ids.contains(&task.id))
        .cloned()
        .collect::<Vec<_>>();
    if selected_tasks.is_empty() {
        return None;
    }

    let unselected_tasks = queue_tasks
        .iter()
        .filter(|task| !selected_ids.contains(&task.id))
        .cloned()
        .collect::<Vec<_>>();
    let insert_index = target_index.min(unselected_tasks.len());
    let mut reordered = Vec::with_capacity(queue_tasks.len());
    reordered.extend_from_slice(&unselected_tasks[..insert_index]);
    reordered.extend(selected_tasks);
    reordered.extend_from_slice(&unselected_tasks[insert_index..]);
    Some(reordered)
}

fn reorder_selected_queue_tasks_in_order(
    queue_tasks: &[QueuedTask],
    ids: &[String],
    target_index: usize,
) -> Option<Vec<QueuedTask>> {
    let selected_ids = ids.iter().collect::<HashSet<_>>();
    let mut seen_ids = HashSet::new();
    let selected_tasks = ids
        .iter()
        .filter(|id| seen_ids.insert(*id))
        .filter_map(|id| queue_tasks.iter().find(|task| task.id == *id))
        .cloned()
        .collect::<Vec<_>>();
    if selected_tasks.is_empty() {
        return None;
    }

    let unselected_tasks = queue_tasks
        .iter()
        .filter(|task| !selected_ids.contains(&task.id))
        .cloned()
        .collect::<Vec<_>>();
    let insert_index = target_index.min(unselected_tasks.len());
    let mut reordered = Vec::with_capacity(queue_tasks.len());
    reordered.extend_from_slice(&unselected_tasks[..insert_index]);
    reordered.extend(selected_tasks);
    reordered.extend_from_slice(&unselected_tasks[insert_index..]);
    Some(reordered)
}

type Aria2ControlLocks = Arc<StdMutex<HashMap<String, Arc<Mutex<()>>>>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Aria2GidMapping {
    pub id: String,
    pub epoch: u64,
}

/// Owns one per-download control lock and removes its idle map entry when the
/// last operation for that download finishes.
pub struct Aria2ControlGuard {
    locks: Aria2ControlLocks,
    id: String,
    lock: Arc<Mutex<()>>,
    guard: Option<OwnedMutexGuard<()>>,
}

impl Drop for Aria2ControlGuard {
    fn drop(&mut self) {
        // Release the async mutex before inspecting Arc ownership. The map
        // entry and this guard are then the only strong references when no
        // waiter is pending, so the entry can be removed safely.
        self.guard.take();
        let mut locks = self.locks.lock().unwrap_or_else(|error| error.into_inner());
        let should_remove = locks.get(&self.id).is_some_and(|candidate| {
            Arc::ptr_eq(candidate, &self.lock) && Arc::strong_count(&self.lock) == 2
        });
        if should_remove {
            locks.remove(&self.id);
        }
    }
}

/// Outcome of an aria2 completion that arrived before its gid was stored.
/// Carries the outcome so the correct state emit survives the race.
#[derive(Debug, Clone)]
pub enum PendingOutcome {
    Complete,
    /// BitTorrent payload is complete, but Aria2 is still seeding. Keep the
    /// GID, ownership record, and queue permit until the final complete
    /// notification arrives.
    Seeding,
    Error(String),
}

/// Result of recycling an aria2 transfer's connections. A refresh can race
/// with daemon completion or leave the transfer paused after an ambiguous
/// unpause failure, so callers must handle the verified daemon outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Aria2RefreshOutcome {
    Resumed,
    Paused,
    Complete,
}

/// Result of rebuilding an aria2 job while retaining its partial file and
/// queue permit. `Refresh` is the compatibility path for test/alternate
/// spawners that do not own aria2's addUri options.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Aria2RecreateOutcome {
    NewGid(String),
    Complete,
    Refresh,
    /// The old daemon job is gone and the replacement could not be created.
    /// The queue manager must retire the stale mapping and surface a paused
    /// lifecycle so the next user resume can enqueue a fresh job.
    Unavailable(String),
}

fn aria2_recovery_should_rebuild_after_pause_error(status: &str) -> bool {
    status == "removed"
}

/// What kind of sidecar a queued task spawns. Drives which runner the
/// dispatcher invokes.
#[derive(Debug, Clone)]
pub enum TaskKind {
    Aria2,
    Media,
}

/// Everything needed to start a sidecar, captured at enqueue time so the
/// dispatcher can spawn it later without round-tripping back to the frontend.
#[derive(Debug, Clone)]
pub struct QueuedTask {
    pub id: String,
    pub queue_id: String,
    pub kind: TaskKind,
    pub payload: SpawnPayload,
    /// Frontend lifecycle generation that owns this sidecar and its permit.
    /// Manual internal/test tasks use generation 0.
    pub lifecycle_generation: u64,
}

#[derive(Debug, Clone)]
struct QueuePermitOwnership {
    queue_id: String,
    lifecycle_generation: u64,
    active: bool,
}

/// Args mirroring start_download / start_media_download. Kept untyped-loose
/// (String/Option) to match the existing command signatures exactly.
#[derive(Debug, Clone, Default)]
pub struct SpawnPayload {
    pub url: String,
    pub destination: String,
    pub filename: String,
    pub connections: Option<i32>,
    pub speed_limit: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub headers: Option<String>,
    pub checksum: Option<String>,
    pub cookies: Option<String>,
    pub mirrors: Option<String>,
    pub user_agent: Option<String>,
    pub max_tries: Option<i32>,
    pub proxy: Option<String>,
    pub format_selector: Option<String>,
    pub cookie_source: Option<String>,
    pub is_media: bool,
    pub is_torrent: bool,
    pub torrent_path: Option<String>,
    pub torrent_file_indices: Option<Vec<u32>>,
    pub torrent_seed_time: Option<f64>,
    pub torrent_seed_ratio: Option<f64>,
    pub torrent_upload_limit: Option<String>,
    pub torrent_max_peers: Option<u32>,
    pub torrent_peer_speed_limit: Option<String>,
    pub torrent_check_integrity: bool,
    pub torrent_trackers: Option<String>,
    pub torrent_exclude_trackers: Option<String>,
    pub torrent_tracker_connect_timeout: Option<u32>,
    pub torrent_tracker_timeout: Option<u32>,
    pub torrent_tracker_interval: Option<u32>,
    pub torrent_stop_timeout: Option<u32>,
    pub torrent_prioritize_piece: Option<String>,
    pub torrent_remove_unselected_file: bool,
    pub torrent_encryption_policy: Option<String>,
}

/// A sidecar spawner. In production this calls the real aria2/yt-dlp
/// runners; in tests it is replaced with a fake that records calls and
/// optionally hangs to simulate a long-running download.
#[async_trait::async_trait]
pub trait SidecarSpawner: Send + Sync + 'static {
    /// Spawn an aria2 download. Returns the gid. Must return quickly (the
    /// permit is already parked before this is called).
    async fn add_uri(&self, id: &str, payload: &SpawnPayload) -> Result<String, String>;

    /// Force-remove an aria2 gid created by a retry that raced with user
    /// cancellation.
    async fn remove_uri(&self, gid: &str) -> Result<(), String>;

    /// Recycle the connections for an active aria2 transfer without changing
    /// its gid or releasing its queue permit. Production uses forcePause /
    /// unpause; test spawners can leave this unsupported.
    async fn refresh_uri(&self, _gid: &str) -> Result<Aria2RefreshOutcome, String> {
        Err("aria2 connection refresh is unavailable".to_string())
    }

    /// Rebuild an active aria2 job with the current payload/options. The
    /// partial file remains resumable because the production addUri path uses
    /// continue + always-resume. Alternate spawners may return `Refresh` to
    /// retain the older same-GID pause/unpause behavior.
    async fn recreate_uri(
        &self,
        _id: &str,
        _gid: &str,
        _payload: &SpawnPayload,
    ) -> Result<Aria2RecreateOutcome, String> {
        Ok(Aria2RecreateOutcome::Refresh)
    }

    /// Change one active aria2 transfer's runtime download cap. Media
    /// runners intentionally keep the default implementation: yt-dlp reads
    /// its limit only when the process starts.
    async fn set_download_speed_limit(
        &self,
        _gid: &str,
        _limit: Option<&str>,
    ) -> Result<(), String> {
        Err("live aria2 speed limits are unavailable".to_string())
    }

    /// Change one active BitTorrent transfer's runtime upload cap without
    /// replacing its GID or queue permit.
    async fn set_torrent_upload_limit(
        &self,
        _gid: &str,
        _limit: Option<&str>,
    ) -> Result<(), String> {
        Err("live torrent upload limits are unavailable".to_string())
    }

    /// Change the peer cap and low-speed peer expansion threshold without
    /// replacing the Torrent GID or queue permit.
    async fn set_torrent_peer_options(
        &self,
        _gid: &str,
        _max_peers: u32,
        _peer_speed_limit: &str,
    ) -> Result<(), String> {
        Err("live torrent peer options are unavailable".to_string())
    }

    /// Run a media download to completion. The permit is parked for the full
    /// duration; release is handled by QueueManager on the runner's exit.
    async fn run_media(
        &self,
        id: &str,
        payload: &SpawnPayload,
        lifecycle_generation: u64,
    ) -> Result<(), String>;
}

/// The centralized concurrency gatekeeper. One instance lives in AppState.
pub struct QueueManager<R: tauri::Runtime = tauri::Wry> {
    registered_ids: Mutex<HashSet<String>>,
    registered_lifecycle_generations: Mutex<HashMap<String, u64>>,
    enqueue_cancellations: Mutex<HashMap<String, u64>>,
    enqueue_generations: Mutex<HashMap<String, u64>>,
    pending: Mutex<VecDeque<QueuedTask>>,
    semaphore: Arc<Semaphore>,
    active_permits: Mutex<HashMap<String, OwnedSemaphorePermit>>,
    active_permit_generations: Mutex<HashMap<String, u64>>,
    active_kinds: Mutex<HashMap<String, TaskKind>>,
    /// Queue overrides are stored only for queues with an explicit limit.
    /// Missing entries inherit the global target capacity.
    queue_limits: Mutex<HashMap<String, usize>>,
    /// One entry represents either a queued dispatch reservation or an active
    /// transfer. Keeping both phases in one map makes queue-slot ownership
    /// exactly-once across the async addUri handoff.
    queue_permit_ownership: Mutex<HashMap<String, QueuePermitOwnership>>,
    /// Serializes queue-slot selection with global permit acquisition and
    /// ownership transitions.
    admission_gate: Mutex<()>,
    /// Last queue selected by the dispatcher. Selection starts after this
    /// queue when multiple queues have eligible work.
    dispatch_cursor: Mutex<Option<String>>,
    target_capacity: AtomicUsize,
    slots_to_retire: AtomicUsize,
    notify: Notify,

    /// aria2 gid -> download id map (shared with the WS poller).
    pub aria2_gids: Arc<std::sync::RwLock<HashMap<String, Aria2GidMapping>>>,

    /// gid -> buffered (id_placeholder, outcome) for completions that arrived
    /// before the gid was stored. Drained by `remember_gid`.
    pub pending_completion: Arc<Mutex<HashMap<String, (String, PendingOutcome)>>>,

    /// download id -> spawn payload for aria2 transient-error re-addUri retries.
    aria2_payloads: Mutex<HashMap<String, SpawnPayload>>,
    /// Initial aria2 addUri handoffs that have not yet either published a GID
    /// or removed a stale late GID. Removal waits for these handoffs before
    /// deleting owned assets so a magnet cannot leave an orphaned output.
    aria2_dispatch_inflight: Mutex<HashMap<String, HashSet<u64>>>,
    aria2_dispatch_notify: Notify,

    /// The daemon-wide download cap currently applied to aria2. This mirrors
    /// successful RPC changes so the poller can avoid treating an intentional
    /// cap as a degraded connection pool.
    aria2_global_speed_limit: Arc<StdMutex<Option<String>>>,

    /// 0-based transient-error strike counter per aria2 download id.
    aria2_retry_strikes: Mutex<HashMap<String, usize>>,

    /// Download ids whose aria2 retry loop must not create another job.
    aria2_retry_cancelled: Mutex<HashSet<String>>,
    /// Download ids with a retry worker currently sleeping or re-adding a gid.
    /// A duplicate aria2 error event must not create a second worker.
    aria2_retry_inflight: Mutex<HashMap<String, u64>>,
    /// The gid whose terminal event initiated each in-flight retry.
    aria2_retrying_gids: Mutex<HashSet<String>>,
    /// Gids whose terminal events must be ignored after a lifecycle transition.
    /// This is bounded so a long-lived daemon cannot grow the set indefinitely.
    aria2_ignored_gids: Mutex<VecDeque<String>>,
    /// Wakes retry backoff workers when a pause/remove action cancels them.
    aria2_retry_cancel_notify: Notify,

    /// Serializes control RPCs for one download (pause, resume, refresh, and
    /// retry handoff) without blocking control operations for other downloads.
    aria2_control_locks: Aria2ControlLocks,

    /// Serializes GID mapping transitions with early WebSocket event
    /// buffering. The RwLock protects individual map access; this lock makes
    /// map replacement, ignored-GID retirement, and pending-event draining a
    /// single state transition.
    aria2_gid_state: Mutex<()>,

    /// Monotonic per-download aria2 control generation. Long-running queued
    /// resume tasks capture this and abort when a later pause/remove wins.
    aria2_control_epochs: Mutex<HashMap<String, u64>>,

    /// Backend-owned power policy and active-transfer accounting.
    power_manager: Arc<PowerManager>,

    spawner: Arc<dyn SidecarSpawner>,
    app_handle: AppHandle<R>,
}

impl QueueManager<tauri::Wry> {
    /// Production constructor. Wired up in lib.rs setup().
    pub fn new(app_handle: AppHandle<tauri::Wry>, capacity: usize) -> Self {
        let spawner: Arc<dyn SidecarSpawner> = Arc::new(ProductionSpawner::new(app_handle.clone()));
        Self::test_new(app_handle, capacity, spawner)
    }
}

impl<R: tauri::Runtime> QueueManager<R> {
    /// Test-only constructor injecting a fake spawner.
    pub fn test_new(
        app_handle: AppHandle<R>,
        capacity: usize,
        spawner: Arc<dyn SidecarSpawner>,
    ) -> Self {
        Self {
            registered_ids: Mutex::new(HashSet::new()),
            registered_lifecycle_generations: Mutex::new(HashMap::new()),
            enqueue_cancellations: Mutex::new(HashMap::new()),
            enqueue_generations: Mutex::new(HashMap::new()),
            pending: Mutex::new(VecDeque::new()),
            semaphore: Arc::new(Semaphore::new(capacity)),
            active_permits: Mutex::new(HashMap::new()),
            active_permit_generations: Mutex::new(HashMap::new()),
            active_kinds: Mutex::new(HashMap::new()),
            queue_limits: Mutex::new(HashMap::new()),
            queue_permit_ownership: Mutex::new(HashMap::new()),
            admission_gate: Mutex::new(()),
            dispatch_cursor: Mutex::new(None),
            target_capacity: AtomicUsize::new(capacity),
            slots_to_retire: AtomicUsize::new(0),
            notify: Notify::new(),
            aria2_gids: Arc::new(std::sync::RwLock::new(HashMap::new())),
            pending_completion: Arc::new(Mutex::new(HashMap::new())),
            aria2_payloads: Mutex::new(HashMap::new()),
            aria2_dispatch_inflight: Mutex::new(HashMap::new()),
            aria2_dispatch_notify: Notify::new(),
            aria2_global_speed_limit: Arc::new(StdMutex::new(None)),
            aria2_retry_strikes: Mutex::new(HashMap::new()),
            aria2_retry_cancelled: Mutex::new(HashSet::new()),
            aria2_retry_inflight: Mutex::new(HashMap::new()),
            aria2_retrying_gids: Mutex::new(HashSet::new()),
            aria2_ignored_gids: Mutex::new(VecDeque::new()),
            aria2_retry_cancel_notify: Notify::new(),
            aria2_control_locks: Arc::new(StdMutex::new(HashMap::new())),
            aria2_gid_state: Mutex::new(()),
            aria2_control_epochs: Mutex::new(HashMap::new()),
            power_manager: PowerManager::new(),
            spawner,
            app_handle,
        }
    }

    pub fn power_manager(&self) -> Arc<PowerManager> {
        Arc::clone(&self.power_manager)
    }

    pub fn activate_power_management(&self) -> Result<(), String> {
        self.power_manager.activate()
    }

    pub fn set_power_preferences(
        &self,
        prevent_system_sleep: bool,
        prevent_display_sleep: bool,
    ) -> Result<(), String> {
        self.power_manager
            .set_preferences(prevent_system_sleep, prevent_display_sleep)
    }

    pub fn set_system_sleep_prevention(&self, enabled: bool) -> Result<(), String> {
        self.power_manager.set_system_prevention(enabled)
    }

    async fn sync_power_activity(&self) {
        let active_transfers = self.active_permits.lock().await.len();
        self.power_manager
            .set_active_transfer_count(active_transfers);
    }

    /// Current pending order, as id list. Returned by move_in_queue.
    pub async fn pending_order(&self, queue_id: Option<&str>) -> Vec<String> {
        self.pending
            .lock()
            .await
            .iter()
            .filter(|task| queue_id.is_none_or(|queue_id| task.queue_id == queue_id))
            .map(|t| t.id.clone())
            .collect()
    }

    /// Explicitly release a backend registry id (e.g. on un-resumable false paths, removals, or detach).
    pub async fn release_registered_id(&self, id: &str) {
        self.registered_ids.lock().await.remove(id);
        self.registered_lifecycle_generations.lock().await.remove(id);
        // A released lifecycle cannot be resumed by a delayed retry worker.
        // Epoch checks remain the authoritative guard; removing this marker
        // prevents terminal downloads from accumulating cancellation entries.
        self.aria2_retry_cancelled.lock().await.remove(id);
        self.notify.notify_waiters();
    }

    pub async fn is_registered(&self, id: &str) -> bool {
        self.registered_ids.lock().await.contains(id)
    }

    pub async fn registered_lifecycle_generation(&self, id: &str) -> Option<u64> {
        self.registered_lifecycle_generations
            .lock()
            .await
            .get(id)
            .copied()
    }

    async fn is_registered_generation(&self, id: &str, generation: u64) -> bool {
        self.registered_lifecycle_generations
            .lock()
            .await
            .get(id)
            .copied()
            == Some(generation)
    }

    pub(crate) async fn release_registered_id_for_generation(&self, id: &str, generation: u64) {
        let released = {
            let mut registered = self.registered_ids.lock().await;
            let mut generations = self.registered_lifecycle_generations.lock().await;
            if generations.get(id).copied() == Some(generation) {
                registered.remove(id);
                generations.remove(id);
                true
            } else {
                false
            }
        };
        if released {
            self.aria2_retry_cancelled.lock().await.remove(id);
            self.notify.notify_waiters();
        }
    }

    /// Reject an in-flight enqueue generation if a newer UI action supersedes it.
    pub async fn cancel_enqueue_generation(&self, id: &str, generation: u64) {
        let mut cancellations = self.enqueue_cancellations.lock().await;
        cancellations
            .entry(id.to_string())
            .and_modify(|current| *current = (*current).max(generation))
            .or_insert(generation);
    }

    /// Atomically reserve an ID after rejecting cancelled or replayed generations.
    /// The returned watermark must be passed to `rollback_enqueue_reservation`
    /// if ownership registration fails before the task is committed.
    pub async fn reserve_enqueue_generation(
        &self,
        id: &str,
        generation: u64,
    ) -> Result<Option<u64>, String> {
        let cancellations = self.enqueue_cancellations.lock().await;
        if cancellations
            .get(id)
            .is_some_and(|cancelled| *cancelled >= generation)
        {
            return Err("Download enqueue was superseded by a newer user action".to_string());
        }
        let mut generations = self.enqueue_generations.lock().await;
        let previous_generation = generations.get(id).copied();
        if previous_generation.is_some_and(|seen| seen >= generation) {
            return Err("Download enqueue was superseded by a newer user action".to_string());
        }

        let mut registered = self.registered_ids.lock().await;
        if registered.contains(id) {
            return Err("Duplicate task".to_string());
        }
        registered.insert(id.to_string());
        self.registered_lifecycle_generations
            .lock()
            .await
            .insert(id.to_string(), generation);
        generations.insert(id.to_string(), generation);
        Ok(previous_generation)
    }

    pub async fn rollback_enqueue_reservation(
        &self,
        id: &str,
        generation: u64,
        previous_generation: Option<u64>,
    ) {
        let mut generations = self.enqueue_generations.lock().await;
        let mut registered = self.registered_ids.lock().await;
        if generations.get(id).copied() != Some(generation) {
            return;
        }
        registered.remove(id);
        self.registered_lifecycle_generations.lock().await.remove(id);
        match previous_generation {
            Some(previous) => {
                generations.insert(id.to_string(), previous);
            }
            None => {
                generations.remove(id);
            }
        }
    }

    pub async fn commit_reserved_enqueue(
        &self,
        mut task: QueuedTask,
        generation: u64,
    ) -> Result<(), String> {
        let id = task.id.clone();
        let cancellations = self.enqueue_cancellations.lock().await;
        if cancellations
            .get(&id)
            .is_some_and(|cancelled| *cancelled >= generation)
        {
            return Err("Download enqueue was superseded by a newer user action".to_string());
        }
        task.lifecycle_generation = generation;
        self.pending.lock().await.push_back(task);
        self.emit_state(id, DownloadStatus::Queued);
        self.notify.notify_one();
        Ok(())
    }

    /// Atomically checks the generation watermark before registering a task.
    pub async fn push_with_generation(
        &self,
        task: QueuedTask,
        generation: u64,
    ) -> Result<(), String> {
        let id = task.id.clone();
        let previous_generation = self.reserve_enqueue_generation(&id, generation).await?;
        if let Err(error) = self.commit_reserved_enqueue(task, generation).await {
            self.rollback_enqueue_reservation(&id, generation, previous_generation)
                .await;
            return Err(error);
        }
        Ok(())
    }

    /// Enqueue a task without a frontend lifecycle token. This is retained for
    /// internal/test callers and still gets replay protection at generation 0.
    pub async fn push(&self, task: QueuedTask) -> Result<(), String> {
        self.push_with_generation(task, 0).await
    }

    /// Replace the explicit per-queue concurrency overrides. A missing queue
    /// entry inherits the global limit; every effective queue limit is capped
    /// by the global target at admission time.
    pub async fn replace_queue_limits(
        &self,
        limits: Vec<(String, Option<usize>)>,
    ) -> Result<(), String> {
        let mut next = HashMap::with_capacity(limits.len());
        for (queue_id, limit) in limits {
            let queue_id = queue_id.trim();
            if queue_id.is_empty() {
                return Err("Queue id cannot be empty".to_string());
            }
            if next.contains_key(queue_id) {
                return Err(format!("Duplicate queue id '{queue_id}'"));
            }
            if let Some(limit) = limit {
                if !(1..=MAX_QUEUE_CONCURRENT).contains(&limit) {
                    return Err(format!(
                        "Queue concurrency must be between 1 and {MAX_QUEUE_CONCURRENT}"
                    ));
                }
                next.insert(queue_id.to_string(), limit);
            }
        }

        let _admission_gate = self.admission_gate.lock().await;
        *self.queue_limits.lock().await = next;
        self.notify.notify_waiters();
        Ok(())
    }

    pub async fn next_aria2_control_epoch(&self, id: &str) -> u64 {
        let mut epochs = self.aria2_control_epochs.lock().await;
        let epoch = epochs.get(id).copied().unwrap_or_default().wrapping_add(1);
        epochs.insert(id.to_string(), epoch);
        self.notify.notify_waiters();
        epoch
    }

    pub async fn is_aria2_control_epoch_current(&self, id: &str, epoch: u64) -> bool {
        self.aria2_control_epochs
            .lock()
            .await
            .get(id)
            .copied()
            .unwrap_or_default()
            == epoch
    }

    pub async fn current_aria2_control_epoch(&self, id: &str) -> u64 {
        self.aria2_control_epochs
            .lock()
            .await
            .get(id)
            .copied()
            .unwrap_or_default()
    }

    pub async fn is_aria2_retry_cancelled(&self, id: &str) -> bool {
        self.aria2_retry_cancelled.lock().await.contains(id)
    }

    /// Serialize control RPCs for one download while allowing unrelated
    /// downloads to pause, resume, or refresh concurrently.
    pub async fn acquire_aria2_control(&self, id: &str) -> Aria2ControlGuard {
        let lock = {
            let mut locks = self
                .aria2_control_locks
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            Arc::clone(
                locks
                    .entry(id.to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let guard = lock.clone().lock_owned().await;
        Aria2ControlGuard {
            locks: Arc::clone(&self.aria2_control_locks),
            id: id.to_string(),
            lock,
            guard: Some(guard),
        }
    }

    pub async fn has_aria2_retry_state(&self, id: &str) -> bool {
        self.aria2_retry_strikes.lock().await.contains_key(id)
    }

    pub async fn aria2_requested_connections(&self, id: &str) -> Option<i32> {
        self.aria2_payloads
            .lock()
            .await
            .get(id)
            .and_then(|payload| payload.connections)
            .map(clamp_download_connections)
    }

    pub async fn aria2_torrent_seeding_requested(&self, id: &str) -> bool {
        self.aria2_payloads
            .lock()
            .await
            .get(id)
            .is_some_and(torrent_seeding_requested)
    }

    pub fn set_aria2_global_speed_limit(&self, limit: Option<String>) {
        *self
            .aria2_global_speed_limit
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = limit;
    }

    pub async fn aria2_speed_limited(&self, id: &str) -> bool {
        if self
            .aria2_global_speed_limit
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_some()
        {
            return true;
        }

        self.aria2_payloads
            .lock()
            .await
            .get(id)
            .and_then(|payload| payload.speed_limit.as_deref())
            .and_then(crate::normalize_speed_limit_for_aria2)
            .is_some()
    }

    /// Change an active aria2 transfer's speed cap without replacing its GID
    /// or queue permit. The per-download control lock and post-RPC ownership
    /// check make a late response harmless if terminal cleanup or a retry
    /// transition wins the lifecycle race.
    pub async fn set_aria2_download_speed_limit(
        &self,
        id: &str,
        limit: Option<String>,
    ) -> Result<(), String> {
        let normalized_limit = match limit.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => Some(
                crate::normalize_speed_limit_for_aria2(raw)
                    .ok_or_else(|| "invalid download speed limit".to_string())?,
            ),
        };
        let _control_guard = self.acquire_aria2_control(id).await;

        if !self.is_registered(id).await
            || !matches!(self.active_kind(id).await, Some(TaskKind::Aria2))
        {
            return Err("download is not an active aria2 transfer".to_string());
        }
        let gid = self
            .aria2_gid_for_download(id)
            .ok_or_else(|| "active aria2 transfer has no gid".to_string())?;
        let expected_mapping = self
            .aria2_gid_mapping(&gid)
            .ok_or_else(|| "active aria2 transfer has no current gid mapping".to_string())?;
        if expected_mapping.id != id {
            return Err("aria2 gid belongs to another download".to_string());
        }
        if !self
            .is_aria2_control_epoch_current(id, expected_mapping.epoch)
            .await
        {
            return Err("active aria2 transfer has a stale control epoch".to_string());
        }

        self.spawner
            .set_download_speed_limit(&gid, normalized_limit.as_deref())
            .await?;

        let still_current = self.is_registered(id).await
            && matches!(self.active_kind(id).await, Some(TaskKind::Aria2))
            && self
                .is_aria2_control_epoch_current(id, expected_mapping.epoch)
                .await
            && self.is_current_aria2_gid_mapping(&gid, &expected_mapping)
            && self.aria2_gid_for_download(id).as_deref() == Some(gid.as_str());
        if !still_current {
            return Err("download lifecycle changed while setting speed limit".to_string());
        }

        let mut payloads = self.aria2_payloads.lock().await;
        let payload = payloads
            .get_mut(id)
            .ok_or_else(|| "active aria2 transfer payload is unavailable".to_string())?;
        payload.speed_limit = normalized_limit;
        Ok(())
    }

    /// Change an active Torrent's upload cap without replacing its GID or
    /// queue permit. The control lock and post-RPC ownership check fence a
    /// late response from a terminal or replaced lifecycle.
    pub async fn set_aria2_torrent_upload_limit(
        &self,
        id: &str,
        limit: Option<String>,
    ) -> Result<(), String> {
        let normalized_limit = match limit.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => Some(
                crate::normalize_speed_limit_for_aria2(raw)
                    .ok_or_else(|| "invalid torrent upload limit".to_string())?,
            ),
        };
        let _control_guard = self.acquire_aria2_control(id).await;

        if !self.is_registered(id).await
            || !matches!(self.active_kind(id).await, Some(TaskKind::Aria2))
        {
            return Err("download is not an active aria2 transfer".to_string());
        }
        let is_torrent = self
            .aria2_payloads
            .lock()
            .await
            .get(id)
            .is_some_and(|payload| payload.is_torrent);
        if !is_torrent {
            return Err("download is not a Torrent transfer".to_string());
        }
        let gid = self
            .aria2_gid_for_download(id)
            .ok_or_else(|| "active Torrent transfer has no gid".to_string())?;
        let expected_mapping = self
            .aria2_gid_mapping(&gid)
            .ok_or_else(|| "active Torrent transfer has no current gid mapping".to_string())?;
        if expected_mapping.id != id {
            return Err("aria2 gid belongs to another download".to_string());
        }
        if !self
            .is_aria2_control_epoch_current(id, expected_mapping.epoch)
            .await
        {
            return Err("active Torrent transfer has a stale control epoch".to_string());
        }

        self.spawner
            .set_torrent_upload_limit(&gid, normalized_limit.as_deref())
            .await?;

        let still_current = self.is_registered(id).await
            && matches!(self.active_kind(id).await, Some(TaskKind::Aria2))
            && self
                .is_aria2_control_epoch_current(id, expected_mapping.epoch)
                .await
            && self.is_current_aria2_gid_mapping(&gid, &expected_mapping)
            && self.aria2_gid_for_download(id).as_deref() == Some(gid.as_str());
        if !still_current {
            return Err("Torrent lifecycle changed while setting upload limit".to_string());
        }

        let mut payloads = self.aria2_payloads.lock().await;
        let payload = payloads
            .get_mut(id)
            .ok_or_else(|| "active Torrent transfer payload is unavailable".to_string())?;
        payload.torrent_upload_limit = normalized_limit;
        Ok(())
    }

    /// Change active Torrent peer settings without replacing the GID or queue
    /// permit. Clearing a setting restores Aria2's documented default while
    /// keeping the persisted payload override-free for future retries.
    pub async fn set_aria2_torrent_peer_options(
        &self,
        id: &str,
        max_peers: Option<i64>,
        peer_speed_limit: Option<String>,
    ) -> Result<(), String> {
        let normalized_max_peers = normalize_torrent_max_peers(max_peers)?;
        let normalized_peer_speed_limit =
            normalize_torrent_peer_speed_limit(peer_speed_limit.as_deref())?;
        let rpc_max_peers = normalized_max_peers.unwrap_or(ARIA2_DEFAULT_TORRENT_MAX_PEERS);
        let rpc_peer_speed_limit = normalized_peer_speed_limit
            .as_deref()
            .unwrap_or(ARIA2_DEFAULT_TORRENT_PEER_SPEED_LIMIT);
        let _control_guard = self.acquire_aria2_control(id).await;

        if !self.is_registered(id).await
            || !matches!(self.active_kind(id).await, Some(TaskKind::Aria2))
        {
            return Err("download is not an active aria2 transfer".to_string());
        }
        let is_torrent = self
            .aria2_payloads
            .lock()
            .await
            .get(id)
            .is_some_and(|payload| payload.is_torrent);
        if !is_torrent {
            return Err("download is not a Torrent transfer".to_string());
        }
        let gid = self
            .aria2_gid_for_download(id)
            .ok_or_else(|| "active Torrent transfer has no gid".to_string())?;
        let expected_mapping = self
            .aria2_gid_mapping(&gid)
            .ok_or_else(|| "active Torrent transfer has no current gid mapping".to_string())?;
        if expected_mapping.id != id {
            return Err("aria2 gid belongs to another download".to_string());
        }
        if !self
            .is_aria2_control_epoch_current(id, expected_mapping.epoch)
            .await
        {
            return Err("active Torrent transfer has a stale control epoch".to_string());
        }

        self.spawner
            .set_torrent_peer_options(&gid, rpc_max_peers, rpc_peer_speed_limit)
            .await?;

        let still_current = self.is_registered(id).await
            && matches!(self.active_kind(id).await, Some(TaskKind::Aria2))
            && self
                .is_aria2_control_epoch_current(id, expected_mapping.epoch)
                .await
            && self.is_current_aria2_gid_mapping(&gid, &expected_mapping)
            && self.aria2_gid_for_download(id).as_deref() == Some(gid.as_str());
        if !still_current {
            return Err("Torrent lifecycle changed while setting peer options".to_string());
        }

        let mut payloads = self.aria2_payloads.lock().await;
        let payload = payloads
            .get_mut(id)
            .ok_or_else(|| "active Torrent transfer payload is unavailable".to_string())?;
        payload.torrent_max_peers = normalized_max_peers;
        payload.torrent_peer_speed_limit = normalized_peer_speed_limit;
        Ok(())
    }

    /// Return redacted, bounded peer diagnostics for the current Torrent GID.
    /// The control lock and post-RPC mapping check prevent a late response from
    /// being attributed to a replaced or terminal lifecycle.
    pub async fn get_aria2_torrent_peers(
        &self,
        id: &str,
    ) -> Result<crate::ipc::TorrentPeerDiagnostics, String> {
        let _control_guard = self.acquire_aria2_control(id).await;
        if !self.is_registered(id).await
            || !matches!(self.active_kind(id).await, Some(TaskKind::Aria2))
        {
            return Err("download is not an active aria2 transfer".to_string());
        }
        let is_torrent = self
            .aria2_payloads
            .lock()
            .await
            .get(id)
            .is_some_and(|payload| payload.is_torrent);
        if !is_torrent {
            return Err("download is not a Torrent transfer".to_string());
        }
        let gid = self
            .aria2_gid_for_download(id)
            .ok_or_else(|| "active Torrent transfer has no gid".to_string())?;
        let expected_mapping = self
            .aria2_gid_mapping(&gid)
            .ok_or_else(|| "active Torrent transfer has no current gid mapping".to_string())?;
        if expected_mapping.id != id
            || !self
                .is_aria2_control_epoch_current(id, expected_mapping.epoch)
                .await
        {
            return Err("active Torrent transfer has a stale control epoch".to_string());
        }

        let state = self.app_handle.state::<crate::AppState>();
        let result = crate::rpc_call(
            state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
            &state.aria2_secret,
            "aria2.getPeers",
            serde_json::json!([gid]),
        )
        .await
        .map_err(|error| {
            format!(
                "aria2.getPeers failed: {}",
                crate::redact_sensitive_text(&error)
            )
        })?;
        let diagnostics = parse_torrent_peer_diagnostics(result)?;

        let still_current = self.is_registered(id).await
            && matches!(self.active_kind(id).await, Some(TaskKind::Aria2))
            && self
                .is_aria2_control_epoch_current(id, expected_mapping.epoch)
                .await
            && self.is_current_aria2_gid_mapping(&gid, &expected_mapping)
            && self.aria2_gid_for_download(id).as_deref() == Some(gid.as_str());
        if !still_current {
            return Err("Torrent lifecycle changed while reading peer diagnostics".to_string());
        }

        Ok(diagnostics)
    }

    /// Pop the next task, or None if empty.
    pub async fn pop_front(&self) -> Option<QueuedTask> {
        self.pending.lock().await.pop_front()
    }

    /// Acquire a permit from the semaphore (blocks until one is available).
    pub async fn acquire_permit(&self) -> Option<OwnedSemaphorePermit> {
        self.semaphore.clone().acquire_owned().await.ok()
    }

    fn try_acquire_permit_after_retirement(&self) -> Option<OwnedSemaphorePermit> {
        loop {
            let permit = self.semaphore.clone().try_acquire_owned().ok()?;
            if self.retire_slot_if_needed() {
                permit.forget();
                continue;
            }
            return Some(permit);
        }
    }

    async fn acquire_permit_after_retirement(&self) -> Option<OwnedSemaphorePermit> {
        loop {
            let permit = self.acquire_permit().await?;
            if self.retire_slot_if_needed() {
                permit.forget();
                continue;
            }
            return Some(permit);
        }
    }

    /// Acquire a permit without attaching it to a download yet. Resume
    /// workers use this while they are outside the per-download control lock;
    /// the permit is parked only after the worker revalidates its epoch.
    pub async fn acquire_aria2_permit_candidate(&self) -> Option<OwnedSemaphorePermit> {
        self.acquire_permit_after_retirement().await
    }

    /// Acquire and reserve both the global slot and a queue slot for a resume
    /// that may still be outside the per-download control lock. The reservation
    /// is generation-stamped so a concurrent pause cannot be overwritten by a
    /// late resume worker.
    pub async fn acquire_aria2_permit_candidate_for_queue(
        &self,
        id: &str,
        queue_id: &str,
        lifecycle_generation: u64,
        control_epoch: u64,
    ) -> Option<OwnedSemaphorePermit> {
        loop {
            if !self.is_registered_generation(id, lifecycle_generation).await
                || self.is_aria2_retry_cancelled(id).await
                || !self.is_aria2_control_epoch_current(id, control_epoch).await
            {
                return None;
            }
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(permit) = self
                .try_reserve_queue_slot(id, queue_id, lifecycle_generation)
                .await
            {
                if self.is_registered_generation(id, lifecycle_generation).await
                    && !self.is_aria2_retry_cancelled(id).await
                    && self
                        .is_aria2_control_epoch_current(id, control_epoch)
                        .await
                {
                    return Some(permit);
                }
                self.release_queue_reservation_for_generation(id, lifecycle_generation)
                    .await;
                drop(permit);
                return None;
            }
            notified.await;
        }
    }

    fn retire_slot_if_needed(&self) -> bool {
        let mut debt = self.slots_to_retire.load(Ordering::Relaxed);
        while debt > 0 {
            match self.slots_to_retire.compare_exchange_weak(
                debt,
                debt - 1,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(actual) => debt = actual,
            }
        }
        false
    }

    async fn try_reserve_queue_slot(
        &self,
        id: &str,
        queue_id: &str,
        lifecycle_generation: u64,
    ) -> Option<OwnedSemaphorePermit> {
        let _admission_gate = self.admission_gate.lock().await;
        let mut ownership = self.queue_permit_ownership.lock().await;
        if ownership.contains_key(id)
            || self.active_permits.lock().await.contains_key(id)
        {
            return None;
        }

        let global_target = self.target_capacity.load(Ordering::Relaxed);
        let queue_limit = self
            .queue_limits
            .lock()
            .await
            .get(queue_id)
            .copied()
            .unwrap_or(global_target)
            .min(global_target);
        let queue_active = ownership
            .values()
            .filter(|active| active.queue_id == queue_id)
            .count();
        if queue_active >= queue_limit {
            return None;
        }

        let permit = self.try_acquire_permit_after_retirement()?;
        ownership.insert(
            id.to_string(),
            QueuePermitOwnership {
                queue_id: queue_id.to_string(),
                lifecycle_generation,
                active: false,
            },
        );
        Some(permit)
    }

    async fn release_queue_reservation_for_generation(&self, id: &str, generation: u64) {
        let _admission_gate = self.admission_gate.lock().await;
        let removed = self
            .queue_permit_ownership
            .lock()
            .await
            .get(id)
            .is_some_and(|ownership| {
                ownership.lifecycle_generation == generation && !ownership.active
            });
        if removed {
            self.queue_permit_ownership.lock().await.remove(id);
            self.notify.notify_waiters();
        }
    }

    async fn activate_admitted_permit(
        &self,
        id: &str,
        lifecycle_generation: u64,
        permit: OwnedSemaphorePermit,
    ) -> bool {
        let _admission_gate = self.admission_gate.lock().await;
        let mut ownership = self.queue_permit_ownership.lock().await;
        let owned = ownership
            .get(id)
            .is_some_and(|entry| entry.lifecycle_generation == lifecycle_generation && !entry.active);
        let active_already_owned = self.active_permits.lock().await.contains_key(id);
        if !owned || active_already_owned {
            if owned {
                ownership.remove(id);
                self.notify.notify_waiters();
            }
            return false;
        }
        if let Some(entry) = ownership.get_mut(id) {
            entry.active = true;
        }
        drop(ownership);
        self.active_permits.lock().await.insert(id.to_string(), permit);
        self.active_permit_generations
            .lock()
            .await
            .insert(id.to_string(), lifecycle_generation);
        self.sync_power_activity().await;
        true
    }

    async fn try_admit_next_task(&self) -> Option<(OwnedSemaphorePermit, QueuedTask)> {
        let _admission_gate = self.admission_gate.lock().await;
        let mut pending = self.pending.lock().await;
        if pending.is_empty() {
            return None;
        }

        let ownership = self.queue_permit_ownership.lock().await;
        let mut queue_ids = Vec::new();
        let mut seen = HashSet::new();
        for task in pending.iter() {
            if !ownership.contains_key(&task.id) && seen.insert(task.queue_id.clone()) {
                queue_ids.push(task.queue_id.clone());
            }
        }
        if queue_ids.is_empty() {
            return None;
        }

        let cursor = self.dispatch_cursor.lock().await.clone();
        let start = cursor
            .as_ref()
            .and_then(|queue_id| queue_ids.iter().position(|candidate| candidate == queue_id))
            .map_or(0, |position| (position + 1) % queue_ids.len());
        let global_target = self.target_capacity.load(Ordering::Relaxed);
        let queue_limits = self.queue_limits.lock().await;
        let selected_queue = (0..queue_ids.len()).find_map(|offset| {
            let queue_id = &queue_ids[(start + offset) % queue_ids.len()];
            let queue_limit = queue_limits
                .get(queue_id)
                .copied()
                .unwrap_or(global_target)
                .min(global_target);
            let active = ownership
                .values()
                .filter(|active| active.queue_id == *queue_id)
                .count();
            (active < queue_limit).then_some(queue_id.clone())
        })?;
        let task_index = pending
            .iter()
            .position(|task| task.queue_id == selected_queue && !ownership.contains_key(&task.id))?;
        drop(queue_limits);
        drop(ownership);

        let permit = self.try_acquire_permit_after_retirement()?;
        let task = pending.remove(task_index)?;
        self.queue_permit_ownership.lock().await.insert(
            task.id.clone(),
            QueuePermitOwnership {
                queue_id: selected_queue.clone(),
                lifecycle_generation: task.lifecycle_generation,
                active: false,
            },
        );
        *self.dispatch_cursor.lock().await = Some(selected_queue);
        Some((permit, task))
    }

    /// Park an already-acquired permit under `id`.
    pub async fn park_permit(&self, id: &str, permit: OwnedSemaphorePermit) {
        self.park_permit_for_queue(id, "main", 0, permit).await;
    }

    async fn park_permit_for_queue(
        &self,
        id: &str,
        queue_id: &str,
        lifecycle_generation: u64,
        permit: OwnedSemaphorePermit,
    ) {
        let _admission_gate = self.admission_gate.lock().await;
        self.active_permits
            .lock()
            .await
            .insert(id.to_string(), permit);
        self.queue_permit_ownership.lock().await.insert(
            id.to_string(),
            QueuePermitOwnership {
                queue_id: queue_id.to_string(),
                lifecycle_generation,
                active: true,
            },
        );
        self.sync_power_activity().await;
    }

    /// Park a candidate only when no newer lifecycle has already claimed the
    /// download. Dropping a duplicate candidate returns its slot safely.
    pub async fn park_aria2_permit_if_missing(
        &self,
        id: &str,
        permit: OwnedSemaphorePermit,
    ) -> bool {
        self.park_aria2_permit_if_missing_for_queue(id, "main", 0, permit)
            .await
    }

    /// Activate a queue-aware resume reservation. The caller owns the permit
    /// while it revalidates the lifecycle under the per-download control lock.
    pub async fn park_aria2_permit_if_missing_for_queue(
        &self,
        id: &str,
        queue_id: &str,
        lifecycle_generation: u64,
        permit: OwnedSemaphorePermit,
    ) -> bool {
        let _admission_gate = self.admission_gate.lock().await;
        let registered_generation = self
            .registered_lifecycle_generations
            .lock()
            .await
            .get(id)
            .copied();
        let mut ownership = self.queue_permit_ownership.lock().await;
        let has_matching_reservation = ownership.get(id).is_some_and(|entry| {
            entry.queue_id == queue_id
                && entry.lifecycle_generation == lifecycle_generation
                && !entry.active
                && (registered_generation == Some(lifecycle_generation)
                    || (registered_generation.is_none() && lifecycle_generation == 0))
        });
        if ownership.contains_key(id) && !has_matching_reservation {
            let remove_reservation = ownership
                .get(id)
                .is_some_and(|entry| entry.lifecycle_generation == lifecycle_generation && !entry.active);
            if remove_reservation {
                ownership.remove(id);
                self.notify.notify_waiters();
            }
            return false;
        }
        if ownership.get(id).is_none()
            && registered_generation.is_some_and(|current| current != lifecycle_generation)
        {
            return false;
        }
        let mut permits = self.active_permits.lock().await;
        if permits.contains_key(id) {
            return false;
        }
        permits.insert(id.to_string(), permit);
        drop(permits);
        if let Some(entry) = ownership.get_mut(id) {
            entry.active = true;
        } else {
            ownership.insert(
                id.to_string(),
                QueuePermitOwnership {
                    queue_id: queue_id.to_string(),
                    lifecycle_generation,
                    active: true,
                },
            );
        }
        drop(ownership);
        self.active_permit_generations
            .lock()
            .await
            .insert(id.to_string(), lifecycle_generation);
        self.active_kinds
            .lock()
            .await
            .insert(id.to_string(), TaskKind::Aria2);
        self.sync_power_activity().await;
        true
    }

    pub async fn release_aria2_permit_candidate(&self, id: &str, lifecycle_generation: u64) {
        self.release_queue_reservation_for_generation(id, lifecycle_generation)
            .await;
    }

    pub async fn active_kind(&self, id: &str) -> Option<TaskKind> {
        self.active_kinds.lock().await.get(id).cloned()
    }

    /// Ensure an aria2 transfer owns exactly one queue permit. Returns true
    /// when this call acquired and parked the permit, false when one was
    /// already parked.
    pub async fn ensure_aria2_permit(&self, id: &str) -> bool {
        self.ensure_aria2_permit_for_queue(id, "main").await
    }

    /// Ensure a paused or externally recovered aria2 transfer owns one global
    /// permit and one slot in its queue. This waits without holding a
    /// per-download control lock and wakes on either kind of capacity change.
    pub async fn ensure_aria2_permit_for_queue(&self, id: &str, queue_id: &str) -> bool {
        loop {
            if self.has_active_permit(id).await
                || self.queue_permit_ownership.lock().await.contains_key(id)
            {
                return false;
            }
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let generation = self
                .registered_lifecycle_generation(id)
                .await
                .unwrap_or_default();
            if let Some(permit) = self
                .try_reserve_queue_slot(id, queue_id, generation)
                .await
            {
                if self.park_aria2_permit_if_missing_for_queue(
                    id,
                    queue_id,
                    generation,
                    permit,
                )
                .await
                {
                    self.active_kinds
                        .lock()
                        .await
                        .insert(id.to_string(), TaskKind::Aria2);
                    return true;
                }
                return false;
            }
            notified.await;
        }
    }

    pub async fn release_permit(&self, id: &str) {
        let _admission_gate = self.admission_gate.lock().await;
        let queue_removed = self.queue_permit_ownership.lock().await.remove(id).is_some();
        let removed = self.active_permits.lock().await.remove(id).is_some();
        self.active_permit_generations.lock().await.remove(id);
        self.active_kinds.lock().await.remove(id);
        if removed || queue_removed {
            self.notify.notify_waiters();
        }
        drop(_admission_gate);
        if removed {
            self.sync_power_activity().await;
        }
    }

    pub(crate) async fn release_permit_for_generation(&self, id: &str, generation: u64) {
        let _admission_gate = self.admission_gate.lock().await;
        let removed = {
            let mut permits = self.active_permits.lock().await;
            let mut generations = self.active_permit_generations.lock().await;
            let queue_owned = self
                .queue_permit_ownership
                .lock()
                .await
                .get(id)
                .is_some_and(|ownership| ownership.lifecycle_generation == generation);
            if queue_owned || generations.get(id).copied() == Some(generation) {
                generations.remove(id);
                let active_removed = permits.remove(id).is_some();
                if queue_owned {
                    self.queue_permit_ownership.lock().await.remove(id);
                }
                active_removed || queue_owned
            } else {
                false
            }
        };
        if removed {
            self.active_kinds.lock().await.remove(id);
            self.notify.notify_waiters();
            drop(_admission_gate);
            self.sync_power_activity().await;
        }
    }

    pub async fn has_active_permit(&self, id: &str) -> bool {
        self.active_permits.lock().await.contains_key(id)
    }

    /// Clear all permits belonging to aria2. Useful when aria2 WS connection drops.
    pub async fn clear_aria2_permits(&self) {
        let ids_to_fail: Vec<String> = {
            let kinds = self.active_kinds.lock().await;
            kinds
                .iter()
                .filter(|(_, kind)| matches!(kind, TaskKind::Aria2))
                .map(|(id, _)| id.clone())
                .collect()
        };

        for id in ids_to_fail {
            let _control_guard = self.acquire_aria2_control(&id).await;
            if matches!(self.active_kind(&id).await, Some(TaskKind::Aria2)) {
                self.apply_completion_locked(
                    &id,
                    PendingOutcome::Error("Aria2 WebSocket connection lost".to_string()),
                )
                .await;
            }
        }
    }

    /// Number of un-acquired permits currently in the semaphore pool.
    pub fn available_permits(&self) -> usize {
        self.semaphore.available_permits()
    }

    fn emit_state(&self, id: impl Into<String>, status: DownloadStatus) {
        use tauri::Emitter;
        let _ = self
            .app_handle
            .emit("download-state", DownloadStateEvent::new(id, status));
    }

    /// Resize the global concurrency limit. Grow adds permits immediately;
    /// shrink records a retirement debt honored lazily by the dispatcher.
    pub fn set_capacity(&self, new_target: usize) {
        let prev_target = self.target_capacity.swap(new_target, Ordering::Relaxed);
        if new_target == prev_target {
            return;
        }
        if new_target > prev_target {
            let mut delta = new_target - prev_target;
            loop {
                let debt = self.slots_to_retire.load(Ordering::Relaxed);
                let to_deduct = std::cmp::min(debt, delta);
                if self
                    .slots_to_retire
                    .compare_exchange_weak(
                        debt,
                        debt - to_deduct,
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                    )
                    .is_ok()
                {
                    delta -= to_deduct;
                    break;
                }
            }
            if delta > 0 {
                self.semaphore.add_permits(delta);
            }
            self.notify.notify_waiters();
        } else {
            let delta = prev_target - new_target;
            self.slots_to_retire.fetch_add(delta, Ordering::Relaxed);
            self.notify.notify_waiters();
        }
    }

    /// Test accessor for the retirement debt counter.
    pub fn slots_to_retire_load(&self) -> usize {
        self.slots_to_retire.load(Ordering::Relaxed)
    }

    /// The long-running dispatcher. One instance is spawned in setup().
    /// It scans for a queue with capacity before reserving the global slot, so
    /// a saturated front queue cannot block later eligible queues.
    pub async fn run_dispatcher(self: Arc<Self>) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some((permit, task)) = self.try_admit_next_task().await {
                // Admission owns the global and per-queue reservation before
                // this task is spawned. Keep the dispatcher free to admit
                // other work while an Aria2 addUri call is retrying or a
                // control RPC is slow; dispatch_one retains the reservation
                // until that lifecycle reaches its own terminal path.
                let manager = Arc::clone(&self);
                tauri::async_runtime::spawn(async move {
                    manager.dispatch_one(permit, task).await;
                });
            } else {
                // This covers both an empty pending list and the case where
                // all queue/global capacity is occupied. The notification
                // future is created before inspection to close the lost-wake
                // window without polling or sleeping.
                notified.await;
            }
        }
    }

    async fn dispatch_one(self: Arc<Self>, permit: OwnedSemaphorePermit, task: QueuedTask) {
        let id = task.id.clone();
        let lifecycle_generation = task.lifecycle_generation;
        // Serialize activation with pause/remove/detach. The dispatcher can
        // pop a task just as a control command arrives; registering the
        // permit and active kind under the same guard prevents that command
        // from observing a half-started lifecycle.
        let control_guard = self.acquire_aria2_control(&id).await;
        if !self
            .is_registered_generation(&id, lifecycle_generation)
            .await
        {
            self.release_queue_reservation_for_generation(&id, lifecycle_generation)
                .await;
            drop(control_guard);
            drop(permit);
            return;
        }

        // Activate the reservation BEFORE spawning. Uniform parking:
        // aria2's RPC returns instantly, so the permit must outlive the
        // dispatch_one call. Media runners release on exit.
        if !self
            .activate_admitted_permit(&id, lifecycle_generation, permit)
            .await
        {
            drop(control_guard);
            return;
        }
        self.active_kinds
            .lock()
            .await
            .insert(id.clone(), task.kind.clone());

        let aria2_lifecycle_epoch = if matches!(&task.kind, TaskKind::Aria2) {
            // Every backend aria2 dispatch starts a new control lifecycle.
            // This invalidates retry workers left behind by a previous
            // failed or cancelled lifecycle before retry cancellation is
            // made reusable for the new task.
            let lifecycle_epoch = self.next_aria2_control_epoch(&id).await;
            self.aria2_retry_cancelled.lock().await.remove(&id);
            self.aria2_payloads
                .lock()
                .await
                .insert(id.clone(), task.payload.clone());
            self.aria2_retry_strikes.lock().await.remove(&id);
            Some(lifecycle_epoch)
        } else {
            None
        };
        if let Some(epoch) = aria2_lifecycle_epoch {
            self.begin_aria2_dispatch(&id, epoch).await;
        }
        self.emit_state(&id, DownloadStatus::Downloading);
        drop(control_guard);

        match task.kind {
            TaskKind::Aria2 => {
                let lifecycle_epoch = aria2_lifecycle_epoch
                    .expect("aria2 dispatch must initialize a control epoch");
                let add_result = self.spawner.add_uri(&id, &task.payload).await;
                match add_result {
                    Ok(gid) => {
                        let control_guard = self.acquire_aria2_control(&id).await;
                        let cancelled = self.aria2_retry_cancelled.lock().await.contains(&id);
                        let current_lifecycle = self
                            .is_aria2_control_epoch_current(&id, lifecycle_epoch)
                            .await
                            && self.is_registered(&id).await;
                        if cancelled || !current_lifecycle {
                            drop(control_guard);
                            log::info!(
                                "aria2 dispatch cancellation [{}]: removing late gid {}",
                                id,
                                gid
                            );
                            if task.payload.is_torrent {
                                if let Err(error) = self
                                    .reconcile_aria2_torrent_ownership_for_payload(
                                        &id,
                                        &gid,
                                        &task.payload,
                                    )
                                    .await
                                {
                                    log::debug!(
                                        "aria2 dispatch cancellation [{}]: could not resolve torrent output paths for gid {}: {}",
                                        id,
                                        gid,
                                        error
                                    );
                                }
                            }
                            if let Err(error) = self.spawner.remove_uri(&gid).await {
                                log::warn!(
                                    "aria2 dispatch cancellation [{}]: failed to remove late gid {}: {}",
                                    id,
                                    gid,
                                    error
                                );
                            }
                            self.ignore_aria2_gid(&gid).await;
                            self.finish_aria2_dispatch(&id, lifecycle_epoch).await;
                            if current_lifecycle {
                                self.clear_aria2_retry_state(&id).await;
                                self.release_permit(&id).await;
                            }
                            return;
                        }
                        let buffered_outcome = self.remember_gid(id.clone(), gid.clone()).await;
                        self.finish_aria2_dispatch(&id, lifecycle_epoch).await;
                        drop(control_guard);
                        if let Some(outcome) = buffered_outcome {
                            self.handle_aria2_event(&gid, outcome).await;
                        }
                    }
                    Err(error) => {
                        let _control_guard = self.acquire_aria2_control(&id).await;
                        let current_lifecycle = self
                            .is_aria2_control_epoch_current(&id, lifecycle_epoch)
                            .await
                            && self.is_registered(&id).await;
                        if current_lifecycle {
                            self.next_aria2_control_epoch(&id).await;
                            self.cancel_aria2_retries(&id).await;
                            self.clear_aria2_retry_state(&id).await;
                            self.release_permit(&id).await;
                            self.release_registered_id(&id).await;
                            self.emit_failed(&id, error);
                        } else {
                            log::info!(
                                "aria2 dispatch [{}]: ignoring stale addUri failure after a newer lifecycle took ownership",
                                id
                            );
                        }
                        self.finish_aria2_dispatch(&id, lifecycle_epoch).await;
                    }
                }
            }
            TaskKind::Media => {
                let this = Arc::clone(&self);
                let payload = task.payload.clone();
                let id_for_task = id.clone();
                tauri::async_runtime::spawn(async move {
                    let outcome = this
                        .spawner
                        .run_media(&id_for_task, &payload, lifecycle_generation)
                        .await;
                    this.finish_runner(&id_for_task, lifecycle_generation, outcome)
                        .await;
                });
            }
        }
    }

    /// Terminal handler for non-aria2 transfers. Emits state and frees the permit.
    /// Intentional cancellation is silent, but still releases backend ownership.
    /// Note: `id` is the frontend download UUID, which survives indefinitely as
    /// the terminal state.
    async fn finish_runner(
        self: Arc<Self>,
        id: &str,
        lifecycle_generation: u64,
        outcome: Result<(), String>,
    ) {
        // Completion and pause/remove/detach must observe one ordered
        // lifecycle. Without this guard a terminal media outcome could emit
        // Completed, then a racing pause could emit Paused afterward.
        let _control_guard = self.acquire_aria2_control(id).await;
        if !self.is_registered_generation(id, lifecycle_generation).await {
            log::info!(
                "media runner [{}]: ignoring stale terminal outcome for lifecycle {}",
                id,
                lifecycle_generation
            );
            self.release_permit_for_generation(id, lifecycle_generation).await;
            return;
        }

        match outcome {
            Ok(()) => {
                self.emit_state(id, DownloadStatus::Completed);
                self.release_registered_id_for_generation(id, lifecycle_generation)
                    .await;
            }
            Err(error) if error == MEDIA_RUN_CANCELLED => {
                self.release_registered_id_for_generation(id, lifecycle_generation)
                    .await;
            }
            Err(error) => {
                self.emit_failed(id, error);
                self.release_registered_id_for_generation(id, lifecycle_generation)
                    .await;
            }
        }
        self.release_permit_for_generation(id, lifecycle_generation)
            .await;
    }

    fn emit_failed(&self, id: &str, error: String) {
        use tauri::Emitter;
        let _ = self
            .app_handle
            .emit("download-state", DownloadStateEvent::failed(id, error));
    }

    /// Store gid -> id and return any buffered terminal event for the caller
    /// to reconcile against the correct event path. In particular, buffered
    /// errors must still pass through transient retry classification.
    pub async fn remember_gid(&self, id: String, gid: String) -> Option<PendingOutcome> {
        let epoch = self.current_aria2_control_epoch(&id).await;
        let buffered_outcome = {
            let _gid_state = self.aria2_gid_state.lock().await;
            let mut replaced_gids = Vec::new();
            {
                let mut gids = self.aria2_gids.write().unwrap();
                gids.retain(|existing_gid, existing_id| {
                    let keep = existing_id.id != id.as_str() || existing_gid == &gid;
                    if !keep {
                        replaced_gids.push(existing_gid.clone());
                        log::warn!(
                            "aria2 gid transition [{}]: dropping stale mapping {} before storing {}",
                            id,
                            existing_gid,
                            gid
                        );
                    }
                    keep
                });
                gids.insert(
                    gid.clone(),
                    Aria2GidMapping {
                        id: id.clone(),
                        epoch,
                    },
                );
            }

            self.unignore_aria2_gid_locked(&gid).await;
            for replaced_gid in &replaced_gids {
                self.ignore_aria2_gid_locked(replaced_gid).await;
            }
            let mut buffered = self.pending_completion.lock().await;
            for replaced_gid in &replaced_gids {
                buffered.remove(replaced_gid);
            }
            buffered.remove(&gid).map(|(_buf_id, outcome)| outcome)
        };
        log::info!("aria2 gid transition [{}]: mapped {}", id, gid);
        buffered_outcome
    }

    /// Rebind an existing paused GID to the new lifecycle created by resume.
    /// The GID remains stable across aria2.pause/unpause, but its previous
    /// epoch must not be reused after a pause invalidated that lifecycle.
    pub async fn rebind_aria2_gid_epoch(&self, id: &str, gid: &str, epoch: u64) -> bool {
        let _gid_state = self.aria2_gid_state.lock().await;
        let mut gids = self.aria2_gids.write().unwrap();
        let Some(mapping) = gids.get_mut(gid) else {
            return false;
        };
        if mapping.id != id {
            return false;
        }
        mapping.epoch = epoch;
        true
    }

    /// Apply an aria2 completion outcome: release permit + emit state.
    pub async fn apply_completion(&self, id: &str, outcome: PendingOutcome) {
        let _control_guard = self.acquire_aria2_control(id).await;
        self.apply_completion_locked(id, outcome).await;
    }

    /// Apply a terminal outcome while the caller owns the download control
    /// lock. Keeping the epoch transition and terminal cleanup under that
    /// lock prevents an old WebSocket event from completing a newer lifecycle
    /// and lets commands reconcile an Aria2 terminal status without releasing
    /// the lock first.
    pub(crate) async fn apply_completion_locked(&self, id: &str, outcome: PendingOutcome) {
        let outcome = match outcome {
            PendingOutcome::Seeding if self.aria2_torrent_seeding_requested(id).await => {
                self.emit_state(id, DownloadStatus::Seeding);
                return;
            }
            // `onBtDownloadComplete` means that Aria2 is still seeding. If
            // Firelink has no seeding policy for this payload, reconcile it
            // as terminal so a daemon-side default or stale event cannot
            // strand the GID and permit.
            PendingOutcome::Seeding => PendingOutcome::Complete,
            other => other,
        };
        if let Some(gid) = self.aria2_gid_for_download(id) {
            if let Err(error) = self.reconcile_aria2_torrent_ownership(id, &gid).await {
                log::debug!(
                    "aria2 torrent ownership [{}]: could not resolve files for gid {}: {}",
                    id,
                    gid,
                    error
                );
            }
        }
        // A terminal event invalidates every delayed retry or control worker
        // from the previous lifecycle before releasing its permit.
        self.next_aria2_control_epoch(id).await;
        self.cancel_aria2_retries(id).await;
        let torrent_removal_requested = self
            .aria2_payloads
            .lock()
            .await
            .get(id)
            .is_some_and(|payload| payload.is_torrent && payload.torrent_remove_unselected_file);
        match outcome {
            PendingOutcome::Complete => {
                self.clear_aria2_retry_state(id).await;
                self.forget_aria2_gid(id).await;
                if torrent_removal_requested {
                    match crate::download_ownership::torrent_removal_paths_for_id(
                        &self.app_handle,
                        id,
                    ) {
                        Ok(paths) if paths.iter().all(|path| !path.exists()) => {
                            if let Err(error) =
                                crate::download_ownership::clear_torrent_removal_paths(
                                    &self.app_handle,
                                    id,
                                )
                            {
                                log::warn!(
                                    "aria2 torrent removal reservation [{}]: could not clear after completion: {}",
                                    id,
                                    error
                                );
                            }
                        }
                        Ok(paths) => {
                            log::warn!(
                                "aria2 torrent removal reservation [{}]: keeping {} path(s) reserved because Aria2 cleanup was not observed",
                                id,
                                paths.len()
                            );
                        }
                        Err(error) => {
                            log::warn!(
                                "aria2 torrent removal reservation [{}]: could not verify cleanup: {}",
                                id,
                                error
                            );
                        }
                    }
                }
                self.release_registered_id(id).await;
                self.release_permit(id).await;
                self.emit_state(id, DownloadStatus::Completed);
            }
            PendingOutcome::Error(error) => {
                if error.to_ascii_lowercase().contains("checksum") {
                    log::warn!("Checksum error detected for {}, cleaning up assets", id);
                    if let Ok(paths) =
                        crate::download_ownership::owned_paths_for_id(&self.app_handle, id)
                    {
                        for path in paths {
                            let _ = crate::remove_download_assets(&path, &self.app_handle).await;
                        }
                    }
                }

                log::error!("aria2 download {} failed: {}", id, error);

                self.clear_aria2_retry_state(id).await;
                self.forget_aria2_gid(id).await;
                if torrent_removal_requested {
                    if let Err(clear_error) =
                        crate::download_ownership::clear_torrent_removal_paths(&self.app_handle, id)
                    {
                        log::warn!(
                            "aria2 torrent removal reservation [{}]: could not clear after terminal failure: {}",
                            id,
                            clear_error
                        );
                    }
                }
                self.release_registered_id(id).await;
                self.release_permit(id).await;
                self.emit_failed(id, error);
            }
            PendingOutcome::Seeding => unreachable!("seeding outcomes are normalized before terminal cleanup"),
        }
    }

    pub async fn clear_aria2_retry_state(&self, id: &str) {
        self.aria2_payloads.lock().await.remove(id);
        self.aria2_retry_strikes.lock().await.remove(id);
    }

    pub async fn cancel_aria2_retries(&self, id: &str) {
        self.aria2_retry_cancelled
            .lock()
            .await
            .insert(id.to_string());
        self.aria2_retry_cancel_notify.notify_waiters();
        self.notify.notify_waiters();
    }

    pub async fn allow_aria2_retries(&self, id: &str) {
        self.aria2_retry_cancelled.lock().await.remove(id);
    }

    /// A user-initiated resume starts a new retry lifecycle while retaining
    /// the paused Aria2 payload/GID. Reset only the strike budget here; the
    /// payload is still needed for the same-GID resume path.
    pub async fn reset_aria2_retry_strikes(&self, id: &str) {
        self.aria2_retry_strikes.lock().await.remove(id);
    }

    async fn finish_aria2_retry(&self, id: &str, gid: &str, retry_epoch: u64) {
        self.release_aria2_retry_inflight(id, retry_epoch).await;
        self.aria2_retrying_gids.lock().await.remove(gid);
    }

    async fn release_aria2_retry_inflight(&self, id: &str, retry_epoch: u64) {
        let mut inflight = self.aria2_retry_inflight.lock().await;
        if inflight.get(id).copied() == Some(retry_epoch) {
            inflight.remove(id);
        }
    }

    async fn ignore_aria2_gid(&self, gid: &str) {
        let _gid_state = self.aria2_gid_state.lock().await;
        self.ignore_aria2_gid_locked(gid).await;
    }

    async fn remove_stale_aria2_gid(&self, id: &str, gid: &str) {
        const MAX_ATTEMPTS: usize = 3;
        for attempt in 1..=MAX_ATTEMPTS {
            match self.spawner.remove_uri(gid).await {
                Ok(()) => {
                    log::info!(
                        "aria2 lifecycle cleanup [{}]: removed stale replacement gid {} on attempt {}",
                        id,
                        gid,
                        attempt
                    );
                    return;
                }
                Err(error) if attempt < MAX_ATTEMPTS => {
                    log::warn!(
                        "aria2 lifecycle cleanup [{}]: failed to remove stale replacement gid {} on attempt {}: {}; retrying",
                        id,
                        gid,
                        attempt,
                        error
                    );
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(error) => {
                    log::error!(
                        "aria2 lifecycle cleanup [{}]: stale replacement gid {} could not be removed after {} attempts: {}",
                        id,
                        gid,
                        MAX_ATTEMPTS,
                        error
                    );
                }
            }
        }
    }

    async fn ignore_aria2_gid_locked(&self, gid: &str) {
        const MAX_IGNORED_GIDS: usize = 1024;
        let mut ignored = self.aria2_ignored_gids.lock().await;
        if !ignored.iter().any(|known| known == gid) {
            ignored.push_back(gid.to_string());
        }
        while ignored.len() > MAX_IGNORED_GIDS {
            ignored.pop_front();
        }
    }

    async fn unignore_aria2_gid_locked(&self, gid: &str) {
        self.aria2_ignored_gids
            .lock()
            .await
            .retain(|known| known != gid);
    }

    async fn is_aria2_gid_ignored_locked(&self, gid: &str) -> bool {
        self.aria2_ignored_gids
            .lock()
            .await
            .iter()
            .any(|known| known == gid)
    }

    pub fn aria2_gid_for_download(&self, id: &str) -> Option<String> {
        self.aria2_gids
            .read()
            .unwrap()
            .iter()
            .find_map(|(gid, mapping)| (mapping.id == id).then(|| gid.clone()))
    }

    async fn begin_aria2_dispatch(&self, id: &str, epoch: u64) {
        self.aria2_dispatch_inflight
            .lock()
            .await
            .entry(id.to_string())
            .or_default()
            .insert(epoch);
    }

    async fn finish_aria2_dispatch(&self, id: &str, epoch: u64) {
        let mut inflight = self.aria2_dispatch_inflight.lock().await;
        let removed = if let Some(epochs) = inflight.get_mut(id) {
            let removed = epochs.remove(&epoch);
            if epochs.is_empty() {
                inflight.remove(id);
            }
            removed
        } else {
            false
        };
        drop(inflight);
        if removed {
            self.aria2_dispatch_notify.notify_waiters();
        }
    }

    pub async fn wait_for_aria2_dispatch(&self, id: &str) {
        loop {
            let notified = self.aria2_dispatch_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self
                .aria2_dispatch_inflight
                .lock()
                .await
                .contains_key(id)
            {
                return;
            }
            notified.await;
        }
    }

    async fn reconcile_aria2_torrent_ownership_for_payload(
        &self,
        id: &str,
        gid: &str,
        payload: &SpawnPayload,
    ) -> Result<(), String> {
        let state = self.app_handle.state::<crate::AppState>();
        let result = crate::rpc_call(
            state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
            &state.aria2_secret,
            "aria2.getFiles",
            serde_json::json!([gid]),
        )
        .await?;
        self.persist_aria2_torrent_ownership(id, payload, result)
    }

    fn persist_aria2_torrent_ownership(
        &self,
        id: &str,
        payload: &SpawnPayload,
        result: serde_json::Value,
    ) -> Result<(), String> {
        let paths = result
            .as_array()
            .into_iter()
            .flatten()
            .filter(|file| file.get("selected").and_then(|value| value.as_str()) != Some("false"))
            .filter_map(|file| file.get("path").and_then(|value| value.as_str()))
            .map(std::path::PathBuf::from)
            .collect::<Vec<_>>();
        if paths.is_empty() {
            return Err("aria2 returned no selected torrent output paths".to_string());
        }
        let destination = crate::resolve_path(&payload.destination, &self.app_handle);
        let canonical_destination = crate::canonicalize_with_missing_components(&destination)
            .ok_or_else(|| "torrent destination could not be canonicalized".to_string())?;
        if paths.iter().any(|path| {
            crate::canonicalize_with_missing_components(path)
                .is_none_or(|path| !crate::platform::path_is_within(&path, &canonical_destination))
        }) {
            return Err("aria2 returned a torrent output path outside its destination".to_string());
        }
        let primary = if paths.len() == 1 {
            paths[0].clone()
        } else {
            let canonical_paths = paths
                .iter()
                .filter_map(|path| crate::canonicalize_with_missing_components(path))
                .collect::<Vec<_>>();
            let mut common = canonical_paths
                .first()
                .and_then(|path| path.parent())
                .map(std::path::Path::to_path_buf)
                .ok_or_else(|| "torrent output path has no parent".to_string())?;
            for path in canonical_paths.iter().skip(1) {
                while !crate::platform::path_is_within(path, &common) {
                    let Some(parent) = common.parent() else {
                        return Err("torrent output paths have no common directory".to_string());
                    };
                    if parent == common {
                        return Err("torrent output paths have no common directory".to_string());
                    }
                    common = parent.to_path_buf();
                }
            }
            common
        };
        crate::download_ownership::set_owned_paths_with_primary(
            &self.app_handle,
            id,
            &primary,
            &paths,
        )
    }

    /// Refresh ownership from Aria2's resolved file list before a torrent
    /// lifecycle is forgotten. Magnet metadata is not available when the row
    /// is enqueued, so the user-provided display name is not a safe ownership
    /// path until Aria2 reports the actual files.
    pub async fn reconcile_aria2_torrent_ownership(
        &self,
        id: &str,
        gid: &str,
    ) -> Result<(), String> {
        let payload = self.aria2_payloads.lock().await.get(id).cloned();
        let Some(payload) = payload.filter(|payload| payload.is_torrent) else {
            return Ok(());
        };
        let mapping = self
            .aria2_gid_mapping(gid)
            .filter(|mapping| mapping.id == id)
            .ok_or_else(|| "aria2 torrent ownership has no current gid mapping".to_string())?;
        let state = self.app_handle.state::<crate::AppState>();
        let result = crate::rpc_call(
            state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
            &state.aria2_secret,
            "aria2.getFiles",
            serde_json::json!([gid]),
        )
        .await?;
        if !self.is_current_aria2_gid_mapping(gid, &mapping)
            || !self
                .is_aria2_control_epoch_current(id, mapping.epoch)
                .await
        {
            return Err("aria2 torrent lifecycle changed while resolving output paths".to_string());
        }
        self.persist_aria2_torrent_ownership(id, &payload, result)
    }

    /// Capture the GID ownership token used by the poller. The mapping's
    /// epoch must still be current when an asynchronous status snapshot is
    /// emitted; otherwise a late response from an older GID can be attributed
    /// to a newer lifecycle for the same download id.
    pub fn aria2_gid_mapping(&self, gid: &str) -> Option<Aria2GidMapping> {
        self.aria2_gids.read().unwrap().get(gid).cloned()
    }

    pub fn is_current_aria2_gid_mapping(
        &self,
        gid: &str,
        expected: &Aria2GidMapping,
    ) -> bool {
        self.aria2_gid_mapping(gid).as_ref() == Some(expected)
    }

    pub fn aria2_gid_mappings(&self) -> Vec<(String, String)> {
        self.aria2_gids
            .read()
            .unwrap()
            .iter()
            .map(|(gid, mapping)| (gid.clone(), mapping.id.clone()))
            .collect()
    }

    /// Recycle an active transfer's connections after the poller observes a
    /// persistent connection-pool collapse or a true zero-progress stall.
    /// The observed epoch must still own the GID before the refresh can act.
    pub async fn refresh_aria2_connections(
        self: &Arc<Self>,
        id: &str,
        gid: &str,
        observed_epoch: u64,
    ) -> Result<(), String> {
        let _control_guard = self.acquire_aria2_control(id).await;
        if self.aria2_gid_for_download(id).as_deref() != Some(gid)
            || !self.is_registered(id).await
            || !self.has_active_permit(id).await
            || self.is_aria2_retry_cancelled(id).await
            || !self.is_aria2_control_epoch_current(id, observed_epoch).await
        {
            return Ok(());
        }

        let payload = self.aria2_payloads.lock().await.get(id).cloned();
        let recreation = if let Some(payload) = payload.as_ref() {
            self.spawner.recreate_uri(id, gid, payload).await?
        } else {
            // Older persisted rows may briefly reach recovery before their
            // payload has been rebuilt. Keep the current lifecycle intact and
            // use the non-destructive fallback until the payload is present.
            Aria2RecreateOutcome::Refresh
        };

        if let Aria2RecreateOutcome::NewGid(new_gid) = recreation {
            if new_gid.trim().is_empty() || new_gid == gid {
                return Err(format!(
                    "aria2 connection recovery returned an invalid replacement gid for {gid}"
                ));
            }

            let still_current = self.is_registered(id).await
                && !self.is_aria2_retry_cancelled(id).await
                && self.is_aria2_control_epoch_current(id, observed_epoch).await
                && self.aria2_gid_for_download(id).as_deref() == Some(gid);
            if !still_current {
                self.ignore_aria2_gid(&new_gid).await;
                drop(_control_guard);
                self.remove_stale_aria2_gid(id, &new_gid).await;
                log::info!(
                    "aria2 connection recovery [{}]: replacement gid {} became stale before rebind",
                    id,
                    new_gid
                );
                return Ok(());
            }

            let buffered_outcome = self.remember_gid(id.to_string(), new_gid.clone()).await;
            log::info!(
                "aria2 connection recovery [{}]: recreated gid {} from {} while retaining the lifecycle permit",
                id,
                new_gid,
                gid
            );
            drop(_control_guard);
            if let Some(outcome) = buffered_outcome {
                self.handle_aria2_event(&new_gid, outcome).await;
            }
            return Ok(());
        }

        let outcome = match recreation {
            Aria2RecreateOutcome::Complete => Aria2RefreshOutcome::Complete,
            Aria2RecreateOutcome::Refresh => self.spawner.refresh_uri(gid).await?,
            Aria2RecreateOutcome::Unavailable(error) => {
                let still_current = self.is_registered(id).await
                    && self.has_active_permit(id).await
                    && !self.is_aria2_retry_cancelled(id).await
                    && self.is_aria2_control_epoch_current(id, observed_epoch).await
                    && self.aria2_gid_for_download(id).as_deref() == Some(gid);
                if !still_current {
                    return Ok(());
                }

                self.next_aria2_control_epoch(id).await;
                self.cancel_aria2_retries(id).await;
                self.clear_aria2_retry_state(id).await;
                self.forget_aria2_gid(id).await;
                self.release_registered_id(id).await;
                self.release_permit(id).await;
                self.emit_state(id, DownloadStatus::Paused);
                log::warn!(
                    "aria2 connection recovery [{}]: replacement job unavailable; retired stale gid {} and paused the download: {}",
                    id,
                    gid,
                    error
                );
                return Ok(());
            }
            Aria2RecreateOutcome::NewGid(_) => unreachable!("replacement gid handled above"),
        };

        let still_current = self.is_registered(id).await
            && !self.is_aria2_retry_cancelled(id).await
            && self.is_aria2_control_epoch_current(id, observed_epoch).await
            && self.aria2_gid_for_download(id).as_deref() == Some(gid);
        if !still_current {
            log::info!(
                "aria2 connection refresh [{}]: control state changed while refreshing gid {}; leaving the newer action in charge",
                id,
                gid
            );
            return Ok(());
        }

        match outcome {
            Aria2RefreshOutcome::Resumed => {}
            Aria2RefreshOutcome::Paused => {
                self.next_aria2_control_epoch(id).await;
                self.cancel_aria2_retries(id).await;
                self.release_permit(id).await;
                self.emit_state(id, DownloadStatus::Paused);
                log::warn!(
                    "aria2 connection refresh [{}]: gid {} remained paused; released its queue permit",
                    id,
                    gid
                );
            }
            Aria2RefreshOutcome::Complete => {
                self.apply_completion_locked(id, PendingOutcome::Complete)
                    .await;
                log::info!(
                    "aria2 connection refresh [{}]: gid {} completed during recovery",
                    id,
                    gid
                );
            }
        }
        Ok(())
    }

    /// Remove every gid mapping for a download and discard buffered terminal
    /// events for those gids. Returns the most recently encountered gid.
    pub async fn forget_aria2_gid(&self, id: &str) -> Option<String> {
        let _gid_state = self.aria2_gid_state.lock().await;
        let removed = {
            let mut gids = self.aria2_gids.write().unwrap();
            let removed: Vec<String> = gids
                .iter()
                .filter(|(_, mapping)| mapping.id == id)
                .map(|(gid, _)| gid.clone())
                .collect();
            for gid in &removed {
                gids.remove(gid);
            }
            removed
        };

        if removed.is_empty() {
            return None;
        }

        for gid in &removed {
            self.ignore_aria2_gid_locked(gid).await;
        }

        let mut buffered = self.pending_completion.lock().await;
        for gid in &removed {
            buffered.remove(gid);
            log::info!("aria2 gid transition [{}]: forgot {}", id, gid);
        }
        removed.last().cloned()
    }

    /// Intercept transient `onDownloadError` events: backoff, re-issue
    /// `addUri`, and rotate the gid mapping. Permanent errors and exhausted
    /// strikes fall through to a hard `Failed` state.
    fn handle_aria2_download_error(
        self: &Arc<Self>,
        gid: String,
        error: String,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        let this = Arc::clone(self);
        Box::pin(async move {
            this.handle_aria2_download_error_inner(&gid, error).await;
        })
    }

    /// Resolve a WebSocket event against the GID map, or buffer it while the
    /// map transition is still in flight. The state lock closes the window in
    /// which an event could be inserted after remember_gid drained it.
    async fn map_or_buffer_aria2_event(
        &self,
        gid: &str,
        outcome: PendingOutcome,
    ) -> Option<(Aria2GidMapping, PendingOutcome)> {
        let _gid_state = self.aria2_gid_state.lock().await;
        if self.is_aria2_gid_ignored_locked(gid).await {
            return None;
        }
        let mapping = {
            let gids = self.aria2_gids.read().unwrap();
            gids.get(gid).cloned()
        };
        if let Some(mapping) = mapping {
            return Some((mapping, outcome));
        }
        self.pending_completion
            .lock()
            .await
            .insert(gid.to_string(), (String::new(), outcome));
        None
    }

    async fn handle_aria2_download_error_inner(self: &Arc<Self>, gid: &str, error: String) {
        let Some((mapping, PendingOutcome::Error(error))) = self
            .map_or_buffer_aria2_event(gid, PendingOutcome::Error(error))
            .await
        else {
            return;
        };

        let _control_guard = self.acquire_aria2_control(&mapping.id).await;
        let current_mapping = {
            let gids = self.aria2_gids.read().unwrap();
            gids.get(gid).cloned()
        };
        if current_mapping
            .as_ref()
            .is_none_or(|current| current.id != mapping.id || current.epoch != mapping.epoch)
            || !self
                .is_aria2_control_epoch_current(&mapping.id, mapping.epoch)
                .await
        {
            return;
        }
        let id = mapping.id;
        if self.aria2_retry_cancelled.lock().await.contains(&id) {
            log::info!(
                "aria2 retry cancellation [{}]: ignoring error for gid {} during removal",
                id,
                gid
            );
            return;
        }

        if self.aria2_retrying_gids.lock().await.contains(gid) {
            log::debug!(
                "aria2 retry [{}]: ignoring duplicate error event for retrying gid {}",
                id,
                gid
            );
            return;
        }

        if self.aria2_retry_inflight.lock().await.contains_key(&id) {
            log::debug!(
                "aria2 retry [{}]: ignoring duplicate error event while retry handoff is in flight",
                id
            );
            return;
        }

        let payload = self.aria2_payloads.lock().await.get(&id).cloned();
        if payload.is_none() {
            self.apply_completion_locked(&id, PendingOutcome::Error(error))
                .await;
            return;
        }
        let mut payload = payload.unwrap();

        let strike = {
            let mut strikes = self.aria2_retry_strikes.lock().await;
            let entry = strikes.entry(id.clone()).or_insert(0);
            *entry
        };

        let transient = is_retryable_aria2_error(&error);
        let strikes_left = strike < automatic_retry_limit(payload.max_tries);
        if !(transient && strikes_left) {
            self.apply_completion_locked(&id, PendingOutcome::Error(error))
                .await;
            return;
        }

        self.aria2_retrying_gids
            .lock()
            .await
            .insert(gid.to_string());
        let retry_epoch = self.current_aria2_control_epoch(&id).await;
        let already_inflight = {
            let mut inflight = self.aria2_retry_inflight.lock().await;
            inflight.insert(id.clone(), retry_epoch).is_some()
        };
        if already_inflight {
            self.aria2_retrying_gids.lock().await.remove(gid);
            return;
        }
        let retry_gid = gid.to_string();

        if is_aria2_range_mode_error(&error) {
            log::warn!(
                "aria2 range mode [{}]: server rejected bounded chunk ranges; restarting with a single connection",
                id
            );
            payload.connections = Some(1);
            if let Err(cleanup_error) = remove_incompatible_aria2_range_state(self, &id).await {
                log::warn!(
                    "aria2 range mode [{}]: failed to remove incompatible partial state: {}",
                    id,
                    cleanup_error
                );
            }
            self.aria2_payloads
                .lock()
                .await
                .insert(id.clone(), payload.clone());
        }

        let this = Arc::clone(self);
        let id_for_task = id.clone();
        let error_for_emit = error.clone();
        tauri::async_runtime::spawn(async move {
            let retry_cancel = async {
                loop {
                    if this.is_aria2_retry_cancelled(&id_for_task).await {
                        break;
                    }
                    let notified = this.aria2_retry_cancel_notify.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if this.is_aria2_retry_cancelled(&id_for_task).await {
                        break;
                    }
                    notified.await;
                }
            };
            let outcome = backoff_and_emit(strike, error_for_emit, retry_cancel, |reason| {
                use tauri::Emitter;
                let _ = this.app_handle.emit(
                    "download-state",
                    DownloadStateEvent::retrying(&id_for_task, reason),
                );
            })
            .await;

            if outcome == BackoffOutcome::Aborted {
                this.finish_aria2_retry(&id_for_task, &retry_gid, retry_epoch)
                    .await;
                return;
            }

            // Serialize the payload snapshot and addUri with live speed
            // changes. Without this guard, a speed update could change the
            // old GID and payload just before this worker re-added a new GID
            // from a stale clone, silently losing the user's limit.
            let control_guard = this.acquire_aria2_control(&id_for_task).await;
            let stale_before_add = !this.active_permits.lock().await.contains_key(&id_for_task)
                || this.is_aria2_retry_cancelled(&id_for_task).await
                || !this
                    .is_aria2_control_epoch_current(&id_for_task, retry_epoch)
                    .await
                || !this.is_registered(&id_for_task).await
                || this.aria2_gid_for_download(&id_for_task).as_deref() != Some(retry_gid.as_str());
            let current_payload = this.aria2_payloads.lock().await.get(&id_for_task).cloned();
            let Some(current_payload) = current_payload else {
                drop(control_guard);
                this.finish_aria2_retry(&id_for_task, &retry_gid, retry_epoch)
                    .await;
                return;
            };
            if stale_before_add {
                drop(control_guard);
                this.finish_aria2_retry(&id_for_task, &retry_gid, retry_epoch)
                    .await;
                return;
            }

            match this
                .spawner
                .add_uri(&id_for_task, &current_payload)
                .await
            {
                Ok(new_gid) => {
                    let stale = this.is_aria2_retry_cancelled(&id_for_task).await
                        || !this
                            .is_aria2_control_epoch_current(&id_for_task, retry_epoch)
                            .await
                        || !this.is_registered(&id_for_task).await
                        || this.aria2_gid_for_download(&id_for_task).as_deref()
                            != Some(retry_gid.as_str());
                    if stale {
                        drop(control_guard);
                        if let Err(error) = this.spawner.remove_uri(&new_gid).await {
                            log::error!(
                                "aria2 retry cancellation [{}]: failed to remove late gid {}: {}",
                                id_for_task,
                                new_gid,
                                error
                            );
                        } else {
                            log::info!(
                                "aria2 retry cancellation [{}]: removed stale gid {}",
                                id_for_task,
                                new_gid
                            );
                        }
                        this.finish_aria2_retry(&id_for_task, &retry_gid, retry_epoch)
                            .await;
                        return;
                    }
                    this.aria2_retry_strikes
                        .lock()
                        .await
                        .insert(id_for_task.clone(), strike + 1);
                    this.emit_state(&id_for_task, DownloadStatus::Downloading);
                    // Stop suppressing events for the id before exposing the
                    // new gid. The old gid remains marked as retrying until
                    // remember_gid atomically replaces its mapping, so a
                    // duplicate old event is still ignored while a genuine
                    // new-gid error is allowed through.
                    this.release_aria2_retry_inflight(&id_for_task, retry_epoch)
                        .await;
                    let new_gid_for_event = new_gid.clone();
                    let buffered_outcome = this.remember_gid(id_for_task.clone(), new_gid).await;
                    this.aria2_retrying_gids.lock().await.remove(&retry_gid);
                    drop(control_guard);
                    if let Some(outcome) = buffered_outcome {
                        this.handle_aria2_event(&new_gid_for_event, outcome).await;
                    }
                }
                Err(retry_error) => {
                    let stale = this.is_aria2_retry_cancelled(&id_for_task).await
                        || !this
                            .is_aria2_control_epoch_current(&id_for_task, retry_epoch)
                            .await;
                    if !stale {
                        this.apply_completion_locked(
                            &id_for_task,
                            PendingOutcome::Error(retry_error),
                        )
                        .await;
                    }
                    drop(control_guard);
                    this.finish_aria2_retry(&id_for_task, &retry_gid, retry_epoch)
                        .await;
                }
            }
        });
    }

    /// Entry point for the aria2 WS poller. Resolves gid -> id; if not yet
    /// stored, buffers the outcome for reconciliation by remember_gid.
    pub async fn handle_aria2_event(self: &Arc<Self>, gid: &str, outcome: PendingOutcome) {
        if let PendingOutcome::Error(error) = outcome {
            self.handle_aria2_download_error(gid.to_string(), error)
                .await;
            return;
        }
        let Some((mapping, outcome)) = self.map_or_buffer_aria2_event(gid, outcome).await else {
            return;
        };

        let _control_guard = self.acquire_aria2_control(&mapping.id).await;
        if self.aria2_retrying_gids.lock().await.contains(gid) {
            return;
        }
        let current_mapping = {
            let gids = self.aria2_gids.read().unwrap();
            gids.get(gid).cloned()
        };
        if current_mapping
            .as_ref()
            .is_none_or(|current| current.id != mapping.id || current.epoch != mapping.epoch)
            || !self
                .is_aria2_control_epoch_current(&mapping.id, mapping.epoch)
                .await
        {
            return;
        }
        self.apply_completion_locked(&mapping.id, outcome).await;
    }

    /// Reorder a pending task up or down. Returns the new pending order.
    /// No-op at boundaries. Does not emit (membership unchanged); the caller
    /// (Tauri command) returns the order to the frontend.
    pub async fn move_in_queue(
        &self,
        id: &str,
        queue_id: &str,
        direction: QueueDirection,
    ) -> Vec<String> {
        self.move_many_in_queue(&[id.to_string()], queue_id, direction)
            .await
    }

    /// Atomically move a selected block of pending tasks up or down. The
    /// frontend uses the same block semantics for multi-selection, so keeping
    /// the operation under one pending-list lock prevents partial RPC moves
    /// from leaving the backend in a different order than the UI.
    pub async fn move_many_in_queue(
        &self,
        ids: &[String],
        queue_id: &str,
        direction: QueueDirection,
    ) -> Vec<String> {
        let mut pending = self.pending.lock().await;
        let queue_positions = pending
            .iter()
            .enumerate()
            .filter_map(|(index, task)| (task.queue_id == queue_id).then_some(index))
            .collect::<Vec<_>>();
        let selected_positions = queue_positions
            .iter()
            .enumerate()
            .filter_map(|(position, index)| ids.iter().any(|id| id == &pending[*index].id).then_some(position))
            .collect::<Vec<_>>();

        if !selected_positions.is_empty() {
            let queue_tasks = queue_positions
                .iter()
                .map(|index| pending[*index].clone())
                .collect::<Vec<_>>();
            let selected_ids = ids.iter().collect::<HashSet<_>>();
            let selected_tasks = queue_tasks
                .iter()
                .filter(|task| selected_ids.contains(&task.id))
                .cloned()
                .collect::<Vec<_>>();
            let unselected_tasks = queue_tasks
                .iter()
                .filter(|task| !selected_ids.contains(&task.id))
                .cloned()
                .collect::<Vec<_>>();

            let first_selected = *selected_positions.first().unwrap();
            let last_selected = *selected_positions.last().unwrap();
            let selected_count = selected_tasks.len();
            let insert_index = match direction {
                QueueDirection::Up => first_selected.saturating_sub(1),
                QueueDirection::Down => (last_selected + 1)
                    .saturating_sub(selected_count)
                    .saturating_add(1)
                    .min(unselected_tasks.len()),
            };
            let reordered = reorder_selected_queue_tasks(&queue_tasks, ids, insert_index)
                .expect("selected queue tasks were present");

            for (queue_index, pending_index) in queue_positions.iter().enumerate() {
                pending[*pending_index] = reordered[queue_index].clone();
            }
        }
        pending
            .iter()
            .filter(|task| task.queue_id == queue_id)
            .map(|task| task.id.clone())
            .collect()
    }

    /// Atomically place a selected block at an insertion index among the
    /// unselected tasks in one queue. This is the drag/drop counterpart to
    /// move_many_in_queue; the index is clamped at the backend boundary so a
    /// stale pointer position cannot create an invalid queue state.
    pub async fn move_many_in_queue_to(
        &self,
        ids: &[String],
        queue_id: &str,
        target_index: usize,
    ) -> Vec<String> {
        let mut pending = self.pending.lock().await;
        let queue_positions = pending
            .iter()
            .enumerate()
            .filter_map(|(index, task)| (task.queue_id == queue_id).then_some(index))
            .collect::<Vec<_>>();
        let queue_tasks = queue_positions
            .iter()
            .map(|index| pending[*index].clone())
            .collect::<Vec<_>>();

        if let Some(reordered) = reorder_selected_queue_tasks_in_order(&queue_tasks, ids, target_index) {
            for (queue_index, pending_index) in queue_positions.iter().enumerate() {
                pending[*pending_index] = reordered[queue_index].clone();
            }
        }

        pending
            .iter()
            .filter(|task| task.queue_id == queue_id)
            .map(|task| task.id.clone())
            .collect()
    }

    /// Remove a task from pending if present (used by remove_download).
    /// Does NOT release a permit (the caller handles active permits via
    /// release_permit if the task was already dispatched).
    pub async fn remove_from_pending(&self, id: &str) -> bool {
        let mut pending = self.pending.lock().await;
        let before = pending.len();
        pending.retain(|t| t.id != id);
        let removed = pending.len() < before;
        if removed {
            self.notify.notify_one();
        }
        removed
    }

    pub async fn remove_from_pending_for_generation(&self, id: &str, generation: u64) -> bool {
        let mut pending = self.pending.lock().await;
        let before = pending.len();
        pending.retain(|task| !(task.id == id && task.lifecycle_generation == generation));
        let removed = pending.len() < before;
        if removed {
            self.notify.notify_one();
        }
        removed
    }
}

fn automatic_retry_limit(max_tries: Option<i32>) -> usize {
    max_tries.unwrap_or(MAX_RETRIES as i32).max(0) as usize
}

fn torrent_seeding_requested(payload: &SpawnPayload) -> bool {
    payload.is_torrent
        && (payload
            .torrent_seed_time
            .is_some_and(|minutes| minutes.is_finite() && minutes > 0.0)
            || payload
                .torrent_seed_ratio
                .is_some_and(|ratio| ratio.is_finite() && ratio >= 0.0))
}

fn aria2_attempt_limit(max_tries: Option<i32>) -> u32 {
    // Firelink owns the retry budget and performs the backoff/GID rotation.
    // Keep each aria2 GID to one attempt so `max_tries` is not multiplied by
    // aria2's own internal retry loop.
    let _ = max_tries;
    1
}

fn is_retryable_aria2_error(error: &str) -> bool {
    is_transient_network_error(error) || is_aria2_range_mode_error(error)
}

fn is_aria2_rpc_unavailable(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    is_transient_network_error(error)
        || lower.contains("aria2 did not become ready")
        || lower.contains("connection refused")
        || lower.contains("failed to connect")
        || lower.contains("error trying to connect")
        || lower.contains("connection closed")
        || lower.contains("connection reset")
}

fn is_aria2_range_mode_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("invalid range header")
        || lower.contains("aria2 error code 8")
        || lower.contains("errorcode=8")
}

async fn remove_incompatible_aria2_range_state<R: tauri::Runtime>(
    manager: &QueueManager<R>,
    id: &str,
) -> Result<(), String> {
    let Some(primary_path) =
        crate::download_ownership::primary_path_for_id(&manager.app_handle, id)?
    else {
        return Ok(());
    };

    crate::remove_download_assets(&primary_path, &manager.app_handle).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoundedRangeSupport {
    Supported,
    Unsupported,
    Unknown,
}

async fn effective_aria2_connections(id: &str, payload: &SpawnPayload) -> i32 {
    let requested = clamp_download_connections(
        payload
            .connections
            .unwrap_or(DOWNLOAD_CONNECTIONS_MIN),
    );
    if requested <= 1 {
        return requested;
    }

    for uri in crate::collect_download_uris(&payload.url, payload.mirrors.as_deref()) {
        if !is_http_uri(&uri) {
            continue;
        }

        match probe_bounded_range_support(&uri, payload).await {
            Ok(BoundedRangeSupport::Unsupported) => {
                log::warn!(
                    "aria2 range probe [{}]: {} does not honor bounded byte ranges; using one connection",
                    id,
                    uri_host_for_log(&uri)
                );
                return 1;
            }
            Ok(BoundedRangeSupport::Supported) => {}
            Ok(BoundedRangeSupport::Unknown) => {
                log::debug!(
                    "aria2 range probe [{}]: {} range support unknown; keeping {} connections",
                    id,
                    uri_host_for_log(&uri),
                    requested
                );
            }
            Err(error) => {
                log::debug!(
                    "aria2 range probe [{}]: {} probe failed: {}; keeping {} connections",
                    id,
                    uri_host_for_log(&uri),
                    error,
                    requested
                );
            }
        }
    }

    requested
}

fn is_http_uri(uri: &str) -> bool {
    reqwest::Url::parse(uri)
        .ok()
        .is_some_and(|url| matches!(url.scheme(), "http" | "https"))
}

fn uri_host_for_log(uri: &str) -> String {
    reqwest::Url::parse(uri)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "<unknown host>".to_string())
}

fn proxy_scheme(proxy: &str) -> Option<String> {
    proxy
        .split_once("://")
        .map(|(scheme, _)| scheme.trim().to_ascii_lowercase())
}

pub(crate) fn aria2_all_proxy_value(proxy: &str) -> Result<Option<String>, String> {
    let proxy = proxy.trim();
    if proxy.is_empty() {
        return Ok(None);
    }
    if proxy.eq_ignore_ascii_case("none") {
        return Ok(Some(String::new()));
    }
    if proxy_scheme(proxy).is_some_and(|scheme| scheme.starts_with("socks")) {
        return Err(
            "SOCKS system proxies are not supported for normal file downloads because aria2 only accepts HTTP/HTTPS/FTP proxy URLs. Use an HTTP proxy endpoint for normal downloads, or use media downloads where yt-dlp supports SOCKS.".to_string(),
        );
    }
    Ok(Some(proxy.to_string()))
}

async fn probe_bounded_range_support(
    uri: &str,
    payload: &SpawnPayload,
) -> Result<BoundedRangeSupport, String> {
    crate::ensure_reqwest_crypto_provider();

    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(std::time::Duration::from_secs(10));

    if let Some(proxy) = payload
        .proxy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if proxy.eq_ignore_ascii_case("none") {
            builder = builder.no_proxy();
        } else {
            builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|error| error.to_string())?);
        }
    }

    let client = builder.build().map_err(|error| error.to_string())?;
    let request = client
        .get(uri)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    let request = apply_payload_headers(request, payload);
    let response = request.send().await.map_err(|error| error.to_string())?;
    let content_range = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok());

    Ok(classify_bounded_range_response(
        response.status(),
        content_range,
    ))
}

fn apply_payload_headers(
    mut request: reqwest::RequestBuilder,
    payload: &SpawnPayload,
) -> reqwest::RequestBuilder {
    if let Some(user_agent) = payload
        .user_agent
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        request = request.header(reqwest::header::USER_AGENT, user_agent);
    }
    if let Some(cookies) = payload.cookies.as_deref().filter(|value| !value.is_empty()) {
        request = request.header(reqwest::header::COOKIE, cookies);
    }
    if let Some(headers) = payload.headers.as_deref() {
        for line in headers
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            if name.trim().eq_ignore_ascii_case("range") {
                continue;
            }
            let Ok(name) = reqwest::header::HeaderName::from_bytes(name.trim().as_bytes()) else {
                continue;
            };
            let Ok(value) = reqwest::header::HeaderValue::from_str(value.trim()) else {
                continue;
            };
            request = request.header(name, value);
        }
    }
    if let Some(username) = payload
        .username
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        request = request.basic_auth(username, payload.password.as_deref());
    }
    request
}

fn classify_bounded_range_response(
    status: reqwest::StatusCode,
    content_range: Option<&str>,
) -> BoundedRangeSupport {
    if status == reqwest::StatusCode::PARTIAL_CONTENT {
        return match content_range.and_then(parse_content_range_bounds) {
            Some((0, 0)) => BoundedRangeSupport::Supported,
            Some((0, _)) => BoundedRangeSupport::Unsupported,
            Some(_) => BoundedRangeSupport::Unknown,
            None => BoundedRangeSupport::Unknown,
        };
    }

    if status.is_success() {
        BoundedRangeSupport::Unsupported
    } else {
        BoundedRangeSupport::Unknown
    }
}

fn parse_content_range_bounds(value: &str) -> Option<(u64, u64)> {
    let value = value.trim();
    let (unit, range) = value.split_once(' ')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (bounds, _) = range.split_once('/')?;
    let (start, end) = bounds.split_once('-')?;
    Some((start.trim().parse().ok()?, end.trim().parse().ok()?))
}

/// Production spawner that delegates to the real aria2 RPC and yt-dlp runners.
pub struct ProductionSpawner {
    app_handle: AppHandle<tauri::Wry>,
}

const ARIA2_MIN_SPLIT_SIZE: &str = "1M";
const ARIA2_STREAM_PIECE_SELECTOR: &str = "inorder";
const ARIA2_DEFAULT_TORRENT_MAX_PEERS: u32 = 55;
const ARIA2_DEFAULT_TORRENT_PEER_SPEED_LIMIT: &str = "50K";
const MAX_TORRENT_MAX_PEERS: u32 = 1000;
pub(crate) const MAX_TORRENT_STOP_TIMEOUT: u32 = 7 * 24 * 60 * 60;
pub(crate) const MAX_TORRENT_PEER_DIAGNOSTICS: usize = 128;
const MAX_TORRENT_PEER_RESPONSE: usize = 4096;
const MAX_TORRENT_TRACKERS: usize = 64;
const MAX_TORRENT_TRACKER_BYTES: usize = 16 * 1024;

fn apply_aria2_connection_options(
    options: &mut serde_json::Map<String, serde_json::Value>,
    connections: i32,
) {
    let connections = clamp_download_connections(connections);
    options.insert(
        "split".to_string(),
        serde_json::json!(connections.to_string()),
    );
    options.insert(
        "max-connection-per-server".to_string(),
        serde_json::json!(connections.to_string()),
    );
    // aria2's 20M default suppresses segmentation for files smaller than
    // 40M. Keep the requested connection count useful for ordinary release
    // assets while retaining a 1M lower bound to avoid tiny range requests.
    options.insert(
        "min-split-size".to_string(),
        serde_json::json!(ARIA2_MIN_SPLIT_SIZE),
    );
    // Aria2's default selector deliberately reduces the number of established
    // connections over time. Keep a segmented HTTP transfer replenishing its
    // requested ranges so a healthy host does not degrade from (for example)
    // 16 active connections to one or two after early pieces finish.
    options.insert(
        "stream-piece-selector".to_string(),
        serde_json::json!(ARIA2_STREAM_PIECE_SELECTOR),
    );
}

fn format_aria2_torrent_number(value: f64, field: &str) -> Result<String, String> {
    if !value.is_finite() || value < 0.0 {
        return Err(format!("torrent {field} must be a finite non-negative number"));
    }
    Ok(value.to_string())
}

fn normalize_torrent_max_peers(value: Option<i64>) -> Result<Option<u32>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if !(0..=i64::from(MAX_TORRENT_MAX_PEERS)).contains(&value) {
        return Err(format!(
            "torrent maximum peers must be between 0 and {MAX_TORRENT_MAX_PEERS}"
        ));
    }
    Ok(Some(value as u32))
}

fn normalize_torrent_peer_speed_limit(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    crate::normalize_speed_limit_for_aria2(value)
        .map(Some)
        .ok_or_else(|| "torrent peer speed limit must be greater than zero".to_string())
}

pub(crate) fn normalize_torrent_stop_timeout(value: Option<u32>) -> Result<Option<u32>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value > MAX_TORRENT_STOP_TIMEOUT {
        return Err(format!(
            "torrent stall timeout must be between 0 and {MAX_TORRENT_STOP_TIMEOUT} seconds"
        ));
    }
    Ok(Some(value))
}

fn normalize_torrent_piece_priority_size(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("torrent piece priority size must use a positive K or M value".to_string());
    }
    let Some((unit_start, unit)) = value.char_indices().next_back() else {
        return Err("torrent piece priority size must use a positive K or M value".to_string());
    };
    let amount = &value[..unit_start];
    let unit = unit.to_ascii_uppercase();
    if !matches!(unit, 'K' | 'M') || amount.is_empty() {
        return Err("torrent piece priority size must use a positive K or M value".to_string());
    }
    let amount = amount
        .parse::<u64>()
        .map_err(|_| "torrent piece priority size must use a positive K or M value".to_string())?;
    if amount == 0
        || (unit == 'M' && amount > MAX_TORRENT_PIECE_PRIORITY_SIZE_MIB)
        || (unit == 'K' && amount > MAX_TORRENT_PIECE_PRIORITY_SIZE_MIB * 1024)
    {
        return Err(format!(
            "torrent piece priority size must be between 1K and {}M",
            MAX_TORRENT_PIECE_PRIORITY_SIZE_MIB
        ));
    }
    Ok(format!("{amount}{unit}"))
}

pub(crate) fn normalize_torrent_prioritize_piece(
    value: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if raw.len() > 64 {
        return Err("torrent piece priority is too long".to_string());
    }

    let mut head = None;
    let mut tail = None;
    for token in raw.split(',') {
        let token = token.trim();
        if token.is_empty() {
            return Err("torrent piece priority contains an empty entry".to_string());
        }
        let (keyword, size) = token
            .split_once('=')
            .map_or((token, None), |(keyword, size)| {
                (keyword.trim(), Some(size))
            });
        let keyword = keyword.to_ascii_lowercase();
        let normalized_size = size
            .map(normalize_torrent_piece_priority_size)
            .transpose()?;
        let normalized = normalized_size
            .map(|size| format!("{keyword}={size}"))
            .unwrap_or_else(|| keyword.clone());
        match keyword.as_str() {
            "head" => {
                if head.is_some() {
                    return Err("torrent piece priority cannot repeat head".to_string());
                }
                head = Some(normalized);
            }
            "tail" => {
                if tail.is_some() {
                    return Err("torrent piece priority cannot repeat tail".to_string());
                }
                tail = Some(normalized);
            }
            _ => return Err("torrent piece priority must use head and/or tail".to_string()),
        }
    }

    let mut normalized = Vec::with_capacity(2);
    if let Some(head) = head {
        normalized.push(head);
    }
    if let Some(tail) = tail {
        normalized.push(tail);
    }
    if normalized.is_empty() {
        return Ok(None);
    }
    Ok(Some(normalized.join(",")))
}

fn aria2_peer_number(value: Option<&serde_json::Value>) -> u64 {
    match value {
        Some(serde_json::Value::String(value)) => value.parse().unwrap_or_default(),
        Some(serde_json::Value::Number(value)) => value.as_u64().unwrap_or_default(),
        _ => 0,
    }
}

fn aria2_peer_bool(value: Option<&serde_json::Value>) -> bool {
    match value {
        Some(serde_json::Value::Bool(value)) => *value,
        Some(serde_json::Value::String(value)) => {
            value.eq_ignore_ascii_case("true") || value == "1"
        }
        _ => false,
    }
}

pub(crate) fn parse_torrent_peer_diagnostics(
    result: serde_json::Value,
) -> Result<crate::ipc::TorrentPeerDiagnostics, String> {
    let peers = result
        .as_array()
        .ok_or_else(|| "aria2.getPeers returned a non-array result".to_string())?;
    if peers.len() > MAX_TORRENT_PEER_RESPONSE {
        return Err("aria2.getPeers returned too many peers".to_string());
    }
    if peers.iter().any(|peer| !peer.is_object()) {
        return Err("aria2.getPeers returned malformed peer data".to_string());
    }
    let total_peers = u32::try_from(peers.len()).unwrap_or(u32::MAX);
    let mut total_seeders = 0u32;
    let mut sanitized = Vec::with_capacity(peers.len().min(MAX_TORRENT_PEER_DIAGNOSTICS));

    for peer in peers.iter().take(MAX_TORRENT_PEER_DIAGNOSTICS) {
        let peer = peer
            .as_object()
            .ok_or_else(|| "aria2.getPeers returned malformed peer data".to_string())?;
        let seeder = aria2_peer_bool(peer.get("seeder"));
        if seeder {
            total_seeders = total_seeders.saturating_add(1);
        }
        sanitized.push(crate::ipc::TorrentPeer {
            download_speed: aria2_peer_number(peer.get("downloadSpeed")),
            upload_speed: aria2_peer_number(peer.get("uploadSpeed")),
            seeder,
            am_choking: aria2_peer_bool(peer.get("amChoking")),
            peer_choking: aria2_peer_bool(peer.get("peerChoking")),
        });
    }

    // Count seeders beyond the display cap without retaining any identifying
    // peer data. The response is bounded by Aria2's per-Torrent peer limit,
    // while the UI receives at most MAX_TORRENT_PEER_DIAGNOSTICS rows.
    for peer in peers.iter().skip(MAX_TORRENT_PEER_DIAGNOSTICS) {
        let peer = peer
            .as_object()
            .ok_or_else(|| "aria2.getPeers returned malformed peer data".to_string())?;
        if aria2_peer_bool(peer.get("seeder")) {
            total_seeders = total_seeders.saturating_add(1);
        }
    }

    Ok(crate::ipc::TorrentPeerDiagnostics {
        total_peers,
        total_seeders,
        peers: sanitized,
        truncated: peers.len() > MAX_TORRENT_PEER_DIAGNOSTICS,
    })
}

fn normalize_torrent_tracker_list(
    value: Option<&str>,
    allow_wildcard: bool,
) -> Result<Option<String>, String> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if raw.len() > MAX_TORRENT_TRACKER_BYTES {
        return Err(format!(
            "torrent tracker list must be at most {MAX_TORRENT_TRACKER_BYTES} bytes"
        ));
    }

    let mut trackers = Vec::new();
    let mut wildcard = false;
    let mut serialized_bytes = 0usize;
    for line in raw.split(['\r', '\n']) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        for token in line.split(',') {
            let token = token.trim();
            if token.is_empty() {
                return Err("torrent tracker list contains an empty entry".to_string());
            }
            if token.chars().any(char::is_control) {
                return Err("torrent tracker URI contains a control character".to_string());
            }
            if allow_wildcard && token == "*" {
                if !trackers.is_empty() {
                    return Err(
                        "torrent tracker exclusion wildcard cannot be combined with tracker URLs"
                            .to_string(),
                    );
                }
                wildcard = true;
                continue;
            }
            if wildcard {
                return Err(
                    "torrent tracker exclusion wildcard cannot be combined with tracker URLs"
                        .to_string(),
                );
            }
            let parsed = url::Url::parse(token)
                .map_err(|_| "torrent tracker URI is invalid".to_string())?;
            if !matches!(parsed.scheme(), "http" | "https" | "udp") {
                return Err("torrent tracker URI must use http, https, or udp".to_string());
            }
            if parsed.host_str().is_none_or(str::is_empty) {
                return Err("torrent tracker URI must include a host".to_string());
            }
            if !parsed.username().is_empty() || parsed.password().is_some() {
                return Err("torrent tracker URI must not contain credentials".to_string());
            }
            if parsed.fragment().is_some() {
                return Err("torrent tracker URI must not contain a fragment".to_string());
            }

            let normalized = parsed.to_string();
            if trackers.iter().any(|tracker| tracker == &normalized) {
                continue;
            }
            if trackers.len() >= MAX_TORRENT_TRACKERS {
                return Err(format!(
                    "torrent tracker list must contain at most {MAX_TORRENT_TRACKERS} trackers"
                ));
            }
            serialized_bytes = serialized_bytes
                .checked_add(normalized.len())
                .and_then(|bytes| bytes.checked_add(if trackers.is_empty() { 0 } else { 1 }))
                .ok_or_else(|| "torrent tracker list is too large".to_string())?;
            if serialized_bytes > MAX_TORRENT_TRACKER_BYTES {
                return Err(format!(
                    "torrent tracker list must be at most {MAX_TORRENT_TRACKER_BYTES} bytes"
                ));
            }
            trackers.push(normalized);
        }
    }

    if wildcard {
        return Ok(Some("*".to_string()));
    }
    if trackers.is_empty() {
        return Ok(None);
    }
    Ok(Some(trackers.join(",")))
}

pub(crate) fn normalize_torrent_trackers(value: Option<&str>) -> Result<Option<String>, String> {
    normalize_torrent_tracker_list(value, false)
}

pub(crate) fn normalize_torrent_exclude_trackers(
    value: Option<&str>,
) -> Result<Option<String>, String> {
    normalize_torrent_tracker_list(value, true)
}

fn normalize_torrent_tracker_timeout(value: Option<u32>, field: &str) -> Result<Option<u32>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if !(1..=MAX_TORRENT_TRACKER_TIMEOUT).contains(&value) {
        return Err(format!(
            "torrent {field} must be between 1 and {MAX_TORRENT_TRACKER_TIMEOUT} seconds"
        ));
    }
    Ok(Some(value))
}

pub(crate) fn normalize_torrent_tracker_connect_timeout(
    value: Option<u32>,
) -> Result<Option<u32>, String> {
    normalize_torrent_tracker_timeout(value, "tracker connect timeout")
}

pub(crate) fn normalize_torrent_tracker_request_timeout(
    value: Option<u32>,
) -> Result<Option<u32>, String> {
    normalize_torrent_tracker_timeout(value, "tracker timeout")
}

pub(crate) fn normalize_torrent_tracker_interval(
    value: Option<u32>,
) -> Result<Option<u32>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value > MAX_TORRENT_TRACKER_INTERVAL {
        return Err(format!(
            "torrent tracker interval must be between 0 and {MAX_TORRENT_TRACKER_INTERVAL} seconds"
        ));
    }
    Ok(Some(value))
}

pub(crate) fn normalize_torrent_encryption_policy(
    value: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    match raw {
        "disabled" => Ok(None),
        "require-crypto" => Ok(Some("require-crypto".to_string())),
        "force-encryption" => Ok(Some("force-encryption".to_string())),
        _ => Err(
            "torrent encryption policy must be disabled, require-crypto, or force-encryption"
                .to_string(),
        ),
    }
}

fn apply_aria2_torrent_options(
    options: &mut serde_json::Map<String, serde_json::Value>,
    payload: &SpawnPayload,
) -> Result<(), String> {
    if !payload.is_torrent {
        return Ok(());
    }

    let encryption_policy =
        normalize_torrent_encryption_policy(payload.torrent_encryption_policy.as_deref())?;
    let (force_encryption, require_crypto, min_crypto_level) =
        match encryption_policy.as_deref() {
            Some("require-crypto") => (false, true, "plain"),
            Some("force-encryption") => (true, true, "arc4"),
            None => (false, false, "plain"),
            Some(policy) => {
                return Err(format!("unsupported normalized Torrent encryption policy: {policy}"));
            }
        };
    options.insert(
        "bt-force-encryption".to_string(),
        serde_json::json!(force_encryption.to_string()),
    );
    options.insert(
        "bt-require-crypto".to_string(),
        serde_json::json!(require_crypto.to_string()),
    );
    options.insert(
        "bt-min-crypto-level".to_string(),
        serde_json::json!(min_crypto_level),
    );

    let seed_time = payload
        .torrent_seed_time
        .map(|value| format_aria2_torrent_number(value, "seed time"))
        .transpose()?;
    let seed_ratio = payload
        .torrent_seed_ratio
        .map(|value| format_aria2_torrent_number(value, "seed ratio"))
        .transpose()?;

    // Aria2 treats seed-time=0 as an explicit disable. Omit it when a ratio
    // policy exists so ratio-only and unlimited-ratio policies remain active.
    // With no policy, keep the explicit zero to prevent daemon defaults from
    // turning a normal Torrent download into an untracked seeding lifecycle.
    if seed_ratio.is_none() || payload.torrent_seed_time.is_some_and(|value| value > 0.0) {
        options.insert(
            "seed-time".to_string(),
            serde_json::json!(seed_time.unwrap_or_else(|| "0".to_string())),
        );
    }

    if let Some(seed_ratio) = seed_ratio {
        options.insert("seed-ratio".to_string(), serde_json::json!(seed_ratio));
    }

    if let Some(upload_limit) = payload.torrent_upload_limit.as_deref() {
        let normalized = crate::normalize_speed_limit_for_aria2(upload_limit)
            .ok_or_else(|| "torrent upload limit must be greater than zero".to_string())?;
        options.insert("max-upload-limit".to_string(), serde_json::json!(normalized));
    }

    if let Some(max_peers) = payload.torrent_max_peers {
        if max_peers > MAX_TORRENT_MAX_PEERS {
            return Err(format!(
                "torrent maximum peers must be between 0 and {MAX_TORRENT_MAX_PEERS}"
            ));
        }
        options.insert(
            "bt-max-peers".to_string(),
            serde_json::json!(max_peers.to_string()),
        );
    }

    if let Some(peer_speed_limit) = payload.torrent_peer_speed_limit.as_deref() {
        let normalized = normalize_torrent_peer_speed_limit(Some(peer_speed_limit))
            ?.ok_or_else(|| "torrent peer speed limit must be greater than zero".to_string())?;
        options.insert(
            "bt-request-peer-speed-limit".to_string(),
            serde_json::json!(normalized),
        );
    }
    if let Some(trackers) = normalize_torrent_trackers(payload.torrent_trackers.as_deref())? {
        options.insert("bt-tracker".to_string(), serde_json::json!(trackers));
    }
    if let Some(trackers) =
        normalize_torrent_exclude_trackers(payload.torrent_exclude_trackers.as_deref())?
    {
        options.insert("bt-exclude-tracker".to_string(), serde_json::json!(trackers));
    }
    if let Some(timeout) = normalize_torrent_tracker_connect_timeout(
        payload.torrent_tracker_connect_timeout,
    )? {
        options.insert(
            "bt-tracker-connect-timeout".to_string(),
            serde_json::json!(timeout.to_string()),
        );
    }
    if let Some(timeout) =
        normalize_torrent_tracker_request_timeout(payload.torrent_tracker_timeout)?
    {
        options.insert(
            "bt-tracker-timeout".to_string(),
            serde_json::json!(timeout.to_string()),
        );
    }
    if let Some(interval) = normalize_torrent_tracker_interval(payload.torrent_tracker_interval)? {
        options.insert(
            "bt-tracker-interval".to_string(),
            serde_json::json!(interval.to_string()),
        );
    }
    if let Some(stop_timeout) = normalize_torrent_stop_timeout(payload.torrent_stop_timeout)? {
        options.insert(
            "bt-stop-timeout".to_string(),
            serde_json::json!(stop_timeout.to_string()),
        );
    }
    if let Some(piece_priority) =
        normalize_torrent_prioritize_piece(payload.torrent_prioritize_piece.as_deref())?
    {
        options.insert(
            "bt-prioritize-piece".to_string(),
            serde_json::json!(piece_priority),
        );
    }
    if payload.torrent_remove_unselected_file {
        let Some(indices) = payload.torrent_file_indices.as_deref() else {
            return Err(
                "removing unselected Torrent files requires selecting a subset of files"
                    .to_string(),
            );
        };
        if indices.is_empty() {
            return Err("torrent file selection is invalid".to_string());
        }
        options.insert(
            "bt-remove-unselected-file".to_string(),
            serde_json::json!("true"),
        );
    }
    if payload.torrent_check_integrity {
        options.insert(
            "check-integrity".to_string(),
            serde_json::json!("true"),
        );
        options.insert(
            "bt-hash-check-seed".to_string(),
            serde_json::json!(torrent_seeding_requested(payload).to_string()),
        );
        // Do not let a daemon-wide bt-seed-unverified setting bypass the
        // explicit per-download integrity request.
        options.insert(
            "bt-seed-unverified".to_string(),
            serde_json::json!("false"),
        );
    }
    Ok(())
}

impl ProductionSpawner {
    pub fn new(app_handle: AppHandle<tauri::Wry>) -> Self {
        Self { app_handle }
    }

    async fn add_transfer_rpc(
        &self,
        state: &crate::AppState,
        method: &str,
        params: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            match crate::rpc_call(
                state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
                &state.aria2_secret,
                method,
                params.clone(),
            )
            .await
            {
                Ok(result) => return Ok(result),
                Err(error) => {
                    if !is_aria2_rpc_unavailable(&error) || std::time::Instant::now() >= deadline {
                        return Err(error);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            }
        }
    }
}

#[async_trait::async_trait]
impl SidecarSpawner for ProductionSpawner {
    async fn add_uri(&self, id: &str, payload: &SpawnPayload) -> Result<String, String> {
        let state = self.app_handle.state::<crate::AppState>();
        let mut options = serde_json::Map::new();
        let resolved_dest = crate::resolve_path(&payload.destination, &self.app_handle);
        if !crate::is_safe_path(&resolved_dest, &self.app_handle) {
            return Err("Path traversal blocked".to_string());
        }
        let proxy_value = payload
            .proxy
            .as_deref()
            .map(aria2_all_proxy_value)
            .transpose()?
            .flatten();
        options.insert(
            "dir".to_string(),
            serde_json::json!(resolved_dest.to_string_lossy().to_string()),
        );
        let safe_filename =
            crate::download_ownership::canonical_download_filename(&payload.filename);
        if !payload.is_torrent {
            options.insert("out".to_string(), serde_json::json!(safe_filename));
        }
        let conn = effective_aria2_connections(id, payload).await;
        apply_aria2_connection_options(&mut options, conn);
        apply_aria2_torrent_options(&mut options, payload)?;
        let mt = aria2_attempt_limit(payload.max_tries);
        options.insert("max-tries".to_string(), serde_json::json!(mt.to_string()));
        options.insert("retry-wait".to_string(), serde_json::json!("2"));
        options.insert("connect-timeout".to_string(), serde_json::json!("20"));
        options.insert("timeout".to_string(), serde_json::json!("60"));
        options.insert("continue".to_string(), serde_json::json!("true"));
        options.insert("always-resume".to_string(), serde_json::json!("true"));
        options.insert("auto-file-renaming".to_string(), serde_json::json!("false"));
        if let Some(speed) = payload
            .speed_limit
            .as_deref()
            .and_then(crate::normalize_speed_limit_for_aria2)
        {
            options.insert("max-download-limit".to_string(), serde_json::json!(speed));
        }
        if let Some(user) = &payload.username {
            options.insert("http-user".to_string(), serde_json::json!(user));
        }
        if let Some(pass) = &payload.password {
            options.insert("http-passwd".to_string(), serde_json::json!(pass));
        }
        if let Some(chk) = &payload.checksum {
            let formatted_chk = if let Some((algo, digest)) = chk.split_once('=') {
                format!("{}={}", algo.to_ascii_lowercase(), digest)
            } else {
                chk.clone()
            };
            options.insert("checksum".to_string(), serde_json::json!(formatted_chk));
        }
        if let Some(ua) = &payload.user_agent {
            options.insert("user-agent".to_string(), serde_json::json!(ua));
        }
        let mut header_list = Vec::new();
        if let Some(cook) = &payload.cookies {
            header_list.push(format!("Cookie: {}", cook));
        }
        if let Some(hdrs) = &payload.headers {
            for line in hdrs.lines() {
                if !line.trim().is_empty() {
                    header_list.push(line.trim().to_string());
                }
            }
        }
        if !header_list.is_empty() {
            options.insert("header".to_string(), serde_json::json!(header_list));
        }
        if let Some(prox) = proxy_value {
            options.insert("all-proxy".to_string(), serde_json::json!(prox));
        }

        let (method, params) = if payload.is_torrent {
            if let Some(path) = payload.torrent_path.as_deref() {
                let path = crate::torrent::validate_managed_torrent_path(
                    &self.app_handle,
                    id,
                    path,
                )?;
                let bytes = tokio::fs::read(&path)
                    .await
                    .map_err(|error| format!("could not read cached torrent metadata: {error}"))?;
                let metadata = crate::torrent::parse_torrent_bytes(&bytes)?;
                options.insert(
                    "index-out".to_string(),
                    serde_json::json!(crate::torrent::aria2_index_outputs(&metadata)),
                );
                let selected = crate::torrent::validate_selected_indices(
                    payload.torrent_file_indices.as_deref(),
                    metadata.files.len(),
                )?;
                if let Some(indices) = selected {
                    options.insert(
                        "select-file".to_string(),
                        serde_json::json!(indices.iter().map(u32::to_string).collect::<Vec<_>>().join(",")),
                    );
                }
                let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                let uris = payload
                    .mirrors
                    .as_deref()
                    .map(|mirrors| crate::collect_download_uris("", Some(mirrors)))
                    .unwrap_or_default();
                ("aria2.addTorrent", serde_json::json!([encoded, uris, options]))
            } else {
                let parsed = url::Url::parse(&payload.url)
                    .map_err(|_| "invalid magnet URI".to_string())?;
                if parsed.scheme() != "magnet" {
                    return Err("torrent transfer has no magnet URI or cached metadata".to_string());
                }
                let selected = crate::torrent::validate_selected_indices(
                    payload.torrent_file_indices.as_deref(),
                    usize::MAX,
                )?;
                if selected.is_some() {
                    return Err("magnet file selection requires resolved torrent metadata".to_string());
                }
                ("aria2.addUri", serde_json::json!([[payload.url.clone()], options]))
            }
        } else {
            let uris = crate::collect_download_uris(&payload.url, payload.mirrors.as_deref());
            ("aria2.addUri", serde_json::json!([uris, options]))
        };

        match self.add_transfer_rpc(&state, method, &params).await {
            Ok(result) => {
                let gid = result.as_str().unwrap_or("").to_string();
                if gid.is_empty() {
                    Err(format!("{method} returned an empty gid"))
                } else {
                    log::info!("aria2 {} [{}]: created gid {}", method, id, gid);
                    Ok(gid)
                }
            }
            Err(e) => {
                let safe_error = crate::redact_sensitive_text(&e);
                log::error!("aria2 {} [{}] failed: {}", method, id, safe_error);
                Err(format!("aria2 {method} failed: {safe_error}"))
            }
        }
    }

    async fn remove_uri(&self, gid: &str) -> Result<(), String> {
        let state = self.app_handle.state::<crate::AppState>();
        let result = crate::rpc_call(
            state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
            &state.aria2_secret,
            "aria2.forceRemove",
            serde_json::json!([gid]),
        )
        .await?;
        match result.as_str() {
            Some(returned_gid) if returned_gid == gid => {
                crate::wait_for_aria2_stopped(
                    state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
                    &state.aria2_secret,
                    gid,
                )
                .await
            }
            Some(returned_gid) => Err(format!(
                "aria2.forceRemove returned unexpected gid {returned_gid}, expected {gid}"
            )),
            None => Err("aria2.forceRemove returned a non-string result".to_string()),
        }
    }

    async fn set_download_speed_limit(
        &self,
        gid: &str,
        limit: Option<&str>,
    ) -> Result<(), String> {
        let state = self.app_handle.state::<crate::AppState>();
        let limit = limit.unwrap_or("0");
        let result = crate::rpc_call(
            state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
            &state.aria2_secret,
            "aria2.changeOption",
            serde_json::json!([gid, {"max-download-limit": limit}]),
        )
        .await
        .map_err(|error| format!("aria2 changeOption failed for gid {gid}: {error}"))?;
        match result.as_str() {
            Some("OK") => Ok(()),
            Some(value) => Err(format!(
                "aria2.changeOption returned unexpected result {value} for gid {gid}"
            )),
            None => Err("aria2.changeOption returned a non-string result".to_string()),
        }
    }

    async fn set_torrent_upload_limit(
        &self,
        gid: &str,
        limit: Option<&str>,
    ) -> Result<(), String> {
        let state = self.app_handle.state::<crate::AppState>();
        let limit = limit.unwrap_or("0");
        let result = crate::rpc_call(
            state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
            &state.aria2_secret,
            "aria2.changeOption",
            serde_json::json!([gid, {"max-upload-limit": limit}]),
        )
        .await
        .map_err(|error| format!("aria2 changeOption failed for gid {gid}: {error}"))?;
        match result.as_str() {
            Some("OK") => Ok(()),
            Some(value) => Err(format!(
                "aria2.changeOption returned unexpected result {value} for gid {gid}"
            )),
            None => Err("aria2.changeOption returned a non-string result".to_string()),
        }
    }

    async fn set_torrent_peer_options(
        &self,
        gid: &str,
        max_peers: u32,
        peer_speed_limit: &str,
    ) -> Result<(), String> {
        let state = self.app_handle.state::<crate::AppState>();
        let result = crate::rpc_call(
            state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
            &state.aria2_secret,
            "aria2.changeOption",
            serde_json::json!([gid, {
                "bt-max-peers": max_peers.to_string(),
                "bt-request-peer-speed-limit": peer_speed_limit,
            }]),
        )
        .await
        .map_err(|error| format!("aria2.changeOption failed for gid {gid}: {error}"))?;
        match result.as_str() {
            Some("OK") => Ok(()),
            Some(value) => Err(format!(
                "aria2.changeOption returned unexpected result {value} for gid {gid}"
            )),
            None => Err("aria2.changeOption returned a non-string result".to_string()),
        }
    }

    async fn recreate_uri(
        &self,
        id: &str,
        gid: &str,
        payload: &SpawnPayload,
    ) -> Result<Aria2RecreateOutcome, String> {
        let state = self.app_handle.state::<crate::AppState>();
        let port = state.aria2_port.load(std::sync::atomic::Ordering::Relaxed);
        let secret = &state.aria2_secret;

        let status = match crate::aria2_download_status(port, secret, gid).await {
            Ok(status) => Some(status),
            Err(error) if crate::aria2_gid_not_found(&error) => {
                log::warn!(
                    "aria2 connection recovery [{}]: gid {} is already absent; rebuilding from the saved payload",
                    id,
                    gid
                );
                None
            }
            Err(error) => return Err(error),
        };

        if let Some(status) = status {
            match status.as_str() {
                "complete" => return Ok(Aria2RecreateOutcome::Complete),
                "active" | "waiting" => {
                    let pause_result = crate::rpc_call(
                        port,
                        secret,
                        "aria2.forcePause",
                        serde_json::json!([gid]),
                    )
                    .await;
                    if let Err(error) = pause_result {
                        match crate::aria2_download_status(port, secret, gid).await {
                            Ok(status) if status == "paused" => {
                                log::warn!(
                                    "aria2 connection recovery [{}]: forcePause for gid {} returned an error after the daemon paused it: {}",
                                    id,
                                    gid,
                                    error
                                );
                            }
                            Ok(status) if status == "complete" => {
                                return Ok(Aria2RecreateOutcome::Complete);
                            }
                            Ok(status)
                                if aria2_recovery_should_rebuild_after_pause_error(&status) =>
                            {
                                log::warn!(
                                    "aria2 connection recovery [{}]: gid {} disappeared after forcePause failed; rebuilding from the saved payload: {}",
                                    id,
                                    gid,
                                    error
                                );
                            }
                            Ok(status) => {
                                return Err(format!(
                                    "failed to pause aria2 gid {gid} before recreation: {error}; daemon reports {status}"
                                ));
                            }
                            Err(status_error) => {
                                return Err(format!(
                                    "failed to pause aria2 gid {gid} before recreation: {error}; status verification failed: {status_error}"
                                ));
                            }
                        }
                    }
                }
                "paused" => {}
                "removed" => {}
                other => {
                    return Err(format!(
                        "cannot recreate aria2 gid {gid} from daemon state {other}"
                    ));
                }
            }
        }

        let remove_result = crate::rpc_call(
            port,
            secret,
            "aria2.forceRemove",
            serde_json::json!([gid]),
        )
        .await;
        let remove_error = match remove_result {
            Ok(result) => crate::ensure_aria2_gid_result("forceRemove", gid, &result)
                .err()
                .map(|error| error.to_string()),
            Err(error) if crate::aria2_gid_not_found(&error) => None,
            Err(error) => Some(error.to_string()),
        };
        if let Some(error) = remove_error {
            match crate::aria2_download_status(port, secret, gid).await {
                Ok(status) if status == "complete" => {
                    return Ok(Aria2RecreateOutcome::Complete);
                }
                Ok(status) if status == "removed" => {}
                Ok(status) => {
                    return Err(format!(
                        "failed to remove aria2 gid {gid} before recreation: {error}; daemon reports {status}"
                    ));
                }
                Err(status_error) if crate::aria2_gid_not_found(&status_error) => {}
                Err(status_error) => {
                    return Err(format!(
                        "failed to remove aria2 gid {gid} before recreation: {error}; status verification failed: {status_error}"
                    ));
                }
            }
        }

        match self.add_uri(id, payload).await {
            Ok(new_gid) => Ok(Aria2RecreateOutcome::NewGid(new_gid)),
            Err(error) => Ok(Aria2RecreateOutcome::Unavailable(error)),
        }
    }

    async fn refresh_uri(&self, gid: &str) -> Result<Aria2RefreshOutcome, String> {
        let state = self.app_handle.state::<crate::AppState>();
        let port = state.aria2_port.load(std::sync::atomic::Ordering::Relaxed);
        let secret = &state.aria2_secret;
        let pause_error = match crate::rpc_call(
            port,
            secret,
            "aria2.forcePause",
            serde_json::json!([gid]),
        )
        .await
        {
            Ok(result) => crate::ensure_aria2_gid_result("forcePause", gid, &result)
                .err()
                .map(|error| error.to_string()),
            Err(error) => Some(format!("failed to refresh aria2 gid {gid}: {error}")),
        };

        if let Some(error) = pause_error {
            match crate::aria2_download_status(port, secret, gid).await {
                Ok(status) if status == "paused" => {
                    log::warn!(
                        "aria2 connection refresh: forcePause for gid {} failed after the daemon paused it; continuing with unpause",
                        gid
                    );
                }
                Ok(status) if status == "complete" => {
                    return Ok(Aria2RefreshOutcome::Complete);
                }
                Ok(status) => {
                    return Err(format!("{error}; aria2 gid {gid} is still {status}"));
                }
                Err(status_error) => {
                    return Err(format!(
                        "{error}; failed to verify aria2 gid {gid}: {status_error}"
                    ));
                }
            }
        }

        let unpause_error = match crate::rpc_call(
            port,
            secret,
            "aria2.unpause",
            serde_json::json!([gid]),
        )
        .await
        {
            Ok(result) => crate::ensure_aria2_gid_result("unpause", gid, &result)
                .err()
                .map(|error| error.to_string()),
            Err(error) => Some(format!("failed to refresh aria2 gid {gid}: {error}")),
        };

        let Some(error) = unpause_error else {
            return Ok(Aria2RefreshOutcome::Resumed);
        };
        let status = crate::aria2_download_status(port, secret, gid).await?;
        match status.as_str() {
            "active" | "waiting" => Ok(Aria2RefreshOutcome::Resumed),
            "paused" => Ok(Aria2RefreshOutcome::Paused),
            "complete" => Ok(Aria2RefreshOutcome::Complete),
            _ => Err(format!(
                "{error}; aria2 gid {gid} reports terminal or unknown state {status}"
            )),
        }
    }

    async fn run_media(
        &self,
        id: &str,
        payload: &SpawnPayload,
        lifecycle_generation: u64,
    ) -> Result<(), String> {
        let state = self.app_handle.state::<crate::AppState>();
        // Serialize registration with pause/remove/detach. If the queue
        // lifecycle was invalidated before this worker reached the
        // coordinator, do not create a late media registration that could
        // outlive the row's permit and ownership.
        let control_guard = state.queue_manager.acquire_aria2_control(id).await;
        if !state
            .queue_manager
            .is_registered_generation(id, lifecycle_generation)
            .await
        {
            drop(control_guard);
            return Err(crate::queue::MEDIA_RUN_CANCELLED.to_string());
        }
        let mut cancel_rx = state
            .download_coordinator
            .register_media(id.to_string(), lifecycle_generation)
            .await?;
        drop(control_guard);
        let outcome = if *cancel_rx.borrow() {
            Err(crate::queue::MEDIA_RUN_CANCELLED.to_string())
        } else {
            crate::start_media_download_internal(
                self.app_handle.clone(),
                id,
                payload.url.clone(),
                payload.destination.clone(),
                payload.filename.clone(),
                payload.format_selector.clone(),
                payload.connections,
                payload.cookie_source.clone(),
                payload.speed_limit.clone(),
                payload.username.clone(),
                payload.password.clone(),
                payload.headers.clone(),
                payload.cookies.clone(),
                payload.proxy.clone(),
                payload.user_agent.clone(),
                payload.max_tries,
                &mut cancel_rx,
            )
            .await
        };
        if let Ok(path) = outcome.as_ref() {
            let _ = crate::download_ownership::set_primary_path(&self.app_handle, id, path);
            if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
                use tauri::Emitter;
                let _ = self.app_handle.emit(
                    "download-state",
                    crate::ipc::DownloadStateEvent::completed_with_file(id, file_name),
                );
            }
        }
        let _ = state
            .download_coordinator
            .finish_media(id.to_string(), lifecycle_generation)
            .await;
        outcome.map(|_| ())
    }
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EnqueueItem {
    pub id: String,
    pub queue_id: String,
    pub url: String,
    pub destination: String,
    pub filename: String,
    pub connections: Option<i32>,
    pub speed_limit: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub headers: Option<String>,
    pub checksum: Option<String>,
    pub cookies: Option<String>,
    pub mirrors: Option<String>,
    pub user_agent: Option<String>,
    pub max_tries: Option<i32>,
    pub proxy: Option<String>,
    pub format_selector: Option<String>,
    pub cookie_source: Option<String>,
    pub is_media: Option<bool>,
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
    pub lifecycle_generation: Option<String>,
}

impl EnqueueItem {
    pub fn into_task(self) -> QueuedTask {
        let media = self.is_media.unwrap_or(false);
        let kind = if media {
            TaskKind::Media
        } else {
            TaskKind::Aria2
        };
        let id = self.id.clone();
        QueuedTask {
            id,
            queue_id: self.queue_id,
            kind,
            lifecycle_generation: self
                .lifecycle_generation
                .as_deref()
                .and_then(|generation| generation.parse().ok())
                .unwrap_or_default(),
            payload: SpawnPayload {
                url: self.url,
                destination: self.destination,
                filename: self.filename,
                connections: self.connections,
                speed_limit: self.speed_limit,
                username: self.username,
                password: self.password,
                headers: self.headers,
                checksum: self.checksum,
                cookies: self.cookies,
                mirrors: self.mirrors,
                user_agent: self.user_agent,
                max_tries: self.max_tries,
                proxy: self.proxy,
                format_selector: self.format_selector,
                cookie_source: self.cookie_source,
                is_media: media,
                is_torrent: self.is_torrent.unwrap_or(false),
                torrent_path: self.torrent_path,
                torrent_file_indices: self.torrent_file_indices,
                torrent_seed_time: self.torrent_seed_time,
                torrent_seed_ratio: self.torrent_seed_ratio,
                torrent_upload_limit: self.torrent_upload_limit,
                torrent_max_peers: self.torrent_max_peers,
                torrent_peer_speed_limit: self.torrent_peer_speed_limit,
                torrent_check_integrity: self.torrent_check_integrity.unwrap_or(false),
                torrent_trackers: self.torrent_trackers,
                torrent_exclude_trackers: self.torrent_exclude_trackers,
                torrent_tracker_connect_timeout: self.torrent_tracker_connect_timeout,
                torrent_tracker_timeout: self.torrent_tracker_timeout,
                torrent_tracker_interval: self.torrent_tracker_interval,
                torrent_stop_timeout: self.torrent_stop_timeout,
                torrent_prioritize_piece: self.torrent_prioritize_piece,
                torrent_remove_unselected_file: self
                    .torrent_remove_unselected_file
                    .unwrap_or(false),
                torrent_encryption_policy: self.torrent_encryption_policy,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestSpawner;

    #[async_trait::async_trait]
    impl SidecarSpawner for TestSpawner {
        async fn add_uri(&self, _id: &str, _payload: &SpawnPayload) -> Result<String, String> {
            Ok("test-gid".to_string())
        }

        async fn remove_uri(&self, _gid: &str) -> Result<(), String> {
            Ok(())
        }

        async fn run_media(
            &self,
            _id: &str,
            _payload: &SpawnPayload,
            _lifecycle_generation: u64,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn aria2_connection_options_enable_requested_ranges_for_small_release_assets() {
        let mut options = serde_json::Map::new();

        apply_aria2_connection_options(&mut options, 16);

        assert_eq!(options.get("split"), Some(&serde_json::json!("16")));
        assert_eq!(
            options.get("max-connection-per-server"),
            Some(&serde_json::json!("16"))
        );
        assert_eq!(
            options.get("min-split-size"),
            Some(&serde_json::json!("1M"))
        );
        assert_eq!(
            options.get("stream-piece-selector"),
            Some(&serde_json::json!("inorder"))
        );
    }

    #[test]
    fn torrent_options_disable_seeding_when_no_policy_is_saved() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            ..Default::default()
        };

        apply_aria2_torrent_options(&mut options, &payload).unwrap();

        assert_eq!(options.get("seed-time"), Some(&serde_json::json!("0")));
        assert!(!options.contains_key("max-upload-limit"));
        assert_eq!(
            options.get("bt-force-encryption"),
            Some(&serde_json::json!("false"))
        );
        assert_eq!(
            options.get("bt-require-crypto"),
            Some(&serde_json::json!("false"))
        );
        assert_eq!(
            options.get("bt-min-crypto-level"),
            Some(&serde_json::json!("plain"))
        );
    }

    #[test]
    fn torrent_encryption_policy_maps_to_one_consistent_aria2_policy() {
        let cases = [
            (
                Some("require-crypto"),
                ("false", "true", "plain"),
            ),
            (
                Some("force-encryption"),
                ("true", "true", "arc4"),
            ),
            (None, ("false", "false", "plain")),
        ];

        for (policy, expected) in cases {
            let mut options = serde_json::Map::new();
            let payload = SpawnPayload {
                is_torrent: true,
                torrent_encryption_policy: policy.map(str::to_string),
                ..Default::default()
            };

            apply_aria2_torrent_options(&mut options, &payload).unwrap();

            assert_eq!(
                options.get("bt-force-encryption"),
                Some(&serde_json::json!(expected.0))
            );
            assert_eq!(
                options.get("bt-require-crypto"),
                Some(&serde_json::json!(expected.1))
            );
            assert_eq!(
                options.get("bt-min-crypto-level"),
                Some(&serde_json::json!(expected.2))
            );
        }
    }

    #[test]
    fn torrent_encryption_policy_rejects_unknown_values() {
        assert_eq!(normalize_torrent_encryption_policy(None).unwrap(), None);
        assert_eq!(
            normalize_torrent_encryption_policy(Some(" disabled ")).unwrap(),
            None
        );
        assert_eq!(
            normalize_torrent_encryption_policy(Some("require-crypto")).unwrap(),
            Some("require-crypto".to_string())
        );
        assert!(normalize_torrent_encryption_policy(Some("arc4")).is_err());
        assert!(normalize_torrent_encryption_policy(Some("true")).is_err());
    }

    #[test]
    fn torrent_encryption_policy_is_not_applied_to_non_torrent_payloads() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            torrent_encryption_policy: Some("force-encryption".to_string()),
            ..Default::default()
        };

        apply_aria2_torrent_options(&mut options, &payload).unwrap();

        assert!(!options.contains_key("bt-force-encryption"));
        assert!(!options.contains_key("bt-require-crypto"));
        assert!(!options.contains_key("bt-min-crypto-level"));
    }

    #[test]
    fn torrent_options_preserve_seed_policy_and_upload_limit() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_seed_time: Some(30.0),
            torrent_seed_ratio: Some(1.5),
            torrent_upload_limit: Some("2 MiB/s".to_string()),
            torrent_max_peers: Some(120),
            torrent_peer_speed_limit: Some("2M".to_string()),
            ..Default::default()
        };

        apply_aria2_torrent_options(&mut options, &payload).unwrap();

        assert_eq!(options.get("seed-time"), Some(&serde_json::json!("30")));
        assert_eq!(options.get("seed-ratio"), Some(&serde_json::json!("1.5")));
        assert_eq!(
            options.get("max-upload-limit"),
            Some(&serde_json::json!("2M"))
        );
        assert_eq!(
            options.get("bt-max-peers"),
            Some(&serde_json::json!("120"))
        );
        assert_eq!(
            options.get("bt-request-peer-speed-limit"),
            Some(&serde_json::json!("2M"))
        );
        assert!(torrent_seeding_requested(&payload));
    }

    #[test]
    fn torrent_options_support_ratio_only_seeding_without_disabling_seed_time() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_seed_ratio: Some(1.5),
            ..Default::default()
        };

        apply_aria2_torrent_options(&mut options, &payload).unwrap();

        assert!(!options.contains_key("seed-time"));
        assert_eq!(options.get("seed-ratio"), Some(&serde_json::json!("1.5")));
        assert!(torrent_seeding_requested(&payload));
    }

    #[test]
    fn torrent_integrity_check_does_not_enter_seeding_without_a_seed_policy() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_check_integrity: true,
            ..Default::default()
        };

        apply_aria2_torrent_options(&mut options, &payload).unwrap();

        assert_eq!(options.get("check-integrity"), Some(&serde_json::json!("true")));
        assert_eq!(
            options.get("bt-hash-check-seed"),
            Some(&serde_json::json!("false"))
        );
        assert_eq!(
            options.get("bt-seed-unverified"),
            Some(&serde_json::json!("false"))
        );
    }

    #[test]
    fn torrent_integrity_check_preserves_an_explicit_seeding_policy() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_check_integrity: true,
            torrent_seed_ratio: Some(1.0),
            ..Default::default()
        };

        apply_aria2_torrent_options(&mut options, &payload).unwrap();

        assert_eq!(options.get("check-integrity"), Some(&serde_json::json!("true")));
        assert_eq!(
            options.get("bt-hash-check-seed"),
            Some(&serde_json::json!("true"))
        );
        assert_eq!(
            options.get("bt-seed-unverified"),
            Some(&serde_json::json!("false"))
        );
    }

    #[test]
    fn torrent_integrity_options_are_not_emitted_when_disabled_or_non_torrent() {
        for payload in [
            SpawnPayload::default(),
            SpawnPayload {
                is_torrent: true,
                ..Default::default()
            },
        ] {
            let mut options = serde_json::Map::new();
            apply_aria2_torrent_options(&mut options, &payload).unwrap();
            assert!(!options.contains_key("check-integrity"));
            assert!(!options.contains_key("bt-hash-check-seed"));
            assert!(!options.contains_key("bt-seed-unverified"));
        }
    }

    #[test]
    fn enqueue_item_deserializes_integrity_policy_from_frontend_payload() {
        let item: EnqueueItem = serde_json::from_value(serde_json::json!({
            "id": "torrent-integrity",
            "queue_id": "main",
            "url": "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
            "destination": "/tmp/downloads",
            "filename": "payload",
            "is_media": false,
            "is_torrent": true,
            "torrent_check_integrity": true
        }))
        .expect("frontend enqueue payload should deserialize");

        assert!(item.into_task().payload.torrent_check_integrity);
    }

    #[test]
    fn enqueue_item_preserves_torrent_encryption_policy() {
        let item: EnqueueItem = serde_json::from_value(serde_json::json!({
            "id": "torrent-encryption",
            "queue_id": "main",
            "url": "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
            "destination": "/tmp/downloads",
            "filename": "payload",
            "is_media": false,
            "is_torrent": true,
            "torrent_encryption_policy": "force-encryption"
        }))
        .expect("frontend enqueue payload should deserialize");

        assert_eq!(
            item.into_task().payload.torrent_encryption_policy.as_deref(),
            Some("force-encryption")
        );
    }

    #[test]
    fn enqueue_item_preserves_torrent_tracker_timing() {
        let item: EnqueueItem = serde_json::from_value(serde_json::json!({
            "id": "torrent-tracker-timing",
            "queue_id": "main",
            "url": "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
            "destination": "/tmp/downloads",
            "filename": "payload",
            "is_media": false,
            "is_torrent": true,
            "torrent_tracker_connect_timeout": 11,
            "torrent_tracker_timeout": 22,
            "torrent_tracker_interval": 33
        }))
        .expect("frontend enqueue payload should deserialize");

        let payload = item.into_task().payload;
        assert_eq!(payload.torrent_tracker_connect_timeout, Some(11));
        assert_eq!(payload.torrent_tracker_timeout, Some(22));
        assert_eq!(payload.torrent_tracker_interval, Some(33));
    }

    #[test]
    fn torrent_network_settings_are_normalized_and_bounded() {
        assert_eq!(
            normalize_torrent_port_spec(Some(" 6881-6999, 7000 "), "TCP listen ports").unwrap(),
            Some("6881-6999,7000".to_string())
        );
        assert_eq!(
            normalize_torrent_external_ip(Some(" 2001:db8::1 ")).unwrap(),
            Some("2001:db8::1".to_string())
        );
        assert_eq!(
            normalize_torrent_dht_entry_point(Some("Bootstrap.Example:6881"), false).unwrap(),
            Some("bootstrap.example:6881".to_string())
        );
        assert_eq!(
            normalize_torrent_dht_entry_point(Some("[2001:db8::1]:6881"), true).unwrap(),
            Some("[2001:db8::1]:6881".to_string())
        );
        assert_eq!(
            normalize_torrent_dht_listen_addr6(Some("2001:db8::2")).unwrap(),
            Some("2001:db8::2".to_string())
        );
        assert_eq!(
            normalize_torrent_lpd_interface(Some("en0")).unwrap(),
            Some("en0".to_string())
        );
        assert_eq!(
            normalize_torrent_peer_id_prefix(Some("-FL-1-3-1-")).unwrap(),
            Some("-FL-1-3-1-".to_string())
        );
        assert_eq!(
            normalize_torrent_peer_agent(Some("Firelink/1.3.1")).unwrap(),
            Some("Firelink/1.3.1".to_string())
        );
        assert!(torrent_port_spec_contains("6800-6802,6881", 6801));
        assert!(!torrent_port_spec_contains("6800-6802,6881", 6803));
        assert_eq!(normalize_torrent_port_spec(Some(" "), "TCP listen ports").unwrap(), None);
        assert_eq!(
            normalize_torrent_port_spec(Some("1024"), "TCP listen ports").unwrap(),
            Some("1024".to_string())
        );
    }

    #[test]
    fn torrent_network_settings_reject_unsafe_or_malformed_values() {
        for value in ["0", "1023", "65536", "7000-6999", "6881,", "6881-"] {
            assert!(
                normalize_torrent_port_spec(Some(value), "TCP listen ports").is_err(),
                "{value}"
            );
        }
        assert!(normalize_torrent_external_ip(Some("example.com")).is_err());
        assert!(normalize_torrent_dht_entry_point(Some("example.com"), false).is_err());
        assert!(normalize_torrent_dht_entry_point(Some("[2001:db8::1]:6881"), false).is_err());
        assert!(normalize_torrent_dht_entry_point(Some("2001:db8::1:6881"), true).is_err());
        assert!(normalize_torrent_dht_listen_addr6(Some("127.0.0.1")).is_err());
        assert!(normalize_torrent_lpd_interface(Some("en0\n--bad")).is_err());
        assert!(normalize_torrent_peer_id_prefix(Some("é")).is_err());
        assert!(normalize_torrent_peer_id_prefix(Some("123456789012345678901")).is_err());
        assert!(normalize_torrent_peer_agent(Some("agent\nname")).is_err());
        assert!(normalize_torrent_peer_agent(Some(&"a".repeat(MAX_TORRENT_PEER_AGENT_LENGTH + 1))).is_err());
        assert!(
            normalize_torrent_port_spec(
                Some(&"1".repeat(MAX_TORRENT_NETWORK_VALUE_LENGTH + 1)),
                "TCP listen ports"
            )
            .is_err()
        );
    }

    #[test]
    fn torrent_trackers_are_normalized_and_deduplicated() {
        assert_eq!(
            normalize_torrent_trackers(Some(
                " https://tracker.example/announce\nudp://tracker.example:6969/announce\nhttps://tracker.example/announce "
            ))
            .unwrap(),
            Some("https://tracker.example/announce,udp://tracker.example:6969/announce".to_string())
        );
        assert_eq!(normalize_torrent_trackers(Some("  \n\n  ")).unwrap(), None);
    }

    #[test]
    fn torrent_trackers_reject_unsafe_or_unbounded_values() {
        for value in [
            "ftp://tracker.example/announce",
            "https://user:pass@tracker.example/announce",
            "https://tracker.example/announce#fragment",
            "https://tracker.example/announce,",
            "https://",
        ] {
            assert!(normalize_torrent_trackers(Some(value)).is_err(), "{value}");
        }
        let too_many = (0..=MAX_TORRENT_TRACKERS)
            .map(|index| format!("https://tracker{index}.example/announce"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(normalize_torrent_trackers(Some(&too_many)).is_err());
    }

    #[test]
    fn torrent_exclude_trackers_support_wildcard_and_normalized_uris() {
        assert_eq!(normalize_torrent_exclude_trackers(Some("*")).unwrap(), Some("*".to_string()));
        assert_eq!(
            normalize_torrent_exclude_trackers(Some(
                " https://tracker.example/announce\nudp://tracker.example:6969/announce "
            ))
            .unwrap(),
            Some("https://tracker.example/announce,udp://tracker.example:6969/announce".to_string())
        );
        assert_eq!(normalize_torrent_exclude_trackers(Some("  \n\n  ")).unwrap(), None);
    }

    #[test]
    fn torrent_exclude_trackers_reject_unsafe_or_ambiguous_values() {
        for value in [
            "ftp://tracker.example/announce",
            "https://user:pass@tracker.example/announce",
            "https://tracker.example/announce#fragment",
            "https://tracker.example/announce,*",
            "*,https://tracker.example/announce",
            "https://tracker.example/announce,",
        ] {
            assert!(normalize_torrent_exclude_trackers(Some(value)).is_err(), "{value}");
        }
    }

    #[test]
    fn torrent_tracker_timing_is_bounded_and_preserves_aria2_defaults() {
        assert_eq!(normalize_torrent_tracker_connect_timeout(None).unwrap(), None);
        assert_eq!(
            normalize_torrent_tracker_connect_timeout(Some(1)).unwrap(),
            Some(1)
        );
        assert_eq!(
            normalize_torrent_tracker_request_timeout(Some(MAX_TORRENT_TRACKER_TIMEOUT)).unwrap(),
            Some(MAX_TORRENT_TRACKER_TIMEOUT)
        );
        assert_eq!(normalize_torrent_tracker_interval(Some(0)).unwrap(), Some(0));
        assert!(normalize_torrent_tracker_connect_timeout(Some(0)).is_err());
        assert!(normalize_torrent_tracker_request_timeout(Some(0)).is_err());
        assert!(normalize_torrent_tracker_interval(Some(MAX_TORRENT_TRACKER_INTERVAL + 1)).is_err());

        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_tracker_connect_timeout: Some(11),
            torrent_tracker_timeout: Some(22),
            torrent_tracker_interval: Some(33),
            ..Default::default()
        };
        apply_aria2_torrent_options(&mut options, &payload).unwrap();
        assert_eq!(
            options.get("bt-tracker-connect-timeout"),
            Some(&serde_json::json!("11"))
        );
        assert_eq!(
            options.get("bt-tracker-timeout"),
            Some(&serde_json::json!("22"))
        );
        assert_eq!(
            options.get("bt-tracker-interval"),
            Some(&serde_json::json!("33"))
        );
    }

    #[test]
    fn torrent_tracker_timing_is_not_applied_to_non_torrent_payloads() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            torrent_tracker_connect_timeout: Some(11),
            torrent_tracker_timeout: Some(22),
            torrent_tracker_interval: Some(33),
            ..Default::default()
        };

        apply_aria2_torrent_options(&mut options, &payload).unwrap();

        assert!(!options.contains_key("bt-tracker-connect-timeout"));
        assert!(!options.contains_key("bt-tracker-timeout"));
        assert!(!options.contains_key("bt-tracker-interval"));
    }

    #[test]
    fn torrent_max_open_files_is_bounded() {
        assert_eq!(normalize_torrent_max_open_files(1).unwrap(), 1);
        assert_eq!(
            normalize_torrent_max_open_files(MAX_TORRENT_MAX_OPEN_FILES).unwrap(),
            MAX_TORRENT_MAX_OPEN_FILES
        );
        assert!(normalize_torrent_max_open_files(0).is_err());
        assert!(normalize_torrent_max_open_files(MAX_TORRENT_MAX_OPEN_FILES + 1).is_err());
    }

    #[test]
    fn torrent_trackers_are_emitted_as_the_aria2_tracker_option() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_trackers: Some("https://tracker.example/announce".to_string()),
            ..Default::default()
        };

        apply_aria2_torrent_options(&mut options, &payload).unwrap();

        assert_eq!(
            options.get("bt-tracker"),
            Some(&serde_json::json!("https://tracker.example/announce"))
        );
    }

    #[test]
    fn torrent_exclude_trackers_are_emitted_as_the_aria2_option() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_exclude_trackers: Some("*".to_string()),
            ..Default::default()
        };

        apply_aria2_torrent_options(&mut options, &payload).unwrap();

        assert_eq!(
            options.get("bt-exclude-tracker"),
            Some(&serde_json::json!("*"))
        );
    }

    #[test]
    fn torrent_stop_timeout_is_normalized_and_emitted() {
        assert_eq!(normalize_torrent_stop_timeout(None).unwrap(), None);
        assert_eq!(normalize_torrent_stop_timeout(Some(0)).unwrap(), Some(0));
        assert_eq!(
            normalize_torrent_stop_timeout(Some(MAX_TORRENT_STOP_TIMEOUT)).unwrap(),
            Some(MAX_TORRENT_STOP_TIMEOUT)
        );
        assert!(normalize_torrent_stop_timeout(Some(MAX_TORRENT_STOP_TIMEOUT + 1)).is_err());

        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_stop_timeout: Some(300),
            ..Default::default()
        };
        apply_aria2_torrent_options(&mut options, &payload).unwrap();
        assert_eq!(
            options.get("bt-stop-timeout"),
            Some(&serde_json::json!("300"))
        );

        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_stop_timeout: Some(0),
            ..Default::default()
        };
        apply_aria2_torrent_options(&mut options, &payload).unwrap();
        assert_eq!(
            options.get("bt-stop-timeout"),
            Some(&serde_json::json!("0"))
        );
    }

    #[test]
    fn torrent_stop_timeout_is_not_applied_to_non_torrent_payloads() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            torrent_stop_timeout: Some(300),
            ..Default::default()
        };

        apply_aria2_torrent_options(&mut options, &payload).unwrap();

        assert!(!options.contains_key("bt-stop-timeout"));
    }

    #[test]
    fn torrent_piece_priority_is_normalized_and_bounded() {
        assert_eq!(
            normalize_torrent_prioritize_piece(Some(" tail = 64k, HEAD ")).unwrap(),
            Some("head,tail=64K".to_string())
        );
        assert_eq!(
            normalize_torrent_prioritize_piece(Some("head=1m,tail=1024M")).unwrap(),
            Some("head=1M,tail=1024M".to_string())
        );
        assert_eq!(normalize_torrent_prioritize_piece(Some(" ")).unwrap(), None);

        for value in [
            "head,head",
            "tail,tail",
            "middle",
            "head=0K",
            "tail=1G",
            "head=1🙂",
            "head=1K,",
        ] {
            assert!(
                normalize_torrent_prioritize_piece(Some(value)).is_err(),
                "{value}"
            );
        }
        assert!(normalize_torrent_prioritize_piece(Some("head=1025M")).is_err());
    }

    #[test]
    fn torrent_piece_priority_is_emitted_as_the_aria2_option() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_prioritize_piece: Some("tail=2m,head".to_string()),
            ..Default::default()
        };

        apply_aria2_torrent_options(&mut options, &payload).unwrap();

        assert_eq!(
            options.get("bt-prioritize-piece"),
            Some(&serde_json::json!("head,tail=2M"))
        );
    }

    #[test]
    fn torrent_piece_priority_is_not_applied_to_non_torrent_payloads() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            torrent_prioritize_piece: Some("head".to_string()),
            ..Default::default()
        };

        apply_aria2_torrent_options(&mut options, &payload).unwrap();

        assert!(!options.contains_key("bt-prioritize-piece"));
    }

    #[test]
    fn torrent_unselected_file_removal_requires_a_non_empty_file_selection() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_remove_unselected_file: true,
            torrent_file_indices: Some(vec![]),
            ..Default::default()
        };

        let error = apply_aria2_torrent_options(&mut options, &payload).unwrap_err();
        assert!(error.contains("file selection"));
        assert!(!options.contains_key("bt-remove-unselected-file"));
    }

    #[test]
    fn torrent_unselected_file_removal_is_emitted_only_for_selected_torrent_files() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_remove_unselected_file: true,
            torrent_file_indices: Some(vec![1]),
            ..Default::default()
        };

        apply_aria2_torrent_options(&mut options, &payload).unwrap();

        assert_eq!(
            options.get("bt-remove-unselected-file"),
            Some(&serde_json::json!("true"))
        );
    }

    #[test]
    fn torrent_unselected_file_removal_is_not_applied_without_torrent_selection() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_remove_unselected_file: true,
            ..Default::default()
        };

        let error = apply_aria2_torrent_options(&mut options, &payload).unwrap_err();
        assert!(error.contains("subset"));
    }

    #[test]
    fn torrent_peer_diagnostics_are_redacted_and_bounded() {
        let mut result = vec![serde_json::json!({
            "peerId": "secret-peer-id",
            "ip": "192.0.2.10",
            "port": "6881",
            "bitfield": "ffffffff",
            "downloadSpeed": "10602",
            "uploadSpeed": "6890",
            "seeder": "true",
            "amChoking": "false",
            "peerChoking": "true"
        })];
        result.extend((1..MAX_TORRENT_PEER_DIAGNOSTICS + 2).map(|index| {
            serde_json::json!({
                "peerId": format!("peer-{index}"),
                "ip": format!("192.0.2.{index}"),
                "downloadSpeed": index.to_string(),
                "uploadSpeed": 0,
                "seeder": index == MAX_TORRENT_PEER_DIAGNOSTICS + 1,
                "amChoking": false,
                "peerChoking": false
            })
        }));

        let diagnostics = parse_torrent_peer_diagnostics(serde_json::Value::Array(result)).unwrap();
        assert_eq!(diagnostics.total_peers, (MAX_TORRENT_PEER_DIAGNOSTICS + 2) as u32);
        assert_eq!(diagnostics.total_seeders, 2);
        assert_eq!(diagnostics.peers.len(), MAX_TORRENT_PEER_DIAGNOSTICS);
        assert!(diagnostics.truncated);
        let serialized = serde_json::to_string(&diagnostics).unwrap();
        assert!(!serialized.contains("peerId"));
        assert!(!serialized.contains("192.0.2."));
        assert!(!serialized.contains("bitfield"));
    }

    #[test]
    fn torrent_peer_diagnostics_reject_non_array_results() {
        let error = parse_torrent_peer_diagnostics(serde_json::json!({"peers": []})).unwrap_err();
        assert!(error.contains("non-array"));
    }

    #[test]
    fn torrent_peer_diagnostics_reject_malformed_peer_entries() {
        let error = parse_torrent_peer_diagnostics(serde_json::json!([{
            "seeder": true
        }, "not-a-peer"]))
        .unwrap_err();
        assert!(error.contains("malformed"));
    }

    #[test]
    fn enqueue_item_carries_torrent_trackers_into_the_spawn_payload() {
        let item: EnqueueItem = serde_json::from_value(serde_json::json!({
            "id": "torrent-trackers",
            "queue_id": "main",
            "url": "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
            "destination": "/tmp/downloads",
            "filename": "payload",
            "is_media": false,
            "is_torrent": true,
            "torrent_trackers": "https://tracker.example/announce",
            "torrent_exclude_trackers": "*"
        }))
        .expect("frontend enqueue payload should deserialize");

        let payload = item.into_task().payload;
        assert_eq!(
            payload.torrent_trackers.as_deref(),
            Some("https://tracker.example/announce")
        );
        assert_eq!(payload.torrent_exclude_trackers.as_deref(), Some("*"));
    }

    #[test]
    fn enqueue_item_carries_torrent_stop_timeout_into_the_spawn_payload() {
        let item: EnqueueItem = serde_json::from_value(serde_json::json!({
            "id": "torrent-stop-timeout",
            "queue_id": "main",
            "url": "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
            "destination": "/tmp/downloads",
            "filename": "payload",
            "is_media": false,
            "is_torrent": true,
            "torrent_stop_timeout": 300
        }))
        .expect("frontend enqueue payload should deserialize");

        assert_eq!(
            item.into_task().payload.torrent_stop_timeout,
            Some(300)
        );
    }

    #[test]
    fn enqueue_item_carries_torrent_piece_priority_into_the_spawn_payload() {
        let item: EnqueueItem = serde_json::from_value(serde_json::json!({
            "id": "torrent-piece-priority",
            "queue_id": "main",
            "url": "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
            "destination": "/tmp/downloads",
            "filename": "payload",
            "is_media": false,
            "is_torrent": true,
            "torrent_prioritize_piece": "head=2M,tail=1M"
        }))
        .expect("frontend enqueue payload should deserialize");

        assert_eq!(
            item.into_task().payload.torrent_prioritize_piece.as_deref(),
            Some("head=2M,tail=1M")
        );
    }

    #[test]
    fn enqueue_item_carries_torrent_unselected_file_removal_into_the_spawn_payload() {
        let item: EnqueueItem = serde_json::from_value(serde_json::json!({
            "id": "torrent-remove-unselected",
            "queue_id": "main",
            "url": "file:///tmp/payload.torrent",
            "destination": "/tmp/downloads",
            "filename": "payload",
            "is_media": false,
            "is_torrent": true,
            "torrent_file_indices": [1],
            "torrent_remove_unselected_file": true
        }))
        .expect("frontend enqueue payload should deserialize");

        assert!(item.into_task().payload.torrent_remove_unselected_file);
    }

    #[test]
    fn torrent_options_reject_invalid_seed_values() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_seed_time: Some(f64::NAN),
            ..Default::default()
        };

        let error = apply_aria2_torrent_options(&mut options, &payload).unwrap_err();
        assert!(error.contains("seed time"));
    }

    #[test]
    fn torrent_options_reject_invalid_peer_values() {
        assert!(normalize_torrent_max_peers(Some(-1)).is_err());

        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_max_peers: Some(MAX_TORRENT_MAX_PEERS + 1),
            ..Default::default()
        };
        let error = apply_aria2_torrent_options(&mut options, &payload).unwrap_err();
        assert!(error.contains("maximum peers"));

        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_peer_speed_limit: Some("0".to_string()),
            ..Default::default()
        };
        let error = apply_aria2_torrent_options(&mut options, &payload).unwrap_err();
        assert!(error.contains("peer speed limit"));
    }

    #[tokio::test]
    async fn seeding_outcome_keeps_torrent_ownership_and_permit_live() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let manager = QueueManager::test_new(
            app.handle().clone(),
            1,
            Arc::new(TestSpawner),
        );
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_seed_time: Some(30.0),
            ..Default::default()
        };

        assert!(manager.ensure_aria2_permit("torrent").await);
        manager
            .aria2_payloads
            .lock()
            .await
            .insert("torrent".to_string(), payload);
        manager
            .remember_gid("torrent".to_string(), "test-gid".to_string())
            .await;
        manager
            .apply_completion("torrent", PendingOutcome::Seeding)
            .await;

        assert_eq!(manager.aria2_gid_for_download("torrent").as_deref(), Some("test-gid"));
        assert_eq!(manager.available_permits(), 0);
    }

    #[tokio::test]
    async fn unexpected_seeding_outcome_without_policy_is_reconciled_as_complete() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let manager = QueueManager::test_new(
            app.handle().clone(),
            1,
            Arc::new(TestSpawner),
        );

        assert!(manager.ensure_aria2_permit("torrent").await);
        manager
            .aria2_payloads
            .lock()
            .await
            .insert(
                "torrent".to_string(),
                SpawnPayload {
                    is_torrent: true,
                    ..Default::default()
                },
            );
        manager
            .apply_completion("torrent", PendingOutcome::Seeding)
            .await;

        assert_eq!(manager.aria2_gid_for_download("torrent"), None);
        assert_eq!(manager.available_permits(), 1);
    }

    #[test]
    fn aria2_connection_options_never_emit_zero_connections() {
        let mut options = serde_json::Map::new();

        apply_aria2_connection_options(&mut options, 0);

        assert_eq!(options.get("split"), Some(&serde_json::json!("1")));
        assert_eq!(
            options.get("max-connection-per-server"),
            Some(&serde_json::json!("1"))
        );
    }

    #[test]
    fn aria2_recovery_rebuilds_when_force_pause_races_with_removal() {
        assert!(aria2_recovery_should_rebuild_after_pause_error("removed"));
        assert!(!aria2_recovery_should_rebuild_after_pause_error("paused"));
        assert!(!aria2_recovery_should_rebuild_after_pause_error("active"));
    }

    #[test]
    fn aria2_connection_options_clamp_untrusted_connection_counts() {
        let mut options = serde_json::Map::new();

        apply_aria2_connection_options(&mut options, i32::MAX);

        assert_eq!(options.get("split"), Some(&serde_json::json!("16")));
        assert_eq!(
            options.get("max-connection-per-server"),
            Some(&serde_json::json!("16"))
        );
    }

    #[test]
    fn bounded_range_probe_accepts_exact_requested_byte() {
        assert_eq!(
            classify_bounded_range_response(
                reqwest::StatusCode::PARTIAL_CONTENT,
                Some("bytes 0-0/383882118"),
            ),
            BoundedRangeSupport::Supported
        );
    }

    #[test]
    fn bounded_range_probe_accepts_case_insensitive_content_range_unit() {
        assert_eq!(
            classify_bounded_range_response(
                reqwest::StatusCode::PARTIAL_CONTENT,
                Some("Bytes 0-0/383882118"),
            ),
            BoundedRangeSupport::Supported
        );
    }

    #[test]
    fn aria2_proxy_value_rejects_socks_proxies() {
        assert_eq!(aria2_all_proxy_value("none").unwrap().as_deref(), Some(""));
        assert_eq!(
            aria2_all_proxy_value("http://127.0.0.1:8080")
                .unwrap()
                .as_deref(),
            Some("http://127.0.0.1:8080")
        );
        assert!(aria2_all_proxy_value("socks5://127.0.0.1:1080")
            .unwrap_err()
            .contains("SOCKS system proxies are not supported"));
    }

    #[test]
    fn bounded_range_probe_rejects_server_that_expands_to_end() {
        assert_eq!(
            classify_bounded_range_response(
                reqwest::StatusCode::PARTIAL_CONTENT,
                Some("bytes 0-383882117/383882118"),
            ),
            BoundedRangeSupport::Unsupported
        );
    }

    #[test]
    fn bounded_range_probe_rejects_ignored_range_request() {
        assert_eq!(
            classify_bounded_range_response(reqwest::StatusCode::OK, None),
            BoundedRangeSupport::Unsupported
        );
    }

    #[test]
    fn aria2_range_code_is_retryable_without_global_no_uri_retry() {
        assert!(is_retryable_aria2_error(
            "aria2 error code 8: No URI available."
        ));
        assert!(!is_retryable_aria2_error("No URI available."));
    }

    #[test]
    fn aria2_stall_timeout_outcome_is_not_automatically_retried() {
        assert!(!is_retryable_aria2_error("aria2 error code 7: unfinished download"));
    }

    #[test]
    fn aria2_startup_rpc_errors_are_retryable() {
        assert!(is_aria2_rpc_unavailable(
            "error trying to connect: tcp connect error: Connection refused"
        ));
        assert!(is_aria2_rpc_unavailable(
            "aria2 did not become ready: connection refused"
        ));
        assert!(!is_aria2_rpc_unavailable(
            "aria2 error code 3: Resource not found"
        ));
    }

    #[test]
    fn aria2_internal_attempts_do_not_multiply_firelink_retry_budget() {
        assert_eq!(aria2_attempt_limit(Some(0)), 1);
        assert_eq!(aria2_attempt_limit(Some(10)), 1);
    }

    #[test]
    fn omitted_retry_limit_uses_the_shared_default_but_zero_stays_explicit() {
        assert_eq!(automatic_retry_limit(None), MAX_RETRIES);
        assert_eq!(automatic_retry_limit(Some(0)), 0);
        assert_eq!(automatic_retry_limit(Some(2)), 2);
    }
}

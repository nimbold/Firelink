use crate::ipc::{DownloadStateEvent, DownloadStatus, QueueDirection};
use crate::retry::{backoff_and_emit, is_transient_network_error, BackoffOutcome, MAX_RETRIES};
use log;
use serde::Deserialize;
use serde_json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, Notify, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};
use ts_rs::TS;

/// Default capacity when no setting is read yet.
pub const DEFAULT_MAX_CONCURRENT: usize = 3;
pub const MEDIA_RUN_CANCELLED: &str = "__firelink_media_run_cancelled__";
pub const DOWNLOAD_CONNECTIONS_MIN: i32 = 1;
pub const DOWNLOAD_CONNECTIONS_MAX: i32 = 16;

pub fn clamp_download_connections(connections: i32) -> i32 {
    connections.clamp(DOWNLOAD_CONNECTIONS_MIN, DOWNLOAD_CONNECTIONS_MAX)
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
            target_capacity: AtomicUsize::new(capacity),
            slots_to_retire: AtomicUsize::new(0),
            notify: Notify::new(),
            aria2_gids: Arc::new(std::sync::RwLock::new(HashMap::new())),
            pending_completion: Arc::new(Mutex::new(HashMap::new())),
            aria2_payloads: Mutex::new(HashMap::new()),
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
            spawner,
            app_handle,
        }
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

    pub async fn next_aria2_control_epoch(&self, id: &str) -> u64 {
        let mut epochs = self.aria2_control_epochs.lock().await;
        let epoch = epochs.get(id).copied().unwrap_or_default().wrapping_add(1);
        epochs.insert(id.to_string(), epoch);
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

    /// Pop the next task, or None if empty.
    pub async fn pop_front(&self) -> Option<QueuedTask> {
        self.pending.lock().await.pop_front()
    }

    /// Acquire a permit from the semaphore (blocks until one is available).
    pub async fn acquire_permit(&self) -> Option<OwnedSemaphorePermit> {
        self.semaphore.clone().acquire_owned().await.ok()
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

    /// Park an already-acquired permit under `id`.
    pub async fn park_permit(&self, id: &str, permit: OwnedSemaphorePermit) {
        self.active_permits
            .lock()
            .await
            .insert(id.to_string(), permit);
    }

    /// Park a candidate only when no newer lifecycle has already claimed the
    /// download. Dropping a duplicate candidate returns its slot safely.
    pub async fn park_aria2_permit_if_missing(
        &self,
        id: &str,
        permit: OwnedSemaphorePermit,
    ) -> bool {
        let mut permits = self.active_permits.lock().await;
        if permits.contains_key(id) {
            return false;
        }
        permits.insert(id.to_string(), permit);
        drop(permits);
        self.active_kinds
            .lock()
            .await
            .insert(id.to_string(), TaskKind::Aria2);
        true
    }

    async fn tag_permit_generation(&self, id: &str, generation: u64) {
        self.active_permit_generations
            .lock()
            .await
            .insert(id.to_string(), generation);
    }

    pub async fn active_kind(&self, id: &str) -> Option<TaskKind> {
        self.active_kinds.lock().await.get(id).cloned()
    }

    /// Ensure an aria2 transfer owns exactly one queue permit. Returns true
    /// when this call acquired and parked the permit, false when one was
    /// already parked.
    pub async fn ensure_aria2_permit(&self, id: &str) -> bool {
        if self.active_permits.lock().await.contains_key(id) {
            return false;
        }

        let permit = match self.acquire_permit_after_retirement().await {
            Some(p) => p,
            None => return false,
        };
        let mut permits = self.active_permits.lock().await;
        if permits.contains_key(id) {
            drop(permits);
            drop(permit);
            return false;
        }
        permits.insert(id.to_string(), permit);
        drop(permits);
        self.active_kinds
            .lock()
            .await
            .insert(id.to_string(), TaskKind::Aria2);
        true
    }

    pub async fn release_permit(&self, id: &str) {
        let removed = self.active_permits.lock().await.remove(id).is_some();
        self.active_permit_generations.lock().await.remove(id);
        self.active_kinds.lock().await.remove(id);
        if removed {
            self.notify.notify_one();
        }
    }

    async fn release_permit_for_generation(&self, id: &str, generation: u64) {
        let removed = {
            let mut permits = self.active_permits.lock().await;
            let mut generations = self.active_permit_generations.lock().await;
            if generations.get(id).copied() == Some(generation) {
                generations.remove(id);
                permits.remove(id).is_some()
            } else {
                false
            }
        };
        if removed {
            self.active_kinds.lock().await.remove(id);
            self.notify.notify_one();
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
            self.notify.notify_one();
        } else {
            let delta = prev_target - new_target;
            self.slots_to_retire.fetch_add(delta, Ordering::Relaxed);
        }
    }

    /// Test accessor for the retirement debt counter.
    pub fn slots_to_retire_load(&self) -> usize {
        self.slots_to_retire.load(Ordering::Relaxed)
    }

    /// The long-running dispatcher. One instance is spawned in setup().
    /// Idle-parks on Notify; CAS-honors retirement debt; re-pops under lock.
    pub async fn run_dispatcher(self: Arc<Self>) {
        loop {
            // (1) Idle-park: avoid busy-spin when pending is empty.
            if self.pending.lock().await.is_empty() {
                self.notify.notified().await;
                continue;
            }
            // (2) Acquire a slot.
            let permit = match self.acquire_permit_after_retirement().await {
                Some(p) => p,
                None => break, // Semaphore closed, exit dispatcher
            };
            // (4) Re-pop under lock — guards against racing removals between
            //     waking from Notify and acquiring the permit.
            let task = match self.pending.lock().await.pop_front() {
                Some(t) => t,
                None => {
                    drop(permit);
                    continue;
                }
            };
            Arc::clone(&self).dispatch_one(permit, task).await;
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
            drop(control_guard);
            drop(permit);
            return;
        }

        // Park the permit BEFORE spawning. Uniform parking:
        // aria2's RPC returns instantly, so the permit must outlive the
        // dispatch_one call. Media runners release on exit.
        self.park_permit(&id, permit).await;
        self.tag_permit_generation(&id, lifecycle_generation).await;
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
        self.emit_state(&id, DownloadStatus::Downloading);
        drop(control_guard);

        match task.kind {
            TaskKind::Aria2 => {
                let lifecycle_epoch = aria2_lifecycle_epoch
                    .expect("aria2 dispatch must initialize a control epoch");
                match self.spawner.add_uri(&id, &task.payload).await {
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
                            if let Err(error) = self.spawner.remove_uri(&gid).await {
                                log::warn!(
                                    "aria2 dispatch cancellation [{}]: failed to remove late gid {}: {}",
                                    id,
                                    gid,
                                    error
                                );
                            }
                            self.ignore_aria2_gid(&gid).await;
                            if current_lifecycle {
                                self.clear_aria2_retry_state(&id).await;
                                self.release_permit(&id).await;
                            }
                            return;
                        }
                        let buffered_outcome = self.remember_gid(id.clone(), gid.clone()).await;
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
        // A terminal event invalidates every delayed retry or control worker
        // from the previous lifecycle before releasing its permit.
        self.next_aria2_control_epoch(id).await;
        self.cancel_aria2_retries(id).await;
        match outcome {
            PendingOutcome::Complete => {
                self.clear_aria2_retry_state(id).await;
                self.forget_aria2_gid(id).await;
                self.release_registered_id(id).await;
                self.release_permit(id).await;
                self.emit_state(id, DownloadStatus::Completed);
            }
            PendingOutcome::Error(error) => {
                if error.to_ascii_lowercase().contains("checksum") {
                    log::warn!("Checksum error detected for {}, cleaning up assets", id);
                    if let Ok(primary_path) =
                        crate::download_ownership::primary_path_for_id(&self.app_handle, id)
                    {
                        if let Some(path) = primary_path.as_deref() {
                            let _ = crate::remove_download_assets(path, &self.app_handle).await;
                        }
                    }
                }

                log::error!("aria2 download {} failed: {}", id, error);

                self.clear_aria2_retry_state(id).await;
                self.forget_aria2_gid(id).await;
                self.release_registered_id(id).await;
                self.release_permit(id).await;
                self.emit_failed(id, error);
            }
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
        &self,
        id: &str,
        gid: &str,
        observed_epoch: u64,
    ) -> Result<(), String> {
        let _control_guard = self.acquire_aria2_control(id).await;
        if self.aria2_gid_for_download(id).as_deref() != Some(gid)
            || !self.is_registered(id).await
            || self.is_aria2_retry_cancelled(id).await
            || !self.is_aria2_control_epoch_current(id, observed_epoch).await
        {
            return Ok(());
        }

        let outcome = self.spawner.refresh_uri(gid).await?;

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

            if !this.active_permits.lock().await.contains_key(&id_for_task)
                || this.is_aria2_retry_cancelled(&id_for_task).await
                || !this
                    .is_aria2_control_epoch_current(&id_for_task, retry_epoch)
                    .await
                || !this.is_registered(&id_for_task).await
                || this.aria2_gid_for_download(&id_for_task).as_deref() != Some(retry_gid.as_str())
            {
                this.finish_aria2_retry(&id_for_task, &retry_gid, retry_epoch)
                    .await;
                return;
            }

            match this.spawner.add_uri(&id_for_task, &payload).await {
                Ok(new_gid) => {
                    let control_guard = this.acquire_aria2_control(&id_for_task).await;
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
                    let control_guard = this.acquire_aria2_control(&id_for_task).await;
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
            let mut reordered = Vec::with_capacity(queue_tasks.len());
            reordered.extend_from_slice(&unselected_tasks[..insert_index]);
            reordered.extend(selected_tasks);
            reordered.extend_from_slice(&unselected_tasks[insert_index..]);

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
}

fn automatic_retry_limit(max_tries: Option<i32>) -> usize {
    max_tries.unwrap_or(MAX_RETRIES as i32).max(0) as usize
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

fn aria2_all_proxy_value(proxy: &str) -> Result<Option<String>, String> {
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
}

impl ProductionSpawner {
    pub fn new(app_handle: AppHandle<tauri::Wry>) -> Self {
        Self { app_handle }
    }

    async fn add_uri_rpc(
        &self,
        state: &crate::AppState,
        params: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            match crate::rpc_call(
                state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
                &state.aria2_secret,
                "aria2.addUri",
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
        options.insert("out".to_string(), serde_json::json!(safe_filename));
        let conn = effective_aria2_connections(id, payload).await;
        apply_aria2_connection_options(&mut options, conn);
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
        let uris = crate::collect_download_uris(&payload.url, payload.mirrors.as_deref());
        let params = serde_json::json!([uris, options]);

        match self.add_uri_rpc(&state, &params).await {
            Ok(result) => {
                let gid = result.as_str().unwrap_or("").to_string();
                if gid.is_empty() {
                    Err("aria2.addUri returned an empty gid".to_string())
                } else {
                    log::info!("aria2 addUri [{}]: created gid {}", id, gid);
                    Ok(gid)
                }
            }
            Err(e) => {
                let safe_error = crate::redact_sensitive_text(&e);
                log::error!("aria2 addUri [{}] failed: {}", id, safe_error);
                Err(format!("aria2 addUri failed: {safe_error}"))
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
            Some(returned_gid) if returned_gid == gid => Ok(()),
            Some(returned_gid) => Err(format!(
                "aria2.forceRemove returned unexpected gid {returned_gid}, expected {gid}"
            )),
            None => Err("aria2.forceRemove returned a non-string result".to_string()),
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
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

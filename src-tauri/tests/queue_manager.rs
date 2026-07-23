use firelink_lib::queue::{
    Aria2RefreshOutcome, QueueManager, QueuedTask, SidecarSpawner, SpawnPayload, TaskKind,
    MEDIA_RUN_CANCELLED,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::Listener;
use tokio::time::timeout;

/// A fake spawner that records calls and lets tests gate sidecar lifetime.
struct CountingSpawner {
    add_uri_calls: AtomicUsize,
    media_calls: AtomicUsize,
    speed_limit_calls: AtomicUsize,
    last_speed_limit: std::sync::Mutex<Option<String>>,
    add_speed_limits: std::sync::Mutex<Vec<Option<String>>>,
    block_speed_limit: std::sync::atomic::AtomicBool,
    speed_limit_started: tokio::sync::Notify,
    speed_limit_release: tokio::sync::Notify,
}

struct DelayedAria2Spawner {
    gid_tx: tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    add_uri_calls: AtomicUsize,
    remove_uri_calls: AtomicUsize,
}

struct FailFirstAria2Spawner {
    add_uri_calls: AtomicUsize,
    fail_first: std::sync::atomic::AtomicBool,
}

struct RefreshOutcomeSpawner {
    outcome: Aria2RefreshOutcome,
    refresh_calls: AtomicUsize,
}

impl FailFirstAria2Spawner {
    fn new() -> Self {
        Self {
            add_uri_calls: AtomicUsize::new(0),
            fail_first: std::sync::atomic::AtomicBool::new(true),
        }
    }
}

impl DelayedAria2Spawner {
    fn new(gid_tx: tokio::sync::oneshot::Sender<()>) -> Self {
        Self {
            gid_tx: tokio::sync::Mutex::new(Some(gid_tx)),
            add_uri_calls: AtomicUsize::new(0),
            remove_uri_calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait::async_trait]
impl SidecarSpawner for DelayedAria2Spawner {
    async fn add_uri(&self, _id: &str, _payload: &SpawnPayload) -> Result<String, String> {
        let call = self.add_uri_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(tx) = self.gid_tx.lock().await.take() {
            let _ = tx.send(());
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok("late-gid".to_string())
        } else {
            Ok(format!("gid-{call}"))
        }
    }

    async fn remove_uri(&self, gid: &str) -> Result<(), String> {
        assert_eq!(gid, "late-gid");
        self.remove_uri_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn run_media(&self, _id: &str, _payload: &SpawnPayload, _generation: u64) -> Result<(), String> {
        unreachable!("media is not used by delayed aria2 tests")
    }
}

#[async_trait::async_trait]
impl SidecarSpawner for FailFirstAria2Spawner {
    async fn add_uri(&self, _id: &str, _payload: &SpawnPayload) -> Result<String, String> {
        let call = self.add_uri_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if self
            .fail_first
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            Err("initial aria2 RPC failure".to_string())
        } else {
            Ok(format!("gid-{call}"))
        }
    }

    async fn remove_uri(&self, _gid: &str) -> Result<(), String> {
        Ok(())
    }

    async fn run_media(&self, _id: &str, _payload: &SpawnPayload, _generation: u64) -> Result<(), String> {
        unreachable!("media is not used by fail-first aria2 tests")
    }
}

impl CountingSpawner {
    fn new() -> Self {
        Self {
            add_uri_calls: AtomicUsize::new(0),
            media_calls: AtomicUsize::new(0),
            speed_limit_calls: AtomicUsize::new(0),
            last_speed_limit: std::sync::Mutex::new(None),
            add_speed_limits: std::sync::Mutex::new(Vec::new()),
            block_speed_limit: std::sync::atomic::AtomicBool::new(false),
            speed_limit_started: tokio::sync::Notify::new(),
            speed_limit_release: tokio::sync::Notify::new(),
        }
    }
}

#[async_trait::async_trait]
impl SidecarSpawner for RefreshOutcomeSpawner {
    async fn add_uri(&self, _id: &str, _payload: &SpawnPayload) -> Result<String, String> {
        unreachable!("refresh outcome tests do not spawn aria2")
    }

    async fn remove_uri(&self, _gid: &str) -> Result<(), String> {
        unreachable!("refresh outcome tests do not remove aria2")
    }

    async fn refresh_uri(&self, _gid: &str) -> Result<Aria2RefreshOutcome, String> {
        self.refresh_calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.outcome)
    }

    async fn run_media(
        &self,
        _id: &str,
        _payload: &SpawnPayload,
        _generation: u64,
    ) -> Result<(), String> {
        unreachable!("refresh outcome tests do not run media")
    }
}

#[async_trait::async_trait]
impl firelink_lib::queue::SidecarSpawner for CountingSpawner {
    async fn add_uri(&self, _id: &str, payload: &SpawnPayload) -> Result<String, String> {
        self.add_uri_calls.fetch_add(1, Ordering::SeqCst);
        self.add_speed_limits
            .lock()
            .unwrap()
            .push(payload.speed_limit.clone());
        Ok(format!("gid-{}", self.add_uri_calls.load(Ordering::SeqCst)))
    }
    async fn remove_uri(&self, _gid: &str) -> Result<(), String> {
        Ok(())
    }
    async fn set_download_speed_limit(
        &self,
        _gid: &str,
        limit: Option<&str>,
    ) -> Result<(), String> {
        self.speed_limit_calls.fetch_add(1, Ordering::SeqCst);
        *self.last_speed_limit.lock().unwrap() = limit.map(str::to_string);
        if self
            .block_speed_limit
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            self.speed_limit_started.notify_one();
            self.speed_limit_release.notified().await;
        }
        Ok(())
    }
    async fn run_media(&self, _id: &str, _payload: &SpawnPayload, _generation: u64) -> Result<(), String> {
        self.media_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

/// Build a QueueManager with a fake spawner. Tauri's mock AppHandle is needed
/// for emit; we construct the minimal mock.
fn make_manager(capacity: usize) -> (QueueManager<tauri::test::MockRuntime>, Arc<CountingSpawner>) {
    let app = mock_builder()
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let spawner = Arc::new(CountingSpawner::new());
    let mgr = QueueManager::test_new(app.handle().clone(), capacity, spawner.clone());
    (mgr, spawner)
}

fn sample_task(id: &str) -> QueuedTask {
    QueuedTask {
        id: id.to_string(),
        queue_id: "main".to_string(),
        kind: TaskKind::Aria2,
        lifecycle_generation: 0,
        payload: SpawnPayload::default(),
    }
}

#[tokio::test]
async fn push_appends_to_pending_and_emits_queued() {
    let (mgr, _spawner) = make_manager(2);
    mgr.push(sample_task("a")).await.unwrap();
    mgr.push(sample_task("b")).await.unwrap();
    let order = mgr.pending_order(None).await;
    assert_eq!(order, vec!["a".to_string(), "b".to_string()]);
}

#[tokio::test]
async fn cancelled_enqueue_generation_cannot_register_after_a_newer_user_action() {
    let (mgr, _spawner) = make_manager(2);
    mgr.cancel_enqueue_generation("a", 4).await;

    let stale = mgr.push_with_generation(sample_task("a"), 4).await;
    assert!(
        stale.is_err(),
        "cancelled generation must not enter the queue"
    );
    assert!(!mgr.is_registered("a").await);

    mgr.push_with_generation(sample_task("a"), 5)
        .await
        .expect("newer generation should be accepted");
    assert_eq!(mgr.pending_order(None).await, vec!["a".to_string()]);
}

#[tokio::test]
async fn cancellation_between_reservation_and_commit_cannot_start_the_task() {
    let (mgr, _spawner) = make_manager(2);
    let previous = mgr
        .reserve_enqueue_generation("a", 7)
        .await
        .expect("reservation should succeed");
    mgr.cancel_enqueue_generation("a", 7).await;

    let committed = mgr.commit_reserved_enqueue(sample_task("a"), 7).await;
    assert!(committed.is_err(), "cancelled reservation must not commit");
    mgr.rollback_enqueue_reservation("a", 7, previous).await;

    assert!(!mgr.is_registered("a").await);
    assert!(mgr.pending_order(None).await.is_empty());
    assert!(mgr.push_with_generation(sample_task("a"), 7).await.is_err());
    mgr.push_with_generation(sample_task("a"), 8)
        .await
        .expect("a newer generation should remain startable");
}

#[tokio::test]
async fn accepted_generation_cannot_be_replayed_after_registry_release() {
    let (mgr, _spawner) = make_manager(2);
    mgr.push_with_generation(sample_task("a"), 3)
        .await
        .expect("first enqueue should succeed");
    assert!(mgr.remove_from_pending("a").await);
    mgr.release_registered_id("a").await;

    assert!(mgr.push_with_generation(sample_task("a"), 3).await.is_err());
    mgr.push_with_generation(sample_task("a"), 4)
        .await
        .expect("only a newer lifecycle may reuse the id");
}

#[tokio::test]
async fn release_permit_is_idempotent() {
    let (mgr, _spawner) = make_manager(2);
    let permit = mgr.acquire_permit().await;
    mgr.park_permit("a", permit.unwrap()).await;
    let avail_before = mgr.available_permits();
    mgr.release_permit("a").await; // first release: frees the slot
    let avail_after_first = mgr.available_permits();
    mgr.release_permit("a").await; // second release: no-op
    let avail_after_second = mgr.available_permits();
    assert_eq!(avail_after_first - avail_before, 1);
    assert_eq!(
        avail_after_second, avail_after_first,
        "second release must not free another slot"
    );
}

#[tokio::test]
async fn ensure_aria2_permit_does_not_double_acquire() {
    let (mgr, _spawner) = make_manager(2);
    assert!(mgr.ensure_aria2_permit("a").await);
    assert!(!mgr.ensure_aria2_permit("a").await);
    assert_eq!(mgr.available_permits(), 1);

    mgr.release_permit("a").await;
    assert_eq!(mgr.available_permits(), 2);
}

#[tokio::test]
async fn live_aria2_speed_limit_updates_the_current_gid_and_payload() {
    let (manager, spawner) = make_manager(1);
    let manager = Arc::new(manager);
    let mut task = aria2_task("speed-limit");
    task.payload.speed_limit = Some("1M".to_string());
    manager.push(task).await.unwrap();

    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };
    timeout(Duration::from_secs(1), async {
        loop {
            if manager.aria2_gid_for_download("speed-limit").is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("aria2 dispatch should register a gid");

    manager
        .set_aria2_download_speed_limit("speed-limit", Some("512K".to_string()))
        .await
        .unwrap();
    assert_eq!(spawner.speed_limit_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        spawner.last_speed_limit.lock().unwrap().as_deref(),
        Some("512K")
    );
    assert!(manager.aria2_speed_limited("speed-limit").await);

    manager
        .set_aria2_download_speed_limit("speed-limit", None)
        .await
        .unwrap();
    assert_eq!(spawner.speed_limit_calls.load(Ordering::SeqCst), 2);
    assert!(spawner.last_speed_limit.lock().unwrap().is_none());
    assert!(!manager.aria2_speed_limited("speed-limit").await);

    manager
        .apply_completion(
            "speed-limit",
            firelink_lib::queue::PendingOutcome::Complete,
        )
        .await;
    dispatcher.abort();
}

#[tokio::test]
async fn live_aria2_speed_limit_rejects_invalid_and_non_active_requests() {
    let (manager, spawner) = make_manager(1);
    assert!(manager
        .set_aria2_download_speed_limit("missing", Some("not-a-rate".to_string()))
        .await
        .is_err());
    assert!(manager
        .set_aria2_download_speed_limit("missing", Some("512K".to_string()))
        .await
        .is_err());
    assert_eq!(spawner.speed_limit_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn live_aria2_speed_limit_does_not_update_payload_after_gid_replacement() {
    let (manager, spawner) = make_manager(1);
    let manager = Arc::new(manager);
    let mut task = aria2_task("speed-stale");
    task.payload.speed_limit = Some("1M".to_string());
    manager.push(task).await.unwrap();

    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };
    timeout(Duration::from_secs(1), async {
        loop {
            if manager.aria2_gid_for_download("speed-stale").is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("aria2 dispatch should register a gid");

    spawner
        .block_speed_limit
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let started = spawner.speed_limit_started.notified();
    let setter = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move {
            manager
                .set_aria2_download_speed_limit("speed-stale", Some("512K".to_string()))
                .await
        })
    };
    timeout(Duration::from_secs(1), started)
        .await
        .expect("speed RPC should start");

    manager
        .remember_gid("speed-stale".to_string(), "gid-replaced".to_string())
        .await;
    spawner.speed_limit_release.notify_one();
    assert!(setter.await.unwrap().is_err());
    assert!(manager.aria2_speed_limited("speed-stale").await);

    manager
        .apply_completion(
            "speed-stale",
            firelink_lib::queue::PendingOutcome::Complete,
        )
        .await;
    dispatcher.abort();
}

#[tokio::test]
async fn retry_readds_aria2_with_the_latest_live_speed_limit() {
    use firelink_lib::queue::PendingOutcome;

    let (mgr, spawner) = make_manager(1);
    let manager = Arc::new(mgr);
    let mut task = aria2_task("speed-retry");
    task.payload.max_tries = Some(1);
    task.payload.speed_limit = Some("1M".to_string());
    manager.push(task).await.unwrap();
    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };

    timeout(Duration::from_secs(1), async {
        loop {
            if spawner.add_uri_calls.load(Ordering::SeqCst) >= 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("initial aria2 add should run");
    manager
        .handle_aria2_event(
            "gid-1",
            PendingOutcome::Error(
                "aria2 error code 1: Failed to receive data, cause: protocol error".to_string(),
            ),
        )
        .await;
    manager
        .set_aria2_download_speed_limit("speed-retry", Some("512K".to_string()))
        .await
        .unwrap();

    timeout(Duration::from_secs(4), async {
        loop {
            if spawner.add_uri_calls.load(Ordering::SeqCst) >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("retry should re-add after backoff");
    assert_eq!(
        spawner.add_speed_limits.lock().unwrap().as_slice(),
        &[Some("1M".to_string()), Some("512K".to_string())]
    );

    manager
        .handle_aria2_event(
            "gid-2",
            PendingOutcome::Error("permanent failure".to_string()),
        )
        .await;
    dispatcher.abort();
}

#[tokio::test]
async fn stale_aria2_permit_candidate_cannot_replace_current_permit() {
    let (mgr, _spawner) = make_manager(2);
    let existing = mgr.acquire_permit().await.unwrap();
    assert!(mgr
        .park_aria2_permit_if_missing("a", existing)
        .await);

    let candidate = mgr.acquire_aria2_permit_candidate().await.unwrap();
    assert!(!mgr
        .park_aria2_permit_if_missing("a", candidate)
        .await);
    assert_eq!(mgr.available_permits(), 1);

    mgr.release_permit("a").await;
    assert_eq!(mgr.available_permits(), 2);
}

#[tokio::test]
async fn aria2_control_epoch_invalidates_stale_resume_workers() {
    let (mgr, _spawner) = make_manager(1);
    let first_resume = mgr.next_aria2_control_epoch("a").await;
    assert!(mgr.is_aria2_control_epoch_current("a", first_resume).await);

    let pause = mgr.next_aria2_control_epoch("a").await;
    assert_ne!(pause, first_resume);
    assert!(!mgr.is_aria2_control_epoch_current("a", first_resume).await);
    assert!(mgr.is_aria2_control_epoch_current("a", pause).await);
}

#[tokio::test]
async fn stale_terminal_event_cannot_complete_a_newer_control_epoch() {
    use firelink_lib::queue::PendingOutcome;

    let (mgr, _spawner) = make_manager(1);
    let manager = Arc::new(mgr);
    manager.push(aria2_task("stale-event")).await.unwrap();
    let permit = manager.acquire_permit().await.expect("permit");
    manager.park_permit("stale-event", permit).await;

    let old_epoch = manager.next_aria2_control_epoch("stale-event").await;
    manager
        .remember_gid("stale-event".to_string(), "gid-old".to_string())
        .await;
    manager.next_aria2_control_epoch("stale-event").await;

    manager
        .handle_aria2_event("gid-old", PendingOutcome::Complete)
        .await;

    assert!(
        !manager
            .is_aria2_control_epoch_current("stale-event", old_epoch)
            .await
    );
    assert_eq!(
        manager.available_permits(),
        0,
        "a terminal event from an older epoch must not release the newer lifecycle permit"
    );
    manager.forget_aria2_gid("stale-event").await;
    manager.release_permit("stale-event").await;
    manager.release_registered_id("stale-event").await;
}

#[tokio::test]
async fn resumed_gid_rebinds_to_the_new_control_epoch() {
    use firelink_lib::queue::PendingOutcome;

    let (mgr, _spawner) = make_manager(1);
    let manager = Arc::new(mgr);
    manager.push(aria2_task("resumed-gid")).await.unwrap();
    let permit = manager.acquire_permit().await.expect("permit");
    manager.park_permit("resumed-gid", permit).await;
    manager
        .remember_gid("resumed-gid".to_string(), "gid-resumed".to_string())
        .await;

    let resume_epoch = manager.next_aria2_control_epoch("resumed-gid").await;
    manager
        .handle_aria2_event("gid-resumed", PendingOutcome::Complete)
        .await;
    assert_eq!(
        manager.available_permits(),
        0,
        "the old GID epoch must not complete the resumed lifecycle"
    );

    assert!(manager
        .rebind_aria2_gid_epoch("resumed-gid", "gid-resumed", resume_epoch)
        .await);
    manager
        .handle_aria2_event("gid-resumed", PendingOutcome::Complete)
        .await;

    assert_eq!(manager.available_permits(), 1);
    assert!(manager.aria2_gid_for_download("resumed-gid").is_none());
}

#[tokio::test]
async fn gid_mapping_snapshot_is_invalid_after_epoch_or_gid_replacement() {
    let (mgr, _spawner) = make_manager(1);

    mgr.remember_gid("snapshot".to_string(), "gid-old".to_string())
        .await;
    let old_mapping = mgr
        .aria2_gid_mapping("gid-old")
        .expect("the first gid should be mapped");
    assert!(mgr.is_current_aria2_gid_mapping("gid-old", &old_mapping));

    let resume_epoch = mgr.next_aria2_control_epoch("snapshot").await;
    assert!(mgr
        .rebind_aria2_gid_epoch("snapshot", "gid-old", resume_epoch)
        .await);
    assert!(!mgr.is_current_aria2_gid_mapping("gid-old", &old_mapping));

    mgr.remember_gid("snapshot".to_string(), "gid-new".to_string())
        .await;
    assert!(mgr.aria2_gid_mapping("gid-old").is_none());
    let new_mapping = mgr
        .aria2_gid_mapping("gid-new")
        .expect("the replacement gid should be mapped");
    assert!(mgr.is_current_aria2_gid_mapping("gid-new", &new_mapping));
}

#[tokio::test]
async fn forgetting_aria2_gid_clears_mapping_without_releasing_twice() {
    let (mgr, _spawner) = make_manager(1);
    let permit = mgr.acquire_permit().await;
    mgr.park_permit("a", permit.unwrap()).await;
    mgr.remember_gid("a".to_string(), "gid-a".to_string()).await;

    assert_eq!(mgr.forget_aria2_gid("a").await.as_deref(), Some("gid-a"));
    assert!(mgr.aria2_gid_for_download("a").is_none());
    assert_eq!(mgr.available_permits(), 0);

    mgr.release_permit("a").await;
    mgr.release_permit("a").await;
    assert_eq!(mgr.available_permits(), 1);
}

#[tokio::test]
async fn push_then_pop_front_drains_fifo() {
    let (mgr, _spawner) = make_manager(2);
    mgr.push(sample_task("a")).await.unwrap();
    mgr.push(sample_task("b")).await.unwrap();
    let first = mgr.pop_front().await.expect("some task");
    let second = mgr.pop_front().await.expect("some task");
    assert_eq!(first.id, "a");
    assert_eq!(second.id, "b");
    assert!(mgr.pop_front().await.is_none());
}

#[tokio::test]
async fn dispatcher_parks_when_idle_no_busy_spin() {
    let (mgr, _spawner) = make_manager(3);
    let mgr_arc = Arc::new(mgr);
    let handle = {
        let mgr_clone = Arc::clone(&mgr_arc);
        tokio::spawn(async move { mgr_clone.run_dispatcher().await })
    };

    // Queue is empty. Sleep long enough for any busy-spin to drain permits.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // No permit should have been acquired while idle.
    assert_eq!(
        mgr_arc.available_permits(),
        3,
        "dispatcher must not acquire permits when pending is empty"
    );

    handle.abort();
}

#[tokio::test]
async fn cas_retirement_never_underflows() {
    let (mgr, _spawner) = make_manager(3);
    let mgr_arc = Arc::new(mgr);
    let handle = {
        let mgr_clone = Arc::clone(&mgr_arc);
        tokio::spawn(async move { mgr_clone.run_dispatcher().await })
    };

    // Repeatedly toggle capacity down while idle. A fetch_sub-based impl
    // would underflow to usize::MAX on the second set_capacity(1).
    for _ in 0..5 {
        mgr_arc.set_capacity(3);
        mgr_arc.set_capacity(1);
        mgr_arc.set_capacity(3);
    }
    tokio::time::sleep(Duration::from_millis(50)).await;

    let debt = mgr_arc.slots_to_retire_load();
    assert!(
        debt <= 2,
        "retirement debt must stay within [0, capacity-target], got {debt}"
    );

    handle.abort();
}

#[tokio::test]
async fn grow_releases_immediately_and_dispatches_waiting_tasks() {
    let (mgr, spawner) = make_manager(2);
    let mgr_arc = Arc::new(mgr);

    for i in 0..4 {
        mgr_arc.push(sample_task(&format!("t{i}"))).await.unwrap();
    }
    let handle = {
        let mgr_clone = Arc::clone(&mgr_arc);
        tokio::spawn(async move { mgr_clone.run_dispatcher().await })
    };

    // Give dispatcher time to dispatch 2 (capacity) of the 4.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let aria2_after_initial = spawner.add_uri_calls.load(Ordering::SeqCst);
    assert_eq!(
        aria2_after_initial, 2,
        "only capacity-many tasks dispatch initially"
    );

    // Grow to 4; the remaining 2 should dispatch.
    mgr_arc.set_capacity(4);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let aria2_after_grow = spawner.add_uri_calls.load(Ordering::SeqCst);
    assert_eq!(
        aria2_after_grow, 4,
        "grow must allow the waiting tasks to dispatch"
    );

    handle.abort();
}

#[tokio::test]
async fn shrink_converges_to_target_without_killing_active() {
    let (mgr, spawner) = make_manager(4);
    let mgr_arc = Arc::new(mgr);

    for i in 0..6 {
        mgr_arc.push(sample_task(&format!("t{i}"))).await.unwrap();
    }
    let handle = {
        let mgr_clone = Arc::clone(&mgr_arc);
        tokio::spawn(async move { mgr_clone.run_dispatcher().await })
    };

    // Let 4 dispatch (capacity).
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(spawner.add_uri_calls.load(Ordering::SeqCst), 4);

    // Shrink to 2 while 4 are "active" (permits parked).
    mgr_arc.set_capacity(2);

    // Release active permits. Debt is 2; two releases retire both, but the
    // remaining active count still equals the shrunken target.
    mgr_arc.release_permit("t0").await;
    mgr_arc.release_permit("t1").await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert_eq!(
        spawner.add_uri_calls.load(Ordering::SeqCst),
        4,
        "pending tasks must not dispatch while active count already meets the shrunken target"
    );

    mgr_arc.release_permit("t2").await;
    mgr_arc.release_permit("t3").await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert_eq!(
        spawner.add_uri_calls.load(Ordering::SeqCst),
        6,
        "pending tasks dispatch after active count falls below the shrunken target"
    );

    handle.abort();
}

#[tokio::test]
async fn aria2_resume_waits_for_shrunk_capacity() {
    let (mgr, _spawner) = make_manager(3);
    let mgr_arc = Arc::new(mgr);

    let active = mgr_arc.acquire_permit().await.unwrap();
    mgr_arc.park_permit("active", active).await;
    let paused = mgr_arc.acquire_permit().await.unwrap();
    mgr_arc.park_permit("paused", paused).await;
    mgr_arc.release_permit("paused").await;

    mgr_arc.set_capacity(1);

    let waiter = {
        let mgr_clone = Arc::clone(&mgr_arc);
        tokio::spawn(async move { mgr_clone.ensure_aria2_permit("paused").await })
    };

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !waiter.is_finished(),
        "paused resume must wait while current active count already meets shrunk limit"
    );

    mgr_arc.release_permit("active").await;
    assert!(timeout(Duration::from_secs(1), waiter)
        .await
        .expect("resume permit should unblock after active transfer exits")
        .expect("resume task should not panic"));
}

#[tokio::test]
async fn dispatcher_skips_a_full_front_queue_for_later_eligible_work() {
    let (manager, spawner) = make_manager(2);
    let manager = Arc::new(manager);
    manager
        .replace_queue_limits(vec![
            ("queue-a".to_string(), Some(1)),
            ("queue-b".to_string(), Some(1)),
        ])
        .await
        .unwrap();

    manager.push(aria2_task_in_queue("a1", "queue-a")).await.unwrap();
    manager.push(aria2_task_in_queue("a2", "queue-a")).await.unwrap();
    manager.push(aria2_task_in_queue("b1", "queue-b")).await.unwrap();
    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };

    timeout(Duration::from_secs(1), async {
        loop {
            if spawner.add_uri_calls.load(Ordering::SeqCst) == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("later eligible queue should dispatch");
    assert!(manager.aria2_gid_for_download("a1").is_some());
    assert!(manager.aria2_gid_for_download("b1").is_some());
    assert!(manager.aria2_gid_for_download("a2").is_none());

    dispatcher.abort();
}

#[tokio::test]
async fn dispatcher_rotates_eligible_queues_without_starving_later_work() {
    let (manager, spawner) = make_manager(1);
    let manager = Arc::new(manager);
    manager
        .replace_queue_limits(vec![
            ("queue-a".to_string(), Some(1)),
            ("queue-b".to_string(), Some(1)),
        ])
        .await
        .unwrap();
    manager.push(aria2_task_in_queue("a1", "queue-a")).await.unwrap();
    manager.push(aria2_task_in_queue("a2", "queue-a")).await.unwrap();
    manager.push(aria2_task_in_queue("b1", "queue-b")).await.unwrap();
    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };

    timeout(Duration::from_secs(1), async {
        while spawner.add_uri_calls.load(Ordering::SeqCst) < 1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("first queue task should dispatch");
    manager.release_permit("a1").await;

    timeout(Duration::from_secs(1), async {
        while manager.aria2_gid_for_download("b1").is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("later queue should be selected before another task from queue-a");
    assert!(manager.aria2_gid_for_download("a2").is_none());

    dispatcher.abort();
}

#[tokio::test]
async fn queue_limit_increase_wakes_waiting_work_and_decrease_keeps_active_tasks() {
    let (manager, spawner) = make_manager(3);
    let manager = Arc::new(manager);
    manager
        .replace_queue_limits(vec![("queue-a".to_string(), Some(2))])
        .await
        .unwrap();
    for id in ["a1", "a2", "a3"] {
        manager.push(aria2_task_in_queue(id, "queue-a")).await.unwrap();
    }
    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };

    timeout(Duration::from_secs(1), async {
        while spawner.add_uri_calls.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("queue override should allow two active transfers");
    manager
        .replace_queue_limits(vec![("queue-a".to_string(), Some(1))])
        .await
        .unwrap();
    assert_eq!(spawner.add_uri_calls.load(Ordering::SeqCst), 2);

    manager.release_permit("a1").await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        spawner.add_uri_calls.load(Ordering::SeqCst),
        2,
        "reducing a queue limit must not admit work while one active transfer remains"
    );

    manager.release_permit("a2").await;
    timeout(Duration::from_secs(1), async {
        while spawner.add_uri_calls.load(Ordering::SeqCst) < 3 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("queue work should resume after active count falls below the reduced limit");

    dispatcher.abort();
}

#[tokio::test]
async fn queue_overrides_never_exceed_the_global_ceiling() {
    let (manager, spawner) = make_manager(2);
    let manager = Arc::new(manager);
    manager
        .replace_queue_limits(vec![
            ("queue-a".to_string(), Some(12)),
            ("queue-b".to_string(), Some(12)),
        ])
        .await
        .unwrap();
    for (id, queue_id) in [
        ("a1", "queue-a"),
        ("a2", "queue-a"),
        ("b1", "queue-b"),
        ("b2", "queue-b"),
    ] {
        manager.push(aria2_task_in_queue(id, queue_id)).await.unwrap();
    }
    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(spawner.add_uri_calls.load(Ordering::SeqCst), 2);
    assert_eq!(manager.available_permits(), 0);

    dispatcher.abort();
}

#[tokio::test]
async fn queue_limit_configuration_rejects_malformed_input() {
    let (manager, _spawner) = make_manager(2);
    assert!(manager
        .replace_queue_limits(vec![(String::new(), Some(1))])
        .await
        .is_err());
    assert!(manager
        .replace_queue_limits(vec![("queue-a".to_string(), Some(0))])
        .await
        .is_err());
    assert!(manager
        .replace_queue_limits(vec![
            ("queue-a".to_string(), Some(1)),
            ("queue-a".to_string(), None),
        ])
        .await
        .is_err());
    manager
        .replace_queue_limits(vec![("queue-a".to_string(), None)])
        .await
        .unwrap();
}

#[tokio::test]
async fn stale_queue_resume_reservation_is_removed_when_activation_fails() {
    let (manager, _spawner) = make_manager(1);
    let previous = manager
        .reserve_enqueue_generation("candidate", 1)
        .await
        .unwrap();
    assert!(previous.is_none());
    let candidate = manager
        .acquire_aria2_permit_candidate_for_queue("candidate", "queue-a", 1)
        .await
        .expect("candidate should reserve the queue slot");

    manager.release_registered_id("candidate").await;
    assert!(!manager
        .park_aria2_permit_if_missing_for_queue("candidate", "queue-a", 1, candidate)
        .await);
    assert_eq!(manager.available_permits(), 1);

    assert!(manager.ensure_aria2_permit_for_queue("replacement", "queue-a").await);
    manager.release_permit("replacement").await;
}

#[tokio::test]
async fn duplicate_pending_id_cannot_replace_an_existing_queue_ownership() {
    let (manager, spawner) = make_manager(2);
    let manager = Arc::new(manager);
    manager
        .replace_queue_limits(vec![
            ("queue-a".to_string(), Some(1)),
            ("queue-b".to_string(), Some(1)),
        ])
        .await
        .unwrap();
    assert!(manager
        .ensure_aria2_permit_for_queue("duplicate", "queue-b")
        .await);
    manager
        .reserve_enqueue_generation("duplicate", 1)
        .await
        .unwrap();
    manager
        .commit_reserved_enqueue(aria2_task_in_queue("duplicate", "queue-a"), 1)
        .await
        .unwrap();

    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert_eq!(spawner.add_uri_calls.load(Ordering::SeqCst), 0);
    assert_eq!(manager.available_permits(), 1);
    manager.release_permit("duplicate").await;
    dispatcher.abort();
}

fn aria2_task(id: &str) -> QueuedTask {
    QueuedTask {
        id: id.to_string(),
        queue_id: "main".to_string(),
        kind: TaskKind::Aria2,
        lifecycle_generation: 0,
        payload: SpawnPayload::default(),
    }
}

fn aria2_task_in_queue(id: &str, queue_id: &str) -> QueuedTask {
    let mut task = aria2_task(id);
    task.queue_id = queue_id.to_string();
    task
}

fn media_task(id: &str) -> QueuedTask {
    QueuedTask {
        id: id.to_string(),
        queue_id: "main".to_string(),
        kind: TaskKind::Media,
        lifecycle_generation: 0,
        payload: SpawnPayload::default(),
    }
}

struct FixedMediaSpawner {
    outcome: Result<(), String>,
}

#[async_trait::async_trait]
impl SidecarSpawner for FixedMediaSpawner {
    async fn add_uri(&self, _id: &str, _payload: &SpawnPayload) -> Result<String, String> {
        unreachable!("aria2 is not used by media terminal-state tests")
    }

    async fn remove_uri(&self, _gid: &str) -> Result<(), String> {
        unreachable!("aria2 is not used by media terminal-state tests")
    }

    async fn run_media(&self, _id: &str, _payload: &SpawnPayload, _generation: u64) -> Result<(), String> {
        self.outcome.clone()
    }
}

fn make_media_manager(
    outcome: Result<(), String>,
) -> (
    QueueManager<tauri::test::MockRuntime>,
    std::sync::mpsc::Receiver<String>,
) {
    let app = mock_builder()
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let (event_tx, event_rx) = std::sync::mpsc::channel();
    app.handle().listen("download-state", move |event| {
        let _ = event_tx.send(event.payload().to_string());
    });
    let spawner: Arc<dyn SidecarSpawner> = Arc::new(FixedMediaSpawner { outcome });
    let manager = QueueManager::test_new(app.handle().clone(), 1, spawner);
    (manager, event_rx)
}

fn emitted_statuses(event_rx: &std::sync::mpsc::Receiver<String>) -> Vec<String> {
    event_rx
        .try_iter()
        .filter_map(|payload| serde_json::from_str::<serde_json::Value>(&payload).ok())
        .filter_map(|payload| payload.get("status")?.as_str().map(str::to_string))
        .collect()
}

#[tokio::test]
async fn media_terminal_error_emits_failed_without_completed() {
    let (manager, event_rx) = make_media_manager(Err("terminal media failure".to_string()));
    let manager = Arc::new(manager);
    manager.push(media_task("media-failed")).await.unwrap();
    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };

    tokio::time::sleep(Duration::from_millis(100)).await;
    let statuses = emitted_statuses(&event_rx);
    assert!(statuses.iter().any(|status| status == "failed"));
    assert!(!statuses.iter().any(|status| status == "completed"));
    assert_eq!(manager.available_permits(), 1);

    dispatcher.abort();
}

#[tokio::test]
async fn media_cancellation_does_not_emit_completed() {
    let (manager, event_rx) = make_media_manager(Err(MEDIA_RUN_CANCELLED.to_string()));
    let manager = Arc::new(manager);
    manager.push(media_task("media-cancelled")).await.unwrap();
    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };

    tokio::time::sleep(Duration::from_millis(100)).await;
    let statuses = emitted_statuses(&event_rx);
    assert!(!statuses.iter().any(|status| status == "failed"));
    assert!(!statuses.iter().any(|status| status == "completed"));
    assert_eq!(manager.available_permits(), 1);
    assert!(!manager.is_registered("media-cancelled").await);

    dispatcher.abort();
}

#[tokio::test]
async fn aria2_permit_survives_rpc_return() {
    let (mgr, spawner) = make_manager(1);
    let mgr_arc = Arc::new(mgr);
    mgr_arc.push(aria2_task("a")).await.unwrap();
    let handle = {
        let mgr_clone = Arc::clone(&mgr_arc);
        tokio::spawn(async move { mgr_clone.run_dispatcher().await })
    };

    // Dispatcher acquires the single permit, parks it, calls add_uri (returns
    // instantly). The permit must STAY parked.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(spawner.add_uri_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        mgr_arc.available_permits(),
        0,
        "permit must remain parked while aria2 download is notionally running"
    );

    // Now simulate aria2 completion: release_permit frees the slot.
    mgr_arc.release_permit("a").await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        mgr_arc.available_permits(),
        1,
        "release frees the parked permit"
    );

    handle.abort();
}

#[tokio::test]
async fn failed_refresh_that_leaves_gid_paused_releases_permit_but_keeps_resume_mapping() {
    let app = mock_builder()
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let spawner = Arc::new(RefreshOutcomeSpawner {
        outcome: Aria2RefreshOutcome::Paused,
        refresh_calls: AtomicUsize::new(0),
    });
    let manager = QueueManager::test_new(
        app.handle().clone(),
        1,
        Arc::clone(&spawner) as Arc<dyn SidecarSpawner>,
    );
    manager.push(aria2_task("refresh-paused")).await.unwrap();
    assert!(manager.ensure_aria2_permit("refresh-paused").await);
    manager
        .remember_gid("refresh-paused".to_string(), "gid-refresh-paused".to_string())
        .await;

    let epoch = manager.current_aria2_control_epoch("refresh-paused").await;
    manager
        .refresh_aria2_connections("refresh-paused", "gid-refresh-paused", epoch)
        .await
        .unwrap();

    assert_eq!(spawner.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(manager.available_permits(), 1);
    assert!(!manager.has_active_permit("refresh-paused").await);
    assert_eq!(
        manager.aria2_gid_for_download("refresh-paused").as_deref(),
        Some("gid-refresh-paused")
    );
    assert!(manager.is_registered("refresh-paused").await);
}

#[tokio::test]
async fn stale_refresh_observation_cannot_touch_a_newer_control_epoch() {
    let app = mock_builder()
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let spawner = Arc::new(RefreshOutcomeSpawner {
        outcome: Aria2RefreshOutcome::Resumed,
        refresh_calls: AtomicUsize::new(0),
    });
    let manager = QueueManager::test_new(
        app.handle().clone(),
        1,
        Arc::clone(&spawner) as Arc<dyn SidecarSpawner>,
    );
    manager.push(aria2_task("refresh-stale")).await.unwrap();
    assert!(manager.ensure_aria2_permit("refresh-stale").await);
    manager
        .remember_gid("refresh-stale".to_string(), "gid-refresh-stale".to_string())
        .await;
    let stale_epoch = manager.current_aria2_control_epoch("refresh-stale").await;
    manager.next_aria2_control_epoch("refresh-stale").await;

    manager
        .refresh_aria2_connections("refresh-stale", "gid-refresh-stale", stale_epoch)
        .await
        .unwrap();

    assert_eq!(spawner.refresh_calls.load(Ordering::SeqCst), 0);
    assert!(manager.has_active_permit("refresh-stale").await);
}

#[tokio::test]
async fn transient_aria2_error_reissues_after_backoff() {
    use firelink_lib::queue::PendingOutcome;

    let (mgr, spawner) = make_manager(1);
    let manager = Arc::new(mgr);
    let mut task = aria2_task("retry");
    task.payload.max_tries = Some(1);
    manager.push(task).await.unwrap();

    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(spawner.add_uri_calls.load(Ordering::SeqCst), 1);

    manager
        .handle_aria2_event(
            "gid-1",
            PendingOutcome::Error(
                "aria2 error code 1: Failed to receive data, cause: protocol error".to_string(),
            ),
        )
        .await;

    timeout(Duration::from_secs(4), async {
        loop {
            if spawner.add_uri_calls.load(Ordering::SeqCst) >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("transient aria2 errors must retry after backoff");

    manager
        .handle_aria2_event(
            "gid-2",
            PendingOutcome::Error("SSL/TLS handshake failure: protocol error".to_string()),
        )
        .await;
    assert_eq!(spawner.add_uri_calls.load(Ordering::SeqCst), 2);
    assert!(manager.aria2_gid_for_download("retry").is_none());
    assert_eq!(manager.available_permits(), 1);

    manager.release_permit("retry").await;
    dispatcher.abort();
}

#[tokio::test]
async fn duplicate_transient_events_schedule_only_one_retry_worker() {
    use firelink_lib::queue::PendingOutcome;

    let (mgr, spawner) = make_manager(1);
    let manager = Arc::new(mgr);
    let mut task = aria2_task("duplicate-retry");
    task.payload.max_tries = Some(1);
    manager.push(task).await.unwrap();

    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;

    let error = PendingOutcome::Error(
        "aria2 error code 1: Failed to receive data, cause: protocol error".to_string(),
    );
    manager.handle_aria2_event("gid-1", error.clone()).await;
    manager.handle_aria2_event("gid-1", error).await;

    timeout(Duration::from_secs(4), async {
        loop {
            if spawner.add_uri_calls.load(Ordering::SeqCst) >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("one retry should be issued");
    assert_eq!(
        spawner.add_uri_calls.load(Ordering::SeqCst),
        2,
        "duplicate terminal events must not create duplicate aria2 jobs"
    );

    manager
        .handle_aria2_event(
            "gid-2",
            PendingOutcome::Error("HTTP 404 Not Found".to_string()),
        )
        .await;
    dispatcher.abort();
}

#[tokio::test]
async fn stale_retry_worker_cannot_reenter_after_new_control_epoch() {
    use firelink_lib::queue::PendingOutcome;

    let (mgr, spawner) = make_manager(1);
    let manager = Arc::new(mgr);
    let mut task = aria2_task("stale-retry");
    task.payload.max_tries = Some(1);
    manager.push(task).await.unwrap();

    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    manager
        .handle_aria2_event(
            "gid-1",
            PendingOutcome::Error(
                "aria2 error code 1: Failed to receive data, cause: protocol error".to_string(),
            ),
        )
        .await;

    // Simulate a newer pause/resume lifecycle while the old worker is in its
    // cancel-safe backoff. Clearing the reusable cancellation flag must not
    // revive the worker because its control epoch is stale.
    manager.next_aria2_control_epoch("stale-retry").await;
    manager.allow_aria2_retries("stale-retry").await;
    tokio::time::sleep(Duration::from_secs(3)).await;

    assert_eq!(
        spawner.add_uri_calls.load(Ordering::SeqCst),
        1,
        "a retry worker from an older lifecycle must not add a new gid"
    );
    manager.release_permit("stale-retry").await;
    dispatcher.abort();
}

#[tokio::test]
async fn completion_event_for_retrying_gid_cannot_release_new_lifecycle_permit() {
    use firelink_lib::queue::PendingOutcome;

    let (mgr, spawner) = make_manager(1);
    let manager = Arc::new(mgr);
    let mut task = aria2_task("retry-complete-race");
    task.payload.max_tries = Some(1);
    manager.push(task).await.unwrap();

    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    manager
        .handle_aria2_event(
            "gid-1",
            PendingOutcome::Error(
                "aria2 error code 1: Failed to receive data, cause: protocol error".to_string(),
            ),
        )
        .await;
    manager
        .handle_aria2_event("gid-1", PendingOutcome::Complete)
        .await;
    assert_eq!(
        manager.available_permits(),
        0,
        "a duplicate completion for the retrying gid must not free the permit"
    );

    timeout(Duration::from_secs(4), async {
        loop {
            if spawner.add_uri_calls.load(Ordering::SeqCst) >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("retry should create the next gid");
    manager
        .handle_aria2_event("gid-2", PendingOutcome::Complete)
        .await;
    assert_eq!(manager.available_permits(), 1);
    dispatcher.abort();
}

#[tokio::test]
async fn initial_aria2_add_failure_releases_registry_for_restart() {
    let app = mock_builder()
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let spawner = Arc::new(FailFirstAria2Spawner::new());
    let manager = Arc::new(QueueManager::test_new(
        app.handle().clone(),
        1,
        spawner.clone(),
    ));
    manager
        .push_with_generation(aria2_task("initial-failure"), 1)
        .await
        .unwrap();

    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };
    timeout(Duration::from_secs(1), async {
        loop {
            if !manager.is_registered("initial-failure").await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("failed initial addUri must release the registry id");

    manager
        .push_with_generation(aria2_task("initial-failure"), 2)
        .await
        .expect("the same download must be restartable after initial add failure");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(spawner.add_uri_calls.load(Ordering::SeqCst), 2);
    manager.release_permit("initial-failure").await;
    dispatcher.abort();
}

#[tokio::test]
async fn late_initial_gid_cannot_attach_to_a_newer_lifecycle() {
    let app = mock_builder()
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let (gid_started_tx, gid_started_rx) = tokio::sync::oneshot::channel();
    let spawner = Arc::new(DelayedAria2Spawner::new(gid_started_tx));
    let manager = Arc::new(QueueManager::test_new(
        app.handle().clone(),
        1,
        spawner.clone(),
    ));
    manager
        .push_with_generation(aria2_task("dispatch-race"), 1)
        .await
        .unwrap();

    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };
    gid_started_rx.await.expect("first addUri should start");

    // Model pause while the first addUri is still resolving, followed by a
    // new enqueue for the same frontend download id.
    manager.next_aria2_control_epoch("dispatch-race").await;
    manager.cancel_aria2_retries("dispatch-race").await;
    manager.clear_aria2_retry_state("dispatch-race").await;
    manager.release_permit("dispatch-race").await;
    manager.release_registered_id("dispatch-race").await;
    manager
        .push_with_generation(aria2_task("dispatch-race"), 2)
        .await
        .unwrap();

    timeout(Duration::from_secs(1), async {
        loop {
            if manager.aria2_gid_for_download("dispatch-race").as_deref() == Some("gid-2") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("new lifecycle should own the mapped gid");
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert_eq!(spawner.add_uri_calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        spawner.remove_uri_calls.load(Ordering::SeqCst),
        1,
        "the late gid from the old lifecycle must be removed"
    );
    assert_eq!(
        manager.aria2_gid_for_download("dispatch-race").as_deref(),
        Some("gid-2")
    );
    manager.release_permit("dispatch-race").await;
    dispatcher.abort();
}

#[tokio::test]
async fn transient_error_buffered_before_gid_mapping_still_retries() {
    use firelink_lib::queue::PendingOutcome;

    let app = mock_builder()
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let (gid_started_tx, gid_started_rx) = tokio::sync::oneshot::channel();
    let spawner = Arc::new(DelayedAria2Spawner::new(gid_started_tx));
    let manager = Arc::new(QueueManager::test_new(
        app.handle().clone(),
        1,
        spawner.clone(),
    ));
    let mut task = aria2_task("early-error");
    task.payload.max_tries = Some(1);
    manager.push(task).await.unwrap();

    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };
    gid_started_rx.await.expect("initial addUri should start");
    manager
        .handle_aria2_event(
            "late-gid",
            PendingOutcome::Error(
                "aria2 error code 1: Failed to receive data, cause: protocol error".to_string(),
            ),
        )
        .await;

    timeout(Duration::from_secs(4), async {
        loop {
            if spawner.add_uri_calls.load(Ordering::SeqCst) >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the buffered transient error must enter the retry loop");

    manager
        .handle_aria2_event(
            "gid-2",
            PendingOutcome::Error("HTTP 404 Not Found".to_string()),
        )
        .await;
    dispatcher.abort();
}

#[tokio::test]
async fn gid_completion_before_store_buffers_and_reconciles() {
    use firelink_lib::queue::PendingOutcome;

    let (mgr, _spawner) = make_manager(1);
    let mgr_arc = Arc::new(mgr);
    mgr_arc.push(aria2_task("a")).await.unwrap();
    let handle = {
        let mgr_clone = Arc::clone(&mgr_arc);
        tokio::spawn(async move { mgr_clone.run_dispatcher().await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;

    // The dispatcher called add_uri and got "gid-1", then remember_gid stored it.
    // Simulate a completion arriving for an UNKNOWN gid first:
    mgr_arc
        .handle_aria2_event("gid-unknown", PendingOutcome::Complete)
        .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    // Permit still parked (gid-unknown is not ours).
    assert_eq!(mgr_arc.available_permits(), 0);

    // Now store gid-1 -> "a" via remember_gid. The buffered gid-unknown stays
    // buffered (different gid). Release via the real gid:
    mgr_arc.release_permit("a").await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(mgr_arc.available_permits(), 1);

    // Push another aria2 task; its gid will be "gid-2".
    mgr_arc.push(aria2_task("b")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    mgr_arc.release_permit("b").await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    handle.abort();
}

#[tokio::test]
async fn aria2_completion_forgets_gid_and_releases_permit() {
    use firelink_lib::queue::PendingOutcome;

    let (mgr, _spawner) = make_manager(1);
    let permit = mgr.acquire_permit().await;
    mgr.park_permit("a", permit.unwrap()).await;
    mgr.remember_gid("a".to_string(), "gid-a".to_string()).await;

    mgr.apply_completion("a", PendingOutcome::Complete).await;

    assert!(mgr.aria2_gid_for_download("a").is_none());
    assert_eq!(mgr.available_permits(), 1);
}

#[tokio::test]
async fn late_aria2_gid_after_cancellation_is_removed_without_leaking_permit() {
    let app = mock_builder()
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let (gid_started_tx, gid_started_rx) = tokio::sync::oneshot::channel();
    let spawner = Arc::new(DelayedAria2Spawner::new(gid_started_tx));
    let manager = Arc::new(QueueManager::test_new(
        app.handle().clone(),
        1,
        spawner.clone(),
    ));
    manager.push(aria2_task("late")).await.unwrap();

    let dispatcher = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.run_dispatcher().await })
    };

    gid_started_rx.await.expect("add_uri should start");
    manager.cancel_aria2_retries("late").await;
    manager.release_registered_id("late").await;
    manager.release_permit("late").await;

    tokio::time::sleep(Duration::from_millis(100)).await;

    assert!(manager.aria2_gid_for_download("late").is_none());
    assert_eq!(manager.available_permits(), 1);
    assert_eq!(spawner.remove_uri_calls.load(Ordering::SeqCst), 1);

    dispatcher.abort();
}

#[tokio::test]
async fn move_up_down_reorders_pending() {
    use firelink_lib::ipc::QueueDirection;

    let (mgr, _spawner) = make_manager(3);
    let mgr_arc = Arc::new(mgr);
    mgr_arc.push(sample_task("a")).await.unwrap();
    mgr_arc.push(sample_task("b")).await.unwrap();
    mgr_arc.push(sample_task("c")).await.unwrap();

    mgr_arc
        .move_in_queue("c", "main", QueueDirection::Down)
        .await;
    assert_eq!(mgr_arc.pending_order(None).await, vec!["a", "b", "c"]);

    mgr_arc.move_in_queue("c", "main", QueueDirection::Up).await;
    assert_eq!(mgr_arc.pending_order(None).await, vec!["a", "c", "b"]);

    mgr_arc
        .move_in_queue("a", "main", QueueDirection::Down)
        .await;
    assert_eq!(mgr_arc.pending_order(None).await, vec!["c", "a", "b"]);

    mgr_arc.move_in_queue("c", "main", QueueDirection::Up).await;
    assert_eq!(mgr_arc.pending_order(None).await, vec!["c", "a", "b"]);
}

#[tokio::test]
async fn multi_move_reorders_selected_items_as_one_atomic_block() {
    use firelink_lib::ipc::QueueDirection;

    let (mgr, _spawner) = make_manager(3);
    for id in ["a", "b", "c", "d", "e"] {
        mgr.push(sample_task(id)).await.unwrap();
    }

    let selected = vec!["b".to_string(), "d".to_string()];
    assert_eq!(
        mgr.move_many_in_queue(&selected, "main", QueueDirection::Up)
            .await,
        vec!["b", "d", "a", "c", "e"]
    );
    assert_eq!(
        mgr.move_many_in_queue(&selected, "main", QueueDirection::Down)
            .await,
        vec!["a", "b", "d", "c", "e"]
    );
}

#[tokio::test]
async fn target_move_reorders_a_selected_block_and_clamps_the_target() {
    use firelink_lib::ipc::QueueDirection;

    let (mgr, _spawner) = make_manager(3);
    for id in ["a", "b", "c", "d", "e"] {
        mgr.push(sample_task(id)).await.unwrap();
    }

    let selected = vec!["b".to_string(), "d".to_string()];
    assert_eq!(
        mgr.move_many_in_queue_to(&selected, "main", 1).await,
        vec!["a", "b", "d", "c", "e"]
    );
    assert_eq!(
        mgr.move_many_in_queue_to(&selected, "main", usize::MAX).await,
        vec!["a", "c", "e", "b", "d"]
    );

    // The original direction API remains unchanged for keyboard/button moves.
    assert_eq!(
        mgr.move_many_in_queue(&selected, "main", QueueDirection::Up)
            .await,
        vec!["a", "c", "b", "d", "e"]
    );
}

#[tokio::test]
async fn moving_one_queue_does_not_reorder_another_queue() {
    use firelink_lib::ipc::QueueDirection;

    let (mgr, _spawner) = make_manager(3);
    let mut a1 = sample_task("a1");
    a1.queue_id = "a".to_string();
    let mut b1 = sample_task("b1");
    b1.queue_id = "b".to_string();
    let mut a2 = sample_task("a2");
    a2.queue_id = "a".to_string();
    let mut b2 = sample_task("b2");
    b2.queue_id = "b".to_string();
    mgr.push(a1).await.unwrap();
    mgr.push(b1).await.unwrap();
    mgr.push(a2).await.unwrap();
    mgr.push(b2).await.unwrap();

    assert_eq!(
        mgr.move_in_queue("a2", "a", QueueDirection::Up).await,
        vec!["a2", "a1"]
    );
    assert_eq!(mgr.pending_order(Some("b")).await, vec!["b1", "b2"]);
}

#[tokio::test]
async fn notify_fires_on_push_and_release() {
    let (mgr, _spawner) = make_manager(1);
    let mgr_arc = Arc::new(mgr);

    let permit = mgr_arc.acquire_permit().await;
    mgr_arc.park_permit("a", permit.unwrap()).await;

    let handle = {
        let mgr_clone = Arc::clone(&mgr_arc);
        tokio::spawn(async move { mgr_clone.run_dispatcher().await })
    };

    mgr_arc.push(sample_task("x")).await.unwrap();
    let dispatched = timeout(Duration::from_millis(150), async {
        loop {
            if mgr_arc.available_permits() == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(dispatched.is_ok(), "push must wake the idle dispatcher");

    handle.abort();
}

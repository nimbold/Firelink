use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const STOP_POLL_ATTEMPTS: usize = 30;
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(100);
const CANCELLATION_CLEANUP_ATTEMPTS: usize = 3;
const CANCELLATION_CLEANUP_INTERVAL: Duration = Duration::from_millis(250);

#[async_trait]
pub(crate) trait RpcClient: Send + Sync {
    async fn call(&self, method: &str, params: Value) -> Result<Value, String>;
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ProbeFailure {
    Metadata(String),
    Cleanup(String),
}

pub(crate) async fn run_metadata_probe<C: RpcClient + 'static>(
    client: Arc<C>,
    source: &str,
    options: Map<String, Value>,
    metadata_path: &Path,
    timeout: Duration,
    poll_interval: Duration,
) -> Result<Vec<u8>, ProbeFailure> {
    let mut cleanup_guard = ProbeCleanupGuard::new(Arc::clone(&client), metadata_path);
    let result = match client
        .call("aria2.addUri", json!([[source], options]))
        .await
    {
        Ok(result) => result,
        Err(error) => {
            cleanup_guard.disarm();
            return Err(ProbeFailure::Metadata(format!(
                "Aria2 could not start magnet metadata resolution: {}",
                crate::redact_sensitive_text(&error)
            )));
        }
    };
    let gid = match result.as_str().filter(|value| !value.is_empty()) {
        Some(gid) => gid.to_string(),
        None => {
            cleanup_guard.disarm();
            return Err(ProbeFailure::Metadata(
                "Aria2 returned an empty metadata probe GID".to_string(),
            ));
        }
    };
    cleanup_guard.set_gid(gid.clone());

    let metadata_result = async {
        let deadline = Instant::now() + timeout;
        loop {
            let status = match client
                .call(
                    "aria2.tellStatus",
                    json!([&gid, ["status", "errorCode", "errorMessage"]]),
                )
                .await
            {
                Ok(status) => status,
                Err(error) if crate::aria2_gid_not_found(&error) => {
                    return Err(ProbeFailure::Metadata(
                        "Aria2 removed the magnet metadata probe before metadata was saved"
                            .to_string(),
                    ));
                }
                Err(error) if crate::retry::is_transient_network_error(&error) => {
                    if Instant::now() >= deadline {
                        return Err(ProbeFailure::Metadata(format!(
                            "Aria2 metadata resolution status failed: {}",
                            crate::redact_sensitive_text(&error)
                        )));
                    }
                    tokio::time::sleep(poll_interval).await;
                    continue;
                }
                Err(error) => {
                    return Err(ProbeFailure::Metadata(format!(
                        "Aria2 metadata resolution status failed: {}",
                        crate::redact_sensitive_text(&error)
                    )));
                }
            };
            match status.get("status").and_then(Value::as_str) {
                Some("complete") => break,
                Some("error") | Some("removed") => {
                    let error_code = status
                        .get("errorCode")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty());
                    let error_message = status
                        .get("errorMessage")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("metadata probe ended without a torrent file");
                    let detail = match error_code {
                        Some(code) => format!("aria2 error code {code}: {error_message}"),
                        None => error_message.to_string(),
                    };
                    return Err(ProbeFailure::Metadata(format!(
                        "Aria2 could not resolve magnet metadata: {}",
                        crate::redact_sensitive_text(&detail)
                    )));
                }
                Some("active") | Some("waiting") | Some("paused") => {}
                None => {
                    return Err(ProbeFailure::Metadata(
                        "Aria2 returned an invalid metadata probe status".to_string(),
                    ));
                }
                Some(status) => {
                    return Err(ProbeFailure::Metadata(format!(
                        "Aria2 returned an unsupported metadata probe status: {status}"
                    )));
                }
            }
            if Instant::now() >= deadline {
                return Err(ProbeFailure::Metadata(
                    "Aria2 magnet metadata resolution timed out".to_string(),
                ));
            }
            tokio::time::sleep(poll_interval).await;
        }

        tokio::fs::read(metadata_path).await.map_err(|error| {
            ProbeFailure::Metadata(format!(
                "Aria2 did not save magnet metadata ({:?})",
                error.kind()
            ))
        })
    }
    .await;

    let cleanup_result = cleanup_metadata_probe(client.as_ref(), &gid).await;
    if let Err(error) = cleanup_result {
        return Err(ProbeFailure::Cleanup(error));
    }
    cleanup_guard.disarm();
    metadata_result
}

struct ProbeCleanupGuard<C: RpcClient + 'static> {
    client: Arc<C>,
    gid: Option<String>,
    probe_dir: Option<PathBuf>,
}

impl<C: RpcClient + 'static> ProbeCleanupGuard<C> {
    fn new(client: Arc<C>, metadata_path: &Path) -> Self {
        Self {
            client,
            gid: None,
            probe_dir: metadata_path
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
                .map(Path::to_path_buf),
        }
    }

    fn set_gid(&mut self, gid: String) {
        self.gid = Some(gid);
    }

    fn disarm(&mut self) {
        self.gid = None;
        self.probe_dir = None;
    }
}

impl<C: RpcClient + 'static> Drop for ProbeCleanupGuard<C> {
    fn drop(&mut self) {
        let gid = self.gid.take();
        let probe_dir = self.probe_dir.take();
        if gid.is_none() && probe_dir.is_none() {
            return;
        }

        let Some(runtime) = tokio::runtime::Handle::try_current().ok() else {
            log::warn!("magnet metadata probe was canceled without an active Tokio runtime");
            return;
        };
        let client = Arc::clone(&self.client);
        runtime.spawn(async move {
            let cleanup_result = if let Some(gid) = gid {
                let mut last_error = None;
                for attempt in 0..CANCELLATION_CLEANUP_ATTEMPTS {
                    match cleanup_metadata_probe(client.as_ref(), &gid).await {
                        Ok(()) => {
                            last_error = None;
                            break;
                        }
                        Err(error) => {
                            last_error = Some(error);
                            if attempt + 1 < CANCELLATION_CLEANUP_ATTEMPTS {
                                tokio::time::sleep(CANCELLATION_CLEANUP_INTERVAL).await;
                            }
                        }
                    }
                }
                last_error
            } else {
                None
            };
            if let Some(error) = cleanup_result {
                log::warn!(
                    "canceled magnet metadata probe cleanup failed: {}",
                    crate::redact_sensitive_text(&error)
                );
                // Do not delete a directory while Aria2 may still own the
                // GID. The startup reaper removes this orphan before the
                // next daemon launch.
                return;
            }
            if let Some(probe_dir) = probe_dir {
                if let Err(error) = tokio::fs::remove_dir_all(&probe_dir).await {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        log::warn!(
                            "canceled magnet metadata probe directory cleanup failed ({:?})",
                            error.kind()
                        );
                    }
                }
            }
        });
    }
}

async fn cleanup_metadata_probe<C: RpcClient>(client: &C, gid: &str) -> Result<(), String> {
    match client.call("aria2.forceRemove", json!([gid])).await {
        Ok(result) => {
            crate::ensure_aria2_gid_result("forceRemove", gid, &result)?;
            wait_for_stopped(client, gid).await
        }
        Err(error) if crate::aria2_gid_not_found(&error) => Ok(()),
        Err(error) => match aria2_status(client, gid).await {
            Ok(status) if matches!(status.as_str(), "complete" | "error" | "removed") => Ok(()),
            Err(status_error) if crate::aria2_gid_not_found(&status_error) => Ok(()),
            _ => Err(format!(
                "failed to remove aria2 gid {gid}: {}",
                crate::redact_sensitive_text(&error)
            )),
        },
    }
}

async fn aria2_status<C: RpcClient>(client: &C, gid: &str) -> Result<String, String> {
    let result = client
        .call("aria2.tellStatus", json!([gid, ["status"]]))
        .await
        .map_err(|error| {
            format!(
                "failed to query aria2 gid {gid}: {}",
                crate::redact_sensitive_text(&error)
            )
        })?;
    result
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("aria2.tellStatus returned no status for gid {gid}"))
}

async fn wait_for_stopped<C: RpcClient>(client: &C, gid: &str) -> Result<(), String> {
    let mut last_transient_error = None;
    for _ in 0..STOP_POLL_ATTEMPTS {
        match aria2_status(client, gid).await {
            Ok(status)
                if matches!(status.as_str(), "paused" | "complete" | "error" | "removed") =>
            {
                return Ok(())
            }
            Ok(_) => {}
            Err(error) if crate::aria2_gid_not_found(&error) => return Ok(()),
            Err(error) if crate::retry::is_transient_network_error(&error) => {
                last_transient_error = Some(error);
            }
            Err(error) => return Err(error),
        }
        tokio::time::sleep(STOP_POLL_INTERVAL).await;
    }
    match last_transient_error {
        Some(error) => Err(format!(
            "aria2 gid {gid} did not stop within 3 seconds after forceRemove: {}",
            crate::redact_sensitive_text(&error)
        )),
        None => Err(format!(
            "aria2 gid {gid} did not stop within 3 seconds after forceRemove"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    struct FakeRpc {
        statuses: Mutex<VecDeque<Result<Value, String>>>,
        force_remove: Mutex<Result<Value, String>>,
        removed: AtomicBool,
        calls: Mutex<Vec<String>>,
        call_notification: tokio::sync::Notify,
    }

    impl FakeRpc {
        fn new(
            statuses: impl IntoIterator<Item = Result<Value, String>>,
            force_remove: Result<Value, String>,
        ) -> Self {
            Self {
                statuses: Mutex::new(statuses.into_iter().collect()),
                force_remove: Mutex::new(force_remove),
                removed: AtomicBool::new(false),
                calls: Mutex::new(Vec::new()),
                call_notification: tokio::sync::Notify::new(),
            }
        }

        fn status(name: &str) -> Result<Value, String> {
            Ok(json!({ "status": name }))
        }

        fn call_names(&self) -> Vec<String> {
            self.calls
                .lock()
                .expect("call log lock should work")
                .clone()
        }

        async fn wait_for_call(&self, method: &str) {
            loop {
                if self.call_names().iter().any(|call| call == method) {
                    return;
                }
                self.call_notification.notified().await;
            }
        }
    }

    #[async_trait]
    impl RpcClient for FakeRpc {
        async fn call(&self, method: &str, _params: Value) -> Result<Value, String> {
            self.calls
                .lock()
                .expect("call log lock should work")
                .push(method.to_string());
            self.call_notification.notify_one();
            match method {
                "aria2.addUri" => Ok(json!("gid-1")),
                "aria2.tellStatus" => {
                    if let Some(status) = self
                        .statuses
                        .lock()
                        .expect("status queue lock should work")
                        .pop_front()
                    {
                        status
                    } else if self.removed.load(Ordering::Acquire) {
                        Self::status("removed")
                    } else {
                        Self::status("active")
                    }
                }
                "aria2.forceRemove" => {
                    let result = self
                        .force_remove
                        .lock()
                        .expect("forceRemove lock should work");
                    if result.is_ok() {
                        self.removed.store(true, Ordering::Release);
                    }
                    match &*result {
                        Ok(value) => Ok(value.clone()),
                        Err(error) => Err(error.clone()),
                    }
                }
                _ => Err(format!("unexpected RPC method {method}")),
            }
        }
    }

    async fn run_fake_probe(
        rpc: Arc<FakeRpc>,
        timeout: Duration,
        poll_interval: Duration,
    ) -> Result<Vec<u8>, ProbeFailure> {
        let temporary = tempfile::tempdir().expect("temporary probe storage should exist");
        let metadata_path = temporary.path().join("metadata.torrent");
        tokio::fs::write(&metadata_path, b"torrent metadata")
            .await
            .expect("metadata fixture should be writable");
        run_metadata_probe(
            rpc,
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            Map::new(),
            &metadata_path,
            timeout,
            poll_interval,
        )
        .await
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resolves_active_waiting_complete_and_cleans_the_probe() {
        let rpc = Arc::new(FakeRpc::new(
            [
                FakeRpc::status("active"),
                FakeRpc::status("waiting"),
                FakeRpc::status("complete"),
                FakeRpc::status("removed"),
            ],
            Ok(json!("gid-1")),
        ));
        let bytes = run_fake_probe(Arc::clone(&rpc), Duration::from_secs(1), Duration::ZERO)
            .await
            .expect("complete probe should return metadata");
        assert_eq!(bytes, b"torrent metadata");
        assert_eq!(
            rpc.call_names(),
            vec![
                "aria2.addUri",
                "aria2.tellStatus",
                "aria2.tellStatus",
                "aria2.tellStatus",
                "aria2.forceRemove",
                "aria2.tellStatus",
            ]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn returns_metadata_error_for_failed_status_and_cleans_the_probe() {
        let rpc = Arc::new(FakeRpc::new(
            [FakeRpc::status("error"), FakeRpc::status("removed")],
            Ok(json!("gid-1")),
        ));
        let error = run_fake_probe(Arc::clone(&rpc), Duration::from_secs(1), Duration::ZERO)
            .await
            .expect_err("error status should fail the probe");
        assert!(
            matches!(error, ProbeFailure::Metadata(message) if message.contains("could not resolve"))
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn retries_transient_status_errors_during_metadata_polling() {
        let rpc = Arc::new(FakeRpc::new(
            [
                Err("connection reset by peer".to_string()),
                FakeRpc::status("complete"),
                FakeRpc::status("removed"),
            ],
            Ok(json!("gid-1")),
        ));
        let bytes = run_fake_probe(Arc::clone(&rpc), Duration::from_secs(1), Duration::ZERO)
            .await
            .expect("a transient status error should be retried");
        assert_eq!(bytes, b"torrent metadata");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rejects_a_malformed_status_response_instead_of_waiting_for_timeout() {
        let rpc = Arc::new(FakeRpc::new([Ok(json!({}))], Ok(json!("gid-1"))));
        let error = run_fake_probe(Arc::clone(&rpc), Duration::from_secs(1), Duration::ZERO)
            .await
            .expect_err("a missing status field should fail immediately");
        assert!(matches!(
            error,
            ProbeFailure::Metadata(message)
                if message.contains("invalid metadata probe status")
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn does_not_expose_metadata_path_when_reading_fails() {
        let temporary = tempfile::tempdir().expect("temporary probe storage should exist");
        let metadata_path = temporary.path().join("missing-metadata.torrent");
        let rpc = Arc::new(FakeRpc::new(
            [FakeRpc::status("complete"), FakeRpc::status("removed")],
            Ok(json!("gid-1")),
        ));
        let error = run_metadata_probe(
            Arc::clone(&rpc),
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            Map::new(),
            &metadata_path,
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .await
        .expect_err("missing metadata should fail");
        let ProbeFailure::Metadata(message) = error else {
            panic!("metadata read failure should remain a metadata error");
        };
        assert!(!message.contains(&*temporary.path().to_string_lossy()));
        assert!(message.contains("NotFound"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn redacts_status_rpc_errors_during_cleanup() {
        let rpc = Arc::new(FakeRpc::new(
            [
                FakeRpc::status("complete"),
                Err("token=super-secret-value".to_string()),
            ],
            Ok(json!("gid-1")),
        ));
        let error = run_fake_probe(Arc::clone(&rpc), Duration::from_secs(1), Duration::ZERO)
            .await
            .expect_err("cleanup status failure should be reported");
        let ProbeFailure::Cleanup(message) = error else {
            panic!("cleanup status failure should remain a cleanup error");
        };
        assert!(!message.contains("super-secret-value"));
        assert!(message.contains("[redacted]"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn retries_transient_status_errors_after_force_remove() {
        let rpc = Arc::new(FakeRpc::new(
            [
                FakeRpc::status("complete"),
                Err("connection reset by peer".to_string()),
                FakeRpc::status("removed"),
            ],
            Ok(json!("gid-1")),
        ));
        run_fake_probe(Arc::clone(&rpc), Duration::from_secs(1), Duration::ZERO)
            .await
            .expect("a transient cleanup status error should be retried");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn handles_missing_gid_and_timeout_without_leaking_cleanup() {
        let missing = Arc::new(FakeRpc::new(
            [
                Err("aria2 gid gid-1 not found".to_string()),
                Err("aria2 gid gid-1 not found".to_string()),
            ],
            Err("temporary forceRemove transport failure".to_string()),
        ));
        let missing_error =
            run_fake_probe(Arc::clone(&missing), Duration::from_secs(1), Duration::ZERO)
                .await
                .expect_err("missing gid should fail the probe");
        assert!(
            matches!(missing_error, ProbeFailure::Metadata(message) if message.contains("removed"))
        );

        let timeout = Arc::new(FakeRpc::new(Vec::new(), Ok(json!("gid-1"))));
        let timeout_error = run_fake_probe(
            Arc::clone(&timeout),
            Duration::from_millis(5),
            Duration::from_millis(1),
        )
        .await
        .expect_err("active probe should time out");
        assert!(
            matches!(timeout_error, ProbeFailure::Metadata(message) if message.contains("timed out"))
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn accepts_force_remove_race_only_after_terminal_status() {
        let terminal_race = Arc::new(FakeRpc::new(
            [FakeRpc::status("error"), FakeRpc::status("complete")],
            Err("temporary forceRemove transport failure".to_string()),
        ));
        let error = run_fake_probe(
            Arc::clone(&terminal_race),
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .await
        .expect_err("metadata error should still be returned");
        assert!(
            matches!(error, ProbeFailure::Metadata(message) if message.contains("could not resolve"))
        );

        let active_race = Arc::new(FakeRpc::new(
            [FakeRpc::status("error"), FakeRpc::status("active")],
            Err("temporary forceRemove transport failure".to_string()),
        ));
        let cleanup_error = run_fake_probe(
            Arc::clone(&active_race),
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .await
        .expect_err("active race must report cleanup failure");
        assert!(
            matches!(cleanup_error, ProbeFailure::Cleanup(message) if message.contains("failed to remove"))
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_still_removes_the_remote_gid_and_probe_directory() {
        let temporary = tempfile::tempdir().expect("temporary probe storage should exist");
        let metadata_path = temporary.path().join("metadata.torrent");
        tokio::fs::write(&metadata_path, b"torrent metadata")
            .await
            .expect("metadata fixture should be writable");
        let rpc = Arc::new(FakeRpc::new(Vec::new(), Ok(json!("gid-1"))));
        let probe = run_metadata_probe(
            Arc::clone(&rpc),
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            Map::new(),
            &metadata_path,
            Duration::from_secs(60),
            Duration::from_secs(60),
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), probe)
                .await
                .is_err(),
            "the active probe should be canceled while polling"
        );

        tokio::time::timeout(
            Duration::from_secs(1),
            rpc.wait_for_call("aria2.forceRemove"),
        )
        .await
        .expect("cancellation cleanup should force-remove the GID");
        tokio::time::timeout(Duration::from_secs(1), async {
            while temporary.path().exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancellation cleanup should remove the probe directory");
    }
}

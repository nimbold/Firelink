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

#[allow(dead_code)]
pub(crate) async fn run_metadata_probe<C: RpcClient + 'static>(
    client: Arc<C>,
    source: &str,
    options: Map<String, Value>,
    metadata_path: &Path,
    timeout: Duration,
    poll_interval: Duration,
) -> Result<Vec<u8>, ProbeFailure> {
    let deadline = Instant::now() + timeout;
    run_metadata_probe_with_deadlines(
        client,
        source,
        options,
        metadata_path,
        deadline,
        deadline,
        poll_interval,
    )
    .await
}

/// Run one metadata probe with separate metadata and cleanup deadlines.
///
/// The split is important for resolver fallback: the first resolver gets its
/// own bounded attempt, while cleanup of its GID consumes only the shared
/// operation deadline before a second resolver may be started.
pub(crate) async fn run_metadata_probe_with_deadlines<C: RpcClient + 'static>(
    client: Arc<C>,
    source: &str,
    mut options: Map<String, Value>,
    metadata_path: &Path,
    metadata_deadline: Instant,
    cleanup_deadline: Instant,
    poll_interval: Duration,
) -> Result<Vec<u8>, ProbeFailure> {
    // This probe only resolves magnet metadata. It must never allow Aria2 to
    // interpret a downloaded metadata file as another child download because
    // the probe cleanup guard owns exactly one GID.
    options.insert("follow-torrent".to_string(), json!("false"));
    options.insert("follow-metalink".to_string(), json!("false"));
    let mut cleanup_guard = ProbeCleanupGuard::new(Arc::clone(&client), metadata_path);
    let add_result = tokio::time::timeout(
        metadata_deadline.saturating_duration_since(Instant::now()),
        client.call("aria2.addUri", json!([[source], options])),
    )
    .await;
    let result = match add_result {
        Err(_) => {
            cleanup_guard.disarm();
            return Err(ProbeFailure::Metadata(
                "Aria2 could not start magnet metadata resolution before the resolver attempt deadline"
                    .to_string(),
            ));
        }
        Ok(Err(error)) => {
            cleanup_guard.disarm();
            return Err(ProbeFailure::Metadata(format!(
                "Aria2 could not start magnet metadata resolution: {}",
                crate::redact_sensitive_text(&error)
            )));
        }
        Ok(Ok(result)) => result,
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
        loop {
            let status = match tokio::time::timeout(
                metadata_deadline.saturating_duration_since(Instant::now()),
                client.call(
                    "aria2.tellStatus",
                    json!([&gid, ["status", "errorCode", "errorMessage"]]),
                ),
            )
            .await
            {
                Err(_) => {
                    return Err(ProbeFailure::Metadata(
                        "Aria2 magnet metadata resolution timed out".to_string(),
                    ));
                }
                Ok(Ok(status)) => status,
                Ok(Err(error)) if crate::aria2_gid_not_found(&error) => {
                    return Err(ProbeFailure::Metadata(
                        "Aria2 removed the magnet metadata probe before metadata was saved"
                            .to_string(),
                    ));
                }
                Ok(Err(error)) if crate::retry::is_transient_network_error(&error) => {
                    if Instant::now() >= metadata_deadline {
                        return Err(ProbeFailure::Metadata(format!(
                            "Aria2 metadata resolution status failed: {}",
                            crate::redact_sensitive_text(&error)
                        )));
                    }
                    tokio::time::sleep(
                        poll_interval.min(metadata_deadline.saturating_duration_since(Instant::now())),
                    )
                    .await;
                    continue;
                }
                Ok(Err(error)) => {
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
            if Instant::now() >= metadata_deadline {
                return Err(ProbeFailure::Metadata(
                    "Aria2 magnet metadata resolution timed out".to_string(),
                ));
            }
            tokio::time::sleep(
                poll_interval.min(metadata_deadline.saturating_duration_since(Instant::now())),
            )
            .await;
        }

        let remaining = metadata_deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(remaining, tokio::fs::read(metadata_path)).await {
            Err(_) => Err(ProbeFailure::Metadata(
                "Aria2 magnet metadata file read timed out".to_string(),
            )),
            Ok(Ok(bytes)) => Ok(bytes),
            Ok(Err(error)) => Err(ProbeFailure::Metadata(format!(
                "Aria2 did not save magnet metadata ({:?})",
                error.kind()
            ))),
        }
    }
    .await;

    let cleanup_result = match tokio::time::timeout(
        cleanup_deadline.saturating_duration_since(Instant::now()),
        cleanup_metadata_probe(client.as_ref(), &gid),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(format!(
            "failed to remove aria2 gid {gid} before the metadata operation deadline"
        )),
    };
    if let Err(error) = cleanup_result {
        return Err(ProbeFailure::Cleanup(error));
    }
    cleanup_guard.disarm();
    metadata_result
}

/// Run direct magnet metadata discovery through the system resolver first,
/// then use Aria2's alternate resolver only after the first probe has failed
/// and its GID has been cleaned up. Both attempts share one absolute deadline.
pub(crate) async fn run_metadata_probe_with_resolver_fallback<C: RpcClient + 'static>(
    client: Arc<C>,
    source: &str,
    initial_options: Map<String, Value>,
    metadata_path: &Path,
    initial_resolver_mode: &'static str,
    fallback_to_automatic: bool,
    total_timeout: Duration,
    initial_timeout: Duration,
    poll_interval: Duration,
) -> Result<Vec<u8>, ProbeFailure> {
    let operation_started = Instant::now();
    let operation_deadline = operation_started + total_timeout;
    let initial_deadline = (operation_started + initial_timeout).min(operation_deadline);

    log::debug!(
        "magnet metadata probe [resolver_mode={initial_resolver_mode} outcome=started error_class=none elapsed_ms=0]"
    );
    let first_started = Instant::now();
    let first_result = run_metadata_probe_with_deadlines(
        Arc::clone(&client),
        source,
        initial_options.clone(),
        metadata_path,
        initial_deadline,
        operation_deadline,
        poll_interval,
    )
    .await;
    log_probe_result(initial_resolver_mode, first_started, &first_result);

    let should_try_alternate = initial_resolver_mode == "system"
        && fallback_to_automatic
        && probe_failure_allows_resolver_fallback(&first_result)
        && Instant::now() < operation_deadline;
    if !should_try_alternate {
        return first_result;
    }

    // The first probe has completed its lifecycle cleanup. Remove any
    // partial metadata before reusing the path so a stale result can never be
    // adopted by the alternate resolver.
    let clear_result = match tokio::time::timeout(
        operation_deadline.saturating_duration_since(Instant::now()),
        tokio::fs::remove_file(metadata_path),
    )
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(Err(error)) => Err(format!("filesystem error ({:?})", error.kind())),
        Err(_) => Err("timed out before the metadata operation deadline".to_string()),
    };
    if let Err(error) = clear_result {
        let cleanup_failure = ProbeFailure::Cleanup(format!(
            "could not clear stale magnet metadata before resolver fallback: {error}"
        ));
        log::debug!(
            "magnet metadata probe [resolver_mode=automatic outcome=cleanup-failure error_class=cleanup elapsed_ms={}]",
            Instant::now().duration_since(operation_started).as_millis()
        );
        return Err(cleanup_failure);
    }

    let mut alternate_options = initial_options;
    alternate_options.remove("async-dns");
    log::debug!(
        "magnet metadata probe [resolver_mode=automatic outcome=started error_class=none elapsed_ms={}]",
        operation_started.elapsed().as_millis()
    );
    let alternate_started = Instant::now();
    let alternate_result = run_metadata_probe_with_deadlines(
        client,
        source,
        alternate_options,
        metadata_path,
        operation_deadline,
        operation_deadline,
        poll_interval,
    )
    .await;
    log_probe_result("automatic", alternate_started, &alternate_result);
    alternate_result
}

fn probe_failure_allows_resolver_fallback(result: &Result<Vec<u8>, ProbeFailure>) -> bool {
    let Err(ProbeFailure::Metadata(error)) = result else {
        return false;
    };
    // An alternate resolver can only repair a resolver-owned failure. Keep
    // malformed metadata, missing output, daemon/status errors, cancellation,
    // and every cleanup uncertainty on the original result. The generic
    // operation timeout is emitted only by the bounded add/status polling
    // path; file-read and addUri-start deadlines use distinct messages so an
    // uncertain GID is never duplicated by a fallback attempt.
    crate::retry::is_aria2_name_resolution_error(error)
        || error == "Aria2 magnet metadata resolution timed out"
}

fn log_probe_result(
    resolver_mode: &str,
    started: Instant,
    result: &Result<Vec<u8>, ProbeFailure>,
) {
    let (outcome, error_class) = match result {
        Ok(_) => ("probe-success", "none"),
        Err(ProbeFailure::Metadata(error)) => ("metadata-failure", probe_error_class(error)),
        Err(ProbeFailure::Cleanup(error)) => ("cleanup-failure", probe_error_class(error)),
    };
    log::debug!(
        "magnet metadata probe [resolver_mode={resolver_mode} outcome={outcome} error_class={error_class} elapsed_ms={}]",
        started.elapsed().as_millis()
    );
}

fn probe_error_class(error: &str) -> &'static str {
    let lower = error.to_ascii_lowercase();
    if lower.contains("cleanup") || lower.contains("remove aria2 gid") {
        "cleanup"
    } else if lower.contains("timed out") || lower.contains("timeout") {
        "timeout"
    } else if lower.contains("dns") || lower.contains("name resolution") {
        "name_resolution"
    } else if lower.contains("metadata") || lower.contains("torrent") {
        "metadata"
    } else {
        "probe"
    }
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
    use axum::{
        body::Body,
        extract::State,
        http::StatusCode,
        response::{IntoResponse, Response},
        routing::post,
        Json, Router,
    };
    use std::collections::HashMap;
    use std::collections::VecDeque;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tokio::sync::{oneshot, watch, Notify};

    enum ScriptedReply {
        Result(Value),
        RpcError(String),
        HttpError(StatusCode, String),
        Malformed(String),
        Delay(Duration, Box<ScriptedReply>),
        Hang,
    }

    struct RecordedCall {
        method: String,
        params: Value,
    }

    struct ScriptedRpcState {
        secret: String,
        scripts: Mutex<HashMap<String, VecDeque<ScriptedReply>>>,
        calls: Mutex<Vec<RecordedCall>>,
        call_notification: Notify,
        termination: watch::Sender<bool>,
    }

    struct ScriptedRpcServer {
        address: SocketAddr,
        state: Arc<ScriptedRpcState>,
        shutdown: Option<oneshot::Sender<()>>,
        task: Option<tokio::task::JoinHandle<()>>,
    }

    impl ScriptedRpcServer {
        async fn start(scripts: impl IntoIterator<Item = (String, Vec<ScriptedReply>)>) -> Self {
            let secret = "torrent-probe-test-secret".to_string();
            let (termination, _) = watch::channel(false);
            let state = Arc::new(ScriptedRpcState {
                secret: secret.clone(),
                scripts: Mutex::new(
                    scripts
                        .into_iter()
                        .map(|(method, replies)| (method, replies.into_iter().collect()))
                        .collect(),
                ),
                calls: Mutex::new(Vec::new()),
                call_notification: Notify::new(),
                termination,
            });
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("scripted RPC listener should bind");
            let address = listener
                .local_addr()
                .expect("scripted RPC listener should have an address");
            let app = Router::new()
                .route("/jsonrpc", post(scripted_rpc_handler))
                .with_state(Arc::clone(&state));
            let (shutdown, shutdown_signal) = oneshot::channel();
            let task = tokio::spawn(async move {
                let _ = axum::serve(listener, app)
                    .with_graceful_shutdown(async {
                        let _ = shutdown_signal.await;
                    })
                    .await;
            });
            Self {
                address,
                state,
                shutdown: Some(shutdown),
                task: Some(task),
            }
        }

        fn client(&self) -> Arc<crate::Aria2RpcClient> {
            Arc::new(crate::Aria2RpcClient {
                port: self.address.port(),
                secret: self.state.secret.clone(),
            })
        }

        fn calls(&self) -> Vec<(String, Value)> {
            self.state
                .calls
                .lock()
                .expect("scripted RPC call log lock should work")
                .iter()
                .map(|call| (call.method.clone(), call.params.clone()))
                .collect()
        }

        async fn wait_for_method(&self, method: &str, occurrence: usize) {
            loop {
                let count = self
                    .state
                    .calls
                    .lock()
                    .expect("scripted RPC call log lock should work")
                    .iter()
                    .filter(|call| call.method == method)
                    .count();
                if count >= occurrence {
                    return;
                }
                self.state.call_notification.notified().await;
            }
        }

        async fn shutdown(mut self) {
            self.state.termination.send_replace(true);
            if let Some(shutdown) = self.shutdown.take() {
                let _ = shutdown.send(());
            }
            if let Some(task) = self.task.take() {
                task.await.expect("scripted RPC server should stop cleanly");
            }
        }

        async fn terminate(mut self) {
            self.state.termination.send_replace(true);
            if let Some(shutdown) = self.shutdown.take() {
                let _ = shutdown.send(());
            }
            if let Some(mut task) = self.task.take() {
                match tokio::time::timeout(Duration::from_secs(1), &mut task).await {
                    Ok(result) => {
                        let _ = result;
                    }
                    Err(_) => {
                        task.abort();
                        let _ = task.await;
                    }
                }
            }
        }
    }

    impl Drop for ScriptedRpcServer {
        fn drop(&mut self) {
            self.state.termination.send_replace(true);
            if let Some(task) = self.task.take() {
                task.abort();
            }
        }
    }

    async fn scripted_rpc_handler(
        State(state): State<Arc<ScriptedRpcState>>,
        Json(request): Json<Value>,
    ) -> Response {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("<missing-method>")
            .to_string();
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        state
            .calls
            .lock()
            .expect("scripted RPC call log lock should work")
            .push(RecordedCall {
                method: method.clone(),
                params: params.clone(),
            });
        state.call_notification.notify_waiters();

        let token = params
            .as_array()
            .and_then(|params| params.first())
            .and_then(Value::as_str);
        let expected_token = format!("token:{}", state.secret);
        if token != Some(expected_token.as_str()) {
            return rpc_error_response(
                id,
                StatusCode::UNAUTHORIZED,
                "invalid RPC token".to_string(),
            );
        }

        let reply = state
            .scripts
            .lock()
            .expect("scripted RPC scripts lock should work")
            .get_mut(&method)
            .and_then(VecDeque::pop_front)
            .unwrap_or_else(|| {
                ScriptedReply::RpcError(format!("unexpected scripted RPC method {method}"))
            });
        scripted_reply_response(id, reply, state.termination.subscribe()).await
    }

    async fn scripted_reply_response(
        id: Value,
        mut reply: ScriptedReply,
        mut termination: watch::Receiver<bool>,
    ) -> Response {
        loop {
            if *termination.borrow() {
                return terminated_response();
            }
            match reply {
                ScriptedReply::Delay(delay, next) => {
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => reply = *next,
                        _ = termination.changed() => return terminated_response(),
                    }
                }
                ScriptedReply::Hang => {
                    let _ = termination.changed().await;
                    return terminated_response();
                }
                ScriptedReply::Result(result) => {
                    return Json(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": result,
                    }))
                    .into_response();
                }
                ScriptedReply::RpcError(message) => {
                    return rpc_error_response(id, StatusCode::OK, message);
                }
                ScriptedReply::HttpError(status, message) => {
                    return rpc_error_response(id, status, message);
                }
                ScriptedReply::Malformed(body) => {
                    return (StatusCode::OK, Body::from(body)).into_response();
                }
            }
        }
    }

    fn terminated_response() -> Response {
        (StatusCode::OK, Body::empty()).into_response()
    }

    fn rpc_error_response(id: Value, status: StatusCode, message: String) -> Response {
        (
            status,
            Json(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": 1, "message": message },
            })),
        )
            .into_response()
    }

    fn scripts(
        entries: impl IntoIterator<Item = (&'static str, Vec<ScriptedReply>)>,
    ) -> Vec<(String, Vec<ScriptedReply>)> {
        entries
            .into_iter()
            .map(|(method, replies)| (method.to_string(), replies))
            .collect()
    }

    async fn probe_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temporary = tempfile::tempdir().expect("temporary probe storage should exist");
        let probe_dir = temporary.path().join("probe");
        tokio::fs::create_dir(&probe_dir)
            .await
            .expect("probe directory should be created");
        let metadata_path = probe_dir.join("metadata.torrent");
        tokio::fs::write(&metadata_path, b"torrent metadata")
            .await
            .expect("metadata fixture should be writable");
        (temporary, probe_dir, metadata_path)
    }

    async fn wait_for_path(path: &Path, should_exist: bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if path.exists() == should_exist {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            path.exists(),
            should_exist,
            "path state did not become {}: {}",
            should_exist,
            path.display()
        );
    }

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

    fn status_reply(status: &str) -> ScriptedReply {
        ScriptedReply::Result(json!({ "status": status }))
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resolver_fallback_cleans_the_first_gid_and_rejects_stale_metadata() {
        let server = ScriptedRpcServer::start(scripts([
            (
                "aria2.addUri",
                vec![
                    ScriptedReply::Result(json!("gid-1")),
                    ScriptedReply::Delay(
                        Duration::from_millis(50),
                        Box::new(ScriptedReply::Result(json!("gid-2"))),
                    ),
                ],
            ),
            (
                "aria2.tellStatus",
                vec![
                    ScriptedReply::Result(json!({
                        "status": "error",
                        "errorCode": "19",
                        "errorMessage": "Name resolution failed",
                    })),
                    status_reply("removed"),
                    status_reply("complete"),
                    status_reply("removed"),
                ],
            ),
            (
                "aria2.forceRemove",
                vec![
                    ScriptedReply::Result(json!("gid-1")),
                    ScriptedReply::Result(json!("gid-2")),
                ],
            ),
        ]))
        .await;
        let (_temporary, probe_dir, metadata_path) = probe_fixture().await;
        let probe_path = metadata_path.clone();
        let client = server.client();
        let task = tokio::spawn(async move {
            let mut options = Map::new();
            options.insert("async-dns".to_string(), json!("false"));
            run_metadata_probe_with_resolver_fallback(
                client,
                "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
                options,
                &probe_path,
                "system",
                true,
                Duration::from_secs(2),
                Duration::from_millis(200),
                Duration::ZERO,
            )
            .await
        });

        server.wait_for_method("aria2.addUri", 2).await;
        assert!(
            !metadata_path.exists(),
            "the first probe's stale metadata must be removed before fallback"
        );
        tokio::fs::write(&metadata_path, b"metadata from alternate resolver")
            .await
            .expect("alternate metadata fixture should be writable");
        let bytes = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("resolver fallback should remain bounded")
            .expect("resolver fallback task should not panic")
            .expect("alternate resolver should complete the probe");
        assert_eq!(bytes, b"metadata from alternate resolver");

        let calls = server.calls();
        let add_calls = calls
            .iter()
            .filter(|(method, _)| method == "aria2.addUri")
            .collect::<Vec<_>>();
        assert_eq!(add_calls.len(), 2);
        let first_options = add_calls[0]
            .1
            .as_array()
            .and_then(|params| params.get(2))
            .and_then(Value::as_object)
            .expect("first addUri options should be recorded");
        assert_eq!(first_options.get("async-dns"), Some(&json!("false")));
        let alternate_options = add_calls[1]
            .1
            .as_array()
            .and_then(|params| params.get(2))
            .and_then(Value::as_object)
            .expect("alternate addUri options should be recorded");
        assert!(!alternate_options.contains_key("async-dns"));

        let first_force_remove = calls
            .iter()
            .position(|(method, _)| method == "aria2.forceRemove")
            .expect("first probe must be cleaned up");
        let second_add = calls
            .iter()
            .rposition(|(method, _)| method == "aria2.addUri")
            .expect("alternate probe must be started");
        assert!(
            first_force_remove < second_add,
            "alternate probing must wait for first-GID cleanup"
        );
        assert_eq!(
            calls
                .iter()
                .filter(|(method, _)| method == "aria2.forceRemove")
                .count(),
            2
        );

        tokio::fs::remove_dir_all(&probe_dir)
            .await
            .expect("successful fallback fixture should be removable");
        server.shutdown().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resolver_fallback_does_not_repeat_invalid_metadata_failures() {
        let server = ScriptedRpcServer::start(scripts([
            ("aria2.addUri", vec![ScriptedReply::Result(json!("gid-1"))]),
            (
                "aria2.tellStatus",
                vec![
                    ScriptedReply::Result(json!({
                        "status": "error",
                        "errorCode": "1",
                        "errorMessage": "tracker rejected metadata",
                    })),
                    status_reply("removed"),
                ],
            ),
            (
                "aria2.forceRemove",
                vec![ScriptedReply::Result(json!("gid-1"))],
            ),
        ]))
        .await;
        let (_temporary, probe_dir, metadata_path) = probe_fixture().await;
        let error = run_metadata_probe_with_resolver_fallback(
            server.client(),
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            Map::new(),
            &metadata_path,
            "system",
            true,
            Duration::from_secs(1),
            Duration::from_millis(100),
            Duration::ZERO,
        )
        .await
        .expect_err("invalid metadata failure should remain on the initial route");
        assert!(matches!(error, ProbeFailure::Metadata(message) if message.contains("could not resolve")));
        assert_eq!(
            server
                .calls()
                .iter()
                .filter(|(method, _)| method == "aria2.addUri")
                .count(),
            1
        );
        tokio::fs::remove_dir_all(&probe_dir)
            .await
            .expect("failed probe fixture should be removable");
        server.shutdown().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resolver_fallback_does_not_run_after_cleanup_uncertainty() {
        let server = ScriptedRpcServer::start(scripts([
            ("aria2.addUri", vec![ScriptedReply::Result(json!("gid-1"))]),
            (
                "aria2.tellStatus",
                vec![
                    ScriptedReply::Result(json!({
                        "status": "error",
                        "errorCode": "19",
                        "errorMessage": "Name resolution failed",
                    })),
                    status_reply("active"),
                ],
            ),
            (
                "aria2.forceRemove",
                vec![ScriptedReply::RpcError("temporary cleanup failure".to_string())],
            ),
        ]))
        .await;
        let (_temporary, probe_dir, metadata_path) = probe_fixture().await;
        let error = run_metadata_probe_with_resolver_fallback(
            server.client(),
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            Map::new(),
            &metadata_path,
            "system",
            true,
            Duration::from_secs(1),
            Duration::from_millis(100),
            Duration::ZERO,
        )
        .await
        .expect_err("cleanup uncertainty must stop resolver fallback");
        assert!(matches!(error, ProbeFailure::Cleanup(_)));
        assert_eq!(
            server
                .calls()
                .iter()
                .filter(|(method, _)| method == "aria2.addUri")
                .count(),
            1
        );
        tokio::fs::remove_dir_all(&probe_dir)
            .await
            .expect("uncertain probe fixture should be removable by the test");
        server.shutdown().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resolver_fallback_is_not_started_after_cancellation() {
        let server = ScriptedRpcServer::start(scripts([
            ("aria2.addUri", vec![ScriptedReply::Result(json!("gid-1"))]),
            (
                "aria2.tellStatus",
                vec![ScriptedReply::Hang, status_reply("removed")],
            ),
            (
                "aria2.forceRemove",
                vec![ScriptedReply::Result(json!("gid-1"))],
            ),
        ]))
        .await;
        let (_temporary, probe_dir, metadata_path) = probe_fixture().await;
        let probe_path = metadata_path.clone();
        let client = server.client();
        let task = tokio::spawn(async move {
            run_metadata_probe_with_resolver_fallback(
                client,
                "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
                Map::new(),
                &probe_path,
                "system",
                true,
                Duration::from_secs(60),
                Duration::from_secs(20),
                Duration::from_secs(60),
            )
            .await
        });
        server.wait_for_method("aria2.tellStatus", 1).await;
        task.abort();
        let _ = task.await;
        server.wait_for_method("aria2.forceRemove", 1).await;
        assert_eq!(
            server
                .calls()
                .iter()
                .filter(|(method, _)| method == "aria2.addUri")
                .count(),
            1,
            "cancellation must not start the alternate resolver"
        );
        wait_for_path(&probe_dir, false).await;
        server.terminate().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn http_rpc_harness_exercises_production_client_and_status_order() {
        let server = ScriptedRpcServer::start(scripts([
            ("aria2.addUri", vec![ScriptedReply::Result(json!("gid-1"))]),
            (
                "aria2.tellStatus",
                vec![
                    status_reply("active"),
                    status_reply("waiting"),
                    status_reply("paused"),
                    status_reply("complete"),
                    status_reply("removed"),
                ],
            ),
            (
                "aria2.forceRemove",
                vec![ScriptedReply::Result(json!("gid-1"))],
            ),
        ]))
        .await;
        let (_temporary, probe_dir, metadata_path) = probe_fixture().await;
        let mut options = Map::new();
        options.insert("bt-metadata-only".to_string(), json!("true"));
        options.insert("bt-save-metadata".to_string(), json!("true"));
        let bytes = run_metadata_probe(
            server.client(),
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            options,
            &metadata_path,
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .await
        .expect("HTTP-backed metadata probe should resolve");

        assert_eq!(bytes, b"torrent metadata");
        let calls = server.calls();
        assert_eq!(
            calls
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            vec![
                "aria2.addUri",
                "aria2.tellStatus",
                "aria2.tellStatus",
                "aria2.tellStatus",
                "aria2.tellStatus",
                "aria2.forceRemove",
                "aria2.tellStatus",
            ]
        );
        assert!(calls.iter().all(|(_, params)| {
            params
                .as_array()
                .and_then(|params| params.first())
                .and_then(Value::as_str)
                == Some("token:torrent-probe-test-secret")
        }));
        let add_params = calls[0]
            .1
            .as_array()
            .expect("addUri params should be an array");
        assert_eq!(
            add_params[1],
            json!(["magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"])
        );
        let options = add_params[2]
            .as_object()
            .expect("addUri options should be an object");
        assert_eq!(
            options.get("bt-metadata-only"),
            Some(&json!("true")),
            "recorded addUri params: {add_params:?}"
        );
        assert_eq!(
            options.get("bt-save-metadata"),
            Some(&json!("true")),
            "recorded addUri params: {add_params:?}"
        );
        assert_eq!(
            options.get("follow-torrent"),
            Some(&json!("false")),
            "recorded addUri params: {add_params:?}"
        );
        assert_eq!(
            options.get("follow-metalink"),
            Some(&json!("false")),
            "recorded addUri params: {add_params:?}"
        );
        tokio::fs::remove_dir_all(&probe_dir)
            .await
            .expect("successful probe fixture should be removable");
        server.shutdown().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn http_rpc_harness_reports_add_uri_failure_without_fabricating_cleanup() {
        let server = ScriptedRpcServer::start(scripts([(
            "aria2.addUri",
            vec![ScriptedReply::HttpError(
                StatusCode::SERVICE_UNAVAILABLE,
                "daemon is starting".to_string(),
            )],
        )]))
        .await;
        let (_temporary, probe_dir, metadata_path) = probe_fixture().await;
        let error = run_metadata_probe(
            server.client(),
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            Map::new(),
            &metadata_path,
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .await
        .expect_err("addUri failure should fail metadata resolution");
        assert!(matches!(
            error,
            ProbeFailure::Metadata(message) if message.contains("could not start")
        ));
        assert_eq!(
            server
                .calls()
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            vec!["aria2.addUri"]
        );
        assert!(probe_dir.exists());
        server.shutdown().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn http_rpc_harness_covers_terminal_malformed_and_missing_gid_statuses() {
        for (initial_status, expected_message) in [
            (
                ScriptedReply::Result(json!({
                    "status": "error",
                    "errorCode": "19",
                    "errorMessage": "tracker rejected metadata",
                })),
                "could not resolve",
            ),
            (status_reply("removed"), "could not resolve"),
            (
                ScriptedReply::Result(json!({ "unexpected": "shape" })),
                "invalid metadata probe status",
            ),
            (ScriptedReply::Malformed("{".to_string()), "status failed"),
        ] {
            let server = ScriptedRpcServer::start(scripts([
                ("aria2.addUri", vec![ScriptedReply::Result(json!("gid-1"))]),
                (
                    "aria2.tellStatus",
                    vec![initial_status, status_reply("removed")],
                ),
                (
                    "aria2.forceRemove",
                    vec![ScriptedReply::Result(json!("gid-1"))],
                ),
            ]))
            .await;
            let (_temporary, _probe_dir, metadata_path) = probe_fixture().await;
            let error = run_metadata_probe(
                server.client(),
                "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
                Map::new(),
                &metadata_path,
                Duration::from_secs(1),
                Duration::ZERO,
            )
            .await
            .expect_err("terminal or malformed status should fail the probe");
            assert!(matches!(
                error,
                ProbeFailure::Metadata(message) if message.contains(expected_message)
            ));
            server.shutdown().await;
        }

        let server = ScriptedRpcServer::start(scripts([
            ("aria2.addUri", vec![ScriptedReply::Result(json!("gid-1"))]),
            (
                "aria2.tellStatus",
                vec![ScriptedReply::RpcError("gid gid-1 not found".to_string())],
            ),
            (
                "aria2.forceRemove",
                vec![ScriptedReply::RpcError("gid gid-1 not found".to_string())],
            ),
        ]))
        .await;
        let (_temporary, _probe_dir, metadata_path) = probe_fixture().await;
        let error = run_metadata_probe(
            server.client(),
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            Map::new(),
            &metadata_path,
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .await
        .expect_err("a missing GID should fail metadata resolution");
        assert!(matches!(
            error,
            ProbeFailure::Metadata(message) if message.contains("removed")
        ));
        assert_eq!(
            server
                .calls()
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            vec!["aria2.addUri", "aria2.tellStatus", "aria2.forceRemove"]
        );
        server.shutdown().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn http_rpc_harness_retries_polling_and_force_remove_outages() {
        let server = ScriptedRpcServer::start(scripts([
            ("aria2.addUri", vec![ScriptedReply::Result(json!("gid-1"))]),
            (
                "aria2.tellStatus",
                vec![
                    ScriptedReply::HttpError(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "temporary polling outage".to_string(),
                    ),
                    status_reply("complete"),
                    status_reply("removed"),
                ],
            ),
            (
                "aria2.forceRemove",
                vec![ScriptedReply::Result(json!("gid-1"))],
            ),
        ]))
        .await;
        let (_temporary, probe_dir, metadata_path) = probe_fixture().await;
        run_metadata_probe(
            server.client(),
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            Map::new(),
            &metadata_path,
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .await
        .expect("a transient polling outage should be retried");
        assert_eq!(
            server
                .calls()
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            vec![
                "aria2.addUri",
                "aria2.tellStatus",
                "aria2.tellStatus",
                "aria2.forceRemove",
                "aria2.tellStatus",
            ]
        );
        tokio::fs::remove_dir_all(&probe_dir)
            .await
            .expect("successful probe fixture should be removable");
        server.shutdown().await;

        let server = ScriptedRpcServer::start(scripts([
            ("aria2.addUri", vec![ScriptedReply::Result(json!("gid-1"))]),
            (
                "aria2.tellStatus",
                vec![status_reply("complete"), status_reply("complete")],
            ),
            (
                "aria2.forceRemove",
                vec![ScriptedReply::HttpError(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "temporary cleanup outage".to_string(),
                )],
            ),
        ]))
        .await;
        let (_temporary, probe_dir, metadata_path) = probe_fixture().await;
        run_metadata_probe(
            server.client(),
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            Map::new(),
            &metadata_path,
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .await
        .expect("a completion race after forceRemove should be accepted");
        assert_eq!(
            server
                .calls()
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            vec![
                "aria2.addUri",
                "aria2.tellStatus",
                "aria2.forceRemove",
                "aria2.tellStatus",
            ]
        );
        tokio::fs::remove_dir_all(&probe_dir)
            .await
            .expect("successful probe fixture should be removable");
        server.shutdown().await;

        let server = ScriptedRpcServer::start(scripts([
            ("aria2.addUri", vec![ScriptedReply::Result(json!("gid-1"))]),
            (
                "aria2.tellStatus",
                vec![
                    status_reply("complete"),
                    status_reply("active"),
                    status_reply("active"),
                    status_reply("removed"),
                ],
            ),
            (
                "aria2.forceRemove",
                vec![
                    ScriptedReply::HttpError(
                        StatusCode::BAD_GATEWAY,
                        "temporary gateway outage".to_string(),
                    ),
                    ScriptedReply::RpcError("connection reset by peer".to_string()),
                    ScriptedReply::Result(json!("gid-1")),
                ],
            ),
        ]))
        .await;
        let (_temporary, probe_dir, metadata_path) = probe_fixture().await;
        let error = run_metadata_probe(
            server.client(),
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            Map::new(),
            &metadata_path,
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .await
        .expect_err("cleanup must report an unverified active GID");
        assert!(matches!(error, ProbeFailure::Cleanup(_)));
        server.wait_for_method("aria2.forceRemove", 3).await;
        wait_for_path(&probe_dir, false).await;
        server.shutdown().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn http_rpc_harness_covers_cancellation_before_and_after_gid_assignment() {
        let server = ScriptedRpcServer::start(scripts([(
            "aria2.addUri",
            vec![ScriptedReply::Delay(
                Duration::from_millis(250),
                Box::new(ScriptedReply::Result(json!("gid-1"))),
            )],
        )]))
        .await;
        let (_temporary, probe_dir, metadata_path) = probe_fixture().await;
        let probe_path = metadata_path.clone();
        let client = server.client();
        let task = tokio::spawn(async move {
            run_metadata_probe(
                client,
                "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
                Map::new(),
                &probe_path,
                Duration::from_secs(60),
                Duration::from_secs(60),
            )
            .await
        });
        server.wait_for_method("aria2.addUri", 1).await;
        task.abort();
        let _ = task.await;
        wait_for_path(&probe_dir, false).await;
        server.shutdown().await;

        let server = ScriptedRpcServer::start(scripts([
            ("aria2.addUri", vec![ScriptedReply::Result(json!("gid-1"))]),
            (
                "aria2.tellStatus",
                vec![ScriptedReply::Hang, status_reply("removed")],
            ),
            (
                "aria2.forceRemove",
                vec![ScriptedReply::Result(json!("gid-1"))],
            ),
        ]))
        .await;
        let (_temporary, probe_dir, metadata_path) = probe_fixture().await;
        let probe_path = metadata_path.clone();
        let client = server.client();
        let task = tokio::spawn(async move {
            run_metadata_probe(
                client,
                "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
                Map::new(),
                &probe_path,
                Duration::from_secs(60),
                Duration::from_secs(60),
            )
            .await
        });
        server.wait_for_method("aria2.tellStatus", 1).await;
        task.abort();
        let _ = task.await;
        server.wait_for_method("aria2.forceRemove", 1).await;
        wait_for_path(&probe_dir, false).await;
        server.terminate().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn http_rpc_harness_retains_probe_when_daemon_shuts_down_during_resolution_or_cleanup() {
        let server = ScriptedRpcServer::start(scripts([
            ("aria2.addUri", vec![ScriptedReply::Result(json!("gid-1"))]),
            (
                "aria2.tellStatus",
                vec![ScriptedReply::Delay(
                    Duration::from_millis(250),
                    Box::new(status_reply("active")),
                )],
            ),
        ]))
        .await;
        let (_temporary, probe_dir, metadata_path) = probe_fixture().await;
        let probe_path = metadata_path.clone();
        let client = server.client();
        let task = tokio::spawn(async move {
            run_metadata_probe(
                client,
                "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
                Map::new(),
                &probe_path,
                Duration::from_millis(40),
                Duration::from_millis(5),
            )
            .await
        });
        server.wait_for_method("aria2.tellStatus", 1).await;
        server.terminate().await;
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("probe should finish after daemon shutdown")
            .expect("probe task should not panic")
            .expect_err("daemon shutdown should not report metadata success");
        assert!(matches!(result, ProbeFailure::Cleanup(_)));
        assert!(probe_dir.exists());

        let server = ScriptedRpcServer::start(scripts([
            ("aria2.addUri", vec![ScriptedReply::Result(json!("gid-1"))]),
            ("aria2.tellStatus", vec![status_reply("complete")]),
            (
                "aria2.forceRemove",
                vec![ScriptedReply::Delay(
                    Duration::from_secs(1),
                    Box::new(ScriptedReply::Result(json!("gid-1"))),
                )],
            ),
        ]))
        .await;
        let (_temporary, probe_dir, metadata_path) = probe_fixture().await;
        let probe_path = metadata_path.clone();
        let client = server.client();
        let task = tokio::spawn(async move {
            run_metadata_probe(
                client,
                "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
                Map::new(),
                &probe_path,
                Duration::from_secs(1),
                Duration::ZERO,
            )
            .await
        });
        server.wait_for_method("aria2.forceRemove", 1).await;
        server.terminate().await;
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("cleanup should finish after daemon shutdown")
            .expect("cleanup task should not panic")
            .expect_err("daemon shutdown should report cleanup uncertainty");
        assert!(matches!(result, ProbeFailure::Cleanup(_)));
        assert!(probe_dir.exists());
    }
}

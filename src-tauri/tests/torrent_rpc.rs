use axum::{extract::Json, http::StatusCode, response::IntoResponse, routing::post, Router};
use firelink_lib::rpc_call;
use serde_json::{json, Value};
use std::net::SocketAddr;
use tokio::sync::oneshot;

async fn start_server(
    app: Router,
) -> (SocketAddr, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("RPC test server should bind");
    let address = listener
        .local_addr()
        .expect("RPC test server should have an address");
    let (shutdown, shutdown_signal) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_signal.await;
            })
            .await
            .expect("RPC test server should stop cleanly");
    });
    (address, shutdown, task)
}

struct TestResponse(StatusCode, Value);

impl IntoResponse for TestResponse {
    fn into_response(self) -> axum::response::Response {
        (self.0, Json(self.1)).into_response()
    }
}

async fn successful_rpc(Json(request): Json<Value>) -> TestResponse {
    assert_eq!(request.get("jsonrpc"), Some(&json!("2.0")));
    assert_eq!(request.get("id"), Some(&json!("1")));
    assert_eq!(request.get("method"), Some(&json!("aria2.getVersion")));
    assert_eq!(
        request.get("params"),
        Some(&json!(["token:test-secret", {"include": "version"}]))
    );
    TestResponse(
        StatusCode::OK,
        json!({"jsonrpc": "2.0", "id": "1", "result": {"version": "test"}}),
    )
}

async fn gateway_error(Json(_request): Json<Value>) -> TestResponse {
    TestResponse(
        StatusCode::BAD_GATEWAY,
        json!({"jsonrpc": "2.0", "id": "1", "error": {"code": 1, "message": "backend unavailable"}}),
    )
}

async fn stop_server(shutdown: oneshot::Sender<()>, task: tokio::task::JoinHandle<()>) {
    let _ = shutdown.send(());
    task.await.expect("RPC test server task should join");
}

#[tokio::test]
async fn production_rpc_client_sends_authenticated_json_rpc() {
    let app = Router::new().route("/jsonrpc", post(successful_rpc));
    let (address, shutdown, task) = start_server(app).await;
    let result = rpc_call(
        address.port(),
        "test-secret",
        "aria2.getVersion",
        json!([{"include": "version"}]),
    )
    .await
    .expect("successful RPC response should decode");

    assert_eq!(result, json!({"version": "test"}));
    stop_server(shutdown, task).await;
}

#[tokio::test]
async fn production_rpc_client_preserves_http_gateway_context() {
    let app = Router::new().route("/jsonrpc", post(gateway_error));
    let (address, shutdown, task) = start_server(app).await;
    let error = rpc_call(address.port(), "test-secret", "aria2.getVersion", json!([]))
        .await
        .expect_err("gateway response should fail");

    assert!(
        error.contains("HTTP 502 Bad Gateway"),
        "unexpected error: {error}"
    );
    assert!(
        error.contains("backend unavailable"),
        "unexpected error: {error}"
    );
    stop_server(shutdown, task).await;
}

#[tokio::test]
async fn production_rpc_client_bypasses_environment_proxy() {
    let app = Router::new().route("/jsonrpc", post(successful_rpc));
    let (address, shutdown, task) = start_server(app).await;

    // Even if an invalid or hostile HTTP proxy is set in the environment,
    // loopback JSON-RPC calls must bypass the proxy and connect directly to loopback.
    struct EnvGuard(&'static str, Option<String>);
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.1 {
                Some(val) => std::env::set_var(self.0, val),
                None => std::env::remove_var(self.0),
            }
        }
    }
    let _guard = EnvGuard("HTTP_PROXY", std::env::var("HTTP_PROXY").ok());
    std::env::set_var("HTTP_PROXY", "http://192.0.2.1:8080");

    let result = rpc_call(
        address.port(),
        "test-secret",
        "aria2.getVersion",
        json!([{"include": "version"}]),
    )
    .await
    .expect("RPC client must bypass HTTP_PROXY and succeed over loopback");

    assert_eq!(result, json!({"version": "test"}));
    stop_server(shutdown, task).await;
}

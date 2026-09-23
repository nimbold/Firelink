use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header::HeaderName},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Router,
};
use base64::Engine as _;
use hmac::{Hmac, KeyInit, Mac};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, watch};
use tower_http::{
    cors::{Any, CorsLayer},
    limit::RequestBodyLimitLayer,
};
use ts_rs::TS;

pub const EXTENSION_SERVER_PORT: u16 = 6412;
pub const EXTENSION_SERVER_PORT_RANGE: std::ops::RangeInclusive<u16> = EXTENSION_SERVER_PORT..=6422;
const MAX_URL_COUNT: usize = 200;
const MAX_NON_TORRENT_REQUEST_BODY_BYTES: usize = 256 * 1024;
const MAX_MEDIA_HEADER_LINES: usize = 32;
const MAX_MEDIA_HEADER_NAME_BYTES: usize = 128;
const MAX_MEDIA_HEADER_VALUE_BYTES: usize = 8 * 1024;
const MAX_MEDIA_HEADERS_BYTES: usize = 16 * 1024;
const MAX_MEDIA_REFERER_BYTES: usize = 4 * 1024;
const MAX_ENCODED_TORRENT_BYTES: usize =
    ((crate::torrent::MAX_TORRENT_BYTES + 2) / 3) * 4;
const MAX_REQUEST_BODY_BYTES: usize =
    MAX_ENCODED_TORRENT_BYTES + MAX_NON_TORRENT_REQUEST_BODY_BYTES;
const SIGNATURE_MAX_AGE_MS: u64 = 60_000;
const SERVER_HEADER: &str = "x-firelink-server";
const PROTOCOL_VERSION_HEADER: &str = "x-firelink-protocol-version";
const CLIENT_NONCE_HEADER: &str = "x-firelink-client-nonce";
const SERVER_SESSION_HEADER: &str = "x-firelink-server-session";
const SESSION_BINDING_HEADER: &str = "x-firelink-session-binding";
const SERVER_PROOF_HEADER: &str = "x-firelink-server-proof";
const SERVER_PORT_HEADER: &str = "x-firelink-server-port";
const SMOKE_PROCESS_ID_HEADER: &str = "x-firelink-smoke-process-id";
const SERVER_PROOF_PREFIX: &[u8] = b"firelink-server-proof\n";
const PROTOCOL_VERSION: &str = "7";
const MEDIA_HANDOFF_PROTOCOL_VERSION: u16 = 7;
const MAX_MEDIA_HANDOFF_ID_BYTES: usize = 128;
const MAX_ACTIVE_MEDIA_HANDOFFS: usize = 64;
const MEDIA_HANDOFF_TTL: Duration = Duration::from_secs(30);
const MEDIA_DISCOVERY_ATTEMPT_TTL: Duration = Duration::from_secs(10);
const MAX_PENDING_EXTENSION_ACKS: usize = 64;
const EXTENSION_ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

type HmacSha256 = Hmac<Sha256>;
pub type SharedExtensionToken = Arc<RwLock<String>>;
pub type SharedFrontendReady = Arc<AtomicBool>;
pub type SharedServerPort = Arc<RwLock<Option<u16>>>;
pub type SharedExtensionAcks = Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>;
pub type SharedMediaHandoffs = Arc<Mutex<HashMap<String, MediaHandoffState>>>;
type ReplayCache = Arc<Mutex<HashMap<String, u64>>>;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum MediaHandoffPhase {
    Initial,
    Discovered,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MediaDiscoveryContent {
    urls: Vec<String>,
    referer: Option<String>,
    headers: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MediaDiscoveryDeliveryResult {
    Acknowledged,
    RetryableFailure,
}

#[derive(Clone, Debug)]
enum MediaDiscoveryState {
    InFlight {
        content: MediaDiscoveryContent,
        attempt_id: String,
        completion: watch::Sender<Option<MediaDiscoveryDeliveryResult>>,
        attempt_expires_at: Instant,
    },
    Acknowledged {
        content: MediaDiscoveryContent,
    },
}

#[derive(Clone, Debug)]
pub struct MediaHandoffState {
    discovery: Option<MediaDiscoveryState>,
    expires_at: Instant,
}

#[derive(Clone)]
pub struct ServerState {
    pub app_handle: AppHandle,
    pub pairing_token: SharedExtensionToken,
    pub frontend_ready: SharedFrontendReady,
    pub extension_acks: SharedExtensionAcks,
    pub media_handoffs: SharedMediaHandoffs,
    pub replay_cache: ReplayCache,
    pub server_session: String,
    pub bound_port: u16,
}

#[derive(Deserialize)]
struct ExtensionRequest {
    urls: Vec<String>,
    #[serde(default)]
    referer: Option<String>,
    #[serde(default)]
    silent: bool,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    headers: Option<String>,
    #[serde(default)]
    cookies: Option<String>,
    #[serde(default)]
    cookie_scopes: Option<Vec<ExtensionCookieScope>>,
    #[serde(default)]
    media: bool,
    #[serde(default)]
    torrent: bool,
    #[serde(default)]
    batch: bool,
    #[serde(default)]
    batch_name: Option<String>,
    #[serde(default)]
    torrent_bytes_base64: Option<String>,
    #[serde(default, alias = "media_handoff_id")]
    handoff_id: Option<String>,
    #[serde(default, alias = "media_phase")]
    phase: Option<MediaHandoffPhase>,
    #[serde(default)]
    media_protocol_version: Option<u16>,
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ExtensionCookieScope {
    pub url: String,
    pub cookies: String,
}

#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ExtensionDownload {
    #[ts(optional)]
    request_id: Option<String>,
    urls: Vec<String>,
    referer: Option<String>,
    silent: bool,
    filename: Option<String>,
    headers: Option<String>,
    cookies: Option<String>,
    cookie_scopes: Option<Vec<ExtensionCookieScope>>,
    media: bool,
    torrent: bool,
    batch: bool,
    batch_name: Option<String>,
    #[ts(optional)]
    handoff_id: Option<String>,
    #[ts(optional)]
    phase: Option<MediaHandoffPhase>,
    #[ts(optional)]
    torrent_path: Option<String>,
    #[serde(skip)]
    #[ts(skip)]
    torrent_bytes: Option<Vec<u8>>,
}

#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ExtensionMediaDiscoveryUpdate {
    #[ts(optional)]
    request_id: Option<String>,
    handoff_id: String,
    phase: MediaHandoffPhase,
    urls: Vec<String>,
    referer: Option<String>,
    headers: Option<String>,
}

#[derive(Deserialize)]
struct ExtensionMediaDiscoveryRequest {
    handoff_id: String,
    phase: MediaHandoffPhase,
    media_protocol_version: u16,
    urls: Vec<String>,
    #[serde(default)]
    referer: Option<String>,
    #[serde(default)]
    headers: Option<String>,
}

pub async fn start_server(
    app_handle: AppHandle,
    pairing_token: SharedExtensionToken,
    frontend_ready: SharedFrontendReady,
    extension_acks: SharedExtensionAcks,
    media_handoffs: SharedMediaHandoffs,
    server_port: SharedServerPort,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let (port, listener) = bind_extension_listener().await?;
    let state = ServerState {
        app_handle,
        pairing_token,
        frontend_ready,
        extension_acks,
        media_handoffs,
        replay_cache: Arc::new(Mutex::new(HashMap::new())),
        server_session: uuid::Uuid::new_v4().simple().to_string(),
        bound_port: port,
    };

    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::AllowOrigin::predicate(|origin, _| {
            is_allowed_origin(origin.to_str().unwrap_or(""))
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any)
        .expose_headers(Any);

    let app = Router::new()
        .route("/ping", get(ping_handler))
        .route("/download", post(download_handler))
        .route("/media-discovery", post(media_discovery_handler))
        .layer(cors)
        .layer(RequestBodyLimitLayer::new(MAX_REQUEST_BODY_BYTES))
        .layer(middleware::from_fn(add_server_identity))
        .with_state(state);

    if let Ok(mut current_port) = server_port.write() {
        *current_port = Some(port);
    }

    log::info!("Browser extension server bound to 127.0.0.1:{port}");

    let server_result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            if *shutdown_rx.borrow() {
                return;
            }
            let _ = shutdown_rx.changed().await;
        })
        .await
        .map_err(|e| format!("Server error: {}", e));

    if let Ok(mut current_port) = server_port.write() {
        *current_port = None;
    }

    server_result
}

async fn add_server_identity(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(SERVER_HEADER, HeaderValue::from_static("1"));
    response.headers_mut().insert(
        PROTOCOL_VERSION_HEADER,
        HeaderValue::from_static(PROTOCOL_VERSION),
    );
    if std::env::var_os("FIRELINK_SMOKE_TEST").is_some() {
        if let Ok(process_id) = HeaderValue::from_str(&std::process::id().to_string()) {
            response
                .headers_mut()
                .insert(SMOKE_PROCESS_ID_HEADER, process_id);
        }
    }
    response
}

fn require_frontend_ready(frontend_ready: &SharedFrontendReady) -> Result<(), StatusCode> {
    // Startup intentionally seeds the server with a per-launch token while
    // the frontend decides whether credential-store access is allowed. Do
    // not expose that temporary token as an authentication failure.
    if frontend_ready.load(Ordering::Acquire) {
        Ok(())
    } else {
        Err(StatusCode::SERVICE_UNAVAILABLE)
    }
}

async fn bind_extension_listener() -> Result<(u16, tokio::net::TcpListener), String> {
    let mut errors = Vec::new();
    for port in EXTENSION_SERVER_PORT_RANGE {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => return Ok((port, listener)),
            Err(error) => {
                errors.push(format!("{port}: {error}"));
            }
        }
    }
    Err(format!(
        "Failed to bind extension server in port range {}-{} ({})",
        EXTENSION_SERVER_PORT,
        *EXTENSION_SERVER_PORT_RANGE.end(),
        errors.join("; ")
    ))
}

async fn ping_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, StatusCode> {
    if !has_allowed_request_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    require_frontend_ready(&state.frontend_ready)?;

    let signature = match headers
        .get("x-firelink-signature")
        .and_then(|v| v.to_str().ok())
    {
        Some(v) => v,
        None => return Err(StatusCode::FORBIDDEN),
    };

    let timestamp_str = match headers
        .get("x-firelink-timestamp")
        .and_then(|v| v.to_str().ok())
    {
        Some(v) => v,
        None => return Err(StatusCode::FORBIDDEN),
    };

    let nonce = match headers
        .get(CLIENT_NONCE_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|value| is_valid_client_nonce(value))
    {
        Some(v) => v,
        None => return Err(StatusCode::FORBIDDEN),
    };

    let timestamp = match verify_signature(signature, timestamp_str, &body, &state.pairing_token, None) {
        Ok(timestamp) => timestamp,
        Err(_) => return Err(StatusCode::FORBIDDEN),
    };

    // Discovery probes are authenticated requests too. Claim the verified
    // signature before signing a proof so a captured /ping signature cannot
    // be replayed with arbitrary client nonces during its validity window.
    if !claim_request(signature, timestamp, &state.replay_cache) {
        return Err(StatusCode::FORBIDDEN);
    }

    let proof = sign_server_proof(timestamp_str, nonce, state.bound_port, &state.pairing_token)
        .map_err(|_| StatusCode::FORBIDDEN)?;

    let mut response = Response::new(Body::empty());
    response.headers_mut().insert(
        SERVER_PROOF_HEADER,
        HeaderValue::from_str(&proof).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    response.headers_mut().insert(
        SERVER_PORT_HEADER,
        HeaderValue::from_str(&state.bound_port.to_string())
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    response.headers_mut().insert(
        SERVER_SESSION_HEADER,
        HeaderValue::from_str(&state.server_session)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    Ok(response)
}

async fn download_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, StatusCode> {
    if !has_allowed_request_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    require_frontend_ready(&state.frontend_ready)?;

    let nonce = required_client_nonce(&headers).ok_or(StatusCode::FORBIDDEN)?;

    let signature = match headers
        .get("x-firelink-signature")
        .and_then(|v| v.to_str().ok())
    {
        Some(v) => v,
        None => return Err(StatusCode::FORBIDDEN),
    };

    let timestamp_str = match headers
        .get("x-firelink-timestamp")
        .and_then(|v| v.to_str().ok())
    {
        Some(v) => v,
        None => return Err(StatusCode::FORBIDDEN),
    };

    let session_binding = match session_binding_requested(&headers) {
        Ok(value) => value,
        Err(_) => return Err(StatusCode::FORBIDDEN),
    };
    let server_session = match server_session_for_request(&headers, &state.server_session) {
        Ok(value) => value,
        Err(_) => return Err(StatusCode::FORBIDDEN),
    };
    if session_binding && server_session.is_none() {
        return Err(StatusCode::FORBIDDEN);
    }

    let timestamp = match verify_signature(
        signature,
        timestamp_str,
        &body,
        &state.pairing_token,
        server_session,
    ) {
        Ok(v) => v,
        Err(_) => return Err(StatusCode::FORBIDDEN),
    };

    if !claim_request(signature, timestamp, &state.replay_cache) {
        return Err(StatusCode::FORBIDDEN);
    }

    let payload: ExtensionRequest = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return Err(StatusCode::BAD_REQUEST),
    };

    let mut download = match normalize_download(payload) {
        Some(v) => v,
        None => return Err(StatusCode::BAD_REQUEST),
    };

    if download.phase == Some(MediaHandoffPhase::Discovered) {
        let update = ExtensionMediaDiscoveryUpdate {
            request_id: None,
            handoff_id: download
                .handoff_id
                .ok_or(StatusCode::BAD_REQUEST)?,
            phase: MediaHandoffPhase::Discovered,
            urls: download.urls,
            referer: download.referer,
            headers: download.headers,
        };
        return deliver_media_discovery_update(&state, headers, update).await;
    }

    let media_handoff_id = download.handoff_id.clone();

    let request_id = uuid::Uuid::new_v4().simple().to_string();
    if let Some(torrent_bytes) = download.torrent_bytes.take() {
        let torrent_path = crate::torrent::cache_torrent_bytes(
            &state.app_handle,
            &request_id,
            &torrent_bytes,
        )
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        download.urls = vec![torrent_path.clone()];
        download.torrent_path = Some(torrent_path);
    }
    let cached_torrent = download.torrent_path.is_some();

    let is_hidden = state
        .app_handle
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .is_some_and(|is_visible| !is_visible);
    crate::restore_main_window(&state.app_handle);
    if is_hidden {
        // Sleep briefly to let the webview wake up from macOS App Nap
        // otherwise the IPC event emitted immediately after is dropped.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }

    if !wait_for_frontend(&state.frontend_ready).await {
        if let Some(handoff_id) = media_handoff_id.as_deref() {
            remove_media_handoff(&state.media_handoffs, handoff_id);
        }
        if cached_torrent {
            crate::torrent::remove_managed_torrent(&state.app_handle, &request_id).await;
        }
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    if let Some(handoff_id) = media_handoff_id.as_deref() {
        if !register_media_handoff(&state.media_handoffs, handoff_id) {
            if cached_torrent {
                crate::torrent::remove_managed_torrent(&state.app_handle, &request_id).await;
            }
            return Err(StatusCode::CONFLICT);
        }
    }

    let Some(ack_receiver) = register_extension_ack(&state.extension_acks, request_id.clone())
    else {
        if let Some(handoff_id) = media_handoff_id.as_deref() {
            remove_media_handoff(&state.media_handoffs, handoff_id);
        }
        if cached_torrent {
            crate::torrent::remove_managed_torrent(&state.app_handle, &request_id).await;
        }
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    download.request_id = Some(request_id.clone());

    if state
        .app_handle
        .emit("extension-add-download", download)
        .is_err()
    {
        remove_extension_ack(&state.extension_acks, &request_id);
        if let Some(handoff_id) = media_handoff_id.as_deref() {
            remove_media_handoff(&state.media_handoffs, handoff_id);
        }
        if cached_torrent {
            crate::torrent::remove_managed_torrent(&state.app_handle, &request_id).await;
        }
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    if !wait_for_extension_acknowledgement(ack_receiver, EXTENSION_ACK_TIMEOUT).await {
        remove_extension_ack(&state.extension_acks, &request_id);
        // The event may already have reached the frontend even when its
        // acknowledgement was delayed or lost. Do not return 503 here:
        // extension callers retry 503 and could create a duplicate modal.
        return Err(StatusCode::GATEWAY_TIMEOUT);
    }

    let proof = sign_server_proof(timestamp_str, nonce, state.bound_port, &state.pairing_token)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut response = Response::new(Body::empty());
    response.headers_mut().insert(
        SERVER_PROOF_HEADER,
        HeaderValue::from_str(&proof).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    response.headers_mut().insert(
        SERVER_PORT_HEADER,
        HeaderValue::from_str(&state.bound_port.to_string())
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    response.headers_mut().insert(
        SERVER_SESSION_HEADER,
        HeaderValue::from_str(&state.server_session)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    Ok(response)
}

async fn media_discovery_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, StatusCode> {
    if !has_allowed_request_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    require_frontend_ready(&state.frontend_ready)?;

    let _nonce = required_client_nonce(&headers).ok_or(StatusCode::FORBIDDEN)?;
    let signature = headers
        .get("x-firelink-signature")
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::FORBIDDEN)?;
    let timestamp_str = headers
        .get("x-firelink-timestamp")
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::FORBIDDEN)?;
    let session_binding = session_binding_requested(&headers).map_err(|_| StatusCode::FORBIDDEN)?;
    let server_session =
        server_session_for_request(&headers, &state.server_session).map_err(|_| StatusCode::FORBIDDEN)?;
    if session_binding && server_session.is_none() {
        return Err(StatusCode::FORBIDDEN);
    }
    let timestamp = verify_signature(
        signature,
        timestamp_str,
        &body,
        &state.pairing_token,
        server_session,
    )
    .map_err(|_| StatusCode::FORBIDDEN)?;
    if !claim_request(signature, timestamp, &state.replay_cache) {
        return Err(StatusCode::FORBIDDEN);
    }

    let payload: ExtensionMediaDiscoveryRequest =
        serde_json::from_slice(&body).map_err(|_| StatusCode::BAD_REQUEST)?;
    let update = normalize_media_discovery_update(payload).ok_or(StatusCode::BAD_REQUEST)?;
    deliver_media_discovery_update(&state, headers, update).await
}

async fn deliver_media_discovery_update(
    state: &ServerState,
    headers: HeaderMap,
    update: ExtensionMediaDiscoveryUpdate,
) -> Result<Response, StatusCode> {
    let nonce = required_client_nonce(&headers).ok_or(StatusCode::FORBIDDEN)?;
    let timestamp_str = headers
        .get("x-firelink-timestamp")
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::FORBIDDEN)?;
    let handoff_id = update.handoff_id.clone();
    let request_id = uuid::Uuid::new_v4().simple().to_string();
    match admit_media_discovery_update(&state.media_handoffs, &update, request_id.clone()) {
        MediaDiscoveryAdmission::Missing => return Err(StatusCode::NOT_FOUND),
        MediaDiscoveryAdmission::Conflict => return Err(StatusCode::CONFLICT),
        MediaDiscoveryAdmission::RegistryUnavailable => {
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
        MediaDiscoveryAdmission::Duplicate => {
            return signed_server_response(timestamp_str, nonce, state);
        }
        MediaDiscoveryAdmission::InFlight { completion } => {
            return match tokio::time::timeout(
                EXTENSION_ACK_TIMEOUT,
                wait_for_media_discovery_completion(completion),
            )
            .await
            {
                Ok(Some(MediaDiscoveryDeliveryResult::Acknowledged)) => {
                    signed_server_response(timestamp_str, nonce, state)
                }
                Ok(Some(MediaDiscoveryDeliveryResult::RetryableFailure))
                | Ok(None)
                | Err(_) => {
                    Err(StatusCode::GATEWAY_TIMEOUT)
                }
            };
        }
        MediaDiscoveryAdmission::Fresh => {}
    }

    let is_hidden = state
        .app_handle
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .is_some_and(|is_visible| !is_visible);
    crate::restore_main_window(&state.app_handle);
    if is_hidden {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    if !wait_for_frontend(&state.frontend_ready).await {
        finish_media_discovery_attempt(
            &state.media_handoffs,
            &handoff_id,
            &request_id,
            &update,
            MediaDiscoveryDeliveryResult::RetryableFailure,
        );
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    let Some(ack_receiver) = register_extension_ack(&state.extension_acks, request_id.clone())
    else {
        finish_media_discovery_attempt(
            &state.media_handoffs,
            &handoff_id,
            &request_id,
            &update,
            MediaDiscoveryDeliveryResult::RetryableFailure,
        );
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    let update_for_cleanup = update.clone();
    let mut event = update;
    event.request_id = Some(request_id.clone());

    if state
        .app_handle
        .emit("extension-media-discovery", event)
        .is_err()
    {
        remove_extension_ack(&state.extension_acks, &request_id);
        finish_media_discovery_attempt(
            &state.media_handoffs,
            &handoff_id,
            &request_id,
            &update_for_cleanup,
            MediaDiscoveryDeliveryResult::RetryableFailure,
        );
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    if !wait_for_extension_acknowledgement(ack_receiver, EXTENSION_ACK_TIMEOUT).await {
        remove_extension_ack(&state.extension_acks, &request_id);
        finish_media_discovery_attempt(
            &state.media_handoffs,
            &handoff_id,
            &request_id,
            &update_for_cleanup,
            MediaDiscoveryDeliveryResult::RetryableFailure,
        );
        return Err(StatusCode::GATEWAY_TIMEOUT);
    }

    if !finish_media_discovery_attempt(
        &state.media_handoffs,
        &handoff_id,
        &request_id,
        &update_for_cleanup,
        MediaDiscoveryDeliveryResult::Acknowledged,
    ) {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    signed_server_response(timestamp_str, nonce, state)
}

async fn wait_for_media_discovery_completion(
    mut completion: watch::Receiver<Option<MediaDiscoveryDeliveryResult>>,
) -> Option<MediaDiscoveryDeliveryResult> {
    loop {
        let result = *completion.borrow();
        if result.is_some() {
            return result;
        }
        completion.changed().await.ok()?;
    }
}

fn signed_server_response(
    timestamp_str: &str,
    nonce: &str,
    state: &ServerState,
) -> Result<Response, StatusCode> {
    let proof = sign_server_proof(timestamp_str, nonce, state.bound_port, &state.pairing_token)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut response = Response::new(Body::empty());
    response.headers_mut().insert(
        SERVER_PROOF_HEADER,
        HeaderValue::from_str(&proof).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    response.headers_mut().insert(
        SERVER_PORT_HEADER,
        HeaderValue::from_str(&state.bound_port.to_string())
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    response.headers_mut().insert(
        SERVER_SESSION_HEADER,
        HeaderValue::from_str(&state.server_session)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    Ok(response)
}

async fn wait_for_frontend(frontend_ready: &SharedFrontendReady) -> bool {
    for _ in 0..40 {
        if frontend_ready.load(Ordering::Acquire) {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    false
}

fn register_extension_ack(
    registry: &SharedExtensionAcks,
    request_id: String,
) -> Option<oneshot::Receiver<()>> {
    let (sender, receiver) = oneshot::channel();
    let mut pending = registry.lock().ok()?;
    if pending.len() >= MAX_PENDING_EXTENSION_ACKS {
        return None;
    }
    pending.insert(request_id, sender);
    Some(receiver)
}

pub fn acknowledge_extension_download(registry: &SharedExtensionAcks, request_id: &str) -> bool {
    let Some(sender) = registry
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(request_id))
    else {
        return false;
    };
    sender.send(()).is_ok()
}

pub fn reject_extension_download(registry: &SharedExtensionAcks, request_id: &str) -> bool {
    registry
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(request_id))
        .is_some()
}

fn remove_extension_ack(registry: &SharedExtensionAcks, request_id: &str) {
    if let Ok(mut pending) = registry.lock() {
        pending.remove(request_id);
    }
}

async fn wait_for_extension_acknowledgement(
    receiver: oneshot::Receiver<()>,
    timeout: Duration,
) -> bool {
    matches!(tokio::time::timeout(timeout, receiver).await, Ok(Ok(())))
}

fn is_valid_media_handoff_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_MEDIA_HANDOFF_ID_BYTES
        && value.is_ascii()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn media_protocol_version_is_supported() -> bool {
    PROTOCOL_VERSION.parse::<u16>().ok() == Some(MEDIA_HANDOFF_PROTOCOL_VERSION)
}

fn normalize_media_handoff_metadata(
    media: bool,
    handoff_id: Option<String>,
    phase: Option<MediaHandoffPhase>,
    protocol_version: Option<u16>,
) -> Option<(Option<String>, Option<MediaHandoffPhase>)> {
    if !media {
        return (handoff_id.is_none() && phase.is_none() && protocol_version.is_none())
            .then_some((None, None));
    }

    match (handoff_id, phase, protocol_version) {
        (None, None, None) => Some((None, None)),
        (
            Some(value),
            Some(phase @ (MediaHandoffPhase::Initial | MediaHandoffPhase::Discovered)),
            Some(protocol_version),
        )
            if is_valid_media_handoff_id(&value)
                && protocol_version == MEDIA_HANDOFF_PROTOCOL_VERSION
                && media_protocol_version_is_supported() =>
        {
            Some((Some(value), Some(phase)))
        }
        _ => None,
    }
}

fn normalize_media_discovery_update(
    payload: ExtensionMediaDiscoveryRequest,
) -> Option<ExtensionMediaDiscoveryUpdate> {
    if payload.phase != MediaHandoffPhase::Discovered
        || payload.media_protocol_version != MEDIA_HANDOFF_PROTOCOL_VERSION
        || !media_protocol_version_is_supported()
        || !is_valid_media_handoff_id(&payload.handoff_id)
        || payload.urls.len() != 1
    {
        return None;
    }

    let url = normalize_media_url(payload.urls.into_iter().next()?.as_str())?;
    Some(ExtensionMediaDiscoveryUpdate {
        request_id: None,
        handoff_id: payload.handoff_id,
        phase: MediaHandoffPhase::Discovered,
        urls: vec![url],
        referer: normalize_referer(payload.referer),
        headers: normalize_headers(payload.headers, true),
    })
}

fn media_discovery_content(update: &ExtensionMediaDiscoveryUpdate) -> MediaDiscoveryContent {
    MediaDiscoveryContent {
        urls: update.urls.clone(),
        referer: update.referer.clone(),
        headers: update.headers.clone(),
    }
}

fn prune_media_handoffs(registry: &mut HashMap<String, MediaHandoffState>) {
    let now = Instant::now();
    for state in registry.values_mut() {
        let attempt_expired = matches!(
            state.discovery.as_ref(),
            Some(MediaDiscoveryState::InFlight {
                attempt_expires_at,
                ..
            }) if *attempt_expires_at <= now
        );
        if attempt_expired {
            if let Some(MediaDiscoveryState::InFlight { completion, .. }) = state.discovery.take() {
                let _ = completion.send(Some(MediaDiscoveryDeliveryResult::RetryableFailure));
            }
        }
    }
    registry.retain(|_, state| state.expires_at > now);
}

fn register_media_handoff(registry: &SharedMediaHandoffs, handoff_id: &str) -> bool {
    let Ok(mut registry) = registry.lock() else {
        return false;
    };
    prune_media_handoffs(&mut registry);
    if registry.contains_key(handoff_id) || registry.len() >= MAX_ACTIVE_MEDIA_HANDOFFS {
        return false;
    }
    registry.insert(
        handoff_id.to_string(),
        MediaHandoffState {
            discovery: None,
            expires_at: Instant::now() + MEDIA_HANDOFF_TTL,
        },
    );
    true
}

fn remove_media_handoff(registry: &SharedMediaHandoffs, handoff_id: &str) {
    if let Ok(mut registry) = registry.lock() {
        registry.remove(handoff_id);
    }
}

#[derive(Debug)]
enum MediaDiscoveryAdmission {
    Fresh,
    InFlight {
        completion: watch::Receiver<Option<MediaDiscoveryDeliveryResult>>,
    },
    Duplicate,
    Missing,
    Conflict,
    RegistryUnavailable,
}

fn admit_media_discovery_update(
    registry: &SharedMediaHandoffs,
    update: &ExtensionMediaDiscoveryUpdate,
    attempt_id: String,
) -> MediaDiscoveryAdmission {
    let Ok(mut registry) = registry.lock() else {
        return MediaDiscoveryAdmission::RegistryUnavailable;
    };
    prune_media_handoffs(&mut registry);
    let Some(state) = registry.get_mut(&update.handoff_id) else {
        return MediaDiscoveryAdmission::Missing;
    };
    let content = media_discovery_content(update);
    match state.discovery.take() {
        None => {
            let (completion, _waiter) = watch::channel(None);
            state.discovery = Some(MediaDiscoveryState::InFlight {
                content,
                attempt_id,
                completion,
                attempt_expires_at: Instant::now() + MEDIA_DISCOVERY_ATTEMPT_TTL,
            });
            state.expires_at = Instant::now() + MEDIA_HANDOFF_TTL;
            MediaDiscoveryAdmission::Fresh
        }
        Some(MediaDiscoveryState::InFlight {
            content: previous,
            attempt_id: previous_attempt_id,
            completion,
            attempt_expires_at,
        }) => {
            let same_content = previous == content;
            state.discovery = Some(MediaDiscoveryState::InFlight {
                content: previous,
                attempt_id: previous_attempt_id,
                completion: completion.clone(),
                attempt_expires_at,
            });
            if same_content {
                MediaDiscoveryAdmission::InFlight {
                    completion: completion.subscribe(),
                }
            } else {
                MediaDiscoveryAdmission::Conflict
            }
        }
        Some(MediaDiscoveryState::Acknowledged { content: previous }) => {
            let same_content = previous == content;
            state.discovery = Some(MediaDiscoveryState::Acknowledged { content: previous });
            if same_content {
                MediaDiscoveryAdmission::Duplicate
            } else {
                MediaDiscoveryAdmission::Conflict
            }
        }
    }
}

fn finish_media_discovery_attempt(
    registry: &SharedMediaHandoffs,
    handoff_id: &str,
    attempt_id: &str,
    update: &ExtensionMediaDiscoveryUpdate,
    result: MediaDiscoveryDeliveryResult,
) -> bool {
    let completion = {
        let Ok(mut registry) = registry.lock() else {
            return false;
        };
        let Some(state) = registry.get_mut(handoff_id) else {
            return false;
        };
        let Some(MediaDiscoveryState::InFlight {
            content,
            attempt_id: current_attempt_id,
            completion,
            attempt_expires_at,
        }) = state.discovery.take()
        else {
            return false;
        };
        if current_attempt_id != attempt_id || content != media_discovery_content(update) {
            state.discovery = Some(MediaDiscoveryState::InFlight {
                content,
                attempt_id: current_attempt_id,
                completion,
                attempt_expires_at,
            });
            return false;
        }

        if result == MediaDiscoveryDeliveryResult::Acknowledged {
            state.discovery = Some(MediaDiscoveryState::Acknowledged { content });
        }
        completion
    };

    let _ = completion.send(Some(result));
    true
}

#[cfg(test)]
fn expire_media_handoff(registry: &SharedMediaHandoffs, handoff_id: &str) {
    if let Ok(mut registry) = registry.lock() {
        if let Some(state) = registry.get_mut(handoff_id) {
            state.expires_at = Instant::now() - Duration::from_secs(1);
        }
    }
}

fn decode_torrent_bytes(encoded: &str) -> Option<Vec<u8>> {
    if encoded.is_empty()
        || encoded.len() > MAX_ENCODED_TORRENT_BYTES
        || encoded.len() % 4 != 0
    {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    if bytes.is_empty() || bytes.len() > crate::torrent::MAX_TORRENT_BYTES {
        return None;
    }
    crate::torrent::parse_torrent_bytes(&bytes).ok()?;
    Some(bytes)
}

fn normalize_download(mut payload: ExtensionRequest) -> Option<ExtensionDownload> {
    if payload.urls.len() > MAX_URL_COUNT {
        return None;
    }

    let (handoff_id, phase) = normalize_media_handoff_metadata(
        payload.media,
        payload.handoff_id.take(),
        payload.phase.take(),
        payload.media_protocol_version.take(),
    )?;

    let torrent_bytes = match payload.torrent_bytes_base64.as_deref() {
        Some(encoded) => Some(decode_torrent_bytes(encoded)?),
        None => None,
    };

    let mut seen = HashSet::new();
    let urls = payload
        .urls
        .into_iter()
        .filter_map(|raw_url| {
            if payload.media {
                normalize_media_url(&raw_url)
            } else {
                normalize_url(&raw_url)
            }
        })
        .filter(|url| seen.insert(url.clone()))
        .collect::<Vec<_>>();
    if urls.is_empty() {
        return None;
    }
    if matches!(
        phase,
        Some(MediaHandoffPhase::Initial | MediaHandoffPhase::Discovered)
    ) && urls.len() != 1
    {
        return None;
    }
    if torrent_bytes.is_some()
        && (payload.media
            || !payload.torrent
            || urls.len() != 1
            || Url::parse(&urls[0])
                .ok()
                .is_none_or(|url| !matches!(url.scheme(), "http" | "https")))
    {
        return None;
    }
    if payload.media
        && urls.iter().any(|url| {
            Url::parse(url)
                .ok()
                .is_none_or(|url| !matches!(url.scheme(), "http" | "https"))
        })
    {
        return None;
    }
    let torrent = !payload.media
        && urls.len() == 1
        && Url::parse(&urls[0]).ok().is_some_and(|url| {
            if url.scheme() == "magnet" {
                return true;
            }
            matches!(url.scheme(), "http" | "https")
                && (payload.torrent
                    || torrent_bytes.is_some()
                    || filename_is_torrent(payload.filename.as_deref())
                    || url.path().to_ascii_lowercase().ends_with(".torrent"))
        });
    if payload.torrent && !torrent {
        return None;
    }

    let referer = normalize_referer(payload.referer);
    let filename = payload.filename.and_then(|value| sanitize_filename(&value));
    let batch = payload.batch && urls.len() >= 2;
    let batch_name = batch
        .then_some(payload.batch_name)
        .flatten()
        .and_then(|value| {
            let value = value.trim().to_string();
            (!value.is_empty() && value.chars().count() <= 512).then_some(value)
        });
    // A multi-URL handoff has no per-URL cookie scope. Keep ordinary request
    // headers, but drop credential-bearing headers and the dedicated cookie
    // field so a legacy or untrusted caller cannot reuse one session across
    // hosts. Explicit media handoffs have a narrower, browser-context header
    // contract and are normalized separately below.
    let headers = if payload.media {
        normalize_headers(payload.headers, true)
    } else if urls.len() > 1 {
        normalize_shared_capture_headers(payload.headers)
    } else {
        normalize_headers(payload.headers, false)
    };
    let cookie_scopes = if !payload.media && urls.len() == 1 {
        let mut scopes = payload.cookie_scopes.take().unwrap_or_default();
        if let Some(cookies) = payload.cookies.take() {
            if !cookies.trim().is_empty() {
                scopes.push(ExtensionCookieScope {
                    url: urls[0].clone(),
                    cookies,
                });
            }
        }
        normalize_cookie_scopes(scopes)
    } else {
        None
    };
    let cookies = cookie_scopes.as_ref().and_then(|scopes| {
        scopes
            .iter()
            .find(|scope| same_origin_url(&scope.url, &urls[0]))
            .map(|scope| scope.cookies.clone())
    });

    Some(ExtensionDownload {
        request_id: None,
        urls,
        referer,
        silent: payload.silent,
        filename,
        headers,
        // Explicit media is resolved by yt-dlp, which must use Firelink's
        // configured browser-cookie source. Forwarding a browser's complete
        // Cookie header can exceed upstream limits and makes old extension
        // builds pay for a doomed metadata request before retrying. Ordinary
        // captured downloads still need their exact request cookies.
        cookies,
        cookie_scopes,
        media: payload.media,
        torrent,
        batch,
        batch_name,
        handoff_id,
        phase,
        torrent_path: None,
        torrent_bytes,
    })
}

fn normalize_cookie_scopes(scopes: Vec<ExtensionCookieScope>) -> Option<Vec<ExtensionCookieScope>> {
    let mut normalized = Vec::new();
    let mut seen_origins = HashSet::new();

    for scope in scopes {
        let Ok(url) = Url::parse(scope.url.trim()) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https") {
            continue;
        }
        let cookies = scope.cookies.trim();
        if cookies.is_empty() {
            continue;
        }
        let Some(host) = url.host_str() else {
            continue;
        };
        let origin = format!(
            "{}://{}:{}",
            url.scheme(),
            host,
            url.port_or_known_default().unwrap_or(443)
        );
        if !seen_origins.insert(origin) {
            continue;
        }
        normalized.push(ExtensionCookieScope {
            url: url.to_string(),
            cookies: cookies.to_string(),
        });
        if normalized.len() >= 16 {
            break;
        }
    }

    (!normalized.is_empty()).then_some(normalized)
}

fn same_origin_url(left: &str, right: &str) -> bool {
    let Some(left) = Url::parse(left).ok() else {
        return false;
    };
    let Some(right) = Url::parse(right).ok() else {
        return false;
    };
    left.scheme() == right.scheme()
        && left.host() == right.host()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn normalize_referer(value: Option<String>) -> Option<String> {
    let value = value?;
    if value.len() > MAX_MEDIA_REFERER_BYTES || value.chars().any(char::is_control) {
        return None;
    }

    let trimmed = value.trim();
    let mut url = Url::parse(trimmed).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }

    // Fragments are not sent in HTTP requests. Preserve the validated query
    // string because media servers may use page-session or signed referer
    // parameters as part of authorization; it remains in the dedicated
    // referer field and is never promoted into the forwarded header allowlist.
    url.set_fragment(None);
    Some(url.to_string())
}

fn normalize_headers(headers: Option<String>, media: bool) -> Option<String> {
    let headers = headers?;
    if !media {
        return (!headers.trim().is_empty()).then_some(headers);
    }

    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    let mut normalized_bytes = 0_usize;

    for line in headers.lines().take(MAX_MEDIA_HEADER_LINES) {
        let Some((raw_name, raw_value)) = line.split_once(':') else {
            continue;
        };
        if raw_name.is_empty()
            || raw_name.len() > MAX_MEDIA_HEADER_NAME_BYTES
            || raw_name
                .chars()
                .any(|character| character.is_control() || character.is_whitespace())
        {
            continue;
        }

        let Ok(parsed_name) = HeaderName::from_bytes(raw_name.as_bytes()) else {
            continue;
        };
        if crate::queue::header_name_has_credential_material(parsed_name.as_str()) {
            continue;
        }

        let Some(canonical_name) = canonical_media_header_name(parsed_name.as_str()) else {
            // Referer intentionally travels only through the dedicated,
            // validated field. All other browser-captured names are outside
            // the media handoff contract, including custom token headers.
            continue;
        };
        let value = raw_value.trim();
        if value.is_empty()
            || value.len() > MAX_MEDIA_HEADER_VALUE_BYTES
            || value.chars().any(char::is_control)
            || HeaderValue::from_str(value).is_err()
            || !seen.insert(canonical_name)
        {
            continue;
        }

        let line = format!("{canonical_name}: {value}");
        let separator_bytes = usize::from(!normalized.is_empty());
        if normalized_bytes
            .saturating_add(separator_bytes)
            .saturating_add(line.len())
            > MAX_MEDIA_HEADERS_BYTES
        {
            continue;
        }
        normalized_bytes = normalized_bytes
            .saturating_add(separator_bytes)
            .saturating_add(line.len());
        normalized.push(line);
    }

    (!normalized.is_empty()).then(|| normalized.join("\n"))
}

fn normalize_shared_capture_headers(headers: Option<String>) -> Option<String> {
    let headers = headers?;
    let filtered = headers
        .lines()
        .filter(|line| {
            line.split_once(':')
                .map(|(name, _)| !crate::queue::header_name_has_credential_material(name))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!filtered.trim().is_empty()).then_some(filtered)
}

fn canonical_media_header_name(name: &str) -> Option<&'static str> {
    if name.eq_ignore_ascii_case("accept") {
        Some("Accept")
    } else if name.eq_ignore_ascii_case("accept-language") {
        Some("Accept-Language")
    } else if name.eq_ignore_ascii_case("origin") {
        Some("Origin")
    } else if name.eq_ignore_ascii_case("user-agent") {
        Some("User-Agent")
    } else {
        None
    }
}

fn normalize_url(raw_url: &str) -> Option<String> {
    let url = Url::parse(raw_url.trim()).ok()?;
    matches!(url.scheme(), "http" | "https" | "ftp" | "sftp" | "magnet")
        .then(|| url.to_string())
}

fn normalize_media_url(raw_url: &str) -> Option<String> {
    let mut url = Url::parse(raw_url.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_fragment(None);
    Some(url.to_string())
}

fn filename_is_torrent(filename: Option<&str>) -> bool {
    filename
        .and_then(|value| Path::new(value.trim()).file_name())
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.to_ascii_lowercase().ends_with(".torrent"))
}

fn sanitize_filename(filename: &str) -> Option<String> {
    let normalized = filename.trim().replace('\\', "/");
    let basename = Path::new(&normalized).file_name()?.to_str()?.trim();
    if basename.is_empty() || basename == "." || basename == ".." || basename.len() > 255 {
        return None;
    }
    Some(basename.to_string())
}

fn verify_signature(
    signature_hex: &str,
    timestamp_text: &str,
    body: &[u8],
    pairing_token: &SharedExtensionToken,
    server_session: Option<&str>,
) -> Result<u64, ()> {
    let signature = decode_hex(signature_hex)?;
    let timestamp = timestamp_text.parse::<u64>().map_err(|_| ())?;
    let now = current_time_millis().ok_or(())?;
    if now.abs_diff(timestamp) >= SIGNATURE_MAX_AGE_MS {
        return Err(());
    }

    let token = pairing_token.read().unwrap_or_else(|e| e.into_inner());
    if token.is_empty() {
        return Err(());
    }

    let mut mac = HmacSha256::new_from_slice(token.as_bytes()).map_err(|_| ())?;
    mac.update(timestamp_text.as_bytes());
    if let Some(server_session) = server_session {
        mac.update(b"\n");
        mac.update(server_session.as_bytes());
        mac.update(b"\n");
    }
    mac.update(body);
    mac.verify_slice(&signature).map_err(|_| ())?;
    Ok(timestamp)
}

fn is_valid_client_nonce(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn has_allowed_request_origin(headers: &HeaderMap) -> bool {
    match headers.get("origin") {
        None => true,
        Some(origin) => origin.to_str().ok().is_some_and(is_allowed_origin),
    }
}

fn required_client_nonce(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(CLIENT_NONCE_HEADER)
        .and_then(|nonce| nonce.to_str().ok())
        .filter(|nonce| is_valid_client_nonce(nonce))
}

fn is_valid_server_session(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn server_session_for_request<'a>(
    headers: &'a HeaderMap,
    expected: &str,
) -> Result<Option<&'a str>, ()> {
    let Some(value) = headers.get(SERVER_SESSION_HEADER) else {
        // The session binding is an optional upgrade so existing paired
        // Companion releases continue to use the established HMAC contract.
        return Ok(None);
    };
    let value = value.to_str().map_err(|_| ())?;
    if !is_valid_server_session(value) || value != expected {
        return Err(());
    }
    Ok(Some(value))
}

fn session_binding_requested(headers: &HeaderMap) -> Result<bool, ()> {
    match headers.get(SESSION_BINDING_HEADER) {
        None => Ok(false),
        Some(value) if value.to_str().ok() == Some("1") => Ok(true),
        Some(_) => Err(()),
    }
}

fn sign_server_proof(
    timestamp_text: &str,
    nonce: &str,
    bound_port: u16,
    pairing_token: &SharedExtensionToken,
) -> Result<String, ()> {
    let token = pairing_token.read().unwrap_or_else(|e| e.into_inner());
    if token.is_empty() {
        return Err(());
    }

    let mut mac = HmacSha256::new_from_slice(token.as_bytes()).map_err(|_| ())?;
    mac.update(SERVER_PROOF_PREFIX);
    mac.update(timestamp_text.as_bytes());
    mac.update(b"\n");
    mac.update(nonce.as_bytes());
    mac.update(b"\n");
    mac.update(bound_port.to_string().as_bytes());
    let signature = mac.finalize().into_bytes();
    Ok(encode_hex(signature.as_slice()))
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn claim_request(signature: &str, timestamp: u64, replay_cache: &ReplayCache) -> bool {
    let now = match current_time_millis() {
        Some(now) => now,
        None => return false,
    };
    claim_request_at(signature, timestamp, replay_cache, now)
}

fn claim_request_at(signature: &str, timestamp: u64, replay_cache: &ReplayCache, now: u64) -> bool {
    let mut cache = match replay_cache.lock() {
        Ok(cache) => cache,
        Err(_) => return false,
    };
    cache.retain(|_, expires_at| now < *expires_at);
    let key = format!("{timestamp}:{}", signature.to_ascii_lowercase());
    if cache.len() >= 10_000 && !cache.contains_key(&key) {
        return false;
    }
    cache
        .insert(key, timestamp.saturating_add(SIGNATURE_MAX_AGE_MS))
        .is_none()
}

fn current_time_millis() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn decode_hex(value: &str) -> Result<Vec<u8>, ()> {
    if value.len() != 64 || !value.is_ascii() {
        return Err(());
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = hex_digit(pair[0]).ok_or(())?;
            let low = hex_digit(pair[1]).ok_or(())?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn is_allowed_origin(origin: &str) -> bool {
    Url::parse(origin)
        .ok()
        .is_some_and(|url| matches!(url.scheme(), "moz-extension" | "chrome-extension"))
}

#[cfg(test)]
mod tests {
    use super::{
        acknowledge_extension_download, add_server_identity, admit_media_discovery_update,
        claim_request_at, decode_torrent_bytes, has_allowed_request_origin,
        is_valid_client_nonce, is_valid_media_handoff_id, normalize_download,
        normalize_headers, normalize_media_discovery_update, normalize_media_handoff_metadata,
        normalize_media_url, normalize_referer, normalize_url,
        expire_media_handoff, finish_media_discovery_attempt, register_media_handoff,
        reject_extension_download, wait_for_extension_acknowledgement,
        require_frontend_ready, required_client_nonce, same_origin_url, sanitize_filename,
        server_session_for_request, session_binding_requested,
        sign_server_proof,
        wait_for_media_discovery_completion,
        ExtensionCookieScope, ExtensionMediaDiscoveryRequest, ExtensionRequest,
        MediaDiscoveryAdmission, MediaDiscoveryDeliveryResult, MediaHandoffPhase,
        MAX_MEDIA_HEADER_VALUE_BYTES, MAX_MEDIA_HANDOFF_ID_BYTES, MAX_MEDIA_REFERER_BYTES,
        MAX_URL_COUNT,
        MEDIA_HANDOFF_PROTOCOL_VERSION,
        PROTOCOL_VERSION_HEADER, SERVER_HEADER, SERVER_SESSION_HEADER,
        SESSION_BINDING_HEADER,
    };
    use axum::{
        http::{HeaderMap, HeaderValue, StatusCode},
        middleware,
        routing::get,
        Router,
    };
    use base64::Engine as _;
    use hmac::{Hmac, KeyInit, Mac};
    use sha2::Sha256;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, RwLock};
    use std::time::Duration;

    fn normalized_discovery_update(
        handoff_id: &str,
        url: &str,
        referer: Option<&str>,
        headers: Option<&str>,
    ) -> super::ExtensionMediaDiscoveryUpdate {
        normalize_media_discovery_update(ExtensionMediaDiscoveryRequest {
            handoff_id: handoff_id.to_string(),
            phase: MediaHandoffPhase::Discovered,
            media_protocol_version: MEDIA_HANDOFF_PROTOCOL_VERSION,
            urls: vec![url.to_string()],
            referer: referer.map(str::to_string),
            headers: headers.map(str::to_string),
        })
        .expect("valid discovery payload")
    }

    #[tokio::test]
    async fn identifies_every_extension_server_response() {
        let app = Router::new()
            .route("/ping", get(|| async { StatusCode::FORBIDDEN }))
            .layer(middleware::from_fn(add_server_identity));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        crate::ensure_reqwest_crypto_provider();
        let response = reqwest::get(format!("http://{address}/ping"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(response.headers().get(SERVER_HEADER).unwrap(), "1");
        assert_eq!(
            response.headers().get(PROTOCOL_VERSION_HEADER).unwrap(),
            "7"
        );

        server.abort();
    }

    #[test]
    fn reports_startup_as_retryable_until_the_frontend_is_ready() {
        let frontend_ready = Arc::new(AtomicBool::new(false));
        assert_eq!(
            require_frontend_ready(&frontend_ready),
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );

        frontend_ready.store(true, Ordering::Release);
        assert_eq!(require_frontend_ready(&frontend_ready), Ok(()));
    }

    #[test]
    fn gates_the_two_phase_media_contract_and_rejects_malformed_ids_or_phases() {
        assert_eq!(MEDIA_HANDOFF_PROTOCOL_VERSION, 7);
        assert!(is_valid_media_handoff_id("media-opaque_01"));
        assert!(!is_valid_media_handoff_id(""));
        assert!(!is_valid_media_handoff_id("media id"));
        assert!(!is_valid_media_handoff_id(&"x".repeat(MAX_MEDIA_HANDOFF_ID_BYTES + 1)));

        assert_eq!(
            normalize_media_handoff_metadata(
                true,
                Some("media-opaque".to_string()),
                Some(MediaHandoffPhase::Initial),
                Some(MEDIA_HANDOFF_PROTOCOL_VERSION),
            ),
            Some((
                Some("media-opaque".to_string()),
                Some(MediaHandoffPhase::Initial),
            ))
        );
        assert!(normalize_media_handoff_metadata(
            true,
            Some("media-opaque".to_string()),
            None,
            Some(MEDIA_HANDOFF_PROTOCOL_VERSION),
        )
        .is_none());
        assert!(normalize_media_handoff_metadata(
            false,
            Some("ordinary".to_string()),
            Some(MediaHandoffPhase::Initial),
            Some(MEDIA_HANDOFF_PROTOCOL_VERSION),
        )
        .is_none());
        assert!(normalize_media_handoff_metadata(
            true,
            Some("media-opaque".to_string()),
            Some(MediaHandoffPhase::Initial),
            Some(MEDIA_HANDOFF_PROTOCOL_VERSION - 1),
        )
        .is_none());
        assert!(normalize_media_handoff_metadata(
            true,
            None,
            None,
            Some(MEDIA_HANDOFF_PROTOCOL_VERSION),
        )
        .is_none());
        assert!(serde_json::from_str::<MediaHandoffPhase>("\"invalid\"").is_err());
    }

    #[test]
    fn normalizes_only_versioned_discovery_updates() {
        let valid = ExtensionMediaDiscoveryRequest {
            handoff_id: "media-opaque".to_string(),
            phase: MediaHandoffPhase::Discovered,
            media_protocol_version: MEDIA_HANDOFF_PROTOCOL_VERSION,
            urls: vec!["https://cdn.example/master.m3u8#fragment".to_string()],
            referer: Some("https://video.example/watch".to_string()),
            headers: Some("Cookie: discarded\nUser-Agent: Firefox".to_string()),
        };
        let update = normalize_media_discovery_update(valid).expect("valid discovery update");
        assert_eq!(update.urls, vec!["https://cdn.example/master.m3u8"]);
        assert_eq!(update.referer.as_deref(), Some("https://video.example/watch"));
        assert_eq!(update.headers.as_deref(), Some("User-Agent: Firefox"));

        for invalid in [
            ExtensionMediaDiscoveryRequest {
                handoff_id: "media-opaque".to_string(),
                phase: MediaHandoffPhase::Initial,
                media_protocol_version: MEDIA_HANDOFF_PROTOCOL_VERSION,
                urls: vec!["https://cdn.example/master.m3u8".to_string()],
                referer: None,
                headers: None,
            },
            ExtensionMediaDiscoveryRequest {
                handoff_id: "media opaque".to_string(),
                phase: MediaHandoffPhase::Discovered,
                media_protocol_version: MEDIA_HANDOFF_PROTOCOL_VERSION,
                urls: vec!["https://cdn.example/master.m3u8".to_string()],
                referer: None,
                headers: None,
            },
            ExtensionMediaDiscoveryRequest {
                handoff_id: "media-opaque".to_string(),
                phase: MediaHandoffPhase::Discovered,
                media_protocol_version: MEDIA_HANDOFF_PROTOCOL_VERSION - 1,
                urls: vec!["https://cdn.example/master.m3u8".to_string()],
                referer: None,
                headers: None,
            },
            ExtensionMediaDiscoveryRequest {
                handoff_id: "media-opaque".to_string(),
                phase: MediaHandoffPhase::Discovered,
                media_protocol_version: MEDIA_HANDOFF_PROTOCOL_VERSION,
                urls: Vec::new(),
                referer: None,
                headers: None,
            },
        ] {
            assert!(normalize_media_discovery_update(invalid).is_none());
        }
    }

    #[test]
    fn normalizes_initial_media_handoff_without_forwarding_cookies() {
        let download = normalize_download(ExtensionRequest {
            urls: vec!["https://video.example/watch?id=1".to_string()],
            referer: Some("https://video.example/watch?id=1".to_string()),
            silent: false,
            filename: None,
            headers: Some("Cookie: browser-secret\nUser-Agent: Firefox".to_string()),
            cookies: Some("browser-secret".to_string()),
            cookie_scopes: None,
            media: true,
            torrent: false,
            batch: false,
            batch_name: None,
            torrent_bytes_base64: None,
            handoff_id: Some("media-opaque".to_string()),
            phase: Some(MediaHandoffPhase::Initial),
            media_protocol_version: Some(MEDIA_HANDOFF_PROTOCOL_VERSION),
        })
        .expect("valid initial media handoff");

        assert_eq!(download.handoff_id.as_deref(), Some("media-opaque"));
        assert_eq!(download.phase, Some(MediaHandoffPhase::Initial));
        assert_eq!(download.cookies, None);
        assert_eq!(download.headers.as_deref(), Some("User-Agent: Firefox"));
    }

    #[tokio::test]
    async fn discovery_updates_require_ack_before_deduplication_and_roll_back_on_failure() {
        let registry = Arc::new(Mutex::new(HashMap::new()));
        assert!(register_media_handoff(&registry, "media-opaque"));

        let update = normalized_discovery_update(
            "media-opaque",
            "https://cdn.example/stream.m3u8#fragment",
            Some("https://video.example/watch"),
            Some("Cookie: discarded\nUser-Agent: Firefox"),
        );
        assert!(matches!(
            admit_media_discovery_update(&registry, &update, "attempt-1".to_string()),
            MediaDiscoveryAdmission::Fresh
        ));
        let failure_completion = match admit_media_discovery_update(
            &registry,
            &update,
            "attempt-2".to_string(),
        ) {
            MediaDiscoveryAdmission::InFlight { completion } => completion,
            admission => panic!("expected an in-flight duplicate, got {admission:?}"),
        };
        let failure_waiter = tokio::spawn(wait_for_media_discovery_completion(failure_completion));

        assert!(finish_media_discovery_attempt(
            &registry,
            "media-opaque",
            "attempt-1",
            &update,
            MediaDiscoveryDeliveryResult::RetryableFailure,
        ));
        assert_eq!(
            failure_waiter.await.unwrap(),
            Some(MediaDiscoveryDeliveryResult::RetryableFailure)
        );
        assert!(matches!(
            admit_media_discovery_update(&registry, &update, "attempt-3".to_string()),
            MediaDiscoveryAdmission::Fresh
        ));
        let success_completion = match admit_media_discovery_update(
            &registry,
            &update,
            "attempt-4".to_string(),
        ) {
            MediaDiscoveryAdmission::InFlight { completion } => completion,
            admission => panic!("expected an in-flight duplicate, got {admission:?}"),
        };
        let success_waiter = tokio::spawn(wait_for_media_discovery_completion(success_completion));
        assert!(finish_media_discovery_attempt(
            &registry,
            "media-opaque",
            "attempt-3",
            &update,
            MediaDiscoveryDeliveryResult::Acknowledged,
        ));
        assert_eq!(
            success_waiter.await.unwrap(),
            Some(MediaDiscoveryDeliveryResult::Acknowledged)
        );
        assert!(matches!(
            admit_media_discovery_update(&registry, &update, "attempt-5".to_string()),
            MediaDiscoveryAdmission::Duplicate
        ));

        let conflicting = normalized_discovery_update(
            "media-opaque",
            "https://cdn.example/older.m3u8",
            None,
            None,
        );
        assert!(matches!(
            admit_media_discovery_update(&registry, &conflicting, "attempt-6".to_string()),
            MediaDiscoveryAdmission::Conflict
        ));
        assert_eq!(update.urls, vec!["https://cdn.example/stream.m3u8"]);
        assert_eq!(update.headers.as_deref(), Some("User-Agent: Firefox"));
    }

    #[test]
    fn missing_and_expired_discovery_handoffs_are_not_successful_duplicates() {
        let missing_registry = Arc::new(Mutex::new(HashMap::new()));
        let update = normalized_discovery_update(
            "missing-handoff",
            "https://cdn.example/stream.m3u8",
            None,
            None,
        );
        assert!(matches!(
            admit_media_discovery_update(&missing_registry, &update, "attempt-1".to_string()),
            MediaDiscoveryAdmission::Missing
        ));

        let expired_registry = Arc::new(Mutex::new(HashMap::new()));
        assert!(register_media_handoff(&expired_registry, "expired-handoff"));
        expire_media_handoff(&expired_registry, "expired-handoff");
        let expired = normalized_discovery_update(
            "expired-handoff",
            "https://cdn.example/stream.m3u8",
            None,
            None,
        );
        assert!(matches!(
            admit_media_discovery_update(&expired_registry, &expired, "attempt-2".to_string()),
            MediaDiscoveryAdmission::Missing
        ));
    }

    #[test]
    fn discovery_update_payload_has_a_stable_ipc_shape() {
        let update = normalized_discovery_update(
            "media-opaque",
            "https://cdn.example/stream.m3u8",
            None,
            None,
        );
        let value = serde_json::to_value(update).expect("serialize discovery update");
        assert_eq!(
            value,
            serde_json::json!({
                "request_id": null,
                "handoff_id": "media-opaque",
                "phase": "discovered",
                "urls": ["https://cdn.example/stream.m3u8"],
                "referer": null,
                "headers": null
            })
        );
    }

    #[test]
    fn validates_client_nonce_shape() {
        assert!(is_valid_client_nonce("0123456789abcdef0123456789abcdef"));
        assert!(is_valid_client_nonce("ABCDEF0123456789abcdef0123456789"));
        assert!(!is_valid_client_nonce("0123456789abcdef0123456789abcde"));
        assert!(!is_valid_client_nonce("0123456789abcdef0123456789abcdeg"));
    }

    #[test]
    fn rejects_invalid_origins() {
        let mut headers = HeaderMap::new();
        assert!(has_allowed_request_origin(&headers));

        headers.insert(
            "origin",
            HeaderValue::from_static("https://not-firelink.example"),
        );
        assert!(!has_allowed_request_origin(&headers));

        headers.insert(
            "origin",
            HeaderValue::from_static("moz-extension://firelink"),
        );
        assert!(has_allowed_request_origin(&headers));
    }

    #[test]
    fn requires_a_valid_client_nonce_for_downloads() {
        let mut headers = HeaderMap::new();
        assert!(required_client_nonce(&headers).is_none());

        headers.insert(
            "x-firelink-client-nonce",
            HeaderValue::from_static("not-a-valid-nonce"),
        );
        assert!(required_client_nonce(&headers).is_none());

        headers.insert(
            "x-firelink-client-nonce",
            HeaderValue::from_static("0123456789abcdef0123456789abcdef"),
        );
        assert_eq!(
            required_client_nonce(&headers),
            Some("0123456789abcdef0123456789abcdef")
        );
    }

    #[test]
    fn validates_optional_server_session_binding_for_downloads() {
        let mut headers = HeaderMap::new();
        let current = "0123456789abcdef0123456789abcdef";
        assert_eq!(server_session_for_request(&headers, current), Ok(None));

        headers.insert(
            SERVER_SESSION_HEADER,
            HeaderValue::from_static("stale-session"),
        );
        assert!(server_session_for_request(&headers, current).is_err());

        headers.insert(
            SERVER_SESSION_HEADER,
            HeaderValue::from_static(current),
        );
        assert_eq!(server_session_for_request(&headers, current), Ok(Some(current)));

        headers.insert(SESSION_BINDING_HEADER, HeaderValue::from_static("1"));
        assert_eq!(session_binding_requested(&headers), Ok(true));
    }

    #[test]
    fn media_handoffs_reject_non_http_page_urls() {
        let download = normalize_download(ExtensionRequest {
            urls: vec!["ftp://example.com/audio.mp3".to_string()],
            referer: None,
            silent: false,
            filename: None,
            headers: None,
            cookies: None,
            cookie_scopes: None,
            media: true,
            torrent: false,
            batch: false,
            batch_name: None,
            torrent_bytes_base64: None,
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        });

        assert!(download.is_none());
    }

    #[test]
    fn rejects_oversized_url_lists_instead_of_truncating_them() {
        let download = normalize_download(ExtensionRequest {
            urls: (0..=MAX_URL_COUNT)
                .map(|index| format!("https://example.com/file-{index}.bin"))
                .collect(),
            referer: None,
            silent: false,
            filename: None,
            headers: None,
            cookies: None,
            cookie_scopes: None,
            media: false,
            torrent: false,
            batch: false,
            batch_name: None,
            torrent_bytes_base64: None,
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        });

        assert!(download.is_none());
    }

    #[test]
    fn rejects_replayed_download_signature() {
        let cache = Arc::new(Mutex::new(HashMap::new()));
        let signature = "a".repeat(64);
        let now = 1_000_000;

        assert!(claim_request_at(&signature, now, &cache, now));
        assert!(!claim_request_at(&signature, now, &cache, now + 1));
    }

    #[test]
    fn future_timestamp_replay_claim_survives_cache_pruning_window() {
        let cache = Arc::new(Mutex::new(HashMap::new()));
        let signature = "b".repeat(64);
        let now = 1_000_000;
        let future_timestamp = now + 30_000;

        assert!(claim_request_at(&signature, future_timestamp, &cache, now));
        assert!(!claim_request_at(
            &signature,
            future_timestamp,
            &cache,
            now + 70_000
        ));
    }

    #[test]
    fn download_signatures_bind_to_the_server_session() {
        let token = Arc::new(RwLock::new("pairing-token".to_string()));
        let timestamp = super::current_time_millis().unwrap().to_string();
        let body = br#"{"media":true}"#;
        let session = "0123456789abcdef0123456789abcdef";
        let mut mac = Hmac::<Sha256>::new_from_slice(b"pairing-token").unwrap();
        mac.update(timestamp.as_bytes());
        mac.update(b"\n");
        mac.update(session.as_bytes());
        mac.update(b"\n");
        mac.update(body);
        let signature = super::encode_hex(mac.finalize().into_bytes().as_slice());

        assert!(super::verify_signature(
            &signature,
            &timestamp,
            body,
            &token,
            Some(session)
        )
        .is_ok());
        assert!(super::verify_signature(&signature, &timestamp, body, &token, None).is_err());
        assert!(super::verify_signature(
            &signature,
            &timestamp,
            body,
            &token,
            Some("fedcba9876543210fedcba9876543210")
        )
        .is_err());
    }

    #[tokio::test]
    async fn acknowledges_and_removes_pending_extension_event() {
        let registry = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = tokio::sync::oneshot::channel();
        registry
            .lock()
            .unwrap()
            .insert("request-1".to_string(), sender);

        assert!(acknowledge_extension_download(&registry, "request-1"));
        assert!(!acknowledge_extension_download(&registry, "request-1"));
        assert!(receiver.await.is_ok());
    }

    #[tokio::test]
    async fn rejects_and_removes_pending_extension_event_for_retry() {
        let registry = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = tokio::sync::oneshot::channel();
        registry
            .lock()
            .unwrap()
            .insert("request-2".to_string(), sender);

        assert!(reject_extension_download(&registry, "request-2"));
        assert!(!reject_extension_download(&registry, "request-2"));
        assert!(!wait_for_extension_acknowledgement(receiver, Duration::from_secs(1)).await);
    }

    #[tokio::test]
    async fn only_a_sent_acknowledgement_counts_as_success() {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        sender.send(()).unwrap();
        assert!(wait_for_extension_acknowledgement(receiver, Duration::from_secs(1)).await);

        let (_sender, receiver) = tokio::sync::oneshot::channel::<()>();
        assert!(!wait_for_extension_acknowledgement(receiver, Duration::ZERO).await);
    }

    #[test]
    fn explicit_media_drops_the_extension_cookie_header() {
        let download = normalize_download(ExtensionRequest {
            urls: vec!["https://www.youtube.com/watch?v=example".to_string()],
            referer: None,
            silent: false,
            filename: None,
            headers: Some(format!(
                "Cookie: stale={};\nCookie2: stale=1\nAuthorization: Bearer stale\nProxy-Authorization: Basic stale\nSet-Cookie: stale=1\nSet-Cookie2: stale=1\nSet-Cookie3: stale=1\nX-Api-Key: stale\nX-Auth-Token: stale\nX-Access-Token: stale\nX-Request-Signature: stale\nX-Session: stale\n: malformed\nUser-Agent: Firefox\nX-Trace: safe",
                "x".repeat(64 * 1024)
            )),
            cookies: Some(format!("large={}", "x".repeat(64 * 1024))),
            cookie_scopes: None,
            media: true,
            torrent: false,
            batch: false,
            batch_name: None,
            torrent_bytes_base64: None,
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        })
        .expect("valid media handoff");

        assert!(download.media);
        assert!(download.cookies.is_none());
        assert_eq!(
            download.headers.as_deref(),
            Some("User-Agent: Firefox")
        );
    }

    #[test]
    fn media_headers_allow_only_safe_context_headers_and_canonicalize_names() {
        let headers = normalize_headers(
            Some(
                "aCcEpT: application/vnd.apple.mpegurl\nACCEPT: second\naccept-language: en-US\nORIGIN: https://media.example\nuser-agent: Firefox\nReferer: https://page.example\nX-Trace: safe"
                    .to_string(),
            ),
            true,
        );

        assert_eq!(
            headers.as_deref(),
            Some(
                "Accept: application/vnd.apple.mpegurl\nAccept-Language: en-US\nOrigin: https://media.example\nUser-Agent: Firefox"
            )
        );
    }

    #[test]
    fn media_headers_drop_malformed_values_and_enforce_bounds() {
        let headers = normalize_headers(
            Some(format!(
                "Accept: valid\nOrigin: https://example.com\u{0}injected\nAccept-Language: en-US\tbad\nUser-Agent : malformed\nUser-Agent: {}\nUser-Agent: Firefox",
                "x".repeat(MAX_MEDIA_HEADER_VALUE_BYTES + 1)
            )),
            true,
        );

        assert_eq!(headers.as_deref(), Some("Accept: valid\nUser-Agent: Firefox"));
    }

    #[test]
    fn media_referer_accepts_bounded_http_urls_and_preserves_valid_queries() {
        assert_eq!(
            normalize_referer(
                Some("  https://media.example/watch?token=short  ".to_string()),
            ),
            Some("https://media.example/watch?token=short".to_string())
        );

        for invalid in [
            "ftp://media.example/watch",
            "https://user:password@media.example/watch",
            "https://media.example/watch\nX-Injected: yes",
        ] {
            assert_eq!(normalize_referer(Some(invalid.to_string())), None);
        }

        assert_eq!(
            normalize_referer(Some("https://media.example/watch#fragment".to_string())),
            Some("https://media.example/watch".to_string())
        );

        let oversized = format!(
            "https://media.example/{}",
            "x".repeat(MAX_MEDIA_REFERER_BYTES)
        );
        assert_eq!(normalize_referer(Some(oversized)), None);
    }

    #[test]
    fn media_handoffs_keep_referer_dedicated_and_accept_direct_manifests() {
        for url in [
            "https://cdn.example/live/stream.m3u8?signature=short",
            "https://cdn.example/live/manifest.MPD#ignored-by-request",
            "https://cdn.example/live/video.ism/manifest",
        ] {
            let download = normalize_download(ExtensionRequest {
                urls: vec![url.to_string()],
                referer: Some("https://player.example/watch".to_string()),
                silent: false,
                filename: None,
                headers: Some(
                    "Referer: https://wrong.example\nUser-Agent: Firefox".to_string(),
                ),
                cookies: None,
                cookie_scopes: None,
                media: true,
                torrent: false,
                batch: false,
                batch_name: None,
                torrent_bytes_base64: None,
                handoff_id: None,
                phase: None,
                media_protocol_version: None,
            })
            .expect("direct manifest media handoff");

            assert!(download.media);
            let expected_url = url.split('#').next().unwrap_or(url);
            assert_eq!(download.urls, vec![expected_url.to_string()]);
            assert_eq!(
                download.referer.as_deref(),
                Some("https://player.example/watch")
            );
            assert_eq!(download.headers.as_deref(), Some("User-Agent: Firefox"));
        }
    }

    #[test]
    fn media_urls_reject_embedded_credentials_and_fragments() {
        assert_eq!(
            normalize_media_url("https://cdn.example/live/stream.m3u8?sig=short#player"),
            Some("https://cdn.example/live/stream.m3u8?sig=short".to_string())
        );
        assert!(normalize_media_url("https://user:secret@cdn.example/live/stream.m3u8").is_none());
        assert!(normalize_media_url("https://[invalid/live/stream.m3u8").is_none());
        assert!(normalize_media_url("ftp://cdn.example/live/stream.m3u8").is_none());
    }

    #[test]
    fn regular_single_url_capture_preserves_valid_headers_and_referer() {
        let download = normalize_download(ExtensionRequest {
            urls: vec!["https://example.com/private.zip".to_string()],
            referer: Some("https://example.com/folder".to_string()),
            silent: true,
            filename: None,
            headers: Some("Authorization: Bearer test\nX-Trace: safe".to_string()),
            cookies: Some("session=browser-cookie-header".to_string()),
            cookie_scopes: None,
            media: false,
            torrent: false,
            batch: false,
            batch_name: None,
            torrent_bytes_base64: None,
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        })
        .expect("valid ordinary download handoff");

        assert_eq!(
            download.headers.as_deref(),
            Some("Authorization: Bearer test\nX-Trace: safe")
        );
        assert_eq!(download.referer.as_deref(), Some("https://example.com/folder"));
        assert_eq!(download.cookies.as_deref(), Some("session=browser-cookie-header"));
    }

    #[test]
    fn regular_referers_reject_credentials_and_strip_fragments() {
        assert_eq!(
            normalize_referer(
                Some("https://example.com/folder?session=short#local-only".to_string()),
            ),
            Some("https://example.com/folder?session=short".to_string())
        );

        for invalid in [
            "ftp://example.com/folder",
            "https://user:password@example.com/folder",
            "https://",
            "https://example.com/folder\nX-Injected: yes",
        ] {
            assert_eq!(normalize_referer(Some(invalid.to_string())), None);
        }

        let oversized = format!(
            "https://example.com/{}",
            "x".repeat(MAX_MEDIA_REFERER_BYTES)
        );
        assert_eq!(normalize_referer(Some(oversized)), None);
    }

    #[test]
    fn regular_capture_preserves_the_extension_cookie_header() {
        let download = normalize_download(ExtensionRequest {
            urls: vec!["https://example.com/private.zip".to_string()],
            referer: None,
            silent: true,
            filename: None,
            headers: None,
            cookies: Some("session=browser-cookie-header".to_string()),
            cookie_scopes: None,
            media: false,
            torrent: false,
            batch: false,
            batch_name: None,
            torrent_bytes_base64: None,
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        })
        .expect("valid download handoff");

        assert!(!download.media);
        assert_eq!(
            download.cookies.as_deref(),
            Some("session=browser-cookie-header")
        );
    }

    #[test]
    fn multi_url_capture_drops_shared_credentials_but_keeps_safe_headers() {
        let download = normalize_download(ExtensionRequest {
            urls: vec![
                "https://one.example/file.zip".to_string(),
                "https://two.example/file.zip".to_string(),
            ],
            referer: None,
            silent: false,
            filename: None,
            headers: Some(
                "X-Api-Key: shared-secret\nX-Request-Signature: signature-secret\n: malformed\nUser-Agent: Firefox\nX-Trace: safe"
                    .to_string(),
            ),
            cookies: Some("session=must-not-cross-hosts".to_string()),
            cookie_scopes: None,
            media: false,
            torrent: false,
            batch: true,
            batch_name: Some("batch".to_string()),
            torrent_bytes_base64: None,
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        })
        .expect("valid multi-url handoff");

        assert!(download.batch);
        assert!(download.cookies.is_none());
        assert_eq!(
            download.headers.as_deref(),
            Some("User-Agent: Firefox\nX-Trace: safe")
        );
    }

    #[test]
    fn torrent_handoff_accepts_magnets_and_preserves_the_intent() {
        let download = normalize_download(ExtensionRequest {
            urls: vec![
                "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567".to_string(),
            ],
            referer: None,
            silent: false,
            filename: None,
            headers: None,
            cookies: None,
            cookie_scopes: None,
            media: false,
            torrent: true,
            batch: false,
            batch_name: None,
            torrent_bytes_base64: None,
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        })
        .expect("valid magnet torrent handoff");

        assert!(download.torrent);
        assert_eq!(download.urls[0], "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567");

        let opaque = normalize_download(ExtensionRequest {
            urls: vec!["https://example.com/download?id=opaque".to_string()],
            referer: None,
            silent: true,
            filename: None,
            headers: None,
            cookies: None,
            cookie_scopes: None,
            media: false,
            torrent: true,
            batch: false,
            batch_name: None,
            torrent_bytes_base64: None,
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        })
        .expect("explicit opaque torrent handoff");
        assert!(opaque.torrent);

        let legacy_magnet = normalize_download(ExtensionRequest {
            urls: vec![
                "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567".to_string(),
            ],
            referer: None,
            silent: false,
            filename: None,
            headers: None,
            cookies: None,
            cookie_scopes: None,
            media: false,
            torrent: false,
            batch: false,
            batch_name: None,
            torrent_bytes_base64: None,
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        })
        .expect("legacy magnet handoff");
        assert!(legacy_magnet.torrent);
    }

    #[test]
    fn browser_local_torrent_bytes_are_normalized_as_a_single_http_sourced_torrent() {
        let bytes = b"d4:infod6:lengthi5e4:name4:testee".to_vec();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let download = normalize_download(ExtensionRequest {
            urls: vec!["https://privatebin.example/paste".to_string()],
            referer: Some("https://privatebin.example/paste".to_string()),
            silent: true,
            filename: Some("TerraScape.TORRENT".to_string()),
            headers: None,
            cookies: None,
            cookie_scopes: None,
            media: false,
            torrent: true,
            batch: false,
            batch_name: None,
            torrent_bytes_base64: Some(encoded),
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        })
        .expect("browser-local torrent bytes should be accepted");

        assert!(download.torrent);
        assert_eq!(download.urls, vec!["https://privatebin.example/paste"]);
        assert_eq!(download.filename.as_deref(), Some("TerraScape.TORRENT"));
        assert_eq!(download.torrent_bytes.as_deref(), Some(bytes.as_slice()));
        assert!(download.torrent_path.is_none());
    }

    #[test]
    fn browser_local_torrent_bytes_require_valid_bencoded_metadata_and_http_source() {
        let valid = base64::engine::general_purpose::STANDARD
            .encode(b"d4:infod6:lengthi5e4:name4:testee");
        let invalid = base64::engine::general_purpose::STANDARD.encode(b"not a torrent");

        assert!(decode_torrent_bytes(&invalid).is_none());
        assert!(normalize_download(ExtensionRequest {
            urls: vec!["blob:https://privatebin.example/attachment".to_string()],
            referer: None,
            silent: true,
            filename: Some("download.torrent".to_string()),
            headers: None,
            cookies: None,
            cookie_scopes: None,
            media: false,
            torrent: true,
            batch: false,
            batch_name: None,
            torrent_bytes_base64: Some(valid.clone()),
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        })
        .is_none());
        assert!(normalize_download(ExtensionRequest {
            urls: vec!["https://privatebin.example/paste".to_string()],
            referer: None,
            silent: true,
            filename: Some("download.torrent".to_string()),
            headers: None,
            cookies: None,
            cookie_scopes: None,
            media: true,
            torrent: true,
            batch: false,
            batch_name: None,
            torrent_bytes_base64: Some(valid),
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        })
        .is_none());
    }

    #[test]
    fn regular_capture_normalizes_host_scoped_cookie_headers() {
        let download = normalize_download(ExtensionRequest {
            urls: vec!["https://mail.google.com/mail/u/0/?view=att".to_string()],
            referer: Some("https://mail.google.com/mail/u/0/".to_string()),
            silent: true,
            filename: Some("report.zip".to_string()),
            headers: None,
            cookies: Some("SID=mail-session".to_string()),
            cookie_scopes: Some(vec![
                ExtensionCookieScope {
                    url: "https://mail.google.com/".to_string(),
                    cookies: "SID=mail-session".to_string(),
                },
                ExtensionCookieScope {
                    url: "https://accounts.google.com/".to_string(),
                    cookies: "SID=account-session".to_string(),
                },
                ExtensionCookieScope {
                    url: "https://mail.google.com/another-path".to_string(),
                    cookies: "duplicate=ignored".to_string(),
                },
            ]),
            media: false,
            torrent: false,
            batch: false,
            batch_name: None,
            torrent_bytes_base64: None,
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        })
        .expect("valid download handoff");

        assert_eq!(download.cookies.as_deref(), Some("SID=mail-session"));
        assert_eq!(
            download.cookie_scopes.as_ref().map(|scopes| scopes.len()),
            Some(2)
        );
        assert_eq!(
            download.cookie_scopes.as_ref().unwrap()[1].cookies,
            "SID=account-session"
        );
    }

    #[test]
    fn multi_url_capture_drops_cookie_scope_but_preserves_safe_headers() {
        let download = normalize_download(ExtensionRequest {
            urls: vec![
                "https://one.example/private.zip".to_string(),
                "https://two.example/file.zip".to_string(),
            ],
            referer: None,
            silent: true,
            filename: None,
            headers: Some("Cookie: session=secret\nUser-Agent: Firefox".to_string()),
            cookies: Some("session=secret".to_string()),
            cookie_scopes: None,
            media: false,
            torrent: false,
            batch: false,
            batch_name: None,
            torrent_bytes_base64: None,
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        })
        .expect("valid multi-url handoff");

        assert_eq!(download.cookies, None);
        assert_eq!(download.headers.as_deref(), Some("User-Agent: Firefox"));
    }

    #[test]
    fn selected_link_batches_preserve_context_only_for_two_or_more_urls() {
        let download = normalize_download(ExtensionRequest {
            urls: vec![
                "https://example.com/one.zip".to_string(),
                "https://example.com/two.zip".to_string(),
            ],
            referer: Some("https://example.com/gallery".to_string()),
            silent: false,
            filename: None,
            headers: None,
            cookies: None,
            cookie_scopes: None,
            media: false,
            torrent: false,
            batch: true,
            batch_name: Some("Example Gallery / Chapter: 1".to_string()),
            torrent_bytes_base64: None,
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        })
        .expect("valid selected-link batch");

        assert!(download.batch);
        assert_eq!(
            download.batch_name.as_deref(),
            Some("Example Gallery / Chapter: 1")
        );
    }

    #[test]
    fn selected_link_batch_context_is_dropped_for_single_urls() {
        let download = normalize_download(ExtensionRequest {
            urls: vec!["https://example.com/one.zip".to_string()],
            referer: Some("https://example.com/gallery".to_string()),
            silent: false,
            filename: None,
            headers: None,
            cookies: None,
            cookie_scopes: None,
            media: false,
            torrent: false,
            batch: true,
            batch_name: Some("Example Gallery".to_string()),
            torrent_bytes_base64: None,
            handoff_id: None,
            phase: None,
            media_protocol_version: None,
        })
        .expect("valid single-link handoff");

        assert!(!download.batch);
        assert!(download.batch_name.is_none());
    }

    #[test]
    fn signs_server_proof_with_timestamp_nonce_and_bound_port() {
        let token = Arc::new(RwLock::new("pairing-token".to_string()));
        let timestamp = "1710000000000";
        let nonce = "0123456789abcdef0123456789abcdef";
        let port = 6414;

        let mut mac = Hmac::<Sha256>::new_from_slice(b"pairing-token").unwrap();
        mac.update(b"firelink-server-proof\n");
        mac.update(timestamp.as_bytes());
        mac.update(b"\n");
        mac.update(nonce.as_bytes());
        mac.update(b"\n");
        mac.update(port.to_string().as_bytes());
        let expected = mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();

        assert_eq!(
            sign_server_proof(timestamp, nonce, port, &token).unwrap(),
            expected
        );
        assert_ne!(
            sign_server_proof(timestamp, nonce, port + 1, &token).unwrap(),
            expected
        );
    }

    #[test]
    fn sanitize_filename_strips_path_traversal_and_rejects_empty_or_special_names() {
        assert_eq!(sanitize_filename("../../etc/passwd"), Some("passwd".to_string()));
        assert_eq!(
            sanitize_filename(r"..\..\Windows\System32\calc.exe"),
            Some("calc.exe".to_string())
        );
        assert_eq!(
            sanitize_filename("valid_report.pdf"),
            Some("valid_report.pdf".to_string())
        );
        assert!(sanitize_filename(".").is_none());
        assert!(sanitize_filename("..").is_none());
        assert!(sanitize_filename("").is_none());
        assert!(sanitize_filename("   ").is_none());
        assert!(sanitize_filename(&"a".repeat(256)).is_none());
    }

    #[test]
    fn normalize_url_rejects_dangerous_or_unsupported_schemes() {
        assert!(normalize_url("file:///etc/passwd").is_none());
        assert!(normalize_url("javascript:alert(1)").is_none());
        assert!(normalize_url("data:text/html,<h1>test</h1>").is_none());
        assert!(normalize_url("blob:https://example.com/uuid").is_none());
        assert_eq!(
            normalize_url("https://example.com/file.zip"),
            Some("https://example.com/file.zip".to_string())
        );
        assert_eq!(
            normalize_url("http://example.com/file.zip"),
            Some("http://example.com/file.zip".to_string())
        );
        assert_eq!(
            normalize_url("ftp://example.com/file.zip"),
            Some("ftp://example.com/file.zip".to_string())
        );
        assert_eq!(
            normalize_url("sftp://example.com/file.zip"),
            Some("sftp://example.com/file.zip".to_string())
        );
        assert_eq!(
            normalize_url("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"),
            Some("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567".to_string())
        );
    }

    #[test]
    fn same_origin_url_strictly_matches_scheme_host_and_port() {
        assert!(same_origin_url(
            "https://example.com/path1",
            "https://example.com/path2"
        ));
        assert!(!same_origin_url(
            "http://example.com/path",
            "https://example.com/path"
        ));
        assert!(!same_origin_url(
            "https://example.com:8443/path",
            "https://example.com/path"
        ));
        assert!(!same_origin_url(
            "https://other.example/path",
            "https://example.com/path"
        ));
    }
}

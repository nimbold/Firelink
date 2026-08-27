use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Router,
};
use hmac::{Hmac, KeyInit, Mac};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
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
const MAX_REQUEST_BODY_BYTES: usize = 256 * 1024;
const SIGNATURE_MAX_AGE_MS: u64 = 60_000;
const SERVER_HEADER: &str = "x-firelink-server";
const PROTOCOL_VERSION_HEADER: &str = "x-firelink-protocol-version";
const CLIENT_NONCE_HEADER: &str = "x-firelink-client-nonce";
const SERVER_PROOF_HEADER: &str = "x-firelink-server-proof";
const SERVER_PORT_HEADER: &str = "x-firelink-server-port";
const SMOKE_PROCESS_ID_HEADER: &str = "x-firelink-smoke-process-id";
const SERVER_PROOF_PREFIX: &[u8] = b"firelink-server-proof\n";
const PROTOCOL_VERSION: &str = "5";
const MAX_PENDING_EXTENSION_ACKS: usize = 64;
const EXTENSION_ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

type HmacSha256 = Hmac<Sha256>;
pub type SharedExtensionToken = Arc<RwLock<String>>;
pub type SharedFrontendReady = Arc<AtomicBool>;
pub type SharedServerPort = Arc<RwLock<Option<u16>>>;
pub type SharedExtensionAcks = Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>;
type ReplayCache = Arc<Mutex<HashMap<String, u64>>>;

#[derive(Clone)]
pub struct ServerState {
    pub app_handle: AppHandle,
    pub pairing_token: SharedExtensionToken,
    pub frontend_ready: SharedFrontendReady,
    pub extension_acks: SharedExtensionAcks,
    pub replay_cache: ReplayCache,
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
}

pub async fn start_server(
    app_handle: AppHandle,
    pairing_token: SharedExtensionToken,
    frontend_ready: SharedFrontendReady,
    extension_acks: SharedExtensionAcks,
    server_port: SharedServerPort,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let (port, listener) = bind_extension_listener().await?;
    let state = ServerState {
        app_handle,
        pairing_token,
        frontend_ready,
        extension_acks,
        replay_cache: Arc::new(Mutex::new(HashMap::new())),
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

    let timestamp = match verify_signature(signature, timestamp_str, &body, &state.pairing_token) {
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
    Ok(response)
}

async fn download_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, StatusCode> {
    let nonce = match required_client_nonce(&headers) {
        Some(nonce) if has_allowed_request_origin(&headers) => nonce,
        _ => return Err(StatusCode::FORBIDDEN),
    };

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

    let timestamp = match verify_signature(signature, timestamp_str, &body, &state.pairing_token) {
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

    let download = match normalize_download(payload) {
        Some(v) => v,
        None => return Err(StatusCode::BAD_REQUEST),
    };

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
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let ack_receiver = register_extension_ack(&state.extension_acks, request_id.clone())
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let mut download = download;
    download.request_id = Some(request_id.clone());

    if state
        .app_handle
        .emit("extension-add-download", download)
        .is_err()
    {
        remove_extension_ack(&state.extension_acks, &request_id);
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    if tokio::time::timeout(EXTENSION_ACK_TIMEOUT, ack_receiver)
        .await
        .is_err()
    {
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

fn remove_extension_ack(registry: &SharedExtensionAcks, request_id: &str) {
    if let Ok(mut pending) = registry.lock() {
        pending.remove(request_id);
    }
}

fn normalize_download(mut payload: ExtensionRequest) -> Option<ExtensionDownload> {
    if payload.urls.len() > MAX_URL_COUNT {
        return None;
    }

    let mut seen = HashSet::new();
    let urls = payload
        .urls
        .into_iter()
        .filter_map(|raw_url| normalize_url(&raw_url))
        .filter(|url| seen.insert(url.clone()))
        .collect::<Vec<_>>();
    if urls.is_empty() {
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
                    || filename_is_torrent(payload.filename.as_deref())
                    || url.path().to_ascii_lowercase().ends_with(".torrent"))
        });
    if payload.torrent && !torrent {
        return None;
    }

    let referer = payload.referer.and_then(|value| {
        let url = Url::parse(value.trim()).ok()?;
        matches!(url.scheme(), "http" | "https").then(|| url.to_string())
    });
    let filename = payload.filename.and_then(|value| sanitize_filename(&value));
    let batch = payload.batch && urls.len() >= 2;
    let batch_name = batch
        .then_some(payload.batch_name)
        .flatten()
        .and_then(|value| {
            let value = value.trim().to_string();
            (!value.is_empty() && value.chars().count() <= 512).then_some(value)
        });
    // A multi-URL handoff has no per-URL cookie scope. Keep ordinary
    // request headers, but drop credential-bearing headers and the dedicated cookie field
    // so a legacy or untrusted caller cannot reuse one session across hosts.
    let headers = normalize_headers(payload.headers, payload.media || urls.len() > 1);
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

fn normalize_headers(headers: Option<String>, media: bool) -> Option<String> {
    let headers = headers?;
    if !media {
        return (!headers.trim().is_empty()).then_some(headers);
    }

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

fn normalize_url(raw_url: &str) -> Option<String> {
    let url = Url::parse(raw_url.trim()).ok()?;
    matches!(url.scheme(), "http" | "https" | "ftp" | "sftp" | "magnet")
        .then(|| url.to_string())
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
        acknowledge_extension_download, add_server_identity, claim_request_at,
        has_allowed_request_origin, is_valid_client_nonce, normalize_download,
        required_client_nonce, sign_server_proof, ExtensionCookieScope, ExtensionRequest,
        MAX_URL_COUNT, PROTOCOL_VERSION_HEADER, SERVER_HEADER,
    };
    use axum::{
        http::{HeaderMap, HeaderValue, StatusCode},
        middleware,
        routing::get,
        Router,
    };
    use hmac::{Hmac, KeyInit, Mac};
    use sha2::Sha256;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, RwLock};

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
            "5"
        );

        server.abort();
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

    #[test]
    fn explicit_media_drops_the_extension_cookie_header() {
        let download = normalize_download(ExtensionRequest {
            urls: vec!["https://www.youtube.com/watch?v=example".to_string()],
            referer: None,
            silent: false,
            filename: None,
            headers: Some(format!(
                "Cookie: stale={};\nCookie2: stale=1\nAuthorization: Bearer stale\nProxy-Authorization: Basic stale\nSet-Cookie: stale=1\nSet-Cookie2: stale=1\nX-Api-Key: stale\nX-Auth-Token: stale\nX-Access-Token: stale\nX-Request-Signature: stale\nX-Session: stale\n: malformed\nUser-Agent: Firefox\nX-Trace: safe",
                "x".repeat(64 * 1024)
            )),
            cookies: Some(format!("large={}", "x".repeat(64 * 1024))),
            cookie_scopes: None,
            media: true,
            torrent: false,
            batch: false,
            batch_name: None,
        })
        .expect("valid media handoff");

        assert!(download.media);
        assert!(download.cookies.is_none());
        assert_eq!(
            download.headers.as_deref(),
            Some("User-Agent: Firefox\nX-Trace: safe")
        );
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
        })
        .expect("legacy magnet handoff");
        assert!(legacy_magnet.torrent);
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
}

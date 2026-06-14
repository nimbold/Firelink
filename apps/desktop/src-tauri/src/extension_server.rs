use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode, Method},
    routing::{get, post},
    Router,
};
use hmac::{Hmac, Mac};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tower_http::cors::{Any, CorsLayer};

pub const EXTENSION_SERVER_PORT: u16 = 23522;
const MAX_URL_COUNT: usize = 200;
const SIGNATURE_MAX_AGE_MS: u64 = 60_000;

type HmacSha256 = Hmac<Sha256>;
pub type SharedExtensionToken = Arc<RwLock<String>>;
pub type SharedFrontendReady = Arc<AtomicBool>;
type ReplayCache = Arc<Mutex<HashMap<String, u64>>>;

#[derive(Clone)]
pub struct ServerState {
    pub app_handle: AppHandle,
    pub pairing_token: SharedExtensionToken,
    pub frontend_ready: SharedFrontendReady,
    pub replay_cache: ReplayCache,
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
}

#[derive(Clone, Serialize)]
struct ExtensionDownload {
    urls: Vec<String>,
    referer: Option<String>,
    silent: bool,
    filename: Option<String>,
}

pub async fn start_server(
    app_handle: AppHandle,
    pairing_token: SharedExtensionToken,
    frontend_ready: SharedFrontendReady,
) -> Result<(), String> {
    let state = ServerState {
        app_handle,
        pairing_token,
        frontend_ready,
        replay_cache: Arc::new(Mutex::new(HashMap::new())),
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
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", EXTENSION_SERVER_PORT))
        .await
        .map_err(|e| format!("Failed to bind to {}: {}", EXTENSION_SERVER_PORT, e))?;

    axum::serve(listener, app)
        .await
        .map_err(|e| format!("Server error: {}", e))?;

    Ok(())
}

async fn ping_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    if !state.frontend_ready.load(Ordering::Acquire) {
        return StatusCode::SERVICE_UNAVAILABLE;
    }

    let signature = match headers.get("x-firelink-signature").and_then(|v| v.to_str().ok()) {
        Some(v) => v,
        None => return StatusCode::FORBIDDEN,
    };

    let timestamp_str = match headers.get("x-firelink-timestamp").and_then(|v| v.to_str().ok()) {
        Some(v) => v,
        None => return StatusCode::FORBIDDEN,
    };

    if verify_signature(signature, timestamp_str, &body, &state.pairing_token).is_err() {
        return StatusCode::FORBIDDEN;
    }

    StatusCode::OK
}

async fn download_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, StatusCode> {
    if !state.frontend_ready.load(Ordering::Acquire) {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    let signature = match headers.get("x-firelink-signature").and_then(|v| v.to_str().ok()) {
        Some(v) => v,
        None => return Err(StatusCode::FORBIDDEN),
    };

    let timestamp_str = match headers.get("x-firelink-timestamp").and_then(|v| v.to_str().ok()) {
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

    if let Some(window) = state.app_handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }

    if state.app_handle.emit("extension-add-download", download).is_err() {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    Ok(StatusCode::OK)
}

fn normalize_download(payload: ExtensionRequest) -> Option<ExtensionDownload> {
    let mut seen = HashSet::new();
    let urls = payload
        .urls
        .into_iter()
        .take(MAX_URL_COUNT)
        .filter_map(|raw_url| normalize_url(&raw_url))
        .filter(|url| seen.insert(url.clone()))
        .collect::<Vec<_>>();
    if urls.is_empty() {
        return None;
    }

    let referer = payload.referer.and_then(|value| {
        let url = Url::parse(value.trim()).ok()?;
        matches!(url.scheme(), "http" | "https").then(|| url.to_string())
    });
    let filename = payload.filename.and_then(|value| sanitize_filename(&value));

    Some(ExtensionDownload {
        urls,
        referer,
        silent: payload.silent,
        filename,
    })
}

fn normalize_url(raw_url: &str) -> Option<String> {
    let url = Url::parse(raw_url.trim()).ok()?;
    matches!(url.scheme(), "http" | "https" | "ftp" | "sftp").then(|| url.to_string())
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

    let token = pairing_token.read().map_err(|_| ())?;
    if token.is_empty() {
        return Err(());
    }

    let mut mac = HmacSha256::new_from_slice(token.as_bytes()).map_err(|_| ())?;
    mac.update(timestamp_text.as_bytes());
    mac.update(body);
    mac.verify_slice(&signature).map_err(|_| ())?;
    Ok(timestamp)
}

fn claim_request(signature: &str, timestamp: u64, replay_cache: &ReplayCache) -> bool {
    let now = match current_time_millis() {
        Some(now) => now,
        None => return false,
    };
    let mut cache = match replay_cache.lock() {
        Ok(cache) => cache,
        Err(_) => return false,
    };
    cache.retain(|_, seen_at| now.saturating_sub(*seen_at) < SIGNATURE_MAX_AGE_MS);
    let key = format!("{timestamp}:{}", signature.to_ascii_lowercase());
    cache.insert(key, now).is_none()
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

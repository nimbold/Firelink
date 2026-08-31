use base64::Engine as _;
use crate::ipc::{
    DownloadAllocationEvent, DownloadStateEvent, DownloadStateProgress, DownloadStatus,
    QueueDirection,
};
use crate::power::PowerManager;
use crate::retry::{
    aria2_error_code, backoff_and_emit, is_transient_network_error, network_error_class,
    BackoffOutcome, MAX_RETRIES,
};
use log;
use serde::Deserialize;
use serde_json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, Notify, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};
use ts_rs::TS;

/// Default capacity when no setting is read yet.
pub const DEFAULT_MAX_CONCURRENT: usize = 3;
pub const MAX_QUEUE_CONCURRENT: usize = 12;
const MAX_PENDING_DOWNLOAD_STARTS: usize = 1024;
pub const MEDIA_RUN_CANCELLED: &str = "__firelink_media_run_cancelled__";
pub const DOWNLOAD_CONNECTIONS_MIN: i32 = 1;
pub const DOWNLOAD_CONNECTIONS_MAX: i32 = 16;
pub const MAX_TORRENT_PIECE_PRIORITY_SIZE_MIB: u64 = 1024;
pub const MAX_TORRENT_TRACKER_TIMEOUT: u32 = 604_800;
pub const MAX_TORRENT_TRACKER_INTERVAL: u32 = 604_800;
pub const DEFAULT_TORRENT_MAX_OPEN_FILES: u32 = 100;
pub const MIN_TORRENT_MAX_OPEN_FILES: u32 = 1;
pub const MAX_TORRENT_MAX_OPEN_FILES: u32 = 4_096;
pub const DEFAULT_TORRENT_DHT_MESSAGE_TIMEOUT: u32 = 10;
pub const MIN_TORRENT_DHT_MESSAGE_TIMEOUT: u32 = 1;
// Aria2 1.37.0 rejects values above 60 during option parsing. Keep this
// boundary aligned with the bundled engine so a saved setting cannot prevent
// the daemon from starting.
pub const MAX_TORRENT_DHT_MESSAGE_TIMEOUT: u32 = 60;
pub const DEFAULT_TORRENT_MAX_CONCURRENT_SEEDS: u32 = 2;
pub const MIN_TORRENT_MAX_CONCURRENT_SEEDS: u32 = 1;
pub const MAX_TORRENT_MAX_CONCURRENT_SEEDS: u32 = 64;
pub const MAX_TORRENT_NETWORK_VALUE_LENGTH: usize = 256;
pub const MAX_TORRENT_PEER_ID_PREFIX_BYTES: usize = 20;
pub const MAX_TORRENT_PEER_AGENT_LENGTH: usize = 128;
pub const MAX_TORRENT_PIECES_FOR_PROGRESS: u64 = 10_000_000;
pub const MAX_TORRENT_AVAILABILITY_PEERS: usize = 4_096;
/// Poller gaps beyond this bounded interval are treated conservatively. In
/// particular, a suspended machine must not accrue wall-clock seed time.
pub const MAX_TORRENT_SEED_ACCOUNTING_INTERVAL_SECS: u64 = 5;
pub const MAX_TORRENT_WEB_SEEDS: usize = 256;
pub const MAX_TORRENT_WEB_SEED_URI_LENGTH: usize = 2_048;
pub const MIN_TORRENT_LISTEN_PORT: u16 = 1024;
pub const DEFAULT_TORRENT_LISTEN_PORT_SPEC: &str = "6881-6999";
pub const DEFAULT_ARIA2_DISK_CACHE: &str = "16M";
pub const MAX_ARIA2_DISK_CACHE_MIB: u64 = 1024;
pub const MAX_MINIMUM_NORMAL_DOWNLOAD_SPEED_KIB: u32 = 1_048_576;
const MAX_ARIA2_MAGNET_FOLLOWED_GIDS: usize = 16;
const ARIA2_MAGNET_CHILD_HANDOFF_TIMEOUT: Duration = Duration::from_secs(60);

/// A per-download zero is different from an empty/global limit: Aria2 uses
/// `0` to remove the item cap, which intentionally lets an item override the
/// daemon-wide limit. Keep that sentinel through payloads, retries, and live
/// GID updates instead of normalizing it to `None`.
fn normalize_download_speed_limit(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed == "0" {
        Some("0".to_string())
    } else {
        crate::normalize_speed_limit_for_aria2(trimmed)
    }
}

pub fn normalize_minimum_normal_download_speed_kib(value: u32) -> Result<u32, String> {
    if value > MAX_MINIMUM_NORMAL_DOWNLOAD_SPEED_KIB {
        return Err(format!(
            "minimum normal download speed must be between 0 and {MAX_MINIMUM_NORMAL_DOWNLOAD_SPEED_KIB} KiB/s"
        ));
    }
    Ok(value)
}

pub fn normalize_sftp_host_key_md(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let (kind, digest) = value
        .split_once('=')
        .ok_or_else(|| "SFTP host-key fingerprint must use TYPE=DIGEST form".to_string())?;
    let kind = kind.trim().to_ascii_lowercase();
    let digest = digest.trim().to_ascii_lowercase();
    let expected_length = match kind.as_str() {
        "md5" => 32,
        "sha-1" => 40,
        _ => return Err("SFTP host-key fingerprint type must be md5 or sha-1".to_string()),
    };
    if digest.len() != expected_length || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "SFTP {kind} host-key fingerprint must contain exactly {expected_length} hexadecimal characters"
        ));
    }
    Ok(Some(format!("{kind}={digest}")))
}

pub fn normalize_torrent_bind_address(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.len() > MAX_TORRENT_NETWORK_VALUE_LENGTH
        || value.chars().any(char::is_control)
    {
        return Err("Torrent bind address is too long or contains control characters".to_string());
    }
    let address = value
        .parse::<std::net::IpAddr>()
        .map_err(|_| "Torrent bind address must be a valid IPv4 or IPv6 address".to_string())?;
    Ok(Some(address.to_string()))
}

pub fn normalize_aria2_disk_cache(value: Option<&str>) -> Result<String, String> {
    let value = value.map(str::trim).filter(|value| !value.is_empty()).unwrap_or(DEFAULT_ARIA2_DISK_CACHE);
    if value == "0" {
        return Ok("0".to_string());
    }
    let (digits, multiplier, suffix) = match value.as_bytes().last().copied() {
        Some(b'k' | b'K') => (&value[..value.len() - 1], 1_u64, "K"),
        Some(b'm' | b'M') => (&value[..value.len() - 1], 1024_u64, "M"),
        _ => return Err("Aria2 disk cache must be 0 or a positive value ending in K or M".to_string()),
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Aria2 disk cache must be 0 or a positive value ending in K or M".to_string());
    }
    let amount = digits
        .parse::<u64>()
        .map_err(|_| "Aria2 disk cache is too large".to_string())?;
    let kib = amount
        .checked_mul(multiplier)
        .ok_or_else(|| "Aria2 disk cache is too large".to_string())?;
    if kib == 0 || kib > MAX_ARIA2_DISK_CACHE_MIB * 1024 {
        return Err(format!(
            "Aria2 disk cache must be between 1K and {MAX_ARIA2_DISK_CACHE_MIB}M"
        ));
    }
    Ok(format!("{amount}{suffix}"))
}

pub fn normalize_torrent_file_allocation(value: Option<&str>) -> Result<String, String> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok("prealloc".to_string()),
        Some("prealloc") => Ok("prealloc".to_string()),
        Some("none") => Ok("none".to_string()),
        Some(_) => Err("Torrent file allocation must be prealloc or none".to_string()),
    }
}

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

pub fn normalize_torrent_dht_message_timeout(value: u32) -> Result<u32, String> {
    if !(MIN_TORRENT_DHT_MESSAGE_TIMEOUT..=MAX_TORRENT_DHT_MESSAGE_TIMEOUT).contains(&value) {
        return Err(format!(
            "DHT message timeout must be between {MIN_TORRENT_DHT_MESSAGE_TIMEOUT} and {MAX_TORRENT_DHT_MESSAGE_TIMEOUT} seconds"
        ));
    }
    Ok(value)
}

pub(crate) fn normalize_torrent_web_seed_uri(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_TORRENT_WEB_SEED_URI_LENGTH {
        return Err(format!(
            "Torrent web-seed URIs must be between 1 and {MAX_TORRENT_WEB_SEED_URI_LENGTH} bytes"
        ));
    }
    if value.chars().any(char::is_control) {
        return Err("Torrent web-seed URIs must not contain control characters".to_string());
    }
    let parsed = url::Url::parse(value).map_err(|_| "Torrent web-seed URI is invalid".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Torrent web-seed URI must use HTTP or HTTPS".to_string());
    }
    if parsed.host_str().is_none_or(str::is_empty)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Torrent web-seed URI must have a host and no credentials or fragment".to_string());
    }
    crate::network::validate_url(
        &parsed,
        &["http", "https"],
        crate::network::CredentialPolicy::Reject(
            "Torrent web-seed URI must have a host and no credentials or fragment",
        ),
    )?;
    Ok(parsed.to_string())
}

pub fn normalize_torrent_web_seeds(
    seeds: Option<&[crate::ipc::TorrentWebSeed]>,
    files: &[crate::ipc::TorrentFile],
) -> Result<Vec<crate::ipc::TorrentWebSeed>, String> {
    let Some(seeds) = seeds else {
        return Ok(Vec::new());
    };
    if seeds.len() > MAX_TORRENT_WEB_SEEDS {
        return Err(format!("a Torrent may have at most {MAX_TORRENT_WEB_SEEDS} web seeds"));
    }
    let mut normalized = Vec::with_capacity(seeds.len());
    let mut seen = HashSet::new();
    for seed in seeds {
        if !files.iter().any(|file| file.index == seed.file_index) {
            return Err(format!("Torrent web-seed file index {} is out of range", seed.file_index));
        }
        let uri = normalize_torrent_web_seed_uri(&seed.uri)?;
        if seen.insert((seed.file_index, uri.clone())) {
            normalized.push(crate::ipc::TorrentWebSeed {
                file_index: seed.file_index,
                uri,
            });
        }
    }
    Ok(normalized)
}

pub(crate) fn normalize_torrent_mirror_uris(
    mirrors: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut normalized = Vec::new();
    for uri in crate::collect_download_uris("", mirrors) {
        let uri = normalize_torrent_web_seed_uri(&uri)?;
        if !normalized.iter().any(|existing| existing == &uri) {
            if normalized.len() >= MAX_TORRENT_WEB_SEEDS {
                return Err(format!(
                    "a Torrent may have at most {MAX_TORRENT_WEB_SEEDS} fallback web seeds"
                ));
            }
            normalized.push(uri);
        }
    }
    Ok(normalized)
}

fn expand_torrent_web_seed_uri(
    seed: &crate::ipc::TorrentWebSeed,
    files: &[crate::ipc::TorrentFile],
) -> Result<String, String> {
    let uri = normalize_torrent_web_seed_uri(&seed.uri)?;
    if files.len() <= 1 {
        return Ok(uri);
    }
    let file = files
        .iter()
        .find(|file| file.index == seed.file_index)
        .ok_or_else(|| "Torrent web-seed file index is out of range".to_string())?;
    let mut parsed = url::Url::parse(&uri).map_err(|_| "Torrent web-seed URI is invalid".to_string())?;
    let base_path = parsed.path().trim_end_matches('/').to_string();
    parsed.set_path(&base_path);
    {
        let mut path = parsed
            .path_segments_mut()
            .map_err(|_| "Torrent web-seed URI cannot accept a file path".to_string())?;
        for segment in file.path.replace('\\', "/").split('/') {
            if !segment.is_empty() && segment != "." && segment != ".." {
                path.push(segment);
            }
        }
    }
    Ok(parsed.to_string())
}

pub fn expand_torrent_web_seeds(
    seeds: &[crate::ipc::TorrentWebSeed],
    files: &[crate::ipc::TorrentFile],
) -> Result<Vec<(u32, String)>, String> {
    let normalized = normalize_torrent_web_seeds(Some(seeds), files)?;
    normalized
        .iter()
        .map(|seed| Ok((seed.file_index, expand_torrent_web_seed_uri(seed, files)?)))
        .collect()
}

type TorrentFileUriSets = HashMap<u32, HashSet<String>>;
type TorrentWebSeedPair = (u32, String);

fn normalize_aria2_torrent_file_uris(
    entries: Vec<(u32, Vec<String>)>,
    files: &[crate::ipc::TorrentFile],
) -> Result<TorrentFileUriSets, String> {
    let expected_indices = files.iter().map(|file| file.index).collect::<HashSet<_>>();
    if expected_indices.len() != files.len() || entries.len() != files.len() {
        return Err("aria2.getFiles returned an unexpected Torrent file set".to_string());
    }

    let mut normalized = HashMap::with_capacity(entries.len());
    for (file_index, uris) in entries {
        if file_index == 0 || !expected_indices.contains(&file_index) {
            return Err("aria2.getFiles returned an unknown Torrent file index".to_string());
        }
        if normalized.contains_key(&file_index) {
            return Err("aria2.getFiles returned a duplicate Torrent file index".to_string());
        }
        if uris.len() > MAX_TORRENT_WEB_SEEDS.saturating_mul(3) {
            return Err(
                "aria2.getFiles returned too many Torrent web seeds for one file".to_string(),
            );
        }
        let mut file_uris = HashSet::with_capacity(uris.len());
        for uri in uris {
            file_uris.insert(normalize_torrent_web_seed_uri(&uri)?);
        }
        normalized.insert(file_index, file_uris);
    }

    if files
        .iter()
        .any(|file| !normalized.contains_key(&file.index))
    {
        return Err("aria2.getFiles omitted a Torrent file".to_string());
    }
    Ok(normalized)
}

fn parse_aria2_torrent_file_uris(
    value: &serde_json::Value,
) -> Result<Vec<(u32, Vec<String>)>, String> {
    let entries = value
        .as_array()
        .ok_or_else(|| "aria2.getFiles returned a non-array result".to_string())?;
    let mut file_uris = Vec::with_capacity(entries.len());
    for entry in entries {
        let object = entry
            .as_object()
            .ok_or_else(|| "aria2.getFiles returned malformed Torrent file data".to_string())?;
        let file_index = parse_aria2_decimal(object.get("index"), "file index")?
            .try_into()
            .map_err(|_| "aria2.getFiles returned an invalid Torrent file index".to_string())?;
        let uris = object
            .get("uris")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| "aria2.getFiles returned malformed Torrent URI data".to_string())?;
        let mut parsed_uris = Vec::with_capacity(uris.len());
        for entry in uris {
            let uri = entry
                .get("uri")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    "aria2.getFiles returned a malformed Torrent URI entry".to_string()
                })?;
            parsed_uris.push(uri.to_string());
        }
        file_uris.push((file_index, parsed_uris));
    }
    Ok(file_uris)
}

fn expected_initial_torrent_web_seed_state(
    current: &TorrentFileUriSets,
    explicit: &[TorrentWebSeedPair],
) -> TorrentFileUriSets {
    let mut expected = current.clone();
    for (file_index, uri) in explicit {
        expected.entry(*file_index).or_default().insert(uri.clone());
    }
    expected
}

fn expand_aria2_torrent_web_seed_source(
    source: &str,
    metadata: &crate::torrent::ParsedTorrent,
    file: &crate::ipc::TorrentFile,
) -> Result<String, String> {
    let uri = normalize_torrent_web_seed_uri(source)?;
    let mut parsed =
        url::Url::parse(&uri).map_err(|_| "Torrent web-seed URI is invalid".to_string())?;
    if metadata.files.len() == 1 {
        if parsed.path().ends_with('/') {
            let mut segments = parsed
                .path_segments_mut()
                .map_err(|_| "Torrent web-seed URI cannot accept a file path".to_string())?;
            segments.push(&metadata.name);
        }
        return Ok(parsed.to_string());
    }

    {
        let mut segments = parsed
            .path_segments_mut()
            .map_err(|_| "Torrent web-seed URI cannot accept a file path".to_string())?;
        segments.push(&metadata.name);
        for segment in file.path.split('/') {
            if !segment.is_empty() && segment != "." && segment != ".." {
                segments.push(segment);
            }
        }
    }
    Ok(parsed.to_string())
}

fn expand_torrent_web_seed_sources(
    sources: &[String],
    metadata: &crate::torrent::ParsedTorrent,
) -> Result<HashSet<TorrentWebSeedPair>, String> {
    let mut expanded = HashSet::new();
    for source in sources {
        for file in &metadata.files {
            expanded.insert((
                file.index,
                expand_aria2_torrent_web_seed_source(source, metadata, file)?,
            ));
        }
    }
    Ok(expanded)
}

fn plan_torrent_web_seed_change(
    current: &TorrentFileUriSets,
    baseline: &HashSet<TorrentWebSeedPair>,
    old: &[TorrentWebSeedPair],
    new: &[TorrentWebSeedPair],
) -> Result<(TorrentFileUriSets, Vec<(u32, Vec<String>, Vec<String>)>), String> {
    if old.iter().any(|(file_index, uri)| {
        !current
            .get(file_index)
            .is_some_and(|uris| uris.contains(uri))
    }) {
        return Err("Aria2 web-seed state differs from Firelink's persisted state".to_string());
    }

    let mut allowed_current = baseline.clone();
    allowed_current.extend(old.iter().cloned());
    if current.iter().any(|(file_index, uris)| {
        uris.iter()
            .any(|uri| !allowed_current.contains(&(*file_index, uri.clone())))
    }) {
        return Err("Aria2 web-seed state differs from Firelink's persisted state".to_string());
    }

    let mut expected = current.clone();
    for (file_index, uri) in old {
        if !baseline.contains(&(*file_index, uri.clone())) {
            let Some(file_uris) = expected.get_mut(file_index) else {
                return Err("Aria2 web-seed state contains an unknown Torrent file index".to_string());
            };
            file_uris.remove(uri);
        }
    }
    for (file_index, uri) in new {
        let Some(file_uris) = expected.get_mut(file_index) else {
            return Err("Aria2 web-seed state contains an unknown Torrent file index".to_string());
        };
        file_uris.insert(uri.clone());
    }

    let mut file_indices = current.keys().copied().collect::<HashSet<_>>();
    file_indices.extend(expected.keys().copied());
    let mut file_indices = file_indices.into_iter().collect::<Vec<_>>();
    file_indices.sort_unstable();
    let mut changes = Vec::new();
    for file_index in file_indices {
        let Some(current_uris) = current.get(&file_index) else {
            return Err("Aria2 web-seed state contains an unknown Torrent file index".to_string());
        };
        let Some(expected_uris) = expected.get(&file_index) else {
            return Err("Aria2 web-seed state contains an unknown Torrent file index".to_string());
        };
        let mut delete = current_uris
            .difference(expected_uris)
            .cloned()
            .collect::<Vec<_>>();
        let mut add = expected_uris
            .difference(current_uris)
            .cloned()
            .collect::<Vec<_>>();
        delete.sort();
        add.sort();
        if !delete.is_empty() || !add.is_empty() {
            changes.push((file_index, delete, add));
        }
    }
    Ok((expected, changes))
}

pub fn normalize_torrent_max_concurrent_seeds(value: u32) -> Result<u32, String> {
    if !(MIN_TORRENT_MAX_CONCURRENT_SEEDS..=MAX_TORRENT_MAX_CONCURRENT_SEEDS).contains(&value) {
        return Err(format!(
            "maximum concurrent Torrent seeds must be between {MIN_TORRENT_MAX_CONCURRENT_SEEDS} and {MAX_TORRENT_MAX_CONCURRENT_SEEDS}"
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

#[derive(Debug, Clone)]
struct Aria2MagnetHandoffState {
    parent_gid: String,
    epoch: u64,
    started_at: Instant,
}

#[derive(Debug, Clone)]
struct Aria2MagnetChildHandoff {
    gid: String,
    status: String,
    error: Option<String>,
    pending: Option<PendingAria2Outcome>,
}

#[derive(Debug, Clone)]
enum Aria2MagnetCompletionDisposition {
    /// This GID is a normal Torrent GID, or a magnet whose final GID already
    /// owns real files. The normal terminal path remains authoritative.
    NotMetadataParent,
    /// Aria2 has completed metadata acquisition but has not exposed the
    /// payload child yet. Keep the permit and mapping alive for reconciliation.
    Deferred,
    /// The payload child was validated and atomically adopted by Firelink.
    Adopted(Aria2MagnetChildHandoff),
    /// Aria2 exposed a metadata parent but never exposed a valid payload child
    /// before the bounded handoff deadline. Fail the download instead of
    /// claiming that metadata bytes are the requested payload.
    Failed(String),
}

#[derive(Clone, Copy, Debug)]
struct Aria2ConnectionOptions {
    epoch: u64,
    effective: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TorrentTelemetrySnapshot {
    pub uploaded_bytes: u64,
    pub seeded_seconds: u64,
}

#[derive(Debug, Clone)]
struct TorrentTelemetryState {
    gid: String,
    epoch: u64,
    last_upload_length: Option<u64>,
    uploaded_bytes: u64,
    seeded_seconds: u64,
    last_observed_at: Option<Instant>,
    last_was_seeding: bool,
}

impl TorrentTelemetryState {
    fn new(gid: &str, epoch: u64, now: Instant) -> Self {
        Self {
            gid: gid.to_string(),
            epoch,
            last_upload_length: None,
            uploaded_bytes: 0,
            seeded_seconds: 0,
            last_observed_at: Some(now),
            last_was_seeding: false,
        }
    }

    fn snapshot(&self) -> TorrentTelemetrySnapshot {
        TorrentTelemetrySnapshot {
            uploaded_bytes: self.uploaded_bytes,
            seeded_seconds: self.seeded_seconds,
        }
    }

    fn observe(
        &mut self,
        gid: &str,
        epoch: u64,
        upload_length: Option<u64>,
        is_seeding: bool,
        now: Instant,
    ) -> TorrentTelemetrySnapshot {
        if self.gid != gid || self.epoch != epoch {
            // A new GID or control epoch is a new daemon counter lifecycle.
            // Preserve Firelink totals, but never interpret the new counter
            // as a continuation of the old one.
            if self.last_was_seeding {
                if let Some(previous) = self.last_observed_at {
                    let seconds = now
                        .saturating_duration_since(previous)
                        .min(Duration::from_secs(MAX_TORRENT_SEED_ACCOUNTING_INTERVAL_SECS))
                        .as_secs();
                    self.seeded_seconds = self.seeded_seconds.saturating_add(seconds);
                }
            }
            self.gid = gid.to_string();
            self.epoch = epoch;
            self.last_upload_length = None;
            self.last_observed_at = Some(now);
            self.last_was_seeding = false;
        } else if self.last_was_seeding {
            if let Some(previous) = self.last_observed_at {
                let seconds = now
                    .saturating_duration_since(previous)
                    .min(Duration::from_secs(MAX_TORRENT_SEED_ACCOUNTING_INTERVAL_SECS))
                    .as_secs();
                self.seeded_seconds = self.seeded_seconds.saturating_add(seconds);
            }
        }

        if let Some(current) = upload_length {
            if let Some(previous) = self.last_upload_length {
                if current >= previous {
                    self.uploaded_bytes = self
                        .uploaded_bytes
                        .saturating_add(current.saturating_sub(previous));
                }
                // A decreased Aria2 counter is a daemon/lifecycle reset. The
                // current value becomes the new baseline, without adding it.
            }
            self.last_upload_length = Some(current);
        }
        self.last_observed_at = Some(now);
        self.last_was_seeding = is_seeding;
        self.snapshot()
    }
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

#[derive(Debug, Clone)]
pub struct PendingAria2Outcome {
    pub outcome: PendingOutcome,
    pub progress: Option<DownloadStateProgress>,
}

impl PendingAria2Outcome {
    pub fn new(outcome: PendingOutcome) -> Self {
        Self {
            outcome,
            progress: None,
        }
    }
}

fn aria2_magnet_parent_has_metadata_file(status: &serde_json::Value) -> bool {
    status
        .get("files")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|files| {
            files.iter().any(|file| {
                file.get("path")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|path| path.starts_with("[METADATA]"))
            })
        })
}

fn aria2_magnet_parent_has_payload_file(status: &serde_json::Value) -> bool {
    status
        .get("files")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|files| {
            files.iter().any(|file| {
                file.get("path")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|path| !path.is_empty() && !path.starts_with("[METADATA]"))
            })
        })
}

fn aria2_magnet_followed_gids(
    status: &serde_json::Value,
    parent_gid: &str,
) -> Vec<String> {
    status
        .get("followedBy")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flat_map(|gids| gids.iter())
        .filter_map(serde_json::Value::as_str)
        .filter(|gid| {
            !gid.is_empty()
                && *gid != parent_gid
                && gid.len() <= 64
                && gid.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .take(MAX_ARIA2_MAGNET_FOLLOWED_GIDS)
        .map(str::to_string)
        .collect()
}

fn aria2_magnet_status_error(status: &serde_json::Value) -> String {
    let error_code = status
        .get("errorCode")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty());
    let error_message = status
        .get("errorMessage")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("aria2 magnet payload child ended unexpectedly");
    let message = match error_code {
        Some(code) => format!("aria2 error code {code}: {error_message}"),
        None => error_message.to_string(),
    };
    crate::redact_sensitive_text(&message)
}

fn is_direct_magnet_payload(payload: &SpawnPayload) -> bool {
    payload.is_torrent
        && !payload.torrent_verify_only
        && payload.torrent_path.is_none()
        && payload
            .url
            .trim_start()
            .get(..7)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("magnet:"))
}

fn aria2_resolver_route_for_log(payload: &SpawnPayload) -> &'static str {
    if payload
        .proxy
        .as_deref()
        .is_some_and(|proxy| !proxy.trim().is_empty() && !proxy.eq_ignore_ascii_case("none"))
    {
        "configured"
    } else {
        "automatic"
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Aria2SeedControlOutcome {
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

#[derive(Debug, Clone)]
struct SeedWaiter {
    id: String,
    queue_id: String,
    lifecycle_generation: u64,
}

#[derive(Debug, Default)]
struct SeedCapacityState {
    enabled: bool,
    max_concurrent: usize,
    owners: HashSet<String>,
    waiting: VecDeque<SeedWaiter>,
    starting: HashSet<String>,
}

#[derive(Debug, Clone, Copy)]
struct SeedBudget {
    remaining_minutes: Option<f64>,
    started_at: std::time::Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SeedAdmissionOutcome {
    Seeding,
    Waiting,
    Complete,
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
    pub sftp_host_key_md: Option<String>,
    pub headers: Option<String>,
    pub checksum: Option<String>,
    pub cookies: Option<String>,
    pub mirrors: Option<String>,
    pub user_agent: Option<String>,
    pub max_tries: Option<i32>,
    pub minimum_normal_download_speed_kib: u32,
    pub retry_not_found_errors: bool,
    pub adaptive_mirror_selection: bool,
    pub proxy: Option<String>,
    pub format_selector: Option<String>,
    pub cookie_source: Option<String>,
    pub is_media: bool,
    pub is_torrent: bool,
    pub torrent_path: Option<String>,
    pub torrent_file_indices: Option<Vec<u32>>,
    pub torrent_seed_time: Option<f64>,
    pub torrent_seed_ratio: Option<f64>,
    pub torrent_seed_remaining: Option<f64>,
    pub torrent_web_seeds: Option<Vec<crate::ipc::TorrentWebSeed>>,
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
    pub torrent_file_allocation: Option<String>,
    pub torrent_verify_only: bool,
    pub torrent_verify_restore_status: Option<String>,
    pub torrent_verified_length: Option<u64>,
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

    /// Pause a completed Torrent before releasing its download permit to the
    /// Firelink-owned seed-slot pool.
    async fn pause_for_seed(&self, _gid: &str) -> Result<Aria2SeedControlOutcome, String> {
        Err("live Torrent seed-slot pausing is unavailable".to_string())
    }

    /// Resume a Torrent after a Firelink seed slot has been reserved.
    async fn resume_for_seed(&self, _gid: &str) -> Result<Aria2SeedControlOutcome, String> {
        Err("live Torrent seed-slot resuming is unavailable".to_string())
    }

    async fn get_torrent_file_uris(&self, _gid: &str) -> Result<Vec<(u32, Vec<String>)>, String> {
        Err("live Torrent web-seed inspection is unavailable".to_string())
    }

    async fn change_torrent_uris(
        &self,
        _gid: &str,
        _file_index: u32,
        _delete: &[String],
        _add: &[String],
    ) -> Result<(), String> {
        Err("live Torrent web-seed changes are unavailable".to_string())
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
    /// Prevents new enqueue/admission work after a system action has passed
    /// its final safety check. The flag is set while holding admission_gate so
    /// the check and the fence are one state transition.
    system_action_pending: AtomicBool,
    /// Last queue selected by the dispatcher. Selection starts after this
    /// queue when multiple queues have eligible work.
    dispatch_cursor: Mutex<Option<String>>,
    target_capacity: AtomicUsize,
    slots_to_retire: AtomicUsize,
    notify: Notify,
    /// Firelink-owned seed capacity. Seeders keep the Aria2 GID and mapping
    /// alive, but release the download semaphore while they own a seed slot.
    seed_capacity: StdMutex<SeedCapacityState>,
    seed_budgets: StdMutex<HashMap<String, SeedBudget>>,
    /// Firelink lifetime Torrent upload/seed accounting. Raw Aria2 counters
    /// are scoped to the current GID and control epoch and never leave this
    /// process as durable state.
    torrent_telemetry: Mutex<HashMap<String, TorrentTelemetryState>>,
    torrent_moves: StdMutex<HashSet<String>>,
    torrent_move_cancellations: StdMutex<HashSet<String>>,

    /// aria2 gid -> download id map (shared with the WS poller).
    pub aria2_gids: Arc<std::sync::RwLock<HashMap<String, Aria2GidMapping>>>,

    /// gid -> buffered (id_placeholder, outcome) for completions that arrived
    /// before the gid was stored. Drained by `remember_gid`.
    pub pending_completion: Arc<Mutex<HashMap<String, (String, PendingAria2Outcome)>>>,
    /// Aria2 can emit onDownloadStart before addUri's response has been
    /// mapped to the Firelink download. Buffer that start marker until the
    /// current GID mapping is installed.
    pending_download_starts: Arc<Mutex<HashSet<String>>>,
    /// Current Aria2 lifecycles whose files are expected to be preallocated.
    /// The generation fences late start/clear events from an older GID.
    aria2_allocation_pending: Mutex<HashMap<String, (u64, u64)>>,

    /// download id -> spawn payload for aria2 transient-error re-addUri retries.
    aria2_payloads: Mutex<HashMap<String, SpawnPayload>>,
    /// Attempt-scoped Aria2 connection options. The persisted payload keeps
    /// the user's requested count; this map records the effective count after
    /// range probing for the currently admitted attempt.
    aria2_connection_options: Mutex<HashMap<String, Aria2ConnectionOptions>>,
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
    /// Direct magnets have a short Aria2 metadata-parent handoff before the
    /// payload child becomes visible. Keep that observation bounded and
    /// lifecycle-scoped so a missing child cannot leak a permit forever.
    aria2_magnet_handoffs: Mutex<HashMap<String, Aria2MagnetHandoffState>>,
    /// Once a direct magnet's payload child is adopted, remember that child
    /// identity so terminal reconciliation does not request the full Aria2
    /// file list again for a potentially very large Torrent.
    aria2_magnet_payload_gids: Mutex<HashMap<String, Aria2GidMapping>>,
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
            system_action_pending: AtomicBool::new(false),
            dispatch_cursor: Mutex::new(None),
            target_capacity: AtomicUsize::new(capacity),
            slots_to_retire: AtomicUsize::new(0),
            notify: Notify::new(),
            seed_capacity: StdMutex::new(SeedCapacityState {
                enabled: false,
                max_concurrent: DEFAULT_TORRENT_MAX_CONCURRENT_SEEDS as usize,
                ..SeedCapacityState::default()
            }),
            seed_budgets: StdMutex::new(HashMap::new()),
            torrent_telemetry: Mutex::new(HashMap::new()),
            torrent_moves: StdMutex::new(HashSet::new()),
            torrent_move_cancellations: StdMutex::new(HashSet::new()),
            aria2_gids: Arc::new(std::sync::RwLock::new(HashMap::new())),
            pending_completion: Arc::new(Mutex::new(HashMap::new())),
            pending_download_starts: Arc::new(Mutex::new(HashSet::new())),
            aria2_allocation_pending: Mutex::new(HashMap::new()),
            aria2_payloads: Mutex::new(HashMap::new()),
            aria2_connection_options: Mutex::new(HashMap::new()),
            aria2_dispatch_inflight: Mutex::new(HashMap::new()),
            aria2_dispatch_notify: Notify::new(),
            aria2_global_speed_limit: Arc::new(StdMutex::new(None)),
            aria2_retry_strikes: Mutex::new(HashMap::new()),
            aria2_retry_cancelled: Mutex::new(HashSet::new()),
            aria2_retry_inflight: Mutex::new(HashMap::new()),
            aria2_retrying_gids: Mutex::new(HashSet::new()),
            aria2_ignored_gids: Mutex::new(VecDeque::new()),
            aria2_magnet_handoffs: Mutex::new(HashMap::new()),
            aria2_magnet_payload_gids: Mutex::new(HashMap::new()),
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

    /// Accept one lifecycle-fenced Aria2 status sample and return Firelink's
    /// monotonic lifetime counters. Poller callers must already have checked
    /// the mapping; the key and epoch checks here provide a second fence at
    /// the accounting owner itself.
    pub async fn observe_torrent_telemetry(
        &self,
        id: &str,
        gid: &str,
        epoch: u64,
        upload_length: Option<u64>,
        is_seeding: bool,
        now: Instant,
    ) -> TorrentTelemetrySnapshot {
        let mut telemetry = self.torrent_telemetry.lock().await;
        let state = telemetry
            .entry(id.to_string())
            .or_insert_with(|| TorrentTelemetryState::new(gid, epoch, now));
        state.observe(gid, epoch, upload_length, is_seeding, now)
    }

    /// Restore the durable Firelink totals before the first raw Aria2 sample
    /// for a download. Raw upload counters are intentionally not restored;
    /// the next observation establishes a fresh GID/epoch baseline.
    pub async fn hydrate_torrent_telemetry(
        &self,
        id: &str,
        uploaded_bytes: u64,
        seeded_seconds: u64,
    ) {
        let mut telemetry = self.torrent_telemetry.lock().await;
        let state = telemetry
            .entry(id.to_string())
            .or_insert_with(|| TorrentTelemetryState::new("", 0, Instant::now()));
        state.uploaded_bytes = state.uploaded_bytes.max(uploaded_bytes);
        state.seeded_seconds = state.seeded_seconds.max(seeded_seconds);
    }

    /// Clear the one-shot integrity override only for the still-current
    /// lifecycle. A normal user integrity preference is never changed here.
    pub async fn clear_torrent_relocation_check(&self, id: &str, epoch: u64) -> bool {
        if !self.is_aria2_control_epoch_current(id, epoch).await {
            return false;
        }
        let mut payloads = self.aria2_payloads.lock().await;
        let Some(payload) = payloads.get_mut(id) else {
            return false;
        };
        if !payload.is_torrent {
            return false;
        }
        payload.torrent_check_integrity = false;
        true
    }

    pub async fn begin_torrent_move(&self, id: &str) -> Result<(), String> {
        let _admission_gate = self.admission_gate.lock().await;
        if self.system_action_pending.load(Ordering::Acquire) {
            return Err("System action is already being performed".to_string());
        }
        self.torrent_moves
            .lock()
            .expect("Torrent move lock poisoned")
            .insert(id.to_string());
        self.torrent_move_cancellations
            .lock()
            .expect("Torrent move cancellation lock poisoned")
            .remove(id);
        Ok(())
    }

    pub fn cancel_torrent_move(&self, id: &str) {
        self.torrent_move_cancellations
            .lock()
            .expect("Torrent move cancellation lock poisoned")
            .insert(id.to_string());
    }

    pub fn torrent_move_cancelled(&self, id: &str) -> bool {
        self.torrent_move_cancellations
            .lock()
            .expect("Torrent move cancellation lock poisoned")
            .contains(id)
    }

    pub fn finish_torrent_move(&self, id: &str) {
        self.torrent_moves
            .lock()
            .expect("Torrent move lock poisoned")
            .remove(id);
        self.torrent_move_cancellations
            .lock()
            .expect("Torrent move cancellation lock poisoned")
            .remove(id);
    }

    pub fn has_torrent_moves(&self) -> bool {
        !self
            .torrent_moves
            .lock()
            .expect("Torrent move lock poisoned")
            .is_empty()
    }

    /// Drop counters after terminal cleanup/removal. Persisted lifetime
    /// totals remain owned by the DownloadItem row; this only removes raw
    /// process-local lifecycle state.
    pub async fn forget_torrent_telemetry(&self, id: &str) {
        self.torrent_telemetry.lock().await.remove(id);
    }

    pub fn app_handle(&self) -> AppHandle<R> {
        self.app_handle.clone()
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

    /// Apply the persisted seed policy to the live queue manager. Existing
    /// seeders are not paused when the setting changes; the new limit applies
    /// to the next seed admission and to waiting seeders.
    pub fn configure_seed_capacity(&self, enabled: bool, max_concurrent: u32) {
        let max_concurrent = normalize_torrent_max_concurrent_seeds(max_concurrent)
            .unwrap_or(DEFAULT_TORRENT_MAX_CONCURRENT_SEEDS) as usize;
        if let Ok(mut state) = self.seed_capacity.lock() {
            state.enabled = enabled;
            state.max_concurrent = max_concurrent;
            if enabled {
                if let Ok(budgets) = self.seed_budgets.lock() {
                    state.owners.extend(budgets.keys().cloned());
                }
            }
        }
        self.notify.notify_waiters();
    }

    fn seed_capacity_enabled(&self) -> bool {
        self.seed_capacity
            .lock()
            .map(|state| state.enabled)
            .unwrap_or(false)
    }

    fn seed_owner(&self, id: &str) -> bool {
        self.seed_capacity
            .lock()
            .map(|state| state.owners.contains(id))
            .unwrap_or(false)
    }

    pub fn is_seed_owner(&self, id: &str) -> bool {
        self.seed_owner(id)
    }

    fn seed_waiting(&self, id: &str) -> bool {
        self.seed_capacity.lock().map_or(false, |state| {
            state.waiting.iter().any(|waiter| waiter.id == id)
                || state.starting.contains(id)
        })
    }

    fn seed_starting(&self, id: &str) -> bool {
        self.seed_capacity
            .lock()
            .map_or(false, |state| state.starting.contains(id))
    }

    fn add_seed_waiter(&self, waiter: SeedWaiter) {
        if let Ok(mut state) = self.seed_capacity.lock() {
            if !state.owners.contains(&waiter.id)
                && !state.starting.contains(&waiter.id)
                && !state.waiting.iter().any(|candidate| candidate.id == waiter.id)
            {
                state.waiting.push_back(waiter);
            }
        }
        self.notify.notify_waiters();
    }

    fn reserve_seed_slot(&self, id: &str) -> bool {
        let Ok(mut state) = self.seed_capacity.lock() else {
            return false;
        };
        if state.owners.contains(id) {
            return true;
        }
        if !state.enabled || state.owners.len() >= state.max_concurrent {
            return false;
        }
        state.owners.insert(id.to_string());
        true
    }

    fn reserve_seed_waiter(&self) -> Option<SeedWaiter> {
        let Ok(mut state) = self.seed_capacity.lock() else {
            return None;
        };
        if state.enabled && state.owners.len() >= state.max_concurrent {
            return None;
        }
        let waiter = state.waiting.pop_front()?;
        state.owners.insert(waiter.id.clone());
        state.starting.insert(waiter.id.clone());
        Some(waiter)
    }

    fn finish_seed_start(&self, id: &str) {
        if let Ok(mut state) = self.seed_capacity.lock() {
            state.starting.remove(id);
        }
    }

    fn abandon_seed_start(&self, id: &str) {
        if let Ok(mut state) = self.seed_capacity.lock() {
            state.starting.remove(id);
            state.owners.remove(id);
        }
        self.notify.notify_waiters();
    }

    /// Stop tracking a seed lifecycle. This is called for terminal, manual
    /// pause, and remove paths; releasing a download permit while a seed slot
    /// is merely changing hands deliberately does not call it.
    pub fn release_seed_tracking(&self, id: &str) {
        if let Ok(mut state) = self.seed_capacity.lock() {
            state.owners.remove(id);
            state.starting.remove(id);
            state.waiting.retain(|waiter| waiter.id != id);
        }
        if let Ok(mut budgets) = self.seed_budgets.lock() {
            budgets.remove(id);
        }
        self.notify.notify_waiters();
    }

    pub fn is_waiting_to_seed(&self, id: &str) -> bool {
        self.seed_waiting(id)
    }

    pub fn wake_seed_waiters(&self) {
        self.notify.notify_waiters();
    }

    async fn record_seed_started(&self, id: &str) {
        let remaining_minutes = self
            .aria2_payloads
            .lock()
            .await
            .get(id)
            .and_then(|payload| {
                payload
                    .torrent_seed_remaining
                    .or(payload.torrent_seed_time)
                    .filter(|minutes| minutes.is_finite() && *minutes > 0.0)
            });
        if let Ok(mut budgets) = self.seed_budgets.lock() {
            budgets.insert(
                id.to_string(),
                SeedBudget {
                    remaining_minutes,
                    started_at: std::time::Instant::now(),
                },
            );
        }
    }

    /// Persist the remaining time in the in-memory payload before a seeder is
    /// parked or manually paused. The frontend persistence path receives the
    /// same value through the WaitingToSeed event and can restore it after a
    /// restart.
    pub async fn capture_seed_remaining(&self, id: &str) -> Option<f64> {
        let remaining = self.seed_budgets.lock().ok().and_then(|mut budgets| {
            let budget = budgets.get_mut(id)?;
            let elapsed = budget.started_at.elapsed().as_secs_f64() / 60.0;
            budget.remaining_minutes.map(|minutes| (minutes - elapsed).max(0.0))
        });
        if let Some(remaining) = remaining {
            if let Some(payload) = self.aria2_payloads.lock().await.get_mut(id) {
                payload.torrent_seed_time = Some(remaining);
                payload.torrent_seed_remaining = Some(remaining);
            }
        }
        remaining
    }

    async fn release_download_permit_for_seed(&self, id: &str) {
        let _admission_gate = self.admission_gate.lock().await;
        let removed = self.active_permits.lock().await.remove(id).is_some();
        self.active_permit_generations.lock().await.remove(id);
        self.queue_permit_ownership.lock().await.remove(id);
        if removed {
            self.notify.notify_waiters();
        }
        drop(_admission_gate);
        if removed {
            self.sync_power_activity().await;
        }
    }

    async fn admit_seed_after_completion(&self, id: &str) -> SeedAdmissionOutcome {
        if self.seed_owner(id) {
            return SeedAdmissionOutcome::Seeding;
        }
        if self.seed_waiting(id) {
            return SeedAdmissionOutcome::Waiting;
        }
        if self.reserve_seed_slot(id) {
            self.release_download_permit_for_seed(id).await;
            self.record_seed_started(id).await;
            return SeedAdmissionOutcome::Seeding;
        }

        let Some(gid) = self.aria2_gid_for_download(id) else {
            return SeedAdmissionOutcome::Seeding;
        };
        match self.spawner.pause_for_seed(&gid).await {
            Ok(Aria2SeedControlOutcome::Paused) => {
                self.record_seed_started(id).await;
                let remaining = self.capture_seed_remaining(id).await;
                let ownership = self.queue_permit_ownership.lock().await.get(id).cloned();
                let lifecycle_generation = ownership
                    .as_ref()
                    .map(|ownership| ownership.lifecycle_generation)
                    .or(self.registered_lifecycle_generation(id).await)
                    .unwrap_or_default();
                self.release_download_permit_for_seed(id).await;
                self.add_seed_waiter(SeedWaiter {
                    id: id.to_string(),
                    queue_id: ownership
                        .as_ref()
                        .map(|ownership| ownership.queue_id.clone())
                        .unwrap_or_else(|| "main".to_string()),
                    lifecycle_generation,
                });
                let _ = remaining;
                SeedAdmissionOutcome::Waiting
            }
            Ok(Aria2SeedControlOutcome::Complete) => SeedAdmissionOutcome::Complete,
            Ok(Aria2SeedControlOutcome::Resumed) | Err(_) => {
                // An ambiguous pause must retain the download permit and GID;
                // treating the transfer as a live seeder is the conservative
                // choice until the next daemon status event resolves it.
                self.reserve_seed_slot_even_if_full(id);
                self.record_seed_started(id).await;
                SeedAdmissionOutcome::Seeding
            }
        }
    }

    fn reserve_seed_slot_even_if_full(&self, id: &str) {
        if let Ok(mut state) = self.seed_capacity.lock() {
            state.owners.insert(id.to_string());
        }
    }

    fn emit_waiting_to_seed(&self, id: &str, remaining: Option<f64>) {
        use tauri::Emitter;
        let _ = self.app_handle.emit(
            "download-state",
            DownloadStateEvent::waiting_to_seed(id, remaining),
        );
    }

    async fn try_start_waiting_seed(self: &Arc<Self>) -> bool {
        let Some(waiter) = self.reserve_seed_waiter() else {
            return false;
        };
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            manager.resume_waiting_seed(waiter).await;
        });
        true
    }

    async fn resume_waiting_seed(self: Arc<Self>, waiter: SeedWaiter) {
        let id = waiter.id.clone();
        let Some(gid) = self.aria2_gid_for_download(&id) else {
            self.abandon_seed_start(&id);
            return;
        };
        if !self
            .is_registered_generation_or_legacy(&id, waiter.lifecycle_generation)
            .await
            || !self.seed_waiting(&id)
            || !matches!(self.active_kind(&id).await, Some(TaskKind::Aria2))
        {
            self.abandon_seed_start(&id);
            return;
        }
        let control_epoch = self.current_aria2_control_epoch(&id).await;
        let Some(permit_candidate) = self
            .acquire_aria2_permit_candidate_for_queue(
                &id,
                &waiter.queue_id,
                waiter.lifecycle_generation,
                control_epoch,
            )
            .await
        else {
            self.abandon_seed_start(&id);
            return;
        };
        let _control_guard = self.acquire_aria2_control(&id).await;
        if !self
            .is_registered_generation_or_legacy(&id, waiter.lifecycle_generation)
            .await
            || !self.seed_waiting(&id)
            || !matches!(self.active_kind(&id).await, Some(TaskKind::Aria2))
            || self.aria2_gid_for_download(&id).as_deref() != Some(gid.as_str())
            || !self.is_aria2_control_epoch_current(&id, control_epoch).await
        {
            self.release_aria2_permit_candidate(&id, waiter.lifecycle_generation)
                .await;
            self.abandon_seed_start(&id);
            return;
        }
        let epoch = self.next_aria2_control_epoch(&id).await;
        if !self.rebind_aria2_gid_epoch(&id, &gid, epoch).await {
            self.release_aria2_permit_candidate(&id, waiter.lifecycle_generation)
                .await;
            self.abandon_seed_start(&id);
            return;
        }
        if !self
            .park_aria2_permit_if_missing_for_queue(
                &id,
                &waiter.queue_id,
                waiter.lifecycle_generation,
                permit_candidate,
            )
            .await
        {
            self.release_aria2_permit_candidate(&id, waiter.lifecycle_generation)
                .await;
            self.abandon_seed_start(&id);
            return;
        }
        match self.spawner.resume_for_seed(&gid).await {
            Ok(Aria2SeedControlOutcome::Resumed) => {
                if !self.is_aria2_control_epoch_current(&id, epoch).await
                    || !self.is_current_aria2_gid_mapping(&gid, &Aria2GidMapping { id: id.clone(), epoch })
                {
                    let _ = self.spawner.pause_for_seed(&gid).await;
                    self.release_download_permit_for_seed(&id).await;
                    self.abandon_seed_start(&id);
                    return;
                }
                self.record_seed_started(&id).await;
                // Keep the lifecycle visibly in the starting state until its
                // download permit has been released. Otherwise observers can
                // see a resumed seeder before the permit transition finishes.
                self.release_download_permit_for_seed(&id).await;
                self.finish_seed_start(&id);
                self.emit_state(&id, DownloadStatus::Seeding);
            }
            Ok(Aria2SeedControlOutcome::Complete) => {
                self.finish_seed_start(&id);
                self.apply_completion_locked(&id, PendingOutcome::Complete).await;
            }
            Ok(Aria2SeedControlOutcome::Paused) => {
                let remaining = self.capture_seed_remaining(&id).await;
                self.release_download_permit_for_seed(&id).await;
                self.finish_seed_start(&id);
                self.abandon_seed_start(&id);
                self.add_seed_waiter(SeedWaiter {
                    id: id.clone(),
                    queue_id: waiter.queue_id,
                    lifecycle_generation: waiter.lifecycle_generation,
                });
                self.emit_waiting_to_seed(&id, remaining);
            }
            Err(error) => {
                // An unverified unpause must not release either the seed
                // owner or its download permit: the daemon may already be
                // active even though the RPC/status check was unavailable.
                // Keep the item fenced in the starting state and retry the
                // status-verified control until the daemon or a newer
                // lifecycle resolves it.
                log::warn!(
                    "Torrent seed resume [{}] could not be verified; retaining seed ownership and permit: {}",
                    id,
                    error
                );
                self.emit_waiting_to_seed(&id, None);
                let retry_waiter = SeedWaiter {
                    id: id.clone(),
                    queue_id: waiter.queue_id.clone(),
                    lifecycle_generation: waiter.lifecycle_generation,
                };
                let manager = Arc::clone(&self);
                tauri::async_runtime::spawn(async move {
                    manager
                        .retry_ambiguous_seed_resume(retry_waiter, gid, epoch)
                        .await;
                });
            }
        }
    }

    async fn retry_ambiguous_seed_resume(
        self: Arc<Self>,
        waiter: SeedWaiter,
        gid: String,
        epoch: u64,
    ) {
        let mut delay = Duration::from_millis(250);
        loop {
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = self.notify.notified() => {}
            }

            let _control_guard = self.acquire_aria2_control(&waiter.id).await;
            let lifecycle_current = self
                .is_registered_generation_or_legacy(&waiter.id, waiter.lifecycle_generation)
                .await
                && self.seed_starting(&waiter.id)
                && matches!(self.active_kind(&waiter.id).await, Some(TaskKind::Aria2))
                && self.has_active_permit(&waiter.id).await
                && self.aria2_gid_for_download(&waiter.id).as_deref() == Some(gid.as_str())
                && self.is_aria2_control_epoch_current(&waiter.id, epoch).await
                && self.is_current_aria2_gid_mapping(
                    &gid,
                    &Aria2GidMapping {
                        id: waiter.id.clone(),
                        epoch,
                    },
                );
            if !lifecycle_current {
                return;
            }

            match self.spawner.resume_for_seed(&gid).await {
                Ok(Aria2SeedControlOutcome::Resumed) => {
                    if !self.is_aria2_control_epoch_current(&waiter.id, epoch).await
                        || !self.is_current_aria2_gid_mapping(
                            &gid,
                            &Aria2GidMapping {
                                id: waiter.id.clone(),
                                epoch,
                            },
                        )
                    {
                        let _ = self.spawner.pause_for_seed(&gid).await;
                        let _ = self.spawner.pause_for_seed(&gid).await;
                        self.release_download_permit_for_seed(&waiter.id).await;
                        self.abandon_seed_start(&waiter.id);
                        return;
                    }
                    self.record_seed_started(&waiter.id).await;
                    self.release_download_permit_for_seed(&waiter.id).await;
                    self.finish_seed_start(&waiter.id);
                    self.emit_state(&waiter.id, DownloadStatus::Seeding);
                    return;
                }
                Ok(Aria2SeedControlOutcome::Complete) => {
                    self.finish_seed_start(&waiter.id);
                    self.apply_completion_locked(&waiter.id, PendingOutcome::Complete)
                        .await;
                    return;
                }
                Ok(Aria2SeedControlOutcome::Paused) => {
                    let remaining = self.capture_seed_remaining(&waiter.id).await;
                    self.release_download_permit_for_seed(&waiter.id).await;
                    self.finish_seed_start(&waiter.id);
                    self.abandon_seed_start(&waiter.id);
                    self.add_seed_waiter(SeedWaiter {
                        id: waiter.id.clone(),
                        queue_id: waiter.queue_id.clone(),
                        lifecycle_generation: waiter.lifecycle_generation,
                    });
                    self.emit_waiting_to_seed(&waiter.id, remaining);
                    return;
                }
                Err(error) => {
                    log::warn!(
                        "Torrent seed resume [{}] remains unverified; retaining seed ownership and permit: {}",
                        waiter.id,
                        error
                    );
                    delay = (delay * 2).min(Duration::from_secs(5));
                }
            }
        }
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

    /// Temporarily remove one not-yet-admitted task while a caller performs a
    /// lifecycle-safe reconfiguration. The admission gate prevents the
    /// dispatcher from popping the same task between the caller's validation
    /// and mutation of its payload.
    pub async fn take_pending_task(&self, id: &str) -> Option<(usize, QueuedTask)> {
        let _admission_gate = self.admission_gate.lock().await;
        let mut pending = self.pending.lock().await;
        let index = pending.iter().position(|task| task.id == id)?;
        pending.remove(index).map(|task| (index, task))
    }

    /// Restore a task removed by `take_pending_task`, preserving its queue
    /// position even when another queue's work was admitted meanwhile.
    pub async fn restore_pending_task(&self, index: usize, task: QueuedTask) {
        let _admission_gate = self.admission_gate.lock().await;
        let mut pending = self.pending.lock().await;
        let insert_at = index.min(pending.len());
        pending.insert(insert_at, task);
        self.notify.notify_one();
    }

    /// Explicitly release a backend registry id (e.g. on un-resumable false paths, removals, or detach).
    pub async fn release_registered_id(&self, id: &str) {
        self.registered_ids.lock().await.remove(id);
        self.registered_lifecycle_generations.lock().await.remove(id);
        // A released lifecycle cannot be resumed by a delayed retry worker.
        // Epoch checks remain the authoritative guard; removing this marker
        // prevents terminal downloads from accumulating cancellation entries.
        self.aria2_retry_cancelled.lock().await.remove(id);
        self.release_seed_tracking(id);
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

    async fn is_registered_generation_or_legacy(&self, id: &str, generation: u64) -> bool {
        self.is_registered_generation(id, generation).await
            || (generation == 0
                && self.registered_lifecycle_generation(id).await.is_none()
                && self.is_registered(id).await)
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
            self.release_seed_tracking(id);
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

    /// Return a generation newer than every observed or cancelled enqueue for
    /// an internally-created lifecycle. The caller still passes this value to
    /// `reserve_enqueue_generation`, which performs the atomic ownership and
    /// cancellation checks before the enqueue is committed.
    pub async fn next_enqueue_generation(&self, id: &str) -> Result<u64, String> {
        let cancellations = self.enqueue_cancellations.lock().await;
        let generations = self.enqueue_generations.lock().await;
        let previous_generation = generations.get(id).copied().unwrap_or_default();
        let cancelled_generation = cancellations.get(id).copied().unwrap_or_default();
        previous_generation
            .max(cancelled_generation)
            .checked_add(1)
            .ok_or_else(|| "Download lifecycle generation exhausted".to_string())
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
        task: QueuedTask,
        generation: u64,
        previous_generation: Option<u64>,
    ) -> Result<(), String> {
        self.commit_reserved_enqueue_with_finalizer(task, generation, previous_generation, || async {
            Ok(())
        })
        .await
    }

    /// Commit an enqueue and its final durable admission marker as one
    /// dispatcher-visible boundary. The task is placed in the pending list
    /// before the finalizer runs, but the admission gate stays held so the
    /// dispatcher cannot pop it until the finalizer succeeds. If the
    /// finalizer fails, the task is removed before any worker can observe it.
    pub async fn commit_reserved_enqueue_with_finalizer<F, Fut>(
        &self,
        mut task: QueuedTask,
        generation: u64,
        previous_generation: Option<u64>,
        finalizer: F,
    ) -> Result<(), String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<(), String>>,
    {
        let id = task.id.clone();
        let _admission_gate = self.admission_gate.lock().await;
        if self.system_action_pending.load(Ordering::Acquire) {
            self.rollback_enqueue_reservation(&id, generation, previous_generation)
                .await;
            return Err("System action is already being performed".to_string());
        }
        if self
            .registered_lifecycle_generation(&id)
            .await
            .is_none_or(|registered| registered != generation)
        {
            self.rollback_enqueue_reservation(&id, generation, previous_generation)
                .await;
            return Err("Download enqueue reservation is no longer current".to_string());
        }
        {
            let cancellations = self.enqueue_cancellations.lock().await;
            if cancellations
                .get(&id)
                .is_some_and(|cancelled| *cancelled >= generation)
            {
                self.rollback_enqueue_reservation(&id, generation, previous_generation)
                    .await;
                return Err("Download enqueue was superseded by a newer user action".to_string());
            }
        }
        task.lifecycle_generation = generation;
        self.pending.lock().await.push_back(task);

        if let Err(error) = finalizer().await {
            let mut pending = self.pending.lock().await;
            pending.retain(|candidate| {
                !(candidate.id == id && candidate.lifecycle_generation == generation)
            });
            self.rollback_enqueue_reservation(&id, generation, previous_generation)
                .await;
            return Err(error);
        }

        // Cancellation can arrive while the durable admission marker is being
        // written. Recheck it before making the task visible to the rest of
        // the lifecycle; the admission gate prevents a dispatcher or queue
        // mutation from observing a half-committed replacement.
        {
            let cancellations = self.enqueue_cancellations.lock().await;
            if cancellations
                .get(&id)
                .is_some_and(|cancelled| *cancelled >= generation)
            {
                let mut pending = self.pending.lock().await;
                pending.retain(|candidate| {
                    !(candidate.id == id && candidate.lifecycle_generation == generation)
                });
                self.rollback_enqueue_reservation(&id, generation, previous_generation)
                    .await;
                return Err("Download enqueue was superseded by a newer user action".to_string());
            }
        }

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
        if let Err(error) = self
            .commit_reserved_enqueue(task, generation, previous_generation)
            .await
        {
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

    pub async fn aria2_retry_strike(&self, id: &str) -> usize {
        self.aria2_retry_strikes
            .lock()
            .await
            .get(id)
            .copied()
            .unwrap_or_default()
    }

    pub async fn aria2_requested_connections(&self, id: &str) -> Option<i32> {
        self.aria2_payloads
            .lock()
            .await
            .get(id)
            .and_then(|payload| {
                if payload.is_torrent {
                    None
                } else {
                    payload.connections
                }
            })
            .map(clamp_download_connections)
    }

    pub async fn set_aria2_connection_options(
        &self,
        id: &str,
        epoch: u64,
        effective: i32,
    ) {
        let mut options = self.aria2_connection_options.lock().await;
        if options
            .get(id)
            .is_some_and(|current| current.epoch > epoch)
        {
            return;
        }
        options.insert(
            id.to_string(),
            Aria2ConnectionOptions {
                epoch,
                effective: clamp_download_connections(effective),
            },
        );
    }

    pub async fn aria2_effective_connections(&self, id: &str, epoch: u64) -> Option<i32> {
        self.aria2_connection_options
            .lock()
            .await
            .get(id)
            .filter(|options| options.epoch == epoch)
            .map(|options| options.effective)
    }

    pub async fn aria2_torrent_seeding_requested(&self, id: &str) -> bool {
        self.aria2_payloads
            .lock()
            .await
            .get(id)
            .is_some_and(torrent_seeding_requested)
    }

    /// Whether a currently seeding Torrent owns the Firelink permit that
    /// allows seed-time accounting. Separate seed slots require explicit
    /// ownership; legacy single-pool mode keeps the transfer permit live.
    pub async fn aria2_torrent_seed_permit_owned(&self, id: &str) -> bool {
        if self.seed_capacity_enabled() {
            self.seed_owner(id)
        } else {
            self.aria2_torrent_seeding_requested(id).await
        }
    }

    pub async fn aria2_is_torrent(&self, id: &str) -> bool {
        self.aria2_payloads
            .lock()
            .await
            .get(id)
            .is_some_and(|payload| payload.is_torrent)
    }

    /// Return only the bounded number of tracker endpoints associated with a
    /// live Torrent. The endpoint values and managed metadata path never leave
    /// this method; callers use the count for redacted diagnostics only.
    pub async fn aria2_torrent_tracker_count(&self, id: &str) -> Option<usize> {
        let payload = self.aria2_payloads.lock().await.get(id).cloned()?;
        if !payload.is_torrent {
            return None;
        }

        let mut count = payload
            .torrent_trackers
            .as_deref()
            .map(|trackers| {
                trackers
                    .split(',')
                    .filter(|tracker| !tracker.trim().is_empty())
                    .take(256)
                    .count()
            });

        if payload
            .url
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("magnet:")
        {
            let magnet_count = crate::torrent::magnet_tracker_count(&payload.url).ok()?;
            count = Some(count.unwrap_or_default().saturating_add(magnet_count));
        }

        if let Some(torrent_path) = payload.torrent_path.as_deref() {
            let path = crate::torrent::validate_managed_torrent_path(
                &self.app_handle,
                id,
                torrent_path,
            )
            .ok()?;
            let bytes = crate::torrent::read_bounded_torrent_bytes(&path).await.ok()?;
            let metadata = crate::torrent::torrent_details_from_bytes(&bytes).ok()?;
            count = Some(count.unwrap_or_default().saturating_add(metadata.trackers.len()));
        }

        count.map(|value| value.min(256))
    }

    pub async fn aria2_is_torrent_verification(&self, id: &str) -> bool {
        self.aria2_payloads
            .lock()
            .await
            .get(id)
            .is_some_and(|payload| payload.torrent_verify_only)
    }

    async fn capture_torrent_verification_evidence(&self, id: &str) {
        if !self.aria2_is_torrent_verification(id).await {
            return;
        }
        let Some(gid) = self.aria2_gid_for_download(id) else {
            return;
        };
        let Some(mapping) = self.aria2_gid_mapping(&gid) else {
            return;
        };
        let Some(state) = self.app_handle.try_state::<crate::AppState>() else {
            return;
        };
        let port = state.aria2_port.load(std::sync::atomic::Ordering::Relaxed);
        let secret = state.aria2_secret.clone();
        drop(state);
        let Ok(status) = crate::rpc_call(
            port,
            &secret,
            "aria2.tellStatus",
            serde_json::json!([gid, ["status", "totalLength", "verifiedLength", "verifyIntegrityPending"]]),
        )
        .await else {
            return;
        };
        if !self.is_current_aria2_gid_mapping(&gid, &mapping)
            || !self
                .is_aria2_control_epoch_current(id, mapping.epoch)
                .await
        {
            return;
        }
        let status_name = status.get("status").and_then(|value| value.as_str());
        let total = status
            .get("totalLength")
            .and_then(|value| value.as_str().and_then(|value| value.parse::<u64>().ok()).or_else(|| value.as_u64()));
        let verified = status
            .get("verifiedLength")
            .and_then(|value| value.as_str().and_then(|value| value.parse::<u64>().ok()).or_else(|| value.as_u64()));
        let pending = status
            .get("verifyIntegrityPending")
            .is_some_and(|value| value.as_bool() == Some(true) || value.as_str() == Some("true"));
        if let Some(total) = Self::complete_torrent_verification_length(
            status_name,
            pending,
            total,
            verified,
        ) {
            self.record_torrent_verified_length(id, mapping.epoch, total)
                .await;
        }
    }

    fn complete_torrent_verification_length(
        status: Option<&str>,
        verify_pending: bool,
        total: Option<u64>,
        verified: Option<u64>,
    ) -> Option<u64> {
        if matches!(status, Some("complete" | "active" | "waiting"))
            && !verify_pending
        {
            return verified
                .zip(total)
                .filter(|(verified, total)| verified >= total)
                .map(|(_, total)| total);
        }
        None
    }

    pub async fn record_torrent_verified_length(&self, id: &str, epoch: u64, length: u64) {
        if !self.is_aria2_control_epoch_current(id, epoch).await {
            return;
        }
        if let Some(payload) = self.aria2_payloads.lock().await.get_mut(id) {
            if payload.torrent_verify_only {
                let current = payload.torrent_verified_length.unwrap_or(0);
                payload.torrent_verified_length = Some(current.max(length));
            }
        }
    }

    async fn torrent_metadata_for_payload(
        &self,
        id: &str,
        payload: &SpawnPayload,
    ) -> Result<crate::torrent::ParsedTorrent, String> {
        let path = payload
            .torrent_path
            .as_deref()
            .ok_or_else(|| "Torrent metadata is unavailable for web-seed management".to_string())?;
        let path = crate::torrent::validate_managed_torrent_path(&self.app_handle, id, path)?;
        let bytes = crate::torrent::read_bounded_torrent_bytes(&path)
            .await
            .map_err(|error| format!("could not read cached Torrent metadata: {error}"))?;
        crate::torrent::parse_torrent_bytes(&bytes)
    }

    async fn torrent_files_for_payload(
        &self,
        id: &str,
        payload: &SpawnPayload,
    ) -> Result<Vec<crate::ipc::TorrentFile>, String> {
        Ok(self.torrent_metadata_for_payload(id, payload).await?.files)
    }

    fn torrent_baseline_web_seed_pairs(
        &self,
        payload: &SpawnPayload,
        metadata: &crate::torrent::ParsedTorrent,
    ) -> Result<HashSet<TorrentWebSeedPair>, String> {
        let mut sources = metadata.web_seeds.clone();
        sources.extend(normalize_torrent_mirror_uris(payload.mirrors.as_deref())?);
        expand_torrent_web_seed_sources(&sources, metadata)
    }

    async fn current_torrent_mapping(
        &self,
        id: &str,
    ) -> Result<(String, Aria2GidMapping), String> {
        if !self.is_registered(id).await || !matches!(self.active_kind(id).await, Some(TaskKind::Aria2)) {
            return Err("download is not an active Aria2 Torrent".to_string());
        }
        let gid = self
            .aria2_gid_for_download(id)
            .ok_or_else(|| "active Torrent transfer has no GID".to_string())?;
        let mapping = self
            .aria2_gid_mapping(&gid)
            .ok_or_else(|| "active Torrent transfer has no current GID mapping".to_string())?;
        if mapping.id != id || !self.is_aria2_control_epoch_current(id, mapping.epoch).await {
            return Err("Torrent lifecycle changed before web-seed inspection".to_string());
        }
        Ok((gid, mapping))
    }

    pub async fn get_aria2_torrent_web_seeds(
        &self,
        id: &str,
    ) -> Result<Vec<crate::ipc::TorrentWebSeed>, String> {
        let control_guard = self.acquire_aria2_control(id).await;
        self.get_aria2_torrent_web_seeds_locked(id, &control_guard)
            .await
    }

    pub async fn get_aria2_torrent_web_seeds_locked(
        &self,
        id: &str,
        _control_guard: &Aria2ControlGuard,
    ) -> Result<Vec<crate::ipc::TorrentWebSeed>, String> {
        let payload = self
            .aria2_payloads
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| "Torrent retry payload is unavailable".to_string())?;
        let files = self.torrent_files_for_payload(id, &payload).await?;
        let desired = normalize_torrent_web_seeds(payload.torrent_web_seeds.as_deref(), &files)?;
        let (gid, mapping) = self.current_torrent_mapping(id).await?;
        let current = normalize_aria2_torrent_file_uris(
            self.spawner.get_torrent_file_uris(&gid).await?,
            &files,
        )?;
        if !self.is_aria2_control_epoch_current(id, mapping.epoch).await
            || !self.is_current_aria2_gid_mapping(&gid, &mapping)
        {
            return Err("Torrent lifecycle changed while reading web seeds".to_string());
        }
        let expected = expand_torrent_web_seeds(&desired, &files)?;
        if expected.iter().any(|(file_index, uri)| {
            !current
                .get(file_index)
                .is_some_and(|uris| uris.contains(uri))
        }) {
            return Err("Aria2 web-seed state differs from Firelink's persisted state".to_string());
        }
        Ok(desired
            .into_iter()
            .filter(|seed| {
                expand_torrent_web_seed_uri(seed, &files).ok().is_some_and(|uri| {
                    current
                        .get(&seed.file_index)
                        .is_some_and(|uris| uris.contains(&uri))
                })
            })
            .collect())
    }

    pub async fn normalize_aria2_torrent_web_seeds(
        &self,
        id: &str,
        seeds: &[crate::ipc::TorrentWebSeed],
    ) -> Result<Vec<crate::ipc::TorrentWebSeed>, String> {
        let control_guard = self.acquire_aria2_control(id).await;
        self.normalize_aria2_torrent_web_seeds_locked(id, seeds, &control_guard)
            .await
    }

    pub async fn normalize_aria2_torrent_web_seeds_locked(
        &self,
        id: &str,
        seeds: &[crate::ipc::TorrentWebSeed],
        _control_guard: &Aria2ControlGuard,
    ) -> Result<Vec<crate::ipc::TorrentWebSeed>, String> {
        let payload = self
            .aria2_payloads
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| "Torrent retry payload is unavailable".to_string())?;
        let files = self.torrent_files_for_payload(id, &payload).await?;
        normalize_torrent_web_seeds(Some(seeds), &files)
    }

    async fn rollback_torrent_web_seed_changes(
        &self,
        id: &str,
        gid: &str,
        mapping: &Aria2GidMapping,
        changes: &[(u32, Vec<String>, Vec<String>)],
    ) -> bool {
        if !self.is_aria2_control_epoch_current(id, mapping.epoch).await
            || !self.is_current_aria2_gid_mapping(gid, mapping)
        {
            return false;
        }
        let mut restored = true;
        for (file_index, delete, add) in changes.iter().rev() {
            if let Err(error) = self
                .spawner
                .change_torrent_uris(gid, *file_index, add, delete)
                .await
            {
                restored = false;
                log::warn!(
                    "Torrent web-seed rollback [{}] failed for gid {} file {}: {}",
                    id,
                    gid,
                    file_index,
                    error
                );
            }
        }
        restored
    }

    async fn restore_torrent_web_seed_payload_if_current(
        &self,
        id: &str,
        gid: &str,
        mapping: &Aria2GidMapping,
        old_payload: &SpawnPayload,
    ) {
        if self.is_aria2_control_epoch_current(id, mapping.epoch).await
            && self.is_current_aria2_gid_mapping(gid, mapping)
        {
            if let Some(payload) = self.aria2_payloads.lock().await.get_mut(id) {
                payload.torrent_web_seeds = old_payload.torrent_web_seeds.clone();
            }
        }
    }

    pub async fn set_aria2_torrent_web_seeds(
        &self,
        id: &str,
        seeds: Vec<crate::ipc::TorrentWebSeed>,
    ) -> Result<
        (
            Vec<crate::ipc::TorrentWebSeed>,
            Vec<crate::ipc::TorrentWebSeed>,
        ),
        String,
    > {
        let control_guard = self.acquire_aria2_control(id).await;
        self.set_aria2_torrent_web_seeds_locked(id, seeds, &control_guard)
            .await
    }

    pub async fn set_aria2_torrent_web_seeds_locked(
        &self,
        id: &str,
        seeds: Vec<crate::ipc::TorrentWebSeed>,
        _control_guard: &Aria2ControlGuard,
    ) -> Result<
        (
            Vec<crate::ipc::TorrentWebSeed>,
            Vec<crate::ipc::TorrentWebSeed>,
        ),
        String,
    > {
        let old_payload = self
            .aria2_payloads
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| "Torrent retry payload is unavailable".to_string())?;
        let metadata = self.torrent_metadata_for_payload(id, &old_payload).await?;
        let files = metadata.files.clone();
        let desired = normalize_torrent_web_seeds(Some(&seeds), &files)?;
        let old = normalize_torrent_web_seeds(old_payload.torrent_web_seeds.as_deref(), &files)?;
        let (gid, mapping) = self.current_torrent_mapping(id).await?;
        let mut current = normalize_aria2_torrent_file_uris(
            self.spawner.get_torrent_file_uris(&gid).await?,
            &files,
        )?;
        let old_expanded = expand_torrent_web_seeds(&old, &files)?;
        let new_expanded = expand_torrent_web_seeds(&desired, &files)?;
        let baseline = self.torrent_baseline_web_seed_pairs(&old_payload, &metadata)?;
        if !self.is_aria2_control_epoch_current(id, mapping.epoch).await
            || !self.is_current_aria2_gid_mapping(&gid, &mapping)
        {
            return Err("Torrent lifecycle changed while reading web seeds".to_string());
        }
        let (expected, planned_changes) =
            plan_torrent_web_seed_change(&current, &baseline, &old_expanded, &new_expanded)?;

        if let Some(payload) = self.aria2_payloads.lock().await.get_mut(id) {
            payload.torrent_web_seeds = Some(desired.clone());
        }
        let mut changes = Vec::<(u32, Vec<String>, Vec<String>)>::new();
        for (file_index, delete, add) in planned_changes {
            changes.push((file_index, delete.clone(), add.clone()));
            if let Err(error) = self.spawner.change_torrent_uris(&gid, file_index, &delete, &add).await {
                self.rollback_torrent_web_seed_changes(&id, &gid, &mapping, &changes)
                    .await;
                self.restore_torrent_web_seed_payload_if_current(
                    id,
                    &gid,
                    &mapping,
                    &old_payload,
                )
                .await;
                return Err(error);
            }
            let Some(current_uris) = current.get_mut(&file_index) else {
                self.rollback_torrent_web_seed_changes(&id, &gid, &mapping, &changes)
                    .await;
                self.restore_torrent_web_seed_payload_if_current(
                    id,
                    &gid,
                    &mapping,
                    &old_payload,
                )
                .await;
                return Err("Aria2 web-seed state contains an unknown Torrent file index".to_string());
            };
            for uri in &delete {
                current_uris.remove(uri);
            }
            current_uris.extend(add.iter().cloned());
            if !self.is_aria2_control_epoch_current(id, mapping.epoch).await
                || !self.is_current_aria2_gid_mapping(&gid, &mapping)
            {
                self.rollback_torrent_web_seed_changes(&id, &gid, &mapping, &changes)
                    .await;
                self.restore_torrent_web_seed_payload_if_current(
                    id,
                    &gid,
                    &mapping,
                    &old_payload,
                )
                .await;
                return Err("Torrent lifecycle changed while changing web seeds".to_string());
            }
        }
        let readback = match self.spawner.get_torrent_file_uris(&gid).await {
            Ok(readback) => match normalize_aria2_torrent_file_uris(readback, &files) {
                Ok(readback) => readback,
                Err(error) => {
                    self.rollback_torrent_web_seed_changes(id, &gid, &mapping, &changes)
                        .await;
                    self.restore_torrent_web_seed_payload_if_current(
                        id,
                        &gid,
                        &mapping,
                        &old_payload,
                    )
                    .await;
                    return Err(error);
                }
            },
            Err(error) => {
                self.rollback_torrent_web_seed_changes(&id, &gid, &mapping, &changes)
                    .await;
                self.restore_torrent_web_seed_payload_if_current(
                    id,
                    &gid,
                    &mapping,
                    &old_payload,
                )
                .await;
                return Err(error);
            }
        };
        if !self.is_aria2_control_epoch_current(id, mapping.epoch).await
            || !self.is_current_aria2_gid_mapping(&gid, &mapping)
        {
            self.rollback_torrent_web_seed_changes(&id, &gid, &mapping, &changes)
                .await;
            self.restore_torrent_web_seed_payload_if_current(
                id,
                &gid,
                &mapping,
                &old_payload,
            )
            .await;
            return Err("Torrent lifecycle changed while reading back web seeds".to_string());
        }
        if readback != expected {
            self.rollback_torrent_web_seed_changes(&id, &gid, &mapping, &changes)
                .await;
            self.restore_torrent_web_seed_payload_if_current(
                id,
                &gid,
                &mapping,
                &old_payload,
            )
            .await;
            return Err("Aria2 web-seed readback did not match the requested state".to_string());
        }
        Ok((desired, old))
    }

    /// Attach the persisted typed seed set after addTorrent returns its GID.
    /// The addTorrent URI parameter is intentionally left unscoped; this
    /// method is the only path that supplies the required Aria2 file index.
    pub async fn install_initial_torrent_web_seeds(&self, id: &str) -> Result<(), String> {
        let _control_guard = self.acquire_aria2_control(id).await;
        let payload = self
            .aria2_payloads
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| "Torrent retry payload is unavailable".to_string())?;
        let desired = payload.torrent_web_seeds.clone().unwrap_or_default();
        if desired.is_empty() {
            return Ok(());
        }
        let files = self.torrent_files_for_payload(id, &payload).await?;
        let (gid, mapping) = self.current_torrent_mapping(id).await?;
        let mut current = normalize_aria2_torrent_file_uris(
            self.spawner.get_torrent_file_uris(&gid).await?,
            &files,
        )?;
        if !self.is_aria2_control_epoch_current(id, mapping.epoch).await
            || !self.is_current_aria2_gid_mapping(&gid, &mapping)
        {
            return Err("Torrent lifecycle changed while reading initial web seeds".to_string());
        }
        let expanded = expand_torrent_web_seeds(&desired, &files)?;
        let expected = expected_initial_torrent_web_seed_state(&current, &expanded);
        let mut changes = Vec::<(u32, Vec<String>, Vec<String>)>::new();
        for (file_index, uri) in &expanded {
            if current
                .get(file_index)
                .is_some_and(|uris| uris.contains(uri))
            {
                continue;
            }
            if !self.is_aria2_control_epoch_current(id, mapping.epoch).await
                || !self.is_current_aria2_gid_mapping(&gid, &mapping)
            {
                self.rollback_torrent_web_seed_changes(&id, &gid, &mapping, &changes)
                    .await;
                return Err("Torrent lifecycle changed while attaching web seeds".to_string());
            }
            let add = vec![uri.clone()];
            changes.push((*file_index, Vec::new(), add.clone()));
            if let Err(error) = self
                .spawner
                .change_torrent_uris(&gid, *file_index, &[], &add)
                .await
            {
                self.rollback_torrent_web_seed_changes(&id, &gid, &mapping, &changes)
                    .await;
                return Err(error);
            }
            let Some(current_uris) = current.get_mut(file_index) else {
                self.rollback_torrent_web_seed_changes(&id, &gid, &mapping, &changes)
                    .await;
                return Err("Aria2 web-seed state contains an unknown Torrent file index".to_string());
            };
            current_uris.insert(uri.clone());
            if !self.is_aria2_control_epoch_current(id, mapping.epoch).await
                || !self.is_current_aria2_gid_mapping(&gid, &mapping)
            {
                self.rollback_torrent_web_seed_changes(&id, &gid, &mapping, &changes)
                    .await;
                return Err("Torrent lifecycle changed while attaching web seeds".to_string());
            }
        }
        let readback = match self.spawner.get_torrent_file_uris(&gid).await {
            Ok(readback) => readback,
            Err(error) => {
                self.rollback_torrent_web_seed_changes(&id, &gid, &mapping, &changes)
                    .await;
                return Err(error);
            }
        };
        if !self.is_aria2_control_epoch_current(id, mapping.epoch).await
            || !self.is_current_aria2_gid_mapping(&gid, &mapping)
        {
            self.rollback_torrent_web_seed_changes(&id, &gid, &mapping, &changes)
                .await;
            return Err("Torrent lifecycle changed while reading initial web seeds".to_string());
        }
        let readback = match normalize_aria2_torrent_file_uris(readback, &files) {
            Ok(readback) => readback,
            Err(error) => {
                self.rollback_torrent_web_seed_changes(&id, &gid, &mapping, &changes)
                    .await;
                return Err(error);
            }
        };
        if readback != expected {
            self.rollback_torrent_web_seed_changes(&id, &gid, &mapping, &changes)
                .await;
            return Err("Aria2 did not retain the persisted Torrent web-seed set".to_string());
        }
        Ok(())
    }

    pub fn set_aria2_global_speed_limit(&self, limit: Option<String>) {
        *self
            .aria2_global_speed_limit
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = limit;
    }

    pub async fn aria2_speed_limited(&self, id: &str) -> bool {
        let item_limit = self
            .aria2_payloads
            .lock()
            .await
            .get(id)
            .and_then(|payload| payload.speed_limit.as_deref())
            .and_then(normalize_download_speed_limit);
        if item_limit.as_deref() == Some("0") {
            return false;
        }
        item_limit.is_some()
            || self
                .aria2_global_speed_limit
                .lock()
                .unwrap_or_else(|error| error.into_inner())
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
                normalize_download_speed_limit(raw)
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

    async fn get_aria2_torrent_peer_result(
        &self,
        id: &str,
        result_kind: &str,
    ) -> Result<serde_json::Value, String> {
        let _control_guard = self.acquire_aria2_control(id).await;
        if !self.is_registered(id).await {
            return Err("Torrent peer diagnostics are unavailable for this lifecycle".to_string());
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
        let still_current = self.is_registered(id).await
            && self
                .is_aria2_control_epoch_current(id, expected_mapping.epoch)
                .await
            && self.is_current_aria2_gid_mapping(&gid, &expected_mapping)
            && self.aria2_gid_for_download(id).as_deref() == Some(gid.as_str());
        if !still_current {
            return Err(format!("Torrent lifecycle changed while reading {result_kind}"));
        }

        Ok(result)
    }

    /// Return bounded peer diagnostics for the current Torrent GID. Endpoint
    /// and peer-id fields live only in this response; they are not persisted.
    /// The control lock and post-RPC mapping check prevent a late response from
    /// being attributed to a replaced or terminal lifecycle.
    pub async fn get_aria2_torrent_peers(
        &self,
        id: &str,
    ) -> Result<crate::ipc::TorrentPeerDiagnostics, String> {
        let result = self
            .get_aria2_torrent_peer_result(id, "peer diagnostics")
            .await?;
        parse_torrent_peer_diagnostics(result)
    }

    /// Compute bounded, anonymized swarm availability for the current
    /// Torrent lifecycle. The raw local/peer bitfields are consumed in native
    /// memory and never returned to the frontend.
    pub async fn get_aria2_torrent_availability(
        &self,
        id: &str,
    ) -> Result<crate::ipc::TorrentAvailabilitySnapshot, String> {
        let _control_guard = self.acquire_aria2_control(id).await;
        if !self.is_registered(id).await {
            return Err("Torrent availability is unavailable for this lifecycle".to_string());
        }
        if !self
            .aria2_payloads
            .lock()
            .await
            .get(id)
            .is_some_and(|payload| payload.is_torrent)
        {
            return Err("download is not a Torrent transfer".to_string());
        }
        let gid = self
            .aria2_gid_for_download(id)
            .ok_or_else(|| "active Torrent has no gid".to_string())?;
        let expected_mapping = self
            .aria2_gid_mapping(&gid)
            .ok_or_else(|| "active Torrent has no current gid mapping".to_string())?;
        if expected_mapping.id != id
            || !self
                .is_aria2_control_epoch_current(id, expected_mapping.epoch)
                .await
        {
            return Err("active Torrent has a stale control epoch".to_string());
        }
        let state = self.app_handle.state::<crate::AppState>();
        let status = crate::rpc_call(
            state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
            &state.aria2_secret,
            "aria2.tellStatus",
            serde_json::json!([gid, ["bitfield", "numPieces"]]),
        )
        .await
        .map_err(|error| {
            format!(
                "aria2.tellStatus failed: {}",
                crate::redact_sensitive_text(&error)
            )
        })?;
        if !self.is_current_aria2_gid_mapping(&gid, &expected_mapping)
            || !self
                .is_aria2_control_epoch_current(id, expected_mapping.epoch)
                .await
        {
            return Err("Torrent lifecycle changed while reading availability".to_string());
        }
        let peers = crate::rpc_call(
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
        let snapshot = parse_torrent_availability(status, peers)?;
        if !self.is_registered(id).await
            || !self.is_current_aria2_gid_mapping(&gid, &expected_mapping)
            || !self
                .is_aria2_control_epoch_current(id, expected_mapping.epoch)
                .await
        {
            return Err("Torrent lifecycle changed while reading availability".to_string());
        }
        Ok(snapshot)
    }

    /// Return a lifecycle-fenced, metadata-derived projection of Aria2's
    /// per-file progress. The daemon's absolute paths and URI lists are never
    /// copied across the boundary.
    pub async fn get_aria2_torrent_file_progress(
        &self,
        id: &str,
    ) -> Result<crate::ipc::TorrentFileProgressSnapshot, String> {
        let _control_guard = self.acquire_aria2_control(id).await;
        if !self.is_registered(id).await {
            return Err("live Torrent file progress is unavailable".to_string());
        }
        let payload = self
            .aria2_payloads
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| "live Torrent file progress is unavailable".to_string())?;
        if !payload.is_torrent {
            return Err("download is not a Torrent transfer".to_string());
        }
        let torrent_path = payload
            .torrent_path
            .as_deref()
            .ok_or_else(|| "live Torrent file progress is unavailable".to_string())?;
        let torrent_path = crate::torrent::validate_managed_torrent_path(
            &self.app_handle,
            id,
            torrent_path,
        )?;
        let bytes = crate::torrent::read_bounded_torrent_bytes(&torrent_path)
            .await
            .map_err(|_| "live Torrent file progress is unavailable".to_string())?;
        let metadata = crate::torrent::parse_torrent_bytes(&bytes)?;
        let gid = self
            .aria2_gid_for_download(id)
            .ok_or_else(|| "live Torrent file progress is unavailable".to_string())?;
        let expected_mapping = self
            .aria2_gid_mapping(&gid)
            .ok_or_else(|| "live Torrent file progress is unavailable".to_string())?;
        if expected_mapping.id != id
            || !self
                .is_aria2_control_epoch_current(id, expected_mapping.epoch)
                .await
        {
            return Err("live Torrent file progress is unavailable".to_string());
        }

        let state = self.app_handle.state::<crate::AppState>();
        let result = crate::rpc_call(
            state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
            &state.aria2_secret,
            "aria2.getFiles",
            serde_json::json!([gid]),
        )
        .await
        .map_err(|error| {
            format!(
                "aria2.getFiles failed: {}",
                crate::redact_sensitive_text(&error)
            )
        })?;
        let snapshot = parse_torrent_file_progress(result, &metadata.files)?;

        let still_current = self.is_registered(id).await
            && self
                .is_aria2_control_epoch_current(id, expected_mapping.epoch)
                .await
            && self.is_current_aria2_gid_mapping(&gid, &expected_mapping)
            && self.aria2_gid_for_download(id).as_deref() == Some(gid.as_str());
        if !still_current {
            return Err("Torrent lifecycle changed while reading file progress".to_string());
        }

        Ok(snapshot)
    }

    /// Return a bounded, lifecycle-fenced projection of Aria2's piece
    /// bitfield. The raw bitfield never crosses the native boundary; the UI
    /// receives only exact counts and balanced percentage buckets.
    pub async fn get_aria2_torrent_piece_progress(
        &self,
        id: &str,
    ) -> Result<crate::ipc::TorrentPieceProgressSnapshot, String> {
        let _control_guard = self.acquire_aria2_control(id).await;
        if !self.is_registered(id).await {
            return Err("live Torrent piece progress is unavailable".to_string());
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
            .ok_or_else(|| "live Torrent piece progress is unavailable".to_string())?;
        let expected_mapping = self
            .aria2_gid_mapping(&gid)
            .ok_or_else(|| "live Torrent piece progress is unavailable".to_string())?;
        if expected_mapping.id != id
            || !self
                .is_aria2_control_epoch_current(id, expected_mapping.epoch)
                .await
        {
            return Err("live Torrent piece progress is unavailable".to_string());
        }

        let state = self.app_handle.state::<crate::AppState>();
        let result = crate::rpc_call(
            state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
            &state.aria2_secret,
            "aria2.tellStatus",
            serde_json::json!([gid, ["bitfield", "pieceLength", "numPieces"]]),
        )
        .await
        .map_err(|error| {
            format!(
                "aria2.tellStatus failed: {}",
                crate::redact_sensitive_text(&error)
            )
        })?;
        let snapshot = parse_torrent_piece_progress(result)?;

        let still_current = self.is_registered(id).await
            && self
                .is_aria2_control_epoch_current(id, expected_mapping.epoch)
                .await
            && self.is_current_aria2_gid_mapping(&gid, &expected_mapping)
            && self.aria2_gid_for_download(id).as_deref() == Some(gid.as_str());
        if !still_current {
            return Err("Torrent lifecycle changed while reading piece progress".to_string());
        }

        Ok(snapshot)
    }

    /// Pop the next task, or None if empty.
    pub async fn pop_front(&self) -> Option<QueuedTask> {
        let _admission_gate = self.admission_gate.lock().await;
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
            if !self
                .is_registered_generation_or_legacy(id, lifecycle_generation)
                .await
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
                if self
                    .is_registered_generation_or_legacy(id, lifecycle_generation)
                    .await
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
        if self.system_action_pending.load(Ordering::Acquire) {
            return None;
        }
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
        if self.system_action_pending.load(Ordering::Acquire) {
            let removed = self
                .queue_permit_ownership
                .lock()
                .await
                .get(id)
                .is_some_and(|entry| {
                    entry.lifecycle_generation == lifecycle_generation && !entry.active
                });
            if removed {
                self.queue_permit_ownership.lock().await.remove(id);
                self.notify.notify_waiters();
            }
            return false;
        }
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
        if self.system_action_pending.load(Ordering::Acquire) {
            return None;
        }
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
        if self.system_action_pending.load(Ordering::Acquire) {
            return;
        }
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
        if self.system_action_pending.load(Ordering::Acquire) {
            let remove_reservation = ownership.get(id).is_some_and(|entry| {
                entry.queue_id == queue_id
                    && entry.lifecycle_generation == lifecycle_generation
                    && !entry.active
            });
            if remove_reservation {
                ownership.remove(id);
                self.notify.notify_waiters();
            }
            return false;
        }
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

    /// Atomically fence new transfer admission after checking all backend-owned
    /// work. The frontend performs the same check for a useful user message,
    /// but this backend transition closes the check-to-action race.
    pub async fn begin_system_action(&self, force: bool) -> Result<(), String> {
        let _admission_gate = self.admission_gate.lock().await;
        if self.system_action_pending.load(Ordering::Acquire) {
            return Err("Another system action is already pending".to_string());
        }
        if !force
            && (!self.pending.lock().await.is_empty()
                || !self.queue_permit_ownership.lock().await.is_empty()
                || !self.active_permits.lock().await.is_empty()
                || self.has_torrent_moves())
        {
            return Err("System action was skipped because downloads are still active or queued".to_string());
        }
        self.system_action_pending.store(true, Ordering::Release);
        Ok(())
    }

    pub fn end_system_action(&self) {
        self.system_action_pending.store(false, Ordering::Release);
        self.notify.notify_waiters();
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
        // Unknown start notifications belong to the current Aria2 daemon
        // session. A reconnect/restart invalidates that association; the
        // poller will provide a fresh positive-progress fallback after the
        // next GID mapping instead of letting an old GID clear a new phase.
        self.pending_download_starts.lock().await.clear();
    }

    /// Number of un-acquired permits currently in the semaphore pool.
    pub fn available_permits(&self) -> usize {
        self.semaphore.available_permits()
    }

    pub(crate) fn emit_state(&self, id: impl Into<String>, status: DownloadStatus) {
        use tauri::Emitter;
        let _ = self
            .app_handle
            .emit("download-state", DownloadStateEvent::new(id, status));
    }

    fn emit_allocation_event(&self, id: &str, pending: bool, lifecycle_generation: u64) {
        use tauri::Emitter;
        let _ = self.app_handle.emit(
            "download-allocation",
            DownloadAllocationEvent {
                id: id.to_string(),
                pending,
                lifecycle_generation: lifecycle_generation.to_string(),
            },
        );
    }

    pub fn aria2_allocation_phase_eligible(payload: &SpawnPayload) -> bool {
        if payload.is_media || payload.is_torrent || payload.torrent_verify_only {
            return false;
        }
        true
    }

    async fn begin_aria2_allocation(
        &self,
        id: &str,
        control_epoch: u64,
        lifecycle_generation: u64,
        payload: &SpawnPayload,
    ) {
        if !Self::aria2_allocation_phase_eligible(payload) {
            return;
        }
        self.aria2_allocation_pending
            .lock()
            .await
            .insert(id.to_string(), (control_epoch, lifecycle_generation));
        self.emit_allocation_event(id, true, lifecycle_generation);
    }

    pub async fn clear_aria2_allocation_for_lifecycle_generation(
        &self,
        id: &str,
        lifecycle_generation: u64,
    ) {
        let cleared_generation = {
            let mut pending = self.aria2_allocation_pending.lock().await;
            let Some((_, pending_generation)) = pending.get(id).copied() else {
                return;
            };
            if pending_generation != lifecycle_generation {
                return;
            }
            pending.remove(id).map(|(_, generation)| generation)
        };
        if let Some(cleared_generation) = cleared_generation {
            self.emit_allocation_event(id, false, cleared_generation);
        }
    }

    pub async fn clear_aria2_allocation_for_epoch(&self, id: &str, control_epoch: u64) {
        let lifecycle_generation = {
            let mut pending = self.aria2_allocation_pending.lock().await;
            let Some((pending_epoch, lifecycle_generation)) = pending.get(id).copied() else {
                return;
            };
            if pending_epoch != control_epoch {
                return;
            }
            pending.remove(id);
            lifecycle_generation
        };
        self.emit_allocation_event(id, false, lifecycle_generation);
    }

    pub async fn clear_aria2_allocation(&self, id: &str) {
        let lifecycle_generation = self
            .aria2_allocation_pending
            .lock()
            .await
            .remove(id)
            .map(|(_, lifecycle_generation)| lifecycle_generation);
        if let Some(lifecycle_generation) = lifecycle_generation {
            self.emit_allocation_event(id, false, lifecycle_generation);
        }
    }

    pub async fn complete_aria2_allocation_for_gid(&self, gid: &str, downloaded_bytes: u64) {
        // Aria2 reports an active GID with completedLength=0 while it is still
        // creating preallocated files. That observation is not native
        // transfer progress and must not hide the allocation phase.
        if downloaded_bytes == 0 {
            return;
        }
        let mapping = {
            let _gid_state = self.aria2_gid_state.lock().await;
            if self.is_aria2_gid_ignored_locked(gid).await {
                return;
            }
            let Some(mapping) = self.aria2_gid_mapping(gid) else {
                let mut starts = self.pending_download_starts.lock().await;
                if starts.len() < MAX_PENDING_DOWNLOAD_STARTS {
                    starts.insert(gid.to_string());
                }
                return;
            };
            mapping
        };
        if !self
            .is_current_aria2_gid_mapping(gid, &mapping)
            || !self
                .is_aria2_control_epoch_current(&mapping.id, mapping.epoch)
                .await
        {
            return;
        }
        self.clear_aria2_allocation_for_epoch(&mapping.id, mapping.epoch)
            .await;
    }

    pub async fn handle_aria2_download_start(&self, gid: &str, downloaded_bytes: u64) {
        // Aria2 can publish onDownloadStart before it finishes creating
        // preallocated files. A zero-byte start is therefore not native
        // transfer progress and must leave the allocation phase visible.
        if downloaded_bytes == 0 {
            return;
        }
        let mapping = {
            let _gid_state = self.aria2_gid_state.lock().await;
            if self.is_aria2_gid_ignored_locked(gid).await {
                return;
            }
            let Some(mapping) = self.aria2_gid_mapping(gid) else {
                let mut starts = self.pending_download_starts.lock().await;
                if starts.len() < MAX_PENDING_DOWNLOAD_STARTS {
                    starts.insert(gid.to_string());
                }
                return;
            };
            mapping
        };
        if !self
            .is_current_aria2_gid_mapping(gid, &mapping)
            || !self
                .is_aria2_control_epoch_current(&mapping.id, mapping.epoch)
                .await
        {
            return;
        }
        self.clear_aria2_allocation_for_epoch(&mapping.id, mapping.epoch)
            .await;
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
            if self.try_start_waiting_seed().await {
                continue;
            }
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
            // Register the native allocation phase before releasing the
            // lifecycle lock. A pause/remove can otherwise invalidate this
            // dispatch in the gap and leave a stale pending marker behind
            // when the asynchronous addUri call starts.
            self.begin_aria2_allocation(
                &id,
                epoch,
                lifecycle_generation,
                &task.payload,
            )
            .await;
        }
        drop(control_guard);

        // Media runners do not receive an Aria2 GID. Their permit is already
        // active at this point, so publish their live state before spawning
        // the runner; Aria2 tasks publish only after remember_gid below.
        if matches!(&task.kind, TaskKind::Media) {
            self.emit_state(&id, DownloadStatus::Downloading);
        }

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
                            self.clear_aria2_allocation_for_epoch(&id, lifecycle_epoch)
                                .await;
                            return;
                        }
                        // A queued task is not a live transfer until aria2 has
                        // accepted it and Firelink has installed the GID
                        // mapping. Emitting Downloading before this point
                        // lets the UI (and a concurrent Properties pause)
                        // act on a lifecycle that does not yet exist.
                        let buffered_outcome = self.remember_gid(id.clone(), gid.clone()).await;
                        if buffered_outcome.is_none() {
                            self.emit_state(&id, DownloadStatus::Downloading);
                        }
                        let install_web_seeds = buffered_outcome.is_none()
                            && task.payload.is_torrent
                            && !task.payload.torrent_verify_only
                            && task.payload.torrent_web_seeds.is_some();
                        self.finish_aria2_dispatch(&id, lifecycle_epoch).await;
                        drop(control_guard);
                        if install_web_seeds {
                            if let Err(error) = self.install_initial_torrent_web_seeds(&id).await {
                                // Initial web-seed installation is a
                                // post-GID lifecycle step. Reacquire the
                                // control lock and fence the failure against
                                // the dispatch epoch before retiring the GID;
                                // an old install error must never fail a
                                // newer retry/resume lifecycle.
                                let _control_guard = self.acquire_aria2_control(&id).await;
                                let current_gid = self.aria2_gid_for_download(&id);
                                let current = self
                                    .is_aria2_control_epoch_current(&id, lifecycle_epoch)
                                    .await
                                    && self.is_registered(&id).await
                                    && matches!(self.active_kind(&id).await, Some(TaskKind::Aria2))
                                    && current_gid.as_deref().is_some_and(|gid| {
                                        self.aria2_gid_mapping(gid).is_some_and(|mapping| {
                                            mapping.id == id && mapping.epoch == lifecycle_epoch
                                        })
                                    });
                                if current {
                                    if let Some(current_gid) = current_gid {
                                        if let Err(remove_error) = self.spawner.remove_uri(&current_gid).await {
                                            log::warn!(
                                                "aria2 dispatch web-seed failure [{}]: could not remove gid {}: {}",
                                                id,
                                                current_gid,
                                                remove_error
                                            );
                                        }
                                        self.ignore_aria2_gid(&current_gid).await;
                                    }
                                    self.apply_completion_locked(
                                        &id,
                                        PendingOutcome::Error(format!(
                                            "could not attach Torrent web seeds: {error}"
                                        )),
                                    )
                                    .await;
                                } else {
                                    log::info!(
                                        "aria2 dispatch web-seed failure [{}]: ignoring stale install error after a newer lifecycle took ownership",
                                        id
                                    );
                                }
                                return;
                            }
                        }
                        if let Some(outcome) = buffered_outcome {
                            self.handle_aria2_pending_event(&gid, outcome).await;
                        }
                    }
                    Err(error) => {
                        self.clear_aria2_allocation_for_epoch(&id, lifecycle_epoch)
                            .await;
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
        self.emit_failed_with_progress(id, error, None);
    }

    fn emit_failed_with_progress(
        &self,
        id: &str,
        error: String,
        progress: Option<DownloadStateProgress>,
    ) {
        use tauri::Emitter;
        let mut event = DownloadStateEvent::failed(id, error);
        if let Some(progress) = progress {
            event = event.with_progress(progress);
        }
        let _ = self
            .app_handle
            .emit("download-state", event);
    }

    fn emit_paused_with_error_and_progress(
        &self,
        id: &str,
        error: String,
        progress: Option<DownloadStateProgress>,
    ) {
        use tauri::Emitter;
        let mut event = DownloadStateEvent::paused_with_error(id, error);
        if let Some(progress) = progress {
            event = event.with_progress(progress);
        }
        let _ = self.app_handle.emit(
            "download-state",
            event,
        );
    }

    /// Store gid -> id and return any buffered terminal event for the caller
    /// to reconcile against the correct event path. In particular, buffered
    /// errors must still pass through transient retry classification.
    pub async fn remember_gid(&self, id: String, gid: String) -> Option<PendingAria2Outcome> {
        // A new GID starts a fresh Aria2 observation. In particular, a
        // missing-GID recovery or retry must not inherit the handoff deadline
        // of the retired magnet metadata parent.
        self.clear_aria2_magnet_handoff(&id).await;
        self.aria2_magnet_payload_gids.lock().await.remove(&id);
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
        let start_buffered = self
            .pending_download_starts
            .lock()
            .await
            .remove(&gid);
        if start_buffered {
            self.clear_aria2_allocation_for_epoch(&id, epoch).await;
        }
        let retry_strike = self.aria2_retry_strike(&id).await;
        log::info!(
            "aria2 gid transition [stage=gid_transition id={} gid={} epoch={} retry_strike={} action=mapped]",
            id,
            gid,
            epoch,
            retry_strike
        );
        buffered_outcome
    }

    /// Rebind an existing paused GID to the new lifecycle created by resume.
    /// The GID remains stable across aria2.pause/unpause, but its previous
    /// epoch must not be reused after a pause invalidated that lifecycle.
    pub async fn rebind_aria2_gid_epoch(&self, id: &str, gid: &str, epoch: u64) -> bool {
        let _gid_state = self.aria2_gid_state.lock().await;
        {
            let mut gids = self.aria2_gids.write().unwrap();
            let Some(mapping) = gids.get_mut(gid) else {
                return false;
            };
            if mapping.id != id {
                return false;
            }
            mapping.epoch = epoch;
        }
        if let Some(options) = self.aria2_connection_options.lock().await.get_mut(id) {
            options.epoch = epoch;
        }
        if self.aria2_gid_for_download(id).as_deref() == Some(gid) {
            if let Some(payload_mapping) = self.aria2_magnet_payload_gids.lock().await.get_mut(id) {
                if payload_mapping.id == id {
                    payload_mapping.epoch = epoch;
                }
            }
        }
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
        self.apply_completion_locked_with_progress(id, outcome, None)
            .await;
    }

    pub(crate) async fn apply_completion_locked_with_progress(
        &self,
        id: &str,
        outcome: PendingOutcome,
        progress: Option<DownloadStateProgress>,
    ) {
        self.clear_aria2_magnet_handoff(id).await;
        self.clear_aria2_allocation(id).await;
        if matches!(&outcome, PendingOutcome::Complete) {
            self.capture_torrent_verification_evidence(id).await;
        }
        let (verification_restore_status, verification_only, verification_observed) = {
            let payloads = self.aria2_payloads.lock().await;
            payloads
                .get(id)
                .filter(|payload| payload.torrent_verify_only)
                .map(|payload| {
                    (
                        payload.torrent_verify_restore_status.clone(),
                        true,
                        payload.torrent_verified_length.is_some(),
                    )
                })
                .unwrap_or((None, false, false))
        };
        let outcome = match outcome {
            PendingOutcome::Complete if verification_only && !verification_observed => {
                PendingOutcome::Error(
                    "Torrent integrity verification did not produce a complete hash-check result"
                        .to_string(),
                )
            }
            PendingOutcome::Seeding if self.aria2_torrent_seeding_requested(id).await => {
                if !self.seed_capacity_enabled() {
                    // Keep a budget record even when the legacy single-pool
                    // mode is active. If the user enables separate seed
                    // capacity while this Torrent is already seeding, the
                    // existing seeder must be counted before admitting new
                    // seeders.
                    self.record_seed_started(id).await;
                    self.emit_state(id, DownloadStatus::Seeding);
                    return;
                }
                match self.admit_seed_after_completion(id).await {
                    SeedAdmissionOutcome::Seeding => {
                        self.emit_state(id, DownloadStatus::Seeding);
                        return;
                    }
                    SeedAdmissionOutcome::Waiting => {
                        let remaining = self
                            .aria2_payloads
                            .lock()
                            .await
                            .get(id)
                            .and_then(|payload| payload.torrent_seed_remaining);
                        self.emit_waiting_to_seed(id, remaining);
                        return;
                    }
                    SeedAdmissionOutcome::Complete => PendingOutcome::Complete,
                }
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
                self.forget_torrent_telemetry(id).await;
                self.clear_aria2_retry_state(id).await;
                self.forget_aria2_gid(id).await;
                if torrent_removal_requested {
                    match crate::download_ownership::clear_torrent_removal_paths_if_absent(
                        &self.app_handle,
                        id,
                    ) {
                        Ok(true) => {}
                        Ok(false) => {
                            log::warn!(
                                "aria2 torrent removal reservation [{}]: keeping paths reserved because Aria2 cleanup was not observed",
                                id
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
                let restored_status = if verification_only {
                    if verification_restore_status.as_deref() == Some("completed") {
                        DownloadStatus::Completed
                    } else {
                        DownloadStatus::Paused
                    }
                } else {
                    match verification_restore_status.as_deref() {
                        Some("paused") => DownloadStatus::Paused,
                        Some("failed") => DownloadStatus::Failed,
                        Some("ready") => DownloadStatus::Ready,
                        Some("staged") => DownloadStatus::Staged,
                        Some("completed") => DownloadStatus::Completed,
                        _ => DownloadStatus::Completed,
                    }
                };
                let mut event = DownloadStateEvent::new(id, restored_status);
                if let Some(progress) = progress {
                    event = event.with_progress(progress);
                }
                use tauri::Emitter;
                let _ = self.app_handle.emit("download-state", event);
            }
            PendingOutcome::Error(error) => {
                self.forget_torrent_telemetry(id).await;
                let terminal_gid = self
                    .aria2_gid_for_download(id)
                    .unwrap_or_else(|| "<none>".to_string());
                let terminal_epoch = self
                    .aria2_gid_for_download(id)
                    .and_then(|gid| self.aria2_gid_mapping(&gid).map(|mapping| mapping.epoch))
                    .unwrap_or(self.current_aria2_control_epoch(id).await);
                let retry_strike = self
                    .aria2_retry_strikes
                    .lock()
                    .await
                    .get(id)
                    .copied()
                    .unwrap_or_default();
                let requested_connections = self
                    .aria2_requested_connections(id)
                    .await
                    .unwrap_or(DOWNLOAD_CONNECTIONS_MIN);
                let effective_connections = self
                    .aria2_effective_connections(id, terminal_epoch)
                    .await
                    .unwrap_or(requested_connections);
                if !verification_only && error.to_ascii_lowercase().contains("checksum") {
                    log::warn!("Checksum error detected for {}, cleaning up assets", id);
                    if let Ok(paths) =
                        crate::download_ownership::owned_paths_for_id(&self.app_handle, id)
                    {
                        for path in paths {
                            let _ = crate::remove_download_assets(&path, &self.app_handle).await;
                        }
                    }
                }

                let error = if verification_only {
                    format!(
                        "Torrent integrity verification failed; resume the Torrent to repair it: {error}"
                    )
                } else {
                    error
                };

                self.clear_aria2_retry_state(id).await;
                self.forget_aria2_gid(id).await;
                if torrent_removal_requested {
                    match crate::download_ownership::clear_torrent_removal_paths_if_absent(
                        &self.app_handle,
                        id,
                    ) {
                        Ok(true) => {}
                        Ok(false) => log::warn!(
                            "aria2 torrent removal reservation [{}]: keeping paths reserved because cleanup was not observed after failure",
                            id
                        ),
                        Err(clear_error) => log::warn!(
                            "aria2 torrent removal reservation [{}]: could not verify cleanup after terminal failure: {}",
                            id,
                            clear_error
                        ),
                    }
                }
                self.release_registered_id(id).await;
                self.release_permit(id).await;
                if verification_only {
                    self.emit_paused_with_error_and_progress(id, error, progress);
                } else {
                    let aria2_code = aria2_error_code(&error).unwrap_or_else(|| "none".to_string());
                    log::error!(
                        "aria2 terminal [stage=terminal id={} gid={} epoch={} retry_strike={} requested_connections={} effective_connections={} error_class={} aria2_error_code={}]",
                        id,
                        terminal_gid,
                        terminal_epoch,
                        retry_strike,
                        requested_connections,
                        effective_connections,
                        network_error_class(&error),
                        aria2_code
                    );
                    self.emit_failed_with_progress(id, error, progress);
                }
            }
            PendingOutcome::Seeding => unreachable!("seeding outcomes are normalized before terminal cleanup"),
        }
    }

    pub async fn clear_aria2_retry_state(&self, id: &str) {
        self.clear_aria2_magnet_handoff(id).await;
        self.aria2_magnet_payload_gids.lock().await.remove(id);
        self.aria2_payloads.lock().await.remove(id);
        self.aria2_retry_strikes.lock().await.remove(id);
        self.aria2_connection_options.lock().await.remove(id);
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

    async fn note_aria2_magnet_handoff(
        &self,
        id: &str,
        parent_gid: &str,
        epoch: u64,
    ) -> bool {
        let mut handoffs = self.aria2_magnet_handoffs.lock().await;
        let state = handoffs
            .entry(id.to_string())
            .or_insert_with(|| Aria2MagnetHandoffState {
                parent_gid: parent_gid.to_string(),
                epoch,
                started_at: Instant::now(),
            });
        if state.parent_gid != parent_gid || state.epoch != epoch {
            *state = Aria2MagnetHandoffState {
                parent_gid: parent_gid.to_string(),
                epoch,
                started_at: Instant::now(),
            };
        }
        state.started_at.elapsed() >= ARIA2_MAGNET_CHILD_HANDOFF_TIMEOUT
    }

    async fn clear_aria2_magnet_handoff(&self, id: &str) {
        self.aria2_magnet_handoffs.lock().await.remove(id);
    }

    async fn remove_aria2_magnet_parent_result(&self, gid: &str) {
        let Some(state) = self.app_handle.try_state::<crate::AppState>() else {
            return;
        };
        let port = state
            .aria2_port
            .load(std::sync::atomic::Ordering::Relaxed);
        let secret = state.aria2_secret.clone();
        drop(state);
        for attempt in 1..=3 {
            match crate::rpc_call(
                port,
                &secret,
                "aria2.removeDownloadResult",
                serde_json::json!([gid]),
            )
            .await
            {
                Ok(result) if result.as_str() == Some(gid) => return,
                Ok(result) => {
                    log::debug!(
                        "aria2 magnet handoff [stage=cleanup gid={} attempt={} result=unexpected_return value={}]",
                        gid,
                        attempt,
                        crate::redact_sensitive_text(&result.to_string())
                    );
                    return;
                }
                Err(_error) if attempt < 3 => {
                    tokio::time::sleep(Duration::from_millis(50 * attempt as u64)).await;
                }
                Err(error) => log::debug!(
                    "aria2 magnet handoff [stage=cleanup gid={} attempts={} result=deferred error_class={} error_code={}]",
                    gid,
                    attempt,
                    network_error_class(&error),
                    diagnostic_error_code(&error)
                ),
            }
        }
    }

    /// Aria2 represents a direct magnet as a short metadata parent lifecycle
    /// followed by a real payload child GID. Firelink owns one download ID,
    /// permit, and lifecycle epoch, so completion of the metadata parent must
    /// be converted into an atomic mapping transfer before terminal handling.
    async fn reconcile_aria2_magnet_parent_completion(
        &self,
        id: &str,
        parent_gid: &str,
        expected_mapping: &Aria2GidMapping,
    ) -> Aria2MagnetCompletionDisposition {
        let payload = self.aria2_payloads.lock().await.get(id).cloned();
        let Some(_) = payload.filter(is_direct_magnet_payload) else {
            return Aria2MagnetCompletionDisposition::NotMetadataParent;
        };
        if !self.is_current_aria2_gid_mapping(parent_gid, expected_mapping)
            || !self
                .is_aria2_control_epoch_current(id, expected_mapping.epoch)
                .await
        {
            return Aria2MagnetCompletionDisposition::Deferred;
        }

        // A child adopted by this lifecycle is already known to be the real
        // payload. Avoid asking Aria2 for its complete file list just to prove
        // that a terminal child is not the short metadata parent.
        let adopted_payload = self
            .aria2_magnet_payload_gids
            .lock()
            .await
            .get(id)
            .is_some_and(|mapping| {
                mapping == expected_mapping
                    && self.aria2_gid_for_download(id).as_deref() == Some(parent_gid)
            });
        if adopted_payload {
            return Aria2MagnetCompletionDisposition::NotMetadataParent;
        }

        let handoff_expired = self
            .note_aria2_magnet_handoff(id, parent_gid, expected_mapping.epoch)
            .await;
        let Some(state) = self.app_handle.try_state::<crate::AppState>() else {
            return Aria2MagnetCompletionDisposition::Deferred;
        };
        let port = state
            .aria2_port
            .load(std::sync::atomic::Ordering::Relaxed);
        let secret = state.aria2_secret.clone();
        drop(state);

        let parent_status = match crate::rpc_call(
            port,
            &secret,
            "aria2.tellStatus",
            serde_json::json!([parent_gid, ["status", "followedBy", "files", "errorCode", "errorMessage"]]),
        )
        .await
        {
            Ok(status) => status,
            Err(error) => {
                log::debug!(
                    "aria2 magnet handoff [stage=parent_status id={} gid={} epoch={} result=unavailable error_class={} error_code={}]",
                    id,
                    parent_gid,
                    expected_mapping.epoch,
                    network_error_class(&error),
                    diagnostic_error_code(&error)
                );
                return if handoff_expired {
                    Aria2MagnetCompletionDisposition::Failed(
                        "Aria2 completed magnet metadata but did not expose the payload download"
                            .to_string(),
                    )
                } else {
                    Aria2MagnetCompletionDisposition::Deferred
                };
            }
        };
        let parent_status_name = parent_status
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let parent_has_metadata = aria2_magnet_parent_has_metadata_file(&parent_status);
        let parent_has_payload = aria2_magnet_parent_has_payload_file(&parent_status);
        let child_gids = aria2_magnet_followed_gids(&parent_status, parent_gid);
        let child_count = child_gids.len();

        // Aria2 can expose more than one followed GID. Query the bounded set
        // concurrently so a missing or slow child cannot hold the per-download
        // control lock while every 3-second RPC timeout is consumed in series.
        let child_statuses = futures_util::future::join_all(child_gids.into_iter().map(|child_gid| async {
            let result = crate::rpc_call(
                port,
                &secret,
                "aria2.tellStatus",
                serde_json::json!([child_gid, [
                    "status",
                    "belongsTo",
                    "errorCode",
                    "errorMessage",
                    "completedLength",
                    "totalLength",
                    "uploadLength",
                    "seeder"
                ]]),
            )
            .await;
            match result {
                Ok(status) => (child_gid, Some(status)),
                Err(error) => {
                    log::debug!(
                        "aria2 magnet handoff [stage=child_status id={} parent_gid={} child_gid={} epoch={} result=unavailable error_class={} error_code={}]",
                        id,
                        parent_gid,
                        child_gid,
                        expected_mapping.epoch,
                        network_error_class(&error),
                        diagnostic_error_code(&error)
                    );
                    (child_gid, None)
                }
            }
        })).await;

        for (child_gid, child_status) in child_statuses {
            let Some(child_status) = child_status else {
                continue;
            };
            if child_status
                .get("belongsTo")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|belongs_to| belongs_to != parent_gid)
            {
                continue;
            }
            let child_status_name = child_status
                .get("status")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if !matches!(
                child_status_name,
                "active" | "waiting" | "paused" | "complete" | "error" | "removed"
            ) {
                continue;
            }

            let pending_child = {
                let _gid_state = self.aria2_gid_state.lock().await;
                let current_mapping = self.aria2_gid_mapping(parent_gid);
                if current_mapping.as_ref() != Some(expected_mapping) {
                    return Aria2MagnetCompletionDisposition::Deferred;
                }
                let child_owned_by_other_download = self
                    .aria2_gid_mapping(&child_gid)
                    .is_some_and(|mapping| mapping.id != id);
                if child_owned_by_other_download {
                    continue;
                }
                {
                    let mut gids = self.aria2_gids.write().unwrap();
                    gids.remove(parent_gid);
                    gids.insert(child_gid.clone(), expected_mapping.clone());
                }
                self.aria2_magnet_payload_gids
                    .lock()
                    .await
                    .insert(id.to_string(), expected_mapping.clone());
                self.unignore_aria2_gid_locked(&child_gid).await;
                self.ignore_aria2_gid_locked(parent_gid).await;
                self.pending_download_starts.lock().await.remove(&child_gid);
                let mut buffered = self.pending_completion.lock().await;
                buffered.remove(parent_gid);
                buffered.remove(&child_gid).map(|(_buffered_id, outcome)| outcome)
            };

            self.clear_aria2_magnet_handoff(id).await;
            log::info!(
                "aria2 magnet handoff [stage=gid_transition id={} parent_gid={} child_gid={} epoch={} child_status={} action=adopted]",
                id,
                parent_gid,
                child_gid,
                expected_mapping.epoch,
                child_status_name
            );
            return Aria2MagnetCompletionDisposition::Adopted(Aria2MagnetChildHandoff {
                gid: child_gid,
                status: child_status_name.to_string(),
                error: matches!(child_status_name, "error" | "removed")
                    .then(|| aria2_magnet_status_error(&child_status)),
                pending: pending_child,
            });
        }

        if matches!(parent_status_name, "error" | "removed") {
            self.clear_aria2_magnet_handoff(id).await;
            return Aria2MagnetCompletionDisposition::Failed(aria2_magnet_status_error(
                &parent_status,
            ));
        }
        if handoff_expired {
            Aria2MagnetCompletionDisposition::Failed(
                "Aria2 completed magnet metadata but did not expose the payload download"
                    .to_string(),
            )
        } else {
            log::debug!(
                "aria2 magnet handoff [stage=child_wait id={} gid={} epoch={} status={} child_count={} parent_metadata={} parent_payload={} action=deferred]",
                id,
                parent_gid,
                expected_mapping.epoch,
                parent_status_name,
                child_count,
                parent_has_metadata,
                parent_has_payload
            );
            Aria2MagnetCompletionDisposition::Deferred
        }
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
                        "aria2 lifecycle cleanup [stage=cleanup id={} gid={} attempt={} result=retrying error_class={} error_code={}]",
                        id,
                        gid,
                        attempt,
                        network_error_class(&error),
                        diagnostic_error_code(&error)
                    );
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(error) => {
                    log::error!(
                        "aria2 lifecycle cleanup [stage=cleanup id={} gid={} attempts={} result=failed error_class={} error_code={}]",
                        id,
                        gid,
                        MAX_ATTEMPTS,
                        network_error_class(&error),
                        diagnostic_error_code(&error)
                    );
                }
            }
        }
    }

    async fn ignore_aria2_gid_locked(&self, gid: &str) {
        const MAX_IGNORED_GIDS: usize = 1024;
        self.pending_download_starts.lock().await.remove(gid);
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

    /// A direct magnet's metadata parent is not a terminal payload GID. The
    /// parent may report `complete` before Aria2 exposes the followed child,
    /// so imperative pause/resume commands must defer to the same handoff
    /// reconciler as WebSocket and poller events instead of completing or
    /// re-enqueueing the metadata marker.
    pub(crate) async fn aria2_direct_magnet_needs_child_handoff(
        &self,
        id: &str,
        gid: &str,
    ) -> bool {
        let direct_magnet = self
            .aria2_payloads
            .lock()
            .await
            .get(id)
            .is_some_and(is_direct_magnet_payload);
        if !direct_magnet {
            return false;
        }

        let Some(mapping) = self.aria2_gid_mapping(gid) else {
            return false;
        };
        if mapping.id != id || self.aria2_gid_for_download(id).as_deref() != Some(gid) {
            return false;
        }

        !self
            .aria2_magnet_payload_gids
            .lock()
            .await
            .get(id)
            .is_some_and(|payload_mapping| payload_mapping == &mapping)
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
            let lifecycle_generation = self
                .registered_lifecycle_generation(id)
                .await
                .unwrap_or_default();
            self.begin_aria2_allocation(id, observed_epoch, lifecycle_generation, payload)
                .await;
            match self.spawner.recreate_uri(id, gid, payload).await {
                Ok(outcome) => outcome,
                Err(error) => {
                    self.clear_aria2_allocation_for_epoch(id, observed_epoch)
                        .await;
                    return Err(error);
                }
            }
        } else {
            // Older persisted rows may briefly reach recovery before their
            // payload has been rebuilt. Keep the current lifecycle intact and
            // use the non-destructive fallback until the payload is present.
            Aria2RecreateOutcome::Refresh
        };

        if let Aria2RecreateOutcome::NewGid(new_gid) = recreation {
            if new_gid.trim().is_empty() || new_gid == gid {
                self.clear_aria2_allocation_for_epoch(id, observed_epoch)
                    .await;
                return Err(format!(
                    "aria2 connection recovery returned an invalid replacement gid for {gid}"
                ));
            }

            let still_current = self.is_registered(id).await
                && !self.is_aria2_retry_cancelled(id).await
                && self.is_aria2_control_epoch_current(id, observed_epoch).await
                && self.aria2_gid_for_download(id).as_deref() == Some(gid);
            if !still_current {
                self.clear_aria2_allocation_for_epoch(id, observed_epoch)
                    .await;
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
                self.handle_aria2_pending_event(&new_gid, outcome).await;
            }
            return Ok(());
        }

        let outcome = match recreation {
            Aria2RecreateOutcome::Complete => Aria2RefreshOutcome::Complete,
            Aria2RecreateOutcome::Refresh => match self.spawner.refresh_uri(gid).await {
                Ok(outcome) => outcome,
                Err(error) => {
                    self.clear_aria2_allocation_for_epoch(id, observed_epoch)
                        .await;
                    return Err(error);
                }
            },
            Aria2RecreateOutcome::Unavailable(error) => {
                self.clear_aria2_allocation_for_epoch(id, observed_epoch)
                    .await;
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
                    "aria2 connection recovery [stage=recovery id={} gid={} result=paused_unavailable error_class={} error_code={}]",
                    id,
                    gid,
                    network_error_class(&error),
                    diagnostic_error_code(&error)
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
        self.clear_aria2_magnet_handoff(id).await;
        self.aria2_magnet_payload_gids.lock().await.remove(id);
        self.clear_aria2_allocation(id).await;
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
        progress: Option<DownloadStateProgress>,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        let this = Arc::clone(self);
        Box::pin(async move {
            this.handle_aria2_download_error_inner(&gid, error, progress)
                .await;
        })
    }

    /// Resolve a WebSocket event against the GID map, or buffer it while the
    /// map transition is still in flight. The state lock closes the window in
    /// which an event could be inserted after remember_gid drained it.
    async fn map_or_buffer_aria2_event(
        &self,
        gid: &str,
        outcome: PendingAria2Outcome,
    ) -> Option<(Aria2GidMapping, PendingAria2Outcome)> {
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

    async fn handle_aria2_download_error_inner(
        self: &Arc<Self>,
        gid: &str,
        error: String,
        progress: Option<DownloadStateProgress>,
    ) {
        let Some((mapping, pending)) = self
            .map_or_buffer_aria2_event(
                gid,
                PendingAria2Outcome {
                    outcome: PendingOutcome::Error(error),
                    progress,
                },
            )
            .await
        else {
            return;
        };
        let PendingAria2Outcome {
            outcome: PendingOutcome::Error(error),
            progress,
        } = pending
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
        // The failed GID is no longer allocating. Keep the native phase
        // marker scoped to an actual replacement addUri rather than showing
        // "Allocating files" throughout retry backoff or a failed pause.
        self.clear_aria2_allocation_for_epoch(&id, mapping.epoch)
            .await;
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
            self.apply_completion_locked_with_progress(
                &id,
                PendingOutcome::Error(error),
                progress,
            )
                .await;
            return;
        }
        let mut payload = payload.unwrap();

        let strike = {
            let mut strikes = self.aria2_retry_strikes.lock().await;
            let entry = strikes.entry(id.clone()).or_insert(0);
            *entry
        };

        let retry_action = aria2_retry_action(&payload, &error, strike);
        let requested_connections = self
            .aria2_requested_connections(&id)
            .await
            .unwrap_or(DOWNLOAD_CONNECTIONS_MIN);
        let effective_connections = self
            .aria2_effective_connections(&id, mapping.epoch)
            .await
            .unwrap_or(requested_connections);
        let action = match retry_action {
            Aria2RetryAction::OrdinaryRetry => "ordinary_retry",
            Aria2RetryAction::Terminal => "terminal",
        };
        let error_code = aria2_error_code(&error)
            .unwrap_or_else(|| network_error_class(&error).to_string());
        log::warn!(
            "aria2 retry [stage=retry id={} gid={} epoch={} retry_strike={} action={} resolver_mode={} error_class={} error_code={} requested_connections={} effective_connections={}]",
            id,
            gid,
            mapping.epoch,
            strike,
            action,
            aria2_resolver_route_for_log(&payload),
            network_error_class(&error),
            error_code,
            requested_connections,
            effective_connections
        );
        if retry_action == Aria2RetryAction::Terminal {
            self.apply_completion_locked_with_progress(
                &id,
                PendingOutcome::Error(error),
                progress,
            )
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
        let progress_for_retry = progress.clone();
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
                let event = DownloadStateEvent::retrying(&id_for_task, reason);
                let _ = this.app_handle.emit("download-state", event);
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

            let lifecycle_generation = this
                .registered_lifecycle_generation(&id_for_task)
                .await
                .unwrap_or_default();
            this.begin_aria2_allocation(
                &id_for_task,
                retry_epoch,
                lifecycle_generation,
                &current_payload,
            )
            .await;
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
                        this.clear_aria2_allocation_for_epoch(&id_for_task, retry_epoch)
                            .await;
                        drop(control_guard);
                        if let Err(error) = this.spawner.remove_uri(&new_gid).await {
                            log::error!(
                                "aria2 retry cancellation [stage=cleanup id={} gid={} result=failed error_class={} error_code={}]",
                                id_for_task,
                                new_gid,
                                network_error_class(&error),
                                diagnostic_error_code(&error)
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
                    let new_gid_for_event = new_gid.clone();
                    let buffered_outcome = this.remember_gid(id_for_task.clone(), new_gid).await;
                    // Install the replacement GID before exposing the
                    // Downloading state. If Aria2 completed or failed the
                    // replacement before the mapping was installed, apply
                    // that buffered terminal outcome directly and never
                    // publish a stale transient state.
                    if buffered_outcome.is_none() {
                        this.emit_state(&id_for_task, DownloadStatus::Downloading);
                    }
                    // The old gid remains marked as retrying until the new
                    // mapping is installed, so a duplicate old event is
                    // ignored while a genuine new-gid event is accepted.
                    this.release_aria2_retry_inflight(&id_for_task, retry_epoch)
                        .await;
                    this.aria2_retrying_gids.lock().await.remove(&retry_gid);
                    drop(control_guard);
                    if let Some(outcome) = buffered_outcome {
                        this.handle_aria2_pending_event(&new_gid_for_event, outcome)
                            .await;
                    }
                }
                Err(retry_error) => {
                    this.clear_aria2_allocation_for_epoch(&id_for_task, retry_epoch)
                        .await;
                    let stale = this.is_aria2_retry_cancelled(&id_for_task).await
                        || !this
                            .is_aria2_control_epoch_current(&id_for_task, retry_epoch)
                            .await;
                    if !stale {
                        this.apply_completion_locked_with_progress(
                            &id_for_task,
                            PendingOutcome::Error(retry_error),
                            progress_for_retry,
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
        self.handle_aria2_pending_event(gid, PendingAria2Outcome::new(outcome))
            .await;
    }

    pub async fn handle_aria2_event_with_progress(
        self: &Arc<Self>,
        gid: &str,
        outcome: PendingOutcome,
        progress: Option<DownloadStateProgress>,
    ) {
        self.handle_aria2_pending_event(
            gid,
            PendingAria2Outcome { outcome, progress },
        )
        .await;
    }

    async fn handle_aria2_pending_event(
        self: &Arc<Self>,
        gid: &str,
        pending: PendingAria2Outcome,
    ) {
        let PendingAria2Outcome { outcome, progress } = pending;
        if let PendingOutcome::Error(error) = outcome {
            self.handle_aria2_download_error(gid.to_string(), error, progress)
                .await;
            return;
        }
        let Some((mapping, pending)) = self
            .map_or_buffer_aria2_event(
                gid,
                PendingAria2Outcome { outcome, progress },
            )
            .await
        else {
            return;
        };
        let PendingAria2Outcome { outcome, progress } = pending;

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

        if matches!(&outcome, PendingOutcome::Complete) {
            match self
                .reconcile_aria2_magnet_parent_completion(&mapping.id, gid, &mapping)
                .await
            {
                Aria2MagnetCompletionDisposition::NotMetadataParent => {}
                Aria2MagnetCompletionDisposition::Deferred => {
                    // A metadata parent is not the user's payload. Keep the
                    // current permit and mapping alive until the next
                    // poll/reconnect observation exposes the child GID.
                    self.emit_state(&mapping.id, DownloadStatus::Downloading);
                    return;
                }
                Aria2MagnetCompletionDisposition::Failed(error) => {
                    self.apply_completion_locked_with_progress(
                        &mapping.id,
                        PendingOutcome::Error(error),
                        progress,
                    )
                    .await;
                    return;
                }
                Aria2MagnetCompletionDisposition::Adopted(child) => {
                    let id = mapping.id.clone();
                    drop(_control_guard);
                    // Parent-result cleanup is best effort and may consume
                    // several bounded RPC attempts. Do it after releasing
                    // the per-download control lock so a stale daemon result
                    // cannot block pause, resume, or removal of the adopted
                    // payload lifecycle.
                    self.remove_aria2_magnet_parent_result(gid).await;
                    if let Some(pending) = child.pending {
                        Box::pin(self.handle_aria2_pending_event(&child.gid, pending)).await;
                    } else {
                        match child.status.as_str() {
                            "complete" => {
                                Box::pin(self.handle_aria2_event(&child.gid, PendingOutcome::Complete))
                                    .await;
                            }
                            "error" | "removed" => {
                                Box::pin(self.handle_aria2_event(
                                    &child.gid,
                                    PendingOutcome::Error(child.error.unwrap_or_else(|| {
                                        "aria2 magnet payload child ended unexpectedly".to_string()
                                    })),
                                ))
                                .await;
                            }
                            "paused" => {
                                // The child may have been paused by Aria2
                                // while the metadata-parent event was in
                                // flight. Mirror the normal pause boundary so
                                // this handoff cannot strand a queue permit.
                                self.clear_aria2_allocation(&id).await;
                                self.next_aria2_control_epoch(&id).await;
                                self.cancel_aria2_retries(&id).await;
                                self.release_seed_tracking(&id);
                                self.release_permit(&id).await;
                                self.emit_state(&id, DownloadStatus::Paused);
                            }
                            "active" | "waiting" => {
                                self.emit_state(&id, DownloadStatus::Downloading)
                            }
                            _ => {}
                        }
                    }
                    return;
                }
            }
        }
        self.apply_completion_locked_with_progress(&mapping.id, outcome, progress)
            .await;
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
        let _admission_gate = self.admission_gate.lock().await;
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
        let _admission_gate = self.admission_gate.lock().await;
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
        let _admission_gate = self.admission_gate.lock().await;
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
        let _admission_gate = self.admission_gate.lock().await;
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

fn is_aria2_not_found_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("aria2 error code 3") || lower.contains("aria2 error code 4")
}

fn is_aria2_low_speed_error(error: &str) -> bool {
    error
        .to_ascii_lowercase()
        .contains("aria2 error code 5")
}

fn is_retryable_aria2_error_for_payload(payload: &SpawnPayload, error: &str) -> bool {
    is_retryable_aria2_error(error)
        || (!payload.is_torrent
            && payload.retry_not_found_errors
            && is_aria2_not_found_error(error))
        || (!payload.is_torrent
            && payload.minimum_normal_download_speed_kib > 0
            && is_aria2_low_speed_error(error))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Aria2RetryAction {
    OrdinaryRetry,
    Terminal,
}

fn aria2_retry_action(payload: &SpawnPayload, error: &str, strike: usize) -> Aria2RetryAction {
    if is_retryable_aria2_error_for_payload(payload, error)
        && strike < automatic_retry_limit(payload.max_tries)
    {
        Aria2RetryAction::OrdinaryRetry
    } else {
        Aria2RetryAction::Terminal
    }
}

fn is_aria2_rpc_unavailable(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    is_transient_network_error(error)
        || lower.contains("aria2 daemon is not ready")
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

impl BoundedRangeSupport {
    fn as_str(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::Unsupported => "unsupported",
            Self::Unknown => "unknown",
        }
    }
}

struct HttpTransferProbe {
    final_uri: String,
    range_support: BoundedRangeSupport,
    credentials_allowed: bool,
    redirect_count: usize,
}

struct PreparedNormalTransfer {
    uris: Vec<String>,
    requested_connections: i32,
    effective_connections: i32,
    credentials_allowed: bool,
}

fn payload_has_credential_material(payload: &SpawnPayload) -> bool {
    let inline_url_credentials = crate::collect_download_uris(&payload.url, payload.mirrors.as_deref())
        .into_iter()
        .any(|uri| {
            reqwest::Url::parse(&uri)
                .ok()
                .is_some_and(|parsed| !parsed.username().is_empty() || parsed.password().is_some())
        });
    if inline_url_credentials {
        return true;
    }

    if payload
        .username
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        || payload
            .password
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || payload
            .cookies
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    {
        return true;
    }

    payload
        .headers
        .as_deref()
        .into_iter()
        .flat_map(str::lines)
        .filter_map(|line| {
            line.split_once(':')
                .map(|(name, _)| name.trim().to_ascii_lowercase())
        })
        .any(|name| header_name_has_credential_material(&name))
}

pub(crate) fn header_name_has_credential_material(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    name.is_empty() || matches!(
        name.as_str(),
        "authorization"
            | "cookie"
            | "cookie2"
            | "proxy-authorization"
            | "set-cookie"
            | "set-cookie2"
            | "x-api-key"
            | "x-auth-token"
            | "x-access-token"
    ) || [
        "auth",
        "credential",
        "key",
        "password",
        "passwd",
        "secret",
        "session",
        "signature",
        "token",
    ]
    .iter()
    .any(|marker| name.contains(marker))
}

async fn prepare_normal_transfer(
    id: &str,
    epoch: u64,
    payload: &SpawnPayload,
) -> Result<PreparedNormalTransfer, String> {
    let credential_origin = reqwest::Url::parse(&payload.url)
        .map_err(|_| "normal download has an invalid primary URL".to_string())?;
    let requested =
        clamp_download_connections(payload.connections.unwrap_or(DOWNLOAD_CONNECTIONS_MIN));
    let mut connections = requested;
    let mut uris = Vec::new();
    let mut credentials_allowed = true;
    for (index, uri) in crate::collect_download_uris(&payload.url, payload.mirrors.as_deref())
        .into_iter()
        .enumerate()
    {
        if !is_http_uri(&uri) {
            let parsed =
                reqwest::Url::parse(&uri).map_err(|_| "SSRF blocked: Invalid URL".to_string())?;
            crate::network::validate_url(
                &parsed,
                &["http", "https", "ftp", "sftp"],
                crate::network::CredentialPolicy::Allow,
            )?;
            let uri_credentials_allowed = can_forward_payload_credentials(&credential_origin, &parsed);
            if index > 0
                && payload_has_credential_material(payload)
                && !uri_credentials_allowed
            {
                return Err(
                    "credentialed mirrors must use the same origin as the primary URL"
                        .to_string(),
                );
            }
            credentials_allowed &= uri_credentials_allowed;
            uris.push(uri);
            continue;
        }

        let probe_started = Instant::now();
        match probe_bounded_range_support(&uri, payload, &credential_origin).await {
            Ok(probe) => {
                if index > 0
                    && payload_has_credential_material(payload)
                    && !probe.credentials_allowed
                {
                    return Err(
                        "credentialed mirrors must use the same origin as the primary URL"
                            .to_string(),
                    );
                }
                credentials_allowed &= probe.credentials_allowed;
                uris.push(probe.final_uri);
                log::info!(
                    "aria2 range probe [stage=range_probe id={} epoch={} host={} support={} redirect_count={} credentials_allowed={} requested_connections={} effective_connections={} elapsed_ms={}]",
                    id,
                    epoch,
                    uri_host_for_log(&uri),
                    probe.range_support.as_str(),
                    probe.redirect_count,
                    probe.credentials_allowed,
                    requested,
                    if probe.range_support == BoundedRangeSupport::Unsupported && requested > 1 {
                        1
                    } else {
                        connections
                    },
                    probe_started.elapsed().as_millis()
                );
                match probe.range_support {
                    BoundedRangeSupport::Unsupported if requested > 1 => {
                        log::warn!(
                            "aria2 range probe [stage=range_probe id={} epoch={} host={} result=unsupported action=single_connection]",
                            id,
                            epoch,
                            uri_host_for_log(&uri)
                        );
                        connections = 1;
                    }
                    BoundedRangeSupport::Unknown if requested > 1 => {
                        log::debug!(
                            "aria2 range probe [stage=range_probe id={} epoch={} host={} result=unknown action=keep_requested connections={}]",
                            id,
                            epoch,
                            uri_host_for_log(&uri),
                            requested
                        );
                    }
                    _ => {}
                }
            }
            Err(error) if is_fatal_range_probe_error(&error) => {
                    log::error!(
                    "aria2 redirect [stage=redirect id={} epoch={} host={} result=rejected error_code={} requested_connections={} effective_connections={} elapsed_ms={}]",
                    id,
                    epoch,
                    uri_host_for_log(&uri),
                    range_probe_error_code(&error),
                    requested,
                    connections,
                    probe_started.elapsed().as_millis()
                );
                return Err(format!(
                    "normal transfer preflight rejected for {}: {}",
                    uri_host_for_log(&uri),
                    range_probe_error_code(&error)
                ));
            }
            Err(error) if payload_has_credential_material(payload) => {
                log::warn!(
                    "aria2 range probe [stage=range_probe id={} epoch={} host={} result=retryable error_code={} credentials_verified=false requested_connections={} effective_connections={} elapsed_ms={}]",
                    id,
                    epoch,
                    uri_host_for_log(&uri),
                    range_probe_error_code(&error),
                    requested,
                    connections,
                    probe_started.elapsed().as_millis()
                );
                return Err(format!(
                    "normal transfer preflight is retryable for {}: {}",
                    uri_host_for_log(&uri),
                    range_probe_error_code(&error)
                ));
            }
            Err(error) => {
                log::warn!(
                    "aria2 range probe [stage=range_probe id={} epoch={} host={} result=unknown action=use_source_uri error_code={} credentials_verified=false requested_connections={} effective_connections={} elapsed_ms={}]",
                    id,
                    epoch,
                    uri_host_for_log(&uri),
                    range_probe_error_code(&error),
                    requested,
                    connections,
                    probe_started.elapsed().as_millis()
                );
                uris.push(uri);
            }
        }
    }
    uris.dedup();
    if uris.is_empty() {
        return Err("normal download has no usable URI".to_string());
    }
    if payload_has_credential_material(payload) && !credentials_allowed {
        log::warn!(
            "aria2 redirect policy [{}]: stripping credentials after a cross-origin redirect",
            id
        );
    }
    Ok(PreparedNormalTransfer {
        uris,
        requested_connections: requested,
        effective_connections: connections,
        credentials_allowed,
    })
}

fn is_fatal_range_probe_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("private/local ip not allowed")
        || lower.contains("invalid url")
        || lower.contains("no host")
        || lower.contains("unsupported scheme")
        || lower.contains("invalid range probe redirect")
        || lower.contains("range probe redirect uses an unsupported scheme")
        || lower.contains("range probe redirect has no valid location")
        || lower.contains("range probe redirect limit exceeded")
        || lower.contains("range probe redirect loop exhausted")
}

fn range_probe_error_code(error: &str) -> &'static str {
    let lower = error.to_ascii_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        "timeout"
    } else if lower.contains("dns") || lower.contains("name resolution") {
        "dns"
    } else if lower.contains("private/local") {
        "ssrf_private_address"
    } else if lower.contains("redirect") {
        "redirect"
    } else if lower.contains("invalid") {
        "invalid_route"
    } else {
        match network_error_class(error) {
            "name_resolution" | "dns" => "dns",
            "ssrf_policy" => "ssrf_private_address",
            class => class,
        }
    }
}

fn transfer_preflight_error_code(error: &str) -> &'static str {
    if error
        .to_ascii_lowercase()
        .contains("credentialed mirrors must use the same origin")
    {
        "credential_policy"
    } else {
        range_probe_error_code(error)
    }
}

fn diagnostic_error_code(error: &str) -> String {
    aria2_error_code(error).unwrap_or_else(|| network_error_class(error).to_string())
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

pub(crate) fn aria2_all_proxy_value(proxy: &str) -> Result<Option<String>, String> {
    crate::network::NetworkRoute::from_proxy(Some(proxy)).aria2_proxy_value()
}

pub(crate) fn proxy_route_for_log(proxy: Option<&str>) -> &'static str {
    match proxy.map(str::trim) {
        None | Some("") => "none",
        Some(value) if value.eq_ignore_ascii_case("none") => "disabled",
        Some(_) => "configured",
    }
}

async fn probe_bounded_range_support(
    uri: &str,
    payload: &SpawnPayload,
    credential_origin: &reqwest::Url,
) -> Result<HttpTransferProbe, String> {
    probe_bounded_range_support_with_local_override(uri, payload, credential_origin, false).await
}

#[cfg(test)]
async fn probe_bounded_range_support_local_test(
    uri: &str,
    payload: &SpawnPayload,
    credential_origin: &reqwest::Url,
) -> Result<HttpTransferProbe, String> {
    probe_bounded_range_support_with_local_override(uri, payload, credential_origin, true).await
}

async fn probe_bounded_range_support_with_local_override(
    uri: &str,
    payload: &SpawnPayload,
    credential_origin: &reqwest::Url,
    allow_localhost: bool,
) -> Result<HttpTransferProbe, String> {
    crate::ensure_reqwest_crypto_provider();

    let mut current = reqwest::Url::parse(uri).map_err(|error| error.to_string())?;
    let mut credentials_allowed = can_forward_payload_credentials(credential_origin, &current);
    for redirect_count in 0..=5 {
        if !allow_localhost {
            crate::network::validate_url(
                &current,
                &["http", "https"],
                crate::network::CredentialPolicy::Allow,
            )?;
        }
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10));
        let route = if allow_localhost {
            crate::network::NetworkRoute::Direct
        } else {
            crate::network::NetworkRoute::from_proxy(payload.proxy.as_deref())
        };
        builder = route.configure_reqwest(builder)?;

        let client = builder.build().map_err(|error| error.to_string())?;
        let request = client
            .get(current.clone())
            .header(reqwest::header::RANGE, "bytes=0-0")
            .header(reqwest::header::ACCEPT_ENCODING, "identity");
        let response = apply_payload_headers(request, payload, credentials_allowed)
            .send()
            .await
            .map_err(|error| error.to_string())?;

        if response.status().is_redirection() {
            if redirect_count == 5 {
                return Err("range probe redirect limit exceeded".to_string());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "range probe redirect has no valid Location".to_string())?;
            let next = current
                .join(location)
                .map_err(|error| format!("invalid range probe redirect: {error}"))?;
            if !matches!(next.scheme(), "http" | "https") {
                return Err("range probe redirect uses an unsupported scheme".to_string());
            }
            let (next, next_credentials_allowed) = apply_redirect_credentials_policy(
                credential_origin,
                credentials_allowed,
                next,
            );
            credentials_allowed = next_credentials_allowed;
            current = next;
            continue;
        }

        let content_range = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok());
        return Ok(HttpTransferProbe {
            final_uri: current.to_string(),
            range_support: classify_bounded_range_response(response.status(), content_range),
            credentials_allowed,
            redirect_count,
        });
    }

    Err("range probe redirect loop exhausted".to_string())
}

fn can_forward_payload_credentials(original: &reqwest::Url, current: &reqwest::Url) -> bool {
    original.host() == current.host()
        && (original.port_or_known_default() == current.port_or_known_default()
            || (original.scheme() == "http"
                && current.scheme() == "https"
                && original.port_or_known_default() == Some(80)
                && current.port_or_known_default() == Some(443)))
        && (original.scheme() == current.scheme()
            || (original.scheme() == "http" && current.scheme() == "https"))
}

fn apply_redirect_credentials_policy(
    credential_origin: &reqwest::Url,
    credentials_already_allowed: bool,
    mut next: reqwest::Url,
) -> (reqwest::Url, bool) {
    let credentials_allowed = credentials_already_allowed
        && can_forward_payload_credentials(credential_origin, &next);
    if !credentials_allowed {
        let _ = next.set_username("");
        let _ = next.set_password(None);
    }
    (next, credentials_allowed)
}

fn apply_payload_headers(
    mut request: reqwest::RequestBuilder,
    payload: &SpawnPayload,
    include_credentials: bool,
) -> reqwest::RequestBuilder {
    if let Some(user_agent) = payload
        .user_agent
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        request = request.header(reqwest::header::USER_AGENT, user_agent);
    }
    if include_credentials {
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
    }
    request
}

fn apply_protocol_auth_options(
    options: &mut serde_json::Map<String, serde_json::Value>,
    payload: &SpawnPayload,
    uris: &[String],
) {
    let has_http = uris.iter().any(|uri| is_http_uri(uri));
    let has_ftp = uris.iter().any(|uri| {
        url::Url::parse(uri)
            .ok()
            .is_some_and(|parsed| matches!(parsed.scheme(), "ftp" | "sftp"))
    });
    let has_sftp = uris.iter().any(|uri| {
        url::Url::parse(uri)
            .ok()
            .is_some_and(|parsed| parsed.scheme() == "sftp")
    });
    if has_http {
        if let Some(user) = &payload.username {
            options.insert("http-user".to_string(), serde_json::json!(user));
        }
        if let Some(pass) = &payload.password {
            options.insert("http-passwd".to_string(), serde_json::json!(pass));
        }
    }
    if has_ftp {
        if let Some(user) = &payload.username {
            options.insert("ftp-user".to_string(), serde_json::json!(user));
        }
        if let Some(pass) = &payload.password {
            options.insert("ftp-passwd".to_string(), serde_json::json!(pass));
        }
    }
    if has_sftp {
        if let Some(fingerprint) = &payload.sftp_host_key_md {
            options.insert("ssh-host-key-md".to_string(), serde_json::json!(fingerprint));
        }
    }
}

fn apply_checksum_options(
    options: &mut serde_json::Map<String, serde_json::Value>,
    checksum: Option<&str>,
) {
    if let Some(chk) = checksum {
        let formatted_chk = if let Some((algo, digest)) = chk.split_once('=') {
            format!("{}={}", algo.to_ascii_lowercase(), digest)
        } else {
            chk.to_string()
        };
        options.insert("checksum".to_string(), serde_json::json!(formatted_chk));
        options.insert("check-integrity".to_string(), serde_json::json!("true"));
    }
}

struct Aria2NetworkPolicyError {
    host: String,
    message: String,
}

async fn validate_aria2_transfer_network_policy(
    uris: &[String],
) -> Result<(), Aria2NetworkPolicyError> {
    for uri in uris {
        let parsed = reqwest::Url::parse(uri).map_err(|_| Aria2NetworkPolicyError {
            host: uri_host_for_log(uri),
            message: "SSRF blocked: Invalid URL".to_string(),
        })?;
        if !matches!(parsed.scheme(), "http" | "https" | "ftp" | "sftp") {
            return Err(Aria2NetworkPolicyError {
                host: uri_host_for_log(uri),
                message: "Unsupported URL scheme".to_string(),
            });
        }
        // Keep this check immediately before addUri so every retry and every
        // mirror is fenced by the same literal-target policy. Hostname DNS
        // belongs to the selected consumer route and is intentionally not
        // performed here.
        if let Err(error) = crate::network::validate_url(
            &parsed,
            &["http", "https", "ftp", "sftp"],
            crate::network::CredentialPolicy::Allow,
        ) {
            return Err(Aria2NetworkPolicyError {
                host: uri_host_for_log(uri),
                message: error,
            });
        }
    }
    Ok(())
}

fn classify_bounded_range_response(
    status: reqwest::StatusCode,
    content_range: Option<&str>,
) -> BoundedRangeSupport {
    // A 416 for the deliberately tiny `bytes=0-0` request is the one
    // response we can classify as an explicit range rejection. Successful
    // 200 responses and larger 206 responses remain ambiguous because
    // servers and proxies commonly normalize or expand bounded requests.
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        return BoundedRangeSupport::Unsupported;
    }
    if status == reqwest::StatusCode::PARTIAL_CONTENT {
        return match content_range.and_then(parse_content_range_bounds) {
            Some((0, 0)) => BoundedRangeSupport::Supported,
            Some((0, _)) => BoundedRangeSupport::Unknown,
            Some(_) => BoundedRangeSupport::Unknown,
            None => BoundedRangeSupport::Unknown,
        };
    }

    if status.is_success() {
        BoundedRangeSupport::Unknown
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
pub(crate) const MAX_TORRENT_TRACKERS: usize = 64;
pub(crate) const MAX_TORRENT_TRACKER_BYTES: usize = 16 * 1024;

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

fn aria2_add_uri_params(
    transfer_uris: Vec<String>,
    options: serde_json::Map<String, serde_json::Value>,
) -> serde_json::Value {
    serde_json::json!([transfer_uris, options])
}

fn apply_aria2_normal_reliability_options(
    options: &mut serde_json::Map<String, serde_json::Value>,
    payload: &SpawnPayload,
    uri_count: usize,
) -> Result<(), String> {
    if payload.is_torrent {
        return Ok(());
    }
    let minimum_speed =
        normalize_minimum_normal_download_speed_kib(payload.minimum_normal_download_speed_kib)?;
    if minimum_speed > 0 {
        options.insert(
            "lowest-speed-limit".to_string(),
            serde_json::json!(format!("{minimum_speed}K")),
        );
    }
    if payload.adaptive_mirror_selection && uri_count > 1 {
        options.insert(
            "uri-selector".to_string(),
            serde_json::json!("adaptive"),
        );
    }
    Ok(())
}

fn should_apply_aria2_connection_options(payload: &SpawnPayload) -> bool {
    !payload.is_torrent
}

fn apply_aria2_follow_options(
    options: &mut serde_json::Map<String, serde_json::Value>,
    payload: &SpawnPayload,
) {
    if !payload.is_torrent {
        // A generic addUri can point at a .torrent or Metalink file. Aria2
        // may then create a second, followed child GID, but Firelink
        // currently owns exactly one GID per download. Keep that unmanaged
        // child lifecycle impossible until parent/child ownership is modeled
        // end to end.
        options.insert(
            "follow-torrent".to_string(),
            serde_json::json!("false"),
        );
        options.insert(
            "follow-metalink".to_string(),
            serde_json::json!("false"),
        );
    }
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

fn aria2_peer_ip(value: Option<&serde_json::Value>) -> Option<String> {
    let value = value?.as_str()?.trim();
    if value.is_empty() || value.len() > 64 || value.chars().any(char::is_control) {
        return None;
    }
    value.parse::<std::net::IpAddr>().ok().map(|ip| ip.to_string())
}

fn aria2_peer_port(value: Option<&serde_json::Value>) -> Option<u16> {
    match value {
        Some(serde_json::Value::String(value)) => value.parse().ok(),
        Some(serde_json::Value::Number(value)) => value.as_u64()?.try_into().ok(),
        _ => None,
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

fn parse_torrent_availability_decimal(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<u64, String> {
    let value = object
        .get(field)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("aria2.tellStatus returned an invalid {field}"))?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("aria2.tellStatus returned an invalid {field}"));
    }
    value
        .parse::<u64>()
        .map_err(|_| format!("aria2.tellStatus returned an invalid {field}"))
}

fn decode_torrent_availability_bitfield(
    value: &str,
    piece_count: u64,
) -> Result<Vec<u8>, String> {
    if piece_count == 0 || piece_count > MAX_TORRENT_PIECES_FOR_PROGRESS {
        return Err("Torrent availability has an unsupported piece count".to_string());
    }
    let byte_count = piece_count
        .checked_add(7)
        .and_then(|value| value.checked_div(8))
        .ok_or_else(|| "Torrent availability bitfield is oversized".to_string())?;
    let expected_hex_length = byte_count
        .checked_mul(2)
        .ok_or_else(|| "Torrent availability bitfield is oversized".to_string())?;
    if value.len() != usize::try_from(expected_hex_length).unwrap_or(usize::MAX)
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Torrent availability bitfield is malformed".to_string());
    }
    let mut bytes = Vec::with_capacity(byte_count as usize);
    for pair in value.as_bytes().chunks_exact(2) {
        let high = char::from(pair[0])
            .to_digit(16)
            .ok_or_else(|| "Torrent availability bitfield is malformed".to_string())?;
        let low = char::from(pair[1])
            .to_digit(16)
            .ok_or_else(|| "Torrent availability bitfield is malformed".to_string())?;
        bytes.push(((high << 4) | low) as u8);
    }
    if piece_count % 8 != 0 {
        let overflow_mask = (1u8 << (8 - piece_count as u8 % 8)) - 1;
        if bytes.last().is_some_and(|byte| byte & overflow_mask != 0) {
            return Err("Torrent availability bitfield has overflow bits".to_string());
        }
    }
    Ok(bytes)
}

fn torrent_availability_piece_is_set(bitfield: &[u8], index: usize) -> bool {
    bitfield[index / 8] & (1 << (7 - index % 8)) != 0
}

pub(crate) fn parse_torrent_availability(
    status: serde_json::Value,
    peers: serde_json::Value,
) -> Result<crate::ipc::TorrentAvailabilitySnapshot, String> {
    let status = status
        .as_object()
        .ok_or_else(|| "aria2.tellStatus returned malformed Torrent availability".to_string())?;
    let piece_count = parse_torrent_availability_decimal(status, "numPieces")?;
    let local_bitfield = status
        .get("bitfield")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "aria2.tellStatus has no Torrent availability bitfield yet".to_string())?;
    let local_bitfield = decode_torrent_availability_bitfield(local_bitfield, piece_count)?;
    let peers = peers
        .as_array()
        .ok_or_else(|| "aria2.getPeers returned a non-array result".to_string())?;
    if peers.len() > MAX_TORRENT_AVAILABILITY_PEERS {
        return Err("aria2.getPeers returned too many peers for availability".to_string());
    }
    let mut copies = vec![0u16; piece_count as usize];
    for index in 0..piece_count as usize {
        if torrent_availability_piece_is_set(&local_bitfield, index) {
            copies[index] = 1;
        }
    }
    for peer in peers {
        let Some(peer) = peer.as_object() else {
            // Peer projections are network-derived and may be incomplete
            // while Aria2 refreshes its peer table. Preserve the connected
            // count but omit an unusable contribution rather than failing
            // availability for the whole swarm.
            continue;
        };
        let Some(bitfield_value) = peer.get("bitfield") else {
            // Aria2 can report a connected peer before the handshake has
            // supplied its piece bitfield. Keep that peer in the connected
            // count, but do not let it make the whole availability snapshot
            // unavailable. A present, non-string bitfield remains malformed.
            continue;
        };
        let Some(bitfield) = bitfield_value.as_str() else {
            continue;
        };
        let Ok(bitfield) = decode_torrent_availability_bitfield(bitfield, piece_count) else {
            continue;
        };
        for index in 0..piece_count as usize {
            if torrent_availability_piece_is_set(&bitfield, index) {
                copies[index] = copies[index].saturating_add(1);
            }
        }
    }

    let minimum = copies.iter().copied().min().unwrap_or(0);
    let above_minimum = copies.iter().filter(|count| **count > minimum).count();
    let availability = minimum as f64 + above_minimum as f64 / piece_count as f64;
    let bucket_count = piece_count.min(256) as usize;
    let mut buckets = Vec::with_capacity(bucket_count);
    for bucket_index in 0..bucket_count {
        let start = piece_count * bucket_index as u64 / bucket_count as u64;
        let end = piece_count * (bucket_index as u64 + 1) / bucket_count as u64;
        let minimum_copies = copies[start as usize..end as usize]
            .iter()
            .copied()
            .min()
            .unwrap_or(0);
        buckets.push(crate::ipc::TorrentAvailabilityBucket { minimum_copies });
    }
    Ok(crate::ipc::TorrentAvailabilitySnapshot {
        piece_count,
        availability,
        connected_peers: peers.len().try_into().unwrap_or(u32::MAX),
        buckets,
    })
}

struct TorrentPeerCounts {
    listed_peers: u32,
    listed_seeders: u32,
}

fn torrent_peer_counts_from_array(
    peers: &[serde_json::Value],
) -> Result<TorrentPeerCounts, String> {
    if peers.len() > MAX_TORRENT_PEER_RESPONSE {
        return Err("aria2.getPeers returned too many peers".to_string());
    }
    if peers.iter().any(|peer| !peer.is_object()) {
        return Err("aria2.getPeers returned malformed peer data".to_string());
    }
    let mut total_seeders = 0u32;
    for peer in peers {
        let peer = peer
            .as_object()
            .ok_or_else(|| "aria2.getPeers returned malformed peer data".to_string())?;
        if aria2_peer_bool(peer.get("seeder")) {
            total_seeders = total_seeders.saturating_add(1);
        }
    }
    Ok(TorrentPeerCounts {
        listed_peers: u32::try_from(peers.len()).unwrap_or(u32::MAX),
        listed_seeders: total_seeders,
    })
}

pub(crate) fn parse_torrent_peer_diagnostics(
    result: serde_json::Value,
) -> Result<crate::ipc::TorrentPeerDiagnostics, String> {
    let peers = result
        .as_array()
        .ok_or_else(|| "aria2.getPeers returned a non-array result".to_string())?;
    let summary = torrent_peer_counts_from_array(peers)?;
    let mut sanitized = Vec::with_capacity(peers.len().min(MAX_TORRENT_PEER_DIAGNOSTICS));

    for peer in peers.iter().take(MAX_TORRENT_PEER_DIAGNOSTICS) {
        let peer = peer
            .as_object()
            .ok_or_else(|| "aria2.getPeers returned malformed peer data".to_string())?;
        let seeder = aria2_peer_bool(peer.get("seeder"));
        sanitized.push(crate::ipc::TorrentPeer {
            ip: aria2_peer_ip(peer.get("ip")),
            port: aria2_peer_port(peer.get("port")),
            download_speed: aria2_peer_number(peer.get("downloadSpeed")),
            upload_speed: aria2_peer_number(peer.get("uploadSpeed")),
            seeder,
            am_choking: aria2_peer_bool(peer.get("amChoking")),
            peer_choking: aria2_peer_bool(peer.get("peerChoking")),
        });
    }

    Ok(crate::ipc::TorrentPeerDiagnostics {
        listed_peers: summary.listed_peers,
        listed_seeders: summary.listed_seeders,
        peers: sanitized,
        truncated: peers.len() > MAX_TORRENT_PEER_DIAGNOSTICS,
    })
}

fn parse_aria2_decimal(value: Option<&serde_json::Value>, field: &str) -> Result<u64, String> {
    let value = value
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("aria2.getFiles returned an invalid {field}"))?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("aria2.getFiles returned an invalid {field}"));
    }
    value
        .parse::<u64>()
        .map_err(|_| format!("aria2.getFiles returned an invalid {field}"))
}

fn parse_aria2_selected(value: Option<&serde_json::Value>) -> Result<bool, String> {
    match value {
        Some(serde_json::Value::String(value)) if value == "true" => Ok(true),
        Some(serde_json::Value::String(value)) if value == "false" => Ok(false),
        Some(serde_json::Value::Bool(value)) => Ok(*value),
        _ => Err("aria2.getFiles returned an invalid selected flag".to_string()),
    }
}

pub(crate) fn parse_torrent_file_progress(
    result: serde_json::Value,
    metadata_files: &[crate::ipc::TorrentFile],
) -> Result<crate::ipc::TorrentFileProgressSnapshot, String> {
    let files = result
        .as_array()
        .ok_or_else(|| "aria2.getFiles returned a non-array result".to_string())?;
    if files.len() != metadata_files.len() {
        return Err("aria2.getFiles returned an unexpected file count".to_string());
    }

    let mut parsed = HashMap::<u32, crate::ipc::TorrentFileProgress>::with_capacity(files.len());
    for file in files {
        let object = file
            .as_object()
            .ok_or_else(|| "aria2.getFiles returned malformed file data".to_string())?;
        let index = parse_aria2_decimal(object.get("index"), "file index")?
            .try_into()
            .map_err(|_| "aria2.getFiles returned an invalid file index".to_string())?;
        let metadata = metadata_files
            .iter()
            .find(|metadata| metadata.index == index)
            .ok_or_else(|| "aria2.getFiles returned an unknown file index".to_string())?;
        if parsed.contains_key(&index) {
            return Err("aria2.getFiles returned a duplicate file index".to_string());
        }
        let length = parse_aria2_decimal(object.get("length"), "file length")?;
        if length != metadata.length {
            return Err("aria2.getFiles returned a mismatched file length".to_string());
        }
        let completed_length = parse_aria2_decimal(
            object.get("completedLength"),
            "completed file length",
        )?;
        if completed_length > length {
            return Err("aria2.getFiles returned over-complete file data".to_string());
        }
        parsed.insert(
            index,
            crate::ipc::TorrentFileProgress {
                index,
                relative_path: metadata.path.clone(),
                length,
                completed_length,
                selected: parse_aria2_selected(object.get("selected"))?,
            },
        );
    }

    let files = metadata_files
        .iter()
        .map(|metadata| {
            parsed
                .remove(&metadata.index)
                .ok_or_else(|| "aria2.getFiles returned a missing file index".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if !parsed.is_empty() {
        return Err("aria2.getFiles returned unexpected file data".to_string());
    }
    Ok(crate::ipc::TorrentFileProgressSnapshot { files })
}

fn parse_aria2_status_decimal(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<u64, String> {
    let value = object
        .get(field)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("aria2.tellStatus returned an invalid {field}"))?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("aria2.tellStatus returned an invalid {field}"));
    }
    value
        .parse::<u64>()
        .map_err(|_| format!("aria2.tellStatus returned an invalid {field}"))
}

fn decode_torrent_piece_bitfield(
    value: &str,
    num_pieces: u64,
) -> Result<Vec<u8>, String> {
    if num_pieces == 0 {
        return Err("aria2.tellStatus returned a non-positive piece count".to_string());
    }
    if num_pieces > MAX_TORRENT_PIECES_FOR_PROGRESS {
        return Err("aria2.tellStatus returned an unsupported piece count".to_string());
    }
    let byte_count = num_pieces
        .checked_add(7)
        .and_then(|value| value.checked_div(8))
        .ok_or_else(|| "aria2.tellStatus returned an unsupported piece count".to_string())?;
    let hex_length = byte_count
        .checked_mul(2)
        .ok_or_else(|| "aria2.tellStatus returned an oversized bitfield".to_string())?;
    if value.len() != usize::try_from(hex_length).unwrap_or(usize::MAX)
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("aria2.tellStatus returned an invalid piece bitfield".to_string());
    }

    let mut bytes = Vec::with_capacity(usize::try_from(byte_count).unwrap_or_default());
    for pair in value.as_bytes().chunks_exact(2) {
        let high = char::from(pair[0]).to_digit(16).ok_or_else(|| {
            "aria2.tellStatus returned an invalid piece bitfield".to_string()
        })?;
        let low = char::from(pair[1]).to_digit(16).ok_or_else(|| {
            "aria2.tellStatus returned an invalid piece bitfield".to_string()
        })?;
        bytes.push(((high << 4) | low) as u8);
    }

    let remainder = (num_pieces % 8) as u8;
    if remainder != 0 {
        let overflow_mask = (1u8 << (8 - remainder)) - 1;
        if bytes.last().is_some_and(|byte| byte & overflow_mask != 0) {
            return Err("aria2.tellStatus returned set overflow bits".to_string());
        }
    }
    Ok(bytes)
}

fn torrent_piece_is_complete(bitfield: &[u8], index: u64) -> bool {
    let byte = bitfield[(index / 8) as usize];
    byte & (1 << (7 - (index % 8))) != 0
}

pub(crate) fn parse_torrent_piece_progress(
    result: serde_json::Value,
) -> Result<crate::ipc::TorrentPieceProgressSnapshot, String> {
    let object = result
        .as_object()
        .ok_or_else(|| "aria2.tellStatus returned malformed piece progress".to_string())?;
    let piece_length = parse_aria2_status_decimal(object, "pieceLength")?;
    let num_pieces = parse_aria2_status_decimal(object, "numPieces")?;
    if piece_length == 0 {
        return Err("aria2.tellStatus returned a non-positive piece length".to_string());
    }
    let bitfield = object
        .get("bitfield")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "aria2.tellStatus has no piece bitfield yet".to_string())?;
    let bitfield = decode_torrent_piece_bitfield(bitfield, num_pieces)?;
    let completed_pieces = (0..num_pieces)
        .filter(|index| torrent_piece_is_complete(&bitfield, *index))
        .count() as u64;

    let bucket_count = num_pieces.min(256) as usize;
    let mut buckets = Vec::with_capacity(bucket_count);
    for bucket_index in 0..bucket_count {
        let start = num_pieces * bucket_index as u64 / bucket_count as u64;
        let end = num_pieces * (bucket_index as u64 + 1) / bucket_count as u64;
        let bucket_length = end.saturating_sub(start);
        let completed = (start..end)
            .filter(|index| torrent_piece_is_complete(&bitfield, *index))
            .count() as u64;
        let percentage = if bucket_length == 0 {
            0
        } else {
            ((completed * 100) / bucket_length).min(100) as u8
        };
        buckets.push(percentage);
    }

    Ok(crate::ipc::TorrentPieceProgressSnapshot {
        piece_length,
        num_pieces,
        completed_pieces,
        buckets,
    })
}

pub(crate) fn normalize_torrent_tracker_uri(value: &str) -> Result<String, String> {
    let token = value.trim();
    if token.is_empty() {
        return Err("torrent tracker URI is empty".to_string());
    }
    if token.chars().any(char::is_control) {
        return Err("torrent tracker URI contains a control character".to_string());
    }
    let parsed = reqwest::Url::parse(token).map_err(|_| "torrent tracker URI is invalid".to_string())?;
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
    crate::network::validate_url(
        &parsed,
        &["http", "https", "udp"],
        crate::network::CredentialPolicy::Allow,
    )?;
    Ok(parsed.to_string())
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
            let normalized = normalize_torrent_tracker_uri(token)?;
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

pub(crate) fn validate_torrent_tracker_destinations(trackers: &[String]) -> Result<(), String> {
    for tracker in trackers {
        normalize_torrent_tracker_uri(tracker)?;
    }
    Ok(())
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

    if payload.torrent_verify_only {
        options.insert("check-integrity".to_string(), serde_json::json!("true"));
        options.insert("hash-check-only".to_string(), serde_json::json!("true"));
        options.insert("seed-time".to_string(), serde_json::json!("0"));
        options.insert("seed-ratio".to_string(), serde_json::json!("0"));
        options.insert("bt-hash-check-seed".to_string(), serde_json::json!("false"));
        options.insert("bt-seed-unverified".to_string(), serde_json::json!("false"));
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
    // Keep metadata probing and generic .torrent following out of the normal
    // transfer policy. A direct magnet still has an Aria2 metadata parent;
    // QueueManager adopts its validated payload child explicitly.
    options.insert("bt-metadata-only".to_string(), serde_json::json!("false"));
    options.insert("bt-save-metadata".to_string(), serde_json::json!("false"));
    options.insert("follow-torrent".to_string(), serde_json::json!("false"));
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
    let allocation = normalize_torrent_file_allocation(payload.torrent_file_allocation.as_deref())?;
    options.insert("file-allocation".to_string(), serde_json::json!(allocation));
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

fn apply_aria2_header_options(
    options: &mut serde_json::Map<String, serde_json::Value>,
    payload: &SpawnPayload,
    credentials_allowed: bool,
) {
    if !credentials_allowed {
        return;
    }
    let mut header_list = Vec::new();
    if let Some(cookies) = &payload.cookies {
        header_list.push(format!("Cookie: {cookies}"));
    }
    if let Some(headers) = &payload.headers {
        for line in headers.lines() {
            if !line.trim().is_empty() {
                header_list.push(line.trim().to_string());
            }
        }
    }
    if !header_list.is_empty() {
        options.insert("header".to_string(), serde_json::json!(header_list));
    }
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

    async fn control_seed_rpc(
        &self,
        gid: &str,
        method: &str,
    ) -> Result<Aria2SeedControlOutcome, String> {
        let state = self.app_handle.state::<crate::AppState>();
        let port = state.aria2_port.load(std::sync::atomic::Ordering::Relaxed);
        let secret = &state.aria2_secret;
        let rpc_error = match crate::rpc_call(port, secret, method, serde_json::json!([gid])).await {
            Ok(result) => crate::ensure_aria2_gid_result(method, gid, &result)
                .err()
                .map(|error| error.to_string()),
            Err(error) => Some(crate::redact_sensitive_text(&error.to_string())),
        };
        let status = crate::aria2_download_status(port, secret, gid)
            .await
            .map_err(|error| {
                rpc_error
                    .as_ref()
                    .map(|rpc_error| format!("{rpc_error}; status verification failed: {error}"))
                    .unwrap_or_else(|| format!("status verification failed: {error}"))
            })?;
        let outcome = match status.as_str() {
            "active" | "waiting" => Aria2SeedControlOutcome::Resumed,
            "paused" => Aria2SeedControlOutcome::Paused,
            "complete" => Aria2SeedControlOutcome::Complete,
            other => {
                return Err(format!(
                    "aria2 {method} left gid {gid} in unhandled state {other}"
                ));
            }
        };
        if let Some(error) = rpc_error {
            log::warn!(
                "aria2 {method} for seed gid {} returned an error after status verification: {}",
                gid,
                error
            );
        }
        Ok(outcome)
    }
}

#[async_trait::async_trait]
impl SidecarSpawner for ProductionSpawner {
    async fn add_uri(&self, id: &str, payload: &SpawnPayload) -> Result<String, String> {
        let state = self.app_handle.state::<crate::AppState>();
        let attempt_epoch = state.queue_manager.current_aria2_control_epoch(id).await;
        let admission_started = Instant::now();
        let mut options = serde_json::Map::new();
        crate::network::apply_aria2_route_contract(&mut options);
        let mut connection_options = None;
        let resolved_dest = crate::resolve_path(&payload.destination, &self.app_handle);
        if !crate::is_safe_path(&resolved_dest, &self.app_handle) {
            return Err("Path traversal blocked".to_string());
        }
        if payload.is_torrent {
            crate::torrent::validate_output_name(&payload.filename)?;
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
        let (transfer_uris, requested_connections, transfer_connections, credentials_allowed) =
            if payload.is_torrent {
                // Torrent metadata acquisition credentials are never transfer
                // credentials. Torrent trackers and web seeds use their own
                // validated URI/options paths below.
                (Vec::new(), DOWNLOAD_CONNECTIONS_MIN, DOWNLOAD_CONNECTIONS_MIN, false)
            } else {
                let requested_uris =
                    crate::collect_download_uris(&payload.url, payload.mirrors.as_deref());
                let requested_connections =
                    clamp_download_connections(payload.connections.unwrap_or(DOWNLOAD_CONNECTIONS_MIN));
                if let Err(error) = validate_aria2_transfer_network_policy(&requested_uris).await {
                    log::error!(
                        "aria2 admission [stage=network_policy id={} epoch={} host={} proxy_route={} uri_count={} requested_connections={} effective_connections=not_established error_class={} error_code={} elapsed_ms={}]",
                        id,
                        attempt_epoch,
                        error.host,
                        proxy_route_for_log(payload.proxy.as_deref()),
                        requested_uris.len(),
                        requested_connections,
                        network_error_class(&error.message),
                        transfer_preflight_error_code(&error.message),
                        admission_started.elapsed().as_millis()
                    );
                    return Err(error.message);
                }
                let prepared = match prepare_normal_transfer(id, attempt_epoch, payload).await {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        log::error!(
                            "aria2 admission [stage=transfer_preflight id={} epoch={} host={} proxy_route={} requested_connections={} effective_connections=not_established error_class={} error_code={} elapsed_ms={}]",
                            id,
                            attempt_epoch,
                            requested_uris
                                .first()
                                .map(|uri| uri_host_for_log(uri))
                                .unwrap_or_else(|| "<unknown host>".to_string()),
                            proxy_route_for_log(payload.proxy.as_deref()),
                            requested_connections,
                            network_error_class(&error),
                            transfer_preflight_error_code(&error),
                            admission_started.elapsed().as_millis()
                        );
                        return Err(error);
                    }
                };
                connection_options = Some(prepared.effective_connections);
                (
                    prepared.uris,
                    prepared.requested_connections,
                    prepared.effective_connections,
                    prepared.credentials_allowed,
                )
            };
        if should_apply_aria2_connection_options(payload) {
            apply_aria2_connection_options(&mut options, transfer_connections);
        }
        apply_aria2_normal_reliability_options(&mut options, payload, transfer_uris.len())?;
        apply_aria2_follow_options(&mut options, payload);
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
            .and_then(normalize_download_speed_limit)
        {
            options.insert("max-download-limit".to_string(), serde_json::json!(speed));
        }
        if !payload.is_torrent {
            if credentials_allowed {
                apply_protocol_auth_options(&mut options, payload, &transfer_uris);
            }
            apply_checksum_options(&mut options, payload.checksum.as_deref());
        }
        if let Some(ua) = &payload.user_agent {
            options.insert("user-agent".to_string(), serde_json::json!(ua));
        }
        apply_aria2_header_options(&mut options, payload, credentials_allowed);
        if let Some(prox) = proxy_value {
            options.insert("all-proxy".to_string(), serde_json::json!(prox));
        }
        let retry_strike = state.queue_manager.aria2_retry_strike(id).await;
        let transfer_host = transfer_uris
            .first()
            .map(|uri| uri_host_for_log(uri))
            .unwrap_or_else(|| "<torrent>".to_string());

        log::info!(
            "aria2 admission [stage=admission id={} epoch={} retry_strike={} host={} requested_connections={} effective_connections={} uri_count={} resolver_mode={} proxy_route={} elapsed_ms={}]",
            id,
            attempt_epoch,
            retry_strike,
            transfer_host,
            requested_connections,
            transfer_connections,
            transfer_uris.len(),
            aria2_resolver_route_for_log(payload),
            proxy_route_for_log(payload.proxy.as_deref()),
            admission_started.elapsed().as_millis()
        );

        let (method, params) = if payload.is_torrent {
            if let Some(path) = payload.torrent_path.as_deref() {
                let path = crate::torrent::validate_managed_torrent_path(
                    &self.app_handle,
                    id,
                    path,
                )?;
                let bytes = crate::torrent::read_bounded_torrent_bytes(&path)
                    .await
                    .map_err(|error| format!("could not read cached torrent metadata: {error}"))?;
                let (sanitized_bytes, embedded_web_seeds) =
                    crate::torrent::sanitize_torrent_bytes_for_aria2(&bytes)?;
                let embedded_web_seeds =
                    crate::filter_torrent_web_seed_destinations(&embedded_web_seeds).await?;
                let torrent_details = crate::torrent::torrent_details_from_bytes(&sanitized_bytes)?;
                validate_torrent_tracker_destinations(&torrent_details.trackers)?;
                let metadata = crate::torrent::parse_torrent_bytes(&sanitized_bytes)?;
                options.insert(
                    "index-out".to_string(),
                    serde_json::json!(crate::torrent::aria2_index_outputs(&metadata, &payload.filename)),
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
                let encoded = base64::engine::general_purpose::STANDARD.encode(sanitized_bytes);
                let fallback_web_seeds =
                    normalize_torrent_mirror_uris(payload.mirrors.as_deref())?;
                crate::validate_torrent_web_seed_destinations(&fallback_web_seeds).await?;
                let mut uris = embedded_web_seeds;
                uris.extend(fallback_web_seeds);
                uris.sort();
                uris.dedup();
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
                let magnet = crate::torrent::sanitize_magnet_uri_for_aria2(&payload.url)?;
                ("aria2.addUri", serde_json::json!([[magnet], options]))
            }
        } else {
            (
                "aria2.addUri",
                aria2_add_uri_params(transfer_uris, options),
            )
        };

        let lifecycle_current = state
            .queue_manager
            .is_aria2_control_epoch_current(id, attempt_epoch)
            .await
            && state.queue_manager.is_registered(id).await;
        if !lifecycle_current {
            log::info!(
                "aria2 admission [stage=admission id={} epoch={} retry_strike={} host={} requested_connections={} effective_connections={} result=stale_before_rpc elapsed_ms={}]",
                id,
                attempt_epoch,
                retry_strike,
                transfer_host,
                requested_connections,
                transfer_connections,
                admission_started.elapsed().as_millis()
            );
            return Err("aria2 admission canceled before RPC".to_string());
        }

        match self.add_transfer_rpc(&state, method, &params).await {
            Ok(result) => {
                let gid = result.as_str().unwrap_or("").to_string();
                if gid.is_empty() {
                    Err(format!("{method} returned an empty gid"))
                } else {
                    if let Some(effective) = connection_options {
                        state
                            .queue_manager
                            .set_aria2_connection_options(
                                id,
                                attempt_epoch,
                                effective,
                            )
                            .await;
                    }
                    log::info!(
                        "aria2 {} [stage=admission id={} gid={} epoch={} retry_strike={} elapsed_ms={} result=created]",
                        method,
                        id,
                        gid,
                        attempt_epoch,
                        retry_strike,
                        admission_started.elapsed().as_millis()
                    );
                    Ok(gid)
                }
            }
            Err(e) => {
                let error_code = aria2_error_code(&e)
                    .unwrap_or_else(|| network_error_class(&e).to_string());
                log::error!(
                    "aria2 admission [stage=admission id={} epoch={} method={} error_class={} error_code={} elapsed_ms={}]",
                    id,
                    attempt_epoch,
                    method,
                    network_error_class(&e),
                    error_code,
                    admission_started.elapsed().as_millis()
                );
                let safe_error = crate::redact_sensitive_text(&e);
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

    async fn pause_for_seed(
        &self,
        gid: &str,
    ) -> Result<Aria2SeedControlOutcome, String> {
        self.control_seed_rpc(gid, "aria2.forcePause").await
    }

    async fn resume_for_seed(
        &self,
        gid: &str,
    ) -> Result<Aria2SeedControlOutcome, String> {
        self.control_seed_rpc(gid, "aria2.unpause").await
    }

    async fn get_torrent_file_uris(&self, gid: &str) -> Result<Vec<(u32, Vec<String>)>, String> {
        let state = self.app_handle.state::<crate::AppState>();
        let result = crate::rpc_call(
            state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
            &state.aria2_secret,
            "aria2.getFiles",
            serde_json::json!([gid]),
        )
        .await
        .map_err(|error| format!("aria2.getFiles failed for gid {gid}: {}", crate::redact_sensitive_text(&error.to_string())))?;
        parse_aria2_torrent_file_uris(&result)
    }

    async fn change_torrent_uris(
        &self,
        gid: &str,
        file_index: u32,
        delete: &[String],
        add: &[String],
    ) -> Result<(), String> {
        let state = self.app_handle.state::<crate::AppState>();
        let result = crate::rpc_call(
            state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
            &state.aria2_secret,
            "aria2.changeUri",
            serde_json::json!([gid, file_index, delete, add]),
        )
        .await
        .map_err(|error| format!("aria2.changeUri failed for gid {gid}: {}", crate::redact_sensitive_text(&error.to_string())))?;
        match result.as_str() {
            Some("OK") => Ok(()),
            Some(value) => Err(format!("aria2.changeUri returned unexpected result {value}")),
            None => Err("aria2.changeUri returned a non-string result".to_string()),
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
                                    "aria2 connection recovery [stage=recovery id={} gid={} operation=force_pause result=verified_paused error_class={} error_code={}]",
                                    id,
                                    gid,
                                    network_error_class(&error),
                                    diagnostic_error_code(&error)
                                );
                            }
                            Ok(status) if status == "complete" => {
                                return Ok(Aria2RecreateOutcome::Complete);
                            }
                            Ok(status)
                                if aria2_recovery_should_rebuild_after_pause_error(&status) =>
                            {
                                log::warn!(
                                    "aria2 connection recovery [stage=recovery id={} gid={} operation=force_pause result=gid_missing_rebuild error_class={} error_code={}]",
                                    id,
                                    gid,
                                    network_error_class(&error),
                                    diagnostic_error_code(&error)
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

#[derive(Debug, Clone, Default, Deserialize, TS)]
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
    #[serde(default)]
    #[ts(optional)]
    pub sftp_host_key_md: Option<String>,
    pub headers: Option<String>,
    pub checksum: Option<String>,
    pub cookies: Option<String>,
    pub mirrors: Option<String>,
    pub user_agent: Option<String>,
    pub max_tries: Option<i32>,
    #[serde(default)]
    #[ts(optional)]
    pub minimum_normal_download_speed_kib: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub retry_not_found_errors: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub adaptive_mirror_selection: Option<bool>,
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
    pub torrent_seed_remaining: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_web_seeds: Option<Vec<crate::ipc::TorrentWebSeed>>,
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
    pub torrent_file_allocation: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_verify_only: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub torrent_verify_restore_status: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub lifecycle_generation: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub replace_existing_fingerprint: Option<String>,
}

impl EnqueueItem {
    pub fn strip_torrent_credentials(&mut self) {
        if self.is_torrent.unwrap_or(false) {
            self.username = None;
            self.password = None;
            self.headers = None;
            self.cookies = None;
        }
    }

    pub fn into_task(self) -> QueuedTask {
        let mut item = self;
        item.strip_torrent_credentials();
        let media = item.is_media.unwrap_or(false);
        let kind = if media {
            TaskKind::Media
        } else {
            TaskKind::Aria2
        };
        let id = item.id.clone();
        QueuedTask {
            id,
            queue_id: item.queue_id,
            kind,
            lifecycle_generation: item
                .lifecycle_generation
                .as_deref()
                .and_then(|generation| generation.parse().ok())
                .unwrap_or_default(),
            payload: SpawnPayload {
                url: item.url,
                destination: item.destination,
                filename: item.filename,
                connections: item.connections,
                speed_limit: item.speed_limit,
                username: item.username,
                password: item.password,
                sftp_host_key_md: item.sftp_host_key_md,
                headers: item.headers,
                checksum: item.checksum,
                cookies: item.cookies,
                mirrors: item.mirrors,
                user_agent: item.user_agent,
                max_tries: item.max_tries,
                minimum_normal_download_speed_kib: item
                    .minimum_normal_download_speed_kib
                    .unwrap_or_default(),
                retry_not_found_errors: item.retry_not_found_errors.unwrap_or(false),
                adaptive_mirror_selection: item.adaptive_mirror_selection.unwrap_or(true),
                proxy: item.proxy,
                format_selector: item.format_selector,
                cookie_source: item.cookie_source,
                is_media: media,
                is_torrent: item.is_torrent.unwrap_or(false),
                torrent_path: item.torrent_path,
                torrent_file_indices: item.torrent_file_indices,
                torrent_seed_time: item.torrent_seed_remaining.or(item.torrent_seed_time),
                torrent_seed_ratio: item.torrent_seed_ratio,
                torrent_seed_remaining: item.torrent_seed_remaining,
                torrent_web_seeds: item.torrent_web_seeds,
                torrent_upload_limit: item.torrent_upload_limit,
                torrent_max_peers: item.torrent_max_peers,
                torrent_peer_speed_limit: item.torrent_peer_speed_limit,
                torrent_check_integrity: item.torrent_check_integrity.unwrap_or(false),
                torrent_trackers: item.torrent_trackers,
                torrent_exclude_trackers: item.torrent_exclude_trackers,
                torrent_tracker_connect_timeout: item.torrent_tracker_connect_timeout,
                torrent_tracker_timeout: item.torrent_tracker_timeout,
                torrent_tracker_interval: item.torrent_tracker_interval,
                torrent_stop_timeout: item.torrent_stop_timeout,
                torrent_prioritize_piece: item.torrent_prioritize_piece,
                torrent_remove_unselected_file: item
                    .torrent_remove_unselected_file
                    .unwrap_or(false),
                torrent_encryption_policy: item.torrent_encryption_policy,
                torrent_file_allocation: item.torrent_file_allocation,
                torrent_verify_only: item.torrent_verify_only.unwrap_or(false),
                torrent_verify_restore_status: item.torrent_verify_restore_status,
                torrent_verified_length: None,
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

    struct BlockingSpawner {
        started: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    #[async_trait::async_trait]
    impl SidecarSpawner for BlockingSpawner {
        async fn add_uri(&self, _id: &str, _payload: &SpawnPayload) -> Result<String, String> {
            self.started.notify_one();
            self.release.notified().await;
            Ok("blocking-gid".to_string())
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

    fn allocation_pending_epoch<R: tauri::Runtime>(
        manager: &QueueManager<R>,
        id: &str,
    ) -> Option<(u64, u64)> {
        manager
            .aria2_allocation_pending
            .try_lock()
            .ok()
            .and_then(|pending| pending.get(id).copied())
    }

    #[test]
    fn aria2_allocation_eligibility_matches_download_type_and_torrent_policy() {
        assert!(QueueManager::<tauri::Wry>::aria2_allocation_phase_eligible(
            &SpawnPayload::default()
        ));
        assert!(!QueueManager::<tauri::Wry>::aria2_allocation_phase_eligible(
            &SpawnPayload {
                is_media: true,
                ..SpawnPayload::default()
            }
        ));
        assert!(!QueueManager::<tauri::Wry>::aria2_allocation_phase_eligible(
            &SpawnPayload {
                is_torrent: true,
                torrent_file_allocation: Some("prealloc".to_string()),
                ..SpawnPayload::default()
            }
        ));
        assert!(!QueueManager::<tauri::Wry>::aria2_allocation_phase_eligible(
            &SpawnPayload {
                is_torrent: true,
                torrent_file_allocation: Some("none".to_string()),
                ..SpawnPayload::default()
            }
        ));
        assert!(!QueueManager::<tauri::Wry>::aria2_allocation_phase_eligible(
            &SpawnPayload {
                is_torrent: true,
                torrent_verify_only: true,
                ..SpawnPayload::default()
            }
        ));
    }

    #[tokio::test]
    async fn allocation_stays_pending_while_async_add_uri_is_in_flight() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let manager = Arc::new(QueueManager::test_new(
            app.handle().clone(),
            1,
            Arc::new(BlockingSpawner {
                started: Arc::clone(&started),
                release: Arc::clone(&release),
            }),
        ));
        let previous_generation = manager
            .reserve_enqueue_generation("allocation", 7)
            .await
            .expect("lifecycle reservation");
        manager
            .commit_reserved_enqueue(
                QueuedTask {
                    id: "allocation".to_string(),
                    queue_id: "main".to_string(),
                    kind: TaskKind::Aria2,
                    payload: SpawnPayload::default(),
                    lifecycle_generation: 7,
                },
                7,
                previous_generation,
            )
            .await
            .expect("queued task");

        let dispatcher = tokio::spawn(Arc::clone(&manager).run_dispatcher());
        tokio::time::timeout(Duration::from_secs(1), started.notified())
            .await
            .expect("addUri should begin");
        assert_eq!(allocation_pending_epoch(&manager, "allocation"), Some((1, 7)));

        release.notify_one();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if manager.aria2_gid_for_download("allocation").as_deref() == Some("blocking-gid") {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("async addUri should install its GID");
        manager.handle_aria2_download_start("blocking-gid", 1).await;
        assert_eq!(allocation_pending_epoch(&manager, "allocation"), None);
        dispatcher.abort();
    }

    #[tokio::test]
    async fn enqueue_finalizer_failure_removes_pending_task_before_dispatch() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let manager = QueueManager::test_new(app.handle().clone(), 1, Arc::new(TestSpawner));
        let id = "finalizer-failure";
        let generation = 3;
        let previous_generation = manager
            .reserve_enqueue_generation(id, generation)
            .await
            .expect("lifecycle reservation");

        let error = manager
            .commit_reserved_enqueue_with_finalizer(
                QueuedTask {
                    id: id.to_string(),
                    queue_id: "main".to_string(),
                    kind: TaskKind::Aria2,
                    payload: SpawnPayload::default(),
                    lifecycle_generation: generation,
                    },
                    generation,
                    previous_generation,
                    || async { Err("journal commit failed".to_string()) },
            )
            .await
            .expect_err("a failed finalizer must reject admission");

        assert_eq!(error, "journal commit failed");
        assert!(manager.pending_order(None).await.is_empty());
        assert_eq!(manager.registered_lifecycle_generation(id).await, None);
        assert!(!manager.is_registered(id).await);
    }

    #[tokio::test]
    async fn enqueue_cancellation_during_finalizer_rejects_admission() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let manager = Arc::new(QueueManager::test_new(
            app.handle().clone(),
            1,
            Arc::new(TestSpawner),
        ));
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let finalizer_started = Arc::clone(&started);
        let finalizer_release = Arc::clone(&release);
        let id = "finalizer-cancelled".to_string();
        let generation = 4;
        let previous_generation = manager
            .reserve_enqueue_generation(&id, generation)
            .await
            .expect("lifecycle reservation");

        let commit_manager = Arc::clone(&manager);
        let commit_id = id.clone();
        let commit = tokio::spawn(async move {
            commit_manager
                .commit_reserved_enqueue_with_finalizer(
                    QueuedTask {
                        id: commit_id,
                        queue_id: "main".to_string(),
                        kind: TaskKind::Aria2,
                        payload: SpawnPayload::default(),
                        lifecycle_generation: generation,
                        },
                        generation,
                        previous_generation,
                        {
                        move || async move {
                            finalizer_started.notify_one();
                            finalizer_release.notified().await;
                            Ok(())
                        }
                    },
                )
                .await
        });

        tokio::time::timeout(Duration::from_secs(1), started.notified())
            .await
            .expect("finalizer should begin");
        manager.cancel_enqueue_generation(&id, generation).await;
        release.notify_one();

        let error = tokio::time::timeout(Duration::from_secs(1), commit)
            .await
            .expect("enqueue should finish")
            .expect("enqueue task should not panic")
            .expect_err("cancellation must reject the in-flight admission");
        assert_eq!(
            error,
            "Download enqueue was superseded by a newer user action"
        );
        assert!(manager.pending_order(None).await.is_empty());
        assert!(!manager.is_registered(&id).await);
    }

    #[tokio::test]
    async fn download_start_before_gid_registration_is_buffered_and_consumed() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let manager = QueueManager::test_new(app.handle().clone(), 1, Arc::new(TestSpawner));
        let epoch = manager.next_aria2_control_epoch("buffered-start").await;
        manager
            .begin_aria2_allocation(
                "buffered-start",
                epoch,
                9,
                &SpawnPayload::default(),
            )
            .await;
        manager.handle_aria2_download_start("early-gid", 1).await;
        assert!(manager
            .pending_download_starts
            .lock()
            .await
            .contains("early-gid"));

        manager
            .remember_gid("buffered-start".to_string(), "early-gid".to_string())
            .await;
        assert_eq!(allocation_pending_epoch(&manager, "buffered-start"), None);
        assert!(!manager
            .pending_download_starts
            .lock()
            .await
            .contains("early-gid"));
    }

    #[tokio::test]
    async fn allocation_fallback_and_stale_epochs_cannot_clear_a_new_lifecycle() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let manager = QueueManager::test_new(app.handle().clone(), 1, Arc::new(TestSpawner));
        let first_epoch = manager.next_aria2_control_epoch("stale-allocation").await;
        manager
            .begin_aria2_allocation(
                "stale-allocation",
                first_epoch,
                10,
                &SpawnPayload::default(),
            )
            .await;
        let second_epoch = manager.next_aria2_control_epoch("stale-allocation").await;
        manager
            .begin_aria2_allocation(
                "stale-allocation",
                second_epoch,
                11,
                &SpawnPayload::default(),
            )
            .await;
        manager
            .clear_aria2_allocation_for_epoch("stale-allocation", first_epoch)
            .await;
        manager
            .clear_aria2_allocation_for_lifecycle_generation("stale-allocation", 10)
            .await;
        assert_eq!(
            allocation_pending_epoch(&manager, "stale-allocation"),
            Some((second_epoch, 11))
        );

        manager
            .remember_gid("stale-allocation".to_string(), "fallback-gid".to_string())
            .await;
        manager
            .handle_aria2_download_start("fallback-gid", 0)
            .await;
        assert_eq!(
            allocation_pending_epoch(&manager, "stale-allocation"),
            Some((second_epoch, 11))
        );
        manager
            .complete_aria2_allocation_for_gid("fallback-gid", 0)
            .await;
        assert_eq!(
            allocation_pending_epoch(&manager, "stale-allocation"),
            Some((second_epoch, 11))
        );
        manager
            .complete_aria2_allocation_for_gid("fallback-gid", 1)
            .await;
        assert_eq!(allocation_pending_epoch(&manager, "stale-allocation"), None);

        manager
            .begin_aria2_allocation(
                "stale-allocation",
                second_epoch,
                11,
                &SpawnPayload::default(),
            )
            .await;
        manager.handle_aria2_download_start("fallback-gid", 1).await;
        assert_eq!(allocation_pending_epoch(&manager, "stale-allocation"), None);
    }

    #[tokio::test]
    async fn ignored_gid_start_markers_cannot_clear_a_new_lifecycle() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let manager = QueueManager::test_new(app.handle().clone(), 1, Arc::new(TestSpawner));
        let old_epoch = manager.next_aria2_control_epoch("ignored-start").await;
        manager
            .begin_aria2_allocation(
                "ignored-start",
                old_epoch,
                20,
                &SpawnPayload::default(),
            )
            .await;
        manager
            .remember_gid("ignored-start".to_string(), "reused-gid".to_string())
            .await;
        manager.forget_aria2_gid("ignored-start").await;

        manager.handle_aria2_download_start("reused-gid", 1).await;
        assert!(!manager
            .pending_download_starts
            .lock()
            .await
            .contains("reused-gid"));

        let new_epoch = manager.next_aria2_control_epoch("ignored-start").await;
        manager
            .begin_aria2_allocation(
                "ignored-start",
                new_epoch,
                21,
                &SpawnPayload::default(),
            )
            .await;
        manager
            .remember_gid("ignored-start".to_string(), "new-gid".to_string())
            .await;
        assert_eq!(
            allocation_pending_epoch(&manager, "ignored-start"),
            Some((new_epoch, 21))
        );
        manager.handle_aria2_download_start("new-gid", 1).await;
        assert_eq!(allocation_pending_epoch(&manager, "ignored-start"), None);
    }

    #[tokio::test]
    async fn allocation_is_cleared_by_terminal_reconciliation_and_cancellation() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let manager = QueueManager::test_new(app.handle().clone(), 1, Arc::new(TestSpawner));
        let epoch = manager.next_aria2_control_epoch("terminal-allocation").await;
        manager
            .begin_aria2_allocation(
                "terminal-allocation",
                epoch,
                12,
                &SpawnPayload::default(),
            )
            .await;
        manager
            .apply_completion("terminal-allocation", PendingOutcome::Error("disk full".to_string()))
            .await;
        assert_eq!(allocation_pending_epoch(&manager, "terminal-allocation"), None);

        let next_epoch = manager.next_aria2_control_epoch("terminal-allocation").await;
        manager
            .begin_aria2_allocation(
                "terminal-allocation",
                next_epoch,
                13,
                &SpawnPayload::default(),
            )
            .await;
        manager.clear_aria2_allocation("terminal-allocation").await;
        assert_eq!(allocation_pending_epoch(&manager, "terminal-allocation"), None);
    }

    struct SeedSpawner;

    #[async_trait::async_trait]
    impl SidecarSpawner for SeedSpawner {
        async fn add_uri(&self, id: &str, _payload: &SpawnPayload) -> Result<String, String> {
            Ok(format!("gid-{id}"))
        }

        async fn remove_uri(&self, _gid: &str) -> Result<(), String> {
            Ok(())
        }

        async fn pause_for_seed(&self, _gid: &str) -> Result<Aria2SeedControlOutcome, String> {
            Ok(Aria2SeedControlOutcome::Paused)
        }

        async fn resume_for_seed(&self, _gid: &str) -> Result<Aria2SeedControlOutcome, String> {
            Ok(Aria2SeedControlOutcome::Resumed)
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

    struct AmbiguousResumeSeedSpawner {
        resume_calls: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl SidecarSpawner for AmbiguousResumeSeedSpawner {
        async fn add_uri(&self, id: &str, _payload: &SpawnPayload) -> Result<String, String> {
            Ok(format!("gid-{id}"))
        }

        async fn remove_uri(&self, _gid: &str) -> Result<(), String> {
            Ok(())
        }

        async fn pause_for_seed(&self, _gid: &str) -> Result<Aria2SeedControlOutcome, String> {
            Ok(Aria2SeedControlOutcome::Paused)
        }

        async fn resume_for_seed(&self, _gid: &str) -> Result<Aria2SeedControlOutcome, String> {
            if self.resume_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Err("seed resume status verification unavailable".to_string())
            } else {
                Ok(Aria2SeedControlOutcome::Resumed)
            }
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
    fn normal_reliability_options_are_bounded_and_do_not_apply_to_torrents() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            minimum_normal_download_speed_kib: 64,
            adaptive_mirror_selection: true,
            ..SpawnPayload::default()
        };
        apply_aria2_normal_reliability_options(&mut options, &payload, 2).unwrap();
        assert_eq!(
            options.get("lowest-speed-limit"),
            Some(&serde_json::json!("64K"))
        );
        assert_eq!(
            options.get("uri-selector"),
            Some(&serde_json::json!("adaptive"))
        );

        options.clear();
        apply_aria2_normal_reliability_options(&mut options, &payload, 1).unwrap();
        assert!(!options.contains_key("uri-selector"));

        options.clear();
        apply_aria2_normal_reliability_options(
            &mut options,
            &SpawnPayload {
                is_torrent: true,
                minimum_normal_download_speed_kib: 64,
                adaptive_mirror_selection: true,
                ..SpawnPayload::default()
            },
            2,
        )
        .unwrap();
        assert!(options.is_empty());
        assert!(normalize_minimum_normal_download_speed_kib(
            MAX_MINIMUM_NORMAL_DOWNLOAD_SPEED_KIB + 1
        )
        .is_err());
    }

    #[test]
    fn resolver_state_events_are_typed_and_redacted() {
        let event = DownloadStateEvent::failed(
            "dns-event",
            "aria2 error code 19: Name resolution failed for https://example.test/file?token=secret",
        );
        assert_eq!(event.error_kind, Some(crate::ipc::DownloadErrorKind::NameResolution));
        assert!(event.error.as_deref().is_some_and(|error| {
            error.contains("[redacted]") && !error.contains("token=secret")
        }));

        let retry = DownloadStateEvent::retrying_with_resolver_fallback(
            "dns-event",
            "aria2 error code 19: Name resolution failed",
        );
        assert_eq!(retry.error_kind, Some(crate::ipc::DownloadErrorKind::NameResolution));
        assert_eq!(retry.resolver_fallback, Some(true));
    }

    #[test]
    fn torrent_payloads_do_not_use_generic_connection_options() {
        let torrent = SpawnPayload {
            is_torrent: true,
            connections: Some(16),
            ..Default::default()
        };
        let normal = SpawnPayload {
            is_torrent: false,
            connections: Some(16),
            ..Default::default()
        };
        let mut torrent_options = serde_json::Map::new();
        if should_apply_aria2_connection_options(&torrent) {
            apply_aria2_connection_options(&mut torrent_options, 16);
        }
        assert!(!torrent_options.contains_key("split"));
        assert!(!torrent_options.contains_key("max-connection-per-server"));

        let mut normal_options = serde_json::Map::new();
        if should_apply_aria2_connection_options(&normal) {
            apply_aria2_connection_options(&mut normal_options, 16);
        }
        assert_eq!(normal_options.get("split"), Some(&serde_json::json!("16")));
        assert_eq!(normal_options.get("max-connection-per-server"), Some(&serde_json::json!("16")));
    }

    #[test]
    fn torrent_payloads_do_not_emit_generic_headers_or_cookies() {
        let payload = SpawnPayload {
            is_torrent: true,
            headers: Some("User-Agent: browser\nAuthorization: secret".to_string()),
            cookies: Some("session=secret".to_string()),
            ..Default::default()
        };
        let mut options = serde_json::Map::new();

        apply_aria2_header_options(&mut options, &payload, false);

        assert!(!options.contains_key("header"));
    }

    #[test]
    fn torrent_enqueue_items_strip_generic_credentials_before_task_creation() {
        let mut item = EnqueueItem {
            is_torrent: Some(true),
            username: Some("browser-user".to_string()),
            password: Some("secret".to_string()),
            headers: Some("Authorization: secret".to_string()),
            cookies: Some("session=secret".to_string()),
            ..Default::default()
        };

        item.strip_torrent_credentials();
        let task = item.into_task();

        assert!(task.payload.username.is_none());
        assert!(task.payload.password.is_none());
        assert!(task.payload.headers.is_none());
        assert!(task.payload.cookies.is_none());
    }

    #[test]
    fn torrent_network_and_storage_settings_are_normalized_at_the_boundary() {
        assert_eq!(
            normalize_torrent_bind_address(Some(" 2001:db8::1 ")).unwrap(),
            Some("2001:db8::1".to_string())
        );
        assert_eq!(normalize_torrent_bind_address(Some(" ")).unwrap(), None);
        assert!(normalize_torrent_bind_address(Some("localhost")).is_err());
        assert!(normalize_torrent_bind_address(Some("127.0.0.1\n--bad")).is_err());

        assert_eq!(normalize_aria2_disk_cache(None).unwrap(), "16M");
        assert_eq!(normalize_aria2_disk_cache(Some(" 256m ")).unwrap(), "256M");
        assert_eq!(normalize_aria2_disk_cache(Some("1024K")).unwrap(), "1024K");
        assert_eq!(normalize_aria2_disk_cache(Some("0")).unwrap(), "0");
        assert!(normalize_aria2_disk_cache(Some("1025M")).is_err());
        assert!(normalize_aria2_disk_cache(Some("16")).is_err());

        assert_eq!(normalize_torrent_file_allocation(None).unwrap(), "prealloc");
        assert_eq!(normalize_torrent_file_allocation(Some(" none ")).unwrap(), "none");
        assert!(normalize_torrent_file_allocation(Some("truncate")).is_err());
    }

    #[test]
    fn torrent_verification_evidence_requires_matching_lengths_but_accepts_empty_data() {
        assert_eq!(
            QueueManager::<tauri::Wry>::complete_torrent_verification_length(
                Some("complete"),
                false,
                Some(0),
                Some(0),
            ),
            Some(0)
        );
        assert_eq!(
            QueueManager::<tauri::Wry>::complete_torrent_verification_length(
                Some("complete"),
                false,
                Some(100),
                Some(99),
            ),
            None
        );
        assert_eq!(
            QueueManager::<tauri::Wry>::complete_torrent_verification_length(
                Some("complete"),
                true,
                Some(100),
                Some(100),
            ),
            None
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
    fn direct_magnet_parent_detection_requires_a_metadata_file() {
        let parent = serde_json::json!({
            "status": "complete",
            "followedBy": ["0123456789abcdef"],
            "files": [{"path": "[METADATA]firelink-torrent-runtime"}],
        });
        assert!(aria2_magnet_parent_has_metadata_file(&parent));
        assert!(!aria2_magnet_parent_has_payload_file(&parent));
        assert_eq!(
            aria2_magnet_followed_gids(&parent, "fedcba9876543210"),
            vec!["0123456789abcdef".to_string()]
        );

        let malformed = serde_json::json!({
            "followedBy": [
                "not-a-gid",
                "0123456789abcdef",
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef1"
            ],
            "files": [{"path": "payload.bin"}],
        });
        assert!(!aria2_magnet_parent_has_metadata_file(&malformed));
        assert!(aria2_magnet_parent_has_payload_file(&malformed));
        assert_eq!(
            aria2_magnet_followed_gids(&malformed, "parent"),
            vec!["0123456789abcdef".to_string()]
        );

        let final_payload = serde_json::json!({
            "status": "complete",
            "files": [{"path": "/downloads/payload.bin"}],
        });
        assert!(aria2_magnet_parent_has_payload_file(&final_payload));
    }

    #[tokio::test]
    async fn direct_magnet_control_status_cannot_treat_parent_as_payload() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let manager = QueueManager::test_new(app.handle().clone(), 1, Arc::new(TestSpawner));
        let id = "direct-magnet-control";
        let gid = "0123456789abcdef";
        let payload = SpawnPayload {
            url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
                .to_string(),
            is_torrent: true,
            ..Default::default()
        };
        assert!(is_direct_magnet_payload(&payload));
        manager.aria2_payloads.lock().await.insert(
            id.to_string(),
            payload,
        );
        manager.remember_gid(id.to_string(), gid.to_string()).await;

        assert_eq!(manager.aria2_gid_for_download(id).as_deref(), Some(gid));
        assert!(
            manager
                .aria2_direct_magnet_needs_child_handoff(id, gid)
                .await
        );

        manager
            .aria2_magnet_payload_gids
            .lock()
            .await
            .insert(
                id.to_string(),
                Aria2GidMapping {
                    id: id.to_string(),
                    epoch: 0,
                },
            );
        assert!(!manager
            .aria2_direct_magnet_needs_child_handoff(id, gid)
            .await);
    }

    #[test]
    fn normal_torrent_options_make_metadata_and_following_policy_explicit() {
        let mut options = serde_json::Map::new();
        apply_aria2_torrent_options(
            &mut options,
            &SpawnPayload {
                is_torrent: true,
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(
            options.get("bt-metadata-only"),
            Some(&serde_json::json!("false"))
        );
        assert_eq!(
            options.get("bt-save-metadata"),
            Some(&serde_json::json!("false"))
        );
        assert_eq!(
            options.get("follow-torrent"),
            Some(&serde_json::json!("false"))
        );
        assert!(!options.contains_key("async-dns"));

        let mut proxied_options = serde_json::Map::new();
        apply_aria2_torrent_options(
            &mut proxied_options,
            &SpawnPayload {
                is_torrent: true,
                proxy: Some("http://127.0.0.1:8080".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!proxied_options.contains_key("async-dns"));
    }

    #[test]
    fn generic_aria2_downloads_disable_followed_child_gids() {
        let mut options = serde_json::Map::new();
        apply_aria2_follow_options(&mut options, &SpawnPayload::default());

        assert_eq!(
            options.get("follow-torrent"),
            Some(&serde_json::json!("false"))
        );
        assert_eq!(
            options.get("follow-metalink"),
            Some(&serde_json::json!("false"))
        );
    }

    #[test]
    fn explicit_torrent_downloads_do_not_override_follow_policy() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            ..Default::default()
        };

        apply_aria2_follow_options(&mut options, &payload);

        assert!(!options.contains_key("follow-torrent"));
        assert!(!options.contains_key("follow-metalink"));
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
    fn torrent_verification_uses_hash_only_options_and_ignores_transfer_policy() {
        let mut options = serde_json::Map::new();
        let payload = SpawnPayload {
            is_torrent: true,
            torrent_verify_only: true,
            torrent_trackers: Some("https://tracker.example/announce".to_string()),
            torrent_seed_ratio: Some(1.0),
            torrent_file_allocation: Some("none".to_string()),
            ..Default::default()
        };

        apply_aria2_torrent_options(&mut options, &payload).unwrap();

        assert_eq!(options.get("check-integrity"), Some(&serde_json::json!("true")));
        assert_eq!(options.get("hash-check-only"), Some(&serde_json::json!("true")));
        assert_eq!(options.get("seed-time"), Some(&serde_json::json!("0")));
        assert_eq!(options.get("seed-ratio"), Some(&serde_json::json!("0")));
        assert!(!options.contains_key("bt-tracker"));
        assert!(!options.contains_key("file-allocation"));
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
            "https://127.0.0.1/announce",
            "https://localhost/announce",
            "https://tracker.example/announce,",
            "https://",
        ] {
            assert!(normalize_torrent_trackers(Some(value)).is_err(), "{value}");
        }
        assert_eq!(
            normalize_torrent_trackers(Some(
                "https://this-tracker-does-not-resolve.invalid/announce"
            ))
            .unwrap(),
            Some("https://this-tracker-does-not-resolve.invalid/announce".to_string())
        );
        let too_many = (0..=MAX_TORRENT_TRACKERS)
            .map(|index| format!("https://tracker{index}.example/announce"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(normalize_torrent_trackers(Some(&too_many)).is_err());
    }

    #[test]
    fn torrent_fallback_mirrors_use_the_dedicated_http_policy() {
        assert_eq!(
            normalize_torrent_mirror_uris(Some(
                " https://mirror.example/one\nhttps://mirror.example/one\nhttps://mirror.example/two "
            ))
            .unwrap(),
            vec![
                "https://mirror.example/one".to_string(),
                "https://mirror.example/two".to_string()
            ]
        );
        for value in [
            "ftp://mirror.example/file",
            "sftp://mirror.example/file",
            "https://user:pass@mirror.example/file",
            "https://mirror.example/file#fragment",
            "https://127.0.0.1/file",
            "https://mirror.localhost/file",
        ] {
            assert!(
                normalize_torrent_mirror_uris(Some(value)).is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn initial_torrent_web_seed_readback_keeps_existing_and_explicit_uris() {
        let current = HashMap::from([
            (
                1,
                HashSet::from(["https://embedded.example/file".to_string()]),
            ),
            (
                2,
                HashSet::from(["https://legacy.example/file".to_string()]),
            ),
        ]);
        let explicit = vec![(1, "https://explicit.example/file".to_string())];
        let mut expected = current.clone();
        expected
            .get_mut(&1)
            .expect("file 1 should be present")
            .insert("https://explicit.example/file".to_string());

        assert_eq!(
            expected_initial_torrent_web_seed_state(&current, &explicit),
            expected
        );
    }

    #[test]
    fn torrent_tracker_destination_validation_keeps_dns_route_owned() {
        assert!(validate_torrent_tracker_destinations(&[
            "https://tracker-does-not-resolve.invalid/announce".to_string(),
            "udp://tracker-does-not-resolve.invalid:6969/announce".to_string(),
        ])
        .is_ok());
        for tracker in [
            "https://127.0.0.1/announce",
            "https://[::1]/announce",
            "udp://localhost:6969/announce",
        ] {
            assert!(
                validate_torrent_tracker_destinations(&[tracker.to_string()]).is_err(),
                "{tracker}"
            );
        }
    }

    #[test]
    fn aria2_web_seed_readback_keeps_file_ownership_separate() {
        let files = vec![
            crate::ipc::TorrentFile {
                index: 1,
                path: "one.bin".to_string(),
                length: 1,
            },
            crate::ipc::TorrentFile {
                index: 2,
                path: "two.bin".to_string(),
                length: 1,
            },
        ];
        let result = serde_json::json!([
            {
                "index": "1",
                "uris": [{"uri": "https://mirror.example/bundle/one.bin"}]
            },
            {
                "index": "2",
                "uris": [{"uri": "https://mirror.example/bundle/two.bin"}]
            }
        ]);
        let state = normalize_aria2_torrent_file_uris(
            parse_aria2_torrent_file_uris(&result).unwrap(),
            &files,
        )
        .unwrap();

        assert!(state[&1].contains("https://mirror.example/bundle/one.bin"));
        assert!(!state[&1].contains("https://mirror.example/bundle/two.bin"));
        assert!(state[&2].contains("https://mirror.example/bundle/two.bin"));
        assert!(normalize_aria2_torrent_file_uris(
            parse_aria2_torrent_file_uris(&serde_json::json!([
                {"index": "0", "uris": []},
                {"index": "2", "uris": []}
            ]))
            .unwrap(),
            &files,
        )
        .is_err());
    }

    #[test]
    fn aria2_expands_unscoped_web_seed_baselines_per_torrent_file() {
        let metadata = crate::torrent::ParsedTorrent {
            name: "bundle".to_string(),
            total_bytes: 2,
            files: vec![
                crate::ipc::TorrentFile {
                    index: 1,
                    path: "folder/one.bin".to_string(),
                    length: 1,
                },
                crate::ipc::TorrentFile {
                    index: 2,
                    path: "two.bin".to_string(),
                    length: 1,
                },
            ],
            info_hash: "0123456789abcdef0123456789abcdef01234567".to_string(),
            web_seeds: Vec::new(),
        };
        let expanded = expand_torrent_web_seed_sources(
            &["https://mirror.example/base".to_string()],
            &metadata,
        )
        .unwrap();

        assert_eq!(
            expanded,
            HashSet::from([
                (
                    1,
                    "https://mirror.example/base/bundle/folder/one.bin".to_string()
                ),
                (2, "https://mirror.example/base/bundle/two.bin".to_string()),
            ])
        );
    }

    #[test]
    fn torrent_web_seed_change_preserves_baseline_and_removes_only_explicit_pairs() {
        let current = HashMap::from([
            (
                1,
                HashSet::from([
                    "https://mirror.example/bundle/one.bin".to_string(),
                    "https://explicit.example/one.bin".to_string(),
                ]),
            ),
            (
                2,
                HashSet::from(["https://mirror.example/bundle/two.bin".to_string()]),
            ),
        ]);
        let baseline = HashSet::from([
            (1, "https://mirror.example/bundle/one.bin".to_string()),
            (2, "https://mirror.example/bundle/two.bin".to_string()),
        ]);
        let old = vec![
            (1, "https://mirror.example/bundle/one.bin".to_string()),
            (1, "https://explicit.example/one.bin".to_string()),
        ];
        let new = vec![(2, "https://explicit.example/two.bin".to_string())];

        let (expected, changes) =
            plan_torrent_web_seed_change(&current, &baseline, &old, &new).unwrap();
        assert_eq!(
            changes,
            vec![
                (
                    1,
                    vec!["https://explicit.example/one.bin".to_string()],
                    Vec::new(),
                ),
                (
                    2,
                    Vec::new(),
                    vec!["https://explicit.example/two.bin".to_string()],
                ),
            ]
        );
        assert_eq!(
            expected[&1],
            HashSet::from(["https://mirror.example/bundle/one.bin".to_string()])
        );
        assert_eq!(
            expected[&2],
            HashSet::from([
                "https://mirror.example/bundle/two.bin".to_string(),
                "https://explicit.example/two.bin".to_string(),
            ])
        );
    }

    #[test]
    fn torrent_web_seed_change_rejects_unknown_file_indices_without_panicking() {
        let current = HashMap::from([
            (1, HashSet::from(["https://mirror.example/one".to_string()])),
            (2, HashSet::from(["https://mirror.example/two".to_string()])),
        ]);

        let result = plan_torrent_web_seed_change(
            &current,
            &HashSet::new(),
            &[],
            &[(999, "https://explicit.example/unknown".to_string())],
        );

        assert!(result.is_err());
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
    fn torrent_peer_diagnostics_are_bounded_and_omit_identity_and_bitfields() {
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
        assert_eq!(diagnostics.listed_peers, (MAX_TORRENT_PEER_DIAGNOSTICS + 2) as u32);
        assert_eq!(diagnostics.listed_seeders, 2);
        assert_eq!(diagnostics.peers.len(), MAX_TORRENT_PEER_DIAGNOSTICS);
        assert!(diagnostics.truncated);
        assert_eq!(diagnostics.peers[0].ip.as_deref(), Some("192.0.2.10"));
        assert_eq!(diagnostics.peers[0].port, Some(6881));
        let serialized = serde_json::to_string(&diagnostics).unwrap();
        assert!(serialized.contains("192.0.2."));
        assert!(!serialized.contains("\"port\":null"));
        assert!(!serialized.contains("peerId"));
        assert!(!serialized.contains("secret-peer-id"));
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

    fn test_torrent_progress_metadata() -> Vec<crate::ipc::TorrentFile> {
        vec![
            crate::ipc::TorrentFile {
                index: 1,
                path: "folder/one.bin".to_string(),
                length: 12,
            },
            crate::ipc::TorrentFile {
                index: 2,
                path: "folder/two.bin".to_string(),
                length: 7,
            },
        ]
    }

    #[test]
    fn torrent_file_progress_uses_validated_metadata_and_discards_daemon_paths() {
        let result = serde_json::json!([
            {
                "index": "2",
                "path": "/private/secret/two.bin",
                "uris": [{"uri": "https://secret.example/file"}],
                "length": "7",
                "completedLength": "3",
                "selected": "false"
            },
            {
                "index": "1",
                "path": "/private/secret/one.bin",
                "length": "12",
                "completedLength": "12",
                "selected": "true"
            }
        ]);

        let snapshot = parse_torrent_file_progress(result, &test_torrent_progress_metadata()).unwrap();
        assert_eq!(snapshot.files[0].relative_path, "folder/one.bin");
        assert_eq!(snapshot.files[0].completed_length, 12);
        assert!(snapshot.files[0].selected);
        assert_eq!(snapshot.files[1].relative_path, "folder/two.bin");
        assert_eq!(snapshot.files[1].completed_length, 3);
        assert!(!snapshot.files[1].selected);
        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(!serialized.contains("/private/secret"));
        assert!(!serialized.contains("secret.example"));
    }

    #[test]
    fn torrent_file_progress_rejects_malformed_and_inconsistent_rows() {
        let metadata = test_torrent_progress_metadata();
        let cases = [
            (
                serde_json::json!([{
                    "index": "1",
                    "length": "not-a-number",
                    "completedLength": "0",
                    "selected": "true"
                }, {
                    "index": "2",
                    "length": "7",
                    "completedLength": "0",
                    "selected": "true"
                }]),
                "invalid file length",
            ),
            (
                serde_json::json!([{
                    "index": "1",
                    "length": "12",
                    "completedLength": "13",
                    "selected": "true"
                }, {
                    "index": "2",
                    "length": "7",
                    "completedLength": "0",
                    "selected": "true"
                }]),
                "over-complete",
            ),
            (
                serde_json::json!([{
                    "index": "1",
                    "length": "12",
                    "completedLength": "0",
                    "selected": "true"
                }, {
                    "index": "1",
                    "length": "12",
                    "completedLength": "0",
                    "selected": "true"
                }]),
                "duplicate",
            ),
            (
                serde_json::json!([{
                    "index": "3",
                    "length": "12",
                    "completedLength": "0",
                    "selected": "true"
                }, {
                    "index": "2",
                    "length": "7",
                    "completedLength": "0",
                    "selected": "true"
                }]),
                "unknown",
            ),
        ];

        for (result, expected) in cases {
            let error = parse_torrent_file_progress(result, &metadata).unwrap_err();
            assert!(error.contains(expected), "{error}");
        }
        let error = parse_torrent_file_progress(serde_json::json!([]), &metadata).unwrap_err();
        assert!(error.contains("file count"));
    }

    #[test]
    fn torrent_piece_progress_decodes_high_bit_first_and_buckets_small_torrents() {
        let snapshot = parse_torrent_piece_progress(serde_json::json!({
            "pieceLength": "16384",
            "numPieces": "10",
            "bitfield": "9040"
        }))
        .unwrap();

        assert_eq!(snapshot.piece_length, 16_384);
        assert_eq!(snapshot.num_pieces, 10);
        assert_eq!(snapshot.completed_pieces, 3);
        assert_eq!(snapshot.buckets, vec![100, 0, 0, 100, 0, 0, 0, 0, 0, 100]);
    }

    #[test]
    fn torrent_piece_progress_aggregates_to_at_most_256_balanced_buckets() {
        let bitfield = "ff".repeat(64);
        let snapshot = parse_torrent_piece_progress(serde_json::json!({
            "pieceLength": "1",
            "numPieces": "512",
            "bitfield": bitfield
        }))
        .unwrap();

        assert_eq!(snapshot.completed_pieces, 512);
        assert_eq!(snapshot.buckets.len(), 256);
        assert!(snapshot.buckets.iter().all(|value| *value == 100));
    }

    #[test]
    fn torrent_piece_progress_rejects_missing_fields_malformed_hex_and_overflow_bits() {
        let cases = [
            (serde_json::json!({}), "invalid pieceLength"),
            (
                serde_json::json!({
                    "pieceLength": "16384",
                    "numPieces": "0",
                    "bitfield": ""
                }),
                "non-positive",
            ),
            (
                serde_json::json!({
                    "pieceLength": "16384",
                    "numPieces": "8",
                    "bitfield": "xz"
                }),
                "invalid piece bitfield",
            ),
            (
                serde_json::json!({
                    "pieceLength": "16384",
                    "numPieces": "10",
                    "bitfield": "904f"
                }),
                "overflow",
            ),
        ];

        for (result, expected) in cases {
            let error = parse_torrent_piece_progress(result).unwrap_err();
            assert!(error.contains(expected), "{error}");
        }
    }

    #[test]
    fn torrent_network_limits_and_web_seed_normalization_are_bounded() {
        assert_eq!(normalize_torrent_dht_message_timeout(1).unwrap(), 1);
        assert_eq!(normalize_torrent_dht_message_timeout(60).unwrap(), 60);
        assert!(normalize_torrent_dht_message_timeout(0).is_err());
        assert!(normalize_torrent_dht_message_timeout(61).is_err());
        assert_eq!(normalize_torrent_max_concurrent_seeds(2).unwrap(), 2);
        assert!(normalize_torrent_max_concurrent_seeds(65).is_err());

        let files = vec![
            crate::ipc::TorrentFile {
                index: 1,
                path: "folder/file.bin".to_string(),
                length: 3,
            },
            crate::ipc::TorrentFile {
                index: 2,
                path: "other.txt".to_string(),
                length: 4,
            },
        ];
        let seeds = normalize_torrent_web_seeds(
            Some(&[
                crate::ipc::TorrentWebSeed {
                    file_index: 1,
                    uri: " https://mirror.example/base/ ".to_string(),
                },
                crate::ipc::TorrentWebSeed {
                    file_index: 1,
                    uri: "https://mirror.example/base/".to_string(),
                },
            ]),
            &files,
        )
        .unwrap();
        assert_eq!(seeds.len(), 1);
        assert_eq!(
            expand_torrent_web_seeds(&seeds, &files).unwrap()[0].1,
            "https://mirror.example/base/folder/file.bin"
        );
        assert!(normalize_torrent_web_seeds(
            Some(&[crate::ipc::TorrentWebSeed {
                file_index: 1,
                uri: "ftp://mirror.example/file".to_string(),
            }]),
            &files,
        )
        .is_err());
        assert!(normalize_torrent_web_seeds(
            Some(&[crate::ipc::TorrentWebSeed {
                file_index: 9,
                uri: "https://mirror.example/file".to_string(),
            }]),
            &files,
        )
        .is_err());
    }

    #[test]
    fn normal_protocol_options_use_the_protocol_specific_aria2_keys() {
        let payload = SpawnPayload {
            username: Some("alice".to_string()),
            password: Some("secret".to_string()),
            sftp_host_key_md: Some(
                "sha-1=0123456789abcdef0123456789abcdef01234567".to_string(),
            ),
            ..SpawnPayload::default()
        };
        let mut options = serde_json::Map::new();
        apply_protocol_auth_options(
            &mut options,
            &payload,
            &["ftp://example.test/file.bin".to_string()],
        );
        assert_eq!(options.get("ftp-user"), Some(&serde_json::json!("alice")));
        assert_eq!(options.get("ftp-passwd"), Some(&serde_json::json!("secret")));
        assert!(!options.contains_key("http-user"));
        assert!(!options.contains_key("ssh-host-key-md"));

        options.clear();
        apply_protocol_auth_options(
            &mut options,
            &payload,
            &["sftp://example.test/file.bin".to_string()],
        );
        assert_eq!(options.get("ftp-user"), Some(&serde_json::json!("alice")));
        assert_eq!(
            options.get("ssh-host-key-md"),
            Some(&serde_json::json!("sha-1=0123456789abcdef0123456789abcdef01234567"))
        );
        assert!(!options.contains_key("http-user"));
    }

    #[test]
    fn inline_url_credentials_are_treated_as_credential_material() {
        assert!(payload_has_credential_material(&SpawnPayload {
            url: "https://alice:secret@example.test/file".to_string(),
            ..SpawnPayload::default()
        }));
        assert!(payload_has_credential_material(&SpawnPayload {
            url: "https://example.test/file".to_string(),
            mirrors: Some("https://alice:secret@mirror.example/file".to_string()),
            ..SpawnPayload::default()
        }));
        assert!(header_name_has_credential_material("X-Request-Signature"));
        assert!(!header_name_has_credential_material("Referer"));
    }

    #[test]
    fn normal_checksum_options_enable_aria2_integrity_checks() {
        let mut options = serde_json::Map::new();
        apply_checksum_options(&mut options, Some("SHA-256=ABCDEF"));
        assert_eq!(options.get("checksum"), Some(&serde_json::json!("sha-256=ABCDEF")));
        assert_eq!(options.get("check-integrity"), Some(&serde_json::json!("true")));

        options.clear();
        apply_checksum_options(&mut options, None);
        assert!(options.is_empty());
    }

    #[test]
    fn sftp_host_key_fingerprints_are_normalized_and_bounded() {
        assert_eq!(
            normalize_sftp_host_key_md(Some(
                " SHA-1=0123456789ABCDEF0123456789ABCDEF01234567 ",
            ))
            .unwrap()
            .as_deref(),
            Some("sha-1=0123456789abcdef0123456789abcdef01234567")
        );
        assert!(normalize_sftp_host_key_md(Some("sha-256=abcd")).is_err());
        assert!(normalize_sftp_host_key_md(Some("md5=abcd")).is_err());
        assert!(normalize_sftp_host_key_md(Some("sha-1=xyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzx")).is_err());
        assert_eq!(normalize_sftp_host_key_md(Some(" ")).unwrap(), None);
    }

    #[test]
    fn range_probe_does_not_forward_credentials_across_origins() {
        crate::ensure_reqwest_crypto_provider();
        let payload = SpawnPayload {
            username: Some("alice".to_string()),
            password: Some("secret".to_string()),
            cookies: Some("session=secret".to_string()),
            headers: Some("Authorization: Bearer secret\nX-Test: yes".to_string()),
            ..SpawnPayload::default()
        };
        let client = reqwest::Client::builder().build().unwrap();
        let same_origin = apply_payload_headers(
            client.get("https://example.test/file"),
            &payload,
            true,
        )
        .build()
        .unwrap();
        assert!(same_origin.headers().contains_key(reqwest::header::COOKIE));
        assert!(same_origin.headers().contains_key(reqwest::header::AUTHORIZATION));
        assert_eq!(same_origin.headers().get("x-test").unwrap(), "yes");

        let cross_origin = apply_payload_headers(
            client.get("https://cdn.example.test/file"),
            &payload,
            false,
        )
        .build()
        .unwrap();
        assert!(!cross_origin.headers().contains_key(reqwest::header::COOKIE));
        assert!(!cross_origin.headers().contains_key(reqwest::header::AUTHORIZATION));
        assert!(!cross_origin.headers().contains_key("x-test"));
    }

    #[test]
    fn range_probe_allows_http_to_https_upgrade_but_not_cross_origin_return() {
        let original = reqwest::Url::parse("http://example.test/file").unwrap();
        let upgrade = reqwest::Url::parse("https://example.test/file").unwrap();
        let unrelated = reqwest::Url::parse("https://cdn.example.test/file").unwrap();

        assert!(can_forward_payload_credentials(&original, &original));
        assert!(can_forward_payload_credentials(&original, &upgrade));
        assert!(!can_forward_payload_credentials(&original, &unrelated));
        assert!(!can_forward_payload_credentials(
            &reqwest::Url::parse("https://example.test/file").unwrap(),
            &reqwest::Url::parse("http://example.test/file").unwrap()
        ));

        let ftp_origin = reqwest::Url::parse("ftp://example.test/file").unwrap();
        assert!(can_forward_payload_credentials(
            &ftp_origin,
            &reqwest::Url::parse("ftp://example.test/other").unwrap(),
        ));
        assert!(!can_forward_payload_credentials(
            &ftp_origin,
            &reqwest::Url::parse("ftp://mirror.example.test/file").unwrap(),
        ));

        let redirected_with_credentials = reqwest::Url::parse(
            "https://alice:secret@cdn.example.test/file",
        )
        .unwrap();
        let (sanitized, credentials_allowed) = apply_redirect_credentials_policy(
            &original,
            true,
            redirected_with_credentials,
        );
        assert!(!credentials_allowed);
        assert!(sanitized.username().is_empty());
        assert!(sanitized.password().is_none());
    }

    #[tokio::test]
    async fn range_probe_fixture_follows_redirect_and_forwards_same_origin_credentials() {
        use axum::{
            http::{HeaderMap, StatusCode},
            response::{IntoResponse, Redirect},
            routing::get,
            Router,
        };

        async fn source() -> Redirect {
            Redirect::temporary("/final")
        }

        async fn final_resource(headers: HeaderMap) -> impl IntoResponse {
            let range = headers
                .get("range")
                .and_then(|value| value.to_str().ok());
            let cookie = headers
                .get("cookie")
                .and_then(|value| value.to_str().ok());
            if range == Some("bytes=0-0") && cookie == Some("session=secret") {
                (
                    StatusCode::PARTIAL_CONTENT,
                    [("content-range", "bytes 0-0/8")],
                )
                    .into_response()
            } else {
                StatusCode::UNAUTHORIZED.into_response()
            }
        }

        let app = Router::new()
            .route("/source", get(source))
            .route("/final", get(final_resource));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("fixture listener");
        let port = listener.local_addr().expect("fixture address").port();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let source_url = format!("http://127.0.0.1:{port}/source");
        let payload = SpawnPayload {
            url: source_url.clone(),
            cookies: Some("session=secret".to_string()),
            connections: Some(16),
            ..SpawnPayload::default()
        };
        let origin = reqwest::Url::parse(&source_url).expect("fixture URL");
        let probe = probe_bounded_range_support_local_test(&source_url, &payload, &origin)
            .await
            .expect("range probe");

        assert_eq!(
            probe.final_uri,
            format!("http://127.0.0.1:{port}/final")
        );
        assert_eq!(probe.range_support, BoundedRangeSupport::Supported);
        assert!(probe.credentials_allowed);
        server.abort();
    }

    #[test]
    fn public_probe_transport_failures_are_advisory_but_security_failures_are_fatal() {
        assert!(!is_fatal_range_probe_error("error sending request"));
        assert_eq!(range_probe_error_code("error sending request"), "transport");
        assert_eq!(
            range_probe_error_code("error sending request for https://example.test/file"),
            "transport"
        );
        assert!(is_fatal_range_probe_error("SSRF blocked: Private/local IP not allowed"));
        assert_eq!(
            range_probe_error_code("SSRF blocked: DNS resolution timed out"),
            "timeout"
        );
    }

    #[test]
    fn proxy_route_diagnostics_never_include_proxy_details() {
        assert_eq!(proxy_route_for_log(None), "none");
        assert_eq!(proxy_route_for_log(Some("none")), "disabled");
        assert_eq!(
            proxy_route_for_log(Some("http://user:secret@example.test:8080")),
            "configured"
        );
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
    fn enqueue_item_carries_normal_reliability_policy_into_the_spawn_payload() {
        let item: EnqueueItem = serde_json::from_value(serde_json::json!({
            "id": "normal-reliability",
            "queue_id": "main",
            "url": "https://example.test/file.bin",
            "destination": "/tmp/downloads",
            "filename": "file.bin",
            "minimum_normal_download_speed_kib": 64,
            "retry_not_found_errors": true,
            "adaptive_mirror_selection": false
        }))
        .expect("frontend enqueue payload should deserialize");

        let payload = item.into_task().payload;
        assert_eq!(payload.minimum_normal_download_speed_kib, 64);
        assert!(payload.retry_not_found_errors);
        assert!(!payload.adaptive_mirror_selection);
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

    #[tokio::test]
    async fn internally_created_enqueue_advances_past_cancelled_generation() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let manager = QueueManager::test_new(app.handle().clone(), 1, Arc::new(TestSpawner));

        manager.cancel_enqueue_generation("torrent", 4).await;
        let generation = manager
            .next_enqueue_generation("torrent")
            .await
            .expect("a fresh generation should be available");

        assert_eq!(generation, 5);
        manager
            .reserve_enqueue_generation("torrent", generation)
            .await
            .expect("the fresh generation should not be rejected as stale");
        assert_eq!(manager.registered_lifecycle_generation("torrent").await, Some(5));
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
        assert!(manager
            .capture_seed_remaining("torrent")
            .await
            .is_some());
    }

    #[tokio::test]
    async fn pending_torrent_reconfiguration_restores_position_and_payload() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let manager = QueueManager::test_new(app.handle().clone(), 1, Arc::new(TestSpawner));
        for id in ["first", "target", "last"] {
            manager
                .push(QueuedTask {
                    id: id.to_string(),
                    queue_id: "queue".to_string(),
                    kind: TaskKind::Aria2,
                    lifecycle_generation: 0,
                    payload: SpawnPayload {
                        is_torrent: true,
                        ..Default::default()
                    },
                })
                .await
                .unwrap();
        }

        let (index, mut task) = manager
            .take_pending_task("target")
            .await
            .expect("target remains pending");
        assert_eq!(manager.pending_order(None).await, ["first", "last"]);
        task.payload.torrent_file_indices = Some(vec![2]);
        manager.restore_pending_task(index, task).await;

        assert_eq!(
            manager.pending_order(None).await,
            ["first", "target", "last"]
        );
        let (_, restored) = manager
            .take_pending_task("target")
            .await
            .expect("target was restored");
        assert_eq!(restored.payload.torrent_file_indices, Some(vec![2]));
    }

    #[tokio::test]
    async fn enabling_separate_seed_capacity_counts_existing_seeders() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let manager = QueueManager::test_new(app.handle().clone(), 1, Arc::new(SeedSpawner));
        assert!(manager.ensure_aria2_permit("existing").await);
        manager
            .aria2_payloads
            .lock()
            .await
            .insert(
                "existing".to_string(),
                SpawnPayload {
                    is_torrent: true,
                    torrent_seed_time: Some(5.0),
                    ..Default::default()
                },
            );
        manager
            .remember_gid("existing".to_string(), "gid-existing".to_string())
            .await;
        manager
            .apply_completion("existing", PendingOutcome::Seeding)
            .await;

        assert!(!manager.is_seed_owner("existing"));
        manager.configure_seed_capacity(true, 1);
        assert!(manager.is_seed_owner("existing"));
        assert!(manager.has_active_permit("existing").await);
    }

    #[tokio::test]
    async fn separate_seed_capacity_pauses_fairly_and_rebinds_before_resume() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let manager = Arc::new(QueueManager::test_new(
            app.handle().clone(),
            1,
            Arc::new(SeedSpawner),
        ));
        manager.configure_seed_capacity(true, 1);
        for id in ["first", "second"] {
            manager.reserve_enqueue_generation(id, 0).await.unwrap();
            assert!(manager.ensure_aria2_permit(id).await);
            manager
                .aria2_payloads
                .lock()
                .await
                .insert(
                    id.to_string(),
                    SpawnPayload {
                        is_torrent: true,
                        torrent_seed_time: Some(5.0),
                        ..Default::default()
                    },
                );
            manager
                .remember_gid(id.to_string(), format!("gid-{id}"))
                .await;
            if id == "first" {
                manager
                    .apply_completion(id, PendingOutcome::Seeding)
                    .await;
                assert!(manager.is_seed_owner(id));
                assert!(!manager.has_active_permit(id).await);
            } else {
                manager
                    .apply_completion(id, PendingOutcome::Seeding)
                    .await;
                assert!(manager.is_waiting_to_seed(id));
                assert!(!manager.has_active_permit(id).await);
            }
        }

        manager.release_registered_id("first").await;
        assert!(manager.try_start_waiting_seed().await);
        let result = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if manager.is_seed_owner("second") && !manager.is_waiting_to_seed("second") {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        assert!(result.is_ok(), "waiting seed did not resume after capacity was released");
        assert!(!manager.has_active_permit("second").await);
        assert_eq!(manager.current_aria2_control_epoch("second").await, 1);
    }

    #[tokio::test]
    async fn ambiguous_seed_resume_retries_without_stranding_the_seed_permit() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let spawner = Arc::new(AmbiguousResumeSeedSpawner {
            resume_calls: Arc::new(AtomicUsize::new(0)),
        });
        let manager = Arc::new(QueueManager::test_new(
            app.handle().clone(),
            1,
            spawner.clone(),
        ));
        manager.configure_seed_capacity(true, 1);
        for id in ["first", "second"] {
            manager.reserve_enqueue_generation(id, 0).await.unwrap();
            assert!(manager.ensure_aria2_permit(id).await);
            manager
                .aria2_payloads
                .lock()
                .await
                .insert(
                    id.to_string(),
                    SpawnPayload {
                        is_torrent: true,
                        torrent_seed_time: Some(5.0),
                        ..Default::default()
                    },
                );
            manager
                .remember_gid(id.to_string(), format!("gid-{id}"))
                .await;
            manager
                .apply_completion(id, PendingOutcome::Seeding)
                .await;
        }

        assert!(manager.is_waiting_to_seed("second"));
        manager.release_registered_id("first").await;
        assert!(manager.try_start_waiting_seed().await);

        let first_attempt = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if spawner.resume_calls.load(Ordering::SeqCst) >= 1
                    && manager.has_active_permit("second").await
                    && manager.is_waiting_to_seed("second")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        assert!(first_attempt.is_ok(), "ambiguous seed resume was not retained safely");

        manager.wake_seed_waiters();
        let recovered = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if spawner.resume_calls.load(Ordering::SeqCst) >= 2
                    && manager.is_seed_owner("second")
                    && !manager.is_waiting_to_seed("second")
                    && !manager.has_active_permit("second").await
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        assert!(
            recovered.is_ok(),
            "ambiguous seed resume did not reconcile after the daemon became reachable"
        );
        assert_eq!(manager.current_aria2_control_epoch("second").await, 1);
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

    #[tokio::test]
    async fn stale_aria2_connection_options_cannot_overwrite_a_newer_epoch() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let manager = QueueManager::test_new(app.handle().clone(), 1, Arc::new(TestSpawner));
        let first_epoch = manager.next_aria2_control_epoch("download").await;

        manager
            .set_aria2_connection_options("download", first_epoch, 1)
            .await;
        assert_eq!(
            manager
                .aria2_effective_connections("download", first_epoch)
                .await,
            Some(1)
        );

        let second_epoch = manager.next_aria2_control_epoch("download").await;
        assert_eq!(
            manager
                .aria2_effective_connections("download", second_epoch)
                .await,
            None
        );
        manager
            .set_aria2_connection_options("download", second_epoch, 4)
            .await;
        manager
            .set_aria2_connection_options("download", first_epoch, 1)
            .await;
        assert_eq!(
            manager
                .aria2_effective_connections("download", second_epoch)
                .await,
            Some(4)
        );
    }

    #[test]
    fn aria2_add_uri_uses_the_prepared_attempt_uris() {
        let prepared = vec!["https://cdn.example.test/signed-attempt".to_string()];
        let source = "https://downloads.example.test/stable-source";
        let params = aria2_add_uri_params(prepared.clone(), serde_json::Map::new());

        assert_eq!(params[0], serde_json::json!(prepared));
        assert_ne!(params[0], serde_json::json!([source]));
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
    fn bounded_range_probe_treats_expanded_response_as_unknown() {
        assert_eq!(
            classify_bounded_range_response(
                reqwest::StatusCode::PARTIAL_CONTENT,
                Some("bytes 0-383882117/383882118"),
            ),
            BoundedRangeSupport::Unknown
        );
    }

    #[test]
    fn bounded_range_probe_treats_ignored_range_request_as_unknown() {
        assert_eq!(
            classify_bounded_range_response(reqwest::StatusCode::OK, None),
            BoundedRangeSupport::Unknown
        );
    }

    #[test]
    fn bounded_range_probe_classifies_explicit_range_rejection() {
        assert_eq!(
            classify_bounded_range_response(reqwest::StatusCode::RANGE_NOT_SATISFIABLE, None),
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
    fn optional_not_found_and_low_speed_retries_use_the_firelink_budget() {
        let not_found = "aria2 error code 3: Resource not found";
        let low_speed = "aria2 error code 5: Download speed is too slow";

        assert_eq!(
            aria2_retry_action(&SpawnPayload::default(), not_found, 0),
            Aria2RetryAction::Terminal
        );
        assert_eq!(
            aria2_retry_action(
                &SpawnPayload {
                    retry_not_found_errors: true,
                    max_tries: Some(1),
                    ..SpawnPayload::default()
                },
                not_found,
                0,
            ),
            Aria2RetryAction::OrdinaryRetry
        );
        assert_eq!(
            aria2_retry_action(
                &SpawnPayload {
                    retry_not_found_errors: true,
                    max_tries: Some(1),
                    ..SpawnPayload::default()
                },
                not_found,
                1,
            ),
            Aria2RetryAction::Terminal
        );
        assert_eq!(
            aria2_retry_action(&SpawnPayload::default(), low_speed, 0),
            Aria2RetryAction::Terminal
        );
        assert_eq!(
            aria2_retry_action(
                &SpawnPayload {
                    minimum_normal_download_speed_kib: 1,
                    max_tries: Some(1),
                    ..SpawnPayload::default()
                },
                low_speed,
                0,
            ),
            Aria2RetryAction::OrdinaryRetry
        );
        assert_eq!(
            aria2_retry_action(
                &SpawnPayload {
                    is_torrent: true,
                    minimum_normal_download_speed_kib: 1,
                    retry_not_found_errors: true,
                    max_tries: Some(1),
                    ..SpawnPayload::default()
                },
                low_speed,
                0,
            ),
            Aria2RetryAction::Terminal
        );
    }

    #[test]
    fn aria2_name_resolution_error_stays_on_bounded_retry_path() {
        let error = "aria2 error code 19: Name resolution for example.test failed: Could not contact DNS servers.";
        assert!(is_retryable_aria2_error(error));
        assert_eq!(
            aria2_retry_action(
                &SpawnPayload {
                    max_tries: Some(1),
                    ..Default::default()
                },
                error,
                0,
            ),
            Aria2RetryAction::OrdinaryRetry
        );
        assert_eq!(
            aria2_retry_action(
                &SpawnPayload {
                    max_tries: Some(0),
                    ..Default::default()
                },
                error,
                0,
            ),
            Aria2RetryAction::Terminal
        );
    }

    #[test]
    fn aria2_startup_rpc_errors_are_retryable() {
        assert!(is_aria2_rpc_unavailable(
            "error trying to connect: tcp connect error: Connection refused"
        ));
        assert!(is_aria2_rpc_unavailable(
            "aria2 did not become ready: connection refused"
        ));
        assert!(is_aria2_rpc_unavailable("aria2 daemon is not ready"));
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

    #[test]
    fn torrent_availability_aggregates_local_and_peer_copies_without_exposing_bitfields() {
        let snapshot = parse_torrent_availability(
            serde_json::json!({ "numPieces": "4", "bitfield": "f0" }),
            serde_json::json!([
                { "bitfield": "30", "ip": "192.0.2.1" }
            ]),
        )
        .expect("availability should parse");
        assert_eq!(snapshot.piece_count, 4);
        assert_eq!(snapshot.connected_peers, 1);
        assert!((snapshot.availability - 1.5).abs() < f64::EPSILON);
        assert_eq!(snapshot.buckets.len(), 4);
        assert_eq!(snapshot.buckets[0].minimum_copies, 1);
    }

    #[test]
    fn torrent_availability_rejects_malformed_and_overflow_bitfields() {
        assert!(parse_torrent_availability(
            serde_json::json!({ "numPieces": "4", "bitfield": "f1" }),
            serde_json::json!([]),
        )
        .is_err());
        let snapshot = parse_torrent_availability(
            serde_json::json!({ "numPieces": "4", "bitfield": "f0" }),
            serde_json::json!([{ "bitfield": "0" }]),
        )
        .expect("malformed peer data should be omitted");
        assert_eq!(snapshot.connected_peers, 1);
        assert_eq!(snapshot.availability, 1.0);
    }

    #[test]
    fn torrent_availability_ignores_peers_before_their_bitfield_handshake() {
        let snapshot = parse_torrent_availability(
            serde_json::json!({ "numPieces": "4", "bitfield": "f0" }),
            serde_json::json!([
                { "ip": "192.0.2.1" },
                { "bitfield": "30" }
            ]),
        )
        .expect("a peer without a handshake bitfield is not malformed");
        assert_eq!(snapshot.connected_peers, 2);
        assert!((snapshot.availability - 1.5).abs() < f64::EPSILON);
    }

    #[test]
    fn torrent_telemetry_counts_only_monotonic_upload_deltas() {
        let start = Instant::now();
        let mut state = TorrentTelemetryState::new("gid-1", 7, start);
        assert_eq!(
            state.observe("gid-1", 7, Some(100), false, start),
            TorrentTelemetrySnapshot {
                uploaded_bytes: 0,
                seeded_seconds: 0
            }
        );
        assert_eq!(
            state.observe(
                "gid-1",
                7,
                Some(180),
                false,
                start + Duration::from_secs(1)
            )
            .uploaded_bytes,
            80
        );
        // A daemon counter reset establishes a new baseline and contributes
        // no bytes from the reset itself.
        assert_eq!(
            state.observe(
                "gid-1",
                7,
                Some(12),
                false,
                start + Duration::from_secs(2)
            )
            .uploaded_bytes,
            80
        );
        assert_eq!(
            state.observe(
                "gid-1",
                7,
                Some(20),
                false,
                start + Duration::from_secs(3)
            )
            .uploaded_bytes,
            88
        );
    }

    #[test]
    fn torrent_telemetry_restarts_baseline_on_gid_or_epoch_replacement() {
        let start = Instant::now();
        let mut state = TorrentTelemetryState::new("gid-1", 1, start);
        state.observe("gid-1", 1, Some(500), false, start);
        state.observe("gid-1", 1, Some(525), false, start + Duration::from_secs(1));
        let snapshot = state.observe("gid-2", 2, Some(4), false, start + Duration::from_secs(2));
        assert_eq!(snapshot.uploaded_bytes, 25);
        assert_eq!(
            state.observe("gid-2", 2, Some(9), false, start + Duration::from_secs(3))
                .uploaded_bytes,
            30
        );
    }

    #[test]
    fn torrent_telemetry_closes_the_previous_seed_interval_on_lifecycle_replacement() {
        let start = Instant::now();
        let mut state = TorrentTelemetryState::new("gid-1", 1, start);
        state.observe("gid-1", 1, Some(0), true, start);
        let snapshot = state.observe("gid-2", 2, Some(4), false, start + Duration::from_secs(3));
        assert_eq!(snapshot.seeded_seconds, 3);
        assert_eq!(snapshot.uploaded_bytes, 0);
    }

    #[test]
    fn torrent_telemetry_counts_seed_seconds_only_for_the_previous_seed_interval() {
        let start = Instant::now();
        let mut state = TorrentTelemetryState::new("gid-1", 1, start);
        state.observe("gid-1", 1, Some(0), true, start);
        assert_eq!(
            state.observe(
                "gid-1",
                1,
                Some(10),
                true,
                start + Duration::from_secs(4)
            )
            .seeded_seconds,
            4
        );
        assert_eq!(
            state.observe(
                "gid-1",
                1,
                Some(10),
                false,
                start + Duration::from_secs(9)
            )
            .seeded_seconds,
            9
        );
    }

    #[test]
    fn torrent_telemetry_caps_long_observer_gaps() {
        let start = Instant::now();
        let mut state = TorrentTelemetryState::new("gid-1", 1, start);
        state.observe("gid-1", 1, Some(0), true, start);
        let snapshot = state.observe(
            "gid-1",
            1,
            Some(1),
            true,
            start + Duration::from_secs(MAX_TORRENT_SEED_ACCOUNTING_INTERVAL_SECS + 3600),
        );
        assert_eq!(
            snapshot.seeded_seconds,
            MAX_TORRENT_SEED_ACCOUNTING_INTERVAL_SECS
        );
    }
}

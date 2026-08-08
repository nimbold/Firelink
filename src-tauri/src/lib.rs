#![allow(unexpected_cfgs)]

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use futures_util::StreamExt;
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::ffi::OsStr;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use ts_rs::TS;

pub(crate) fn ensure_reqwest_crypto_provider() {
    static INSTALL: OnceLock<()> = OnceLock::new();
    INSTALL.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn sanitize_metadata_filename(filename: &str) -> Option<String> {
    let normalized = filename.trim().replace('\\', "/");
    let basename = std::path::Path::new(&normalized)
        .file_name()?
        .to_str()?
        .trim()
        .trim_end_matches(['.', ' ']);

    if basename.is_empty() || basename == "." || basename == ".." || basename.len() > 255 {
        return None;
    }

    Some(basename.to_string())
}

fn percent_decode_metadata_value(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let hex_value = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    };

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (
                hex_value(bytes[index + 1]),
                hex_value(bytes[index + 2]),
            ) {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }

        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8(decoded).ok()
}

fn filename_from_content_disposition(disposition: &str) -> Option<String> {
    let mut fallback = None;

    for part in disposition.split(';').map(str::trim) {
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        let normalized_name = name.trim().to_ascii_lowercase();
        let raw_value = value.trim().trim_matches('"').trim_matches('\'');

        if normalized_name == "filename*" {
            let encoded = raw_value
                .split_once("''")
                .map(|(_, value)| value)
                .unwrap_or(raw_value);
            if let Some(filename) = percent_decode_metadata_value(encoded)
                .and_then(|value| sanitize_metadata_filename(&value))
            {
                return Some(filename);
            }
        } else if normalized_name == "filename" {
            fallback = sanitize_metadata_filename(raw_value);
        }
    }

    fallback
}

fn filename_from_url_disposition_query(raw_url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(raw_url).ok()?;

    for (name, value) in parsed.query_pairs() {
        if name.eq_ignore_ascii_case("response-content-disposition")
            || name.eq_ignore_ascii_case("rscd")
        {
            if let Some(filename) = filename_from_content_disposition(&value) {
                return Some(filename);
            }
        }
    }

    None
}

fn filename_from_url_path(raw_url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(raw_url).ok()?;
    let last = parsed.path_segments()?.next_back()?;
    // URL path segments retain their percent-encoded representation. Decode
    // before applying the same filename sanitization used by header metadata.
    // If the escape sequence cannot form valid UTF-8, retain the raw segment
    // so a malformed URL cannot erase an otherwise usable filename.
    let decoded = percent_decode_metadata_value(last).unwrap_or_else(|| last.to_string());
    let filename = sanitize_metadata_filename(&decoded)?;
    let is_gmail_profile_path = parsed.host_str() == Some("mail.google.com")
        && parsed.path().contains("/mail/u/");
    let is_gmail_profile_number = is_gmail_profile_path
        && filename.chars().all(|character| character.is_ascii_digit());
    (!is_weak_url_filename(&filename) && !is_gmail_profile_number).then_some(filename)
}

fn is_weak_url_filename(filename: &str) -> bool {
    let normalized = filename.trim().to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "identifier" | "download" | "view" | "uc"
    )
}

fn metadata_filename_from_response(
    response: &reqwest::Response,
    current_url: &str,
    original_url: &str,
) -> String {
    if let Some(filename) = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .and_then(filename_from_content_disposition)
        .filter(|filename| !is_weak_url_filename(filename))
    {
        return filename;
    }

    filename_from_url_disposition_query(current_url)
        .filter(|filename| !is_weak_url_filename(filename))
        .or_else(|| filename_from_url_path(original_url))
        .or_else(|| filename_from_url_path(current_url))
        .unwrap_or_else(|| "download".to_string())
}

fn metadata_response_error(status: reqwest::StatusCode) -> Option<String> {
    (!status.is_success()).then(|| {
        format!(
            "Metadata request failed with HTTP {} ({})",
            status.as_u16(),
            status.canonical_reason().unwrap_or("unknown status")
        )
    })
}

fn metadata_cookie_header_present(
    headers: Option<&str>,
    cookies: Option<&str>,
    cookie_scopes: Option<&[extension_server::ExtensionCookieScope]>,
) -> bool {
    cookies.is_some_and(|value| !value.trim().is_empty())
        || headers.is_some_and(|value| {
            value.lines().any(|line| {
                let Some((name, value)) = line.split_once(':') else {
                    return false;
                };
                name.trim().eq_ignore_ascii_case("cookie") && !value.trim().is_empty()
            })
        })
        || cookie_scopes.is_some_and(|scopes| {
            scopes.iter().any(|scope| !scope.cookies.trim().is_empty())
        })
}

fn metadata_headers(
    headers: Option<&str>,
    cookie_header: Option<&str>,
    include_cookies: bool,
) -> reqwest::header::HeaderMap {
    let mut header_map = reqwest::header::HeaderMap::new();

    if let Some(headers) = headers {
        for line in headers.lines() {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            let Ok(name) = reqwest::header::HeaderName::from_bytes(name.trim().as_bytes()) else {
                continue;
            };
            if name == reqwest::header::COOKIE && !include_cookies {
                continue;
            }
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            let Ok(value) = reqwest::header::HeaderValue::from_str(value) else {
                continue;
            };
            header_map.insert(name, value);
        }
    }

    if include_cookies {
        if let Some(cookie_header) = cookie_header
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if let Ok(value) = reqwest::header::HeaderValue::from_str(cookie_header) {
                header_map.insert(reqwest::header::COOKIE, value);
            }
        }
    }

    header_map
}

fn should_retry_metadata_with_cookies(
    status: reqwest::StatusCode,
    cookies_available: bool,
    cookie_retry_attempted: bool,
) -> bool {
    cookies_available
        && !cookie_retry_attempted
        && matches!(
            status,
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
        )
}

fn retry_metadata_with_cookies(
    status: reqwest::StatusCode,
    cookies_available: bool,
    send_cookies: &mut bool,
    cookie_retry_attempted: &mut bool,
    original_url: &str,
    current_url: &mut String,
    redirects: &mut usize,
) -> bool {
    if !should_retry_metadata_with_cookies(
        status,
        cookies_available && !*send_cookies,
        *cookie_retry_attempted,
    ) {
        return false;
    }

    // A cookie retry is a new, bounded resolution pass. Keep the retry
    // itself one-shot, while giving the authenticated pass the same redirect
    // budget as the initial unauthenticated pass.
    *send_cookies = true;
    *cookie_retry_attempted = true;
    current_url.clear();
    current_url.push_str(original_url);
    *redirects = 0;
    true
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct MetadataResponse {
    // Keep the caller's durable source URL here. Resolved redirect targets
    // can be short-lived signed URLs and must not become download identity.
    url: String,
    filename: String,
    size: String,
    #[ts(type = "number")]
    size_bytes: u64,
    resumable: bool,
}

#[derive(Debug, Serialize, serde::Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct MediaFormat {
    pub format_id: String,
    pub resolution: String,
    pub ext: String,
    pub format_label: String,
    #[ts(type = "number | null")]
    pub fps: Option<f64>,
    #[ts(type = "number | null")]
    pub filesize: Option<u64>,
    #[ts(type = "number | null")]
    pub filesize_approx: Option<u64>,
}

#[derive(Debug, Serialize, serde::Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct MediaMetadata {
    pub title: String,
    #[ts(type = "number | null")]
    pub duration: Option<u64>,
    pub thumbnail: Option<String>,
    pub formats: Vec<MediaFormat>,
}

#[derive(Debug, Serialize, serde::Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct MediaPlaylistEntry {
    pub id: String,
    pub url: String,
    pub title: String,
    #[ts(type = "number | null")]
    pub playlist_index: Option<u64>,
}

#[derive(Debug, Serialize, serde::Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct MediaPlaylistMetadata {
    pub title: String,
    pub playlist_id: Option<String>,
    #[ts(type = "number | null")]
    pub entry_count: Option<u64>,
    #[ts(type = "number")]
    pub skipped_entries: u64,
    pub truncated: bool,
    pub entries: Vec<MediaPlaylistEntry>,
}

const MEDIA_PLAYLIST_MAX_ENTRIES: usize = 1000;

fn parse_media_playlist_metadata(
    value: &serde_json::Value,
    max_entries: usize,
) -> Result<MediaPlaylistMetadata, String> {
    let raw_entries = value
        .get("entries")
        .and_then(|entries| entries.as_array())
        .ok_or_else(|| "yt-dlp did not return playlist entries".to_string())?;
    let entry_count = value.get("playlist_count").and_then(|count| count.as_u64());
    let playlist_title = value
        .get("title")
        .and_then(|title| title.as_str())
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("YouTube playlist")
        .trim()
        .to_string();
    let playlist_id = value
        .get("id")
        .and_then(|id| id.as_str())
        .map(|value| value.trim())
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned);

    let mut seen_urls = HashSet::new();
    let mut entries = Vec::new();
    let mut skipped_entries = 0_u64;

    for (position, entry) in raw_entries.iter().enumerate() {
        let candidate_url = ["webpage_url", "url"].iter().find_map(|key| {
            entry
                .get(*key)
                .and_then(|url| url.as_str())
                .map(str::trim)
                .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
        });
        let Some(url) = candidate_url else {
            skipped_entries += 1;
            continue;
        };
        let url = url.to_string();
        if !seen_urls.insert(url.clone()) {
            skipped_entries += 1;
            continue;
        }
        if entries.len() >= max_entries {
            continue;
        }

        let id = entry
            .get("id")
            .and_then(|id| id.as_str())
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .unwrap_or(&url)
            .to_string();
        let title = entry
            .get("title")
            .and_then(|title| title.as_str())
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or("Untitled video")
            .to_string();
        let playlist_index = entry
            .get("playlist_index")
            .and_then(|index| index.as_u64())
            .or(Some((position + 1) as u64));

        entries.push(MediaPlaylistEntry {
            id,
            url,
            title,
            playlist_index,
        });
    }

    let truncated = raw_entries.len() > max_entries
        || entry_count.is_some_and(|count| count > max_entries as u64);
    if let Some(count) = entry_count {
        skipped_entries = skipped_entries.max(count.saturating_sub(entries.len() as u64));
    } else {
        skipped_entries = skipped_entries.max(
            raw_entries
                .len()
                .saturating_sub(entries.len())
                .try_into()
                .unwrap_or(u64::MAX),
        );
    }

    if entries.is_empty() {
        return Err("yt-dlp returned no usable entries for this playlist".to_string());
    }

    Ok(MediaPlaylistMetadata {
        title: playlist_title,
        playlist_id,
        entry_count,
        skipped_entries,
        truncated,
        entries,
    })
}

fn is_media_processing_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("[merger]")
        || lower.contains("[extractaudio]")
        || lower.contains("[ffmpeg]")
        || lower.contains("[videoconvertor]")
        || lower.contains("[fixup")
        || lower.contains("merging formats")
        || lower.contains("post-process")
}

fn media_output_template(
    resolved_dest: &std::path::Path,
    safe_filename: &str,
    format_selector: Option<&str>,
) -> std::path::PathBuf {
    if format_selector.is_none() && std::path::Path::new(safe_filename).extension().is_none() {
        resolved_dest.join("%(title).200B [%(id)s].%(ext)s")
    } else {
        resolved_dest.join(safe_filename)
    }
}

fn media_progress_args() -> Vec<String> {
    vec![
        "--newline".to_string(),
        "--progress".to_string(),
        "--progress-delta".to_string(),
        "0.2".to_string(),
        "--progress-template".to_string(),
        format!("download:{MEDIA_PROGRESS_PREFIX}%(progress)j"),
    ]
}

fn json_str<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(|value| value.trim())
        .filter(|v| !v.is_empty())
}

fn json_lower(value: &serde_json::Value, key: &str) -> String {
    json_str(value, key).unwrap_or_default().to_lowercase()
}

fn json_u64(value: &serde_json::Value, key: &str) -> Option<u64> {
    value
        .get(key)
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
}

fn json_f64(value: &serde_json::Value, key: &str) -> Option<f64> {
    value.get(key).and_then(|v| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
    })
}

fn media_filesize(value: &serde_json::Value) -> Option<u64> {
    json_u64(value, "filesize").or_else(|| json_u64(value, "filesize_approx"))
}

fn media_exact_filesize(value: &serde_json::Value) -> Option<u64> {
    json_u64(value, "filesize")
}

fn media_approx_filesize(value: &serde_json::Value) -> Option<u64> {
    media_exact_filesize(value)
        .is_none()
        .then(|| json_u64(value, "filesize_approx"))
        .flatten()
}

fn media_sized_bytes(value: &serde_json::Value) -> Option<(u64, bool)> {
    if let Some(size) = media_exact_filesize(value) {
        Some((size, false))
    } else {
        media_approx_filesize(value).map(|size| (size, true))
    }
}

fn estimated_stream_bytes(
    value: &serde_json::Value,
    duration_seconds: Option<f64>,
) -> Option<(u64, bool)> {
    if let Some(size) = media_sized_bytes(value) {
        return Some(size);
    }

    let duration_seconds = duration_seconds.filter(|duration| *duration > 0.0)?;
    let bitrate_kbps = if has_video_stream(value) && !has_audio_stream(value) {
        json_f64(value, "vbr").or_else(|| json_f64(value, "tbr"))
    } else if has_audio_stream(value) && !has_video_stream(value) {
        json_f64(value, "abr").or_else(|| json_f64(value, "tbr"))
    } else {
        json_f64(value, "tbr")
    }
    .filter(|bitrate| *bitrate > 0.0)?;

    let bytes = bitrate_kbps * 1_000.0 * duration_seconds / 8.0;
    (bytes.is_finite() && bytes > 0.0).then_some((bytes.round() as u64, true))
}

fn split_size_estimate(bytes: Option<(u64, bool)>) -> (Option<u64>, Option<u64>) {
    match bytes {
        Some((bytes, false)) => (Some(bytes), None),
        Some((bytes, true)) => (None, Some(bytes)),
        None => (None, None),
    }
}

fn codec_is_present(codec: Option<&str>) -> bool {
    codec
        .map(str::trim)
        .filter(|codec| !codec.is_empty())
        .map(|codec| codec.to_lowercase() != "none")
        .unwrap_or(false)
}

fn has_video_stream(value: &serde_json::Value) -> bool {
    codec_is_present(json_str(value, "vcodec"))
}

fn has_audio_stream(value: &serde_json::Value) -> bool {
    codec_is_present(json_str(value, "acodec"))
}

fn is_excluded_yt_dlp_format(value: &serde_json::Value) -> bool {
    let ext = json_lower(value, "ext");
    let protocol = json_lower(value, "protocol");
    if ext == "mhtml" || protocol.contains("mhtml") {
        return true;
    }

    for key in ["format_note", "format", "format_id", "protocol"] {
        let text = json_lower(value, key);
        if text.contains("storyboard")
            || text.contains("thumbnail")
            || text.contains("subtitle")
            || text.contains("subtitles")
        {
            return true;
        }
    }

    !(has_video_stream(value) || has_audio_stream(value))
}

fn format_height(value: &serde_json::Value) -> Option<u64> {
    if let Some(height) = json_u64(value, "height").filter(|height| *height > 0) {
        return Some(height);
    }

    if let Some(resolution) = json_str(value, "resolution") {
        if let Some((_, height)) = resolution
            .split_once('x')
            .or_else(|| resolution.split_once('X'))
        {
            if let Ok(parsed) = height.trim().parse::<u64>() {
                if parsed > 0 {
                    return Some(parsed);
                }
            }
        }
    }

    let note = json_lower(value, "format_note");
    let bytes = note.as_bytes();
    let mut heights = Vec::new();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'p' || index == 0 {
            continue;
        }
        let mut start = index;
        while start > 0 && bytes[start - 1].is_ascii_digit() {
            start -= 1;
        }
        if start < index {
            if let Ok(height) = note[start..index].parse::<u64>() {
                if height > 0 {
                    heights.push(height);
                }
            }
        }
    }
    heights.into_iter().max()
}

fn matches_media_height(value: &serde_json::Value, target: u64) -> bool {
    if !has_video_stream(value) {
        return false;
    }

    format_height(value) == Some(target)
}

fn format_score(value: &serde_json::Value) -> u64 {
    let height_score = format_height(value).unwrap_or(0).saturating_mul(1_000_000);
    let bitrate_score = json_f64(value, "tbr").unwrap_or(0.0).max(0.0) as u64 * 1_000;
    let size_score = media_filesize(value).unwrap_or(0).min(999);
    height_score + bitrate_score + size_score
}

fn best_matching_format<'a, F>(
    formats: &'a [&'a serde_json::Value],
    predicate: F,
) -> Option<&'a serde_json::Value>
where
    F: Fn(&serde_json::Value) -> bool,
{
    formats
        .iter()
        .copied()
        .filter(|format| predicate(format))
        .max_by_key(|format| format_score(format))
}

fn best_audio_format<'a>(
    formats: &'a [&'a serde_json::Value],
    ext: Option<&str>,
) -> Option<&'a serde_json::Value> {
    best_matching_format(formats, |format| {
        if !has_audio_stream(format) || has_video_stream(format) {
            return false;
        }
        ext.map(|wanted| json_lower(format, "ext") == wanted)
            .unwrap_or(true)
    })
}

fn display_codec(codec: Option<&str>, fallback: &str) -> String {
    let Some(codec) = codec.map(str::trim).filter(|codec| !codec.is_empty()) else {
        return fallback.to_string();
    };

    let lower = codec.to_lowercase();
    if lower == "none" {
        return fallback.to_string();
    }

    if lower.starts_with("avc1") || lower.contains("h264") {
        "H.264".to_string()
    } else if lower.starts_with("av01") {
        "AV1".to_string()
    } else if lower.starts_with("vp09") || lower.starts_with("vp9") {
        "VP9".to_string()
    } else if lower.starts_with("vp8") {
        "VP8".to_string()
    } else if lower.starts_with("hev1")
        || lower.starts_with("hvc1")
        || lower.contains("h265")
        || lower.contains("hevc")
    {
        "H.265".to_string()
    } else if lower.starts_with("mp4a") || lower.contains("aac") {
        "AAC".to_string()
    } else if lower.contains("opus") {
        "Opus".to_string()
    } else if lower.contains("vorbis") {
        "Vorbis".to_string()
    } else if lower.contains("mp3") {
        "MP3".to_string()
    } else {
        fallback.to_string()
    }
}

fn joined_format_label(
    container: &str,
    video_codec: Option<&str>,
    audio_codec: Option<&str>,
) -> String {
    let mut codecs = Vec::new();
    if video_codec.is_some() {
        codecs.push(display_codec(video_codec, "Video"));
    }
    if audio_codec.is_some() {
        codecs.push(display_codec(audio_codec, "Audio"));
    }

    if codecs.is_empty() {
        container.to_uppercase()
    } else {
        format!("{} • {}", container.to_uppercase(), codecs.join(" + "))
    }
}

fn selected_format_id(
    video: Option<&serde_json::Value>,
    audio: Option<&serde_json::Value>,
) -> Option<String> {
    match (
        video.and_then(|format| json_str(format, "format_id")),
        audio.and_then(|format| json_str(format, "format_id")),
    ) {
        (Some(video_id), Some(audio_id)) if video_id != audio_id => {
            Some(format!("{video_id}+{audio_id}"))
        }
        (Some(video_id), _) => Some(video_id.to_string()),
        (None, Some(audio_id)) => Some(audio_id.to_string()),
        (None, None) => None,
    }
}

fn estimated_merged_size(
    video: Option<&serde_json::Value>,
    audio: Option<&serde_json::Value>,
    duration_seconds: Option<f64>,
) -> (Option<u64>, Option<u64>) {
    let video_has_audio = video.is_some_and(has_audio_stream);
    let v_bytes = video.and_then(|format| estimated_stream_bytes(format, duration_seconds));
    let a_bytes = if video_has_audio {
        None
    } else {
        audio.and_then(|format| estimated_stream_bytes(format, duration_seconds))
    };

    match (video, audio, v_bytes, a_bytes, video_has_audio) {
        (Some(_), _, Some((v_size, v_approx)), _, true) => {
            split_size_estimate(Some((v_size, v_approx)))
        }
        (Some(_), Some(_), Some((v_size, v_approx)), Some((a_size, a_approx)), false) => {
            split_size_estimate(Some((v_size.saturating_add(a_size), v_approx || a_approx)))
        }
        (Some(_), None, Some((v_size, v_approx)), None, false) => {
            split_size_estimate(Some((v_size, v_approx)))
        }
        (None, Some(_), None, Some((a_size, a_approx)), false) => {
            split_size_estimate(Some((a_size, a_approx)))
        }
        _ => (None, None),
    }
}

fn raw_media_format(
    value: &serde_json::Value,
    duration_seconds: Option<f64>,
) -> Option<MediaFormat> {
    let format_id = json_str(value, "format_id")?.to_string();
    let ext = json_str(value, "ext").unwrap_or("mkv").to_string();
    let fps = json_f64(value, "fps");
    let (filesize, filesize_approx) =
        split_size_estimate(estimated_stream_bytes(value, duration_seconds));

    let resolution = if has_video_stream(value) {
        format_height(value)
            .map(|height| format!("{height}p"))
            .or_else(|| json_str(value, "resolution").map(ToOwned::to_owned))
            .unwrap_or_else(|| "Video".to_string())
    } else {
        "Audio only".to_string()
    };

    let format_label = if has_video_stream(value) && has_audio_stream(value) {
        joined_format_label(&ext, json_str(value, "vcodec"), json_str(value, "acodec"))
    } else if has_video_stream(value) {
        joined_format_label(&ext, json_str(value, "vcodec"), None)
    } else {
        joined_format_label(&ext, None, json_str(value, "acodec"))
    };

    Some(MediaFormat {
        format_id,
        resolution,
        ext,
        format_label,
        fps,
        filesize,
        filesize_approx,
    })
}

fn build_media_format_options(
    formats_arr: &[serde_json::Value],
    duration_seconds: Option<f64>,
) -> Vec<MediaFormat> {
    let clean_formats: Vec<&serde_json::Value> = formats_arr
        .iter()
        .filter(|format| !is_excluded_yt_dlp_format(format))
        .collect();
    let has_video = clean_formats.iter().any(|format| has_video_stream(format));
    let has_audio = clean_formats.iter().any(|format| has_audio_stream(format));
    let mut options = Vec::new();

    if has_video {
        let available_heights: Vec<u64> = clean_formats
            .iter()
            .filter(|format| has_video_stream(format))
            .filter_map(|format| format_height(format))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .rev()
            .collect();

        for height in available_heights {
            if let Some(video) = best_matching_format(&clean_formats, |format| {
                has_video_stream(format) && matches_media_height(format, height)
            }) {
                let audio = if has_audio_stream(video) {
                    None
                } else {
                    best_audio_format(&clean_formats, None)
                };
                let (filesize, filesize_approx) =
                    estimated_merged_size(Some(video), audio, duration_seconds);
                options.push(MediaFormat {
                    format_id: selected_format_id(Some(video), audio).unwrap_or_else(|| {
                        format!("bestvideo[height<={height}]+bestaudio/best[height<={height}]")
                    }),
                    resolution: format!("{height}p"),
                    ext: "mkv".to_string(),
                    format_label: joined_format_label(
                        "mkv",
                        json_str(video, "vcodec"),
                        audio.and_then(|format| json_str(format, "acodec")),
                    ),
                    fps: json_f64(video, "fps"),
                    filesize,
                    filesize_approx,
                });
            }

            if let Some(video) = best_matching_format(&clean_formats, |format| {
                has_video_stream(format)
                    && matches_media_height(format, height)
                    && json_lower(format, "ext") == "mp4"
            }) {
                let audio = if has_audio_stream(video) {
                    None
                } else {
                    best_audio_format(&clean_formats, Some("m4a"))
                        .or_else(|| best_audio_format(&clean_formats, None))
                };
                let (filesize, filesize_approx) =
                    estimated_merged_size(Some(video), audio, duration_seconds);
                options.push(MediaFormat {
                    format_id: selected_format_id(Some(video), audio).unwrap_or_else(|| {
                        format!("bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/best[height<={height}][ext=mp4]/bestvideo[height<={height}]+bestaudio/best[height<={height}]")
                    }),
                    resolution: format!("{height}p"),
                    ext: "mp4".to_string(),
                    format_label: joined_format_label("mp4", json_str(video, "vcodec"), audio.and_then(|format| json_str(format, "acodec"))),
                    fps: json_f64(video, "fps"),
                    filesize,
                    filesize_approx,
                });
            }

            if let Some(video) = best_matching_format(&clean_formats, |format| {
                has_video_stream(format)
                    && matches_media_height(format, height)
                    && json_lower(format, "ext") == "webm"
            }) {
                let audio = if has_audio_stream(video) {
                    None
                } else {
                    best_audio_format(&clean_formats, Some("webm"))
                        .or_else(|| best_audio_format(&clean_formats, Some("opus")))
                        .or_else(|| best_audio_format(&clean_formats, None))
                };
                let (filesize, filesize_approx) =
                    estimated_merged_size(Some(video), audio, duration_seconds);
                options.push(MediaFormat {
                    format_id: selected_format_id(Some(video), audio).unwrap_or_else(|| {
                        format!("bestvideo[height<={height}][ext=webm]+bestaudio[ext=webm]/best[height<={height}][ext=webm]/bestvideo[height<={height}]+bestaudio/best[height<={height}]")
                    }),
                    resolution: format!("{height}p"),
                    ext: "webm".to_string(),
                    format_label: joined_format_label("webm", json_str(video, "vcodec"), audio.and_then(|format| json_str(format, "acodec"))),
                    fps: json_f64(video, "fps"),
                    filesize,
                    filesize_approx,
                });
            }
        }
    }

    if has_audio {
        if let Some(audio) = best_audio_format(&clean_formats, Some("m4a")) {
            let (filesize, filesize_approx) =
                split_size_estimate(estimated_stream_bytes(audio, duration_seconds));
            options.push(MediaFormat {
                format_id: json_str(audio, "format_id")
                    .unwrap_or("bestaudio[ext=m4a]/bestaudio/best")
                    .to_string(),
                resolution: "Audio only".to_string(),
                ext: "m4a".to_string(),
                format_label: joined_format_label("m4a", None, json_str(audio, "acodec")),
                fps: None,
                filesize,
                filesize_approx,
            });
        }

        if let Some(audio) = best_audio_format(&clean_formats, Some("webm"))
            .or_else(|| best_audio_format(&clean_formats, Some("opus")))
        {
            let (filesize, filesize_approx) =
                split_size_estimate(estimated_stream_bytes(audio, duration_seconds));
            options.push(MediaFormat {
                format_id: json_str(audio, "format_id")
                    .unwrap_or("bestaudio[ext=webm]/bestaudio/best")
                    .to_string(),
                resolution: "Audio only".to_string(),
                ext: "opus".to_string(),
                format_label: joined_format_label("opus", None, json_str(audio, "acodec")),
                fps: None,
                filesize,
                filesize_approx,
            });
        }

        if let Some(audio) = best_audio_format(&clean_formats, None) {
            let (filesize, filesize_approx) =
                split_size_estimate(estimated_stream_bytes(audio, duration_seconds));
            options.push(MediaFormat {
                format_id: json_str(audio, "format_id")
                    .unwrap_or("bestaudio/best")
                    .to_string(),
                resolution: "Audio only".to_string(),
                ext: "mp3".to_string(),
                format_label: "MP3 • Best audio".to_string(),
                fps: None,
                filesize,
                filesize_approx,
            });
        }
    }

    if options.is_empty() {
        clean_formats
            .iter()
            .filter_map(|format| raw_media_format(format, duration_seconds))
            .collect()
    } else {
        options
    }
}

const MEDIA_PROGRESS_PREFIX: &str = "__FIRELINK_PROGRESS__";

#[derive(Debug, PartialEq)]
struct MediaProgress {
    fraction: f64,
    speed: String,
    eta: String,
    size: Option<String>,
    downloaded_bytes: Option<f64>,
    total_bytes: Option<f64>,
    total_is_estimate: bool,
}

fn progress_json_number(progress: &serde_json::Value, key: &str) -> Option<f64> {
    progress.get(key).and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
    })
}

fn progress_json_string(progress: &serde_json::Value, key: &str) -> Option<String> {
    progress
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "N/A")
        .map(ToOwned::to_owned)
}

fn drain_media_output_lines(buffer: &mut String, chunk: &str) -> Vec<String> {
    buffer.push_str(chunk);

    let mut lines = Vec::new();
    while let Some(index) = match (buffer.find('\n'), buffer.find('\r')) {
        (Some(line_feed), Some(carriage_return)) => Some(line_feed.min(carriage_return)),
        (Some(line_feed), None) => Some(line_feed),
        (None, Some(carriage_return)) => Some(carriage_return),
        (None, None) => None,
    } {
        let mut line: String = buffer.drain(..=index).collect();
        while line.ends_with('\n') || line.ends_with('\r') {
            line.pop();
        }
        if !line.trim().is_empty() {
            lines.push(line);
        }
    }

    if lines.is_empty()
        && buffer.contains(MEDIA_PROGRESS_PREFIX)
        && parse_media_progress_line(buffer).is_some()
    {
        lines.push(std::mem::take(buffer));
    }

    lines
}

fn flush_media_output_line(buffer: &mut String) -> Option<String> {
    let line = std::mem::take(buffer);
    (!line.trim().is_empty()).then_some(line)
}

fn parse_media_progress_line(line: &str) -> Option<MediaProgress> {
    if let Some(prefix_index) = line.find(MEDIA_PROGRESS_PREFIX) {
        let progress: serde_json::Value =
            serde_json::from_str(line[prefix_index + MEDIA_PROGRESS_PREFIX.len()..].trim()).ok()?;
        let downloaded = progress_json_number(&progress, "downloaded_bytes").unwrap_or(0.0);
        let exact_total = progress_json_number(&progress, "total_bytes");
        let estimated_total = progress_json_number(&progress, "total_bytes_estimate");
        let total = exact_total.or(estimated_total).unwrap_or(0.0);
        let fragment_index = progress_json_number(&progress, "fragment_index");
        let fragment_count = progress_json_number(&progress, "fragment_count");
        let fraction = if let (Some(fragment_index), Some(fragment_count)) =
            (fragment_index, fragment_count)
        {
            if fragment_count > 1.0 {
                (fragment_index / fragment_count).clamp(0.0, 1.0)
            } else if total > 0.0 {
                downloaded / total
            } else {
                0.0
            }
        } else if total > 0.0 {
            downloaded / total
        } else {
            progress_json_number(&progress, "_percent")
                .or_else(|| {
                    progress_json_string(&progress, "_percent_str").and_then(|percent| {
                        percent.trim_end_matches('%').trim().parse::<f64>().ok()
                    })
                })
                .unwrap_or(0.0)
                / 100.0
        };
        let speed = progress_json_string(&progress, "_speed_str")
            .or_else(|| {
                progress_json_number(&progress, "speed")
                    .filter(|speed| *speed > 0.0)
                    .map(|speed| format!("{}/s", crate::download::format_size(speed)))
            })
            .unwrap_or_else(|| "-".to_string());
        let eta = progress_json_string(&progress, "_eta_str")
            .or_else(|| {
                progress_json_number(&progress, "eta")
                    .map(|seconds| format!("{}s", seconds.round() as u64))
            })
            .unwrap_or_else(|| "-".to_string());
        let total_is_estimate = exact_total.is_none() && estimated_total.is_some();
        // yt-dlp's estimated total is a moving bitrate-based guess. Use it to
        // derive a percentage when no better signal exists, but never expose
        // it as the media byte denominator. The Add window supplies the
        // stable format estimate, and an exact total is emitted at completion.
        let size = if total_is_estimate {
            None
        } else {
            progress_json_string(&progress, "_total_bytes_str")
                .or_else(|| exact_total.map(crate::download::format_size))
        };

        return Some(MediaProgress {
            fraction: fraction.clamp(0.0, 1.0),
            speed,
            eta,
            size,
            downloaded_bytes: (total > 0.0 || downloaded > 0.0).then_some(downloaded),
            total_bytes: exact_total.filter(|total| total.is_finite() && *total > 0.0),
            total_is_estimate,
        });
    }

    static ARIA2_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static YTDLP_PCT_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static YTDLP_SPD_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static YTDLP_ETA_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static YTDLP_SIZE_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

    let aria2_re = ARIA2_RE.get_or_init(|| {
        Regex::new(
            r"\[#[^\s]+\s+([^/\s]+)/([^\s(]+)\((\d+(?:\.\d+)?)%\).*?\bDL:([^\s\]]+)(?:\s+ETA:([^\s\]]+))?",
        )
        .unwrap()
    });
    if let Some(captures) = aria2_re.captures(line) {
        let fraction = captures.get(3)?.as_str().parse::<f64>().ok()? / 100.0;
        let speed = captures
            .get(4)
            .map(|value| format!("{}/s", value.as_str()))
            .unwrap_or_else(|| "-".to_string());
        let eta = captures
            .get(5)
            .map(|value| value.as_str().to_string())
            .unwrap_or_else(|| "-".to_string());
        let size = captures.get(2).map(|value| value.as_str().to_string());
        let downloaded_bytes = captures
            .get(1)
            .and_then(|value| parse_human_size(value.as_str()));
        let total_bytes = captures
            .get(2)
            .and_then(|value| parse_human_size(value.as_str()));
        return Some(MediaProgress {
            fraction: fraction.clamp(0.0, 1.0),
            speed,
            eta,
            size,
            downloaded_bytes,
            total_bytes,
            total_is_estimate: false,
        });
    }

    let percent_re =
        YTDLP_PCT_RE.get_or_init(|| Regex::new(r"\[download\]\s+~?\s*(\d+(?:\.\d+)?)%").unwrap());
    let captures = percent_re.captures(line)?;
    let fraction = captures.get(1)?.as_str().parse::<f64>().ok()? / 100.0;
    let speed_re = YTDLP_SPD_RE.get_or_init(|| Regex::new(r"\bat\s+([^\s]+)").unwrap());
    let eta_re = YTDLP_ETA_RE.get_or_init(|| Regex::new(r"\bETA\s+([^\s]+)").unwrap());
    let size_re = YTDLP_SIZE_RE
        .get_or_init(|| Regex::new(r"of\s+(~?)\s*([0-9.]+[a-zA-Z]+)").unwrap());
    let mut parsed_size_str = None;
    let mut downloaded_bytes = None;
    let mut total_bytes = None;
    let mut total_is_estimate = false;
    if let Some(captures) = size_re.captures(line) {
        if let Some(size_str) = captures.get(2) {
            parsed_size_str = Some(size_str.as_str().to_string());
            if let Some(parsed_total_bytes) = parse_human_size(size_str.as_str()) {
                downloaded_bytes = Some(parsed_total_bytes * fraction);
                total_bytes = Some(parsed_total_bytes);
            }
        }
        total_is_estimate = captures
            .get(1)
            .map(|marker| !marker.as_str().is_empty())
            .unwrap_or(false);
    }

    Some(MediaProgress {
        fraction: fraction.clamp(0.0, 1.0),
        speed: speed_re
            .captures(line)
            .and_then(|capture| capture.get(1))
            .map(|value| value.as_str().to_string())
            .unwrap_or_else(|| "-".to_string()),
        eta: eta_re
            .captures(line)
            .and_then(|capture| capture.get(1))
            .map(|value| value.as_str().to_string())
            .unwrap_or_else(|| "-".to_string()),
        size: parsed_size_str,
        downloaded_bytes,
        total_bytes,
        total_is_estimate,
    })
}

fn parse_human_size(s: &str) -> Option<f64> {
    let s = s.trim().to_lowercase();
    let num_str = s.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect::<String>();
    let num = num_str.parse::<f64>().ok()?;
    if s.ends_with("kib") || s.ends_with("kb") || s.ends_with("k") {
        Some(num * 1024.0)
    } else if s.ends_with("mib") || s.ends_with("mb") || s.ends_with("m") {
        Some(num * 1024.0 * 1024.0)
    } else if s.ends_with("gib") || s.ends_with("gb") || s.ends_with("g") {
        Some(num * 1024.0 * 1024.0 * 1024.0)
    } else {
        Some(num)
    }
}

const MEDIA_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(1000);
const MEDIA_SPEED_SAMPLE_WINDOW: Duration = Duration::from_secs(8);

#[derive(Debug, Default)]
struct MediaSpeedSampler {
    samples: VecDeque<(Instant, f64)>,
}

impl MediaSpeedSampler {
    fn reset(&mut self) {
        self.samples.clear();
    }

    fn sample(&mut self, downloaded_bytes: f64, now: Instant) -> Option<f64> {
        if self
            .samples
            .back()
            .is_some_and(|(_, last_bytes)| downloaded_bytes < *last_bytes)
        {
            self.reset();
        }

        self.samples.push_back((now, downloaded_bytes));
        while self.samples.len() > 2 {
            let Some((oldest_at, _)) = self.samples.front() else {
                break;
            };
            if now.duration_since(*oldest_at) <= MEDIA_SPEED_SAMPLE_WINDOW {
                break;
            }
            self.samples.pop_front();
        }

        let (oldest_at, oldest_bytes) = *self.samples.front()?;
        let elapsed = now.duration_since(oldest_at).as_secs_f64();
        if elapsed <= 0.25 || downloaded_bytes <= oldest_bytes {
            return None;
        }

        Some((downloaded_bytes - oldest_bytes) / elapsed)
    }
}

fn media_progress_speed(
    progress: &MediaProgress,
    now: Instant,
    speed_sampler: &mut MediaSpeedSampler,
) -> (String, String) {
    let Some(downloaded_bytes) = progress.downloaded_bytes else {
        return (progress.speed.clone(), progress.eta.clone());
    };

    if let Some(bytes_per_second) = speed_sampler.sample(downloaded_bytes, now) {
        let speed_str = crate::download::format_speed(bytes_per_second);
        let eta_str = if progress.fraction > 0.0 && progress.fraction < 1.0 {
            let total = downloaded_bytes / progress.fraction;
            let remaining = total - downloaded_bytes;
            crate::download::format_duration(remaining / bytes_per_second)
        } else {
            progress.eta.clone()
        };
        (speed_str, eta_str)
    } else {
        (progress.speed.clone(), progress.eta.clone())
    }
}

fn aggregate_media_fraction(
    total_tracks: f64,
    current_track: &mut f64,
    last_fraction: &mut f64,
    next_fraction: f64,
) -> f64 {
    let next_fraction = next_fraction.clamp(0.0, 1.0);
    let has_next_track = *current_track + 1.0 < total_tracks;
    if has_next_track && *last_fraction >= 0.95 && next_fraction <= 0.05 {
        *current_track += 1.0;
        *last_fraction = next_fraction;
    } else {
        *last_fraction = (*last_fraction).max(next_fraction);
    }

    ((*current_track + *last_fraction) / total_tracks).clamp(0.0, 1.0)
}

struct MediaProgressEmitterState {
    current_track: f64,
    last_fraction: f64,
    speed_sampler: MediaSpeedSampler,
    last_progress_at: Instant,
    completed_tracks_downloaded_bytes: Option<f64>,
    completed_tracks_total_bytes: Option<f64>,
    completed_tracks_total_is_estimate: bool,
    current_track_downloaded_bytes: Option<f64>,
    current_track_total_bytes: Option<f64>,
    current_track_total_is_estimate: bool,
}

impl MediaProgressEmitterState {
    fn new() -> Self {
        Self {
            current_track: 0.0,
            last_fraction: 0.0,
            speed_sampler: MediaSpeedSampler::default(),
            last_progress_at: Instant::now()
                .checked_sub(MEDIA_PROGRESS_EMIT_INTERVAL)
                .unwrap_or_else(Instant::now),
            completed_tracks_downloaded_bytes: Some(0.0),
            completed_tracks_total_bytes: Some(0.0),
            completed_tracks_total_is_estimate: false,
            current_track_downloaded_bytes: None,
            current_track_total_bytes: None,
            current_track_total_is_estimate: false,
        }
    }
}

fn aggregate_media_byte_progress(
    progress: &MediaProgress,
    track_changed: bool,
    state: &mut MediaProgressEmitterState,
) -> Option<(u64, u64, bool)> {
    if track_changed {
        if let Some(total_bytes) = state.current_track_total_bytes {
            let completed_downloaded = state.current_track_downloaded_bytes.unwrap_or(total_bytes);
            let completed_downloaded = if state.current_track_total_is_estimate {
                completed_downloaded.max(0.0)
            } else {
                completed_downloaded.clamp(0.0, total_bytes.max(0.0))
            };
            *state
                .completed_tracks_total_bytes
                .get_or_insert(0.0) += total_bytes;
            *state
                .completed_tracks_downloaded_bytes
                .get_or_insert(0.0) += completed_downloaded;
            state.completed_tracks_total_is_estimate |= state.current_track_total_is_estimate;
        } else {
            state.completed_tracks_total_bytes = None;
            state.completed_tracks_downloaded_bytes = None;
        }
        state.current_track_downloaded_bytes = None;
        state.current_track_total_bytes = None;
        state.current_track_total_is_estimate = false;
    }
    // yt-dlp's estimated total is a moving bitrate-based guess. Keep the
    // first total observed for a stream stable so the UI does not make the
    // download's size appear to change on every progress update. A new media
    // track gets its own stable total when split audio/video downloads switch
    // tracks.
    let next_total = progress
        .total_bytes
        .filter(|total_bytes| total_bytes.is_finite() && *total_bytes > 0.0);
    if state.current_track_total_bytes.is_none()
        || (state.current_track_total_is_estimate && !progress.total_is_estimate)
    {
        if let Some(total_bytes) = next_total {
            state.current_track_total_bytes = Some(total_bytes);
            state.current_track_total_is_estimate = progress.total_is_estimate;
        }
    }
    let stable_total_bytes = state.current_track_total_bytes;
    state.current_track_downloaded_bytes = progress
        .downloaded_bytes
        .or_else(|| progress.total_bytes.map(|total| total * progress.fraction))
        .zip(stable_total_bytes)
        .map(|(downloaded, total)| {
            // An estimated total is only a display anchor. yt-dlp can
            // legitimately download more bytes than that first estimate,
            // so never turn a moving estimate into a false 100% byte count.
            if state.current_track_total_is_estimate {
                downloaded.max(0.0)
            } else {
                downloaded.clamp(0.0, total.max(0.0))
            }
        })
        .or(progress.downloaded_bytes);

    match (
        state.completed_tracks_downloaded_bytes,
        state.completed_tracks_total_bytes,
        state.current_track_downloaded_bytes,
        state.current_track_total_bytes,
    ) {
        (
            Some(completed_downloaded),
            Some(completed_total),
            Some(current_downloaded),
            Some(current_total),
        ) if current_total > 0.0 => Some((
            (completed_downloaded + current_downloaded).max(0.0).round() as u64,
            (completed_total + current_total).max(0.0).round() as u64,
            state.completed_tracks_total_is_estimate || state.current_track_total_is_estimate,
        )),
        _ => None,
    }
}

fn media_progress_event_totals(
    progress: &MediaProgress,
    byte_progress: Option<(u64, u64, bool)>,
    total_tracks: f64,
) -> (Option<f64>, Option<bool>) {
    let fallback_total = (total_tracks <= 1.0)
        .then_some(progress.total_bytes)
        .flatten();
    let total_bytes = byte_progress
        .map(|value| value.1 as f64)
        .or(fallback_total);
    let total_is_estimate = byte_progress
        .map(|value| value.2)
        .or_else(|| fallback_total.map(|_| progress.total_is_estimate));
    (total_bytes, total_is_estimate)
}

fn emit_media_progress(
    app_handle: &tauri::AppHandle,
    id: &str,
    progress: MediaProgress,
    total_tracks: f64,
    state: &mut MediaProgressEmitterState,
) {
    let previous_track = state.current_track;
    let overall_fraction = aggregate_media_fraction(
        total_tracks,
        &mut state.current_track,
        &mut state.last_fraction,
        progress.fraction,
    );
    let track_changed = state.current_track != previous_track;
    if track_changed {
        state.speed_sampler.reset();
    }
    let byte_progress = aggregate_media_byte_progress(&progress, track_changed, state);
    let (speed, eta) = media_progress_speed(&progress, Instant::now(), &mut state.speed_sampler);
    let (total_bytes, total_is_estimate) =
        media_progress_event_totals(&progress, byte_progress, total_tracks);
    let downloaded_bytes = byte_progress
        .map(|value| value.0 as f64)
        .or(progress.downloaded_bytes);
    let size = byte_progress
        .map(|(_, total, total_is_estimate)| {
            let prefix = if total_is_estimate { "~" } else { "" };
            format!("{prefix}{}", crate::download::format_size(total as f64))
        })
        .or(progress.size);

    let now = Instant::now();
    if now.duration_since(state.last_progress_at) >= MEDIA_PROGRESS_EMIT_INTERVAL {
        let _ = app_handle.emit(
            "download-progress",
            DownloadProgressEvent {
                id: id.to_string(),
                fraction: overall_fraction,
                speed,
                eta,
                size,
                size_is_final: false,
                downloaded_bytes,
                total_bytes,
                total_is_estimate,
                active_connections: None,
                requested_connections: None,
                uploaded_bytes: None,
                upload_speed: None,
                num_seeders: None,
                torrent_seeded_seconds: None,
            },
        );
        state.last_progress_at = now;
    }
}

async fn cleanup_media_processing_artifacts(out_path: &std::path::Path) {
    cleanup_media_artifacts(out_path, true).await;
}

async fn remove_file_best_effort_with_retry(path: &std::path::Path) {
    for attempt in 0..=5 {
        match tokio::fs::remove_file(path).await {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) if attempt == 5 => {
                log::warn!(
                    "failed to remove media artifact '{}' after retries: {}",
                    path.display(),
                    error
                );
            }
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
    }
}

async fn cleanup_media_artifacts(out_path: &std::path::Path, remove_primary: bool) {
    let Some(parent) = out_path.parent() else {
        return;
    };
    let Some(base_name) = out_path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let base_stem = out_path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(base_name);

    if remove_primary {
        remove_file_best_effort_with_retry(out_path).await;
    }

    let Ok(mut entries) = tokio::fs::read_dir(parent).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path == out_path {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if is_media_artifact_name(name, base_name, base_stem) {
            remove_file_best_effort_with_retry(&path).await;
        }
    }
}

fn is_media_artifact_name(name: &str, base_name: &str, base_stem: &str) -> bool {
    let suffix = name.strip_prefix(base_name).or_else(|| {
        (base_stem != base_name)
            .then(|| name.strip_prefix(base_stem))
            .flatten()
    });
    let Some(suffix) = suffix else {
        return false;
    };

    if matches!(suffix, ".part" | ".ytdl" | ".temp" | ".tmp") {
        return true;
    }

    for marker in [".part", ".ytdl", ".temp", ".tmp"] {
        if let Some(extension) = suffix.strip_suffix(marker) {
            if is_known_media_extension(extension.strip_prefix('.').unwrap_or(extension)) {
                return true;
            }
        }
    }

    let Some(format_suffix) = suffix.strip_prefix(".f") else {
        return false;
    };
    let Some((format_id, extension)) = format_suffix.split_once('.') else {
        return false;
    };
    if format_id.is_empty() || !format_id.chars().all(|ch| ch.is_ascii_digit()) {
        return false;
    }

    let extension = [".part", ".ytdl", ".temp", ".tmp"]
        .iter()
        .find_map(|marker| extension.strip_suffix(marker))
        .unwrap_or(extension);

    is_known_media_extension(extension)
}

fn is_known_media_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "3gp"
            | "aac"
            | "ass"
            | "avi"
            | "flac"
            | "flv"
            | "jpg"
            | "jpeg"
            | "m4a"
            | "m4v"
            | "mka"
            | "mkv"
            | "mov"
            | "mp3"
            | "mp4"
            | "oga"
            | "ogg"
            | "opus"
            | "srt"
            | "ts"
            | "wav"
            | "webm"
            | "webp"
            | "wmv"
            | "vtt"
    )
}

fn sanitize_ytdlp_config_value(value: &str) -> String {
    value.replace(['\n', '\r'], "")
}

fn append_ytdlp_config_option(config: &mut String, option: &str, value: &str) {
    let safe_value = sanitize_ytdlp_config_value(value);
    if !safe_value.is_empty() {
        config.push_str(option);
        config.push(' ');
        // yt-dlp parses one configuration line at a time. Quoting keeps
        // whitespace and cookie delimiters inside this option's single value,
        // rather than turning them into additional input URLs.
        config.push('\'');
        config.push_str(&safe_value.replace('\'', "'\\''"));
        config.push('\'');
        config.push('\n');
    }
}

fn append_ytdlp_add_header(config: &mut String, header: &str) -> Result<bool, String> {
    let safe_header = sanitize_ytdlp_config_value(header).trim().to_string();
    if safe_header.is_empty() {
        return Ok(false);
    }
    let Some((name, _)) = safe_header.split_once(':') else {
        return Err(format!("invalid HTTP header: {safe_header}"));
    };
    if name.trim().is_empty() {
        return Err(format!("invalid HTTP header: {safe_header}"));
    }
    append_ytdlp_config_option(config, "--add-header", &safe_header);
    Ok(name.trim().eq_ignore_ascii_case("cookie"))
}

fn append_ytdlp_http_headers(
    config: &mut String,
    headers: Option<&str>,
    cookies: Option<&str>,
) -> Result<(), String> {
    let mut has_cookie_header = false;
    if let Some(headers) = headers {
        for header in headers.lines() {
            has_cookie_header |= append_ytdlp_add_header(config, header)?;
        }
    }

    if !has_cookie_header {
        if let Some(cookies) = cookies {
            let safe_cookies = sanitize_ytdlp_config_value(cookies).trim().to_string();
            if !safe_cookies.is_empty() {
                append_ytdlp_add_header(config, &format!("Cookie: {safe_cookies}"))?;
            }
        }
    }

    Ok(())
}

fn is_browser_cookie_extraction_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("could not copy") && lower.contains("cookie database")
        || lower.contains("could not access browser cookie database")
        || lower.contains("failed to read browser cookie")
        || lower.contains("failed to decrypt with dpapi")
}

fn should_retry_without_browser_cookies(
    cookie_browser: Option<&str>,
    failure_reason: &str,
    fallback_used: bool,
) -> bool {
    // Browser cookies are an optional authentication enhancement. Chromium on
    // Windows can deny access to its database independently of whether the
    // requested media needs authentication, so only this narrowly classified
    // extraction failure may downgrade to a public-media attempt.
    !fallback_used
        && cookie_browser.is_some_and(|source| {
            let source = source.trim();
            !source.is_empty() && !source.eq_ignore_ascii_case("none")
        })
        && is_browser_cookie_extraction_error(failure_reason)
}

fn should_cleanup_media_artifacts_after_failure(
    failure_reason: &str,
    strike: usize,
    max_retries: usize,
) -> bool {
    !(crate::retry::is_transient_network_error(failure_reason) && strike < max_retries)
}

fn is_blocked_network_address(ip: std::net::IpAddr) -> bool {
    if ip.is_loopback() || ip.is_multicast() || ip.is_unspecified() {
        return true;
    }
    match ip {
        std::net::IpAddr::V4(ipv4) => ipv4.is_private() || ipv4.is_link_local(),
        std::net::IpAddr::V6(ipv6) => {
            ipv6.to_ipv4().is_some_and(|ipv4| is_blocked_network_address(ipv4.into()))
                || (ipv6.segments()[0] & 0xfe00) == 0xfc00
                || (ipv6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

async fn resolve_and_validate_url_host(
    parsed: &reqwest::Url,
) -> Result<(String, std::net::SocketAddr), String> {
    let host = parsed.host_str().ok_or("SSRF blocked: No host")?;
    let lookup_host = host.trim_start_matches('[').trim_end_matches(']');
    let port = parsed.port_or_known_default().unwrap_or_else(|| match parsed.scheme() {
        "ftp" => 21,
        "sftp" => 22,
        _ => 80,
    });

    let addrs: Vec<_> = if let Ok(ip) = lookup_host.parse::<std::net::IpAddr>() {
        vec![std::net::SocketAddr::new(ip, port)]
    } else {
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::net::lookup_host((lookup_host, port)),
        )
        .await
        .map_err(|_| "SSRF blocked: DNS resolution timed out")?
        .map_err(|_| "SSRF blocked: DNS resolution failed")?
        .collect()
    };
    let addr = addrs.first().copied().ok_or("SSRF blocked: No DNS records")?;
    if addrs.iter().any(|candidate| is_blocked_network_address(candidate.ip())) {
        return Err("SSRF blocked: Private/local IP not allowed".to_string());
    }
    Ok((lookup_host.to_string(), addr))
}

async fn validate_url_ssrf(url: &str) -> Result<Option<(String, std::net::SocketAddr)>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "SSRF blocked: Invalid URL")?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("SSRF blocked: Only HTTP/HTTPS schemes allowed".to_string());
    }
    resolve_and_validate_url_host(&parsed).await.map(Some)
}

const MAX_REMOTE_TORRENT_REDIRECTS: usize = 5;

fn is_remote_torrent_source(source: &str, explicitly_torrent: bool) -> bool {
    if crate::torrent::is_remote_torrent_url(source) {
        return true;
    }
    if !explicitly_torrent {
        return false;
    }
    reqwest::Url::parse(source.trim())
        .ok()
        .is_some_and(|url| matches!(url.scheme(), "http" | "https"))
}

/// Fetch remote `.torrent` metadata through the same SSRF, redirect, proxy,
/// timeout, and bounded-body rules used by Firelink's metadata path. The
/// bytes are parsed and cached before they can enter the Aria2 lifecycle.
async fn fetch_remote_torrent_bytes(
    source: &str,
    proxy: Option<&str>,
    headers: Option<&str>,
    cookies: Option<&str>,
    cookie_scopes: Option<&[extension_server::ExtensionCookieScope]>,
) -> Result<Vec<u8>, String> {
    ensure_reqwest_crypto_provider();
    let proxy = proxy
        .map(crate::queue::aria2_all_proxy_value)
        .transpose()?
        .flatten();
    let mut current = reqwest::Url::parse(source)
        .map_err(|_| "SSRF blocked: Invalid URL".to_string())?;
    let original_origin = Some(current.clone());
    let cookies_available = metadata_cookie_header_present(headers, cookies, cookie_scopes);
    let mut send_cookies = !cookies_available;
    let mut cookie_retry_attempted = false;

    let mut redirect_count = 0;
    loop {
        if redirect_count > MAX_REMOTE_TORRENT_REDIRECTS {
            return Err("Too many redirects while fetching torrent metadata".to_string());
        }
        if !matches!(current.scheme(), "http" | "https") {
            return Err("Remote torrent metadata must use HTTP or HTTPS".to_string());
        }
        if !current.username().is_empty() || current.password().is_some() {
            return Err("Torrent metadata URLs must not contain credentials".to_string());
        }

        let (host, address) = validate_url_ssrf(current.as_str())
            .await?
            .ok_or_else(|| "SSRF blocked: No host".to_string())?;
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(FILE_METADATA_TIMEOUT)
            .user_agent("Firelink torrent metadata");
        match proxy.as_deref().map(str::trim) {
            Some("") => builder = builder.no_proxy(),
            Some(proxy) => {
                builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|error| error.to_string())?);
            }
            None => {}
        }
        builder = builder.resolve(&host, address);
        let same_origin_credentials = should_send_metadata_credentials(
            original_origin.as_ref(),
            Some(&current),
            redirect_count,
        );
        let scoped_cookie = if send_cookies {
            cookie_scope_for_url(current.as_str(), cookie_scopes)
        } else {
            None
        };
        let cookie_header = if same_origin_credentials {
            scoped_cookie.or(cookies)
        } else {
            scoped_cookie
        };
        let header_map = if same_origin_credentials {
            metadata_headers(headers, cookie_header, send_cookies)
        } else {
            metadata_headers(None, cookie_header, send_cookies)
        };
        builder = builder.default_headers(header_map);
        let client = builder
            .build()
            .map_err(|error| format!("could not create torrent metadata client: {error}"))?;
        let response = client
            .get(current.clone())
            .header(
                reqwest::header::ACCEPT,
                "application/x-bittorrent, application/octet-stream",
            )
            .send()
            .await
            .map_err(|error| {
                format!(
                    "remote torrent metadata request failed: {}",
                    crate::redact_sensitive_text(&error.to_string())
                )
            })?;

        if should_retry_metadata_with_cookies(
            response.status(),
            cookies_available && !send_cookies,
            cookie_retry_attempted,
        ) {
            send_cookies = true;
            cookie_retry_attempted = true;
            current = reqwest::Url::parse(source)
                .map_err(|_| "SSRF blocked: Invalid URL".to_string())?;
            redirect_count = 0;
            continue;
        }

        if response.status().is_redirection() {
            if redirect_count == MAX_REMOTE_TORRENT_REDIRECTS {
                return Err("Too many redirects while fetching torrent metadata".to_string());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "Torrent metadata redirect has no valid location".to_string())?;
            current = current
                .join(location)
                .map_err(|_| "Torrent metadata redirect URL is invalid".to_string())?;
            redirect_count += 1;
            continue;
        }

        if !response.status().is_success() {
            return Err(format!(
                "Remote torrent metadata request returned HTTP {}",
                response.status().as_u16()
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > crate::torrent::MAX_TORRENT_BYTES as u64)
        {
            return Err(format!(
                "torrent metadata must be at most {} bytes",
                crate::torrent::MAX_TORRENT_BYTES
            ));
        }

        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                format!(
                    "remote torrent metadata response failed: {}",
                    crate::redact_sensitive_text(&error.to_string())
                )
            })?;
            if bytes
                .len()
                .checked_add(chunk.len())
                .is_none_or(|length| length > crate::torrent::MAX_TORRENT_BYTES)
            {
                return Err(format!(
                    "torrent metadata must be at most {} bytes",
                    crate::torrent::MAX_TORRENT_BYTES
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err("remote torrent metadata response was empty".to_string());
        }
        return Ok(bytes);
    }

}

fn same_origin(left: &reqwest::Url, right: &reqwest::Url) -> bool {
    left.scheme() == right.scheme()
        && left.host() == right.host()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn should_send_metadata_credentials(
    original: Option<&reqwest::Url>,
    current: Option<&reqwest::Url>,
    redirects: usize,
) -> bool {
    redirects == 0
        || original
            .zip(current)
            .is_some_and(|(original, current)| same_origin(original, current))
}

fn cookie_scope_for_url<'a>(
    current_url: &str,
    cookie_scopes: Option<&'a [extension_server::ExtensionCookieScope]>,
) -> Option<&'a str> {
    let current = reqwest::Url::parse(current_url).ok()?;
    cookie_scopes?.iter().find_map(|scope| {
        let scope_url = reqwest::Url::parse(&scope.url).ok()?;
        let same_googleusercontent_site = scope_url.scheme() == current.scheme()
            && scope_url.port_or_known_default() == current.port_or_known_default()
            && scope_url.host_str() == Some("googleusercontent.com")
            && current
                .host_str()
                .is_some_and(|host| host.ends_with(".googleusercontent.com"));
        (same_origin(&scope_url, &current) || same_googleusercontent_site)
            .then_some(scope.cookies.as_str())
    })
}

fn metadata_authentication_error(current_url: &str, content_type: Option<&str>) -> Option<String> {
    let url = reqwest::Url::parse(current_url).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let path = url.path().to_ascii_lowercase();
    let content_type = content_type.unwrap_or_default().to_ascii_lowercase();
    let is_html = content_type.starts_with("text/html")
        || content_type.starts_with("application/xhtml+xml");
    let is_google_auth_host = host == "accounts.google.com"
        && (path.contains("signin")
            || path.contains("servicelogin")
            || url.query().is_some_and(|query| query.contains("continue=")));

    (is_google_auth_host && (is_html || path.contains("signin"))).then(|| {
        "The server returned a Google sign-in page instead of the requested attachment. Re-authenticate in the browser and try again.".to_string()
    })
}

#[allow(clippy::too_many_arguments)] // Keep the metadata IPC fields explicit and independently typed.
#[tauri::command]
async fn fetch_metadata(
    caller: tauri::WebviewWindow,
    url: String,
    user_agent: Option<String>,
    username: Option<String>,
    password: Option<String>,
    headers: Option<String>,
    cookies: Option<String>,
    cookie_scopes: Option<Vec<extension_server::ExtensionCookieScope>>,
    proxy: Option<String>,
    defer_cookies: Option<bool>,
) -> Result<MetadataResponse, String> {
    properties_window::ensure_main_window(&caller)?;
    ensure_reqwest_crypto_provider();

    let mut current_url = url.clone();
    let original_origin = reqwest::Url::parse(&url).ok();
    let mut redirects = 0;
    let cookies_available = metadata_cookie_header_present(
        headers.as_deref(),
        cookies.as_deref(),
        cookie_scopes.as_deref(),
    );
    let defer_cookies = defer_cookies.unwrap_or(false);
    let mut send_cookies = !defer_cookies || !cookies_available;
    let mut cookie_retry_attempted = false;
    let res;

    loop {
        if redirects >= 5 {
            return Err("Too many redirects".to_string());
        }

        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(FILE_METADATA_TIMEOUT);
        if let Some(proxy) = proxy.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            if proxy.eq_ignore_ascii_case("none") {
                builder = builder.no_proxy();
            } else {
                builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| e.to_string())?);
            }
        }

        if let Some(ref ua) = user_agent {
            let ua = ua.trim();
            if !ua.is_empty() {
                builder = builder.user_agent(ua);
            } else {
                builder = builder.user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36");
            }
        } else {
            builder = builder.user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36");
        }

        let parsed_current_url = reqwest::Url::parse(&current_url)
            .map_err(|_| "SSRF blocked: Invalid URL".to_string())?;
        let resolved_addr = match parsed_current_url.scheme() {
            "http" | "https" => validate_url_ssrf(&current_url).await?,
            "ftp" | "sftp" => resolve_and_validate_url_host(&parsed_current_url)
                .await
                .map(Some)?,
            _ => return Err("Unsupported URL scheme".to_string()),
        };

        if let Some((host, addr)) = resolved_addr {
            builder = builder.resolve(&host, addr);
        }

        let current_origin = reqwest::Url::parse(&current_url).ok();
        let same_origin_credentials = should_send_metadata_credentials(
            original_origin.as_ref(),
            current_origin.as_ref(),
            redirects,
        );

        let scoped_cookie = if send_cookies {
            cookie_scope_for_url(&current_url, cookie_scopes.as_deref())
        } else {
            None
        };
        let cookie_header = if same_origin_credentials {
            scoped_cookie.or(cookies.as_deref())
        } else {
            scoped_cookie
        };
        let header_map = if same_origin_credentials {
            metadata_headers(headers.as_deref(), cookie_header, send_cookies)
        } else {
            // A cross-origin redirect may receive only the cookie scope that
            // explicitly matches its host. Never forward captured headers or
            // a source-host Cookie header to an unrelated redirect target.
            metadata_headers(None, cookie_header, send_cookies)
        };
        builder = builder.default_headers(header_map);

        let client = builder.build().map_err(|e| e.to_string())?;
        let request_url = current_url.clone();

        let build_get_range = || {
            let mut get_req = client
                .get(&request_url)
                .header(reqwest::header::RANGE, "bytes=0-0");
            if same_origin_credentials {
                if let Some(ref user) = username {
                    if !user.is_empty() {
                        get_req = get_req.basic_auth(user, password.as_deref());
                    }
                }
            }
            get_req
        };

        let mut head_req = client.head(&request_url);
        if same_origin_credentials {
            if let Some(ref user) = username {
                if !user.is_empty() {
                    head_req = head_req.basic_auth(user, password.as_deref());
                }
            }
        }
        let mut current_res = match head_req.send().await {
            Ok(response) => response,
            Err(head_error) => build_get_range().send().await.map_err(|get_error| {
                let head_error = crate::redact_sensitive_text(&head_error.to_string());
                let get_error = crate::redact_sensitive_text(&get_error.to_string());
                format!(
                    "HEAD metadata request failed ({head_error}); ranged GET fallback failed ({get_error})"
                )
            })?,
        };

        if retry_metadata_with_cookies(
            current_res.status(),
            cookies_available,
            &mut send_cookies,
            &mut cookie_retry_attempted,
            &url,
            &mut current_url,
            &mut redirects,
        ) {
            // Browser captures may carry a large cookie jar even when the
            // direct download is public. Probe without it first so a server
            // or proxy header limit cannot turn harmless metadata into the
            // generic fallback state. Retry once with the captured cookie
            // header only when the origin explicitly challenges us.
            continue;
        }

        let mut needs_fallback = false;
        if (!current_res.status().is_success() && !current_res.status().is_redirection())
            || (current_res.status().is_success() && current_res.headers().get(reqwest::header::CONTENT_LENGTH).is_none())
        {
            needs_fallback = true;
        }

        if needs_fallback {
            current_res = build_get_range().send().await.map_err(|e| e.to_string())?;

            if retry_metadata_with_cookies(
                current_res.status(),
                cookies_available,
                &mut send_cookies,
                &mut cookie_retry_attempted,
                &url,
                &mut current_url,
                &mut redirects,
            ) {
                // HEAD is advisory. Some origins reject it while requiring
                // the captured session for the ranged GET that follows.
                continue;
            }
        }

        if current_res.status().is_redirection() {
            if let Some(loc) = current_res.headers().get(reqwest::header::LOCATION) {
                if let Ok(loc_str) = loc.to_str() {
                    if let Ok(parsed_base) = reqwest::Url::parse(&current_url) {
                        if let Ok(new_url) = parsed_base.join(loc_str) {
                            current_url = new_url.to_string();
                            redirects += 1;
                            continue;
                        }
                    }
                }
            }
        }

        if let Some(error) = metadata_authentication_error(
            &current_url,
            current_res
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
        ) {
            return Err(error);
        }

        if let Some(error) = metadata_response_error(current_res.status()) {
            return Err(error);
        }

        res = current_res;
        break;
    }

    let filename = metadata_filename_from_response(&res, &current_url, &url);
    
    let mut size_str = "Unknown".to_string();
    let mut size_bytes = 0;
    
    if res.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        if let Some(content_range) = res.headers().get(reqwest::header::CONTENT_RANGE) {
            if let Ok(cr_str) = content_range.to_str() {
                if let Some(idx) = cr_str.find('/') {
                    if let Ok(bytes) = cr_str[idx + 1..].parse::<u64>() {
                        size_bytes = bytes;
                    }
                }
            }
        }
    }

    if size_bytes == 0 {
        if let Some(len) = res.headers().get(reqwest::header::CONTENT_LENGTH) {
            if let Ok(len_str) = len.to_str() {
                if let Ok(bytes) = len_str.parse::<u64>() {
                    size_bytes = bytes;
                }
            }
        }
    }

    if size_bytes > 0 {
        let bytes = size_bytes;
        if bytes < 1024 {
            size_str = format!("{} B", bytes);
        } else if bytes < 1024 * 1024 {
            size_str = format!("{:.1} KB", bytes as f64 / 1024.0);
        } else if bytes < 1024 * 1024 * 1024 {
            size_str = format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0);
        } else {
            size_str = format!("{:.2} GB", bytes as f64 / 1024.0 / 1024.0 / 1024.0);
        }
    }

    let mut resumable = false;
    if res.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        resumable = true;
    } else if let Some(accept_ranges) = res.headers().get(reqwest::header::ACCEPT_RANGES) {
        if let Ok(accept_ranges_str) = accept_ranges.to_str() {
            if accept_ranges_str.contains("bytes") {
                resumable = true;
            }
        }
    }

    Ok(MetadataResponse {
        url,
        filename,
        size: size_str,
        size_bytes,
        resumable,
    })
}

const MEDIA_METADATA_CACHE_TTL: Duration = Duration::from_secs(60);
const MEDIA_METADATA_TIMEOUT: Duration = Duration::from_secs(55);
const MEDIA_METADATA_CACHE_MAX_ENTRIES: usize = 128;
const FILE_METADATA_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_SHELL_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
fn normalize_media_connections(connections: Option<i32>) -> i32 {
    crate::queue::clamp_download_connections(
        connections.unwrap_or(crate::queue::DOWNLOAD_CONNECTIONS_MAX),
    )
}

struct ShellCommandOutput {
    status_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn terminate_shell_process_tree(child: tauri_plugin_shell::process::CommandChild) {
    crate::process::kill_process_tree(child.pid());
    // The process-tree helper may already have signalled the root. The
    // direct kill is still needed when the root was not visible in the
    // snapshot, but its result is cleanup telemetry, not the operation's
    // primary error.
    let _ = child.kill();
}

async fn shell_command_output_with_timeout(
    command: tauri_plugin_shell::process::Command,
    timeout: Duration,
    operation: &str,
) -> Result<ShellCommandOutput, String> {
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("failed to spawn command: {error}"))?;

    let collect_output = async move {
        let mut output = ShellCommandOutput {
            status_code: None,
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        let mut output_bytes = 0usize;

        while let Some(event) = events.recv().await {
            match event {
                tauri_plugin_shell::process::CommandEvent::Stdout(bytes) => {
                    let next_size = output_bytes
                        .saturating_add(bytes.len())
                        .saturating_add(1);
                    if next_size > MAX_SHELL_OUTPUT_BYTES {
                        return Err(format!(
                            "{operation} produced more than {} MiB of output",
                            MAX_SHELL_OUTPUT_BYTES / (1024 * 1024)
                        ));
                    }
                    output.stdout.extend(bytes);
                    output.stdout.push(b'\n');
                    output_bytes = next_size;
                }
                tauri_plugin_shell::process::CommandEvent::Stderr(bytes) => {
                    let next_size = output_bytes
                        .saturating_add(bytes.len())
                        .saturating_add(1);
                    if next_size > MAX_SHELL_OUTPUT_BYTES {
                        return Err(format!(
                            "{operation} produced more than {} MiB of output",
                            MAX_SHELL_OUTPUT_BYTES / (1024 * 1024)
                        ));
                    }
                    output.stderr.extend(bytes);
                    output.stderr.push(b'\n');
                    output_bytes = next_size;
                }
                tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                    output.status_code = payload.code;
                }
                tauri_plugin_shell::process::CommandEvent::Error(_) => {}
                _ => {}
            }
        }

        Ok(output)
    };

    match tokio::time::timeout(timeout, collect_output).await {
        Ok(Ok(output)) if output.status_code.is_some() => Ok(output),
        Ok(Ok(_)) => {
            terminate_shell_process_tree(child);
            Err(format!("{operation} ended without a process exit status"))
        }
        Ok(Err(error)) => {
            terminate_shell_process_tree(child);
            Err(error)
        }
        Err(_) => {
            terminate_shell_process_tree(child);
            Err(format!(
                "{operation} timed out after {}s",
                timeout.as_secs()
            ))
        }
    }
}

static MEDIA_METADATA_CACHE: OnceLock<tokio::sync::Mutex<HashMap<u64, (Instant, MediaMetadata)>>> =
    OnceLock::new();
static MEDIA_METADATA_LOCKS: OnceLock<
    tokio::sync::Mutex<HashMap<u64, std::sync::Arc<tokio::sync::Mutex<()>>>>,
> = OnceLock::new();

#[allow(clippy::too_many_arguments)] // Hash every user-controlled yt-dlp input explicitly.
fn media_metadata_cache_key(
    url: &str,
    cookie_browser: &Option<String>,
    user_agent: &Option<String>,
    username: &Option<String>,
    password: &Option<String>,
    headers: &Option<String>,
    cookies: &Option<String>,
    proxy: &Option<String>,
) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    cookie_browser.hash(&mut hasher);
    user_agent.hash(&mut hasher);
    username.hash(&mut hasher);
    password.hash(&mut hasher);
    headers.hash(&mut hasher);
    cookies.hash(&mut hasher);
    proxy.hash(&mut hasher);
    hasher.finish()
}

async fn release_media_metadata_lock(
    cache_key: u64,
    request_lock: &std::sync::Arc<tokio::sync::Mutex<()>>,
) {
    let locks = MEDIA_METADATA_LOCKS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    let mut locks_guard = locks.lock().await;
    if std::sync::Arc::strong_count(request_lock) == 2
        && locks_guard
            .get(&cache_key)
            .is_some_and(|current| std::sync::Arc::ptr_eq(current, request_lock))
    {
        locks_guard.remove(&cache_key);
    }
}

fn resolve_metadata_ytdlp_path(
    app_handle: &tauri::AppHandle,
) -> Result<(PathBuf, &'static str), String> {
    resolve_bundled_binary_path(app_handle, "yt-dlp")
        .map(|path| (path, "bundled"))
        .map_err(|e| format!("failed to find bundled yt-dlp: {e}"))
}

#[allow(clippy::too_many_arguments)]
fn build_ytdlp_config_content(
    username: Option<&str>,
    password: Option<&str>,
    headers: Option<&str>,
    cookies: Option<&str>,
) -> Result<String, String> {
    let mut config_content = String::new();
    if let Some(user) = username {
        if !user.is_empty() {
            append_ytdlp_config_option(&mut config_content, "--username", user);
        }
    }
    if let Some(pass) = password {
        if !pass.is_empty() {
            append_ytdlp_config_option(&mut config_content, "--password", pass);
        }
    }
    append_ytdlp_http_headers(&mut config_content, headers, cookies)?;
    Ok(config_content)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Keep the generated TypeScript IPC contract flat and stable.
async fn fetch_media_metadata(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    url: String,
    cookie_browser: Option<String>,
    user_agent: Option<String>,
    username: Option<String>,
    password: Option<String>,
    headers: Option<String>,
    cookies: Option<String>,
    proxy: Option<String>,
) -> Result<MediaMetadata, String> {
    properties_window::ensure_main_window(&caller)?;
    validate_url_ssrf(&url).await?;
    let cache_key = media_metadata_cache_key(
        &url,
        &cookie_browser,
        &user_agent,
        &username,
        &password,
        &headers,
        &cookies,
        &proxy,
    );

    let cache = MEDIA_METADATA_CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    let mut cache_guard = cache.lock().await;
    cache_guard.retain(|_, (cached_at, _)| cached_at.elapsed() <= MEDIA_METADATA_CACHE_TTL);
    if let Some((_, metadata)) = cache_guard.get(&cache_key).cloned() {
        return Ok(metadata);
    }
    drop(cache_guard);

    let request_lock = {
        let locks = MEDIA_METADATA_LOCKS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
        let mut locks = locks.lock().await;
        locks
            .entry(cache_key)
            .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };

    let request_guard = request_lock.lock().await;

    let mut cache_guard = cache.lock().await;
    cache_guard.retain(|_, (cached_at, _)| cached_at.elapsed() <= MEDIA_METADATA_CACHE_TTL);
    if let Some((_, metadata)) = cache_guard.get(&cache_key).cloned() {
        drop(cache_guard);
        drop(request_guard);
        release_media_metadata_lock(cache_key, &request_lock).await;
        return Ok(metadata);
    }
    drop(cache_guard);

    // A fallback result was resolved without the configured browser session;
    // keep that effective identity separate so a later successful cookie
    // extraction can refresh authenticated formats instead of hitting stale
    // public-only metadata.
    let mut result_cache_key = cache_key;
    let result = fetch_media_metadata_uncached(
        app_handle.clone(),
        url.clone(),
        cookie_browser.clone(),
        user_agent.clone(),
        username.clone(),
        password.clone(),
        headers.clone(),
        cookies.clone(),
        proxy.clone(),
    )
    .await;

    let result = match (result, cookie_browser.as_deref()) {
        (Err(error), Some(browser))
            if should_retry_without_browser_cookies(Some(browser), &error, false) =>
        {
            log::warn!(
                "yt-dlp could not read browser cookies from {}; retrying media metadata without browser cookies",
                browser
            );
            result_cache_key = media_metadata_cache_key(
                &url,
                &None,
                &user_agent,
                &username,
                &password,
                &headers,
                &cookies,
                &proxy,
            );
            fetch_media_metadata_uncached(
                app_handle,
                url,
                None,
                user_agent,
                username,
                password,
                headers,
                cookies,
                proxy,
            )
            .await
        }
        (result, _) => result,
    };

    let result = match result {
        Ok(metadata) if metadata.formats.is_empty() => {
            Err("yt-dlp returned no usable media formats for this URL".to_string())
        }
        Ok(metadata) => {
            let mut cache_guard = cache.lock().await;
            if cache_guard.len() >= MEDIA_METADATA_CACHE_MAX_ENTRIES
                && !cache_guard.contains_key(&result_cache_key)
            {
                if let Some(oldest_key) = cache_guard
                    .iter()
                    .min_by_key(|(_, (cached_at, _))| *cached_at)
                    .map(|(key, _)| *key)
                {
                    cache_guard.remove(&oldest_key);
                }
            }
            cache_guard.insert(result_cache_key, (Instant::now(), metadata.clone()));
            Ok(metadata)
        }
        Err(error) => Err(error),
    };

    drop(request_guard);
    release_media_metadata_lock(cache_key, &request_lock).await;

    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn fetch_media_playlist_metadata(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    url: String,
    cookie_browser: Option<String>,
    user_agent: Option<String>,
    username: Option<String>,
    password: Option<String>,
    headers: Option<String>,
    cookies: Option<String>,
    proxy: Option<String>,
) -> Result<MediaPlaylistMetadata, String> {
    properties_window::ensure_main_window(&caller)?;
    validate_url_ssrf(&url).await?;

    let result = fetch_media_playlist_metadata_uncached(
        app_handle.clone(),
        url.clone(),
        cookie_browser.clone(),
        user_agent.clone(),
        username.clone(),
        password.clone(),
        headers.clone(),
        cookies.clone(),
        proxy.clone(),
    )
    .await;

    match (result, cookie_browser.as_deref()) {
        (Err(error), Some(browser))
            if should_retry_without_browser_cookies(Some(browser), &error, false) =>
        {
            log::warn!(
                "yt-dlp could not read browser cookies from {}; retrying playlist metadata without browser cookies",
                browser
            );
            fetch_media_playlist_metadata_uncached(
                app_handle,
                url,
                None,
                user_agent,
                username,
                password,
                headers,
                cookies,
                proxy,
            )
            .await
        }
        (result, _) => result,
    }
}

#[allow(clippy::too_many_arguments)]
async fn fetch_media_playlist_metadata_uncached(
    app_handle: tauri::AppHandle,
    url: String,
    cookie_browser: Option<String>,
    user_agent: Option<String>,
    username: Option<String>,
    password: Option<String>,
    headers: Option<String>,
    cookies: Option<String>,
    proxy: Option<String>,
) -> Result<MediaPlaylistMetadata, String> {
    let deno_path = resolve_bundled_binary_path(&app_handle, "deno")
        .map_err(|e| format!("failed to find bundled deno: {e}"))?;
    let ffmpeg_path = resolve_bundled_binary_path(&app_handle, "ffmpeg")
        .map_err(|e| format!("failed to find bundled ffmpeg: {e}"))?;
    let deno_runtime = format!("deno:{}", deno_path.to_string_lossy());
    let trusted_path = crate::platform::trusted_system_path()?;

    use tauri_plugin_shell::ShellExt;
    let (ytdlp_path, _) = resolve_metadata_ytdlp_path(&app_handle)?;
    let mut cmd = app_handle
        .shell()
        .command(ytdlp_path.to_string_lossy().to_string());
    cmd = cmd
        .env("PATH", trusted_path)
        .arg("--ffmpeg-location")
        .arg(&ffmpeg_path)
        .arg("--js-runtimes")
        .arg(&deno_runtime)
        .arg("--no-warnings")
        .arg("--ignore-errors")
        .arg("--flat-playlist")
        .arg("--playlist-end")
        .arg(MEDIA_PLAYLIST_MAX_ENTRIES.to_string())
        .arg("--dump-single-json")
        .arg("--socket-timeout")
        .arg("20")
        .arg("--retries")
        .arg("3")
        .arg("--extractor-retries")
        .arg("3")
        .arg("--compat-options")
        .arg("no-youtube-unavailable-videos");

    if let Some(browser) = cookie_browser.as_deref() {
        if !browser.is_empty() {
            cmd = cmd.arg("--cookies-from-browser").arg(browser);
        }
    }

    if let Some(proxy) = proxy.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if proxy.eq_ignore_ascii_case("none") {
            cmd = cmd.arg("--proxy").arg("");
        } else {
            cmd = cmd.arg("--proxy").arg(proxy);
        }
    }

    if let Some(ua) = user_agent
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cmd = cmd.arg("--user-agent").arg(ua);
    }

    let mut config_file = tempfile::Builder::new()
        .prefix("ytdlp-playlist-")
        .suffix(".conf")
        .tempfile()
        .map_err(|e| e.to_string())?;
    let config_content = build_ytdlp_config_content(
        username.as_deref(),
        password.as_deref(),
        headers.as_deref(),
        cookies.as_deref(),
    )?;
    use std::io::Write;
    config_file
        .write_all(config_content.as_bytes())
        .map_err(|e| e.to_string())?;
    let config_path = config_file.into_temp_path();
    if !config_content.is_empty() {
        cmd = cmd.arg("--config-location").arg(&config_path);
    }

    cmd = cmd.arg("--").arg(&url);
    let output = shell_command_output_with_timeout(
        cmd,
        MEDIA_METADATA_TIMEOUT,
        "yt-dlp playlist metadata fetch",
    )
    .await?;

    if output.status_code != Some(0) {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!(
                "yt-dlp failed while fetching playlist metadata (exit status: {:?})",
                output.status_code
            )
        } else {
            format!("yt-dlp failed while fetching playlist metadata: {}", err)
        });
    }

    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse playlist JSON: {}", e))?;
    parse_media_playlist_metadata(&value, MEDIA_PLAYLIST_MAX_ENTRIES)
}

#[allow(clippy::too_many_arguments)] // Mirrors the stable command contract for the fallback call.
async fn fetch_media_metadata_uncached(
    app_handle: tauri::AppHandle,
    url: String,
    cookie_browser: Option<String>,
    user_agent: Option<String>,
    username: Option<String>,
    password: Option<String>,
    headers: Option<String>,
    cookies: Option<String>,
    proxy: Option<String>,
) -> Result<MediaMetadata, String> {
    // Pass bundled tools by absolute path so extraction never depends on
    // system Python, a user-managed PATH, or auto-detection heuristics.
    let deno_path = resolve_bundled_binary_path(&app_handle, "deno")
        .map_err(|e| format!("failed to find bundled deno: {e}"))?;
    let ffmpeg_path = resolve_bundled_binary_path(&app_handle, "ffmpeg")
        .map_err(|e| format!("failed to find bundled ffmpeg: {e}"))?;
    let deno_runtime = format!("deno:{}", deno_path.to_string_lossy());
    let trusted_path = crate::platform::trusted_system_path()?;

    use tauri_plugin_shell::ShellExt;
    let (ytdlp_path, _) = resolve_metadata_ytdlp_path(&app_handle)?;
    let mut cmd = app_handle
        .shell()
        .command(ytdlp_path.to_string_lossy().to_string());
    cmd = cmd
        .env("PATH", trusted_path)
        .arg("--ffmpeg-location")
        .arg(&ffmpeg_path)
        .arg("--js-runtimes")
        .arg(&deno_runtime)
        .arg("--no-warnings")
        .arg("--no-playlist")
        .arg("--skip-download")
        .arg("--socket-timeout")
        .arg("20")
        .arg("--retries")
        .arg("3")
        .arg("--extractor-retries")
        .arg("3")
        .arg("--compat-options")
        .arg("no-youtube-unavailable-videos")
        .arg("--print")
        .arg("%(.{title,duration,thumbnail,formats})j");

    if let Some(browser) = cookie_browser.as_deref() {
        if !browser.is_empty() {
            cmd = cmd.arg("--cookies-from-browser").arg(browser);
        }
    }

    if let Some(proxy) = proxy.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if proxy.eq_ignore_ascii_case("none") {
            cmd = cmd.arg("--proxy").arg("");
        } else {
            cmd = cmd.arg("--proxy").arg(proxy);
        }
    }

    if let Some(ua) = user_agent
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cmd = cmd.arg("--user-agent").arg(ua);
    }

    let mut config_file = tempfile::Builder::new()
        .prefix("ytdlp-")
        .suffix(".conf")
        .tempfile()
        .map_err(|e| e.to_string())?;
    let config_content = build_ytdlp_config_content(
        username.as_deref(),
        password.as_deref(),
        headers.as_deref(),
        cookies.as_deref(),
    )?;
    use std::io::Write;
    config_file
        .write_all(config_content.as_bytes())
        .map_err(|e| e.to_string())?;
    let config_path = config_file.into_temp_path();
    if !config_content.is_empty() {
        cmd = cmd.arg("--config-location").arg(&config_path);
    }

    cmd = cmd.arg("--").arg(&url);

    let output = shell_command_output_with_timeout(
        cmd,
        MEDIA_METADATA_TIMEOUT,
        "yt-dlp media metadata fetch",
    )
    .await?;
    if output.status_code == Some(0) {
        let value: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("Failed to parse JSON: {}", e))?;

        let title = value
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown Title")
            .to_string();
        let duration_seconds = value.get("duration").and_then(|v| v.as_f64());
        let duration = duration_seconds.map(|v| v as u64);
        let thumbnail = value
            .get("thumbnail")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let formats = value
            .get("formats")
            .and_then(|v| v.as_array())
            .map(|formats_arr| build_media_format_options(formats_arr, duration_seconds))
            .unwrap_or_default();

        Ok(MediaMetadata {
            title,
            duration,
            thumbnail,
            formats,
        })
    } else {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if err.is_empty() {
            Err(format!(
                "yt-dlp failed while fetching media metadata (exit status: {:?})",
                output.status_code
            ))
        } else {
            Err(format!(
                "yt-dlp failed while fetching media metadata: {}",
                err
            ))
        }
    }
}

#[tauri::command]
async fn test_ytdlp(caller: tauri::WebviewWindow, app_handle: tauri::AppHandle) -> Result<String, String> {
    properties_window::ensure_main_window(&caller)?;
    let (version, error, _) = run_sidecar_version(&app_handle, "yt-dlp", &["--version"]).await;
    match (version, error) {
        (Some(version), None) => Ok(version),
        (_, Some(error)) => Err(error),
        _ => Err("yt-dlp returned no version output".to_string()),
    }
}

#[tauri::command]
async fn test_ffmpeg(caller: tauri::WebviewWindow, app_handle: tauri::AppHandle) -> Result<String, String> {
    properties_window::ensure_main_window(&caller)?;
    let (version, error, _) = run_sidecar_version(&app_handle, "ffmpeg", &["-version"]).await;
    version
        .as_deref()
        .and_then(parse_ffmpeg_version)
        .ok_or_else(|| error.unwrap_or_else(|| "ffmpeg returned no version output".to_string()))
}

#[tauri::command]
async fn test_deno(caller: tauri::WebviewWindow, app_handle: tauri::AppHandle) -> Result<String, String> {
    properties_window::ensure_main_window(&caller)?;
    let (version, error, _) = run_sidecar_version(&app_handle, "deno", &["--version"]).await;
    if let Some(text) = version {
        let re = regex::Regex::new(r"deno\s+(\d+\.\d+\.\d+)").unwrap();
        let clean = re
            .captures(&text)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str())
            .unwrap_or(&text)
            .to_string();
        Ok(clean)
    } else {
        Err(error.unwrap_or_else(|| "deno returned no version output".to_string()))
    }
}

pub(crate) fn is_safe_path<R: tauri::Runtime>(path: &std::path::Path, app_handle: &tauri::AppHandle<R>) -> bool {
    if !path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return false;
    }

    let Some(canonical_path) = canonicalize_with_missing_components(path) else {
        return false;
    };

    approved_download_roots(app_handle)
        .into_iter()
        .filter_map(|root| canonicalize_with_missing_components(&root))
        .any(|root| crate::platform::path_is_within(&canonical_path, &root))
}

pub(crate) fn path_has_symlink_component(path: &std::path::Path) -> bool {
    use std::path::Component;

    let mut current = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => {
                current.push(component.as_os_str());
            }
            Component::Normal(name) => {
                current.push(name);
                if std::fs::symlink_metadata(&current)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
                {
                    return true;
                }
            }
            Component::CurDir | Component::ParentDir => return true,
        }
    }
    false
}

pub(crate) fn canonicalize_with_missing_components(
    path: &std::path::Path,
) -> Option<std::path::PathBuf> {
    if path_has_symlink_component(path) {
        return None;
    }
    let mut existing = path;
    let mut missing = Vec::new();
    loop {
        match std::fs::symlink_metadata(existing) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return None;
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(existing.file_name()?.to_owned());
                existing = existing.parent()?;
            }
            Err(_) => return None,
        }
    }
    let mut canonical = std::fs::canonicalize(existing).ok()?;
    for component in missing.iter().rev() {
        canonical.push(component);
    }
    Some(canonical)
}

fn approved_download_roots<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> Vec<std::path::PathBuf> {
    use tauri::Manager;

    let mut roots = Vec::new();
    for root in [
        app_handle.path().download_dir().ok(),
        app_handle.path().audio_dir().ok(),
        app_handle.path().video_dir().ok(),
        app_handle.path().picture_dir().ok(),
        app_handle.path().document_dir().ok(),
        app_handle.path().desktop_dir().ok(),
    ]
    .into_iter()
    .flatten()
    {
        push_unique_path(&mut roots, root);
    }

    if let Ok(settings) = crate::settings::load_settings(app_handle) {
        push_unique_path(
            &mut roots,
            resolve_path(&settings.base_download_folder, app_handle),
        );
        for root in settings.category_directory_overrides.values() {
            push_unique_path(&mut roots, resolve_path(root, app_handle));
        }
        for root in &settings.approved_download_roots {
            push_unique_path(&mut roots, resolve_path(root, app_handle));
        }
    }

    roots
}

#[tauri::command]
fn approve_download_root(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<String, String> {
    properties_window::ensure_main_window(&caller)?;
    let resolved = resolve_path(path.trim(), &app_handle);
    if !resolved.is_absolute() {
        return Err("Download root must be an absolute path".to_string());
    }
    if crate::path_has_symlink_component(&resolved) {
        return Err("Download root may not contain symlink components".to_string());
    }
    let canonical = std::fs::canonicalize(&resolved)
        .map_err(|error| format!("Failed to resolve download root: {error}"))?;
    if !canonical.is_dir() {
        return Err("Download root must be an existing directory".to_string());
    }
    let canonical_text = crate::platform::display_path(&canonical);

    crate::settings::update_settings_state(&app_handle, |state| {
        let roots = state
            .entry("approvedDownloadRoots".to_string())
            .or_insert_with(|| serde_json::Value::Array(Vec::new()));
        if !roots.is_array() {
            *roots = serde_json::Value::Array(Vec::new());
        }
        let values = roots
            .as_array_mut()
            .expect("approved roots must be an array");
        if !values
            .iter()
            .filter_map(serde_json::Value::as_str)
            .any(|root| {
                crate::platform::paths_equal(
                    std::path::Path::new(root),
                    std::path::Path::new(&canonical_text),
                )
            })
        {
            values.push(serde_json::Value::String(canonical_text.clone()));
        }
    })?;

    Ok(canonical_text)
}

fn push_unique_path(paths: &mut Vec<std::path::PathBuf>, path: std::path::PathBuf) {
    if path.is_absolute()
        && !paths
            .iter()
            .any(|existing| crate::platform::paths_equal(existing, &path))
    {
        paths.push(path);
    }
}

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

struct Aria2DaemonGuard {
    child: Mutex<Option<std::process::Child>>,
    startup_error: Mutex<Option<String>>,
    last_stderr: Mutex<String>,
    config_path: Mutex<Option<tempfile::TempPath>>,
}

impl Aria2DaemonGuard {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            startup_error: Mutex::new(None),
            last_stderr: Mutex::new(String::new()),
            config_path: Mutex::new(None),
        }
    }
}

impl Drop for Aria2DaemonGuard {
    fn drop(&mut self) {
        if let Ok(mut lock) = self.child.lock() {
            if let Some(mut child) = lock.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

pub mod commands;
pub mod download;
pub mod download_ownership;
mod engines;
pub mod error;
#[allow(dead_code)]
pub mod ipc;
mod parity;
mod power;
mod platform;
mod properties_window;
pub mod queue;
pub mod process;
pub mod retry;
mod torrent_probe;
pub mod torrent;
mod settings;
mod storage;
pub use error::AppError;

// Retained only for compatibility with the optional aria2 diagnostic monitor.
// Active downloads are owned by DownloadCoordinator.
#[non_exhaustive]
pub enum TaskHandle {
    Aria2(String),
}

pub struct AppState {
    pub download_coordinator: download::DownloadCoordinator,
    pub storage_layout: crate::storage::StorageLayout,
    /// Credential-store access is denied until the frontend has completed the
    /// startup consent decision for this process. This is intentionally
    /// process-local: a new binary must pass through the consent barrier
    /// again before any stale or early IPC caller can reach the OS store.
    pub keychain_access_authorized: Arc<AtomicBool>,
    pub keychain_grant_in_progress: Arc<AtomicBool>,
    keychain_grant: Arc<Mutex<KeychainGrantState>>,
    pub extension_pairing_token: extension_server::SharedExtensionToken,
    pub extension_frontend_ready: extension_server::SharedFrontendReady,
    pub extension_acks: extension_server::SharedExtensionAcks,
    pub extension_server_port: extension_server::SharedServerPort,
    pub extension_server_shutdown: tokio::sync::watch::Sender<bool>,
    pub aria2_port: std::sync::Arc<std::sync::atomic::AtomicU16>,
    pub aria2_secret: String,
    pub media_semaphore: Arc<tokio::sync::Semaphore>,
    pub power_manager: Arc<power::PowerManager>,
    pub scheduler_settings: Arc<RwLock<Option<crate::ipc::PersistedSettings>>>,
    pub queue_manager: Arc<queue::QueueManager>,
}

#[derive(Default)]
struct MainWindowRestoreState {
    requested: AtomicBool,
}

#[cfg(target_os = "macos")]
const MAIN_WINDOW_MINIMIZE_MENU_ID: &str = "main_window_minimize";

const KEYCHAIN_CONSENT_REQUIRED_ERROR: &str =
    "Credential-store access requires explicit user consent";
const KEYCHAIN_GRANT_IN_PROGRESS_ERROR: &str =
    "Credential-store access is already being requested";
const KEYCHAIN_GRANT_REQUEST_ID_MAX_LEN: usize = 128;
const MAX_ABANDONED_KEYCHAIN_REQUESTS: usize = 64;

fn validate_keychain_grant_request_id(request_id: &str) -> Result<(), String> {
    if request_id.trim().is_empty() || request_id.len() > KEYCHAIN_GRANT_REQUEST_ID_MAX_LEN {
        return Err("Invalid keychain grant request ID".to_string());
    }
    Ok(())
}

fn require_keychain_access(state: &AppState) -> Result<(), String> {
    if state
        .keychain_access_authorized
        .load(Ordering::Acquire)
    {
        Ok(())
    } else {
        Err(KEYCHAIN_CONSENT_REQUIRED_ERROR.to_string())
    }
}

struct KeychainGrantGuard(Arc<AtomicBool>);

impl Drop for KeychainGrantGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn begin_keychain_grant(
    state: &AppState,
    request_id: &str,
) -> Result<KeychainGrantGuard, String> {
    validate_keychain_grant_request_id(request_id)?;
    let guard = state
        .keychain_grant_in_progress
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .map(|_| KeychainGrantGuard(Arc::clone(&state.keychain_grant_in_progress)))
        .map_err(|_| KEYCHAIN_GRANT_IN_PROGRESS_ERROR.to_string())?;
    let mut grant = state
        .keychain_grant
        .lock()
        .map_err(|_| "Keychain grant state lock is unavailable".to_string())?;
    if grant.abandoned_request_ids.remove(request_id) {
        return Err("Keychain grant was dismissed before it started".to_string());
    }
    grant.request_id = Some(request_id.to_string());
    grant.cancelled = false;
    grant.committed = false;
    grant.result = None;
    Ok(guard)
}

#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct DownloadProgressEvent {
    id: String,
    fraction: f64,
    speed: String,
    eta: String,
    size: Option<String>,
    size_is_final: bool,
    #[ts(optional)]
    downloaded_bytes: Option<f64>,
    #[ts(optional)]
    total_bytes: Option<f64>,
    #[ts(optional)]
    total_is_estimate: Option<bool>,
    #[ts(optional)]
    active_connections: Option<i32>,
    #[ts(optional)]
    requested_connections: Option<i32>,
    #[ts(optional)]
    uploaded_bytes: Option<f64>,
    #[ts(optional)]
    upload_speed: Option<String>,
    #[ts(optional)]
    num_seeders: Option<i32>,
    #[ts(optional)]
    torrent_seeded_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EngineStatusItem {
    name: String,
    kind: String,
    expected_sidecar: String,
    resolved_path: Option<String>,
    version: Option<String>,
    ready: bool,
    error: Option<String>,
    stderr_tail: Option<String>,
    remediation_hint: Option<String>,
    rpc_port: Option<u16>,
    daemon_alive: Option<bool>,
    rpc_ready: Option<bool>,
    last_stderr_tail: Option<String>,
    expects_internal_dir: Option<bool>,
    has_internal_dir: Option<bool>,
    has_python_framework: Option<bool>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EngineStatusResult {
    pub engines: Vec<EngineStatusItem>,
}

pub(crate) fn resolve_path<R: tauri::Runtime>(path: &str, app_handle: &tauri::AppHandle<R>) -> std::path::PathBuf {
    use tauri::Manager;
    let mut resolved = std::path::PathBuf::from(path);
    if let Some(stripped) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = app_handle.path().home_dir().ok().or_else(|| {
            std::env::var("USERPROFILE")
                .ok()
                .map(std::path::PathBuf::from)
        }) {
            resolved = home.join(stripped);
        } else {
            log::warn!("Failed to resolve home directory for ~ expansion");
        }
    } else if path == "~" {
        if let Some(home) = app_handle.path().home_dir().ok().or_else(|| {
            std::env::var("USERPROFILE")
                .ok()
                .map(std::path::PathBuf::from)
        }) {
            resolved = home;
        } else {
            log::warn!("Failed to resolve home directory for ~ expansion");
        }
    }
    resolved
}

pub(crate) fn collect_download_uris(url: &str, mirrors: Option<&str>) -> Vec<String> {
    let mut uris = Vec::new();
    for uri in std::iter::once(url).chain(mirrors.into_iter().flat_map(str::lines)) {
        let uri = uri.trim();
        if !uri.is_empty() && !uris.iter().any(|existing| existing == uri) {
            uris.push(uri.to_string());
        }
    }
    uris
}

const MAX_DEEP_LINK_PAYLOAD_LEN: usize = 65_536;
const MAX_DEEP_LINK_URLS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
enum FirelinkDeepLink {
    Launch,
    Add(Vec<String>),
    Invalid,
}

fn parse_firelink_deep_link(deep_link: &url::Url) -> FirelinkDeepLink {
    if deep_link.scheme() == "magnet" {
        return if deep_link.query().is_some()
            && deep_link.fragment().is_none()
            && deep_link.username().is_empty()
            && deep_link.password().is_none()
            && deep_link.port().is_none()
            && deep_link.to_string().chars().count() < MAX_DEEP_LINK_PAYLOAD_LEN
        {
            FirelinkDeepLink::Add(vec![deep_link.to_string()])
        } else {
            FirelinkDeepLink::Invalid
        };
    }

    if deep_link.scheme() != "firelink"
        || !deep_link.username().is_empty()
        || deep_link.password().is_some()
        || deep_link.port().is_some()
    {
        return FirelinkDeepLink::Invalid;
    }

    if deep_link.host_str() == Some("launch") {
        return if matches!(deep_link.path(), "" | "/")
            && deep_link.query().is_none()
            && deep_link.fragment().is_none()
        {
            FirelinkDeepLink::Launch
        } else {
            FirelinkDeepLink::Invalid
        };
    }

    if deep_link.host_str() != Some("add")
        || !matches!(deep_link.path(), "" | "/")
        || deep_link.fragment().is_some()
    {
        return FirelinkDeepLink::Invalid;
    }

    let Some(raw_urls) = deep_link
        .query_pairs()
        .find_map(|(key, value)| (key == "url").then(|| value.into_owned()))
    else {
        return FirelinkDeepLink::Invalid;
    };
    if raw_urls.is_empty() || raw_urls.chars().count() >= MAX_DEEP_LINK_PAYLOAD_LEN {
        return FirelinkDeepLink::Invalid;
    }

    let mut captured = Vec::new();
    for raw_url in raw_urls.lines() {
        let raw_url = raw_url.trim();
        let Ok(url) = url::Url::parse(raw_url) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https" | "ftp" | "sftp" | "magnet") {
            continue;
        }
        let url = url.to_string();
        if !captured.iter().any(|existing| existing == &url) {
            captured.push(url);
            if captured.len() == MAX_DEEP_LINK_URLS {
                break;
            }
        }
    }

    if captured.is_empty() {
        FirelinkDeepLink::Invalid
    } else {
        FirelinkDeepLink::Add(captured)
    }
}

fn normalize_opened_torrent_argument(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty()
        || raw.starts_with('-')
        || raw.contains('\r')
        || raw.contains('\n')
        || raw.chars().count() >= MAX_DEEP_LINK_PAYLOAD_LEN
    {
        return None;
    }

    let is_windows_absolute = cfg!(target_os = "windows")
        && raw.len() >= 3
        && raw.as_bytes()[1] == b':'
        && matches!(raw.as_bytes()[2], b'/' | b'\\');
    let path = if is_windows_absolute {
        PathBuf::from(raw)
    } else if let Ok(url) = url::Url::parse(raw) {
        if url.scheme() != "file" {
            return None;
        }
        url.to_file_path().ok()?
    } else {
        PathBuf::from(raw)
    };
    if !path.is_absolute() && !is_windows_absolute {
        return None;
    }
    if !path.extension().is_some_and(|extension| {
        extension.to_string_lossy().eq_ignore_ascii_case("torrent")
    }) {
        return None;
    }
    let path = path.to_string_lossy().into_owned();
    (!path.contains('\r') && !path.contains('\n')).then_some(path)
}

fn collect_opened_torrent_paths<I, S>(arguments: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut seen = HashSet::new();
    arguments
        .into_iter()
        .filter_map(|argument| argument.as_ref().to_str().and_then(normalize_opened_torrent_argument))
        .filter(|path| seen.insert(path.clone()))
        .take(MAX_DEEP_LINK_URLS)
        .collect()
}

fn restore_main_window(app_handle: &tauri::AppHandle) {
    let Some(window) = app_handle.get_webview_window("main") else {
        if let Some(state) = app_handle.try_state::<MainWindowRestoreState>() {
            state.requested.store(true, Ordering::Release);
        }
        return;
    };

    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn restore_pending_main_window(app_handle: &tauri::AppHandle) {
    if app_handle
        .try_state::<MainWindowRestoreState>()
        .is_some_and(|state| state.requested.swap(false, Ordering::AcqRel))
    {
        restore_main_window(app_handle);
    }
}

fn dispatch_deep_links(app_handle: tauri::AppHandle, deep_links: Vec<url::Url>) {
    let mut should_restore = false;
    let mut urls = Vec::new();
    for deep_link in deep_links {
        match parse_firelink_deep_link(&deep_link) {
            FirelinkDeepLink::Launch => should_restore = true,
            FirelinkDeepLink::Add(parsed) => {
                should_restore = true;
                for url in parsed {
                    if !urls.contains(&url) && urls.len() < MAX_DEEP_LINK_URLS {
                        urls.push(url);
                    }
                }
            }
            FirelinkDeepLink::Invalid => {}
        }
    }
    if !should_restore {
        return;
    }

    restore_main_window(&app_handle);
    if urls.is_empty() {
        return;
    }
    let coordinator = app_handle.state::<AppState>().download_coordinator.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = coordinator
            .send(download::DownloadCmd::CaptureUrls(urls))
            .await
        {
            eprintln!("Failed to dispatch deep link to download coordinator: {error}");
        }
    });
}

fn dispatch_opened_torrent_paths(app_handle: tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    restore_main_window(&app_handle);
    let coordinator = app_handle.state::<AppState>().download_coordinator.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = coordinator
            .send(download::DownloadCmd::CaptureUrls(paths))
            .await
        {
            eprintln!("Failed to dispatch opened torrent files: {error}");
        }
    });
}

#[doc(hidden)]
pub async fn rpc_call(
    port: u16,
    secret: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    ensure_reqwest_crypto_provider();

    let url = format!("http://127.0.0.1:{}/jsonrpc", port);
    let mut payload = serde_json::Map::new();
    payload.insert("jsonrpc".to_string(), serde_json::json!("2.0"));
    payload.insert("id".to_string(), serde_json::json!("1"));
    payload.insert("method".to_string(), serde_json::json!(method));

    let mut p = vec![serde_json::json!(format!("token:{}", secret))];
    if let serde_json::Value::Array(arr) = params {
        p.extend(arr);
    }
    payload.insert("params".to_string(), serde_json::json!(p));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let http_status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&body).map_err(|error| {
        if http_status.is_success() {
            error.to_string()
        } else {
            format!(
                "HTTP {} {}: invalid JSON-RPC response: {error}",
                http_status.as_u16(),
                http_status.canonical_reason().unwrap_or("response error")
            )
        }
    })?;
    if !http_status.is_success() {
        let detail = json
            .get("error")
            .map(serde_json::Value::to_string)
            .unwrap_or_else(|| "aria2 returned no JSON-RPC error".to_string());
        return Err(format!(
            "HTTP {} {}: {detail}",
            http_status.as_u16(),
            http_status.canonical_reason().unwrap_or("response error")
        ));
    }
    if let Some(error) = json.get("error") {
        return Err(error.to_string());
    }
    json.get("result")
        .cloned()
        .ok_or_else(|| "aria2 returned no result".to_string())
}

struct Aria2RpcClient {
    port: u16,
    secret: String,
}

#[async_trait::async_trait]
impl crate::torrent_probe::RpcClient for Aria2RpcClient {
    async fn call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        rpc_call(self.port, &self.secret, method, params).await
    }
}

#[tauri::command]
async fn test_aria2c(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    properties_window::ensure_main_window(&caller)?;
    let guard = app_handle.state::<Aria2DaemonGuard>();
    let startup_err = guard
        .startup_error
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(err) = startup_err {
        return Err(format!("aria2 daemon unavailable: {err}"));
    }

    let result = rpc_call(
        state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
        &state.aria2_secret,
        "aria2.getVersion",
        serde_json::json!([]),
    )
    .await
    .map_err(|error| format!("aria2 daemon unavailable: {error}"))?;

    result
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "aria2 returned an invalid version response".to_string())
}

// ── get_engine_status: Structured engine status ──────────────

async fn run_sidecar_version(
    app_handle: &tauri::AppHandle,
    sidecar_name: &str,
    args: &[&str],
) -> (Option<String>, Option<String>, Option<String>) {
    let binary_path = match resolve_bundled_binary_path(app_handle, sidecar_name) {
        Ok(p) => p,
        Err(e) => {
            return (
                None,
                Some(format!("Missing bundled binary '{}': {}", sidecar_name, e)),
                None,
            )
        }
    };

    if let Err(error) = validate_bundled_binary(&binary_path) {
        return (None, Some(error), None);
    }

    let cache_key = version_cache_key(&binary_path, args);
    if let Ok(cache) = version_check_cache().lock() {
        if let Some(cached) = cache.get(&cache_key) {
            return cached.clone();
        }
    }

    let mut command = tokio::process::Command::new(&binary_path);
    crate::platform::hide_tokio_child_console(&mut command);
    if sidecar_name == "aria2c" {
        crate::engines::apply_aria2_tokio_environment(&mut command, &binary_path);
    }
    command.args(args).kill_on_drop(true);
    let output_future = command.output();
    tokio::pin!(output_future);

    const VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);
    let result = tokio::time::timeout(VERSION_TIMEOUT, &mut output_future)
        .await
        .map_err(|_| VERSION_TIMEOUT);

    let output = match result {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            return (
                None,
                Some(format!("Failed to execute '{}': {}", sidecar_name, e)),
                None,
            )
        }
        Err(timeout) => {
            return (
                None,
                Some(format!(
                    "'{}' version check timed out after {} seconds at '{}'",
                    sidecar_name,
                    timeout.as_secs(),
                    binary_path.display()
                )),
                None,
            )
        }
    };

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stderr_tail = if stderr.is_empty() {
        None
    } else {
        Some(stderr.clone())
    };

    let result = if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (Some(stdout), None, stderr_tail)
    } else {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let err = if !stderr.is_empty() {
            stderr.lines().rev().take(10).collect::<Vec<_>>().join("\n")
        } else {
            format!("Exited with code {:?}", output.status.code())
        };
        (
            if stdout.is_empty() {
                None
            } else {
                Some(stdout)
            },
            Some(err),
            stderr_tail,
        )
    };

    if result.1.is_none() {
        if let Ok(mut cache) = version_check_cache().lock() {
            cache.insert(cache_key, result.clone());
        }
    }

    result
}

type VersionCheckResult = (Option<String>, Option<String>, Option<String>);

fn version_check_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, VersionCheckResult>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, VersionCheckResult>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn version_cache_key(binary_path: &std::path::Path, args: &[&str]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let modified = std::fs::metadata(binary_path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    binary_path.hash(&mut hasher);
    modified.hash(&mut hasher);
    args.hash(&mut hasher);
    hasher.finish().to_string()
}

fn validate_bundled_binary(binary_path: &std::path::Path) -> Result<(), String> {
    let metadata = std::fs::metadata(binary_path).map_err(|error| {
        format!(
            "Missing bundled binary at '{}': {error}",
            binary_path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "Bundled binary path is not a file: '{}'",
            binary_path.display()
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(format!(
                "Bundled binary is not executable: '{}'",
                binary_path.display()
            ));
        }
    }

    #[cfg(target_os = "macos")]
    {
        let expected_arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x86_64"
        };
        if let Ok(output) = std::process::Command::new("/usr/bin/lipo")
            .arg("-archs")
            .arg(binary_path)
            .output()
        {
            if output.status.success() {
                let archs = String::from_utf8_lossy(&output.stdout);
                if !archs.split_whitespace().any(|arch| arch == expected_arch) {
                    return Err(format!(
                        "Wrong architecture for '{}': expected {}, found {}",
                        binary_path.display(),
                        expected_arch,
                        archs.trim()
                    ));
                }
            }
        }
    }

    Ok(())
}

fn generate_remediation_hint(error: &str, _kind: &str) -> Option<String> {
    let lower = error.to_lowercase();
    if lower.contains("library not loaded") || lower.contains("dylib") {
        Some("A required system library is missing. Try reinstalling Firelink or run 'brew install openssl'.".to_string())
    } else if lower.contains("not found") || lower.contains("could not find") {
        Some("The bundled binary file is missing. Reinstall Firelink to restore it.".to_string())
    } else if lower.contains("timed out") {
        Some("The binary did not respond within the timeout. It may be damaged or incompatible with this system.".to_string())
    } else if lower.contains("permission denied") {
        Some("The binary does not have execute permission. Try reinstalling Firelink.".to_string())
    } else {
        None
    }
}

async fn check_aria2(app_handle: &tauri::AppHandle, port: u16, secret: &str) -> EngineStatusItem {
    let sidecar_name = "aria2c";
    let expected_sidecar = crate::platform::engine_binary_name(sidecar_name);

    let resolved = resolve_bundled_binary_path(app_handle, sidecar_name);
    let resolved_path = resolved
        .as_ref()
        .ok()
        .map(|p| crate::platform::display_path(p));

    let (startup_err, daemon_stderr) = {
        let guard = app_handle.state::<Aria2DaemonGuard>();
        let se = guard
            .startup_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let stderr = guard
            .last_stderr
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        (se, stderr)
    };
    let daemon_alive = startup_err.is_none();
    let last_stderr_tail = if daemon_stderr.is_empty() {
        None
    } else {
        Some(daemon_stderr)
    };

    let (version_raw, run_error, stderr_tail) =
        run_sidecar_version(app_handle, sidecar_name, &["--version"]).await;
    let version = version_raw.and_then(|v| v.lines().next().map(|l| l.trim().to_string()));

    let rpc_ready = if daemon_alive {
        rpc_call(port, secret, "aria2.getVersion", serde_json::json!([]))
            .await
            .is_ok()
    } else {
        false
    };

    let error = startup_err.or(run_error);
    let ready = daemon_alive && rpc_ready && version.is_some();
    let remediation_hint = error
        .as_ref()
        .and_then(|e| generate_remediation_hint(e, sidecar_name));

    EngineStatusItem {
        name: "Aria2".to_string(),
        kind: "aria2".to_string(),
        expected_sidecar,
        resolved_path,
        version,
        ready,
        error,
        stderr_tail,
        remediation_hint,
        rpc_port: Some(port),
        daemon_alive: Some(daemon_alive),
        rpc_ready: Some(rpc_ready),
        last_stderr_tail,
        expects_internal_dir: None,
        has_internal_dir: None,
        has_python_framework: None,
    }
}

async fn check_ytdlp(app_handle: &tauri::AppHandle) -> EngineStatusItem {
    let sidecar_name = "yt-dlp";
    let expected_sidecar = crate::platform::engine_binary_name(sidecar_name);

    let resolved = resolve_bundled_binary_path(app_handle, sidecar_name);
    let resolved_path = resolved
        .as_ref()
        .ok()
        .map(|p| crate::platform::display_path(p));

    let (has_internal_dir, has_python_runtime) = if let Ok(ref path) = resolved {
        let parent = path.parent().map(|p| p.to_path_buf());
        if let Some(parent) = parent {
            let internal =
                crate::engines::ytdlp_internal_dir(path).unwrap_or_else(|| parent.join("_internal"));
            let hi = internal.is_dir();
            let hp = hi && ytdlp_embedded_runtime_exists(&internal);
            (hi, hp)
        } else {
            (false, false)
        }
    } else {
        (false, false)
    };

    let (version_raw, run_error, stderr_tail) =
        run_sidecar_version(app_handle, sidecar_name, &["--version"]).await;
    let version = version_raw.and_then(|v| v.lines().next().map(|l| l.trim().to_string()));

    let mut error = run_error;
    let mut remediation_hint = None;

    if error.is_none() && has_internal_dir && !has_python_runtime {
        error = Some(yt_dlp_missing_runtime_message().to_string());
        remediation_hint = Some(
            "The yt-dlp distribution is missing its embedded Python runtime. Reinstall Firelink."
                .to_string(),
        );
    }

    if remediation_hint.is_none() {
        remediation_hint = error
            .as_ref()
            .and_then(|e| generate_remediation_hint(e, sidecar_name));
    }

    EngineStatusItem {
        name: "yt-dlp".to_string(),
        kind: "ytdlp".to_string(),
        expected_sidecar,
        resolved_path,
        version,
        ready: error.is_none(),
        error,
        stderr_tail,
        remediation_hint,
        rpc_port: None,
        daemon_alive: None,
        rpc_ready: None,
        last_stderr_tail: None,
        expects_internal_dir: has_internal_dir.then_some(true),
        has_internal_dir: has_internal_dir.then_some(true),
        has_python_framework: has_internal_dir.then_some(has_python_runtime),
    }
}

fn ytdlp_embedded_runtime_exists(internal: &std::path::Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        return std::fs::read_dir(internal)
            .ok()
            .into_iter()
            .flat_map(|entries| entries.flatten())
            .any(|entry| {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                name.starts_with("python")
                    && entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("dll"))
            });
    }

    #[cfg(target_os = "linux")]
    {
        return std::fs::read_dir(internal)
            .ok()
            .into_iter()
            .flat_map(|entries| entries.flatten())
            .any(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                name == "Python" || name.starts_with("libpython") && name.contains(".so")
            });
    }

    #[cfg(target_os = "macos")]
    {
        return internal.join("Python.framework").is_dir() || internal.join("Python").exists();
    }

    #[allow(unreachable_code)]
    false
}

fn yt_dlp_missing_runtime_message() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        return "_internal/python*.dll was not found beside yt-dlp sidecar";
    }

    #[cfg(target_os = "linux")]
    {
        return "_internal/libpython*.so was not found beside yt-dlp sidecar";
    }

    #[cfg(target_os = "macos")]
    {
        return "_internal/Python.framework was not found beside yt-dlp sidecar";
    }

    #[allow(unreachable_code)]
    "_internal Python runtime was not found beside yt-dlp sidecar"
}

async fn check_ffmpeg(app_handle: &tauri::AppHandle) -> EngineStatusItem {
    let sidecar_name = "ffmpeg";
    let expected_sidecar = crate::platform::engine_binary_name(sidecar_name);

    let resolved = resolve_bundled_binary_path(app_handle, sidecar_name);
    let resolved_path = resolved
        .as_ref()
        .ok()
        .map(|p| crate::platform::display_path(p));

    let (version_raw, run_error, stderr_tail) =
        run_sidecar_version(app_handle, sidecar_name, &["-version"]).await;
    let version = version_raw
        .as_ref()
        .and_then(|text| parse_ffmpeg_version(text));

    let error = run_error;
    let remediation_hint = error
        .as_ref()
        .and_then(|e| generate_remediation_hint(e, sidecar_name));

    EngineStatusItem {
        name: "FFmpeg".to_string(),
        kind: "ffmpeg".to_string(),
        expected_sidecar,
        resolved_path,
        version,
        ready: error.is_none(),
        error,
        stderr_tail,
        remediation_hint,
        rpc_port: None,
        daemon_alive: None,
        rpc_ready: None,
        last_stderr_tail: None,
        expects_internal_dir: None,
        has_internal_dir: None,
        has_python_framework: None,
    }
}

fn parse_ffmpeg_version(output: &str) -> Option<String> {
    let first = output.lines().next()?.trim();
    let token = first
        .split_whitespace()
        .collect::<Vec<_>>()
        .windows(2)
        .find_map(|window| {
            window[0]
                .eq_ignore_ascii_case("version")
                .then_some(window[1])
        })?;

    let without_url = token
        .split_once("-https://")
        .or_else(|| token.split_once("-http://"))
        .map(|(prefix, _)| prefix)
        .unwrap_or(token);

    if without_url.starts_with("N-") {
        return Some(without_url.to_string());
    }

    without_url
        .split('-')
        .next()
        .filter(|version| !version.trim().is_empty())
        .map(str::to_string)
}

async fn check_deno(app_handle: &tauri::AppHandle) -> EngineStatusItem {
    let sidecar_name = "deno";
    let expected_sidecar = crate::platform::engine_binary_name(sidecar_name);

    let resolved = resolve_bundled_binary_path(app_handle, sidecar_name);
    let resolved_path = resolved
        .as_ref()
        .ok()
        .map(|p| crate::platform::display_path(p));

    let (version_raw, run_error, stderr_tail) =
        run_sidecar_version(app_handle, sidecar_name, &["--version"]).await;
    let version = version_raw
        .as_ref()
        .and_then(|text| {
            let re = regex::Regex::new(r"deno\s+(\d+\.\d+\.\d+)").ok()?;
            re.captures(text)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_string())
        })
        .or(version_raw);

    let error = run_error;
    let remediation_hint = error
        .as_ref()
        .and_then(|e| generate_remediation_hint(e, sidecar_name));

    EngineStatusItem {
        name: "Deno".to_string(),
        kind: "deno".to_string(),
        expected_sidecar,
        resolved_path,
        version,
        ready: error.is_none(),
        error,
        stderr_tail,
        remediation_hint,
        rpc_port: None,
        daemon_alive: None,
        rpc_ready: None,
        last_stderr_tail: None,
        expects_internal_dir: None,
        has_internal_dir: None,
        has_python_framework: None,
    }
}

#[tauri::command]
async fn get_engine_status(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<EngineStatusResult, String> {
    properties_window::ensure_main_window(&caller)?;
    let port = state.aria2_port.load(std::sync::atomic::Ordering::Relaxed);
    let secret = state.aria2_secret.clone();

    let (aria2, ytdlp, ffmpeg, deno) = tokio::join!(
        check_aria2(&app_handle, port, &secret),
        check_ytdlp(&app_handle),
        check_ffmpeg(&app_handle),
        check_deno(&app_handle),
    );

    Ok(EngineStatusResult {
        engines: vec![aria2, ytdlp, ffmpeg, deno],
    })
}

#[tauri::command]
async fn get_aria2_engine_status(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<EngineStatusItem, String> {
    properties_window::ensure_main_window(&caller)?;
    Ok(check_aria2(
        &app_handle,
        state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
        &state.aria2_secret,
    )
    .await)
}

#[tauri::command]
async fn get_ytdlp_engine_status(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
) -> Result<EngineStatusItem, String> {
    properties_window::ensure_main_window(&caller)?;
    Ok(check_ytdlp(&app_handle).await)
}

#[tauri::command]
async fn get_ffmpeg_engine_status(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
) -> Result<EngineStatusItem, String> {
    properties_window::ensure_main_window(&caller)?;
    Ok(check_ffmpeg(&app_handle).await)
}

#[tauri::command]
async fn get_deno_engine_status(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
) -> Result<EngineStatusItem, String> {
    properties_window::ensure_main_window(&caller)?;
    Ok(check_deno(&app_handle).await)
}

fn resolve_bundled_binary_path(
    app_handle: &tauri::AppHandle,
    binary_name: &str,
) -> Result<std::path::PathBuf, String> {
    crate::engines::resolve_bundled_binary_path(app_handle, binary_name)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn start_media_download_internal(
    app_handle: tauri::AppHandle,
    id: &str,
    url: String,
    destination: String,
    filename: String,
    format_selector: Option<String>,
    connections: Option<i32>,
    cookie_source: Option<String>,
    speed_limit: Option<String>,
    username: Option<String>,
    password: Option<String>,
    headers: Option<String>,
    cookies: Option<String>,
    proxy: Option<String>,
    user_agent: Option<String>,
    max_tries: Option<i32>,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<std::path::PathBuf, String> {
    let safe_filename = crate::download_ownership::canonical_download_filename(&filename);

    let resolved_dest = resolve_path(&destination, &app_handle);

    if !is_safe_path(&resolved_dest, &app_handle) {
        return Err("Path traversal blocked".to_string());
    }

    if !resolved_dest.exists() {
        let _ = tokio::fs::create_dir_all(&resolved_dest).await;
    }

    let out_path = resolved_dest.join(&safe_filename);
    let output_template =
        media_output_template(&resolved_dest, &safe_filename, format_selector.as_deref());

    let total_tracks: f64 = if let Some(ref format) = format_selector {
        if format.contains('+') {
            2.0
        } else {
            1.0
        }
    } else {
        1.0
    };

    use tauri_plugin_shell::ShellExt;

    let mut config_file = tempfile::Builder::new()
        .prefix("ytdlp-")
        .suffix(".conf")
        .tempfile()
        .map_err(|e| e.to_string())?;
    let config_content = build_ytdlp_config_content(
        username.as_deref(),
        password.as_deref(),
        headers.as_deref(),
        cookies.as_deref(),
    )?;
    use std::io::Write;
    config_file
        .write_all(config_content.as_bytes())
        .map_err(|e| e.to_string())?;
    let config_path = config_file.into_temp_path();

    use crate::ipc::DownloadStateEvent;
    use crate::retry::{backoff_and_emit_cancel, is_transient_network_error, BackoffOutcome};

    const STDERR_TAIL: usize = 2048;

    let config_location = if !config_content.is_empty() {
        Some(config_path.to_string_lossy().to_string())
    } else {
        None
    };
    let _keep_alive = config_path;
    let mut progress_state = MediaProgressEmitterState::new();

    // Resolve absolute paths to bundled binaries
    let aria2c_path = resolve_bundled_binary_path(&app_handle, "aria2c")?;
    let ffmpeg_path = resolve_bundled_binary_path(&app_handle, "ffmpeg")?;
    let deno_path = resolve_bundled_binary_path(&app_handle, "deno")?;
    log::info!("Using bundled aria2c: {:?}", aria2c_path);
    log::info!("Using bundled ffmpeg: {:?}", ffmpeg_path);
    log::info!("Using bundled deno: {:?}", deno_path);

    // yt-dlp accepts an absolute path for its external downloader. Keep every
    // engine explicit so behavior never depends on PATH, symlink privileges,
    // user-installed tools, or platform-specific executable aliases.
    let trusted_path = crate::platform::trusted_system_path()?;

    let max_retries = max_tries
        .unwrap_or(crate::retry::MAX_RETRIES as i32)
        .max(0) as usize;
    let concurrent_fragments = normalize_media_connections(connections);
    let mut strike = 0_usize;
    let mut effective_cookie_source = cookie_source.clone();
    let mut browser_cookie_fallback_used = false;

    while strike <= max_retries {
        if *cancel_rx.borrow() {
            return Err(crate::queue::MEDIA_RUN_CANCELLED.to_string());
        }
        let mut processing_started = false;
        let ytdlp_path = resolve_bundled_binary_path(&app_handle, "yt-dlp")?;
        let mut cmd = app_handle.shell().command(&ytdlp_path);
        for arg in media_progress_args() {
            cmd = cmd.arg(arg);
        }
        cmd = cmd
            .arg("--socket-timeout")
            .arg("20")
            .arg("--retries")
            // Firelink owns the retry budget so `maxAutomaticRetries` means
            // the same thing for aria2 and media downloads. Letting yt-dlp
            // also consume that value would multiply the configured retry
            // count on every outer restart.
            .arg("0")
            .arg("--extractor-retries")
            .arg("0")
            .arg("--fragment-retries")
            .arg("0")
            .arg("--ffmpeg-location")
            .arg(&ffmpeg_path)
            .arg("--js-runtimes")
            .arg(format!("deno:{}", deno_path.to_string_lossy()))
            .arg("--concurrent-fragments")
            .arg(concurrent_fragments.to_string())
            .arg("--no-warnings")
            // Playlist expansion is owned by Firelink. Every persisted media
            // row must remain a single-video lifecycle, even when yt-dlp's
            // webpage URL still carries a playlist query parameter.
            .arg("--no-playlist")
            .arg("--continue")
            .arg("--compat-options")
            .arg("no-youtube-unavailable-videos")
            .arg("--print")
            .arg("after_move:%(filepath)s")
            .arg("-o")
            .arg(output_template.to_string_lossy().to_string())
            .env("PATH", &trusted_path);

        if let Some(limit) = speed_limit
            .as_deref()
            .and_then(normalize_speed_limit_for_aria2)
        {
            cmd = cmd.arg("--limit-rate").arg(limit);
        }

        if let Some(p) = proxy.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            if p.eq_ignore_ascii_case("none") {
                cmd = cmd.arg("--proxy").arg("");
            } else {
                cmd = cmd.arg("--proxy").arg(p);
            }
        }

        if let Some(cs) = effective_cookie_source.as_ref() {
            let mut cs = cs.clone();
            if !cs.is_empty() && cs != "none" {
                if cs == "safari" {
                    cs = "safari:".to_string()
                }
                cmd = cmd.arg("--cookies-from-browser").arg(cs);
            }
        }

        if let Some(ua) = user_agent.as_ref() {
            if !ua.is_empty() {
                cmd = cmd.arg("--user-agent").arg(ua);
            }
        }

        if let Some(loc) = config_location.as_ref() {
            cmd = cmd.arg("--config-location").arg(loc);
        }

        if let Some(format) = format_selector.as_ref() {
            cmd = cmd.arg("-f").arg(format);
            if safe_filename.ends_with(".mp3") {
                cmd = cmd.arg("-x").arg("--audio-format").arg("mp3");
            } else if safe_filename.ends_with(".m4a") {
                cmd = cmd.arg("-x").arg("--audio-format").arg("m4a");
            } else if safe_filename.ends_with(".opus") {
                cmd = cmd.arg("-x").arg("--audio-format").arg("opus");
            } else if safe_filename.ends_with(".mp4") {
                cmd = cmd.arg("--merge-output-format").arg("mp4");
            } else if safe_filename.ends_with(".webm") {
                cmd = cmd.arg("--merge-output-format").arg("webm");
            } else {
                // `--merge-output-format` only affects split video/audio
                // selections. A progressive MP4/WebM stream already includes
                // audio, so also request remuxing to keep an MKV option from
                // producing a mismatched file extension and container.
                cmd = cmd
                    .arg("--merge-output-format")
                    .arg("mkv")
                    .arg("--remux-video")
                    .arg("mkv");
            }
        }

        cmd = cmd.arg("--").arg(&url);

        if *cancel_rx.borrow() {
            return Err(crate::queue::MEDIA_RUN_CANCELLED.to_string());
        }

        let (mut rx, child) = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn yt-dlp: {}", e))?;
        if strike > 0 {
            // The backoff path emits `Retrying`. Restore the live transfer
            // state when the replacement process actually starts so React
            // accepts progress from this attempt instead of staying stuck.
            progress_state.speed_sampler.reset();
            let _ = app_handle.emit(
                "download-state",
                DownloadStateEvent::new(id, crate::ipc::DownloadStatus::Downloading),
            );
        }
        log::info!("yt-dlp spawned for id: {} (strike {})", id, strike);

        let mut stderr_tail = String::new();
        let mut final_output_path: Option<std::path::PathBuf> = None;
        let mut stdout_buffer = String::new();
        let mut stderr_buffer = String::new();
        let failure_reason = loop {
            tokio::select! {
                _ = cancel_rx.changed() => {
                    terminate_shell_process_tree(child);
                    if processing_started {
                        cleanup_media_processing_artifacts(&out_path).await;
                    }
                    return Err(crate::queue::MEDIA_RUN_CANCELLED.to_string());
                }
                event = rx.recv() => {
                    match event {
                        Some(tauri_plugin_shell::process::CommandEvent::Stdout(line_bytes)) => {
                            let chunk = String::from_utf8_lossy(&line_bytes);
                            for line in drain_media_output_lines(&mut stdout_buffer, &chunk) {
                                if let Some(progress) = parse_media_progress_line(&line) {
                                    emit_media_progress(
                                        &app_handle,
                                        id,
                                        progress,
                                        total_tracks,
                                        &mut progress_state,
                                    );
                                } else {
                                    let candidate = line.trim();
                                    if !candidate.is_empty() {
                                        let candidate_path = std::path::PathBuf::from(candidate);
                                        if candidate_path.is_absolute() {
                                            final_output_path = Some(candidate_path);
                                        }
                                    }
                                }
                            }
                        }
                        Some(tauri_plugin_shell::process::CommandEvent::Stderr(line_bytes)) => {
                            let chunk = String::from_utf8_lossy(&line_bytes);
                            stderr_tail.push_str(&chunk);
                            if stderr_tail.len() > STDERR_TAIL {
                                stderr_tail = stderr_tail.split_off(stderr_tail.len() - STDERR_TAIL);
                            }
                            for line in drain_media_output_lines(&mut stderr_buffer, &chunk) {
                                if let Some(progress) = parse_media_progress_line(&line) {
                                    emit_media_progress(
                                        &app_handle,
                                        id,
                                        progress,
                                        total_tracks,
                                        &mut progress_state,
                                    );
                                }
                                if !processing_started && is_media_processing_line(&line) {
                                    processing_started = true;
                                    let _ = app_handle.emit(
                                        "download-state",
                                        DownloadStateEvent::new(
                                            id,
                                            crate::ipc::DownloadStatus::Processing,
                                        ),
                                    );
                                    let _ = app_handle.emit("download-progress", DownloadProgressEvent {
                                        id: id.to_string(),
                                        fraction: 1.0,
                                        speed: "Processing".to_string(),
                                        eta: "-".to_string(),
                                        size: None,
                                        size_is_final: false,
                                        downloaded_bytes: None,
                                        total_bytes: None,
                                        total_is_estimate: Some(false),
                                        active_connections: None,
                                        requested_connections: None,
                                        uploaded_bytes: None,
                                        upload_speed: None,
                                        num_seeders: None,
                                        torrent_seeded_seconds: None,
                                    });
                                }
                                let lower = line.to_lowercase();
                                if lower.contains("error") || lower.contains("critical") {
                                    log::error!("yt-dlp stderr [{}]: {}", id, line.trim());
                                }
                            }
                        }
                        Some(tauri_plugin_shell::process::CommandEvent::Error(err)) => {
                            log::error!("yt-dlp shell error [{}]: {}", id, err);
                            break err;
                        }
                        Some(tauri_plugin_shell::process::CommandEvent::Terminated(payload)) => {
                            if let Some(line) = flush_media_output_line(&mut stdout_buffer) {
                                if let Some(progress) = parse_media_progress_line(&line) {
                                    emit_media_progress(
                                        &app_handle,
                                        id,
                                        progress,
                                        total_tracks,
                                        &mut progress_state,
                                    );
                                } else {
                                    let candidate = line.trim();
                                    if !candidate.is_empty() {
                                        let candidate_path = std::path::PathBuf::from(candidate);
                                        if candidate_path.is_absolute() {
                                            final_output_path = Some(candidate_path);
                                        }
                                    }
                                }
                            }
                            if let Some(line) = flush_media_output_line(&mut stderr_buffer) {
                                if let Some(progress) = parse_media_progress_line(&line) {
                                    emit_media_progress(
                                        &app_handle,
                                        id,
                                        progress,
                                        total_tracks,
                                        &mut progress_state,
                                    );
                                }
                                if !processing_started && is_media_processing_line(&line) {
                                    let _ = app_handle.emit(
                                        "download-state",
                                        DownloadStateEvent::new(
                                            id,
                                            crate::ipc::DownloadStatus::Processing,
                                        ),
                                    );
                                }
                            }
                            if payload.code == Some(0) {
                                log::info!("yt-dlp completed successfully id: {}", id);
                                let completed_path = final_output_path
                                    .as_ref()
                                    .filter(|path| path.is_file())
                                    .cloned()
                                    .unwrap_or_else(|| out_path.clone());
                                if let Ok(metadata) = tokio::fs::metadata(&completed_path).await {
                                    if metadata.is_file() {
                                        let _ = app_handle.emit("download-progress", DownloadProgressEvent {
                                            id: id.to_string(),
                                            fraction: 1.0,
                                            speed: "-".to_string(),
                                            eta: "-".to_string(),
                                            size: Some(crate::download::format_size(metadata.len() as f64)),
                                            size_is_final: true,
                                            downloaded_bytes: Some(metadata.len() as f64),
                                            total_bytes: Some(metadata.len() as f64),
                                            total_is_estimate: Some(false),
                                            active_connections: None,
                                            requested_connections: None,
                                            uploaded_bytes: None,
                                            upload_speed: None,
                                            num_seeders: None,
                                            torrent_seeded_seconds: None,
                                        });
                                    }
                                }
                                return Ok(completed_path);
                            }
                            log::error!("yt-dlp exited with non-zero code {:?} for id: {}", payload.code, id);
                            break if stderr_tail.is_empty() {
                                format!("yt-dlp exited with code {:?}", payload.code)
                            } else {
                                stderr_tail.clone()
                            };
                        }
                        Some(_) => {}
                        None => {
                            break if stderr_tail.is_empty() {
                                "yt-dlp process ended unexpectedly".to_string()
                            } else {
                                stderr_tail.clone()
                            };
                        }
                    }
                }
            }
        };

        let transient = is_transient_network_error(&failure_reason);
        let strikes_left = strike < max_retries;
        if should_cleanup_media_artifacts_after_failure(&failure_reason, strike, max_retries) {
            cleanup_media_artifacts(&out_path, false).await;
        }
        if should_retry_without_browser_cookies(
            effective_cookie_source.as_deref(),
            &failure_reason,
            browser_cookie_fallback_used,
        )
        {
            let source = effective_cookie_source.clone().unwrap_or_default();
            log::warn!(
                "yt-dlp could not read browser cookies from {}; retrying media download without browser cookies",
                source
            );
            effective_cookie_source = None;
            browser_cookie_fallback_used = true;
            continue;
        }
        if !(transient && strikes_left) {
            return Err(failure_reason);
        }

        let reason = failure_reason.clone();
        let outcome = backoff_and_emit_cancel(strike, reason, cancel_rx, |retry_reason| {
            let _ = app_handle.emit(
                "download-state",
                DownloadStateEvent::retrying(id, retry_reason),
            );
        })
        .await;

        if outcome == BackoffOutcome::Aborted {
            return Err(crate::queue::MEDIA_RUN_CANCELLED.to_string());
        }

        strike += 1;
    }

    Err("yt-dlp retry loop exhausted".to_string())
}

#[tauri::command]
async fn pause_download(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    log::info!("pause_download called for id: {}", id);

    let _control_guard = state.queue_manager.acquire_aria2_control(&id).await;
    let active_kind = state.queue_manager.active_kind(&id).await;
    let registered_lifecycle_generation = state
        .queue_manager
        .registered_lifecycle_generation(&id)
        .await;
    let media_lifecycle_generation = registered_lifecycle_generation.unwrap_or_default();
    let removed_pending = state.queue_manager.remove_from_pending(&id).await;

    let gid = state.queue_manager.aria2_gid_for_download(&id);
    if let Some(gid) = gid.as_deref() {
        let status = aria2_download_status(
            state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
            &state.aria2_secret,
            gid,
        )
        .await?;
        match status.as_str() {
            "paused" => {
                state.queue_manager.next_aria2_control_epoch(&id).await;
                state.queue_manager.cancel_aria2_retries(&id).await;
                log::info!("aria2 pause [{}]: gid {} was already paused", id, gid);
            }
            "active" | "waiting" => {
                state.queue_manager.cancel_aria2_retries(&id).await;
                let pause_result = match rpc_call(
                    state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
                    &state.aria2_secret,
                    "aria2.forcePause",
                    serde_json::json!([gid]),
                )
                .await
                {
                    Ok(result) => ensure_aria2_gid_result("forcePause", gid, &result),
                    Err(error) => Err(format!("failed to pause aria2 gid {gid}: {error}")),
                };
                if let Err(pause_error) = pause_result {
                    match aria2_download_status(
                        state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
                        &state.aria2_secret,
                        gid,
                    )
                    .await
                    {
                        Ok(status) if status == "paused" => {
                            // forcePause may have returned an RPC error after
                            // the daemon actually paused the GID. Invalidate
                            // terminal events already in flight before
                            // preserving the resumable mapping.
                            state.queue_manager.next_aria2_control_epoch(&id).await;
                            state.queue_manager.cancel_aria2_retries(&id).await;
                            log::info!(
                                "aria2 pause [{}]: forcePause failed but gid {} is paused",
                                id,
                                gid
                            );
                        }
                        Ok(status) if status == "complete" => {
                            state
                                .queue_manager
                                .apply_completion_locked(&id, crate::queue::PendingOutcome::Complete)
                                .await;
                            return Ok(());
                        }
                        Ok(status) if matches!(status.as_str(), "error" | "removed") => {
                            let terminal_error = format!(
                                "cannot pause aria2 gid {gid}: {pause_error}; daemon reports terminal state {status}"
                            );
                            state
                                .queue_manager
                                .apply_completion_locked(
                                    &id,
                                    crate::queue::PendingOutcome::Error(terminal_error.clone()),
                                )
                                .await;
                            return Err(terminal_error);
                        }
                        Ok(status) => {
                            state.queue_manager.allow_aria2_retries(&id).await;
                            return Err(format!(
                                "{pause_error}; aria2 gid {gid} is still {status}"
                            ));
                        }
                        Err(status_error) => {
                            state.queue_manager.allow_aria2_retries(&id).await;
                            return Err(format!(
                                "{pause_error}; failed to verify aria2 gid {gid}: {status_error}"
                            ));
                        }
                    }
                }
                state.queue_manager.next_aria2_control_epoch(&id).await;
                log::info!("aria2 pause [{}]: gid {} paused", id, gid);
            }
            "complete" => {
                // Aria2 can reach complete before its terminal event updates
                // Firelink's row. Treat a pause request in that narrow window
                // as an idempotent completion reconciliation, not as an
                // actionable pause failure.
                log::info!(
                    "aria2 pause [{}]: gid {} was already complete; reconciling completion",
                    id,
                    gid
                );
                state
                    .queue_manager
                    .apply_completion_locked(&id, crate::queue::PendingOutcome::Complete)
                    .await;
                return Ok(());
            }
            terminal => {
                let retrying = state.queue_manager.has_aria2_retry_state(&id).await;
                state.queue_manager.clear_aria2_retry_state(&id).await;
                state.queue_manager.forget_aria2_gid(&id).await;
                state.queue_manager.release_permit(&id).await;
                state.queue_manager.next_aria2_control_epoch(&id).await;
                state.queue_manager.cancel_aria2_retries(&id).await;
                if retrying && matches!(terminal, "error" | "removed") {
                    // The terminal GID was forgotten above, so this
                    // lifecycle can no longer be resumed in place. Release
                    // backend ownership as well; otherwise a paused row
                    // keeps a dead registration until another command happens
                    // to repair it.
                    state.queue_manager.release_registered_id(&id).await;
                    use tauri::Emitter;
                    let _ = app_handle.emit(
                        "download-state",
                        crate::ipc::DownloadStateEvent::new(
                            id,
                            crate::ipc::DownloadStatus::Paused,
                        ),
                    );
                    return Ok(());
                }
                state.queue_manager.release_registered_id(&id).await;
                return Err(format!(
                    "cannot pause aria2 gid {gid} in terminal state {terminal}"
                ));
            }
        }

        let seed_remaining = if state.queue_manager.is_seed_owner(&id) {
            state.queue_manager.capture_seed_remaining(&id).await
        } else {
            None
        };
        state.queue_manager.release_seed_tracking(&id);
        state.queue_manager.release_permit(&id).await;
        use tauri::Emitter;
        let _ = app_handle.emit(
            "download-state",
            crate::ipc::DownloadStateEvent::paused_with_seed_remaining(id, seed_remaining),
        );
        return Ok(());
    }

    // A terminal runner may have already released its lifecycle while this
    // command was waiting for the per-download control lock. Treat pause as
    // an idempotent no-op instead of emitting a stale Paused state.
    if active_kind.is_none() && !removed_pending && registered_lifecycle_generation.is_none() {
        return Ok(());
    }

    if matches!(active_kind, Some(crate::queue::TaskKind::Aria2)) {
        state.queue_manager.next_aria2_control_epoch(&id).await;
        state.queue_manager.cancel_aria2_retries(&id).await;
        state.queue_manager.clear_aria2_retry_state(&id).await;
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    if matches!(active_kind, Some(crate::queue::TaskKind::Media)) {
        state
            .download_coordinator
            .pause_media_with_ack(id.clone(), media_lifecycle_generation, tx)
            .await?;
    } else {
        let _ = tx.send(false);
    }
    let media_was_registered = rx
        .await
        .map_err(|_| "download worker stopped without acknowledging pause".to_string())?;
    if matches!(active_kind, Some(crate::queue::TaskKind::Media)) && !media_was_registered {
        // No media runner reached the coordinator. The queue control lock is
        // still held, and run_media now checks the same lifecycle generation
        // before registration, so this tombstone can be retired safely.
        state
            .download_coordinator
            .finish_media(id.clone(), media_lifecycle_generation)
            .await;
    }

    let seed_remaining = if state.queue_manager.is_seed_owner(&id) {
        state.queue_manager.capture_seed_remaining(&id).await
    } else {
        None
    };
    state.queue_manager.release_seed_tracking(&id);
    state.queue_manager.release_permit(&id).await;
    if registered_lifecycle_generation.is_some()
        || removed_pending
        || matches!(active_kind, Some(crate::queue::TaskKind::Aria2))
    {
        if let Some(generation) = registered_lifecycle_generation {
            state
                .queue_manager
                .release_registered_id_for_generation(&id, generation)
                .await;
        } else {
            state.queue_manager.release_registered_id(&id).await;
        }
    }
    use tauri::Emitter;
    let _ = app_handle.emit(
        "download-state",
        crate::ipc::DownloadStateEvent::paused_with_seed_remaining(id, seed_remaining),
    );
    Ok(())
}

#[tauri::command]
async fn resume_download(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    queue_id: String,
) -> Result<bool, String> {
    properties_window::ensure_main_window(&caller)?;
    let queue_id = queue_id.trim().to_string();
    if queue_id.is_empty() {
        return Err("Queue id cannot be empty".to_string());
    }
    let control_guard = state.queue_manager.acquire_aria2_control(&id).await;
    let Some(gid) = state.queue_manager.aria2_gid_for_download(&id) else {
        log::info!(
            "aria2 resume [{}]: no mapped gid; re-enqueue is permitted",
            id
        );
        state.queue_manager.next_aria2_control_epoch(&id).await;
        state.queue_manager.cancel_aria2_retries(&id).await;
        state.queue_manager.clear_aria2_retry_state(&id).await;
        state.queue_manager.release_permit(&id).await;
        state.queue_manager.release_registered_id(&id).await;
        return Ok(false);
    };
    if state.queue_manager.is_waiting_to_seed(&id) {
        // WaitingToSeed is an intentional paused GID with no download
        // permit. A resume request only wakes the Firelink seed scheduler;
        // it must not bypass the seed-slot admission gate.
        state.queue_manager.wake_seed_waiters();
        drop(control_guard);
        return Ok(true);
    }
    let status = aria2_download_status(
        state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
        &state.aria2_secret,
        &gid,
    )
    .await?;
    match status.as_str() {
        "paused" => {
            let control_epoch = state.queue_manager.next_aria2_control_epoch(&id).await;
            let lifecycle_generation = state
                .queue_manager
                .registered_lifecycle_generation(&id)
                .await
                .unwrap_or_default();
            state.queue_manager.allow_aria2_retries(&id).await;
            state.queue_manager.reset_aria2_retry_strikes(&id).await;
            use tauri::Emitter;
            let _ = app_handle.emit(
                "download-state",
                crate::ipc::DownloadStateEvent::new(&id, crate::ipc::DownloadStatus::Queued),
            );

            let queue_manager = state.queue_manager.clone();
            let aria2_port = state.aria2_port.load(std::sync::atomic::Ordering::Relaxed);
            let aria2_secret = state.aria2_secret.clone();
            let id_clone = id.clone();
            let gid_clone = gid.clone();

            let app_handle_clone = app_handle.clone();
            drop(control_guard);
            tauri::async_runtime::spawn(async move {
                let had_permit = queue_manager.has_active_permit(&id_clone).await;
                let permit_candidate = if had_permit {
                    None
                } else {
                    queue_manager
                        .acquire_aria2_permit_candidate_for_queue(
                            &id_clone,
                            &queue_id,
                            lifecycle_generation,
                            control_epoch,
                        )
                        .await
                };
                if permit_candidate.is_none() && !had_permit {
                    return;
                }
                let _control_guard = queue_manager.acquire_aria2_control(&id_clone).await;
                let current_epoch = queue_manager
                    .is_aria2_control_epoch_current(&id_clone, control_epoch)
                    .await;
                if queue_manager.is_aria2_retry_cancelled(&id_clone).await
                    || !current_epoch
                    || queue_manager.aria2_gid_for_download(&id_clone).as_deref()
                        != Some(gid_clone.as_str())
                    || !queue_manager.is_registered(&id_clone).await
                {
                    if permit_candidate.is_some() {
                        queue_manager
                            .release_aria2_permit_candidate(&id_clone, lifecycle_generation)
                            .await;
                    }
                    return;
                }
                if !queue_manager
                    .rebind_aria2_gid_epoch(&id_clone, &gid_clone, control_epoch)
                    .await
                {
                    if permit_candidate.is_some() {
                        queue_manager
                            .release_aria2_permit_candidate(&id_clone, lifecycle_generation)
                            .await;
                    }
                    log::warn!(
                        "aria2 resume [{}]: gid {} disappeared before lifecycle rebind",
                        id_clone,
                        gid_clone
                    );
                    return;
                }
                if let Some(permit) = permit_candidate {
                    let parked = queue_manager
                        .park_aria2_permit_if_missing_for_queue(
                            &id_clone,
                            &queue_id,
                            lifecycle_generation,
                            permit,
                        )
                        .await;
                    if !parked {
                        queue_manager
                            .release_aria2_permit_candidate(&id_clone, lifecycle_generation)
                            .await;
                        log::warn!(
                            "aria2 resume [{}]: permit ownership was not established before unpause; leaving gid {} paused",
                            id_clone,
                            gid_clone
                        );
                        return;
                    }
                }
                let unpause_error = match rpc_call(
                    aria2_port,
                    &aria2_secret,
                    "aria2.unpause",
                    serde_json::json!([gid_clone]),
                )
                .await
                {
                    Ok(result) => ensure_aria2_gid_result("unpause", &gid_clone, &result)
                        .err()
                        .map(|error| error.to_string()),
                    Err(error) => Some(format!("failed to resume aria2 gid {gid_clone}: {error}")),
                };
                if let Some(unpause_error) = unpause_error {
                    match verify_aria2_resume_status(aria2_port, &aria2_secret, &gid_clone).await {
                        Ok(status) if matches!(status.as_str(), "active" | "waiting") => {
                            let still_current = queue_manager
                                .is_aria2_control_epoch_current(&id_clone, control_epoch)
                                .await
                                && queue_manager.aria2_gid_for_download(&id_clone).as_deref()
                                    == Some(gid_clone.as_str());
                            if !still_current {
                                let _ = rpc_call(
                                    aria2_port,
                                    &aria2_secret,
                                    "aria2.forcePause",
                                    serde_json::json!([gid_clone]),
                                )
                                .await;
                                return;
                            }
                            use tauri::Emitter;
                            let _ = app_handle_clone.emit(
                                "download-state",
                                crate::ipc::DownloadStateEvent::new(
                                    &id_clone,
                                    crate::ipc::DownloadStatus::Downloading,
                                ),
                            );
                            log::warn!(
                                "aria2 resume [{}]: {} but daemon reports gid {} as {}; retaining permit",
                                id_clone,
                                unpause_error,
                                gid_clone,
                                status
                            );
                            return;
                        }
                        Ok(status) if status == "complete" => {
                            log::info!(
                                "aria2 resume [{}]: {} but daemon reports gid {} complete; reconciling completion",
                                id_clone,
                                unpause_error,
                                gid_clone
                            );
                            queue_manager
                                .apply_completion_locked(
                                    &id_clone,
                                    crate::queue::PendingOutcome::Complete,
                                )
                                .await;
                            return;
                        }
                        Ok(status) if status == "paused" => {
                            queue_manager.next_aria2_control_epoch(&id_clone).await;
                            queue_manager.cancel_aria2_retries(&id_clone).await;
                            queue_manager.release_permit(&id_clone).await;
                            log::error!(
                                "aria2 resume [{}]: {}; daemon kept gid {} paused",
                                id_clone,
                                unpause_error,
                                gid_clone
                            );
                            let _ = app_handle_clone.emit(
                                "download-state",
                                crate::ipc::DownloadStateEvent::paused_with_error(
                                    &id_clone,
                                    unpause_error,
                                ),
                            );
                            return;
                        }
                        Ok(status) if matches!(status.as_str(), "error" | "removed") => {
                            let terminal_error = format!(
                                "{unpause_error}; daemon reports gid {gid_clone} as {status}"
                            );
                            queue_manager
                                .apply_completion_locked(
                                    &id_clone,
                                    crate::queue::PendingOutcome::Error(terminal_error),
                                )
                                .await;
                            return;
                        }
                        Ok(status) => {
                            // An unrecognized daemon state is not proof that
                            // the transfer stopped. Keep its permit and
                            // mapping so a later reconciliation can observe
                            // the real terminal state.
                            log::error!(
                                "aria2 resume [{}]: {}; daemon reports gid {} as {}; retaining permit",
                                id_clone,
                                unpause_error,
                                gid_clone,
                                status
                            );
                            return;
                        }
                        Err(status_error) => {
                            log::error!(
                                "aria2 resume [{}]: {}; could not verify gid {} after the RPC failure: {}; retaining permit",
                                id_clone,
                                unpause_error,
                                gid_clone,
                                status_error
                            );
                            return;
                        }
                    }
                }
                // A successful unpause RPC is not itself the postcondition:
                // aria2 may still report the GID as paused, complete, or
                // otherwise unavailable. Verify the daemon state before
                // publishing Downloading to the renderer.
                let status_after_unpause = match verify_aria2_resume_status(
                    aria2_port,
                    &aria2_secret,
                    &gid_clone,
                )
                .await
                {
                    Ok(status) => status,
                    Err(error) => {
                        log::error!(
                            "aria2 resume [{}]: unpause succeeded but gid {} could not be verified: {}; retaining permit",
                            id_clone,
                            gid_clone,
                            error
                        );
                        return;
                    }
                };
                match status_after_unpause.as_str() {
                    "active" | "waiting" => {}
                    "complete" => {
                        queue_manager
                            .apply_completion_locked(
                                &id_clone,
                                crate::queue::PendingOutcome::Complete,
                            )
                            .await;
                        return;
                    }
                    "error" | "removed" => {
                        let terminal_error = format!(
                            "aria2 resume left gid {gid_clone} in terminal state {status_after_unpause}"
                        );
                        queue_manager
                            .apply_completion_locked(
                                &id_clone,
                                crate::queue::PendingOutcome::Error(terminal_error),
                            )
                            .await;
                        return;
                    }
                    "paused" => {
                        queue_manager.next_aria2_control_epoch(&id_clone).await;
                        queue_manager.cancel_aria2_retries(&id_clone).await;
                        queue_manager.release_permit(&id_clone).await;
                        let error = "aria2 kept the download paused after resume".to_string();
                        log::error!(
                            "aria2 resume [{}]: {}; gid {} remains paused",
                            id_clone,
                            error,
                            gid_clone
                        );
                        let _ = app_handle_clone.emit(
                            "download-state",
                            crate::ipc::DownloadStateEvent::paused_with_error(&id_clone, error),
                        );
                        return;
                    }
                    other => {
                        log::error!(
                            "aria2 resume [{}]: unpause left gid {} in unexpected state {}; retaining permit",
                            id_clone,
                            gid_clone,
                            other
                        );
                        return;
                    }
                }

                let current_epoch = queue_manager
                    .is_aria2_control_epoch_current(&id_clone, control_epoch)
                    .await;
                if queue_manager.is_aria2_retry_cancelled(&id_clone).await
                    || !current_epoch
                    || queue_manager.aria2_gid_for_download(&id_clone).as_deref()
                        != Some(gid_clone.as_str())
                {
                    let _ = rpc_call(
                        aria2_port,
                        &aria2_secret,
                        "aria2.forcePause",
                        serde_json::json!([gid_clone]),
                    )
                    .await;
                    return;
                }
                use tauri::Emitter;
                let _ = app_handle_clone.emit(
                    "download-state",
                    crate::ipc::DownloadStateEvent::new(
                        &id_clone,
                        crate::ipc::DownloadStatus::Downloading,
                    ),
                );
                log::info!("aria2 resume [{}]: unpaused gid {}", id_clone, gid_clone);
            });
            Ok(true)
        }
        "active" | "waiting" => {
            let resume_epoch = state.queue_manager.current_aria2_control_epoch(&id).await;
            let lifecycle_generation = state
                .queue_manager
                .registered_lifecycle_generation(&id)
                .await
                .unwrap_or_default();
            drop(control_guard);
            state.queue_manager.allow_aria2_retries(&id).await;
            let queue_manager = state.queue_manager.clone();
            let id_clone = id.clone();
            let gid_clone = gid.clone();
            let queue_id_clone = queue_id.clone();
            let app_handle_clone = app_handle.clone();
            let status_for_log = status.to_string();
            tauri::async_runtime::spawn(async move {
                let had_permit = queue_manager.has_active_permit(&id_clone).await;
                let permit_candidate = if had_permit {
                    None
                } else {
                    queue_manager
                        .acquire_aria2_permit_candidate_for_queue(
                            &id_clone,
                            &queue_id_clone,
                            lifecycle_generation,
                            resume_epoch,
                        )
                        .await
                };
                let had_permit_candidate = permit_candidate.is_some();
                if permit_candidate.is_none() && !had_permit {
                    return;
                }

                let _control_guard = queue_manager.acquire_aria2_control(&id_clone).await;
                let still_current = queue_manager.is_registered(&id_clone).await
                    && !queue_manager.is_aria2_retry_cancelled(&id_clone).await
                    && queue_manager
                        .is_aria2_control_epoch_current(&id_clone, resume_epoch)
                        .await
                    && queue_manager.aria2_gid_for_download(&id_clone).as_deref()
                        == Some(gid_clone.as_str());
                if !still_current {
                    if had_permit_candidate {
                        queue_manager
                            .release_aria2_permit_candidate(&id_clone, lifecycle_generation)
                            .await;
                    }
                    return;
                }

                if let Some(permit) = permit_candidate {
                    let parked = queue_manager
                        .park_aria2_permit_if_missing_for_queue(
                            &id_clone,
                            &queue_id_clone,
                            lifecycle_generation,
                            permit,
                        )
                        .await;
                    if !parked && !queue_manager.has_active_permit(&id_clone).await {
                        queue_manager
                            .release_aria2_permit_candidate(&id_clone, lifecycle_generation)
                            .await;
                        return;
                    }
                }
                log::info!(
                    "aria2 resume [{}]: gid {} already {}; no duplicate job created",
                    id_clone,
                    gid_clone,
                    status_for_log
                );
                use tauri::Emitter;
                let _ = app_handle_clone.emit(
                    "download-state",
                    crate::ipc::DownloadStateEvent::new(
                        &id_clone,
                        crate::ipc::DownloadStatus::Downloading,
                    ),
                );
            });
            Ok(true)
        }
        "complete" | "error" | "removed" => {
            drop(control_guard);
            state.queue_manager.next_aria2_control_epoch(&id).await;
            state.queue_manager.cancel_aria2_retries(&id).await;
            state.queue_manager.clear_aria2_retry_state(&id).await;
            state.queue_manager.forget_aria2_gid(&id).await;
            state.queue_manager.release_permit(&id).await;
            state.queue_manager.release_registered_id(&id).await;
            log::info!(
                "aria2 resume [{}]: gid {} is {}; re-enqueue is permitted",
                id,
                gid,
                status
            );
            Ok(false)
        }
        other => {
            drop(control_guard);
            Err(format!("aria2 gid {gid} returned unknown status {other}"))
        }
    }
}

#[tauri::command]
async fn remove_download(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    delete_assets: bool,
    preserve_resumable: Option<bool>,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    log::info!("remove_download called for id: {}", id);
    let preserve_resumable = preserve_resumable.unwrap_or(false);
    let control_guard = state.queue_manager.acquire_aria2_control(&id).await;

    let active_kind = state.queue_manager.active_kind(&id).await;
    let registered_lifecycle_generation = state
        .queue_manager
        .registered_lifecycle_generation(&id)
        .await;
    let media_lifecycle_generation = registered_lifecycle_generation.unwrap_or_default();
    if let Some(generation) = registered_lifecycle_generation {
        state
            .queue_manager
            .remove_from_pending_for_generation(&id, generation)
            .await;
    } else {
        state.queue_manager.remove_from_pending(&id).await;
    }

    let gid = state.queue_manager.aria2_gid_for_download(&id);
    if let Some(gid) = gid.as_deref() {
        if let Err(error) = state
            .queue_manager
            .reconcile_aria2_torrent_ownership(&id, gid)
            .await
        {
            log::debug!(
                "aria2 torrent ownership [{}]: could not resolve files before removal of gid {}: {}",
                id,
                gid,
                error
            );
        }
        // Keep the current epoch and mapping alive until daemon removal is
        // confirmed. If removal fails, terminal events from this lifecycle
        // must still be accepted so the permit and mapping can be cleaned up.
        state.queue_manager.cancel_aria2_retries(&id).await;
        let removal_result = async {
            force_remove_aria2_gid(
                state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
                &state.aria2_secret,
                gid,
            )
            .await?;
            wait_for_aria2_stopped(
                state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
                &state.aria2_secret,
                gid,
            )
            .await
        }
        .await;
        if let Err(error) = removal_result {
            state.queue_manager.allow_aria2_retries(&id).await;
            return Err(error);
        }
        state.queue_manager.next_aria2_control_epoch(&id).await;
        state.queue_manager.clear_aria2_retry_state(&id).await;
        state.queue_manager.forget_torrent_telemetry(&id).await;
        state.queue_manager.forget_aria2_gid(&id).await;
        state.queue_manager.release_permit(&id).await;
        log::info!("aria2 remove [{}]: gid {} stopped and forgotten", id, gid);
    } else {
        // There may be an addUri or retry handoff in flight with no mapped
        // GID yet. Invalidate that pending lifecycle before acknowledging the
        // removal so its late result cannot resurrect the download.
        let removal_epoch = state.queue_manager.next_aria2_control_epoch(&id).await;
        state.queue_manager.cancel_aria2_retries(&id).await;
        let (tx, rx) = tokio::sync::oneshot::channel();
        if matches!(active_kind, Some(crate::queue::TaskKind::Media)) {
            state
                .download_coordinator
                .pause_media_with_ack(id.clone(), media_lifecycle_generation, tx)
                .await?;
        } else {
            let _ = tx.send(false);
        }
        let media_was_registered = rx.await.unwrap_or(false);
        if matches!(active_kind, Some(crate::queue::TaskKind::Media)) && !media_was_registered {
            state
                .download_coordinator
                .finish_media(id.clone(), media_lifecycle_generation)
                .await;
        }

        // The initial addUri call intentionally runs outside the control lock.
        // Do not delete the guessed magnet path and ownership record until a
        // late GID has been removed; otherwise the daemon can finish creating
        // an output after cleanup and leave an untracked file behind.
        drop(control_guard);
        state.queue_manager.wait_for_aria2_dispatch(&id).await;
        let _control_guard = state.queue_manager.acquire_aria2_control(&id).await;
        let current_generation = state
            .queue_manager
            .registered_lifecycle_generation(&id)
            .await;
        let lifecycle_changed = registered_lifecycle_generation.is_some()
            && current_generation != registered_lifecycle_generation
            || registered_lifecycle_generation.is_none() && current_generation.is_some();
        if lifecycle_changed {
            state
                .queue_manager
                .release_permit_for_generation(&id, media_lifecycle_generation)
                .await;
            return Err("download lifecycle changed while waiting for aria2 dispatch".to_string());
        }
        if let Some(late_gid) = state.queue_manager.aria2_gid_for_download(&id) {
            if let Err(error) = state
                .queue_manager
                .reconcile_aria2_torrent_ownership(&id, &late_gid)
                .await
            {
                log::debug!(
                    "aria2 remove [{}]: could not resolve files for late gid {}: {}",
                    id,
                    late_gid,
                    error
                );
            }
            let removal_result = async {
                force_remove_aria2_gid(
                    state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
                    &state.aria2_secret,
                    &late_gid,
                )
                .await?;
                wait_for_aria2_stopped(
                    state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
                    &state.aria2_secret,
                    &late_gid,
                )
                .await
            }
            .await;
            if let Err(error) = removal_result {
                state.queue_manager.allow_aria2_retries(&id).await;
                return Err(error);
            }
            state.queue_manager.next_aria2_control_epoch(&id).await;
            state.queue_manager.clear_aria2_retry_state(&id).await;
            state.queue_manager.forget_torrent_telemetry(&id).await;
            state.queue_manager.forget_aria2_gid(&id).await;
        } else if !state
            .queue_manager
            .is_aria2_control_epoch_current(&id, removal_epoch)
            .await
        {
            // A same-generation pause/resume control action may advance the
            // epoch while the late add is being retired. Removal still owns
            // the registered row, so fence that action before cleaning it.
            state.queue_manager.next_aria2_control_epoch(&id).await;
        }
        state.queue_manager.release_permit(&id).await;
        state.queue_manager.clear_aria2_retry_state(&id).await;
        state.queue_manager.forget_torrent_telemetry(&id).await;
        state.queue_manager.forget_aria2_gid(&id).await;
    }

    let owned_paths = crate::download_ownership::owned_paths_for_id(&app_handle, &id)?;

    use tauri::Emitter;
    let _ = app_handle.emit(
        "download-state",
        crate::ipc::DownloadStateEvent::new(id.clone(), crate::ipc::DownloadStatus::Paused),
    );

    let preserve_assets = preserve_resumable
        && owned_paths.iter().any(|path| has_resumable_download_assets(path));

    let cleanup_result = async {
        if delete_assets && !preserve_assets {
            for path in &owned_paths {
                remove_download_assets(path, &app_handle).await?;
            }
        }
        crate::torrent::remove_managed_torrent(&app_handle, &id).await;
        crate::download_ownership::remove(&app_handle, &id)?;
        Ok::<(), String>(())
    }
    .await;

    state.queue_manager.release_registered_id(&id).await;
    cleanup_result
}

#[tauri::command]
fn get_download_primary_path(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    id: String,
) -> Result<Option<String>, String> {
    properties_window::ensure_main_window(&caller)?;
    crate::download_ownership::primary_path_for_id(&app_handle, &id)
        .map(|path| path.map(|path| path.to_string_lossy().to_string()))
}

fn has_resumable_download_assets(primary: &std::path::Path) -> bool {
    [".aria2", ".part", ".ytdl"].iter().any(|suffix| {
        let mut candidate = primary.as_os_str().to_os_string();
        candidate.push(suffix);
        std::path::PathBuf::from(candidate).exists()
    })
}

pub(crate) async fn remove_download_assets<R: tauri::Runtime>(
    primary: &std::path::Path,
    app_handle: &tauri::AppHandle<R>,
) -> Result<(), String> {
    if !is_safe_path(primary, app_handle) {
        return Err("Download asset path is outside an allowed download location".to_string());
    }

    if primary.exists() {
        let mut retries = 5;
        loop {
            let res = if primary.is_dir() {
                tokio::fs::remove_dir_all(primary).await.map_err(|e| e.to_string())
            } else {
                if let Err(e) = trash::delete(primary) {
                    log::warn!("failed to move downloaded file to Trash, attempting hard delete: {}", e);
                    std::fs::remove_file(primary).map_err(|e| e.to_string())
                } else {
                    Ok(())
                }
            };
            match res {
                Ok(_) => break,
                Err(e) => {
                    if retries == 0 {
                        return Err(e);
                    }
                    retries -= 1;
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
    }

    for suffix in [".aria2", ".part", ".ytdl"] {
        let mut candidate_os = primary.as_os_str().to_os_string();
        candidate_os.push(suffix);
        let candidate = std::path::PathBuf::from(candidate_os);
        if candidate.exists() && is_safe_path(&candidate, app_handle) {
            let mut retries = 5;
            loop {
                match tokio::fs::remove_file(&candidate).await {
                    Ok(_) => break,
                    Err(_) if retries == 0 => {
                        return Err(format!("failed to remove '{}' after retries", candidate.display()));
                    }
                    Err(_) => {
                        retries -= 1;
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    }
                }
            }
        }
    }

    cleanup_media_processing_artifacts(primary).await;
    Ok(())
}

#[tauri::command]
async fn detach_download_for_reconfigure(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    log::info!("detach_download_for_reconfigure called for id: {}", id);
    let control_guard = state.queue_manager.acquire_aria2_control(&id).await;
    detach_download_for_reconfigure_locked(
        &app_handle,
        state.inner(),
        &id,
        &control_guard,
    )
    .await
}

async fn detach_download_for_reconfigure_locked(
    app_handle: &tauri::AppHandle,
    state: &AppState,
    id: &str,
    _control_guard: &queue::Aria2ControlGuard,
) -> Result<(), String> {
    let active_kind = state.queue_manager.active_kind(id).await;
    let media_lifecycle_generation = state
        .queue_manager
        .registered_lifecycle_generation(id)
        .await
        .unwrap_or_default();
    state.queue_manager.remove_from_pending(id).await;
    let gid = state.queue_manager.aria2_gid_for_download(id);

    if let Some(gid) = gid.as_deref() {
        // Do not invalidate the mapped lifecycle until the daemon confirms
        // the detach. A failed pause must leave terminal-event reconciliation
        // and permit ownership intact.
        state.queue_manager.cancel_aria2_retries(id).await;
        let removal_result = async {
            let pause_res = rpc_call(
                state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
                &state.aria2_secret,
                "aria2.forcePause",
                serde_json::json!([gid]),
            )
            .await;

            if let Err(e) = pause_res {
                if !e.contains("cannot be paused now") {
                    return Err(e);
                }
            }

            wait_for_aria2_stopped(
                state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
                &state.aria2_secret,
                gid,
            )
            .await
        }
        .await;
        if let Err(error) = removal_result {
            state.queue_manager.allow_aria2_retries(id).await;
            return Err(error);
        }
        state.queue_manager.next_aria2_control_epoch(id).await;
        state.queue_manager.clear_aria2_retry_state(id).await;
        state.queue_manager.forget_aria2_gid(id).await;
        state.queue_manager.release_permit(id).await;
        state.queue_manager.release_registered_id(id).await;
        log::info!("aria2 detach [{}]: gid {} stopped and forgotten", id, gid);
    } else {
        // Invalidate a queued/addUri lifecycle that has not published a GID.
        state.queue_manager.next_aria2_control_epoch(id).await;
        state.queue_manager.cancel_aria2_retries(id).await;
        let (tx, rx) = tokio::sync::oneshot::channel();
        if matches!(active_kind, Some(crate::queue::TaskKind::Media)) {
            state
                .download_coordinator
                .pause_media_with_ack(id.to_string(), media_lifecycle_generation, tx)
                .await?;
        } else {
            let _ = tx.send(false); // Fallback if no task exists
        }
        let media_was_registered = rx.await.unwrap_or(false); // Wait for the writer to stop
        if matches!(active_kind, Some(crate::queue::TaskKind::Media)) && !media_was_registered {
            state
                .download_coordinator
                .finish_media(id.to_string(), media_lifecycle_generation)
                .await;
        }

        state.queue_manager.release_permit(id).await;
        state.queue_manager.clear_aria2_retry_state(id).await;
        state.queue_manager.forget_aria2_gid(id).await;
        state.queue_manager.release_registered_id(id).await;
    }

    use tauri::Emitter;
    let _ = app_handle.emit(
        "download-state",
        crate::ipc::DownloadStateEvent::new(id, crate::ipc::DownloadStatus::Paused),
    );

    Ok(())
}

fn ensure_aria2_gid_result(
    method: &str,
    expected_gid: &str,
    result: &serde_json::Value,
) -> Result<(), String> {
    match result.as_str() {
        Some(returned_gid) if returned_gid == expected_gid => Ok(()),
        Some(returned_gid) => Err(format!(
            "aria2.{method} returned unexpected gid {returned_gid}, expected {expected_gid}"
        )),
        None => Err(format!("aria2.{method} returned a non-string result")),
    }
}

async fn aria2_download_status(port: u16, secret: &str, gid: &str) -> Result<String, String> {
    let result = rpc_call(
        port,
        secret,
        "aria2.tellStatus",
        serde_json::json!([gid, ["status"]]),
    )
    .await
    .map_err(|error| format!("failed to query aria2 gid {gid}: {error}"))?;
    result
        .get("status")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("aria2.tellStatus returned no status for gid {gid}"))
}

/// Verify a retained-GID resume against Aria2's actual state. `unpause` can
/// return before a paused GID becomes observable as active, and a transient
/// tellStatus failure must not turn a successful resume into a false failure.
/// Retry only that ambiguous observation; terminal and active states return
/// immediately and remain authoritative.
async fn verify_aria2_resume_status(port: u16, secret: &str, gid: &str) -> Result<String, String> {
    let mut last_observation = Err(format!("aria2 resume status for gid {gid} was not observed"));
    for attempt in 0..4u32 {
        last_observation = match aria2_download_status(port, secret, gid).await {
            Ok(status) if status != "paused" => return Ok(status),
            Ok(status) => Ok(status),
            Err(error) => Err(error),
        };
        if attempt < 3 {
            tokio::time::sleep(Duration::from_millis(25 * (1_u64 << attempt))).await;
        }
    }
    last_observation
}

async fn reconcile_aria2_downloads(app_handle: &tauri::AppHandle) {
    let state = app_handle.state::<AppState>();
    let port = state.aria2_port.load(std::sync::atomic::Ordering::Relaxed);
    let secret = state.aria2_secret.clone();
    let mappings = state.queue_manager.aria2_gid_mappings();

    for (gid, id) in mappings {
        let status = match rpc_call(
            port,
            &secret,
            "aria2.tellStatus",
            serde_json::json!([gid, ["status", "seeder", "errorCode", "errorMessage"]]),
        )
        .await
        {
            Ok(status) => status,
            Err(error) => {
                log::debug!(
                    "aria2 reconnect reconciliation [{}]: could not query gid {}: {}",
                    id,
                    gid,
                    error
                );
                if aria2_gid_not_found(&error)
                    && state.queue_manager.has_active_permit(&id).await
                    && state
                        .queue_manager
                        .aria2_gid_mapping(&gid)
                        .is_some_and(|mapping| mapping.id == id)
                {
                    if let Some(mapping) = state.queue_manager.aria2_gid_mapping(&gid) {
                        log::warn!(
                            "aria2 reconnect reconciliation [{}]: mapped gid {} is missing; attempting payload recovery",
                            id,
                            gid
                        );
                        if let Err(recovery_error) = state
                            .queue_manager
                            .refresh_aria2_connections(&id, &gid, mapping.epoch)
                            .await
                        {
                            log::warn!(
                                "aria2 reconnect reconciliation [{}]: payload recovery for missing gid {} failed: {}",
                                id,
                                gid,
                                recovery_error
                            );
                        }
                    }
                }
                continue;
            }
        };

        let status_name = status.get("status").and_then(|value| value.as_str());
        let outcome = match status_name {
            Some("complete") => Some(crate::queue::PendingOutcome::Complete),
            Some("active")
                if status.get("seeder").is_some_and(|value| {
                    value.as_str() == Some("true") || value.as_bool() == Some(true)
                })
                    && state
                        .queue_manager
                        .aria2_torrent_seeding_requested(&id)
                        .await =>
            {
                Some(crate::queue::PendingOutcome::Seeding)
            }
            Some("error") | Some("removed") => {
                let error_code = status
                    .get("errorCode")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.is_empty());
                let error_message = status
                    .get("errorMessage")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.is_empty())
                    .unwrap_or("aria2 download ended while the event channel was disconnected");
                Some(crate::queue::PendingOutcome::Error(match error_code {
                    Some(code) => format!("aria2 error code {code}: {error_message}"),
                    None => error_message.to_string(),
                }))
            }
            _ => None,
        };

        if let Some(outcome) = outcome {
            state.queue_manager.handle_aria2_event(&gid, outcome).await;
        }
    }
}

async fn aria2_daemon_is_reachable(port: u16, secret: &str) -> bool {
    for attempt in 0..2 {
        if rpc_call(
            port,
            secret,
            "aria2.getVersion",
            serde_json::json!([]),
        )
        .await
        .is_ok()
        {
            return true;
        }
        if attempt == 0 {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    false
}

/// Distinguish a temporary RPC/WebSocket outage from a daemon that actually
/// exited. The latter invalidates Aria2 GIDs and permits; the former must leave
/// them intact so reconnect reconciliation can recover the transfer.
fn aria2_daemon_process_exited(app_handle: &tauri::AppHandle) -> bool {
    let guard = app_handle.state::<Aria2DaemonGuard>();
    let Ok(mut child) = guard.child.lock() else {
        return false;
    };
    match child.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(error) => {
                log::warn!("could not verify aria2 process state after RPC outage: {error}");
                false
            }
        },
        None => true,
    }
}

pub(crate) fn aria2_gid_not_found(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("gid") && lower.contains("not found")
}

async fn force_remove_aria2_gid(port: u16, secret: &str, gid: &str) -> Result<(), String> {
    match rpc_call(port, secret, "aria2.forceRemove", serde_json::json!([gid])).await {
        Ok(result) => ensure_aria2_gid_result("forceRemove", gid, &result),
        Err(error) if aria2_gid_not_found(&error) => {
            log::info!("aria2 forceRemove: gid {} was already absent", gid);
            Ok(())
        }
        Err(error) => match aria2_download_status(port, secret, gid).await {
            Ok(status) if matches!(status.as_str(), "complete" | "error" | "removed") => {
                log::info!(
                    "aria2 forceRemove: gid {} raced to terminal state {}",
                    gid,
                    status
                );
                Ok(())
            }
            _ => Err(format!("failed to remove aria2 gid {gid}: {error}")),
        },
    }
}

async fn wait_for_aria2_stopped(port: u16, secret: &str, gid: &str) -> Result<(), String> {
    for _ in 0..30 {
        match aria2_download_status(port, secret, gid).await {
            Ok(status) if matches!(status.as_str(), "paused" | "complete" | "error" | "removed") => {
                return Ok(());
            }
            Ok(_) => {}
            Err(error) if aria2_gid_not_found(&error) => return Ok(()),
            Err(error) => return Err(error),
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err(format!(
        "aria2 gid {gid} did not stop within 3 seconds after forceRemove"
    ))
}

static NEXT_DOCK_BADGE_SESSION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(1);

#[cfg(target_os = "macos")]
fn should_apply_dock_badge_update(
    current_session: u64,
    current_generation: u64,
    session: u64,
    generation: u64,
) -> bool {
    session > current_session || (session == current_session && generation >= current_generation)
}

#[tauri::command]
fn begin_dock_badge_session() -> u64 {
    NEXT_DOCK_BADGE_SESSION.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

#[tauri::command]
#[allow(unused_variables)]
fn update_dock_badge(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    count: i32,
    generation: u64,
    session: u64,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    #[cfg(target_os = "macos")]
    {
        use objc::runtime::Object;
        use objc::{class, msg_send, sel, sel_impl};
        use std::ffi::CString;
        use std::sync::{Mutex, OnceLock};

        static LAST_DOCK_BADGE_STATE: OnceLock<Mutex<(u64, u64)>> = OnceLock::new();

        let _ = app_handle.run_on_main_thread(move || {
            let state = LAST_DOCK_BADGE_STATE.get_or_init(|| Mutex::new((0, 0)));
            let Ok(mut state) = state.lock() else {
                return;
            };
            if !should_apply_dock_badge_update(state.0, state.1, session, generation) {
                return;
            }
            *state = (session, generation);
            drop(state);
            unsafe {
            let app_class = class!(NSApplication);
            let app: *mut Object = msg_send![app_class, sharedApplication];
            let dock_tile: *mut Object = msg_send![app, dockTile];
            let label = if count > 0 {
                count.to_string()
            } else {
                "".to_string()
            };
            let c_label = CString::new(label).unwrap();
            let ns_string_class = class!(NSString);
            let ns_label: *mut Object = msg_send![ns_string_class, alloc];
            let ns_label: *mut Object = msg_send![ns_label, initWithUTF8String: c_label.as_ptr()];
            let _: () = msg_send![dock_tile, setBadgeLabel: ns_label];
            let _: () = msg_send![ns_label, release];
            }
        });
    }
    Ok(())
}

#[tauri::command]
fn get_platform_info(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<crate::ipc::PlatformInfo, String> {
    properties_window::ensure_main_window(&caller)?;
    Ok(crate::ipc::PlatformInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        target_triple: crate::platform::target_triple(),
        portable: state.storage_layout.is_portable(),
    })
}

#[tauri::command]
fn set_prevent_sleep(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    prevent: bool,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    state.power_manager.set_system_prevention(prevent)
}

#[tauri::command]
fn set_power_preferences(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    prevent_system_sleep: bool,
    prevent_display_sleep: bool,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    state
        .power_manager
        .set_preferences(prevent_system_sleep, prevent_display_sleep)
}

pub(crate) fn execute_system_action(action: crate::ipc::PostQueueAction) -> Result<(), String> {
    match action {
        crate::ipc::PostQueueAction::Shutdown => {
            system_shutdown::shutdown().map_err(|e| e.to_string())
        }
        crate::ipc::PostQueueAction::Restart => {
            system_shutdown::reboot().map_err(|e| e.to_string())
        }
        crate::ipc::PostQueueAction::Sleep => system_shutdown::sleep().map_err(|e| e.to_string()),
        crate::ipc::PostQueueAction::None => Err("Invalid action".to_string()),
    }
}

#[tauri::command]
fn perform_system_action(
    caller: tauri::WebviewWindow,
    action: crate::ipc::PostQueueAction,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    execute_system_action(action)
}

#[tauri::command]
fn ack_schedule_trigger(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    action: String,
    key: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    crate::settings::update_settings_state(&app_handle, |state| match action.as_str() {
        "start" => {
            state.insert("schedulerLastStartKey".to_string(), serde_json::json!(key));
        }
        "stop" => {
            state.insert("schedulerLastStopKey".to_string(), serde_json::json!(key));
        }
        _ => {}
    })?;
    match action.as_str() {
        "start" | "stop" => {
            if let Ok(mut cached) = state.scheduler_settings.write() {
                if let Some(settings) = cached.as_mut() {
                    if action == "start" {
                        settings.scheduler_last_start_key = key;
                    } else {
                        settings.scheduler_last_stop_key = key;
                    }
                }
            }
            Ok(())
        }
        _ => Err("Unknown scheduler trigger action".to_string()),
    }
}

#[tauri::command]
async fn get_pending_order(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    queue_id: Option<String>,
) -> Result<Vec<String>, AppError> {
    properties_window::ensure_main_window(&caller).map_err(AppError::Internal)?;
    Ok(state.queue_manager.pending_order(queue_id.as_deref()).await)
}

fn enqueue_lifecycle_generation(item: &queue::EnqueueItem) -> Result<u64, String> {
    item.lifecycle_generation
        .as_deref()
        .map(|generation| {
            generation
                .parse::<u64>()
                .map_err(|_| "Invalid enqueue lifecycle generation".to_string())
        })
        .transpose()
        .map(|generation| generation.unwrap_or_default())
}

async fn validate_enqueue_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "SSRF blocked: Invalid URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" | "ftp" | "sftp" => {
            resolve_and_validate_url_host(&parsed).await.map(|_| ())
        }
        _ => Err("Unsupported URL scheme".to_string()),
    }
}

async fn validate_enqueue_uris(url: &str, mirrors: Option<&str>) -> Result<(), String> {
    for uri in collect_download_uris(url, mirrors) {
        validate_enqueue_url(&uri).await?;
    }
    Ok(())
}

async fn validate_torrent_web_seed_destinations(seeds: &[String]) -> Result<(), String> {
    for uri in seeds {
        let parsed = reqwest::Url::parse(uri)
            .map_err(|_| "Torrent web-seed URI is invalid".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none_or(str::is_empty)
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
        {
            return Err("Torrent web-seed URI must use HTTP or HTTPS without credentials or fragments".to_string());
        }
        resolve_and_validate_url_host(&parsed).await?;
    }
    Ok(())
}

/// Embedded web seeds are optional Torrent accelerators, not the transfer's
/// source of truth. Keep the peer-only path usable when a stale seed domain is
/// temporarily unavailable, while still rejecting destinations that resolve
/// to local or private addresses before they are offered to Aria2.
pub(crate) async fn filter_torrent_web_seed_destinations(
    seeds: &[String],
) -> Result<Vec<String>, String> {
    let mut allowed = Vec::with_capacity(seeds.len());
    for seed in seeds {
        let parsed = reqwest::Url::parse(seed)
            .map_err(|_| "Torrent web-seed URI is invalid".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none_or(str::is_empty)
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
        {
            return Err("Torrent web-seed URI must use HTTP or HTTPS without credentials or fragments".to_string());
        }
        match resolve_and_validate_url_host(&parsed).await {
            Ok(_) => allowed.push(seed.clone()),
            Err(error)
                if error == "SSRF blocked: DNS resolution failed"
                    || error == "SSRF blocked: DNS resolution timed out"
                    || error == "SSRF blocked: No DNS records" =>
            {
                log::warn!(
                    "Skipping unavailable embedded Torrent web seed {}",
                    parsed.host_str().unwrap_or("<unknown host>")
                );
            }
            Err(error) => return Err(error),
        }
    }
    Ok(allowed)
}

async fn validate_torrent_enqueue(
    app_handle: &tauri::AppHandle,
    item: &mut queue::EnqueueItem,
) -> Result<(), String> {
    if item.is_media.unwrap_or(false) {
        return Err("torrent transfer cannot be a media download".to_string());
    }
    crate::torrent::validate_output_name(&item.filename)?;
    item.torrent_trackers = queue::normalize_torrent_trackers(item.torrent_trackers.as_deref())?;
    item.torrent_exclude_trackers =
        queue::normalize_torrent_exclude_trackers(item.torrent_exclude_trackers.as_deref())?;
    item.torrent_tracker_connect_timeout = queue::normalize_torrent_tracker_connect_timeout(
        item.torrent_tracker_connect_timeout,
    )?;
    item.torrent_tracker_timeout =
        queue::normalize_torrent_tracker_request_timeout(item.torrent_tracker_timeout)?;
    item.torrent_tracker_interval =
        queue::normalize_torrent_tracker_interval(item.torrent_tracker_interval)?;
    item.torrent_stop_timeout = queue::normalize_torrent_stop_timeout(item.torrent_stop_timeout)?;
    item.torrent_prioritize_piece = queue::normalize_torrent_prioritize_piece(
        item.torrent_prioritize_piece.as_deref(),
    )?;
    item.torrent_encryption_policy = queue::normalize_torrent_encryption_policy(
        item.torrent_encryption_policy.as_deref(),
    )?;
    validate_enqueue_uris("", item.mirrors.as_deref()).await?;
    if let Some(path) = item.torrent_path.as_deref() {
        let path = crate::torrent::validate_managed_torrent_path(app_handle, &item.id, path)?;
        let bytes = std::fs::read(path)
            .map_err(|error| format!("could not read cached torrent metadata: {error}"))?;
        let metadata = crate::torrent::parse_torrent_bytes(&bytes)?;
        let normalized_user_web_seeds = queue::normalize_torrent_web_seeds(
            item.torrent_web_seeds.as_deref(),
            &metadata.files,
        )?;
        let user_web_seed_uris = normalized_user_web_seeds
            .iter()
            .map(|seed| seed.uri.clone())
            .collect::<Vec<_>>();
        validate_torrent_web_seed_destinations(&user_web_seed_uris).await?;
        item.torrent_web_seeds = (!normalized_user_web_seeds.is_empty())
            .then_some(normalized_user_web_seeds);
        crate::torrent::validate_info_hash(
            item.torrent_info_hash.as_deref(),
            &metadata.info_hash,
        )?;
        let selected = crate::torrent::validate_selected_indices(
            item.torrent_file_indices.as_deref(),
            metadata.files.len(),
        )?;
        item.torrent_file_indices = selected.clone();
        if item.torrent_remove_unselected_file.unwrap_or(false) {
            let Some(selected) = selected else {
                return Err(
                    "removing unselected Torrent files requires selecting a subset of files"
                        .to_string(),
                );
            };
            if selected.len() >= metadata.files.len() {
                return Err(
                    "removing unselected Torrent files requires at least one unselected file"
                        .to_string(),
                );
            }
        }
        return Ok(());
    }

    let parsed = url::Url::parse(&item.url).map_err(|_| "invalid magnet URI".to_string())?;
    if parsed.scheme() != "magnet" {
        return Err("torrent transfer has no magnet URI or cached metadata".to_string());
    }
    if item.torrent_file_indices.is_some() {
        return Err("magnet file selection requires resolved torrent metadata".to_string());
    }
    if item.torrent_remove_unselected_file.unwrap_or(false) {
        return Err(
            "removing unselected Torrent files requires resolved torrent metadata".to_string(),
        );
    }
    let metadata = crate::torrent::inspect_source(&item.url)?;
    crate::torrent::validate_info_hash(item.torrent_info_hash.as_deref(), &metadata.info_hash)
}

struct ExpectedTorrentOutputPaths {
    primary: std::path::PathBuf,
    selected: Vec<std::path::PathBuf>,
    unselected: Vec<std::path::PathBuf>,
}

#[derive(Clone)]
struct DownloadOwnershipSnapshot {
    primary: Option<std::path::PathBuf>,
    owned: Vec<std::path::PathBuf>,
    removal: Vec<std::path::PathBuf>,
}

fn snapshot_download_ownership(
    app_handle: &tauri::AppHandle,
    id: &str,
) -> Result<DownloadOwnershipSnapshot, String> {
    Ok(DownloadOwnershipSnapshot {
        primary: crate::download_ownership::primary_path_for_id(app_handle, id)?,
        owned: crate::download_ownership::owned_paths_for_id(app_handle, id)?,
        removal: crate::download_ownership::torrent_removal_paths_for_id(app_handle, id)?,
    })
}

fn restore_download_ownership(
    app_handle: &tauri::AppHandle,
    id: &str,
    snapshot: DownloadOwnershipSnapshot,
) -> Result<(), String> {
    let Some(primary) = snapshot.primary else {
        return crate::download_ownership::remove(app_handle, id);
    };
    let owned = if snapshot.owned.is_empty() {
        vec![primary.clone()]
    } else {
        snapshot.owned
    };
    crate::download_ownership::set_owned_paths_with_primary_and_removal(
        app_handle,
        id,
        &primary,
        &owned,
        &snapshot.removal,
    )
}

fn expected_torrent_output_paths(
    app_handle: &tauri::AppHandle,
    id: &str,
    destination: &str,
    filename: &str,
    torrent_path: Option<&str>,
    torrent_file_indices: Option<&[u32]>,
    torrent_remove_unselected_file: bool,
) -> Result<Option<ExpectedTorrentOutputPaths>, String> {
    let Some(torrent_path) = torrent_path else {
        return Ok(None);
    };
    let torrent_path = crate::torrent::validate_managed_torrent_path(app_handle, id, torrent_path)?;
    let bytes = std::fs::read(torrent_path)
        .map_err(|error| format!("could not read cached torrent metadata: {error}"))?;
    let metadata = crate::torrent::parse_torrent_bytes(&bytes)?;
    let selected = crate::torrent::validate_selected_indices(
        torrent_file_indices,
        metadata.files.len(),
    )?;
    let destination = crate::resolve_path(destination, app_handle);
    if !crate::is_safe_path(&destination, app_handle) {
        return Err("Path traversal blocked".to_string());
    }
    let canonical_destination = crate::canonicalize_with_missing_components(&destination)
        .ok_or_else(|| "torrent destination could not be canonicalized".to_string())?;
    let selected_relative = crate::torrent::aria2_output_paths(
        &metadata,
        selected.as_deref(),
        filename,
    );
    let resolve_paths = |relative_paths: Vec<String>| -> Result<Vec<std::path::PathBuf>, String> {
        let mut paths = Vec::new();
        for relative in relative_paths {
            let relative = std::path::PathBuf::from(relative);
            if relative.is_absolute()
                || relative.components().any(|component| {
                    matches!(
                        component,
                        std::path::Component::ParentDir | std::path::Component::CurDir
                    )
                })
            {
                return Err("torrent output path is unsafe".to_string());
            }
            let path = destination.join(relative);
            let canonical_path = crate::canonicalize_with_missing_components(&path)
                .ok_or_else(|| "torrent output path could not be canonicalized".to_string())?;
            if !crate::platform::path_is_within(&canonical_path, &canonical_destination) {
                return Err("torrent output path is outside its destination".to_string());
            }
            paths.push(canonical_path);
        }
        Ok(paths)
    };
    let selected_paths = resolve_paths(selected_relative)?;
    let unselected_paths = if torrent_remove_unselected_file {
        let selected_indices = selected
            .as_deref()
            .ok_or_else(|| "torrent file selection is required for unselected-file removal".to_string())?;
        let selected_indices = selected_indices.iter().copied().collect::<std::collections::HashSet<_>>();
        let unselected_relative = metadata
            .files
            .iter()
            .filter(|file| !selected_indices.contains(&file.index))
            .map(|file| {
                if metadata.files.len() == 1 {
                    file.path.clone()
                } else {
                    format!("{}/{}", filename, file.path)
                }
            })
            .collect::<Vec<_>>();
        let paths = resolve_paths(unselected_relative)?;
        if paths.iter().any(|path| {
            std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
        }) {
            return Err("unselected Torrent output path is a directory".to_string());
        }
        paths
    } else {
        Vec::new()
    };
    let primary = if metadata.files.len() == 1 {
        selected_paths
            .first()
            .cloned()
            .ok_or_else(|| "Torrent selection produced no output path".to_string())?
    } else {
        resolve_paths(vec![filename.to_string()])?
            .into_iter()
            .next()
            .ok_or_else(|| "Torrent output name is invalid".to_string())?
    };
    Ok(Some(ExpectedTorrentOutputPaths {
        primary,
        selected: selected_paths,
        unselected: unselected_paths,
    }))
}

/// Register the complete output ownership for one enqueue in a single
/// ownership transaction.  In particular, do not first register only the
/// primary path and then add Torrent paths: a crash between those writes can
/// leave a partial ownership record that no longer describes the queued task.
fn register_download_ownership(
    app_handle: &tauri::AppHandle,
    item: &queue::EnqueueItem,
) -> Result<(), String> {
    if item.is_torrent.unwrap_or(false) {
        return register_torrent_output_ownership(
            app_handle,
            &item.id,
            &item.destination,
            &item.filename,
            item.torrent_path.as_deref(),
            item.torrent_file_indices.as_deref(),
            item.torrent_remove_unselected_file.unwrap_or(false),
        );
    }
    let primary = crate::download_ownership::expected_primary_path(
        app_handle,
        &item.destination,
        &item.filename,
    )?;
    set_download_output_ownership(
        app_handle,
        &item.id,
        primary.clone(),
        vec![primary],
        Vec::new(),
    )
}

fn register_torrent_output_ownership(
    app_handle: &tauri::AppHandle,
    id: &str,
    destination: &str,
    filename: &str,
    torrent_path: Option<&str>,
    torrent_file_indices: Option<&[u32]>,
    torrent_remove_unselected_file: bool,
) -> Result<(), String> {
    let Some(paths) = expected_torrent_output_paths(
        app_handle,
        id,
        destination,
        filename,
        torrent_path,
        torrent_file_indices,
        torrent_remove_unselected_file,
    )? else {
        let primary = crate::download_ownership::expected_primary_path(
            app_handle,
            destination,
            filename,
        )?;
        return set_download_output_ownership(
            app_handle,
            id,
            primary.clone(),
            vec![primary],
            Vec::new(),
        );
    };
    set_download_output_ownership(
        app_handle,
        id,
        paths.primary,
        paths.selected,
        if torrent_remove_unselected_file {
            paths.unselected
        } else {
            Vec::new()
        },
    )
}

fn set_download_output_ownership(
    app_handle: &tauri::AppHandle,
    id: &str,
    primary: std::path::PathBuf,
    owned_paths: Vec<std::path::PathBuf>,
    removal_paths: Vec<std::path::PathBuf>,
) -> Result<(), String> {
    crate::download_ownership::set_owned_paths_with_primary_and_removal(
        app_handle,
        id,
        &primary,
        &owned_paths,
        &removal_paths,
    )
}

async fn remove_magnet_metadata_probe_dir(path: &std::path::Path) -> Result<(), String> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "could not remove magnet metadata probe ({:?})",
            error.kind()
        )),
    }
}

async fn resolve_magnet_metadata(
    app_handle: &tauri::AppHandle,
    state: &AppState,
    source: &str,
    id: &str,
    proxy: Option<&str>,
    cache: bool,
) -> Result<crate::ipc::TorrentMetadata, String> {
    let expected = crate::torrent::inspect_source(source)?;
    let managed_path = crate::torrent::managed_torrent_path(app_handle, id)?;
    let proxy_value = proxy
        .map(crate::queue::aria2_all_proxy_value)
        .transpose()?
        .flatten();
    if cache && crate::torrent::magnet_allows_cached_metadata(source) {
        match crate::torrent::read_cached_torrent_by_info_hash(app_handle, &expected.info_hash)
            .await
        {
            Ok(Some(bytes)) => {
                let parsed = crate::torrent::parse_torrent_bytes(&bytes)?;
                crate::torrent::validate_info_hash(Some(&expected.info_hash), &parsed.info_hash)?;
                let torrent_path =
                    crate::torrent::cache_torrent_bytes(app_handle, id, &bytes).await?;
                return Ok(crate::torrent::to_metadata(parsed, Some(torrent_path)));
            }
            Ok(None) => {}
            Err(error) => {
                log::warn!("could not inspect canonical torrent metadata cache: {error}");
            }
        }
    }
    let storage_root = managed_path
        .parent()
        .ok_or_else(|| "torrent storage has no parent directory".to_string())?;
    let probe_dir = storage_root.join(format!(".probe-{}", uuid::Uuid::new_v4().simple()));
    tokio::fs::create_dir_all(&probe_dir)
        .await
        .map_err(|error| format!("could not create torrent metadata probe: {error}"))?;

    let port = state
        .aria2_port
        .load(std::sync::atomic::Ordering::Relaxed);
    let secret = state.aria2_secret.clone();
    let metadata_path = probe_dir.join(format!("{}.torrent", expected.info_hash));
    let mut options = serde_json::Map::new();
    options.insert(
        "dir".to_string(),
        serde_json::json!(probe_dir.to_string_lossy().to_string()),
    );
    options.insert("bt-metadata-only".to_string(), serde_json::json!("true"));
    options.insert("bt-save-metadata".to_string(), serde_json::json!("true"));
    options.insert("max-tries".to_string(), serde_json::json!("3"));
    options.insert("retry-wait".to_string(), serde_json::json!("2"));
    options.insert("connect-timeout".to_string(), serde_json::json!("20"));
    options.insert("timeout".to_string(), serde_json::json!("60"));
    options.insert("auto-file-renaming".to_string(), serde_json::json!("false"));
    if let Some(proxy) = proxy_value {
        options.insert("all-proxy".to_string(), serde_json::json!(proxy));
    }

    let client = std::sync::Arc::new(Aria2RpcClient { port, secret });
    let sanitized_source = crate::torrent::sanitize_magnet_uri_for_aria2(source)?;
    let metadata_result = crate::torrent_probe::run_metadata_probe(
        client,
        &sanitized_source,
        options,
        &metadata_path,
        Duration::from_secs(60),
        Duration::from_millis(250),
    )
    .await;

    let bytes = match metadata_result {
        Ok(bytes) => bytes,
        Err(crate::torrent_probe::ProbeFailure::Metadata(error)) => {
            if let Err(remove_error) = remove_magnet_metadata_probe_dir(&probe_dir).await {
                return Err(remove_error);
            }
            return Err(error);
        }
        Err(crate::torrent_probe::ProbeFailure::Cleanup(error)) => {
            if aria2_daemon_process_exited(app_handle) {
                if let Err(remove_error) = remove_magnet_metadata_probe_dir(&probe_dir).await {
                    return Err(format!(
                        "could not clean up magnet metadata probe: {error}; could not remove probe after aria2 exit: {remove_error}"
                    ));
                }
                return Err(format!(
                    "could not clean up magnet metadata probe after aria2 exit: {error}"
                ));
            }
            return Err(format!("could not clean up magnet metadata probe: {error}"));
        }
    };

    if let Err(error) = remove_magnet_metadata_probe_dir(&probe_dir).await {
        return Err(error);
    }
    let parsed = crate::torrent::parse_torrent_bytes(&bytes)?;
    crate::torrent::validate_info_hash(Some(&expected.info_hash), &parsed.info_hash)?;
    let torrent_path = if cache {
        let torrent_path = crate::torrent::cache_torrent_bytes(app_handle, id, &bytes).await?;
        if let Err(error) = crate::torrent::cache_torrent_info_hash(app_handle, &bytes).await {
            log::warn!("could not cache canonical torrent metadata: {error}");
        }
        Some(torrent_path)
    } else {
        None
    };
    Ok(crate::torrent::to_metadata(parsed, torrent_path))
}

#[tauri::command]
async fn inspect_torrent(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    source: String,
    id: String,
    cache: Option<bool>,
    proxy: Option<String>,
    headers: Option<String>,
    cookies: Option<String>,
    cookie_scopes: Option<Vec<extension_server::ExtensionCookieScope>>,
    torrent: Option<bool>,
) -> Result<crate::ipc::TorrentMetadata, AppError> {
    properties_window::ensure_main_window(&caller).map_err(AppError::Internal)?;
    if source.trim_start().to_ascii_lowercase().starts_with("magnet:") {
        return resolve_magnet_metadata(
            &app_handle,
            state.inner(),
            &source,
            &id,
            proxy.as_deref(),
            cache == Some(true),
        )
        .await
        .map_err(AppError::Internal);
    }
    if is_remote_torrent_source(&source, torrent == Some(true)) {
        let remote_source = source.trim();
        let bytes = fetch_remote_torrent_bytes(
            remote_source,
            proxy.as_deref(),
            headers.as_deref(),
            cookies.as_deref(),
            cookie_scopes.as_deref(),
        )
            .await
            .map_err(AppError::Internal)?;
        let parsed = crate::torrent::parse_torrent_bytes(&bytes).map_err(AppError::Internal)?;
        let torrent_path = if cache != Some(false) {
            let torrent_path = crate::torrent::cache_torrent_bytes(&app_handle, &id, &bytes)
                .await
                .map_err(AppError::Internal)?;
            if let Err(error) =
                crate::torrent::cache_torrent_info_hash(&app_handle, &bytes).await
            {
                log::warn!("could not cache canonical torrent metadata: {error}");
            }
            Some(torrent_path)
        } else {
            None
        };
        return Ok(crate::torrent::to_metadata(parsed, torrent_path));
    }
    if cache == Some(false) {
        return crate::torrent::inspect_source(&source)
            .map(|parsed| crate::torrent::to_metadata(parsed, None))
            .map_err(AppError::Internal);
    }
    let (parsed, path) = crate::torrent::prepare_local_torrent(&app_handle, &source, &id)
        .await
        .map_err(AppError::Internal)?;
    Ok(crate::torrent::to_metadata(parsed, Some(path)))
}

#[tauri::command]
async fn rekey_torrent_metadata(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    source_id: String,
    target_id: String,
) -> Result<String, AppError> {
    properties_window::ensure_main_window(&caller).map_err(AppError::Internal)?;
    let source = crate::torrent::managed_torrent_path(&app_handle, &source_id)
        .map_err(AppError::Internal)?;
    let source = crate::torrent::validate_managed_torrent_path(
        &app_handle,
        &source_id,
        &source.to_string_lossy(),
    )
    .map_err(AppError::Internal)?;
    let bytes = tokio::fs::read(&source)
        .await
        .map_err(|error| {
            AppError::Internal(format!("could not read cached torrent metadata: {error}"))
        })?;
    crate::torrent::parse_torrent_bytes(&bytes).map_err(AppError::Internal)?;
    let target = crate::torrent::cache_torrent_bytes(&app_handle, &target_id, &bytes)
        .await
        .map_err(AppError::Internal)?;
    if let Err(error) = crate::torrent::cache_torrent_info_hash(&app_handle, &bytes).await {
        log::warn!("could not cache canonical torrent metadata during rekey: {error}");
    }
    let target = crate::torrent::validate_managed_torrent_path(
        &app_handle,
        &target_id,
        &target,
    )
    .map_err(AppError::Internal)?;
    if source != target {
        tokio::fs::remove_file(&source).await.map_err(|error| {
            AppError::Internal(format!("could not remove temporary torrent metadata: {error}"))
        })?;
    }
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
async fn remove_torrent_metadata(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    id: String,
) -> Result<(), AppError> {
    properties_window::ensure_main_window(&caller).map_err(AppError::Internal)?;
    crate::torrent::remove_managed_torrent(&app_handle, &id).await;
    Ok(())
}

#[tauri::command]
async fn enqueue_download(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    item: queue::EnqueueItem,
) -> Result<crate::ipc::EnqueueAccepted, AppError> {
    properties_window::ensure_main_window(&caller).map_err(AppError::Internal)?;
    let id = item.id.clone();
    let control_guard = state.queue_manager.acquire_aria2_control(&id).await;
    enqueue_download_locked(&app_handle, state.inner(), item, &control_guard).await
}

async fn enqueue_download_locked(
    app_handle: &tauri::AppHandle,
    state: &AppState,
    mut item: queue::EnqueueItem,
    _control_guard: &queue::Aria2ControlGuard,
) -> Result<crate::ipc::EnqueueAccepted, AppError> {
    if item.is_torrent.unwrap_or(false) {
        validate_torrent_enqueue(app_handle, &mut item)
            .await
            .map_err(AppError::Internal)?;
    } else {
        item.sftp_host_key_md = queue::normalize_sftp_host_key_md(item.sftp_host_key_md.as_deref())
            .map_err(AppError::Internal)?;
        validate_enqueue_uris(&item.url, item.mirrors.as_deref())
            .await
            .map_err(AppError::Internal)?;
    }
    let id = item.id.clone();
    item.filename = crate::download_ownership::canonical_download_filename(&item.filename);
    let accepted_filename = item.filename.clone();
    let lifecycle_generation = enqueue_lifecycle_generation(&item).map_err(AppError::Internal)?;
    let previous_generation = state
        .queue_manager
        .reserve_enqueue_generation(&id, lifecycle_generation)
        .await
        .map_err(AppError::Internal)?;
    let previous_ownership = match snapshot_download_ownership(app_handle, &id) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            state
                .queue_manager
                .rollback_enqueue_reservation(&id, lifecycle_generation, previous_generation)
                .await;
            return Err(AppError::Internal(error));
        }
    };
    if let Err(error) = register_download_ownership(app_handle, &item) {
        if let Err(restore_error) = restore_download_ownership(app_handle, &id, previous_ownership) {
            log::error!(
                "download ownership [{}]: failed to restore the previous mapping after enqueue registration failed: {}",
                id,
                restore_error
            );
        }
        state
            .queue_manager
            .rollback_enqueue_reservation(&id, lifecycle_generation, previous_generation)
            .await;
        return Err(AppError::Internal(error));
    }
    if let Err(error) = state
        .queue_manager
        .commit_reserved_enqueue(item.into_task(), lifecycle_generation)
        .await
    {
        if let Err(restore_error) = restore_download_ownership(app_handle, &id, previous_ownership) {
            log::error!(
                "download ownership [{}]: failed to restore the previous mapping after enqueue commit failed: {}",
                id,
                restore_error
            );
        }
        state
            .queue_manager
            .rollback_enqueue_reservation(&id, lifecycle_generation, previous_generation)
            .await;
        return Err(AppError::Internal(error));
    }
    Ok(crate::ipc::EnqueueAccepted {
        id,
        filename: accepted_filename,
    })
}

#[tauri::command]
async fn cancel_enqueue_generation(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
    generation: String,
) -> Result<(), AppError> {
    properties_window::ensure_main_window(&caller).map_err(AppError::Internal)?;
    let generation = generation
        .parse::<u64>()
        .map_err(|_| AppError::Internal("Invalid enqueue lifecycle generation".to_string()))?;
    state
        .queue_manager
        .cancel_enqueue_generation(&id, generation)
        .await;
    Ok(())
}

#[tauri::command]
async fn enqueue_many(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    items: Vec<queue::EnqueueItem>,
) -> Result<Vec<crate::ipc::EnqueueResult>, AppError> {
    properties_window::ensure_main_window(&caller).map_err(AppError::Internal)?;
    let mut results = Vec::with_capacity(items.len());
    for mut item in items {
        let id = item.id.clone();
        // Keep validation, ownership replacement, and enqueue reservation
        // serialized with pause/resume/remove for this download. The guard is
        // intentionally held through every early-continue path below.
        let _control_guard = state.queue_manager.acquire_aria2_control(&id).await;
        let validation = if item.is_torrent.unwrap_or(false) {
            validate_torrent_enqueue(&app_handle, &mut item).await
        } else {
            match queue::normalize_sftp_host_key_md(item.sftp_host_key_md.as_deref()) {
                Ok(normalized) => {
                    item.sftp_host_key_md = normalized;
                    validate_enqueue_uris(&item.url, item.mirrors.as_deref()).await
                }
                Err(error) => Err(error),
            }
        };
        if let Err(error) = validation {
            results.push(crate::ipc::EnqueueResult {
                id,
                success: false,
                filename: None,
                error: Some(error),
            });
            continue;
        }
        item.filename = crate::download_ownership::canonical_download_filename(&item.filename);
        let filename = item.filename.clone();
        let lifecycle_generation = match enqueue_lifecycle_generation(&item) {
            Ok(generation) => generation,
            Err(error) => {
                results.push(crate::ipc::EnqueueResult {
                    id,
                    success: false,
                    filename: None,
                    error: Some(error),
                });
                continue;
            }
        };
        let previous_generation = match state
            .queue_manager
            .reserve_enqueue_generation(&id, lifecycle_generation)
            .await
        {
            Ok(previous) => previous,
            Err(error) => {
                results.push(crate::ipc::EnqueueResult {
                    id,
                    success: false,
                    filename: None,
                    error: Some(error),
                });
                continue;
            }
        };
        let previous_ownership = match snapshot_download_ownership(&app_handle, &id) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                state
                    .queue_manager
                    .rollback_enqueue_reservation(&id, lifecycle_generation, previous_generation)
                    .await;
                results.push(crate::ipc::EnqueueResult {
                    id,
                    success: false,
                    filename: None,
                    error: Some(error),
                });
                continue;
            }
        };
        if let Err(error) = register_download_ownership(&app_handle, &item) {
            if let Err(restore_error) = restore_download_ownership(&app_handle, &id, previous_ownership) {
                log::error!(
                    "download ownership [{}]: failed to restore the previous mapping after batch enqueue registration failed: {}",
                    id,
                    restore_error
                );
            }
            state
                .queue_manager
                .rollback_enqueue_reservation(&id, lifecycle_generation, previous_generation)
                .await;
            results.push(crate::ipc::EnqueueResult {
                id,
                success: false,
                filename: None,
                error: Some(error),
            });
            continue;
        }
        if let Err(error) = state
            .queue_manager
            .commit_reserved_enqueue(item.into_task(), lifecycle_generation)
            .await
        {
            if let Err(restore_error) = restore_download_ownership(&app_handle, &id, previous_ownership) {
                log::error!(
                    "download ownership [{}]: failed to restore the previous mapping after batch enqueue commit failed: {}",
                    id,
                    restore_error
                );
            }
            state
                .queue_manager
                .rollback_enqueue_reservation(&id, lifecycle_generation, previous_generation)
                .await;
            results.push(crate::ipc::EnqueueResult {
                id,
                success: false,
                filename: None,
                error: Some(error),
            });
            continue;
        }
        results.push(crate::ipc::EnqueueResult {
            id,
            success: true,
            filename: Some(filename),
            error: None,
        });
    }

    Ok(results)
}

#[tauri::command]
async fn move_in_queue(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
    queue_id: String,
    direction: crate::ipc::QueueDirection,
) -> Result<Vec<String>, AppError> {
    properties_window::ensure_main_window(&caller).map_err(AppError::Internal)?;
    Ok(state
        .queue_manager
        .move_in_queue(&id, &queue_id, direction)
        .await)
}

#[tauri::command]
async fn move_many_in_queue(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
    queue_id: String,
    direction: crate::ipc::QueueDirection,
    target_index: Option<usize>,
) -> Result<Vec<String>, AppError> {
    properties_window::ensure_main_window(&caller).map_err(AppError::Internal)?;
    Ok(match target_index {
        Some(target_index) => state
            .queue_manager
            .move_many_in_queue_to(&ids, &queue_id, target_index)
            .await,
        None => state
            .queue_manager
            .move_many_in_queue(&ids, &queue_id, direction)
            .await,
    })
}

#[tauri::command]
async fn remove_from_queue(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<bool, AppError> {
    properties_window::ensure_main_window(&caller).map_err(AppError::Internal)?;
    let removed = state.queue_manager.remove_from_pending(&id).await;
    if removed {
        let _ = crate::download_ownership::remove(&app_handle, &id);
        state.queue_manager.release_registered_id(&id).await;
    }
    Ok(removed)
}

#[tauri::command]
async fn set_concurrent_limit(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    limit: usize,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    state.queue_manager.set_capacity(limit.clamp(1, 12));
    Ok(())
}

#[tauri::command]
async fn set_queue_concurrency_limits(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    limits: Vec<crate::ipc::QueueConcurrencyConfig>,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    state
        .queue_manager
        .replace_queue_limits(
            limits
                .into_iter()
                .map(|limit| (limit.id, limit.max_concurrent))
                .collect(),
        )
        .await
}

#[tauri::command]
async fn set_download_speed_limit(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
    limit: Option<String>,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    state
        .queue_manager
        .set_aria2_download_speed_limit(&id, limit)
        .await
}

#[tauri::command]
async fn set_torrent_upload_limit(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
    limit: Option<String>,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    state
        .queue_manager
        .set_aria2_torrent_upload_limit(&id, limit)
        .await
}

#[tauri::command]
async fn set_torrent_peer_options(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
    max_peers: Option<i64>,
    peer_speed_limit: Option<String>,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    state
        .queue_manager
        .set_aria2_torrent_peer_options(&id, max_peers, peer_speed_limit)
        .await
}

#[tauri::command]
async fn get_torrent_peers(
    caller: tauri::WebviewWindow,
    properties: tauri::State<'_, properties_window::PropertiesWindowRegistry>,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<crate::ipc::TorrentPeerDiagnostics, String> {
    properties_window::ensure_properties_or_main(&caller, &properties, &id)?;
    state.queue_manager.get_aria2_torrent_peers(&id).await
}

#[tauri::command]
async fn get_torrent_availability(
    caller: tauri::WebviewWindow,
    properties: tauri::State<'_, properties_window::PropertiesWindowRegistry>,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<crate::ipc::TorrentAvailabilitySnapshot, String> {
    properties_window::ensure_properties_or_main(&caller, &properties, &id)?;
    state.queue_manager.get_aria2_torrent_availability(&id).await
}

#[tauri::command]
async fn get_torrent_file_progress(
    caller: tauri::WebviewWindow,
    properties: tauri::State<'_, properties_window::PropertiesWindowRegistry>,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<crate::ipc::TorrentFileProgressSnapshot, String> {
    properties_window::ensure_properties_or_main(&caller, &properties, &id)?;
    state
        .queue_manager
        .get_aria2_torrent_file_progress(&id)
        .await
}

#[tauri::command]
async fn get_torrent_piece_progress(
    caller: tauri::WebviewWindow,
    properties: tauri::State<'_, properties_window::PropertiesWindowRegistry>,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<crate::ipc::TorrentPieceProgressSnapshot, String> {
    properties_window::ensure_properties_or_main(&caller, &properties, &id)?;
    state
        .queue_manager
        .get_aria2_torrent_piece_progress(&id)
        .await
}

fn torrent_file_selection_snapshot(
    metadata: &crate::torrent::ParsedTorrent,
    selected: Option<&[u32]>,
) -> crate::ipc::TorrentFileSelectionSnapshot {
    crate::ipc::TorrentFileSelectionSnapshot {
        files: metadata
            .files
            .iter()
            .map(|file| crate::ipc::TorrentFileSelectionEntry {
                index: file.index,
                relative_path: file.path.clone(),
                length: file.length,
                selected: selected.is_none_or(|indices| indices.contains(&file.index)),
                completed_length: None,
            })
            .collect(),
    }
}

fn load_persisted_torrent_item(
    database: &crate::db::DbState,
    id: &str,
) -> Result<crate::ipc::DownloadItem, String> {
    let connection = database.lock()?;
    crate::db::load_downloads(&connection)?
        .into_iter()
        .find_map(|record| {
            serde_json::from_str::<crate::ipc::DownloadItem>(&record)
                .ok()
                .filter(|item| item.id == id)
        })
        .ok_or_else(|| "download is not persisted".to_string())
}

fn persist_torrent_destination(
    database: &crate::db::DbState,
    id: &str,
    destination: &str,
    relocation_check_pending: bool,
) -> Result<(), String> {
    let mut connection = database.lock()?;
    crate::db::mutate_download(
        &mut connection,
        id,
        database.is_portable(),
        |object| {
            object.insert(
                "destination".to_string(),
                serde_json::Value::String(destination.to_string()),
            );
            if relocation_check_pending {
                object.insert(
                    "torrentRelocationCheckPending".to_string(),
                    serde_json::Value::Bool(true),
                );
            } else {
                object.remove("torrentRelocationCheckPending");
            }
            object.insert(
                "torrentMoveDestination".to_string(),
                serde_json::Value::String(destination.to_string()),
            );
            Ok(())
        },
    )
}

fn persist_torrent_telemetry(
    database: &crate::db::DbState,
    id: &str,
    snapshot: crate::queue::TorrentTelemetrySnapshot,
) -> Result<(), String> {
    let mut connection = database.lock()?;
    crate::db::mutate_download(
        &mut connection,
        id,
        database.is_portable(),
        |object| {
            object.insert(
                "torrentUploadedBytes".to_string(),
                serde_json::Value::from(snapshot.uploaded_bytes),
            );
            object.insert(
                "torrentSeededSeconds".to_string(),
                serde_json::Value::from(snapshot.seeded_seconds),
            );
            Ok(())
        },
    )
}

fn persist_torrent_relocation_check(
    database: &crate::db::DbState,
    id: &str,
    pending: bool,
) -> Result<(), String> {
    let mut connection = database.lock()?;
    crate::db::mutate_download(
        &mut connection,
        id,
        database.is_portable(),
        |object| {
            if pending {
                object.insert(
                    "torrentRelocationCheckPending".to_string(),
                    serde_json::Value::Bool(true),
                );
            } else {
                object.remove("torrentRelocationCheckPending");
            }
            Ok(())
        },
    )
}

fn persist_torrent_file_selection(
    database: &crate::db::DbState,
    id: &str,
    expected: Option<&[u32]>,
    selected: Option<&[u32]>,
) -> Result<(), String> {
    let mut connection = database.lock()?;
    crate::db::mutate_download(
        &mut connection,
        id,
        database.is_portable(),
        |object| {
            let current = match object.get("torrentFileIndices") {
                None => None,
                Some(serde_json::Value::Array(indices)) => Some(
                    indices
                        .iter()
                        .map(serde_json::Value::as_u64)
                        .collect::<Option<Vec<_>>>()
                        .ok_or_else(|| {
                            "persisted Torrent file selection is malformed".to_string()
                        })?
                        .into_iter()
                        .map(|index| {
                            u32::try_from(index).map_err(|_| {
                                "persisted Torrent file selection is out of range".to_string()
                            })
                        })
                        .collect::<Result<Vec<_>, String>>()?,
                ),
                Some(_) => {
                    return Err("persisted Torrent file selection is malformed".to_string())
                }
            };
            if current.as_deref() != expected {
                return Err("Torrent file selection changed; reload before applying".to_string());
            }
            if let Some(selected) = selected {
                object.insert("torrentFileIndices".to_string(), serde_json::json!(selected));
            } else {
                object.remove("torrentFileIndices");
            }
            Ok(())
        },
    )
}

#[tauri::command]
async fn get_torrent_file_selection(
    caller: tauri::WebviewWindow,
    properties: tauri::State<'_, properties_window::PropertiesWindowRegistry>,
    state: tauri::State<'_, crate::db::DbState>,
    app_handle: tauri::AppHandle,
    id: String,
) -> Result<crate::ipc::TorrentFileSelectionSnapshot, String> {
    properties_window::ensure_properties_or_main(&caller, &properties, &id)?;
    let item = load_persisted_torrent_item(state.inner(), &id)?;
    if item.is_torrent != Some(true) {
        return Err("file selection is available only for Torrent downloads".to_string());
    }
    let path = item
        .torrent_path
        .as_deref()
        .ok_or_else(|| "Torrent metadata is not resolved yet".to_string())?;
    let path = crate::torrent::validate_managed_torrent_path(&app_handle, &id, path)?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("could not read cached torrent metadata: {error}"))?;
    let metadata = crate::torrent::parse_torrent_bytes(&bytes)?;
    let selected = crate::torrent::validate_selected_indices(
        item.torrent_file_indices.as_deref(),
        metadata.files.len(),
    )?;
    Ok(torrent_file_selection_snapshot(&metadata, selected.as_deref()))
}

#[tauri::command]
async fn set_torrent_file_selection(
    caller: tauri::WebviewWindow,
    properties: tauri::State<'_, properties_window::PropertiesWindowRegistry>,
    state: tauri::State<'_, AppState>,
    database: tauri::State<'_, crate::db::DbState>,
    app_handle: tauri::AppHandle,
    id: String,
    selected_indices: Option<Vec<u32>>,
) -> Result<crate::ipc::TorrentFileSelectionSnapshot, String> {
    properties_window::ensure_properties_or_main(&caller, &properties, &id)?;
    let control_guard = state.queue_manager.acquire_aria2_control(&id).await;
    let item = load_persisted_torrent_item(database.inner(), &id)?;
    if item.is_torrent != Some(true) {
        return Err("file selection is available only for Torrent downloads".to_string());
    }
    if !matches!(
        item.status,
        crate::ipc::DownloadStatus::Ready
            | crate::ipc::DownloadStatus::Staged
            | crate::ipc::DownloadStatus::Queued
            | crate::ipc::DownloadStatus::Paused
            | crate::ipc::DownloadStatus::Failed
    ) {
        return Err("pause the Torrent before changing file selection".to_string());
    }
    let path = item
        .torrent_path
        .as_deref()
        .ok_or_else(|| "Torrent metadata is not resolved yet".to_string())?;
    let path = crate::torrent::validate_managed_torrent_path(&app_handle, &id, path)?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("could not read cached torrent metadata: {error}"))?;
    let metadata = crate::torrent::parse_torrent_bytes(&bytes)?;
    let selected = crate::torrent::validate_selected_indices(
        selected_indices.as_deref(),
        metadata.files.len(),
    )?;
    if item.torrent_remove_unselected_file == Some(true) && selected.is_none() {
        return Err("removing unselected Torrent files requires selecting a subset of files".to_string());
    }

    // Queued tasks already contain the fully resolved payload (proxy,
    // credentials, destination, and retry settings) that the frontend cannot
    // safely reconstruct in this native command. Remove that exact task from
    // the admission queue while ownership and persistence are updated, then
    // restore it at its original position with only the selection changed.
    let pending_task = if matches!(item.status, crate::ipc::DownloadStatus::Queued) {
        let pending_task =
            state
                .queue_manager
                .take_pending_task(&id)
                .await
                .ok_or_else(|| {
                    "Torrent lifecycle changed; retry selection after the queued task settles"
                        .to_string()
                })?;
        if pending_task
            .1
            .payload
            .torrent_file_indices
            .as_deref()
            != item.torrent_file_indices.as_deref()
        {
            state
                .queue_manager
                .restore_pending_task(pending_task.0, pending_task.1)
                .await;
            return Err("Torrent lifecycle changed; reload before changing file selection".to_string());
        }
        Some(pending_task)
    } else {
        None
    };

    if matches!(item.status, crate::ipc::DownloadStatus::Paused) {
        if let Err(error) = detach_download_for_reconfigure_locked(
            &app_handle,
            state.inner(),
            &id,
            &control_guard,
        )
        .await
        {
            return Err(error);
        }
    }

    let (destination, filename) = pending_task
        .as_ref()
        .map(|(_, task)| (task.payload.destination.as_str(), task.payload.filename.as_str()))
        .unwrap_or_else(|| {
            let destination = item.destination.as_deref().unwrap_or("");
            (destination, item.file_name.as_str())
        });
    let destination = if destination.trim().is_empty() {
        verification_destination(&app_handle, &item)?
    } else {
        destination.to_string()
    };
    let previous_ownership = snapshot_download_ownership(&app_handle, &id)?;
    if let Err(error) = register_torrent_output_ownership(
        &app_handle,
        &id,
        &destination,
        filename,
        item.torrent_path.as_deref(),
        selected.as_deref(),
        item.torrent_remove_unselected_file.unwrap_or(false),
    ) {
        if let Some((index, task)) = pending_task.as_ref() {
            state
                .queue_manager
                .restore_pending_task(*index, task.clone())
                .await;
        }
        return Err(error);
    }

    if let Err(error) = persist_torrent_file_selection(
        database.inner(),
        &id,
        item.torrent_file_indices.as_deref(),
        selected.as_deref(),
    ) {
        if let Err(restore_error) = restore_download_ownership(
            &app_handle,
            &id,
            previous_ownership,
        ) {
            log::error!(
                "torrent selection [{}]: failed to restore ownership after persistence failure: {}",
                id,
                restore_error
            );
        }
        if let Some((index, task)) = pending_task.as_ref() {
            state
                .queue_manager
                .restore_pending_task(*index, task.clone())
                .await;
        }
        return Err(error);
    }

    if let Some((index, mut task)) = pending_task {
        task.payload.torrent_file_indices = selected.clone();
        state.queue_manager.restore_pending_task(index, task).await;
    }
    Ok(torrent_file_selection_snapshot(&metadata, selected.as_deref()))
}

#[tauri::command]
async fn get_torrent_details(
    caller: tauri::WebviewWindow,
    properties: tauri::State<'_, properties_window::PropertiesWindowRegistry>,
    state: tauri::State<'_, crate::db::DbState>,
    app_handle: tauri::AppHandle,
    id: String,
) -> Result<crate::ipc::TorrentDetails, String> {
    properties_window::ensure_properties_or_main(&caller, &properties, &id)?;
    let item = load_persisted_torrent_item(state.inner(), &id)?;
    if item.is_torrent != Some(true) {
        return Err("details are available only for Torrent downloads".to_string());
    }
    let path = item
        .torrent_path
        .as_deref()
        .ok_or_else(|| "Torrent metadata is not resolved yet".to_string())?;
    let path = crate::torrent::validate_managed_torrent_path(&app_handle, &id, path)?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("could not read cached torrent metadata: {error}"))?;
    crate::torrent::torrent_details_from_bytes(&bytes)
}

fn torrent_identity_magnet(details: &crate::ipc::TorrentDetails) -> Result<String, String> {
    let info_hash = crate::torrent::canonical_info_hash(&details.info_hash)
        .ok_or_else(|| "Torrent metadata has an invalid info hash".to_string())?;
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("xt", &format!("urn:btih:{info_hash}"));
    if let Some(name) = sanitize_metadata_filename(&details.display_name) {
        let bounded = name.chars().take(255).collect::<String>();
        if !bounded.is_empty() {
            serializer.append_pair("dn", &bounded);
        }
    }
    Ok(format!("magnet:?{}", serializer.finish()))
}

#[tauri::command]
async fn get_torrent_magnet_link(
    caller: tauri::WebviewWindow,
    properties: tauri::State<'_, properties_window::PropertiesWindowRegistry>,
    state: tauri::State<'_, crate::db::DbState>,
    app_handle: tauri::AppHandle,
    id: String,
) -> Result<String, String> {
    properties_window::ensure_properties_or_main(&caller, &properties, &id)?;
    let item = load_persisted_torrent_item(state.inner(), &id)?;
    if item.is_torrent != Some(true) {
        return Err("magnet links are available only for Torrent downloads".to_string());
    }
    let path = item
        .torrent_path
        .as_deref()
        .ok_or_else(|| "Torrent metadata is not resolved yet".to_string())?;
    let path = crate::torrent::validate_managed_torrent_path(&app_handle, &id, path)?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| "Torrent metadata is unavailable".to_string())?;
    let details = crate::torrent::torrent_details_from_bytes(&bytes)?;
    crate::torrent::validate_info_hash(item.torrent_info_hash.as_deref(), &details.info_hash)?;
    torrent_identity_magnet(&details)
}

#[tauri::command]
async fn export_torrent_metadata(
    caller: tauri::WebviewWindow,
    properties: tauri::State<'_, properties_window::PropertiesWindowRegistry>,
    state: tauri::State<'_, crate::db::DbState>,
    app_handle: tauri::AppHandle,
    id: String,
    destination: String,
) -> Result<(), String> {
    properties_window::ensure_properties_or_main(&caller, &properties, &id)?;
    let destination = std::path::PathBuf::from(destination.trim());
    if !destination.is_absolute()
        || destination.extension().and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("torrent"))
    {
        return Err("Choose an absolute .torrent destination".to_string());
    }
    let metadata = std::fs::symlink_metadata(&destination);
    if let Ok(metadata) = metadata {
        if metadata.file_type().is_symlink() {
            return Err("The export destination cannot be a symbolic link".to_string());
        }
        return Err("The export destination already exists".to_string());
    }
    if let Err(error) = metadata {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err("The export destination cannot be accessed".to_string());
        }
    }
    let parent = destination
        .parent()
        .filter(|path| path.is_dir())
        .ok_or_else(|| "The export destination folder is unavailable".to_string())?;
    let _canonical_parent = std::fs::canonicalize(parent)
        .map_err(|_| "The export destination folder is unavailable".to_string())?;

    let item = load_persisted_torrent_item(state.inner(), &id)?;
    if item.is_torrent != Some(true) {
        return Err("metadata export is available only for Torrent downloads".to_string());
    }
    let path = item
        .torrent_path
        .as_deref()
        .ok_or_else(|| "Torrent metadata is not resolved yet".to_string())?;
    let path = crate::torrent::validate_managed_torrent_path(&app_handle, &id, path)?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| "Torrent metadata is unavailable".to_string())?;
    let details = crate::torrent::torrent_details_from_bytes(&bytes)?;
    crate::torrent::validate_info_hash(item.torrent_info_hash.as_deref(), &details.info_hash)?;

    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists => "The export destination already exists".to_string(),
            _ => "The Torrent metadata could not be exported".to_string(),
        })?;
    if file.write_all(&bytes).await.is_err() {
        let _ = tokio::fs::remove_file(&destination).await;
        return Err("The Torrent metadata could not be exported".to_string());
    }
    if file.sync_all().await.is_err() {
        let _ = tokio::fs::remove_file(&destination).await;
        return Err("The Torrent metadata could not be exported".to_string());
    }
    Ok(())
}

fn torrent_move_journal_path(state: &AppState, id: &str) -> Result<std::path::PathBuf, String> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("invalid Torrent download id".to_string());
    }
    Ok(state
        .storage_layout
        .data_dir()
        .join("torrent-moves")
        .join(format!("{id}.json")))
}

async fn write_torrent_move_journal(
    path: &std::path::Path,
    phase: &str,
    id: &str,
    old_destination: &std::path::Path,
    new_destination: &std::path::Path,
    old_primary: Option<&std::path::Path>,
    old_removal_paths: &[std::path::PathBuf],
    new_primary: &std::path::Path,
    new_removal_paths: &[std::path::PathBuf],
    staging_root: &std::path::Path,
    staging_paths: &[std::path::PathBuf],
    old_paths: &[std::path::PathBuf],
    new_paths: &[std::path::PathBuf],
    total_bytes: u64,
) -> Result<(), String> {
    let data = serde_json::json!({
        "phase": phase,
        "id": id,
        "oldDestination": old_destination,
        "newDestination": new_destination,
        "oldPrimary": old_primary,
        "oldRemovalPaths": old_removal_paths,
        "newPrimary": new_primary,
        "newRemovalPaths": new_removal_paths,
        "stagingRoot": staging_root,
        "stagingPaths": staging_paths,
        "oldPaths": old_paths,
        "newPaths": new_paths,
        "totalBytes": total_bytes,
    });
    let bytes = serde_json::to_vec_pretty(&data)
        .map_err(|_| "could not encode Torrent move journal".to_string())?;
    let temporary = path.with_extension("json.tmp");
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(|_| "could not write Torrent move journal".to_string())?;
    tokio::fs::rename(&temporary, path)
        .await
        .map_err(|_| "could not commit Torrent move journal".to_string())
}

#[derive(serde::Deserialize)]
struct TorrentMoveJournal {
    phase: String,
    id: String,
    old_destination: std::path::PathBuf,
    new_destination: std::path::PathBuf,
    #[serde(default)]
    old_primary: Option<std::path::PathBuf>,
    #[serde(default)]
    old_removal_paths: Vec<std::path::PathBuf>,
    #[serde(default)]
    new_primary: Option<std::path::PathBuf>,
    #[serde(default)]
    new_removal_paths: Vec<std::path::PathBuf>,
    #[serde(default)]
    staging_root: Option<std::path::PathBuf>,
    #[serde(default)]
    staging_paths: Vec<std::path::PathBuf>,
    old_paths: Vec<std::path::PathBuf>,
    new_paths: Vec<std::path::PathBuf>,
}

fn validate_torrent_move_recovery_path(
    app_handle: &tauri::AppHandle,
    path: &std::path::Path,
) -> Result<(), String> {
    if !path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
        || crate::path_has_symlink_component(path)
        || !crate::is_safe_path(path, app_handle)
    {
        return Err("Torrent move journal contains an unsafe path".to_string());
    }
    Ok(())
}

fn remove_torrent_move_file(path: &std::path::Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Torrent move recovery could not inspect a managed path".to_string()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("Torrent move recovery found a non-file managed path".to_string())
        }
        Ok(_) => std::fs::remove_file(path)
            .map_err(|_| "Torrent move recovery could not remove a managed file".to_string()),
    }
}

fn remove_torrent_move_staging_root(path: &std::path::Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Torrent move recovery could not inspect staging".to_string()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err("Torrent move recovery found an unsafe staging path".to_string())
        }
        Ok(_) => {
            let mut entries = std::fs::read_dir(path)
                .map_err(|_| "Torrent move recovery could not inspect staging".to_string())?;
            if entries.next().is_some() {
                return Err("Torrent move recovery found unexpected staging data".to_string());
            }
            std::fs::remove_dir(path)
                .map_err(|_| "Torrent move recovery could not remove staging".to_string())
        }
    }
}

fn remove_empty_torrent_move_directories(
    files: &[std::path::PathBuf],
    boundary: &std::path::Path,
) -> Result<(), String> {
    let mut directories = Vec::new();
    for file in files {
        let mut current = file.parent();
        while let Some(directory) = current {
            if crate::platform::paths_equal(directory, boundary)
                || !crate::platform::path_is_within(directory, boundary)
            {
                break;
            }
            if !directories
                .iter()
                .any(|existing: &std::path::PathBuf| {
                    crate::platform::paths_equal(existing, directory)
                })
            {
                directories.push(directory.to_path_buf());
            }
            current = directory.parent();
        }
    }
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        match std::fs::symlink_metadata(&directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Torrent move cleanup could not inspect a directory".to_string()),
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err("Torrent move cleanup found an unsafe directory".to_string());
            }
            Ok(_) => {
                let mut entries = std::fs::read_dir(&directory)
                    .map_err(|_| "Torrent move cleanup could not inspect a directory".to_string())?;
                if entries.next().is_some() {
                    continue;
                }
                std::fs::remove_dir(&directory).map_err(|_| {
                    "Torrent move cleanup could not remove an empty directory".to_string()
                })?;
            }
        }
    }
    Ok(())
}

async fn copy_torrent_move_file(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    let source_metadata = tokio::fs::symlink_metadata(source)
        .await
        .map_err(|_| "Torrent source changed during relocation".to_string())?;
    if !source_metadata.is_file() || source_metadata.file_type().is_symlink() {
        return Err("Torrent source changed to a non-file during relocation".to_string());
    }
    let mut input = tokio::fs::File::open(source)
        .await
        .map_err(|_| "Torrent source could not be opened".to_string())?;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut output = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists => {
                "the Torrent move destination already contains managed output".to_string()
            }
            _ => "Torrent move destination could not be created".to_string(),
        })?;
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .await
            .map_err(|_| "Torrent source could not be read".to_string())?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .await
            .map_err(|_| "Torrent move destination could not be written".to_string())?;
    }
    output
        .sync_all()
        .await
        .map_err(|_| "Torrent move destination could not be synchronized".to_string())
}

async fn cleanup_torrent_move_outputs(
    new_paths: &[std::path::PathBuf],
    staging_paths: &[std::path::PathBuf],
    staging_root: &std::path::Path,
) {
    for path in new_paths.iter().chain(staging_paths.iter()) {
        let _ = tokio::fs::remove_file(path).await;
    }
    let _ = tokio::fs::remove_dir(staging_root).await;
}

async fn digest_torrent_move_file(path: &std::path::Path) -> Result<[u8; 32], String> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| "Torrent move file could not be verified".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Torrent move file is not a regular file".to_string());
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| "Torrent move file could not be opened for verification".to_string())?;
    use sha2::Digest;
    use tokio::io::AsyncReadExt;
    let mut digest = sha2::Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|_| "Torrent move file could not be read for verification".to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest.finalize().into())
}

fn recover_torrent_move_journals(
    app_handle: &tauri::AppHandle,
    database: &crate::db::DbState,
    storage_layout: &crate::storage::StorageLayout,
) -> Result<(), String> {
    let directory = storage_layout.data_dir().join("torrent-moves");
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("could not inspect Torrent move recovery".to_string()),
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let journal: TorrentMoveJournal = match std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        {
            Some(journal) => journal,
            None => {
                log::warn!("leaving malformed Torrent move journal for manual recovery");
                continue;
            }
        };
        if journal.id.is_empty()
            || path.file_stem().and_then(|value| value.to_str()) != Some(journal.id.as_str())
            || journal.old_paths.is_empty()
            || journal.new_paths.len() != journal.old_paths.len()
        {
            log::warn!("leaving invalid Torrent move journal for manual recovery");
            continue;
        }
        let all_paths = journal
            .old_paths
            .iter()
            .chain(journal.new_paths.iter())
            .chain(journal.old_removal_paths.iter())
            .chain(journal.new_removal_paths.iter())
            .chain(journal.old_primary.iter())
            .chain(journal.new_primary.iter());
        if all_paths
            .chain([&journal.old_destination, &journal.new_destination])
            .any(|path| validate_torrent_move_recovery_path(app_handle, path).is_err())
        {
            log::warn!("leaving unsafe Torrent move journal for manual recovery");
            continue;
        }
        if journal.staging_root.as_ref().is_some_and(|root| {
            validate_torrent_move_recovery_path(app_handle, root).is_err()
                || !crate::platform::path_is_within(root, &journal.new_destination)
        }) || journal.staging_paths.iter().any(|path| {
            validate_torrent_move_recovery_path(app_handle, path).is_err()
                || journal
                    .staging_root
                    .as_ref()
                    .is_none_or(|root| !crate::platform::path_is_within(path, root))
        }) {
            log::warn!("leaving unsafe Torrent staging journal for manual recovery");
            continue;
        }
        let mut old_owned_paths = journal
            .old_paths
            .iter()
            .chain(journal.old_removal_paths.iter())
            .chain(journal.old_primary.iter());
        let mut new_owned_paths = journal
            .new_paths
            .iter()
            .chain(journal.new_removal_paths.iter())
            .chain(journal.new_primary.iter());
        if old_owned_paths.any(|path| {
            !crate::platform::path_is_within(path, &journal.old_destination)
        }) || new_owned_paths.any(|path| {
            !crate::platform::path_is_within(path, &journal.new_destination)
        }) {
            log::warn!("leaving Torrent move journal with paths outside its roots");
            continue;
        }
        let item = match load_persisted_torrent_item(database, &journal.id) {
            Ok(item) => item,
            Err(_) => {
                log::warn!(
                    "leaving Torrent move journal {} because its download row is absent",
                    journal.id
                );
                continue;
            }
        };
        let current_destination = item
            .destination
            .as_deref()
            .map(|value| crate::resolve_path(value, app_handle));
        let database_committed = current_destination
            .as_deref()
            .is_some_and(|value| crate::platform::paths_equal(value, &journal.new_destination));
        if database_committed
            || matches!(journal.phase.as_str(), "databaseCommitted" | "sourceCleanupPending")
        {
            let mut cleanup_error = None;
            for old_path in &journal.old_paths {
                if let Err(error) = remove_torrent_move_file(old_path) {
                    cleanup_error = Some(error);
                    break;
                }
            }
            if cleanup_error.is_none() {
                if let Err(error) = remove_empty_torrent_move_directories(
                    &journal.old_paths,
                    &journal.old_destination,
                ) {
                    cleanup_error = Some(error);
                }
            }
            if cleanup_error.is_none() {
                for staging_path in &journal.staging_paths {
                    if let Err(error) = remove_torrent_move_file(staging_path) {
                        cleanup_error = Some(error);
                        break;
                    }
                }
            }
            if cleanup_error.is_none() {
                if let Some(root) = journal.staging_root.as_ref() {
                    if let Err(error) = remove_torrent_move_staging_root(root) {
                        cleanup_error = Some(error);
                    }
                }
            }
            if let Some(error) = cleanup_error {
                log::warn!(
                    "Torrent move recovery [{}] retained the journal: {}",
                    journal.id,
                    error
                );
                let _ = persist_torrent_relocation_check(database, &journal.id, true);
                continue;
            }
            let _ = std::fs::remove_file(&path);
            continue;
        }
        let database_is_old = current_destination
            .as_deref()
            .is_some_and(|value| crate::platform::paths_equal(value, &journal.old_destination));
        if !database_is_old {
            log::warn!(
                "leaving Torrent move journal {} because its destination is neither transaction endpoint",
                journal.id
            );
            continue;
        }
        let mut cleanup_error = None;
        for new_path in &journal.new_paths {
            if let Err(error) = remove_torrent_move_file(new_path) {
                cleanup_error = Some(error);
                break;
            }
        }
        if cleanup_error.is_none() {
            for staging_path in &journal.staging_paths {
                if let Err(error) = remove_torrent_move_file(staging_path) {
                    cleanup_error = Some(error);
                    break;
                }
            }
        }
        if cleanup_error.is_none() {
            if let Some(root) = journal.staging_root.as_ref() {
                if let Err(error) = remove_torrent_move_staging_root(root) {
                    cleanup_error = Some(error);
                }
            }
        }
        if let Some(error) = cleanup_error {
            log::warn!(
                "Torrent move recovery [{}] retained the journal: {}",
                journal.id,
                error
            );
            continue;
        }
        let old_primary = journal
            .old_primary
            .as_ref()
            .or_else(|| journal.old_paths.first());
        let old_owned_paths = journal
            .old_paths
            .iter()
            .filter(|path| {
                !journal
                    .old_removal_paths
                    .iter()
                    .any(|removal| crate::platform::paths_equal(path, removal))
            })
            .cloned()
            .collect::<Vec<_>>();
        if let Some(old_primary) = old_primary {
            if let Err(error) = crate::download_ownership::set_owned_paths_with_primary_and_removal(
                app_handle,
                &journal.id,
                old_primary,
                &old_owned_paths,
                &journal.old_removal_paths,
            ) {
                log::warn!(
                    "Torrent move recovery [{}] could not restore ownership: {}",
                    journal.id,
                    error
                );
                continue;
            }
        }
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

fn torrent_move_path_pair(
    old_root: &std::path::Path,
    new_root: &std::path::Path,
    path: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    if crate::platform::paths_equal(path, old_root) {
        if crate::path_has_symlink_component(new_root) {
            return Err("Torrent move destination contains a symbolic link".to_string());
        }
        return crate::canonicalize_with_missing_components(new_root)
            .ok_or_else(|| "Torrent move destination could not be canonicalized".to_string());
    }
    let relative = path
        .strip_prefix(old_root)
        .map_err(|_| "managed Torrent output is outside its current root".to_string())?;
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err("managed Torrent output path is unsafe".to_string());
    }
    let target = new_root.join(relative);
    if crate::path_has_symlink_component(&target) {
        return Err("Torrent move destination contains a symbolic link".to_string());
    }
    Ok(crate::canonicalize_with_missing_components(&target)
        .ok_or_else(|| "Torrent move destination could not be canonicalized".to_string())?)
}

#[tauri::command]
async fn move_torrent_data(
    caller: tauri::WebviewWindow,
    properties: tauri::State<'_, properties_window::PropertiesWindowRegistry>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    database: tauri::State<'_, crate::db::DbState>,
    id: String,
    destination: String,
) -> Result<(), String> {
    properties_window::ensure_properties_or_main(&caller, &properties, &id)?;
    let control_guard = state.queue_manager.acquire_aria2_control(&id).await;
    let item = load_persisted_torrent_item(database.inner(), &id)?;
    if item.is_torrent != Some(true) {
        return Err("data relocation is available only for Torrent downloads".to_string());
    }
    if !matches!(item.status, crate::ipc::DownloadStatus::Paused | crate::ipc::DownloadStatus::Completed | crate::ipc::DownloadStatus::Failed) {
        return Err("pause the Torrent before moving its data".to_string());
    }
    if state.queue_manager.aria2_gid_for_download(&id).is_some() {
        return Err("the Torrent still has an active daemon lifecycle".to_string());
    }
    let old_destination = crate::resolve_path(
        item.destination
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Torrent data has no current destination".to_string())?,
        &app_handle,
    );
    if !old_destination.is_absolute()
        || crate::path_has_symlink_component(&old_destination)
        || !crate::is_safe_path(&old_destination, &app_handle)
    {
        return Err("Torrent current destination is unsafe".to_string());
    }
    let old_destination = std::fs::canonicalize(&old_destination)
        .map_err(|_| "Torrent current destination is unavailable".to_string())?;
    let new_destination = std::path::PathBuf::from(destination.trim());
    if !new_destination.is_absolute()
        || !new_destination.is_dir()
        || crate::path_has_symlink_component(&new_destination)
        || !crate::is_safe_path(&new_destination, &app_handle)
    {
        return Err("choose an existing managed destination folder without symbolic links".to_string());
    }
    let new_destination = std::fs::canonicalize(&new_destination)
        .map_err(|_| "Torrent move destination could not be canonicalized".to_string())?;
    if crate::platform::paths_equal(&old_destination, &new_destination) {
        return Err("the Torrent is already in that destination".to_string());
    }

    let torrent_path = item
        .torrent_path
        .as_deref()
        .ok_or_else(|| "Torrent metadata is not resolved yet".to_string())?;
    let torrent_path = crate::torrent::validate_managed_torrent_path(&app_handle, &id, torrent_path)?;
    let bytes = tokio::fs::read(&torrent_path)
        .await
        .map_err(|_| "Torrent metadata is unavailable".to_string())?;
    let metadata = crate::torrent::parse_torrent_bytes(&bytes)?;
    crate::torrent::validate_info_hash(item.torrent_info_hash.as_deref(), &metadata.info_hash)?;

    let ownership = snapshot_download_ownership(&app_handle, &id)?;
    let old_paths = ownership.owned.clone();
    if old_paths.is_empty() {
        return Err("Torrent data has no managed output files".to_string());
    }
    let old_root = if metadata.files.len() == 1 {
        old_destination.clone()
    } else {
        old_destination.join(&item.file_name)
    };
    let new_root = if metadata.files.len() == 1 {
        new_destination.clone()
    } else {
        new_destination.join(&item.file_name)
    };
    let new_paths = old_paths
        .iter()
        .map(|path| {
            if !path.is_file()
                || std::fs::symlink_metadata(path)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                return Err("managed Torrent output is missing or symbolic".to_string());
            }
            torrent_move_path_pair(&old_root, &new_root, path)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let old_primary = ownership
        .primary
        .as_ref()
        .ok_or_else(|| "Torrent ownership is unavailable".to_string())?;
    let new_primary = torrent_move_path_pair(&old_root, &new_root, old_primary)?;
    let new_removal_paths = ownership
        .removal
        .iter()
        .map(|path| torrent_move_path_pair(&old_root, &new_root, path))
        .collect::<Result<Vec<_>, _>>()?;
    let mut move_old_paths = old_paths.clone();
    let mut move_new_paths = new_paths.clone();
    for (old_path, new_path) in ownership.removal.iter().zip(new_removal_paths.iter()) {
        match std::fs::symlink_metadata(old_path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err("managed Torrent removal path is not a regular file".to_string());
            }
            Ok(_) => {
                if !move_old_paths
                    .iter()
                    .any(|path| crate::platform::paths_equal(path, old_path))
                {
                    move_old_paths.push(old_path.clone());
                    move_new_paths.push(new_path.clone());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("managed Torrent removal path could not be inspected".to_string()),
        }
    }
    if new_paths.iter().any(|path| std::fs::symlink_metadata(path).is_ok())
        || new_removal_paths
            .iter()
            .any(|path| std::fs::symlink_metadata(path).is_ok())
    {
        return Err("the Torrent move destination already contains managed output".to_string());
    }
    let total_bytes = move_old_paths
        .iter()
        .map(|path| std::fs::metadata(path).map(|metadata| metadata.len()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "could not read Torrent data size".to_string())?
        .into_iter()
        .try_fold(0u64, u64::checked_add)
        .ok_or_else(|| "Torrent move size overflowed".to_string())?;
    let staging_root = new_destination.join(format!(".firelink-torrent-move-{id}"));
    if crate::path_has_symlink_component(&staging_root)
        || std::fs::symlink_metadata(&staging_root).is_ok()
    {
        return Err("the Torrent move staging location is unavailable".to_string());
    }
    let staging_paths = move_new_paths
        .iter()
        .enumerate()
        .map(|(index, _)| staging_root.join(format!("{index:08}.part")))
        .collect::<Vec<_>>();
    for path in &move_new_paths {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|_| "could not prepare the Torrent move destination".to_string())?;
        }
    }

    let journal = torrent_move_journal_path(&state, &id)?;
    if let Some(parent) = journal.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| "could not prepare Torrent move recovery".to_string())?;
    }
    state.queue_manager.begin_torrent_move(&id).await;
    if let Err(error) = write_torrent_move_journal(
        &journal,
        "reserved",
        &id,
        &old_destination,
        &new_destination,
        ownership.primary.as_deref(),
        &ownership.removal,
        &new_primary,
        &new_removal_paths,
        &staging_root,
        &staging_paths,
        &move_old_paths,
        &move_new_paths,
        total_bytes,
    )
    .await
    {
        state.queue_manager.finish_torrent_move(&id).await;
        return Err(error);
    }
    if let Err(error) = tokio::fs::create_dir(&staging_root).await {
        let _ = tokio::fs::remove_file(&journal).await;
        state.queue_manager.finish_torrent_move(&id).await;
        return Err(format!("could not prepare Torrent move staging: {error}"));
    }
    if let Err(error) = crate::download_ownership::set_owned_paths_with_primary_and_removal(
        &app_handle,
        &id,
        &new_primary,
        &new_paths,
        &new_removal_paths,
    ) {
        let _ = tokio::fs::remove_file(&journal).await;
        state.queue_manager.finish_torrent_move(&id).await;
        return Err(error);
    }

    use tauri::Emitter;
    let _ = app_handle.emit("download-state", crate::ipc::DownloadStateEvent::new(&id, crate::ipc::DownloadStatus::Moving));
    let mut copied_bytes = 0u64;
    for (source, target) in move_old_paths.iter().zip(staging_paths.iter()) {
        if state.queue_manager.torrent_move_cancelled(&id).await {
            cleanup_torrent_move_outputs(&move_new_paths, &staging_paths, &staging_root).await;
            let _ = restore_download_ownership(&app_handle, &id, ownership.clone());
            let _ = tokio::fs::remove_file(&journal).await;
            state.queue_manager.finish_torrent_move(&id).await;
            let _ = app_handle.emit("download-state", crate::ipc::DownloadStateEvent::new(&id, item.status));
            return Err("Torrent move canceled".to_string());
        }
        if let Err(error) = copy_torrent_move_file(source, target).await {
            cleanup_torrent_move_outputs(&move_new_paths, &staging_paths, &staging_root).await;
            let _ = restore_download_ownership(&app_handle, &id, ownership.clone());
            let _ = tokio::fs::remove_file(&journal).await;
            state.queue_manager.finish_torrent_move(&id).await;
            let _ = app_handle.emit("download-state", crate::ipc::DownloadStateEvent::new(&id, item.status));
            return Err(error);
        }
        let source_size = match tokio::fs::metadata(source).await {
            Ok(metadata) => metadata.len(),
            Err(_) => {
                cleanup_torrent_move_outputs(&move_new_paths, &staging_paths, &staging_root).await;
                let _ = restore_download_ownership(&app_handle, &id, ownership.clone());
                let _ = tokio::fs::remove_file(&journal).await;
                state.queue_manager.finish_torrent_move(&id).await;
                let _ = app_handle.emit(
                    "download-state",
                    crate::ipc::DownloadStateEvent::new(&id, item.status),
                );
                return Err("Torrent source changed during relocation".to_string());
            }
        };
        let target_size = match tokio::fs::metadata(target).await {
            Ok(metadata) => metadata.len(),
            Err(_) => {
                cleanup_torrent_move_outputs(&move_new_paths, &staging_paths, &staging_root).await;
                let _ = restore_download_ownership(&app_handle, &id, ownership.clone());
                let _ = tokio::fs::remove_file(&journal).await;
                state.queue_manager.finish_torrent_move(&id).await;
                let _ = app_handle.emit(
                    "download-state",
                    crate::ipc::DownloadStateEvent::new(&id, item.status),
                );
                return Err("Torrent destination could not be verified".to_string());
            }
        };
        if source_size != target_size {
            cleanup_torrent_move_outputs(&move_new_paths, &staging_paths, &staging_root).await;
            let _ = restore_download_ownership(&app_handle, &id, ownership.clone());
            let _ = tokio::fs::remove_file(&journal).await;
            let _ = app_handle.emit("download-state", crate::ipc::DownloadStateEvent::new(&id, item.status));
            return Err("Torrent data changed during relocation".to_string());
        }
        let source_digest = digest_torrent_move_file(source).await;
        let target_digest = digest_torrent_move_file(target).await;
        if source_digest.is_err() || target_digest.is_err() || source_digest.ok() != target_digest.ok() {
            cleanup_torrent_move_outputs(&move_new_paths, &staging_paths, &staging_root).await;
            let _ = restore_download_ownership(&app_handle, &id, ownership.clone());
            let _ = tokio::fs::remove_file(&journal).await;
            let _ = app_handle.emit("download-state", crate::ipc::DownloadStateEvent::new(&id, item.status));
            return Err("Torrent data changed during relocation".to_string());
        }
        copied_bytes = copied_bytes.saturating_add(target_size);
        let _ = app_handle.emit("torrent-move-progress", crate::ipc::TorrentMoveProgressEvent {
            id: id.clone(),
            fraction: if total_bytes == 0 { 1.0 } else { copied_bytes as f64 / total_bytes as f64 },
            copied_bytes,
            total_bytes,
        });
    }
    if state.queue_manager.torrent_move_cancelled(&id).await {
        cleanup_torrent_move_outputs(&move_new_paths, &staging_paths, &staging_root).await;
        let _ = restore_download_ownership(&app_handle, &id, ownership.clone());
        let _ = tokio::fs::remove_file(&journal).await;
        state.queue_manager.finish_torrent_move(&id).await;
        let _ = app_handle.emit("download-state", crate::ipc::DownloadStateEvent::new(&id, item.status));
        return Err("Torrent move canceled".to_string());
    }
    for (staged, target) in staging_paths.iter().zip(move_new_paths.iter()) {
        if tokio::fs::rename(staged, target).await.is_err() {
            cleanup_torrent_move_outputs(&move_new_paths, &staging_paths, &staging_root).await;
            let _ = restore_download_ownership(&app_handle, &id, ownership.clone());
            let _ = tokio::fs::remove_file(&journal).await;
            state.queue_manager.finish_torrent_move(&id).await;
            let _ = app_handle.emit(
                "download-state",
                crate::ipc::DownloadStateEvent::new(&id, item.status),
            );
            return Err("Torrent move destination could not be published".to_string());
        }
    }
    if tokio::fs::remove_dir(&staging_root).await.is_err() {
        cleanup_torrent_move_outputs(&move_new_paths, &staging_paths, &staging_root).await;
        let _ = restore_download_ownership(&app_handle, &id, ownership.clone());
        let _ = tokio::fs::remove_file(&journal).await;
        state.queue_manager.finish_torrent_move(&id).await;
        let _ = app_handle.emit(
            "download-state",
            crate::ipc::DownloadStateEvent::new(&id, item.status),
        );
        return Err("Torrent move staging could not be finalized".to_string());
    }
    if let Err(error) = write_torrent_move_journal(
        &journal,
        "copied",
        &id,
        &old_destination,
        &new_destination,
        ownership.primary.as_deref(),
        &ownership.removal,
        &new_primary,
        &new_removal_paths,
        &staging_root,
        &staging_paths,
        &move_old_paths,
        &move_new_paths,
        total_bytes,
    )
    .await
    {
        cleanup_torrent_move_outputs(&move_new_paths, &staging_paths, &staging_root).await;
        let _ = restore_download_ownership(&app_handle, &id, ownership.clone());
        let _ = tokio::fs::remove_file(&journal).await;
        state.queue_manager.finish_torrent_move(&id).await;
        let _ = app_handle.emit(
            "download-state",
            crate::ipc::DownloadStateEvent::new(&id, item.status),
        );
        return Err(error);
    }
    let relocation_check_pending = item.torrent_relocation_check_pending == Some(true)
        || matches!(
            item.status,
            crate::ipc::DownloadStatus::Paused | crate::ipc::DownloadStatus::Failed
        );
    if let Err(error) = persist_torrent_destination(
        database.inner(),
        &id,
        &new_destination.to_string_lossy(),
        relocation_check_pending,
    ) {
        cleanup_torrent_move_outputs(&move_new_paths, &staging_paths, &staging_root).await;
        let _ = restore_download_ownership(&app_handle, &id, ownership.clone());
        let _ = tokio::fs::remove_file(&journal).await;
        state.queue_manager.finish_torrent_move(&id).await;
        let _ = app_handle.emit("download-state", crate::ipc::DownloadStateEvent::new(&id, item.status));
        return Err(error);
    }
    if let Err(error) = write_torrent_move_journal(
        &journal,
        "databaseCommitted",
        &id,
        &old_destination,
        &new_destination,
        ownership.primary.as_deref(),
        &ownership.removal,
        &new_primary,
        &new_removal_paths,
        &staging_root,
        &staging_paths,
        &move_old_paths,
        &move_new_paths,
        total_bytes,
    )
    .await
    {
        // The database is already authoritative. Keep the prior journal and
        // let startup recovery finish old-source cleanup from the committed
        // destination rather than rolling the row back after commit.
        let _ = persist_torrent_relocation_check(database.inner(), &id, true);
        state.queue_manager.finish_torrent_move(&id).await;
        let _ = app_handle.emit(
            "download-state",
            crate::ipc::DownloadStateEvent::new(&id, item.status),
        );
        return Err(format!("Torrent data moved; cleanup recovery remains pending: {error}"));
    }
    let mut cleanup_error: Option<String> = None;
    for path in &move_old_paths {
        if let Err(error) = tokio::fs::remove_file(path).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                cleanup_error = Some(error.to_string());
            }
        }
    }
    if cleanup_error.is_none() {
        if let Err(error) = remove_empty_torrent_move_directories(
            &move_old_paths,
            &old_destination,
        ) {
            cleanup_error = Some(error);
        }
    }
    if let Some(error) = cleanup_error {
        let _ = persist_torrent_destination(database.inner(), &id, &new_destination.to_string_lossy(), true);
        if let Err(journal_error) = write_torrent_move_journal(
            &journal,
            "sourceCleanupPending",
            &id,
            &old_destination,
            &new_destination,
            ownership.primary.as_deref(),
            &ownership.removal,
            &new_primary,
            &new_removal_paths,
            &staging_root,
            &staging_paths,
            &move_old_paths,
            &move_new_paths,
            total_bytes,
        ).await {
            state.queue_manager.finish_torrent_move(&id).await;
            let _ = app_handle.emit(
                "download-state",
                crate::ipc::DownloadStateEvent::new(&id, item.status),
            );
            return Err(format!(
                "Torrent data moved, but cleanup recovery could not be recorded: {journal_error}"
            ));
        }
        state.queue_manager.finish_torrent_move(&id).await;
        let _ = app_handle.emit("download-state", crate::ipc::DownloadStateEvent::new(&id, item.status));
        drop(control_guard);
        return Err(format!("Torrent data moved, but old files need cleanup: {error}"));
    }
    let _ = tokio::fs::remove_file(&journal).await;
    state.queue_manager.finish_torrent_move(&id).await;
    let _ = app_handle.emit("download-state", crate::ipc::DownloadStateEvent::new(&id, item.status));
    drop(control_guard);
    Ok(())
}

#[tauri::command]
async fn cancel_torrent_move_data(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    if id.trim().is_empty() {
        return Err("invalid Torrent download id".to_string());
    }
    state.queue_manager.cancel_torrent_move(&id).await;
    Ok(())
}

fn verification_destination(
    app_handle: &tauri::AppHandle,
    item: &crate::ipc::DownloadItem,
) -> Result<String, String> {
    if let Some(destination) = item
        .destination
        .as_deref()
        .map(str::trim)
        .filter(|destination| !destination.is_empty())
    {
        return Ok(destination.to_string());
    }

    let settings = crate::settings::load_settings(app_handle)?;
    let base = settings.base_download_folder.trim();
    let base = if base.is_empty() { "~/Downloads" } else { base };
    let base_path = crate::resolve_path(base, app_handle);
    if !settings.category_subfolders_enabled {
        return Ok(base_path.to_string_lossy().to_string());
    }

    let category = format!("{:?}", item.category);
    if let Some(override_path) = settings
        .category_directory_overrides
        .get(&category)
        .map(|value| value.trim())
        .filter(|override_path| !override_path.is_empty())
    {
        return Ok(crate::resolve_path(override_path, app_handle)
            .to_string_lossy()
            .to_string());
    }
    let subfolder = settings
        .category_subfolders
        .get(&category)
        .map(|value| value.trim())
        .unwrap_or("");
    if subfolder.is_empty() {
        Ok(base_path.to_string_lossy().to_string())
    } else {
        Ok(base_path.join(subfolder).to_string_lossy().to_string())
    }
}

#[tauri::command]
async fn verify_torrent_data(
    caller: tauri::WebviewWindow,
    properties: tauri::State<'_, properties_window::PropertiesWindowRegistry>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    database: tauri::State<'_, crate::db::DbState>,
    id: String,
) -> Result<(), String> {
    properties_window::ensure_properties_or_main(&caller, &properties, &id)?;
    // Verification replaces the current Aria2 lifecycle. Serialize that
    // replacement with pause/resume/remove so a paused GID cannot reject the
    // maintenance enqueue as a duplicate task or race it with a late event.
    let control_guard = state.queue_manager.acquire_aria2_control(&id).await;
    let item = load_persisted_torrent_item(database.inner(), &id)?;
    if item.is_torrent != Some(true) {
        return Err("integrity verification is available only for Torrent downloads".to_string());
    }
    if !matches!(
        item.status,
        crate::ipc::DownloadStatus::Completed
            | crate::ipc::DownloadStatus::Paused
            | crate::ipc::DownloadStatus::Failed
    ) {
        return Err("pause the Torrent before verifying its data".to_string());
    }
    let path = item
        .torrent_path
        .as_deref()
        .ok_or_else(|| "Torrent metadata is not resolved yet".to_string())?;
    let path = crate::torrent::validate_managed_torrent_path(&app_handle, &id, path)?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("could not read cached torrent metadata: {error}"))?;
    let metadata = crate::torrent::parse_torrent_bytes(&bytes)?;
    crate::torrent::validate_info_hash(item.torrent_info_hash.as_deref(), &metadata.info_hash)?;
    let restore_status = item.status.as_str().to_string();
    let restore_status_value = item.status;
    let restore_has_been_dispatched = item.has_been_dispatched;
    let destination = verification_destination(&app_handle, &item)?;
    if matches!(item.status, crate::ipc::DownloadStatus::Paused) {
        detach_download_for_reconfigure_locked(
            &app_handle,
            state.inner(),
            &id,
            &control_guard,
        )
        .await?;
    } else if state.queue_manager.is_registered(&id).await
        || state.queue_manager.aria2_gid_for_download(&id).is_some()
    {
        return Err("Torrent lifecycle changed; pause it before verifying its data".to_string());
    }
    // Allocate the internally-created generation after detaching any retained
    // paused lifecycle, so the value includes every cancellation watermark
    // observed during that transition. Reservation still remains the atomic
    // acceptance point immediately before ownership registration.
    let verification_generation = state.queue_manager.next_enqueue_generation(&id).await?;
    let enqueue_item = queue::EnqueueItem {
        id: item.id.clone(),
        queue_id: item
            .queue_id
            .clone()
            .unwrap_or_else(|| "00000000-0000-0000-0000-000000000001".to_string()),
        url: item.url.clone(),
        destination,
        filename: item.file_name.clone(),
        connections: item.connections,
        speed_limit: item.speed_limit.clone(),
        username: item.username.clone(),
        password: item.password.clone(),
        sftp_host_key_md: item.sftp_host_key_md.clone(),
        headers: item.headers.clone(),
        checksum: item.checksum.clone(),
        cookies: item.cookies.clone(),
        mirrors: None,
        user_agent: None,
        max_tries: Some(0),
        proxy: None,
        format_selector: None,
        cookie_source: None,
        is_media: Some(false),
        is_torrent: Some(true),
        torrent_path: item.torrent_path.clone(),
        torrent_file_indices: item.torrent_file_indices.clone(),
        torrent_info_hash: item.torrent_info_hash.clone(),
        torrent_seed_time: None,
        torrent_seed_ratio: None,
        torrent_seed_remaining: None,
        torrent_web_seeds: None,
        torrent_upload_limit: None,
        torrent_max_peers: None,
        torrent_peer_speed_limit: None,
        torrent_check_integrity: Some(true),
        torrent_trackers: None,
        torrent_exclude_trackers: None,
        torrent_tracker_connect_timeout: None,
        torrent_tracker_timeout: None,
        torrent_tracker_interval: None,
        torrent_stop_timeout: None,
        torrent_prioritize_piece: None,
        // Preserve the existing removal reservation in the ownership record,
        // but the verify-only option path returns before emitting
        // bt-remove-unselected-file, so this maintenance lifecycle cannot
        // delete data.
        torrent_remove_unselected_file: item.torrent_remove_unselected_file,
        torrent_encryption_policy: None,
        torrent_file_allocation: item.torrent_file_allocation.clone(),
        torrent_verify_only: Some(true),
        torrent_verify_restore_status: Some(restore_status.clone()),
        lifecycle_generation: Some(verification_generation.to_string()),
    };

    {
        let mut connection = database.lock()?;
        crate::db::mutate_download(
            &mut connection,
            &id,
            database.is_portable(),
            |object| {
                object.insert("status".to_string(), serde_json::json!("queued"));
                object.insert("hasBeenDispatched".to_string(), serde_json::json!(false));
                object.insert("torrentVerifyOnly".to_string(), serde_json::json!(true));
                object.insert(
                    "torrentVerifyRestoreStatus".to_string(),
                    serde_json::json!(restore_status),
                );
                object.insert(
                    "torrentVerifyNative".to_string(),
                    serde_json::json!(restore_status),
                );
                Ok(())
            },
        )?;
    }

    if let Err(error) =
        enqueue_download_locked(&app_handle, state.inner(), enqueue_item, &control_guard).await
    {
        // Roll back only this verification marker, and only while the row is
        // still this verification lifecycle (queued or already restored by a
        // renderer snapshot). Never restore the stale full array captured
        // before enqueue: frontend persistence or another command may have
        // changed unrelated rows in the meantime.
        let rollback_result = (|| {
            let mut connection = database.lock()?;
            crate::db::mutate_download(
                &mut connection,
                &id,
                database.is_portable(),
                |object| {
                    let has_verification_marker = object
                        .get("torrentVerifyOnly")
                        .and_then(serde_json::Value::as_bool)
                        == Some(true)
                        && object
                            .get("torrentVerifyRestoreStatus")
                            .and_then(serde_json::Value::as_str)
                            == Some(restore_status.as_str());
                    let current_status = object
                        .get("status")
                        .and_then(serde_json::Value::as_str);
                    let is_verification_marker = has_verification_marker
                        && (current_status == Some("queued")
                            || current_status == Some(restore_status.as_str()));
                    // The native marker is an additional persistence fence,
                    // not a prerequisite for rollback. A renderer snapshot
                    // may have already acknowledged and removed that native
                    // marker while enqueue is still in flight; the failed
                    // operation must still clear its own queued lifecycle.
                    if is_verification_marker {
                        object.insert(
                            "status".to_string(),
                            serde_json::json!(restore_status),
                        );
                        match restore_has_been_dispatched {
                            Some(value) => {
                                object.insert(
                                    "hasBeenDispatched".to_string(),
                                    serde_json::json!(value),
                                );
                            }
                            None => {
                                object.remove("hasBeenDispatched");
                            }
                        }
                        object.remove("torrentVerifyOnly");
                        object.remove("torrentVerifyRestoreStatus");
                        object.remove("torrentVerifyNative");
                    }
                    Ok(is_verification_marker)
                },
            )
        })();
        let rollback_applied = match rollback_result {
            Ok(applied) => applied,
            Err(rollback_error) => {
                return Err(format!(
                    "{error}; failed to roll back Torrent verification state: {rollback_error}"
                ));
            }
        };
        if rollback_applied {
            use tauri::Emitter;
            let _ = app_handle.emit(
                "download-state",
                crate::ipc::DownloadStateEvent::new(&id, restore_status_value),
            );
        }
        return Err(error.to_string());
    }
    Ok(())
}

fn replace_persisted_torrent_web_seeds(
    database: &crate::db::DbState,
    id: &str,
    seeds: &[crate::ipc::TorrentWebSeed],
) -> Result<Option<serde_json::Value>, String> {
    let mut connection = database.lock()?;
    let next_seeds = serde_json::to_value(seeds)
        .map_err(|error| format!("failed to encode Torrent web seeds: {error}"))?;
    crate::db::mutate_download(
        &mut connection,
        id,
        database.is_portable(),
        |object| {
            let previous_seeds = object.get("torrentWebSeeds").cloned();
            object.insert("torrentWebSeeds".to_string(), next_seeds.clone());
            object.insert("torrentWebSeedsNative".to_string(), next_seeds.clone());
            Ok(previous_seeds)
        },
    )
}

fn restore_persisted_torrent_web_seeds(
    database: &crate::db::DbState,
    id: &str,
    expected_seeds: &[crate::ipc::TorrentWebSeed],
    previous_seeds: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut connection = database.lock()?;
    let expected_value = serde_json::to_value(expected_seeds)
        .map_err(|error| format!("failed to encode expected Torrent web seeds: {error}"))?;
    crate::db::mutate_download(
        &mut connection,
        id,
        database.is_portable(),
        |object| {
            if object.get("torrentWebSeeds") == Some(&expected_value) {
                match previous_seeds.clone() {
                    Some(previous) => {
                        object.insert("torrentWebSeeds".to_string(), previous);
                    }
                    None => {
                        object.remove("torrentWebSeeds");
                    }
                }
                object.remove("torrentWebSeedsNative");
            } else {
                log::warn!(
                    "Torrent web-seed rollback [{}] skipped because persisted state changed concurrently",
                    id
                );
            }
            Ok(())
        },
    )
}

async fn normalize_persisted_torrent_web_seeds(
    database: &crate::db::DbState,
    app_handle: &tauri::AppHandle,
    id: &str,
    seeds: &[crate::ipc::TorrentWebSeed],
) -> Result<Vec<crate::ipc::TorrentWebSeed>, String> {
    let record = {
        let connection = database.lock()?;
        crate::db::load_downloads(&connection)?
            .into_iter()
            .find_map(|record| {
                serde_json::from_str::<crate::ipc::DownloadItem>(&record)
                    .ok()
                    .filter(|item| item.id == id)
            })
            .ok_or_else(|| "download is not persisted".to_string())?
    };
    let path = record
        .torrent_path
        .as_deref()
        .ok_or_else(|| "Torrent metadata is unavailable for web-seed management".to_string())?;
    let path = crate::torrent::validate_managed_torrent_path(app_handle, id, path)?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("could not read cached Torrent metadata: {error}"))?;
    let metadata = crate::torrent::parse_torrent_bytes(&bytes)?;
    let normalized = crate::queue::normalize_torrent_web_seeds(Some(seeds), &metadata.files)?;
    let web_seed_uris = normalized.iter().map(|seed| seed.uri.clone()).collect::<Vec<_>>();
    validate_torrent_web_seed_destinations(&web_seed_uris).await?;
    Ok(normalized)
}

#[tauri::command]
async fn get_torrent_web_seeds(
    caller: tauri::WebviewWindow,
    properties: tauri::State<'_, properties_window::PropertiesWindowRegistry>,
    database: tauri::State<'_, crate::db::DbState>,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<crate::ipc::TorrentWebSeed>, String> {
    properties_window::ensure_properties_or_main(
        &caller,
        &properties,
        &id,
    )?;
    let control_guard = state.queue_manager.acquire_aria2_control(&id).await;
    if state.queue_manager.is_registered(&id).await
        && matches!(state.queue_manager.active_kind(&id).await, Some(crate::queue::TaskKind::Aria2))
    {
        return state
            .queue_manager
            .get_aria2_torrent_web_seeds_locked(&id, &control_guard)
            .await;
    }
    let persisted_seeds = {
        let connection = database.lock()?;
        crate::db::load_downloads(&connection)?
            .into_iter()
            .find_map(|record| {
                serde_json::from_str::<crate::ipc::DownloadItem>(&record)
                    .ok()
                    .filter(|item| item.id == id)
                    .map(|item| item.torrent_web_seeds)
            })
            .ok_or_else(|| "download is not persisted".to_string())?
    };
    let Some(seeds) = persisted_seeds else {
        return Ok(Vec::new());
    };
    if seeds.is_empty() {
        return Ok(seeds);
    }
    normalize_persisted_torrent_web_seeds(
        database.inner(),
        &state.queue_manager.app_handle(),
        &id,
        &seeds,
    )
    .await
}

#[tauri::command]
async fn set_torrent_web_seeds(
    caller: tauri::WebviewWindow,
    database: tauri::State<'_, crate::db::DbState>,
    state: tauri::State<'_, AppState>,
    id: String,
    seeds: Vec<crate::ipc::TorrentWebSeed>,
) -> Result<Vec<crate::ipc::TorrentWebSeed>, String> {
    properties_window::ensure_main_window(&caller)?;
    let control_guard = state.queue_manager.acquire_aria2_control(&id).await;
    let active = state.queue_manager.is_registered(&id).await
        && matches!(state.queue_manager.active_kind(&id).await, Some(crate::queue::TaskKind::Aria2));
    let normalized = if active {
        state
            .queue_manager
            .normalize_aria2_torrent_web_seeds_locked(&id, &seeds, &control_guard)
            .await?
    } else {
        normalize_persisted_torrent_web_seeds(
            database.inner(),
            &state.queue_manager.app_handle(),
            &id,
            &seeds,
        )
        .await?
    };
    let web_seed_uris = normalized.iter().map(|seed| seed.uri.clone()).collect::<Vec<_>>();
    validate_torrent_web_seed_destinations(&web_seed_uris).await?;
    let previous_seeds =
        replace_persisted_torrent_web_seeds(database.inner(), &id, &normalized)?;
    // The download can cross the queued/active boundary while metadata is
    // being normalized and persistence is updated. Recheck before returning
    // so a newly active Torrent receives the live Aria2 change instead of
    // waiting for a restart to apply its persisted value.
    let active_now = state.queue_manager.is_registered(&id).await
        && matches!(state.queue_manager.active_kind(&id).await, Some(crate::queue::TaskKind::Aria2));
    if !active_now {
        return Ok(normalized);
    }
    match state
        .queue_manager
        .set_aria2_torrent_web_seeds_locked(&id, normalized.clone(), &control_guard)
        .await
    {
        Ok((result, previous_live_seeds)) => {
            if let Err(persist_error) =
                replace_persisted_torrent_web_seeds(database.inner(), &id, &result)
            {
                // The live operation succeeded, but the durable value must
                // remain transactional. Try to restore the exact value that
                // was persisted before this command before reporting the
                // persistence failure to the caller.
                if let Err(rollback_error) = state
                    .queue_manager
                    .set_aria2_torrent_web_seeds_locked(
                        &id,
                        previous_live_seeds,
                        &control_guard,
                    )
                    .await
                {
                    log::error!(
                        "Torrent web-seed live rollback [{}] failed after persistence error: {}",
                        id,
                        rollback_error
                    );
                }
                if let Err(restore_error) = restore_persisted_torrent_web_seeds(
                    database.inner(),
                    &id,
                    &normalized,
                    previous_seeds.clone(),
                ) {
                    log::error!(
                        "Torrent web-seed persistence rollback [{}] failed: {}",
                        id,
                        restore_error
                    );
                }
                return Err(format!(
                    "Torrent web seeds changed live but could not be persisted: {persist_error}"
                ));
            }
            Ok(result)
        }
        Err(error) => {
            if let Err(restore_error) = restore_persisted_torrent_web_seeds(
                database.inner(),
                &id,
                &normalized,
                previous_seeds,
            ) {
                log::error!("Torrent web-seed rollback [{}] failed: {}", id, restore_error);
            }
            Err(error)
        }
    }
}

pub(crate) fn normalize_speed_limit_for_aria2(limit: &str) -> Option<String> {
    let trimmed = limit.trim();
    if trimmed.is_empty() {
        return None;
    }

    let re = regex::Regex::new(r"(?i)^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?(?:/s)?$").ok()?;
    let captures = re.captures(trimmed)?;
    let amount = captures.get(1)?.as_str().parse::<f64>().ok()?;
    if !amount.is_finite() || amount <= 0.0 {
        return None;
    }

    let unit = captures
        .get(2)
        .map(|m| m.as_str().to_ascii_uppercase())
        .unwrap_or_default();
    Some(if unit.is_empty() {
        format!("{amount}K")
    } else {
        format!("{amount}{unit}")
    })
}

fn normalize_torrent_overall_upload_limit(limit: Option<&str>) -> Result<Option<String>, String> {
    let Some(limit) = limit else {
        return Ok(None);
    };
    if limit.trim().is_empty() {
        return Ok(None);
    }
    normalize_speed_limit_for_aria2(limit)
        .map(Some)
        .ok_or_else(|| "Torrent overall upload limit is invalid".to_string())
}

fn apply_aria2_torrent_peer_discovery_options(
    command: &mut std::process::Command,
    enable_dht: bool,
    enable_dht6: bool,
    enable_pex: bool,
    enable_lpd: bool,
) {
    // These are daemon-global BitTorrent options. Keep them explicit at
    // launch so Firelink does not silently inherit a different aria2
    // configuration from the host or a future bundled-engine default.
    command
        .arg(format!("--enable-dht={enable_dht}"))
        .arg(format!("--enable-dht6={enable_dht6}"))
        .arg(format!("--enable-peer-exchange={enable_pex}"))
        .arg(format!("--bt-enable-lpd={enable_lpd}"));
}

fn apply_aria2_torrent_network_options(
    command: &mut std::process::Command,
    listen_port: &str,
    dht_listen_port: &str,
    external_ip: &str,
    dht_entry_point: &str,
    dht_entry_point6: &str,
    dht_listen_addr6: &str,
    lpd_interface: &str,
    bind_address: &str,
    ipv6_enabled: bool,
) {
    for (option, value) in [
        ("--listen-port", listen_port),
        ("--dht-listen-port", dht_listen_port),
        ("--bt-external-ip", external_ip),
        ("--dht-entry-point", dht_entry_point),
        ("--dht-entry-point6", dht_entry_point6),
        ("--dht-listen-addr6", dht_listen_addr6),
        ("--bt-lpd-interface", lpd_interface),
    ] {
        let value = value.trim();
        if !value.is_empty() {
            command.arg(format!("{option}={value}"));
        }
    }
    if !bind_address.trim().is_empty() {
        command.arg(format!("--interface={}", bind_address.trim()));
    }
    if !ipv6_enabled {
        command.arg("--disable-ipv6=true");
    }
}

fn apply_aria2_torrent_dht_paths(
    command: &mut std::process::Command,
    dht_path: &std::path::Path,
    dht6_path: &std::path::Path,
) {
    command
        .arg(format!("--dht-file-path={}", dht_path.display()))
        .arg(format!("--dht-file-path6={}", dht6_path.display()));
}

fn apply_aria2_torrent_dht_options(
    command: &mut std::process::Command,
    message_timeout: u32,
) {
    let timeout = queue::normalize_torrent_dht_message_timeout(message_timeout)
        .unwrap_or(queue::DEFAULT_TORRENT_DHT_MESSAGE_TIMEOUT);
    command.arg(format!("--dht-message-timeout={timeout}"));
}

fn apply_aria2_torrent_peer_identity_options(
    command: &mut std::process::Command,
    peer_id_prefix: &str,
    peer_agent: &str,
) {
    for (option, value) in [
        ("--peer-id-prefix", peer_id_prefix),
        ("--peer-agent", peer_agent),
    ] {
        let value = value.trim();
        if !value.is_empty() {
            command.arg(format!("{option}={value}"));
        }
    }
}

fn aria2_rpc_port_is_occupied(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
}

fn apply_aria2_torrent_global_options(
    command: &mut std::process::Command,
    max_open_files: u32,
    overall_upload_limit: Option<&str>,
    disk_cache: &str,
) {
    let max_open_files = queue::normalize_torrent_max_open_files(max_open_files)
        .unwrap_or(queue::DEFAULT_TORRENT_MAX_OPEN_FILES);
    command.arg(format!("--bt-max-open-files={max_open_files}"));
    let disk_cache = queue::normalize_aria2_disk_cache(Some(disk_cache))
        .unwrap_or_else(|_| queue::DEFAULT_ARIA2_DISK_CACHE.to_string());
    command.arg(format!("--disk-cache={disk_cache}"));
    if let Some(limit) = overall_upload_limit.and_then(normalize_speed_limit_for_aria2) {
        command.arg(format!("--max-overall-upload-limit={limit}"));
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn set_torrent_max_open_files(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    max_open_files: u32,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    let max_open_files = queue::normalize_torrent_max_open_files(max_open_files)?;
    rpc_call(
        state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
        &state.aria2_secret,
        "aria2.changeGlobalOption",
        serde_json::json!([{"bt-max-open-files": max_open_files.to_string()}]),
    )
    .await
    .map(|_| ())
    .map_err(|error| format!("Failed to set Torrent maximum open files: {error}"))
}

#[tauri::command]
async fn set_torrent_overall_upload_limit(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    limit: Option<String>,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    let normalized_limit = normalize_torrent_overall_upload_limit(limit.as_deref())?;
    let limit_str = normalized_limit.as_deref().unwrap_or("0");
    rpc_call(
        state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
        &state.aria2_secret,
        "aria2.changeGlobalOption",
        serde_json::json!([{"max-overall-upload-limit": limit_str}]),
    )
    .await
    .map(|_| ())
    .map_err(|error| format!("Failed to set Torrent overall upload limit: {error}"))
}

#[tauri::command]
async fn set_global_speed_limit(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    limit: Option<String>,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    let normalized_limit = limit
        .as_deref()
        .and_then(normalize_speed_limit_for_aria2);
    let limit_str = normalized_limit.clone().unwrap_or_else(|| "0".to_string());
    rpc_call(
        state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
        &state.aria2_secret,
        "aria2.changeGlobalOption",
        serde_json::json!([{"max-overall-download-limit": limit_str}]),
    )
    .await
    .map(|_| {
        state
            .queue_manager
            .set_aria2_global_speed_limit(normalized_limit);
    })
    .map_err(|e| {
        eprintln!("Failed to set global speed limit: {}", e);
        e
    })
}

#[tauri::command]
fn check_automation_permission(caller: tauri::WebviewWindow) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    #[cfg(target_os = "macos")]
    {
        use objc::runtime::Object;
        use objc::{class, msg_send, sel, sel_impl};
        use std::ffi::CString;
        use std::ptr::null_mut;

        unsafe {
            objc::rc::autoreleasepool(|| {
                let script = "tell application \"System Events\" to get name";
                let c_script = CString::new(script).unwrap();
                let ns_string_class = class!(NSString);
                let script_str: *mut Object = msg_send![ns_string_class, alloc];
                let script_str: *mut Object = msg_send![script_str, initWithUTF8String: c_script.as_ptr()];

                let ns_apple_script: *mut Object = msg_send![class!(NSAppleScript), alloc];
                let ns_apple_script: *mut Object = msg_send![ns_apple_script, initWithSource: script_str];

                let mut error_dict: *mut Object = null_mut();
                let result: *mut Object = msg_send![ns_apple_script, executeAndReturnError: &mut error_dict];

                let _: () = msg_send![script_str, release];
                let _: () = msg_send![ns_apple_script, release];

                if result.is_null() {
                    return Err("Automation permission was not granted".to_string());
                }
                Ok(())
            })
        }
    }

    #[cfg(not(target_os = "macos"))]
    Ok(())
}

#[tauri::command]
fn request_automation_permission(caller: tauri::WebviewWindow) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    #[cfg(target_os = "macos")]
    {
        system_shutdown::request_permission_dialog()
            .map_err(|error| format!("Automation permission was not granted: {error}"))
    }

    #[cfg(not(target_os = "macos"))]
    Ok(())
}

#[tauri::command]
#[allow(unused_variables)]
fn open_automation_settings(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_opener::OpenerExt;
        app_handle
            .opener()
            .open_url(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
                None::<String>,
            )
            .map_err(|e| format!("Failed to open Automation settings: {}", e))?;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    Err("Automation settings are only available on macOS".to_string())
}

#[tauri::command]
fn get_free_space(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<String, String> {
    properties_window::ensure_main_window(&caller)?;
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();

    let resolved_dest = resolve_path(&path, &app_handle);

    // Find the disk that the path is mounted on
    let mut best_match: Option<&sysinfo::Disk> = None;
    let mut max_match_len = 0;

    for disk in disks.list() {
        let mount_point = disk.mount_point();
        if crate::platform::path_is_within(&resolved_dest, mount_point) {
            let match_len = mount_point.as_os_str().len();
            if match_len > max_match_len {
                max_match_len = match_len;
                best_match = Some(disk);
            }
        }
    }

    if let Some(disk) = best_match {
        let bytes = disk.available_space();
        let size_str = if bytes < 1024 * 1024 {
            format!("{:.1} KB", bytes as f64 / 1024.0)
        } else if bytes < 1024 * 1024 * 1024 {
            format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
        } else {
            format!("{:.2} GB", bytes as f64 / 1024.0 / 1024.0 / 1024.0)
        };
        Ok(size_str)
    } else {
        Ok("Unknown".to_string())
    }
}

#[tauri::command(async)]
fn set_keychain_password(
    caller: tauri::WebviewWindow,
    database: tauri::State<'_, crate::db::DbState>,
    state: tauri::State<'_, AppState>,
    id: String,
    password: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    if state.storage_layout.is_portable()
        && id == crate::db::PAIRING_TOKEN_KEYCHAIN_ID
    {
        let connection = database.lock()?;
        crate::db::save_pairing_token_to_settings(&connection, &password, true)?;
        return Ok(());
    }
    require_keychain_access(&state)?;
    crate::db::set_keychain_password(&id, &password)
}

#[tauri::command(async)]
fn get_keychain_password(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    properties_window::ensure_main_window(&caller)?;
    if state.storage_layout.is_portable()
        && id == crate::db::PAIRING_TOKEN_KEYCHAIN_ID
    {
        return Err("portable pairing token is stored in portable settings".to_string());
    }
    require_keychain_access(&state)?;
    crate::db::get_keychain_password(&id)
}

#[tauri::command(async)]
fn delete_keychain_password(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    if state.storage_layout.is_portable()
        && id == crate::db::PAIRING_TOKEN_KEYCHAIN_ID
    {
        return Ok(());
    }
    require_keychain_access(&state)?;
    crate::db::delete_keychain_password(&id)
}

#[tauri::command(async)]
fn save_site_login(
    caller: tauri::WebviewWindow,
    database: tauri::State<'_, crate::db::DbState>,
    state: tauri::State<'_, AppState>,
    id: String,
    url_pattern: String,
    username: String,
    password: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    require_keychain_access(&state)?;
    let connection = database.lock()?;
    crate::db::save_site_login(&connection, &id, &url_pattern, &username, &password)
}

#[tauri::command(async)]
fn delete_site_login(
    caller: tauri::WebviewWindow,
    database: tauri::State<'_, crate::db::DbState>,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    require_keychain_access(&state)?;
    let connection = database.lock()?;
    crate::db::delete_site_login(&connection, &id)
}

/// Arm credential-store access after the frontend has completed its startup
/// decision. The process-local gate prevents any stale or early IPC caller
/// from producing a native OS prompt before the explanation is visible.
#[tauri::command]
fn authorize_keychain_access(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    if state.storage_layout.is_portable() {
        return Ok(());
    }
    state
        .keychain_access_authorized
        .store(true, Ordering::Release);
    Ok(())
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
struct PairingTokenHydration {
    token: String,
    token_changed: bool,
    persistent: bool,
    error: Option<String>,
}

#[derive(Default)]
struct KeychainGrantState {
    request_id: Option<String>,
    abandoned_request_ids: HashSet<String>,
    cancelled: bool,
    committed: bool,
    result: Option<Result<PairingTokenHydration, String>>,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
struct KeychainGrantStatus {
    started: bool,
    in_progress: bool,
    result: Option<PairingTokenHydration>,
}

/// Hydrate the extension pairing token after the frontend is ready. Standard
/// mode uses the OS credential store; portable mode intentionally keeps the
/// token with the portable settings folder.
#[tauri::command(async)]
fn hydrate_extension_pairing_token(
    caller: tauri::WebviewWindow,
    database: tauri::State<'_, crate::db::DbState>,
    app_state: tauri::State<'_, AppState>,
) -> Result<PairingTokenHydration, String> {
    properties_window::ensure_main_window(&caller)?;
    let connection = database.lock()?;

    if app_state.storage_layout.is_portable() {
        let token = crate::db::load_pairing_token_from_settings(&connection)?
            .unwrap_or_else(crate::db::generate_pairing_token);
        crate::db::save_pairing_token_to_settings(&connection, &token, true)?;
        if let Ok(mut pairing_token) = app_state.extension_pairing_token.write() {
            *pairing_token = token.clone();
        }
        return Ok(PairingTokenHydration {
            token,
            token_changed: false,
            persistent: true,
            error: None,
        });
    }

    require_keychain_access(&app_state)?;
    let migration_error = crate::db::migrate_legacy_pairing_token(&connection).err();
    let keychain_token = crate::db::get_keychain_password(crate::db::PAIRING_TOKEN_KEYCHAIN_ID)
        .ok()
        .filter(|value| !value.trim().is_empty());
    let persistent = keychain_token.is_some();
    let token = keychain_token.unwrap_or_else(crate::db::generate_pairing_token);
    if !persistent && crate::db::has_user_data(&connection)? {
        crate::db::record_notice(&connection, crate::db::TOKEN_CHANGED_NOTICE)?;
    }
    let token_changed =
        crate::db::has_pending_notice(&connection, crate::db::TOKEN_CHANGED_NOTICE)?;
    if let Ok(mut pairing_token) = app_state.extension_pairing_token.write() {
        *pairing_token = token.clone();
    }
    Ok(PairingTokenHydration {
        token,
        token_changed,
        persistent,
        error: migration_error.or_else(|| {
            (!persistent).then(|| {
                "Credential store access is unavailable; browser pairing is session-only.".to_string()
            })
        }),
    })
}

/// Return the per-launch pairing token without touching the OS credential
/// store. Startup uses this while the frontend explains credential access and
/// waits for an explicit user decision.
#[tauri::command]
fn get_session_pairing_token(
    caller: tauri::WebviewWindow,
    app_state: tauri::State<'_, AppState>,
) -> Result<PairingTokenHydration, String> {
    properties_window::ensure_main_window(&caller)?;
    let token = app_state
        .extension_pairing_token
        .read()
        .map_err(|_| "Extension pairing token lock is unavailable".to_string())?
        .clone();
    if token.trim().is_empty() {
        return Err("Session pairing token is not initialized".to_string());
    }
    Ok(PairingTokenHydration {
        token,
        token_changed: false,
        persistent: false,
        error: None,
    })
}

#[tauri::command(async)]
fn regenerate_pairing_token(
    caller: tauri::WebviewWindow,
    database: tauri::State<'_, crate::db::DbState>,
    app_state: tauri::State<'_, AppState>,
) -> Result<PairingTokenHydration, String> {
    properties_window::ensure_main_window(&caller)?;
    let connection = database.lock()?;
    let generated = crate::db::generate_pairing_token();

    if app_state.storage_layout.is_portable() {
        crate::db::save_pairing_token_to_settings(&connection, &generated, true)?;
    } else {
        require_keychain_access(&app_state)?;
        if let Err(error) = crate::db::migrate_legacy_pairing_token(&connection) {
            let token = app_state
                .extension_pairing_token
                .read()
                .map_err(|_| "Extension pairing token lock is unavailable".to_string())?
                .clone();
            return Ok(PairingTokenHydration {
                token,
                token_changed: false,
                persistent: false,
                error: Some(error),
            });
        }
        if let Err(error) = crate::db::set_keychain_password(
            crate::db::PAIRING_TOKEN_KEYCHAIN_ID,
            &generated,
        ) {
            let token = app_state
                .extension_pairing_token
                .read()
                .map_err(|_| "Extension pairing token lock is unavailable".to_string())?
                .clone();
            return Ok(PairingTokenHydration {
                token,
                token_changed: false,
                persistent: false,
                error: Some(error),
            });
        }
    }

    if let Ok(mut pairing_token) = app_state.extension_pairing_token.write() {
        *pairing_token = generated.clone();
    }
    Ok(PairingTokenHydration {
        token: generated,
        token_changed: false,
        persistent: true,
        error: None,
    })
}

// Keychain access can synchronously show an OS authentication prompt. Keep
// the IPC command genuinely asynchronous and isolate all blocking credential
// store work from both the WebView and Tauri's async worker threads. This is
// important on macOS, where the Security framework can block while presenting
// an authorization prompt, and on Linux/Windows where the native stores may
// also perform synchronous IPC to their desktop credential service.
#[tauri::command]
async fn grant_keychain_access(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    request_id: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    validate_keychain_grant_request_id(&request_id)?;
    let app_state = app_handle.state::<AppState>();
    let grant_guard = begin_keychain_grant(app_state.inner(), &request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let database = app_handle.state::<crate::db::DbState>();
        let app_state = app_handle.state::<AppState>();
        let result = grant_keychain_access_blocking(
            database.inner(),
            app_state.inner(),
            grant_guard,
        );
        let Ok(mut grant) = app_state.keychain_grant.lock() else {
            log::warn!("keychain grant state lock is unavailable");
            return;
        };
        if grant.request_id.as_deref() != Some(request_id.as_str()) || grant.cancelled {
            log::debug!("keychain grant result discarded after dismissal");
            return;
        }
        if let Err(error) = &result {
            log::warn!("keychain grant worker failed: {error}");
        }
        grant.result = Some(result);
    });
    Ok(())
}

#[tauri::command]
fn get_keychain_grant_status(
    caller: tauri::WebviewWindow,
    app_state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<KeychainGrantStatus, String> {
    properties_window::ensure_main_window(&caller)?;
    validate_keychain_grant_request_id(&request_id)?;
    let grant = app_state
        .keychain_grant
        .lock()
        .map_err(|_| "Keychain grant state lock is unavailable".to_string())?;
    let started = grant.request_id.as_deref() == Some(request_id.as_str());
    let result = if started {
        grant.result.as_ref().map(|result| match result {
            Ok(result) => result.clone(),
            Err(error) => PairingTokenHydration {
                token: String::new(),
                token_changed: false,
                persistent: false,
                error: Some(error.clone()),
            },
        })
    } else {
        None
    };
    let in_progress = app_state
        .keychain_grant_in_progress
        .load(Ordering::Acquire);
    Ok(KeychainGrantStatus {
        started,
        in_progress,
        result,
    })
}

#[tauri::command]
fn accept_keychain_grant(
    caller: tauri::WebviewWindow,
    app_state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<PairingTokenHydration, String> {
    properties_window::ensure_main_window(&caller)?;
    validate_keychain_grant_request_id(&request_id)?;
    let mut grant = app_state
        .keychain_grant
        .lock()
        .map_err(|_| "Keychain grant state lock is unavailable".to_string())?;
    if grant.request_id.as_deref() != Some(request_id.as_str()) {
        return Err("Keychain grant request is no longer active".to_string());
    }
    let result = grant
        .result
        .take()
        .ok_or_else(|| "Keychain grant result is no longer available".to_string())??;
    if !result.persistent || result.token.trim().is_empty() {
        return Ok(result);
    }
    let mut pairing_token = app_state
        .extension_pairing_token
        .write()
        .map_err(|_| "Extension pairing token lock is unavailable".to_string())?;
    *pairing_token = result.token.clone();
    app_state
        .keychain_access_authorized
        .store(true, Ordering::Release);
    grant.committed = true;
    log::debug!("keychain grant accepted; extension token updated");
    Ok(result)
}

#[tauri::command]
fn abandon_keychain_grant(
    caller: tauri::WebviewWindow,
    app_state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<Option<PairingTokenHydration>, String> {
    properties_window::ensure_main_window(&caller)?;
    validate_keychain_grant_request_id(&request_id)?;
    let mut grant = app_state
        .keychain_grant
        .lock()
        .map_err(|_| "Keychain grant state lock is unavailable".to_string())?;
    if grant.request_id.as_deref() != Some(request_id.as_str()) {
        if grant.abandoned_request_ids.len() >= MAX_ABANDONED_KEYCHAIN_REQUESTS {
            return Err("Too many pending keychain grant requests".to_string());
        }
        grant.abandoned_request_ids.insert(request_id);
        return Ok(None);
    }
    if grant.committed {
        let token = app_state
            .extension_pairing_token
            .read()
            .map_err(|_| "Extension pairing token lock is unavailable".to_string())?
            .clone();
        return Ok(Some(PairingTokenHydration {
            token,
            token_changed: false,
            persistent: true,
            error: None,
        }));
    }
    grant.cancelled = true;
    grant.result = None;
    Ok(None)
}

fn grant_keychain_access_blocking(
    database: &crate::db::DbState,
    app_state: &AppState,
    _grant_guard: KeychainGrantGuard,
) -> Result<PairingTokenHydration, String> {
    log::debug!("keychain grant worker started");
    let connection = database.lock()?;
    log::debug!("keychain grant database access acquired");

    if app_state.storage_layout.is_portable() {
        let token = if let Some(existing) = crate::db::load_pairing_token_from_settings(&connection)?
        {
            existing
        } else {
            let generated = crate::db::generate_pairing_token();
            crate::db::save_pairing_token_to_settings(&connection, &generated, true)?;
            generated
        };
        log::debug!("keychain grant completed using portable storage");
        return Ok(PairingTokenHydration {
            token,
            token_changed: false,
            persistent: true,
            error: None,
        });
    }

    if let Err(error) = crate::db::migrate_legacy_pairing_token(&connection) {
        log::debug!("keychain grant legacy migration did not complete");
        let token = app_state
            .extension_pairing_token
            .read()
            .map_err(|_| "Extension pairing token lock is unavailable".to_string())?
            .clone();
        return Ok(PairingTokenHydration {
            token,
            token_changed: false,
            persistent: false,
            error: Some(error),
        });
    }

    let token = match crate::db::get_keychain_password(crate::db::PAIRING_TOKEN_KEYCHAIN_ID) {
        Ok(token) if !token.trim().is_empty() => token,
        _ => {
            let generated = crate::db::generate_pairing_token();
            if let Err(error) = crate::db::set_keychain_password(
                crate::db::PAIRING_TOKEN_KEYCHAIN_ID,
                &generated,
            ) {
                let current = app_state
                    .extension_pairing_token
                    .read()
                    .map_err(|_| "Extension pairing token lock is unavailable".to_string())?
                    .clone();
                return Ok(PairingTokenHydration {
                    token: current,
                    token_changed: false,
                    persistent: false,
                    error: Some(error),
                });
            }
            generated
        }
    };
    log::debug!("keychain grant credential operation completed");
    Ok(PairingTokenHydration {
        token,
        token_changed: false,
        persistent: true,
        error: None,
    })
}

#[tauri::command]
fn acknowledge_pairing_token_change(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, crate::db::DbState>,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    let connection = state.lock()?;
    crate::db::acknowledge_pairing_token_notice(&connection)
}

#[tauri::command]
fn db_save_settings(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, crate::db::DbState>,
    app_state: tauri::State<'_, AppState>,
    data: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    let connection = state.lock()?;
    let existing = crate::db::load_settings(&connection)?;
    let merged = crate::settings::preserve_scheduler_runtime_keys(existing.as_deref(), &data)?;
    let merged = if state.is_portable() {
        crate::settings::preserve_portable_pairing_token(existing.as_deref(), &merged)?
    } else {
        let sanitized = crate::db::strip_pairing_token_from_settings(&merged)?;
        crate::db::preserve_legacy_pairing_token(existing.as_deref(), &sanitized)?
    };
    let merged = crate::settings::canonicalize_torrent_network_settings(&merged)?;
    crate::db::save_settings(&connection, &merged)?;
    let decoded = crate::settings::decode_stored_settings(&serde_json::Value::String(merged))?;
    let prevent_system_sleep = decoded.prevents_sleep_while_downloading;
    let prevent_display_sleep = decoded.prevents_display_sleep_while_downloading;
    if let Ok(mut cached) = app_state.scheduler_settings.write() {
        *cached = Some(decoded.clone());
    }
    app_state.queue_manager.configure_seed_capacity(
        decoded.torrent_separate_seed_slots,
        decoded.torrent_max_concurrent_seeds,
    );
    if let Err(error) = app_state
        .power_manager
        .set_preferences(prevent_system_sleep, prevent_display_sleep)
    {
        log::warn!("power: saved settings applied with an OS assertion error: {error}");
    }
    Ok(())
}

#[tauri::command]
fn db_load_settings(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, crate::db::DbState>,
) -> Result<Option<String>, String> {
    properties_window::ensure_main_window(&caller)?;
    let connection = state.lock()?;
    let settings = crate::db::load_settings(&connection)?;
    if state.is_portable() {
        return settings
            .map(|data| crate::settings::canonicalize_torrent_network_settings(&data))
            .transpose();
    }
    settings
        .map(|data| crate::db::strip_pairing_token_from_settings(&data))
        .transpose()?
        .map(|data| crate::settings::canonicalize_torrent_network_settings(&data))
        .transpose()
}

#[tauri::command]
fn db_get_all_downloads(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, crate::db::DbState>,
) -> Result<Vec<String>, String> {
    properties_window::ensure_main_window(&caller)?;
    let connection = state.lock()?;
    crate::db::load_downloads(&connection)
}

#[tauri::command]
async fn clear_torrent_removal_paths(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    // This command is reached from the trusted renderer, but it still owns a
    // destructive reservation boundary. Serialize it with terminal/control
    // transitions and refuse to clear a lifecycle that the backend still
    // owns. The frontend's registration set is only a hint and must not be
    // the safety check.
    let _control_guard = state.queue_manager.acquire_aria2_control(&id).await;
    if state.queue_manager.aria2_gid_for_download(&id).is_some()
        || state.queue_manager.is_registered(&id).await
    {
        return Err(
            "cannot clear Torrent removal paths while the backend owns the download".to_string(),
        );
    }
    crate::download_ownership::clear_torrent_removal_paths(&app_handle, &id)
}

#[tauri::command]
fn reconcile_torrent_removal_reservations(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, crate::db::DbState>,
) -> Result<usize, String> {
    properties_window::ensure_main_window(&caller)?;
    let connection = state.lock()?;
    crate::db::reconcile_torrent_removal_paths_after_restart(&connection)
}

fn retained_torrent_id_from_persisted_record(record: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(record).ok()?;
    let object = value.as_object()?;
    if object.get("isTorrent").and_then(serde_json::Value::as_bool) != Some(true)
        || object.get("torrentPath").is_none_or(serde_json::Value::is_null)
    {
        return None;
    }
    object
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
}

fn retained_torrent_info_hash_from_persisted_record(record: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(record).ok()?;
    let object = value.as_object()?;
    if object.get("isTorrent").and_then(serde_json::Value::as_bool) != Some(true)
        || object.get("torrentPath").is_none_or(serde_json::Value::is_null)
    {
        return None;
    }
    object
        .get("torrentInfoHash")
        .and_then(serde_json::Value::as_str)
        .and_then(crate::torrent::canonical_info_hash)
}

#[tauri::command]
fn db_replace_downloads(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, crate::db::DbState>,
    data: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    let portable = state.is_portable();
    let mut connection = state.lock()?;
    let existing = crate::db::load_downloads(&connection)?;
    let data = merge_durable_torrent_telemetry(&existing, &data)?;
    crate::db::replace_downloads(&mut connection, &data, portable)
}

fn persisted_destinations_equal(left: &str, right: &str) -> bool {
    let left = std::path::Path::new(left.trim());
    let right = std::path::Path::new(right.trim());
    crate::platform::paths_equal(left, right)
        || std::fs::canonicalize(left)
            .ok()
            .zip(std::fs::canonicalize(right).ok())
            .is_some_and(|(left, right)| crate::platform::paths_equal(&left, &right))
}

/// The renderer saves complete download snapshots, while native commands and
/// the poller checkpoint Torrent state independently. Merge these writers at
/// the persistence boundary so an older renderer snapshot cannot lower native
/// lifetime totals or roll back a just-committed relocation.
fn merge_durable_torrent_telemetry(existing: &[String], data: &str) -> Result<String, String> {
    let mut native_state: HashMap<
        String,
        (
            u64,
            u64,
            Option<String>,
            bool,
            Option<serde_json::Value>,
            Option<String>,
        ),
    > = HashMap::new();
    for record in existing {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(record) else {
            continue;
        };
        let Some(object) = value.as_object() else {
            continue;
        };
        let Some(id) = object.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let uploaded = object
            .get("torrentUploadedBytes")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let seeded = object
            .get("torrentSeededSeconds")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        native_state.insert(
            id.to_string(),
            (
                uploaded,
                seeded,
                object
                    .get("torrentMoveDestination")
                    .and_then(serde_json::Value::as_str)
                    .map(ToString::to_string),
                object
                    .get("torrentRelocationCheckPending")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true),
                object.get("torrentWebSeedsNative").cloned(),
                object
                    .get("torrentVerifyNative")
                    .and_then(serde_json::Value::as_str)
                    .map(ToString::to_string),
            ),
        );
    }

    let mut values: serde_json::Value = serde_json::from_str(data)
        .map_err(|error| format!("failed to decode downloads: {error}"))?;
    let records = values
        .as_array_mut()
        .ok_or_else(|| "persisted downloads must be an array".to_string())?;
    for value in records {
        let Some(object) = value.as_object_mut() else {
            continue;
        };
        let Some(id) = object.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some((
            existing_uploaded,
            existing_seeded,
            native_destination,
            relocation_check_pending,
            native_web_seeds,
            native_verify_restore_status,
        )) = native_state.get(id).cloned()
        else {
            continue;
        };
        if let Some(native_destination) = native_destination {
            let incoming_destination = object
                .get("destination")
                .and_then(serde_json::Value::as_str);
            if incoming_destination
                .is_some_and(|value| persisted_destinations_equal(value, &native_destination))
            {
                object.remove("torrentMoveDestination");
            } else {
                object.insert(
                    "destination".to_string(),
                    serde_json::Value::String(native_destination.clone()),
                );
                object.insert(
                    "torrentMoveDestination".to_string(),
                    serde_json::Value::String(native_destination),
                );
            }
        }
        if relocation_check_pending {
            object.insert(
                "torrentRelocationCheckPending".to_string(),
                serde_json::Value::Bool(true),
            );
        }
        if let Some(native_web_seeds) = native_web_seeds {
            if object.get("torrentWebSeeds") == Some(&native_web_seeds) {
                object.remove("torrentWebSeedsNative");
            } else {
                object.insert("torrentWebSeeds".to_string(), native_web_seeds.clone());
                object.insert("torrentWebSeedsNative".to_string(), native_web_seeds);
            }
        }
        if let Some(restore_status) = native_verify_restore_status {
            let incoming_acknowledges_marker = object
                .get("torrentVerifyOnly")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
                && object
                    .get("torrentVerifyRestoreStatus")
                    .and_then(serde_json::Value::as_str)
                    == Some(restore_status.as_str());
            object.insert(
                "torrentVerifyOnly".to_string(),
                serde_json::Value::Bool(true),
            );
            object.insert(
                "torrentVerifyRestoreStatus".to_string(),
                serde_json::Value::String(restore_status.clone()),
            );
            if incoming_acknowledges_marker {
                object.remove("torrentVerifyNative");
            } else {
                object.insert(
                    "torrentVerifyNative".to_string(),
                    serde_json::Value::String(restore_status),
                );
            }
        }
        let uploaded = object
            .get("torrentUploadedBytes")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
            .max(existing_uploaded);
        let seeded = object
            .get("torrentSeededSeconds")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
            .max(existing_seeded);
        if existing_uploaded > 0 || object.contains_key("torrentUploadedBytes") {
            object.insert(
                "torrentUploadedBytes".to_string(),
                serde_json::Value::from(uploaded),
            );
        }
        if existing_seeded > 0 || object.contains_key("torrentSeededSeconds") {
            object.insert(
                "torrentSeededSeconds".to_string(),
                serde_json::Value::from(seeded),
            );
        }
    }
    serde_json::to_string(&values)
        .map_err(|error| format!("failed to encode downloads: {error}"))
}

#[tauri::command]
fn db_get_all_queues(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, crate::db::DbState>,
) -> Result<Vec<String>, String> {
    properties_window::ensure_main_window(&caller)?;
    let connection = state.lock()?;
    crate::db::load_queues(&connection)
}

#[tauri::command]
fn db_replace_queues(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, crate::db::DbState>,
    data: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    let mut connection = state.lock()?;
    crate::db::replace_queues(&mut connection, &data)
}

#[tauri::command]
fn check_file_exists(caller: tauri::WebviewWindow, app_handle: tauri::AppHandle, path: String) -> bool {
    if properties_window::ensure_main_window(&caller).is_err() {
        return false;
    }
    let resolved_dest = resolve_path(&path, &app_handle);
    if !is_safe_path(&resolved_dest, &app_handle) {
        return false;
    }
    resolved_dest.exists()
}

fn collect_log_files(log_dir: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
    let directory_metadata = match std::fs::symlink_metadata(log_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("failed to inspect log directory: {error}")),
    };
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Ok(Vec::new());
    }

    let canonical_log_dir = match std::fs::canonicalize(log_dir) {
        Ok(path) if path.is_dir() => path,
        Ok(_) | Err(_) => return Ok(Vec::new()),
    };
    let entries = match std::fs::read_dir(log_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("failed to read log directory: {error}")),
    };

    let mut files = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|error| format!("failed to inspect log directory entry: {error}"))?
            .path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("failed to inspect log file '{}': {error}", path.display()))?;
        if !metadata.file_type().is_file()
            || metadata.file_type().is_symlink()
            || !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().contains(".log"))
        {
            continue;
        }

        let canonical_path = std::fs::canonicalize(&path)
            .map_err(|error| format!("failed to resolve log file '{}': {error}", path.display()))?;
        if canonical_path.starts_with(&canonical_log_dir) {
            files.push(canonical_path);
        }
    }
    files.sort();
    Ok(files)
}

async fn log_files(app_handle: &tauri::AppHandle) -> Result<Vec<std::path::PathBuf>, String> {
    let log_dir = app_handle
        .state::<AppState>()
        .storage_layout
        .log_dir()
        .to_path_buf();
    collect_log_files(&log_dir)
}

pub(crate) fn redact_sensitive_text(line: &str) -> String {
    use std::sync::OnceLock;
    static SECRET: OnceLock<regex::Regex> = OnceLock::new();
    static QUOTED_SECRET: OnceLock<regex::Regex> = OnceLock::new();
    static HEADER: OnceLock<regex::Regex> = OnceLock::new();
    static QUERY: OnceLock<regex::Regex> = OnceLock::new();
    static USERINFO: OnceLock<regex::Regex> = OnceLock::new();
    static FRAGMENT: OnceLock<regex::Regex> = OnceLock::new();
    let secret = SECRET.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(authorization|proxy-authorization|cookie|set-cookie|password|token|secret|credential|pairing[-_ ]?token|api[-_ ]?key)\s*[:=]\s*([^\r\n,;]+)",
        )
            .expect("valid secret redaction regex")
    });
    let quoted_secret = QUOTED_SECRET.get_or_init(|| {
        regex::Regex::new(
            r#"(?i)(["'])(authorization|proxy-authorization|cookie|set-cookie|password|token|secret|credential|pairing[-_ ]?token|api[-_ ]?key)(["'])(\s*[:=]\s*)["'][^"\r\n,;]*["']"#,
        )
        .expect("valid quoted secret redaction regex")
    });
    let header = HEADER.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]+",
        )
            .expect("valid sensitive header redaction regex")
    });
    let query = QUERY.get_or_init(|| {
        regex::Regex::new(r"([A-Za-z][A-Za-z0-9+.-]*://[^\s?]+)\?[^\s]+")
            .expect("valid URL query redaction regex")
    });
    let userinfo = USERINFO.get_or_init(|| {
        regex::Regex::new(r"(?i)([A-Za-z][A-Za-z0-9+.-]*://)[^@\s/?#]+@")
            .expect("valid URL userinfo redaction regex")
    });
    let fragment = FRAGMENT.get_or_init(|| {
        regex::Regex::new(r"([A-Za-z][A-Za-z0-9+.-]*://[^\s?#]+)#\S+")
            .expect("valid URL fragment redaction regex")
    });
    let redacted = header.replace_all(line, "$1: [redacted]");
    let redacted = quoted_secret.replace_all(&redacted, "$1$2$3$4[redacted]");
    let redacted = secret.replace_all(&redacted, "$1=[redacted]");
    let redacted = userinfo.replace_all(&redacted, "$1[redacted]@");
    let redacted = query.replace_all(&redacted, "$1?[redacted]");
    fragment
        .replace_all(&redacted, "$1#[redacted]")
        .into_owned()
}

fn redact_log_line(line: &str) -> String {
    redact_sensitive_text(line)
}

fn redact_log_line_for_output(line: &str) -> String {
    static HOME_PATHS: OnceLock<(String, String)> = OnceLock::new();
    let (home, escaped_home) = HOME_PATHS.get_or_init(|| {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        let home = if home.len() > 3 { home } else { String::new() };
        let escaped_home = home.replace('\\', "\\\\");
        (home, escaped_home)
    });

    let mut redacted = line.to_string();
    if !home.is_empty() {
        redacted = redacted.replace(home, "<HOME>");
    }
    if !escaped_home.is_empty() && escaped_home != home {
        redacted = redacted.replace(escaped_home, "<HOME>");
    }
    redact_log_line(&redacted)
}

fn redact_log_line_for_app(line: &str, app_handle: &tauri::AppHandle) -> String {
    use tauri::Manager;
    let without_home = app_handle
        .path()
        .home_dir()
        .ok()
        .map(|home| {
            let home = home.to_string_lossy();
            line.replace(home.as_ref(), "~")
        })
        .unwrap_or_else(|| line.to_string());
    redact_log_line(&without_home)
}

#[tauri::command]
async fn read_logs(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    limit: usize,
) -> Result<Vec<String>, String> {
    properties_window::ensure_main_window(&caller)?;
    let mut lines = Vec::new();
    for file in log_files(&app_handle).await? {
        let content = tokio::fs::read_to_string(&file)
            .await
            .map_err(|error| format!("failed to read '{}': {error}", file.display()))?;
        lines.extend(
            content
                .lines()
                .map(|line| redact_log_line_for_app(line, &app_handle)),
        );
    }
    let keep = limit.clamp(1, 10_000);
    if lines.len() > keep {
        lines.drain(..lines.len() - keep);
    }
    Ok(lines)
}

#[tauri::command]
async fn clear_logs(caller: tauri::WebviewWindow, app_handle: tauri::AppHandle) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    for file in log_files(&app_handle).await? {
        tokio::fs::write(&file, "")
            .await
            .map_err(|e| format!("Failed to clear log file {:?}: {}", file, e))?;
    }
    Ok(())
}

#[tauri::command]
async fn export_logs(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    destination: Option<String>,
) -> Result<String, String> {
    properties_window::ensure_main_window(&caller)?;
    let mut output = format!(
        "Firelink support logs\nVersion: {}\nOS: {} {}\nArchitecture: {}\nGenerated: {}\n\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::FAMILY,
        std::env::consts::ARCH,
        chrono::Utc::now().to_rfc3339(),
    );
    let (aria2, ytdlp, ffmpeg, deno) = tokio::join!(
        check_aria2(
            &app_handle,
            state.aria2_port.load(std::sync::atomic::Ordering::Relaxed),
            &state.aria2_secret
        ),
        check_ytdlp(&app_handle),
        check_ffmpeg(&app_handle),
        check_deno(&app_handle),
    );
    output.push_str("Engine status:\n");
    for engine in [aria2, ytdlp, ffmpeg, deno] {
        output.push_str(&format!(
            "- {}: {}{}\n",
            engine.name,
            if engine.ready { "ready" } else { "unavailable" },
            engine
                .version
                .as_deref()
                .map(|version| format!(" ({version})"))
                .unwrap_or_default()
        ));
        if let Some(error) = engine.error {
            output.push_str(&format!("  Error: {}\n", redact_log_line(&error)));
        }
    }
    if let Ok(settings) = crate::settings::load_settings(&app_handle) {
        output.push_str(&format!(
            "\nRuntime settings:\n- Max concurrent downloads: {}\n- Per-server connections: {}\n- Automatic retries: {}\n- Proxy mode: {:?}\n- Scheduler enabled: {}\n\n",
            settings.max_concurrent_downloads,
            settings.per_server_connections,
            settings.max_automatic_retries,
            settings.proxy_mode,
            settings.scheduler.enabled,
        ));
    }
    for file in log_files(&app_handle).await? {
        let file_name = file
            .file_name()
            .map(|name| name.to_string_lossy())
            .unwrap_or_else(|| std::borrow::Cow::Borrowed("firelink.log"));
        output.push_str(&format!("===== {} =====\n", file_name));
        let content = tokio::fs::read_to_string(&file)
            .await
            .map_err(|error| format!("failed to read '{}': {error}", file.display()))?;
        for line in content.lines() {
            output.push_str(&redact_log_line_for_app(line, &app_handle));
            output.push('\n');
        }
        output.push('\n');
    }

    if let Some(destination) = destination {
        let destination = std::path::PathBuf::from(destination.trim());
        if destination.file_name().is_none() {
            return Err("log export destination must be a file path".to_string());
        }
        tokio::fs::write(&destination, &output)
            .await
            .map_err(|error| format!("failed to write exported logs to '{}': {error}", destination.display()))?;
    }
    Ok(output)
}

#[tauri::command]
fn toggle_tray_icon(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    show: bool,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    if show {
        build_main_tray(&app_handle)
    } else {
        if app_handle.tray_by_id("main").is_some() {
            let _ = app_handle.remove_tray_by_id("main");
        }
        Ok(())
    }
}

fn build_main_tray(app_handle: &tauri::AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    if app_handle.tray_by_id("main").is_some() {
        return Ok(());
    }

    let show_i = MenuItem::with_id(app_handle, "show", "Show Firelink", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let pause_all_i = MenuItem::with_id(app_handle, "pause_all", "Pause All", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let resume_all_i =
        MenuItem::with_id(app_handle, "resume_all", "Resume All", true, None::<&str>)
            .map_err(|e| e.to_string())?;
    let quit_i = MenuItem::with_id(app_handle, "quit", "Quit", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app_handle, &[&show_i, &pause_all_i, &resume_all_i, &quit_i])
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    let tray_icon_bytes = include_bytes!("../icons/trayTemplate.png").as_slice();
    #[cfg(not(target_os = "macos"))]
    let tray_icon_bytes = include_bytes!("../icons/128x128.png").as_slice();
    let tray_icon = tauri::image::Image::from_bytes(tray_icon_bytes).map_err(|e| e.to_string())?;
    #[allow(unused_mut)]
    let mut tray = TrayIconBuilder::with_id("main")
        .icon(tray_icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => restore_main_window(app),
            "pause_all" => {
                use tauri::Emitter;
                let _ = app.emit("tray-action", "pause-all");
            }
            "resume_all" => {
                use tauri::Emitter;
                let _ = app.emit("tray-action", "resume-all");
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                restore_main_window(tray.app_handle());
            }
        });
    #[cfg(target_os = "macos")]
    {
        tray = tray.icon_as_template(true);
    }
    tray.build(app_handle).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn set_extension_pairing_token(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    if token.is_empty() || token.len() > 512 {
        return Err("Invalid extension pairing token".to_string());
    }

    let mut pairing_token = state
        .extension_pairing_token
        .write()
        .map_err(|_| "Extension pairing token lock is unavailable".to_string())?;
    *pairing_token = token;
    Ok(())
}

#[tauri::command]
fn get_extension_server_port(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Option<u16> {
    if properties_window::ensure_main_window(&caller).is_err() {
        return None;
    }
    state
        .extension_server_port
        .read()
        .ok()
        .and_then(|port| *port)
}

#[tauri::command]
fn set_extension_frontend_ready(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    ready: bool,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    state
        .extension_frontend_ready
        .store(ready, Ordering::Release);
    let coordinator = state.download_coordinator.clone();
    tauri::async_runtime::spawn(async move {
        let _ = coordinator
            .send(download::DownloadCmd::FrontendReady(ready))
            .await;
    });
    Ok(())
}

#[tauri::command]
fn ack_extension_download(
    caller: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    if request_id.len() != 32 || !request_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid extension request id".to_string());
    }

    extension_server::acknowledge_extension_download(&state.extension_acks, &request_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        aggregate_media_byte_progress, aggregate_media_fraction, append_ytdlp_config_option,
        append_ytdlp_http_headers,
        build_media_format_options,
        collect_download_uris, drain_media_output_lines, filename_from_content_disposition,
        filename_from_url_disposition_query, filename_from_url_path, is_excluded_yt_dlp_format,
        is_browser_cookie_extraction_error, json_lower, media_metadata_cache_key,
        media_output_template, media_progress_args, media_progress_event_totals,
        media_progress_speed,
        cookie_scope_for_url, metadata_authentication_error, metadata_cookie_header_present,
        metadata_headers, metadata_response_error,
        is_remote_torrent_source,
        normalize_speed_limit_for_aria2,
        normalize_torrent_overall_upload_limit,
        apply_aria2_torrent_global_options,
        apply_aria2_torrent_network_options,
        apply_aria2_torrent_peer_identity_options,
        apply_aria2_torrent_peer_discovery_options,
        apply_aria2_torrent_dht_paths,
        apply_aria2_torrent_dht_options,
        aria2_rpc_port_is_occupied,
        parse_firelink_deep_link, parse_ffmpeg_version, parse_media_progress_line,
        collect_opened_torrent_paths,
        normalize_opened_torrent_argument,
        redact_log_line, redact_log_line_for_output, sanitize_ytdlp_config_value,
        has_resumable_download_assets, is_media_artifact_name,
        should_cleanup_media_artifacts_after_failure,
        should_retry_without_browser_cookies,
        retry_metadata_with_cookies, should_retry_metadata_with_cookies,
        should_send_metadata_credentials, collect_log_files, FirelinkDeepLink,
        percent_decode_metadata_value, MediaProgress,
        MediaProgressEmitterState, MediaSpeedSampler, MEDIA_PROGRESS_PREFIX,
        observe_aria2_connections, observe_aria2_connections_with_epoch,
        Aria2ConnectionObservation, Aria2ConnectionSample, Aria2RecoveryReason,
        aria2_active_connection_count,
        parse_media_playlist_metadata,
        normalize_media_connections,
        validate_enqueue_url, validate_enqueue_uris, validate_keychain_grant_request_id,
        retained_torrent_id_from_persisted_record,
        retained_torrent_info_hash_from_persisted_record,
        merge_durable_torrent_telemetry, torrent_identity_magnet, torrent_move_path_pair,
    };
    #[cfg(target_os = "macos")]
    use super::should_apply_dock_badge_update;
    use serde_json::json;
    use crate::queue;
    use std::time::{Duration, Instant};

    #[test]
    fn keychain_grant_request_ids_are_bounded_and_nonempty() {
        assert!(validate_keychain_grant_request_id("grant-123").is_ok());
        assert!(validate_keychain_grant_request_id("").is_err());
        assert!(validate_keychain_grant_request_id("   ").is_err());
        assert!(validate_keychain_grant_request_id(&"x".repeat(129)).is_err());
    }

    #[test]
    fn renderer_download_snapshots_cannot_lower_native_torrent_totals() {
        let existing = vec![
            json!({
                "id": "torrent-1",
                "torrentUploadedBytes": 900,
                "torrentSeededSeconds": 45
            })
            .to_string(),
        ];
        let merged = merge_durable_torrent_telemetry(
            &existing,
            &json!([
                { "id": "torrent-1", "torrentUploadedBytes": 12, "torrentSeededSeconds": 90 },
                { "id": "file-1" }
            ])
            .to_string(),
        )
        .unwrap();
        let records: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(records[0]["torrentUploadedBytes"], 900);
        assert_eq!(records[0]["torrentSeededSeconds"], 90);
    }

    #[test]
    fn renderer_download_snapshots_cannot_roll_back_a_native_relocation() {
        let existing = vec![
            json!({
                "id": "torrent-1",
                "destination": "/downloads/new",
                "torrentMoveDestination": "/downloads/new"
            })
            .to_string(),
        ];
        let merged = merge_durable_torrent_telemetry(
            &existing,
            &json!([{ "id": "torrent-1", "destination": "/downloads/old" }]).to_string(),
        )
        .unwrap();
        let records: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(records[0]["destination"], "/downloads/new");
        assert_eq!(records[0]["torrentMoveDestination"], "/downloads/new");

        let acknowledged = merge_durable_torrent_telemetry(
            &existing,
            &json!([{ "id": "torrent-1", "destination": "/downloads/new" }]).to_string(),
        )
        .unwrap();
        let acknowledged: serde_json::Value = serde_json::from_str(&acknowledged).unwrap();
        assert!(acknowledged[0].get("torrentMoveDestination").is_none());
    }

    #[test]
    fn renderer_download_snapshots_cannot_clear_native_relocation_or_verification_markers() {
        let existing = vec![
            json!({
                "id": "torrent-1",
                "status": "queued",
                "destination": "/downloads/new",
                "torrentMoveDestination": "/downloads/new",
                "torrentRelocationCheckPending": true,
                "torrentVerifyOnly": true,
                "torrentVerifyRestoreStatus": "paused",
                "torrentVerifyNative": "paused"
            })
            .to_string(),
        ];
        let merged = merge_durable_torrent_telemetry(
            &existing,
            &json!([{
                "id": "torrent-1",
                "status": "paused",
                "destination": "/downloads/old"
            }])
            .to_string(),
        )
        .unwrap();
        let records: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(records[0]["destination"], "/downloads/new");
        assert_eq!(records[0]["torrentRelocationCheckPending"], true);
        assert_eq!(records[0]["torrentVerifyOnly"], true);
        assert_eq!(records[0]["torrentVerifyRestoreStatus"], "paused");
        assert_eq!(records[0]["torrentVerifyNative"], "paused");

        let acknowledged = merge_durable_torrent_telemetry(
            &existing,
            &json!([{
                "id": "torrent-1",
                "status": "queued",
                "destination": "/downloads/new",
                "torrentVerifyOnly": true,
                "torrentVerifyRestoreStatus": "paused"
            }])
            .to_string(),
        )
        .unwrap();
        let acknowledged: serde_json::Value = serde_json::from_str(&acknowledged).unwrap();
        assert_eq!(acknowledged[0]["torrentRelocationCheckPending"], true);
        assert!(acknowledged[0].get("torrentMoveDestination").is_none());
        assert!(acknowledged[0].get("torrentVerifyNative").is_none());
        assert_eq!(acknowledged[0]["torrentVerifyOnly"], true);
    }

    #[test]
    fn renderer_download_snapshots_cannot_roll_back_native_web_seed_changes() {
        let native_seeds = json!([{ "fileIndex": 0, "uri": "https://mirror.example/file" }]);
        let existing = vec![
            json!({
                "id": "torrent-1",
                "torrentWebSeeds": native_seeds.clone(),
                "torrentWebSeedsNative": native_seeds.clone()
            })
            .to_string(),
        ];
        let merged = merge_durable_torrent_telemetry(
            &existing,
            &json!([{ "id": "torrent-1", "torrentWebSeeds": [] }]).to_string(),
        )
        .unwrap();
        let records: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(records[0]["torrentWebSeeds"][0]["uri"], "https://mirror.example/file");
        assert!(records[0].get("torrentWebSeedsNative").is_some());

        let acknowledged = merge_durable_torrent_telemetry(
            &existing,
            &json!([{ "id": "torrent-1", "torrentWebSeeds": native_seeds }]).to_string(),
        )
        .unwrap();
        let acknowledged: serde_json::Value = serde_json::from_str(&acknowledged).unwrap();
        assert!(acknowledged[0].get("torrentWebSeedsNative").is_none());
    }

    #[test]
    fn torrent_identity_magnet_is_bounded_and_credential_free() {
        let details = crate::ipc::TorrentDetails {
            info_hash: "0123456789abcdef0123456789abcdef01234567".to_string(),
            display_name: "folder/preview & name".to_string(),
            total_bytes: 1,
            file_count: 1,
            piece_length: 1,
            piece_count: 1,
            private: true,
            creation_date: None,
            creator: None,
            comment: None,
            trackers: vec!["https://tracker.example/passkey".to_string()],
            web_seeds: vec!["https://cdn.example/file".to_string()],
        };
        let magnet = torrent_identity_magnet(&details).unwrap();
        assert_eq!(
            magnet,
            "magnet:?xt=urn%3Abtih%3A0123456789abcdef0123456789abcdef01234567&dn=preview+%26+name"
        );
        assert!(!magnet.contains("tracker"));
        assert!(!magnet.contains("passkey"));
    }

    #[test]
    fn torrent_move_root_mapping_handles_single_file_output() {
        let root = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let old_root = root.path().join("old");
        let new_root = root.path().join("new");
        std::fs::create_dir_all(&old_root).unwrap();
        std::fs::create_dir_all(&new_root).unwrap();
        let mapped = torrent_move_path_pair(&old_root, &new_root, &old_root).unwrap();
        assert_eq!(mapped, new_root.canonicalize().unwrap());
        let child = old_root.join("file.bin");
        assert_eq!(
            torrent_move_path_pair(&old_root, &new_root, &child).unwrap(),
            new_root.join("file.bin")
        );
    }

    #[test]
    fn aria2_torrent_peer_discovery_options_are_explicit_and_launch_scoped() {
        let mut command = std::process::Command::new("aria2c");
        apply_aria2_torrent_peer_discovery_options(&mut command, false, true, false, true);
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            vec![
                "--enable-dht=false",
                "--enable-dht6=true",
                "--enable-peer-exchange=false",
                "--bt-enable-lpd=true",
            ]
        );
    }

    #[test]
    fn aria2_torrent_dht_paths_are_explicit_and_owned_by_firelink() {
        let root = tempfile::tempdir().unwrap();
        let dht_path = root.path().join("aria2/dht.dat");
        let dht6_path = root.path().join("aria2/dht6.dat");
        let mut command = std::process::Command::new("aria2c");

        apply_aria2_torrent_dht_paths(&mut command, &dht_path, &dht6_path);

        assert_eq!(
            command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec![
                format!("--dht-file-path={}", dht_path.display()),
                format!("--dht-file-path6={}", dht6_path.display()),
            ]
        );
    }

    #[test]
    fn aria2_torrent_dht_message_timeout_is_bounded_and_launch_scoped() {
        let mut command = std::process::Command::new("aria2c");
        apply_aria2_torrent_dht_options(&mut command, 42);
        assert_eq!(
            command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec!["--dht-message-timeout=42"]
        );

        let mut command = std::process::Command::new("aria2c");
        apply_aria2_torrent_dht_options(&mut command, 0);
        assert_eq!(
            command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec!["--dht-message-timeout=10"]
        );
    }

    #[test]
    fn aria2_torrent_global_options_are_bounded_and_explicit() {
        let mut command = std::process::Command::new("aria2c");
        apply_aria2_torrent_global_options(&mut command, 256, Some("2M"), "16M");
        assert_eq!(
            command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec![
                "--bt-max-open-files=256",
                "--disk-cache=16M",
                "--max-overall-upload-limit=2M",
            ]
        );
        let mut fallback_command = std::process::Command::new("aria2c");
        apply_aria2_torrent_global_options(
            &mut fallback_command,
            queue::MAX_TORRENT_MAX_OPEN_FILES + 1,
            Some("not-a-rate"),
            "not-a-cache",
        );
        assert_eq!(
            fallback_command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec!["--bt-max-open-files=100", "--disk-cache=16M"]
        );
        let mut unlimited_command = std::process::Command::new("aria2c");
        apply_aria2_torrent_global_options(&mut unlimited_command, 256, None, "0");
        assert_eq!(
            unlimited_command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec!["--bt-max-open-files=256", "--disk-cache=0"]
        );
    }

    #[test]
    fn torrent_overall_upload_limit_rejects_invalid_values_but_accepts_unlimited() {
        assert_eq!(
            normalize_torrent_overall_upload_limit(None).unwrap(),
            None
        );
        assert_eq!(
            normalize_torrent_overall_upload_limit(Some(" ")).unwrap(),
            None
        );
        assert_eq!(
            normalize_torrent_overall_upload_limit(Some("1.5 MB/s")).unwrap(),
            Some("1.5M".to_string())
        );
        assert!(normalize_torrent_overall_upload_limit(Some("not-a-rate")).is_err());
    }

    #[test]
    fn aria2_torrent_network_options_are_explicit_and_omit_defaults() {
        let mut command = std::process::Command::new("aria2c");
        apply_aria2_torrent_network_options(
            &mut command,
            "6881-6999",
            "6881",
            "203.0.113.7",
            "router.example:6881",
            "[2001:db8::1]:6881",
            "2001:db8::2",
            "en0",
            "192.0.2.10",
            true,
        );
        assert_eq!(
            command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec![
                "--listen-port=6881-6999",
                "--dht-listen-port=6881",
                "--bt-external-ip=203.0.113.7",
                "--dht-entry-point=router.example:6881",
                "--dht-entry-point6=[2001:db8::1]:6881",
                "--dht-listen-addr6=2001:db8::2",
                "--bt-lpd-interface=en0",
                "--interface=192.0.2.10",
            ]
        );

        let mut defaults = std::process::Command::new("aria2c");
        apply_aria2_torrent_network_options(&mut defaults, "", "", "", "", "", "", "", "", true);
        assert!(defaults.get_args().next().is_none());

        let mut ipv4_only = std::process::Command::new("aria2c");
        apply_aria2_torrent_network_options(&mut ipv4_only, "", "", "", "", "", "", "", "192.0.2.10", false);
        assert_eq!(
            ipv4_only
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec!["--interface=192.0.2.10", "--disable-ipv6=true"]
        );
    }

    #[test]
    fn aria2_torrent_peer_identity_options_are_explicit_and_omit_defaults() {
        let mut command = std::process::Command::new("aria2c");
        apply_aria2_torrent_peer_identity_options(
            &mut command,
            "-FL-1-3-1-",
            "Firelink/1.3.1",
        );
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            vec![
                "--peer-id-prefix=-FL-1-3-1-",
                "--peer-agent=Firelink/1.3.1",
            ]
        );

        let mut defaults = std::process::Command::new("aria2c");
        apply_aria2_torrent_peer_identity_options(&mut defaults, "", "");
        assert!(defaults.get_args().next().is_none());
    }

    #[test]
    fn aria2_rpc_port_occupancy_is_detected_without_claiming_free_ports() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(aria2_rpc_port_is_occupied(port));
        drop(listener);
        assert!(!aria2_rpc_port_is_occupied(port));
    }

    #[test]
    fn retained_torrent_metadata_survives_unrelated_persisted_field_corruption() {
        let record = json!({
            "id": "retained-torrent",
            "isTorrent": true,
            "torrentPath": "/tmp/retained-torrent.torrent",
            "torrentMaxPeers": "corrupted"
        })
        .to_string();

        assert_eq!(
            retained_torrent_id_from_persisted_record(&record).as_deref(),
            Some("retained-torrent")
        );
        assert!(retained_torrent_id_from_persisted_record("not-json").is_none());
        assert!(retained_torrent_id_from_persisted_record(
            &json!({ "id": "ordinary", "isTorrent": false }).to_string()
        )
        .is_none());
    }

    #[test]
    fn retained_torrent_info_hash_is_canonicalized_only_for_live_torrents() {
        let record = json!({
            "id": "retained-torrent",
            "isTorrent": true,
            "torrentPath": "/tmp/retained-torrent.torrent",
            "torrentInfoHash": "AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH"
        })
        .to_string();

        assert_eq!(
            retained_torrent_info_hash_from_persisted_record(&record).as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        assert!(retained_torrent_info_hash_from_persisted_record(
            &json!({
                "id": "not-live",
                "isTorrent": true,
                "torrentInfoHash": "0123456789abcdef0123456789abcdef01234567"
            })
            .to_string()
        )
        .is_none());
        assert!(retained_torrent_info_hash_from_persisted_record(
            &json!({
                "id": "invalid-hash",
                "isTorrent": true,
                "torrentPath": "/tmp/invalid-hash.torrent",
                "torrentInfoHash": "not-a-hash"
            })
            .to_string()
        )
        .is_none());
    }

    #[test]
    fn aria2_active_connection_count_uses_only_nonnegative_daemon_values() {
        assert_eq!(
            aria2_active_connection_count(&json!({"connections": "16"})),
            16
        );
        assert_eq!(
            aria2_active_connection_count(&json!({"connections": 16})),
            16
        );
        assert_eq!(
            aria2_active_connection_count(&json!({"connections": "-1"})),
            0
        );
        assert_eq!(
            aria2_active_connection_count(&json!({"connections": -1})),
            0
        );
        assert_eq!(aria2_active_connection_count(&json!({})), 0);
    }

    #[test]
    fn normalize_media_connections_uses_safe_user_selected_range() {
        assert_eq!(normalize_media_connections(Some(16)), 16);
        assert_eq!(normalize_media_connections(Some(7)), 7);
        assert_eq!(normalize_media_connections(None), 16);
        assert_eq!(normalize_media_connections(Some(0)), 1);
        assert_eq!(normalize_media_connections(Some(-4)), 1);
        assert_eq!(normalize_media_connections(Some(99)), 16);
    }

    #[tokio::test]
    async fn enqueue_url_validation_blocks_local_http_but_preserves_ftp() {
        assert_eq!(
            validate_enqueue_url("http://127.0.0.1/file.zip").await,
            Err("SSRF blocked: Private/local IP not allowed".to_string())
        );
        assert_eq!(
            validate_enqueue_url("ftp://127.0.0.1/file.zip").await,
            Err("SSRF blocked: Private/local IP not allowed".to_string())
        );
        assert_eq!(
            validate_enqueue_url("sftp://[::1]/file.zip").await,
            Err("SSRF blocked: Private/local IP not allowed".to_string())
        );
        assert_eq!(
            validate_enqueue_url("http://[::ffff:127.0.0.1]/file.zip").await,
            Err("SSRF blocked: Private/local IP not allowed".to_string())
        );
        assert_eq!(
            validate_enqueue_url("file:///tmp/file.zip").await,
            Err("Unsupported URL scheme".to_string())
        );
    }

    #[tokio::test]
    async fn remote_torrent_fetch_rejects_non_http_and_embedded_credentials() {
        assert_eq!(
            super::fetch_remote_torrent_bytes(
                "ftp://example.com/sample.torrent",
                None,
                None,
                None,
                None,
            )
            .await,
            Err("Remote torrent metadata must use HTTP or HTTPS".to_string())
        );
        assert_eq!(
            super::fetch_remote_torrent_bytes(
                "https://user:pass@example.com/sample.torrent",
                None,
                None,
                None,
                None,
            )
            .await,
            Err("Torrent metadata URLs must not contain credentials".to_string())
        );
        let proxy_error = super::fetch_remote_torrent_bytes(
            "https://example.com/sample.torrent",
            Some("socks5://127.0.0.1:1080"),
            None,
            None,
            None,
        )
        .await
        .expect_err("remote Torrent metadata must use the shared proxy policy");
        assert!(proxy_error.contains("SOCKS"));
    }

    #[tokio::test]
    async fn enqueue_uri_validation_covers_mirrors_not_only_the_primary_url() {
        assert_eq!(
            validate_enqueue_uris(
                "http://192.0.2.1/file.zip",
                Some("http://127.0.0.1/internal\nfile:///etc/passwd"),
            )
            .await,
            Err("SSRF blocked: Private/local IP not allowed".to_string())
        );
        assert_eq!(
            validate_enqueue_uris(
                "http://192.0.2.1/file.zip",
                Some("file:///etc/passwd"),
            )
            .await,
            Err("Unsupported URL scheme".to_string())
        );
    }

    #[test]
    fn slow_nonzero_aria2_throughput_recovers_after_a_sustained_degradation() {
        let start = Instant::now();
        let mut observation = Aria2ConnectionObservation::default();

        assert_eq!(
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                10 * 1024 * 1024,
                10.0 * 1024.0 * 1024.0,
                16,
                16,
                false,
                start,
            ),
            None
        );
        observe_aria2_connections(
            &mut observation,
            "gid-1",
            "active",
            100 * 1024 * 1024,
            11 * 1024 * 1024,
            10.0 * 1024.0 * 1024.0,
            16,
            16,
            false,
            start + Duration::from_secs(1),
        );
        observe_aria2_connections(
            &mut observation,
            "gid-1",
            "active",
            100 * 1024 * 1024,
            12 * 1024 * 1024,
            10.0 * 1024.0 * 1024.0,
            16,
            16,
            false,
            start + Duration::from_secs(2),
        );
        assert_eq!(
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                11 * 1024 * 1024,
                1024.0 * 1024.0,
                16,
                16,
                false,
                start + Duration::from_secs(31),
            ),
            None,
            "the first slow sample starts the degradation timer"
        );
        assert_eq!(
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                12 * 1024 * 1024,
                1024.0 * 1024.0,
                16,
                16,
                false,
                start + Duration::from_secs(62),
            ),
            Some(Aria2RecoveryReason::SlowThroughput)
        );
    }

    #[test]
    fn aria2_recovery_uses_a_cooldown_instead_of_a_one_shot_latch() {
        let start = Instant::now();
        let mut observation = Aria2ConnectionObservation::default();
        let sample = |observation: &mut Aria2ConnectionObservation, now: Instant| {
            observe_aria2_connections(
                observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                12 * 1024 * 1024,
                1024.0 * 1024.0,
                16,
                16,
                false,
                now,
            )
        };

        observe_aria2_connections(
            &mut observation,
            "gid-1",
            "active",
            100 * 1024 * 1024,
            12 * 1024 * 1024,
            10.0 * 1024.0 * 1024.0,
            16,
            16,
            false,
            start,
        );
        observe_aria2_connections(
            &mut observation,
            "gid-1",
            "active",
            100 * 1024 * 1024,
            13 * 1024 * 1024,
            10.0 * 1024.0 * 1024.0,
            16,
            16,
            false,
            start + Duration::from_secs(1),
        );
        observe_aria2_connections(
            &mut observation,
            "gid-1",
            "active",
            100 * 1024 * 1024,
            14 * 1024 * 1024,
            10.0 * 1024.0 * 1024.0,
            16,
            16,
            false,
            start + Duration::from_secs(2),
        );
        sample(&mut observation, start + Duration::from_secs(31));
        assert_eq!(
            sample(&mut observation, start + Duration::from_secs(62)),
            Some(Aria2RecoveryReason::SlowThroughput)
        );
        assert_eq!(sample(&mut observation, start + Duration::from_secs(93)), None);
        assert_eq!(
            sample(&mut observation, start + Duration::from_secs(108)),
            Some(Aria2RecoveryReason::SlowThroughput),
            "a later degradation can recover again after the cooldown"
        );
    }

    #[test]
    fn aria2_recovery_observation_resets_after_a_control_epoch_change() {
        let start = Instant::now();
        let mut observation = Aria2ConnectionObservation::default();

        for (offset, completed, speed) in [
            (0, 10 * 1024 * 1024, 10.0 * 1024.0 * 1024.0),
            (1, 11 * 1024 * 1024, 10.0 * 1024.0 * 1024.0),
            (2, 12 * 1024 * 1024, 10.0 * 1024.0 * 1024.0),
        ] {
            observe_aria2_connections_with_epoch(
                &mut observation,
                Aria2ConnectionSample {
                    gid: "gid-epoch",
                    control_epoch: 1,
                    status: "active",
                    total: 100 * 1024 * 1024,
                    completed,
                    speed_bytes: speed,
                    active_connections: 16,
                    requested_connections: 16,
                    speed_limited: false,
                    now: start + Duration::from_secs(offset),
                },
            );
        }
        observe_aria2_connections_with_epoch(
            &mut observation,
            Aria2ConnectionSample {
                gid: "gid-epoch",
                control_epoch: 1,
                status: "active",
                total: 100 * 1024 * 1024,
                completed: 13 * 1024 * 1024,
                speed_bytes: 1024.0 * 1024.0,
                active_connections: 16,
                requested_connections: 16,
                speed_limited: false,
                now: start + Duration::from_secs(31),
            },
        );
        assert!(observation.saw_multiple_connections);

        assert_eq!(
            observe_aria2_connections_with_epoch(
                &mut observation,
                Aria2ConnectionSample {
                    gid: "gid-epoch",
                    control_epoch: 2,
                    status: "active",
                    total: 100 * 1024 * 1024,
                    completed: 13 * 1024 * 1024,
                    speed_bytes: 1024.0 * 1024.0,
                    active_connections: 1,
                    requested_connections: 16,
                    speed_limited: false,
                    now: start + Duration::from_secs(62),
                },
            ),
            None
        );
        assert_eq!(observation.control_epoch, 2);
        assert!(!observation.saw_multiple_connections);
        assert_eq!(observation.healthy_speed_samples, 0);
    }

    #[test]
    fn aria2_recovery_budget_survives_same_epoch_gid_replacement() {
        let mut observation = Aria2ConnectionObservation {
            gid: "gid-old".to_string(),
            control_epoch: 7,
            recovery_attempts: 2,
            ..Default::default()
        };
        let now = Instant::now();

        assert_eq!(
            observe_aria2_connections_with_epoch(
                &mut observation,
                Aria2ConnectionSample {
                    gid: "gid-new",
                    control_epoch: 7,
                    status: "active",
                    total: 100,
                    completed: 10,
                    speed_bytes: 1024.0,
                    active_connections: 16,
                    requested_connections: 16,
                    speed_limited: false,
                    now,
                },
            ),
            None
        );
        assert_eq!(
            observation.recovery_attempts, 2,
            "a fresh gid in the same lifecycle must not reset the bounded recovery budget"
        );

        observe_aria2_connections_with_epoch(
            &mut observation,
            Aria2ConnectionSample {
                gid: "gid-new-lifecycle",
                control_epoch: 8,
                status: "active",
                total: 100,
                completed: 10,
                speed_bytes: 1024.0,
                active_connections: 16,
                requested_connections: 16,
                speed_limited: false,
                now: now + Duration::from_secs(1),
            },
        );
        assert_eq!(
            observation.recovery_attempts, 0,
            "a genuinely new lifecycle may start with a fresh recovery budget"
        );
    }

    #[test]
    fn slow_recovery_requires_a_real_multi_connection_transfer() {
        let start = Instant::now();
        let mut observation = Aria2ConnectionObservation::default();

        for (offset, speed) in [(0, 10.0 * 1024.0 * 1024.0), (31, 1024.0 * 1024.0), (62, 1024.0 * 1024.0)] {
            assert_eq!(
                observe_aria2_connections(
                    &mut observation,
                    "gid-1",
                    "active",
                    100 * 1024 * 1024,
                    10 * 1024 * 1024 + offset * 1024,
                    speed,
                    1,
                    16,
                    false,
                    start + Duration::from_secs(offset),
                ),
                None
            );
        }
    }

    #[test]
    fn slow_recovery_ignores_intentional_speed_limits() {
        let start = Instant::now();
        let mut observation = Aria2ConnectionObservation::default();
        for offset in 0..3 {
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                (10 + offset) * 1024 * 1024,
                10.0 * 1024.0 * 1024.0,
                16,
                16,
                true,
                start + Duration::from_secs(offset),
            );
        }

        assert_eq!(
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                14 * 1024 * 1024,
                1024.0 * 1024.0,
                16,
                16,
                true,
                start + Duration::from_secs(31),
            ),
            None
        );
        assert_eq!(
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                15 * 1024 * 1024,
                1024.0 * 1024.0,
                16,
                16,
                true,
                start + Duration::from_secs(62),
            ),
            None
        );
    }

    #[test]
    fn partial_connection_pool_collapse_recovers_after_degraded_throughput() {
        let start = Instant::now();
        let mut observation = Aria2ConnectionObservation::default();

        for offset in 0..3 {
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                (10 + offset) * 1024 * 1024,
                10.0 * 1024.0 * 1024.0,
                16,
                16,
                false,
                start + Duration::from_secs(offset),
            );
        }

        assert_eq!(
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                13 * 1024 * 1024,
                2.4 * 1024.0 * 1024.0,
                12,
                16,
                false,
                start + Duration::from_secs(31),
            ),
            None,
            "the first partial collapse sample starts the degradation timer"
        );
        assert_eq!(
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                14 * 1024 * 1024,
                2.4 * 1024.0 * 1024.0,
                12,
                16,
                false,
                start + Duration::from_secs(62),
            ),
            Some(Aria2RecoveryReason::ConnectionPoolCollapse)
        );
    }

    #[test]
    fn partial_connection_pool_collapse_stays_quiet_while_speed_limited() {
        let start = Instant::now();
        let mut observation = Aria2ConnectionObservation::default();

        for offset in 0..3 {
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                (10 + offset) * 1024 * 1024,
                1024.0 * 1024.0,
                16,
                16,
                true,
                start + Duration::from_secs(offset),
            );
        }

        assert_eq!(
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                13 * 1024 * 1024,
                1024.0 * 1024.0,
                12,
                16,
                true,
                start + Duration::from_secs(31),
            ),
            None
        );
    }

    #[test]
    fn partial_connection_pool_recovery_is_bounded_until_a_healthy_window() {
        let start = Instant::now();
        let mut observation = Aria2ConnectionObservation::default();

        for offset in 0..3 {
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                (10 + offset) * 1024 * 1024,
                10.0 * 1024.0 * 1024.0,
                16,
                16,
                false,
                start + Duration::from_secs(offset),
            );
        }

        let partial_sample = |observation: &mut Aria2ConnectionObservation, now: u64| {
            observe_aria2_connections(
                observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                13 * 1024 * 1024 + now * 1024,
                2.4 * 1024.0 * 1024.0,
                12,
                16,
                false,
                start + Duration::from_secs(now),
            )
        };

        assert_eq!(partial_sample(&mut observation, 31), None);
        assert_eq!(
            partial_sample(&mut observation, 62),
            Some(Aria2RecoveryReason::ConnectionPoolCollapse)
        );
        assert_eq!(
            partial_sample(&mut observation, 108),
            Some(Aria2RecoveryReason::ConnectionPoolCollapse)
        );
        assert_eq!(
            partial_sample(&mut observation, 154),
            Some(Aria2RecoveryReason::ConnectionPoolCollapse)
        );
        assert_eq!(partial_sample(&mut observation, 200), None);
        assert_eq!(
            partial_sample(&mut observation, 246),
            None,
            "the fourth failed recovery must be suppressed"
        );
        assert_eq!(
            partial_sample(&mut observation, 292),
            None
        );

        for offset in 1..=3 {
            assert_eq!(
                observe_aria2_connections(
                    &mut observation,
                    "gid-1",
                    "active",
                    100 * 1024 * 1024,
                    (20 + offset) * 1024 * 1024,
                    10.0 * 1024.0 * 1024.0,
                    16,
                    16,
                    false,
                    start + Duration::from_secs(292 + offset),
                ),
                None
            );
        }

        assert_eq!(
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                24 * 1024 * 1024,
                2.4 * 1024.0 * 1024.0,
                12,
                16,
                false,
                start + Duration::from_secs(338),
            ),
            None,
            "a healthy window resets the recovery budget before the next degraded sample"
        );
        assert_eq!(
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                25 * 1024 * 1024,
                2.4 * 1024.0 * 1024.0,
                12,
                16,
                false,
                start + Duration::from_secs(369),
            ),
            Some(Aria2RecoveryReason::ConnectionPoolCollapse)
        );
    }

    #[test]
    fn partial_connection_pool_zero_progress_uses_zero_progress_recovery() {
        let start = Instant::now();
        let mut observation = Aria2ConnectionObservation::default();

        for offset in 0..3 {
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                (10 + offset) * 1024 * 1024,
                10.0 * 1024.0 * 1024.0,
                16,
                16,
                false,
                start + Duration::from_secs(offset),
            );
        }

        assert_eq!(
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                12 * 1024 * 1024,
                0.0,
                12,
                16,
                false,
                start + Duration::from_secs(31),
            ),
            None
        );
        assert_eq!(
            observe_aria2_connections(
                &mut observation,
                "gid-1",
                "active",
                100 * 1024 * 1024,
                12 * 1024 * 1024,
                0.0,
                12,
                16,
                false,
                start + Duration::from_secs(62),
            ),
            Some(Aria2RecoveryReason::ZeroProgress)
        );
    }

    #[test]
    fn one_connection_recovery_requires_a_healthy_multi_connection_baseline() {
        let start = Instant::now();
        let mut observation = Aria2ConnectionObservation::default();

        observe_aria2_connections(
            &mut observation,
            "gid-1",
            "active",
            100 * 1024 * 1024,
            10 * 1024 * 1024,
            10.0 * 1024.0 * 1024.0,
            16,
            16,
            false,
            start,
        );

        for (offset, completed) in [(31, 11), (62, 12)] {
            assert_eq!(
                observe_aria2_connections(
                    &mut observation,
                    "gid-1",
                    "active",
                    100 * 1024 * 1024,
                    completed * 1024 * 1024,
                    128.0 * 1024.0,
                    1,
                    16,
                    false,
                    start + Duration::from_secs(offset),
                ),
                None,
                "one transient multi-connection sample must not arm pool recovery"
            );
        }
    }

    #[test]
    fn one_startup_spike_does_not_arm_slow_recovery() {
        let start = Instant::now();
        let mut observation = Aria2ConnectionObservation::default();
        observe_aria2_connections(
            &mut observation,
            "gid-1",
            "active",
            100 * 1024 * 1024,
            10 * 1024 * 1024,
            10.0 * 1024.0 * 1024.0,
            16,
            16,
            false,
            start,
        );

        for offset in [31_u64, 62, 93] {
            assert_eq!(
                observe_aria2_connections(
                    &mut observation,
                    "gid-1",
                    "active",
                    100 * 1024 * 1024,
                    10 * 1024 * 1024 + offset * 1024,
                    1024.0 * 1024.0,
                    16,
                    16,
                    false,
                    start + Duration::from_secs(offset),
                ),
                None
            );
        }
    }

    #[test]
    fn media_metadata_fallback_lets_ytdlp_choose_extension() {
        let destination = std::path::Path::new("/tmp/firelink");
        let template = media_output_template(destination, "1234567890", None);
        assert_eq!(
            template,
            destination.join("%(title).200B [%(id)s].%(ext)s")
        );
    }

    #[test]
    fn selected_media_format_keeps_requested_output_path() {
        let destination = std::path::Path::new("/tmp/firelink");
        let template = media_output_template(destination, "clip.mp4", Some("best"));
        assert_eq!(template, destination.join("clip.mp4"));
    }

    #[test]
    fn parses_playlist_entries_and_skips_duplicates_or_unusable_entries() {
        let metadata = parse_media_playlist_metadata(
            &json!({
                "id": "playlist-1",
                "title": "Example playlist",
                "playlist_count": 5,
                "entries": [
                    {"id": "one", "title": "One", "url": "https://www.youtube.com/watch?v=one"},
                    {"id": "one", "title": "Duplicate", "url": "https://www.youtube.com/watch?v=one"},
                    {"id": "missing", "title": "Missing"},
                    {"id": "two", "title": "Two", "url": "https://www.youtube.com/watch?v=wrong", "webpage_url": "https://www.youtube.com/watch?v=two"}
                ]
            }),
            10,
        )
        .unwrap();

        assert_eq!(metadata.playlist_id.as_deref(), Some("playlist-1"));
        assert_eq!(metadata.title, "Example playlist");
        assert_eq!(metadata.entries.len(), 2);
        assert_eq!(metadata.entries[0].url, "https://www.youtube.com/watch?v=one");
        assert_eq!(metadata.entries[1].url, "https://www.youtube.com/watch?v=two");
        assert_eq!(metadata.skipped_entries, 3);
        assert!(!metadata.truncated);
    }

    #[test]
    fn bounds_playlist_discovery_without_silently_claiming_all_entries_loaded() {
        let metadata = parse_media_playlist_metadata(
            &json!({
                "id": "large-playlist",
                "title": "Large playlist",
                "playlist_count": 4,
                "entries": [
                    {"id": "one", "url": "https://www.youtube.com/watch?v=one"},
                    {"id": "two", "url": "https://www.youtube.com/watch?v=two"},
                    {"id": "three", "url": "https://www.youtube.com/watch?v=three"},
                    {"id": "four", "url": "https://www.youtube.com/watch?v=four"}
                ]
            }),
            2,
        )
        .unwrap();

        assert_eq!(metadata.entries.len(), 2);
        assert_eq!(metadata.entry_count, Some(4));
        assert_eq!(metadata.skipped_entries, 2);
        assert!(metadata.truncated);
    }

    #[test]
    fn rejects_playlists_without_usable_entries() {
        let error = parse_media_playlist_metadata(
            &json!({"title": "Empty", "entries": [{"id": "missing"}]}),
            100,
        )
        .expect_err("a playlist without downloadable URLs must fail clearly");

        assert!(error.contains("no usable entries"));
    }

    #[test]
    fn metadata_rejects_final_http_errors_but_accepts_partial_content() {
        assert!(metadata_response_error(reqwest::StatusCode::PARTIAL_CONTENT).is_none());
        assert_eq!(
            metadata_response_error(reqwest::StatusCode::NOT_FOUND).as_deref(),
            Some("Metadata request failed with HTTP 404 (Not Found)")
        );
    }

    #[test]
    fn metadata_redirect_credentials_require_the_exact_origin() {
        let original = reqwest::Url::parse("https://example.com/file").unwrap();
        let same_origin = reqwest::Url::parse("https://example.com/other").unwrap();
        let subdomain = reqwest::Url::parse("https://cdn.example.com/file").unwrap();
        let different_port = reqwest::Url::parse("https://example.com:8443/file").unwrap();
        let downgraded = reqwest::Url::parse("http://example.com/file").unwrap();

        assert!(should_send_metadata_credentials(
            Some(&original),
            Some(&original),
            0
        ));
        assert!(should_send_metadata_credentials(
            Some(&original),
            Some(&same_origin),
            1
        ));
        assert!(!should_send_metadata_credentials(
            Some(&original),
            Some(&subdomain),
            1
        ));
        assert!(!should_send_metadata_credentials(
            Some(&original),
            Some(&different_port),
            1
        ));
        assert!(!should_send_metadata_credentials(
            Some(&original),
            Some(&downgraded),
            1
        ));
    }

    #[cfg(unix)]
    #[test]
    fn log_collection_rejects_symlink_files_and_directories() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let log_dir = root.path().join("logs");
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(log_dir.join("firelink.log"), "safe").unwrap();
        std::fs::write(outside.path().join("secret.log"), "redacted-fixture").unwrap();
        symlink(
            outside.path().join("secret.log"),
            log_dir.join("attacker.log"),
        )
        .unwrap();

        let files = collect_log_files(&log_dir).unwrap();
        assert_eq!(files, vec![std::fs::canonicalize(log_dir.join("firelink.log")).unwrap()]);

        let redirected_logs = root.path().join("redirected-logs");
        symlink(outside.path(), &redirected_logs).unwrap();
        assert!(collect_log_files(&redirected_logs).unwrap().is_empty());
    }

    #[test]
    fn metadata_defers_captured_cookies_until_the_origin_challenges() {
        let headers = "Cookie: oversized=secret\nReferer: https://example.com/page";
        assert!(metadata_cookie_header_present(
            Some(headers),
            Some("session=secret"),
            None
        ));

        let initial_headers = metadata_headers(Some(headers), Some("session=secret"), false);
        assert!(initial_headers.get(reqwest::header::COOKIE).is_none());
        assert_eq!(
            initial_headers
                .get(reqwest::header::REFERER)
                .and_then(|value| value.to_str().ok()),
            Some("https://example.com/page")
        );

        let authenticated_headers = metadata_headers(Some(headers), Some("session=secret"), true);
        assert_eq!(
            authenticated_headers
                .get(reqwest::header::COOKIE)
                .and_then(|value| value.to_str().ok()),
            Some("session=secret")
        );
    }

    #[test]
    fn metadata_cookie_scopes_select_only_the_matching_origin() {
        let scopes = vec![
            crate::extension_server::ExtensionCookieScope {
                url: "https://mail.google.com/".to_string(),
                cookies: "mail=session".to_string(),
            },
            crate::extension_server::ExtensionCookieScope {
                url: "https://accounts.google.com/".to_string(),
                cookies: "account=session".to_string(),
            },
            crate::extension_server::ExtensionCookieScope {
                url: "https://googleusercontent.com/".to_string(),
                cookies: "googleusercontent=session".to_string(),
            },
        ];

        assert_eq!(
            cookie_scope_for_url("https://mail.google.com/mail/u/0/", Some(&scopes)),
            Some("mail=session")
        );
        assert_eq!(
            cookie_scope_for_url("https://accounts.google.com/v3/signin/identifier", Some(&scopes)),
            Some("account=session")
        );
        assert_eq!(
            cookie_scope_for_url("https://mail-attachment.googleusercontent.com/file", Some(&scopes)),
            Some("googleusercontent=session")
        );
        assert_eq!(
            cookie_scope_for_url("https://attacker.example/redirect", Some(&scopes)),
            None
        );
        assert!(!metadata_cookie_header_present(None, None, Some(&scopes[..0])));
        assert!(metadata_cookie_header_present(None, None, Some(&scopes)));
    }

    #[test]
    fn metadata_cookie_retry_is_limited_to_one_auth_challenge() {
        let mut send_cookies = false;
        let mut cookie_retry_attempted = false;
        let mut current_url = "https://cdn.example/file".to_string();
        let mut redirects = 3;

        assert!(should_retry_metadata_with_cookies(
            reqwest::StatusCode::FORBIDDEN,
            true,
            false
        ));
        assert!(should_retry_metadata_with_cookies(
            reqwest::StatusCode::UNAUTHORIZED,
            true,
            false
        ));
        assert!(!should_retry_metadata_with_cookies(
            reqwest::StatusCode::OK,
            true,
            false
        ));
        assert!(!should_retry_metadata_with_cookies(
            reqwest::StatusCode::FORBIDDEN,
            true,
            true
        ));
        assert!(retry_metadata_with_cookies(
            reqwest::StatusCode::FORBIDDEN,
            true,
            &mut send_cookies,
            &mut cookie_retry_attempted,
            "https://origin.example/file",
            &mut current_url,
            &mut redirects,
        ));
        assert!(send_cookies);
        assert!(cookie_retry_attempted);
        assert_eq!(current_url, "https://origin.example/file");
        assert_eq!(redirects, 0);
        assert!(!retry_metadata_with_cookies(
            reqwest::StatusCode::FORBIDDEN,
            true,
            &mut send_cookies,
            &mut cookie_retry_attempted,
            "https://origin.example/file",
            &mut current_url,
            &mut redirects,
        ));
    }

    #[test]
    fn explicit_torrent_intent_allows_opaque_http_sources() {
        assert!(is_remote_torrent_source(
            "https://example.com/download?id=opaque",
            true
        ));
        assert!(!is_remote_torrent_source(
            "https://example.com/download?id=opaque",
            false
        ));
        assert!(!is_remote_torrent_source(
            "ftp://example.com/download?id=opaque",
            true
        ));
        assert!(is_remote_torrent_source(
            "https://example.com/files/sample.torrent?download=1",
            false
        ));
    }

    #[test]
    fn recognizes_resume_sidecars_without_treating_the_primary_file_as_partial() {
        let directory = tempfile::tempdir().unwrap();
        let primary = directory.path().join("download.bin");
        std::fs::write(&primary, b"partial").unwrap();

        assert!(!has_resumable_download_assets(&primary));

        std::fs::write(directory.path().join("download.bin.aria2"), b"control").unwrap();
        assert!(has_resumable_download_assets(&primary));
    }

    #[test]
    fn ytdlp_progress_args_force_progress_in_quiet_print_mode() {
        let args = media_progress_args();

        assert!(args.iter().any(|arg| arg == "--progress"));
        assert!(args.windows(2).any(|pair| {
            pair[0] == "--progress-template"
                && pair[1] == format!("download:{MEDIA_PROGRESS_PREFIX}%(progress)j")
        }));
    }

    #[test]
    fn ytdlp_config_values_cannot_inject_extra_lines() {
        assert_eq!(
            sanitize_ytdlp_config_value("user\n--exec\rmalicious"),
            "user--execmalicious"
        );
    }

    #[test]
    fn ytdlp_media_headers_include_captured_cookies_once() {
        let mut config = String::new();
        append_ytdlp_http_headers(
            &mut config,
            Some("Referer: https://example.com/video"),
            Some("session=abc; preference=high\r\n--proxy=http://bad.invalid"),
        )
        .unwrap();

        assert_eq!(
            config,
            "--add-header 'Referer: https://example.com/video'\n--add-header 'Cookie: session=abc; preference=high--proxy=http://bad.invalid'\n"
        );
    }

    #[test]
    fn ytdlp_config_options_quote_embedded_single_quotes() {
        let mut config = String::new();
        append_ytdlp_config_option(&mut config, "--username", "sam's account");

        assert_eq!(config, "--username 'sam'\\''s account'\n");
    }

    #[test]
    fn ytdlp_media_headers_reject_invalid_lines() {
        let mut config = String::new();
        let error = append_ytdlp_http_headers(&mut config, Some("not a header"), None)
            .expect_err("invalid header line should be rejected");

        assert!(error.contains("invalid HTTP header"));
    }

    #[test]
    fn media_metadata_cache_key_includes_request_headers_and_cookies() {
        let base = media_metadata_cache_key(
            "https://example.com/watch?v=1",
            &Some("firefox".to_string()),
            &Some("Custom UA A".to_string()),
            &None,
            &None,
            &Some("User-Agent: Browser A".to_string()),
            &Some("session=one".to_string()),
            &None,
        );
        let changed_headers = media_metadata_cache_key(
            "https://example.com/watch?v=1",
            &Some("firefox".to_string()),
            &Some("Custom UA A".to_string()),
            &None,
            &None,
            &Some("User-Agent: Browser B".to_string()),
            &Some("session=one".to_string()),
            &None,
        );
        let changed_cookies = media_metadata_cache_key(
            "https://example.com/watch?v=1",
            &Some("firefox".to_string()),
            &Some("Custom UA A".to_string()),
            &None,
            &None,
            &Some("User-Agent: Browser A".to_string()),
            &Some("session=two".to_string()),
            &None,
        );
        let changed_user_agent = media_metadata_cache_key(
            "https://example.com/watch?v=1",
            &Some("firefox".to_string()),
            &Some("Custom UA B".to_string()),
            &None,
            &None,
            &Some("User-Agent: Browser A".to_string()),
            &Some("session=one".to_string()),
            &None,
        );
        let without_browser = media_metadata_cache_key(
            "https://example.com/watch?v=1",
            &None,
            &Some("Custom UA A".to_string()),
            &None,
            &None,
            &Some("User-Agent: Browser A".to_string()),
            &Some("session=one".to_string()),
            &None,
        );

        assert_ne!(base, changed_headers);
        assert_ne!(base, changed_cookies);
        assert_ne!(base, changed_user_agent);
        assert_ne!(base, without_browser);
    }

    #[test]
    fn retryable_media_failures_preserve_resumable_artifacts() {
        assert!(!should_cleanup_media_artifacts_after_failure(
            "The response status is not successful. status=503",
            0,
            1
        ));
        assert!(should_cleanup_media_artifacts_after_failure(
            "The response status is not successful. status=503",
            1,
            1
        ));
        assert!(should_cleanup_media_artifacts_after_failure(
            "HTTP 404 Not Found",
            0,
            3
        ));
    }

    #[test]
    fn media_cleanup_requires_exact_artifact_boundaries() {
        assert!(is_media_artifact_name("video.mp4.part", "video.mp4", "video"));
        assert!(is_media_artifact_name("video.mp4.tmp", "video.mp4", "video"));
        assert!(is_media_artifact_name("video.f137.mp4", "video.mp4", "video"));
        assert!(is_media_artifact_name("video.f137.mp4.part", "video.mp4", "video"));
        assert!(is_media_artifact_name("video.vtt.part", "video.mp4", "video"));
        assert!(is_media_artifact_name("video.jpg.tmp", "video.mp4", "video"));
        assert!(!is_media_artifact_name("video.part1.rar", "video.mp4", "video"));
        assert!(!is_media_artifact_name("video.mp4.part1.rar", "video.mp4", "video"));
        assert!(!is_media_artifact_name("videography.mp4.part", "video.mp4", "video"));
        assert!(!is_media_artifact_name("video.f1-backup.tar.gz", "video.mp4", "video"));
        assert!(!is_media_artifact_name("video.f1.backup", "video.mp4", "video"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dock_badge_updates_reject_stale_sessions_and_generations() {
        assert!(should_apply_dock_badge_update(1, 99, 2, 1));
        assert!(should_apply_dock_badge_update(2, 1, 2, 2));
        assert!(!should_apply_dock_badge_update(2, 2, 2, 1));
        assert!(!should_apply_dock_badge_update(2, 2, 1, 99));
    }

    #[test]
    fn metadata_filename_prefers_content_disposition_filename() {
        assert_eq!(
            filename_from_content_disposition(
                "attachment; filename*=UTF-8''OnionHop-3.5-macOS-arm64.dmg; filename=ignored.bin"
            ),
            Some("OnionHop-3.5-macOS-arm64.dmg".to_string())
        );
        assert_eq!(
            filename_from_content_disposition("attachment; filename=OnionHop-3.5-macOS-arm64.dmg"),
            Some("OnionHop-3.5-macOS-arm64.dmg".to_string())
        );
    }

    #[test]
    fn metadata_filename_reads_redirect_disposition_query_before_opaque_path() {
        let redirected = "https://release-assets.githubusercontent.com/github-production-release-asset/1117828249/7aae36e6-00ec-4e7d-8dec-f14ace170bdb?rscd=attachment%3B+filename%3DOnionHop-3.5-macOS-arm64.dmg";

        assert_eq!(
            filename_from_url_disposition_query(redirected),
            Some("OnionHop-3.5-macOS-arm64.dmg".to_string())
        );
        assert_eq!(
            filename_from_url_path(redirected),
            Some("7aae36e6-00ec-4e7d-8dec-f14ace170bdb".to_string())
        );
    }

    #[test]
    fn metadata_filename_decodes_url_path_segments_before_sanitizing() {
        assert_eq!(
            filename_from_url_path("https://example.com/files/Rick%20and%20Morty%20-%20S09E08.mkv"),
            Some("Rick and Morty - S09E08.mkv".to_string())
        );
        assert_eq!(
            filename_from_url_path("https://example.com/files/%E2%98%83%20episode.mkv"),
            Some("☃ episode.mkv".to_string())
        );
    }

    #[test]
    fn metadata_filename_preserves_invalid_utf8_and_rejects_decoded_dot_segments() {
        assert_eq!(
            percent_decode_metadata_value("literal%☃"),
            Some("literal%☃".to_string())
        );
        assert_eq!(
            filename_from_url_path("https://example.com/files/file%FF.mkv"),
            Some("file%FF.mkv".to_string())
        );
        assert_eq!(
            filename_from_url_path("https://example.com/files/file%ZZ.mkv"),
            Some("file%ZZ.mkv".to_string())
        );
        assert_eq!(
            filename_from_url_path("https://example.com/files/%2e%2e"),
            None
        );
        assert_eq!(
            filename_from_url_path("https://example.com/files/a%2Fb.mkv"),
            Some("b.mkv".to_string())
        );
        assert_eq!(
            filename_from_url_path("https://accounts.google.com/v3/signin/identifier"),
            None
        );
        assert_eq!(
            filename_from_url_path("https://mail.google.com/mail/u/0/"),
            None
        );
        assert_eq!(
            filename_from_url_path("https://example.com/files/123"),
            Some("123".to_string())
        );
    }

    #[test]
    fn metadata_rejects_google_sign_in_interstitials() {
        let message = metadata_authentication_error(
            "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com%2F",
            Some("text/html; charset=UTF-8"),
        )
        .expect("Google sign-in HTML must not become a download");
        assert!(message.contains("Google sign-in page"));
        assert!(metadata_authentication_error(
            "https://accounts.google.com/drive/download/report.zip",
            Some("application/zip"),
        )
        .is_none());
        assert!(metadata_authentication_error(
            "https://downloads.example.com/signin/identifier",
            Some("text/html"),
        )
        .is_none());
    }

    #[test]
    fn normalizes_bare_global_speed_limits_as_kib_per_second() {
        assert_eq!(
            normalize_speed_limit_for_aria2("1024"),
            Some("1024K".to_string())
        );
        assert_eq!(
            normalize_speed_limit_for_aria2("512K"),
            Some("512K".to_string())
        );
        assert_eq!(
            normalize_speed_limit_for_aria2("1.5 MB/s"),
            Some("1.5M".to_string())
        );
        assert_eq!(normalize_speed_limit_for_aria2("0"), None);
        assert_eq!(normalize_speed_limit_for_aria2("bad"), None);
    }

    #[test]
    fn redacts_secrets_and_signed_url_queries_from_support_logs() {
        let line =
            "Authorization: bearer-secret Cookie=session=abc https://example.com/file?token=secret";
        let redacted = redact_log_line(line);
        assert!(!redacted.contains("bearer-secret"));
        assert!(!redacted.contains("session=abc"));
        assert!(!redacted.contains("token=secret"));
        assert!(redacted.contains("[redacted]"));
    }

    #[test]
    fn redacts_spaced_credentials_and_non_http_url_queries() {
        let line =
            "token: Bearer spaced secret; ftp://example.com/file?credential=spaced-secret";
        let redacted = redact_log_line(line);
        assert!(!redacted.contains("Bearer spaced secret"));
        assert!(!redacted.contains("credential=spaced-secret"));
        assert!(redacted.contains("token=[redacted]"));
        assert!(redacted.contains("ftp://example.com/file?[redacted]"));
    }

    #[test]
    fn redacts_live_log_output_before_webview_delivery() {
        let line = "Cookie: session=abc https://example.com/file?signature=secret";
        let redacted = redact_log_line_for_output(line);
        assert!(!redacted.contains("session=abc"));
        assert!(!redacted.contains("signature=secret"));
        assert!(redacted.contains("[redacted]"));
    }

    #[test]
    fn redacts_proxy_credentials_pairing_tokens_and_url_fragments() {
        let line = "Proxy-Authorization: Basic abc\npairing token: pair-secret\nhttp://user:pass@example.com/file#signature=secret";
        let redacted = redact_log_line(line);
        assert!(!redacted.contains("Basic abc"));
        assert!(!redacted.contains("pair-secret"));
        assert!(!redacted.contains("user:pass"));
        assert!(!redacted.contains("signature=secret"));
        assert!(redacted.contains("http://[redacted]@example.com/file#[redacted]"));
    }

    #[test]
    fn redacts_quoted_json_credentials() {
        let line = r#"{"api_key":"json-secret","cookie":"session=secret"}"#;
        let redacted = redact_log_line(line);
        assert!(!redacted.contains("json-secret"));
        assert!(!redacted.contains("session=secret"));
        assert!(redacted.contains("[redacted]"));
    }

    #[test]
    fn collects_primary_url_and_unique_mirrors_in_order() {
        let uris = collect_download_uris(
            "https://primary.example/file.zip",
            Some(
                "\nhttps://mirror-one.example/file.zip\n\
                 https://primary.example/file.zip\n\
                 https://mirror-two.example/file.zip\n",
            ),
        );

        assert_eq!(
            uris,
            vec![
                "https://primary.example/file.zip",
                "https://mirror-one.example/file.zip",
                "https://mirror-two.example/file.zip",
            ]
        );
    }

    #[test]
    fn parses_valid_firelink_download_urls() {
        let deep_link = url::Url::parse(
            "firelink://add?url=https%3A%2F%2Fexample.com%2Fone.zip%0Aftp%3A%2F%2Fexample.com%2Ftwo.zip",
        )
        .unwrap();

        assert_eq!(
            parse_firelink_deep_link(&deep_link),
            FirelinkDeepLink::Add(vec![
                "https://example.com/one.zip".to_string(),
                "ftp://example.com/two.zip".to_string(),
            ])
        );
    }

    #[test]
    fn accepts_exact_launch_without_downloads() {
        let deep_link = url::Url::parse("firelink://launch").unwrap();
        assert_eq!(
            parse_firelink_deep_link(&deep_link),
            FirelinkDeepLink::Launch
        );
    }

    #[test]
    fn accepts_direct_magnet_deep_links() {
        let deep_link = url::Url::parse(
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Example",
        )
        .unwrap();
        assert_eq!(
            parse_firelink_deep_link(&deep_link),
            FirelinkDeepLink::Add(vec![deep_link.to_string()])
        );
    }

    #[test]
    fn filters_opened_torrent_arguments_to_absolute_files() {
        assert_eq!(
            normalize_opened_torrent_argument("file:///tmp/example%20one.torrent"),
            Some("/tmp/example one.torrent".to_string())
        );
        assert!(normalize_opened_torrent_argument("relative/example.torrent").is_none());
        assert!(normalize_opened_torrent_argument("--flag.torrent").is_none());
        assert!(normalize_opened_torrent_argument("/tmp/line\nbreak.torrent").is_none());
        assert!(normalize_opened_torrent_argument("file:///tmp/line%0Abreak.torrent").is_none());
        assert!(normalize_opened_torrent_argument("/tmp/example.zip").is_none());
        if cfg!(target_os = "windows") {
            assert!(normalize_opened_torrent_argument("C:/example.torrent").is_some());
        } else {
            assert!(normalize_opened_torrent_argument("C:/example.torrent").is_none());
        }

        let paths = collect_opened_torrent_paths([
            "--new-instance",
            "/tmp/one.torrent",
            "/tmp/one.torrent",
            "/tmp/two.TORRENT",
            "/tmp/readme.txt",
        ]);
        assert_eq!(paths, vec![
            "/tmp/one.torrent".to_string(),
            "/tmp/two.TORRENT".to_string(),
        ]);
    }

    #[test]
    fn rejects_launch_variants_and_nested_schemes() {
        let links = [
            url::Url::parse("firelink://open?url=https%3A%2F%2Fexample.com").unwrap(),
            url::Url::parse("firelink://add?url=file%3A%2F%2F%2Ftmp%2Fsecret").unwrap(),
            url::Url::parse("other://add?url=https%3A%2F%2Fexample.com").unwrap(),
            url::Url::parse("firelink://launch?url=https%3A%2F%2Fexample.com").unwrap(),
            url::Url::parse("firelink://launch/path").unwrap(),
            url::Url::parse("firelink://user@launch").unwrap(),
            url::Url::parse("firelink://add/path?url=https%3A%2F%2Fexample.com").unwrap(),
        ];

        assert!(links
            .iter()
            .all(|link| parse_firelink_deep_link(link) == FirelinkDeepLink::Invalid));
    }

    #[test]
    fn excludes_youtube_storyboard_mhtml_formats() {
        let storyboard = json!({
            "format_id": "sb0",
            "ext": "mhtml",
            "protocol": "mhtml",
            "format_note": "storyboard",
            "vcodec": "none",
            "acodec": "none"
        });

        assert!(is_excluded_yt_dlp_format(&storyboard));
    }

    #[test]
    fn builds_compact_media_options_without_storyboards() {
        let formats = vec![
            json!({
                "format_id": "sb0",
                "ext": "mhtml",
                "protocol": "mhtml",
                "format_note": "storyboard",
                "vcodec": "none",
                "acodec": "none"
            }),
            json!({
                "format_id": "137",
                "ext": "mp4",
                "height": 1080,
                "format_note": "1080p",
                "vcodec": "avc1.640028",
                "acodec": "none",
                "filesize": 100_000_000_u64
            }),
            json!({
                "format_id": "140",
                "ext": "m4a",
                "vcodec": "none",
                "acodec": "mp4a.40.2",
                "filesize": 10_000_000_u64
            }),
        ];

        let options = build_media_format_options(&formats, Some(600.0));

        assert!(!options.iter().any(|format| format.ext == "mhtml"));
        assert!(!options.iter().any(|format| format.resolution == "Best"));
        assert!(!options.iter().any(|format| format.resolution == "1440p"));
        assert!(options.iter().any(|format| {
            format.resolution == "1080p"
                && format.ext == "mkv"
                && format.format_label == "MKV • H.264 + AAC"
                && format.filesize == Some(110_000_000)
        }));
        assert!(options.iter().any(|format| {
            format.resolution == "1080p"
                && format.ext == "mp4"
                && format.format_label == "MP4 • H.264 + AAC"
                && format.filesize == Some(110_000_000)
        }));
        assert!(options.iter().any(|format| {
            format.resolution == "Audio only" && format.format_label == "M4A • AAC"
        }));
    }

    #[test]
    fn estimates_missing_video_size_from_bitrate_and_uses_exact_stream_ids() {
        let formats = vec![
            json!({
                "format_id": "301",
                "ext": "mp4",
                "height": 1080,
                "fps": 60,
                "vcodec": "avc1.64002A",
                "acodec": "none",
                "tbr": 6_400.0
            }),
            json!({
                "format_id": "251",
                "ext": "webm",
                "vcodec": "none",
                "acodec": "opus",
                "filesize": 28_000_000_u64
            }),
        ];
        let options = build_media_format_options(&formats, Some(1_800.0));
        let option = options
            .iter()
            .find(|format| format.resolution == "1080p" && format.ext == "mkv")
            .expect("1080p MKV option");

        assert_eq!(option.format_id, "301+251");
        assert_eq!(option.filesize, None);
        assert_eq!(option.filesize_approx, Some(1_468_000_000));
    }

    #[test]
    fn keeps_every_available_video_height_including_nonstandard_qualities() {
        let formats = vec![
            json!({
                "format_id": "401",
                "ext": "webm",
                "height": 4320,
                "vcodec": "av01.0.17M.08",
                "acodec": "none"
            }),
            json!({
                "format_id": "17",
                "ext": "mp4",
                "height": 144,
                "vcodec": "avc1.42E01E",
                "acodec": "mp4a.40.2"
            }),
            json!({
                "format_id": "five-k",
                "ext": "webm",
                "resolution": "5120X2880",
                "vcodec": "av01.0.17M.08",
                "acodec": "none"
            }),
            json!({
                "format_id": "pal",
                "ext": "mp4",
                "format_note": "Premium 576p",
                "vcodec": "avc1.4d401f",
                "acodec": "none"
            }),
        ];

        let options = build_media_format_options(&formats, Some(60.0));

        assert!(options.iter().any(|format| format.resolution == "4320p"));
        assert!(options.iter().any(|format| format.resolution == "2880p"));
        assert!(options.iter().any(|format| format.resolution == "576p"));
        assert!(options.iter().any(|format| format.resolution == "144p"));
    }

    #[test]
    fn returns_no_media_options_for_webpage_only_metadata() {
        let formats = vec![json!({
            "format_id": "0",
            "ext": "html",
            "protocol": "https",
            "format": "default webpage",
            "vcodec": "none",
            "acodec": "none"
        })];

        assert!(build_media_format_options(&formats, Some(30.0)).is_empty());
    }

    #[test]
    fn classifies_browser_cookie_database_errors() {
        assert!(is_browser_cookie_extraction_error(
            "ERROR: Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271"
        ));
        assert!(is_browser_cookie_extraction_error(
            "failed to read browser cookie data"
        ));
        assert!(!is_browser_cookie_extraction_error(
            "ERROR: Sign in to confirm you are not a bot"
        ));
        assert!(!is_browser_cookie_extraction_error(
            "ERROR: requested format is not available"
        ));
    }

    #[test]
    fn retries_once_without_browser_cookies_only_for_cookie_database_failures() {
        let cookie_database_error =
            "ERROR: Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271";

        assert!(should_retry_without_browser_cookies(
            Some("chrome"),
            cookie_database_error,
            false
        ));
        assert!(!should_retry_without_browser_cookies(
            Some("chrome"),
            cookie_database_error,
            true
        ));
        assert!(!should_retry_without_browser_cookies(
            Some("none"),
            cookie_database_error,
            false
        ));
        assert!(!should_retry_without_browser_cookies(
            None,
            cookie_database_error,
            false
        ));
        assert!(!should_retry_without_browser_cookies(
            Some("chrome"),
            "ERROR: Sign in to confirm you are not a bot",
            false
        ));
    }

    #[test]
    #[ignore = "requires network and a local yt-dlp executable"]
    fn filters_live_youtube_metadata_from_env() {
        let url = std::env::var("FIRELINK_LIVE_YOUTUBE_URL")
            .expect("set FIRELINK_LIVE_YOUTUBE_URL to a YouTube watch URL");
        let output = std::process::Command::new("yt-dlp")
            .args([
                "--dump-json",
                "--no-warnings",
                "--no-playlist",
                "--socket-timeout",
                "20",
                "--retries",
                "3",
                "--extractor-retries",
                "3",
                "--compat-options",
                "no-youtube-unavailable-videos",
                "--",
                &url,
            ])
            .output()
            .expect("failed to run yt-dlp");

        assert!(
            output.status.success(),
            "yt-dlp failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let value: serde_json::Value =
            serde_json::from_slice(&output.stdout).expect("yt-dlp did not emit valid JSON");
        let formats = value
            .get("formats")
            .and_then(|v| v.as_array())
            .expect("yt-dlp JSON did not include formats");
        let raw_mhtml_count = formats
            .iter()
            .filter(|format| json_lower(format, "ext") == "mhtml")
            .count();
        let duration = value.get("duration").and_then(|duration| duration.as_f64());
        let options = build_media_format_options(formats, duration);

        eprintln!(
            "raw formats: {}, raw mhtml: {}, normalized options: {}",
            formats.len(),
            raw_mhtml_count,
            options.len()
        );
        assert!(!options.is_empty());
        assert!(options.iter().all(|format| format.ext != "mhtml"));
        assert!(options
            .iter()
            .all(|format| !format.format_label.to_lowercase().contains("mhtml")));
    }

    #[test]
    fn parses_structured_ytdlp_progress() {
        let line = format!(
            "{MEDIA_PROGRESS_PREFIX}{{\"downloaded_bytes\":5242880,\"total_bytes\":10485760,\"speed\":1048576,\"eta\":5,\"_speed_str\":\"1.00MiB/s\",\"_eta_str\":\"00:05\",\"_total_bytes_str\":\"10.00MiB\"}}"
        );

        assert_eq!(
            parse_media_progress_line(&line),
            Some(MediaProgress {
                fraction: 0.5,
                speed: "1.00MiB/s".to_string(),
                eta: "00:05".to_string(),
                size: Some("10.00MiB".to_string()),
                downloaded_bytes: Some(5242880.0),
                total_bytes: Some(10485760.0),
                total_is_estimate: false,
            })
        );
    }

    #[test]
    fn keeps_structured_estimated_total_out_of_stable_byte_progress() {
        let line = format!(
            "{MEDIA_PROGRESS_PREFIX}{{\"downloaded_bytes\":5242880,\"total_bytes\":null,\"total_bytes_estimate\":10485760,\"_total_bytes_estimate_str\":\"~10.00MiB\"}}"
        );

        assert_eq!(
            parse_media_progress_line(&line),
            Some(MediaProgress {
                fraction: 0.5,
                speed: "-".to_string(),
                eta: "-".to_string(),
                size: None,
                downloaded_bytes: Some(5242880.0),
                total_bytes: None,
                total_is_estimate: true,
            })
        );
    }

    #[test]
    fn ignores_estimated_media_totals_without_fragment_metadata() {
        let line = format!(
            "{MEDIA_PROGRESS_PREFIX}{{\"downloaded_bytes\":512,\"total_bytes_estimate\":1024,\"_percent_str\":\"50.0%\"}}"
        );

        let progress = parse_media_progress_line(&line).expect("structured progress should parse");
        assert_eq!(progress.fraction, 0.5);
        assert_eq!(progress.size, None);
        assert_eq!(progress.downloaded_bytes, Some(512.0));
        assert_eq!(progress.total_bytes, None);
        assert!(progress.total_is_estimate);
    }

    #[test]
    fn parses_chunked_structured_ytdlp_progress() {
        let mut buffer = String::new();
        let first = format!("{MEDIA_PROGRESS_PREFIX}{{\"downloaded_bytes\":5242880,");
        let second = "\"total_bytes\":10485760,\"_percent\":50.0,\"_speed_str\":\"1.00MiB/s\"}\n";

        assert!(drain_media_output_lines(&mut buffer, &first).is_empty());
        let lines = drain_media_output_lines(&mut buffer, second);

        assert_eq!(lines.len(), 1);
        assert_eq!(
            parse_media_progress_line(&lines[0]).map(|progress| progress.fraction),
            Some(0.5)
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn parses_structured_ytdlp_numeric_percent_without_total() {
        let line = format!(
            "{MEDIA_PROGRESS_PREFIX}{{\"downloaded_bytes\":5242880,\"_percent\":37.5,\"_speed_str\":\"1.00MiB/s\"}}"
        );

        assert_eq!(
            parse_media_progress_line(&line).map(|progress| progress.fraction),
            Some(0.375)
        );
    }

    #[test]
    fn parses_ffmpeg_snapshot_version_without_collapsing_to_n() {
        let output = "ffmpeg version N-125385-ge2e889d9da-https://www.martin-riedl.de Copyright (c) 2000-2026 the FFmpeg developers";

        assert_eq!(
            parse_ffmpeg_version(output),
            Some("N-125385-ge2e889d9da".to_string())
        );
    }

    #[test]
    fn parses_ffmpeg_release_version_without_build_suffix() {
        let output = "ffmpeg version 8.1.2-static https://example.invalid Copyright (c) 2000-2026 the FFmpeg developers";

        assert_eq!(parse_ffmpeg_version(output), Some("8.1.2".to_string()));
    }

    #[test]
    fn uses_fragment_progress_instead_of_temporary_hls_size_estimates() {
        let line = format!(
            "{MEDIA_PROGRESS_PREFIX}{{\"downloaded_bytes\":1024,\"total_bytes_estimate\":1024,\"fragment_index\":0,\"fragment_count\":354,\"_percent_str\":\"100.0%\"}}"
        );

        let progress = parse_media_progress_line(&line).expect("structured progress should parse");
        assert_eq!(progress.fraction, 0.0);
        assert_eq!(progress.size, None);
        assert_eq!(progress.total_bytes, None);
        assert!(progress.total_is_estimate);
    }

    #[test]
    fn advances_tracks_only_after_a_completed_track_restarts() {
        let mut current_track = 0.0;
        let mut last_fraction = 0.0;

        assert_eq!(
            aggregate_media_fraction(2.0, &mut current_track, &mut last_fraction, 0.5),
            0.25
        );
        assert_eq!(
            aggregate_media_fraction(2.0, &mut current_track, &mut last_fraction, 1.0),
            0.5
        );
        assert_eq!(
            aggregate_media_fraction(2.0, &mut current_track, &mut last_fraction, 0.0),
            0.5
        );
        assert_eq!(
            aggregate_media_fraction(2.0, &mut current_track, &mut last_fraction, 0.4),
            0.7
        );
        assert_eq!(current_track, 1.0);
    }

    #[test]
    fn aggregates_media_byte_progress_across_tracks() {
        let mut state = MediaProgressEmitterState::new();
        let first = MediaProgress {
            fraction: 0.99,
            speed: "-".to_string(),
            eta: "-".to_string(),
            size: Some("100B".to_string()),
            downloaded_bytes: Some(99.0),
            total_bytes: Some(100.0),
            total_is_estimate: false,
        };
        let second = MediaProgress {
            fraction: 0.01,
            speed: "-".to_string(),
            eta: "-".to_string(),
            size: Some("200B".to_string()),
            downloaded_bytes: Some(2.0),
            total_bytes: Some(200.0),
            total_is_estimate: true,
        };

        aggregate_media_fraction(
            2.0,
            &mut state.current_track,
            &mut state.last_fraction,
            first.fraction,
        );
        assert_eq!(
            aggregate_media_byte_progress(&first, false, &mut state),
            Some((99, 100, false))
        );
        aggregate_media_fraction(
            2.0,
            &mut state.current_track,
            &mut state.last_fraction,
            second.fraction,
        );
        assert_eq!(
            aggregate_media_byte_progress(&second, true, &mut state),
            Some((101, 300, true))
        );
    }

    #[test]
    fn preserves_single_track_totals_when_byte_aggregation_is_unavailable() {
        let progress = MediaProgress {
            fraction: 0.5,
            speed: "-".to_string(),
            eta: "-".to_string(),
            size: Some("~2.00 KB".to_string()),
            downloaded_bytes: Some(1024.0),
            total_bytes: Some(2048.0),
            total_is_estimate: true,
        };

        assert_eq!(
            media_progress_event_totals(&progress, None, 1.0),
            (Some(2048.0), Some(true))
        );
        assert_eq!(
            media_progress_event_totals(&progress, None, 2.0),
            (None, None)
        );
        assert_eq!(
            media_progress_event_totals(&progress, Some((1024, 4096, false)), 1.0),
            (Some(4096.0), Some(false))
        );
    }

    #[test]
    fn freezes_a_media_track_estimate_across_progress_updates() {
        let mut state = MediaProgressEmitterState::new();
        let first = MediaProgress {
            fraction: 0.25,
            speed: "-".to_string(),
            eta: "-".to_string(),
            size: Some("~100B".to_string()),
            downloaded_bytes: Some(25.0),
            total_bytes: Some(100.0),
            total_is_estimate: true,
        };
        let later = MediaProgress {
            fraction: 0.75,
            speed: "-".to_string(),
            eta: "-".to_string(),
            size: Some("~200B".to_string()),
            downloaded_bytes: Some(150.0),
            total_bytes: Some(200.0),
            total_is_estimate: true,
        };

        assert_eq!(
            aggregate_media_byte_progress(&first, false, &mut state),
            Some((25, 100, true))
        );
        assert_eq!(
            aggregate_media_byte_progress(&later, false, &mut state),
            Some((150, 100, true))
        );

        let exact = MediaProgress {
            fraction: 0.9,
            speed: "-".to_string(),
            eta: "-".to_string(),
            size: Some("200B".to_string()),
            downloaded_bytes: Some(180.0),
            total_bytes: Some(200.0),
            total_is_estimate: false,
        };
        assert_eq!(
            aggregate_media_byte_progress(&exact, false, &mut state),
            Some((180, 200, false))
        );
    }

    #[test]
    fn preserves_estimated_bytes_when_a_split_track_exceeds_its_estimate() {
        let mut state = MediaProgressEmitterState::new();
        let first = MediaProgress {
            fraction: 0.75,
            speed: "-".to_string(),
            eta: "-".to_string(),
            size: Some("~100B".to_string()),
            downloaded_bytes: Some(150.0),
            total_bytes: Some(100.0),
            total_is_estimate: true,
        };
        let second = MediaProgress {
            fraction: 0.01,
            speed: "-".to_string(),
            eta: "-".to_string(),
            size: Some("50B".to_string()),
            downloaded_bytes: Some(1.0),
            total_bytes: Some(50.0),
            total_is_estimate: false,
        };

        assert_eq!(
            aggregate_media_byte_progress(&first, false, &mut state),
            Some((150, 100, true))
        );
        assert_eq!(
            aggregate_media_byte_progress(&second, true, &mut state),
            Some((151, 150, true))
        );
    }

    #[test]
    fn derives_main_window_speed_from_downloaded_byte_delta() {
        let first = MediaProgress {
            fraction: 0.25,
            speed: "fallback".to_string(),
            eta: "-".to_string(),
            size: None,
            downloaded_bytes: Some(1_000_000.0),
            total_bytes: None,
            total_is_estimate: false,
        };
        let second = MediaProgress {
            fraction: 0.5,
            speed: "fallback".to_string(),
            eta: "-".to_string(),
            size: None,
            downloaded_bytes: Some(3_097_152.0),
            total_bytes: None,
            total_is_estimate: false,
        };
        let start = Instant::now();
        let mut sampler = MediaSpeedSampler::default();

        assert_eq!(
            media_progress_speed(&first, start, &mut sampler),
            ("fallback".to_string(), "-".to_string())
        );
        assert_eq!(
            media_progress_speed(&second, start + Duration::from_secs(1), &mut sampler),
            ("2.0 MB/s".to_string(), "1s".to_string())
        );
    }

    #[test]
    fn smooths_media_speed_across_short_stalls() {
        let start = Instant::now();
        let mut sampler = MediaSpeedSampler::default();
        let mut progress = MediaProgress {
            fraction: 0.25,
            speed: "-".to_string(),
            eta: "-".to_string(),
            size: None,
            downloaded_bytes: Some(1_000_000.0),
            total_bytes: None,
            total_is_estimate: false,
        };

        assert_eq!(
            media_progress_speed(&progress, start, &mut sampler),
            ("-".to_string(), "-".to_string())
        );

        progress.fraction = 0.5;
        progress.downloaded_bytes = Some(3_000_000.0);
        assert_eq!(
            media_progress_speed(&progress, start + Duration::from_secs(1), &mut sampler),
            ("1.9 MB/s".to_string(), "2s".to_string())
        );

        progress.downloaded_bytes = Some(3_000_000.0);
        assert_eq!(
            media_progress_speed(&progress, start + Duration::from_secs(2), &mut sampler),
            ("976.6 KB/s".to_string(), "3s".to_string())
        );
    }

    #[test]
    fn parses_aria2_external_downloader_progress() {
        let line = "[#2d2636 12MiB/34MiB(34%) CN:1 DL:910KiB ETA:25s]";

        assert_eq!(
            parse_media_progress_line(line),
            Some(MediaProgress {
                fraction: 0.34,
                speed: "910KiB/s".to_string(),
                eta: "25s".to_string(),
                size: Some("34MiB".to_string()),
                downloaded_bytes: Some(12.0 * 1024.0 * 1024.0),
                total_bytes: Some(34.0 * 1024.0 * 1024.0),
                total_is_estimate: false,
            })
        );
    }

    #[test]
    fn retains_legacy_ytdlp_progress_fallback() {
        let line = "[download]  42.5% of ~10.00MiB at 2.00MiB/s ETA 00:03";

        assert_eq!(
            parse_media_progress_line(line),
            Some(MediaProgress {
                fraction: 0.425,
                speed: "2.00MiB/s".to_string(),
                eta: "00:03".to_string(),
                size: Some("10.00MiB".to_string()),
                downloaded_bytes: Some(4456448.0),
                total_bytes: Some(10485760.0),
                total_is_estimate: true,
            })
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Aria2RecoveryReason {
    ZeroProgress,
    SlowThroughput,
    ConnectionPoolCollapse,
}

impl Aria2RecoveryReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::ZeroProgress => "zero-stall",
            Self::SlowThroughput => "slow-throughput",
            Self::ConnectionPoolCollapse => "connection-collapse",
        }
    }
}

#[derive(Default)]
struct Aria2ConnectionObservation {
    gid: String,
    control_epoch: u64,
    saw_multiple_connections: bool,
    healthy_speed_samples: u8,
    healthy_samples_since_recovery: u8,
    recovery_attempts: u8,
    degraded_since: Option<Instant>,
    no_progress_since: Option<Instant>,
    last_refreshed_at: Option<Instant>,
    peak_speed_bytes: f64,
    last_completed: u64,
    seeder: bool,
    verifying: bool,
}

struct Aria2ConnectionSample<'a> {
    gid: &'a str,
    control_epoch: u64,
    status: &'a str,
    total: u64,
    completed: u64,
    speed_bytes: f64,
    active_connections: i32,
    requested_connections: i32,
    speed_limited: bool,
    now: Instant,
}

fn aria2_active_connection_count(status_info: &serde_json::Value) -> i32 {
    status_info
        .get("connections")
        .and_then(|value| {
            value
                .as_str()
                .and_then(|value| value.parse::<i32>().ok())
                .or_else(|| value.as_i64().and_then(|value| i32::try_from(value).ok()))
        })
        .filter(|value| *value >= 0)
        .unwrap_or(0)
}

const ARIA2_CONNECTION_RECOVERY_DELAY: Duration = Duration::from_secs(30);
const ARIA2_CONNECTION_RECOVERY_COOLDOWN: Duration = Duration::from_secs(45);
const ARIA2_MIN_REMAINING_FOR_CONNECTION_RECOVERY: u64 = 1024 * 1024;
const ARIA2_MIN_PEAK_SPEED_FOR_DEGRADED_RECOVERY: f64 = 64.0 * 1024.0;
const ARIA2_DEGRADED_SPEED_FRACTION: f64 = 0.20;
const ARIA2_CONNECTION_POOL_DEGRADED_FRACTION: f64 = 0.75;
const ARIA2_MIN_HEALTHY_SPEED_SAMPLES: u8 = 3;
const ARIA2_MAX_CONSECUTIVE_RECOVERY_ATTEMPTS: u8 = 3;

#[cfg(test)]
// Keep the test scenarios explicit while the production path uses the typed sample.
#[allow(clippy::too_many_arguments)]
fn observe_aria2_connections(
    observation: &mut Aria2ConnectionObservation,
    gid: &str,
    status: &str,
    total: u64,
    completed: u64,
    speed_bytes: f64,
    active_connections: i32,
    requested_connections: i32,
    speed_limited: bool,
    now: Instant,
) -> Option<Aria2RecoveryReason> {
    observe_aria2_connections_with_epoch(
        observation,
        Aria2ConnectionSample {
            gid,
            control_epoch: 0,
            status,
            total,
            completed,
            speed_bytes,
            active_connections,
            requested_connections,
            speed_limited,
            now,
        },
    )
}

fn observe_aria2_connections_with_epoch(
    observation: &mut Aria2ConnectionObservation,
    sample: Aria2ConnectionSample<'_>,
) -> Option<Aria2RecoveryReason> {
    let Aria2ConnectionSample {
        gid,
        control_epoch,
        status,
        total,
        completed,
        speed_bytes,
        active_connections,
        requested_connections,
        speed_limited,
        now,
    } = sample;
    if observation.gid != gid || observation.control_epoch != control_epoch {
        let preserved_recovery_attempts = if observation.control_epoch == control_epoch {
            observation.recovery_attempts
        } else {
            Default::default()
        };
        *observation = Aria2ConnectionObservation {
            gid: gid.to_string(),
            control_epoch,
            last_completed: completed,
            recovery_attempts: preserved_recovery_attempts,
            ..Default::default()
        };
    }

    let remaining = total.saturating_sub(completed);
    let mut reason = None;
    if status == "active" && total > completed {
        let speed_bytes = speed_bytes.max(0.0);
        // A decaying peak keeps the trigger sensitive to a recent healthy
        // rate without permanently comparing against a brief startup burst.
        observation.peak_speed_bytes = (observation.peak_speed_bytes * 0.995).max(speed_bytes);

        if completed > observation.last_completed {
            observation.no_progress_since = None;
        } else if speed_bytes <= 0.0 {
            let stalled_since = observation.no_progress_since.get_or_insert(now);
            if now.duration_since(*stalled_since) >= ARIA2_CONNECTION_RECOVERY_DELAY {
                reason = Some(Aria2RecoveryReason::ZeroProgress);
            }
        } else {
            observation.no_progress_since = None;
        }

        let multi_connection_candidate = requested_connections > 1
            && remaining >= ARIA2_MIN_REMAINING_FOR_CONNECTION_RECOVERY;
        if multi_connection_candidate {
            let healthy_connection_sample = active_connections > 1
                && speed_bytes >= ARIA2_MIN_PEAK_SPEED_FOR_DEGRADED_RECOVERY
                && speed_bytes >= observation.peak_speed_bytes * 0.5;
            if healthy_connection_sample {
                observation.healthy_speed_samples = observation
                    .healthy_speed_samples
                    .saturating_add(1);
            }
            let slow_throughput = !speed_limited
                && observation.saw_multiple_connections
                && observation.healthy_speed_samples >= ARIA2_MIN_HEALTHY_SPEED_SAMPLES
                && observation.peak_speed_bytes
                    >= ARIA2_MIN_PEAK_SPEED_FOR_DEGRADED_RECOVERY
                && speed_bytes > 0.0
                && speed_bytes < observation.peak_speed_bytes * ARIA2_DEGRADED_SPEED_FRACTION;
            let partial_connection_pool_collapse = !speed_limited
                && observation.saw_multiple_connections
                && observation.healthy_speed_samples >= ARIA2_MIN_HEALTHY_SPEED_SAMPLES
                && requested_connections >= 4
                && (active_connections as f64)
                    <= (requested_connections as f64) * ARIA2_CONNECTION_POOL_DEGRADED_FRACTION
                && observation.peak_speed_bytes >= ARIA2_MIN_PEAK_SPEED_FOR_DEGRADED_RECOVERY
                && speed_bytes > 0.0
                && speed_bytes < observation.peak_speed_bytes * 0.5;
            let connection_pool_collapse = !speed_limited
                && observation.saw_multiple_connections
                && observation.healthy_speed_samples >= ARIA2_MIN_HEALTHY_SPEED_SAMPLES
                && (active_connections <= 1 || partial_connection_pool_collapse);
            if observation.recovery_attempts > 0 {
                if !speed_limited
                    && healthy_connection_sample
                    && !slow_throughput
                    && !connection_pool_collapse
                {
                    observation.healthy_samples_since_recovery = observation
                        .healthy_samples_since_recovery
                        .saturating_add(1);
                    if observation.healthy_samples_since_recovery
                        >= ARIA2_MIN_HEALTHY_SPEED_SAMPLES
                    {
                        observation.recovery_attempts = 0;
                        observation.healthy_samples_since_recovery = 0;
                    }
                } else {
                    observation.healthy_samples_since_recovery = 0;
                }
            }
            if slow_throughput || connection_pool_collapse {
                let degraded_since = observation.degraded_since.get_or_insert(now);
                if now.duration_since(*degraded_since) >= ARIA2_CONNECTION_RECOVERY_DELAY
                    && reason.is_none()
                {
                    reason = Some(if slow_throughput {
                        Aria2RecoveryReason::SlowThroughput
                    } else {
                        Aria2RecoveryReason::ConnectionPoolCollapse
                    });
                }
            } else {
                observation.degraded_since = None;
            }

            if active_connections > 1 {
                observation.saw_multiple_connections = true;
            }
        } else {
            observation.degraded_since = None;
        }
    } else {
        observation.degraded_since = None;
        observation.no_progress_since = None;
    }

    observation.last_completed = completed;

    let recovery_allowed = observation.last_refreshed_at.is_none_or(|last| {
        now.duration_since(last) >= ARIA2_CONNECTION_RECOVERY_COOLDOWN
    }) && observation.recovery_attempts < ARIA2_MAX_CONSECUTIVE_RECOVERY_ATTEMPTS;
    if !recovery_allowed {
        return None;
    }

    if let Some(reason) = reason {
        observation.last_refreshed_at = Some(now);
        observation.recovery_attempts = observation.recovery_attempts.saturating_add(1);
        observation.healthy_samples_since_recovery = 0;
        // Start a fresh observation window after every attempt. This permits
        // bounded repeated healing while preventing a refresh loop every poll
        // tick or indefinitely repeating against a host-side connection cap.
        match reason {
            Aria2RecoveryReason::ZeroProgress => observation.no_progress_since = Some(now),
            Aria2RecoveryReason::SlowThroughput
            | Aria2RecoveryReason::ConnectionPoolCollapse => {
                observation.degraded_since = Some(now)
            }
        }
        Some(reason)
    } else {
        None
    }
}

static LOG_PAUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
static LOG_STREAM_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn toggle_log_pause(caller: tauri::WebviewWindow, pause: bool) -> Result<(), String> {
    properties_window::ensure_main_window(&caller)?;
    LOG_PAUSED.store(pause, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn is_log_paused(caller: tauri::WebviewWindow) -> bool {
    properties_window::ensure_main_window(&caller).is_ok()
        && LOG_PAUSED.load(std::sync::atomic::Ordering::Relaxed)
}

#[tauri::command]
fn set_log_stream_active(caller: tauri::WebviewWindow, active: bool) -> Result<(), String> {
    if let Err(error) = properties_window::ensure_main_window(&caller) {
        return Err(error);
    }
    LOG_STREAM_ACTIVE.store(active, std::sync::atomic::Ordering::Release);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_reqwest_crypto_provider();

    let storage_mode = crate::storage::StorageMode::detect();
    let setup_storage_mode = storage_mode.clone();
    let log_target = match &storage_mode {
        crate::storage::StorageMode::Standard => tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir { file_name: None },
        ),
        crate::storage::StorageMode::Portable { root } => tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Folder {
                path: root.join("data").join("logs"),
                file_name: None,
            },
        ),
    };

    let extension_pairing_token = Arc::new(RwLock::new(String::new()));
    let server_pairing_token = extension_pairing_token.clone();
    let extension_frontend_ready = Arc::new(AtomicBool::new(false));
    let server_frontend_ready = extension_frontend_ready.clone();
    let extension_acks = Arc::new(Mutex::new(HashMap::new()));
    let server_extension_acks = extension_acks.clone();
    let extension_server_port = Arc::new(RwLock::new(None));
    let server_extension_port = extension_server_port.clone();
    let (extension_server_shutdown_tx, extension_server_shutdown_rx) =
        tokio::sync::watch::channel(false);

    let initial_aria2_port = 6800; // Will be determined dynamically in background
    let aria2_port = Arc::new(std::sync::atomic::AtomicU16::new(initial_aria2_port));
    let aria2_port_clone = Arc::clone(&aria2_port);
    let aria2_secret = uuid::Uuid::new_v4().to_string();
    tauri::Builder::default()
        .manage(MainWindowRestoreState::default())
        .manage(properties_window::PropertiesWindowRegistry::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            restore_main_window(app);
            let paths = collect_opened_torrent_paths(args);
            dispatch_opened_torrent_paths(app.clone(), paths);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(Aria2DaemonGuard::new())
        .setup(move |app| {
            let storage_layout = crate::storage::StorageLayout::resolve(
                app.handle(),
                setup_storage_mode.clone(),
            )?;
            let main_window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
                .ok_or_else(|| "main window configuration is missing".to_string())?;
            let mut main_window_builder = tauri::WebviewWindowBuilder::from_config(
                app.handle(),
                &main_window_config,
            )
            .map_err(|error| format!("failed to prepare main window: {error}"))?;
            if storage_layout.is_portable() {
                main_window_builder =
                    main_window_builder.data_directory(storage_layout.webview_dir().to_path_buf());
            }

            let mut sys = sysinfo::System::new_all();
            sys.refresh_all();
            log::info!("=== System Information ===");
            log::info!("OS: {} {}", sysinfo::System::name().unwrap_or_else(|| "Unknown".to_string()), sysinfo::System::os_version().unwrap_or_else(|| "Unknown".to_string()));
            let arch = sysinfo::System::cpu_arch();
            log::info!("Architecture: {}", if arch.is_empty() { "Unknown" } else { &arch });
            log::info!("CPU: {} ({} cores)", sys.cpus().first().map(|c| c.brand()).unwrap_or("Unknown"), sys.cpus().len());
            log::info!("Memory: {} MB total", sys.total_memory() / 1024 / 1024);
            log::info!("App Version: {}", env!("CARGO_PKG_VERSION"));
            log::info!("==========================");
            build_main_tray(app.handle())
                .map_err(|error| format!("failed to create tray menu: {error}"))?;
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuItem, WINDOW_SUBMENU_ID};

                let app_menu = tauri::menu::Menu::default(app.handle())
                    .map_err(|error| format!("failed to create application menu: {error}"))?;
                let minimize_item = MenuItem::with_id(
                    app.handle(),
                    MAIN_WINDOW_MINIMIZE_MENU_ID,
                    "Minimize",
                    true,
                    Some("CmdOrCtrl+M"),
                )
                .map_err(|error| format!("failed to create minimize menu item: {error}"))?;
                let window_menu = app_menu
                    .get(WINDOW_SUBMENU_ID)
                    .and_then(|item| item.as_submenu().cloned())
                    .ok_or_else(|| "application Window menu is missing".to_string())?;
                if window_menu
                    .remove_at(0)
                    .map_err(|error| {
                        format!("failed to replace native minimize menu item: {error}")
                    })?
                    .is_none()
                {
                    return Err(
                        "application Window menu has no minimize item"
                            .to_string()
                            .into(),
                    );
                }
                window_menu
                    .insert(&minimize_item, 0)
                    .map_err(|error| format!("failed to install minimize menu item: {error}"))?;
                app.on_menu_event(|app, event| {
                    if event.id.as_ref() == MAIN_WINDOW_MINIMIZE_MENU_ID {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.minimize();
                        }
                    }
                });
                app.set_menu(app_menu)
                    .map_err(|error| format!("failed to install application menu: {error}"))?;
            }

            let database = crate::db::init(&storage_layout)
                .map_err(|error| format!("failed to initialize persistence: {error}"))?;
            if let Err(error) = recover_torrent_move_journals(
                app.handle(),
                &database,
                &storage_layout,
            ) {
                log::warn!("Torrent move recovery did not complete: {error}");
            }
            // Establish Firelink-owned Aria2 routing-table paths after the
            // existing data-root initializer has created the selected storage
            // directory, but before the daemon launcher is scheduled. A
            // conflict must fail startup; silently allowing Aria2 to fall back
            // to a user-global dht.dat would escape the storage boundary.
            let aria2_dht_paths = storage_layout.prepare_aria2_dht_paths()?;
            if let Err(error) = crate::torrent::remove_orphaned_probe_dirs(app.handle()) {
                log::warn!("could not remove orphaned torrent probes: {error}");
            }
            let retained_torrent_metadata = database
                .lock()
                .and_then(|connection| crate::db::load_downloads(&connection))
                .map(|records| {
                    let mut retained_ids = HashSet::new();
                    let mut retained_info_hashes = HashSet::new();
                    for record in records {
                        let retained_id = retained_torrent_id_from_persisted_record(&record);
                        let retained_info_hash =
                            retained_torrent_info_hash_from_persisted_record(&record);
                        let has_retained_metadata =
                            retained_id.is_some() || retained_info_hash.is_some();
                        if let Some(id) = retained_id {
                            retained_ids.insert(id);
                        }
                        if let Some(info_hash) = retained_info_hash {
                            retained_info_hashes.insert(info_hash);
                        }
                        if !has_retained_metadata
                            && serde_json::from_str::<crate::ipc::DownloadItem>(&record).is_err()
                        {
                            log::warn!(
                                "skipping malformed persisted download during torrent metadata retention"
                            );
                        }
                    }
                    (retained_ids, retained_info_hashes)
                });
            match retained_torrent_metadata {
                Ok((retained_torrent_ids, retained_torrent_info_hashes)) => {
                    if let Err(error) = crate::torrent::remove_orphaned_cached_torrents(
                        app.handle(),
                        &retained_torrent_ids,
                        &retained_torrent_info_hashes,
                    ) {
                        log::warn!("could not remove orphaned torrent metadata: {error}");
                    }
                }
                Err(error) => {
                    log::warn!("could not identify retained torrent metadata: {error}");
                }
            }
            let initial_pairing_token = {
                // Generate a temporary session token for the extension server on startup.
                // The frontend will hydrate the real token via IPC once it mounts,
                // avoiding any macOS system prompts before the UI is fully visible.
                format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                )
            };
            {
                let mut pairing_token = extension_pairing_token
                    .write()
                    .map_err(|_| "extension pairing token lock is unavailable".to_string())?;
                *pairing_token = initial_pairing_token;
            }
            app.manage(database);
            let persisted_settings = crate::settings::load_settings(app.handle()).ok();
            let logs_enabled = persisted_settings
                .as_ref()
                .is_some_and(|settings| settings.logs_enabled);
            LOG_PAUSED.store(!logs_enabled, std::sync::atomic::Ordering::Relaxed);
            if logs_enabled {
                log::info!("=== System Information ===");
                log::info!(
                    "OS: {} {}",
                    sysinfo::System::name().unwrap_or_else(|| "Unknown".to_string()),
                    sysinfo::System::os_version().unwrap_or_else(|| "Unknown".to_string())
                );
                let arch = sysinfo::System::cpu_arch();
                log::info!(
                    "Architecture: {}",
                    if arch.is_empty() { "Unknown" } else { &arch }
                );
                log::info!(
                    "CPU: {} ({} cores)",
                    sys.cpus().first().map(|c| c.brand()).unwrap_or("Unknown"),
                    sys.cpus().len()
                );
                log::info!("Memory: {} MB total", sys.total_memory() / 1024 / 1024);
                log::info!("App Version: {}", env!("CARGO_PKG_VERSION"));
                log::info!("==========================");
            }

            let max_concurrent = {
                persisted_settings
                    .as_ref()
                    .map(|settings| settings.max_concurrent_downloads)
                    .unwrap_or(crate::queue::DEFAULT_MAX_CONCURRENT)
            };
            let scheduler_settings = Arc::new(RwLock::new(persisted_settings.clone()));

            let queue_manager = Arc::new(queue::QueueManager::new(app.handle().clone(), max_concurrent));
            if let Some(settings) = persisted_settings.as_ref() {
                queue_manager.configure_seed_capacity(
                    settings.torrent_separate_seed_slots,
                    settings.torrent_max_concurrent_seeds,
                );
            }
            let power_manager = queue_manager.power_manager();
            if let Some(settings) = persisted_settings.as_ref() {
                let _ = power_manager.set_preferences(
                    settings.prevents_sleep_while_downloading,
                    settings.prevents_display_sleep_while_downloading,
                );
            }
            let initial_global_speed_limit = persisted_settings
                .as_ref()
                .and_then(|settings| normalize_speed_limit_for_aria2(&settings.global_speed_limit));
            queue_manager.set_aria2_global_speed_limit(initial_global_speed_limit);
            let dispatcher_mgr = Arc::clone(&queue_manager);
            tauri::async_runtime::spawn(async move {
                dispatcher_mgr.run_dispatcher().await;
            });

            let queue_manager_poll = Arc::clone(&queue_manager);
            let queue_manager_capability = Arc::clone(&queue_manager);

            app.manage(AppState {
                download_coordinator: download::DownloadCoordinator::spawn(app.handle().clone()),
                storage_layout,
                keychain_access_authorized: Arc::new(AtomicBool::new(false)),
                keychain_grant_in_progress: Arc::new(AtomicBool::new(false)),
                keychain_grant: Arc::new(Mutex::new(KeychainGrantState::default())),
                extension_pairing_token,
                extension_frontend_ready,
                extension_acks,
                extension_server_port,
                extension_server_shutdown: extension_server_shutdown_tx.clone(),
                aria2_port: aria2_port.clone(),
                aria2_secret: aria2_secret.clone(),
                media_semaphore: Arc::new(tokio::sync::Semaphore::new(3)),
                power_manager: Arc::clone(&power_manager),
                scheduler_settings: Arc::clone(&scheduler_settings),
                queue_manager,
            });

            if let Err(error) = power_manager.activate() {
                log::error!("power: failed to activate backend power management: {error}");
            }

            // Build the window only after all command state is registered. This
            // prevents the frontend from racing startup and invoking IPC before
            // the database and portable storage layout are available.
            main_window_builder
                .build()
                .map_err(|error| format!("failed to create main window: {error}"))?;
            restore_pending_main_window(app.handle());

            #[cfg(any(target_os = "windows", target_os = "linux"))]
            dispatch_opened_torrent_paths(
                app.handle().clone(),
                collect_opened_torrent_paths(std::env::args_os().skip(1)),
            );

            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                window
                    .set_decorations(false)
                    .map_err(|error| format!("failed to disable Windows native frame: {error}"))?;
            }

            let deep_link_app = app.handle().clone();
            #[cfg(target_os = "linux")]
            if let Err(error) = app.deep_link().register_all() {
                log::warn!("Could not register firelink:// handler: {error}");
            }
            app.deep_link().on_open_url(move |event| {
                dispatch_deep_links(deep_link_app.clone(), event.urls());
            });
            match app.deep_link().get_current() {
                Ok(Some(urls)) => dispatch_deep_links(app.handle().clone(), urls),
                Ok(None) => {}
                Err(error) => eprintln!("Failed to read startup deep link: {error}"),
            }
            crate::scheduler::spawn_scheduler(app.handle().clone(), scheduler_settings);

            let global_speed_limit = persisted_settings
                .as_ref()
                .map(|settings| settings.global_speed_limit.clone())
                .unwrap_or_default();
            let torrent_overall_upload_limit = persisted_settings
                .as_ref()
                .map(|settings| settings.torrent_overall_upload_limit.clone())
                .unwrap_or_default();
            let torrent_peer_discovery = persisted_settings
                .as_ref()
                .map(|settings| {
                    (
                        settings.torrent_enable_dht,
                        settings.torrent_enable_dht6 && settings.torrent_ipv6_enabled,
                        settings.torrent_enable_pex,
                        settings.torrent_enable_lpd,
                    )
                })
                .unwrap_or((true, false, true, false));
            let torrent_max_open_files = persisted_settings
                .as_ref()
                .map(|settings| settings.torrent_max_open_files)
                .unwrap_or(queue::DEFAULT_TORRENT_MAX_OPEN_FILES);
            let torrent_max_open_files = match queue::normalize_torrent_max_open_files(
                torrent_max_open_files,
            ) {
                Ok(value) => value,
                Err(error) => {
                    log::error!(
                        "invalid persisted Torrent open-file limit; using Aria2 default: {error}"
                    );
                    queue::DEFAULT_TORRENT_MAX_OPEN_FILES
                }
            };
            let torrent_startup_settings =
                crate::settings::torrent_startup_settings(persisted_settings.as_ref());

            let aria2_secret_clone = aria2_secret.clone();
            let app_handle_bg = app.handle().clone();
            tauri::async_runtime::spawn(async move {

                let mut ws_port = 6800;
                match resolve_bundled_binary_path(&app_handle_bg, "aria2c") {
                    Ok(binary_path) => {
                        let mut success = false;
                        let mut attempted_rpc_port = false;
                        let mut startup_failure = None;
                        for attempt_port in 6800..6900 {
                            if queue::torrent_port_spec_contains(
                                if torrent_startup_settings.listen_port.is_empty() {
                                    queue::DEFAULT_TORRENT_LISTEN_PORT_SPEC
                                } else {
                                    &torrent_startup_settings.listen_port
                                },
                                attempt_port,
                            ) {
                                continue;
                            }
                            attempted_rpc_port = true;
                            let mut cmd = std::process::Command::new(&binary_path);
                            crate::platform::hide_child_console(&mut cmd);
                            crate::engines::apply_aria2_environment(&mut cmd, &binary_path);

                            let mut config_file = tempfile::Builder::new().prefix("aria2-").suffix(".conf").tempfile().expect("failed to create aria2 config file");
                            use std::io::Write;
                            let config_content = format!("rpc-secret={}\n", aria2_secret_clone);
                            config_file.write_all(config_content.as_bytes()).expect("failed to write aria2 config file");
                            let config_path = config_file.into_temp_path();

                            cmd.arg("--enable-rpc=true")
                                .arg(format!("--conf-path={}", config_path.display()))
                                .arg(format!("--rpc-listen-port={}", attempt_port))
                                .arg("--rpc-listen-all=false")
                                .arg("--continue=true")
                                .arg("--retry-wait=2")
                                .arg("--allow-overwrite=false")
                                .arg("--summary-interval=1")
                                .arg("--console-log-level=warn")
                                .arg("--download-result=hide")
                                .arg("--max-concurrent-downloads=9999")
                                .arg("--check-certificate=true")
                                .arg(format!("--stop-with-process={}", std::process::id()));

                            apply_aria2_torrent_global_options(
                                &mut cmd,
                                torrent_max_open_files,
                                Some(&torrent_overall_upload_limit),
                                &torrent_startup_settings.disk_cache,
                            );
                            apply_aria2_torrent_dht_paths(
                                &mut cmd,
                                &aria2_dht_paths.0,
                                &aria2_dht_paths.1,
                            );
                            apply_aria2_torrent_dht_options(
                                &mut cmd,
                                torrent_startup_settings.dht_message_timeout,
                            );

                            apply_aria2_torrent_peer_discovery_options(
                                &mut cmd,
                                torrent_peer_discovery.0,
                                torrent_peer_discovery.1,
                                torrent_peer_discovery.2,
                                torrent_peer_discovery.3,
                            );
                            apply_aria2_torrent_network_options(
                                &mut cmd,
                                &torrent_startup_settings.listen_port,
                                &torrent_startup_settings.dht_listen_port,
                                &torrent_startup_settings.external_ip,
                                &torrent_startup_settings.dht_entry_point,
                                &torrent_startup_settings.dht_entry_point6,
                                &torrent_startup_settings.dht_listen_addr6,
                                &torrent_startup_settings.lpd_interface,
                                &torrent_startup_settings.bind_address,
                                torrent_startup_settings.ipv6_enabled,
                            );
                            apply_aria2_torrent_peer_identity_options(
                                &mut cmd,
                                &torrent_startup_settings.peer_id_prefix,
                                &torrent_startup_settings.peer_agent,
                            );

                            if let Some(limit) = normalize_speed_limit_for_aria2(&global_speed_limit) {
                                cmd.arg(format!("--max-overall-download-limit={}", limit));
                            }

                            cmd.stdout(std::process::Stdio::null());
                            cmd.stderr(std::process::Stdio::piped());

                            match cmd.spawn() {
                                Ok(mut child) => {
                                    // Give it a moment to fail if port is in use
                                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                                    if let Ok(Some(status)) = child.try_wait() {
                                        use std::io::Read;
                                        let mut stderr = String::new();
                                        if let Some(pipe) = child.stderr.take() {
                                            // A failed child is not trusted to produce a bounded
                                            // diagnostic. Keep startup error handling bounded so a
                                            // pathological stderr stream cannot stall or exhaust
                                            // the launcher while it is deciding whether to retry.
                                            let _ = pipe.take(4096).read_to_string(&mut stderr);
                                        }
                                        let stderr = stderr.trim().to_string();
                                        if aria2_rpc_port_is_occupied(attempt_port) {
                                            // The RPC port is occupied by another process; retry
                                            // with the next candidate. A configured Torrent port
                                            // cannot cause this branch because overlapping RPC
                                            // candidates are skipped above.
                                            continue;
                                        }
                                        startup_failure = Some(if stderr.is_empty() {
                                            format!(
                                                "aria2 exited before startup on RPC port {attempt_port} with status {status}"
                                            )
                                        } else {
                                            format!(
                                                "aria2 exited before startup on RPC port {attempt_port}: {stderr}"
                                            )
                                        });
                                        break;
                                    }

                                    log::info!("aria2c spawned successfully on port {}", attempt_port);

                                    aria2_port_clone.store(attempt_port, std::sync::atomic::Ordering::Relaxed);
                                    ws_port = attempt_port;
                                    success = true;

                                    let daemon_app = app_handle_bg.clone();
                                    if let Some(stderr) = child.stderr.take() {
                                        std::thread::spawn(move || {
                                            use std::io::BufRead;
                                            let reader = std::io::BufReader::new(stderr);
                                            for line in reader.lines().map_while(Result::ok) {
                                                let trimmed = line.trim().to_string();
                                                if let Ok(mut stderr_lock) = daemon_app.state::<Aria2DaemonGuard>().last_stderr.lock() {
                                                    stderr_lock.push_str(&trimmed);
                                                    stderr_lock.push('\n');
                                                    let excess = stderr_lock.len().saturating_sub(8192);
                                                    if excess > 0 {
                                                        let _ = stderr_lock.drain(..excess);
                                                    }
                                                }
                                                let lower = trimmed.to_lowercase();
                                                if lower.contains("error") || lower.contains("critical") {
                                                    log::error!("aria2c stderr: {}", trimmed);
                                                }
                                            }
                                        });
                                    }

                                    let guard = app_handle_bg.state::<Aria2DaemonGuard>();
                                    *guard.child.lock().unwrap() = Some(child);
                                    *guard.config_path.lock().unwrap() = Some(config_path);

                                    let mut last_err = String::new();
                                    let start = std::time::Instant::now();
                                    let mut ready = false;
                                    while start.elapsed() < std::time::Duration::from_secs(5) {
                                        match rpc_call(attempt_port, &aria2_secret_clone, "aria2.getVersion", serde_json::json!([])).await {
                                            Ok(ver) => {
                                                let v = ver.get("version").and_then(|v| v.as_str()).unwrap_or("unknown");
                                                let async_dns_supported = ver
                                                    .get("enabledFeatures")
                                                    .and_then(|features| features.as_array())
                                                    .map(|features| {
                                                        features.iter().any(|feature| {
                                                            feature.as_str() == Some("Async DNS")
                                                        })
                                                    })
                                                    .unwrap_or(false);
                                                queue_manager_capability
                                                    .set_aria2_async_dns_supported(async_dns_supported);
                                                log::info!(
                                                    "aria2 daemon ready (version {}) on port {} (async DNS: {})",
                                                    v,
                                                    attempt_port,
                                                    async_dns_supported
                                                );
                                                ready = true;
                                                break;
                                            }
                                            Err(e) => {
                                                last_err = e;
                                                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                                            }
                                        }
                                    }
                                    if !ready {
                                        let err = if last_err.is_empty() { "aria2 daemon did not become ready within 5 seconds".to_string() } else { format!("aria2 did not become ready: {last_err}") };
                                        log::error!("{}", err);
                                        *guard.startup_error.lock().unwrap() = Some(err);
                                    }
                                    break;
                                }
                                Err(e) => {
                                    startup_failure = Some(format!("Failed to spawn aria2c: {e}"));
                                    break;
                                }
                            }
                        }
                        if !success {
                            let guard = app_handle_bg.state::<Aria2DaemonGuard>();
                            *guard.startup_error.lock().unwrap() = Some(startup_failure.unwrap_or_else(|| {
                                if attempted_rpc_port {
                                    "Failed to find open RPC port for aria2c".to_string()
                                } else {
                                    "No Aria2 RPC port is available outside the configured Torrent TCP listen ports".to_string()
                                }
                            }));
                        }
                    }
                    Err(e) => {
                        log::error!("Failed to resolve aria2c binary: {}", e);
                        let guard = app_handle_bg.state::<Aria2DaemonGuard>();
                        *guard.startup_error.lock().unwrap() = Some(format!("Failed to resolve aria2c: {e}"));
                    }
                }

                let mut ws_retries = 0;
                loop {
                    if ws_retries == 10 {
                        log::error!("Aria2 WebSocket is still unavailable after repeated reconnection attempts; continuing to retry.");
                        let guard = app_handle_bg.state::<Aria2DaemonGuard>();
                        *guard.startup_error.lock().unwrap() = Some("Max WebSocket reconnection attempts reached.".to_string());
                        // Keep retrying. The daemon or local WebSocket can
                        // recover after a prolonged outage; permanently
                        // stopping this task strands active transfers.
                        ws_retries = 0;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    let ws_url = format!("ws://127.0.0.1:{}/jsonrpc", ws_port);
                    if let Ok((ws_stream, _)) = tokio_tungstenite::connect_async(&ws_url).await {
                        ws_retries = 0; // reset on success
                        if let Ok(mut startup_error) = app_handle_bg
                            .state::<Aria2DaemonGuard>()
                            .startup_error
                            .lock()
                        {
                            if startup_error.as_deref()
                                == Some("Max WebSocket reconnection attempts reached.")
                            {
                                *startup_error = None;
                            }
                        }
                        reconcile_aria2_downloads(&app_handle_bg).await;
                        use futures_util::StreamExt;
                        let (_, mut read) = ws_stream.split();
                        while let Some(msg) = read.next().await {
                            if let Ok(tokio_tungstenite::tungstenite::Message::Text(text)) = msg {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                                    if let Some(method) = json.get("method").and_then(|m| m.as_str()) {
                                        if let Some(params) = json.get("params").and_then(|p| p.as_array()) {
                                            if let Some(event) = params.first().and_then(|p| p.as_object()) {
                                                if let Some(gid) = event.get("gid").and_then(|g| g.as_str()) {
                                                    let state = app_handle_bg.state::<AppState>();
                                                    let outcome = match method {
                                                        "aria2.onDownloadComplete" => Some(crate::queue::PendingOutcome::Complete),
                                                        "aria2.onBtDownloadComplete" => Some(crate::queue::PendingOutcome::Seeding),
                                                        "aria2.onDownloadError" => {
                                                            let mut msg = event.get("error_message").and_then(|m| m.as_str()).unwrap_or("aria2 download error").to_string();
                                                            let aria2_port = state.aria2_port.load(std::sync::atomic::Ordering::Relaxed);
                                                            let aria2_secret = state.aria2_secret.clone();
                                                    if let Ok(status) = rpc_call(aria2_port, &aria2_secret, "aria2.tellStatus", serde_json::json!([gid, ["errorCode", "errorMessage"]])).await {
                                                        let err_msg = status
                                                            .get("errorMessage")
                                                            .and_then(|m| m.as_str())
                                                            .filter(|m| !m.is_empty());
                                                        let err_code = status
                                                            .get("errorCode")
                                                            .and_then(|m| m.as_str())
                                                            .filter(|m| !m.is_empty());
                                                        match (err_code, err_msg) {
                                                            (Some(code), Some(message)) => {
                                                                msg = format!("aria2 error code {code}: {message}");
                                                            }
                                                            (Some(code), None) => {
                                                                msg = format!("aria2 error code {code}: {msg}");
                                                            }
                                                            (None, Some(message)) => {
                                                                msg = message.to_string();
                                                            }
                                                            (None, None) => {}
                                                        }
                                                    }
                                                            Some(crate::queue::PendingOutcome::Error(msg))
                                                        }
                                                        _ => None,
                                                    };
                                                    if let Some(outcome) = outcome {
                                                        Arc::clone(&state.queue_manager)
                                                            .handle_aria2_event(gid, outcome)
                                                            .await;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    ws_retries += 1;
                    let state = app_handle_bg.state::<AppState>();
                    let port = state.aria2_port.load(std::sync::atomic::Ordering::Relaxed);
                    if !aria2_daemon_is_reachable(port, &state.aria2_secret).await
                        && aria2_daemon_process_exited(&app_handle_bg)
                    {
                        state.queue_manager.clear_aria2_permits().await;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                }
            });

            let app_handle_poll = app.handle().clone();
            let poll_port = aria2_port.clone();
            let poll_secret = aria2_secret.clone();
            let poll_mgr = Arc::clone(&queue_manager_poll);
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_millis(1000));
                let mut observations: HashMap<String, Aria2ConnectionObservation> = HashMap::new();
                let mut missing_gid_recovery_at: HashMap<String, Instant> = HashMap::new();
                let mut telemetry_hydrated = HashSet::new();
                let mut telemetry_persisted: HashMap<
                    String,
                    crate::queue::TorrentTelemetrySnapshot,
                > = HashMap::new();
                let mut relocation_checks = HashSet::new();
                loop {
                    interval.tick().await;
                    // Terminal cleanup removes a download's GID mapping. Do
                    // not retain one observation per historical download for
                    // the lifetime of the poller.
                    let mapped_ids: HashSet<String> = poll_mgr
                        .aria2_gid_mappings()
                        .into_iter()
                        .map(|(_, id)| id)
                        .collect();
                    observations.retain(|id, _| mapped_ids.contains(id));
                    missing_gid_recovery_at.retain(|id, _| mapped_ids.contains(id));
                    telemetry_hydrated.retain(|id| mapped_ids.contains(id));
                    telemetry_persisted.retain(|id, _| mapped_ids.contains(id));
                    relocation_checks.retain(|id| mapped_ids.contains(id));
                    let params = serde_json::json!([[
                        "gid",
                        "status",
                        "totalLength",
                        "completedLength",
                        "downloadSpeed",
                        "uploadLength",
                        "uploadSpeed",
                        "numSeeders",
                        "seeder",
                        "connections",
                        "errorMessage",
                        "verifiedLength",
                        "verifyIntegrityPending"
                    ]]);
                    if let Ok(active_list) = rpc_call(poll_port.load(std::sync::atomic::Ordering::Relaxed), &poll_secret, "aria2.tellActive", params).await {
                        if let Some(active_arr) = active_list.as_array() {
                            let mut seen_ids = HashSet::new();
                            let mut seen_gids = HashSet::new();
                            for status_info in active_arr {
                                let gid = status_info.get("gid").and_then(|s| s.as_str()).unwrap_or("");
                                let Some(mapping) = poll_mgr.aria2_gid_mapping(gid) else {
                                    continue;
                                };
                                let id = mapping.id.clone();
                                {
                                    let status = status_info.get("status").and_then(|value| value.as_str()).unwrap_or("");
                                    let total = status_info.get("totalLength").and_then(|s| s.as_str()).unwrap_or("0").parse::<u64>().unwrap_or(0);
                                    let completed = status_info.get("completedLength").and_then(|s| s.as_str()).unwrap_or("0").parse::<u64>().unwrap_or(0);
                                    let verified_length = status_info
                                        .get("verifiedLength")
                                        .and_then(|value| {
                                            value
                                                .as_str()
                                                .and_then(|value| value.parse::<u64>().ok())
                                                .or_else(|| value.as_u64())
                                        });
                                    let verify_pending = status_info
                                        .get("verifyIntegrityPending")
                                        .is_some_and(|value| {
                                            value.as_bool() == Some(true)
                                                || value.as_str() == Some("true")
                                        });
                                    let speed_bytes = status_info.get("downloadSpeed").and_then(|s| s.as_str()).unwrap_or("0").parse::<f64>().unwrap_or(0.0);
                                    let uploaded_bytes = status_info.get("uploadLength").and_then(|s| s.as_str()).and_then(|value| value.parse::<u64>().ok());
                                    let upload_speed_bytes = status_info.get("uploadSpeed").and_then(|s| s.as_str()).and_then(|value| value.parse::<f64>().ok());
                                    let num_seeders = status_info.get("numSeeders").and_then(|s| s.as_str()).and_then(|value| value.parse::<i32>().ok());
                                    let is_seeder = status_info.get("seeder").is_some_and(|value| {
                                        value.as_str() == Some("true") || value.as_bool() == Some(true)
                                    });
                                    let active_connections =
                                        aria2_active_connection_count(status_info);
                                    let requested_connections = poll_mgr
                                        .aria2_requested_connections(&id)
                                        .await
                                        .unwrap_or(1)
                                        .max(1);
                                    let speed_limited = poll_mgr.aria2_speed_limited(&id).await;
                                    let control_epoch = mapping.epoch;
                                    // The status snapshot and the requested
                                    // connection lookup both await. A pause,
                                    // retry, or same-GID resume may replace the
                                    // mapping while those awaits are in
                                    // flight. Only emit telemetry if this
                                    // snapshot still owns the same GID epoch.
                                    if !poll_mgr.is_current_aria2_gid_mapping(gid, &mapping)
                                        || !poll_mgr
                                            .is_aria2_control_epoch_current(&id, control_epoch)
                                            .await
                                    {
                                        continue;
                                    }
                                    seen_ids.insert(id.clone());
                                    seen_gids.insert(gid.to_string());
                                    let now = Instant::now();
                                    let observation = observations.entry(id.clone()).or_default();
                                    let recovery_reason = observe_aria2_connections_with_epoch(
                                        observation,
                                        Aria2ConnectionSample {
                                            gid,
                                            control_epoch,
                                            status,
                                            total,
                                            completed,
                                            speed_bytes,
                                            active_connections,
                                            requested_connections,
                                            speed_limited,
                                            now,
                                        },
                                    );
                                    let entering_seeding = is_seeder && !observation.seeder;
                                    observation.seeder = is_seeder;

                                    let is_torrent = poll_mgr.aria2_is_torrent(&id).await;
                                    let is_verification =
                                        poll_mgr.aria2_is_torrent_verification(&id).await;
                                    if !poll_mgr.is_current_aria2_gid_mapping(gid, &mapping)
                                        || !poll_mgr
                                            .is_aria2_control_epoch_current(&id, control_epoch)
                                            .await
                                    {
                                        continue;
                                    }
                                    let torrent_telemetry = if is_torrent {
                                        if !telemetry_hydrated.contains(&id) {
                                            match load_persisted_torrent_item(
                                                &app_handle_poll.state::<crate::db::DbState>(),
                                                &id,
                                            ) {
                                                Ok(item) => {
                                                    poll_mgr
                                                        .hydrate_torrent_telemetry(
                                                            &id,
                                                            item.torrent_uploaded_bytes.unwrap_or(0),
                                                            item.torrent_seeded_seconds.unwrap_or(0),
                                                        )
                                                        .await;
                                                    if item.torrent_relocation_check_pending
                                                        == Some(true)
                                                    {
                                                        relocation_checks.insert(id.clone());
                                                    }
                                                    telemetry_hydrated.insert(id.clone());
                                                }
                                                Err(error) => {
                                                    log::debug!(
                                                        "aria2 telemetry [{}]: could not hydrate durable totals: {}",
                                                        id,
                                                        error
                                                    );
                                                }
                                            }
                                        }
                                        let seed_permit_owned = poll_mgr
                                            .aria2_torrent_seed_permit_owned(&id)
                                            .await;
                                        Some(
                                            poll_mgr
                                                .observe_torrent_telemetry(
                                                    &id,
                                                    gid,
                                                    control_epoch,
                                                    uploaded_bytes,
                                                    is_seeder && seed_permit_owned,
                                                    Instant::now(),
                                                )
                                                .await,
                                        )
                                    } else {
                                        None
                                    };
                                    if !poll_mgr.is_current_aria2_gid_mapping(gid, &mapping)
                                        || !poll_mgr
                                            .is_aria2_control_epoch_current(&id, control_epoch)
                                            .await
                                    {
                                        continue;
                                    }
                                    if let Some(snapshot) = torrent_telemetry {
                                        if telemetry_persisted.get(&id) != Some(&snapshot) {
                                            if let Err(error) = persist_torrent_telemetry(
                                                &app_handle_poll.state::<crate::db::DbState>(),
                                                &id,
                                                snapshot,
                                            ) {
                                                log::debug!(
                                                    "aria2 telemetry [{}]: could not persist durable totals: {}",
                                                    id,
                                                    error
                                                );
                                            } else {
                                                telemetry_persisted.insert(id.clone(), snapshot);
                                            }
                                        }
                                    }
                                    let is_verifying = is_torrent
                                        && (verify_pending
                                            || (status == "active"
                                                && total > 0
                                                && completed >= total
                                                && verified_length.is_some_and(|value| value < total)));
                                    let entering_verifying = is_verifying && !observation.verifying;
                                    let leaving_verifying = !is_verifying && observation.verifying;
                                    observation.verifying = is_verifying;
                                    if relocation_checks.contains(&id)
                                        && leaving_verifying
                                        && matches!(status, "active" | "waiting")
                                        && poll_mgr.is_current_aria2_gid_mapping(gid, &mapping)
                                        && poll_mgr
                                            .is_aria2_control_epoch_current(&id, control_epoch)
                                            .await
                                    {
                                        if let Err(error) = persist_torrent_relocation_check(
                                            &app_handle_poll.state::<crate::db::DbState>(),
                                            &id,
                                            false,
                                        ) {
                                            log::debug!(
                                                "aria2 relocation check [{}]: could not clear one-shot marker: {}",
                                                id,
                                                error
                                            );
                                        } else {
                                            let _ = poll_mgr
                                                .clear_torrent_relocation_check(&id, control_epoch)
                                                .await;
                                            relocation_checks.remove(&id);
                                        }
                                    }
                                    if is_verification
                                        && leaving_verifying
                                        && total > 0
                                        && verified_length.is_some_and(|value| value >= total)
                                    {
                                        // A verification lifecycle is considered
                                        // observed only after Aria2 leaves its
                                        // pending/hash-check phase for this
                                        // same GID epoch. This evidence is used
                                        // by terminal reconciliation instead
                                        // of treating a bare complete event as
                                        // proof that data was verified.
                                        poll_mgr
                                            .record_torrent_verified_length(
                                                &id,
                                                control_epoch,
                                                total,
                                            )
                                            .await;
                                    }

                                    if entering_verifying {
                                        let _ = app_handle_poll.emit(
                                            "download-state",
                                            crate::ipc::DownloadStateEvent::new(
                                                &id,
                                                crate::ipc::DownloadStatus::Verifying,
                                            ),
                                        );
                                    } else if leaving_verifying && matches!(status, "active" | "waiting") {
                                        let _ = app_handle_poll.emit(
                                            "download-state",
                                            crate::ipc::DownloadStateEvent::new(
                                                &id,
                                                crate::ipc::DownloadStatus::Downloading,
                                            ),
                                        );
                                    }

                                    let fraction = if is_verifying {
                                        if total > 0 {
                                            (verified_length.unwrap_or(0).min(total) as f64 / total as f64)
                                                .clamp(0.0, 1.0)
                                        } else {
                                            0.0
                                        }
                                    } else if total > 0 {
                                        (completed.min(total) as f64 / total as f64).clamp(0.0, 1.0)
                                    } else {
                                        0.0
                                    };
                                    let speed = if is_verifying {
                                        "0 B/s".to_string()
                                    } else {
                                        crate::download::format_speed(speed_bytes)
                                    };
                                    let upload_speed = upload_speed_bytes.map(crate::download::format_speed);
                                    let eta = if !is_verifying && speed_bytes > 0.0 && total > completed {
                                        crate::download::format_duration((total - completed) as f64 / speed_bytes)
                                    } else {
                                        "-".to_string()
                                    };
                                    let size = if total > 0 {
                                        Some(crate::download::format_size(total as f64))
                                    } else {
                                        None
                                    };

                                    use tauri::Emitter;
                                    let _ = app_handle_poll.emit("download-progress", DownloadProgressEvent {
                                        id: id.clone(),
                                        fraction,
                                        speed,
                                        eta,
                                        size,
                                        size_is_final: false,
                                        downloaded_bytes: Some(completed as f64),
                                        total_bytes: (total > 0).then_some(total as f64),
                                        total_is_estimate: Some(false),
                                        active_connections: Some(active_connections),
                                        requested_connections: (!is_torrent).then_some(requested_connections),
                                        uploaded_bytes: torrent_telemetry
                                            .map(|value| value.uploaded_bytes as f64)
                                            .or_else(|| uploaded_bytes.map(|value| value as f64)),
                                        upload_speed,
                                        num_seeders,
                                        torrent_seeded_seconds: torrent_telemetry
                                            .map(|value| value.seeded_seconds as f64),
                                    });

                                    if entering_seeding
                                        && poll_mgr.aria2_torrent_seeding_requested(&id).await
                                    {
                                        poll_mgr
                                            .handle_aria2_event(
                                                &gid,
                                                crate::queue::PendingOutcome::Seeding,
                                            )
                                            .await;
                                    }

                                    if let Some(reason) = recovery_reason {
                                        log::warn!(
                                            "aria2 connection recovery [{}]: gid {} reason={} speed={}B/s active_connections={} requested_connections={}",
                                            id,
                                            gid,
                                            reason.as_str(),
                                            speed_bytes,
                                            active_connections,
                                            requested_connections
                                        );
                                        if let Err(error) = poll_mgr
                                            .refresh_aria2_connections(&id, gid, control_epoch)
                                            .await
                                        {
                                            log::warn!(
                                                "aria2 connection recovery [{}] for gid {} failed: {}",
                                                id,
                                                gid,
                                                error
                                            );
                                        }
                                    }
                                }
                            }

                            // A completion notification can be lost while the
                            // WebSocket is reconnecting. Completed GIDs also
                            // disappear from tellActive, so reconcile mapped
                            // GIDs that were not present in this active list.
                            // Paused and waiting downloads are intentionally
                            // left alone; only terminal statuses are applied.
                            for (gid, id) in poll_mgr.aria2_gid_mappings() {
                                if seen_gids.contains(&gid) {
                                    continue;
                                }
                                let status = match rpc_call(
                                    poll_port.load(std::sync::atomic::Ordering::Relaxed),
                                    &poll_secret,
                                    "aria2.tellStatus",
                                    serde_json::json!([gid, ["status", "seeder", "errorCode", "errorMessage"]]),
                                )
                                .await
                                {
                                    Ok(status) => status,
                                    Err(error) => {
                                        log::debug!(
                                            "aria2 poller reconciliation [{}]: could not query gid {}: {}",
                                            id,
                                            gid,
                                            error
                                        );
                                        let recovery_allowed = missing_gid_recovery_at
                                            .get(&id)
                                            .is_none_or(|last_attempt| {
                                                last_attempt.elapsed()
                                                    >= Duration::from_secs(5)
                                            });
                                        if crate::aria2_gid_not_found(&error)
                                            && recovery_allowed
                                            && poll_mgr.has_active_permit(&id).await
                                        {
                                            if let Some(mapping) = poll_mgr
                                                .aria2_gid_mapping(&gid)
                                                .filter(|mapping| mapping.id == id)
                                            {
                                                missing_gid_recovery_at
                                                    .insert(id.clone(), Instant::now());
                                                log::warn!(
                                                    "aria2 poller reconciliation [{}]: mapped gid {} is missing; attempting payload recovery",
                                                    id,
                                                    gid
                                                );
                                                match poll_mgr
                                                    .refresh_aria2_connections(
                                                        &id,
                                                        &gid,
                                                        mapping.epoch,
                                                    )
                                                    .await
                                                {
                                                    Ok(()) => {
                                                        missing_gid_recovery_at.remove(&id);
                                                    }
                                                    Err(recovery_error) => {
                                                        log::warn!(
                                                            "aria2 poller reconciliation [{}]: payload recovery for missing gid {} failed: {}",
                                                            id,
                                                            gid,
                                                            recovery_error
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                        continue;
                                    }
                                };
                                if let Some(mapping) = poll_mgr
                                    .aria2_gid_mapping(&gid)
                                    .filter(|mapping| mapping.id == id)
                                {
                                    let is_torrent = poll_mgr.aria2_is_torrent(&id).await;
                                    if is_torrent
                                        && poll_mgr
                                            .is_aria2_control_epoch_current(&id, mapping.epoch)
                                            .await
                                    {
                                        let upload_length = status
                                            .get("uploadLength")
                                            .and_then(|value| value.as_str())
                                            .and_then(|value| value.parse::<u64>().ok());
                                        let is_seeder = status.get("seeder").is_some_and(|value| {
                                            value.as_str() == Some("true")
                                                || value.as_bool() == Some(true)
                                        });
                                        let seed_permit_owned = poll_mgr
                                            .aria2_torrent_seed_permit_owned(&id)
                                            .await;
                                        let snapshot = poll_mgr
                                            .observe_torrent_telemetry(
                                                &id,
                                                &gid,
                                                mapping.epoch,
                                                upload_length,
                                                is_seeder && seed_permit_owned,
                                                Instant::now(),
                                            )
                                            .await;
                                        if poll_mgr.is_current_aria2_gid_mapping(&gid, &mapping)
                                            && poll_mgr
                                                .is_aria2_control_epoch_current(&id, mapping.epoch)
                                                .await
                                            && telemetry_persisted.get(&id) != Some(&snapshot)
                                        {
                                            if let Err(error) = persist_torrent_telemetry(
                                                &app_handle_poll.state::<crate::db::DbState>(),
                                                &id,
                                                snapshot,
                                            ) {
                                                log::debug!(
                                                    "aria2 terminal telemetry [{}]: could not persist durable totals: {}",
                                                    id,
                                                    error
                                                );
                                            } else {
                                                telemetry_persisted.insert(id.clone(), snapshot);
                                            }
                                        }
                                    }
                                }
                                let status_name = status
                                    .get("status")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("");
                                let outcome = match status_name {
                                    "complete" => Some(crate::queue::PendingOutcome::Complete),
                                    "active"
                                        if status.get("seeder").is_some_and(|value| {
                                            value.as_str() == Some("true")
                                                || value.as_bool() == Some(true)
                                        })
                                            && poll_mgr.aria2_torrent_seeding_requested(&id).await =>
                                    {
                                        Some(crate::queue::PendingOutcome::Seeding)
                                    }
                                    "error" | "removed" => {
                                        let error_code = status
                                            .get("errorCode")
                                            .and_then(|value| value.as_str())
                                            .filter(|value| !value.is_empty());
                                        let error_message = status
                                            .get("errorMessage")
                                            .and_then(|value| value.as_str())
                                            .filter(|value| !value.is_empty())
                                            .unwrap_or("aria2 download ended outside the active poll");
                                        Some(crate::queue::PendingOutcome::Error(match error_code {
                                            Some(code) => format!("aria2 error code {code}: {error_message}"),
                                            None => error_message.to_string(),
                                        }))
                                    }
                                    _ => None,
                                };
                                if let Some(outcome) = outcome {
                                    log::info!(
                                        "aria2 poller reconciliation [{}]: gid {} reported terminal status {} outside tellActive",
                                        id,
                                        gid,
                                        status_name
                                    );
                                    poll_mgr.handle_aria2_event(&gid, outcome).await;
                                }
                            }
                            observations.retain(|id, _| seen_ids.contains(id));
                        }
                    }
                }
            });


            let ext_app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Err(error) = extension_server::start_server(
                    ext_app_handle.clone(),
                    server_pairing_token.clone(),
                    server_frontend_ready.clone(),
                    server_extension_acks.clone(),
                    server_extension_port.clone(),
                    extension_server_shutdown_rx.clone(),
                ).await {
                    log::error!("Browser extension server unavailable: {error}");
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                }
            });
            Ok(())
        })
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    log_target,
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview)
                        .filter(|_| {
                            LOG_STREAM_ACTIVE.load(std::sync::atomic::Ordering::Acquire)
                        }),
                ])
                .level(if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info })
                .filter(|metadata| {
                    if LOG_PAUSED.load(std::sync::atomic::Ordering::Relaxed) {
                        return false;
                    }
                    let target = metadata.target();
                    !target.starts_with("webview::")
                        && !target.starts_with("hyper")
                        && !target.starts_with("reqwest")
                        && !target.starts_with("rustls")
                        && !target.starts_with("h2")
                        && !target.starts_with("tower")
                })
                .max_file_size(10_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .format(|out, message, record| {
                    let redacted = redact_log_line_for_output(&message.to_string());
                    out.finish(format_args!(
                        "[{}][{}][{}] {}",
                        chrono::Local::now().format("%Y-%m-%d][%H:%M:%S"),
                        record.level(),
                        record.target(),
                        redacted
                    ))
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| {
            if properties_window::is_properties_window_label(window.label()) {
                let resize = match event {
                    tauri::WindowEvent::Resized(size) => {
                        window.scale_factor().ok().map(|scale_factor| {
                            (size.width, size.height, scale_factor)
                        })
                    }
                    tauri::WindowEvent::ScaleFactorChanged {
                        scale_factor,
                        new_inner_size,
                        ..
                    } => Some((new_inner_size.width, new_inner_size.height, *scale_factor)),
                    tauri::WindowEvent::CloseRequested { .. } => window
                        .inner_size()
                        .ok()
                        .and_then(|size| {
                            window
                                .scale_factor()
                                .ok()
                                .map(|scale_factor| (size.width, size.height, scale_factor))
                        }),
                    _ => None,
                };
                if let Some((width, height, scale_factor)) = resize {
                    if let Some(registry) = window
                        .app_handle()
                        .try_state::<properties_window::PropertiesWindowRegistry>()
                    {
                        let _ = registry.remember_size(
                            window.label(),
                            width,
                            height,
                            scale_factor,
                        );
                    }
                }
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    if let Some(registry) = window.app_handle().try_state::<properties_window::PropertiesWindowRegistry>() {
                        let _ = registry.remove_window(window.label());
                    }
                    let _ = window
                        .app_handle()
                        .emit_to("main", "properties-window-closed", window.label().to_string());
                }
            }
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
.invoke_handler(tauri::generate_handler![
 get_engine_status, get_aria2_engine_status, get_ytdlp_engine_status, get_ffmpeg_engine_status,
 get_deno_engine_status, test_ytdlp, test_aria2c, test_ffmpeg, test_deno,
 pause_download, resume_download, fetch_metadata, inspect_torrent, rekey_torrent_metadata, remove_torrent_metadata, fetch_media_metadata, fetch_media_playlist_metadata,
            begin_dock_badge_session, update_dock_badge, get_platform_info, approve_download_root, set_prevent_sleep, set_power_preferences, get_free_space, perform_system_action,
            ack_schedule_trigger,
            check_automation_permission, request_automation_permission, open_automation_settings,
            set_keychain_password, get_keychain_password, delete_keychain_password,
            save_site_login, delete_site_login,
            hydrate_extension_pairing_token, get_session_pairing_token, regenerate_pairing_token, grant_keychain_access,
            get_keychain_grant_status, accept_keychain_grant, abandon_keychain_grant,
            authorize_keychain_access,
            acknowledge_pairing_token_change,
            check_file_exists, toggle_tray_icon, set_extension_pairing_token,
            get_extension_server_port, set_extension_frontend_ready, ack_extension_download, set_concurrent_limit, set_queue_concurrency_limits, set_download_speed_limit, set_torrent_upload_limit, set_torrent_peer_options, get_torrent_peers, get_torrent_availability, get_torrent_file_progress, get_torrent_piece_progress, get_torrent_file_selection, set_torrent_file_selection, get_torrent_details, get_torrent_magnet_link, export_torrent_metadata, move_torrent_data, cancel_torrent_move_data, verify_torrent_data, get_torrent_web_seeds, set_torrent_web_seeds, set_torrent_max_open_files, set_torrent_overall_upload_limit, set_global_speed_limit, remove_download, get_download_primary_path,
            detach_download_for_reconfigure,
            enqueue_download, enqueue_many, cancel_enqueue_generation, move_in_queue, move_many_in_queue, remove_from_queue, get_pending_order,
            commands::reveal_in_file_manager, commands::open_downloaded_file,
            properties_window::open_download_properties_window,
            properties_window::get_properties_window_download_id,
            properties_window::properties_window_send_ready,
            properties_window::properties_window_reveal,
            properties_window::properties_window_send_action,
            properties_window::validate_properties_window_request,
            properties_window::close_download_properties_window,
            properties_window::properties_window_registry_remove_for_download,
            parity::get_system_proxy, parity::get_file_category, parity::check_for_updates, parity::is_supported_media, parity::get_supported_media_domains,
            parity::create_category_directories,
            db_save_settings, db_load_settings, db_get_all_downloads, db_replace_downloads,
            clear_torrent_removal_paths, reconcile_torrent_removal_reservations,
            db_get_all_queues, db_replace_queues,
            read_logs, export_logs, toggle_log_pause, is_log_paused, clear_logs,
            set_log_stream_active
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                let paths = collect_opened_torrent_paths(
                    urls.into_iter().map(|url| url.to_string()),
                );
                dispatch_opened_torrent_paths(app_handle.clone(), paths);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => {
                if !has_visible_windows {
                    restore_main_window(app_handle);
                }
            }
            tauri::RunEvent::ExitRequested { .. } => {
                let state = app_handle.state::<AppState>();
                let _ = state.extension_server_shutdown.send(true);
            }
            _ => {}
        });
}
mod db;
mod extension_server;
mod scheduler;

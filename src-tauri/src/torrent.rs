use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use tauri::Manager;
use tokio::io::AsyncReadExt;

use crate::ipc::{TorrentFile, TorrentMetadata};

pub const MAX_TORRENT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ParsedTorrent {
    pub name: String,
    pub total_bytes: u64,
    pub files: Vec<TorrentFile>,
    pub info_hash: String,
    /// URL-list entries from the torrent metainfo. These are validated again
    /// at enqueue time because Aria2 consumes the original torrent bytes.
    pub web_seeds: Vec<String>,
}

#[derive(Debug, Clone)]
enum BencodeValue {
    Integer(i64),
    Bytes(Vec<u8>),
    List(Vec<BencodeValue>),
    Dict(BTreeMap<Vec<u8>, BencodeValue>),
}

struct Parser<'a> {
    input: &'a [u8],
    position: usize,
    depth: usize,
}

impl<'a> Parser<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self { input, position: 0, depth: 0 }
    }

    fn parse(mut self) -> Result<BencodeValue, String> {
        let value = self.parse_value()?;
        if self.position != self.input.len() {
            return Err("torrent metadata has trailing data".to_string());
        }
        Ok(value)
    }

    fn parse_value(&mut self) -> Result<BencodeValue, String> {
        if self.depth >= 128 {
            return Err("torrent metadata nesting is too deep".to_string());
        }
        let byte = *self
            .input
            .get(self.position)
            .ok_or_else(|| "torrent metadata is truncated".to_string())?;
        match byte {
            b'i' => self.parse_integer(),
            b'l' => self.parse_list(),
            b'd' => self.parse_dict(),
            b'0'..=b'9' => self.parse_bytes(),
            _ => Err("torrent metadata contains an invalid bencode value".to_string()),
        }
    }

    fn parse_integer(&mut self) -> Result<BencodeValue, String> {
        self.position += 1;
        let start = self.position;
        while let Some(byte) = self.input.get(self.position) {
            if *byte == b'e' {
                break;
            }
            self.position += 1;
        }
        if self.input.get(self.position) != Some(&b'e') {
            return Err("torrent integer is truncated".to_string());
        }
        let raw = std::str::from_utf8(&self.input[start..self.position])
            .map_err(|_| "torrent integer is not valid UTF-8".to_string())?;
        if raw.is_empty() || (raw.starts_with('0') && raw.len() > 1) || raw == "-0" {
            return Err("torrent integer has invalid encoding".to_string());
        }
        let value = raw
            .parse::<i64>()
            .map_err(|_| "torrent integer is outside the supported range".to_string())?;
        self.position += 1;
        Ok(BencodeValue::Integer(value))
    }

    fn parse_bytes(&mut self) -> Result<BencodeValue, String> {
        let start = self.position;
        while let Some(byte) = self.input.get(self.position) {
            if *byte == b':' {
                break;
            }
            if !byte.is_ascii_digit() {
                return Err("torrent byte string has an invalid length".to_string());
            }
            self.position += 1;
        }
        if self.input.get(self.position) != Some(&b':') {
            return Err("torrent byte string is truncated".to_string());
        }
        let length = std::str::from_utf8(&self.input[start..self.position])
            .map_err(|_| "torrent byte string length is invalid".to_string())?
            .to_owned();
        if (length.starts_with('0') && length.len() > 1) || length.is_empty() {
            return Err("torrent byte string has invalid length encoding".to_string());
        }
        let length = length
            .parse::<usize>()
            .map_err(|_| "torrent byte string length is too large".to_string())?;
        self.position += 1;
        let end = self
            .position
            .checked_add(length)
            .ok_or_else(|| "torrent byte string length overflowed".to_string())?;
        if end > self.input.len() {
            return Err("torrent byte string is truncated".to_string());
        }
        let value = self.input[self.position..end].to_vec();
        self.position = end;
        Ok(BencodeValue::Bytes(value))
    }

    fn parse_list(&mut self) -> Result<BencodeValue, String> {
        self.position += 1;
        self.depth += 1;
        let mut values = Vec::new();
        while self.input.get(self.position) != Some(&b'e') {
            if self.input.get(self.position).is_none() {
                self.depth -= 1;
                return Err("torrent list is truncated".to_string());
            }
            values.push(self.parse_value()?);
        }
        self.position += 1;
        self.depth -= 1;
        Ok(BencodeValue::List(values))
    }

    fn parse_dict(&mut self) -> Result<BencodeValue, String> {
        self.position += 1;
        self.depth += 1;
        let mut values = BTreeMap::new();
        let mut previous_key: Option<Vec<u8>> = None;
        while self.input.get(self.position) != Some(&b'e') {
            if self.input.get(self.position).is_none() {
                self.depth -= 1;
                return Err("torrent dictionary is truncated".to_string());
            }
            let key = match self.parse_bytes()? {
                BencodeValue::Bytes(key) => key,
                _ => unreachable!(),
            };
            if previous_key.as_ref().is_some_and(|previous| previous >= &key) {
                self.depth -= 1;
                return Err("torrent dictionary keys are not sorted".to_string());
            }
            previous_key = Some(key.clone());
            values.insert(key, self.parse_value()?);
        }
        self.position += 1;
        self.depth -= 1;
        Ok(BencodeValue::Dict(values))
    }
}

fn encode(value: &BencodeValue, output: &mut Vec<u8>) {
    match value {
        BencodeValue::Integer(value) => output.extend_from_slice(format!("i{value}e").as_bytes()),
        BencodeValue::Bytes(value) => {
            output.extend_from_slice(value.len().to_string().as_bytes());
            output.push(b':');
            output.extend_from_slice(value);
        }
        BencodeValue::List(values) => {
            output.push(b'l');
            for value in values {
                encode(value, output);
            }
            output.push(b'e');
        }
        BencodeValue::Dict(values) => {
            output.push(b'd');
            for (key, value) in values {
                encode(&BencodeValue::Bytes(key.clone()), output);
                encode(value, output);
            }
            output.push(b'e');
        }
    }
}

fn bytes_text(value: Option<&BencodeValue>, field: &str) -> Result<String, String> {
    let bytes = match value {
        Some(BencodeValue::Bytes(bytes)) => bytes,
        _ => return Err(format!("torrent metadata is missing {field}")),
    };
    String::from_utf8(bytes.clone()).map_err(|_| format!("torrent {field} is not valid UTF-8"))
}

fn positive_length(value: Option<&BencodeValue>, field: &str) -> Result<u64, String> {
    match value {
        Some(BencodeValue::Integer(value)) if *value >= 0 => Ok(*value as u64),
        _ => Err(format!("torrent {field} is invalid")),
    }
}

fn safe_path_component(value: &str, field: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value == "." || value == ".." || value.contains(['/', '\\', '\0']) {
        return Err(format!("torrent {field} contains an unsafe path"));
    }
    Ok(crate::download_ownership::canonical_download_filename(value))
}

fn parse_info(info: &BencodeValue) -> Result<ParsedTorrent, String> {
    let info_dict = match info {
        BencodeValue::Dict(value) => value,
        _ => return Err("torrent info dictionary is invalid".to_string()),
    };
    let name = info_dict
        .get(b"name.utf-8".as_slice())
        .or_else(|| info_dict.get(b"name".as_slice()))
        .map(|value| bytes_text(Some(value), "name"))
        .transpose()?
        .ok_or_else(|| "torrent metadata is missing name".to_string())?;
    let name = crate::download_ownership::canonical_download_filename(&safe_path_component(&name, "name")?);

    let mut files = Vec::new();
    let total_bytes = if let Some(files_value) = info_dict.get(b"files".as_slice()) {
        let entries = match files_value {
            BencodeValue::List(entries) => entries,
            _ => return Err("torrent files field is invalid".to_string()),
        };
        let mut total = 0u64;
        let mut paths = HashSet::new();
        for (position, entry) in entries.iter().enumerate() {
            let entry = match entry {
                BencodeValue::Dict(value) => value,
                _ => return Err(format!("torrent file entry {} is invalid", position + 1)),
            };
            let path_value = entry
                .get(b"path.utf-8".as_slice())
                .or_else(|| entry.get(b"path".as_slice()))
                .ok_or_else(|| format!("torrent file entry {} has no path", position + 1))?;
            let path_parts = match path_value {
                BencodeValue::List(parts) => parts
                    .iter()
                    .map(|part| bytes_text(Some(part), "file path"))
                    .collect::<Result<Vec<_>, _>>()?,
                _ => return Err(format!("torrent file entry {} path is invalid", position + 1)),
            };
            if path_parts.is_empty() {
                return Err(format!("torrent file entry {} path is empty", position + 1));
            }
            let path = path_parts
                .iter()
                .map(|part| safe_path_component(part, "file path"))
                .collect::<Result<Vec<_>, _>>()?
                .join("/");
            if !paths.insert(path.clone()) {
                return Err("torrent contains duplicate output paths".to_string());
            }
            let length = positive_length(entry.get(b"length".as_slice()), "file length")?;
            total = total
                .checked_add(length)
                .ok_or_else(|| "torrent total size is too large".to_string())?;
            files.push(TorrentFile {
                index: (position + 1) as u32,
                path,
                length,
            });
        }
        if files.is_empty() {
            return Err("torrent has no files".to_string());
        }
        total
    } else {
        let length = positive_length(info_dict.get(b"length".as_slice()), "length")?;
        files.push(TorrentFile {
            index: 1,
            path: name.clone(),
            length,
        });
        length
    };

    let mut encoded = Vec::new();
    encode(info, &mut encoded);
    let digest = Sha1::digest(encoded);
    let info_hash = digest.iter().map(|byte| format!("{byte:02x}")).collect();

    Ok(ParsedTorrent { name, total_bytes, files, info_hash, web_seeds: Vec::new() })
}

fn canonical_btih(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() == 40 && normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Some(normalized);
    }
    if normalized.len() != 32 {
        return None;
    }

    let mut decoded = Vec::with_capacity(20);
    let mut accumulator = 0u64;
    let mut bits = 0u8;
    for byte in normalized.bytes() {
        let value = match byte {
            b'a'..=b'z' => byte - b'a',
            b'2'..=b'7' => byte - b'2' + 26,
            _ => return None,
        } as u64;
        accumulator = (accumulator << 5) | value;
        bits += 5;
        while bits >= 8 {
            bits -= 8;
            decoded.push(((accumulator >> bits) & 0xff) as u8);
        }
        if bits == 0 {
            accumulator = 0;
        } else {
            accumulator &= (1u64 << bits) - 1;
        }
    }
    if bits != 0 || decoded.len() != 20 {
        return None;
    }

    Some(decoded.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn canonical_info_hash(value: &str) -> Option<String> {
    canonical_btih(value)
}

pub fn validate_info_hash(expected: Option<&str>, actual: &str) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let expected = canonical_btih(expected)
        .ok_or_else(|| "torrent metadata has an invalid expected info hash".to_string())?;
    if expected != actual {
        return Err("torrent metadata changed before it was queued".to_string());
    }
    Ok(())
}

pub fn parse_torrent_bytes(bytes: &[u8]) -> Result<ParsedTorrent, String> {
    if bytes.is_empty() || bytes.len() > MAX_TORRENT_BYTES {
        return Err(format!("torrent metadata must be between 1 byte and {MAX_TORRENT_BYTES} bytes"));
    }
    let root = Parser::new(bytes).parse()?;
    let root = match root {
        BencodeValue::Dict(value) => value,
        _ => return Err("torrent root is not a dictionary".to_string()),
    };
    let info = root
        .get(b"info".as_slice())
        .ok_or_else(|| "torrent metadata is missing info".to_string())?;
    let web_seeds = parse_torrent_web_seeds(root.get(b"url-list".as_slice()))?;
    let mut parsed = parse_info(info)?;
    parsed.web_seeds = web_seeds;
    Ok(parsed)
}

/// Remove the untrusted metainfo URL-list before handing a torrent to Aria2.
/// The info dictionary, and therefore the info hash, remains unchanged. The
/// caller can pass the parsed seeds back through the explicit web-seed policy
/// and add only the destinations that were accepted there.
pub fn sanitize_torrent_bytes_for_aria2(bytes: &[u8]) -> Result<(Vec<u8>, Vec<String>), String> {
    if bytes.is_empty() || bytes.len() > MAX_TORRENT_BYTES {
        return Err(format!(
            "torrent metadata must be between 1 byte and {MAX_TORRENT_BYTES} bytes"
        ));
    }
    let root = match Parser::new(bytes).parse()? {
        BencodeValue::Dict(value) => value,
        _ => return Err("torrent root is not a dictionary".to_string()),
    };
    let web_seeds = parse_torrent_web_seeds(root.get(b"url-list".as_slice()))?;
    let mut sanitized = root;
    sanitized.remove(b"url-list".as_slice());
    let mut encoded = Vec::with_capacity(bytes.len());
    encode(&BencodeValue::Dict(sanitized), &mut encoded);
    Ok((encoded, web_seeds))
}

fn bounded_optional_text(value: Option<&BencodeValue>, limit: usize) -> Option<String> {
    let BencodeValue::Bytes(bytes) = value? else {
        return None;
    };
    if bytes.len() > limit {
        return None;
    }
    String::from_utf8(bytes.clone())
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn bounded_uri(value: &str, schemes: &[&str]) -> Option<String> {
    if value.len() > 2_048 || value.chars().any(char::is_control) {
        return None;
    }
    let parsed = url::Url::parse(value).ok()?;
    if !schemes.contains(&parsed.scheme())
        || parsed.host_str().is_none_or(str::is_empty)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(parsed.to_string())
}

fn collect_torrent_uris(value: Option<&BencodeValue>, schemes: &[&str]) -> Vec<String> {
    let mut values = Vec::new();
    let mut append = |value: &BencodeValue| {
        if let BencodeValue::Bytes(bytes) = value {
            if let Ok(value) = String::from_utf8(bytes.clone()) {
                if let Some(uri) = bounded_uri(value.trim(), schemes) {
                    if !values.contains(&uri) && values.len() < 256 {
                        values.push(uri);
                    }
                }
            }
        }
    };
    match value {
        Some(BencodeValue::Bytes(_)) => append(value.unwrap()),
        Some(BencodeValue::List(entries)) => {
            for entry in entries {
                append(entry);
            }
        }
        _ => {}
    }
    values
}

fn torrent_tracker_uri_is_safe(value: &BencodeValue) -> bool {
    let BencodeValue::Bytes(bytes) = value else {
        return false;
    };
    let Ok(value) = String::from_utf8(bytes.clone()) else {
        return false;
    };
    bounded_uri(value.trim(), &["http", "https", "udp"]).is_some()
}

fn torrent_tracker_metadata_is_safe(root: &BTreeMap<Vec<u8>, BencodeValue>) -> bool {
    let mut tracker_count = 0usize;
    let mut count_tracker = |value: &BencodeValue| {
        tracker_count = tracker_count.saturating_add(1);
        tracker_count <= 256 && torrent_tracker_uri_is_safe(value)
    };

    if let Some(announce) = root.get(b"announce".as_slice()) {
        if !count_tracker(announce) {
            return false;
        }
    }

    let Some(announce_list) = root.get(b"announce-list".as_slice()) else {
        return true;
    };
    let BencodeValue::List(tiers) = announce_list else {
        return false;
    };
    for tier in tiers {
        let BencodeValue::List(trackers) = tier else {
            return false;
        };
        for tracker in trackers {
            if !count_tracker(tracker) {
                return false;
            }
        }
    }
    true
}

fn parse_torrent_web_seeds(value: Option<&BencodeValue>) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let entries = match value {
        BencodeValue::Bytes(_) => std::slice::from_ref(value),
        BencodeValue::List(entries) => entries.as_slice(),
        _ => return Err("torrent url-list field is invalid".to_string()),
    };
    if entries.len() > 256 {
        return Err("torrent url-list contains too many web seeds".to_string());
    }
    let mut normalized = Vec::with_capacity(entries.len());
    for entry in entries {
        let BencodeValue::Bytes(bytes) = entry else {
            return Err("torrent url-list contains a non-text web seed".to_string());
        };
        let value = String::from_utf8(bytes.clone())
            .map_err(|_| "torrent url-list contains invalid UTF-8".to_string())?;
        let value = value.trim();
        let uri = bounded_uri(value, &["http", "https"])
            .ok_or_else(|| "torrent url-list contains an invalid HTTP(S) web seed".to_string())?;
        if !normalized.contains(&uri) {
            normalized.push(uri);
        }
    }
    Ok(normalized)
}

pub fn torrent_details_from_bytes(bytes: &[u8]) -> Result<crate::ipc::TorrentDetails, String> {
    if bytes.is_empty() || bytes.len() > MAX_TORRENT_BYTES {
        return Err(format!(
            "torrent metadata must be between 1 byte and {MAX_TORRENT_BYTES} bytes"
        ));
    }
    let root = match Parser::new(bytes).parse()? {
        BencodeValue::Dict(value) => value,
        _ => return Err("torrent root is not a dictionary".to_string()),
    };
    let info = root
        .get(b"info".as_slice())
        .ok_or_else(|| "torrent metadata is missing info".to_string())?;
    let parsed = parse_info(info)?;
    let web_seeds = parse_torrent_web_seeds(root.get(b"url-list".as_slice()))?;
    let info_dict = match info {
        BencodeValue::Dict(value) => value,
        _ => return Err("torrent info dictionary is invalid".to_string()),
    };
    let piece_length = positive_length(info_dict.get(b"piece length".as_slice()), "piece length")?;
    let piece_count = match info_dict.get(b"pieces".as_slice()) {
        Some(BencodeValue::Bytes(pieces)) if pieces.len() % 20 == 0 => (pieces.len() / 20) as u64,
        _ => return Err("torrent pieces field is invalid".to_string()),
    };
    let creation_date = root
        .get(b"creation date".as_slice())
        .and_then(|value| match value {
            BencodeValue::Integer(value) if *value >= 0 => chrono::DateTime::<chrono::Utc>::from_timestamp(*value, 0)
                .map(|date| date.to_rfc3339()),
            _ => None,
        });
    let trackers = collect_torrent_uris(root.get(b"announce".as_slice()), &["http", "https", "udp"])
        .into_iter()
        .chain(root.get(b"announce-list".as_slice()).into_iter().flat_map(|value| {
            let mut trackers = Vec::new();
            if let BencodeValue::List(tiers) = value {
                for tier in tiers {
                    if let BencodeValue::List(entries) = tier {
                        for entry in entries {
                            trackers.extend(collect_torrent_uris(Some(entry), &["http", "https", "udp"]));
                        }
                    }
                }
            }
            trackers
        }))
        .fold(Vec::new(), |mut result, tracker| {
            if !result.contains(&tracker) && result.len() < 256 {
                result.push(tracker);
            }
            result
        });
    Ok(crate::ipc::TorrentDetails {
        info_hash: parsed.info_hash,
        display_name: parsed.name,
        total_bytes: parsed.total_bytes,
        file_count: parsed.files.len() as u32,
        piece_length,
        piece_count,
        private: matches!(info_dict.get(b"private".as_slice()), Some(BencodeValue::Integer(1))),
        creation_date,
        creator: bounded_optional_text(
            root.get(b"created by.utf-8".as_slice()).or_else(|| root.get(b"created by".as_slice())),
            256,
        ),
        comment: bounded_optional_text(
            root.get(b"comment.utf-8".as_slice()).or_else(|| root.get(b"comment".as_slice())),
            4_096,
        ),
        trackers,
        web_seeds,
    })
}

/// Return whether validated metainfo may be reused for a Magnet identified by
/// its info hash. Tracker lists are safe to retain because they are peer
/// discovery metadata, while direct web-seed/source fields are deliberately
/// excluded so a later Magnet cannot inherit arbitrary HTTP resources.
pub fn torrent_metadata_is_safe_for_magnet_reuse(bytes: &[u8]) -> Result<bool, String> {
    if bytes.is_empty() || bytes.len() > MAX_TORRENT_BYTES {
        return Err(format!(
            "torrent metadata must be between 1 byte and {MAX_TORRENT_BYTES} bytes"
        ));
    }
    let root = Parser::new(bytes).parse()?;
    let root = match root {
        BencodeValue::Dict(value) => value,
        _ => return Err("torrent root is not a dictionary".to_string()),
    };
    let info = root
        .get(b"info".as_slice())
        .ok_or_else(|| "torrent metadata is missing info".to_string())?;
    parse_info(info)?;
    if !torrent_tracker_metadata_is_safe(&root) {
        return Ok(false);
    }

    Ok(root.keys().all(|key| {
        matches!(
            key.as_slice(),
            b"info"
                | b"announce"
                | b"announce-list"
                | b"comment"
                | b"comment.utf-8"
                | b"created by"
                | b"created by.utf-8"
                | b"creation date"
                | b"encoding"
                | b"publisher"
                | b"publisher-url"
                | b"publisher-url.utf-8"
        )
    }))
}

fn magnet_metadata(source: &str) -> Result<ParsedTorrent, String> {
    let parsed = url::Url::parse(source).map_err(|_| "invalid magnet URI".to_string())?;
    if parsed.scheme() != "magnet" {
        return Err("unsupported torrent source".to_string());
    }
    let info_hash = parsed
        .query_pairs()
        .find_map(|(key, value)| {
            if key != "xt" {
                return None;
            }
            let value = value.strip_prefix("urn:btih:")?;
            canonical_btih(value)
        })
        .ok_or_else(|| "magnet URI has no valid BitTorrent info hash".to_string())?;
    let name = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "dn").then_some(value.into_owned()))
        .filter(|value| !value.trim().is_empty())
        .map(|value| crate::download_ownership::canonical_download_filename(&value))
        .unwrap_or_else(|| format!("torrent-{info_hash}"));
    Ok(ParsedTorrent { name, total_bytes: 0, files: Vec::new(), info_hash, web_seeds: Vec::new() })
}

/// Return the Magnet URI form that Firelink may hand to Aria2. Direct source
/// parameters can make Aria2 fetch arbitrary HTTP/FTP/SFTP resources during
/// metadata resolution, so keep the peer/tracker identity parameters but
/// remove `ws`, `as`, and `xs` sources. Users can add validated web seeds after
/// metadata is available through the transactional per-file path.
pub fn sanitize_magnet_uri_for_aria2(source: &str) -> Result<String, String> {
    let mut parsed = url::Url::parse(source.trim()).map_err(|_| "invalid magnet URI".to_string())?;
    if parsed.scheme() != "magnet"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || parsed.host_str().is_some()
        || parsed.port().is_some()
    {
        return Err("magnet URI contains an invalid authority or fragment".to_string());
    }

    let mut has_info_hash = false;
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in parsed.query_pairs() {
        if matches!(key.as_ref(), "ws" | "as" | "xs") {
            continue;
        }
        if key == "xt" {
            let hash = value
                .strip_prefix("urn:btih:")
                .and_then(canonical_btih)
                .ok_or_else(|| "magnet URI has no valid BitTorrent info hash".to_string())?;
            query.append_pair("xt", &format!("urn:btih:{hash}"));
            has_info_hash = true;
        } else {
            query.append_pair(&key, &value);
        }
    }
    if !has_info_hash {
        return Err("magnet URI has no valid BitTorrent info hash".to_string());
    }
    let query = query.finish();
    parsed.set_query(Some(&query));
    Ok(parsed.to_string())
}

pub fn magnet_allows_cached_metadata(source: &str) -> bool {
    let Ok(parsed) = url::Url::parse(source.trim()) else {
        return false;
    };
    if parsed.scheme() != "magnet" {
        return false;
    }

    let mut has_info_hash = false;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "xt" => {
                let Some(info_hash) = value.strip_prefix("urn:btih:") else {
                    return false;
                };
                if canonical_btih(info_hash).is_none() {
                    return false;
                }
                has_info_hash = true;
            }
            "dn" | "tr" => {}
            _ => return false,
        }
    }
    has_info_hash
}

fn local_torrent_path(source: &str) -> Result<PathBuf, String> {
    let path = match url::Url::parse(source) {
        Ok(parsed) if parsed.scheme() == "file" => parsed
            .to_file_path()
            .map_err(|_| "invalid local torrent path".to_string())?,
        _ => PathBuf::from(source),
    };
    if !path.is_absolute() {
        return Err("torrent source is not an absolute local file".to_string());
    }
    let path = std::fs::canonicalize(&path)
        .map_err(|error| format!("could not resolve torrent file: {error}"))?;
    if path.extension().and_then(|extension| extension.to_str()).map(|extension| extension.eq_ignore_ascii_case("torrent")) != Some(true) {
        return Err("torrent files must use the .torrent extension".to_string());
    }
    Ok(path)
}

pub fn inspect_source(source: &str) -> Result<ParsedTorrent, String> {
    if source.trim_start().to_ascii_lowercase().starts_with("magnet:") {
        return magnet_metadata(source.trim());
    }
    let path = local_torrent_path(source)?;
    let bytes = std::fs::read(&path).map_err(|error| format!("could not read torrent file: {error}"))?;
    parse_torrent_bytes(&bytes)
}

/// Remote torrent metadata is fetched and cached before enqueue so it follows
/// the same validated `addTorrent`, ownership, retry, and restart path as
/// local metadata and magnets.
pub fn is_remote_torrent_url(source: &str) -> bool {
    let Ok(parsed) = url::Url::parse(source.trim()) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https")
        && parsed
            .path_segments()
            .and_then(|segments| segments.last())
            .is_some_and(|name| name.to_ascii_lowercase().ends_with(".torrent"))
}

pub fn to_metadata(parsed: ParsedTorrent, torrent_path: Option<String>) -> TorrentMetadata {
    TorrentMetadata {
        name: parsed.name,
        total_bytes: parsed.total_bytes,
        files: parsed.files,
        info_hash: parsed.info_hash,
        torrent_path,
    }
}

/// Aria2's BitTorrent output is controlled by `index-out`, not `out`. Keep
/// these values derived from the validated, canonical paths so the daemon's
/// actual files stay aligned with Firelink's ownership registry.
pub fn validate_output_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name != name.trim()
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name.chars().any(|character| {
            character.is_control()
                || matches!(character, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*')
        })
        || crate::platform::is_windows_reserved_filename(name)
        || crate::download_ownership::canonical_download_filename(name) != name
    {
        return Err("Torrent output name is not a safe single path component".to_string());
    }
    Ok(())
}

pub fn aria2_index_outputs(parsed: &ParsedTorrent, output_name: &str) -> Vec<String> {
    parsed
        .files
        .iter()
        .map(|file| {
            let output = if parsed.files.len() == 1 {
                output_name.to_string()
            } else {
                format!("{output_name}/{}", file.path)
            };
            format!("{}={output}", file.index)
        })
        .collect()
}

pub fn aria2_output_paths(
    parsed: &ParsedTorrent,
    selected: Option<&[u32]>,
    output_name: &str,
) -> Vec<String> {
    parsed
        .files
        .iter()
        .filter(|file| selected.is_none_or(|indices| indices.contains(&file.index)))
        .map(|file| {
            if parsed.files.len() == 1 {
                output_name.to_string()
            } else {
                format!("{output_name}/{}", file.path)
            }
        })
        .collect()
}

pub fn managed_torrent_path<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    id: &str,
) -> Result<PathBuf, String> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("invalid torrent download id".to_string());
    }
    let root = managed_torrent_storage_root(app_handle)?;
    Ok(root.join(format!("{id}.torrent")))
}

pub fn managed_torrent_info_hash_path<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    info_hash: &str,
) -> Result<PathBuf, String> {
    let info_hash = canonical_btih(info_hash)
        .ok_or_else(|| "invalid torrent info hash cache key".to_string())?;
    let root = managed_torrent_storage_root(app_handle)?;
    Ok(root.join(format!(".info-{info_hash}.torrent")))
}

pub fn managed_torrent_storage_root<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    let root = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve torrent storage: {error}"))?
        .join("torrents");
    Ok(root)
}

pub fn remove_orphaned_probe_dirs<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
) -> Result<usize, String> {
    let root = managed_torrent_storage_root(app_handle)?;
    remove_orphaned_probe_dirs_at(&root)
}

fn remove_orphaned_probe_dirs_at(root: &Path) -> Result<usize, String> {
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("could not inspect torrent probe storage: {error}")),
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry.map_err(|error| format!("could not inspect torrent probe storage: {error}"))?;
        let is_probe = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(".probe-"));
        if !is_probe || !entry
            .file_type()
            .map_err(|error| format!("could not inspect torrent probe entry: {error}"))?
            .is_dir()
        {
            continue;
        }
        match std::fs::remove_dir_all(entry.path()) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("could not remove orphaned torrent probe: {error}")),
        }
    }
    Ok(removed)
}

pub fn remove_orphaned_cached_torrents<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    retained_ids: &HashSet<String>,
    retained_info_hashes: &HashSet<String>,
) -> Result<usize, String> {
    let root = managed_torrent_storage_root(app_handle)?;
    remove_orphaned_cached_torrents_at(&root, retained_ids, retained_info_hashes)
}

fn remove_orphaned_cached_torrents_at(
    root: &Path,
    retained_ids: &HashSet<String>,
    retained_info_hashes: &HashSet<String>,
) -> Result<usize, String> {
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("could not inspect torrent metadata storage: {error}")),
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("could not inspect torrent metadata storage: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("could not inspect torrent metadata entry: {error}"))?;
        let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            continue;
        };
        if file_type.is_file() && is_canonical_torrent_temp_file(&name) {
            match std::fs::remove_file(entry.path()) {
                Ok(()) => removed += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "could not remove orphaned torrent metadata temporary file: {error}"
                    ));
                }
            }
            continue;
        }
        if file_type.is_file() && name.starts_with(".info-") && name.ends_with(".torrent") {
            let retained = name
                .strip_prefix(".info-")
                .and_then(|name| name.strip_suffix(".torrent"))
                .and_then(canonical_btih)
                .is_some_and(|info_hash| {
                    name == format!(".info-{info_hash}.torrent")
                        && retained_info_hashes.contains(&info_hash)
                });
            if retained {
                continue;
            }
            match std::fs::remove_file(entry.path()) {
                Ok(()) => removed += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("could not remove orphaned torrent metadata: {error}"));
                }
            }
            continue;
        }
        if !file_type.is_file()
            || entry.path().extension().and_then(|ext| ext.to_str()) != Some("torrent")
        {
            continue;
        }
        let path = entry.path();
        let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if retained_ids.contains(id) {
            continue;
        }
        match std::fs::remove_file(path) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("could not remove orphaned torrent metadata: {error}"));
            }
        }
    }
    Ok(removed)
}

pub fn validate_selected_indices(
    selected: Option<&[u32]>,
    file_count: usize,
) -> Result<Option<Vec<u32>>, String> {
    let Some(selected) = selected else {
        return Ok(None);
    };
    if selected.is_empty() || selected.iter().any(|index| *index == 0 || *index as usize > file_count) {
        return Err("torrent file selection is invalid".to_string());
    }
    let mut normalized = selected.to_vec();
    normalized.sort_unstable();
    normalized.dedup();
    if normalized.len() == file_count {
        Ok(None)
    } else {
        Ok(Some(normalized))
    }
}

pub async fn prepare_local_torrent<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    source: &str,
    id: &str,
) -> Result<(ParsedTorrent, String), String> {
    let source_path = local_torrent_path(source)?;
    let file_metadata = tokio::fs::metadata(&source_path)
        .await
        .map_err(|error| format!("could not inspect torrent file: {error}"))?;
    if file_metadata.len() == 0 || file_metadata.len() > MAX_TORRENT_BYTES as u64 {
        return Err(format!(
            "torrent metadata must be between 1 byte and {MAX_TORRENT_BYTES} bytes"
        ));
    }
    let bytes = read_bounded_torrent_bytes(&source_path)
        .await
        .map_err(|error| format!("could not read torrent file: {error}"))?;
    let parsed = parse_torrent_bytes(&bytes)?;
    let destination = cache_torrent_bytes(app_handle, id, &bytes).await?;
    if let Err(error) = cache_torrent_info_hash(app_handle, &bytes).await {
        log::warn!("could not cache canonical torrent metadata: {error}");
    }
    Ok((parsed, destination))
}

pub async fn cache_torrent_bytes<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    id: &str,
    bytes: &[u8],
) -> Result<String, String> {
    if bytes.is_empty() || bytes.len() > MAX_TORRENT_BYTES {
        return Err(format!(
            "torrent metadata must be between 1 byte and {MAX_TORRENT_BYTES} bytes"
        ));
    }
    let destination = managed_torrent_path(app_handle, id)?;
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("could not create torrent storage: {error}"))?;
    }
    tokio::fs::write(&destination, bytes)
        .await
        .map_err(|error| format!("could not cache torrent metadata: {error}"))?;
    Ok(destination.to_string_lossy().to_string())
}

fn is_canonical_torrent_temp_file(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".cache-") else {
        return false;
    };
    let Some((info_hash, temporary_id)) = rest.split_once(".torrent.") else {
        return false;
    };
    let Some(temporary_id) = temporary_id.strip_suffix(".tmp") else {
        return false;
    };
    canonical_btih(info_hash).as_deref() == Some(info_hash)
        && temporary_id.len() == 32
        && temporary_id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

async fn read_bounded_torrent_bytes(path: &Path) -> std::io::Result<Vec<u8>> {
    let file = tokio::fs::File::open(path).await?;
    let mut bytes = Vec::with_capacity(std::cmp::min(MAX_TORRENT_BYTES, 64 * 1024));
    file.take((MAX_TORRENT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > MAX_TORRENT_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("torrent metadata exceeds {MAX_TORRENT_BYTES} bytes"),
        ));
    }
    Ok(bytes)
}

static CANONICAL_TORRENT_CACHE_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> =
    std::sync::OnceLock::new();

fn canonical_torrent_cache_lock() -> &'static tokio::sync::Mutex<()> {
    CANONICAL_TORRENT_CACHE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

async fn read_cached_torrent_by_info_hash_unlocked<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    info_hash: &str,
) -> Result<Option<Vec<u8>>, String> {
    let info_hash = canonical_btih(info_hash)
        .ok_or_else(|| "invalid torrent info hash cache key".to_string())?;
    let path = managed_torrent_info_hash_path(app_handle, &info_hash)?;
    let metadata = match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not inspect cached torrent metadata: {error}")),
    };
    if !metadata.file_type().is_file() && !metadata.file_type().is_symlink() {
        return Ok(None);
    }

    let validated_path = match validate_managed_torrent_info_hash_path(
        app_handle,
        &info_hash,
        &path.to_string_lossy(),
    ) {
        Ok(path) => path,
        Err(error) => {
            let _ = tokio::fs::remove_file(&path).await;
            log::warn!("discarding invalid cached torrent metadata: {error}");
            return Ok(None);
        }
    };
    let bytes = match read_bounded_torrent_bytes(&validated_path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
            let _ = tokio::fs::remove_file(&path).await;
            return Ok(None);
        }
        Err(error) => return Err(format!("could not read cached torrent metadata: {error}")),
    };
    let reusable = torrent_metadata_is_safe_for_magnet_reuse(&bytes).is_ok_and(|safe| safe);
    match parse_torrent_bytes(&bytes) {
        Ok(parsed) if reusable && parsed.info_hash == info_hash => {}
        Ok(_) | Err(_) => {
            let _ = tokio::fs::remove_file(&path).await;
            return Ok(None);
        }
    }
    Ok(Some(bytes))
}

pub async fn read_cached_torrent_by_info_hash<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    info_hash: &str,
) -> Result<Option<Vec<u8>>, String> {
    let _guard = canonical_torrent_cache_lock().lock().await;
    read_cached_torrent_by_info_hash_unlocked(app_handle, info_hash).await
}

pub async fn cache_torrent_info_hash<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    bytes: &[u8],
) -> Result<Option<String>, String> {
    let _guard = canonical_torrent_cache_lock().lock().await;
    let parsed = parse_torrent_bytes(bytes)?;
    if !torrent_metadata_is_safe_for_magnet_reuse(bytes)? {
        return Ok(None);
    }
    let info_hash = parsed.info_hash;
    let destination = managed_torrent_info_hash_path(app_handle, &info_hash)?;
    if read_cached_torrent_by_info_hash_unlocked(app_handle, &info_hash)
        .await?
        .is_some()
    {
        return Ok(Some(destination.to_string_lossy().to_string()));
    }

    let parent = destination
        .parent()
        .ok_or_else(|| "torrent storage has no parent directory".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("could not create torrent storage: {error}"))?;
    let temporary = parent.join(format!(
        ".cache-{info_hash}.torrent.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    if let Err(error) = tokio::fs::write(&temporary, bytes).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(format!("could not stage canonical torrent metadata: {error}"));
    }
    match tokio::fs::rename(&temporary, &destination).await {
        Ok(()) => Ok(Some(destination.to_string_lossy().to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = tokio::fs::remove_file(&temporary).await;
            if read_cached_torrent_by_info_hash_unlocked(app_handle, &info_hash)
                .await?
                .is_some()
            {
                Ok(Some(destination.to_string_lossy().to_string()))
            } else {
                Err("canonical torrent metadata already exists but is invalid".to_string())
            }
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary).await;
            Err(format!("could not commit canonical torrent metadata: {error}"))
        }
    }
}

pub fn validate_managed_torrent_path<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    id: &str,
    path: &str,
) -> Result<PathBuf, String> {
    let expected = managed_torrent_path(app_handle, id)?;
    validate_managed_torrent_path_against_expected(&expected, path)
}

pub fn validate_managed_torrent_info_hash_path<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    info_hash: &str,
    path: &str,
) -> Result<PathBuf, String> {
    let expected = managed_torrent_info_hash_path(app_handle, info_hash)?;
    validate_managed_torrent_path_against_expected(&expected, path)
}

fn validate_managed_torrent_path_against_expected(
    expected: &Path,
    path: &str,
) -> Result<PathBuf, String> {
    let candidate = std::fs::canonicalize(path)
        .map_err(|error| format!("could not access cached torrent metadata: {error}"))?;
    let expected_parent = expected
        .parent()
        .and_then(|parent| std::fs::canonicalize(parent).ok())
        .ok_or_else(|| "cached torrent storage is unavailable".to_string())?;
    if candidate.parent() != Some(expected_parent.as_path())
        || candidate.file_name() != expected.file_name()
    {
        return Err("cached torrent metadata path is invalid".to_string());
    }
    Ok(candidate)
}

pub async fn remove_managed_torrent<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    id: &str,
) {
    if let Ok(path) = managed_torrent_path(app_handle, id) {
        let _ = tokio::fs::remove_file(path).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_file_torrent_and_hashes_info_dictionary() {
        let parsed = parse_torrent_bytes(b"d4:infod6:lengthi5e4:name4:testee")
            .expect("single-file torrent should parse");
        assert_eq!(parsed.name, "test");
        assert_eq!(parsed.total_bytes, 5);
        assert_eq!(parsed.files[0].index, 1);
        assert_eq!(parsed.files[0].path, "test");
        assert_eq!(parsed.info_hash.len(), 40);
    }

    #[test]
    fn retains_only_strict_http_web_seeds_for_enqueue_policy_validation() {
        let parsed = parse_torrent_bytes(
            b"d4:infod6:lengthi5e4:name4:teste8:url-list22:https://example.test/ae",
        )
        .expect("torrent with an HTTP web seed should parse");
        assert_eq!(parsed.web_seeds, vec!["https://example.test/a"]);

        let credentials = parse_torrent_bytes(
            b"d4:infod6:lengthi5e4:name4:teste8:url-list32:https://user:pass@example.test/aee",
        );
        assert!(credentials.is_err());
    }

    #[test]
    fn sanitizing_torrent_web_seeds_preserves_the_info_hash() {
        let bytes = b"d4:infod6:lengthi5e4:name4:teste8:url-list22:https://example.test/ae";
        let original = parse_torrent_bytes(bytes).expect("torrent should parse");
        let (sanitized, web_seeds) = sanitize_torrent_bytes_for_aria2(bytes)
            .expect("torrent should be sanitized");
        let parsed = parse_torrent_bytes(&sanitized).expect("sanitized torrent should parse");

        assert_eq!(web_seeds, vec!["https://example.test/a"]);
        assert!(parsed.web_seeds.is_empty());
        assert_eq!(parsed.info_hash, original.info_hash);
    }

    #[test]
    fn magnet_sanitization_removes_direct_sources_but_preserves_identity() {
        let sanitized = sanitize_magnet_uri_for_aria2(
            "magnet:?xt=urn:btih:0123456789012345678901234567890123456789&dn=demo&tr=udp%3A%2F%2Ftracker.example%3A80&ws=https%3A%2F%2Flocal.example%2Ffile&as=https%3A%2F%2Fother.example%2Ffile",
        )
        .expect("magnet should sanitize");
        assert!(sanitized.contains("xt=urn%3Abtih%3A0123456789012345678901234567890123456789"));
        assert!(sanitized.contains("dn=demo"));
        assert!(sanitized.contains("tr=udp%3A%2F%2Ftracker.example%3A80"));
        assert!(!sanitized.contains("ws="));
        assert!(!sanitized.contains("as="));
    }

    #[test]
    fn validates_torrent_output_names_as_single_safe_components() {
        for name in ["test", "My Torrent (1)", "archive.tar"] {
            validate_output_name(name).expect("ordinary output names should be accepted");
        }
        for name in ["", " test", "test ", ".", "..", "a/b", "a\\b", "CON", "a?.bin"] {
            assert!(validate_output_name(name).is_err(), "{name:?}");
        }
    }

    #[test]
    fn exposes_bounded_torrent_details_from_metadata() {
        let mut bytes = b"d4:infod6:lengthi5e4:name4:test12:piece lengthi2e6:pieces20:".to_vec();
        bytes.extend([0_u8; 20]);
        bytes.extend_from_slice(b"ee");

        let details = torrent_details_from_bytes(&bytes).expect("details should parse");

        assert_eq!(details.display_name, "test");
        assert_eq!(details.total_bytes, 5);
        assert_eq!(details.file_count, 1);
        assert_eq!(details.piece_length, 2);
        assert_eq!(details.piece_count, 1);
        assert!(!details.private);
    }

    #[test]
    fn parses_multi_file_torrent_and_rejects_traversal() {
        let parsed = parse_torrent_bytes(
            b"d4:infod5:filesld6:lengthi2e4:pathl4:root5:a.txteed6:lengthi3e4:pathl4:root5:b.bineee4:name4:rootee",
        )
        .expect("multi-file torrent should parse");
        assert_eq!(parsed.total_bytes, 5);
        assert_eq!(parsed.files.len(), 2);
        assert_eq!(parsed.files[1].path, "root/b.bin");

        let error = parse_torrent_bytes(
            b"d4:infod5:filesld6:lengthi1e4:pathl2:..4:evileee4:name4:rootee",
        )
        .expect_err("path traversal must be rejected");
        assert!(error.contains("unsafe path"));
    }

    #[test]
    fn parses_magnet_identity_without_logging_or_persisting_tracker_data() {
        let parsed = inspect_source(
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Example%20Torrent&tr=https%3A%2F%2Ftracker.invalid%2Fsecret",
        )
        .expect("magnet should parse");
        assert_eq!(parsed.name, "Example Torrent");
        assert_eq!(parsed.info_hash, "0123456789abcdef0123456789abcdef01234567");
        assert!(parsed.files.is_empty());
    }

    #[test]
    fn magnet_reuse_rejects_web_seed_metadata_but_retains_tracker_metadata() {
        assert!(torrent_metadata_is_safe_for_magnet_reuse(
            b"d4:infod6:lengthi5e4:name4:testee"
        )
        .expect("plain torrent metadata should parse"));
        assert!(torrent_metadata_is_safe_for_magnet_reuse(
            b"d8:announce32:https://tracker.example/announce4:infod6:lengthi5e4:name4:testee"
        )
        .expect("tracker-bearing torrent metadata should parse"));
        assert!(torrent_metadata_is_safe_for_magnet_reuse(
            b"d13:announce-listll32:https://tracker.example/announceee4:infod6:lengthi5e4:name4:testee"
        )
        .expect("tracker-list-bearing torrent metadata should parse"));
        assert!(!torrent_metadata_is_safe_for_magnet_reuse(
            b"d8:announce30:ftp://tracker.example/announce4:infod6:lengthi5e4:name4:testee"
        )
        .expect("unsupported tracker metadata should parse"));
        assert!(!torrent_metadata_is_safe_for_magnet_reuse(
            b"d8:announce42:https://user:pass@tracker.example/announce4:infod6:lengthi5e4:name4:testee"
        )
        .expect("credential-bearing tracker metadata should parse"));
        assert!(!torrent_metadata_is_safe_for_magnet_reuse(
            b"d13:announce-listl1:xe4:infod6:lengthi5e4:name4:testee"
        )
        .expect("malformed tracker-list metadata should parse"));
        assert!(!torrent_metadata_is_safe_for_magnet_reuse(
            b"d4:infod6:lengthi5e4:name4:teste8:url-list1:xe"
        )
        .expect("web-seed-bearing torrent metadata should parse"));
    }

    #[test]
    fn canonical_cache_temporary_names_are_strictly_recognized() {
        assert!(is_canonical_torrent_temp_file(
            ".cache-0123456789abcdef0123456789abcdef01234567.torrent.0123456789abcdef0123456789abcdef.tmp"
        ));
        assert!(!is_canonical_torrent_temp_file(
            ".cache-orphan.torrent.temporary.tmp"
        ));
        assert!(!is_canonical_torrent_temp_file(
            ".cache-0123456789abcdef0123456789abcdef01234567.torrent.tmp"
        ));
    }

    #[tokio::test]
    async fn canonical_cache_round_trip_rejects_invalid_bytes_and_source_metadata() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let bytes = b"d4:infod6:lengthi5e4:name4:testee";
        let parsed = parse_torrent_bytes(bytes).expect("test torrent should parse");
        let path = managed_torrent_info_hash_path(app.handle(), &parsed.info_hash)
            .expect("canonical cache path should resolve");
        let _ = tokio::fs::remove_file(&path).await;

        assert!(
            cache_torrent_info_hash(app.handle(), bytes)
                .await
                .expect("canonical cache write should succeed")
                .is_some()
        );
        assert_eq!(
            read_cached_torrent_by_info_hash(app.handle(), &parsed.info_hash)
                .await
                .expect("canonical cache read should succeed"),
            Some(bytes.to_vec())
        );

        tokio::fs::write(&path, b"not a torrent")
            .await
            .expect("invalid cache fixture should be writable");
        assert!(
            read_cached_torrent_by_info_hash(app.handle(), &parsed.info_hash)
                .await
                .expect("invalid cache should be handled")
                .is_none()
        );
        assert!(!path.exists());

        let tracker_bytes = b"d8:announce32:https://tracker.example/announce4:infod6:lengthi5e4:name4:testee";
        let tracker_hash = parse_torrent_bytes(tracker_bytes)
            .expect("tracker-bearing torrent should parse")
            .info_hash;
        assert!(
            cache_torrent_info_hash(app.handle(), tracker_bytes)
                .await
                .expect("tracker metadata should be reusable")
                .is_some()
        );
        assert_eq!(
            read_cached_torrent_by_info_hash(app.handle(), &tracker_hash)
                .await
                .expect("tracker cache should be readable"),
            Some(tracker_bytes.to_vec())
        );
        assert!(
            cache_torrent_info_hash(
                app.handle(),
                b"d4:infod6:lengthi5e4:name4:teste8:url-list22:https://example.test/ae"
            )
            .await
            .expect("web-seed metadata should be handled")
            .is_none()
        );
    }

    #[test]
    fn canonicalizes_base32_magnet_hashes_to_hex() {
        let parsed = inspect_source(
            "magnet:?xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH&dn=Base32",
        )
        .expect("a valid Base32 hash should parse");
        assert_eq!(parsed.info_hash, "0123456789abcdef0123456789abcdef01234567");
    }

    #[test]
    fn validates_expected_hashes_across_hex_and_base32_encodings() {
        validate_info_hash(
            Some("AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH"),
            "0123456789abcdef0123456789abcdef01234567",
        )
        .expect("equivalent Base32 and hexadecimal hashes should match");
        assert!(validate_info_hash(
            Some("0123456789abcdef0123456789abcdef01234567"),
            "fedcba9876543210fedcba9876543210fedcba98",
        )
        .is_err());
        validate_info_hash(None, "not-used").expect("missing legacy identity should remain compatible");
        assert_eq!(
            canonical_info_hash("AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH").as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
    }

    #[test]
    fn magnets_with_safe_parameters_can_reuse_hash_keyed_metadata() {
        assert!(magnet_allows_cached_metadata(
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
        ));
        assert!(magnet_allows_cached_metadata(
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Example%20Torrent"
        ));
        assert!(magnet_allows_cached_metadata(
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=https%3A%2F%2Ftracker.invalid%2Fannounce"
        ));
        assert!(magnet_allows_cached_metadata(
            "magnet:?tr=udp%3A%2F%2Ftracker.invalid%3A1337%2Fannounce&xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
        ));
        assert!(!magnet_allows_cached_metadata(
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&ws=https%3A%2F%2Fexample.invalid%2Ffile"
        ));
        assert!(!magnet_allows_cached_metadata(
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&as=https%3A%2F%2Fexample.invalid%2Ffile"
        ));
        assert!(!magnet_allows_cached_metadata(
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&unknown=value"
        ));
        assert!(!magnet_allows_cached_metadata(
            "magnet:?xt=urn:btih:not-a-valid-hash"
        ));
    }

    #[test]
    fn rejects_malformed_base32_magnet_hashes() {
        let error = inspect_source(
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcde!&dn=Invalid",
        )
        .expect_err("a 32-character hash with non-base32 characters must be rejected");
        assert!(error.contains("valid BitTorrent info hash"));

        let error = inspect_source(
            "magnet:?xt=urn:btih:00000000000000000000000000000000&dn=Invalid",
        )
        .expect_err("characters outside RFC 4648 Base32 must be rejected");
        assert!(error.contains("valid BitTorrent info hash"));
    }

    #[test]
    fn normalizes_and_bounds_selected_file_indices() {
        assert_eq!(
            validate_selected_indices(Some(&[3, 1, 3]), 3).unwrap(),
            Some(vec![1, 3])
        );
        assert!(validate_selected_indices(Some(&[0]), 3).is_err());
        assert!(validate_selected_indices(Some(&[4]), 3).is_err());
    }

    #[test]
    fn maps_validated_torrent_files_to_aria2_index_outputs() {
        let parsed = parse_torrent_bytes(
            b"d4:infod5:filesld6:lengthi2e4:pathl4:root5:a.txteed6:lengthi3e4:pathl4:root5:b.bineee4:name4:rootee",
        )
        .expect("multi-file torrent should parse");
        assert_eq!(
            aria2_index_outputs(&parsed, "custom-name"),
            vec![
                "1=custom-name/root/a.txt".to_string(),
                "2=custom-name/root/b.bin".to_string(),
            ]
        );
    }

    #[test]
    fn recognizes_only_http_torrent_metadata_urls() {
        assert!(is_remote_torrent_url("https://example.com/files/sample.torrent"));
        assert!(is_remote_torrent_url("http://example.com/sample.TORRENT?download=1"));
        assert!(!is_remote_torrent_url("https://example.com/files/sample.zip"));
        assert!(!is_remote_torrent_url("ftp://example.com/files/sample.torrent"));
        assert!(!is_remote_torrent_url(
            "magnet:?xt=urn:btih:0123456789012345678901234567890123456789"
        ));
    }

    #[test]
    fn rejects_noncanonical_lengths_and_invalid_files_field() {
        assert!(parse_torrent_bytes(b"d4:infod6:lengthi5e4:name04:testee").is_err());
        assert!(parse_torrent_bytes(b"d4:infod5:filesi1e6:lengthi5e4:name4:testee").is_err());
    }

    #[test]
    fn removes_only_orphaned_probe_directories() {
        let temporary = tempfile::tempdir().expect("temporary torrent storage should exist");
        let root = temporary.path();
        std::fs::create_dir(root.join(".probe-stale")).expect("probe directory should exist");
        std::fs::write(root.join(".probe-file"), b"not a directory")
            .expect("probe marker file should exist");
        std::fs::create_dir(root.join("retained-dir")).expect("unrelated directory should exist");

        assert_eq!(remove_orphaned_probe_dirs_at(root).unwrap(), 1);
        assert!(!root.join(".probe-stale").exists());
        assert!(root.join(".probe-file").is_file());
        assert!(root.join("retained-dir").is_dir());
    }

    #[test]
    fn removes_unretained_torrent_files_but_preserves_retained_and_unrelated_entries() {
        let temporary = tempfile::tempdir().expect("temporary torrent storage should exist");
        let root = temporary.path();
        let retained_hash = "0123456789abcdef0123456789abcdef01234567";
        std::fs::write(root.join("keep-id.torrent"), b"retained")
            .expect("retained metadata should exist");
        std::fs::write(root.join("orphan-id.torrent"), b"orphan")
            .expect("orphan metadata should exist");
        std::fs::write(root.join(format!(".info-{retained_hash}.torrent")), b"retained hash")
            .expect("retained hash metadata should exist");
        std::fs::write(root.join(format!("{retained_hash}.torrent")), b"legacy hash")
            .expect("legacy hash metadata should exist");
        std::fs::write(
            root.join(".info-fedcba9876543210fedcba9876543210fedcba98.torrent"),
            b"orphan hash",
        )
            .expect("orphan hash metadata should exist");
        std::fs::write(
            root.join(format!(
                ".cache-{retained_hash}.torrent.0123456789abcdef0123456789abcdef.tmp"
            )),
            b"orphan temporary",
        )
            .expect("orphan temporary metadata should exist");
        std::fs::write(root.join("notes.txt"), b"unrelated")
            .expect("unrelated file should exist");
        let retained = HashSet::from(["keep-id".to_string()]);
        let retained_hashes = HashSet::from([retained_hash.to_string()]);

        assert_eq!(
            remove_orphaned_cached_torrents_at(root, &retained, &retained_hashes).unwrap(),
            4
        );
        assert!(root.join("keep-id.torrent").is_file());
        assert!(!root.join("orphan-id.torrent").exists());
        assert!(root.join(format!(".info-{retained_hash}.torrent")).is_file());
        assert!(!root.join(format!("{retained_hash}.torrent")).exists());
        assert!(!root
            .join(".info-fedcba9876543210fedcba9876543210fedcba98.torrent")
            .exists());
        assert!(!root
            .join(format!(
                ".cache-{retained_hash}.torrent.0123456789abcdef0123456789abcdef.tmp"
            ))
            .exists());
        assert!(root.join("notes.txt").is_file());
    }
}

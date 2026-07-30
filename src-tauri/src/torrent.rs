use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use tauri::Manager;

use crate::ipc::{TorrentFile, TorrentMetadata};

pub const MAX_TORRENT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ParsedTorrent {
    pub name: String,
    pub total_bytes: u64,
    pub files: Vec<TorrentFile>,
    pub info_hash: String,
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

    Ok(ParsedTorrent { name, total_bytes, files, info_hash })
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
    parse_info(info)
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
            let normalized = value.trim().to_ascii_lowercase();
            if (normalized.len() == 40 && normalized.bytes().all(|byte| byte.is_ascii_hexdigit()))
                || (normalized.len() == 32
                    && normalized
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || matches!(byte, b'2'..=b'7')))
            {
                Some(normalized)
            } else {
                None
            }
        })
        .ok_or_else(|| "magnet URI has no valid BitTorrent info hash".to_string())?;
    let name = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "dn").then_some(value.into_owned()))
        .filter(|value| !value.trim().is_empty())
        .map(|value| crate::download_ownership::canonical_download_filename(&value))
        .unwrap_or_else(|| format!("torrent-{info_hash}"));
    Ok(ParsedTorrent { name, total_bytes: 0, files: Vec::new(), info_hash })
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
pub fn aria2_index_outputs(parsed: &ParsedTorrent) -> Vec<String> {
    parsed
        .files
        .iter()
        .map(|file| {
            let output = if parsed.files.len() == 1 {
                file.path.clone()
            } else {
                format!("{}/{}", parsed.name, file.path)
            };
            format!("{}={output}", file.index)
        })
        .collect()
}

pub fn aria2_output_paths(parsed: &ParsedTorrent, selected: Option<&[u32]>) -> Vec<String> {
    parsed
        .files
        .iter()
        .filter(|file| selected.is_none_or(|indices| indices.contains(&file.index)))
        .map(|file| {
            if parsed.files.len() == 1 {
                file.path.clone()
            } else {
                format!("{}/{}", parsed.name, file.path)
            }
        })
        .collect()
}

pub fn managed_torrent_path<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    id: &str,
) -> Result<PathBuf, String> {
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return Err("invalid torrent download id".to_string());
    }
    let root = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve torrent storage: {error}"))?
        .join("torrents");
    Ok(root.join(format!("{id}.torrent")))
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
    Ok(Some(normalized))
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
    let bytes = tokio::fs::read(&source_path)
        .await
        .map_err(|error| format!("could not read torrent file: {error}"))?;
    let parsed = parse_torrent_bytes(&bytes)?;
    let destination = managed_torrent_path(app_handle, id)?;
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("could not create torrent storage: {error}"))?;
    }
    tokio::fs::write(&destination, &bytes)
        .await
        .map_err(|error| format!("could not cache torrent metadata: {error}"))?;
    Ok((parsed, destination.to_string_lossy().to_string()))
}

pub fn validate_managed_torrent_path<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    id: &str,
    path: &str,
) -> Result<PathBuf, String> {
    let expected = managed_torrent_path(app_handle, id)?;
    let candidate = std::fs::canonicalize(path)
        .map_err(|error| format!("could not access cached torrent metadata: {error}"))?;
    let expected_parent = expected
        .parent()
        .and_then(|parent| std::fs::canonicalize(parent).ok())
        .ok_or_else(|| "cached torrent storage is unavailable".to_string())?;
    if candidate.parent() != Some(expected_parent.as_path()) || candidate.file_name() != expected.file_name() {
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
    fn rejects_malformed_base32_magnet_hashes() {
        let error = inspect_source(
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcde!&dn=Invalid",
        )
        .expect_err("a 32-character hash with non-base32 characters must be rejected");
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
            aria2_index_outputs(&parsed),
            vec!["1=root/root/a.txt".to_string(), "2=root/root/b.bin".to_string()]
        );
    }

    #[test]
    fn rejects_noncanonical_lengths_and_invalid_files_field() {
        assert!(parse_torrent_bytes(b"d4:infod6:lengthi5e4:name04:testee").is_err());
        assert!(parse_torrent_bytes(b"d4:infod5:filesi1e6:lengthi5e4:name4:testee").is_err());
    }
}

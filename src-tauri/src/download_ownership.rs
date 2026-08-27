use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadOwnershipRecord {
    id: String,
    primary_path: String,
}

pub fn canonical_download_filename(filename: &str) -> String {
    const MAX_FILENAME_BYTES: usize = 255;
    const TRUNCATION_MARKER: &str = "…";

    let leaf = filename.replace('\\', "/");
    let leaf = Path::new(&leaf)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let sanitized = leaf
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '-'
            } else {
                character
            }
        })
        .collect::<String>();
    let sanitized = sanitized.trim().trim_end_matches(['.', ' ']);
    let canonical = if sanitized.is_empty() || matches!(sanitized, "." | "..") {
        "download".to_string()
    } else if crate::platform::is_windows_reserved_filename(sanitized) {
        let path = Path::new(sanitized);
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("download");
        match path.extension().and_then(|value| value.to_str()) {
            Some(extension) => format!("{stem}-.{extension}"),
            None => format!("{stem}-"),
        }
    } else {
        sanitized.to_string()
    };

    if canonical.len() <= MAX_FILENAME_BYTES {
        return canonical;
    }

    let extension = Path::new(&canonical)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let base = canonical
        .strip_suffix(&extension)
        .unwrap_or(canonical.as_str());
    let base_budget = MAX_FILENAME_BYTES
        .saturating_sub(extension.len())
        .saturating_sub(TRUNCATION_MARKER.len());

    if base_budget == 0 {
        return truncate_utf8_to_bytes(&canonical, MAX_FILENAME_BYTES);
    }

    format!(
        "{}{}{}",
        truncate_utf8_to_bytes(base, base_budget),
        TRUNCATION_MARKER,
        extension
    )
}

fn truncate_utf8_to_bytes(value: &str, max_bytes: usize) -> String {
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let next = index + character.len_utf8();
        if next > max_bytes {
            break;
        }
        end = next;
    }
    value[..end].to_string()
}

pub fn expected_primary_path(
    app_handle: &tauri::AppHandle,
    destination: &str,
    filename: &str,
) -> Result<PathBuf, String> {
    let resolved_dest = crate::resolve_path(destination, app_handle);
    if !crate::is_safe_path(&resolved_dest, app_handle) {
        return Err("Path traversal blocked".to_string());
    }

    let safe_filename = canonical_download_filename(filename);
    let path = resolved_dest.join(safe_filename);
    if crate::path_has_symlink_component(&path) {
        return Err("Download path may not contain symlink components".to_string());
    }
    crate::canonicalize_with_missing_components(&path)
        .ok_or_else(|| "Download path could not be canonicalized".to_string())
}

pub fn register_expected(
    app_handle: &tauri::AppHandle,
    id: &str,
    destination: &str,
    filename: &str,
) -> Result<(), String> {
    let path = expected_primary_path(app_handle, destination, filename)?;
    set_primary_path(app_handle, id, &path)
}

pub fn set_primary_path(
    app_handle: &tauri::AppHandle,
    id: &str,
    path: &Path,
) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Download ownership path must be absolute".to_string());
    }
    if path.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir | std::path::Component::CurDir
        )
    }) {
        return Err("Download ownership path traversal is not allowed".to_string());
    }
    if crate::path_has_symlink_component(path) {
        return Err("Download ownership path may not contain symlink components".to_string());
    }
    let canonical_path = crate::canonicalize_with_missing_components(path)
        .ok_or_else(|| "Download ownership path could not be canonicalized".to_string())?;

    let database = app_handle.state::<crate::db::DbState>();
    let connection = database.lock()?;
    crate::db::set_ownership(&connection, id, &canonical_path.to_string_lossy())
}

pub fn remove(app_handle: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let database = app_handle.state::<crate::db::DbState>();
    let connection = database.lock()?;
    crate::db::remove_ownership(&connection, id)
}

pub fn primary_path_for_id<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    id: &str,
) -> Result<Option<PathBuf>, String> {
    Ok(load_records(app_handle)?
        .into_iter()
        .find(|record| record.id == id)
        .map(|record| PathBuf::from(record.primary_path)))
}

pub fn known_primary_paths(app_handle: &tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    let mut paths: Vec<PathBuf> = load_records(app_handle)?
        .into_iter()
        .map(|record| PathBuf::from(record.primary_path))
        .collect();

    // One-time compatibility for downloads created before the backend-owned
    // registry existed. This imports the exact persisted queue path only.
    for path in legacy_download_queue_paths(app_handle)? {
        if !paths.iter().any(|existing| existing == &path) {
            paths.push(path);
        }
    }

    Ok(paths)
}

fn load_records<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> Result<Vec<DownloadOwnershipRecord>, String> {
    let database = app_handle.state::<crate::db::DbState>();
    let connection = database.lock()?;
    crate::db::load_ownership(&connection).map(|records| {
        records
            .into_iter()
            .map(|(id, primary_path)| DownloadOwnershipRecord { id, primary_path })
            .collect()
    })
}

fn legacy_download_queue_paths(app_handle: &tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    let settings = crate::settings::load_settings(app_handle).ok();

    let downloads = {
        let database = app_handle.state::<crate::db::DbState>();
        let connection = database.lock()?;
        parse_legacy_download_items(crate::db::load_downloads(&connection)?)
    };

    let mut paths = Vec::new();
    for download in downloads {
        let category = format!("{:?}", download.category);
        let mut destinations = Vec::new();

        if let Some(destination) = download
            .destination
            .clone()
            .filter(|destination| !destination.trim().is_empty())
        {
            destinations.push(destination);
        }

        let category_destination = settings.as_ref().map(|settings| {
            if !settings.category_subfolders_enabled {
                return settings.base_download_folder.clone();
            }
            settings
                .category_directory_overrides
                .get(&category)
                .cloned()
                .unwrap_or_else(|| {
                    let subfolder = settings
                        .category_subfolders
                        .get(&category)
                        .cloned()
                        .unwrap_or_else(|| category.clone());
                    let base = std::path::PathBuf::from(&settings.base_download_folder);
                    let destination = if subfolder.is_empty() {
                        base
                    } else {
                        base.join(subfolder)
                    };
                    destination.to_string_lossy().to_string()
                })
        });
        let default_destination = settings
            .as_ref()
            .map(|settings| settings.base_download_folder.clone());

        if destinations.is_empty() {
            let fallback_destination = category_destination.clone().or(default_destination.clone());
            if let Some(destination) = fallback_destination {
                destinations.push(destination);
            }
        }

        if matches!(download.status, crate::ipc::DownloadStatus::Completed) {
            if let Some(destination) = category_destination {
                destinations.push(destination);
            }
            if let Some(destination) = default_destination {
                destinations.push(destination);
            }
            destinations.push("~/Downloads".to_string());
        }

        for destination in destinations {
            if let Ok(path) = expected_primary_path(app_handle, &destination, &download.file_name) {
                if !paths.iter().any(|existing| existing == &path) {
                    paths.push(path);
                }
            }
        }
    }

    Ok(paths)
}

fn parse_legacy_download_items(values: Vec<String>) -> Vec<crate::ipc::DownloadItem> {
    values
        .into_iter()
        .filter_map(|value| match serde_json::from_str::<crate::ipc::DownloadItem>(&value) {
            Ok(download) => Some(download),
            Err(error) => {
                log::warn!("Skipping malformed download ownership record: {error}");
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{canonical_download_filename, parse_legacy_download_items};
    use serde_json::json;

    #[test]
    fn canonicalizes_untrusted_download_filenames() {
        assert_eq!(
            canonical_download_filename("../folder/video?.mp4"),
            "video-.mp4"
        );
        assert_eq!(canonical_download_filename(" report. "), "report");
        assert_eq!(canonical_download_filename(".."), "download");
        assert_eq!(canonical_download_filename("CON.txt"), "CON-.txt");
        assert_eq!(canonical_download_filename("lpt9"), "lpt9-");
    }

    #[test]
    fn truncates_long_filenames_by_utf8_bytes_and_preserves_extension() {
        let filename = canonical_download_filename(&format!("{}.mp4", "title ".repeat(100)));

        assert!(filename.len() <= 255);
        assert!(filename.ends_with(".mp4"));
        assert!(filename.contains('…'));
    }

    #[test]
    fn truncates_multibyte_filenames_at_character_boundaries() {
        let filename = canonical_download_filename(&format!("{}.mkv", "😀".repeat(100)));

        assert!(filename.len() <= 255);
        assert!(filename.ends_with(".mkv"));
        assert!(!filename.contains('\u{fffd}'));
    }

    #[test]
    fn malformed_legacy_download_does_not_block_valid_ownership_records() {
        let valid = json!({
            "id": "download-1",
            "url": "https://example.com/file",
            "fileName": "file",
            "status": "completed",
            "category": "Other",
            "dateAdded": ""
        })
        .to_string();

        let downloads = parse_legacy_download_items(vec!["not-json".to_string(), valid]);

        assert_eq!(downloads.len(), 1);
        assert_eq!(downloads[0].id, "download-1");
    }
}

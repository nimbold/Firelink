use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn reveal_in_file_manager(
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    let primary = authorize_download_path(&app_handle, &path)?;
    let path = existing_download_asset(&primary).ok_or_else(|| {
        format!(
            "Downloaded file or partial file is missing: {}",
            primary.display()
        )
    })?;

    if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Download path was replaced by a symlink before reveal".to_string());
    }

    app_handle
        .opener()
        .reveal_item_in_dir(path.to_string_lossy().as_ref())
        .map_err(|e| format!("Failed to reveal file: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn open_downloaded_file(
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    let path = authorize_download_path(&app_handle, &path)?;
    if !path.exists() {
        return Err(format!("Downloaded file is missing: {}", path.display()));
    }

    if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Download path was replaced by a symlink before open".to_string());
    }

    app_handle
        .opener()
        .open_path(path.to_string_lossy().as_ref(), None::<String>)
        .map_err(|e| format!("Failed to open file: {}", e))?;

    Ok(())
}

fn authorize_download_path(
    app_handle: &tauri::AppHandle,
    requested: &str,
) -> Result<PathBuf, String> {
    authorize_exact_path(Path::new(requested), &known_download_paths(app_handle)?)
}

fn known_download_paths(app_handle: &tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    crate::download_ownership::known_primary_paths(app_handle)
}

fn authorize_exact_path(requested: &Path, allowed_paths: &[PathBuf]) -> Result<PathBuf, String> {
    if crate::path_has_symlink_component(requested) {
        return Err("Download path may not contain symlink components".to_string());
    }

    let requested = canonicalize_with_missing_leaf(requested)?;
    if let Ok(metadata) = std::fs::metadata(&requested) {
        if !metadata.is_file() {
            return Err("Download path is not a file".to_string());
        }
    }

    let authorized = allowed_paths.iter().any(|allowed| {
        !crate::path_has_symlink_component(allowed)
            && canonicalize_with_missing_leaf(allowed)
                .is_ok_and(|canonical_allowed| canonical_allowed == requested)
    });

    if authorized {
        Ok(requested)
    } else {
        Err("Path is not owned by a known download".to_string())
    }
}

fn canonicalize_with_missing_leaf(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Download path must be absolute".to_string());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("Download path traversal is not allowed".to_string());
    }

    let mut existing = path;
    let mut missing = Vec::new();
    loop {
        match std::fs::symlink_metadata(existing) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err("Download path may not contain symlink components".to_string());
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = existing
                    .file_name()
                    .ok_or_else(|| "Download path has no existing ancestor".to_string())?;
                missing.push(name.to_owned());
                existing = existing
                    .parent()
                    .ok_or_else(|| "Download path has no existing ancestor".to_string())?;
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect download path '{}': {error}",
                    path.display()
                ));
            }
        }
    }

    let mut canonical = std::fs::canonicalize(existing)
        .map_err(|e| format!("Failed to canonicalize download path: {e}"))?;
    for component in missing.iter().rev() {
        canonical.push(component);
    }
    Ok(canonical)
}

fn existing_download_asset(primary: &Path) -> Option<PathBuf> {
    [
        primary.to_path_buf(),
        append_suffix(primary, ".aria2"),
        append_suffix(primary, ".part"),
    ]
    .into_iter()
    .find(|candidate| {
        std::fs::symlink_metadata(candidate)
            .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    })
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value: OsString = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::{append_suffix, authorize_exact_path};
    use std::fs;
    use std::path::{Path, PathBuf};

    #[test]
    fn authorizes_only_known_download_files_and_partials() {
        let root = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(root.path()).unwrap();
        let owned = root.join("owned.bin");
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(&owned, b"download").unwrap();

        assert_eq!(
            authorize_exact_path(&owned, std::slice::from_ref(&owned)).unwrap(),
            fs::canonicalize(&owned).unwrap()
        );
        assert!(authorize_exact_path(outside.path(), std::slice::from_ref(&owned)).is_err());

        let partial = append_suffix(&owned, ".part");
        fs::write(&partial, b"partial").unwrap();
        assert!(authorize_exact_path(&partial, std::slice::from_ref(&partial)).is_ok());
    }

    #[test]
    fn rejects_relative_traversal_and_sensitive_paths() {
        let root = tempfile::tempdir().unwrap();
        let owned = root.path().join("owned.bin");
        fs::write(&owned, b"download").unwrap();

        assert!(
            authorize_exact_path(Path::new("owned.bin"), std::slice::from_ref(&owned)).is_err()
        );
        assert!(authorize_exact_path(
            &root.path().join("sub/../owned.bin"),
            std::slice::from_ref(&owned)
        )
        .is_err());
        assert!(
            authorize_exact_path(Path::new("/etc/hosts"), std::slice::from_ref(&owned)).is_err()
        );
        if let Some(home) = std::env::var_os("HOME") {
            assert!(authorize_exact_path(
                &PathBuf::from(home).join(".ssh"),
                std::slice::from_ref(&owned)
            )
            .is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_from_download_location() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let escaped = root.path().join("owned.bin");
        symlink(outside.path().join("outside.bin"), &escaped).unwrap();

        assert!(authorize_exact_path(&escaped, std::slice::from_ref(&escaped)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_parent_directory_symlink_escape_from_download_location() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let root_path = fs::canonicalize(root.path()).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("owned.bin");
        fs::write(&outside_file, b"outside").unwrap();

        let redirected_parent = root_path.join("downloads");
        symlink(outside.path(), &redirected_parent).unwrap();
        let escaped = redirected_parent.join("owned.bin");

        assert!(authorize_exact_path(&escaped, std::slice::from_ref(&escaped)).is_err());
    }
}

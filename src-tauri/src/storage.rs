use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

pub const PORTABLE_MARKER: &str = "portable.flag";
const PORTABLE_DATA_DIR: &str = "data";
const PORTABLE_LOG_DIR: &str = "logs";
const PORTABLE_WEBVIEW_DIR: &str = "webview";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageMode {
    Standard,
    Portable { root: PathBuf },
}

impl StorageMode {
    pub fn detect() -> Self {
        let Some(executable) = std::env::current_exe().ok() else {
            return Self::Standard;
        };
        let Some(root) = executable.parent() else {
            return Self::Standard;
        };

        if root.join(PORTABLE_MARKER).is_file() {
            Self::Portable {
                root: root.to_path_buf(),
            }
        } else {
            Self::Standard
        }
    }

    #[cfg(test)]
    fn detect_from_root(root: &Path) -> Self {
        if root.join(PORTABLE_MARKER).is_file() {
            Self::Portable {
                root: root.to_path_buf(),
            }
        } else {
            Self::Standard
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageLayout {
    mode: StorageMode,
    data_dir: PathBuf,
    log_dir: PathBuf,
    webview_dir: PathBuf,
}

impl StorageLayout {
    pub fn resolve<R: Runtime>(
        app_handle: &AppHandle<R>,
        mode: StorageMode,
    ) -> Result<Self, String> {
        let (mode, data_dir, log_dir, webview_dir) = match mode {
            StorageMode::Standard => (
                StorageMode::Standard,
                app_handle
                    .path()
                    .app_data_dir()
                    .map_err(|error| format!("failed to resolve app data directory: {error}"))?,
                app_handle
                    .path()
                    .app_log_dir()
                    .map_err(|error| format!("failed to resolve app log directory: {error}"))?,
                app_handle.path().app_local_data_dir().map_err(|error| {
                    format!("failed to resolve app local data directory: {error}")
                })?,
            ),
            StorageMode::Portable { root } => {
                let data_dir = root.join(PORTABLE_DATA_DIR);
                (
                    StorageMode::Portable { root },
                    data_dir.clone(),
                    data_dir.join(PORTABLE_LOG_DIR),
                    data_dir.join(PORTABLE_WEBVIEW_DIR),
                )
            }
        };

        Ok(Self {
            mode,
            data_dir: canonicalize_storage_path(&data_dir)?,
            log_dir: canonicalize_storage_path(&log_dir)?,
            webview_dir: canonicalize_storage_path(&webview_dir)?,
        })
    }

    pub fn is_portable(&self) -> bool {
        matches!(self.mode, StorageMode::Portable { .. })
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn log_dir(&self) -> &Path {
        &self.log_dir
    }

    pub fn webview_dir(&self) -> &Path {
        &self.webview_dir
    }
}

fn canonicalize_storage_path(path: &Path) -> Result<PathBuf, String> {
    if crate::path_has_symlink_component(path) {
        return Err(format!(
            "storage path contains a symlinked component: '{}'",
            path.display()
        ));
    }
    let mut existing = path;
    let mut missing = Vec::new();
    loop {
        match std::fs::symlink_metadata(existing) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "storage path contains a symlinked directory: '{}'",
                        path.display()
                    ));
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "failed to inspect storage path '{}': {error}",
                    path.display()
                ));
            }
        }
        missing.push(
            existing
                .file_name()
                .ok_or_else(|| format!("storage path has no existing ancestor: '{}'", path.display()))?
                .to_owned(),
        );
        existing = existing
            .parent()
            .ok_or_else(|| format!("storage path has no existing ancestor: '{}'", path.display()))?;
    }
    let mut canonical = std::fs::canonicalize(existing)
        .map_err(|error| format!("failed to canonicalize storage path '{}': {error}", path.display()))?;
    for component in missing.iter().rev() {
        canonical.push(component);
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::{canonicalize_storage_path, StorageMode, PORTABLE_MARKER};
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    #[test]
    fn marker_selects_portable_mode() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join(PORTABLE_MARKER), b"portable\n").unwrap();

        assert_eq!(
            StorageMode::detect_from_root(root.path()),
            StorageMode::Portable {
                root: root.path().to_path_buf()
            }
        );
    }

    #[test]
    fn missing_marker_keeps_standard_mode() {
        let root = TempDir::new().unwrap();

        assert_eq!(
            StorageMode::detect_from_root(root.path()),
            StorageMode::Standard
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_storage_directories() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();
        let root_path = fs::canonicalize(root.path()).unwrap();
        let redirected = root_path.join("logs");
        symlink(target.path(), &redirected).unwrap();

        assert!(canonicalize_storage_path(Path::new(&redirected)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_dangling_symlinked_storage_directories() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let root_path = fs::canonicalize(root.path()).unwrap();
        let redirected = root_path.join("logs");
        symlink(root_path.join("missing-target"), &redirected).unwrap();

        assert!(canonicalize_storage_path(Path::new(&redirected)).is_err());
    }
}

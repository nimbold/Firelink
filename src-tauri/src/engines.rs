use std::path::{Path, PathBuf};
use tauri::Manager;

pub fn resolve_bundled_binary_path(
    app_handle: &tauri::AppHandle,
    engine: &str,
) -> Result<PathBuf, String> {
    let binary_name = crate::platform::engine_binary_name(engine);
    let target = crate::platform::target_triple();

    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        for candidate in packaged_candidates(&resource_dir, &target, &binary_name) {
            if candidate.is_file() {
                log::info!("Resolved bundled '{}' at: {:?}", engine, candidate);
                return Ok(candidate);
            }
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        for candidate in executable_relative_candidates(&exe_path, &target, &binary_name) {
            if candidate.is_file() {
                log::info!("Resolved bundled '{}' at: {:?}", engine, candidate);
                return Ok(candidate);
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for candidate in development_candidates(&cwd, &target, &binary_name) {
            if candidate.is_file() {
                let absolute = candidate.canonicalize().map_err(|error| {
                    format!("Failed to canonicalize '{}': {error}", candidate.display())
                })?;
                log::info!("Resolved bundled '{}' at: {:?}", engine, absolute);
                return Ok(absolute);
            }
        }
    }

    Err(format!(
        "Could not find bundled binary '{}' for target '{}' (expected name: {})",
        engine, target, binary_name
    ))
}

fn packaged_candidates(resource_dir: &Path, target: &str, binary_name: &str) -> Vec<PathBuf> {
    let mut candidates = vec![
        resource_dir
            .join("engine-dist")
            .join(target)
            .join(binary_name),
        resource_dir.join("engines").join(target).join(binary_name),
    ];
    if cfg!(target_os = "macos") {
        candidates.push(resource_dir.join("binaries").join(binary_name));
        candidates.push(resource_dir.join(binary_name));
    }
    candidates
}

fn executable_relative_candidates(
    executable: &Path,
    target: &str,
    binary_name: &str,
) -> Vec<PathBuf> {
    let Some(executable_dir) = executable.parent() else {
        return Vec::new();
    };
    let mut candidates = vec![
        executable_dir
            .join("engine-dist")
            .join(target)
            .join(binary_name),
        executable_dir
            .join("engines")
            .join(target)
            .join(binary_name),
    ];

    if cfg!(target_os = "macos") {
        if let Some(contents_dir) = executable_dir.parent() {
            candidates.push(
                contents_dir
                    .join("Resources")
                    .join("engine-dist")
                    .join(target)
                    .join(binary_name),
            );
            candidates.push(
                contents_dir
                    .join("Resources")
                    .join("binaries")
                    .join(binary_name),
            );
        }
    }
    candidates
}

fn development_candidates(cwd: &Path, target: &str, binary_name: &str) -> Vec<PathBuf> {
    let roots = [cwd.to_path_buf(), cwd.join("src-tauri")];
    let mut candidates = Vec::new();
    for root in roots {
        candidates.push(root.join("engine-dist").join(target).join(binary_name));
        candidates.push(root.join("binaries").join(target).join(binary_name));
        if cfg!(target_os = "macos") {
            candidates.push(root.join("binaries").join(binary_name));
        }
    }
    candidates
}

pub fn ytdlp_internal_dir(binary_path: &Path) -> Option<PathBuf> {
    binary_path.parent().map(|parent| parent.join("_internal"))
}

pub fn apply_aria2_environment(command: &mut std::process::Command, binary_path: &Path) {
    if let Some(modules_dir) = aria2_openssl_modules_dir(binary_path) {
        command.env("OPENSSL_MODULES", modules_dir);
    }
}

pub fn apply_aria2_tokio_environment(command: &mut tokio::process::Command, binary_path: &Path) {
    if let Some(modules_dir) = aria2_openssl_modules_dir(binary_path) {
        command.env("OPENSSL_MODULES", modules_dir);
    }
}

fn aria2_openssl_modules_dir(binary_path: &Path) -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }

    let modules_dir = binary_path
        .parent()?
        .join("aria2-libs");

    modules_dir.is_dir().then_some(modules_dir)
}

#[cfg(test)]
mod tests {
    use super::{development_candidates, packaged_candidates};
    use std::path::Path;

    #[test]
    fn canonical_packaged_layout_is_target_scoped() {
        let candidates = packaged_candidates(
            Path::new("/resources"),
            "x86_64-unknown-linux-gnu",
            "yt-dlp-x86_64-unknown-linux-gnu",
        );
        assert_eq!(
            candidates[0],
            Path::new(
                "/resources/engine-dist/x86_64-unknown-linux-gnu/yt-dlp-x86_64-unknown-linux-gnu"
            )
        );
    }

    #[test]
    fn canonical_development_layout_is_target_scoped() {
        let candidates = development_candidates(
            Path::new("/repo"),
            "x86_64-pc-windows-msvc",
            "aria2c-x86_64-pc-windows-msvc.exe",
        );
        assert_eq!(
            candidates[0],
            Path::new("/repo/engine-dist/x86_64-pc-windows-msvc/aria2c-x86_64-pc-windows-msvc.exe")
        );
    }
}

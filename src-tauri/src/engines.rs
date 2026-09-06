use std::path::{Path, PathBuf};
use tauri::Manager;

pub fn resolve_bundled_binary_path(
    app_handle: &tauri::AppHandle,
    engine: &str,
) -> Result<PathBuf, String> {
    let binary_name = crate::platform::engine_binary_name(engine);
    let target = crate::platform::target_triple();

    #[cfg(debug_assertions)]
    if let Some(runtime_root) = std::env::var_os("FIRELINK_ENGINE_RUNTIME_ROOT") {
        for candidate in runtime_candidates(Path::new(&runtime_root), &target, &binary_name) {
            if candidate.is_file() {
                let absolute = candidate.canonicalize().map_err(|error| {
                    format!("Failed to canonicalize '{}': {error}", candidate.display())
                })?;
                log::info!(
                    "Resolved development engine '{}' for target '{}'",
                    engine,
                    target
                );
                return Ok(absolute);
            }
        }
    }

    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        for candidate in packaged_candidates(&resource_dir, &target, &binary_name) {
            if candidate.is_file() {
                log::info!("Resolved bundled '{}' for target '{}'", engine, target);
                return Ok(candidate);
            }
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        for candidate in executable_relative_candidates(&exe_path, &target, &binary_name) {
            if candidate.is_file() {
                log::info!("Resolved bundled '{}' for target '{}'", engine, target);
                return Ok(candidate);
            }
        }
    }

    // Development payloads are intentionally discoverable from the checkout,
    // but a packaged/release app must never execute an engine selected by its
    // working directory. If the packaged resource or executable-relative
    // payload is missing, fail closed instead of allowing a same-named binary
    // from an untrusted CWD to take over the media/download process.
    if let Ok(cwd) = std::env::current_dir() {
        for candidate in development_candidates_for_runtime(&cwd, &target, &binary_name) {
            if candidate.is_file() {
                let absolute = candidate.canonicalize().map_err(|error| {
                    format!("Failed to canonicalize '{}': {error}", candidate.display())
                })?;
                log::info!("Resolved bundled '{}' for target '{}'", engine, target);
                return Ok(absolute);
            }
        }
    }

    Err(format!(
        "Could not find bundled binary '{}' for target '{}' (expected name: {})",
        engine, target, binary_name
    ))
}

fn development_candidates_for_runtime(
    cwd: &Path,
    target: &str,
    binary_name: &str,
) -> Vec<PathBuf> {
    #[cfg(debug_assertions)]
    {
        development_candidates(cwd, target, binary_name)
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (cwd, target, binary_name);
        Vec::new()
    }
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

#[cfg(any(debug_assertions, test))]
fn runtime_candidates(root: &Path, target: &str, binary_name: &str) -> Vec<PathBuf> {
    vec![root.join(target).join(binary_name)]
}

#[cfg(any(debug_assertions, test))]
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
    apply_aria2_runtime_environment(command, binary_path);
}

pub fn apply_aria2_tokio_environment(command: &mut tokio::process::Command, binary_path: &Path) {
    apply_aria2_runtime_environment(command, binary_path);
}

fn apply_aria2_runtime_environment<C>(command: &mut C, binary_path: &Path)
where
    C: Aria2CommandEnvironment,
{
    if let Some(modules_dir) = aria2_openssl_modules_dir(binary_path) {
        command.set_env("OPENSSL_MODULES", &modules_dir);
        #[cfg(target_os = "windows")]
        {
            let mut path = modules_dir.as_os_str().to_os_string();
            path.push(";");
            if let Some(existing) = std::env::var_os("PATH") {
                path.push(existing);
            }
            command.set_env("PATH", path);
        }
    }
}

trait Aria2CommandEnvironment {
    fn set_env(&mut self, key: &str, value: impl AsRef<std::ffi::OsStr>);
}

impl Aria2CommandEnvironment for std::process::Command {
    fn set_env(&mut self, key: &str, value: impl AsRef<std::ffi::OsStr>) {
        self.env(key, value);
    }
}

impl Aria2CommandEnvironment for tokio::process::Command {
    fn set_env(&mut self, key: &str, value: impl AsRef<std::ffi::OsStr>) {
        self.env(key, value);
    }
}

fn aria2_openssl_modules_dir(binary_path: &Path) -> Option<PathBuf> {
    if !cfg!(any(target_os = "macos", target_os = "windows")) {
        return None;
    }

    let modules_dir = binary_path
        .parent()?
        .join("aria2-libs");

    modules_dir.is_dir().then_some(modules_dir)
}

#[cfg(test)]
mod tests {
    use super::{
        development_candidates, development_candidates_for_runtime, packaged_candidates,
        runtime_candidates,
    };
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

    #[test]
    fn configured_development_layout_is_target_scoped() {
        let candidates = runtime_candidates(
            Path::new("/tmp/firelink-engine-run/engine-dist"),
            "x86_64-unknown-linux-gnu",
            "yt-dlp-x86_64-unknown-linux-gnu",
        );
        assert_eq!(
            candidates[0],
            Path::new(
                "/tmp/firelink-engine-run/engine-dist/x86_64-unknown-linux-gnu/yt-dlp-x86_64-unknown-linux-gnu"
            )
        );
    }

    #[test]
    fn development_resolution_is_disabled_in_release_builds() {
        let candidates = development_candidates_for_runtime(
            Path::new("/repo"),
            "x86_64-unknown-linux-gnu",
            "yt-dlp-x86_64-unknown-linux-gnu",
        );

        if cfg!(debug_assertions) {
            assert!(!candidates.is_empty());
        } else {
            assert!(candidates.is_empty());
        }
    }
}

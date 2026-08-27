use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub fn target_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        std::env::consts::ARCH
    }
}

pub fn target_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "apple-darwin"
    } else if cfg!(target_os = "windows") {
        "pc-windows-msvc"
    } else if cfg!(target_os = "linux") {
        "unknown-linux-gnu"
    } else {
        std::env::consts::OS
    }
}

pub fn target_triple() -> String {
    format!("{}-{}", target_arch(), target_platform())
}

pub fn executable_suffix() -> &'static str {
    if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    }
}

pub fn engine_binary_name(engine: &str) -> String {
    format!("{engine}-{}{}", target_triple(), executable_suffix())
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn hide_child_console(command: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
    }
}

pub fn hide_tokio_child_console(command: &mut tokio::process::Command) {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
    }
}

pub fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();

    #[cfg(target_os = "windows")]
    {
        if let Some(stripped) = text.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{stripped}");
        }
        if let Some(stripped) = text.strip_prefix(r"\\?\") {
            return stripped.to_string();
        }
    }

    text.to_string()
}

pub fn trusted_system_path() -> Result<OsString, String> {
    let entries = trusted_system_path_entries();
    std::env::join_paths(entries)
        .map_err(|error| format!("failed to construct trusted system PATH: {error}"))
}

fn trusted_system_path_entries() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let windows = std::env::var_os("SystemRoot")
            .or_else(|| std::env::var_os("WINDIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        return vec![windows.join("System32"), windows];
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![PathBuf::from("/usr/bin"), PathBuf::from("/bin")]
    }
}

pub fn path_is_within(path: &Path, root: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        let path = path.to_string_lossy().to_lowercase();
        let root = root.to_string_lossy().to_lowercase();
        path == root
            || path
                .strip_prefix(&root)
                .is_some_and(|suffix| suffix.starts_with(['\\', '/']))
    }

    #[cfg(not(target_os = "windows"))]
    {
        path.starts_with(root)
    }
}

pub fn paths_equal(left: &Path, right: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

pub fn is_windows_reserved_filename(filename: &str) -> bool {
    let stem = filename
        .split('.')
        .next()
        .unwrap_or(filename)
        .trim_end_matches(['.', ' '])
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || numbered_windows_device(&stem, "COM")
        || numbered_windows_device(&stem, "LPT")
}

fn numbered_windows_device(stem: &str, prefix: &str) -> bool {
    stem.strip_prefix(prefix)
        .is_some_and(|number| matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
}

#[cfg(test)]
mod tests {
    use super::{engine_binary_name, is_windows_reserved_filename, target_triple};

    #[test]
    fn target_engine_name_uses_current_rust_target() {
        let name = engine_binary_name("ffmpeg");
        assert!(name.starts_with("ffmpeg-"));
        assert!(name.contains(&target_triple()));
        if cfg!(target_os = "windows") {
            assert!(name.ends_with(".exe"));
        } else {
            assert!(!name.ends_with(".exe"));
        }
    }

    #[test]
    fn recognizes_windows_reserved_device_names() {
        for filename in [
            "CON", "con.txt", "PRN.", "aux.mp4", "NUL", "COM1.zip", "lpt9",
        ] {
            assert!(is_windows_reserved_filename(filename), "{filename}");
        }
        for filename in [
            "console.txt",
            "com0.zip",
            "com10.zip",
            "lpt.txt",
            "movie.mp4",
        ] {
            assert!(!is_windows_reserved_filename(filename), "{filename}");
        }
    }
}

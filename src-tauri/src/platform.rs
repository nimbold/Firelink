use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

/// Return a stable identity for an existing directory.
///
/// Canonical paths alone are not a sufficient ownership fence on Windows,
/// where Aria2 may report different casing or separators for the same
/// directory. Pair canonicalization with the platform's filesystem identity
/// so callers compare the object a path resolves to instead of its spelling.
pub fn directory_identity(path: &Path) -> io::Result<String> {
    let canonical = std::fs::canonicalize(path)?;
    let metadata = std::fs::metadata(&canonical)?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            "path is not a directory",
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return Ok(format!("{}:{}", metadata.dev(), metadata.ino()));
    }

    #[cfg(target_os = "windows")]
    {
        return windows_directory_identity(&canonical);
    }

    #[allow(unreachable_code)]
    Ok(canonical.to_string_lossy().into_owned())
}

#[cfg(target_os = "windows")]
fn windows_directory_identity(path: &Path) -> io::Result<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }

    let mut metadata = BY_HANDLE_FILE_INFORMATION::default();
    let succeeded = unsafe { GetFileInformationByHandle(handle, &mut metadata) != 0 };
    let error = (!succeeded).then(io::Error::last_os_error);
    unsafe {
        let _ = CloseHandle(handle);
    }
    match error {
        Some(error) => Err(error),
        None => Ok(format_file_identity(&metadata)),
    }
}

/// Return a stable filesystem identity for an existing Windows file without
/// relying on unstable `std::fs::MetadataExt` APIs. The handle is opened with
/// delete sharing so inspection does not unnecessarily block normal cleanup
/// or replacement; callers still validate the path with `symlink_metadata`
/// before using this identity.
#[cfg(target_os = "windows")]
pub fn file_identity(path: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_NORMAL,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };

    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // A zero desired-access mask requests metadata access only. Opening with
    // all sharing flags avoids introducing a lock that changes the outcome of
    // a subsequent exact replacement or cleanup operation.
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }

    let mut metadata = BY_HANDLE_FILE_INFORMATION::default();
    let result = unsafe {
        let succeeded = GetFileInformationByHandle(handle, &mut metadata) != 0;
        let _ = CloseHandle(handle);
        succeeded
    };
    result.then(|| {
        format_file_identity(&metadata)
    })
}

/// Return the identity of the already-open Windows file handle. This keeps a
/// replacement check tied to the same file that was hashed instead of
/// reopening the path and trusting a second path lookup.
#[cfg(target_os = "windows")]
pub fn file_identity_for_handle(file: &std::fs::File) -> Option<String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut metadata = BY_HANDLE_FILE_INFORMATION::default();
    let succeeded = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut metadata) != 0 };
    succeeded.then(|| format_file_identity(&metadata))
}

#[cfg(target_os = "windows")]
fn format_file_identity(
    metadata: &windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION,
) -> String {
    format!(
        "{}:{}:{}",
        metadata.dwVolumeSerialNumber, metadata.nFileIndexHigh, metadata.nFileIndexLow
    )
}

const ATOMIC_TEMP_PREFIX: &str = ".firelink-atomic-";

/// Write bytes to a same-directory temporary file, synchronize them, and
/// replace the destination without ever opening the destination for writing.
///
/// The destination is checked with `symlink_metadata` so managed callers fail
/// closed when an attacker or another process has substituted a link or a
/// non-file. The final rename is atomic on Unix and uses Windows replace
/// semantics rather than the non-replacing `std::fs::rename` behavior.
pub async fn atomic_write_replace(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "atomic path has no parent"))?;
    validate_atomic_parent(parent).await?;

    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "atomic destination cannot be a symbolic link",
            ));
        }
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "atomic destination is not a regular file",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    let temporary = parent.join(format!(
        "{ATOMIC_TEMP_PREFIX}{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let write_result = async {
        use tokio::io::AsyncWriteExt;

        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await?;
        file.write_all(bytes).await?;
        file.sync_all().await
    }
    .await;

    if let Err(error) = write_result {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }

    if let Err(error) = replace_staged_file(&temporary, path) {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }

    #[cfg(unix)]
    {
        // A directory sync makes the rename durable across a power loss on
        // platforms that support opening directories as file descriptors.
        std::fs::File::open(parent)?.sync_all()?;
    }

    Ok(())
}

async fn validate_atomic_parent(parent: &Path) -> io::Result<()> {
    use std::path::Component;

    let mut current = PathBuf::new();
    for component in parent.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "atomic parent contains a parent-directory component",
                ));
            }
            Component::Normal(name) => {
                current.push(name);
                let metadata = tokio::fs::symlink_metadata(&current).await?;
                if metadata.file_type().is_symlink() {
                    if let Some(canonical_alias) = resolve_atomic_system_alias(&current)? {
                        current = canonical_alias;
                        continue;
                    }
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "atomic parent cannot contain a symbolic link",
                    ));
                }
                if !metadata.is_dir() {
                    return Err(io::Error::new(
                        io::ErrorKind::NotADirectory,
                        "atomic parent is not a directory",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn resolve_atomic_system_alias(path: &Path) -> io::Result<Option<PathBuf>> {
    #[cfg(target_os = "macos")]
    {
        let expected = match path {
            path if path == Path::new("/tmp") => Some(Path::new("/private/tmp")),
            path if path == Path::new("/var") => Some(Path::new("/private/var")),
            path if path == Path::new("/etc") => Some(Path::new("/private/etc")),
            _ => None,
        };
        if let Some(expected) = expected {
            let canonical = std::fs::canonicalize(path)?;
            if canonical == expected {
                return Ok(Some(canonical));
            }
        }
    }

    let _ = path;
    Ok(None)
}

pub fn is_atomic_temp_file_name(name: &str) -> bool {
    let Some(suffix) = name.strip_prefix(ATOMIC_TEMP_PREFIX) else {
        return false;
    };
    let Some(identifier) = suffix.strip_suffix(".tmp") else {
        return false;
    };
    identifier.len() == 32 && identifier.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn replace_staged_file(temporary: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        std::fs::rename(temporary, destination)
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use std::thread;
        use std::time::Duration;
        use windows_sys::Win32::Foundation::{
            GetLastError, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION,
        };
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let temporary = temporary
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let destination = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();

        for attempt in 0..5 {
            // SAFETY: both paths are NUL-terminated UTF-16 buffers owned for
            // the duration of the call, and the flags request same-volume
            // replacement with write-through semantics.
            let replaced = unsafe {
                MoveFileExW(
                    temporary.as_ptr(),
                    destination.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            };
            if replaced != 0 {
                return Ok(());
            }

            let error = unsafe { GetLastError() };
            if !matches!(error, ERROR_LOCK_VIOLATION | ERROR_SHARING_VIOLATION) || attempt == 4 {
                return Err(io::Error::from_raw_os_error(error as i32));
            }
            thread::sleep(Duration::from_millis(25 * (attempt + 1) as u64));
        }

        unreachable!("atomic Windows replacement loop always returns");
    }
}

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
        let path = path_identity(path);
        let root = path_identity(root);
        path == root
            || (root.len() == 3
                && root.ends_with('/')
                && root.as_bytes()[1] == b':'
                && path.starts_with(&root))
            || path
                .strip_prefix(&root)
                .is_some_and(|suffix| suffix.starts_with('/'))
    }

    #[cfg(target_os = "macos")]
    {
        // Containment is a scope check, not an equality check. Do not fold
        // case here: case-sensitive APFS/HFS+ volumes are valid macOS
        // configurations, and lowercasing could admit `/Users/nima2` or a
        // differently-cased sibling outside the approved root. Callers pass
        // canonical paths (with only missing leaf components preserved), so
        // NFC normalization is enough to compare macOS path spellings.
        use unicode_normalization::UnicodeNormalization;

        let path = path.to_string_lossy().nfc().collect::<String>();
        let root = root.to_string_lossy().nfc().collect::<String>();
        let root = root.trim_end_matches('/');
        if path == root || (root.is_empty() && path == "/") {
            return true;
        }

        if root.is_empty() {
            return path.starts_with('/');
        }

        path.strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        path.starts_with(root)
    }

    #[cfg(not(any(unix, target_os = "windows", target_os = "macos")))]
    {
        path.starts_with(root)
    }
}

pub fn paths_equal(left: &Path, right: &Path) -> bool {
    path_identity(left) == path_identity(right)
}

/// Return the in-process lock identity for a path using the same platform
/// equivalence rules as `paths_equal`. Callers use this for serialization,
/// not for display or persistence.
pub fn path_identity(path: &Path) -> String {
    #[cfg(target_os = "windows")]
    {
        let mut normalized = path.to_string_lossy().replace('\\', "/");
        if normalized
            .get(..8)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("//?/UNC/"))
        {
            normalized.replace_range(..8, "//");
        } else if normalized
            .get(..4)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("//?/"))
        {
            normalized.replace_range(..4, "");
        }

        let is_unc = normalized.starts_with("//");
        let mut collapsed = String::with_capacity(normalized.len());
        for character in normalized.chars() {
            if character == '/' && collapsed.ends_with('/') && !(is_unc && collapsed.len() == 1) {
                continue;
            }
            collapsed.push(character);
        }
        while collapsed.len() > 1
            && collapsed.ends_with('/')
            && !(collapsed.len() == 3 && collapsed.as_bytes()[1] == b':')
        {
            collapsed.pop();
        }
        collapsed.to_lowercase()
    }
    #[cfg(target_os = "macos")]
    {
        use unicode_normalization::UnicodeNormalization;

        path.to_string_lossy()
            .to_lowercase()
            .nfc()
            .collect::<String>()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::ffi::OsStrExt;

        path.as_os_str()
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
    #[cfg(not(any(unix, target_os = "windows", target_os = "macos")))]
    {
        path.to_string_lossy().to_string()
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
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    use super::path_is_within;
    use super::{engine_binary_name, is_windows_reserved_filename, paths_equal, target_triple};
    use std::path::Path;

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

    #[test]
    fn path_identity_matches_the_host_filesystem_case_contract() {
        let left = Path::new("/downloads/Selected/File.bin");
        let right = Path::new("/Downloads/selected/file.BIN");
        if cfg!(any(target_os = "windows", target_os = "macos")) {
            assert!(paths_equal(left, right));
        } else {
            assert!(!paths_equal(left, right));
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_path_identity_normalizes_separators_and_verbatim_prefixes() {
        assert!(paths_equal(
            Path::new(r"C:\downloads\file.bin"),
            Path::new("c:/DOWNLOADS/file.bin")
        ));
        assert!(paths_equal(
            Path::new(r"C:\downloads\file.bin"),
            Path::new(r"\\?\C:\downloads\file.bin")
        ));
        assert!(paths_equal(
            Path::new(r"\\server\share\file.bin"),
            Path::new(r"\\?\UNC\server\share\file.bin")
        ));
        assert!(path_is_within(
            Path::new("c:/downloads/file.bin"),
            Path::new(r"C:\downloads")
        ));
    }

    #[test]
    fn path_identity_handles_non_ascii_case_differences() {
        let left = Path::new("/downloads/Ärt/File.bin");
        let right = Path::new("/DOWNLOADS/ärt/file.BIN");
        if cfg!(any(target_os = "windows", target_os = "macos")) {
            assert!(paths_equal(left, right));
        } else {
            assert!(!paths_equal(left, right));
        }
    }

    #[test]
    fn path_identity_handles_macos_unicode_normalization() {
        let composed = Path::new("/downloads/café/File.bin");
        let decomposed = Path::new("/DOWNLOADS/cafe\u{301}/file.BIN");
        if cfg!(target_os = "macos") {
            assert!(paths_equal(composed, decomposed));
        } else {
            assert!(!paths_equal(composed, decomposed));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_path_is_within_preserves_scope_and_unicode_identity() {
        assert!(path_is_within(
            Path::new("/Downloads/cafe\u{301}/movie.bin"),
            Path::new("/Downloads/café")
        ));
        assert!(path_is_within(
            Path::new("/Downloads/movie.bin"),
            Path::new("/Downloads")
        ));
        assert!(path_is_within(
            Path::new("/Downloads"),
            Path::new("/Downloads/")
        ));
        assert!(path_is_within(Path::new("/"), Path::new("////")));
        assert!(path_is_within(
            Path::new("/Downloads/movie.bin"),
            Path::new("/")
        ));
        assert!(!path_is_within(
            Path::new("/downloads/cafeteria/movie.bin"),
            Path::new("/Downloads/café")
        ));
        assert!(!path_is_within(
            Path::new("/downloads/movie.bin"),
            Path::new("/Downloads")
        ));
    }
}

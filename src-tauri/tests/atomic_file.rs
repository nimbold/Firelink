use firelink_lib::atomic_write_replace;
use std::fs;
use tempfile::tempdir;
#[cfg(target_os = "macos")]
use tempfile::tempdir_in;

#[tokio::test]
async fn atomic_replacement_replaces_existing_file_repeatedly() {
    let directory = tempdir().expect("temporary directory should be created");
    let root = fs::canonicalize(directory.path()).expect("temporary directory should canonicalize");
    let destination = root.join("download.torrent");

    for value in [
        b"reserved".as_slice(),
        b"copied".as_slice(),
        b"databaseCommitted".as_slice(),
        b"sourceCleanupPending".as_slice(),
    ] {
        atomic_write_replace(&destination, value)
            .await
            .expect("atomic replacement should succeed");
        assert_eq!(
            fs::read(&destination).expect("destination should exist"),
            value
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn atomic_replacement_rejects_symbolic_link_destinations() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().expect("temporary directory should be created");
    let root = fs::canonicalize(directory.path()).expect("temporary directory should canonicalize");
    let target = root.join("target");
    let destination = root.join("download.torrent");
    fs::write(&target, b"protected").expect("target should be written");
    symlink(&target, &destination).expect("symbolic link should be created");

    assert!(atomic_write_replace(&destination, b"replacement")
        .await
        .is_err());
    assert_eq!(
        fs::read(&target).expect("target should remain readable"),
        b"protected"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn atomic_replacement_rejects_symbolic_link_parent_components() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().expect("temporary directory should be created");
    let root = fs::canonicalize(directory.path()).expect("temporary directory should canonicalize");
    let target_directory = root.join("target");
    let linked_directory = root.join("linked");
    let target_child = target_directory.join("child");
    std::fs::create_dir(&target_directory).expect("target directory should be created");
    std::fs::create_dir(&target_child).expect("target child directory should be created");
    symlink(&target_directory, &linked_directory).expect("symbolic link should be created");
    let destination = linked_directory.join("child/download.torrent");

    assert!(atomic_write_replace(&destination, b"replacement")
        .await
        .is_err());
    assert!(!target_child.join("download.torrent").exists());
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn atomic_replacement_accepts_macos_system_path_aliases() {
    let directory = tempdir_in("/tmp").expect("temporary directory should be created");
    let destination = directory.path().join("download.torrent");

    atomic_write_replace(&destination, b"replacement")
        .await
        .expect("the fixed macOS /tmp alias should be accepted");
    assert_eq!(fs::read(&destination).unwrap(), b"replacement");
}

#[tokio::test]
async fn atomic_replacement_recovers_after_non_regular_destination_failure() {
    let directory = tempdir().expect("temporary directory should be created");
    let root = fs::canonicalize(directory.path()).expect("temporary directory should canonicalize");
    let destination = root.join("download.torrent");
    fs::create_dir(&destination).expect("non-regular destination should be created");

    assert!(atomic_write_replace(&destination, b"replacement")
        .await
        .is_err());
    fs::remove_dir(&destination).expect("failed destination should be removable");

    atomic_write_replace(&destination, b"recovered")
        .await
        .expect("atomic replacement should recover after the failed attempt");
    assert_eq!(
        fs::read(&destination).expect("destination should exist"),
        b"recovered"
    );
}

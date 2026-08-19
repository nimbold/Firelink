use firelink_lib::atomic_write_replace;
use std::fs;
use tempfile::tempdir;

#[tokio::test]
async fn atomic_replacement_replaces_existing_file_repeatedly() {
    let directory = tempdir().expect("temporary directory should be created");
    let destination = directory.path().join("download.torrent");

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
    let target = directory.path().join("target");
    let destination = directory.path().join("download.torrent");
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

#[tokio::test]
async fn atomic_replacement_recovers_after_non_regular_destination_failure() {
    let directory = tempdir().expect("temporary directory should be created");
    let destination = directory.path().join("download.torrent");
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

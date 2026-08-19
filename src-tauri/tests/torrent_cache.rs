use firelink_lib::torrent::{
    cache_torrent_info_hash_at, parse_torrent_bytes, read_cached_torrent_by_info_hash_at,
};
use tempfile::tempdir;

#[tokio::test]
async fn canonical_cache_round_trip_rejects_invalid_bytes_and_source_metadata() {
    let directory = tempdir().expect("temporary directory should be created");
    let root = directory.path().join("torrents");
    let bytes = b"d4:infod6:lengthi5e4:name4:testee";
    let parsed = parse_torrent_bytes(bytes).expect("test torrent should parse");

    let path = cache_torrent_info_hash_at(&root, bytes)
        .await
        .expect("canonical cache write should succeed")
        .expect("canonical cache path should be returned");
    let path = std::path::PathBuf::from(path);
    assert_eq!(
        read_cached_torrent_by_info_hash_at(&root, &parsed.info_hash)
            .await
            .expect("canonical cache read should succeed"),
        Some(bytes.to_vec())
    );

    tokio::fs::write(&path, b"not a torrent")
        .await
        .expect("invalid cache fixture should be writable");
    assert!(
        read_cached_torrent_by_info_hash_at(&root, &parsed.info_hash)
            .await
            .expect("invalid cache should be handled")
            .is_none()
    );
    assert!(!path.exists());

    let tracker_bytes =
        b"d8:announce32:https://tracker.example/announce4:infod6:lengthi5e4:name4:testee";
    let tracker_hash = parse_torrent_bytes(tracker_bytes)
        .expect("tracker-bearing torrent should parse")
        .info_hash;
    let tracker_path = cache_torrent_info_hash_at(&root, tracker_bytes)
        .await
        .expect("tracker metadata should be reusable")
        .expect("tracker cache path should be returned");
    let tracker_path = std::path::PathBuf::from(tracker_path);
    assert_eq!(
        read_cached_torrent_by_info_hash_at(&root, &tracker_hash)
            .await
            .expect("tracker cache should be readable"),
        Some(tracker_bytes.to_vec())
    );
    assert!(cache_torrent_info_hash_at(
        &root,
        b"d4:infod6:lengthi5e4:name4:teste8:url-list22:https://example.test/ae"
    )
    .await
    .expect("web-seed metadata should be handled")
    .is_none());

    let _ = tokio::fs::remove_file(&tracker_path).await;
}

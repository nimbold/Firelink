use firelink_lib::torrent::{
    cache_torrent_info_hash, managed_torrent_info_hash_path, parse_torrent_bytes,
    read_cached_torrent_by_info_hash,
};
use tauri::test::{mock_builder, mock_context, noop_assets};

#[tokio::test]
async fn canonical_cache_round_trip_rejects_invalid_bytes_and_source_metadata() {
    let app = mock_builder()
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let bytes = b"d4:infod6:lengthi5e4:name4:testee";
    let parsed = parse_torrent_bytes(bytes).expect("test torrent should parse");
    let path = managed_torrent_info_hash_path(app.handle(), &parsed.info_hash)
        .expect("canonical cache path should resolve");
    let _ = tokio::fs::remove_file(&path).await;

    assert!(cache_torrent_info_hash(app.handle(), bytes)
        .await
        .expect("canonical cache write should succeed")
        .is_some());
    assert_eq!(
        read_cached_torrent_by_info_hash(app.handle(), &parsed.info_hash)
            .await
            .expect("canonical cache read should succeed"),
        Some(bytes.to_vec())
    );

    tokio::fs::write(&path, b"not a torrent")
        .await
        .expect("invalid cache fixture should be writable");
    assert!(
        read_cached_torrent_by_info_hash(app.handle(), &parsed.info_hash)
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
    let tracker_path = managed_torrent_info_hash_path(app.handle(), &tracker_hash)
        .expect("tracker cache path should resolve");
    let _ = tokio::fs::remove_file(&tracker_path).await;
    assert!(cache_torrent_info_hash(app.handle(), tracker_bytes)
        .await
        .expect("tracker metadata should be reusable")
        .is_some());
    assert_eq!(
        read_cached_torrent_by_info_hash(app.handle(), &tracker_hash)
            .await
            .expect("tracker cache should be readable"),
        Some(tracker_bytes.to_vec())
    );
    assert!(cache_torrent_info_hash(
        app.handle(),
        b"d4:infod6:lengthi5e4:name4:teste8:url-list22:https://example.test/ae"
    )
    .await
    .expect("web-seed metadata should be handled")
    .is_none());

    let _ = tokio::fs::remove_file(&tracker_path).await;
}

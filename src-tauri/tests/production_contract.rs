use firelink_lib::ipc::{TorrentFile, TorrentWebSeed};
use firelink_lib::queue::{
    clamp_download_connections, normalize_aria2_disk_cache, normalize_torrent_bind_address,
    normalize_torrent_dht_message_timeout, normalize_torrent_file_allocation,
    normalize_torrent_web_seeds, EnqueueItem, QueueManager, SpawnPayload,
};
use firelink_lib::retry::{backoff_for, is_permanent_network_error, network_error_class};
use std::time::Duration;

#[test]
fn headless_queue_contracts_reject_unsafe_inputs_and_preserve_bounds() {
    assert_eq!(clamp_download_connections(0), 1);
    assert_eq!(clamp_download_connections(99), 16);
    assert_eq!(normalize_aria2_disk_cache(Some(" 32m ")).unwrap(), "32M");
    assert!(normalize_aria2_disk_cache(Some("0K")).is_err());
    assert_eq!(
        normalize_torrent_bind_address(Some(" 2001:db8::1 ")).unwrap(),
        Some("2001:db8::1".to_string())
    );
    assert!(normalize_torrent_bind_address(Some("not-an-ip")).is_err());
    assert_eq!(normalize_torrent_dht_message_timeout(60).unwrap(), 60);
    assert!(normalize_torrent_dht_message_timeout(61).is_err());
    assert_eq!(normalize_torrent_file_allocation(None).unwrap(), "prealloc");
    assert!(normalize_torrent_file_allocation(Some("sparse")).is_err());
}

#[test]
fn headless_torrent_web_seed_contract_deduplicates_and_expands_per_file() {
    let files = vec![
        TorrentFile {
            index: 1,
            path: "folder/one.bin".to_string(),
            length: 10,
        },
        TorrentFile {
            index: 2,
            path: "two.bin".to_string(),
            length: 20,
        },
    ];
    let seeds = vec![
        TorrentWebSeed {
            file_index: 1,
            uri: "https://mirror.example/base".to_string(),
        },
        TorrentWebSeed {
            file_index: 1,
            uri: "https://mirror.example/base".to_string(),
        },
    ];
    let normalized = normalize_torrent_web_seeds(Some(&seeds), &files).unwrap();
    assert_eq!(normalized.len(), 1);
    let expanded = firelink_lib::queue::expand_torrent_web_seeds(&normalized, &files).unwrap();
    assert_eq!(
        expanded,
        vec![(1, "https://mirror.example/base/folder/one.bin".to_string())]
    );

    let credentialed = [TorrentWebSeed {
        file_index: 1,
        uri: "https://user:pass@mirror.example/file".to_string(),
    }];
    assert!(normalize_torrent_web_seeds(Some(&credentialed), &files).is_err());
    let unknown_file = [TorrentWebSeed {
        file_index: 3,
        uri: "https://mirror.example/file".to_string(),
    }];
    assert!(normalize_torrent_web_seeds(Some(&unknown_file), &files).is_err());
}

#[test]
fn headless_enqueue_contract_strips_torrent_credentials_before_task_creation() {
    let item = EnqueueItem {
        id: "torrent".to_string(),
        queue_id: "main".to_string(),
        url: "https://example.test/file.torrent".to_string(),
        destination: "/tmp".to_string(),
        filename: "file.torrent".to_string(),
        username: Some("user".to_string()),
        password: Some("secret".to_string()),
        headers: Some("Cookie: session=secret".to_string()),
        cookies: Some("session=secret".to_string()),
        is_torrent: Some(true),
        ..EnqueueItem::default()
    };
    let task = item.into_task();
    assert!(task.payload.username.is_none());
    assert!(task.payload.password.is_none());
    assert!(task.payload.headers.is_none());
    assert!(task.payload.cookies.is_none());
}

#[test]
fn headless_queue_lifecycle_eligibility_and_retry_contracts_hold() {
    assert!(QueueManager::<tauri::Wry>::aria2_allocation_phase_eligible(
        &SpawnPayload::default()
    ));
    assert!(
        !QueueManager::<tauri::Wry>::aria2_allocation_phase_eligible(&SpawnPayload {
            is_media: true,
            ..SpawnPayload::default()
        })
    );
    assert!(
        !QueueManager::<tauri::Wry>::aria2_allocation_phase_eligible(&SpawnPayload {
            is_torrent: true,
            torrent_file_allocation: Some("none".to_string()),
            ..SpawnPayload::default()
        })
    );
    assert!(
        !QueueManager::<tauri::Wry>::aria2_allocation_phase_eligible(&SpawnPayload {
            is_torrent: true,
            torrent_file_allocation: Some("prealloc".to_string()),
            ..SpawnPayload::default()
        })
    );
    assert_eq!(backoff_for(0), Duration::from_secs(2));
    assert_eq!(backoff_for(usize::MAX), Duration::from_secs(10));
    assert_eq!(
        network_error_class("HTTP/1.1 503 Service Unavailable"),
        "http"
    );
    assert!(is_permanent_network_error("HTTP 403 Forbidden"));
}

#[derive(serde::Deserialize, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
struct TorrentPeerOptionsArgs {
    id: String,
    max_peers: Option<i64>,
    peer_speed_limit: Option<String>,
}

#[derive(serde::Deserialize, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
struct TorrentFileSelectionArgs {
    id: String,
    selected_indices: Option<Vec<u32>>,
}

#[derive(serde::Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct BuggyTorrentPeerOptionsArgs {
    id: String,
    max_peers: Option<i64>,
    peer_speed_limit: Option<String>,
}

#[derive(serde::Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct BuggyTorrentFileSelectionArgs {
    id: String,
    selected_indices: Option<Vec<u32>>,
}

#[test]
fn ipc_snake_case_deserialization_contract_preserves_torrent_arguments() {
    let peer_payload = serde_json::json!({
        "id": "dl-123",
        "max_peers": 42,
        "peer_speed_limit": "2M"
    });

    // The fixed snake_case contract receives and preserves the frontend's arguments:
    let fixed_peer: TorrentPeerOptionsArgs = serde_json::from_value(peer_payload.clone())
        .expect("snake_case deserializer should parse torrent peer options");
    assert_eq!(fixed_peer.id, "dl-123");
    assert_eq!(fixed_peer.max_peers, Some(42));
    assert_eq!(fixed_peer.peer_speed_limit.as_deref(), Some("2M"));

    // The buggy default camelCase contract dropped the arguments to None silently:
    let buggy_peer: BuggyTorrentPeerOptionsArgs = serde_json::from_value(peer_payload)
        .expect("camelCase deserializer parses but silently drops snake_case keys");
    assert_eq!(buggy_peer.id, "dl-123");
    assert_eq!(buggy_peer.max_peers, None);
    assert_eq!(buggy_peer.peer_speed_limit, None);

    let selection_payload = serde_json::json!({
        "id": "dl-456",
        "selected_indices": [1, 3, 5]
    });

    // The fixed snake_case contract receives and preserves selected file indices:
    let fixed_selection: TorrentFileSelectionArgs = serde_json::from_value(selection_payload.clone())
        .expect("snake_case deserializer should parse selected indices");
    assert_eq!(fixed_selection.id, "dl-456");
    assert_eq!(fixed_selection.selected_indices, Some(vec![1, 3, 5]));

    // The buggy default camelCase contract dropped selected indices to None (selecting all files):
    let buggy_selection: BuggyTorrentFileSelectionArgs = serde_json::from_value(selection_payload)
        .expect("camelCase deserializer parses but silently drops snake_case keys");
    assert_eq!(buggy_selection.id, "dl-456");
    assert_eq!(buggy_selection.selected_indices, None);
}

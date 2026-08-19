use firelink_lib::ipc::{TorrentFile, TorrentWebSeed};
use firelink_lib::queue::{expand_torrent_web_seeds, normalize_torrent_web_seeds};

#[test]
fn web_seed_normalization_preserves_one_based_file_ownership() {
    let files = vec![
        TorrentFile {
            index: 1,
            path: "one.bin".to_string(),
            length: 1,
        },
        TorrentFile {
            index: 2,
            path: "nested/two.bin".to_string(),
            length: 2,
        },
    ];
    let seeds = vec![
        TorrentWebSeed {
            file_index: 2,
            uri: " https://cdn.example/assets/ ".to_string(),
        },
        TorrentWebSeed {
            file_index: 1,
            uri: "https://cdn.example/one".to_string(),
        },
        TorrentWebSeed {
            file_index: 2,
            uri: "https://cdn.example/assets/".to_string(),
        },
    ];

    let normalized = normalize_torrent_web_seeds(Some(&seeds), &files)
        .expect("valid web seeds should normalize");
    assert_eq!(normalized.len(), 2);
    assert_eq!(normalized[0].file_index, 2);
    assert_eq!(normalized[1].file_index, 1);
    assert_eq!(
        expand_torrent_web_seeds(&normalized, &files).expect("web seeds should expand"),
        vec![
            (2, "https://cdn.example/assets/nested/two.bin".to_string()),
            (1, "https://cdn.example/one/one.bin".to_string()),
        ]
    );

    for uri in [
        "ftp://cdn.example/file",
        "https://user:pass@cdn.example/file",
        "https://cdn.example/file#fragment",
    ] {
        assert!(normalize_torrent_web_seeds(
            Some(&[TorrentWebSeed {
                file_index: 1,
                uri: uri.to_string()
            }]),
            &files,
        )
        .is_err());
    }
    assert!(normalize_torrent_web_seeds(
        Some(&[TorrentWebSeed {
            file_index: 0,
            uri: "https://cdn.example/file".to_string()
        }]),
        &files,
    )
    .is_err());
}

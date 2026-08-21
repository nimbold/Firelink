# Headless Download Tests

Run the full Rust suite:

```sh
cd src-tauri
cargo test --all-targets
```

Run the queue-manager harness when changing aria2 scheduling, concurrency, and
retry behavior:

```sh
cd src-tauri
cargo test --test queue_manager -- --nocapture
```

Run the media metadata smoke test with an explicit URL when changing yt-dlp
integration:

```sh
cd src-tauri
FIRELINK_LIVE_YOUTUBE_URL='https://www.youtube.com/watch?v=dQw4w9WgXcQ' \
  cargo test filters_live_youtube_metadata_from_env --lib -- --ignored --nocapture
```

Run the real local Torrent runtime smoke test against the host bundled Aria2
binary. It starts a local tracker and two Aria2 daemons, then covers magnet
metadata resolution, saved-metadata hash validation, selected-file output,
pause/resume, ownership reporting, and cancel/remove:

```sh
npm run smoke:torrent
```

Use `node scripts/smoke-torrent.js --binary /path/to/aria2c` when validating a
packaged or target-specific Aria2 binary.

Run the HTTP-boundary Torrent RPC integration test. It drives the production
Aria2 RPC client through a local JSON-RPC server and verifies successful
requests plus HTTP gateway errors:

```sh
npm run test:torrent:rpc
```

Run the deterministic unavailable-tracker and Aria2-daemon-exit checks with:

```sh
npm run smoke:torrent:failure-paths
```

Native CI runs this failure-path smoke after staging the target-specific
bundled engines on macOS, Windows, and Linux. Windows executes the Torrent RPC,
atomic-storage, canonical-cache, and web-seed normalization targets, while
compiling (but not executing) the queue-manager and library test binaries;
the Tauri mock harness exits before running on the Windows runner. The
headless `production_contract` target still executes queue admission,
normalization, credential-boundary, and retry contracts on Windows without
constructing a Tauri mock application.

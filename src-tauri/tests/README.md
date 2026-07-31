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

Run the deterministic unavailable-tracker and Aria2-daemon-exit checks with:

```sh
npm run smoke:torrent:failure-paths
```

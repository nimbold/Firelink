# Firelink

Firelink is a clean SwiftUI download manager for Apple Silicon Macs. The goal is to bring the practical parts of IDM/FDM-style download management to macOS with a native interface, segmented downloads, queue control, automatic file organization, and credential-aware transfers.

This project is early, but it already has a working native prototype, an `aria2c`-backed download engine, a queue-focused UI, batch link intake, and app-wide settings.

## Features

- Native SwiftUI macOS interface.
- Segmented downloads with a per-file connection count that also controls the split count.
- Multiple files downloading at the same time.
- Queue-based downloads with drag-and-drop priority ordering.
- Batch Add Downloads window for pasting one or many links at once.
- Automatic link parsing from newlines, whitespace, and common separators.
- Metadata preview for new downloads, including file size when the server reports it.
- Total required disk space and available disk space summary before adding downloads.
- Per-batch save location override, while keeping automatic file-type folders by default.
- Native macOS Settings window, available from App menu > Settings and the main toolbar.
- Configurable default per-server connection count.
- Configurable parallel file download limit in Settings.
- Per-batch connection controls in the Add Downloads window.
- Sidebar filters for all downloads, queued, active, completed, failed, and file categories.
- Sortable, resizable download table columns with a right-click column chooser.
- Default table columns for file name, size, progress/status, ETA, last try date, and date added.
- Download row context menu with properties, show in Finder, resume, stop, queue, and delete actions.
- Download properties window for editing URL, file name, save location, connection count, and login behavior.
- Delete confirmation with optional move-to-Trash for downloaded or partial files.
- Automatic cleanup of unfinished `.aria2` cache files when removing incomplete downloads.
- Automatic save folders under `~/Downloads`:
  - `Musics`
  - `Movies`
  - `Compressed`
  - `Pictures`
  - `Documents`
  - `Other`
- Custom download locations per file category.
- Broad file extension detection for audio, video, archive, image, and document formats.
- HTTP, HTTPS, FTP, and SFTP URL support through `aria2c`.
- Site login rules with URL pattern matching and Keychain-stored passwords.
- Optional prevention of system sleep while files are downloading, while still allowing display sleep.
- Pause, resume, cancel, delete, progress, speed, ETA, and connection count display.
- Release `.app` bundle script for local macOS builds.

## Engine

This first version uses `aria2c` as the download engine. It is a better fit than plain `curl` for the requested IDM/FDM-style behavior because it has segmented downloads, resumable transfers, concurrent downloads, HTTP/FTP/SFTP support, and username/password options built in.

Firelink uses one per-file connection value for both `aria2c` split count and same-server connection count. That keeps the download behavior close to the familiar IDM-style model: choosing 8 connections splits the file into 8 parallel segments.

## Requirements

Install the engine:

```sh
brew install aria2
```

- macOS 14 or newer.
- Apple Silicon Mac.
- Swift 6 toolchain.
- `aria2c` installed with Homebrew, or bundled into the app resources later.

## Run

```sh
swift run Firelink
```

Build a release `.app` bundle:

```sh
make app
open build/Firelink.app
```

Because the current machine only has Command Line Tools selected, this repository is set up as a Swift Package with a bundling script rather than a generated Xcode project. Opening the package in Xcode will still give you a native macOS app workflow.

## Roadmap

- Persist download history, queue order, column choices, and active download state across launches.
- Bundle or manage `aria2c` automatically so users do not need a separate Homebrew install.
- Add first-class pause/resume semantics with clearer partial-file and cache handling.
- Add per-download and global speed limits, plus scheduler rules for start/stop windows.
- Add retry policies, mirror fallback, and richer failure recovery for unstable servers.
- Add browser integration or a companion extension for capturing download links from Safari/Chrome/Firefox.
- Add cookie/header support for authenticated downloads that require browser sessions.
- Improve site-login editing, credential migration, and matching diagnostics.
- Add duplicate detection for URLs, file names, and already-downloaded files.
- Add checksum/hash verification and optional post-download integrity checks.
- Add download history search, saved filters, and better category management.
- Add signed/notarized release builds, auto-update support, and downloadable GitHub releases.
- Add localization-ready strings and accessibility review for keyboard and VoiceOver workflows.
- Add unit and integration tests for file classification, URL parsing, queue behavior, settings persistence, `aria2c` progress parsing, and metadata fetching.

## License

Firelink is released under the MIT License. See [LICENSE](LICENSE).

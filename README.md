<p align="center">
  <img src="src/assets/app-icon.png" alt="Firelink app icon" width="128" height="128" />
</p>

# Firelink

> A fast, focused desktop download manager for macOS, Windows, and Linux.

[![Latest release](https://img.shields.io/github/v/release/nimbold/Firelink?style=flat-square)](https://github.com/nimbold/Firelink/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/nimbold/Firelink/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/nimbold/Firelink/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/nimbold/Firelink?style=flat-square)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-Apple%20silicon-111111?style=flat-square&logo=apple&logoColor=white)](#installation)
[![Windows](.github/badges/windows.svg)](#installation)
[![Linux](https://img.shields.io/badge/Linux-x64-FCC624?style=flat-square&logo=linux&logoColor=black)](#installation)

<p align="center">
  <img src="Screenshots/Dark%20theme%20-%20main.png" width="24%" alt="Firelink dark theme main window" />
  <img src="Screenshots/Dark%20theme%20-%20add%20window.png" width="24%" alt="Firelink dark theme add window" />
  <img src="Screenshots/Light%20theme%20-%20main.png" width="24%" alt="Firelink light theme main window" />
  <img src="Screenshots/Light%20theme%20-%20add%20window.png" width="24%" alt="Firelink light theme add window" />
</p>

## What is Firelink?

Firelink manages direct downloads, browser captures, media, playlists, queues, and scheduling from one desktop app.

It uses a Rust and Tauri backend with a React and TypeScript interface. Required download and media engines are bundled with the app.

## Status

Firelink `1.3.0` is the latest desktop release.

It is paired with [the latest Firelink Companion release, `2.1.0`](https://github.com/nimbold/Firelink-Extension/releases/tag/v2.1.0).

The project is actively maintained. See the [changelog](CHANGELOG.md) for release history and current work.

Translations are available for English, Simplified Chinese, Hebrew, Persian, Ukrainian, and Russian. Translation corrections are welcome.

## Features

- Segmented HTTP and HTTPS downloads with retries, speed limits, and connection controls.
- Media and playlist downloads through yt-dlp, FFmpeg, and Deno.
- An Add window for metadata, duplicate handling, save locations, and download options.
- Persistent queues with pause, resume, retry, redownload, and scheduling.
- Live speed and connection controls for active downloads.
- A customizable download table with sorting, column selection, reordering, and bulk actions.
- File organization with categories, default folders, and per-download locations.
- Appearance preferences with window styles, multilingual fonts, and localized calendar dates.
- Browser handoff through local pairing and signed requests.
- Tray controls, notifications, sounds, sleep prevention, and secure credential storage.
- RTL support for Hebrew and Persian.

## Installation

Download the [latest Firelink release](https://github.com/nimbold/Firelink/releases/latest).

| Platform | Package | Notes |
| --- | --- | --- |
| macOS Apple silicon | `.dmg` | Ad-hoc signed and not notarized. macOS may require approval in **System Settings -> Privacy & Security**. |
| Windows x64 | NSIS `.exe` | Unsigned. Windows SmartScreen may display a warning. |
| Windows x64 portable | `.zip` | Extract to a writable folder and launch `firelink.exe`. |
| Linux x64 | `.deb`, `.rpm`, or `.AppImage` | Choose the package for your distribution, or use AppImage. |

All packages include aria2, yt-dlp, FFmpeg, Deno, and SQLite support. No separate engine installation is required.

<details>
<summary><strong>Windows portable ZIP notes</strong></summary>

- Keep the folder writable. Avoid `Program Files` and read-only media.
- Settings, queues, logs, and WebView data are stored beside the executable in `data/`.
- Close Firelink before moving or copying the folder.
- Treat the folder as sensitive because it contains the extension pairing credential.
- The installer remains the supported path for `firelink://` browser launch registration.

</details>

## Browser integration

[Firelink Companion `2.1.0`](https://github.com/nimbold/Firelink-Extension/releases/tag/v2.1.0) connects browser downloads, links, and media pages to Firelink. Use the latest Companion release with the latest Firelink release.

Captured links open Firelink's Add window for review before they are started or queued.

<p>
  <a href="https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/"><img src="https://img.shields.io/badge/Install%20from-Firefox%20Add--ons-FF7139?style=for-the-badge&logo=firefox-browser&logoColor=white" alt="Install from Firefox Add-ons" /></a>&nbsp;&nbsp;
  <a href="https://github.com/nimbold/Firelink-Extension#manual-chromium-installation"><img src="https://img.shields.io/badge/Manual%20install-Chromium-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Manual install for Chromium browsers" /></a>
</p>

See the [Companion README](https://github.com/nimbold/Firelink-Extension#readme) for browser installation, pairing, and privacy details.

## Development

### Requirements

- Node.js 22 or newer
- npm
- Rust and Cargo
- [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)

### Quick start

```sh
git clone --recurse-submodules https://github.com/nimbold/Firelink.git
cd Firelink
npm install
npm run tauri dev
```

Run the main checks with:

```sh
node --test scripts/*.node-test.js
npm test -- --run
npm run build
cd src-tauri && cargo test --all-targets
```

See [RELEASE.md](RELEASE.md) for engine provisioning, packaging, and release verification.

## Contributing and support

- Report bugs and request features in [GitHub Issues](https://github.com/nimbold/Firelink/issues).
- Open focused pull requests with tests for behavior changes.
- Report translation corrections in an issue or pull request.
- Read [CHANGELOG.md](CHANGELOG.md) for release history.

## Credits

Core technologies:

- [Tauri 2](https://v2.tauri.app/), [Rust](https://www.rust-lang.org/), [Tokio](https://tokio.rs/)
- [React](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Zustand](https://zustand-demo.pmnd.rs/)
- [SQLite](https://www.sqlite.org/)

Bundled engines:

- [aria2](https://aria2.github.io/)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [FFmpeg](https://ffmpeg.org/)
- [Deno](https://deno.com/)

Font licenses, engine versions, source references, and third-party notices are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Firelink is available under the [MIT License](LICENSE). Bundled tools and fonts retain their own licenses.

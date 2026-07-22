<div align="center">
  <img src="src/assets/app-icon.png" alt="Firelink" width="112" height="112" />

  # Firelink

  **A fast, focused desktop download manager for macOS, Windows, and Linux.**

  [![Version](https://img.shields.io/badge/version-1.2.0-6f42c1?style=flat-square)](https://github.com/nimbold/Firelink/releases)
  [![macOS](https://img.shields.io/badge/macOS-111111?style=flat-square&logo=apple&logoColor=white)](#supported-platforms)
  [![Windows](.github/badges/windows.svg)](#supported-platforms)
  [![Linux](https://img.shields.io/badge/Linux-FCC624?style=flat-square&logo=linux&logoColor=black)](#supported-platforms)
  [![License](https://img.shields.io/github/license/nimbold/Firelink?style=flat-square)](LICENSE)
  [![CI](https://img.shields.io/github/actions/workflow/status/nimbold/Firelink/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/nimbold/Firelink/actions/workflows/ci.yml)

  [Features](#features) · [Install](#installation) · [Browser Extension](#browser-extension) · [Development](#development) · [Changelog](CHANGELOG.md)
</div>

<br/>

<div align="center">
  <img src="Screenshots/Dark%20theme%20-%20main.png" width="24%" alt="Firelink dark theme main window" />
  <img src="Screenshots/Dark%20theme%20-%20add%20window.png" width="24%" alt="Firelink dark theme add window" />
  <img src="Screenshots/Light%20theme%20-%20main.png" width="24%" alt="Firelink light theme main window" />
  <img src="Screenshots/Light%20theme%20-%20add%20window.png" width="24%" alt="Firelink light theme add window" />

  <details>
    <summary><b>View more screenshots</b></summary>
    <br/>
    <img src="Screenshots/Dark%20theme%20-%20settings.png" width="32%" alt="Firelink dark theme settings" />
    <img src="Screenshots/Light%20theme%20-%20settings.png" width="32%" alt="Firelink light theme settings" />
  </details>
</div>

## Overview

Firelink manages direct downloads, browser captures, media extraction, playlists, scheduling, and file placement from one desktop app. It uses a Rust/Tauri backend with a React and TypeScript interface, and bundles the engines needed for its download and media workflows.

The current desktop release is **1.2.0**, paired with [Firelink Companion 2.0.6](https://github.com/nimbold/Firelink-Extension/releases). The release focuses on a more dependable download table and queue, better browser handoffs, broader localization, and safer packaged builds.

## Features

- **Segmented downloads** with aria2, retries, speed limits, and connection controls.
- **Media downloads** with yt-dlp, FFmpeg, Deno, live progress, speed, and ETA.
- **Playlist downloads** for YouTube playlists with queueing and efficient rendering for large lists.
- **Customizable download table** with selectable columns, sorting, drag-to-reorder, and bulk actions.
- **Add window** for metadata, duplicate handling, captured links, clipboard-prefilled URLs, save locations, and live connection limits.
- **Persistent queues** with pause, resume, retry, redownload, scheduling, and multi-select actions.
- **Optional batch folders** for grouping related multi-link downloads in a new, editable folder.
- **File organization** with categories, default folders, per-download overrides, and reveal/trash actions.
- **Browser handoff** through local pairing, signed requests, Add-window review, replay protection, and server checks.
- **Desktop integration** with tray controls, notifications, sounds, sleep prevention, and secure credential storage.
- **Localization** for English, Simplified Chinese, Hebrew, Persian, Ukrainian, and Russian, with RTL support. Non-English translations are LLM-assisted and welcome user review.
- **Diagnostics** with engine health checks, structured logs, and package verification.

## Installation

Download desktop builds from [GitHub Releases](https://github.com/nimbold/Firelink/releases).

| Platform | Package | Notes |
| --- | --- | --- |
| **macOS Apple silicon** | `.dmg` | Not notarized. If macOS blocks the first launch, approve Firelink in **System Settings -> Privacy & Security**. |
| **Windows x64** | NSIS `.exe` installer | Unsigned. Windows SmartScreen may warn until code signing is added. |
| **Windows x64 portable** | `.zip` archive | Extract to a writable folder and launch `firelink.exe`. See the notes below. |
| **Linux x64** | `.deb`, `.rpm`, or `.AppImage` | Choose the package for your distribution, or use AppImage as the self-contained option. |

All packages include aria2, yt-dlp, FFmpeg, Deno, and SQLite support. You do not need to install those engines separately.

<details>
<summary><strong>Windows portable ZIP notes</strong></summary>

The portable ZIP is a secondary distribution. Extract it to a writable folder and launch `firelink.exe`:

- Keep it out of `Program Files`, read-only media, and folders that block SQLite or WebView writes.
- Settings, queues, logs, and WebView data stay beside the executable under `data/`.
- Close Firelink before moving or copying the folder, and close the installed app before launching the portable copy.
- Credentials, browser cookies, and URL query or fragment data are not saved in portable queue records.
- Saved site passwords remain in the Windows credential store and are not copied into the archive.
- The folder contains the extension pairing credential. Treat it as sensitive and do not share it.
- Saved absolute download locations may need to be selected again after moving the folder to another drive.
- The installer remains the supported path for `firelink://` browser launch registration.

</details>

## Browser Extension

[Firelink Companion](https://github.com/nimbold/Firelink-Extension) connects browser downloads, links, and media pages to Firelink. Captured downloads always open Firelink's Add window so you can review them before starting or queuing them.

It provides automatic capture for regular downloads, explicit **Fetch media** actions, link and selected-text context menus, Firefox and Chromium support, signed local requests, and a safe browser fallback when Firelink is unavailable.

<p align="center">
  <a href="https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/"><img src="https://img.shields.io/badge/Install%20from-Firefox%20Add--ons-FF7139?style=for-the-badge&logo=firefox-browser&logoColor=white" alt="Install Firelink Companion from Firefox Add-ons" /></a>
  &nbsp;&nbsp;
  <a href="https://github.com/nimbold/Firelink-Extension#manual-chromium-installation"><img src="https://img.shields.io/badge/Manual%20install-Chromium-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Read manual Chromium install instructions" /></a>
</p>

Install the extension, open Firelink, and pair it from **Settings -> Integrations**. Use the latest [Firelink Companion 2.0.6 release](https://github.com/nimbold/Firelink-Extension/releases) with Firelink 1.2.0. Chromium users can load `firelink-chromium.zip` by following the [manual installation instructions](https://github.com/nimbold/Firelink-Extension#manual-chromium-installation).

## Supported Platforms

| Target | Status |
| --- | --- |
| **macOS arm64** | Supported with a native build, bundled-engine checks, launch smoke test, and ad-hoc-signed DMG workflow. |
| **Windows x64** | Supported with a native build, engine checks, installer smoke test, NSIS installer, and portable ZIP. |
| **Linux x64** | Supported with native builds, bundled-engine checks, package/AppImage smoke tests, `.deb`, `.rpm`, and AppImage packages. |

## Development

### Requirements

- Node.js 22 or newer
- npm
- Rust and Cargo
- [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)

Clone the repository with its browser-extension submodule:

```sh
git clone --recurse-submodules https://github.com/nimbold/Firelink.git
cd Firelink
npm install
```

Launch the app with `npm run tauri dev`. Run the core checks with:

```sh
node --test scripts/*.node-test.js
npm test -- --run
npm run build
cd src-tauri
cargo test --all-targets
```

See [RELEASE.md](RELEASE.md) for engine provisioning, packaging, and release verification.

## Help and Project Status

- Report bugs or request improvements in [GitHub Issues](https://github.com/nimbold/Firelink/issues).
- Read [CHANGELOG.md](CHANGELOG.md) for release history.
- The project is actively maintained, but macOS builds are not notarized and Windows installers are not code-signed yet.

## Technology and License

Firelink is built with [Tauri 2](https://tauri.app/), [Rust](https://www.rust-lang.org/), [Tokio](https://tokio.rs/), [React](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Zustand](https://zustand-demo.pmnd.rs/), [SQLite](https://www.sqlite.org/), [aria2](https://aria2.github.io/), [yt-dlp](https://github.com/yt-dlp/yt-dlp), [FFmpeg](https://ffmpeg.org/), and [Deno](https://deno.com/).

Firelink is available under the [MIT License](LICENSE).

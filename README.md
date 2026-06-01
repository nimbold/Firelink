<div align="center">
  <h1>Firelink</h1>
  <p><strong>A clean, native SwiftUI download manager for Apple Silicon macOS</strong></p>

  [![Swift Version](https://img.shields.io/badge/Swift-6.0-orange?logo=swift&logoColor=white)](https://swift.org)
  [![Platform Support](https://img.shields.io/badge/macOS-14.0%2B-blue?logo=apple&logoColor=white)](https://apple.com)
  [![Engine](https://img.shields.io/badge/Engine-aria2c-red?logo=terminal&logoColor=white)](https://aria2.github.io/)
  [![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)
</div>

---

**Firelink** brings the efficiency of multi-segmented download managers (like IDM or FDM) to macOS with a modern, native SwiftUI interface. Designed specifically for Apple Silicon, it delivers high-speed concurrent transfers, drag-and-drop queue control, automated file organization, and Keychain-secured authentication—all in a lightweight native package.

---

## ✨ Key Features

- ⚡ **High-Speed Downloads:** Multi-segmented download engine powered by `aria2c` for concurrent connections and optimal bandwidth utilization. Supports HTTP, HTTPS, FTP, and SFTP.
- 🎨 **Native macOS & SwiftUI:** Responsive interface designed natively for Apple Silicon, featuring resizable tables, customizable columns, sidebar filters, and a native Settings panel.
- 🗂️ **Smart Queue & Categories:** Drag-and-drop priority ordering, batch link ingestion with smart parsing, and automatic file organization (`Musics`, `Movies`, `Compressed`, `Pictures`, `Documents`, `Other`) based on extension detection.
- 🔒 **Keychain Security:** Local macOS Keychain integration for secure site credential storage and matching during transfers.
- ⚙️ **Power & System Integrity:** Optional system sleep prevention during active downloads, disk-space safety checks, and automated cleanup of partial `.aria2` metadata cache files.

<details>
<summary>🔍 View Full Feature Index (30+ features)</summary>

### All native SwiftUI macOS features:

- **Core Download Engine:**
  - Segmented downloads with per-file connection/split counts.
  - Multi-threaded, parallel downloading with configurable limits.
  - Support for HTTP, HTTPS, FTP, and SFTP transfers via `aria2c`.
- **Advanced Queue Control:**
  - Drag-and-drop download reordering to manage priorities.
  - Comprehensive download table with resizable, custom columns (Name, Size, Status, ETA, Dates).
  - Individual download controls: pause, resume, stop, and queue actions.
- **Smart Link Ingestion:**
  - Batch Add window for pasting multiple links at once.
  - Automated link parsing (whitespaces, newlines, standard separators).
  - Disk space availability checks and total size calculation prior to adding.
- **File Organization:**
  - Automatic categorization of files (Music, Movies, Compressed, Documents, Images) into structured subfolders under `~/Downloads`.
  - Smart fallback to customizable download folders per category.
  - Automatic cleanup of unfinished `.aria2` metadata/cache files on removal.
- **Security & System:**
  - Local macOS Keychain integration for site logins.
  - Prevents system sleep while active transfers are in progress, preserving display sleep.
  - Release `.app` bundle build scripts ready for distribution.

</details>

---

## ⚙️ Engine Architecture

Firelink leverages `aria2c` under the hood as its core download engine. Unlike standard `curl`, `aria2c` allows:
- **Segmented Downloads:** Splits files into multiple streams for maximum transfer speeds.
- **Unified Connection Control:** A single slider regulates both the server connection count and segment split count, matching the intuitive behavior of classic managers like IDM/FDM.
- **Built-in Resumability:** Seamlessly resumes interrupted or paused downloads without data corruption.

---

## 🛠️ Requirements & Setup

### 1. Install Dependencies
Ensure you have **Homebrew** and the **Swift toolchain** installed:
```bash
brew install aria2
```
- **OS Support:** macOS 14.0 or newer (built natively for Apple Silicon)
- **Toolchain:** Xcode 15+ / Swift 6.0 toolchain

### 2. Build & Run
Run the application directly via the terminal:
```bash
swift run Firelink
```

Or build a production `.app` bundle:
```bash
make app && open build/Firelink.app
```

---

## 🗺️ Roadmap

- [ ] **Data Persistence:** Store history, column layout preferences, and active queues across restarts.
- [ ] **Zero-Config Setup:** Automatically bundle and configure `aria2c` inside the `.app` bundle.
- [ ] **Bandwidth Limits:** Add global and per-download speed caps and calendar schedules.
- [ ] **Browser Extensions:** Capture links directly from Safari, Chrome, and Firefox.
- [ ] **Advanced Transfer Features:** Checksum validation, cookie/header ingestion, and smart mirror failovers.
- [ ] **Distribution:** Notarized release builds, automated Sparkle updates, and Homebrew formulae.

---

## 📄 License

Firelink is released under the MIT License. See [LICENSE](LICENSE) for details.

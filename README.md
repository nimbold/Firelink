<div align="center">
  <img src="Resources/AppIcon.png" alt="Firelink Icon" width="128" height="128" />
  <h1>Firelink</h1>
  <p><strong>The modern, blazing-fast download manager built natively for Apple Silicon macOS.</strong></p>

  <a href="https://swift.org"><img src="https://img.shields.io/badge/Swift-6.0-orange?logo=swift&logoColor=white" alt="Swift Version" /></a>
  <a href="https://apple.com"><img src="https://img.shields.io/badge/macOS-14.0%2B-blue?logo=apple&logoColor=white" alt="Platform Support" /></a>
  <a href="https://aria2.github.io/"><img src="https://img.shields.io/badge/Engine-aria2c-red?logo=terminal&logoColor=white" alt="Engine" /></a>
  <a href="https://github.com/yt-dlp/yt-dlp"><img src="https://img.shields.io/badge/Engine-yt--dlp-red?logo=youtube&logoColor=white" alt="yt-dlp Engine" /></a>
  <a href="https://ffmpeg.org/"><img src="https://img.shields.io/badge/Engine-ffmpeg-red?logo=ffmpeg&logoColor=white" alt="ffmpeg Engine" /></a>
  <a href="https://deno.com/"><img src="https://img.shields.io/badge/Engine-deno-blue?logo=deno&logoColor=white" alt="Deno Engine" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="License" /></a>
</div>

---

**Firelink** reimagines macOS file downloading by wrapping legendary open-source engines (`aria2c`, `yt-dlp`, and `ffmpeg`) in a beautifully crafted, highly polished SwiftUI interface. Enjoy high-speed segmented downloads, native media extraction, seamless browser integration, and intelligent file organization without compromising on the aesthetics of your Mac.

---

## 📸 Screenshots

<div align="center">
  <img src="Resources/Screenshots/Dark/MainPage.png" alt="Firelink main window" width="32%" />
  <img src="Resources/Screenshots/Dark/AddWindow.png" alt="Add downloads window" width="32%" />
  <img src="Resources/Screenshots/Dark/Settings.png" alt="Settings" width="32%" />
  <br/>
  <sub>A premium native experience, from batch linking to advanced settings.</sub>
</div>

<details>
<summary><b>Light Theme Screenshots</b></summary>
<br/>

<div align="center">
  <img src="Resources/Screenshots/Light/MainPage.png" alt="Firelink main window light theme" width="32%" />
  <img src="Resources/Screenshots/Light/AddWindow.png" alt="Add downloads window light theme" width="32%" />
  <img src="Resources/Screenshots/Light/Settings.png" alt="Settings light theme" width="32%" />
</div>

</details>

---

## ✨ Features

- ⚡ **Multi-Segmented Engine:** Ultra-fast parallel downloading powered by `aria2c` with configurable speed limits and a built-in download scheduler.
- 🪄 **Media Downloader:** Instantly extract high-quality media (4K, 1080p, MP3) with smart cascading format pickers, powered by bundled `yt-dlp` and `ffmpeg`.
- 🎨 **Premium Native UI:** A responsive, frosted-glass SwiftUI interface strictly adhering to Apple Human Interface Guidelines, featuring a visual chunk map and dynamic progress tracking.
- 🌐 **Seamless Browser Integration:** Send downloads directly from your browser via the secure Firelink Companion extension.
- 🛡️ **Privacy & Security:** Zero-configuration setup with deferred Keychain integration and secure HMAC-SHA256 authenticated local API endpoints ensure your system remains strictly isolated and protected from malicious scripts.
- 🗂️ **Smart Organization:** Auto-categorizes incoming files and remembers your preferred download locations.
- 🔄 **Native Updater:** Built-in seamless GitHub release checking for lightweight and transparent app updates.

---

## 🧩 Browser Integration

We are live! Send downloads directly from your browser to the Firelink app with zero friction.

<a href="https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/"><img src="https://img.shields.io/badge/Install%20on%20Firefox-FF7139?logo=firefox-browser&logoColor=white&style=for-the-badge" alt="Install on Firefox" /></a>

*(Check out the [Firelink-Extension source code](https://github.com/nimbold/Firelink-Extension) to contribute or learn more.)*

---

## 🌍 Cross-Platform Evolution (Firelink v2)

We are currently rewriting Firelink from the ground up using **Tauri, React, and Rust** to bring our blazing-fast native experience to Windows and Linux, while maintaining our standard of excellence on macOS.

### 🚀 Development Progress
- [x] **Core Engine Port:** `aria2c` and `yt-dlp` integration in Rust
- [x] **UI Foundation:** Pixel-perfect React + Tailwind interface
- [x] **Settings & State:** Fully wired frontend-to-backend communication
- [ ] **Cross-Platform Binaries:** Automated builds for Windows (`.exe`) and Linux (`.AppImage`)
- [ ] **Feature Parity:** Porting remaining media extraction and scheduler features

*Stay tuned as we prepare our first true cross-platform beta release!*

---

## 🛠️ Quick Start

**OS Support:** macOS 14.0 or newer (Apple Silicon natively).

Run the application directly:
```bash
swift run Firelink
```

Or build a production `.app` bundle:
```bash
make app && open build/Firelink.app
```

---

## 🏆 Credits

Firelink stands on the shoulders of giants. A massive thank you to the contributors of these phenomenal open-source projects:
- **[aria2](https://aria2.github.io/)** - The legendary multi-protocol download utility driving our core engine.
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** - The definitive command-line audio/video downloader.
- **[FFmpeg](https://ffmpeg.org/)** - The industry standard for media stream manipulation and merging.
- **[Deno](https://deno.com/)** - The secure runtime for JavaScript and TypeScript solving complex media extraction challenges.

---

## 📄 License

Firelink is released under the MIT License. See [LICENSE](LICENSE) for details.

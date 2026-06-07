<div align="center">
  <img src="Resources/AppIcon.png" alt="Firelink Icon" width="128" height="128" />
  <h1>Firelink</h1>
  <p><strong>The modern, blazing-fast download manager built natively for Apple Silicon macOS.</strong></p>

  <a href="https://swift.org"><img src="https://img.shields.io/badge/Swift-6.0-orange?logo=swift&logoColor=white" alt="Swift Version" /></a>
  <a href="https://apple.com"><img src="https://img.shields.io/badge/macOS-14.0%2B-blue?logo=apple&logoColor=white" alt="Platform Support" /></a>
  <a href="https://aria2.github.io/"><img src="https://img.shields.io/badge/Engine-aria2c-red?logo=terminal&logoColor=white" alt="Engine" /></a>
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

---

## ✨ Features

- ⚡ **Multi-Segmented Engine:** Ultra-fast parallel downloading powered by `aria2c`.
- 🪄 **Media Downloader:** Instantly extract high-quality audio and video formats (4K, 1080p, MP3) from sites like YouTube and Twitter—backed securely by `yt-dlp` and `ffmpeg` via our Add-on Gatekeeper.
- 🎨 **Premium Native UI:** Responsive, frosted-glass SwiftUI design tailor-made for Apple Silicon.
- 🌐 **Seamless Integration:** Send links directly from your browser with the Firelink Companion extension.
- 🎯 **Visual Chunk Map:** Monitor active segment connections and download progress in real time.
- 🗂️ **Smart Organization:** Auto-categorizes files into `Musics`, `Movies`, `Compressed`, and more.
- 🛡️ **Reliable & Secure:** Deep Keychain integration for authenticated downloads, zero-configuration setup, and automatic recovery.

---

## 🧩 Browser Integration

We are live! Send downloads directly from your browser to the Firelink app with zero friction.

<a href="https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/"><img src="https://img.shields.io/badge/Install%20on%20Firefox-FF7139?logo=firefox-browser&logoColor=white&style=for-the-badge" alt="Install on Firefox" /></a>

*(Check out the [Firelink-Extension source code](https://github.com/nimbold/Firelink-Extension) to contribute or learn more.)*

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

---

## 📄 License

Firelink is released under the MIT License. See [LICENSE](LICENSE) for details.

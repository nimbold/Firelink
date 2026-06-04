# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.4] - 2026-06-04

### New features
- Added direct double-click access to Download Properties for unfinished downloads.
- Added a `make verify` command for local build and Firefox extension manifest checks.

### Changes
- Updated Firefox integration to probe the same local fallback ports used by the app.
- Updated global speed limiting so changes apply to active downloads through `aria2` RPC.
- Declared SwiftPM resources and added development fallbacks for app icons and Firefox extension copying.
- Narrowed saved site-login matching so plain host patterns match exact hosts unless a wildcard is used.

### Fixes
- Fixed browser handoff failures when the default local extension port is unavailable.
- Fixed dropped `Referer` headers from browser extension requests.
- Fixed scheduler configurations that could be enabled without any runnable queue target.
- Fixed unsafe file names from URLs, metadata responses, and manual property edits.
- Fixed a possible duplicate-open glitch when double-clicking unfinished downloads.

## [0.5.3] - 2026-06-04

### New features
- Added `ChunkMapView` to visualize active segmented downloads using `aria2` RPC with minimal performance overhead.
- Added seamless drag-and-drop support for URLs and text files in the main window and dock icon.

### Changes
- Refactored all Settings panes to use standard macOS HIG `Form` and `.toolbar` layouts.
- Updated the "Add Downloads" dialog to use native macOS `.toolbar` with integrated cancel actions.

### Fixes
- Fixed a DNS rebinding vulnerability by rigorously validating the `Host` header within the local extension server.
- Fixed a potentially unbounded memory leak in the download console buffer by introducing a strict 512KB cap.
- Fixed an intermittent UI hang during the `aria2c` version check by fully decoupling the process execution into a detached background task.

## [0.5.2] - 2026-06-04

### Fixes
- Fixed the hit-testing area on Settings tabs so the entire tab frame is clickable, not just the text/icon.
- Re-architected the Settings tab bar layout to perfectly distribute available horizontal space, ensuring symmetric right/left padding.

## [0.5.1] - 2026-06-04

### Changes
- Added sleek SF Symbol icons to the Settings capsule tabs to improve visual scannability and modernize the interface.

## [0.5.0] - 2026-06-04

### New features
- Added a dedicated Speed Limiter UI to the main sidebar for instant global bandwidth throttling.
- Integrated Settings directly into the main application window instead of a separate macOS scene, paving the way for future Windows/Linux cross-platform parity.

### Changes
- Modernized Settings with a sleek horizontal tab bar layout.
- Added persistent state retention across views (remembers the last visited settings tab and custom speed limits).
- Compacted the README file to be more concise and user-friendly.

### Fixes
- Fixed a critical memory crash (`EXC_BAD_ACCESS`) inside the Download Table caused by ephemeral string sorting during active downloads.
- Fixed sidebar layout glitches to prevent text overlap during scroll.

## [0.4.3] - 2026-06-03

### Changes
- Refined About page UI and simplified the delete confirmation dialog.

### Fixes
- Optimized disk writes and UI state updates to significantly reduce main thread CPU usage and SSD wear during concurrent downloads and table resizing.

## [0.4.2] - 2026-06-03

### Features added
- Added double-click to open completed files directly from the download table.
- Added redownload functionality for completed or failed items.
- Added 'Copy Address' context menu action.
- Added a monochrome template tray icon loaded explicitly with precise dimensions.

### Changes
- Improved context menu organization and conditionally displayed actions based on download status.

## [0.4.1] - 2026-06-03

### Features added
- Added app theming engine with Look and Feel settings.
- Added Font Size, List Row Density, and Menu Bar Icon settings.
- Added tray icon and context menu for main window and queues.
- Added site logins integration directly into the Add Downloads window.

### Changes
- Updated the paste hint to use a visual Command icon.

### Fixes
- Resolved SwiftUI infinite layout freeze caused by MenuBarExtra binding.
- Fixed a bug with Light/System theme appearance.
- Fixed phantom state issues with Menu Bar Icon setting and conditionally applied theme backgrounds to preserve native macOS translucency.

## [0.4.0] - 2026-06-03

### Changes
- Reorganized Settings sections so related download preferences sit together and app diagnostics live under App.
- Hardened the release workflow with explicit macOS 26 SDK checks, newer GitHub Actions, and app signature verification.
- Prefer the bundled `aria2c` binary inside release builds.

### Fixes
- Fixed queue-specific starts so one queue no longer starts unrelated queued downloads.
- Fixed scheduler completion handling so empty queues do not trigger post-download system actions.
- Fixed queue drag reordering when moving items downward.
- Fixed scheduler Automation permission prompting.

### Features added
- Added scheduler controls with explicit Automation permission UI.
- Added global and per-download speed limits.
- Added advanced transfer options for checksums, headers, cookies, and mirror URLs.

## [0.3.0] - 2026-06-02

### Added
- **Zero-Config Setup:** Firelink now automatically bundles the `aria2c` engine and all of its dynamic library dependencies internally via `dylibbundler`. End-users no longer need to install Homebrew or `aria2c` manually! 

### Changed
- **README Redesign:** Modernized the README with a clean layout, centered App Icon header, and updated roadmap.
- **CI Releases:** The GitHub Actions DMG release pipeline now automatically fetches and packages dependencies during builds.

## [0.2.1] - 2026-06-02
### Changed
- Fixed CI release runner specifying macOS 26.

## [0.2.0] - 2026-06-01
### Added
- **In-App Update Checker:** Built-in GitHub release checks inside the Settings About pane.
- **Queue Management:** Advanced drag-and-drop priority ordering and queue management controls.
- **Download Recovery:** Built-in download recovery and automated retry policies.
- Initial core download engine with `aria2c` support.
- Native macOS Settings pane.
- Smart file categorization and organization based on extension detection.
- Keychain-secured authentication integration.

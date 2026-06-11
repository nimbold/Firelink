# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Prevented yt-dlp and JavaScript child processes from keeping metadata fetches or canceled downloads alive indefinitely.
- Replaced the repeatedly extracted one-file yt-dlp build with a stable prewarmed runtime cache.
- Bundled Deno so YouTube JavaScript challenges and formats above 720p do not depend on system-installed tools.
- Stopped masking empty-format extraction failures and removed brittle forced YouTube client selection.

### Changed
- Pinned and checksum-verified yt-dlp, Deno, FFmpeg, aria2, and aria2's libraries for matching local and GitHub Actions builds.
- Removed aria2's runtime dependency on Homebrew and configured its bundled CA certificate for direct and yt-dlp-delegated HTTPS downloads.
- Added bounded network retries and optional aria2c acceleration for large direct media downloads.

## [0.7.1] - 2026-06-11

### Fixes
- Increased the `yt-dlp` metadata extraction timeout to 120 seconds to properly handle YouTube's new JavaScript Proof-of-Work bot protection challenges.
- Improved the `AddDownloadsView` UI to display the exact underlying error message during extraction failures rather than a generic masked string.

### Security Fixes
- Addressed multiple vulnerabilities identified in the v0.7.0 security audit.
- Moved `yt-dlp` credential passing from CLI arguments to secure temporary configuration files to prevent process list leakage.
- Enforced strict `0o600` POSIX permissions on `aria2c` temporary configuration files to protect generated RPC secrets.
- Replaced the unauthenticated local connection protocol with a secure HMAC-SHA256 signature validation.
- Excluded sensitive properties like `rpcSecret` and `rpcPort` from `DownloadItem` serialization so they are never saved to disk in plaintext.
- Mitigated SSRF (Server-Side Request Forgery) by strictly validating metadata fetch requests against private IP addresses and loopback ranges.
- Prevented potential path traversal vulnerabilities by validating destination file URLs during duplicate resolution.
- Sanitized custom HTTP headers to prevent CR/LF injection vectors.
- Re-architected `aria2c` port-finding with POSIX sockets to eliminate a known race-condition window.
- Applied rate-limiting and text length bounds to the custom `firelink://` scheme to mitigate DoS and injection attempts.

### Fixes
- Fixed a metadata extraction timeout when downloading from YouTube by preventing child processes from holding process pipes open.
- Resolved an issue to correctly assign filenames for auto-captured downloads.
- Restored the UUID fallback for token generation to prevent silent failures if secure random byte generation fails.
- Hardened local API security by immediately rejecting requests if the expected pairing token is completely empty.
- Implemented a thread-safe cleanup mechanism for temporary directories to resolve a concurrency race condition during engine cancellation.

## [0.7.0] - 2026-06-11

### New Features & Improvements
- Complete UI modernization for the context menu, toolbar, download list, and sidebar to adhere strictly to Apple's Human Interface Guidelines (HIG).
- Overhaul of the Settings panes including Site Logins, Engine, About, Locations, and Downloads for a unified, cleaner look.
- Introduce an "Ask where to save" global configuration option for manual location picking per download.
- Add "Stop Time" option to the Scheduler and unit picker for the global Speed Limiter.
- Enhance the Integration pane with a visible step counter and an up-to-date status icon.
- Optimize `yt-dlp` execution for noticeably faster media extraction speeds.
- Defer Keychain access prompts and track executable modification dates for a more secure "priming" mechanism.

### Fixes
- Fix issues regarding proxy environment propagation into media download processes.
- Resolve multiple critical bugs related to configuration storage and download stability.
- Address multiple underlying issues identified during comprehensive code reviews to improve overall resilience.

## [0.6.6] - 2026-06-10

### New Features
- Add cascading media format pickers with inline loading states during metadata extraction.
- Redesign the Integration settings pane for a more modern experience.
- Overhaul the built-in update checker UI to integrate seamlessly into the settings.

### Improvements
- Implement keychain permission priming to defer secure access until explicitly granted, preventing unexpected macOS prompts.
- Optimize core UI components to significantly improve rendering performance and overall app stability.

### Fixes
- Fix layout and dynamic sizing bugs in the Add Downloads window.
- Fix formatting inconsistencies in media options selection.
- Fix toast notification rendering glitches.

## [0.6.5] - 2026-06-09

### Fixes
- Fix GitHub Actions build failure caused by an ambiguous bundle format when attempting to codesign `yt-dlp`'s embedded PyInstaller `Python.framework`.

## [0.6.4] - 2026-06-09

### New Features
- Replace Sparkle with a lightweight native GitHub release checker for seamless and reliable updates.

### Improvements
- Polish the browser extension pairing UI with a secure masked token field and improved styling.

### Changes
- Remove stale references to the legacy static token from the Firelink Companion extension.

### Fixes
- Fix an issue where the app failed to detect newer padded version numbers (e.g., `1.0` vs `1.0.0`).
- Fix missing macOS code signatures for `yt-dlp`'s embedded Python runtime, resolving potential Gatekeeper rejections.

## [0.6.3] - 2026-06-09

### Improvements
- Upgrade pairing token generation to use a 32-byte cryptographically secure random sequence.
- Migrate pairing token storage from UserDefaults to KeychainCredentialStore for enhanced security.
- Redesign the "Connect Browser Extension" settings pane to be browser-agnostic with links to both Firefox and Chrome extension stores.
- Add a "Regenerate" button to instantly invalidate and recreate the pairing token.

### Fixes
- Fix CORS preflight failures for the new `/ping` extension connection check by allowing `GET` methods in the local server.

## [0.6.2] - 2026-06-08

### Fixes
- Fix a bug where confirming a duplicate resolution failed to close the Add Downloads window, misleading users into thinking the download didn't start.
- Fix keyboard shortcut collision that caused the main window to intercept Enter/Escape keys when the duplicate resolution sheet was open.
- Fix UI freeze when checking release notes for an update by parsing HTML asynchronously on a background thread.
- Improve update changelog formatting by converting release note markup to clean Markdown instead of stripping it into an unreadable block of text.
- Change the internal `Process xxxxx` status message to a cleaner `Starting...` message when queueing a new download.
- Fix `EXC_BREAKPOINT` crash on app launch in production builds by prioritizing `Bundle.main` over `Bundle.module` when accessing resources.

## [0.6.1] - 2026-06-08

### New Features
- No new user-facing features in this patch release.

### Improvements
- Package bundled `yt-dlp` and `ffmpeg` executables into the macOS app bundle so media extraction works in release builds.
- Resolve bundled media engines from both app resources and SwiftPM resources to support packaged apps and local development builds.

### Changes
- Fetch release-time media engine binaries in GitHub Actions instead of storing large binaries in git.
- Use the changelog entry for GitHub release page descriptions so published release notes match the source tree.
- Remove stale media add-on update language now that media engines are bundled with the app.
- Update Firelink Companion to `1.0.8`.

### Fixes
- Replace the stale pinned FFmpeg download URL with Martin Riedl's latest macOS ARM64 release redirect.
- Fail release builds early when `yt-dlp` or `ffmpeg` cannot be fetched or made executable.
- Remove unused media inspector and media download entry-point code left behind by the removed engine update flow.
- Prevent Firelink Companion global capture from canceling browser downloads unless the native app confirms the local API handoff.

## [0.6.0] - 2026-06-08

### New features
- Enhance mixed media support and add duplicate resolution.
- Redesign settings panes and enhance update flows.
- Improve yt-dlp fetching speed and redesign media detection UI.
- Enhance media engine settings with cookie extraction and update checks.
- Modernize Integration settings UI and add official install button.
- Integrate yt-dlp to DownloadController and add global queue support.
- Implement smart progressive disclosure UI and media extraction engine.
- Implement gatekeeper architecture for on-demand media engine binaries.
- Inline update checks to avoid unnecessary modals.

### Changes
- Add backward compatibility support for extension tokens.
- Update Firelink-Extension submodule to latest.
- Update app icons and icon generation scripts.
- Tone down icon gradient to 1.9x for modern subtle look.
- Increase gradient contrast for stronger lighting effect.
- Switch to lighter gradient (+1 to 0).
- Revert to plain mode without gradient.
- Apply premium gradient to the correct new icon and app icon.
- Remove redundant version string from up-to-date message.
- Update release metadata for the framework-embedded dmg.

### Fixes
- Cap max height of download links text editor.
- Harden media download flow.
- Pass extractor arguments to yt-dlp download process.
- Restore single click selection by removing simultaneousGesture.
- Restore Download Properties routing and gestures.
- Pass UUID as String for download properties WindowGroup to prevent routing failures.
- Size column fallback and table row interactions.
- Media download UX and table row selection.
- Media downloads connections, progress parsing, file size, and selection highlight.
- Stabilize yt-dlp metadata and add-on updates.
- Block automatic metadata fetch for private IP addresses (security).
- Actually update extension icons with the 1.9x gradient icon.
- Correctly remove black padding and mask corners.
- Harden release metadata.
- Correct no-update handling to prevent false error messages.

## [0.5.7] - 2026-06-06

### New features
- Replaced the basic in-app update checker with an integrated release-checking flow.
- Added secure update metadata checks before presenting new releases in the app.

## [0.5.6] - 2026-06-05

### New features
- Added the official transparent GitHub icon to the Source Code link in the About page.

### Changes
- Compacted the About settings pane to reduce vertical padding, placing the app identity and updates prominently at the top.
- Consolidated developer, credits, and legal links into a single unified footer section in the About pane.

### Fixes
- Fixed a build script bug that prevented bundled images (like the GitHub icon) from being copied into the final app bundle.

## [0.5.5] - 2026-06-05

### New features
- Added a compact Download Properties inspector with a persistent progress summary and redownload-aware transfer settings.
- Added authenticated metadata probing so batch previews can use custom or saved credentials.

### Changes
- Updated Download Properties disclosure sections so their full title row opens and closes them.
- Compacted Add Downloads with a smaller summary strip, queue picker, and clearer per-file speed limit wording.
- Expanded download table hit areas so double-clicks register across empty cell space.

### Fixes
- Fixed active downloads that could remain stuck at 99% until manually stopped by detecting `aria2` completion through RPC.
- Fixed Chunk Map layout overlap in Download Properties.
- Fixed Download Properties controls that implied completed or active file identity edits would apply immediately.

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

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

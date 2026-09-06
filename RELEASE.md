# Firelink Release Process

Targets:

- macOS arm64 DMG
- Windows x64 NSIS installer
- Windows x64 portable ZIP
- Linux x64 AppImage
- Linux x64 Debian package
- Linux x64 RPM package

## Distribution policy

Firelink does not use an Apple Developer account. macOS releases are ad-hoc signed but not notarized or Gatekeeper-approved. Users may still need to explicitly approve the downloaded app through Finder or macOS Privacy & Security. Release copy must not describe these builds as Developer ID signed, notarized, or Gatekeeper-approved.

Windows releases are currently unsigned. SmartScreen may warn until code signing is added.

## Engine supply chain

Firelink never falls back to system-installed media tools.

- `engines.lock.json` pins current committed macOS payload hashes.
- `engine-sources.lock.json` pins Windows/Linux source archives and checksums.
- `scripts/provision-engines.js` downloads and verifies target archives.
- `scripts/stage-engines.js` creates one target-specific bundle payload in an
  invocation-owned temporary workspace.
- `scripts/verify-binaries.js` runs architecture, packaging, version, and RPC checks.

Aria2 allocation telemetry is a required bundle capability. Windows and Linux
provisioning now builds the checksum-pinned upstream source archive with
`scripts/aria2/firelink.patch`; this patch also retains Firelink's native DNS,
network target policy, and Torrent routing changes. CI installs the compiler
and static-library prerequisites. Windows uses the MSYS2 installation returned
by the setup action (`FIRELINK_MSYS2_ROOT`, default `C:/msys64` for local builds).
The patch checksum is recorded in both source and payload provenance. Never
replace these builds with stock Aria2 archives: package verification requires
`firelinkAllocationTelemetry: true` from `aria2.getVersion`.

Linux `.deb` and `.rpm` packages are built with the complete verified engine payload. The AppImage is bundled separately with the engine resource excluded from the initial Linux packaging pass, then repacked from the verified payload because the AppImage tooling can rewrite bundled native binaries.

yt-dlp must remain its official PyInstaller **onedir** distribution: launcher plus adjacent `_internal` runtime. Onefile builds are rejected because repeated extraction caused roughly 17-second startup latency.

## Version update

Keep versions aligned:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

## Local macOS build

```bash
npm ci
npm test -- --run
npm run build
cd src-tauri && cargo test --all-targets
cd ..
npm run tauri build -- --target aarch64-apple-darwin --bundles dmg
```

`npm run tauri` owns engine staging for `dev`, `build`, and `bundle`. The
wrapper creates a private workspace, verifies the payload, and removes the
workspace after Tauri exits. To stage and verify a payload manually, provide a
private output root explicitly:

```bash
ENGINE_OUTPUT_ROOT="$(mktemp -d -t firelink-engines)/engine-dist"
FIRELINK_ENGINE_OUTPUT_ROOT="$ENGINE_OUTPUT_ROOT" \
  node scripts/stage-engines.js --target aarch64-apple-darwin
FIRELINK_ENGINE_OUTPUT_ROOT="$ENGINE_OUTPUT_ROOT" \
  node scripts/verify-binaries.js --staged --target aarch64-apple-darwin
```

Do not use `src-tauri/engine-dist` or another repository-shared directory as
the manual output root. On Windows, set `FIRELINK_ENGINE_OUTPUT_ROOT` to a
private directory under `$env:TEMP` and use the PowerShell form:

```powershell
$env:FIRELINK_ENGINE_OUTPUT_ROOT = Join-Path $env:TEMP "firelink-engines-$PID\engine-dist"
node scripts/stage-engines.js --target x86_64-pc-windows-msvc
node scripts/verify-binaries.js --staged --target x86_64-pc-windows-msvc
```

Verify the DMG and the app it contains, then launch outside the repository
working directory. The DMG bundler removes the intermediate app directory, so
the post-build checks must use the mounted release artifact:

```bash
DMG="$(find src-tauri/target/aarch64-apple-darwin/release/bundle/dmg -name '*.dmg' -print -quit)"
test -n "$DMG"
npm run verify:macos-signing -- --dmg "$DMG"
MOUNT_POINT="$(mktemp -d -t firelink-dmg)"
cleanup() {
  hdiutil detach "$MOUNT_POINT" -quiet || hdiutil detach "$MOUNT_POINT" -force -quiet || true
  rmdir "$MOUNT_POINT" 2>/dev/null || true
}
trap cleanup EXIT
hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_POINT" "$DMG" >/dev/null
APP_COUNT="$(find "$MOUNT_POINT" -maxdepth 1 -type d -name 'Firelink.app' | wc -l | tr -d ' ')"
test "$APP_COUNT" -eq 1
APP="$(find "$MOUNT_POINT" -maxdepth 1 -type d -name 'Firelink.app' -print -quit)"
node scripts/verify-binaries.js --search-root "$APP" --target aarch64-apple-darwin
node scripts/smoke-packaged-app.js --executable "$APP/Contents/MacOS/firelink"
```

GitHub release publication follows `.github/workflows/release.yml`. A `v*` tag
push builds, verifies, and publishes the GitHub release after the platform jobs
pass. A `workflow_dispatch` on a `v*` tag also publishes when its
`publish_release` input is enabled. The current workflow has no separate
release-certification inputs; clean-machine QA remains a release-owner gate
before pushing the tag.

For paired releases, publish and verify the Companion release first. The
desktop release workflow requires `Extensions/Browser` to be at a clean commit
whose exact tag matches both the Companion `package.json` and `manifest.json`
versions before building desktop packages.

## Automated release builds

Push a version tag to build and verify native artifacts:

```bash
git tag v<version>
git push origin v<version>
```

GitHub Actions builds all targets on native runners, verifies engines inside
final package contents, performs packaged launch smoke where supported, and
publishes the GitHub Release after the build matrix passes.

No target may silently skip missing engines, failed extraction, checksum mismatch, or missing package output.

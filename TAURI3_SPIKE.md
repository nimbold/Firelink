# Tauri 3 compatibility spike

- Date: 2026-10-14
- Status: report-only, isolated non-production experiment
- Production decision: Firelink remains on stable Tauri 2

This report records the result of an isolated Tauri 3 alpha experiment. The
alpha dependency and source changes used for the experiment are intentionally
not part of the production refresh.

## Findings

The main migration shape is tractable: add a direct runtime crate, select Wry
on the builder, and replace `tauri::Wry` type parameters with
`tauri::DynRuntime`. Firelink's command dispatcher, setup, tray/menu code,
capability files, and macOS run-event handling compiled with that model.

The blocking incompatibility is `tauri-plugin-shell` alpha.2. Firelink relies
on `.set_process_group(true)` for media subprocesses and tests that killing a
launcher also kills its descendants. The alpha crate has no such method or
process-group/job-object implementation. A normal `cargo check --lib` failed
at `src/lib.rs:2779` with:

```text
error[E0599]: no method named `set_process_group` found for struct `tauri_plugin_shell::process::Command`
```

The same API is used by the shell regression test and
`tests/shell_process_group.rs`. Removing those calls only for diagnosis let
the remaining code compile, but would discard Unix process-group and Windows
Job Object behavior. The calls were restored; the alpha migration is not
release-safe until the plugin restores that contract or Firelink adopts a
separately validated process supervisor.

## Dependency and runtime surface

The official [Tauri 2-to-3 alpha migration guide](https://v3.tauri.app/start/migrate/from-tauri-2/)
requires Rust 1.95 or newer, explicit runtime selection, and v3 alpha
plugins. The registry versions were staggered on 2026-10-14:

| Component | Spike version |
| --- | --- |
| `tauri` / `tauri-runtime-wry` | `3.0.0-alpha.4` |
| `tauri-build` | `3.0.0-alpha.3` |
| Rust dialog plugin | `3.0.0-alpha.3` |
| Rust opener, shell, notification, clipboard-manager, deep-link, single-instance, log plugins | `3.0.0-alpha.2` |
| `@tauri-apps/api` / CLI | `3.0.0-alpha.2` / `3.0.0-alpha.4` |

The installed Rust toolchain was 1.99.0, above the documented MSRV. The
selected runtime was Wry; `tauri info` reported Wry 0.57.0 and Tao 0.37.1,
with no CEF runtime detected. The generated Firelink TypeScript bindings are
`ts-rs` domain types rather than Tauri invoke-handler types and needed no
regeneration.

## Migration surface by feature

- Plugins and capabilities resolved at their v3 alpha versions. Existing
  `default.json` and `properties.json` permissions passed the Tauri config
  check; no capability edit was needed.
- The main and Properties windows, menus, tray, and macOS run-event path
  compiled with `DynRuntime`.
- The `firelink` and `magnet` schemes plus deep-link and single-instance
  plugins resolved on macOS. Windows/Linux protocol forwarding was not
  runtime-tested.
- Notification and clipboard plugins compiled. The shell plugin's process
  ownership contract is the blocker above.
- The existing `THIRD_PARTY_NOTICES.md` and `engine-dist/` resource mappings
  were accepted by configuration checks, but resource lookup was not
  exercised in a running or packaged app.
- Wry still uses WKWebView on macOS, WebView2 on Windows, and WebKitGTK on
  Linux. The current release matrix remains macOS arm64 DMG, Windows x64 NSIS,
  and Linux x64 AppImage/deb/rpm. Linux tray behavior still needs native
  desktop-environment validation; the current workflow's libappindicator
  dependency should only be removed after that validation.

## Probes and limits

- `npm run build` passed with the v3 alpha JS packages.
- Tauri CLI version/config/runtime detection passed.
- `cargo check --lib` and `cargo check --all-targets` failed only at the
  restored shell process-group calls; with those calls temporarily removed for
  diagnosis, both checks passed after updating `tauri::Wry` references.
- A Windows cross-target check stopped in `ring` because this macOS host lacks
  Windows SDK headers. Linux package checks were unavailable because this host
  lacks WebKitGTK/GTK/Ayatana AppIndicator development modules.
- No app launch or native package was produced. Package size, startup,
  resource placement, deep-link delivery, clipboard/notification behavior,
  and Windows/Linux packaging remain unmeasured.

## Required next validation

Preserve process-group/job-object cancellation semantics while resolving the
shell-plugin gap, then run the existing Rust tests and packaged smoke checks on
native macOS arm64, Windows x64, and Ubuntu 22.04 Linux x64. Include Linux
tray validation, deep-link/single-instance launch checks, staged-engine
resource-path verification, and before/after artifact-size measurements. Keep
the alpha dependency/configuration experiment isolated until those results and
upstream plugin compatibility are resolved.

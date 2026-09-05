# Rust dependency advisory policy

`cargo audit` is a required CI gate. Vulnerability advisories must be resolved;
the gate must not be bypassed with a broad ignore list.

As of 2026-09-05, Cargo reports no vulnerability advisories. It does report
the following informational warnings, which remain visible in CI output:

- `RUSTSEC-2024-0411` through `RUSTSEC-2024-0420` (GTK3 bindings) and
  `RUSTSEC-2024-0370` (`proc-macro-error`) are Linux-only dependencies reached
  through Tauri/Wry's GTK3 and tray integration.
- `RUSTSEC-2024-0429` (`glib` 0.18.5 iterator unsoundness) is in that same
  Linux Tauri/Wry GTK3 graph. Firelink does not directly use
  `glib::VariantStrIter`, but this remains an upstream risk rather than a
  Firelink-level remediation.
- `RUSTSEC-2025-0075`, `RUSTSEC-2025-0080`, `RUSTSEC-2025-0081`,
  `RUSTSEC-2025-0098`, and `RUSTSEC-2025-0100` are unmaintained UNIC crates
  reached through `tauri-utils -> urlpattern`.

Review these paths with every Tauri/Wry update and no later than 2026-12-05.
Remove this acknowledgement when the upstream graph no longer contains the
affected packages. Do not add these advisory IDs to Cargo's ignore list: a
future severity change must remain visible.

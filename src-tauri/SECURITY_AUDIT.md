# Rust dependency advisory policy

`cargo audit` is a required CI gate. Vulnerability advisories must be resolved;
the gate must not be bypassed with a broad ignore list.

As of 2026-10-23, `cargo audit` reports no vulnerability advisories. It reports
five allowed warnings, which remain visible in CI output:

- `RUSTSEC-2024-0370` marks `proc-macro-error` 1.0.4 unmaintained.
- `RUSTSEC-2024-0429` reports unsound iterator implementations in `glib`
  0.18.5. This is in the Linux Tauri/Wry GTK3 graph; Firelink does not directly
  use `glib::VariantStrIter`.
- `RUSTSEC-2026-0370`, `RUSTSEC-2026-0371`, and `RUSTSEC-2026-0372` mark
  `zvariant` 5.15.1, `zbus_names` 4.3.5, and `zvariant_derive` 5.15.1
  unmaintained. They are reached through the Linux D-Bus `zbus` 5 graph,
  including Tauri plugins and system integrations. The advisories describe
  these APIs as moved into modules provided by `zbus` 6. Forcing `zbus` 6
  across the current Tauri 2 graph is not a compatible lockfile-only change.

The previous GTK3, UNIC, and `urlpattern` warning IDs did not appear in this
refreshed audit output. Keep the current audit output as the authority and
recheck this note on the next Cargo dependency refresh.

Review these paths with every Tauri/Wry update and no later than 2026-12-05.
Remove this acknowledgement when the upstream graph no longer contains the
affected packages. Do not add these advisory IDs to Cargo's ignore list: a
future severity change must remain visible.

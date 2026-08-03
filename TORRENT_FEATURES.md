# Firelink Torrent feature matrix

This document is the source of truth for Firelink's BitTorrent scope, current
implementation status, and next work. It compares Firelink with the
BitTorrent-specific surface of the bundled Aria2 1.37.0 engine. Aria2's
generic HTTP/FTP/SFTP/Metalink options, arbitrary shell hooks, and daemon
administration RPCs are intentionally separate unless they affect Torrent
ownership or safety.

Reference: [Aria2 1.37.0 manual](https://aria2.github.io/manual/en/html/aria2c.html).

## Audit basis

- Audited on 2026-08-03 at Firelink `32034e9` (`main`) plus the current working
  tree, with the cumulative
  Torrent work reviewed from `edc76a7`.
- Source of truth: `src-tauri/src/torrent.rs`, `torrent_probe.rs`, `queue.rs`,
  `lib.rs`, `settings.rs`, `download_ownership.rs`, `db.rs`, the IPC bindings,
  frontend stores/components, and `scripts/smoke-torrent.js`.
- Reliability claims require a source postcondition or a test/harness
  assertion. A passing local macOS check does not prove Windows/Linux native
  behavior, public tracker/DHT reachability, or packaged-app behavior.
- The requested Agy and OpenCode review was bounded to the cumulative Torrent
  diff and relevant paths. Their advice was used only after this source audit
  and was verified against the live tree.

## Implemented

### Intake, metadata, and file selection

- Local `.torrent` files, magnet links, and remote HTTP(S) `.torrent` metadata.
  Remote metadata is bounded, redirect/SSRF checked, credential-free, parsed,
  and cached before enqueue.
- Strict bencode parsing, sorted-key validation, size/depth bounds, UTF-8
  validation, canonical info-hash verification, safe output components, and
  managed metadata retention/rekeying.
- Selected-file preview and validated `select-file` handling. Firelink derives
  the Torrent output contract with Aria2 `index-out`; it does not use the
  generic `out` option for Torrent files.
- Torrent metadata probing uses Aria2 `bt-metadata-only` and `bt-save-metadata`
  internally, validates the returned hash, and conservatively cleans probe
  directories. It is not exposed as a separate metadata-only download mode.
- Validated metadata is also stored under a canonical lowercase hexadecimal
  info-hash key. Plain magnets containing only `xt` and optional `dn` reuse
  that cache before probing when the cached file has no tracker, web-seed, or
  other source-specific outer metadata; tracker, web-seed, source, and unknown
  query parameters conservatively force a fresh probe. Cache hits are
  revalidated against bencode and the exact hash, copied into the current
  draft ID, and therefore remain compatible with Add-window rekeying.
- Canonical metadata writes use a same-directory temporary file and rename;
  invalid entries and abandoned canonical temporary files are removed safely.
  Canonical files use a separate `.info-<hash>.torrent` namespace from
  draft/final IDs, and reads are bounded before parsing. Startup retention
  keeps canonical files referenced by persisted Torrent records'
  `torrentInfoHash`, as well as draft/final ID-keyed files.
- `addTorrent` passes validated web-seed/mirror URIs when supplied through the
  existing download input. There is no separate Torrent web-seed manager.

### Queue and lifecycle ownership

- Torrents use the existing Firelink queue admission, global/per-queue permits,
  pause/resume, cancellation, retry/GID replacement, restart recovery, and
  terminal reconciliation.
- A Torrent's Aria2 GID is paired with the Firelink download ID and lifecycle
  epoch. Late RPC results and stale terminal events cannot revive a removed or
  newer lifecycle.
- Exactly one queue permit remains parked for the complete Aria2 lifecycle,
  including seeding, and release is idempotent.
- Aria2 `getFiles` reconciliation establishes output ownership for Torrent
  files. Ownership and optional unselected-file removal reservations are
  canonicalized, persisted, collision-checked, and kept separate.
- Generic `addUri` explicitly sets both `follow-torrent=false` and
  `follow-metalink=false`. This prevents an HTTP download from creating an
  unmanaged child GID outside Firelink's queue, ownership, cancellation, retry,
  and restart model.

### Transfer, seeding, and integrity controls

- Optional `seed-time` and/or `seed-ratio` policies, including ratio-only and
  unlimited-ratio semantics; upload progress and seeding status are reflected
  in the UI.
- Per-Torrent upload limit through Aria2 `max-upload-limit`, with a live,
  lifecycle-fenced update path.
- Global Aria2 aggregate upload limit through
  `max-overall-upload-limit`. It is persisted, validated, applied at daemon
  startup, and changeable through `aria2.changeGlobalOption`; in Firelink it
  primarily controls Torrent seeding traffic, and blank means Aria2's
  unlimited value (`0`).
- Per-Torrent maximum peers (`bt-max-peers`) and low-speed peer expansion
  threshold (`bt-request-peer-speed-limit`), including live updates.
- Optional piece-integrity verification through `check-integrity` and a safe
  `bt-hash-check-seed`/`bt-seed-unverified=false` policy. Firelink does not
  silently seed unverified data when the user requests verification.
- Optional `bt-stop-timeout` stall policy, persisted per Torrent and reapplied
  on start/retry.
- Optional `bt-prioritize-piece` head/tail preview policy, normalized and
  reapplied on start/retry.
- Validated encryption policies mapped consistently to
  `bt-force-encryption`, `bt-require-crypto`, and `bt-min-crypto-level`.
- Optional `bt-remove-unselected-file` cleanup after successful completion,
  only with an explicit partial selection and confirmation. The selected-file
  ownership and unselected-file reservation are committed atomically; Firelink
  clears the reservation only after Aria2's reserved paths are absent,
  including when a transfer fails. Restart recovery preserves queued/paused
  and orphaned reservations while reclaiming only observed failed or completed
  cleanup. Disabling the option after a detach clears the reservation before
  the edited item is persisted.

### Trackers, peers, and network identity

- Additional `bt-tracker` URLs and `bt-exclude-tracker`, including the explicit
  `*` wildcard. URLs are bounded, normalized, credential-free, and limited to
  HTTP(S)/UDP schemes.
- `bt-tracker-connect-timeout`, `bt-tracker-timeout`, and
  `bt-tracker-interval`, persisted per Torrent and reapplied on start/retry.
- Bounded read-only `aria2.getPeers` diagnostics. Firelink discards peer IPs,
  ports, IDs, and bitfields at the native boundary and exposes only bounded
  operational speeds and choking/seeder flags.
- Global DHT, IPv6 DHT, PEX, and LPD toggles. Private-Torrent behavior remains
  Aria2-controlled.
- Launch-scoped TCP/UDP listen-port ranges, external BitTorrent IP, IPv4/IPv6
  DHT entry points, IPv6 DHT listen address, and LPD interface. Settings are
  validated, persisted, and applied only after Firelink restart.
- Optional bounded peer-ID prefix and peer-agent overrides. They are disabled
  by default and carry identity/privacy/compatibility warnings.
- Global `bt-max-open-files`, bounded to 1–4096, applied at startup and
  updateable for newly added Torrents through `aria2.changeGlobalOption`.

### Evidence already present in the tree

- Rust unit coverage for bencode/hash/path validation, option normalization,
  queue ownership, lifecycle fencing, persistence sanitization, atomic Torrent
  removal reservations, conservative restart recovery, host case-insensitive
  path identity, and native startup argument construction.
- `src-tauri/tests/torrent_rpc.rs` covers the production authenticated JSON-RPC
  HTTP boundary in a Windows-compatible integration-test target.
- `npm run smoke:torrent` and `npm run smoke:torrent:failure-paths` cover
  deterministic local seeding, magnet metadata resolution, selected output,
  pause/resume, ownership, cancellation/removal, unavailable trackers,
  daemon failure, integrity, encryption, tracker/piece policies, open-file and
  aggregate-upload limits, and stall-timeout behavior.

## Aria2 comparison: available but not exposed or only partially represented

| Aria2 capability | Firelink status | Reason / next step |
| --- | --- | --- |
| `bt-load-saved-metadata` | App-equivalent implemented | Firelink owns a validated, atomic, info-hash-keyed metadata cache for plain magnets, limited to metadata without source-specific outer tracker/web-seed fields, while preserving the current draft-ID/rekey contract. Source-specific magnet parameters intentionally bypass reuse; Aria2's daemon option is not exposed directly. |
| `dht-message-timeout` | Not exposed | Global DHT/UDP timeout tuning is not yet represented in settings. Add only with bounded validation and a runtime/startup contract. |
| `dht-file-path`, `dht-file-path6` | Not explicitly controlled | Aria2 can persist DHT routing tables, but Firelink does not choose app-managed paths or report their health. Decide whether portable-mode and privacy behavior justify exposing this. |
| `bt-detach-seed-only` | Not used | Aria2's concurrent-download accounting does not replace Firelink's permit ownership. Enabling it blindly would create two competing concurrency models. Revisit only with an explicit seed-slot policy. |
| `follow-torrent=true/mem` | Intentionally disabled for generic URLs | The child GID has no durable Firelink identity, permit, output ownership, or restart recovery record. Implement only after a parent/child lifecycle model exists and remote metadata validation is preserved. |
| `bt-metadata-only` / `bt-save-metadata` as user actions | Internal probe only | The Add window resolves metadata before enqueue; a separate user-visible metadata-only job is not currently a product need. |
| `on-bt-download-complete` and other hooks | Out of scope | Aria2 executes arbitrary commands. Firelink does not expose a shell-command injection surface; any future automation should be a bounded, app-owned event system. |
| `bt-enable-hook-after-hash-check` | Out of scope with hooks | It has no useful standalone meaning while arbitrary hooks are excluded. |
| `rpc-save-upload-metadata`, `save-session`, and other daemon-admin RPC policy | Out of scope / replaced | Firelink owns metadata retention and durable download state; enabling Aria2's uploaded-metadata persistence would create a second storage contract. |
| Aria2 CLI-only `show-files` / `torrent-file` controls | Product-equivalent path exists | Firelink provides a validated Add-window preview and managed `addTorrent` path rather than exposing CLI flags. |

The comparison intentionally does not treat Aria2 defaults as Firelink
features. For example, Aria2 defaults `follow-torrent` to true, but Firelink
must override it to false on every generic `addUri` path until child ownership
is durable.

## Priority tiers for future work

### Tier 0 — correctness and safety gates

No unstarted Tier 0 feature is approved. The global aggregate upload ceiling
was the highest-impact missing control and is now implemented as a persisted,
startup, and live-RPC contract.

Before any new Torrent feature is promoted, keep these gates mandatory:

1. Every Aria2 GID must remain attached to one Firelink identity, lifecycle
   epoch, permit, and owned-path contract.
2. Every awaited RPC must re-check lifecycle ownership before mutating UI,
   persistence, or queue state.
3. Any cleanup that can delete files must prove ownership and remain
   conservative after cancellation, daemon loss, restart, and missed events.
4. Generic followed child GIDs remain disabled until their full lifecycle is
   modeled and tested.

### Tier 1 — high-value user behavior

1. **DHT routing-table persistence policy.** Decide and implement app-managed
   `dht-file-path`/`dht-file-path6` behavior, especially for portable mode,
   permissions, reset, and privacy. This should be opt-in if it expands data
   retention beyond the current download metadata contract.

### Tier 2 — advanced tuning and ownership expansion

1. Expose bounded `dht-message-timeout` if real tracker/DHT diagnostics show a
   user-visible need; validate it at startup and document that it affects DHT
   and UDP tracker waits, not HTTP metadata fetches.
2. Add an explicit seed-slot policy only if Firelink wants seeding to stop
   consuming a queue permit. Aria2 `bt-detach-seed-only` alone is insufficient;
   Firelink's queue and power-management semantics must agree first.
3. Model generic followed Torrent children (`true` or `mem`) with durable
   parent/child IDs, admission accounting, output ownership, cancellation,
   retry/GID replacement, restart discovery, and bounded metadata validation.
   This remains a substantial architecture change, not a one-line option.

## Deliberately not planned

- Arbitrary shell hooks from Aria2.
- Direct daemon-admin/session-management controls that duplicate Firelink's
  persistence and ownership system.
- Claims of public tracker/DHT readiness from local deterministic fixtures.
- A second Torrent engine. Firelink's existing Aria2 queue, permit, GID, and
  recovery contracts are the intended transfer architecture.

## Validation commands

Run focused checks first, then the relevant broader gates:

```sh
npm test -- --run
npm run check:i18n
npm run bindings
cd src-tauri
cargo test --test torrent_rpc -- --nocapture
cargo test --all-targets
cd ..
npm run smoke:torrent
npm run smoke:torrent:failure-paths
git diff --check
```

Native Windows/Linux behavior, packaged-app startup, public magnets, and
router/firewall port forwarding remain separate evidence slices and must not be
implied by these local checks.

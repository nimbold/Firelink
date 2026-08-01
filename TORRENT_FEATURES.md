# Firelink Torrent feature matrix

This is the current product-facing comparison for BitTorrent features exposed
by Firelink's bundled Aria2 engine. It intentionally excludes Aria2's generic
HTTP/FTP/Metalink options, shell hooks, and daemon-admin RPC methods that do not
belong in the download UI. The Aria2 reference is the [1.37.0 manual](https://aria2.github.io/manual/en/html/aria2c.html).

## Implemented

- Local `.torrent` files, magnet links, and remote HTTP(S) `.torrent` metadata.
  Remote metadata is bounded, SSRF-checked, redirect-checked, parsed, and
  cached before it enters the normal `addTorrent` path.
- Bencode validation, canonical info-hash checks, safe output paths, managed
  metadata retention, selected-file preview, `select-file`, and `index-out`.
- Firelink queue admission, per-queue/global permits, pause/resume, cancel,
  retry/GID replacement, restart recovery, terminal reconciliation, and
  output ownership for Torrent lifecycles.
- Optional seeding by time and/or ratio, upload progress, upload limits,
  seeders telemetry, per-Torrent maximum peers, and the Aria2
  `bt-request-peer-speed-limit` threshold.
- Global DHT, IPv6 DHT, PEX, and Local Peer Discovery toggles.
- Optional piece-integrity verification, including the explicit policy that
  disables unverified seeding when verification is requested.
- Additional per-Torrent tracker URLs through `bt-tracker`, with bounded and
  credential-free HTTP/HTTPS/UDP validation.
- Deterministic local Aria2 smoke coverage for metadata resolution, selected
  output, pause/resume, ownership, cancellation/removal, unavailable trackers,
  and daemon failure; RPC-boundary coverage is separate.

## Priority tiers for remaining work

### Tier 0 — reliability and user-visible control

1. **Stall timeout** — expose `bt-stop-timeout` with clear semantics for a
   Torrent that has no download progress. The queue must reconcile the Aria2
   stop/error outcome and release its permit without turning an intentional
   stall policy into a stale retry loop.
2. **Peer diagnostics** — expose `aria2.getPeers` as bounded, redacted,
   read-only detail for the selected Torrent. Keep the current counts as the
   fast summary and treat peer IPs/IDs as sensitive display data.
3. **Tracker exclusion** — add `bt-exclude-tracker` alongside the existing
   additional-tracker list. It must be persisted, re-normalized, and re-applied
   on every retry/GID replacement. Document that it filters announce URLs only;
   it does not disable DHT or PEX.

### Tier 1 — transfer policy and storage behavior

1. **Piece/file priority** — expose `bt-prioritize-piece` for head/tail
   previewing and a deliberate file-priority model beyond the current binary
   selected/unselected state.
2. **Safe removal of unselected files** — expose
   `bt-remove-unselected-file` only as an explicit destructive choice, with
   ownership-aware confirmation and tests for cancellation, retry, and
   reconfiguration.
3. **Encryption policy** — expose `bt-force-encryption`,
   `bt-require-crypto`, and `bt-min-crypto-level` as one validated policy so
   users cannot accidentally select contradictory combinations.
4. **Tracker timing controls** — expose tracker connect timeout, request
   timeout, and interval only when their effect on battery/network behavior is
   explained and persisted.

### Tier 2 — advanced networking and daemon tuning

1. Configurable TCP/UDP listen ports, external IP, DHT entry points, IPv6 DHT
   listen address, and LPD interface, with platform/firewall warnings.
2. Global BitTorrent open-file limits and peer identity/agent controls.
3. Aria2 `follow-torrent`/in-memory follow behavior for generic downloads only
   if the resulting child-GID ownership model can be represented safely; the
   current explicit metadata path intentionally avoids unmapped child jobs.

The first implementation in this task is the former missing Tier 0 intake
capability: remote `.torrent` metadata now uses Firelink's existing safe,
cached, lifecycle-aware Torrent path.

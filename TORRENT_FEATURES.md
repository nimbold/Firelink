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
- Bounded, read-only Torrent peer diagnostics through `aria2.getPeers`.
  Firelink discards peer IPs, ports, IDs, and bitfields at the native boundary;
  the selected-Torrent detail view exposes only operational speeds, seeder,
  and choking flags, with a bounded display count.
- Global DHT, IPv6 DHT, PEX, and Local Peer Discovery toggles.
- Optional piece-integrity verification, including the explicit policy that
  disables unverified seeding when verification is requested.
- Optional stall timeout through `bt-stop-timeout`, persisted with each
  Torrent and re-applied when it starts or retries. A value of zero disables
  the policy; Aria2 stops the Torrent after the configured consecutive
  zero-download-speed interval.
- Additional per-Torrent tracker URLs through `bt-tracker`, with bounded and
  credential-free HTTP/HTTPS/UDP validation.
- Per-Torrent tracker exclusion through `bt-exclude-tracker`, including Aria2's
  explicit `*` value for excluding all announce URLs. Exclusions are persisted,
  normalized, reapplied on retries, and do not change DHT or PEX settings.
- Optional `bt-prioritize-piece` preview policy for the head, tail, or both
  ends of every selected file. The constrained policy is validated, persisted,
  normalized, and reapplied when a Torrent starts or retries.
- Optional `bt-remove-unselected-file` cleanup after completion when a
  selected-file subset is configured. Firelink requires explicit confirmation,
  reserves the unselected paths against competing downloads, keeps those
  paths separate from removable download ownership, and clears the reservation
  after observing Aria2's completion cleanup (or on terminal failure,
  cancellation, or reconfiguration).
- Deterministic local Aria2 smoke coverage for metadata resolution, selected
  output, piece priority, pause/resume, ownership, cancellation/removal,
  unavailable trackers, daemon failure, and `bt-stop-timeout` terminal behavior;
  RPC-boundary coverage is separate.

## Priority tiers for remaining work

### Tier 0 — reliability and user-visible control

No remaining Tier 0 items.

### Tier 1 — transfer policy and storage behavior

1. **File priority beyond selection** — Aria2 exposes only the binary
   `selected` file state through its Torrent file API and has no supported
   per-file priority option. Firelink therefore does not pretend that
   `select-file` is file priority; this remains pending an engine capability or
   a safe product-level model.
2. **Encryption policy** — expose `bt-force-encryption`,
   `bt-require-crypto`, and `bt-min-crypto-level` as one validated policy so
   users cannot accidentally select contradictory combinations.
3. **Tracker timing controls** — expose tracker connect timeout, request
   timeout, and interval only when their effect on battery/network behavior is
   explained and persisted.

### Tier 2 — advanced networking and daemon tuning

1. Configurable TCP/UDP listen ports, external IP, DHT entry points, IPv6 DHT
   listen address, and LPD interface, with platform/firewall warnings.
2. Global BitTorrent open-file limits and peer identity/agent controls.
3. Aria2 `follow-torrent`/in-memory follow behavior for generic downloads only
   if the resulting child-GID ownership model can be represented safely; the
   current explicit metadata path intentionally avoids unmapped child jobs.

The first implementation in this task was remote `.torrent` metadata intake;
follow-up implementations add stall-timeout control, bounded peer diagnostics,
persisted tracker exclusion, piece-preview priority, and safe unselected-file
removal.

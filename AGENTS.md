# Firelink agent guidance

This file is local operational guidance for work in the Firelink checkout. Live
code, tests, workflow files, issue text, and reproducible behavior outrank this
file. Details below that contain a date, version, commit, or test count are
orientation only and must be rechecked before being used as current evidence.

AGENTS.md is currently ignored by the repository's .gitignore; changing the
ignore policy or publishing this file is a separate, intentional decision.

## Current project snapshot

Snapshot checked on 2026-07-28:

- The desktop app is Firelink 1.2.0, aligned in package.json,
  src-tauri/Cargo.toml, and src-tauri/tauri.conf.json.
- The parent checkout is on main at edc76a7 and was aligned with origin/main
  when this snapshot was taken.
- Extensions/Browser is the Companion 2.0.6 submodule at b5118f1,
  compatible with Firelink 1.2.0. Its standalone repository remains the
  source of truth for extension behavior.
- The product is a Rust/Tauri desktop app with a React/TypeScript frontend,
  Zustand stores, SQLite persistence, local signed browser handoff, and bundled
  aria2, yt-dlp, FFmpeg, and Deno engines.
- The maintained release matrix is macOS arm64, Windows x64, and Linux x64.
  macOS builds are ad-hoc signed and not notarized; Windows builds are
  unsigned. Do not describe either as fully trusted or store-signed.

Before saying that a release, issue, workflow, submodule, or native platform is
current, inspect it live. In particular, do not infer current status from this
snapshot, an old handoff, a pushed tag, or a workflow that has not completed.

### macOS dev-app Computer Use limitation

`npm run tauri dev` launches the bare `src-tauri/target/debug/firelink`
executable, not a macOS `.app` bundle. Computer Use cannot register that
executable as a controllable application, and app lookup by
`com.nimbold.firelink` can be ambiguous when `/Applications/Firelink.app` and
a repository-built release bundle are both present. This is an app-discovery
limitation, not a Shadowrocket/TUN failure. Check the live executable path and
duplicate bundle registrations before rebuilding a package; use an exact
packaged `.app` path for native Computer Use validation. Shadowrocket may still
affect Torrent metadata or transfers when Firelink's System Proxy mode is
selected, so keep app discovery and proxy-consumer behavior as separate
diagnoses.

## First actions for every non-trivial task

Run these before editing:

    git status --short --branch
    git submodule status

Then locate the source of truth and its tests. Preserve unrelated worktree
changes, including unstaged changes in tests or generated-looking files. Never
use git reset --hard, git checkout --, broad cleanup, or recursive deletion to
make the checkout convenient.

For issue or audit work, read the complete issue, comments, attachments, and
follow-up replies before accepting the claim. Consultant or auditor feedback is
hypothesis, not authority. Reproduce it against current code and retain only
findings supported by source, tests, logs, or direct runtime evidence.

Trace user-visible behavior end to end before changing it:

    UI event -> Zustand/store lifecycle -> typed IPC -> Tauri command
    -> persistence/queue/sidecar -> event or response -> store -> rendered UI

Do not fix a symptom in one layer while leaving a stale-state, ownership,
security, or visible-claim defect in another layer.

## Consultants and delegation

Codex remains the primary investigator, implementer, tester, and final
decision-maker. Agy is explicit opt-in second-opinion support only; do not
invoke it unless the user asks for an Agy consultation. Keep any consultation
bounded to relevant files and diffs, never send secrets or unrelated private
data, and verify every actionable suggestion against live code, tests, logs,
and repository state. A consultant must never edit, commit, push, or become the
sole source of a finding.

## Source map

- src-tauri/src/lib.rs owns download orchestration, media metadata and format
  normalization, yt-dlp arguments, progress parsing/emission, cleanup, and
  many focused unit tests.
- src-tauri/src/queue.rs owns queue admission, global and per-queue
  reservations, fairness, permits, dispatch, retries, Aria2 lifecycle
  registration, and terminal reconciliation.
- src-tauri/src/extension_server.rs owns the local browser handoff boundary:
  pairing, request validation, authentication, replay/identity checks, and
  extension payload normalization.
- src-tauri/src/db.rs, storage.rs, settings.rs, and download.rs own
  persistence and durable download state. A UI-only fix is incomplete if a
  restart can recreate the bug.
- src-tauri/src/commands.rs and ipc.rs define the native command boundary;
  src/bindings/ contains generated shared TypeScript types.
- src/store/useDownloadStore.ts owns Add-window routing, frontend lifecycle
  serialization, dispatch invalidation, queue actions, and extension capture
  handling. src/store/downloadStore.ts owns native event listeners and the
  canonical React projection of progress/state.
- src/components/AddDownloadsModal.tsx owns the Add-window interaction;
  DownloadTable.tsx and DownloadItem.tsx own the main list and live row
  rendering. src/i18n/ owns typed locale resources and direction handling.
- src-tauri/tests/queue_manager.rs is the first regression target for queue,
  permit, Aria2, retry, cancellation, and admission races. Media parser and
  format tests are concentrated in src-tauri/src/lib.rs; frontend lifecycle
  tests live beside the stores and utilities.
- scripts/ owns engine provisioning/staging, binary and package checks, release
  identity, and packaged-app smoke checks. .github/workflows/ is the authority
  for what CI and release automation actually verify.
- Read YouTube_media_download_handoff.md, RELEASE.md, and
  src-tauri/tests/README.md for deeper task-specific notes, but verify their
  claims against the current checkout.

## Non-negotiable product and security boundaries

### Browser captures

- Every intercepted or automatic capture, including a request marked silent,
  must go through handleExtensionDownload and openAddModalWithUrls. The user
  reviews it in the Add window before it is started or queued.
- Never add an intercepted URL directly to the download list or backend queue.
- Explicit media handoff is the canonical page URL plus media: true. Do not
  attach a raw browser Cookie header or a browser request-header snapshot.
- Old extension builds may still send cookies with a media request. Desktop
  code must discard those media cookies before opening the Add window while
  preserving cookies for ordinary captured file downloads.
- Media authentication belongs to Firelink's configured mediaCookieSource.
  Cookies or headers the user explicitly enters in the Add window are a
  separate, validated trust path and must not be conflated with extension data.
- The extension source of truth is
  /Users/nima/Documents/Code/Firelink-Extension. When extension behavior
  changes, verify and publish that repository first, then advance the
  Extensions/Browser gitlink in this repository. Never pin the parent to an
  older extension behavior by accident.

### Downloads and bundled engines

- Normal file downloads are Aria2-backed. Media downloads use yt-dlp and may
  invoke bundled FFmpeg and Deno. Do not treat the Swift/legacy implementation
  or a user-installed binary as the active architecture.
- Resolve aria2, yt-dlp, FFmpeg, and Deno from Firelink's bundled engine
  resolution. Do not depend on the user's PATH.
- Keep yt-dlp as its official onedir payload: executable plus adjacent
  _internal/, embedded runtime, and solver files. Do not replace it with a
  onefile or system installation without a deliberate packaging decision.
- Never log, persist, or expose cookies, authorization headers, pairing tokens,
  passwords, private paths, or other secrets merely to make a failure easier to
  diagnose. Redact at the boundary and keep errors actionable without secret
  material.
- Windows subprocess and daemon file handles can outlive process termination.
  Deleting or replacing an artifact after sidecar activity needs bounded retry
  with backoff and a safe failure path.

### Proxy and network claims

Proxy capability is per consumer: metadata requests, yt-dlp media transfers,
FFmpeg/Deno child work, and Aria2 normal downloads do not have identical
support. Metadata success does not prove final transfer success. Do not claim
SOCKS or another proxy mode works end to end unless every consumer in the
described workflow supports it; Aria2 is the limiting path for broad normal-
download promises.

## Queue and Aria2 lifecycle invariants

Treat this as a state machine, not a collection of independent button handlers.

- Reserve global and per-queue ownership atomically in one serialized
  admission decision. Select eligible work before capacity can be consumed by
  an ineligible front queue; rotate eligible queues fairly. A queue-limit
  reduction does not cancel transfers already active.
- run_dispatcher must not await a slow addUri before dispatching another
  already-admitted task. Dispatch asynchronously while retaining the
  reservation and lifecycle fencing in the dispatch task.
- Keep exactly one queue permit per Aria2 transfer for the full daemon
  lifecycle. Park it until terminal reconciliation and make release idempotent.
  has_active_permit(id) alone never proves that the current worker owns the
  permit; ownership must be established by the current queue- and
  lifecycle-aware parking operation.
- An Aria2 GID is not a permanent Firelink identity. Retries or re-enqueues can
  receive a new GID; a paused transfer can retain the same GID. Pair the
  download ID and GID with a monotonic control epoch/lifecycle generation.
- A legitimate resume of a paused GID must rebind that GID to the new control
  epoch immediately before aria2.unpause. After every awaited RPC, recheck the
  current epoch, registered ID, and mapped GID before emitting state or
  mutating queue ownership.
- tellActive is not a terminal event feed. A mapped GID missing from it must be
  reconciled through tellStatus, applying only complete, error, or removed;
  leave paused and waiting alone.
- Pause can race with completion. If tellStatus says complete, reconcile
  completion idempotently and report success rather than claiming pause
  failed. Duplicate WebSocket/poller terminal events must be harmless.
- If unpause returns an ambiguous RPC error, query tellStatus before releasing
  the permit: retain it for active/waiting, reconcile completion, and stay
  conservative when the daemon state cannot be verified.
- Terminal cleanup must invalidate delayed retry/control workers, clear retry
  state, forget the GID mapping, release the permit, and release the registered
  ID under the per-download control lock. Late addUri results must not revive a
  removed or newer lifecycle.
- For queue changes, cover worst cases rather than only happy paths: stale
  terminal events after pause, same-GID resume epoch rebinding, GID replacement
  during retry, lost completion events, completion racing with pause, ambiguous
  RPC errors, duplicate terminal events, late addUri, fairness, queue-limit
  shrink, cancellation, restart, and permit ownership.

Use real postconditions in asynchronous tests. Wait for a GID mapping, state
transition, notification, or permit count to become correct; do not assert only
that an RPC call counter increased, and do not use arbitrary sleeps as proof of
completion.

## Media, metadata, progress, and size invariants

- build_media_format_options in src-tauri/src/lib.rs is the source of truth
  for selectable media formats. Do not duplicate format interpretation in
  React. Preserve concrete stream IDs, exact displayed resolutions, exclusion
  of storyboards/MHTML/thumbnails/subtitles, split-track handling, and the
  explicit no-common-format state.
- Keep metadata cache/deduplication keys sensitive to all relevant request
  context: URL, cookie source/browser, credentials, headers/cookies, proxy, and
  user agent. Do not let React development behavior create duplicate yt-dlp
  work.
- yt-dlp arguments must keep explicit --progress together with
  --progress-template; Firelink also uses --print after_move:%(filepath)s,
  and --print implies quiet mode unless progress is enabled.
- Preserve chunk buffering in drain_media_output_lines, structured and
  numeric-percent parsing in parse_media_progress_line, HLS fragment progress,
  split-track aggregation in aggregate_media_fraction, and the
  emit_media_progress event path. One shell output event is not necessarily one
  complete line.
- The live UI path is download-progress -> src/store/downloadStore.ts ->
  src/components/DownloadItem.tsx. React/store state is authoritative; do not
  use imperative DOM mutation for live progress.
- filesize is exact, filesize_approx and bitrate-derived values are estimates,
  and progress-event size is authoritative only when size_is_final is true. A
  completed download should replace an estimate with the actual output size
  from disk.
- Cleanup must use exact artifact boundaries and remain safe for failed,
  canceled, paused, retried, and split-track media work. Never broaden a
  filename pattern until archive-like or unrelated files are proven safe.

## React, UI, i18n, and accessibility

- Async UI work must check that a terminal state or newer lifecycle has not won
  before emitting a transitional status such as Downloading.
- Visible labels, settings, placeholders, controls, and status nouns are
  product claims. Match them to backend capability. A live Aria2 control must
  not be presented as a process-start-only yt-dlp control, and parity tests do
  not prove that a translation is natural.
- Keep the UI dense, native, and functional. For RTL, preserve correct
  document.dir behavior and the physical-LTR download-table/file-column
  contract unless the product explicitly changes it. Review scrolling, narrow
  widths, focus, keyboard paths, reduced motion, and pointer cancellation.
- If an exit animation collapses a wrapper to height 0, the collapsing wrapper
  needs overflow: hidden. Verify visual fixes in the running app or a packaged
  smoke path; a build alone does not prove geometry or focus behavior.
- When changing a native command or shared Rust type, keep generated bindings
  in sync through the repository's binding test/workflow instead of hand-editing
  a stale type.

## Investigation and implementation workflow

1. Establish scope, current branch/status, submodule state, and the exact user
   or issue claim.
2. Read the relevant source path and nearby tests. Search for all producers,
   consumers, persistence fields, events, and user-visible copy.
3. State the root cause and the invariant that must hold after the fix before
   editing. Prefer a focused regression test that fails for the reproduced
   behavior, including a race or malformed-input case when applicable.
4. Implement the smallest root-cause change across every affected layer. Do not
   add a retry, timeout, DOM mutation, fallback, or duplicate parser merely to
   hide an unresolved contract mismatch.
5. Run the focused test first and wait for its real postcondition. Then broaden
   validation according to the risk matrix below.
6. Review git diff, git diff --check, and git status for scope, secrets,
   generated artifacts, unrelated formatting, and accidental submodule changes.

## Verification matrix

Run the smallest relevant checks first. These are the repository's high-value
gates:

    # Frontend and script checks from the repository root
    node --test scripts/*.node-test.js
    npm test -- --run
    npm run build
    npm run check:i18n

    # Backend checks from src-tauri
    cd src-tauri
    cargo test --test queue_manager -- --nocapture
    cargo test --all-targets
    cd ..

    # Engine/package and tree checks when applicable
    node scripts/verify-binaries.js
    git diff --check

Use npm run check:updates for dependency/engine-source audits, but isolate
network endpoint failures and retry them before changing checker logic. Use
node scripts/verify-binaries.js --staged --target <target> after staging
engines and --search-root <package> --target <target> for packaged payloads.
Use npm run tauri build for native Tauri/package changes; npm run build is
frontend-only and cannot validate Rust, bundled engines, or packaging.

The CI workflow currently verifies frontend scripts/tests/build plus Rust and
engine checks on macOS arm64, Windows x64, and Linux x64. Windows has a
different Rust test split from Unix. The release workflow additionally builds
the native packages, checks release identity, verifies final engine payloads,
and runs packaged smoke checks. Local macOS testing is not evidence that
Windows/Linux native behavior is verified; local unit tests are not packaged
launch evidence; a pushed tag is not a published release until the workflow
and release assets are read back.

For live media checks, use an available public multi-quality URL and cookies
only when required. Bot checks, deleted/private videos, age gates, and geo
restrictions are environmental failures, not proof of a Firelink regression.

## Release, submodule, and Git discipline

- Keep package.json, src-tauri/Cargo.toml, and src-tauri/tauri.conf.json aligned.
  Read RELEASE.md before provisioning engines, building packages, or making
  public release claims.
- For paired releases, publish Firelink Companion first, verify its release,
  then advance Extensions/Browser, update Firelink release notes, and publish
  Firelink. Verify the completed workflow, exact assets, release body, and
  browser installation links rather than relying on tag creation.
- Do not claim Apple Developer signing, notarization, Gatekeeper approval, or
  Windows code signing unless the current artifact proves it. Do not claim
  cross-platform runtime QA from a macOS checkout.
- When the user explicitly requests conventional commit spec push main,
  commit and push main, or equivalent, verify branch/status, stage only the
  intended paths, create a Conventional Commit, push origin main, and report
  the commit hash. Do not create a PR unless asked.
- Otherwise, do not commit, push, tag, alter a submodule pointer, or publish
  external replies without explicit authorization. For public issue replies,
  write concise, human, paste-ready text backed by the live result.

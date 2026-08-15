//! Connection-aware retry engine, shared by aria2c file downloads and yt-dlp
//! media downloads.
//!
//! ## Design contract
//!
//! A brief network drop or Wi-Fi timeout must NEVER transition a download
//! directly to a hard `Failed` state. Instead, transient conditions are routed
//! through a 3-strike exponential-backoff retry loop while the active download
//! allocation (semaphore permit / worker slot) is preserved.
//!
//! This module is deliberately runtime-agnostic and free of Tauri types so it
//! can be unit-tested headlessly. Each path translates the schedule into its
//! own state-emission and cancellation vocabulary:
//!
//! - **yt-dlp** (`lib.rs`): sleeps between child re-spawns; `--continue` resumes.
//! - **aria2** (`queue.rs` / WS poller): sleeps before re-issuing `aria2.addUri`.
//!
//! ### aria2 GID-rotation contract (CRITICAL)
//!
//! When aria2 retries via a fresh `aria2.addUri`, it mints a **brand-new GID**.
//! The caller MUST store the new GID through `QueueManager::remember_gid` on
//! every successful re-add. Failing to do so detaches subsequent
//! `onDownloadComplete` / `onDownloadError` WebSocket events from the original
//! id, or strands a terminal event that arrived before the fresh GID was stored.
//! Concretely, after every retry-driven `addUri` that returns `new_gid`:
//!
//! ```ignore
//! queue_manager.remember_gid(id.clone(), new_gid).await;
//! ```

use std::time::Duration;

/// The fixed 3-strike exponential backoff schedule: 2s, then 5s, then 10s
/// before each fresh connection attempt. Indexed 0-based by strike number.
/// A 4th+ strike is clamped to the final (10s) slot by [`backoff_for`].
pub const BACKOFF_SCHEDULE: [Duration; 3] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
];

/// The 429-specific 3-strike escalating backoff schedule: 60s, 120s, 300s.
pub const BACKOFF_SCHEDULE_429: [Duration; 3] = [
    Duration::from_secs(60),
    Duration::from_secs(120),
    Duration::from_secs(300),
];

/// Maximum number of transient-error retries before the download is allowed to
/// fall through to a hard `Failed`. Three strikes matches the schedule length.
pub const MAX_RETRIES: usize = BACKOFF_SCHEDULE.len();

/// Detect Aria2's name-resolution failure without treating arbitrary DNS-like
/// text as a resolver failure. The numeric code is the authoritative signal;
/// the message forms cover older/alternate Aria2 wrappers that omit it.
pub fn is_aria2_name_resolution_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    aria2_error_code(message).as_deref() == Some("19")
        || (lower.contains("name resolution")
            && lower.contains("failed")
            && lower.contains("could not contact dns"))
        || lower.contains("could not contact dns server")
}

/// Extract Aria2's numeric error code without retaining the rest of its
/// message. Aria2 error messages can include the request URI, so diagnostics
/// should record this code rather than the raw text.
pub fn aria2_error_code(message: &str) -> Option<String> {
    let lower = message.to_ascii_lowercase();
    let marker = "aria2 error code";
    let start = lower.find(marker)? + marker.len();
    let remainder = lower[start..].trim_start_matches(|character: char| {
        character.is_ascii_whitespace()
            || matches!(character, ':' | '=' | '(' | ')' | '[' | ']')
    });
    let digits: String = remainder
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    (!digits.is_empty()).then_some(digits)
}

/// Coarse, secret-free classification for retry diagnostics. The returned
/// value is intentionally stable and contains no provider or request text.
pub fn network_error_class(message: &str) -> &'static str {
    if is_aria2_name_resolution_error(message) {
        return "name_resolution";
    }
    let lower = message.to_ascii_lowercase();
    if lower.contains("private/local ip") || lower.contains("ssrf") {
        return "ssrf_policy";
    }
    if lower.contains("permission denied") || lower.contains("operation not permitted") {
        return "permission";
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return "timeout";
    }
    if lower.contains("connection refused") {
        return "connection_refused";
    }
    if lower.contains("connection reset") || lower.contains("connection aborted") {
        return "connection_reset";
    }
    if [
        "invalid range",
        "range not satisfiable",
        "range request",
        "range support",
        "accept-ranges",
        "bounded range",
        "byte range",
        "does not support range",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return "range";
    }
    if lower.contains("dns") || lower.contains("name resolution") {
        return "dns";
    }
    let has_http_version_token = lower.split_whitespace().any(|token| {
        let token = token.trim_start_matches(|character: char| {
            matches!(character, '(' | '[' | '{')
        });
        token.starts_with("http/")
            && token
                .chars()
                .nth(5)
                .is_some_and(|character| character.is_ascii_digit())
    });
    if lower.contains("http error")
        || has_http_version_token
        || lower.contains("http status")
        || lower.contains("response status")
        || lower.contains("status code")
        || [
            "status=400",
            "status=401",
            "status=403",
            "status=404",
            "status=408",
            "status=410",
            "status=429",
            "status=451",
            "status=500",
            "status=502",
            "status=503",
            "status=504",
        ]
        .iter()
        .any(|marker| {
            lower.split_whitespace().any(|token| {
                token
                    .trim_matches(|character: char| {
                        !character.is_ascii_alphanumeric() && character != '='
                    })
                    == *marker
            })
        })
    {
        return "http";
    }
    "transport"
}

/// Resolve the backoff delay for a 0-based strike. Strikes at or beyond the
/// schedule length clamp to the longest slot (10s) rather than panicking, so a
/// mis-sized loop degrades gracefully instead of aborting the worker.
#[inline]
pub fn backoff_for(strike: usize) -> Duration {
    BACKOFF_SCHEDULE
        .get(strike)
        .copied()
        .unwrap_or_else(|| *BACKOFF_SCHEDULE.last().expect("schedule is non-empty"))
}

/// Classify an error string as a transient network condition worth retrying.
///
/// Returns `true` for socket drops, connect/read timeouts, connection resets,
/// and transient HTTP status conditions across both download paths:
///
/// - **yt-dlp**: stderr lines like `ERROR: unable to ... Connection timed out`,
///   `HTTP Error 408`.
/// - **aria2c**: `Timeout.`, `Connection was closed by server`.
///
/// Returns `false` for permanent conditions that retrying cannot fix: HTTP
/// 401/403/404/410/451, "not found", permission denied, out-of-disk. The
/// permanent list is checked first so a composite message (e.g. an HTTP 404
/// that also mentions "timeout" in a URL) still fails fast.
pub fn is_permanent_network_error(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    const PERMANENT_HTTP_STATUS: [&str; 5] = ["401", "403", "404", "410", "451"];
    if PERMANENT_HTTP_STATUS
        .iter()
        .any(|status| contains_http_status(&m, status))
    {
        return true;
    }
    const PERMANENT: [&str; 3] = [
        "404 not found",
        "permission denied",
        "no space left on device",
    ];
    PERMANENT.iter().any(|p| m.contains(p))
}

/// Match the HTTP status formats emitted by both clients, including
/// `HTTP/1.1 403` and `HTTP Error 403`, not only the shorthand `HTTP 403`.
fn contains_http_status(message: &str, status: &str) -> bool {
    let tokens = message
        .split(|character: char| {
            character.is_ascii_whitespace()
                || matches!(character, '/' | '.' | ':' | '-' | '_')
        })
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();

    tokens.windows(2).any(|window| window[0] == "http" && window[1] == status)
        || tokens.windows(3).any(|window| {
            window[0] == "http"
                && (window[1] == "error"
                    || window[1].chars().all(|character| character.is_ascii_digit()))
                && window[2] == status
        })
        || tokens.windows(4).any(|window| {
            window[0] == "http"
                && window[1].chars().all(|character| character.is_ascii_digit())
                && window[2].chars().all(|character| character.is_ascii_digit())
                && window[3] == status
        })
}

pub fn is_transient_network_error(message: &str) -> bool {
    if is_permanent_network_error(message) {
        return false;
    }

    if is_aria2_name_resolution_error(message) {
        return true;
    }

    let m = message.to_ascii_lowercase();

    const TRANSIENT: [&str; 36] = [
        // socket-layer / HTTP-client phrasing surfaced by aria2 and yt-dlp
        "timed out",
        "timeout",
        "connection reset",
        "broken pipe",
        "connection refused",
        "network is unreachable",
        "network unreachable",
        "no route to host",
        "host unreachable",
        "temporarily unavailable",
        "operation timed out",
        "connection aborted",
        "error sending request", // reqwest wrapper for connect/send failures
        "dns error",             // transient resolver failures
        "name resolution",       // aria2 name-resolution failures
        "could not contact dns", // aria2 c-ares resolver failures
        "protocol error",        // aria2 read/protocol failures after a link drop
        "tls handshake failure",
        "ssl/tls handshake failure",
        // HTTP-level transient
        "request timeout",
        "503 service unavailable",
        "429 too many requests",
        // aria2c HTTP error formats
        "status=408",
        "status=429",
        "status=500",
        "status=502",
        "status=503",
        "status=504",
        "status=520",
        "status=521",
        "status=522",
        "status=523",
        "status=524",
        // aria2c log phrasing
        "connection was closed",
        "timeout.",
        "invalid range header",
    ];
    const TRANSIENT_HTTP_STATUS: [&str; 11] = [
        "408", "429", "500", "502", "503", "504", "520", "521", "522", "523", "524",
    ];
    TRANSIENT_HTTP_STATUS
        .iter()
        .any(|status| contains_http_status(&m, status))
        || TRANSIENT.iter().any(|t| m.contains(t))
}

/// Outcome of a cancel-safe backoff sleep wrapped around a transient retry.
#[derive(PartialEq, Eq)]
pub enum BackoffOutcome {
    /// Backoff completed; the caller may re-issue the download attempt.
    Continue,
    /// Pause/cancel interrupted the wait; the caller must abort without failing.
    Aborted,
}

/// Emit a `Retrying` state, then sleep for the strike's backoff slot. The
/// `interrupt` future is raced via `tokio::select!` so pause/cancel paths can
/// abort the wait without waiting for the full delay.
pub async fn backoff_and_emit(
    strike: usize,
    reason: String,
    interrupt: impl std::future::Future<Output = ()>,
    emit: impl FnOnce(String),
) -> BackoffOutcome {
    let attempt = strike + 1;
    emit(format!("Network drop — retry #{attempt}: {reason}"));
    let delay = if reason.to_ascii_lowercase().contains("429") {
        BACKOFF_SCHEDULE_429
            .get(strike)
            .copied()
            .unwrap_or_else(|| *BACKOFF_SCHEDULE_429.last().unwrap())
    } else {
        backoff_for(strike)
    };
    tokio::select! {
        _ = tokio::time::sleep(delay) => BackoffOutcome::Continue,
        _ = interrupt => BackoffOutcome::Aborted,
    }
}

/// yt-dlp / media runners: interrupt when the coordinator signals cancel via
/// a watch channel.
pub async fn backoff_and_emit_cancel(
    strike: usize,
    reason: String,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
    emit: impl FnOnce(String),
) -> BackoffOutcome {
    backoff_and_emit(
        strike,
        reason,
        async {
            let _ = cancel_rx.changed().await;
        },
        emit,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- backoff schedule -------------------------------------------------

    #[test]
    fn schedule_is_three_strike_exponential() {
        assert_eq!(
            BACKOFF_SCHEDULE,
            [
                Duration::from_secs(2),
                Duration::from_secs(5),
                Duration::from_secs(10)
            ]
        );
        assert_eq!(MAX_RETRIES, 3);
    }

    #[test]
    fn extracts_aria2_error_code_without_message_material() {
        for error in [
            "aria2 error code 19: Could not contact DNS servers",
            "aria2 error code: 19: Could not contact DNS servers",
            "aria2 error code (19): Could not contact DNS servers",
            "aria2 error code=19: Could not contact DNS servers",
        ] {
            assert_eq!(aria2_error_code(error).as_deref(), Some("19"));
        }
        let error =
            "aria2 error code 19: Could not contact DNS servers for https://example.test/file?token=secret";
        assert_eq!(network_error_class(error), "name_resolution");
        assert_eq!(aria2_error_code("aria2 error code: unknown 19"), None);
        assert!(is_aria2_name_resolution_error("aria2 error code: 19"));
    }

    #[test]
    fn classifies_diagnostic_errors_without_echoing_private_details() {
        assert_eq!(network_error_class("operation not permitted"), "permission");
        assert_eq!(network_error_class("connect timed out"), "timeout");
        assert_eq!(network_error_class("invalid range header"), "range");
        assert_eq!(
            network_error_class("error sending request for https://example.test/file"),
            "transport"
        );
        assert_eq!(
            network_error_class("error sending request for http://example.test/file"),
            "transport"
        );
        assert_eq!(
            network_error_class("error sending request for https://example.test/file?status=503"),
            "transport"
        );
        assert_eq!(network_error_class("ranged GET fallback failed"), "transport");
        assert_eq!(network_error_class("HTTP Error 503"), "http");
    }

    #[test]
    fn backoff_for_indexes_then_clamps() {
        assert_eq!(backoff_for(0), Duration::from_secs(2));
        assert_eq!(backoff_for(1), Duration::from_secs(5));
        assert_eq!(backoff_for(2), Duration::from_secs(10));
        // Out-of-range strikes clamp to the longest slot, never panic.
        assert_eq!(backoff_for(3), Duration::from_secs(10));
        assert_eq!(backoff_for(usize::MAX), Duration::from_secs(10));
    }

    // --- transient classification: positive cases -------------------------

    #[test]
    fn classifies_socket_timeouts_as_transient() {
        assert!(is_transient_network_error("operation timed out"));
        assert!(is_transient_network_error(
            "error sending request: operation timed out"
        ));
        assert!(is_transient_network_error("connection reset by peer"));
        assert!(is_transient_network_error(
            "connection refused (os error 61)"
        ));
        assert!(is_transient_network_error(
            "dns error: failed to lookup address"
        ));
    }

    #[test]
    fn classifies_http_408_as_transient() {
        assert!(is_transient_network_error("HTTP 408 Request Timeout"));
        assert!(is_transient_network_error("request timeout"));
    }

    #[test]
    fn classifies_http_503_as_transient() {
        assert!(is_transient_network_error("HTTP 503 Service Unavailable"));
        assert!(is_transient_network_error("HTTP/1.1 503 Service Unavailable"));
        assert!(is_transient_network_error(
            "http://127.0.0.1/file returned HTTP 503 Service Unavailable"
        ));
    }

    #[test]
    fn classifies_http_429_as_transient() {
        assert!(is_transient_network_error("HTTP 429 Too Many Requests"));
        assert!(is_transient_network_error("HTTP Error 429: Too Many Requests"));
        assert!(is_transient_network_error("429 too many requests"));
        assert!(is_transient_network_error("The response status is not successful. status=429"));
    }

    #[test]
    fn classifies_rpc_http_gateway_errors_as_transient() {
        for status in [500, 502, 503, 504, 520, 521, 522, 523, 524] {
            assert!(
                is_transient_network_error(&format!("HTTP {status} gateway failure")),
                "HTTP {status} should be retryable"
            );
        }
    }

    #[test]
    fn classifies_ytdlp_and_aria2_phrasing_as_transient() {
        assert!(is_transient_network_error(
            "ERROR: unable to download video: Connection timed out"
        ));
        assert!(is_transient_network_error(
            "Connection was closed by server"
        ));
        assert!(is_transient_network_error("Timeout."));
        assert!(is_transient_network_error("network is unreachable"));
        assert!(is_transient_network_error("The response status is not successful. status=503"));
        assert!(is_transient_network_error("The response status is not successful. status=502"));
        assert!(is_transient_network_error("Invalid range header. Request: 106954752-361758719/383882118, Response: 106954752-383882117/383882118"));
        assert!(is_transient_network_error(
            "aria2 error code 1: Failed to receive data, cause: protocol error"
        ));
        assert!(is_transient_network_error(
            "SSL/TLS handshake failure: protocol error"
        ));
    }

    #[test]
    fn classifies_aria2_name_resolution_failures_precisely() {
        assert!(is_aria2_name_resolution_error(
            "aria2 error code 19: Name resolution for example.test failed: Could not contact DNS servers."
        ));
        assert!(is_aria2_name_resolution_error(
            "Name resolution for example.test failed: Could not contact DNS server"
        ));
        assert!(is_aria2_name_resolution_error(
            "aria2 error code 19: connection refused"
        ));
        assert!(!is_aria2_name_resolution_error(
            "aria2 error code 8: No URI available"
        ));
    }

    // --- transient classification: negative cases -------------------------

    #[test]
    fn refuses_to_retry_permanent_http_statuses() {
        assert!(!is_transient_network_error("HTTP 404 Not Found"));
        assert!(!is_transient_network_error("HTTP/1.1 403 Forbidden"));
        assert!(!is_transient_network_error("HTTP Error 404: Not Found"));
        assert!(!is_transient_network_error("HTTP 403 Forbidden"));
        assert!(!is_transient_network_error("HTTP 410 Gone"));
        assert!(!is_transient_network_error("HTTP 401 Unauthorized"));
        assert!(!is_transient_network_error(
            "HTTP 451 Unavailable For Legal Reasons"
        ));
    }

    #[test]
    fn refuses_to_retry_permanent_fs_errors() {
        assert!(!is_transient_network_error("No space left on device"));
        assert!(!is_transient_network_error(
            "Permission denied (os error 13)"
        ));
    }

    #[test]
    fn permanent_keyword_wins_over_transient_in_composite_message() {
        // A 404 whose URL happens to contain "timeout" must still fail fast
        // because the explicit "http 404" token wins.
        assert!(!is_transient_network_error(
            "https://site/timeout-page returned HTTP 404 Not Found"
        ));
        assert!(!is_transient_network_error(
            "https://slow-host/ returned HTTP 403 Forbidden"
        ));
    }

    #[test]
    fn benign_messages_are_not_transient() {
        assert!(!is_transient_network_error("invalid HTTP header: x-bad"));
        assert!(!is_transient_network_error("path traversal blocked"));
        assert!(!is_transient_network_error(""));
    }
}

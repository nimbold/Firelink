use chrono::{Datelike, Local, NaiveDate, Timelike};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::Emitter;

fn minute_of_day(value: &str) -> Option<u32> {
    let bytes = value.as_bytes();
    if bytes.len() != 5
        || bytes[2] != b':'
        || !bytes[0].is_ascii_digit()
        || !bytes[1].is_ascii_digit()
        || !bytes[3].is_ascii_digit()
        || !bytes[4].is_ascii_digit()
    {
        return None;
    }
    let hour = u32::from(bytes[0] - b'0') * 10 + u32::from(bytes[1] - b'0');
    let minute = u32::from(bytes[3] - b'0') * 10 + u32::from(bytes[4] - b'0');
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}

fn stop_is_due(
    stop_time_enabled: bool,
    stop_minute: Option<u32>,
    current_minute: u32,
    last_start_key: &str,
    triggered_start_key: &str,
    start_key: &str,
    last_stop_key: &str,
    stop_key: &str,
) -> bool {
    stop_time_enabled
        && stop_minute.is_some_and(|stop| current_minute >= stop)
        && (last_start_key == start_key || triggered_start_key == start_key)
        && last_stop_key != stop_key
}

struct OvernightStopCheck<'a> {
    stop_time_enabled: bool,
    start_minute: Option<u32>,
    stop_minute: Option<u32>,
    current_minute: u32,
    previous_day_allowed: bool,
    last_start_key: &'a str,
    triggered_start_key: &'a str,
    previous_start_key: &'a str,
    last_stop_key: &'a str,
    stop_key: &'a str,
}

fn overnight_stop_is_due(check: OvernightStopCheck<'_>) -> bool {
    let OvernightStopCheck {
        stop_time_enabled,
        start_minute,
        stop_minute,
        current_minute,
        previous_day_allowed,
        last_start_key,
        triggered_start_key,
        previous_start_key,
        last_stop_key,
        stop_key,
    } = check;
    stop_time_enabled
        && previous_day_allowed
        && start_minute.zip(stop_minute).is_some_and(|(start, stop)| {
            stop < start && current_minute >= stop && current_minute < start
        })
        && (last_start_key == previous_start_key || triggered_start_key == previous_start_key)
        && last_stop_key != stop_key
}

fn scheduler_run_snapshot(
    start_key: &str,
    scheduler: &crate::ipc::SchedulerSettings,
) -> crate::ipc::SchedulerRunSnapshot {
    let stop = if scheduler.stop_time_enabled {
        let start_minute = minute_of_day(&scheduler.start_time);
        let stop_minute = minute_of_day(&scheduler.stop_time);
        start_minute.zip(stop_minute).and_then(|(start, stop)| {
            let date = start_key
                .strip_suffix("-start")
                .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())?;
            let stop_date = if stop < start { date.succ_opt()? } else { date };
            Some((format!("{}-stop", stop_date.format("%Y-%m-%d")), stop))
        })
    } else {
        None
    };

    crate::ipc::SchedulerRunSnapshot {
        start_key: start_key.to_string(),
        stop_key: stop.as_ref().map(|(key, _)| key.clone()),
        stop_minute: stop.map(|(_, minute)| minute),
    }
}

fn snapshot_stop_is_due(
    snapshot: &crate::ipc::SchedulerRunSnapshot,
    current_stop_key: &str,
    current_minute: u32,
    last_stop_key: &str,
) -> bool {
    snapshot
        .stop_key
        .as_deref()
        .zip(snapshot.stop_minute)
        .is_some_and(|(stop_key, stop_minute)| {
            stop_key == current_stop_key
                && current_minute >= stop_minute
                && last_stop_key != stop_key
        })
}

fn persist_scheduler_start_trigger(
    app_handle: &tauri::AppHandle,
    settings_cache: &Arc<RwLock<Option<crate::ipc::PersistedSettings>>>,
    key: &str,
    scheduler: &crate::ipc::SchedulerSettings,
) {
    let snapshot = scheduler_run_snapshot(key, scheduler);
    if let Err(error) = crate::settings::update_settings_state(app_handle, |state| {
        state.insert(
            "schedulerTriggeredStartKey".to_string(),
            serde_json::json!(key),
        );
        state.insert(
            "schedulerActiveRunSnapshot".to_string(),
            serde_json::json!({
                "startKey": snapshot.start_key,
                "stopKey": snapshot.stop_key,
                "stopMinute": snapshot.stop_minute
            }),
        );
    }) {
        log::warn!("Failed to persist scheduler start trigger: {error}");
    }

    if let Ok(mut settings) = settings_cache.write() {
        if let Some(settings) = settings.as_mut() {
            settings.scheduler_triggered_start_key = Some(key.to_string());
            settings.scheduler_active_run_snapshot = Some(snapshot);
        }
    }
}

pub fn spawn_scheduler(
    app_handle: tauri::AppHandle,
    settings_cache: Arc<RwLock<Option<crate::ipc::PersistedSettings>>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        let mut last_emit: HashMap<&'static str, std::time::Instant> = HashMap::new();
        // Renderer acknowledgement remains the durable completion record, but
        // a native dispatch marker also survives a closed/unmounted webview so
        // an overnight stop does not become permanently ineligible. The
        // process-local start key also covers the same-loop event/stop check.
        let mut triggered_start_key = String::new();
        loop {
            interval.tick().await;

            let settings = settings_cache.read().ok().and_then(|settings| {
                settings.as_ref().map(|settings| {
                    (
                        settings.scheduler.clone(),
                        settings.scheduler_last_start_key.clone(),
                        settings
                            .scheduler_triggered_start_key
                            .clone()
                            .unwrap_or_default(),
                        settings.scheduler_last_stop_key.clone(),
                        settings.scheduler_active_run_snapshot.clone(),
                    )
                })
            });
            if let Some((
                scheduler,
                scheduler_last_start_key,
                persisted_triggered_start_key,
                scheduler_last_stop_key,
                scheduler_active_run_snapshot,
            )) = settings
            {
                if !scheduler.enabled {
                    continue;
                }

                let now = Local::now();
                let current_minute = now.hour() * 60 + now.minute();
                let current_day = now.weekday().num_days_from_sunday();

                let allowed_today =
                    scheduler.everyday || scheduler.selected_days.contains(&current_day);
                let date_key = now.format("%Y-%m-%d").to_string();
                let start_key = format!("{date_key}-start");
                let stop_key = format!("{date_key}-stop");
                let start_minute = minute_of_day(&scheduler.start_time);
                let stop_minute = minute_of_day(&scheduler.stop_time);
                let overnight = start_minute
                    .zip(stop_minute)
                    .is_some_and(|(start, stop)| stop < start);
                let before_stop = !scheduler.stop_time_enabled
                    || stop_minute.is_some_and(|stop| current_minute < stop);

                if allowed_today
                    && start_minute.is_some_and(|start| current_minute >= start)
                    && (overnight || before_stop)
                    && scheduler_last_start_key != start_key
                    && last_emit
                        .get("start")
                        .is_none_or(|instant| instant.elapsed() >= Duration::from_secs(5))
                {
                    if (persisted_triggered_start_key != start_key
                        && triggered_start_key != start_key)
                        || scheduler_active_run_snapshot
                            .as_ref()
                            .is_none_or(|snapshot| snapshot.start_key != start_key)
                    {
                        // Record the dispatch intent before emitting so a
                        // crash between the native event and renderer ack
                        // still makes an overnight stop eligible. Start
                        // events remain retryable until the renderer acks
                        // them, which covers startup/listener races.
                        persist_scheduler_start_trigger(
                            &app_handle,
                            &settings_cache,
                            &start_key,
                            &scheduler,
                        );
                    }
                    if app_handle.emit(
                        "schedule-trigger",
                        serde_json::json!({
                            "action": "start",
                            "key": start_key
                        }),
                    ).is_ok() {
                        triggered_start_key = start_key.clone();
                    }
                    last_emit.insert("start", std::time::Instant::now());
                }

                let same_day_stop_due = allowed_today
                    && !overnight
                    && stop_is_due(
                        scheduler.stop_time_enabled,
                        stop_minute,
                        current_minute,
                        &scheduler_last_start_key,
                        if triggered_start_key == start_key {
                            start_key.as_str()
                        } else if persisted_triggered_start_key == start_key {
                            start_key.as_str()
                        } else {
                            ""
                        },
                        &start_key,
                        &scheduler_last_stop_key,
                        &stop_key,
                    );
                let previous_day = now.date_naive().pred_opt();
                let previous_day_allowed = previous_day.is_some_and(|day| {
                    scheduler.everyday
                        || scheduler
                            .selected_days
                            .contains(&day.weekday().num_days_from_sunday())
                });
                let previous_start_key = previous_day
                    .map(|day| format!("{}-start", day.format("%Y-%m-%d")))
                    .unwrap_or_default();
                let overnight_stop_due = overnight_stop_is_due(OvernightStopCheck {
                    stop_time_enabled: scheduler.stop_time_enabled,
                    start_minute,
                    stop_minute,
                    current_minute,
                    previous_day_allowed,
                    last_start_key: &scheduler_last_start_key,
                    triggered_start_key: if triggered_start_key == previous_start_key {
                        previous_start_key.as_str()
                    } else if persisted_triggered_start_key == previous_start_key {
                        previous_start_key.as_str()
                    } else {
                        ""
                    },
                    previous_start_key: &previous_start_key,
                    last_stop_key: &scheduler_last_stop_key,
                    stop_key: &stop_key,
                });

                let active_snapshot = scheduler_active_run_snapshot.as_ref().filter(|snapshot| {
                    snapshot.start_key == scheduler_last_start_key
                        || snapshot.start_key == persisted_triggered_start_key
                        || snapshot.start_key == triggered_start_key
                });
                let snapshot_stop_due = active_snapshot.is_some_and(|snapshot| {
                    snapshot_stop_is_due(
                        snapshot,
                        &stop_key,
                        current_minute,
                        &scheduler_last_stop_key,
                    )
                });
                let stop_due = if active_snapshot.is_some() {
                    snapshot_stop_due
                } else {
                    same_day_stop_due || overnight_stop_due
                };
                if stop_due
                    && last_emit
                        .get("stop")
                        .is_none_or(|instant| instant.elapsed() >= Duration::from_secs(5))
                {
                    let _ = app_handle.emit(
                        "schedule-trigger",
                        serde_json::json!({
                            "action": "stop",
                            "key": active_snapshot
                                .and_then(|snapshot| snapshot.stop_key.as_deref())
                                .unwrap_or(&stop_key)
                        }),
                    );
                    last_emit.insert("stop", std::time::Instant::now());
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        minute_of_day, overnight_stop_is_due, scheduler_run_snapshot, snapshot_stop_is_due,
        stop_is_due, OvernightStopCheck,
    };
    use crate::ipc::{PostQueueAction, SchedulerSettings};

    fn scheduler_settings(
        start_time: &str,
        stop_enabled: bool,
        stop_time: &str,
    ) -> SchedulerSettings {
        SchedulerSettings {
            enabled: true,
            start_time: start_time.to_string(),
            stop_time_enabled: stop_enabled,
            stop_time: stop_time.to_string(),
            everyday: false,
            selected_days: vec![1],
            selected_queue_ids: Vec::new(),
            post_queue_action: PostQueueAction::None,
        }
    }

    #[test]
    fn parses_valid_scheduler_times() {
        assert_eq!(minute_of_day("00:00"), Some(0));
        assert_eq!(minute_of_day("23:59"), Some(1439));
        assert_eq!(minute_of_day("06:30"), Some(390));
    }

    #[test]
    fn rejects_invalid_scheduler_times() {
        assert_eq!(minute_of_day("24:00"), None);
        assert_eq!(minute_of_day("12:60"), None);
        assert_eq!(minute_of_day("1:02"), None);
        assert_eq!(minute_of_day("01:2"), None);
        assert_eq!(minute_of_day(" 01:02"), None);
        assert_eq!(minute_of_day("01:02 "), None);
        assert_eq!(minute_of_day("bad"), None);
    }

    #[test]
    fn snapshots_overnight_stop_boundary_for_started_run() {
        let snapshot = scheduler_run_snapshot(
            "2026-06-22-start",
            &scheduler_settings("22:00", true, "06:00"),
        );

        assert_eq!(snapshot.start_key, "2026-06-22-start");
        assert_eq!(snapshot.stop_key.as_deref(), Some("2026-06-23-stop"));
        assert_eq!(snapshot.stop_minute, Some(360));
        // Later edits to weekdays or start/stop settings cannot change this
        // already-started run's stop boundary.
        assert!(snapshot_stop_is_due(&snapshot, "2026-06-23-stop", 420, ""));
        assert!(!snapshot_stop_is_due(&snapshot, "2026-06-23-stop", 359, ""));
        assert!(!snapshot_stop_is_due(
            &snapshot,
            "2026-06-23-stop",
            420,
            "2026-06-23-stop"
        ));
    }

    #[test]
    fn snapshots_same_day_stop_and_disabled_stop() {
        let same_day = scheduler_run_snapshot(
            "2026-06-22-start",
            &scheduler_settings("08:00", true, "18:30"),
        );
        assert_eq!(same_day.stop_key.as_deref(), Some("2026-06-22-stop"));
        assert_eq!(same_day.stop_minute, Some(1110));

        let no_stop = scheduler_run_snapshot(
            "2026-06-22-start",
            &scheduler_settings("08:00", false, "18:30"),
        );
        assert_eq!(no_stop.stop_key, None);
        assert_eq!(no_stop.stop_minute, None);
        assert!(!snapshot_stop_is_due(&no_stop, "2026-06-22-stop", 1200, ""));
    }

    #[test]
    fn stop_requires_same_day_acknowledged_start() {
        assert!(!stop_is_due(
            true,
            Some(480),
            600,
            "",
            "",
            "2026-06-22-start",
            "",
            "2026-06-22-stop",
        ));
        assert!(stop_is_due(
            true,
            Some(480),
            600,
            "2026-06-22-start",
            "",
            "2026-06-22-start",
            "",
            "2026-06-22-stop",
        ));
    }

    #[test]
    fn stop_accepts_process_local_start_when_renderer_ack_is_missing() {
        assert!(stop_is_due(
            true,
            Some(480),
            600,
            "",
            "2026-06-22-start",
            "2026-06-22-start",
            "",
            "2026-06-22-stop",
        ));
    }

    #[test]
    fn overnight_stop_accepts_persisted_start_trigger_when_app_restarts() {
        assert!(overnight_stop_is_due(OvernightStopCheck {
            stop_time_enabled: true,
            start_minute: Some(1320),
            stop_minute: Some(360),
            current_minute: 420,
            previous_day_allowed: true,
            last_start_key: "",
            triggered_start_key: "2026-06-22-start",
            previous_start_key: "2026-06-22-start",
            last_stop_key: "",
            stop_key: "2026-06-23-stop",
        }));
    }

    #[test]
    fn overnight_stop_uses_the_previous_day_start() {
        assert!(overnight_stop_is_due(OvernightStopCheck {
            stop_time_enabled: true,
            start_minute: Some(1320),
            stop_minute: Some(360),
            current_minute: 420,
            previous_day_allowed: true,
            last_start_key: "2026-06-22-start",
            triggered_start_key: "",
            previous_start_key: "2026-06-22-start",
            last_stop_key: "",
            stop_key: "2026-06-23-stop",
        }));
        assert!(!overnight_stop_is_due(OvernightStopCheck {
            stop_time_enabled: true,
            start_minute: Some(1320),
            stop_minute: Some(360),
            current_minute: 1380,
            previous_day_allowed: true,
            last_start_key: "2026-06-22-start",
            triggered_start_key: "",
            previous_start_key: "2026-06-22-start",
            last_stop_key: "",
            stop_key: "2026-06-22-stop",
        }));
        assert!(!overnight_stop_is_due(OvernightStopCheck {
            stop_time_enabled: true,
            start_minute: Some(1320),
            stop_minute: Some(360),
            current_minute: 420,
            previous_day_allowed: false,
            last_start_key: "2026-06-22-start",
            triggered_start_key: "",
            previous_start_key: "2026-06-22-start",
            last_stop_key: "",
            stop_key: "2026-06-23-stop",
        }));
    }
}

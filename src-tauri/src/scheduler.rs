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
            let scheduled_date = stop_key
                .strip_suffix("-stop")
                .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok());
            let current_date = current_stop_key
                .strip_suffix("-stop")
                .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok());
            scheduled_date
                .zip(current_date)
                .is_some_and(|(scheduled, current)| {
                    (scheduled < current || (scheduled == current && current_minute >= stop_minute))
                        && last_stop_key != stop_key
                })
        })
}

fn active_snapshot_stop_is_due(
    snapshot: &crate::ipc::SchedulerRunSnapshot,
    current_stop_key: &str,
    current_minute: u32,
    last_stop_key: &str,
) -> bool {
    snapshot_stop_is_due(snapshot, current_stop_key, current_minute, last_stop_key)
}

fn active_snapshot_stop_is_pending(
    snapshot: &crate::ipc::SchedulerRunSnapshot,
    last_stop_key: &str,
) -> bool {
    snapshot
        .stop_key
        .as_deref()
        .is_some_and(|stop_key| last_stop_key != stop_key)
}

fn eligible_start_key(
    start_due: bool,
    stop_due: bool,
    active_stop_pending: bool,
    start_key: &str,
) -> Option<String> {
    (start_due && !stop_due && !active_stop_pending).then(|| start_key.to_string())
}

fn snapshot_belongs_to_active_scheduler_run(
    snapshot: &crate::ipc::SchedulerRunSnapshot,
    last_start_key: &str,
    persisted_triggered_start_key: &str,
    triggered_start_key: &str,
) -> bool {
    snapshot.start_key == last_start_key
        || snapshot.start_key == persisted_triggered_start_key
        || snapshot.start_key == triggered_start_key
}

#[derive(Debug, PartialEq, Eq)]
enum SchedulerAction {
    Stop { key: String, run_key: String },
    Start(String),
}

fn next_scheduler_action(
    due_stop: Option<(String, String)>,
    due_start_key: Option<String>,
) -> Option<SchedulerAction> {
    due_stop
        .map(|(key, run_key)| SchedulerAction::Stop { key, run_key })
        .or_else(|| due_start_key.map(SchedulerAction::Start))
}

pub(crate) fn scheduler_trigger_matches_state(
    state: &serde_json::Map<String, serde_json::Value>,
    action: &str,
    key: &str,
    run_key: &str,
) -> bool {
    match action {
        "start" => {
            key == run_key
                && state
                    .get("schedulerTriggeredStartKey")
                    .and_then(serde_json::Value::as_str)
                    == Some(run_key)
        }
        "stop" => {
            let snapshot = state
                .get("schedulerActiveRunSnapshot")
                .and_then(serde_json::Value::as_object);
            if let Some(snapshot) = snapshot {
                snapshot.get("startKey").and_then(serde_json::Value::as_str) == Some(run_key)
                    && snapshot.get("stopKey").and_then(serde_json::Value::as_str) == Some(key)
            } else {
                state
                    .get("schedulerLastStartKey")
                    .and_then(serde_json::Value::as_str)
                    == Some(run_key)
                    && state
                        .get("schedulerLastStopKey")
                        .and_then(serde_json::Value::as_str)
                        != Some(key)
            }
        }
        _ => false,
    }
}

fn persist_scheduler_start_trigger(
    app_handle: &tauri::AppHandle,
    settings_cache: &Arc<RwLock<Option<crate::ipc::PersistedSettings>>>,
    key: &str,
    scheduler: &crate::ipc::SchedulerSettings,
) -> Result<(), String> {
    let snapshot = scheduler_run_snapshot(key, scheduler);
    crate::settings::update_settings_state(app_handle, |state| {
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
    })?;

    let mut settings = settings_cache
        .write()
        .map_err(|_| "scheduler settings cache is unavailable".to_string())?;
    let settings = settings
        .as_mut()
        .ok_or_else(|| "scheduler settings are not loaded".to_string())?;
    settings.scheduler_triggered_start_key = Some(key.to_string());
    settings.scheduler_active_run_snapshot = Some(snapshot);
    Ok(())
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
                    snapshot_belongs_to_active_scheduler_run(
                        snapshot,
                        &scheduler_last_start_key,
                        &persisted_triggered_start_key,
                        &triggered_start_key,
                    )
                });
                let snapshot_stop_due = active_snapshot.is_some_and(|snapshot| {
                    active_snapshot_stop_is_due(
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

                let due_stop_key = (stop_due
                    && last_emit
                        .get("stop")
                        .is_none_or(|instant| instant.elapsed() >= Duration::from_secs(5)))
                .then(|| {
                    active_snapshot
                        .and_then(|snapshot| snapshot.stop_key.clone())
                        .unwrap_or_else(|| stop_key.clone())
                });
                let due_stop = due_stop_key.map(|key| {
                    let run_key = active_snapshot
                        .map(|snapshot| snapshot.start_key.clone())
                        .unwrap_or_else(|| {
                            if overnight_stop_due {
                                previous_start_key.clone()
                            } else {
                                start_key.clone()
                            }
                        });
                    (key, run_key)
                });
                let start_due = allowed_today
                    && start_minute.is_some_and(|start| current_minute >= start)
                    && (overnight || before_stop)
                    && scheduler_last_start_key != start_key
                    && last_emit
                        .get("start")
                        .is_none_or(|instant| instant.elapsed() >= Duration::from_secs(5));
                let active_stop_pending = active_snapshot.is_some_and(|snapshot| {
                    active_snapshot_stop_is_pending(snapshot, &scheduler_last_stop_key)
                });
                let due_start_key =
                    eligible_start_key(start_due, stop_due, active_stop_pending, &start_key);

                match next_scheduler_action(due_stop, due_start_key) {
                    Some(SchedulerAction::Stop { key, run_key }) => {
                        if app_handle
                            .emit(
                                "schedule-trigger",
                                serde_json::json!({
                                    "action": "stop",
                                    "key": key,
                                    "runKey": run_key
                                }),
                            )
                            .is_ok()
                        {
                            last_emit.insert("stop", std::time::Instant::now());
                        }
                    }
                    Some(SchedulerAction::Start(key)) => {
                        if (persisted_triggered_start_key != key && triggered_start_key != key)
                            || scheduler_active_run_snapshot
                                .as_ref()
                                .is_none_or(|snapshot| snapshot.start_key != key)
                        {
                            // Record dispatch intent only after the previous
                            // run's captured stop has been acknowledged. This
                            // keeps its snapshot available until stop succeeds.
                            if let Err(error) = persist_scheduler_start_trigger(
                                &app_handle,
                                &settings_cache,
                                &key,
                                &scheduler,
                            ) {
                                log::warn!("Failed to persist scheduler start trigger: {error}");
                                continue;
                            }
                        }
                        if app_handle
                            .emit(
                                "schedule-trigger",
                                serde_json::json!({
                                    "action": "start",
                                    "key": key,
                                    "runKey": key
                                }),
                            )
                            .is_ok()
                        {
                            triggered_start_key = start_key;
                            last_emit.insert("start", std::time::Instant::now());
                        }
                    }
                    None => {}
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        active_snapshot_stop_is_due, active_snapshot_stop_is_pending, eligible_start_key,
        minute_of_day, next_scheduler_action, overnight_stop_is_due, scheduler_run_snapshot,
        scheduler_trigger_matches_state, snapshot_belongs_to_active_scheduler_run,
        snapshot_stop_is_due, stop_is_due, OvernightStopCheck, SchedulerAction,
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
    fn missed_stop_from_an_older_run_precedes_the_next_start_and_retries_until_acknowledged() {
        let snapshot = scheduler_run_snapshot(
            "2026-06-22-start",
            &scheduler_settings("22:00", true, "06:00"),
        );
        let due_stop_key = snapshot_stop_is_due(&snapshot, "2026-06-23-stop", 1320, "")
            .then(|| snapshot.stop_key.clone().unwrap());
        let due_start_key = Some("2026-06-23-start".to_string());

        assert_eq!(
            next_scheduler_action(
                due_stop_key.map(|key| (key, snapshot.start_key.clone())),
                due_start_key.clone()
            ),
            Some(SchedulerAction::Stop {
                key: "2026-06-23-stop".to_string(),
                run_key: "2026-06-22-start".to_string()
            })
        );
        assert!(snapshot_stop_is_due(&snapshot, "2026-06-23-stop", 1320, ""));
        assert!(!snapshot_stop_is_due(
            &snapshot,
            "2026-06-23-stop",
            1320,
            "2026-06-23-stop"
        ));
        assert_eq!(
            next_scheduler_action(None, due_start_key),
            Some(SchedulerAction::Start("2026-06-23-start".to_string()))
        );
    }

    #[test]
    fn scheduler_trigger_acknowledgements_are_fenced_to_their_run() {
        let state = serde_json::json!({
            "schedulerTriggeredStartKey": "2026-06-23-start",
            "schedulerLastStartKey": "2026-06-22-start",
            "schedulerLastStopKey": "",
            "schedulerActiveRunSnapshot": {
                "startKey": "2026-06-22-start",
                "stopKey": "2026-06-23-stop"
            }
        });
        let state = state.as_object().unwrap();

        assert!(scheduler_trigger_matches_state(
            state,
            "start",
            "2026-06-23-start",
            "2026-06-23-start"
        ));
        assert!(!scheduler_trigger_matches_state(
            state,
            "start",
            "2026-06-22-start",
            "2026-06-22-start"
        ));
        assert!(scheduler_trigger_matches_state(
            state,
            "stop",
            "2026-06-23-stop",
            "2026-06-22-start"
        ));
        assert!(!scheduler_trigger_matches_state(
            state,
            "stop",
            "2026-06-23-stop",
            "2026-06-23-start"
        ));
    }

    #[test]
    fn missed_same_day_stop_is_due_after_the_calendar_day_changes() {
        let snapshot = scheduler_run_snapshot(
            "2026-06-22-start",
            &scheduler_settings("08:00", true, "18:30"),
        );

        assert!(snapshot_stop_is_due(&snapshot, "2026-06-23-stop", 480, ""));
        assert!(!snapshot_stop_is_due(
            &snapshot,
            "2026-06-23-stop",
            480,
            "2026-06-22-stop"
        ));
    }

    #[test]
    fn a_triggered_but_unacknowledged_run_keeps_its_overdue_stop() {
        let snapshot = scheduler_run_snapshot(
            "2026-06-22-start",
            &scheduler_settings("08:00", true, "18:30"),
        );

        assert!(!snapshot_belongs_to_active_scheduler_run(
            &snapshot,
            "2026-06-21-start",
            "",
            ""
        ));
        assert!(snapshot_belongs_to_active_scheduler_run(
            &snapshot,
            "2026-06-21-start",
            "2026-06-22-start",
            ""
        ));
        assert!(active_snapshot_stop_is_due(
            &snapshot,
            "2026-06-23-stop",
            480,
            ""
        ));
    }

    #[test]
    fn a_new_start_waits_for_the_prior_runs_captured_future_stop() {
        let prior_run = scheduler_run_snapshot(
            "2026-06-22-start",
            &scheduler_settings("22:00", true, "06:00"),
        );

        assert!(active_snapshot_stop_is_pending(&prior_run, ""));
        assert!(!active_snapshot_stop_is_due(
            &prior_run,
            "2026-06-23-stop",
            240,
            ""
        ));
        assert_eq!(
            eligible_start_key(
                true,
                false,
                active_snapshot_stop_is_pending(&prior_run, ""),
                "2026-06-23-start"
            ),
            None
        );

        // A 04:00 start under edited 04:00-12:00 settings cannot replace the
        // previous run's 06:00 stop snapshot. Once that stop is acknowledged,
        // the current-day start is eligible at the next scheduler pass.
        assert!(!active_snapshot_stop_is_pending(
            &prior_run,
            "2026-06-23-stop"
        ));
        assert_eq!(
            eligible_start_key(
                true,
                false,
                active_snapshot_stop_is_pending(&prior_run, "2026-06-23-stop"),
                "2026-06-23-start"
            ),
            Some("2026-06-23-start".to_string())
        );
    }

    #[test]
    fn an_active_run_without_a_stop_does_not_block_later_starts() {
        let no_stop_run = scheduler_run_snapshot(
            "2026-06-22-start",
            &scheduler_settings("08:00", false, "18:30"),
        );
        assert!(!active_snapshot_stop_is_pending(&no_stop_run, ""));
        assert_eq!(
            eligible_start_key(
                true,
                false,
                active_snapshot_stop_is_pending(&no_stop_run, ""),
                "2026-06-23-start"
            ),
            Some("2026-06-23-start".to_string())
        );
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

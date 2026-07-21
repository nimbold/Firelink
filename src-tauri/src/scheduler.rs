use chrono::{Datelike, Local, Timelike};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::Emitter;

fn minute_of_day(value: &str) -> Option<u32> {
    let (hour, minute) = value.split_once(':')?;
    let hour = hour.parse::<u32>().ok()?;
    let minute = minute.parse::<u32>().ok()?;
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}

fn stop_is_due(
    stop_time_enabled: bool,
    stop_minute: Option<u32>,
    current_minute: u32,
    last_start_key: &str,
    start_key: &str,
    last_stop_key: &str,
    stop_key: &str,
) -> bool {
    stop_time_enabled
        && stop_minute.is_some_and(|stop| current_minute >= stop)
        && last_start_key == start_key
        && last_stop_key != stop_key
}

fn overnight_stop_is_due(
    stop_time_enabled: bool,
    start_minute: Option<u32>,
    stop_minute: Option<u32>,
    current_minute: u32,
    previous_day_allowed: bool,
    last_start_key: &str,
    previous_start_key: &str,
    last_stop_key: &str,
    stop_key: &str,
) -> bool {
    stop_time_enabled
        && previous_day_allowed
        && start_minute.zip(stop_minute).is_some_and(|(start, stop)| {
            stop < start && current_minute >= stop && current_minute < start
        })
        && last_start_key == previous_start_key
        && last_stop_key != stop_key
}

pub fn spawn_scheduler(
    app_handle: tauri::AppHandle,
    settings_cache: Arc<RwLock<Option<crate::ipc::PersistedSettings>>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        let mut last_emit: HashMap<&'static str, std::time::Instant> = HashMap::new();
        loop {
            interval.tick().await;

            let settings = settings_cache.read().ok().and_then(|settings| {
                settings.as_ref().map(|settings| {
                    (
                        settings.scheduler.clone(),
                        settings.scheduler_last_start_key.clone(),
                        settings.scheduler_last_stop_key.clone(),
                    )
                })
            });
            if let Some((scheduler, scheduler_last_start_key, scheduler_last_stop_key)) = settings {
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
                    let _ = app_handle.emit(
                        "schedule-trigger",
                        serde_json::json!({
                            "action": "start",
                            "key": start_key
                        }),
                    );
                    last_emit.insert("start", std::time::Instant::now());
                }

                let same_day_stop_due = allowed_today
                    && !overnight
                    && stop_is_due(
                        scheduler.stop_time_enabled,
                        stop_minute,
                        current_minute,
                        &scheduler_last_start_key,
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
                let overnight_stop_due = overnight_stop_is_due(
                    scheduler.stop_time_enabled,
                    start_minute,
                    stop_minute,
                    current_minute,
                    previous_day_allowed,
                    &scheduler_last_start_key,
                    &previous_start_key,
                    &scheduler_last_stop_key,
                    &stop_key,
                );

                if (same_day_stop_due || overnight_stop_due)
                    && last_emit
                        .get("stop")
                        .is_none_or(|instant| instant.elapsed() >= Duration::from_secs(5))
                {
                    let _ = app_handle.emit(
                        "schedule-trigger",
                        serde_json::json!({
                            "action": "stop",
                            "key": stop_key
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
    use super::{minute_of_day, overnight_stop_is_due, stop_is_due};

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
        assert_eq!(minute_of_day("bad"), None);
    }

    #[test]
    fn stop_requires_same_day_acknowledged_start() {
        assert!(!stop_is_due(
            true,
            Some(480),
            600,
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
            "2026-06-22-start",
            "",
            "2026-06-22-stop",
        ));
    }

    #[test]
    fn overnight_stop_uses_the_previous_day_start() {
        assert!(overnight_stop_is_due(
            true,
            Some(1320),
            Some(360),
            420,
            true,
            "2026-06-22-start",
            "2026-06-22-start",
            "",
            "2026-06-23-stop",
        ));
        assert!(!overnight_stop_is_due(
            true,
            Some(1320),
            Some(360),
            1380,
            true,
            "2026-06-22-start",
            "2026-06-22-start",
            "",
            "2026-06-22-stop",
        ));
        assert!(!overnight_stop_is_due(
            true,
            Some(1320),
            Some(360),
            420,
            false,
            "2026-06-22-start",
            "2026-06-22-start",
            "",
            "2026-06-23-stop",
        ));
    }
}

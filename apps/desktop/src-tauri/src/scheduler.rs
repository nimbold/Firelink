use tauri::{Manager, Emitter};
use chrono::{Local, Datelike};
use std::time::Duration;
use serde::Deserialize;

#[derive(Deserialize, Debug)]
struct SchedulerSettings {
    enabled: bool,
    #[serde(rename = "startTime")]
    start_time: String,
    #[serde(rename = "stopTimeEnabled")]
    stop_time_enabled: bool,
    #[serde(rename = "stopTime")]
    stop_time: String,
    everyday: bool,
    #[serde(rename = "selectedDays")]
    selected_days: Vec<u32>,
    #[serde(rename = "postQueueAction")]
    post_queue_action: String,
}

pub fn spawn_scheduler(app_handle: tauri::AppHandle) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        loop {
            interval.tick().await;

            let settings_opt = {
                let state = app_handle.state::<crate::db::DbState>();
                let conn = state.conn.lock().unwrap();
                crate::db::get_settings(&conn).unwrap_or(None)
            };

            if let Some(settings_str) = settings_opt {
                if let Ok(mut settings) = serde_json::from_str::<serde_json::Value>(&settings_str) {
                    if let Ok(scheduler) = serde_json::from_value::<SchedulerSettings>(settings.get("scheduler").unwrap_or(&serde_json::json!({})).clone()) {
                        if !scheduler.enabled {
                            continue;
                        }

                        let now = Local::now();
                        let current_time = now.format("%H:%M").to_string();
                        let current_day = now.weekday().num_days_from_sunday();

                        let allowed_today = scheduler.everyday || scheduler.selected_days.contains(&current_day);
                        if !allowed_today {
                            continue;
                        }

                        let date_key = now.format("%Y-%m-%d").to_string();
                        let trigger_key = format!("{}-{}", date_key, current_time);

                        let last_start_key = settings.get("schedulerLastStartKey").and_then(|v| v.as_str()).unwrap_or("");
                        let last_stop_key = settings.get("schedulerLastStopKey").and_then(|v| v.as_str()).unwrap_or("");

                        if scheduler.start_time == current_time && last_start_key != trigger_key {
                            settings["schedulerLastStartKey"] = serde_json::json!(trigger_key.clone());
                            settings["schedulerRunning"] = serde_json::json!(true);
                            
                            let _ = app_handle.emit("schedule-trigger", "start");
                            
                            if let Ok(updated) = serde_json::to_string(&settings) {
                                let state = app_handle.state::<crate::db::DbState>();
                                let conn = state.conn.lock().unwrap();
                                let _ = crate::db::save_settings(&conn, &updated);
                            }
                        }

                        if scheduler.stop_time_enabled && scheduler.stop_time == current_time && last_stop_key != trigger_key {
                            settings["schedulerLastStopKey"] = serde_json::json!(trigger_key.clone());
                            settings["schedulerRunning"] = serde_json::json!(false);
                            
                            let _ = app_handle.emit("schedule-trigger", "stop");

                            if let Ok(updated) = serde_json::to_string(&settings) {
                                let state = app_handle.state::<crate::db::DbState>();
                                let conn = state.conn.lock().unwrap();
                                let _ = crate::db::save_settings(&conn, &updated);
                            }
                        }
                    }
                }
            }
        }
    });
}

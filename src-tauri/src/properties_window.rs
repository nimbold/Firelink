use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

const MAIN_WINDOW_LABEL: &str = "main";
const PROPERTIES_LABEL_PREFIX: &str = "properties-";
const PROPERTIES_WINDOW_TITLE: &str = "Properties - Firelink";
const PROPERTIES_WINDOW_READY_EVENT: &str = "properties-window-ready";
const PROPERTIES_WINDOW_ACTION_REQUEST_EVENT: &str = "properties-window-action-request";
const MAX_PROPERTIES_ACTION_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_PROPERTIES_SESSION_ID_BYTES: usize = 128;
const MAX_PROPERTIES_REQUEST_ID: u64 = 9_007_199_254_740_991;

#[derive(Default)]
pub struct PropertiesWindowRegistry {
    state: Mutex<RegistryState>,
}

#[derive(Default)]
struct RegistryState {
    by_download: HashMap<String, String>,
    by_window: HashMap<String, String>,
    ready_windows: HashSet<String>,
    sessions_by_window: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PropertiesWindowReadyEvent {
    window_label: String,
    download_id: String,
    session_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PropertiesWindowActionEvent {
    window_label: String,
    download_id: String,
    session_id: String,
    request_id: u64,
    action: String,
    payload: Option<serde_json::Value>,
}

impl PropertiesWindowRegistry {
    pub fn allocate(&self, download_id: &str) -> Result<String, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Properties window registry is unavailable".to_string())?;
        if let Some(label) = state.by_download.get(download_id) {
            return Ok(label.clone());
        }

        let label = format!("{PROPERTIES_LABEL_PREFIX}{}", Uuid::new_v4().simple());
        state.by_download.insert(download_id.to_string(), label.clone());
        state.by_window.insert(label.clone(), download_id.to_string());
        Ok(label)
    }

    pub fn download_for_window(&self, label: &str) -> Result<Option<String>, String> {
        Ok(self
            .state
            .lock()
            .map_err(|_| "Properties window registry is unavailable".to_string())?
            .by_window
            .get(label)
            .cloned())
    }

    pub fn remove_window(&self, label: &str) -> Result<Option<String>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Properties window registry is unavailable".to_string())?;
        let download_id = state.by_window.remove(label);
        state.ready_windows.remove(label);
        state.sessions_by_window.remove(label);
        if let Some(download_id) = &download_id {
            state.by_download.remove(download_id);
        }
        Ok(download_id)
    }

    pub fn remove_download(&self, download_id: &str) -> Result<Option<String>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Properties window registry is unavailable".to_string())?;
        let label = state.by_download.remove(download_id);
        if let Some(label) = &label {
            state.by_window.remove(label);
            state.ready_windows.remove(label);
            state.sessions_by_window.remove(label);
        }
        Ok(label)
    }

    pub fn window_for_download(&self, download_id: &str) -> Result<Option<String>, String> {
        Ok(self
            .state
            .lock()
            .map_err(|_| "Properties window registry is unavailable".to_string())?
            .by_download
            .get(download_id)
            .cloned())
    }

    pub fn mark_ready(&self, label: &str) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Properties window registry is unavailable".to_string())?;
        if !state.by_window.contains_key(label) {
            return Err("Properties window is no longer registered".to_string());
        }
        state.ready_windows.insert(label.to_string());
        Ok(())
    }

    pub fn register_session(&self, label: &str, session_id: &str) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Properties window registry is unavailable".to_string())?;
        if !state.by_window.contains_key(label) {
            return Err("Properties window is no longer registered".to_string());
        }
        state
            .sessions_by_window
            .insert(label.to_string(), session_id.to_string());
        Ok(())
    }

    pub fn session_for_window(&self, label: &str) -> Result<Option<String>, String> {
        Ok(self
            .state
            .lock()
            .map_err(|_| "Properties window registry is unavailable".to_string())?
            .sessions_by_window
            .get(label)
            .cloned())
    }

    pub fn session_matches(&self, label: &str, session_id: &str) -> Result<bool, String> {
        Ok(self.session_for_window(label)?.as_deref() == Some(session_id))
    }

    pub fn is_ready(&self, label: &str) -> Result<bool, String> {
        Ok(self
            .state
            .lock()
            .map_err(|_| "Properties window registry is unavailable".to_string())?
            .ready_windows
            .contains(label))
    }

    pub fn clear_ready(&self, label: &str) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "Properties window registry is unavailable".to_string())?
            .ready_windows
            .remove(label);
        Ok(())
    }
}

pub fn is_properties_window_label(label: &str) -> bool {
    label.starts_with(PROPERTIES_LABEL_PREFIX)
        && label.len() > PROPERTIES_LABEL_PREFIX.len()
        && label[PROPERTIES_LABEL_PREFIX.len()..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

/// Custom Tauri commands are not automatically narrowed by a capability's
/// window list. Commands that a Properties child may call must therefore
/// validate the invoking webview and its registered download explicitly.
pub fn ensure_properties_or_main(
    caller: &tauri::WebviewWindow,
    registry: &PropertiesWindowRegistry,
    download_id: &str,
) -> Result<(), String> {
    if caller.label() == MAIN_WINDOW_LABEL {
        return Ok(());
    }
    if !is_properties_window_label(caller.label())
        || registry.download_for_window(caller.label())?.as_deref() != Some(download_id)
    {
        return Err("This window is not authorized for the requested download".to_string());
    }
    Ok(())
}

pub fn ensure_main_window(caller: &tauri::WebviewWindow) -> Result<(), String> {
    (caller.label() == MAIN_WINDOW_LABEL)
        .then_some(())
        .ok_or_else(|| "This command is available only to the main window".to_string())
}

fn registered_download_for_caller(
    caller: &tauri::WebviewWindow,
    registry: &PropertiesWindowRegistry,
) -> Result<String, String> {
    let label = caller.label();
    if !is_properties_window_label(label) {
        return Err("This window is not a Properties window".to_string());
    }
    registry
        .download_for_window(label)?
        .ok_or_else(|| "Properties window is no longer registered".to_string())
}

fn is_properties_action(action: &str) -> bool {
    matches!(
        action,
        "apply-properties"
            | "pause-resume"
            | "verify-torrent"
            | "set-download-limit"
            | "set-torrent-upload-limit"
            | "set-torrent-peer-options"
    )
}

fn download_exists(db: &crate::db::DbState, download_id: &str) -> Result<bool, String> {
    let connection = db.lock()?;
    Ok(crate::db::load_downloads(&connection)?.into_iter().any(|record| {
        serde_json::from_str::<serde_json::Value>(&record)
            .ok()
            .and_then(|value| value.get("id").and_then(serde_json::Value::as_str).map(str::to_owned))
            .is_some_and(|id| id == download_id)
    }))
}

fn validate_download_id(download_id: &str) -> Result<(), String> {
    let trimmed = download_id.trim();
    if trimmed.is_empty() || trimmed.len() > 256 || trimmed.chars().any(char::is_control) {
        return Err("Invalid download ID".to_string());
    }
    Ok(())
}

fn validate_properties_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.len() > MAX_PROPERTIES_SESSION_ID_BYTES
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid Properties window session".to_string());
    }
    Ok(())
}

fn validate_properties_request_id(request_id: u64) -> Result<(), String> {
    if request_id == 0 || request_id > MAX_PROPERTIES_REQUEST_ID {
        return Err("Invalid Properties action request ID".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn open_download_properties_window(
    app: tauri::AppHandle,
    caller: tauri::WebviewWindow,
    db: tauri::State<'_, crate::db::DbState>,
    registry: tauri::State<'_, PropertiesWindowRegistry>,
    id: String,
) -> Result<String, String> {
    if caller.label() != MAIN_WINDOW_LABEL {
        return Err("Only the main window can open Properties windows".to_string());
    }
    validate_download_id(&id)?;
    if !download_exists(&db, &id)? {
        return Err("Download no longer exists".to_string());
    }

    let label = registry.allocate(&id)?;
    if let Some(window) = app.get_webview_window(&label) {
        if !registry.is_ready(&label)? {
            return Ok(label);
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(label);
    }

    // If the native window disappeared without delivering Destroyed, discard
    // the old readiness bit before constructing a fresh hidden webview.
    registry.clear_ready(&label)?;
    let build_result = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(PROPERTIES_WINDOW_TITLE)
        .inner_size(1000.0, 720.0)
        .min_inner_size(760.0, 560.0)
        .resizable(true)
        .always_on_top(false)
        .visible(false)
        .build();
    if let Err(error) = build_result {
        // Two rapid main-window requests can race between the native lookup
        // above and builder creation. If the first request won, retain the
        // registry entry and focus its window instead of treating the second
        // request as a failed open.
        if let Some(window) = app.get_webview_window(&label) {
            if registry.is_ready(&label)? {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            return Ok(label);
        }
        let _ = registry.remove_window(&label);
        return Err(format!("Could not open Properties window: {error}"));
    }

    Ok(label)
}

#[tauri::command]
pub fn get_properties_window_download_id(
    caller: tauri::WebviewWindow,
    registry: tauri::State<'_, PropertiesWindowRegistry>,
) -> Result<String, String> {
    registered_download_for_caller(&caller, &registry)
}

#[tauri::command]
pub fn properties_window_send_ready(
    caller: tauri::WebviewWindow,
    app: tauri::AppHandle,
    registry: tauri::State<'_, PropertiesWindowRegistry>,
    session_id: String,
) -> Result<(), String> {
    validate_properties_session_id(&session_id)?;
    let download_id = registered_download_for_caller(&caller, &registry)?;
    registry.register_session(caller.label(), &session_id)?;
    app.emit_to(
        MAIN_WINDOW_LABEL,
        PROPERTIES_WINDOW_READY_EVENT,
        PropertiesWindowReadyEvent {
            window_label: caller.label().to_string(),
            download_id,
            session_id,
        },
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn properties_window_reveal(
    caller: tauri::WebviewWindow,
    registry: tauri::State<'_, PropertiesWindowRegistry>,
) -> Result<(), String> {
    registered_download_for_caller(&caller, &registry)?;
    registry.mark_ready(caller.label())?;
    caller.show().map_err(|error| error.to_string())?;
    caller.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn properties_window_send_action(
    caller: tauri::WebviewWindow,
    app: tauri::AppHandle,
    registry: tauri::State<'_, PropertiesWindowRegistry>,
    session_id: String,
    request_id: u64,
    action: String,
    payload: Option<serde_json::Value>,
) -> Result<(), String> {
    validate_properties_session_id(&session_id)?;
    validate_properties_request_id(request_id)?;
    if !is_properties_action(&action)
        || action.len() > 64
        || action.chars().any(char::is_control)
    {
        return Err("Invalid Properties action".to_string());
    }
    if let Some(payload) = payload.as_ref() {
        let payload_size = serde_json::to_vec(payload)
            .map_err(|_| "Invalid Properties action payload".to_string())?
            .len();
        if payload_size > MAX_PROPERTIES_ACTION_PAYLOAD_BYTES {
            return Err("Properties action payload is too large".to_string());
        }
    }
    let download_id = registered_download_for_caller(&caller, &registry)?;
    if !registry.session_matches(caller.label(), &session_id)? {
        return Err("Properties window session is no longer current".to_string());
    }
    app.emit_to(
        MAIN_WINDOW_LABEL,
        PROPERTIES_WINDOW_ACTION_REQUEST_EVENT,
        PropertiesWindowActionEvent {
            window_label: caller.label().to_string(),
            download_id,
            session_id,
            request_id,
            action,
            payload,
        },
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn validate_properties_window_request(
    caller: tauri::WebviewWindow,
    registry: tauri::State<'_, PropertiesWindowRegistry>,
    window_label: String,
    download_id: String,
    session_id: String,
    request_id: Option<u64>,
) -> Result<(), String> {
    if caller.label() != MAIN_WINDOW_LABEL {
        return Err("Only the main window can validate Properties requests".to_string());
    }
    validate_download_id(&download_id)?;
    validate_properties_session_id(&session_id)?;
    if let Some(request_id) = request_id {
        validate_properties_request_id(request_id)?;
    }
    if !is_properties_window_label(&window_label) {
        return Err("Invalid Properties window label".to_string());
    }
    if registry.download_for_window(&window_label)?.as_deref() != Some(download_id.as_str()) {
        return Err("Properties window request does not match its registered download".to_string());
    }
    if !registry.session_matches(&window_label, &session_id)? {
        return Err("Properties window session is no longer current".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn close_download_properties_window(
    caller: tauri::WebviewWindow,
    app: tauri::AppHandle,
    registry: tauri::State<'_, PropertiesWindowRegistry>,
    id: String,
) -> Result<(), String> {
    let label = caller.label();
    let registered_id = if label == MAIN_WINDOW_LABEL {
        registry.window_for_download(&id)?.map(|_| id.clone())
    } else {
        registry.download_for_window(label)?
    };
    if registered_id.as_deref() != Some(id.as_str()) {
        return Err("Properties window close request is not registered".to_string());
    }
    if let Some(label) = registry.window_for_download(&id)? {
        if let Some(window) = app.get_webview_window(&label) {
            window.close().map_err(|error| error.to_string())?;
        }
    }
    let _ = registry.remove_download(&id);
    Ok(())
}

#[tauri::command]
pub fn properties_window_registry_remove_for_download(
    caller: tauri::WebviewWindow,
    app: tauri::AppHandle,
    registry: tauri::State<'_, PropertiesWindowRegistry>,
    id: String,
) -> Result<(), String> {
    if caller.label() != MAIN_WINDOW_LABEL {
        return Err("Only the main window can remove a Properties window".to_string());
    }
    if let Some(label) = registry.remove_download(&id)? {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_opaque_and_strictly_scoped() {
        assert!(is_properties_window_label("properties-0123456789abcdef"));
        assert!(!is_properties_window_label("properties-download-id"));
        assert!(!is_properties_window_label("main"));
        assert!(!is_properties_window_label("properties-"));
    }

    #[test]
    fn registry_reuses_one_label_per_download_and_cleans_both_indexes() {
        let registry = PropertiesWindowRegistry::default();
        let first = registry.allocate("download-a").unwrap();
        assert!(!registry.is_ready(&first).unwrap());
        registry.mark_ready(&first).unwrap();
        assert!(registry.is_ready(&first).unwrap());
        registry.clear_ready(&first).unwrap();
        assert!(!registry.is_ready(&first).unwrap());
        registry.mark_ready(&first).unwrap();
        assert_eq!(registry.allocate("download-a").unwrap(), first);
        assert_eq!(registry.download_for_window(&first).unwrap(), Some("download-a".to_string()));
        assert_eq!(registry.remove_window(&first).unwrap(), Some("download-a".to_string()));
        assert_eq!(registry.download_for_window(&first).unwrap(), None);
        assert!(!registry.is_ready(&first).unwrap());
        assert_ne!(registry.allocate("download-a").unwrap(), first);
    }

    #[test]
    fn invalid_ids_are_rejected() {
        assert!(validate_download_id("").is_err());
        assert!(validate_download_id("\n").is_err());
        assert!(validate_download_id("valid-id").is_ok());
        assert!(validate_properties_session_id("session-1").is_ok());
        assert!(validate_properties_session_id("").is_err());
        assert!(validate_properties_session_id("bad session").is_err());
        assert!(validate_properties_request_id(1).is_ok());
        assert!(validate_properties_request_id(0).is_err());
    }

    #[test]
    fn registering_a_new_session_invalidates_the_previous_session() {
        let registry = PropertiesWindowRegistry::default();
        let label = registry.allocate("download-a").unwrap();

        registry.register_session(&label, "session-old").unwrap();
        assert!(registry.session_matches(&label, "session-old").unwrap());

        registry.register_session(&label, "session-new").unwrap();
        assert!(!registry.session_matches(&label, "session-old").unwrap());
        assert!(registry.session_matches(&label, "session-new").unwrap());

        registry.remove_window(&label).unwrap();
        assert!(!registry.session_matches(&label, "session-new").unwrap());
    }

    #[test]
    fn child_actions_are_allowlisted() {
        assert!(is_properties_action("apply-properties"));
        assert!(is_properties_action("verify-torrent"));
        assert!(is_properties_action("set-torrent-peer-options"));
        assert!(!is_properties_action("get_keychain_password"));
        assert!(!is_properties_action(""));
    }
}

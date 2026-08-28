use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

const MAIN_WINDOW_LABEL: &str = "main";
const PROPERTIES_LABEL_PREFIX: &str = "properties-";
const PROPERTIES_WINDOW_TITLE: &str = "Properties - Firelink";
const PROPERTIES_DEFAULT_WIDTH: f64 = 960.0;
const PROPERTIES_DEFAULT_HEIGHT: f64 = 640.0;
const PROPERTIES_MIN_WIDTH: f64 = 680.0;
const PROPERTIES_MIN_HEIGHT: f64 = 500.0;
const PROPERTIES_WINDOW_READY_EVENT: &str = "properties-window-ready";
const PROPERTIES_WINDOW_ACTION_REQUEST_EVENT: &str = "properties-window-action-request";
const MAX_PROPERTIES_ACTION_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_PROPERTIES_SESSION_ID_BYTES: usize = 128;
const MAX_PROPERTIES_REQUEST_ID: u64 = 9_007_199_254_740_991;
const MAX_RETIRED_PROPERTIES_SESSIONS: usize = 256;
const PROPERTIES_SESSION_HISTORY_EXHAUSTED: &str =
    "Properties window session history is exhausted; close and reopen the window";

#[derive(Default)]
pub struct PropertiesWindowRegistry {
    state: Mutex<RegistryState>,
    window_creation: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct RegistryState {
    by_download: HashMap<String, String>,
    by_window: HashMap<String, String>,
    ready_windows: HashSet<String>,
    sessions_by_window: HashMap<String, String>,
    retired_sessions_by_window: HashMap<String, HashSet<String>>,
    remembered_size: Option<PropertiesWindowSize>,
}

#[derive(Clone, Copy)]
struct PropertiesWindowSize {
    width: f64,
    height: f64,
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
    async fn lock_window_creation(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.window_creation.lock().await
    }

    pub(crate) fn remember_size(
        &self,
        window_label: &str,
        physical_width: u32,
        physical_height: u32,
        scale_factor: f64,
    ) -> Result<(), String> {
        if !scale_factor.is_finite() || scale_factor <= 0.0 {
            return Ok(());
        }

        let width = (f64::from(physical_width) / scale_factor).round();
        let height = (f64::from(physical_height) / scale_factor).round();
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return Ok(());
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| "Properties window registry is unavailable".to_string())?;
        if !state.by_window.contains_key(window_label) {
            return Ok(());
        }

        state.remembered_size = Some(PropertiesWindowSize {
            width: width.max(PROPERTIES_MIN_WIDTH),
            height: height.max(PROPERTIES_MIN_HEIGHT),
        });
        Ok(())
    }

    fn remembered_size(&self) -> Result<Option<(f64, f64)>, String> {
        Ok(self
            .state
            .lock()
            .map_err(|_| "Properties window registry is unavailable".to_string())?
            .remembered_size
            .map(|size| (size.width, size.height)))
    }

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
        state.retired_sessions_by_window.remove(label);
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
            state.retired_sessions_by_window.remove(label);
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
        if state
            .sessions_by_window
            .get(label)
            .is_some_and(|current| current == session_id)
        {
            return Ok(());
        }
        if state
            .retired_sessions_by_window
            .get(label)
            .is_some_and(|retired| retired.contains(session_id))
        {
            return Err("Properties window session is no longer current".to_string());
        }
        if state.sessions_by_window.contains_key(label)
            && state
                .retired_sessions_by_window
                .get(label)
                .is_some_and(|retired| retired.len() >= MAX_RETIRED_PROPERTIES_SESSIONS)
        {
            return Err(PROPERTIES_SESSION_HISTORY_EXHAUSTED.to_string());
        }
        if let Some(previous) = state
            .sessions_by_window
            .insert(label.to_string(), session_id.to_string())
        {
            state
                .retired_sessions_by_window
                .entry(label.to_string())
                .or_default()
                .insert(previous);
        }
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

    /// Validate a session and perform a short synchronous mutation while the
    /// registry lock is held. Callers use this for cancellation flags so a
    /// stale session cannot pass validation and then race a replacement
    /// session before its mutation is recorded.
    pub fn with_current_session<T>(
        &self,
        label: &str,
        session_id: &str,
        mutation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Properties window registry is unavailable".to_string())?;
        if state.sessions_by_window.get(label).map(String::as_str) != Some(session_id) {
            return Err("Properties window session is no longer current".to_string());
        }
        mutation()
    }

    #[cfg(test)]
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

fn emit_to_main<T: Serialize + Clone>(
    app: &tauri::AppHandle,
    event: &str,
    payload: T,
) -> Result<(), String> {
    use tauri::Emitter;

    if app.get_webview_window(MAIN_WINDOW_LABEL).is_none() {
        return Err("Firelink main window is unavailable".to_string());
    }

    app.emit_to(
        tauri::EventTarget::webview_window(MAIN_WINDOW_LABEL),
        event,
        payload,
    )
    .map_err(|error| error.to_string())
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
            | "set-torrent-file-selection"
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
pub async fn open_download_properties_window(
    app: tauri::AppHandle,
    caller: tauri::WebviewWindow,
    db: tauri::State<'_, crate::db::DbState>,
    registry: tauri::State<'_, PropertiesWindowRegistry>,
    id: String,
) -> Result<String, String> {
    // WebviewWindowBuilder::build can deadlock on Windows when it runs in a
    // synchronous command or event handler because WebView2 initialization
    // needs the native event loop to keep pumping. This command is async so
    // Tauri executes the blocking construction away from the renderer/native
    // command callback that initiated it.
    if caller.label() != MAIN_WINDOW_LABEL {
        return Err("Only the main window can open Properties windows".to_string());
    }
    validate_download_id(&id)?;
    if !download_exists(&db, &id)? {
        return Err("Download no longer exists".to_string());
    }

    // Async command invocations can overlap before Tauri registers a newly
    // created native window. Serialize the lookup/build/cleanup transaction
    // so a duplicate request cannot remove the registry entry of the request
    // that successfully created the window.
    let _window_creation_guard = registry.lock_window_creation().await;
    let label = registry.allocate(&id)?;
    if let Some(window) = app.get_webview_window(&label) {
        // Visibility belongs to the native window owner, not to the renderer
        // handshake. A delayed or lost snapshot must leave a usable loading
        // window on screen instead of making the open request appear to do
        // nothing.
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(label);
    }

    // If the native window disappeared without delivering Destroyed, discard
    // the old readiness bit before constructing a fresh hidden webview.
    registry.clear_ready(&label)?;
    let (initial_width, initial_height) = registry
        .remembered_size()?
        .unwrap_or((PROPERTIES_DEFAULT_WIDTH, PROPERTIES_DEFAULT_HEIGHT));
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(PROPERTIES_WINDOW_TITLE)
        .inner_size(initial_width, initial_height)
        .min_inner_size(PROPERTIES_MIN_WIDTH, PROPERTIES_MIN_HEIGHT)
        .resizable(true)
        .always_on_top(false)
        // Let the child renderer paint its rounded loading shell before the
        // native window becomes visible. Showing an opaque native surface
        // here exposes the webview's unpainted white background.
        .visible(false)
        // A hidden WebView2 must not request focus during construction. The
        // native reveal path focuses it after the window is visible.
        .focused(false)
        .transparent(true)
        // The rounded surface is painted by the child renderer. Tao enables
        // its undecorated Windows shadow by default, which leaves an opaque
        // native frame outside that renderer surface at the corners.
        .shadow(false);
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    let builder = builder.decorations(false);
    let build_result = builder.build();
    if let Err(error) = build_result {
        // The native builder can report an error after registering a window.
        // Prefer that registered native owner over discarding its registry
        // entry and leaving the child inaccessible.
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
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
    if let Err(error) = registry.register_session(caller.label(), &session_id) {
        if error == PROPERTIES_SESSION_HISTORY_EXHAUSTED {
            let _ = registry.remove_window(caller.label());
            let _ = caller.close();
        }
        return Err(error);
    }
    emit_to_main(
        &app,
        PROPERTIES_WINDOW_READY_EVENT,
        PropertiesWindowReadyEvent {
            window_label: caller.label().to_string(),
            download_id,
            session_id,
        },
    )
}

#[tauri::command]
pub fn properties_window_reveal(
    caller: tauri::WebviewWindow,
    registry: tauri::State<'_, PropertiesWindowRegistry>,
    session_id: Option<String>,
) -> Result<(), String> {
    registered_download_for_caller(&caller, &registry)?;
    if caller.label() != MAIN_WINDOW_LABEL {
        let session_id = session_id.ok_or_else(|| "Properties window session is required".to_string())?;
        validate_properties_session_id(&session_id)?;
        if !registry.session_matches(caller.label(), &session_id)? {
            return Err("Properties window session is no longer current".to_string());
        }
    }
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
    emit_to_main(
        &app,
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
pub async fn close_download_properties_window(
    caller: tauri::WebviewWindow,
    app: tauri::AppHandle,
    registry: tauri::State<'_, PropertiesWindowRegistry>,
    id: String,
) -> Result<(), String> {
    let _window_creation_guard = registry.lock_window_creation().await;
    let label = caller.label();
    let registered_id = if label == MAIN_WINDOW_LABEL {
        registry.window_for_download(&id)?.map(|_| id.clone())
    } else {
        registry.download_for_window(label)?
    };
    if registered_id.as_deref() != Some(id.as_str()) {
        return Err("Properties window close request is not registered".to_string());
    }
    if let Some(window_label) = registry.window_for_download(&id)? {
        if let Some(window) = app.get_webview_window(&window_label) {
            window.close().map_err(|error| error.to_string())?;
        } else {
            // A native window can disappear without delivering its Destroyed
            // event. Only clear this stale registry entry when there is no
            // window left to receive a close-request veto from the child.
            let _ = registry.remove_download(&id);
        }
    } else {
        let _ = registry.remove_download(&id);
    }
    Ok(())
}

#[tauri::command]
pub async fn properties_window_registry_remove_for_download(
    caller: tauri::WebviewWindow,
    app: tauri::AppHandle,
    registry: tauri::State<'_, PropertiesWindowRegistry>,
    id: String,
) -> Result<(), String> {
    if caller.label() != MAIN_WINDOW_LABEL {
        return Err("Only the main window can remove a Properties window".to_string());
    }
    let _window_creation_guard = registry.lock_window_creation().await;
    if let Some(label) = registry.remove_download(&id)? {
        if let Some(window) = app.get_webview_window(&label) {
            // This command is used after the download has already been
            // removed. It is a forced lifecycle teardown, so a dirty-draft
            // close-request handler must not be able to leave an orphaned
            // Properties window behind.
            let _ = window.destroy();
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

    #[tokio::test]
    async fn window_creation_lock_is_exclusive() {
        let registry = PropertiesWindowRegistry::default();
        let guard = registry.lock_window_creation().await;

        assert!(registry.window_creation.try_lock().is_err());

        drop(guard);
        assert!(registry.window_creation.try_lock().is_ok());
    }

    #[test]
    fn remembered_size_uses_logical_units_and_survives_window_cleanup() {
        let registry = PropertiesWindowRegistry::default();
        let label = registry.allocate("download-a").unwrap();

        registry.remember_size(&label, 1920, 1280, 2.0).unwrap();
        assert_eq!(registry.remembered_size().unwrap(), Some((960.0, 640.0)));

        registry.remove_window(&label).unwrap();
        assert_eq!(registry.remembered_size().unwrap(), Some((960.0, 640.0)));
    }

    #[test]
    fn remembered_size_clamps_below_minimum_and_ignores_invalid_scale() {
        let registry = PropertiesWindowRegistry::default();

        let label = registry.allocate("download-a").unwrap();
        registry.remember_size(&label, 1, 1, 1.0).unwrap();
        assert_eq!(
            registry.remembered_size().unwrap(),
            Some((PROPERTIES_MIN_WIDTH, PROPERTIES_MIN_HEIGHT))
        );

        registry.remember_size(&label, 2000, 1600, 0.0).unwrap();
        assert_eq!(
            registry.remembered_size().unwrap(),
            Some((PROPERTIES_MIN_WIDTH, PROPERTIES_MIN_HEIGHT))
        );
    }

    #[test]
    fn late_resize_from_unregistered_window_cannot_overwrite_session_size() {
        let registry = PropertiesWindowRegistry::default();
        let label = registry.allocate("download-a").unwrap();

        registry.remember_size(&label, 1920, 1280, 2.0).unwrap();
        registry.remove_window(&label).unwrap();
        registry
            .remember_size(&label, 2560, 1600, 2.0)
            .unwrap();

        assert_eq!(registry.remembered_size().unwrap(), Some((960.0, 640.0)));
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
    fn a_late_ready_from_a_retired_session_cannot_reclaim_the_window() {
        let registry = PropertiesWindowRegistry::default();
        let label = registry.allocate("download-a").unwrap();

        registry.register_session(&label, "session-old").unwrap();
        assert!(registry.session_matches(&label, "session-old").unwrap());

        registry.register_session(&label, "session-new").unwrap();
        assert!(!registry.session_matches(&label, "session-old").unwrap());
        assert!(registry.session_matches(&label, "session-new").unwrap());
        assert!(registry.register_session(&label, "session-old").is_err());
        assert!(registry.session_matches(&label, "session-new").unwrap());

        for index in 0..(MAX_RETIRED_PROPERTIES_SESSIONS - 1) {
            registry
                .register_session(&label, &format!("session-{index}"))
                .unwrap();
        }
        assert!(registry.register_session(&label, "session-after-limit").is_err());

        registry.remove_window(&label).unwrap();
        assert!(!registry.session_matches(&label, "session-new").unwrap());
    }

    #[test]
    fn current_session_mutation_is_fenced_from_retired_sessions() {
        let registry = PropertiesWindowRegistry::default();
        let label = registry.allocate("download-a").unwrap();
        registry.register_session(&label, "session-old").unwrap();

        let mut mutations = 0;
        let stale = registry.with_current_session(&label, "session-old", || {
            mutations += 1;
            Ok(())
        });
        assert!(stale.is_ok());

        registry.register_session(&label, "session-new").unwrap();
        let rejected = registry.with_current_session(&label, "session-old", || {
            mutations += 1;
            Ok(())
        });
        assert!(rejected.is_err());
        assert_eq!(mutations, 1);
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

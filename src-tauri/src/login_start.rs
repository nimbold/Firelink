use serde::Serialize;
use std::ffi::OsStr;
use ts_rs::TS;

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::Once;

pub const AUTOSTART_ARGUMENT: &str = "--firelink-autostart";

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LoginStartStatus {
    pub supported: bool,
    pub enabled: bool,
    pub requires_approval: bool,
}

pub fn has_autostart_argument<I, S>(arguments: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    arguments
        .into_iter()
        .any(|argument| argument.as_ref() == OsStr::new(AUTOSTART_ARGUMENT))
}

pub fn is_login_launch<I, S>(arguments: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    has_autostart_argument(arguments) || macos_login_item_launch()
}

#[cfg(target_os = "macos")]
fn macos_login_item_launch() -> bool {
    macos_login_event::was_login_launch()
}

#[cfg(not(target_os = "macos"))]
fn macos_login_item_launch() -> bool {
    false
}

/// Install the macOS login-launch detector before AppKit starts dispatching its
/// initial `kAEOpenApplication` event. SMAppService's MainApp service launches
/// without command-line arguments, so the Apple Event is the only reliable
/// distinction between a login launch and a user opening Firelink normally.
#[cfg(target_os = "macos")]
pub fn install_macos_login_launch_detector() {
    macos_login_event::install();
}

#[cfg(not(target_os = "macos"))]
pub fn install_macos_login_launch_detector() {}

#[cfg(target_os = "macos")]
mod macos_login_event {
    use super::{AtomicBool, Once, Ordering};
    use objc2::rc::{Allocated, Retained};
    use objc2::{define_class, msg_send, sel, ClassType, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSApplicationWillFinishLaunchingNotification};
    use objc2_core_services::{AEEventClass, AEEventID, AEKeyword};
    use objc2_foundation::{
        NSAppleEventDescriptor, NSAppleEventManager, NSNotification, NSNotificationCenter,
        NSObject, NSObjectProtocol,
    };
    use std::sync::OnceLock;

    // Core Event / Open Application / property-data / login-item marker.
    const K_CORE_EVENT_CLASS: AEEventClass = u32::from_be_bytes(*b"aevt");
    const K_AE_OPEN_APPLICATION: AEEventID = u32::from_be_bytes(*b"oapp");
    const KEY_AE_PROP_DATA: AEKeyword = u32::from_be_bytes(*b"prdt");
    const KEY_AE_LAUNCHED_AS_LOGIN_ITEM: u32 = u32::from_be_bytes(*b"lgit");
    const TYPE_TYPE: u32 = u32::from_be_bytes(*b"type");

    static INSTALL: Once = Once::new();
    static OBSERVER: OnceLock<Retained<LoginLaunchObserver>> = OnceLock::new();
    static LOGIN_LAUNCH: AtomicBool = AtomicBool::new(false);
    static DECIDED: AtomicBool = AtomicBool::new(false);

    define_class!(
        // SAFETY:
        // - NSObject has no subclassing requirements.
        // - The observer has no Rust destructor or thread-confined state.
        #[unsafe(super(NSObject))]
        #[name = "FirelinkLoginLaunchObserver"]
        #[ivars = ()]
        struct LoginLaunchObserver;

        impl LoginLaunchObserver {
            #[unsafe(method_id(init))]
            fn init(this: Allocated<Self>) -> Retained<Self> {
                let this = this.set_ivars(());
                unsafe { msg_send![super(this), init] }
            }

            #[unsafe(method(applicationWillFinishLaunching:))]
            fn application_will_finish_launching(&self, _notification: &NSNotification) {
                let manager = NSAppleEventManager::sharedAppleEventManager();
                // SAFETY: The selector is implemented below with the matching
                // Apple Event handler signature, and `self` is this observer.
                unsafe {
                    manager.setEventHandler_andSelector_forEventClass_andEventID(
                        self,
                        sel!(handleAppleEvent:withReplyEvent:),
                        K_CORE_EVENT_CLASS,
                        K_AE_OPEN_APPLICATION,
                    );
                }
            }

            #[unsafe(method(handleAppleEvent:withReplyEvent:))]
            fn handle_apple_event(
                &self,
                event: Option<&NSAppleEventDescriptor>,
                _reply_event: Option<&NSAppleEventDescriptor>,
            ) {
                let is_login_launch = event
                    .and_then(|event| event.paramDescriptorForKeyword(KEY_AE_PROP_DATA))
                    .is_some_and(|property_data| {
                        property_data.descriptorType() == TYPE_TYPE
                            && property_data.typeCodeValue() == KEY_AE_LAUNCHED_AS_LOGIN_ITEM
                    });

                if DECIDED
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
                {
                    LOGIN_LAUNCH.store(is_login_launch, Ordering::Release);
                }
            }
        }

        unsafe impl NSObjectProtocol for LoginLaunchObserver {}
    );

    pub fn install() {
        INSTALL.call_once(|| {
            let Some(main_thread) = MainThreadMarker::new() else {
                log::error!("could not install macOS login-launch observer off the main thread");
                return;
            };

            let application = NSApplication::sharedApplication(main_thread);
            let observer: Retained<LoginLaunchObserver> =
                unsafe { msg_send![LoginLaunchObserver::class(), new] };
            if OBSERVER.set(observer).is_err() {
                log::error!("could not retain macOS login-launch observer");
                return;
            }

            let Some(observer) = OBSERVER.get() else {
                log::error!("macOS login-launch observer was not retained");
                return;
            };
            let notification_center = NSNotificationCenter::defaultCenter();
            // NotificationCenter does not own selector-based observers. Keep
            // the observer retained in OBSERVER for the process lifetime.
            // SAFETY: The selector is implemented by LoginLaunchObserver and
            // the notification name and object are the matching AppKit values.
            unsafe {
                notification_center.addObserver_selector_name_object(
                    observer,
                    sel!(applicationWillFinishLaunching:),
                    Some(NSApplicationWillFinishLaunchingNotification),
                    Some(&application),
                );
            }
        });
    }

    pub fn was_login_launch() -> bool {
        LOGIN_LAUNCH.load(Ordering::Acquire)
    }
}

fn current_executable_path() -> Result<String, String> {
    let path = std::env::current_exe()
        .map_err(|error| format!("could not resolve Firelink executable: {error}"))?;
    if !path.is_absolute() {
        return Err("Firelink executable path is not absolute".to_string());
    }
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "Firelink executable path is not valid UTF-8".to_string())
}

#[cfg(target_os = "linux")]
fn linux_executable_path() -> Result<String, String> {
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        let path = std::path::PathBuf::from(appimage);
        if path.is_absolute() && path.is_file() {
            return path
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| "AppImage path is not valid UTF-8".to_string());
        }
        log::warn!(
            "Ignoring invalid APPIMAGE path for login startup: {}",
            path.display()
        );
    }

    current_executable_path()
}

#[cfg(target_os = "windows")]
fn launch_path(path: String) -> String {
    // auto-launch writes the Windows Run value as `<path> <args>`. Quote the
    // executable ourselves so the installed path may contain spaces.
    format!("\"{}\"", path.replace('"', "\\\""))
}

#[cfg(any(target_os = "linux", test))]
fn encode_linux_exec_argument(path: &str) -> Result<String, String> {
    if path.chars().any(char::is_control) {
        return Err(
            "Linux executable path contains an unsupported control character".to_string(),
        );
    }

    // First encode the argument according to the Exec quoting rules. Percent
    // signs are doubled so the launcher does not treat them as field codes.
    let mut quoted_argument = String::with_capacity(path.len() + 2);
    quoted_argument.push('"');
    for character in path.chars() {
        match character {
            '\\' | '"' | '`' | '$' => {
                quoted_argument.push('\\');
                quoted_argument.push(character);
            }
            '%' => quoted_argument.push_str("%%"),
            _ => quoted_argument.push(character),
        }
    }
    quoted_argument.push('"');

    // Exec is also a desktop-entry string value. Escape its backslashes and
    // supported control characters so the parser can apply the Exec quoting
    // rules to the intended argument above.
    let mut encoded = String::with_capacity(quoted_argument.len() + 2);
    for character in quoted_argument.chars() {
        match character {
            '\\' => encoded.push_str("\\\\"),
            '\t' => encoded.push_str("\\t"),
            '\n' => encoded.push_str("\\n"),
            '\r' => encoded.push_str("\\r"),
            _ => encoded.push(character),
        }
    }
    Ok(encoded)
}

#[cfg(any(target_os = "linux", test))]
fn encode_linux_exec_path(path: &str) -> Result<String, String> {
    // Desktop Entry Exec forbids '=' in its executable token. Keep that token
    // fixed at env, then pass the AppImage path as a quoted argument so valid
    // install paths such as "Work=Home" remain launchable. The absolute path
    // also prevents env from interpreting it as an environment assignment.
    Ok(format!(
        "\"/usr/bin/env\" -- {}",
        encode_linux_exec_argument(path)?
    ))
}

#[cfg(target_os = "linux")]
fn launch_path(path: String) -> Result<String, String> {
    encode_linux_exec_path(&path)
}

#[cfg(target_os = "windows")]
fn build_auto_launch() -> Result<auto_launch::AutoLaunch, String> {
    use auto_launch::{AutoLaunchBuilder, WindowsEnableMode};

    let executable = launch_path(current_executable_path()?);
    let mut builder = AutoLaunchBuilder::new();
    builder
        .set_app_name("Firelink")
        .set_app_path(&executable)
        .set_windows_enable_mode(WindowsEnableMode::CurrentUser)
        .set_args(&[AUTOSTART_ARGUMENT]);
    builder
        .build()
        .map_err(|error| format!("could not configure Windows startup: {error}"))
}

#[cfg(target_os = "linux")]
fn build_auto_launch() -> Result<auto_launch::AutoLaunch, String> {
    use auto_launch::{AutoLaunchBuilder, LinuxLaunchMode};

    let executable = launch_path(linux_executable_path()?)?;
    let mut builder = AutoLaunchBuilder::new();
    builder
        .set_app_name("Firelink")
        .set_app_path(&executable)
        .set_linux_launch_mode(LinuxLaunchMode::XdgAutostart)
        .set_args(&[AUTOSTART_ARGUMENT]);
    builder
        .build()
        .map_err(|error| format!("could not configure Linux startup: {error}"))
}

#[cfg(target_os = "macos")]
fn build_macos_sm_app_service() -> Result<auto_launch::AutoLaunch, String> {
    use auto_launch::{AutoLaunchBuilder, MacOSLaunchMode};

    let mut builder = AutoLaunchBuilder::new();
    builder
        .set_macos_launch_mode(MacOSLaunchMode::SMAppService)
        .set_args(&[AUTOSTART_ARGUMENT]);
    builder
        .build()
        .map_err(|error| format!("macOS SMAppService is unavailable: {error}"))
}

#[cfg(target_os = "macos")]
fn macos_launch_agent_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "could not resolve the macOS user home directory".to_string())?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join("Firelink.plist"))
}

#[cfg(target_os = "macos")]
fn macos_launch_agent_value(executable: &str) -> plist::Value {
    let mut dictionary = plist::Dictionary::new();
    dictionary.insert(
        "Label".to_string(),
        plist::Value::String("Firelink".to_string()),
    );
    dictionary.insert(
        "AssociatedBundleIdentifiers".to_string(),
        plist::Value::Array(vec![plist::Value::String(
            "com.nimbold.firelink".to_string(),
        )]),
    );
    dictionary.insert(
        "ProgramArguments".to_string(),
        plist::Value::Array(vec![
            plist::Value::String(executable.to_string()),
            plist::Value::String(AUTOSTART_ARGUMENT.to_string()),
        ]),
    );
    dictionary.insert("RunAtLoad".to_string(), plist::Value::Boolean(true));
    plist::Value::Dictionary(dictionary)
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MacOSLaunchAgentState {
    Missing,
    CurrentFirelink,
    StaleFirelink,
    ForeignOrInvalid,
}

#[cfg(target_os = "macos")]
fn macos_launch_agent_is_owned(value: &plist::Value) -> bool {
    let Some(dictionary) = value.as_dictionary() else {
        return false;
    };
    let bundle_identifiers = dictionary
        .get("AssociatedBundleIdentifiers")
        .and_then(plist::Value::as_array);

    dictionary.get("Label").and_then(plist::Value::as_string) == Some("Firelink")
        && bundle_identifiers.is_some_and(|identifiers| {
            identifiers
                .iter()
                .any(|identifier| identifier.as_string() == Some("com.nimbold.firelink"))
        })
}

#[cfg(target_os = "macos")]
fn macos_launch_agent_matches(value: &plist::Value, executable: &str) -> bool {
    if !macos_launch_agent_is_owned(value) {
        return false;
    }
    let Some(dictionary) = value.as_dictionary() else {
        return false;
    };
    let arguments = dictionary
        .get("ProgramArguments")
        .and_then(plist::Value::as_array);

    dictionary
        .get("RunAtLoad")
        .and_then(plist::Value::as_boolean)
        == Some(true)
        && arguments.is_some_and(|arguments| {
            arguments.len() == 2
                && arguments[0].as_string() == Some(executable)
                && arguments[1].as_string() == Some(AUTOSTART_ARGUMENT)
        })
}

#[cfg(target_os = "macos")]
fn macos_launch_agent_state(contents: &[u8], executable: &str) -> MacOSLaunchAgentState {
    let Ok(value) = plist::Value::from_reader(std::io::Cursor::new(contents)) else {
        return MacOSLaunchAgentState::ForeignOrInvalid;
    };
    if !macos_launch_agent_is_owned(&value) {
        return MacOSLaunchAgentState::ForeignOrInvalid;
    }
    if macos_launch_agent_matches(&value, executable) {
        MacOSLaunchAgentState::CurrentFirelink
    } else {
        MacOSLaunchAgentState::StaleFirelink
    }
}

#[cfg(target_os = "macos")]
fn macos_launch_agent_needs_cleanup(state: MacOSLaunchAgentState) -> bool {
    state == MacOSLaunchAgentState::StaleFirelink
}

#[cfg(target_os = "macos")]
fn macos_launch_agent_is_firelink_owned(state: MacOSLaunchAgentState) -> bool {
    matches!(
        state,
        MacOSLaunchAgentState::CurrentFirelink | MacOSLaunchAgentState::StaleFirelink
    )
}

#[cfg(target_os = "macos")]
fn inspect_macos_launch_agent() -> Result<MacOSLaunchAgentState, String> {
    let path = macos_launch_agent_path()?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(MacOSLaunchAgentState::Missing);
        }
        Err(error) => Err(format!(
            "could not inspect macOS LaunchAgent plist: {error}"
        ))?,
    };
    if !metadata.file_type().is_file() {
        return Ok(MacOSLaunchAgentState::ForeignOrInvalid);
    }
    let executable = current_executable_path()?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(macos_launch_agent_state(&bytes, &executable)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(MacOSLaunchAgentState::Missing)
        }
        Err(error) => Err(format!("could not read macOS LaunchAgent plist: {error}")),
    }
}

#[cfg(target_os = "macos")]
fn enable_macos_launch_agent() -> Result<(), String> {
    match inspect_macos_launch_agent()? {
        MacOSLaunchAgentState::CurrentFirelink => return Ok(()),
        MacOSLaunchAgentState::StaleFirelink => disable_macos_launch_agent()?,
        MacOSLaunchAgentState::Missing => {}
        MacOSLaunchAgentState::ForeignOrInvalid => {
            return Err(
                "an existing LaunchAgent plist at Firelink's path is not owned by Firelink"
                    .to_string(),
            );
        }
    }
    let path = macos_launch_agent_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "macOS LaunchAgent path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("could not create macOS LaunchAgents directory: {error}"))?;

    let executable = current_executable_path()?;
    let value = macos_launch_agent_value(&executable);
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("could not prepare macOS LaunchAgent plist: {error}"))?;
    value
        .to_writer_xml(temporary.as_file_mut())
        .map_err(|error| format!("could not serialize macOS LaunchAgent plist: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("could not sync macOS LaunchAgent plist: {error}"))?;
    temporary
        .persist_noclobber(&path)
        .map_err(|error| format!("could not install macOS LaunchAgent plist: {}", error.error))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn disable_macos_launch_agent() -> Result<(), String> {
    let state = inspect_macos_launch_agent()?;
    if !macos_launch_agent_is_firelink_owned(state) {
        return Ok(());
    }
    let path = macos_launch_agent_path()?;
    match std::fs::symlink_metadata(&path) {
        Ok(_) => std::fs::remove_file(path)
            .map_err(|error| format!("could not remove macOS LaunchAgent plist: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "could not inspect macOS LaunchAgent plist: {error}"
        )),
    }
}

#[cfg(target_os = "macos")]
fn macos_service_status() -> smappservice_rs::ServiceStatus {
    use smappservice_rs::{AppService, ServiceType};

    AppService::new(ServiceType::MainApp).status()
}

#[cfg(target_os = "macos")]
fn status_macos() -> Result<LoginStartStatus, String> {
    use smappservice_rs::ServiceStatus;

    let mut fallback_state = inspect_macos_launch_agent()?;
    if fallback_state == MacOSLaunchAgentState::ForeignOrInvalid {
        log::warn!("existing macOS LaunchAgent plist is invalid or not owned by Firelink");
    }
    if macos_launch_agent_needs_cleanup(fallback_state) {
        // A LaunchAgent for an older app path can still start that old copy at
        // login even though this installation would report itself disabled.
        // Remove the stale Firelink-owned fallback before returning status.
        disable_macos_launch_agent().map_err(|error| {
            format!("could not remove stale macOS LaunchAgent startup: {error}")
        })?;
        fallback_state = MacOSLaunchAgentState::Missing;
    }
    let fallback_enabled = fallback_state == MacOSLaunchAgentState::CurrentFirelink;

    let Some(_modern) = build_macos_sm_app_service().ok() else {
        return Ok(LoginStartStatus {
            supported: true,
            enabled: fallback_enabled,
            requires_approval: false,
        });
    };

    let modern_status = macos_service_status();
    match modern_status {
        ServiceStatus::Enabled | ServiceStatus::RequiresApproval => {
            if macos_launch_agent_is_firelink_owned(fallback_state) {
                disable_macos_launch_agent().map_err(|error| {
                    format!("could not remove stale macOS LaunchAgent startup: {error}")
                })?;
            }
            Ok(LoginStartStatus {
                supported: true,
                enabled: true,
                requires_approval: modern_status == ServiceStatus::RequiresApproval,
            })
        }
        ServiceStatus::NotRegistered | ServiceStatus::NotFound => Ok(LoginStartStatus {
            supported: true,
            enabled: fallback_enabled,
            requires_approval: false,
        }),
    }
}

pub fn status() -> Result<LoginStartStatus, String> {
    #[cfg(target_os = "macos")]
    {
        return status_macos();
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let launcher = build_auto_launch()?;
        let enabled = launcher
            .is_enabled()
            .map_err(|error| format!("could not read system-login startup state: {error}"))?;
        return Ok(LoginStartStatus {
            supported: true,
            enabled,
            requires_approval: false,
        });
    }

    #[allow(unreachable_code)]
    Ok(LoginStartStatus {
        supported: false,
        enabled: false,
        requires_approval: false,
    })
}

pub fn enable() -> Result<LoginStartStatus, String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(modern) = build_macos_sm_app_service() {
            use smappservice_rs::ServiceStatus;

            if matches!(
                macos_service_status(),
                ServiceStatus::Enabled | ServiceStatus::RequiresApproval
            ) {
                // Only one registration may own startup. A stale fallback
                // from an older build must not launch a second Firelink
                // process alongside SMAppService.
                if matches!(
                    inspect_macos_launch_agent()?,
                    MacOSLaunchAgentState::CurrentFirelink | MacOSLaunchAgentState::StaleFirelink
                ) {
                    disable_macos_launch_agent().map_err(|error| {
                        format!("could not remove stale macOS LaunchAgent startup: {error}")
                    })?;
                }
                return status_macos();
            }
            match modern.enable() {
                Ok(()) => {
                    if matches!(
                        macos_service_status(),
                        ServiceStatus::Enabled | ServiceStatus::RequiresApproval
                    ) {
                        if matches!(
                            inspect_macos_launch_agent()?,
                            MacOSLaunchAgentState::CurrentFirelink
                                | MacOSLaunchAgentState::StaleFirelink
                        ) {
                            if let Err(error) = disable_macos_launch_agent() {
                                let _ = modern.disable();
                                return Err(format!(
                                    "could not remove stale macOS LaunchAgent startup: {error}"
                                ));
                            }
                        }
                        return status_macos();
                    }
                }
                Err(error) => {
                    log::warn!(
                        "macOS SMAppService registration unavailable; trying LaunchAgent fallback: {error}"
                    );
                }
            }
        }

        enable_macos_launch_agent()
            .map_err(|error| format!("could not enable macOS login startup: {error}"))?;
        return status_macos();
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let launcher = build_auto_launch()?;
        launcher
            .enable()
            .map_err(|error| format!("could not enable system-login startup: {error}"))?;
        return status();
    }

    #[allow(unreachable_code)]
    Err("system-login startup is not supported on this platform".to_string())
}

pub fn disable() -> Result<LoginStartStatus, String> {
    #[cfg(target_os = "macos")]
    {
        let mut first_error = None;
        if let Ok(modern) = build_macos_sm_app_service() {
            use smappservice_rs::ServiceStatus;

            if matches!(
                macos_service_status(),
                ServiceStatus::Enabled | ServiceStatus::RequiresApproval
            ) {
                if let Err(error) = modern.disable() {
                    first_error = Some(format!("could not disable macOS SMAppService: {error}"));
                }
            }
        }

        if let Err(error) = disable_macos_launch_agent() {
            first_error.get_or_insert_with(|| {
                format!("could not disable macOS LaunchAgent startup: {error}")
            });
        }

        if let Some(error) = first_error {
            return Err(error);
        }
        return status_macos();
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let launcher = build_auto_launch()?;
        launcher
            .disable()
            .map_err(|error| format!("could not disable system-login startup: {error}"))?;
        return status();
    }

    #[allow(unreachable_code)]
    Err("system-login startup is not supported on this platform".to_string())
}

pub fn open_login_items_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        smappservice_rs::AppService::open_system_settings_login_items();
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("login-item settings are only available on macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::{encode_linux_exec_path, has_autostart_argument, AUTOSTART_ARGUMENT};

    #[cfg(target_os = "macos")]
    use super::{macos_launch_agent_state, macos_launch_agent_value, MacOSLaunchAgentState};

    #[cfg(target_os = "macos")]
    use super::{macos_launch_agent_is_firelink_owned, macos_launch_agent_needs_cleanup};

    #[test]
    fn accepts_only_the_exact_autostart_argument() {
        assert!(has_autostart_argument([AUTOSTART_ARGUMENT]));
        assert!(has_autostart_argument([
            "--other",
            AUTOSTART_ARGUMENT,
            "/tmp/file.torrent"
        ]));
        assert!(!has_autostart_argument(["--firelink-autostart=true"]));
        assert!(!has_autostart_argument(["--firelink-autostart-extra"]));
        assert!(!has_autostart_argument(["firelink-autostart"]));
    }

    #[test]
    fn encodes_linux_exec_path_special_characters() {
        let path = r#"/opt/Firelink app/quoted"/back\slash/$cost/`tick`/100%"#;

        assert_eq!(
            encode_linux_exec_path(path).unwrap(),
            r#""/usr/bin/env" -- "/opt/Firelink app/quoted\\"/back\\\\slash/\\$cost/\\`tick\\`/100%%""#
        );
    }

    #[test]
    fn passes_equals_in_linux_appimage_path_as_a_launcher_argument() {
        assert_eq!(
            encode_linux_exec_path("/home/user/Apps/Work=Home/Firelink AppImage%2.AppImage")
                .unwrap(),
            r#""/usr/bin/env" -- "/home/user/Apps/Work=Home/Firelink AppImage%%2.AppImage""#
        );
    }

    #[test]
    fn rejects_control_characters_in_linux_executable_paths() {
        for character in ['\0', '\t', '\n', '\r', '\u{1}', '\u{7f}', '\u{85}'] {
            let path = format!("/opt/Firelink{character}path");
            assert!(encode_linux_exec_path(&path).is_err());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launch_agent_plist_round_trips_xml_metacharacters_and_validates_status() {
        let executable = "/Applications/Firelink & <QA> >.app/Contents/MacOS/firelink";
        let value = macos_launch_agent_value(executable);
        let mut serialized = Vec::new();
        value.to_writer_xml(&mut serialized).unwrap();

        let serialized_text = std::str::from_utf8(&serialized).unwrap();
        assert!(serialized_text.contains("&amp;"));
        assert!(serialized_text.contains("&lt;"));
        assert_eq!(
            macos_launch_agent_state(&serialized, executable),
            MacOSLaunchAgentState::CurrentFirelink
        );
        assert_eq!(
            macos_launch_agent_state(
                &serialized,
                "/Applications/Another Firelink.app/Contents/MacOS/firelink"
            ),
            MacOSLaunchAgentState::StaleFirelink
        );
        assert_eq!(
            macos_launch_agent_state(b"<plist><invalid>", executable),
            MacOSLaunchAgentState::ForeignOrInvalid
        );
        assert!(macos_launch_agent_needs_cleanup(
            MacOSLaunchAgentState::StaleFirelink
        ));
        assert!(!macos_launch_agent_needs_cleanup(
            MacOSLaunchAgentState::CurrentFirelink
        ));
        assert!(!macos_launch_agent_needs_cleanup(
            MacOSLaunchAgentState::ForeignOrInvalid
        ));
        assert!(!macos_launch_agent_needs_cleanup(
            MacOSLaunchAgentState::Missing
        ));
        assert!(macos_launch_agent_is_firelink_owned(
            MacOSLaunchAgentState::CurrentFirelink
        ));
        assert!(macos_launch_agent_is_firelink_owned(
            MacOSLaunchAgentState::StaleFirelink
        ));
        assert!(!macos_launch_agent_is_firelink_owned(
            MacOSLaunchAgentState::ForeignOrInvalid
        ));

        let mut foreign_dictionary = plist::Dictionary::new();
        foreign_dictionary.insert("Label".to_string(), plist::Value::String("Other".into()));
        foreign_dictionary.insert(
            "AssociatedBundleIdentifiers".to_string(),
            plist::Value::Array(vec![plist::Value::String("com.example.other".into())]),
        );
        let foreign = plist::Value::Dictionary(foreign_dictionary);
        let mut foreign_serialized = Vec::new();
        foreign.to_writer_xml(&mut foreign_serialized).unwrap();
        assert_eq!(
            macos_launch_agent_state(&foreign_serialized, executable),
            MacOSLaunchAgentState::ForeignOrInvalid
        );
    }
}

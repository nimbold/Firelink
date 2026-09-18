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
    use objc::declare::ClassDecl;
    use objc::runtime::{Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};

    // Core Event / Open Application / property-data / login-item marker.
    const K_CORE_EVENT_CLASS: u32 = u32::from_be_bytes(*b"aevt");
    const K_AE_OPEN_APPLICATION: u32 = u32::from_be_bytes(*b"oapp");
    const KEY_AE_PROP_DATA: u32 = u32::from_be_bytes(*b"prdt");
    const KEY_AE_LAUNCHED_AS_LOGIN_ITEM: u32 = u32::from_be_bytes(*b"lgit");
    const TYPE_TYPE: u32 = u32::from_be_bytes(*b"type");

    static INSTALL: Once = Once::new();
    static LOGIN_LAUNCH: AtomicBool = AtomicBool::new(false);
    static DECIDED: AtomicBool = AtomicBool::new(false);

    extern "C" fn application_will_finish_launching(
        this: &Object,
        _cmd: Sel,
        _notification: *mut Object,
    ) {
        unsafe {
            let manager: *mut Object =
                msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
            if manager.is_null() {
                return;
            }

            let _: () = msg_send![
                manager,
                setEventHandler: this as *const Object as *mut Object
                andSelector: sel!(handleAppleEvent:withReplyEvent:)
                forEventClass: K_CORE_EVENT_CLASS
                andEventID: K_AE_OPEN_APPLICATION
            ];
        }
    }

    extern "C" fn handle_apple_event(
        _this: &Object,
        _cmd: Sel,
        event: *mut Object,
        _reply_event: *mut Object,
    ) {
        let is_login_launch = unsafe {
            if event.is_null() {
                false
            } else {
                let property_data: *mut Object =
                    msg_send![event, paramDescriptorForKeyword: KEY_AE_PROP_DATA];
                if property_data.is_null() {
                    false
                } else {
                    let descriptor_type: u32 = msg_send![property_data, descriptorType];
                    if descriptor_type != TYPE_TYPE {
                        false
                    } else {
                        let value: u32 = msg_send![property_data, typeCodeValue];
                        value == KEY_AE_LAUNCHED_AS_LOGIN_ITEM
                    }
                }
            }
        };

        if DECIDED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            LOGIN_LAUNCH.store(is_login_launch, Ordering::Release);
        }
    }

    pub fn install() {
        INSTALL.call_once(|| unsafe {
            let mut declaration = ClassDecl::new("FirelinkLoginLaunchObserver", class!(NSObject))
                .expect("could not allocate macOS login-launch observer class");
            declaration.add_method(
                sel!(applicationWillFinishLaunching:),
                application_will_finish_launching as extern "C" fn(&Object, Sel, *mut Object),
            );
            declaration.add_method(
                sel!(handleAppleEvent:withReplyEvent:),
                handle_apple_event as extern "C" fn(&Object, Sel, *mut Object, *mut Object),
            );
            let observer_class = declaration.register();
            let observer: *mut Object = msg_send![observer_class, new];
            if observer.is_null() {
                log::error!("could not create macOS login-launch observer");
                return;
            }

            // NotificationCenter does not own selector-based observers. The
            // object is intentionally retained for the process lifetime.
            let notification_center: *mut Object =
                msg_send![class!(NSNotificationCenter), defaultCenter];
            let application: *mut Object = msg_send![class!(NSApplication), sharedApplication];
            let notification_name: *mut Object = msg_send![
                class!(NSString),
                stringWithUTF8String: b"NSApplicationWillFinishLaunchingNotification\0".as_ptr()
            ];
            let _: () = msg_send![
                notification_center,
                addObserver: observer
                selector: sel!(applicationWillFinishLaunching:)
                name: notification_name
                object: application
            ];
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

#[cfg(target_os = "linux")]
fn launch_path(path: String) -> String {
    // XDG Exec values use double-quoted arguments rather than shell parsing.
    let escaped = path.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

#[cfg(target_os = "macos")]
fn launch_path(path: String) -> String {
    path
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

    let executable = launch_path(linux_executable_path()?);
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
fn build_macos_launch_agent() -> Result<auto_launch::AutoLaunch, String> {
    use auto_launch::{AutoLaunchBuilder, MacOSLaunchMode};

    let executable = launch_path(current_executable_path()?);
    let mut builder = AutoLaunchBuilder::new();
    builder
        .set_app_name("Firelink")
        .set_app_path(&executable)
        .set_macos_launch_mode(MacOSLaunchMode::LaunchAgent)
        .set_bundle_identifiers(&["com.nimbold.firelink"])
        .set_args(&[AUTOSTART_ARGUMENT]);
    builder
        .build()
        .map_err(|error| format!("could not configure macOS LaunchAgent: {error}"))
}

#[cfg(target_os = "macos")]
fn macos_service_status() -> smappservice_rs::ServiceStatus {
    use smappservice_rs::{AppService, ServiceType};

    AppService::new(ServiceType::MainApp).status()
}

#[cfg(target_os = "macos")]
fn status_macos() -> Result<LoginStartStatus, String> {
    use smappservice_rs::ServiceStatus;

    let fallback = build_macos_launch_agent()?;
    let fallback_enabled = fallback
        .is_enabled()
        .map_err(|error| format!("could not read macOS LaunchAgent state: {error}"))?;

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
            if fallback_enabled {
                fallback.disable().map_err(|error| {
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
        let fallback = build_macos_launch_agent()?;
        if let Ok(modern) = build_macos_sm_app_service() {
            use smappservice_rs::ServiceStatus;

            if matches!(
                macos_service_status(),
                ServiceStatus::Enabled | ServiceStatus::RequiresApproval
            ) {
                // Only one registration may own startup. A stale fallback
                // from an older build must not launch a second Firelink
                // process alongside SMAppService.
                fallback.disable().map_err(|error| {
                    format!("could not remove stale macOS LaunchAgent startup: {error}")
                })?;
                return status_macos();
            }
            match modern.enable() {
                Ok(()) => {
                    if matches!(
                        macos_service_status(),
                        ServiceStatus::Enabled | ServiceStatus::RequiresApproval
                    ) {
                        if let Err(error) = fallback.disable() {
                            let _ = modern.disable();
                            return Err(format!(
                                "could not remove stale macOS LaunchAgent startup: {error}"
                            ));
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

        fallback
            .enable()
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

        if let Ok(fallback) = build_macos_launch_agent() {
            if let Err(error) = fallback.disable() {
                first_error.get_or_insert_with(|| {
                    format!("could not disable macOS LaunchAgent startup: {error}")
                });
            }
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
    use super::{has_autostart_argument, AUTOSTART_ARGUMENT};

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
}

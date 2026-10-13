use std::time::{Duration, Instant};

#[test]
fn shell_process_group_descendant_fixture() {
    match std::env::var("FIRELINK_SHELL_PROCESS_GROUP_FIXTURE").as_deref() {
        Ok("launcher") => {
            let executable = std::env::current_exe().expect("test executable path");
            let descendant = std::process::Command::new(executable)
                .args([
                    "--exact",
                    "shell_process_group_descendant_fixture",
                    "--nocapture",
                ])
                .env("FIRELINK_SHELL_PROCESS_GROUP_FIXTURE", "descendant")
                .spawn()
                .expect("spawn long-running descendant");

            use std::io::Write;
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "FIRELINK_DESCENDANT_PID={}", descendant.id())
                .expect("write descendant PID");
            stdout.flush().expect("flush descendant PID");
        }
        Ok("descendant") => loop {
            std::thread::park_timeout(Duration::from_secs(60));
        },
        _ => {}
    }
}

#[cfg(windows)]
fn process_is_running(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if process.is_null() {
        return false;
    }

    let running = unsafe { WaitForSingleObject(process, 0) } == WAIT_TIMEOUT;
    unsafe { CloseHandle(process) };
    running
}

#[cfg(not(windows))]
fn process_is_running(pid: u32) -> bool {
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system.process(sysinfo::Pid::from_u32(pid)).is_some()
}

async fn wait_for_process_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !process_is_running(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn shell_process_group_kills_descendant_after_launcher_exit() {
    use tauri_plugin_shell::ShellExt;

    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_shell::init())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let executable = std::env::current_exe().expect("test executable path");
    let (mut events, child) = app
        .shell()
        .command(executable)
        .args([
            "--exact",
            "shell_process_group_descendant_fixture",
            "--nocapture",
        ])
        .env("FIRELINK_SHELL_PROCESS_GROUP_FIXTURE", "launcher")
        .set_process_group(true)
        .spawn()
        .expect("spawn launcher with process-group ownership");
    let launcher_pid = child.pid();
    let mut output = String::new();
    let descendant_pid = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match events.recv().await {
                Some(tauri_plugin_shell::process::CommandEvent::Stdout(bytes)) => {
                    output.push_str(&String::from_utf8_lossy(&bytes));
                    if let Some(pid) = output
                        .split("FIRELINK_DESCENDANT_PID=")
                        .nth(1)
                        .and_then(|value| value.split_whitespace().next())
                        .and_then(|value| value.parse::<u32>().ok())
                    {
                        return Ok(pid);
                    }
                }
                Some(tauri_plugin_shell::process::CommandEvent::Terminated(_)) => {
                    return Err("launcher exited before reporting its descendant".to_string());
                }
                Some(tauri_plugin_shell::process::CommandEvent::Error(error)) => {
                    return Err(format!("launcher process error: {error}"));
                }
                None => {
                    return Err(
                        "launcher event stream closed before reporting its descendant".to_string(),
                    );
                }
                _ => {}
            }
        }
    })
    .await;
    let descendant_pid = match descendant_pid {
        Ok(Ok(pid)) => pid,
        Ok(Err(error)) => {
            let _ = child.kill();
            panic!("{error}");
        }
        Err(_) => {
            let _ = child.kill();
            panic!("launcher did not report its descendant within 10 seconds");
        }
    };

    if !wait_for_process_exit(launcher_pid, Duration::from_secs(10)).await {
        let _ = child.kill();
        panic!("launcher did not exit after spawning its descendant");
    }
    if !process_is_running(descendant_pid) {
        let _ = child.kill();
        panic!("descendant exited before its process group was terminated");
    }

    child.kill().expect("terminate process group");
    let terminated = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match events.recv().await {
                Some(tauri_plugin_shell::process::CommandEvent::Terminated(payload)) => {
                    return Ok(payload);
                }
                Some(tauri_plugin_shell::process::CommandEvent::Error(error)) => {
                    return Err(format!("process-group termination error: {error}"));
                }
                None => {
                    return Err("process-group event stream closed before termination".to_string());
                }
                _ => {}
            }
        }
    })
    .await
    .expect("process group should terminate within 10 seconds")
    .expect("process group should report termination");
    assert_eq!(terminated.code, Some(0), "launcher exit status");
    assert!(
        wait_for_process_exit(descendant_pid, Duration::from_secs(10)).await,
        "descendant should exit when its process group is killed"
    );
}

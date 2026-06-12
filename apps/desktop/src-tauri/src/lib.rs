// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use tauri::{Manager, Emitter};
use std::process::Command;
use tokio::process::Command as AsyncCommand;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use regex::Regex;
use serde::Serialize;

#[derive(Serialize)]
struct MetadataResponse {
    filename: String,
    size: String,
    size_bytes: u64,
}

#[tauri::command]
async fn fetch_metadata(url: String, user_agent: Option<String>) -> Result<MetadataResponse, String> {
    let mut builder = reqwest::Client::builder();
    if let Some(ua) = user_agent {
        if !ua.is_empty() {
            builder = builder.user_agent(ua);
        } else {
            builder = builder.user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        }
    } else {
        builder = builder.user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    }
    
    let client = builder.build().map_err(|e| e.to_string())?;

    let mut res = client.head(&url).send().await.map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    }

    let mut filename = String::new();
    if let Some(cd) = res.headers().get(reqwest::header::CONTENT_DISPOSITION) {
        if let Ok(cd_str) = cd.to_str() {
            if let Some(idx) = cd_str.find("filename=") {
                let rest = &cd_str[idx + 9..];
                filename = rest.trim_matches('"').to_string();
            }
        }
    }
    
    if filename.is_empty() {
        if let Ok(parsed) = reqwest::Url::parse(&url) {
            if let Some(segments) = parsed.path_segments() {
                if let Some(last) = segments.last() {
                    filename = last.to_string();
                }
            }
        }
    }
    if filename.is_empty() {
        filename = "download".to_string();
    }

    let mut size_str = "Unknown".to_string();
    let mut size_bytes = 0;
    if let Some(len) = res.headers().get(reqwest::header::CONTENT_LENGTH) {
        if let Ok(len_str) = len.to_str() {
            if let Ok(bytes) = len_str.parse::<u64>() {
                size_bytes = bytes;
                if bytes < 1024 {
                    size_str = format!("{} B", bytes);
                } else if bytes < 1024 * 1024 {
                    size_str = format!("{:.1} KB", bytes as f64 / 1024.0);
                } else if bytes < 1024 * 1024 * 1024 {
                    size_str = format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0);
                } else {
                    size_str = format!("{:.2} GB", bytes as f64 / 1024.0 / 1024.0 / 1024.0);
                }
            }
        }
    }

    Ok(MetadataResponse { filename, size: size_str, size_bytes })
}

#[tauri::command]
fn greet(name: &str) -> String {
    println!("greet called with name: {}", name);
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn test_ytdlp(app_handle: tauri::AppHandle) -> Result<String, String> {
    println!("test_ytdlp called!");
    let resource_dir = app_handle.path().resource_dir().map_err(|e| e.to_string())?;
    let ytdlp_path = resource_dir.join("binaries").join("yt-dlp");
    println!("Resolved yt-dlp path: {:?}", ytdlp_path);
    
    let output = Command::new(&ytdlp_path)
        .arg("--version")
        .output()
        .map_err(|e| {
            println!("Failed to execute: {}", e);
            format!("Failed to execute yt-dlp: {}", e)
        })?;
        
    println!("yt-dlp execution finished with status: {}", output.status);
    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        println!("yt-dlp output: {}", text);
        Ok(text)
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        println!("yt-dlp error output: {}", err);
        Err(format!("yt-dlp error: {}", err))
    }
}

#[tauri::command]
async fn test_aria2c(app_handle: tauri::AppHandle) -> Result<String, String> {
    println!("test_aria2c called!");
    let resource_dir = app_handle.path().resource_dir().map_err(|e| e.to_string())?;
    let aria2c_path = resource_dir.join("binaries").join("aria2c");
    println!("Resolved aria2c path: {:?}", aria2c_path);
    
    let output = Command::new(&aria2c_path)
        .arg("--version")
        .output()
        .map_err(|e| {
            println!("Failed to execute: {}", e);
            format!("Failed to execute aria2c: {}", e)
        })?;
        
    println!("aria2c execution finished with status: {}", output.status);
    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        // aria2c prints a lot, just get the first line for the version
        let first_line = text.lines().next().unwrap_or("").to_string();
        println!("aria2c output: {}", first_line);
        Ok(first_line)
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        println!("aria2c error output: {}", err);
        Err(format!("aria2c error: {}", err))
    }
}

#[tauri::command]
async fn test_ffmpeg(app_handle: tauri::AppHandle) -> Result<String, String> {
    println!("test_ffmpeg called!");
    let resource_dir = app_handle.path().resource_dir().map_err(|e| e.to_string())?;
    let ffmpeg_path = resource_dir.join("binaries").join("ffmpeg");
    println!("Resolved ffmpeg path: {:?}", ffmpeg_path);
    
    let output = Command::new(&ffmpeg_path)
        .arg("-version")
        .output()
        .map_err(|e| {
            println!("Failed to execute: {}", e);
            format!("Failed to execute ffmpeg: {}", e)
        })?;
        
    println!("ffmpeg execution finished with status: {}", output.status);
    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let first_line = text.lines().next().unwrap_or("").to_string();
        println!("ffmpeg output: {}", first_line);
        Ok(first_line)
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        println!("ffmpeg error output: {}", err);
        Err(format!("ffmpeg error: {}", err))
    }
}

#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    println!("open_file called for path: {}", path);
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(&path)
            .status();
        match status {
            Ok(s) if s.success() => Ok(()),
            _ => Err(format!("Failed to open file: {:?}", status)),
        }
    }
    #[cfg(target_os = "windows")]
    {
        let status = std::process::Command::new("cmd")
            .arg("/c")
            .arg("start")
            .arg("")
            .arg(&path)
            .status();
        match status {
            Ok(s) if s.success() => Ok(()),
            _ => Err(format!("Failed to open file: {:?}", status)),
        }
    }
    #[cfg(target_os = "linux")]
    {
        let status = std::process::Command::new("xdg-open")
            .arg(&path)
            .status();
        match status {
            Ok(s) if s.success() => Ok(()),
            _ => Err(format!("Failed to open file: {:?}", status)),
        }
    }
}

#[tauri::command]
async fn show_in_folder(path: String) -> Result<(), String> {
    println!("show_in_folder called for path: {}", path);
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .status();
        match status {
            Ok(s) if s.success() => Ok(()),
            _ => Err(format!("Failed to show in Finder: {:?}", status)),
        }
    }
    #[cfg(target_os = "windows")]
    {
        let status = std::process::Command::new("explorer")
            .arg("/select,")
            .arg(path.replace("/", "\\"))
            .status();
        match status {
            Ok(s) if s.success() => Ok(()),
            _ => Err(format!("Failed to show in Explorer: {:?}", status)),
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            let status = std::process::Command::new("xdg-open")
                .arg(parent)
                .status();
            match status {
                Ok(s) if s.success() => Ok(()),
                _ => Err(format!("Failed to open folder: {:?}", status)),
            }
        } else {
            Err("No parent folder found".to_string())
        }
    }
}

use std::collections::HashMap;
use std::sync::Mutex;

struct AppState {
    tasks: Mutex<HashMap<String, u32>>,
}

#[derive(Clone, Serialize)]
struct DownloadProgressEvent {
    id: String,
    fraction: f64,
    speed: String,
    eta: String,
}

#[tauri::command]
async fn start_download(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    url: String,
    destination: String,
    filename: String,
    connections: Option<i32>,
    speed_limit: Option<String>,
    username: Option<String>,
    password: Option<String>,
    headers: Option<String>,
    user_agent: Option<String>,
    max_tries: Option<i32>,
    proxy: Option<String>,
) -> Result<(), String> {
    println!("start_download called for id: {}", id);
    let resource_dir = app_handle.path().resource_dir().map_err(|e| e.to_string())?;
    let aria2c_path = resource_dir.join("binaries").join("aria2c");

    let mut resolved_dest = std::path::PathBuf::from(&destination);
    if destination.starts_with("~/") {
        if let Ok(home) = app_handle.path().home_dir() {
            resolved_dest = home.join(&destination[2..]);
        }
    } else if destination == "~" {
        if let Ok(home) = app_handle.path().home_dir() {
            resolved_dest = home;
        }
    }
    println!("Resolved destination path: {:?}", resolved_dest);

    if !resolved_dest.exists() {
        if let Err(e) = std::fs::create_dir_all(&resolved_dest) {
            println!("Failed to create destination directory: {}", e);
        }
    }

    let mut cmd = AsyncCommand::new(&aria2c_path);
    cmd.arg("--enable-rpc=false")
       .arg("--continue=true")
       .arg("--allow-overwrite=false")
       .arg("--summary-interval=1")
       .arg("--check-certificate=false")
       .arg(format!("--dir={}", resolved_dest.to_string_lossy()))
       .arg(format!("--out={}", filename));
       
    if let Some(conn) = connections {
        cmd.arg(format!("--split={}", conn));
        cmd.arg(format!("--max-connection-per-server={}", conn));
    }
    if let Some(limit) = speed_limit {
        if !limit.is_empty() {
            cmd.arg(format!("--max-overall-download-limit={}", limit));
        }
    }
    if let Some(user) = username {
        if !user.is_empty() {
            cmd.arg(format!("--http-user={}", user));
        }
    }
    if let Some(pass) = password {
        if !pass.is_empty() {
            cmd.arg(format!("--http-passwd={}", pass));
        }
    }
    if let Some(hdr) = headers {
        if !hdr.is_empty() {
            cmd.arg(format!("--header={}", hdr));
        }
    }
    if let Some(ua) = user_agent {
        if !ua.is_empty() {
            cmd.arg(format!("--user-agent={}", ua));
        }
    }
    if let Some(tries) = max_tries {
        cmd.arg(format!("--max-tries={}", tries));
    }
    if let Some(p) = proxy {
        if !p.is_empty() {
            cmd.arg(format!("--all-proxy={}", p));
        }
    }
    
    cmd.arg(&url);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
    // We remove kill_on_drop(true) so we can gracefully SIGTERM it
    // cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn aria2c: {}", e))?;
    
    let pid = child.id().unwrap_or(0);
    state.tasks.lock().unwrap().insert(id.clone(), pid);

    let stdout = child.stdout.take().unwrap();
    let app_handle_clone = app_handle.clone();
    let id_clone = id.clone();
    
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let percentage_re = Regex::new(r"\((\d+)%\)").unwrap();
        let speed_re = Regex::new(r"DL:([^\s\]]+)").unwrap();
        let eta_re = Regex::new(r"ETA:([^\s\]]+)").unwrap();

        loop {
            tokio::select! {
                line_result = reader.next_line() => {
                    match line_result {
                        Ok(Some(line)) => {
                            if line.contains("DL:") {
                                let fraction = percentage_re.captures(&line)
                                    .and_then(|cap| cap.get(1))
                                    .and_then(|m| m.as_str().parse::<f64>().ok())
                                    .unwrap_or(0.0) / 100.0;
                                    
                                let speed = speed_re.captures(&line)
                                    .and_then(|cap| cap.get(1))
                                    .map(|m| m.as_str().to_string())
                                    .unwrap_or_else(|| "-".to_string());
                                    
                                let eta = eta_re.captures(&line)
                                    .and_then(|cap| cap.get(1))
                                    .map(|m| m.as_str().to_string())
                                    .unwrap_or_else(|| "-".to_string());
                                
                                let _ = app_handle_clone.emit("download-progress", DownloadProgressEvent {
                                    id: id_clone.clone(),
                                    fraction,
                                    speed,
                                    eta,
                                });
                            }
                        }
                        _ => break, // EOF or error
                    }
                }
                status = child.wait() => {
                    println!("child exit status: {:?}", status);
                    if let Ok(exit_status) = status {
                        if exit_status.success() {
                            let _ = app_handle_clone.emit("download-complete", id_clone.clone());
                        } else {
                            // If it exited with error, emit failed (7 means paused/aborted usually, but we emit failed anyway, UI can filter)
                            let _ = app_handle_clone.emit("download-failed", id_clone.clone());
                        }
                    }
                    break;
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn pause_download(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    println!("pause_download called for id: {}", id);
    if let Some(pid) = state.tasks.lock().unwrap().remove(&id) {
        if pid > 0 {
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("kill")
                    .arg("-15") // SIGTERM
                    .arg(pid.to_string())
                    .status();
                println!("Sent SIGTERM to pid: {}", pid);
            }
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .arg("/PID")
                    .arg(pid.to_string())
                    .status();
                println!("Sent taskkill to pid: {}", pid);
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn update_dock_badge(app_handle: tauri::AppHandle, count: i32) {
    #[cfg(target_os = "macos")]
    {
        let label = if count > 0 { count.to_string() } else { "".to_string() };
        let script = format!("tell application \"System Events\" to set the badge of application process \"Firelink\" to \"{}\"", label);
        let _ = std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .status();
    }
}

#[tauri::command]
fn set_prevent_sleep(state: tauri::State<'_, AppState>, prevent: bool) {
    #[cfg(target_os = "macos")]
    {
        let mut tasks = state.tasks.lock().unwrap();
        if prevent {
            if !tasks.contains_key("sleep_prevent") {
                if let Ok(child) = std::process::Command::new("caffeinate")
                    .arg("-i")
                    .spawn()
                {
                    tasks.insert("sleep_prevent".to_string(), child.id());
                }
            }
        } else {
            if let Some(pid) = tasks.remove("sleep_prevent") {
                let _ = std::process::Command::new("kill")
                    .arg("-15")
                    .arg(pid.to_string())
                    .status();
            }
        }
    }
}

#[tauri::command]
fn get_free_space(app_handle: tauri::AppHandle, path: String) -> Result<String, String> {
    use sysinfo::Disks;
    use tauri::Manager;
    let disks = Disks::new_with_refreshed_list();
    
    let mut resolved_dest = std::path::PathBuf::from(&path);
    if path.starts_with("~/") {
        if let Ok(home) = app_handle.path().home_dir() {
            resolved_dest = home.join(&path[2..]);
        }
    } else if path == "~" {
        if let Ok(home) = app_handle.path().home_dir() {
            resolved_dest = home;
        }
    }
    
    // Find the disk that the path is mounted on
    let mut best_match: Option<&sysinfo::Disk> = None;
    let mut max_match_len = 0;
    
    for disk in disks.list() {
        let mount_point = disk.mount_point();
        if resolved_dest.starts_with(mount_point) {
            let match_len = mount_point.as_os_str().len();
            if match_len > max_match_len {
                max_match_len = match_len;
                best_match = Some(disk);
            }
        }
    }
    
    if let Some(disk) = best_match {
        let bytes = disk.available_space();
        let size_str = if bytes < 1024 * 1024 {
            format!("{:.1} KB", bytes as f64 / 1024.0)
        } else if bytes < 1024 * 1024 * 1024 {
            format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
        } else {
            format!("{:.2} GB", bytes as f64 / 1024.0 / 1024.0 / 1024.0)
        };
        Ok(size_str)
    } else {
        Ok("Unknown".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            tasks: Mutex::new(HashMap::new()),
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            greet, test_ytdlp, test_aria2c, test_ffmpeg, open_file, show_in_folder, 
            start_download, pause_download, fetch_metadata, update_dock_badge, set_prevent_sleep, get_free_space
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

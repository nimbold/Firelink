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
async fn fetch_metadata(url: String, user_agent: Option<String>, username: Option<String>, password: Option<String>) -> Result<MetadataResponse, String> {
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

    if let Ok(parsed) = reqwest::Url::parse(&url) {
        if let Some(host) = parsed.host_str() {
            let port = parsed.port_or_known_default().unwrap_or(80);
            if let Ok(addrs) = std::net::ToSocketAddrs::to_socket_addrs(&(host, port)) {
                for addr in addrs {
                    let ip = addr.ip();
                    if ip.is_loopback() || ip.is_multicast() || ip.is_unspecified() {
                        return Err("SSRF blocked: Private/local IP not allowed".to_string());
                    }
                    match ip {
                        std::net::IpAddr::V4(ipv4) if ipv4.is_private() || ipv4.is_link_local() => {
                            return Err("SSRF blocked: Private/local IP not allowed".to_string());
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    let mut head_req = client.head(&url);
    if let Some(ref user) = username {
        if !user.is_empty() {
            head_req = head_req.basic_auth(user, password.as_deref());
        }
    }
    let mut res = head_req.send().await.map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let mut get_req = client.get(&url);
        if let Some(ref user) = username {
            if !user.is_empty() {
                get_req = get_req.basic_auth(user, password.as_deref());
            }
        }
        res = get_req.send().await.map_err(|e| e.to_string())?;
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
async fn fetch_media_metadata(app_handle: tauri::AppHandle, url: String, cookie_browser: Option<String>, username: Option<String>, password: Option<String>) -> Result<String, String> {
    println!("fetch_media_metadata called for: {}", url);
    let resource_dir = app_handle.path().resource_dir().map_err(|e| e.to_string())?;
    let ytdlp_path = resource_dir.join("binaries").join("yt-dlp");

    let mut cmd = AsyncCommand::new(&ytdlp_path);
    cmd.arg("-J")
       .arg("--no-warnings")
       .arg("--no-playlist")
       .arg("--no-check-formats")
       .arg("--socket-timeout").arg("20")
       .arg("--retries").arg("3")
       .arg("--extractor-retries").arg("3")
       .arg("--compat-options").arg("no-youtube-unavailable-videos")
       .arg("--js-runtimes").arg("deno,node");

    if let Some(browser) = cookie_browser {
        if !browser.is_empty() {
            cmd.arg("--cookies-from-browser").arg(&browser);
        }
    }
    
    let mut config_file = tempfile::Builder::new().prefix("ytdlp-").suffix(".conf").tempfile().map_err(|e| e.to_string())?;
    let mut config_content = String::new();
    if let Some(user) = username {
        if !user.is_empty() {
            config_content.push_str(&format!("--username\n{}\n", user));
        }
    }
    if let Some(pass) = password {
        if !pass.is_empty() {
            config_content.push_str(&format!("--password\n{}\n", pass));
        }
    }
    use std::io::Write;
    config_file.write_all(config_content.as_bytes()).map_err(|e| e.to_string())?;
    let config_path = config_file.into_temp_path();
    if !config_content.is_empty() {
        cmd.arg("--config-locations").arg(&config_path);
    }

    cmd.arg(&url);

    // We use tokio AsyncCommand so it doesn't block the async thread
    let output = cmd.output()
        .await
        .map_err(|e| format!("Failed to execute yt-dlp: {}", e))?;

    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(text)
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        Err(format!("yt-dlp error: {}", err))
    }
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
        let clean = first_line.replace("aria2 version ", "");
        println!("aria2c output: {}", clean);
        Ok(clean)
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
        let parts: Vec<&str> = first_line.split_whitespace().collect();
        let clean = parts.get(2).unwrap_or(&first_line.as_str()).split('-').next().unwrap_or("").to_string();
        println!("ffmpeg output: {}", clean);
        Ok(clean)
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        println!("ffmpeg error output: {}", err);
        Err(format!("ffmpeg error: {}", err))
    }
}

#[tauri::command]
async fn test_deno(app_handle: tauri::AppHandle) -> Result<String, String> {
    println!("test_deno called!");
    let resource_dir = app_handle.path().resource_dir().map_err(|e| e.to_string())?;
    let deno_path = resource_dir.join("binaries").join("deno");
    println!("Resolved deno path: {:?}", deno_path);

    let output = Command::new(&deno_path)
        .arg("--version")
        .output()
        .map_err(|e| {
            println!("Failed to execute: {}", e);
            format!("Failed to execute deno: {}", e)
        })?;

    println!("deno execution finished with status: {}", output.status);
    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let first_line = text.lines().next().unwrap_or("").to_string();
        let parts: Vec<&str> = first_line.split_whitespace().collect();
        let clean = parts.get(1).unwrap_or(&first_line.as_str()).to_string();
        println!("deno output: {}", clean);
        Ok(clean)
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        println!("deno error output: {}", err);
        Err(format!("deno error: {}", err))
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

mod parity;
pub mod error;
pub use error::AppError;

pub enum TaskHandle {
    Aria2(String),
    Pid(u32),
    Queued,
}

pub struct AppState {
    pub tasks: Arc<Mutex<HashMap<String, TaskHandle>>>,
    pub extension_pairing_token: extension_server::SharedExtensionToken,
    pub extension_frontend_ready: extension_server::SharedFrontendReady,
    pub aria2_port: u16,
    pub aria2_secret: String,
    pub media_semaphore: Arc<tokio::sync::Semaphore>,
}

#[derive(Clone, Serialize)]
struct DownloadProgressEvent {
    id: String,
    fraction: f64,
    speed: String,
    eta: String,
}

fn collect_download_uris(url: &str, mirrors: Option<&str>) -> Vec<String> {
    let mut uris = Vec::new();
    for uri in std::iter::once(url).chain(mirrors.into_iter().flat_map(str::lines)) {
        let uri = uri.trim();
        if !uri.is_empty() && !uris.iter().any(|existing| existing == uri) {
            uris.push(uri.to_string());
        }
    }
    uris
}

async fn rpc_call(port: u16, secret: &str, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{}/jsonrpc", port);
    let mut payload = serde_json::Map::new();
    payload.insert("jsonrpc".to_string(), serde_json::json!("2.0"));
    payload.insert("id".to_string(), serde_json::json!("1"));
    payload.insert("method".to_string(), serde_json::json!(method));
    
    let mut p = vec![serde_json::json!(format!("token:{}", secret))];
    if let serde_json::Value::Array(arr) = params {
        p.extend(arr);
    }
    payload.insert("params".to_string(), serde_json::json!(p));

    let client = reqwest::Client::new();
    let res = client.post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    
    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(json)
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
    checksum: Option<String>,
    cookies: Option<String>,
    mirrors: Option<String>,
    user_agent: Option<String>,
    max_tries: Option<i32>,
    proxy: Option<String>,
) -> Result<(), AppError> {
    println!("start_download called for id: {}", id);
    let state_aria2_port = state.aria2_port;
    let state_aria2_secret = state.aria2_secret.clone();
    let tasks_map = state.tasks.clone();

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
    
    if !resolved_dest.exists() {
        let _ = std::fs::create_dir_all(&resolved_dest);
    }

    let gid: String = id.replace("-", "").chars().take(16).collect();
    // ensure exactly 16 chars
    let gid = format!("{:0<16}", gid);
    
    tasks_map.lock().unwrap().insert(id.clone(), TaskHandle::Aria2(gid.clone()));

    let mut options = serde_json::Map::new();
    options.insert("gid".to_string(), serde_json::json!(gid));
    options.insert("dir".to_string(), serde_json::json!(resolved_dest.to_string_lossy().to_string()));
    options.insert("out".to_string(), serde_json::json!(filename));
    
    if let Some(conn) = connections {
        options.insert("split".to_string(), serde_json::json!(conn.to_string()));
        options.insert("max-connection-per-server".to_string(), serde_json::json!(conn.to_string()));
    }
    if let Some(limit) = speed_limit {
        if !limit.is_empty() {
            options.insert("max-download-limit".to_string(), serde_json::json!(limit));
        }
    }
    
    if let Some(user) = username {
        if !user.is_empty() {
            options.insert("http-user".to_string(), serde_json::json!(user));
            options.insert("ftp-user".to_string(), serde_json::json!(user));
            if let Some(pass) = password {
                options.insert("http-passwd".to_string(), serde_json::json!(pass));
                options.insert("ftp-passwd".to_string(), serde_json::json!(pass));
            }
        }
    }
    
    let mut hdrs = Vec::new();
    if let Some(hdr) = headers {
        for header in hdr.lines().map(str::trim).filter(|h| !h.is_empty()) {
            hdrs.push(header.to_string());
        }
    }
    if let Some(cks) = cookies {
        if !cks.is_empty() {
            hdrs.push(format!("Cookie: {}", cks));
        }
    }
    if !hdrs.is_empty() {
        options.insert("header".to_string(), serde_json::json!(hdrs));
    }
    
    if let Some(p) = proxy {
        if !p.is_empty() {
            options.insert("all-proxy".to_string(), serde_json::json!(p));
        }
    }
    if let Some(ua) = user_agent {
        if !ua.is_empty() {
            options.insert("user-agent".to_string(), serde_json::json!(ua));
        }
    }
    if let Some(chk) = checksum {
        if !chk.is_empty() {
            options.insert("checksum".to_string(), serde_json::json!(chk));
        }
    }
    if let Some(tries) = max_tries {
        options.insert("max-tries".to_string(), serde_json::json!(tries.to_string()));
    }

    let uris = collect_download_uris(&url, mirrors.as_deref());
    
    let _ = rpc_call(state_aria2_port, &state_aria2_secret, "aria2.addUri", serde_json::json!([uris, options])).await?;

    Ok(())
}

#[tauri::command]
async fn start_media_download(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    url: String,
    destination: String,
    filename: String,
    format_selector: Option<String>,
    cookie_source: Option<String>,
    speed_limit: Option<String>,
    username: Option<String>,
    password: Option<String>,
    headers: Option<String>,
    proxy: Option<String>,
    user_agent: Option<String>,
    max_tries: Option<i32>,
) -> Result<(), String> {
    let tasks_map = state.tasks.clone();
    let media_semaphore = state.media_semaphore.clone();

    // Mark task as queued
    tasks_map.lock().unwrap().insert(id.clone(), TaskHandle::Queued);

    let id_clone = id.clone();
    tauri::async_runtime::spawn(async move {
        // Wait in queue via semaphore
        let permit = media_semaphore.acquire().await;
        
        // Check if user cancelled the task while it was waiting in queue
        {
            let map = tasks_map.lock().unwrap();
            if !map.contains_key(&id_clone) {
                return;
            }
        }

        let _ = start_media_download_internal(
            app_handle,
            tasks_map,
            id_clone,
            url,
            destination,
            filename,
            format_selector,
            cookie_source,
            speed_limit,
            username,
            password,
            headers,
            proxy,
            user_agent,
            max_tries,
        ).await;
        
        drop(permit); // Release semaphore permit
    });

    Ok(())
}

pub(crate) async fn start_media_download_internal(
    app_handle: tauri::AppHandle,
    tasks_map: Arc<Mutex<HashMap<String, TaskHandle>>>,
    id: String,
    url: String,
    destination: String,
    filename: String,
    format_selector: Option<String>,
    cookie_source: Option<String>,
    speed_limit: Option<String>,
    username: Option<String>,
    password: Option<String>,
    headers: Option<String>,
    proxy: Option<String>,
    user_agent: Option<String>,
    max_tries: Option<i32>,
) -> Result<(), String> {
    println!("start_media_download called for id: {}", id);
    let resource_dir = app_handle.path().resource_dir().map_err(|e| e.to_string())?;
    let ytdlp_path = resource_dir.join("binaries").join("yt-dlp");
    let ffmpeg_path = resource_dir.join("binaries").join("ffmpeg");

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

    if !resolved_dest.exists() {
        let _ = std::fs::create_dir_all(&resolved_dest);
    }

    let out_path = resolved_dest.join(&filename);

    let total_tracks: f64 = if let Some(ref format) = format_selector {
        if format.contains('+') { 2.0 } else { 1.0 }
    } else {
        1.0
    };

    let mut cmd = AsyncCommand::new(&ytdlp_path);
    cmd.arg("--newline")
       .arg("--ffmpeg-location")
       .arg(&ffmpeg_path)
       .arg("--no-check-formats")
       .arg("--socket-timeout").arg("20")
       .arg("--retries").arg("3")
       .arg("--extractor-retries").arg("3")
       .arg("--downloader").arg("aria2c")
       .arg("--downloader-args").arg("aria2c:-x 16 -s 16 -k 1M")
       .arg("--concurrent-fragments").arg("4")
       .arg("-o").arg(out_path.to_string_lossy().to_string());

    if let Some(limit) = speed_limit {
        if !limit.is_empty() {
            cmd.arg("--limit-rate").arg(limit);
        }
    }

    if let Some(p) = proxy {
        if !p.is_empty() {
            cmd.arg("--proxy").arg(p);
        }
    }

    if let Some(mut cs) = cookie_source {
        if !cs.is_empty() && cs != "none" {
            if cs == "safari" { cs = "safari:".to_string() }
            cmd.arg("--cookies-from-browser").arg(cs);
        }
    }

    if let Some(ua) = user_agent {
        if !ua.is_empty() {
            cmd.arg("--user-agent").arg(ua);
        }
    }

    if let Some(tries) = max_tries {
        cmd.arg("--retries").arg(tries.to_string());
    }

    let mut config_file = tempfile::Builder::new().prefix("ytdlp-").suffix(".conf").tempfile().map_err(|e| e.to_string())?;
    let mut config_content = String::new();
    if let Some(user) = username {
        if !user.is_empty() {
            config_content.push_str(&format!("--username\n{}\n", user));
        }
    }
    if let Some(pass) = password {
        if !pass.is_empty() {
            config_content.push_str(&format!("--password\n{}\n", pass));
        }
    }
    if let Some(headers) = headers {
        for header in headers.lines().map(str::trim).filter(|header| !header.is_empty()) {
            config_content.push_str(&format!("--add-header\n{}\n", header));
        }
    }
    use std::io::Write;
    config_file.write_all(config_content.as_bytes()).map_err(|e| e.to_string())?;
    let config_path = config_file.into_temp_path();
    if !config_content.is_empty() {
        cmd.arg("--config-locations").arg(&config_path);
    }

    if let Some(format) = format_selector {
        cmd.arg("-f").arg(format);
        // If the filename implies an audio format, use it as audio output
        if filename.ends_with(".mp3") {
            cmd.arg("-x").arg("--audio-format").arg("mp3");
        } else if filename.ends_with(".m4a") {
            cmd.arg("-x").arg("--audio-format").arg("m4a");
        } else if filename.ends_with(".opus") {
            cmd.arg("-x").arg("--audio-format").arg("opus");
        } else {
            // Otherwise attempt to merge into mp4 or mkv based on filename
            if filename.ends_with(".mp4") {
                cmd.arg("--merge-output-format").arg("mp4");
            } else if filename.ends_with(".webm") {
                cmd.arg("--merge-output-format").arg("webm");
            } else {
                cmd.arg("--merge-output-format").arg("mkv");
            }
        }
    }

    cmd.arg(&url);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped()); // Also pipe stderr for better error reporting

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn yt-dlp: {}", e))?;
    let pid = child.id().unwrap_or(0);
    
    // Update task handle from Queued to Pid
    tasks_map.lock().unwrap().insert(id.clone(), TaskHandle::Pid(pid));

    let stdout = child.stdout.take().unwrap();
    let app_handle_clone = app_handle.clone();
    let id_clone = id.clone();

    // yt-dlp parsing regex
    let pct_re = Regex::new(r"\[download\]\s+(\d+(?:\.\d+)?)%").unwrap();
    let spd_re = Regex::new(r"at\s+([^\s]+)").unwrap();
    let eta_re = Regex::new(r"ETA\s+([^\s]+)").unwrap();

    tokio::spawn(async move {
        let _keep_alive = config_path; // Keep the temp file alive
        let mut reader = BufReader::new(stdout).lines();
        let mut current_track: f64 = 0.0;
        let mut last_fraction: f64 = 0.0;

        loop {
            tokio::select! {
                line_result = reader.next_line() => {
                    match line_result {
                        Ok(Some(line)) => {
                            if line.contains("[download]") && line.contains("%") {
                                let fraction = pct_re.captures(&line)
                                    .and_then(|cap| cap.get(1))
                                    .and_then(|m| m.as_str().parse::<f64>().ok())
                                    .unwrap_or(0.0) / 100.0;

                                if fraction < last_fraction && (last_fraction - fraction) > 0.5 {
                                    current_track += 1.0;
                                }
                                last_fraction = fraction;

                                let overall_fraction = ((current_track + fraction) / total_tracks).min(1.0);

                                let speed = spd_re.captures(&line)
                                    .and_then(|cap| cap.get(1))
                                    .map(|m| m.as_str().to_string())
                                    .unwrap_or_else(|| "-".to_string());

                                let eta = eta_re.captures(&line)
                                    .and_then(|cap| cap.get(1))
                                    .map(|m| m.as_str().to_string())
                                    .unwrap_or_else(|| "-".to_string());

                                let _ = app_handle_clone.emit("download-progress", DownloadProgressEvent {
                                    id: id_clone.clone(),
                                    fraction: overall_fraction,
                                    speed,
                                    eta,
                                });
                            }
                        }
                        _ => break,
                    }
                }
                status = child.wait() => {
                    println!("child exit status: {:?}", status);
                    if let Ok(exit_status) = status {
                        if exit_status.success() {
                            let _ = app_handle_clone.emit("download-complete", id_clone.clone());
                        } else {
                            // If it exited with error, emit failed
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
    let handle_opt = state.tasks.lock().unwrap().remove(&id);
    if let Some(handle) = handle_opt {
        match handle {
            TaskHandle::Aria2(gid) => {
                let _ = rpc_call(state.aria2_port, &state.aria2_secret, "aria2.pause", serde_json::json!([gid])).await;
            }
            TaskHandle::Queued => {
                // If it was just queued, it's already removed from tasks map.
                // The waiting Tokio task will wake up, see it's missing, and abort silently.
                println!("Queued download {} aborted before starting", id);
            }
            TaskHandle::Pid(pid) => {
                if pid > 0 {
                    use sysinfo::{System, Pid};
                    let mut sys = System::new_all();
                    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
                    
                    let parent_pid = Pid::from_u32(pid);
                    let mut to_kill = vec![parent_pid];
                    let mut idx = 0;
                    
                    while idx < to_kill.len() {
                        let current = to_kill[idx];
                        for (proc_pid, proc) in sys.processes() {
                            if let Some(p) = proc.parent() {
                                if p == current {
                                    to_kill.push(*proc_pid);
                                }
                            }
                        }
                        idx += 1;
                    }
                    
                    for p in to_kill.into_iter().rev() {
                        if let Some(proc) = sys.process(p) {
                            #[cfg(unix)]
                            {
                                if proc.kill_with(sysinfo::Signal::Term).is_none() {
                                    proc.kill(); // Fallback to SIGKILL
                                }
                            }
                            #[cfg(windows)]
                            proc.kill();
                            
                            println!("Sent termination signal to pid: {}", p.as_u32());
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn remove_download(state: tauri::State<'_, AppState>, id: String, filepath: Option<String>) -> Result<(), String> {
    println!("remove_download called for id: {}", id);
    
    // Check if it's aria2 first, so we can call remove instead of pause
    let mut is_aria2 = false;
    let mut gid_to_remove = String::new();
    if let Some(TaskHandle::Aria2(gid)) = state.tasks.lock().unwrap().get(&id) {
        is_aria2 = true;
        gid_to_remove = gid.clone();
    }
    
    if is_aria2 {
        state.tasks.lock().unwrap().remove(&id);
        let _ = rpc_call(state.aria2_port, &state.aria2_secret, "aria2.remove", serde_json::json!([gid_to_remove])).await;
    } else {
        let _ = pause_download(state, id).await;
    }
    
    if let Some(path) = filepath {
        if !path.is_empty() {
            let p = std::path::Path::new(&path);
            if p.exists() {
                let _ = std::fs::remove_file(p);
            }
            let aria2_path = format!("{}.aria2", path);
            let p_aria2 = std::path::Path::new(&aria2_path);
            if p_aria2.exists() {
                let _ = std::fs::remove_file(p_aria2);
            }
        }
    }
    
    Ok(())
}

#[tauri::command]
fn update_dock_badge(_app_handle: tauri::AppHandle, count: i32) {
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
                    tasks.insert("sleep_prevent".to_string(), TaskHandle::Pid(child.id()));
                }
            }
        } else {
            if let Some(TaskHandle::Pid(pid)) = tasks.remove("sleep_prevent") {
                let _ = std::process::Command::new("kill")
                    .arg("-15")
                    .arg(pid.to_string())
                    .status();
            }
        }
    }
}

#[tauri::command]
fn perform_system_action(action: String) -> Result<(), String> {
    let status = match action.as_str() {
        "shutdown" => std::process::Command::new("osascript").arg("-e").arg("tell app \"System Events\" to shut down").status(),
        "restart" => std::process::Command::new("osascript").arg("-e").arg("tell app \"System Events\" to restart").status(),
        "sleep" => std::process::Command::new("osascript").arg("-e").arg("tell app \"System Events\" to sleep").status(),
        _ => return Err("Invalid action".to_string())
    };

    match status {
        Ok(_) => Ok(()),
        Err(e) => Err(e.to_string())
    }
}

#[tauri::command]
async fn set_concurrent_limit(state: tauri::State<'_, AppState>, limit: usize) -> Result<(), String> {
    let _ = rpc_call(
        state.aria2_port,
        &state.aria2_secret,
        "aria2.changeGlobalOption",
        serde_json::json!([{"max-concurrent-downloads": limit.to_string()}])
    ).await;
    Ok(())
}

#[tauri::command]
async fn set_global_speed_limit(state: tauri::State<'_, AppState>, limit: Option<String>) -> Result<(), String> {
    let limit_str = limit.unwrap_or_else(|| "0".to_string());
    let _ = rpc_call(
        state.aria2_port,
        &state.aria2_secret,
        "aria2.changeGlobalOption",
        serde_json::json!([{"max-overall-download-limit": limit_str}])
    ).await;
    Ok(())
}

#[tauri::command]
fn request_automation_permission() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("osascript")
            .arg("-e")
            .arg("tell application \"Finder\" to get name")
            .status()
            .map_err(|error| error.to_string())?;
        return if status.success() {
            Ok(())
        } else {
            Err("Automation permission was not granted".to_string())
        };
    }

    #[cfg(not(target_os = "macos"))]
    Ok(())
}

#[tauri::command]
fn open_automation_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
            .status()
            .map_err(|error| error.to_string())?;
        return if status.success() {
            Ok(())
        } else {
            Err("Failed to open Automation settings".to_string())
        };
    }

    #[cfg(not(target_os = "macos"))]
    Err("Automation settings are only available on macOS".to_string())
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

#[tauri::command]
fn set_keychain_password(id: String, password: String) -> Result<(), String> {
    let entry = keyring::Entry::new("com.firelink.app", &id).map_err(|e| e.to_string())?;
    entry.set_password(&password).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_keychain_password(id: String) -> Result<String, String> {
    let entry = keyring::Entry::new("com.firelink.app", &id).map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_keychain_password(id: String) -> Result<(), String> {
    let entry = keyring::Entry::new("com.firelink.app", &id).map_err(|e| e.to_string())?;
    let _ = entry.delete_credential(); // Ignore error if it doesn't exist
    Ok(())
}

#[tauri::command]
fn check_file_exists(app_handle: tauri::AppHandle, path: String) -> bool {
    use tauri::Manager;
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
    resolved_dest.exists()
}

#[tauri::command]
fn delete_file(app_handle: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager;
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
    if resolved_dest.exists() {
        std::fs::remove_file(resolved_dest).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
fn toggle_tray_icon(app_handle: tauri::AppHandle, show: bool) -> Result<(), String> {
    use tauri::tray::TrayIconBuilder;
    use tauri::menu::{Menu, MenuItem};
    use tauri::Manager;

    if show {
        if app_handle.tray_by_id("main").is_none() {
            let quit_i = MenuItem::with_id(&app_handle, "quit", "Quit", true, None::<&str>).map_err(|e| e.to_string())?;
            let show_i = MenuItem::with_id(&app_handle, "show", "Show Firelink", true, None::<&str>).map_err(|e| e.to_string())?;
            let menu = Menu::with_items(&app_handle, &[&show_i, &quit_i]).map_err(|e| e.to_string())?;

            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/trayTemplate.png")).unwrap();
            let _tray = TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        std::process::exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(&app_handle)
                .map_err(|e| e.to_string())?;
        }
    } else {
        if let Some(_tray) = app_handle.tray_by_id("main") {
            let _ = app_handle.remove_tray_by_id("main");
        }
    }
    Ok(())
}

#[tauri::command]
fn set_extension_pairing_token(
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    if token.is_empty() || token.len() > 512 {
        return Err("Invalid extension pairing token".to_string());
    }

    let mut pairing_token = state
        .extension_pairing_token
        .write()
        .map_err(|_| "Extension pairing token lock is unavailable".to_string())?;
    *pairing_token = token;
    Ok(())
}

#[tauri::command]
fn set_extension_frontend_ready(
    state: tauri::State<'_, AppState>,
    ready: bool,
) {
    state
        .extension_frontend_ready
        .store(ready, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::collect_download_uris;

    #[test]
    fn collects_primary_url_and_unique_mirrors_in_order() {
        let uris = collect_download_uris(
            "https://primary.example/file.zip",
            Some(
                "\nhttps://mirror-one.example/file.zip\n\
                 https://primary.example/file.zip\n\
                 https://mirror-two.example/file.zip\n",
            ),
        );

        assert_eq!(
            uris,
            vec![
                "https://primary.example/file.zip",
                "https://mirror-one.example/file.zip",
                "https://mirror-two.example/file.zip",
            ]
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let extension_pairing_token = Arc::new(RwLock::new(String::new()));
    let server_pairing_token = extension_pairing_token.clone();
    let extension_frontend_ready = Arc::new(AtomicBool::new(false));
    let server_frontend_ready = extension_frontend_ready.clone();

    let aria2_port = std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(6800);
    let aria2_secret = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppState {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            extension_pairing_token,
            extension_frontend_ready,
            aria2_port,
            aria2_secret: aria2_secret.clone(),
            media_semaphore: Arc::new(tokio::sync::Semaphore::new(3)),
        })
        .setup(move |app| {
            let resource_dir = app.path().resource_dir().unwrap();
            let aria2c_path = resource_dir.join("binaries").join("aria2c");
            
            let mut cmd = std::process::Command::new(&aria2c_path);
            cmd.arg("--enable-rpc=true")
               .arg(format!("--rpc-listen-port={}", aria2_port))
               .arg(format!("--rpc-secret={}", aria2_secret))
               .arg("--rpc-listen-all=false")
               .arg("--continue=true")
               .arg("--allow-overwrite=false")
               .arg("--summary-interval=1")
               .arg("--console-log-level=warn")
               .arg("--download-result=hide")
               .arg("--check-certificate=false");

            match cmd.spawn() {
                Ok(_) => println!("Spawned global aria2c daemon on port {}", aria2_port),
                Err(e) => eprintln!("Failed to spawn aria2c daemon: {}", e),
            }

            let app_handle_clone = app.handle().clone();
            let aria2_port_clone = aria2_port;
            let aria2_secret_clone = aria2_secret.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                    
                    let state = app_handle_clone.state::<AppState>();
                    let tasks = state.tasks.clone();
                    
                    let mut gid_to_id = HashMap::new();
                    {
                        let map = tasks.lock().unwrap();
                        for (id, handle) in map.iter() {
                            if let TaskHandle::Aria2(gid) = handle {
                                gid_to_id.insert(gid.clone(), id.clone());
                            }
                        }
                    }

                    if let Ok(json) = crate::rpc_call(aria2_port_clone, &aria2_secret_clone, "aria2.tellActive", serde_json::json!([["gid", "status", "completedLength", "totalLength", "downloadSpeed"]])).await {
                        if let Some(arr) = json.get("result").and_then(|r| r.as_array()) {
                            for item in arr {
                                if let Some(gid) = item.get("gid").and_then(|v| v.as_str()) {
                                    if let Some(id) = gid_to_id.get(gid) {
                                        let completed = item.get("completedLength").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                                        let total = item.get("totalLength").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(1.0);
                                        let speed_bytes = item.get("downloadSpeed").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                                        
                                        let fraction = if total > 0.0 { completed / total } else { 0.0 };
                                        let speed = if speed_bytes > 1024.0 * 1024.0 {
                                            format!("{:.1} MB/s", speed_bytes / (1024.0 * 1024.0))
                                        } else if speed_bytes > 1024.0 {
                                            format!("{:.1} KB/s", speed_bytes / 1024.0)
                                        } else {
                                            format!("{:.0} B/s", speed_bytes)
                                        };

                                        let eta = if speed_bytes > 0.0 && total > completed {
                                            let seconds = (total - completed) / speed_bytes;
                                            if seconds > 3600.0 {
                                                format!("{:.0}h {:.0}m", seconds / 3600.0, (seconds % 3600.0) / 60.0)
                                            } else if seconds > 60.0 {
                                                format!("{:.0}m {:.0}s", seconds / 60.0, seconds % 60.0)
                                            } else {
                                                format!("{:.0}s", seconds)
                                            }
                                        } else {
                                            "-".to_string()
                                        };

                                        let _ = app_handle_clone.emit("download-progress", DownloadProgressEvent {
                                            id: id.clone(),
                                            fraction,
                                            speed,
                                            eta,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    
                    if let Ok(json) = crate::rpc_call(aria2_port_clone, &aria2_secret_clone, "aria2.tellStopped", serde_json::json!([0, 100, ["gid", "status", "completedLength", "totalLength"]])).await {
                        if let Some(arr) = json.get("result").and_then(|r| r.as_array()) {
                            for item in arr {
                                if let Some(gid) = item.get("gid").and_then(|v| v.as_str()) {
                                    if let Some(id) = gid_to_id.get(gid) {
                                        let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
                                        if status == "complete" {
                                            let _ = app_handle_clone.emit("download-complete", id.clone());
                                            tasks.lock().unwrap().remove(id);
                                        } else if status == "error" {
                                            let comp = item.get("completedLength").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                                            let tot = item.get("totalLength").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(1.0);
                                            if comp > 0.0 && comp >= tot {
                                                let _ = app_handle_clone.emit("download-complete", id.clone());
                                            } else {
                                                let _ = app_handle_clone.emit("download-failed", id.clone());
                                            }
                                            tasks.lock().unwrap().remove(id);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            });
            let ext_app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match extension_server::start_server(
                    ext_app_handle,
                    server_pairing_token.clone(),
                    server_frontend_ready.clone(),
                ).await {
                    Ok(()) => println!(
                        "Browser extension server listening on 127.0.0.1:{}",
                        extension_server::EXTENSION_SERVER_PORT
                    ),
                    Err(error) => eprintln!("Browser extension server unavailable: {error}"),
                }
            });
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            greet, test_ytdlp, test_aria2c, test_ffmpeg, test_deno, open_file, show_in_folder,
            start_download, start_media_download, pause_download, fetch_metadata, fetch_media_metadata,
            update_dock_badge, set_prevent_sleep, get_free_space, perform_system_action,
            request_automation_permission, open_automation_settings,
            set_keychain_password, get_keychain_password, delete_keychain_password,
            check_file_exists, delete_file, toggle_tray_icon, set_extension_pairing_token,
            set_extension_frontend_ready, set_concurrent_limit, set_global_speed_limit, remove_download,
            parity::get_system_proxy, parity::get_file_category, parity::check_for_updates, parity::is_supported_media
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
mod extension_server;

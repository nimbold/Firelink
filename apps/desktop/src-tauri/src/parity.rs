use serde::{Deserialize, Serialize};

#[tauri::command]
pub async fn get_system_proxy() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let output = Command::new("scutil").arg("--proxy").output().map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        let mut http_enable = false;
        let mut http_proxy = String::new();
        let mut http_port = String::new();
        let mut https_enable = false;
        let mut https_proxy = String::new();
        let mut https_port = String::new();

        for line in stdout.lines() {
            let parts: Vec<&str> = line.splitn(2, ':').collect();
            if parts.len() == 2 {
                let key = parts[0].trim();
                let value = parts[1].trim();
                match key {
                    "HTTPEnable" => http_enable = value == "1",
                    "HTTPProxy" => http_proxy = value.to_string(),
                    "HTTPPort" => http_port = value.to_string(),
                    "HTTPSEnable" => https_enable = value == "1",
                    "HTTPSProxy" => https_proxy = value.to_string(),
                    "HTTPSPort" => https_port = value.to_string(),
                    _ => {}
                }
            }
        }

        if https_enable && !https_proxy.is_empty() {
            return Ok(Some(format!("http://{}:{}", https_proxy, https_port))); // Often https proxy is HTTP
        } else if http_enable && !http_proxy.is_empty() {
            return Ok(Some(format!("http://{}:{}", http_proxy, http_port)));
        }
        Ok(None)
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let enable_output = Command::new("reg")
            .args(&["query", r#"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"#, "/v", "ProxyEnable"])
            .output();
        
        if let Ok(output) = enable_output {
            let enable_stdout = String::from_utf8_lossy(&output.stdout);
            if !enable_stdout.contains("0x1") {
                return Ok(None);
            }
        } else {
            return Ok(None);
        }

        let proxy_output = Command::new("reg")
            .args(&["query", r#"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"#, "/v", "ProxyServer"])
            .output();
            
        if let Ok(output) = proxy_output {
            let proxy_stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = proxy_stdout.lines().find(|l| l.contains("ProxyServer")) {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 {
                    let mut proxy = parts.last().unwrap().to_string();
                    if !proxy.starts_with("http") {
                        proxy = format!("http://{}", proxy);
                    }
                    return Ok(Some(proxy));
                }
            }
        }
        Ok(None)
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(proxy) = std::env::var("https_proxy") {
            if !proxy.is_empty() { return Ok(Some(proxy)); }
        }
        if let Ok(proxy) = std::env::var("HTTPS_PROXY") {
            if !proxy.is_empty() { return Ok(Some(proxy)); }
        }
        if let Ok(proxy) = std::env::var("http_proxy") {
            if !proxy.is_empty() { return Ok(Some(proxy)); }
        }
        if let Ok(proxy) = std::env::var("HTTP_PROXY") {
            if !proxy.is_empty() { return Ok(Some(proxy)); }
        }

        use std::process::Command;
        let mode_output = Command::new("gsettings")
            .args(&["get", "org.gnome.system.proxy", "mode"])
            .output();
            
        if let Ok(output) = mode_output {
            let mode = String::from_utf8_lossy(&output.stdout);
            if mode.contains("'manual'") {
                let https_host = Command::new("gsettings").args(&["get", "org.gnome.system.proxy.https", "host"]).output();
                let https_port = Command::new("gsettings").args(&["get", "org.gnome.system.proxy.https", "port"]).output();
                
                if let (Ok(h), Ok(p)) = (https_host, https_port) {
                    let host = String::from_utf8_lossy(&h.stdout).replace("'", "").trim().to_string();
                    let port = String::from_utf8_lossy(&p.stdout).trim().to_string();
                    if !host.is_empty() && port != "0" {
                        return Ok(Some(format!("https://{}:{}", host, port)));
                    }
                }
                
                let http_host = Command::new("gsettings").args(&["get", "org.gnome.system.proxy.http", "host"]).output();
                let http_port = Command::new("gsettings").args(&["get", "org.gnome.system.proxy.http", "port"]).output();
                
                if let (Ok(h), Ok(p)) = (http_host, http_port) {
                    let host = String::from_utf8_lossy(&h.stdout).replace("'", "").trim().to_string();
                    let port = String::from_utf8_lossy(&p.stdout).trim().to_string();
                    if !host.is_empty() && port != "0" {
                        return Ok(Some(format!("http://{}:{}", host, port)));
                    }
                }
            }
        }

        Ok(None)
    }
}

#[tauri::command]
pub fn get_file_category(filename: String) -> String {
    let ext = std::path::Path::new(&filename)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let music_exts = ["aac", "aif", "aiff", "alac", "amr", "ape", "au", "caf", "flac", "m4a", "m4b", "mid", "midi", "mp3", "oga", "ogg", "opus", "ra", "wav", "weba", "wma"];
    let movie_exts = ["3g2", "3gp", "avi", "divx", "f4v", "flv", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "mts", "ogm", "ogv", "rm", "rmvb", "ts", "vob", "webm", "wmv"];
    let compressed_exts = ["7z", "ace", "alz", "apk", "appx", "ar", "arc", "arj", "bz", "bz2", "cab", "cpio", "deb", "dmg", "gz", "gzip", "iso", "jar", "lha", "lzh", "lz", "lz4", "lzip", "lzma", "pak", "pkg", "rar", "rpm", "sit", "sitx", "tar", "tbz", "tbz2", "tgz", "tlz", "txz", "war", "whl", "xar", "xz", "z", "zip", "zipx", "zst"];
    let picture_exts = ["ai", "apng", "avif", "bmp", "cr2", "cr3", "dng", "emf", "eps", "gif", "heic", "heif", "ico", "indd", "jfif", "jpeg", "jpg", "jxl", "nef", "orf", "pbm", "pgm", "png", "pnm", "ppm", "psd", "raw", "rw2", "svg", "tga", "tif", "tiff", "webp", "wmf"];
    let document_exts = ["azw", "azw3", "csv", "djvu", "doc", "docm", "docx", "dot", "dotx", "epub", "fb2", "htm", "html", "ics", "key", "log", "md", "mobi", "pdf", "numbers", "odp", "ods", "odt", "pages", "pot", "potx", "pps", "ppsx", "ppt", "pptm", "pptx", "rtf", "tex", "txt", "vcf", "xls", "xlsm", "xlsx", "xml", "xps", "yaml", "yml"];

    if music_exts.contains(&ext.as_str()) {
        "musics".to_string()
    } else if movie_exts.contains(&ext.as_str()) {
        "movies".to_string()
    } else if compressed_exts.contains(&ext.as_str()) {
        "compressed".to_string()
    } else if picture_exts.contains(&ext.as_str()) {
        "pictures".to_string()
    } else if document_exts.contains(&ext.as_str()) {
        "documents".to_string()
    } else {
        "other".to_string()
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AvailableReleaseUpdate {
    pub version: String,
    pub tag_name: String,
    pub title: String,
    pub release_notes: String,
    pub release_url: String,
    pub published_at: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
pub enum ReleaseCheckOutcome {
    UpdateAvailable { update: AvailableReleaseUpdate },
    UpToDate { latest_version: String, local_version: String },
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
}

#[tauri::command]
pub async fn check_for_updates(app_handle: tauri::AppHandle) -> Result<ReleaseCheckOutcome, String> {
    let current_version = app_handle.package_info().version.to_string();
    
    let client = reqwest::Client::new();
    let res = client.get("https://api.github.com/repos/nimbold/Firelink/releases?per_page=30")
        .header("User-Agent", "Firelink")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("GitHub returned HTTP {}", res.status().as_u16()));
    }

    let releases: Vec<GitHubRelease> = res.json().await.map_err(|e| e.to_string())?;
    
    let latest_stable = releases.into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .max_by(|a, b| cmp_versions(&a.tag_name, &b.tag_name));
        
    let release = match latest_stable {
        Some(r) => r,
        None => return Err("No stable release was found.".to_string()),
    };

    let latest_version = release.tag_name.trim_start_matches(|c| c == 'v' || c == 'V').to_string();

    if cmp_versions(&latest_version, &current_version) == std::cmp::Ordering::Greater {
        Ok(ReleaseCheckOutcome::UpdateAvailable {
            update: AvailableReleaseUpdate {
                version: latest_version.clone(),
                tag_name: release.tag_name.clone(),
                title: release.name.unwrap_or(release.tag_name),
                release_notes: release.body.unwrap_or_else(|| "No release notes were provided for this version.".to_string()),
                release_url: release.html_url,
                published_at: release.published_at,
            }
        })
    } else {
        Ok(ReleaseCheckOutcome::UpToDate {
            latest_version,
            local_version: current_version,
        })
    }
}

fn cmp_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let a_clean = a.trim_start_matches(|c| c == 'v' || c == 'V');
    let b_clean = b.trim_start_matches(|c| c == 'v' || c == 'V');
    
    let a_parts: Vec<u32> = a_clean.split('.').filter_map(|s| s.parse().ok()).collect();
    let b_parts: Vec<u32> = b_clean.split('.').filter_map(|s| s.parse().ok()).collect();
    
    let len = std::cmp::max(a_parts.len(), b_parts.len());
    for i in 0..len {
        let a_val = a_parts.get(i).unwrap_or(&0);
        let b_val = b_parts.get(i).unwrap_or(&0);
        if a_val != b_val {
            return a_val.cmp(b_val);
        }
    }
    std::cmp::Ordering::Equal
}

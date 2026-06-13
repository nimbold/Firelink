use serde::{Deserialize, Serialize};

#[tauri::command]
pub async fn get_system_proxy() -> Result<Option<String>, String> {
    match sysproxy::Sysproxy::get_system_proxy() {
        Ok(proxy) => {
            if proxy.enable {
                // Determine protocol, usually sysproxy returns the host and port
                // We'll default to http:// unless the user has configured something specific
                Ok(Some(format!("http://{}:{}", proxy.host, proxy.port)))
            } else {
                Ok(None)
            }
        }
        Err(_) => Ok(None),
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
    use semver::Version;
    
    let a_clean = a.trim_start_matches(|c| c == 'v' || c == 'V');
    let b_clean = b.trim_start_matches(|c| c == 'v' || c == 'V');
    
    let a_ver = Version::parse(a_clean).unwrap_or_else(|_| Version::new(0, 0, 0));
    let b_ver = Version::parse(b_clean).unwrap_or_else(|_| Version::new(0, 0, 0));
    
    a_ver.cmp(&b_ver)
}

#[tauri::command]
pub fn is_supported_media(url: String) -> bool {
    if let Ok(parsed_url) = reqwest::Url::parse(&url) {
        if let Some(host) = parsed_url.host_str() {
            let host_lower = host.to_lowercase();
            let supported_domains = [
                "youtube.com", "youtu.be",
                "twitter.com", "x.com",
                "vimeo.com",
                "twitch.tv",
                "instagram.com",
                "tiktok.com",
                "facebook.com", "fb.watch",
                "reddit.com", "v.redd.it",
                "soundcloud.com"
            ];
            for domain in supported_domains.iter() {
                if host_lower == *domain || host_lower.ends_with(&format!(".{}", domain)) {
                    return true;
                }
            }
        }
    }
    false
}

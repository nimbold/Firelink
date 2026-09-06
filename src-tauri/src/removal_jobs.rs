//! Durable removal intent is independent of renderer download snapshots. Completed
//! jobs remain as tombstones, so an old save can never recreate a deleted UUID.
use crate::ipc::{DownloadAssetRemovalPolicy, DownloadRemovalJob, DownloadRemovalPhase as Phase};
use rusqlite::{params, Connection, OptionalExtension};
use tauri::{Emitter, Manager};

static WORKER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn jobs(connection: &Connection) -> Result<Vec<DownloadRemovalJob>, String> {
    let mut statement = connection
        .prepare("SELECT data FROM download_removal_jobs ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    })
    .collect()
}

fn save(connection: &Connection, job: &DownloadRemovalJob) -> Result<(), String> {
    connection.execute("INSERT INTO download_removal_jobs(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        params![job.id, serde_json::to_string(job).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn has_job(app: &tauri::AppHandle, id: &str) -> Result<bool, String> {
    let db = app.state::<crate::db::DbState>();
    let connection = db.lock()?;
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM download_removal_jobs WHERE id=?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(exists)
}

pub(crate) fn ensure_not_removing(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    if has_job(app, id)? {
        Err("Download removal is pending or requires retry".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn list_download_removals(
    caller: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Vec<DownloadRemovalJob>, String> {
    crate::properties_window::ensure_main_window(&caller)?;
    jobs(&*app.state::<crate::db::DbState>().lock()?)
}

#[tauri::command]
pub async fn submit_download_removals(
    caller: tauri::WebviewWindow,
    app: tauri::AppHandle,
    ids: Vec<String>,
    delete_assets: bool,
) -> Result<(), String> {
    crate::properties_window::ensure_main_window(&caller)?;
    // Fence each admission before recording intent, retaining all existing rows
    // and ownership records until physical cleanup has actually succeeded.
    let result = async {
        let state = app.state::<crate::AppState>();
        for id in ids {
            let _guard = state.queue_manager.acquire_aria2_control(&id).await;
            let job = {
                let db = app.state::<crate::db::DbState>();
                let connection = db.lock()?;
                let existing: Option<String> = connection
                    .query_row(
                        "SELECT data FROM download_removal_jobs WHERE id=?1",
                        [&id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                if existing.is_some() {
                    continue;
                }
                let exists: bool = connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM downloads WHERE id=?1)",
                        [&id],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if !exists {
                    return Err("Download is not durably saved".into());
                }
                let job = DownloadRemovalJob {
                    id: id.clone(),
                    revision: 1,
                    delete_assets,
                    phase: Phase::Pending,
                    error: None,
                };
                save(&connection, &job)?;
                job
            };
            state.queue_manager.remove_from_pending(&id).await;
            state.queue_manager.cancel_aria2_retries(&id).await;
            if state.queue_manager.is_waiting_to_seed(&id) {
                state.queue_manager.release_seed_tracking(&id);
            }
            let _ = app.emit("download-removal", &job);
        }
        Ok(())
    }
    .await;
    kick(&app);
    result
}

#[tauri::command]
pub fn resume_download_removals(
    caller: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    crate::properties_window::ensure_main_window(&caller)?;
    kick(&app);
    Ok(())
}

#[tauri::command]
pub fn retry_download_removal(
    caller: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    crate::properties_window::ensure_main_window(&caller)?;
    {
        let db = app.state::<crate::db::DbState>();
        let connection = db.lock()?;
        let mut job = jobs(&connection)?
            .into_iter()
            .find(|job| job.id == id)
            .ok_or("Removal job not found")?;
        if job.phase != Phase::Failed {
            return Ok(());
        }
        job.revision = job.revision.saturating_add(1);
        job.phase = Phase::Pending;
        job.error = None;
        save(&connection, &job)?;
        let _ = app.emit("download-removal", &job);
    }
    kick(&app);
    Ok(())
}

fn kick(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _worker = WORKER.lock().await;
        // Filesystem guards include synchronous platform APIs. Run the entire
        // cleanup on a blocking thread, with async RPC/timers using the runtime.
        let runtime = tokio::runtime::Handle::current();
        let result = tauri::async_runtime::spawn_blocking(move || runtime.block_on(run(app))).await;
        if !matches!(result, Ok(Ok(()))) {
            log::error!("download removal worker stopped; durable jobs retained for recovery");
        }
    });
}

async fn run(app: tauri::AppHandle) -> Result<(), String> {
    loop {
        let next = {
            let db = app.state::<crate::db::DbState>();
            let connection = db.lock()?;
            jobs(&connection)?
                .into_iter()
                .find(|job| matches!(job.phase, Phase::Pending | Phase::Running))
        };
        let Some(mut job) = next else {
            return Ok(());
        };
        job.revision = job.revision.saturating_add(1);
        job.phase = Phase::Running;
        let saved = app
            .state::<crate::db::DbState>()
            .lock()
            .and_then(|connection| save(&connection, &job));
        if let Err(error) = saved {
            emit_persistence_failure(&app, &mut job);
            return Err(error);
        }
        let _ = app.emit("download-removal", &job);
        let started = std::time::Instant::now();
        let result = crate::remove_download_inner(
            app.clone(),
            app.state::<crate::AppState>(),
            job.id.clone(),
            job.delete_assets,
            Some(false),
            Some(DownloadAssetRemovalPolicy::PermanentIfUnfinished),
            None,
            true,
        )
        .await;
        job.revision = job.revision.saturating_add(1);
        let committed = (|| -> Result<(), String> {
            let db = app.state::<crate::db::DbState>();
            let mut connection = db.lock()?;
            let tx = connection.transaction().map_err(|e| e.to_string())?;
            if result.is_ok() {
                tx.execute("DELETE FROM download_ownership WHERE id=?1", [&job.id])
                    .map_err(|e| e.to_string())?;
                tx.execute("DELETE FROM download_owned_paths WHERE id=?1", [&job.id])
                    .map_err(|e| e.to_string())?;
                tx.execute("DELETE FROM download_removal_paths WHERE id=?1", [&job.id])
                    .map_err(|e| e.to_string())?;
                tx.execute("DELETE FROM download_removal_assets WHERE id=?1", [&job.id])
                    .map_err(|e| e.to_string())?;
                tx.execute("DELETE FROM downloads WHERE id=?1", [&job.id])
                    .map_err(|e| e.to_string())?;
                job.phase = Phase::Completed;
                job.error = None;
            } else {
                job.phase = Phase::Failed;
                // Native errors can contain private paths. Keep only actionable,
                // safe UI guidance in the durable record and public event.
                job.error = Some("Removal could not finish. Close programs using the files, check drive access and permissions, then retry removal.".into());
            }
            save(&tx, &job)?;
            tx.commit().map_err(|e| e.to_string())
        })();
        if let Err(error) = committed {
            emit_persistence_failure(&app, &mut job);
            return Err(error);
        }
        log::info!(
            "download removal [id={} phase={:?} elapsed_ms={}]",
            job.id,
            job.phase,
            started.elapsed().as_millis()
        );
        let _ = app.emit("download-removal", &job);
    }
}

fn emit_persistence_failure(app: &tauri::AppHandle, job: &mut DownloadRemovalJob) {
    job.phase = Phase::Failed;
    job.error = Some(
        "Removal could not be saved. Check disk space and drive access, then retry removal.".into(),
    );
    let _ = app.emit("download-removal", &*job);
}

// Kept in a private table, never in shared IPC job data: paths and filesystem
// identities are authorization evidence, not diagnostic or presentation data.
type AssetManifest = std::collections::BTreeMap<std::path::PathBuf, String>;

fn snapshot_assets(roots: &[std::path::PathBuf]) -> Result<AssetManifest, String> {
    let mut pending = roots.to_vec();
    let mut manifest = AssetManifest::new();
    while let Some(path) = pending.pop() {
        if manifest.contains_key(&path) {
            continue;
        }
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Could not inspect removal assets".into()),
        };
        if crate::metadata_is_link_or_reparse(&metadata) || crate::path_has_symlink_component(&path)
        {
            return Err("Removal asset contains a symbolic link or reparse point".into());
        }
        let identity = crate::target_identity(&path, &metadata);
        if identity.starts_with("windows-path:") || identity == "portable" {
            return Err("Could not establish removal asset identity".into());
        }
        let signature = if metadata.is_dir() {
            // Directory mtime changes as its children are removed; identity and
            // birth time remain stable across partial cleanup and restart.
            pending.extend(
                std::fs::read_dir(&path)
                    .map_err(|_| "Could not inspect removal directory")?
                    .map(|entry| entry.map(|entry| entry.path()))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| "Could not inspect removal entry")?,
            );
            format!("dir:{identity}:{:?}", metadata.created().ok())
        } else if metadata.is_file() {
            format!(
                "file:{identity}:{:?}:{}:{}",
                metadata.created().ok(),
                metadata.len(),
                crate::target_modified(&metadata)
            )
        } else {
            return Err("Removal asset is not a regular file or directory".into());
        };
        manifest.insert(path, signature);
    }
    Ok(manifest)
}

fn validate_manifest(expected: &AssetManifest, current: &AssetManifest) -> Result<(), String> {
    // Missing entries are expected after interrupted cleanup. Newly created or
    // replaced entries never inherit authorization from the old path owner.
    if current
        .iter()
        .any(|(path, signature)| expected.get(path) != Some(signature))
    {
        return Err("Removal assets changed since cleanup began".into());
    }
    Ok(())
}

pub(crate) fn fence_assets(
    app: &tauri::AppHandle,
    id: &str,
    roots: &[std::path::PathBuf],
) -> Result<(), String> {
    let current = snapshot_assets(roots)?;
    let db = app.state::<crate::db::DbState>();
    let connection = db.lock()?;
    let previous: Option<String> = connection
        .query_row(
            "SELECT data FROM download_removal_assets WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(previous) = previous {
        validate_manifest(
            &serde_json::from_str(&previous).map_err(|_| "Invalid removal asset manifest")?,
            &current,
        )
    } else {
        connection
            .execute(
                "INSERT INTO download_removal_assets(id,data) VALUES(?1,?2)",
                params![
                    id,
                    serde_json::to_string(&current).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_cleanup_rejects_replacement_and_new_files() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let a = root.join("a");
        let b = root.join("b");
        std::fs::write(&a, b"original").unwrap();
        std::fs::write(&b, b"original").unwrap();
        let roots = vec![root.clone()];
        let manifest = snapshot_assets(&roots).unwrap();
        std::fs::remove_file(&a).unwrap();
        assert!(validate_manifest(&manifest, &snapshot_assets(&roots).unwrap()).is_ok());
        let replacement = root.join("replacement");
        std::fs::write(&replacement, b"replacement").unwrap();
        std::fs::rename(&replacement, &a).unwrap();
        assert!(validate_manifest(&manifest, &snapshot_assets(&roots).unwrap()).is_err());
        std::fs::remove_file(&a).unwrap();
        std::fs::write(directory.path().join("new"), b"unrelated").unwrap();
        assert!(validate_manifest(&manifest, &snapshot_assets(&roots).unwrap()).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn retry_allows_permission_repair_but_rejects_content_changes() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().canonicalize().unwrap().join("file");
        std::fs::write(&file, b"original").unwrap();
        let roots = vec![file.clone()];
        let manifest = snapshot_assets(&roots).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(validate_manifest(&manifest, &snapshot_assets(&roots).unwrap()).is_ok());
        std::fs::write(&file, b"changed content").unwrap();
        assert!(validate_manifest(&manifest, &snapshot_assets(&roots).unwrap()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn removal_manifest_does_not_follow_links() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::os::unix::fs::symlink(&root, root.join("link")).unwrap();
        assert!(snapshot_assets(&[root]).is_err());
    }
}

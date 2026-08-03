use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

const DATABASE_NAME: &str = "firelink.sqlite";
const LEGACY_STORE_NAME: &str = "store.bin";
const LEGACY_BUNDLE_IDENTIFIER: &str = "com.nima.tauri-app";
const CURRENT_SCHEMA_VERSION: i64 = 3;
pub(crate) const TOKEN_CHANGED_NOTICE: &str = "pairing-token-changed";
pub const PAIRING_TOKEN_KEYCHAIN_ID: &str = "extension-pairing-token";
// Development builds are a different executable identity from the packaged
// app. Keep their credentials separate so a debug binary cannot trigger an
// access prompt for, or reuse, the release app's Keychain item.
#[cfg(debug_assertions)]
const KEYCHAIN_SERVICE: &str = "com.firelink.app.dev";
#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "com.firelink.app";
static KEYRING_OPERATION_LOCK: Mutex<()> = Mutex::new(());

fn is_database_path(path: &Path) -> bool {
    path.file_name().is_some_and(|name| {
        name == DATABASE_NAME
            || name
                .to_string_lossy()
                .starts_with(&format!("{DATABASE_NAME}.backup-"))
    })
}

pub struct DbState {
    conn: Mutex<Connection>,
    portable: bool,
}

impl DbState {
    pub fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "persistence database lock is unavailable".to_string())
    }
}

#[derive(Default)]
struct LegacyData {
    settings: Option<String>,
    downloads: Vec<String>,
    queues: Vec<String>,
    ownership: Vec<(String, String)>,
    pairing_token: Option<String>,
}

pub fn init(storage_layout: &crate::storage::StorageLayout) -> Result<DbState, String> {
    init_at_path_internal(storage_layout.data_dir(), storage_layout.is_portable())
}

#[cfg(test)]
fn init_at_path(app_data_dir: &Path) -> Result<DbState, String> {
    init_at_path_internal(app_data_dir, false)
}

fn init_at_path_internal(
    app_data_dir: &Path,
    portable: bool,
) -> Result<DbState, String> {
    fs::create_dir_all(app_data_dir)
        .map_err(|error| format!("failed to create app data directory: {error}"))?;
    let database_path = app_data_dir.join(DATABASE_NAME);
    let existed = database_path.exists();
    let mut connection = Connection::open(&database_path)
        .map_err(|error| format!("failed to open database: {error}"))?;

    let version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|error| format!("failed to read database schema version: {error}"))?;
    // Portable mode intentionally does not create raw migration backups:
    // those backups would duplicate any legacy transfer secrets beside the
    // executable. The imported data is sanitized before the portable DB is
    // used, and any legacy source is sanitized in place after a successful
    // import so it cannot remain as an unsanitized sidecar.
    if existed && version < CURRENT_SCHEMA_VERSION && !portable {
        backup_database(&connection, &database_path, &format!("schema-v{version}"))?;
    }
    migrate_schema(&mut connection, version)?;

    import_legacy_data(&mut connection, app_data_dir, portable)?;
    if portable {
        sanitize_persisted_downloads(&mut connection)?;
    }

    Ok(DbState {
        conn: Mutex::new(connection),
        portable,
    })
}

impl DbState {
    pub fn is_portable(&self) -> bool {
        self.portable
    }
}

fn migrate_schema(connection: &mut Connection, from_version: i64) -> Result<(), String> {
    if from_version > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "database schema version {from_version} is newer than supported version {CURRENT_SCHEMA_VERSION}"
        ));
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin database migration: {error}"))?;

    if from_version < 1 {
        transaction
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS queues (
                    id TEXT PRIMARY KEY,
                    data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS download_ownership (
                    id TEXT PRIMARY KEY,
                    primary_path TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS download_owned_paths (
                    id TEXT PRIMARY KEY,
                    paths TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS migration_events (
                    key TEXT PRIMARY KEY,
                    consumed INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                ",
            )
            .map_err(|error| format!("failed to create persistence tables: {error}"))?;

        if table_exists(&transaction, "downloads")? {
            let queue_id_not_null = column_is_not_null(&transaction, "downloads", "queue_id")?;
            if queue_id_not_null {
                transaction
                    .execute_batch(
                        "
                        DROP TABLE IF EXISTS downloads_v0;
                        ALTER TABLE downloads RENAME TO downloads_v0;
                        CREATE TABLE downloads (
                            id TEXT PRIMARY KEY,
                            status TEXT NOT NULL,
                            queue_id TEXT,
                            data TEXT NOT NULL
                        );
                        INSERT INTO downloads (id, status, queue_id, data)
                            SELECT id, status, queue_id, data FROM downloads_v0;
                        DROP TABLE downloads_v0;
                        ",
                    )
                    .map_err(|error| format!("failed to migrate downloads table: {error}"))?;
            }
        } else {
            transaction
                .execute_batch(
                    "
                    CREATE TABLE downloads (
                        id TEXT PRIMARY KEY,
                        status TEXT NOT NULL,
                        queue_id TEXT,
                        data TEXT NOT NULL
                    );
                    ",
                )
                .map_err(|error| format!("failed to create downloads table: {error}"))?;
        }
    }

    if from_version < 2 {
        transaction
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS download_owned_paths (
                    id TEXT PRIMARY KEY,
                    paths TEXT NOT NULL
                );
                ",
            )
            .map_err(|error| format!("failed to migrate download ownership paths: {error}"))?;
    }

    if from_version < 3 {
        transaction
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS download_removal_paths (
                    id TEXT PRIMARY KEY,
                    paths TEXT NOT NULL
                );
                ",
            )
            .map_err(|error| format!("failed to migrate torrent removal paths: {error}"))?;
    }

    transaction
        .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)
        .map_err(|error| format!("failed to update database schema version: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit database migration: {error}"))
}

fn import_legacy_data(
    connection: &mut Connection,
    app_data_dir: &Path,
    portable: bool,
) -> Result<(), String> {
    let legacy_app_dir = app_data_dir
        .parent()
        .map(|parent| parent.join(LEGACY_BUNDLE_IDENTIFIER));
    let candidates = [
        Some(app_data_dir.join(LEGACY_STORE_NAME)),
        legacy_app_dir.as_ref().map(|dir| dir.join(DATABASE_NAME)),
        legacy_app_dir
            .as_ref()
            .map(|dir| dir.join(LEGACY_STORE_NAME)),
    ];

    for candidate in candidates.into_iter().flatten() {
        if !candidate.exists() {
            continue;
        }
        let marker = format!("legacy-import:{}", candidate.to_string_lossy());
        if metadata_exists(connection, &marker)? {
            sanitize_legacy_source(&candidate, !portable)?;
            continue;
        }
        let backup = if !portable {
            Some(backup_file(&candidate, "legacy-import")?)
        } else {
            None
        };
        let mut legacy = if candidate
            .file_name()
            .is_some_and(|name| name == DATABASE_NAME)
        {
            read_legacy_database(&candidate, !portable)?
        } else {
            read_legacy_store(&candidate, !portable)?
        };
        let mut pending_pairing_token = None;
        if !portable {
            if let Some(token) = legacy.pairing_token.take() {
                // Legacy migration is deliberately deferred until the
                // explicit frontend consent action. Database initialization
                // must never touch the OS credential store.
                pending_pairing_token = Some(token);
            }
        }
        if portable {
            // Sanitize before importing as well as sanitizing the legacy
            // source afterward. A crash between those two operations must
            // not leave raw transfer credentials in the portable database.
            sanitize_download_strings(&mut legacy.downloads)?;
        }
        merge_legacy_data(connection, legacy)?;
        if let Some(token) = pending_pairing_token {
            if load_pairing_token_from_settings(connection)?.is_none() {
                save_pairing_token_to_settings(connection, &token, true)?;
            }
        }
        if let Some(backup) = backup.as_deref() {
            sanitize_legacy_source(backup, !portable)?;
        }
        sanitize_legacy_source(&candidate, !portable)?;
        connection
            .execute(
                "INSERT INTO metadata (key, value) VALUES (?1, 'complete')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![marker],
            )
            .map_err(|error| format!("failed to record legacy import: {error}"))?;
    }
    Ok(())
}

fn sanitize_legacy_source(path: &Path, remove_pairing_token: bool) -> Result<(), String> {
    if is_database_path(path) {
        let mut connection = Connection::open(path).map_err(|error| {
            format!(
                "failed to open legacy database '{}' for sanitization: {error}",
                path.display()
            )
        })?;
        if remove_pairing_token && table_exists(&connection, "settings")? {
            if let Some(settings) = connection
                .query_row("SELECT data FROM settings WHERE id = 1", [], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
                .map_err(|error| format!("failed to read legacy settings for sanitization: {error}"))?
            {
                let sanitized = strip_pairing_token_from_settings(&settings)?;
                connection
                    .execute(
                        "UPDATE settings SET data = ?1 WHERE id = 1",
                        params![sanitized],
                    )
                    .map_err(|error| format!("failed to sanitize legacy settings: {error}"))?;
            }
        }
        if table_exists(&connection, "downloads")? {
            sanitize_persisted_downloads(&mut connection)?;
        }
        return Ok(());
    }

    let text = fs::read_to_string(path).map_err(|error| {
        format!(
            "failed to read legacy store '{}' for sanitization: {error}",
            path.display()
        )
    })?;
    let mut document: Value = serde_json::from_str(&text).map_err(|error| {
        format!(
            "failed to decode legacy store '{}' for sanitization: {error}",
            path.display()
        )
    })?;
    if remove_pairing_token {
        if let Some(settings) = document.get_mut("settings") {
            let was_string = settings.is_string();
            let (sanitized, _, _) = sanitize_settings_value(settings, true)?;
            *settings = if was_string {
                Value::String(sanitized)
            } else {
                serde_json::from_str(&sanitized).map_err(|error| {
                    format!("failed to decode sanitized legacy settings: {error}")
                })?
            };
        }
    }
    if let Some(downloads) = document
        .get_mut("download_queue")
        .and_then(Value::as_array_mut)
    {
        for download in downloads {
            remove_persisted_transfer_secrets(download);
        }
    }
    write_sanitized_legacy_store(path, &text, &document)
}

fn write_sanitized_legacy_store(
    path: &Path,
    original: &str,
    document: &Value,
) -> Result<(), String> {
    let sanitized = serde_json::to_string(&document).map_err(|error| {
        format!(
            "failed to encode legacy store '{}' for sanitization: {error}",
            path.display()
        )
    })?;
    if sanitized == original {
        return Ok(());
    }

    let parent = path
        .parent()
        .ok_or_else(|| format!("legacy store path has no parent: '{}'", path.display()))?;
    use std::io::Write;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|error| {
        format!(
            "failed to create temporary sanitized legacy store beside '{}': {error}",
            path.display()
        )
    })?;
    temporary
        .write_all(sanitized.as_bytes())
        .and_then(|_| temporary.flush())
        .map_err(|error| {
            format!(
                "failed to write temporary sanitized legacy store beside '{}': {error}",
                path.display()
            )
        })?;
    temporary.persist(path).map_err(|error| {
        format!(
            "failed to replace legacy store '{}' without losing the original: {}",
            path.display(), error.error
        )
    })?;
    Ok(())
}

fn merge_legacy_data(connection: &mut Connection, legacy: LegacyData) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin legacy import: {error}"))?;

    let has_settings = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE id = 1)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("failed to inspect persisted settings: {error}"))?;
    if !has_settings {
        if let Some(settings) = legacy.settings {
            save_settings_tx(&transaction, &settings)?;
        }
    }

    let download_count: i64 = transaction
        .query_row("SELECT COUNT(*) FROM downloads", [], |row| row.get(0))
        .map_err(|error| format!("failed to inspect persisted downloads: {error}"))?;
    if download_count == 0 {
        replace_downloads_tx(&transaction, &legacy.downloads)?;
    }

    let queue_count: i64 = transaction
        .query_row("SELECT COUNT(*) FROM queues", [], |row| row.get(0))
        .map_err(|error| format!("failed to inspect persisted queues: {error}"))?;
    if queue_count == 0 {
        replace_queues_tx(&transaction, &legacy.queues)?;
    }

    for (id, primary_path) in legacy.ownership {
        transaction
            .execute(
                "INSERT OR IGNORE INTO download_ownership (id, primary_path) VALUES (?1, ?2)",
                params![id, primary_path],
            )
            .map_err(|error| format!("failed to import download ownership: {error}"))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("failed to commit legacy import: {error}"))?;

    Ok(())
}

fn read_legacy_store(path: &Path, force_migrate: bool) -> Result<LegacyData, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("failed to read legacy store '{}': {error}", path.display()))?;
    let document: Value = serde_json::from_str(&text).map_err(|error| {
        format!(
            "failed to decode legacy store '{}': {error}",
            path.display()
        )
    })?;

    let mut data = LegacyData::default();
    if let Some(settings) = document.get("settings") {
        let (sanitized, token, _) = sanitize_settings_value(settings, force_migrate)?;
        data.settings = Some(sanitized);
        data.pairing_token = token;
    }
    data.downloads = json_array_as_strings(document.get("download_queue"))?;
    data.queues = json_array_as_strings(document.get("queues"))?;
    data.ownership = document
        .get("download_ownership")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|record| {
            Some((
                record.get("id")?.as_str()?.to_string(),
                record.get("primaryPath")?.as_str()?.to_string(),
            ))
        })
        .collect();
    Ok(data)
}

fn read_legacy_database(path: &Path, force_migrate: bool) -> Result<LegacyData, String> {
    let connection = Connection::open(path).map_err(|error| {
        format!(
            "failed to open legacy database '{}': {error}",
            path.display()
        )
    })?;
    let mut data = LegacyData::default();

    if table_exists(&connection, "settings")? {
        if let Some(settings) = connection
            .query_row("SELECT data FROM settings WHERE id = 1", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .map_err(|error| format!("failed to read legacy settings: {error}"))?
        {
            let (sanitized, token, _) = sanitize_settings_text(&settings, force_migrate)?;
            data.settings = Some(sanitized);
            data.pairing_token = token;
        }
    }
    if table_exists(&connection, "downloads")? {
        data.downloads = query_string_column(&connection, "SELECT data FROM downloads")?;
    }
    if table_exists(&connection, "queues")? {
        data.queues = query_string_column(&connection, "SELECT data FROM queues")?;
    }
    Ok(data)
}

fn sanitize_settings_value(
    value: &Value,
    force_migrate: bool,
) -> Result<(String, Option<String>, bool), String> {
    match value {
        Value::String(text) => sanitize_settings_text(text, force_migrate),
        _ => sanitize_settings_document(value.clone(), force_migrate),
    }
}

fn sanitize_settings_text(
    text: &str,
    force_migrate: bool,
) -> Result<(String, Option<String>, bool), String> {
    let document: Value = serde_json::from_str(text)
        .map_err(|error| format!("failed to decode persisted settings: {error}"))?;
    sanitize_settings_document(document, force_migrate)
}

fn sanitize_settings_document(
    mut document: Value,
    force_migrate: bool,
) -> Result<(String, Option<String>, bool), String> {
    let state_value = if document.get("state").is_some() {
        document
            .get_mut("state")
            .ok_or_else(|| "persisted settings state is missing".to_string())?
    } else {
        &mut document
    };
    let state = state_value
        .as_object_mut()
        .ok_or_else(|| "persisted settings state must be an object".to_string())?;

    let keychain_granted = state
        .get("keychainAccessGranted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let should_migrate = force_migrate || keychain_granted;

    let token = if should_migrate {
        state
            .remove("extensionPairingToken")
            .and_then(|value| value.as_str().map(str::to_string))
    } else {
        None
    };

    let serialized = serde_json::to_string(&document)
        .map_err(|error| format!("failed to encode persisted settings: {error}"))?;
    Ok((serialized, token, keychain_granted))
}

fn json_array_as_strings(value: Option<&Value>) -> Result<Vec<String>, String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    serde_json::to_string(item)
                        .map_err(|error| format!("failed to encode legacy item: {error}"))
                })
                .collect()
        })
        .unwrap_or_else(|| Ok(Vec::new()))
}

fn query_string_column(connection: &Connection, query: &str) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(query)
        .map_err(|error| format!("failed to prepare legacy query: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query legacy data: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read legacy data: {error}"))
}

fn backup_file(path: &Path, reason: &str) -> Result<PathBuf, String> {
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid persistence file path '{}'", path.display()))?;
    let backup_prefix = format!("{file_name}.backup-{reason}-");
    if let Some(existing) = path.parent().and_then(|parent| {
        fs::read_dir(parent).ok()?.flatten().find_map(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(&backup_prefix)
                .then_some(entry.path())
        })
    }) {
        return Ok(existing);
    }
    let backup_path = path.with_file_name(format!("{file_name}.backup-{reason}-{timestamp}"));
    if backup_path.exists() {
        return Ok(backup_path);
    }
    fs::copy(path, &backup_path).map_err(|error| {
        format!(
            "failed to back up persistence file '{}' to '{}': {error}",
            path.display(),
            backup_path.display()
        )
    })?;
    Ok(backup_path)
}

fn backup_database(connection: &Connection, path: &Path, reason: &str) -> Result<PathBuf, String> {
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid database path '{}'", path.display()))?;
    let backup_path = path.with_file_name(format!("{file_name}.backup-{reason}-{timestamp}"));
    connection
        .execute("VACUUM INTO ?1", params![backup_path.to_string_lossy()])
        .map_err(|error| {
            format!(
                "failed to back up database '{}' to '{}': {error}",
                path.display(),
                backup_path.display()
            )
        })?;
    Ok(backup_path)
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            params![table],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to inspect database table '{table}': {error}"))
}

fn metadata_exists(connection: &Connection, key: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM metadata WHERE key = ?1)",
            params![key],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to inspect migration metadata: {error}"))
}

fn column_is_not_null(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("failed to inspect table '{table}': {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, bool>(3)?))
        })
        .map_err(|error| format!("failed to inspect table '{table}': {error}"))?;
    for row in rows {
        let (name, not_null) =
            row.map_err(|error| format!("failed to inspect table '{table}': {error}"))?;
        if name == column {
            return Ok(not_null);
        }
    }
    Ok(false)
}

pub fn load_settings(connection: &Connection) -> Result<Option<String>, String> {
    connection
        .query_row("SELECT data FROM settings WHERE id = 1", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| format!("failed to load settings: {error}"))
}

#[allow(dead_code)]
pub fn is_keychain_access_granted(connection: &Connection) -> Result<bool, String> {
    let Some(settings) = load_settings(connection)? else {
        return Ok(false);
    };
    let document: Value = serde_json::from_str(&settings)
        .map_err(|error| format!("failed to decode settings: {error}"))?;
    let granted = document
        .get("state")
        .and_then(|s| s.get("keychainAccessGranted"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(granted)
}

pub fn save_settings(connection: &Connection, data: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO settings (id, data) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![data],
        )
        .map_err(|error| format!("failed to save settings: {error}"))?;
    Ok(())
}

fn settings_state_mut(
    document: &mut Value,
) -> Result<&mut serde_json::Map<String, Value>, String> {
    if document.get("state").is_some() {
        document
            .get_mut("state")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "persisted settings state must be an object".to_string())
    } else {
        document
            .as_object_mut()
            .ok_or_else(|| "persisted settings must be an object".to_string())
    }
}

fn add_site_login_to_settings(
    data: &str,
    id: &str,
    url_pattern: &str,
    username: &str,
) -> Result<String, String> {
    let mut document: Value = serde_json::from_str(data)
        .map_err(|error| format!("failed to decode settings: {error}"))?;
    let state = settings_state_mut(&mut document)?;
    let logins = state
        .entry("siteLogins")
        .or_insert_with(|| Value::Array(Vec::new()));
    let logins = logins
        .as_array_mut()
        .ok_or_else(|| "persisted site logins must be an array".to_string())?;
    if logins.iter().any(|login| {
        login
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|existing_id| existing_id == id)
    }) {
        return Err("site login already exists".to_string());
    }
    logins.push(serde_json::json!({
        "id": id,
        "urlPattern": url_pattern,
        "username": username,
    }));
    serde_json::to_string(&document)
        .map_err(|error| format!("failed to encode settings: {error}"))
}

fn remove_site_login_from_settings(
    data: &str,
    id: &str,
) -> Result<(String, bool), String> {
    let mut document: Value = serde_json::from_str(data)
        .map_err(|error| format!("failed to decode settings: {error}"))?;
    let state = settings_state_mut(&mut document)?;
    let Some(logins) = state.get_mut("siteLogins") else {
        return Ok((data.to_string(), false));
    };
    let logins = logins
        .as_array_mut()
        .ok_or_else(|| "persisted site logins must be an array".to_string())?;
    let original_len = logins.len();
    logins.retain(|login| {
        login
            .get("id")
            .and_then(Value::as_str)
            .is_none_or(|existing_id| existing_id != id)
    });
    if logins.len() == original_len {
        return Ok((data.to_string(), false));
    }
    let updated = serde_json::to_string(&document)
        .map_err(|error| format!("failed to encode settings: {error}"))?;
    Ok((updated, true))
}

fn validate_site_login_id(id: &str) -> Result<&str, String> {
    let trimmed = id.trim();
    if trimmed.is_empty()
        || trimmed != id
        || trimmed == PAIRING_TOKEN_KEYCHAIN_ID
    {
        return Err("invalid site login identifier".to_string());
    }
    Ok(trimmed)
}

fn validate_site_login_input(
    id: &str,
    url_pattern: &str,
    username: &str,
    password: &str,
) -> Result<(), String> {
    validate_site_login_id(id)?;
    if url_pattern.trim().is_empty() || url_pattern.chars().any(char::is_whitespace) {
        return Err("site login URL pattern must be non-empty and contain no whitespace".to_string());
    }
    if username.trim().is_empty() {
        return Err("site login username must be non-empty".to_string());
    }
    if password.is_empty() {
        return Err("site login password must be non-empty".to_string());
    }
    Ok(())
}

pub fn save_site_login(
    connection: &Connection,
    id: &str,
    url_pattern: &str,
    username: &str,
    password: &str,
) -> Result<(), String> {
    validate_site_login_input(id, url_pattern, username, password)?;
    let id = validate_site_login_id(id)?;
    let _keyring_guard = lock_keyring_operations()?;
    let original = load_settings(connection)?.unwrap_or_else(|| {
        // A first-run standard-mode install can grant keychain access before
        // any frontend setting has been persisted. Start with a valid
        // Zustand envelope so the first site login is not rejected.
        serde_json::json!({ "state": {}, "version": 3 }).to_string()
    });
    if get_keychain_password_if_present_unlocked(id)?.is_some() {
        return Err("a credential already exists for this site login".to_string());
    }
    let updated = add_site_login_to_settings(&original, id, url_pattern, username)?;

    // Persist metadata before creating the secret. If the credential-store
    // write fails, restore the exact previous settings document so a failed
    // add cannot leave an orphaned keychain entry or a visible login row.
    save_settings(connection, &updated)?;
    if let Err(error) = set_keychain_password_unlocked(id, password) {
        let keychain_rollback = delete_keychain_password_unlocked(id);
        let settings_rollback = save_settings(connection, &original);
        if let Err(rollback_error) = keychain_rollback {
            return Err(format!(
                "failed to save site login credential: {error}; credential rollback also failed: {rollback_error}"
            ));
        }
        if let Err(rollback_error) = settings_rollback {
            return Err(format!(
                "failed to save site login credential: {error}; settings rollback also failed: {rollback_error}"
            ));
        }
        return Err(format!("failed to save site login credential: {error}"));
    }
    Ok(())
}

pub fn delete_site_login(connection: &Connection, id: &str) -> Result<(), String> {
    let id = validate_site_login_id(id)?;
    let _keyring_guard = lock_keyring_operations()?;
    let Some(original) = load_settings(connection)? else {
        return Err("settings are not persisted yet".to_string());
    };
    let (updated, removed) = remove_site_login_from_settings(&original, id)?;
    if !removed {
        return Err("site login was not found".to_string());
    }
    let _existing_password = get_keychain_password_if_present_unlocked(id)?;

    // Remove the metadata first only after the keychain has been checked. If
    // deleting the secret fails, restore the metadata so the UI cannot lose a
    // credential that still exists.
    save_settings(connection, &updated)?;
    if let Err(error) = delete_keychain_password_unlocked(id) {
        if matches!(
            get_keychain_password_if_present_unlocked(id),
            Ok(None)
        ) {
            return Ok(());
        }
        if let Err(rollback_error) = save_settings(connection, &original) {
            return Err(format!(
                "failed to delete site login credential: {error}; settings rollback also failed: {rollback_error}"
            ));
        }
        return Err(format!("failed to delete site login credential: {error}"));
    }

    Ok(())
}

fn save_settings_tx(transaction: &Transaction<'_>, data: &str) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO settings (id, data) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![data],
        )
        .map_err(|error| format!("failed to import settings: {error}"))?;
    Ok(())
}

pub fn load_downloads(connection: &Connection) -> Result<Vec<String>, String> {
    query_string_column(connection, "SELECT data FROM downloads ORDER BY rowid")
}

pub fn replace_downloads(
    connection: &mut Connection,
    data: &str,
    portable: bool,
) -> Result<(), String> {
    let values: Vec<Value> = serde_json::from_str(data)
        .map_err(|error| format!("failed to decode downloads: {error}"))?;
    let strings = values
        .into_iter()
        .map(|mut value| {
            if portable {
                remove_persisted_transfer_secrets(&mut value);
            }
            serde_json::to_string(&value)
                .map_err(|error| format!("failed to encode download: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin download save: {error}"))?;
    replace_downloads_tx(&transaction, &strings)?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit download save: {error}"))
}

fn remove_persisted_transfer_secrets(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };

    // These values are accepted from users, browser extensions, or URLs and
    // may contain credentials or bearer tokens. Portable queues keep their
    // useful metadata, but never persist these values beside the executable.
    let mut removed_transfer_context = false;
    for key in ["password", "cookies", "headers", "mirrors", "proxy"] {
        if object
            .get(key)
            .is_some_and(|value| !value.is_null() && !value_is_empty(value))
        {
            removed_transfer_context = true;
        }
        object.remove(key);
    }

    if let Some(last_error) = object.get("lastError").and_then(Value::as_str) {
        object.insert(
            "lastError".to_string(),
            Value::String(crate::redact_sensitive_text(last_error)),
        );
    }

    sanitize_portable_torrent_trackers(object);
    sanitize_portable_torrent_exclude_trackers(object);

    if let Some(url) = object.get("url").and_then(Value::as_str) {
        if let Ok(mut parsed) = url::Url::parse(url) {
            let had_userinfo = !parsed.username().is_empty() || parsed.password().is_some();
            if parsed.scheme() == "magnet" {
                let mut serializer = url::form_urlencoded::Serializer::new(String::new());
                let mut retained_info_hash = false;
                let mut removed_query_context = false;
                for (key, value) in parsed.query_pairs() {
                    if key == "xt" || key == "dn" {
                        retained_info_hash |= key == "xt";
                        serializer.append_pair(&key, &value);
                    } else {
                        removed_query_context = true;
                    }
                }
                let removed_fragment = parsed.fragment().is_some();
                let safe_query = serializer.finish();
                let _ = parsed.set_username("");
                let _ = parsed.set_password(None);
                parsed.set_query((!safe_query.is_empty()).then_some(safe_query.as_str()));
                parsed.set_fragment(None);
                object.insert("url".to_string(), Value::String(parsed.to_string()));
                if had_userinfo || removed_query_context || removed_fragment || !retained_info_hash {
                    mark_portable_download_unresumable(object);
                }
            } else {
                let had_query_or_fragment = parsed.query().is_some() || parsed.fragment().is_some();
                if had_userinfo || had_query_or_fragment {
                    let _ = parsed.set_username("");
                    let _ = parsed.set_password(None);
                    parsed.set_query(None);
                    parsed.set_fragment(None);
                    object.insert("url".to_string(), Value::String(parsed.to_string()));

                    // A queued transfer whose URL depended on query/fragment
                    // credentials must not silently auto-resume with a truncated
                    // URL after a portable restart.
                    if had_userinfo || had_query_or_fragment {
                        mark_portable_download_unresumable(object);
                    }
                }
            }
        } else {
            object.insert("url".to_string(), Value::String(String::new()));
            mark_portable_download_unresumable(object);
        }
    }

    // Do not silently resume a queued transfer after removing request
    // credentials or other transfer-specific context. The URL may still be
    // valid, but its semantics have changed and the user must re-add it with
    // the required request settings.
    if removed_transfer_context {
        mark_portable_download_unresumable(object);
    }
}

fn sanitize_portable_torrent_tracker_field(
    object: &mut serde_json::Map<String, Value>,
    key: &str,
    normalize: fn(Option<&str>) -> Result<Option<String>, String>,
) {
    let Some(raw_value) = object.get(key).cloned() else {
        return;
    };
    let Some(raw) = raw_value.as_str().map(str::to_string) else {
        object.remove(key);
        mark_portable_download_unresumable(object);
        return;
    };
    let raw = raw.trim();
    if raw.is_empty() {
        object.remove(key);
        return;
    }
    let Some(normalized) = normalize(Some(raw)).ok().flatten() else {
        object.remove(key);
        mark_portable_download_unresumable(object);
        return;
    };

    let mut sanitized = Vec::new();
    let mut removed_context = false;
    for token in normalized.split(',') {
        if token == "*" {
            sanitized.push(token.to_string());
            continue;
        }
        let Ok(mut parsed) = url::Url::parse(token) else {
            object.remove(key);
            mark_portable_download_unresumable(object);
            return;
        };
        let had_context = !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some();
        if had_context {
            let _ = parsed.set_username("");
            let _ = parsed.set_password(None);
            parsed.set_query(None);
            parsed.set_fragment(None);
            removed_context = true;
        }
        sanitized.push(parsed.to_string());
    }

    if sanitized.is_empty() {
        object.remove(key);
    } else {
        object.insert(key.to_string(), Value::String(sanitized.join(",")));
    }
    if removed_context {
        mark_portable_download_unresumable(object);
    }
}

fn sanitize_portable_torrent_trackers(object: &mut serde_json::Map<String, Value>) {
    sanitize_portable_torrent_tracker_field(
        object,
        "torrentTrackers",
        crate::queue::normalize_torrent_trackers,
    );
}

fn sanitize_portable_torrent_exclude_trackers(object: &mut serde_json::Map<String, Value>) {
    sanitize_portable_torrent_tracker_field(
        object,
        "torrentExcludeTrackers",
        crate::queue::normalize_torrent_exclude_trackers,
    );
}

fn value_is_empty(value: &Value) -> bool {
    value.as_str().is_some_and(str::is_empty)
        || value.as_array().is_some_and(Vec::is_empty)
        || value.as_object().is_some_and(serde_json::Map::is_empty)
}

fn mark_portable_download_unresumable(object: &mut serde_json::Map<String, Value>) {
    if object
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status != "completed")
    {
        object.insert("status".to_string(), Value::String("failed".to_string()));
        object.insert("resumable".to_string(), Value::Bool(false));
        object.insert(
            "lastError".to_string(),
            Value::String(
                "Portable mode removed credentials or transfer settings from this persisted download; add it again to resume."
                    .to_string(),
            ),
        );
    }
}

fn sanitize_download_strings(downloads: &mut [String]) -> Result<(), String> {
    for data in downloads {
        let mut value: Value = serde_json::from_str(data).map_err(|error| {
            format!("failed to decode download for portable sanitization: {error}")
        })?;
        remove_persisted_transfer_secrets(&mut value);
        *data = serde_json::to_string(&value).map_err(|error| {
            format!("failed to encode download for portable sanitization: {error}")
        })?;
    }
    Ok(())
}

fn sanitize_persisted_downloads(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin portable download sanitization: {error}"))?;
    let records = {
        let mut statement = transaction
            .prepare("SELECT id, data FROM downloads")
            .map_err(|error| {
                format!("failed to prepare portable download sanitization: {error}")
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| {
                format!("failed to read downloads for portable sanitization: {error}")
            })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
            format!("failed to read download for portable sanitization: {error}")
        })?
    };

    for (id, data) in records {
        let mut value: Value = serde_json::from_str(&data).map_err(|error| {
            format!("failed to decode download '{id}' for portable sanitization: {error}")
        })?;
        remove_persisted_transfer_secrets(&mut value);
        let sanitized = serde_json::to_string(&value).map_err(|error| {
            format!("failed to encode download '{id}' for portable sanitization: {error}")
        })?;
        if sanitized != data {
            transaction
                .execute(
                    "UPDATE downloads SET data = ?1 WHERE id = ?2",
                    params![sanitized, id],
                )
                .map_err(|error| format!("failed to sanitize download '{id}': {error}"))?;
        }
    }

    transaction
        .commit()
        .map_err(|error| format!("failed to commit portable download sanitization: {error}"))
}

fn replace_downloads_tx(transaction: &Transaction<'_>, downloads: &[String]) -> Result<(), String> {
    transaction
        .execute("DELETE FROM downloads", [])
        .map_err(|error| format!("failed to clear downloads: {error}"))?;
    for data in downloads {
        let value: Value = serde_json::from_str(data)
            .map_err(|error| format!("failed to decode download: {error}"))?;
        let id = required_string(&value, "id")?;
        let status = required_string(&value, "status")?;
        let queue_id = value.get("queueId").and_then(Value::as_str);
        transaction
            .execute(
                "INSERT INTO downloads (id, status, queue_id, data) VALUES (?1, ?2, ?3, ?4)",
                params![id, status, queue_id, data],
            )
            .map_err(|error| format!("failed to save download '{id}': {error}"))?;
    }
    Ok(())
}

pub fn load_queues(connection: &Connection) -> Result<Vec<String>, String> {
    query_string_column(connection, "SELECT data FROM queues ORDER BY rowid")
}

pub fn replace_queues(connection: &mut Connection, data: &str) -> Result<(), String> {
    let values: Vec<Value> =
        serde_json::from_str(data).map_err(|error| format!("failed to decode queues: {error}"))?;
    let strings = values
        .iter()
        .map(|value| {
            serde_json::to_string(value).map_err(|error| format!("failed to encode queue: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin queue save: {error}"))?;
    replace_queues_tx(&transaction, &strings)?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit queue save: {error}"))
}

fn replace_queues_tx(transaction: &Transaction<'_>, queues: &[String]) -> Result<(), String> {
    transaction
        .execute("DELETE FROM queues", [])
        .map_err(|error| format!("failed to clear queues: {error}"))?;
    for data in queues {
        let value: Value = serde_json::from_str(data)
            .map_err(|error| format!("failed to decode queue: {error}"))?;
        let id = required_string(&value, "id")?;
        transaction
            .execute(
                "INSERT INTO queues (id, data) VALUES (?1, ?2)",
                params![id, data],
            )
            .map_err(|error| format!("failed to save queue '{id}': {error}"))?;
    }
    Ok(())
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("persisted item is missing '{key}'"))
}

pub fn load_ownership(connection: &Connection) -> Result<Vec<(String, String, Vec<String>)>, String> {
    let mut statement = connection
        .prepare(
            "SELECT ownership.id, ownership.primary_path, paths.paths
             FROM download_ownership AS ownership
             LEFT JOIN download_owned_paths AS paths ON paths.id = ownership.id",
        )
        .map_err(|error| format!("failed to prepare ownership query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let primary_path: String = row.get(1)?;
            let owned_paths = row
                .get::<_, Option<String>>(2)?
                .and_then(|paths| serde_json::from_str::<Vec<String>>(&paths).ok())
                .filter(|paths| !paths.is_empty())
                .unwrap_or_else(|| vec![primary_path.clone()]);
            Ok((row.get(0)?, primary_path, owned_paths))
        })
        .map_err(|error| format!("failed to query ownership data: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read ownership data: {error}"))
}

pub fn set_ownership_paths(
    connection: &Connection,
    id: &str,
    primary_path: &str,
    paths: &[String],
) -> Result<(), String> {
    set_ownership_paths_checked(connection, id, primary_path, paths, &[])
}

fn set_ownership_paths_checked(
    connection: &Connection,
    id: &str,
    primary_path: &str,
    paths: &[String],
    removal_paths: &[String],
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT ownership.id, ownership.primary_path, paths.paths, removal.paths
             FROM download_ownership AS ownership
             LEFT JOIN download_owned_paths AS paths ON paths.id = ownership.id
             LEFT JOIN download_removal_paths AS removal ON removal.id = ownership.id
             WHERE ownership.id <> ?1",
        )
        .map_err(|error| format!("failed to prepare download ownership check: {error}"))?;
    let existing = statement
        .query_map(params![id], |row| {
            let primary: String = row.get(1)?;
            let owned = row
                .get::<_, Option<String>>(2)?
                .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
                .unwrap_or_else(|| vec![primary.clone()]);
            let removal = row
                .get::<_, Option<String>>(3)?
                .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
                .unwrap_or_default();
            Ok((primary, owned, removal))
        })
        .map_err(|error| format!("failed to check download ownership paths: {error}"))?;
    for row in existing {
        let (existing_primary, owned, removal) =
            row.map_err(|error| format!("failed to read download ownership paths: {error}"))?;
        let new_paths = std::iter::once(primary_path)
            .chain(paths.iter().map(String::as_str))
            .chain(removal_paths.iter().map(String::as_str));
        let existing_paths = std::iter::once(existing_primary.as_str())
            .chain(owned.iter().map(String::as_str))
            .chain(removal.iter().map(String::as_str));
        if new_paths.clone().any(|new_path| {
            existing_paths
                .clone()
                .any(|existing_path| crate::platform::paths_equal(Path::new(new_path), Path::new(existing_path)))
        }) {
            return Err("Download destination is already owned by another Firelink download".to_string());
        }
    }

    connection
        .execute(
            "INSERT INTO download_ownership (id, primary_path) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET primary_path = excluded.primary_path",
            params![id, primary_path],
        )
        .map_err(|error| format!("failed to save ownership data: {error}"))?;
    let encoded_paths = serde_json::to_string(paths)
        .map_err(|error| format!("failed to encode download ownership paths: {error}"))?;
    connection
        .execute(
            "INSERT INTO download_owned_paths (id, paths) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET paths = excluded.paths",
            params![id, encoded_paths],
        )
        .map_err(|error| format!("failed to save download ownership path list: {error}"))?;
    Ok(())
}

pub fn set_ownership_and_removal_paths(
    connection: &Connection,
    id: &str,
    primary_path: &str,
    paths: &[String],
    removal_paths: &[String],
) -> Result<(), String> {
    // Ownership and the planned deletion reservation are one safety
    // boundary.  Do not leave a partially-written reservation behind if the
    // second table write fails or the process crashes between writes.
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("failed to begin torrent ownership transaction: {error}"))?;
    set_ownership_paths_checked(&transaction, id, primary_path, paths, removal_paths)?;
    if removal_paths.is_empty() {
        transaction
            .execute(
                "DELETE FROM download_removal_paths WHERE id = ?1",
                params![id],
            )
            .map_err(|error| format!("failed to clear torrent removal paths: {error}"))?;
    } else {
        let encoded_paths = serde_json::to_string(removal_paths)
            .map_err(|error| format!("failed to encode torrent removal paths: {error}"))?;
        transaction
            .execute(
                "INSERT INTO download_removal_paths (id, paths) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET paths = excluded.paths",
                params![id, encoded_paths],
            )
            .map_err(|error| format!("failed to save torrent removal paths: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit torrent ownership transaction: {error}"))
}

/// Reclaim reservations left behind by a process crash after a terminal
/// Torrent outcome.  Active, queued, and paused records remain reserved: a
/// future lifecycle may still ask Aria2 to remove those paths.  A terminal
/// record is reclaimed only after every reserved path is absent, proving that
/// Aria2's unselected-file cleanup was observed.  Failed records are treated
/// conservatively as well because Aria2 may leave unselected files behind on
/// an error.
pub fn reconcile_torrent_removal_paths_after_restart(
    connection: &Connection,
) -> Result<usize, String> {
    let mut statement = connection
        .prepare(
            "SELECT removal.id, removal.paths, downloads.status
             FROM download_removal_paths AS removal
             LEFT JOIN downloads ON downloads.id = removal.id",
        )
        .map_err(|error| format!("failed to prepare torrent removal recovery query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let paths: String = row.get(1)?;
            let status: Option<String> = row.get(2)?;
            Ok((id, paths, status))
        })
        .map_err(|error| format!("failed to query torrent removal recovery data: {error}"))?;

    let mut reclaim = Vec::new();
    for row in rows {
        let (id, encoded_paths, status) =
            row.map_err(|error| format!("failed to read torrent removal recovery data: {error}"))?;
        let paths = match serde_json::from_str::<Vec<String>>(&encoded_paths) {
            Ok(paths)
                if !paths.is_empty()
                    && paths.iter().all(|path| {
                        let path = Path::new(path);
                        path.is_absolute()
                            && !path.components().any(|component| {
                                matches!(component, Component::CurDir | Component::ParentDir)
                            })
                    }) =>
            {
                paths
            }
            // Malformed or empty reservations are retained for conservative
            // manual recovery rather than being silently discarded.
            _ => continue,
        };
        let Some(status) = status else {
            continue;
        };
        let should_reclaim = match status.as_str() {
            "failed" | "completed" => paths
                .iter()
                .all(|path| torrent_removal_path_is_absent(Path::new(path))),
            _ => false,
        };
        if should_reclaim {
            reclaim.push(id);
        }
    }

    let mut reclaimed = 0;
    for id in reclaim {
        reclaimed += connection
            .execute(
                "DELETE FROM download_removal_paths WHERE id = ?1",
                params![id],
            )
            .map_err(|error| format!("failed to reclaim torrent removal paths: {error}"))?;
    }
    Ok(reclaimed)
}

fn torrent_removal_path_is_absent(path: &Path) -> bool {
    matches!(
        fs::symlink_metadata(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    )
}

pub fn remove_ownership(connection: &Connection, id: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM download_removal_paths WHERE id = ?1", params![id])
        .map_err(|error| format!("failed to delete torrent removal paths: {error}"))?;
    connection
        .execute("DELETE FROM download_owned_paths WHERE id = ?1", params![id])
        .map_err(|error| format!("failed to delete download ownership paths: {error}"))?;
    connection
        .execute("DELETE FROM download_ownership WHERE id = ?1", params![id])
        .map_err(|error| format!("failed to delete ownership data: {error}"))?;
    Ok(())
}

pub fn remove_torrent_removal_paths(connection: &Connection, id: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM download_removal_paths WHERE id = ?1", params![id])
        .map_err(|error| format!("failed to clear torrent removal paths: {error}"))?;
    Ok(())
}

pub fn load_torrent_removal_paths(
    connection: &Connection,
    id: &str,
) -> Result<Vec<String>, String> {
    connection
        .query_row(
            "SELECT paths FROM download_removal_paths WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to read torrent removal paths: {error}"))?
        .map(|value| {
            serde_json::from_str::<Vec<String>>(&value)
                .map_err(|error| format!("failed to decode torrent removal paths: {error}"))
        })
        .transpose()
        .map(|paths| paths.unwrap_or_default())
}

pub fn has_user_data(connection: &Connection) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT
                EXISTS(SELECT 1 FROM settings WHERE id = 1)
                OR EXISTS(SELECT 1 FROM downloads)
                OR EXISTS(SELECT 1 FROM queues)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to inspect existing user data: {error}"))
}

pub fn record_notice(connection: &Connection, key: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO migration_events (key, consumed) VALUES (?1, 0)
             ON CONFLICT(key) DO NOTHING",
            params![key],
        )
        .map_err(|error| format!("failed to record migration notice: {error}"))?;
    Ok(())
}

pub fn has_pending_notice(connection: &Connection, key: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM migration_events WHERE key = ?1 AND consumed = 0)",
            params![key],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("failed to read migration notice: {error}"))
}

pub fn consume_notice(connection: &Connection, key: &str) -> Result<(), String> {
    connection
        .execute(
            "UPDATE migration_events SET consumed = 1 WHERE key = ?1",
            params![key],
        )
        .map_err(|error| format!("failed to consume migration notice: {error}"))?;
    Ok(())
}

pub fn acknowledge_pairing_token_notice(connection: &Connection) -> Result<(), String> {
    consume_notice(connection, TOKEN_CHANGED_NOTICE)
}

pub(crate) fn generate_pairing_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Read the extension pairing token from portable settings JSON.
/// Standard-mode settings are sanitized so this field is never a credential
/// source outside the explicit portable-storage exception.
pub fn load_pairing_token_from_settings(connection: &Connection) -> Result<Option<String>, String> {
    let Some(settings_json) = load_settings(connection)? else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_str(&settings_json)
        .map_err(|error| format!("failed to decode settings: {error}"))?;
    let state = value.get("state").unwrap_or(&value);
    let token = state
        .get("extensionPairingToken")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Ok(token)
}

/// Write (or update) the extension pairing token inside portable settings JSON.
/// Keeps all other settings fields intact.
pub fn save_pairing_token_to_settings(
    connection: &Connection,
    token: &str,
    initialize_if_missing: bool,
) -> Result<(), String> {
    let Some(settings_json) = load_settings(connection)? else {
        if !initialize_if_missing {
            // Settings have not been persisted yet. Standard mode keeps the
            // first-run token session-only until the user grants credential-
            // store access; portable mode opts into initialization explicitly.
            return Ok(());
        }
        let initial = serde_json::json!({
            "state": { "extensionPairingToken": token },
            "version": 3
        });
        let serialized = serde_json::to_string(&initial)
            .map_err(|error| format!("failed to encode initial settings: {error}"))?;
        return save_settings(connection, &serialized);
    };
    let mut value: serde_json::Value = serde_json::from_str(&settings_json)
        .map_err(|error| format!("failed to decode settings: {error}"))?;
    let state = if value.get("state").is_some() {
        value
            .get_mut("state")
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| "persisted settings state must be an object".to_string())?
    } else {
        value
            .as_object_mut()
            .ok_or_else(|| "persisted settings must be an object".to_string())?
    };
    state.insert(
        "extensionPairingToken".to_string(),
        serde_json::Value::String(token.to_string()),
    );
    let updated = serde_json::to_string(&value)
        .map_err(|error| format!("failed to encode settings: {error}"))?;
    save_settings(connection, &updated)
}

/// Remove a pairing token from a serialized settings document.
///
/// Standard-mode settings must never carry the extension HMAC secret. The
/// portable path deliberately preserves it separately through
/// `preserve_portable_pairing_token`.
pub fn strip_pairing_token_from_settings(data: &str) -> Result<String, String> {
    let (sanitized, _, _) = sanitize_settings_text(data, true)?;
    Ok(sanitized)
}

/// Keep a legacy token in the standard settings document while credential-store
/// migration is pending. The backend never returns this copy to the frontend;
/// it is retained only so an unavailable credential store cannot turn a later
/// settings save into permanent pairing loss.
pub fn preserve_legacy_pairing_token(
    existing: Option<&str>,
    incoming: &str,
) -> Result<String, String> {
    let Some(existing) = existing else {
        return Ok(incoming.to_string());
    };
    let (_, token, _) = sanitize_settings_text(existing, true)?;
    let Some(token) = token.filter(|value| !value.trim().is_empty()) else {
        return Ok(incoming.to_string());
    };

    let mut document: Value = serde_json::from_str(incoming)
        .map_err(|error| format!("failed to decode settings for legacy token preservation: {error}"))?;
    let state = if document.get("state").is_some() {
        document
            .get_mut("state")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "persisted settings state must be an object".to_string())?
    } else {
        document
            .as_object_mut()
            .ok_or_else(|| "persisted settings must be an object".to_string())?
    };
    state.insert("extensionPairingToken".to_string(), Value::String(token));
    serde_json::to_string(&document)
        .map_err(|error| format!("failed to encode settings with pending pairing token: {error}"))
}

/// Read a legacy pairing token from the settings database without changing it.
pub fn read_pairing_token_from_settings(
    connection: &Connection,
) -> Result<Option<String>, String> {
    let Some(settings) = load_settings(connection)? else {
        return Ok(None);
    };
    let (_, token, _) = sanitize_settings_text(&settings, true)?;
    Ok(token.filter(|value| !value.trim().is_empty()))
}

/// Remove a legacy pairing token from the settings database.
pub fn remove_pairing_token_from_settings(connection: &Connection) -> Result<(), String> {
    let Some(settings) = load_settings(connection)? else {
        return Ok(());
    };
    let (sanitized, _, _) = sanitize_settings_text(&settings, true)?;
    if sanitized != settings {
        save_settings(connection, &sanitized)?;
    }
    Ok(())
}

/// Migrate any legacy standard-mode token into the OS credential store.
///
/// The settings copy is removed only after the credential-store write succeeds.
/// If cleanup fails after creating a new credential, the new entry is rolled
/// back so a later retry can complete the migration without losing the token.
pub fn migrate_legacy_pairing_token(connection: &Connection) -> Result<(), String> {
    let Some(legacy_token) = read_pairing_token_from_settings(connection)? else {
        return Ok(());
    };

    // Hold the same lock used by the public credential-store commands across
    // the complete read/write/cleanup sequence. Otherwise a concurrent grant,
    // regeneration, or delete could invalidate the rollback decision.
    let _keyring_guard = lock_keyring_operations()?;
    let keychain_has_token = get_keychain_password_unlocked(PAIRING_TOKEN_KEYCHAIN_ID)
        .ok()
        .is_some_and(|value| !value.trim().is_empty());
    let created_keychain_entry = !keychain_has_token;
    if created_keychain_entry {
        set_keychain_password_unlocked(PAIRING_TOKEN_KEYCHAIN_ID, &legacy_token)?;
    }

    if let Err(error) = remove_pairing_token_from_settings(connection) {
        if created_keychain_entry {
            if let Err(rollback_error) = delete_keychain_password_unlocked(PAIRING_TOKEN_KEYCHAIN_ID)
            {
                return Err(format!(
                    "failed to remove the legacy pairing token after credential-store migration: {error}; credential-store rollback also failed: {rollback_error}"
                ));
            }
        }
        return Err(format!(
            "failed to remove the legacy pairing token after credential-store migration: {error}"
        ));
    }

    Ok(())
}

fn ensure_keyring_store() -> Result<(), String> {
    if keyring_core::get_default_store().is_some() {
        return Ok(());
    }

    static STORE_INIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = STORE_INIT_LOCK
        .lock()
        .map_err(|_| "keyring store initialization lock is unavailable".to_string())?;

    if keyring_core::get_default_store().is_some() {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let store = apple_native_keyring_store::keychain::Store::new()
            .map_err(|error| error.to_string())?;
        keyring_core::set_default_store(store);
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let store =
            windows_native_keyring_store::Store::new().map_err(|error| error.to_string())?;
        keyring_core::set_default_store(store);
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let store =
            zbus_secret_service_keyring_store::Store::new().map_err(|error| error.to_string())?;
        keyring_core::set_default_store(store);
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("No native keyring store is available for this platform".to_string())
    }
}

fn keychain_entry_with_target(
    id: &str,
    target: Option<&str>,
) -> Result<keyring_core::Entry, String> {
    ensure_keyring_store()?;
    if let Some(target) = target {
        return keyring_core::Entry::new_with_modifiers(
            KEYCHAIN_SERVICE,
            id,
            &std::collections::HashMap::from([("target", target)]),
        )
        .map_err(|error| error.to_string());
    }
    keyring_core::Entry::new(KEYCHAIN_SERVICE, id).map_err(|error| error.to_string())
}

fn keychain_entry(id: &str) -> Result<keyring_core::Entry, String> {
    #[cfg(target_os = "linux")]
    {
        return keychain_entry_with_target(id, Some("default"));
    }

    #[cfg(not(target_os = "linux"))]
    keychain_entry_with_target(id, None)
}

fn lock_keyring_operations() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    KEYRING_OPERATION_LOCK
        .lock()
        .map_err(|_| "keyring operation lock is unavailable".to_string())
}

#[cfg(target_os = "linux")]
fn legacy_linux_keychain_entries(id: &str) -> Result<Vec<keyring_core::Entry>, String> {
    ensure_keyring_store()?;
    let entries = keyring_core::Entry::search(&std::collections::HashMap::from([
        ("service", KEYCHAIN_SERVICE),
        ("username", id),
    ]))
    .map_err(|error| error.to_string())?;
    let mut legacy = Vec::new();
    for entry in entries {
        let attributes = entry.get_attributes().map_err(|error| error.to_string())?;
        if !attributes.contains_key("target") {
            legacy.push(entry);
        }
    }
    Ok(legacy)
}

#[cfg(target_os = "linux")]
fn unique_legacy_linux_keychain_entry(id: &str) -> Result<Option<keyring_core::Entry>, String> {
    let mut entries = legacy_linux_keychain_entries(id)?;
    match entries.len() {
        0 => Ok(None),
        1 => Ok(entries.pop()),
        count => Err(format!(
            "Entry is matched by {count} legacy Linux credentials"
        )),
    }
}

fn set_keychain_password_unlocked(id: &str, password: &str) -> Result<(), String> {
    let entry = keychain_entry(id)?;

    #[cfg(target_os = "linux")]
    if let Err(error) = entry.get_credential() {
        match error {
            keyring_core::Error::NoEntry => {
                if let Some(legacy) = unique_legacy_linux_keychain_entry(id)? {
                    return legacy
                        .set_password(password)
                        .map_err(|error| error.to_string());
                }
            }
            error => return Err(error.to_string()),
        }
    }

    entry
        .set_password(password)
        .map_err(|error| error.to_string())
}

pub fn set_keychain_password(id: &str, password: &str) -> Result<(), String> {
    let _guard = lock_keyring_operations()?;
    set_keychain_password_unlocked(id, password)
}

fn get_keychain_password_if_present_unlocked(id: &str) -> Result<Option<String>, String> {
    let entry = keychain_entry(id)?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        #[cfg(target_os = "linux")]
        Err(keyring_core::Error::NoEntry) => unique_legacy_linux_keychain_entry(id)?
            .map(|legacy| legacy.get_password().map_err(|error| error.to_string()))
            .transpose(),
        #[cfg(not(target_os = "linux"))]
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn get_keychain_password_unlocked(id: &str) -> Result<String, String> {
    get_keychain_password_if_present_unlocked(id)?
        .ok_or_else(|| keyring_core::Error::NoEntry.to_string())
}

pub fn get_keychain_password(id: &str) -> Result<String, String> {
    let _guard = lock_keyring_operations()?;
    get_keychain_password_unlocked(id)
}

fn delete_keychain_password_unlocked(id: &str) -> Result<(), String> {
    let entry = keychain_entry(id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => {}
        Err(error) => return Err(error.to_string()),
    }

    #[cfg(target_os = "linux")]
    for legacy in legacy_linux_keychain_entries(id)? {
        match legacy.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => {}
            Err(error) => return Err(error.to_string()),
        }
    }

    Ok(())
}

pub fn delete_keychain_password(id: &str) -> Result<(), String> {
    let _guard = lock_keyring_operations()?;
    delete_keychain_password_unlocked(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn site_login_settings_update_preserves_envelope_without_password() {
        let original = json!({
            "state": {
                "theme": "dark",
                "siteLogins": []
            },
            "version": 3
        })
        .to_string();

        let updated = add_site_login_to_settings(
            &original,
            "login-1",
            "https://example.com/*",
            "nima",
        )
        .unwrap();
        let document: Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(document["state"]["theme"], "dark");
        assert_eq!(document["version"], 3);
        assert_eq!(document["state"]["siteLogins"][0]["id"], "login-1");
        assert_eq!(document["state"]["siteLogins"][0]["username"], "nima");
        assert!(!updated.contains("password"));
    }

    #[test]
    fn site_login_settings_update_rejects_duplicate_ids() {
        let original = json!({
            "state": {
                "siteLogins": [{
                    "id": "login-1",
                    "urlPattern": "https://example.com/*",
                    "username": "old-user"
                }]
            },
            "version": 3
        })
        .to_string();

        let error = add_site_login_to_settings(
            &original,
            "login-1",
            "https://example.com/*",
            "new-user",
        )
        .unwrap_err();
        assert_eq!(error, "site login already exists");
    }

    #[test]
    fn site_login_settings_removal_reports_whether_metadata_changed() {
        let original = json!({
            "state": {
                "siteLogins": [{
                    "id": "login-1",
                    "urlPattern": "https://example.com/*",
                    "username": "nima"
                }]
            },
            "version": 3
        })
        .to_string();

        let (updated, removed) = remove_site_login_from_settings(&original, "login-1").unwrap();
        assert!(removed);
        let document: Value = serde_json::from_str(&updated).unwrap();
        assert!(document["state"]["siteLogins"].as_array().unwrap().is_empty());

        let (unchanged, removed) = remove_site_login_from_settings(&updated, "missing").unwrap();
        assert!(!removed);
        assert_eq!(unchanged, updated);
    }

    #[test]
    fn site_login_ids_cannot_alias_the_pairing_token_or_hide_whitespace() {
        assert_eq!(validate_site_login_id("login-1").unwrap(), "login-1");
        assert!(validate_site_login_id(" extension-pairing-token").is_err());
        assert!(validate_site_login_id("extension-pairing-token ").is_err());
        assert!(validate_site_login_id(" login-1").is_err());
    }

    #[test]
    fn migrates_v0_database_and_creates_backup() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(DATABASE_NAME);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE downloads (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    queue_id TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE queues (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                INSERT INTO downloads VALUES (
                    'one', 'queued', 'main',
                    '{\"id\":\"one\",\"status\":\"queued\",\"queueId\":\"main\"}'
                );
                ",
            )
            .unwrap();
        drop(connection);

        let state = init_at_path(temp.path()).unwrap();
        let connection = state.lock().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert!(!column_is_not_null(&connection, "downloads", "queue_id").unwrap());
        assert_eq!(load_downloads(&connection).unwrap().len(), 1);
        assert!(fs::read_dir(temp.path()).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("firelink.sqlite.backup-schema-v0-")
        }));
    }

    #[test]
    fn portable_migration_does_not_create_raw_schema_backup() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(DATABASE_NAME);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE downloads (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    queue_id TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE queues (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                INSERT INTO downloads VALUES (
                    'one', 'queued', 'main',
                    '{\"id\":\"one\",\"status\":\"queued\",\"password\":\"secret\"}'
                );
                ",
            )
            .unwrap();
        drop(connection);

        let state = init_at_path_internal(temp.path(), true).unwrap();
        let connection = state.lock().unwrap();
        let saved: Value = serde_json::from_str(&load_downloads(&connection).unwrap()[0]).unwrap();
        assert!(saved.get("password").is_none());
        assert!(!fs::read_dir(temp.path()).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("firelink.sqlite.backup-schema-v0-")
        }));
    }

    #[test]
    fn imports_legacy_bundle_store_with_pending_token_for_deferred_migration() {
        let root = TempDir::new().unwrap();
        let current = root.path().join("com.nimbold.firelink");
        let legacy = root.path().join(LEGACY_BUNDLE_IDENTIFIER);
        fs::create_dir_all(&legacy).unwrap();
        let store = json!({
            "settings": json!({
                "state": {
                    "theme": "dark",
                    "extensionPairingToken": "legacy-secret"
                },
                "version": 0
            }).to_string(),
            "download_queue": [{
                "id": "download-1",
                "status": "ready",
                "url": "https://example.com/file",
                "fileName": "file",
                "category": "Other",
                "dateAdded": ""
            }],
            "queues": [{
                "id": "main",
                "name": "Main Queue",
                "isMain": true
            }]
        });
        fs::write(
            legacy.join(LEGACY_STORE_NAME),
            serde_json::to_vec(&store).unwrap(),
        )
        .unwrap();

        let state = init_at_path(&current).unwrap();
        let connection = state.lock().unwrap();
        assert_eq!(load_downloads(&connection).unwrap().len(), 1);
        assert_eq!(load_queues(&connection).unwrap().len(), 1);
        let settings = load_settings(&connection).unwrap().unwrap();
        assert!(settings.contains("\"theme\":\"dark\""));
        assert!(settings.contains("legacy-secret"));
        let backup = fs::read_dir(&legacy)
            .unwrap()
            .flatten()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("store.bin.backup-legacy-import-")
            })
            .expect("legacy import should retain a sanitized backup");
        assert!(!fs::read_to_string(backup.path())
            .unwrap()
            .contains("legacy-secret"));
        assert!(!fs::read_to_string(legacy.join(LEGACY_STORE_NAME))
            .unwrap()
            .contains("legacy-secret"));
    }

    #[test]
    fn portable_import_sanitizes_legacy_source_after_success() {
        let root = TempDir::new().unwrap();
        let current = root.path().join("com.nimbold.firelink");
        let legacy = root.path().join(LEGACY_BUNDLE_IDENTIFIER);
        fs::create_dir_all(&legacy).unwrap();
        let store_path = legacy.join(LEGACY_STORE_NAME);
        let store = json!({
            "settings": json!({"state": {"theme": "dark"}}).to_string(),
            "download_queue": [{
                "id": "download-1",
                "status": "queued",
                "url": "https://example.com/file",
                "password": "legacy-secret"
            }],
            "queues": []
        });
        fs::write(&store_path, serde_json::to_vec(&store).unwrap()).unwrap();

        let state = init_at_path_internal(&current, true).unwrap();
        let connection = state.lock().unwrap();
        let saved: Value = serde_json::from_str(&load_downloads(&connection).unwrap()[0]).unwrap();
        assert!(saved.get("password").is_none());
        let sanitized_store = fs::read_to_string(&store_path).unwrap();
        assert!(!sanitized_store.contains("legacy-secret"));
    }

    #[test]
    fn imports_legacy_bundle_sqlite_database() {
        let root = TempDir::new().unwrap();
        let current = root.path().join("com.nimbold.firelink");
        let legacy = root.path().join(LEGACY_BUNDLE_IDENTIFIER);
        fs::create_dir_all(&legacy).unwrap();
        let legacy_path = legacy.join(DATABASE_NAME);
        let connection = Connection::open(&legacy_path).unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE downloads (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    queue_id TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE queues (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                INSERT INTO downloads VALUES (
                    'legacy-download', 'queued', 'legacy-main',
                    '{\"id\":\"legacy-download\",\"status\":\"queued\",\"queueId\":\"legacy-main\"}'
                );
                INSERT INTO queues VALUES (
                    'legacy-main',
                    '{\"id\":\"legacy-main\",\"name\":\"Legacy Main\",\"isMain\":true}'
                );
                INSERT INTO settings VALUES (
                    1,
                    '{\"state\":{\"theme\":\"nord\",\"extensionPairingToken\":\"legacy-sqlite-secret\"},\"version\":0}'
                );
                ",
            )
            .unwrap();
        drop(connection);

        let state = init_at_path(&current).unwrap();
        let connection = state.lock().unwrap();
        assert_eq!(load_downloads(&connection).unwrap().len(), 1);
        assert_eq!(load_queues(&connection).unwrap().len(), 1);
        let settings = load_settings(&connection).unwrap().unwrap();
        assert!(settings.contains("\"nord\""));
        assert!(settings.contains("legacy-sqlite-secret"));
        let backup = fs::read_dir(&legacy)
            .unwrap()
            .flatten()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("firelink.sqlite.backup-legacy-import-")
            })
            .unwrap();
        let backup_connection = Connection::open(backup.path()).unwrap();
        let backup_settings: String = backup_connection
            .query_row("SELECT data FROM settings WHERE id = 1", [], |row| row.get(0))
            .unwrap();
        assert!(!backup_settings.contains("legacy-sqlite-secret"));
        drop(backup_connection);
        let source_connection = Connection::open(legacy.join(DATABASE_NAME)).unwrap();
        let source_settings: String = source_connection
            .query_row("SELECT data FROM settings WHERE id = 1", [], |row| row.get(0))
            .unwrap();
        assert!(!source_settings.contains("legacy-sqlite-secret"));
    }

    #[test]
    fn portable_download_persistence_removes_transfer_secrets() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let mut connection = state.lock().unwrap();
        let data = json!([{
            "id": "download-1",
            "status": "queued",
            "queueId": "main",
            "url": "https://user:secret@example.com/file?token=secret#fragment",
            "password": "secret",
            "cookies": "session=secret",
            "headers": "Authorization: Bearer secret",
            "mirrors": "https://user:secret@example.com/mirror",
            "proxy": "http://user:secret@example.com:8080",
            "torrentTrackers": "https://tracker.example/announce?passkey=secret",
            "torrentExcludeTrackers": "https://tracker.example/exclude?passkey=secret"
        }])
        .to_string();

        replace_downloads(&mut connection, &data, true).unwrap();

        let saved: Value = serde_json::from_str(&load_downloads(&connection).unwrap()[0]).unwrap();
        assert_eq!(saved["url"], "https://example.com/file");
        assert_eq!(saved["status"], "failed");
        assert_eq!(saved["resumable"], false);
        assert!(!saved.to_string().contains("secret"));
        for key in ["password", "cookies", "headers", "mirrors", "proxy"] {
            assert!(saved.get(key).is_none(), "portable data retained {key}");
        }
        assert_eq!(saved["torrentTrackers"], "https://tracker.example/announce");
        assert_eq!(saved["torrentExcludeTrackers"], "https://tracker.example/exclude");
    }

    #[test]
    fn portable_download_persistence_drops_malformed_tracker_fields() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let mut connection = state.lock().unwrap();
        let data = json!([{
            "id": "download-malformed-trackers",
            "status": "queued",
            "queueId": "main",
            "url": "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            "torrentTrackers": { "token": "secret" },
            "torrentExcludeTrackers": { "token": "secret" }
        }])
        .to_string();

        replace_downloads(&mut connection, &data, true).unwrap();

        let saved: Value = serde_json::from_str(&load_downloads(&connection).unwrap()[0]).unwrap();
        assert!(saved.get("torrentTrackers").is_none());
        assert!(saved.get("torrentExcludeTrackers").is_none());
        assert_eq!(saved["status"], "failed");
        assert_eq!(saved["resumable"], false);
        assert!(!saved.to_string().contains("secret"));
    }

    #[test]
    fn portable_download_persistence_keeps_wildcard_tracker_exclusion() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let mut connection = state.lock().unwrap();
        let data = json!([{
            "id": "download-wildcard-exclusion",
            "status": "queued",
            "queueId": "main",
            "url": "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
            "torrentExcludeTrackers": "*"
        }])
        .to_string();

        replace_downloads(&mut connection, &data, true).unwrap();

        let saved: Value = serde_json::from_str(&load_downloads(&connection).unwrap()[0]).unwrap();
        assert_eq!(saved["torrentExcludeTrackers"], "*");
    }

    #[test]
    fn portable_download_persistence_drops_invalid_tracker_urls() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let mut connection = state.lock().unwrap();
        let data = json!([{
            "id": "download-invalid-trackers",
            "status": "queued",
            "queueId": "main",
            "url": "https://example.com/file.bin",
            "torrentTrackers": "ftp://tracker.example/announce",
            "torrentExcludeTrackers": "ftp://tracker.example/announce"
        }])
        .to_string();

        replace_downloads(&mut connection, &data, true).unwrap();

        let saved: Value = serde_json::from_str(&load_downloads(&connection).unwrap()[0]).unwrap();
        assert!(saved.get("torrentTrackers").is_none());
        assert!(saved.get("torrentExcludeTrackers").is_none());
        assert_eq!(saved["status"], "failed");
        assert_eq!(saved["resumable"], false);
    }

    #[test]
    fn portable_download_persistence_marks_context_dependent_queue_items_unresumable() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let mut connection = state.lock().unwrap();
        let data = json!([{
            "id": "download-context",
            "status": "queued",
            "queueId": "main",
            "url": "https://example.com/file",
            "headers": "Authorization: Bearer secret"
        }])
        .to_string();

        replace_downloads(&mut connection, &data, true).unwrap();

        let saved: Value = serde_json::from_str(&load_downloads(&connection).unwrap()[0]).unwrap();
        assert_eq!(saved["url"], "https://example.com/file");
        assert_eq!(saved["status"], "failed");
        assert_eq!(saved["resumable"], false);
        assert_eq!(
            saved["lastError"],
            "Portable mode removed credentials or transfer settings from this persisted download; add it again to resume."
        );
        assert!(saved.get("headers").is_none());
    }

    #[test]
    fn portable_magnet_persistence_keeps_identity_but_does_not_resume_after_tracker_removal() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let mut connection = state.lock().unwrap();
        let data = json!([{
            "id": "magnet-download",
            "status": "queued",
            "queueId": "main",
            "url": "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Example%20Torrent&tr=https%3A%2F%2Ftracker.invalid%2Fsecret"
        }])
        .to_string();

        replace_downloads(&mut connection, &data, true).unwrap();

        let saved: Value = serde_json::from_str(&load_downloads(&connection).unwrap()[0]).unwrap();
        assert_eq!(saved["url"], "magnet:?xt=urn%3Abtih%3A0123456789abcdef0123456789abcdef01234567&dn=Example+Torrent");
        assert_eq!(saved["status"], "failed");
        assert_eq!(saved["resumable"], false);
        assert!(!saved.to_string().contains("tracker.invalid"));
        assert!(!saved.to_string().contains("secret"));
    }

    #[test]
    fn portable_download_persistence_redacts_error_secrets_but_preserves_safe_errors_and_standard_details() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let mut connection = state.lock().unwrap();
        let data = json!([
            {
                "id": "download-secret-error",
                "status": "failed",
                "queueId": "main",
                "url": "https://example.com/file",
                "lastError": "HTTP 500 for https://example.com/file?token=PORTABLE_TEST_QUERY_TOKEN"
            },
            {
                "id": "download-safe-error",
                "status": "failed",
                "queueId": "main",
                "url": "https://example.com/other-file",
                "lastError": "connection refused"
            }
        ])
        .to_string();

        replace_downloads(&mut connection, &data, true).unwrap();

        let saved = load_downloads(&connection).unwrap();
        let secret_error: Value = serde_json::from_str(&saved[0]).unwrap();
        let safe_error: Value = serde_json::from_str(&saved[1]).unwrap();
        assert!(!secret_error
            .to_string()
            .contains("PORTABLE_TEST_QUERY_TOKEN"));
        assert_eq!(safe_error["lastError"], "connection refused");

        replace_downloads(&mut connection, &data, false).unwrap();
        let standard: Value =
            serde_json::from_str(&load_downloads(&connection).unwrap()[0]).unwrap();
        assert!(standard.to_string().contains("PORTABLE_TEST_QUERY_TOKEN"));
    }

    #[test]
    fn standard_pairing_token_is_stripped_from_settings_documents() {
        let input = json!({
            "state": {
                "theme": "dark",
                "extensionPairingToken": "redacted-pairing-token"
            },
            "version": 3
        })
        .to_string();

        let stripped = strip_pairing_token_from_settings(&input).unwrap();
        assert!(!stripped.contains("redacted-pairing-token"));
        assert!(stripped.contains("\"theme\":\"dark\""));
    }

    #[test]
    fn pending_legacy_pairing_token_survives_standard_settings_save() {
        let existing = json!({
            "state": { "theme": "dark", "extensionPairingToken": "pending-token" },
            "version": 3
        })
        .to_string();
        let incoming = json!({
            "state": { "theme": "light" },
            "version": 3
        })
        .to_string();

        let sanitized = strip_pairing_token_from_settings(&incoming).unwrap();
        let preserved = preserve_legacy_pairing_token(Some(&existing), &sanitized).unwrap();

        assert!(preserved.contains("pending-token"));
        assert!(preserved.contains("\"theme\":\"light\""));
    }

    #[test]
    fn reading_legacy_pairing_token_does_not_remove_it_before_migration() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let connection = state.lock().unwrap();
        save_settings(
            &connection,
            &json!({
                "state": { "extensionPairingToken": "redacted-legacy-token" },
                "version": 3
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            read_pairing_token_from_settings(&connection)
                .unwrap()
                .as_deref(),
            Some("redacted-legacy-token")
        );
        assert!(load_settings(&connection)
            .unwrap()
            .unwrap()
            .contains("redacted-legacy-token"));

        remove_pairing_token_from_settings(&connection).unwrap();
        assert!(!load_settings(&connection)
            .unwrap()
            .unwrap()
            .contains("redacted-legacy-token"));
    }

    #[test]
    fn portable_persistence_redacts_unparseable_download_urls() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let mut connection = state.lock().unwrap();
        let data = json!([{
            "id": "download-1",
            "status": "queued",
            "url": "not a URL secret=secret"
        }])
        .to_string();

        replace_downloads(&mut connection, &data, true).unwrap();

        let saved: Value = serde_json::from_str(&load_downloads(&connection).unwrap()[0]).unwrap();
        assert_eq!(saved["url"], "");
        assert_eq!(saved["status"], "failed");
        assert!(!saved.to_string().contains("secret"));
    }

    #[test]
    fn portable_initialization_sanitizes_existing_downloads() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let mut connection = state.lock().unwrap();
        let data = json!([{
            "id": "download-1",
            "status": "queued",
            "url": "https://example.com/file",
            "password": "secret",
            "lastError": "request failed with token=PORTABLE_EXISTING_QUERY_TOKEN"
        }])
        .to_string();
        replace_downloads(&mut connection, &data, false).unwrap();
        drop(connection);
        drop(state);

        let state = init_at_path_internal(temp.path(), true).unwrap();
        let connection = state.lock().unwrap();
        let saved: Value = serde_json::from_str(&load_downloads(&connection).unwrap()[0]).unwrap();
        assert!(saved.get("password").is_none());
        assert!(!saved.to_string().contains("PORTABLE_EXISTING_QUERY_TOKEN"));
    }

    #[test]
    fn rejects_malformed_settings_state_without_panicking() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let connection = state.lock().unwrap();
        save_settings(
            &connection,
            &json!({ "state": "corrupted", "version": 3 }).to_string(),
        )
        .unwrap();

        let result = save_pairing_token_to_settings(&connection, "token", true);

        assert_eq!(
            result.unwrap_err(),
            "persisted settings state must be an object"
        );
    }

    #[test]
    fn pairing_token_is_persisted_before_frontend_settings_exist() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let connection = state.lock().unwrap();

        save_pairing_token_to_settings(&connection, "initial-token", true).unwrap();

        assert_eq!(
            load_pairing_token_from_settings(&connection).unwrap().as_deref(),
            Some("initial-token")
        );
    }

    #[test]
    fn migration_notice_is_persistent_until_acknowledged() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let connection = state.lock().unwrap();

        record_notice(&connection, TOKEN_CHANGED_NOTICE).unwrap();
        assert!(has_pending_notice(&connection, TOKEN_CHANGED_NOTICE).unwrap());
        assert!(has_pending_notice(&connection, TOKEN_CHANGED_NOTICE).unwrap());

        acknowledge_pairing_token_notice(&connection).unwrap();
        assert!(!has_pending_notice(&connection, TOKEN_CHANGED_NOTICE).unwrap());
    }

    #[test]
    fn rejects_two_download_ids_from_claiming_the_same_primary_path() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let connection = state.lock().unwrap();

        set_ownership_paths(
            &connection,
            "first",
            "/downloads/file.bin",
            &["/downloads/file.bin".to_string()],
        )
        .unwrap();
        let error = set_ownership_paths(
            &connection,
            "second",
            "/downloads/file.bin",
            &["/downloads/file.bin".to_string()],
        )
            .expect_err("a primary path must have one live owner");

        assert!(error.contains("already owned"));
        assert_eq!(
            load_ownership(&connection).unwrap(),
            vec![(
                "first".to_string(),
                "/downloads/file.bin".to_string(),
                vec!["/downloads/file.bin".to_string()]
            )]
        );
        set_ownership_paths(
            &connection,
            "first",
            "/downloads/renamed.bin",
            &["/downloads/renamed.bin".to_string()],
        )
        .unwrap();
    }

    #[test]
    fn rejects_overlap_with_any_owned_torrent_path() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let connection = state.lock().unwrap();

        set_ownership_paths(
            &connection,
            "first",
            "/downloads/root",
            &[
                "/downloads/root/a.bin".to_string(),
                "/downloads/root/b.bin".to_string(),
            ],
        )
        .unwrap();
        let error = set_ownership_paths(
            &connection,
            "second",
            "/downloads/root",
            &["/downloads/root/c.bin".to_string()],
        )
        .expect_err("a torrent root must not be reused");
        assert!(error.contains("already owned"));
    }

    #[test]
    fn removal_reservations_block_later_download_ownership_claims() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let connection = state.lock().unwrap();

        set_ownership_and_removal_paths(
            &connection,
            "torrent",
            "/downloads/selected.bin",
            &["/downloads/selected.bin".to_string()],
            &["/downloads/unselected.bin".to_string()],
        )
        .unwrap();
        let error = set_ownership_paths(
            &connection,
            "later",
            "/downloads/unselected.bin",
            &["/downloads/unselected.bin".to_string()],
        )
        .expect_err("a planned Torrent deletion must reserve its path");

        assert!(error.contains("already owned"));
        remove_torrent_removal_paths(&connection, "torrent").unwrap();
        set_ownership_paths(
            &connection,
            "later",
            "/downloads/unselected.bin",
            &["/downloads/unselected.bin".to_string()],
        )
        .unwrap();
    }

    #[test]
    fn torrent_ownership_and_removal_reservation_commit_atomically() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let connection = state.lock().unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_torrent_removal
                 BEFORE INSERT ON download_removal_paths
                 BEGIN SELECT RAISE(ABORT, 'test rejection'); END;",
            )
            .unwrap();

        let error = set_ownership_and_removal_paths(
            &connection,
            "torrent",
            "/downloads/selected.bin",
            &["/downloads/selected.bin".to_string()],
            &["/downloads/unselected.bin".to_string()],
        )
        .expect_err("the injected reservation failure must abort the transaction");

        assert!(error.contains("test rejection"));
        assert!(load_ownership(&connection).unwrap().is_empty());
        assert!(load_torrent_removal_paths(&connection, "torrent")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn restart_reclaims_only_observed_terminal_torrent_reservations() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let connection = state.lock().unwrap();
        let completed_missing = temp.path().join("completed-missing.bin");
        let completed_present = temp.path().join("completed-present.bin");
        let failed_present = temp.path().join("failed-present.bin");
        let queued_missing = temp.path().join("queued-missing.bin");
        fs::write(&completed_present, b"old").unwrap();
        fs::write(&failed_present, b"old").unwrap();

        for (id, status, path) in [
            ("completed-missing", "completed", &completed_missing),
            ("completed-present", "completed", &completed_present),
            ("failed-present", "failed", &failed_present),
            ("queued-missing", "queued", &queued_missing),
        ] {
            let selected_path = temp.path().join(format!("{id}-selected.bin"));
            set_ownership_and_removal_paths(
                &connection,
                id,
                &selected_path.to_string_lossy(),
                &[selected_path.to_string_lossy().to_string()],
                &[path.to_string_lossy().to_string()],
            )
            .unwrap();
            let record = json!({
                "id": id,
                "status": status,
                "isTorrent": true,
                "torrentRemoveUnselectedFile": true
            })
            .to_string();
            connection
                .execute(
                    "INSERT INTO downloads (id, status, queue_id, data) VALUES (?1, ?2, ?3, ?4)",
                    params![id, status, "main", record],
                )
                .unwrap();
        }

        assert_eq!(
            reconcile_torrent_removal_paths_after_restart(&connection).unwrap(),
            1
        );
        assert!(load_torrent_removal_paths(&connection, "completed-missing")
            .unwrap()
            .is_empty());
        assert_eq!(
            load_torrent_removal_paths(&connection, "failed-present").unwrap(),
            vec![failed_present.to_string_lossy().to_string()]
        );
        assert_eq!(
            load_torrent_removal_paths(&connection, "completed-present")
                .unwrap(),
            vec![completed_present.to_string_lossy().to_string()]
        );
        assert_eq!(
            load_torrent_removal_paths(&connection, "queued-missing")
                .unwrap(),
            vec![queued_missing.to_string_lossy().to_string()]
        );

        set_ownership_paths(
            &connection,
            "replacement",
            &completed_missing.to_string_lossy(),
            &[completed_missing.to_string_lossy().to_string()],
        )
        .unwrap();

        let error = set_ownership_paths(
            &connection,
            "failed-replacement",
            &failed_present.to_string_lossy(),
            &[failed_present.to_string_lossy().to_string()],
        )
        .expect_err("an unobserved failed Torrent cleanup must keep its path reserved");
        assert!(error.contains("already owned"));
    }

    #[test]
    fn restart_keeps_orphaned_torrent_removal_reservations_conservative() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let connection = state.lock().unwrap();
        let reserved = temp.path().join("orphaned-unselected.bin");
        set_ownership_and_removal_paths(
            &connection,
            "orphaned",
            &temp.path().join("orphaned-selected.bin").to_string_lossy(),
            &[temp
                .path()
                .join("orphaned-selected.bin")
                .to_string_lossy()
                .to_string()],
            &[reserved.to_string_lossy().to_string()],
        )
        .unwrap();

        assert_eq!(
            reconcile_torrent_removal_paths_after_restart(&connection).unwrap(),
            0
        );
        assert_eq!(
            load_torrent_removal_paths(&connection, "orphaned").unwrap(),
            vec![reserved.to_string_lossy().to_string()]
        );
    }

    #[test]
    fn restart_keeps_malformed_torrent_removal_reservations_conservative() {
        let temp = TempDir::new().unwrap();
        let state = init_at_path(temp.path()).unwrap();
        let connection = state.lock().unwrap();
        for (id, encoded_paths) in [
            ("empty", "[]"),
            ("relative", r#"["relative-file.bin"]"#),
            ("empty-path", r#"[""]"#),
        ] {
            connection
                .execute(
                    "INSERT INTO download_removal_paths (id, paths) VALUES (?1, ?2)",
                    params![id, encoded_paths],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO downloads (id, status, queue_id, data) VALUES
                     (?1, 'completed', 'main', '{}')",
                    params![id],
                )
                .unwrap();
        }

        assert_eq!(
            reconcile_torrent_removal_paths_after_restart(&connection).unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM download_removal_paths",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            3
        );
    }
}

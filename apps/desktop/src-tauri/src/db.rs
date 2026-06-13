use rusqlite::{Connection, Result, params};
use std::sync::Mutex;
use std::path::PathBuf;
use tauri::Manager;

pub struct DbState {
    pub conn: Mutex<Connection>,
}

pub fn init_db(app_handle: &tauri::AppHandle) -> Result<Connection> {
    let app_dir = app_handle.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    if !app_dir.exists() {
        let _ = std::fs::create_dir_all(&app_dir);
    }
    let db_path = app_dir.join("firelink.sqlite");
    let conn = Connection::open(db_path)?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS downloads (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            queue_id TEXT NOT NULL,
            data TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            data TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS queues (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL
        )",
        [],
    )?;

    Ok(conn)
}

// Downloads CRUD
pub fn insert_download(conn: &Connection, id: &str, status: &str, queue_id: &str, data: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO downloads (id, status, queue_id, data) VALUES (?1, ?2, ?3, ?4)",
        params![id, status, queue_id, data],
    )?;
    Ok(())
}

pub fn update_download_status(conn: &Connection, id: &str, status: &str) -> Result<()> {
    conn.execute(
        "UPDATE downloads SET status = ?1 WHERE id = ?2",
        params![status, id],
    )?;
    Ok(())
}

pub fn update_download_data(conn: &Connection, id: &str, data: &str) -> Result<()> {
    conn.execute(
        "UPDATE downloads SET data = ?1 WHERE id = ?2",
        params![data, id],
    )?;
    Ok(())
}

pub fn delete_download(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM downloads WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn get_all_downloads(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT data FROM downloads")?;
    let iter = stmt.query_map([], |row| row.get(0))?;
    let mut res = Vec::new();
    for data in iter {
        res.push(data?);
    }
    Ok(res)
}

pub fn get_downloads_by_status(conn: &Connection, status: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT data FROM downloads WHERE status = ?1")?;
    let iter = stmt.query_map(params![status], |row| row.get(0))?;
    let mut res = Vec::new();
    for data in iter {
        res.push(data?);
    }
    Ok(res)
}

// Settings CRUD
pub fn get_settings(conn: &Connection) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT data FROM settings WHERE id = 1")?;
    let mut iter = stmt.query_map([], |row| row.get(0))?;
    if let Some(row) = iter.next() {
        Ok(Some(row?))
    } else {
        Ok(None)
    }
}

pub fn save_settings(conn: &Connection, data: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?1)",
        params![data],
    )?;
    Ok(())
}

// Queues CRUD
pub fn insert_queue(conn: &Connection, id: &str, data: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO queues (id, data) VALUES (?1, ?2)",
        params![id, data],
    )?;
    Ok(())
}

pub fn delete_queue(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM queues WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn get_all_queues(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT data FROM queues")?;
    let iter = stmt.query_map([], |row| row.get(0))?;
    let mut res = Vec::new();
    for data in iter {
        res.push(data?);
    }
    Ok(res)
}

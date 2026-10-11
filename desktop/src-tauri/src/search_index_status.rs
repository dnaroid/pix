//! Read-only diagnostics for the local search stores under `<workspace>/.pi/search`.
//! Never creates, migrates or repairs a store, never reads credentials and never uses a network.
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchStoreStatus {
    id: &'static str,
    /// "absent" | "present" | "error"
    state: &'static str,
    size_bytes: Option<u64>,
    modified_at_ms: Option<u64>,
    generation: Option<i64>,
    completed_at: Option<String>,
    counts: BTreeMap<&'static str, u64>,
    legacy_sources: Vec<&'static str>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchIndexStatus {
    stores: Vec<SearchStoreStatus>,
}

#[tauri::command]
pub(crate) async fn search_index_status(workspace: String) -> Result<SearchIndexStatus, String> {
    tauri::async_runtime::spawn_blocking(move || read_status(&workspace))
        .await
        .map_err(|_| "Search index status worker failed".to_string())?
}

fn read_status(workspace: &str) -> Result<SearchIndexStatus, String> {
    let root = fs::canonicalize(workspace).map_err(|_| "Selected workspace is unavailable")?;
    let search = root.join(".pi/search");
    let usable_dir = fs::symlink_metadata(&search)
        .map(|m| m.file_type().is_dir() && !m.file_type().is_symlink())
        .unwrap_or(false);
    let stores = [
        (
            "files",
            "files.sqlite",
            &[
                ("files", "SELECT count(*) FROM pix_native_files"),
                (
                    "codeChunks",
                    "SELECT count(*) FROM pix_native_chunks WHERE kind='code'",
                ),
                (
                    "knowledgeChunks",
                    "SELECT count(*) FROM pix_native_chunks WHERE kind='knowledge'",
                ),
            ][..],
        ),
        (
            "vectors",
            "file-vectors.sqlite",
            &[("vectors", "SELECT count(*) FROM vectors")][..],
        ),
        (
            "history",
            "index.sqlite",
            &[
                (
                    "settingsDocuments",
                    "SELECT count(*) FROM documents WHERE json_extract(hit, '$.kind')='settings'",
                ),
                ("settingsVectors", "SELECT count(*) FROM vectors"),
                ("sessionTitles", "SELECT count(*) FROM pix_session_titles"),
                ("sessionVectors", "SELECT count(*) FROM pix_session_vectors"),
                ("taskDocuments", "SELECT count(*) FROM pix_task_documents"),
                ("taskVectors", "SELECT count(*) FROM pix_task_vectors"),
                (
                    "commitDocuments",
                    "SELECT count(*) FROM pix_commit_documents",
                ),
                ("commitVectors", "SELECT count(*) FROM pix_commit_vectors"),
            ][..],
        ),
    ]
    .into_iter()
    .map(|(id, file, queries)| inspect_store(id, usable_dir.then(|| search.join(file)), queries))
    .collect();
    Ok(SearchIndexStatus { stores })
}

fn inspect_store(
    id: &'static str,
    path: Option<PathBuf>,
    queries: &[(&'static str, &str)],
) -> SearchStoreStatus {
    let mut status = SearchStoreStatus {
        id,
        state: "absent",
        size_bytes: None,
        modified_at_ms: None,
        generation: None,
        completed_at: None,
        counts: BTreeMap::new(),
        legacy_sources: Vec::new(),
        error: None,
    };
    let Some(path) = path else { return status };
    let metadata = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return status,
        Err(_) => return fail(status, "Could not inspect the store file"),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return fail(status, "Store path is not a regular file");
    }
    status.size_bytes = Some(metadata.len());
    status.modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    match query_store(&path, id, queries, &mut status) {
        Ok(()) => status.state = "present",
        Err(message) => return fail(status, &message),
    }
    status
}

fn fail(mut status: SearchStoreStatus, message: &str) -> SearchStoreStatus {
    status.state = "error";
    status.error = Some(message.to_string());
    status
}

fn query_store(
    path: &Path,
    id: &str,
    queries: &[(&'static str, &str)],
    status: &mut SearchStoreStatus,
) -> Result<(), String> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "Store could not be opened read-only".to_string())?;
    let _ = db.busy_timeout(Duration::from_millis(250));
    db.execute_batch("BEGIN")
        .map_err(|_| "Store snapshot unavailable".to_string())?;
    // Opening is lazy: force a header read so corrupt/non-database files are errors, not "empty".
    db.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(|_| "Store is not a readable SQLite database".to_string())?;
    if id == "files" {
        let meta: Result<(i64, Option<String>), _> = db.query_row(
            "SELECT generation, completed_at FROM pix_native_meta WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        );
        match meta {
            Ok((generation, completed)) => {
                status.generation = Some(generation);
                status.completed_at = completed;
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {}
            Err(_) => return Err("Store metadata is unreadable or has an unknown schema".into()),
        }
    }
    for (key, sql) in queries {
        // A missing table only means that source has not written to this store yet.
        if let Ok(count) = db.query_row(sql, [], |row| row.get::<_, i64>(0)) {
            status.counts.insert(key, count.max(0) as u64);
        }
    }
    if id == "history" {
        for (source, count, table) in [
            ("settings", "settingsVectors", "metadata"),
            ("sessions", "sessionVectors", "pix_session_meta"),
            ("tasks", "taskVectors", "pix_task_index_meta"),
        ] {
            if status.counts.get(count).copied().unwrap_or(0) == 0 {
                continue;
            }
            let identity: Result<String, _> = db.query_row(
                &format!("SELECT value FROM {table} WHERE key='identity'"),
                [],
                |row| row.get(0),
            );
            if !identity.is_ok_and(|value| !value.is_empty()) {
                status.legacy_sources.push(source);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.pi/artifacts")
            .join(format!("pix-search-status-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".pi/search")).unwrap();
        root
    }

    #[test]
    fn missing_stores_are_absent_not_created() {
        let root = temp_root();
        let status = read_status(root.to_str().unwrap()).unwrap();
        assert!(status.stores.iter().all(|s| s.state == "absent"));
        assert!(!root.join(".pi/search/files.sqlite").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_settings_counts_without_creating_other_tables() {
        let root = temp_root();
        let path = root.join(".pi/search/index.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE documents (hit TEXT); CREATE TABLE vectors (hash TEXT); INSERT INTO documents VALUES ('{\"kind\":\"settings\"}'), ('{\"kind\":\"legacy\"}'); INSERT INTO vectors VALUES ('one');").unwrap();
        drop(db);
        let status = read_status(root.to_str().unwrap()).unwrap();
        let history = &status.stores[2];
        assert_eq!(history.counts.get("settingsDocuments"), Some(&1));
        assert_eq!(history.counts.get("settingsVectors"), Some(&1));
        assert_eq!(history.legacy_sources, vec!["settings"]);
        assert!(!history.counts.contains_key("taskDocuments"));
        let db = Connection::open(&path).unwrap();
        let tables: i64 = db
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 2);
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_identity_is_reported_per_namespace_without_modifying_vectors() {
        let root = temp_root();
        let path = root.join(".pi/search/index.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE metadata (key TEXT, value TEXT);
            INSERT INTO metadata VALUES ('model','old');
            CREATE TABLE vectors (hash TEXT); INSERT INTO vectors VALUES ('settings');
            CREATE TABLE pix_session_meta (key TEXT, value TEXT);
            CREATE TABLE pix_session_vectors (hash TEXT); INSERT INTO pix_session_vectors VALUES ('session');
            CREATE TABLE pix_task_index_meta (key TEXT, value TEXT);
            INSERT INTO pix_task_index_meta VALUES ('identity','configured');
            CREATE TABLE pix_task_vectors (hash TEXT); INSERT INTO pix_task_vectors VALUES ('task');").unwrap();
        let before = fs::read(&path).unwrap();
        let status = read_status(root.to_str().unwrap()).unwrap();
        let history = &status.stores[2];
        assert_eq!(history.legacy_sources, vec!["settings", "sessions"]);
        assert_eq!(history.counts.get("taskVectors"), Some(&1));
        assert_eq!(fs::read(&path).unwrap(), before);
        db.execute_batch("DELETE FROM vectors; DELETE FROM pix_session_vectors")
            .unwrap();
        assert!(read_status(root.to_str().unwrap()).unwrap().stores[2]
            .legacy_sources
            .is_empty());
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_native_counts_and_flags_malformed_store() {
        let root = temp_root();
        let db = Connection::open(root.join(".pi/search/files.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TABLE pix_native_meta (singleton INTEGER PRIMARY KEY, version INTEGER, root TEXT, generation INTEGER, completed_at TEXT);
             INSERT INTO pix_native_meta VALUES(1,1,'/r',3,'2026-01-01');
             CREATE TABLE pix_native_files (path TEXT, hash TEXT);
             CREATE TABLE pix_native_chunks (id TEXT, path TEXT, kind TEXT, title TEXT, start_line INT, end_line INT, content TEXT, is_test INT);
             INSERT INTO pix_native_chunks VALUES('a','a','code','',1,1,'',0),('b','b','knowledge','',1,1,'',0);",
        )
        .unwrap();
        drop(db);
        fs::write(root.join(".pi/search/index.sqlite"), b"not a database").unwrap();
        let status = read_status(root.to_str().unwrap()).unwrap();
        let files = &status.stores[0];
        assert_eq!(files.state, "present");
        assert_eq!(files.generation, Some(3));
        assert_eq!(files.counts.get("codeChunks"), Some(&1));
        assert_eq!(files.counts.get("knowledgeChunks"), Some(&1));
        assert_eq!(status.stores[2].state, "error");
        fs::remove_dir_all(root).unwrap();
    }
}

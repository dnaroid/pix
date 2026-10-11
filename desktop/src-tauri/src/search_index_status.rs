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
    incompatible_sources: Vec<&'static str>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchIndexStatus {
    stores: Vec<SearchStoreStatus>,
    commits_empty: Option<bool>,
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
        ("code", "code.sqlite", &[("files", "SELECT count(*) FROM pix_native_files"), ("codeChunks", "SELECT count(*) FROM pix_native_chunks WHERE kind='code'"), ("vectors", "SELECT count(*) FROM vectors")][..]),
        ("knowledge", "knowledge.sqlite", &[("files", "SELECT count(*) FROM pix_native_files"), ("knowledgeChunks", "SELECT count(*) FROM pix_native_chunks WHERE kind='knowledge'"), ("vectors", "SELECT count(*) FROM vectors")][..]),
        ("settings", "settings.sqlite", &[("settingsDocuments", "SELECT count(*) FROM documents WHERE json_extract(hit, '$.kind')='settings'"), ("settingsVectors", "SELECT count(*) FROM vectors")][..]),
        ("sessions", "sessions.sqlite", &[("sessionTitles", "SELECT count(*) FROM pix_session_titles"), ("sessionVectors", "SELECT count(*) FROM pix_session_vectors")][..]),
        ("tasks", "tasks.sqlite", &[("taskDocuments", "SELECT count(*) FROM pix_task_documents"), ("taskVectors", "SELECT count(*) FROM pix_task_vectors")][..]),
        ("commits", "git-commits.sqlite", &[("commitDocuments", "SELECT count(*) FROM pix_commit_documents"), ("commitVectors", "SELECT count(*) FROM pix_commit_vectors")][..]),
    ]
    .into_iter()
    .map(|(id, file, queries)| inspect_store(id, usable_dir.then(|| search.join(file)), queries))
    .collect();
    Ok(SearchIndexStatus {
        stores,
        commits_empty: commits_empty(&root),
    })
}

fn commits_empty(root: &Path) -> Option<bool> {
    let head = crate::git_output_raw(root, &["rev-parse", "--verify", "HEAD^{commit}"]).ok()?;
    if head.status.success() {
        return Some(false);
    }
    // Only an absent symbolic branch proves an unborn history. Git failures or
    // a broken existing reference must not hide the recovery action.
    let head_ref = crate::git_output_raw(root, &["symbolic-ref", "-q", "HEAD"]).ok()?;
    if !head_ref.status.success() {
        return None;
    }
    let name = std::str::from_utf8(&head_ref.stdout).ok()?.trim();
    if !name.starts_with("refs/heads/") {
        return None;
    }
    let branch = crate::git_output_raw(root, &["show-ref", "--verify", "--quiet", name]).ok()?;
    (branch.status.code() == Some(1)).then_some(true)
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
        incompatible_sources: Vec::new(),
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
    if matches!(id, "code" | "knowledge") {
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
    if matches!(id, "settings" | "sessions" | "tasks" | "commits") {
        for (source, count, table) in [
            ("settings", "settingsVectors", "metadata"),
            ("sessions", "sessionVectors", "pix_session_meta"),
            ("tasks", "taskVectors", "pix_task_index_meta"),
            ("commits", "commitVectors", "pix_commit_meta"),
        ] {
            if id != source { continue; }
            if status.counts.get(count).copied().unwrap_or(0) == 0 {
                continue;
            }
            let identity: Result<String, _> = db.query_row(
                &format!("SELECT value FROM {table} WHERE key='identity'"),
                [],
                |row| row.get(0),
            );
            if !identity.is_ok_and(|value| !value.is_empty()) {
                status.incompatible_sources.push(source);
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
    fn distinguishes_unborn_history_from_uncached_commits_and_broken_refs() {
        let root = temp_root();
        assert!(crate::git_output_raw(&root, &["init", "-b", "main"])
            .unwrap()
            .status
            .success());
        assert_eq!(commits_empty(&root), Some(true));
        assert!(crate::git_output_raw(
            &root,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "Initial"
            ]
        )
        .unwrap()
        .status
        .success());
        assert_eq!(
            read_status(root.to_str().unwrap()).unwrap().commits_empty,
            Some(false)
        );
        assert!(!root.join(".pi/search/index.sqlite").exists());
        fs::write(root.join(".git/refs/heads/main"), "not-an-object\n").unwrap();
        assert_eq!(commits_empty(&root), None);
        fs::remove_dir_all(root).unwrap();
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
    fn source_databases_are_isolated_and_polling_never_migrates() {
        let root = temp_root();
        let tasks = root.join(".pi/search/tasks.sqlite");
        let db = Connection::open(&tasks).unwrap();
        db.execute_batch("CREATE TABLE pix_task_vectors(hash TEXT); INSERT INTO pix_task_vectors VALUES('paid');").unwrap();
        drop(db);
        let legacy = root.join(".pi/search/index.sqlite");
        fs::write(&legacy, b"preserve legacy bytes").unwrap();
        fs::write(root.join(".pi/search/settings.sqlite"), b"invalid source").unwrap();
        let before = fs::read(&tasks).unwrap();
        for _ in 0..2 {
            let status = read_status(root.to_str().unwrap()).unwrap();
            let source = |id| status.stores.iter().find(|s| s.id == id).unwrap();
            assert_eq!(status.stores.len(), 6);
            assert_eq!(source("settings").state, "error");
            assert_eq!(source("tasks").counts.get("taskVectors"), Some(&1));
            assert_eq!(source("sessions").state, "absent");
        }
        assert_eq!(fs::read(&tasks).unwrap(), before);
        assert_eq!(fs::read(&legacy).unwrap(), b"preserve legacy bytes");
        assert!(!root.join(".pi/search/sessions.sqlite").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_settings_counts_without_creating_other_tables() {
        let root = temp_root();
        let path = root.join(".pi/search/settings.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE documents (hit TEXT); CREATE TABLE vectors (hash TEXT); INSERT INTO documents VALUES ('{\"kind\":\"settings\"}'), ('{\"kind\":\"legacy\"}'); INSERT INTO vectors VALUES ('one');").unwrap();
        drop(db);
        let status = read_status(root.to_str().unwrap()).unwrap();
        let history = &status.stores[2];
        assert_eq!(history.counts.get("settingsDocuments"), Some(&1));
        assert_eq!(history.counts.get("settingsVectors"), Some(&1));
        assert_eq!(history.incompatible_sources, vec!["settings"]);
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
    fn missing_identity_is_reported_only_for_its_source_without_modification() {
        let root = temp_root();
        let path = root.join(".pi/search/settings.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE metadata(key TEXT,value TEXT); CREATE TABLE vectors(hash TEXT); INSERT INTO vectors VALUES('paid');").unwrap();
        let before = fs::read(&path).unwrap();
        let status = read_status(root.to_str().unwrap()).unwrap();
        assert_eq!(status.stores[2].incompatible_sources, vec!["settings"]);
        assert!(status.stores[3].incompatible_sources.is_empty());
        assert_eq!(fs::read(&path).unwrap(), before);
        db.execute_batch("DELETE FROM vectors").unwrap();
        assert!(read_status(root.to_str().unwrap()).unwrap().stores[2].incompatible_sources.is_empty());
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_native_counts_and_flags_malformed_store() {
        let root = temp_root();
        let db = Connection::open(root.join(".pi/search/code.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TABLE pix_native_meta (singleton INTEGER PRIMARY KEY, version INTEGER, root TEXT, generation INTEGER, completed_at TEXT);
             INSERT INTO pix_native_meta VALUES(1,1,'/r',3,'2026-01-01');
             CREATE TABLE pix_native_files (path TEXT, hash TEXT);
             CREATE TABLE pix_native_chunks (id TEXT, path TEXT, kind TEXT, title TEXT, start_line INT, end_line INT, content TEXT, is_test INT);
             INSERT INTO pix_native_chunks VALUES('a','a','code','',1,1,'',0),('b','b','knowledge','',1,1,'',0);",
        )
        .unwrap();
        drop(db);
        fs::write(root.join(".pi/search/settings.sqlite"), b"not a database").unwrap();
        let status = read_status(root.to_str().unwrap()).unwrap();
        let files = &status.stores[0];
        assert_eq!(files.state, "present");
        assert_eq!(files.generation, Some(3));
        assert_eq!(files.counts.get("codeChunks"), Some(&1));
        assert_eq!(files.counts.get("knowledgeChunks"), None);
        assert_eq!(status.stores[1].state, "absent");
        assert_eq!(status.stores[2].state, "error");
        fs::remove_dir_all(root).unwrap();
    }
}

//! Read-only diagnostics for project search stores and the shared Settings cache.
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
    let home = std::env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
        .ok_or("Home directory unavailable")?;
    read_status_with_settings(workspace, &home.join(".config/pi/search"))
}

fn read_status_with_settings(
    workspace: &str,
    settings_directory: &Path,
) -> Result<SearchIndexStatus, String> {
    let root = fs::canonicalize(workspace).map_err(|_| "Selected workspace is unavailable")?;
    let search = root.join(".pi/search");
    let mut usable_dir = true;
    for directory in [root.join(".pi"), search.clone()] {
        match fs::symlink_metadata(directory) {
            Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            }
            Ok(_) => return Err("Search storage directory is unsafe".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                usable_dir = false;
                break;
            }
            Err(_) => return Err("Search storage directory could not be inspected".into()),
        }
    }
    let stores = [
        (
            "code",
            "code.sqlite",
            &[
                ("files", "SELECT count(*) FROM pix_native_files"),
                (
                    "codeChunks",
                    "SELECT count(*) FROM pix_native_chunks WHERE kind='code'",
                ),
                ("vectors", "SELECT count(*) FROM vectors"),
            ][..],
        ),
        (
            "knowledge",
            "knowledge.sqlite",
            &[
                ("files", "SELECT count(*) FROM pix_native_files"),
                (
                    "knowledgeChunks",
                    "SELECT count(*) FROM pix_native_chunks WHERE kind='knowledge'",
                ),
                ("vectors", "SELECT count(*) FROM vectors"),
            ][..],
        ),
        (
            "settings",
            "settings.sqlite",
            &[
                (
                    "settingsDocuments",
                    "SELECT count(*) FROM documents WHERE json_extract(hit, '$.kind')='settings'",
                ),
                ("settingsVectors", "SELECT count(*) FROM vectors"),
            ][..],
        ),
        (
            "sessions",
            "sessions.sqlite",
            &[
                ("sessionTitles", "SELECT count(*) FROM pix_session_titles"),
                ("sessionVectors", "SELECT count(*) FROM pix_session_vectors"),
                ("sessionChunks", "SELECT count(*) FROM pix_session_chunks"),
                (
                    "sessionChunkVectors",
                    "SELECT count(*) FROM pix_session_chunk_vectors",
                ),
            ][..],
        ),
        (
            "tasks",
            "tasks.sqlite",
            &[
                ("taskDocuments", "SELECT count(*) FROM pix_task_documents"),
                ("taskVectors", "SELECT count(*) FROM pix_task_vectors"),
            ][..],
        ),
        (
            "commits",
            "git-commits.sqlite",
            &[
                (
                    "commitDocuments",
                    "SELECT count(*) FROM pix_commit_documents",
                ),
                ("commitVectors", "SELECT count(*) FROM pix_commit_vectors"),
            ][..],
        ),
    ]
    .into_iter()
    .map(|(id, file, queries)| {
        if id != "settings" {
            return inspect_store(id, usable_dir.then(|| search.join(file)), queries);
        }
        for directory in settings_directory.ancestors().take(3) {
            match fs::symlink_metadata(directory) {
                Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                _ => {
                    return fail(
                        inspect_store(id, None, queries),
                        "Unsafe global Settings search directory",
                    )
                }
            }
        }
        inspect_store(id, Some(settings_directory.join(file)), queries)
    })
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
    if metadata.len() > 512 * 1024 * 1024 {
        return fail(status, "Store exceeds the 512 MiB diagnostic limit");
    }
    if !safe_storage_file(&metadata) {
        return fail(status, "Store path is not a regular file");
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        match fs::symlink_metadata(sidecar) {
            Ok(info) if safe_storage_file(&info) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return fail(status, "Store sidecar is unsafe or unavailable"),
        }
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

fn safe_storage_file(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return false;
        }
    }
    metadata.file_type().is_file()
        && !metadata.file_type().is_symlink()
        && metadata.len() <= 512 * 1024 * 1024
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
    // Opening is lazy: force a header read and reject views in owned namespaces
    // before querying them. busy_timeout only bounds lock waits, not execution
    // of an attacker-supplied recursive view masquerading as a count table.
    let owned_views = db.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='view' AND (lower(name) GLOB 'pix_*' OR lower(name)='metadata')",
        [],
        |row| row.get::<_, i64>(0),
    ).map_err(|_| "Store is not a readable SQLite database".to_string())?;
    if owned_views != 0 {
        return Err("Store uses unsupported views in search namespaces".into());
    }
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
    if id == "sessions" {
        // Count cached entities across title-only and transcript-only sessions,
        // without rediscovering or reading any source session files.
        let tables: Vec<&str> = ["pix_session_titles", "pix_session_chunks"]
            .into_iter()
            .filter(|table| {
                db.prepare(&format!("SELECT session_id FROM {table} LIMIT 0"))
                    .is_ok()
            })
            .collect();
        if !tables.is_empty() {
            let union = tables
                .iter()
                .map(|table| format!("SELECT session_id FROM {table}"))
                .collect::<Vec<_>>()
                .join(" UNION ");
            if let Ok(count) = db.query_row(
                &format!("SELECT count(DISTINCT session_id) FROM ({union})"),
                [],
                |row| row.get::<_, i64>(0),
            ) {
                status.counts.insert("sessions", count.max(0) as u64);
            }
        }
    }
    if matches!(id, "settings" | "sessions" | "tasks" | "commits") {
        for (source, count, table) in [
            ("settings", "settingsVectors", "metadata"),
            ("sessions", "sessionVectors", "pix_session_meta"),
            ("tasks", "taskVectors", "pix_task_index_meta"),
            ("commits", "commitVectors", "pix_commit_meta"),
        ] {
            if id != source {
                continue;
            }
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

    fn read_status(workspace: &str) -> Result<SearchIndexStatus, String> {
        read_status_with_settings(workspace, &Path::new(workspace).join(".pi/search"))
    }

    #[test]
    fn settings_cache_is_visible_without_project_search_directory() {
        let root = temp_root();
        let global = root.join("shared/search");
        fs::create_dir_all(&global).unwrap();
        let db = Connection::open(global.join("settings.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE documents(id TEXT,hit TEXT); CREATE TABLE vectors(hash TEXT); INSERT INTO documents VALUES('settings:a','{\"kind\":\"settings\"}'); INSERT INTO vectors VALUES('h');").unwrap();
        drop(db);
        fs::remove_dir_all(root.join(".pi")).unwrap();
        let result = read_status_with_settings(root.to_str().unwrap(), &global).unwrap();
        let settings = result
            .stores
            .iter()
            .find(|row| row.id == "settings")
            .unwrap();
        assert_eq!(settings.state, "present");
        assert_eq!(settings.counts.get("settingsVectors"), Some(&1));
        assert_eq!(
            result
                .stores
                .iter()
                .find(|row| row.id == "code")
                .unwrap()
                .state,
            "absent"
        );
        fs::remove_dir_all(root).unwrap();
    }

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
    #[cfg(unix)]
    fn refuses_redirected_parent_hardlinks_and_sidecars_without_opening_them() {
        use std::os::unix::fs::symlink;
        let root = temp_root();
        let outside = temp_root();
        let original = outside.join("external.sqlite");
        let db = Connection::open(&original).unwrap();
        db.execute_batch("CREATE TABLE pix_task_vectors(hash TEXT); INSERT INTO pix_task_vectors VALUES('retained');").unwrap();
        drop(db);
        let before = fs::read(&original).unwrap();
        let linked = root.join(".pi/search/tasks.sqlite");
        fs::hard_link(&original, &linked).unwrap();
        let status = read_status(root.to_str().unwrap()).unwrap();
        assert_eq!(
            status
                .stores
                .iter()
                .find(|store| store.id == "tasks")
                .unwrap()
                .state,
            "error"
        );
        fs::remove_file(&linked).unwrap();
        fs::copy(&original, &linked).unwrap();
        symlink(&original, root.join(".pi/search/tasks.sqlite-wal")).unwrap();
        let status = read_status(root.to_str().unwrap()).unwrap();
        assert_eq!(
            status
                .stores
                .iter()
                .find(|store| store.id == "tasks")
                .unwrap()
                .state,
            "error"
        );
        fs::rename(root.join(".pi"), root.join("original-pi")).unwrap();
        symlink(outside.join(".pi"), root.join(".pi")).unwrap();
        assert!(read_status(root.to_str().unwrap()).is_err());
        assert_eq!(fs::read(&original).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn rejects_recursive_views_in_search_namespaces_without_executing_them() {
        for (source, name) in [
            ("tasks", "PIX_TASK_VECTORS"),
            ("settings", "metadata"),
            ("code", "pix_native_meta"),
        ] {
            let root = temp_root();
            let path = root.join(format!(".pi/search/{source}.sqlite"));
            let db = Connection::open(&path).unwrap();
            db.execute_batch(&format!("CREATE VIEW {name} AS WITH RECURSIVE nodes(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nodes) SELECT n FROM nodes;")).unwrap();
            drop(db);
            let before = fs::read(&path).unwrap();
            let status = read_status(root.to_str().unwrap()).unwrap();
            let store = status
                .stores
                .iter()
                .find(|store| store.id == source)
                .unwrap();
            assert_eq!(store.state, "error");
            assert!(store
                .error
                .as_deref()
                .unwrap()
                .contains("unsupported views"));
            assert_eq!(fs::read(&path).unwrap(), before);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn oversized_store_reports_its_limit_without_reading_its_contents() {
        let root = temp_root();
        let path = root.join(".pi/search/tasks.sqlite");
        let size = 512 * 1024 * 1024 + 1;
        fs::File::create(&path).unwrap().set_len(size).unwrap();
        let status = read_status(root.to_str().unwrap()).unwrap();
        let tasks = status
            .stores
            .iter()
            .find(|store| store.id == "tasks")
            .unwrap();
        assert_eq!(tasks.state, "error");
        assert!(tasks.error.as_deref().unwrap().contains("512 MiB"));
        assert_eq!(fs::metadata(path).unwrap().len(), size);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_public_message_counts_separately_from_titles_without_mutation() {
        let root = temp_root();
        let path = root.join(".pi/search/sessions.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE pix_session_chunks(session_id TEXT); INSERT INTO pix_session_chunks VALUES('same'),('same'),('other'); CREATE TABLE pix_session_chunk_vectors(hash TEXT); INSERT INTO pix_session_chunk_vectors VALUES('same');").unwrap();
        drop(db);
        let before = fs::read(&path).unwrap();
        let status = read_status(root.to_str().unwrap()).unwrap();
        let sessions = status
            .stores
            .iter()
            .find(|store| store.id == "sessions")
            .unwrap();
        assert_eq!(sessions.counts.get("sessionChunks"), Some(&3));
        assert_eq!(sessions.counts.get("sessionChunkVectors"), Some(&1));
        assert!(!sessions.counts.contains_key("sessionTitles"));
        assert_eq!(sessions.counts.get("sessions"), Some(&2));
        assert_eq!(fs::read(&path).unwrap(), before);
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE pix_session_titles(session_id TEXT); INSERT INTO pix_session_titles VALUES('same'),('title-only');").unwrap();
        drop(db);
        let combined = read_status(root.to_str().unwrap()).unwrap();
        assert_eq!(
            combined
                .stores
                .iter()
                .find(|s| s.id == "sessions")
                .unwrap()
                .counts
                .get("sessions"),
            Some(&3)
        );
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
        assert!(read_status(root.to_str().unwrap()).unwrap().stores[2]
            .incompatible_sources
            .is_empty());
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

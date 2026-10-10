//! SQLite-only project task persistence. SQLite owns all writer coordination.
use super::{empty_task_document, validate_task_document, AttachmentFile, ProjectTask,
    ProjectTaskDocument, ProjectTaskStatus};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Read, path::{Path, PathBuf}, time::Duration};

fn sql_error(error: rusqlite::Error) -> String {
    format!("project task database: {error}")
}

/// SQLite unlinks -wal/-shm on the last connection close. On macOS a concurrent
/// symlink_metadata can return the already-unlinked inode with nlink=0 instead
/// of ENOENT. That inode has no directory entry and is NOT a hard link.
/// Only nlink>1 means an actual extra directory entry that must be rejected.
pub(super) fn validate_sidecar_metadata(name: &str, metadata: &fs::Metadata) -> Result<(), String> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(".pi/{name} must be a project-owned regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return Err(format!(".pi/{name} must not be hard-linked"));
        }
    }
    Ok(())
}

pub(super) fn exists(directory: &Path) -> Result<bool, String> {
    let path = directory.join("tasks.sqlite");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("failed to inspect {}: {error}", path.display())),
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(".pi/tasks.sqlite must be a project-owned regular file".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.nlink() != 1 {
                    return Err(".pi/tasks.sqlite must not be hard-linked".into());
                }
            }
            Ok(true)
        }
    }
}

fn open(directory: &Path, initialize: bool) -> Result<Connection, String> {
    let directory_metadata = fs::symlink_metadata(directory)
        .map_err(|error| format!("failed to inspect project task directory: {error}"))?;
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Err("Project task directory must be a real directory".into());
    }
    // SQLITE_OPEN_NOFOLLOW rejects symlinks anywhere in the pathname, including
    // macOS's system /var -> /private/var alias. Canonicalize verified parents,
    // retain NOFOLLOW on the actual database entry, and inspect its inode below.
    let canonical_directory = fs::canonicalize(directory)
        .map_err(|error| format!("failed to resolve project task directory: {error}"))?;
    let present = exists(directory)?;
    if !present && !initialize {
        return Err("project task database is not initialized".into());
    }
    // SQLite's own sidecars must not redirect writes outside project storage.
    for name in ["tasks.sqlite-wal", "tasks.sqlite-shm"] {
        match fs::symlink_metadata(directory.join(name)) {
            Ok(metadata) => validate_sidecar_metadata(name, &metadata)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to inspect .pi/{name}: {error}")),
        }
    }
    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    if initialize {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    let mut connection = Connection::open_with_flags(canonical_directory.join("tasks.sqlite"), flags)
        .map_err(|error| format!("project task SQLite open: {error}"))?;
    connection.busy_timeout(Duration::from_secs(5)).map_err(|error| format!("project task SQLite busy timeout: {error}"))?;
    connection.pragma_update(None, "foreign_keys", "ON").map_err(|error| format!("project task SQLite foreign keys: {error}"))?;
    if initialize {
        // Concurrent initializers serialize on the same database, not a custom lock.
        connection.pragma_update(None, "journal_mode", "WAL").map_err(sql_error)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let version: i64 = transaction.pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(sql_error)?;
        if version == 0 {
            transaction.execute_batch(
                "CREATE TABLE tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,position INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE attachments(hash TEXT PRIMARY KEY,name TEXT NOT NULL,size INTEGER NOT NULL);
                 CREATE TABLE task_attachments(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, hash TEXT NOT NULL REFERENCES attachments(hash), ordinal INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_id,hash));
                 PRAGMA user_version=1;"
            ).map_err(sql_error)?;
        } else if version != 1 {
            return Err(format!("unsupported project task database version {version}"));
        }
        transaction.commit().map_err(sql_error)?;
    }
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("project task SQLite schema version: {error}"))?;
    if version != 1 {
        return Err(format!("unsupported project task database version {version}"));
    }
    let journal: String = connection.pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(|error| format!("project task SQLite journal mode: {error}"))?;
    if !journal.eq_ignore_ascii_case("wal") {
        connection.pragma_update(None, "journal_mode", "WAL").map_err(sql_error)?;
    }
    Ok(connection)
}

pub(super) fn initialize(directory: &Path) -> Result<(), String> {
    open(directory, true).map(|_| ())
}

pub(super) fn inspect(directory: &Path) -> Result<bool, String> {
    if !exists(directory)? { return Ok(false); }
    let connection = open(directory, false)?;
    connection.prepare("SELECT id,payload,revision,position FROM tasks LIMIT 0").map_err(sql_error)?;
    connection.prepare("SELECT hash,name,size FROM attachments LIMIT 0").map_err(sql_error)?;
    connection.prepare("SELECT task_id,hash,ordinal FROM task_attachments LIMIT 0").map_err(sql_error)?;
    Ok(true)
}

/// Lightweight card badges; query the association table instead of opening
/// and approving each blob just to render the Tasks list.
pub(super) fn attachment_counts(directory: &Path) -> Result<std::collections::HashMap<String, i64>, String> {
    if !exists(directory)? { return Ok(std::collections::HashMap::new()); }
    let connection = open(directory, false)?;
    let mut statement = connection.prepare(
        "SELECT task_id,COUNT(*) FROM task_attachments GROUP BY task_id"
    ).map_err(sql_error)?;
    let mut counts = std::collections::HashMap::new();
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(sql_error)?;
    for row in rows {
        let (id, count) = row.map_err(sql_error)?;
        counts.insert(id, count);
    }
    Ok(counts)
}

/// Read only linked attachment display names for local search; never touch
/// immutable attachment blob paths, contents, or permission scopes.
pub(super) fn attachment_names(directory: &Path) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    if !exists(directory)? { return Ok(std::collections::HashMap::new()); }
    let connection = open(directory, false)?;
    let mut statement = connection.prepare(
        "SELECT t.task_id,a.name FROM task_attachments t JOIN attachments a ON a.hash=t.hash ORDER BY t.task_id,t.ordinal,t.hash"
    ).map_err(sql_error)?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(sql_error)?;
    let mut result = std::collections::HashMap::<String, Vec<String>>::new();
    for row in rows {
        let (id, name) = row.map_err(sql_error)?;
        result.entry(id).or_default().push(name.chars().take(256).collect());
    }
    Ok(result)
}

pub(super) fn read(directory: &Path, max_bytes: u64) -> Result<ProjectTaskDocument, String> {
    if !exists(directory)? { return Ok(empty_task_document()); }
    let connection = open(directory, false)?;
    let mut statement = connection.prepare("SELECT id,payload FROM tasks ORDER BY position ASC,id ASC")
        .map_err(sql_error)?;
    let mut rows = statement.query([]).map_err(sql_error)?;
    let mut document = empty_task_document();
    let mut bytes = 0u64;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let id: String = row.get(0).map_err(sql_error)?;
        let payload: String = row.get(1).map_err(sql_error)?;
        bytes = bytes.saturating_add(payload.len() as u64);
        if bytes > max_bytes || document.tasks.len() >= 10_000 {
            return Err("project task database snapshot exceeds storage limits".into());
        }
        let task: ProjectTask = serde_json::from_str(&payload)
            .map_err(|error| format!("invalid task payload {id}: {error}"))?;
        if task.id != id { return Err(format!("task payload id does not match row id: {id}")); }
        document.tasks.push(task);
    }
    validate_task_document(&document)?;
    Ok(document)
}

pub(super) fn mutate_with_attachments(
    directory: &Path,
    id: &str,
    expected: Option<&ProjectTask>,
    desired: Option<&ProjectTask>,
    attachments: Option<&[AttachmentFile]>,
) -> Result<(), String> {
    if desired.is_none() && attachments.is_some() {
        return Err("cannot attach files to a deleted task".into());
    }
    // Verify all selected blobs BEFORE BEGIN IMMEDIATE so expensive I/O does
    // not hold the SQLite writer transaction. The DB stores only verified
    // project-owned content hashes, never arbitrary webview-supplied paths.
    let mut links = Vec::new();
    if let Some(files) = attachments {
        if files.len() > 10 { return Err("at most ten task attachments are allowed".into()); }
        let mut seen = HashSet::new();
        for file in files {
            let path = Path::new(&file.path);
            let hash = path.file_name().and_then(|value| value.to_str())
                .ok_or("invalid task attachment filename")?;
            if path != directory.join("task-attachments").join(hash) {
                return Err("task attachment must be a project-owned SHA-256 blob".into());
            }
            if file.name.is_empty() || file.name.len() > 1024 ||
                file.name.contains('/') || file.name.contains('\\') || file.name.contains('\0') {
                return Err("invalid task attachment display name".into());
            }
            verified_blob(directory, hash, file.size)?;
            if seen.insert(hash.to_owned()) {
                links.push((hash.to_owned(), file.name.clone(), file.size));
            }
        }
    }
    let mut connection = open(directory, false)?;
    // Capture the row revision, then recheck it under BEGIN IMMEDIATE. Unrelated
    // task revisions never participate in conflict detection.
    let baseline: Option<(String, i64)> = connection.query_row(
        "SELECT payload,revision FROM tasks WHERE id=?1", [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(sql_error)?;
    let current = baseline.as_ref().map(|(payload, _)| serde_json::from_str::<ProjectTask>(payload))
        .transpose().map_err(|error| format!("invalid target task payload: {error}"))?;
    let conflict = || "Task file conflict: target task changed externally. Latest tasks reloaded; your editor draft is preserved. Review before retrying.".to_owned();
    if current.as_ref() != expected { return Err(conflict()); }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_error)?;
    let latest: Option<(String, i64)> = transaction.query_row(
        "SELECT payload,revision FROM tasks WHERE id=?1", [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(sql_error)?;
    if latest != baseline { return Err(conflict()); }
    match (baseline, desired) {
        (Some((_, revision)), Some(task)) => {
            let payload = serde_json::to_string(task).map_err(|error| error.to_string())?;
            let count = transaction.execute("UPDATE tasks SET payload=?1,revision=revision+1 WHERE id=?2 AND revision=?3", params![payload, id, revision]).map_err(sql_error)?;
            if count != 1 { return Err(conflict()); }
        }
        (Some((_, revision)), None) => {
            let count = transaction.execute("DELETE FROM tasks WHERE id=?1 AND revision=?2", params![id, revision]).map_err(sql_error)?;
            if count != 1 { return Err(conflict()); }
        }
        (None, Some(task)) => {
            let payload = serde_json::to_string(task).map_err(|error| error.to_string())?;
            transaction.execute("INSERT INTO tasks(id,payload,position) VALUES(?1,?2,(SELECT COALESCE(MAX(position),-1)+1 FROM tasks))", params![id, payload]).map_err(sql_error)?;
        }
        (None, None) => return Err("task save must mutate exactly one task".into()),
    }
    validate_task_references(&transaction)?;
    if attachments.is_some() {
        transaction.execute("DELETE FROM task_attachments WHERE task_id=?1", [id])
            .map_err(sql_error)?;
        for (ordinal, (hash, name, size)) in links.iter().enumerate() {
            transaction.execute(
                "INSERT INTO attachments(hash,name,size) VALUES(?1,?2,?3) ON CONFLICT(hash) DO NOTHING",
                params![hash, name, size],
            ).map_err(sql_error)?;
            let stored_size: i64 = transaction.query_row(
                "SELECT size FROM attachments WHERE hash=?1", [hash], |row| row.get(0),
            ).map_err(sql_error)?;
            if stored_size != *size as i64 {
                return Err("task attachment hash has conflicting metadata".into());
            }
            transaction.execute(
                "INSERT INTO task_attachments(task_id,hash,ordinal) VALUES(?1,?2,?3)",
                params![id, hash, ordinal as i64],
            ).map_err(sql_error)?;
        }
    }
    transaction.commit().map_err(sql_error)
}

fn validate_task_references(transaction: &rusqlite::Transaction<'_>) -> Result<(), String> {
    // Validate the entire *candidate* document under BEGIN IMMEDIATE, not an
    // earlier UI snapshot: delete/reparent must never strand linked tasks.
    let mut statement = transaction.prepare("SELECT id,payload FROM tasks ORDER BY position,id")
        .map_err(sql_error)?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(sql_error)?;
    let mut tasks = Vec::new();
    for row in rows {
        let (id, payload) = row.map_err(sql_error)?;
        let task: ProjectTask = serde_json::from_str(&payload)
            .map_err(|error| format!("Invalid task {id}: {error}"))?;
        if task.id != id { return Err("Task row and payload ids do not match".into()); }
        tasks.push(task);
    }
    super::validate_task_document(&ProjectTaskDocument { schema: None, version: 1, tasks })
}

/// The GUI deliberately requests a reorder. It can change other rows'
/// *positions*, but never their payloads or revisions. Unlike the restricted
/// agent tool, it may rebalance positions to support unlimited drag-and-drop.
pub(super) fn reorder(
    directory: &Path,
    id: &str,
    target_status: &ProjectTaskStatus,
    target_id: Option<&str>,
    position: &str,
    expected: &ProjectTask,
    updated_at: &str,
) -> Result<(), String> {
    if !matches!(position, "before" | "after") || target_id == Some(id) {
        return Err("invalid task drag target".into());
    }
    if chrono::DateTime::parse_from_rfc3339(updated_at).is_err() {
        return Err("invalid task reorder timestamp".into());
    }
    let mut connection = open(directory, false)?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql_error)?;
    let mut existing = Vec::new();
    {
        let mut statement = tx.prepare(
            "SELECT id,payload,revision,position FROM tasks ORDER BY position ASC,id ASC"
        ).map_err(sql_error)?;
        let mut rows = statement.query([]).map_err(sql_error)?;
        while let Some(row) = rows.next().map_err(sql_error)? {
            let row_id: String = row.get(0).map_err(sql_error)?;
            let payload: String = row.get(1).map_err(sql_error)?;
            let revision: i64 = row.get(2).map_err(sql_error)?;
            let position: i64 = row.get(3).map_err(sql_error)?;
            let task: ProjectTask = serde_json::from_str(&payload)
                .map_err(|error| format!("invalid task payload {row_id}: {error}"))?;
            if task.id != row_id || revision < 1 {
                return Err("invalid task row during reorder".into());
            }
            existing.push((task, revision, position));
            if existing.len() > 10_000 { return Err("task count exceeds the storage limit".into()); }
        }
    }
    let mut document = empty_task_document();
    document.tasks = existing.iter().map(|(task, _, _)| task.clone()).collect();
    validate_task_document(&document)?;
    let moved_index = existing.iter().position(|(task, _, _)| task.id == id)
        .ok_or_else(|| format!("Unknown project task id: {id}"))?;
    if existing[moved_index].0 != *expected {
        return Err("Task file conflict: dragged task changed externally".into());
    }
    let (mut moved, revision, _) = existing.remove(moved_index);
    moved.status = target_status.clone();
    moved.updated_at = updated_at.to_owned();
    // Compute an authoritative ordering from the latest committed transaction
    // instead of trusting a potentially stale array supplied by the webview.
    let statuses = [
        ProjectTaskStatus::InProgress, ProjectTaskStatus::Todo,
        ProjectTaskStatus::Backlog, ProjectTaskStatus::Done, ProjectTaskStatus::Failed,
    ];
    let mut ordered = Vec::with_capacity(existing.len() + 1);
    for status in statuses {
        let mut group = existing.iter().filter(|(task, _, _)| task.status == status)
            .map(|(task, _, _)| task.id.as_str()).collect::<Vec<_>>();
        if status == *target_status {
            let insert_at = if let Some(target) = target_id {
                let at = group.iter().position(|item| *item == target)
                    .ok_or("task drop target no longer exists in that status group")?;
                at + usize::from(position == "after")
            } else { group.len() };
            group.insert(insert_at, id);
        }
        ordered.extend(group);
    }
    if ordered.len() != existing.len() + 1 {
        return Err("task reorder produced an invalid target".into());
    }
    let payload = serde_json::to_string(&moved).map_err(|error| error.to_string())?;
    let affected = tx.execute(
        "UPDATE tasks SET payload=?1,revision=revision+1 WHERE id=?2 AND revision=?3",
        params![payload, id, revision],
    ).map_err(sql_error)?;
    if affected != 1 { return Err("Task file conflict: dragged task changed externally".into()); }
    for (index, row_id) in ordered.iter().enumerate() {
        tx.execute("UPDATE tasks SET position=?1 WHERE id=?2 AND position<>?1",
            params![index as i64, row_id]).map_err(sql_error)?;
    }
    tx.commit().map_err(sql_error)
}

/// Resolve task-owned blob references, never description markers or arbitrary paths.
/// No attachment bytes are returned to the model until the user actually launches the task.
pub(super) fn attachments_for_task(directory: &Path, id: &str) -> Result<Vec<(PathBuf, String, u64)>, String> {
    let connection = open(directory, false)?;
    let found: i64 = connection.query_row("SELECT COUNT(*) FROM tasks WHERE id=?1", [id], |row| row.get(0)).map_err(sql_error)?;
    if found != 1 { return Err(format!("Unknown project task id: {id}")); }
    let mut statement = connection.prepare(
        "SELECT a.hash,a.name,a.size FROM attachments a JOIN task_attachments t ON t.hash=a.hash WHERE t.task_id=?1 ORDER BY t.ordinal ASC,a.hash ASC"
    ).map_err(sql_error)?;
    let mut rows = statement.query([id]).map_err(sql_error)?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(sql_error)? {
        let hash: String = row.get(0).map_err(sql_error)?;
        let name: String = row.get(1).map_err(sql_error)?;
        let size: i64 = row.get(2).map_err(sql_error)?;
        if size < 0 || size > 25 * 1024 * 1024 || name.is_empty() || name.len() > 1024 ||
            !name.bytes().all(|byte| byte != b'/' && byte != b'\\' && byte != 0) {
            return Err("Invalid task attachment metadata".into());
        }
        let blob = verified_blob(directory, &hash, size as u64)?;
        if blob.len() != size as usize { return Err(format!("Task attachment changed: {hash}")); }
        result.push((directory.join("task-attachments").join(&hash), name, size as u64));
    }
    Ok(result)
}

fn verified_blob(directory: &Path, hash: &str, size: u64) -> Result<Vec<u8>, String> {
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
        return Err("Invalid task attachment hash".into());
    }
    let blobs = directory.join("task-attachments");
    let meta = fs::symlink_metadata(&blobs).map_err(|error| format!("task attachment directory: {error}"))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("Unsafe task attachment directory".into());
    }
    let path = blobs.join(hash);
    let metadata = fs::symlink_metadata(&path).map_err(|error| format!("task attachment {hash}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != size || size > 25 * 1024 * 1024 {
        return Err(format!("Unsafe or oversized task attachment: {hash}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        if metadata.nlink() != 1 { return Err("Hard-linked task attachment is not allowed".into()); }
        let mut options = fs::OpenOptions::new();
        options.read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        let file = options.open(&path).map_err(|error| format!("failed to open task attachment {hash}: {error}"))?;
        let opened = file.metadata().map_err(|error| error.to_string())?;
        if !opened.is_file() || opened.ino() != metadata.ino() || opened.dev() != metadata.dev() {
            return Err("Task attachment changed during read".into());
        }
        let mut bytes = Vec::with_capacity(size as usize);
        file.take(size + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        if bytes.len() != size as usize || format!("{:x}", Sha256::digest(&bytes)) != hash {
            return Err(format!("Task attachment checksum mismatch: {hash}"));
        }
        Ok(bytes)
    }
    #[cfg(not(unix))]
    {
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        if bytes.len() != size as usize || format!("{:x}", Sha256::digest(&bytes)) != hash {
            return Err(format!("Task attachment checksum mismatch: {hash}"));
        }
        Ok(bytes)
    }
}

/// A logical, transactionally consistent snapshot: WAL checkpointing and other
/// physical database maintenance must not invalidate Registry resources.
pub(super) fn snapshot(directory: &Path) -> Result<Vec<u8>, String> {
    let mut connection = open(directory, false)?;
    let transaction = connection.transaction().map_err(sql_error)?;
    let mut tasks = Vec::new();
    {
        let mut statement = transaction.prepare("SELECT id,payload,revision,position FROM tasks ORDER BY id ASC").map_err(sql_error)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?))).map_err(sql_error)?;
        for row in rows {
            let (id, payload, revision, position) = row.map_err(sql_error)?;
            let task: ProjectTask = serde_json::from_str(&payload).map_err(|error| format!("invalid task payload {id}: {error}"))?;
            if task.id != id { return Err(format!("task payload id does not match row id: {id}")); }
            let mut document = empty_task_document();
            document.tasks.push(task.clone());
            validate_task_document(&document)?;
            tasks.push(serde_json::json!({"id":id,"payload":serde_json::to_value(task).map_err(|error| error.to_string())?,
                "revision":revision,"position":position}));
        }
    }
    let mut attachments = Vec::new();
    {
        let mut statement = transaction.prepare("SELECT hash,name,size FROM attachments WHERE hash IN (SELECT hash FROM task_attachments) ORDER BY hash ASC").map_err(sql_error)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))).map_err(sql_error)?;
        for row in rows {
            let (hash, name, size): (String, String, i64) = row.map_err(sql_error)?;
            attachments.push(serde_json::json!({"hash":hash,"name":name,"size":size}));
        }
    }
    let mut references = Vec::new();
    {
        let mut statement = transaction.prepare("SELECT task_id,hash,ordinal FROM task_attachments ORDER BY task_id ASC,hash ASC").map_err(sql_error)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))).map_err(sql_error)?;
        for row in rows {
            let (task_id, hash, ordinal): (String, String, i64) = row.map_err(sql_error)?;
            references.push(serde_json::json!({"task_id":task_id,"hash":hash,"ordinal":ordinal}));
        }
    }
    // serde_json objects have stable lexicographic keys, matching Registry's
    // canonical JSON.stringify. Concatenate the same tagged, verified blob bytes
    // so both implementations calculate identical logical hashes independent of WAL.
    let mut digest_input = b"tasks-sqlite-v1\0".to_vec();
    digest_input.extend(serde_json::to_vec(&serde_json::json!({
        "tasks": tasks, "attachments": attachments, "taskAttachments": references
    })).map_err(|error| error.to_string())?);
    let mut statement = transaction.prepare(
        "SELECT a.hash,a.size FROM attachments a WHERE a.hash IN (SELECT hash FROM task_attachments) ORDER BY a.hash ASC"
    ).map_err(sql_error)?;
    let mut rows = statement.query([]).map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let hash: String = row.get(0).map_err(sql_error)?;
        let size: i64 = row.get(1).map_err(sql_error)?;
        if size < 0 { return Err("Invalid task attachment size".into()); }
        digest_input.extend(format!("\0{hash}\0").as_bytes());
        digest_input.extend(verified_blob(directory, &hash, size as u64)?);
    }
    Ok(digest_input)
}

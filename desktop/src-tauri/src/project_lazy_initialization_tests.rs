use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.pi/artifacts")
            .join(format!(
                "lazy-init-{}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
                now_ms()
            ));
        fs::create_dir_all(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn empty_project_reads_do_not_create_storage_or_gitignore() {
    let workspace = Workspace::new();
    assert_eq!(
        read_project_tasks_from(&workspace.0, MAX_TASK_DOCUMENT_BYTES).unwrap(),
        empty_task_document()
    );
    assert!(
        read_project_tasks_panel_from(&workspace.0, MAX_TASK_DOCUMENT_BYTES)
            .unwrap()
            .document
            .tasks
            .is_empty()
    );
    let documents = list_project_documents_from(&workspace.0).unwrap();
    assert!(documents.plans.is_empty());
    assert!(!documents.todo_exists);
    assert!(!project_pi_initialized_from(&workspace.0).unwrap());
    let root = workspace.0.to_string_lossy().into_owned();
    assert!(
        tauri::async_runtime::block_on(read_project_task_attachment_counts(root.clone()))
            .unwrap()
            .is_empty()
    );
    assert!(
        tauri::async_runtime::block_on(read_project_task_attachment_names(root))
            .unwrap()
            .is_empty()
    );
    assert_eq!(fs::read_dir(&workspace.0).unwrap().count(), 0);
}

#[test]
fn first_task_creates_only_database_and_ignore_rule() {
    let workspace = Workspace::new();
    let desired = tests::sample_task_document();
    write_project_tasks_checked_with_attachments(
        &workspace.0,
        &desired,
        Some(&empty_task_document()),
        None,
    )
    .unwrap();
    assert_eq!(
        read_project_tasks_from(&workspace.0, MAX_TASK_DOCUMENT_BYTES).unwrap(),
        desired
    );
    assert!(!workspace.0.join(".pi/plans").exists());
    assert!(!workspace.0.join(".pi/task-attachments").exists());
    assert!(fs::read_dir(workspace.0.join(".pi"))
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".tasks-init-")));
    assert_eq!(
        fs::read_to_string(workspace.0.join(".gitignore")).unwrap(),
        "/.pi/\n"
    );
}

#[test]
fn first_plan_creates_only_its_directories() {
    let workspace = Workspace::new();
    write_project_markdown_from(
        &workspace.0,
        Path::new(".pi/plans/nested/first.md"),
        "# First\n",
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(workspace.0.join(".pi/plans/nested/first.md")).unwrap(),
        "# First\n"
    );
    assert!(!workspace.0.join(".pi/tasks.sqlite").exists());
    assert!(!workspace.0.join(".pi/task-attachments").exists());
}

#[test]
fn first_settings_save_does_not_create_tasks_or_plans() {
    let workspace = Workspace::new();
    write_project_workspace_config_from(&workspace.0, "{}\n").unwrap();
    assert!(workspace.0.join(".pi/workspace.jsonc").is_file());
    assert!(!workspace.0.join(".pi/tasks.sqlite").exists());
    assert!(!workspace.0.join(".pi/plans").exists());
    assert_eq!(
        fs::read_to_string(workspace.0.join(".gitignore")).unwrap(),
        "/.pi/\n"
    );
}

#[test]
fn attachments_can_precede_the_first_task() {
    let workspace = Workspace::new();
    let directory = task_blob_directory(&workspace.0).unwrap();
    assert!(!workspace.0.join(".pi/tasks.sqlite").exists());
    let bytes = b"first task attachment";
    let path = persist_immutable_task_attachment(&directory, "draft.txt", bytes).unwrap();
    let attachment = AttachmentFile {
        path: path.to_string_lossy().into_owned(),
        name: "draft.txt".into(),
        size: bytes.len() as u64,
    };
    let document = tests::sample_task_document();
    write_project_tasks_checked_with_attachments(
        &workspace.0,
        &document,
        Some(&empty_task_document()),
        Some(&[attachment]),
    )
    .unwrap();
    assert_eq!(
        project_tasks_sqlite::attachment_counts(&workspace.0.join(".pi"))
            .unwrap()
            .get("task-1"),
        Some(&1)
    );
}

#[test]
fn invalid_task_and_stale_update_do_not_initialize_storage() {
    let workspace = Workspace::new();
    let expected = tests::sample_task_document();
    let mut desired = expected.clone();
    desired.version = 99;
    assert!(
        write_project_tasks_checked_with_attachments(&workspace.0, &desired, None, None).is_err()
    );
    desired = expected.clone();
    desired.tasks[0].title = "Edited stale task".into();
    assert!(write_project_tasks_checked_with_attachments(
        &workspace.0,
        &desired,
        Some(&expected),
        None
    )
    .is_err());
    assert!(write_project_tasks_checked_with_attachments(
        &workspace.0,
        &empty_task_document(),
        Some(&expected),
        None
    )
    .is_err());
    assert_eq!(fs::read_dir(&workspace.0).unwrap().count(), 0);
}

#[test]
fn malformed_database_is_not_reinitialized() {
    let workspace = Workspace::new();
    fs::create_dir(workspace.0.join(".pi")).unwrap();
    fs::write(workspace.0.join(".pi/tasks.sqlite"), "not a database").unwrap();
    assert!(write_project_tasks_checked_with_attachments(
        &workspace.0,
        &tests::sample_task_document(),
        None,
        None
    )
    .is_err());
    assert_eq!(
        fs::read_to_string(workspace.0.join(".pi/tasks.sqlite")).unwrap(),
        "not a database"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn initialization_does_not_repair_an_existing_version_zero_database() {
    let workspace = Workspace::new();
    let directory = ensure_project_pi_directory(&workspace.0).unwrap();
    let path = directory.join("tasks.sqlite");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch("CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES('keep');")
        .unwrap();
    connection.close().unwrap();
    let before = fs::read(&path).unwrap();
    assert!(initialize_project_tasks_file(&directory)
        .unwrap_err()
        .contains("version 0"));
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn ignore_preserves_existing_rules_newlines_and_is_idempotent() {
    for original in [
        "# existing\r\nnode_modules",
        "# existing\nnode_modules\n",
        ".pi/\n",
        "/.pi\n",
        ".pi\n",
        "/.pi/\n",
    ] {
        let workspace = Workspace::new();
        let ignore = workspace.0.join(".gitignore");
        fs::write(&ignore, original).unwrap();
        ensure_project_pi_directory(&workspace.0).unwrap();
        let saved = fs::read_to_string(&ignore).unwrap();
        let expected = match original {
            "# existing\r\nnode_modules" => "# existing\r\nnode_modules\r\n/.pi/\r\n",
            "# existing\nnode_modules\n" => "# existing\nnode_modules\n/.pi/\n",
            other => other,
        };
        assert_eq!(saved, expected);
        fs::remove_dir(workspace.0.join(".pi")).unwrap();
        ensure_project_pi_directory(&workspace.0).unwrap();
        assert_eq!(fs::read_to_string(ignore).unwrap(), saved);
    }
}

#[test]
fn concurrent_first_plan_saves_preserve_every_document_and_one_ignore_rule() {
    let workspace = Workspace::new();
    let start = Arc::new(std::sync::Barrier::new(8));
    let workers = (0..8)
        .map(|index| {
            let root = workspace.0.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                write_project_markdown_from(
                    &root,
                    Path::new(&format!(".pi/plans/{index}.md")),
                    "# Plan\n",
                )
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().unwrap().unwrap();
    }
    assert_eq!(
        list_project_documents_from(&workspace.0)
            .unwrap()
            .plans
            .len(),
        8
    );
    assert_eq!(
        fs::read_to_string(workspace.0.join(".gitignore")).unwrap(),
        "/.pi/\n"
    );
}

#[test]
fn concurrent_first_task_creates_do_not_overwrite_other_rows() {
    let workspace = Workspace::new();
    let start = Arc::new(std::sync::Barrier::new(8));
    let workers = (0..8)
        .map(|index| {
            let root = workspace.0.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                let mut document = tests::sample_task_document();
                document.tasks[0].id = format!("task-{index}");
                start.wait();
                write_project_tasks_checked_with_attachments(
                    &root,
                    &document,
                    Some(&empty_task_document()),
                    None,
                )
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().unwrap().unwrap();
    }
    assert_eq!(
        read_project_tasks_from(&workspace.0, MAX_TASK_DOCUMENT_BYTES)
            .unwrap()
            .tasks
            .len(),
        8
    );
}

#[cfg(unix)]
#[test]
fn unsafe_pi_and_gitignore_are_never_followed() {
    use std::os::unix::fs::symlink;
    let outside = Workspace::new();
    for target in [".pi", ".gitignore"] {
        let workspace = Workspace::new();
        symlink(&outside.0, workspace.0.join(target)).unwrap();
        assert!(ensure_project_pi_directory(&workspace.0).is_err());
        assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 0);
    }
    let workspace = Workspace::new();
    let outside_ignore = outside.0.join("ignore");
    fs::write(&outside_ignore, "keep\n").unwrap();
    fs::hard_link(&outside_ignore, workspace.0.join(".gitignore")).unwrap();
    assert!(ensure_project_pi_directory(&workspace.0).is_err());
    assert_eq!(fs::read_to_string(outside_ignore).unwrap(), "keep\n");
    assert!(!workspace.0.join(".pi").exists());
}

#[cfg(unix)]
#[test]
fn permission_denied_is_reported_without_creating_state() {
    use std::os::unix::fs::PermissionsExt;
    // These are real permission checks, not mocks or silently skipped assertions.
    assert_ne!(
        unsafe { libc::geteuid() },
        0,
        "run permission tests as an unprivileged user"
    );
    let workspace = Workspace::new();
    fs::set_permissions(&workspace.0, fs::Permissions::from_mode(0o500)).unwrap();
    let task = write_project_tasks_checked_with_attachments(
        &workspace.0,
        &tests::sample_task_document(),
        None,
        None,
    );
    let plan =
        write_project_markdown_from(&workspace.0, Path::new(".pi/plans/first.md"), "# First\n");
    let settings = write_project_workspace_config_from(&workspace.0, "{}\n");
    fs::set_permissions(&workspace.0, fs::Permissions::from_mode(0o700)).unwrap();
    for result in [task, plan.map(|_| ()), settings.map(|_| ())] {
        let error = result.expect_err("read-only workspace must reject writes");
        assert!(error.contains(".gitignore"), "{error}");
        assert!(
            error.to_lowercase().contains("permission denied"),
            "{error}"
        );
    }
    assert_eq!(fs::read_dir(&workspace.0).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn readonly_gitignore_blocks_private_storage_without_changing_rules() {
    use std::os::unix::fs::PermissionsExt;
    assert_ne!(unsafe { libc::geteuid() }, 0);
    let workspace = Workspace::new();
    let ignore = workspace.0.join(".gitignore");
    fs::write(&ignore, "keep\n").unwrap();
    fs::set_permissions(&ignore, fs::Permissions::from_mode(0o400)).unwrap();
    let result = ensure_project_pi_directory(&workspace.0);
    fs::set_permissions(&ignore, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(result.unwrap_err().contains(".gitignore"));
    assert_eq!(fs::read_to_string(ignore).unwrap(), "keep\n");
    assert!(!workspace.0.join(".pi").exists());
}

use super::*;

struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.pi/artifacts/file-history-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn write(&self, path: &str, content: &str) {
        fs::write(self.0.join(path), content).unwrap();
    }
    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.0.join(path)).unwrap()
    }
    fn exists(&self, path: &str) -> bool {
        self.0.join(path).exists()
    }
    fn create(&self, name: &str) -> Receipt {
        execute(
            &self.0,
            Request::Create {
                parent: "".into(),
                name: name.into(),
                kind: ProjectTreeEntryKind::File,
            },
        )
        .unwrap()
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        if let Ok(mut records) = MUTATIONS.lock() {
            records.retain(|_, record| record.workspace != self.0);
        }
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn create_and_copy_keep_safe_saved_edits_through_undo_redo() {
    let w = Workspace::new();
    let created = w.create("created.txt");
    w.write("replacement", "edited");
    fs::rename(w.0.join("replacement"), w.0.join("created.txt")).unwrap();
    replay(&w.0, &created.token, true).unwrap();
    assert!(!w.exists("created.txt"));
    replay(&w.0, &created.token, false).unwrap();
    assert_eq!(w.read("created.txt"), "edited");
    let copied = execute(
        &w.0,
        Request::Copy {
            paths: vec!["created.txt".into()],
            destination: "".into(),
            source_workspace: None,
        },
    )
    .unwrap();
    let path = &copied.entries[0].path;
    w.write(path, "copy edits");
    replay(&w.0, &copied.token, true).unwrap();
    w.write("created.txt", "changed source");
    replay(&w.0, &copied.token, false).unwrap();
    assert_eq!(w.read(path), "copy edits");
    assert_eq!(w.read("created.txt"), "changed source");
}

#[test]
fn nested_selection_moves_once_and_batch_delete_restores_contents() {
    let w = Workspace::new();
    fs::create_dir_all(w.0.join("folder/sub")).unwrap();
    fs::create_dir(w.0.join("target")).unwrap();
    w.write("folder/sub/file", "nested");
    w.write("other", "other");
    let moved = execute(
        &w.0,
        Request::Move {
            paths: vec!["folder/sub/file".into(), "folder".into(), "other".into()],
            destination: "target".into(),
        },
    )
    .unwrap();
    assert_eq!(moved.changes.len(), 2);
    assert_eq!(w.read("target/folder/sub/file"), "nested");
    replay(&w.0, &moved.token, true).unwrap();
    assert_eq!(w.read("folder/sub/file"), "nested");
    replay(&w.0, &moved.token, false).unwrap();
    let deleted = execute(
        &w.0,
        Request::Delete {
            paths: vec!["target/folder".into(), "target/other".into()],
        },
    )
    .unwrap();
    assert!(!w.exists("target/folder"));
    replay(&w.0, &deleted.token, true).unwrap();
    assert_eq!(w.read("target/folder/sub/file"), "nested");
    assert_eq!(w.read("target/other"), "other");
}

#[test]
fn conflicts_are_preflighted_and_late_collisions_retain_an_undoable_prefix() {
    let w = Workspace::new();
    fs::create_dir(w.0.join("target")).unwrap();
    w.write("one", "one");
    w.write("two", "two");
    w.write("target/two", "occupied");
    assert!(execute(
        &w.0,
        Request::Move {
            paths: vec!["one".into(), "two".into()],
            destination: "target".into()
        }
    )
    .is_err());
    assert!(w.exists("one"));
    fs::remove_file(w.0.join("target/two")).unwrap();
    let receipt = execute_with(
        &w.0,
        Request::Move {
            paths: vec!["one".into(), "two".into()],
            destination: "target".into(),
        },
        |index| {
            if index == 1 {
                w.write("target/two", "racer");
            }
        },
    )
    .unwrap();
    assert!(receipt.warning.is_some());
    assert_eq!(receipt.changes.len(), 1);
    assert_eq!(w.read("target/two"), "racer");
    replay(&w.0, &receipt.token, true).unwrap();
    assert_eq!(w.read("one"), "one");
    assert_eq!(w.read("two"), "two");
}

#[test]
fn partial_undo_can_retry_without_replaying_already_completed_steps() {
    let w = Workspace::new();
    w.write("one", "one");
    w.write("two", "two");
    let deleted = execute(
        &w.0,
        Request::Delete {
            paths: vec!["one".into(), "two".into()],
        },
    )
    .unwrap();
    let partial = replay_with(&w.0, &deleted.token, true, |index| {
        if index == 0 {
            w.write("one", "occupied");
        }
    })
    .unwrap();
    assert!(!partial.complete);
    assert!(partial.warning.is_some());
    assert_eq!(w.read("two"), "two");
    assert_eq!(w.read("one"), "occupied");
    fs::remove_file(w.0.join("one")).unwrap();
    assert!(replay(&w.0, &deleted.token, true).unwrap().complete);
    assert_eq!(w.read("one"), "one");
    replay(&w.0, &deleted.token, false).unwrap();
    assert!(!w.exists("one"));
    assert!(!w.exists("two"));
}

#[test]
fn protects_replaced_folders_missing_slots_links_and_metadata() {
    use std::os::unix::fs::symlink;
    let w = Workspace::new();
    fs::create_dir(w.0.join("folder")).unwrap();
    let renamed = execute(
        &w.0,
        Request::Rename {
            path: "folder".into(),
            name: "renamed".into(),
        },
    )
    .unwrap();
    fs::rename(w.0.join("renamed"), w.0.join("original")).unwrap();
    fs::create_dir(w.0.join("renamed")).unwrap();
    assert!(replay(&w.0, &renamed.token, true).is_err());
    assert!(w.exists("renamed"));
    w.write("file", "data");
    let deleted = execute(
        &w.0,
        Request::Delete {
            paths: vec!["file".into()],
        },
    )
    .unwrap();
    fs::remove_file(w.0.join(STORAGE).join(&deleted.token).join("data-0")).unwrap();
    assert!(replay(&w.0, &deleted.token, true).is_err());
    symlink(w.0.join("original"), w.0.join("alias")).unwrap();
    for path in ["alias", ".pi", ".PI/FILE-HISTORY", "../outside"] {
        assert!(
            execute(
                &w.0,
                Request::Delete {
                    paths: vec![path.into()]
                }
            )
            .is_err(),
            "{path}"
        );
    }
    assert!(execute(
        &w.0,
        Request::Move {
            paths: vec!["original".into()],
            destination: "original".into()
        }
    )
    .is_err());
}

#[test]
fn history_is_hidden_ignored_and_survives_manual_and_ttl_cleanup() {
    let w = Workspace::new();
    w.create("file");
    let folder = w.0.join(STORAGE).join("retained-user-data");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join(".DS_Store"), "user data").unwrap();
    fs::write(folder.join(".markdown.user.tmp"), "user data").unwrap();
    crate::clean_project_pi_from(&w.0).unwrap();
    crate::auto_clean_project_pi_from(&w.0).unwrap();
    assert_eq!(
        fs::read_to_string(folder.join(".DS_Store")).unwrap(),
        "user data"
    );
    assert!(folder.join(".markdown.user.tmp").exists());
    assert_eq!(w.read(".pi/file-history/.gitignore"), "*\n");
    let entries = crate::list_project_directory_from(&w.0, Some(Path::new(".pi"))).unwrap();
    assert!(!entries.iter().any(|e| e.name == "file-history"));
    assert!(crate::search_project_files_from(&w.0, "retained-user-data")
        .unwrap()
        .is_empty());
}

#[test]
fn cross_workspace_copy_and_simultaneous_replay_never_touch_the_source_or_overwrite() {
    let source = Workspace::new();
    let target = Workspace::new();
    source.write("file", "source");
    let copy = execute(
        &target.0,
        Request::Copy {
            paths: vec!["file".into()],
            destination: "".into(),
            source_workspace: Some(source.0.to_string_lossy().into_owned()),
        },
    )
    .unwrap();
    std::thread::scope(|scope| {
        let one = scope.spawn(|| replay(&target.0, &copy.token, true));
        let two = scope.spawn(|| replay(&target.0, &copy.token, true));
        assert!(one.join().unwrap().unwrap().complete);
        assert!(two.join().unwrap().unwrap().complete);
    });
    assert_eq!(source.read("file"), "source");
    assert!(!target.exists("file"));
    forget(vec![copy.token.clone()]);
    assert!(replay(&target.0, &copy.token, false).is_err());
    assert!(target.exists(&format!("{STORAGE}/{}/data-0", copy.token)));
}

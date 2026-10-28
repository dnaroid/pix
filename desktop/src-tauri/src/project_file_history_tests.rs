use super::*;

fn finder_copy(paths: &[PathBuf], destination: &str) -> Request {
    Request::Copy {
        paths: paths
            .iter()
            .map(|path| path.strip_prefix("/").unwrap().to_str().unwrap().to_owned())
            .collect(),
        destination: destination.into(),
        source_workspace: Some("/".into()),
    }
}

fn finder_move(paths: &[PathBuf], destination: &str) -> Request {
    Request::ImportMove {
        paths: paths
            .iter()
            .map(|path| path.strip_prefix("/").unwrap().to_str().unwrap().to_owned())
            .collect(),
        destination: destination.into(),
        source_workspace: "/".into(),
    }
}

#[test]
fn finder_moves_are_reversible_across_parents_and_keep_receipts_workspace_relative() {
    let source = Workspace::new();
    let target = Workspace::new();
    fs::create_dir_all(source.0.join("папка/sub")).unwrap();
    source.write("a #%.txt", "one");
    source.write("папка/sub/file", "two");
    let receipt = execute(
        &target.0,
        finder_move(
            &[
                source.0.join("a #%.txt"),
                source.0.join("папка"),
                source.0.join("папка/sub/file"),
            ],
            "",
        ),
    )
    .unwrap();
    assert_eq!(receipt.changes.len(), 2);
    assert!(receipt.changes.iter().all(|change| change.before.is_none()));
    assert!(!source.exists("a #%.txt"));
    assert!(!source.exists("папка"));
    assert_eq!(target.read("папка/sub/file"), "two");
    let undo = replay(&target.0, &receipt.token, true).unwrap();
    assert!(undo.complete);
    assert!(undo.entries.is_empty());
    assert!(undo.changes.iter().all(|change| change.after.is_none()));
    assert_eq!(source.read("a #%.txt"), "one");
    assert_eq!(source.read("папка/sub/file"), "two");
    assert!(!target.exists("папка"));
    replay(&target.0, &receipt.token, false).unwrap();
    assert_eq!(target.read("a #%.txt"), "one");
    assert!(!source.exists("a #%.txt"));
}

#[test]
fn finder_move_refuses_collisions_and_never_overwrites_original_on_undo() {
    let source = Workspace::new();
    let target = Workspace::new();
    source.write("file", "source");
    target.write("file", "target");
    assert!(execute(&target.0, finder_move(&[source.0.join("file")], "")).is_err());
    assert_eq!(source.read("file"), "source");
    assert_eq!(target.read("file"), "target");
    fs::remove_file(target.0.join("file")).unwrap();
    let receipt = execute(&target.0, finder_move(&[source.0.join("file")], "")).unwrap();
    source.write("file", "replacement");
    assert!(replay(&target.0, &receipt.token, true).is_err());
    assert_eq!(source.read("file"), "replacement");
    assert_eq!(target.read("file"), "source");
}

#[test]
fn finder_move_rejects_links_recursion_and_foreign_metadata() {
    use std::os::unix::fs::symlink;
    let source = Workspace::new();
    let target = Workspace::new();
    fs::create_dir_all(source.0.join("folder/sub")).unwrap();
    fs::create_dir_all(source.0.join(".git")).unwrap();
    source.write(".git/config", "protected");
    source.write("file", "source");
    symlink(source.0.join("folder"), source.0.join("link")).unwrap();
    for path in [
        source.0.join("link"),
        source.0.join(".git/config"),
        source.0.join(".git"),
        target.0.clone(),
    ] {
        assert!(execute(&target.0, finder_move(&[path], "")).is_err());
    }
    assert!(execute(
        &source.0,
        finder_move(&[source.0.join("folder")], "folder/sub")
    )
    .is_err());
    fs::create_dir(target.0.join("target")).unwrap();
    let receipt = execute(&target.0, finder_move(&[source.0.join("file")], "target")).unwrap();
    symlink(&target.0, source.0.join("linked-parent")).unwrap();
    // Undo refuses to follow a replaced original parent through a symlink.
    let source2 = Workspace::new();
    fs::create_dir(source2.0.join("parent")).unwrap();
    source2.write("parent/other", "other");
    let second = execute(
        &target.0,
        finder_move(&[source2.0.join("parent/other")], "target"),
    )
    .unwrap();
    fs::remove_dir(source2.0.join("parent")).unwrap();
    symlink(&source.0, source2.0.join("parent")).unwrap();
    assert!(replay(&target.0, &second.token, true).is_err());
    assert_eq!(target.read("target/other"), "other");
    replay(&target.0, &receipt.token, true).unwrap();
    assert_eq!(source.read("file"), "source");
}

#[test]
fn finder_move_partial_success_remains_undoable_and_local_paths_are_remapped() {
    let source = Workspace::new();
    let target = Workspace::new();
    source.write("a", "one");
    target.write("local", "two");
    fs::create_dir(target.0.join("dest")).unwrap();
    let request = finder_move(&[source.0.join("a"), target.0.join("local")], "dest");
    let receipt = execute_with(&target.0, request, |index| {
        if index == 1 {
            target.write("dest/local", "racing file");
        }
    })
    .unwrap();
    assert_eq!(receipt.changes.len(), 1);
    assert!(receipt.warning.is_some());
    replay(&target.0, &receipt.token, true).unwrap();
    assert_eq!(source.read("a"), "one");
    fs::remove_file(target.0.join("dest/local")).unwrap();
    let local = execute(&target.0, finder_move(&[target.0.join("local")], "dest")).unwrap();
    assert_eq!(local.changes[0].before.as_deref(), Some("local"));
    let undo = replay(&target.0, &local.token, true).unwrap();
    assert_eq!(undo.changes[0].after.as_deref(), Some("local"));
    assert_eq!(target.read("local"), "two");
}

#[test]
fn finder_batch_copies_files_and_folders_from_different_parents_with_undo() {
    let source = Workspace::new();
    let target = Workspace::new();
    fs::create_dir_all(source.0.join("папка/sub")).unwrap();
    fs::create_dir(source.0.join("other")).unwrap();
    fs::create_dir(target.0.join("target")).unwrap();
    source.write("a #%.txt", "one");
    source.write("other/a #%.txt", "two");
    source.write("папка/sub/file", "nested");
    target.write("target/a #%.txt", "existing");
    let paths = [
        source.0.join("a #%.txt"),
        source.0.join("other/a #%.txt"),
        source.0.join("папка"),
        source.0.join("папка/sub/file"),
    ];
    let receipt = execute(&target.0, finder_copy(&paths, "target")).unwrap();
    assert_eq!(receipt.changes.len(), 3); // A selected descendant is copied with its parent.
    assert_eq!(target.read("target/a #%.txt"), "existing");
    assert_eq!(target.read(&receipt.entries[0].path), "one");
    assert_eq!(target.read(&receipt.entries[1].path), "two");
    assert_eq!(target.read("target/папка/sub/file"), "nested");
    assert_eq!(source.read("a #%.txt"), "one");
    replay(&target.0, &receipt.token, true).unwrap();
    assert!(!target.exists("target/папка"));
    assert_eq!(target.read("target/a #%.txt"), "existing");
    source.write("a #%.txt", "changed source");
    replay(&target.0, &receipt.token, false).unwrap();
    assert_eq!(target.read(&receipt.entries[0].path), "one");
}

#[test]
fn finder_copy_rejects_recursion_protected_destinations_and_missing_sources() {
    let source = Workspace::new();
    let target = Workspace::new();
    fs::create_dir_all(source.0.join("folder/sub")).unwrap();
    assert!(execute(
        &source.0,
        finder_copy(&[source.0.join("folder")], "folder/sub")
    )
    .is_err());
    // Staging lives under .pi/file-history, so copying .pi itself would recurse
    // even when the requested destination is the workspace root.
    assert!(execute(&source.0, finder_copy(&[source.0.join(".pi")], "")).is_err());
    assert!(execute(&target.0, finder_copy(&[source.0.join("missing")], "")).is_err());
    source.write("file", "source");
    fs::create_dir(target.0.join(".git")).unwrap();
    assert!(execute(&target.0, finder_copy(&[source.0.join("file")], ".git")).is_err());
    assert!(execute(
        &target.0,
        finder_copy(&[source.0.join("file")], "../escape")
    )
    .is_err());
}

#[test]
fn finder_copy_rejects_symlinks_and_keeps_a_late_successful_prefix_undoable() {
    use std::os::unix::fs::symlink;
    let source = Workspace::new();
    let target = Workspace::new();
    source.write("file", "source");
    symlink(source.0.join("file"), source.0.join("link")).unwrap();
    assert!(execute(
        &target.0,
        finder_copy(&[source.0.join("file"), source.0.join("link")], "")
    )
    .is_err());
    assert!(!target.exists("file"));
    fs::create_dir(source.0.join("folder")).unwrap();
    symlink(source.0.join("file"), source.0.join("folder/link")).unwrap();
    let receipt = execute(
        &target.0,
        finder_copy(&[source.0.join("file"), source.0.join("folder")], ""),
    )
    .unwrap();
    assert!(receipt.warning.is_some());
    assert_eq!(receipt.changes.len(), 1);
    assert!(!target.exists("folder"));
    replay(&target.0, &receipt.token, true).unwrap();
    assert!(!target.exists("file"));
    assert_eq!(source.read("file"), "source");
}

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

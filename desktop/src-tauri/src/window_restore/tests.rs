use super::*;

#[test]
fn native_window_title_identifies_the_current_project() {
    assert_eq!(workspace_window_title("/projects/pix"), "Pix — pix");
    assert_eq!(
        workspace_window_title("/projects/Мой проект/"),
        "Pix — Мой проект"
    );
    assert_eq!(workspace_window_title("/"), "Pix — /");
    assert_eq!(workspace_window_title(""), "Pix");
}

#[test]
fn qa_restore_opt_in_never_uses_user_membership_storage() {
    assert_eq!(snapshot_file(false, false, false), Some(FILE_NAME));
    assert_eq!(snapshot_file(false, false, true), Some(FILE_NAME));
    assert_eq!(snapshot_file(true, false, false), None);
    assert_eq!(snapshot_file(true, false, true), Some(QA_FILE_NAME));
    assert_eq!(snapshot_file(false, true, true), None);
    assert_eq!(snapshot_file(true, true, true), None);
}

#[test]
fn closing_one_window_excludes_it_but_last_window_is_retained() {
    let mut registry = Registry::default();
    registry.update("main", "/a".into());
    registry.update("project-1", "/b".into());
    registry.destroyed("main", true);
    registry.destroyed("project-1", false);
    let snapshot = registry.freeze();
    assert_eq!(
        snapshot.windows,
        vec![SavedWindow {
            label: "project-1".into(),
            workspace: "/b".into(),
            geometry: None,
        }]
    );
    assert_eq!(snapshot.closed_windows[0].label, "main");
}

fn with_closed_project() -> Registry {
    let mut registry = Registry::default();
    registry.update("main", "/host".into());
    registry.update("project-old", "/project".into());
    registry.destroyed("project-old", true);
    registry
}

#[test]
fn reopening_project_reuses_closed_identity_but_not_an_open_window() {
    let mut registry = with_closed_project();
    let reopened = registry
        .begin_open("project-new".into(), "/project".into())
        .unwrap();
    assert_eq!(reopened.label, "project-old");
    assert!(registry.finish_open(reopened, true));
    let second = registry
        .begin_open("project-second".into(), "/project".into())
        .unwrap();
    assert_eq!(second.label, "project-second");
    assert!(registry.finish_open(second, true));
    assert_eq!(registry.windows.len(), 3);
    assert!(registry.closed_windows.is_empty());
}

#[test]
fn reopening_uses_most_recent_matching_closed_window_and_its_geometry() {
    let mut registry = with_closed_project();
    registry.update("project-newer", "/project".into());
    let geometry = Geometry {
        width: 1100.0,
        height: 750.0,
        x: 40.0,
        y: -900.0,
    };
    registry.geometry("project-newer", geometry);
    registry.destroyed("project-newer", true);
    let reopened = registry
        .begin_open("project-request".into(), "/project".into())
        .unwrap();
    assert_eq!(reopened.label, "project-newer");
    assert_eq!(reopened.geometry, Some(geometry));
    assert_eq!(registry.closed_windows[0].label, "project-old");
}

#[test]
fn closed_identity_survives_quit_and_relaunch_without_auto_opening() {
    let mut registry = with_closed_project();
    let snapshot = parse(&serde_json::to_vec(&registry.freeze()).unwrap()).unwrap();
    assert_eq!(snapshot.windows.len(), 1);
    assert_eq!(snapshot.windows[0].label, "main");
    let mut next = Registry {
        closed_windows: snapshot.closed_windows,
        ..Registry::default()
    };
    for window in snapshot.windows {
        next.update(&window.label, window.workspace);
    }
    let reopened = next
        .begin_open("project-new".into(), "/project".into())
        .unwrap();
    assert_eq!(reopened.label, "project-old");
}

#[test]
fn concurrent_openings_cannot_claim_the_same_closed_identity() {
    let mut registry = with_closed_project();
    let first = registry
        .begin_open("project-first".into(), "/project".into())
        .unwrap();
    let second = registry
        .begin_open("project-second".into(), "/project".into())
        .unwrap();
    assert_eq!(first.label, "project-old");
    assert_eq!(second.label, "project-second");
    assert!(registry
        .begin_open("project-old".into(), "/project".into())
        .is_err());
    assert!(registry.finish_open(second, true));
    assert!(registry.finish_open(first, true));
}

#[test]
fn failed_creation_releases_the_closed_identity_for_retry() {
    let mut registry = with_closed_project();
    let first = registry
        .begin_open("project-first".into(), "/project".into())
        .unwrap();
    assert!(!registry.finish_open(first, false));
    let retry = registry
        .begin_open("project-retry".into(), "/project".into())
        .unwrap();
    assert_eq!(retry.label, "project-old");
}

#[test]
fn quit_during_creation_retains_closed_identity_and_rejects_late_completion() {
    let mut registry = with_closed_project();
    let pending = registry
        .begin_open("project-new".into(), "/project".into())
        .unwrap();
    let snapshot = registry.freeze();
    assert_eq!(snapshot.closed_windows[0].label, "project-old");
    assert!(!registry.finish_open(pending, true));
    assert!(registry
        .begin_open("project-late".into(), "/project".into())
        .is_err());
    assert_eq!(registry.freeze(), snapshot);
    assert!(parse(&serde_json::to_vec(&snapshot).unwrap()).is_ok());
}

#[test]
fn frontend_registration_before_creation_settles_is_not_duplicated_on_quit() {
    let mut registry = with_closed_project();
    let pending = registry
        .begin_open("project-new".into(), "/project".into())
        .unwrap();
    registry.update(&pending.label, pending.workspace.clone());
    let snapshot = registry.freeze();
    assert!(snapshot.closed_windows.is_empty());
    assert_eq!(snapshot.windows.len(), 2);
    assert!(parse(&serde_json::to_vec(&snapshot).unwrap()).is_ok());
    assert!(!registry.finish_open(pending, true));
}

#[test]
fn history_is_bounded_and_a_different_project_does_not_inherit_it() {
    let mut registry = Registry::default();
    registry.update("main", "/host".into());
    for index in 0..MAX_CLOSED_WINDOWS + 3 {
        let label = format!("project-{index}");
        registry.update(&label, format!("/project-{index}"));
        registry.destroyed(&label, true);
    }
    assert_eq!(registry.closed_windows.len(), MAX_CLOSED_WINDOWS);
    assert_eq!(registry.closed_windows[0].label, "project-3");
    let opened = registry
        .begin_open("project-new".into(), "/other".into())
        .unwrap();
    assert_eq!(opened.label, "project-new");
}

#[test]
fn early_destruction_cannot_reassign_a_still_reserved_identity() {
    let mut registry = with_closed_project();
    let pending = registry
        .begin_open("project-new".into(), "/project".into())
        .unwrap();
    registry.update(&pending.label, pending.workspace.clone());
    registry.destroyed(&pending.label, true);
    let other = registry
        .begin_open("project-other".into(), "/project".into())
        .unwrap();
    assert_eq!(other.label, "project-other");
    let snapshot = registry.freeze();
    assert_eq!(snapshot.closed_windows.len(), 1);
    assert!(parse(&serde_json::to_vec(&snapshot).unwrap()).is_ok());
}

#[test]
fn early_workspace_update_is_not_overwritten_by_creation_completion() {
    let mut registry = with_closed_project();
    let pending = registry
        .begin_open("project-new".into(), "/project".into())
        .unwrap();
    registry.update(&pending.label, "/changed".into());
    assert!(registry.finish_open(pending, true));
    assert_eq!(registry.windows["project-old"].workspace, "/changed");
}

#[test]
fn oversized_history_evicts_oldest_closed_window_not_live_membership() {
    let mut registry = with_closed_project();
    registry.closed_windows[0].workspace = format!("/{}", "a".repeat(MAX_BYTES as usize));
    registry.update("project-newer", "/other".into());
    registry.destroyed("project-newer", true);
    let snapshot = parse(&registry.freeze().encode().unwrap()).unwrap();
    assert_eq!(snapshot.windows.len(), 1);
    assert_eq!(snapshot.windows[0].label, "main");
    assert_eq!(snapshot.closed_windows.len(), 1);
    assert_eq!(snapshot.closed_windows[0].label, "project-newer");
}

#[test]
fn failed_creation_after_early_destruction_preserves_the_newer_closed_record() {
    let mut registry = with_closed_project();
    let pending = registry
        .begin_open("project-new".into(), "/project".into())
        .unwrap();
    registry.update(&pending.label, "/changed".into());
    registry.destroyed(&pending.label, true);
    assert!(!registry.finish_open(pending, false));
    let snapshot = registry.freeze();
    assert_eq!(snapshot.closed_windows.len(), 1);
    assert_eq!(snapshot.closed_windows[0].workspace, "/changed");
    assert!(parse(&snapshot.encode().unwrap()).is_ok());
}

#[test]
fn failed_creation_after_last_window_close_does_not_duplicate_live_membership() {
    let mut registry = with_closed_project();
    let pending = registry
        .begin_open("project-new".into(), "/project".into())
        .unwrap();
    registry.update(&pending.label, "/changed".into());
    registry.destroyed("main", true);
    registry.destroyed(&pending.label, false);
    assert!(!registry.finish_open(pending, false));
    let snapshot = registry.freeze();
    assert_eq!(snapshot.windows.len(), 1);
    assert_eq!(snapshot.windows[0].workspace, "/changed");
    assert_eq!(snapshot.closed_windows.len(), 1);
    assert_eq!(snapshot.closed_windows[0].label, "main");
    assert!(parse(&snapshot.encode().unwrap()).is_ok());
}

#[test]
fn quit_freezes_membership_and_workspaces_before_async_teardown() {
    let mut registry = Registry::default();
    registry.update("main", "/a".into());
    registry.update("project-1", "/b".into());
    let geometry = Geometry {
        width: 1100.0,
        height: 750.0,
        x: 40.0,
        y: -900.0,
    };
    registry.geometry("project-1", geometry);
    let snapshot = registry.freeze();
    registry.destroyed("main", true);
    registry.update("project-1", "/stale".into());
    registry.update("project-late", "/late".into());
    registry.geometry(
        "project-1",
        Geometry {
            width: 430.0,
            ..geometry
        },
    );
    assert_eq!(registry.freeze(), snapshot);
    assert_eq!(snapshot.windows.len(), 2);
    assert_eq!(snapshot.windows[1].geometry, Some(geometry));
}

#[test]
fn workspace_update_preserves_normal_geometry_and_last_close_keeps_it() {
    let mut registry = Registry::default();
    registry.update("main", "/a".into());
    let geometry = Geometry {
        width: 1100.0,
        height: 750.0,
        x: 40.0,
        y: -900.0,
    };
    registry.geometry("main", geometry);
    registry.update("main", "/b".into());
    registry.destroyed("main", false);
    let snapshot = registry.freeze();
    assert_eq!(snapshot.windows[0].geometry, Some(geometry));
    assert_eq!(snapshot.windows[0].workspace, "/b");
    let bytes = serde_json::to_vec(&snapshot).unwrap();
    assert_eq!(parse(&bytes).unwrap(), snapshot);
}

#[test]
fn snapshot_keeps_stable_labels_and_repeated_projects() {
    let bytes = br#"{"version":1,"windows":[{"label":"main","workspace":"/a"},{"label":"project-123-abc","workspace":"/a"}]}"#;
    let snapshot = parse(bytes).unwrap();
    assert_eq!(snapshot.windows.len(), 2);
    assert_eq!(snapshot.windows[1].label, "project-123-abc");
    assert!(snapshot.closed_windows.is_empty());
    assert_eq!(
        parse(&serde_json::to_vec(&snapshot).unwrap()).unwrap(),
        snapshot
    );
}

#[test]
fn invalid_snapshots_fall_back_instead_of_creating_arbitrary_windows() {
    for bytes in [
        r#"{"version":2,"windows":[]}"#,
        r#"{"version":1,"windows":[{"label":"other","workspace":"/a"}]}"#,
        r#"{"version":1,"windows":[{"label":"main","workspace":"relative"}]}"#,
        r#"{"version":1,"windows":[{"label":"main","workspace":"/a"},{"label":"main","workspace":"/b"}]}"#,
        r#"{"version":1,"windows":[{"label":"main","workspace":"/a"}],"closedWindows":[{"label":"main","workspace":"/b"}]}"#,
        r#"{"version":1,"windows":[{"label":"main","workspace":"/a"}],"closedWindows":[{"label":"project-1","workspace":"relative"}]}"#,
        "not json",
    ] {
        assert!(parse(bytes.as_bytes()).is_err());
    }
    assert!(parse(&vec![b' '; MAX_BYTES as usize + 1]).is_err());
}

#[test]
fn route_encodes_paths_without_turning_them_into_query_or_fragment() {
    let WebviewUrl::App(path) = route("/space & ?# проект") else {
        panic!()
    };
    let url = tauri::Url::parse(&format!("http://localhost/{}", path.display())).unwrap();
    assert_eq!(
        url.query_pairs().find(|(k, _)| k == "workspace").unwrap().1,
        "/space & ?# проект"
    );
    assert!(url.fragment().is_none());
}

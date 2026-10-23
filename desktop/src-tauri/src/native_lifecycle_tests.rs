use super::*;
#[cfg(unix)]
use std::sync::mpsc;

#[test]
fn delayed_destroy_cleanup_targets_only_captured_resources_after_label_reuse() {
    let lifecycle = AcpProcessState::default();
    let terminals = PackageTerminalState::default();
    let old_slot = reserve_process_slot(&lifecycle, "reused", || true).unwrap();
    let terminal = |window_label: &str| PackageTerminalSession {
        window_label: window_label.into(),
        workspace: PathBuf::from("/workspace"),
        kind: PackageTerminalKind::Script,
        script: String::new(),
        command: String::new(),
        launch_command_id: None,
        started_at_ms: 0,
        status: PackageTerminalStatus::Exited,
        exit_code: None,
        signal: None,
        stop_requested: false,
        output: Vec::new(),
        running: None,
    };
    terminals
        .sessions
        .lock()
        .unwrap()
        .insert("old-terminal".into(), terminal("reused"));
    terminals
        .sessions
        .lock()
        .unwrap()
        .insert("other-terminal".into(), terminal("other"));
    let (removed, terminal_ids) = capture_destroyed_window(&lifecycle, &terminals, "reused");
    assert!(Arc::ptr_eq(&removed.unwrap(), &old_slot));
    assert!(old_slot.cancelled.load(Ordering::Acquire));
    assert_eq!(terminal_ids, ["old-terminal"]);
    // A new window publishes its own resources while the old worker is
    // blocked stopping ACP. Only captured IDs may be stopped or pruned.
    let replacement = reserve_process_slot(&lifecycle, "reused", || true).unwrap();
    terminals
        .sessions
        .lock()
        .unwrap()
        .insert("new-terminal".into(), terminal("reused"));
    assert!(!terminal_ids.contains(&"new-terminal".into()));
    remove_captured_ids(&mut terminals.sessions.lock().unwrap(), &terminal_ids);
    assert!(!replacement.cancelled.load(Ordering::Acquire));
    assert_eq!(
        terminals
            .sessions
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<HashSet<_>>(),
        HashSet::from(["new-terminal".into(), "other-terminal".into()])
    );
}

#[cfg(unix)]
#[test]
fn pty_startup_guard_reaps_child_on_error() {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.arg("-c");
    cmd.arg("sleep 30");
    let child = pair.slave.spawn_command(cmd).unwrap();
    let pid = child.process_id().unwrap();
    let guard = PtyStartupGuard(Some(child));
    drop(guard); // models a failure between spawn and registry publication
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

#[cfg(unix)]
#[test]
fn natural_leader_exit_cleanup_closes_descendant_inherited_pipe() {
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c")
        .arg("sleep 30 & exit 0")
        .stdout(Stdio::piped());
    native_process::isolate(&mut cmd);
    let mut child = native_process::spawn(&mut cmd).unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut stdout = stdout;
        let mut bytes = Vec::new();
        let _ = tx.send(stdout.read_to_end(&mut bytes));
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    while !native_process::exited_before_reap(&child).unwrap() {
        assert!(Instant::now() < deadline, "leader did not exit");
        thread::sleep(Duration::from_millis(5));
    }
    native_process::force_stop(&mut child).unwrap();
    child.wait().unwrap();
    assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap().is_ok());
}

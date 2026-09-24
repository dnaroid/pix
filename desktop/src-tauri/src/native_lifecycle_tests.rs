use super::*;

#[test]
fn delayed_destroy_cleanup_targets_only_captured_resources_after_label_reuse() {
    let lifecycle = AcpProcessState::default();
    let terminals = PackageTerminalState::default();
    let idx = IdxOperationState::default();
    let old_slot = reserve_process_slot(&lifecycle, "reused", || true).unwrap();
    let terminal = |window_label: &str| PackageTerminalSession {
        window_label: window_label.into(),
        workspace: PathBuf::from("/workspace"),
        kind: PackageTerminalKind::Script,
        script: String::new(),
        command: String::new(),
        started_at_ms: 0,
        status: PackageTerminalStatus::Exited,
        exit_code: None,
        signal: None,
        stop_requested: false,
        output: Vec::new(),
        running: None,
    };
    let operation = |window_label: &str| IdxOperationRecord {
        window_label: window_label.into(),
        workspace: PathBuf::from("/workspace"),
        kind: IdxMaintenanceKind::Index,
        command: String::new(),
        status: IdxOperationStatus::Succeeded,
        output: String::new(),
        started_at_ms: 0,
        finished_at_ms: None,
        exit_code: None,
        stop_tx: None,
        exited: Arc::new((Mutex::new(true), Condvar::new())),
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
    idx.operations
        .lock()
        .unwrap()
        .insert("old-idx".into(), operation("reused"));
    idx.operations
        .lock()
        .unwrap()
        .insert("other-idx".into(), operation("other"));

    let (removed, terminal_ids, idx_ids) =
        capture_destroyed_window(&lifecycle, &terminals, &idx, "reused");
    assert!(Arc::ptr_eq(&removed.unwrap(), &old_slot));
    assert!(old_slot.cancelled.load(Ordering::Acquire));
    assert_eq!(terminal_ids, ["old-terminal"]);
    assert_eq!(idx_ids, ["old-idx"]);
    // A new window publishes its own resources while the old worker is
    // blocked stopping ACP. Only captured IDs may be stopped or pruned.
    let replacement = reserve_process_slot(&lifecycle, "reused", || true).unwrap();
    terminals
        .sessions
        .lock()
        .unwrap()
        .insert("new-terminal".into(), terminal("reused"));
    idx.operations
        .lock()
        .unwrap()
        .insert("new-idx".into(), operation("reused"));
    assert!(!terminal_ids.contains(&"new-terminal".into()));
    assert!(!idx_ids.contains(&"new-idx".into()));
    remove_captured_ids(&mut terminals.sessions.lock().unwrap(), &terminal_ids);
    remove_captured_ids(&mut idx.operations.lock().unwrap(), &idx_ids);
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
    assert_eq!(
        idx.operations
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<HashSet<_>>(),
        HashSet::from(["new-idx".into(), "other-idx".into()])
    );
}

#[test]
fn reservation_checks_owner_under_registry_lock_and_does_not_retain_closed_ids() {
    let state = AcpProcessState::default();
    for n in 0..100 {
        assert!(reserve_process_slot(&state, &format!("closed-{n}"), || {
            assert!(state.slots.try_lock().is_err());
            false
        })
        .is_err());
    }
    assert!(state.slots.lock().unwrap().is_empty());
    let slot = reserve_process_slot(&state, "live", || true).unwrap();
    assert!(Arc::ptr_eq(
        &slot,
        &reserve_process_slot(&state, "live", || true).unwrap()
    ));
    remove_process_slot(&state, "live").unwrap();
    assert!(slot.cancelled.load(Ordering::Acquire));
    assert!(reserve_process_slot(&state, "live", || false).is_err());
    assert!(state.slots.lock().unwrap().is_empty());
}

fn ack(receiver: tokio::sync::oneshot::Receiver<Result<(), String>>) -> Result<(), String> {
    tauri::async_runtime::block_on(receiver).unwrap()
}

#[test]
fn command_admission_rejects_saturation_without_parking_and_preserves_accepted_fifo() {
    let queue = acp_queue::Queue::new(100, 2);
    let first = admit_stdin(&queue, "{\"n\":1}".into()).unwrap();
    let second = admit_stdin(&queue, "{\"n\":2}".into()).unwrap();
    assert!(admit_stdin(&queue, "{\"n\":3}".into())
        .unwrap_err()
        .contains("busy"));
    for (expected, receiver) in [("{\"n\":1}", first), ("{\"n\":2}", second)] {
        let StdinCommand::Write { line, ack: reply } = queue.pop(None).unwrap();
        assert_eq!(line, expected);
        reply.send(Ok(())).unwrap();
        ack(receiver).unwrap();
    }
    let oversized = admit_stdin(&queue, "x".repeat(100)).unwrap();
    assert!(admit_stdin(&queue, "{}".into())
        .unwrap_err()
        .contains("busy"));
    let StdinCommand::Write { ack: reply, .. } = queue.pop(None).unwrap();
    reply.send(Ok(())).unwrap();
    ack(oversized).unwrap();
}

struct FailWrite;
impl Write for FailWrite {
    fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
        Err(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "test failure",
        ))
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn writer_error_drains_all_pending_acknowledgements() {
    let queue = Arc::new(acp_queue::Queue::new(100, 4));
    let receivers: Vec<_> = (0..4)
        .map(|n| admit_stdin(&queue, format!("{{\"n\":{n}}}")).unwrap())
        .collect();
    forward_stdin(FailWrite, queue.clone());
    for receiver in receivers {
        assert!(ack(receiver).is_err());
    }
    assert!(queue.is_closed());
    assert!(admit_stdin(&queue, "{}".into()).is_err());
}

#[test]
fn invalid_json_rejects_only_its_command() {
    let queue = Arc::new(acp_queue::Queue::new(100, 4));
    let invalid = admit_stdin(&queue, "not-json".into()).unwrap();
    let valid = admit_stdin(&queue, "{}".into()).unwrap();
    let output = Arc::new(Mutex::new(Vec::<u8>::new()));
    struct Writer(Arc<Mutex<Vec<u8>>>);
    impl Write for Writer {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    forward_stdin(Writer(output.clone()), queue.clone());
    assert!(ack(invalid).is_err());
    ack(valid).unwrap();
    assert_eq!(&*output.lock().unwrap(), b"{}\n");
    queue.close();
}

#[test]
fn startup_lock_does_not_block_send_or_stop_state_access() {
    let slot = ProcessSlot::default();
    let _startup = slot.startup.lock().unwrap();
    assert!(slot.running.try_lock().is_ok());
    let queue = Arc::new(acp_queue::Queue::new(100, 1));
    let (stop_tx, stop_rx) = mpsc::channel();
    *slot.running.lock().unwrap() = Some(RunningProcess {
        generation: 1,
        stdin_tx: Some(queue.clone()),
        stop_tx,
        exited: Arc::new((Mutex::new(true), Condvar::new())),
    });
    stop_process_slot(&slot, Some(1)).unwrap();
    assert!(queue.is_closed());
    assert!(stop_rx.try_recv().is_ok());
    slot.cancelled.store(true, Ordering::Release);
    assert!(slot.cancelled.load(Ordering::Acquire));
}

#[test]
fn cancellation_before_startup_publication_does_not_lose_stop() {
    let state = AcpProcessState::default();
    let slot = Arc::new(ProcessSlot::default());
    state
        .slots
        .lock()
        .unwrap()
        .insert("window".into(), slot.clone());
    let _startup = slot.startup.lock().unwrap();
    let removed = remove_process_slot(&state, "window").unwrap();
    let queue = Arc::new(acp_queue::Queue::new(100, 1));
    let (stop_tx, stop_rx) = mpsc::channel();
    let running = RunningProcess {
        generation: 1,
        stdin_tx: Some(queue.clone()),
        stop_tx,
        exited: Arc::new((Mutex::new(false), Condvar::new())),
    };
    assert!(publish_process(&removed, &state, true, running).is_err());
    assert!(removed.running.lock().unwrap().is_none());
    assert!(queue.is_closed());
    assert!(stop_rx.try_recv().is_ok());
    // The old startup must not publish into a slot for a recreated window.
    let replacement = Arc::new(ProcessSlot::default());
    state
        .slots
        .lock()
        .unwrap()
        .insert("window".into(), replacement.clone());
    assert!(!replacement.cancelled.load(Ordering::Acquire));
    let _ = slot;
}

fn idx_start_record(window: &str, workspace: &str) -> IdxOperationRecord {
    IdxOperationRecord {
        window_label: window.into(),
        workspace: workspace.into(),
        kind: IdxMaintenanceKind::Index,
        command: "idx index".into(),
        status: IdxOperationStatus::Running,
        output: String::new(),
        started_at_ms: 0,
        finished_at_ms: None,
        exit_code: None,
        stop_tx: None,
        exited: Arc::new((Mutex::new(false), Condvar::new())),
    }
}

#[cfg(unix)]
fn idx_test_child(pipes: bool) -> IdxStartupGuard {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg("exec sleep 30");
    command.process_group(0);
    if pipes {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    }
    IdxStartupGuard(Some(command.spawn().unwrap()))
}

#[cfg(unix)]
fn assert_idx_reaped(pid: u32) {
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

#[cfg(unix)]
#[test]
fn destroyed_window_rejects_pending_idx_child_without_touching_replacement() {
    let lifecycle = Arc::new(AcpProcessState::default());
    let terminals = PackageTerminalState::default();
    let idx = Arc::new(IdxOperationState::default());
    let old = reserve_process_slot(&lifecycle, "reused", || true).unwrap();
    let (spawned_tx, spawned_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let worker_lifecycle = lifecycle.clone();
    let worker_idx = idx.clone();
    let worker = thread::spawn(move || {
        let mut child = idx_test_child(true);
        let pid = child.0.as_ref().unwrap().id();
        let _pipes = take_idx_pipes(&mut child).unwrap();
        spawned_tx.send(pid).unwrap();
        resume_rx.recv().unwrap();
        let result = publish_idx_operation(
            &worker_lifecycle,
            &old,
            "reused",
            true, // a replacement window already has the same visible label
            &worker_idx,
            "stale",
            idx_start_record("reused", "/old"),
        );
        assert!(result.unwrap_err().contains("closed"));
        drop(child);
    });
    let pid = spawned_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let (removed, _, captured) = capture_destroyed_window(&lifecycle, &terminals, &idx, "reused");
    assert!(removed.is_some());
    assert!(captured.is_empty());
    let replacement = reserve_process_slot(&lifecycle, "reused", || true).unwrap();
    let snapshot = publish_idx_operation(
        &lifecycle,
        &replacement,
        "reused",
        true,
        &idx,
        "replacement",
        idx_start_record("reused", "/new"),
    )
    .unwrap();
    assert_eq!(snapshot.id, "replacement");
    resume_tx.send(()).unwrap();
    worker.join().unwrap();
    assert_idx_reaped(pid);
    let operations = idx.operations.lock().unwrap();
    assert!(!operations.contains_key("stale"));
    assert!(operations.contains_key("replacement"));
}

#[cfg(unix)]
#[test]
fn idx_startup_guard_reaps_pipe_and_registry_failures() {
    let mut no_pipes = idx_test_child(false);
    let pid = no_pipes.0.as_ref().unwrap().id();
    assert!(take_idx_pipes(&mut no_pipes).is_err());
    drop(no_pipes);
    assert_idx_reaped(pid);

    let lifecycle = AcpProcessState::default();
    let idx = IdxOperationState::default();
    let owner = reserve_process_slot(&lifecycle, "window", || true).unwrap();
    let mut child = idx_test_child(true);
    let pid = child.0.as_ref().unwrap().id();
    assert!(publish_idx_operation(
        &lifecycle,
        &owner,
        "window",
        false,
        &idx,
        "missing",
        idx_start_record("window", "/missing")
    )
    .is_err());
    assert!(idx.operations.lock().unwrap().is_empty());
    drop(child);
    assert_idx_reaped(pid);

    let conflict = idx_start_record("window", "/same");
    idx.operations
        .lock()
        .unwrap()
        .insert("existing".into(), conflict);
    let child = idx_test_child(true);
    let pid = child.0.as_ref().unwrap().id();
    assert!(publish_idx_operation(
        &lifecycle,
        &owner,
        "window",
        true,
        &idx,
        "conflict",
        idx_start_record("window", "/same")
    )
    .unwrap_err()
    .contains("already running"));
    drop(child);
    assert_idx_reaped(pid);
    lifecycle.exiting.store(true, Ordering::Release);
    assert!(publish_idx_operation(
        &lifecycle,
        &owner,
        "window",
        true,
        &idx,
        "exiting",
        idx_start_record("window", "/different")
    )
    .is_err());
    lifecycle.exiting.store(false, Ordering::Release);
    // Reject a stale owner even if its cancellation flag was not set (or
    // visibility still resolves the newly created window under this label).
    let replacement = Arc::new(ProcessSlot::default());
    lifecycle
        .slots
        .lock()
        .unwrap()
        .insert("window".into(), replacement.clone());
    assert!(publish_idx_operation(
        &lifecycle,
        &owner,
        "window",
        true,
        &idx,
        "replaced",
        idx_start_record("window", "/different")
    )
    .is_err());
    lifecycle.slots.lock().unwrap().remove("window");
    assert!(publish_idx_operation(
        &lifecycle,
        &replacement,
        "window",
        true,
        &idx,
        "absent",
        idx_start_record("window", "/different")
    )
    .is_err());
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

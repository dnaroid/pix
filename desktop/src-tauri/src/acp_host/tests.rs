use super::*;

#[test]
fn destroyed_reservation_cannot_publish_after_global_slot_is_removed() {
    let state = AcpProcessState::default();
    let slot = Arc::new(ProcessSlot::default());
    state
        .slots
        .lock()
        .unwrap()
        .insert("window".to_owned(), slot.clone());
    let held_start = slot.running.lock().unwrap();
    let removed = remove_process_slot(&state, "window").unwrap();
    assert!(removed.cancelled.load(Ordering::Acquire));
    assert!(state.slots.lock().unwrap().is_empty());
    drop(held_start);
    assert!(slot.cancelled.load(Ordering::Acquire));
    // A recreated window with the same label receives a fresh reservation.
    let replacement = Arc::new(ProcessSlot::default());
    state
        .slots
        .lock()
        .unwrap()
        .insert("window".to_owned(), replacement.clone());
    assert!(!replacement.cancelled.load(Ordering::Acquire));
    assert!(!Arc::ptr_eq(&removed, &replacement));
}

#[test]
fn stale_stop_does_not_close_replacement_stdin() {
    let slot = ProcessSlot::default();
    let queue = Arc::new(acp_queue::Queue::<StdinCommand>::new(16, 1));
    let (stop_tx, stop_rx) = mpsc::channel();
    *slot.running.lock().unwrap() = Some(RunningProcess {
        generation: 2,
        stdin_tx: Some(queue.clone()),
        stop_tx,
        exited: Arc::new((Mutex::new(false), Condvar::new())),
    });
    stop_process_slot(&slot, Some(1)).unwrap();
    assert!(!queue.is_closed());
    assert!(stop_rx.try_recv().is_err());
    assert_eq!(slot.running.lock().unwrap().as_ref().unwrap().generation, 2);
}

#[test]
fn one_window_startup_reservation_does_not_lock_global_registry() {
    let state = AcpProcessState::default();
    let slot = Arc::new(ProcessSlot::default());
    state
        .slots
        .lock()
        .unwrap()
        .insert("one".into(), slot.clone());
    let _startup = slot.startup.lock().unwrap();
    let mut slots = state
        .slots
        .try_lock()
        .expect("global registry must remain unlocked during startup");
    slots.insert("two".into(), Arc::new(ProcessSlot::default()));
    assert_eq!(slots.len(), 2);
}

#[test]
fn validates_acp_payloads_without_materializing_the_json_object() {
    assert!(validate_json_object(r#"{"jsonrpc":"2.0","id":1,"params":{"blob":"abc"}}"#).is_ok());
    assert!(validate_json_object("[]").is_err());
    assert!(validate_json_object("null").is_err());
    assert!(validate_json_object(r#"{"jsonrpc":"2.0"} trailing"#).is_err());
}

#[test]
fn acp_event_payloads_include_the_owning_window_label() {
    let lines = serde_json::to_value(LinesPayload {
        window_label: "project-one".to_owned(),
        generation: 7,
        lines: vec!["message".to_owned()],
    })
    .expect("serialize lines payload");
    let exit = serde_json::to_value(exit_payload("project-two".to_owned(), 8, None, true, None))
        .expect("serialize exit payload");

    assert_eq!(lines["windowLabel"], "project-one");
    assert_eq!(lines["generation"], 7);
    assert_eq!(exit["windowLabel"], "project-two");
    assert_eq!(exit["generation"], 8);
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
    let first = admit_stdin(&queue, vec!["{\"n\":1}".into()]).unwrap();
    let second = admit_stdin(&queue, vec!["{\"n\":2}".into()]).unwrap();
    assert!(admit_stdin(&queue, vec!["{\"n\":3}".into()])
        .unwrap_err()
        .contains("busy"));
    for (expected, receiver) in [("{\"n\":1}", first), ("{\"n\":2}", second)] {
        let StdinCommand::Write { lines, ack: reply } = queue.pop(None).unwrap();
        assert_eq!(lines, vec![expected.to_owned()]);
        reply.send(Ok(())).unwrap();
        ack(receiver).unwrap();
    }
    let oversized = admit_stdin(&queue, vec!["x".repeat(100).into()]).unwrap();
    assert!(admit_stdin(&queue, vec!["{}".into()])
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
        .map(|n| admit_stdin(&queue, vec![format!("{{\"n\":{n}}}").into()]).unwrap())
        .collect();
    forward_stdin(FailWrite, queue.clone());
    for receiver in receivers {
        assert!(ack(receiver).is_err());
    }
    assert!(queue.is_closed());
    assert!(admit_stdin(&queue, vec!["{}".into()]).is_err());
}

#[test]
fn invalid_json_rejects_only_its_command() {
    let queue = Arc::new(acp_queue::Queue::new(100, 4));
    let invalid = admit_stdin(&queue, vec!["not-json".into()]).unwrap();
    let valid = admit_stdin(&queue, vec!["{}".into()]).unwrap();
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

#[derive(Clone, Default)]
struct RecordingWriter {
    output: Arc<Mutex<Vec<u8>>>,
    flushes: Arc<AtomicU64>,
}
impl Write for RecordingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.output.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.flushes.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }
}

#[test]
fn send_batch_is_written_in_order_and_flushed_once() {
    let queue = Arc::new(acp_queue::Queue::new(1024, 4));
    let writer = RecordingWriter::default();
    let batch = admit_stdin(&queue, vec!["{\"n\":1}".into(), "{\"n\":2}".into()]).unwrap();
    forward_stdin(writer.clone(), queue.clone());
    ack(batch).unwrap();
    assert_eq!(&*writer.output.lock().unwrap(), b"{\"n\":1}\n{\"n\":2}\n");
    assert_eq!(writer.flushes.load(Ordering::Acquire), 1);
    queue.close();
}

#[test]
fn invalid_entry_rejects_its_whole_batch_without_partial_write() {
    let queue = Arc::new(acp_queue::Queue::new(1024, 4));
    let writer = RecordingWriter::default();
    let invalid = admit_stdin(&queue, vec!["{}".into(), "[]".into()]).unwrap();
    let valid = admit_stdin(&queue, vec!["{\"ok\":true}".into()]).unwrap();
    forward_stdin(writer.clone(), queue.clone());
    assert!(ack(invalid).is_err());
    ack(valid).unwrap();
    assert_eq!(&*writer.output.lock().unwrap(), b"{\"ok\":true}\n");
    queue.close();
}

#[test]
fn send_batch_shape_is_validated_at_the_command_boundary() {
    assert!(validate_send_batch(&[]).is_err());
    assert!(validate_send_batch(&["{}\n{}".to_owned()]).is_err());
    assert!(validate_send_batch(&vec!["{}".to_owned(); MAX_SEND_BATCH_LINES + 1]).is_err());
    assert!(validate_send_batch(&vec!["{}".to_owned(); MAX_SEND_BATCH_LINES]).is_ok());
}

#[test]
fn forwarder_drain_waits_for_every_forwarder_but_is_bounded() {
    let (tx, rx) = mpsc::channel();
    let late = tx.clone();
    tx.send(()).unwrap();
    let worker = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        late.send(()).unwrap();
    });
    let started = Instant::now();
    Forwarders { done: rx, count: 2 }.drain(Duration::from_secs(5));
    assert!(started.elapsed() >= Duration::from_millis(25));
    worker.join().unwrap();

    // A forwarder held open by an escaped descendant cannot stall exit forever.
    let (_held, rx) = mpsc::channel::<()>();
    let started = Instant::now();
    Forwarders { done: rx, count: 2 }.drain(Duration::from_millis(50));
    assert!(started.elapsed() < Duration::from_secs(2));
}

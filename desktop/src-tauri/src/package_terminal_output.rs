//! Package terminal output plumbing: the bounded replay history and the
//! coalescing PTY reader that feeds `package-terminal://output`.
//!
//! The reader thread only reads the PTY; a separate batcher coalesces reads into
//! one sink call per [`OUTPUT_FLUSH_INTERVAL`] or [`OUTPUT_FLUSH_BYTES`], so a
//! chatty process produces a bounded IPC event rate. The batcher marks the
//! returned [`DrainSignal`] after its final flush, which lets the exit
//! supervisor deliver every byte before `package-terminal://exit`.

use std::{
    collections::VecDeque,
    io::Read,
    sync::{mpsc, Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

/// Maximum added latency for terminal output (about one display frame).
pub(crate) const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
/// A batch is flushed early once it reaches this size.
pub(crate) const OUTPUT_FLUSH_BYTES: usize = 64 * 1024;
/// Upper bound for draining PTY output after the child is reaped. A background
/// descendant that keeps the PTY slave open must not hold back exit forever.
pub(crate) const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const READ_CHUNK_BYTES: usize = 8 * 1024;
/// Reader → batcher backpressure: at most this many unread chunks in flight.
const PENDING_CHUNKS: usize = 64;

/// Replay history for one terminal: a byte ring that keeps the newest
/// `capacity` bytes. Trimming is O(trimmed bytes) instead of shifting the
/// whole buffer on every append.
pub(crate) struct OutputHistory {
    bytes: VecDeque<u8>,
    capacity: usize,
}

impl OutputHistory {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            capacity,
        }
    }

    pub(crate) fn push(&mut self, data: &[u8]) {
        if data.len() >= self.capacity {
            self.bytes.clear();
            self.bytes.extend(&data[data.len() - self.capacity..]);
            return;
        }
        let overflow = (self.bytes.len() + data.len()).saturating_sub(self.capacity);
        if overflow > 0 {
            self.bytes.drain(..overflow.min(self.bytes.len()));
        }
        self.bytes.extend(data);
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Contiguous copy for snapshots.
    pub(crate) fn to_vec(&self) -> Vec<u8> {
        let (head, tail) = self.bytes.as_slices();
        let mut out = Vec::with_capacity(self.bytes.len());
        out.extend_from_slice(head);
        out.extend_from_slice(tail);
        out
    }
}

/// Set once the batcher emitted its final batch (reader EOF/error).
#[derive(Clone, Default)]
pub(crate) struct DrainSignal(Arc<(Mutex<bool>, Condvar)>);

impl DrainSignal {
    fn mark(&self) {
        let (lock, wake) = &*self.0;
        if let Ok(mut drained) = lock.lock() {
            *drained = true;
            wake.notify_all();
        }
    }

    /// Wait up to `timeout`; returns whether all output was delivered.
    pub(crate) fn wait(&self, timeout: Duration) -> bool {
        let (lock, wake) = &*self.0;
        let Ok(drained) = lock.lock() else {
            return false;
        };
        match wake.wait_timeout_while(drained, timeout, |drained| !*drained) {
            Ok((drained, _)) => *drained,
            Err(_) => false,
        }
    }
}

/// Marks the drain signal even if the sink panics, so exit is never delayed
/// beyond the bounded wait by a dead batcher.
struct MarkOnDrop(DrainSignal);

impl Drop for MarkOnDrop {
    fn drop(&mut self) {
        self.0.mark();
    }
}

/// Start reading `reader` until EOF/error, delivering coalesced batches to
/// `sink` in order. Both threads end on reader EOF/error; nothing is retained
/// afterwards.
pub(crate) fn spawn_output_pump<R, F>(reader: R, sink: F) -> DrainSignal
where
    R: Read + Send + 'static,
    F: FnMut(&[u8]) + Send + 'static,
{
    spawn_output_pump_with(reader, sink, OUTPUT_FLUSH_INTERVAL, OUTPUT_FLUSH_BYTES)
}

fn spawn_output_pump_with<R, F>(
    mut reader: R,
    sink: F,
    interval: Duration,
    max_batch: usize,
) -> DrainSignal
where
    R: Read + Send + 'static,
    F: FnMut(&[u8]) + Send + 'static,
{
    let drained = DrainSignal::default();
    let (chunks_tx, chunks_rx) = mpsc::sync_channel::<Vec<u8>>(PENDING_CHUNKS);
    thread::spawn(move || {
        let mut buffer = [0_u8; READ_CHUNK_BYTES];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if chunks_tx.send(buffer[..read].to_vec()).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                // EIO is the normal end of a PTY once the slave side closes.
                Err(_) => break,
            }
        }
    });
    let guard = MarkOnDrop(drained.clone());
    thread::spawn(move || {
        let _guard = guard;
        batch_output(chunks_rx, sink, interval, max_batch);
    });
    drained
}

fn batch_output<F: FnMut(&[u8])>(
    chunks: mpsc::Receiver<Vec<u8>>,
    mut sink: F,
    interval: Duration,
    max_batch: usize,
) {
    while let Ok(mut batch) = chunks.recv() {
        let deadline = Instant::now() + interval;
        let mut disconnected = false;
        while batch.len() < max_batch {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match chunks.recv_timeout(remaining) {
                Ok(chunk) => batch.extend_from_slice(&chunk),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }
        sink(&batch);
        if disconnected {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_keeps_the_newest_bytes_within_capacity() {
        let mut history = OutputHistory::new(8);
        history.push(b"abcde");
        history.push(b"fgh");
        assert_eq!(history.to_vec(), b"abcdefgh");
        history.push(b"ij");
        assert_eq!(history.to_vec(), b"cdefghij");
        assert_eq!(history.len(), 8);
        history.push(b"0123456789");
        assert_eq!(history.to_vec(), b"23456789");
        history.push(b"x");
        assert_eq!(history.to_vec(), b"3456789x");
    }

    /// Reader fed by a channel: each message is one `read` result, so the
    /// test controls exactly when data and EOF arrive.
    struct ScriptedReader(mpsc::Receiver<Vec<u8>>);

    impl Read for ScriptedReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.0.recv() {
                Ok(chunk) => {
                    buf[..chunk.len()].copy_from_slice(&chunk);
                    Ok(chunk.len())
                }
                Err(_) => Ok(0),
            }
        }
    }

    #[test]
    fn pump_coalesces_reads_in_order_and_signals_drain_after_final_flush() {
        let (feed, rx) = mpsc::channel();
        let batches = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let sink_batches = batches.clone();
        // A long interval makes coalescing deterministic: every chunk fed
        // before EOF lands in the first batch.
        let drained = spawn_output_pump_with(
            ScriptedReader(rx),
            move |batch| sink_batches.lock().unwrap().push(batch.to_vec()),
            Duration::from_secs(30),
            1024 * 1024,
        );
        for n in 0..100 {
            feed.send(format!("{n},").into_bytes()).unwrap();
        }
        assert!(!drained.wait(Duration::from_millis(20)));
        drop(feed);
        assert!(drained.wait(Duration::from_secs(5)));
        let batches = batches.lock().unwrap();
        assert_eq!(batches.len(), 1, "100 reads must coalesce into one event");
        let expected = (0..100).map(|n| format!("{n},")).collect::<String>();
        assert_eq!(batches[0], expected.into_bytes());
    }

    #[test]
    fn pump_flushes_early_at_the_size_limit_and_after_the_interval() {
        let (feed, rx) = mpsc::channel();
        let (batch_tx, batch_rx) = mpsc::channel::<Vec<u8>>();
        let drained = spawn_output_pump_with(
            ScriptedReader(rx),
            move |batch| batch_tx.send(batch.to_vec()).unwrap(),
            Duration::from_millis(10),
            4,
        );
        feed.send(b"ab".to_vec()).unwrap();
        feed.send(b"cd".to_vec()).unwrap();
        feed.send(b"ef".to_vec()).unwrap();
        let mut received = Vec::new();
        while received.len() < 6 {
            received.extend(batch_rx.recv_timeout(Duration::from_secs(5)).unwrap());
        }
        assert_eq!(received, b"abcdef");
        drop(feed);
        assert!(drained.wait(Duration::from_secs(5)));
    }

    #[test]
    fn drain_wait_is_bounded_while_a_descendant_holds_the_pty_open() {
        let (_feed, rx) = mpsc::channel::<Vec<u8>>();
        let drained = spawn_output_pump(ScriptedReader(rx), |_| {});
        let started = Instant::now();
        assert!(!drained.wait(Duration::from_millis(30)));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn drain_is_signalled_even_if_the_sink_panics() {
        let (feed, rx) = mpsc::channel();
        let drained = spawn_output_pump(ScriptedReader(rx), |_| panic!("sink failed"));
        feed.send(b"x".to_vec()).unwrap();
        assert!(drained.wait(Duration::from_secs(5)));
    }
}

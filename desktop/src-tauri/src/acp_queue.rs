use std::{
    collections::VecDeque,
    sync::{Condvar, Mutex},
    time::Duration,
};

/// Lossless bounded queue. A single oversized ACP JSON object is allowed,
/// exclusively, so legitimate large requests are not rejected or truncated.
pub struct Queue<T> {
    inner: Mutex<Inner<T>>,
    wake: Condvar,
    max_bytes: usize,
    max_items: usize,
}

struct Inner<T> {
    pending: VecDeque<(T, usize)>,
    bytes: usize,
    closed: bool,
}

impl<T> Queue<T> {
    pub fn new(max_bytes: usize, max_items: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                pending: VecDeque::new(),
                bytes: 0,
                closed: false,
            }),
            wake: Condvar::new(),
            max_bytes,
            max_items,
        }
    }

    pub fn push(&self, value: T, bytes: usize) -> Result<(), &'static str> {
        let mut inner = self.inner.lock().map_err(|_| "ACP queue is poisoned")?;
        while !inner.closed
            && (inner.pending.len() >= self.max_items
                || (inner.bytes.saturating_add(bytes) > self.max_bytes
                    && !inner.pending.is_empty()))
        {
            inner = self.wake.wait(inner).map_err(|_| "ACP queue is poisoned")?;
        }
        if inner.closed {
            return Err("ACP queue is closed");
        }
        inner.bytes = inner.bytes.saturating_add(bytes);
        inner.pending.push_back((value, bytes));
        self.wake.notify_all();
        Ok(())
    }

    /// Command-boundary admission: never park a payload or a blocking worker
    /// while waiting for capacity. Accepted items retain their insertion order.
    pub fn try_push(&self, value: T, bytes: usize) -> Result<(), &'static str> {
        let mut inner = self.inner.lock().map_err(|_| "ACP queue is poisoned")?;
        if inner.closed {
            return Err("ACP queue is closed");
        }
        if inner.pending.len() >= self.max_items
            || (inner.bytes.saturating_add(bytes) > self.max_bytes && !inner.pending.is_empty())
        {
            return Err("ACP stdin is busy; retry the write");
        }
        inner.bytes = inner.bytes.saturating_add(bytes);
        inner.pending.push_back((value, bytes));
        self.wake.notify_all();
        Ok(())
    }

    /// On an unrecoverable writer error, release all accepted acknowledgements
    /// even if the running generation retains the now-closed queue.
    pub fn close_and_drain(&self) -> Vec<T> {
        let Ok(mut inner) = self.inner.lock() else {
            return Vec::new();
        };
        inner.closed = true;
        inner.bytes = 0;
        let drained = inner.pending.drain(..).map(|(value, _)| value).collect();
        self.wake.notify_all();
        drained
    }

    pub fn pop(&self, timeout: Option<Duration>) -> Option<T> {
        let mut inner = self.inner.lock().ok()?;
        loop {
            if let Some((value, bytes)) = inner.pending.pop_front() {
                inner.bytes -= bytes;
                self.wake.notify_all();
                return Some(value);
            }
            if inner.closed {
                return None;
            }
            inner = match timeout {
                Some(duration) => {
                    let (guard, result) = self.wake.wait_timeout(inner, duration).ok()?;
                    if result.timed_out() {
                        return None;
                    }
                    guard
                }
                None => self.wake.wait(inner).ok()?,
            };
        }
    }

    pub fn close(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.closed = true;
            self.wake.notify_all();
        }
    }

    pub fn is_closed(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.closed && inner.pending.is_empty())
            .unwrap_or(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{mpsc, Arc},
        thread,
    };

    #[test]
    fn byte_budget_blocks_until_consumed_and_keeps_oversized_item() {
        let queue = Arc::new(Queue::new(4, 2));
        queue.push("large", 10).unwrap();
        let sender = queue.clone();
        let (tx, rx) = mpsc::channel();
        let worker = thread::spawn(move || tx.send(sender.push("next", 1)).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(40)).is_err());
        assert_eq!(queue.pop(None), Some("large"));
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap().is_ok());
        worker.join().unwrap();
        assert_eq!(queue.pop(None), Some("next"));
    }

    #[test]
    fn closing_saturated_queue_unblocks_producer_without_dropping_accepted_item() {
        let queue = Arc::new(Queue::new(1, 1));
        queue.push(1, 1).unwrap();
        let sender = queue.clone();
        let (tx, rx) = mpsc::channel();
        let worker = thread::spawn(move || tx.send(sender.push(2, 1)).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(40)).is_err());
        queue.close();
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap().is_err());
        assert_eq!(queue.pop(None), Some(1));
        assert_eq!(queue.pop(None), None);
        worker.join().unwrap();
    }
}

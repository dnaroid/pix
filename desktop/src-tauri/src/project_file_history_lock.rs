//! In-process serialization of Files history disk work, per workspace. A long
//! copy in one workspace must not block mutations, undo or redo elsewhere.
//! Locks are taken all-or-nothing, so multi-workspace operations (imports and
//! cross-workspace copies) cannot deadlock against each other. The on-disk
//! `flock` in the history storage still guards against other Pix processes.
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Condvar, Mutex, PoisonError},
};

#[derive(Default)]
pub(crate) struct WorkspaceLocks {
    held: Mutex<HashSet<PathBuf>>,
    released: Condvar,
}

pub(crate) struct WorkspaceGuard<'a> {
    locks: &'a WorkspaceLocks,
    paths: Vec<PathBuf>,
}

impl WorkspaceLocks {
    /// Block until every path is free, then hold them all until the guard drops.
    pub(crate) fn acquire(&self, paths: impl IntoIterator<Item = PathBuf>) -> WorkspaceGuard<'_> {
        let mut paths: Vec<PathBuf> = paths.into_iter().collect();
        paths.sort();
        paths.dedup();
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        while paths.iter().any(|path| held.contains(path)) {
            held = self
                .released
                .wait(held)
                .unwrap_or_else(PoisonError::into_inner);
        }
        held.extend(paths.iter().cloned());
        WorkspaceGuard { locks: self, paths }
    }
}

impl Drop for WorkspaceGuard<'_> {
    fn drop(&mut self) {
        let mut held = self
            .locks
            .held
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for path in &self.paths {
            held.remove(path);
        }
        drop(held);
        self.locks.released.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{mpsc, Arc},
        thread,
        time::Duration,
    };

    fn path(name: &str) -> PathBuf {
        PathBuf::from(format!("/workspaces/{name}"))
    }

    #[test]
    fn a_busy_workspace_does_not_block_another_workspace() {
        let locks = WorkspaceLocks::default();
        let busy = locks.acquire([path("a")]);
        // Would block forever if locking were process-wide.
        drop(locks.acquire([path("b")]));
        drop(busy);
        assert!(locks.held.lock().unwrap().is_empty());
    }

    #[test]
    fn the_same_workspace_waits_until_the_holder_releases() {
        let locks = Arc::new(WorkspaceLocks::default());
        let guard = locks.acquire([path("a"), path("source")]);
        let (sender, receiver) = mpsc::channel();
        let waiter = {
            let locks = Arc::clone(&locks);
            thread::spawn(move || {
                let _guard = locks.acquire([path("source")]);
                sender.send(()).unwrap();
            })
        };
        assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
        drop(guard);
        receiver.recv_timeout(Duration::from_secs(10)).unwrap();
        waiter.join().unwrap();
    }

    #[test]
    fn opposite_multi_workspace_orders_do_not_deadlock() {
        let locks = Arc::new(WorkspaceLocks::default());
        let workers: Vec<_> = [[path("a"), path("b")], [path("b"), path("a")]]
            .into_iter()
            .map(|order| {
                let locks = Arc::clone(&locks);
                thread::spawn(move || {
                    for _ in 0..500 {
                        drop(locks.acquire(order.clone()));
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert!(locks.held.lock().unwrap().is_empty());
    }

    #[test]
    fn duplicate_paths_are_held_once_and_released() {
        let locks = WorkspaceLocks::default();
        drop(locks.acquire([path("a"), path("a")]));
        drop(locks.acquire([path("a")]));
        assert!(locks.held.lock().unwrap().is_empty());
    }
}

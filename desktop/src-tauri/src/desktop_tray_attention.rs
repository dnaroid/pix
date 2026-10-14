//! Window-owned attention. A reused label cannot inherit a destroyed owner's dot.
use std::{collections::HashMap, sync::Mutex};

#[derive(Default)]
pub(crate) struct State(pub(crate) Mutex<Attention>);

#[derive(Default)]
pub(crate) struct Attention {
    owners: HashMap<String, usize>,
    stopped: bool,
}

impl Attention {
    pub(crate) fn set(&mut self, label: &str, invoking: usize, current: usize, attention: bool) {
        if self.stopped || invoking == 0 || invoking != current {
            return;
        }
        if attention {
            self.owners.insert(label.into(), invoking);
        } else {
            self.owners.remove(label);
        }
    }

    pub(crate) fn snapshot(&mut self, live: &[(String, usize)]) -> bool {
        self.owners.retain(|label, owner| {
            live.iter().any(|(current_label, current_owner)| {
                current_label == label && current_owner == owner
            })
        });
        !self.owners.is_empty()
    }

    pub(crate) fn destroyed(&mut self, label: &str) {
        self.owners.remove(label);
    }

    pub(crate) fn shutdown(&mut self) {
        self.stopped = true;
        self.owners.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clearing_one_window_preserves_other_owners() {
        let mut state = Attention::default();
        let live = vec![("main".into(), 1), ("project-a".into(), 2)];
        state.set("main", 1, 1, true);
        state.set("project-a", 2, 2, true);
        assert!(state.snapshot(&live));
        state.set("main", 1, 1, false);
        assert!(state.snapshot(&live));
        state.destroyed("project-a");
        assert!(!state.snapshot(&live));
    }

    #[test]
    fn stale_sends_cannot_set_or_clear_a_reused_label() {
        let mut state = Attention::default();
        state.set("main", 1, 1, true);
        assert!(!state.snapshot(&[("main".into(), 2)]));
        state.set("main", 1, 2, true);
        assert!(!state.snapshot(&[("main".into(), 2)]));
        state.set("main", 2, 2, true);
        state.set("main", 1, 2, false);
        assert!(state.snapshot(&[("main".into(), 2)]));
        assert!(!state.snapshot(&[]));
    }

    #[test]
    fn late_updates_cannot_resurrect_shutdown() {
        let mut state = Attention::default();
        state.set("main", 1, 1, true);
        state.shutdown();
        state.set("main", 1, 1, true);
        assert!(!state.snapshot(&[("main".into(), 1)]));
    }
}

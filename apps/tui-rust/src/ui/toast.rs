//! Transient toast notifications rendered above the conversation.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use ratatui::style::Color;

#[derive(Debug, Clone)]
pub struct Toast {
    pub message: String,
    pub level: ToastLevel,
    pub expires_at: Instant,
    pub kind_label: ToastKindLabel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToastLevel {
    Info,
    Warn,
    Error,
}

impl ToastLevel {
    pub fn color(self) -> Color {
        match self {
            ToastLevel::Info => Color::Cyan,
            ToastLevel::Warn => Color::Yellow,
            ToastLevel::Error => Color::Red,
        }
    }

    pub fn default_ttl(self) -> Duration {
        match self {
            ToastLevel::Info => Duration::from_secs(4),
            ToastLevel::Warn => Duration::from_secs(6),
            ToastLevel::Error => Duration::from_secs(10),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ToastLevel::Info => "info",
            ToastLevel::Warn => "warn",
            ToastLevel::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToastKindLabel {
    Stderr,
    Bridge,
    Info,
    Link,
}

impl ToastKindLabel {
    pub fn icon(self) -> char {
        match self {
            ToastKindLabel::Stderr => '!',
            ToastKindLabel::Bridge => '✖',
            ToastKindLabel::Info => 'i',
            ToastKindLabel::Link => '↗',
        }
    }
}

#[derive(Debug, Clone)]
pub struct ToastQueue {
    toasts: VecDeque<Toast>,
    capacity: usize,
}

impl Default for ToastQueue {
    fn default() -> Self {
        Self::new(3)
    }
}

impl ToastQueue {
    pub fn new(capacity: usize) -> Self {
        Self {
            toasts: VecDeque::new(),
            capacity,
        }
    }

    pub fn push(
        &mut self,
        level: ToastLevel,
        kind_label: ToastKindLabel,
        message: impl Into<String>,
        ttl_seconds: u64,
    ) {
        while self.toasts.len() >= self.capacity {
            self.toasts.pop_front();
        }
        let ttl = if ttl_seconds == 0 {
            level.default_ttl()
        } else {
            Duration::from_secs(ttl_seconds)
        };
        self.toasts.push_back(Toast {
            message: message.into(),
            level,
            expires_at: Instant::now() + ttl,
            kind_label,
        });
    }

    pub fn purge_expired(&mut self, now: Instant) -> bool {
        let before = self.toasts.len();
        self.toasts.retain(|toast| toast.expires_at > now);
        self.toasts.len() != before
    }

    pub fn is_empty(&self) -> bool {
        self.toasts.is_empty()
    }

    pub fn iter_active(&self) -> impl Iterator<Item = &Toast> {
        self.toasts.iter()
    }

    pub fn latest(&self) -> Option<&Toast> {
        self.toasts.back()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_capacity_evicts_fifo() {
        let mut queue = ToastQueue::new(3);
        queue.push(ToastLevel::Info, ToastKindLabel::Info, "one", 4);
        queue.push(ToastLevel::Info, ToastKindLabel::Info, "two", 4);
        queue.push(ToastLevel::Info, ToastKindLabel::Info, "three", 4);
        queue.push(ToastLevel::Info, ToastKindLabel::Info, "four", 4);

        let messages: Vec<_> = queue.iter_active().map(|t| t.message.as_str()).collect();
        assert_eq!(messages, vec!["two", "three", "four"]);
    }

    #[test]
    fn purge_expired_drops_old_toasts() {
        let mut queue = ToastQueue::new(3);
        queue.push(ToastLevel::Warn, ToastKindLabel::Stderr, "old", 1);
        queue.push(ToastLevel::Warn, ToastKindLabel::Stderr, "new", 10);

        let changed = queue.purge_expired(Instant::now() + Duration::from_secs(2));

        assert!(changed);
        let messages: Vec<_> = queue.iter_active().map(|t| t.message.as_str()).collect();
        assert_eq!(messages, vec!["new"]);
    }

    #[test]
    fn push_preserves_pop_ordering() {
        let mut queue = ToastQueue::new(3);
        queue.push(ToastLevel::Info, ToastKindLabel::Info, "first", 4);
        queue.push(ToastLevel::Warn, ToastKindLabel::Stderr, "second", 6);

        let messages: Vec<_> = queue.iter_active().map(|t| t.message.as_str()).collect();
        assert_eq!(messages, vec!["first", "second"]);
        assert_eq!(queue.latest().unwrap().message, "second");
    }

    #[test]
    fn empty_after_purge() {
        let mut queue = ToastQueue::new(3);
        queue.push(ToastLevel::Error, ToastKindLabel::Bridge, "boom", 1);

        assert!(queue.purge_expired(Instant::now() + Duration::from_secs(2)));
        assert!(queue.is_empty());
    }

    #[test]
    fn default_ttl_is_used_for_zero_seconds() {
        let mut queue = ToastQueue::new(3);
        let before = Instant::now();
        queue.push(ToastLevel::Error, ToastKindLabel::Bridge, "boom", 0);
        let toast = queue.latest().unwrap();

        assert!(toast.expires_at >= before + Duration::from_secs(9));
        assert!(toast.expires_at <= Instant::now() + Duration::from_secs(11));
    }
}

//! Finished spans wait here and a thread of their own posts them, so that a
//! command never waits on a collector while it runs, and a long-lived one
//! (a folder watch) sends as it goes rather than all at its end.

use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::otlp::{Finished, Poster, Resource, request};

/// A batch goes at this many spans, or when this long has passed.
const BATCH: usize = 512;
const INTERVAL: Duration = Duration::from_secs(5);

/// What waits for a post. Past this, a span is dropped and counted, so that a
/// collector that does not answer cannot make a watch grow without bound. The
/// run's root span is never dropped.
const MOST_WAITING: usize = 2048;

#[derive(Default)]
struct State {
    waiting: Vec<Finished>,
    dropped: u64,
    closing: bool,
    done: bool,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Where the layer puts a span that has ended.
pub trait Sink: Send + Sync {
    fn push(&self, span: Finished);
}

pub struct Exporter {
    shared: Arc<Shared>,
}

impl Exporter {
    /// `None` where the thread cannot be made: the run then sends nothing.
    pub fn start(poster: Poster, resource: Resource) -> Option<Exporter> {
        let shared = Arc::new(Shared::default());
        let worker = Arc::clone(&shared);
        crate::interrupt::spawn_apart("telemetry", move || work(&worker, &poster, &resource))
            .ok()
            .map(|_| Exporter { shared })
    }

    pub fn dropped(&self) -> u64 {
        self.shared.lock().dropped
    }

    /// Hands what is left to the thread and waits for it, up to `budget`. The
    /// thread is left to the process's end if it has not finished by then.
    pub fn close(&self, budget: Duration) {
        let deadline = Instant::now() + budget;
        let mut state = self.shared.lock();
        state.closing = true;
        self.shared.changed.notify_all();
        while !state.done {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            state = self
                .shared
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }
}

impl Sink for Exporter {
    fn push(&self, span: Finished) {
        let mut state = self.shared.lock();
        if state.waiting.len() >= MOST_WAITING && span.parent.is_some() {
            state.dropped += 1;
            return;
        }
        state.waiting.push(span);
        if state.waiting.len() >= BATCH {
            self.shared.changed.notify_all();
        }
    }
}

fn work(shared: &Shared, poster: &Poster, resource: &Resource) {
    let mut due = Instant::now() + INTERVAL;
    loop {
        let (batch, last) = {
            let mut state = shared.lock();
            loop {
                let now = Instant::now();
                if state.closing || state.waiting.len() >= BATCH {
                    break;
                }
                if now >= due {
                    if !state.waiting.is_empty() {
                        break;
                    }
                    due = now + INTERVAL;
                }
                state = shared
                    .changed
                    .wait_timeout(state, due.saturating_duration_since(now))
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0;
            }
            let taken = if state.closing {
                state.waiting.len()
            } else {
                state.waiting.len().min(BATCH)
            };
            (
                state.waiting.drain(..taken).collect::<Vec<_>>(),
                state.closing,
            )
        };
        due = Instant::now() + INTERVAL;
        if !batch.is_empty() {
            poster.post(&request(resource, &batch));
        }
        if last {
            shared.lock().done = true;
            shared.changed.notify_all();
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use super::*;

    fn span(parent: Option<[u8; 8]>) -> Finished {
        Finished {
            trace_id: [1; 16],
            span_id: [2; 8],
            parent,
            name: "drain".into(),
            start: SystemTime::UNIX_EPOCH,
            end: SystemTime::UNIX_EPOCH,
            attributes: Vec::new(),
            events: Vec::new(),
            error: false,
        }
    }

    /// An exporter with nothing posting, so the queue only fills.
    fn stalled() -> Exporter {
        Exporter {
            shared: Arc::new(Shared::default()),
        }
    }

    #[test]
    fn past_the_limit_a_span_is_dropped_and_counted_but_the_root_is_kept() {
        let exporter = stalled();
        for _ in 0..MOST_WAITING {
            exporter.push(span(Some([1; 8])));
        }
        assert_eq!(exporter.dropped(), 0);
        exporter.push(span(Some([1; 8])));
        exporter.push(span(Some([1; 8])));
        assert_eq!(exporter.dropped(), 2);
        exporter.push(span(None));
        assert_eq!(exporter.dropped(), 2);
        assert_eq!(exporter.shared.lock().waiting.len(), MOST_WAITING + 1);
    }

    #[test]
    fn closing_returns_at_the_budget_when_nothing_is_posting() {
        let exporter = stalled();
        let started = Instant::now();
        exporter.close(Duration::from_millis(80));
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(70), "{took:?}");
        assert!(took < Duration::from_secs(2), "{took:?}");
    }
}

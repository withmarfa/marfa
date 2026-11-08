//! Work handed to a thread of its own so that a request never waits on a
//! receiver. The queue is bounded and a full one drops what comes, so a
//! storm of faults, or a receiver that hangs, holds a fixed amount of memory
//! and changes nothing for a request.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::thread;
use std::time::{Duration, Instant};

enum Message<T> {
    Item(T),
    Flush(SyncSender<()>),
}

pub struct Lane<T> {
    queue: SyncSender<Message<T>>,
}

impl<T: Send + 'static> Lane<T> {
    /// Starts the thread. `send` gets items together once `window` has passed
    /// since the first of them, or `batch` of them are waiting, or a flush is
    /// asked for. Whatever it does with them, a panic in it ends nothing.
    pub fn start(
        name: &str,
        capacity: usize,
        window: Duration,
        batch: usize,
        mut send: impl FnMut(Vec<T>) + Send + 'static,
    ) -> Lane<T> {
        let (queue, inbox) = sync_channel::<Message<T>>(capacity);
        let work = move || {
            let mut held: Vec<T> = Vec::new();
            let mut due: Option<Instant> = None;
            let mut deliver = |held: &mut Vec<T>, due: &mut Option<Instant>| {
                *due = None;
                if !held.is_empty() {
                    let items = std::mem::take(held);
                    let _ = catch_unwind(AssertUnwindSafe(|| send(items)));
                }
            };
            loop {
                let next = match due {
                    Some(at) => inbox.recv_timeout(at.saturating_duration_since(Instant::now())),
                    None => inbox.recv().map_err(|_| RecvTimeoutError::Disconnected),
                };
                match next {
                    Ok(Message::Item(item)) => {
                        if held.is_empty() {
                            due = Some(Instant::now() + window);
                        }
                        held.push(item);
                        if held.len() >= batch {
                            deliver(&mut held, &mut due);
                        }
                    }
                    Ok(Message::Flush(done)) => {
                        deliver(&mut held, &mut due);
                        let _ = done.send(());
                    }
                    Err(RecvTimeoutError::Timeout) => deliver(&mut held, &mut due),
                    Err(RecvTimeoutError::Disconnected) => {
                        deliver(&mut held, &mut due);
                        break;
                    }
                }
            }
        };
        // A thread that cannot start leaves the lane dropping everything.
        let _ = thread::Builder::new().name(name.to_string()).spawn(work);
        Lane { queue }
    }

    /// Queues an item, or drops it when the queue is full.
    pub fn offer(&self, item: T) {
        if let Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) =
            self.queue.try_send(Message::Item(item))
        {
            // Dropped on purpose: see the module.
        }
    }

    /// Has everything queued sent, waiting no longer than `within`.
    pub fn flush(&self, within: Duration) {
        let (done, finished) = sync_channel(1);
        if self.queue.try_send(Message::Flush(done)).is_ok() {
            let _ = finished.recv_timeout(within);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;

    #[test]
    fn items_leave_together_after_the_window_or_at_a_flush() {
        let seen = Arc::new(Mutex::new(Vec::<Vec<u32>>::new()));
        let sink = seen.clone();
        let lane = Lane::start("t", 8, Duration::from_secs(60), 100, move |items| {
            sink.lock().unwrap().push(items);
        });
        lane.offer(1);
        lane.offer(2);
        lane.flush(Duration::from_secs(5));
        lane.offer(3);
        lane.flush(Duration::from_secs(5));
        assert_eq!(*seen.lock().unwrap(), vec![vec![1, 2], vec![3]]);
    }

    #[test]
    fn a_full_queue_drops_and_a_stuck_sender_never_blocks_the_offerer() {
        let release = Arc::new(Mutex::new(()));
        let held = release.lock().unwrap();
        let sent = Arc::new(AtomicUsize::new(0));
        let (lock, count) = (release.clone(), sent.clone());
        let lane = Lane::start("t", 4, Duration::ZERO, 1, move |items| {
            drop(lock.lock().unwrap());
            count.fetch_add(items.len(), Ordering::SeqCst);
        });
        let started = Instant::now();
        for item in 0..10_000u32 {
            lane.offer(item);
        }
        assert!(started.elapsed() < Duration::from_secs(1));
        // Bounded: the stuck sender holds one and the queue holds four.
        drop(held);
        lane.flush(Duration::from_secs(5));
        assert!(
            sent.load(Ordering::SeqCst) <= 6,
            "{}",
            sent.load(Ordering::SeqCst)
        );
    }

    #[test]
    fn a_panic_in_the_sender_ends_nothing() {
        let sent = Arc::new(AtomicUsize::new(0));
        let count = sent.clone();
        let lane = Lane::start("t", 4, Duration::ZERO, 1, move |items: Vec<u32>| {
            assert!(items[0] != 0, "boom");
            count.fetch_add(1, Ordering::SeqCst);
        });
        lane.offer(0);
        lane.flush(Duration::from_secs(5));
        lane.offer(1);
        lane.flush(Duration::from_secs(5));
        assert_eq!(sent.load(Ordering::SeqCst), 1);
    }
}

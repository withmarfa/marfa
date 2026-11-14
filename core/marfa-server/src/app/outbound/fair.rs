//! Slots shared by makers, each holding at most its share, with waiters served by turns across makers and oldest first within one.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll, Waker};

use tokio::sync::watch;

pub(super) struct Pool {
    /// The most slots one maker may hold at once.
    share: Option<usize>,
    line: Mutex<Line>,
    /// Counts the slots given back.
    released: watch::Sender<u64>,
}

/// Every count and queue of the pool, changed only together under one lock.
struct Line {
    free: usize,
    held: HashMap<String, usize>,
    /// The makers with a waiter, in the order they are served.
    turns: VecDeque<String>,
    queues: HashMap<String, VecDeque<u64>>,
    places: HashMap<u64, Place>,
    next_id: u64,
}

enum Place {
    Waiting(Option<Waker>),
    /// A slot was moved here; it is counted as held and belongs to the place until taken or given back.
    Served,
}

/// A slot of the pool, given back when dropped.
pub(super) struct Held {
    pool: Arc<Pool>,
    maker: String,
}

impl Drop for Held {
    fn drop(&mut self) {
        let woken = {
            let mut line = self.pool.lock();
            line.put_back(&self.maker);
            line.serve(self.pool.share)
        };
        self.pool.announce(woken);
    }
}

pub(super) enum Joined {
    Held(Held),
    Queued(Queued),
}

/// A place in line. Dropped before it takes its slot, it leaves the line, or gives back the slot moved to it.
pub(super) struct Queued {
    pool: Arc<Pool>,
    maker: String,
    id: u64,
    done: bool,
}

pub(super) enum AtDeadline {
    Served(Held),
    Left,
    Stays,
}

impl Pool {
    pub(super) fn new(total: usize, share: Option<usize>) -> Arc<Pool> {
        Arc::new(Pool {
            share,
            line: Mutex::new(Line {
                free: total,
                held: HashMap::new(),
                turns: VecDeque::new(),
                queues: HashMap::new(),
                places: HashMap::new(),
                next_id: 0,
            }),
            released: watch::Sender::new(0),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Line> {
        self.line.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn held(self: &Arc<Pool>, maker: &str) -> Held {
        Held {
            pool: self.clone(),
            maker: maker.to_string(),
        }
    }

    fn announce(&self, woken: Vec<Waker>) {
        self.released
            .send_modify(|count| *count = count.wrapping_add(1));
        woken.into_iter().for_each(Waker::wake);
    }

    /// A slot at once when one is free and the maker has room, or a place in line.
    pub(super) fn join(self: &Arc<Pool>, maker: &str) -> Joined {
        let mut line = self.lock();
        if line.free > 0 && line.has_room(maker, self.share) {
            line.grant(maker);
            return Joined::Held(self.held(maker));
        }
        let id = line.enqueue(maker);
        Joined::Queued(Queued {
            pool: self.clone(),
            maker: maker.to_string(),
            id,
            done: false,
        })
    }

    /// Whether the maker holds fewer slots than its share.
    pub(super) fn has_room(&self, maker: &str) -> bool {
        self.lock().has_room(maker, self.share)
    }

    pub(super) fn released(&self) -> watch::Receiver<u64> {
        self.released.subscribe()
    }

    #[cfg(test)]
    pub(super) fn free(&self) -> usize {
        self.lock().free
    }
}

impl Line {
    fn has_room(&self, maker: &str, share: Option<usize>) -> bool {
        share.is_none_or(|share| self.held.get(maker).copied().unwrap_or(0) < share)
    }

    fn grant(&mut self, maker: &str) {
        self.free -= 1;
        *self.held.entry(maker.to_string()).or_default() += 1;
    }

    fn put_back(&mut self, maker: &str) {
        self.free += 1;
        if let Some(count) = self.held.get_mut(maker) {
            *count -= 1;
            if *count == 0 {
                self.held.remove(maker);
            }
        }
    }

    fn enqueue(&mut self, maker: &str) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let queue = self.queues.entry(maker.to_string()).or_default();
        if queue.is_empty() {
            self.turns.push_back(maker.to_string());
        }
        queue.push_back(id);
        self.places.insert(id, Place::Waiting(None));
        id
    }

    fn leave(&mut self, maker: &str, id: u64) {
        self.places.remove(&id);
        if let Some(queue) = self.queues.get_mut(maker) {
            queue.retain(|queued| *queued != id);
            if queue.is_empty() {
                self.queues.remove(maker);
                self.turns.retain(|turn| turn != maker);
            }
        }
    }

    /// Moves each free slot to the oldest waiter of the next maker in turn with room, and that maker goes to the back.
    fn serve(&mut self, share: Option<usize>) -> Vec<Waker> {
        let mut woken = Vec::new();
        while self.free > 0 {
            let Some(at) = self
                .turns
                .iter()
                .position(|maker| self.has_room(maker, share))
            else {
                break;
            };
            let Some(maker) = self.turns.remove(at) else {
                break;
            };
            let Some(queue) = self.queues.get_mut(&maker) else {
                continue;
            };
            let Some(id) = queue.pop_front() else {
                self.queues.remove(&maker);
                continue;
            };
            if queue.is_empty() {
                self.queues.remove(&maker);
            } else {
                self.turns.push_back(maker.clone());
            }
            self.grant(&maker);
            if let Some(Place::Waiting(waker)) = self.places.insert(id, Place::Served) {
                woken.extend(waker);
            }
        }
        woken
    }
}

impl Queued {
    /// Takes a slot moved here meanwhile; otherwise leaves the line if `always` or the maker's share is full.
    pub(super) fn at_deadline(&mut self, always: bool) -> AtDeadline {
        let mut line = self.pool.lock();
        match line.places.get(&self.id) {
            Some(Place::Served) => {
                line.places.remove(&self.id);
                drop(line);
                self.done = true;
                AtDeadline::Served(self.pool.held(&self.maker))
            }
            Some(Place::Waiting(_)) if always || !line.has_room(&self.maker, self.pool.share) => {
                line.leave(&self.maker, self.id);
                self.done = true;
                AtDeadline::Left
            }
            Some(Place::Waiting(_)) => AtDeadline::Stays,
            None => AtDeadline::Left,
        }
    }
}

impl Future for Queued {
    type Output = Held;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Held> {
        let this = &mut *self;
        let mut line = this.pool.lock();
        match line.places.get_mut(&this.id) {
            Some(Place::Served) => {
                line.places.remove(&this.id);
                drop(line);
                this.done = true;
                Poll::Ready(this.pool.held(&this.maker))
            }
            Some(Place::Waiting(waker)) => {
                if !waker.as_ref().is_some_and(|w| w.will_wake(cx.waker())) {
                    *waker = Some(cx.waker().clone());
                }
                Poll::Pending
            }
            None => Poll::Pending,
        }
    }
}

impl Drop for Queued {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        let mut line = self.pool.lock();
        let woken = match line.places.get(&self.id) {
            Some(Place::Served) => {
                line.places.remove(&self.id);
                line.put_back(&self.maker);
                line.serve(self.pool.share)
            }
            Some(Place::Waiting(_)) => {
                line.leave(&self.maker, self.id);
                return;
            }
            None => return,
        };
        drop(line);
        self.pool.announce(woken);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use proptest::prelude::*;

    use super::*;

    async fn take(pool: &Arc<Pool>, maker: &str) -> Held {
        match pool.join(maker) {
            Joined::Held(held) => held,
            Joined::Queued(queued) => queued.await,
        }
    }

    fn queued(pool: &Arc<Pool>, maker: &str) -> Queued {
        match pool.join(maker) {
            Joined::Queued(queued) => queued,
            Joined::Held(_) => panic!("{maker} was given a slot at once"),
        }
    }

    fn poll(queued: &mut Queued) -> Option<Held> {
        match Pin::new(queued).poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(held) => Some(held),
            Poll::Pending => None,
        }
    }

    /// Checks every count against the slots `live` holds and returns the free count.
    fn check(pool: &Pool, total: usize, live: &[Held]) -> usize {
        let line = pool.lock();
        let held: usize = line.held.values().sum();
        let served = line
            .places
            .values()
            .filter(|place| matches!(place, Place::Served))
            .count();
        assert_eq!(line.free + held, total, "every slot is free or held");
        assert_eq!(held, live.len() + served, "every held slot has one owner");
        let mut by_maker: HashMap<&str, usize> = HashMap::new();
        for slot in live {
            *by_maker.entry(slot.maker.as_str()).or_default() += 1;
        }
        for (maker, count) in &line.held {
            assert!(
                pool.share.is_none_or(|share| *count <= share),
                "{maker} holds {count}"
            );
            assert!(by_maker.get(maker.as_str()).copied().unwrap_or(0) <= *count);
        }
        if line.free > 0 {
            assert!(
                line.turns
                    .iter()
                    .all(|maker| !line.has_room(maker, pool.share)),
                "a free slot is never left while a waiter could take it"
            );
        }
        let waiting: usize = line.queues.values().map(VecDeque::len).sum();
        assert_eq!(waiting + served, line.places.len());
        assert_eq!(line.turns.len(), line.queues.len());
        line.free
    }

    #[tokio::test]
    async fn makers_are_served_in_turn_and_one_makers_oldest_first() {
        let pool = Pool::new(1, None);
        let held = take(&pool, "holder").await;
        let (mut a1, mut a2, mut a3, mut b1) = (
            queued(&pool, "a"),
            queued(&pool, "a"),
            queued(&pool, "a"),
            queued(&pool, "b"),
        );
        drop(held);
        let first = poll(&mut a1).expect("a's oldest first");
        assert!(poll(&mut b1).is_none() && poll(&mut a2).is_none());
        drop(first);
        let second = poll(&mut b1).expect("b's turn before a's second");
        assert!(poll(&mut a2).is_none());
        drop(second);
        let third = poll(&mut a2).expect("a's second");
        assert!(poll(&mut a3).is_none());
        drop(third);
        drop(poll(&mut a3).expect("a's third"));
        assert_eq!(check(&pool, 1, &[]), 1);
    }

    #[test]
    fn a_maker_at_its_share_waits_while_another_is_served() {
        let pool = Pool::new(3, Some(1));
        let Joined::Held(a) = pool.join("a") else {
            panic!("a's first slot");
        };
        let mut a2 = queued(&pool, "a");
        let Joined::Held(b) = pool.join("b") else {
            panic!("b has room and a slot is free");
        };
        let live = [a, b];
        assert_eq!(check(&pool, 3, &live), 1);
        assert!(
            poll(&mut a2).is_none(),
            "a is at its share with a slot free"
        );
        drop(live);
        assert!(poll(&mut a2).is_some());
    }

    #[test]
    fn a_waiter_cancelled_after_its_slot_was_moved_to_it_gives_back_exactly_that_slot() {
        let pool = Pool::new(1, Some(4));
        let Joined::Held(held) = pool.join("holder") else {
            panic!("the only slot");
        };
        let mut gone = queued(&pool, "a");
        assert!(poll(&mut gone).is_none());
        drop(held);
        assert_eq!(check(&pool, 1, &[]), 0, "the slot moved to the waiter");
        drop(gone);
        assert_eq!(check(&pool, 1, &[]), 1, "one slot back, not two");
    }

    #[test]
    fn a_slot_moved_to_a_cancelled_waiter_passes_to_the_next() {
        let pool = Pool::new(1, Some(4));
        let Joined::Held(held) = pool.join("holder") else {
            panic!("the only slot");
        };
        let (gone, mut next) = (queued(&pool, "a"), queued(&pool, "b"));
        drop(held);
        drop(gone);
        let passed = poll(&mut next).expect("the slot passed on");
        assert_eq!(check(&pool, 1, std::slice::from_ref(&passed)), 0);
        drop(passed);
        assert_eq!(check(&pool, 1, &[]), 1);
    }

    #[test]
    fn a_waiter_cancelled_before_a_release_leaves_the_line_and_the_slot_goes_on() {
        let pool = Pool::new(1, Some(4));
        let Joined::Held(held) = pool.join("holder") else {
            panic!("the only slot");
        };
        let (gone, mut next) = (queued(&pool, "a"), queued(&pool, "b"));
        drop(gone);
        drop(held);
        let passed = poll(&mut next).expect("the slot went to the waiter left");
        drop(passed);
        assert_eq!(check(&pool, 1, &[]), 1);
    }

    #[test]
    fn a_release_racing_a_cancellation_on_other_threads_keeps_one_slot() {
        for _ in 0..2_000 {
            let pool = Pool::new(1, Some(4));
            let Joined::Held(held) = pool.join("holder") else {
                panic!("the only slot");
            };
            let mut waiter = queued(&pool, "a");
            assert!(poll(&mut waiter).is_none());
            let start = std::sync::Barrier::new(2);
            std::thread::scope(|scope| {
                let start = &start;
                scope.spawn(move || {
                    start.wait();
                    drop(held);
                });
                scope.spawn(move || {
                    start.wait();
                    drop(waiter);
                });
            });
            assert_eq!(check(&pool, 1, &[]), 1);
        }
    }

    #[test]
    fn a_patient_waiter_stays_while_its_maker_has_room_and_leaves_once_the_share_is_full() {
        let pool = Pool::new(2, Some(1));
        let Joined::Held(other) = pool.join("other") else {
            panic!("a free slot");
        };
        let Joined::Held(own) = pool.join("a") else {
            panic!("a free slot");
        };
        let mut waiting = queued(&pool, "a");
        assert!(matches!(waiting.at_deadline(false), AtDeadline::Left));
        drop(waiting);
        drop(own);
        let Joined::Held(third) = pool.join("third") else {
            panic!("a free slot");
        };
        let mut waiting = queued(&pool, "a");
        assert!(matches!(waiting.at_deadline(false), AtDeadline::Stays));
        drop(other);
        assert!(matches!(waiting.at_deadline(false), AtDeadline::Served(_)));
        drop(third);
        assert_eq!(check(&pool, 2, &[]), 2);
    }

    #[derive(Debug, Clone)]
    enum Step {
        Join(u8),
        Poll(usize),
        Release(usize),
        Cancel(usize),
        Deadline(usize, bool),
    }

    fn step() -> impl Strategy<Value = Step> {
        prop_oneof![
            3 => (0u8..12).prop_map(Step::Join),
            2 => any::<usize>().prop_map(Step::Poll),
            2 => any::<usize>().prop_map(Step::Release),
            1 => any::<usize>().prop_map(Step::Cancel),
            1 => (any::<usize>(), any::<bool>()).prop_map(|(at, always)| Step::Deadline(at, always)),
        ]
    }

    proptest! {
        #[test]
        fn no_more_than_32_slots_are_held_or_4_by_one_maker_whatever_the_order(
            steps in prop::collection::vec(step(), 1..400),
        ) {
            let pool = Pool::new(32, Some(4));
            let mut live: Vec<Held> = Vec::new();
            let mut line: Vec<Queued> = Vec::new();
            for step in steps {
                match step {
                    Step::Join(maker) => match pool.join(&format!("m{maker}")) {
                        Joined::Held(held) => live.push(held),
                        Joined::Queued(queued) => line.push(queued),
                    },
                    Step::Poll(at) if !line.is_empty() => {
                        let at = at % line.len();
                        if let Some(held) = poll(&mut line[at]) {
                            live.push(held);
                            line.swap_remove(at);
                        }
                    }
                    Step::Release(at) if !live.is_empty() => {
                        live.swap_remove(at % live.len());
                    }
                    Step::Cancel(at) if !line.is_empty() => {
                        line.swap_remove(at % line.len());
                    }
                    Step::Deadline(at, always) if !line.is_empty() => {
                        let at = at % line.len();
                        match line[at].at_deadline(always) {
                            AtDeadline::Served(held) => {
                                live.push(held);
                                line.swap_remove(at);
                            }
                            AtDeadline::Left => {
                                line.swap_remove(at);
                            }
                            AtDeadline::Stays => {}
                        }
                    }
                    _ => {}
                }
                check(&pool, 32, &live);
            }
            drop(line);
            drop(live);
            prop_assert_eq!(check(&pool, 32, &[]), 32);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn makers_racing_on_threads_never_hold_more_than_the_pool_or_their_share() {
        let pool = Pool::new(32, Some(4));
        let total = Arc::new(AtomicUsize::new(0));
        let makers: Arc<Vec<AtomicUsize>> =
            Arc::new((0..10).map(|_| AtomicUsize::new(0)).collect());
        let mut tasks = Vec::new();
        for task in 0..200usize {
            let (pool, total, makers) = (pool.clone(), total.clone(), makers.clone());
            tasks.push(tokio::spawn(async move {
                for round in 0..40usize {
                    let maker = (task + round) % 10;
                    let wait = Duration::from_micros(((task * 7 + round * 13) % 400) as u64);
                    let Ok(held) =
                        tokio::time::timeout(wait, take(&pool, &format!("m{maker}"))).await
                    else {
                        continue;
                    };
                    assert!(total.fetch_add(1, Ordering::SeqCst) < 32);
                    assert!(makers[maker].fetch_add(1, Ordering::SeqCst) < 4);
                    tokio::task::yield_now().await;
                    makers[maker].fetch_sub(1, Ordering::SeqCst);
                    total.fetch_sub(1, Ordering::SeqCst);
                    drop(held);
                }
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(check(&pool, 32, &[]), 32);
    }
}

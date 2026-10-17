//! The watch: the one source a store has, told to however many listeners.
//!
//! A source runs on a thread of its own and hands each change to the
//! dispatcher, the only thread that calls a listener. The dispatcher owns the
//! listeners and what they were told, so a join, a leave, a hydration and a
//! change are all ordered in one place.

use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, ThreadId};
use std::time::{Duration, Instant};

use crate::catch_up::{Change, ChangeEvent, PACE, Pace};
use crate::error::CoreError;
use crate::{Core, Handle, Result, store};

/// Between the source and the dispatcher: a source that finds it full waits,
/// so the event stream is read no faster than the listeners take changes.
const QUEUE: usize = 1024;

/// How often a reading handle reads the data version, and the longest wait
/// between reads while they fail.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SavesPace {
    pub(crate) poll: Duration,
    pub(crate) retry_most: Duration,
}

pub(crate) const SAVES_PACE: SavesPace = SavesPace {
    poll: Duration::from_millis(250),
    retry_most: Duration::from_secs(2),
};

/// What a caller hands `Core::watch`: told of each change on a thread of the
/// core's, and once when it leaves the watch, with the error that removed it or
/// none where it stopped.
///
/// `changed` must return promptly: every listener is told by one thread, so a
/// slow one delays the rest, and a hydration waits for the call in progress.
pub trait WatchListener: Send + Sync {
    fn changed(&self, change: &Change);
    fn ended(&self, error: Option<CoreError>);
}

/// A listener's place in the watch. Dropping it, or `stop`, removes the
/// listener, which is then told `ended` once.
pub struct Listening {
    watch: Arc<Watch>,
    id: u64,
}

impl Listening {
    pub fn stop(&self) {
        self.watch.leave(self.id);
    }
}

impl Drop for Listening {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    Follow,
    Saves,
}

struct Slot {
    id: u64,
    listener: Arc<dyn WatchListener>,
    /// Last told `server.unreachable`.
    unreachable: bool,
    /// The data version it last read or was told.
    saved: Option<i64>,
}

pub(crate) enum Told {
    Change(Change),
    Saved { version: i64, forced: bool },
    SavesFailed(CoreError),
    Contact,
    Ended(Result<()>),
}

#[derive(Default)]
struct Shared {
    /// The dispatcher thread, while one runs.
    dispatcher: Option<ThreadId>,
    next: u64,
    /// Hydrations and catch-ups holding the stream. Outlives a dispatcher, so
    /// a listener that joins during one waits for it.
    takers: usize,
    /// No source thread runs.
    at_rest: bool,
    joined: Vec<Slot>,
    left: Vec<u64>,
    queue: VecDeque<Told>,
    /// The last taker finished.
    resumed: bool,
    /// A taker succeeded.
    recovered: bool,
    /// A drain the caller started answered a write.
    drained: bool,
}

pub(crate) struct Watch {
    shared: Mutex<Shared>,
    follow_pace: Mutex<Pace>,
    /// The dispatcher waits here for work.
    work: Condvar,
    /// A source waits here for room, and a taker for the source to rest.
    rest: Condvar,
}

fn held(shared: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Watch {
    pub(crate) fn new() -> Arc<Watch> {
        Arc::new(Watch {
            shared: Mutex::new(Shared {
                at_rest: true,
                ..Shared::default()
            }),
            follow_pace: Mutex::new(PACE),
            work: Condvar::new(),
            rest: Condvar::new(),
        })
    }

    pub(crate) fn follow_pace(&self) -> Pace {
        *self
            .follow_pace
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    pub(crate) fn set_follow_pace(&self, pace: Pace) {
        *self
            .follow_pace
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = pace;
    }

    fn leave(&self, id: u64) {
        held(&self.shared).left.push(id);
        self.work.notify_all();
    }

    /// Waits until no source holds the stream, and keeps it from starting
    /// again until the result is dropped.
    pub(crate) fn take(self: &Arc<Self>) -> Result<Taken> {
        let mut shared = held(&self.shared);
        if shared.dispatcher == Some(thread::current().id()) {
            return Err(crate::one_at_a_time());
        }
        shared.takers += 1;
        let taken = Taken {
            watch: Arc::clone(self),
            reached: false,
        };
        self.work.notify_all();
        while shared.dispatcher.is_some() && !shared.at_rest {
            shared = self
                .rest
                .wait(shared)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        Ok(taken)
    }

    /// A drain the caller started answered a write.
    pub(crate) fn drained(&self) {
        let mut shared = held(&self.shared);
        if shared.dispatcher.is_some() {
            shared.drained = true;
            self.work.notify_all();
        }
    }

    fn push(&self, stop: &AtomicBool, told: Told) {
        let mut shared = held(&self.shared);
        while shared.queue.len() >= QUEUE && !stop.load(Ordering::Relaxed) {
            shared = self
                .rest
                .wait_timeout(shared, Duration::from_millis(50))
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        shared.queue.push_back(told);
        drop(shared);
        self.work.notify_all();
    }
}

/// The stream is held off a watch while this lives.
pub(crate) struct Taken {
    watch: Arc<Watch>,
    reached: bool,
}

impl Taken {
    /// The call reached the server and succeeded.
    pub(crate) fn reached(&mut self) {
        self.reached = true;
    }
}

impl Drop for Taken {
    fn drop(&mut self) {
        let mut shared = held(&self.watch.shared);
        shared.takers -= 1;
        if shared.dispatcher.is_some() {
            shared.recovered |= self.reached;
            shared.resumed |= shared.takers == 0;
        }
        drop(shared);
        self.watch.work.notify_all();
    }
}

impl Core {
    /// Adds `listener` to this store's watch, starting it if it was idle.
    ///
    /// A writer with a server follows the event stream, and tells what a
    /// follow tells; a reading handle tells `store.saved` each time another
    /// process saves. However many listeners there are, one source runs, and
    /// only while one is attached. A hydration or catch-up takes the stream
    /// from it for its duration and gives it back, and the listeners are
    /// told nothing of the gap.
    ///
    /// A listener hears what changes after it joins, in order, and is first
    /// told the outage or failure that holds when it joins. `told_unreachable`
    /// says it was last told `server.unreachable` by an earlier watch, so it
    /// is told `server.reachable` once the server is reached and not
    /// `server.unreachable` again before.
    ///
    /// Each listener is told `server.reachable` once a request reaches the
    /// server, however it ends: the follow's, a hydration's or catch-up's that
    /// succeeded, or a drain's that answered a write. A follow that fails ends
    /// no listener: they are told `watch.failed` once and no stream is held
    /// until the next hydration or catch-up. Where the follow lost the server,
    /// or a drain left a write undelivered, the first stream it has after is
    /// drained to once (`device/watch-drains-owed`).
    ///
    /// Refused `NoServer` for a writer with no server. A hydration or catch-up
    /// called from inside `changed` is refused, since it would wait on its own
    /// thread.
    pub fn watch(
        self: &Arc<Self>,
        told_unreachable: bool,
        listener: Arc<dyn WatchListener>,
    ) -> Result<Listening> {
        self.watch_paced(told_unreachable, listener, SAVES_PACE)
    }

    pub(crate) fn watch_paced(
        self: &Arc<Self>,
        told_unreachable: bool,
        listener: Arc<dyn WatchListener>,
        pace: SavesPace,
    ) -> Result<Listening> {
        let source = match self.handle() {
            Handle::Reader => Source::Saves,
            Handle::Writer if self.http.is_some() => Source::Follow,
            Handle::Writer => return Err(CoreError::NoServer),
        };
        // Read before the caller goes on, so a save it makes next is told.
        let saved = (source == Source::Saves)
            .then(|| self.data_version().ok())
            .flatten();
        let mut shared = held(&self.watch.shared);
        let id = shared.next;
        shared.next += 1;
        shared.joined.push(Slot {
            id,
            listener,
            unreachable: told_unreachable,
            saved,
        });
        if shared.dispatcher.is_none() {
            shared.recovered = false;
            shared.resumed = false;
            shared.drained = false;
            shared.at_rest = true;
            let (core, watch) = (Arc::clone(self), Arc::clone(&self.watch));
            let spawned = thread::Builder::new()
                .name("marfa-watch".into())
                .spawn(move || dispatch(core, watch, source, pace))
                .map_err(|error| CoreError::Invalid(format!("the watch cannot start: {error}")));
            match spawned {
                Ok(handle) => shared.dispatcher = Some(handle.thread().id()),
                Err(error) => {
                    shared.joined.pop();
                    return Err(error);
                }
            }
        }
        drop(shared);
        self.watch.work.notify_all();
        Ok(Listening {
            watch: Arc::clone(&self.watch),
            id,
        })
    }

    /// Whether a drain left work for the next stream the watch has.
    pub(crate) fn drain_owed(&self) -> bool {
        self.conn()
            .and_then(|conn| store::drain_owed(&conn))
            .unwrap_or(false)
    }

    /// A drain already made stands whatever this write does.
    pub(crate) fn owe_drain(&self, owed: bool) {
        let _ = self
            .conn()
            .and_then(|conn| store::set_drain_owed(&conn, owed));
    }
}

fn dispatch(core: Arc<Core>, watch: Arc<Watch>, source: Source, pace: SavesPace) {
    let mut dispatcher = Dispatcher {
        core: &core,
        watch: &watch,
        source,
        pace,
        slots: Vec::new(),
        outage: None,
        failed: None,
        halted: false,
        cursor: String::new(),
        run: None,
        restart: false,
        takers_seen: 0,
        farewells: Vec::new(),
    };
    let ran = catch_unwind(AssertUnwindSafe(|| dispatcher.serve()));
    let mut farewells = std::mem::take(&mut dispatcher.farewells);
    if let Err(fault) = ran {
        let error = CoreError::Invalid(format!(
            "the watch stopped on a fault in the core: {}",
            crate::fault_said(fault.as_ref())
        ));
        if let Some(run) = &dispatcher.run {
            run.stop.store(true, Ordering::Relaxed);
        }
        let mut shared = held(&watch.shared);
        shared.dispatcher = None;
        shared.at_rest = true;
        shared.joined.drain(..).for_each(|slot| {
            farewells.push((slot.listener, Some(error.clone())));
        });
        drop(shared);
        watch.rest.notify_all();
        farewells.extend(
            dispatcher
                .slots
                .drain(..)
                .map(|slot| (slot.listener, Some(error.clone()))),
        );
    }
    drop(dispatcher);
    // The store is let go before anyone is told the watch is over: a listener
    // that opens it again on being told must find the writer's role free.
    drop(core);
    for (listener, error) in farewells {
        let _ = catch_unwind(AssertUnwindSafe(|| listener.ended(error)));
    }
}

struct Run {
    stop: Arc<AtomicBool>,
    stopping: bool,
}

struct Dispatcher<'a> {
    core: &'a Arc<Core>,
    watch: &'a Arc<Watch>,
    source: Source,
    pace: SavesPace,
    slots: Vec<Slot>,
    /// The outage the listeners were told, for one that joins.
    outage: Option<CoreError>,
    /// The failure the listeners were told, for one that joins.
    failed: Option<CoreError>,
    /// The follow failed: no stream until a taker has finished.
    halted: bool,
    cursor: String,
    run: Option<Run>,
    restart: bool,
    takers_seen: usize,
    farewells: Vec<(Arc<dyn WatchListener>, Option<CoreError>)>,
}

struct Inbox {
    joined: Vec<Slot>,
    left: Vec<u64>,
    queue: VecDeque<Told>,
    resumed: bool,
    recovered: bool,
    drained: bool,
}

impl Dispatcher<'_> {
    fn serve(&mut self) {
        self.cursor = self.held_cursor();
        loop {
            let inbox = self.wait();
            self.admit(inbox.joined);
            for told in inbox.queue {
                self.tell(told);
            }
            if inbox.recovered {
                self.clear_outage();
            }
            if inbox.drained && self.clear_outage() {
                // The follow believes it has told the outage; it must ask again
                // to tell a new one.
                self.restart = true;
            }
            if inbox.resumed {
                self.halted = false;
                self.failed = None;
            }
            self.depart(&inbox.left);
            self.reconcile();
            if !self.slots.is_empty() {
                self.say_farewells();
            }
            if self.finished() {
                return;
            }
        }
    }

    /// Takes what has arrived, waiting for something to.
    fn wait(&mut self) -> Inbox {
        let mut shared = held(&self.watch.shared);
        loop {
            let moved = shared.takers != self.takers_seen;
            if !shared.joined.is_empty()
                || !shared.left.is_empty()
                || !shared.queue.is_empty()
                || shared.resumed
                || shared.recovered
                || shared.drained
                || moved
                || self.must_reconcile(&shared)
            {
                break;
            }
            shared = self
                .watch
                .work
                .wait(shared)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        self.takers_seen = shared.takers;
        let inbox = Inbox {
            joined: std::mem::take(&mut shared.joined),
            left: std::mem::take(&mut shared.left),
            queue: std::mem::take(&mut shared.queue),
            resumed: std::mem::take(&mut shared.resumed),
            recovered: std::mem::take(&mut shared.recovered),
            drained: std::mem::take(&mut shared.drained),
        };
        drop(shared);
        self.watch.rest.notify_all();
        inbox
    }

    /// Nothing arrived, but the source is not as it should be.
    fn must_reconcile(&self, shared: &Shared) -> bool {
        match &self.run {
            None => self.wanted(shared),
            Some(run) => !run.stopping && (self.slots.is_empty() || self.restart),
        }
    }

    fn wanted(&self, shared: &Shared) -> bool {
        !self.slots.is_empty() && shared.takers == 0 && !self.halted
    }

    /// Starts the source, or asks it to stop, as the listeners and takers
    /// call for.
    fn reconcile(&mut self) {
        let mut shared = held(&self.watch.shared);
        let wanted = self.wanted(&shared);
        match &mut self.run {
            None if wanted => {
                shared.at_rest = false;
                drop(shared);
                self.restart = false;
                self.start();
            }
            Some(run) if (!wanted || self.restart) && !run.stopping => {
                run.stopping = true;
                run.stop.store(true, Ordering::Relaxed);
            }
            _ => {}
        }
    }

    fn start(&mut self) {
        let stop = Arc::new(AtomicBool::new(false));
        let (core, watch, flag) = (
            Arc::clone(self.core),
            Arc::clone(self.watch),
            Arc::clone(&stop),
        );
        let (source, pace) = (self.source, self.pace);
        let owes_drain = source == Source::Follow && core.drain_owed();
        let spawned = thread::Builder::new()
            .name("marfa-watch-source".into())
            .spawn(move || {
                let told = |told| watch.push(&flag, told);
                let ended = catch_unwind(AssertUnwindSafe(|| match source {
                    Source::Follow => core
                        .follow_watched(
                            &flag,
                            owes_drain,
                            |change| told(Told::Change(change.clone())),
                            || told(Told::Contact),
                        )
                        .map(|_| ()),
                    Source::Saves => {
                        read_saves(&|| core.data_version(), &flag, pace, &told);
                        Ok(())
                    }
                }))
                .unwrap_or_else(|fault| {
                    Err(CoreError::Invalid(format!(
                        "the watch's source stopped on a fault in the core: {}",
                        crate::fault_said(fault.as_ref())
                    )))
                });
                // The store is let go before the dispatcher hears it ended.
                drop(core);
                watch.push(&flag, Told::Ended(ended));
            });
        match spawned {
            Ok(_) => {
                self.run = Some(Run {
                    stop,
                    stopping: false,
                })
            }
            Err(error) => {
                held(&self.watch.shared).at_rest = true;
                self.halted = true;
                self.fail(CoreError::Invalid(format!(
                    "the watch's source cannot start: {error}"
                )));
            }
        }
    }

    /// Nothing is left to run or to tell: the watch ends here unless a
    /// listener joined meanwhile.
    fn finished(&mut self) -> bool {
        if !self.slots.is_empty() || self.run.is_some() {
            return false;
        }
        let mut shared = held(&self.watch.shared);
        if !shared.joined.is_empty() || !shared.left.is_empty() || !shared.queue.is_empty() {
            return false;
        }
        shared.dispatcher = None;
        shared.at_rest = true;
        drop(shared);
        self.watch.rest.notify_all();
        true
    }

    fn admit(&mut self, joined: Vec<Slot>) {
        for mut slot in joined {
            let mut alive = true;
            if let Some(reason) = self.outage.clone()
                && !slot.unreachable
            {
                slot.unreachable = true;
                alive = self.deliver(
                    &mut slot,
                    self.change(ChangeEvent::ServerUnreachable(reason)),
                );
            }
            if alive && let Some(error) = self.failed.clone() {
                alive = self.deliver(&mut slot, self.change(ChangeEvent::WatchFailed(error)));
            }
            if alive {
                self.slots.push(slot);
            }
        }
    }

    fn depart(&mut self, left: &[u64]) {
        let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.slots)
            .into_iter()
            .partition(|slot| left.contains(&slot.id));
        self.slots = kept;
        self.farewells
            .extend(gone.into_iter().map(|slot| (slot.listener, None)));
    }

    fn say_farewells(&mut self) {
        for (listener, error) in std::mem::take(&mut self.farewells) {
            let _ = catch_unwind(AssertUnwindSafe(|| listener.ended(error)));
        }
    }

    fn change(&self, event: ChangeEvent) -> Change {
        Change {
            event,
            item_id: None,
            edge_id: None,
            cursor: self.cursor.clone(),
        }
    }

    fn held_cursor(&self) -> String {
        self.core
            .conn()
            .ok()
            .and_then(|conn| {
                store::meta_get(&conn, store::META_EVENT_CURSOR)
                    .ok()
                    .flatten()
            })
            .unwrap_or_default()
    }

    /// Tells one listener one change. A listener that faults is removed.
    fn deliver(&mut self, slot: &mut Slot, change: Change) -> bool {
        match catch_unwind(AssertUnwindSafe(|| slot.listener.changed(&change))) {
            Ok(()) => true,
            Err(fault) => {
                self.farewells.push((
                    Arc::clone(&slot.listener),
                    Some(CoreError::Invalid(format!(
                        "a watch listener stopped on a fault: {}",
                        crate::fault_said(fault.as_ref())
                    ))),
                ));
                false
            }
        }
    }

    /// Tells every listener the change `each` makes for it, if it makes one.
    fn tell_each(&mut self, mut each: impl FnMut(&mut Slot) -> Option<Change>) {
        let mut slots = std::mem::take(&mut self.slots);
        slots.retain_mut(|slot| match each(slot) {
            Some(change) => self.deliver(slot, change),
            None => true,
        });
        self.slots = slots;
    }

    fn tell_all(&mut self, event: ChangeEvent) {
        let change = self.change(event);
        self.tell_each(|_| Some(change.clone()));
    }

    fn tell(&mut self, told: Told) {
        match told {
            Told::Change(change) => self.follow_told(change),
            Told::Saved { version, forced } => {
                let change = self.change(ChangeEvent::Saved(version));
                self.failed = None;
                self.tell_each(|slot| {
                    let due = forced || slot.saved != Some(version);
                    slot.saved = Some(version);
                    due.then(|| change.clone())
                });
            }
            Told::SavesFailed(error) => self.fail(error),
            Told::Contact => {
                self.clear_outage();
            }
            Told::Ended(result) => self.source_ended(result),
        }
    }

    fn follow_told(&mut self, change: Change) {
        self.cursor = change.cursor.clone();
        match &change.event {
            ChangeEvent::ServerUnreachable(reason) => {
                // The drain owed is kept where a restart or a new core finds it.
                self.core.owe_drain(true);
                self.outage = Some(reason.clone());
                self.tell_each(|slot| {
                    (!std::mem::replace(&mut slot.unreachable, true)).then(|| change.clone())
                });
            }
            ChangeEvent::ServerReachable => {
                self.clear_outage();
            }
            _ => self.tell_each(|_| Some(change.clone())),
        }
    }

    /// A request reached the server. Answers whether any listener was told it
    /// had not.
    fn clear_outage(&mut self) -> bool {
        let told = self.outage.take().is_some() | self.slots.iter().any(|slot| slot.unreachable);
        if told {
            let change = self.change(ChangeEvent::ServerReachable);
            self.tell_each(|slot| {
                std::mem::replace(&mut slot.unreachable, false).then(|| change.clone())
            });
        }
        told
    }

    fn fail(&mut self, error: CoreError) {
        self.failed = Some(error.clone());
        self.tell_all(ChangeEvent::WatchFailed(error));
    }

    fn source_ended(&mut self, result: Result<()>) {
        let stopping = self.run.take().is_some_and(|run| run.stopping);
        {
            let mut shared = held(&self.watch.shared);
            shared.at_rest = true;
        }
        self.watch.rest.notify_all();
        // An error met while it was being stopped is met again by the next
        // stream, or beside a hydration that mends it.
        if stopping {
            return;
        }
        self.halted = true;
        self.fail(result.err().unwrap_or_else(|| {
            CoreError::Invalid("the watch's source ended though no one asked it to".into())
        }));
    }
}

/// Reads the data version of a store another process writes, and hands each
/// version it finds, so a listener that read an earlier one is told.
pub(crate) fn read_saves(
    read: &dyn Fn() -> Result<i64>,
    stop: &AtomicBool,
    pace: SavesPace,
    told: &dyn Fn(Told),
) {
    let mut seen = None;
    let mut failing = false;
    let mut wait = pace.poll;
    while !stop.load(Ordering::Relaxed) {
        match read() {
            Ok(now) => {
                // After a failure a save may have gone unseen, so everyone is
                // told.
                if failing || seen != Some(now) {
                    told(Told::Saved {
                        version: now,
                        forced: failing,
                    });
                }
                seen = Some(now);
                failing = false;
                wait = pace.poll;
            }
            Err(error) => {
                if !failing {
                    failing = true;
                    told(Told::SavesFailed(error));
                }
                wait = (wait * 2).min(pace.retry_most);
            }
        }
        let until = Instant::now() + wait;
        while Instant::now() < until && !stop.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(10).min(wait));
        }
    }
}

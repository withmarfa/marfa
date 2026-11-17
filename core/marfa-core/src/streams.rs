//! The one cursor a working copy moves, and the calls that move it: hydration,
//! catch-up and follow, one at a time.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

#[cfg(debug_assertions)]
use crate::fault;
use crate::hydrate::Fill;
use crate::{
    CatchUpFailed, CatchUpReport, Change, Core, CoreError, FollowReport, HydrateReport,
    NEVER_STOPPED, Result, SliceQuery, SliceTier, catch_up, fault_message, http, hydrate, reach,
    store, telemetry,
};

/// What moves the one cursor now.
#[derive(Default)]
pub(crate) struct Streaming {
    pub(crate) holder: Option<Mover>,
    /// A follow is open, holding the stream or waiting for a hydration
    /// without it, so a second follow is refused at once.
    following: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mover {
    Hydration,
    CatchUp,
    Follow,
}

pub(crate) struct StreamClaim<'a>(&'a Mutex<Streaming>);

impl Drop for StreamClaim<'_> {
    fn drop(&mut self) {
        streaming_of(self.0).holder = None;
    }
}

pub(crate) struct FollowClaim<'a>(&'a Mutex<Streaming>);

impl Drop for FollowClaim<'_> {
    fn drop(&mut self) {
        streaming_of(self.0).following = false;
    }
}

/// Holds nothing a panic could leave half-written.
pub(crate) fn streaming_of(streaming: &Mutex<Streaming>) -> MutexGuard<'_, Streaming> {
    streaming
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

const ROWS_CAUGHT_UP_WAIT: Duration = Duration::from_secs(5);

pub(crate) fn one_at_a_time() -> CoreError {
    CoreError::Invalid(
        "this working copy is already hydrating, catching up or following; one at a time moves \
         its cursor"
            .into(),
    )
}

impl Core {
    /// Refused while a catch-up or a follow runs on this handle: a follow
    /// left running across a hydration would apply events read against the
    /// old slice to the new copy. A caller stops its follow first. A watch is
    /// not stopped: the hydration takes its stream, and gives it back.
    ///
    /// `types` is the slice's types. `store::EVERY_TYPE` alone is every type
    /// but `system.*`, hydrated in one pass with no need to read the catalog
    /// and name its types first; beside `system.*` types it adds them, and
    /// beside any other type it is `Invalid`.
    pub fn hydrate(&self, types: &[String], tier: SliceTier) -> Result<HydrateReport> {
        self.hydrate_with(types, tier, &[])
    }

    /// `hydrate_with`, ended with `Canceled` soon after `stop` is raised. The
    /// copy is then unfinished, as after a hydration that failed part way: it
    /// answers lists and searches marked partial and refuses writes; the queue is untouched.
    pub fn hydrate_until(
        &self,
        types: &[String],
        tier: SliceTier,
        edge_types: &[String],
        stop: &AtomicBool,
    ) -> Result<HydrateReport> {
        self.hydrate_filling(types, tier, edge_types, None, Fill::Any, stop)
    }

    /// `hydrate_until` for a slice narrowed past its types and tier by
    /// `query`: the copy then holds, of the rows its types and tier take,
    /// those the query takes (`device/slice-query-outside`). `None` is
    /// `hydrate_until`. A query that narrows by edges or another row is
    /// `Invalid`, since an event cannot be judged by the row it carries.
    pub fn hydrate_sliced(
        &self,
        types: &[String],
        tier: SliceTier,
        edge_types: &[String],
        query: Option<&SliceQuery>,
        stop: &AtomicBool,
    ) -> Result<HydrateReport> {
        self.hydrate_filling(types, tier, edge_types, query, Fill::Any, stop)
    }

    /// `hydrate_until` for a copy that must only ever be filled again in
    /// place (`device/refill-in-place-only`): wherever the fill could not
    /// keep the rows, queue and files the copy holds, it is refused
    /// `CopyExpired` with the reason before anything is cleared, and the copy
    /// stays as it was. The reasons are `not_stale`, `instance_changed`,
    /// `reach_changed`, `slice_changed` and `head_past_log`. A refusal of the
    /// credential or the reach by the server still ends a stale copy,
    /// keeping the queue (`device/refill-in-place-only-server-ends`), and
    /// can also carry `reach_changed`: the copy's `hydration` then reads
    /// `Expired`, where a refused fill leaves a stale copy `Stale`.
    pub fn hydrate_in_place_only(
        &self,
        types: &[String],
        tier: SliceTier,
        edge_types: &[String],
        stop: &AtomicBool,
    ) -> Result<HydrateReport> {
        self.hydrate_filling(types, tier, edge_types, None, Fill::InPlaceOnly, stop)
    }

    fn hydrate_filling(
        &self,
        types: &[String],
        tier: SliceTier,
        edge_types: &[String],
        query: Option<&SliceQuery>,
        fill: Fill,
        stop: &AtomicBool,
    ) -> Result<HydrateReport> {
        self.lock.refuse_unless_writer()?;
        let mut taken = self.watch.take()?;
        let _streaming = self.claim_stream(Mover::Hydration)?;
        let report = hydrate::hydrate(
            self,
            self.http()?,
            types,
            tier,
            edge_types,
            query,
            fill,
            stop,
        )?;
        taken.reached();
        self.settle_bodies(stop)?;
        Ok(report)
    }

    /// Holds every edge of `edge_types` the key reads, whichever ends the
    /// copy holds. `types` reads as in [`Core::hydrate`].
    pub fn hydrate_with(
        &self,
        types: &[String],
        tier: SliceTier,
        edge_types: &[String],
    ) -> Result<HydrateReport> {
        self.hydrate_until(types, tier, edge_types, &NEVER_STOPPED)
    }

    /// A failure does not say whether the catalog changed before it;
    /// `catch_up_until` does.
    pub fn catch_up(&self) -> Result<CatchUpReport> {
        self.catch_up_until(&NEVER_STOPPED)
            .map_err(|failed| failed.error)
    }

    /// Ended with `Canceled` soon after `stop` is raised, keeping the cursor
    /// of the last event taken.
    pub fn catch_up_until(
        &self,
        stop: &AtomicBool,
    ) -> std::result::Result<CatchUpReport, CatchUpFailed> {
        let op = telemetry::operation!("catch_up", applied, skipped);
        let result = self.catch_up_pass(stop);
        telemetry::ended!(
            op,
            result.as_ref().map_err(|failed| &failed.error),
            |report| {
                outcome = "ok",
                applied = report.applied,
                skipped = report.skipped,
            }
        );
        result
    }

    fn catch_up_pass(
        &self,
        stop: &AtomicBool,
    ) -> std::result::Result<CatchUpReport, CatchUpFailed> {
        self.lock.refuse_unless_writer()?;
        let mut taken = self.watch.take()?;
        let _streaming = self.claim_stream(Mover::CatchUp)?;
        let mut catalog_changed = false;
        catch_up::catch_up(
            self,
            self.http()?,
            self.catch_up_idle,
            stop,
            &mut catalog_changed,
        )
        .and_then(|report| {
            taken.reached();
            self.settle_bodies(stop)?;
            Ok(report)
        })
        .map_err(|error| CatchUpFailed {
            error,
            catalog_changed,
        })
    }

    /// An unreadable head does not prevent sending the write.
    pub(crate) fn catch_up_before_rows(&self, stop: &AtomicBool) -> Result<()> {
        let deadline = std::time::Instant::now() + ROWS_CAUGHT_UP_WAIT;
        let _ends_by = http::EndsBy::hold(Some(deadline));
        let target = match catch_up::last_carried(self, self.http()?, deadline, stop) {
            Ok(target) => target,
            Err(error) => {
                catch_up::refuse_if_stopped(stop)?;
                telemetry::degraded!(&error);
                return Ok(());
            }
        };
        let Some(target) = target else {
            return Ok(());
        };
        while !self.applied_through(target)? {
            catch_up::refuse_if_stopped(stop)?;
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return Ok(());
            }
            if streaming_of(&self.streaming).holder.is_some() {
                std::thread::sleep(left.min(Duration::from_millis(20)));
                continue;
            }
            match self.catch_up_by(deadline, stop) {
                Ok(_) => {}
                Err(failed) if failed.error == one_at_a_time() => {}
                Err(failed)
                    if failed.error == CoreError::Canceled
                        || failed.error.is_environmental()
                        || matches!(failed.error, CoreError::StreamIncomplete { .. }) =>
                {
                    catch_up::refuse_if_stopped(stop)?;
                    telemetry::degraded!(&failed.error);
                    return Ok(());
                }
                Err(failed) => return Err(failed.error),
            }
        }
        Ok(())
    }

    fn applied_through(&self, target: u64) -> Result<bool> {
        let cursor = store::meta_get(&*self.conn()?, store::META_EVENT_CURSOR)?;
        Ok(cursor
            .as_deref()
            .and_then(reach::cursor)
            .is_some_and(|cursor| cursor >= target))
    }

    /// A catch-up pass that `deadline` stops as `stop` does.
    fn catch_up_by(
        &self,
        deadline: std::time::Instant,
        stop: &AtomicBool,
    ) -> std::result::Result<CatchUpReport, CatchUpFailed> {
        let cut = AtomicBool::new(false);
        let done = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                while !done.load(Ordering::Relaxed) {
                    if stop.load(Ordering::Relaxed) || std::time::Instant::now() >= deadline {
                        cut.store(true, Ordering::Relaxed);
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            });
            let result = self.catch_up_pass(&cut);
            done.store(true, Ordering::Relaxed);
            result
        })
    }

    /// `on_change` is called with no lock on the store held, so it may read
    /// the row it is told about.
    ///
    /// On a copy never hydrated, or whose hydration is under way or was
    /// interrupted, it waits, asking the server nothing, until a hydration
    /// completes and no hydration or catch-up still holds the stream, then
    /// follows. `stop` ends the wait as it ends the follow. An expired copy
    /// is refused at once, as it stands. A second follow is refused at once,
    /// waiting or not.
    ///
    /// `told_unreachable` says the caller was last told `server.unreachable`
    /// by a follow before this one, so this one says `server.reachable` when
    /// a stream first takes an event or goes live, and nothing before
    /// (`device/follow-told-reachable`).
    ///
    /// Each time it says `server.reachable` with work queued for a drain,
    /// it drains once, on a thread of its own so the stream is read
    /// meanwhile, and tells `queue.drained` or `queue.not_drained`
    /// (`device/follow-drains-reachable`). That drain waits for one under
    /// way to end, and then does only the work left. That drain watches
    /// `stop` as `drain_until` does, and the follow raises `stop` itself
    /// when it ends, however it ends, so no write goes out after either:
    /// give each follow a flag of its own.
    pub fn follow(
        &self,
        stop: &AtomicBool,
        told_unreachable: bool,
        on_change: impl FnMut(&Change),
    ) -> Result<FollowReport> {
        self.follow_from(
            stop,
            catch_up::FollowAs {
                told_unreachable,
                owes_drain: false,
                drains: true,
                pace: catch_up::PACE,
            },
            on_change,
            || {},
        )
    }

    /// The follow a watch holds. `owes_drain` has it drain once at its first
    /// stream, as it does after the server was lost.
    pub(crate) fn follow_watched(
        &self,
        stop: &AtomicBool,
        owes_drain: bool,
        on_change: impl FnMut(&Change),
        on_contact: impl FnMut(),
    ) -> Result<FollowReport> {
        self.follow_from(
            stop,
            catch_up::FollowAs {
                told_unreachable: false,
                owes_drain,
                drains: true,
                pace: self.watch.follow_pace(),
            },
            on_change,
            on_contact,
        )
    }

    fn follow_from(
        &self,
        stop: &AtomicBool,
        how: catch_up::FollowAs,
        on_change: impl FnMut(&Change),
        on_contact: impl FnMut(),
    ) -> Result<FollowReport> {
        self.lock.refuse_unless_writer()?;
        let http = self.http.clone().ok_or(CoreError::NoServer)?;
        let _following = self.claim_follow()?;
        let Some(streaming) = self.claim_stream_once_hydrated(stop)? else {
            return Ok(FollowReport::default());
        };
        self.follow_claimed(http, streaming, stop, how, on_change, |_| {}, on_contact)
    }

    /// A folder's watch hydrates its copy on the thread that follows it, so
    /// this refuses a copy that is not hydrated rather than wait for a
    /// hydration that thread would never run. It never drains: the watch's
    /// own pass drains, and keeps the folder's books as it does.
    pub(crate) fn follow_observed(
        &self,
        stop: &AtomicBool,
        told_unreachable: bool,
        on_change: impl FnMut(&Change),
        on_live: impl FnMut(bool),
    ) -> Result<FollowReport> {
        self.lock.refuse_unless_writer()?;
        let http = self.http.clone().ok_or(CoreError::NoServer)?;
        let _following = self.claim_follow()?;
        let streaming = self.claim_stream(Mover::Follow)?;
        self.follow_claimed(
            http,
            streaming,
            stop,
            catch_up::FollowAs {
                told_unreachable,
                owes_drain: false,
                drains: false,
                pace: catch_up::PACE,
            },
            on_change,
            on_live,
            || {},
        )
    }

    /// `None` where `stop` was raised while it waited.
    fn claim_stream_once_hydrated(&self, stop: &AtomicBool) -> Result<Option<StreamClaim<'_>>> {
        let mut waited = false;
        loop {
            let mut conn = self.conn()?;
            let answer = catch_up::refuse_unless_current(&mut conn);
            // A refill under way is waited for as a first hydration is; a
            // stale copy no refill has begun is refused.
            let waits = match &answer {
                Err(CoreError::NoCursor | CoreError::HydrationIncomplete) => true,
                Err(CoreError::CopyExpired { reason, .. })
                    if reason == catch_up::CATCHUP_TOO_OLD =>
                {
                    !store::hydration_complete(&conn)?
                }
                _ => false,
            };
            drop(conn);
            match answer {
                Ok(()) => match self.try_claim_stream(Mover::Follow) {
                    Ok(claim) => return Ok(Some(claim)),
                    // The hydration waited for holds it until it has
                    // settled, and a catch-up may have taken it since.
                    Err(Mover::Hydration | Mover::CatchUp) if waited => {}
                    Err(_) => return Err(one_at_a_time()),
                },
                Err(_) if waits => {
                    #[cfg(debug_assertions)]
                    if !waited {
                        fault::hold(|| "follow-waiting");
                    }
                    waited = true;
                }
                Err(error) => return Err(error),
            }
            if stop.load(Ordering::Relaxed) {
                return Ok(None);
            }
            std::thread::sleep(catch_up::PACE.stop_poll);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn follow_claimed(
        &self,
        http: Arc<http::Http>,
        _streaming: StreamClaim<'_>,
        stop: &AtomicBool,
        how: catch_up::FollowAs,
        mut on_change: impl FnMut(&Change),
        mut on_live: impl FnMut(bool),
        mut on_contact: impl FnMut(),
    ) -> Result<FollowReport> {
        // A binding says the follow ended when this returns: a fault that
        // unwound past here would end the thread silently, and a caller
        // waiting to be told would wait for good.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            catch_up::follow(
                self,
                http,
                stop,
                how,
                &mut on_change,
                &mut on_live,
                &mut on_contact,
            )
        }))
        .unwrap_or_else(|fault| Err(CoreError::Fault(fault_message(fault.as_ref()))))
    }

    pub(crate) fn claim_stream(&self, mover: Mover) -> Result<StreamClaim<'_>> {
        self.try_claim_stream(mover).map_err(|_| one_at_a_time())
    }

    /// Refused with what holds the stream.
    pub(crate) fn try_claim_stream(
        &self,
        mover: Mover,
    ) -> std::result::Result<StreamClaim<'_>, Mover> {
        let mut streaming = streaming_of(&self.streaming);
        if let Some(holder) = streaming.holder {
            return Err(holder);
        }
        streaming.holder = Some(mover);
        Ok(StreamClaim(&self.streaming))
    }

    pub(crate) fn claim_follow(&self) -> Result<FollowClaim<'_>> {
        let mut streaming = streaming_of(&self.streaming);
        if streaming.following {
            return Err(one_at_a_time());
        }
        streaming.following = true;
        Ok(FollowClaim(&self.streaming))
    }
}

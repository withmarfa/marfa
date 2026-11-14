//! The one place code asks the time, kept from stamping below the trusted time or judging age far ahead of it.

#[cfg(feature = "test-hooks")]
use std::sync::MutexGuard;
use std::sync::{Mutex, PoisonError};

use std::fmt;

use chrono::{DateTime, Utc};
use marfa_rules::time;
use rusqlite::OptionalExtension;
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use tokio::sync::watch;

use crate::app::refusal::{self, Refusal};

#[cfg(feature = "test-hooks")]
pub const MAX_OFFSET_MS: u64 = 3_153_600_000_000;
const FIRST_MS: i64 = -62_167_219_200_000;
const LAST_MS: i64 = 253_402_300_799_999;

const DAY_MS: i64 = 86_400_000;
/// How far the wall clock may run ahead of the trusted time before clean-up holds.
pub const AHEAD_MS: i64 = 7 * DAY_MS;
/// How long the server runs with no further jump before a hold ends by itself.
pub const STEADY_MS: i64 = DAY_MS;
/// How far behind the trusted time the wall clock is before the owner is told.
pub const BEHIND_MS: i64 = 3_600_000;
/// The most the wall clock and the steady clock may part between two looks without it being a jump.
const JUMP_MS: i64 = 60_000;

/// The trusted time, and how long the clock has held clean-up.
#[derive(Clone, Copy, Debug, Default)]
pub struct Guard {
    trusted: Option<i64>,
    /// The wall and steady readings at the last look.
    last: Option<(i64, i64)>,
    /// The steady reading the count toward a hold's end started from.
    steady_since: Option<i64>,
    /// The wall clock fell behind the trusted time, and time runs on from it by the steady clock.
    running_on: bool,
}

impl Guard {
    /// Brings the guard up to these readings, and answers whether clean-up holds.
    fn look(&mut self, wall: i64, steady: i64) -> bool {
        let was_held = self.steady_since.is_some();
        let (jumped, passed) = self.last.map_or((false, 0), |(last_wall, last_steady)| {
            let passed = steady - last_steady;
            (((wall - last_wall) - passed).abs() > JUMP_MS, passed.max(0))
        });
        self.last = Some((wall, steady));
        let trusted = *self.trusted.get_or_insert(wall);
        if wall - trusted <= AHEAD_MS {
            self.steady_since = None;
            let run = if self.running_on || wall < trusted {
                trusted.saturating_add(if was_held { 0 } else { passed })
            } else {
                wall
            };
            self.running_on = wall < run;
            self.trusted = Some(run.max(wall));
            return false;
        }
        self.running_on = false;
        let since = match self.steady_since {
            Some(since) if !jumped => since,
            _ => steady,
        };
        if steady - since >= STEADY_MS {
            self.confirm(wall);
            return false;
        }
        self.steady_since = Some(since);
        true
    }

    fn confirm(&mut self, wall: i64) {
        self.trusted = Some(wall);
        self.steady_since = None;
        self.running_on = false;
    }

    fn standing(&mut self, wall: i64, steady: i64) -> Standing {
        let held = self.look(wall, steady);
        let trusted = self.trusted.unwrap_or(wall);
        match (held, self.steady_since) {
            (true, Some(since)) => Standing::Ahead {
                trusted: Stamp::clamped(trusted),
                wall: Stamp::clamped(wall),
                ends: Stamp::clamped(wall.saturating_add(STEADY_MS - (steady - since))),
            },
            _ if trusted - wall > BEHIND_MS => Standing::Behind {
                trusted: Stamp::clamped(trusted),
                wall: Stamp::clamped(wall),
            },
            _ => Standing::Agrees,
        }
    }
}

/// How the wall clock stands against the trusted time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    Agrees,
    /// Clean-up holds until `ends`, unless the clock jumps again or the owner confirms the time.
    Ahead {
        trusted: Stamp,
        wall: Stamp,
        ends: Stamp,
    },
    /// The server's time runs on ahead of the clock.
    Behind {
        trusted: Stamp,
        wall: Stamp,
    },
}

/// What the database keeps of the clock, written with every write that commits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Kept {
    pub trusted_at: Stamp,
    /// The wall clock at the last look before the write.
    pub clock_at: Stamp,
    /// The wall-clock time the count toward a hold's end began, while clean-up holds.
    pub steady_from: Option<Stamp>,
}

#[cfg(feature = "test-hooks")]
#[derive(Debug)]
struct State {
    offset_ms: u64,
    /// Moves the wall clock alone, as a host's clock being set does.
    jump_ms: i64,
    /// The wall and steady readings it was paused at.
    paused_at: Option<(i64, i64)>,
}

#[derive(Debug)]
#[cfg_attr(not(feature = "test-hooks"), derive(Default))]
pub struct Clock {
    guard: Mutex<Guard>,
    #[cfg(feature = "test-hooks")]
    state: Mutex<State>,
    moved: watch::Sender<u64>,
}

#[cfg(feature = "test-hooks")]
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Refused {
    #[error("the clock cannot be more than {MAX_OFFSET_MS} ms ahead")]
    TooFarAhead,
    #[error("the clock cannot move past the last instant")]
    PastLastInstant,
    #[error("the clock cannot be set more than {MAX_OFFSET_MS} ms either way")]
    TooFarSet,
}

fn system_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// A clock that counts the time the host sleeps and that nothing sets.
fn steady_ms() -> i64 {
    #[cfg(target_os = "linux")]
    const STEADY: libc::clockid_t = libc::CLOCK_BOOTTIME;
    #[cfg(not(target_os = "linux"))]
    const STEADY: libc::clockid_t = libc::CLOCK_MONOTONIC;
    let mut at = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `at` is a whole `timespec`, which the call fills.
    unsafe { libc::clock_gettime(STEADY, &mut at) };
    at.tv_sec
        .saturating_mul(1_000)
        .saturating_add(at.tv_nsec / 1_000_000)
}

impl Clock {
    #[cfg(feature = "test-hooks")]
    pub fn new(offset_ms: u64) -> Clock {
        Clock {
            guard: Mutex::default(),
            state: Mutex::new(State {
                offset_ms,
                jump_ms: 0,
                paused_at: None,
            }),
            moved: watch::Sender::new(0),
        }
    }

    /// Starts from what the database keeps, before anything asks the time.
    ///
    /// A hold's count carries on across the restart, the time stopped included, unless the
    /// clock now reads earlier than it did at the last write, which only a clock set back does.
    pub fn resume_from(&self, kept: Option<Kept>) {
        let mut guard = self.guard();
        let (wall, steady) = self.readings();
        guard.trusted = kept.map(|kept| kept.trusted_at.ms());
        guard.steady_since = kept
            .filter(|kept| wall >= kept.clock_at.ms())
            .and_then(|kept| kept.steady_from)
            .map(|from| steady.saturating_sub(wall.saturating_sub(from.ms()).max(0)));
        guard.last = Some((wall, steady));
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, Guard> {
        self.guard.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(feature = "test-hooks")]
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(feature = "test-hooks")]
    fn readings(&self) -> (i64, i64) {
        let state = self.state();
        let (wall, steady) = state
            .paused_at
            .unwrap_or_else(|| (system_ms(), steady_ms()));
        let offset = state.offset_ms as i64;
        (wall + offset + state.jump_ms, steady + offset)
    }

    #[cfg(not(feature = "test-hooks"))]
    fn readings(&self) -> (i64, i64) {
        (system_ms(), steady_ms())
    }

    /// The trusted time, which runs on by the steady clock while the wall clock is behind it, or
    /// the wall clock alone while clean-up holds.
    pub fn now_ms(&self) -> i64 {
        let mut guard = self.guard();
        let (wall, steady) = self.readings();
        if guard.look(wall, steady) {
            wall
        } else {
            guard.trusted.unwrap_or(wall)
        }
    }

    /// The time a clean-up judges age by, or `None` while it holds and must keep everything.
    pub fn judging(&self) -> Option<Stamp> {
        let mut guard = self.guard();
        let (wall, steady) = self.readings();
        (!guard.look(wall, steady)).then(|| Stamp::clamped(guard.trusted.unwrap_or(wall)))
    }

    pub fn standing(&self) -> Standing {
        let (mut guard, (wall, steady)) = (self.guard(), self.readings());
        guard.standing(wall, steady)
    }

    /// Takes the wall clock as right; answers the guard it replaced, for [`Clock::undo`].
    pub fn confirm(&self) -> (Stamp, Guard) {
        let mut guard = self.guard();
        let before = *guard;
        let (wall, steady) = self.readings();
        guard.last = Some((wall, steady));
        guard.confirm(wall);
        (Stamp::clamped(wall), before)
    }

    /// Puts back the guard a confirmation replaced, keeping the latest readings.
    pub fn undo(&self, before: Guard) {
        let mut guard = self.guard();
        *guard = Guard {
            last: guard.last,
            ..before
        };
    }

    /// Reads no clock, so a write that asked no time leaves the row as it is.
    pub fn keep(&self, tx: &rusqlite::Transaction<'_>) -> refusal::Result<()> {
        let guard = *self.guard();
        let (Some(trusted), Some((wall, steady))) = (guard.trusted, guard.last) else {
            return Ok(());
        };
        let kept = Kept {
            trusted_at: Stamp::clamped(trusted),
            clock_at: Stamp::clamped(wall),
            steady_from: guard
                .steady_since
                .map(|since| Stamp::clamped(wall.saturating_sub(steady - since))),
        };
        tx.prepare_cached(
            "INSERT INTO clock_trust (id, trusted_at, clock_at, steady_from) VALUES (1, ?1, ?2, ?3) \
             ON CONFLICT (id) DO UPDATE SET trusted_at = excluded.trusted_at, \
             clock_at = excluded.clock_at, steady_from = excluded.steady_from \
             WHERE (trusted_at, clock_at, steady_from) IS NOT \
             (excluded.trusted_at, excluded.clock_at, excluded.steady_from)",
        )?
        .execute(rusqlite::params![kept.trusted_at, kept.clock_at, kept.steady_from])?;
        Ok(())
    }

    /// The time to the millisecond, which never leaves the years a [`Stamp`] holds.
    pub fn instant(&self) -> Stamp {
        Stamp::clamped(self.now_ms())
    }

    pub fn now(&self) -> DateTime<Utc> {
        self.instant().at()
    }

    pub fn stamp(&self) -> String {
        self.instant().text()
    }

    #[cfg(feature = "test-hooks")]
    pub fn offset_ms(&self) -> u64 {
        self.state().offset_ms
    }

    #[cfg(feature = "test-hooks")]
    pub fn jump_ms(&self) -> i64 {
        self.state().jump_ms
    }

    #[cfg(feature = "test-hooks")]
    pub fn is_paused(&self) -> bool {
        self.state().paused_at.is_some()
    }

    #[cfg(not(feature = "test-hooks"))]
    pub fn is_paused(&self) -> bool {
        false
    }

    /// Changes each time the clock is moved or paused, so a wait on it can be measured again.
    pub fn moves(&self) -> watch::Receiver<u64> {
        self.moved.subscribe()
    }

    #[cfg(feature = "test-hooks")]
    fn tell_moved(&self) {
        self.moved.send_modify(|count| *count += 1);
    }

    /// Time passing while the server runs: both clocks move, and the trusted time moves with them
    /// unless clean-up holds.
    #[cfg(feature = "test-hooks")]
    pub fn advance(&self, ms: u64) -> Result<u64, Refused> {
        let mut guard = self.guard();
        let (wall, steady) = self.readings();
        let held = guard.look(wall, steady);
        let mut state = self.state();
        let offset = state
            .offset_ms
            .checked_add(ms)
            .filter(|offset| *offset <= MAX_OFFSET_MS)
            .ok_or(Refused::TooFarAhead)?;
        if wall.saturating_add(ms as i64) > LAST_MS {
            return Err(Refused::PastLastInstant);
        }
        state.offset_ms = offset;
        drop(state);
        guard.last = Some(self.readings());
        if !held {
            guard.trusted = guard
                .trusted
                .map(|trusted| trusted.saturating_add(ms as i64));
        }
        drop(guard);
        self.tell_moved();
        Ok(offset)
    }

    /// The host's clock set by `ms`, either way, while no time passes.
    #[cfg(feature = "test-hooks")]
    pub fn jump(&self, ms: i64) -> Result<i64, Refused> {
        let guard = self.guard();
        let (wall, _) = self.readings();
        let mut state = self.state();
        let jump = state
            .jump_ms
            .checked_add(ms)
            .filter(|jump| jump.unsigned_abs() <= MAX_OFFSET_MS)
            .ok_or(Refused::TooFarSet)?;
        if !(FIRST_MS..=LAST_MS).contains(&wall.saturating_add(ms)) {
            return Err(Refused::PastLastInstant);
        }
        state.jump_ms = jump;
        drop((state, guard));
        self.tell_moved();
        Ok(jump)
    }

    /// Resuming reads the system clock again, so the time paused is caught up.
    #[cfg(feature = "test-hooks")]
    pub fn pause(&self, paused: bool) {
        let guard = self.guard();
        let mut state = self.state();
        state.paused_at = if paused {
            Some(
                state
                    .paused_at
                    .unwrap_or_else(|| (system_ms(), steady_ms())),
            )
        } else {
            None
        };
        drop((state, guard));
        self.tell_moved();
    }
}

/// What the database keeps of the clock; `None` before the first write.
pub fn kept(tx: &rusqlite::Transaction<'_>) -> refusal::Result<Option<Kept>> {
    let stored: Option<(String, String, Option<String>)> = tx
        .query_row(
            "SELECT trusted_at, clock_at, steady_from FROM clock_trust WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    stored
        .map(|(trusted_at, clock_at, steady_from)| {
            Ok(Kept {
                trusted_at: Stamp::read(&trusted_at)?,
                clock_at: Stamp::read(&clock_at)?,
                steady_from: steady_from.as_deref().map(Stamp::read).transpose()?,
            })
        })
        .transpose()
}

/// A time as every table holds it: RFC 3339 UTC text with milliseconds, which sorts as it reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Stamp(DateTime<Utc>);

impl Stamp {
    fn clamped(ms: i64) -> Stamp {
        Stamp(DateTime::from_timestamp_millis(ms.clamp(FIRST_MS, LAST_MS)).unwrap_or_default())
    }

    /// Refuses an instant outside the years 0000 to 9999, which no text of this form can hold.
    pub fn from_ms(ms: i64) -> refusal::Result<Stamp> {
        (FIRST_MS..=LAST_MS)
            .contains(&ms)
            .then(|| DateTime::from_timestamp_millis(ms))
            .flatten()
            .map(Stamp)
            .ok_or_else(|| Refusal::internal("a time outside the years 0000 to 9999"))
    }

    /// Refuses any text but the one form a time is stored in.
    pub fn read(stored: &str) -> refusal::Result<Stamp> {
        Stamp::parsed(stored).ok_or_else(|| Refusal::unread("a stored time did not read"))
    }

    /// For a caller that reports an unreadable time itself.
    pub fn parsed(stored: &str) -> Option<Stamp> {
        time::instant(stored, "")
            .ok()
            .filter(|at| time::written(at) == stored)
            .map(Stamp)
    }

    pub fn ms(self) -> i64 {
        self.0.timestamp_millis()
    }

    pub fn at(self) -> DateTime<Utc> {
        self.0
    }

    pub fn text(self) -> String {
        time::written(&self.0)
    }

    pub fn plus_ms(self, ms: i64) -> refusal::Result<Stamp> {
        Stamp::from_ms(self.ms().saturating_add(ms))
    }

    /// `None` once no stored time can be that early, so a cutoff there keeps everything.
    pub fn earlier_by(self, ms: i64) -> Option<Stamp> {
        let at = self.ms().saturating_sub(ms);
        (at >= FIRST_MS)
            .then(|| DateTime::from_timestamp_millis(at))
            .flatten()
            .map(Stamp)
    }
}

/// Holds only for a time in the stored form, and is never NULL; `strftime` alone would pass an hour of 24.
pub fn readable(column: &str) -> String {
    format!(
        "COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', {column}) = {column} AND substr({column}, 12, 2) < '24', 0)"
    )
}

/// Rows a clean-up keeps because the time it judges them by does not read.
pub struct Unread<'a> {
    pub table: &'a str,
    /// A column, or an expression of columns.
    pub time: &'a str,
    /// What else makes a row the clean-up's.
    pub scope: &'a str,
}

impl Unread<'_> {
    /// Counts them whatever a cutoff would say, and warns when there are any.
    pub fn report(
        &self,
        db: &rusqlite::Connection,
        job: &str,
        args: impl rusqlite::Params,
    ) -> refusal::Result<i64> {
        let Unread { table, time, scope } = self;
        let count: i64 = db.query_row(
            &format!(
                "SELECT count(*) FROM {table} WHERE ({scope}) AND {time} IS NOT NULL AND NOT {}",
                readable(time)
            ),
            args,
            |row| row.get(0),
        )?;
        if count > 0 {
            tracing::warn!(
                job,
                table,
                count,
                "A clean-up kept rows whose stored time does not read"
            );
        }
        Ok(count)
    }
}

impl fmt::Display for Stamp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.text())
    }
}

impl serde::Serialize for Stamp {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.text())
    }
}

impl ToSql for Stamp {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.text()))
    }
}

impl FromSql for Stamp {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Stamp> {
        Stamp::parsed(value.as_str()?).ok_or_else(|| {
            FromSqlError::Other("a stored time is not RFC 3339 UTC text with milliseconds".into())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_paused_clock_stands_still_and_keeps_its_offset_when_it_resumes() {
        let clock = Clock::new(0);
        clock.pause(true);
        let at = clock.now_ms();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(clock.now_ms(), at);
        clock.advance(1_000).unwrap();
        assert_eq!(clock.now_ms(), at + 1_000);
        clock.pause(false);
        assert!(clock.now_ms() >= at + 1_005);
        assert_eq!(clock.offset_ms(), 1_000);
    }

    const T0: i64 = 1_800_000_000_000;

    fn started_at(trusted: i64) -> Guard {
        Guard {
            trusted: Some(trusted),
            ..Guard::default()
        }
    }

    fn kept(trusted_at: i64, clock_at: i64, steady_from: Option<i64>) -> Option<Kept> {
        Some(Kept {
            trusted_at: Stamp::from_ms(trusted_at).unwrap(),
            clock_at: Stamp::from_ms(clock_at).unwrap(),
            steady_from: steady_from.map(|from| Stamp::from_ms(from).unwrap()),
        })
    }

    const TABLE: &str = "CREATE TABLE clock_trust (id INTEGER PRIMARY KEY CHECK (id = 1), \
        trusted_at TEXT NOT NULL, clock_at TEXT NOT NULL, steady_from TEXT) STRICT";

    fn paused() -> (Clock, i64) {
        let clock = Clock::new(0);
        clock.pause(true);
        let (wall, _) = clock.readings();
        (clock, wall)
    }

    #[test]
    fn holds_only_once_the_wall_clock_is_more_than_seven_days_ahead_of_the_trusted_time() {
        let mut guard = started_at(T0);
        assert!(!guard.look(T0 + AHEAD_MS, 0));
        assert_eq!(guard.trusted, Some(T0 + AHEAD_MS));
        let mut guard = started_at(T0);
        assert!(guard.look(T0 + AHEAD_MS + 1, 0));
        assert_eq!(
            guard.trusted,
            Some(T0),
            "the trusted time stays while it holds"
        );
    }

    #[test]
    fn a_clock_behind_the_trusted_time_runs_on_from_it_and_holds_nothing() {
        let (clock, now) = paused();
        let ahead = now + DAY_MS;
        clock.resume_from(kept(ahead, now, None));
        assert_eq!(clock.now_ms(), ahead);
        assert!(matches!(clock.standing(), Standing::Behind { .. }));
        clock.advance(1_000).unwrap();
        assert_eq!(clock.now_ms(), ahead + 1_000);
        assert_eq!(clock.judging().map(Stamp::ms), Some(ahead + 1_000));
    }

    #[test]
    fn a_clock_set_back_runs_on_by_the_steady_clock_until_it_catches_up() {
        let mut guard = started_at(T0);
        assert!(!guard.look(T0, 0));
        assert!(!guard.look(T0 - DAY_MS, 1_000));
        assert_eq!(guard.trusted, Some(T0 + 1_000));
        assert!(!guard.look(T0 - DAY_MS + 5_000, 6_000));
        assert_eq!(guard.trusted, Some(T0 + 6_000));
        // Set forward, still short of the server's time.
        assert!(!guard.look(T0 + 3_000, 7_000));
        assert_eq!(guard.trusted, Some(T0 + 7_000));
        // Set forward past it: the server keeps time by the clock again.
        assert!(!guard.look(T0 + 10_000, 8_000));
        assert_eq!(guard.trusted, Some(T0 + 10_000));
        assert!(!guard.look(T0 + 10_500, 8_500));
        assert_eq!(guard.trusted, Some(T0 + 10_500));
    }

    #[test]
    fn a_hold_ends_after_a_steady_day_and_a_jump_starts_the_day_again() {
        let mut guard = started_at(T0);
        let wall = T0 + 31 * DAY_MS;
        assert!(guard.look(wall, 0));
        assert!(guard.look(wall + STEADY_MS / 2, STEADY_MS / 2));
        // Set a further hour ahead while half the day had passed.
        assert!(guard.look(wall + STEADY_MS / 2 + 3_600_000, STEADY_MS / 2));
        assert!(guard.look(wall + STEADY_MS + 3_600_000, STEADY_MS));
        let ends = wall + 3 * STEADY_MS / 2 + 3_600_000;
        assert!(guard.look(ends - 1, 3 * STEADY_MS / 2 - 1));
        assert!(!guard.look(ends, 3 * STEADY_MS / 2));
        assert_eq!(guard.trusted, Some(ends));
    }

    #[test]
    fn a_host_asleep_past_the_margin_holds_for_a_day_on_waking() {
        let mut guard = started_at(T0);
        assert!(!guard.look(T0, 0));
        let woke = T0 + 10 * DAY_MS;
        assert!(guard.look(woke, 10 * DAY_MS));
        assert!(!guard.look(woke + STEADY_MS, 11 * DAY_MS));
    }

    #[test]
    fn a_clock_set_right_after_a_hold_leaves_no_stamp_pinned() {
        let mut guard = started_at(T0);
        assert!(guard.look(T0 + 400 * DAY_MS, 0));
        assert!(!guard.look(T0 + 1_000, 1_000));
        assert_eq!(guard.trusted, Some(T0 + 1_000));
    }

    #[test]
    fn a_restart_carries_the_day_on_with_the_time_stopped() {
        let (clock, now) = paused();
        let half = STEADY_MS / 2;
        clock.resume_from(kept(now - 31 * DAY_MS, now - 60_000, Some(now - half)));
        assert_eq!(
            clock.standing(),
            Standing::Ahead {
                trusted: Stamp::from_ms(now - 31 * DAY_MS).unwrap(),
                wall: Stamp::from_ms(now).unwrap(),
                ends: Stamp::from_ms(now + half).unwrap(),
            }
        );
        clock.advance(half as u64 - 1).unwrap();
        assert_eq!(clock.judging(), None);
        clock.advance(1).unwrap();
        assert_eq!(clock.judging().map(Stamp::ms), Some(now + half));
    }

    #[test]
    fn a_restart_with_the_clock_earlier_than_at_the_last_write_starts_the_day_again() {
        let (clock, now) = paused();
        clock.resume_from(kept(
            now - 31 * DAY_MS,
            now + 60_000,
            Some(now - STEADY_MS / 2),
        ));
        assert!(matches!(
            clock.standing(),
            Standing::Ahead { ends, .. } if ends.ms() == now + STEADY_MS
        ));
    }

    #[test]
    fn confirming_takes_the_wall_clock_either_way() {
        let clock = Clock::new(0);
        let now = clock.instant().ms();
        clock.resume_from(kept(now - 180 * DAY_MS, now, None));
        assert_eq!(clock.judging(), None);
        assert!(matches!(clock.standing(), Standing::Ahead { .. }));
        assert!(clock.confirm().0.ms() >= now);
        assert!(clock.judging().is_some());
        assert_eq!(clock.standing(), Standing::Agrees);

        let clock = Clock::new(0);
        clock.resume_from(kept(now + 30 * DAY_MS, now, None));
        let confirmed = clock.confirm().0.ms();
        assert!(confirmed < now + DAY_MS);
        assert!(clock.now_ms() < now + DAY_MS);
    }

    #[test]
    fn undoing_a_confirmation_puts_the_hold_back() {
        let (clock, now) = paused();
        clock.resume_from(kept(now - 180 * DAY_MS, now, None));
        let ends = clock.standing();
        let (_, before) = clock.confirm();
        assert_eq!(clock.standing(), Standing::Agrees);
        clock.undo(before);
        assert_eq!(clock.standing(), ends);
    }

    #[test]
    fn time_that_passes_carries_the_trusted_time_and_a_set_clock_does_not() {
        let clock = Clock::new(0);
        clock.pause(true);
        let start = clock.now_ms();
        clock.advance(400 * DAY_MS as u64).unwrap();
        assert_eq!(clock.judging().map(Stamp::ms), Some(start + 400 * DAY_MS));
        clock.jump(31 * DAY_MS).unwrap();
        assert_eq!(clock.judging(), None);
        assert_eq!(clock.now_ms(), start + 431 * DAY_MS);
        clock.advance(STEADY_MS as u64 - 1).unwrap();
        assert_eq!(clock.judging(), None);
        clock.advance(1).unwrap();
        assert_eq!(
            clock.judging().map(Stamp::ms),
            Some(start + 431 * DAY_MS + STEADY_MS)
        );
    }

    #[test]
    fn a_clock_stepped_back_stamps_nothing_earlier_and_time_runs_on() {
        let clock = Clock::new(0);
        clock.pause(true);
        let before = clock.now_ms();
        clock.jump(-DAY_MS).unwrap();
        assert_eq!(clock.now_ms(), before);
        clock.advance(DAY_MS as u64 + 1).unwrap();
        assert_eq!(clock.now_ms(), before + DAY_MS + 1);
    }

    #[test]
    fn keeps_what_it_knows_in_the_transaction() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(TABLE).unwrap();
        let (clock, now) = paused();
        let tx = db.transaction().unwrap();
        assert_eq!(super::kept(&tx).unwrap(), None);
        clock.keep(&tx).unwrap();
        assert_eq!(
            super::kept(&tx).unwrap(),
            None,
            "nothing before the first look"
        );
        clock.now_ms();
        clock.keep(&tx).unwrap();
        assert_eq!(super::kept(&tx).unwrap(), kept(now, now, None));

        clock.resume_from(kept(now - 31 * DAY_MS, now, None));
        clock.advance(1_000).unwrap();
        clock.keep(&tx).unwrap();
        assert_eq!(
            super::kept(&tx).unwrap(),
            kept(now - 31 * DAY_MS, now + 1_000, Some(now)),
            "the count toward the hold's end began at the first look"
        );
        tx.commit().unwrap();
        for column in ["trusted_at", "clock_at", "steady_from"] {
            let tx = db.transaction().unwrap();
            tx.execute(&format!("UPDATE clock_trust SET {column} = 'soon'"), [])
                .unwrap();
            assert!(super::kept(&tx).is_err(), "{column}");
        }
    }

    #[test]
    fn a_hold_counts_no_time_stopped_when_the_clock_moved_on_while_stopped() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(TABLE).unwrap();
        let (before, _) = paused();
        before.now_ms();
        before.jump(30 * DAY_MS).unwrap();
        before.advance(10_000).unwrap();
        assert_eq!(before.judging(), None, "the witness: held at 30 days");
        let tx = db.transaction().unwrap();
        before.keep(&tx).unwrap();
        tx.commit().unwrap();

        let (after, _) = paused();
        after.jump(32 * DAY_MS).unwrap();
        let tx = db.transaction().unwrap();
        after.resume_from(super::kept(&tx).unwrap());
        assert_eq!(after.judging(), None, "restarted at 32 days");
        after.advance((STEADY_MS - 10_000) as u64 - 1).unwrap();
        assert_eq!(after.judging(), None);
        after.advance(1).unwrap();
        assert!(after.judging().is_some(), "a day of running in all");
    }

    #[test]
    fn stops_at_its_offset_cap() {
        let clock = Clock::new(MAX_OFFSET_MS);
        assert_eq!(clock.advance(1), Err(Refused::TooFarAhead));
        assert_eq!(clock.offset_ms(), MAX_OFFSET_MS);
    }

    #[test]
    fn stamps_utc_to_the_millisecond() {
        let stamp = Clock::new(0).stamp();
        assert_eq!(stamp.len(), "2026-11-07T01:39:37.000Z".len());
        assert!(stamp.ends_with('Z'));
    }

    #[test]
    fn reads_only_the_form_it_writes() {
        let at = Stamp::from_ms(1_762_672_580_123).unwrap();
        assert_eq!(at.text(), "2025-11-09T07:16:20.123Z");
        assert_eq!(Stamp::read(&at.text()).unwrap(), at);
        for stored in [
            "",
            "soon",
            "1762672580",
            "2025-11-09T07:16:20Z",
            "2025-11-09T07:16:20.1Z",
            "2025-11-09T07:16:20.123+00:00",
            "2025-11-09t07:16:20.123z",
            "2025-11-09T07:16:20.1234Z",
            "2025-11-09 07:16:20.123Z",
        ] {
            assert!(Stamp::read(stored).is_err(), "{stored}");
        }
    }

    #[test]
    fn reports_every_row_in_scope_whose_time_does_not_read_whichever_way_it_sorts() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE t (at, kind)").unwrap();
        let rows: [(rusqlite::types::Value, &str); 8] = [
            ("2025-01-01T00:00:00.000Z".to_string().into(), "x"),
            ("2027-01-01T00:00:00.000Z".to_string().into(), "x"),
            ("0".to_string().into(), "x"),
            ("0".to_string().into(), "y"),
            ("z".to_string().into(), "x"),
            ("2025-01-01T00:00:00Z".to_string().into(), "x"),
            (5_i64.into(), "x"),
            (rusqlite::types::Value::Null, "x"),
        ];
        for (at, kind) in rows {
            db.execute("INSERT INTO t VALUES (?1, ?2)", rusqlite::params![at, kind])
                .unwrap();
        }
        let kept = Unread {
            table: "t",
            time: "at",
            scope: "kind = ?1",
        };
        assert_eq!(kept.report(&db, "a-job", ["x"]).unwrap(), 4);
    }

    #[test]
    fn its_sql_test_agrees_with_reading() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE t (at)").unwrap();
        let held: Vec<rusqlite::types::Value> = [
            "2025-11-09T07:16:20.123Z",
            "0000-01-01T00:00:00.000Z",
            "9999-12-31T23:59:59.999Z",
            "2024-02-29T00:00:00.000Z",
            "",
            "0",
            "z",
            "soon",
            "1762672580",
            "2025-11-09T07:16:20Z",
            "2025-11-09T07:16:20.1Z",
            "2025-11-09T07:16:20.123+00:00",
            "2025-11-09t07:16:20.123z",
            "2025-11-09T07:16:20.1234Z",
            "2025-11-09 07:16:20.123Z",
            " 2025-11-09T07:16:20.123Z",
            "2025-11-09T07:16:20.123Z ",
            "2025-02-29T00:00:00.000Z",
            "2025-13-01T00:00:00.000Z",
            "2025-11-31T00:00:00.000Z",
            "2025-11-09T24:00:00.000Z",
            "2025-11-09T24:59:59.999Z",
            "2025-11-09T25:00:00.000Z",
            "2025-11-09T23:59:59.999Z",
            "2025-11-09T23:60:00.000Z",
            "2025-11-09T23:59:60.000Z",
        ]
        .map(|text| rusqlite::types::Value::Text(text.into()))
        .into_iter()
        .chain([
            rusqlite::types::Value::Integer(1_762_672_580_123),
            rusqlite::types::Value::Real(2_461_000.5),
            rusqlite::types::Value::Null,
        ])
        .collect();
        for value in &held {
            db.execute("DELETE FROM t", []).unwrap();
            db.execute("INSERT INTO t VALUES (?1)", [value]).unwrap();
            let passes = |test: String| -> bool {
                db.query_row(
                    &format!("SELECT EXISTS (SELECT 1 FROM t WHERE {test})"),
                    [],
                    |row| row.get(0),
                )
                .unwrap()
            };
            let reads = match value {
                rusqlite::types::Value::Text(text) => Stamp::parsed(text).is_some(),
                _ => false,
            };
            assert_eq!(passes(readable("at")), reads, "{value:?}");
            assert_eq!(
                passes(format!("NOT {}", readable("at"))),
                !reads,
                "{value:?}"
            );
        }
    }

    #[test]
    fn holds_the_years_0000_to_9999_and_refuses_the_rest() {
        assert_eq!(
            Stamp::from_ms(FIRST_MS).unwrap().text(),
            "0000-01-01T00:00:00.000Z"
        );
        assert_eq!(
            Stamp::from_ms(LAST_MS).unwrap().text(),
            "9999-12-31T23:59:59.999Z"
        );
        assert!(Stamp::from_ms(FIRST_MS - 1).is_err());
        assert!(Stamp::from_ms(LAST_MS + 1).is_err());
        assert!(Stamp::from_ms(LAST_MS).unwrap().plus_ms(1).is_err());
        let first = Stamp::from_ms(FIRST_MS + 1).unwrap();
        assert_eq!(first.earlier_by(1).map(Stamp::ms), Some(FIRST_MS));
        assert_eq!(first.earlier_by(2), None);
    }

    #[test]
    fn sorts_as_text_in_the_order_of_its_instants() {
        let times = [FIRST_MS, -1, 0, 1, 999, 1_000, 1_762_672_580_123, LAST_MS];
        let texts: Vec<String> = times
            .iter()
            .map(|ms| Stamp::from_ms(*ms).unwrap().text())
            .collect();
        let mut sorted = texts.clone();
        sorted.sort();
        assert_eq!(texts, sorted);
    }
}

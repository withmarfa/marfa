//! Password hashes, made and checked off the writer thread and few at a time,
//! since each one takes real memory and time.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use argon2::Argon2;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use tokio::sync::{OnceCell, OwnedSemaphorePermit, Semaphore};

use super::limits::too_many_passwords;
use crate::app::refusal::{Refusal, Result};

const AT_ONCE: usize = 2;
const OPEN_AT_ONCE: usize = 1;
const OPEN_PLACES: usize = 8;
const OPEN_WAIT_MS: i64 = 1_000;
pub const MIN_LENGTH: usize = 8;
pub const MAX_LENGTH: usize = 128;

/// `field` names where the password came in, in the refusal.
pub fn check_new(password: &str, field: &str) -> Result<()> {
    let length = password.chars().count();
    let message = if length < MIN_LENGTH {
        format!("Password must be at least {MIN_LENGTH} characters.")
    } else if length > MAX_LENGTH {
        format!("Password must be at most {MAX_LENGTH} characters.")
    } else {
        return Ok(());
    };
    Err(Refusal::invalid_at(field, &message))
}

fn shape(hash: &str) -> &str {
    hash.rsplitn(3, '$').last().unwrap_or(hash)
}

fn hashed(password: &str) -> Result<String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|_| Refusal::internal("a password could not be hashed"))
}

fn verified(password: &str, hash: &str) -> bool {
    Argon2::default()
        .verify_password(password.as_bytes(), hash)
        .is_ok()
}

/// The owner's checks do not queue behind anonymous checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Queue {
    Owner,
    Open,
}

/// Where a password waits for its turn.
#[derive(Clone, Copy, Debug)]
pub enum Turn<'a> {
    /// Checked, in this queue.
    Check(Queue),
    /// Not checked: holds a place and a turn as a check does, in the open queue, or with an
    /// username, in that username's own queue shaped like it.
    StandIn(Option<&'a str>),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Checked {
    Wrong,
    Right,
    RightButDated,
}

/// How long a turn may take before it is due to end, from the checks seen lately: the longest
/// of the last `RECENT` plus a quarter, at least `FLOOR`, rounded up to a whole millisecond.
const RECENT: usize = 32;
const FLOOR: Duration = Duration::from_millis(10);

type TurnEnds = Arc<Mutex<Option<Instant>>>;

/// A queue of password turns.
struct Line {
    lane: Arc<Semaphore>,
    places: Option<Arc<Semaphore>>,
    /// When the last turn ended, in a line that takes one at a time.
    turn_ends: Option<TurnEnds>,
}

impl Line {
    fn owner() -> Line {
        Line {
            lane: Arc::new(Semaphore::new(AT_ONCE)),
            places: None,
            turn_ends: None,
        }
    }

    fn open() -> Line {
        Line {
            lane: Arc::new(Semaphore::new(OPEN_AT_ONCE)),
            places: Some(Arc::new(Semaphore::new(OPEN_PLACES))),
            turn_ends: Some(TurnEnds::default()),
        }
    }

    fn place(&self) -> Result<Option<OwnedSemaphorePermit>> {
        let Some(places) = &self.places else {
            return Ok(None);
        };
        let place = places.clone().try_acquire_owned();
        place
            .map(Some)
            .map_err(|_| too_many_passwords(OPEN_WAIT_MS))
    }

    /// A turn, and when it is due to end. One that waited starts where the turn before it ended,
    /// so a late wake-up is not carried down the queue.
    async fn turn(&self, budget: Duration) -> Result<(OwnedSemaphorePermit, Instant)> {
        let (turn, waited) = match self.lane.clone().try_acquire_owned() {
            Ok(turn) => (turn, false),
            Err(_) => {
                let turn = self.lane.clone().acquire_owned().await;
                let turn =
                    turn.map_err(|_| Refusal::internal("the password checks have stopped"))?;
                (turn, true)
            }
        };
        let now = Instant::now();
        let ended = self
            .turn_ends
            .as_ref()
            .and_then(|ends| *ends.lock().unwrap_or_else(PoisonError::into_inner));
        let starts = match ended {
            Some(ended) if waited => ended.min(now),
            _ => now,
        };
        Ok((turn, starts.checked_add(budget).unwrap_or(starts)))
    }

    /// Runs `work` in a turn and answers at `due`, or when `work` ends if that is later. The turn
    /// and what `held` holds are kept until then even if the caller goes.
    async fn answer<T, H, W>(&self, held: H, due: Instant, work: W) -> Result<T>
    where
        T: Send + 'static,
        H: Send + 'static,
        W: Future<Output = Result<T>> + Send + 'static,
    {
        let turn_ends = self.turn_ends.clone();
        tokio::spawn(async move {
            let done = work.await;
            let ends = due.max(Instant::now());
            if let Some(turn_ends) = &turn_ends {
                *turn_ends.lock().unwrap_or_else(PoisonError::into_inner) = Some(ends);
            }
            tokio::time::sleep_until(ends.into()).await;
            drop(held);
            done
        })
        .await
        .map_err(|_| Refusal::internal("a password check did not finish"))?
    }
}

/// Each username's stand-in line, with how many attempts hold it.
type StandIns = Arc<Mutex<HashMap<String, (Arc<Line>, usize)>>>;

/// A hold on one username's stand-in line; the last one out removes it.
struct StandIn {
    stand_ins: StandIns,
    key: String,
    line: Arc<Line>,
}

impl StandIn {
    fn take(stand_ins: &StandIns, key: &str) -> StandIn {
        let mut held = stand_ins.lock().unwrap_or_else(PoisonError::into_inner);
        let (line, holders) = held
            .entry(key.to_string())
            .or_insert_with(|| (Arc::new(Line::open()), 0));
        *holders += 1;
        StandIn {
            stand_ins: stand_ins.clone(),
            key: key.to_string(),
            line: line.clone(),
        }
    }
}

impl Drop for StandIn {
    fn drop(&mut self) {
        let mut held = self
            .stand_ins
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some((_, holders)) = held.get_mut(&self.key) {
            *holders = holders.saturating_sub(1);
            if *holders == 0 {
                held.remove(&self.key);
            }
        }
    }
}

pub struct Passwords {
    owner: Arc<Line>,
    open: Arc<Line>,
    stand_ins: StandIns,
    decoy: OnceCell<String>,
    recent: Mutex<VecDeque<Duration>>,
    #[cfg(test)]
    checks: AtomicU64,
}

impl Default for Passwords {
    fn default() -> Passwords {
        Passwords {
            owner: Arc::new(Line::owner()),
            open: Arc::new(Line::open()),
            stand_ins: StandIns::default(),
            decoy: OnceCell::new(),
            recent: Mutex::new(VecDeque::with_capacity(RECENT)),
            #[cfg(test)]
            checks: AtomicU64::new(0),
        }
    }
}

impl Passwords {
    /// Runs `job` with a turn in `lane`, and gives how long it held the turn.
    async fn off_thread<T, F>(&self, lane: &Arc<Semaphore>, job: F) -> Result<(T, Duration)>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T> + Send + 'static,
    {
        let permit = lane
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| Refusal::internal("the password checks have stopped"))?;
        let turned = Instant::now();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            job().map(|done| (done, turned.elapsed()))
        })
        .await
        .map_err(|_| Refusal::internal("a password check did not finish"))?
    }

    pub async fn hash(&self, password: String) -> Result<String> {
        let (hash, _) = self
            .off_thread(&self.owner.lane, move || hashed(&password))
            .await?;
        Ok(hash)
    }

    async fn decoy(&self) -> Result<&str> {
        let decoy = self
            .decoy
            .get_or_try_init(|| async {
                let mut bytes = [0u8; 32];
                getrandom::fill(&mut bytes)
                    .map_err(|_| Refusal::internal("no randomness was available"))?;
                let password = hex::encode(bytes);
                let (hash, took) = self
                    .off_thread(&self.owner.lane, move || hashed(&password))
                    .await?;
                self.note_check(took);
                Ok::<_, Refusal>(hash)
            })
            .await?;
        Ok(decoy)
    }

    fn note_check(&self, took: Duration) {
        let mut recent = self.recent.lock().unwrap_or_else(PoisonError::into_inner);
        if recent.len() == RECENT {
            recent.pop_front();
        }
        recent.push_back(took);
    }

    fn budget(&self) -> Duration {
        let recent = self.recent.lock().unwrap_or_else(PoisonError::into_inner);
        let longest = recent.iter().max().copied().unwrap_or_default();
        let budget = longest.saturating_add(longest / 4).max(FLOOR);
        let ms = u64::try_from(budget.as_micros().div_ceil(1_000)).unwrap_or(u64::MAX);
        Duration::from_millis(ms)
    }

    /// Holds a place and a turn in the line `at` names, and answers when a check would.
    pub async fn wait_as_a_check(&self, at: Option<&str>) -> Result<()> {
        self.decoy().await?;
        let stand_in = at.map(|key| StandIn::take(&self.stand_ins, key));
        let line = stand_in
            .as_ref()
            .map_or_else(|| self.open.clone(), |held| held.line.clone());
        let place = line.place()?;
        let (turn, due) = line.turn(self.budget()).await?;
        line.answer((stand_in, place, turn), due, async { Ok(()) })
            .await
    }

    #[cfg(test)]
    pub fn open_places_left(&self) -> usize {
        self.open
            .places
            .as_ref()
            .map_or(0, |places| places.available_permits())
    }

    #[cfg(test)]
    pub async fn hold_the_open_lane(&self) -> OwnedSemaphorePermit {
        self.open.lane.clone().acquire_owned().await.unwrap()
    }

    #[cfg(test)]
    pub fn stand_ins_held(&self) -> usize {
        self.stand_ins.lock().unwrap().len()
    }

    #[cfg(test)]
    pub fn checks_made(&self) -> u64 {
        self.checks.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    pub fn turn_budget(&self) -> Duration {
        self.budget()
    }

    /// Missing hashes still require a password check to hide account existence.
    pub async fn check(
        &self,
        stored: Option<&str>,
        password: String,
        queue: Queue,
    ) -> Result<Checked> {
        let today = self.decoy().await?.to_string();
        let line = match queue {
            Queue::Owner => self.owner.clone(),
            Queue::Open => self.open.clone(),
        };
        let dated = stored.is_some_and(|stored| shape(stored) != shape(&today));
        let against = stored.map_or(today, str::to_string);
        let held = stored.is_some();
        let place = line.place()?;
        let (turn, due) = line.turn(self.budget()).await?;
        let turned = Instant::now();
        let work = async move {
            tokio::task::spawn_blocking(move || (verified(&password, &against), turned.elapsed()))
                .await
                .map_err(|_| Refusal::internal("a password check did not finish"))
        };
        let (matched, took) = line.answer((place, turn), due, work).await?;
        self.note_check(took);
        #[cfg(test)]
        self.checks.fetch_add(1, Ordering::Relaxed);
        Ok(match (held && matched, dated) {
            (false, _) => Checked::Wrong,
            (true, false) => Checked::Right,
            (true, true) => Checked::RightButDated,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;
    use crate::app::refusal::Code;

    #[tokio::test]
    async fn a_dropped_request_keeps_its_place_until_its_job_ends() {
        let passwords = Passwords::default();
        let running = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        for _ in 0..4 * AT_ONCE {
            let (running, most) = (running.clone(), most.clone());
            let job = passwords.off_thread(&passwords.owner.lane, move || {
                most.fetch_max(running.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(300));
                running.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            });
            assert!(
                tokio::time::timeout(Duration::from_millis(10), job)
                    .await
                    .is_err()
            );
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(most.load(Ordering::SeqCst), AT_ONCE);
    }

    #[tokio::test]
    async fn the_open_queue_refuses_any_username_alike_and_never_holds_up_the_owner() {
        let passwords = Arc::new(Passwords::default());
        let hash = passwords.hash("a good long password".into()).await.unwrap();
        let _lane = passwords
            .open
            .lane
            .clone()
            .acquire_many_owned(OPEN_AT_ONCE as u32)
            .await
            .unwrap();
        let mut waiting = tokio::task::JoinSet::new();
        for _ in 0..OPEN_PLACES {
            let passwords = passwords.clone();
            waiting
                .spawn(async move { passwords.check(None, "a guess".into(), Queue::Open).await });
        }
        let filled = async {
            while passwords.open_places_left() > 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        };
        tokio::time::timeout(Duration::from_secs(20), filled)
            .await
            .unwrap();
        for stored in [None, Some(hash.as_str())] {
            let refused = passwords
                .check(stored, "a guess".into(), Queue::Open)
                .await
                .unwrap_err();
            assert_eq!(refused.code, Code::RateLimited);
            assert_eq!(refused.details.unwrap()["retry_after_seconds"], 1);
        }
        let owner = passwords.check(Some(&hash), "a good long password".into(), Queue::Owner);
        let checked = tokio::time::timeout(Duration::from_secs(20), owner).await;
        assert_eq!(checked.unwrap().unwrap(), Checked::Right);
    }

    #[tokio::test]
    async fn a_check_and_a_stand_in_both_answer_once_their_turn_is_due() {
        let passwords = Passwords::default();
        for _ in 0..4 {
            passwords
                .check(None, "a guess".into(), Queue::Open)
                .await
                .unwrap();
        }
        for at in [None, Some("someone")] {
            let budget = passwords.budget();
            assert_eq!(budget.subsec_micros() % 1_000, 0);
            let started = Instant::now();
            passwords
                .check(None, "a guess".into(), Queue::Open)
                .await
                .unwrap();
            let checked = started.elapsed();
            let budget_now = passwords.budget();
            let started = Instant::now();
            passwords.wait_as_a_check(at).await.unwrap();
            let stood_in = started.elapsed();
            assert!(checked >= budget, "{checked:?} {budget:?}");
            assert!(stood_in >= budget_now, "{stood_in:?} {budget_now:?}");
        }
        assert_eq!(passwords.stand_ins_held(), 0);
    }

    #[tokio::test]
    async fn a_hash_under_older_settings_is_right_and_dated() {
        use argon2::{Algorithm, Params, Version};
        let passwords = Passwords::default();
        let older = Argon2::new(
            Algorithm::Argon2id,
            Version::V0x13,
            Params::new(8192, 2, 1, None).unwrap(),
        )
        .hash_password(b"a good long password")
        .unwrap()
        .to_string();
        let today = passwords.hash("a good long password".into()).await.unwrap();
        let check = |stored: Option<String>, password: &str| {
            let password = password.to_string();
            let passwords = &passwords;
            async move {
                let stored = stored.as_deref();
                let open = passwords.check(stored, password.clone(), Queue::Open);
                let owner = passwords.check(stored, password, Queue::Owner);
                let (open, owner) = (open.await.unwrap(), owner.await.unwrap());
                assert_eq!(open, owner);
                owner
            }
        };
        let right = "a good long password";
        assert_eq!(check(Some(today.clone()), right).await, Checked::Right);
        assert_eq!(
            check(Some(older.clone()), right).await,
            Checked::RightButDated
        );
        assert_eq!(check(Some(today), "not it").await, Checked::Wrong);
        assert_eq!(check(Some(older), "not it").await, Checked::Wrong);
        assert_eq!(check(None, right).await, Checked::Wrong);
    }

    #[test]
    fn a_new_password_is_measured_in_characters() {
        assert!(check_new("1234567", "password").is_err());
        assert!(check_new("12345678", "password").is_ok());
        assert!(check_new(&"x".repeat(128), "password").is_ok());
        assert!(check_new(&"x".repeat(129), "password").is_err());
        assert!(check_new(&"😀".repeat(7), "password").is_err());
        assert!(check_new(&"😀".repeat(8), "password").is_ok());
        assert!(check_new(&"😀".repeat(128), "password").is_ok());
        assert!(check_new(&"😀".repeat(129), "password").is_err());
    }

    #[test]
    fn a_refused_new_password_names_its_field() {
        let refused = check_new("short", "new_password").unwrap_err();
        assert_eq!(
            refused.details.unwrap()["errors"][0]["path"],
            "new_password"
        );
    }
}

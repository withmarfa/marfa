//! Password hashes, made and checked off the writer thread and few at a time,
//! since each one takes real memory and time.

use std::collections::HashMap;
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
const MIN_LENGTH: usize = 8;
const MAX_LENGTH: usize = 128;

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
    /// Not checked: holds a place as long as a check takes, in the open queue, or with an
    /// email, in that email's own queue shaped like it.
    StandIn(Option<&'a str>),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Checked {
    Wrong,
    Right,
    RightButDated,
}

/// A queue shaped like the open queue: `OPEN_AT_ONCE` at a time, `OPEN_PLACES` places.
struct OpenShaped {
    lane: Arc<Semaphore>,
    places: Arc<Semaphore>,
    /// When the last turn ended or is due to.
    turn_ends: Arc<Mutex<Option<Instant>>>,
}

impl Default for OpenShaped {
    fn default() -> OpenShaped {
        OpenShaped {
            lane: Arc::new(Semaphore::new(OPEN_AT_ONCE)),
            places: Arc::new(Semaphore::new(OPEN_PLACES)),
            turn_ends: Arc::default(),
        }
    }
}

fn mark_turn_end(turn_ends: &Mutex<Option<Instant>>, at: Instant) {
    *turn_ends.lock().unwrap_or_else(PoisonError::into_inner) = Some(at);
}

impl OpenShaped {
    fn place(&self) -> Result<OwnedSemaphorePermit> {
        self.places
            .clone()
            .try_acquire_owned()
            .map_err(|_| too_many_passwords(OPEN_WAIT_MS))
    }

    /// A turn that stands in for a check of `lasts`, and when it ends. One that waited starts
    /// where the turn before it ended, so a late wake-up is not carried down the queue.
    async fn stand_in_turn(&self, lasts: Duration) -> Result<(OwnedSemaphorePermit, Instant)> {
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
        let mut turn_ends = self
            .turn_ends
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let starts = match *turn_ends {
            Some(ended) if waited => ended.min(now),
            _ => now,
        };
        let ends = starts.checked_add(lasts).unwrap_or(starts);
        *turn_ends = Some(ends);
        Ok((turn, ends))
    }
}

/// Each email's stand-in queue, with how many attempts hold it.
type StandIns = Arc<Mutex<HashMap<String, (Arc<OpenShaped>, usize)>>>;

/// A hold on one email's stand-in queue; the last one out removes it.
struct StandIn {
    stand_ins: StandIns,
    key: String,
    queue: Arc<OpenShaped>,
}

impl StandIn {
    fn take(stand_ins: &StandIns, key: &str) -> StandIn {
        let mut held = stand_ins.lock().unwrap_or_else(PoisonError::into_inner);
        let (queue, holders) = held.entry(key.to_string()).or_default();
        *holders += 1;
        StandIn {
            stand_ins: stand_ins.clone(),
            key: key.to_string(),
            queue: queue.clone(),
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
    owner: Arc<Semaphore>,
    open: OpenShaped,
    stand_ins: StandIns,
    decoy: OnceCell<String>,
    check_us: AtomicU64,
    #[cfg(test)]
    checks: AtomicU64,
}

impl Default for Passwords {
    fn default() -> Passwords {
        Passwords {
            owner: Arc::new(Semaphore::new(AT_ONCE)),
            open: OpenShaped::default(),
            stand_ins: StandIns::default(),
            decoy: OnceCell::new(),
            check_us: AtomicU64::new(0),
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
            .off_thread(&self.owner, move || hashed(&password))
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
                    .off_thread(&self.owner, move || hashed(&password))
                    .await?;
                self.note_check(took);
                Ok::<_, Refusal>(hash)
            })
            .await?;
        Ok(decoy)
    }

    fn note_check(&self, took: Duration) {
        let us = u64::try_from(took.as_micros()).unwrap_or(u64::MAX);
        let _ = self
            .check_us
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |held| {
                Some(match held {
                    0 => us,
                    held => held.saturating_mul(3).saturating_add(us) / 4,
                })
            });
    }

    /// Holds a place and a turn in the queue `at` names about as long as a check takes, and
    /// keeps them until then even if the caller goes, as a check does.
    pub async fn wait_as_a_check(&self, at: Option<&str>) -> Result<()> {
        self.decoy().await?;
        let stand_in = at.map(|key| StandIn::take(&self.stand_ins, key));
        let queue = stand_in.as_ref().map_or(&self.open, |held| &held.queue);
        let place = queue.place()?;
        let lasts = Duration::from_micros(self.check_us.load(Ordering::Relaxed));
        let (turn, ends) = queue.stand_in_turn(lasts).await?;
        tokio::spawn(async move {
            let _held = (stand_in, place, turn);
            tokio::time::sleep_until(ends.into()).await;
        })
        .await
        .map_err(|_| Refusal::internal("a password check did not finish"))
    }

    #[cfg(test)]
    pub fn open_places_left(&self) -> usize {
        self.open.places.available_permits()
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
    pub fn check_us(&self) -> u64 {
        self.check_us.load(Ordering::Relaxed)
    }

    /// Missing hashes still require a password check to hide account existence.
    pub async fn check(
        &self,
        stored: Option<&str>,
        password: String,
        queue: Queue,
    ) -> Result<Checked> {
        let today = self.decoy().await?.to_string();
        let (place, lane, turn_ends) = match queue {
            Queue::Owner => (None, &self.owner, None),
            Queue::Open => (
                Some(self.open.place()?),
                &self.open.lane,
                Some(self.open.turn_ends.clone()),
            ),
        };
        let dated = stored.is_some_and(|stored| shape(stored) != shape(&today));
        let against = stored.map_or(today, str::to_string);
        let held = stored.is_some();
        let (matched, took) = self
            .off_thread(lane, move || {
                let _place = place;
                let matched = verified(&password, &against);
                if let Some(turn_ends) = turn_ends {
                    mark_turn_end(&turn_ends, Instant::now());
                }
                Ok(matched)
            })
            .await?;
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
            let job = passwords.off_thread(&passwords.owner, move || {
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
    async fn the_open_queue_refuses_any_email_alike_and_never_holds_up_the_owner() {
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
            while passwords.open.places.available_permits() > 0 {
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

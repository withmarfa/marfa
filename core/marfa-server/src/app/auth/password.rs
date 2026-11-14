//! Password hashes, made and checked off the writer thread and few at a time,
//! since each one takes real memory and time.

use std::sync::Arc;

use argon2::Argon2;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use tokio::sync::{OnceCell, Semaphore};

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

#[derive(Debug, PartialEq, Eq)]
pub enum Checked {
    Wrong,
    Right,
    RightButDated,
}

pub struct Passwords {
    owner: Arc<Semaphore>,
    open: Arc<Semaphore>,
    open_places: Arc<Semaphore>,
    decoy: OnceCell<String>,
}

impl Default for Passwords {
    fn default() -> Passwords {
        Passwords {
            owner: Arc::new(Semaphore::new(AT_ONCE)),
            open: Arc::new(Semaphore::new(OPEN_AT_ONCE)),
            open_places: Arc::new(Semaphore::new(OPEN_PLACES)),
            decoy: OnceCell::new(),
        }
    }
}

impl Passwords {
    async fn off_thread<T, F>(&self, lane: &Arc<Semaphore>, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T> + Send + 'static,
    {
        let permit = lane
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| Refusal::internal("the password checks have stopped"))?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            job()
        })
        .await
        .map_err(|_| Refusal::internal("a password check did not finish"))?
    }

    pub async fn hash(&self, password: String) -> Result<String> {
        self.off_thread(&self.owner, move || hashed(&password))
            .await
    }

    async fn decoy(&self) -> Result<&str> {
        let decoy = self
            .decoy
            .get_or_try_init(|| async {
                let mut bytes = [0u8; 32];
                getrandom::fill(&mut bytes)
                    .map_err(|_| Refusal::internal("no randomness was available"))?;
                self.hash(hex::encode(bytes)).await
            })
            .await?;
        Ok(decoy)
    }

    /// Missing hashes still require a password check to hide account existence.
    pub async fn check(
        &self,
        stored: Option<&str>,
        password: String,
        queue: Queue,
    ) -> Result<Checked> {
        let today = self.decoy().await?.to_string();
        let (place, lane) = match queue {
            Queue::Owner => (None, &self.owner),
            Queue::Open => {
                let place = self
                    .open_places
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| too_many_passwords(OPEN_WAIT_MS))?;
                (Some(place), &self.open)
            }
        };
        let dated = stored.is_some_and(|stored| shape(stored) != shape(&today));
        let against = stored.map_or(today, str::to_string);
        let held = stored.is_some();
        let matched = self
            .off_thread(lane, move || {
                let _place = place;
                Ok(verified(&password, &against))
            })
            .await?;
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
            while passwords.open_places.available_permits() > 0 {
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
            assert_eq!(refused.details.unwrap()["retry_after"], 1);
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

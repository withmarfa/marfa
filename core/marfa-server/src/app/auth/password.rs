//! Password hashes, made and checked off the writer thread and few at a time,
//! since each one takes real memory and time.

use std::sync::Arc;

use argon2::Argon2;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use serde_json::json;
use tokio::sync::{OnceCell, Semaphore};

use super::limits::too_many_passwords;
use crate::app::refusal::{Refusal, Result};

const AT_ONCE: usize = 2;
const DECOYS_AT_ONCE: usize = 1;
const DECOY_PLACES: usize = 8;
const DECOY_WAIT_MS: i64 = 1_000;
const MIN_UNITS: usize = 8;
const MAX_UNITS: usize = 128;

pub fn check_new(password: &str) -> Result<()> {
    let units = password.encode_utf16().count();
    let message = if units < MIN_UNITS {
        format!("Password must be at least {MIN_UNITS} characters.")
    } else if units > MAX_UNITS {
        format!("Password must be at most {MAX_UNITS} characters.")
    } else {
        return Ok(());
    };
    Err(Refusal::validation(message.clone()).with_detail(
        "errors",
        json!([{ "path": "password", "message": message }]),
    ))
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

#[derive(Debug, PartialEq, Eq)]
pub enum Checked {
    Wrong,
    Right,
    RightButDated,
}

pub struct Passwords {
    owner: Arc<Semaphore>,
    decoys: Arc<Semaphore>,
    decoy_places: Arc<Semaphore>,
    decoy: OnceCell<String>,
}

impl Default for Passwords {
    fn default() -> Passwords {
        Passwords {
            owner: Arc::new(Semaphore::new(AT_ONCE)),
            decoys: Arc::new(Semaphore::new(DECOYS_AT_ONCE)),
            decoy_places: Arc::new(Semaphore::new(DECOY_PLACES)),
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

    /// Does the same work when there is nothing stored. That work runs in a lane of its own,
    /// which refuses once full, so no email but the owner's can hold up the owner.
    pub async fn check(&self, stored: Option<&str>, password: String) -> Result<Checked> {
        let today = self.decoy().await?.to_string();
        let Some(stored) = stored else {
            let place = self
                .decoy_places
                .clone()
                .try_acquire_owned()
                .map_err(|_| too_many_passwords(DECOY_WAIT_MS))?;
            self.off_thread(&self.decoys, move || {
                let _place = place;
                Ok(verified(&password, &today))
            })
            .await?;
            return Ok(Checked::Wrong);
        };
        let against = stored.to_string();
        let dated = shape(&against) != shape(&today);
        let matched = self
            .off_thread(&self.owner, move || Ok(verified(&password, &against)))
            .await?;
        Ok(match (matched, dated) {
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
    async fn decoys_queue_only_so_far_and_never_ahead_of_the_owner() {
        let passwords = Arc::new(Passwords::default());
        let hash = passwords.hash("a good long password".into()).await.unwrap();
        let _lane = passwords
            .decoys
            .clone()
            .acquire_many_owned(DECOYS_AT_ONCE as u32)
            .await
            .unwrap();
        let mut waiting = tokio::task::JoinSet::new();
        for _ in 0..DECOY_PLACES {
            let passwords = passwords.clone();
            waiting.spawn(async move { passwords.check(None, "a guess".into()).await });
        }
        let filled = async {
            while passwords.decoy_places.available_permits() > 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        };
        tokio::time::timeout(Duration::from_secs(20), filled)
            .await
            .unwrap();
        let refused = passwords.check(None, "a guess".into()).await.unwrap_err();
        assert_eq!(refused.code, Code::RateLimited);
        assert_eq!(refused.details.unwrap()["retry_after"], 1);
        let owner = passwords.check(Some(&hash), "a good long password".into());
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
            async move { passwords.check(stored.as_deref(), password).await.unwrap() }
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
    fn a_new_password_is_measured_in_utf16_units() {
        assert!(check_new("1234567").is_err());
        assert!(check_new("12345678").is_ok());
        assert!(check_new(&"x".repeat(128)).is_ok());
        assert!(check_new(&"x".repeat(129)).is_err());
        assert!(check_new(&"😀".repeat(65)).is_err());
    }
}

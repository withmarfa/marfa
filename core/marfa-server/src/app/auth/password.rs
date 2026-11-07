//! Password hashes, made and checked off the writer thread and few at a time,
//! since each one takes real memory and time.

use std::sync::Arc;

use argon2::Argon2;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use serde_json::json;
use tokio::sync::{OnceCell, Semaphore};

use crate::app::refusal::{Refusal, Result};

const AT_ONCE: usize = 2;
const MIN_UNITS: usize = 8;
const MAX_UNITS: usize = 128;

/// Refuses a password the owner may not choose. Length is in UTF-16 units,
/// which is what the contract counts.
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

/// The settings a hash was made with: everything before its salt.
fn shape(hash: &str) -> &str {
    hash.rsplitn(3, '$').last().unwrap_or(hash)
}

fn hashed(password: &str) -> Result<String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|_| Refusal::internal("a password could not be hashed"))
}

/// What checking a password found.
#[derive(Debug, PartialEq, Eq)]
pub enum Checked {
    Wrong,
    Right,
    /// Right, and held under settings other than today's.
    RightButDated,
}

pub struct Passwords {
    permits: Arc<Semaphore>,
    decoy: OnceCell<String>,
}

impl Default for Passwords {
    fn default() -> Passwords {
        Passwords {
            permits: Arc::new(Semaphore::new(AT_ONCE)),
            decoy: OnceCell::new(),
        }
    }
}

impl Passwords {
    async fn off_thread<T, F>(&self, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T> + Send + 'static,
    {
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| Refusal::internal("the password checks have stopped"))?;
        tokio::task::spawn_blocking(job)
            .await
            .map_err(|_| Refusal::internal("a password check did not finish"))?
    }

    pub async fn hash(&self, password: String) -> Result<String> {
        self.off_thread(move || hashed(&password)).await
    }

    /// A hash nothing matches, in today's settings, for an account that does
    /// not exist to cost what one that does costs.
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

    /// Checks `password` against `stored`, and does the same work when there
    /// is nothing stored.
    pub async fn check(&self, stored: Option<&str>, password: String) -> Result<Checked> {
        let today = self.decoy().await?.to_string();
        let known = stored.is_some();
        let against = stored.unwrap_or(&today).to_string();
        let dated = shape(&against) != shape(&today);
        let matched = self
            .off_thread(move || {
                Ok(Argon2::default()
                    .verify_password(password.as_bytes(), against.as_str())
                    .is_ok())
            })
            .await?;
        Ok(match (known && matched, dated) {
            (false, _) => Checked::Wrong,
            (true, false) => Checked::Right,
            (true, true) => Checked::RightButDated,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

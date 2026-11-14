//! A pending challenge lives sealed in the browser; the table keeps only answered ones.

use aes_gcm::aead::{Aead, Nonce, Payload};
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use rusqlite::{Transaction, params};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::app::clock::{Stamp, Unread, readable};
use crate::app::refusal::{Refusal, Result};

const KEY_LABEL: &[u8] = b"marfa passkey ceremony key";
/// A key of its own for each cookie, so random nonces never meet under one key.
const ID_BYTES: usize = 16;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
/// Above what a browser keeps for one cookie.
const MOST_COOKIE_CHARS: usize = 4096;
pub const LIFE_MS: i64 = 5 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    Add,
    Prove,
}

impl Purpose {
    const fn word(self) -> &'static [u8] {
        match self {
            Purpose::Add => b"add",
            Purpose::Prove => b"prove",
        }
    }
}

pub struct New<'a, S> {
    pub purpose: Purpose,
    pub origin: &'a str,
    pub session_id: Option<&'a str>,
    pub state: &'a S,
}

#[derive(Serialize, Deserialize)]
struct Sealed {
    expires_ms: i64,
    origin: String,
    session_id: Option<String>,
    state: Value,
}

pub struct Taken {
    pub origin: String,
    pub session_id: Option<String>,
    state: Value,
}

impl Taken {
    pub fn state<S: DeserializeOwned>(self) -> Result<S> {
        serde_json::from_value(self.state)
            .map_err(|_| Refusal::internal("a passkey challenge did not read"))
    }
}

fn mac(key: &[u8]) -> Result<Hmac<Sha256>> {
    <Hmac<Sha256>>::new_from_slice(key)
        .map_err(|_| Refusal::internal("the passkey challenge key was refused"))
}

/// What seals and opens challenge cookies, derived once from the instance's secret.
pub struct Sealer(Vec<u8>);

impl Sealer {
    pub fn derive(secret: &str) -> Result<Sealer> {
        let mut derive = mac(secret.as_bytes())?;
        derive.update(KEY_LABEL);
        Ok(Sealer(derive.finalize().into_bytes().to_vec()))
    }

    fn cipher(&self, id: &[u8]) -> Result<Aes256Gcm> {
        let mut each = mac(&self.0)?;
        each.update(id);
        Aes256Gcm::new_from_slice(&each.finalize().into_bytes())
            .map_err(|_| Refusal::internal("the passkey challenge key was refused"))
    }

    pub fn issue<S: Serialize>(&self, now: Stamp, new: New<'_, S>) -> Result<String> {
        let sealed = Sealed {
            expires_ms: now.plus_ms(LIFE_MS)?.ms(),
            origin: new.origin.to_string(),
            session_id: new.session_id.map(str::to_string),
            state: serde_json::to_value(new.state)
                .map_err(|_| Refusal::internal("a passkey challenge did not write"))?,
        };
        let plain = serde_json::to_vec(&sealed)
            .map_err(|_| Refusal::internal("a passkey challenge did not write"))?;
        let mut random = [0u8; ID_BYTES + NONCE_BYTES];
        getrandom::fill(&mut random)
            .map_err(|_| Refusal::internal("no randomness was available"))?;
        let (id, nonce) = random.split_at(ID_BYTES);
        let nonce = Nonce::<Aes256Gcm>::try_from(nonce)
            .map_err(|_| Refusal::internal("a passkey challenge did not write"))?;
        let payload = Payload {
            msg: &plain,
            aad: new.purpose.word(),
        };
        let closed = self
            .cipher(id)?
            .encrypt(&nonce, payload)
            .map_err(|_| Refusal::internal("a passkey challenge did not write"))?;
        let cookie = URL_SAFE_NO_PAD.encode([random.as_slice(), &closed].concat());
        if cookie.len() > MOST_COOKIE_CHARS {
            return Err(Refusal::internal(
                "a passkey challenge is too long for a cookie",
            ));
        }
        Ok(cookie)
    }

    /// Every failure is `None`, so a refusal never says why.
    fn open(&self, cookie: &str, purpose: Purpose) -> Option<Opened> {
        if cookie.len() > MOST_COOKIE_CHARS {
            return None;
        }
        let bytes = URL_SAFE_NO_PAD.decode(cookie).ok()?;
        if bytes.len() < ID_BYTES + NONCE_BYTES + TAG_BYTES {
            return None;
        }
        let (id, rest) = bytes.split_at(ID_BYTES);
        let (nonce, closed) = rest.split_at(NONCE_BYTES);
        let nonce = Nonce::<Aes256Gcm>::try_from(nonce).ok()?;
        let payload = Payload {
            msg: closed,
            aad: purpose.word(),
        };
        let plain = self.cipher(id).ok()?.decrypt(&nonce, payload).ok()?;
        let sealed: Sealed = serde_json::from_slice(&plain).ok()?;
        Some(Opened {
            digest: hex::encode(Sha256::digest(id)),
            expires_at: Stamp::from_ms(sealed.expires_ms).ok()?,
            taken: Taken {
                origin: sealed.origin,
                session_id: sealed.session_id,
                state: sealed.state,
            },
        })
    }

    /// `None` for a cookie not this instance's, not for `purpose`, ended or answered before.
    pub fn take(
        &self,
        tx: &Transaction<'_>,
        cookie: Option<&str>,
        purpose: Purpose,
        now: Stamp,
    ) -> Result<Option<Taken>> {
        let Some(opened) = cookie.and_then(|cookie| self.open(cookie, purpose)) else {
            return Ok(None);
        };
        if opened.expires_at <= now {
            return Ok(None);
        }
        // A row outlives its cookie by one more life, so a clock stepped back cannot revive it.
        if let Some(before) = now.earlier_by(LIFE_MS) {
            tx.execute(
                &format!(
                    "DELETE FROM passkey_challenges_answered WHERE {} AND expires_at <= ?1",
                    readable("expires_at")
                ),
                params![before],
            )?;
        }
        let recorded = tx.execute(
            "INSERT INTO passkey_challenges_answered (digest, expires_at) VALUES (?1, ?2) \
             ON CONFLICT (digest) DO NOTHING",
            params![opened.digest, opened.expires_at],
        )?;
        Ok((recorded == 1).then_some(opened.taken))
    }
}

struct Opened {
    digest: String,
    expires_at: Stamp,
    taken: Taken,
}

pub const UNREAD: Unread<'static> = Unread {
    table: "passkey_challenges_answered",
    time: "expires_at",
    scope: "1",
};

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;

    const SECRET: &str = "an instance secret for these tests only";
    const NOW: i64 = 1_800_000_000_000;

    fn sealer() -> Sealer {
        Sealer::derive(SECRET).unwrap()
    }

    fn at(ms: i64) -> Stamp {
        Stamp::from_ms(ms).unwrap()
    }

    fn issued(purpose: Purpose) -> String {
        let new = New {
            purpose,
            origin: "https://a.example",
            session_id: Some("a session"),
            state: &"state",
        };
        sealer().issue(at(NOW), new).unwrap()
    }

    fn issue_at(ms: i64) -> String {
        let new = New {
            purpose: Purpose::Prove,
            origin: "https://a.example",
            session_id: None,
            state: &"state",
        };
        sealer().issue(at(ms), new).unwrap()
    }

    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../../../db/migrations/0001_baseline.sql"))
            .unwrap();
        db
    }

    fn taken(db: &mut Connection, cookie: &str, purpose: Purpose, now: i64) -> bool {
        let tx = db.transaction().unwrap();
        let taken = sealer().take(&tx, Some(cookie), purpose, at(now)).unwrap();
        tx.commit().unwrap();
        taken.is_some()
    }

    fn answered(db: &Connection) -> i64 {
        db.query_row(
            "SELECT count(*) FROM passkey_challenges_answered",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn a_challenge_is_taken_once_until_the_millisecond_it_ends() {
        for (taken_at, stands) in [(NOW + LIFE_MS - 1, true), (NOW + LIFE_MS, false)] {
            let mut db = database();
            let cookie = issued(Purpose::Prove);
            assert_eq!(taken(&mut db, &cookie, Purpose::Prove, taken_at), stands);
            assert!(!taken(&mut db, &cookie, Purpose::Prove, taken_at));
        }
    }

    #[test]
    fn an_unanswered_challenge_stores_nothing_and_an_answer_is_kept_past_its_end() {
        let mut db = database();
        let first = issued(Purpose::Prove);
        let second = issued(Purpose::Prove);
        assert_eq!(answered(&db), 0);
        assert!(taken(&mut db, &first, Purpose::Prove, NOW));
        assert_eq!(answered(&db), 1);
        let later = issued(Purpose::Prove);
        let new = New {
            purpose: Purpose::Prove,
            origin: "https://a.example",
            session_id: None,
            state: &"state",
        };
        let fresh = sealer().issue(at(NOW + LIFE_MS), new).unwrap();
        assert!(!taken(&mut db, &second, Purpose::Prove, NOW + LIFE_MS));
        assert!(taken(&mut db, &fresh, Purpose::Prove, NOW + LIFE_MS));
        assert_eq!(
            answered(&db),
            2,
            "the first answer stays a life past its end"
        );
        assert!(!taken(&mut db, &later, Purpose::Prove, NOW + LIFE_MS));
    }

    #[test]
    fn a_cookie_opens_only_for_its_purpose_and_its_instance_and_whole() {
        let cookie = issued(Purpose::Add);
        let sealer = sealer();
        assert!(sealer.open(&cookie, Purpose::Add).is_some());
        assert!(sealer.open(&cookie, Purpose::Prove).is_none());
        let elsewhere = Sealer::derive("another instance's secret").unwrap();
        assert!(elsewhere.open(&cookie, Purpose::Add).is_none());
        assert!(
            sealer
                .open(&cookie[..cookie.len() - 1], Purpose::Add)
                .is_none()
        );
        assert!(sealer.open("", Purpose::Add).is_none());
        assert!(sealer.open("not base64!", Purpose::Add).is_none());
        let bytes = URL_SAFE_NO_PAD.decode(&cookie).unwrap();
        for at in [0, ID_BYTES, ID_BYTES + NONCE_BYTES, bytes.len() - 1] {
            let mut flipped = bytes.clone();
            flipped[at] ^= 1;
            let flipped = URL_SAFE_NO_PAD.encode(flipped);
            assert!(sealer.open(&flipped, Purpose::Add).is_none(), "{at}");
        }
        let opened = sealer.open(&cookie, Purpose::Add).unwrap();
        assert_eq!(opened.taken.session_id.as_deref(), Some("a session"));
        assert_eq!(opened.expires_at, at(NOW + LIFE_MS));
    }

    #[test]
    fn an_answered_challenge_stays_refused_when_the_clock_steps_forward_and_back() {
        let mut db = database();
        let answered_once = issued(Purpose::Prove);
        assert!(taken(&mut db, &answered_once, Purpose::Prove, NOW));
        // Forward to the cookie's end, where an answer deletes what it may.
        let forward = issue_at(NOW + LIFE_MS);
        assert!(taken(&mut db, &forward, Purpose::Prove, NOW + LIFE_MS));
        // Back to a moment the first cookie still stands.
        assert!(!taken(&mut db, &answered_once, Purpose::Prove, NOW + 1));
        // A whole life after its end, the row goes.
        let last = issue_at(NOW + 2 * LIFE_MS);
        assert!(taken(&mut db, &last, Purpose::Prove, NOW + 2 * LIFE_MS));
        assert_eq!(answered(&db), 2, "the first answer went");
    }

    #[test]
    fn an_answer_whose_end_does_not_read_is_kept_for_the_sweep_to_report() {
        for stored in ["soon", "1800000300000", "2027-01-15T08:00:00Z"] {
            let mut db = database();
            db.execute(
                "INSERT INTO passkey_challenges_answered (digest, expires_at) VALUES ('d', ?1)",
                [stored],
            )
            .unwrap();
            let cookie = issued(Purpose::Prove);
            assert!(
                taken(&mut db, &cookie, Purpose::Prove, NOW + LIFE_MS - 1),
                "{stored}"
            );
            assert_eq!(answered(&db), 2, "{stored}");
        }
    }
}

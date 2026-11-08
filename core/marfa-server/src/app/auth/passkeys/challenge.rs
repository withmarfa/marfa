//! Ceremonies under way. A browser holds a random token and the table its
//! digest, so what the library keeps of a ceremony never leaves the server.

use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::app::keys::digest_of;
use crate::app::refusal::{Refusal, Result};

const TOKEN_BYTES: usize = 32;
pub const LIFE_MS: i64 = 5 * 60 * 1000;
/// Of each purpose. The sign-in door is open to anyone, so the oldest ceremony
/// of its purpose goes first and a flood there never reaches the other's.
const MOST_UNDER_WAY: i64 = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    Add,
    Prove,
}

impl Purpose {
    const fn word(self) -> &'static str {
        match self {
            Purpose::Add => "add",
            Purpose::Prove => "prove",
        }
    }
}

/// One ceremony to record.
pub struct New<'a, S> {
    pub purpose: Purpose,
    pub origin: &'a str,
    pub session_id: Option<&'a str>,
    pub state: &'a S,
}

/// A ceremony once it has been taken from the table.
pub struct Taken {
    pub origin: String,
    pub session_id: Option<String>,
    state: String,
}

impl Taken {
    pub fn state<S: DeserializeOwned>(&self) -> Result<S> {
        serde_json::from_str(&self.state)
            .map_err(|_| Refusal::internal("a passkey challenge did not read"))
    }
}

fn new_token() -> Result<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| Refusal::internal("no randomness was available"))?;
    Ok(hex::encode(bytes))
}

fn looks_like_a_token(text: &str) -> bool {
    text.len() == TOKEN_BYTES * 2 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn make_room(tx: &Transaction<'_>, now_ms: i64, purpose: Purpose) -> Result<()> {
    tx.execute(
        "DELETE FROM auth_passkey_challenge WHERE expires_at <= ?1",
        params![now_ms],
    )?;
    tx.execute(
        "DELETE FROM auth_passkey_challenge WHERE digest IN (SELECT digest \
         FROM auth_passkey_challenge WHERE purpose = ?2 \
         ORDER BY expires_at DESC LIMIT -1 OFFSET ?1)",
        params![MOST_UNDER_WAY - 1, purpose.word()],
    )?;
    Ok(())
}

/// Records a ceremony and answers the token that can finish it.
pub fn issue<S: Serialize>(
    tx: &Transaction<'_>,
    salt: &str,
    now_ms: i64,
    new: New<'_, S>,
) -> Result<String> {
    make_room(tx, now_ms, new.purpose)?;
    let token = new_token()?;
    let state = serde_json::to_string(new.state)
        .map_err(|_| Refusal::internal("a passkey challenge did not write"))?;
    tx.execute(
        "INSERT INTO auth_passkey_challenge (digest, purpose, origin, session_id, state, \
         expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            digest_of(salt, &token)?,
            new.purpose.word(),
            new.origin,
            new.session_id,
            state,
            now_ms + LIFE_MS,
        ],
    )?;
    Ok(token)
}

/// Removes the ceremony `token` names and answers it if it was live and of
/// `purpose`. One of another purpose, or past its time, is gone all the same.
pub fn take(
    tx: &Transaction<'_>,
    salt: &str,
    token: Option<&str>,
    purpose: Purpose,
    now_ms: i64,
) -> Result<Option<Taken>> {
    let Some(token) = token.filter(|token| looks_like_a_token(token)) else {
        return Ok(None);
    };
    let found: Option<(String, i64, Taken)> = tx
        .query_row(
            "DELETE FROM auth_passkey_challenge WHERE digest = ?1 \
             RETURNING purpose, expires_at, origin, session_id, state",
            params![digest_of(salt, token)?],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    Taken {
                        origin: row.get(2)?,
                        session_id: row.get(3)?,
                        state: row.get(4)?,
                    },
                ))
            },
        )
        .optional()?;
    Ok(found.and_then(|(word, expires_at, taken)| {
        (word == purpose.word() && expires_at > now_ms).then_some(taken)
    }))
}

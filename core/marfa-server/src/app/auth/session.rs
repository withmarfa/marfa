//! Browser sessions. The cookie holds 32 random bytes and the table only
//! their digest, so a copy of the database signs no one in.

use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde_json::{Value, json};

use super::{Note, Visit, names, note, seconds_of, stamp_of};
use crate::app::access::{Caller, unauthorized};
use crate::app::keys::digest_of;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::{App, instance};
use crate::db::Write;

const TOKEN_BYTES: usize = 32;
/// A week and a minute, since a use is recorded at most once a minute.
const IDLE_SECONDS: i64 = 7 * 24 * 3600 + 60;
const USE_EVERY_SECONDS: i64 = 60;
const RECENT_SECONDS: i64 = 5 * 60;
const ENDED: &str = "auth.session.delete";
/// Bookkeeping, named so a fault can reach it. It leaves no audit entry.
const USE: Write = Write {
    action: Some("auth.session.use"),
    for_caller: false,
};

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub user_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub expires_at: i64,
    pub remembered: bool,
    pub user_agent: Option<String>,
}

impl Session {
    /// Whether it was made in the last five minutes.
    pub fn is_recent(&self, now: i64) -> bool {
        now - self.created_at <= RECENT_SECONDS
    }

    /// What a sign-in is called where it wrote something.
    pub fn name(&self) -> String {
        names::browser_name(self.user_agent.as_deref())
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "userId": self.user_id,
            "createdAt": stamp_of(self.created_at),
            "updatedAt": stamp_of(self.updated_at),
            "expiresAt": stamp_of(self.expires_at),
        })
    }
}

/// A session just made, with the one copy of its token.
#[derive(Debug)]
pub struct Opened {
    pub session: Session,
    pub token: String,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get("id")?,
        user_id: row.get("user_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        expires_at: row.get("expires_at")?,
        remembered: row.get("remembered")?,
        user_agent: row.get("user_agent")?,
    })
}

const COLUMNS: &str = "id, user_id, created_at, updated_at, expires_at, remembered, user_agent";

/// Only the owner's session counts, and only while it lasts.
fn live(tx: &Transaction<'_>, found: Option<Session>, now: i64) -> Result<Option<Session>> {
    let owner = instance::owner_id(tx)?;
    Ok(found.filter(|session| {
        session.expires_at > now && owner.as_deref() == Some(session.user_id.as_str())
    }))
}

pub fn live_by_id(tx: &Transaction<'_>, id: &str, now: i64) -> Result<Option<Session>> {
    let found = tx
        .query_row(
            &format!("SELECT {COLUMNS} FROM auth_session WHERE id = ?1"),
            [id],
            from_row,
        )
        .optional()?;
    live(tx, found, now)
}

fn live_by_digest(tx: &Transaction<'_>, digest: &str, now: i64) -> Result<Option<Session>> {
    let found = tx
        .query_row(
            &format!("SELECT {COLUMNS} FROM auth_session WHERE token = ?1"),
            [digest],
            from_row,
        )
        .optional()?;
    live(tx, found, now)
}

fn new_token() -> Result<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| Refusal::internal("no randomness was available"))?;
    Ok(hex::encode(bytes))
}

fn looks_like_a_token(text: &str) -> bool {
    text.len() == TOKEN_BYTES * 2 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) struct New<'a> {
    pub salt: &'a str,
    pub user_id: &'a str,
    pub remembered: bool,
    pub visit: &'a Visit,
}

pub(super) fn open(tx: &Transaction<'_>, now: i64, new: New<'_>) -> Result<Opened> {
    let token = new_token()?;
    let session = Session {
        id: uuid::Uuid::now_v7().to_string(),
        user_id: new.user_id.to_string(),
        created_at: now,
        updated_at: now,
        expires_at: now + IDLE_SECONDS,
        remembered: new.remembered,
        user_agent: new.visit.user_agent.clone(),
    };
    tx.execute(
        "INSERT INTO auth_session (id, token, user_id, created_at, updated_at, expires_at, \
         remembered, user_agent, ip_address) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8)",
        params![
            session.id,
            digest_of(new.salt, &token)?,
            session.user_id,
            now,
            session.expires_at,
            session.remembered,
            session.user_agent,
            new.visit.client_ip(),
        ],
    )?;
    Ok(Opened { session, token })
}

/// A session a request came in on, and whether this request recorded its use.
#[derive(Debug)]
pub struct Seen {
    pub session: Session,
    pub recorded: bool,
}

/// What a use of `id` found once it held the writer: nothing if the session
/// ended meanwhile.
fn record_use(tx: &Transaction<'_>, id: &str, now: i64) -> Result<Option<Seen>> {
    let Some(mut session) = live_by_id(tx, id, now)? else {
        return Ok(None);
    };
    if now - session.updated_at < USE_EVERY_SECONDS {
        return Ok(Some(Seen {
            session,
            recorded: false,
        }));
    }
    session.updated_at = now;
    session.expires_at = now + IDLE_SECONDS;
    tx.execute(
        "UPDATE auth_session SET updated_at = ?2, expires_at = ?3 WHERE id = ?1",
        params![id, session.updated_at, session.expires_at],
    )?;
    Ok(Some(Seen {
        session,
        recorded: true,
    }))
}

/// Storage that is full, read-only or held by another writer costs a session
/// its renewal and nothing else.
fn leaves_use_unwritten(refusal: &Refusal) -> bool {
    matches!(
        refusal.code,
        Code::WriteContention | Code::InsufficientStorage
    ) || refusal.cause == Some("SQLITE_READONLY")
}

/// The live session a cookie's token names.
pub async fn find(app: &App, token: &str) -> Result<Option<Session>> {
    if !looks_like_a_token(token) {
        return Ok(None);
    }
    let digest = digest_of(&app.settings.start.api_key_salt, token)?;
    let now = app.clock.now_ms() / 1000;
    app.db
        .read(move |tx| live_by_digest(tx, &digest, now))
        .await
}

/// Records a use of `session` if the last is a minute old. Nothing comes back
/// if it ended meanwhile.
pub async fn seen(app: &App, session: Session) -> Result<Option<Seen>> {
    let now = app.clock.now_ms() / 1000;
    if now - session.updated_at < USE_EVERY_SECONDS {
        return Ok(Some(Seen {
            session,
            recorded: false,
        }));
    }
    let id = session.id.clone();
    let clock = app.clock.clone();
    match app
        .db
        .write(USE, move |tx| record_use(tx, &id, clock.now_ms() / 1000))
        .await
    {
        Err(refusal) if leaves_use_unwritten(&refusal) => Ok(Some(Seen {
            session,
            recorded: false,
        })),
        outcome => outcome,
    }
}

fn ended(
    tx: &Transaction<'_>,
    at: &str,
    actor: &Caller,
    visit: &Visit,
    session_id: &str,
    user_id: &str,
    replaced: bool,
) -> Result<()> {
    tx.execute("DELETE FROM auth_session WHERE id = ?1", [session_id])?;
    let mut details = json!({ "operation": "delete", "user_id": user_id });
    if replaced {
        details["replaced_by_confirmation"] = true.into();
    }
    note(
        tx,
        at,
        Some(actor),
        visit,
        Note {
            action: ENDED,
            resource_type: "auth_session",
            resource_id: session_id,
            details: Some(details),
        },
    )
}

/// Ends a session a confirmation has just replaced.
pub(super) fn end_replaced(
    tx: &Transaction<'_>,
    at: &str,
    actor: &Caller,
    visit: &Visit,
    session: &Session,
) -> Result<()> {
    ended(tx, at, actor, visit, &session.id, &session.user_id, true)
}

/// Ends every session of `user_id` but `keeping`.
pub(super) fn end_all(
    tx: &Transaction<'_>,
    at: &str,
    actor: &Caller,
    visit: &Visit,
    user_id: &str,
    keeping: Option<&str>,
) -> Result<()> {
    let mut statement = tx.prepare("SELECT id FROM auth_session WHERE user_id = ?1")?;
    let ids = statement
        .query_map([user_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    for id in ids.iter().filter(|id| Some(id.as_str()) != keeping) {
        ended(tx, at, actor, visit, id, user_id, false)?;
    }
    Ok(())
}

/// Signs a browser out. A session that ended while this waited is out already.
pub async fn sign_out(app: &App, caller: &Caller, visit: Visit) -> Result<()> {
    if caller.session().is_none() {
        return Err(unauthorized());
    }
    let ending = app
        .write(caller, ENDED, move |unit| {
            let session = unit.caller.session().ok_or_else(unauthorized)?;
            ended(
                unit.tx(),
                &unit.at,
                &unit.caller,
                &visit,
                &session.id,
                &session.user_id,
                false,
            )
        })
        .await;
    match ending {
        Err(refusal) if refusal.code == Code::Unauthorized => Ok(()),
        other => other,
    }
}

/// Ends the owner's other sessions, or all of them, which only a recent
/// sign-in may ask.
pub async fn end_many(app: &App, caller: &Caller, keep_own: bool, visit: Visit) -> Result<()> {
    app.write(caller, ENDED, move |unit| {
        unit.caller.require_recent(&unit.at)?;
        let session = unit.caller.session().ok_or_else(unauthorized)?;
        let keeping = keep_own.then_some(session.id.as_str());
        end_all(
            unit.tx(),
            &unit.at,
            &unit.caller,
            &visit,
            &session.user_id,
            keeping,
        )
    })
    .await
}

/// The instant `at` as the whole seconds a session is judged in.
pub fn now_of(at: &str) -> Result<i64> {
    seconds_of(at)
}

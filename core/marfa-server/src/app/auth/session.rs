//! Browser sessions. The cookie holds 32 random bytes and the table only
//! their digest, so a copy of the database signs no one in.

use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde_json::json;

use super::{Note, Visit, names, note};
use crate::app::access::{Caller, Standing, unauthorized};
use crate::app::clock::{Stamp, Unread, readable};
use crate::app::faults::{FAIL_SESSION_DELETE, FAIL_SESSION_LOOKUP, FAIL_SESSION_USE};
use crate::app::keys::digest_of;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::{App, instance};
use crate::db::Write;

const TOKEN_BYTES: usize = 32;
/// A week and a minute, since a use is recorded at most once a minute.
const IDLE_MS: i64 = (7 * 24 * 3600 + 60) * 1000;
const USE_EVERY_MS: i64 = 60 * 1000;
const RECENT_MS: i64 = 5 * 60 * 1000;
pub(super) const ENDED: &str = "auth.sign_in.ended";
/// Bookkeeping, named so a fault can reach it. It leaves no audit entry.
const USE: Write = Write {
    action: Some("auth.sign_in.used"),
    for_caller: false,
    sync: true,
};

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub owner_id: String,
    pub created_at: Stamp,
    pub updated_at: Stamp,
    pub expires_at: Stamp,
    pub user_agent: Option<String>,
    /// What the instance's levers hold it to, once a transaction has read them.
    pub standing: Standing,
}

impl Session {
    pub fn is_recent(&self, now: Stamp) -> bool {
        now.ms().saturating_sub(self.created_at.ms()) <= RECENT_MS
    }

    /// What a sign-in is called where it wrote something.
    pub fn name(&self) -> String {
        names::browser_name(self.user_agent.as_deref())
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
        owner_id: row.get("owner_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        expires_at: row.get("expires_at")?,
        user_agent: row.get("user_agent")?,
        standing: Standing::default(),
    })
}

const COLUMNS: &str = "id, owner_id, created_at, updated_at, expires_at, user_agent";

/// Only the owner's session counts, and only while it lasts.
fn live(tx: &Transaction<'_>, found: Option<Session>, now: Stamp) -> Result<Option<Session>> {
    let owner = instance::owner_id(tx)?;
    Ok(found.filter(|session| {
        session.expires_at > now && owner.as_deref() == Some(session.owner_id.as_str())
    }))
}

pub fn live_by_id(tx: &Transaction<'_>, id: &str, now: Stamp) -> Result<Option<Session>> {
    let found = tx
        .query_row(
            &format!("SELECT {COLUMNS} FROM sign_ins WHERE id = ?1"),
            [id],
            from_row,
        )
        .optional()?;
    live(tx, found, now)
}

/// Every live session of the owner, each with the address it signed in from.
pub(super) fn all_live(tx: &Transaction<'_>, now: Stamp) -> Result<Vec<(Session, Option<String>)>> {
    let Some(owner) = instance::owner_id(tx)? else {
        return Ok(Vec::new());
    };
    Ok(tx
        .prepare(&format!(
            "SELECT {COLUMNS}, ip_address FROM sign_ins WHERE owner_id = ?1"
        ))?
        .query_map([owner], |row| Ok((from_row(row)?, row.get("ip_address")?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(session, _): &(Session, Option<String>)| session.expires_at > now)
        .collect())
}

fn live_by_digest(tx: &Transaction<'_>, digest: &str, now: Stamp) -> Result<Option<Session>> {
    let found = tx
        .query_row(
            &format!("SELECT {COLUMNS} FROM sign_ins WHERE token = ?1"),
            [digest],
            from_row,
        )
        .optional()?;
    live(tx, found, now)
}

/// How many browsers hold a session that still opens at `now`.
pub fn live_count(tx: &Transaction<'_>, now: Stamp) -> Result<i64> {
    let Some(owner) = instance::owner_id(tx)? else {
        return Ok(0);
    };
    let ends = tx
        .prepare("SELECT expires_at FROM sign_ins WHERE owner_id = ?1")?
        .query_map([owner], |row| row.get::<_, Stamp>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ends.iter().filter(|ends| **ends > now).count() as i64)
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
    pub owner_id: &'a str,
    pub visit: &'a Visit,
}

pub(super) fn open(tx: &Transaction<'_>, now: Stamp, new: New<'_>) -> Result<Opened> {
    let token = new_token()?;
    let session = Session {
        id: uuid::Uuid::now_v7().to_string(),
        owner_id: new.owner_id.to_string(),
        created_at: now,
        updated_at: now,
        expires_at: now.plus_ms(IDLE_MS)?,
        user_agent: new.visit.user_agent.clone(),
        standing: Standing::default(),
    };
    tx.execute(
        "INSERT INTO sign_ins (id, token, owner_id, created_at, updated_at, expires_at, \
         user_agent, ip_address) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7)",
        params![
            session.id,
            digest_of(new.salt, &token)?,
            session.owner_id,
            now,
            session.expires_at,
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
fn record_use(tx: &Transaction<'_>, id: &str, now: Stamp) -> Result<Option<Seen>> {
    let Some(mut session) = live_by_id(tx, id, now)? else {
        return Ok(None);
    };
    if !use_due(&session, now) {
        return Ok(Some(Seen {
            session,
            recorded: false,
        }));
    }
    session.updated_at = now;
    session.expires_at = now.plus_ms(IDLE_MS)?;
    tx.execute(
        "UPDATE sign_ins SET updated_at = ?2, expires_at = ?3 WHERE id = ?1",
        params![id, session.updated_at, session.expires_at],
    )?;
    Ok(Some(Seen {
        session,
        recorded: true,
    }))
}

fn use_due(session: &Session, now: Stamp) -> bool {
    now.ms() - session.updated_at.ms() >= USE_EVERY_MS
}

/// Storage that is full, read-only or held by another writer costs a session
/// its renewal and nothing else.
fn leaves_use_unwritten(refusal: &Refusal) -> bool {
    matches!(
        refusal.code,
        Code::WriteContention | Code::InsufficientStorage
    ) || refusal.database_code() == Some("SQLITE_READONLY")
}

/// The live session a cookie's token names.
pub async fn find(app: &App, token: &str) -> Result<Option<Session>> {
    if !looks_like_a_token(token) {
        return Ok(None);
    }
    let digest = digest_of(&app.settings.start.key_salt, token)?;
    let now = app.clock.instant();
    app.db
        .read(move |tx| live_by_digest(tx, &digest, now))
        .await
}

/// Records a use of `session` if the last is a minute old. Nothing comes back
/// if it ended meanwhile.
pub async fn seen(app: &App, session: Session) -> Result<Option<Seen>> {
    if !use_due(&session, app.clock.instant()) {
        return Ok(Some(Seen {
            session,
            recorded: false,
        }));
    }
    let id = session.id.clone();
    let clock = app.clock.clone();
    let faults = app.faults.clone();
    match app
        .db
        .write_briefly(USE, move |tx| {
            if faults.fail(FAIL_SESSION_USE, None) {
                return Err(Refusal::new(
                    Code::WriteContention,
                    "The database is busy; try again.",
                ));
            }
            record_use(tx, &id, clock.instant())
        })
        .await
    {
        Err(refusal) if leaves_use_unwritten(&refusal) => Ok(Some(Seen {
            session,
            recorded: false,
        })),
        outcome => outcome,
    }
}

pub(super) fn ended(
    tx: &Transaction<'_>,
    at: &str,
    actor: &Caller,
    visit: &Visit,
    session_id: &str,
    owner_id: &str,
    replaced: bool,
) -> Result<()> {
    tx.execute("DELETE FROM sign_ins WHERE id = ?1", [session_id])?;
    let mut details = json!({ "operation": "delete", "owner_id": owner_id });
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
            resource_type: "sign_in",
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
    ended(tx, at, actor, visit, &session.id, &session.owner_id, true)
}

/// Ends every session of `owner_id` but `keeping`. One already past its end was
/// over before this, so it goes unrecorded.
pub(super) fn end_all(
    tx: &Transaction<'_>,
    at: &str,
    actor: &Caller,
    visit: &Visit,
    owner_id: &str,
    keeping: Option<&str>,
) -> Result<()> {
    let now = Stamp::read(at)?;
    tx.execute(
        &format!(
            "DELETE FROM sign_ins WHERE owner_id = ?1 AND {} AND expires_at <= ?2",
            readable("expires_at")
        ),
        params![owner_id, now],
    )?;
    let mut statement = tx.prepare("SELECT id FROM sign_ins WHERE owner_id = ?1")?;
    let ids = statement
        .query_map([owner_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    for id in ids.iter().filter(|id| Some(id.as_str()) != keeping) {
        ended(tx, at, actor, visit, id, owner_id, false)?;
    }
    Ok(())
}

pub const UNREAD: Unread<'static> = Unread {
    table: "sign_ins",
    time: "expires_at",
    scope: "1",
};

/// Removes up to `batch` sessions past their end, which no cookie opens any more.
pub fn remove_expired(tx: &Transaction<'_>, now: Stamp, batch: i64) -> Result<i64> {
    let count = tx.execute(
        &format!(
            "DELETE FROM sign_ins WHERE id IN ( \
             SELECT id FROM sign_ins WHERE {} AND expires_at <= ?1 LIMIT ?2)",
            readable("expires_at")
        ),
        params![now, batch],
    )?;
    Ok(i64::try_from(count).unwrap_or(i64::MAX))
}

fn io_failure() -> Refusal {
    rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR), None)
        .into()
}

/// Signs a browser out. A session that ended while this waited is out already.
pub async fn sign_out(app: &App, caller: &Caller, visit: Visit) -> Result<()> {
    if caller.session().is_none() {
        return Err(unauthorized());
    }
    if app.faults.fail(FAIL_SESSION_LOOKUP, None) {
        return Err(io_failure());
    }
    let faults = app.faults.clone();
    let ending = app
        .write(caller, ENDED, move |unit| {
            let session = unit.caller.session().ok_or_else(unauthorized)?;
            if faults.fail(FAIL_SESSION_DELETE, None) {
                return Err(io_failure());
            }
            ended(
                unit.tx(),
                &unit.at,
                &unit.caller,
                &visit,
                &session.id,
                &session.owner_id,
                false,
            )
        })
        .await;
    match ending {
        Err(refusal) if refusal.code == Code::Unauthorized => Ok(()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn at(ms: i64) -> Stamp {
        Stamp::from_ms(ms).unwrap()
    }

    fn owned() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../../db/migrations/0001_baseline.sql"))
            .unwrap();
        let then = at(NOW - 60_000);
        db.execute(
            "INSERT INTO owner (id, name, email, password, created_at, updated_at) \
             VALUES ('owner', 'Owner', 'owner@example.test', 'x', ?1, ?1)",
            [then],
        )
        .unwrap();
        db.execute(
            "INSERT INTO instance (key, value) VALUES ('owner_id', 'owner')",
            [],
        )
        .unwrap();
        db
    }

    fn ending(tx: &Transaction<'_>, id: &str, expires_at: &str) {
        tx.execute(
            "INSERT INTO sign_ins (id, token, owner_id, created_at, updated_at, expires_at) \
             VALUES (?1, ?1, 'owner', ?2, ?2, ?3)",
            params![id, at(NOW - 60_000), expires_at],
        )
        .unwrap();
    }

    #[test]
    fn a_session_lives_until_the_millisecond_it_ends_and_the_sweep_takes_it_then() {
        let mut db = owned();
        let tx = db.transaction().unwrap();
        for (id, ms) in [("before", NOW - 1), ("end", NOW), ("after", NOW + 1)] {
            ending(&tx, id, &at(ms).text());
        }
        let now = at(NOW);
        for (id, lives) in [("before", false), ("end", false), ("after", true)] {
            assert_eq!(live_by_id(&tx, id, now).unwrap().is_some(), lives, "{id}");
        }
        let live: Vec<String> = all_live(&tx, now)
            .unwrap()
            .into_iter()
            .map(|(session, _)| session.id)
            .collect();
        assert_eq!(live, ["after"]);
        assert_eq!(live_count(&tx, now).unwrap(), 1);
        assert_eq!(remove_expired(&tx, now, 10).unwrap(), 2);
        let left: Vec<String> = tx
            .prepare("SELECT id FROM sign_ins")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(left, ["after"]);
    }

    #[test]
    fn a_session_whose_end_does_not_read_is_refused_and_never_taken_as_live_or_swept() {
        let now = at(NOW);
        for stored in [
            "0",
            "z",
            "soon",
            "1800000000",
            "2027-01-15T08:00:00Z",
            "2027-01-15T08:00:00.000+00:00",
        ] {
            let mut db = owned();
            let tx = db.transaction().unwrap();
            ending(&tx, "odd", stored);
            let refused = live_by_id(&tx, "odd", now).unwrap_err();
            assert_eq!(refused.code, Code::InternalError, "{stored}");
            assert!(all_live(&tx, now).is_err(), "{stored}");
            assert!(live_count(&tx, now).is_err(), "{stored}");
            assert_eq!(remove_expired(&tx, now, 10).unwrap(), 0, "{stored}");
        }
    }
}

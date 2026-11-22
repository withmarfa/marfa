//! The link's row and the unlinks Marfa Cloud has not been told of. Secrets stay sealed here.

use rusqlite::{OptionalExtension, Row, Transaction, params};

use crate::app::clock::Stamp;
use crate::app::refusal::{Refusal, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Linking,
    Linked,
    Failed,
    /// Marfa Cloud ended a link that was linked.
    Ended,
}

impl State {
    pub fn word(self) -> &'static str {
        match self {
            State::Linking => "linking",
            State::Linked => "linked",
            State::Failed => "failed",
            State::Ended => "ended",
        }
    }

    fn read(word: &str) -> Option<State> {
        Some(match word {
            "linking" => State::Linking,
            "linked" => State::Linked,
            "failed" => State::Failed,
            "ended" => State::Ended,
            _ => return None,
        })
    }
}

/// What a link does with the sign-in address once it is linked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Move {
    Keep,
    /// A caller who could move it confirmed the move when the link started.
    Authorized,
    /// The move waits for a caller who can make it.
    Waiting,
    Done,
}

impl Move {
    pub fn word(self) -> &'static str {
        match self {
            Move::Keep => "keep",
            Move::Authorized => "authorized",
            Move::Waiting => "waiting",
            Move::Done => "done",
        }
    }

    fn read(word: &str) -> Option<Move> {
        Some(match word {
            "keep" => Move::Keep,
            "authorized" => Move::Authorized,
            "waiting" => Move::Waiting,
            "done" => Move::Done,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    pub link_id: String,
    pub state: State,
    pub user_code: String,
    pub approval_url: String,
    pub expires_at: Stamp,
    pub interval_ms: i64,
    /// The port of the 127.0.0.1 listener the tunnel connector reaches; none on a link made
    /// before the port was kept, which cannot be served.
    pub origin_port: Option<u16>,
    pub started_at: Stamp,
    pub poll_secret: Option<String>,
    pub sign_in_move: Move,
    pub previous_sign_in_address: Option<String>,
    pub name: Option<String>,
    pub address: Option<String>,
    pub approved_at: Option<Stamp>,
    pub linked_at: Option<Stamp>,
    pub tunnel_token: Option<String>,
    pub link_credential: Option<String>,
    pub failure_reason: Option<String>,
    pub failure_message: Option<String>,
    pub ended_at: Option<Stamp>,
    /// Why Marfa could not put back the sign-in address as the link ended.
    pub put_back_failure: Option<String>,
}

const LINK_COLUMNS: &str = "link_id, state, user_code, approval_url, expires_at, interval_ms, \
     started_at, poll_secret, sign_in_move, previous_sign_in_address, name, address, \
     approved_at, linked_at, tunnel_token, link_credential, failure_reason, failure_message, \
     ended_at, put_back_failure, origin_port";

fn unread(column: &str) -> Refusal {
    Refusal::internal(&format!("the stored link's {column} does not read"))
}

fn stamp(text: Option<String>, column: &str) -> Result<Option<Stamp>> {
    text.map(|text| Stamp::parsed(&text).ok_or_else(|| unread(column)))
        .transpose()
}

type Columns = (
    (String, String, String, String, String, i64),
    (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    ),
    (Option<String>, Option<String>, Option<String>),
    (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ),
    Option<i64>,
);

fn columns(row: &Row<'_>) -> rusqlite::Result<Columns> {
    Ok((
        (
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
        ),
        (
            row.get(6)?,
            row.get(7)?,
            row.get(8)?,
            row.get(9)?,
            row.get(10)?,
        ),
        (row.get(11)?, row.get(12)?, row.get(13)?),
        (
            row.get(14)?,
            row.get(15)?,
            row.get(16)?,
            row.get(17)?,
            row.get(18)?,
            row.get(19)?,
        ),
        row.get(20)?,
    ))
}

fn link_of(columns: Columns) -> Result<Link> {
    let (
        (link_id, state, user_code, approval_url, expires_at, interval_ms),
        (started_at, poll_secret, sign_in_move, previous_sign_in_address, name),
        (address, approved_at, linked_at),
        (
            tunnel_token,
            link_credential,
            failure_reason,
            failure_message,
            ended_at,
            put_back_failure,
        ),
        origin_port,
    ) = columns;
    Ok(Link {
        link_id,
        state: State::read(&state).ok_or_else(|| unread("state"))?,
        user_code,
        approval_url,
        expires_at: Stamp::parsed(&expires_at).ok_or_else(|| unread("expires_at"))?,
        interval_ms,
        origin_port: origin_port
            .map(|port| {
                u16::try_from(port)
                    .ok()
                    .filter(|port| *port != 0)
                    .ok_or_else(|| unread("origin_port"))
            })
            .transpose()?,
        started_at: Stamp::parsed(&started_at).ok_or_else(|| unread("started_at"))?,
        poll_secret,
        sign_in_move: Move::read(&sign_in_move).ok_or_else(|| unread("sign_in_move"))?,
        previous_sign_in_address,
        name,
        address,
        approved_at: stamp(approved_at, "approved_at")?,
        linked_at: stamp(linked_at, "linked_at")?,
        tunnel_token,
        link_credential,
        failure_reason,
        failure_message,
        ended_at: stamp(ended_at, "ended_at")?,
        put_back_failure,
    })
}

pub fn read(tx: &Transaction<'_>) -> Result<Option<Link>> {
    let columns = tx
        .query_row(
            &format!("SELECT {LINK_COLUMNS} FROM cloud_link WHERE id = 1"),
            [],
            columns,
        )
        .optional()?;
    columns.map(link_of).transpose()
}

/// Replaces any link there was.
pub fn put(tx: &Transaction<'_>, link: &Link) -> Result<()> {
    tx.execute(
        &format!(
            "INSERT OR REPLACE INTO cloud_link (id, {LINK_COLUMNS}) \
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, \
             ?17, ?18, ?19, ?20, ?21)"
        ),
        params![
            link.link_id,
            link.state.word(),
            link.user_code,
            link.approval_url,
            link.expires_at.text(),
            link.interval_ms,
            link.started_at.text(),
            link.poll_secret,
            link.sign_in_move.word(),
            link.previous_sign_in_address,
            link.name,
            link.address,
            link.approved_at.map(Stamp::text),
            link.linked_at.map(Stamp::text),
            link.tunnel_token,
            link.link_credential,
            link.failure_reason,
            link.failure_message,
            link.ended_at.map(Stamp::text),
            link.put_back_failure,
            link.origin_port,
        ],
    )?;
    Ok(())
}

pub fn remove(tx: &Transaction<'_>) -> Result<()> {
    tx.execute("DELETE FROM cloud_link", [])?;
    Ok(())
}

/// A link ended here whose end Marfa Cloud has not been told of.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unlink {
    pub link_id: String,
    pub link_credential: Option<String>,
    pub poll_secret: Option<String>,
    pub expires_at: Stamp,
    pub interval_ms: i64,
}

pub fn queue(tx: &Transaction<'_>, unlink: &Unlink) -> Result<()> {
    tx.execute(
        "INSERT OR REPLACE INTO cloud_unlinks \
         (link_id, link_credential, poll_secret, expires_at, interval_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            unlink.link_id,
            unlink.link_credential,
            unlink.poll_secret,
            unlink.expires_at.text(),
            unlink.interval_ms,
        ],
    )?;
    Ok(())
}

pub fn unlinks(tx: &Transaction<'_>) -> Result<Vec<Unlink>> {
    let rows = tx
        .prepare(
            "SELECT link_id, link_credential, poll_secret, expires_at, interval_ms \
             FROM cloud_unlinks ORDER BY link_id",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(
            |(link_id, link_credential, poll_secret, expires_at, interval_ms)| {
                Ok(Unlink {
                    link_id,
                    link_credential,
                    poll_secret,
                    expires_at: Stamp::parsed(&expires_at).ok_or_else(|| unread("expires_at"))?,
                    interval_ms,
                })
            },
        )
        .collect()
}

/// Whether Marfa Cloud has not been told of some unlink.
pub fn any_untold(tx: &Transaction<'_>) -> Result<bool> {
    Ok(
        tx.query_row("SELECT EXISTS (SELECT 1 FROM cloud_unlinks)", [], |row| {
            row.get(0)
        })?,
    )
}

pub fn forget(tx: &Transaction<'_>, link_id: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM cloud_unlinks WHERE link_id = ?1",
        params![link_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::read;

    #[test]
    fn a_link_stored_with_no_origin_port_reads_as_having_none() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::db::migrate::make_all(&db).unwrap();
        let tx = db.transaction().unwrap();
        tx.execute(
            "INSERT INTO cloud_link (id, link_id, state, user_code, approval_url, expires_at, \
             interval_ms, started_at, sign_in_move) VALUES (1, 'link', 'linked', 'ABCD-1234', \
             'https://cloud.example/link', '2026-01-01T00:00:00.000Z', 5000, \
             '2026-01-01T00:00:00.000Z', 'keep')",
            [],
        )
        .unwrap();
        assert_eq!(read(&tx).unwrap().unwrap().origin_port, None);
        tx.execute("UPDATE cloud_link SET origin_port = 8080", [])
            .unwrap();
        assert_eq!(read(&tx).unwrap().unwrap().origin_port, Some(8080));
    }
}

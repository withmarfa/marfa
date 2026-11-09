//! Every statement about subscriptions, their deliveries and the sender's place in the log.

use rusqlite::{OptionalExtension, Row, Transaction, params};

use crate::app::access::Maker;
use crate::app::refusal::{Refusal, Result};

#[derive(Clone, Debug)]
pub struct Subscription {
    pub id: String,
    pub url: String,
    pub events: Vec<String>,
    pub type_filter: Option<String>,
    pub secret: String,
    pub active: bool,
    pub maker: Maker,
    pub starts_after: i64,
    pub created_at: String,
    pub updated_at: String,
}

const SUBSCRIPTION: &str = "SELECT id, url, events, type_filter, secret, active, key_id, grant_id, \
     starts_after, created_at, updated_at FROM webhooks";

fn subscription_of(row: &Row<'_>) -> rusqlite::Result<Subscription> {
    let events: String = row.get(2)?;
    let key_id: Option<String> = row.get(6)?;
    let grant_id: Option<String> = row.get(7)?;
    let maker = match (key_id, grant_id) {
        (Some(id), _) => Maker::Key(id),
        (None, Some(id)) => Maker::Grant(id),
        (None, None) => {
            return Err(rusqlite::Error::InvalidColumnType(
                6,
                "key_id".into(),
                rusqlite::types::Type::Null,
            ));
        }
    };
    Ok(Subscription {
        id: row.get(0)?,
        url: row.get(1)?,
        events: serde_json::from_str(&events).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, error.into())
        })?,
        type_filter: row.get(3)?,
        secret: row.get(4)?,
        active: row.get(5)?,
        maker,
        starts_after: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn maker_columns(maker: &Maker) -> (Option<&str>, Option<&str>) {
    match maker {
        Maker::Key(id) => (Some(id), None),
        Maker::Grant(id) => (None, Some(id)),
    }
}

fn events_text(events: &[String]) -> Result<String> {
    serde_json::to_string(events)
        .map_err(|_| Refusal::internal("a subscription's events did not print"))
}

pub fn insert(tx: &Transaction<'_>, subscription: &Subscription) -> Result<()> {
    let (key_id, grant_id) = maker_columns(&subscription.maker);
    tx.execute(
        "INSERT INTO webhooks (id, url, events, type_filter, secret, active, key_id, grant_id, \
         starts_after, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            subscription.id,
            subscription.url,
            events_text(&subscription.events)?,
            subscription.type_filter,
            subscription.secret,
            subscription.active,
            key_id,
            grant_id,
            subscription.starts_after,
            subscription.created_at,
            subscription.updated_at,
        ],
    )?;
    turn(tx, &subscription.maker)
}

pub fn update(tx: &Transaction<'_>, subscription: &Subscription) -> Result<()> {
    tx.execute(
        "UPDATE webhooks SET url = ?2, events = ?3, type_filter = ?4, active = ?5, updated_at = ?6 \
         WHERE id = ?1",
        params![
            subscription.id,
            subscription.url,
            events_text(&subscription.events)?,
            subscription.type_filter,
            subscription.active,
            subscription.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete(tx: &Transaction<'_>, subscription: &Subscription) -> Result<()> {
    tx.execute("DELETE FROM webhooks WHERE id = ?1", [&subscription.id])?;
    turn(tx, &subscription.maker)
}

fn turn(tx: &Transaction<'_>, maker: &Maker) -> Result<()> {
    let (column, id) = match maker {
        Maker::Key(id) => ("key_id", id),
        Maker::Grant(id) => ("grant_id", id),
    };
    tx.execute(
        &format!(
            "INSERT INTO webhook_turns ({column}, turns) VALUES (?1, 1) \
             ON CONFLICT ({column}) WHERE {column} IS NOT NULL DO UPDATE SET turns = turns + 1"
        ),
        [id],
    )?;
    Ok(())
}

/// How many webhooks `maker` has made or deleted.
pub fn turns(tx: &Transaction<'_>, maker: &Maker) -> Result<i64> {
    let (key_id, grant_id) = maker_columns(maker);
    Ok(tx
        .query_row(
            "SELECT turns FROM webhook_turns WHERE key_id = ?1 OR grant_id = ?2",
            params![key_id, grant_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

/// How many subscriptions `maker` holds now.
pub fn count(tx: &Transaction<'_>, maker: &Maker) -> Result<i64> {
    let (column, id) = match maker {
        Maker::Key(id) => ("key_id", id),
        Maker::Grant(id) => ("grant_id", id),
    };
    Ok(tx.query_row(
        &format!("SELECT COUNT(*) FROM webhooks WHERE {column} = ?1"),
        [id],
        |row| row.get(0),
    )?)
}

pub fn delete_for_grant(tx: &Transaction<'_>, grant_id: &str) -> Result<usize> {
    Ok(tx.execute("DELETE FROM webhooks WHERE grant_id = ?1", [grant_id])?)
}

/// `reach` is the maker whose subscriptions the caller reaches, or `None` for every one.
pub fn by_id(
    tx: &Transaction<'_>,
    id: &str,
    reach: Option<&Maker>,
) -> Result<Option<Subscription>> {
    let found = tx
        .query_row(
            &format!("{SUBSCRIPTION} WHERE id = ?1"),
            [id],
            subscription_of,
        )
        .optional()?;
    Ok(found.filter(|subscription| reach.is_none_or(|maker| *maker == subscription.maker)))
}

pub fn list(tx: &Transaction<'_>, reach: Option<&Maker>) -> Result<Vec<Subscription>> {
    let (key_id, grant_id) = match reach {
        Some(maker) => maker_columns(maker),
        None => (None, None),
    };
    let mut statement = tx.prepare(&format!(
        "{SUBSCRIPTION} WHERE (?1 IS NULL AND ?2 IS NULL) OR key_id = ?1 OR grant_id = ?2 \
         ORDER BY created_at, id"
    ))?;
    let rows = statement.query_map(params![key_id, grant_id], subscription_of)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn active(tx: &Transaction<'_>) -> Result<Vec<Subscription>> {
    let mut statement =
        tx.prepare_cached(&format!("{SUBSCRIPTION} WHERE active = 1 ORDER BY id"))?;
    let rows = statement.query_map([], subscription_of)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The newest log id deliveries have been queued through; `None` while the row is missing.
pub fn position(tx: &Transaction<'_>) -> Result<Option<i64>> {
    Ok(tx
        .query_row(
            "SELECT event_id FROM webhook_position WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn set_position(tx: &Transaction<'_>, event_id: i64) -> Result<()> {
    tx.execute(
        "INSERT INTO webhook_position (id, event_id) VALUES (1, ?1) \
         ON CONFLICT (id) DO UPDATE SET event_id = excluded.event_id",
        [event_id],
    )?;
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    Pending,
    Success,
    DeadLetter,
    Canceled,
}

impl Status {
    pub fn wire(&self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Success => "success",
            Status::DeadLetter => "dead_letter",
            Status::Canceled => "canceled",
        }
    }

    fn read(text: &str) -> Option<Status> {
        Some(match text {
            "pending" => Status::Pending,
            "success" => Status::Success,
            "dead_letter" => Status::DeadLetter,
            "canceled" => Status::Canceled,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug)]
pub struct Delivery {
    pub seq: i64,
    pub id: String,
    pub webhook_id: String,
    pub event_id: i64,
    pub event_type: String,
    pub type_id: String,
    pub source: String,
    pub status: Status,
    pub status_code: Option<i64>,
    pub attempt: i64,
    pub cycle_attempt: i64,
    pub error: Option<String>,
    pub created_at: String,
}

const DELIVERY_COLUMNS: &str = "seq, id, webhook_id, event_id, event_type, type, source, status, \
     status_code, attempt, cycle_attempt, error, created_at";
const DELIVERY: &str = "SELECT seq, id, webhook_id, event_id, event_type, type, source, status, \
     status_code, attempt, cycle_attempt, error, created_at FROM webhook_deliveries";

fn delivery_of(row: &Row<'_>) -> rusqlite::Result<Delivery> {
    let status: String = row.get(7)?;
    Ok(Delivery {
        seq: row.get(0)?,
        id: row.get(1)?,
        webhook_id: row.get(2)?,
        event_id: row.get(3)?,
        event_type: row.get(4)?,
        type_id: row.get(5)?,
        source: row.get(6)?,
        status: Status::read(&status).ok_or_else(|| {
            rusqlite::Error::InvalidColumnType(7, "status".into(), rusqlite::types::Type::Text)
        })?,
        status_code: row.get(8)?,
        attempt: row.get(9)?,
        cycle_attempt: row.get(10)?,
        error: row.get(11)?,
        created_at: row.get(12)?,
    })
}

pub struct Queued<'a> {
    pub id: &'a str,
    pub webhook_id: &'a str,
    pub event_id: i64,
    pub event_type: &'a str,
    pub type_id: &'a str,
    pub source: &'a str,
    pub payload: &'a str,
    pub due_at: i64,
    pub at: &'a str,
}

/// Answers whether the delivery is new: one subscription has one delivery of an event.
pub fn queue(tx: &Transaction<'_>, queued: &Queued<'_>) -> Result<bool> {
    let added = tx.execute(
        "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, type, source, \
         payload, status, due_at, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9, ?9) \
         ON CONFLICT (webhook_id, event_id) DO NOTHING",
        params![
            queued.id,
            queued.webhook_id,
            queued.event_id,
            queued.event_type,
            queued.type_id,
            queued.source,
            queued.payload,
            queued.due_at,
            queued.at,
        ],
    )?;
    Ok(added == 1)
}

pub fn delivery(tx: &Transaction<'_>, webhook_id: &str, id: &str) -> Result<Option<Delivery>> {
    Ok(tx
        .query_row(
            &format!("{DELIVERY} WHERE webhook_id = ?1 AND id = ?2"),
            [webhook_id, id],
            delivery_of,
        )
        .optional()?)
}

/// The delivery with its stored event, while it is still pending.
pub fn pending(tx: &Transaction<'_>, seq: i64) -> Result<Option<(Delivery, String)>> {
    Ok(tx
        .query_row(
            &format!(
                "SELECT {DELIVERY_COLUMNS}, payload FROM webhook_deliveries \
                 WHERE seq = ?1 AND status = 'pending'"
            ),
            [seq],
            |row| Ok((delivery_of(row)?, row.get(13)?)),
        )
        .optional()?)
}

pub fn pending_of(tx: &Transaction<'_>, webhook_id: &str) -> Result<Vec<Delivery>> {
    let mut statement = tx.prepare(&format!(
        "{DELIVERY} WHERE webhook_id = ?1 AND status = 'pending' ORDER BY seq"
    ))?;
    let rows = statement.query_map([webhook_id], delivery_of)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Newest first, from before `before` when a page has been read.
pub fn page(
    tx: &Transaction<'_>,
    webhook_id: &str,
    before: Option<i64>,
    limit: i64,
) -> Result<Vec<Delivery>> {
    let mut statement = tx.prepare(&format!(
        "{DELIVERY} WHERE webhook_id = ?1 AND (?2 IS NULL OR seq < ?2) ORDER BY seq DESC LIMIT ?3"
    ))?;
    let rows = statement.query_map(params![webhook_id, before, limit], delivery_of)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A subscription's maker as one text, the same for every subscription the maker holds.
const MAKER: &str = "SELECT id, CASE WHEN key_id IS NOT NULL THEN 'key:' || key_id \
     ELSE 'grant:' || grant_id END AS maker FROM webhooks";

/// A delivery that has fallen due, and the maker whose share its attempt takes.
pub struct Due {
    pub seq: i64,
    pub maker: String,
}

/// The deliveries that have fallen due as of `?1`, each with its subscription's maker.
fn due_rows() -> String {
    format!(
        "SELECT d.seq, d.webhook_id, d.due_at, m.maker FROM webhook_deliveries d \
         JOIN ({MAKER}) m ON m.id = d.webhook_id WHERE d.status = 'pending' AND d.due_at <= ?1"
    )
}

/// One due delivery per idle subscription; a maker alone may pass its `share`, up to `beyond_share` rows in all.
pub fn due(
    tx: &Transaction<'_>,
    now_ms: i64,
    busy: &[i64],
    holding: &[String],
    share: usize,
    limit: usize,
    beyond_share: usize,
) -> Result<Vec<Due>> {
    let busy =
        serde_json::to_string(busy).map_err(|_| Refusal::internal("a list did not print"))?;
    let holding =
        serde_json::to_string(holding).map_err(|_| Refusal::internal("a list did not print"))?;
    let mut statement = tx.prepare_cached(&format!(
        "WITH due AS ({}), \
         span AS (SELECT MIN(maker) AS lo, MAX(maker) AS hi FROM due), \
         heads AS (SELECT seq, due_at, maker, ROW_NUMBER() OVER \
         (PARTITION BY maker ORDER BY due_at, seq) AS place \
         FROM (SELECT seq, due_at, maker, ROW_NUMBER() OVER \
         (PARTITION BY webhook_id ORDER BY due_at, seq) AS turn FROM due \
         WHERE webhook_id NOT IN (SELECT webhook_id FROM webhook_deliveries \
         WHERE seq IN (SELECT value FROM json_each(?2)))) WHERE turn = 1), \
         shared AS (SELECT seq, due_at, maker, place, ?4 - (SELECT COUNT(*) FROM json_each(?3) \
         WHERE value = heads.maker) AS room FROM heads), \
         picked AS (SELECT seq, due_at, maker, place > room AS past FROM shared, span \
         WHERE place <= room OR (lo = maker AND hi = maker)), \
         ranked AS (SELECT seq, maker, past, ROW_NUMBER() OVER (ORDER BY past, due_at, seq) AS n \
         FROM picked) \
         SELECT seq, maker FROM ranked \
         WHERE NOT past OR n <= ?6 ORDER BY n LIMIT ?5",
        due_rows()
    ))?;
    let share = i64::try_from(share).unwrap_or(i64::MAX);
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let beyond_share = i64::try_from(beyond_share).unwrap_or(i64::MAX);
    let rows = statement.query_map(
        params![now_ms, busy, holding, share, limit, beyond_share],
        |row| {
            Ok(Due {
                seq: row.get(0)?,
                maker: row.get(1)?,
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// When the next delivery not yet due falls due, leaving out the subscriptions being attempted.
pub fn next_due(tx: &Transaction<'_>, now_ms: i64, busy: &[i64]) -> Result<Option<i64>> {
    let busy =
        serde_json::to_string(busy).map_err(|_| Refusal::internal("a list did not print"))?;
    Ok(tx.query_row(
        "SELECT MIN(due_at) FROM webhook_deliveries WHERE status = 'pending' AND due_at > ?1 \
         AND webhook_id NOT IN (SELECT webhook_id FROM webhook_deliveries \
         WHERE seq IN (SELECT value FROM json_each(?2)))",
        params![now_ms, busy],
        |row| row.get(0),
    )?)
}

#[test]
fn due_takes_one_turn_per_subscription_and_shares_attempts_between_makers() {
    let mut db = rusqlite::Connection::open_in_memory().unwrap();
    let tx = db.transaction().unwrap();
    tx.execute_batch(
        "CREATE TABLE webhooks (id TEXT, key_id TEXT, grant_id TEXT);
         CREATE TABLE webhook_deliveries (seq INTEGER, webhook_id TEXT, status TEXT, due_at INTEGER);
         INSERT INTO webhooks VALUES ('a', 'k1', NULL), ('b', 'k1', NULL), ('c', 'k1', NULL),
         ('d', NULL, 'g1');
         INSERT INTO webhook_deliveries VALUES (1, 'a', 'pending', 0), (2, 'a', 'pending', 0),
         (3, 'b', 'pending', 0), (4, 'c', 'pending', 5), (5, 'd', 'pending', 1);",
    )
    .unwrap();
    let seqs = |found: Vec<Due>| found.into_iter().map(|due| due.seq).collect::<Vec<_>>();
    assert_eq!(
        seqs(due(&tx, 1, &[], &[], 8, 10, 10).unwrap()),
        vec![1, 3, 5]
    );
    assert_eq!(seqs(due(&tx, 1, &[], &[], 8, 1, 10).unwrap()), vec![1]);
    assert_eq!(seqs(due(&tx, 1, &[1], &[], 8, 10, 10).unwrap()), vec![3, 5]);
    assert_eq!(seqs(due(&tx, 1, &[], &[], 1, 10, 10).unwrap()), vec![1, 5]);
    let held = ["key:k1".to_string()];
    assert_eq!(seqs(due(&tx, 1, &[], &held, 1, 10, 10).unwrap()), vec![5]);
    assert_eq!(
        seqs(due(&tx, 1, &[], &held, 2, 10, 10).unwrap()),
        vec![1, 5]
    );
    assert_eq!(
        seqs(due(&tx, 0, &[], &[], 1, 10, 10).unwrap()),
        vec![1, 3],
        "a maker no other maker waits behind may pass its share"
    );
    assert_eq!(
        seqs(due(&tx, 1, &[1, 3], &held, 1, 10, 10).unwrap()),
        vec![5],
        "the busy subscriptions of another maker keep the share"
    );
    assert_eq!(next_due(&tx, 1, &[1, 3]).unwrap(), Some(5));
    assert_eq!(
        next_due(&tx, 1, &[1, 3, 4]).unwrap(),
        None,
        "a delivery already due waits for an attempt to end, and a busy subscription for its own"
    );
}

#[test]
fn due_lets_a_maker_nobody_waits_behind_pass_its_share_within_the_room_beyond_it() {
    let held = ["key:k1".to_string(), "key:k1".to_string()];
    let ask = |inserts: &str, beyond_share: usize| {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        let tx = db.transaction().unwrap();
        tx.execute_batch(&format!(
            "CREATE TABLE webhooks (id TEXT, key_id TEXT, grant_id TEXT);
             CREATE TABLE webhook_deliveries (seq INTEGER, webhook_id TEXT, status TEXT, due_at INTEGER);
             INSERT INTO webhooks VALUES ('a', 'k1', NULL), ('b', 'k1', NULL), ('c', NULL, 'g1'),
             ('d', 'k2', NULL), ('e', 'k1', NULL);
             {inserts}"
        ))
        .unwrap();
        let started: Vec<i64> = due(&tx, 10, &[], &held, 2, 10, beyond_share)
            .unwrap()
            .into_iter()
            .map(|due| due.seq)
            .collect();
        let next = next_due(&tx, 10, &started).unwrap();
        (started, next)
    };
    let alone = "INSERT INTO webhook_deliveries VALUES (1, 'a', 'pending', 0),
         (2, 'b', 'pending', 0), (3, 'e', 'pending', 0), (4, 'd', 'pending', 50);";
    assert_eq!(
        ask(alone, 10),
        (vec![1, 2, 3], Some(50)),
        "one maker passes its share, and its later delivery keeps a timer"
    );
    assert_eq!(
        ask(alone, 2),
        (vec![1, 2], Some(50)),
        "a maker alone starts past its share only within the room beyond it"
    );
    assert_eq!(
        ask(alone, 0),
        (vec![], Some(50)),
        "a maker alone starts nothing past its share when there is no room beyond it"
    );
    assert_eq!(
        ask(
            "INSERT INTO webhook_deliveries VALUES (1, 'a', 'pending', 0), (2, 'b', 'pending', 0),
             (3, 'c', 'pending', 0), (4, 'a', 'pending', 50);",
            10,
        ),
        (vec![3], Some(50)),
        "another maker with a delivery due keeps a full maker to its share"
    );
    assert_eq!(
        ask(
            "INSERT INTO webhook_deliveries VALUES (1, 'a', 'pending', 0), (2, 'b', 'pending', 0),
             (3, 'c', 'pending', 50), (4, 'd', 'pending', 0), (5, 'd', 'pending', 0);",
            10,
        ),
        (vec![4], Some(50)),
        "of three makers, the one within its share passes and the full one waits"
    );
    assert_eq!(
        ask(
            "INSERT INTO webhook_deliveries VALUES (1, 'a', 'pending', 0), (2, 'b', 'success', 0),
             (3, 'c', 'pending', 50);",
            10,
        ),
        (vec![1], Some(50)),
        "a settled delivery is not one due"
    );
}

/// Preserves earlier attempts and leaves settled deliveries unchanged.
pub fn cancel(tx: &Transaction<'_>, seq: i64, error: &str, at: &str) -> Result<()> {
    tx.execute(
        "UPDATE webhook_deliveries SET status = 'canceled', error = ?2, updated_at = ?3, \
         payload = NULL WHERE seq = ?1 AND status = 'pending'",
        params![seq, error, at],
    )?;
    Ok(())
}

pub fn cancel_all(tx: &Transaction<'_>, webhook_id: &str, error: &str, at: &str) -> Result<()> {
    tx.execute(
        "UPDATE webhook_deliveries SET status = 'canceled', error = ?2, updated_at = ?3, \
         payload = NULL WHERE webhook_id = ?1 AND status = 'pending'",
        params![webhook_id, error, at],
    )?;
    Ok(())
}

/// What an attempt that got as far as the network leaves on its delivery.
pub struct Recorded<'a> {
    pub status: Status,
    pub status_code: Option<u16>,
    pub error: Option<&'a str>,
    pub due_at: i64,
}

/// Only a delivery still pending takes the outcome, so one settled while it was attempted stays settled.
pub fn record(tx: &Transaction<'_>, seq: i64, recorded: &Recorded<'_>, at: &str) -> Result<()> {
    tx.execute(
        "UPDATE webhook_deliveries SET status = ?2, status_code = ?3, error = ?4, due_at = ?5, \
         attempt = attempt + 1, cycle_attempt = cycle_attempt + 1, updated_at = ?6, \
         payload = CASE WHEN ?2 = 'success' THEN NULL ELSE payload END \
         WHERE seq = ?1 AND status = 'pending'",
        params![
            seq,
            recorded.status.wire(),
            recorded.status_code,
            recorded.error,
            recorded.due_at,
            at
        ],
    )?;
    Ok(())
}

pub fn redeliver(tx: &Transaction<'_>, seq: i64, due_at: i64, at: &str) -> Result<()> {
    tx.execute(
        "UPDATE webhook_deliveries SET status = 'pending', cycle_attempt = 0, due_at = ?2, \
         updated_at = ?3 WHERE seq = ?1 AND status = 'dead_letter'",
        params![seq, due_at, at],
    )?;
    Ok(())
}

/// Settled deliveries created before `before`, oldest first.
pub fn expire(tx: &Transaction<'_>, before: &str, limit: i64) -> Result<i64> {
    let removed = tx.execute(
        "DELETE FROM webhook_deliveries WHERE seq IN (SELECT seq FROM webhook_deliveries \
         WHERE status <> 'pending' AND created_at < ?1 ORDER BY created_at LIMIT ?2)",
        params![before, limit],
    )?;
    Ok(removed as i64)
}

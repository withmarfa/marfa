//! How many attempts a door takes, held in the database so a restart keeps
//! them. Each limit is a fixed window opened by its first attempt.

use std::net::IpAddr;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{OptionalExtension, Transaction, params};

use crate::app::refusal::{Code, Refusal, Result};

const MINUTE_MS: i64 = 60_000;
const ACCOUNT_ADDRESS: &str = "sign-in-account-address";
const ACCOUNT: &str = "sign-in-account";
const SETUP_ADDRESS: &str = "instance-claim-address";
const DEVICE_ADDRESS: &str = "device-user-code-address";
const DEVICE_INSTANCE: &str = "device-user-code-instance";
const DEVICE_OWNER: &str = "device-user-code-owner";
const DEVICE_OWNER_INSTANCE: &str = "device-user-code-owner-instance";
const DOCUMENT_ADDRESS: &str = "client-document-address";
const DOCUMENT_INSTANCE: &str = "client-document-instance";
/// The key of a count every address or every owner shares.
const ALL: &str = "all";
/// An address nothing could name shares this one count.
const NO_ADDRESS: &str = "unknown";
const MAX_ACCOUNT_CHARS: usize = 254;

/// One count an attempt is held to.
#[derive(Clone, Debug)]
pub struct Lane {
    family: &'static str,
    key: String,
    limit: i64,
    window_ms: i64,
}

/// What an address is counted as: an IPv6 address by its /64.
fn bucket(address: Option<IpAddr>) -> String {
    let Some(address) = address else {
        return NO_ADDRESS.to_string();
    };
    match address.to_canonical() {
        IpAddr::V4(address) => address.to_string(),
        IpAddr::V6(address) => {
            let [a, b, c, d, ..] = address.segments();
            format!("{a:x}:{b:x}:{c:x}:{d:x}::/64")
        }
    }
}

fn account_key(email: &str) -> String {
    email
        .trim()
        .to_lowercase()
        .chars()
        .take(MAX_ACCOUNT_CHARS)
        .collect()
}

/// The two counts every check of a password goes through, wherever it is made.
pub fn password_lanes(email: &str, address: Option<IpAddr>) -> [Lane; 2] {
    let account = account_key(email);
    [
        Lane {
            family: ACCOUNT_ADDRESS,
            key: format!("{account}|{}", bucket(address)),
            limit: 10,
            window_ms: 15 * MINUTE_MS,
        },
        Lane {
            family: ACCOUNT,
            key: account,
            limit: 100,
            window_ms: 60 * MINUTE_MS,
        },
    ]
}

pub fn setup_code_lanes(address: Option<IpAddr>) -> [Lane; 1] {
    [Lane {
        family: SETUP_ADDRESS,
        key: bucket(address),
        limit: 10,
        window_ms: 15 * MINUTE_MS,
    }]
}

/// The counts of a device code lookup made without an owner's own session.
pub fn device_lookup_lanes(address: Option<IpAddr>) -> [Lane; 2] {
    [
        Lane {
            family: DEVICE_ADDRESS,
            key: bucket(address),
            limit: 10,
            window_ms: 15 * MINUTE_MS,
        },
        Lane {
            family: DEVICE_INSTANCE,
            key: ALL.to_string(),
            limit: 100,
            window_ms: 15 * MINUTE_MS,
        },
    ]
}

/// The counts of a lookup made by the claimed owner's live session, whichever
/// address or session it came from.
pub fn device_owner_lanes(user_id: &str) -> [Lane; 2] {
    [
        Lane {
            family: DEVICE_OWNER,
            key: user_id.to_string(),
            limit: 10,
            window_ms: 15 * MINUTE_MS,
        },
        Lane {
            family: DEVICE_OWNER_INSTANCE,
            key: ALL.to_string(),
            limit: 100,
            window_ms: 15 * MINUTE_MS,
        },
    ]
}

/// The counts of a metadata document fetched for a client not yet stored.
pub fn document_lanes(address: Option<IpAddr>) -> [Lane; 2] {
    [
        Lane {
            family: DOCUMENT_ADDRESS,
            key: bucket(address),
            limit: 10,
            window_ms: MINUTE_MS,
        },
        Lane {
            family: DOCUMENT_INSTANCE,
            key: ALL.to_string(),
            limit: 30,
            window_ms: MINUTE_MS,
        },
    ]
}

fn stamp(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn read(tx: &Transaction<'_>, lane: &Lane, now_ms: i64) -> Result<Option<(i64, i64)>> {
    let row: Option<(i64, String)> = tx
        .query_row(
            "SELECT count, expires_at FROM rate_limit_windows \
             WHERE family = ?1 AND window_key = ?2",
            params![lane.family, lane.key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.and_then(|(count, expires_at)| {
        let end = DateTime::parse_from_rfc3339(&expires_at)
            .ok()?
            .timestamp_millis();
        (end > now_ms).then_some((count, end))
    }))
}

/// Removes up to `batch` windows that have ended, of any family.
pub fn remove_expired(tx: &Transaction<'_>, now_ms: i64, batch: i64) -> Result<i64> {
    let count = tx.execute(
        "DELETE FROM rate_limit_windows WHERE (family, window_key) IN ( \
         SELECT family, window_key FROM rate_limit_windows WHERE expires_at <= ?1 LIMIT ?2)",
        params![stamp(now_ms), batch],
    )?;
    Ok(i64::try_from(count).unwrap_or(i64::MAX))
}

/// Counts one attempt, and answers how many milliseconds from `now_ms` the
/// caller must wait if it is refused. An attempt stops at the first lane that
/// refuses it, so that lane's excess never reaches the next. The wait runs to
/// the latest end among the lanes the next attempt would meet spent.
pub fn admit(tx: &Transaction<'_>, now_ms: i64, lanes: &[Lane]) -> Result<Option<i64>> {
    tx.execute(
        "DELETE FROM rate_limit_windows WHERE expires_at <= ?1 AND family IN \
         (?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            stamp(now_ms),
            ACCOUNT_ADDRESS,
            ACCOUNT,
            SETUP_ADDRESS,
            DEVICE_ADDRESS,
            DEVICE_INSTANCE,
            DEVICE_OWNER,
            DEVICE_OWNER_INSTANCE,
            DOCUMENT_ADDRESS,
            DOCUMENT_INSTANCE,
        ],
    )?;
    let mut refused = false;
    let mut end = None;
    for lane in lanes {
        let found = read(tx, lane, now_ms)?;
        let (count, lane_end) = if refused {
            found.unwrap_or((0, now_ms))
        } else {
            let (count, lane_end) = found.unwrap_or((0, now_ms + lane.window_ms));
            tx.execute(
                "INSERT INTO rate_limit_windows (family, window_key, count, expires_at) \
                 VALUES (?1, ?2, ?3, ?4) ON CONFLICT (family, window_key) \
                 DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at",
                params![lane.family, lane.key, count + 1, stamp(lane_end)],
            )?;
            refused = count + 1 > lane.limit;
            (count + 1, lane_end)
        };
        if count >= lane.limit {
            end = end.max(Some(lane_end));
        }
    }
    Ok(if refused {
        end.map(|end| end - now_ms)
    } else {
        None
    })
}

/// The attempts an account has used, from every address.
pub fn clear_account(tx: &Transaction<'_>, email: &str) -> Result<()> {
    let account = account_key(email);
    tx.execute(
        "DELETE FROM rate_limit_windows WHERE family = ?1 AND window_key = ?2",
        params![ACCOUNT, account],
    )?;
    let prefix = format!("{account}|");
    tx.execute(
        "DELETE FROM rate_limit_windows WHERE family = ?1 \
         AND substr(window_key, 1, length(?2)) = ?2",
        params![ACCOUNT_ADDRESS, prefix],
    )?;
    Ok(())
}

/// The refusal of an attempt with `wait_ms` to go, in whole seconds, at least
/// one.
pub fn spent(message: &'static str, wait_ms: i64) -> Refusal {
    let seconds = ((wait_ms + 999) / 1000).max(1);
    Refusal::new(Code::RateLimited, message).with_detail("retry_after", seconds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../db/migrations/0003_sign_in.sql"))
            .unwrap();
        conn
    }

    fn attempt(conn: &mut Connection, now: i64, lanes: &[Lane]) -> Option<i64> {
        let tx = conn.transaction().unwrap();
        let wait = admit(&tx, now, lanes).unwrap();
        tx.commit().unwrap();
        wait
    }

    #[test]
    fn an_address_past_its_limit_leaves_the_account_count_alone() {
        let mut conn = database();
        let lanes = password_lanes("a@example.test", "203.0.113.1".parse().ok());
        for _ in 0..10 {
            assert_eq!(attempt(&mut conn, 0, &lanes), None);
        }
        assert_eq!(
            attempt(&mut conn, 1_000, &lanes),
            Some(15 * MINUTE_MS - 1_000)
        );
        let tx = conn.transaction().unwrap();
        assert_eq!(read(&tx, &lanes[1], 1_000).unwrap().unwrap().0, 10);
    }

    #[test]
    fn a_window_counts_afresh_once_it_ends() {
        let mut conn = database();
        let lanes = setup_code_lanes(None);
        for _ in 0..11 {
            attempt(&mut conn, 0, &lanes);
        }
        assert!(attempt(&mut conn, 15 * MINUTE_MS - 1, &lanes).is_some());
        assert_eq!(attempt(&mut conn, 15 * MINUTE_MS, &lanes), None);
    }

    #[test]
    fn the_wait_runs_to_the_latest_spent_lane() {
        let mut conn = database();
        let one = password_lanes("a@example.test", "203.0.113.1".parse().ok());
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO rate_limit_windows VALUES (?1, ?2, 100, ?3)",
            params![ACCOUNT, "a@example.test", stamp(50 * MINUTE_MS)],
        )
        .unwrap();
        tx.commit().unwrap();
        assert_eq!(attempt(&mut conn, 0, &one), Some(50 * MINUTE_MS));
    }

    #[test]
    fn addresses_share_a_count_only_where_they_should() {
        let v6 = |text: &str| bucket(text.parse().ok());
        assert_eq!(v6("2001:db8:1:2:3::1"), v6("2001:db8:1:2:ffff::9"));
        assert_ne!(v6("2001:db8:1:2::1"), v6("2001:db8:1:3::1"));
        assert_eq!(v6("::ffff:203.0.113.1"), v6("203.0.113.1"));
        assert_eq!(bucket(None), NO_ADDRESS);
    }

    #[test]
    fn a_cleared_account_loses_only_its_own_counts() {
        let mut conn = database();
        let mine = password_lanes("a@example.test", None);
        let other = password_lanes("aa@example.test", None);
        attempt(&mut conn, 0, &mine);
        attempt(&mut conn, 0, &other);
        let tx = conn.transaction().unwrap();
        clear_account(&tx, "A@example.test").unwrap();
        assert!(read(&tx, &mine[0], 0).unwrap().is_none());
        assert!(read(&tx, &mine[1], 0).unwrap().is_none());
        assert!(read(&tx, &other[0], 0).unwrap().is_some());
    }
}

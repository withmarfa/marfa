use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use rusqlite::Connection;

use crate::error::CoreError;

type Result<T> = std::result::Result<T, CoreError>;

const ATTEMPTS: u32 = 5;
const FIRST_WAIT: Duration = Duration::from_millis(20);
const POLL: Duration = Duration::from_millis(10);

/// Runs `attempt` again from its first read, after a wait that doubles,
/// while it fails `StoreBusy`, and answers its last result. In WAL mode a
/// transaction that read and then writes after another connection committed
/// is refused (`SQLITE_BUSY_SNAPSHOT`) and no wait lets it through: only a
/// new transaction, which reads what that commit left, can. `attempt` must
/// hold no transaction of its caller's, and must be one that may run again.
pub(crate) fn retrying<T>(
    conn: &Mutex<Connection>,
    stop: &AtomicBool,
    mut attempt: impl FnMut() -> Result<T>,
) -> Result<T> {
    let mut wait = FIRST_WAIT;
    let mut tried = 1;
    loop {
        let answer = attempt();
        if !matches!(answer, Err(CoreError::StoreBusy(_))) {
            return answer;
        }
        rolled_back(conn)?;
        if tried == ATTEMPTS {
            return answer;
        }
        crate::clock::wait(stop, wait, POLL);
        crate::catch_up::refuse_if_stopped(stop)?;
        wait *= 2;
        tried += 1;
    }
}

/// A statement refused busy can leave its transaction open, which would
/// hold the stale snapshot into the next attempt.
fn rolled_back(conn: &Mutex<Connection>) -> Result<()> {
    let conn = conn
        .lock()
        .map_err(|_| CoreError::Store("the connection was poisoned by an earlier panic".into()))?;
    if conn.is_autocommit() {
        return Ok(());
    }
    conn.execute_batch("ROLLBACK").map_err(|error| {
        CoreError::Store(format!(
            "a transaction refused as busy could not be rolled back: {error}"
        ))
    })?;
    if conn.is_autocommit() {
        Ok(())
    } else {
        Err(CoreError::Store(
            "a transaction refused as busy is still open after its rollback".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::atomic::Ordering;

    fn stores() -> (tempfile::TempDir, Mutex<Connection>, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let ours = Connection::open(&path).unwrap();
        ours.execute_batch(
            "PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta VALUES ('count', '0');",
        )
        .unwrap();
        ours.busy_timeout(Duration::from_secs(5)).unwrap();
        let other = Connection::open(&path).unwrap();
        (dir, Mutex::new(ours), other)
    }

    /// Reads the count, lets `between` write as another program, then
    /// writes the count it read plus one, as a read-then-write does.
    fn add_one(conn: &Mutex<Connection>, between: impl FnOnce()) -> Result<()> {
        let mut conn = conn.lock().unwrap();
        let tx = conn.transaction()?;
        let count: i64 = tx.query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'count'",
            [],
            |row| row.get(0),
        )?;
        between();
        tx.execute(
            "UPDATE meta SET value = ?1 WHERE key = 'count'",
            [(count + 1).to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn outside_write(other: &Connection, count: &str) {
        other
            .execute("UPDATE meta SET value = ?1 WHERE key = 'count'", [count])
            .unwrap();
    }

    fn count(conn: &Mutex<Connection>) -> String {
        conn.lock()
            .unwrap()
            .query_row("SELECT value FROM meta WHERE key = 'count'", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[test]
    fn a_write_after_another_programs_commit_is_refused_busy_and_rolled_back() {
        let (_dir, ours, other) = stores();
        let refused = add_one(&ours, || outside_write(&other, "10"));
        assert!(
            matches!(&refused, Err(CoreError::StoreBusy(message)) if message.contains("locked")),
            "{refused:?}"
        );
        assert_eq!(CoreError::StoreBusy(String::new()).code(), "store_busy");
        assert!(ours.lock().unwrap().is_autocommit());
    }

    #[test]
    fn a_busy_transaction_is_made_again_from_what_the_other_write_left() {
        let (_dir, ours, other) = stores();
        let tries = Cell::new(0);
        retrying(&ours, &AtomicBool::new(false), || {
            tries.set(tries.get() + 1);
            add_one(&ours, || {
                if tries.get() == 1 {
                    outside_write(&other, "10");
                }
            })
        })
        .unwrap();
        assert_eq!(tries.get(), 2);
        assert_eq!(count(&ours), "11");
    }

    #[test]
    fn a_transaction_busy_at_every_attempt_answers_store_busy_after_the_last() {
        let (_dir, ours, other) = stores();
        let tries = Cell::new(0);
        let answer = retrying(&ours, &AtomicBool::new(false), || {
            tries.set(tries.get() + 1);
            add_one(&ours, || outside_write(&other, &tries.get().to_string()))
        });
        assert!(matches!(answer, Err(CoreError::StoreBusy(_))), "{answer:?}");
        assert_eq!(tries.get(), ATTEMPTS);
        assert_eq!(count(&ours), ATTEMPTS.to_string());
        assert!(ours.lock().unwrap().is_autocommit());
    }

    #[test]
    fn a_transaction_left_open_by_a_busy_attempt_is_rolled_back_before_the_next() {
        let (_dir, ours, other) = stores();
        let tries = Cell::new(0);
        retrying(&ours, &AtomicBool::new(false), || {
            tries.set(tries.get() + 1);
            let conn = ours.lock().unwrap();
            conn.execute_batch("BEGIN")?;
            let _: String =
                conn.query_row("SELECT value FROM meta WHERE key = 'count'", [], |row| {
                    row.get(0)
                })?;
            if tries.get() == 1 {
                outside_write(&other, "10");
            }
            conn.execute("UPDATE meta SET value = 'mine' WHERE key = 'count'", [])?;
            conn.execute_batch("COMMIT")?;
            Ok(())
        })
        .unwrap();
        assert_eq!(tries.get(), 2);
        assert_eq!(count(&ours), "mine");
    }

    #[test]
    fn a_stop_during_the_wait_ends_the_retries_canceled() {
        let (_dir, ours, other) = stores();
        let stop = AtomicBool::new(false);
        let tries = Cell::new(0);
        let answer = retrying(&ours, &stop, || {
            tries.set(tries.get() + 1);
            stop.store(true, Ordering::SeqCst);
            add_one(&ours, || outside_write(&other, "10"))
        });
        assert!(matches!(answer, Err(CoreError::Canceled)), "{answer:?}");
        assert_eq!(tries.get(), 1);
    }

    #[test]
    fn a_refusal_that_is_not_busy_is_answered_at_once() {
        let (_dir, ours, _other) = stores();
        let tries = Cell::new(0);
        let answer: Result<()> = retrying(&ours, &AtomicBool::new(false), || {
            tries.set(tries.get() + 1);
            Err(CoreError::Store("file is not a database".into()))
        });
        assert!(matches!(answer, Err(CoreError::Store(_))), "{answer:?}");
        assert_eq!(tries.get(), 1);
    }
}

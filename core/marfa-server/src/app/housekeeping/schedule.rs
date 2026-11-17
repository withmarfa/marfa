//! Deciding takes the rows and the time and touches nothing, so that a moved clock, a changed
//! interval and an unreadable row are all one question.

use rusqlite::{OptionalExtension, Row as Sql, Transaction, params};

use super::super::clock::Stamp;
use super::super::refusal::Result;

#[derive(Clone, Debug)]
pub struct Row {
    pub name: String,
    pub next_run_at: String,
    pub wake_requested: bool,
    pub running_since: Option<String>,
    pub last_started_at: Option<String>,
    pub last_finished_at: Option<String>,
    pub last_outcome: Option<String>,
    pub last_error: Option<String>,
    pub last_result: Option<String>,
}

fn row_of(row: &Sql<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        name: row.get(0)?,
        next_run_at: row.get(1)?,
        wake_requested: row.get(2)?,
        running_since: row.get(3)?,
        last_started_at: row.get(4)?,
        last_finished_at: row.get(5)?,
        last_outcome: row.get(6)?,
        last_error: row.get(7)?,
        last_result: row.get(8)?,
    })
}

pub fn rows(tx: &Transaction<'_>) -> Result<Vec<Row>> {
    let mut statement = tx.prepare_cached(
        "SELECT name, next_run_at, wake_requested, running_since, last_started_at, \
         last_finished_at, last_outcome, last_error, last_result FROM housekeeping_jobs",
    )?;
    Ok(statement
        .query_map([], row_of)?
        .collect::<rusqlite::Result<_>>()?)
}

/// What the scheduler's decisions read: when each idle job is next due or asked to run soon, and
/// which jobs run. A running job's `next_run_at` and wake are left out, since a write inside the
/// run moves them and its finish settles them.
pub fn signature(conn: &rusqlite::Connection) -> rusqlite::Result<String> {
    conn.prepare_cached(
        "SELECT coalesce(group_concat(name || ' ' || \
         CASE WHEN running_since IS NULL THEN next_run_at || ' ' || wake_requested ELSE 'running' END, \
         char(10)), '') \
         FROM (SELECT name, running_since, next_run_at, wake_requested FROM housekeeping_jobs \
         ORDER BY name)",
    )?
    .query_row([], |row| row.get(0))
}

/// The milliseconds until the earliest idle job is due, `None` when none will be.
pub fn next_due(rows: &[Row], wanted: &[Wanted], now_ms: i64) -> Option<i64> {
    wanted
        .iter()
        .filter_map(|job| rows.iter().find(|row| row.name == job.name))
        .filter(|row| row.running_since.is_none())
        .filter_map(|row| parsed_ms(&row.next_run_at))
        .map(|next| next.saturating_sub(now_ms).max(0))
        .min()
}

fn parsed_ms(text: &str) -> Option<i64> {
    Stamp::parsed(text).map(Stamp::ms)
}

pub fn readable(text: &str) -> bool {
    Stamp::parsed(text).is_some()
}

/// How long a request to run soon waits, so that a burst of writes makes one run.
const WAKE_DELAY_MS: i64 = 5_000;

#[derive(Clone, Debug)]
pub struct Wanted {
    pub name: &'static str,
    pub interval_ms: i64,
    pub first_run_ms: i64,
    pub wakes_on_files: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Enter {
        name: &'static str,
        next_ms: i64,
        wakes_on_files: bool,
    },
    Bring {
        name: &'static str,
        next_ms: i64,
    },
    /// Answers a request to run soon: the job runs no later than `next_ms`.
    Wake {
        name: &'static str,
        next_ms: i64,
    },
    Claim {
        name: &'static str,
        seen: String,
    },
}

/// `next_run_at` only moves earlier; each due job is one claim however many intervals passed.
pub fn plan(rows: &[Row], wanted: &[Wanted], now_ms: i64) -> Vec<Step> {
    let mut steps = Vec::new();
    for job in wanted {
        let name = job.name;
        let Some(row) = rows.iter().find(|row| row.name == name) else {
            let next_ms = now_ms.saturating_add(job.first_run_ms.min(job.interval_ms));
            steps.push(Step::Enter {
                name,
                next_ms,
                wakes_on_files: job.wakes_on_files,
            });
            continue;
        };
        let Some(next) = parsed_ms(&row.next_run_at) else {
            tracing::warn!(
                job = name,
                "A housekeeping schedule does not read; it runs now"
            );
            steps.push(Step::Bring {
                name,
                next_ms: now_ms,
            });
            continue;
        };
        let latest = now_ms.saturating_add(job.interval_ms);
        if next > latest {
            steps.push(Step::Bring {
                name,
                next_ms: latest,
            });
        } else if next <= now_ms && row.running_since.is_none() {
            steps.push(Step::Claim {
                name,
                seen: row.next_run_at.clone(),
            });
        } else if row.wake_requested && row.running_since.is_none() {
            steps.push(Step::Wake {
                name,
                next_ms: now_ms.saturating_add(WAKE_DELAY_MS),
            });
        }
    }
    steps
}

/// `seen` makes the claim hold only while the row is due as the scheduler read it.
pub fn claim(tx: &Transaction<'_>, name: &str, seen: Option<&str>, at: &str) -> Result<bool> {
    let changed = tx.execute(
        "UPDATE housekeeping_jobs SET running_since = ?2, last_started_at = ?2, wake_requested = 0 \
         WHERE name = ?1 AND running_since IS NULL AND (?3 IS NULL OR next_run_at = ?3)",
        params![name, at, seen],
    )?;
    Ok(changed == 1)
}

pub fn apply(
    tx: &Transaction<'_>,
    steps: &[Step],
    started: Option<&str>,
) -> Result<Vec<&'static str>> {
    let mut claimed = Vec::new();
    for step in steps {
        match step {
            Step::Enter {
                name,
                next_ms,
                wakes_on_files,
            } => {
                tx.execute(
                    "INSERT OR IGNORE INTO housekeeping_jobs (name, next_run_at, wakes_on_files) \
                     VALUES (?1, ?2, ?3)",
                    params![name, Stamp::from_ms(*next_ms)?, wakes_on_files],
                )?;
            }
            Step::Wake { name, next_ms } => {
                tx.execute(
                    "UPDATE housekeeping_jobs SET next_run_at = MIN(next_run_at, ?2), \
                     wake_requested = 0 WHERE name = ?1 AND running_since IS NULL",
                    params![name, Stamp::from_ms(*next_ms)?],
                )?;
            }
            Step::Bring { name, next_ms } => {
                tx.execute(
                    "UPDATE housekeeping_jobs SET next_run_at = ?2 WHERE name = ?1",
                    params![name, Stamp::from_ms(*next_ms)?],
                )?;
            }
            Step::Claim { name, seen } => {
                if let Some(started) = started
                    && claim(tx, name, Some(seen), started)?
                {
                    claimed.push(*name);
                }
            }
        }
    }
    Ok(claimed)
}

pub fn clear_unfinished(tx: &Transaction<'_>) -> Result<usize> {
    Ok(tx.execute(
        "UPDATE housekeeping_jobs SET running_since = NULL WHERE running_since IS NOT NULL",
        [],
    )?)
}

/// A run ahead of schedule keeps it; otherwise the next run follows the finish, with no catching up.
fn next_after(held: Option<i64>, started: i64, finished: i64, interval: i64, again: bool) -> i64 {
    if again {
        return finished;
    }
    let scheduled = finished.saturating_add(interval);
    match held {
        Some(held) if held > started => held.min(scheduled),
        _ => scheduled,
    }
}

pub fn bring_forward(tx: &Transaction<'_>, name: &str, at: &str) -> Result<()> {
    tx.prepare_cached(
        "UPDATE housekeeping_jobs SET next_run_at = MIN(next_run_at, ?2), \
         wake_requested = CASE WHEN running_since IS NOT NULL THEN 1 ELSE wake_requested END \
         WHERE name = ?1",
    )?
    .execute(params![name, at])?;
    Ok(())
}

/// Brings forward a job whose last run was held.
pub fn bring_forward_held(tx: &Transaction<'_>, name: &str, at: &str) -> Result<()> {
    tx.prepare_cached(
        "UPDATE housekeeping_jobs SET next_run_at = MIN(next_run_at, ?2) \
         WHERE name = ?1 AND last_outcome = 'held'",
    )?
    .execute(params![name, at])?;
    Ok(())
}

#[derive(Debug)]
pub struct Finish<'a> {
    pub name: &'a str,
    pub started_at: &'a str,
    pub finished_at: &'a str,
    pub interval_ms: i64,
    pub again: bool,
    pub outcome: &'a str,
    pub error: Option<&'a str>,
    pub result: Option<&'a str>,
}

pub fn finish(tx: &Transaction<'_>, run: &Finish<'_>) -> Result<()> {
    let held: Option<(String, bool)> = tx
        .query_row(
            "SELECT next_run_at, wake_requested FROM housekeeping_jobs WHERE name = ?1",
            [run.name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let finished = Stamp::read(run.finished_at)?.ms();
    let next = next_after(
        held.as_ref().and_then(|(at, _)| parsed_ms(at)),
        Stamp::read(run.started_at)?.ms(),
        finished,
        run.interval_ms,
        run.again || held.is_some_and(|(_, requested)| requested),
    );
    tx.execute(
        "UPDATE housekeeping_jobs SET next_run_at = ?2, running_since = NULL, wake_requested = 0, \
         last_finished_at = ?3, last_outcome = ?4, last_error = ?5, last_result = ?6 \
         WHERE name = ?1",
        params![
            run.name,
            Stamp::from_ms(next)?,
            run.finished_at,
            run.outcome,
            run.error,
            run.result
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: i64) -> String {
        Stamp::from_ms(ms).unwrap().text()
    }

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn a_wake_during_a_claimed_run_survives_its_finish() {
        for offset in [0, 1] {
            let mut db = rusqlite::Connection::open_in_memory().unwrap();
            db.execute_batch(include_str!("../../db/migrations/0001_baseline.sql"))
                .unwrap();
            let tx = db.transaction().unwrap();
            apply(
                &tx,
                &[Step::Enter {
                    name: "job",
                    next_ms: NOW,
                    wakes_on_files: false,
                }],
                None,
            )
            .unwrap();
            assert!(claim(&tx, "job", None, &at(NOW)).unwrap());
            bring_forward(&tx, "job", &at(NOW + offset)).unwrap();
            let end = Finish {
                name: "job",
                started_at: &at(NOW),
                finished_at: &at(NOW + 10),
                interval_ms: 60_000,
                again: false,
                outcome: "succeeded",
                error: None,
                result: None,
            };
            finish(&tx, &end).unwrap();
            assert!(matches!(
                plan(&rows(&tx).unwrap(), &[JOB], NOW + 10).as_slice(),
                [Step::Claim { .. }]
            ));
            assert!(claim(&tx, "job", None, &at(NOW + 10)).unwrap());
            finish(
                &tx,
                &Finish {
                    started_at: &at(NOW + 10),
                    finished_at: &at(NOW + 20),
                    ..end
                },
            )
            .unwrap();
            assert!(plan(&rows(&tx).unwrap(), &[JOB], NOW + 20).is_empty());
        }
    }

    fn row(name: &str, next: &str, running: bool) -> Row {
        Row {
            name: name.to_string(),
            next_run_at: next.to_string(),
            wake_requested: false,
            running_since: running.then(|| at(NOW)),
            last_started_at: None,
            last_finished_at: None,
            last_outcome: None,
            last_error: None,
            last_result: None,
        }
    }

    const JOB: Wanted = Wanted {
        name: "job",
        interval_ms: 60_000,
        first_run_ms: 5_000,
        wakes_on_files: false,
    };

    fn planned(row: Row) -> Vec<Step> {
        plan(&[row], &[JOB], NOW)
    }

    #[test]
    fn a_new_job_comes_after_its_first_delay_inside_its_interval() {
        let at = |first_run_ms, interval_ms| {
            let job = Wanted {
                name: "job",
                interval_ms,
                first_run_ms,
                wakes_on_files: false,
            };
            plan(&[], &[job], NOW)
        };
        assert_eq!(
            at(5_000, 60_000),
            [Step::Enter {
                name: "job",
                next_ms: NOW + 5_000,
                wakes_on_files: false
            }]
        );
        assert_eq!(
            at(5_000, 1_000),
            [Step::Enter {
                name: "job",
                next_ms: NOW + 1_000,
                wakes_on_files: false
            }]
        );
    }

    #[test]
    fn a_job_due_long_ago_is_one_claim() {
        let seen = at(NOW - 400 * 86_400_000);
        assert_eq!(
            planned(row("job", &seen, false)),
            [Step::Claim { name: "job", seen }]
        );
    }

    #[test]
    fn a_due_job_that_is_running_is_left() {
        assert!(planned(row("job", &at(NOW), true)).is_empty());
    }

    #[test]
    fn a_job_not_yet_due_is_left() {
        assert!(planned(row("job", &at(NOW + 1), false)).is_empty());
        assert!(planned(row("job", &at(NOW + 60_000), false)).is_empty());
    }

    #[test]
    fn a_request_to_run_soon_moves_an_idle_job_forward_on_the_given_clock() {
        let asked = |next: i64, running: bool| Row {
            wake_requested: true,
            ..row("job", &at(next), running)
        };
        assert_eq!(
            planned(asked(NOW + 30_000, false)),
            [Step::Wake {
                name: "job",
                next_ms: NOW + WAKE_DELAY_MS
            }]
        );
        assert!(planned(asked(NOW + 30_000, true)).is_empty());
        assert!(matches!(
            planned(asked(NOW, false)).as_slice(),
            [Step::Claim { .. }]
        ));
    }

    #[test]
    fn a_request_to_run_soon_never_delays_a_job_and_is_answered_once() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../../db/migrations/0001_baseline.sql"))
            .unwrap();
        let tx = db.transaction().unwrap();
        let wanted = Wanted {
            wakes_on_files: true,
            ..JOB
        };
        let enter = Step::Enter {
            name: "job",
            next_ms: NOW + 1_000,
            wakes_on_files: true,
        };
        apply(&tx, &[enter], None).unwrap();
        tx.execute("UPDATE housekeeping_jobs SET wake_requested = 1", [])
            .unwrap();
        let steps = plan(&rows(&tx).unwrap(), std::slice::from_ref(&wanted), NOW);
        apply(&tx, &steps, None).unwrap();
        let held = rows(&tx).unwrap();
        assert_eq!(held[0].next_run_at, at(NOW + 1_000));
        assert!(!held[0].wake_requested);
        assert!(plan(&held, &[wanted], NOW).is_empty());
    }

    #[test]
    fn a_change_to_a_file_s_record_asks_only_the_jobs_that_read_files() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../../db/migrations/0001_baseline.sql"))
            .unwrap();
        db.pragma_update(None, "foreign_keys", false).unwrap();
        for (name, wakes) in [("reader", 1), ("other", 0)] {
            db.execute(
                "INSERT INTO housekeeping_jobs (name, next_run_at, wakes_on_files) \
                 VALUES (?1, ?2, ?3)",
                params![name, at(NOW + 30_000), wakes],
            )
            .unwrap();
        }
        let asked = |db: &rusqlite::Connection| -> Vec<String> {
            let mut names = db
                .prepare("SELECT name FROM housekeeping_jobs WHERE wake_requested = 1")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<String>>>()
                .unwrap();
            names.sort();
            names
        };
        assert!(asked(&db).is_empty());
        db.execute(
            "INSERT INTO enrichment_files (item_seq, hash, state, reason, updated_at) \
             VALUES (1, 'h', 'skipped', 'missing', ?1)",
            [at(NOW)],
        )
        .unwrap();
        assert!(asked(&db).is_empty());
        db.execute(
            "INSERT INTO blob_copies (hash, store_id, written, recorded_at) \
             VALUES ('h', 's', 1, ?1)",
            [at(NOW)],
        )
        .unwrap();
        assert_eq!(asked(&db), ["reader"]);
    }

    #[test]
    fn a_shortened_interval_brings_the_next_run_in() {
        assert_eq!(
            planned(row("job", &at(NOW + 60_001), false)),
            [Step::Bring {
                name: "job",
                next_ms: NOW + 60_000
            }]
        );
    }

    #[test]
    fn a_next_run_that_does_not_read_is_due_now() {
        assert_eq!(
            planned(row("job", "not a date", false)),
            [Step::Bring {
                name: "job",
                next_ms: NOW
            }]
        );
    }

    #[test]
    fn a_row_of_a_job_this_build_lacks_is_left() {
        assert!(plan(&[row("gone", "not a date", false)], &[], NOW).is_empty());
    }

    #[test]
    fn the_next_look_is_at_the_earliest_idle_job() {
        let rows = [
            row("job", &at(NOW + 9_000), false),
            row("other", &at(NOW + 4_000), false),
            row("busy", &at(NOW - 1), true),
        ];
        let wanted = |name| Wanted { name, ..JOB };
        let all = [wanted("job"), wanted("other"), wanted("busy")];
        assert_eq!(next_due(&rows, &all, NOW), Some(4_000));
        assert_eq!(next_due(&rows, &all[..1], NOW), Some(9_000));
        assert_eq!(next_due(&rows, &all[2..], NOW), None);
        assert_eq!(next_due(&[], &all, NOW), None);
        assert_eq!(next_due(&rows[..1], &all, NOW + 20_000), Some(0));
        assert_eq!(
            next_due(&[row("job", "not a date", false)], &all, NOW),
            None
        );
    }

    #[test]
    fn the_signature_moves_with_an_idle_schedule_and_not_with_a_running_job_s() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../../db/migrations/0001_baseline.sql"))
            .unwrap();
        assert_eq!(signature(&db).unwrap(), "");
        db.execute(
            "INSERT INTO housekeeping_jobs (name, next_run_at) VALUES ('job', ?1)",
            [at(NOW)],
        )
        .unwrap();
        let idle = signature(&db).unwrap();
        db.execute(
            "UPDATE housekeeping_jobs SET next_run_at = ?1 WHERE name = 'job'",
            [at(NOW + 1)],
        )
        .unwrap();
        assert_ne!(signature(&db).unwrap(), idle);
        db.execute(
            "UPDATE housekeeping_jobs SET running_since = ?1 WHERE name = 'job'",
            [at(NOW)],
        )
        .unwrap();
        let running = signature(&db).unwrap();
        db.execute(
            "UPDATE housekeeping_jobs SET next_run_at = ?1 WHERE name = 'job'",
            [at(NOW + 5_000)],
        )
        .unwrap();
        assert_eq!(signature(&db).unwrap(), running);
    }

    #[test]
    fn a_run_ahead_of_schedule_leaves_the_schedule() {
        let started = NOW;
        let finished = NOW + 10;
        assert_eq!(
            next_after(Some(NOW + 500), started, finished, 60_000, false),
            NOW + 500
        );
        assert_eq!(
            next_after(Some(NOW + 90_000), started, finished, 60_000, false),
            finished + 60_000
        );
    }

    #[test]
    fn a_run_on_schedule_sets_the_next_from_its_finish() {
        let finished = NOW + 200_000;
        assert_eq!(
            next_after(Some(NOW), NOW, finished, 60_000, false),
            finished + 60_000
        );
        assert_eq!(
            next_after(None, NOW, finished, 60_000, false),
            finished + 60_000
        );
    }

    #[test]
    fn a_run_with_work_left_is_due_at_its_finish() {
        assert_eq!(
            next_after(Some(NOW + 9), NOW, NOW + 3, 60_000, true),
            NOW + 3
        );
    }
}

//! The latest report of each folder copy, kept by sign-in, and the status they add up to.

use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::FOLDER_TYPE;
use super::inventory::shown;
use super::report::{MOST, Report};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::faults::{FAIL_FOLDER_STATUS_REPORT, HOLD_FOLDER_STATUS_READ};
use crate::app::items::{parsed, readable_of, reading};
use crate::app::keys;
use crate::app::oauth::grants;
use crate::app::oauth::store::ms_of;
use crate::app::refusal::{Code, Refusal, Result};

const ACTION: &str = "folder.status";

struct Copy {
    folder_store_id: String,
    sequence: i64,
    received_at: String,
    last_success_at: Option<String>,
    pending_uploads: i64,
    pending_downloads: i64,
    paused_removals: i64,
    first_sync_waiting: bool,
    problems: Vec<(String, i64)>,
}

struct Stored {
    kind: String,
    id: String,
    name: String,
    copy: Copy,
}

fn problems_of(text: &str) -> Result<Vec<(String, i64)>> {
    let unread = || Refusal::internal("a stored folder report's problems do not read");
    let listed: Vec<Value> = serde_json::from_str(text).map_err(|_| unread())?;
    listed
        .iter()
        .map(|problem| {
            let code = problem.get("code").and_then(Value::as_str);
            let count = problem.get("count").and_then(Value::as_i64);
            code.zip(count)
                .map(|(code, count)| (code.to_string(), count))
                .ok_or_else(unread)
        })
        .collect()
}

fn problems_json(problems: &[(String, i64)]) -> Value {
    Value::Array(
        problems
            .iter()
            .map(|(code, count)| json!({ "code": code, "count": count }))
            .collect(),
    )
}

/// A repeated or older sequence preserves the receipt time too.
pub async fn report(
    app: &App,
    caller: &Caller,
    folder_id: String,
    report: Report,
) -> Result<String> {
    let faults = app.faults.clone();
    app.write(caller, ACTION, move |unit| {
        let tx = unit.tx();
        unit.caller.require_reach()?;
        readable_of(tx, &unit.caller, &folder_id, FOLDER_TYPE)?;
        let by = match unit.caller.writer() {
            Some(by) if by.kind != "local" => by,
            _ => {
                return Err(Refusal::new(
                    Code::Forbidden,
                    "A local command has no sign-in to report under.",
                ));
            }
        };
        let held: Option<(i64, String)> = tx
            .query_row(
                "SELECT sequence, received_at FROM folder_status WHERE folder_id = ?1 \
                 AND sign_in_kind = ?2 AND sign_in_id = ?3 AND folder_store_id = ?4",
                params![folder_id, by.kind, by.id, report.folder_store_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (accepted, sequence, received_at) = match held {
            Some((sequence, received_at)) if report.sequence <= sequence => {
                (false, sequence, received_at)
            }
            _ => {
                let problems: Vec<(String, i64)> = report
                    .problems
                    .iter()
                    .map(|(code, count)| ((*code).to_string(), *count))
                    .collect();
                tx.execute(
                    "INSERT INTO folder_status (folder_id, sign_in_kind, sign_in_id, \
                     sign_in_name, folder_store_id, sequence, received_at, last_success_at, \
                     pending_uploads, pending_downloads, paused_removals, first_sync_waiting, \
                     problems) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
                     ON CONFLICT (folder_id, sign_in_kind, sign_in_id, folder_store_id) \
                     DO UPDATE SET sign_in_name = ?4, sequence = ?6, received_at = ?7, \
                     last_success_at = ?8, pending_uploads = ?9, pending_downloads = ?10, \
                     paused_removals = ?11, first_sync_waiting = ?12, problems = ?13",
                    params![
                        folder_id,
                        by.kind,
                        by.id,
                        by.name,
                        report.folder_store_id,
                        report.sequence,
                        unit.at,
                        report.last_success_at,
                        report.pending_uploads,
                        report.pending_downloads,
                        report.paused_removals,
                        report.first_sync_waiting,
                        problems_json(&problems).to_string(),
                    ],
                )?;
                if faults.fail(FAIL_FOLDER_STATUS_REPORT, None) {
                    return Err(Refusal::internal("a folder status report was made to fail"));
                }
                (true, report.sequence, unit.at.clone())
            }
        };
        Ok(json!({
            "accepted": accepted,
            "sequence": sequence,
            "received_at": received_at,
        })
        .to_string())
    })
    .await
}

fn stored_rows(tx: &Transaction<'_>, folder_id: &str) -> Result<Vec<Stored>> {
    let mut statement = tx.prepare_cached(
        "SELECT sign_in_kind, sign_in_id, sign_in_name, folder_store_id, sequence, received_at, \
         last_success_at, pending_uploads, pending_downloads, paused_removals, \
         first_sync_waiting, problems FROM folder_status WHERE folder_id = ?1 \
         ORDER BY sign_in_kind, sign_in_id, received_at DESC, folder_store_id",
    )?;
    let found = statement.query_map([folder_id], |row| {
        Ok((
            Stored {
                kind: row.get(0)?,
                id: row.get(1)?,
                name: row.get(2)?,
                copy: Copy {
                    folder_store_id: row.get(3)?,
                    sequence: row.get(4)?,
                    received_at: row.get(5)?,
                    last_success_at: row.get(6)?,
                    pending_uploads: row.get(7)?,
                    pending_downloads: row.get(8)?,
                    paused_removals: row.get(9)?,
                    first_sync_waiting: row.get(10)?,
                    problems: Vec::new(),
                },
            },
            row.get::<_, String>(11)?,
        ))
    })?;
    let mut stored = Vec::new();
    for found in found {
        let (mut row, problems) = found?;
        row.copy.problems = problems_of(&problems)?;
        stored.push(row);
    }
    Ok(stored)
}

/// Whether the sign-in a report came from still stands.
fn stands(tx: &Transaction<'_>, kind: &str, id: &str, at: &str) -> Result<bool> {
    match kind {
        "key" => keys::stands(tx, id, at),
        "app" => Ok(grants::of_owner(tx, id)?.is_some()),
        _ => Err(Refusal::internal(
            "a stored folder report names an unknown sign-in kind",
        )),
    }
}

#[derive(Default)]
struct Totals {
    pending_uploads: i64,
    pending_downloads: i64,
    paused_removals: i64,
    first_sync_waiting: i64,
    problems: Vec<(String, i64)>,
    saturated: bool,
}

impl Totals {
    fn add(&mut self, total: fn(&mut Totals) -> &mut i64, count: i64) {
        let sum = (*total(self)).saturating_add(count);
        *total(self) = sum.min(MOST);
        self.saturated |= sum > MOST;
    }

    fn take(&mut self, copy: &Copy) {
        self.add(|t| &mut t.pending_uploads, copy.pending_uploads);
        self.add(|t| &mut t.pending_downloads, copy.pending_downloads);
        self.add(|t| &mut t.paused_removals, copy.paused_removals);
        self.add(
            |t| &mut t.first_sync_waiting,
            i64::from(copy.first_sync_waiting),
        );
        for (code, count) in &copy.problems {
            let at = match self.problems.iter().position(|(held, _)| held == code) {
                Some(at) => at,
                None => {
                    self.problems.push((code.clone(), 0));
                    self.problems.len() - 1
                }
            };
            let sum = self.problems[at].1.saturating_add(*count);
            self.problems[at].1 = sum.min(MOST);
            self.saturated |= sum > MOST;
        }
    }
}

fn copy_json(copy: &Copy, at_ms: i64) -> Result<Value> {
    let age = (at_ms - ms_of(&copy.received_at)?).max(0) / 1_000;
    Ok(json!({
        "folder_store_id": copy.folder_store_id,
        "sequence": copy.sequence,
        "last_success_at": copy.last_success_at,
        "pending_uploads": copy.pending_uploads,
        "pending_downloads": copy.pending_downloads,
        "paused_removals": copy.paused_removals,
        "first_sync_waiting": copy.first_sync_waiting,
        "problems": problems_json(&copy.problems),
        "received_at": copy.received_at,
        "age_seconds": age,
    }))
}

/// Each sign-in's copies, and the totals of the sign-ins that still stand.
fn gathered(tx: &Transaction<'_>, folder_id: &str, at: &str) -> Result<(Vec<Value>, Totals)> {
    let at_ms = ms_of(at)?;
    let mut totals = Totals::default();
    let mut groups: Vec<Value> = Vec::new();
    let mut at_group: Option<(String, String, bool)> = None;
    let mut copies: Vec<Value> = Vec::new();
    let mut named = (String::new(), String::new(), String::new());
    let mut close =
        |group: &Option<(String, String, bool)>, name: &str, copies: &mut Vec<Value>| {
            if let Some((kind, id, current)) = group {
                groups.push(json!({
                    "sign_in": { "kind": kind, "id": id, "name": name },
                    "current": current,
                    "copies": std::mem::take(copies),
                }));
            }
        };
    for row in stored_rows(tx, folder_id)? {
        let same = at_group
            .as_ref()
            .is_some_and(|(kind, id, _)| *kind == row.kind && *id == row.id);
        if !same {
            close(&at_group, &named.2, &mut copies);
            let current = stands(tx, &row.kind, &row.id, at)?;
            at_group = Some((row.kind.clone(), row.id.clone(), current));
            named = (row.kind.clone(), row.id.clone(), row.name.clone());
        }
        if at_group.as_ref().is_some_and(|(_, _, current)| *current) {
            totals.take(&row.copy);
        }
        copies.push(copy_json(&row.copy, at_ms)?);
    }
    close(&at_group, &named.2, &mut copies);
    Ok((groups, totals))
}

fn status_of(tx: &Transaction<'_>, folder_id: &str, at: &str) -> Result<String> {
    let (groups, totals) = gathered(tx, folder_id, at)?;
    Ok(json!({
        "folder_id": folder_id,
        "sign_ins": groups,
        "totals": {
            "saturated": totals.saturated,
            "pending_uploads": totals.pending_uploads,
            "pending_downloads": totals.pending_downloads,
            "paused_removals": totals.paused_removals,
            "first_sync_waiting": totals.first_sync_waiting,
            "problems": problems_json(&totals.problems),
        },
    })
    .to_string())
}

pub async fn read(app: &App, caller: &Caller, folder_id: String) -> Result<String> {
    app.faults.hold(HOLD_FOLDER_STATUS_READ, None).await;
    let at = app.clock.stamp();
    reading(app, caller, move |read| {
        read.caller.require_reach()?;
        readable_of(read.tx, &read.caller, &folder_id, FOLDER_TYPE)?;
        status_of(read.tx, &folder_id, &at)
    })
    .await
}

/// An active folder whose standing sign-ins report something to look at.
pub struct Concern {
    pub id: String,
    pub title: String,
    pub problems: i64,
    pub paused_removals: i64,
    pub first_sync_waiting: bool,
}

/// Every active folder with a report that needs a look, in one snapshot.
pub fn concerns(tx: &Transaction<'_>, at: &str) -> Result<Vec<Concern>> {
    let mut statement = tx.prepare_cached(
        "SELECT i.id, json(i.properties) FROM items i WHERE i.type = ?1 AND i.state = 'active' \
         AND EXISTS (SELECT 1 FROM folder_status s WHERE s.folder_id = i.id) \
         ORDER BY i.created_at DESC, i.id DESC",
    )?;
    let folders = statement
        .query_map([FOLDER_TYPE], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut found = Vec::new();
    for (id, properties) in folders {
        let (_, totals) = gathered(tx, &id, at)?;
        let problems = totals
            .problems
            .iter()
            .fold(0_i64, |sum, (_, count)| sum.saturating_add(*count));
        if problems == 0 && totals.paused_removals == 0 && totals.first_sync_waiting == 0 {
            continue;
        }
        let properties = parsed(&properties)?;
        found.push(Concern {
            title: shown(properties.get("title").and_then(Value::as_str)),
            id,
            problems,
            paused_removals: totals.paused_removals,
            first_sync_waiting: totals.first_sync_waiting > 0,
        });
    }
    Ok(found)
}

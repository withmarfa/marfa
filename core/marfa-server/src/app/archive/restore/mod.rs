//! `POST /restore`: reads and checks the body as it arrives, then one write records everything or nothing.

pub mod intake;
pub mod named;
mod untar;

use std::collections::{BTreeMap, HashSet};
use std::io::{BufRead, BufReader};
use std::sync::Arc;

use bytes::Bytes;
use flate2::read::GzDecoder;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::checks;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::blobs::Scratch;
use crate::app::blobs::restore as blobs;
use crate::app::catalog::{self, Snapshot};
use crate::app::edges::write::Writing;
use crate::app::faults::{HOLD_RESTORE_COMMIT, HOLD_RESTORE_ITEM};
use crate::app::items::restored::{self, Restored};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::{connectors, edge_types, sources, stored, tables, types};
use intake::{Intake, Received};

/// What every answer says of what an archive does not hold.
pub const SET_UP_AGAIN: &str =
    "An archive holds no sign-in, keys, apps or webhooks. Set them up again on this instance.";
const QUEUED: usize = 8;
const SETTLE_EVERY: usize = 1000;

pub(crate) fn conflicting(ids: Vec<String>) -> Refusal {
    Refusal::new(
        Code::Conflict,
        format!(
            "The archive registers {} this instance holds differently: {}",
            ids.len(),
            ids.join(", ")
        ),
    )
    .with_detail("conflicting_ids", ids)
}

pub(crate) fn files_missing(lacking: Vec<String>) -> Refusal {
    const SHOWN: usize = 10;
    let mut shown = lacking[..lacking.len().min(SHOWN)].join(", ");
    if lacking.len() > SHOWN {
        shown.push_str(&format!(" and {} more", lacking.len() - SHOWN));
    }
    Refusal::new(
        Code::BackupFilesMissing,
        format!(
            "Nothing was restored: the backup names {} files that neither this instance nor the \
             backup folder holds whole: {shown}. Put them back in the backup folder, or restore \
             the backup's archive file with `marfa restore` to leave them out.",
            lacking.len()
        ),
    )
    .with_detail("missing_blobs", lacking)
}

/// A restore's body arriving: its parts go to a blocking thread that reads them in order.
pub struct Receiving {
    parts: Option<mpsc::Sender<Bytes>>,
    reading: JoinHandle<Result<Received>>,
}

impl Receiving {
    /// Hands on a part of the body; a refusal the reader has made comes back here.
    pub async fn push(&mut self, bytes: Bytes) -> Result<()> {
        let Some(parts) = &self.parts else {
            return Err(Refusal::internal("a restore's body arrived after its end"));
        };
        if parts.send(bytes).await.is_ok() {
            return Ok(());
        }
        self.parts = None;
        match (&mut self.reading).await {
            Ok(Err(refusal)) => Err(refusal),
            Ok(Ok(_)) => Err(Refusal::internal("a restore's reader ended early")),
            Err(error) => Err(Refusal::internal(&format!(
                "a restore's reader stopped: {error}"
            ))),
        }
    }

    /// Gives up on the body, and answers once its spool is gone.
    pub async fn abandon(mut self) {
        self.parts = None;
        let _ = (&mut self.reading).await;
    }

    /// Ends the body and answers what was read.
    pub async fn finish(mut self) -> Result<Received> {
        self.parts = None;
        (&mut self.reading)
            .await
            .map_err(|error| Refusal::internal(&format!("a restore's reader stopped: {error}")))?
    }
}

#[derive(Default)]
struct Counted {
    added: usize,
    skipped: usize,
    reasons: BTreeMap<String, usize>,
}

impl Counted {
    fn skip(&mut self, reason: &str) {
        self.skipped += 1;
        *self.reasons.entry(reason.to_string()).or_default() += 1;
    }
}

fn bits(id: &str) -> Option<u128> {
    uuid::Uuid::parse_str(id).ok().map(|held| held.as_u128())
}

/// Lines of a spooled line file, in order.
fn lines(scratch: &Scratch) -> Result<impl Iterator<Item = Result<Value>>> {
    let file = scratch
        .reopen()
        .map_err(|error| Refusal::internal(&format!("a restore's spool did not open: {error}")))?;
    let mut reader = BufReader::with_capacity(256 * 1024, GzDecoder::new(BufReader::new(file)));
    let mut buffer = Vec::new();
    Ok(std::iter::from_fn(move || {
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) => return None,
                Ok(_) => {
                    let text = buffer.strip_suffix(b"\n").unwrap_or(&buffer);
                    if text.is_empty() {
                        continue;
                    }
                    return Some(serde_json::from_slice(text).map_err(|_| {
                        Refusal::internal("a checked line of a restore's spool does not read")
                    }));
                }
                Err(error) => {
                    return Some(Err(Refusal::internal(&format!(
                        "a restore's spool did not read: {error}"
                    ))));
                }
            }
        }
    }))
}

impl App {
    /// Refuses a declared size the volume has no room for.
    pub async fn begin_restore(&self, declared: Option<u64>) -> Result<Receiving> {
        self.restore_room(declared.unwrap_or(0)).await?;
        let cache = self.catalog_handle();
        let committed = self
            .db
            .read(move |tx| catalog::current(&cache, tx, Snapshot::Committed))
            .await?;
        let spool = self.restore_spool();
        let cap = self.bulk_cap();
        let (parts, mut arriving) = mpsc::channel::<Bytes>(QUEUED);
        let reading = tokio::task::spawn_blocking(move || {
            let mut intake = Intake::new(spool, committed, cap)?;
            while let Some(part) = arriving.blocking_recv() {
                intake.push(&part)?;
            }
            intake.finish()
        });
        Ok(Receiving {
            parts: Some(parts),
            reading,
        })
    }

    /// Writes nothing unless it commits whole. With `whole`, a file the archive names that the
    /// instance held when the archive was written must be found, or nothing is restored.
    pub async fn restore(
        self: &Arc<App>,
        caller: &Caller,
        started_at: String,
        received: Received,
        whole: bool,
    ) -> Result<Value> {
        caller.require_local()?;
        let app = self.clone();
        let caller = caller.clone();
        let task = async move {
            let absent = received.absent();
            let needed: HashSet<String> = if whole {
                received.manifest.held_files()
            } else {
                HashSet::new()
            };
            let Received {
                registrations,
                spools,
                snapshots,
                carried,
                ..
            } = received;
            let placed = app.place_restored(carried, absent).await?;
            let lacking: Vec<String> = placed
                .missing
                .iter()
                .filter(|hash| needed.contains(*hash))
                .cloned()
                .collect();
            if !lacking.is_empty() {
                return Err(files_missing(lacking));
            }
            let copies = placed.copies.clone();
            let replicates = placed.replicates;
            let (imported_blobs, missing) = (placed.imported, placed.missing.clone());
            let cache = app.catalog_handle();
            let faults = app.faults.clone();
            let settings = app.clone();
            let cap = app.bulk_cap();
            let written = app
                .write(&caller, "restore_archive", move |unit| {
                    let began = std::time::Instant::now();
                    unit.caller.require_local()?;
                    unit.caller.require_recent(&started_at)?;
                    unit.fanning(false, |unit| {
                        let tx = unit.tx();
                        let before = catalog::current(&cache, tx, Snapshot::Pending)?;
                        let types_plan = types::write::plan_restored(&before, &registrations.types)?;
                        let edges_plan =
                            edge_types::plan_restored(&before, &registrations.edge_types)?;
                        let conflicts: Vec<String> = types_plan
                            .conflicts
                            .iter()
                            .chain(&edges_plan.conflicts)
                            .cloned()
                            .collect();
                        if !conflicts.is_empty() {
                            return Err(conflicting(conflicts));
                        }
                        let (types_registered, types_skipped) =
                            (types_plan.registered(), types_plan.skipped);
                        let (edge_types_registered, edge_types_skipped) =
                            (edges_plan.registered(), edges_plan.skipped);
                        types::write::write_restored(unit, &cache, &before, types_plan)?;
                        edge_types::write_restored(unit, edges_plan)?;
                        let catalog = catalog::current(&cache, tx, Snapshot::Pending)?;
                        for (type_id, _) in &registrations.icons {
                            if !catalog.holds(type_id) {
                                return Err(Refusal::new(
                                    Code::InvalidSchema,
                                    format!("The archive carries an icon for {type_id}, which neither the archive nor this instance registers."),
                                ));
                            }
                        }
                        let mut icons = Counted::default();
                        let drawn: Vec<(String, String)> = registrations
                            .icons
                            .iter()
                            .filter_map(|(id, icon)| match icon {
                                Some(icon) => Some((id.clone(), icon.clone())),
                                None => {
                                    icons.skip("unknown_icon");
                                    None
                                }
                            })
                            .collect();
                        let (added, held) = types::write::restore_icons(unit, &catalog, &drawn)?;
                        icons.added = added;
                        for _ in 0..held {
                            icons.skip("already_set");
                        }
                        let named = sources::restore(tx, &unit.at, &registrations.sources)?;
                        let (settings_added, settings_skipped) =
                            stored::restore(tx, &settings, &registrations.settings)?;
                        let mut states = Counted::default();
                        for (source, state) in &registrations.states {
                            if connectors::restore_state(tx, source, state, &unit.at)? {
                                states.added += 1;
                            } else {
                                states.skip("already_set");
                            }
                        }
                        blobs::record(tx, &copies, replicates, &unit.caller.credential_handle(), &unit.at)?;
                        let held = restored::held_snapshots(tx, snapshots.each())?;
                        let (mut imported, mut duplicates) = (0usize, 0usize);
                        let mut written: HashSet<u128> = HashSet::new();
                        for (row, line) in lines(&spools[1])?.enumerate() {
                            let line = line?;
                            checks::item(&catalog, cap, &line, row + 1).map_err(|refused| refused.refusal)?;
                            faults.hold_writing(HOLD_RESTORE_ITEM);
                            match restored::restore(unit, &catalog, &line, &held)? {
                                Restored::Written => {
                                    imported += 1;
                                    if let Some(id) = line.pointer("/item/id").and_then(Value::as_str).and_then(bits) {
                                        written.insert(id);
                                    }
                                }
                                Restored::Duplicate => duplicates += 1,
                            }
                            if (row + 1) % SETTLE_EVERY == 0 {
                                restored::settle(tx, &catalog)?;
                            }
                        }
                        restored::settle(tx, &catalog)?;
                        let writing = Writing::of(unit, &catalog, None);
                        let mut edges = Counted::default();
                        for (row, line) in lines(&spools[2])?.enumerate() {
                            let line = line?;
                            if let Err(refused) = checks::edge(&catalog, cap, &line, row + 1, |_| None)
                                && refused.skip.is_none()
                            {
                                return Err(refused.refusal);
                            }
                            match writing.restore(&line)? {
                                None => edges.added += 1,
                                Some(reason) => edges.skip(&reason),
                            }
                        }
                        let mut agreements = Counted::default();
                        for line in lines(&spools[0])? {
                            let line = line?;
                            let Some(agreement) = line.get("connector_agreement") else {
                                continue;
                            };
                            let text = |key: &str| agreement.get(key).and_then(Value::as_str).unwrap_or_default();
                            let record = agreement
                                .get("record")
                                .and_then(Value::as_object)
                                .cloned()
                                .unwrap_or_default();
                            let waiting = agreement.get("waiting").and_then(Value::as_bool).unwrap_or(false);
                            if connectors::restore_agreement(tx, text("source"), text("item_id"), waiting, &record, &unit.at)? {
                                agreements.added += 1;
                            } else {
                                agreements.skip("already_set");
                            }
                        }
                        let mut restoring = tables::archive::Restoring::new(unit, &catalog);
                        for (row, line) in lines(&spools[3])?.enumerate() {
                            let line = line?;
                            let key = checks::row(&line, row + 1).map_err(|refused| refused.refusal)?;
                            let holds = bits(&key.item_id).is_some_and(|id| written.contains(&id));
                            restoring.row(&line, key, holds)?;
                        }
                        let (rows_imported, rows_skipped) = restoring.finish()?;
                        let answer = json!({
                            "imported": imported,
                            "duplicates": duplicates,
                            "edges_imported": edges.added,
                            "edges_skipped": edges.skipped,
                            "edges_skipped_reasons": edges.reasons,
                            "blobs_imported": imported_blobs,
                            "blobs_missing": missing,
                            "types_registered": types_registered,
                            "types_skipped": types_skipped,
                            "edge_types_registered": edge_types_registered,
                            "edge_types_skipped": edge_types_skipped,
                            "type_icons_added": icons.added,
                            "type_icons_skipped": icons.skipped,
                            "type_icons_skipped_reasons": icons.reasons,
                            "sources_added": named.added,
                            "sources_skipped": named.skipped,
                            "sources_skipped_reasons": named.reasons,
                            "settings_added": settings_added,
                            "settings_skipped": settings_skipped,
                            "settings_dropped": registrations.dropped_settings,
                            "connector_states_added": states.added,
                            "connector_states_skipped": states.skipped,
                            "connector_agreements_added": agreements.added,
                            "connector_agreements_skipped": agreements.skipped,
                            "rows_imported": rows_imported,
                            "rows_skipped": rows_skipped,
                        });
                        unit.audit_set("restore_archive", Some(answer.clone()))?;
                        let staged = (settings_added > 0)
                            .then(|| stored::stage(tx, &settings))
                            .transpose()?;
                        faults.hold_writing(HOLD_RESTORE_COMMIT);
                        tracing::info!(
                            held_ms = began.elapsed().as_millis() as u64,
                            imported,
                            edges = edges.added,
                            rows = rows_imported,
                            "A restore wrote its archive"
                        );
                        Ok((answer, staged))
                    })
                })
                .await;
            drop(placed);
            let (mut answer, staged) = written?;
            let emptying = app.clone();
            tokio::spawn(async move { emptying.db.empty_log().await });
            if let Some(staged) = staged {
                staged.publish(&app);
            }
            app.publish_catalog().await;
            answer["set_up_again"] = Value::from(SET_UP_AGAIN);
            Ok(answer)
        };
        tokio::spawn(task)
            .await
            .map_err(|error| Refusal::internal(&format!("a restore did not finish: {error}")))?
    }
}

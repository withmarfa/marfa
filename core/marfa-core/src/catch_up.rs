use std::io::{self, BufReader};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::http::Http;
use crate::model::{CatchUpReport, Tier};
use crate::sse::{Frame, Frames};
use crate::store;
use crate::wire::EventPayload;
use crate::{Core, Result};

const STREAM_HARD_BOUND: Duration = Duration::from_secs(120);
const FIRST_FRAME_WAIT: Duration = Duration::from_secs(15);
// The server budgets its head read at five seconds and only then announces
// the cursor, so the wait between the connect comment and the first event
// has to outlast that budget.
const HEAD_WAIT: Duration = Duration::from_secs(10);
const TYPE_FILTER_LIMIT: usize = 10;

struct Slice {
    types: Vec<String>,
    tier: Tier,
}

pub(crate) fn catch_up(core: &Core, http: &Http, idle: Duration) -> Result<CatchUpReport> {
    let (slice, cursor) = {
        let conn = core.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        let cursor =
            store::meta_get(&conn, store::META_EVENT_CURSOR)?.ok_or(CoreError::NoCursor)?;
        if cursor.is_empty() || !cursor.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(CoreError::Invalid(format!(
                "the stored event cursor {cursor:?} is not an event id"
            )));
        }
        let types: Vec<String> = match store::meta_get(&conn, store::META_SLICE_TYPES)? {
            Some(json) => serde_json::from_str(&json)?,
            None => return Err(CoreError::NoCursor),
        };
        let tier: Tier = store::meta_get(&conn, store::META_SLICE_TIER)?
            .ok_or(CoreError::NoCursor)?
            .parse()?;
        (Slice { types, tier }, cursor)
    };
    let catalog_rows = http.types()?;
    let catalog = {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        store::replace_types(&tx, &catalog_rows)?;
        tx.commit()?;
        Catalog::load(&conn)?
    };

    let filter: &[String] = if slice.types.len() <= TYPE_FILTER_LIMIT {
        &slice.types
    } else {
        &[]
    };
    let reader = http.open_events(Some(&cursor), filter, STREAM_HARD_BOUND)?;
    let (sender, frames) = mpsc::sync_channel::<io::Result<Frame>>(256);
    thread::spawn(move || {
        let mut frames = Frames::new(BufReader::new(reader));
        loop {
            match frames.next_frame() {
                Ok(Some(frame)) => {
                    if sender.send(Ok(frame)).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = sender.send(Err(error));
                    break;
                }
            }
        }
    });

    let mut report = CatchUpReport {
        applied: 0,
        skipped: 0,
        cursor: cursor.clone(),
        reached_head: false,
    };
    let mut head: Option<u64> = None;
    let mut connected = false;
    let mut prologue_seen = false;
    loop {
        let wait = if prologue_seen {
            idle
        } else if connected {
            HEAD_WAIT
        } else {
            FIRST_FRAME_WAIT
        };
        let frame = match frames.recv_timeout(wait) {
            Ok(Ok(frame)) => frame,
            Ok(Err(error)) => match error.kind() {
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock if connected => break,
                _ => return Err(CoreError::Network(error.to_string())),
            },
            Err(RecvTimeoutError::Timeout) if connected => break,
            Err(RecvTimeoutError::Timeout) => {
                return Err(CoreError::Network("the event stream sent nothing".into()));
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        match frame {
            Frame::Comment(_) => connected = true,
            Frame::Event { id, name, data } => {
                connected = true;
                prologue_seen = true;
                let payload: EventPayload = match serde_json::from_str(&data) {
                    Ok(payload) => payload,
                    Err(error) => {
                        return Err(CoreError::Decoding(format!("event {data:?}: {error}")));
                    }
                };
                match name.as_deref().unwrap_or(&payload.r#type) {
                    "stream_cursor" => {
                        head = payload.cursor.as_deref().and_then(|text| text.parse().ok());
                        if let (Some(head), Ok(have)) = (head, report.cursor.parse::<u64>())
                            && head <= have
                        {
                            report.reached_head = true;
                            break;
                        }
                    }
                    "catchup_too_old" => {
                        let conn = core.conn()?;
                        store::meta_delete(&conn, store::META_EVENT_CURSOR)?;
                        return Err(CoreError::CatchUpTooOld {
                            min_retained_id: payload.min_retained_id.unwrap_or_default(),
                        });
                    }
                    "stream_incomplete" => {
                        return Err(CoreError::StreamIncomplete {
                            reason: payload.reason.unwrap_or_default(),
                        });
                    }
                    kind => {
                        let Some(id) = id else { continue };
                        let mut conn = core.conn()?;
                        let tx = conn.transaction()?;
                        let applied = apply(&tx, &catalog, &slice, kind, &payload)?;
                        // The cursor is the last id received, never the highest:
                        // ids are assigned before commit, so a lower id can
                        // arrive after a higher one and would be skipped for
                        // ever by a high-water mark.
                        store::meta_set(&tx, store::META_EVENT_CURSOR, &id)?;
                        tx.commit()?;
                        if applied {
                            report.applied += 1;
                        } else {
                            report.skipped += 1;
                        }
                        report.cursor = id.clone();
                        if let (Some(head), Ok(reached)) = (head, id.parse::<u64>())
                            && reached >= head
                        {
                            report.reached_head = true;
                            break;
                        }
                    }
                }
            }
        }
    }
    Ok(report)
}

fn apply(
    tx: &rusqlite::Connection,
    catalog: &Catalog,
    slice: &Slice,
    kind: &str,
    payload: &EventPayload,
) -> Result<bool> {
    match kind {
        "item.purged" => {
            let Some(item) = &payload.item else {
                return Ok(false);
            };
            store::delete_item(tx, &item.id)
        }
        "item.created" | "item.updated" | "item.deleted" | "item.restored"
        | "item.state_changed" | "metadata.changed" => {
            let Some(item) = &payload.item else {
                return Ok(false);
            };
            let tier = Tier::parse_wire(item.tier.as_deref())?;
            let in_slice = tier == Some(slice.tier)
                && slice
                    .types
                    .iter()
                    .any(|declared| catalog.matches(declared, &item.r#type));
            if in_slice {
                let tags = payload
                    .metadata
                    .as_ref()
                    .map(|metadata| metadata.tags.as_slice());
                store::upsert_item(tx, item, tags, catalog.title_field(&item.r#type))?;
                Ok(true)
            } else {
                store::delete_item(tx, &item.id)
            }
        }
        "edge.created" | "edge.updated" => {
            let Some(edge) = &payload.edge else {
                return Ok(false);
            };
            if store::item_held(tx, &edge.source_id)? {
                store::upsert_edge(tx, edge)?;
                Ok(true)
            } else {
                Ok(false)
            }
        }
        "edge.deleted" => {
            let Some(edge) = &payload.edge else {
                return Ok(false);
            };
            store::delete_edge(tx, &edge.id)
        }
        _ => Ok(false),
    }
}

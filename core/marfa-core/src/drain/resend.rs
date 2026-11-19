//! A write sent before under another credential, judged from what the
//! server holds before it goes again: the server keeps an idempotency key to
//! the credential that sent it (`items/idempotency-credential`), so under
//! this one the same key would run the write afresh.

use std::collections::HashSet;
use std::sync::atomic::AtomicBool;

use marfa_rules::conflict::{changed, same};
use marfa_rules::time::projected;
use rusqlite::Connection;
use serde_json::{Map, Value};

use super::read_back::names_no_row;
use crate::catch_up::ask_unless_stopped;
use crate::error::CoreError;
use crate::http::{Http, INSTANCE_CHANGED};
use crate::model::{QueuedWrite, WriteKind};
use crate::wire::{WireEdge, WireItem};
use crate::{Core, Result, reach, store};

#[derive(Debug)]
pub(super) enum Judged {
    /// The server holds what the write asks for: the subject as read, for a
    /// door whose answer is the subject, and `None` for one whose is not.
    Applied(Option<Value>),
    /// The server holds none of it, or not all of it. Sent again, the
    /// write meets the server's own checks: a version, a merge, a natural
    /// key. With `read`, the subject was found, so the version it was first
    /// sent at can guard it.
    Send { read: bool },
    /// Nothing this credential reads tells whether the write landed, and
    /// sent again it could write twice: the reason, and the status the read
    /// met where it named one.
    Undecided { reason: String, status: Option<u16> },
}

/// Whether what a read shows holds the write.
enum Holds {
    Yes,
    No,
    /// Part of it is hidden from this credential.
    Unknown,
}

/// Whether `row` goes again only once its subject is read: a write sent
/// before under a credential other than `credential`, or under one the copy
/// kept no record of. A create naming its id, or an edge create, is answered
/// for what it made whoever repeats it (`items/create-repeat`,
/// `edges/id-repeat`), and a row write by its own key and values.
pub(super) fn owed(
    conn: &Connection,
    row: &QueuedWrite,
    payload: &Value,
    credential: &str,
) -> Result<bool> {
    let judged = match row.kind {
        WriteKind::CreateItem => payload.get("id").is_none(),
        WriteKind::CreateEdge
        | WriteKind::WriteRows
        | WriteKind::UndoRows
        | WriteKind::UploadBlob => false,
        WriteKind::UpdateItem
        | WriteKind::DeleteItem
        | WriteKind::RestoreItem
        | WriteKind::TransitionItem
        | WriteKind::UpdateEdge
        | WriteKind::DeleteEdge
        | WriteKind::ReplaceTags
        | WriteKind::AddTag
        | WriteKind::RemoveTag
        | WriteKind::WriteExtension
        | WriteKind::DeleteExtension => true,
    };
    Ok(judged
        && !store::unsent(conn, &row.id)?
        && store::sent_as(conn, &row.id)?.as_deref() != Some(credential))
}

/// The version of its subject the copy holds as `row` is first sent, for a
/// write whose door takes one and that names none itself: a tag or
/// lifecycle write, or a create by natural key on a row the copy holds.
/// A version moves with a property, never with a tag or a state.
pub(super) fn version_at_send(
    conn: &Connection,
    row: &QueuedWrite,
    payload: &Value,
    own_source: Option<&str>,
) -> Result<Option<i64>> {
    let held = match row.kind {
        WriteKind::AddTag
        | WriteKind::RemoveTag
        | WriteKind::TransitionItem
        | WriteKind::RestoreItem => match row.item_id.as_deref() {
            Some(id) => store::held_version(conn, id)?,
            None => None,
        },
        WriteKind::CreateItem if payload.get("version").is_none() => {
            let source = text(payload, "source").or(own_source);
            match (source, text(payload, "source_id")) {
                (Some(source), Some(source_id)) => {
                    store::item_under_key(conn, source, source_id)?.map(|item| item.version)
                }
                _ => None,
            }
        }
        _ => None,
    };
    Ok(held.filter(|version| *version >= 1))
}

enum Read {
    Row(Value),
    Absent,
    /// The credential may not read it, so it cannot say.
    Refused,
}

/// Every request can be stopped; an error is the read's own, for the caller
/// to settle as it would the write's.
/// `own` is the current credential's own source, where known.
pub(super) fn judge(
    core: &Core,
    http: &Http,
    stop: &AtomicBool,
    row: &QueuedWrite,
    payload: &Value,
    own: Option<&str>,
) -> Result<Judged> {
    let context = reach::Context::capture(&*core.conn()?)?;
    let reads = Reads {
        within: &context.http(http),
        plain: http,
    };
    judged(core, &reads, stop, row, payload, own).or_else(|error| match error {
        // The caller expires the copy and leaves the write unsent in one step.
        CoreError::CopyExpired { ref reason, .. } if reason == INSTANCE_CHANGED => Err(error),
        error => Err(context.failed(core, error)?),
    })
}

/// A lookup by natural key is no conditional read, so it carries no reach.
struct Reads<'a> {
    within: &'a Http,
    plain: &'a Http,
}

fn judged(
    core: &Core,
    reads: &Reads<'_>,
    stop: &AtomicBool,
    row: &QueuedWrite,
    payload: &Value,
    own: Option<&str>,
) -> Result<Judged> {
    let http = reads.within;
    let item_id = || subject(row.item_id.as_deref(), row);
    let edge_id = || subject(row.edge_id.as_deref(), row);
    let applied_if = |holds: bool, found: Option<Value>| {
        if holds {
            Judged::Applied(found)
        } else {
            Judged::Send { read: true }
        }
    };
    let unread = Judged::Send { read: false };
    let undecided = |id: &str| Judged::Undecided {
        reason: format!(
            "under this credential the server finds no {id}, which it also answers for one \
             this credential may not read, so whether the {} sent under another credential \
             landed cannot be told",
            row.kind
        ),
        status: Some(404),
    };
    let state_of = |found: &Value| item_of(found).map(|item| item.state);
    Ok(match row.kind {
        WriteKind::CreateItem => {
            let named = text(payload, "source");
            let recorded = match named {
                Some(_) => None,
                None => store::sent_source(&*core.conn()?, &row.id)?,
            };
            let stamped = named.map(str::to_string).or(recorded.clone().flatten());
            // Naming no source, it is stamped with the sending credential's
            // own, so under another source it would make a second item. Two
            // credentials neither of whose source is known are taken as one
            // app's tokens, stamped with the app's source.
            let elsewhere = named.is_none() && recorded.is_none_or(|sent| sent.as_deref() != own);
            let not_held = |read: bool| {
                if elsewhere {
                    Judged::Undecided {
                        reason: "the create names no source, and the server stamps it with the \
                                 sending credential's own, so sent again under this credential, \
                                 whose source may be another, it could make a second item"
                            .into(),
                        status: None,
                    }
                } else {
                    Judged::Send { read }
                }
            };
            let unknown = || Judged::Undecided {
                reason: "this credential reads only part of what the create sent under \
                         another credential would have made, so whether it landed cannot be \
                         told"
                    .into(),
                status: None,
            };
            let (Some(r#type), Some(source_id), Some(source)) =
                (text(payload, "type"), text(payload, "source_id"), stamped)
            else {
                return Ok(not_held(false));
            };
            let (r#type, source_id) = (r#type.to_string(), source_id.to_string());
            let found = ask_unless_stopped(stop, reads.plain, move |http| {
                http.item_by_key(&r#type, &source, &source_id)
            })?;
            let Some(found) = found else {
                return Ok(not_held(false));
            };
            // The server takes no state or place on a row it merges into.
            let merged = payload.get("version").is_some()
                || store::sent_at_version(&*core.conn()?, &row.id)?.is_some();
            let found = if payload.get("edges").is_some() {
                let Some(id) = found["id"].as_str() else {
                    return Ok(unknown());
                };
                match read(
                    http,
                    stop,
                    &["items", id],
                    &[("include", "edges,metadata"), ("state", "any")],
                )? {
                    Read::Row(found) => found,
                    Read::Absent | Read::Refused => return Ok(unknown()),
                }
            } else {
                serde_json::json!({ "item": found })
            };
            let Some(item) = item_of(&found) else {
                return Ok(unknown());
            };
            if !(item_holds(payload, &item, false) && (merged || created_as_sent(payload, &item))) {
                return Ok(not_held(true));
            }
            match edges_held(http, stop, payload, &item)? {
                Holds::Yes => Judged::Applied(Some(found)),
                Holds::No => not_held(true),
                Holds::Unknown => unknown(),
            }
        }
        WriteKind::UpdateItem => match read_item(http, stop, item_id()?)? {
            Read::Row(found) => {
                let base = payload.get("version").and_then(Value::as_i64);
                let holds = item_of(&found).is_some_and(|item| {
                    base.is_some_and(|base| item.version > base) && item_holds(payload, &item, true)
                });
                applied_if(holds, Some(found))
            }
            Read::Absent | Read::Refused => unread,
        },
        WriteKind::DeleteItem => match read_item(http, stop, item_id()?)? {
            Read::Row(found) if state_of(&found).as_deref() == Some("trashed") => {
                Judged::Applied(None)
            }
            Read::Row(_) => Judged::Send { read: true },
            Read::Absent => undecided(item_id()?),
            Read::Refused => unread,
        },
        WriteKind::RestoreItem => match read_item(http, stop, item_id()?)? {
            Read::Row(found) => {
                let holds = state_of(&found).is_some_and(|state| state != "trashed");
                applied_if(holds, Some(found))
            }
            Read::Absent | Read::Refused => unread,
        },
        WriteKind::TransitionItem => match read_item(http, stop, item_id()?)? {
            Read::Row(found) => {
                let holds = state_of(&found).as_deref() == text(payload, "state");
                applied_if(holds, Some(found))
            }
            Read::Absent if text(payload, "state") == Some("trashed") => undecided(item_id()?),
            Read::Absent | Read::Refused => unread,
        },
        WriteKind::ReplaceTags | WriteKind::AddTag | WriteKind::RemoveTag => {
            match read_item(http, stop, item_id()?)? {
                Read::Row(found) => {
                    let held: HashSet<&str> = found["metadata"]["tags"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect();
                    let sent: HashSet<&str> = payload["tags"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect();
                    let holds = match row.kind {
                        WriteKind::ReplaceTags => held == sent,
                        WriteKind::AddTag => sent.is_subset(&held),
                        _ => row.tag.as_deref().is_some_and(|tag| !held.contains(tag)),
                    };
                    applied_if(holds, None)
                }
                Read::Absent | Read::Refused => unread,
            }
        }
        WriteKind::WriteExtension | WriteKind::DeleteExtension => {
            let namespace = subject(row.namespace.as_deref(), row)?;
            match read(
                http,
                stop,
                &["items", item_id()?, "extensions", namespace],
                &[],
            )? {
                Read::Row(found) => {
                    let holds = if row.kind == WriteKind::WriteExtension {
                        same(&found["document"], payload)
                    } else {
                        found["document"].is_null()
                    };
                    applied_if(holds, None)
                }
                Read::Absent | Read::Refused => unread,
            }
        }
        WriteKind::UpdateEdge => match read(http, stop, &["edges", edge_id()?], &[])? {
            Read::Row(found) => {
                let base = payload.get("version").and_then(Value::as_i64);
                let holds =
                    serde_json::from_value::<WireEdge>(found["edge"].clone()).is_ok_and(|edge| {
                        base.is_some_and(|base| edge.version > base)
                            && text(payload, "from_id").is_none_or(|end| end == edge.from_id)
                            && text(payload, "to_id").is_none_or(|end| end == edge.to_id)
                            && changed(properties(payload), &edge.properties).is_empty()
                    });
                applied_if(holds, Some(found))
            }
            Read::Absent | Read::Refused => unread,
        },
        WriteKind::DeleteEdge => match read(http, stop, &["edges", edge_id()?], &[])? {
            Read::Row(_) => Judged::Send { read: true },
            Read::Absent => undecided(edge_id()?),
            Read::Refused => unread,
        },
        WriteKind::CreateEdge
        | WriteKind::WriteRows
        | WriteKind::UndoRows
        | WriteKind::UploadBlob => unread,
    })
}

/// Whether `item` holds every field the create or update `sent` names, and,
/// for an update, none it clears and only the properties a replace sends.
fn item_holds(sent: &Value, item: &WireItem, update: bool) -> bool {
    let properties = properties(sent);
    if !changed(properties, &item.properties).is_empty() {
        return false;
    }
    if update {
        if text(sent, "properties_mode") == Some("replace")
            && item
                .properties
                .keys()
                .any(|name| !properties.contains_key(name))
        {
            return false;
        }
        let cleared = sent["clear_properties"].as_array().into_iter().flatten();
        if cleared
            .filter_map(Value::as_str)
            .any(|name| item.properties.contains_key(name))
        {
            return false;
        }
        if text(sent, "type").is_some_and(|r#type| r#type != item.r#type) {
            return false;
        }
    }
    text(sent, "tier").is_none_or(|tier| item.tier.as_deref() == Some(tier))
        && text(sent, "source_id").is_none_or(|key| item.source_id.as_deref() == Some(key))
        && text(sent, "occurred_at")
            .is_none_or(|time| projected(time) == projected(&item.occurred_at))
}

/// The fields a create sets only on a row it makes.
fn created_as_sent(sent: &Value, item: &WireItem) -> bool {
    let place = |key: &str, held: Option<f64>| {
        sent.get(key)
            .and_then(Value::as_f64)
            .is_none_or(|sent| held == Some(sent))
    };
    text(sent, "state").is_none_or(|state| state == item.state)
        && place("capture_latitude", item.capture_latitude)
        && place("capture_longitude", item.capture_longitude)
}

/// Each edge type the create names holds exactly its targets, as the server
/// replaces them, read to the end of the listing a block continues. The
/// server leaves out an edge this credential may not read, and a block
/// with none it may, so a target missing from what it shows may be hidden.
fn edges_held(http: &Http, stop: &AtomicBool, sent: &Value, item: &WireItem) -> Result<Holds> {
    let Some(named) = sent.get("edges").and_then(Value::as_object) else {
        return Ok(Holds::Yes);
    };
    let mut hidden = false;
    for (edge_type, targets) in named {
        let sent: HashSet<&str> = targets
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let block = item.edges.as_ref().and_then(|edges| edges.get(edge_type));
        let mut held: HashSet<String> = block
            .into_iter()
            .flat_map(|page| page.data.iter().map(|edge| edge.to_id.clone()))
            .collect();
        let mut cursor = block.and_then(|page| page.next_cursor.clone());
        while let Some(at) = cursor.take() {
            let page = match read(
                http,
                stop,
                &["items", &item.id, "edges"],
                &[("edge_type", edge_type), ("cursor", &at), ("limit", "500")],
            )? {
                Read::Row(page) => page,
                Read::Absent | Read::Refused => return Ok(Holds::Unknown),
            };
            held.extend(
                page["data"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|edge| edge["to_id"].as_str())
                    .map(str::to_string),
            );
            cursor = page["next_cursor"].as_str().map(str::to_string);
        }
        if held.iter().any(|to| !sent.contains(to.as_str())) {
            return Ok(Holds::No);
        }
        hidden |= held.len() != sent.len();
    }
    Ok(if hidden { Holds::Unknown } else { Holds::Yes })
}

/// In every state, so a write that trashed its subject finds it in the bin.
fn read_item(http: &Http, stop: &AtomicBool, id: &str) -> Result<Read> {
    read(
        http,
        stop,
        &["items", id],
        &[("include", "metadata"), ("state", "any")],
    )
}

fn read(
    http: &Http,
    stop: &AtomicBool,
    segments: &[&str],
    params: &[(&str, &str)],
) -> Result<Read> {
    let segments: Vec<String> = segments.iter().map(|segment| segment.to_string()).collect();
    let params: Vec<(String, String)> = params
        .iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
    let found = ask_unless_stopped(stop, http, move |http| {
        let segments: Vec<&str> = segments.iter().map(String::as_str).collect();
        let params: Vec<(&str, &str)> = params
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        http.read_whole_with(&segments, &params)
    });
    match found {
        Ok(Some(found)) => Ok(Read::Row(found)),
        Ok(None) => Ok(Read::Absent),
        Err(error) if names_no_row(&error) => Ok(Read::Absent),
        Err(CoreError::Forbidden { .. }) => Ok(Read::Refused),
        Err(error) => Err(error),
    }
}

fn item_of(found: &Value) -> Option<WireItem> {
    serde_json::from_value(found.get("item")?.clone()).ok()
}

fn properties(sent: &Value) -> &Map<String, Value> {
    static NONE: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);
    sent.get("properties")
        .and_then(Value::as_object)
        .unwrap_or(&NONE)
}

fn text<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

fn subject<'a>(id: Option<&'a str>, row: &QueuedWrite) -> Result<&'a str> {
    id.ok_or_else(|| {
        CoreError::Store(format!(
            "the queued {} names no subject, so there is nothing to read",
            row.kind
        ))
    })
}

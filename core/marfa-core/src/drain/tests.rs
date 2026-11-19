use serde_json::json;

use super::address::{Shape, upload};
use super::classify::{Classified, classify, refine};
use super::drain_keeping;
use super::read_back::{Bin, ReachChange, apply_owed, read_owed, read_owed_backs};
use super::report::DrainReport;
use super::settle::{
    AnsweredAt, drop_projected_edges, holds, land, move_edits_back, move_edits_behind, receipt_key,
    settle,
};
use crate::error::CoreError;
use crate::http::{Answer, Http, INSTANCE_CHANGED};
use crate::model::{BlockedReason, QueuedWrite, Subject, Verdict, WriteKind};
use crate::{Core, Result, reach, store};
use std::fs::File;
use std::sync::atomic::AtomicBool;

pub(super) fn write<'a>(
    kind: WriteKind,
    item_id: &'a str,
    edge_id: Option<&'a str>,
    base_version: Option<i64>,
    depends_on: &'a [String],
) -> store::NewWrite<'a> {
    store::NewWrite {
        kind,
        item_id: Some(item_id),
        to_id: None,
        edge_id,
        namespace: None,
        tag: None,
        blob: None,
        base_version,
        payload: "{}",
        depends_on,
    }
}

/// A copy holding `rows` as the server answered them, each deleted
/// locally, so each is one write to a door of its own.
pub(super) fn deleting(
    server: &crate::scripted::Scripted,
    rows: &[&str],
) -> (tempfile::TempDir, Core) {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(
        dir.path().join("core.sqlite"),
        Some(crate::Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap();
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, reach::FENCE, &"a".repeat(64)).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        for id in rows {
            let item = store::testing::note(id, id, "", "2026-01-01T00:00:00Z");
            store::upsert_item(&conn, &item, None, &Default::default()).unwrap();
        }
    }
    for id in rows {
        core.delete_item(id).unwrap();
    }
    (dir, core)
}

/// The server's bin as `GET /items?state=trashed` answers it under the
/// copy's reach: each row trashed, at `version`, stamped after the
/// copy's own.
pub(super) fn in_the_bin(rows: &[(&str, i64)]) -> crate::scripted::Answer {
    let data: Vec<serde_json::Value> =
        rows.iter()
            .map(|(id, version)| {
                let mut row: serde_json::Value = serde_json::from_str(
                    &crate::scripted::item_payload("item.trashed", id, "core.note", *version),
                )
                .unwrap();
                row.as_object_mut().unwrap().remove("event_type");
                row["item"]["state"] = "trashed".into();
                row["item"]["updated_at"] = "2026-03-01T00:00:00Z".into();
                row["listed"] = true.into();
                row
            })
            .collect();
    crate::scripted::certified(crate::scripted::json(
        200,
        &json!({ "data": data, "next_cursor": null }).to_string(),
    ))
}

pub(super) fn held_in_the_bin(core: &Core, id: &str, version: i64) {
    let held = store::items_by_ids(&core.conn().unwrap(), &[id.to_string()])
        .unwrap()
        .pop()
        .unwrap_or_else(|| panic!("the copy let go of {id}, which the bin holds"));
    assert_eq!(held.state, crate::model::ItemState::Trashed);
    assert_eq!(held.version, version);
    assert_eq!(
        held.updated_at, "2026-03-01T00:00:00Z",
        "the copy holds the row the bin answered"
    );
}

pub(super) fn report(answered: usize, held: usize) -> DrainReport {
    DrainReport {
        answered,
        held,
        undelivered: 0,
        unsent: 0,
        unmade: 0,
        unavailable: None,
        limited: false,
        verdicts: Vec::new(),
        stopped: None,
        refused_by: None,
        unclaimed_sources: Vec::new(),
        retry_after_seconds: None,
    }
}

pub(super) fn projected(index: usize) -> String {
    crate::model::projected_edge_id("made", "references", &format!("t{index:02}"))
}

pub(super) fn reach_changed() -> CoreError {
    CoreError::expired_by("reach_changed", 409, "reach_changed")
}

mod create_edges;
mod interrupted;
mod landing;
mod pass;
mod read_back;
mod rebase;
mod source_moves;

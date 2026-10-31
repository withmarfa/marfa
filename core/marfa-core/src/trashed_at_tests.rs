//! When a held row went to the bin: stamped by a delete made here, cleared by
//! a restore, overwritten by the server's own time, and the order of a list
//! of the bin alone.

use std::sync::Arc;

use serde_json::json;

use crate::scripted::Scripted;
use crate::stop_tests::{copy, holding_a_catalog};
use crate::{Core, Item, ItemState, ListFilters, Sort, SortDirection, SortField, store};

const HELD_AT: &str = "2026-01-01T00:00:00Z";

fn put(core: &Core, row: &crate::wire::WireItem) {
    let conn = core.conn().unwrap();
    let catalog = crate::catalog::Catalog::load(&conn).unwrap();
    crate::reach::set_listed(&conn, &row.id, true).unwrap();
    store::put_server_item(&conn, row, Some(&[]), &catalog).unwrap();
    store::lay_waiting_writes_over(&conn, &row.id, &|type_id| catalog.indexing(type_id)).unwrap();
}

fn note(id: &str, state: &str) -> crate::wire::WireItem {
    store::testing::wire_item(id, "core.note", state, HELD_AT, json!({ "title": id }))
}

fn held_copy(server: &Scripted, ids: &[&str]) -> Arc<Core> {
    let core = copy(server);
    holding_a_catalog(&core);
    for id in ids {
        put(&core, &note(id, "active"));
    }
    core
}

fn held(core: &Core, id: &str) -> Item {
    store::items_by_ids(&core.conn().unwrap(), &[id.to_string()])
        .unwrap()
        .pop()
        .unwrap()
}

/// Waits out the clock's resolution, so two stamps taken either side differ.
fn tick() {
    std::thread::sleep(std::time::Duration::from_millis(5));
}

#[test]
fn a_delete_made_here_stamps_when_and_leaves_updated_at_alone() {
    let server = Scripted::start();
    let core = held_copy(&server, &["a"]);
    assert_eq!(held(&core, "a").trashed_at, None);

    let queued = core.delete_item("a").unwrap();

    let item = held(&core, "a");
    assert_eq!(item.state, ItemState::Trashed);
    assert_eq!(item.trashed_at.as_deref(), Some(queued.queued_at.as_str()));
    assert_eq!(
        item.updated_at, HELD_AT,
        "the local delete moved updated_at"
    );
}

#[test]
fn a_restore_clears_it_and_a_second_delete_takes_a_new_time() {
    let server = Scripted::start();
    let core = held_copy(&server, &["a"]);
    core.delete_item("a").unwrap();
    let first = held(&core, "a").trashed_at.unwrap();

    core.restore_item("a").unwrap();
    let restored = held(&core, "a");
    assert_eq!(restored.state, ItemState::Active);
    assert_eq!(restored.trashed_at, None);

    tick();
    core.delete_item("a").unwrap();
    let second = held(&core, "a").trashed_at.unwrap();
    assert!(second > first, "{second} is not after {first}");
}

#[test]
fn a_move_between_other_states_keeps_no_time() {
    let server = Scripted::start();
    let core = held_copy(&server, &["a"]);
    core.transition_item("a", ItemState::Archived).unwrap();
    assert_eq!(held(&core, "a").trashed_at, None);
}

#[test]
fn the_server_time_replaces_the_one_stamped_here() {
    let server = Scripted::start();
    let core = held_copy(&server, &["a", "b"]);
    core.delete_item("a").unwrap();
    core.delete_item("b").unwrap();
    assert!(held(&core, "a").trashed_at.is_some());

    // The server's row arrives in the bin with its own time while the delete
    // made here still waits: it keeps the server's time.
    let mut binned = note("a", "trashed");
    binned.version = 2;
    binned.updated_at = "2030-03-03T03:03:03.000Z".into();
    binned.trashed_at = Some("2030-03-03T03:03:03.000Z".into());
    put(&core, &binned);
    assert_eq!(
        held(&core, "a").trashed_at.as_deref(),
        Some("2030-03-03T03:03:03.000Z")
    );

    // The server's row arrives live while the delete still waits: the delete
    // laid over it is stamped when it was queued.
    let queued_at = store::waiting_writes_for_item(&core.conn().unwrap(), "b")
        .unwrap()
        .pop()
        .unwrap()
        .queued_at;
    let mut live = note("b", "active");
    live.version = 2;
    live.updated_at = "2030-03-03T03:03:03.000Z".into();
    put(&core, &live);
    let item = held(&core, "b");
    assert_eq!(item.state, ItemState::Trashed);
    assert_eq!(item.trashed_at, Some(queued_at));
}

fn ids(core: &Core, filters: &ListFilters, sort: Option<Sort>) -> Vec<String> {
    core.list(filters, sort)
        .unwrap()
        .rows
        .into_iter()
        .map(|item| item.id)
        .collect()
}

#[test]
fn a_list_of_the_bin_alone_is_newest_binned_first() {
    let server = Scripted::start();
    let core = copy(&server);
    holding_a_catalog(&core);
    // Created a to f, oldest first; binned in another order, with two ties
    // and two rows that kept no time and stand at their updated_at.
    for (id, created, updated, trashed) in [
        (
            "a",
            "2026-01-01T00:06:00.000Z",
            "2026-01-01T00:10:00.000Z",
            Some("2026-01-01T00:10:00.000Z"),
        ),
        (
            "b",
            "2026-01-01T00:05:00.000Z",
            "2026-01-01T00:30:00.000Z",
            Some("2026-01-01T00:11:00.000Z"),
        ),
        (
            "c",
            "2026-01-01T00:04:00.000Z",
            "2026-01-01T00:12:00.000Z",
            None,
        ),
        (
            "d",
            "2026-01-01T00:03:00.000Z",
            "2026-01-01T00:13:00.000Z",
            Some("2026-01-01T00:13:00.000Z"),
        ),
        (
            "e",
            "2026-01-01T00:02:00.000Z",
            "2026-01-01T00:13:00.000Z",
            Some("2026-01-01T00:13:00.000Z"),
        ),
        (
            "f",
            "2026-01-01T00:01:00.000Z",
            "2026-01-01T00:14:00.000Z",
            None,
        ),
        (
            "live",
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:20:00.000Z",
            None,
        ),
    ] {
        let mut row = note(id, if id == "live" { "active" } else { "trashed" });
        row.created_at = created.into();
        row.updated_at = updated.into();
        row.trashed_at = trashed.map(Into::into);
        put(&core, &row);
    }
    let bin = ListFilters {
        states: Some(vec![ItemState::Trashed]),
        ..ListFilters::default()
    };

    assert_eq!(ids(&core, &bin, None), ["f", "e", "d", "c", "b", "a"]);
    assert_eq!(
        ids(
            &core,
            &bin,
            Sort::named(None, Some(SortDirection::Ascending), &bin)
        ),
        ["a", "b", "c", "d", "e", "f"]
    );
    assert_eq!(
        ids(
            &core,
            &bin,
            Sort::named(Some(SortField::CreatedAt), None, &bin)
        ),
        ["a", "b", "c", "d", "e", "f"]
    );
    let more = ListFilters {
        states: Some(vec![ItemState::Trashed, ItemState::Active]),
        ..ListFilters::default()
    };
    assert_eq!(
        ids(&core, &more, None),
        ["a", "b", "c", "d", "e", "f", "live"]
    );
    let every = ListFilters {
        all_states: true,
        ..ListFilters::default()
    };
    assert_eq!(
        ids(&core, &every, None),
        ["a", "b", "c", "d", "e", "f", "live"]
    );
}

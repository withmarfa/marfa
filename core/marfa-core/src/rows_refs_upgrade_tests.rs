//! A store from before held rows kept their marks is upgraded in place:
//! each table whose marks the copy can tell stays whole and readable, and
//! only a table that holds an item id's text in another column is owed
//! again, with what the restore check needs set aside first.

use std::path::Path;
use std::sync::atomic::AtomicBool;

use marfa_rules::wire::{WireCatalog, WireType};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::scripted::{self, Answer, Scripted};
use crate::{Core, Server, store};

const NOTE: &str = "core.note";
const LEDGER: &str = "app.acme.ledger";
const STEPS: &str = "steps";
const AT: &str = "2026-01-01T00:00:00Z";

const X: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f01";
const Y: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f02";
/// Text of an item id's form in a column of type `string`.
const Z: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f03";
const R1: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f11";
const R2: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f12";
const S1: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f21";
const S2: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f22";
const S3: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f23";
const T1: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f31";

fn ledger() -> Value {
    json!({
        "id": LEDGER,
        "fields": {},
        "tables": {
            "steps": {"columns": {
                "count": {"type": "integer"},
                "link": {"type": "item"},
                "note": {"type": "string"},
            }},
        },
    })
}

fn answer(body: &Value) -> Answer {
    scripted::certified(scripted::json(200, &body.to_string()))
}

fn row(id: &str, values: Value, refs: &[&str]) -> Value {
    json!({"id": id, "values": values, "refs": refs, "updated_at": AT})
}

fn rows(item: &str, rows: Vec<Value>) -> (String, Answer) {
    (
        format!("/items/{item}/tables/{STEPS}/rows"),
        answer(&json!({"data": rows, "next_cursor": null})),
    )
}

fn summary(server: &Scripted, item: &str, count: usize) {
    server.on(
        &format!("/items/{item}/tables"),
        vec![answer(&json!({
            "data": [{"name": STEPS, "row_count": count, "bytes": 100}],
            "next_cursor": null,
        }))],
    );
}

fn serve(server: &Scripted) {
    server.on(
        "/types",
        vec![answer(&json!({
            "data": [{"id": NOTE, "display_hints": {"title_field": "title"}}, ledger()],
            "next_cursor": null,
        }))],
    );
    server.on(
        "/edge-types",
        vec![scripted::certified(scripted::edge_types(&[]))],
    );
    server.on(
        "/keys/current",
        vec![answer(
            &json!({"type_permissions": {NOTE: "write", LEDGER: "write"}}),
        )],
    );
}

fn open(path: &Path, server: Option<&Scripted>) -> Core {
    Core::open(
        path,
        server.map(|server| Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap()
}

/// n1 and n2 of the ledger, held whole from the server.
fn filled(path: &Path) {
    let server = Scripted::start();
    serve(&server);
    let core = open(path, Some(&server));
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, crate::reach::FENCE, scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, scripted::INSTANCE).unwrap();
        store::meta_set(
            &conn,
            store::META_SLICE_TYPES,
            &serde_json::to_string(&[NOTE, LEDGER]).unwrap(),
        )
        .unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        store::mark_read_only_read(&conn).unwrap();
        let catalog = WireCatalog {
            types: vec![
                store::testing::wire_type(NOTE, None, Some("title")),
                serde_json::from_value::<WireType>(ledger()).unwrap(),
            ],
            edge_types: Vec::new(),
        };
        store::replace_catalog(&conn, &catalog).unwrap();
        let catalog = crate::catalog::load(&conn).unwrap();
        for id in ["n1", "n2"] {
            let item = store::testing::wire_item(id, LEDGER, "active", AT, json!({}));
            crate::reach::set_listed(&conn, id, true).unwrap();
            store::put_server_item(&conn, &item, Some(&[]), &catalog).unwrap();
        }
    }
    summary(&server, "n1", 2);
    summary(&server, "n2", 2);
    for (path, rows) in [
        rows(
            "n1",
            vec![
                row(R1, json!({"link": X}), &["link"]),
                row(R2, json!({"count": 2}), &[]),
            ],
        ),
        rows(
            "n2",
            vec![
                row(S1, json!({"note": Z}), &[]),
                row(S2, json!({"count": 5}), &[]),
            ],
        ),
    ] {
        server.on(&path, vec![rows]);
    }
    let held = core.hold_table(LEDGER, STEPS).unwrap();
    assert!(held.fill.is_some(), "the hold left its tables owed");

    // (a) Queued and unsent.
    core.write_rows(
        "n1",
        STEPS,
        &[json!({"op": "patch", "id": R2, "values": {"link": Y}})],
    )
    .unwrap();
    core.write_rows(
        "n2",
        STEPS,
        &[json!({"op": "put", "id": S3, "values": {"count": 3, "link": Y}})],
    )
    .unwrap();
    // (c) An item whose create waits, with its table held and a row written.
    let n3 = core
        .create_item(&crate::Draft {
            r#type: LEDGER.into(),
            ..Default::default()
        })
        .unwrap()
        .item_id
        .unwrap();
    core.fill_tables(&AtomicBool::new(false)).unwrap();
    core.write_rows(
        &n3,
        STEPS,
        &[json!({"op": "put", "id": T1, "values": {"link": X}})],
    )
    .unwrap();
    // (b) The server answered a write of s2 whose event has not come.
    let conn = core.conn().unwrap();
    conn.execute(
        "INSERT INTO row_receipts (write_id, item_id, name, id, batch, at, removal, answered_at, seen)
         VALUES ('answered', 'n2', ?1, ?2, 'b-s2', ?3, 0, ?4, 0)",
        params![STEPS, S2, AT, store::now_millis()],
    )
    .unwrap();
}

/// Back to the shape and the `row_refs` rule of schema 13.
fn as_schema_13(path: &Path) {
    let conn = Connection::open(path).unwrap();
    let held: Vec<(String, String, String, String)> = conn
        .prepare("SELECT item_id, name, id, body FROM table_rows")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    conn.execute_batch(
        "DELETE FROM row_refs;
         ALTER TABLE table_rows DROP COLUMN refs;
         ALTER TABLE rows_beneath DROP COLUMN refs;
         PRAGMA user_version = 13;",
    )
    .unwrap();
    for (item, table, id, body) in held {
        let values: serde_json::Map<String, Value> = serde_json::from_str(&body).unwrap();
        for text in values.values().filter_map(Value::as_str) {
            if marfa_rules::validation::is_id(text) {
                conn.execute(
                    "INSERT OR IGNORE INTO row_refs (item_id, name, row_id, target) VALUES (?1, ?2, ?3, ?4)",
                    params![item, table, id, text],
                )
                .unwrap();
            }
        }
    }
}

fn state(core: &Core, item: &str) -> String {
    crate::tables::state(&core.conn().unwrap(), item, STEPS)
        .unwrap()
        .unwrap()
}

/// Each row the copy shows of the item's table, as its values and refs.
fn shown(core: &Core, item: &str) -> Vec<(String, Value, Value)> {
    let read = core
        .table_rows(item, STEPS, &crate::tables::RowsAsked::default())
        .unwrap();
    let mut rows: Vec<(String, Value, Value)> = read["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["id"].as_str().unwrap().to_string(),
                row["values"].clone(),
                row.get("refs").cloned().unwrap_or(json!([])),
            )
        })
        .collect();
    rows.sort_by(|one, other| one.0.cmp(&other.0));
    rows
}

fn named(core: &Core, item: &str) -> Vec<(String, String)> {
    core.conn()
        .unwrap()
        .prepare("SELECT row_id, target FROM row_refs WHERE item_id = ?1 ORDER BY row_id")
        .unwrap()
        .query_map([item], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn kept(core: &Core) -> Vec<Value> {
    core.conn()
        .unwrap()
        .prepare("SELECT payload FROM queue WHERE reason = 'server_restored' ORDER BY seq")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|payload| {
            serde_json::from_str::<Value>(&payload.unwrap()).unwrap()["operations"].clone()
        })
        .collect()
}

#[test]
fn a_store_from_before_rows_kept_marks_keeps_what_it_can_tell_and_refills_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    filled(&path);
    let n3: String = Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT item_id FROM item_tables WHERE item_id NOT IN ('n1', 'n2')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    as_schema_13(&path);

    // Upgraded with no server: what it can tell stays whole and readable.
    {
        let core = open(&path, None);
        assert_eq!(state(&core, "n1"), "whole");
        assert_eq!(
            shown(&core, "n1"),
            [
                (R1.into(), json!({"link": X}), json!(["link"])),
                (R2.into(), json!({"count": 2, "link": Y}), json!(["link"])),
            ]
        );
        assert_eq!(
            named(&core, "n1"),
            [(R1.into(), X.into()), (R2.into(), Y.into())]
        );
        assert_eq!(state(&core, &n3), "whole");
        assert_eq!(
            shown(&core, &n3),
            [(T1.into(), json!({"link": X}), json!(["link"]))]
        );
        // Z may have been written to `note` while it was of type `item`.
        assert_eq!(state(&core, "n2"), "owed");
        let conn = core.conn().unwrap();
        let set_aside: Vec<String> = conn
            .prepare("SELECT id FROM held_rows WHERE item_id = 'n2'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(set_aside, [S2.to_string()]);
    }

    // Refilled from a server that lost s2.
    let server = Scripted::start();
    serve(&server);
    summary(&server, "n2", 1);
    let (at, answered) = rows("n2", vec![row(S1, json!({"note": Z}), &[])]);
    server.on(&at, vec![answered]);
    let core = open(&path, Some(&server));
    core.fill_tables(&AtomicBool::new(false)).unwrap();
    assert_eq!(state(&core, "n2"), "whole");
    assert_eq!(
        shown(&core, "n2"),
        [
            (S1.into(), json!({"note": Z}), json!([])),
            (S2.into(), json!({"count": 5}), json!([])),
            (S3.into(), json!({"count": 3, "link": Y}), json!(["link"])),
        ]
    );
    assert_eq!(named(&core, "n2"), [(S3.into(), Y.into())]);
    assert_eq!(
        kept(&core),
        [json!([{"op": "put", "id": S2, "values": {"count": 5}}])]
    );
    assert!(
        server.seen("/items/n1/tables").is_empty(),
        "the table it could tell was filled again"
    );
}

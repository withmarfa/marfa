//! The tables a working copy holds, and the reads and writes of their rows.

use std::sync::Arc;

use crate::guard::guarded;
use crate::{Core, JsonObject, MarfaError, QueuedWrite, SortDirection, Stop, flag_of, queued};

/// What a fill of the tables not yet whole did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TableFill {
    /// Tables the pass left whole.
    pub whole: u64,
    /// Tables past the cap, which are read from the server.
    pub online: u64,
    /// Tables left unfilled, including failed and handed-over tables.
    pub unfilled: u64,
    pub pages: u64,
    pub rows: u64,
    /// Tables left unfilled because their read failed, each left to the next pass.
    pub failed: u64,
    /// The last of them, or what cut the fill short, and why.
    pub failure: Option<String>,
    /// Tables left to the call that took the stream, counted in `unfilled`.
    pub handed: Vec<ChangedTable>,
}

impl From<marfa_core::FillReport> for TableFill {
    fn from(fill: marfa_core::FillReport) -> Self {
        TableFill {
            whole: fill.whole,
            online: fill.online,
            unfilled: fill.unfilled,
            pages: fill.pages,
            rows: fill.rows,
            failed: fill.failed,
            failure: fill.failure,
            handed: fill.handed.into_iter().map(ChangedTable::from).collect(),
        }
    }
}

/// A table the copy holds, or held, whose state or rows changed.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ChangedTable {
    pub item_id: String,
    pub table: String,
}

impl From<marfa_core::ChangedTable> for ChangedTable {
    fn from(changed: marfa_core::ChangedTable) -> Self {
        ChangedTable {
            item_id: changed.item,
            table: changed.table,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TableHold {
    pub r#type: String,
    pub table: String,
    pub was_held: bool,
    /// `nil` if the hold started no fill pass.
    pub fill: Option<TableFill>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TableChoice {
    pub r#type: String,
    pub table: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum TableState {
    /// Held, with no row read yet.
    Owed,
    Filling,
    Whole,
    /// Past the cap, so its reads go to the server.
    Online,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct HeldTable {
    pub item_id: String,
    pub table: String,
    pub state: TableState,
    pub rows: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct HeldTables {
    pub choices: Vec<TableChoice>,
    pub tables: Vec<HeldTable>,
}

/// A read of a table's rows, as `GET /items/{id}/tables/{table}/rows` takes it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RowsAsked {
    #[uniffi(default = None)]
    pub limit: Option<u32>,
    #[uniffi(default = None)]
    pub cursor: Option<String>,
    #[uniffi(default = None)]
    pub filter: Option<String>,
    /// `id`, `updated_at` or `values.<column>`.
    #[uniffi(default = None)]
    pub sort: Option<String>,
    #[uniffi(default = None)]
    pub direction: Option<SortDirection>,
}

impl From<RowsAsked> for marfa_core::RowsAsked {
    fn from(asked: RowsAsked) -> Self {
        marfa_core::RowsAsked {
            limit: asked.limit.map(i64::from),
            cursor: asked.cursor,
            filter: asked.filter,
            sort: asked.sort,
            direction: asked.direction.map(|direction| {
                match direction {
                    SortDirection::Ascending => "asc",
                    SortDirection::Descending => "desc",
                }
                .to_string()
            }),
        }
    }
}

fn held(held: marfa_core::HeldTables) -> Result<HeldTables, MarfaError> {
    let tables = held
        .tables
        .into_iter()
        .map(|table| {
            let state = match table.state.as_str() {
                "owed" => TableState::Owed,
                "filling" => TableState::Filling,
                "whole" => TableState::Whole,
                "online" => TableState::Online,
                other => {
                    return Err(MarfaError::Store {
                        message: format!(
                            "the copy holds a table in a state it does not know: {other}"
                        ),
                    });
                }
            };
            Ok(HeldTable {
                item_id: table.item,
                table: table.table,
                state,
                rows: table.rows,
            })
        })
        .collect::<Result<_, _>>()?;
    Ok(HeldTables {
        choices: held
            .choices
            .into_iter()
            .map(|choice| TableChoice {
                r#type: choice.type_id,
                table: choice.table,
            })
            .collect(),
        tables,
    })
}

/// A row answer, in the server's shape with `held` beside it.
fn answer(value: serde_json::Value) -> Result<JsonObject, MarfaError> {
    match value {
        serde_json::Value::Object(map) => Ok(map.into()),
        other => Err(MarfaError::Store {
            message: format!("a table read answered {other}, not an object"),
        }),
    }
}

guarded! {
    #[uniffi::export]
    impl Core {
        /// Chooses `table` for the types `type_id` names and fills it while no other
        /// call holds the stream.
        pub fn hold_table(
            &self,
            type_id: String,
            table: String,
            stop: Option<Arc<Stop>>,
        ) -> Result<TableHold, MarfaError> {
            let hold = self
                .inner
                .hold_table_until(&type_id, &table, &flag_of(stop))?;
            Ok(TableHold {
                r#type: hold.type_id,
                table: hold.table,
                was_held: hold.was_held,
                fill: hold.fill.map(Into::into),
            })
        }

        /// Releases a choice, keeping the tables another choice holds; answers
        /// whether it was held.
        pub fn let_go_table(&self, type_id: String, table: String) -> Result<bool, MarfaError> {
            Ok(self.inner.let_go_table(&type_id, &table)?)
        }

        pub fn held_tables(&self) -> Result<HeldTables, MarfaError> {
            held(self.inner.held_tables()?)
        }

        /// Fills each table the copy holds that is not whole.
        pub fn fill_tables(&self, stop: Option<Arc<Stop>>) -> Result<TableFill, MarfaError> {
            Ok(self.inner.fill_tables(&flag_of(stop))?.into())
        }

        /// A page of rows, from the copy where it holds the table whole and from
        /// the server otherwise, with `held` saying which.
        #[uniffi::method(default(asked = None))]
        pub fn table_rows(
            &self,
            item_id: String,
            table: String,
            asked: Option<RowsAsked>,
        ) -> Result<JsonObject, MarfaError> {
            let asked = asked.map(Into::into).unwrap_or_default();
            answer(self.inner.table_rows(&item_id, &table, &asked)?)
        }

        pub fn table_row(
            &self,
            item_id: String,
            table: String,
            row: String,
        ) -> Result<JsonObject, MarfaError> {
            answer(self.inner.table_row(&item_id, &table, &row)?)
        }

        #[uniffi::method(default(filter = None))]
        pub fn table_totals(
            &self,
            item_id: String,
            table: String,
            filter: Option<String>,
        ) -> Result<JsonObject, MarfaError> {
            answer(
                self.inner
                    .table_totals(&item_id, &table, filter.as_deref())?,
            )
        }

        /// Queues one batch of row operations, laid over the copy where it
        /// holds the table whole.
        pub fn write_rows(
            &self,
            item_id: String,
            table: String,
            operations: Vec<JsonObject>,
        ) -> Result<QueuedWrite, MarfaError> {
            let operations = operations
                .into_iter()
                .map(|operation| operation.into_map().map(serde_json::Value::Object))
                .collect::<Result<Vec<_>, _>>()?;
            queued(self.inner.write_rows(&item_id, &table, &operations)?)
        }

        /// Queues an undo of a batch; no held row changes until the server's
        /// `rows.changed` arrives.
        pub fn undo_rows(
            &self,
            item_id: String,
            table: String,
            batch: String,
        ) -> Result<QueuedWrite, MarfaError> {
            queued(self.inner.undo_rows(&item_id, &table, &batch)?)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::sync::{Arc, Mutex};

    use serde_json::{Value, json};

    use super::*;
    use crate::{Core, SliceTier, Verdict, WriteKind};

    const ITEM: &str = "019a0000-0000-7000-8000-000000000001";
    const HELD_ROW: &str = "019a0000-0000-7000-8000-0000000000a1";
    const NEW_ROW: &str = "019a0000-0000-7000-8000-0000000000b2";
    const OTHER_ROW: &str = "019a0000-0000-7000-8000-0000000000c3";
    const BATCH: &str = "019a0000-0000-7000-8000-0000000000d4";
    const UNDO: &str = "019a0000-0000-7000-8000-0000000000e5";

    /// A server holding one item of `test.steps`, its `steps` table and one
    /// row, which takes row writes and undoes.
    struct Steps {
        url: String,
        /// Each request's method and path.
        seen: Arc<Mutex<Vec<(String, String)>>>,
    }

    fn steps() -> Steps {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seeing = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let seeing = Arc::clone(&seeing);
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let (mut head, mut line) = (String::new(), String::new());
                    while reader.read_line(&mut line).unwrap_or(0) > 2 {
                        head.push_str(&line);
                        line.clear();
                    }
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    let mut body = vec![0; length];
                    let _ = reader.read_exact(&mut body);
                    let method = head.split_whitespace().next().unwrap_or("GET").to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("/");
                    let path = path.split('?').next().unwrap_or("/").to_string();
                    seeing.lock().unwrap().push((method.clone(), path.clone()));
                    let contract = marfa_core::contract::CONTRACT_VERSION;
                    let fence = "a".repeat(64);
                    let instance = "00000000-0000-7000-8000-000000000000";
                    let proof = if head.to_ascii_lowercase().contains("x-marfa-reach:") {
                        format!("X-Marfa-Reach: {fence}\r\nCache-Control: no-store\r\n")
                    } else {
                        String::new()
                    };
                    let json = |body: String| {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Marfa-Contract: {contract}\r\n{proof}Connection: close\r\n\r\n{body}",
                            body.len()
                        )
                    };
                    let tables = format!("/items/{ITEM}/tables");
                    let rows = format!("{tables}/steps/rows");
                    let undo = format!("{tables}/steps/batches/{BATCH}/undo");
                    let answer = match (method.as_str(), path.as_str()) {
                        (_, "/") => json(format!(r#"{{"instance_id":"{instance}"}}"#)),
                        (_, "/types") => json(
                            json!({"data": [{
                                "id": "test.steps",
                                "fields": {"title": {"type": "string"}},
                                "tables": {"steps": {"columns": {
                                    "count": {"type": "integer"},
                                    "note": {"type": "string"},
                                }}},
                            }], "next_cursor": null})
                            .to_string(),
                        ),
                        (_, "/edge-types") => json(r#"{"data":[],"next_cursor":null}"#.into()),
                        (_, "/keys/current") => {
                            json(r#"{"type_permissions":{"*":"write"}}"#.into())
                        }
                        (_, "/items") => json(r#"{"data":[],"next_cursor":null}"#.into()),
                        (_, "/events") => {
                            let marker = |kind: &str| {
                                format!(
                                    "event: {kind}\ndata: {{\"event_type\":\"{kind}\",\"cursor\":\"10\",\"instance_id\":\"{instance}\",\"reach\":\"{fence}\"}}\n\n"
                                )
                            };
                            let live = if head.to_ascii_lowercase().contains("last-event-id") {
                                marker("stream_live")
                            } else {
                                String::new()
                            };
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nX-Marfa-Contract: {contract}\r\nConnection: close\r\n\r\n: connected\n\n{}{live}",
                                marker("stream_cursor")
                            )
                        }
                        ("GET", path) if path == tables => json(
                            r#"{"data":[{"name":"steps","row_count":1,"bytes":40}]}"#.into(),
                        ),
                        ("GET", path) if path == rows => json(
                            json!({"data": [{
                                "id": HELD_ROW,
                                "values": {"count": 1, "note": "held"},
                                "updated_at": "2026-01-01T00:00:00Z",
                            }], "next_cursor": null})
                            .to_string(),
                        ),
                        ("POST", path) if path == rows => {
                            let sent: Value = serde_json::from_slice(&body).unwrap_or_default();
                            let results: Vec<Value> = sent["operations"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .map(|op| json!({"id": op["id"], "outcome": "created"}))
                                .collect();
                            json(
                                json!({
                                    "batch": BATCH,
                                    "results": results,
                                    "last_activity_at": "2026-01-02T00:00:00Z",
                                })
                                .to_string(),
                            )
                        }
                        ("POST", path) if path == undo => json(
                            json!({
                                "batch": UNDO,
                                "undoes": BATCH,
                                "results": [{"id": NEW_ROW, "outcome": "deleted"}],
                            })
                            .to_string(),
                        ),
                        _ => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .into(),
                    };
                    let mut stream = stream;
                    let _ = stream.write_all(answer.as_bytes());
                });
            }
        });
        Steps { url, seen }
    }

    fn object(value: Value) -> crate::JsonObject {
        match value {
            Value::Object(map) => map.into(),
            _ => unreachable!(),
        }
    }

    fn put(id: &str, note: &str) -> crate::JsonObject {
        object(json!({"op": "put", "id": id, "values": {"count": 2, "note": note}}))
    }

    fn ids(page: &crate::JsonObject) -> Vec<String> {
        let page = Value::Object(page.clone().into_map().unwrap());
        page["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap().to_string())
            .collect()
    }

    fn held(page: &crate::JsonObject) -> Value {
        Value::Object(page.clone().into_map().unwrap())["held"].clone()
    }

    #[test]
    fn a_table_is_held_filled_read_written_and_undone_across_the_binding() {
        let server = steps();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(
            path.clone(),
            Some(server.url.clone()),
            Some("key".into()),
            None,
        )
        .unwrap();
        core.hydrate(vec!["test.steps".into()], SliceTier::Library, None)
            .unwrap();
        // The server's item, as the copy holds it once read.
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute(
                "INSERT INTO items (id,type,state,tier,version,schema_version,source,occurred_at,created_at,updated_at,properties) VALUES (?1,'test.steps','active','library',1,1,'test',?2,?2,?2,'{\"title\":\"Steps\"}')",
                rusqlite::params![ITEM, "2026-01-01T00:00:00Z"],
            )
            .unwrap();

        // The witness: before the table is held, the server answers the read.
        let asked = core.table_rows(ITEM.into(), "steps".into(), None).unwrap();
        assert_eq!(held(&asked), json!(false));

        let since = core.changes_since(None, 100).unwrap().cursor;
        let hold = core
            .hold_table("test.steps".into(), "steps".into(), None)
            .unwrap();
        assert_eq!(
            (hold.r#type.as_str(), hold.table.as_str()),
            ("test.steps", "steps")
        );
        assert!(!hold.was_held);
        let fill = hold.fill.expect("the hold filled no table");
        assert_eq!((fill.whole, fill.rows, fill.failed), (1, 1, 0));

        let tables = core.held_tables().unwrap();
        assert_eq!(tables.choices.len(), 1);
        assert_eq!(tables.choices[0].r#type, "test.steps");
        assert_eq!(tables.tables.len(), 1);
        assert_eq!(tables.tables[0].item_id, ITEM);
        assert_eq!(tables.tables[0].state, TableState::Whole);
        assert_eq!(tables.tables[0].rows, 1);
        assert_eq!(core.fill_tables(None).unwrap().whole, 0);

        let changes = core.changes_since(Some(since), 100).unwrap();
        assert_eq!(
            (changes.everything, changes.tables),
            (
                false,
                vec![ChangedTable {
                    item_id: ITEM.into(),
                    table: "steps".into()
                }]
            ),
            "the fill was not named to the app"
        );
        let quiet = core.changes_since(Some(changes.cursor), 100).unwrap();
        assert_eq!(
            quiet.tables,
            Vec::new(),
            "a table nothing changed was named"
        );

        let page = core
            .table_rows(
                ITEM.into(),
                "steps".into(),
                Some(RowsAsked {
                    limit: Some(10),
                    cursor: None,
                    filter: None,
                    sort: None,
                    direction: Some(crate::SortDirection::Descending),
                }),
            )
            .unwrap();
        assert_eq!(held(&page), json!(true));
        assert_eq!(ids(&page), vec![HELD_ROW.to_string()]);
        let row = core
            .table_row(ITEM.into(), "steps".into(), HELD_ROW.into())
            .unwrap();
        assert_eq!(held(&row), json!(true));
        let totals = core
            .table_totals(ITEM.into(), "steps".into(), None)
            .unwrap();
        assert_eq!(held(&totals), json!(true));
        let before = server.seen.lock().unwrap().len();

        let first = core
            .write_rows(ITEM.into(), "steps".into(), vec![put(NEW_ROW, "new")])
            .unwrap();
        let second = core
            .write_rows(ITEM.into(), "steps".into(), vec![put(OTHER_ROW, "other")])
            .unwrap();
        assert_eq!(first.kind, WriteKind::WriteRows);
        assert!(first.verdict.is_none());
        let mut shown = ids(&core.table_rows(ITEM.into(), "steps".into(), None).unwrap());
        shown.sort();
        assert_eq!(shown, vec![HELD_ROW, NEW_ROW, OTHER_ROW]);
        assert_eq!(
            server.seen.lock().unwrap().len(),
            before,
            "a read of a table held whole asked the server"
        );

        core.drain(None).unwrap();
        let posted = server
            .seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, path)| method == "POST" && path.ends_with("/steps/rows"))
            .count();
        assert_eq!(posted, 1, "the two writes were not sent as one batch");
        let queue = core.queue().unwrap();
        for id in [&first.id, &second.id] {
            let write = queue.iter().find(|write| &write.id == id).unwrap();
            assert!(
                matches!(write.verdict, Some(Verdict::Accepted)),
                "{id}: {:?}",
                write.verdict
            );
        }

        let undo = core
            .undo_rows(ITEM.into(), "steps".into(), BATCH.into())
            .unwrap();
        assert_eq!(undo.kind, WriteKind::UndoRows);
        core.drain(None).unwrap();
        let undone = core
            .queue()
            .unwrap()
            .into_iter()
            .find(|write| write.id == undo.id)
            .unwrap();
        assert!(
            matches!(undone.verdict, Some(Verdict::Accepted)),
            "{:?}",
            undone.verdict
        );
        assert!(
            server
                .seen
                .lock()
                .unwrap()
                .iter()
                .any(|(method, path)| method == "POST"
                    && path.ends_with(&format!("/batches/{BATCH}/undo")))
        );

        assert!(
            core.let_go_table("test.steps".into(), "steps".into())
                .unwrap()
        );
        assert!(core.held_tables().unwrap().tables.is_empty());
        assert!(
            !core
                .let_go_table("test.steps".into(), "steps".into())
                .unwrap()
        );
    }
}

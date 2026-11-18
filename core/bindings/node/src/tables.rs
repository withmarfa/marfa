//! The tables a working copy holds, and the reads of them it answers.

use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{MarfaCore, Stop, count, failure, flag_of, record, rethrown};

/// One pass over the tables a copy holds that are not whole.
#[napi(object)]
pub struct TableFill {
    pub whole: i64,
    pub online: i64,
    pub unfilled: i64,
    pub pages: i64,
    pub rows: i64,
    /// Tables whose read failed, each left to the next pass.
    pub failed: i64,
    /// The last of them, and why.
    pub failure: Option<String>,
}

impl From<marfa_core::FillReport> for TableFill {
    fn from(fill: marfa_core::FillReport) -> Self {
        TableFill {
            whole: count(fill.whole),
            online: count(fill.online),
            unfilled: count(fill.unfilled),
            pages: count(fill.pages),
            rows: count(fill.rows),
            failed: count(fill.failed),
            failure: fill.failure,
        }
    }
}

/// A table the copy holds, or held, whose state or rows changed.
#[napi(object)]
pub struct ChangedTable {
    pub item: String,
    pub table: String,
}

impl From<marfa_core::ChangedTable> for ChangedTable {
    fn from(changed: marfa_core::ChangedTable) -> Self {
        ChangedTable {
            item: changed.item,
            table: changed.table,
        }
    }
}

/// A read of a table's rows, as `GET /items/{id}/tables/{table}/rows` takes it.
#[napi(object)]
pub struct RowsAsked {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    pub filter: Option<String>,
    pub sort: Option<String>,
    pub direction: Option<String>,
}

/// What a count counts: name exactly one.
#[napi(object)]
pub struct Counted {
    /// An edge type: the items an edge of it leaves each item for.
    pub backref: Option<String>,
    /// An edge type: the items with an edge of it to each item.
    pub edge: Option<String>,
    /// A table name: the rows each item holds in it.
    pub table: Option<String>,
}

impl Counted {
    fn named(self) -> marfa_core::Result<marfa_core::Counted> {
        match (self.backref, self.edge, self.table) {
            (Some(edge_type), None, None) => Ok(marfa_core::Counted::Backref(edge_type)),
            (None, Some(edge_type), None) => Ok(marfa_core::Counted::Edge(edge_type)),
            (None, None, Some(table)) => Ok(marfa_core::Counted::Table(table)),
            _ => Err(marfa_core::CoreError::Validation {
                server: None,
                code: "validation_error".into(),
                message: "name exactly one of backref, edge and table".into(),
                details: None,
            }),
        }
    }
}

type Call = Box<dyn FnOnce(&marfa_core::Core) -> marfa_core::Result<serde_json::Value> + Send>;

/// A JSON answer, handed to JavaScript as the object it is.
pub struct Answer(serde_json::Value);

impl TypeName for Answer {
    fn type_name() -> &'static str {
        "Object"
    }

    fn value_type() -> ValueType {
        ValueType::Object
    }
}

impl ToNapiValue for Answer {
    unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> Result<sys::napi_value> {
        // SAFETY: `env` is the environment napi handed this call.
        unsafe { serde_json::Value::to_napi_value(env, value.0) }
    }
}

pub struct TableCall {
    core: Arc<marfa_core::Core>,
    call: Option<Call>,
    failed: Option<marfa_core::CoreError>,
}

#[napi]
impl Task for TableCall {
    type Output = serde_json::Value;
    type JsValue = Answer;

    fn compute(&mut self) -> Result<Self::Output> {
        let call = self
            .call
            .take()
            .ok_or_else(|| Error::from_reason("a table call ran twice"))?;
        call(&self.core).map_err(|error| record(&mut self.failed, error))
    }

    fn resolve(&mut self, _: Env, value: Self::Output) -> Result<Self::JsValue> {
        Ok(Answer(value))
    }

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }
}

#[napi]
impl MarfaCore {
    fn table_call(&self, call: Call) -> AsyncTask<TableCall> {
        AsyncTask::new(TableCall {
            core: Arc::clone(&self.inner),
            call: Some(call),
            failed: None,
        })
    }

    /// Holds matching tables and fills them, or leaves them to the follow or
    /// catch-up that holds the stream.
    #[napi(
        ts_return_type = "Promise<{ type: string; table: string; was_held: boolean; fill: TableFill | null }>"
    )]
    pub fn hold_table(
        &self,
        type_id: String,
        table: String,
        stop: Option<&Stop>,
    ) -> AsyncTask<TableCall> {
        let stop = flag_of(stop);
        self.table_call(Box::new(move |core| {
            Ok(serde_json::to_value(
                core.hold_table_until(&type_id, &table, &stop)?,
            )?)
        }))
    }

    /// Removes the rows the copy holds of a table it held; answers whether it was held.
    #[napi]
    pub fn let_go_table(&self, env: Env, type_id: String, table: String) -> Result<bool> {
        self.inner
            .let_go_table(&type_id, &table)
            .map_err(|error| failure(env, error))
    }

    #[napi(
        ts_return_type = "{ choices: { type: string; table: string }[]; tables: { item: string; table: string; state: string; rows: number }[] }"
    )]
    pub fn held_tables(&self, env: Env) -> Result<serde_json::Value> {
        self.inner
            .held_tables()
            .and_then(|held| Ok(serde_json::to_value(held)?))
            .map_err(|error| failure(env, error))
    }

    #[napi(ts_return_type = "Promise<TableFill>")]
    pub fn fill_tables(&self, stop: Option<&Stop>) -> AsyncTask<TableCall> {
        let stop = flag_of(stop);
        self.table_call(Box::new(move |core| {
            Ok(serde_json::to_value(core.fill_tables(&stop)?)?)
        }))
    }

    /// Reads a page, with `held` indicating whether the copy answered it.
    #[napi(ts_return_type = "Promise<Record<string, unknown>>")]
    pub fn table_rows(
        &self,
        item: String,
        table: String,
        asked: Option<RowsAsked>,
    ) -> AsyncTask<TableCall> {
        let asked = asked.map_or_else(marfa_core::RowsAsked::default, |asked| {
            marfa_core::RowsAsked {
                limit: asked.limit,
                cursor: asked.cursor,
                filter: asked.filter,
                sort: asked.sort,
                direction: asked.direction,
            }
        });
        self.table_call(Box::new(move |core| core.table_rows(&item, &table, &asked)))
    }

    /// Queues one batch of row operations, laid over the copy where it holds the table whole.
    #[napi]
    pub fn write_rows(
        &self,
        env: Env,
        item: String,
        table: String,
        operations: Vec<serde_json::Value>,
    ) -> Result<crate::QueuedWrite> {
        crate::queued(
            env,
            self.inner
                .write_rows(&item, &table, &operations)
                .map_err(|error| failure(env, error))?,
        )
    }

    /// Queues an undo of a batch.
    #[napi]
    pub fn undo_rows(
        &self,
        env: Env,
        item: String,
        table: String,
        batch: String,
    ) -> Result<crate::QueuedWrite> {
        crate::queued(
            env,
            self.inner
                .undo_rows(&item, &table, &batch)
                .map_err(|error| failure(env, error))?,
        )
    }

    #[napi(ts_return_type = "Promise<Record<string, unknown>>")]
    pub fn table_row(&self, item: String, table: String, row: String) -> AsyncTask<TableCall> {
        self.table_call(Box::new(move |core| core.table_row(&item, &table, &row)))
    }

    #[napi(ts_return_type = "Promise<Record<string, unknown>>")]
    pub fn table_totals(
        &self,
        item: String,
        table: String,
        filter: Option<String>,
    ) -> AsyncTask<TableCall> {
        self.table_call(Box::new(move |core| {
            core.table_totals(&item, &table, filter.as_deref())
        }))
    }

    /// Counts from the copy where possible. On `not_answerable`, call `servedCounts(ids, counted)`.
    #[napi(
        ts_return_type = "Promise<{ counts: { id: string; total: number; status_groups?: { not_started: number; in_progress: number; completed: number; canceled: number }; held: boolean }[] }>"
    )]
    pub fn counts(&self, ids: Vec<String>, counted: Counted) -> AsyncTask<TableCall> {
        self.table_call(Box::new(move |core| {
            Ok(serde_json::json!({ "counts": core.counts(&ids, &counted.named()?)? }))
        }))
    }

    /// Requests every count from the copy's server. Each result has `held` set to false.
    #[napi(
        ts_return_type = "Promise<{ counts: { id: string; total: number; status_groups?: { not_started: number; in_progress: number; completed: number; canceled: number }; held: boolean }[] }>"
    )]
    pub fn served_counts(&self, ids: Vec<String>, counted: Counted) -> AsyncTask<TableCall> {
        self.table_call(Box::new(move |core| {
            Ok(serde_json::json!({ "counts": core.served_counts(&ids, &counted.named()?)? }))
        }))
    }
}

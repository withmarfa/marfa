use clap::{Args, Subcommand};
use serde_json::{Value, json};

use super::items::IdempotencyArgs;
use super::{BodySource, PageArgs, object};
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;
use crate::values::SortDirection;

#[derive(Debug, Subcommand)]
pub enum RowsCommand {
    /// One page of a table's rows, in the table's own order unless a sort is
    /// given, and by id for a table that names none. Pass the answer's
    /// `next_cursor` as `--cursor` for the next page.
    List(ListArgs),
    /// One row of a table.
    Get {
        /// The item id.
        item: String,
        /// The table name.
        table: String,
        /// The row id.
        row: String,
    },
    /// Apply a batch of `put`, `patch` and `delete` operations to a table,
    /// all of them or none. The batch is a JSON object holding `operations`,
    /// up to 1000, applied in order.
    Write {
        /// The item id.
        item: String,
        /// The table name.
        table: String,
        #[command(flatten)]
        body: BodySource,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Write one whole row: create it, or replace the row `--id` names.
    Put {
        /// The item id.
        item: String,
        /// The table name.
        table: String,
        /// The row id to write; the server makes one when it is left out.
        #[arg(long)]
        id: Option<String>,
        /// The row's values as a JSON object, keyed by column.
        #[arg(long, value_name = "JSON")]
        values: String,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Set the columns named on one row, leaving the others as they are.
    /// A `null` value clears a column.
    Patch {
        /// The item id.
        item: String,
        /// The table name.
        table: String,
        /// The row id.
        row: String,
        /// The values to set as a JSON object, keyed by column.
        #[arg(long, value_name = "JSON")]
        values: String,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Delete one or more rows, all of them or none. A row that is not there
    /// is answered `absent`.
    Delete {
        /// The item id.
        item: String,
        /// The table name.
        table: String,
        /// One or more row ids.
        #[arg(required = true)]
        rows: Vec<String>,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// How many rows a filter selects, and the total of each column that
    /// names `adds_up`.
    Totals {
        /// The item id.
        item: String,
        /// The table name.
        table: String,
        /// Only the rows this expression matches, in the server's filter
        /// grammar, where `values.<column>` names a column. Unset totals
        /// every row.
        #[arg(long)]
        filter: Option<String>,
    },
    /// One page of the batches a table's change log holds, newest first, with
    /// how many rows each changed and the batch it undid. Pass the answer's
    /// `next_cursor` as `--cursor` for the next page.
    Batches {
        /// The item id.
        item: String,
        /// The table name.
        table: String,
        #[command(flatten)]
        page: PageArgs,
    },
    /// Put back every row a batch changed as it was before the batch, all of
    /// them or none, as a new batch. Undo an undo to redo it.
    Undo {
        /// The item id.
        item: String,
        /// The table name.
        table: String,
        /// The batch id, as a write or `rows batches` answers it.
        batch: String,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
}

#[derive(Debug, Default, Args)]
pub struct ListArgs {
    /// The item id.
    pub item: String,
    /// The table name.
    pub table: String,
    /// Only the rows this expression matches, in the server's filter grammar,
    /// where `values.<column>` names a column, and `id` and `updated_at` are
    /// the row's own.
    #[arg(long)]
    pub filter: Option<String>,
    /// What to order by: `id`, `updated_at` or `values.<column>`. The default
    /// is the table's own order, or `id` for a table that names none.
    #[arg(long, value_name = "FIELD")]
    pub sort: Option<String>,
    /// `asc` or `desc`; the server's default is `asc`.
    #[arg(long)]
    pub direction: Option<SortDirection>,
    #[command(flatten)]
    pub page: PageArgs,
}

pub fn list_request(args: &ListArgs) -> Request {
    Request::get(&["items", &args.item, "tables", &args.table, "rows"])
        .query_opt("filter", args.filter.clone())
        .query_opt("sort", args.sort.clone())
        .query_opt("direction", args.direction.map(SortDirection::as_str))
        .query_opt("limit", args.page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", args.page.cursor.clone())
}

pub fn get_request(item: &str, table: &str, row: &str) -> Request {
    Request::get(&["items", item, "tables", table, "rows", row])
}

pub fn write_request(item: &str, table: &str, batch: Value) -> Result<Request, CliError> {
    let Some(operations) = batch.get("operations").filter(|_| batch.is_object()) else {
        return Err(CliError::Invalid(
            "a batch is a JSON object holding `operations`, a list of put, patch and delete operations"
                .into(),
        ));
    };
    if !operations.is_array() {
        return Err(CliError::Invalid("`operations` is a list".into()));
    }
    Ok(Request::post(&["items", item, "tables", table, "rows"]).json(batch))
}

fn one_operation(item: &str, table: &str, operation: Value) -> Result<Request, CliError> {
    write_request(item, table, json!({ "operations": [operation] }))
}

pub fn put_request(
    item: &str,
    table: &str,
    id: Option<&str>,
    values: &str,
) -> Result<Request, CliError> {
    let mut operation = json!({ "op": "put", "values": object(values, "--values")? });
    if let Some(id) = id {
        operation["id"] = json!(id);
    }
    one_operation(item, table, operation)
}

pub fn patch_request(
    item: &str,
    table: &str,
    row: &str,
    values: &str,
) -> Result<Request, CliError> {
    one_operation(
        item,
        table,
        json!({ "op": "patch", "id": row, "values": object(values, "--values")? }),
    )
}

pub fn delete_request(item: &str, table: &str, rows: &[String]) -> Result<Request, CliError> {
    let operations: Vec<Value> = rows
        .iter()
        .map(|row| json!({ "op": "delete", "id": row }))
        .collect();
    write_request(item, table, json!({ "operations": operations }))
}

pub fn totals_request(item: &str, table: &str, filter: Option<&str>) -> Request {
    Request::get(&["items", item, "tables", table, "totals"])
        .query_opt("filter", filter.map(str::to_string))
}

pub fn batches_request(item: &str, table: &str, page: &PageArgs) -> Request {
    Request::get(&["items", item, "tables", table, "batches"])
        .query_opt("limit", page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", page.cursor.clone())
}

pub fn undo_request(item: &str, table: &str, batch: &str) -> Request {
    Request::post(&["items", item, "tables", table, "batches", batch, "undo"])
}

/// Paths within the one row `put` or `patch` sent, not its place in the batch.
pub fn for_one_row(error: CliError) -> CliError {
    let CliError::Refused {
        status,
        code,
        message,
        retry_after_seconds,
        mut details,
    } = error
    else {
        return error;
    };
    let message = strip_batch_place(&message).unwrap_or(message);
    if let Some(Value::Object(map)) = details.as_deref_mut() {
        map.remove("operation");
        if let Some(Value::Array(errors)) = map.get_mut("errors") {
            for entry in errors.iter_mut().filter_map(Value::as_object_mut) {
                let path = entry.get("path").and_then(Value::as_str);
                match path.map(|path| path.strip_prefix("operations.0")) {
                    Some(Some("")) => {
                        entry.remove("path");
                    }
                    Some(Some(rest)) if rest.starts_with('.') => {
                        entry.insert("path".into(), json!(&rest[1..]));
                    }
                    _ => {}
                }
            }
        }
    }
    CliError::Refused {
        status,
        code,
        message,
        retry_after_seconds,
        details,
    }
}

fn strip_batch_place(message: &str) -> Option<String> {
    let rest = message.strip_prefix("operations.0")?;
    rest.strip_prefix(": ")
        .or_else(|| rest.strip_prefix('.'))
        .map(str::to_string)
}

pub fn run(command: RowsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let one_row = matches!(command, RowsCommand::Put { .. } | RowsCommand::Patch { .. });
    let request = match &command {
        RowsCommand::List(args) => list_request(args),
        RowsCommand::Get { item, table, row } => get_request(item, table, row),
        RowsCommand::Write {
            item,
            table,
            body,
            idempotency,
        } => idempotency.apply(write_request(item, table, body.read()?)?),
        RowsCommand::Put {
            item,
            table,
            id,
            values,
            idempotency,
        } => idempotency.apply(put_request(item, table, id.as_deref(), values)?),
        RowsCommand::Patch {
            item,
            table,
            row,
            values,
            idempotency,
        } => idempotency.apply(patch_request(item, table, row, values)?),
        RowsCommand::Delete {
            item,
            table,
            rows,
            idempotency,
        } => idempotency.apply(delete_request(item, table, rows)?),
        RowsCommand::Totals {
            item,
            table,
            filter,
        } => totals_request(item, table, filter.as_deref()),
        RowsCommand::Batches { item, table, page } => batches_request(item, table, page),
        RowsCommand::Undo {
            item,
            table,
            batch,
            idempotency,
        } => idempotency.apply(undo_request(item, table, batch)),
    };
    let all = match &command {
        RowsCommand::List(args) => args.page.all,
        RowsCommand::Batches { page, .. } => page.all,
        _ => false,
    };
    let answer = remote
        .pages(&request, all)
        .map_err(|error| if one_row { for_one_row(error) } else { error })?;
    let table = match &command {
        RowsCommand::Write { table, .. }
        | RowsCommand::Put { table, .. }
        | RowsCommand::Patch { table, .. }
        | RowsCommand::Delete { table, .. }
        | RowsCommand::Undo { table, .. } => Some(table),
        _ => None,
    };
    match table {
        Some(table) => out.report(&answer, |answer| super::said::rows(table, answer)),
        None => out.value(&answer),
    }
}

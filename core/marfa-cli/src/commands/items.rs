use std::collections::HashMap;
use std::path::PathBuf;

use clap::{Args, Subcommand, ValueEnum};
use marfa_core::{file_type_for, mime_type_for};
use serde_json::{Map, Value, json};

use super::{PageArgs, PropertyArgs, StateFilter, TierFilter, insert_opt, object};
use crate::error::CliError;
use crate::output::{self, Printer};
use crate::remote::Remote;
use crate::remote::request::Request;
use crate::values::{ItemState, SortDirection, SortField, Tier};

#[derive(Debug, Subcommand)]
pub enum ItemsCommand {
    /// List items on the server, a page at a time.
    List(ListArgs),
    /// One item by id.
    Get {
        /// The item id.
        id: String,
        /// Extra to hydrate onto the item: `edges`, `metadata`, or both comma-separated.
        #[arg(long, value_name = "LIST")]
        include: Option<String>,
    },
    /// Create an item.
    Create(CreateArgs),
    /// Change an item's properties or fields, conditional on the version read.
    Update(UpdateArgs),
    /// Move an item to the bin.
    Delete {
        /// The item id.
        id: String,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Take an item out of the bin.
    Restore {
        /// The item id.
        id: String,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Move an item to another lifecycle state.
    Transition {
        /// The item id.
        id: String,
        /// The state to move it to.
        #[arg(long)]
        state: TransitionState,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Destroy a trashed item irrecoverably. Needs `items.purge`.
    Purge {
        /// The item id.
        id: String,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// One page of the snapshots an item's history holds, oldest first.
    /// Pass the answer's `next_cursor` as `--cursor` for the next page.
    Versions {
        /// The item id.
        id: String,
        #[command(flatten)]
        page: PageArgs,
    },
    /// Put tags on an item.
    Tag {
        /// The item id.
        id: String,
        /// One or more tags.
        #[arg(required = true)]
        tags: Vec<String>,
    },
    /// Take one tag off an item.
    Untag {
        /// The item id.
        id: String,
        /// The tag to take off.
        tag: String,
    },
    /// The edges leaving an item.
    Edges(ItemEdgesArgs),
    /// The edges arriving at an item.
    Backrefs(ItemEdgesArgs),
    /// Add a file as an item of its own: upload its bytes and create a file
    /// item for them.
    Add(AddArgs),
    /// Attach a file: upload its bytes, create a file item for them, and link
    /// it to the target with an `attached-to` edge.
    Attach(AttachArgs),
    /// Item counts, by state or by type.
    Stats {
        /// What to count by.
        #[arg(long)]
        by: Option<StatsBy>,
    },
    /// Occurrences of `core.event` items in a window.
    Occurrences {
        /// The window's start, RFC 3339.
        #[arg(long, value_name = "TIME")]
        from: String,
        /// The window's end, RFC 3339.
        #[arg(long, value_name = "TIME")]
        to: String,
        /// A type identifier to narrow to.
        #[arg(long = "type", value_name = "TYPE")]
        type_: Option<String>,
    },
    /// Upsert many items in one request.
    Bulk(BulkArgs),
    /// Read many items by id in one request.
    BulkGet {
        /// The item ids.
        #[arg(required = true)]
        ids: Vec<String>,
        /// Extra to hydrate onto each item: `edges`, `metadata`.
        #[arg(long, value_name = "NAME")]
        include: Vec<String>,
    },
    /// Items by link, natural key or id, in every state, with the
    /// tombstones purges left for the keys named.
    Lookup {
        /// The type the links are held in and the tombstones kept under.
        #[arg(long = "type", value_name = "TYPE")]
        type_: String,
        /// A link value; repeat for more.
        #[arg(long = "link", value_name = "VALUE")]
        links: Vec<String>,
        /// The source the `--source-id` natural keys are under.
        #[arg(long, value_name = "SOURCE")]
        source: Option<String>,
        /// A natural key's `source_id`; repeat for more.
        #[arg(long = "source-id", value_name = "ID")]
        source_ids: Vec<String>,
        /// An item id; repeat for more.
        #[arg(long = "id", value_name = "ID")]
        ids: Vec<String>,
        /// Extra to hydrate onto each item: `edges`.
        #[arg(long, value_name = "NAME")]
        include: Vec<String>,
    },
    /// Settle the tombstones purges left at a later time.
    Tombstones {
        /// The type the tombstones are kept under.
        #[arg(long = "type", value_name = "TYPE")]
        type_: String,
        /// A link value; repeat for more.
        #[arg(long = "link", value_name = "VALUE")]
        links: Vec<String>,
        /// The source the `--source-id` natural keys are under.
        #[arg(long, value_name = "SOURCE")]
        source: Option<String>,
        /// A natural key's `source_id`; repeat for more.
        #[arg(long = "source-id", value_name = "ID")]
        source_ids: Vec<String>,
        /// The vendor-side change time, RFC 3339; one earlier than a
        /// tombstone holds leaves it as it is.
        #[arg(long = "settled-at", value_name = "TIME")]
        settled_at: String,
    },
    /// Apply one action to every item a filter selects, as a job.
    #[command(name = "bulk-action")]
    BulkAction {
        #[command(subcommand)]
        command: BulkActionCommand,
    },
}

/// No `revoked`: only the server revokes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum TransitionState {
    Active,
    Archived,
    Trashed,
}

impl TransitionState {
    fn as_str(self) -> &'static str {
        match self {
            TransitionState::Active => "active",
            TransitionState::Archived => "archived",
            TransitionState::Trashed => "trashed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum StatsBy {
    State,
    Type,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Conflict {
    Auto,
    Manual,
    Callback,
}

/// The key a write is answered from the server's record under, when sent
/// again. Optional on every write operation that takes it.
#[derive(Debug, Default, Args)]
pub struct IdempotencyArgs {
    /// Sent as `Idempotency-Key`, so a repeat is answered from the record
    /// rather than written twice.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

impl IdempotencyArgs {
    pub fn apply(&self, request: Request) -> Request {
        match &self.idempotency_key {
            Some(key) => request.header("Idempotency-Key", key.clone()),
            None => request,
        }
    }
}

#[derive(Debug, Default, Args)]
pub struct ListArgs {
    /// A type identifier; its subtypes are included.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// One state, or `any`. Unset answers the active state.
    #[arg(long)]
    pub state: Option<StateFilter>,
    /// The source the items were written under.
    #[arg(long)]
    pub source: Option<String>,
    /// One tier, or `all`.
    #[arg(long)]
    pub tier: Option<TierFilter>,
    /// Items must carry every tag given.
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    /// A property filter in the server's filter grammar.
    #[arg(long)]
    pub filter: Option<String>,
    /// The field to order by; the server's default is the creation time.
    #[arg(long)]
    pub sort: Option<SortField>,
    /// `asc` or `desc`; the server's default is newest first.
    #[arg(long)]
    pub direction: Option<SortDirection>,
    /// Exclusive lower bound on the item's own time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub occurred_after: Option<String>,
    /// Exclusive upper bound on the item's own time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub occurred_before: Option<String>,
    /// Inclusive lower bound on the modification time: the catch-up filter.
    #[arg(long, value_name = "TIME")]
    pub updated_after: Option<String>,
    /// Exclusive upper bound on the modification time.
    #[arg(long, value_name = "TIME")]
    pub updated_before: Option<String>,
    /// Extra to hydrate onto each item: `edges`, `metadata`.
    #[arg(long, value_name = "NAME")]
    pub include: Vec<String>,
    #[command(flatten)]
    pub page: PageArgs,
}

#[derive(Debug, Default, Args)]
pub struct CreateArgs {
    /// The type the item is.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: String,
    #[command(flatten)]
    pub properties: PropertyArgs,
    /// A tag, repeatable.
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    /// The tier to write it at; the server's default is the library.
    #[arg(long)]
    pub tier: Option<Tier>,
    /// The state to create it in.
    #[arg(long)]
    pub state: Option<ItemState>,
    /// The item's own time, RFC 3339. Defaults to now.
    #[arg(long, value_name = "TIME")]
    pub occurred_at: Option<String>,
    /// The source to key and stamp it with: the key's own, or one it claims.
    /// Any other is refused.
    #[arg(long)]
    pub source: Option<String>,
    /// The id this row has in the system it came from: the natural key.
    #[arg(long)]
    pub source_id: Option<String>,
    /// The id to mint it under. Omitted, the server mints one.
    #[arg(long)]
    pub id: Option<String>,
    /// The version this create is conditional on, where its natural key
    /// resolves a row the server already holds.
    #[arg(long)]
    pub version: Option<i64>,
    /// Edges to write with it, as the JSON object the operation takes.
    #[arg(long, value_name = "JSON")]
    pub edges: Option<String>,
    #[command(flatten)]
    pub idempotency: IdempotencyArgs,
}

#[derive(Debug, Default, Args)]
pub struct UpdateArgs {
    /// The item id.
    pub id: String,
    /// The version the edit was based on. Required: the server refuses an
    /// update that names no version.
    #[arg(long)]
    pub version: i64,
    #[command(flatten)]
    pub properties: PropertyArgs,
    /// Replace the properties whole instead of merging the ones given.
    #[arg(long)]
    pub replace: bool,
    /// Move the item to this type.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// Let the type change even where the target type is enforced.
    #[arg(long)]
    pub retype: bool,
    /// The tier to move the item to.
    #[arg(long)]
    pub tier: Option<Tier>,
    /// The item's own time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub occurred_at: Option<String>,
    /// The natural key to move the row to. The server refuses one another
    /// item already holds.
    #[arg(long, value_name = "KEY")]
    pub source_id: Option<String>,
    /// Edges to write with it, as the JSON object the operation takes.
    #[arg(long, value_name = "JSON")]
    pub edges: Option<String>,
    /// How a colliding write is settled: `auto` asks the server to resolve
    /// within its own transaction.
    #[arg(long)]
    pub conflict: Option<Conflict>,
    #[command(flatten)]
    pub idempotency: IdempotencyArgs,
}

#[derive(Debug, Default, Args)]
pub struct ItemEdgesArgs {
    /// The item id.
    pub id: String,
    /// Only edges of this type.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    #[command(flatten)]
    pub page: PageArgs,
}

#[derive(Debug, Default, Args)]
pub struct AddArgs {
    /// The file to add.
    pub file: PathBuf,
    /// The file's MIME type. Guessed from the extension when omitted.
    #[arg(long, value_name = "TYPE")]
    pub mime_type: Option<String>,
    /// The file item's title. Defaults to the file's name.
    #[arg(long)]
    pub title: Option<String>,
    /// The file item's type. Defaults to `core.file`, or the image, audio or
    /// video subtype when the MIME type says.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// A tag, repeatable.
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    /// The tier to write it at; the server's default is the library.
    #[arg(long)]
    pub tier: Option<Tier>,
}

#[derive(Debug, Default, Args)]
pub struct AttachArgs {
    /// The item the file belongs to.
    pub id: String,
    /// The file to attach.
    pub file: PathBuf,
    /// The file's MIME type. Guessed from the extension when omitted.
    #[arg(long, value_name = "TYPE")]
    pub mime_type: Option<String>,
    /// The file item's title. Defaults to the file's name.
    #[arg(long)]
    pub title: Option<String>,
    /// The file item's type. Defaults to `core.file`, or the image, audio or
    /// video subtype when the MIME type says.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
}

#[derive(Debug, Default, Args)]
pub struct BulkArgs {
    /// A JSON file holding the items, or the whole body with `items` in it;
    /// `-` reads stdin.
    #[arg(long, value_name = "PATH")]
    pub file: PathBuf,
    /// `upsert` or `create_only`.
    #[arg(long)]
    pub mode: Option<String>,
    /// Refuse the whole request if any entry is refused.
    #[arg(long)]
    pub atomic: bool,
    /// Do not deliver the writes to webhooks.
    #[arg(long)]
    pub no_fanout: bool,
    /// Let entries change the type of the rows they land on.
    #[arg(long)]
    pub retype: bool,
}

/// The filter a bulk action selects by, the same grammar `items list` takes
/// minus the sort and the page.
#[derive(Debug, Default, Args)]
pub struct BulkFilterArgs {
    /// A type identifier; its subtypes are included.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// One state. Unset excludes the bin, as a listing does; there is no
    /// `any` on this operation.
    #[arg(long)]
    pub state: Option<ItemState>,
    /// The source the items were written under.
    #[arg(long)]
    pub source: Option<String>,
    /// One tier.
    #[arg(long)]
    pub tier: Option<Tier>,
    /// Items must carry every tag given.
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    /// Exclusive lower bound on the item's own time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub occurred_after: Option<String>,
    /// Exclusive upper bound on the item's own time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub occurred_before: Option<String>,
    /// A property filter in the server's filter grammar.
    #[arg(long)]
    pub filter: Option<String>,
    /// Report what the action would touch and touch nothing.
    #[arg(long)]
    pub dry_run: bool,
    /// Refuse if more than this many items match.
    #[arg(long)]
    pub max_items: Option<u64>,
    /// Do not deliver the writes to webhooks.
    #[arg(long)]
    pub no_fanout: bool,
}

#[derive(Debug, Subcommand)]
pub enum BulkActionCommand {
    /// Move every matching item to a state.
    Transition {
        /// The state to move them to.
        #[arg(long = "to", value_name = "STATE")]
        to: TransitionState,
        #[command(flatten)]
        filter: BulkFilterArgs,
    },
    /// Destroy every matching item that is in the trash when the job reaches it; any other
    /// match is left as it is and reported. Match the bin with `--state trashed`. Needs
    /// `items.purge` and `--confirm PURGE`.
    Purge {
        /// The word `PURGE`, because the operation asks for it out loud.
        #[arg(long, value_name = "PURGE")]
        confirm: Option<String>,
        #[command(flatten)]
        filter: BulkFilterArgs,
    },
    /// Add tags to, and remove tags from, every matching item.
    Tags {
        /// A tag to add, repeatable.
        #[arg(long = "add", value_name = "TAG")]
        add: Vec<String>,
        /// A tag to remove, repeatable.
        #[arg(long = "remove", value_name = "TAG")]
        remove: Vec<String>,
        #[command(flatten)]
        filter: BulkFilterArgs,
    },
    /// Move every matching item to a tier.
    Tier {
        /// The tier to move them to.
        #[arg(long = "to", value_name = "TIER")]
        to: Tier,
        #[command(flatten)]
        filter: BulkFilterArgs,
    },
    /// Merge a patch into every matching item's properties.
    Properties {
        /// The patch, as a JSON object.
        #[arg(long, value_name = "JSON")]
        patch: String,
        #[command(flatten)]
        filter: BulkFilterArgs,
    },
    /// Set every matching item's own time.
    #[command(name = "occurred-at")]
    OccurredAt {
        /// The time to set, RFC 3339.
        #[arg(long, value_name = "TIME")]
        occurred_at: String,
        #[command(flatten)]
        filter: BulkFilterArgs,
    },
    /// A bulk-action job's state.
    Job {
        /// The job id.
        id: String,
    },
    /// Cancel a bulk-action job.
    Cancel {
        /// The job id.
        id: String,
    },
}

pub fn list_request(args: &ListArgs) -> Request {
    Request::get(&["items"])
        .query_opt("type", args.type_.clone())
        .query_opt("state", args.state.map(StateFilter::as_str))
        .query_opt("source", args.source.clone())
        .query_opt("tier", args.tier.map(TierFilter::as_str))
        .query_list("tags", &args.tags)
        .query_opt("filter", args.filter.clone())
        .query_opt("sort", args.sort.map(SortField::as_str))
        .query_opt("direction", args.direction.map(SortDirection::as_str))
        .query_opt("occurred_after", args.occurred_after.clone())
        .query_opt("occurred_before", args.occurred_before.clone())
        .query_opt("updated_after", args.updated_after.clone())
        .query_opt("updated_before", args.updated_before.clone())
        .query_list("include", &args.include)
        .query_opt("limit", args.page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", args.page.cursor.clone())
}

pub fn get_request(id: &str, include: Option<&str>) -> Request {
    Request::get(&["items", id]).query_opt("include", include.map(str::to_string))
}

pub fn create_request(args: &CreateArgs) -> Result<Request, CliError> {
    let mut body = Map::new();
    body.insert("type".into(), Value::String(args.type_.clone()));
    let properties = args.properties.read()?;
    if !properties.is_empty() {
        body.insert("properties".into(), Value::Object(properties));
    }
    if !args.tags.is_empty() {
        body.insert("tags".into(), json!(args.tags));
    }
    insert_opt(&mut body, "tier", args.tier.map(Tier::as_str));
    insert_opt(&mut body, "state", args.state.map(ItemState::as_str));
    insert_opt(&mut body, "occurred_at", args.occurred_at.clone());
    insert_opt(&mut body, "source", args.source.clone());
    insert_opt(&mut body, "source_id", args.source_id.clone());
    insert_opt(&mut body, "id", args.id.clone());
    insert_opt(&mut body, "version", args.version);
    if let Some(edges) = &args.edges {
        body.insert("edges".into(), Value::Object(object(edges, "--edges")?));
    }
    Ok(args
        .idempotency
        .apply(Request::post(&["items"]).json(Value::Object(body))))
}

pub fn update_request(args: &UpdateArgs) -> Result<Request, CliError> {
    let mut body = Map::new();
    body.insert("version".into(), Value::from(args.version));
    let properties = args.properties.read()?;
    if !args.properties.is_empty() {
        body.insert("properties".into(), Value::Object(properties));
    }
    if args.replace {
        body.insert("properties_mode".into(), Value::String("replace".into()));
    }
    insert_opt(&mut body, "type", args.type_.clone());
    if args.retype {
        body.insert("retype".into(), Value::Bool(true));
    }
    insert_opt(&mut body, "tier", args.tier.map(Tier::as_str));
    insert_opt(&mut body, "occurred_at", args.occurred_at.clone());
    insert_opt(&mut body, "source_id", args.source_id.clone());
    if let Some(edges) = &args.edges {
        body.insert("edges".into(), Value::Object(object(edges, "--edges")?));
    }
    let conflict = args.conflict.map(|conflict| match conflict {
        Conflict::Auto => "auto",
        Conflict::Manual => "manual",
        Conflict::Callback => "callback",
    });
    Ok(args.idempotency.apply(
        Request::patch(&["items", &args.id])
            .query_opt("conflict", conflict)
            .json(Value::Object(body)),
    ))
}

pub fn delete_request(id: &str) -> Request {
    Request::delete(&["items", id])
}

pub fn restore_request(id: &str) -> Request {
    Request::post(&["items", id, "restore"])
}

pub fn transition_request(id: &str, state: TransitionState) -> Request {
    Request::post(&["items", id, "transition"]).json(json!({ "state": state.as_str() }))
}

pub fn purge_request(id: &str) -> Request {
    Request::post(&["items", id, "purge"])
}

pub fn versions_request(id: &str, page: &PageArgs) -> Request {
    Request::get(&["items", id, "versions"])
        .query_opt("limit", page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", page.cursor.clone())
}

pub fn tag_request(id: &str, tags: &[String]) -> Request {
    Request::post(&["items", id, "tags"]).json(json!({ "tags": tags }))
}

pub fn untag_request(id: &str, tag: &str) -> Request {
    Request::delete(&["items", id, "tags", tag])
}

pub fn edges_request(args: &ItemEdgesArgs, inbound: bool) -> Request {
    let door = if inbound { "backrefs" } else { "edges" };
    Request::get(&["items", &args.id, door])
        .query_opt("edge_type", args.type_.clone())
        .query_opt("limit", args.page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", args.page.cursor.clone())
}

pub fn stats_request(by: Option<StatsBy>) -> Request {
    Request::get(&["items", "stats"]).query_opt(
        "by",
        by.map(|by| match by {
            StatsBy::State => "state",
            StatsBy::Type => "type",
        }),
    )
}

pub fn occurrences_request(from: &str, to: &str, type_: Option<&str>) -> Request {
    Request::get(&["occurrences"])
        .query("from", from)
        .query("to", to)
        .query_opt("type", type_.map(str::to_string))
}

pub fn bulk_request(args: &BulkArgs) -> Result<Request, CliError> {
    let text = super::read_text(&args.file)?;
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|error| CliError::Invalid(format!("the body is not JSON: {error}")))?;
    let mut body = match parsed {
        Value::Array(items) => {
            let mut body = Map::new();
            body.insert("items".into(), Value::Array(items));
            body
        }
        Value::Object(body) if body.contains_key("items") => body,
        _ => {
            return Err(CliError::Invalid(
                "the file holds neither an array of items nor an object with `items`".into(),
            ));
        }
    };
    insert_opt(&mut body, "mode", args.mode.clone());
    if args.atomic {
        body.insert("atomic".into(), Value::Bool(true));
    }
    if args.no_fanout {
        body.insert("enable_fanout".into(), Value::Bool(false));
    }
    if args.retype {
        body.insert("retype".into(), Value::Bool(true));
    }
    Ok(Request::post(&["items", "bulk"]).json(Value::Object(body)))
}

pub fn bulk_get_request(ids: &[String], include: &[String]) -> Request {
    let mut body = json!({ "ids": ids });
    if !include.is_empty() {
        body["include"] = json!(include);
    }
    Request::post(&["items", "bulk-get"]).json(body)
}

fn key_selector(
    type_: &str,
    links: &[String],
    source: Option<&str>,
    source_ids: &[String],
) -> Map<String, Value> {
    let mut body = Map::new();
    body.insert("type".into(), json!(type_));
    if !links.is_empty() {
        body.insert("links".into(), json!(links));
    }
    insert_opt(&mut body, "source", source);
    if !source_ids.is_empty() {
        body.insert("source_ids".into(), json!(source_ids));
    }
    body
}

pub fn lookup_request(
    type_: &str,
    links: &[String],
    source: Option<&str>,
    source_ids: &[String],
    ids: &[String],
    include: &[String],
) -> Request {
    let mut body = key_selector(type_, links, source, source_ids);
    if !ids.is_empty() {
        body.insert("ids".into(), json!(ids));
    }
    if !include.is_empty() {
        body.insert("include".into(), json!(include));
    }
    Request::post(&["items", "lookup"]).json(Value::Object(body))
}

pub fn tombstones_request(
    type_: &str,
    links: &[String],
    source: Option<&str>,
    source_ids: &[String],
    settled_at: &str,
) -> Request {
    let mut body = key_selector(type_, links, source, source_ids);
    body.insert("settled_at".into(), json!(settled_at));
    Request::post(&["items", "tombstones"]).json(Value::Object(body))
}

fn bulk_filter(args: &BulkFilterArgs) -> Map<String, Value> {
    let mut filter = Map::new();
    insert_opt(&mut filter, "type", args.type_.clone());
    insert_opt(&mut filter, "state", args.state.map(ItemState::as_str));
    insert_opt(&mut filter, "source", args.source.clone());
    insert_opt(&mut filter, "tier", args.tier.map(Tier::as_str));
    if !args.tags.is_empty() {
        filter.insert("tags".into(), json!(args.tags));
    }
    insert_opt(&mut filter, "occurred_after", args.occurred_after.clone());
    insert_opt(&mut filter, "occurred_before", args.occurred_before.clone());
    insert_opt(&mut filter, "filter", args.filter.clone());
    filter
}

fn bulk_action_body(action: &str, filter: &BulkFilterArgs, extra: Map<String, Value>) -> Value {
    let mut body = Map::new();
    body.insert("action".into(), Value::String(action.into()));
    let selected = bulk_filter(filter);
    if !selected.is_empty() {
        body.insert("filter".into(), Value::Object(selected));
    }
    if filter.dry_run {
        body.insert("dry_run".into(), Value::Bool(true));
    }
    insert_opt(&mut body, "max_items", filter.max_items);
    if filter.no_fanout {
        body.insert("enable_fanout".into(), Value::Bool(false));
    }
    body.extend(extra);
    Value::Object(body)
}

pub fn bulk_action_request(command: &BulkActionCommand) -> Result<Request, CliError> {
    let body = match command {
        BulkActionCommand::Transition { to, filter } => {
            let mut extra = Map::new();
            extra.insert("state".into(), Value::String(to.as_str().into()));
            bulk_action_body("transition", filter, extra)
        }
        BulkActionCommand::Purge { confirm, filter } => {
            let mut extra = Map::new();
            insert_opt(&mut extra, "confirm", confirm.clone());
            bulk_action_body("purge", filter, extra)
        }
        BulkActionCommand::Tags {
            add,
            remove,
            filter,
        } => {
            let mut extra = Map::new();
            if !add.is_empty() {
                extra.insert("add".into(), json!(add));
            }
            if !remove.is_empty() {
                extra.insert("remove".into(), json!(remove));
            }
            bulk_action_body("update_tags", filter, extra)
        }
        BulkActionCommand::Tier { to, filter } => {
            let mut extra = Map::new();
            extra.insert("tier".into(), Value::String(to.as_str().into()));
            bulk_action_body("update_tier", filter, extra)
        }
        BulkActionCommand::Properties { patch, filter } => {
            let mut extra = Map::new();
            extra.insert("patch".into(), Value::Object(object(patch, "--patch")?));
            bulk_action_body("update_properties", filter, extra)
        }
        BulkActionCommand::OccurredAt {
            occurred_at,
            filter,
        } => {
            let mut extra = Map::new();
            extra.insert("occurred_at".into(), Value::String(occurred_at.clone()));
            bulk_action_body("update_occurred_at", filter, extra)
        }
        BulkActionCommand::Job { id } => {
            return Ok(Request::get(&["items", "bulk-actions", "jobs", id]));
        }
        BulkActionCommand::Cancel { id } => {
            return Ok(Request::post(&[
                "items",
                "bulk-actions",
                "jobs",
                id,
                "cancel",
            ]));
        }
    };
    Ok(Request::post(&["items", "bulk-actions"]).json(body))
}

pub fn upload_request(path: &std::path::Path, mime_type: &str) -> Request {
    Request::post(&["blobs"]).file(path.to_path_buf(), mime_type.to_string())
}

pub fn file_item_request(args: &AttachArgs, mime_type: &str, hash: &str) -> Request {
    let body = file_item_body(
        &args.file,
        args.title.as_deref(),
        args.type_.as_deref(),
        mime_type,
        hash,
    );
    Request::post(&["items"]).json(Value::Object(body))
}

pub fn added_file_request(args: &AddArgs, mime_type: &str, hash: &str) -> Request {
    let mut body = file_item_body(
        &args.file,
        args.title.as_deref(),
        args.type_.as_deref(),
        mime_type,
        hash,
    );
    if !args.tags.is_empty() {
        body.insert("tags".into(), json!(args.tags));
    }
    insert_opt(&mut body, "tier", args.tier.map(Tier::as_str));
    Request::post(&["items"]).json(Value::Object(body))
}

fn file_item_body(
    file: &std::path::Path,
    title: Option<&str>,
    type_: Option<&str>,
    mime_type: &str,
    hash: &str,
) -> Map<String, Value> {
    let title = title.map(str::to_string).unwrap_or_else(|| {
        file.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into())
    });
    let mut body = Map::new();
    body.insert("type".into(), file_type_for(mime_type, type_).into());
    body.insert(
        "properties".into(),
        json!({ "blob_ref": hash, "mime_type": mime_type, "title": title }),
    );
    body
}

pub fn attached_to_request(file_item_id: &str, target_id: &str) -> Request {
    Request::post(&["edges"]).json(json!({
        "source_id": file_item_id,
        "target_id": target_id,
        "edge_type": "attached-to",
    }))
}

pub fn run(command: ItemsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let done = match &command {
        ItemsCommand::Delete { id, .. } => Some(format!("trashed {id}")),
        ItemsCommand::Purge { id, .. } => Some(format!("purged {id}")),
        _ => None,
    };
    let request = match &command {
        ItemsCommand::List(args) => list_request(args),
        ItemsCommand::Get { id, include } => get_request(id, include.as_deref()),
        ItemsCommand::Create(args) => create_request(args)?,
        ItemsCommand::Update(args) => update_request(args)?,
        ItemsCommand::Delete { id, idempotency } => idempotency.apply(delete_request(id)),
        ItemsCommand::Restore { id, idempotency } => idempotency.apply(restore_request(id)),
        ItemsCommand::Transition {
            id,
            state,
            idempotency,
        } => idempotency.apply(transition_request(id, *state)),
        ItemsCommand::Purge { id, idempotency } => idempotency.apply(purge_request(id)),
        ItemsCommand::Versions { id, page } => versions_request(id, page),
        ItemsCommand::Tag { id, tags } => tag_request(id, tags),
        ItemsCommand::Untag { id, tag } => untag_request(id, tag),
        ItemsCommand::Edges(args) => return edges(args, false, remote, out),
        ItemsCommand::Backrefs(args) => return edges(args, true, remote, out),
        ItemsCommand::Add(args) => return add(args, remote, out),
        ItemsCommand::Attach(args) => return attach(args, remote, out),
        ItemsCommand::Stats { by } => stats_request(*by),
        ItemsCommand::Occurrences { from, to, type_ } => {
            occurrences_request(from, to, type_.as_deref())
        }
        ItemsCommand::Bulk(args) => bulk_request(args)?,
        ItemsCommand::BulkGet { ids, include } => bulk_get_request(ids, include),
        ItemsCommand::Lookup {
            type_,
            links,
            source,
            source_ids,
            ids,
            include,
        } => lookup_request(type_, links, source.as_deref(), source_ids, ids, include),
        ItemsCommand::Tombstones {
            type_,
            links,
            source,
            source_ids,
            settled_at,
        } => tombstones_request(type_, links, source.as_deref(), source_ids, settled_at),
        ItemsCommand::BulkAction { command } => bulk_action_request(command)?,
    };
    let answer = remote.json(&request)?;
    match done {
        Some(sentence) => out.report(&answer, || sentence),
        None => out.value(&answer),
    }
}

/// The edge page carries only the other end's id, so the plain listing
/// reads each one's title.
fn edges(
    args: &ItemEdgesArgs,
    inbound: bool,
    remote: &Remote,
    out: &Printer,
) -> Result<(), CliError> {
    let page = remote.json(&edges_request(args, inbound))?;
    if out.json {
        return out.value(&page);
    }
    let mut ids: Vec<String> = page
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|edge| output::other_end(edge, inbound).to_string())
        .filter(|id| !id.is_empty())
        .collect();
    ids.sort_unstable();
    ids.dedup();
    let mut titles = HashMap::new();
    for chunk in ids.chunks(BULK_GET_LIMIT) {
        titles.extend(output::titles(&remote.json(&bulk_get_request(chunk, &[]))?));
    }
    out.line(&output::edges_from(&page, inbound, &titles))
}

/// The most ids `POST /items/bulk-get` takes in one request.
const BULK_GET_LIMIT: usize = 100;

/// A run that stops partway leaves the earlier steps standing; the blob is
/// content-addressed, so a retry uploads nothing new.
fn attach(args: &AttachArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let mime_type = mime_type_for(&args.file, args.mime_type.as_deref());
    let (blob, hash) = upload(&args.file, &mime_type, remote)?;
    let item = remote.json(&file_item_request(args, &mime_type, &hash))?;
    let (file_item, file_item_id) = file_item_of(&item)?;
    let edge = remote.json(&attached_to_request(&file_item_id, &args.id))?;
    out.report(
        &json!({ "blob": blob, "item": file_item, "edge": edge }),
        || {
            format!(
                "attached {} as {} ({}), linked to {}",
                args.file.display(),
                file_item_id,
                hash,
                args.id
            )
        },
    )
}

fn add(args: &AddArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let mime_type = mime_type_for(&args.file, args.mime_type.as_deref());
    let (blob, hash) = upload(&args.file, &mime_type, remote)?;
    let item = remote.json(&added_file_request(args, &mime_type, &hash))?;
    let (file_item, file_item_id) = file_item_of(&item)?;
    out.report(&json!({ "blob": blob, "item": file_item }), || {
        format!(
            "added {} as {} ({})",
            args.file.display(),
            file_item_id,
            hash
        )
    })
}

fn upload(
    file: &std::path::Path,
    mime_type: &str,
    remote: &Remote,
) -> Result<(Value, String), CliError> {
    let blob = remote.json(&upload_request(file, mime_type))?;
    let hash = blob
        .get("hash")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CliError::Invalid("the upload answered no hash, so nothing can reference it".into())
        })?
        .to_string();
    Ok((blob, hash))
}

fn file_item_of(answer: &Value) -> Result<(&Value, String), CliError> {
    let file_item = answer.get("item").ok_or_else(|| {
        CliError::Invalid("the file item was created without an item in the answer".into())
    })?;
    let id = file_item
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CliError::Invalid("the file item was created without an id in the answer".into())
        })?
        .to_string();
    Ok((file_item, id))
}

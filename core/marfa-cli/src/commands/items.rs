use std::collections::HashMap;
use std::path::PathBuf;

use clap::{Args, Subcommand, ValueEnum};
use marfa_core::http::BULK_GET_LIMIT;
use marfa_core::{file_type_for, mime_type_for};
use serde_json::{Map, Value, json};

use super::duplicate::{self, Added, IfDuplicate};
use super::{PageArgs, PropertyArgs, StateFilter, TierFilter, insert_opt, object, state_list};
use crate::error::CliError;
use crate::output::{self, Printer, printable};
use crate::remote::Remote;
use crate::remote::request::Request;
use crate::values::{ItemState, SortDirection, Tier, parse_sort_field};

#[derive(Debug, Subcommand)]
pub enum ItemsCommand {
    /// List items on the server, a page at a time.
    List(ListArgs),
    /// Item names, sources and creation times, newest first, of the types
    /// the credential reads.
    Summaries {
        /// Only items of this exact type.
        #[arg(long = "type", value_name = "TYPE")]
        type_: Option<String>,
        /// Text to find in item names, ignoring case.
        #[arg(long)]
        query: Option<String>,
        #[command(flatten)]
        page: PageArgs,
    },
    /// Read and empty the bin, as far as the credential reads its types.
    /// Requires `items.purge`.
    Bin {
        #[command(subcommand)]
        command: BinCommand,
    },
    /// One item by id, in any state, the bin included.
    Get {
        /// The item id.
        id: String,
        /// Extra to add to the item: `backrefs`, `neighbors` or `versions`; repeatable.
        #[arg(long, value_name = "NAME")]
        include: Vec<String>,
    },
    /// Print an item's link, one line, or open it. The link is the address the
    /// item's own server gives, the bin included.
    Link {
        /// The item id.
        id: String,
        /// Give the link that opens the item in a Marfa app on this device,
        /// `marfa://` and the instance and item ids, in place of the address
        /// that opens in a browser.
        #[arg(long)]
        app: bool,
        /// Open the link with the system's opener in place of printing it. If
        /// nothing opens it, the link is printed and the command fails.
        #[arg(long)]
        open: bool,
    },
    /// Create an item.
    Create(CreateArgs),
    /// Change an item's properties or fields, conditional on the version read.
    Update(UpdateArgs),
    /// Move one or more items to the bin, all of them or none. With `--socket`,
    /// name one item and its `--version` from `items summaries`.
    Trash {
        /// One or more item ids, up to 20.
        #[arg(required = true, value_name = "ID")]
        ids: Vec<String>,
        /// The version you read, for one item. If the item has changed since,
        /// nothing is moved. With `--socket` it is required.
        #[arg(long, conflicts_with_all = ["dry_run", "digest"])]
        version: Option<i64>,
        /// Show what the trash would move to the bin, the items beneath
        /// included, and move nothing.
        #[arg(long, conflicts_with_all = ["idempotency_key", "version"])]
        dry_run: bool,
        /// The digest `--dry-run` gave for the same ids. If what the trash
        /// would move to the bin has changed since, nothing is moved.
        #[arg(long, conflicts_with = "dry_run")]
        digest: Option<String>,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Take an item out of the bin. With `--socket`, name its `--version` from
    /// `items bin list`.
    Restore {
        /// The item id.
        id: String,
        /// The version you read. If the item has changed since, nothing is
        /// restored. With `--socket` it is required.
        #[arg(long)]
        version: Option<i64>,
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
        /// The state you read the item in. If it is in another state now,
        /// nothing moves and the server answers `state_conflict`.
        #[arg(long)]
        from: Option<TransitionState>,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Destroy an item in the bin irrecoverably. Needs `items.purge`. With
    /// `--socket`, name its `--version` from `items bin list`.
    Purge {
        /// The item id.
        id: String,
        /// The version you read before the item went to the bin. If the item
        /// has changed since, nothing is purged. With `--socket` it is required.
        #[arg(long)]
        version: Option<i64>,
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
    /// An item's tags: add, remove or replace them.
    Tags {
        #[command(subcommand)]
        command: ItemTagsCommand,
    },
    /// The edges leaving an item.
    Edges(ItemEdgesArgs),
    /// The edges arriving at an item.
    Backrefs(ItemEdgesArgs),
    /// Add a file as an item of its own: upload its bytes and create a file
    /// item for them.
    Add(AddArgs),
    /// Attach a file: upload its bytes, create a file item for them, and link
    /// it to the item with an `attached-to` edge.
    Attach(AttachArgs),
    /// Item counts, by state, by type or by source.
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
        #[arg(required = true, value_name = "ID")]
        ids: Vec<String>,
        /// Extra to hydrate onto each item: `edges`, `metadata`.
        #[arg(long, value_name = "NAME")]
        include: Vec<String>,
    },
    /// Count, for each item, the active items an edge type links to it or the
    /// rows it holds in a table, in one request.
    #[command(group(clap::ArgGroup::new("counted").required(true).args(["backref", "edge", "table"])))]
    Counts {
        /// The item ids, at most 100.
        #[arg(required = true, value_name = "ID")]
        ids: Vec<String>,
        /// Count the items an edge of this type leaves each item for, such as
        /// `parent-of` for children.
        #[arg(long, value_name = "EDGE_TYPE")]
        backref: Option<String>,
        /// Count the items with an edge of this type to each item, such as
        /// `in-collection` for a collection's members.
        #[arg(long, value_name = "EDGE_TYPE")]
        edge: Option<String>,
        /// Count the rows each item holds in this table.
        #[arg(long, value_name = "TABLE")]
        table: Option<String>,
    },
    /// Find the items titled by each name, in one request.
    Titles {
        /// The titles to look for, at most 200.
        #[arg(required = true)]
        names: Vec<String>,
    },
    /// Find the items the credential can read that hold each file hash, in
    /// one request: what `items add` and `items attach` ask before they
    /// upload.
    Blobs {
        /// The hashes to look for, each `sha256:` and 64 lowercase
        /// hexadecimal digits, at most 200.
        #[arg(required = true)]
        hashes: Vec<String>,
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

#[derive(Debug, Subcommand)]
pub enum ItemTagsCommand {
    /// Put tags on an item.
    Add {
        /// The item id.
        id: String,
        /// One or more tags.
        #[arg(required = true)]
        tags: Vec<String>,
        /// The item version you read. If the item has changed since, no tag
        /// is added.
        #[arg(long)]
        version: Option<i64>,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Take one tag off an item.
    Remove {
        /// The item id.
        id: String,
        /// The tag to take off.
        tag: String,
        /// The item version you read. If the item has changed since, the tag
        /// stays.
        #[arg(long)]
        version: Option<i64>,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Write an item's tags whole, dropping any not named; none at all clears
    /// them.
    Replace {
        /// The item id.
        id: String,
        /// The tags the item is to carry.
        tags: Vec<String>,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
}

#[derive(Debug, Subcommand)]
pub enum BinCommand {
    /// List what the bin holds, when each item is eligible for automatic deletion, and the retention, one page at a time.
    List {
        /// Only this exact item type.
        #[arg(long = "type")]
        type_: Option<String>,
        /// Match item names, ignoring case.
        #[arg(long)]
        query: Option<String>,
        #[command(flatten)]
        page: PageArgs,
    },
    /// Permanently delete everything in the bin, 200 at a time, and say how
    /// many have gone as it does. It stops where a deletion could not be
    /// confirmed; run it again to carry on, as an interrupted run is safe to
    /// repeat. Items that changed meanwhile stay in the bin, and it says how
    /// many. If a batch fails, the error says how many had gone, and with
    /// --json carries the count as "purged".
    Empty {
        /// Confirm permanent deletion with `PURGE`.
        #[arg(long, value_name = "WORD", value_parser = ["PURGE"])]
        confirm: String,
    },
}

pub fn bin_request(command: &BinCommand) -> Result<Request, CliError> {
    Ok(match command {
        BinCommand::List { type_, query, page } => Request::get(&["trash"])
            .query_opt("type", type_.as_deref())
            .query_opt("q", query.as_deref())
            .query_opt("limit", page.limit.map(|n| n.to_string()))
            .query_opt("cursor", page.cursor.as_deref()),
        BinCommand::Empty { confirm } => {
            if confirm != "PURGE" {
                return Err(CliError::Usage(
                    "emptying the bin needs --confirm PURGE".into(),
                ));
            }
            empty_request(None)
        }
    })
}

fn empty_request(cursor: Option<&str>) -> Request {
    Request::post(&["trash", "empty"]).query_opt("cursor", cursor)
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

impl From<TransitionState> for marfa_core::ItemState {
    fn from(state: TransitionState) -> Self {
        match state {
            TransitionState::Active => marfa_core::ItemState::Active,
            TransitionState::Archived => marfa_core::ItemState::Archived,
            TransitionState::Trashed => marfa_core::ItemState::Trashed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum StatsBy {
    State,
    Type,
    Source,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Conflict {
    Auto,
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
    /// A type identifier, with its subtypes; repeat it for more, up to ten.
    #[arg(long = "type", value_name = "TYPE")]
    pub types: Vec<String>,
    /// A state to answer; repeat it for more. `any` is
    /// every state, and is given alone. Unset answers the active state.
    #[arg(long)]
    pub state: Vec<StateFilter>,
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
    /// The field to order by: `created-at` (the server's default),
    /// `updated-at`, `occurred-at`, `last-activity-at` or `properties.<name>`.
    #[arg(long, value_parser = parse_sort_field)]
    pub sort: Option<marfa_rules::query::SortField>,
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
    /// The id this item has in the system it came from: the natural key.
    #[arg(long)]
    pub source_id: Option<String>,
    /// The id to mint it under. Omitted, the server mints one.
    #[arg(long)]
    pub id: Option<String>,
    /// Create only: where an item already holds the source and source id, or
    /// the id, the server writes nothing and answers `item_exists`.
    #[arg(long)]
    pub create_only: bool,
    /// The version this create is conditional on, where its natural key
    /// resolves an item the server already holds.
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
    /// A property to remove from the item, leaving every other as it is.
    /// Repeat it to remove more than one.
    #[arg(long = "clear-property", value_name = "NAME")]
    pub clear_properties: Vec<String>,
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
    /// The natural key to move the item to. The server refuses one another
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
    /// The file item's type. Defaults to `core.file`, or the image, audio,
    /// video or web page subtype when the MIME type says.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// A tag, repeatable.
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    /// The tier to write it at; the server's default is the library.
    #[arg(long)]
    pub tier: Option<Tier>,
    /// What to do when an item already holds this file's bytes: `ask` says
    /// what matches and asks at a terminal, and elsewhere adds the file and
    /// says what matched; `add` adds without looking; `skip` adds nothing.
    #[arg(long, value_enum, default_value_t, value_name = "WHAT")]
    pub if_duplicate: IfDuplicate,
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
    /// The file item's type. Defaults to `core.file`, or the image, audio,
    /// video or web page subtype when the MIME type says.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// What to do when an item already holds this file's bytes: `ask` says
    /// what matches and asks at a terminal, and elsewhere adds the file and
    /// says what matched; `add` adds without looking; `skip` adds nothing.
    #[arg(long, value_enum, default_value_t, value_name = "WHAT")]
    pub if_duplicate: IfDuplicate,
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
    /// Let entries change the type of the items they land on.
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
        /// The state to move them to. The options below select which items
        /// move, so `--state` there is the state they are in now.
        #[arg(value_name = "STATE")]
        to: TransitionState,
        #[command(flatten)]
        filter: BulkFilterArgs,
    },
    /// Destroy every matching item that is in the bin when the job reaches it; any other
    /// match is left as it is and reported. Match the bin with `--state trashed`. Needs
    /// `items.purge` and `--confirm PURGE`.
    Purge {
        /// The word `PURGE`, because the operation asks for it out loud.
        #[arg(long, value_name = "WORD")]
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
        /// The tier to move them to. The options below select which items
        /// move, so `--tier` there is the tier they are in now.
        #[arg(value_name = "TIER")]
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

pub fn summaries_request(type_: Option<&str>, query: Option<&str>, page: &PageArgs) -> Request {
    Request::get(&["items", "summaries"])
        .query_opt("type", type_.map(str::to_string))
        .query_opt("q", query.map(str::to_string))
        .query_opt("limit", page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", page.cursor.clone())
}

pub fn list_request(args: &ListArgs) -> Result<Request, CliError> {
    Ok(Request::get(&["items"])
        .query_list("type", &args.types)
        .query_opt("state", state_list(&args.state)?)
        .query_opt("source", args.source.clone())
        .query_opt("tier", args.tier.map(TierFilter::as_str))
        .query_list("tags", &args.tags)
        .query_opt("filter", args.filter.clone())
        .query_opt("sort", args.sort.as_ref().map(ToString::to_string))
        .query_opt("direction", args.direction.map(SortDirection::as_str))
        .query_opt("occurred_after", args.occurred_after.clone())
        .query_opt("occurred_before", args.occurred_before.clone())
        .query_opt("updated_after", args.updated_after.clone())
        .query_opt("updated_before", args.updated_before.clone())
        .query_list("include", &args.include)
        .query_opt("limit", args.page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", args.page.cursor.clone()))
}

pub fn get_request(id: &str, include: &[String]) -> Request {
    Request::get(&["items", id])
        .query_list("include", include)
        .query("state", "any")
}

pub fn create_request(
    args: &CreateArgs,
    fields: Option<&Map<String, Value>>,
) -> Result<Request, CliError> {
    let mut body = Map::new();
    body.insert("type".into(), Value::String(args.type_.clone()));
    let properties = args.properties.read(fields)?;
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
    if args.create_only {
        body.insert("mode".into(), Value::String("create_only".into()));
    }
    if let Some(edges) = &args.edges {
        body.insert("edges".into(), Value::Object(object(edges, "--edges")?));
    }
    Ok(args
        .idempotency
        .apply(Request::post(&["items"]).json(Value::Object(body))))
}

pub fn update_request(
    args: &UpdateArgs,
    fields: Option<&Map<String, Value>>,
) -> Result<Request, CliError> {
    let mut body = Map::new();
    body.insert("version".into(), Value::from(args.version));
    let properties = args.properties.read(fields)?;
    if !args.properties.is_empty() {
        body.insert("properties".into(), Value::Object(properties));
    }
    if args.replace {
        body.insert("properties_mode".into(), Value::String("replace".into()));
    }
    if !args.clear_properties.is_empty() {
        body.insert(
            "clear_properties".into(),
            Value::from(args.clear_properties.clone()),
        );
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
    });
    Ok(args.idempotency.apply(
        Request::patch(&["items", &args.id])
            .query_opt("conflict", conflict)
            .json(Value::Object(body)),
    ))
}

/// One id with no digest is a plain trash; several, or a digest, go through
/// the door that moves them all to the bin in one step or none.
pub fn trash_request(ids: &[String], digest: Option<&str>, version: Option<i64>) -> Request {
    match (ids, digest) {
        ([id], None) => {
            Request::delete(&["items", id]).query_opt("version", version.map(|v| v.to_string()))
        }
        _ => {
            let mut body = json!({ "ids": ids });
            if let Some(digest) = digest {
                body["digest"] = json!(digest);
            }
            Request::post(&["items", "trash"]).json(body)
        }
    }
}

pub fn bin_preview_request(ids: &[String]) -> Request {
    Request::post(&["items", "trash-preview"])
        .json(json!({ "ids": ids }))
        .reading()
}

pub fn restore_request(id: &str, version: Option<i64>) -> Request {
    Request::post(&["items", id, "restore"]).query_opt("version", version.map(|v| v.to_string()))
}

pub fn transition_request(
    id: &str,
    state: TransitionState,
    from: Option<TransitionState>,
) -> Request {
    let body = match from {
        Some(from) => json!({ "state": state.as_str(), "from": from.as_str() }),
        None => json!({ "state": state.as_str() }),
    };
    Request::post(&["items", id, "transition"]).json(body)
}

pub fn purge_request(id: &str, version: Option<i64>) -> Request {
    Request::post(&["items", id, "purge"]).query_opt("version", version.map(|v| v.to_string()))
}

pub fn versions_request(id: &str, page: &PageArgs) -> Request {
    Request::get(&["items", id, "versions"])
        .query_opt("limit", page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", page.cursor.clone())
}

pub fn tag_request(id: &str, tags: &[String], version: Option<i64>) -> Request {
    Request::post(&["items", id, "tags"])
        .query_opt("version", version.map(|v| v.to_string()))
        .json(json!({ "tags": tags }))
}

pub fn untag_request(id: &str, tag: &str, version: Option<i64>) -> Request {
    Request::delete(&["items", id, "tags", tag])
        .query_opt("version", version.map(|v| v.to_string()))
}

pub fn replace_tags_request(id: &str, tags: &[String]) -> Request {
    Request::put(&["items", id, "tags"]).json(json!({ "tags": tags }))
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
            StatsBy::Source => "source",
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
    marfa_core::refuse_inexact_integers(&text)?;
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
    Request::post(&["items", "bulk-get"]).json(body).reading()
}

pub fn counts_request(
    ids: &[String],
    backref: Option<&str>,
    edge: Option<&str>,
    table: Option<&str>,
) -> Request {
    let mut body = json!({ "ids": ids });
    for (key, value) in [("backref", backref), ("edge", edge), ("table", table)] {
        if let Some(value) = value {
            body[key] = json!(value);
        }
    }
    Request::post(&["items", "counts"]).json(body).reading()
}

pub fn titles_request(names: &[String]) -> Request {
    Request::post(&["items", "titles"])
        .json(json!({ "names": names }))
        .reading()
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
    Request::post(&["items", "lookup"])
        .json(Value::Object(body))
        .reading()
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
    // A dry run counts what the action would change and changes nothing.
    let dry_run = body.get("dry_run") == Some(&Value::Bool(true));
    let request = Request::post(&["items", "bulk-actions"]).json(body);
    Ok(if dry_run { request.reading() } else { request })
}

/// The server answers a refusal it makes before reading the body without the body being sent.
pub fn upload_request(path: &std::path::Path, mime_type: &str) -> Request {
    Request::post(&["blobs"])
        .file(path.to_path_buf(), mime_type.to_string())
        .header("Expect", "100-continue")
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

pub fn attached_to_request(file_item_id: &str, to_id: &str) -> Request {
    Request::post(&["edges"]).json(json!({
        "from_id": file_item_id,
        "to_id": to_id,
        "edge_type": "attached-to",
    }))
}

pub fn run(command: ItemsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    if let ItemsCommand::Bin {
        command: BinCommand::Empty { confirm },
    } = &command
    {
        return empty_bin(confirm, remote, out);
    }
    let done = match &command {
        ItemsCommand::Trash {
            ids,
            dry_run: false,
            ..
        } => Some(format!("moved {} to the bin", ids.join(", "))),
        ItemsCommand::Purge { id, .. } => Some(format!("purged {id}")),
        _ => None,
    };
    let tagged = match &command {
        ItemsCommand::Tags {
            command: ItemTagsCommand::Add { id, .. },
        } => Some(("tagged", id.clone())),
        ItemsCommand::Tags {
            command: ItemTagsCommand::Remove { id, .. },
        } => Some(("untagged", id.clone())),
        ItemsCommand::Tags {
            command: ItemTagsCommand::Replace { id, .. },
        } => Some(("set the tags of", id.clone())),
        _ => None,
    };
    let wrote = match &command {
        ItemsCommand::Create(_) => Some("created"),
        ItemsCommand::Update(_) => Some("updated"),
        ItemsCommand::Restore { .. } => Some("restored"),
        ItemsCommand::Transition { state, .. } => Some(match state {
            TransitionState::Active => "reactivated",
            TransitionState::Archived => "archived",
            TransitionState::Trashed => "moved to the bin",
        }),
        _ => None,
    };
    let request = match &command {
        ItemsCommand::Bin { command } => bin_request(command)?,
        ItemsCommand::List(args) => list_request(args)?,
        ItemsCommand::Summaries { type_, query, page } => {
            summaries_request(type_.as_deref(), query.as_deref(), page)
        }
        ItemsCommand::Get { id, include } => get_request(id, include),
        ItemsCommand::Create(args) => {
            let fields = field_definitions(remote, &args.properties, || Some(args.type_.clone()));
            create_request(args, fields.as_ref())?
        }
        ItemsCommand::Update(args) => {
            let fields = field_definitions(remote, &args.properties, || {
                args.type_
                    .clone()
                    .or_else(|| type_of_item(remote, &args.id))
            });
            update_request(args, fields.as_ref())?
        }
        ItemsCommand::Trash {
            ids, dry_run: true, ..
        } => bin_preview_request(ids),
        ItemsCommand::Trash {
            ids,
            version,
            digest,
            idempotency,
            ..
        } => {
            if version.is_some() && ids.len() > 1 {
                return Err(CliError::Usage(
                    "--version names the version of one item: give one id with it".into(),
                ));
            }
            idempotency.apply(trash_request(ids, digest.as_deref(), *version))
        }
        ItemsCommand::Restore {
            id,
            version,
            idempotency,
        } => idempotency.apply(restore_request(id, *version)),
        ItemsCommand::Transition {
            id,
            state,
            from,
            idempotency,
        } => idempotency.apply(transition_request(id, *state, *from)),
        ItemsCommand::Purge {
            id,
            version,
            idempotency,
        } => idempotency.apply(purge_request(id, *version)),
        ItemsCommand::Versions { id, page } => versions_request(id, page),
        ItemsCommand::Tags { command } => match command {
            ItemTagsCommand::Add {
                id,
                tags,
                version,
                idempotency,
            } => idempotency.apply(tag_request(id, tags, *version)),
            ItemTagsCommand::Remove {
                id,
                tag,
                version,
                idempotency,
            } => idempotency.apply(untag_request(id, tag, *version)),
            ItemTagsCommand::Replace {
                id,
                tags,
                idempotency,
            } => idempotency.apply(replace_tags_request(id, tags)),
        },
        ItemsCommand::Link { id, app, open } => return link(id, *app, *open, remote, out),
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
        ItemsCommand::Counts {
            ids,
            backref,
            edge,
            table,
        } => counts_request(ids, backref.as_deref(), edge.as_deref(), table.as_deref()),
        ItemsCommand::Titles { names } => titles_request(names),
        ItemsCommand::Blobs { hashes } => duplicate::lookup_request(hashes),
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
    let all = match &command {
        ItemsCommand::List(args) => args.page.all,
        ItemsCommand::Summaries { page, .. } => page.all,
        ItemsCommand::Versions { page, .. } => page.all,
        ItemsCommand::Bin {
            command: BinCommand::List { page, .. },
        } => page.all,
        _ => false,
    };
    let answer = remote.pages(&request, all)?;
    match (done, wrote, tagged) {
        (Some(sentence), _, _) => out.report(&answer, |_| sentence),
        (None, Some(verb), _) => out.report(&answer, |answer| super::said::item(verb, answer)),
        (None, None, Some((verb, id))) => {
            out.report(&answer, |answer| super::said::tags(verb, &id, answer))
        }
        (None, None, None) => out.value(&answer),
    }
}

/// The item's `web_url` or `app_url`, as its server answers it, printed or opened.
fn link(id: &str, app: bool, open: bool, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    marfa_rules::validation::id("id", id).map_err(|_| {
        CliError::Invalid(format!(
            "Invalid item ID: {id:?} is not a UUIDv7 in lowercase"
        ))
    })?;
    let answer = remote.json(&get_request(id, &[]))?;
    let item = answer.get("item").unwrap_or(&Value::Null);
    let web_url = || item_link(item, "web_url", &["http", "https"]);
    let app_url = || item_link(item, "app_url", &["marfa"]);
    let wanted = if app { app_url()? } else { web_url()? };
    let shown = if out.json {
        json!({"web_url": web_url()?, "app_url": app_url()?})
    } else {
        Value::String(wanted.clone())
    };
    if item.get("state").and_then(Value::as_str) == Some("trashed") {
        crate::errln!("This item is in the bin, which the apps call Recently Deleted.");
    }
    if open && super::open_link(&wanted) {
        return Ok(());
    }
    match &shown {
        Value::String(text) => out.line(text)?,
        object => out.value(object)?,
    }
    if open {
        return Err(CliError::Io(std::io::Error::other(
            "could not open the link with the system's opener; it is printed above",
        )));
    }
    Ok(())
}

/// A link the server put on an item, kept only if it is one address in a scheme
/// it may hand over: the opener and the terminal take what it says.
fn item_link(item: &Value, name: &str, schemes: &[&str]) -> Result<String, CliError> {
    let link = item.get(name).and_then(Value::as_str).ok_or_else(|| {
        CliError::Invalid(
            "the server gives no item links: it needs a newer release of Marfa".into(),
        )
    })?;
    let plain = url::Url::parse(link).is_ok_and(|parsed| schemes.contains(&parsed.scheme()))
        && !link
            .chars()
            .any(|c| c.is_whitespace() || output::needs_escape(c));
    if plain {
        Ok(link.to_string())
    } else {
        let expected = match schemes {
            ["marfa"] => "a marfa address",
            _ => "an http or https address",
        };
        Err(CliError::Invalid(format!(
            "the server gave {name} as something other than {expected}"
        )))
    }
}

/// The type's field definitions, read only when a `--prop` was given.
fn field_definitions(
    remote: &Remote,
    properties: &PropertyArgs,
    type_id: impl FnOnce() -> Option<String>,
) -> Option<Map<String, Value>> {
    if properties.props.is_empty() {
        return None;
    }
    let fields = type_id()
        .and_then(|id| remote.json(&super::types::get_request(&id)).ok())
        .and_then(|definition| match definition.get("fields") {
            Some(Value::Object(fields)) => Some(fields.clone()),
            _ => None,
        });
    if fields.is_none() {
        crate::hint::props_sent_as_text();
    }
    fields
}

fn type_of_item(remote: &Remote, id: &str) -> Option<String> {
    let answer = remote.json(&get_request(id, &[])).ok()?;
    answer
        .pointer("/item/type")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Empties the bin batch by batch; a batch of unknown outcome stops the run.
fn empty_bin(confirm: &str, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    bin_request(&BinCommand::Empty {
        confirm: confirm.to_string(),
    })?;
    let mut purged: u64 = 0;
    let mut failures: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen: Vec<String> = Vec::new();
    let unsure = loop {
        let batch =
            remote
                .json(&empty_request(cursor.as_deref()))
                .map_err(|error| match purged {
                    0 => error,
                    purged => CliError::BinPartlyEmptied {
                        purged,
                        error: Box::new(error),
                    },
                })?;
        purged += batch.get("purged").and_then(Value::as_u64).unwrap_or(0);
        let held: Vec<Value> = batch
            .get("failures")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let unsure = held.iter().any(is_unconfirmed);
        failures.extend(held);
        let next = batch
            .get("next_cursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        if !out.json && next.is_some() && !unsure {
            out.line(&format!("{purged} items deleted so far"))?;
        }
        let Some(next) = next.filter(|_| !unsure) else {
            break unsure;
        };
        if cursor.as_ref() == Some(&next) || seen.contains(&next) {
            return Err(CliError::Invalid(format!(
                "the server named the cursor \"{next}\" again after {purged} items were deleted, so emptying stopped rather than go round again"
            )));
        }
        seen.push(next.clone());
        cursor = Some(next);
    };
    let stayed = failures
        .iter()
        .filter(|failure| !is_unconfirmed(failure))
        .count();
    out.report(
        &json!({ "purged": purged, "stayed": stayed, "failures": failures }),
        |_| {
            let mut lines = vec![format!("{purged} items deleted from the bin")];
            for failure in &failures {
                let text = |name: &str| failure.get(name).and_then(Value::as_str).unwrap_or("");
                lines.push(format!(
                    "{}: {}",
                    crate::output::printable(text("id")),
                    crate::output::printable(text("message"))
                ));
            }
            if stayed > 0 {
                lines.push(format!("{stayed} items stayed in the bin"));
            }
            lines.join("\n")
        },
    )?;
    if unsure {
        return Err(CliError::Invalid(
            "stopped: a deletion could not be confirmed, so read the bin again before running this again".into(),
        ));
    }
    Ok(())
}

fn is_unconfirmed(failure: &Value) -> bool {
    failure
        .pointer("/details/write_outcome")
        .and_then(Value::as_str)
        == Some("unknown")
}

/// The edge page carries only the other end's id, so the plain listing
/// reads each one's title.
fn edges(
    args: &ItemEdgesArgs,
    inbound: bool,
    remote: &Remote,
    out: &Printer,
) -> Result<(), CliError> {
    let page = remote.pages(&edges_request(args, inbound), args.page.all)?;
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

/// A run that stops partway leaves the earlier steps standing; the blob is
/// content-addressed, so a retry uploads nothing new.
fn attach(args: &AttachArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let mime_type = mime_type_for(&args.file, args.mime_type.as_deref());
    let ((blob, hash), duplicates) =
        match checked_upload(&args.file, &mime_type, args.if_duplicate, out, remote)? {
            Added::Held(found) => return duplicate::report_held(&args.file, &found, out),
            Added::Uploaded { uploaded, found } => (uploaded, found),
        };
    let item = remote.json(&file_item_request(args, &mime_type, &hash))?;
    let (file_item, file_item_id) = file_item_of(&item)?;
    let edge = remote.json(&attached_to_request(&file_item_id, &args.id))?;
    out.report(
        &duplicate::with_matches(
            json!({ "blob": blob, "item": file_item, "edge": edge }),
            duplicates.as_ref(),
        ),
        |_| {
            format!(
                "attached {} as {} ({}), linked to {}",
                duplicate::shown(&args.file),
                printable(&file_item_id),
                printable(&hash),
                args.id
            )
        },
    )
}

fn add(args: &AddArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let mime_type = mime_type_for(&args.file, args.mime_type.as_deref());
    let ((blob, hash), duplicates) =
        match checked_upload(&args.file, &mime_type, args.if_duplicate, out, remote)? {
            Added::Held(found) => return duplicate::report_held(&args.file, &found, out),
            Added::Uploaded { uploaded, found } => (uploaded, found),
        };
    let item = remote.json(&added_file_request(args, &mime_type, &hash))?;
    let (file_item, file_item_id) = file_item_of(&item)?;
    out.report(
        &duplicate::with_matches(
            json!({ "blob": blob, "item": file_item }),
            duplicates.as_ref(),
        ),
        |_| {
            format!(
                "added {} as {} ({})",
                duplicate::shown(&args.file),
                printable(&file_item_id),
                printable(&hash)
            )
        },
    )
}

fn checked_upload(
    file: &std::path::Path,
    mime_type: &str,
    mode: IfDuplicate,
    out: &Printer,
    remote: &Remote,
) -> Result<Added<(Value, String)>, CliError> {
    duplicate::checked_upload(file, mode, out.json, remote, || {
        let (blob, hash) = upload(file, mime_type, remote)?;
        Ok(((blob, hash.clone()), hash))
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

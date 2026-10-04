use std::path::PathBuf;

use clap::{Args, Subcommand};
use marfa_core::{
    Attachment, Core, Draft, EdgeDraft, EdgeEdit, Edit, ListFilters, MetadataWrite, SearchFilters,
    Sort,
};

use crate::error::{CliError, Exit};
use crate::output;
use crate::remote::{Named, Session, renewing};
use crate::values::{ItemState, SortDirection, SortField, Tier, properties};

#[derive(Debug, Args)]
pub struct DeviceArgs {
    /// The working copy's database file.
    #[arg(
        long,
        global = true,
        env = "MARFA_DB",
        value_name = "PATH",
        hide_env_values = true
    )]
    pub db: Option<PathBuf>,

    /// Open the store to read only: never claim the writer role, never
    /// write, and refuse a path where no store has been made.
    #[arg(long, global = true)]
    pub reader: bool,

    #[command(subcommand)]
    pub command: DeviceCommand,
}

#[derive(Debug, Subcommand)]
pub enum DeviceCommand {
    /// Replace the local copy with the declared types at one tier.
    Hydrate {
        /// Comma-separated type identifiers, such as core.note,core.file.
        #[arg(long, value_delimiter = ',', required = true, value_name = "TYPE")]
        types: Vec<String>,
        /// The tier to hold the slice at.
        #[arg(long)]
        tier: Tier,
        /// An edge type to hold whole: every edge of it the key reads,
        /// whichever ends the copy holds. Repeatable.
        #[arg(long = "edge-type", value_name = "TYPE")]
        edge_types: Vec<String>,
    },
    /// Hold one row by id whatever the slice says of it, read now and kept
    /// current, even after it leaves the slice.
    Pin {
        /// The item id.
        id: String,
    },
    /// Stop holding a row by id; one the slice does not take goes.
    Unpin {
        /// The item id.
        id: String,
    },
    /// Apply every event since the last hydrate or catch-up.
    #[command(name = "catch-up")]
    CatchUp,
    /// Hold the event stream open and apply each event as it arrives,
    /// printing a line for each that changed the copy.
    Follow {
        /// Stop after this many seconds; without it, follow until
        /// interrupted. Either way it ends with its report.
        #[arg(long = "for", value_name = "SECONDS")]
        r#for: Option<u64>,
    },
    /// Print a line each time another process saves to the store. Opens it
    /// to read, with or without `--reader`, so watching never takes the
    /// writer's place.
    Changes {
        /// Stop after this many seconds; without it, watch until
        /// interrupted.
        #[arg(long = "for", value_name = "SECONDS")]
        r#for: Option<u64>,
    },
    /// Read items from the local copy.
    Items {
        #[command(subcommand)]
        command: ItemsCommand,
    },
    /// Full-text search over the local copy, best match first.
    Search {
        /// Words to look for; each is a prefix, all must match.
        query: String,
        /// Exactly one state. Unset answers the active state.
        #[arg(long)]
        state: Option<ItemState>,
        /// Every state, not just the active one.
        #[arg(long)]
        all_states: bool,
        /// A type identifier; its subtypes are included.
        #[arg(long = "type", value_name = "TYPE")]
        type_: Option<String>,
        /// Hits must carry every tag given.
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
        /// An expression in the server's listing grammar, answered as the
        /// server answers `filter`; a `backref` condition is refused.
        #[arg(long, value_name = "EXPR")]
        filter: Option<String>,
        /// Only this item and what it reaches along `parent-of` edges.
        #[arg(long, value_name = "ID")]
        beneath: Option<String>,
        /// How many hits at most.
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Every queued write, the body it carries and what became of it.
    Queue,
    /// Send what the queue holds and record what came back.
    ///
    /// One pass. A write that met a network rather than an answer is left
    /// where it was, uncounted, for the next drain.
    Drain,
    /// Clear the writes the server has answered.
    ///
    /// A queue nobody empties makes every later write slower. Blocked and
    /// dead rows stay, because a caller may still release them, and so does
    /// a refused write that carried content, until it is discarded.
    Forget,
    /// Take a refused write out of the queue, with the content it carried.
    ///
    /// The one way a refused create, edit, metadata, extension or edge
    /// write leaves the queue. A write still waiting on it keeps it.
    Discard {
        /// The refused write to discard.
        #[arg(value_name = "ID")]
        id: String,
    },
    /// Send a blocked or dead write again, under a fresh key.
    Release {
        /// The queued write to release.
        #[arg(
            value_name = "ID",
            conflicts_with = "reason",
            required_unless_present = "reason"
        )]
        id: Option<String>,
        /// Release every write blocked for this reason instead of one by id.
        #[arg(long, value_name = "REASON", value_parser = blocked_reason())]
        reason: Option<marfa_core::BlockedReason>,
    },
    /// Take a write blocked `ancestor_unavailable` or `conflict_unresolved`
    /// out of the queue, and put the copy back to what the server holds.
    ///
    /// Sent again, such a write is refused the same way under any key. The
    /// writes held for it are refused unsent.
    Withdraw {
        /// The queued write to withdraw.
        #[arg(value_name = "ID")]
        id: String,
    },
    /// What the local copy holds and where it came from.
    Status,
    /// The item types the copy holds, read from it alone, and the ones an app
    /// declares for it.
    Types {
        #[command(subcommand)]
        command: TypesCommand,
    },
    /// The edge types the copy holds, read from it alone.
    #[command(name = "edge-types")]
    EdgeTypes {
        #[command(subcommand)]
        command: CatalogCommand,
    },
    /// Edges between items, each its own write.
    Edges {
        #[command(subcommand)]
        command: EdgesCommand,
    },
    /// Tags on an item, each its own write.
    Tags {
        #[command(subcommand)]
        command: TagsCommand,
    },
    /// An item's metadata, written whole or merged.
    Metadata {
        #[command(subcommand)]
        command: MetadataCommand,
    },
    /// An item's extension namespaces, each its own write.
    Extensions {
        #[command(subcommand)]
        command: ExtensionsCommand,
    },
    /// Blobs' bytes: uploaded as queued writes, fetched when asked for.
    Blobs {
        #[command(subcommand)]
        command: BlobsCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum BlobsCommand {
    /// Hold a file's bytes beside the store and queue their upload.
    Put {
        /// The file to upload.
        file: PathBuf,
        /// The MIME type to send them under; the default comes from the
        /// file's extension.
        #[arg(long)]
        mime_type: Option<String>,
    },
    /// Print where a blob's bytes are held, fetching them first where the
    /// store does not hold them yet.
    Get {
        /// The blob's hash, `sha256:<hex>`.
        hash: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum ItemsCommand {
    /// List items, newest first unless sorted otherwise.
    List(ListArgs),
    /// One item by id, with its properties and tags.
    Get {
        /// The item id.
        id: String,
    },
    /// Write a new item into the local copy and queue it for the server.
    Create(CreateArgs),
    /// Change an item in the local copy and queue the change.
    Update(UpdateArgs),
    /// Move an item to the bin locally and queue the delete.
    Delete {
        /// The item id.
        id: String,
    },
    /// Take an item out of the bin locally and queue the restore.
    Restore {
        /// The item id.
        id: String,
    },
    /// Move an item to another lifecycle state.
    Transition {
        /// The item id.
        id: String,
        /// The state to move it to. `revoked` is the server's alone.
        #[arg(long)]
        state: ItemState,
    },
    /// Add a file as an item of its own: its upload and a file item naming
    /// the bytes, two queued writes, and one for each tag.
    Add(AddArgs),
    /// Attach a file to an item: its upload, a file item naming the bytes,
    /// and an `attached-to` edge, three queued writes.
    Attach(AttachArgs),
    /// The thumbnail an item carries, read from the local copy with no
    /// request: its MIME type and size, and its bytes written to `--out`.
    Thumbnail {
        /// The item id.
        id: String,
        /// Where to write the image's bytes.
        #[arg(long, value_name = "FILE")]
        out: Option<PathBuf>,
    },
}

#[derive(Debug, Args)]
pub struct AddArgs {
    /// The file to add.
    pub file: PathBuf,
    /// The MIME type; the default comes from the file's extension.
    #[arg(long)]
    pub mime_type: Option<String>,
    /// The file item's title; the default is the file's name.
    #[arg(long)]
    pub title: Option<String>,
    /// The file item's type; the default comes from the MIME type.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// A tag, repeatable. Each is queued as a write of its own.
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    /// The tier to write the file item at.
    #[arg(long)]
    pub tier: Option<Tier>,
}

#[derive(Debug, Args)]
pub struct AttachArgs {
    /// The item to attach the file to.
    pub id: String,
    /// The file to attach.
    pub file: PathBuf,
    /// The MIME type; the default comes from the file's extension.
    #[arg(long)]
    pub mime_type: Option<String>,
    /// The file item's title; the default is the file's name.
    #[arg(long)]
    pub title: Option<String>,
    /// The file item's type; the default comes from the MIME type.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// The tier to write the file item at.
    #[arg(long)]
    pub tier: Option<Tier>,
}

#[derive(Debug, Subcommand)]
pub enum EdgesCommand {
    /// The edges the copy holds from one item.
    List {
        /// The item the edges start from.
        item: String,
    },
    /// The edges the copy holds to one item.
    To {
        /// The item the edges point at.
        item: String,
    },
    /// Link two items, and queue the edge.
    Create {
        /// The item the edge starts from.
        #[arg(long, value_name = "ID")]
        source: String,
        /// The item the edge points at.
        #[arg(long, value_name = "ID")]
        target: String,
        /// The edge type.
        #[arg(long = "type", value_name = "TYPE")]
        type_: String,
        /// The edge's properties, as a JSON object.
        #[arg(long, value_name = "JSON", default_value = "{}")]
        properties: String,
        /// The id to mint it under. Omitted, the device mints one.
        #[arg(long)]
        id: Option<String>,
    },
    /// Change an edge's properties.
    Update {
        /// The edge id.
        id: String,
        /// The properties to write, as a JSON object. Whole values.
        #[arg(long, value_name = "JSON", default_value = "{}")]
        properties: String,
        /// The version the edit was based on. Required, as on an item.
        #[arg(long)]
        version: Option<i64>,
        /// Move the edge to this source, where each target holds one of its type.
        #[arg(long, value_name = "ID")]
        source: Option<String>,
        /// Move the edge to this target, where each source holds one of its type.
        #[arg(long, value_name = "ID")]
        target: Option<String>,
    },
    /// Drop an edge locally and queue the delete.
    Delete {
        /// The edge id.
        id: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum TypesCommand {
    /// Every one the copy holds, by id.
    List,
    /// One by id; a type inherits the fields of the types above it.
    Get {
        /// The id, such as `core.note`.
        id: String,
    },
    /// Declare the types this app saves, so a copy with no server checks what
    /// it queues against them and the first hydration registers the ones the
    /// instance lacks, where the key may.
    ///
    /// Marfa's own types need no declaring. Declaring a type again replaces
    /// its earlier declaration.
    Declare {
        /// A type definition, or an array of them, as JSON.
        #[arg(
            long,
            value_name = "JSON",
            conflicts_with = "file",
            required_unless_present = "file"
        )]
        definitions: Option<String>,
        /// A file holding the same.
        #[arg(long, value_name = "PATH")]
        file: Option<PathBuf>,
    },
    /// The declarations this copy holds, as they were made.
    Declared,
}

#[derive(Debug, Subcommand)]
pub enum CatalogCommand {
    /// Every one the copy holds, by id.
    List,
    /// One by id; a type inherits the fields of the types above it.
    Get {
        /// The id, such as `core.note` or `parent-of`.
        id: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum TagsCommand {
    /// Put one tag on an item.
    Add {
        /// The item id.
        item: String,
        /// The tag.
        tag: String,
    },
    /// Take one tag off an item.
    Remove {
        /// The item id.
        item: String,
        /// The tag.
        tag: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum MetadataCommand {
    /// Write the item's tags whole, dropping any not named.
    Replace {
        /// The item id.
        item: String,
        /// A tag, repeatable.
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
    },
    /// Add the named tags, leaving the rest.
    Merge {
        /// The item id.
        item: String,
        /// A tag, repeatable.
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
    },
}

#[derive(Debug, Subcommand)]
pub enum ExtensionsCommand {
    /// Write one extension namespace.
    Write {
        /// The item id.
        item: String,
        /// The extension namespace.
        namespace: String,
        /// The namespace's contents, as a JSON object.
        #[arg(long, value_name = "JSON", default_value = "{}")]
        body: String,
    },
    /// Remove one extension namespace.
    Delete {
        /// The item id.
        item: String,
        /// The extension namespace.
        namespace: String,
    },
}

#[derive(Debug, Args)]
pub struct CreateArgs {
    /// The type the item is.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: String,
    /// The properties, as a JSON object.
    #[arg(long, value_name = "JSON")]
    pub properties: String,
    /// A tag, repeatable. Each is queued as a write of its own.
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    /// The tier to write it at; the default is the library.
    #[arg(long)]
    pub tier: Option<Tier>,
    /// The source to stamp it with.
    #[arg(long)]
    pub source: Option<String>,
    /// The id this row has in the system it came from.
    #[arg(long)]
    pub source_id: Option<String>,
    /// The item's own time, RFC 3339. Defaults to now.
    #[arg(long)]
    pub occurred_at: Option<String>,
    /// The id to mint it under. Omitted, the device mints one.
    #[arg(long)]
    pub id: Option<String>,
    /// The version this create is conditional on, where its natural key
    /// resolves a row the server already holds.
    #[arg(long)]
    pub version: Option<i64>,
}

#[derive(Debug, Args)]
pub struct UpdateArgs {
    /// The item id.
    pub id: String,
    /// The properties to write, as a JSON object. Whole values.
    #[arg(long, value_name = "JSON")]
    pub properties: String,
    /// The version the edit was based on. Required: an update that names no
    /// version overwrites whatever it finds.
    #[arg(long)]
    pub version: Option<i64>,
    /// The natural key to move the row to. The server refuses one another
    /// item already holds, so a rename does not take a name off a note.
    #[arg(long, value_name = "KEY")]
    pub source_id: Option<String>,
    /// The version is one read before the version the copy holds now, and
    /// the server merges the edit against it rather than taking it as newer
    /// than what came in since.
    #[arg(long)]
    pub as_read: bool,
    /// The type to move the item to. The server holds its properties to the
    /// type it enters.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// The tier to move the item to.
    #[arg(long)]
    pub tier: Option<Tier>,
    /// The properties are the item's whole properties: one they leave out is
    /// cleared rather than kept.
    #[arg(long)]
    pub replace: bool,
}

#[derive(Debug, Args)]
pub struct ListArgs {
    /// A type identifier; its subtypes are included.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// Exactly one state. Unset answers the active state.
    #[arg(long)]
    pub state: Option<ItemState>,
    /// Every state, not just the active one.
    #[arg(long)]
    pub all_states: bool,
    /// Only items at this tier.
    #[arg(long)]
    pub tier: Option<Tier>,
    /// Items must carry every tag given.
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    /// Exclusive lower bound on the item's own time, RFC 3339.
    #[arg(long = "occurred-after", value_name = "TIME")]
    pub occurred_after: Option<String>,
    /// Exclusive upper bound on the item's own time, RFC 3339.
    #[arg(long = "occurred-before", value_name = "TIME")]
    pub occurred_before: Option<String>,
    /// An expression in the server's listing grammar, answered as the
    /// server answers `filter`; a `backref` condition is refused.
    #[arg(long, value_name = "EXPR")]
    pub filter: Option<String>,
    /// Only this item and what it reaches along `parent-of` edges.
    #[arg(long, value_name = "ID")]
    pub beneath: Option<String>,
    /// The time to order by.
    #[arg(long, default_value = "created-at")]
    pub sort: SortField,
    /// Newest first, or oldest.
    #[arg(long, default_value = "desc")]
    pub direction: SortDirection,
    /// How many items at most.
    #[arg(long)]
    pub limit: Option<u32>,
    /// How many items to skip first.
    #[arg(long)]
    pub offset: Option<u32>,
}

pub fn run(args: DeviceArgs, named: &Named, json: bool) -> Result<Exit, CliError> {
    let store = Store {
        db: args.db,
        reader: args.reader,
        makes: matches!(
            args.command,
            DeviceCommand::Hydrate { .. } | DeviceCommand::Status
        ),
    };
    match args.command {
        DeviceCommand::Hydrate {
            types,
            tier,
            edge_types,
        } => {
            let core = store.open_with_server(named)?;
            stop_on_interrupt();
            let report = core.hydrate_until(&types, tier.into(), &edge_types, stop_after(None))?;
            output::report(&report, json, || {
                let whole = if report.edge_types.is_empty() {
                    String::new()
                } else {
                    format!(", {} held whole", report.edge_types.join(","))
                };
                let mut line = format!(
                    "hydrated {} item(s) and {} edge(s) of {} at {}{whole} in {} page(s); cursor {}",
                    report.items,
                    report.edges,
                    report.types.join(","),
                    report.tier,
                    report.pages,
                    report.cursor
                );
                if !report.registered_types.is_empty() {
                    line.push_str(&format!(
                        "\nregistered {} on the server",
                        report.registered_types.join(",")
                    ));
                }
                for held in &report.unregistered_types {
                    line.push_str(&format!(
                        "\nnot registered: {} ({}): {}",
                        held.id, held.code, held.message
                    ));
                }
                line
            })
        }
        DeviceCommand::Pin { id } => {
            let was_pinned = store.open_with_server(named)?.pin(&id)?;
            output::report(
                &serde_json::json!({ "id": id, "pinned": true, "was_pinned": was_pinned }),
                json,
                || {
                    if was_pinned {
                        format!("{id} was pinned already, and is read again")
                    } else {
                        format!("pinned {id}")
                    }
                },
            )
        }
        DeviceCommand::Unpin { id } => {
            let was_pinned = store.open(None)?.unpin(&id)?;
            output::report(
                &serde_json::json!({ "id": id, "pinned": false, "was_pinned": was_pinned }),
                json,
                || {
                    if was_pinned {
                        format!("unpinned {id}")
                    } else {
                        format!("{id} was not pinned")
                    }
                },
            )
        }
        DeviceCommand::Follow { r#for } => {
            let core = store.open_with_server(named)?;
            let stop = stop_after(r#for);
            stop_on_interrupt();
            let mut unwritten: Option<CliError> = None;
            let report = core.follow(stop, |change| {
                if unwritten.is_some() {
                    return;
                }
                let written = output::line_of(change, json, || {
                    format!(
                        "{} {} (cursor {}){}",
                        change.event,
                        change
                            .item_id
                            .as_deref()
                            .or(change.edge_id.as_deref())
                            .unwrap_or("-"),
                        change.cursor,
                        change
                            .reason
                            .as_deref()
                            .map(|reason| format!(": {reason}"))
                            .unwrap_or_default()
                    )
                });
                if let Err(error) = written {
                    unwritten = Some(error);
                    stop.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            })?;
            if let Some(error) = unwritten {
                return Err(error);
            }
            output::line_of(&report, json, || {
                let failed = match (&report.last_failure, report.failed_opens) {
                    (Some(reason), count) => {
                        format!("; {count} stream(s) could not be opened, last: {reason}")
                    }
                    (None, _) => String::new(),
                };
                format!(
                    "applied {} event(s), skipped {}; cursor {}; {} reconnect(s){failed}",
                    report.applied, report.skipped, report.cursor, report.reconnects
                )
            })
        }
        DeviceCommand::Changes { r#for } => {
            let core = Store {
                reader: true,
                ..store
            }
            .open(None)?;
            let stop = stop_after(r#for);
            // Read before announcing, so a save landing just after is told.
            let mut seen = core.data_version()?;
            if json {
                output::line_of(
                    &serde_json::json!({ "watching": true, "data_version": seen }),
                    json,
                    String::new,
                )?;
            } else {
                match r#for {
                    Some(seconds) => eprintln!("watching for saves for {seconds}s"),
                    None => eprintln!("watching for saves (interrupt to stop)"),
                }
            }
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                std::thread::sleep(CHANGES_POLL);
                let now = core.data_version()?;
                if now != seen {
                    seen = now;
                    output::line_of(&serde_json::json!({ "data_version": now }), json, || {
                        format!("saved (data version {now})")
                    })?;
                }
            }
            Ok(())
        }
        DeviceCommand::CatchUp => {
            let core = store.open_with_server(named)?;
            stop_on_interrupt();
            let report = core.catch_up_until(stop_after(None))?;
            output::report(&report, json, || {
                format!(
                    "applied {} event(s), skipped {}; cursor {}{}",
                    report.applied,
                    report.skipped,
                    report.cursor,
                    if report.reached_head {
                        ""
                    } else {
                        " (stopped on silence)"
                    }
                )
            })
        }
        DeviceCommand::Items { command } => {
            let core = store.open(None)?;
            match command {
                ItemsCommand::List(args) => {
                    let filters = ListFilters {
                        r#type: args.type_,
                        state: args.state.map(Into::into),
                        all_states: args.all_states,
                        tier: args.tier.map(Into::into),
                        tags: args.tags,
                        occurred_after: args.occurred_after,
                        occurred_before: args.occurred_before,
                        filter: args.filter,
                        beneath: args.beneath,
                        limit: args.limit,
                        offset: args.offset,
                    };
                    let sort = Sort {
                        field: args.sort.into(),
                        direction: args.direction.into(),
                    };
                    output::items(&core.list(&filters, sort)?, json)
                }
                ItemsCommand::Get { id } => match core.get(&id)? {
                    Some(item) => output::item(&item, json),
                    None => Err(CliError::NotHeld(id)),
                },
                ItemsCommand::Create(args) => {
                    let draft = Draft {
                        r#type: args.type_,
                        id: args.id,
                        properties: properties(&args.properties)?,
                        tags: args.tags,
                        tier: args.tier.map(Into::into),
                        source: args.source,
                        source_id: args.source_id,
                        occurred_at: args.occurred_at,
                        base_version: args.version,
                    };
                    output::queued_one(&core.create_item(&draft)?, json)
                }
                ItemsCommand::Update(args) => {
                    let edit = Edit {
                        properties: properties(&args.properties)?,
                        base_version: args.version,
                        source_id: args.source_id,
                        r#type: args.type_,
                        tier: args.tier.map(Into::into),
                        replace_properties: args.replace,
                    };
                    let queued = if args.as_read {
                        core.update_item_as_read(&args.id, &edit)?
                    } else {
                        core.update_item(&args.id, &edit)?
                    };
                    output::queued_one(&queued, json)
                }
                ItemsCommand::Delete { id } => output::queued_one(&core.delete_item(&id)?, json),
                ItemsCommand::Restore { id } => output::queued_one(&core.restore_item(&id)?, json),
                ItemsCommand::Transition { id, state } => {
                    output::queued_one(&core.transition_item(&id, state.into())?, json)
                }
                ItemsCommand::Add(args) => {
                    let attachment = Attachment {
                        mime_type: args.mime_type,
                        title: args.title,
                        r#type: args.type_,
                        tier: args.tier.map(Into::into),
                    };
                    let added = core.add_file(&args.file, &attachment, &args.tags)?;
                    output::queued(&[added.upload, added.item], json)
                }
                ItemsCommand::Attach(args) => {
                    let attachment = Attachment {
                        mime_type: args.mime_type,
                        title: args.title,
                        r#type: args.type_,
                        tier: args.tier.map(Into::into),
                    };
                    let attached = core.attach(&args.id, &args.file, &attachment)?;
                    output::queued(&[attached.upload, attached.item, attached.edge], json)
                }
                ItemsCommand::Thumbnail { id, out } => {
                    if core.get(&id)?.is_none() {
                        return Err(CliError::NotHeld(id));
                    }
                    let Some(thumbnail) = core.thumbnail(&id)? else {
                        return output::report(
                            &serde_json::json!({ "id": id, "thumbnail": null }),
                            json,
                            || format!("{id} carries no thumbnail"),
                        ).map(|()| Exit::Done);
                    };
                    if let Some(path) = &out {
                        std::fs::write(path, &thumbnail.bytes)?;
                    }
                    output::report(
                        &serde_json::json!({
                            "id": id,
                            "thumbnail": {
                                "mime_type": thumbnail.mime_type,
                                "size_bytes": thumbnail.bytes.len(),
                                "path": out,
                            }
                        }),
                        json,
                        || {
                            format!(
                                "{} of {} bytes{}",
                                thumbnail.mime_type,
                                thumbnail.bytes.len(),
                                out.as_ref()
                                    .map(|path| format!(", written to {}", path.display()))
                                    .unwrap_or_default()
                            )
                        },
                    )
                }
            }
        }
        DeviceCommand::Blobs { command } => match command {
            BlobsCommand::Put { file, mime_type } => output::queued_one(
                &store.open(None)?.put_blob(&file, mime_type.as_deref())?,
                json,
            ),
            BlobsCommand::Get { hash } => {
                // No server is required: held bytes need none, and without
                // one a missing blob is absent rather than a usage error.
                let path = store.open(named.session_if_named()?)?.blob(&hash)?;
                output::report(
                    &serde_json::json!({ "hash": hash, "path": path }),
                    json,
                    || path.display().to_string(),
                )
            }
        },
        DeviceCommand::Search {
            query,
            state,
            all_states,
            type_,
            tags,
            filter,
            beneath,
            limit,
        } => {
            let filters = SearchFilters {
                state: state.map(Into::into),
                all_states,
                r#type: type_,
                tags,
                filter,
                beneath,
            };
            output::hits(&store.open(None)?.search(&query, &filters, limit)?, json)
        }
        DeviceCommand::Edges { command } => {
            let core = store.open(None)?;
            match command {
                EdgesCommand::List { item } => edge_list(&core.edges_from(&item)?, json),
                EdgesCommand::To { item } => edge_list(&core.edges_to(&item)?, json),
                EdgesCommand::Create {
                    source,
                    target,
                    type_,
                    properties: props,
                    id,
                } => {
                    let draft = EdgeDraft {
                        source_id: source,
                        target_id: target,
                        edge_type: type_,
                        properties: properties(&props)?,
                        id,
                    };
                    output::queued_one(&core.create_edge(&draft)?, json)
                }
                EdgesCommand::Update {
                    id,
                    properties: props,
                    version,
                    source,
                    target,
                } => {
                    let edit = EdgeEdit {
                        properties: properties(&props)?,
                        base_version: version,
                        source_id: source,
                        target_id: target,
                    };
                    output::queued_one(&core.update_edge(&id, &edit)?, json)
                }
                EdgesCommand::Delete { id } => output::queued_one(&core.delete_edge(&id)?, json),
            }
        }
        DeviceCommand::Tags { command } => {
            let core = store.open(None)?;
            let queued = match command {
                TagsCommand::Add { item, tag } => core.add_tag(&item, &tag)?,
                TagsCommand::Remove { item, tag } => core.remove_tag(&item, &tag)?,
            };
            output::queued_one(&queued, json)
        }
        DeviceCommand::Metadata { command } => {
            let core = store.open(None)?;
            let (item, tags, replace) = match command {
                MetadataCommand::Replace { item, tags } => (item, tags, true),
                MetadataCommand::Merge { item, tags } => (item, tags, false),
            };
            let write = MetadataWrite { tags };
            output::queued_one(&core.write_metadata(&item, &write, replace)?, json)
        }
        DeviceCommand::Extensions { command } => {
            let core = store.open(None)?;
            let queued = match command {
                ExtensionsCommand::Write {
                    item,
                    namespace,
                    body,
                } => {
                    properties(&body)?;
                    core.write_extension(&item, &namespace, &body)?
                }
                ExtensionsCommand::Delete { item, namespace } => {
                    core.delete_extension(&item, &namespace)?
                }
            };
            output::queued_one(&queued, json)
        }
        DeviceCommand::Queue => output::queued(&store.open(None)?.queue()?, json),
        DeviceCommand::Forget => {
            let cleared = store.open(None)?.forget_answered()?;
            output::report(&cleared, json, || {
                format!("cleared {cleared} answered write(s)")
            })
        }
        DeviceCommand::Discard { id } => {
            let discarded = store.open(None)?.discard(&id)?;
            output::report(&discarded, json, || {
                if discarded {
                    format!("discarded {id} and what it carried")
                } else {
                    format!(
                        "nothing to discard: {id} is not a refused write, or a write still waits on it"
                    )
                }
            })
        }
        DeviceCommand::Drain => {
            let core = store.open_with_server(named)?;
            stop_on_interrupt();
            let report = core.drain_until(stop_after(None))?;
            output::drained(&report, json)?;
            return Ok(output::drain_exit(&report));
        }
        DeviceCommand::Release { id, reason } => {
            let core = store.open(None)?;
            let released = match (&id, &reason) {
                (_, Some(reason)) => core.release_reason(*reason)?,
                (Some(id), None) => usize::from(core.release(id)?),
                // clap refuses this; reached only if the argument rules drift.
                (None, None) => {
                    return Err(CliError::Invalid(
                        "name a queued write to release, or a reason to release every write blocked for it".into(),
                    ));
                }
            };
            output::report(&released, json, || {
                if released == 0 {
                    "nothing to release: a write is released only where it is blocked or dead"
                        .into()
                } else {
                    format!("released {released} write(s), each under a fresh key")
                }
            })
        }
        DeviceCommand::Withdraw { id } => {
            let withdrawn = store.open_with_server(named)?.withdraw(&id)?;
            output::report(&withdrawn, json, || {
                if withdrawn {
                    format!("withdrew {id}; the copy holds what the server holds")
                } else {
                    format!(
                        "nothing to withdraw: {id} is not blocked ancestor_unavailable or conflict_unresolved"
                    )
                }
            })
        }
        DeviceCommand::Status => {
            let status = store.open(None)?.status()?;
            output::report(&status, json, || {
                let listed = |names: &[String]| {
                    if names.is_empty() {
                        "(none)".to_string()
                    } else {
                        names.join(",")
                    }
                };
                format!(
                    "server {}\ninstance {}\nslice {} at {}\nedge types held whole {}\npinned {}\ncursor {}\nhydration {}\ncatalog version {}\n{} item(s), {} edge(s)",
                    status.server_origin.as_deref().unwrap_or("(none)"),
                    status.instance_id.as_deref().unwrap_or("(none)"),
                    listed(&status.slice_types),
                    status
                        .slice_tier
                        .map(|tier| tier.to_string())
                        .unwrap_or_else(|| "(none)".into()),
                    listed(&status.slice_edge_types),
                    listed(&status.pinned),
                    status.event_cursor.as_deref().unwrap_or("(none)"),
                    status.hydration.as_str(),
                    status
                        .catalog_version
                        .map_or_else(|| "(none)".into(), |version| version.to_string()),
                    status.items,
                    status.edges
                )
            })
        }
        DeviceCommand::Types { command } => {
            let core = store.open(None)?;
            match command {
                TypesCommand::Declare { definitions, file } => {
                    let text = match (definitions, file) {
                        (Some(text), _) => text,
                        (None, Some(path)) => std::fs::read_to_string(&path).map_err(|error| {
                            CliError::Invalid(format!("cannot read {}: {error}", path.display()))
                        })?,
                        (None, None) => unreachable!("one of the two is required"),
                    };
                    let parsed: serde_json::Value = serde_json::from_str(&text)
                        .map_err(|error| CliError::Invalid(format!("not JSON: {error}")))?;
                    let definitions = match parsed {
                        serde_json::Value::Array(all) => all,
                        one @ serde_json::Value::Object(_) => vec![one],
                        _ => {
                            return Err(CliError::Invalid(
                                "a type definition is a JSON object, or an array of them".into(),
                            ));
                        }
                    };
                    core.declare_types(&definitions)?;
                    output::report(
                        &serde_json::json!({ "declared": definitions.len() }),
                        json,
                        || format!("declared {} type(s)", definitions.len()),
                    )
                }
                TypesCommand::Declared => {
                    let declared = core.declared_types()?;
                    output::report(&declared, json, || {
                        declared
                            .iter()
                            .filter_map(|held| held["id"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                }
                TypesCommand::List => {
                    let types = core.item_types()?;
                    output::report(&types, json, || {
                        types.iter().map(type_line).collect::<Vec<_>>().join("\n")
                    })
                }
                TypesCommand::Get { id } => {
                    let held = core.item_type(&id)?;
                    output::report(&held, json, || {
                        let mut lines = vec![type_line(&held)];
                        for (name, value) in [
                            ("title", &held.title_field),
                            ("body", &held.body_field),
                            ("link", &held.link_field),
                        ] {
                            if let Some(value) = value {
                                lines.push(format!("  {name} field {value}"));
                            }
                        }
                        lines.extend(held.fields.iter().map(field_line));
                        lines.join("\n")
                    })
                }
            }
        }
        DeviceCommand::EdgeTypes { command } => {
            let core = store.open(None)?;
            match command {
                CatalogCommand::List => {
                    let types = core.edge_types()?;
                    output::report(&types, json, || {
                        types
                            .iter()
                            .map(edge_type_line)
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                }
                CatalogCommand::Get { id } => {
                    let held = core.edge_type(&id)?;
                    output::report(&held, json, || {
                        let mut lines = vec![
                            edge_type_line(&held),
                            format!(
                                "  from {} to {}, {} on delete",
                                held.source_type_constraints.join(","),
                                held.target_type_constraints.join(","),
                                held.cascade_on_delete
                            ),
                        ];
                        lines.extend(held.properties.iter().map(field_line));
                        lines.join("\n")
                    })
                }
            }
        }
    }
    .map(|()| Exit::Done)
}

fn type_line(held: &marfa_core::ItemType) -> String {
    format!(
        "{}  {}{}  {} field(s)",
        held.id,
        held.label.as_deref().unwrap_or("(no label)"),
        held.parent
            .as_deref()
            .map_or(String::new(), |parent| format!("  inherits {parent}")),
        held.fields.len()
    )
}

fn field_line(field: &marfa_core::TypeField) -> String {
    format!(
        "  {}  {}{}  from {}",
        field.name,
        field.r#type,
        if field.required { "  required" } else { "" },
        field.declared_by
    )
}

fn edge_type_line(held: &marfa_core::EdgeType) -> String {
    format!(
        "{}  {}  {}{}  written at its {}{}",
        held.id,
        held.label.as_deref().unwrap_or("(no label)"),
        held.cardinality,
        held.reverse_name
            .as_deref()
            .map_or(String::new(), |name| format!("  reverse {name}")),
        match held.written_at {
            marfa_core::End::Source => "source",
            marfa_core::End::Target => "target",
        },
        if held.shipped { "  shipped" } else { "" }
    )
}

fn edge_list(edges: &[marfa_core::Edge], json: bool) -> Result<(), CliError> {
    output::report(&edges, json, || {
        edges
            .iter()
            .map(|edge| {
                format!(
                    "{}  {} -> {}  {}  v{}",
                    edge.id, edge.source_id, edge.target_id, edge.edge_type, edge.version
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    })
}

fn blocked_reason() -> impl clap::builder::TypedValueParser<Value = marfa_core::BlockedReason> {
    use clap::builder::TypedValueParser;
    clap::builder::PossibleValuesParser::new(
        marfa_core::BlockedReason::ALL.map(marfa_core::BlockedReason::as_str),
    )
    .try_map(|reason| reason.parse::<marfa_core::BlockedReason>())
}

const CHANGES_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// A static, because a signal handler can reach nothing else.
static STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn stop_after(seconds: Option<u64>) -> &'static std::sync::atomic::AtomicBool {
    if let Some(seconds) = seconds {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(seconds));
            STOP.store(true, std::sync::atomic::Ordering::Relaxed);
        });
    }
    &STOP
}

extern "C" fn interrupted(_: libc::c_int) {
    STOP.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// `SA_RESETHAND`: a second Ctrl-C ends the process at once.
fn stop_on_interrupt() {
    // SAFETY: the handler only stores to an atomic, which is safe inside a
    // signal handler, and the action is fully initialized before it is
    // installed.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = interrupted as extern "C" fn(libc::c_int) as libc::sighandler_t;
        action.sa_flags = libc::SA_RESETHAND;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut());
    }
}

struct Store {
    db: Option<PathBuf>,
    reader: bool,
    makes: bool,
}

impl Store {
    fn open(&self, session: Option<Session>) -> Result<Core, CliError> {
        let Some(path) = &self.db else {
            return Err(CliError::NoStoreNamed);
        };
        if (self.reader || !self.makes) && !path.exists() {
            return Err(CliError::NoStoreAt(path.clone()));
        }
        if self.reader {
            return Ok(Core::open_reader(path)?);
        }
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
            && !parent.exists()
        {
            std::fs::create_dir_all(parent)?;
        }
        let (server, renew) = Session::split(session);
        let core = Core::open(path, server)?;
        renewing(&core, renew);
        Ok(core)
    }

    /// A reader resolves no server: the core refuses server commands on a
    /// reading handle, and resolving could refresh a stored token for nothing.
    fn open_with_server(&self, named: &Named) -> Result<Core, CliError> {
        if self.reader {
            return self.open(None);
        }
        self.open(Some(named.session()?))
    }
}

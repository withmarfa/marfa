//! The working copy: a local copy of a slice of one server, in a store
//! named by `--db`, and the queue of writes it holds for that server.

use std::path::PathBuf;

use clap::{Args, Subcommand};
use marfa_core::{
    Core, Draft, EdgeDraft, EdgeEdit, Edit, ListFilters, MetadataWrite, SearchFilters, Server, Sort,
};

use crate::error::CliError;
use crate::output;
use crate::remote::Named;
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
    },
    /// Apply every event since the last hydrate or catch-up.
    #[command(name = "catch-up")]
    CatchUp,
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
        /// How many hits at most.
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Every queued write and what became of it.
    Queue,
    /// Send what the queue holds and record what came back.
    ///
    /// One pass. A write that met a network rather than an answer is left
    /// where it was, uncounted, for the next drain.
    Drain,
    /// Clear the writes the server has answered.
    ///
    /// A queue nobody empties makes every later write slower. Blocked and
    /// dead rows stay, because a caller may still release them.
    Forget,
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
    /// What the local copy holds and where it came from.
    Status,
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
}

#[derive(Debug, Subcommand)]
pub enum EdgesCommand {
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
        #[arg(long, value_name = "JSON")]
        properties: String,
        /// The version the edit was based on. Required, as on an item.
        #[arg(long)]
        version: Option<i64>,
    },
    /// Drop an edge locally and queue the delete.
    Delete {
        /// The edge id.
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
    ///
    /// Named for the field rather than shortened to `--after`, because the
    /// binary sorts on three times — `created_at`, `updated_at` and this
    /// one — so an unqualified `--after` would not say which.
    #[arg(long = "occurred-after", value_name = "TIME")]
    pub occurred_after: Option<String>,
    /// Exclusive upper bound on the item's own time, RFC 3339.
    #[arg(long = "occurred-before", value_name = "TIME")]
    pub occurred_before: Option<String>,
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

pub fn run(args: DeviceArgs, named: &Named, json: bool) -> Result<(), CliError> {
    match args.command {
        DeviceCommand::Hydrate { types, tier } => {
            let report = open(&args.db, Some(named.server()?))?.hydrate(&types, tier.into())?;
            output::report(&report, json, || {
                format!(
                    "hydrated {} item(s) and {} edge(s) of {} at {} in {} page(s); cursor {}",
                    report.items,
                    report.edges,
                    report.types.join(","),
                    report.tier,
                    report.pages,
                    report.cursor
                )
            })
        }
        DeviceCommand::CatchUp => {
            let report = open(&args.db, Some(named.server()?))?.catch_up()?;
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
            let core = open(&args.db, None)?;
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
                    };
                    output::queued_one(&core.update_item(&args.id, &edit)?, json)
                }
                ItemsCommand::Delete { id } => output::queued_one(&core.delete_item(&id)?, json),
                ItemsCommand::Restore { id } => output::queued_one(&core.restore_item(&id)?, json),
                ItemsCommand::Transition { id, state } => {
                    output::queued_one(&core.transition_item(&id, state.into())?, json)
                }
            }
        }
        DeviceCommand::Search {
            query,
            state,
            all_states,
            type_,
            tags,
            limit,
        } => {
            let filters = SearchFilters {
                state: state.map(Into::into),
                all_states,
                r#type: type_,
                tags,
            };
            output::hits(
                &open(&args.db, None)?.search(&query, &filters, limit)?,
                json,
            )
        }
        DeviceCommand::Edges { command } => {
            let core = open(&args.db, None)?;
            match command {
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
                } => {
                    let edit = EdgeEdit {
                        properties: properties(&props)?,
                        base_version: version,
                    };
                    output::queued_one(&core.update_edge(&id, &edit)?, json)
                }
                EdgesCommand::Delete { id } => output::queued_one(&core.delete_edge(&id)?, json),
            }
        }
        DeviceCommand::Tags { command } => {
            let core = open(&args.db, None)?;
            let queued = match command {
                TagsCommand::Add { item, tag } => core.add_tag(&item, &tag)?,
                TagsCommand::Remove { item, tag } => core.remove_tag(&item, &tag)?,
            };
            output::queued_one(&queued, json)
        }
        DeviceCommand::Metadata { command } => {
            let core = open(&args.db, None)?;
            let (item, tags, replace) = match command {
                MetadataCommand::Replace { item, tags } => (item, tags, true),
                MetadataCommand::Merge { item, tags } => (item, tags, false),
            };
            let write = MetadataWrite { tags };
            output::queued_one(&core.write_metadata(&item, &write, replace)?, json)
        }
        DeviceCommand::Extensions { command } => {
            let core = open(&args.db, None)?;
            let queued = match command {
                ExtensionsCommand::Write {
                    item,
                    namespace,
                    body,
                } => {
                    // Parsed before it is queued, so a body that is not an
                    // object is refused here rather than sent and refused.
                    properties(&body)?;
                    core.write_extension(&item, &namespace, &body)?
                }
                ExtensionsCommand::Delete { item, namespace } => {
                    core.delete_extension(&item, &namespace)?
                }
            };
            output::queued_one(&queued, json)
        }
        DeviceCommand::Queue => output::queued(&open(&args.db, None)?.queue()?, json),
        DeviceCommand::Forget => {
            let cleared = open(&args.db, None)?.forget_answered()?;
            output::report(&cleared, json, || {
                format!("cleared {cleared} answered write(s)")
            })
        }
        DeviceCommand::Drain => {
            let report = open(&args.db, Some(named.server()?))?.drain()?;
            output::drained(&report, json)
        }
        DeviceCommand::Release { id, reason } => {
            let core = open(&args.db, None)?;
            let released = match (&id, &reason) {
                (_, Some(reason)) => core.release_reason(*reason)?,
                (Some(id), None) => usize::from(core.release(id)?),
                // clap refuses this combination, so reaching it means the
                // argument rules and this branch have drifted apart.
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
        DeviceCommand::Status => {
            let status = open(&args.db, None)?.status()?;
            output::report(&status, json, || {
                format!(
                    "server {}\nslice {} at {}\ncursor {}\nhydration {}\n{} item(s), {} edge(s)",
                    status.server_origin.as_deref().unwrap_or("(none)"),
                    if status.slice_types.is_empty() {
                        "(none)".to_string()
                    } else {
                        status.slice_types.join(",")
                    },
                    status
                        .slice_tier
                        .map(|tier| tier.to_string())
                        .unwrap_or_else(|| "(none)".into()),
                    status.event_cursor.as_deref().unwrap_or("(none)"),
                    status.hydration.as_str(),
                    status.items,
                    status.edges
                )
            })
        }
    }
}

/// The five reasons, read at the flag, so anything else is refused before
/// the store opens and `--help` lists what may be named.
fn blocked_reason() -> impl clap::builder::TypedValueParser<Value = marfa_core::BlockedReason> {
    use clap::builder::TypedValueParser;
    clap::builder::PossibleValuesParser::new(
        marfa_core::BlockedReason::ALL.map(marfa_core::BlockedReason::as_str),
    )
    .try_map(|reason| reason.parse::<marfa_core::BlockedReason>())
}

/// A working copy is named by `--db` or `MARFA_DB` or it does not exist:
/// there is no default store, because a store nobody named is one nobody
/// can find again. The file is made at the named path on first open, so
/// the state report is answerable before a hydration (`device.md` 5).
fn open(db: &Option<PathBuf>, server: Option<Server>) -> Result<Core, CliError> {
    let Some(path) = db else {
        return Err(CliError::NoStoreNamed);
    };
    let path = path.clone();
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
        && !parent.exists()
    {
        std::fs::create_dir_all(parent)?;
    }
    Ok(Core::open(path, server)?)
}

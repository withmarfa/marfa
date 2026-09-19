mod error;
mod output;
mod watch;

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use clap::{Args, Parser, Subcommand, ValueEnum};
use marfa_core::{
    Core, Draft, EdgeDraft, EdgeEdit, Edit, Folder, ListFilters, MetadataWrite, SearchFilters,
    Server, Slice, Sort,
};

use crate::error::CliError;

/// Marfa from the command line: a local copy of a slice of one server.
#[derive(Debug, Parser)]
#[command(name = "marfa", version)]
struct Cli {
    /// The local database file.
    #[arg(
        long,
        global = true,
        env = "MARFA_DB",
        value_name = "PATH",
        hide_env_values = true,
        help_heading = "Global"
    )]
    db: Option<PathBuf>,

    /// Print records as JSON.
    #[arg(long, global = true, help_heading = "Global")]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Args)]
struct ServerArgs {
    /// The server's base URL.
    #[arg(
        long,
        env = "MARFA_API_URL",
        value_name = "URL",
        hide_env_values = true
    )]
    url: String,

    /// A key for that server.
    #[arg(
        long,
        env = "MARFA_API_KEY",
        value_name = "KEY",
        hide_env_values = true
    )]
    key: String,
}

impl From<ServerArgs> for Server {
    fn from(args: ServerArgs) -> Server {
        Server {
            url: args.url,
            key: args.key,
        }
    }
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Replace the local copy with the declared types at one tier.
    Hydrate {
        #[command(flatten)]
        server: ServerArgs,
        /// Comma-separated type identifiers, such as core.note,core.file.
        #[arg(long, value_delimiter = ',', required = true, value_name = "TYPE")]
        types: Vec<String>,
        #[arg(long)]
        tier: Tier,
    },
    /// Apply every event since the last hydrate or catch-up.
    #[command(name = "catch-up")]
    CatchUp {
        #[command(flatten)]
        server: ServerArgs,
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
    Drain {
        #[command(flatten)]
        server: ServerArgs,
    },
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
        #[arg(long, value_name = "REASON")]
        reason: Option<String>,
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
    /// Folders on this machine: a directory that holds a slice as files.
    Folders {
        #[command(subcommand)]
        command: FoldersCommand,
    },
}

#[derive(Debug, Subcommand)]
enum ItemsCommand {
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
enum EdgesCommand {
    /// Link two items, and queue the edge.
    Create {
        #[arg(long, value_name = "ID")]
        source: String,
        #[arg(long, value_name = "ID")]
        target: String,
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
enum TagsCommand {
    /// Put one tag on an item.
    Add {
        /// The item id.
        item: String,
        tag: String,
    },
    /// Take one tag off an item.
    Remove {
        /// The item id.
        item: String,
        tag: String,
    },
}

#[derive(Debug, Subcommand)]
enum MetadataCommand {
    /// Write the item's tags whole, dropping any not named.
    Replace {
        /// The item id.
        item: String,
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
    },
    /// Add the named tags, leaving the rest.
    Merge {
        /// The item id.
        item: String,
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
    },
}

#[derive(Debug, Subcommand)]
enum ExtensionsCommand {
    /// Write one extension namespace.
    Write {
        /// The item id.
        item: String,
        namespace: String,
        /// The namespace's contents, as a JSON object.
        #[arg(long, value_name = "JSON", default_value = "{}")]
        body: String,
    },
    /// Remove one extension namespace.
    Delete {
        /// The item id.
        item: String,
        namespace: String,
    },
}

#[derive(Debug, Args)]
struct CreateArgs {
    /// The type the item is.
    #[arg(long = "type", value_name = "TYPE")]
    type_: String,
    /// The properties, as a JSON object.
    #[arg(long, value_name = "JSON")]
    properties: String,
    /// A tag, repeatable. Each is queued as a write of its own.
    #[arg(long = "tag", value_name = "TAG")]
    tags: Vec<String>,
    /// The tier to write it at; the default is the library.
    #[arg(long)]
    tier: Option<Tier>,
    /// The source to stamp it with.
    #[arg(long)]
    source: Option<String>,
    /// The id this row has in the system it came from.
    #[arg(long)]
    source_id: Option<String>,
    /// The item's own time, RFC 3339. Defaults to now.
    #[arg(long)]
    occurred_at: Option<String>,
    /// The id to mint it under. Omitted, the device mints one.
    #[arg(long)]
    id: Option<String>,
    /// The version this create is conditional on, where its natural key
    /// resolves a row the server already holds.
    #[arg(long)]
    version: Option<i64>,
}

#[derive(Debug, Args)]
struct UpdateArgs {
    /// The item id.
    id: String,
    /// The properties to write, as a JSON object. Whole values.
    #[arg(long, value_name = "JSON")]
    properties: String,
    /// The version the edit was based on. Required: an update that names no
    /// version overwrites whatever it finds.
    #[arg(long)]
    version: Option<i64>,
}

#[derive(Debug, Args)]
struct ListArgs {
    /// A type identifier; its subtypes are included.
    #[arg(long = "type", value_name = "TYPE")]
    type_: Option<String>,
    /// Exactly one state. Unset answers the active state.
    #[arg(long)]
    state: Option<ItemState>,
    /// Every state, not just the active one.
    #[arg(long)]
    all_states: bool,
    /// Only items at this tier.
    #[arg(long)]
    tier: Option<Tier>,
    /// Items must carry every tag given.
    #[arg(long = "tag", value_name = "TAG")]
    tags: Vec<String>,
    /// Exclusive lower bound on the item's own time, RFC 3339.
    ///
    /// Named for the field rather than shortened to `--after`, because the
    /// binary sorts on three times — `created_at`, `updated_at` and this
    /// one — so an unqualified `--after` would not say which.
    #[arg(long = "occurred-after", value_name = "TIME")]
    occurred_after: Option<String>,
    /// Exclusive upper bound on the item's own time, RFC 3339.
    #[arg(long = "occurred-before", value_name = "TIME")]
    occurred_before: Option<String>,
    #[arg(long, default_value = "created-at")]
    sort: SortField,
    #[arg(long, default_value = "desc")]
    direction: SortDirection,
    /// How many items at most.
    #[arg(long)]
    limit: Option<u32>,
    /// How many items to skip first.
    #[arg(long)]
    offset: Option<u32>,
}

#[derive(Debug, Subcommand)]
enum FoldersCommand {
    /// Make a directory a folder: a view on a slice, with defaults.
    Add {
        /// The directory. It is made if it is not there.
        dir: PathBuf,
        /// The types this folder holds.
        #[arg(long, value_delimiter = ',', required = true, value_name = "TYPE")]
        types: Vec<String>,
        #[arg(long, default_value = "library")]
        tier: Tier,
        /// What a new file becomes. The default is the first type named.
        #[arg(long = "default-type", value_name = "TYPE")]
        default_type: Option<String>,
        /// Properties every new file gets, as a JSON object.
        #[arg(long, value_name = "JSON", default_value = "{}")]
        defaults: String,
        /// A tag every item in this folder carries.
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
    },
    /// Pull the folder's slice into its working copy.
    Hydrate {
        dir: PathBuf,
        #[command(flatten)]
        server: ServerArgs,
    },
    /// Read the folder and queue what has changed. Sends nothing.
    Scan { dir: PathBuf },
    /// Write the slice out as files.
    Pull { dir: PathBuf },
    /// Scan, drain and pull: everything a folder does, once.
    Push {
        dir: PathBuf,
        #[command(flatten)]
        server: ServerArgs,
    },
    /// Watch a folder and keep it in step until interrupted.
    Watch {
        /// The directory to watch, recursively.
        dir: PathBuf,
        #[command(flatten)]
        server: ServerArgs,
        /// Stop after this long. Unset, it runs until interrupted.
        #[arg(long, value_name = "SECONDS")]
        r#for: Option<u64>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum Tier {
    Library,
    Feed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum ItemState {
    Active,
    Archived,
    Trashed,
    Revoked,
}

// Every sortable column is a verb plus `_at`, so the shared `At` suffix the
// lint reports is the naming rule rather than noise the variants could drop.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum SortField {
    CreatedAt,
    UpdatedAt,
    OccurredAt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum SortDirection {
    Asc,
    Desc,
}

impl From<Tier> for marfa_core::Tier {
    fn from(tier: Tier) -> Self {
        match tier {
            Tier::Library => marfa_core::Tier::Library,
            Tier::Feed => marfa_core::Tier::Feed,
        }
    }
}

impl From<ItemState> for marfa_core::ItemState {
    fn from(state: ItemState) -> Self {
        match state {
            ItemState::Active => marfa_core::ItemState::Active,
            ItemState::Archived => marfa_core::ItemState::Archived,
            ItemState::Trashed => marfa_core::ItemState::Trashed,
            ItemState::Revoked => marfa_core::ItemState::Revoked,
        }
    }
}

impl From<SortField> for marfa_core::SortField {
    fn from(field: SortField) -> Self {
        match field {
            SortField::CreatedAt => marfa_core::SortField::CreatedAt,
            SortField::UpdatedAt => marfa_core::SortField::UpdatedAt,
            SortField::OccurredAt => marfa_core::SortField::OccurredAt,
        }
    }
}

impl From<SortDirection> for marfa_core::SortDirection {
    fn from(direction: SortDirection) -> Self {
        match direction {
            SortDirection::Asc => marfa_core::SortDirection::Ascending,
            SortDirection::Desc => marfa_core::SortDirection::Descending,
        }
    }
}

/// A `--properties` argument as the object the core takes.
///
/// Refused here rather than deeper, because a caller who typed malformed JSON
/// wants to hear about their argument rather than about a field a queue could
/// not build. An array or a bare value is refused for the same reason: the
/// wire shape is an object and a caller who sent something else meant an
/// object.
fn properties(text: &str) -> Result<serde_json::Map<String, serde_json::Value>, CliError> {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        Ok(_) => Err(CliError::Core(marfa_core::CoreError::Invalid(
            "--properties takes a JSON object".into(),
        ))),
        Err(error) => Err(CliError::Core(marfa_core::CoreError::Invalid(format!(
            "--properties is not JSON: {error}"
        )))),
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(CliError::ClosedOutput) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("marfa: {error}");
            ExitCode::from(1)
        }
    }
}

fn run(cli: Cli) -> Result<(), CliError> {
    let json = cli.json;
    match cli.command {
        Command::Hydrate {
            server,
            types,
            tier,
        } => {
            let report = open(&cli.db, Some(server))?.hydrate(&types, tier.into())?;
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
        Command::CatchUp { server } => {
            let report = open(&cli.db, Some(server))?.catch_up()?;
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
        Command::Items { command } => {
            let core = open(&cli.db, None)?;
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
        Command::Search {
            query,
            state,
            all_states,
            limit,
        } => {
            let filters = SearchFilters {
                state: state.map(Into::into),
                all_states,
            };
            output::hits(&open(&cli.db, None)?.search(&query, &filters, limit)?, json)
        }
        Command::Edges { command } => {
            let core = open(&cli.db, None)?;
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
        Command::Tags { command } => {
            let core = open(&cli.db, None)?;
            let queued = match command {
                TagsCommand::Add { item, tag } => core.add_tag(&item, &tag)?,
                TagsCommand::Remove { item, tag } => core.remove_tag(&item, &tag)?,
            };
            output::queued_one(&queued, json)
        }
        Command::Metadata { command } => {
            let core = open(&cli.db, None)?;
            let (item, tags, replace) = match command {
                MetadataCommand::Replace { item, tags } => (item, tags, true),
                MetadataCommand::Merge { item, tags } => (item, tags, false),
            };
            let write = MetadataWrite { tags };
            output::queued_one(&core.write_metadata(&item, &write, replace)?, json)
        }
        Command::Extensions { command } => {
            let core = open(&cli.db, None)?;
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
        Command::Queue => output::queued(&open(&cli.db, None)?.queue()?, json),
        Command::Forget => {
            let cleared = open(&cli.db, None)?.forget_answered()?;
            output::report(&cleared, json, || {
                format!("cleared {cleared} answered write(s)")
            })
        }
        Command::Drain { server } => {
            let report = open(&cli.db, Some(server))?.drain()?;
            output::drained(&report, json)
        }
        Command::Release { id, reason } => {
            let core = open(&cli.db, None)?;
            let released = match (&id, &reason) {
                (_, Some(reason)) => core.release_reason(reason)?,
                (Some(id), None) => usize::from(core.release(id)?),
                // clap refuses this combination, so reaching it means the
                // argument rules and this branch have drifted apart.
                (None, None) => {
                    return Err(CliError::Core(marfa_core::CoreError::Invalid(
                        "name a queued write to release, or a reason to release every write blocked for it".into(),
                    )));
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
        Command::Status => {
            let status = open(&cli.db, None)?.status()?;
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
        Command::Folders { command } => folders(command, json),
    }
}

/// Every folder command. A folder carries its own store under `.marfa`, so
/// none of these takes `--db`: pointing one at another store would be two
/// folders sharing a mapping, and neither would be right about the other's
/// files.
fn folders(command: FoldersCommand, json: bool) -> Result<(), CliError> {
    match command {
        FoldersCommand::Add {
            dir,
            types,
            tier,
            default_type,
            defaults,
            tags,
        } => {
            let slice = Slice {
                default_type: default_type
                    .unwrap_or_else(|| types.first().cloned().unwrap_or_default()),
                types,
                tier: tier.into(),
                defaults: properties(&defaults)?,
                tags,
            };
            let folder = Folder::add(&dir, slice, None)?;
            output::report(folder.slice(), json, || {
                format!("{} is a folder", folder.root().display())
            })
        }
        FoldersCommand::Hydrate { dir, server } => {
            let folder = Folder::open(&dir, Some(server.into()))?;
            let report = folder.hydrate()?;
            output::report(&report, json, || {
                format!("{} item(s) into {}", report.items, dir.display())
            })
        }
        FoldersCommand::Scan { dir } => {
            let report = Folder::open(&dir, None)?.scan()?;
            output::report(&report, json, || describe_scan(&report))
        }
        FoldersCommand::Pull { dir } => {
            let report = Folder::open(&dir, None)?.pull()?;
            output::report(&report, json, || describe_pull(&report))
        }
        FoldersCommand::Push { dir, server } => {
            let folder = Folder::open(&dir, Some(server.into()))?;
            let scanned = folder.scan()?;
            let drained = folder.core().drain()?;
            let pulled = folder.pull()?;
            output::report(
                &serde_json::json!({
                    "scan": scanned,
                    "drain": drained,
                    "pull": pulled,
                }),
                json,
                || {
                    format!(
                        "{}\nsent {}, held {}\n{} file(s) written",
                        describe_scan(&scanned),
                        drained.sent,
                        drained.held,
                        pulled.written + pulled.rewritten
                    )
                },
            )
        }
        FoldersCommand::Watch { dir, server, r#for } => {
            watch::watch(&dir, server.into(), r#for.map(Duration::from_secs), json)
        }
    }
}

/// What a pull did, for somebody who did not ask for JSON.
///
/// The three counts after the semicolon are items that have no file and are
/// not going to get one, which `folders.md` 20 requires be reported and which
/// a line of the first five numbers alone says nothing about: a person
/// reading five zeroes has been told the pull was quiet, not that it declined
/// to write. Left off when they are zero, because the ordinary pull is the
/// one nobody needs to read twice.
fn describe_pull(report: &marfa_core::PullReport) -> String {
    let mut line = format!(
        "{} written, {} rewritten, {} moved, {} unchanged, {} skipped",
        report.written, report.rewritten, report.moved, report.unchanged, report.skipped
    );
    let held: Vec<String> = [
        (report.unwritten, "changed since the folder wrote them"),
        (report.collided, "wanting a path another item took"),
        (report.outside, "wanting a path outside the folder"),
    ]
    .into_iter()
    .filter(|(count, _)| *count > 0)
    .map(|(count, why)| format!("{count} {why}"))
    .collect();
    if !held.is_empty() {
        line.push_str("; not written: ");
        line.push_str(&held.join(", "));
    }
    line
}

fn describe_scan(report: &marfa_core::ScanReport) -> String {
    format!(
        "{} created, {} updated, {} renamed, {} unchanged, {} missing, {} deleted, {} skipped",
        report.created,
        report.updated,
        report.renamed,
        report.unchanged,
        report.missing,
        report.deleted,
        report.skipped
    )
}

fn open(db: &Option<PathBuf>, server: Option<ServerArgs>) -> Result<Core, CliError> {
    let path = match db {
        Some(path) => path.clone(),
        None => default_db_path()?,
    };
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
        && !parent.exists()
    {
        std::fs::create_dir_all(parent)?;
    }
    let server = server.map(|server| Server {
        url: server.url,
        key: server.key,
    });
    Ok(Core::open(path, server)?)
}

fn default_db_path() -> Result<PathBuf, CliError> {
    directories::ProjectDirs::from("", "", "marfa")
        .map(|dirs| dirs.data_dir().join("core.sqlite"))
        .ok_or(CliError::NoDataDirectory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn the_command_tree_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn hydrate_parses_a_type_list_and_a_tier_and_needs_both_server_args() {
        let cli = Cli::try_parse_from([
            "marfa",
            "hydrate",
            "--url",
            "http://localhost:8600",
            "--key",
            "k",
            "--types",
            "core.note,core.file",
            "--tier",
            "library",
        ])
        .unwrap();
        match cli.command {
            Command::Hydrate {
                server,
                types,
                tier,
            } => {
                assert_eq!(server.url, "http://localhost:8600");
                assert_eq!(types, vec!["core.note", "core.file"]);
                assert_eq!(tier, Tier::Library);
            }
            other => panic!("{other:?}"),
        }
        let refused = Cli::try_parse_from([
            "marfa",
            "hydrate",
            "--url",
            "http://localhost:8600",
            "--key",
            "k",
            "--types",
            "core.note",
            "--tier",
            "all",
        ]);
        assert!(refused.is_err());
        let missing_key = Cli::try_parse_from([
            "marfa",
            "hydrate",
            "--url",
            "http://localhost:8600",
            "--types",
            "core.note",
            "--tier",
            "feed",
        ]);
        assert!(missing_key.is_err());
    }

    /// The release door takes one row or one reason, never both and never
    /// neither.
    ///
    /// `clap` enforces it and the dispatch has a branch that says so, and the
    /// two are asserted together here: without the refusals, `marfa release`
    /// with no argument would reach a branch that exists only because it
    /// cannot be reached.
    #[test]
    fn release_takes_one_row_or_one_reason_and_refuses_the_other_shapes() {
        match Cli::try_parse_from(["marfa", "release", "abc"])
            .unwrap()
            .command
        {
            Command::Release { id, reason } => {
                assert_eq!(id.as_deref(), Some("abc"));
                assert_eq!(reason, None);
            }
            other => panic!("`release <id>` parsed as {other:?}"),
        }
        match Cli::try_parse_from(["marfa", "release", "--reason", "key_spent"])
            .unwrap()
            .command
        {
            Command::Release { id, reason } => {
                assert_eq!(id, None);
                assert_eq!(reason.as_deref(), Some("key_spent"));
            }
            other => panic!("`release --reason` parsed as {other:?}"),
        }
        assert!(
            Cli::try_parse_from(["marfa", "release"]).is_err(),
            "`release` with neither a row nor a reason was accepted, so the door \
             would have to guess which writes a caller meant"
        );
        assert!(
            Cli::try_parse_from(["marfa", "release", "abc", "--reason", "key_spent"]).is_err(),
            "`release` took a row and a reason together, and the two select \
             different sets: whichever the dispatch reads, the other was ignored"
        );
    }

    #[test]
    fn drain_needs_a_server_because_it_is_the_one_command_that_sends() {
        match Cli::try_parse_from([
            "marfa",
            "drain",
            "--url",
            "http://localhost:8600",
            "--key",
            "marfa_k1_test",
        ])
        .unwrap()
        .command
        {
            Command::Drain { server } => assert_eq!(server.url, "http://localhost:8600"),
            other => panic!("`drain` parsed as {other:?}"),
        }
        assert!(
            Cli::try_parse_from(["marfa", "drain"]).is_err(),
            "`drain` was accepted with no server, and a drain with nowhere to send \
             is a command that can only refuse once it has opened the store"
        );
    }

    #[test]
    fn items_list_search_catch_up_status_and_watch_parse() {
        let cli = Cli::try_parse_from([
            "marfa",
            "--json",
            "items",
            "list",
            "--type",
            "core.note",
            "--tag",
            "a",
            "--tag",
            "b",
            "--state",
            "archived",
            "--sort",
            "occurred-at",
            "--direction",
            "asc",
            "--limit",
            "5",
        ])
        .unwrap();
        assert!(cli.json);
        match cli.command {
            Command::Items {
                command: ItemsCommand::List(args),
            } => {
                assert_eq!(args.type_.as_deref(), Some("core.note"));
                assert_eq!(args.tags, vec!["a", "b"]);
                assert_eq!(args.state, Some(ItemState::Archived));
                assert_eq!(args.sort, SortField::OccurredAt);
                assert_eq!(args.direction, SortDirection::Asc);
                assert_eq!(args.limit, Some(5));
            }
            other => panic!("{other:?}"),
        }
        assert!(Cli::try_parse_from(["marfa", "items", "list", "--state", "gone"]).is_err());
        assert!(matches!(
            Cli::try_parse_from(["marfa", "search", "zebra"])
                .unwrap()
                .command,
            Command::Search { limit: 20, .. }
        ));
        assert!(matches!(
            Cli::try_parse_from([
                "marfa",
                "catch-up",
                "--url",
                "http://localhost:8600",
                "--key",
                "k"
            ])
            .unwrap()
            .command,
            Command::CatchUp { .. }
        ));
        assert!(matches!(
            Cli::try_parse_from(["marfa", "status"]).unwrap().command,
            Command::Status
        ));
        // A folder watch needs a server now: it sends what the folder
        // queues, where the old stub only printed what changed.
        assert!(
            Cli::try_parse_from(["marfa", "folders", "watch", "."]).is_err(),
            "`folders watch` was accepted with no server, and a watch that \
             cannot send is a watch that queues for ever"
        );
        assert!(matches!(
            Cli::try_parse_from([
                "marfa",
                "folders",
                "watch",
                ".",
                "--url",
                "http://localhost:8600",
                "--key",
                "marfa_k1_test",
            ])
            .unwrap()
            .command,
            Command::Folders {
                command: FoldersCommand::Watch { .. }
            }
        ));
        // A folder carries its own store, so the reading commands take no
        // server at all.
        assert!(matches!(
            Cli::try_parse_from(["marfa", "folders", "scan", "."])
                .unwrap()
                .command,
            Command::Folders {
                command: FoldersCommand::Scan { .. }
            }
        ));
        match Cli::try_parse_from([
            "marfa",
            "folders",
            "add",
            "notes",
            "--types",
            "core.note,core.file",
            "--tag",
            "inbox",
        ])
        .unwrap()
        .command
        {
            Command::Folders {
                command: FoldersCommand::Add { types, tags, .. },
            } => {
                assert_eq!(types, vec!["core.note", "core.file"]);
                assert_eq!(tags, vec!["inbox"]);
            }
            other => panic!("`folders add` parsed as {other:?}"),
        }
        assert!(matches!(
            Cli::try_parse_from(["marfa", "items", "get", "abc"])
                .unwrap()
                .command,
            Command::Items {
                command: ItemsCommand::Get { .. }
            }
        ));
    }
}

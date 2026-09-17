mod output;
mod watch;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use marfa_core::{
    Core, CoreError, ItemState, ListFilters, Server, Sort, SortDirection, SortField, Tier,
};

/// Marfa from the command line: a local copy of a slice of one server.
#[derive(Debug, Parser)]
#[command(name = "marfa", version, about)]
struct Cli {
    /// The local database file.
    #[arg(long, global = true, env = "MARFA_DB", value_name = "PATH")]
    db: Option<PathBuf>,

    /// The server's base URL.
    #[arg(long, global = true, env = "MARFA_API_URL", value_name = "URL")]
    url: Option<String>,

    /// A key for that server.
    #[arg(
        long,
        global = true,
        env = "MARFA_API_KEY",
        value_name = "KEY",
        hide_env_values = true
    )]
    key: Option<String>,

    /// Print records as JSON.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Replace the local copy with the declared types at one tier.
    Hydrate {
        /// Comma-separated type identifiers, such as core.note,core.file.
        #[arg(long, value_delimiter = ',', required = true)]
        types: Vec<String>,
        /// library or feed.
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
    /// Full-text search over the local copy.
    Search {
        query: String,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// What the local copy holds and where it came from.
    Status,
    /// Folders on this machine.
    Folders {
        #[command(subcommand)]
        command: FoldersCommand,
    },
}

#[derive(Debug, Subcommand)]
enum ItemsCommand {
    /// List items, newest first unless sorted otherwise.
    List(ListArgs),
    /// One item by id.
    Get { id: String },
}

#[derive(Debug, Args)]
struct ListArgs {
    /// A type identifier; its subtypes are included.
    #[arg(long = "type")]
    type_: Option<String>,
    /// active, archived, trashed or revoked. Unset hides trashed items.
    #[arg(long)]
    state: Option<ItemState>,
    /// Every state, the bin included.
    #[arg(long)]
    include_trashed: bool,
    #[arg(long)]
    tier: Option<Tier>,
    /// Items must carry every tag given.
    #[arg(long = "tag")]
    tags: Vec<String>,
    /// Lower bound on the item's own time, RFC 3339.
    #[arg(long)]
    after: Option<String>,
    /// Upper bound on the item's own time, RFC 3339.
    #[arg(long)]
    before: Option<String>,
    /// created_at, updated_at or timestamp.
    #[arg(long, default_value = "created_at")]
    sort: SortField,
    /// asc or desc.
    #[arg(long, default_value = "desc")]
    direction: SortDirection,
    #[arg(long)]
    limit: Option<u32>,
    #[arg(long)]
    offset: Option<u32>,
}

#[derive(Debug, Subcommand)]
enum FoldersCommand {
    /// Print what changes under a directory. Writes nothing.
    Watch { dir: PathBuf },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("marfa: {error}");
            ExitCode::from(1)
        }
    }
}

fn run(cli: Cli) -> Result<(), CoreError> {
    if let Command::Folders {
        command: FoldersCommand::Watch { dir },
    } = &cli.command
    {
        return watch::watch(dir);
    }
    let core = open(&cli)?;
    match cli.command {
        Command::Hydrate { types, tier } => {
            let report = core.hydrate(&types, tier)?;
            output::report(&report, cli.json, || {
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
        Command::CatchUp => {
            let report = core.catch_up()?;
            output::report(&report, cli.json, || {
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
        Command::Items { command } => match command {
            ItemsCommand::List(args) => {
                let filters = ListFilters {
                    r#type: args.type_,
                    state: args.state,
                    include_trashed: args.include_trashed,
                    tier: args.tier,
                    tags: args.tags,
                    timestamp_after: args.after,
                    timestamp_before: args.before,
                    limit: args.limit,
                    offset: args.offset,
                };
                let sort = Sort {
                    field: args.sort,
                    direction: args.direction,
                };
                output::items(&core.list(&filters, sort)?, cli.json)
            }
            ItemsCommand::Get { id } => match core.get(&id)? {
                Some(item) => output::item(&item, cli.json),
                None => Err(CoreError::NotFound {
                    code: "item_not_found".into(),
                    message: format!("{id} is not in the local copy"),
                }),
            },
        },
        Command::Search { query, limit } => output::hits(&core.search(&query, limit)?, cli.json),
        Command::Status => {
            let status = core.status()?;
            output::report(&status, cli.json, || {
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
                    if status.hydration_complete {
                        "complete"
                    } else {
                        "incomplete"
                    },
                    status.items,
                    status.edges
                )
            })
        }
        Command::Folders { .. } => unreachable!("handled before the store opens"),
    }
}

fn open(cli: &Cli) -> Result<Core, CoreError> {
    let server = match (&cli.url, &cli.key) {
        (Some(url), Some(key)) => Some(Server {
            url: url.clone(),
            key: key.clone(),
        }),
        (None, None) => None,
        _ => {
            return Err(CoreError::Invalid(
                "--url and --key go together (or MARFA_API_URL and MARFA_API_KEY)".into(),
            ));
        }
    };
    let path = match &cli.db {
        Some(path) => path.clone(),
        None => default_db_path()?,
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| CoreError::Store(format!("{}: {error}", parent.display())))?;
    }
    Core::open(path, server)
}

fn default_db_path() -> Result<PathBuf, CoreError> {
    directories::ProjectDirs::from("", "", "marfa")
        .map(|dirs| dirs.data_dir().join("core.sqlite"))
        .ok_or_else(|| CoreError::Invalid("no data directory on this system; pass --db".into()))
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
    fn hydrate_parses_a_type_list_and_a_tier() {
        let cli = Cli::try_parse_from([
            "marfa",
            "--url",
            "http://localhost:8600",
            "--key",
            "k",
            "hydrate",
            "--types",
            "core.note,core.file",
            "--tier",
            "library",
        ])
        .unwrap();
        match cli.command {
            Command::Hydrate { types, tier } => {
                assert_eq!(types, vec!["core.note", "core.file"]);
                assert_eq!(tier, Tier::Library);
            }
            other => panic!("{other:?}"),
        }
        assert!(
            Cli::try_parse_from(["marfa", "hydrate", "--types", "core.note", "--tier", "all"])
                .is_err()
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
            "--sort",
            "timestamp",
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
                assert_eq!(args.sort, SortField::Timestamp);
                assert_eq!(args.direction, SortDirection::Ascending);
                assert_eq!(args.limit, Some(5));
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            Cli::try_parse_from(["marfa", "search", "zebra"])
                .unwrap()
                .command,
            Command::Search { limit: 20, .. }
        ));
        assert!(matches!(
            Cli::try_parse_from(["marfa", "catch-up"]).unwrap().command,
            Command::CatchUp
        ));
        assert!(matches!(
            Cli::try_parse_from(["marfa", "status"]).unwrap().command,
            Command::Status
        ));
        assert!(matches!(
            Cli::try_parse_from(["marfa", "folders", "watch", "."])
                .unwrap()
                .command,
            Command::Folders {
                command: FoldersCommand::Watch { .. }
            }
        ));
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

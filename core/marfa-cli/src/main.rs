mod error;
mod output;
mod watch;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand, ValueEnum};
use marfa_core::{Core, ListFilters, SearchFilters, Server, Sort};

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
    /// What the local copy holds and where it came from.
    Status,
    /// Watch a folder on this machine.
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
    /// Print what changes under a directory. Writes nothing.
    Watch {
        /// The directory to watch, recursively.
        dir: PathBuf,
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
        Command::Folders {
            command: FoldersCommand::Watch { dir },
        } => watch::watch(&dir),
    }
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

mod auth;
mod commands;
mod credentials;
mod device;
#[cfg(test)]
mod door;
mod error;
mod folders;
mod output;
mod remote;
mod values;
mod watch;

use std::process::ExitCode;

use clap::{Parser, Subcommand};

use crate::commands::{
    audit, blobs, config, connectors, edge_types, edges, events, export, extensions, housekeeping,
    items, keys, login, logout, metadata, operations, owner, restore, search, status, types,
    webhooks, whoami,
};
use crate::device::DeviceArgs;
use crate::error::{CliError, EXIT_CODES_HELP};
use crate::folders::FoldersCommand;
use crate::output::Printer;
use crate::remote::{Named, Remote};

/// Marfa from the command line: every operation of one instance, a working
/// copy of a slice of it under `device`, and folders that hold a slice as
/// files.
#[derive(Debug, Parser)]
#[command(name = "marfa", version, after_long_help = EXIT_CODES_HELP)]
struct Cli {
    /// The server's base URL. Falls back to MARFA_API_URL, then to the
    /// server a kept credential made current.
    #[arg(long, global = true, value_name = "URL", help_heading = "Server")]
    url: Option<String>,

    /// A key or a token for that server. Falls back to MARFA_API_KEY, then
    /// to the keychain: the file MARFA_KEYCHAIN names, where it names one.
    #[arg(long, global = true, value_name = "KEY", help_heading = "Server")]
    key: Option<String>,

    /// Print the answer as JSON, and a refusal as one JSON object on stderr.
    #[arg(long, global = true, help_heading = "Output")]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// What the instance says about itself, and item counts where the credential reaches them.
    Status,
    /// Which server, instance and credential a bare command would use.
    Whoami,
    /// Sign in to a server as the owner: a code, approved in the browser.
    Login(login::LoginArgs),
    /// Sign out of a server: the token is revoked and forgotten.
    Logout,
    /// The owner: the one account behind the sign-in surface.
    Owner {
        #[command(subcommand)]
        command: owner::OwnerCommand,
    },
    /// Items: create, read, change, tag, link, attach, and the bulk doors.
    Items {
        #[command(subcommand)]
        command: items::ItemsCommand,
    },
    /// Edges between items.
    Edges {
        #[command(subcommand)]
        command: edges::EdgesCommand,
    },
    /// The edge types an instance holds.
    #[command(name = "edge-types")]
    EdgeTypes {
        #[command(subcommand)]
        command: edge_types::EdgeTypesCommand,
    },
    /// The types an instance holds, and the shipped ones it has outgrown.
    Types {
        #[command(subcommand)]
        command: types::TypesCommand,
    },
    /// Full-text search on the server, best match first.
    Search(search::SearchArgs),
    /// An item's tags and the namespaces it carries, and every tag in use.
    Metadata {
        #[command(subcommand)]
        command: metadata::MetadataCommand,
    },
    /// An item's extension namespaces.
    Extensions {
        #[command(subcommand)]
        command: extensions::ExtensionsCommand,
    },
    /// Bytes stored by content hash, and the stores that hold them.
    Blobs {
        #[command(subcommand)]
        command: blobs::BlobsCommand,
    },
    /// Keys: the credentials that reach the API.
    Keys {
        #[command(subcommand)]
        command: keys::KeysCommand,
    },
    /// The instance configuration.
    Config {
        #[command(subcommand)]
        command: config::ConfigCommand,
    },
    /// Export the instance's data.
    Export(export::ExportArgs),
    /// Take an archive back. Operator key only.
    Restore(restore::RestoreArgs),
    /// Outbound subscriptions that send events out. Every command needs `webhooks.manage`.
    Webhooks {
        #[command(subcommand)]
        command: webhooks::WebhooksCommand,
    },
    /// The audit log: every write, with the acting key. Needs `audit.read`.
    Audit(audit::AuditArgs),
    /// The event stream, one frame per line.
    Events(events::EventsArgs),
    /// The housekeeping jobs the server runs on itself. Operator key only.
    Housekeeping {
        #[command(subcommand)]
        command: housekeeping::HousekeepingCommand,
    },
    /// Processes that write on a key's behalf: registered, heard from, and
    /// reporting their runs. A key registers itself; the operator key sees
    /// every registration and may remove one.
    Connectors {
        #[command(subcommand)]
        command: connectors::ConnectorsCommand,
    },
    /// Every published operation and the command that reaches it.
    Operations,
    /// A working copy of a slice of one server, in the store --db names.
    Device(DeviceArgs),
    /// Folders on this machine, a directory that holds a slice as files, and
    /// their settings on the server.
    Folders {
        #[command(subcommand)]
        command: FoldersCommand,
    },
}

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => match usage(&error, std::env::args_os()) {
            Some(refusal) => return refused(&refusal, true),
            None => error.exit(),
        },
    };
    let json = cli.json;
    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(CliError::ClosedOutput) => ExitCode::SUCCESS,
        Err(error) => refused(&error, json),
    }
}

fn refused(error: &CliError, json: bool) -> ExitCode {
    if json {
        eprintln!("{}", error.envelope());
    } else {
        eprintln!("marfa: {error}");
    }
    ExitCode::from(error.exit() as u8)
}

/// The parser's refusal as the envelope, where the command line asked for
/// JSON. `None` leaves it to the parser: help and the version are answers
/// rather than refusals, and without `--json` the usage text is what a
/// person reads.
///
/// `--json` is looked for in the arguments themselves, since a command line
/// the parser refused has no parsed flags to read it from.
fn usage(
    error: &clap::Error,
    args: impl IntoIterator<Item = std::ffi::OsString>,
) -> Option<CliError> {
    use clap::error::ErrorKind;
    if matches!(
        error.kind(),
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
    ) {
        return None;
    }
    let json = args
        .into_iter()
        .skip(1)
        .take_while(|arg| arg != "--")
        .any(|arg| arg == "--json");
    if !json {
        return None;
    }
    let message = match error.kind() {
        ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => {
            "a subcommand is required; --help lists them".to_string()
        }
        // The paragraph before the usage text, which names what was wrong.
        _ => error
            .render()
            .to_string()
            .lines()
            .take_while(|line| !line.trim().is_empty())
            .map(str::trim)
            .collect::<Vec<_>>()
            .join(" ")
            .trim_start_matches("error: ")
            .to_string(),
    };
    Some(CliError::Usage(message))
}

fn run(cli: Cli) -> Result<(), CliError> {
    let out = Printer { json: cli.json };
    let named = Named {
        url: cli.url,
        key: cli.key,
    };
    // Resolved by the commands that talk to a server: the working copy and
    // the folders resolve it only where a command sends, the table needs no
    // server at all, and signing in and out take the server without a
    // credential, since a sign-in has none yet and a sign-out is giving
    // its up.
    let remote = || Remote::resolve(&named);
    match cli.command {
        Command::Operations => operations::run(&out),
        Command::Login(args) => login::run(args, &named, &out),
        Command::Logout => logout::run(&named, &out),
        Command::Owner { command } => owner::run(command, &remote()?, &out),
        Command::Device(args) => device::run(args, &named, cli.json),
        Command::Folders { command } => folders::run(command, &named, cli.json),
        Command::Status => status::run(&remote()?, &out),
        Command::Whoami => whoami::run(&remote()?, &out),
        Command::Items { command } => items::run(command, &remote()?, &out),
        Command::Edges { command } => edges::run(command, &remote()?, &out),
        Command::EdgeTypes { command } => edge_types::run(command, &remote()?, &out),
        Command::Types { command } => types::run(command, &remote()?, &out),
        Command::Search(args) => search::run(args, &remote()?, &out),
        Command::Metadata { command } => metadata::run(command, &remote()?, &out),
        Command::Extensions { command } => extensions::run(command, &remote()?, &out),
        Command::Blobs { command } => blobs::run(command, &remote()?, &out),
        Command::Keys { command } => keys::run(command, &remote()?, &out),
        Command::Config { command } => config::run(command, &remote()?, &out),
        Command::Export(args) => export::run(args, &remote()?, &out),
        Command::Restore(args) => restore::run(args, &remote()?, &out),
        Command::Webhooks { command } => webhooks::run(command, &remote()?, &out),
        Command::Audit(args) => audit::run(args, &remote()?, &out),
        Command::Events(args) => events::run(args, &remote()?, &out),
        Command::Housekeeping { command } => housekeeping::run(command, &remote()?, &out),
        Command::Connectors { command } => connectors::run(command, &remote()?, &out),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::{DeviceCommand, ItemsCommand as DeviceItemsCommand};
    use crate::values::{ItemState, SortDirection, SortField, Tier};
    use clap::CommandFactory;

    #[test]
    fn the_command_tree_is_well_formed() {
        Cli::command().debug_assert();
    }

    /// Every subcommand has an `about` and every argument has help. This is
    /// the gate on "help is complete": a leaf added without a sentence is
    /// red here rather than found by a person typing `--help`.
    #[test]
    fn every_command_and_argument_is_documented() {
        fn walk(command: &clap::Command, path: &str, missing: &mut Vec<String>) {
            for arg in command.get_arguments() {
                if arg.get_help().is_none() {
                    let shown = if arg.is_positional() {
                        format!("<{}>", arg.get_id())
                    } else {
                        format!("--{}", arg.get_id())
                    };
                    missing.push(format!("{path} {shown}"));
                }
            }
            for sub in command.get_subcommands() {
                let here = format!("{path} {}", sub.get_name());
                if sub.get_about().is_none() {
                    missing.push(here.clone());
                }
                walk(sub, &here, missing);
            }
        }
        let mut missing = Vec::new();
        walk(&Cli::command(), "marfa", &mut missing);
        assert!(missing.is_empty(), "undocumented: {}", missing.join(", "));
    }

    fn device(args: &[&str]) -> DeviceCommand {
        let mut argv = vec!["marfa", "device", "--db", "store.sqlite"];
        argv.extend(args);
        match Cli::try_parse_from(argv).unwrap().command {
            Command::Device(device) => device.command,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn hydrate_parses_a_type_list_and_a_tier() {
        match device(&[
            "hydrate",
            "--types",
            "core.note,core.file",
            "--tier",
            "library",
        ]) {
            DeviceCommand::Hydrate {
                types,
                tier,
                edge_types,
            } => {
                assert_eq!(types, vec!["core.note", "core.file"]);
                assert_eq!(tier, Tier::Library);
                assert!(edge_types.is_empty());
            }
            other => panic!("{other:?}"),
        }
        match device(&[
            "hydrate",
            "--types",
            "core.note",
            "--tier",
            "library",
            "--edge-type",
            "parent-of",
            "--edge-type",
            "references",
        ]) {
            DeviceCommand::Hydrate { edge_types, .. } => {
                assert_eq!(edge_types, vec!["parent-of", "references"]);
            }
            other => panic!("{other:?}"),
        }
        assert!(
            Cli::try_parse_from([
                "marfa",
                "device",
                "--db",
                "s",
                "hydrate",
                "--types",
                "core.note",
                "--tier",
                "all",
            ])
            .is_err(),
            "`all` is a tier filter, not a tier a slice can be hydrated at"
        );
        assert!(
            Cli::try_parse_from(["marfa", "device", "--db", "s", "hydrate", "--tier", "feed"])
                .is_err(),
            "a hydration with no types was accepted"
        );
    }

    /// The server is named once, at the root, and lands wherever it is
    /// written: before the subcommand, after it, or in the environment.
    #[test]
    fn the_server_is_named_at_the_root_and_reaches_every_command() {
        let before = Cli::try_parse_from([
            "marfa",
            "--url",
            "http://localhost:8600",
            "--key",
            "k",
            "device",
            "--db",
            "s",
            "catch-up",
        ])
        .unwrap();
        assert_eq!(before.url.as_deref(), Some("http://localhost:8600"));
        assert_eq!(before.key.as_deref(), Some("k"));
        let after = Cli::try_parse_from([
            "marfa",
            "device",
            "--db",
            "s",
            "drain",
            "--url",
            "http://localhost:8600",
            "--key",
            "k",
        ])
        .unwrap();
        assert_eq!(after.url.as_deref(), Some("http://localhost:8600"));
        assert!(matches!(
            after.command,
            Command::Device(DeviceArgs {
                command: DeviceCommand::Drain,
                ..
            })
        ));
        let direct = Cli::try_parse_from([
            "marfa",
            "items",
            "list",
            "--url",
            "http://localhost:8600",
            "--key",
            "k",
        ])
        .unwrap();
        assert_eq!(direct.key.as_deref(), Some("k"));
        assert!(matches!(
            direct.command,
            Command::Items {
                command: items::ItemsCommand::List(_)
            }
        ));
        let folder = Cli::try_parse_from([
            "marfa",
            "folders",
            "watch",
            ".",
            "--url",
            "http://localhost:8600",
            "--key",
            "k",
        ])
        .unwrap();
        assert_eq!(folder.key.as_deref(), Some("k"));
        assert!(matches!(
            folder.command,
            Command::Folders {
                command: FoldersCommand::Watch { .. }
            }
        ));
        // Absent, the parse succeeds and the refusal comes from the
        // resolution, as `remote::Remote::resolve` says.
        let none = Cli::try_parse_from(["marfa", "device", "--db", "s", "drain"]).unwrap();
        assert_eq!(none.url, None);
        assert_eq!(none.key, None);
    }

    /// The store is named on `device` and lands before or after the leaf,
    /// and is not an argument of anything else: a folder carries its own
    /// store, and a direct command has none.
    #[test]
    fn the_store_is_named_on_device_and_nowhere_else() {
        let before = Cli::try_parse_from(["marfa", "device", "--db", "s", "queue"]).unwrap();
        let after = Cli::try_parse_from(["marfa", "device", "queue", "--db", "s"]).unwrap();
        for cli in [before, after] {
            match cli.command {
                Command::Device(DeviceArgs {
                    db,
                    reader,
                    command,
                }) => {
                    assert_eq!(db.as_deref(), Some(std::path::Path::new("s")));
                    assert!(!reader);
                    assert!(matches!(command, DeviceCommand::Queue));
                }
                other => panic!("{other:?}"),
            }
        }
        // The witness for `!reader` above: named, before or after the leaf,
        // it parses true.
        for named in [
            ["marfa", "device", "--db", "s", "--reader", "queue"],
            ["marfa", "device", "queue", "--db", "s", "--reader"],
        ] {
            match Cli::try_parse_from(named).unwrap().command {
                Command::Device(DeviceArgs { reader, .. }) => assert!(reader),
                other => panic!("{other:?}"),
            }
        }
        assert!(
            Cli::try_parse_from(["marfa", "folders", "scan", ".", "--db", "s"]).is_err(),
            "a folder command took --db, so two folders could share one mapping"
        );
        assert!(
            Cli::try_parse_from(["marfa", "items", "list", "--db", "s"]).is_err(),
            "a direct command took --db, which names a working copy it does not read"
        );
        assert!(
            Cli::try_parse_from(["marfa", "--db", "s", "device", "queue"]).is_err(),
            "--db was accepted at the root, where every command could reach it"
        );
    }

    /// The release door takes one row or one reason, never both and never
    /// neither.
    ///
    /// `clap` enforces it and the dispatch has a branch that says so, and the
    /// two are asserted together here: without the refusals, `marfa device
    /// release` with no argument would reach a branch that exists only
    /// because it cannot be reached.
    #[test]
    fn release_takes_one_row_or_one_reason_and_refuses_the_other_shapes() {
        match device(&["release", "abc"]) {
            DeviceCommand::Release { id, reason } => {
                assert_eq!(id.as_deref(), Some("abc"));
                assert_eq!(reason, None);
            }
            other => panic!("`release <id>` parsed as {other:?}"),
        }
        match device(&["release", "--reason", "key_spent"]) {
            DeviceCommand::Release { id, reason } => {
                assert_eq!(id, None);
                assert_eq!(reason, Some(marfa_core::BlockedReason::KeySpent));
            }
            other => panic!("`release --reason` parsed as {other:?}"),
        }
        assert!(
            Cli::try_parse_from(["marfa", "device", "--db", "s", "release"]).is_err(),
            "`release` with neither a row nor a reason was accepted, so the door \
             would have to guess which writes a caller meant"
        );
        assert!(
            Cli::try_parse_from([
                "marfa",
                "device",
                "--db",
                "s",
                "release",
                "abc",
                "--reason",
                "key_spent",
            ])
            .is_err(),
            "`release` took a row and a reason together, and the two select \
             different sets: whichever the dispatch reads, the other was ignored"
        );
        assert!(
            Cli::try_parse_from([
                "marfa", "device", "--db", "s", "release", "--reason", "stuck"
            ])
            .is_err(),
            "`release` took a reason outside the five, so it opens the store to be told what the flag could have said"
        );
    }

    #[test]
    fn the_device_tree_and_the_folder_tree_parse() {
        let cli = Cli::try_parse_from([
            "marfa",
            "--json",
            "device",
            "--db",
            "s",
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
            Command::Device(DeviceArgs {
                command:
                    DeviceCommand::Items {
                        command: DeviceItemsCommand::List(args),
                    },
                ..
            }) => {
                assert_eq!(args.type_.as_deref(), Some("core.note"));
                assert_eq!(args.tags, vec!["a", "b"]);
                assert_eq!(args.state, Some(ItemState::Archived));
                assert_eq!(args.sort, SortField::OccurredAt);
                assert_eq!(args.direction, SortDirection::Asc);
                assert_eq!(args.limit, Some(5));
            }
            other => panic!("{other:?}"),
        }
        assert!(
            Cli::try_parse_from([
                "marfa", "device", "--db", "s", "items", "list", "--state", "gone",
            ])
            .is_err()
        );
        assert!(matches!(
            device(&["search", "zebra"]),
            DeviceCommand::Search { limit: 20, .. }
        ));
        assert!(matches!(device(&["catch-up"]), DeviceCommand::CatchUp));
        assert!(matches!(device(&["status"]), DeviceCommand::Status));
        assert!(matches!(
            device(&["items", "get", "abc"]),
            DeviceCommand::Items {
                command: DeviceItemsCommand::Get { .. }
            }
        ));
        assert!(matches!(
            Cli::try_parse_from(["marfa", "folders", "scan", "."])
                .unwrap()
                .command,
            Command::Folders {
                command: FoldersCommand::Scan { .. }
            }
        ));
        let add = ["marfa", "folders", "add", "notes", "--folder", "f1"];
        assert!(
            Cli::try_parse_from(add.iter().copied().chain(["--source", "notes"])).is_err(),
            "a folder names no source (`folders.md` 13)"
        );
        // A folder's settings are its `system.folder`'s, never flags here
        // (`folders.md` 1).
        for flag in [
            ["--types", "core.note"],
            ["--tier", "library"],
            ["--default-type", "core.note"],
            ["--defaults", "{}"],
            ["--tag", "inbox"],
        ] {
            assert!(
                Cli::try_parse_from(add.iter().copied().chain(flag)).is_err(),
                "`folders add` took {}",
                flag[0]
            );
        }
        assert!(
            Cli::try_parse_from(&add[..4]).is_err(),
            "`--folder` is required"
        );
        match Cli::try_parse_from(add).unwrap().command {
            Command::Folders {
                command: FoldersCommand::Add { folder, .. },
            } => assert_eq!(folder, "f1"),
            other => panic!("`folders add` parsed as {other:?}"),
        }
    }
}

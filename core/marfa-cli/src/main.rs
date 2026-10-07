mod auth;
mod commands;
mod credentials;
mod device;
#[cfg(test)]
mod door;
mod error;
mod folders;
mod output;
#[cfg(test)]
mod reference;
mod remote;
mod values;
mod watch;

use std::process::ExitCode;

use clap::{Parser, Subcommand};

use crate::commands::{
    audit, blobs, config, connectors, docs, edge_types, edges, events, export, extensions,
    housekeeping, items, keys, login, logout, metadata, operations, owner, restore, search, status,
    types, webhooks, whoami,
};
use crate::device::DeviceArgs;
use crate::error::{CliError, Exit, exit_codes_help};
use crate::folders::FoldersCommand;
use crate::output::Printer;
use crate::remote::{Named, Remote};

/// Marfa from the command line: every operation of one instance, a working
/// copy of a slice of it under `device`, and folders that hold a slice as
/// files.
#[derive(Debug, Parser)]
#[command(
    name = "marfa",
    version,
    max_term_width = 100,
    after_long_help = exit_codes_help()
)]
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
    /// Restore an archive. Operator key only.
    ///
    /// Preserves item and edge IDs, created_at and updated_at dates, current
    /// versions, tags, extensions, and the item's earlier versions carried in
    /// the archive. Existing items and their history remain unchanged.
    ///
    /// The archive contains only data the exporting credential could read,
    /// including history allowed by each snapshot's type permissions and blobs
    /// that credential could read. It does not restore keys, webhooks, or
    /// configuration. Trashed items are absent unless explicitly exported, for
    /// example with `export --format archive --state any`.
    ///
    /// Until the first public release, restore only with the server build that
    /// wrote the archive. Archive format 0 does not promise compatibility
    /// between builds.
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
    Docs(docs::DocsArgs),
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
        Ok(exit) => ExitCode::from(exit as u8),
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

/// `--json` is read from the raw arguments: a refused command line has no
/// parsed flags.
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

fn run(cli: Cli) -> Result<Exit, CliError> {
    let out = Printer { json: cli.json };
    let named = Named {
        url: cli.url,
        key: cli.key,
    };
    // Lazy: login, logout, device, folders and operations must run without
    // a resolved credential.
    let remote = || Remote::resolve(&named);
    match cli.command {
        Command::Operations => operations::run(&out),
        Command::Docs(args) => docs::run(args, &named, &out),
        Command::Login(args) => login::run(args, &named, &out),
        Command::Logout => logout::run(&named, &out),
        Command::Owner { command } => owner::run(command, &remote()?, &out),
        Command::Device(args) => return device::run(args, &named, cli.json),
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
        Command::Keys {
            command: keys::KeysCommand::Forget,
        } => {
            let url = Remote::url_named(&named)?;
            keys::run(keys::KeysCommand::Forget, &Remote::public_at(&url)?, &out)
        }
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
    .map(|()| Exit::Done)
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
}

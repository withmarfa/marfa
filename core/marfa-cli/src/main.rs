mod access;
#[cfg(target_os = "macos")]
mod acl;
mod auth;
mod autostart;
mod cleartext;
mod commands;
mod credentials;
mod device;
#[cfg(test)]
mod door;
mod environment;
mod error;
mod folders;
mod interrupt;
mod keyfile;
mod local;
mod logfile;
mod output;
mod profiles;
#[cfg(test)]
mod reference;
mod remote;
mod server;
mod storage;
mod style;
mod telemetry;
mod values;
mod watch;
mod writing;

use std::process::ExitCode;

use clap::{ArgMatches, CommandFactory, FromArgMatches, Parser, Subcommand};

use crate::commands::{
    apps, audit, blobs, config, connectors, docs, edge_types, edges, events, export, extensions,
    housekeeping, items, keys, login, logout, metadata, metrics, operations, owner, profile,
    restore, search, sign_ins, status, types, webhooks, whoami,
};
use crate::device::DeviceArgs;
use crate::error::{CliError, DOCS_HINT, Exit, long_help_footer};
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
    after_help = DOCS_HINT,
    after_long_help = long_help_footer()
)]
struct Cli {
    /// A profile in profiles.toml: a server, and where its key comes from.
    /// Not the owner's profile, which `marfa profile` changes.
    ///
    /// The file is ~/Library/Application Support/Marfa/profiles.toml on
    /// macOS, and $XDG_CONFIG_HOME/marfa/profiles.toml, else
    /// ~/.config/marfa/profiles.toml, elsewhere. Each profile is a section
    /// with a url line and, optionally, key_command: a program and its
    /// arguments, run without a shell, that prints the key. Without
    /// key_command, the key is the credential the keychain keeps for that
    /// server.
    ///
    /// The server and key come from the first of these that is given:
    /// --profile, which refuses --url and --key beside it and reads none of
    /// MARFA_API_URL, MARFA_API_KEY and MARFA_PROFILE; --url or --key, as
    /// below, without MARFA_PROFILE; MARFA_PROFILE, which refuses
    /// MARFA_API_URL and MARFA_API_KEY beside it; MARFA_API_URL and
    /// MARFA_API_KEY, then the keychain. A profile's key is sent only to its
    /// server, and no other key is.
    #[arg(
        long,
        global = true,
        value_name = "NAME",
        conflicts_with_all = ["url", "key"],
        help_heading = "Server"
    )]
    profile: Option<String>,

    /// The server's base URL. Falls back to MARFA_API_URL, then to the
    /// server a kept credential made current. MARFA_PROFILE is not read
    /// beside it. A command that sends a key
    /// from --key or MARFA_API_KEY needs the URL named, and so does any
    /// command with the keychain off.
    #[arg(long, global = true, value_name = "URL", help_heading = "Server")]
    url: Option<String>,

    /// A key or a token for that server. Prefer MARFA_API_KEY or the
    /// keychain: a command line is readable by other users of the machine and
    /// stays in shell history. Falls back to MARFA_API_KEY, then to the
    /// keychain: the file MARFA_KEYCHAIN names, where it names one, unless
    /// the keychain is off. MARFA_PROFILE is not read beside it.
    #[arg(long, global = true, value_name = "KEY", help_heading = "Server")]
    key: Option<String>,

    /// Treat the keychain as absent: read nothing from it and write nothing
    /// to it, so the server and the key must come from --url, --key,
    /// MARFA_API_URL or MARFA_API_KEY, or a profile with a key_command. A
    /// command that needs to keep something refuses. MARFA_NO_KEYCHAIN=1
    /// does the same.
    #[arg(long, global = true, help_heading = "Server")]
    no_keychain: bool,

    /// Send a credential over plain http to a host that is not this machine
    /// without the warning, for a network that is private. MARFA_ALLOW_HTTP=1
    /// does the same.
    #[arg(long, global = true, help_heading = "Server")]
    allow_http: bool,

    /// Use private local process authority through this Unix socket, without a keychain.
    /// Item properties, edges, tags, search, counts, events and exports still need a key.
    /// `items summaries`, `items trash`, the `blobs` commands and bulk-action job status and
    /// cancel do not.
    #[arg(long, global = true, value_name = "PATH", conflicts_with_all = ["url", "key", "profile"], help_heading = "Server")]
    socket: Option<std::path::PathBuf>,

    /// Print the answer as JSON. A refusal is the last line of stderr, one
    /// JSON object, after any plain lines such as a warning or the write line.
    #[arg(long, global = true, help_heading = "Output")]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// What the instance says about itself, and item counts where the credential reaches them.
    Status,
    /// Instance-wide counters and process uptime. Needs `instance.read`.
    Metrics,
    /// Which server, instance and credential a bare command would use.
    Whoami,
    /// Sign in to a server as an app: a code the owner approves in the browser.
    Login(login::LoginArgs),
    /// Sign out of a server: the token is revoked and forgotten.
    Logout,
    /// Claim a new instance, obtain a setup code, or open a browser handoff.
    Setup {
        #[command(subcommand)]
        command: owner::SetupCommand,
    },
    /// The owner: the one account behind the sign-in surface.
    Owner {
        #[command(subcommand)]
        command: owner::OwnerCommand,
    },
    /// The owner's name and picture, changed with a key or app's profile write permission.
    Profile {
        #[command(subcommand)]
        command: profile::ProfileCommand,
    },
    /// List, narrow or disconnect approved apps.
    Apps {
        #[command(subcommand)]
        command: apps::AppsCommand,
    },
    /// Sign-ins: every browser, app and key that can reach the server. A key
    /// or an app's token is refused; use --socket.
    #[command(name = "sign-ins")]
    SignIns {
        #[command(subcommand)]
        command: sign_ins::SignInsCommand,
    },
    /// Items: create, read, change, tag, link, attach, and the bulk operations.
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
    ///
    /// An archive is kept even when it lacks blobs it names: a blob no store
    /// could read whole, or a file's blob the key may not read, such as one
    /// only an earlier version names. A key holding `blobs.manage` reads every
    /// blob. The manifest lists the blobs it lacks under `missing_blobs`, and
    /// the command then exits 1 with `blobs_missing`, naming up to ten of them.
    ///
    /// With `--output`, such an archive is not written to the path. It is
    /// kept beside it as `<PATH>.incomplete`, which replaces only an earlier
    /// file of that name, and the file at the path stays as it was, so a
    /// script that reads the path never gets an archive that lacks files. The
    /// message names both paths. When that name cannot be taken, the archive
    /// stays in a hidden partial file beside the path, and the message names
    /// it. Without `--output`, the archive goes to standard output.
    Export(export::ExportArgs),
    /// Restore an archive with direct owner or local authority.
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
    ///
    /// When the archive lacks blobs it names and this instance does not hold
    /// them either, the answer lists them in `blobs_missing`, and the command
    /// prints it and exits 1 with `blobs_missing`. Upload their bytes again
    /// with `blobs upload` to restore them.
    Restore(restore::RestoreArgs),
    /// Outbound subscriptions that send events out. Every command needs `webhooks.manage`.
    Webhooks {
        #[command(subcommand)]
        command: webhooks::WebhooksCommand,
    },
    /// The audit log: every write, with the acting sign-in. Needs `audit.read`.
    Audit(audit::AuditArgs),
    /// The event stream, one frame per line. It ends with an error and a
    /// non-zero exit when the stream closes on `cursor_ahead`,
    /// `catchup_too_old` or `stream_incomplete`.
    Events(events::EventsArgs),
    /// Current concerns and unavailable checks. Requires the owner or --socket.
    Attention,
    /// The housekeeping jobs the server runs on itself. Explicit management permission required.
    Housekeeping {
        #[command(subcommand)]
        command: housekeeping::HousekeepingCommand,
    },
    /// Processes that write on a key's behalf: registered, heard from, and
    /// reporting their runs. A key registers itself; `connectors.manage` sees
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
    /// A server on this machine, in Docker: install it, upgrade it, see how
    /// it is and take it down.
    Server {
        #[command(subcommand)]
        command: server::ServerCommand,
    },
}

fn main() -> ExitCode {
    let (cli, command) = match parse() {
        Ok(parsed) => parsed,
        Err(error) => match usage(&error, std::env::args_os()) {
            Some(refusal) => return refused(&refusal, true),
            None => error.exit(),
        },
    };
    let json = cli.json;
    style::set_json(json);
    let telemetry = telemetry::start(&command, json);
    // A panic is what error tracking is for. It is reported, the trace is
    // ended, and the panic then goes on unwinding, so that the message on
    // standard error and the exit status are what they are without telemetry.
    let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        telemetry.within(|| run(cli))
    })) {
        Ok(result) => result,
        Err(panic) => {
            telemetry.panicked();
            std::panic::resume_unwind(panic)
        }
    };
    let status = match &result {
        Ok(exit) => interrupt::status(*exit as u8),
        Err(CliError::ClosedOutput) => 0,
        Err(error) => {
            print_refusal(error, json);
            error.exit() as u8
        }
    };
    telemetry.finish(
        status,
        result
            .as_ref()
            .err()
            .filter(|error| !matches!(error, CliError::ClosedOutput)),
    );
    ExitCode::from(status)
}

/// What `Cli::try_parse` does, and the command's names as well, which are the
/// only part of a command line that is safe to report: the subcommands the
/// parser matched, never an argument or a value.
/// Whether `--json` is among the arguments, read from the raw line: a refused
/// command line has no parsed flags.
fn json_in(args: impl IntoIterator<Item = std::ffi::OsString>) -> bool {
    args.into_iter()
        .skip(1)
        .take_while(|arg| arg != "--")
        .any(|arg| arg == "--json")
}

fn parse() -> Result<(Cli, String), clap::Error> {
    let mut command = Cli::command();
    // clap draws help and usage errors in color on a terminal and reads
    // `NO_COLOR` itself; `--json` it does not know, and on some systems it
    // draws for `TERM=dumb`.
    if json_in(std::env::args_os()) || std::env::var("TERM").is_ok_and(|term| term == "dumb") {
        command = command.color(clap::ColorChoice::Never);
    }
    let mut matches = command.try_get_matches_from_mut(std::env::args_os())?;
    let path = command_path(&matches);
    let cli =
        Cli::from_arg_matches_mut(&mut matches).map_err(|error| error.format(&mut command))?;
    Ok((cli, path))
}

fn command_path(matches: &ArgMatches) -> String {
    let mut path = String::from("marfa");
    let mut at = matches;
    while let Some((name, within)) = at.subcommand() {
        path.push(' ');
        path.push_str(name);
        at = within;
    }
    path
}

fn refused(error: &CliError, json: bool) -> ExitCode {
    print_refusal(error, json);
    ExitCode::from(error.exit() as u8)
}

fn print_refusal(error: &CliError, json: bool) {
    if json {
        eprintln!("{}", error.envelope());
    } else {
        eprintln!("{} {error}", style::bad(style::Stream::Err, "marfa:"));
    }
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
    if !json_in(args) {
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

/// What `--socket` refuses before anything is sent: commands that have no
/// use for it, including folder commands that resolve their own server.
/// Folder inventory is the one folder command that uses the private socket.
fn socket_refusal(command: &Command) -> Option<CliError> {
    if matches!(
        command,
        Command::Folders {
            command: folders::FoldersCommand::Inventory { .. }
        }
    ) {
        return None;
    }
    if matches!(
        command,
        Command::Login(_)
            | Command::Logout
            | Command::Device(_)
            | Command::Folders { .. }
            | Command::Docs(_)
            | Command::Server { .. }
            | Command::Types {
                command: types::TypesCommand::Scaffold(_)
            }
    ) {
        return Some(CliError::Usage(
            "this command does not support --socket".into(),
        ));
    }
    None
}

/// The commands that sign in, sign out, keep or forget a credential in the
/// keychain, which a profile whose key comes from a key command never reads.
fn keychain_profile_refusal(command: &Command, named: &Named) -> Result<(), CliError> {
    let what = match command {
        Command::Login(args) if !args.print_token => "login",
        Command::Logout => "logout",
        Command::Keys {
            command: keys::KeysCommand::Keep,
        } => "keys keep",
        Command::Keys {
            command: keys::KeysCommand::Forget,
        } => "keys forget",
        _ => return Ok(()),
    };
    match named.chosen_profile()? {
        Some(profile) if profile.has_key_command() => Err(CliError::Usage(format!(
            "the profile {} takes its key from its key_command, not the keychain, so `{what}` has nothing to do for it; remove key_command from the profile to use the keychain",
            profile.name
        ))),
        _ => Ok(()),
    }
}

fn run(cli: Cli) -> Result<Exit, CliError> {
    #[cfg(debug_assertions)]
    if let Ok(message) = std::env::var("MARFA_TEST_PANIC") {
        panic!("{message}");
    }
    if cli.allow_http || cleartext::allowed_by_environment() {
        cleartext::allow();
    }
    if cli.no_keychain || credentials::off_by_environment() {
        credentials::turn_off();
    }
    marfa_core::http::on_write(writing::announce);
    let out = Printer { json: cli.json };
    if cli.socket.is_some()
        && ["MARFA_API_URL", "MARFA_API_KEY", profiles::ENVIRONMENT]
            .iter()
            .any(|name| std::env::var(name).is_ok_and(|value| !value.is_empty()))
    {
        return Err(CliError::Usage(
            "--socket cannot be combined with MARFA_API_URL, MARFA_API_KEY or MARFA_PROFILE; unset them first"
                .into(),
        ));
    }
    if cli.socket.is_some()
        && let Some(refusal) = socket_refusal(&cli.command)
    {
        return Err(refusal);
    }
    if cli.socket.is_none()
        && matches!(
            &cli.command,
            Command::Owner {
                command: owner::OwnerCommand::Recover(_)
                    | owner::OwnerCommand::Passkeys { .. }
                    | owner::OwnerCommand::Update(_)
            } | Command::Setup {
                command: owner::SetupCommand::Status
                    | owner::SetupCommand::Code
                    | owner::SetupCommand::Open { .. }
            }
        )
    {
        return Err(CliError::Usage(
            "this operation requires --socket PATH".into(),
        ));
    }
    if matches!(
        cli.command,
        Command::Types {
            command: types::TypesCommand::Scaffold(_)
        }
    ) && (cli.url.is_some() || cli.key.is_some() || cli.profile.is_some())
    {
        return Err(CliError::Usage(
            "types scaffold contacts no server and takes none of --url, --key and --profile".into(),
        ));
    }
    if matches!(cli.command, Command::Server { .. })
        && (cli.url.is_some() || cli.key.is_some() || cli.profile.is_some())
    {
        return Err(CliError::Usage(
            "server commands run Docker on this machine and take none of --url, --key and --profile"
                .into(),
        ));
    }
    let profile = match cli.profile {
        Some(name) => Some(profiles::Chosen::new(name, profiles::ChosenBy::Flag)),
        None if cli.url.is_none() && cli.key.is_none() && cli.socket.is_none() => {
            profiles::Chosen::from_environment()
        }
        None => None,
    };
    let named = Named {
        url: cli.url,
        key: cli.key,
        profile,
    };
    keychain_profile_refusal(&cli.command, &named)?;
    if matches!(
        cli.command,
        Command::Keys {
            command: keys::KeysCommand::Keep | keys::KeysCommand::Forget
        }
    ) {
        // Before a server is asked for, so a keychain that is off is the
        // first thing said.
        credentials::refuse_if_off()?;
        if cli.socket.is_some() {
            return Err(CliError::Usage(
                "keychain commands cannot use --socket".into(),
            ));
        }
    }
    // Lazy: login, logout, device, folders, operations, docs and types scaffold must run
    // without a resolved credential.
    let remote = || match &cli.socket {
        Some(path) => Remote::local(path),
        None => Remote::resolve(&named),
    };
    match cli.command {
        Command::Operations => operations::run(&out),
        Command::Docs(args) => docs::run(args, &named, &out),
        Command::Server { command } => server::run(command, &out),
        Command::Login(args) => login::run(args, &named, &out),
        Command::Logout => logout::run(&named, &out),
        Command::Owner { command } => owner::run(command, &remote()?, &out),
        Command::Profile { command } => profile::run(command, &remote()?, &out),
        Command::Apps { command } => apps::run(command, &remote()?, &out),
        Command::SignIns { command } => sign_ins::run(command, &remote()?, &out),
        Command::Setup { command } => {
            let setup_remote = match &cli.socket {
                Some(path) => Remote::local(path)?,
                None => Remote::public_at(&Remote::url_named(&named)?)?,
            };
            owner::setup(command, &setup_remote, &out)
        }
        Command::Device(args) => return device::run(args, &named, cli.json),
        Command::Folders { command } => {
            return folders::run(command, &named, cli.socket.as_deref(), cli.json);
        }
        Command::Status => status::run(&remote()?, &out),
        Command::Metrics => metrics::run(&remote()?, &out),
        Command::Whoami => whoami::run(&remote()?, &out),
        Command::Items { command } => items::run(command, &remote()?, &out),
        Command::Edges { command } => edges::run(command, &remote()?, &out),
        Command::EdgeTypes { command } => edge_types::run(command, &remote()?, &out),
        Command::Types { command } => types::run(command, remote, &out),
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
        Command::Attention => {
            out.value(&remote()?.json(&crate::remote::request::Request::get(&["attention"]))?)
        }
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
    fn socket_authority_cannot_be_combined_with_network_credentials() {
        for flags in [["--url", "https://example.com"], ["--key", "secret"]] {
            assert!(
                Cli::try_parse_from([
                    "marfa",
                    "--socket",
                    "/private/control.sock",
                    flags[0],
                    flags[1],
                    "owner",
                    "show"
                ])
                .is_err()
            );
        }
        assert!(
            Cli::try_parse_from([
                "marfa",
                "--socket",
                "/private/control.sock",
                "owner",
                "recover",
                "--password",
                "secret"
            ])
            .is_err()
        );
        assert!(Cli::try_parse_from(["marfa", "keys", "bootstrap"]).is_err());
        assert!(Cli::try_parse_from(["marfa", "keys", "create", "--operator"]).is_err());
    }

    #[test]
    fn socket_authority_is_refused_for_commands_it_has_no_use_for() {
        let command = |words: &[&str]| {
            let mut argv = vec!["marfa", "--socket", "/marfa-test-missing/control.sock"];
            argv.extend_from_slice(words);
            Cli::try_parse_from(argv).unwrap().command
        };
        for words in [
            &["login"][..],
            &["logout"],
            &["device", "status"],
            &["folders", "list"],
            &["folders", "health", "folder-id"],
            &["folders", "create", "--title", "Test"],
            &["docs", "topics"],
            &["types", "scaffold", "user.recipe"],
        ] {
            assert!(
                matches!(socket_refusal(&command(words)), Some(CliError::Usage(ref message)) if message == "this command does not support --socket"),
                "{words:?}"
            );
        }
        // Witness: commands that need a key, or are streamed, are sent.
        for words in [
            &["export"][..],
            &["events"],
            &["items", "list"],
            &["connectors", "deliveries", "body", "id", "delivery"],
            &["blobs", "download", "sha256:abc"],
            &["connectors", "list"],
            &["folders", "inventory"],
        ] {
            assert!(socket_refusal(&command(words)).is_none(), "{words:?}");
        }
    }

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

//! `marfa server`: a Marfa server on this machine, run natively or in Docker.
//!
//! The install is a folder holding `.env` (name, release, port, runtime, how the
//! server is reached) and `marfa.env` (the server's secrets and proxy trust).

mod account;
pub(crate) mod address;
mod backups;
mod docker;
mod envfile;
mod files;
mod install;
mod launchd;
mod lifecycle;
mod logs;
mod names;
mod native;
mod prompt;
mod run;
mod service;
mod systemd;
mod tailscale;

use std::path::PathBuf;
use std::time::Duration;

use clap::{Args, Subcommand, ValueEnum};

use crate::error::CliError;
use crate::output::Printer;
use crate::style::{self, Stream};
use envfile::EnvFile;
use service::Manager;

const DEFAULT_PORT: u16 = 8600;
const IMAGE: &str = "ghcr.io/withmarfa/marfa-server";
const CLOUDFLARE_HEADER: &str = "CF-Connecting-IP";
const ROOT_DIR: &str = "/var/lib/marfa-server";
const AGENT_HINT: &str =
    "To give an AI agent access to this server, run `marfa docs build/ai-agents`.";
const OPTIONS_HINT: &str = "Options, all optional: --dir <folder> to install somewhere else, --port <port> for the port on this machine, --name <name> to run more than one, --docker to run the server in Docker, --external-settings when a secrets manager writes marfa.env. `marfa server install --help` lists them all.";

#[derive(Debug, Subcommand)]
pub enum ServerCommand {
    /// Set up a server on this machine and print the link that claims it.
    ///
    /// The server runs as a service of this machine, without Docker: a
    /// launchd agent on a Mac, and a systemd service on Linux (in your own
    /// account, or as the `marfa` account when root runs this). Use
    /// `--docker` to run the release's image in Docker instead.
    ///
    /// It writes two settings files into `--dir`, makes the server's two
    /// secrets once and keeps them in `marfa.env`, which only you can read,
    /// starts the service, and prints the one-time setup link. It never prints
    /// a secret. Running it again changes only what is not already as asked,
    /// and never a secret or the runtime.
    ///
    /// It asks how the server is reached, because that decides which caller
    /// address the server believes and the address people sign in at. Every
    /// question has a flag, and `--yes` or a non-terminal answers none: the
    /// flag or the default is used.
    Install(InstallArgs),
    /// Move the server to the release now installed, and update its database.
    ///
    /// A native server runs the `marfa-server` installed beside this `marfa`,
    /// so install the release you want first (Homebrew, or the install
    /// script), then run this. A Docker install moves to the release you name
    /// with `--release`, or to this binary's own. A release whose database
    /// schema is newer copies the database beside it first, then updates it.
    /// It refuses an older release than the one installed, because an older
    /// release does not know what a newer one changed in the database.
    Upgrade(UpgradeArgs),
    /// Whether the server runs, its release and address, and whether it is claimed.
    ///
    /// It says what the server's `/health` answers: healthy, or degraded or down with the
    /// components at fault, such as a disk with too little room. It says "not answering" only
    /// when the server gave no answer. It also says when the server keeps no backups, and how
    /// to set one. When the server is not answering, it shows the end of its log.
    ///
    /// It exits 0 whenever it can say how the server is, a stopped, degraded or silent server
    /// included: `--json` has `running`, `answering`, `healthy`, `health` and `backups` for a script to
    /// read. It exits non-zero only when the command itself fails, such as for a folder with
    /// no install.
    Status(DirArgs),
    /// Start the server, if it is not running.
    ///
    /// On a Mac with a Docker install, this starts Docker's engine first if it
    /// is down: it is what the login agent runs.
    Start(StartArgs),
    /// Stop the server, keeping the service, its data and its settings.
    Stop(DirArgs),
    /// Stop the server and start it again, so that it reads `marfa.env`
    /// anew.
    ///
    /// It does what `stop` and then `start` do, and prints what each prints.
    /// It exits as `start` does, so a server that did not come back healthy
    /// is an error here too.
    Restart(StartArgs),
    /// Run the server in the foreground. This is what the service runs.
    ///
    /// It starts the `marfa-server` of the same release as this `marfa`, with
    /// the settings in `--dir` (the data below it, and the port from `.env`);
    /// without `--dir` it uses the settings in its own environment, as the
    /// container does. It passes a stop on to the server and ends with its
    /// status. On a Mac it keeps the server's output in
    /// `~/Library/Logs/Marfa`. A server that refuses its database is not
    /// started again: this command says so and waits until it is stopped.
    Run(RunArgs),
    /// Remove the service, keeping its data and settings.
    ///
    /// The data, the settings and the secrets stay, so `install` brings the
    /// same server back. `--delete-data` removes the data folder (or the
    /// Docker volume) and `marfa.env` too.
    Uninstall(UninstallArgs),
}

#[derive(Debug, Args)]
pub struct DirArgs {
    /// The folder the install lives in. The default is `marfa-server` in your
    /// home directory, and `/var/lib/marfa-server` for root on Linux.
    #[arg(long, value_name = "PATH")]
    dir: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct RunArgs {
    #[command(flatten)]
    dir: DirArgs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Access {
    Local,
    Tailscale,
    Cloudflare,
    Proxy,
}

impl Access {
    fn name(self) -> String {
        self.to_possible_value()
            .map(|value| value.get_name().to_string())
            .unwrap_or_default()
    }

    fn parse(name: &str) -> Option<Access> {
        Access::from_str(name, false).ok()
    }
}

/// Where the server runs, which an install keeps for as long as it exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Runtime {
    Native,
    Docker,
}

impl Runtime {
    fn name(self) -> &'static str {
        match self {
            Runtime::Native => "native",
            Runtime::Docker => "docker",
        }
    }

    fn parse(name: &str) -> Option<Runtime> {
        [Runtime::Native, Runtime::Docker]
            .into_iter()
            .find(|runtime| runtime.name() == name)
    }
}

#[derive(Debug, Args)]
pub struct InstallArgs {
    #[command(flatten)]
    dir: DirArgs,
    /// What this install is called: the service, the container and the data
    /// volume are named from it. The default is `marfa`.
    #[arg(long, value_name = "NAME")]
    name: Option<String>,
    /// Run the server in Docker, from the release's image, in place of as a
    /// service of this machine. Needs Docker with Compose. An install keeps
    /// its runtime: to change it, export the data and restore it into a new
    /// install.
    #[arg(long)]
    docker: bool,
    /// The release of the image to run, such as `0.0.22`, for `--docker`. The
    /// default is this binary's own version, and for a server already
    /// installed, the release it runs. A native server runs the release
    /// installed beside this `marfa`.
    #[arg(long, value_name = "VERSION")]
    release: Option<String>,
    /// How the server is reached. Asked when not given. `local`: only this
    /// machine, at `http://localhost`. `tailscale`: your tailnet, through
    /// Tailscale Serve, at this machine's `ts.net` name. `cloudflare`: a
    /// Cloudflare Tunnel on this machine, at your own address. `proxy`:
    /// another proxy on this machine, such as Caddy or nginx, at your own
    /// address.
    #[arg(long, value_enum)]
    access: Option<Access>,
    /// The address devices sign in at, such as `https://marfa.example.com`.
    /// Needed for `cloudflare` and `proxy`; `tailscale` reads it from
    /// Tailscale. The server holds it, and a link to set up the server is at
    /// it. A run that gives neither this nor a different `--access` leaves
    /// an address the server already holds, and says so; `--access local`
    /// clears it.
    #[arg(long, value_name = "URL")]
    address: Option<String>,
    /// The port on this machine's loopback address. The default is 8600, or
    /// the next free port.
    #[arg(long, value_name = "PORT")]
    port: Option<u16>,
    /// The port Tailscale serves on, for `--access tailscale`. The default is 443.
    #[arg(long, value_name = "PORT")]
    https_port: Option<u16>,
    /// The server's settings file, `marfa.env` in `--dir`, is written by
    /// something else, such as a secrets manager. This command then never
    /// makes or changes it: it checks that it holds the secrets and the proxy
    /// setting this install needs, and says what is missing. It reads a
    /// quoted value the way Docker Compose reads it.
    #[arg(long)]
    external_settings: bool,
    /// Start the server when you log in (on a Mac) or when the machine starts
    /// (on Linux). The default; a Docker install on Linux relies on Docker
    /// starting at boot.
    #[arg(long)]
    autostart: bool,
    /// Do not start the server at login or at boot. `marfa server start`
    /// starts it.
    #[arg(long, conflicts_with = "autostart")]
    no_autostart: bool,
    /// How long to wait for the server to answer, in seconds.
    #[arg(long, value_name = "SECONDS", default_value_t = 120)]
    wait: u64,
    /// Ask nothing: use the flags and the defaults.
    #[arg(long, short = 'y')]
    yes: bool,
}

#[derive(Debug, Args)]
pub struct UpgradeArgs {
    #[command(flatten)]
    dir: DirArgs,
    /// The release to move to, for a Docker install. The default is this
    /// binary's own version. A native server moves to the release installed.
    #[arg(long, value_name = "VERSION")]
    release: Option<String>,
    /// How long to wait for the server to answer, in seconds.
    #[arg(long, value_name = "SECONDS", default_value_t = 120)]
    wait: u64,
}

#[derive(Debug, Args)]
pub struct StartArgs {
    #[command(flatten)]
    dir: DirArgs,
    /// How long to wait for Docker's engine and then the server, in seconds.
    #[arg(long, value_name = "SECONDS", default_value_t = 120)]
    wait: u64,
}

#[derive(Debug, Args)]
pub struct UninstallArgs {
    #[command(flatten)]
    dir: DirArgs,
    /// Also delete the data and the settings. This cannot be undone.
    #[arg(long)]
    delete_data: bool,
    /// Do not ask before `--delete-data`.
    #[arg(long, short = 'y')]
    yes: bool,
}

pub fn run(command: ServerCommand, out: &Printer) -> Result<(), CliError> {
    match command {
        ServerCommand::Install(args) => install::install(args, out),
        ServerCommand::Upgrade(args) => lifecycle::upgrade(args, out),
        ServerCommand::Start(args) => lifecycle::start(args, out),
        ServerCommand::Stop(args) => lifecycle::stop(args, out),
        ServerCommand::Restart(args) => lifecycle::restart(args, out),
        ServerCommand::Status(args) => lifecycle::status(args, out),
        ServerCommand::Uninstall(args) => lifecycle::uninstall(args, out),
        ServerCommand::Run(args) => run::run(&args.dir),
    }
}

// ---- the install on disk ------------------------------------------------

/// What `.env` says about an install.
#[derive(Debug, Clone, PartialEq, Eq)]
struct State {
    name: String,
    release: String,
    port: u16,
    access: Access,
    https_port: Option<u16>,
    runtime: Runtime,
    /// What keeps a native server running.
    manager: Option<Manager>,
    /// The sign-in address this install set on the server, for an install
    /// that is not `local`.
    address: Option<String>,
    /// `marfa.env` is written by something else.
    external: bool,
    /// The server starts at login or at boot.
    autostart: bool,
}

struct Folder {
    dir: PathBuf,
}

/// How this machine reaches a server's private local command.
pub enum PrivateCommand {
    /// A native install: its socket is a path on this machine.
    Socket(PathBuf),
    /// A Docker install: its socket is inside the container.
    Container(String),
}

impl PrivateCommand {
    fn of(state: &State, folder: &Folder) -> Option<Self> {
        match state.runtime {
            Runtime::Native => {
                let socket = native::Layout::new(&folder.dir).socket();
                socket.exists().then_some(Self::Socket(socket))
            }
            Runtime::Docker => Some(Self::Container(state.name.clone())),
        }
    }

    /// The words that put `command` through the private local command, with
    /// no call to Docker: the install record says which container it is.
    pub fn run_text(&self, command: &str) -> String {
        match self {
            Self::Socket(socket) => format!(
                "`marfa --socket {} {command}`",
                crate::hint::shell_word(&socket.display().to_string())
            ),
            Self::Container(name) => format!(
                "`{command}` with the `marfa` command inside the Docker container `{name}`, putting `--socket {CONTAINER_SOCKET}` before it"
            ),
        }
    }

    /// The `marfa --socket` prefix, which a container has none of.
    pub fn prefix(&self) -> Option<String> {
        match self {
            Self::Socket(socket) => Some(format!(
                "marfa --socket {}",
                crate::hint::shell_word(&socket.display().to_string())
            )),
            Self::Container(_) => None,
        }
    }

    pub fn container_words(&self) -> Option<String> {
        match self {
            Self::Socket(_) => None,
            Self::Container(name) => Some(format!(
                "the server runs in the Docker container `{name}`: run this command with the `marfa` command inside it, putting `--socket {CONTAINER_SOCKET}` before it, and a file the command reads must be inside the container too"
            )),
        }
    }
}

/// The socket inside a Docker install's container.
const CONTAINER_SOCKET: &str = "/data/control/marfa.sock";

/// The private local command of the server at `origin`, if this machine's install is that server.
pub fn private_command_for(origin: &str) -> Option<PrivateCommand> {
    let asked = url::Url::parse(origin).ok()?;
    let folder = Folder::new(&DirArgs { dir: None }).ok()?;
    let (state, _) = folder.state().ok()??;
    let on_this_port = marfa_telemetry::host::is_loopback(&asked)
        && asked.port_or_known_default() == Some(state.port);
    let at_its_address = state
        .address
        .as_deref()
        .and_then(|address| url::Url::parse(address).ok())
        .is_some_and(|address| address.origin() == asked.origin());
    if !on_this_port && !at_its_address {
        return None;
    }
    PrivateCommand::of(&state, &folder)
}

/// The path with the part that exists made real, so that a link in it is
/// followed: the server's socket is refused beyond a link.
fn resolved(path: PathBuf) -> PathBuf {
    let mut rest = Vec::new();
    let mut current = path.as_path();
    loop {
        if let Ok(real) = std::fs::canonicalize(current) {
            return rest.iter().rev().fold(real, |path, part| path.join(part));
        }
        match (current.parent(), current.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                current = parent;
            }
            _ => return path,
        }
    }
}

impl Folder {
    fn new(args: &DirArgs) -> Result<Self, CliError> {
        let dir = match &args.dir {
            Some(dir) => dir.clone(),
            None if cfg!(target_os = "linux") && account::is_root() => PathBuf::from(ROOT_DIR),
            None => std::env::var_os("HOME")
                .filter(|home| !home.is_empty())
                .map(|home| PathBuf::from(home).join("marfa-server"))
                .ok_or_else(|| CliError::Usage("HOME is not set: pass --dir".into()))?,
        };
        // Compose reads the project directory from inside it, so a relative
        // path would mean another folder there.
        Ok(Self {
            dir: resolved(std::path::absolute(dir)?),
        })
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// A settings file of the folder, read without following a link.
    fn read(&self, name: &str) -> Result<Option<EnvFile>, CliError> {
        Ok(self.read_text(name)?.map(|text| EnvFile::parse(&text)))
    }

    fn read_text(&self, name: &str) -> Result<Option<String>, CliError> {
        match files::read_regular(&self.path(name)) {
            Err(CliError::Io(error)) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                Err(CliError::Usage(format!(
                    "this account cannot read {}: an install made by root belongs to root and the {} account, so run the command with sudo",
                    self.path(name).display(),
                    account::NAME
                )))
            }
            read => read,
        }
    }

    /// What a native server started now reads, as `MARFA_APPLIED` keeps it.
    fn applied(&self, port: u16, release: &str) -> Result<String, CliError> {
        let settings = self.read_text(files::SETTINGS)?.unwrap_or_default();
        Ok(native::applied(&self.dir, port, release, &settings))
    }

    /// Keeps what the server now running was started with, once a start or
    /// restart is confirmed. Written to `.env` as it stands on disk.
    fn keep_applied(
        &self,
        dotenv: &mut EnvFile,
        applied: &str,
        kept: files::Perms,
    ) -> Result<(), CliError> {
        dotenv.set("MARFA_APPLIED", applied)?;
        files::write_if_changed(&self.path(files::DOTENV), &dotenv.render(), kept)?;
        Ok(())
    }

    /// Forgets what the server was started with before a restart that may
    /// not be confirmed, so that the next install restarts it again.
    fn forget_applied(&self, dotenv: &mut EnvFile, kept: files::Perms) -> Result<(), CliError> {
        dotenv.remove("MARFA_APPLIED");
        files::write_if_changed(&self.path(files::DOTENV), &dotenv.render(), kept)?;
        Ok(())
    }

    /// The install in this folder, or `None` for a folder with none.
    fn state(&self) -> Result<Option<(State, EnvFile)>, CliError> {
        let Some(dotenv) = self.read(files::DOTENV)? else {
            // A settings file alone is a restored or a managed one, which an
            // install adopts. A Compose file alone is someone else's.
            if self.path(files::COMPOSE).exists() {
                return Err(CliError::Usage(format!(
                    "{} holds a Compose file this command did not write: choose another --dir",
                    self.dir.display()
                )));
            }
            return Ok(None);
        };
        let field = |name: &str| {
            dotenv.get(name).ok_or_else(|| {
                CliError::Usage(format!(
                    "{} has no {name}: it was not written by `marfa server install`",
                    self.path(files::DOTENV).display()
                ))
            })
        };
        let port = field("MARFA_PORT")?
            .parse()
            .map_err(|_| CliError::Usage("MARFA_PORT in .env is not a port".into()))?;
        let access_name = field("MARFA_ACCESS")?;
        let access = Access::parse(&access_name)
            .ok_or_else(|| CliError::Usage(format!("MARFA_ACCESS in .env is {access_name}")))?;
        let runtime_name = field("MARFA_RUNTIME")?;
        let runtime = Runtime::parse(&runtime_name)
            .ok_or_else(|| CliError::Usage(format!("MARFA_RUNTIME in .env is {runtime_name}")))?;
        let manager =
            match runtime {
                Runtime::Docker => None,
                Runtime::Native => {
                    let name = field("MARFA_SERVICE")?;
                    Some(Manager::parse(&name).ok_or_else(|| {
                        CliError::Usage(format!("MARFA_SERVICE in .env is {name}"))
                    })?)
                }
            };
        let https_port = dotenv
            .get("MARFA_HTTPS_PORT")
            .map(|value| {
                value
                    .parse()
                    .map_err(|_| CliError::Usage("MARFA_HTTPS_PORT in .env is not a port".into()))
            })
            .transpose()?;
        let state = State {
            name: field("MARFA_NAME")?,
            release: field("MARFA_RELEASE")?,
            port,
            access,
            https_port,
            runtime,
            manager,
            address: dotenv.get("MARFA_ADDRESS"),
            external: dotenv.get("MARFA_SETTINGS").as_deref() == Some("external"),
            autostart: dotenv.get("MARFA_AUTOSTART").as_deref() == Some("on"),
        };
        Ok(Some((state, dotenv)))
    }

    fn require_state(&self) -> Result<(State, EnvFile), CliError> {
        self.state()?.ok_or_else(|| {
            CliError::Usage(format!(
                "no install in {}: `marfa server install` makes one",
                self.dir.display()
            ))
        })
    }
}

// ---- pure decisions -----------------------------------------------------

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn parse_release(release: &str) -> Option<(u64, u64, u64)> {
    let mut parts = release.split('.');
    let mut next = || {
        let part = parts.next()?;
        (!part.is_empty()
            && part.chars().all(|c| c.is_ascii_digit())
            && (part == "0" || !part.starts_with('0')))
        .then(|| part.parse().ok())
        .flatten()
    };
    let version = (next()?, next()?, next()?);
    parts.next().is_none().then_some(version)
}

/// A newer release may have updated the database in a way an older one does
/// not know, so the server never goes back to an older one.
fn refuse_older(installed: &str, target: &str) -> Result<(), CliError> {
    if parse_release(target) < parse_release(installed) {
        return Err(CliError::Usage(format!(
            "{installed} is installed and {target} is older. A newer release may have updated the database in a way an older one does not know, so the server will not go back: start the older release on the copy of the database the upgrade took, or on a backup. Delete `marfa.db-wal` and `marfa.db-shm` before you put it in place, because SQLite applies a log it finds beside the database (https://docs.marfa.so/run/upgrade)"
        )));
    }
    Ok(())
}

fn own_release() -> Option<String> {
    let own = env!("CARGO_PKG_VERSION");
    // A build that is not a release is stamped 0.0.0, which names no image.
    (own != "0.0.0").then(|| own.to_string())
}

fn checked_release(release: &str) -> Result<String, CliError> {
    parse_release(release).map(|_| release.to_string()).ok_or_else(|| {
        CliError::Usage(format!(
            "{release} is not a release: use three numbers, such as 0.0.22. `latest` is refused so a restart never changes the build"
        ))
    })
}

/// Devices sign in over https only, so an `http` address, which the server takes for its own machine, is refused.
fn public_address(raw: &str) -> Result<String, CliError> {
    if url::Url::parse(raw).is_ok_and(|url| url.scheme() != "https") {
        return Err(CliError::Usage(format!(
            "{raw} is not an address the server can use: devices sign in only over https"
        )));
    }
    address::normalise(raw)
}

fn proxy_trust(
    runtime: Runtime,
    access: Access,
    subnet: &str,
) -> (Option<String>, Option<&'static str>) {
    let ranges = || match runtime {
        Runtime::Native => native::LOOPBACK_PROXIES.to_string(),
        Runtime::Docker => subnet.to_string(),
    };
    match access {
        Access::Local => (None, None),
        Access::Tailscale | Access::Proxy => (Some(ranges()), None),
        Access::Cloudflare => (Some(ranges()), Some(CLOUDFLARE_HEADER)),
    }
}

/// Whether `network`, as `a.b.c.d/n`, lies inside `range`.
fn cidr_contains(range: &str, network: &str) -> bool {
    fn parse(cidr: &str) -> Option<(u32, u32)> {
        let (address, bits) = cidr.trim().split_once('/')?;
        let address: std::net::Ipv4Addr = address.parse().ok()?;
        let bits: u32 = bits.parse().ok().filter(|bits| *bits <= 32)?;
        Some((u32::from(address), bits))
    }
    let (Some((range_address, range_bits)), Some((network_address, network_bits))) =
        (parse(range), parse(network))
    else {
        return false;
    };
    let mask = if range_bits == 0 {
        0
    } else {
        u32::MAX << (32 - range_bits)
    };
    range_bits <= network_bits && (range_address & mask) == (network_address & mask)
}

/// Names settings, never their values, which can be secrets.
fn external_problems(settings: &EnvFile, access: Access, network: &str, of: &str) -> Vec<String> {
    let mut problems = Vec::new();
    for secret in names::SECRETS {
        if settings.get(secret).is_none_or(|value| value.is_empty()) {
            problems.push(format!("{secret} is not set"));
        }
    }
    let header = settings.get(names::PROXY_HEADER).filter(|v| !v.is_empty());
    let cidrs = settings.get(names::PROXY_CIDRS).filter(|v| !v.is_empty());
    let covered =
        cidrs.is_some_and(|cidrs| cidrs.split(',').any(|range| cidr_contains(range, network)));
    match access {
        Access::Local => return problems,
        Access::Cloudflare => {
            if !header.is_some_and(|header| header.eq_ignore_ascii_case(CLOUDFLARE_HEADER)) {
                problems.push(format!(
                    "{} must be {CLOUDFLARE_HEADER} for a Cloudflare Tunnel, or every caller shares one address and ten wrong passwords lock the owner out",
                    names::PROXY_HEADER
                ));
            }
        }
        Access::Tailscale | Access::Proxy => {
            if header.is_some() {
                problems.push(format!("{} is set, so the server reads the caller's address from it and not from the X-Forwarded-For this way of reaching the server sends", names::PROXY_HEADER));
            }
        }
    }
    if !covered {
        problems.push(format!(
            "{} must include {network}, {of}, or every caller shares one address and ten wrong passwords lock the owner out",
            names::PROXY_CIDRS
        ));
    }
    problems
}

/// macOS lets a loopback bind succeed beside a listener on every address, which would fail to publish.
fn port_is_free(port: u16) -> std::io::Result<()> {
    std::net::TcpListener::bind(("127.0.0.1", port))?;
    std::net::TcpListener::bind(("0.0.0.0", port))?;
    Ok(())
}

/// Where a tunnel or proxy on this machine reaches the server.
fn local_address(port: u16) -> String {
    format!("http://localhost:{port}")
}

fn free_port(from: u16) -> Option<u16> {
    (from..from.saturating_add(100)).find(|port| port_is_free(*port).is_ok())
}

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(3)))
        .http_status_as_error(false)
        .build()
        .into()
}

// ---- progress -----------------------------------------------------------

struct Steps {
    quiet: bool,
}

impl Steps {
    fn say(&self, text: &str) {
        if !self.quiet {
            eprintln!("{}", style::bold(Stream::Err, text));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_container_is_named_in_words_and_a_socket_is_a_prefix_to_repeat_a_command_after() {
        let container = PrivateCommand::Container("marfa-home".into());
        assert_eq!(container.prefix(), None);
        let words = container.container_words().unwrap();
        assert!(words.contains("`marfa-home`"), "{words}");
        assert!(
            words.contains("--socket /data/control/marfa.sock"),
            "{words}"
        );
        assert!(!words.contains("docker exec"), "{words}");
        let moved = container.run_text("config update");
        assert!(moved.contains("`config update`") && moved.contains("`marfa-home`"));

        let socket = PrivateCommand::Socket(PathBuf::from("/srv/it's/marfa.sock"));
        assert_eq!(
            socket.prefix().as_deref(),
            Some("marfa --socket '/srv/it'\\''s/marfa.sock'")
        );
        assert_eq!(socket.container_words(), None);
    }

    #[test]
    fn a_release_is_three_plain_numbers() {
        assert_eq!(parse_release("0.0.22"), Some((0, 0, 22)));
        assert_eq!(parse_release("1.10.3"), Some((1, 10, 3)));
        for bad in [
            "latest",
            "0.0",
            "0.0.22.1",
            "v0.0.22",
            "01.0.0",
            "0.0.x",
            "",
            "0.0.22-rc1",
        ] {
            assert_eq!(parse_release(bad), None, "{bad}");
        }
        assert!(parse_release("0.0.9") < parse_release("0.0.10"));
    }

    #[test]
    fn an_address_is_an_https_host_and_nothing_else() {
        assert_eq!(
            public_address("https://marfa.example.com/").unwrap(),
            "https://marfa.example.com"
        );
        assert_eq!(
            public_address("https://Marfa.Example.com:8443").unwrap(),
            "https://marfa.example.com:8443"
        );
        for bad in [
            "http://marfa.example.com",
            "marfa.example.com",
            "https://marfa.example.com/path",
            "https://marfa.example.com/?a=1",
            "https://user:pw@marfa.example.com",
            "https://marfa.example.com/#x",
        ] {
            assert!(public_address(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn each_way_of_reaching_the_server_trusts_what_it_should() {
        let subnet = "192.168.117.0/24";
        for runtime in [Runtime::Native, Runtime::Docker] {
            assert_eq!(proxy_trust(runtime, Access::Local, subnet), (None, None));
            let ranges = match runtime {
                Runtime::Native => "127.0.0.0/8,::1/128",
                Runtime::Docker => subnet,
            };
            assert_eq!(
                proxy_trust(runtime, Access::Cloudflare, subnet),
                (Some(ranges.into()), Some("CF-Connecting-IP"))
            );
        }
        for access in [Access::Tailscale, Access::Proxy] {
            assert_eq!(
                proxy_trust(Runtime::Docker, access, subnet),
                (Some(subnet.into()), None)
            );
            assert_eq!(
                proxy_trust(Runtime::Native, access, subnet),
                (Some("127.0.0.0/8,::1/128".into()), None)
            );
        }
    }

    #[test]
    fn a_native_proxy_range_covers_the_loopback_the_proxy_calls_from() {
        let mut settings = EnvFile::parse("");
        settings.set(names::KEY_SALT, "a").unwrap();
        settings.set(names::AUTH_SECRET, "b").unwrap();
        settings
            .set(names::PROXY_CIDRS, native::LOOPBACK_PROXIES)
            .unwrap();
        assert!(
            external_problems(
                &settings,
                Access::Proxy,
                native::LOOPBACK_NETWORK,
                "the loopback"
            )
            .is_empty()
        );
        settings.set(names::PROXY_CIDRS, "10.0.0.0/8").unwrap();
        assert_eq!(
            external_problems(
                &settings,
                Access::Proxy,
                native::LOOPBACK_NETWORK,
                "the loopback"
            )
            .len(),
            1
        );
    }

    #[test]
    fn a_cloudflare_tunnel_needs_the_header_and_the_range_it_connects_from() {
        let mut settings = EnvFile::parse("");
        settings.set(names::KEY_SALT, "a").unwrap();
        settings.set(names::AUTH_SECRET, "b").unwrap();
        settings
            .set(names::PROXY_HEADER, "CF-Connecting-IP")
            .unwrap();
        let problems = |settings: &EnvFile| {
            external_problems(
                settings,
                Access::Cloudflare,
                native::LOOPBACK_NETWORK,
                "the loopback",
            )
        };
        let alone = problems(&settings);
        assert_eq!(alone.len(), 1, "{alone:?}");
        assert!(alone[0].starts_with(names::PROXY_CIDRS), "{alone:?}");
        settings
            .set(names::PROXY_CIDRS, native::LOOPBACK_PROXIES)
            .unwrap();
        assert_eq!(problems(&settings), Vec::<String>::new());
    }

    #[test]
    fn a_range_covers_a_network_it_contains() {
        assert!(cidr_contains("172.30.0.0/16", "172.30.4.0/24"));
        assert!(cidr_contains("172.30.4.0/24", "172.30.4.0/24"));
        assert!(!cidr_contains("172.30.4.0/24", "172.30.0.0/16"));
        assert!(!cidr_contains("10.0.0.0/8", "172.30.4.0/24"));
        assert!(cidr_contains("0.0.0.0/0", "172.30.4.0/24"));
        assert!(!cidr_contains("garbage", "172.30.4.0/24"));
        assert!(!cidr_contains("172.30.0.0/33", "172.30.4.0/24"));
    }

    #[test]
    fn a_name_is_safe_for_docker() {
        for good in ["marfa", "marfa-2", "a_b", "9lives"] {
            assert!(valid_name(good), "{good}");
        }
        for bad in ["", "-x", "Marfa", "a b", "a/b", "a.b", &"x".repeat(41)] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn the_compose_file_names_only_what_the_env_files_hold() {
        for variable in ["MARFA_NAME", "MARFA_RELEASE", "MARFA_PORT"] {
            assert!(
                files::COMPOSE_FILE.contains(&format!("${{{variable}}}")),
                "{variable}"
            );
        }
        assert!(files::COMPOSE_FILE.contains("127.0.0.1:"));
        assert!(files::COMPOSE_FILE.contains("restart: unless-stopped"));
    }

    #[test]
    fn a_runtime_is_known_by_its_recorded_name() {
        for runtime in [Runtime::Native, Runtime::Docker] {
            assert_eq!(Runtime::parse(runtime.name()), Some(runtime));
        }
        assert_eq!(Runtime::parse("podman"), None);
    }
}

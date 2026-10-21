//! `marfa server`: a Marfa server on this machine, in Docker.
//!
//! The install is a folder holding a Compose file that is the same for every
//! install, `.env` for Compose (name, release, port, how the server is
//! reached) and `marfa.env` for the server (its secrets and address). Every
//! command works from those files, so running one again changes only what is
//! not already as asked, and the folder works with `docker compose` alone.

mod boot;
mod docker;
mod envfile;
mod files;
mod prompt;
mod tailscale;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use clap::{Args, Subcommand, ValueEnum};
use serde_json::json;

use crate::error::CliError;
use crate::output::Printer;
use docker::Docker;
use envfile::EnvFile;
use prompt::Prompter;

const DEFAULT_PORT: u16 = 8600;
const IMAGE: &str = "ghcr.io/withmarfa/marfa-server";
const CLOUDFLARE_HEADER: &str = "CF-Connecting-IP";

#[derive(Debug, Subcommand)]
pub enum ServerCommand {
    /// Set up a server on this machine and print the link that claims it.
    ///
    /// Needs Docker with Compose. It writes a Compose file and two settings
    /// files into `--dir`, makes the server's two secrets once and keeps them
    /// in `marfa.env`, which only you can read, starts the pinned release with
    /// a restart policy, and prints the one-time setup link. It never prints a
    /// secret. Running it again changes only what is not already as asked, and
    /// never a secret.
    ///
    /// It asks how the server is reached, because that decides which caller
    /// address the server believes. Every question has a flag, and `--yes` or
    /// a non-terminal answers none: the flag or the default is used.
    Install(InstallArgs),
    /// Move the server to a release, after printing what to read first.
    ///
    /// Stops at the release you name or at this binary's own. It refuses an
    /// older release than the one installed, because a newer release may have
    /// changed the database's shape.
    Upgrade(UpgradeArgs),
    /// Whether the server runs, its release and address, and whether it is claimed.
    Status(DirArgs),
    /// Bring the server up: start Docker's engine if it is down (on a Mac),
    /// then the container. What the login agent runs.
    Start(StartArgs),
    /// Stop the server and remove its container, keeping its data.
    ///
    /// The data volume, the settings and the secrets stay, so `install`
    /// brings the same server back. `--delete-data` removes the volume too.
    Uninstall(UninstallArgs),
}

#[derive(Debug, Args)]
pub struct DirArgs {
    /// The folder the install lives in. The default is `marfa-server` in your
    /// home directory.
    #[arg(long, value_name = "PATH")]
    dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Access {
    Local,
    Tailscale,
    Cloudflare,
    Proxy,
}

impl Access {
    fn name(self) -> &'static str {
        match self {
            Access::Local => "local",
            Access::Tailscale => "tailscale",
            Access::Cloudflare => "cloudflare",
            Access::Proxy => "proxy",
        }
    }

    fn parse(name: &str) -> Option<Access> {
        Access::value_variants()
            .iter()
            .copied()
            .find(|access| access.name() == name)
    }
}

#[derive(Debug, Args)]
pub struct InstallArgs {
    #[command(flatten)]
    dir: DirArgs,
    /// What this install is called: the container, the data volume and the
    /// Compose project are named from it. The default is `marfa`.
    #[arg(long, value_name = "NAME")]
    name: Option<String>,
    /// The release to run, such as `0.0.22`. The default is this binary's own
    /// version, and for a server already installed, the release it runs.
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
    /// The address devices use, such as `https://marfa.example.com`. Needed
    /// for `cloudflare` and `proxy`; `tailscale` reads it from Tailscale.
    #[arg(long, value_name = "URL")]
    address: Option<String>,
    /// The port on this machine's loopback address. The default is 8600, or
    /// the next free port.
    #[arg(long, value_name = "PORT")]
    port: Option<u16>,
    /// The port Tailscale serves on, for `--access tailscale`. The default is 443.
    #[arg(long, value_name = "PORT")]
    https_port: Option<u16>,
    /// Keep a copy of the data in an S3-compatible bucket: its name. Setting
    /// any `--s3-` option turns the copy on. The secret key is read from
    /// `S3_SECRET_ACCESS_KEY` or asked for, never taken as an option.
    #[arg(long, value_name = "BUCKET")]
    s3_bucket: Option<String>,
    /// The bucket's region.
    #[arg(long, value_name = "REGION")]
    s3_region: Option<String>,
    /// The bucket's address, for a store other than Amazon S3.
    #[arg(long, value_name = "URL")]
    s3_endpoint: Option<String>,
    /// The bucket's access key ID.
    #[arg(long, value_name = "ID")]
    s3_access_key_id: Option<String>,
    /// Where in the bucket this install keeps its copy. It must be this
    /// install's own. The default is the install's name.
    #[arg(long, value_name = "PREFIX")]
    s3_prefix: Option<String>,
    /// The server's settings file, `marfa.env` in `--dir`, is written by
    /// something else, such as a secrets manager. This command then never
    /// makes or changes it: it checks that it holds the secrets, the address
    /// and the proxy setting this install needs, and says what is missing.
    #[arg(long)]
    external_settings: bool,
    /// Start the server when you log in, even if Docker is not running yet:
    /// a launchd agent that runs `server start`. The default on a Mac.
    #[arg(long)]
    autostart: bool,
    /// Do not start the server at login.
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
    /// The release to move to. The default is this binary's own version.
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
    /// Also delete the data volume and the settings. This cannot be undone.
    #[arg(long)]
    delete_data: bool,
    /// Do not ask before `--delete-data`.
    #[arg(long, short = 'y')]
    yes: bool,
}

pub fn run(command: ServerCommand, out: &Printer) -> Result<(), CliError> {
    match command {
        ServerCommand::Install(args) => install(args, out),
        ServerCommand::Upgrade(args) => upgrade(args, out),
        ServerCommand::Start(args) => start_server(args, out),
        ServerCommand::Status(args) => status(args, out),
        ServerCommand::Uninstall(args) => uninstall(args, out),
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
    /// `marfa.env` is written by something else.
    external: bool,
    /// A login agent starts the server.
    autostart: bool,
}

struct Folder {
    dir: PathBuf,
}

impl Folder {
    fn new(args: &DirArgs) -> Result<Self, CliError> {
        let dir = match &args.dir {
            Some(dir) => dir.clone(),
            None => std::env::var_os("HOME")
                .filter(|home| !home.is_empty())
                .map(|home| PathBuf::from(home).join("marfa-server"))
                .ok_or_else(|| CliError::Usage("HOME is not set: pass --dir".into()))?,
        };
        Ok(Self { dir })
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn read(&self, name: &str) -> Result<Option<EnvFile>, CliError> {
        match std::fs::read_to_string(self.path(name)) {
            Ok(text) => Ok(Some(EnvFile::parse(&text))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
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
            dotenv.get(name).map(str::to_string).ok_or_else(|| {
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
            external: dotenv.get("MARFA_SETTINGS") == Some("external"),
            autostart: dotenv.get("MARFA_AUTOSTART") == Some("on"),
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

/// The address devices use, written the way the server reads it: no path,
/// no query, no trailing slash.
fn public_address(raw: &str) -> Result<String, CliError> {
    let bad =
        |why: &str| CliError::Usage(format!("{raw} is not an address the server can use: {why}"));
    let url = url::Url::parse(raw).map_err(|_| bad("write it like https://marfa.example.com"))?;
    if url.scheme() != "https" {
        return Err(bad("devices sign in only over https"));
    }
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(bad(
            "it takes a host, and a port if needed, and nothing else",
        ));
    }
    let host = url.host_str().unwrap_or_default();
    Ok(match url.port() {
        Some(port) => format!("https://{host}:{port}"),
        None => format!("https://{host}"),
    })
}

/// Which caller address the server believes, for how it is reached. A proxy
/// on this machine reaches the container from its network's gateway, so that
/// network's range is the proxy. Cloudflare's edge overwrites a header with
/// the caller's address, which is exact where the range is not.
fn proxy_trust(access: Access, subnet: &str) -> (Option<String>, Option<&'static str>) {
    match access {
        Access::Local => (None, None),
        Access::Tailscale | Access::Proxy => (Some(subnet.to_string()), None),
        Access::Cloudflare => (None, Some(CLOUDFLARE_HEADER)),
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

/// What a settings file that something else owns lacks for this install. It
/// names settings, never their values, which can be secrets.
fn external_problems(settings: &EnvFile, access: Access, subnet: &str, net: &str) -> Vec<String> {
    let mut problems = Vec::new();
    for secret in ["API_KEY_SALT", "MARFA_AUTH_SECRET"] {
        if settings.get(secret).is_none_or(str::is_empty) {
            problems.push(format!("{secret} is not set"));
        }
    }
    match settings.get("MARFA_AUTH_BASE_URL") {
        None | Some("") => problems.push("MARFA_AUTH_BASE_URL is not set".into()),
        Some(address) => {
            let sound = url::Url::parse(address).is_ok_and(|url| {
                url.scheme() == "https"
                    || (url.scheme() == "http"
                        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
            });
            if !sound {
                problems.push(
                    "MARFA_AUTH_BASE_URL must be an https address, or http on localhost".into(),
                );
            }
        }
    }
    let header = settings
        .get("TRUSTED_PROXY_HEADER")
        .filter(|v| !v.is_empty());
    let cidrs = settings
        .get("TRUSTED_PROXY_CIDRS")
        .filter(|v| !v.is_empty());
    match access {
        Access::Local => {}
        Access::Cloudflare => {
            if !header.is_some_and(|header| header.eq_ignore_ascii_case(CLOUDFLARE_HEADER)) {
                problems.push(format!(
                    "TRUSTED_PROXY_HEADER must be {CLOUDFLARE_HEADER} for a Cloudflare Tunnel, or every caller shares one address and ten wrong passwords lock the owner out"
                ));
            }
        }
        Access::Tailscale | Access::Proxy => {
            if header.is_some() {
                problems.push("TRUSTED_PROXY_HEADER is set, and it takes precedence over the proxy range, which this way of reaching the server needs".into());
            }
            if !cidrs
                .is_some_and(|cidrs| cidrs.split(',').any(|range| cidr_contains(range, subnet)))
            {
                problems.push(format!(
                    "TRUSTED_PROXY_CIDRS must include {subnet}, the range of the Docker network {net}, or every caller shares one address and ten wrong passwords lock the owner out"
                ));
            }
        }
    }
    problems
}

fn free_port(from: u16) -> Option<u16> {
    (from..from.saturating_add(100))
        .find(|port| std::net::TcpListener::bind(("127.0.0.1", *port)).is_ok())
}

// ---- progress -----------------------------------------------------------

struct Steps {
    quiet: bool,
}

impl Steps {
    fn say(&self, text: &str) {
        if !self.quiet {
            eprintln!("{text}");
        }
    }
}

// ---- install ------------------------------------------------------------

struct Backup {
    bucket: String,
    region: Option<String>,
    endpoint: Option<String>,
    access_key_id: String,
    secret: String,
    prefix: String,
}

fn backup_from(
    args: &InstallArgs,
    name: &str,
    prompter: &Prompter,
    existing: bool,
) -> Result<Option<Backup>, CliError> {
    let asked_by_flag = args.s3_bucket.is_some()
        || args.s3_region.is_some()
        || args.s3_endpoint.is_some()
        || args.s3_access_key_id.is_some()
        || args.s3_prefix.is_some();
    if !asked_by_flag {
        if existing || !prompter.asking() {
            return Ok(None);
        }
        eprintln!();
        eprintln!(
            "A copy of your data in an S3-compatible bucket (Amazon S3, Cloudflare R2, Backblaze B2, Railway) lets you rebuild the server if this machine is lost. Without one, no copy leaves this machine, and you back up the volume yourself."
        );
        if !prompter.yes_no("Keep a copy in a bucket?", false)? {
            return Ok(None);
        }
    }
    let bucket = match &args.s3_bucket {
        Some(bucket) => bucket.clone(),
        None => prompter.text("Bucket name", None, "--s3-bucket")?,
    };
    let access_key_id = match &args.s3_access_key_id {
        Some(id) => id.clone(),
        None => prompter.text("Access key ID", None, "--s3-access-key-id")?,
    };
    let secret = match std::env::var("S3_SECRET_ACCESS_KEY") {
        Ok(secret) if !secret.is_empty() => secret,
        _ => prompter.secret(
            "Secret access key",
            "S3_SECRET_ACCESS_KEY in the environment",
        )?,
    };
    let region = match &args.s3_region {
        Some(region) => Some(region.clone()),
        None if prompter.asking() => {
            Some(prompter.text("Region", Some("us-east-1"), "--s3-region")?)
        }
        None => None,
    };
    let endpoint = match &args.s3_endpoint {
        Some(endpoint) => Some(endpoint.clone()),
        None if prompter.asking() => {
            let answer = prompter.text(
                "Address, if the store is not Amazon S3 (press Return to skip)",
                Some(""),
                "--s3-endpoint",
            )?;
            (!answer.is_empty()).then_some(answer)
        }
        None => None,
    };
    let prefix = match &args.s3_prefix {
        Some(prefix) => prefix.clone(),
        None => name.to_string(),
    };
    Ok(Some(Backup {
        bucket,
        region,
        endpoint,
        access_key_id,
        secret,
        prefix,
    }))
}

fn install(args: InstallArgs, out: &Printer) -> Result<(), CliError> {
    let steps = Steps { quiet: out.json };
    let folder = Folder::new(&args.dir)?;
    let docker = Docker::new(!out.json);
    let prompter = Prompter::new(args.yes);
    let existing = folder.state()?;
    let external = args.external_settings || existing.as_ref().is_some_and(|(s, _)| s.external);

    let name = match (&args.name, &existing) {
        (Some(name), Some((state, _))) if *name != state.name => {
            return Err(CliError::Usage(format!(
                "{} already holds the install {}: use its name, or another --dir",
                folder.dir.display(),
                state.name
            )));
        }
        (Some(name), _) => name.clone(),
        (None, Some((state, _))) => state.name.clone(),
        (None, None) => "marfa".to_string(),
    };
    if !valid_name(&name) {
        return Err(CliError::Usage(format!(
            "{name} cannot name an install: use lowercase letters, digits, - and _, starting with a letter or digit"
        )));
    }
    let release = match (&args.release, &existing) {
        (Some(release), _) => checked_release(release)?,
        (None, Some((state, _))) => state.release.clone(),
        (None, None) => own_release().ok_or_else(|| {
            CliError::Usage("this build is not a release, so it names no image: pass --release, such as --release 0.0.22".into())
        })?,
    };

    steps.say("Checking Docker...");
    docker.check()?;

    let net = format!("{name}-net");
    let volume = format!("{name}-data");
    let settings_path = folder.path(files::SETTINGS);
    let have_secrets = folder.read(files::SETTINGS)?;
    if external && have_secrets.is_none() {
        return Err(CliError::Usage(format!(
            "{} does not exist, and this install takes its settings from there: write it first",
            settings_path.display()
        )));
    }
    if existing.is_none() {
        // A server this command did not make, on the name it would use.
        if docker.container(&name)?.is_some() {
            return Err(CliError::Usage(format!(
                "a container named {name} already exists, and no install in {} made it: choose another --name, or remove it with `docker rm -f {name}`",
                folder.dir.display()
            )));
        }
        if have_secrets.is_none() && docker.volume_exists(&volume)? {
            return Err(CliError::Usage(format!(
                "the Docker volume {volume} already holds data, and its secrets are not in {}: this command would start the data on new secrets and every key would stop working. Restore marfa.env from your copy into the folder, or choose another --name",
                folder.dir.display()
            )));
        }
    } else if have_secrets.is_none() && docker.volume_exists(&volume)? {
        return Err(CliError::Usage(format!(
            "{} is missing, and the data volume {volume} exists: restore marfa.env from your copy. A new one would make every key stop working",
            settings_path.display()
        )));
    }

    // The port.
    let port = match (&existing, args.port) {
        (Some((state, _)), None) => state.port,
        (Some((state, _)), Some(port)) if port == state.port => port,
        (_, Some(port)) => {
            if let Err(error) = std::net::TcpListener::bind(("127.0.0.1", port)) {
                return Err(CliError::Usage(format!(
                    "port {port} on this machine cannot be used ({error}): choose another with --port"
                )));
            }
            port
        }
        (None, None) => free_port(DEFAULT_PORT).ok_or_else(|| {
            CliError::Usage("no free port from 8600: choose one with --port".into())
        })?,
    };

    // How it is reached.
    let access = match (args.access, &existing) {
        (Some(access), _) => access,
        (None, Some((state, _))) => state.access,
        (None, None) => {
            let options = [
                ("local", "only this machine, at http://localhost"),
                (
                    "tailscale",
                    "your devices, over Tailscale, at an https address of your tailnet",
                ),
                (
                    "cloudflare",
                    "anywhere, through a Cloudflare Tunnel on this machine, at your own address",
                ),
                (
                    "proxy",
                    "anywhere, through another proxy on this machine (Caddy, nginx...), at your own address",
                ),
            ];
            let chosen = prompter.choose(
                "How will your devices reach this server?",
                &options,
                Some(0),
                "--access",
            )?;
            Access::value_variants()[chosen]
        }
    };
    let https_port = match access {
        Access::Tailscale => Some(
            args.https_port
                .or(existing.as_ref().and_then(|(state, _)| state.https_port))
                .unwrap_or(443),
        ),
        _ => {
            if args.https_port.is_some() {
                return Err(CliError::Usage(
                    "--https-port is for --access tailscale".into(),
                ));
            }
            None
        }
    };
    let address = match access {
        _ if external => {
            let written = have_secrets
                .as_ref()
                .and_then(|file| file.get("MARFA_AUTH_BASE_URL"))
                .map(str::to_string);
            match (&args.address, written) {
                (Some(asked), Some(written)) if public_address(asked)? != written => {
                    return Err(CliError::Usage(format!(
                        "--address is {asked}, and {} says MARFA_AUTH_BASE_URL is {written}: change one",
                        settings_path.display()
                    )));
                }
                (_, Some(written)) => written,
                (_, None) => String::new(),
            }
        }
        Access::Local => {
            if args.address.is_some() {
                return Err(CliError::Usage(
                    "--address is for tailscale, cloudflare and proxy: a local server is at http://localhost".into(),
                ));
            }
            format!("http://localhost:{port}")
        }
        Access::Tailscale => match &args.address {
            Some(address) => public_address(address)?,
            None => {
                let dns = tailscale::dns_name()?;
                match https_port {
                    Some(443) | None => format!("https://{dns}"),
                    Some(other) => format!("https://{dns}:{other}"),
                }
            }
        },
        Access::Cloudflare | Access::Proxy => {
            let raw = match (&args.address, &existing) {
                (Some(address), _) => address.clone(),
                (None, Some((_, _))) => have_secrets
                    .as_ref()
                    .and_then(|file| file.get("MARFA_AUTH_BASE_URL"))
                    .map(str::to_string)
                    .map_or_else(
                        || prompter.text("Address devices will use", None, "--address"),
                        Ok,
                    )?,
                (None, None) => prompter.text(
                    "Address devices will use, such as https://marfa.example.com",
                    None,
                    "--address",
                )?,
            };
            public_address(&raw)?
        }
    };

    // The backup.
    let backup = backup_from(&args, &name, &prompter, existing.is_some())?;

    // The network gives the proxy a range that survives a restart.
    let subnet = match docker.network_subnet(&net)? {
        Some(subnet) => subnet,
        None => {
            steps.say(&format!("Making the Docker network {net}..."));
            docker.create_network(&net)?;
            docker.network_subnet(&net)?.ok_or_else(|| {
                CliError::Install(format!("Docker made the network {net} with no IPv4 range"))
            })?
        }
    };

    // The settings the server reads. The secrets are made once, and not at
    // all when something else owns the file.
    let mut settings = have_secrets
        .clone()
        .unwrap_or_else(|| EnvFile::parse(files::SETTINGS_HEADER));
    if external {
        let problems = external_problems(&settings, access, &subnet, &net);
        if !problems.is_empty() {
            return Err(CliError::Usage(format!(
                "{} cannot run this install yet:\n  - {}",
                settings_path.display(),
                problems.join("\n  - ")
            )));
        }
        if backup.is_some() {
            return Err(CliError::Usage(
                "--s3 options change the settings file, and this install takes it as it is: put the S3_ settings in it".into(),
            ));
        }
    }
    let made_secrets = !external
        && (settings.get("API_KEY_SALT").is_none() || settings.get("MARFA_AUTH_SECRET").is_none());
    if !external {
        if settings.get("API_KEY_SALT").is_none() {
            settings.set("API_KEY_SALT", &envfile::secret()?)?;
        }
        if settings.get("MARFA_AUTH_SECRET").is_none() {
            settings.set("MARFA_AUTH_SECRET", &envfile::secret()?)?;
        }
        settings.set("MARFA_AUTH_BASE_URL", &address)?;
        let (cidrs, header) = proxy_trust(access, &subnet);
        match cidrs {
            Some(cidrs) => settings.set("TRUSTED_PROXY_CIDRS", &cidrs)?,
            None => settings.remove("TRUSTED_PROXY_CIDRS"),
        }
        match header {
            Some(header) => settings.set("TRUSTED_PROXY_HEADER", header)?,
            None => settings.remove("TRUSTED_PROXY_HEADER"),
        }
    }
    if let (false, Some(backup)) = (external, &backup) {
        settings.set("S3_BUCKET", &backup.bucket)?;
        settings.set("S3_ACCESS_KEY_ID", &backup.access_key_id)?;
        settings.set("S3_SECRET_ACCESS_KEY", &backup.secret)?;
        settings.set("S3_PREFIX", &backup.prefix)?;
        match &backup.region {
            Some(region) => settings.set("S3_REGION", region)?,
            None => settings.remove("S3_REGION"),
        }
        match &backup.endpoint {
            Some(endpoint) => settings.set("S3_ENDPOINT", endpoint)?,
            None => settings.remove("S3_ENDPOINT"),
        }
    }

    // What Compose reads.
    let mut dotenv = existing
        .as_ref()
        .map(|(_, dotenv)| dotenv.clone())
        .unwrap_or_else(|| EnvFile::parse(files::DOTENV_HEADER));
    dotenv.set("MARFA_NAME", &name)?;
    dotenv.set("MARFA_RELEASE", &release)?;
    dotenv.set("MARFA_PORT", &port.to_string())?;
    dotenv.set("MARFA_ACCESS", access.name())?;
    match https_port {
        Some(port) => dotenv.set("MARFA_HTTPS_PORT", &port.to_string())?,
        None => dotenv.remove("MARFA_HTTPS_PORT"),
    }
    if external {
        dotenv.set("MARFA_SETTINGS", "external")?;
    }
    let autostart = match (args.autostart, args.no_autostart, &existing) {
        (true, _, _) if !boot::supported() => {
            return Err(CliError::Usage(
                "--autostart is for a Mac, where launchd starts it at login; on Linux, `sudo systemctl enable docker` brings the server back at boot".into(),
            ));
        }
        (true, _, _) => true,
        (_, true, _) => false,
        (_, _, Some((state, _))) => state.autostart,
        (_, _, None) => {
            boot::supported()
                && prompter.yes_no(
                    "Start Marfa when you log in, even if Docker is not running yet?",
                    true,
                )?
        }
    };
    dotenv.set("MARFA_AUTOSTART", if autostart { "on" } else { "off" })?;

    std::fs::create_dir_all(&folder.dir)?;
    let wrote_settings = if external {
        false
    } else {
        let wrote = files::write_if_changed(&settings_path, &settings.render(), true)?;
        files::keep_private(&settings_path)?;
        wrote
    };
    let wrote_dotenv =
        files::write_if_changed(&folder.path(files::DOTENV), &dotenv.render(), false)?;
    let wrote_compose =
        files::write_if_changed(&folder.path(files::COMPOSE), files::COMPOSE_FILE, false)?;
    let changed = wrote_settings || wrote_dotenv || wrote_compose;

    if access == Access::Tailscale {
        steps.say("Serving the address on your tailnet...");
        tailscale::serve(
            https_port.unwrap_or(443),
            &format!("http://127.0.0.1:{port}"),
        )?;
    }

    start(&docker, &folder.dir, &name, &release, &steps)?;
    wait_until_healthy(&docker, &name, port, args.wait)?;

    // The login agent comes after the server is up, because loading it runs it.
    if autostart {
        steps.say("Setting the server to start when you log in...");
        boot::on(
            &boot::Agent::for_this_binary(&name, &folder.dir)?,
            !out.json,
        )?;
    } else if boot::installed(&name) {
        boot::off(&name, !out.json)?;
    }

    // Claim.
    let claim = claim_state(&docker, &name)?;
    let notes = boot_notes(autostart);
    let backup_on = settings.get("S3_BUCKET").is_some();
    let report = json!({
        "installed": true,
        "changed": changed,
        "dir": folder.dir,
        "name": name,
        "release": release,
        "address": address,
        "port": port,
        "access": access.name(),
        "backup": backup_on,
        "secrets_made": made_secrets,
        "settings": if external { "external" } else { "managed" },
        "autostart": autostart,
        "claimed": claim.claimed,
        "setup_url": claim.url,
        "setup_expires_at": claim.expires_at,
    });
    out.report(&report, || {
        let mut text = String::new();
        text.push_str(&format!(
            "\nMarfa {release} is running.\n\n"
        ));
        text.push_str(&format!("  Address   {address}\n"));
        text.push_str(&format!("  Folder    {}\n", folder.dir.display()));
        text.push_str(&format!(
            "  Backup    {}\n",
            if backup_on {
                "to your bucket, continuously"
            } else {
                "none: no copy leaves this machine"
            }
        ));
        if external {
            text.push_str(&format!(
                "  Settings  {} (managed outside this command; run it again after they change)\n",
                settings_path.display()
            ));
        }
        if made_secrets {
            text.push_str(&format!(
                "\nKeep a copy of {} somewhere safe, outside this folder. It holds the two secrets the data needs, and they are not stored anywhere else.\n",
                settings_path.display()
            ));
        }
        match &claim.url {
            Some(url) => text.push_str(&format!(
                "\nOpen this link to choose the owner's email and password. It works once, for five minutes; run this command again for a new one.\n\n  {url}\n"
            )),
            None => text.push_str(&format!(
                "\nThis instance has an owner already. Sign in at {address}.\n"
            )),
        }
        for note in &notes {
            text.push_str(&format!("\n{note}\n"));
        }
        text
    })
}

fn start(
    docker: &Docker,
    dir: &Path,
    name: &str,
    release: &str,
    steps: &Steps,
) -> Result<(), CliError> {
    if !docker.image_present(&format!("{IMAGE}:{release}"))? {
        steps.say(&format!("Pulling {IMAGE}:{release}..."));
        docker.compose(dir, &["pull", "--quiet"], !steps.quiet)?;
    }
    steps.say(&format!("Starting {name}..."));
    docker.compose(dir, &["up", "-d", "--remove-orphans"], false)
}

fn wait_until_healthy(
    docker: &Docker,
    name: &str,
    port: u16,
    seconds: u64,
) -> Result<(), CliError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(3)))
        .http_status_as_error(false)
        .build()
        .into();
    let url = format!("http://127.0.0.1:{port}/health");
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut last = String::from("no answer yet");
    loop {
        match agent.get(&url).call() {
            Ok(response) if response.status().as_u16() == 200 => return Ok(()),
            Ok(response) => last = format!("it answered {}", response.status().as_u16()),
            Err(_) => {}
        }
        if let Some(state) = docker.container(name)?
            && matches!(state.status.as_str(), "exited" | "dead")
        {
            return Err(CliError::Install(format!(
                "the server stopped: {}\n{}",
                state.status,
                docker.logs_tail(name)
            )));
        }
        if Instant::now() >= deadline {
            return Err(CliError::Install(format!(
                "the server did not become healthy in {seconds} seconds ({last}). Its log ends:\n{}",
                docker.logs_tail(name)
            )));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

struct Claim {
    claimed: bool,
    url: Option<String>,
    expires_at: Option<String>,
}

fn claim_state(docker: &Docker, name: &str) -> Result<Claim, CliError> {
    let status = docker.marfa_json(name, &["setup", "status"])?;
    if status["claimed"].as_bool().unwrap_or(false) {
        return Ok(Claim {
            claimed: true,
            url: None,
            expires_at: None,
        });
    }
    let ticket = docker.marfa_json(name, &["setup", "open", "--no-browser"])?;
    let url = ticket["url"]
        .as_str()
        .ok_or_else(|| CliError::Install("the server returned no setup link".into()))?;
    Ok(Claim {
        claimed: false,
        url: Some(url.to_string()),
        expires_at: ticket["expires_at"].as_str().map(str::to_string),
    })
}

/// What decides whether the server comes back after a restart of the machine:
/// Docker's restart policy brings the container back whenever the engine
/// starts, so the engine's own start is the part worth saying.
fn boot_notes(autostart: bool) -> Vec<String> {
    if autostart {
        return vec!["It starts when you log in, starting Docker first if it is not running, and again after a failure. `marfa server status` shows it.".into()];
    }
    if cfg!(target_os = "linux") {
        let enabled = std::process::Command::new("systemctl")
            .args(["is-enabled", "docker"])
            .output()
            .ok();
        return match enabled {
            Some(output) if output.status.success() => {
                vec!["It starts again whenever the machine does: Docker starts at boot and the container restarts with it.".into()]
            }
            Some(_) => vec!["Docker does not start at boot on this machine, so the server would not either. Run `sudo systemctl enable docker` once.".into()],
            None => Vec::new(),
        };
    }
    vec!["It restarts whenever Docker does. On a Mac, Docker starts only after you sign in, unless you turn on \"Start at login\" in OrbStack or Docker Desktop's settings.".into()]
}

// ---- upgrade ------------------------------------------------------------

fn upgrade(args: UpgradeArgs, out: &Printer) -> Result<(), CliError> {
    let steps = Steps { quiet: out.json };
    let folder = Folder::new(&args.dir)?;
    let (state, mut dotenv) = folder.require_state()?;
    let target = match &args.release {
        Some(release) => checked_release(release)?,
        None => own_release().ok_or_else(|| {
            CliError::Usage(
                "this build is not a release, so it names no image: pass --release".into(),
            )
        })?,
    };
    let (current, wanted) = (parse_release(&state.release), parse_release(&target));
    if wanted < current {
        return Err(CliError::Usage(format!(
            "{} is installed and {target} is older. A newer release may have changed the database's shape, so the server will not go back: restore a backup into a fresh install of the older release instead",
            state.release
        )));
    }
    let docker = Docker::new(!out.json);
    docker.check()?;
    let unchanged = target == state.release;
    if !unchanged {
        steps.say(&format!(
            "Read the changelog for {target} first (https://docs.marfa.so/changelog). If it says the database changes shape, follow the Upgrade guide (https://docs.marfa.so/guides/upgrade) instead of this command."
        ));
        dotenv.set("MARFA_RELEASE", &target)?;
        files::write_if_changed(&folder.path(files::DOTENV), &dotenv.render(), false)?;
    }
    files::write_if_changed(&folder.path(files::COMPOSE), files::COMPOSE_FILE, false)?;
    start(&docker, &folder.dir, &state.name, &target, &steps)?;
    wait_until_healthy(&docker, &state.name, state.port, args.wait)?;
    let report = json!({
        "name": state.name,
        "from": state.release,
        "release": target,
        "changed": !unchanged,
    });
    out.report(&report, || {
        if unchanged {
            format!("Already on {target}.")
        } else {
            format!("Upgraded from {} to {target}.", state.release)
        }
    })
}

// ---- start --------------------------------------------------------------

fn start_server(args: StartArgs, out: &Printer) -> Result<(), CliError> {
    let steps = Steps { quiet: out.json };
    let folder = Folder::new(&args.dir)?;
    let (state, _) = folder.require_state()?;
    let docker = Docker::new(!out.json);
    steps.say("Checking Docker...");
    boot::ensure_engine(&docker, args.wait, !out.json)?;
    docker.check()?;
    start(&docker, &folder.dir, &state.name, &state.release, &steps)?;
    wait_until_healthy(&docker, &state.name, state.port, args.wait)?;
    out.report(
        &json!({ "name": state.name, "release": state.release, "running": true }),
        || format!("{} {} is running.", state.name, state.release),
    )
}

// ---- status -------------------------------------------------------------

fn autostart_word(state: &State) -> &'static str {
    match (state.autostart, boot::installed(&state.name)) {
        (true, true) if boot::loaded(&state.name) => "on",
        (true, true) => "installed, not loaded",
        (true, false) => "missing: `marfa server install` restores it",
        (false, _) => "off",
    }
}

fn status(args: DirArgs, out: &Printer) -> Result<(), CliError> {
    let folder = Folder::new(&args)?;
    let (state, _) = folder.require_state()?;
    let settings = folder.read(files::SETTINGS)?.unwrap_or_default();
    let docker = Docker::new(false);
    docker.check()?;
    let container = docker.container(&state.name)?;
    let running = container.as_ref().is_some_and(|c| c.status == "running");
    let healthy = running && {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(3)))
            .http_status_as_error(false)
            .build()
            .into();
        agent
            .get(&format!("http://127.0.0.1:{}/health", state.port))
            .call()
            .is_ok_and(|response| response.status().as_u16() == 200)
    };
    let claimed = if healthy {
        docker
            .marfa_json(&state.name, &["setup", "status"])
            .ok()
            .and_then(|status| status["claimed"].as_bool())
    } else {
        None
    };
    let address = settings.get("MARFA_AUTH_BASE_URL").map(str::to_string);
    let login = if boot::supported() {
        format!("\n  Login     {}", autostart_word(&state))
    } else {
        String::new()
    };
    let autostart = autostart_word(&state);
    let report = json!({
        "dir": folder.dir,
        "name": state.name,
        "release": state.release,
        "container": container.as_ref().map(|c| c.status.clone()),
        "healthy": healthy,
        "claimed": claimed,
        "address": address,
        "port": state.port,
        "access": state.access.name(),
        "backup": settings.get("S3_BUCKET").is_some(),
        "settings": if state.external { "external" } else { "managed" },
        "autostart": autostart,
    });
    out.report(&report, || {
        let word = match (&container, healthy) {
            (None, _) => "not created".to_string(),
            (Some(_), true) => "running and healthy".to_string(),
            (Some(c), false) => format!("{}, not answering", c.status),
        };
        format!(
            "{} {}: {word}\n  Address   {}\n  Folder    {}\n  Owner     {}\n  Backup    {}{login}",
            state.name,
            state.release,
            address.as_deref().unwrap_or("unknown"),
            folder.dir.display(),
            match claimed {
                Some(true) => "set up",
                Some(false) => "not set up yet: `marfa server install` prints the link",
                None => "unknown",
            },
            if settings.get("S3_BUCKET").is_some() {
                "to a bucket"
            } else {
                "none"
            },
        )
    })
}

// ---- uninstall ----------------------------------------------------------

fn uninstall(args: UninstallArgs, out: &Printer) -> Result<(), CliError> {
    let steps = Steps { quiet: out.json };
    let folder = Folder::new(&args.dir)?;
    let (state, _) = folder.require_state()?;
    let docker = Docker::new(!out.json);
    docker.check()?;
    let volume = format!("{}-data", state.name);
    let net = format!("{}-net", state.name);
    if args.delete_data && !args.yes {
        let prompter = Prompter::new(false);
        if !prompter.asking() {
            return Err(CliError::Usage(
                "--delete-data needs --yes when nothing can ask you".into(),
            ));
        }
        eprintln!(
            "This deletes every item and file in {volume}, and the secrets in {}.",
            folder.path(files::SETTINGS).display()
        );
        let typed = prompter.text(&format!("Type {} to confirm", state.name), None, "--yes")?;
        if typed != state.name {
            return Err(CliError::Usage("not confirmed; nothing was deleted".into()));
        }
    }
    steps.say(&format!("Stopping {}...", state.name));
    if folder.path(files::COMPOSE).exists() {
        docker.compose(&folder.dir, &["down"], false)?;
    }
    if boot::installed(&state.name) {
        boot::off(&state.name, !out.json)?;
    }
    let mut unserved = false;
    if state.access == Access::Tailscale {
        unserved = tailscale::unserve(
            state.https_port.unwrap_or(443),
            &format!("http://127.0.0.1:{}", state.port),
        )
        .unwrap_or(false);
    }
    if args.delete_data {
        docker.remove_volume(&volume)?;
        docker.remove_network(&net)?;
        for name in [files::SETTINGS, files::DOTENV, files::COMPOSE] {
            match std::fs::remove_file(folder.path(name)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        // Only an empty folder goes; anything else in it is the person's.
        let _ = std::fs::remove_dir(&folder.dir);
    }
    let report = json!({
        "name": state.name,
        "stopped": true,
        "data_deleted": args.delete_data,
        "tailscale_unserved": unserved,
    });
    out.report(&report, || {
        if args.delete_data {
            format!("Stopped {} and deleted its data and settings.", state.name)
        } else {
            format!(
                "Stopped {}. Its data stays in the Docker volume {volume}, and its settings in {}; `marfa server install` starts it again.",
                state.name,
                folder.dir.display()
            )
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(proxy_trust(Access::Local, subnet), (None, None));
        assert_eq!(
            proxy_trust(Access::Tailscale, subnet),
            (Some(subnet.into()), None)
        );
        assert_eq!(
            proxy_trust(Access::Proxy, subnet),
            (Some(subnet.into()), None)
        );
        assert_eq!(
            proxy_trust(Access::Cloudflare, subnet),
            (None, Some("CF-Connecting-IP"))
        );
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
}

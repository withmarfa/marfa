//! `marfa server upgrade`, `start`, `stop`, `restart`, `status` and `uninstall`.

use std::path::Path;

use serde_json::{Value, json};

use super::backups;
use super::docker::{self, Docker};
use super::install::{Watch, wait_until_healthy, write_compose};
use super::prompt::Prompter;
use super::run::{self, REFUSED_DATABASE};
use super::service::{Control, Manager, Service};
use super::{
    Access, DirArgs, Folder, IMAGE, PrivateCommand, Runtime, StartArgs, State, Steps,
    UninstallArgs, UpgradeArgs, checked_release, files, http_agent, launchd, native, own_release,
    refuse_older, tailscale,
};
use crate::error::CliError;
use crate::output::Printer;
use crate::style::{self, Stream};

/// The service of a native install, after a check that this account can
/// manage it.
fn service_of<'a>(
    state: &'a State,
    folder: &'a Folder,
    trace: bool,
) -> Result<Service<'a>, CliError> {
    let manager = state.manager.expect("a native install records its service");
    manager.check_account()?;
    Ok(Service {
        manager,
        name: &state.name,
        dir: &folder.dir,
        trace,
    })
}

// ---- upgrade ------------------------------------------------------------

pub fn upgrade(args: UpgradeArgs, out: &Printer) -> Result<(), CliError> {
    let steps = Steps { quiet: out.json };
    let folder = Folder::new(&args.dir)?;
    let (state, mut dotenv) = folder.require_state()?;
    match state.runtime {
        Runtime::Native => upgrade_native(&args, out, &steps, &folder, &state, &mut dotenv),
        Runtime::Docker => upgrade_docker(&args, out, &steps, &folder, &state, &mut dotenv),
    }
}

fn upgrade_native(
    args: &UpgradeArgs,
    out: &Printer,
    steps: &Steps,
    folder: &Folder,
    state: &State,
    dotenv: &mut super::envfile::EnvFile,
) -> Result<(), CliError> {
    if args.release.is_some() {
        return Err(CliError::Usage(
            "--release is for a Docker install: a native server moves to the release installed beside this marfa. Install the release you want (with Homebrew, or scripts/install.sh) and run this again".into(),
        ));
    }
    let target = env!("CARGO_PKG_VERSION").to_string();
    refuse_older(&state.release, &target)?;
    let service = service_of(state, folder, !out.json)?;
    if state.manager == Some(Manager::SystemdSystem) {
        super::account::check_group()?;
    }
    if !service.exists() {
        return Err(CliError::Usage(format!(
            "{} does not exist: `marfa server install` makes it",
            service.describe()
        )));
    }
    let server = run::locate()?;
    let binary = native::stable_binary_of_this()?;
    let unchanged = target == state.release;
    if !unchanged {
        steps.say(&format!(
            "If {target} has a newer database schema, the server copies the database beside it and then updates it in place."
        ));
    }
    if !unchanged {
        folder.forget_applied(dotenv, files::kept_for(state.manager).dotenv)?;
    }
    let mark = service.mark();
    // A new release may keep the same service definition.
    let started = service.on(state.autostart, !unchanged, &binary, &server)?;
    let watch = Watch::Process {
        service: &service,
        mark,
    };
    if let Err(error) = wait_until_healthy(&watch, state.port, args.wait) {
        if unchanged || !service.log_tail(40).contains(REFUSED_DATABASE) {
            return Err(error);
        }
        return Err(CliError::Install(format!(
            "{error}\n\n{}",
            refused_update_note(&target, &state.release, &folder.dir)
        )));
    }
    if !unchanged {
        if !out.json {
            started.say_unconfirmed(state.port);
        }
        dotenv.set("MARFA_RELEASE", &target)?;
        let kept = files::kept_for(state.manager).dotenv;
        if started.confirmed() {
            folder.keep_applied(dotenv, &folder.applied(state.port, &target)?, kept)?;
        } else {
            folder.forget_applied(dotenv, kept)?;
        }
    }
    let update = database_update(&service.log_tail(200));
    let copy_note = update.as_ref().map(|update| {
        format!(
            " The server's log records that it updated the database from schema version {} to {}. A copy of the database as it was is at {}, and stays until you remove it.",
            update.schema_from,
            update.schema_to,
            update.copy,
        )
    });
    let report = json!({
        "name": state.name,
        "from": state.release,
        "release": target,
        "runtime": "native",
        "changed": !unchanged,
        "database_update": update.as_ref().map(|update| json!({
            "schema_from": update.schema_from,
            "schema_to": update.schema_to,
            "copy": update.copy,
        })),
    });
    out.report(&report, || {
        let moved = if unchanged {
            format!("Already on {target}.")
        } else {
            format!("Upgraded from {} to {target}.", state.release)
        };
        match &copy_note {
            Some(note) => format!("{moved}{note}"),
            None => moved,
        }
    })
}

fn upgrade_docker(
    args: &UpgradeArgs,
    out: &Printer,
    steps: &Steps,
    folder: &Folder,
    state: &State,
    dotenv: &mut super::envfile::EnvFile,
) -> Result<(), CliError> {
    let target = match &args.release {
        Some(release) => checked_release(release)?,
        None => own_release().ok_or_else(|| {
            CliError::Usage(
                "this build is not a release, so it names no image: pass --release".into(),
            )
        })?,
    };
    refuse_older(&state.release, &target)?;
    let docker = Docker::new(!out.json);
    docker.check()?;
    let unchanged = target == state.release;
    // A release that does not exist is found before it is written down, or no
    // later upgrade could name a real one below it.
    if !unchanged && !docker.image_present(&format!("{IMAGE}:{target}"))? {
        docker.release_exists(IMAGE, &target)?;
    }
    if !unchanged {
        steps.say(&format!(
            "If {target} has a newer database schema, the server copies the database beside it and then updates it in place."
        ));
        dotenv.set("MARFA_RELEASE", &target)?;
        files::write_if_changed(
            &folder.path(files::DOTENV),
            &dotenv.render(),
            files::Perms::READABLE,
        )?;
    }
    write_compose(folder, steps)?;
    super::install::start(&docker, &folder.dir, &state.name, &target, steps)?;
    let watch = Watch::Container {
        docker: &docker,
        name: &state.name,
    };
    if let Err(error) = wait_until_healthy(&watch, state.port, args.wait) {
        if unchanged || !docker.logs_tail(&state.name).contains(REFUSED_DATABASE) {
            return Err(error);
        }
        return Err(CliError::Install(format!(
            "{error}\n\n{target} did not update the database, and the server says why above. A refused update leaves the database as it was, so {from} still reads it: to go back, set MARFA_RELEASE={from} in {env} and run `marfa server start`.",
            from = state.release,
            env = folder.path(files::DOTENV).display(),
        )));
    }
    // A retry finds the env file already on the target, though the update
    // happened after the first run's wait ended, so the log is read either way.
    let update = database_update(&docker.logs(&state.name));
    let report = json!({
        "name": state.name,
        "from": state.release,
        "release": target,
        "runtime": "docker",
        "changed": !unchanged,
        "database_update": update.as_ref().map(|update| json!({
            "schema_from": update.schema_from,
            "schema_to": update.schema_to,
            "copy": update.copy,
        })),
    });
    out.report(&report, || {
        let moved = if unchanged {
            format!("Already on {target}.")
        } else {
            format!("Upgraded from {} to {target}.", state.release)
        };
        match &update {
            Some(update) => format!(
                "{moved} The server's log records that it updated the database from schema version {} to {}. A copy of the database as it was is at {copy} in the volume {name}-data, and stays until you remove it; `docker cp {name}:{copy} .` copies it out.",
                update.schema_from,
                update.schema_to,
                copy = update.copy,
                name = state.name,
            ),
            None => moved,
        }
    })
}

/// What the server logged of the update it made to the database on start.
struct DatabaseUpdate {
    schema_from: u64,
    schema_to: u64,
    copy: String,
}

/// The update the server's log reports, read from its JSON lines: the last
/// one, since a log holds every start it made.
fn database_update(log: &str) -> Option<DatabaseUpdate> {
    log.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .filter(|entry| {
            entry["message"]
                .as_str()
                .is_some_and(|m| m.starts_with("Updated "))
        })
        .filter_map(|entry| {
            Some(DatabaseUpdate {
                schema_from: entry["schema_from"].as_u64()?,
                schema_to: entry["schema_to"].as_u64()?,
                copy: entry["backup_path"].as_str()?.to_string(),
            })
        })
        .next_back()
}

// The idle supervisor must stop before the earlier release can start.
fn refused_update_note(target: &str, from: &str, dir: &Path) -> String {
    let dir = format!("'{}'", dir.display().to_string().replace('\'', "'\\''"));
    format!(
        "{target} did not update the database, and the server says why above. A refused update leaves the database as it was, so {from} still reads it. The service stays up and idle after a refusal, so run `marfa server stop --dir {dir}`, install {from} again, then run `marfa server start --dir {dir}`."
    )
}

// ---- start and stop -----------------------------------------------------

pub fn start(args: StartArgs, out: &Printer) -> Result<(), CliError> {
    let (json, text) = started(args, out)?;
    out.report(&json, || text)
}

fn started(args: StartArgs, out: &Printer) -> Result<(Value, String), CliError> {
    let steps = Steps { quiet: out.json };
    let folder = Folder::new(&args.dir)?;
    let (state, mut dotenv) = folder.require_state()?;
    match state.runtime {
        Runtime::Native => {
            let service = service_of(&state, &folder, !out.json)?;
            if !service.exists() {
                return Err(CliError::Usage(format!(
                    "{} does not exist: `marfa server install` makes it",
                    service.describe()
                )));
            }
            let server = run::locate()?;
            let binary = native::stable_binary_of_this()?;
            steps.say(&format!("Starting {}...", state.name));
            let mark = service.mark();
            // Written again, so that a binary that has moved is named by its
            // new path.
            let was_running = service.running();
            service.on(state.autostart, false, &binary, &server)?;
            service.start()?;
            wait_until_healthy(
                &Watch::Process {
                    service: &service,
                    mark,
                },
                state.port,
                args.wait,
            )?;
            // A server that was already running keeps what it started with.
            if !was_running {
                folder.keep_applied(
                    &mut dotenv,
                    &folder.applied(state.port, &state.release)?,
                    files::kept_for(state.manager).dotenv,
                )?;
            }
        }
        Runtime::Docker => {
            let docker = Docker::new(!out.json);
            steps.say("Checking Docker...");
            docker::ensure_engine(&docker, args.wait, !out.json)?;
            docker.check()?;
            super::install::start(&docker, &folder.dir, &state.name, &state.release, &steps)?;
            wait_until_healthy(
                &Watch::Container {
                    docker: &docker,
                    name: &state.name,
                },
                state.port,
                args.wait,
            )?;
        }
    }
    Ok((
        json!({ "name": state.name, "release": state.release, "running": true }),
        format!("{} {} is running.", state.name, state.release),
    ))
}

pub fn stop(args: DirArgs, out: &Printer) -> Result<(), CliError> {
    let (json, text) = stopped(args, out)?;
    out.report(&json, || text)
}

fn stopped(args: DirArgs, out: &Printer) -> Result<(Value, String), CliError> {
    let steps = Steps { quiet: out.json };
    let folder = Folder::new(&args)?;
    let (state, _) = folder.require_state()?;
    let was_running = match state.runtime {
        Runtime::Native => {
            let service = service_of(&state, &folder, !out.json)?;
            steps.say(&format!("Stopping {}...", state.name));
            service.stop()?
        }
        Runtime::Docker => {
            let docker = Docker::new(!out.json);
            docker.check()?;
            let was = docker
                .container(&state.name)?
                .is_some_and(|container| container.status == "running");
            steps.say(&format!("Stopping {}...", state.name));
            write_compose(&folder, &steps)?;
            docker.compose(&folder.dir, &["stop"], false)?;
            was
        }
    };
    let text = if was_running {
        format!(
            "Stopped {}. `marfa server start` starts it again; its data and settings stay.",
            state.name
        )
    } else {
        format!("{} was not running.", state.name)
    };
    Ok((
        json!({ "name": state.name, "stopped": true, "was_running": was_running }),
        text,
    ))
}

/// One document in JSON, `stopped` and `started`, so a strict parser reads it.
pub fn restart(args: StartArgs, out: &Printer) -> Result<(), CliError> {
    let (stopped, said) = stopped(
        DirArgs {
            dir: args.dir.dir.clone(),
        },
        out,
    )?;
    if !out.json {
        out.line(&said)?;
    }
    let (started, text) = started(args, out)?;
    out.report(&json!({ "stopped": stopped, "started": started }), || text)
}

// ---- status -------------------------------------------------------------

fn autostart_word(state: &State, at_boot: Option<bool>, exists: bool) -> &'static str {
    match (state.autostart, exists, at_boot) {
        (true, true, Some(true) | None) => "on",
        (true, true, Some(false)) => "installed, not loaded",
        (true, false, _) => "missing: `marfa server install` restores it",
        (false, _, _) => "off",
    }
}

/// What `GET /health` answered, whatever its status: a server that says it is
/// degraded or down has still answered.
struct Health {
    http: u16,
    /// `ok`, `degraded` or `down`, when the body names one.
    status: Option<String>,
    /// Each component that is not `ok`, in words.
    problems: Vec<String>,
    backups: Option<backups::Said>,
}

impl Health {
    fn ask(agent: &ureq::Agent, port: u16) -> Option<Health> {
        let mut response = agent
            .get(&format!("http://127.0.0.1:{port}/health"))
            .call()
            .ok()?;
        let http = response.status().as_u16();
        let body = response
            .body_mut()
            .read_json::<Value>()
            .unwrap_or(Value::Null);
        let status = body["status"].as_str().map(str::to_string);
        let mut problems: Vec<String> = body["components"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(name, component)| {
                let said = component["status"].as_str().filter(|said| *said != "ok")?;
                Some(format!("{} {said}", name.replace('_', " ")))
            })
            .collect();
        if body["backups"]["status"] == "failing" {
            problems.push("backups failing".into());
        }
        Some(Health {
            http,
            status,
            problems,
            backups: backups::Said::of(&body),
        })
    }

    fn is_ok(&self) -> bool {
        self.http == 200 && matches!(self.status.as_deref(), None | Some("ok"))
    }

    fn said(&self) -> String {
        let word = match &self.status {
            Some(status) => status.clone(),
            None => format!("answered {}", self.http),
        };
        if self.problems.is_empty() {
            word
        } else {
            format!("{word}: {}", self.problems.join(", "))
        }
    }

    fn json(&self) -> Value {
        json!({ "http": self.http, "status": self.status, "problems": self.problems })
    }
}

pub fn status(args: DirArgs, out: &Printer) -> Result<(), CliError> {
    let folder = Folder::new(&args)?;
    let (state, _) = folder.require_state()?;
    let trace = false;
    let (service, container, docker): (
        Option<Service>,
        Option<docker::ContainerState>,
        Option<Docker>,
    ) = match state.runtime {
        Runtime::Native => (Some(service_of(&state, &folder, trace)?), None, None),
        Runtime::Docker => {
            let docker = Docker::new(false);
            docker.check()?;
            let container = docker.container(&state.name)?;
            (None, container, Some(docker))
        }
    };
    let running = match (&service, &container) {
        (Some(service), _) => service.running(),
        (_, Some(container)) => container.status == "running",
        _ => false,
    };
    let agent = http_agent();
    let answered = if running {
        Health::ask(&agent, state.port)
    } else {
        None
    };
    let answering = answered.is_some();
    let healthy = answered.as_ref().is_some_and(Health::is_ok);
    let release = if answering {
        agent
            .get(&format!("http://127.0.0.1:{}/", state.port))
            .call()
            .ok()
            .and_then(|mut response| response.body_mut().read_json::<Value>().ok())
            .and_then(|body| body["version"].as_str().map(str::to_string))
    } else {
        None
    };
    let control = match (&service, &docker) {
        (Some(service), _) => Control::native(&folder.dir, service.manager).ok(),
        (_, Some(docker)) => Some(Control::Container {
            docker,
            name: &state.name,
        }),
        _ => None,
    };
    let claimed = control
        .as_ref()
        .filter(|_| answering)
        .and_then(|control| control.json(&["setup", "status"]).ok())
        .and_then(|status| status["claimed"].as_bool());
    let held_address: Option<String> = control
        .as_ref()
        .filter(|_| answering)
        .and_then(|control| control.json(&["config", "get"]).ok())
        .and_then(|config| super::address::stored(&config).map(str::to_string));
    let address = held_address
        .or_else(|| state.address.clone())
        .unwrap_or_else(|| super::local_address(state.port));
    let tail = if answering {
        String::new()
    } else {
        match (&service, &docker) {
            (Some(service), _) => service.log_tail(15),
            (_, Some(docker)) => docker.logs_tail(&state.name),
            _ => String::new(),
        }
    };
    let (at_boot, exists) = match &service {
        Some(service) => (Some(service.at_boot()), service.exists()),
        None => (None, launchd::installed(&state.name, &folder.dir).is_some()),
    };
    let login = autostart_word(&state, at_boot, exists);
    let service_name = service.as_ref().map(|service| service.describe());
    let settings = folder.path(files::SETTINGS);
    let private = PrivateCommand::of(&state, &folder);
    let backups_say = answered
        .as_ref()
        .and_then(|health| health.backups.as_ref())
        .and_then(|backups| {
            backups.words(
                &settings,
                state.runtime == Runtime::Docker,
                private.as_ref(),
            )
        });
    let report = json!({
        "dir": folder.dir,
        "name": state.name,
        "runtime": state.runtime.name(),
        "release": state.release,
        "running_release": release,
        "service": service_name,
        "container": container.as_ref().map(|c| c.status.clone()),
        "running": running,
        "answering": answering,
        "healthy": healthy,
        "health": answered.as_ref().map(Health::json),
        "backups": answered
            .as_ref()
            .and_then(|health| health.backups.as_ref())
            .map(|backups| backups.json(backups_say.as_deref())),
        "claimed": claimed,
        "address": address,
        "port": state.port,
        "access": state.access.name(),
        "settings": if state.external { "external" } else { "managed" },
        "autostart": login,
        "log": tail,
    });
    out.report(&report, || {
        let word = match (running, &answered) {
            (false, _) => style::bad(Stream::Out, "not running"),
            (true, None) => style::bad(Stream::Out, "running, not answering"),
            (true, Some(health)) if health.is_ok() => {
                style::good(Stream::Out, "running and healthy")
            }
            (true, Some(health)) => style::bad(Stream::Out, &format!("running, {}", health.said())),
        };
        let mut text = format!(
            "{} {}: {word}\n  Runtime   {}\n  Address   {address}\n  Folder    {}\n  Owner     {}",
            state.name,
            release.as_deref().unwrap_or(&state.release),
            match &service_name {
                Some(name) => format!("native, {name}"),
                None => "Docker".to_string(),
            },
            folder.dir.display(),
            match claimed {
                Some(true) => "set up",
                Some(false) => "not set up yet: `marfa server install` prints the link",
                None => "unknown",
            },
        );
        if state.runtime == Runtime::Native || launchd::supported() {
            text.push_str(&format!("\n  Login     {login}"));
        }
        if let Some(say) = &backups_say {
            text.push_str(&format!("\n  Backups   {say}"));
        }
        if !tail.is_empty() {
            text.push_str(&format!("\n\nThe end of its log:\n{tail}"));
        }
        style::labelled(Stream::Out, &text)
    })
}

// ---- uninstall ----------------------------------------------------------

/// `data` must be a folder of its own, not a link to somewhere else.
fn own_data(folder: &Folder, state: &State) -> Result<(), CliError> {
    let data = native::Layout::new(&folder.dir).data();
    files::admit_folder(
        &folder.dir,
        state.manager == Some(Manager::SystemdSystem),
        super::account::lookup(super::account::NAME).map(|identity| identity.gid),
        true,
    )?;
    match std::fs::symlink_metadata(&data) {
        Ok(found) if found.is_dir() => Ok(()),
        Ok(_) => Err(CliError::Usage(format!(
            "{} is a link or a file, not the folder this install made: it is not deleted",
            data.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn uninstall(args: UninstallArgs, out: &Printer) -> Result<(), CliError> {
    let steps = Steps { quiet: out.json };
    let folder = Folder::new(&args.dir)?;
    let (state, _) = folder.require_state()?;
    let docker = Docker::new(!out.json);
    let service = match state.runtime {
        Runtime::Native => Some(service_of(&state, &folder, !out.json)?),
        Runtime::Docker => {
            docker.check()?;
            None
        }
    };
    // What is deleted is found to be this install's before anything is stopped.
    if args.delete_data && state.runtime == Runtime::Native {
        own_data(&folder, &state)?;
    }
    let volume = format!("{}-data", state.name);
    let net = format!("{}-net", state.name);
    let place = match state.runtime {
        Runtime::Native => format!("{}", native::Layout::new(&folder.dir).data().display()),
        Runtime::Docker => volume.clone(),
    };
    if args.delete_data && !args.yes {
        let prompter = Prompter::new(false);
        if !prompter.asking() {
            return Err(CliError::Usage(
                "--delete-data needs --yes when nothing can ask you".into(),
            ));
        }
        if state.external {
            eprintln!(
                "This deletes every item and file in {place}. {} is managed elsewhere and stays.",
                folder.path(files::SETTINGS).display()
            );
        } else {
            eprintln!(
                "This deletes every item and file in {place}, and the secrets in {}.",
                folder.path(files::SETTINGS).display()
            );
        }
        let typed = prompter.text(&format!("Type {} to confirm", state.name), None, "--yes")?;
        if typed != state.name {
            return Err(CliError::Usage("not confirmed; nothing was deleted".into()));
        }
    }
    steps.say(&format!("Stopping {}...", state.name));
    match &service {
        Some(service) => {
            service.off()?;
        }
        None => {
            // `down` needs the Compose file, so a missing one is written first.
            write_compose(&folder, &steps)?;
            docker.compose(&folder.dir, &["down"], false)?;
            docker.remove_container(&state.name)?;
            if launchd::installed(&state.name, &folder.dir).is_some() {
                launchd::off(&state.name, &folder.dir, !out.json)?;
            }
        }
    }
    let mut unserved = false;
    if state.access == Access::Tailscale {
        let https = state.https_port.unwrap_or(443);
        match tailscale::unserve(
            https,
            &format!("http://127.0.0.1:{}", state.port),
            !out.json,
        ) {
            Ok(done) => unserved = done,
            Err(error) => eprintln!(
                "The address stays on your tailnet: {error}. Remove it with `tailscale serve --https={https} off`."
            ),
        }
    }
    if args.delete_data {
        let mut names = vec![files::SETTINGS, files::UNCONFIRMED, files::DOTENV];
        match state.runtime {
            Runtime::Docker => {
                names.push(files::COMPOSE);
                docker.remove_volume(&volume)?;
                // A proxy of the person's may have joined the network.
                if let Err(error) = docker.remove_network(&net) {
                    eprintln!("The Docker network {net} stays: {error}");
                }
            }
            Runtime::Native => {
                if state.manager == Some(Manager::Launchd) {
                    launchd::remove_logs(&state.name);
                }
                let data = native::Layout::new(&folder.dir).data();
                match std::fs::remove_dir_all(&data) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(CliError::Io(std::io::Error::new(
                            error.kind(),
                            format!("cannot delete {}: {error}", data.display()),
                        )));
                    }
                }
            }
        }
        for name in names {
            if state.external && name == files::SETTINGS {
                continue;
            }
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
            if state.external {
                format!(
                    "Stopped {} and deleted its data. {} is managed elsewhere and stays.",
                    state.name,
                    folder.path(files::SETTINGS).display()
                )
            } else {
                format!("Stopped {} and deleted its data and settings.", state.name)
            }
        } else {
            format!(
                "Stopped {}. Its data stays in {place}, and its settings in {}; `marfa server install` starts it again.",
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
    fn the_last_update_the_log_reports_is_the_one_read() {
        let log = [
            r#"{"message":"Updated /d/marfa.db, keeping a copy at /a","schema_from":3,"schema_to":4,"backup_path":"/a"}"#,
            "not json",
            r#"{"message":"Updated /d/marfa.db, keeping a copy at /b","schema_from":4,"schema_to":5,"backup_path":"/b"}"#,
            r#"{"message":"Listening"}"#,
        ]
        .join("\n");
        let update = database_update(&log).unwrap();
        assert_eq!(
            (update.schema_from, update.schema_to, update.copy.as_str()),
            (4, 5, "/b")
        );
        assert!(database_update("{}").is_none());
    }

    #[test]
    fn a_refused_update_says_to_stop_the_idle_service_before_starting_it_again() {
        let note = refused_update_note("0.0.71", "0.0.70", Path::new("/srv/marfa one"));
        let stop = note
            .find("`marfa server stop --dir '/srv/marfa one'`")
            .unwrap();
        let install = note.find("install 0.0.70 again").unwrap();
        let start = note
            .find("`marfa server start --dir '/srv/marfa one'`")
            .unwrap();
        assert!(stop < install && install < start, "{note}");
    }
}

//! `marfa server upgrade`, `start`, `stop`, `restart`, `status` and `uninstall`.

use std::path::Path;

use marfa_rules::server_log::{
    DatabaseUpgrade, RefusedUpgrade, UpgradeRefusal, last_upgrade, refused_upgrade,
};
use marfa_rules::update_record::{release_record, served_release};
use serde_json::{Value, json};

use super::backups;
use super::docker::{self, Docker};
use super::install::{Watch, wait_until_healthy, write_compose};
use super::prompt::Prompter;
use super::run::{self, OWN, REFUSED_DATABASE};
use super::service::{Control, Manager, Service};
use super::{
    Access, DirArgs, Folder, IMAGE, PrivateCommand, Runtime, StartArgs, State, Steps,
    UninstallArgs, UpgradeArgs, checked_release, files, health_url, http_agent, launchd,
    moved_only_by_upgrade, native, own_release, parse_release, shell_word, tailscale,
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
    let target = OWN.to_string();
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
    let server = run::locate(Some(&folder.dir))?;
    let binary = native::stable_binary_of_this()?;
    let serviced = service.release();
    let running = running_release(state.port);
    let from = install_release(folder, running.clone()).ok();
    let on_target = from.as_deref() == Some(target.as_str());
    // The server running on the database is the one release known to open it; any other start
    // is asked first.
    let moves = running.as_deref() != Some(target.as_str());
    if moves {
        let settings = folder.read(files::SETTINGS)?.unwrap_or_default();
        let environment = native::environment(&folder.dir, state.port, &settings);
        let database = native::Layout::new(&folder.dir).database();
        if let Some(said) = run::will_not_open(&server, &database, &environment) {
            return Err(CliError::Install(cannot_open(
                &target,
                from.as_deref(),
                serviced.as_deref().ok() == Some(target.as_str()) && !on_target,
                &said,
                &service.program().unwrap_or(binary),
                &folder.dir,
            )));
        }
        steps.say(&format!(
            "If {target} has a newer database schema, the server copies the database beside it, when it holds data, and then updates it in place."
        ));
        folder.forget_applied(dotenv, files::kept_for(state.manager).dotenv)?;
    }
    let mark = service.mark();
    // A new release may keep the same service definition.
    let started = service.on(state.autostart, moves, &binary, &server)?;
    let watch = Watch::Process {
        service: &service,
        mark,
    };
    if let Err(error) = wait_until_healthy(&watch, state.port, args.wait) {
        let note = match (moves, watch.log(40).as_deref().and_then(refused_update)) {
            (true, Some(refusal)) if !on_target => {
                refusal.note(&target, from.as_deref(), &binary, &folder.dir)
            }
            _ => return Err(error),
        };
        return Err(CliError::Install(format!("{error}\n\n{note}")));
    }
    if moves {
        if !out.json {
            started.say_unconfirmed(state.port);
        }
        // Earlier releases' `marfa` reads the release here, and cannot run the service without
        // it, so it is written only once the target runs: an owner who puts the earlier release
        // back after a refusal finds the line as that release left it.
        dotenv.set("MARFA_RELEASE", &target)?;
        let kept = files::kept_for(state.manager).dotenv;
        if started.confirmed() {
            folder.keep_applied(dotenv, &folder.applied(state.port, &target)?, kept)?;
        } else {
            folder.forget_applied(dotenv, kept)?;
        }
    }
    let changed = !on_target;
    let update = native_update(&watch, &service, &target);
    let report = json!({
        "name": state.name,
        "from": from,
        "release": target,
        "runtime": "native",
        "changed": changed,
        "database_update": update.json(),
        "log_read": update.read(),
    });
    out.report(&report, |_| {
        let moved = match (changed, &from) {
            // The programs were already the target's, and its server was not running.
            (false, _) if moves => format!("Started {target}, which this install is on."),
            (false, _) => format!("Already on {target}."),
            (true, Some(from)) => format!("Upgraded from {from} to {target}."),
            (true, None) => format!("Upgraded to {target}."),
        };
        match update.words(None) {
            Some(words) => format!("{moved} {words}"),
            None => moved,
        }
    })
}

/// The release the server answering on `port` says it is, while one answers.
fn running_release(port: u16) -> Option<String> {
    http_agent(port)
        .get(&format!("http://127.0.0.1:{port}/"))
        .call()
        .ok()
        .and_then(|mut response| response.body_mut().read_json::<Value>().ok())
        .and_then(|body| body["version"].as_str().map(str::to_string))
}

/// The release a native install is on: the one serving it, `running`, else the one that last
/// served its database. `Err` says why it cannot be told. The `MARFA_RELEASE` line in `.env` is
/// no source: `marfa` and `marfa-server` up to 0.0.85 do not keep it up to date when they update
/// themselves, so it may name an earlier release than the one that last served.
pub(super) fn install_release(folder: &Folder, running: Option<String>) -> Result<String, String> {
    if let Some(running) = running {
        return Ok(running);
    }
    let database = native::Layout::new(&folder.dir).database();
    match served_release(&database) {
        Ok(Some(served)) => Ok(served),
        Ok(None) => Err(format!(
            "{} does not exist: a release up to 0.0.85 last served the database, and those write none",
            release_record(&database).display()
        )),
        Err(error) => Err(format!(
            "{} cannot be read: {error}",
            release_record(&database).display()
        )),
    }
}

/// Why `target` was not started on the install. When the programs the service runs, `program`,
/// are already `target`'s, the next start of the service, such as at the next boot, would meet
/// the same refusal, so `from` is put back first. When `target` is the release the install is
/// on, there is nothing to go back to or move to.
fn cannot_open(
    target: &str,
    from: Option<&str>,
    replaced: bool,
    said: &str,
    program: &Path,
    dir: &Path,
) -> String {
    let said = match said.is_empty() {
        true => String::new(),
        false => format!(" It says: {said}"),
    };
    let which = from.unwrap_or("the release it ran before");
    let mut text = format!(
        "{target} will not run on this install's settings and database, so nothing was changed: the service and the database stay as they were.{said}"
    );
    if replaced {
        text.push_str(&format!(
            "\n\nThe programs the service runs, in {}, are already {target}, so the server will refuse to start the next time it starts, such as when this machine restarts. {}",
            program.parent().unwrap_or(program).display(),
            put_back(from, program, dir)
        ));
    }
    if from != Some(target) {
        text.push_str(&format!(
            "\n\nTo move to {target}, export the data with `marfa export` while {which} runs, make a new install of {target} in another --dir, and restore the archive there with `marfa restore`."
        ));
    }
    text
}

const INSTALL_SCRIPT: &str =
    "https://raw.githubusercontent.com/withmarfa/marfa/main/scripts/install.sh";

/// How to put `from` back once the programs the service runs, `program`, are another release's:
/// install it the way marfa was installed, then move the install to it with that release's
/// `marfa server upgrade`, which asks it first whether it opens the database.
fn put_back(from: Option<&str>, program: &Path, dir: &Path) -> String {
    let real = std::fs::canonicalize(program)
        .or_else(|_| std::env::current_exe().and_then(std::fs::canonicalize));
    put_back_by(
        from,
        program,
        real.is_ok_and(|real| native::from_homebrew(&real)),
        dir,
    )
}

/// Homebrew installs only its newest release, so an earlier one comes from the install script,
/// in its own folder.
fn put_back_by(from: Option<&str>, program: &Path, homebrew: bool, dir: &Path) -> String {
    let dir = shell_word(dir);
    let Some(from) = from else {
        return format!(
            "The release that last ran on this install cannot be told, so none is named here. To put it back, install it the way you installed marfa, then run `marfa server restart --dir {dir}` with that release's marfa. Releases up to 0.0.85 have no `marfa server upgrade` that goes back, and their server refuses a database it cannot read, changing nothing in it. A later release goes back with `marfa server upgrade --dir {dir}` instead."
        );
    };
    let (which, version) = (from, from);
    let how = if homebrew {
        format!(
            "Homebrew installs only its newest release, so install {which} with the install script, which puts it in ~/.local/bin: `curl -fsSL {INSTALL_SCRIPT} | MARFA_VERSION={version} sh`, then run `~/.local/bin/marfa server upgrade --dir {dir}`."
        )
    } else {
        let programs = shell_word(program.parent().unwrap_or(program));
        format!(
            "The install script puts it back where the service runs it: `curl -fsSL {INSTALL_SCRIPT} | MARFA_VERSION={version} MARFA_INSTALL_DIR={programs} sh`, then run `{programs}/marfa server upgrade --dir {dir}`."
        )
    };
    format!(
        "To put {which} back, install it the way you installed marfa, then run `marfa server upgrade --dir {dir}` with that release's marfa. {how}"
    )
}

/// What a native start's log says of the database update. A run after one whose wait ended
/// early can find the update made by then, so its start, if it made one, logged nothing of it:
/// the update is then looked for further back, among the lines of the release being installed.
fn native_update(watch: &Watch, service: &Service, target: &str) -> Update {
    let Some(log) = watch.log(2000) else {
        return Update::Unread;
    };
    if let Some(update) = last_upgrade(&log, None) {
        return Update::Made {
            update,
            earlier: false,
        };
    }
    match service.log_held(5000) {
        None => Update::Unread,
        Some(held) => match last_upgrade(&held, Some(target)) {
            Some(update) => Update::Made {
                update,
                earlier: true,
            },
            None => Update::Unknown,
        },
    }
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
    let docker = Docker::new(!out.json);
    docker.check()?;
    let from = state.image();
    let unchanged = target == from;
    if !unchanged && parse_release(&target) < parse_release(docker::FIRST_ASKED) {
        return Err(CliError::Install(format!(
            "{target} cannot say whether it opens this install's database, because only releases from {} answer that, so nothing was changed: the container and the database stay on {from}.\n\nTo move to {target}, export the data with `marfa export` while {from} runs, make a new install with `--release {target}` in another --dir, and restore the archive there with `marfa restore`.",
            docker::FIRST_ASKED
        )));
    }
    if !unchanged {
        // A release that does not exist is found before it is written down, or no later upgrade
        // could name a real one.
        let image = format!("{IMAGE}:{target}");
        if !docker.image_present(&image)? {
            docker.release_exists(IMAGE, &target)?;
            steps.say(&format!("Pulling {image}..."));
            docker.pull(&image)?;
        }
        let settings = folder.read(files::SETTINGS)?.unwrap_or_default();
        let volume = format!("{}-data", state.name);
        if let Some(said) = docker.will_not_open(&image, &volume, &settings.entries()) {
            let said = match said.is_empty() {
                true => String::new(),
                false => format!(" It says: {said}"),
            };
            return Err(CliError::Install(format!(
                "{target} will not run on this install's settings and database, so nothing was changed: the container and the database stay on {from}.{said}\n\nTo move to {target}, export the data with `marfa export` while {from} runs, make a new install with `--release {target}` in another --dir, and restore the archive there with `marfa restore`."
            )));
        }
        steps.say(&format!(
            "If {target} has a newer database schema, the server copies the database beside it, when it holds data, and then updates it in place."
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
        let refusal = match (unchanged, watch.log(40).as_deref().and_then(refused_update)) {
            (false, Some(refusal)) => refusal,
            _ => return Err(error),
        };
        let back = put_back_docker(&docker, folder, state, dotenv, steps, args.wait);
        let back = match back {
            Ok(()) => format!("so {from} was put back and runs"),
            Err(failed) => format!(
                "so {from} still reads it, but putting {from} back failed: {failed}. `marfa server upgrade --release {from} --dir {}` puts it back",
                shell_word(&folder.dir)
            ),
        };
        return Err(CliError::Install(format!(
            "{error}\n\n{target} {} A refused update leaves the database as it was, {back}. To move to {target}, export the data with `marfa export`, make a new install with `--release {target}` in another --dir, and restore the archive there with `marfa restore`.",
            refusal.words(),
        )));
    }
    // A retry finds the env file already on the target and the container running, though the
    // update happened after the first run's wait ended, so the log of the container's current
    // run is read whole, since requests since then would push the line out of a tail.
    let update = match docker.run_log(&state.name, None) {
        None => Update::Unread,
        Some(log) => match last_upgrade(&log, None) {
            Some(update) => Update::Made {
                update,
                earlier: false,
            },
            None => Update::Unknown,
        },
    };
    let report = json!({
        "name": state.name,
        "from": from,
        "release": target,
        "runtime": "docker",
        "changed": !unchanged,
        "database_update": update.json(),
        "log_read": update.read(),
    });
    out.report(&report, |_| {
        let moved = if unchanged {
            format!("Already on {target}.")
        } else {
            format!("Upgraded from {from} to {target}.")
        };
        match update.words(Some(&state.name)) {
            Some(words) => format!("{moved} {words}"),
            None => moved,
        }
    })
}

/// Starts the release the install ran before an upgrade the new release refused.
fn put_back_docker(
    docker: &Docker,
    folder: &Folder,
    state: &State,
    dotenv: &mut super::envfile::EnvFile,
    steps: &Steps,
    wait: u64,
) -> Result<(), CliError> {
    dotenv.set("MARFA_RELEASE", state.image())?;
    files::write_if_changed(
        &folder.path(files::DOTENV),
        &dotenv.render(),
        files::Perms::READABLE,
    )?;
    write_compose(folder, steps)?;
    super::install::start(docker, &folder.dir, &state.name, state.image(), steps)?;
    wait_until_healthy(
        &Watch::Container {
            docker,
            name: &state.name,
        },
        state.port,
        wait,
    )
}

/// What the server's log says of the update it made to the database.
enum Update {
    /// The server updated the database, on this start or, when `earlier`, on one before it.
    Made {
        update: DatabaseUpgrade,
        earlier: bool,
    },
    /// The log was read and records no update.
    Unknown,
    /// The log could not be read.
    Unread,
}

impl Update {
    fn json(&self) -> Value {
        match self {
            Update::Made { update, earlier } => json!({
                "schema_from": update.from,
                "schema_to": update.to,
                "copy": update.copy,
                "earlier_start": earlier,
            }),
            Update::Unknown | Update::Unread => Value::Null,
        }
    }

    /// Whether the log could be read: a `null` update from a log that was not read says nothing
    /// of whether the database was updated.
    fn read(&self) -> bool {
        !matches!(self, Update::Unread)
    }

    /// What the owner is told of the update the server made to the database. A Docker install
    /// names its container, since the copy is in that container's volume.
    fn words(&self, container: Option<&str>) -> Option<String> {
        let (update, earlier) = match self {
            Update::Made { update, earlier } => (update, *earlier),
            Update::Unknown => return None,
            Update::Unread => {
                return Some(
                    "The log could not be read, so whether the server updated the database, and kept a copy, is not known."
                        .to_string(),
                );
            }
        };
        let moved = format!(
            "{} the database from schema version {} to {}.",
            if earlier {
                "An earlier start of this release, before this run, updated"
            } else {
                "The server updated"
            },
            update.from,
            update.to
        );
        let Some(copy) = &update.copy else {
            return Some(format!(
                "{moved} The database held no data, so no copy was made."
            ));
        };
        Some(match container {
            Some(name) => format!(
                "{moved} It first copied the database to {copy} in the volume {name}-data, and the next update of the database replaces that copy; `docker cp {name}:{copy} .` copies it out."
            ),
            None => format!(
                "{moved} It first copied the database to {copy}, and the next update of the database replaces that copy."
            ),
        })
    }
}

/// A start of the new release that stopped before it changed the database.
pub(super) enum Refusal {
    /// The database is one this release will not run on.
    Database,
    /// The server declined to update the database and says why.
    Upgrade(RefusedUpgrade),
}

/// The refusal a log, read from this start only, ends on.
pub(super) fn refused_update(log: &str) -> Option<Refusal> {
    if log.contains(REFUSED_DATABASE) {
        return Some(Refusal::Database);
    }
    refused_upgrade(log).map(Refusal::Upgrade)
}

impl Refusal {
    pub(super) fn words(&self) -> String {
        match self {
            Refusal::Database => {
                "did not update the database, and the server says why above.".to_string()
            }
            Refusal::Upgrade(refused) => {
                let cause = match refused.refusal {
                    UpgradeRefusal::CopyNotMade => "the copy kept first could not be made",
                    UpgradeRefusal::SettingsUnreadable => {
                        "the settings stored in the database could not be used"
                    }
                };
                format!(
                    "did not update the database, because {cause}: {}",
                    refused.error
                )
            }
        }
    }

    /// What to do after a native start of `target`, which the service now runs as `program`,
    /// refused the database that `from` reads. The idle supervisor must stop before the earlier
    /// release can start.
    fn note(&self, target: &str, from: Option<&str>, program: &Path, dir: &Path) -> String {
        let after = match self {
            Refusal::Database => "The service stays up and idle after a refusal".to_string(),
            Refusal::Upgrade(_) => format!("The service keeps trying to start {target}"),
        };
        format!(
            "{target} {} A refused update leaves the database as it was, so {} still reads it. {after}, so run `marfa server stop --dir {}` first. {}",
            self.words(),
            from.unwrap_or("the release it ran before"),
            shell_word(dir),
            put_back(from, program, dir),
        )
    }
}

// ---- start and stop -----------------------------------------------------

pub fn start(args: StartArgs, out: &Printer) -> Result<(), CliError> {
    let (json, text) = started(args, out)?;
    out.report(&json, |_| text)
}

fn started(args: StartArgs, out: &Printer) -> Result<(Value, String), CliError> {
    let steps = Steps { quiet: out.json };
    let folder = Folder::new(&args.dir)?;
    let (state, mut dotenv) = folder.require_state()?;
    let release = match state.runtime {
        Runtime::Native => {
            let service = service_of(&state, &folder, !out.json)?;
            if !service.exists() {
                return Err(CliError::Usage(format!(
                    "{} does not exist: `marfa server install` makes it",
                    service.describe()
                )));
            }
            let server = run::locate(Some(&folder.dir))?;
            let release = keeps_release(&folder, &service, &state)?;
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
                    &folder.applied(state.port, &release)?,
                    files::kept_for(state.manager).dotenv,
                )?;
            }
            release
        }
        Runtime::Docker => {
            let docker = Docker::new(!out.json);
            steps.say("Checking Docker...");
            docker::ensure_engine(&docker, args.wait, !out.json)?;
            docker.check()?;
            super::install::start(&docker, &folder.dir, &state.name, state.image(), &steps)?;
            wait_until_healthy(
                &Watch::Container {
                    docker: &docker,
                    name: &state.name,
                },
                state.port,
                args.wait,
            )?;
            state.image().to_string()
        }
    };
    Ok((
        json!({ "name": state.name, "release": release, "running": true }),
        format!("{} {release} is running.", state.name),
    ))
}

pub fn stop(args: DirArgs, out: &Printer) -> Result<(), CliError> {
    let (json, text) = stopped(args, out)?;
    out.report(&json, |_| text)
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

/// The release a native install runs, when a start, restart or install by this `marfa` keeps it
/// there: only `marfa server upgrade` moves an install, after asking the release it moves to
/// whether it opens the database. A start names this `marfa` in the service, and a restart
/// starts the programs the service names, which may have been replaced while the install was
/// on an earlier release, running or stopped. An install trying an update runs either release
/// of it.
pub(super) fn keeps_release(
    folder: &Folder,
    service: &Service,
    state: &State,
) -> Result<String, CliError> {
    let upgrade = format!("marfa server upgrade --dir {}", shell_word(&folder.dir));
    let serviced = service.release().map_err(|why| {
        CliError::Usage(format!(
            "the release this install runs cannot be told, because {why}: `{upgrade}` moves it to {OWN}, once {OWN} has said it opens the database"
        ))
    })?;
    if run::trying_update(&folder.dir, &serviced) {
        return Ok(serviced);
    }
    if serviced != OWN {
        return Err(moved_only_by_upgrade(
            &serviced,
            "this marfa is",
            OWN,
            &upgrade,
        ));
    }
    let on = install_release(folder, running_release(state.port)).map_err(|why| {
        CliError::Usage(format!(
            "the release this install is on cannot be told, because {why}: `{upgrade}` moves it to {serviced}, once {serviced} has said it opens the database"
        ))
    })?;
    if on != serviced {
        return Err(CliError::Usage(format!(
            "this install is on {on}, and the programs its service runs are now {serviced}: `{upgrade}` moves it to {serviced}, once {serviced} has said it opens the database"
        )));
    }
    Ok(serviced)
}

/// One document in JSON, `stopped` and `started`, so a strict parser reads it.
pub fn restart(args: StartArgs, out: &Printer) -> Result<(), CliError> {
    let folder = Folder::new(&args.dir)?;
    let (state, _) = folder.require_state()?;
    if state.runtime == Runtime::Native {
        let service = service_of(&state, &folder, false)?;
        if service.exists() {
            keeps_release(&folder, &service, &state)?;
        }
    }
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
    out.report(&json!({ "stopped": stopped, "started": started }), |_| text)
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
        let mut response = agent.get(&health_url(port)).call().ok()?;
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
    let agent = http_agent(state.port);
    let answered = if running {
        Health::ask(&agent, state.port)
    } else {
        None
    };
    let answering = answered.is_some();
    let healthy = answered.as_ref().is_some_and(Health::is_ok);
    let release = if answering {
        running_release(state.port)
    } else {
        None
    };
    let installed = match &service {
        Some(_) => install_release(&folder, release.clone()),
        None => Ok(state.image().to_string()),
    };
    // Programs replaced while the install was on another release wait for `upgrade`.
    let waiting = service
        .as_ref()
        .and_then(|service| service.release().ok())
        .filter(|programs| {
            installed.as_ref().is_ok_and(|on| on != programs)
                && !run::trying_update(&folder.dir, programs)
        });
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
    let private = PrivateCommand::of(&state, &folder);
    let backups_say = answered
        .as_ref()
        .and_then(|health| health.backups.as_ref())
        .and_then(|backups| backups.words(state.runtime == Runtime::Docker, private.as_ref()));
    let report = json!({
        "dir": folder.dir,
        "name": state.name,
        "runtime": state.runtime.name(),
        "release": installed.as_ref().ok(),
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
    out.report(&report, |_| {
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
            release
                .as_deref()
                .or(installed.as_deref().ok())
                .unwrap_or("of a release that cannot be told"),
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
        if let Err(why) = &installed {
            text.push_str(&format!("\n  Release   cannot be told: {why}"));
            if let (Some(recorded), true) = (&state.release, service.is_some()) {
                text.push_str(&format!(
                    "\n  Recorded  {recorded} in .env, which releases up to 0.0.85 write at install only, so it may not be the release that last ran"
                ));
            }
        }
        if let Some(programs) = &waiting {
            text.push_str(&format!(
                "\n  Programs  {programs}: `marfa server upgrade --dir {}` moves the install to {programs}, once {programs} has said it opens the database",
                shell_word(&folder.dir)
            ));
        }
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
            crate::errln!(
                "This deletes every item and file in {place}. {} is managed elsewhere and stays.",
                folder.path(files::SETTINGS).display()
            );
        } else {
            crate::errln!(
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
            Err(error) => crate::errln!(
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
                    crate::errln!("The Docker network {net} stays: {error}");
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
    out.report(&report, |_| {
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

    fn made(copy: Option<&str>, earlier: bool) -> Update {
        Update::Made {
            update: DatabaseUpgrade {
                from: 1,
                to: 2,
                copy: copy.map(str::to_string),
            },
            earlier,
        }
    }

    fn update_words(update: &Update, container: Option<&str>) -> String {
        update.words(container).unwrap()
    }

    #[test]
    fn an_update_names_its_copy_and_says_the_next_update_replaces_it() {
        let words = update_words(&made(Some("/d/marfa.db.before-upgrade"), false), None);
        assert!(words.contains("from schema version 1 to 2"), "{words}");
        assert!(words.contains("/d/marfa.db.before-upgrade"), "{words}");
        assert!(
            words.contains("next update of the database replaces that copy"),
            "{words}"
        );
        let docker = update_words(
            &made(Some("/data/marfa.db.before-upgrade"), false),
            Some("marfa"),
        );
        assert!(docker.contains("the volume marfa-data"), "{docker}");
        assert!(
            docker.contains("docker cp marfa:/data/marfa.db.before-upgrade ."),
            "{docker}"
        );
    }

    #[test]
    fn an_update_from_an_earlier_start_says_so_and_an_unread_log_claims_nothing() {
        let words = update_words(&made(Some("/d/marfa.db.before-upgrade"), true), None);
        assert!(words.contains("An earlier start"), "{words}");
        assert!(words.contains("/d/marfa.db.before-upgrade"), "{words}");
        let unread = update_words(&Update::Unread, None);
        assert!(unread.contains("log could not be read"), "{unread}");
        assert!(!unread.contains("no copy was made"), "{unread}");
        assert!(Update::Unknown.words(None).is_none());
        assert_eq!(Update::Unread.json(), Value::Null);
        assert!(!Update::Unread.read() && Update::Unknown.read());
    }

    #[test]
    fn an_update_of_an_empty_database_says_no_copy_was_made() {
        let words = update_words(&made(None, false), None);
        assert!(words.contains("no copy was made"), "{words}");
        assert!(!words.contains("replaces"), "{words}");
    }

    #[test]
    fn a_refusal_is_read_from_the_field_the_server_names_it_in() {
        use marfa_rules::server_log::{ERROR, REFUSED, START_FAILED};
        let line = |refusal: Option<UpgradeRefusal>, error: &str| {
            let mut line = serde_json::json!({ "message": START_FAILED, ERROR: error });
            if let Some(refusal) = refusal {
                line[REFUSED] = refusal.name().into();
            }
            line.to_string()
        };
        let copy = line(Some(UpgradeRefusal::CopyNotMade), "no space");
        let words = refused_update(&copy).unwrap().words();
        assert!(
            words.contains("because the copy kept first could not be made: no space"),
            "{words}"
        );
        let settings = line(
            Some(UpgradeRefusal::SettingsUnreadable),
            "reserve is not a number",
        );
        let words = refused_update(&settings).unwrap().words();
        assert!(
            words.contains("because the settings stored in the database could not be used"),
            "{words}"
        );
        assert!(!words.contains("copy kept"), "{words}");
        // Witness: prose that reads like a refusal, on a line that does not name one, is none.
        let port = line(None, "was not upgraded. Nothing was changed.");
        assert!(refused_update(&port).is_none());
        assert!(matches!(
            refused_update("marfa-server will not start on the database (exit status 78)"),
            Some(Refusal::Database)
        ));
    }

    #[test]
    fn a_refused_update_says_to_stop_the_idle_service_and_put_the_earlier_release_back() {
        let note = Refusal::Database.note(
            "0.0.71",
            Some("0.0.70"),
            Path::new("/opt/marfa/bin/marfa"),
            Path::new("/srv/marfa one"),
        );
        let stop = note
            .find("`marfa server stop --dir '/srv/marfa one'`")
            .unwrap();
        let back = note.find("To put 0.0.70 back").unwrap();
        let upgrade = note
            .find("`'/opt/marfa/bin'/marfa server upgrade --dir '/srv/marfa one'`")
            .unwrap();
        assert!(stop < back && back < upgrade, "{note}");
        assert!(!note.contains("marfa server start"), "{note}");
    }

    #[test]
    fn putting_an_earlier_release_back_names_the_folder_only_outside_homebrew() {
        let dir = Path::new("/srv/marfa");
        // The install script's folder, and a folder the programs were copied into by hand: the
        // install script puts the programs back there.
        for programs in ["/home/someone/.local/bin", "/usr/local/bin"] {
            let program = Path::new(programs).join("marfa");
            let words = put_back_by(Some("0.0.80"), &program, false, dir);
            assert!(
                words.contains(&format!(
                    "MARFA_VERSION=0.0.80 MARFA_INSTALL_DIR='{programs}' sh"
                )) && words.contains(&format!(
                    "`'{programs}'/marfa server upgrade --dir '/srv/marfa'`"
                )),
                "{words}"
            );
        }
        // Homebrew's own folder is never written into, and it keeps only its newest release.
        let words = put_back_by(
            Some("0.0.80"),
            Path::new("/opt/homebrew/bin/marfa"),
            true,
            dir,
        );
        assert!(
            words.contains("Homebrew installs only its newest release")
                && words.contains("| MARFA_VERSION=0.0.80 sh`")
                && words.contains("`~/.local/bin/marfa server upgrade --dir '/srv/marfa'`"),
            "{words}"
        );
        assert!(!words.contains("MARFA_INSTALL_DIR"), "{words}");
        assert!(!words.contains("/opt/homebrew"), "{words}");
        // A release that cannot be told is named nowhere, and no value is given to install by.
        let words = put_back_by(None, Path::new("/usr/local/bin/marfa"), false, dir);
        assert!(
            words.contains("The release that last ran on this install cannot be told")
                && words.contains("`marfa server restart --dir '/srv/marfa'`")
                && !words.contains("MARFA_VERSION")
                && !words.contains("<release>"),
            "{words}"
        );
    }

    #[test]
    fn a_program_homebrew_installed_is_told_from_one_installed_another_way() {
        assert!(native::from_homebrew(Path::new(
            "/opt/homebrew/Cellar/marfa/0.0.80/bin/marfa"
        )));
        assert!(!native::from_homebrew(Path::new("/usr/local/bin/marfa")));
        assert!(!native::from_homebrew(Path::new(
            "/home/someone/.local/bin/marfa"
        )));
    }
}

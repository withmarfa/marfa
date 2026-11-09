//! `marfa server install`.

use std::path::Path;
use std::time::{Duration, Instant};

use clap::ValueEnum;
use serde_json::json;

use super::docker::Docker;
use super::envfile::{self, EnvFile};
use super::prompt::Prompter;
use super::run::{self, REFUSED_DATABASE};
use super::service::{Control, Manager, Mark, Service};
use super::systemd::Linger;
use super::{
    AGENT_HINT, Access, DEFAULT_PORT, Folder, IMAGE, InstallArgs, OPTIONS_HINT, Runtime, State,
    Steps, account, address, checked_release, external_problems, files, free_port, http_agent,
    launchd, local_address, names, native, own_release, port_is_free, proxy_trust, public_address,
    refuse_older, tailscale, valid_name,
};
use crate::error::CliError;
use crate::output::Printer;
use crate::style::{self, Stream};

pub fn install(args: InstallArgs, out: &Printer) -> Result<(), CliError> {
    let steps = Steps { quiet: out.json };
    let folder = Folder::new(&args.dir)?;
    let docker = Docker::new(!out.json);
    let prompter = Prompter::new(args.yes);
    let existing = folder.state()?;
    if prompter.asking()
        && existing.is_none()
        && args.dir.dir.is_none()
        && args.name.is_none()
        && args.port.is_none()
        && !args.external_settings
        && !args.docker
    {
        eprintln!("{OPTIONS_HINT}\n");
    }
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

    let runtime = match (
        args.docker,
        existing.as_ref().map(|(state, _)| state.runtime),
    ) {
        (true, Some(Runtime::Native)) => {
            return Err(CliError::Usage(format!(
                "{dir} is a native install, and an install keeps its runtime, because its data is in {dir}/data and a Docker install keeps it in a volume. To move to Docker, export the data with `marfa export`, install with --docker in another --dir, and restore the archive into it",
                dir = folder.dir.display()
            )));
        }
        (true, _) => Runtime::Docker,
        (false, Some(runtime)) => runtime,
        (false, None) => Runtime::Native,
    };

    let release = match runtime {
        Runtime::Native => native_release(&args, existing.as_ref().map(|(state, _)| state))?,
        Runtime::Docker => match (&args.release, &existing) {
            (Some(release), Some((state, _))) => {
                let release = checked_release(release)?;
                refuse_older(&state.release, &release)?;
                release
            }
            (Some(release), None) => checked_release(release)?,
            (None, Some((state, _))) => state.release.clone(),
            (None, None) => own_release().ok_or_else(|| {
                CliError::Usage("this build is not a release, so it names no image: pass --release, such as --release 0.0.22".into())
            })?,
        },
    };

    // The service manager, and what it needs, are found before anything is
    // changed.
    let manager = match (runtime, &existing) {
        (Runtime::Docker, _) => None,
        (Runtime::Native, Some((state, _))) => {
            let manager = state.manager.expect("a native install records its service");
            manager.check_account()?;
            Some(manager)
        }
        (Runtime::Native, None) => Some(Manager::here()?),
    };
    let root_install = manager == Some(Manager::SystemdSystem);
    if root_install {
        account::check_group()?;
    }
    files::admit_folder(
        &folder.dir,
        root_install,
        account::lookup(account::NAME).map(|identity| identity.gid),
        runtime == Runtime::Native,
    )?;
    let native_server = match runtime {
        Runtime::Docker => {
            steps.say("Checking Docker...");
            docker.check()?;
            None
        }
        Runtime::Native => {
            steps.say("Checking the server program...");
            native::Layout::new(&folder.dir).check_socket()?;
            if manager == Some(Manager::SystemdUser) {
                super::systemd::user_session()?;
            }
            Some(run::locate()?)
        }
    };

    let net = format!("{name}-net");
    let volume = format!("{name}-data");
    let settings_path = folder.path(files::SETTINGS);
    let have_secrets = folder.read(files::SETTINGS)?;
    if runtime == Runtime::Native
        && let Some(file) = &have_secrets
    {
        native::refuse_folder_settings(file, &settings_path)?;
    }
    if external && have_secrets.is_none() {
        return Err(CliError::Usage(format!(
            "{} does not exist, and this install takes its settings from there: write it first",
            settings_path.display()
        )));
    }
    let layout = native::Layout::new(&folder.dir);
    let data_exists = match runtime {
        Runtime::Docker => docker.volume_exists(&volume)?,
        Runtime::Native => layout.database().exists(),
    };
    let data_place = match runtime {
        Runtime::Docker => format!("the Docker volume {volume}"),
        Runtime::Native => format!("the database {}", layout.database().display()),
    };
    if existing.is_none() {
        match (runtime, manager) {
            (Runtime::Docker, _) => {
                // A server this command did not make, on the name it would use.
                if docker.container(&name)?.is_some() {
                    return Err(CliError::Usage(format!(
                        "a container named {name} already exists, and no install in {} made it: choose another --name, or remove it with `docker rm -f {name}`",
                        folder.dir.display()
                    )));
                }
            }
            (Runtime::Native, Some(manager)) => {
                let service = Service {
                    manager,
                    name: &name,
                    dir: &folder.dir,
                    trace: false,
                };
                if service.exists() {
                    return Err(CliError::Usage(format!(
                        "{} already exists, and no install in {} made it: choose another --name",
                        service.describe(),
                        folder.dir.display()
                    )));
                }
            }
            (Runtime::Native, None) => {}
        }
        if have_secrets.is_none() && data_exists {
            return Err(CliError::Usage(format!(
                "{data_place} already holds data, and its secrets are not in {}: this command would start the data on new secrets and every key would stop working. Restore marfa.env from your copy into the folder, or choose another --name",
                folder.dir.display()
            )));
        }
    } else if have_secrets.is_none() && data_exists {
        return Err(CliError::Usage(format!(
            "{} is missing, and {data_place} exists: restore marfa.env from your copy. A new one would make every key stop working",
            settings_path.display()
        )));
    }

    // A settings file that lacks a secret is never completed over data that
    // exists, because a new secret would make every key stop working.
    if !external && let Some(file) = &have_secrets {
        for secret in names::SECRETS {
            if file.get(secret).is_none_or(|value| value.is_empty())
                && (existing.is_some() || data_exists)
            {
                return Err(CliError::Usage(format!(
                    "{secret} is missing or empty in {}, and this install has data: restore the setting from your copy. A new one would make every key stop working",
                    settings_path.display()
                )));
            }
        }
    }

    // The port.
    let port = match (&existing, args.port) {
        (Some((state, _)), None) => state.port,
        (Some((state, _)), Some(port)) if port == state.port => port,
        (_, Some(port)) => {
            if let Err(error) = port_is_free(port) {
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
    // Docker's fallback uses the container port, not the published port.
    let sign_in: Option<String> = match access {
        Access::Local => {
            if args.address.is_some() {
                return Err(CliError::Usage(
                    "--address is for tailscale, cloudflare and proxy: a local server is at http://localhost".into(),
                ));
            }
            match runtime {
                Runtime::Native => None,
                Runtime::Docker => Some(local_address(port)),
            }
        }
        Access::Tailscale => Some(match &args.address {
            Some(address) => public_address(address)?,
            None => {
                let dns = tailscale::dns_name()?;
                match https_port {
                    Some(443) | None => format!("https://{dns}"),
                    Some(other) => format!("https://{dns}:{other}"),
                }
            }
        }),
        Access::Cloudflare | Access::Proxy => {
            if prompter.asking() && args.address.is_none() {
                eprintln!(
                    "Point your {} at {} on this machine.",
                    if access == Access::Cloudflare {
                        "Cloudflare Tunnel"
                    } else {
                        "proxy"
                    },
                    local_address(port)
                );
            }
            let raw = match (
                &args.address,
                existing.as_ref().and_then(|(s, _)| s.address.clone()),
            ) {
                (Some(address), _) => address.clone(),
                (None, Some(address)) => address,
                (None, None) => prompter.text(
                    "Address devices will use, such as https://marfa.example.com",
                    None,
                    "--address",
                )?,
            };
            Some(public_address(&raw)?)
        }
    };
    let shown_address = sign_in.clone().unwrap_or_else(|| local_address(port));

    // What this install served on the tailnet before, which is its own to
    // replace or to take away.
    let served_before = existing.as_ref().and_then(|(state, _)| {
        (state.access == Access::Tailscale).then(|| {
            (
                state.https_port.unwrap_or(443),
                format!("http://127.0.0.1:{}", state.port),
            )
        })
    });
    if access == Access::Tailscale {
        // Before anything is changed: the port may serve something else.
        tailscale::check_free(
            https_port.unwrap_or(443),
            &format!("http://127.0.0.1:{port}"),
            served_before.as_ref().map(|(_, target)| target.as_str()),
        )?;
    }

    // A release that does not exist is found before it is written down.
    if runtime == Runtime::Docker && !docker.image_present(&format!("{IMAGE}:{release}"))? {
        docker.release_exists(IMAGE, &release)?;
    }

    // Last of the questions, so nothing is changed before they are all asked.
    let autostart = match (args.autostart, args.no_autostart, &existing) {
        (true, _, _) if runtime == Runtime::Docker && !launchd::supported() => {
            return Err(CliError::Usage(
                "--autostart for a Docker install is for a Mac, where launchd starts it at login; on Linux, `sudo systemctl enable docker` brings the server back at boot".into(),
            ));
        }
        (true, _, _) => true,
        (_, true, _) => false,
        (_, _, Some((state, _))) => state.autostart,
        (_, _, None) => match runtime {
            Runtime::Docker => {
                launchd::supported()
                    && prompter.yes_no(
                        "Start Marfa when you log in, even if Docker is not running yet?",
                        true,
                    )?
            }
            Runtime::Native if manager == Some(Manager::Launchd) => {
                prompter.yes_no("Start Marfa when you log in?", true)?
            }
            Runtime::Native => true,
        },
    };

    // What a proxy on this machine reaches the server from.
    let subnet = match runtime {
        Runtime::Docker => {
            // The network gives the proxy a range that survives a restart.
            match docker.network_subnet(&net)? {
                Some(subnet) => subnet,
                None => {
                    steps.say(&format!("Making the Docker network {net}..."));
                    docker.create_network(&net)?;
                    docker.network_subnet(&net)?.ok_or_else(|| {
                        CliError::Install(format!(
                            "Docker made the network {net} with no IPv4 range"
                        ))
                    })?
                }
            }
        }
        Runtime::Native => native::LOOPBACK_NETWORK.to_string(),
    };

    // The folder, before the first file is kept in it. A root install leaves
    // it to root, with the account able to write only `data/`.
    let identity = if root_install {
        if account::lookup(account::NAME).is_none() {
            steps.say(&format!("Making the {} account...", account::NAME));
        }
        Some(account::ensure(&folder.dir, !out.json)?)
    } else {
        None
    };
    let kept = files::kept(identity);
    match identity {
        Some(identity) => files::prepare_root_folder(&folder.dir, identity)?,
        None => std::fs::create_dir_all(&folder.dir)?,
    }

    // The settings the server reads. The secrets are made once, and not at
    // all when something else owns the file.
    let mut settings = have_secrets
        .clone()
        .unwrap_or_else(|| EnvFile::parse(files::SETTINGS_HEADER));
    if external {
        let of = match runtime {
            Runtime::Docker => format!("the range of the Docker network {net}"),
            Runtime::Native => {
                "the address a proxy on this machine reaches the server from".to_string()
            }
        };
        let problems = external_problems(&settings, access, &subnet, &of);
        if !problems.is_empty() {
            return Err(CliError::Usage(format!(
                "{} cannot run this install yet:\n  - {}",
                settings_path.display(),
                problems.join("\n  - ")
            )));
        }
    }
    let lacks = |name: &str| settings.get(name).is_none_or(|value| value.is_empty());
    let made_secrets = !external && names::SECRETS.iter().any(|secret| lacks(secret));
    // The warning is owed until one install has succeeded after the secrets
    // were made, which a run that fails part-way does not do.
    let marker = folder.path(files::UNCONFIRMED);
    let warn_to_keep = made_secrets || (!external && marker.is_file());
    if made_secrets {
        // Written before the secrets, and best effort: a marker that cannot
        // be kept costs only the warning on a later run, never the install.
        let _ = files::write_if_changed(&marker, files::UNCONFIRMED_NOTE, kept.marker);
    }
    if !external {
        for secret in names::SECRETS {
            if settings.get(secret).is_none_or(|value| value.is_empty()) {
                settings.set(secret, &envfile::secret()?)?;
            }
        }
        let (cidrs, header) = proxy_trust(runtime, access, &subnet);
        match cidrs {
            Some(cidrs) => settings.set(names::PROXY_CIDRS, &cidrs)?,
            None => settings.remove(names::PROXY_CIDRS),
        }
        match header {
            Some(header) => settings.set(names::PROXY_HEADER, header)?,
            None => settings.remove(names::PROXY_HEADER),
        }
    }

    // What the commands read to find the install again.
    let mut dotenv = existing
        .as_ref()
        .map(|(_, dotenv)| dotenv.clone())
        .unwrap_or_else(|| EnvFile::parse(files::DOTENV_HEADER));
    dotenv.set("MARFA_NAME", &name)?;
    dotenv.set("MARFA_RELEASE", &release)?;
    dotenv.set("MARFA_PORT", &port.to_string())?;
    dotenv.set("MARFA_ACCESS", &access.name())?;
    dotenv.set("MARFA_RUNTIME", runtime.name())?;
    match manager {
        Some(manager) => dotenv.set("MARFA_SERVICE", manager.name())?,
        None => dotenv.remove("MARFA_SERVICE"),
    }
    match https_port {
        Some(port) => dotenv.set("MARFA_HTTPS_PORT", &port.to_string())?,
        None => dotenv.remove("MARFA_HTTPS_PORT"),
    }
    match &sign_in {
        Some(address) => dotenv.set("MARFA_ADDRESS", address)?,
        None => dotenv.remove("MARFA_ADDRESS"),
    }
    if external {
        dotenv.set("MARFA_SETTINGS", "external")?;
    }
    dotenv.set("MARFA_AUTOSTART", if autostart { "on" } else { "off" })?;

    let wrote_settings = if external {
        // The server's account reads a settings file that something else
        // writes, and nothing else changes in it.
        if root_install {
            files::settle_path(&settings_path, kept.settings)?;
        }
        false
    } else {
        files::write_if_changed(&settings_path, &settings.render(), kept.settings)?
    };
    let wrote_dotenv =
        files::write_if_changed(&folder.path(files::DOTENV), &dotenv.render(), kept.dotenv)?;
    let wrote_compose = match runtime {
        Runtime::Docker => write_compose(&folder, &steps)?,
        Runtime::Native => false,
    };
    let changed = wrote_settings || wrote_dotenv || wrote_compose;

    if access == Access::Tailscale {
        steps.say("Serving the address on your tailnet...");
        tailscale::serve(
            https_port.unwrap_or(443),
            &format!("http://127.0.0.1:{port}"),
            served_before.as_ref().map(|(_, target)| target.as_str()),
            !out.json,
        )?;
    }

    let mut autostart = autostart;
    let mut autostart_failed = None;
    let mut linger = None;
    let service = manager.map(|manager| Service {
        manager,
        name: &name,
        dir: &folder.dir,
        trace: !out.json,
    });
    match (&service, &native_server) {
        (Some(service), Some(server)) => {
            let binary = native::stable_binary_of_this()?;
            if let Some(identity) = identity {
                check_account_runs(identity, &binary)?;
            }
            // A running server reads its settings once: restart it when they
            // changed, when another program owns them, or when it does not
            // answer on its port, as after a run that failed past the write.
            let restart = wrote_settings
                || external
                || existing
                    .as_ref()
                    .is_some_and(|(state, _)| state.port != port || state.release != release)
                || (service.running() && !answers_health(port));
            steps.say(&format!("Starting {name}..."));
            let mark = service.mark();
            linger = service.on(autostart, restart, &binary, server)?;
            let watch = Watch::Process { service, mark };
            wait_until_healthy(&watch, port, args.wait)?;
        }
        _ => {
            start(&docker, &folder.dir, &name, &release, &steps)?;
            wait_until_healthy(
                &Watch::Container {
                    docker: &docker,
                    name: &name,
                },
                port,
                args.wait,
            )?;
            // The login agent comes after the server is up, because loading
            // it runs it.
            if autostart {
                steps.say("Setting the server to start when you log in...");
                let loaded = launchd::Agent::for_docker(&name, &folder.dir)
                    .and_then(|agent| launchd::on(&agent, !out.json));
                if let Err(error) = loaded {
                    // The server is up, so the link below still matters most.
                    // The choice is recorded as off, so a run again tries
                    // again only when asked.
                    autostart = false;
                    autostart_failed = Some(error.to_string());
                    // The plist is written before launchd is asked to load
                    // it, and a file left behind would load at the next login.
                    let _ = launchd::off(&name, &folder.dir, false);
                    dotenv.set("MARFA_AUTOSTART", "off")?;
                    files::write_if_changed(
                        &folder.path(files::DOTENV),
                        &dotenv.render(),
                        kept.dotenv,
                    )?;
                }
            } else if launchd::installed(&name, &folder.dir).is_some() {
                launchd::off(&name, &folder.dir, !out.json)?;
            }
        }
    }
    if let Some((https, target)) = &served_before
        && (access != Access::Tailscale || *https != https_port.unwrap_or(443))
    {
        steps.say("Taking the old address off your tailnet...");
        if let Err(error) = tailscale::unserve(*https, target, !out.json) {
            eprintln!(
                "The old address stays on your tailnet: {error}. Remove it with `tailscale serve --https={https} off`."
            );
        }
    }

    // Claim.
    let control = match manager {
        Some(manager) => Control::native(&folder.dir, manager)?,
        None => Control::Container {
            docker: &docker,
            name: &name,
        },
    };
    // The server's address moves only when this run asked for another: a new
    // install, an address given, or a change of how the server is reached. A
    // local server in a container is reached only at its published port, so
    // that address is always put back.
    let asked_to_move = existing.is_none()
        || args.address.is_some()
        || args
            .access
            .zip(existing.as_ref())
            .is_some_and(|(access, (state, _))| access != state.access)
        || (access == Access::Tailscale
            && args
                .https_port
                .zip(existing.as_ref())
                .is_some_and(|(port, (state, _))| state.https_port != Some(port)))
        || (access == Access::Local && runtime == Runtime::Docker);
    let want = match &sign_in {
        Some(address) => address::Want::Set {
            address,
            asked: asked_to_move,
        },
        None => address::Want::Clear {
            asked: asked_to_move || args.access == Some(Access::Local),
        },
    };
    let (claim, settled) = claim_state(&control, want)?;
    let shown_address = match &settled {
        address::Settled::Left { held } => held.clone(),
        _ => shown_address,
    };
    if let address::Settled::Left { held } = &settled
        && !out.json
    {
        let reach = match runtime {
            Runtime::Native => format!("marfa --socket {}", layout.socket().display()),
            Runtime::Docker => {
                format!("docker exec {name} marfa --socket /data/control/marfa.sock")
            }
        };
        if sign_in.is_none() {
            eprintln!(
                "The server signs in at {held}, and this run left it there. To clear it, run this again with --access local."
            );
        } else {
            eprintln!(
                "The server signs in at {held}, and this run left it there. To move it, run this again with --address (or --access), or run `{reach} config update --body '{{\"sign_in_address\": \"<url>\", \"confirm_sign_in_address_change\": true}}'`."
            );
        }
    }
    let notes = boot_notes(runtime, manager, autostart, &linger);
    let host = crate::auth::machine_name();
    let report = json!({
        "installed": true,
        "changed": changed,
        "dir": folder.dir,
        "name": name,
        "release": release,
        "runtime": runtime.name(),
        "address": shown_address,
        "host": host,
        "port": port,
        "local_address": local_address(port),
        "access": access.name(),
        // True when this run tells the person to keep the settings file safe:
        // it made the secrets, or an earlier run did and none has succeeded since.
        "keep_settings_file": warn_to_keep,
        "settings": if external { "external" } else { "managed" },
        "autostart": autostart,
        "autostart_error": autostart_failed,
        "claimed": claim.claimed,
        "setup_url": claim.url,
        "setup_expires_at": claim.expires_at,
        "sign_in_address_left": match &settled {
            address::Settled::Left { held } => Some(held.clone()),
            _ => None,
        },
    });
    out.report(&report, || {
        let mut text = String::new();
        text.push_str(&format!(
            "\n{}\n\n",
            style::good(Stream::Out, &format!("Marfa {release} is running."))
        ));
        text.push_str(&format!("  Address   {shown_address}\n"));
        if matches!(access, Access::Cloudflare | Access::Proxy) {
            text.push_str(&format!(
                "  Point at  {} (point your {} here, or the address answers 502)\n",
                local_address(port),
                if access == Access::Cloudflare { "tunnel" } else { "proxy" }
            ));
        }
        text.push_str(&format!(
            "  Folder    {} on {}\n",
            folder.dir.display(),
            host.as_deref().unwrap_or("this machine")
        ));
        if let Some(service) = &service {
            text.push_str(&format!("  Service   {}\n", service.describe()));
        }
        if external {
            text.push_str(&format!(
                "  Settings  {} (managed outside this command; run it again after they change)\n",
                settings_path.display()
            ));
        }
        if warn_to_keep {
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
                "\nThis instance has an owner already. Sign in at {shown_address}.\n"
            )),
        }
        if let Some(why) = &autostart_failed {
            text.push_str(&format!(
                "\nThe instance is running, but it was not set to start at login: {why}\nRun this command again with --autostart to try again, or with --no-autostart to leave it.\n"
            ));
        }
        for note in &notes {
            text.push_str(&format!("\n{note}\n"));
        }
        text.push_str(&format!("\n{AGENT_HINT}\n"));
        style::labelled(Stream::Out, &text)
    })?;
    // The install succeeded, so the warning is no longer owed. A marker that
    // cannot be removed only repeats it.
    let _ = std::fs::remove_file(&marker);
    Ok(())
}

/// A native server runs the release installed. Another release than the one
/// the install runs is moved to with `upgrade`.
fn native_release(args: &InstallArgs, existing: Option<&State>) -> Result<String, CliError> {
    if args.release.is_some() {
        return Err(CliError::Usage(
            "--release is for --docker: a native server runs the release installed beside this marfa. Install the release you want (with Homebrew, or scripts/install.sh) and run `marfa server upgrade`".into(),
        ));
    }
    let own = env!("CARGO_PKG_VERSION").to_string();
    if let Some(state) = existing
        && state.release != own
    {
        refuse_older(&state.release, &own)?;
        return Err(CliError::Usage(format!(
            "this install runs {} and the installed marfa is {own}: `marfa server upgrade` moves it",
            state.release
        )));
    }
    Ok(own)
}

/// The account a root install runs as can run the program the service names;
/// a program in root's own home cannot be.
fn check_account_runs(identity: account::Identity, binary: &Path) -> Result<(), CliError> {
    let ran = account::command_as(identity, binary)
        .arg("--version")
        .output();
    if ran.is_ok_and(|output| output.status.success()) {
        return Ok(());
    }
    Err(CliError::Install(format!(
        "the {} account cannot run {}: install marfa and marfa-server where every account can, such as /usr/local/bin, then run this again",
        account::NAME,
        binary.display()
    )))
}

/// Writes the Compose file, after keeping a copy of one that differs, because
/// a person may have added a service to it.
pub(super) fn write_compose(folder: &Folder, steps: &Steps) -> Result<bool, CliError> {
    let path = folder.path(files::COMPOSE);
    if let Ok(existing) = std::fs::read_to_string(&path)
        && existing != files::COMPOSE_FILE
    {
        let backup = (0..)
            .map(|n| match n {
                0 => folder.path("compose.yaml.bak"),
                n => folder.path(&format!("compose.yaml.bak.{n}")),
            })
            .find(|candidate| !candidate.exists())
            .expect("a free name");
        std::fs::copy(&path, &backup)?;
        steps.say(&format!(
            "compose.yaml differed from the one this command writes; the old one is kept as {}.",
            backup.display()
        ));
    }
    files::write_if_changed(&path, files::COMPOSE_FILE, files::Perms::READABLE)
}

pub(super) fn start(
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
    docker.compose(dir, &["up", "-d"], false)
}

/// What a start waits on, and where it looks when the server does not answer.
pub(super) enum Watch<'a> {
    Container {
        docker: &'a Docker,
        name: &'a str,
    },
    Process {
        service: &'a Service<'a>,
        /// The log as it was before this start.
        mark: Mark,
    },
}

impl Watch<'_> {
    /// Why the server will not come up, when it has said so.
    fn failed(&self) -> Result<Option<String>, CliError> {
        Ok(match self {
            Watch::Container { docker, name } => match docker.container(name)? {
                Some(state) if matches!(state.status.as_str(), "exited" | "dead") => Some(format!(
                    "the server stopped: {}\n{}",
                    state.status,
                    docker.logs_tail(name)
                )),
                _ => {
                    let tail = docker.logs_tail(name);
                    tail.contains(REFUSED_DATABASE).then(|| {
                        format!("the server will not start on its database. Its log ends:\n{tail}")
                    })
                }
            },
            Watch::Process { service, mark } => {
                let tail = service.log_after(Some(mark), 20);
                tail.contains(REFUSED_DATABASE).then(|| {
                    format!("the server will not start on its database. Its log ends:\n{tail}")
                })
            }
        })
    }

    fn tail(&self) -> String {
        match self {
            Watch::Container { docker, name } => docker.logs_tail(name),
            Watch::Process { service, mark } => service.log_after(Some(mark), 20),
        }
    }
}

fn answers_health(port: u16) -> bool {
    http_agent()
        .get(&format!("http://127.0.0.1:{port}/health"))
        .call()
        .is_ok_and(|response| response.status().as_u16() == 200)
}

pub(super) fn wait_until_healthy(watch: &Watch, port: u16, seconds: u64) -> Result<(), CliError> {
    let agent = http_agent();
    let url = format!("http://127.0.0.1:{port}/health");
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut last = String::from("no answer yet");
    loop {
        match agent.get(&url).call() {
            Ok(response) if response.status().as_u16() == 200 => return Ok(()),
            Ok(response) => last = format!("it answered {}", response.status().as_u16()),
            Err(_) => {}
        }
        if let Some(why) = watch.failed()? {
            return Err(CliError::Install(why));
        }
        if Instant::now() >= deadline {
            return Err(CliError::Install(format!(
                "the server did not become healthy in {seconds} seconds ({last}). Its log ends:\n{}",
                watch.tail()
            )));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

pub(super) struct Claim {
    pub claimed: bool,
    pub url: Option<String>,
    pub expires_at: Option<String>,
}

/// Brings the sign-in address the server holds to the one this install wants,
/// then reads whether the instance is claimed and, if not, makes the link that
/// claims it. The address is first, because the link is at the address the
/// server holds.
fn claim_state(
    control: &Control,
    want: address::Want,
) -> Result<(Claim, address::Settled), CliError> {
    let settled = address::settle_with(
        want,
        || control.json(&["config", "get"]),
        |body| {
            control
                .json(&["config", "update", "--body", &body.to_string()])
                .map(drop)
        },
    )?;
    let status = control.json(&["setup", "status"])?;
    if status["claimed"].as_bool().unwrap_or(false) {
        return Ok((
            Claim {
                claimed: true,
                url: None,
                expires_at: None,
            },
            settled,
        ));
    }
    let ticket = control.json(&["setup", "open", "--no-browser"])?;
    let url = ticket["url"]
        .as_str()
        .ok_or_else(|| CliError::Install("the server returned no setup link".into()))?;
    Ok((
        Claim {
            claimed: false,
            url: Some(url.to_string()),
            expires_at: ticket["expires_at"].as_str().map(str::to_string),
        },
        settled,
    ))
}

/// What decides whether the server comes back after a restart of the machine.
fn boot_notes(
    runtime: Runtime,
    manager: Option<Manager>,
    autostart: bool,
    linger: &Option<Linger>,
) -> Vec<String> {
    match (runtime, manager) {
        (Runtime::Native, Some(Manager::Launchd)) => vec![if autostart {
            "It starts when you log in, and again after a failure. `marfa server status` shows it.".to_string()
        } else {
            "It runs now, and again after a failure, but not when you log in again: `marfa server start` starts it.".to_string()
        }],
        (Runtime::Native, Some(Manager::SystemdSystem)) => vec![if autostart {
            "It starts when the machine does, and again after a failure. `marfa server status` shows it.".to_string()
        } else {
            "It runs now, and again after a failure, but not when the machine starts: `marfa server start` starts it.".to_string()
        }],
        (Runtime::Native, Some(Manager::SystemdUser)) if !autostart => vec![
            "It runs now, and again after a failure, but not when the machine starts: `marfa server start` starts it.".to_string(),
        ],
        (Runtime::Native, Some(Manager::SystemdUser)) => match linger {
            Some(Linger::Refused(why)) => vec![format!(
                "It runs now, and starts when you log in, but the machine would not let it start at boot with nobody logged in: {why}. Run `sudo loginctl enable-linger {}` once to allow it.",
                account::current_user()
            )],
            _ => vec!["It starts when the machine does, even with nobody logged in, and again after a failure. `marfa server status` shows it.".to_string()],
        },
        (Runtime::Native, None) => Vec::new(),
        (Runtime::Docker, _) => docker_boot_notes(autostart),
    }
}

/// What decides whether the container comes back after a restart of the
/// machine: Docker's restart policy brings it back whenever the engine starts,
/// so the engine's own start is the part worth saying.
fn docker_boot_notes(autostart: bool) -> Vec<String> {
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

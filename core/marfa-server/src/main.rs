#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::disallowed_methods)
)]

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use marfa_server::app::updates;
use marfa_server::failure::Failure;
use marfa_server::settings::{Environment, Refused, Settings};
use marfa_server::telemetry::config::{self, Config};
use marfa_server::{log, run, telemetry};

#[global_allocator]
static ALLOCATOR: marfa_allocator::Allocator = marfa_allocator::Allocator;

/// The Marfa server. It is configured through its environment.
#[derive(Parser)]
#[command(version, about)]
struct Cli {
    /// Says whether this build accepts the environment's settings and opens the database file, reading it only, and ends.
    #[arg(long, value_name = "FILE")]
    can_open: Option<PathBuf>,
}

/// A rule between telemetry settings is asked only when every setting has read.
fn read_settings() -> Result<(marfa_server::settings::Accepted, Config), Failure> {
    let environment = Environment::of_process();
    let mut own = Vec::new();
    let telemetry = Config::read(&environment, &mut own);
    let refuse = |lines| Failure::start(Refused { lines }.to_string());
    match Settings::read(environment.clone()) {
        Ok(accepted) if own.is_empty() => {
            let together = config::disagreements(&environment);
            if together.is_empty() {
                accepted.warn_of_unknown();
                Ok((accepted, telemetry))
            } else {
                Err(refuse(together))
            }
        }
        Ok(_) => Err(refuse(own)),
        Err(mut refused) => {
            refused.lines.extend(own);
            Err(refuse(refused.lines))
        }
    }
}

fn start() -> Result<u8, Failure> {
    let (accepted, telemetry) = read_settings()?;
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| Failure::start(format!("The runtime did not start: {error}")))?
        .block_on(run::run(accepted, telemetry))
}

/// Status 78 says this build will not run on this server's settings or database.
fn can_open(file: &std::path::Path) -> ExitCode {
    if let Err(failure) = read_settings() {
        eprintln!("{}", failure.message);
        return ExitCode::from(78);
    }
    match updates::inspect(file) {
        Ok(said) => {
            println!("{said}");
            ExitCode::SUCCESS
        }
        Err(failure) => {
            eprintln!("{}", failure.message);
            ExitCode::from(failure.status)
        }
    }
}

fn main() -> ExitCode {
    marfa_server::private_files::take_umask();
    marfa_allocator::route_sqlite();
    marfa_enrichment::serve_child_if_asked();
    let cli = Cli::parse();
    if let Some(file) = cli.can_open {
        return can_open(&file);
    }
    log::init();
    telemetry::install_panic_hook();
    match start() {
        Ok(status) => ExitCode::from(status),
        Err(failure) => {
            log::start_failed(&failure);
            ExitCode::from(failure.status)
        }
    }
}

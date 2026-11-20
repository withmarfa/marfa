#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::disallowed_methods)
)]

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use marfa_server::app::updates;
use marfa_server::failure::Failure;
use marfa_server::settings::{Environment, Settings};
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

fn read_settings() -> Result<marfa_server::settings::Accepted, Failure> {
    match Settings::read(Environment::of_process()) {
        Ok(accepted) => {
            accepted.warn_of_unknown();
            Ok(accepted)
        }
        Err(refused) => Err(Failure::start(refused.to_string())),
    }
}

fn start() -> Result<u8, Failure> {
    let accepted = read_settings()?;
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| Failure::start(format!("The runtime did not start: {error}")))?
        .block_on(run::run(accepted))
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

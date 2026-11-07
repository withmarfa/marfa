use std::process::ExitCode;

use clap::Parser;
use marfa_server::failure::Failure;
use marfa_server::settings::{Environment, Settings};
use marfa_server::{log, run};

/// The Marfa server. It is configured through its environment.
#[derive(Parser)]
#[command(version, about)]
struct Cli {}

fn start() -> Result<u8, Failure> {
    let settings = Settings::read(Environment::of_process())
        .map_err(|refused| Failure::start(refused.to_string()))?;
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| Failure::start(format!("The runtime did not start: {error}")))?
        .block_on(run::run(settings))
}

fn main() -> ExitCode {
    Cli::parse();
    log::init();
    match start() {
        Ok(status) => ExitCode::from(status),
        Err(failure) => {
            tracing::error!(error = %failure, "Failed to start server");
            ExitCode::from(failure.status)
        }
    }
}

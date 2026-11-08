use std::process::ExitCode;

use clap::Parser;
use marfa_server::failure::Failure;
use marfa_server::settings::{Environment, Refused, Settings};
use marfa_server::telemetry::config::{self, Config};
use marfa_server::{log, run, telemetry};

/// The Marfa server. It is configured through its environment.
#[derive(Parser)]
#[command(version, about)]
struct Cli {}

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

fn main() -> ExitCode {
    marfa_enrichment::serve_child_if_asked();
    Cli::parse();
    log::init();
    telemetry::install_panic_hook();
    match start() {
        Ok(status) => ExitCode::from(status),
        Err(failure) => {
            tracing::error!(error = %failure, "Failed to start server");
            ExitCode::from(failure.status)
        }
    }
}

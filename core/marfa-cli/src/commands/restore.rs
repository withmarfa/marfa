use std::path::PathBuf;

use clap::Args;

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// Take an archive back: the other half of `export --format archive`.
#[derive(Debug, Args)]
pub struct RestoreArgs {
    /// The archive, as `export --format archive` wrote it.
    pub file: PathBuf,
}

pub fn request(args: &RestoreArgs) -> Request {
    Request::post(&["restore"]).file(args.file.clone(), "application/x-tar")
}

pub fn run(args: RestoreArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let answer = remote.json(&request(&args))?;
    out.value(&answer)?;
    if let Some(note) = answer.get("set_up_again").and_then(serde_json::Value::as_str) {
        eprintln!("{note}");
    }
    let missing: Vec<String> = answer
        .get("blobs_missing")
        .and_then(serde_json::Value::as_array)
        .map(|hashes| {
            hashes
                .iter()
                .filter_map(|hash| hash.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(CliError::RestoreLacksBlobs(missing))
    }
}

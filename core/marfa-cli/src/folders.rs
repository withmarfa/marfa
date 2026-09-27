//! Folders on this machine: a directory that holds a slice as files.

use std::path::PathBuf;
use std::time::Duration;

use clap::Subcommand;
use marfa_core::{CoreError, Folder, Slice};

use crate::commands::folders as folder_settings;
use crate::commands::items::IdempotencyArgs;
use crate::error::CliError;
use crate::output::{self, Printer};
use crate::remote::{Named, Remote};
use crate::values::{Tier, properties};
use crate::watch;

#[derive(Debug, Subcommand)]
pub enum FoldersCommand {
    /// Make a directory a folder: a view on a slice, with defaults.
    Add {
        /// The directory. It is made if it is not there.
        dir: PathBuf,
        /// The types this folder holds.
        #[arg(long, value_delimiter = ',', required = true, value_name = "TYPE")]
        types: Vec<String>,
        /// The tier the folder's slice is held at.
        #[arg(long, default_value = "library")]
        tier: Tier,
        /// What a new file becomes. The default is the first type named.
        #[arg(long = "default-type", value_name = "TYPE")]
        default_type: Option<String>,
        /// Properties every new file gets, as a JSON object.
        #[arg(long, value_name = "JSON", default_value = "{}")]
        defaults: String,
        /// A tag every item in this folder carries.
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
    },
    /// Pull the folder's slice into its working copy.
    Hydrate {
        /// The folder.
        dir: PathBuf,
    },
    /// Read the folder and queue what has changed. Sends nothing.
    Scan {
        /// The folder.
        dir: PathBuf,
    },
    /// Write the slice out as files.
    Pull {
        /// The folder.
        dir: PathBuf,
    },
    /// Scan, drain, catch up and pull: everything a folder does, once.
    Push {
        /// The folder.
        dir: PathBuf,
    },
    /// Create a folder's settings on the server, as a `system.folder`.
    /// Needs write on `system.folder`.
    Create(folder_settings::CreateArgs),
    /// Change a folder's settings on the server, each named one replaced whole.
    Change(folder_settings::ChangeArgs),
    /// Retire a folder's settings on the server. A revoked folder does not change.
    Revoke {
        /// The folder's `system.folder` id.
        id: String,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Watch a folder and keep it in step until interrupted.
    Watch {
        /// The directory to watch, recursively.
        dir: PathBuf,
        /// Stop after this long. Unset, it runs until interrupted.
        #[arg(long, value_name = "SECONDS")]
        r#for: Option<u64>,
    },
}

/// Every folder command. A folder carries its own store under `.marfa`, so
/// none of these takes `--db`: pointing one at another store would be two
/// folders sharing a mapping, and neither would be right about the other's
/// files.
pub fn run(command: FoldersCommand, named: &Named, json: bool) -> Result<(), CliError> {
    match command {
        FoldersCommand::Add {
            dir,
            types,
            tier,
            default_type,
            defaults,
            tags,
        } => {
            let slice = Slice {
                default_type: default_type
                    .unwrap_or_else(|| types.first().cloned().unwrap_or_default()),
                types,
                tier: tier.into(),
                defaults: properties(&defaults)?,
                tags,
            };
            let folder = Folder::add(&dir, slice, None)?;
            output::report(folder.slice(), json, || {
                format!("{} is a folder", folder.root().display())
            })
        }
        FoldersCommand::Hydrate { dir } => {
            let folder = Folder::open(&dir, Some(named.server()?))?;
            let report = folder.hydrate()?;
            output::report(&report, json, || {
                format!("{} item(s) into {}", report.items, dir.display())
            })
        }
        FoldersCommand::Scan { dir } => {
            let report = Folder::open(&dir, None)?.scan()?;
            output::report(&report, json, || describe_scan(&report))
        }
        FoldersCommand::Pull { dir } => {
            // A server where one is named, because a file item's bytes are
            // fetched when the pull asks for them; with none, a file whose
            // bytes are not held is reported rather than written.
            let server = match named.server() {
                Ok(server) => Some(server),
                Err(CliError::NoServerNamed) => None,
                Err(error) => return Err(error),
            };
            let report = Folder::open(&dir, server)?.pull()?;
            output::report(&report, json, || describe_pull(&report))
        }
        FoldersCommand::Push { dir } => {
            let folder = Folder::open(&dir, Some(named.server()?))?;
            let hydrated = folder.resume()?;
            let scanned = folder.scan()?;
            let drained = folder.core().drain()?;
            // A folder offline still writes out the copy it holds.
            let (caught, failed) = match folder.catch_up() {
                Ok(caught) => (serde_json::to_value(caught)?, None),
                Err(error) if error.is_environmental() => (
                    serde_json::json!({ "failed": error.to_string() }),
                    Some(error),
                ),
                Err(error) => return Err(error.into()),
            };
            // A failed hydration after an aged-out cursor leaves nothing to
            // pull from; the next push hydrates first.
            let pulled = match folder.pull() {
                Ok(pulled) => Some(pulled),
                Err(CoreError::HydrationIncomplete) if failed.is_some() => None,
                Err(error) => return Err(error.into()),
            };
            output::report(
                &serde_json::json!({
                    "hydrated": hydrated,
                    "scan": scanned,
                    "drain": drained,
                    "catch_up": caught,
                    "pull": pulled,
                }),
                json,
                || {
                    let mut lines = Vec::new();
                    if let Some(hydrated) = &hydrated {
                        lines.push(format!("hydrated {} item(s) first", hydrated.items));
                    }
                    lines.push(describe_scan(&scanned));
                    lines.push(format!("sent {}, held {}", drained.sent, drained.held));
                    if let Some(error) = &failed {
                        lines.push(format!("could not catch up: {error}"));
                    }
                    lines.push(match &pulled {
                        Some(pulled) => {
                            format!("{} file(s) written", pulled.written + pulled.rewritten)
                        }
                        None => "nothing written: the copy could not be hydrated, and the next push tries again".into(),
                    });
                    lines.join("\n")
                },
            )
        }
        FoldersCommand::Watch { dir, r#for } => {
            watch::watch(&dir, named.server()?, r#for.map(Duration::from_secs), json)
        }
        FoldersCommand::Create(args) => send(folder_settings::create_request(&args)?, named, json),
        FoldersCommand::Change(args) => send(folder_settings::change_request(&args)?, named, json),
        FoldersCommand::Revoke { id, idempotency } => send(
            folder_settings::revoke_request(&id, &idempotency),
            named,
            json,
        ),
    }
}

fn send(
    request: crate::remote::request::Request,
    named: &Named,
    json: bool,
) -> Result<(), CliError> {
    let answer = Remote::resolve(named)?.json(&request)?;
    Printer { json }.value(&answer)
}

/// What a pull did, for somebody who did not ask for JSON.
///
/// The counts after the semicolon are items that have no file and will not
/// get one on this pass (`folders.md` 20, 22, 27), named only when there are
/// any.
fn describe_pull(report: &marfa_core::PullReport) -> String {
    let mut line = format!(
        "{} written, {} rewritten, {} moved, {} unchanged, {} skipped",
        report.written, report.rewritten, report.moved, report.unchanged, report.skipped
    );
    let held: Vec<String> = [
        (
            report.unwritten,
            "the folder did not write and would not write over",
        ),
        (report.collided, "wanting a path another item took"),
        (report.outside, "wanting a path outside the folder"),
        (report.absent, "whose bytes could not be fetched"),
    ]
    .into_iter()
    .filter(|(count, _)| *count > 0)
    .map(|(count, why)| format!("{count} {why}"))
    .collect();
    if !held.is_empty() {
        line.push_str("; not written: ");
        line.push_str(&held.join(", "));
    }
    // A file the person deleted and the pull wrote back.
    if report.revived > 0 {
        line.push_str(&format!(
            "; {} written back over a pending delete",
            report.revived
        ));
    }
    let departed: Vec<String> = [
        (
            report.removed,
            "file(s) of items that left the slice removed",
        ),
        (report.kept, "kept with the person's changes"),
    ]
    .into_iter()
    .filter(|(count, _)| *count > 0)
    .map(|(count, what)| format!("{count} {what}"))
    .collect();
    if !departed.is_empty() {
        line.push_str("; ");
        line.push_str(&departed.join(", "));
    }
    line
}

fn describe_scan(report: &marfa_core::ScanReport) -> String {
    format!(
        "{} created, {} updated, {} renamed, {} unchanged, {} missing, {} deleted, {} skipped{}",
        report.created,
        report.updated,
        report.renamed,
        report.unchanged,
        report.missing,
        report.deleted,
        report.skipped,
        [
            (
                report.requeued,
                "queued again because the item it was bound to is gone",
            ),
            (
                report.lost,
                "bound to an item that is gone and unchanged since, so not sent",
            ),
        ]
        .into_iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, what)| format!("; {count} {what}"))
        .collect::<String>()
    )
}

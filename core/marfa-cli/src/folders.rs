//! Folders on this machine: a directory that holds what a search matches, as files.

use std::path::PathBuf;
use std::time::Duration;

use clap::Subcommand;
use marfa_core::{CoreError, Folder};

use crate::commands::folders as folder_settings;
use crate::commands::items::IdempotencyArgs;
use crate::error::CliError;
use crate::output::{self, Printer};
use crate::remote::{Named, Remote};
use crate::watch;

#[derive(Debug, Subcommand)]
pub enum FoldersCommand {
    /// Make a directory a folder that follows a `system.folder`'s settings,
    /// which `folders create` makes. Needs read on `system.folder`.
    Add {
        /// The directory. It is made if it is not there.
        dir: PathBuf,
        /// The folder's `system.folder` id.
        #[arg(long, value_name = "ID")]
        folder: String,
    },
    /// Pull what the folder's search needs into its working copy.
    Hydrate {
        /// The folder.
        dir: PathBuf,
    },
    /// Read the folder and queue what has changed. Sends nothing.
    Scan {
        /// The folder.
        dir: PathBuf,
    },
    /// Write what the folder's search matches out as files.
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
        FoldersCommand::Add { dir, folder } => {
            let folder = Folder::add(&dir, &folder, Some(named.server()?))?;
            output::report(
                &serde_json::json!({
                    "dir": folder.root(),
                    "folder": folder.folder_id(),
                }),
                json,
                || {
                    format!(
                        "{} follows the folder {}",
                        folder.root().display(),
                        folder.folder_id()
                    )
                },
            )
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
            // First, so the rest of the push works on the settings the person
            // just wrote.
            let settings = folder.send_settings_edit()?;
            let scanned = folder.scan()?;
            let drained = folder.drain()?;
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
                    "settings": settings,
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
                    lines.extend(settings_line(&settings));
                    lines.push(describe_scan(&scanned));
                    lines.push(format!(
                        "sent {}, held {}",
                        drained.report.sent, drained.report.held
                    ));
                    if drained.rebased > 0 {
                        lines.push(rebased_line(drained.rebased));
                    }
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

/// Said in words, because what these edits carried went over whatever
/// changed since their file was written (`folders.md` 19).
pub fn rebased_line(rebased: usize) -> String {
    format!(
        "{rebased} edit(s) written from a version the server no longer holds, sent again on the version this copy holds"
    )
}

/// What became of the settings file, where anything did.
pub fn settings_line(report: &marfa_core::SettingsFileReport) -> Option<String> {
    match (&report.flagged, report.sent) {
        (Some(reason), _) => Some(format!(
            "the settings file is not in force, and the settings before it are: {reason}"
        )),
        (None, true) => Some("the settings file's edit went through the folder door".into()),
        (None, false) => None,
    }
}

/// What a pull did, for somebody who did not ask for JSON.
///
/// The counts after the semicolon are items that have no file and will not
/// get one on this pass (`folders.md` 24, 26, 32), named only when there are
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
            "file(s) of items trashed or out of the search's states removed",
        ),
        (report.kept, "kept with the person's changes"),
        (
            report.unmatched,
            "file(s) left in place whose item the search no longer matches",
        ),
    ]
    .into_iter()
    .filter(|(count, _)| *count > 0)
    .map(|(count, what)| format!("{count} {what}"))
    .collect();
    if !departed.is_empty() {
        line.push_str("; ");
        line.push_str(&departed.join(", "));
    }
    if let Some(settings) = settings_line(&report.settings) {
        line.push('\n');
        line.push_str(&settings);
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

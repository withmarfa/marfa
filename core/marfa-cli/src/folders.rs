//! Folders on this machine: a directory that holds a slice as files.

use std::path::PathBuf;
use std::time::Duration;

use clap::Subcommand;
use marfa_core::{Folder, Slice};

use crate::error::CliError;
use crate::output;
use crate::remote::Named;
use crate::values::{Tier, properties};
use crate::watch;

#[derive(Debug, Subcommand)]
pub enum FoldersCommand {
    /// Make a directory a folder: a view on a slice, with defaults.
    Add {
        /// The directory. It is made if it is not there.
        dir: PathBuf,
        /// The source every item this folder creates is keyed by. Name the
        /// same one on every machine that holds this folder, so one file is
        /// one item on all of them.
        #[arg(long)]
        source: String,
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
            source,
            types,
            tier,
            default_type,
            defaults,
            tags,
        } => {
            let slice = Slice {
                source,
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
            let scanned = folder.scan()?;
            let drained = folder.core().drain()?;
            // Before the pull, so what another device changed since the
            // copy's cursor is written out rather than waiting for a
            // hydration that nothing asks for.
            let caught = folder.catch_up()?;
            let pulled = folder.pull()?;
            output::report(
                &serde_json::json!({
                    "scan": scanned,
                    "drain": drained,
                    "catch_up": caught,
                    "pull": pulled,
                }),
                json,
                || {
                    let mut lines = vec![
                        describe_scan(&scanned),
                        format!("sent {}, held {}", drained.sent, drained.held),
                    ];
                    lines.extend(output::unclaimed(&drained));
                    lines.push(format!(
                        "{} file(s) written",
                        pulled.written + pulled.rewritten
                    ));
                    lines.join("\n")
                },
            )
        }
        FoldersCommand::Watch { dir, r#for } => {
            watch::watch(&dir, named.server()?, r#for.map(Duration::from_secs), json)
        }
    }
}

/// What a pull did, for somebody who did not ask for JSON.
///
/// The counts after the semicolon are items that have no file and are not
/// going to get one on this pass. `folders.md` 20 requires the path outside
/// the folder be reported, 22 the file not written over, and 29 the bytes
/// that could not be had; a line of the first five numbers alone says
/// nothing about any of them, so a person reading five zeroes has been told
/// the pull was quiet rather than that it declined to write. Left off when
/// they are zero, because the ordinary pull is the one nobody needs to read
/// twice.
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
    // Named only when it happened. A file the person deleted and the folder
    // wrote back is the one outcome of a pull they did not ask for, and a
    // count they never see is the same as no count at all.
    if report.revived > 0 {
        line.push_str(&format!(
            "; {} written back over a pending delete",
            report.revived
        ));
    }
    // Both about items that have left the slice, and both named only when
    // there were any: a file taken away is one the person may go looking
    // for, and one kept is an edit the folder is holding for them.
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
        // Each named only when it happened, because each is rare and a
        // line of the other seven does not account for it.
        [
            (report.parked, "moved off a contested name and back"),
            (
                report.requeued,
                "queued again because the item it was bound to is gone",
            ),
            (
                report.lost,
                "bound to an item that is gone and unchanged since, so not sent",
            ),
            (
                report.overwrote,
                "sent over another device's content, which this one never read; the last writer wins and the other version stays in the item's history",
            ),
        ]
        .into_iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, what)| format!("; {count} {what}"))
        .collect::<String>()
    )
}

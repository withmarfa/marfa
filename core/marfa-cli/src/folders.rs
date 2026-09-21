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
    /// Scan, drain and pull: everything a folder does, once.
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
            let report = Folder::open(&dir, None)?.pull()?;
            output::report(&report, json, || describe_pull(&report))
        }
        FoldersCommand::Push { dir } => {
            let folder = Folder::open(&dir, Some(named.server()?))?;
            let scanned = folder.scan()?;
            let drained = folder.core().drain()?;
            let pulled = folder.pull()?;
            output::report(
                &serde_json::json!({
                    "scan": scanned,
                    "drain": drained,
                    "pull": pulled,
                }),
                json,
                || {
                    format!(
                        "{}\nsent {}, held {}\n{} file(s) written",
                        describe_scan(&scanned),
                        drained.sent,
                        drained.held,
                        pulled.written + pulled.rewritten
                    )
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
/// The three counts after the semicolon are items that have no file and are
/// not going to get one on this pass. `folders.md` 20 requires the third be
/// reported and 22 the first; a line of the first five numbers alone says
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
        // Named only when it happened, because it is rare and it is
        // the write a line of the other seven does not account for.
        if report.parked > 0 {
            format!("; {} moved off a contested name and back", report.parked)
        } else {
            String::new()
        }
    )
}

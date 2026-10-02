use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::Subcommand;
use marfa_core::folder::Registry;
use marfa_core::{CoreError, Folder};

use crate::commands::folders as folder_settings;
use crate::commands::items::IdempotencyArgs;
use crate::error::CliError;
use crate::output::{self, Printer};
use crate::remote::{Named, Remote, Session, renewing};
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
    /// List the folders on this machine, as its registry holds them. The
    /// registry is the file MARFA_FOLDER_REGISTRY names, where it names one.
    List,
    /// Take a folder off this machine: its own state under `.marfa` goes,
    /// and its files stay as plain files. Refused while writes wait. A
    /// folder whose directory is gone is taken off the list.
    Remove {
        /// The folder.
        dir: PathBuf,
    },
    /// Say where every file in the folder stands, from its own store,
    /// asking the server nothing.
    Status {
        /// The folder.
        dir: PathBuf,
    },
    /// Let a paused large removal go: its deletes are queued, and files
    /// whose items left elsewhere are taken away.
    Confirm {
        /// The folder.
        dir: PathBuf,
    },
    /// Cancel a paused large removal: files gone from the disk are written
    /// back, and items that left elsewhere are restored.
    Restore {
        /// The folder.
        dir: PathBuf,
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
    /// Watch a folder and keep it in step.
    Watch {
        /// The directory to watch, recursively.
        dir: PathBuf,
        /// Stop after this long. Unset, it runs until interrupted.
        #[arg(long, value_name = "SECONDS")]
        r#for: Option<u64>,
    },
}

pub fn run(command: FoldersCommand, named: &Named, json: bool) -> Result<(), CliError> {
    match command {
        FoldersCommand::Add { dir, folder } => {
            let session = named.session()?;
            let folder = Folder::add(&dir, &folder, Some(session.server))?;
            renewing(folder.core(), session.renew);
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
        FoldersCommand::List => {
            let listed = match Registry::located() {
                Some(registry) => registry.folders()?,
                None => Vec::new(),
            };
            output::report(&listed, json, || {
                if listed.is_empty() {
                    return "no folders on this machine".into();
                }
                listed
                    .iter()
                    .map(|entry| {
                        format!(
                            "{} follows the folder {}",
                            entry.dir.display(),
                            entry.folder
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        }
        FoldersCommand::Remove { dir } => {
            if dir.join(marfa_core::folder::STATE_DIR).exists() || !Folder::forget(&dir)? {
                Folder::open(&dir, None)?.remove()?;
            }
            output::report(
                &serde_json::json!({ "dir": dir, "removed": true }),
                json,
                || format!("{} is no longer a folder; its files stay", dir.display()),
            )
        }
        FoldersCommand::Status { dir } => {
            let report = Folder::open(&dir, None)?.status()?;
            output::report(&report, json, || describe_status(&report))
        }
        FoldersCommand::Confirm { dir } => {
            let confirmed = Folder::open(&dir, None)?.confirm()?;
            output::report(&confirmed, json, || {
                format!(
                    "{} delete(s) queued, sent at the next push; {} file(s) found in another folder, whose items stay; {} file(s) taken away{}",
                    confirmed.deleted,
                    confirmed.moved,
                    confirmed.removed,
                    confirmed
                        .unsure
                        .iter()
                        .map(|file| format!("\n{}: not let go yet, {}", file.path, file.reason))
                        .collect::<String>()
                )
            })
        }
        FoldersCommand::Restore { dir } => {
            let restored = opened(&dir, named.session_if_named()?)?.restore()?;
            output::report(&restored, json, || {
                format!(
                    "{} file(s) written back; {} item(s) restored, sent at the next push",
                    restored.put_back, restored.restored
                )
            })
        }
        FoldersCommand::Hydrate { dir } => {
            let folder = opened(&dir, Some(named.session()?))?;
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
            // Optional: without a server, unheld bytes are reported, not fetched.
            let report = opened(&dir, named.session_if_named()?)?.pull()?;
            output::report(&report, json, || describe_pull(&report))
        }
        FoldersCommand::Push { dir } => {
            let folder = opened(&dir, Some(named.session()?))?;
            let hydrated = folder.resume()?;
            // First, so the rest of the push works on the new settings.
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
                    let mut flagged = scanned.flagged.clone();
                    if let Some(pulled) = &pulled {
                        for file in &pulled.flagged {
                            if !flagged.iter().any(|seen| seen.path == file.path) {
                                flagged.push(file.clone());
                            }
                        }
                        lines.extend(uncarried_line(&pulled.uncarried));
                    }
                    lines.extend(flagged_lines(&flagged));
                    lines.extend(embed_lines(
                        scanned
                            .embeds
                            .iter()
                            .chain(pulled.iter().flat_map(|pulled| &pulled.embeds)),
                    ));
                    lines.push(format!(
                        "sent {}, held {}",
                        drained.report.sent, drained.report.held
                    ));
                    if drained.rebased > 0 {
                        lines.push(rebased_line(drained.rebased));
                    }
                    if drained.gave_way > 0 {
                        lines.push(gave_way_line(drained.gave_way));
                    }
                    if let Some(error) = &failed {
                        lines.push(format!("could not catch up: {error}"));
                    }
                    lines.push(match &pulled {
                        Some(pulled) if pulled.root_gone.is_some() => describe_pull(pulled),
                        Some(pulled) => format!(
                            "{} file(s) written{}",
                            pulled.written + pulled.rewritten,
                            unplaced_line(pulled.unplaced)
                                .map(|line| format!("; {line}"))
                                .unwrap_or_default()
                        ),
                        None => "nothing written: the copy could not be hydrated, and the next push tries again".into(),
                    });
                    lines.join("\n")
                },
            )
        }
        FoldersCommand::Watch { dir, r#for } => {
            watch::watch(&dir, named.session()?, r#for.map(Duration::from_secs), json)
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

pub fn rebased_line(rebased: usize) -> String {
    format!(
        "{rebased} edit(s) written from a version the server no longer holds, sent again on the version this copy holds"
    )
}

pub fn gave_way_line(gave_way: usize) -> String {
    format!("{gave_way} placement(s) another machine made first, followed instead")
}

pub fn unplaced_line(unplaced: usize) -> Option<String> {
    (unplaced > 0).then(|| {
        format!(
            "{unplaced} placement(s) the server refused, not sent again until the file moves, its placement moves on, or the key or the settings change"
        )
    })
}

pub fn opened(dir: &Path, session: Option<Session>) -> Result<Folder, CliError> {
    let (server, renew) = Session::split(session);
    let folder = Folder::open(dir, server)?;
    renewing(folder.core(), renew);
    Ok(folder)
}

pub fn flagged_lines(flagged: &[marfa_core::folder::Flagged]) -> Vec<String> {
    flagged
        .iter()
        .map(|file| match file.flag {
            "unreadable" => format!(
                "{} is held, not sent: its frontmatter cannot be read ({})",
                file.path, file.reason
            ),
            "behind" => format!("{}: {}", file.path, file.reason),
            "edges" => format!("{} is left as written: {}", file.path, file.reason),
            "waiting" => format!("{} waits: {}", file.path, file.reason),
            _ => format!(
                "{} is held, not sent, and left as written: {}",
                file.path, file.reason
            ),
        })
        .collect()
}

pub fn directory_lines(directories: &[marfa_core::folder::Flagged]) -> Vec<String> {
    directories
        .iter()
        .map(|dir| match dir.path.as_str() {
            "" => format!("the folder {}", dir.reason),
            path => format!("{path} {}", dir.reason),
        })
        .collect()
}

pub fn embed_lines<'a>(
    embeds: impl IntoIterator<Item = &'a marfa_core::folder::Flagged>,
) -> Vec<String> {
    let mut said: Vec<String> = Vec::new();
    for embed in embeds {
        let line = format!("{}: {}", embed.path, embed.reason);
        if !said.contains(&line) {
            said.push(line);
        }
    }
    said
}

pub fn uncarried_line(uncarried: &[marfa_core::folder::Uncarried]) -> Option<String> {
    (!uncarried.is_empty()).then(|| {
        let named: Vec<String> = uncarried
            .iter()
            .map(|entry| format!("{}.{}", entry.r#type, entry.property))
            .collect();
        format!(
            "no file can carry {}: a file reads type, tier, tags, state and edge names as the item's own",
            named.join(", ")
        )
    })
}

pub fn settings_line(report: &marfa_core::SettingsFileReport) -> Option<String> {
    if let Some(reason) = &report.unwritten {
        return Some(format!(
            "the settings file was not written, and the next pass writes it: {reason}"
        ));
    }
    match (&report.flagged, report.sent) {
        (Some(reason), _) => Some(format!(
            "the settings file is not in force, and the settings before it are: {reason}"
        )),
        (None, true) => Some("the settings file's edit went through the folder door".into()),
        (None, false) => None,
    }
}

fn describe_pull(report: &marfa_core::PullReport) -> String {
    if let Some(gone) = &report.root_gone {
        return format!("nothing written: {gone}");
    }
    let mut line = format!(
        "{} written, {} rewritten, {} moved, {} unchanged, {} skipped",
        report.written, report.rewritten, report.moved, report.unchanged, report.skipped
    );
    let held: Vec<String> = [
        (
            report.unwritten,
            "the folder did not write and would not write over",
        ),
        (report.outside, "wanting a path outside the folder"),
        (
            report.unsuited,
            "whose placement would make them another kind of file",
        ),
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
    if let Some(unplaced) = unplaced_line(report.unplaced) {
        line.push_str("; ");
        line.push_str(&unplaced);
    }
    if report.beside > 0 {
        line.push_str(&format!(
            "; {} placed beside a path another item holds",
            report.beside
        ));
    }
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
        (
            report.taken,
            "file(s) taken in from another folder on this machine",
        ),
        (
            report.elsewhere,
            "item(s) whose file was moved to another folder on this machine, written here once that folder takes it",
        ),
        (
            report.let_go,
            "file(s) removed whose item another folder on this machine holds, with nothing trashed",
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
    if report.paused > 0 {
        line.push('\n');
        line.push_str(&paused_line(report.paused, true));
    }
    for extra in uncarried_line(&report.uncarried)
        .into_iter()
        .chain(flagged_lines(&report.flagged))
        .chain(embed_lines(&report.embeds))
    {
        line.push('\n');
        line.push_str(&extra);
    }
    line
}

fn describe_status(report: &marfa_core::StatusReport) -> String {
    let in_step = report
        .files
        .iter()
        .filter(|file| file.status == "in_step")
        .count();
    let mut lines = vec![format!("{in_step} file(s) in step")];
    for file in report.files.iter().filter(|file| file.status != "in_step") {
        let mut line = format!("{}: {}", file.path, file.status.replace('_', " "));
        if !file.waits.is_empty() {
            line.push_str(&format!(" ({})", file.waits.join(", ")));
        }
        if let Some(reason) = &file.reason {
            line.push_str(&format!(", {reason}"));
        }
        if let Some(warning) = &file.warning {
            line.push_str(&format!("; {warning}"));
        }
        lines.push(line);
    }
    if report.paused.disk + report.paused.pull > 0 {
        lines.push(format!(
            "a large removal waits: {} file(s) gone from the disk, {} whose items left elsewhere; `folders confirm` lets it go, `folders restore` puts them back",
            report.paused.disk, report.paused.pull
        ));
    }
    lines.join("\n")
}

pub(crate) fn secret_lines(secrets: &[String]) -> Vec<String> {
    secrets
        .iter()
        .map(|path| format!("{path}: not taken, because its name is one a secret goes by"))
        .collect()
}

pub fn paused_line(count: usize, from_pull: bool) -> String {
    if from_pull {
        format!(
            "a large removal waits: {} file(s) left in place whose items left elsewhere; `folders confirm` takes them away, `folders restore` restores the items",
            count
        )
    } else {
        format!(
            "a large removal waits: {} delete(s) not sent; `folders confirm` sends them, `folders restore` writes the files back",
            count
        )
    }
}

fn describe_scan(report: &marfa_core::ScanReport) -> String {
    if let Some(gone) = &report.root_gone {
        return format!("nothing scanned: {gone}");
    }
    let mut line = format!(
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
            (
                report.unreached,
                "bound but not reached, where the lists no longer take them or a package or an unreadable directory holds them, so held rather than deleted",
            ),
        ]
        .into_iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, what)| format!("; {count} {what}"))
        .collect::<String>()
    );
    if report.moved_away > 0 {
        line.push_str(&format!(
            "; {} moved to another folder on this machine, so nothing was trashed",
            report.moved_away
        ));
    }
    let behind = report
        .flagged
        .iter()
        .filter(|file| file.flag == "behind")
        .count();
    let held = report.flagged.len() - behind;
    if held > 0 {
        line.push_str(&format!("; {held} held, not sent"));
    }
    if behind > 0 {
        line.push_str(&format!("; {behind} behind: own-field lines not sent"));
    }
    if report.paused > 0 {
        line.push('\n');
        line.push_str(&paused_line(report.paused, false));
    }
    for said in directory_lines(&report.directories)
        .into_iter()
        .chain(embed_lines(&report.embeds))
        .chain(
            report
                .warnings
                .iter()
                .map(|file| format!("{}: {}", file.path, file.reason)),
        )
        .chain(secret_lines(&report.secrets))
    {
        line.push('\n');
        line.push_str(&said);
    }
    for said in trashed_lines(report) {
        line.push('\n');
        line.push_str(&said);
    }
    line
}

pub fn trashed_lines(report: &marfa_core::ScanReport) -> Vec<String> {
    let registry = report.registry.iter().map(|why| {
        format!("this folder stands alone, since the folder registry cannot be read: {why}")
    });
    let trashed = report.trashed.iter().map(|path| {
        format!("{path} was found in no folder on this machine, so its item was trashed")
    });
    let unsure = report.unsure.iter().map(|file| {
        format!(
            "{} is missing and not trashed, since the other folders cannot all be read: {}",
            file.path, file.reason
        )
    });
    registry.chain(trashed).chain(unsure).collect()
}

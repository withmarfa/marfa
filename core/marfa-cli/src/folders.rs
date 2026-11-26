use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::Subcommand;
use marfa_core::Confirmed;
use marfa_core::folder::Registry;
use marfa_core::{CoreError, FirstSync, Folder, Removal, SendReport, SyncReport, Synced};

use crate::autostart::{self, AutostartCommand};
use crate::commands::folders as folder_settings;
use crate::commands::items::IdempotencyArgs;
use crate::credentials;
use crate::error::{CliError, Exit};
use crate::interrupt;
use crate::keyfile;
use crate::logfile;
use crate::new_build;
use crate::output::{self, Printer, printable};
use crate::remote::{Named, Remote, Session, renewing};
use crate::storage;
use crate::watch;

#[derive(Debug, Subcommand)]
pub enum FoldersCommand {
    /// Make a directory follow a folder, the `system.folder` that
    /// `folders create` makes. Needs read on `system.folder`. Warns on
    /// standard error, once, and goes on, if the directory is in iCloud Drive,
    /// a cloud service's synced location or a network file system, or if git
    /// tracks it.
    Add {
        /// The directory. It is made if it is not there.
        dir: PathBuf,
        /// The folder to follow, by its `system.folder` ID, or by its title
        /// where exactly one folder the credential can read has that title. A
        /// value that is an ID is taken as one.
        #[arg(long, value_name = "ID_OR_TITLE")]
        folder: String,
        /// Confirm the first sync without asking, for scripts. Without it,
        /// the add says what the first sync will do and waits for a go-ahead.
        #[arg(long)]
        yes: bool,
    },
    /// List the directories on this machine that follow a folder, as its
    /// registry holds them. The
    /// registry is the file MARFA_FOLDER_REGISTRY names, where it names one.
    /// With --json, each entry has `dir`, `folder`, `paused` (whether its sync is
    /// paused with `folders pause`), and where the registry
    /// records them, `store` and `root`. `root` is an opaque value that
    /// identifies the directory as it was opened: compare it for equality
    /// and do not parse it.
    List,
    /// List the active folders in Marfa, each with its title and ID, to a
    /// credential that reads `system.folder`.
    Inventory {
        #[command(flatten)]
        page: crate::commands::PageArgs,
    },
    /// List a folder's immediate directories and their file counts.
    ///
    /// Start at the top level or pass a listed path to `--under`. Each directory
    /// has a count of files directly inside it and a count that includes its
    /// subdirectories. The result also counts files at the requested level and
    /// in the whole folder. A key needs read access to `system.folder` and
    /// `in-folder`. Counts include only files the caller can read. A placement
    /// whose stored path no write would accept is left out of every count and
    /// reported as `unreadable_placements`.
    ///
    /// With `--json`, the result has `folder_id`, `under`, `direct_files`,
    /// `total_files`, `unreadable_placements` and `directories`. Each directory has `path`,
    /// `direct_files`, `all_files` and `has_directories`.
    Directories {
        /// The folder's `system.folder` ID.
        id: String,
        /// A directory path from the folder's root, such as `notes/2026`.
        /// Use up to 1024 characters. A leading slash, backslash, NUL or
        /// `..` component is invalid.
        #[arg(long, value_name = "PATH", allow_hyphen_values = true)]
        under: Option<String>,
    },
    /// Make a directory stop following its folder: its own state under
    /// `.marfa` goes, and its files stay as plain files. Empty administrative directories
    /// remain. Refused while writes wait, except for a first sync still
    /// waiting to be confirmed, which this cancels, and except where another
    /// Marfa instance answers at the folder's server, which none of them can
    /// reach: the command then names each file holding a change the folder
    /// could not send, and how to send the changes there. Follows no symbolic
    /// link, and takes a path through one only where it is the path
    /// `folders list` shows. Where that path is gone, passes through a link,
    /// or holds state the registry does not show to be the directory's own, the
    /// directory is only taken off the list and nothing is deleted.
    Remove {
        /// The directory.
        dir: PathBuf,
    },
    /// Say where every file in the directory stands, from its own store,
    /// asking the server nothing, and whether the watch of the directory runs
    /// another build of marfa.
    Status {
        /// The directory.
        dir: PathBuf,
    },
    /// Read the server's latest reports from every sign-in and local copy.
    /// Receipt ages describe reports; they do not establish current reachability.
    Health {
        /// The folder's `system.folder` id.
        id: String,
    },
    /// Pause a directory's sync until `folders resume`. A watch, of one
    /// directory or of every one, skips a paused directory, and `folders push`
    /// and `folders pull` refuse it. The pause is kept in the directory's own
    /// state on this computer, so it lasts through a restart of the watch and
    /// of the computer, and nothing in the directory or in its saved state
    /// changes. A watch that holds the directory lets it go to this command.
    /// Pausing a directory that is paused changes nothing and says so.
    Pause {
        /// The directory.
        dir: PathBuf,
    },
    /// Let a paused directory's sync go on. A watch picks the directory up
    /// again, and the next sync sends what changed in it and pulls what
    /// changed on the server, as a watch that starts again does; conflicts are
    /// handled as they are then. Resuming a directory that is not paused
    /// changes nothing and says so.
    Resume {
        /// The directory.
        dir: PathBuf,
    },
    /// Let a directory's first sync go, or what it holds back: a paused large
    /// removal, whose deletes are queued and whose files that items left
    /// elsewhere are taken away, and new files held for being more than the
    /// addition threshold lets in at once, which are queued as new items.
    Confirm {
        /// The directory.
        dir: PathBuf,
    },
    /// Cancel a paused large removal: files gone from the disk are written
    /// back, and items that left elsewhere are restored.
    Restore {
        /// The directory.
        dir: PathBuf,
    },
    /// Pull what its folder's query needs into the directory's working copy.
    Hydrate {
        /// The directory.
        dir: PathBuf,
    },
    /// Read the directory and queue what has changed. Sends nothing.
    Scan {
        /// The directory.
        dir: PathBuf,
    },
    /// Write what its folder's query matches out as files.
    Pull {
        /// The directory.
        dir: PathBuf,
    },
    /// Scan, drain, catch up, pull, and send the placements the pull queued:
    /// everything a directory does, once. Exits 3 where a write is left unsent or
    /// the catch-up failed, and 5 where the server refused the credential.
    Push {
        /// The directory.
        dir: PathBuf,
        /// Send what the directory holds and go no further: scan and drain,
        /// catch up with nothing and pull nothing, so no item's file is
        /// written into the directory or removed from it. A copy never
        /// hydrated hydrates first, which writes only the directory's store. A
        /// later push without this pulls what the server holds. Refused while
        /// the first sync waits to be confirmed.
        #[arg(long)]
        send_only: bool,
        /// Send every new file this push finds, however many, in place of
        /// holding a drop of more than the folder's `addition_threshold` for
        /// `folders confirm`. For a script that no one is at; the decision is
        /// the script's.
        #[arg(long)]
        confirm_additions: bool,
    },
    /// List the files the directory keeps whose items its folder's query does not match,
    /// as the last pull left them, and with `--remove` take them away. A file
    /// goes only after a confirmation at a terminal or `--yes`, and only
    /// while its bytes are the ones the directory wrote (for a file made from a
    /// new file, the ones it last read) and no edit of it waits to be sent; any other is kept and said. The item stays in
    /// Marfa as it was, and the folder's placement of it ends, sent at the
    /// next push. Also lists, with why, the new files a directory whose folder's `outside_query` is `hold` holds because its query would not hold them; they have no item and
    /// are never taken away. Takes away no `held`, `outside` or `unreached` file. With
    /// `--remove`, a watch holding the directory lets it go while this runs, and
    /// this is refused if the process holding the directory does not let it go
    /// within 10 seconds. Use `--remove` to keep the item when removing its
    /// file. Deleting the file by hand can send the item to the bin. Also
    /// lists, with why, each removal Marfa stopped on and holds, and never
    /// takes its file away. Where Marfa cannot read the record of one and no
    /// file is at its path in the directory itself, `--remove` ends it: the
    /// folder stops following the path, and its item stays in Marfa as it
    /// was.
    Unmatched {
        /// The directory.
        dir: PathBuf,
        /// Take the files away, after a confirmation.
        #[arg(long)]
        remove: bool,
        /// Confirm the removal without asking, for scripts. Without it, a
        /// removal asks at a terminal, and is refused with `--json` or
        /// anywhere else.
        #[arg(long, requires = "remove")]
        yes: bool,
    },
    /// List the files the directory keeps under a reserved name because a
    /// program might still write to them, and with `--discard` delete them.
    /// When a pull replaces or removes a file that a program holds open for
    /// writing, or one where Marfa cannot tell, it sets the old file aside under
    /// a name starting `.marfa-kept-`. Marfa deletes it once no program holds it,
    /// or, where it cannot tell, once it has been unchanged for 7 days. A file
    /// a program wrote to goes back to its path, and the next push sends what
    /// the program wrote; `--discard` puts such a file back too, in place of
    /// deleting it. One whose record Marfa could not read is deleted only
    /// while it holds the bytes Marfa set aside and its directory is the one
    /// in the folder that the record names, and is listed still otherwise.
    /// Every file a discard Marfa stopped on left under another reserved name
    /// is listed, and so is a record of one whose file is not where it says.
    /// A file an earlier release moved aside in another folder's directory as
    /// it took the file in is listed while Marfa cannot tell that directory
    /// is the one it recorded, and Marfa never deletes it. `--discard` forgets
    /// such a record where nothing is at its path, and deletes no file for
    /// it. With `--discard`, a watch
    /// holding the directory lets it go while this runs, and this is refused
    /// if the process holding the directory does not let it go within 10
    /// seconds.
    Kept {
        /// The directory.
        dir: PathBuf,
        /// Delete the files, after a confirmation, whatever programs hold them.
        #[arg(long)]
        discard: bool,
        /// Confirm the deletion without asking, for scripts. Without it, a
        /// deletion asks at a terminal, and is refused with `--json` or
        /// anywhere else.
        #[arg(long, requires = "discard")]
        yes: bool,
    },
    /// List the files whose deletion the directory holds because Marfa cannot
    /// tell whether each was deleted or moved into another folder on this
    /// computer, and settle them one by one. No scan or pull deletes a held
    /// file's item or writes the file again, and a hold lasts until it is
    /// settled. With `--trash`, the delete of each named file's item is
    /// queued, checked against the version Marfa last read, and sent at the
    /// next push, after a confirmation at a terminal or `--yes`; a file that
    /// one other folder Marfa can read now holds keeps its item. With
    /// `--keep`, each named file's item stays in Marfa as it is and the
    /// folder's binding and placement of it end; while the folder's query
    /// holds the item, a later pull writes the file again. With `--write-back`
    /// as well, the file is written again at once, unless another item's file
    /// is at its path. A path where a file is now stays held and is left
    /// alone. A watch holding the directory lets it go while this runs.
    Held {
        /// The directory.
        dir: PathBuf,
        /// Trash the items of these held files, by their paths in the directory.
        #[arg(long, num_args = 1.., value_name = "PATH", conflicts_with = "keep")]
        trash: Vec<String>,
        /// Keep the items of these held files, by their paths in the directory.
        #[arg(long, num_args = 1.., value_name = "PATH")]
        keep: Vec<String>,
        /// Write each kept file again at once where the folder's query holds
        /// its item. A file whose path another item's file took stays held.
        #[arg(long, requires = "keep")]
        write_back: bool,
        /// Confirm the trash without asking, for scripts. Without it, a trash
        /// asks at a terminal, and is refused with `--json` or anywhere else.
        #[arg(long, requires = "trash")]
        yes: bool,
    },
    /// Create a folder's settings on the server, as a `system.folder`.
    /// Needs write on `system.folder`.
    Create(folder_settings::CreateArgs),
    /// Change a folder's settings on the server, each named one replaced whole.
    /// Omitted settings stay. Every accepted change removes stored properties
    /// the current folder type does not declare, including with --file or --body.
    Update(folder_settings::UpdateArgs),
    /// Retire a folder's settings on the server. A revoked folder does not change.
    Revoke {
        /// The folder's `system.folder` id.
        id: String,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Watch a directory and keep it in step, or every directory on this
    /// machine. Warns on standard error, once per directory, and goes on, if a
    /// directory is in iCloud Drive, a cloud service's synced location or a
    /// network file system. `SIGTERM` stops it as Ctrl-C does, and it then
    /// exits 0, so a service manager that stopped it does not start it again.
    /// A command that works a directory the watch holds, such as `folders
    /// confirm`, asks for it: the watch lets it go at the end of the step of
    /// its pass under way, and takes it back once the command ends.
    Watch {
        /// The directory to watch, recursively. Without one, the command
        /// watches every directory the folder registry lists, in one process.
        /// Each directory uses the server its copy came from, and each line
        /// names its directory. A directory added or removed while the watch
        /// runs joins or leaves it. A directory that can't be watched is
        /// reported once and tried again. A directory whose sign-in ended is reported once as
        /// `signed_out` and is not tried again with that sign-in; it is
        /// watched once `marfa login` or `marfa keys keep` keeps a new
        /// credential, and the other directories go on. A watch of one directory ends
        /// with exit status 5 when its sign-in ends. Either way the watch keeps
        /// a record of its directories in `folder-watch.json` beside the registry,
        /// for other programs on the machine to read.
        dir: Option<PathBuf>,
        /// Stop after this long. Unset, it runs until interrupted.
        #[arg(long = "for-seconds", value_name = "SECONDS")]
        r#for: Option<u64>,
        /// Write what the watch prints, and its errors, to this file in place
        /// of the terminal. A file of 1 MiB or more is moved to the same name
        /// with `.1` added, replacing the one there, when the watch starts and
        /// as it runs. `folders autostart` runs the watch with it. When Ctrl-C
        /// or `SIGTERM` stops the watch, the last line written names the
        /// signal and the time, and the process that sent it where the system
        /// reports one.
        #[arg(long, value_name = "FILE")]
        log: Option<PathBuf>,
        /// A file that holds `MARFA_API_URL` and `MARFA_API_KEY` lines, which
        /// only you can read (mode 600), for a watch that runs with nobody
        /// signed in to unlock the keychain. The watch uses it for the
        /// directories that name that server and reads the keychain for none,
        /// so a directory of another server is reported as having no
        /// credential. Keep the file outside every directory. `folders autostart on --key-file` runs
        /// the watch with it.
        #[arg(long, value_name = "FILE")]
        key_file: Option<PathBuf>,
        /// End with exit status 3 once a new build of marfa is installed at
        /// the path the watch was started by, after the passes under way
        /// finish, so that a service manager starts the new build. A link
        /// moved to another build counts, as does a file replaced in place.
        /// `folders autostart` runs the watch with it. Without it, the watch
        /// says once that a new build is installed and goes on. Either way, a
        /// path that leads to no file, or to one that does not say its
        /// version, is said once, and the watch goes on.
        #[arg(long)]
        exit_on_new_build: bool,
    },
    /// Sync every directory from login, in your own account: a launchd agent on
    /// macOS or a systemd user unit on Linux runs `folders watch` with no
    /// directory. Supported on macOS and Linux.
    Autostart {
        #[command(subcommand)]
        command: AutostartCommand,
    },
}

/// A push that left a write undelivered, or could not catch up with the
/// server, has not finished its work: the environment's exit says to try
/// again. A refused credential is the credential's.
fn sync_exit(drain: &marfa_core::DrainReport, caught_up: bool) -> Exit {
    match output::drain_exit(drain) {
        Exit::Done if !caught_up => Exit::Environment,
        exit => exit,
    }
}

pub fn run(
    command: FoldersCommand,
    named: &Named,
    socket: Option<&Path>,
    json: bool,
) -> Result<Exit, CliError> {
    let mut exit = Exit::Done;
    let done = match command {
        FoldersCommand::Add { dir, folder, yes } => {
            let session = named.session()?;
            let folder = folder_id(&folder, || {
                let request = crate::remote::request::Request::get(&["folders"]);
                Remote::resolve(named)?.pages(&request, true)
            })?;
            let folder = Folder::add(&dir, &folder, Some(session.server), session.renew)
                .map_err(asked(&dir))?;
            say_replaced(&folder);
            storage::warn(&folder);
            storage::warn_git(&folder);
            // Told what the first sync will do before it can, unless the
            // person said to go ahead.
            let (mut plan, mut confirmed, mut unread) = (None, true, None);
            if yes {
                folder.confirm_first_sync()?;
            } else if folder.awaiting_confirmation()? {
                // The folder is added whether or not it could be read now.
                match folder.plan_first_sync() {
                    Ok(planned) => {
                        plan = planned;
                        confirmed = plan.is_none();
                    }
                    Err(error) => {
                        confirmed = false;
                        unread = Some(error.to_string());
                    }
                }
                if let Some(plan) = &plan
                    && !json
                    && asks_to_go_ahead(&dir, plan)?
                {
                    folder.confirm_first_sync()?;
                    confirmed = true;
                }
            }
            output::report(
                &serde_json::json!({
                    "dir": folder.root(),
                    "folder": folder.folder_id(),
                    "first_sync": first_sync_json(plan.as_ref(), confirmed, unread.as_deref()),
                }),
                json,
                || {
                    let mut lines = vec![format!(
                        "{} follows the folder {}",
                        folder.root().display(),
                        printable(folder.folder_id())
                    )];
                    lines.extend(first_sync_lines(&dir, plan.as_ref(), confirmed));
                    if let Some(error) = &unread {
                        lines.push(format!(
                            "the first sync waits for confirmation, but the directory could not be read for it now: {}; `folders push` tries again",
                            printable(&error.to_string())
                        ));
                    }
                    lines.join("\n")
                },
            )
        }
        FoldersCommand::Inventory { page } => {
            let request = crate::remote::request::Request::get(&["folders"])
                .query_opt("limit", page.limit.map(|n| n.to_string()))
                .query_opt("cursor", page.cursor);
            let remote = match socket {
                Some(path) => Remote::local(path)?,
                None => Remote::resolve(named)?,
            };
            Printer { json }.value(&remote.pages(&request, page.all)?)
        }
        FoldersCommand::List => {
            let listed = match Registry::located() {
                Some(registry) => registry.folders()?,
                None => Vec::new(),
            };
            let listed: Vec<ListedFolder<'_>> = listed
                .iter()
                .map(|entry| ListedFolder {
                    paused: Folder::paused_at(&entry.dir),
                    entry,
                })
                .collect();
            output::list_report(&listed, None, json, || {
                if listed.is_empty() {
                    return "no directory on this machine follows a folder".into();
                }
                listed
                    .iter()
                    .map(|listed| {
                        format!(
                            "{} follows the folder {}{}",
                            listed.entry.dir.display(),
                            printable(&listed.entry.folder),
                            if listed.paused { " (paused)" } else { "" }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        }
        FoldersCommand::Remove { dir } => {
            match Folder::remove_at_asking(&dir).map_err(asked(&dir))? {
                Removal::Deleted {
                    dir,
                    folder,
                    unsent,
                } => output::report(
                    &serde_json::json!({
                        "dir": dir,
                        "removed": true,
                        "folder": folder,
                        "unsent": unsent.writes,
                        "files": unsent.files,
                    }),
                    json,
                    || removed_said(&dir, &folder, &unsent),
                ),
                Removal::Unlisted { dir, reason } => output::report(
                    &serde_json::json!({ "dir": dir, "removed": false, "reason": reason }),
                    json,
                    || {
                        format!(
                            "{} was taken off the list; nothing was deleted because {}",
                            dir.display(),
                            printable(&reason)
                        )
                    },
                ),
            }
        }
        FoldersCommand::Status { dir } => {
            let stopped = watch::stopped_for_another_instance(&dir);
            let report =
                Folder::status_of(&dir).map_err(|error| status_refused(error, stopped.clone()))?;
            let stopped = stopped
                .as_deref()
                .map(marfa_core::folder::instance_changed_said);
            let other = new_build::other_build_watching(&dir);
            output::report(
                &FolderStatus {
                    report: &report,
                    watch_other_build: other.as_ref(),
                    watch_stopped: stopped.as_deref(),
                },
                json,
                || {
                    let mut text = describe_status(&report);
                    for line in other
                        .as_ref()
                        .map(new_build::OtherBuild::describe)
                        .into_iter()
                        .chain(stopped.clone())
                    {
                        text.push('\n');
                        text.push_str(&line);
                    }
                    text
                },
            )
        }
        FoldersCommand::Health { id } => {
            let report = Remote::resolve(named)?.json(&crate::remote::request::Request::get(&[
                "folders", &id, "status",
            ]))?;
            output::report(&report, json, || describe_health(&report))
        }
        FoldersCommand::Directories { id, under } => {
            let request = crate::remote::request::Request::get(&["folders", &id, "directories"])
                .query_opt("under", under);
            let remote = match socket {
                Some(path) => Remote::local(path)?,
                None => Remote::resolve(named)?,
            };
            let report = remote.json(&request)?;
            output::report(&report, json, || describe_directories(&report))
        }
        FoldersCommand::Pause { dir } => {
            let folder = working(&dir, named.session_if_named()?)?;
            let changed = folder.pause_sync()?;
            paused_report(&folder, true, changed, json)
        }
        FoldersCommand::Resume { dir } => {
            let folder = working(&dir, named.session_if_named()?)?;
            let changed = folder.resume_sync()?;
            paused_report(&folder, false, changed, json)
        }
        FoldersCommand::Confirm { dir } => {
            let folder = working(&dir, None)?;
            // The first sync goes first; a removal paused beside it waits for
            // the next confirm.
            let first_sync = folder.confirm_first_sync()?;
            let confirmed = if first_sync {
                Confirmed::default()
            } else {
                folder.confirm()?
            };
            output::report(
                &serde_json::json!({
                    "first_sync": first_sync,
                    "deleted": confirmed.deleted,
                    "moved": confirmed.moved,
                    "unsure": confirmed.unsure,
                    "removed": confirmed.removed,
                    "added": confirmed.added,
                    "refused": confirmed.refused,
                }),
                json,
                || {
                    if first_sync {
                        return "the first sync is confirmed; `folders push` or `folders watch` runs it"
                            .into();
                    }
                    format!(
                        "{} delete(s) waiting, sent at the next push; {} file(s) found in another directory, whose items stay; {} file(s) taken away; {} new file(s) waiting to become items, sent at the next push{}",
                        confirmed.deleted,
                        confirmed.moved,
                        confirmed.removed,
                        confirmed.added,
                        confirmed
                            .unsure
                            .iter()
                            .map(|file| format!(
                                "\n{}: not let go yet, {}",
                                printable(&file.path),
                                printable(&file.reason)
                            ))
                            .chain(confirmed.refused.iter().map(|file| format!(
                                "\n{}: not taken away, still paused; {}",
                                printable(&file.path),
                                printable(&file.reason)
                            )))
                            .collect::<String>()
                    )
                },
            )
        }
        FoldersCommand::Restore { dir } => {
            let restored = working(&dir, named.session_if_named()?)?.restore()?;
            output::report(&restored, json, || {
                let unwritten = match restored.not_written_back.len() {
                    0 => String::new(),
                    left => format!(
                        "; {left} file(s) not written back yet, which every pull tries again{}",
                        restored
                            .not_written_back
                            .iter()
                            .map(|file| format!(
                                "\n{}: {}",
                                printable(&file.path),
                                printable(&file.reason)
                            ))
                            .collect::<String>()
                    ),
                };
                format!(
                    "{} file(s) written back; {} item(s) restored, sent at the next push{unwritten}",
                    restored.put_back, restored.restored
                )
            })
        }
        FoldersCommand::Hydrate { dir } => {
            let folder = working(&dir, Some(named.session()?))?;
            let report = folder.hydrate()?;
            output::report(&report, json, || {
                format!("{} item(s) into {}", report.items, dir.display())
            })
        }
        FoldersCommand::Scan { dir } => {
            let report = working(&dir, None)?.scan()?;
            output::report(&report, json, || describe_scan(&report))
        }
        FoldersCommand::Pull { dir } => {
            // Optional: without a server, unheld bytes are reported, not fetched.
            let report = working(&dir, named.session_if_named()?)?.pull()?;
            output::report(&report, json, || describe_pull(&report))
        }
        FoldersCommand::Push {
            dir,
            send_only: true,
            confirm_additions,
        } => {
            let folder = working(&dir, Some(named.session()?))?;
            if confirm_additions {
                folder.allow_additions()?;
            }
            let SendReport {
                hydrated,
                settings,
                scan: scanned,
                drain: drained,
                rebuilt,
            } = folder.send_only()?;
            exit = output::drain_exit(&drained.report);
            output::report(
                &serde_json::json!({
                    "send_only": true,
                    "pulled": false,
                    "hydrated": hydrated,
                    "settings": settings,
                    "scan": scanned,
                    "drain": drained,
                    "rebuilt": rebuilt,
                }),
                json,
                || {
                    let mut lines = Vec::new();
                    if let Some(hydrated) = &hydrated {
                        lines.push(format!(
                            "read {} item(s) from the server first",
                            hydrated.items
                        ));
                    }
                    lines.extend(settings_lines(&settings, None));
                    lines.push(describe_scan(&scanned));
                    lines.extend(flagged_lines(&scanned.flagged));
                    lines.extend(embed_lines(&scanned.embeds));
                    lines.extend(rebuilt_line(rebuilt.as_ref()));
                    lines.extend(drain_lines(&folder, &drained));
                    lines.push(
                        "send-only run: nothing was pulled, so no item's file was written or removed; the next `folders push` pulls what the server holds"
                            .into(),
                    );
                    lines.join("\n")
                },
            )
        }
        FoldersCommand::Push {
            dir,
            send_only: false,
            confirm_additions,
        } => {
            let folder = working(&dir, Some(named.session()?))?;
            if confirm_additions {
                folder.allow_additions()?;
            }
            let SyncReport {
                hydrated,
                settings,
                scan: scanned,
                drain: drained,
                rebuilt,
                catch_up,
                pull: pulled,
                beneath,
            } = match folder.sync()? {
                Synced::Done(report) => *report,
                Synced::Waiting(plan) => {
                    return output::report(
                        &serde_json::json!({ "first_sync": first_sync_json(Some(&plan), false, None) }),
                        json,
                        || first_sync_lines(&dir, Some(&plan), false).join("\n"),
                    )
                    .map(|()| Exit::Done);
                }
            };
            exit = sync_exit(&drained.report, catch_up.is_ok());
            let (caught, failed) = match catch_up {
                Ok(caught) => (serde_json::to_value(caught)?, None),
                Err(error) => (
                    serde_json::json!({ "failed": error.to_string() }),
                    Some(error),
                ),
            };
            output::report(
                &serde_json::json!({
                    "hydrated": hydrated,
                    "settings": settings,
                    "scan": scanned,
                    "drain": drained,
                    "rebuilt": rebuilt,
                    "catch_up": caught,
                    "pull": pulled,
                    "beneath": beneath,
                }),
                json,
                || {
                    let mut lines = Vec::new();
                    if let Some(hydrated) = &hydrated {
                        lines.push(format!(
                            "read {} item(s) from the server first",
                            hydrated.items
                        ));
                    }
                    lines.extend(settings_lines(
                        &settings,
                        pulled.as_ref().map(|pulled| &pulled.settings),
                    ));
                    lines.push(describe_scan(&scanned));
                    let flagged = marfa_core::folder::merged_flagged(
                        &scanned.flagged,
                        pulled.iter().flat_map(|pulled| &pulled.flagged),
                    );
                    if let Some(pulled) = &pulled {
                        lines.extend(uncarried_line(&pulled.uncarried));
                        if pulled.paused > 0 {
                            lines.push(paused_line(pulled.paused, true));
                        }
                    }
                    lines.extend(flagged_lines(&flagged));
                    lines.extend(embed_lines(
                        scanned
                            .embeds
                            .iter()
                            .chain(pulled.iter().flat_map(|pulled| &pulled.embeds)),
                    ));
                    lines.extend(rebuilt_line(rebuilt.as_ref()));
                    lines.extend(drain_lines(&folder, &drained));
                    lines.extend(beneath_line(beneath.as_ref()));
                    if let Some(error) = &failed {
                        lines.push(format!(
                            "could not catch up: {}",
                            printable(&error.to_string())
                        ));
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
                        None => "nothing written: the folder's items could not be read from the server, and the next push tries again".into(),
                    });
                    lines.join("\n")
                },
            )
        }
        FoldersCommand::Unmatched { dir, remove, yes } => unmatched(&dir, remove, yes, json),
        FoldersCommand::Kept { dir, discard, yes } => kept(&dir, discard, yes, json),
        FoldersCommand::Held {
            dir,
            trash,
            keep,
            write_back,
            yes,
        } => held_files(&dir, &trash, &keep, write_back, yes, named, json),
        FoldersCommand::Watch {
            dir,
            r#for,
            log,
            key_file,
            exit_on_new_build,
        } => {
            interrupt::stop_on_terminate_too();
            if let Some(log) = &log {
                logfile::redirect(log)?;
            }
            let keyed;
            let named = match &key_file {
                Some(path) => {
                    keyed = from_key_file(path, dir.as_deref(), named)?;
                    &keyed
                }
                None => named,
            };
            new_build::look_out(exit_on_new_build, json);
            let ended = match dir {
                Some(dir) => watch::watch(&dir, named, r#for.map(Duration::from_secs), json),
                None => watch::watch_every(named, r#for, json),
            };
            if log.is_some() {
                logfile::note_stop();
            }
            // A service manager starts again only a watch that failed, and
            // one it stopped itself stays stopped.
            if ended.is_ok() && new_build::ended_for_it() && !interrupt::asked_to_stop() {
                exit = Exit::Environment;
            }
            ended
        }
        FoldersCommand::Autostart { command } => autostart::run(command, named, json),
        FoldersCommand::Create(args) => send(folder_settings::create_request(&args)?, named, json),
        FoldersCommand::Update(args) => send(folder_settings::update_request(&args)?, named, json),
        FoldersCommand::Revoke { id, idempotency } => send(
            folder_settings::revoke_request(&id, &idempotency),
            named,
            json,
        ),
    };
    done.map(|()| exit)
}

/// The command's own server and key, taken from a key file. The keychain is
/// turned off, so that a folder of another server is reported without a
/// credential rather than looked up where nobody can answer a prompt. The
/// file is read again each time a folder is opened (see `keyfile::active`).
fn from_key_file(path: &Path, dir: Option<&Path>, named: &Named) -> Result<Named, CliError> {
    if named.on_command_line() {
        return Err(CliError::Usage(
            "--key-file holds the server and key, so it takes none of --url, --key and --profile"
                .into(),
        ));
    }
    keyfile::activate(path, dir)?;
    credentials::turn_off();
    let held = keyfile::active().ok_or_else(|| {
        CliError::Usage("the key file could not be made the watch's own".into())
    })??;
    Ok(Named {
        url: Some(held.url),
        key: Some(held.key),
        profile: None,
    })
}

fn unmatched(dir: &Path, remove: bool, yes: bool, json: bool) -> Result<(), CliError> {
    if !remove {
        let files = Folder::unmatched_of(dir)?;
        return output::report(&serde_json::json!({ "unmatched": files }), json, || {
            describe_unmatched(&files)
        });
    }
    let at_terminal =
        !json && std::io::stdin().is_terminal() && crate::output::stderr_is_terminal();
    if !yes && !at_terminal {
        return Err(CliError::Usage(
            "`folders unmatched --remove` asks only at a terminal and without --json, and otherwise takes away nothing; pass --yes to confirm it".into(),
        ));
    }
    let folder = working(dir, None)?;
    let files = folder.unmatched_files()?;
    let going: Vec<&marfa_core::Unmatched> = files
        .iter()
        .filter(|file| file.kept.is_none() && file.held.is_none())
        .collect();
    let agreed = going.is_empty() || yes || asks_to_remove(dir, &going)?;
    let going: Vec<String> = going.into_iter().map(|file| file.path.clone()).collect();
    let done = if agreed {
        folder.remove_unmatched(&going)?
    } else {
        Default::default()
    };
    // What was kept before the question is kept still, whether or not it was asked.
    let kept: Vec<_> = files
        .iter()
        .filter(|file| file.kept.is_some())
        .cloned()
        .chain(done.kept.iter().cloned())
        .collect();
    output::report(
        &serde_json::json!({
            "removed": done.removed,
            "kept": kept,
            "ended": done.ended,
            "settled": done.settled,
            "declined": !agreed,
        }),
        json,
        || {
            let mut lines = vec![if !agreed {
                "nothing was removed".to_string()
            } else if done.removed.is_empty() {
                "no file was removed".to_string()
            } else {
                format!(
                    "{} file(s) removed; their items are unchanged in Marfa, and the folder's placement of each ends, sent at the next `folders push`",
                    done.removed.len()
                )
            }];
            lines.extend(done.settled.iter().map(|file| {
                format!(
                    "{}: the removal Marfa stopped on ended; its item is unchanged in Marfa",
                    printable(&file.path)
                )
            }));
            lines.extend(kept_lines(&kept));
            lines.join("\n")
        },
    )
}

fn kept(dir: &Path, discard: bool, yes: bool, json: bool) -> Result<(), CliError> {
    if !discard {
        let files = Folder::kept_of(dir)?;
        return output::report(&serde_json::json!({ "kept": files }), json, || {
            describe_kept(&files)
        });
    }
    let at_terminal =
        !json && std::io::stdin().is_terminal() && crate::output::stderr_is_terminal();
    if !yes && !at_terminal {
        return Err(CliError::Usage(
            "`folders kept --discard` asks only at a terminal and without --json, and otherwise deletes nothing; pass --yes to confirm it".into(),
        ));
    }
    let folder = working(dir, None)?;
    let files = folder.kept_files()?;
    let going: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
    let agreed = going.is_empty() || yes || asks_to_discard(dir, &going)?;
    let done = if agreed {
        folder.discard_kept()?
    } else {
        marfa_core::KeptDiscarded {
            kept: files,
            ..Default::default()
        }
    };
    output::report(
        &serde_json::json!({
            "discarded": done.discarded,
            "put_back": done.put_back,
            "kept": done.kept,
            "forgotten": done.forgotten,
            "declined": !agreed,
        }),
        json,
        || {
            let mut lines = vec![if !agreed {
                "nothing was deleted".to_string()
            } else {
                format!("{} kept file(s) deleted", done.discarded.len())
            }];
            lines.extend(done.put_back.iter().map(|path| {
                format!(
                    "{}: a program wrote to the file set aside from it, so Marfa put that file back, and the next push sends it",
                    printable(path)
                )
            }));
            lines.extend(done.forgotten.iter().map(|path| {
                format!(
                    "{}: no file is there, so Marfa forgot its record of it",
                    printable(path)
                )
            }));
            if agreed {
                lines.extend(done.kept.iter().map(|file| {
                    format!(
                        "{} is still kept: Marfa could not reach it",
                        printable(&file.path)
                    )
                }));
            }
            lines.join("\n")
        },
    )
}

fn held_files(
    dir: &Path,
    trash: &[String],
    keep: &[String],
    write_back: bool,
    yes: bool,
    named: &Named,
    json: bool,
) -> Result<(), CliError> {
    if trash.is_empty() && keep.is_empty() {
        let files = Folder::held_of(dir)?;
        return output::report(&serde_json::json!({ "held": files }), json, || {
            describe_held(&files)
        });
    }
    let at_terminal =
        !json && std::io::stdin().is_terminal() && crate::output::stderr_is_terminal();
    if !trash.is_empty() && !yes && !at_terminal {
        return Err(CliError::Usage(
            "`folders held --trash` asks only at a terminal and without --json, and otherwise trashes nothing; pass --yes to confirm it".into(),
        ));
    }
    // Writing a file item back fetches its bytes.
    let server = if write_back {
        named.session_if_named()?
    } else {
        None
    };
    let folder = working(dir, server)?;
    let (paths, settle) = if trash.is_empty() {
        (keep, marfa_core::Settle::Keep { write_back })
    } else {
        (trash, marfa_core::Settle::Trash)
    };
    let agreed = keep.len() == paths.len() || yes || asks_to_trash(dir, trash)?;
    let done = if agreed {
        folder.settle_held(paths, settle)?
    } else {
        Default::default()
    };
    output::report(
        &serde_json::json!({
            "trashed": done.trashed,
            "gone": done.gone,
            "moved": done.moved,
            "kept": done.kept,
            "written_back": done.written_back,
            "not_written_back": done.not_written_back,
            "not_settled": done.not_settled,
            "declined": !agreed,
        }),
        json,
        || {
            if !agreed {
                return "nothing was trashed".into();
            }
            let mut lines = Vec::new();
            if !done.trashed.is_empty() {
                lines.push(format!(
                    "{} item(s) to the bin, sent at the next push",
                    done.trashed.len()
                ));
            }
            lines.extend(done.gone.iter().map(|path| {
                format!(
                    "{}: its item is already in the bin or gone, so the folder lets it go",
                    printable(path)
                )
            }));
            lines.extend(done.moved.iter().map(|path| {
                format!(
                    "{}: found in another folder, so its item stays",
                    printable(path)
                )
            }));
            if !done.kept.is_empty() {
                lines.push(format!(
                    "{} item(s) kept; the folder's placement of each ends, sent at the next push, unless its file is written again",
                    done.kept.len()
                ));
            }
            lines.extend(
                done.written_back
                    .iter()
                    .map(|path| format!("{}: written again", printable(path))),
            );
            lines.extend(done.not_written_back.iter().map(|file| {
                format!(
                    "{}: not written again, {}",
                    printable(&file.path),
                    printable(&file.reason)
                )
            }));
            lines.extend(done.not_settled.iter().map(|file| {
                format!(
                    "{}: not settled, {}",
                    printable(&file.path),
                    printable(&file.reason)
                )
            }));
            if lines.is_empty() {
                "nothing was settled".into()
            } else {
                lines.join("\n")
            }
        },
    )
}

fn describe_held(files: &[marfa_core::HeldFile]) -> String {
    if files.is_empty() {
        return "no held files".into();
    }
    let mut lines = vec![format!(
        "{} held file(s), which `folders held --trash` or `--keep` settles",
        files.len()
    )];
    lines.extend(
        files
            .iter()
            .map(|file| format!("{} {}", printable(&file.path), printable(&file.reason))),
    );
    lines.join("\n")
}

/// Asks at a terminal; the caller has already made sure there is one.
fn asks_to_trash(dir: &Path, going: &[String]) -> Result<bool, CliError> {
    use std::io::{BufRead, Write};
    let mut question = crate::output::stderr();
    writeln!(
        question,
        "The items of {} held file(s) in {} would go to the bin. A file another folder now holds keeps its item:",
        going.len(),
        dir.display()
    )?;
    for path in going {
        writeln!(question, "  {}", printable(path))?;
    }
    write!(question, "Trash them? [y/N] ")?;
    question.flush()?;
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    Ok(matches!(answer.trim().to_lowercase().as_str(), "y" | "yes"))
}

fn describe_kept(files: &[marfa_core::KeptFile]) -> String {
    if files.is_empty() {
        return "no kept files".into();
    }
    let mut lines = vec![format!(
        "{} kept file(s), which `folders kept --discard` deletes",
        files.len()
    )];
    lines.extend(
        files
            .iter()
            .map(|file| format!("{} {}", printable(&file.path), printable(&file.reason))),
    );
    lines.join("\n")
}

/// Asks at a terminal; the caller has already made sure there is one.
fn asks_to_discard(dir: &Path, going: &[String]) -> Result<bool, CliError> {
    use std::io::{BufRead, Write};
    let mut question = crate::output::stderr();
    writeln!(
        question,
        "{} kept file(s) in {} would be deleted. A file a program wrote to goes back to its path instead, or is kept where Marfa could not read its record. A record Marfa cannot read with no file at its path in the directory itself is forgotten, and no file is deleted for it; one in another directory stays listed:",
        going.len(),
        dir.display()
    )?;
    for path in going {
        writeln!(question, "  {}", printable(path))?;
    }
    write!(question, "Delete them? [y/N] ")?;
    question.flush()?;
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    Ok(matches!(answer.trim().to_lowercase().as_str(), "y" | "yes"))
}

fn kept_lines(kept: &[marfa_core::Unmatched]) -> Vec<String> {
    kept.iter()
        .filter_map(|file| {
            file.kept
                .as_ref()
                .map(|reason| format!("{} is kept: {}", printable(&file.path), printable(reason)))
        })
        .collect()
}

fn describe_unmatched(files: &[marfa_core::Unmatched]) -> String {
    if files.is_empty() {
        return "no unmatched files".into();
    }
    let removable = files
        .iter()
        .filter(|file| file.kept.is_none() && file.held.is_none())
        .count();
    let mut lines = vec![format!(
        "{} unmatched file(s), {removable} of them removable with `folders unmatched --remove`",
        files.len()
    )];
    lines.extend(files.iter().map(|file| {
        match (&file.kept, file.held.as_ref().or(file.removing.as_ref())) {
            (_, Some(reason)) => format!("{} {}", printable(&file.path), printable(reason)),
            (Some(reason), None) => format!(
                "{} would be kept: {}",
                printable(&file.path),
                printable(reason)
            ),
            (None, None) => printable(&file.path),
        }
    }));
    lines.join("\n")
}

/// Asks at a terminal; the caller has already made sure there is one.
fn asks_to_remove(dir: &Path, going: &[&marfa_core::Unmatched]) -> Result<bool, CliError> {
    use std::io::{BufRead, Write};
    let (ending, removing): (Vec<&marfa_core::Unmatched>, Vec<&marfa_core::Unmatched>) =
        going.iter().partition(|file| file.removing.is_some());
    let mut question = crate::output::stderr();
    if !removing.is_empty() {
        writeln!(
            question,
            "{} unmatched file(s) in {} would be removed; their items stay in Marfa as they are:",
            removing.len(),
            dir.display()
        )?;
        for file in &removing {
            writeln!(question, "  {}", printable(&file.path))?;
        }
    }
    if !ending.is_empty() {
        writeln!(
            question,
            "{} removal(s) Marfa stopped on in {} would end. No file is at their paths, so no file is removed: the folder stops following each path, and its item stays in Marfa as it is:",
            ending.len(),
            dir.display()
        )?;
        for file in &ending {
            writeln!(question, "  {}", printable(&file.path))?;
        }
    }
    // Nothing is removed for a removal it ends, so the question says so.
    if ending.is_empty() {
        write!(question, "Remove them? [y/N] ")?;
    } else {
        write!(question, "Go ahead? [y/N] ")?;
    }
    question.flush()?;
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    Ok(matches!(answer.trim().to_lowercase().as_str(), "y" | "yes"))
}

/// Whether `text` is an ID as the server mints one: hyphenated, 36 characters.
fn is_folder_id(text: &str) -> bool {
    text.len() == 36
        && text.char_indices().all(|(at, found)| match at {
            8 | 13 | 18 | 23 => found == '-',
            _ => found.is_ascii_hexdigit(),
        })
}

/// The ID of the folder `value` names: an ID as it is, any other value as an exact title.
fn folder_id(
    value: &str,
    listing: impl FnOnce() -> Result<serde_json::Value, CliError>,
) -> Result<String, CliError> {
    if is_folder_id(value) {
        return Ok(value.to_string());
    }
    let listed = listing()?;
    let matches: Vec<&str> = listed["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|folder| folder["title"].as_str() == Some(value))
        .filter_map(|folder| folder["id"].as_str())
        .collect();
    match matches.as_slice() {
        [only] => Ok((*only).to_string()),
        [] => Err(CliError::Invalid(format!(
            "no folder titled \"{}\" that this credential can read; `marfa folders inventory` lists the folders, and `--folder` also takes a folder's ID",
            printable(value)
        ))),
        several => Err(CliError::Invalid(format!(
            "{} folders are titled \"{}\", so nothing was added; pass the ID of the one to follow:\n{}",
            several.len(),
            printable(value),
            several
                .iter()
                .map(|id| format!("  {}", printable(id)))
                .collect::<Vec<_>>()
                .join("\n")
        ))),
    }
}

fn rebuilt_line(rebuilt: Option<&marfa_core::HydrateReport>) -> Option<String> {
    rebuilt.map(|rebuilt| {
        format!(
            "the server's reach changed, so the folder's items were read from the server again ({} item(s)) before the waiting changes were sent",
            rebuilt.items
        )
    })
}

fn beneath_line(beneath: Option<&marfa_core::folder::BeneathReport>) -> Option<String> {
    let beneath = beneath?;
    Some(match (&beneath.resolved, &beneath.waiting) {
        (Some(item), _) => format!(
            "the folder now narrows beneath item {item}, which {} became",
            printable(&beneath.path)
        ),
        (None, Some(why)) => format!(
            "the folder holds nothing from the server until its query names the item of {}: {}",
            printable(&beneath.path),
            printable(why)
        ),
        (None, None) => return None,
    })
}

/// What a push sent to the server and what came of it, said once.
fn drain_lines(folder: &Folder, drained: &marfa_core::Drained) -> Vec<String> {
    let mut lines = vec![output::folder_counts(&drained.report)];
    lines.extend(Conflicts::default().say(folder, &drained.report));
    lines.extend(output::folder_undelivered(&drained.report, "the next push"));
    if drained.report.undelivered > 0
        && let Some(wait) = drained.report.retry_after_seconds
    {
        lines.push(format!(
            "the server asked for {wait}s before more is sent; push again after that to send the rest"
        ));
    }
    lines.extend(output::folder_stopped(&drained.report));
    lines.extend(output::folder_unclaimed(&drained.report));
    if drained.rebased > 0 {
        lines.push(rebased_line(drained.rebased));
    }
    if drained.gave_way > 0 {
        lines.push(gave_way_line(drained.gave_way));
    }
    lines
}

fn describe_health(report: &serde_json::Value) -> String {
    let report = &output::printable_value(report);
    let mut lines = vec![format!(
        "folder {}",
        report["folder_id"].as_str().unwrap_or_default()
    )];
    let totals = &report["totals"];
    let qualifier = if totals["saturated"].as_bool() == Some(true) {
        "at least "
    } else {
        ""
    };
    lines.push(format!("current reports: {qualifier}{} file(s) waiting to upload; {qualifier}{} known file(s) pending or blocked on download; {qualifier}{} paused removal(s); {qualifier}{} copy/copies waiting for first sync",
        totals["pending_uploads"], totals["pending_downloads"], totals["paused_removals"], totals["first_sync_waiting"]));
    if let Some(sign_ins) = report["sign_ins"].as_array() {
        for sign_in in sign_ins {
            let identity = &sign_in["sign_in"];
            let current = if sign_in["current"].as_bool() == Some(true) {
                "current sign-in"
            } else {
                "ended sign-in; historical reports"
            };
            lines.push(format!(
                "{} {} ({}): {current}",
                identity["kind"].as_str().unwrap_or_default(),
                identity["name"].as_str().unwrap_or_default(),
                identity["id"].as_str().unwrap_or_default()
            ));
            if let Some(copies) = sign_in["copies"].as_array() {
                for copy in copies {
                    lines.push(format!(
                        "  copy {}: received {} ({} second(s) ago); last full successful sync {}",
                        copy["folder_store_id"].as_str().unwrap_or_default(),
                        copy["received_at"].as_str().unwrap_or_default(),
                        copy["age_seconds"],
                        copy["last_success_at"].as_str().unwrap_or("never reported")
                    ));
                    lines.push(format!("    {} file(s) waiting to upload; {} known file(s) pending or blocked on download; {} paused removal(s); first sync waiting: {}",
                        copy["pending_uploads"], copy["pending_downloads"], copy["paused_removals"], copy["first_sync_waiting"]));
                    if let Some(problems) = copy["problems"].as_array() {
                        for problem in problems {
                            lines.push(format!(
                                "    {}: {}",
                                problem["code"].as_str().unwrap_or_default(),
                                problem["count"]
                            ));
                        }
                    }
                }
            }
        }
    }
    lines.join("\n")
}

fn describe_directories(report: &serde_json::Value) -> String {
    let report = &output::printable_value(report);
    let under = report["under"].as_str().unwrap_or_default();
    let place = if under.is_empty() {
        "the top level".to_string()
    } else {
        under.to_string()
    };
    let mut lines = vec![
        format!(
            "folder {}",
            report["folder_id"].as_str().unwrap_or_default()
        ),
        format!(
            "{} file(s) directly at {place}; {} file(s) in the folder",
            report["direct_files"], report["total_files"]
        ),
    ];
    let unreadable = report["unreadable_placements"].as_i64().unwrap_or(0);
    if unreadable > 0 {
        lines.push(format!(
            "{unreadable} placement(s) with a damaged path left out of every count"
        ));
    }
    for directory in report["directories"].as_array().into_iter().flatten() {
        lines.push(format!(
            "{}: {} file(s) directly, {} in all{}",
            directory["path"].as_str().unwrap_or_default(),
            directory["direct_files"],
            directory["all_files"],
            if directory["has_directories"].as_bool() == Some(true) {
                ", with directories beneath"
            } else {
                ""
            }
        ));
    }
    if report["directories"].as_array().is_none_or(Vec::is_empty) {
        lines.push("no directory here".to_string());
    }
    lines.join("\n")
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

fn held(dir: &Path) -> impl FnOnce(CoreError) -> CliError + '_ {
    move |error| match error {
        CoreError::ReadingHandle => CliError::FolderHeld(dir.to_path_buf()),
        other => other.into(),
    }
}

fn asked(dir: &Path) -> impl FnOnce(CoreError) -> CliError + '_ {
    move |error| match error {
        CoreError::ReadingHandle => CliError::FolderNotHandedOver(dir.to_path_buf()),
        other => other.into(),
    }
}

/// Says on standard error that opening `folder` replaced the saved state
/// another build made (`folder-setup/refused-store-replaced-told`).
fn say_replaced(folder: &Folder) {
    if let Some(reason) = folder.replaced_store() {
        crate::errln!(
            "marfa: replaced the saved state of {}, which another build of marfa made ({}); nothing in it waited to be sent and no answer from the server was yet to be recorded, so the new saved state keeps what is recorded of each file and is filled again from the server; the replacement changes no file",
            folder.root().display(),
            printable(reason)
        );
    }
}

/// The folder, for a watch: refused at once where another process holds it,
/// since a watch that asked would take a folder from another watch.
pub fn opened(dir: &Path, session: Option<Session>) -> Result<Folder, CliError> {
    let (server, renew) = Session::split(session);
    let folder = Folder::open(dir, server).map_err(held(dir))?;
    say_replaced(&folder);
    renewing(folder.core(), renew);
    Ok(folder)
}

/// A session's renewal, shared by every open of one folder a watch makes.
pub type Renewal = std::sync::Arc<dyn Fn(&str) -> Result<String, CoreError> + Send + Sync>;

/// The server and renewal of `session`, kept for a watch to open its folder
/// again with, rather than reading the credential each time.
pub fn kept_session(session: Session) -> (marfa_core::Server, Option<Renewal>) {
    let Session { server, renew } = session;
    (server, renew.map(Renewal::from))
}

/// The folder, for a watch, opened with a kept server and renewal: refused
/// at once where another process holds it.
pub fn reopened(
    dir: &Path,
    server: &marfa_core::Server,
    renew: Option<&Renewal>,
) -> Result<Folder, CliError> {
    reopening(dir, server, renew).map_err(held(dir))
}

/// `reopened`, with the core's own error.
pub fn reopening(
    dir: &Path,
    server: &marfa_core::Server,
    renew: Option<&Renewal>,
) -> Result<Folder, CoreError> {
    let folder = Folder::open(dir, Some(server.clone()))?;
    say_replaced(&folder);
    if let Some(renew) = renew {
        let renew = std::sync::Arc::clone(renew);
        folder
            .core()
            .renew_credential_with(Box::new(move |refused| renew(refused)));
    }
    Ok(folder)
}

/// The folder, for a command that works it: a watch holding it is asked to
/// let it go, and takes it back once this command ends.
fn working(dir: &Path, session: Option<Session>) -> Result<Folder, CliError> {
    let (server, renew) = Session::split(session);
    let folder = Folder::open_asking(dir, server).map_err(asked(dir))?;
    say_replaced(&folder);
    renewing(folder.core(), renew);
    Ok(folder)
}

pub fn flagged_lines(flagged: &[marfa_core::folder::Flagged]) -> Vec<String> {
    flagged
        .iter()
        .map(|file| match file.flag {
            "unreadable" => format!(
                "{} is held, not sent: its frontmatter cannot be read ({})",
                printable(&file.path),
                printable(&file.reason)
            ),
            "behind" => format!("{}: {}", printable(&file.path), printable(&file.reason)),
            "edges" => format!(
                "{} is left as written: {}",
                printable(&file.path),
                printable(&file.reason)
            ),
            "waiting" => format!(
                "{} waits: {}",
                printable(&file.path),
                printable(&file.reason)
            ),
            "busy" => format!(
                "{} waits: {}",
                printable(&file.path),
                printable(&file.reason)
            ),
            "kept" => format!(
                "{} is kept: {}",
                printable(&file.path),
                printable(&file.reason)
            ),
            "carried" => format!(
                "{} is kept{}: {}",
                printable(&file.path),
                file.item
                    .as_ref()
                    .map(|item| format!(" (item {})", printable(item)))
                    .unwrap_or_default(),
                printable(&file.reason)
            ),
            "unwritten" | "outside" | "unsuited" | "absent" => {
                let item = file
                    .item
                    .as_ref()
                    .map(|item| format!(" (item {})", printable(item)))
                    .unwrap_or_default();
                format!(
                    "{} is not written{item}: {}",
                    printable(&file.path),
                    printable(&file.reason)
                )
            }
            marfa_core::folder::DEFAULT_EDGE_REFUSED => format!(
                "{} is sent, but a default edge of the folder was not applied: {}",
                printable(&file.path),
                printable(&file.reason)
            ),
            _ => format!(
                "{} is held, not sent, and left as written: {}",
                printable(&file.path),
                printable(&file.reason)
            ),
        })
        .collect()
}

pub fn directory_lines(directories: &[marfa_core::folder::Flagged]) -> Vec<String> {
    directories
        .iter()
        .map(|dir| match dir.path.as_str() {
            "" => format!("the folder {}", printable(&dir.reason)),
            path => format!("{} {}", printable(path), printable(&dir.reason)),
        })
        .collect()
}

pub fn embed_lines<'a>(
    embeds: impl IntoIterator<Item = &'a marfa_core::folder::Flagged>,
) -> Vec<String> {
    let mut said: Vec<String> = Vec::new();
    for embed in embeds {
        let line = format!("{}: {}", printable(&embed.path), printable(&embed.reason));
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
            .map(|entry| printable(&format!("{}.{}", entry.r#type, entry.property)))
            .collect();
        format!(
            "no file can carry {}: a file reads type, tier, tags, state, occurred_at and edge names as the item's own",
            named.join(", ")
        )
    })
}

/// What became of the settings file in a pass: its edit, sent first, and
/// the pull's write of it, each said once.
pub fn settings_lines(
    sent: &marfa_core::SettingsFileReport,
    pulled: Option<&marfa_core::SettingsFileReport>,
) -> Vec<String> {
    let mut lines: Vec<String> = settings_line(sent).into_iter().collect();
    if let Some(line) = pulled.and_then(settings_line)
        && !lines.contains(&line)
    {
        lines.push(line);
    }
    lines
}

pub fn settings_line(report: &marfa_core::SettingsFileReport) -> Option<String> {
    if let Some(reason) = &report.unwritten {
        return Some(format!(
            "the settings file was not written, and the next pass writes it: {}",
            printable(reason)
        ));
    }
    match (&report.flagged, report.sent) {
        (Some(reason), _) => Some(format!(
            "the settings file is not in force, and the settings before it are: {}",
            printable(reason)
        )),
        (None, true) => Some("the settings file's edit went through the folder operations".into()),
        (None, false) => None,
    }
}

fn describe_pull(report: &marfa_core::PullReport) -> String {
    if let Some(gone) = &report.root_gone {
        return format!("nothing written: {}", printable(gone));
    }
    let mut line = format!(
        "{} written, {} rewritten, {} moved, {} unchanged, {} skipped",
        report.written, report.rewritten, report.moved, report.unchanged, report.skipped
    );
    let held: Vec<String> = [
        (
            report.unwritten,
            "the directory did not write and would not write over",
        ),
        (
            report.busy,
            "that a program holds open for writing, which a later pull writes once it closes them",
        ),
        (
            report.outside,
            "whose path the directory does not write to (left out by its lists, inside a package or another directory, or not a path inside the directory)",
        ),
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
            report.removed - report.purged,
            "file(s) of items trashed or out of the query's states removed",
        ),
        (report.purged, "file(s) of items purged removed"),
        (report.kept, "kept with the person's changes"),
        (
            report.unmatched,
            "file(s) left in place whose item the query does not match",
        ),
        (
            report.elsewhere,
            "item(s) whose file was moved to another directory on this machine, written here once that directory takes it",
        ),
        (
            report.ended,
            "placement(s) ended, for files that left the directory for good",
        ),
        (
            report.relinked,
            "document(s) whose links were rewritten to follow a retitled item",
        ),
        (
            report.unrelinked,
            "document(s) whose links to a retitled item could not be rewritten, tried again next time",
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

/// A status as a person reads it. `outside` is the name in the JSON for a file
/// the folder does not take; a pull's `outside` count is another thing, a
/// path the folder will not write to.
fn status_words(status: &str) -> String {
    match status {
        "outside" => "not taken".to_string(),
        other => other.replace('_', " "),
    }
}

/// A directory the registry lists, and whether its sync is paused.
#[derive(serde::Serialize)]
struct ListedFolder<'a> {
    #[serde(flatten)]
    entry: &'a marfa_core::folder::registry::Registered,
    paused: bool,
}

/// `folders status` in JSON: the folder's own status, and the current watch
/// of the folder where it runs another build of marfa.
#[derive(serde::Serialize)]
struct FolderStatus<'a> {
    #[serde(flatten)]
    report: &'a marfa_core::StatusReport,
    watch_other_build: Option<&'a new_build::OtherBuild>,
    /// Why the watch stopped the folder, where another instance answers at
    /// its server.
    watch_stopped: Option<&'a str>,
}

/// What `folders remove` says of a folder whose state went, and where
/// another instance at its server never received changes the folder held,
/// each file that holds one and how to send them to that instance.
fn removed_said(dir: &Path, folder: &str, unsent: &marfa_core::folder::UnsentChanges) -> String {
    use marfa_core::folder::UnsentChange;
    let shown = dir.display();
    let folder = printable(folder);
    let removed = format!("{shown} no longer follows the folder {folder}; its files stay");
    if unsent.writes == 0 && unsent.files.is_empty() {
        return removed;
    }
    let cause = "another Marfa instance answers at the folder's server";
    let mut said = vec![removed];
    said.push(match (unsent.writes, unsent.files.is_empty()) {
        (0, _) => format!("{cause}, and these files hold changes this folder could not send to it:"),
        (writes, false) => format!(
            "{writes} write(s) could not be sent, because {cause}; these files hold the changes this folder could not send:"
        ),
        (writes, true) => {
            format!("{writes} write(s) could not be sent, because {cause}; no file holds their changes")
        }
    });
    for file in &unsent.files {
        let path = file.path.as_deref().map(printable);
        let line = match (file.change, path, file.from.as_deref()) {
            (UnsentChange::Moved, Some(path), Some(from)) => {
                format!("  moved    {path}, from {}", printable(from))
            }
            (UnsentChange::Deleted, None, _) => format!(
                "  deleted  the item {}, whose path was not recorded",
                printable(file.item.as_deref().unwrap_or_default())
            ),
            (change, path, _) => {
                let word = match change {
                    UnsentChange::Changed => "changed",
                    UnsentChange::New => "new",
                    UnsentChange::Moved => "moved",
                    UnsentChange::Deleted => "deleted",
                };
                format!("  {word:<8} {}", path.unwrap_or_default())
            }
        };
        said.push(line);
    }
    let word = crate::hint::shell_word(&shown.to_string());
    said.extend([
        format!(
            "The changes to changed, new and moved files stay in the files in {shown}, but a \
             deletion or a move is in no file. To send them to that instance:"
        ),
        format!(
            "  1. Move {shown} aside, run `marfa folders add {word} --folder {folder}` with a key \
             for that instance, and run `marfa folders push {word}`."
        ),
        "  2. In the new directory, delete each deleted file again and move each moved file \
         again from where it was."
            .to_string(),
        "  3. Copy only the changed, new and moved files back in from the moved directory."
            .to_string(),
        "  4. Compare the moved directory with the new one. A file that differs but is not named \
         above may hold a change this folder sent that the new instance lacks, such as one sent \
         after the backup it was restored from was made: check it, and copy it back if the moved \
         copy is the one to keep."
            .to_string(),
        format!(
            "  5. Run `marfa folders push {word}`, and again until `marfa folders status {word}` \
             shows nothing waiting: a deleted file's item is deleted only once the folder's grace \
             for a rename has passed."
        ),
    ]);
    said.join("\n")
}

/// A copy the instance change expired is said by its cause; every other
/// refusal stays its own.
fn status_refused(error: CoreError, stopped: Option<String>) -> CliError {
    match (error, stopped) {
        (CoreError::CopyExpired { .. } | CoreError::HydrationIncomplete, Some(server)) => {
            CliError::InstanceChanged(server)
        }
        (error, _) => error.into(),
    }
}

fn describe_status(report: &marfa_core::StatusReport) -> String {
    let in_step = report
        .files
        .iter()
        .filter(|file| file.status == "in_step")
        .count();
    let headline = if report.sync_paused {
        format!("sync paused; {in_step} file(s) were in step when it last ran")
    } else if report.unwatched > 0 {
        format!(
            "{in_step} file(s) were in step when last read, but {} cannot be watched, so a change there is found only when the watch looks again",
            directories_words(report.unwatched)
        )
    } else {
        format!("{in_step} file(s) in step")
    };
    let mut lines = vec![headline];
    for file in report.files.iter().filter(|file| {
        file.status != "in_step"
            || file.flag.is_some()
            || file.reason.is_some()
            || file.warning.is_some()
    }) {
        let mut line = format!("{}: {}", printable(&file.path), status_words(file.status));
        if !file.waits.is_empty() {
            line.push_str(&format!(" ({})", printable(&file.waits.join(", "))));
        }
        if let Some(reason) = &file.reason {
            line.push_str(&format!(", {}", printable(reason)));
        }
        if let Some(warning) = &file.warning {
            line.push_str(&format!("; {}", printable(warning)));
        }
        lines.push(line);
    }
    for directory in &report.directories {
        let path = if directory.path.is_empty() {
            "the directory"
        } else {
            &directory.path
        };
        lines.push(format!(
            "{}: {}, {}",
            printable(path),
            printable(directory.flag),
            printable(&directory.reason)
        ));
    }
    if report.sync_paused {
        lines.push(
            "the sync is paused: nothing is sent or written until `folders resume` lets it go on"
                .into(),
        );
    }
    if report.unwatched > 0 {
        lines.push(format!(
            "{} could not be registered with the system's file watch; the watch registers them again and looks at their files on a short interval until it can",
            directories_words(report.unwatched)
        ));
    }
    if let Some(path) = &report.beneath_waiting {
        let mut line = format!(
            "the folder holds nothing from the server until its query names the item of {}",
            printable(path)
        );
        if let Some(why) = &report.beneath_waiting_reason {
            line.push_str(&format!(": {}", printable(why)));
        }
        lines.push(line);
    }
    if report.paused.disk + report.paused.pull > 0 {
        lines.push(format!(
            "a large removal waits: {} file(s) gone from the disk, {} whose items left elsewhere; `folders confirm` lets it go, `folders restore` puts them back",
            report.paused.disk, report.paused.pull
        ));
    }
    if report.paused.additions > 0 {
        lines.push(paused_additions_line(report.paused.additions));
    }
    if report.paused.outside_query > 0 {
        lines.push(held_outside_line(report.paused.outside_query));
    }
    if let Some(waiting) = &report.first_sync {
        lines.push(match &waiting.plan {
            Some(plan) => format!("the first sync waits for confirmation: {}", plan_line(plan)),
            None => {
                "the first sync waits for confirmation; `folders push` says what it will do".into()
            }
        });
    }
    lines.join("\n")
}

fn directories_words(count: u64) -> String {
    match count {
        1 => "1 directory".into(),
        count => format!("{count} directories"),
    }
}

/// What `folders pause` and `folders resume` say: the directory's sync as it
/// now stands, and whether the command changed it.
fn paused_report(folder: &Folder, paused: bool, changed: bool, json: bool) -> Result<(), CliError> {
    output::report(
        &serde_json::json!({ "dir": folder.root(), "paused": paused, "changed": changed }),
        json,
        || {
            let dir = folder.root().display();
            match (paused, changed) {
                (true, true) => format!("{dir} is paused; `folders resume` lets its sync go on"),
                (true, false) => format!("{dir} was already paused; nothing changed"),
                (false, true) => format!("{dir} is resumed; its sync goes on"),
                (false, false) => format!("{dir} was not paused; nothing changed"),
            }
        },
    )
}

fn plan_line(plan: &FirstSync) -> String {
    let mut line = format!(
        "{} file(s) to write into the directory, {} to send to the server",
        plan.write, plan.send
    );
    if plan.beside > 0 {
        line.push_str(&format!(
            "; {} of those would be written at the path of a file that is being sent, so one of the two gets a number added to its name and no file is written over",
            plan.beside
        ));
    }
    if plan.left > 0 {
        line.push_str(&format!(
            "; for {} more, no file is written, because a file that is not sent is already at the item's path; that file stays as it is",
            plan.left
        ));
    }
    line
}

/// What the person is told while the first sync waits, and after.
fn first_sync_lines(dir: &Path, plan: Option<&FirstSync>, confirmed: bool) -> Vec<String> {
    match (plan, confirmed) {
        (Some(plan), false) => vec![
            format!(
                "the first sync will write and send nothing until you confirm it: {}",
                plan_line(plan)
            ),
            format!(
                "`marfa folders confirm {0}` lets it go; `marfa folders remove {0}` stops the directory following its folder and leaves the files",
                dir.display()
            ),
        ],
        (Some(plan), true) => vec![format!(
            "the first sync is confirmed: {}; `folders push` or `folders watch` runs it",
            plan_line(plan)
        )],
        (None, _) => Vec::new(),
    }
}

fn first_sync_json(
    plan: Option<&FirstSync>,
    confirmed: bool,
    unread: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "waiting": !confirmed,
        "write": plan.map(|plan| plan.write),
        "send": plan.map(|plan| plan.send),
        "beside": plan.map(|plan| plan.beside),
        "left": plan.map(|plan| plan.left),
        "unread": unread,
    })
}

/// Asks at a terminal, and says no anywhere else: a script that has not said
/// `--yes` has not agreed.
fn asks_to_go_ahead(dir: &Path, plan: &FirstSync) -> Result<bool, CliError> {
    use std::io::{BufRead, IsTerminal, Write};
    if !std::io::stdin().is_terminal() || !crate::output::stderr_is_terminal() {
        return Ok(false);
    }
    let mut question = crate::output::stderr();
    writeln!(
        question,
        "the first sync of {} will write and send nothing until you agree: {}",
        dir.display(),
        plan_line(plan)
    )?;
    write!(question, "Go ahead? [y/N] ")?;
    question.flush()?;
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    Ok(matches!(answer.trim().to_lowercase().as_str(), "y" | "yes"))
}

pub(crate) fn secret_lines(secrets: &[String]) -> Vec<String> {
    secrets
        .iter()
        .map(|path| {
            format!(
                "{}: not taken, because its name is one a secret goes by",
                printable(path)
            )
        })
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

pub fn paused_additions_line(count: usize) -> String {
    format!(
        "a large addition waits: {count} new file(s) held, not sent; `folders confirm` sends them, and deleting the files you did not mean to add cancels it; new files that arrive meanwhile join it"
    )
}

pub fn held_outside_line(count: usize) -> String {
    format!(
        "{count} new file(s) held outside the query, not sent: the folder's outside_query is hold, so each is sent once it matches the query or the setting is send; `folders unmatched` lists them"
    )
}

fn describe_scan(report: &marfa_core::ScanReport) -> String {
    if let Some(gone) = &report.root_gone {
        return format!("nothing scanned: {}", printable(gone));
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
                "set to be sent again because the item it was bound to is gone",
            ),
            (
                report.lost,
                "bound to an item that is gone and unchanged since, so not sent",
            ),
            (
                report.waiting,
                "already waiting to be sent from an earlier scan, so not counted as created or updated here",
            ),
            (
                report.unreached,
                "bound but not reached, where the lists no longer take them or a package or an unreadable directory holds them, so held rather than deleted",
            ),
            (
                report.carried,
                "gone from their paths but kept, because a file the folder holds for its name or does not send carries them",
            ),
        ]
        .into_iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, what)| format!("; {count} {what}"))
        .collect::<String>()
    );
    if report.moved_away > 0 {
        line.push_str(&format!(
            "; {} moved to another directory on this machine, so nothing was trashed",
            report.moved_away
        ));
    }
    let behind = report
        .flagged
        .iter()
        .filter(|file| file.flag == "behind")
        .count();
    let defaulted = report
        .flagged
        .iter()
        .filter(|file| file.flag == marfa_core::folder::DEFAULT_EDGE_REFUSED)
        .count();
    let held = report.flagged.len() - behind - defaulted;
    if held > 0 {
        line.push_str(&format!("; {held} held, not sent"));
    }
    if defaulted > 0 {
        line.push_str(&format!(
            "; {defaulted} default edge(s) of the folder not applied, the file sent"
        ));
    }
    if behind > 0 {
        line.push_str(&format!("; {behind} behind: own-field lines not sent"));
    }
    if report.paused > 0 {
        line.push('\n');
        line.push_str(&paused_line(report.paused, false));
    }
    if report.paused_additions > 0 {
        line.push('\n');
        line.push_str(&paused_additions_line(report.paused_additions));
    }
    if report.held_outside > 0 {
        line.push('\n');
        line.push_str(&held_outside_line(report.held_outside));
    }
    for said in directory_lines(&report.directories)
        .into_iter()
        .chain(embed_lines(&report.embeds))
        .chain(
            report
                .warnings
                .iter()
                .map(|file| format!("{}: {}", printable(&file.path), printable(&file.reason))),
        )
        .chain(secret_lines(&report.secrets))
    {
        line.push('\n');
        line.push_str(&said);
    }
    for said in trashed_lines(report)
        .into_iter()
        .chain(unsure_lines(report))
        .chain(lookup_line(report))
    {
        line.push('\n');
        line.push_str(&said);
    }
    line
}

pub fn trashed_lines(report: &marfa_core::ScanReport) -> Vec<String> {
    report
        .trashed
        .iter()
        .map(|path| {
            format!(
                "{} was found in no directory on this machine, so its item was trashed",
                printable(path)
            )
        })
        .collect()
}

pub fn unsure_lines(report: &marfa_core::ScanReport) -> Vec<String> {
    let registry = report.registry.iter().map(|why| {
        format!(
            "this directory stands alone, since the folder registry cannot be read: {}",
            printable(why)
        )
    });
    let unsure = report.unsure.iter().map(|file| {
        format!(
            "Deletion of {} is on hold because {}. `folders held` settles it",
            printable(&file.path),
            printable(&file.reason)
        )
    });
    registry.chain(unsure).collect()
}

/// What stands while the server does not answer the folder's title lookups.
/// A watch says it when it changes, apart from the other standing lines, so a
/// held file or an excluded secret does not say it again.
pub fn lookup_line(report: &marfa_core::ScanReport) -> Option<String> {
    report.lookup_refused.as_deref().map(printable)
}

/// Says each edit that conflicted once, as a file that changed in two places
/// and the file the other edit went to. A conflicted copy reaches the
/// directory with a change after the answer, so a watch can know its file
/// only at a later pass; it keeps those and says them then.
#[derive(Default)]
pub struct Conflicts {
    awaiting: Vec<(String, String)>,
}

impl Conflicts {
    pub fn say(&mut self, folder: &Folder, drain: &marfa_core::DrainReport) -> Vec<String> {
        self.say_with(|id| folder.file_of(id).ok().flatten(), drain)
    }

    /// `file_of` answers the path of the file bound to an item, if any.
    fn say_with(
        &mut self,
        file_of: impl Fn(&str) -> Option<String>,
        drain: &marfa_core::DrainReport,
    ) -> Vec<String> {
        let mut lines = Vec::new();
        let mut arrived = Vec::new();
        self.awaiting.retain(|(file, copy)| match file_of(copy) {
            Some(path) => {
                arrived.push(format!(
                    "{} now holds the other edit of {}",
                    printable(&path),
                    printable(file)
                ));
                false
            }
            None => true,
        });
        for verdict in &drain.verdicts {
            if verdict.verdict != Some(marfa_core::Verdict::Conflicted) {
                continue;
            }
            // The drain answers every write in the store, so a conflict on an
            // item that is no file of this folder is not this folder's to say.
            let Some(file) = verdict.item_id.as_deref().and_then(&file_of) else {
                continue;
            };
            let copy = verdict.conflicted_copy_id.as_deref().and_then(&file_of);
            let mut line = format!("{} changed in two places", printable(&file));
            match (&copy, &verdict.conflicted_copy_id) {
                (Some(copy), _) => {
                    line.push_str(&format!("; the other edit is in {}", printable(copy)));
                }
                (None, Some(id)) => {
                    line.push_str(
                        "; the other edit is in a new file that is not in this directory yet",
                    );
                    self.awaiting.push((file, id.clone()));
                }
                (None, None) => {}
            }
            lines.push(line);
        }
        lines.extend(arrived);
        lines
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn remote_health_is_a_folder_command() {
        use clap::Parser;
        assert!(crate::Cli::try_parse_from(["marfa", "folders", "health", "folder"]).is_ok());
    }

    #[test]
    fn folder_directories_names_the_folder_and_takes_an_optional_under() {
        use clap::Parser;
        let parsed = |words: &[&str]| {
            let mut argv = vec!["marfa", "folders", "directories"];
            argv.extend_from_slice(words);
            crate::Cli::try_parse_from(argv)
        };
        assert!(parsed(&[]).is_err());
        assert!(parsed(&["folder"]).is_ok());
        assert!(parsed(&["folder", "--under", "notes/2026"]).is_ok());
        assert!(parsed(&["folder", "--under"]).is_err());
    }

    #[test]
    fn folder_directories_takes_an_under_that_starts_with_a_hyphen() {
        use clap::Parser;
        let parsed = crate::Cli::try_parse_from([
            "marfa",
            "folders",
            "directories",
            "folder",
            "--under",
            "-drafts",
        ])
        .unwrap();
        let crate::Command::Folders {
            command: FoldersCommand::Directories { under, .. },
        } = parsed.command
        else {
            panic!("not a directories command");
        };
        assert_eq!(under.as_deref(), Some("-drafts"));
    }

    #[test]
    fn a_directory_listing_says_each_level_and_each_directory() {
        let said = describe_directories(&serde_json::json!({
            "folder_id": "f1",
            "under": "notes",
            "direct_files": 2,
            "total_files": 8,
            "unreadable_placements": 2,
            "directories": [
                { "path": "notes/2026", "direct_files": 1, "all_files": 3, "has_directories": true },
                { "path": "notes/old", "direct_files": 1, "all_files": 1, "has_directories": false },
            ],
        }));
        assert_eq!(
            said,
            "folder f1\n2 file(s) directly at notes; 8 file(s) in the folder\n\
             2 placement(s) with a damaged path left out of every count\n\
             notes/2026: 1 file(s) directly, 3 in all, with directories beneath\n\
             notes/old: 1 file(s) directly, 1 in all"
        );
        let empty = describe_directories(&serde_json::json!({
            "folder_id": "f1", "under": "", "direct_files": 0, "total_files": 0, "directories": [],
        }));
        assert_eq!(
            empty,
            "folder f1\n0 file(s) directly at the top level; 0 file(s) in the folder\nno directory here"
        );
    }
    use super::*;
    use marfa_core::{DrainReport, DrainVerdict, Verdict, WriteKind};
    use std::collections::HashMap;

    #[test]
    fn a_status_says_only_what_the_instance_change_caused_by_it() {
        let server = || Some("https://one.test".to_owned());
        let expired = || CoreError::CopyExpired {
            reason: "instance_changed".into(),
            server: None,
        };
        for error in [expired(), CoreError::HydrationIncomplete] {
            let said = status_refused(error, server());
            assert_eq!(said.code(), "instance_changed");
            assert_eq!(said.exit(), Exit::Local);
            assert!(said.to_string().contains("https://one.test"), "{said}");
        }
        // The witness: with no stop in the record, the copy's own refusal.
        assert_eq!(status_refused(expired(), None).code(), "copy_expired");
        let busy = status_refused(CoreError::StoreBusy("held".into()), server());
        assert_eq!(busy.code(), "store_busy");
        assert_eq!(busy.exit(), Exit::Environment);
    }

    #[test]
    fn a_message_the_server_or_the_root_check_gives_stays_on_its_own_line() {
        let forged = "refused\nwould create 0 items\u{1b}[2K";
        let refused = marfa_core::ScanReport {
            lookup_refused: Some(forged.into()),
            ..Default::default()
        };
        let line = lookup_line(&refused).expect("a standing line");
        assert!(!line.contains('\n') && !line.contains('\u{1b}'), "{line:?}");
        assert_eq!(lookup_line(&marfa_core::ScanReport::default()), None);
        let gone = marfa_core::ScanReport {
            root_gone: Some(forged.into()),
            ..Default::default()
        };
        let text = describe_scan(&gone);
        assert!(!text.contains('\n') && !text.contains('\u{1b}'), "{text:?}");
        assert!(
            describe_scan(&refused).lines().count() <= 3,
            "{:?}",
            describe_scan(&refused)
        );
    }

    #[test]
    fn a_reason_the_settings_file_gives_stays_on_its_own_line() {
        let said = |unwritten: Option<&str>, flagged: Option<&str>| {
            settings_line(&marfa_core::SettingsFileReport {
                sent: false,
                written: false,
                unwritten: unwritten.map(str::to_string),
                flagged: flagged.map(str::to_string),
            })
            .unwrap()
        };
        for line in [
            said(Some("full\nforged line\u{1b}[2K"), None),
            said(None, Some("flagged\nforged line\r")),
        ] {
            assert_eq!(line.lines().count(), 1, "{line:?}");
            assert!(!line.contains('\u{1b}') && !line.contains('\r'), "{line:?}");
        }
    }

    fn drain(verdicts: Vec<DrainVerdict>) -> DrainReport {
        DrainReport {
            answered: verdicts.len(),
            held: 0,
            undelivered: 0,
            unsent: 0,
            unmade: 0,
            unavailable: None,
            limited: false,
            verdicts,
            stopped: None,
            refused_by: None,
            unclaimed_sources: Vec::new(),
            retry_after_seconds: None,
        }
    }

    fn answered(verdict: Verdict, item: &str, copy: Option<&str>) -> DrainVerdict {
        DrainVerdict {
            id: "write".into(),
            kind: WriteKind::UpdateItem,
            item_id: Some(item.into()),
            edge_id: None,
            verdict: Some(verdict),
            reason: None,
            refusal: None,
            conflicted_copy_id: copy.map(str::to_string),
            refusals: 0,
            replayed: false,
            merged_fields: Vec::new(),
            conflicts: Vec::new(),
        }
    }

    fn file(
        path: &str,
        status: &'static str,
        flag: &'static str,
        reason: &str,
    ) -> marfa_core::FileStatus {
        marfa_core::FileStatus {
            path: path.into(),
            item_id: None,
            status,
            waits: Vec::new(),
            flag: Some(flag),
            reason: Some(reason.into()),
            warning: None,
        }
    }

    #[test]
    fn the_first_sync_plan_says_what_happens_where_a_file_is_at_a_path() {
        let plan = |beside, left| FirstSync {
            write: 3,
            send: 2,
            beside,
            left,
        };
        let plain = plan_line(&plan(0, 0));
        assert_eq!(
            plain,
            "3 file(s) to write into the directory, 2 to send to the server"
        );
        let beside = plan_line(&plan(2, 0));
        assert!(
            beside.contains(
                "2 of those would be written at the path of a file that is being sent, so one of the two gets a number added to its name and no file is written over"
            ),
            "{beside}"
        );
        let left = plan_line(&plan(0, 1));
        assert!(
            left.contains(
                "for 1 more, no file is written, because a file that is not sent is already at the item's path; that file stays as it is"
            ),
            "{left}"
        );
        assert!(!left.contains("gets a number"), "{left}");
    }

    #[test]
    fn a_scan_does_not_count_a_refused_default_edge_as_a_file_held() {
        let mut report = marfa_core::ScanReport::default();
        report
            .flagged
            .push(marfa_core::folder::Flagged::default_edge_refused(
                "a.md", "why",
            ));
        let said = describe_scan(&report);
        assert!(!said.contains("held, not sent"), "{said}");
        assert!(
            said.contains("1 default edge(s) of the folder not applied, the file sent"),
            "{said}"
        );
        report.flagged.push(marfa_core::folder::Flagged {
            path: "b.md".into(),
            flag: "refused",
            reason: "x".into(),
            item: None,
        });
        assert!(describe_scan(&report).contains("1 held, not sent"));
    }

    #[test]
    fn a_refused_default_edge_is_said_to_be_sent_and_its_edge_not_applied() {
        let lines = flagged_lines(&[marfa_core::folder::Flagged::default_edge_refused(
            "a.md",
            "edge_type_unknown (the folder's default shelved-in edge to b was not applied; write that line in the file to apply it)",
        )]);
        assert_eq!(
            lines,
            vec![
                "a.md is sent, but a default edge of the folder was not applied: edge_type_unknown (the folder's default shelved-in edge to b was not applied; write that line in the file to apply it)"
            ]
        );
        let held = flagged_lines(&[marfa_core::folder::Flagged {
            path: "b.md".into(),
            flag: "refused",
            reason: "x".into(),
            item: None,
        }]);
        assert!(held[0].contains("held, not sent"), "{held:?}");
    }

    #[test]
    fn a_file_in_step_that_carries_a_refusal_or_a_warning_is_listed_with_it() {
        let mut refused = file(
            "a.md",
            "in_step",
            "default_edge_refused",
            "edge_type_unknown (the folder's default shelved-in edge to b was not applied)",
        );
        let mut near = file("b.md", "in_step", "refused", "");
        near.flag = None;
        near.reason = None;
        near.warning = Some("is near the size limit".into());
        refused.warning = None;
        let clean = {
            let mut clean = file("c.md", "in_step", "refused", "");
            clean.flag = None;
            clean.reason = None;
            clean
        };
        let said = describe_status(&marfa_core::StatusReport {
            files: vec![refused, near, clean],
            ..Default::default()
        });
        assert!(said.starts_with("3 file(s) in step"), "{said}");
        assert!(
            said.contains("a.md: in step, edge_type_unknown (the folder's default shelved-in edge to b was not applied)"),
            "{said}"
        );
        assert!(
            said.contains("b.md: in step; is near the size limit"),
            "{said}"
        );
        assert!(!said.contains("c.md"), "{said}");
    }

    #[test]
    fn a_file_the_folder_does_not_take_is_not_said_to_be_outside() {
        let said = describe_status(&marfa_core::StatusReport {
            files: vec![file(
                "blank.bin",
                "outside",
                "empty",
                "it is empty, and a file item holds bytes",
            )],
            ..Default::default()
        });
        assert!(said.contains("blank.bin: not taken, it is empty"), "{said}");
        assert!(!said.contains("outside"), "{said}");
    }

    #[test]
    fn a_pull_says_why_a_path_is_one_the_folder_does_not_write() {
        let said = describe_pull(&marfa_core::PullReport {
            outside: 2,
            ..Default::default()
        });
        assert!(
            said.contains("2 whose path the directory does not write to"),
            "{said}"
        );
        assert!(
            said.contains("left out by its lists")
                && said.contains("inside a package or another directory")
                && said.contains("not a path inside the directory"),
            "{said}"
        );
        assert!(!said.contains("wanting a path outside"), "{said}");
    }

    const HOME: &str = "01a10122-54e3-7447-9e6f-91e7d99f361f";
    const OTHER: &str = "01a10126-6c86-74b2-a04a-1fe68e721fde";

    fn listed(folders: &[(&str, &str)]) -> Result<serde_json::Value, CliError> {
        Ok(serde_json::json!({
            "data": folders
                .iter()
                .map(|(id, title)| serde_json::json!({
                    "id": id, "title": title, "created_at": "2026-10-03T09:57:30.610Z"
                }))
                .collect::<Vec<_>>(),
            "next_cursor": null,
        }))
    }

    #[test]
    fn a_folder_is_named_by_its_title_where_one_folder_has_it() {
        let id = folder_id("Home", || listed(&[(HOME, "Home"), (OTHER, "Deals")])).unwrap();
        assert_eq!(id, HOME);
    }

    #[test]
    fn a_title_is_matched_exactly() {
        for title in ["home", "Hom", "Home ", "Home\n"] {
            let refused = folder_id(title, || listed(&[(HOME, "Home")])).unwrap_err();
            assert!(matches!(refused, CliError::Invalid(_)), "{title:?}");
        }
    }

    #[test]
    fn a_title_no_folder_has_is_refused_naming_the_title() {
        let refused = folder_id("Archive", || listed(&[(HOME, "Home")])).unwrap_err();
        let CliError::Invalid(said) = refused else {
            panic!("not refused as invalid");
        };
        assert!(said.contains("\"Archive\""), "{said}");
        assert!(said.contains("marfa folders inventory"), "{said}");
    }

    #[test]
    fn a_title_two_folders_have_is_refused_listing_each_id() {
        let refused = folder_id("Home", || {
            listed(&[(HOME, "Home"), (OTHER, "Home"), ("x", "Deals")])
        })
        .unwrap_err();
        let CliError::Invalid(said) = refused else {
            panic!("not refused as invalid");
        };
        assert!(said.contains(HOME) && said.contains(OTHER), "{said}");
        assert!(
            said.contains("2 folders") && said.contains("nothing was added"),
            "{said}"
        );
    }

    #[test]
    fn an_id_is_taken_as_an_id_without_asking_the_server() {
        let id = folder_id(HOME, || panic!("the server was asked about an ID")).unwrap();
        assert_eq!(id, HOME);
        assert_eq!(id, HOME);
        assert!(!is_folder_id("Home") && !is_folder_id(&HOME.replace('-', "_")));
        assert!(
            !is_folder_id(&format!("{HOME}0"))
                && !is_folder_id("0123456789abcdefg0123456789abcdefg0")
        );
    }

    #[test]
    fn a_listing_the_server_refuses_is_the_refusal() {
        let refused = folder_id("Home", || Err(CliError::Invalid("refused".into()))).unwrap_err();
        assert!(matches!(refused, CliError::Invalid(said) if said == "refused"));
    }

    #[test]
    fn a_conflicted_edit_names_its_file_and_the_file_its_text_went_to() {
        let files: HashMap<&str, &str> = [("item", "note.md"), ("copy", "note (2).md")].into();
        let mut conflicts = Conflicts::default();
        let said = conflicts.say_with(
            |id| files.get(id).map(|path| path.to_string()),
            &drain(vec![
                answered(Verdict::Accepted, "item", None),
                answered(Verdict::Conflicted, "item", Some("copy")),
            ]),
        );
        assert_eq!(
            said,
            ["note.md changed in two places; the other edit is in note (2).md"]
        );
    }

    #[test]
    fn a_conflicted_edit_names_no_write_kind_field_or_reason_of_the_queue() {
        let files: HashMap<&str, &str> =
            [("item", "Packing list.md"), ("copy", "Packing list (2).md")].into();
        let mut verdict = answered(Verdict::Conflicted, "item", Some("copy"));
        verdict.merged_fields = vec!["body".into()];
        verdict.reason = Some("version_conflict".into());
        verdict.replayed = true;
        verdict.refusals = 1;
        let said = Conflicts::default().say_with(
            |id| files.get(id).map(|path| path.to_string()),
            &drain(vec![verdict]),
        );
        assert_eq!(
            said,
            ["Packing list.md changed in two places; the other edit is in Packing list (2).md"]
        );
        // The witness: the queue's own line for the same verdict names all of them.
        let queue = output::verdict_line(
            &{
                let mut verdict = answered(Verdict::Conflicted, "item", Some("copy"));
                verdict.merged_fields = vec!["body".into()];
                verdict
            },
            Some("Packing list.md"),
            Some("Packing list (2).md"),
        );
        assert!(
            queue.contains("update_item") && queue.contains("merged body"),
            "{queue}"
        );
    }

    #[test]
    fn a_copy_that_is_not_a_file_yet_is_said_when_it_becomes_one() {
        let mut files: HashMap<&str, &str> = [("item", "note.md")].into();
        let mut conflicts = Conflicts::default();
        let verdicts = drain(vec![answered(Verdict::Conflicted, "item", Some("copy"))]);
        let said = conflicts.say_with(|id| files.get(id).map(|path| path.to_string()), &verdicts);
        assert_eq!(
            said,
            [
                "note.md changed in two places; the other edit is in a new file that is not in this directory yet"
            ]
        );
        let quiet = drain(Vec::new());
        assert!(
            conflicts
                .say_with(|id| files.get(id).map(|path| path.to_string()), &quiet)
                .is_empty(),
            "said again before the copy had a file"
        );
        files.insert("copy", "note (2).md");
        let arrived = conflicts.say_with(|id| files.get(id).map(|path| path.to_string()), &quiet);
        assert_eq!(arrived, ["note (2).md now holds the other edit of note.md"]);
        assert!(
            conflicts
                .say_with(|id| files.get(id).map(|path| path.to_string()), &quiet)
                .is_empty(),
            "said a third time"
        );
    }

    #[test]
    fn a_conflict_on_an_item_that_is_no_file_here_is_not_said() {
        let mut files: HashMap<&str, &str> = [("mine", "note.md")].into();
        let mut conflicts = Conflicts::default();
        let said = conflicts.say_with(
            |id| files.get(id).map(|path| path.to_string()),
            &drain(vec![answered(Verdict::Conflicted, "other", Some("copy"))]),
        );
        assert!(said.is_empty(), "{said:?}");
        // Nor is it kept to be said when its copy becomes a file here.
        files.insert("copy", "other (2).md");
        let later = conflicts.say_with(
            |id| files.get(id).map(|path| path.to_string()),
            &drain(Vec::new()),
        );
        assert!(later.is_empty(), "{later:?}");
    }

    #[test]
    fn only_a_conflicted_verdict_is_said() {
        let mut conflicts = Conflicts::default();
        let said = conflicts.say_with(
            |_| None,
            &drain(vec![
                answered(Verdict::Accepted, "a", None),
                answered(Verdict::Merged, "b", None),
                answered(Verdict::Refused, "c", None),
            ]),
        );
        assert!(said.is_empty(), "{said:?}");
    }
}

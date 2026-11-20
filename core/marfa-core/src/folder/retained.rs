//! Files a pull set aside while a program might still write to them, kept
//! under their reserved names until a pass settles them.

use super::{Directory, Folder, Rows, device, identity, in_state, joined, landing, state, writers};
use std::path::Path;

use serde::Serialize;

use crate::Result;
use crate::directory::{Mode, OFlags};

/// A file a directory keeps under a reserved name because a program might
/// still write to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeptFile {
    /// The file's path in the directory.
    pub path: String,
    /// The path Marfa replaced or removed the file at.
    pub from: String,
    /// What the last look found: `open` where a program holds the file open
    /// for writing, `unknown` where Marfa cannot tell, and `none` where it
    /// has not looked since it set the file aside.
    pub writers: &'static str,
    /// The day, in UTC, Marfa deletes the file if it is still unchanged,
    /// where it cannot tell whether a program writes to it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    pub reason: String,
}

/// What discarding the kept files did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct KeptDiscarded {
    /// The files deleted, each unchanged since Marfa set it aside.
    pub discarded: Vec<String>,
    /// The paths a file a program wrote to went back to, in place of being
    /// deleted, and those Marfa kept such a file beside.
    pub put_back: Vec<String>,
    /// The files still kept, where Marfa could not reach them.
    pub kept: Vec<KeptFile>,
}

/// The day, in UTC, a file kept where Marfa cannot tell whether a program
/// writes to it is deleted if unchanged.
fn until(retained: &landing::Retained) -> String {
    i64::try_from(retained.since.saturating_add(landing::RETAINED_FOR))
        .ok()
        .and_then(|until| jiff::Timestamp::from_second(until).ok())
        .map(|until| until.strftime("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn kept_file(row: &state::Retained) -> KeptFile {
    let retained = &row.retained;
    let from = joined(&row.dir, &retained.target);
    KeptFile {
        path: joined(&row.aside, &retained.kept),
        writers: match retained.writers {
            Some(writers::Writers::Open) => "open",
            Some(writers::Writers::Unknown) => "unknown",
            Some(writers::Writers::None) | None => "none",
        },
        until: (retained.writers == Some(writers::Writers::Unknown)).then(|| until(retained)),
        reason: retained_reason(&from, retained),
        from,
    }
}

/// Why a file set aside at `path` is kept, by what the last look found.
pub(super) fn retained_reason(path: &str, retained: &landing::Retained) -> String {
    let set_aside =
        format!("Marfa replaced or removed {path} and set the file it held aside under this name");
    match retained.writers {
        Some(writers::Writers::Open) => format!(
            "{set_aside}, because a program still holds it open for writing. If the program writes to it, Marfa puts it back; once the program closes it unchanged, Marfa deletes it"
        ),
        Some(writers::Writers::Unknown) => {
            let until = until(retained);
            format!(
                "{set_aside}, because Marfa cannot tell whether a program still writes to it. If it changes, Marfa puts it back; unchanged, Marfa deletes it on {until}"
            )
        }
        Some(writers::Writers::None) | None => {
            format!("{set_aside} until it looks again at whether a program still writes to it")
        }
    }
}

/// How many kept files one look at the programs writing files covers, which
/// bounds the files held open at once.
const SETTLED_AT_ONCE: usize = 128;

/// Settles one file kept because a program may still write to it, opened
/// from `aside` as `file`, with `writers`, what the look found, at `now`.
/// Where it changed and went back to its path, the binding there takes it,
/// keeping the content last agreed with the server, so the next scan sends
/// what the program wrote. Answers whether it is still kept.
fn settle_retained_row(
    conn: &rusqlite::Connection,
    row: &state::Retained,
    (dir, aside, file): (&Directory, &Directory, &std::fs::File),
    (writers, now): (writers::Writers, u64),
    root_device: Option<u64>,
    census: &writers::Census,
) -> Result<RowSettled> {
    let rows = Rows {
        conn,
        dir: row.dir.clone(),
        dir_at: row.dir_at,
        aside: row.aside.clone(),
        aside_at: row.aside_at,
        follow: None,
    };
    let guard = landing::Guard {
        aside,
        ledger: &rows,
        beside: !in_state(&row.dir),
        writers: census,
    };
    let retained = remounted_retained(row, dir, root_device);
    let settled = match landing::settle_retained(dir, guard, &retained, file, writers, now) {
        Ok(settled) => settled,
        Err(error) => {
            // Tried again at the next pass, and reported until it settles.
            state::put_kept(
                conn,
                &joined(&row.aside, &retained.kept),
                &format!(
                    "Marfa set {} aside while a program might still write to it, and could not look at it again: {error}",
                    joined(&row.dir, &retained.target)
                ),
            )?;
            return Ok(RowSettled::Kept);
        }
    };
    match settled {
        landing::Settled::Kept(kept) => {
            let looked = landing::Retained {
                read: landing::Object {
                    length: kept.read.length,
                    modified: kept.read.modified,
                    ..row.retained.read.clone()
                },
                changed: kept.changed,
                writers: kept.writers,
                ..row.retained.clone()
            };
            if looked != row.retained {
                state::set_retained(
                    conn,
                    &state::Retained {
                        retained: looked,
                        ..row.clone()
                    },
                )?;
            }
            Ok(RowSettled::Kept)
        }
        landing::Settled::PutBack(metadata) => {
            let path = joined(&row.dir, &retained.target);
            let tx = conn.unchecked_transaction()?;
            if let Some(bound) = state::bound_at(&tx, &path)? {
                state::bind(
                    &tx,
                    &state::Bound {
                        identity: identity::of(&metadata).map(|found| found.key()),
                        ..bound
                    },
                )?;
            }
            state::forget_stat(&tx, &path)?;
            state::clear_retained(&tx, &retained.id)?;
            tx.commit()?;
            Ok(RowSettled::Back)
        }
        landing::Settled::Restored => {
            state::clear_retained(conn, &retained.id)?;
            Ok(RowSettled::Back)
        }
        landing::Settled::Discarded => {
            state::clear_retained(conn, &retained.id)?;
            Ok(RowSettled::Discarded)
        }
        landing::Settled::Beside => {
            state::clear_retained(conn, &retained.id)?;
            Ok(RowSettled::Beside)
        }
        landing::Settled::Gone => {
            state::clear_retained(conn, &retained.id)?;
            Ok(RowSettled::Gone)
        }
    }
}

/// What settling one kept file left.
enum RowSettled {
    /// Still kept.
    Kept,
    /// Deleted, unchanged.
    Discarded,
    /// Back at its path.
    Back,
    /// Kept beside its path, which holds a newer save.
    Beside,
    /// No longer under its reserved name.
    Gone,
}

/// `row`'s file and the new file at its path on `dir`'s device, where the
/// volume was mounted again since the row was recorded.
fn remounted_retained(
    row: &state::Retained,
    dir: &Directory,
    root_device: Option<u64>,
) -> landing::Retained {
    let mut retained = row.retained.clone();
    let recorded = row.dir_at.0;
    if root_device == Some(recorded) {
        return retained;
    }
    let Ok(now) = dir.metadata().map(|found| landing::identity(&found).0) else {
        return retained;
    };
    for object in std::iter::once(&mut retained.read).chain(retained.ours.as_mut()) {
        if object.device == recorded {
            object.device = now;
        }
    }
    retained
}

impl Folder {
    /// Whether a file is kept because a program may still write to it.
    pub(super) fn retains(&self) -> Result<bool> {
        state::any_retained(&*self.core.conn()?)
    }

    /// The files the directory at `root` keeps because a program might
    /// still write to them, read from its store without claiming it, so it
    /// answers beside a running watch.
    pub fn kept_of(root: impl AsRef<Path>) -> Result<Vec<KeptFile>> {
        Folder::reading(root.as_ref())?.kept_files()
    }

    /// The files this folder keeps because a program might still write to
    /// them, in path order.
    pub fn kept_files(&self) -> Result<Vec<KeptFile>> {
        let mut files: Vec<KeptFile> = state::retained(&*self.core.conn()?)?
            .iter()
            .flatten()
            .map(kept_file)
            .collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    }

    /// Deletes each file kept because a program might still write to it,
    /// whatever programs hold it, where it is unchanged since Marfa set it
    /// aside. One a program wrote to goes back to its path, as a pass would
    /// put it back.
    pub fn discard_kept(&self) -> Result<KeptDiscarded> {
        let mut done = KeptDiscarded::default();
        for (row, settled) in self.settle_retained_as(true)? {
            match settled {
                RowSettled::Discarded => done.discarded.push(row.path),
                RowSettled::Back | RowSettled::Beside => done.put_back.push(row.from),
                RowSettled::Gone | RowSettled::Kept => {}
            }
        }
        done.kept = self.kept_files()?;
        Ok(done)
    }

    /// Settles each file kept because a program may still write to it, with
    /// one fresh look at the programs writing files for each batch of them,
    /// so the cost grows with what is kept, not with the folder. Each file is
    /// opened before the look, which then sees every program that opened it
    /// before. A file that went back to its path is one only a walk finds,
    /// so the next pass walks.
    pub(super) fn settle_retained(&self) -> Result<()> {
        self.settle_retained_as(false).map(|_| ())
    }

    /// The same, or, where `discard`, settles each as though no program held
    /// it. Answers each file it looked at and what became of it.
    fn settle_retained_as(&self, discard: bool) -> Result<Vec<(KeptFile, RowSettled)>> {
        let conn = self.core.conn()?;
        let rows = state::retained(&conn)?;
        let mut waiting = false;
        let mut back = false;
        let mut looked = Vec::new();
        if !rows.is_empty() {
            let root_device = device(&self.root_dir);
            let now = landing::seconds(crate::clock::system_time());
            for batch in rows.chunks(SETTLED_AT_ONCE) {
                let mut opened = Vec::with_capacity(batch.len());
                for row in batch {
                    match row {
                        Ok(row) => {
                            if let Some(open) = self.retained_open(&conn, row, now)? {
                                opened.push((row, open));
                            }
                        }
                        // What it kept stays under its reserved name, which
                        // every scan reports.
                        Err(id) => state::clear_retained(&conn, id)?,
                    }
                }
                if !discard {
                    self.writers.fresh();
                }
                for (row, (dir, aside, file)) in opened {
                    let writers = if discard {
                        writers::Writers::None
                    } else {
                        self.writers.of(&file)
                    };
                    let settled = settle_retained_row(
                        &conn,
                        row,
                        (&dir, &aside, &file),
                        (writers, now),
                        root_device,
                        &self.writers,
                    )?;
                    match settled {
                        RowSettled::Kept => waiting |= writers == writers::Writers::Open,
                        RowSettled::Back => back = true,
                        RowSettled::Discarded | RowSettled::Beside | RowSettled::Gone => {}
                    }
                    looked.push((kept_file(row), settled));
                }
            }
        }
        if !discard {
            self.writer_wait
                .store(waiting, std::sync::atomic::Ordering::Relaxed);
        }
        if back {
            self.forget_inventory();
        }
        Ok(looked)
    }

    /// `row`'s directory, the directory its reserved name is in, and the file
    /// there, opened read-only. Ends a row whose file is gone, and one whose
    /// directory has been away from where it was for as long as a file is
    /// kept, reporting its file kept wherever the directory went.
    #[allow(clippy::type_complexity)]
    fn retained_open(
        &self,
        conn: &rusqlite::Connection,
        row: &state::Retained,
        now: u64,
    ) -> Result<Option<(Directory, Directory, std::fs::File)>> {
        let retained = &row.retained;
        let places = self
            .displaced_dir(&row.dir, row.dir_at)
            .and_then(|dir| Ok((dir, self.displaced_dir(&row.aside, row.aside_at)?)));
        let (dir, aside) = match places {
            Ok(places) => places,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if now >= retained.since.saturating_add(landing::RETAINED_FOR) {
                    let tx = conn.unchecked_transaction()?;
                    state::put_kept(
                        &tx,
                        &joined(&row.aside, &retained.kept),
                        &format!(
                            "Marfa set {} aside while a program might still write to it, and its directory is no longer in the folder; the file stays under this name wherever the directory now is",
                            joined(&row.dir, &retained.target)
                        ),
                    )?;
                    state::clear_retained(&tx, &retained.id)?;
                    tx.commit()?;
                }
                return Ok(None);
            }
            // Tried again at the next pass.
            Err(_) => return Ok(None),
        };
        match aside.open_file(Path::new(&retained.kept), OFlags::RDONLY, Mode::empty()) {
            Ok(file) => Ok(Some((dir, aside, file))),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidInput
                ) =>
            {
                state::clear_retained(conn, &retained.id)?;
                Ok(None)
            }
            Err(_) => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(debug_assertions)]
    use std::io::Write;
    use std::path::Path;

    #[cfg(debug_assertions)]
    use super::super::state;
    use super::super::tests::{changed_elsewhere, landed, scanned_folder};
    use super::super::{Folder, landing};

    fn reserved_in(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| landing::is_reserved(Path::new(name)))
            .collect()
    }

    /// A folder whose `Notes/Plan.md` is bound to an item the server has
    /// changed since, so the next pull replaces it. Answers the item's id.
    fn changed_on_the_server(dir: &Path, folder: &Folder) -> String {
        std::fs::create_dir(dir.join("Notes")).unwrap();
        std::fs::write(dir.join("Notes/Plan.md"), "as it was\n").unwrap();
        assert_eq!(folder.scan().unwrap().created, 1);
        let id = landed(folder, "Notes/Plan.md");
        folder.pull().unwrap();
        changed_elsewhere(folder, &id, "changed elsewhere\n");
        id
    }

    fn holds(dir: &Path, text: &str) -> bool {
        std::fs::read_to_string(dir.join("Notes/Plan.md"))
            .unwrap()
            .contains(text)
    }

    #[test]
    fn a_file_a_program_holds_open_for_writing_is_written_once_it_closes() {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        changed_on_the_server(&root, &folder);
        let writer = std::fs::OpenOptions::new()
            .append(true)
            .open(root.join("Notes/Plan.md"))
            .unwrap();

        let report = folder.pull().unwrap();
        assert_eq!(report.busy, 1, "{report:?}");
        assert!(!holds(&root, "changed elsewhere"));
        assert!(reserved_in(&root.join("Notes")).is_empty());

        // The witness: the same pull, with the program gone, writes it.
        drop(writer);
        let report = folder.pull().unwrap();
        assert_eq!(report.busy, 0, "{report:?}");
        assert!(holds(&root, "changed elsewhere"));
        assert!(reserved_in(&root.join("Notes")).is_empty());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_file_kept_where_writers_are_unknown_is_listed_until_the_owner_discards_it() {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        changed_on_the_server(&root, &folder);
        {
            let _unknown = crate::fault::fail_on_this_thread("writers-unknown");
            folder.pull().unwrap();
            folder.scan().unwrap();
        }
        assert!(holds(&root, "changed elsewhere"));
        let reserved = reserved_in(&root.join("Notes"));
        assert_eq!(reserved.len(), 1);
        let kept = Folder::kept_of(&root).unwrap();
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(kept[0].path, format!("Notes/{}", reserved[0]));
        assert_eq!(kept[0].from, "Notes/Plan.md");
        assert_eq!(kept[0].writers, "unknown");
        assert!(kept[0].until.is_some());
        let status = Folder::status_of(&root).unwrap();
        assert!(
            status.files.iter().any(|file| file.path == kept[0].path),
            "{status:?}"
        );

        let done = folder.discard_kept().unwrap();
        assert_eq!(done.discarded, vec![kept[0].path.clone()]);
        assert!(done.put_back.is_empty() && done.kept.is_empty(), "{done:?}");
        assert!(reserved_in(&root.join("Notes")).is_empty());
        assert!(folder.kept_files().unwrap().is_empty());
        assert!(holds(&root, "changed elsewhere"));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_kept_file_whose_metadata_alone_changed_stays_kept_and_is_discarded() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        changed_on_the_server(&root, &folder);
        {
            let _unknown = crate::fault::fail_on_this_thread("writers-unknown");
            folder.pull().unwrap();
        }
        let reserved = reserved_in(&root.join("Notes"));
        assert_eq!(reserved.len(), 1);
        let kept_at = root.join("Notes").join(&reserved[0]);
        // A mode, its times and an extended attribute change; the bytes do not.
        std::fs::set_permissions(&kept_at, std::fs::Permissions::from_mode(0o640)).unwrap();
        let file = std::fs::File::options().write(true).open(&kept_at).unwrap();
        file.set_modified(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1))
            .unwrap();
        drop(file);
        #[cfg(target_os = "macos")]
        xattr::set(&kept_at, "com.apple.metadata:_kMDItemUserTags", b"tag").unwrap();

        {
            let _unknown = crate::fault::fail_on_this_thread("writers-unknown");
            let report = folder.scan().unwrap();
            assert_eq!(report.updated, 0, "{report:?}");
        }
        assert!(holds(&root, "changed elsewhere"));
        assert_eq!(reserved_in(&root.join("Notes")), reserved);
        let conn = folder.core.conn().unwrap();
        let rows = state::retained(&conn).unwrap();
        let row = rows[0].as_ref().unwrap();
        let now = std::fs::metadata(&kept_at).unwrap();
        assert_eq!(row.retained.read.length, Some(now.len()));
        assert_eq!(
            row.retained.read.modified,
            Some((1, 0)),
            "the new times are recorded, so the next pass does not hash it again"
        );
        drop(conn);

        let done = folder.discard_kept().unwrap();
        assert_eq!(
            done.discarded,
            vec![format!("Notes/{}", reserved[0])],
            "{done:?}"
        );
        assert!(done.put_back.is_empty(), "{done:?}");
        assert!(holds(&root, "changed elsewhere"));
        assert!(reserved_in(&root.join("Notes")).is_empty());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_kept_file_a_program_wrote_to_goes_back_and_is_sent() {
        for discard in [false, true] {
            let (dir, folder) = scanned_folder();
            let root = dir.path().canonicalize().unwrap();
            let id = changed_on_the_server(&root, &folder);
            {
                let _unknown = crate::fault::fail_on_this_thread("writers-unknown");
                folder.pull().unwrap();
            }
            let reserved = reserved_in(&root.join("Notes"));
            assert_eq!(reserved.len(), 1);
            let mut program = std::fs::OpenOptions::new()
                .append(true)
                .open(root.join("Notes").join(&reserved[0]))
                .unwrap();
            program.write_all(b"what the program wrote\n").unwrap();
            drop(program);

            if discard {
                let done = folder.discard_kept().unwrap();
                assert_eq!(done.put_back, vec!["Notes/Plan.md".to_string()], "{done:?}");
                assert!(done.discarded.is_empty());
            }
            let report = folder.scan().unwrap();
            assert_eq!(report.updated, 1, "discard {discard}: {report:?}");
            assert!(holds(&root, "what the program wrote"), "discard {discard}");
            assert!(reserved_in(&root.join("Notes")).is_empty());
            assert!(folder.kept_files().unwrap().is_empty());
            let bound = state::bound_at(&folder.core.conn().unwrap(), "Notes/Plan.md").unwrap();
            assert_eq!(bound.map(|bound| bound.item_id), Some(id));
        }
    }
}

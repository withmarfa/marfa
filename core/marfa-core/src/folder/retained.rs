//! Files a pull set aside while a program might still write to them, kept
//! under their reserved names until a pass settles them.

use super::fields::VERSION_FIELD;
use super::{
    Directory, Folder, OUTSIDE, Rows, carries_frontmatter, device, document, identity, in_state,
    joined, landing, line_of, state, writers,
};
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
    /// The files still kept, each with why: one Marfa could not reach, one
    /// it does not change because it is outside the folder, or one a
    /// program wrote to that could not go back.
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
    if row.outside() {
        return KeptFile {
            path: joined(&row.aside, &retained.kept),
            writers: "none",
            until: None,
            reason: outside_retained(&from),
            from,
        };
    }
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

pub(super) const UNREAD: &str = "Marfa could not read its record";

fn unread_file(row: &state::Unread) -> KeptFile {
    KeptFile {
        path: joined(&row.aside, &row.kept),
        from: row.from.clone(),
        writers: "unknown",
        until: None,
        reason: if row.outside {
            outside_unread(&row.from)
        } else {
            UNREAD.into()
        },
    }
}

/// Why a file kept outside the folder, set aside from `from`, is left there.
fn outside_retained(from: &str) -> String {
    let from = if from.is_empty() { "a file" } else { from };
    format!("Marfa set {from} aside here as it took the file in from another folder. {OUTSIDE}")
}

/// The same, for a file whose record does not read.
fn outside_unread(from: &str) -> String {
    if from.is_empty() {
        format!("{UNREAD}. {OUTSIDE}")
    } else {
        format!("{UNREAD}, which names {from}. {OUTSIDE}")
    }
}

fn left_reason(left: &str) -> String {
    format!(
        "{left}, so it stays under this name until Marfa can put it back; delete it when it is not needed"
    )
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
        landing::Settled::Left => Ok(RowSettled::Kept),
        landing::Settled::PutBack { metadata, replaced } => {
            let path = joined(&row.dir, &retained.target);
            let read_at = put_back_read_at(&path, file, &replaced, &retained.read);
            let tx = conn.unchecked_transaction()?;
            if let Some(bound) = state::bound_at(&tx, &path)? {
                state::bind(
                    &tx,
                    &state::Bound {
                        identity: identity::of(&metadata).map(|found| found.key()),
                        // A remote edit since meets what the program wrote as
                        // any concurrent edit does.
                        content_hash: read_at
                            .map_or(bound.content_hash.clone(), state::untaken_read_at),
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
        landing::Settled::Beside(at) => {
            state::clear_retained(conn, &retained.id)?;
            if landing::is_reserved(&at) {
                return Ok(RowSettled::Stayed);
            }
            Ok(RowSettled::Beside(joined(&row.dir, &at.to_string_lossy())))
        }
        landing::Settled::Gone => {
            state::clear_retained(conn, &retained.id)?;
            Ok(RowSettled::Gone)
        }
    }
}

/// The version a document put back at `path` was read at, where `file` is
/// the kept file now there and `replaced` the file the pull wrote. Where the
/// kept file was set aside as `replaced` but for its version line, the pull
/// moved only that line past this device's own edit, and the file holds what
/// `replaced` shows; otherwise it holds what its own line says.
fn put_back_read_at(
    path: &str,
    file: &std::fs::File,
    replaced: &[u8],
    set_aside: &landing::Object,
) -> Option<i64> {
    use std::io::{Read, Seek};
    if !carries_frontmatter(Path::new(path)) {
        return None;
    }
    let mut file = file;
    let mut kept = String::new();
    file.seek(std::io::SeekFrom::Start(0)).ok()?;
    file.read_to_string(&mut kept).ok()?;
    let kept_line = version_line(&kept)?;
    if let Ok(replaced) = std::str::from_utf8(replaced)
        && let Some(written) = version_line(replaced)
    {
        let as_set_aside = [
            &replaced[..written.start],
            &kept[kept_line.clone()],
            &replaced[written.end..],
        ]
        .concat();
        if set_aside.hash.as_deref() == Some(state::hash(as_set_aside.as_bytes()).as_str()) {
            return line_of(&document::read(replaced).front);
        }
    }
    line_of(&document::read(&kept).front)
}

/// Where in `text` its front matter's `marfa_version` line is, with its
/// line ending.
fn version_line(text: &str) -> Option<std::ops::Range<usize>> {
    let mut lines = text.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end() != "---" {
        return None;
    }
    let mut at = first.len();
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed == "---" {
            return None;
        }
        if trimmed.starts_with(&format!("{VERSION_FIELD}:")) {
            return Some(at..at + line.len());
        }
        at += line.len();
    }
    None
}

/// What settling one kept file left.
enum RowSettled {
    /// Still kept.
    Kept,
    /// Deleted, unchanged.
    Discarded,
    /// Back at its path.
    Back,
    /// Kept beside its path, which holds a newer save, at this path.
    Beside(String),
    /// Changed, and left under its reserved name, which no pass settles, as
    /// it could not go back to or beside its path.
    Stayed,
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
        let conn = self.core.conn()?;
        let mut moved = std::collections::HashMap::new();
        let mut files = Vec::new();
        for (path, mark) in state::discarding(&conn)? {
            let outside = !state::in_folder(&path);
            match mark {
                Some(mark) => {
                    let gone = !outside
                        && self
                            .place_dir(&mark.aside)
                            .and_then(|aside| aside.entry_identity(Path::new(&mark.private)))
                            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
                    if !gone {
                        moved.insert(mark.id.clone(), (path, mark));
                    }
                }
                None => files.push(KeptFile {
                    reason: if outside {
                        outside_unread("")
                    } else {
                        format!("{UNREAD}; delete it when it is not needed")
                    },
                    path,
                    from: String::new(),
                    writers: "unknown",
                    until: None,
                }),
            }
        }
        for row in state::retained(&conn)? {
            let (id, mut file, outside) = match &row {
                Ok(row) => (&row.retained.id, kept_file(row), row.outside()),
                Err(row) => (&row.id, unread_file(row), row.outside),
            };
            if let Some((path, mark)) = moved.remove(id) {
                if !state::in_folder(&path) {
                    if !outside {
                        file.reason = outside_retained(&mark.from);
                    }
                } else if let Some(left) = &mark.left {
                    file.reason = left_reason(left);
                }
                file.path = path;
            }
            files.push(file);
        }
        files.extend(moved.into_values().map(|(path, mark)| KeptFile {
            reason: if state::in_folder(&path) {
                left_reason(
                    mark.left
                        .as_deref()
                        .unwrap_or("Marfa stopped as it discarded it"),
                )
            } else {
                outside_retained(&mark.from)
            },
            path,
            from: mark.from,
            writers: "unknown",
            until: None,
        }));
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
                RowSettled::Back => done.put_back.push(row.from),
                RowSettled::Beside(at) => done.put_back.push(at),
                RowSettled::Stayed => done.kept.push(KeptFile {
                    reason: format!(
                        "a program wrote to it, and Marfa could not put it back at or beside {}, so it stays under this name; move it back yourself",
                        row.from
                    ),
                    ..row
                }),
                RowSettled::Gone | RowSettled::Kept => {}
            }
        }
        done.kept.extend(self.kept_files()?);
        done.kept.sort_by(|a, b| a.path.cmp(&b.path));
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
        let marked = self.settle_discarding(&conn)?;
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
                        Ok(row) if row.outside() => {
                            let file = kept_file(row);
                            let path = marked.get(&row.retained.id).unwrap_or(&file.path);
                            state::put_kept(&conn, path, &file.reason)?;
                        }
                        Err(row) if row.outside => {
                            let file = unread_file(row);
                            state::put_kept(&conn, &file.path, &file.reason)?;
                        }
                        Ok(row) => {
                            if let Some(open) = self.retained_open(&conn, row, now)? {
                                opened.push((row, open));
                            }
                        }
                        // Left for the owner to discard.
                        Err(row) if discard => {
                            let settled = self.discard_unread(&conn, row)?;
                            looked.push((unread_file(row), settled));
                        }
                        Err(_) => {}
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
                        RowSettled::Discarded
                        | RowSettled::Beside(_)
                        | RowSettled::Stayed
                        | RowSettled::Gone => {}
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

    /// Restore the kept name so the retained record can settle the file.
    /// A mark outside the folder is reported and left. Answers, by record,
    /// the path each readable one names.
    fn settle_discarding(
        &self,
        conn: &rusqlite::Connection,
    ) -> Result<std::collections::HashMap<String, String>> {
        let mut outside = std::collections::HashMap::new();
        let marks = state::discarding(conn)?;
        if marks.is_empty() {
            return Ok(outside);
        }
        let rows: std::collections::HashSet<String> = state::retained(conn)?
            .into_iter()
            .map(|row| match row {
                Ok(row) => row.retained.id,
                Err(row) => row.id,
            })
            .collect();
        for (path, mark) in marks {
            if !state::in_folder(&path) {
                let reason = mark
                    .as_ref()
                    .map_or_else(|| outside_unread(""), |mark| outside_retained(&mark.from));
                state::put_kept(conn, &path, &reason)?;
                if let Some(mark) = mark {
                    outside.insert(mark.id, path);
                }
                continue;
            }
            let Some(mark) = mark else { continue };
            let Ok(aside) = self.place_dir(&mark.aside) else {
                continue;
            };
            let private = Path::new(&mark.private);
            match aside.entry_identity(private) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    state::clear_discarding_at(conn, &path)?;
                    continue;
                }
                Err(_) => continue,
            }
            if !rows.contains(&mark.id) {
                continue;
            }
            match landing::rename_new_at(&aside, private, &aside, Path::new(&mark.kept)) {
                Ok(()) => state::clear_discarding_at(conn, &path)?,
                Err(error)
                    if error.kind() == std::io::ErrorKind::AlreadyExists && mark.left.is_none() =>
                {
                    state::set_discarding(
                        conn,
                        &state::Discarding {
                            left: Some(
                                "Marfa stopped as it discarded it, and another file took the name it was kept under".into(),
                            ),
                            ..mark
                        },
                    )?;
                }
                Err(_) => {}
            }
        }
        Ok(outside)
    }

    /// Deletes the file of a row that does not read, which only the owner's
    /// discard does, and only where its bytes are still the ones the row
    /// says were set aside: anything else may be what a program wrote, and
    /// stays listed.
    fn discard_unread(
        &self,
        conn: &rusqlite::Connection,
        row: &state::Unread,
    ) -> Result<RowSettled> {
        let aside = match self.place_dir(&row.aside) {
            Ok(aside) => aside,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                state::clear_retained(conn, &row.id)?;
                return Ok(RowSettled::Gone);
            }
            Err(_) => return Ok(RowSettled::Kept),
        };
        let unchanged = match aside.read(Path::new(&row.kept)) {
            Ok(bytes) => row
                .hash
                .as_deref()
                .is_some_and(|hash| state::hash(&bytes) == hash),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                state::clear_retained(conn, &row.id)?;
                return Ok(RowSettled::Gone);
            }
            Err(_) => false,
        };
        if !unchanged {
            return Ok(RowSettled::Kept);
        }
        let name = Path::new(&row.kept);
        let still = |private: &Path| {
            Ok(aside
                .read(private)
                .is_ok_and(|bytes| row.hash.as_deref() == Some(state::hash(&bytes).as_str())))
        };
        let mark = |private: &Path, mark: landing::Mark<'_>| {
            let discarding = state::Discarding {
                id: row.id.clone(),
                aside: row.aside.clone(),
                kept: row.kept.clone(),
                private: private.to_string_lossy().into_owned(),
                from: row.from.clone(),
                left: None,
            };
            state::mark_discarding(conn, discarding, mark)
                .map_err(|error| std::io::Error::other(error.to_string()))
        };
        let settled = match landing::discard_checked(&aside, name, None, still, mark) {
            Ok(landing::Discard::Removed) => RowSettled::Discarded,
            Ok(landing::Discard::Absent) => RowSettled::Gone,
            // Listed still, for the owner to look at or another try.
            Ok(landing::Discard::Changed | landing::Discard::Left) | Err(_) => {
                return Ok(RowSettled::Kept);
            }
        };
        state::clear_retained(conn, &row.id)?;
        Ok(settled)
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
    fn a_kept_file_whose_record_does_not_read_is_listed_and_discarded() {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        changed_on_the_server(&root, &folder);
        {
            let _unknown = crate::fault::fail_on_this_thread("writers-unknown");
            folder.pull().unwrap();
        }
        let reserved = reserved_in(&root.join("Notes"));
        assert_eq!(reserved.len(), 1);
        let path = format!("Notes/{}", reserved[0]);
        // The witness: while its record reads, it is listed.
        assert_eq!(folder.kept_files().unwrap()[0].path, path);
        folder
            .core
            .conn()
            .unwrap()
            .execute(
                "UPDATE meta SET value = json_set(value, '$.retained.since', 'soon') WHERE key LIKE 'folder_retained:%'",
                [],
            )
            .unwrap();

        folder.scan().unwrap();
        let kept = Folder::kept_of(&root).unwrap();
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(kept[0].path, path);
        assert_eq!(kept[0].from, "Notes/Plan.md");
        assert_eq!(kept[0].reason, "Marfa could not read its record");
        assert_eq!(reserved_in(&root.join("Notes")), reserved);

        let done = folder.discard_kept().unwrap();
        assert_eq!(done.discarded, vec![path], "{done:?}");
        assert!(done.kept.is_empty(), "{done:?}");
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
    fn a_kept_file_a_program_wrote_to_goes_back_and_is_sent_as_read_at_its_own_version() {
        for discard in [false, true] {
            let (dir, folder) = scanned_folder();
            let root = dir.path().canonicalize().unwrap();
            let id = changed_on_the_server(&root, &folder);
            // The scan's create still waits, so the pull counts version 2 as
            // this device's own edit, and the file's line alone would put the
            // edit on 2.
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
            assert_eq!(bound.map(|bound| bound.item_id), Some(id.clone()));
            let bases: Vec<Option<i64>> = folder
                .core
                .queue()
                .unwrap()
                .into_iter()
                .filter(|write| {
                    write.kind == crate::model::WriteKind::UpdateItem
                        && write.item_id.as_deref() == Some(id.as_str())
                })
                .map(|write| write.base_version)
                .collect();
            assert_eq!(
                bases,
                vec![Some(1)],
                "discard {discard}: what the program wrote goes on the version it read"
            );
        }
    }

    /// Whether a file in `Notes`, kept or not, holds `text`.
    #[cfg(debug_assertions)]
    fn kept_somewhere(root: &Path, text: &str) -> bool {
        std::fs::read_dir(root.join("Notes")).unwrap().any(|entry| {
            std::fs::read_to_string(entry.unwrap().path()).is_ok_and(|held| held.contains(text))
        })
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_kept_file_written_to_as_the_owner_discards_it_is_not_deleted() {
        for unread in [false, true] {
            let (dir, folder) = scanned_folder();
            let root = dir.path().canonicalize().unwrap();
            changed_on_the_server(&root, &folder);
            {
                let _unknown = crate::fault::fail_on_this_thread("writers-unknown");
                folder.pull().unwrap();
            }
            assert_eq!(reserved_in(&root.join("Notes")).len(), 1);
            if unread {
                folder
                    .core
                    .conn()
                    .unwrap()
                    .execute(
                        "UPDATE meta SET value = json_set(value, '$.retained.since', 'soon') WHERE key LIKE 'folder_retained:%'",
                        [],
                    )
                    .unwrap();
            }

            let done = {
                let _write = crate::fault::fail_on_this_thread("write-before-discard");
                folder.discard_kept().unwrap()
            };

            assert!(done.discarded.is_empty(), "unread {unread}: {done:?}");
            assert!(
                kept_somewhere(&root, "written before the discard"),
                "unread {unread}: the write was deleted"
            );
            if unread {
                assert_eq!(done.kept.len(), 1, "{done:?}");
                assert_eq!(reserved_in(&root.join("Notes")).len(), 1);
            }
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_kept_file_put_back_beside_an_edited_path_is_reported_where_it_went() {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        changed_on_the_server(&root, &folder);
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
        std::fs::write(root.join("Notes/Plan.md"), "the person's edit\n").unwrap();

        let done = folder.discard_kept().unwrap();

        assert_eq!(done.put_back.len(), 1, "{done:?}");
        assert_ne!(done.put_back[0], "Notes/Plan.md", "{done:?}");
        let went = std::fs::read_to_string(root.join(&done.put_back[0])).unwrap();
        assert!(went.contains("what the program wrote"), "{done:?}");
        assert!(holds(&root, "the person's edit"));
    }

    /// Creates a retained file with a readable or damaged record.
    #[cfg(debug_assertions)]
    fn kept_aside(
        unread: bool,
    ) -> (
        super::super::tests::ScannedDir,
        Folder,
        std::path::PathBuf,
        String,
    ) {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        changed_on_the_server(&root, &folder);
        {
            let _unknown = crate::fault::fail_on_this_thread("writers-unknown");
            folder.pull().unwrap();
        }
        let reserved = reserved_in(&root.join("Notes"));
        assert_eq!(reserved.len(), 1);
        if unread {
            folder
                .core
                .conn()
                .unwrap()
                .execute(
                    "UPDATE meta SET value = json_set(value, '$.retained.since', 'soon') WHERE key LIKE 'folder_retained:%'",
                    [],
                )
                .unwrap();
        }
        (dir, folder, root, format!("Notes/{}", reserved[0]))
    }

    /// Each kept path listed, and whether a file is there.
    #[cfg(debug_assertions)]
    fn listed(root: &Path, kept: &[super::KeptFile]) -> Vec<(String, bool)> {
        kept.iter()
            .map(|file| (file.path.clone(), root.join(&file.path).is_file()))
            .collect()
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_kept_file_discarded_is_gone_with_nothing_left_under_another_name() {
        for unread in [false, true] {
            let (_dir, folder, root, path) = kept_aside(unread);

            let done = folder.discard_kept().unwrap();

            assert_eq!(done.discarded, vec![path], "unread {unread}: {done:?}");
            assert!(done.kept.is_empty(), "unread {unread}: {done:?}");
            assert!(
                reserved_in(&root.join("Notes")).is_empty(),
                "unread {unread}"
            );
            assert!(folder.kept_files().unwrap().is_empty(), "unread {unread}");
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_kept_file_whose_delete_is_refused_is_listed_where_it_is() {
        for unread in [false, true] {
            let (_dir, folder, root, _) = kept_aside(unread);

            let done = {
                let _refused = crate::fault::fail_on_this_thread("discard-unlink-refused");
                folder.discard_kept().unwrap()
            };

            assert!(done.discarded.is_empty(), "unread {unread}: {done:?}");
            let kept = listed(&root, &done.kept);
            assert_eq!(kept.len(), 1, "unread {unread}: {done:?}");
            assert!(kept[0].1, "unread {unread}: {kept:?} names no file");
            assert_eq!(
                listed(&root, &Folder::kept_of(&root).unwrap()),
                kept,
                "unread {unread}"
            );
            folder.scan().unwrap();
            let after = listed(&root, &folder.kept_files().unwrap());
            assert!(
                unread || after.is_empty(),
                "unread {unread}: a pass discards it now: {after:?}"
            );
            assert!(after.iter().all(|(_, there)| *there), "{after:?}");
            assert_eq!(reserved_in(&root.join("Notes")).len(), after.len());
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_kept_file_a_discard_stopped_on_is_listed_put_back_and_keeps_what_was_written() {
        for unread in [false, true] {
            let (dir, folder, root, path) = kept_aside(unread);
            let mut program = std::fs::OpenOptions::new()
                .append(true)
                .open(root.join(&path))
                .unwrap();
            {
                let _stop = crate::fault::fail_on_this_thread("crash-after-private-rename");
                let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    folder.discard_kept()
                }));
                assert!(stopped.is_err(), "it did not stop");
            }
            drop(folder);
            program.write_all(b"written after the stop\n").unwrap();
            drop(program);

            let kept = listed(&root, &Folder::kept_of(&root).unwrap());
            assert_eq!(kept.len(), 1, "unread {unread}: {kept:?}");
            assert!(kept[0].1, "unread {unread}: {kept:?} names no file");

            let folder = Folder::open(&root, None).unwrap();
            {
                let _unknown = crate::fault::fail_on_this_thread("writers-unknown");
                folder.scan().unwrap();
            }
            let kept = listed(&root, &folder.kept_files().unwrap());
            if unread {
                assert_eq!(kept, vec![(path.clone(), true)], "unread: {kept:?}");
            }
            assert!(
                kept_somewhere(&root, "written after the stop"),
                "unread {unread}: the write was lost"
            );
            let done = folder.discard_kept().unwrap();
            assert!(done.discarded.is_empty(), "unread {unread}: {done:?}");
            assert!(
                kept_somewhere(&root, "written after the stop"),
                "unread {unread}: the write was deleted"
            );
            drop(dir);
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_kept_file_a_discard_stopped_on_stays_listed_when_another_file_takes_its_name() {
        for unread in [false, true] {
            let (_dir, folder, root, path) = kept_aside(unread);
            {
                let _stop = crate::fault::fail_on_this_thread("crash-after-private-rename");
                let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    folder.discard_kept()
                }));
                assert!(stopped.is_err(), "it did not stop");
            }
            drop(folder);
            std::fs::write(root.join(&path), "another file\n").unwrap();

            let folder = Folder::open(&root, None).unwrap();
            folder.scan().unwrap();
            folder.discard_kept().unwrap();

            let kept = listed(&root, &folder.kept_files().unwrap());
            let aside: Vec<&(String, bool)> = kept.iter().filter(|(at, _)| *at != path).collect();
            assert_eq!(aside.len(), 1, "unread {unread}: {kept:?}");
            assert!(aside[0].1, "unread {unread}: {kept:?}");
            assert!(
                std::fs::read_to_string(root.join(&aside[0].0))
                    .unwrap()
                    .contains("as it was"),
                "unread {unread}"
            );
        }
    }

    /// The file a take-in from another folder read.
    const TAKEN: &[u8] = b"as the server has it\n";

    /// A directory beside the folder's, as another folder's is.
    fn beside(root: &Path) -> (tempfile::TempDir, std::path::PathBuf) {
        let other = tempfile::tempdir_in(root.join("..")).unwrap();
        let path = other.path().canonicalize().unwrap();
        (other, path)
    }

    fn identity_of(path: &Path) -> (u64, u64) {
        landing::identity(&std::fs::metadata(path).unwrap())
    }

    /// What a take-in from another folder recorded as it set `Recovery.md`
    /// aside in `dir`, named as `place`, eight days ago, where it could not
    /// tell whether a program writes to it. Answers the record's id and the
    /// file under its reserved name, unchanged since.
    fn kept_by_a_take_in(folder: &Folder, dir: &Path, place: &str) -> (String, std::path::PathBuf) {
        let id = uuid::Uuid::now_v7().simple().to_string();
        let name = landing::reserved(&id);
        let kept = dir.join(&name);
        std::fs::write(&kept, TAKEN).unwrap();
        let (device, inode) = identity_of(&kept);
        let now = landing::seconds(crate::clock::system_time());
        state::set_retained(
            &folder.core.conn().unwrap(),
            &state::Retained {
                dir: place.into(),
                dir_at: identity_of(dir),
                aside: place.into(),
                aside_at: identity_of(dir),
                retained: landing::Retained {
                    id: id.clone(),
                    kind: landing::Displaced::Withdraw,
                    target: "Recovery.md".into(),
                    kept: name.to_string_lossy().into_owned(),
                    ours: None,
                    read: landing::Object {
                        device,
                        inode,
                        length: None,
                        modified: None,
                        hash: Some(state::hash(TAKEN)),
                    },
                    changed: None,
                    since: now - landing::RETAINED_FOR - 24 * 60 * 60,
                    writers: Some(super::super::writers::Writers::Unknown),
                },
            },
        )
        .unwrap();
        (id, kept)
    }

    /// A note scanned and answered, so a pull runs against the folder's copy.
    fn pullable(root: &Path, folder: &Folder) {
        std::fs::write(root.join("Ready.md"), "ready\n").unwrap();
        assert_eq!(folder.scan().unwrap().created, 1);
        landed(folder, "Ready.md");
    }

    fn records(folder: &Folder) -> usize {
        state::retained(&folder.core.conn().unwrap()).unwrap().len()
    }

    fn path_of(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    /// Asserts `reason` says the file came from `from` and stays outside the
    /// folder untouched.
    fn says_outside(reason: &str, from: &Path) {
        assert!(
            reason.contains(&path_of(from)) && reason.contains("outside this folder"),
            "{reason}"
        );
    }

    /// The paths `flagged` reports kept.
    fn reported(flagged: &[super::super::Flagged]) -> Vec<&str> {
        flagged
            .iter()
            .filter(|flagged| flagged.flag == "kept")
            .map(|flagged| flagged.path.as_str())
            .collect()
    }

    #[test]
    fn a_kept_file_outside_the_folder_survives_every_door_and_discard() {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        pullable(&root, &folder);
        let (_other, other) = beside(&root);
        let (_, kept) = kept_by_a_take_in(&folder, &other, &path_of(&other));
        std::fs::create_dir(root.join("Projects")).unwrap();
        let (_, inside) = kept_by_a_take_in(&folder, &root.join("Projects"), "Projects");
        let from = other.join("Recovery.md");

        let scanned = folder.scan().unwrap();
        // The witness: the same file in the folder is deleted.
        assert!(!inside.exists());
        assert!(reported(&scanned.flagged).contains(&path_of(&kept).as_str()));
        let pulled = folder.pull().unwrap();
        assert!(reported(&pulled.flagged).contains(&path_of(&kept).as_str()));
        folder.confirm().unwrap();
        folder.remove_unmatched(&[]).unwrap();
        let done = folder.discard_kept().unwrap();

        assert!(done.discarded.is_empty(), "{done:?}");
        assert!(done.put_back.is_empty(), "{done:?}");
        let listed = folder.kept_files().unwrap();
        assert_eq!(done.kept, listed);
        assert_eq!(Folder::kept_of(&root).unwrap(), listed);
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert_eq!(listed[0].path, path_of(&kept));
        assert_eq!(listed[0].from, path_of(&from));
        assert_eq!(listed[0].writers, "none");
        assert_eq!(listed[0].until, None);
        says_outside(&listed[0].reason, &from);
        assert_eq!(std::fs::read(&kept).unwrap(), TAKEN);
        assert!(!from.exists());
        assert_eq!(records(&folder), 1);
    }

    #[test]
    fn an_unreadable_kept_file_record_outside_the_folder_deletes_nothing() {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        let (_other, other) = beside(&root);
        std::fs::create_dir(root.join("Projects")).unwrap();
        let outside = path_of(&other);
        let mut files = Vec::new();
        // An outside `aside`, an outside `dir` with no `aside`, and the
        // witness, an `aside` in the folder.
        for (id, dir, aside, there) in [
            (
                "1",
                Some(outside.as_str()),
                Some(outside.as_str()),
                other.clone(),
            ),
            ("2", Some(outside.as_str()), None, root.clone()),
            (
                "3",
                Some("Projects"),
                Some("Projects"),
                root.join("Projects"),
            ),
        ] {
            let name = path_of(&landing::reserved(id));
            std::fs::write(there.join(&name), TAKEN).unwrap();
            files.push(there.join(&name));
            // No `kind`, so the record does not read.
            let mut value = serde_json::json!({
                "dir": dir,
                "retained": {
                    "id": id,
                    "target": "Recovery.md",
                    "kept": name,
                    "read": { "hash": state::hash(TAKEN) },
                },
            });
            if let Some(aside) = aside {
                value["aside"] = aside.into();
            }
            crate::store::meta_set(
                &folder.core.conn().unwrap(),
                &format!("folder_retained:{id}"),
                &value.to_string(),
            )
            .unwrap();
        }
        let from = other.join("Recovery.md");

        let scanned = folder.scan().unwrap();
        let flagged = reported(&scanned.flagged);
        for at in [
            other.join(path_of(&landing::reserved("1"))),
            other.join(path_of(&landing::reserved("2"))),
        ] {
            assert!(
                flagged.contains(&path_of(&at).as_str()),
                "{at:?} in {flagged:?}"
            );
        }
        let done = folder.discard_kept().unwrap();

        assert!(files[0].exists() && files[1].exists(), "{done:?}");
        assert!(!files[2].exists(), "the witness: {done:?}");
        assert_eq!(
            done.discarded,
            vec![format!("Projects/{}", path_of(&landing::reserved("3")))]
        );
        let listed = folder.kept_files().unwrap();
        assert_eq!(listed.len(), 2, "{listed:?}");
        for file in &listed {
            assert!(file.reason.starts_with(super::UNREAD), "{file:?}");
            says_outside(&file.reason, &from);
        }
        assert_eq!(records(&folder), 2);
    }

    #[test]
    fn a_stopped_discard_outside_the_folder_renames_nothing() {
        for readable in [true, false] {
            let (dir, folder) = scanned_folder();
            let root = dir.path().canonicalize().unwrap();
            pullable(&root, &folder);
            let (_other, other) = beside(&root);
            let (id, kept) = kept_by_a_take_in(&folder, &other, &path_of(&other));
            let private = other.join(landing::reserved(
                &uuid::Uuid::now_v7().simple().to_string(),
            ));
            std::fs::rename(&kept, &private).unwrap();
            let from = other.join("Recovery.md");
            let mark = state::Discarding {
                id,
                aside: path_of(&other),
                kept: path_of(kept.file_name().unwrap().as_ref()),
                private: path_of(private.file_name().unwrap().as_ref()),
                from: path_of(&from),
                left: None,
            };
            let conn = folder.core.conn().unwrap();
            if readable {
                state::set_discarding(&conn, &mark).unwrap();
            } else {
                crate::store::meta_set(
                    &conn,
                    &format!("folder_discarding:{}", path_of(&private)),
                    "not a mark",
                )
                .unwrap();
            }
            drop(conn);

            for _ in 0..2 {
                let scanned = folder.scan().unwrap();
                let flagged = reported(&scanned.flagged);
                assert!(
                    flagged.contains(&path_of(&private).as_str()),
                    "readable {readable}: {flagged:?}"
                );
                // One report for one file: the record's goes to the name its mark holds it under.
                assert_eq!(
                    flagged.contains(&path_of(&kept).as_str()),
                    !readable,
                    "readable {readable}: {flagged:?}"
                );
            }
            folder.pull().unwrap();
            let done = folder.discard_kept().unwrap();

            assert!(done.discarded.is_empty(), "readable {readable}: {done:?}");
            assert_eq!(
                std::fs::read(&private).unwrap(),
                TAKEN,
                "readable {readable}"
            );
            assert!(!kept.exists(), "readable {readable}");
            let listed = folder.kept_files().unwrap();
            assert!(
                listed.iter().any(|file| file.path == path_of(&private)),
                "readable {readable}: {listed:?}"
            );
            for file in &listed {
                assert!(
                    file.reason.contains("outside this folder"),
                    "readable {readable}: {file:?}"
                );
            }
            assert_eq!(listed.len(), if readable { 1 } else { 2 }, "{listed:?}");
            assert_eq!(
                state::discarding(&folder.core.conn().unwrap())
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(records(&folder), 1);
        }
    }
}

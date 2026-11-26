//! Files a pull set aside while a program might still write to them, kept
//! under their reserved names until a pass settles them.

use super::fields::VERSION_FIELD;
use super::{
    Directory, Folder, Rows, carries_frontmatter, device, document, identity, in_state, joined,
    landing, line_of, outside_reason, state, unread_displaced_reason, writers,
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
    /// The files still kept, where Marfa could not reach them.
    pub kept: Vec<KeptFile>,
    /// The paths of records of a stopped discard that do not read, which
    /// Marfa forgot because no file is at them in the folder's own
    /// directory. No file was deleted.
    pub forgotten: Vec<String>,
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

/// `row` as listed, with why Marfa keeps it where it names a directory
/// outside the folder.
fn retained_file(row: &state::Retained) -> KeptFile {
    let mut file = kept_file(row);
    if row.outside() {
        file.reason = outside_reason(&file.from);
        file.writers = "unknown";
        file.until = None;
    }
    file
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

pub(super) const UNREAD: &str = "Marfa could not read its record";

/// Whether nothing shows that `row`'s directory is the one it names: it is
/// outside the folder, or a directory below the root the row holds no
/// identity for.
fn unverified(row: &state::Unread) -> bool {
    Path::new(&row.aside).is_absolute() || (row.aside_at.is_none() && !row.aside.is_empty())
}

/// Why a file under a record that does not read stays.
pub(super) fn unread_reason(row: &state::Unread) -> String {
    if unverified(row) {
        format!(
            "Marfa could not read its record, and cannot tell that this directory is the one it set the file aside in, so it deletes nothing here and keeps the record; delete the file when it is not needed. {}",
            super::END_RECORD
        )
    } else {
        UNREAD.into()
    }
}

fn unread_file(row: &state::Unread) -> KeptFile {
    KeptFile {
        path: joined(&row.aside, &row.kept),
        from: row.from.clone(),
        writers: "unknown",
        until: None,
        reason: unread_reason(row),
    }
}

/// Why an unreadable record of a stopped discard whose file is gone from the
/// folder's own directory is still listed.
const UNREAD_GONE: &str = "Marfa could not read its record of a discard it stopped on, and no file is at this path. Run `marfa folders kept <DIR> --discard` to forget the record";

/// Why an unreadable record of a stopped discard is still listed where no
/// file is at its path in a directory Marfa cannot show is the one it was in.
const UNREAD_UNPROVED: &str = "Marfa could not read its record of a discard it stopped on, and no file is at this path, but it cannot tell the directory at the path from another put at its name, so the file may be wherever that directory went. Put the directory back, or make the directory stop following its folder with `marfa folders remove <DIR>`";

/// Why a file a stopped discard left is listed while Marfa cannot show the
/// directory at its path is the one the discard recorded.
fn away_reason(why: &str) -> String {
    format!(
        "Marfa stopped as it discarded it, and cannot tell where the file is: {why}. It stays listed until the directory is back where it was; delete the file there when it is not needed, or make the directory stop following its folder with `marfa folders remove <DIR>`"
    )
}

/// A record Marfa keeps and acts on no file for, by its key.
enum Unproved {
    Displaced(String),
    Retained(String),
}

/// Each record Marfa keeps and acts on no file for, with its file's path.
fn unproved(conn: &rusqlite::Connection) -> Result<Vec<(String, Unproved)>> {
    let mut records = Vec::new();
    for row in state::displaced(conn)? {
        match row {
            Ok(row) if row.outside() => records.push((
                joined(&row.aside, &row.displacement.kept),
                Unproved::Displaced(row.displacement.id),
            )),
            Err(row) if !row.inside => records.push((row.path, Unproved::Displaced(row.id))),
            Ok(_) | Err(_) => {}
        }
    }
    for row in state::retained(conn)? {
        match row {
            Ok(row) if row.outside() => records.push((
                joined(&row.aside, &row.retained.kept),
                Unproved::Retained(row.retained.id),
            )),
            Err(row) if Path::new(&row.aside).is_absolute() => {
                records.push((joined(&row.aside, &row.kept), Unproved::Retained(row.id)));
            }
            Ok(_) | Err(_) => {}
        }
    }
    Ok(records)
}

/// Where the file of a record of a stopped discard that does not read is.
enum UnreadMark {
    /// Something is at its path, or Marfa cannot tell.
    There,
    /// Nothing is at its path, in the folder's own directory.
    Gone,
    /// Nothing is at its path, in a directory Marfa cannot show is the one
    /// the discard ran in.
    Unproved,
}

/// Where a stopped discard's file is, by its mark.
enum MarkAt {
    /// Under its private name, or something is, in the directory the mark
    /// recorded, opened and checked.
    There(Directory),
    /// Not there, in the directory the mark recorded.
    Gone,
    /// Unknown, for this reason: the directory at its path is not shown to
    /// be the one the mark recorded.
    Away(String),
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
        aside_seen: aside
            .metadata()
            .ok()
            .map(|found| identity::Seen::of(&found)),
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

    /// [`Folder::unproved_gone`] of the directory at `root`, read from its
    /// store without claiming it.
    pub fn unproved_gone_of(root: impl AsRef<Path>) -> Result<Vec<String>> {
        Folder::reading(root.as_ref())?.unproved_gone()
    }

    /// The files this folder keeps because a program might still write to
    /// them, in path order.
    pub fn kept_files(&self) -> Result<Vec<KeptFile>> {
        let conn = self.core.conn()?;
        #[allow(clippy::type_complexity)]
        let mut moved: std::collections::HashMap<
            String,
            Vec<(String, state::Discarding, Option<String>)>,
        > = std::collections::HashMap::new();
        let mut files = Vec::new();
        for (path, mark) in state::discarding(&conn)? {
            match mark {
                Some(mark) => {
                    let away = match self.mark_at(&mark) {
                        MarkAt::Gone => continue,
                        MarkAt::There(_) => None,
                        MarkAt::Away(why) => Some(why),
                    };
                    moved
                        .entry(mark.id.clone())
                        .or_default()
                        .push((path, mark, away));
                }
                None => {
                    let reason = match self.unread_mark_at(&path) {
                        UnreadMark::Gone => UNREAD_GONE.into(),
                        UnreadMark::Unproved => UNREAD_UNPROVED.into(),
                        UnreadMark::There => format!("{UNREAD}; delete it when it is not needed"),
                    };
                    files.push(KeptFile {
                        path,
                        from: String::new(),
                        writers: "unknown",
                        until: None,
                        reason,
                    });
                }
            }
        }
        let reason = |mark: &state::Discarding, away: &Option<String>| {
            if let Some(why) = away {
                away_reason(why)
            } else {
                left_reason(
                    mark.left
                        .as_deref()
                        .unwrap_or("Marfa stopped as it discarded it"),
                )
            }
        };
        for row in state::displaced(&conn)? {
            match row {
                Ok(row) if row.outside() => {
                    let from = joined(&row.dir, &row.displacement.target);
                    files.push(KeptFile {
                        path: joined(&row.aside, &row.displacement.kept),
                        writers: "unknown",
                        until: None,
                        reason: outside_reason(&from),
                        from,
                    });
                }
                Err(row) if !row.inside => files.push(KeptFile {
                    path: row.path,
                    from: String::new(),
                    writers: "unknown",
                    until: None,
                    reason: unread_displaced_reason(),
                }),
                Ok(_) | Err(_) => {}
            }
        }
        for row in state::retained(&conn)? {
            let (id, mut file) = match &row {
                Ok(row) => (&row.retained.id, retained_file(row)),
                Err(row) => (&row.id, unread_file(row)),
            };
            if let Some(marks) = moved.get_mut(id)
                && !marks.is_empty()
            {
                let (path, mark, away) = marks.remove(0);
                file.path = path;
                if away.is_some() || mark.left.is_some() {
                    file.reason = reason(&mark, &away);
                }
            }
            files.push(file);
        }
        files.extend(
            moved
                .into_values()
                .flatten()
                .map(|(path, mark, away)| KeptFile {
                    path,
                    reason: reason(&mark, &away),
                    from: mark.from,
                    writers: "unknown",
                    until: None,
                }),
        );
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
        done.forgotten = self.forget_discards_gone()?;
        done.kept.extend(self.kept_files()?);
        done.kept.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(done)
    }

    /// The path of each record Marfa keeps and acts on no file for where
    /// nothing is at that path, which Marfa cannot prove means the file is
    /// gone: a record naming a directory outside the folder, or one that does
    /// not read and cannot show it names only the folder's.
    pub fn unproved_gone(&self) -> Result<Vec<String>> {
        let conn = self.core.conn()?;
        Ok(unproved(&conn)?
            .into_iter()
            .filter(|(path, _)| self.nothing_at(path))
            .map(|(path, _)| path)
            .collect())
    }

    /// Forgets each record [`Folder::unproved_gone`] lists at one of `paths`
    /// where nothing is at its path still. Only the owner does this, once
    /// told Marfa cannot prove the file is gone, and it deletes no file.
    /// Answers the paths forgotten.
    pub fn forget_unproved(&self, paths: &[String]) -> Result<Vec<String>> {
        let conn = self.core.conn()?;
        let mut forgotten = Vec::new();
        for (path, record) in unproved(&conn)? {
            if !paths.contains(&path) || !self.nothing_at(&path) {
                continue;
            }
            match record {
                Unproved::Displaced(id) => state::clear_displaced(&conn, &id)?,
                Unproved::Retained(id) => state::clear_retained(&conn, &id)?,
            }
            forgotten.push(path);
        }
        Ok(forgotten)
    }

    /// Whether nothing is at `path`, absolute or relative to the root, nor
    /// at its directory's path.
    fn nothing_at(&self, path: &str) -> bool {
        let path = Path::new(path);
        let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
            return false;
        };
        self.place_dir(&dir.to_string_lossy())
            .and_then(|dir| dir.entry_identity(Path::new(name)))
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    }

    /// Forgets each record of a stopped discard that does not read and whose
    /// file is shown gone from the folder's own directory, which no pass can
    /// settle. Only the owner's discard does this, and it deletes no file.
    fn forget_discards_gone(&self) -> Result<Vec<String>> {
        let conn = self.core.conn()?;
        let mut forgotten = Vec::new();
        for (path, mark) in state::discarding(&conn)? {
            if mark.is_none() && matches!(self.unread_mark_at(&path), UnreadMark::Gone) {
                state::clear_discarding_at(&conn, &path)?;
                forgotten.push(path);
            }
        }
        Ok(forgotten)
    }

    /// Where `mark`'s file is, read through its directory once that is
    /// shown, by its full identity, to be the one the mark recorded.
    fn mark_at(&self, mark: &state::Discarding) -> MarkAt {
        let place = if mark.aside.is_empty() {
            "the folder's directory"
        } else {
            mark.aside.as_str()
        };
        let aside = match self.place_dir(&mark.aside) {
            Ok(aside) => aside,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return MarkAt::Away(format!("the directory {place} is not at its path"));
            }
            Err(error) => {
                return MarkAt::Away(format!(
                    "Marfa cannot look at the directory {place}: {error}"
                ));
            }
        };
        match aside.metadata() {
            Ok(found) => match mark.aside_at.compare(&identity::Seen::of(&found)) {
                identity::Compared::Same => {}
                identity::Compared::Weaker => {
                    return MarkAt::Away(format!(
                        "the file system keeps no birth time for the directory {place}, so Marfa cannot tell it from another put at its name"
                    ));
                }
                identity::Compared::Other => {
                    return MarkAt::Away(format!(
                        "another directory is at the path of the directory {place}, so the file is wherever that directory went"
                    ));
                }
            },
            Err(error) => {
                return MarkAt::Away(format!(
                    "Marfa cannot look at the directory {place}: {error}"
                ));
            }
        }
        match aside.entry_identity(Path::new(&mark.private)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => MarkAt::Gone,
            _ => MarkAt::There(aside),
        }
    }

    /// Where the file of a record of a stopped discard that does not read
    /// is, at `path`, relative to the root. Only the folder's own directory,
    /// which holds the store the record is in, is shown to be the directory
    /// the discard ran in.
    fn unread_mark_at(&self, path: &str) -> UnreadMark {
        let path = Path::new(path);
        let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
            return UnreadMark::There;
        };
        let nothing = self
            .place_dir(&dir.to_string_lossy())
            .and_then(|dir| dir.entry_identity(Path::new(name)))
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
        match (nothing, dir.as_os_str().is_empty()) {
            (false, _) => UnreadMark::There,
            (true, true) => UnreadMark::Gone,
            (true, false) => UnreadMark::Unproved,
        }
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
        self.settle_discarding(&conn)?;
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
    fn settle_discarding(&self, conn: &rusqlite::Connection) -> Result<()> {
        let marks = state::discarding(conn)?;
        if marks.is_empty() {
            return Ok(());
        }
        // A mark is settled only for a record of a file in the folder that
        // names the same directory and name.
        let rows: std::collections::HashMap<String, (String, String)> = state::retained(conn)?
            .into_iter()
            .filter_map(|row| match row {
                Ok(row) if !row.outside() => {
                    Some((row.retained.id, (row.aside, row.retained.kept)))
                }
                Err(row) if !Path::new(&row.aside).is_absolute() => {
                    Some((row.id, (row.aside, row.kept)))
                }
                Ok(_) | Err(_) => None,
            })
            .collect();
        for (path, mark) in marks {
            let Some(mark) = mark else { continue };
            let aside = match self.mark_at(&mark) {
                MarkAt::Gone => {
                    state::clear_discarding_at(conn, &path)?;
                    continue;
                }
                MarkAt::Away(_) => continue,
                MarkAt::There(aside) => aside,
            };
            #[cfg(debug_assertions)]
            crate::fault::hold(|| "folder-discard-mark-checked");
            let private = Path::new(&mark.private);
            if rows.get(&mark.id) != Some(&(mark.aside.clone(), mark.kept.clone())) {
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
        Ok(())
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
        // Outside the folder, nothing shows its directory is the one recorded.
        if Path::new(&row.aside).is_absolute() {
            return Ok(RowSettled::Kept);
        }
        // A directory away, or not shown to be the one recorded, keeps the
        // row: its file is wherever that directory went.
        let Ok(aside) = self.place_dir(&row.aside) else {
            return Ok(RowSettled::Kept);
        };
        let Ok(aside_at) = aside.metadata() else {
            return Ok(RowSettled::Kept);
        };
        let proved = match row.aside_at {
            Some(at) => landing::identity(&aside_at) == at,
            None => row.aside.is_empty(),
        };
        if !proved {
            return Ok(RowSettled::Kept);
        }
        let aside_at = identity::Seen::of(&aside_at);
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
                aside_at,
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
        // Never opened, settled or ended for its age.
        if row.outside() {
            return Ok(None);
        }
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

    /// Stops a discard of the kept file once it is under its private name.
    #[cfg(debug_assertions)]
    fn discard_stopped(folder: Folder, root: &Path) -> Folder {
        {
            let _stop = crate::fault::fail_on_this_thread("crash-after-private-rename");
            let stopped =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| folder.discard_kept()));
            assert!(stopped.is_err(), "it did not stop");
        }
        drop(folder);
        Folder::open(root, None).unwrap()
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_kept_file_a_discard_stopped_on_stays_listed_while_another_directory_has_its_name() {
        for unread in [false, true] {
            let (_dir, folder, root, _) = kept_aside(unread);
            let folder = discard_stopped(folder, &root);
            let elsewhere = tempfile::tempdir_in(root.parent().unwrap()).unwrap();
            std::fs::rename(root.join("Notes"), elsewhere.path().join("Notes")).unwrap();
            std::fs::create_dir(root.join("Notes")).unwrap();
            folder.scan().unwrap();
            folder.discard_kept().unwrap();
            std::fs::remove_dir_all(root.join("Notes")).unwrap();
            std::fs::rename(elsewhere.path().join("Notes"), root.join("Notes")).unwrap();

            let kept = listed(&root, &folder.kept_files().unwrap());

            assert_eq!(kept.len(), 1, "unread {unread}: {kept:?}");
            assert!(kept[0].1, "unread {unread}: {kept:?} names no file");
            assert!(
                std::fs::read_to_string(root.join(&kept[0].0))
                    .unwrap()
                    .contains("as it was"),
                "unread {unread}"
            );
            assert_eq!(reserved_in(&root.join("Notes")).len(), 1, "unread {unread}");
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn two_discards_stopped_on_one_unread_record_list_both_files() {
        let (_dir, folder, root, path) = kept_aside(true);
        let folder = discard_stopped(folder, &root);
        let private = reserved_in(&root.join("Notes"));
        assert_eq!(private.len(), 1);
        std::fs::copy(root.join("Notes").join(&private[0]), root.join(&path)).unwrap();
        let folder = discard_stopped(folder, &root);
        assert_eq!(
            reserved_in(&root.join("Notes")).len(),
            2,
            "the second discard did not leave a second file, so nothing below is about it"
        );

        let kept = listed(&root, &Folder::kept_of(&root).unwrap());

        assert_eq!(kept.len(), 2, "{kept:?}");
        assert!(kept.iter().all(|(_, there)| *there), "{kept:?}");
        drop(folder);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn an_unreadable_discard_record_outside_the_folders_own_directory_is_never_forgotten() {
        let (_dir, folder, root, _) = kept_aside(false);
        let folder = discard_stopped(folder, &root);
        let private = reserved_in(&root.join("Notes"));
        assert_eq!(private.len(), 1);
        folder
            .core
            .conn()
            .unwrap()
            .execute(
                "UPDATE meta SET value = 'unreadable' WHERE key LIKE 'folder_discarding:%'",
                [],
            )
            .unwrap();
        // The witness: while its file is there, it is listed.
        assert!(
            listed(&root, &folder.kept_files().unwrap())
                .iter()
                .any(|(_, there)| *there)
        );
        std::fs::remove_file(root.join("Notes").join(&private[0])).unwrap();
        folder.scan().unwrap();

        let done = folder.discard_kept().unwrap();

        // Nothing shows the directory at its path is the one the discard ran in.
        assert!(done.forgotten.is_empty(), "{done:?}");
        let kept = folder.kept_files().unwrap();
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(kept[0].reason, super::UNREAD_UNPROVED);
    }

    /// Spoils every record of a stopped discard.
    #[cfg(debug_assertions)]
    fn spoiled_discard_records(folder: &Folder) {
        folder
            .core
            .conn()
            .unwrap()
            .execute(
                "UPDATE meta SET value = 'unreadable' WHERE key LIKE 'folder_discarding:%'",
                [],
            )
            .unwrap();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_record_of_a_stopped_discard_is_never_forgotten_while_its_directory_is_away() {
        for unread in [false, true] {
            let (_dir, folder, root, _) = kept_aside(false);
            let folder = discard_stopped(folder, &root);
            if unread {
                spoiled_discard_records(&folder);
            }
            let elsewhere = tempfile::tempdir_in(root.parent().unwrap()).unwrap();
            std::fs::rename(root.join("Notes"), elsewhere.path().join("Notes")).unwrap();

            let done = folder.discard_kept().unwrap();

            assert!(
                done.forgotten.is_empty(),
                "unread {unread}: a record was forgotten while its directory was away: {done:?}"
            );
            std::fs::rename(elsewhere.path().join("Notes"), root.join("Notes")).unwrap();
            let kept = listed(&root, &folder.kept_files().unwrap());
            assert!(
                kept.iter().any(|(_, there)| *there),
                "unread {unread}: the file the discard left is not listed: {kept:?}"
            );
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_stopped_discard_is_settled_in_the_directory_it_checked() {
        let (_dir, folder, root, _) = kept_aside(false);
        let folder = discard_stopped(folder, &root);
        let private = reserved_in(&root.join("Notes"));
        assert_eq!(private.len(), 1);
        let elsewhere = tempfile::tempdir_in(root.parent().unwrap()).unwrap();
        let copy = elsewhere.path().join("copy");
        std::fs::create_dir(&copy).unwrap();
        std::fs::copy(root.join("Notes").join(&private[0]), copy.join(&private[0])).unwrap();
        let swap = super::super::unmatched::tests::meanwhile_at("folder-discard-mark-checked", {
            let (root, elsewhere, copy) =
                (root.clone(), elsewhere.path().to_path_buf(), copy.clone());
            move || {
                std::fs::rename(root.join("Notes"), elsewhere.join("Notes")).unwrap();
                std::fs::rename(&copy, root.join("Notes")).unwrap();
            }
        });

        folder.scan().unwrap();

        assert!(
            swap.join().unwrap(),
            "the discard's record was never settled, so nothing below is about it"
        );
        assert_eq!(
            reserved_in(&root.join("Notes")),
            private,
            "the directory put at its name after the check was changed"
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_stopped_discard_never_settles_on_a_directory_short_of_its_full_identity() {
        for spoil in ["no birth time", "another device"] {
            let (_dir, folder, root, _) = kept_aside(false);
            let folder = discard_stopped(folder, &root);
            {
                let conn = folder.core.conn().unwrap();
                let (_, mark) = state::discarding(&conn).unwrap().pop().unwrap();
                let mut mark = mark.unwrap();
                if spoil == "no birth time" {
                    mark.aside_at.born = None;
                } else {
                    mark.aside_at.device ^= 1;
                }
                state::set_discarding(&conn, &mark).unwrap();
            }
            let private = reserved_in(&root.join("Notes"));
            assert_eq!(private.len(), 1);
            std::fs::remove_file(root.join("Notes").join(&private[0])).unwrap();

            folder.scan().unwrap();

            assert_eq!(
                state::discarding(&folder.core.conn().unwrap())
                    .unwrap()
                    .len(),
                1,
                "{spoil}: the record was cleared on less than its directory's full identity"
            );
            assert!(!folder.kept_files().unwrap().is_empty(), "{spoil}");
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_kept_file_whose_record_does_not_read_stays_where_its_directory_cannot_be_told() {
        use std::os::unix::fs::MetadataExt;
        for case in [
            "with no identity for its directory",
            "in another folder's directory",
            "in another folder's directory with no identity for it",
        ] {
            let (_dir, folder, root, path) = kept_aside(true);
            let name = Path::new(&path).file_name().unwrap().to_owned();
            let conn = folder.core.conn().unwrap();
            let elsewhere = tempfile::tempdir_in(root.parent().unwrap()).unwrap();
            let elsewhere = elsewhere.path().canonicalize().unwrap();
            let kept = if case == "with no identity for its directory" {
                root.join(&path)
            } else {
                std::fs::rename(root.join(&path), elsewhere.join(&name)).unwrap();
                let at = std::fs::metadata(&elsewhere).unwrap();
                conn.execute(
                    "UPDATE meta SET value = json_set(value, '$.dir', ?1, '$.aside', ?1, '$.aside_at', json(?2)) WHERE key LIKE 'folder_retained:%'",
                    rusqlite::params![
                        elsewhere.to_string_lossy(),
                        format!("[{},{}]", at.dev(), at.ino())
                    ],
                )
                .unwrap();
                elsewhere.join(&name)
            };
            if case.ends_with("no identity for it") || case.ends_with("its directory") {
                conn.execute(
                    "UPDATE meta SET value = json_remove(value, '$.aside_at') WHERE key LIKE 'folder_retained:%'",
                    [],
                )
                .unwrap();
            }
            drop(conn);

            let done = folder.discard_kept().unwrap();

            assert!(kept.exists(), "{case}: the owner's discard deleted it");
            assert!(done.discarded.is_empty(), "{case}: {done:?}");
            assert_eq!(
                listed(&root, &folder.kept_files().unwrap())
                    .into_iter()
                    .map(|(path, _)| path)
                    .collect::<Vec<_>>(),
                [if kept.starts_with(&root) {
                    path.clone()
                } else {
                    kept.to_string_lossy().into_owned()
                }],
                "{case}"
            );
        }
    }
}

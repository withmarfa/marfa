//! The record of a self-update across the restarts that try the new release, which the server
//! and `marfa server run` both keep, and the moves of the programs it describes.
//!
//! The swap replaces only `marfa-server` and stages the new `marfa` as `.marfa.next`, so the
//! `marfa server run` of the running release supervises the new server's first starts.

use std::fs::{self, File};
use std::io::{self, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const SERVER: &str = "marfa-server";
pub const MARFA: &str = "marfa";

/// Held while a server unpacks and swaps a release into the folder.
pub const LOCK: &str = ".marfa-update.lock";

/// Starts of a new release that ended unasked; the next start puts the old release back.
pub const UNFINISHED_STARTS: u32 = 2;

const PENDING: &str = "pending.json";
const LAST: &str = "last.json";
const SUPERVISOR: &str = "supervisor.lock";

pub fn previous_of(programs: &Path, name: &str) -> PathBuf {
    programs.join(format!(".{name}.previous"))
}

/// The new release's `marfa`, which waits until the new server has settled.
pub fn next_marfa(programs: &Path) -> PathBuf {
    programs.join(".marfa.next")
}

/// A swap that has not settled. `starts` counts starts of the new release that have not ended
/// in a stop someone asked for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pending {
    pub from: String,
    pub to: String,
    pub schema: Option<u32>,
    pub starts: u32,
    pub programs: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Succeeded,
    Failed,
    RolledBack,
}

impl Outcome {
    pub fn word(self) -> &'static str {
        match self {
            Outcome::Succeeded => "succeeded",
            Outcome::Failed => "failed",
            Outcome::RolledBack => "rolled_back",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Last {
    pub outcome: String,
    pub release: String,
    pub finished_at: String,
    pub reason: Option<String>,
}

/// The `update` folder beside the database.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Folder(PathBuf);

impl Folder {
    pub fn beside(database: &Path) -> Folder {
        let data = database
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        Folder(data.join("update"))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    fn write(&self, name: &str, text: &str) -> io::Result<()> {
        fs::create_dir_all(&self.0)?;
        let temporary = self.0.join(format!("{name}.partial"));
        let mut file = File::create(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, self.0.join(name))?;
        sync_folder(&self.0)
    }

    fn read<T: for<'a> Deserialize<'a>>(&self, name: &str) -> io::Result<Option<T>> {
        let path = self.0.join(name);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        serde_json::from_slice(&bytes).map(Some).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{} does not read: {error}", path.display()),
            )
        })
    }

    pub fn pending(&self) -> io::Result<Option<Pending>> {
        self.read(PENDING)
    }

    pub fn keep_pending(&self, pending: &Pending) -> io::Result<()> {
        let text = serde_json::to_string(pending).map_err(io::Error::other)?;
        self.write(PENDING, &text)
    }

    pub fn clear_pending(&self) -> io::Result<()> {
        match fs::remove_file(self.0.join(PENDING)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => sync_folder(&self.0).or(Ok(())),
        }
    }

    pub fn last(&self) -> io::Result<Option<Last>> {
        self.read(LAST)
    }

    /// `at` is the time the update ended, as `time::written` gives it.
    pub fn end(
        &self,
        at: &str,
        outcome: Outcome,
        release: &str,
        reason: Option<String>,
    ) -> io::Result<()> {
        let last = Last {
            outcome: outcome.word().to_string(),
            release: release.to_string(),
            finished_at: at.to_string(),
            reason,
        };
        let text = serde_json::to_string(&last).map_err(io::Error::other)?;
        self.write(LAST, &text)
    }

    /// The file a `marfa server run` locks while it supervises a try of the new release.
    pub fn supervisor_lock(&self) -> io::Result<File> {
        fs::create_dir_all(&self.0)?;
        File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.0.join(SUPERVISOR))
    }
}

pub fn sync_folder(folder: &Path) -> io::Result<()> {
    File::open(folder)?.sync_all()
}

/// Some file systems and Linux's `protected_hardlinks` refuse the link, so a copy stands in.
pub fn keep_aside(
    live: &Path,
    kept: &Path,
    link: impl Fn(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    match fs::remove_file(kept) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    if link(live, kept).is_ok() {
        return Ok(());
    }
    fs::copy(live, kept)?;
    fs::set_permissions(kept, fs::Permissions::from_mode(0o755))
}

/// Puts `.marfa.next` in place as `marfa`, keeping the old `marfa` beside it.
/// Nothing to do when it is already in place.
pub fn finish_swap(programs: &Path) -> io::Result<()> {
    let next = next_marfa(programs);
    if !next.exists() {
        return Ok(());
    }
    let live = programs.join(MARFA);
    keep_aside(&live, &previous_of(programs, MARFA), |from, to| {
        fs::hard_link(from, to)
    })?;
    fs::rename(&next, &live)?;
    sync_folder(programs)
}

/// Puts the old `marfa-server` back, and the old `marfa` too where `marfa` was replaced, and
/// drops a `.marfa.next` that waited.
pub fn put_back(programs: &Path, marfa_replaced: bool) -> io::Result<()> {
    let names: &[&str] = if marfa_replaced {
        &[SERVER, MARFA]
    } else {
        &[SERVER]
    };
    if let Some(missing) = names
        .iter()
        .map(|name| previous_of(programs, name))
        .find(|kept| !kept.is_file())
    {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{} is missing", missing.display()),
        ));
    }
    for name in names {
        fs::rename(previous_of(programs, name), programs.join(name))?;
    }
    match fs::remove_file(next_marfa(programs)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    sync_folder(programs)
}

/// Drops a `.marfa.next` left by an update that ended without it.
pub fn drop_next(programs: &Path) -> io::Result<()> {
    match fs::remove_file(next_marfa(programs)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: &str = "2030-01-02T03:04:05.678Z";

    fn scratch(name: &str) -> (PathBuf, Folder) {
        let dir = std::env::temp_dir().join(format!("marfa-record-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("bin")).unwrap();
        let folder = Folder::beside(&dir.join("data/marfa.db"));
        (dir, folder)
    }

    fn pending(bin: &Path) -> Pending {
        Pending {
            from: "0.0.74".into(),
            to: "0.0.75".into(),
            schema: Some(1),
            starts: 0,
            programs: bin.to_path_buf(),
        }
    }

    #[test]
    fn the_record_reads_what_was_kept_and_a_missing_one_reads_as_none() {
        let (dir, record) = scratch("kept");
        assert_eq!(record.path(), dir.join("data/update"));
        assert_eq!(record.pending().unwrap(), None);
        assert_eq!(record.last().unwrap(), None);
        let kept = pending(&dir.join("bin"));
        record.keep_pending(&kept).unwrap();
        assert_eq!(record.pending().unwrap(), Some(kept));
        record.clear_pending().unwrap();
        record.clear_pending().unwrap();
        assert_eq!(record.pending().unwrap(), None);
        record
            .end(AT, Outcome::RolledBack, "0.0.75", Some("why".into()))
            .unwrap();
        let last = record.last().unwrap().unwrap();
        assert_eq!(
            (
                last.outcome.as_str(),
                last.release.as_str(),
                last.finished_at.as_str()
            ),
            ("rolled_back", "0.0.75", AT)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_record_that_does_not_read_is_an_error_and_not_nothing() {
        let (dir, record) = scratch("unreadable");
        fs::create_dir_all(record.path()).unwrap();
        fs::write(record.path().join(PENDING), "{\"from\":").unwrap();
        let error = record.pending().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("pending.json"), "{error}");
        let _ = fs::remove_dir_all(&dir);
    }

    fn programs(dir: &Path) -> PathBuf {
        let bin = dir.join("bin");
        for (name, text) in [
            (SERVER, "new server"),
            (MARFA, "old marfa"),
            (".marfa-server.previous", "old server"),
            (".marfa.next", "new marfa"),
        ] {
            fs::write(bin.join(name), text).unwrap();
        }
        bin
    }

    fn text(path: PathBuf) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn finishing_the_swap_puts_the_new_marfa_in_place_and_keeps_the_old_one() {
        let (dir, _) = scratch("finish");
        let bin = programs(&dir);
        fs::write(previous_of(&bin, MARFA), "a copy from an earlier update").unwrap();
        finish_swap(&bin).unwrap();
        assert_eq!(text(bin.join(MARFA)), "new marfa");
        assert_eq!(text(previous_of(&bin, MARFA)), "old marfa");
        assert!(!next_marfa(&bin).exists());
        finish_swap(&bin).unwrap();
        assert_eq!(
            text(previous_of(&bin, MARFA)),
            "old marfa",
            "a second finish changes nothing"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn putting_back_restores_the_server_and_drops_the_waiting_marfa() {
        let (dir, _) = scratch("back");
        let bin = programs(&dir);
        fs::write(previous_of(&bin, MARFA), "a copy from an earlier update").unwrap();
        put_back(&bin, false).unwrap();
        assert_eq!(text(bin.join(SERVER)), "old server");
        assert_eq!(
            text(bin.join(MARFA)),
            "old marfa",
            "a marfa that was never replaced is left alone"
        );
        assert!(!next_marfa(&bin).exists());
        assert!(!previous_of(&bin, SERVER).exists());

        let bin = programs(&dir);
        finish_swap(&bin).unwrap();
        put_back(&bin, true).unwrap();
        assert_eq!(text(bin.join(SERVER)), "old server");
        assert_eq!(text(bin.join(MARFA)), "old marfa");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn putting_back_with_no_old_server_kept_says_so() {
        let (dir, _) = scratch("nothing-kept");
        let bin = programs(&dir);
        fs::remove_file(previous_of(&bin, SERVER)).unwrap();
        let error = put_back(&bin, false).unwrap_err();
        assert!(
            error.to_string().contains(".marfa-server.previous"),
            "{error}"
        );
        assert_eq!(text(bin.join(SERVER)), "new server");
        let _ = fs::remove_dir_all(&dir);
    }
}

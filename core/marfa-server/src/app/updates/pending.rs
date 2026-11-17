//! The record of a swap across the restart, and the outcome the owner reads.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::settings::DatabasePath;

/// The programs an update replaces, in the order it replaces them.
pub const PROGRAMS: [&str; 2] = ["marfa-server", "marfa"];

const PENDING: &str = "pending.json";
const LAST: &str = "last.json";

/// A swap that the new release has not yet settled.
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

pub fn previous_of(programs: &Path, name: &str) -> PathBuf {
    programs.join(format!(".{name}.previous"))
}

#[derive(Clone, Debug)]
pub struct Folder(PathBuf);

impl Folder {
    pub fn of(database: &DatabasePath) -> Option<Folder> {
        database
            .file()
            .map(|_| Folder(database.folder().join("update")))
    }

    fn write(&self, name: &str, text: &str) -> std::io::Result<()> {
        fs::create_dir_all(&self.0)?;
        let temporary = self.0.join(format!("{name}.partial"));
        let mut file = File::create(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, self.0.join(name))?;
        File::open(&self.0)?.sync_all()
    }

    fn read<T: for<'a> Deserialize<'a>>(&self, name: &str) -> Option<T> {
        serde_json::from_slice(&fs::read(self.0.join(name)).ok()?).ok()
    }

    pub fn pending(&self) -> Option<Pending> {
        self.read(PENDING)
    }

    pub fn keep_pending(&self, pending: &Pending) -> std::io::Result<()> {
        let text = serde_json::to_string(pending).map_err(std::io::Error::other)?;
        self.write(PENDING, &text)
    }

    pub fn clear_pending(&self) {
        let _ = fs::remove_file(self.0.join(PENDING));
    }

    pub fn last(&self) -> Option<Last> {
        self.read(LAST)
    }

    /// `at` is the time as the server's clock writes it.
    pub fn end(&self, at: &str, outcome: Outcome, version: &str, reason: Option<String>) {
        let last = Last {
            outcome: outcome.word().to_string(),
            release: version.to_string(),
            finished_at: at.to_string(),
            reason,
        };
        let kept = serde_json::to_string(&last)
            .map_err(std::io::Error::other)
            .and_then(|text| self.write(LAST, &text));
        if let Err(error) = kept {
            tracing::warn!("The outcome of an update could not be kept: {error}");
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Start {
    Proceed,
    Restart,
}

pub fn put_back(programs: &Path) -> std::io::Result<()> {
    for name in PROGRAMS.iter().rev() {
        let kept = previous_of(programs, name);
        if kept.exists() {
            fs::rename(&kept, programs.join(name))?;
        }
    }
    File::open(programs)?.sync_all()
}

/// Counts the starts of an unsettled release; the second puts the old one back.
pub fn on_start(
    record: &Folder,
    running: &str,
    at: &str,
    schema_now: &dyn Fn() -> Option<u32>,
) -> Start {
    let Some(mut pending) = record.pending() else {
        return Start::Proceed;
    };
    if pending.to != running {
        record.clear_pending();
        if pending.from == running {
            record.end(
                at,
                Outcome::RolledBack,
                &pending.to,
                Some(format!("The service started release {running} again.")),
            );
        }
        return Start::Proceed;
    }
    if pending.starts == 0 {
        pending.starts = 1;
        if let Err(error) = record.keep_pending(&pending) {
            tracing::warn!("The update's record could not be kept: {error}");
        }
        return Start::Proceed;
    }
    record.clear_pending();
    if pending.schema != schema_now() {
        record.end(
            at,            Outcome::Failed,
            &pending.to,
            Some(format!(
                "Release {} did not stay up, and it had changed the database, so release {} cannot be put back. The copy kept before the change is beside the database.",
                pending.to, pending.from
            )),
        );
        return Start::Proceed;
    }
    match put_back(&pending.programs) {
        Ok(()) => {
            record.end(
                at,
                Outcome::RolledBack,
                &pending.to,
                Some(format!(
                    "Release {} did not stay up, so release {} was put back.",
                    pending.to, pending.from
                )),
            );
            Start::Restart
        }
        Err(error) => {
            record.end(
                at,
                Outcome::Failed,
                &pending.to,
                Some(format!(
                    "Release {} did not stay up, and release {} could not be put back: {error}.",
                    pending.to, pending.from
                )),
            );
            Start::Proceed
        }
    }
}

pub fn settle(record: &Folder, running: &str, at: &str) {
    if record
        .pending()
        .is_some_and(|pending| pending.to == running)
    {
        record.clear_pending();
        record.end(at, Outcome::Succeeded, running, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: &str = "2030-01-02T03:04:05.678Z";

    fn scratch(name: &str) -> (PathBuf, Folder) {
        let dir = std::env::temp_dir().join(format!("marfa-pending-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("bin")).unwrap();
        let folder = Folder::of(&DatabasePath::File(dir.join("data/marfa.db"))).unwrap();
        (dir, folder)
    }

    fn swapped(dir: &Path, schema: Option<u32>) -> Pending {
        let bin = dir.join("bin");
        for name in PROGRAMS {
            fs::write(bin.join(name), "new").unwrap();
            fs::write(previous_of(&bin, name), "old").unwrap();
        }
        Pending {
            from: "0.0.74".into(),
            to: "0.0.75".into(),
            schema,
            starts: 0,
            programs: bin,
        }
    }

    #[test]
    fn a_release_that_stays_up_settles_the_swap_and_the_owner_reads_it() {
        let (dir, record) = scratch("settles");
        record.keep_pending(&swapped(&dir, Some(1))).unwrap();
        assert_eq!(on_start(&record, "0.0.75", AT, &|| Some(1)), Start::Proceed);
        assert_eq!(record.pending().unwrap().starts, 1);
        settle(&record, "0.0.75", AT);
        assert!(record.pending().is_none());
        let last = record.last().unwrap();
        assert_eq!(
            (last.outcome.as_str(), last.release.as_str()),
            ("succeeded", "0.0.75")
        );
        assert_eq!(last.finished_at, AT);
        assert_eq!(fs::read_to_string(dir.join("bin/marfa")).unwrap(), "new");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_release_that_did_not_stay_up_is_put_back_while_the_database_is_as_it_was() {
        let (dir, record) = scratch("back");
        record.keep_pending(&swapped(&dir, Some(1))).unwrap();
        assert_eq!(on_start(&record, "0.0.75", AT, &|| Some(1)), Start::Proceed);
        assert_eq!(on_start(&record, "0.0.75", AT, &|| Some(1)), Start::Restart);
        for name in PROGRAMS {
            assert_eq!(
                fs::read_to_string(dir.join("bin").join(name)).unwrap(),
                "old"
            );
            assert!(!previous_of(&dir.join("bin"), name).exists());
        }
        assert!(record.pending().is_none());
        assert_eq!(record.last().unwrap().outcome, "rolled_back");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_release_that_changed_the_database_is_not_put_back_and_the_owner_is_told() {
        let (dir, record) = scratch("moved");
        record.keep_pending(&swapped(&dir, Some(1))).unwrap();
        assert_eq!(on_start(&record, "0.0.75", AT, &|| Some(1)), Start::Proceed);
        assert_eq!(on_start(&record, "0.0.75", AT, &|| Some(2)), Start::Proceed);
        assert_eq!(fs::read_to_string(dir.join("bin/marfa")).unwrap(), "new");
        let last = record.last().unwrap();
        assert_eq!(last.outcome, "failed");
        assert!(last.reason.unwrap().contains("cannot be put back"));
        assert!(record.pending().is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_old_release_starting_again_ends_the_record_as_a_rollback() {
        let (dir, record) = scratch("old");
        record.keep_pending(&swapped(&dir, Some(1))).unwrap();
        assert_eq!(on_start(&record, "0.0.74", AT, &|| Some(1)), Start::Proceed);
        assert!(record.pending().is_none());
        assert_eq!(record.last().unwrap().outcome, "rolled_back");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_pending_changes_nothing_and_a_settle_of_another_release_leaves_the_record() {
        let (dir, record) = scratch("none");
        assert_eq!(on_start(&record, "0.0.75", AT, &|| None), Start::Proceed);
        assert!(record.last().is_none());
        record.keep_pending(&swapped(&dir, None)).unwrap();
        settle(&record, "0.0.99", AT);
        assert!(record.pending().is_some());
        let _ = fs::remove_dir_all(&dir);
    }
}

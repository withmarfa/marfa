//! The record of a swap as the server reads and settles it. `marfa server run` counts the new
//! release's starts and puts the old one back when it does not stay up.

use std::fs;
use std::path::Path;

pub use marfa_rules::update_record::{
    ASK_LIMIT, Folder, LOCK, MARFA, Outcome, Pending, SERVER, cannot_put_back, finish_swap,
    keep_aside, keep_served_release, next_marfa, previous_of, put_back, run_within, sync_folder,
};

use crate::settings::DatabasePath;

/// The programs a release carries.
pub const PROGRAMS: [&str; 2] = [SERVER, MARFA];

pub fn record_of(database: &DatabasePath) -> Option<Folder> {
    database.file().map(|file| Folder::beside(&file))
}

/// Keeps how an update ended; a record that cannot be written is logged, since the update has
/// already ended either way.
pub fn end(
    record: &Folder,
    at: &str,
    outcome: Outcome,
    release: &str,
    reason: Option<String>,
    attempt: Option<&str>,
) {
    if let Err(error) = record.end(at, outcome, release, reason, attempt) {
        tracing::warn!("The outcome of an update could not be kept: {error}");
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Settled {
    /// No update of this release waits to settle.
    Nothing,
    Succeeded,
    /// The old programs are back, and the server ends so that they start.
    PutBack,
    Failed,
}

/// Settles the update to `running` once it has stayed up: puts the new `marfa` in place, then
/// ends the update as `succeeded` only when both programs report the release. `reports` gives
/// what a program prints for `--version`, or `None` when it does not run, and `cannot_put_back`
/// why the old release cannot run again.
pub fn settle(
    record: &Folder,
    database: Option<&Path>,
    running: &str,
    at: &str,
    cannot_put_back: &dyn Fn(&Pending) -> Option<String>,
    reports: &dyn Fn(&Path) -> Option<String>,
) -> Settled {
    let read = record
        .pending()
        .and_then(|pending| Ok((pending, record.last()?)));
    let (pending, last) = match read {
        Ok((Some(pending), last)) if pending.to == running => (pending, last),
        Ok(_) => return Settled::Nothing,
        Err(error) => {
            tracing::warn!("The update's record could not be read: {error}");
            return Settled::Nothing;
        }
    };
    let (from, to, programs) = (&pending.from, &pending.to, &pending.programs);
    let attempt = pending.attempt.as_deref();
    let waiting = next_marfa(programs).exists();
    let finished = finish_swap(programs);
    // Known before asking: a moved-in `marfa` that does not run is still the one to take out.
    let marfa_moved = waiting && !next_marfa(programs).exists();
    let said = PROGRAMS.map(|name| (name, reports(&programs.join(name))));
    let whole = said
        .iter()
        .all(|(name, said)| said.as_deref() == Some(format!("{name} {to}").as_str()));
    if finished.is_ok() && whole {
        if let Err(error) = record.clear_pending() {
            tracing::warn!("The settled update's record could not be cleared: {error}");
            return Settled::Nothing;
        }
        end(record, at, Outcome::Succeeded, to, None, attempt);
        return Settled::Succeeded;
    }
    let problem = match finished {
        Err(error) => format!("the new marfa could not be put in place: {error}"),
        Ok(()) => said
            .iter()
            .map(|(name, said)| match said {
                Some(said) => format!("{name} reports '{said}'"),
                None => format!("{name} does not run"),
            })
            .collect::<Vec<_>>()
            .join(" and "),
    };
    let marfa_reports_new = said[1].1.as_deref() == Some(format!("{MARFA} {to}").as_str());
    // With the record kept, the old `marfa` goes on starting the new server.
    let keep_old_marfa = || match marfa_moved && !marfa_reports_new {
        true => match fs::rename(previous_of(programs, MARFA), programs.join(MARFA))
            .and_then(|()| sync_folder(programs))
        {
            Ok(()) => format!(" Release {from}'s marfa was put back to keep starting it."),
            Err(error) => format!(" Release {from}'s marfa could not be put back: {error}."),
        },
        false => String::new(),
    };
    if last.is_some_and(|last| last.ends(&pending)) {
        // The update ended with the old release unable to come back, so only the swap is retried.
        let kept_marfa = keep_old_marfa();
        tracing::warn!(
            "Release {to}'s programs are still not all in place ({problem}).{kept_marfa}"
        );
        return Settled::Nothing;
    }
    let reinstall = format!(
        "Install release {to} on this host, then run `marfa server upgrade` for this server."
    );
    if let Some(cannot) = cannot_put_back(&pending) {
        let kept_marfa = keep_old_marfa();
        end(
            record,
            at,
            Outcome::Failed,
            to,
            Some(format!(
                "Release {to} runs, but its programs are not all in place ({problem}), and release {from} cannot be put back: {cannot}.{kept_marfa} {reinstall}"
            )),
            attempt,
        );
        return Settled::Failed;
    }
    let marfa_replaced = marfa_moved || marfa_reports_new;
    match put_back(programs, marfa_replaced) {
        Ok(()) => {
            if let Err(error) = record.clear_pending() {
                tracing::warn!("The update's record could not be cleared: {error}");
            }
            // Release `from` said it opens the database, and may keep no record of its own.
            if let Some(Err(error)) = database.map(|file| keep_served_release(file, from)) {
                tracing::warn!(
                    "The release put back could not be named beside the database: {error}"
                );
            }
            end(
                record,
                at,
                Outcome::RolledBack,
                to,
                Some(format!(
                    "Release {to}'s programs were not all in place ({problem}), so release {from} was put back."
                )),
                attempt,
            );
            Settled::PutBack
        }
        Err(error) => {
            end(
                record,
                at,
                Outcome::Failed,
                to,
                Some(format!(
                    "Release {to}'s programs were not all in place ({problem}), and release {from} could not be put back: {error}. {reinstall}"
                )),
                attempt,
            );
            Settled::Failed
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use marfa_rules::update_record::served_release;

    use super::*;

    const AT: &str = "2030-01-02T03:04:05.678Z";

    struct Case {
        dir: PathBuf,
        record: Folder,
    }

    impl Case {
        /// A swap of 0.0.74 to 0.0.75 that put in only the new server, with the new `marfa`
        /// waiting; each file holds the words its `--version` prints.
        fn new(name: &str) -> Case {
            let dir =
                std::env::temp_dir().join(format!("marfa-settle-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            let bin = dir.join("bin");
            fs::create_dir_all(&bin).unwrap();
            for (file, text) in [
                (SERVER, "marfa-server 0.0.75"),
                (".marfa-server.previous", "marfa-server 0.0.74"),
                (MARFA, "marfa 0.0.74"),
                (".marfa.next", "marfa 0.0.75"),
            ] {
                fs::write(bin.join(file), text).unwrap();
            }
            let record = Folder::beside(&dir.join("data/marfa.db"));
            record
                .keep_pending(&Pending {
                    from: "0.0.74".into(),
                    to: "0.0.75".into(),
                    schema: Some(1),
                    starts: 1,
                    programs: bin,
                    attempt: Some("attempt".into()),
                    limit_ended: None,
                })
                .unwrap();
            Case { dir, record }
        }

        fn bin(&self) -> PathBuf {
            self.dir.join("bin")
        }

        fn database(&self) -> PathBuf {
            self.dir.join("data/marfa.db")
        }

        fn text(&self, name: &str) -> String {
            fs::read_to_string(self.bin().join(name)).unwrap()
        }

        /// Settles with the old server opening the database at `schema`.
        fn settle(&self, schema: Option<u32>) -> Settled {
            self.settle_asking(&|pending| {
                (schema != pending.schema)
                    .then(|| "release 0.0.75 has changed the database's schema".into())
            })
        }

        fn settle_asking(&self, cannot: &dyn Fn(&Pending) -> Option<String>) -> Settled {
            // An empty file stands for a program that does not run.
            let database = self.database();
            settle(
                &self.record,
                Some(&database),
                "0.0.75",
                AT,
                cannot,
                &|program| {
                    fs::read_to_string(program)
                        .ok()
                        .filter(|said| !said.is_empty())
                },
            )
        }

        fn last(&self) -> (String, String) {
            let last = self.record.last().unwrap().unwrap();
            (last.outcome, last.reason.unwrap_or_default())
        }
    }

    impl Drop for Case {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn a_release_that_stayed_up_puts_its_marfa_in_place_and_settles_once_both_report_it() {
        let case = Case::new("settles");
        assert_eq!(case.settle(Some(1)), Settled::Succeeded);
        assert_eq!(case.text(MARFA), "marfa 0.0.75");
        assert_eq!(case.text(".marfa.previous"), "marfa 0.0.74");
        assert!(!next_marfa(&case.bin()).exists());
        assert_eq!(case.record.pending().unwrap(), None);
        assert_eq!(case.last(), ("succeeded".into(), String::new()));
        assert_eq!(case.settle(Some(1)), Settled::Nothing, "nothing is left");
    }

    #[test]
    fn a_swap_that_lost_the_new_marfa_is_reported_and_put_back_and_never_called_succeeded() {
        let case = Case::new("half");
        fs::remove_file(next_marfa(&case.bin())).unwrap();
        // The new release served on the database before it was found not whole.
        fs::create_dir_all(case.dir.join("data")).unwrap();
        keep_served_release(&case.database(), "0.0.75").unwrap();
        assert_eq!(case.settle(Some(1)), Settled::PutBack);
        assert_eq!(case.text(SERVER), "marfa-server 0.0.74");
        assert_eq!(case.text(MARFA), "marfa 0.0.74");
        assert_eq!(case.record.pending().unwrap(), None);
        // Release 0.0.74 may keep no record of its own, so the one it is put back on names it.
        assert_eq!(
            served_release(&case.database()).unwrap().as_deref(),
            Some("0.0.74")
        );
        let (outcome, reason) = case.last();
        assert_eq!(outcome, "rolled_back");
        assert!(
            reason.contains("marfa reports 'marfa 0.0.74'")
                && reason.contains("0.0.74 was put back"),
            "{reason}"
        );
    }

    #[test]
    fn a_new_marfa_that_does_not_run_in_place_is_put_back_with_the_server() {
        for (name, said) in [("wrong", "marfa 0.0.99"), ("fails", "")] {
            let case = Case::new(name);
            fs::write(next_marfa(&case.bin()), said).unwrap();
            assert_eq!(case.settle(Some(1)), Settled::PutBack, "{name}");
            assert_eq!(case.text(SERVER), "marfa-server 0.0.74", "{name}");
            assert_eq!(case.text(MARFA), "marfa 0.0.74", "{name}");
            assert!(!next_marfa(&case.bin()).exists(), "{name}");
            assert_eq!(case.last().0, "rolled_back", "{name}");
        }
    }

    #[test]
    fn a_new_marfa_that_does_not_run_after_the_database_changed_gives_way_to_the_old_one() {
        let case = Case::new("broken-moved");
        fs::write(next_marfa(&case.bin()), "").unwrap();
        assert_eq!(case.settle(Some(2)), Settled::Failed);
        assert_eq!(
            case.text(SERVER),
            "marfa-server 0.0.75",
            "the new server stays"
        );
        assert_eq!(case.text(MARFA), "marfa 0.0.74", "the old marfa starts it");
        assert!(case.record.pending().unwrap().is_some());
        let (outcome, reason) = case.last();
        assert_eq!(outcome, "failed");
        assert!(reason.contains("0.0.74's marfa was put back"), "{reason}");
    }

    #[test]
    fn a_half_swap_after_the_database_changed_says_how_to_finish_and_keeps_the_record() {
        let case = Case::new("half-moved");
        fs::remove_file(next_marfa(&case.bin())).unwrap();
        assert_eq!(case.settle(Some(2)), Settled::Failed);
        assert_eq!(
            case.text(SERVER),
            "marfa-server 0.0.75",
            "the running release stays"
        );
        let (outcome, reason) = case.last();
        assert_eq!(outcome, "failed");
        assert!(
            reason.contains("cannot be put back") && reason.contains("Install release 0.0.75"),
            "{reason}"
        );
        assert!(
            case.record.pending().unwrap().is_some(),
            "the record stays, so marfa server run still starts this release"
        );
    }

    #[test]
    fn an_update_that_ended_only_finishes_its_swap_and_never_puts_the_old_release_back() {
        let case = Case::new("ended");
        let failed = "release 0.0.74 could not be put back, and 0.0.75's marfa could not be either";
        case.record
            .end(
                AT,
                Outcome::Failed,
                "0.0.75",
                Some(failed.into()),
                Some("attempt"),
            )
            .unwrap();
        let next = next_marfa(&case.bin());
        fs::remove_file(&next).unwrap();
        fs::create_dir(&next).unwrap();
        assert_eq!(case.settle(Some(1)), Settled::Nothing);
        assert_eq!(case.text(SERVER), "marfa-server 0.0.75");
        assert_eq!(case.text(MARFA), "marfa 0.0.74");
        assert!(case.record.pending().unwrap().is_some());
        assert_eq!(case.last(), ("failed".into(), failed.into()));

        fs::remove_dir(&next).unwrap();
        fs::write(&next, "marfa 0.0.75").unwrap();
        assert_eq!(case.settle(Some(1)), Settled::Succeeded, "the witness");
        assert_eq!(case.text(MARFA), "marfa 0.0.75");
        assert_eq!(case.record.pending().unwrap(), None);
        assert_eq!(case.last(), ("succeeded".into(), String::new()));
    }

    #[test]
    fn the_old_server_is_asked_before_it_is_put_back_and_a_refusal_keeps_the_new_release() {
        let case = Case::new("refuses");
        fs::remove_file(next_marfa(&case.bin())).unwrap();
        let settled = case.settle_asking(&|_| {
            Some("release 0.0.74 will not open the database: it is newer".into())
        });
        assert_eq!(settled, Settled::Failed);
        assert_eq!(case.text(SERVER), "marfa-server 0.0.75");
        let (outcome, reason) = case.last();
        assert_eq!(outcome, "failed");
        assert!(
            reason.contains("0.0.74 cannot be put back: release 0.0.74 will not open the database"),
            "{reason}"
        );
        assert!(case.record.pending().unwrap().is_some());
    }

    #[test]
    fn a_server_of_another_release_settles_nothing() {
        let case = Case::new("other");
        let settled = settle(&case.record, None, "0.0.74", AT, &|_| None, &|_| None);
        assert_eq!(settled, Settled::Nothing);
        assert!(case.record.pending().unwrap().is_some());
        assert!(next_marfa(&case.bin()).exists());
    }
}

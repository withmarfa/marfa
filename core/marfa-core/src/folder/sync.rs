use std::path::{Path, PathBuf};
use std::time::Duration;

use super::elsewhere;
use super::registry::{self, Reached, Registered};
use super::{
    CaughtUp, Drained, Folder, PullReport, STATE_DIR, ScanReport, SettingsFileReport, Synced,
};
use crate::Result;
use crate::directory::Directory;
use crate::drain::Cut;
use crate::error::CoreError;
use crate::model::HydrateReport;

/// What one sync of a folder did, step by step.
#[derive(Debug, Clone)]
pub struct SyncReport {
    /// The hydration a copy that did not answer for its slice took first.
    pub hydrated: Option<HydrateReport>,
    pub settings: SettingsFileReport,
    pub scan: ScanReport,
    /// Every write the sync sent, those the pull queued after the first
    /// drain included.
    pub drain: Drained,
    /// The hydration the drain took where the server said the copy's read
    /// reach had changed, before it sent the writes still waiting.
    pub rebuilt: Option<HydrateReport>,
    /// Why the catch-up could not reach the server, where it could not; the
    /// sync goes on to write out the copy it holds.
    pub catch_up: std::result::Result<CaughtUp, CoreError>,
    /// `None` where the catch-up failed after the copy expired, which leaves
    /// nothing to pull from until a later sync hydrates. Where the sync
    /// pulled again after a rebuild, the later pull's, with the files both
    /// wrote.
    pub pull: Option<PullReport>,
}

/// What a send-only run of a folder did, step by step.
#[derive(Debug, Clone)]
pub struct SendReport {
    /// The hydration a copy that did not answer for its slice took first.
    pub hydrated: Option<HydrateReport>,
    pub settings: SettingsFileReport,
    pub scan: ScanReport,
    pub drain: Drained,
    /// As for `SyncReport`.
    pub rebuilt: Option<HydrateReport>,
}

impl Folder {
    /// Everything a folder does, once: resumes an unfinished hydration, sends
    /// an edit of the settings file, scans, drains, catches up, pulls, and
    /// drains again where the pull queued the placement of a file it wrote, or
    /// the end of one. Where that drain rebuilt the copy for a changed read
    /// reach, pulls once more, and drains again where that pull placed a file.
    /// A folder whose first sync waits to be confirmed is only read, and says
    /// what the sync will do.
    pub fn sync(&self) -> Result<Synced> {
        let result = self.sync_observed();
        match &result {
            Ok(Synced::Done(report)) => {
                let complete = report.catch_up.is_ok()
                    && report.pull.is_some()
                    && report.drain.report.unavailable.is_none()
                    && report.drain.report.stopped.is_none()
                    && report.drain.report.undelivered == 0
                    && report.drain.report.unsent == 0
                    && report.drain.report.held == 0
                    && report.drain.report.unmade == 0
                    && report.scan.root_gone.is_none()
                    && !report
                        .scan
                        .directories
                        .iter()
                        .any(|entry| matches!(entry.flag, "unreadable" | "gone"));
                let unavailable = report
                    .catch_up
                    .as_ref()
                    .err()
                    .cloned()
                    .or_else(|| stopped_by(&report.drain.report));
                self.health_observe(
                    complete,
                    true,
                    report.pull.as_ref(),
                    unavailable.as_ref(),
                    report.settings.flagged.is_some()
                        || report.settings.unwritten.is_some()
                        || report.pull.as_ref().is_some_and(|pull| {
                            pull.settings.flagged.is_some() || pull.settings.unwritten.is_some()
                        }),
                );
            }
            Ok(Synced::Waiting(_)) => self.health_observe(false, true, None, None, false),
            Err(error) => self.health_observe(false, true, None, Some(error), false),
        }
        self.health_send();
        result
    }

    /// Scans the folder and sends what it holds, and goes no further: it
    /// catches up with nothing and pulls nothing, so it writes no file into
    /// the directory and removes none. A copy that never hydrated hydrates
    /// first, which writes only the store. A later `sync` pulls what this
    /// left. Refused while the first sync waits to be confirmed, before
    /// anything is sent.
    pub fn send_only(&self) -> Result<SendReport> {
        self.refuse_while_waiting()?;
        let result = self.send_only_observed();
        match &result {
            Ok(report) => self.health_observe(
                // Never a complete pass: the copy was not caught up or pulled.
                false,
                true,
                None,
                stopped_by(&report.drain.report).as_ref(),
                report.settings.flagged.is_some() || report.settings.unwritten.is_some(),
            ),
            Err(error) => self.health_observe(false, true, None, Some(error), false),
        }
        self.health_send();
        result
    }

    fn send_only_observed(&self) -> Result<SendReport> {
        let hydrated = self.resume()?;
        let settings = self.send_settings_edit()?;
        let scan = self.scan_keeping_files()?;
        let mut rebuilt = None;
        let drain = self.drain_rebuilding(&mut rebuilt)?;
        Ok(SendReport {
            hydrated,
            settings,
            scan,
            drain,
            rebuilt,
        })
    }

    fn sync_observed(&self) -> Result<Synced> {
        if self.awaiting_confirmation()?
            && let Some(plan) = self.plan_first_sync()?
        {
            return Ok(Synced::Waiting(plan));
        }
        self.sync_confirmed()
            .map(|report| Synced::Done(Box::new(report)))
    }

    fn sync_confirmed(&self) -> Result<SyncReport> {
        let hydrated = self.resume()?;
        // First, so the rest of the sync works on the new settings.
        let settings = self.send_settings_edit()?;
        let scan = self.scan()?;
        let mut rebuilt = None;
        let mut drain = self.drain_rebuilding(&mut rebuilt)?;
        let catch_up = match self.catch_up() {
            Ok(caught) => Ok(caught),
            Err(error) if error.is_environmental() => Err(error),
            Err(error) => return Err(error),
        };
        let mut pull = match self.pull() {
            Ok(pulled) => Some(pulled),
            Err(CoreError::HydrationIncomplete) if catch_up.is_err() => None,
            Err(error) => return Err(error),
        };
        if sends_again(catch_up.is_ok(), &drain.report) && pull.as_ref().is_some_and(places) {
            let rebuilt_before = rebuilt.is_some();
            let later = self.drain_rebuilding(&mut rebuilt)?;
            self.absorb(&mut drain, later)?;
            // The rebuild read the copy under the new reach after the pull
            // wrote it out, so the directory is brought to it once more. The
            // run has rebuilt already, so a change at the drain after this
            // pull ends it.
            if !rebuilt_before && rebuilt.is_some() {
                let mut again = self.pull()?;
                let places_again = places(&again);
                if let Some(first) = &pull {
                    again.add_writes(first);
                }
                if sends_again(true, &drain.report) && places_again {
                    let last = self.drain_rebuilding(&mut rebuilt)?;
                    self.absorb(&mut drain, last)?;
                }
                pull = Some(again);
            }
        }
        Ok(SyncReport {
            hydrated,
            settings,
            scan,
            drain,
            rebuilt,
            catch_up,
            pull,
        })
    }

    /// A drain that the server ends by saying the copy's reach changed,
    /// as it does once the folder's key is replaced or narrowed, builds the
    /// copy again into `rebuilt` and drains once more, so the writes still
    /// waiting go out in this run rather than the next. What the first drain
    /// settled is told with what the second sent. Once a run: where `rebuilt`
    /// holds a rebuild already, a change ends the run. A rebuild that fails
    /// ends it with its own error, the queue kept.
    fn drain_rebuilding(&self, rebuilt: &mut Option<HydrateReport>) -> Result<Drained> {
        match self.drain_keeping(false) {
            Ok(drained) => Ok(drained),
            Err(Cut {
                error: CoreError::CopyExpired { reason },
                settled,
            }) if reason == "reach_changed" && rebuilt.is_none() => {
                *rebuilt = Some(self.hydrate()?);
                let mut drained = *settled;
                self.absorb(&mut drained, self.drain()?)?;
                Ok(drained)
            }
            Err(cut) => Err(cut.error),
        }
    }

    /// Takes `later`, a later drain of the same run, into `drained`. A write
    /// that drain gave way from has left the queue, and the verdict an
    /// earlier drain told of it goes with it.
    fn absorb(&self, drained: &mut Drained, later: Drained) -> Result<()> {
        drained.absorb(later);
        let conn = self.core.conn()?;
        let mut kept = Vec::with_capacity(drained.report.verdicts.len());
        for verdict in std::mem::take(&mut drained.report.verdicts) {
            if crate::store::queued_write(&conn, &verdict.id)?.is_some() {
                kept.push(verdict);
            }
        }
        drained.report.verdicts = kept;
        Ok(())
    }

    /// Takes the folder at `dir` off this machine: its own state under
    /// `.marfa` goes, and its files stay. Refused while writes wait, unless
    /// the first sync still waits to be confirmed. No symbolic link is
    /// followed, and a path through one is taken only where it is the path
    /// the registry lists. A listed folder's state goes
    /// only where the store at its listed path is the one the registry lists
    /// for it; otherwise its entry alone is taken off the registry.
    pub fn remove_at(dir: impl AsRef<Path>) -> Result<Removal> {
        Folder::remove_waiting(dir.as_ref(), None)
    }

    /// `remove_at`, but where another process holds the folder, asks it to
    /// let the folder go and waits up to `HANDOVER_WAIT`, as `open_asking`
    /// does.
    pub fn remove_at_asking(dir: impl AsRef<Path>) -> Result<Removal> {
        Folder::remove_waiting(dir.as_ref(), Some(super::HANDOVER_WAIT))
    }

    /// Whether `dir` holds a folder's store, read without opening it.
    pub fn is_at(dir: impl AsRef<Path>) -> bool {
        held(dir.as_ref())
    }

    /// Whether a command asks for, or works, the folder at `dir`, read
    /// without opening its store.
    pub fn asked_at(dir: impl AsRef<Path>) -> bool {
        Directory::open(dir.as_ref())
            .and_then(|root| root.child(Path::new(STATE_DIR), false))
            .is_ok_and(|state| super::handover::asked_at(&state))
    }

    fn remove_waiting(dir: &Path, wait: Option<Duration>) -> Result<Removal> {
        let spelled = registry::absolute(dir);
        let listed = registry::listing();
        if let Some(entry) = listed.iter().find(|entry| entry.dir == spelled) {
            return Folder::remove_listed(entry.clone(), wait);
        }
        if let Some(link) = registry::first_link(&spelled) {
            let instead = match registry::reach(dir)? {
                Reached::Listed(entry) => format!(
                    "the folder it reaches is listed at {}; to remove that folder, name that path, as `folders list` shows it",
                    entry.dir.display()
                ),
                Reached::Unlisted(_) => "name the folder by a path without symbolic links".into(),
            };
            return Err(CoreError::Invalid(format!(
                "{} passes through the symbolic link {}, and `folders remove` takes a path through a link only where it is the path the folder registry lists; {instead}",
                spelled.display(),
                link.display()
            )));
        }
        let root = registry::named(dir)?;
        match registry::listed_at(&root, &listed) {
            Some(entry) => Folder::remove_listed(entry, wait),
            None => {
                Folder::open_without_listing(root.clone(), None, wait)?.remove()?;
                Ok(Removal::Deleted(root))
            }
        }
    }

    /// Bound to the store the registry lists for `entry`, so a folder that
    /// has taken its directory's place is never removed in its stead.
    fn remove_listed(entry: Registered, wait: Option<Duration>) -> Result<Removal> {
        let reason = if let Some(link) = registry::first_link(&entry.dir) {
            format!("{} is now a symbolic link", link.display())
        } else if !held(&entry.dir) {
            "no folder state is there".to_string()
        } else {
            let folder = Folder::open_without_listing(entry.dir.clone(), None, wait)?;
            match (&entry.store, elsewhere::listed_store(&folder.core)) {
                (Some(listed), Some(found)) if *listed == found => {
                    folder.remove()?;
                    return Ok(Removal::Deleted(entry.dir));
                }
                (None, _) => "the registry lists no store for it, so the state there cannot be shown to be its own".to_string(),
                (Some(_), None) => "no store id can be read from the folder state there, so it cannot be shown to be its own".to_string(),
                (Some(_), Some(found)) => format!(
                    "the folder state there is not the one the registry lists for it; {}",
                    whose(&found)
                ),
            }
        };
        Folder::forget(&entry.dir)?;
        Ok(Removal::Unlisted {
            dir: entry.dir,
            reason,
        })
    }
}

/// What a removal did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Removal {
    /// The folder's own state at this directory went; its files stay.
    Deleted(PathBuf),
    /// Only the registry entry for this directory went, and nothing was
    /// deleted, for the reason given.
    Unlisted { dir: PathBuf, reason: String },
}

/// Whose state a listed folder's directory holds instead of its own.
fn whose(store: &str) -> String {
    let holder = registry::listing()
        .into_iter()
        .find(|entry| entry.store.as_deref() == Some(store));
    match holder {
        Some(entry) => format!(
            "it is the state of the folder listed at {}",
            entry.dir.display()
        ),
        None => "it is the state of a folder the registry does not list".to_string(),
    }
}

fn held(root: &Path) -> bool {
    Directory::open(root)
        .and_then(|root| root.child(Path::new(STATE_DIR), false))
        .and_then(|state| state.entry_identity(Path::new("core.sqlite")))
        .is_ok()
}

/// The failure a drain that could not finish shows, for the folder's health.
fn stopped_by(drain: &crate::DrainReport) -> Option<CoreError> {
    drain
        .unavailable
        .as_ref()
        .map(|_| CoreError::Network("unavailable".into()))
        .or_else(|| {
            drain.stopped.as_ref().map(|_| CoreError::Unauthorized {
                code: "unauthorized".into(),
                message: "credential refused".into(),
            })
        })
}

/// Whether a pull queued the placement of a file it wrote, or the end of one.
fn places(pulled: &PullReport) -> bool {
    pulled.placed + pulled.ended > 0
}

/// Not where the first drain or the catch-up shows the server cannot take
/// writes (unreachable, credential refused, a write left undelivered): the
/// report says why, and the placements wait for the next sync.
fn sends_again(caught_up: bool, first: &crate::DrainReport) -> bool {
    caught_up && first.unavailable.is_none() && first.stopped.is_none() && first.undelivered == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drained() -> crate::DrainReport {
        crate::DrainReport {
            answered: 1,
            held: 0,
            undelivered: 0,
            unsent: 0,
            unmade: 0,
            unavailable: None,
            verdicts: Vec::new(),
            stopped: None,
            unclaimed_sources: Vec::new(),
            retry_after_seconds: None,
        }
    }

    #[test]
    fn a_verdict_an_earlier_drain_told_leaves_with_a_write_a_later_drain_withdrew() {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let db = dir.path().join(STATE_DIR).join("core.sqlite");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let core = super::super::working(crate::Core::open(&db, None).unwrap()).unwrap();
        super::super::settings_file::bind(&core, "folder").unwrap();
        drop(core);
        let folder = Folder::open(
            dir.path(),
            Some(crate::Server {
                url: "http://127.0.0.1:9".into(),
                key: "fixture".into(),
            }),
        )
        .unwrap();
        let queued = folder
            .core
            .create_item(&crate::model::Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({ "title": "Kept", "body": "" })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .unwrap();
        let told = |id: &str| crate::drain::DrainVerdict {
            id: id.into(),
            kind: crate::model::WriteKind::CreateEdge,
            item_id: None,
            edge_id: None,
            verdict: Some(crate::model::Verdict::Refused),
            reason: Some("edge_duplicate".into()),
            refusal: None,
            conflicted_copy_id: None,
            refusals: 0,
            replayed: false,
            merged_fields: Vec::new(),
        };
        let drained = |verdicts| Drained {
            report: crate::DrainReport {
                verdicts,
                ..drained()
            },
            rebased: 0,
            gave_way: 0,
        };
        let mut first = drained(vec![told(&queued.id), told("withdrawn")]);
        folder.absorb(&mut first, drained(Vec::new())).unwrap();
        assert_eq!(
            first
                .report
                .verdicts
                .iter()
                .map(|verdict| verdict.id.as_str())
                .collect::<Vec<_>>(),
            vec![queued.id.as_str()],
            "a write no longer queued kept its verdict, or a queued one lost it"
        );
    }

    #[test]
    fn a_second_drain_goes_only_where_nothing_showed_the_server_unable_to_take_writes() {
        assert!(sends_again(true, &drained()), "the witness: it goes");
        assert!(!sends_again(false, &drained()), "the catch-up failed");
        let unreachable = crate::DrainReport {
            unavailable: Some("the server did not answer".into()),
            ..drained()
        };
        assert!(!sends_again(true, &unreachable));
        let refused = crate::DrainReport {
            stopped: Some("the server refused the credential".into()),
            ..drained()
        };
        assert!(!sends_again(true, &refused));
        let undelivered = crate::DrainReport {
            undelivered: 1,
            ..drained()
        };
        assert!(!sends_again(true, &undelivered));
    }
}

use std::path::Path;

use super::{
    CaughtUp, Drained, Folder, PullReport, STATE_DIR, ScanReport, SettingsFileReport, Synced,
};
use crate::Result;
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
    /// Why the catch-up could not reach the server, where it could not; the
    /// sync goes on to write out the copy it holds.
    pub catch_up: std::result::Result<CaughtUp, CoreError>,
    /// `None` where the catch-up failed after the copy expired, which leaves
    /// nothing to pull from until a later sync hydrates.
    pub pull: Option<PullReport>,
}

impl Folder {
    /// Everything a folder does, once: resumes an unfinished hydration, sends
    /// an edit of the settings file, scans, drains, catches up, pulls, and
    /// drains again where the pull queued the placement of a file it wrote, or
    /// the end of one.
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
                    .or_else(|| {
                        report
                            .drain
                            .report
                            .unavailable
                            .as_ref()
                            .map(|_| CoreError::Network("unavailable".into()))
                    })
                    .or_else(|| {
                        report
                            .drain
                            .report
                            .stopped
                            .as_ref()
                            .map(|_| CoreError::Unauthorized {
                                code: "unauthorized".into(),
                                message: "credential refused".into(),
                            })
                    });
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
        let mut drain = self.drain()?;
        let catch_up = match self.catch_up() {
            Ok(caught) => Ok(caught),
            Err(error) if error.is_environmental() => Err(error),
            Err(error) => return Err(error),
        };
        let pull = match self.pull() {
            Ok(pulled) => Some(pulled),
            Err(CoreError::HydrationIncomplete) if catch_up.is_err() => None,
            Err(error) => return Err(error),
        };
        if sends_again(catch_up.is_ok(), &drain.report)
            && pull
                .as_ref()
                .is_some_and(|pulled| pulled.placed + pulled.ended > 0)
        {
            drain.absorb(self.drain()?);
        }
        Ok(SyncReport {
            hydrated,
            settings,
            scan,
            drain,
            catch_up,
            pull,
        })
    }

    /// Takes the folder at `dir` off this machine: its own state under
    /// `.marfa` goes, and its files stay. Refused while writes wait, unless
    /// the first sync still waits to be confirmed. A folder whose directory
    /// is gone is only taken off the registry.
    pub fn remove_at(dir: impl AsRef<Path>) -> Result<()> {
        let dir = &super::registry::resolved(dir.as_ref());
        let has_store = crate::directory::Directory::open(dir)
            .and_then(|root| root.child(Path::new(STATE_DIR), false))
            .and_then(|state| state.entry_identity(Path::new("core.sqlite")))
            .is_ok();
        if has_store || !Folder::forget(dir)? {
            Folder::open(dir, None)?.remove()?;
        }
        Ok(())
    }
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

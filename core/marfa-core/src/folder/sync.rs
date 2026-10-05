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
    /// drains again where the pull queued the placement of a file it wrote.
    /// A folder whose first sync waits to be confirmed is only read, and says
    /// what the sync will do.
    pub fn sync(&self) -> Result<Synced> {
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
            && pull.as_ref().is_some_and(|pulled| pulled.placed > 0)
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
        let dir = dir.as_ref();
        if dir.join(STATE_DIR).exists() || !Folder::forget(dir)? {
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

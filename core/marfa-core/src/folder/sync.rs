use std::path::Path;

use super::{CaughtUp, Drained, Folder, PullReport, STATE_DIR, ScanReport, SettingsFileReport};
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
    /// an edit of the settings file, scans, drains, catches up and pulls.
    pub fn sync(&self) -> Result<SyncReport> {
        let hydrated = self.resume()?;
        // First, so the rest of the sync works on the new settings.
        let settings = self.send_settings_edit()?;
        let scan = self.scan()?;
        let drain = self.drain()?;
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
    /// `.marfa` goes, and its files stay. Refused while writes wait. A folder
    /// whose directory is gone is only taken off the registry.
    pub fn remove_at(dir: impl AsRef<Path>) -> Result<()> {
        let dir = dir.as_ref();
        if dir.join(STATE_DIR).exists() || !Folder::forget(dir)? {
            Folder::open(dir, None)?.remove()?;
        }
        Ok(())
    }
}

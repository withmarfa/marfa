//! What a pass reports: its counts, the verdicts it told and a pass that ended in an error.

use serde::Serialize;

use crate::Result;
use crate::error::CoreError;
use crate::model::{Refusal, RowConflict, Verdict, WriteKind};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DrainReport {
    /// Writes the server answered this pass, whatever it answered.
    pub answered: usize,
    pub held: usize,
    /// Includes uploads whose bytes cannot be opened, even when set aside.
    pub undelivered: usize,
    /// Writes this pass gave a verdict without sending them: refused for a
    /// write they waited on or for bytes no longer held, or settled by
    /// another write's answer.
    pub unsent: usize,
    /// Writes whose request could not be made, such as a header the
    /// transport would not build: each is counted against its write and
    /// waits for the next drain, or is dead at the ceiling. With `answered`,
    /// `held`, `undelivered` and `unsent`, every write the pass came to; the
    /// writes a refused credential parks are counted in `stopped`.
    pub unmade: usize,
    /// Why the pass ended before the queue was through: the server could not
    /// be reached, failed, or asked to be left alone for a while.
    pub unavailable: Option<String>,
    /// Whether the pass ended because the server answered `429`: it limited
    /// requests, so it was reached.
    #[serde(skip)]
    pub limited: bool,
    /// Also holds rows settled without being sent, by another write's answer.
    pub verdicts: Vec<DrainVerdict>,
    /// Set when a refused credential parks the queue. An answer on another
    /// contract ends the drain as an error instead.
    pub stopped: Option<String>,
    /// The server's answer behind `stopped`.
    #[serde(skip)]
    pub refused_by: Option<Box<crate::error::ServerAnswer>>,
    /// Reported because `credential_refused` alone reads as a key that no
    /// longer works.
    pub unclaimed_sources: Vec<String>,
    /// The longest `Retry-After` of the pass, not the last: a caller waits
    /// once for the whole pass.
    pub retry_after_seconds: Option<u64>,
}

impl DrainReport {
    pub(crate) fn empty() -> DrainReport {
        DrainReport {
            answered: 0,
            held: 0,
            undelivered: 0,
            unsent: 0,
            unmade: 0,
            unavailable: None,
            limited: false,
            verdicts: Vec::new(),
            stopped: None,
            refused_by: None,
            unclaimed_sources: Vec::new(),
            retry_after_seconds: None,
        }
    }

    /// Whether the pass sent what it could and has no wait, outage or
    /// credential stop to tell.
    pub(super) fn has_nothing_left(&self) -> bool {
        self.unavailable.is_none()
            && self.stopped.is_none()
            && self.retry_after_seconds.is_none()
            && self.undelivered == 0
            && self.unmade == 0
    }

    /// Takes in a later pass of the same drain, so the two read as one: what
    /// was sent adds up, and what still waits is what the later pass left.
    pub(crate) fn absorb(&mut self, later: DrainReport) {
        self.answered += later.answered;
        self.unsent += later.unsent;
        self.unmade += later.unmade;
        self.held = later.held;
        self.undelivered = later.undelivered;
        self.unavailable = later.unavailable;
        self.limited = later.limited;
        self.verdicts.extend(later.verdicts);
        self.stopped = later.stopped;
        self.refused_by = later.refused_by;
        for source in later.unclaimed_sources {
            if !self.unclaimed_sources.contains(&source) {
                self.unclaimed_sources.push(source);
            }
        }
        self.retry_after_seconds = self.retry_after_seconds.max(later.retry_after_seconds);
    }
}

/// A drain that ended in an error, with what it settled before it: the queue
/// holds each of those verdicts already, so a caller that goes on, as a
/// folder push does after rebuilding its copy, tells them with its own.
#[derive(Debug)]
pub(crate) struct Cut<T = DrainReport> {
    pub error: CoreError,
    pub settled: Box<T>,
}

impl From<CoreError> for Cut {
    fn from(error: CoreError) -> Cut {
        Cut {
            error,
            settled: Box::new(DrainReport::empty()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DrainVerdict {
    pub id: String,
    pub kind: WriteKind,
    /// An edge write's source; otherwise the item written to.
    pub item_id: Option<String>,
    pub edge_id: Option<String>,
    /// `None` where the write was sent and not answered.
    pub verdict: Option<Verdict>,
    pub reason: Option<String>,
    /// A terminal or credential refusal, read from what the queue stored.
    pub refusal: Option<Refusal>,
    pub conflicted_copy_id: Option<String>,
    pub refusals: i64,
    /// Set by either the `Idempotency-Replayed` header or the answer's
    /// `acknowledged`.
    pub replayed: bool,
    pub merged_fields: Vec<String>,
    /// What a `conflicted` row write replaced unseen.
    pub conflicts: Vec<RowConflict>,
}

impl DrainVerdict {
    pub fn outcome(&self) -> Result<Option<crate::model::Outcome>> {
        crate::model::Outcome::of(
            self.verdict,
            self.reason.as_deref(),
            self.conflicted_copy_id.as_deref(),
            self.merged_fields.clone(),
            &self.conflicts,
            self.refusal.as_ref(),
        )
    }
}

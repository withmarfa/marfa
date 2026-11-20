//! Holds a change an area makes to the confirmation its preview gave: judged in a read before
//! anything costly, then again in the write that makes the change and spends it.

use rusqlite::Transaction;

use super::confirm::{self, Bound, Opening, Signer};
use crate::app::access::Caller;
use crate::app::clock::Stamp;
use crate::app::refusal::Result;
use crate::app::unit::Unit;

/// Why a confirmed change was not made.
#[derive(Debug, PartialEq, Eq)]
pub enum Halt {
    /// The token is not this credential's for this target, or it expired.
    Stale,
    /// This credential spent the token on this target, and that change committed.
    Repeated { total: i64 },
    /// What the preview showed is gone or not as it was.
    Changed,
}

#[derive(Clone)]
pub struct Guard {
    tool: &'static str,
    signer: Signer,
    credential: String,
    target: String,
    bound: Bound,
}

pub fn subject(target: &str, digest: &str) -> String {
    confirm::subject_digest(&[target.to_string()], digest)
}

pub fn issue(
    signer: &Signer,
    tool: &str,
    caller: &Caller,
    target: &str,
    digest: &str,
    now_ms: i64,
) -> Result<confirm::Token> {
    signer.issue_bound(
        tool,
        &caller.credential_handle(),
        target,
        &subject(target, digest),
        now_ms,
    )
}

impl Guard {
    pub fn new(
        tool: &'static str,
        signer: Signer,
        caller: &Caller,
        target: String,
        bound: Bound,
    ) -> Guard {
        Guard {
            tool,
            signer,
            credential: caller.credential_handle(),
            target,
            bound,
        }
    }

    fn judged(&self, opening: Opening, digest: Option<&str>) -> Result<Option<Halt>> {
        match opening {
            Opening::Stale => return Ok(Some(Halt::Stale)),
            Opening::Spent { total } => return Ok(Some(Halt::Repeated { total })),
            Opening::Open => {}
        }
        let Some(digest) = digest else {
            return Ok(Some(Halt::Changed));
        };
        let held = self.signer.holds_subject(
            self.tool,
            &self.credential,
            &subject(&self.target, digest),
            &self.bound,
        )?;
        Ok((!held).then_some(Halt::Changed))
    }

    /// The token alone, in a read: nothing of the target is read.
    pub fn peek(&self, tx: &Transaction<'_>, now: Stamp) -> Result<Option<Halt>> {
        let opening = self.signer.peek(
            tx,
            self.tool,
            &self.credential,
            &self.target,
            &self.bound,
            now,
        )?;
        match opening {
            Opening::Open => Ok(None),
            opening => self.judged(opening, None),
        }
    }

    /// The token, then the target as `digest` reads it now, `None` where it is gone, in a read.
    pub fn peek_at(
        &self,
        tx: &Transaction<'_>,
        now: Stamp,
        digest: Option<&str>,
    ) -> Result<Option<Halt>> {
        let opening = self.signer.peek(
            tx,
            self.tool,
            &self.credential,
            &self.target,
            &self.bound,
            now,
        )?;
        self.judged(opening, digest)
    }

    /// The token, then the target as `digest` reads it, in the write that would spend it.
    pub fn check(&self, unit: &Unit<'_, '_>, digest: Option<&str>) -> Result<Option<Halt>> {
        let opening = self.signer.open(
            unit.tx(),
            self.tool,
            &self.credential,
            &self.target,
            &self.bound,
            unit.instant,
        )?;
        self.judged(opening, digest)
    }

    /// Records the token as spent, in the write of the change it allowed.
    pub fn spend(&self, unit: &Unit<'_, '_>, total: i64) -> Result<()> {
        confirm::spend_bound(
            unit.tx(),
            &self.bound,
            &self.credential,
            &self.target,
            total,
        )
    }
}

//! A confirmation binds updating the server to the release its preview named, and confirming the
//! clock to the hold its preview showed, each judged and spent in the write that does the act.

use std::sync::Arc;

use super::confirm::{self, Bound, Opening, Signer};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::clock::{Stamp, Standing};
use crate::app::housekeeping::{self, ClockConfirmed};
use crate::app::refusal::Result;
use crate::app::updates::{self, Started};

pub const UPDATE_TOOL: &str = "marfa_update_server";
pub const CLOCK_TOOL: &str = "marfa_maintain";

/// Why a confirming call did nothing.
#[derive(Debug, PartialEq, Eq)]
pub enum Stopped {
    /// This credential spent the token on this act, and that act committed.
    Repeated,
    /// The token is not this credential's for this act, or it expired.
    Stale,
    /// The release or the hold is not the one the preview showed.
    Changed,
}

fn target(act: &str) -> String {
    confirm::ids_digest(&[act.to_string()])
}

fn subject(target: &str, digest: &str) -> String {
    confirm::subject_digest(&[target.to_string()], digest)
}

fn issue(
    app: &App,
    caller: &Caller,
    tool: &str,
    act: &str,
    digest: &str,
) -> Result<confirm::Token> {
    let target = target(act);
    app.mcp.signer.issue_bound(
        tool,
        &caller.credential_handle(),
        &target,
        &subject(&target, digest),
        app.clock.now_ms(),
    )
}

/// What a confirmation of the clock binds: the trusted time, and the wall reading at the hold's
/// start, which any jump or restart since moves.
pub fn hold_digest(standing: Standing, from: Stamp) -> Option<String> {
    match standing {
        Standing::Ahead { trusted, .. } => Some(format!("{} {}", trusted.ms(), from.ms())),
        Standing::Agrees | Standing::Behind { .. } => None,
    }
}

pub fn update_token(app: &App, caller: &Caller, release: &str) -> Result<confirm::Token> {
    issue(app, caller, UPDATE_TOOL, "update", release)
}

pub fn clock_token(app: &App, caller: &Caller, digest: &str) -> Result<confirm::Token> {
    issue(app, caller, CLOCK_TOOL, "clock", digest)
}

/// Judges the token, then whether `digest` is what the preview signed, and spends the token.
fn judged(
    app: &App,
    caller: &Caller,
    tool: &'static str,
    act: &'static str,
    bound: Bound,
) -> impl FnOnce(&rusqlite::Transaction<'_>, Option<String>) -> Result<Option<Stopped>> + Send + 'static
{
    let (signer, clock) = (app.mcp.signer.clone(), app.clock.clone());
    let credential = caller.credential_handle();
    move |tx, digest| {
        let opened = Opened {
            signer: &signer,
            tool,
            credential: &credential,
            act,
        };
        opened.judge(tx, &bound, clock.instant(), digest)
    }
}

struct Opened<'a> {
    signer: &'a Signer,
    tool: &'static str,
    credential: &'a str,
    act: &'static str,
}

impl Opened<'_> {
    fn judge(
        &self,
        tx: &rusqlite::Transaction<'_>,
        bound: &Bound,
        now: Stamp,
        digest: Option<String>,
    ) -> Result<Option<Stopped>> {
        let (signer, tool, credential) = (self.signer, self.tool, self.credential);
        let target = target(self.act);
        match signer.open(tx, tool, credential, &target, bound, now)? {
            Opening::Stale => return Ok(Some(Stopped::Stale)),
            Opening::Spent { .. } => return Ok(Some(Stopped::Repeated)),
            Opening::Open => {}
        }
        let Some(digest) = digest else {
            return Ok(Some(Stopped::Changed));
        };
        if !signer.holds_subject(tool, credential, &subject(&target, &digest), bound)? {
            return Ok(Some(Stopped::Changed));
        }
        confirm::spend_bound(tx, bound, credential, &target, 1)?;
        Ok(None)
    }
}

/// Starts the update to the release the preview named, refused as `POST /update` refuses it.
pub async fn update_confirmed(
    app: &Arc<App>,
    caller: &Caller,
    bound: Bound,
) -> Result<Started<Stopped>> {
    let judge = judged(app, caller, UPDATE_TOOL, "update", bound);
    updates::start_if(app, caller, move |tx, release| {
        judge(tx, Some(release.to_string()))
    })
    .await
}

/// Takes the server's clock as right, only while the hold the preview showed still stands.
pub async fn clock_confirmed(
    app: &App,
    caller: &Caller,
    bound: Bound,
) -> Result<ClockConfirmed<Stopped>> {
    let judge = judged(app, caller, CLOCK_TOOL, "clock", bound);
    housekeeping::confirm_clock_if(app, caller, move |tx, hold| {
        judge(
            tx,
            hold.and_then(|(standing, from)| hold_digest(standing, from)),
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spent_table() -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE mcp_spent_confirmations (token TEXT PRIMARY KEY NOT NULL, \
                 credential TEXT NOT NULL, subject_digest TEXT NOT NULL, \
                 total INTEGER NOT NULL, expires_at TEXT NOT NULL) STRICT, WITHOUT ROWID;",
            )
            .unwrap();
        connection
    }

    #[test]
    fn an_update_confirmation_holds_only_for_the_release_its_preview_named() {
        let signer = Signer::derive("instance").unwrap();
        let target = target("update");
        let token = signer
            .issue_bound(
                UPDATE_TOOL,
                "key-a",
                &target,
                &subject(&target, "1.2.3"),
                1_000,
            )
            .unwrap();
        let bound = confirm::parse_bound(&token.text).unwrap();
        let mut connection = spent_table();
        let tx = connection.transaction().unwrap();
        let now = Stamp::from_ms(2_000).unwrap();
        let opened = |credential: &'static str, tool: &'static str| Opened {
            signer: &signer,
            tool,
            credential,
            act: "update",
        };
        let judge = |credential, tool, release: &str| {
            opened(credential, tool)
                .judge(&tx, &bound, now, Some(release.to_string()))
                .unwrap()
        };
        assert_eq!(judge("key-a", UPDATE_TOOL, "1.2.4"), Some(Stopped::Changed));
        assert_eq!(judge("key-b", UPDATE_TOOL, "1.2.3"), Some(Stopped::Stale));
        assert_eq!(judge("key-a", CLOCK_TOOL, "1.2.3"), Some(Stopped::Stale));
        assert_eq!(
            opened("key-a", UPDATE_TOOL)
                .judge(&tx, &bound, now, None)
                .unwrap(),
            Some(Stopped::Changed)
        );
        assert_eq!(judge("key-a", UPDATE_TOOL, "1.2.3"), None);
        assert_eq!(
            judge("key-a", UPDATE_TOOL, "1.2.3"),
            Some(Stopped::Repeated)
        );
    }

    #[test]
    fn a_clock_confirmation_binds_the_trusted_time_and_where_the_hold_counts_from() {
        let at = |ms: i64| Stamp::from_ms(ms).unwrap();
        let ahead = |trusted: i64| Standing::Ahead {
            trusted: at(trusted),
            wall: at(5_000),
            ends: at(9_000),
        };
        let digest = hold_digest(ahead(1_000), at(4_000));
        assert!(digest.is_some());
        assert_ne!(digest, hold_digest(ahead(1_000), at(4_500)));
        assert_ne!(digest, hold_digest(ahead(2_000), at(4_000)));
        assert_eq!(hold_digest(Standing::Agrees, at(4_000)), None);
    }
}

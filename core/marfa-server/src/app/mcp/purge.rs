//! A confirmation binds a purge to the ids it names and to the walk its preview showed.

use std::sync::Arc;

use super::confirm::{self, Bound, Opening};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::write::{self, Chosen};
use crate::app::items::{self, Choosing, PurgePreview};
use crate::app::refusal::Result;

pub const TOOL: &str = "marfa_purge";

#[derive(Debug, PartialEq, Eq)]
pub enum Confirmed {
    Purged {
        total: i64,
    },
    /// This credential spent the token on these ids, and that purge committed.
    AlreadyPurged {
        total: i64,
    },
    /// The token is not this credential's for these ids, or it expired. Nothing of the ids was read.
    Stale,
    /// A named item, or something the walk takes, is gone or not as the preview showed it.
    Changed,
}

pub async fn preview(app: &App, caller: &Caller, choosing: Choosing) -> Result<PurgePreview> {
    items::purge_preview(app, caller, choosing).await
}

pub fn token_for(app: &App, caller: &Caller, preview: &PurgePreview) -> Result<confirm::Token> {
    app.mcp.signer.issue_bound(
        TOOL,
        &caller.credential_handle(),
        &confirm::ids_digest(&preview.ids),
        &confirm::subject_digest(&preview.ids, &preview.digest),
        app.clock.now_ms(),
    )
}

/// The token is judged, the ids read and walked, the walk purged and the token spent in one write,
/// so a failure anywhere leaves every row and the token as they were.
pub async fn confirmed(
    app: &Arc<App>,
    caller: &Caller,
    ids: Vec<String>,
    bound: Bound,
) -> Result<Confirmed> {
    let credential = caller.credential_handle();
    let signer = app.mcp.signer.clone();
    let cache = app.catalog_handle();
    app.write(caller, "item.purge", move |unit| {
        let target = confirm::ids_digest(&ids);
        match signer.open(unit.tx(), TOOL, &credential, &target, &bound, unit.instant)? {
            Opening::Stale => return Ok(Confirmed::Stale),
            Opening::Spent { total } => return Ok(Confirmed::AlreadyPurged { total }),
            Opening::Open => {}
        }
        let agree = |digest: &str| {
            let subject = confirm::subject_digest(&ids, digest);
            signer.holds_subject(TOOL, &credential, &subject, &bound)
        };
        match write::purge_chosen(unit, &cache, &ids, agree)? {
            Chosen::Changed => Ok(Confirmed::Changed),
            Chosen::Purged(count) => {
                let total = i64::try_from(count).unwrap_or(i64::MAX);
                confirm::spend_bound(unit.tx(), &bound, &credential, &target, total)?;
                Ok(Confirmed::Purged { total })
            }
        }
    })
    .await
}

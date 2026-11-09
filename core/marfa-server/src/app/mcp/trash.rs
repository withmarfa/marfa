//! A confirmation binds a trash operation to its preview.

use std::sync::Arc;

use serde_json::Value;

use super::confirm::{self, Check};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::trash_preview;
use crate::app::items::write::{self, Change};
use crate::app::refusal::{Refusal, Result};

pub const TOOL: &str = "marfa_delete";

/// What trashing the named items would do, as the caller may see it.
#[derive(Clone)]
pub struct Preview {
    pub items: Vec<Value>,
    pub count: i64,
    pub digest: String,
}

pub enum Confirmed {
    Trashed {
        total: i64,
    },
    /// The token had been spent on this same change, which already landed.
    AlreadyTrashed {
        total: i64,
    },
    /// The token does not cover what the trash would take now.
    Stale,
}

pub async fn preview(app: &App, caller: &Caller, ids: Vec<String>) -> Result<Preview> {
    let text = trash_preview(app, caller, ids).await?;
    let unreadable = || Refusal::internal("a trash preview did not read");
    let Value::Object(mut whole) = serde_json::from_str(&text).map_err(|_| unreadable())? else {
        return Err(unreadable());
    };
    let items = match whole.remove("items") {
        Some(Value::Array(items)) => items,
        _ => return Err(unreadable()),
    };
    let count = whole
        .get("count")
        .and_then(Value::as_i64)
        .ok_or_else(unreadable)?;
    let digest = match whole.remove("digest") {
        Some(Value::String(digest)) => digest,
        _ => return Err(unreadable()),
    };
    Ok(Preview {
        items,
        count,
        digest,
    })
}

pub fn token_for(
    app: &App,
    caller: &Caller,
    ids: &[String],
    preview: &Preview,
) -> Result<confirm::Token> {
    app.mcp.signer.issue(
        TOOL,
        &caller.credential_handle(),
        &confirm::subject_digest(ids, &preview.digest),
        app.clock.now_ms(),
    )
}

/// The token's expiry, signature and spend are judged on the clock and state the write commits.
pub async fn confirmed(
    app: &Arc<App>,
    caller: &Caller,
    ids: Vec<String>,
    fresh: Result<Preview>,
    token: &str,
) -> Result<Confirmed> {
    let Some(parsed) = confirm::parse(token) else {
        return Ok(Confirmed::Stale);
    };
    let credential = caller.credential_handle();
    let signer = app.mcp.signer.clone();
    let token = token.to_string();
    let cache = app.catalog_handle();
    app.write(caller, "items.trash", move |unit| {
        let now_ms = unit.instant.ms();
        if parsed.expires_at_ms <= now_ms {
            return Ok(Confirmed::Stale);
        }
        confirm::sweep(unit.tx(), unit.instant)?;
        let named = confirm::ids_digest(&ids);
        if let Some(spent) = confirm::spent(unit.tx(), &parsed.signature)? {
            return Ok(
                if spent.credential == credential && spent.ids_digest == named {
                    Confirmed::AlreadyTrashed { total: spent.total }
                } else {
                    Confirmed::Stale
                },
            );
        }
        let preview = fresh?;
        let subject = confirm::subject_digest(&ids, &preview.digest);
        if signer.check(TOOL, &credential, &subject, &token, now_ms)? != Check::Valid {
            return Ok(Confirmed::Stale);
        }
        let change = Change::Trash {
            ids,
            digest: Some(preview.digest),
        };
        write::apply(unit, &cache, None, change)?;
        confirm::spend(unit.tx(), &parsed, &credential, &named, preview.count)?;
        Ok(Confirmed::Trashed {
            total: preview.count,
        })
    })
    .await
}

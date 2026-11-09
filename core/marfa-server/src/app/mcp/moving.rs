//! A confirmation binds a type move to the items and settings its preview showed.

use std::sync::Arc;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::confirm::{self, Check};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::types::{self, Move};

pub const TOOL: &str = "marfa_move_items";

/// What a move would take, as the caller may see it.
pub struct Preview {
    pub body: Map<String, Value>,
    digest: String,
}

/// A preview made after a confirmation went stale.
pub enum Fresh {
    /// The move can start; confirm this preview.
    Open(Preview),
    /// Settings that name the type block the move; the body lists them and carries no token.
    Blocked(Map<String, Value>),
}

pub enum Confirmed {
    /// The move was queued; the job's answer.
    Started(String),
    /// The token does not cover what the move would take now.
    Stale,
}

/// A value with every object's keys in sorted order, so equal values hash equal.
fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort_unstable();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), sorted(&object[key])))
                    .collect(),
            )
        }
        Value::Array(list) => Value::Array(list.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

/// What a preview covered: the move, the items it takes and the settings it names.
fn covered(
    from: &str,
    to: &str,
    properties: Option<&Map<String, Value>>,
    taking: (&[String], &Value, bool),
) -> String {
    let (ids, settings, subtypes) = taking;
    let mut ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    ids.sort_unstable();
    let properties = properties.map_or(Value::Null, |properties| {
        sorted(&Value::Object(properties.clone()))
    });
    hex::encode(Sha256::digest(
        format!(
            "{from}\n{to}\n{properties}\n{settings}\n{subtypes}\n{}",
            ids.join("\n")
        )
        .as_bytes(),
    ))
}

fn subject(digest: &str) -> String {
    confirm::subject_digest(&[], digest)
}

pub async fn preview(
    app: &Arc<App>,
    caller: &Caller,
    from: &str,
    to: &str,
    properties: Option<&Map<String, Value>>,
) -> Result<Preview> {
    let (body, subtypes) = types::dry_run(app, caller, from.to_string(), to.to_string()).await?;
    let unreadable = || Refusal::internal("a move preview did not read");
    let Value::Object(body) = body else {
        return Err(unreadable());
    };
    let ids: Vec<String> = match body.get("ids") {
        Some(Value::Array(ids)) => ids
            .iter()
            .map(|id| id.as_str().map(str::to_string).ok_or_else(unreadable))
            .collect::<Result<_>>()?,
        _ => return Err(unreadable()),
    };
    let settings = body.get("settings").ok_or_else(unreadable)?;
    let digest = covered(from, to, properties, (&ids, settings, subtypes));
    Ok(Preview { body, digest })
}

/// A preview for a caller whose confirmation went stale: the move as it stands now.
pub async fn fresh(
    app: &Arc<App>,
    caller: &Caller,
    from: &str,
    to: &str,
    properties: Option<&Map<String, Value>>,
) -> Result<Fresh> {
    match preview(app, caller, from, to, properties).await {
        Ok(preview) => Ok(Fresh::Open(preview)),
        Err(refusal) if matches!(refusal.code, Code::TypeMoveBlocked) => {
            let settings = refusal
                .details
                .as_ref()
                .and_then(|details| details.get("settings"))
                .cloned()
                .ok_or_else(|| Refusal::internal("a blocked move named no settings"))?;
            let mut body = Map::new();
            body.insert("from".into(), from.into());
            body.insert("to".into(), to.into());
            body.insert("settings".into(), settings);
            Ok(Fresh::Blocked(body))
        }
        Err(refusal) => Err(refusal),
    }
}

pub fn token_for(app: &App, caller: &Caller, preview: &Preview) -> Result<confirm::Token> {
    app.mcp.signer.issue(
        TOOL,
        &caller.credential_handle(),
        &subject(&preview.digest),
        app.clock.now_ms(),
    )
}

/// The token's expiry, signature and spend, and what the move would take, are judged in the write that starts the job.
pub async fn confirmed(
    app: &Arc<App>,
    caller: &Caller,
    from: &str,
    to: &str,
    properties: Option<Map<String, Value>>,
    token: &str,
) -> Result<Confirmed> {
    let Some(parsed) = confirm::parse(token) else {
        return Ok(Confirmed::Stale);
    };
    let credential = caller.credential_handle();
    let signer = app.mcp.signer.clone();
    let token = token.to_string();
    let (named_from, named_to, named_properties) =
        (from.to_string(), to.to_string(), properties.clone());
    let guard: types::Guard<'static> = Box::new(move |unit, taking| {
        let now_ms = unit.instant.ms();
        if parsed.expires_at_ms <= now_ms {
            return Ok(false);
        }
        confirm::sweep(unit.tx(), unit.instant)?;
        if confirm::spent(unit.tx(), &parsed.signature)?.is_some() {
            return Ok(false);
        }
        let digest = covered(
            &named_from,
            &named_to,
            named_properties.as_ref(),
            (taking.ids, taking.settings, taking.subtypes),
        );
        let subject = subject(&digest);
        if signer.check(TOOL, &credential, &subject, &token, now_ms)? != Check::Valid {
            return Ok(false);
        }
        let total = i64::try_from(taking.ids.len()).unwrap_or(i64::MAX);
        confirm::spend(unit.tx(), &parsed, &credential, &subject, total)?;
        Ok(true)
    });
    let asked = Move {
        to: to.to_string(),
        properties,
        dry_run: false,
    };
    Ok(
        match types::start_guarded(app, caller, from.to_string(), asked, guard).await? {
            Some(job) => Confirmed::Started(job),
            None => Confirmed::Stale,
        },
    )
}

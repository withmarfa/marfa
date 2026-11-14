//! A confirmation binds a webhook's making or change to where it would post and what it would send.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use url::Url;

use super::confirm::{self, Check, Token};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::refusal::{Refusal, Result};
use crate::app::webhooks::{self, Create, Subscription, Update};

pub const TOOL: &str = "marfa_manage_webhook";

/// A making, or a change to where a webhook posts or what it sends.
pub enum Request {
    Make(Create),
    Change { id: String, update: Update },
}

impl Request {
    pub fn make(body: &Map<String, Value>) -> Result<Request> {
        Create::from_body(body).map(Request::Make)
    }

    pub fn change(id: String, body: &Map<String, Value>) -> Result<Request> {
        Update::from_body(body).map(|update| Request::Change { id, update })
    }

    fn address(&self) -> Option<&webhooks::Address> {
        match self {
            Request::Make(create) => Some(&create.url),
            Request::Change { update, .. } => update.url.as_ref(),
        }
    }

    fn action(&self) -> &'static str {
        match self {
            Request::Make(_) => "webhook.create",
            Request::Change { .. } => "webhook.update",
        }
    }
}

/// What the webhook would be after the request: what a preview shows and a token covers.
pub struct Plan {
    pub id: Option<String>,
    pub url: String,
    pub host: String,
    pub events: Vec<String>,
    pub type_filter: Option<String>,
    pub active: bool,
}

fn host_of(url: &str) -> Result<String> {
    let parsed = Url::parse(url).map_err(|_| Refusal::internal("a webhook's URL did not read"))?;
    let host = parsed.host_str().unwrap_or_default();
    Ok(match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

impl Plan {
    fn of(request: &Request, existing: Option<&Subscription>) -> Result<Plan> {
        let (id, mut url, mut events, mut type_filter, mut active) = match existing {
            Some(held) => (
                Some(held.id.clone()),
                held.url.clone(),
                held.events.clone(),
                held.type_filter.clone(),
                held.active,
            ),
            None => (None, String::new(), Vec::new(), None, true),
        };
        match request {
            Request::Make(create) => {
                url = create.url.text.clone();
                events = create.events.clone();
                type_filter = create.type_filter.clone();
            }
            Request::Change { update, .. } => {
                if let Some(address) = &update.url {
                    url = address.text.clone();
                }
                if let Some(named) = &update.events {
                    events = named.clone();
                }
                if let Some(filter) = &update.type_filter {
                    type_filter = filter.clone();
                }
                if let Some(state) = update.active {
                    active = state;
                }
            }
        }
        let host = host_of(&url)?;
        Ok(Plan {
            id,
            url,
            host,
            events,
            type_filter,
            active,
        })
    }

    /// The same events in any order are one plan.
    fn digest(&self) -> String {
        let mut events = self.events.clone();
        events.sort_unstable();
        hex::encode(Sha256::digest(
            json!([self.id, self.url, events, self.type_filter, self.active])
                .to_string()
                .as_bytes(),
        ))
    }

    /// `covered` is what the token stops at: the webhook to change, or the count of the credential's makings and deletions.
    fn subject(&self, covered: &str) -> String {
        confirm::subject_digest(&[covered.to_string()], &self.digest())
    }
}

/// The plan and the ids it covers, on the state `tx` sees.
fn planned(
    tx: &rusqlite::Transaction<'_>,
    caller: &Caller,
    request: &Request,
) -> Result<(Plan, String)> {
    match request {
        Request::Make(_) => {
            let plan = Plan::of(request, None)?;
            let subject = plan.subject(&webhooks::turns_of(tx, caller)?.to_string());
            Ok((plan, subject))
        }
        Request::Change { id, .. } => {
            let existing = webhooks::made_by(tx, caller, id)?;
            let plan = Plan::of(request, Some(&existing))?;
            let subject = plan.subject(id);
            Ok((plan, subject))
        }
    }
}

pub struct Previewed {
    pub plan: Plan,
    pub token: Token,
}

/// The address is judged here and again at the commit.
pub async fn preview(app: &App, caller: &Caller, request: Request) -> Result<Previewed> {
    let maker = caller.webhook_maker()?;
    if let Some(address) = request.address() {
        webhooks::check_address(app, &maker, address).await?;
    }
    let reader = caller.clone();
    let (plan, subject) = app
        .db
        .read(move |tx| planned(tx, &reader, &request))
        .await?;
    let token = app.mcp.signer.issue(
        TOOL,
        &caller.credential_handle(),
        &subject,
        app.clock.now_ms(),
    )?;
    Ok(Previewed { plan, token })
}

pub enum Confirmed {
    Made(Subscription),
    Changed(Subscription),
    /// The token is not this credential's for the webhook as it is now, or was spent.
    Stale,
}

/// The token's expiry, signature and spend are judged, and the webhooks read again, in the write that commits.
pub async fn confirmed(
    app: &Arc<App>,
    caller: &Caller,
    request: Request,
    token: &str,
) -> Result<Confirmed> {
    let maker = caller.webhook_maker()?;
    if let Some(address) = request.address() {
        webhooks::check_address(app, &maker, address).await?;
    }
    let Some(parsed) = confirm::parse(token) else {
        return Ok(Confirmed::Stale);
    };
    let credential = caller.credential_handle();
    let signer = app.mcp.signer.clone();
    let cache = app.catalog_handle();
    let token = token.to_string();
    let action = request.action();
    app.write(caller, action, move |unit| {
        unit.caller.webhook_maker()?;
        let now_ms = unit.instant.ms();
        if parsed.expires_at_ms <= now_ms {
            return Ok(Confirmed::Stale);
        }
        confirm::sweep(unit.tx(), unit.instant)?;
        if confirm::spent(unit.tx(), &parsed.signature)?.is_some() {
            return Ok(Confirmed::Stale);
        }
        let (_, subject) = planned(unit.tx(), &unit.caller, &request)?;
        if signer.check(TOOL, &credential, &subject, &token, now_ms)? != Check::Valid {
            return Ok(Confirmed::Stale);
        }
        confirm::spend(unit.tx(), &parsed, &credential, &subject, 1)?;
        Ok(match request {
            Request::Make(create) => Confirmed::Made(webhooks::insert_new(unit, create)?),
            Request::Change { id, update } => {
                Confirmed::Changed(webhooks::apply_update(unit, &cache, id, update)?)
            }
        })
    })
    .await
}

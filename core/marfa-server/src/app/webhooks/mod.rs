//! Credential-owned subscriptions and outbound deliveries.

mod request;
mod schedule;
mod send;
mod sender;
mod store;

use std::sync::Arc;

use marfa_rules::catalog::Catalog as Rules;
use rusqlite::Transaction;
use serde_json::{Map, Value, json};

use super::access::{Caller, Maker, standing_maker};
use super::catalog;
use super::events::fanout;
use super::housekeeping::{self, DAY_MS};
use super::outbound::{self, Reach};
use super::refusal::{Code, Refusal, Result};
use super::{App, keys, oauth};
use crate::settings::registry::AUDIT_RETENTION_DAYS;
use request::invalid;
use store::{Delivery, Status, Subscription};

pub use request::{CREATE_FIELDS, Create, UPDATE_FIELDS, Update};
pub use sender::{Webhooks, start};

const CANCEL_URL: &str = "The subscription was pointed at another URL.";
const CANCEL_TURNED_OFF: &str = "The subscription was turned off.";
const CANCEL_UNSELECTED: &str =
    "The subscription's events or type filter no longer select this event.";
const CANCEL_UNREAD: &str = "The credential the subscription belongs to may not read this event.";
const CANCEL_CREDENTIAL: &str = "The credential the subscription belongs to no longer stands or no longer holds webhooks.manage.";
const CANCEL_UNREADABLE: &str = "The event could not be read, so it was not sent.";

const SECRET_BYTES: usize = 32;
const CURSOR_SCOPE: &str = "webhook-deliveries";

/// Whether a subscription's events and type filter select an event; a filter holds only item events.
fn selects(subscription: &Subscription, rules: &Rules, event_type: &str, type_id: &str) -> bool {
    subscription.events.iter().any(|name| name == event_type)
        && (event_type.starts_with("edge.")
            || subscription
                .type_filter
                .as_deref()
                .is_none_or(|filter| rules.matches(filter, type_id)))
}

/// Log expiry cannot pass this position; `None` prevents expiry.
pub fn scheduled_through(tx: &Transaction<'_>) -> Result<Option<i64>> {
    store::position(tx)
}

/// An app's subscriptions belong to its grant, and go with it.
pub fn forget_grant(tx: &Transaction<'_>, grant_id: &str) -> Result<()> {
    store::delete_for_grant(tx, grant_id)?;
    Ok(())
}

/// Settled deliveries created before `before`; a pending one is kept whatever its age.
pub fn expire_deliveries(tx: &Transaction<'_>, before: &str, limit: i64) -> Result<i64> {
    store::expire(tx, before, limit)
}

fn not_found() -> Refusal {
    Refusal::new(
        Code::WebhookNotFound,
        "No webhook you can reach has this ID.",
    )
}

/// An inconclusive registration lookup leaves the decision to the send attempt.
async fn check_address(app: &App, address: &request::Address) -> Result<()> {
    if app.settings.start.webhook_private_addresses {
        return Ok(());
    }
    match outbound::reach(&app.faults, &address.url, false).await {
        Reach::NotPublic => Err(invalid(
            "url",
            "url names a host that is not a public address. An instance whose receivers are on a \
             private network allows them with MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES=true.",
        )),
        Reach::Targets(_) | Reach::Unresolved => Ok(()),
    }
}

fn generated_secret() -> Result<String> {
    let mut bytes = [0u8; SECRET_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| Refusal::internal("no randomness was available"))?;
    Ok(hex::encode(bytes))
}

fn redacted(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    let last = chars.len().saturating_sub(4);
    let tail: String = chars.get(last..).unwrap_or_default().iter().collect();
    format!("****{tail}")
}

fn answer(subscription: &Subscription, secret_shown: bool) -> Map<String, Value> {
    let secret = if secret_shown {
        subscription.secret.clone()
    } else {
        redacted(&subscription.secret)
    };
    let Value::Object(answer) = json!({
        "id": subscription.id,
        "url": subscription.url,
        "events": subscription.events,
        "type_filter": subscription.type_filter,
        "secret": secret,
        "active": subscription.active,
        "created_at": subscription.created_at,
        "updated_at": subscription.updated_at,
    }) else {
        return Map::new();
    };
    answer
}

fn usable_name(name: Option<String>) -> Option<String> {
    name.map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

fn maker_of(tx: &Transaction<'_>, maker: &Maker) -> Result<Value> {
    Ok(match maker {
        Maker::Key(id) => json!({
            "kind": "key",
            "id": id,
            "name": keys::label(tx, id)?.map(|label| usable_name(Some(label)).unwrap_or_else(|| id.clone())),
        }),
        Maker::Grant(grant_id) => match oauth::grant_client(tx, grant_id)? {
            Some((client_id, name)) => json!({
                "kind": "app",
                "id": client_id,
                "name": usable_name(name),
            }),
            None => json!({ "kind": "app", "id": grant_id, "name": null }),
        },
    })
}

fn read_answer(tx: &Transaction<'_>, subscription: &Subscription) -> Result<Value> {
    let mut answer = answer(subscription, false);
    answer.insert("maker".into(), maker_of(tx, &subscription.maker)?);
    Ok(Value::Object(answer))
}

pub async fn create(app: &App, caller: &Caller, request: Create) -> Result<Value> {
    caller.webhook_maker()?;
    check_address(app, &request.url).await?;
    let secret = match request.secret {
        Some(secret) => secret,
        None => generated_secret()?,
    };
    let id = uuid::Uuid::now_v7().to_string();
    let url = request.url.text;
    let events = request.events;
    let type_filter = request.type_filter;
    let subscription = app
        .write(caller, "webhook.create", move |unit| {
            let maker = unit.caller.webhook_maker()?;
            let tx = unit.tx();
            let subscription = Subscription {
                id,
                url,
                events,
                type_filter,
                secret,
                active: true,
                maker,
                starts_after: fanout::newest(tx)?,
                created_at: unit.at.clone(),
                updated_at: unit.at.clone(),
            };
            store::insert(tx, &subscription)?;
            unit.audit("webhook", &subscription.id, None)?;
            Ok(subscription)
        })
        .await?;
    Ok(Value::Object(answer(&subscription, true)))
}

pub async fn list(app: &App, caller: &Caller) -> Result<Value> {
    let reach = caller.webhook_reach()?;
    app.db
        .read(move |tx| {
            let data = store::list(tx, reach.as_ref())?
                .iter()
                .map(|subscription| read_answer(tx, subscription))
                .collect::<Result<Vec<_>>>()?;
            Ok(json!({ "data": data, "next_cursor": null }))
        })
        .await
}

pub async fn get(app: &App, caller: &Caller, id: String) -> Result<Value> {
    let reach = caller.webhook_reach()?;
    app.db
        .read(move |tx| {
            let subscription = store::by_id(tx, &id, reach.as_ref())?.ok_or_else(not_found)?;
            read_answer(tx, &subscription)
        })
        .await
}

pub async fn update(app: &App, caller: &Caller, id: String, request: Update) -> Result<Value> {
    caller.webhook_maker()?;
    if let Some(address) = &request.url {
        check_address(app, address).await?;
    }
    let fields: Vec<&'static str> = [
        ("url", request.url.is_some()),
        ("events", request.events.is_some()),
        ("type_filter", request.type_filter.is_some()),
        ("active", request.active.is_some()),
    ]
    .into_iter()
    .filter_map(|(field, named)| named.then_some(field))
    .collect();
    let cache = app.catalog_handle();
    let subscription = app
        .write(caller, "webhook.update", move |unit| {
            let maker = unit.caller.webhook_maker()?;
            let tx = unit.tx();
            let existing = store::by_id(tx, &id, Some(&maker))?.ok_or_else(not_found)?;
            let mut next = existing.clone();
            if let Some(address) = request.url {
                next.url = address.text;
            }
            if let Some(events) = request.events {
                next.events = events;
            }
            if let Some(type_filter) = request.type_filter {
                next.type_filter = type_filter;
            }
            if let Some(active) = request.active {
                next.active = active;
            }
            next.updated_at = unit.at.clone();
            store::update(tx, &next)?;
            if next.url != existing.url {
                store::cancel_all(tx, &id, CANCEL_URL, &unit.at)?;
            } else if !next.active {
                store::cancel_all(tx, &id, CANCEL_TURNED_OFF, &unit.at)?;
            } else if next.events != existing.events || next.type_filter != existing.type_filter {
                let catalog = catalog::current(&cache, tx, catalog::Snapshot::Committed)?;
                for delivery in store::pending_of(tx, &id)? {
                    if !selects(
                        &next,
                        &catalog.rules,
                        &delivery.event_type,
                        &delivery.type_id,
                    ) {
                        store::cancel(tx, delivery.seq, CANCEL_UNSELECTED, &unit.at)?;
                    }
                }
            }
            unit.audit("webhook", &id, Some(json!({ "fields": fields })))?;
            Ok(next)
        })
        .await?;
    Ok(Value::Object(answer(&subscription, false)))
}

pub async fn delete(app: &App, caller: &Caller, id: String) -> Result<()> {
    caller.webhook_maker()?;
    app.write(caller, "webhook.delete", move |unit| {
        let maker = unit.caller.webhook_maker()?;
        let tx = unit.tx();
        store::by_id(tx, &id, Some(&maker))?.ok_or_else(not_found)?;
        store::delete(tx, &id)?;
        unit.audit("webhook", &id, None)
    })
    .await
}

fn delivery_answer(delivery: &Delivery) -> Value {
    json!({
        "id": delivery.id,
        "status": delivery.status.wire(),
        "webhook_id": delivery.webhook_id,
        "event_type": delivery.event_type,
        "status_code": delivery.status_code,
        "attempt": delivery.attempt,
        "succeeded": delivery.status == Status::Success,
        "error": delivery.error,
        "created_at": delivery.created_at,
    })
}

pub async fn deliveries(
    app: &App,
    caller: &Caller,
    id: String,
    limit: i64,
    cursor: Option<&str>,
) -> Result<Value> {
    let reach = caller.webhook_reach()?;
    let scope = format!("{CURSOR_SCOPE}:{id}");
    let before = match cursor {
        Some(cursor) => Some(
            app.cursor_secret
                .open(&scope, cursor)?
                .get("before")
                .and_then(Value::as_i64)
                .ok_or_else(|| invalid("cursor", "cursor is not one this list gave."))?,
        ),
        None => None,
    };
    let (rows, more) = app
        .db
        .read(move |tx| {
            store::by_id(tx, &id, reach.as_ref())?.ok_or_else(not_found)?;
            let mut rows = store::page(tx, &id, before, limit.saturating_add(1))?;
            let more = rows.len() > usize::try_from(limit).unwrap_or(usize::MAX);
            rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
            Ok((rows, more))
        })
        .await?;
    let next_cursor = match rows.last() {
        Some(last) if more => Some(
            app.cursor_secret
                .issue(&scope, &json!({ "before": last.seq }))?,
        ),
        _ => None,
    };
    let data: Vec<Value> = rows.iter().map(delivery_answer).collect();
    Ok(json!({ "data": data, "next_cursor": next_cursor }))
}

fn redelivery_refused(reason: &'static str, message: &'static str) -> Refusal {
    Refusal::new(Code::Conflict, message).with_detail("reason", reason)
}

pub async fn redeliver(
    app: &Arc<App>,
    caller: &Caller,
    id: String,
    delivery_id: String,
) -> Result<Value> {
    caller.webhook_reach()?;
    let cutoff = housekeeping::cutoff(app, AUDIT_RETENTION_DAYS, DAY_MS);
    let clock = app.clock.clone();
    app.write(caller, "webhook.delivery.redeliver", move |unit| {
        let reach = unit.caller.webhook_reach()?;
        let tx = unit.tx();
        let subscription = store::by_id(tx, &id, reach.as_ref())?.ok_or_else(not_found)?;
        let delivery = store::delivery(tx, &id, &delivery_id)?.ok_or_else(not_found)?;
        if !subscription.active {
            return Err(redelivery_refused(
                "webhook_inactive",
                "The webhook is turned off. Turn it on, then redeliver.",
            ));
        }
        if standing_maker(tx, &subscription.maker, &unit.at)?.is_none() {
            return Err(redelivery_refused(
                "credential_unavailable",
                "The key or app that registered this webhook has been revoked, has expired or no \
                 longer has webhooks.manage, so Marfa sends it nothing.",
            ));
        }
        if delivery.status != Status::DeadLetter {
            return Err(redelivery_refused(
                "delivery_not_failed",
                "Only a delivery Marfa gave up on, with status dead_letter, can be redelivered.",
            ));
        }
        if cutoff.as_deref().is_some_and(|cutoff| delivery.created_at.as_str() < cutoff) {
            return Err(redelivery_refused(
                "delivery_expired",
                "The delivery is older than the instance's audit retention, so it can't be redelivered.",
            ));
        }
        store::redeliver(tx, delivery.seq, clock.now_ms(), &unit.at)?;
        unit.audit("webhook_delivery", &delivery.id, Some(json!({ "webhook_id": id })))?;
        let reopened = store::delivery(tx, &id, &delivery_id)?.ok_or_else(not_found)?;
        Ok(delivery_answer(&reopened))
    })
    .await
}

/// The subscriptions an archive carries for a caller: every one for the owner and the local
/// command, and a key's or an app's own otherwise.
pub fn archived(
    tx: &rusqlite::Transaction<'_>,
    caller: &super::access::Caller,
) -> super::refusal::Result<Vec<store::Subscription>> {
    use super::access::{Caller, Permission};
    let reach = match caller {
        Caller::Local(_) | Caller::Owner(_) | Caller::Server => None,
        _ if !caller.holds(Permission::WebhooksManage) => return Ok(Vec::new()),
        _ => Some(caller.webhook_maker()?),
    };
    store::list(tx, reach.as_ref())
}

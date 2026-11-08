//! Registrations belong to keys; state and agreements belong to sources.

pub mod read_only;
mod request;
mod store;

use std::collections::HashSet;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::Transaction;
use rusqlite::types::Value as Stored;
use serde_json::{Map, Value, json};

use super::App;
use super::access::Caller;
use super::faults::HOLD_CONNECTOR_WRITE;
use super::items;
use super::query::{Position, bad_cursor};
use super::refusal::{Code, Refusal, Result};
pub use read_only::{ReadOnly, Registry};
pub use request::{Batch, Lookup, Register, Replace, Run, Take, released};
use store::Registration;

const RUNS_KEPT: usize = 100;

fn not_found() -> Refusal {
    Refusal::new(Code::ConnectorNotFound, "Connector not found")
}

fn held(expires_at: Option<&str>) -> Refusal {
    let refusal = Refusal::new(
        Code::ConnectorHeld,
        "Another process holds this connector, or this one does not.",
    );
    match expires_at {
        Some(expires_at) => refusal.with_detail("expires_at", expires_at),
        None => refusal,
    }
}

fn find(tx: &Transaction<'_>, id: &str) -> Result<Registration> {
    store::by_id(tx, id)?.ok_or_else(not_found)
}

fn after(at: &str, window: Duration) -> Result<String> {
    let start = DateTime::parse_from_rfc3339(at)
        .map_err(|_| Refusal::internal("the clock did not read"))?
        .with_timezone(&Utc);
    let wait =
        chrono::Duration::milliseconds(i64::try_from(window.as_millis()).unwrap_or(i64::MAX));
    Ok((start + wait).to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn run_json(run: &store::Run) -> Value {
    json!({
        "id": run.id,
        "connector_id": run.connector_id,
        "outcome": run.outcome,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "summary": run.summary,
        "error": run.error,
        "reported_at": run.reported_at,
    })
}

fn registration_json(tx: &Transaction<'_>, registration: &Registration, at: &str) -> Result<Value> {
    let last_run = store::last_run(tx, &registration.id)?.map(|run| run_json(&run));
    let hold = match store::hold(tx, &registration.id)? {
        Some(hold) if hold.stands_at(at)? => Some(hold.expires_at),
        _ => None,
    };
    Ok(json!({
        "id": registration.id,
        "key_id": registration.key_id,
        "source": registration.source,
        "name": registration.name,
        "description": registration.description,
        "registered_at": registration.registered_at,
        "updated_at": registration.updated_at,
        "last_heartbeat_at": registration.last_heartbeat_at,
        "read_only_types": registration.read_only_types,
        "last_run": last_run,
        "hold_expires_at": hold,
        "problems": store::problems(tx, &registration.source)?,
    }))
}

async fn reading<T, F>(app: &App, caller: &Caller, job: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&Transaction<'_>, &Caller, &str) -> Result<T> + Send + 'static,
{
    let caller = caller.clone();
    let clock = app.clock.clone();
    app.db
        .read(move |tx| {
            let at = clock.stamp();
            let caller = caller.current(tx, &at)?;
            job(tx, &caller, &at)
        })
        .await
}

/// Whether the registration was created or already stood.
pub async fn register(app: &App, caller: &Caller, request: Register) -> Result<(bool, Value)> {
    app.write(caller, "connector.register", move |unit| {
        unit.caller.require_registering_key()?;
        let key = unit
            .caller
            .key()
            .ok_or_else(|| Refusal::internal("a registering caller holds no key"))?;
        let tx = unit.tx();
        let description = request.description.as_deref();
        let (id, created) = match store::by_key(tx, &key.id)? {
            Some(standing) => {
                store::replace(
                    tx,
                    &standing.id,
                    &request.name,
                    description,
                    &request.read_only_types,
                    &unit.at,
                )?;
                (standing.id, false)
            }
            None => {
                let id = uuid::Uuid::now_v7().to_string();
                store::insert(
                    tx,
                    &store::Fresh {
                        id: &id,
                        key_id: &key.id,
                        source: &key.source,
                        name: &request.name,
                        description,
                        declared: &request.read_only_types,
                        at: &unit.at,
                    },
                )?;
                (id, true)
            }
        };
        unit.audit(
            "connector",
            &id,
            Some(json!({ "name": request.name, "created": created })),
        )?;
        let registration = find(tx, &id)?;
        Ok((created, registration_json(tx, &registration, &unit.at)?))
    })
    .await
}

pub async fn list(app: &App, caller: &Caller) -> Result<Value> {
    reading(app, caller, |tx, caller, at| {
        let mut data = Vec::new();
        for registration in store::newest_first(tx)? {
            if caller.sees_connector(&registration.key_id) {
                data.push(registration_json(tx, &registration, at)?);
            }
        }
        Ok(json!({ "data": data, "next_cursor": null }))
    })
    .await
}

pub async fn read(app: &App, caller: &Caller, id: String) -> Result<Value> {
    reading(app, caller, move |tx, caller, at| {
        let registration = find(tx, &id)?;
        if !caller.sees_connector(&registration.key_id) {
            return Err(not_found());
        }
        registration_json(tx, &registration, at)
    })
    .await
}

pub async fn remove(app: &App, caller: &Caller, id: String) -> Result<()> {
    app.write(caller, "connector.delete", move |unit| {
        let registration = find(unit.tx(), &id)?;
        unit.caller
            .require_connector_key_or_manager(&registration.key_id)?;
        store::delete(unit.tx(), &id)?;
        unit.audit("connector", &id, Some(json!({ "name": registration.name })))
    })
    .await
}

pub async fn heartbeat(app: &App, caller: &Caller, id: String) -> Result<Value> {
    app.write(caller, "connector.heartbeat", move |unit| {
        let registration = find(unit.tx(), &id)?;
        unit.caller
            .require_own_connector_key(&registration.key_id)?;
        store::heartbeat(unit.tx(), &id, &unit.at)?;
        Ok(json!({ "last_heartbeat_at": unit.at }))
    })
    .await
}

pub async fn report_run(app: &App, caller: &Caller, id: String, run: Run) -> Result<Value> {
    app.write(caller, "connector.run", move |unit| {
        let registration = find(unit.tx(), &id)?;
        unit.caller
            .require_own_connector_key(&registration.key_id)?;
        let (started_at, finished_at) = run.checked()?;
        let report = store::Run {
            seq: 0,
            id: uuid::Uuid::now_v7().to_string(),
            connector_id: id,
            outcome: if run.succeeded { "succeeded" } else { "failed" }.to_string(),
            started_at,
            finished_at,
            summary: run.summary,
            error: run.error,
            reported_at: unit.at.clone(),
        };
        store::insert_run(unit.tx(), RUNS_KEPT, &report)?;
        Ok(run_json(&report))
    })
    .await
}

/// Where a listing of runs or agreements continues from, read before anything is looked up.
pub struct Window {
    scope: String,
    limit: i64,
    after: Option<(String, String)>,
}

impl Window {
    pub fn open(app: &App, scope: String, limit: i64, cursor: Option<&str>) -> Result<Window> {
        let after = cursor
            .map(|cursor| {
                let payload = app.cursor_secret.open(&scope, cursor)?;
                let position = Position::from_payload(&payload, 1)?;
                match position.keys.as_slice() {
                    [Stored::Text(key)] => Ok((key.clone(), position.id)),
                    _ => Err(bad_cursor()),
                }
            })
            .transpose()?;
        Ok(Window {
            scope,
            limit,
            after,
        })
    }

    fn next(&self, secret: &super::query::Secret, key: &str, id: &str) -> Result<String> {
        let position = Position {
            keys: vec![Stored::Text(key.to_string())],
            id: id.to_string(),
        };
        secret.issue(&self.scope, &position.payload())
    }
}

pub async fn runs(app: &App, caller: &Caller, id: String, window: Window) -> Result<Value> {
    let secret = app.cursor_secret.clone();
    reading(app, caller, move |tx, caller, _| {
        let registration = find(tx, &id)?;
        if !caller.sees_connector(&registration.key_id) {
            return Err(not_found());
        }
        let after = match &window.after {
            Some((reported, seq)) => Some((
                reported.as_str(),
                seq.parse::<i64>().map_err(|_| bad_cursor())?,
            )),
            None => None,
        };
        let mut page = store::runs_page(tx, &id, after, window.limit + 1)?;
        let more = page.len() as i64 > window.limit;
        page.truncate(usize::try_from(window.limit).unwrap_or(usize::MAX));
        let next = match page.last().filter(|_| more) {
            Some(last) => Some(window.next(&secret, &last.reported_at, &last.seq.to_string())?),
            None => None,
        };
        let data: Vec<Value> = page.iter().map(run_json).collect();
        Ok(json!({ "data": data, "next_cursor": next }))
    })
    .await
}

fn document_json(held: Option<store::Document>) -> Value {
    match held {
        Some(held) => json!({
            "problems": held.problems,
            "state": held.state,
            "updated_at": held.updated_at,
        }),
        None => json!({ "problems": {}, "state": {}, "updated_at": null }),
    }
}

pub async fn state(app: &App, caller: &Caller, id: String) -> Result<Value> {
    reading(app, caller, move |tx, caller, _| {
        let registration = find(tx, &id)?;
        caller.require_own_connector_key(&registration.key_id)?;
        let held = store::document(tx, &registration.source)?;
        Ok(document_json(held))
    })
    .await
}

fn fence(tx: &Transaction<'_>, id: &str, process: &str, at: &str) -> Result<()> {
    match store::hold(tx, id)? {
        Some(hold) if hold.stands_at(at)? => {
            if hold.process == process {
                Ok(())
            } else {
                Err(held(Some(&hold.expires_at)))
            }
        }
        _ => Err(held(None)),
    }
}

fn printed(object: &Map<String, Value>) -> Result<String> {
    serde_json::to_string(object).map_err(|_| Refusal::internal("a document did not print"))
}

pub async fn replace_state(
    app: &App,
    caller: &Caller,
    id: String,
    request: Replace,
) -> Result<Value> {
    app.faults.hold(HOLD_CONNECTOR_WRITE, None).await;
    app.write(caller, "connector.state.write", move |unit| {
        let tx = unit.tx();
        let registration = find(tx, &id)?;
        unit.caller
            .require_own_connector_key(&registration.key_id)?;
        request.checked()?;
        fence(tx, &id, &request.process, &unit.at)?;
        let problems = match request.problems {
            Some(problems) => problems,
            None => store::problems(tx, &registration.source)?,
        };
        store::put_document(
            tx,
            &registration.source,
            &printed(&request.state)?,
            &printed(&problems)?,
            &unit.at,
        )?;
        Ok(json!({
            "problems": problems,
            "state": request.state,
            "updated_at": unit.at,
        }))
    })
    .await
}

pub async fn clear_state(app: &App, caller: &Caller, id: String) -> Result<()> {
    app.write(caller, "connector_state.delete", move |unit| {
        let tx = unit.tx();
        let registration = find(tx, &id)?;
        unit.caller
            .require_connector_key_or_manager(&registration.key_id)?;
        let state = store::clear_document(tx, &registration.source)?;
        let agreements = store::clear_agreements(tx, &registration.source)?;
        unit.audit(
            "connector",
            &id,
            Some(json!({
                "source": registration.source,
                "state": state,
                "agreements": agreements,
            })),
        )
    })
    .await
}

pub async fn take_hold(app: &App, caller: &Caller, id: String, request: Take) -> Result<Value> {
    let window = app.settings.start.connector_hold;
    app.write(caller, "connector.hold", move |unit| {
        let tx = unit.tx();
        let registration = find(tx, &id)?;
        unit.caller
            .require_own_connector_key(&registration.key_id)?;
        request.checked()?;
        let live = match store::hold(tx, &id)? {
            Some(hold) if hold.stands_at(&unit.at)? => Some(hold),
            _ => None,
        };
        if let Some(other) = live.as_ref().filter(|hold| hold.process != request.process) {
            return Err(held(Some(&other.expires_at)));
        }
        let expires_at = after(&unit.at, window)?;
        store::put_hold(tx, &id, &request.process, &expires_at)?;
        Ok(json!({
            "expires_at": expires_at,
            "ttl_ms": window.as_millis() as u64,
            "renewed": live.is_some(),
        }))
    })
    .await
}

pub async fn release_hold(app: &App, caller: &Caller, id: String, process: String) -> Result<()> {
    app.write(caller, "connector.release", move |unit| {
        let registration = find(unit.tx(), &id)?;
        unit.caller
            .require_own_connector_key(&registration.key_id)?;
        store::drop_hold(unit.tx(), &id, &process)
    })
    .await
}

fn agreement_json(agreement: &store::Agreement) -> Value {
    json!({
        "item_id": agreement.item_id,
        "waiting": agreement.waiting,
        "record": agreement.record,
        "updated_at": agreement.updated_at,
    })
}

/// The type of a stored row, when the caller reads it.
fn readable_type(tx: &Transaction<'_>, caller: &Caller, item_id: &str) -> Result<Option<String>> {
    Ok(items::type_of(tx, item_id)?.filter(|type_id| caller.may_read_type(type_id)))
}

pub async fn write_agreements(
    app: &App,
    caller: &Caller,
    id: String,
    request: Batch,
) -> Result<Value> {
    app.faults.hold(HOLD_CONNECTOR_WRITE, None).await;
    app.write(caller, "connector.agreements.write", move |unit| {
        let tx = unit.tx();
        let registration = find(tx, &id)?;
        unit.caller
            .require_own_connector_key(&registration.key_id)?;
        request.checked()?;
        fence(tx, &id, &request.process, &unit.at)?;
        let (mut written, mut cleared) = (0, 0);
        let (mut skipped_set, mut skipped_clear) = (Vec::new(), Vec::new());
        for row in &request.set {
            if readable_type(tx, &unit.caller, &row.item_id)?.is_none() {
                skipped_set.push(row.item_id.clone());
                continue;
            }
            store::put_agreement(
                tx,
                &registration.source,
                &row.item_id,
                row.waiting,
                &printed(&row.record)?,
                &unit.at,
            )?;
            written += 1;
        }
        for item_id in &request.clear {
            if readable_type(tx, &unit.caller, item_id)?.is_none() {
                skipped_clear.push(item_id.clone());
                continue;
            }
            cleared += store::drop_agreement(tx, &registration.source, item_id)?;
        }
        skipped_set.extend(skipped_clear);
        Ok(json!({ "written": written, "cleared": cleared, "skipped": skipped_set }))
    })
    .await
}

pub async fn lookup_agreements(
    app: &App,
    caller: &Caller,
    id: String,
    request: Lookup,
) -> Result<Value> {
    reading(app, caller, move |tx, caller, _| {
        let registration = find(tx, &id)?;
        caller.require_own_connector_key(&registration.key_id)?;
        request.checked()?;
        let mut named = HashSet::new();
        let mut data = Vec::new();
        for item_id in request
            .item_ids
            .iter()
            .filter(|id| named.insert(id.as_str()))
        {
            if readable_type(tx, caller, item_id)?.is_none() {
                continue;
            }
            if let Some(agreement) = store::agreement_of(tx, &registration.source, item_id)? {
                data.push(agreement_json(&agreement));
            }
        }
        Ok(json!({ "data": data }))
    })
    .await
}

pub async fn list_agreements(
    app: &App,
    caller: &Caller,
    id: String,
    waiting: Option<bool>,
    window: Window,
) -> Result<Value> {
    let secret = app.cursor_secret.clone();
    reading(app, caller, move |tx, caller, _| {
        let registration = find(tx, &id)?;
        caller.require_own_connector_key(&registration.key_id)?;
        let after = window
            .after
            .as_ref()
            .map(|(updated, item)| (updated.as_str(), item.as_str()));
        let mut page =
            store::agreements_page(tx, &registration.source, waiting, after, window.limit + 1)?;
        let more = page.len() as i64 > window.limit;
        page.truncate(usize::try_from(window.limit).unwrap_or(usize::MAX));
        let next = match page.last().filter(|_| more) {
            Some(last) => Some(window.next(&secret, &last.updated_at, &last.item_id)?),
            None => None,
        };
        let mut data = Vec::new();
        for agreement in &page {
            if readable_type(tx, caller, &agreement.item_id)?.is_some() {
                data.push(agreement_json(agreement));
            }
        }
        Ok(json!({ "data": data, "next_cursor": next }))
    })
    .await
}

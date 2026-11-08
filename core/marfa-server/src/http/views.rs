//! `/views`, the only door that writes a `system.view`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};
use serde_json::{Map, Value};

use super::answer::{Answer, text_answer};
use super::body::{Bag, ReadBody};
use super::items::{Named, Sent, check_item_id, keyed, version_of};
use super::listing::{Params, whole_limit};
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::write::{self, Change, ViewChange};
use crate::app::query::{ViewPage, view_items};
use crate::app::refusal::{Refusal, Result};
use crate::app::types::missing_field;
use crate::app::views::{SETTINGS, refuse_null, undeclared};

const VIEW_PAGE: i64 = 50;
const MAX_VIEW_PAGE: i64 = 200;

fn declared(body: &ReadBody, allowed: &[&str]) -> Result<Map<String, Value>> {
    let sent = body.object(Bag::Properties)?;
    let unknown = undeclared(&sent, allowed);
    if unknown.is_empty() {
        return Ok(sent);
    }
    Err(Refusal::validation(format!(
        "The body names fields this operation does not take: {}.",
        unknown.join(", ")
    ))
    .with_detail("unknown_body_fields", unknown))
}

fn creating(body: &ReadBody) -> Result<ViewChange> {
    let settings = declared(body, &SETTINGS)?;
    refuse_null(&settings)?;
    if !settings.contains_key("title") {
        return Err(missing_field("title"));
    }
    Ok(ViewChange::Create { settings })
}

fn updating(id: String, body: &ReadBody) -> Result<ViewChange> {
    let mut allowed = SETTINGS.to_vec();
    allowed.push("version");
    let mut settings = declared(body, &allowed)?;
    if !settings.contains_key("version") {
        return Err(missing_field("version"));
    }
    let version = version_of(&settings)?.unwrap_or_default();
    settings.remove("version");
    let clear = if settings.get("group").is_some_and(Value::is_null) {
        settings.remove("group");
        vec!["group".to_string()]
    } else {
        Vec::new()
    };
    refuse_null(&settings)?;
    if settings.is_empty() && clear.is_empty() {
        return Err(Refusal::validation("Name at least one setting to change."));
    }
    Ok(ViewChange::Update {
        id,
        settings,
        clear,
        version,
    })
}

pub async fn create(State(app): State<Arc<App>>, caller: Caller, sent: Sent) -> Answer {
    caller.require_view_write()?;
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, body| async move {
        query::only(&uri, &[])?;
        let change = creating(&body)?;
        write::run(&door, &who, claim, Change::View(change)).await
    })
    .await
}

pub async fn update(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    sent: Sent,
) -> Answer {
    caller.require_view_write()?;
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, body| async move {
        query::only(&uri, &[])?;
        body.object(Bag::Properties)?;
        check_item_id(&id)?;
        let change = updating(id, &body)?;
        write::run(&door, &who, claim, Change::View(change)).await
    })
    .await
}

pub async fn delete(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    sent: Sent,
) -> Answer {
    caller.require_view_write()?;
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, _| async move {
        query::only(&uri, &[])?;
        check_item_id(&id)?;
        write::run(&door, &who, claim, Change::View(ViewChange::Delete { id })).await
    })
    .await
}

pub async fn items(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    uri: Uri,
) -> Answer {
    caller.require_reach()?;
    let params = Params::read(&uri, &["limit", "cursor"], false)?;
    check_item_id(&id)?;
    let page = ViewPage {
        id,
        limit: whole_limit(&params, VIEW_PAGE, MAX_VIEW_PAGE)?,
        cursor: params.one("cursor")?.map(str::to_string),
    };
    let answer = view_items(&app, &caller, page).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

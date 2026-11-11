//! Folder settings and sync status.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};
use marfa_rules::integers;
use serde_json::{Map, Value};

use super::answer::{Answer, text_answer};
use super::body::{Bag, JsonBody, ReadBody};
use super::items::{Named, Sent, check_item_id, keyed, version_of};
use super::listing::{Params, whole_limit};
use super::query;
use crate::app::App;
use crate::app::access::{Caller, unauthorized};
use crate::app::folders::{self, Page, Report, SETTINGS, refuse_null, undeclared};
use crate::app::items::write::{self, Change, FolderChange, ruled};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::types::missing_field;

const FOLDER_PAGE: i64 = 50;
const MAX_FOLDER_PAGE: i64 = 200;

/// A whole number a float would change, written under `defaults.properties` and named from inside it.
fn refuse_inexact_defaults(body: &ReadBody) -> Result<()> {
    let Ok(text) = std::str::from_utf8(body.bytes()) else {
        return Ok(());
    };
    integers::refuse_inexact_integers_under(text, &["defaults", "properties"]).map_err(ruled)
}

fn declared(body: &ReadBody, allowed: &[&str]) -> Result<Map<String, Value>> {
    refuse_inexact_defaults(body)?;
    let sent = body.object(Bag::Whole)?;
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

async fn creating(body: &ReadBody) -> Result<FolderChange> {
    let settings = declared(body, &SETTINGS)?;
    refuse_null(&settings)?;
    if !settings.contains_key("title") {
        return Err(missing_field("title"));
    }
    let patterns = folders::compile_patterns(&settings).await?;
    Ok(FolderChange::Create { settings, patterns })
}

async fn updating(id: String, body: &ReadBody) -> Result<FolderChange> {
    let mut allowed = SETTINGS.to_vec();
    allowed.push("version");
    let mut settings = declared(body, &allowed)?;
    if !settings.contains_key("version") {
        return Err(missing_field("version"));
    }
    let version = version_of(&settings)?.unwrap_or_default();
    settings.remove("version");
    refuse_null(&settings)?;
    if settings.is_empty() {
        return Err(Refusal::validation("Name at least one setting to change."));
    }
    let patterns = folders::compile_patterns(&settings).await?;
    Ok(FolderChange::Update {
        id,
        settings,
        patterns,
        version,
    })
}

/// A write answers to a key or an app's token, whose type map decides it.
fn within_a_map(caller: &Caller) -> Result<()> {
    match caller {
        Caller::Local(_) => Err(unauthorized()),
        _ => caller.require_folder_write(),
    }
}

pub async fn create(State(app): State<Arc<App>>, caller: Caller, sent: Sent) -> Answer {
    within_a_map(&caller)?;
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, body| async move {
        query::only(&uri, &[])?;
        let change = creating(&body).await?;
        write::run(&door, &who, claim, Change::Folder(change)).await
    })
    .await
}

pub async fn update(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    sent: Sent,
) -> Answer {
    within_a_map(&caller)?;
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, body| async move {
        query::only(&uri, &[])?;
        body.object(Bag::Whole)?;
        check_item_id(&id)?;
        let change = updating(id, &body).await?;
        write::run(&door, &who, claim, Change::Folder(change)).await
    })
    .await
}

pub async fn revoke(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    sent: Sent,
) -> Answer {
    within_a_map(&caller)?;
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, _| async move {
        query::only(&uri, &[])?;
        check_item_id(&id)?;
        write::run(
            &door,
            &who,
            claim,
            Change::Folder(FolderChange::Revoke { id }),
        )
        .await
    })
    .await
}

pub async fn report(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    caller.require_reach()?;
    query::only(&uri, &[])?;
    let sent = body.read().await?.object(Bag::Properties)?;
    let report = Report::read(&sent)?;
    check_item_id(&id)?;
    let answer = folders::report(&app, &caller, id, report).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

pub async fn status(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    uri: Uri,
) -> Answer {
    caller.require_reach()?;
    query::only(&uri, &[])?;
    check_item_id(&id)?;
    let answer = folders::read(&app, &caller, id).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

/// Only the private socket lists folders, since a listing names every folder whatever a key reads.
pub async fn inventory(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    match &caller {
        Caller::Local(_) => {}
        _ => {
            return Err(Refusal::new(
                Code::Forbidden,
                "Only the private local command can list folders.",
            )
            .into());
        }
    }
    let params = Params::read(&uri, &["limit", "cursor"], false)?;
    let page = Page {
        limit: whole_limit(&params, FOLDER_PAGE, MAX_FOLDER_PAGE)?,
        cursor: params.one("cursor")?.map(str::to_string),
    };
    let answer = folders::list(&app, &caller, page).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

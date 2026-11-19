use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::Response;
use marfa_rules::validation;
use serde_json::{Map, Value};

use super::answer::{Answer, text_answer};
use super::body::{Bag, JsonBody, only_declared};
use super::items::{
    Named, Sent, check_item_id, finished, invalid_field, keyed, named_version, text_of,
};
use super::query;
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::items::emptied::{self, safe};
use crate::app::items::write::{self, Change, OwnerAct};
use crate::app::items::{self, Listing};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::types::{check_id, missing_field};

const STATES: [&str; 3] = ["active", "archived", "trashed"];
const TRANSITION_FIELDS: [&str; 1] = ["state"];
const PREVIEW_FIELDS: [&str; 1] = ["ids"];
const TRASH_FIELDS: [&str; 2] = ["ids", "digest"];
const MAX_TRASH_IDS: usize = 20;
const MAX_QUERY_CHARS: usize = 500;
const SUMMARIES_PAGE: i64 = 50;
const BIN_PAGE: i64 = 25;
const MAX_PAGE: i64 = 200;
const DIGEST_CHARS: usize = 64;

pub async fn transition(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    sent: Sent,
) -> Answer {
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, body| async move {
        let version = named_version(&uri)?;
        let sent = only_declared(body.object(Bag::Whole)?, &TRANSITION_FIELDS)?;
        check_item_id(&id)?;
        let Some(state) = text_of(&sent, "state")? else {
            return Err(missing_field("state"));
        };
        if !STATES.contains(&state.as_str()) {
            return Err(invalid_field(
                "state",
                "state is active, archived or trashed.",
            ));
        }
        let change = Change::Transition { id, state, version };
        write::run(&door, &who, claim, change).await
    })
    .await
}

pub async fn delete(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    uri: Uri,
    sent: Sent,
) -> Answer {
    if caller.is_local() {
        return Ok(owner_act(&app, &caller, id, &uri, OwnerAct::Trash).await?);
    }
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, _| async move {
        let version = named_version(&uri)?;
        check_item_id(&id)?;
        write::run(&door, &who, claim, Change::Delete { id, version }).await
    })
    .await
}

pub async fn restore(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    uri: Uri,
    sent: Sent,
) -> Answer {
    if caller.is_local() {
        return Ok(owner_act(&app, &caller, id, &uri, OwnerAct::Restore).await?);
    }
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, _| async move {
        let version = named_version(&uri)?;
        check_item_id(&id)?;
        write::run(&door, &who, claim, Change::Restore { id, version }).await
    })
    .await
}

pub async fn purge(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    uri: Uri,
    sent: Sent,
) -> Answer {
    if caller.is_local() {
        return Ok(owner_act(&app, &caller, id, &uri, OwnerAct::Purge).await?);
    }
    caller.require(Permission::ItemsPurge)?;
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, _| async move {
        let version = named_version(&uri)?;
        check_item_id(&id)?;
        write::run(&door, &who, claim, Change::Purge { id, version }).await
    })
    .await
}

fn trash_ids(sent: &Map<String, Value>) -> Result<Vec<String>> {
    let Some(named) = sent.get("ids") else {
        return Err(missing_field("ids"));
    };
    let Some(named) = named.as_array() else {
        return Err(invalid_field("ids", "ids must be a list of item IDs."));
    };
    if named.is_empty() || named.len() > MAX_TRASH_IDS {
        return Err(invalid_field(
            "ids",
            format!("ids names from 1 to {MAX_TRASH_IDS} items."),
        ));
    }
    let mut seen = HashSet::new();
    let mut ids = Vec::with_capacity(named.len());
    for id in named {
        let Some(id) = id.as_str() else {
            return Err(invalid_field("ids", "ids must be a list of item IDs."));
        };
        if validation::id("ids", id).is_err() {
            return Err(
                Refusal::new(Code::InvalidId, format!("Invalid item ID: {id}"))
                    .with_detail("field", "ids"),
            );
        }
        if seen.insert(id) {
            ids.push(id.to_string());
        }
    }
    Ok(ids)
}

pub async fn preview(
    State(app): State<Arc<App>>,
    caller: Caller,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    let sent = body.object(&PREVIEW_FIELDS).await?;
    let ids = trash_ids(&sent)?;
    let answer = items::trash_preview(&app, &caller, ids).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

fn digest_of(sent: &Map<String, Value>) -> Result<Option<String>> {
    let digest = text_of(sent, "digest")?;
    if let Some(digest) = &digest
        && !(digest.len() == DIGEST_CHARS
            && digest
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
    {
        return Err(invalid_field(
            "digest",
            "digest must be a SHA-256 hash in hex.",
        ));
    }
    Ok(digest)
}

pub async fn trash(State(app): State<Arc<App>>, caller: Caller, sent: Sent) -> Answer {
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, body| async move {
        query::only(&uri, &[])?;
        let sent = only_declared(body.object(Bag::Whole)?, &TRASH_FIELDS)?;
        let ids = trash_ids(&sent)?;
        let digest = digest_of(&sent)?;
        write::run(&door, &who, claim, Change::Trash { ids, digest }).await
    })
    .await
}

fn limit_of(uri: &Uri, page: i64) -> Result<i64> {
    let named = query::pairs(uri)?
        .into_iter()
        .find(|(name, _)| name == "limit");
    let Some((_, limit)) = named else {
        return Ok(page);
    };
    limit
        .parse()
        .ok()
        .filter(|limit| (1..=MAX_PAGE).contains(limit))
        .ok_or_else(|| {
            invalid_field(
                "limit",
                format!("limit is a whole number from 1 to {MAX_PAGE}."),
            )
        })
}

fn named_in(uri: &Uri, field: &str) -> Result<Option<String>> {
    Ok(query::pairs(uri)?
        .into_iter()
        .find(|(name, _)| name == field)
        .map(|(_, value)| value))
}

fn listing_of(uri: &Uri, page: i64) -> Result<Listing> {
    query::only(uri, &["type", "q", "limit", "cursor"])?;
    let type_id = named_in(uri, "type")?;
    if let Some(type_id) = &type_id {
        check_id(type_id, "type")?;
    }
    let q = named_in(uri, "q")?.unwrap_or_default();
    if q.chars().count() > MAX_QUERY_CHARS {
        return Err(invalid_field(
            "q",
            format!("q holds at most {MAX_QUERY_CHARS} characters."),
        ));
    }
    Ok(Listing {
        type_id,
        q,
        limit: limit_of(uri, page)?,
        cursor: named_in(uri, "cursor")?,
    })
}

pub async fn summaries(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require_reach()?;
    let listing = listing_of(&uri, SUMMARIES_PAGE)?;
    let answer = items::summaries(&app, &caller, listing).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

pub async fn bin(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require(Permission::ItemsPurge)?;
    let listing = listing_of(&uri, BIN_PAGE)?;
    let answer = items::bin(&app, &caller, listing).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

async fn owner_act(
    app: &Arc<App>,
    caller: &Caller,
    id: String,
    uri: &Uri,
    act: OwnerAct,
) -> std::result::Result<Response, Refusal> {
    caller.require_local()?;
    let Some(version) = named_version(uri)? else {
        return Err(missing_field("version"));
    };
    check_item_id(&id)?;
    let change = Change::Owner { act, id, version };
    match write::run(app, caller, None, change).await {
        Ok(done) => Ok(finished(done)),
        Err(refusal) => Err(safe(refusal)),
    }
}

pub async fn empty(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require(Permission::ItemsPurge)?;
    query::only(&uri, &["cursor"])?;
    let emptied = emptied::empty_page(&app, &caller, named_in(&uri, "cursor")?).await?;
    Ok(text_answer(StatusCode::OK, emptied.to_json().to_string()))
}

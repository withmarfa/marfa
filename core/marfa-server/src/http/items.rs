//! A door judges what can be judged without the store; what the store decides happens in
//! `app::items`.

use std::future::Future;
use std::sync::Arc;

use axum::extract::rejection::PathRejection;
use axum::extract::{FromRequest, FromRequestParts, Path, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::Response;
use marfa_rules::error::{RuleError, field_code};
use marfa_rules::{names, time, validation};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use super::answer::{Answer, Stopped, refusal_body, text_answer};
use super::body::{Bag, JsonBody, ReadBody, only_declared};
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::edges::write::Inline;
use crate::app::idempotency::{self, Claim, Entry, Kept, MAX_KEY_CHARACTERS};
use crate::app::items::write::{self, Change, Done, Put, Settle, Update, ruled};
use crate::app::items::{self, Detail, Many};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::types::{check_id, missing_field};

const CREATE_FIELDS: [&str; 14] = [
    "type",
    "properties",
    "id",
    "state",
    "occurred_at",
    "source",
    "source_id",
    "mode",
    "version",
    "tier",
    "capture_latitude",
    "capture_longitude",
    "tags",
    "edges",
];
const UPDATE_FIELDS: [&str; 11] = [
    "properties",
    "clear_properties",
    "type",
    "properties_mode",
    "retype",
    "version",
    "version_match",
    "tier",
    "occurred_at",
    "source_id",
    "edges",
];
const TAG_FIELDS: [&str; 1] = ["tags"];
const BULK_GET_FIELDS: [&str; 2] = ["ids", "include"];
const TITLE_FIELDS: [&str; 1] = ["names"];
const MAX_BULK_IDS: usize = 100;
const MAX_TITLE_NAMES: usize = 200;
const MAX_HISTORY_PAGE: i64 = 200;
const HISTORY_PAGE: i64 = 50;
const REPLAYED_HEADER: &str = "idempotency-replayed";

/// What a path names. A segment that does not decode names no item.
pub struct Named<T>(pub T);

impl<T> FromRequestParts<Arc<App>> for Named<T>
where
    T: DeserializeOwned + Send,
{
    type Rejection = Stopped;

    async fn from_request_parts(
        parts: &mut Parts,
        app: &Arc<App>,
    ) -> std::result::Result<Named<T>, Stopped> {
        let named: std::result::Result<Path<T>, PathRejection> =
            Path::from_request_parts(parts, app).await;
        match named {
            Ok(Path(value)) => Ok(Named(value)),
            Err(_) => Err(Refusal::new(Code::InvalidId, "Invalid item ID").into()),
        }
    }
}

pub struct Sent {
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: JsonBody,
}

impl FromRequest<Arc<App>> for Sent {
    type Rejection = Stopped;

    async fn from_request(request: Request, app: &Arc<App>) -> std::result::Result<Sent, Stopped> {
        let (method, uri, headers) = (
            request.method().clone(),
            request.uri().clone(),
            request.headers().clone(),
        );
        let body = JsonBody::from_request(request, app).await?;
        Ok(Sent {
            method,
            uri,
            headers,
            body,
        })
    }
}

fn idempotency_key(headers: &HeaderMap) -> Result<Option<String>> {
    let Some(value) = headers.get("idempotency-key") else {
        return Ok(None);
    };
    let refused = || {
        Refusal::validation(format!(
            "Idempotency-Key must be between 1 and {MAX_KEY_CHARACTERS} characters"
        ))
    };
    let key = String::from_utf8_lossy(value.as_bytes()).into_owned();
    if key.is_empty() || key.chars().count() > MAX_KEY_CHARACTERS {
        return Err(refused());
    }
    Ok(Some(key))
}

fn hex_value(digit: u8) -> Option<u8> {
    char::from(digit)
        .to_digit(16)
        .and_then(|value| u8::try_from(value).ok())
}

fn decoded(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let high = hex_value(*bytes.get(at + 1)?)?;
            let low = hex_value(*bytes.get(at + 2)?)?;
            out.push(high * 16 + low);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn encoded(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// One spelling for each path a client can percent-encode several ways, so a
/// repeat is known whichever it sends. A segment that does not decode stands.
fn canonical_path(path: &str) -> String {
    path.split('/')
        .map(|segment| decoded(segment).map_or_else(|| segment.to_string(), |text| encoded(&text)))
        .collect::<Vec<_>>()
        .join("/")
}

fn replayed(kept: Kept) -> Response {
    let code = serde_json::from_slice::<Value>(&kept.body)
        .ok()
        .and_then(|answer| {
            answer
                .pointer("/error/code")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .and_then(|code| HeaderValue::from_str(&code).ok());
    let status = StatusCode::from_u16(kept.status).unwrap_or(StatusCode::OK);
    let content_type = HeaderValue::from_str(&kept.content_type)
        .unwrap_or(HeaderValue::from_static("application/json"));
    let mut response = text_answer(status, kept.body);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, content_type);
    headers.insert(REPLAYED_HEADER, HeaderValue::from_static("true"));
    if let Some(code) = code {
        headers.insert("x-error-code", code);
    }
    response
}

pub(super) fn finished(done: Done) -> Response {
    text_answer(
        StatusCode::from_u16(done.status).unwrap_or(StatusCode::OK),
        done.body,
    )
}

/// Runs `job` under the request's `Idempotency-Key`, where it carries one. The
/// write keeps its own answer; this keeps or releases a refusal's.
pub(super) async fn keyed<F, Fut>(app: &Arc<App>, caller: &Caller, sent: Sent, job: F) -> Answer
where
    F: FnOnce(Option<Claim>, Uri, ReadBody) -> Fut,
    Fut: Future<Output = Result<Done>>,
{
    let key = idempotency_key(&sent.headers)?;
    let body = sent.body.read().await?;
    let Some(key) = key else {
        return Ok(finished(job(None, sent.uri, body).await?));
    };
    let fingerprint = idempotency::fingerprint(
        app.contract(),
        sent.method.as_str(),
        &canonical_path(sent.uri.path()),
        sent.uri.query().unwrap_or_default(),
        body.declares_json(),
        body.bytes(),
    );
    let claim = match idempotency::enter(app, caller, &key, fingerprint).await? {
        Entry::Replay(kept) => return Ok(replayed(kept)),
        Entry::Fresh(claim) => claim,
    };
    match job(Some(claim.clone()), sent.uri, body).await {
        Ok(done) => Ok(finished(done)),
        Err(refusal) => {
            idempotency::settle(app, claim, refusal.code.status(), refusal_body(&refusal)).await;
            Err(refusal.into())
        }
    }
}

pub(super) fn check_item_id(id: &str) -> Result<()> {
    validation::id("id", id).map_err(|_| Refusal::new(Code::InvalidId, "Invalid item ID"))
}

pub(super) fn invalid_field(field: &str, message: impl Into<String>) -> Refusal {
    let message = message.into();
    Refusal::validation(message.clone())
        .with_detail("field", field)
        .with_detail("errors", json!([{ "path": field, "message": message }]))
}

pub(super) fn text_of(body: &Map<String, Value>, field: &str) -> Result<Option<String>> {
    match body.get(field) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(invalid_field(field, format!("{field} must be a string."))),
    }
}

fn number_of(body: &Map<String, Value>, field: &str) -> Result<Option<f64>> {
    match body.get(field) {
        None => Ok(None),
        Some(value) => value
            .as_f64()
            .map(Some)
            .ok_or_else(|| invalid_field(field, format!("{field} must be a number."))),
    }
}

fn whole_of(value: &Value) -> Option<i64> {
    const LARGEST_EXACT: f64 = 9_007_199_254_740_992.0;
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|number| number.fract() == 0.0 && number.abs() < LARGEST_EXACT)
            .map(|number| number as i64)
    })
}

pub(super) fn version_of(body: &Map<String, Value>) -> Result<Option<i64>> {
    match body.get("version") {
        None => Ok(None),
        Some(value) => whole_of(value)
            .filter(|version| *version >= 0)
            .map(Some)
            .ok_or_else(|| {
                invalid_field("version", "version must be a whole number of 0 or more.")
            }),
    }
}

pub(super) fn time_of(body: &Map<String, Value>) -> Result<Option<String>> {
    let Some(text) = text_of(body, "occurred_at")? else {
        return Ok(None);
    };
    time::normalize(&text, "occurred_at")
        .map(Some)
        .map_err(|error| invalid_field("occurred_at", error.message))
}

pub(super) fn edges_of(body: &Map<String, Value>) -> Result<Option<Inline>> {
    let Some(sent) = body.get("edges") else {
        return Ok(None);
    };
    let Value::Object(listed) = sent else {
        return Err(invalid_field("edges", "edges must be an object."));
    };
    let mut inline = Vec::with_capacity(listed.len());
    for (edge_type, targets) in listed {
        let field = format!("edges.{edge_type}");
        inline.push((edge_type.clone(), strings_of(targets, &field)?));
    }
    Ok(Some(inline))
}

pub(super) fn properties_of(body: &mut Map<String, Value>) -> Result<Option<Map<String, Value>>> {
    match body.remove("properties") {
        None => Ok(None),
        Some(Value::Object(properties)) => {
            validation::property_names(&properties).map_err(ruled)?;
            Ok(Some(properties))
        }
        Some(_) => Err(invalid_field("properties", "properties must be an object.")),
    }
}

fn strings_of(value: &Value, field: &str) -> Result<Vec<String>> {
    let refused = || invalid_field(field, format!("{field} must be a list of strings."));
    value
        .as_array()
        .ok_or_else(refused)?
        .iter()
        .map(|entry| entry.as_str().map(str::to_string).ok_or_else(refused))
        .collect()
}

pub(super) fn tags_of(value: &Value) -> Result<Vec<String>> {
    let tags = strings_of(value, "tags")?;
    validation::tags(&tags).map_err(ruled)?;
    Ok(tags)
}

pub(super) fn declared_type(body: &Map<String, Value>) -> Result<Option<String>> {
    let declared = text_of(body, "type")?;
    if let Some(type_id) = &declared {
        check_id(type_id, "type")?;
    }
    Ok(declared)
}

fn put_of(body: &ReadBody) -> Result<Put> {
    let object = body.object(Bag::Properties)?;
    let Some(type_id) = declared_type(&object)? else {
        return Err(missing_field("type"));
    };
    let mut sent = only_declared(object, &CREATE_FIELDS)?;
    body.refuse_inexact_numbers(Bag::Properties)?;
    let properties = properties_of(&mut sent)?;
    let id = text_of(&sent, "id")?;
    if let Some(id) = &id {
        validation::id("id", id).map_err(ruled)?;
    }
    let create_only = match text_of(&sent, "mode")?.as_deref() {
        None | Some("upsert") => false,
        Some("create_only") => true,
        Some(_) => return Err(invalid_field("mode", "mode is upsert or create_only.")),
    };
    Ok(Put {
        type_id,
        properties,
        id,
        state: text_of(&sent, "state")?,
        occurred_at: time_of(&sent)?,
        source: text_of(&sent, "source")?,
        source_id: text_of(&sent, "source_id")?,
        create_only,
        version: version_of(&sent)?,
        tier: text_of(&sent, "tier")?,
        capture_latitude: number_of(&sent, "capture_latitude")?,
        capture_longitude: number_of(&sent, "capture_longitude")?,
        tags: sent.get("tags").map(tags_of).transpose()?,
        edges: edges_of(&sent)?,
    })
}

pub async fn create(State(app): State<Arc<App>>, caller: Caller, sent: Sent) -> Answer {
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, body| async move {
        query::only(&uri, &[])?;
        let put = put_of(&body)?;
        write::run(&door, &who, claim, Change::Put(Box::new(put))).await
    })
    .await
}

fn settle_of(uri: &Uri) -> Result<Settle> {
    query::only(uri, &["conflict"])?;
    let named = query::pairs(uri)?
        .into_iter()
        .find(|(name, _)| name == "conflict");
    match named.as_ref().map(|(_, value)| value.as_str()) {
        None | Some("manual" | "callback") => Ok(Settle::Refuse),
        Some("auto") => Ok(Settle::Automatically),
        Some(_) => Err(invalid_field(
            "conflict",
            "conflict is auto, manual or callback.",
        )),
    }
}

fn cleared_refusal(error: RuleError) -> Refusal {
    let both: Vec<String> = error
        .fields
        .iter()
        .filter(|field| field.code == field_code::SET_AND_CLEARED)
        .map(|field| field.path.clone())
        .collect();
    let refusal = ruled(error);
    if both.is_empty() {
        refusal
    } else {
        refusal.with_detail("clear_properties", both)
    }
}

fn update_of(id: String, settle: Settle, body: &ReadBody) -> Result<Update> {
    let sent = body.object(Bag::Properties)?;
    if !sent.contains_key("version") {
        return Err(missing_field("version"));
    }
    let version = version_of(&sent)?.unwrap_or_default();
    let mut sent = only_declared(sent, &UPDATE_FIELDS)?;
    check_item_id(&id)?;
    body.refuse_inexact_numbers(Bag::Properties)?;
    let properties = properties_of(&mut sent)?;
    let clear = sent
        .get("clear_properties")
        .map(|names| strings_of(names, "clear_properties"))
        .transpose()?
        .unwrap_or_default();
    let retype = match sent.get("retype") {
        None => false,
        Some(Value::Bool(retype)) => *retype,
        Some(_) => return Err(invalid_field("retype", "retype must be true or false.")),
    };
    let (tier, occurred, source_id) = (
        text_of(&sent, "tier")?,
        sent.get("occurred_at").cloned(),
        text_of(&sent, "source_id")?,
    );
    let edges = edges_of(&sent)?;
    if properties.is_none()
        && clear.is_empty()
        && edges.as_ref().is_none_or(Vec::is_empty)
        && tier.is_none()
        && occurred.is_none()
        && source_id.is_none()
        && !retype
    {
        return Err(Refusal::validation(
            "At least one of `properties`, `clear_properties`, `edges`, `tier`, `occurred_at`, \
             `source_id`, or `retype` is required.",
        ));
    }
    let none = Map::new();
    validation::cleared_names(&clear, properties.as_ref().unwrap_or(&none))
        .map_err(cleared_refusal)?;
    let occurred_at = time_of(&sent)?;
    let type_id = declared_type(&sent)?;
    if retype && type_id.is_none() {
        return Err(invalid_field(
            "type",
            "retype needs the type to move the item to",
        ));
    }
    let replace = match text_of(&sent, "properties_mode")?.as_deref() {
        None | Some("merge") => false,
        Some("replace") => true,
        Some(_) => {
            return Err(invalid_field(
                "properties_mode",
                "properties_mode is merge or replace.",
            ));
        }
    };
    let exact = match text_of(&sent, "version_match")?.as_deref() {
        None => false,
        Some("exact") => true,
        Some(_) => return Err(invalid_field("version_match", "version_match is exact.")),
    };
    Ok(Update {
        id,
        properties,
        clear,
        replace,
        type_id,
        retype,
        version,
        exact,
        tier,
        occurred_at,
        source_id,
        settle,
        edges,
    })
}

pub async fn update(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    sent: Sent,
) -> Answer {
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, body| async move {
        let settle = settle_of(&uri)?;
        let update = update_of(id, settle, &body)?;
        write::run(&door, &who, claim, Change::Update(Box::new(update))).await
    })
    .await
}

fn detail_of(uri: &Uri) -> Result<Detail> {
    query::only(uri, &["include"])?;
    let mut detail = Detail::default();
    for (name, value) in query::pairs(uri)? {
        if name != "include" {
            continue;
        }
        for token in value.split(',').map(str::trim) {
            match token {
                // Every item read carries these, asked for or not.
                "" | "metadata" | "edges" => {}
                "versions" => detail.versions = true,
                "backrefs" => detail.backrefs = true,
                "neighbors" => detail.neighbors = true,
                other => {
                    return Err(invalid_field(
                        "include",
                        format!("include does not take {other}."),
                    ));
                }
            }
        }
    }
    Ok(detail)
}

pub async fn read(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    uri: Uri,
) -> Answer {
    caller.require_reach()?;
    let include = detail_of(&uri)?;
    check_item_id(&id)?;
    let answer = items::detail(&app, &caller, id, include).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

fn limit_of(uri: &Uri) -> Result<i64> {
    let named = query::pairs(uri)?
        .into_iter()
        .find(|(name, _)| name == "limit");
    let Some((_, limit)) = named else {
        return Ok(HISTORY_PAGE);
    };
    limit
        .parse()
        .ok()
        .filter(|limit| (1..=MAX_HISTORY_PAGE).contains(limit))
        .ok_or_else(|| {
            invalid_field(
                "limit",
                format!("limit is a whole number from 1 to {MAX_HISTORY_PAGE}."),
            )
        })
}

pub async fn versions(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    uri: Uri,
) -> Answer {
    caller.require_reach()?;
    query::only(&uri, &["limit", "cursor"])?;
    let limit = limit_of(&uri)?;
    check_item_id(&id)?;
    let cursor = query::pairs(&uri)?
        .into_iter()
        .find(|(name, _)| name == "cursor")
        .map(|(_, cursor)| cursor);
    let answer = items::history(&app, &caller, id, limit, cursor).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

fn many_of(sent: &Map<String, Value>) -> Result<Many> {
    let mut many = Many::default();
    let Some(include) = sent.get("include") else {
        return Ok(many);
    };
    for token in strings_of(include, "include")? {
        match token.as_str() {
            "metadata" => many.metadata = true,
            "extensions" => many.extensions = true,
            "edges" => many.edges = true,
            "system" => many.system = true,
            other => {
                return Err(invalid_field(
                    "include",
                    format!("include does not take {other}."),
                ));
            }
        }
    }
    Ok(many)
}

pub async fn bulk_get(State(app): State<Arc<App>>, caller: Caller, body: JsonBody) -> Answer {
    let sent = body.object(&BULK_GET_FIELDS).await?;
    let Some(ids) = sent.get("ids") else {
        return Err(missing_field("ids").into());
    };
    let Some(listed) = ids.as_array() else {
        return Err(Refusal::validation("ids must be a list.").into());
    };
    if listed.len() > MAX_BULK_IDS {
        return Err(
            Refusal::validation(format!("Maximum {MAX_BULK_IDS} ids per call"))
                .with_detail("cap", MAX_BULK_IDS)
                .with_detail("provided", listed.len())
                .into(),
        );
    }
    let ids = strings_of(ids, "ids")?;
    for id in &ids {
        if validation::id("id", id).is_err() {
            return Err(
                Refusal::new(Code::InvalidId, format!("Invalid item id: {id}"))
                    .with_detail("id", id.as_str())
                    .into(),
            );
        }
    }
    let include = many_of(&sent)?;
    let answer = items::bulk_get(&app, &caller, ids, include).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

pub async fn titles(State(app): State<Arc<App>>, caller: Caller, body: JsonBody) -> Answer {
    let sent = body.object(&TITLE_FIELDS).await?;
    let Some(listed) = sent.get("names") else {
        return Err(missing_field("names").into());
    };
    let wanted = strings_of(listed, "names")?;
    if wanted.len() > MAX_TITLE_NAMES {
        return Err(
            invalid_field("names", format!("Maximum {MAX_TITLE_NAMES} names per call")).into(),
        );
    }
    if wanted
        .iter()
        .any(|name| name.encode_utf16().count() > names::MAX_NAME_UNITS)
    {
        return Err(invalid_field(
            "names",
            format!(
                "A name must contain at most {} UTF-16 code units",
                names::MAX_NAME_UNITS
            ),
        )
        .into());
    }
    let answer = items::titles(&app, &caller, wanted).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

pub async fn metadata(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    check_item_id(&id)?;
    let answer = items::metadata(&app, &caller, id).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

pub async fn set_metadata(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    sent: Sent,
) -> Answer {
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, body| async move {
        query::only(&uri, &[])?;
        let sent = only_declared(body.object(Bag::Properties)?, &TAG_FIELDS)?;
        check_item_id(&id)?;
        let tags = sent
            .get("tags")
            .map(tags_of)
            .transpose()?
            .unwrap_or_default();
        let change = Change::SetTags {
            id,
            tags,
            version: None,
        };
        write::run(&door, &who, claim, change).await
    })
    .await
}

pub(super) fn named_version(uri: &Uri) -> Result<Option<i64>> {
    query::only(uri, &["version"])?;
    let named = query::pairs(uri)?
        .into_iter()
        .find(|(name, _)| name == "version");
    let Some((_, version)) = named else {
        return Ok(None);
    };
    version
        .parse()
        .ok()
        .filter(|version| *version >= 1)
        .map(Some)
        .ok_or_else(|| invalid_field("version", "version is a whole number of 1 or more."))
}

pub async fn add_tags(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    sent: Sent,
) -> Answer {
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, body| async move {
        let version = named_version(&uri)?;
        let sent = only_declared(body.object(Bag::Properties)?, &TAG_FIELDS)?;
        check_item_id(&id)?;
        let Some(tags) = sent.get("tags") else {
            return Err(missing_field("tags"));
        };
        let tags = tags_of(tags)?;
        if tags.is_empty() {
            return Err(invalid_field(
                "tags",
                "tags must be a non-empty array of strings",
            ));
        }
        write::run(&door, &who, claim, Change::AddTags { id, tags, version }).await
    })
    .await
}

pub async fn remove_tag(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named((id, tag)): Named<(String, String)>,
    sent: Sent,
) -> Answer {
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, _| async move {
        let version = named_version(&uri)?;
        check_item_id(&id)?;
        write::run(&door, &who, claim, Change::RemoveTag { id, tag, version }).await
    })
    .await
}

pub async fn extensions(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    check_item_id(&id)?;
    let answer = items::extensions(&app, &caller, id).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

pub async fn extension(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named((id, namespace)): Named<(String, String)>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    check_item_id(&id)?;
    let answer = items::extension(&app, &caller, id, namespace).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

pub async fn set_extension(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named((id, namespace)): Named<(String, String)>,
    sent: Sent,
) -> Answer {
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, body| async move {
        query::only(&uri, &[])?;
        let data = body.object(Bag::Whole)?;
        check_item_id(&id)?;
        body.refuse_inexact_numbers(Bag::Whole)?;
        let change = Change::SetExtension {
            id,
            namespace,
            data,
        };
        write::run(&door, &who, claim, change).await
    })
    .await
}

pub async fn clear_extension(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named((id, namespace)): Named<(String, String)>,
    sent: Sent,
) -> Answer {
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, _| async move {
        query::only(&uri, &[])?;
        check_item_id(&id)?;
        write::run(&door, &who, claim, Change::ClearExtension { id, namespace }).await
    })
    .await
}

pub async fn tags(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    query::only(&uri, &[])?;
    let answer = items::tag_counts(&app, &caller).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

#[cfg(test)]
mod tests {
    use super::canonical_path;

    #[test]
    fn a_path_has_one_spelling() {
        assert_eq!(canonical_path("/items/a/tags/%2d x"), "/items/a/tags/-%20x");
        assert_eq!(canonical_path("/items/a/tags/%ff"), "/items/a/tags/%ff");
        assert_eq!(canonical_path("/items/a/tags/%7E%2F"), "/items/a/tags/~%2F");
    }
}

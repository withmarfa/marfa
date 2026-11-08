//! Stateless MCP over POST, with JSON responses.

mod results;
mod rpc;
mod tools;

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{FromRequest, Request, State};
use axum::http::header::{ALLOW, ORIGIN, WWW_AUTHENTICATE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use serde_json::{Map, Value, json};

use super::answer::{Unhandled, refusal_answer};
use super::body::JsonBody;
use super::caller::identify;
use super::query;
use crate::app::App;
use crate::app::access::{Caller, unauthorized};
use crate::app::oauth::clients::page_approved;
use crate::app::oauth::scope::Registries;
use crate::app::provenance;
use crate::app::refusal::{Code, Refusal};
use results::{Outcome, Stop, call_result};
use rpc::{Call, Entry, Era, Reply};

const PATH: &str = "/mcp";

/// What a client is told about the server in its first message, at most 512 characters.
const INSTRUCTIONS: &str = "Marfa is the person's own data store. Find and read with marfa_find and marfa_get, save with marfa_create (text, or a file by web address), change with marfa_update, and delete with marfa_delete. Read an item before changing it and send the version you read. marfa_delete only previews first: show the person what would go to the trash and ask before you confirm.";

const SERVER_NAME: &str = "marfa";
const SERVER_TITLE: &str = "Marfa";
const SERVER_INFO_KEY: &str = "io.modelcontextprotocol/serverInfo";

fn resource_metadata(app: &App) -> String {
    format!(
        "{}/.well-known/oauth-protected-resource{PATH}",
        app.addresses().sign_in().origin()
    )
}

fn challenged(mut response: Response, challenge: &str) -> Response {
    if let Ok(value) = HeaderValue::from_str(challenge) {
        response.headers_mut().insert(WWW_AUTHENTICATE, value);
    }
    response
}

fn unauthenticated(app: &App) -> Response {
    challenged(
        refusal_answer(&unauthorized()),
        &format!("Bearer resource_metadata=\"{}\"", resource_metadata(app)),
    )
}

/// Accepts instance and approved app origins when Origin is present.
async fn origin_allowed(app: &Arc<App>, headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    if app
        .addresses()
        .all()
        .iter()
        .any(|address| address.origin() == origin)
    {
        return true;
    }
    page_approved(app, origin).await.unwrap_or(false)
}

fn foreign_origin() -> Response {
    refusal_answer(&Refusal::new(
        Code::Forbidden,
        "This origin may not call the MCP endpoint.",
    ))
}

fn server_info() -> Value {
    json!({
        "name": SERVER_NAME,
        "title": SERVER_TITLE,
        "version": env!("CARGO_PKG_VERSION"),
    })
}

fn capabilities(caller: &Caller) -> Value {
    if tools::any_offered(caller) {
        json!({ "tools": {} })
    } else {
        json!({})
    }
}

/// A result of the 2026-07-28 revision says so; an earlier revision's does not know the member.
fn complete(era: Era, mut result: Map<String, Value>) -> Value {
    if era == Era::Modern {
        result.insert("resultType".into(), "complete".into());
    }
    Value::Object(result)
}

fn initialize(caller: &Caller, call: &Call) -> Value {
    let asked = call.params.get("protocolVersion").and_then(Value::as_str);
    let version = asked
        .filter(|version| rpc::LEGACY.contains(version))
        .unwrap_or(rpc::LEGACY[0]);
    json!({
        "protocolVersion": version,
        "capabilities": capabilities(caller),
        "serverInfo": server_info(),
        "instructions": INSTRUCTIONS,
    })
}

fn discover(caller: &Caller) -> Value {
    let mut result = Map::new();
    result.insert("supportedVersions".into(), json!([rpc::MODERN]));
    result.insert("capabilities".into(), capabilities(caller));
    result.insert("instructions".into(), INSTRUCTIONS.into());
    result.insert("ttlMs".into(), 0.into());
    result.insert("cacheScope".into(), "private".into());
    result.insert("_meta".into(), json!({ SERVER_INFO_KEY: server_info() }));
    complete(Era::Modern, result)
}

fn listing(era: Era, caller: &Caller) -> Value {
    let mut result = Map::new();
    result.insert("tools".into(), Value::Array(tools::listing(caller)));
    if era == Era::Modern {
        result.insert("ttlMs".into(), 0.into());
        result.insert("cacheScope".into(), "private".into());
    }
    complete(era, result)
}

/// Challenges name only scopes an app can be granted.
fn missing_scope(app: &App, stop: &Stop) -> Option<String> {
    let details = stop.refusal.as_ref()?.details.as_ref()?;
    let scope = match details.get("required_scope").and_then(Value::as_str) {
        Some(scope) => scope.to_string(),
        None => {
            let grant = details.get("grant")?;
            let name = grant.get("name").and_then(Value::as_str)?;
            let level = grant.get("level").and_then(Value::as_str)?;
            match grant.get("kind").and_then(Value::as_str)? {
                "type" => format!("{name}:{level}"),
                "edge_type" => format!("edge.{name}:{level}"),
                _ => return None,
            }
        }
    };
    Registries::of(&app.catalog_handle().load())
        .allowed()
        .contains(&scope)
        .then_some(scope)
}

fn step_up(app: &App, scope: &str, stop: &Stop) -> Response {
    let refusal = stop.refusal.clone().unwrap_or_else(|| {
        Refusal::new(
            Code::Forbidden,
            "This credential lacks a scope this call needs.",
        )
    });
    challenged(
        refusal_answer(&refusal),
        &format!(
            "Bearer error=\"insufficient_scope\", scope=\"{scope}\", resource_metadata=\"{}\"",
            resource_metadata(app)
        ),
    )
}

fn faulted(mut response: Response, stop: &Stop) -> Response {
    if let Some(refusal) = stop
        .refusal
        .as_ref()
        .filter(|r| r.code == Code::InternalError)
        && let Some(fault) = &refusal.fault
    {
        response.extensions_mut().insert(Unhandled(fault.clone()));
    }
    response
}

async fn tool_call(app: &Arc<App>, caller: &Caller, call: Call) -> Response {
    let Call {
        id,
        params,
        era,
        exact,
        ..
    } = call;
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return Reply::in_band(id, rpc::INVALID_PARAMS, "Invalid params: name is required.")
            .into_response();
    };
    let arguments = match params.get("arguments") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(arguments)) => arguments.clone(),
        Some(_) => {
            return Reply::in_band(
                id,
                rpc::INVALID_PARAMS,
                "Invalid params: arguments must be an object.",
            )
            .into_response();
        }
    };
    let Some(outcome): Option<Outcome> =
        provenance::through("mcp", tools::call(app, caller, name, arguments, exact)).await
    else {
        return Reply::in_band(id, rpc::INVALID_PARAMS, format!("Unknown tool: {name}"))
            .into_response();
    };
    if let (Err(stop), Caller::App { .. }) = (&outcome, caller)
        && !stop.wrote
        && let Some(scope) = missing_scope(app, stop)
    {
        return step_up(app, &scope, stop);
    }
    let mut result = match call_result(&outcome) {
        Value::Object(result) => result,
        other => return Reply::result(id, other).into_response(),
    };
    if era == Era::Modern {
        result.insert("resultType".into(), "complete".into());
    }
    let response = Reply::result(id, Value::Object(result)).into_response();
    match &outcome {
        Err(stop) => faulted(response, stop),
        Ok(_) => response,
    }
}

async fn answer(app: &Arc<App>, caller: &Caller, call: Call) -> Response {
    let reply = match (call.era, call.method.as_str()) {
        (_, "ping") => Reply::result(call.id, complete(call.era, Map::new())),
        (Era::Legacy, "initialize") => Reply::result(call.id.clone(), initialize(caller, &call)),
        (Era::Modern, "server/discover") => Reply::result(call.id, discover(caller)),
        (era, "tools/list") => Reply::result(call.id, listing(era, caller)),
        (_, "tools/call") => return tool_call(app, caller, call).await,
        _ => Reply::in_band(
            call.id,
            rpc::METHOD_NOT_FOUND,
            format!("Method not found: {}", call.method),
        ),
    };
    reply.into_response()
}

async fn post(State(app): State<Arc<App>>, request: Request) -> Response {
    let (mut parts, body) = request.into_parts();
    if !origin_allowed(&app, &parts.headers).await {
        return foreign_origin();
    }
    let caller = match identify(&mut parts, &app).await {
        Ok(Some(caller @ (Caller::Key(_) | Caller::App { .. }))) => caller,
        Ok(_) => return unauthenticated(&app),
        Err(refusal) => return refusal_answer(&refusal),
    };
    if let Err(refusal) = query::only(&parts.uri, &[]) {
        return refusal_answer(&refusal);
    }
    let headers = parts.headers.clone();
    let read = match JsonBody::from_request(Request::from_parts(parts, body), &app).await {
        Ok(body) => body.read().await,
        Err(stopped) => Err(stopped),
    };
    let read = match read {
        Ok(read) => read,
        Err(stopped) => return axum::response::IntoResponse::into_response(stopped),
    };
    if !read.declares_json() {
        return rpc::not_json().into_response();
    }
    match rpc::classify(&headers, read.bytes()) {
        Entry::Rejected(reply) => reply.into_response(),
        Entry::Notification => {
            let mut accepted = Response::new(Body::empty());
            *accepted.status_mut() = StatusCode::ACCEPTED;
            accepted
        }
        Entry::Call(call) => answer(&app, &caller, call).await,
    }
}

/// The answer to a body that is not a JSON-RPC message, at any MCP path.
pub fn unreadable(is_text: bool) -> Response {
    let (code, message) = if is_text {
        (rpc::PARSE_ERROR, "Parse error")
    } else {
        (
            rpc::INVALID_REQUEST,
            "Bad Request: the request body is not a valid JSON-RPC message",
        )
    };
    Reply::error(StatusCode::BAD_REQUEST, Value::Null, code, message, None).into_response()
}

/// Without sessions or streams, GET and DELETE have no operation.
async fn only_post() -> Response {
    let mut response = Reply::error(
        StatusCode::METHOD_NOT_ALLOWED,
        Value::Null,
        -32000,
        "Method not allowed: this endpoint takes POST only.",
        None,
    )
    .into_response();
    response
        .headers_mut()
        .insert(ALLOW, HeaderValue::from_static("POST"));
    response
}

pub fn doors() -> super::Routes {
    use super::doors::{Doors, post as post_to};
    Doors::new().route(PATH, post_to(post).get(only_post).delete(only_post))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_instructions_fit_the_limit_a_client_may_hold_them_to() {
        assert!(
            INSTRUCTIONS.chars().count() <= 512,
            "{}",
            INSTRUCTIONS.chars().count()
        );
    }
}

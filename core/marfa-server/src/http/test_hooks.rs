//! Routed only on the control socket, and only when `MARFA_TEST_HOOKS` is on.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Value, json};

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use crate::app::App;
use crate::app::refusal::Refusal;
use crate::db::Write;

fn clock_answer(app: &App) -> Response {
    json_answer(
        StatusCode::OK,
        &json!({
            "offset_ms": app.clock.offset_ms(),
            "jump_ms": app.clock.jump_ms(),
            "now": app.clock.stamp(),
        }),
    )
}

fn faults_answer(app: &App) -> Response {
    json_answer(StatusCode::OK, &json!({ "faults": app.faults.list() }))
}

pub async fn read_clock(State(app): State<Arc<App>>) -> Response {
    clock_answer(&app)
}

/// `advance_ms` is time passing while the server runs and commits; `jump_ms` is the host's clock
/// being set, either way, with no time passing.
pub async fn move_clock(State(app): State<Arc<App>>, body: JsonBody) -> Answer {
    let body = body.object(&["advance_ms", "jump_ms", "paused"]).await?;
    let one_of = || {
        Refusal::validation(
            "Send advance_ms, a whole number, jump_ms, an integer, or paused, a boolean.",
        )
    };
    let refused = |refused: crate::app::clock::Refused| Refusal::validation(refused.to_string());
    let only = body.len() == 1;
    match (
        body.get("advance_ms"),
        body.get("jump_ms"),
        body.get("paused"),
    ) {
        (Some(advance), None, None) if only => {
            let ms = advance.as_u64().ok_or_else(one_of)?;
            app.clock.advance(ms).map_err(refused)?;
            app.db.write(Write::own(), |_| Ok(())).await?;
        }
        (None, Some(jump), None) if only => {
            let ms = jump.as_i64().ok_or_else(one_of)?;
            app.clock.jump(ms).map_err(refused)?;
        }
        (None, None, Some(Value::Bool(paused))) if only => app.clock.pause(*paused),
        _ => return Err(one_of().into()),
    }
    Ok(clock_answer(&app))
}

pub async fn read_faults(State(app): State<Arc<App>>) -> Response {
    faults_answer(&app)
}

pub async fn set_fault(State(app): State<Arc<App>>, body: JsonBody) -> Answer {
    let body = body.object(&["name", "arg"]).await?;
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| Refusal::validation("name must be text."))?;
    let arg = match body.get("arg") {
        None | Some(Value::Null) => None,
        Some(Value::String(arg)) => Some(arg.as_str()),
        Some(_) => return Err(Refusal::validation("arg must be text or null.").into()),
    };
    app.faults.set(name, arg).map_err(Refusal::validation)?;
    Ok(faults_answer(&app))
}

pub async fn read_database(State(app): State<Arc<App>>) -> Answer {
    let settings = app.db.connection_settings().await?;
    Ok(json_answer(StatusCode::OK, &settings))
}

#[derive(Deserialize)]
pub struct Inspecting {
    hash: Option<String>,
}

pub async fn inspect_stores(
    State(app): State<Arc<App>>,
    Query(inspecting): Query<Inspecting>,
) -> Answer {
    let found = app.inspect_stores(inspecting.hash.as_deref()).await?;
    Ok(json_answer(StatusCode::OK, &found))
}

#[derive(Deserialize)]
pub struct Clearing {
    name: Option<String>,
}

pub async fn clear_faults(
    State(app): State<Arc<App>>,
    Query(clearing): Query<Clearing>,
) -> Response {
    app.faults.clear(clearing.name.as_deref());
    faults_answer(&app)
}

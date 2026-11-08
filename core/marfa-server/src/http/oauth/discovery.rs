use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;

use crate::app::App;
use crate::app::oauth::discovery;
use crate::app::refusal::{Code, Refusal};
use crate::http::answer::{Answer, json_answer};

pub async fn authorization_server(State(app): State<Arc<App>>) -> Answer {
    Ok(json_answer(
        StatusCode::OK,
        &discovery::authorization_server(&app),
    ))
}

fn resource_at(app: &App, path: &str) -> Answer {
    let found = discovery::protected_resource(app, path)
        .ok_or_else(|| Refusal::new(Code::NotFound, "No resource is served here."))?;
    Ok(json_answer(StatusCode::OK, &found))
}

pub async fn protected_resource(State(app): State<Arc<App>>) -> Answer {
    resource_at(&app, "")
}

pub async fn protected_resource_at(
    State(app): State<Arc<App>>,
    Path(path): Path<String>,
) -> Answer {
    resource_at(&app, &format!("/{path}"))
}

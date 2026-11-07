//! `GET /health`: open to all, with the reasons kept for those who may read
//! them.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};

use super::answer::{Answer, json_answer};
use super::caller::Caller;
use super::query;
use crate::app::App;
use crate::app::health::{self, Status};

const READS_REASONS: &str = "instance.read";

pub async fn answer(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    query::only(&uri, &[])?;
    let released = app.faults.health_admitted();
    let report = health::check(&app).await;
    if let Some(released) = released {
        app.faults.health_answered(released);
    }
    let with_errors = match &caller {
        Caller::Local => true,
        Caller::Key(key) => key.holds(READS_REASONS),
        Caller::Nobody => false,
    };
    let status = if report.overall() == Status::Down {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    };
    Ok(json_answer(status, &report.to_json(with_errors)))
}

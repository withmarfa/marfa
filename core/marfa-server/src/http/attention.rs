//! `GET /attention`: what needs the owner's eye, for the private socket alone.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};

use super::answer::{Answer, json_answer};
use super::query;
use crate::app::App;
use crate::app::access::{Caller, unauthorized};
use crate::app::attention;
use crate::app::refusal::Refusal;

pub async fn list(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    match &caller {
        Caller::Local(_) => {}
        Caller::Owner(_) => return Err(unauthorized().into()),
        _ => {
            return Err(Refusal::needs_local(
                "Only the private local command can read what needs attention.",
            )
            .into());
        }
    }
    query::only(&uri, &[])?;
    Ok(json_answer(StatusCode::OK, &attention::read(&app).await))
}

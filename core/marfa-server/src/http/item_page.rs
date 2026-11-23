//! Reads neither the item nor the caller, so no answer shows whether an item exists.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderValue, Uri, header};
use axum::response::IntoResponse;
use marfa_rules::validation;

use super::answer::Answer;
use super::pages::{self, Notice};
use crate::app::{App, instance};

/// The raw path after `/i/`, which a percent-encoded id is not decoded out of.
fn id_text(uri: &Uri) -> &str {
    uri.path().strip_prefix("/i/").unwrap_or_default()
}

pub async fn open(State(app): State<Arc<App>>, uri: Uri) -> Answer {
    let name = instance::name(&app).await?;
    let id = id_text(&uri);
    let notice = if validation::is_id(id) {
        Notice::opening_item(&name, &format!("marfa://{}/{id}", app.instance_id))
    } else {
        Notice::not_an_item_link(&name)
    };
    let mut response = pages::notice(&notice)?.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert("x-robots-tag", HeaderValue::from_static("noindex"));
    Ok(response)
}

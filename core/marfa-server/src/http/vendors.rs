use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use serde_json::{Value, json};

use super::answer::{Answer, json_answer};
use super::body::JsonBody;
use super::caller::OwnerOrCredential;
use super::{named_instance, query};
use crate::app::App;
use crate::app::refusal::{Code, Refusal};
use crate::app::vendors;

const FIELDS: [&str; 1] = ["client_id"];

pub async fn list(
    State(app): State<Arc<App>>,
    OwnerOrCredential(caller): OwnerOrCredential,
    uri: Uri,
) -> Answer {
    caller.require_vendor_door()?;
    query::only(&uri, &[])?;
    let data = vendors::listed(&app, &caller).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null }),
    ))
}

/// The owner's session is no credential to the instance header's layer, so this door judges it.
pub async fn give(
    State(app): State<Arc<App>>,
    Path(vendor): Path<String>,
    headers: HeaderMap,
    OwnerOrCredential(caller): OwnerOrCredential,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    named_instance::judge(&app, &headers)?;
    caller.require_vendor_move()?;
    query::only(&uri, &[])?;
    let sent = body.object(&FIELDS).await?;
    vendors::check_vendor(&vendor)?;
    let client_id = match sent.get("client_id") {
        Some(Value::String(id)) if !id.is_empty() => id.clone(),
        Some(_) => {
            return Err(Refusal::validation("client_id is an OAuth client ID.")
                .with_detail("field", "client_id")
                .into());
        }
        None => {
            return Err(
                Refusal::new(Code::MissingRequiredField, "client_id is required.")
                    .with_detail("field", "client_id")
                    .into(),
            );
        }
    };
    let binding = vendors::give(&app, &caller, vendor, client_id).await?;
    Ok(json_answer(StatusCode::OK, &binding))
}

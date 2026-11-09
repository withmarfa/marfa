use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};
use serde_json::{Value, json};

use crate::app::App;
use crate::app::access::Caller;
use crate::app::auth::Visit;
use crate::app::auth::sign_ins;
use crate::app::refusal::{Code, Refusal};
use crate::http::answer::{Answer, json_answer};
use crate::http::body::JsonBody;
use crate::http::query;

const NAME_FIELDS: [&str; 1] = ["name"];

pub async fn list(State(app): State<Arc<App>>, uri: Uri, caller: Caller) -> Answer {
    caller.require_local()?;
    query::only(&uri, &[])?;
    let found = sign_ins::list(&app, &caller).await?;
    let data: Vec<Value> = found.iter().map(sign_ins::SignIn::to_json).collect();
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null }),
    ))
}

pub async fn rename(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    caller: Caller,
    body: JsonBody,
) -> Answer {
    caller.require_local()?;
    let body = body.object(&NAME_FIELDS).await?;
    let Some(sent) = body.get("name") else {
        return Err(
            Refusal::new(Code::MissingRequiredField, "name is required.")
                .with_detail("field", "name")
                .into(),
        );
    };
    let text = sent
        .as_str()
        .ok_or_else(|| Refusal::validation("Give the sign-in a name."))?;
    let name = sign_ins::new_name(text)?;
    let renamed = sign_ins::rename(&app, &caller, id, name).await?;
    Ok(json_answer(StatusCode::OK, &renamed.to_json()))
}

pub async fn end(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    uri: Uri,
    caller: Caller,
    visit: Visit,
) -> Answer {
    caller.require_local()?;
    query::only(&uri, &["revoke_keys"])?;
    let with_keys = query::flag(&uri, "revoke_keys")?.unwrap_or(false);
    sign_ins::end(&app, &caller, id, with_keys, visit).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "ok": true })))
}

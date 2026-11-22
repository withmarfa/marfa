use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};
use serde_json::{Map, Value, json};

use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::oauth::grants::{self, Ending, Narrowing};
use crate::app::oauth::scope::ScopeSet;
use crate::app::refusal::{Code, Refusal};
use crate::http::answer::{Answer, json_answer};
use crate::http::body::JsonBody;
use crate::http::query;

const NARROW_FIELDS: [&str; 2] = ["scopes", "expected_scopes"];
const MOST_SCOPES: usize = 1_000;

pub(in crate::http) fn scopes_in(
    body: &Map<String, Value>,
    field: &'static str,
) -> Result<ScopeSet, Refusal> {
    let Some(sent) = body.get(field) else {
        return Err(
            Refusal::new(Code::MissingRequiredField, format!("{field} is required."))
                .with_detail("field", field),
        );
    };
    let invalid = || Refusal::validation(format!("{field} is a list of scopes."));
    let literals = sent.as_array().ok_or_else(invalid)?;
    if literals.len() > MOST_SCOPES {
        return Err(invalid());
    }
    literals
        .iter()
        .map(|literal| literal.as_str().filter(|text| !text.is_empty()))
        .collect::<Option<ScopeSet>>()
        .ok_or_else(invalid)
}

pub async fn list(State(app): State<Arc<App>>, uri: Uri, caller: Caller) -> Answer {
    caller.require(Permission::GrantsManage)?;
    query::only(&uri, &[])?;
    let data = grants::list(&app, &caller).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null }),
    ))
}

pub async fn narrow(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    caller: Caller,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    caller.require(Permission::GrantsManage)?;
    query::only(&uri, &[])?;
    let body = body.object(&NARROW_FIELDS).await?;
    let asked = Narrowing {
        scopes: scopes_in(&body, "scopes")?,
        expected: scopes_in(&body, "expected_scopes")?,
    };
    let narrowed = grants::narrow(&app, &caller, id, asked).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({
            "scopes": narrowed.scopes.literals(),
            "revoked_keys": narrowed.revoked_keys,
        }),
    ))
}

pub async fn revoke(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    uri: Uri,
    caller: Caller,
) -> Answer {
    caller.require(Permission::GrantsManage)?;
    query::only(&uri, &["revoke_keys", "remove_data"])?;
    let ending = Ending {
        revoke_keys: query::flag(&uri, "revoke_keys")?.unwrap_or(false),
        remove_data: query::flag(&uri, "remove_data")?.unwrap_or(false),
    };
    if ending.remove_data {
        caller.require(Permission::ItemsPurge)?;
    }
    grants::revoke(&app, &caller, id, ending).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "ok": true })))
}

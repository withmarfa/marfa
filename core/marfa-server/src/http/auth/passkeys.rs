//! The doors of the owner's passkeys.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::DateTime;
use serde_json::{Map, Value, json};

use super::origin;
use super::sign_in::{refuse_elsewhere, signed_in};
use super::{
    cookies, redirect, require_safe_caller, require_safe_transport, text_field, with_cookie,
};
use crate::app::access::Caller;
use crate::app::auth::passkeys::{self, Adding, Assertion, Begun, Listed};
use crate::app::auth::{Visit, form_origins, owner};
use crate::app::refusal::Refusal;
use crate::app::{App, instance};
use crate::http::answer::{Answer, json_answer};
use crate::http::body::JsonBody;
use crate::http::pages::{self, OwnerPasskey, OwnerPasskeys};

const REGISTRATION_FIELDS: [&str; 2] = ["name", "response"];
const AUTHENTICATION_FIELDS: [&str; 1] = ["response"];
const RENAME_FIELDS: [&str; 1] = ["name"];
const PAGE: &str = "/auth/owner/passkeys";
const SIGN_IN_FOR_PAGE: &str = "/auth/sign-in?return_to=%2Fauth%2Fowner%2Fpasskeys";

fn begun(app: &App, begun: Begun) -> Answer {
    let cookie = cookies::passkey_challenge(&app.addresses().sign_in(), &begun.token)?;
    Ok(with_cookie(
        json_answer(StatusCode::OK, &begun.options),
        cookie,
    ))
}

fn challenge_token(app: &App, headers: &HeaderMap) -> Option<String> {
    cookies::passkey_challenge_token(headers, &app.addresses().sign_in()).map(str::to_string)
}

fn response_in(body: &mut Map<String, Value>) -> Result<Value, Refusal> {
    match body.remove("response") {
        Some(response @ Value::Object(_)) => Ok(response),
        _ => Err(Refusal::validation("Provide `response` as an object.")),
    }
}

/// `GET /auth/passkey/generate-register-options`.
pub async fn register_options(State(app): State<Arc<App>>, caller: Caller) -> Answer {
    let started = passkeys::begin_adding(app.clone(), &caller).await?;
    begun(&app, started)
}

/// `POST /auth/passkey/verify-registration`.
pub async fn verify_registration(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    caller: Caller,
    body: JsonBody,
) -> Answer {
    let mut body = body.object(&REGISTRATION_FIELDS).await?;
    let name = match body.get("name") {
        None | Some(Value::Null) => None,
        Some(Value::String(name)) => Some(name.clone()),
        Some(_) => return Err(Refusal::validation("Provide `name` as text.").into()),
    };
    let adding = Adding {
        token: challenge_token(&app, &headers),
        name,
        response: response_in(&mut body)?,
    };
    let added = passkeys::add(app, &caller, adding).await?;
    Ok(json_answer(StatusCode::OK, &added.to_json()))
}

/// `GET /auth/passkey/generate-authenticate-options`.
pub async fn authenticate_options(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    visit: Visit,
) -> Answer {
    refuse_elsewhere(origin::said(&headers, &form_origins(&app)))?;
    let started = passkeys::begin_proving(app.clone(), &visit).await?;
    begun(&app, started)
}

/// `POST /auth/passkey/verify-authentication`.
pub async fn verify_authentication(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    require_safe_caller(&app, &visit)?;
    refuse_elsewhere(origin::said(&headers, &form_origins(&app)))?;
    let mut body = body.object(&AUTHENTICATION_FIELDS).await?;
    let assertion = Assertion {
        token: challenge_token(&app, &headers),
        response: response_in(&mut body)?,
    };
    let opened = passkeys::sign_in(app.clone(), assertion, visit).await?;
    let found = owner::find(&app).await?.ok_or_else(owner::not_found)?;
    let cookie = cookies::session(
        &app.addresses().sign_in(),
        &opened.token,
        opened.session.remembered,
    )?;
    Ok(with_cookie(
        json_answer(StatusCode::OK, &signed_in(&opened.session, &found)),
        cookie,
    ))
}

/// `GET /owner/passkeys`.
pub async fn list(State(app): State<Arc<App>>, caller: Caller) -> Answer {
    let data: Vec<Value> = passkeys::list(&app, &caller)
        .await?
        .iter()
        .map(Listed::to_json)
        .collect();
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null }),
    ))
}

/// `PATCH /owner/passkeys/{id}`.
pub async fn rename(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    caller: Caller,
    body: JsonBody,
) -> Answer {
    let body = body.object(&RENAME_FIELDS).await?;
    let name = text_field(&body, "name")?;
    let renamed = passkeys::rename(&app, &caller, id, name).await?;
    Ok(json_answer(StatusCode::OK, &renamed.to_json()))
}

/// `DELETE /owner/passkeys/{id}`.
pub async fn remove(State(app): State<Arc<App>>, Path(id): Path<String>, caller: Caller) -> Answer {
    passkeys::remove(&app, &caller, id).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "ok": true })))
}

/// `GET /_control/owner/passkeys/add-url`: where the owner's browser adds a
/// passkey. It carries no credential, so the browser signs in there.
pub async fn add_url(State(app): State<Arc<App>>, caller: Caller) -> Answer {
    caller.require_direct()?;
    let origin = app.addresses().sign_in().origin().to_string();
    let url = format!("{origin}/auth/sign-in?prompt=login&return_to={PAGE}");
    Ok(json_answer(StatusCode::OK, &json!({ "url": url })))
}

fn day_of(stamp: &str) -> String {
    DateTime::parse_from_rfc3339(stamp)
        .map(|at| at.format("%b %-d, %Y").to_string())
        .unwrap_or_default()
}

fn shown(passkey: Listed, host: &str) -> OwnerPasskey {
    OwnerPasskey {
        name: passkey.name.unwrap_or_else(|| "Passkey".to_string()),
        added: day_of(&passkey.created_at),
        last_used: passkey.last_used_at.as_deref().map(day_of),
        made_for: (passkey.host != host).then_some(passkey.host),
        id: passkey.id,
    }
}

/// `GET /auth/owner/passkeys`. Anyone but the signed-in owner goes to sign in.
pub async fn page(State(app): State<Arc<App>>, caller: Option<Caller>) -> Answer {
    require_safe_transport(&app)?;
    let Some(caller) = caller.filter(|caller| caller.session().is_some()) else {
        return redirect(StatusCode::FOUND, SIGN_IN_FOR_PAGE);
    };
    let address = app.addresses().sign_in();
    let rows = passkeys::list(&app, &caller)
        .await?
        .into_iter()
        .map(|passkey| shown(passkey, address.host()))
        .collect();
    let view = OwnerPasskeys {
        instance_name: instance::name(&app).await?,
        rows,
    };
    let page: Response = pages::owner_passkeys(&view)?.into_response();
    Ok(page)
}

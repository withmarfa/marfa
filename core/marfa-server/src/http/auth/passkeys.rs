use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};

use super::origin;
use super::sign_in::{refuse_elsewhere, signed_in};
use super::{
    cookies, redirect, require_safe_caller, require_safe_transport, text_field, with_cookie,
};
use crate::app::access::{Caller, unauthorized};
use crate::app::auth::passkeys::{self, Adding, Assertion, Begun, Listed};
use crate::app::auth::{Visit, form_origins, owner};
use crate::app::clock::Stamp;
use crate::app::refusal::Refusal;
use crate::app::{App, instance};
use crate::http::answer::{Answer, json_answer};
use crate::http::body::JsonBody;
use crate::http::caller::OnPage;
use crate::http::named_instance;
use crate::http::pages::{self, OwnerPasskey, OwnerPasskeys};
use crate::http::query;

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

pub async fn register_options(State(app): State<Arc<App>>, OnPage(caller): OnPage) -> Answer {
    let caller = caller.ok_or_else(unauthorized)?;
    let started = passkeys::begin_adding(app.clone(), &caller).await?;
    begun(&app, started)
}

pub async fn verify_registration(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    OnPage(caller): OnPage,
    body: JsonBody,
) -> Answer {
    let caller = caller.ok_or_else(unauthorized)?;
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

pub async fn authenticate_options(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    visit: Visit,
) -> Answer {
    refuse_elsewhere(origin::said(&headers, &form_origins(&app)))?;
    let started = passkeys::begin_proving(app.clone(), &visit).await?;
    begun(&app, started)
}

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
        json_answer(StatusCode::OK, &signed_in(&app, &opened.session, &found)),
        cookie,
    ))
}

pub async fn list(State(app): State<Arc<App>>, OnPage(caller): OnPage, uri: Uri) -> Answer {
    let caller = caller.ok_or_else(unauthorized)?;
    query::only(&uri, &[])?;
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

/// The owner's session is no credential to the instance header's layer, so this door judges it.
pub async fn rename(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    OnPage(caller): OnPage,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    let caller = caller.ok_or_else(unauthorized)?;
    named_instance::judge(&app, &headers)?;
    query::only(&uri, &[])?;
    let body = body.object(&RENAME_FIELDS).await?;
    let name = text_field(&body, "name")?;
    let renamed = passkeys::rename(&app, &caller, id, name).await?;
    Ok(json_answer(StatusCode::OK, &renamed.to_json()))
}

pub async fn remove(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    OnPage(caller): OnPage,
    uri: Uri,
) -> Answer {
    let caller = caller.ok_or_else(unauthorized)?;
    named_instance::judge(&app, &headers)?;
    query::only(&uri, &[])?;
    passkeys::remove(&app, &caller, id).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "ok": true })))
}

/// It carries no credential, so the browser signs in there.
pub async fn add_url(State(app): State<Arc<App>>, caller: Caller) -> Answer {
    caller.require_local()?;
    let origin = app.addresses().sign_in().origin().to_string();
    let url = format!("{origin}/auth/sign-in?prompt=login&return_to={PAGE}");
    Ok(json_answer(StatusCode::OK, &json!({ "url": url })))
}

fn day_of(stored: &str) -> Result<String, Refusal> {
    Ok(Stamp::read(stored)?.at().format("%b %-d, %Y").to_string())
}

fn shown(passkey: Listed, host: &str) -> Result<OwnerPasskey, Refusal> {
    Ok(OwnerPasskey {
        name: passkey.name.unwrap_or_else(|| "Passkey".to_string()),
        added: day_of(&passkey.created_at)?,
        last_used: passkey.last_used_at.as_deref().map(day_of).transpose()?,
        made_for: (passkey.host != host).then_some(passkey.host),
        id: passkey.id,
    })
}

/// `GET /auth/owner/passkeys`. Anyone but the signed-in owner goes to sign in.
pub async fn page(State(app): State<Arc<App>>, OnPage(caller): OnPage) -> Answer {
    require_safe_transport(&app)?;
    let Some(caller) = caller.filter(|caller| caller.session().is_some()) else {
        return redirect(StatusCode::FOUND, SIGN_IN_FOR_PAGE);
    };
    let address = app.addresses().sign_in();
    let rows = passkeys::list(&app, &caller)
        .await?
        .into_iter()
        .map(|passkey| shown(passkey, address.host()))
        .collect::<Result<_, Refusal>>()?;
    let view = OwnerPasskeys {
        instance_name: instance::name(&app).await?,
        rows,
    };
    let page: Response = pages::owner_passkeys(&view)?.into_response();
    Ok(page)
}

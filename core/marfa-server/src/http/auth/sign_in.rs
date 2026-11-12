use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Map, Value, json};

use super::origin::{self, Source};
use super::{cookies, redirect, require_safe_caller, text_field, with_cookie};
use crate::app::App;
use crate::app::access::unauthorized;
use crate::app::auth::passkeys::{self, Assertion};
use crate::app::auth::return_to::kept;
use crate::app::auth::session;
use crate::app::auth::sign_in::SignedIn;
use crate::app::auth::{Visit, form_origins, sign_in};
use crate::app::refusal::{Code, Refusal};
use crate::http::answer::{Answer, json_answer};
use crate::http::body::{JsonBody, only_declared};
use crate::http::caller::OnPage;

const PASSWORD_FIELDS: [&str; 2] = ["email", "password"];
const CONFIRM_FIELDS: [&str; 2] = ["password", "passkey"];
const CURRENT_PASSWORD_CHARS: usize = 1024;
const CHANGE_FIELDS: [&str; 2] = ["current_password", "new_password"];

fn not_from_here() -> Refusal {
    Refusal::new(
        Code::Forbidden,
        "This sign-in did not come from a page of this instance.",
    )
}

pub(super) fn refuse_elsewhere(source: Source) -> Result<(), Refusal> {
    match source {
        Source::Elsewhere => Err(not_from_here()),
        Source::Own | Source::Unsaid => Ok(()),
    }
}

/// A door that opens a browser session needs `Origin` or `Referer` to name a form origin.
pub(super) fn require_own_page(app: &App, headers: &HeaderMap) -> Result<(), Refusal> {
    match origin::said_by_form(headers, &form_origins(app)) {
        Source::Own => Ok(()),
        Source::Elsewhere | Source::Unsaid => Err(not_from_here()),
    }
}

pub(super) fn done(cookie: HeaderValue) -> Answer {
    Ok(with_cookie(
        json_answer(StatusCode::OK, &json!({ "ok": true })),
        cookie,
    ))
}

fn device_mark<'h>(app: &App, headers: &'h HeaderMap) -> Option<&'h str> {
    cookies::device_mark(headers, &app.addresses().sign_in())
}

/// The cookies the right password leaves: the session, and the device's mark.
pub(super) fn signed_in_cookies(app: &App, signed: &SignedIn) -> Result<[HeaderValue; 2], Refusal> {
    let address = app.addresses().sign_in();
    Ok([
        cookies::session(&address, &signed.opened.token)?,
        cookies::device(&address, &signed.device)?,
    ])
}

fn signed_in(app: &App, response: axum::response::Response, signed: &SignedIn) -> Answer {
    let [session, device] = signed_in_cookies(app, signed)?;
    Ok(with_cookie(with_cookie(response, session), device))
}

/// The sign-in page's form gets a redirect; a JSON body gets `{"ok": true}`.
pub async fn sign_in(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    require_safe_caller(&app, &visit)?;
    if body.declares_form() {
        return form(&app, &headers, visit, body).await;
    }
    require_own_page(&app, &headers)?;
    let body = body.object(&PASSWORD_FIELDS).await?;
    let email = text_field(&body, "email")?.to_string();
    let password = text_field(&body, "password")?.to_string();
    let mark = device_mark(&app, &headers);
    let signed = sign_in::with_password(&app, email, password, mark, visit).await?;
    let ok = json_answer(StatusCode::OK, &json!({ "ok": true }));
    signed_in(&app, ok, &signed)
}

fn back_to_sign_in(pairs: &[(&str, &str)]) -> String {
    let mut query = form_urlencoded::Serializer::new(String::new());
    for (name, value) in pairs.iter().filter(|(_, value)| !value.is_empty()) {
        query.append_pair(name, value);
    }
    let query = query.finish();
    if query.is_empty() {
        "/auth/sign-in".to_string()
    } else {
        format!("/auth/sign-in?{query}")
    }
}

async fn form(app: &Arc<App>, headers: &HeaderMap, visit: Visit, body: JsonBody) -> Answer {
    require_own_page(app, headers)?;
    let fields = body.form().await?;
    let field = |name: &str| fields.get(name).and_then(Value::as_str).unwrap_or("");
    let address = app.addresses().sign_in();
    let return_to = kept(field("return_to"), address.origin());
    let shown_return = if return_to == "/" { "" } else { &return_to };
    let email = field("email").trim();
    let password = field("password");
    let failed = |error: &str, wait: &str| {
        redirect(
            StatusCode::FOUND,
            &back_to_sign_in(&[
                ("error", error),
                ("retry_after", wait),
                ("email", email),
                ("return_to", shown_return),
                ("authorization", field("authorization")),
            ]),
        )
    };
    if email.is_empty() || password.is_empty() {
        return failed("missing_field", "");
    }
    let mark = device_mark(app, headers);
    let outcome =
        sign_in::with_password(app, email.to_string(), password.to_string(), mark, visit).await;
    let signed = match outcome {
        Ok(opened) => opened,
        Err(refusal) if refusal.code == Code::Unauthorized => {
            return failed("invalid_credentials", "");
        }
        Err(refusal) if refusal.code == Code::RateLimited => {
            let wait = refusal
                .details
                .as_ref()
                .and_then(|details| details.get("retry_after"))
                .map(Value::to_string)
                .unwrap_or_default();
            return failed("too_many_attempts", &wait);
        }
        Err(refusal) => return Err(refusal.into()),
    };
    signed_in(app, redirect(StatusCode::FOUND, &return_to)?, &signed)
}

fn ended_cookie(app: &App) -> Result<HeaderValue, Refusal> {
    cookies::session_ended(&app.addresses().sign_in())
}

pub async fn sign_out(State(app): State<Arc<App>>, OnPage(caller): OnPage, visit: Visit) -> Answer {
    let caller = caller.ok_or_else(unauthorized)?;
    session::sign_out(&app, &caller, visit).await?;
    done(ended_cookie(&app)?)
}

enum Proof {
    Password(String),
    Passkey(Value),
}

fn passkey_or_password(body: &Map<String, Value>) -> Result<Proof, Refusal> {
    match (body.get("password"), body.get("passkey")) {
        (Some(Value::String(password)), None) => {
            let length = password.chars().count();
            if (1..=CURRENT_PASSWORD_CHARS).contains(&length) {
                Ok(Proof::Password(password.clone()))
            } else {
                Err(Refusal::validation("Enter your password."))
            }
        }
        (None, Some(passkey @ Value::Object(_))) => Ok(Proof::Passkey(passkey.clone())),
        _ => Err(Refusal::validation("Send your password or a passkey.")),
    }
}

pub async fn confirm(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    OnPage(caller): OnPage,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    require_safe_caller(&app, &visit)?;
    let Some(caller) = caller.filter(|caller| caller.session().is_some()) else {
        return Err(unauthorized().into());
    };
    let body = body.object(&CONFIRM_FIELDS).await?;
    let address = app.addresses().sign_in();
    match passkey_or_password(&body)? {
        Proof::Password(password) => {
            let mark = device_mark(&app, &headers);
            let signed = sign_in::confirm(&app, &caller, password, mark, visit).await?;
            let ok = json_answer(StatusCode::OK, &json!({ "ok": true }));
            signed_in(&app, ok, &signed)
        }
        Proof::Passkey(response) => {
            let token = cookies::passkey_challenge_token(&headers, &address).map(str::to_string);
            let assertion = Assertion { token, response };
            let opened = passkeys::confirm(app.clone(), &caller, assertion, visit).await?;
            done(cookies::session(&address, &opened.token)?)
        }
    }
}

fn current_password(body: &Map<String, Value>) -> Result<String, Refusal> {
    match body.get("current_password") {
        Some(Value::String(password))
            if (1..=CURRENT_PASSWORD_CHARS).contains(&password.chars().count()) =>
        {
            Ok(password.clone())
        }
        _ => Err(Refusal::validation("Enter your current password.")),
    }
}

/// The passkeys page's form, sent as a form or as JSON.
pub async fn change_password(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    OnPage(caller): OnPage,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    require_safe_caller(&app, &visit)?;
    let Some(caller) = caller.filter(|caller| caller.session().is_some()) else {
        return Err(unauthorized().into());
    };
    let body = if body.declares_form() {
        only_declared(body.form().await?, &CHANGE_FIELDS)?
    } else {
        body.object(&CHANGE_FIELDS).await?
    };
    let current = current_password(&body)?;
    let new = text_field(&body, "new_password")?.to_string();
    let mark = device_mark(&app, &headers);
    let device = sign_in::change_password(&app, &caller, current, new, mark, visit).await?;
    let ok = json_answer(StatusCode::OK, &json!({ "ok": true }));
    Ok(with_cookie(
        ok,
        cookies::device(&app.addresses().sign_in(), &device)?,
    ))
}

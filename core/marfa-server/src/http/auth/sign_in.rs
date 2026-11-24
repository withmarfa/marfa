use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::IntoResponse;
use serde_json::{Map, Value, json};

use super::origin::{self, Source};
use super::pages::wants_page;
use super::{cookies, redirect, require_safe_caller, text_field, with_cookie};
use crate::app::App;
use crate::app::access::{Caller, Permission, unauthorized};
use crate::app::auth::passkeys::{self, Assertion};
use crate::app::auth::password;
use crate::app::auth::return_to::kept;
use crate::app::auth::session;
use crate::app::auth::sign_in::SignedIn;
use crate::app::auth::{Visit, own_origins, sign_in};
use crate::app::refusal::{Code, Refusal};
use crate::http::answer::{Answer, json_answer};
use crate::http::body::{JsonBody, only_declared};
use crate::http::caller::OnPage;
use crate::http::pages::{self, Notice};
use crate::http::query;

const PASSWORD_FIELDS: [&str; 2] = ["username", "password"];
const CONFIRM_FIELDS: [&str; 2] = ["password", "passkey"];
const CURRENT_PASSWORD_CHARS: usize = 1024;
const CHANGE_FIELDS: [&str; 2] = ["current_password", "new_password"];
const CHANGE_PAGE_FIELDS: [&str; 3] = ["current_password", "new_password", "confirm_password"];
const PASSKEYS_PAGE: &str = "/auth/owner/passkeys";

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

/// A door that opens a browser session needs `Origin` or `Referer` to name the sign-in address.
pub(super) fn require_own_page(app: &App, headers: &HeaderMap) -> Result<(), Refusal> {
    match origin::said_by_form(headers, &own_origins(app)) {
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
    let username = text_field(&body, "username")?.to_string();
    let password = text_field(&body, "password")?.to_string();
    let mark = device_mark(&app, &headers);
    let signed = sign_in::with_password(&app, username, password, mark, visit).await?;
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
    let username = field("username").trim();
    let password = field("password");
    let failed = |error: &str, wait: &str, missing: [&str; 2]| {
        redirect(
            StatusCode::FOUND,
            &back_to_sign_in(&[
                ("error", error),
                ("retry_after_seconds", wait),
                ("missing", missing[0]),
                ("missing", missing[1]),
                ("username", username),
                ("return_to", shown_return),
                ("authorization", field("authorization")),
            ]),
        )
    };
    if username.is_empty() || password.is_empty() {
        let named = |empty: bool, name| if empty { name } else { "" };
        return failed(
            "missing_field",
            "",
            [
                named(username.is_empty(), "username"),
                named(password.is_empty(), "password"),
            ],
        );
    }
    let mark = device_mark(app, headers);
    let outcome =
        sign_in::with_password(app, username.to_string(), password.to_string(), mark, visit).await;
    let signed = match outcome {
        Ok(opened) => opened,
        Err(refusal) if refusal.code == Code::Unauthorized => {
            return failed("invalid_credentials", "", ["", ""]);
        }
        Err(refusal) if refusal.code == Code::RateLimited => {
            let wait = refusal
                .details
                .as_ref()
                .and_then(|details| details.get("retry_after_seconds"))
                .map(Value::to_string)
                .unwrap_or_default();
            return failed("too_many_attempts", &wait, ["", ""]);
        }
        Err(refusal) => return Err(refusal.into()),
    };
    signed_in(app, redirect(StatusCode::FOUND, &return_to)?, &signed)
}

fn ended_cookie(app: &App) -> Result<HeaderValue, Refusal> {
    cookies::session_ended(&app.addresses().sign_in())
}

/// A browser's form asks for a page, and gets the notice that it is signed out.
pub async fn sign_out(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    OnPage(caller): OnPage,
    visit: Visit,
) -> Answer {
    let caller = caller.ok_or_else(unauthorized)?;
    session::sign_out(&app, &caller, visit).await?;
    if wants_page(&headers) {
        let page = pages::notice(&Notice::signed_out())?.into_response();
        return Ok(with_cookie(page, ended_cookie(&app)?));
    }
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

fn back_to_passkeys(pairs: &[(&str, &str)]) -> String {
    let mut query = form_urlencoded::Serializer::new(String::new());
    for (name, value) in pairs.iter().filter(|(_, value)| !value.is_empty()) {
        query.append_pair(name, value);
    }
    let query = query.finish();
    if query.is_empty() {
        PASSKEYS_PAGE.to_string()
    } else {
        format!("{PASSKEYS_PAGE}?{query}")
    }
}

fn page_problem(problem: &str, wait: &str) -> Answer {
    redirect(
        StatusCode::SEE_OTHER,
        &back_to_passkeys(&[("problem", problem), ("retry_after_seconds", wait)]),
    )
}

async fn change_from_page(
    app: &Arc<App>,
    headers: &HeaderMap,
    caller: Option<Caller>,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    let Some(caller) = caller.filter(|caller| caller.session().is_some()) else {
        return Err(unauthorized().into());
    };
    let fields = only_declared(body.form().await?, &CHANGE_PAGE_FIELDS)?;
    let Ok(current) = current_password(&fields) else {
        return page_problem("current_missing", "");
    };
    let field = |name: &str| fields.get(name).and_then(Value::as_str).unwrap_or("");
    let new = field("new_password");
    let length = new.chars().count();
    if length < password::MIN_LENGTH {
        return page_problem("new_too_short", "");
    }
    if length > password::MAX_LENGTH {
        return page_problem("new_too_long", "");
    }
    if new != field("confirm_password") {
        return page_problem("not_the_same", "");
    }
    let mark = device_mark(app, headers);
    let outcome =
        sign_in::change_password(app, &caller, current, new.to_string(), mark, visit).await;
    match outcome {
        Ok(changed) => {
            let done = redirect(
                StatusCode::SEE_OTHER,
                &back_to_passkeys(&[("changed", "1")]),
            )?;
            Ok(with_cookie(
                done,
                cookies::device(&app.addresses().sign_in(), &changed.device(app)?)?,
            ))
        }
        Err(refusal) if sign_in::is_current_not_right(&refusal) => {
            page_problem("current_not_right", "")
        }
        Err(refusal) if refusal.code == Code::RateLimited => {
            let wait = refusal
                .details
                .as_ref()
                .and_then(|details| details.get("retry_after_seconds"))
                .map(Value::to_string)
                .unwrap_or_default();
            page_problem("too_many_attempts", &wait)
        }
        Err(refusal) => Err(refusal.into()),
    }
}

pub async fn change_password(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    OnPage(caller): OnPage,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    require_safe_caller(&app, &visit)?;
    if body.declares_form() && wants_page(&headers) {
        return change_from_page(&app, &headers, caller, visit, body).await;
    }
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
    let changed = sign_in::change_password(&app, &caller, current, new, mark, visit).await?;
    let ok = json_answer(StatusCode::OK, &json!({ "ok": true }));
    Ok(with_cookie(
        ok,
        cookies::device(&app.addresses().sign_in(), &changed.device(&app)?)?,
    ))
}

/// `PUT /owner/password`: the same change, for a key, an app or the private socket.
pub async fn replace_password(
    State(app): State<Arc<App>>,
    caller: Caller,
    visit: Visit,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    caller.require(Permission::SignInsManage)?;
    query::only(&uri, &[])?;
    let body = body.object(&CHANGE_FIELDS).await?;
    for field in CHANGE_FIELDS {
        if !body.contains_key(field) {
            return Err(
                Refusal::new(Code::MissingRequiredField, format!("{field} is required."))
                    .with_detail("field", field)
                    .into(),
            );
        }
    }
    let current = current_password(&body)?;
    let new = text_field(&body, "new_password")?.to_string();
    sign_in::change_password(&app, &caller, current, new, None, visit).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "ok": true })))
}

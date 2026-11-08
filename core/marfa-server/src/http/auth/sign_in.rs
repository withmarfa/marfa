use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{Map, Value, json};

use super::origin::{self, Source};
use super::{cookies, redirect, require_safe_caller, text_field, with_cookie};
use crate::app::App;
use crate::app::access::{Caller, unauthorized};
use crate::app::auth::passkeys::{self, Assertion};
use crate::app::auth::return_to::kept;
use crate::app::auth::session::{self, Opened, Session};
use crate::app::auth::{Visit, form_origins, owner, sign_in};
use crate::app::refusal::{Code, Refusal};
use crate::http::answer::{Answer, json_answer};
use crate::http::body::JsonBody;
use crate::http::caller::identify;

const EMAIL_FIELDS: [&str; 3] = ["email", "password", "rememberMe"];
const CHANGE_FIELDS: [&str; 3] = ["currentPassword", "newPassword", "revokeOtherSessions"];
const CONFIRM_FIELDS: [&str; 2] = ["password", "passkey"];
const CONFIRM_PASSWORD_CHARS: usize = 1024;

pub(super) fn refuse_elsewhere(source: Source) -> Result<(), Refusal> {
    if source == Source::Elsewhere {
        return Err(Refusal::new(
            Code::Forbidden,
            "This sign-in did not come from a page of this instance.",
        ));
    }
    Ok(())
}

pub(super) fn signed_in(app: &App, session: &Session, owner: &owner::Owner) -> Value {
    let origin = app.addresses().sign_in().origin().to_string();
    json!({ "session": session.to_json(), "user": owner.to_json(&origin) })
}

pub async fn email(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    require_safe_caller(&app, &visit)?;
    refuse_elsewhere(origin::said(&headers, &form_origins(&app)))?;
    let body = body.object(&EMAIL_FIELDS).await?;
    let remembered = match body.get("rememberMe") {
        None => true,
        Some(Value::Bool(remembered)) => *remembered,
        Some(_) => return Err(Refusal::validation("`rememberMe` must be true or false.").into()),
    };
    let email = text_field(&body, "email")?.to_string();
    let password = text_field(&body, "password")?.to_string();
    let opened = sign_in::with_password(&app, email, password, remembered, visit).await?;
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

/// The sign-in form, which answers only by redirecting.
pub async fn form(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    require_safe_caller(&app, &visit)?;
    refuse_elsewhere(origin::said_by_form(&headers, &form_origins(&app)))?;
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
    let outcome =
        sign_in::with_password(&app, email.to_string(), password.to_string(), true, visit).await;
    let Opened { token, session } = match outcome {
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
    let cookie = cookies::session(&address, &token, session.remembered)?;
    Ok(with_cookie(
        redirect(StatusCode::FOUND, &return_to)?,
        cookie,
    ))
}

/// `GET /auth/get-session`. Nobody signed in is an answer, and a session that
/// could not be read is not that answer.
pub async fn get_session(State(app): State<Arc<App>>, request: Request) -> Answer {
    let (mut parts, _) = request.into_parts();
    let caller = identify(&mut parts, &app).await?;
    let Some(session) = caller.as_ref().and_then(Caller::session) else {
        return Ok(json_answer(StatusCode::OK, &Value::Null));
    };
    let Some(found) = owner::find(&app).await? else {
        return Ok(json_answer(StatusCode::OK, &Value::Null));
    };
    Ok(json_answer(
        StatusCode::OK,
        &signed_in(&app, session, &found),
    ))
}

fn ended_cookie(app: &App) -> Result<axum::http::HeaderValue, Refusal> {
    cookies::session_ended(&app.addresses().sign_in())
}

fn signed_out(app: &App, value: &Value) -> Result<Response, Refusal> {
    Ok(with_cookie(
        json_answer(StatusCode::OK, value),
        ended_cookie(app)?,
    ))
}

pub async fn sign_out(State(app): State<Arc<App>>, caller: Caller, visit: Visit) -> Answer {
    session::sign_out(&app, &caller, visit).await?;
    Ok(signed_out(&app, &json!({ "success": true }))?)
}

pub async fn revoke_sessions(State(app): State<Arc<App>>, caller: Caller, visit: Visit) -> Answer {
    session::end_many(&app, &caller, false, visit).await?;
    Ok(signed_out(&app, &json!({ "status": true }))?)
}

pub async fn revoke_other_sessions(
    State(app): State<Arc<App>>,
    caller: Caller,
    visit: Visit,
) -> Answer {
    session::end_many(&app, &caller, true, visit).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "status": true })))
}

enum Proof {
    Password(String),
    Passkey(Value),
}

fn passkey_or_password(body: &Map<String, Value>) -> Result<Proof, Refusal> {
    match (body.get("password"), body.get("passkey")) {
        (Some(Value::String(password)), None) => {
            let length = password.chars().count();
            if (1..=CONFIRM_PASSWORD_CHARS).contains(&length) {
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
    caller: Caller,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    require_safe_caller(&app, &visit)?;
    if caller.session().is_none() {
        return Err(unauthorized().into());
    }
    let body = body.object(&CONFIRM_FIELDS).await?;
    let address = app.addresses().sign_in();
    let opened = match passkey_or_password(&body)? {
        Proof::Password(password) => sign_in::confirm(&app, &caller, password, visit).await?,
        Proof::Passkey(response) => {
            let token = cookies::passkey_challenge_token(&headers, &address).map(str::to_string);
            let assertion = Assertion { token, response };
            passkeys::confirm(app.clone(), &caller, assertion, visit).await?
        }
    };
    let cookie = cookies::session(&address, &opened.token, opened.session.remembered)?;
    Ok(with_cookie(
        json_answer(StatusCode::OK, &json!({ "ok": true })),
        cookie,
    ))
}

pub async fn change_password(
    State(app): State<Arc<App>>,
    caller: Caller,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    require_safe_caller(&app, &visit)?;
    if caller.session().is_none() {
        return Err(unauthorized().into());
    }
    let body = body.object(&CHANGE_FIELDS).await?;
    if !matches!(
        body.get("revokeOtherSessions"),
        None | Some(Value::Bool(true))
    ) {
        return Err(Refusal::validation("A password change ends every other session.").into());
    }
    let current = text_field(&body, "currentPassword")?.to_string();
    let new = text_field(&body, "newPassword")?.to_string();
    sign_in::change_password(&app, &caller, current, new, visit).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "status": true })))
}

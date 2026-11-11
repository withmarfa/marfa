use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};

use super::origin::{self, Source, not_our_page};
use super::pages::{self, Typed};
use super::{cookies, redirect, require_safe_caller, with_cookie};
use crate::app::App;
use crate::app::auth::claim::{self, Proof};
use crate::app::auth::owner::{Details, Owner, incomplete_claim};
use crate::app::auth::{Visit, own_origins, sign_in};
use crate::app::refusal::Refusal;
use crate::http::answer::{Answer, Stopped, json_answer};
use crate::http::body::{JsonBody, only_declared};

const EXCHANGE_FIELDS: [&str; 2] = ["ticket", "code"];
const CLAIM_FIELDS: [&str; 4] = ["email", "password", "name", "code"];
const AFTER_CLAIM: &str = "/auth/sign-in";

pub async fn exchange(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    require_safe_caller(&app, &visit)?;
    if origin::said(&headers, &own_origins(&app)) != Source::Own {
        return Err(not_our_page().into());
    }
    let form = body.declares_form();
    let fields = if form {
        only_declared(body.form().await?, &EXCHANGE_FIELDS)?
    } else {
        body.object(&EXCHANGE_FIELDS).await?
    };
    let text = |name: &str| fields.get(name).and_then(Value::as_str);
    let exchanged = match (text("ticket"), text("code")) {
        (Some(ticket), _) if !form => claim::exchange_ticket(&app, ticket, visit).await,
        (_, Some(code)) if !code.trim().is_empty() || !form => {
            claim::exchange_code(&app, code, visit).await
        }
        _ => Err(Refusal::validation(
            "Enter a setup code or open a new setup link.",
        )),
    };
    let session = match exchanged {
        Ok(session) => session,
        Err(refusal) if form && pages::wants_page(&headers) => {
            return Ok(pages::exchange_refused(&app, &refusal).await?);
        }
        Err(refusal) => return Err(refusal.into()),
    };
    let cookie = cookies::setup(&app.addresses().sign_in(), &session.token)?;
    let answer = if form {
        redirect(StatusCode::SEE_OTHER, "/setup")?
    } else {
        json_answer(StatusCode::OK, &json!({ "ok": true }))
    };
    Ok(with_cookie(answer, cookie))
}

fn is_script(headers: &HeaderMap) -> bool {
    !headers.contains_key("sec-fetch-site") && !cookies::holds_setup(headers)
}

/// The claim both `POST /owner` and `POST /setup/claim` make. A browser on
/// this instance's own page is signed in by it; a script gets no session.
pub(super) async fn make_claim(
    app: &Arc<App>,
    headers: &HeaderMap,
    visit: Visit,
    fields: Map<String, Value>,
) -> Result<(Owner, Option<axum::http::HeaderValue>), Stopped> {
    let fields = only_declared(fields, &CLAIM_FIELDS)?;
    if fields.get("name").is_some_and(|name| !name.is_string()) {
        return Err(incomplete_claim().into());
    }
    let text = |name: &str| fields.get(name).and_then(Value::as_str);
    let password = text("password").unwrap_or("").to_string();
    let details = Details::new(text("email").unwrap_or(""), text("name"), password.clone())?;
    let proof = match text("code") {
        Some(code) => Proof::Code(code.to_string()),
        None => Proof::Session(cookies::setup_token(headers).unwrap_or("").to_string()),
    };
    let owner = claim::claim(app, details, proof, visit.clone()).await?;
    if origin::said(headers, &own_origins(app)) != Source::Own {
        return Ok((owner, None));
    }
    let opening = sign_in::with_password(app, owner.email.clone(), password, visit).await;
    let cookie = match opening {
        Ok(opened) => Some(cookies::session(&app.addresses().sign_in(), &opened.token)?),
        Err(refusal) => {
            tracing::warn!(code = refusal.code.wire(), "a claim left no session open");
            None
        }
    };
    Ok((owner, cookie))
}

/// Refuses a claim from anywhere but this instance's page or a script, once
/// the instance is known to be open to one.
pub(super) async fn admit_claim(
    app: &App,
    headers: &HeaderMap,
    visit: &Visit,
) -> Result<(), Stopped> {
    require_safe_caller(app, visit)?;
    if claim::is_claimed(app).await? {
        return Err(claim::already_claimed().into());
    }
    match origin::said(headers, &own_origins(app)) {
        Source::Own => Ok(()),
        Source::Unsaid if is_script(headers) => Ok(()),
        _ => Err(not_our_page().into()),
    }
}

pub async fn claim(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    admit_claim(&app, &headers, &visit).await?;
    let form = body.declares_form();
    let fields = if form {
        body.form().await?
    } else {
        body.open_object().await?
    };
    let browser = form && origin::said(&headers, &own_origins(&app)) == Source::Own;
    let typed = Typed::of(&fields);
    let (owner, session) = match make_claim(&app, &headers, visit, fields).await {
        Err(Stopped::Refused(refusal)) if browser && pages::wants_page(&headers) => {
            return Ok(pages::claim_refused(&app, &refusal, typed).await?);
        }
        claimed => claimed?,
    };
    let mut answer = if browser {
        redirect(StatusCode::SEE_OTHER, AFTER_CLAIM)?
    } else {
        json_answer(
            StatusCode::CREATED,
            &owner.to_json(app.addresses().sign_in().origin()),
        )
    };
    answer = with_cookie(answer, cookies::setup_ended(&app.addresses().sign_in())?);
    if let Some(session) = session {
        answer = with_cookie(answer, session);
    }
    Ok(answer)
}

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};

use super::origin::{self, Source, not_our_page};
use super::pages::{self, CodeForm, Typed};
use super::sign_in::signed_in_cookies;
use super::{cookies, redirect, require_safe_caller, with_cookie};
use crate::app::App;
use crate::app::auth::claim::{self, Presented, Proof};
use crate::app::auth::owner::{Details, Owner, optional_email, optional_text};
use crate::app::auth::return_to::{HOME, encoded, kept, through_sign_in};
use crate::app::auth::{Visit, own_origins, sign_in};
use crate::app::refusal::{Code, Refusal};
use crate::http::answer::{Answer, Stopped, json_answer};
use crate::http::body::{JsonBody, only_declared};

const EXCHANGE_FIELDS: [&str; 2] = ["ticket", "code"];
const EXCHANGE_FORM_FIELDS: [&str; 3] = ["code", RETURN_TO, PURPOSE];
const CLAIM_FIELDS: [&str; 5] = ["username", "password", "name", "email", "code"];
const RECOVER_FIELDS: [&str; 2] = ["password", "code"];
const RECOVER_FORM_FIELDS: [&str; 3] = ["password", "code", CONFIRM];
/// A page's second password field. A script's body has none, so it is never asked for one.
const CONFIRM: &str = "confirm_password";
const AFTER_CLAIM: &str = "/auth/sign-in";
/// Where the browser goes once the instance is claimed. Only the setup pages' forms carry it.
const RETURN_TO: &str = "return_to";
/// Only the recovery code form carries it, so a form without it holds a setup code.
const PURPOSE: &str = "purpose";
const RECOVERY: &str = "recovery";

/// Takes the confirmation out of a form's fields and refuses a password it does not repeat.
fn take_confirmation(fields: &mut Map<String, Value>) -> Result<(), Refusal> {
    let Some(confirm) = fields.remove(CONFIRM) else {
        return Ok(());
    };
    let repeated = fields.get("password").and_then(Value::as_str) == confirm.as_str();
    if repeated {
        Ok(())
    } else {
        Err(Refusal::invalid_at(
            "password",
            "The passwords don't match.",
        ))
    }
}

/// A form's `return_to` as `kept` reads it, taken out of the fields.
fn take_return_to(app: &App, fields: &mut Map<String, Value>) -> String {
    match fields.remove(RETURN_TO) {
        Some(Value::String(value)) => kept(&value, app.addresses().sign_in().origin()),
        _ => HOME.to_owned(),
    }
}

fn code_form(app: &App, fields: &mut Map<String, Value>) -> Result<CodeForm, Refusal> {
    match fields.remove(PURPOSE) {
        None => Ok(CodeForm::Setup(take_return_to(app, fields))),
        Some(Value::String(purpose)) if purpose == RECOVERY && !fields.contains_key(RETURN_TO) => {
            Ok(CodeForm::Recovery)
        }
        Some(_) => Err(Refusal::validation(
            "A code form's purpose can only be recovery, which carries no return_to.",
        )),
    }
}

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
    if !body.declares_form() {
        let fields = body.object(&EXCHANGE_FIELDS).await?;
        let text = |name: &str| fields.get(name).and_then(Value::as_str);
        let session = match (text("ticket"), text("code")) {
            (Some(ticket), _) => claim::exchange_ticket(&app, ticket, visit).await?,
            (_, Some(code)) => claim::exchange_code(&app, code, visit).await?,
            _ => {
                return Err(
                    Refusal::validation("Enter a setup code or open a new setup link.").into(),
                );
            }
        };
        let cookie = cookies::setup(&app.addresses().sign_in(), &session.token)?;
        let answer = json_answer(StatusCode::OK, &json!({ "ok": true }));
        return Ok(with_cookie(answer, cookie));
    }
    let mut fields = only_declared(body.form().await?, &EXCHANGE_FORM_FIELDS)?;
    let form = code_form(&app, &mut fields)?;
    let code = fields
        .get("code")
        .and_then(Value::as_str)
        .filter(|code| !code.trim().is_empty());
    let exchanged = match (code, &form) {
        (Some(code), CodeForm::Setup(_)) => claim::exchange_setup_code(&app, code, visit).await,
        (Some(code), CodeForm::Recovery) => claim::exchange_code(&app, code, visit).await,
        (None, CodeForm::Setup(_)) if claim::is_claimed(&app).await? => {
            Err(claim::already_claimed())
        }
        (None, _) => Err(Refusal::validation(
            "Enter a setup code or open a new setup link.",
        )),
    };
    let session = match exchanged {
        Ok(session) => session,
        Err(refusal) if pages::wants_page(&headers) => {
            return Ok(pages::exchange_refused(&app, &refusal, &form).await?);
        }
        Err(refusal) => return Err(refusal.into()),
    };
    let cookie = cookies::setup(&app.addresses().sign_in(), &session.token)?;
    let next = match &form {
        CodeForm::Setup(back) if back != HOME => format!("/setup?{RETURN_TO}={}", encoded(back)),
        _ => "/setup".to_owned(),
    };
    Ok(with_cookie(redirect(StatusCode::SEE_OTHER, &next)?, cookie))
}

/// A code in the body, or else the setup cookie.
fn presented(headers: &HeaderMap, code: Option<&str>) -> Presented {
    match code {
        Some(code) => Presented::Code(code.to_string()),
        None => Presented::Session(cookies::setup_token(headers).unwrap_or("").to_string()),
    }
}

fn is_script(headers: &HeaderMap) -> bool {
    !headers.contains_key("sec-fetch-site") && !cookies::holds_setup(headers)
}

/// The claim both `POST /owner` and `POST /setup/claim` make. A browser on
/// this instance's own page is signed in by it, and gets its cookies; a script gets none.
pub(super) async fn make_claim(
    app: &Arc<App>,
    headers: &HeaderMap,
    visit: Visit,
    fields: Map<String, Value>,
) -> Result<(Owner, Vec<axum::http::HeaderValue>), Stopped> {
    let fields = only_declared(fields, &CLAIM_FIELDS)?;
    let text = |name: &str| fields.get(name).and_then(Value::as_str);
    let password = text("password").unwrap_or("").to_string();
    let details = Details::new(
        text("username").unwrap_or(""),
        optional_email(&fields)?,
        optional_text(&fields, "name")?,
        password.clone(),
    )?;
    let proof = Proof::Presented(presented(headers, text("code")));
    let owner = claim::claim(app, details, proof, visit.clone()).await?;
    if origin::said(headers, &own_origins(app)) != Source::Own {
        return Ok((owner, Vec::new()));
    }
    let opening = sign_in::with_password(app, owner.username.clone(), password, None, visit).await;
    let cookies = match opening {
        Ok(signed) => signed_in_cookies(app, &signed)?.to_vec(),
        Err(refusal) => {
            tracing::warn!(code = refusal.code.wire(), "a claim left no session open");
            Vec::new()
        }
    };
    Ok((owner, cookies))
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
    let admitted = admit_claim(&app, &headers, &visit).await;
    let form = body.declares_form();
    let browser = form && origin::said(&headers, &own_origins(&app)) == Source::Own;
    if let Err(Stopped::Refused(refusal)) = &admitted
        && refusal.code == Code::OwnerExists
        && browser
        && pages::wants_page(&headers)
    {
        let mut fields = body.form().await?;
        let return_to = take_return_to(&app, &mut fields);
        return Ok(pages::claim_refused(&app, refusal, Typed::of(&fields), return_to).await?);
    }
    admitted?;
    let (mut fields, return_to) = if form {
        let mut fields = body.form().await?;
        let return_to = take_return_to(&app, &mut fields);
        (fields, return_to)
    } else {
        (body.open_object().await?, HOME.to_owned())
    };
    let typed = Typed::of(&fields);
    if form
        && fields
            .get("email")
            .and_then(Value::as_str)
            .is_some_and(|email| email.trim().is_empty())
    {
        fields.remove("email");
    }
    let confirmed = if form {
        take_confirmation(&mut fields)
    } else {
        Ok(())
    };
    let claimed = match confirmed {
        Ok(()) => make_claim(&app, &headers, visit, fields).await,
        Err(refusal) => Err(refusal.into()),
    };
    let (owner, signed_in) = match claimed {
        Err(Stopped::Refused(refusal)) if browser && pages::wants_page(&headers) => {
            return Ok(pages::claim_refused(&app, &refusal, typed, return_to).await?);
        }
        claimed => claimed?,
    };
    let mut answer = if browser {
        let next = if return_to == HOME {
            AFTER_CLAIM.to_owned()
        } else if signed_in.is_empty() {
            through_sign_in(&return_to)
        } else {
            return_to
        };
        redirect(StatusCode::SEE_OTHER, &next)?
    } else {
        json_answer(
            StatusCode::CREATED,
            &owner.to_json(app.addresses().sign_in().origin()),
        )
    };
    answer = with_cookie(answer, cookies::setup_ended(&app.addresses().sign_in())?);
    for cookie in signed_in {
        answer = with_cookie(answer, cookie);
    }
    Ok(answer)
}

/// Sets the owner's password with a recovery code, or the session one opened.
pub async fn recover(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    require_safe_caller(&app, &visit)?;
    let said = origin::said(&headers, &own_origins(&app));
    match said {
        Source::Own => {}
        Source::Unsaid if is_script(&headers) => {}
        _ => return Err(not_our_page().into()),
    }
    let form = body.declares_form();
    let mut fields = if form {
        only_declared(body.form().await?, &RECOVER_FORM_FIELDS)?
    } else {
        body.object(&RECOVER_FIELDS).await?
    };
    let browser = form && said == Source::Own;
    let confirmed = if form {
        take_confirmation(&mut fields)
    } else {
        Ok(())
    };
    let text = |name: &str| fields.get(name).and_then(Value::as_str);
    let proof = presented(&headers, text("code"));
    let password = text("password").unwrap_or("").to_string();
    let recovered = match confirmed {
        Ok(()) => claim::recover(&app, proof, password, visit).await,
        Err(refusal) => Err(refusal),
    };
    match recovered {
        Err(refusal) if browser && pages::wants_page(&headers) => {
            return Ok(pages::recover_refused(&app, &refusal).await?);
        }
        recovered => recovered?,
    }
    let answer = if browser {
        redirect(StatusCode::SEE_OTHER, AFTER_CLAIM)?
    } else {
        json_answer(StatusCode::OK, &json!({ "recovered": true }))
    };
    Ok(with_cookie(
        answer,
        cookies::setup_ended(&app.addresses().sign_in())?,
    ))
}

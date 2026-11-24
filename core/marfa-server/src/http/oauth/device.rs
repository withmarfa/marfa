use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::IntoResponse;

use super::{Browser, Fields, problem_answer};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::auth::Visit;
use crate::app::auth::return_to::encoded;
use crate::app::oauth::authorize::sign_in_then;
use crate::app::oauth::device::{
    self, Answer as Answered, Blocked, CHECK_PATH as CHECK, CONSENT_PATH as CONSENT, Lookup,
    NotOpen,
};
use crate::app::oauth::token::Form;
use crate::app::oauth::tokens::normalize_user_code;
use crate::app::refusal::{Code, Refusal};
use crate::http::answer::{Answer, json_answer};
use crate::http::auth::redirect;
use crate::http::body::JsonBody;
use crate::http::pages::{self, Answering, Consent, DeviceCheck, Notice};
use crate::http::query;

const ENTRY: &str = "/auth/device";

fn to_entry(error: &str) -> Answer {
    redirect(StatusCode::FOUND, &format!("{ENTRY}?error={error}"))
}

fn to_entry_with_code(error: &str, typed: &str) -> Answer {
    redirect(
        StatusCode::FOUND,
        &format!("{ENTRY}?error={error}&user_code={}", encoded(typed)),
    )
}

fn too_many(wait_ms: i64) -> Answer {
    let seconds = (wait_ms + 999) / 1_000;
    to_entry(&format!("too_many_attempts&retry_after_seconds={seconds}"))
}

fn blocked(lookup: Lookup, typed: &str) -> Answer {
    match lookup {
        Lookup::Unknown => to_entry_with_code("invalid_code", typed),
        Lookup::Expired => to_entry_with_code("expired_code", typed),
        Lookup::Resolved | Lookup::Pending => to_entry_with_code("already_resolved", typed),
    }
}

pub async fn code(
    State(app): State<Arc<App>>,
    visit: Visit,
    headers: HeaderMap,
    body: JsonBody,
) -> Answer {
    let form = Form {
        pairs: body.form_pairs().await?,
        authorization: headers.contains_key(header::AUTHORIZATION),
    };
    let asked = device::request(&app, &form, &visit).await?;
    match asked {
        Ok(answer) => Ok(json_answer(StatusCode::OK, &answer)),
        Err(problem) => problem_answer(&problem),
    }
}

pub async fn enter(
    State(app): State<Arc<App>>,
    visit: Visit,
    Browser(owner): Browser,
    body: JsonBody,
) -> Answer {
    let fields = Fields(body.form_pairs().await?);
    let typed = fields.get("user_code").unwrap_or_default().trim();
    if typed.is_empty() {
        return to_entry("missing_code");
    }
    if let Some(wait) = device::admit_lookup(&app, visit.address, owner.as_ref()) {
        return too_many(wait);
    }
    match device::look_up(&app, typed).await? {
        Lookup::Pending => to_check(typed),
        lookup => blocked(lookup, typed),
    }
}

fn to_check(typed: &str) -> Answer {
    redirect(StatusCode::FOUND, &check_page(typed))
}

fn check_page(typed: &str) -> String {
    format!("{CHECK}?user_code={}", encoded(typed))
}

fn to_sign_in(app: &App, typed: Option<&str>) -> Answer {
    let back = typed.map_or(CHECK.to_string(), check_page);
    redirect(StatusCode::FOUND, &sign_in_then(app, &back))
}

/// The sign-in page shows its form to a browser already signed in only under `prompt=login`.
fn to_sign_in_again(app: &App, typed: &str) -> Answer {
    let page = sign_in_then(app, &check_page(typed));
    redirect(StatusCode::FOUND, &format!("{page}&prompt=login"))
}

fn signed_in(owner: Option<Caller>) -> Option<Caller> {
    owner.filter(|caller| caller.session().is_some())
}

fn not_open(app: &App, not_open: NotOpen, typed: &str) -> Answer {
    match not_open {
        NotOpen::Code(lookup) => blocked(lookup, typed),
        NotOpen::SignInAgain => to_sign_in_again(app, typed),
    }
}

fn typed_in(uri: &Uri) -> Result<Option<String>, Refusal> {
    Ok(query::pairs(uri)?
        .into_iter()
        .find(|(key, _)| key == "user_code")
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

/// Asks the owner to compare the code with the device's before the approval page opens, so a
/// link someone sent cannot carry their device past the owner.
pub async fn check_screen(
    State(app): State<Arc<App>>,
    visit: Visit,
    Browser(owner): Browser,
    uri: Uri,
) -> Answer {
    let typed = typed_in(&uri)?;
    let Some(owner) = signed_in(owner) else {
        return to_sign_in(&app, typed.as_deref());
    };
    let Some(typed) = typed else {
        return to_entry("missing_code");
    };
    if let Some(wait) = device::admit_lookup(&app, visit.address, Some(&owner)) {
        return too_many(wait);
    }
    match device::to_check(&app, &typed, &owner).await? {
        Ok(()) => {
            let view = DeviceCheck {
                user_code: normalize_user_code(&typed),
                typed,
            };
            Ok(pages::device_check(&view)?.into_response())
        }
        Err(closed) => not_open(&app, closed, &typed),
    }
}

pub async fn check(
    State(app): State<Arc<App>>,
    visit: Visit,
    Browser(owner): Browser,
    body: JsonBody,
) -> Answer {
    let fields = Fields(body.form_pairs().await?);
    let typed = fields
        .get("user_code")
        .map(str::trim)
        .filter(|typed| !typed.is_empty());
    let Some(owner) = signed_in(owner) else {
        return to_sign_in(&app, typed);
    };
    let Some(typed) = typed else {
        return to_entry("missing_code");
    };
    if let Some(wait) = device::admit_lookup(&app, visit.address, Some(&owner)) {
        return too_many(wait);
    }
    match device::check(&app, typed, &owner).await? {
        Ok(()) => redirect(
            StatusCode::FOUND,
            &format!("{CONSENT}?user_code={}", encoded(typed)),
        ),
        Err(closed) => not_open(&app, closed, typed),
    }
}

pub async fn screen(State(app): State<Arc<App>>, Browser(owner): Browser, uri: Uri) -> Answer {
    let typed = typed_in(&uri)?;
    let Some(owner) = signed_in(owner) else {
        return to_sign_in(&app, typed.as_deref());
    };
    let Some(typed) = typed else {
        return to_entry("missing_code");
    };
    match device::screen(&app, &typed, &owner).await? {
        Ok(offer) => {
            let view = Consent {
                offer: *offer,
                answering: Answering::Device(typed),
            };
            Ok(pages::consent(&view)?.into_response())
        }
        Err(Blocked::Unchecked) => to_check(&typed),
        Err(Blocked::Code(lookup)) => blocked(lookup, &typed),
        Err(Blocked::SignInAgain) => to_sign_in_again(&app, &typed),
        Err(Blocked::ClientGone) => {
            Err(Refusal::new(Code::InvalidClient, "This app is gone.").into())
        }
    }
}

pub async fn answer(
    State(app): State<Arc<App>>,
    Browser(owner): Browser,
    body: JsonBody,
) -> Answer {
    let fields = Fields(body.form_pairs().await?);
    let typed = fields.get("user_code").map(str::trim);
    let Some(owner) = signed_in(owner) else {
        return to_sign_in(&app, typed);
    };
    let typed = typed
        .filter(|typed| !typed.is_empty())
        .ok_or_else(|| Refusal::validation("Provide `user_code` as text."))?;
    let approve = match fields.get("decision") {
        Some("approve") => true,
        Some("deny") => false,
        _ => return Err(Refusal::validation("Provide `decision` as approve or deny.").into()),
    };
    let answered = device::answer(&app, &owner, typed, approve, fields.post()).await?;
    match answered {
        Answered::Approved => Ok(pages::notice(&Notice::device_approved())?.into_response()),
        Answered::Denied => Ok(pages::notice(&Notice::device_denied())?.into_response()),
        Answered::Unchecked => to_check(typed),
        Answered::Code(lookup) => blocked(lookup, typed),
        Answered::SignInAgain => to_sign_in_again(&app, typed),
    }
}

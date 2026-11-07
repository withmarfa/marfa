use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::IntoResponse;

use super::{Browser, Fields, problem_answer, require_own_form};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::auth::Visit;
use crate::app::instance;
use crate::app::oauth::authorize::sign_in_then;
use crate::app::oauth::device::{self, Answer as Answered, Blocked, Lookup};
use crate::app::refusal::{Code, Refusal};
use crate::http::answer::{Answer, json_answer};
use crate::http::auth::redirect;
use crate::http::body::JsonBody;
use crate::http::pages::{self, Answering, Consent, Notice};
use crate::http::query;

const ENTRY: &str = "/auth/device";
const CONSENT: &str = "/auth/device/consent";

fn encoded(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

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
    to_entry(&format!("too_many_attempts&retry_after={seconds}"))
}

fn blocked(lookup: Lookup, typed: &str) -> Answer {
    match lookup {
        Lookup::Unknown => to_entry_with_code("invalid_code", typed),
        Lookup::Expired => to_entry_with_code("expired_code", typed),
        Lookup::Resolved | Lookup::Pending => to_entry_with_code("already_resolved", typed),
    }
}

pub async fn code(State(app): State<Arc<App>>, visit: Visit, body: JsonBody) -> Answer {
    let fields = Fields(body.form_pairs().await?);
    let asked = device::request(&app, fields.get("client_id"), fields.get("scope"), &visit).await?;
    match asked {
        Ok(answer) => Ok(json_answer(StatusCode::OK, &answer)),
        Err(problem) => problem_answer(&problem),
    }
}

pub async fn enter(
    State(app): State<Arc<App>>,
    visit: Visit,
    Browser(owner): Browser,
    headers: HeaderMap,
    body: JsonBody,
) -> Answer {
    require_own_form(&app, &headers)?;
    let fields = Fields(body.form_pairs().await?);
    let typed = fields.get("user_code").unwrap_or_default().trim();
    if typed.is_empty() {
        return to_entry("missing_code");
    }
    if let Some(wait) = device::admit_lookup(&app, visit.address, owner.as_ref()).await? {
        return too_many(wait);
    }
    match device::look_up(&app, typed).await? {
        Lookup::Pending => redirect(
            StatusCode::FOUND,
            &format!("{CONSENT}?user_code={}", encoded(typed)),
        ),
        lookup => blocked(lookup, typed),
    }
}

fn to_sign_in(app: &App, typed: Option<&str>) -> Answer {
    let back = typed.map_or(CONSENT.to_string(), |typed| {
        format!("{CONSENT}?user_code={}", encoded(typed))
    });
    redirect(StatusCode::FOUND, &sign_in_then(app, &back))
}

fn signed_in(owner: Option<Caller>) -> Option<Caller> {
    owner.filter(|caller| caller.session().is_some())
}

pub async fn screen(
    State(app): State<Arc<App>>,
    visit: Visit,
    Browser(owner): Browser,
    uri: Uri,
) -> Answer {
    let pairs = query::pairs(&uri)?;
    let typed = pairs
        .iter()
        .find(|(key, _)| key == "user_code")
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let Some(owner) = signed_in(owner) else {
        return to_sign_in(&app, typed.as_deref());
    };
    let Some(typed) = typed else {
        return to_entry("missing_code");
    };
    if let Some(wait) = device::admit_lookup(&app, visit.address, Some(&owner)).await? {
        return too_many(wait);
    }
    match device::screen(&app, &typed, &owner).await? {
        Ok(offer) => {
            let view = Consent {
                instance_name: instance::name(&app).await?,
                offer: *offer,
                answering: Answering::Device(typed),
            };
            Ok(pages::consent(&view)?.into_response())
        }
        Err(Blocked::Code(lookup)) => blocked(lookup, &typed),
        Err(Blocked::ClientGone) => {
            Err(Refusal::new(Code::InvalidClient, "This app is gone.").into())
        }
    }
}

pub async fn answer(
    State(app): State<Arc<App>>,
    visit: Visit,
    Browser(owner): Browser,
    headers: HeaderMap,
    body: JsonBody,
) -> Answer {
    require_own_form(&app, &headers)?;
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
    if let Some(wait) = device::admit_lookup(&app, visit.address, Some(&owner)).await? {
        return too_many(wait);
    }
    let answered = device::answer(&app, &owner, typed, approve, fields.post()).await?;
    let name = instance::name(&app).await?;
    match answered {
        Answered::Approved => Ok(pages::notice(&Notice::device_approved(&name))?.into_response()),
        Answered::Denied => Ok(pages::notice(&Notice::device_denied(&name))?.into_response()),
        Answered::Code(Lookup::Unknown) => {
            Err(Refusal::new(Code::NotFound, "No code matches this one.").into())
        }
        Answered::Code(lookup) => blocked(lookup, typed),
    }
}

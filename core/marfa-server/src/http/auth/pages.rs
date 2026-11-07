//! The pages a browser reads at the sign-in, setup, device and error
//! addresses, and the pages a refused setup form is answered with.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::header::ACCEPT;
use axum::http::{HeaderMap, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::Value;

use super::{cookies, require_safe_transport};
use crate::app::access::Caller;
use crate::app::auth::claim;
use crate::app::auth::owner;
use crate::app::auth::return_to::kept;
use crate::app::oauth::signed_link::{self, Verified};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::{App, instance};
use crate::http::answer::{Answer, Page as RefusalMark, asks_for_html, refusal_answer};
use crate::http::caller::identify;
use crate::http::pages::{
    self, AuthError, AuthErrorCode, DeviceEntry, DeviceProblem, Notice, SetupCode,
    SetupCodeProblem, SetupDetails, SetupFieldErrors, SignIn, SignInProblem, SignedIn, Wait,
};
use crate::http::query;

/// Long enough for any address a person types, short enough that a link
/// cannot fill a page with it.
const SHOWN_CHARS: usize = 320;

fn first<'p>(pairs: &'p [(String, String)], name: &str) -> Option<&'p str> {
    pairs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

fn shown(text: Option<&str>) -> String {
    text.unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(SHOWN_CHARS)
        .collect()
}

/// Whether the request asks for a page, which a browser's form post does and
/// a script's does not.
pub fn wants_page(headers: &HeaderMap) -> bool {
    asks_for_html(headers.get(ACCEPT).and_then(|value| value.to_str().ok()))
}

/// The authorization this instance signed, if the request is one.
fn authorization(app: &App, uri: &Uri) -> Option<Verified> {
    let query = uri.query()?;
    let now = app.clock.now_ms().div_euclid(1000);
    signed_link::verify(query, now, &app.settings.start.auth_secret).ok()
}

/// The name the app of a signed authorization registered under. The OAuth
/// server's client lookup answers here.
async fn app_named(_app: &App, _authorization: &Verified) -> Result<Option<String>> {
    Ok(None)
}

/// `GET /auth/sign-in`.
pub async fn sign_in(State(app): State<Arc<App>>, request: Request) -> Answer {
    require_safe_transport(&app)?;
    let name = instance::name(&app).await?;
    if !claim::is_claimed(&app).await? {
        return Ok(pages::notice(&Notice::no_owner_yet(&name))?.into_response());
    }
    let (mut parts, _) = request.into_parts();
    let pairs = query::pairs(&parts.uri)?;
    let field = |name: &str| first(&pairs, name);
    let address = app.addresses().sign_in();
    let return_to = kept(field("return_to").unwrap_or(""), address.origin());
    let sent = authorization(&app, &parts.uri);
    let reprompt = field("prompt") == Some("login")
        || sent
            .as_ref()
            .is_some_and(|link| link.get("prompt") == Some("login"));
    if !reprompt && sent.is_none() {
        let caller = identify(&mut parts, &app).await?;
        if caller.as_ref().and_then(Caller::session).is_some()
            && let Some(found) = owner::find(&app).await?
        {
            let view = SignedIn {
                instance_name: name,
                email: found.email,
                continue_to: return_to,
            };
            return Ok(pages::signed_in(&view)?.into_response());
        }
    }
    let app_name = match &sent {
        Some(link) => app_named(&app, link).await?,
        None => None,
    };
    let view = SignIn {
        instance_name: name,
        email: shown(field("email")),
        return_to,
        app: app_name,
        problem: SignInProblem::from_query(field("error"), field("retry_after")),
    };
    Ok(pages::sign_in(&view)?.into_response())
}

/// `GET /setup`: the code to enter, or, with a live setup session, the
/// owner's details.
pub async fn setup(State(app): State<Arc<App>>, headers: HeaderMap) -> Answer {
    require_safe_transport(&app)?;
    let name = instance::name(&app).await?;
    if claim::is_claimed(&app).await? {
        return Ok(pages::notice(&Notice::already_claimed(&name))?.into_response());
    }
    let live = match cookies::setup_token(&headers) {
        Some(token) => claim::session_stands(&app, token).await?,
        None => false,
    };
    let page = if live {
        pages::setup_details(&SetupDetails {
            instance_name: name,
            name: String::new(),
            email: String::new(),
            errors: SetupFieldErrors::default(),
            notice: None,
        })?
    } else {
        pages::setup_code(&SetupCode {
            instance_name: name,
            problem: None,
        })?
    };
    Ok(page.into_response())
}

/// `GET /auth/error`.
pub async fn error(State(app): State<Arc<App>>, uri: Uri) -> Answer {
    let pairs = query::pairs(&uri)?;
    let view = AuthError {
        instance_name: instance::name(&app).await?,
        code: AuthErrorCode::from_query(first(&pairs, "error")),
    };
    Ok(pages::auth_error(&view)?.into_response())
}

/// `GET /auth/device`: where a code from a device is typed. The lookup is
/// the POST's.
pub async fn device(State(app): State<Arc<App>>, uri: Uri) -> Answer {
    let pairs = query::pairs(&uri)?;
    let view = DeviceEntry {
        instance_name: instance::name(&app).await?,
        user_code: shown(first(&pairs, "user_code")),
        problem: DeviceProblem::from_query(first(&pairs, "error"), first(&pairs, "retry_after")),
    };
    Ok(pages::device_entry(&view)?.into_response())
}

/// The refusal as it is sent, with `page` for its body. Its status, code and
/// `Retry-After` stay, and nothing replaces the page afterwards.
fn refused_with(refusal: &Refusal, page: pages::Page) -> Response {
    let mut response = refusal_answer(refusal);
    response.extensions_mut().remove::<RefusalMark>();
    page.write_over(&mut response);
    response
}

fn wait_of(refusal: &Refusal) -> Option<Wait> {
    let seconds = refusal.details.as_ref()?.get("retry_after")?.as_i64()?;
    Wait::from_query(Some(&seconds.to_string()))
}

/// What a setup form's refusal says to a person, when a page of the form's
/// own can say it better than the refusal's generic page. `None` leaves the
/// refusal as it is.
async fn exchange_page(app: &App, refusal: &Refusal) -> Result<Option<pages::Page>> {
    let name = instance::name(app).await?;
    let problem = match refusal.code {
        Code::OwnerExists => {
            return Ok(Some(pages::notice(&Notice::already_claimed(&name))?));
        }
        Code::ValidationError => SetupCodeProblem::MissingCode,
        Code::SetupProofInvalid => SetupCodeProblem::WrongCode,
        Code::RateLimited => SetupCodeProblem::TooManyAttempts(wait_of(refusal)),
        Code::InternalError => SetupCodeProblem::Other,
        _ => return Ok(None),
    };
    let view = SetupCode {
        instance_name: name,
        problem: Some(problem),
    };
    Ok(Some(pages::setup_code(&view)?))
}

/// The page for a refused code entry form.
pub async fn exchange_refused(app: &App, refusal: &Refusal) -> Result<Response> {
    Ok(match exchange_page(app, refusal).await? {
        Some(page) => refused_with(refusal, page),
        None => refusal_answer(refusal),
    })
}

/// What was typed in the owner's details form. The password is not kept.
#[derive(Clone, Debug, Default)]
pub struct Typed {
    pub name: String,
    pub email: String,
}

impl Typed {
    pub fn of(fields: &serde_json::Map<String, Value>) -> Typed {
        let text = |name: &str| shown(fields.get(name).and_then(Value::as_str));
        Typed {
            name: text("name"),
            email: text("email"),
        }
    }
}

/// The field a validation refusal names, with its message.
fn field_errors(refusal: &Refusal) -> Option<SetupFieldErrors> {
    let errors = refusal.details.as_ref()?.get("errors")?.as_array()?;
    let mut found = SetupFieldErrors::default();
    for error in errors {
        let message = error.get("message")?.as_str()?.to_owned();
        match error.get("path")?.as_str()? {
            "name" => found.name = Some(message),
            "email" => found.email = Some(message),
            "password" => found.password = Some(message),
            _ => return None,
        }
    }
    Some(found)
}

async fn details_page(app: &App, refusal: &Refusal, typed: Typed) -> Result<Option<pages::Page>> {
    let name = instance::name(app).await?;
    let (errors, notice) = match refusal.code {
        Code::OwnerExists => {
            return Ok(Some(pages::notice(&Notice::already_claimed(&name))?));
        }
        Code::SetupProofInvalid => {
            let view = SetupCode {
                instance_name: name,
                problem: Some(SetupCodeProblem::SessionEnded),
            };
            return Ok(Some(pages::setup_code(&view)?));
        }
        Code::ValidationError => match field_errors(refusal) {
            Some(errors) => (errors, None),
            None => return Ok(None),
        },
        Code::Forbidden => return Ok(None),
        _ => (
            SetupFieldErrors::default(),
            Some("Something went wrong. Try again.".to_owned()),
        ),
    };
    let view = SetupDetails {
        instance_name: name,
        name: typed.name,
        email: typed.email,
        errors,
        notice,
    };
    Ok(Some(pages::setup_details(&view)?))
}

/// The page for a refused details form.
pub async fn claim_refused(app: &App, refusal: &Refusal, typed: Typed) -> Result<Response> {
    Ok(match details_page(app, refusal, typed).await? {
        Some(page) => refused_with(refusal, page),
        None => refusal_answer(refusal),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_a_link_puts_in_a_field_is_cut_and_stripped() {
        assert_eq!(shown(Some("a\u{0}b\nc")), "abc");
        assert_eq!(shown(Some(&"x".repeat(1000))).chars().count(), SHOWN_CHARS);
        assert_eq!(shown(None), "");
    }

    #[test]
    fn a_page_is_asked_for_by_accept_alone() {
        let mut headers = HeaderMap::new();
        assert!(!wants_page(&headers));
        headers.insert(ACCEPT, "*/*".parse().unwrap());
        assert!(!wants_page(&headers));
        headers.insert(
            ACCEPT,
            "text/html,application/xhtml+xml,*/*;q=0.8".parse().unwrap(),
        );
        assert!(wants_page(&headers));
    }

    #[test]
    fn a_refusal_names_the_fields_it_found_wrong() {
        let refusal = Refusal::validation("Invalid owner details.").with_detail(
            "errors",
            serde_json::json!([{ "path": "email", "message": "Enter a valid email address." }]),
        );
        let found = field_errors(&refusal).unwrap();
        assert_eq!(found.email.as_deref(), Some("Enter a valid email address."));
        assert!(found.name.is_none() && found.password.is_none());
        let unknown = Refusal::validation("x").with_detail(
            "errors",
            serde_json::json!([{ "path": "bogus", "message": "no" }]),
        );
        assert!(field_errors(&unknown).is_none());
        assert!(field_errors(&Refusal::validation("x")).is_none());
    }

    #[test]
    fn a_wait_is_read_from_the_refusal_that_carries_it() {
        let spent = crate::app::auth::limits::spent("Too many.", 61_000);
        assert_eq!(wait_of(&spent).unwrap().minutes(), 2);
        assert!(wait_of(&Refusal::validation("x")).is_none());
    }
}

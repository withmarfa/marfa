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
use crate::app::auth::return_to::{HOME, kept};
use crate::app::oauth::authorize::app_named;
use crate::app::oauth::redirect::shown_destination;
use crate::app::oauth::signed_link::{self, Verified};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::{App, instance};
use crate::http::answer::{Answer, Page as RefusalMark, asks_for_html, refusal_answer};
use crate::http::caller::browser_owner;
use crate::http::pages::{
    self, AskingApp, AuthError, AuthErrorCode, DeviceEntry, DeviceProblem, Notice, RecoverPassword,
    RecoveryCode, SetupCode, SetupCodeProblem, SetupDetails, SetupFieldErrors, SignIn,
    SignInProblem, SignedIn, Wait,
};
use crate::http::query;

/// Short enough that a link cannot fill a page with an address.
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

/// A browser's form post asks for a page; a script's does not.
pub fn wants_page(headers: &HeaderMap) -> bool {
    asks_for_html(headers.get(ACCEPT).and_then(|value| value.to_str().ok()))
}

fn authorization(app: &App, link: &str) -> Option<Verified> {
    let now = app.clock.now_ms().div_euclid(1000);
    signed_link::verify(link, now, &app.settings.start.auth_secret).ok()
}

/// The app a signed authorization link names, where the page can say where it sends the person.
async fn asking_app(app: &App, sent: Option<&Verified>) -> Result<Option<AskingApp>> {
    let Some(link) = sent else {
        return Ok(None);
    };
    let Some(host) = link.get("redirect_uri").and_then(shown_destination) else {
        return Ok(None);
    };
    Ok(app_named(app, link)
        .await?
        .map(|name| AskingApp { name, host }))
}

fn return_to_in(app: &App, pairs: &[(String, String)]) -> String {
    kept(
        first(pairs, "return_to").unwrap_or(""),
        app.addresses().sign_in().origin(),
    )
}

pub async fn sign_in(State(app): State<Arc<App>>, request: Request) -> Answer {
    require_safe_transport(&app)?;
    let name = instance::name(&app).await?;
    let (parts, _) = request.into_parts();
    let pairs = query::pairs(&parts.uri)?;
    let field = |name: &str| first(&pairs, name);
    let return_to = return_to_in(&app, &pairs);
    let link = field("authorization")
        .or(parts.uri.query())
        .unwrap_or_default()
        .to_string();
    let sent = authorization(&app, &link);
    if !claim::is_claimed(&app).await? {
        let view = SetupCode {
            instance_name: name,
            problem: None,
            app: asking_app(&app, sent.as_ref()).await?,
            return_to,
        };
        return Ok(pages::setup_code(&view)?.into_response());
    }
    if field("prompt") != Some("login") && sent.is_none() {
        let caller = browser_owner(&parts, &app).await?;
        if caller.as_ref().and_then(Caller::session).is_some()
            && let Some(found) = owner::find(&app).await?
        {
            let view = SignedIn {
                instance_name: name,
                username: found.username,
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
        username: shown(field("username")),
        return_to,
        authorization: sent.map(|_| link),
        app: app_name,
        problem: SignInProblem::from_query(field("error"), field("retry_after_seconds")),
    };
    Ok(pages::sign_in(&view)?.into_response())
}

pub async fn setup(State(app): State<Arc<App>>, headers: HeaderMap, uri: Uri) -> Answer {
    require_safe_transport(&app)?;
    let pairs = query::pairs(&uri)?;
    let return_to = return_to_in(&app, &pairs);
    let name = instance::name(&app).await?;
    if claim::is_claimed(&app).await? {
        if first(&pairs, "return_to").is_some() {
            let notice = Notice::already_claimed(&name, &return_to);
            return Ok(pages::notice(&notice)?.into_response());
        }
        return Ok(recovery_page(&app, &headers, name).await?.into_response());
    }
    let live = match cookies::setup_token(&headers) {
        Some(token) => claim::session_stands(&app, token).await?,
        None => false,
    };
    let page = if live {
        pages::setup_details(&SetupDetails {
            instance_name: name,
            name: String::new(),
            username: String::new(),
            email: String::new(),
            errors: SetupFieldErrors::default(),
            notice: None,
            return_to,
        })?
    } else {
        pages::setup_code(&SetupCode {
            instance_name: name,
            problem: None,
            return_to,
            app: None,
        })?
    };
    Ok(page.into_response())
}

/// A claimed instance's setup page, which recovers the owner while a recovery code is offered.
async fn recovery_page(app: &App, headers: &HeaderMap, name: String) -> Result<pages::Page> {
    let live = match cookies::setup_token(headers) {
        Some(token) => claim::recovery_session_stands(app, token).await?,
        None => false,
    };
    if live {
        return pages::recover_password(&RecoverPassword {
            instance_name: name,
            error: None,
            notice: None,
        });
    }
    if claim::recovery_offered(app).await? {
        return pages::recovery_code(&RecoveryCode {
            instance_name: name,
            problem: None,
        });
    }
    pages::notice(&Notice::already_claimed(&name, HOME))
}

pub async fn error(State(app): State<Arc<App>>, uri: Uri) -> Answer {
    let pairs = query::pairs(&uri)?;
    let view = AuthError {
        instance_name: instance::name(&app).await?,
        code: AuthErrorCode::from_query(first(&pairs, "error")),
    };
    Ok(pages::auth_error(&view)?.into_response())
}

pub async fn device(State(app): State<Arc<App>>, uri: Uri) -> Answer {
    let pairs = query::pairs(&uri)?;
    let view = DeviceEntry {
        instance_name: instance::name(&app).await?,
        user_code: shown(first(&pairs, "user_code")),
        problem: DeviceProblem::from_query(
            first(&pairs, "error"),
            first(&pairs, "retry_after_seconds"),
        ),
    };
    Ok(pages::device_entry(&view)?.into_response())
}

/// The refusal's status, code and `Retry-After` stay; only the body is `page`.
fn refused_with(refusal: &Refusal, page: pages::Page) -> Response {
    let mut response = refusal_answer(refusal);
    response.extensions_mut().remove::<RefusalMark>();
    page.write_over(&mut response);
    response
}

fn wait_of(refusal: &Refusal) -> Option<Wait> {
    let seconds = refusal
        .details
        .as_ref()?
        .get("retry_after_seconds")?
        .as_i64()?;
    Wait::from_query(Some(&seconds.to_string()))
}

/// The form a code was posted from, which decides how the code is read.
pub enum CodeForm {
    /// The setup code form, with the `return_to` it carried as `kept` read it.
    Setup(String),
    Recovery,
}

async fn exchange_page(
    app: &App,
    refusal: &Refusal,
    form: &CodeForm,
) -> Result<Option<pages::Page>> {
    let name = instance::name(app).await?;
    let return_to = match form {
        CodeForm::Setup(back) => back.as_str(),
        CodeForm::Recovery => HOME,
    };
    let problem = match refusal.code {
        Code::OwnerExists => {
            let notice = Notice::already_claimed(&name, return_to);
            return Ok(Some(pages::notice(&notice)?));
        }
        Code::ValidationError => SetupCodeProblem::MissingCode,
        Code::SetupProofInvalid => SetupCodeProblem::WrongCode,
        Code::RateLimited => SetupCodeProblem::TooManyAttempts(wait_of(refusal)),
        Code::InternalError => SetupCodeProblem::Other,
        _ => return Ok(None),
    };
    let problem = Some(problem);
    let page = if matches!(form, CodeForm::Recovery) && claim::is_claimed(app).await? {
        pages::recovery_code(&RecoveryCode {
            instance_name: name,
            problem,
        })?
    } else {
        pages::setup_code(&SetupCode {
            instance_name: name,
            problem,
            return_to: return_to.to_owned(),
            app: None,
        })?
    };
    Ok(Some(page))
}

pub async fn exchange_refused(app: &App, refusal: &Refusal, form: &CodeForm) -> Result<Response> {
    Ok(match exchange_page(app, refusal, form).await? {
        Some(page) => refused_with(refusal, page),
        None => refusal_answer(refusal),
    })
}

/// What was typed in the owner's details form. The password is not kept.
#[derive(Clone, Debug, Default)]
pub struct Typed {
    pub name: String,
    pub username: String,
    pub email: String,
}

impl Typed {
    pub fn of(fields: &serde_json::Map<String, Value>) -> Typed {
        let text = |name: &str| shown(fields.get(name).and_then(Value::as_str));
        Typed {
            name: text("name"),
            username: text("username"),
            email: text("email"),
        }
    }
}

fn field_errors(refusal: &Refusal) -> Option<SetupFieldErrors> {
    let errors = refusal.details.as_ref()?.get("errors")?.as_array()?;
    let mut found = SetupFieldErrors::default();
    for error in errors {
        let message = error.get("message")?.as_str()?.to_owned();
        match error.get("path")?.as_str()? {
            "name" => found.name = Some(message),
            "username" => found.username = Some(message),
            "email" => found.email = Some(message),
            "password" => found.password = Some(message),
            _ => return None,
        }
    }
    Some(found)
}

async fn details_page(
    app: &App,
    refusal: &Refusal,
    typed: Typed,
    return_to: String,
) -> Result<Option<pages::Page>> {
    let name = instance::name(app).await?;
    let (errors, notice) = match refusal.code {
        Code::OwnerExists => {
            let notice = Notice::already_claimed(&name, &return_to);
            return Ok(Some(pages::notice(&notice)?));
        }
        Code::SetupProofInvalid => {
            let view = SetupCode {
                instance_name: name,
                problem: Some(SetupCodeProblem::SessionEnded),
                return_to,
                app: None,
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
        username: typed.username,
        email: typed.email,
        errors,
        notice,
        return_to,
    };
    Ok(Some(pages::setup_details(&view)?))
}

pub async fn claim_refused(
    app: &App,
    refusal: &Refusal,
    typed: Typed,
    return_to: String,
) -> Result<Response> {
    Ok(match details_page(app, refusal, typed, return_to).await? {
        Some(page) => refused_with(refusal, page),
        None => refusal_answer(refusal),
    })
}

async fn recover_page(app: &App, refusal: &Refusal) -> Result<Option<pages::Page>> {
    let name = instance::name(app).await?;
    let (error, notice) = match refusal.code {
        Code::SetupProofInvalid | Code::RateLimited => {
            let problem = match refusal.code {
                Code::RateLimited => SetupCodeProblem::TooManyAttempts(wait_of(refusal)),
                _ => SetupCodeProblem::SessionEnded,
            };
            let view = RecoveryCode {
                instance_name: name,
                problem: Some(problem),
            };
            return Ok(Some(pages::recovery_code(&view)?));
        }
        Code::ValidationError => match field_errors(refusal).and_then(|found| found.password) {
            Some(message) => (Some(message), None),
            None => return Ok(None),
        },
        Code::OwnerNotFound | Code::Forbidden => return Ok(None),
        _ => (None, Some("Something went wrong. Try again.".to_owned())),
    };
    let view = RecoverPassword {
        instance_name: name,
        error,
        notice,
    };
    Ok(Some(pages::recover_password(&view)?))
}

pub async fn recover_refused(app: &App, refusal: &Refusal) -> Result<Response> {
    Ok(match recover_page(app, refusal).await? {
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

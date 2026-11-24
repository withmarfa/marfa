use askama::Template;
use axum::http::StatusCode;

use super::{Needs, Page, document_opening, render_body};
use crate::app::auth::return_to::through_sign_in;
use crate::app::connector_sign_in::Failure;
use crate::app::refusal::Result;

#[derive(Debug, Clone)]
pub struct Link {
    pub label: String,
    pub href: String,
}

#[derive(Debug, Clone)]
pub struct Notice {
    pub status: StatusCode,
    pub heading: String,
    pub message: String,
    /// The one next step, drawn as a button.
    pub link: Option<Link>,
    /// The browser goes to the link without a click.
    pub opens_link: bool,
}

impl Notice {
    fn new(status: StatusCode, heading: &str, message: &str) -> Notice {
        Notice {
            status,
            heading: heading.to_owned(),
            message: message.to_owned(),
            link: None,
            opens_link: false,
        }
    }

    fn linked(self, label: &str, href: &str) -> Notice {
        Notice {
            link: Some(Link {
                label: label.into(),
                href: href.into(),
            }),
            ..self
        }
    }

    /// `app_url` is the `marfa://` link of an item, built from an id the caller has read as well formed.
    pub fn opening_item(app_url: &str) -> Notice {
        Notice {
            opens_link: true,
            ..Notice::new(
                StatusCode::OK,
                "Opening in a Marfa app",
                "If nothing opens, no app on this device opens Marfa links.",
            )
            .linked("Open in Marfa", app_url)
        }
    }

    pub fn not_an_item_link() -> Notice {
        Notice::new(
            StatusCode::NOT_FOUND,
            "This is not a Marfa link",
            "Check the link, or ask whoever sent it for a new one.",
        )
    }

    pub fn unverified_request() -> Notice {
        Notice::new(
            StatusCode::BAD_REQUEST,
            "Marfa couldn’t check this request",
            "The link may have been changed. Go back to the app and start again.",
        )
    }

    pub fn expired_request() -> Notice {
        Notice::new(
            StatusCode::BAD_REQUEST,
            "This request has expired",
            "Go back to the app and start again.",
        )
    }

    pub fn device_approved() -> Notice {
        Notice::new(
            StatusCode::OK,
            "Your device is connected",
            "Go back to it to continue.",
        )
    }

    pub fn device_denied() -> Notice {
        Notice::new(
            StatusCode::OK,
            "Your device isn’t connected",
            "You didn’t allow it. Start again on the device if you meant to.",
        )
    }

    pub fn connector_signed_in() -> Notice {
        Notice::new(
            StatusCode::OK,
            "You’re signed in",
            "Marfa keeps this sign-in for the connector. Go back to your app.",
        )
    }

    /// `why` is `None` where the state names no sign-in, which tells a stranger nothing.
    pub fn connector_sign_in_unfinished(why: Option<&Failure>) -> Notice {
        let message = match why {
            None => "It was canceled, has ended or was already used. Start again in your app."
                .to_string(),
            Some(failure) => format!("{} Start again in your app.", sign_in_failure(failure)),
        };
        Notice::new(StatusCode::BAD_REQUEST, "Sign-in didn’t finish", &message)
    }

    pub fn connector_sign_in_failed(why: &Failure) -> Notice {
        Notice::new(
            StatusCode::BAD_GATEWAY,
            "Sign-in didn’t finish",
            &format!("{} Start again in your app.", sign_in_failure(why)),
        )
    }

    pub fn signed_out() -> Notice {
        Notice::new(
            StatusCode::OK,
            "You’re signed out",
            "Sign in again to manage this Marfa.",
        )
        .linked("Sign In", "/auth/sign-in")
    }

    pub fn running() -> Notice {
        Notice::new(
            StatusCode::OK,
            "This Marfa is running",
            "Sign in to manage it, or open an app that connects to it.",
        )
        .linked("Sign In", "/auth/sign-in")
    }

    /// `return_to` is a value `kept` has read, where signing in goes on to.
    pub fn already_claimed(return_to: &str) -> Notice {
        Notice::new(
            StatusCode::OK,
            "This Marfa already has an owner",
            "Setup is finished. Sign in to continue.",
        )
        .linked("Sign In", &through_sign_in(return_to))
    }

    /// No route answers the address.
    pub fn missing_page() -> Notice {
        Notice::new(
            StatusCode::NOT_FOUND,
            "There’s nothing here",
            "Check the address and try again.",
        )
    }

    /// The server's generic internal refusal, which carries no words of its own.
    pub fn fault() -> Notice {
        Notice::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Something went wrong",
            "Marfa couldn’t continue. Go back to the app and try again.",
        )
    }

    /// A refusal a browser reads, in the words it carries.
    pub fn refusal(status: StatusCode, message: &str) -> Notice {
        match status {
            StatusCode::NOT_FOUND => Notice::new(status, "Not found", message),
            status if status.is_server_error() => {
                Notice::new(status, "Something went wrong", message)
            }
            StatusCode::UNAUTHORIZED => {
                Notice::new(status, "Sign in needed", message).linked("Sign In", "/auth/sign-in")
            }
            StatusCode::FORBIDDEN => Notice::new(status, "Not allowed", message),
            StatusCode::TOO_MANY_REQUESTS => Notice::new(status, "Too many requests", message),
            _ => Notice::new(status, "Request not accepted", message),
        }
    }
}

#[derive(Template)]
#[template(path = "notice.html")]
struct NoticeBody<'a> {
    view: &'a Notice,
}

pub fn notice(view: &Notice) -> Result<Page> {
    let body = render_body(&NoticeBody { view })?;
    let opens = view
        .link
        .as_ref()
        .filter(|_| view.opens_link)
        .map(|link| link.href.as_str());
    Ok(document_opening(&view.heading, &body, Needs::default(), opens)?.with_status(view.status))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthErrorCode {
    InvalidRedirect,
    InvalidClient,
    InvalidRequest,
    UnsupportedResponseType,
    UnauthorizedClient,
    InvalidScope,
    InvalidTarget,
    LoginRequired,
    ConsentRequired,
    Other,
}

impl AuthErrorCode {
    /// A code it does not know is never shown.
    pub fn from_query(error: Option<&str>) -> AuthErrorCode {
        match error {
            Some("invalid_redirect") => AuthErrorCode::InvalidRedirect,
            Some("invalid_client") => AuthErrorCode::InvalidClient,
            Some("invalid_request") => AuthErrorCode::InvalidRequest,
            Some("unsupported_response_type") => AuthErrorCode::UnsupportedResponseType,
            Some("unauthorized_client") => AuthErrorCode::UnauthorizedClient,
            Some("invalid_scope") => AuthErrorCode::InvalidScope,
            Some("invalid_target") => AuthErrorCode::InvalidTarget,
            Some("login_required") => AuthErrorCode::LoginRequired,
            Some("consent_required") => AuthErrorCode::ConsentRequired,
            _ => AuthErrorCode::Other,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuthError {
    pub code: AuthErrorCode,
}

pub fn auth_error(view: &AuthError) -> Result<Page> {
    let (heading, message) = match view.code {
        AuthErrorCode::InvalidRedirect => (
            "This app can’t continue",
            "It asked to send you to an address it didn’t register. Tell its developer.",
        ),
        AuthErrorCode::InvalidClient => (
            "Marfa doesn’t know this app",
            "Its registration may have ended. Go back to the app and start again.",
        ),
        AuthErrorCode::InvalidRequest => (
            "This app can’t continue",
            "Its request to Marfa was incomplete. Go back to the app and try again.",
        ),
        AuthErrorCode::UnsupportedResponseType | AuthErrorCode::UnauthorizedClient => (
            "This app can’t continue",
            "It asked to sign in a way Marfa doesn’t allow for it. Go back to the app and try \
             again.",
        ),
        AuthErrorCode::InvalidScope => (
            "This app can’t continue",
            "It asked for access Marfa can’t give. Go back to the app and try again.",
        ),
        AuthErrorCode::InvalidTarget => (
            "This app can’t continue",
            "It asked for something this Marfa doesn’t serve. Go back to the app and try again.",
        ),
        AuthErrorCode::LoginRequired => (
            "You’re not signed in",
            "This app needs you to sign in to Marfa. Go back to the app and start again.",
        ),
        AuthErrorCode::ConsentRequired => (
            "This app needs your approval",
            "You haven’t allowed it. Go back to the app and start again.",
        ),
        AuthErrorCode::Other => (
            "Something went wrong",
            "Marfa couldn’t continue. Go back to the app and try again.",
        ),
    };
    notice(&Notice::new(StatusCode::OK, heading, message))
}

/// One sentence for each outcome word, written by Marfa and never by the provider.
fn sign_in_failure(failure: &Failure) -> &'static str {
    match failure {
        Failure::TokenError("invalid_client")
        | Failure::BrowserError("unauthorized_client")
        | Failure::TokenError("unauthorized_client") => {
            "The service refused this connector’s client ID or secret. Check them in the plugin’s settings."
        }
        Failure::TokenError("invalid_grant") => {
            "The service refused the sign-in, which may have been used already or taken too long."
        }
        Failure::TokenError("invalid_scope") | Failure::BrowserError("invalid_scope") => {
            "The service refused the access this connector asks for."
        }
        Failure::TokenError(_)
        | Failure::BrowserError("invalid_request" | "unsupported_response_type") => {
            "The service refused the request Marfa sent."
        }
        Failure::BrowserError("access_denied") => "The sign-in was declined at the service.",
        Failure::BrowserError(_) | Failure::ProviderError => {
            "The service reported a problem with the sign-in."
        }
        Failure::NoCode => "The service sent the browser back without finishing the sign-in.",
        Failure::ChangedSinceStart => {
            "The connector’s sign-in or its client settings changed after the sign-in started."
        }
        Failure::Timeout => "The service didn’t answer in time.",
        Failure::Unreachable => "Marfa couldn’t reach the service.",
        Failure::Status(_) => "The service answered with an error.",
        Failure::NoRefreshToken => "The service didn’t send a token Marfa can keep.",
        Failure::UnreadableAnswer => "The service sent an answer Marfa couldn’t read.",
    }
}

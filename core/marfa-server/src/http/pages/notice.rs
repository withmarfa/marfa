use askama::Template;
use axum::http::StatusCode;

use super::{Needs, Page, document, render_body};
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
    pub instance_name: String,
    pub status: StatusCode,
    pub heading: String,
    pub message: String,
    pub link: Option<Link>,
}

impl Notice {
    fn new(instance_name: &str, status: StatusCode, heading: &str, message: &str) -> Notice {
        Notice {
            instance_name: instance_name.to_owned(),
            status,
            heading: heading.to_owned(),
            message: message.to_owned(),
            link: None,
        }
    }

    pub fn unverified_request(instance_name: &str) -> Notice {
        Notice::new(
            instance_name,
            StatusCode::BAD_REQUEST,
            "We could not verify this request",
            "The link may have been changed. Go back to the app and start again.",
        )
    }

    pub fn expired_request(instance_name: &str) -> Notice {
        Notice::new(
            instance_name,
            StatusCode::BAD_REQUEST,
            "This request has expired",
            "Go back to the app and start again.",
        )
    }

    pub fn device_approved(instance_name: &str) -> Notice {
        Notice::new(
            instance_name,
            StatusCode::OK,
            "Device connected",
            "Go back to your device to continue.",
        )
    }

    pub fn device_denied(instance_name: &str) -> Notice {
        Notice::new(
            instance_name,
            StatusCode::OK,
            "Device not connected",
            "You didn't approve access, so your device was not connected.",
        )
    }

    pub fn connector_signed_in(instance_name: &str) -> Notice {
        Notice::new(
            instance_name,
            StatusCode::OK,
            "You're signed in",
            "Marfa keeps this sign-in for the connector. You can close this page and return to your app.",
        )
    }

    /// `why` is `None` where the state names no sign-in, which tells a stranger nothing.
    pub fn connector_sign_in_unfinished(instance_name: &str, why: Option<&Failure>) -> Notice {
        let message = match why {
            None => "This sign-in was canceled, has ended, or was already used. Go back to your app and sign in again.".to_string(),
            Some(failure) => format!(
                "{} Go back to your app and sign in again.",
                sign_in_failure(failure)
            ),
        };
        Notice::new(
            instance_name,
            StatusCode::BAD_REQUEST,
            "Sign-in didn't finish",
            &message,
        )
    }

    pub fn connector_sign_in_failed(instance_name: &str, why: &Failure) -> Notice {
        Notice::new(
            instance_name,
            StatusCode::BAD_GATEWAY,
            "Sign-in didn't finish",
            &format!(
                "{} Go back to your app and sign in again.",
                sign_in_failure(why)
            ),
        )
    }

    pub fn signed_out(instance_name: &str) -> Notice {
        Notice::new(
            instance_name,
            StatusCode::OK,
            "You're signed out",
            "You're signed out of this browser.",
        )
        .linked("Sign in", "/auth/sign-in")
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

    pub fn running(instance_name: &str) -> Notice {
        Notice::new(
            instance_name,
            StatusCode::OK,
            "This Marfa is running",
            "Sign in to manage it, or open an app that connects to it.",
        )
        .linked("Sign in", "/auth/sign-in")
    }

    /// `return_to` is a value `kept` has read, where signing in goes on to.
    pub fn already_claimed(instance_name: &str, return_to: &str) -> Notice {
        Notice::new(
            instance_name,
            StatusCode::OK,
            "This Marfa already has an owner",
            "Setup is finished. Sign in to continue.",
        )
        .linked("Sign in", &through_sign_in(return_to))
    }

    pub fn refusal(instance_name: &str, status: StatusCode, message: &str) -> Notice {
        let heading = match status {
            StatusCode::NOT_FOUND => "Page not found",
            StatusCode::UNAUTHORIZED => "Sign in needed",
            StatusCode::FORBIDDEN => "Not allowed",
            StatusCode::TOO_MANY_REQUESTS => "Too many requests",
            status if status.is_server_error() => "Something went wrong",
            _ => "Request not accepted",
        };
        let notice = Notice::new(instance_name, status, heading, message);
        match status {
            StatusCode::UNAUTHORIZED => notice.linked("Sign in", "/auth/sign-in"),
            _ => notice,
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
    Ok(
        document(&view.heading, &view.instance_name, &body, Needs::default())?
            .with_status(view.status),
    )
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
    pub instance_name: String,
    pub code: AuthErrorCode,
}

pub fn auth_error(view: &AuthError) -> Result<Page> {
    let (heading, message) = match view.code {
        AuthErrorCode::InvalidRedirect => (
            "This app can't continue",
            "It asked to send you to an address it didn't register with Marfa, so Marfa \
             stopped. Go back to the app and try again.",
        ),
        AuthErrorCode::InvalidClient => (
            "Marfa doesn't know this app",
            "The app isn't registered with Marfa, or its registration has ended. Go back to \
             the app and start again.",
        ),
        AuthErrorCode::InvalidRequest => (
            "This app can't continue",
            "Its request to Marfa was incomplete. Go back to the app and try again.",
        ),
        AuthErrorCode::UnsupportedResponseType | AuthErrorCode::UnauthorizedClient => (
            "This app can't continue",
            "It asked to sign in a way Marfa doesn't allow for it. Go back to the app and try \
             again.",
        ),
        AuthErrorCode::InvalidScope => (
            "This app can't continue",
            "It asked for access Marfa can't give. Go back to the app and try again.",
        ),
        AuthErrorCode::InvalidTarget => (
            "This app can't continue",
            "It asked for something this Marfa doesn't serve. Go back to the app and try again.",
        ),
        AuthErrorCode::LoginRequired => (
            "You're not signed in",
            "This app needs you to sign in to Marfa. Go back to the app and start again.",
        ),
        AuthErrorCode::ConsentRequired => (
            "This app needs your approval",
            "You haven't approved this app. Go back to the app and start again.",
        ),
        AuthErrorCode::Other => (
            "Something went wrong",
            "Marfa couldn't continue with this request. Go back to the app and try again.",
        ),
    };
    notice(&Notice::new(
        &view.instance_name,
        StatusCode::OK,
        heading,
        message,
    ))
}

/// One sentence for each outcome word, written by Marfa and never by the provider.
fn sign_in_failure(failure: &Failure) -> &'static str {
    match failure {
        Failure::TokenError("invalid_client")
        | Failure::BrowserError("unauthorized_client")
        | Failure::TokenError("unauthorized_client") => {
            "The service refused this connector's client ID or secret. Check them in the plugin's settings."
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
            "The connector's sign-in or its client settings changed after the sign-in started."
        }
        Failure::Timeout => "The service didn't answer in time.",
        Failure::Unreachable => "Marfa couldn't reach the service.",
        Failure::Status(_) => "The service answered with an error.",
        Failure::NoRefreshToken => "The service didn't send a token Marfa can keep.",
        Failure::UnreadableAnswer => "The service sent an answer Marfa couldn't read.",
    }
}

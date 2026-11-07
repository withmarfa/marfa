use askama::Template;
use axum::http::StatusCode;

use super::{Needs, Page, document, render_body};
use crate::app::refusal::Result;

#[derive(Debug, Clone)]
pub struct Link {
    pub label: String,
    pub href: String,
}

/// A page that says one thing: a request was refused, has expired or ended.
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

    /// An authorization link whose signature the instance did not make.
    pub fn unverified_request(instance_name: &str) -> Notice {
        Notice::new(
            instance_name,
            StatusCode::BAD_REQUEST,
            "We could not verify this request",
            "The link may have been changed. Go back to the app and start again.",
        )
    }

    /// An authorization link whose window has closed.
    pub fn expired_request(instance_name: &str) -> Notice {
        Notice::new(
            instance_name,
            StatusCode::BAD_REQUEST,
            "This request has expired",
            "Go back to the app and start again.",
        )
    }

    /// A device code a person approved.
    pub fn device_approved(instance_name: &str) -> Notice {
        Notice::new(
            instance_name,
            StatusCode::OK,
            "Device connected",
            "Go back to your device to continue.",
        )
    }

    /// A device code a person turned down.
    pub fn device_denied(instance_name: &str) -> Notice {
        Notice::new(
            instance_name,
            StatusCode::OK,
            "Device not connected",
            "Your device was not given access.",
        )
    }

    pub fn signed_out(instance_name: &str) -> Notice {
        Notice {
            link: Some(Link {
                label: "Sign in".into(),
                href: "/auth/sign-in".into(),
            }),
            ..Notice::new(
                instance_name,
                StatusCode::OK,
                "You're signed out",
                "You're signed out of this browser.",
            )
        }
    }

    /// A refusal a browser asked for as a page. The message is the refusal's
    /// own.
    pub fn refusal(instance_name: &str, status: StatusCode, message: &str) -> Notice {
        let heading = match status {
            StatusCode::NOT_FOUND => "Page not found",
            StatusCode::UNAUTHORIZED => "Sign in needed",
            StatusCode::FORBIDDEN => "Not allowed",
            StatusCode::TOO_MANY_REQUESTS => "Too many requests",
            status if status.is_server_error() => "Something went wrong",
            _ => "Request not accepted",
        };
        Notice::new(instance_name, status, heading, message)
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

/// What `/auth/error` was sent for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthErrorCode {
    InvalidRedirect,
    InvalidClient,
    Other,
}

impl AuthErrorCode {
    /// The page's `error` query value. A code it does not know is never
    /// shown.
    pub fn from_query(error: Option<&str>) -> AuthErrorCode {
        match error {
            Some("invalid_redirect") => AuthErrorCode::InvalidRedirect,
            Some("invalid_client") => AuthErrorCode::InvalidClient,
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

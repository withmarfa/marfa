//! The pages the server draws itself: sign-in, device codes, setup and the
//! pages that tell a person a request was refused. Each page is a function
//! from a view struct to a [`Page`]. Nothing here reads a request or the
//! database.
#![allow(dead_code)]

mod device;
mod escape;
mod notice;
mod setup;
mod sign_in;
mod wait;

use askama::Template;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

use crate::app::refusal::{Refusal, Result};

pub use device::{DeviceEntry, DeviceProblem, device_entry};
pub use notice::{AuthError, AuthErrorCode, Link, Notice, auth_error, notice};
pub use setup::{
    SetupCode, SetupCodeProblem, SetupDetails, SetupFieldErrors, setup_code, setup_details,
};
pub use sign_in::{SignIn, SignInProblem, SignedIn, sign_in, signed_in};
pub use wait::Wait;

const STYLE: &str = include_str!("assets/page.css");
const SCRIPT: &str = include_str!("assets/page.js");

/// A finished HTML page, ready to answer with.
pub struct Page {
    status: StatusCode,
    html: String,
    policy: HeaderValue,
}

impl Page {
    pub fn with_status(mut self, status: StatusCode) -> Page {
        self.status = status;
        self
    }

    pub fn html(&self) -> &str {
        &self.html
    }

    pub fn policy(&self) -> &HeaderValue {
        &self.policy
    }
}

impl IntoResponse for Page {
    fn into_response(self) -> Response {
        let mut response = Response::new(self.html.into());
        *response.status_mut() = self.status;
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        headers.insert(header::CONTENT_SECURITY_POLICY, self.policy);
        response
    }
}

/// What a page needs of the browser beyond showing itself.
#[derive(Debug, Clone, Copy, Default)]
pub struct Needs {
    /// The page's script asks the server for something: a passkey, a setup
    /// link or a confirmation.
    pub connect: bool,
    /// The page can open the "Confirm it's you" dialog. It implies `connect`.
    pub confirm_dialog: bool,
}

#[derive(Template)]
#[template(path = "base.html")]
struct Base<'a> {
    title: &'a str,
    instance_name: &'a str,
    nonce: &'a str,
    style: &'static str,
    script: &'static str,
    body: &'a str,
    confirm_dialog: bool,
}

fn new_nonce() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| Refusal::internal("no randomness was available"))?;
    Ok(hex::encode(bytes))
}

/// Puts a page's body in the one layout, under a nonce of its own.
fn document(title: &str, instance_name: &str, body: &str, needs: Needs) -> Result<Page> {
    let nonce = new_nonce()?;
    let connect = needs.connect || needs.confirm_dialog;
    let html = Base {
        title,
        instance_name,
        nonce: &nonce,
        style: STYLE,
        script: SCRIPT,
        body,
        confirm_dialog: needs.confirm_dialog,
    }
    .render()
    .map_err(|_| Refusal::internal("a page did not render"))?;
    // No `form-action`: Chrome applies it to the redirect after a post, and
    // the consent decision redirects to the app's own address.
    let policy = format!(
        "default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; \
         img-src data:; {}base-uri 'none'; frame-ancestors 'none'",
        if connect { "connect-src 'self'; " } else { "" }
    );
    Ok(Page {
        status: StatusCode::OK,
        html,
        policy: HeaderValue::from_str(&policy)
            .map_err(|_| Refusal::internal("a page policy was not a header"))?,
    })
}

fn render_body<T: Template>(template: &T) -> Result<String> {
    template
        .render()
        .map_err(|_| Refusal::internal("a page did not render"))
}

#[cfg(test)]
mod tests;

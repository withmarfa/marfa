use askama::Template;

use super::wait::Wait;
use super::{Needs, Page, document, render_body};
use crate::app::refusal::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignInProblem {
    InvalidCredentials,
    MissingField,
    TooManyAttempts(Option<Wait>),
    Other,
}

impl SignInProblem {
    /// No error names no problem; a code the page was not built to know is never repeated.
    pub fn from_query(error: Option<&str>, retry_after: Option<&str>) -> Option<SignInProblem> {
        Some(match error? {
            "" => return None,
            "invalid_credentials" => SignInProblem::InvalidCredentials,
            "missing_field" => SignInProblem::MissingField,
            "too_many_attempts" => SignInProblem::TooManyAttempts(Wait::from_query(retry_after)),
            _ => SignInProblem::Other,
        })
    }

    /// The sentence without its closing full stop, which the page sets after any advice.
    fn message(self) -> String {
        match self {
            SignInProblem::InvalidCredentials => {
                "That username or password isn't right. Check them and try again".into()
            }
            SignInProblem::MissingField => "Enter your username and your password".into(),
            SignInProblem::TooManyAttempts(Some(wait)) => {
                format!("Too many attempts. Try again in {wait}")
            }
            SignInProblem::TooManyAttempts(None) => "Too many attempts. Try again later".into(),
            SignInProblem::Other => "Something went wrong. Try again".into(),
        }
    }

    /// A password lock does not close a passkey, so a lockout may say so.
    fn names_a_passkey(self) -> bool {
        matches!(self, SignInProblem::TooManyAttempts(_))
    }
}

#[derive(Debug, Clone)]
pub struct SignIn {
    pub username: String,
    /// A path on the instance. The caller has already replaced anything else.
    pub return_to: String,
    /// A refused form comes back with it so the page still names the app.
    pub authorization: Option<String>,
    pub app: Option<String>,
    pub problem: Option<SignInProblem>,
    /// Whether the owner holds a passkey that signs in here, which decides if the page offers one.
    pub passkey: bool,
}

#[derive(Template)]
#[template(path = "sign_in.html")]
struct SignInBody<'a> {
    view: &'a SignIn,
    problem_message: Option<String>,
    has_problem: bool,
    /// Whether the lockout line adds "or use a passkey", which the page shows with the button.
    passkey_advice: bool,
}

pub fn sign_in(view: &SignIn) -> Result<Page> {
    let body = render_body(&SignInBody {
        view,
        problem_message: view.problem.map(SignInProblem::message),
        has_problem: view.problem.is_some(),
        passkey_advice: view.passkey && view.problem.is_some_and(SignInProblem::names_a_passkey),
    })?;
    document(
        "Sign in",
        &body,
        Needs {
            connect: true,
            confirm_dialog: false,
        },
    )
}

#[derive(Debug, Clone)]
pub struct SignedIn {
    pub username: String,
    /// Where Continue goes. Anything but a path on the instance becomes `/`.
    pub continue_to: String,
}

#[derive(Template)]
#[template(path = "signed_in.html")]
struct SignedInBody<'a> {
    view: &'a SignedIn,
}

fn local_path(candidate: &str) -> &str {
    let is_path = candidate.starts_with('/')
        && !candidate.starts_with("//")
        && !candidate.starts_with("/\\")
        && !candidate.chars().any(char::is_control);
    if is_path { candidate } else { "/" }
}

pub fn signed_in(view: &SignedIn) -> Result<Page> {
    let view = SignedIn {
        continue_to: local_path(&view.continue_to).to_owned(),
        ..view.clone()
    };
    let body = render_body(&SignedInBody { view: &view })?;
    document(
        "You’re signed in",
        &body,
        Needs {
            connect: true,
            confirm_dialog: false,
        },
    )
}

#[derive(Debug, Clone)]
pub struct Running {
    pub username: String,
}

#[derive(Template)]
#[template(path = "running.html")]
struct RunningBody<'a> {
    view: &'a Running,
}

/// The root as the signed-in owner sees it.
pub fn running(view: &Running) -> Result<Page> {
    let body = render_body(&RunningBody { view })?;
    document(
        "This Marfa is running",
        &body,
        Needs {
            connect: true,
            confirm_dialog: false,
        },
    )
}

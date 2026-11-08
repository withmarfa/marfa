use askama::Template;

use super::wait::Wait;
use super::{Needs, Page, document, render_body};
use crate::app::refusal::Result;

/// What the sign-in form's redirect said went wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignInProblem {
    InvalidCredentials,
    MissingField,
    TooManyAttempts(Option<Wait>),
    Other,
}

impl SignInProblem {
    /// The page's `error` and `retry_after` query values. No error names no
    /// problem, and the page never repeats a code it was not built to know.
    pub fn from_query(error: Option<&str>, retry_after: Option<&str>) -> Option<SignInProblem> {
        Some(match error? {
            "" => return None,
            "invalid_credentials" => SignInProblem::InvalidCredentials,
            "missing_field" => SignInProblem::MissingField,
            "too_many_attempts" => SignInProblem::TooManyAttempts(Wait::from_query(retry_after)),
            _ => SignInProblem::Other,
        })
    }

    fn message(self) -> String {
        match self {
            SignInProblem::InvalidCredentials => {
                "That email or password isn't right. Check them and try again.".into()
            }
            SignInProblem::MissingField => "Enter your email and your password.".into(),
            SignInProblem::TooManyAttempts(Some(wait)) => {
                format!("Too many attempts. Try again in {wait}, or sign in with a passkey.")
            }
            SignInProblem::TooManyAttempts(None) => {
                "Too many attempts. Try again later, or sign in with a passkey.".into()
            }
            SignInProblem::Other => "Something went wrong. Try again.".into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SignIn {
    pub instance_name: String,
    /// The email typed before, so a wrong password costs one field.
    pub email: String,
    /// A path on the instance. The caller has already replaced anything else.
    pub return_to: String,
    /// The signed link the page was opened with, which a refused form comes
    /// back with so the page still names the app.
    pub authorization: Option<String>,
    /// The app an authorization the instance signed sent the person for.
    pub app: Option<String>,
    pub problem: Option<SignInProblem>,
}

#[derive(Template)]
#[template(path = "sign_in.html")]
struct SignInBody<'a> {
    view: &'a SignIn,
    problem_message: Option<String>,
    has_problem: bool,
}

pub fn sign_in(view: &SignIn) -> Result<Page> {
    let body = render_body(&SignInBody {
        view,
        problem_message: view.problem.map(SignInProblem::message),
        has_problem: view.problem.is_some(),
    })?;
    document(
        "Sign in",
        &view.instance_name,
        &body,
        Needs {
            connect: true,
            confirm_dialog: false,
        },
    )
}

#[derive(Debug, Clone)]
pub struct SignedIn {
    pub instance_name: String,
    pub email: String,
    /// Where Continue goes. Anything but a path on the instance becomes `/`.
    pub continue_to: String,
}

#[derive(Template)]
#[template(path = "signed_in.html")]
struct SignedInBody<'a> {
    view: &'a SignedIn,
}

/// A path on this instance, or `/`.
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
        "You're signed in",
        &view.instance_name,
        &body,
        Needs {
            connect: true,
            confirm_dialog: false,
        },
    )
}

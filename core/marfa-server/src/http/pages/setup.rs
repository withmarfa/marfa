use askama::Template;

use super::wait::Wait;
use super::{Needs, Page, document, render_body};
use crate::app::oauth::authorize::REQUEST_PATH;
use crate::app::oauth::device::CHECK_PATH;
use crate::app::refusal::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupCodeProblem {
    MissingCode,
    WrongCode,
    SessionEnded,
    TooManyAttempts(Option<Wait>),
    Other,
}

impl SetupCodeProblem {
    fn message(self, recovering: bool) -> String {
        match (self, recovering) {
            (SetupCodeProblem::MissingCode, false) => "Enter the setup code.".into(),
            (SetupCodeProblem::MissingCode, true) => "Enter the recovery code.".into(),
            (SetupCodeProblem::WrongCode, false) => "That setup code isn't right, or Marfa has \
                 replaced it since. Enter the newest code Marfa shows."
                .into(),
            (SetupCodeProblem::WrongCode, true) => {
                "That recovery code isn't right, or it was already used or has expired.".into()
            }
            (SetupCodeProblem::SessionEnded, false) => {
                "Your setup session ended. Enter the setup code again to continue.".into()
            }
            (SetupCodeProblem::SessionEnded, true) => {
                "Your recovery session ended. Restart Marfa for a new recovery code.".into()
            }
            (SetupCodeProblem::TooManyAttempts(Some(wait)), _) => {
                format!("Too many attempts. Try again in {wait}.")
            }
            (SetupCodeProblem::TooManyAttempts(None), _) => {
                "Too many attempts. Try again later.".into()
            }
            (SetupCodeProblem::Other, _) => "Something went wrong. Try again.".into(),
        }
    }
}

/// The app that led to setup, named only beside the host it sends the person back to.
#[derive(Debug, Clone)]
pub struct AskingApp {
    pub name: String,
    pub host: String,
}

/// Whether `return_to` goes on with an app's request to connect.
fn connects_an_app(return_to: &str) -> bool {
    let path = return_to.split(['?', '#']).next().unwrap_or_default();
    path == REQUEST_PATH || path == CHECK_PATH
}

#[derive(Debug, Clone)]
pub struct SetupCode {
    pub problem: Option<SetupCodeProblem>,
    /// Where the browser goes once the instance is claimed, as `kept` read it.
    pub return_to: String,
    pub app: Option<AskingApp>,
}

/// The code page of an instance that has an owner and offers a recovery code.
#[derive(Debug, Clone)]
pub struct RecoveryCode {
    pub problem: Option<SetupCodeProblem>,
}

#[derive(Template)]
#[template(path = "setup_code.html")]
struct SetupCodeBody<'a> {
    problem_message: Option<String>,
    has_problem: bool,
    return_to: &'a str,
    app: Option<&'a AskingApp>,
    connecting: bool,
}

#[derive(Template)]
#[template(path = "recovery_code.html")]
struct RecoveryCodeBody {
    problem_message: Option<String>,
    has_problem: bool,
}

/// The page also takes a `/setup#handoff=` link: its script exchanges the
/// ticket and reloads.
pub fn setup_code(view: &SetupCode) -> Result<Page> {
    let body = render_body(&SetupCodeBody {
        problem_message: view.problem.map(|problem| problem.message(false)),
        has_problem: view.problem.is_some(),
        return_to: &view.return_to,
        app: view.app.as_ref(),
        connecting: connects_an_app(&view.return_to),
    })?;
    document(
        "Claim this Marfa",
        &body,
        Needs {
            connect: true,
            confirm_dialog: None,
        },
    )
}

pub fn recovery_code(view: &RecoveryCode) -> Result<Page> {
    let body = render_body(&RecoveryCodeBody {
        problem_message: view.problem.map(|problem| problem.message(true)),
        has_problem: view.problem.is_some(),
    })?;
    document("Recover your account", &body, Needs::default())
}

#[derive(Debug, Clone, Default)]
pub struct SetupFieldErrors {
    pub name: Option<String>,
    pub username: Option<String>,
    pub email: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SetupDetails {
    /// What was typed before. The password is never sent back.
    pub name: String,
    pub username: String,
    pub email: String,
    pub errors: SetupFieldErrors,
    pub notice: Option<String>,
    /// Where the browser goes once the instance is claimed, as `kept` read it.
    pub return_to: String,
}

#[derive(Template)]
#[template(path = "setup_details.html")]
struct SetupDetailsBody<'a> {
    view: &'a SetupDetails,
    connecting: bool,
}

pub fn setup_details(view: &SetupDetails) -> Result<Page> {
    let body = render_body(&SetupDetailsBody {
        view,
        connecting: connects_an_app(&view.return_to),
    })?;
    document("Create your account", &body, Needs::default())
}

#[derive(Debug, Clone)]
pub struct RecoverPassword {
    pub error: Option<String>,
    pub notice: Option<String>,
}

#[derive(Template)]
#[template(path = "recover_password.html")]
struct RecoverPasswordBody<'a> {
    view: &'a RecoverPassword,
}

pub fn recover_password(view: &RecoverPassword) -> Result<Page> {
    let body = render_body(&RecoverPasswordBody { view })?;
    document("Choose a new password", &body, Needs::default())
}

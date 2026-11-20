use askama::Template;

use super::wait::Wait;
use super::{Needs, Page, document, render_body};
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
            (SetupCodeProblem::WrongCode, false) => {
                "That setup code isn't right. Check it and try again.".into()
            }
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

#[derive(Debug, Clone)]
pub struct SetupCode {
    pub instance_name: String,
    pub problem: Option<SetupCodeProblem>,
    /// The instance has an owner and offers a recovery code.
    pub recovering: bool,
}

#[derive(Template)]
#[template(path = "setup_code.html")]
struct SetupCodeBody {
    problem_message: Option<String>,
    has_problem: bool,
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
    let problem_message = view.problem.map(|problem| problem.message(view.recovering));
    let has_problem = view.problem.is_some();
    if view.recovering {
        let body = render_body(&RecoveryCodeBody {
            problem_message,
            has_problem,
        })?;
        return document(
            "Recover the owner",
            &view.instance_name,
            &body,
            Needs::default(),
        );
    }
    let body = render_body(&SetupCodeBody {
        problem_message,
        has_problem,
    })?;
    document(
        "Claim this Marfa",
        &view.instance_name,
        &body,
        Needs {
            connect: true,
            confirm_dialog: false,
        },
    )
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
    pub instance_name: String,
    /// What was typed before. The password is never sent back.
    pub name: String,
    pub username: String,
    pub email: String,
    pub errors: SetupFieldErrors,
    pub notice: Option<String>,
}

#[derive(Template)]
#[template(path = "setup_details.html")]
struct SetupDetailsBody<'a> {
    view: &'a SetupDetails,
}

pub fn setup_details(view: &SetupDetails) -> Result<Page> {
    let body = render_body(&SetupDetailsBody { view })?;
    document(
        "Create your account",
        &view.instance_name,
        &body,
        Needs::default(),
    )
}

#[derive(Debug, Clone)]
pub struct RecoverPassword {
    pub instance_name: String,
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
    document(
        "Choose a new password",
        &view.instance_name,
        &body,
        Needs::default(),
    )
}

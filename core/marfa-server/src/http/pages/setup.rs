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
    fn message(self) -> String {
        match self {
            SetupCodeProblem::MissingCode => "Enter the setup code.".into(),
            SetupCodeProblem::WrongCode => {
                "That setup code isn't right. Check it and try again.".into()
            }
            SetupCodeProblem::SessionEnded => {
                "Your setup session ended. Enter the setup code again to continue.".into()
            }
            SetupCodeProblem::TooManyAttempts(Some(wait)) => {
                format!("Too many attempts. Try again in {wait}.")
            }
            SetupCodeProblem::TooManyAttempts(None) => "Too many attempts. Try again later.".into(),
            SetupCodeProblem::Other => "Something went wrong. Try again.".into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SetupCode {
    pub instance_name: String,
    pub problem: Option<SetupCodeProblem>,
}

#[derive(Template)]
#[template(path = "setup_code.html")]
struct SetupCodeBody {
    problem_message: Option<String>,
    has_problem: bool,
}

/// The page also takes a `/setup#handoff=` link: its script exchanges the
/// ticket and reloads.
pub fn setup_code(view: &SetupCode) -> Result<Page> {
    let body = render_body(&SetupCodeBody {
        problem_message: view.problem.map(SetupCodeProblem::message),
        has_problem: view.problem.is_some(),
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
    pub email: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SetupDetails {
    pub instance_name: String,
    /// What was typed before. The password is never sent back.
    pub name: String,
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

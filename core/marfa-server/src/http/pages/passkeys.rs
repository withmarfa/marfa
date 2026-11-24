use askama::Template;

use super::wait::Wait;
use super::{Needs, Page, document, render_body};
use crate::app::refusal::Result;

#[derive(Debug, Clone)]
pub struct OwnerPasskey {
    pub id: String,
    pub name: String,
    pub added: String,
    pub last_used: Option<String>,
    pub made_for: Option<String>,
}

/// What a form sent without JavaScript got wrong, as the line under the group it is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordProblem {
    CurrentNotRight,
    NewTooShort,
    NotTheSame,
    TooManyAttempts(Option<Wait>),
    Other,
}

impl PasswordProblem {
    /// No problem named is none; a code the page was not built to know is never repeated.
    pub fn from_query(problem: Option<&str>, retry_after: Option<&str>) -> Option<PasswordProblem> {
        Some(match problem? {
            "" => return None,
            "current_not_right" => PasswordProblem::CurrentNotRight,
            "new_too_short" => PasswordProblem::NewTooShort,
            "not_the_same" => PasswordProblem::NotTheSame,
            "too_many_attempts" => PasswordProblem::TooManyAttempts(Wait::from_query(retry_after)),
            _ => PasswordProblem::Other,
        })
    }

    fn message(self) -> String {
        match self {
            PasswordProblem::CurrentNotRight => "That password isn't right.".into(),
            PasswordProblem::NewTooShort => "Use at least 8 characters.".into(),
            PasswordProblem::NotTheSame => "The passwords don't match.".into(),
            PasswordProblem::TooManyAttempts(Some(wait)) => {
                format!("Too many attempts. Try again in {wait}.")
            }
            PasswordProblem::TooManyAttempts(None) => "Too many attempts. Try again later.".into(),
            PasswordProblem::Other => "Something went wrong. Try again.".into(),
        }
    }

    fn is_about_current(self) -> bool {
        self == PasswordProblem::CurrentNotRight
    }
}

#[derive(Debug, Clone)]
pub struct OwnerPasskeys {
    /// For a password manager to file the new password under.
    pub username: String,
    pub rows: Vec<OwnerPasskey>,
    /// The password was just changed.
    pub changed: bool,
    pub problem: Option<PasswordProblem>,
}

#[derive(Template)]
#[template(path = "passkeys.html")]
struct PasskeysBody<'a> {
    username: &'a str,
    rows: &'a [OwnerPasskey],
    changed: bool,
    current_problem: String,
    new_problem: String,
}

pub fn owner_passkeys(view: &OwnerPasskeys) -> Result<Page> {
    let (current_problem, new_problem) = match view.problem {
        Some(problem) if problem.is_about_current() => (problem.message(), String::new()),
        Some(problem) => (String::new(), problem.message()),
        None => (String::new(), String::new()),
    };
    let body = render_body(&PasskeysBody {
        username: &view.username,
        rows: &view.rows,
        changed: view.changed,
        current_problem,
        new_problem,
    })?;
    document(
        "Passkeys and password",
        &body,
        Needs {
            connect: true,
            confirm_dialog: true,
        },
    )
}

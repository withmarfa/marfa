use askama::Template;

use super::wait::Wait;
use super::{Needs, Page, document, render_body};
use crate::app::refusal::Result;

/// What the code entry form's redirect said went wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceProblem {
    /// Unknown, or expired and already removed: the page cannot tell which.
    InvalidCode,
    /// The server still holds the code and knows it ended.
    ExpiredCode,
    TooManyAttempts(Option<Wait>),
    Other,
}

impl DeviceProblem {
    pub fn from_query(error: Option<&str>, retry_after: Option<&str>) -> Option<DeviceProblem> {
        Some(match error? {
            "" => return None,
            "invalid_code" => DeviceProblem::InvalidCode,
            "expired_code" => DeviceProblem::ExpiredCode,
            "too_many_attempts" => DeviceProblem::TooManyAttempts(Wait::from_query(retry_after)),
            _ => DeviceProblem::Other,
        })
    }

    fn message(self) -> String {
        match self {
            DeviceProblem::InvalidCode => "That code isn't right or has expired. Check it against \
                 your device, or start again there to get a new one."
                .into(),
            DeviceProblem::ExpiredCode => {
                "That code has expired. Start again on your device to get a new one.".into()
            }
            DeviceProblem::TooManyAttempts(Some(wait)) => {
                format!("Too many codes. Try again in {wait}.")
            }
            DeviceProblem::TooManyAttempts(None) => "Too many codes. Try again later.".into(),
            DeviceProblem::Other => "Something went wrong. Try again.".into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct DeviceEntry {
    pub instance_name: String,
    /// A code already known, from the link a device shows.
    pub user_code: String,
    pub problem: Option<DeviceProblem>,
}

#[derive(Template)]
#[template(path = "device.html")]
struct DeviceBody<'a> {
    view: &'a DeviceEntry,
    problem_message: Option<String>,
    has_problem: bool,
    invalid_code: bool,
    show_lifetime: bool,
}

pub fn device_entry(view: &DeviceEntry) -> Result<Page> {
    let body = render_body(&DeviceBody {
        view,
        problem_message: view.problem.map(DeviceProblem::message),
        has_problem: view.problem.is_some(),
        invalid_code: matches!(
            view.problem,
            Some(DeviceProblem::InvalidCode | DeviceProblem::ExpiredCode)
        ),
        // A wait is already said in minutes, and a second figure beside it
        // reads as a second wait.
        show_lifetime: !matches!(view.problem, Some(DeviceProblem::TooManyAttempts(_))),
    })?;
    document(
        "Enter your code",
        &view.instance_name,
        &body,
        Needs::default(),
    )
}

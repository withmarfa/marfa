use askama::Template;

use super::wait::Wait;
use super::{Needs, Page, document, render_body};
use crate::app::refusal::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceProblem {
    /// Unknown, or expired and already removed: the page cannot tell which.
    InvalidCode,
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
            DeviceProblem::InvalidCode => {
                "That code isn’t right or has expired. Check your device.".into()
            }
            DeviceProblem::ExpiredCode => {
                "That code has expired. Start again on your device.".into()
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
    pub user_code: String,
    pub problem: Option<DeviceProblem>,
}

#[derive(Template)]
#[template(path = "device.html")]
struct DeviceBody<'a> {
    view: &'a DeviceEntry,
    problem_message: Option<String>,
    invalid_code: bool,
}

pub fn device_entry(view: &DeviceEntry) -> Result<Page> {
    let body = render_body(&DeviceBody {
        view,
        problem_message: view.problem.map(DeviceProblem::message),
        invalid_code: matches!(
            view.problem,
            Some(DeviceProblem::InvalidCode | DeviceProblem::ExpiredCode)
        ),
    })?;
    document("Enter the code", &body, Needs::default())
}

/// The code a device shows, for the owner to compare before the approval page opens.
#[derive(Debug, Clone)]
pub struct DeviceCheck {
    /// The code's characters alone, as the device shows them.
    pub user_code: String,
    /// As the link or the form carried it, which the confirmation sends back.
    pub typed: String,
}

#[derive(Template)]
#[template(path = "device_check.html")]
struct DeviceCheckBody<'a> {
    view: &'a DeviceCheck,
    said: String,
}

pub fn device_check(view: &DeviceCheck) -> Result<Page> {
    let code = &view.user_code;
    let said = match (code.get(..4), code.get(4..)) {
        (Some(first), Some(rest)) if !rest.is_empty() => format!("{first}-{rest}"),
        _ => code.clone(),
    };
    let body = render_body(&DeviceCheckBody { view, said })?;
    document("Check the code", &body, Needs::default())
}

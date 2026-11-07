use askama::Template;

use super::{Needs, Page, document, render_body};
use crate::app::access::Level;
use crate::app::oauth::offer::{CHOOSE_TYPES, Choice, FULL_ACCESS, LevelRow, Offer};
use crate::app::refusal::Result;

/// What a consent page's form answers.
#[derive(Debug, Clone)]
pub enum Answering {
    /// The signed query of an authorization.
    Authorization(String),
    /// A device's user code, as typed.
    Device(String),
}

/// A page that asks a person to approve an app.
#[derive(Debug, Clone)]
pub struct Consent {
    pub instance_name: String,
    pub offer: Offer,
    pub answering: Answering,
}

struct Pick {
    value: String,
    word: &'static str,
    selected: bool,
}

struct Control {
    label: String,
    field: &'static str,
    options: Vec<Pick>,
    open_ended: bool,
}

fn word_of(level: Level) -> &'static str {
    match level {
        Level::None => "No access",
        Level::Read => "Read only",
        Level::Write => "Read and edit",
    }
}

fn option_of(choice: &Choice, selected: &str) -> Pick {
    Pick {
        value: choice.value.clone(),
        word: word_of(choice.level),
        selected: choice.value == selected,
    }
}

fn control_of(row: &LevelRow, field: &'static str) -> Control {
    let mut options: Vec<Pick> = row
        .choices
        .iter()
        .map(|choice| option_of(choice, &row.selected))
        .collect();
    if !row.types.is_empty() {
        options.push(Pick {
            value: CHOOSE_TYPES.to_string(),
            word: "Choose types",
            selected: false,
        });
    }
    Control {
        label: row.pattern.clone(),
        field,
        options,
        open_ended: row.open_ended,
    }
}

#[derive(Template)]
#[template(path = "consent.html")]
struct ConsentBody<'a> {
    view: &'a Consent,
    action: &'static str,
    link_field: &'static str,
    link_value: &'a str,
    answer_field: &'static str,
    yes: &'static str,
    no: &'static str,
    page_addresses: String,
    full_access: &'static str,
    controls: Vec<Control>,
    type_controls: Vec<Control>,
}

fn page_addresses(origins: &[String]) -> String {
    let shown: Vec<&str> = origins
        .iter()
        .map(|origin| origin.strip_prefix("https://").unwrap_or(origin))
        .collect();
    shown.join(" and ")
}

pub fn consent(view: &Consent) -> Result<Page> {
    let (action, link_field, link_value, answer_field, yes, no) = match &view.answering {
        Answering::Authorization(query) => (
            "/auth/authorize/decision",
            "oauth_query",
            query.as_str(),
            "accept",
            "true",
            "false",
        ),
        Answering::Device(code) => (
            "/auth/device/consent",
            "user_code",
            code.as_str(),
            "decision",
            "approve",
            "deny",
        ),
    };
    let offer = &view.offer;
    let controls = offer
        .data
        .iter()
        .chain(&offer.profile)
        .map(|row| control_of(row, "scopes"))
        .collect();
    let type_controls = offer
        .data
        .iter()
        .flat_map(|row| &row.types)
        .map(|row| control_of(row, "types"))
        .collect();
    let body = render_body(&ConsentBody {
        view,
        action,
        link_field,
        link_value,
        answer_field,
        yes,
        no,
        page_addresses: page_addresses(&offer.app.web_origins),
        full_access: FULL_ACCESS,
        controls,
        type_controls,
    })?;
    document(
        "Approve this app",
        &view.instance_name,
        &body,
        Needs {
            connect: false,
            confirm_dialog: offer.confirm,
        },
    )
}

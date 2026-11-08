use askama::Template;

use super::words;
use super::{Needs, Page, document, render_body};
use crate::app::access::Level;
use crate::app::oauth::offer::{
    CHOOSE_TYPES, Choice, FULL_ACCESS, Held, LevelRow, Offer, Power, Reach,
};
use crate::app::refusal::Result;

#[derive(Debug, Clone)]
pub enum Answering {
    Authorization(String),
    Device(String),
}

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

struct Ident {
    id: String,
    text: String,
}

struct Row {
    id: String,
    field: &'static str,
    title: String,
    lines: Vec<String>,
    ident: Option<Ident>,
    now: Option<&'static str>,
    options: Vec<Pick>,
    switches_types: bool,
}

struct DataRow {
    row: Row,
    types: Vec<Row>,
}

struct PowerRow {
    id: String,
    literal: String,
    title: String,
    line: Option<String>,
    cannot_be_undone: bool,
}

struct HeldRow {
    title: String,
    level: &'static str,
}

struct Gives {
    text: String,
    danger: bool,
}

/// The page's own rows have no identifier, and one type is never at odds with itself.
struct Titled {
    title: String,
    type_id: Option<String>,
}

fn titled(row: &LevelRow) -> Titled {
    Titled {
        title: words::title(row.reach, &row.pattern, row.label.as_deref()),
        type_id: (row.reach == Reach::Type && !row.pattern.contains('*'))
            .then(|| row.pattern.clone()),
    }
}

fn option_of(choice: &Choice, selected: &str) -> Pick {
    Pick {
        value: choice.value.clone(),
        word: words::level(choice.level),
        selected: choice.value == selected,
    }
}

struct Numbering {
    next: usize,
    shared: Vec<Titled>,
}

impl Numbering {
    fn row(&mut self, row: &LevelRow, field: &'static str) -> Row {
        self.next += 1;
        let own = titled(row);
        let clashes = own.type_id.as_ref().is_some_and(|id| {
            self.shared
                .iter()
                .any(|other| other.title == own.title && other.type_id.as_ref() != Some(id))
        });
        let mut lines = Vec::new();
        if let Some(text) = words::description(row) {
            lines.push(text);
        }
        if row.open_ended {
            lines.push(words::reach_line(&row.covers));
        }
        let mut options: Vec<Pick> = row
            .choices
            .iter()
            .map(|choice| option_of(choice, &row.selected))
            .collect();
        if !row.types.is_empty() {
            options.push(Pick {
                value: CHOOSE_TYPES.to_string(),
                word: words::CHOOSE_TYPES_WORD,
                selected: false,
            });
        }
        Row {
            id: format!("row-{}", self.next),
            field,
            ident: clashes.then(|| Ident {
                id: format!("ident-{}", self.next),
                text: row.pattern.clone(),
            }),
            now: (row.held != Level::None).then(|| words::level(row.held)),
            title: own.title,
            lines,
            options,
            switches_types: !row.types.is_empty(),
        }
    }
}

fn power_row(index: usize, power: &Power) -> PowerRow {
    let known = words::power(&power.literal);
    let note = known.and_then(|words| words.note);
    let line = match (note, power.cannot_be_undone) {
        (Some(note), true) => Some(format!("{note} {}", words::UNDONE_MARK)),
        (Some(note), false) => Some(note.to_string()),
        (None, true) => Some(words::UNDONE_MARK.to_string()),
        (None, false) => None,
    };
    PowerRow {
        id: format!("power-{index}"),
        literal: power.literal.clone(),
        title: known.map_or_else(|| power.literal.clone(), |words| words.title.to_string()),
        line,
        cannot_be_undone: power.cannot_be_undone,
    }
}

fn held_row(held: &Held) -> HeldRow {
    HeldRow {
        title: words::title(held.reach, &held.pattern, held.label.as_deref()),
        level: words::level(held.level),
    }
}

fn gives(offer: &Offer, powers: &[PowerRow]) -> Vec<Gives> {
    let mut lines = Vec::new();
    for level in [Level::Write, Level::Read] {
        let titles: Vec<String> = offer
            .data
            .iter()
            .chain(&offer.profile)
            .filter(|row| row.choices.last().map(|choice| choice.level) == Some(level))
            .map(|row| titled(row).title)
            .collect();
        if !titles.is_empty() {
            lines.push(Gives {
                text: format!("{}: {}", words::level(level), titles.join(", ")),
                danger: false,
            });
        }
    }
    if !powers.is_empty() {
        let names: Vec<String> = powers
            .iter()
            .map(|power| words::lower_first(&power.title))
            .collect();
        lines.push(Gives {
            text: format!("Control over Marfa: {}", names.join("; ")),
            danger: false,
        });
    }
    let undone: Vec<String> = powers
        .iter()
        .filter(|power| power.cannot_be_undone)
        .map(|power| words::lower_first(&power.title))
        .collect();
    if !undone.is_empty() {
        lines.push(Gives {
            text: format!("Can't be undone: {}", undone.join("; ")),
            danger: true,
        });
    }
    lines
}

fn powers_summary(count: usize) -> String {
    let things = if count == 1 { "thing" } else { "things" };
    format!("{count} {things} asked, each off until you turn it on")
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
    device_code: Option<String>,
    page_addresses: String,
    full_access: &'static str,
    edit_line: &'static str,
    legend: &'static str,
    held: Vec<HeldRow>,
    gives: Vec<Gives>,
    data: Vec<DataRow>,
    profile: Vec<Row>,
    powers: Vec<PowerRow>,
    powers_title: &'static str,
    powers_summary: String,
}

fn shown_code(code: &str) -> String {
    let compact: String = code.chars().filter(|c| c.is_alphanumeric()).collect();
    if compact.chars().count() == 8 {
        let first: String = compact.chars().take(4).collect();
        let second: String = compact.chars().skip(4).collect();
        format!("{first}-{second}")
    } else {
        code.to_string()
    }
}

fn page_addresses(origins: &[String]) -> String {
    let shown: Vec<&str> = origins
        .iter()
        .map(|origin| origin.strip_prefix("https://").unwrap_or(origin))
        .collect();
    shown.join(" and ")
}

pub fn consent(view: &Consent) -> Result<Page> {
    let (action, link_field, link_value, answer_field, yes, no, device_code) = match &view.answering
    {
        Answering::Authorization(query) => (
            "/auth/authorize/decision",
            "oauth_query",
            query.as_str(),
            "accept",
            "true",
            "false",
            None,
        ),
        Answering::Device(code) => (
            "/auth/device/consent",
            "user_code",
            code.as_str(),
            "decision",
            "approve",
            "deny",
            Some(shown_code(code)),
        ),
    };
    let offer = &view.offer;
    let shared: Vec<Titled> = offer
        .data
        .iter()
        .chain(&offer.profile)
        .flat_map(|row| std::iter::once(row).chain(&row.types))
        .map(titled)
        .collect();
    let mut numbering = Numbering { next: 0, shared };
    let data = offer
        .data
        .iter()
        .map(|row| DataRow {
            row: numbering.row(row, "scopes"),
            types: row
                .types
                .iter()
                .map(|one| numbering.row(one, "types"))
                .collect(),
        })
        .collect();
    let profile = offer
        .profile
        .iter()
        .map(|row| numbering.row(row, "scopes"))
        .collect();
    let mut ordered: Vec<&Power> = offer.powers.iter().collect();
    ordered.sort_by_key(|power| words::power_rank(&power.literal));
    let powers: Vec<PowerRow> = ordered
        .into_iter()
        .enumerate()
        .map(|(index, power)| power_row(index, power))
        .collect();
    let held = offer
        .held
        .iter()
        .map(held_row)
        .chain(offer.held_powers.iter().map(|power| {
            HeldRow {
                title: words::power(&power.literal)
                    .map_or_else(|| power.literal.clone(), |words| words.title.to_string()),
                level: "Allowed",
            }
        }))
        .collect();
    let body = render_body(&ConsentBody {
        view,
        action,
        link_field,
        link_value,
        answer_field,
        yes,
        no,
        device_code,
        page_addresses: page_addresses(&offer.app.web_origins),
        full_access: FULL_ACCESS,
        edit_line: words::EDIT_LINE,
        legend: if offer.returning {
            "New in this request"
        } else {
            "What to allow"
        },
        held,
        gives: gives(offer, &powers),
        data,
        profile,
        powers_summary: powers_summary(powers.len()),
        powers,
        powers_title: words::POWERS_TITLE,
    })?;
    document(
        "Allow access",
        &view.instance_name,
        &body,
        Needs {
            connect: true,
            confirm_dialog: offer.confirm,
        },
    )
}

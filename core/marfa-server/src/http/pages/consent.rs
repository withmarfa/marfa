use askama::Template;

use super::words;
use super::{Needs, Page, document, render_body};
use crate::app::access::{Level, Permission};
use crate::app::oauth::offer::{
    Admin, AdminLevel, CHOOSE_TYPES, Choice, Held, LevelRow, Offer, Reach,
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
    /// An approval was posted from a page built on access the app no longer holds as it did.
    pub changed: bool,
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
}

struct DataRow {
    row: Row,
    types: Vec<Row>,
}

struct PowerRow {
    id: String,
    title: String,
    line: Option<&'static str>,
    options: [Pick; 2],
}

struct AdminRow {
    title: &'static str,
    options: Vec<Pick>,
    powers: Vec<PowerRow>,
}

struct HeldRow {
    title: String,
    level: &'static str,
}

struct Gives {
    text: String,
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

fn option_of(choice: &Choice, selected: &str, yes_or_no: bool) -> Pick {
    let word = match (yes_or_no, choice.level) {
        (true, Level::None) => words::DONT_ALLOW,
        (true, _) => words::ALLOW,
        (false, level) => words::level(level),
    };
    Pick {
        value: choice.value.clone(),
        word,
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
            .map(|choice| option_of(choice, &row.selected, row.yes_or_no))
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
        }
    }
}

fn power_title(power: Permission) -> String {
    words::power(power.word())
        .map_or_else(|| power.word().to_string(), |words| words.title.to_string())
}

fn power_row(index: usize, power: Permission) -> PowerRow {
    PowerRow {
        id: format!("power-{index}"),
        title: power_title(power),
        line: words::power(power.word()).and_then(|words| words.note),
        options: [
            Pick {
                value: String::new(),
                word: words::DONT_ALLOW,
                selected: false,
            },
            Pick {
                value: power.word().to_string(),
                word: words::ALLOW,
                selected: true,
            },
        ],
    }
}

fn admin_row(admin: &Admin) -> AdminRow {
    let mut ordered = admin.powers.clone();
    ordered.sort_by_key(|power| words::power_rank(power.word()));
    AdminRow {
        title: words::ADMIN_TITLE,
        options: admin
            .levels
            .iter()
            .enumerate()
            .map(|(at, level)| Pick {
                value: level.word().to_string(),
                word: words::admin_level(*level),
                selected: at == 0,
            })
            .collect(),
        powers: ordered
            .into_iter()
            .enumerate()
            .map(|(index, power)| power_row(index, power))
            .collect(),
    }
}

fn held_row(held: &Held) -> HeldRow {
    HeldRow {
        title: words::title(held.reach, &held.pattern, held.label.as_deref()),
        level: words::level(held.level),
    }
}

fn gives(offer: &Offer, admin: Option<&AdminRow>) -> Vec<Gives> {
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
            });
        }
    }
    if let Some(admin) = admin {
        let names: Vec<String> = admin
            .powers
            .iter()
            .map(|power| words::lower_first(&power.title))
            .collect();
        lines.push(Gives {
            text: format!("{}: {}", admin.title, names.join("; ")),
        });
    }
    lines
}

#[derive(Template)]
#[template(path = "consent.html")]
struct ConsentBody<'a> {
    view: &'a Consent,
    action: &'static str,
    link_field: &'static str,
    link_value: &'a str,
    device_code: Option<String>,
    app_bracket: String,
    app_line: Option<String>,
    edit_line: &'static str,
    legend: &'static str,
    held: Vec<HeldRow>,
    gives: Vec<Gives>,
    data: Vec<DataRow>,
    profile: Vec<Row>,
    admin: Option<AdminRow>,
    custom: &'static str,
    choose_types: &'static str,
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

pub fn consent(view: &Consent) -> Result<Page> {
    let (action, link_field, link_value, device_code) = match &view.answering {
        Answering::Authorization(query) => (
            "/auth/consent",
            "authorization_request",
            query.as_str(),
            None,
        ),
        Answering::Device(code) => (
            "/auth/device/consent",
            "user_code",
            code.as_str(),
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
    let admin = offer.admin.as_ref().map(admin_row);
    let held = offer
        .held
        .iter()
        .map(held_row)
        .chain(offer.held_powers.iter().map(|power| HeldRow {
            title: power_title(*power),
            level: "Allowed",
        }))
        .collect();
    let body = render_body(&ConsentBody {
        view,
        action,
        link_field,
        link_value,
        device_code,
        app_bracket: words::app_bracket(&offer.app),
        app_line: words::app_line(&offer.app),
        edit_line: words::EDIT_LINE,
        legend: if offer.returning {
            "New in this request"
        } else {
            "What to allow"
        },
        held,
        gives: gives(offer, admin.as_ref()),
        data,
        profile,
        admin,
        custom: AdminLevel::Custom.word(),
        choose_types: CHOOSE_TYPES,
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

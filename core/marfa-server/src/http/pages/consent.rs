use askama::Template;

use super::words;
use super::{Needs, Page, document, render_body};
use crate::app::access::{Level, Permission};
use crate::app::oauth::offer::{
    Admin, AdminLevel, CHOOSE_TYPES, Choice, LevelRow, Offer, Post, Reach, powers_at,
};
use crate::app::refusal::Result;

#[derive(Debug, Clone)]
pub enum Answering {
    Authorization(String),
    Device(String),
}

#[derive(Debug, Clone)]
pub struct Consent {
    pub offer: Offer,
    pub answering: Answering,
    /// An approval posted from a page built on access the app no longer holds as it did, drawn
    /// again with the choices it made.
    pub again: Option<Post>,
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

impl Row {
    /// The id of the line that tells two rows of the same name apart, which the select names in `aria-describedby`.
    fn described_by(&self) -> &str {
        self.ident.as_ref().map_or("", |ident| ident.id.as_str())
    }
}

struct DataRow {
    row: Row,
    types: Vec<Row>,
    /// Without scripts every type row shows, and counts only under Each Type.
    counts: String,
}

struct PowerRow {
    id: String,
    title: String,
    line: Option<&'static str>,
    options: [Pick; 2],
}

impl PowerRow {
    /// The id of the line under the title, which the select names in `aria-describedby`.
    fn note_id(&self) -> String {
        if self.line.is_some() {
            format!("{}-note", self.id)
        } else {
            String::new()
        }
    }
}

struct AdminRow {
    title: &'static str,
    options: Vec<Pick>,
    powers: Vec<PowerRow>,
    /// Without scripts every power row shows, and counts only under Custom.
    counts: String,
    limited: Option<String>,
    asked: String,
}

/// A row of the summary box, or of what the app already holds.
struct Glance {
    symbol: &'static str,
    text: String,
}

/// The line under the Items box. The later-types sentence follows the first row that offers types.
struct ItemsAfter {
    edit: Option<&'static str>,
    later_by: Option<String>,
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

/// What a row shows chosen: its default on a first draw, and on a redraw the posted choice it
/// still offers, or its least.
fn chosen_of<'a>(row: &'a LevelRow, posted: Option<&'a [String]>) -> &'a str {
    let Some(posted) = posted else {
        return &row.selected;
    };
    if let Some(choice) = row
        .choices
        .iter()
        .rev()
        .find(|choice| !choice.value.is_empty() && posted.contains(&choice.value))
    {
        return &choice.value;
    }
    if !row.types.is_empty() && posted.iter().any(|value| value == CHOOSE_TYPES) {
        return CHOOSE_TYPES;
    }
    ""
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
    fn row(&mut self, row: &LevelRow, field: &'static str, posted: Option<&[String]>) -> Row {
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
        if row.open_ended && row.types.is_empty() {
            lines.push(words::reach_line(&row.covers));
        }
        let chosen = chosen_of(row, posted);
        let mut options: Vec<Pick> = row
            .choices
            .iter()
            .rev()
            .map(|choice| option_of(choice, chosen, row.yes_or_no))
            .collect();
        if !row.types.is_empty() {
            options.push(Pick {
                value: CHOOSE_TYPES.to_string(),
                word: words::CHOOSE_TYPES_WORD,
                selected: chosen == CHOOSE_TYPES,
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

fn power_row(index: usize, power: Permission, allowed: bool) -> PowerRow {
    PowerRow {
        id: format!("power-{index}"),
        title: power_title(power),
        line: words::power(power.word()).and_then(|words| words.note),
        options: [
            Pick {
                value: power.word().to_string(),
                word: words::ALLOW,
                selected: allowed,
            },
            Pick {
                value: String::new(),
                word: words::DONT_ALLOW,
                selected: !allowed,
            },
        ],
    }
}

/// On a redraw, the posted level where it is still offered and No access otherwise, and Allow
/// only on a row the post allowed.
fn admin_row(admin: &Admin, again: Option<&Post>) -> AdminRow {
    let mut ordered = admin.powers.clone();
    ordered.sort_by_key(|power| words::power_rank(power.word()));
    let level = match again {
        None => admin.levels.first().copied(),
        Some(post) => Some(
            admin
                .levels
                .iter()
                .copied()
                .find(|level| post.admin.as_deref() == Some(level.word()))
                .unwrap_or(AdminLevel::None),
        ),
    };
    let titles = |powers: &[Permission]| -> Vec<String> {
        powers
            .iter()
            .map(|power| words::lower_first(&power_title(*power)))
            .collect()
    };
    let limited = admin
        .levels
        .contains(&AdminLevel::Limited)
        .then(|| powers_at(AdminLevel::Limited, &ordered, &[]).unwrap_or_default())
        .map(|powers| words::limited_line(&titles(&powers)));
    let asked = if ordered.len() >= words::POWER_COUNT {
        format!("all {}", words::POWER_COUNT)
    } else {
        ordered.len().to_string()
    };
    AdminRow {
        title: words::ADMIN_TITLE,
        options: admin
            .levels
            .iter()
            .map(|one| Pick {
                value: one.word().to_string(),
                word: words::admin_level(*one),
                selected: Some(*one) == level,
            })
            .collect(),
        counts: words::counts_when(words::ADMIN_TITLE, words::admin_level(AdminLevel::Custom)),
        limited,
        asked,
        powers: ordered
            .into_iter()
            .enumerate()
            .map(|(index, power)| {
                let allowed =
                    again.is_none_or(|post| post.powers.iter().any(|row| row == power.word()));
                power_row(index, power, allowed)
            })
            .collect(),
    }
}

fn sorted_titles(powers: &[Permission]) -> Vec<String> {
    let mut ordered = powers.to_vec();
    ordered.sort_by_key(|power| words::power_rank(power.word()));
    ordered
        .iter()
        .map(|power| words::lower_first(&power_title(*power)))
        .collect()
}

/// A row's line in the summary: each row at the level it starts at.
fn gets(row: &LevelRow) -> Glance {
    let level = row
        .choices
        .last()
        .map_or(Level::None, |choice| choice.level);
    Glance {
        symbol: words::symbol(row.reach),
        text: words::gives(row.reach, &row.pattern, row.label.as_deref(), level),
    }
}

fn glance(offer: &Offer) -> Vec<Glance> {
    let mut lines: Vec<Glance> = offer.data.iter().chain(&offer.profile).map(gets).collect();
    if let Some(admin) = &offer.admin {
        lines.push(Glance {
            symbol: "sliders",
            text: words::admin_gives(&sorted_titles(&admin.powers)),
        });
    }
    lines
}

fn held_glance(offer: &Offer) -> Vec<Glance> {
    let mut lines: Vec<Glance> = offer
        .held
        .iter()
        .map(|held| Glance {
            symbol: words::symbol(held.reach),
            text: words::gives(held.reach, &held.pattern, held.label.as_deref(), held.level),
        })
        .collect();
    if !offer.held_powers.is_empty() {
        lines.push(Glance {
            symbol: "sliders",
            text: words::admin_gives(&sorted_titles(&offer.held_powers)),
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
    more_access: bool,
    app_bracket: String,
    app_line: Option<String>,
    also_wants: bool,
    also_wants_heading: &'static str,
    allowed_heading: &'static str,
    glance: Vec<Glance>,
    held: Vec<Glance>,
    data: Vec<DataRow>,
    items_after: ItemsAfter,
    later_included: &'static str,
    later_excluded: &'static str,
    later_unless: &'static str,
    choices: bool,
    profile: Vec<Row>,
    profile_after: Option<&'static str>,
    admin: Option<AdminRow>,
    custom: &'static str,
    full: &'static str,
    limited: &'static str,
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
    let again = view.again.as_ref();
    let scopes = again.map(|post| post.scopes.as_slice());
    let types = again.map(|post| post.types.as_slice());
    let data: Vec<DataRow> = offer
        .data
        .iter()
        .map(|row| {
            let row_drawn = numbering.row(row, "scopes", scopes);
            DataRow {
                counts: words::counts_when(&row_drawn.title, words::CHOOSE_TYPES_WORD),
                types: row
                    .types
                    .iter()
                    .map(|one| numbering.row(one, "types", types))
                    .collect(),
                row: row_drawn,
            }
        })
        .collect();
    let profile: Vec<Row> = offer
        .profile
        .iter()
        .map(|row| numbering.row(row, "scopes", scopes))
        .collect();
    let admin = offer.admin.as_ref().map(|admin| admin_row(admin, again));
    let items_after = ItemsAfter {
        edit: offer.offers_edit.then_some(words::EDIT_LINE),
        later_by: data
            .iter()
            .find(|one| !one.types.is_empty())
            .map(|one| one.row.id.clone()),
    };
    let profile_after = offer
        .profile
        .iter()
        .find(|row| row.pattern == "profile")
        .map(|row| {
            if row
                .choices
                .iter()
                .any(|choice| choice.level == Level::Write)
            {
                words::PROFILE_EDIT_FIELDS
            } else {
                words::PROFILE_FIELDS
            }
        });
    let choices = offer.asks_new && (!data.is_empty() || !profile.is_empty() || admin.is_some());
    let title_text = match &view.answering {
        Answering::Device(_) => "Allow this device?".to_string(),
        Answering::Authorization(_) => format!(
            "Allow {}{}?",
            offer.app.name,
            if offer.returning && offer.asks_new {
                " more access"
            } else {
                ""
            }
        ),
    };
    let body = render_body(&ConsentBody {
        view,
        action,
        link_field,
        link_value,
        device_code,
        more_access: offer.returning && offer.asks_new,
        app_bracket: words::app_bracket(&offer.app),
        app_line: words::app_line(&offer.app),
        also_wants: offer.returning && offer.asks_new,
        also_wants_heading: words::ALSO_WANTS,
        allowed_heading: words::ALREADY_ALLOWED,
        glance: if offer.asks_new {
            glance(offer)
        } else {
            Vec::new()
        },
        held: held_glance(offer),
        data,
        items_after,
        later_included: words::LATER_INCLUDED,
        later_excluded: words::LATER_NOT_INCLUDED,
        later_unless: words::LATER_UNLESS_EACH,
        choices,
        profile,
        profile_after,
        admin,
        custom: AdminLevel::Custom.word(),
        full: AdminLevel::Full.word(),
        limited: AdminLevel::Limited.word(),
        choose_types: CHOOSE_TYPES,
    })?;
    document(
        &title_text,
        &body,
        Needs {
            connect: true,
            confirm_dialog: offer.confirm,
        },
    )
}

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
    /// Shown under the box at Read Only, and always without scripts, since no choice shows it.
    read_only: Option<String>,
    asked: String,
}

/// A row of the summary box, or of what the app already holds. The object may carry a type's own
/// name, so it is drawn in its own direction; a row with no verb is all one phrase.
struct Glance {
    symbol: &'static str,
    verb: &'static str,
    object: String,
}

/// The line under the Items box. The later-types sentences follow the first row that offers types.
struct ItemsAfter {
    edit: Option<&'static str>,
    later_by: Option<String>,
    /// The values of the row that grant a level reaching types added later, which the page's
    /// script reads as a list divided by `|`.
    later_at: String,
    /// Without scripts, which levels reach types added later.
    later_by_level: String,
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
    let read_only = admin.levels.contains(&AdminLevel::ReadOnly).then(|| {
        words::read_only_line(&powers_at(AdminLevel::ReadOnly, &ordered, &[]).unwrap_or_default())
    });
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
        read_only,
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

fn admin_glance(powers: &[Permission]) -> Glance {
    Glance {
        symbol: "sliders",
        verb: "",
        object: words::admin_gives(&sorted_titles(powers)),
    }
}

/// A row's line in the summary: each row at the level it starts at.
fn gets(row: &LevelRow) -> Glance {
    let level = row
        .choices
        .last()
        .map_or(Level::None, |choice| choice.level);
    let (verb, object) = words::gives(row.reach, &row.pattern, row.label.as_deref(), level);
    Glance {
        symbol: words::symbol(row.reach),
        verb,
        object,
    }
}

fn glance(offer: &Offer) -> Vec<Glance> {
    let mut lines: Vec<Glance> = offer.data.iter().chain(&offer.profile).map(gets).collect();
    if let Some(admin) = &offer.admin {
        lines.push(admin_glance(&admin.powers));
    }
    lines
}

fn held_glance(offer: &Offer) -> Vec<Glance> {
    let mut lines: Vec<Glance> = offer
        .held
        .iter()
        .map(|held| {
            let (verb, object) =
                words::gives(held.reach, &held.pattern, held.label.as_deref(), held.level);
            Glance {
                symbol: words::symbol(held.reach),
                verb,
                object,
            }
        })
        .collect();
    if !offer.held_powers.is_empty() {
        lines.push(admin_glance(&offer.held_powers));
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
    device: bool,
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
    choices: bool,
    profile: Vec<Row>,
    profile_after: Option<&'static str>,
    admin: Option<AdminRow>,
    custom: &'static str,
    full: &'static str,
    read_only: &'static str,
    choose_types: &'static str,
}

pub fn consent(view: &Consent) -> Result<Page> {
    let (action, link_field, link_value) = match &view.answering {
        Answering::Authorization(query) => {
            ("/auth/consent", "authorization_request", query.as_str())
        }
        Answering::Device(code) => ("/auth/device/consent", "user_code", code.as_str()),
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
    let later_row = offer
        .data
        .iter()
        .zip(&data)
        .find(|(_, drawn)| !drawn.types.is_empty());
    let granting: Vec<&Choice> = later_row
        .map(|(row, _)| {
            row.choices
                .iter()
                .filter(|choice| choice.level != Level::None)
                .collect()
        })
        .unwrap_or_default();
    let items_after = ItemsAfter {
        edit: offer.offers_edit.then_some(words::EDIT_LINE),
        later_by: later_row.map(|(_, drawn)| drawn.row.id.clone()),
        later_at: granting
            .iter()
            .map(|choice| choice.value.as_str())
            .collect::<Vec<_>>()
            .join("|"),
        later_by_level: words::later_by_level(
            &granting
                .iter()
                .map(|choice| words::level(choice.level))
                .collect::<Vec<_>>(),
        ),
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
        device: matches!(view.answering, Answering::Device(_)),
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
        choices,
        profile,
        profile_after,
        admin,
        custom: AdminLevel::Custom.word(),
        full: AdminLevel::Full.word(),
        read_only: AdminLevel::ReadOnly.word(),
        choose_types: CHOOSE_TYPES,
    })?;
    document(
        &title_text,
        &body,
        Needs {
            connect: true,
            confirm_dialog: offer
                .confirm
                .then_some("Enter your password to allow this."),
        },
    )
}

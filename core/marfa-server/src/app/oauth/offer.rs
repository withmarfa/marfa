//! Approval-page offers and the meaning of a post. Every value a control posts is a literal the
//! request named, except chosen types, which a named all-data or content literal covers.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use url::Url;

use super::metadata_document::is_url;
use super::redirect::{shown_destination, web_origins};
use super::scope::Registries;
use super::scope::{
    OFFLINE_ACCESS, Scope, ScopeSet, Verb, chosen_within, covers, needs_recent_sign_in,
    with_named_reads,
};
use super::store::Client;
use crate::app::access::{Level, Permission};
use crate::app::catalog::Catalog;

pub const CHOOSE_TYPES: &str = "choose-types";

/// None of these decides who gets in, sends data out or deletes for good.
const LIMITED: [Permission; 3] = [
    Permission::InstanceRead,
    Permission::BlobsManage,
    Permission::AuditRead,
];

#[derive(Clone, Copy, Debug)]
pub struct Request<'a> {
    pub named: &'a ScopeSet,
    pub held: &'a ScopeSet,
    pub choosable: &'a [&'a str],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reach {
    Type,
    Content,
    Edge,
    Metadata,
    Profile,
}

/// `value` is empty for the level the app holds already.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Choice {
    pub level: Level,
    pub value: String,
}

/// A `LevelRow::types` row posts as `types`; the rest post as `scopes`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LevelRow {
    pub reach: Reach,
    pub pattern: String,
    pub held: Level,
    /// Lowest first.
    pub choices: Vec<Choice>,
    pub selected: String,
    /// It reaches what is registered later, which a page must say.
    pub open_ended: bool,
    /// On the all-data and content rows: types offered in its place by a choice whose value is
    /// [`CHOOSE_TYPES`].
    pub types: Vec<LevelRow>,
    pub label: Option<String>,
    pub description: Option<String>,
    pub covers: Vec<String>,
    /// Its choices read Allow and Don't Allow rather than levels.
    pub yes_or_no: bool,
}

/// Posted as `admin`; Custom's rows post as `powers`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdminLevel {
    Full,
    Limited,
    None,
    Custom,
}

impl AdminLevel {
    pub const fn word(self) -> &'static str {
        match self {
            AdminLevel::Full => "full",
            AdminLevel::Limited => "limited",
            AdminLevel::None => "none",
            AdminLevel::Custom => "custom",
        }
    }

    fn from_word(word: &str) -> Option<AdminLevel> {
        [
            AdminLevel::Full,
            AdminLevel::Limited,
            AdminLevel::None,
            AdminLevel::Custom,
        ]
        .into_iter()
        .find(|level| level.word() == word)
    }
}

/// The powers a request names that the app does not hold. Full access comes first and is chosen.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Admin {
    /// In the request's order. Custom shows one row for each, starting at Allow.
    pub powers: Vec<Permission>,
    pub levels: Vec<AdminLevel>,
}

/// What `level` grants of the powers `asked`, with Custom's `rows` as posted. `None` where a row
/// names a power not asked.
fn powers_at(level: AdminLevel, asked: &[Permission], rows: &[String]) -> Option<Vec<Permission>> {
    match level {
        AdminLevel::Full => Some(asked.to_vec()),
        AdminLevel::Limited => Some(
            asked
                .iter()
                .copied()
                .filter(|power| LIMITED.contains(power))
                .collect(),
        ),
        AdminLevel::None => Some(Vec::new()),
        AdminLevel::Custom => {
            let mut chosen = Vec::new();
            for row in rows.iter().filter(|row| !row.is_empty()) {
                match Scope::parse(row) {
                    Some(Scope::Permission(power)) if asked.contains(&power) => {
                        if !chosen.contains(&power) {
                            chosen.push(power);
                        }
                    }
                    _ => return None,
                }
            }
            Some(chosen)
        }
    }
}

fn powers_named(named: &ScopeSet) -> Vec<Permission> {
    named
        .literals()
        .iter()
        .filter_map(|literal| match Scope::parse(literal) {
            Some(Scope::Permission(power)) => Some(power),
            _ => None,
        })
        .collect()
}

/// Limited is offered only where it would hold some of the powers and not all of them.
fn admin_offer(named: &ScopeSet, held: &ScopeSet) -> Option<Admin> {
    let powers: Vec<Permission> = powers_named(named)
        .into_iter()
        .filter(|power| !covers(held, power.word()))
        .collect();
    if powers.is_empty() {
        return None;
    }
    let limited = powers_at(AdminLevel::Limited, &powers, &[]).unwrap_or_default();
    let mut levels = vec![AdminLevel::Full];
    if !limited.is_empty() && limited.len() < powers.len() {
        levels.push(AdminLevel::Limited);
    }
    levels.extend([AdminLevel::None, AdminLevel::Custom]);
    Some(Admin { powers, levels })
}

/// What a page posts as `held`, so an approval is read only against the access it showed.
/// Empty where the app holds nothing, as a post without the field reads.
pub fn fingerprint(held: &ScopeSet) -> String {
    let mut literals: Vec<&str> = held.literals().iter().map(String::as_str).collect();
    if literals.is_empty() {
        return String::new();
    }
    literals.sort_unstable();
    URL_SAFE_NO_PAD.encode(Sha256::digest(literals.join(" ").as_bytes()))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Held {
    pub reach: Reach,
    pub pattern: String,
    pub level: Level,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppShown {
    pub name: String,
    pub client_id: String,
    pub document_host: Option<String>,
    /// Or the scheme of a private-use one.
    pub destinations: Vec<String>,
    pub web_origins: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Offer {
    pub app: AppShown,
    /// The request names something the app does not hold, so the page offers choices.
    pub asks_new: bool,
    pub data: Vec<LevelRow>,
    pub profile: Vec<LevelRow>,
    pub admin: Option<Admin>,
    pub held: Vec<Held>,
    pub held_powers: Vec<Permission>,
    pub mechanisms: Vec<String>,
    pub confirm: bool,
    pub fingerprint: String,
    /// A control offers editing items, which the page must say adds and deletes them.
    pub offers_edit: bool,
    pub returning: bool,
}

struct Ask {
    reach: Reach,
    pattern: String,
    read: Option<String>,
    write: Option<String>,
}

fn level_of(literal: &str) -> Option<(Reach, &str, Verb)> {
    let (reach, verb) = match Scope::parse(literal)? {
        Scope::Type { verb, .. } => (Reach::Type, verb),
        Scope::Content(verb) => (Reach::Content, verb),
        Scope::Edge { verb, .. } => (Reach::Edge, verb),
        Scope::Metadata { verb, .. } => (Reach::Metadata, verb),
        Scope::Profile { verb, .. } => (Reach::Profile, verb),
        Scope::Permission(_) | Scope::OfflineAccess => return None,
    };
    let (pattern, _) = literal.rsplit_once(':')?;
    Some((reach, pattern, verb))
}

fn asks(named: &ScopeSet) -> Vec<Ask> {
    let mut asks: Vec<Ask> = Vec::new();
    for literal in named.literals() {
        let Some((reach, pattern, verb)) = level_of(literal) else {
            continue;
        };
        let at = match asks.iter().position(|ask| ask.pattern == pattern) {
            Some(at) => at,
            None => {
                asks.push(Ask {
                    reach,
                    pattern: pattern.to_string(),
                    read: None,
                    write: None,
                });
                asks.len() - 1
            }
        };
        match verb {
            Verb::Read => asks[at].read = Some(literal.clone()),
            Verb::Write => asks[at].write = Some(literal.clone()),
        }
    }
    asks
}

fn level_held(held: &ScopeSet, pattern: &str) -> Level {
    if covers(held, &format!("{pattern}:{}", Verb::Write.word())) {
        Level::Write
    } else if covers(held, &format!("{pattern}:{}", Verb::Read.word())) {
        Level::Read
    } else {
        Level::None
    }
}

/// The lowest choice posts nothing: a held read is added from the consent when the approval
/// commits, so a page left open never brings one back.
fn row_for(ask: &Ask, held: &ScopeSet) -> Option<LevelRow> {
    let floor = level_held(held, &ask.pattern);
    let top = if ask.write.is_some() {
        Level::Write
    } else {
        Level::Read
    };
    if floor >= top {
        return None;
    }
    let mut choices = vec![Choice {
        level: floor,
        value: String::new(),
    }];
    if let (Level::None, Some(read)) = (floor, &ask.read) {
        choices.push(Choice {
            level: Level::Read,
            value: read.clone(),
        });
    }
    if let Some(write) = &ask.write {
        choices.push(Choice {
            level: Level::Write,
            value: write.clone(),
        });
    }
    Some(LevelRow {
        reach: ask.reach,
        pattern: ask.pattern.clone(),
        held: floor,
        selected: choices.last().map(|choice| choice.value.clone())?,
        choices,
        open_ended: ask.pattern.contains('*') || ask.reach == Reach::Content,
        types: Vec::new(),
        label: None,
        description: None,
        covers: Vec::new(),
        yes_or_no: ask.reach == Reach::Profile && top == Level::Read,
    })
}

fn offers_types(literal: &str) -> bool {
    Scope::parse(literal).is_some_and(|scope| scope.offers_types())
}

fn is_wide(ask: &Ask) -> bool {
    [&ask.read, &ask.write]
        .into_iter()
        .flatten()
        .any(|literal| offers_types(literal))
}

fn type_rows(ask: &Ask, request: &Request<'_>) -> Vec<LevelRow> {
    request
        .choosable
        .iter()
        .filter_map(|id| {
            let one = Ask {
                reach: Reach::Type,
                pattern: (*id).to_string(),
                read: ask.read.as_ref().map(|_| format!("{id}:read")),
                write: ask.write.as_ref().map(|_| format!("{id}:write")),
            };
            row_for(&one, request.held)
        })
        .collect()
}

fn offered_types(request: &Request<'_>) -> Vec<String> {
    let mut offered: Vec<String> = Vec::new();
    for ask in asks(request.named).iter().filter(|ask| is_wide(ask)) {
        if row_for(ask, request.held).is_none() {
            continue;
        }
        for row in type_rows(ask, request) {
            if !offered.contains(&row.pattern) {
                offered.push(row.pattern);
            }
        }
    }
    offered
}

fn carried(literal: &str, held: &ScopeSet) -> bool {
    literal == OFFLINE_ACCESS || covers(held, literal)
}

fn app_shown(client: &Client) -> AppShown {
    let registration = &client.registration;
    let mut destinations: Vec<String> = Vec::new();
    for found in registration
        .redirect_uris
        .iter()
        .filter_map(|uri| shown_destination(uri))
    {
        if !destinations.contains(&found) {
            destinations.push(found);
        }
    }
    AppShown {
        name: client.name(),
        client_id: client.id.clone(),
        document_host: is_url(&client.id)
            .then(|| Url::parse(&client.id).ok())
            .flatten()
            .and_then(|url| url.host_str().map(str::to_string)),
        destinations,
        web_origins: web_origins(registration.application_type, &registration.redirect_uris),
    }
}

fn held_shown(held: &ScopeSet) -> (Vec<Held>, Vec<Permission>) {
    let mut things: Vec<Held> = Vec::new();
    let mut powers = Vec::new();
    for literal in held.literals() {
        if let Some((reach, pattern, verb)) = level_of(literal) {
            let level = match verb {
                Verb::Read => Level::Read,
                Verb::Write => Level::Write,
            };
            match things.iter_mut().find(|one| one.pattern == pattern) {
                Some(one) => one.level = one.level.max(level),
                None => things.push(Held {
                    reach,
                    pattern: pattern.to_string(),
                    level,
                    label: None,
                }),
            }
        } else if let Some(Scope::Permission(permission)) = Scope::parse(literal) {
            powers.push(permission);
        }
    }
    (things, powers)
}

fn registry_label(
    catalog: &Catalog,
    reach: Reach,
    pattern: &str,
) -> (Option<String>, Option<String>) {
    if pattern.contains('*') {
        return (None, None);
    }
    match reach {
        Reach::Type => (
            catalog
                .types
                .get(pattern)
                .and_then(|held| held.get("label"))
                .and_then(|label| label.as_str())
                .map(str::to_string),
            None,
        ),
        Reach::Edge => pattern
            .strip_prefix("edge.")
            .and_then(|id| catalog.edge_kind(id))
            .map_or((None, None), |kind| {
                (Some(kind.label.clone()), kind.description.clone())
            }),
        _ => (None, None),
    }
}

impl Offer {
    pub fn named(mut self, catalog: &Catalog) -> Offer {
        let registries = Registries::of(catalog);
        let choosable = registries.choosable_types();
        let label_of = |id: &str| registry_label(catalog, Reach::Type, id).0;
        fn fill(
            row: &mut LevelRow,
            catalog: &Catalog,
            choosable: &[&str],
            label_of: &dyn Fn(&str) -> Option<String>,
        ) {
            let (label, description) = registry_label(catalog, row.reach, &row.pattern);
            row.label = label;
            row.description = description;
            if row.reach == Reach::Type
                && row.pattern != "*"
                && let Some(root) = row.pattern.strip_suffix(".*")
            {
                let prefix = format!("{root}.");
                row.covers = choosable
                    .iter()
                    .filter(|id| id.starts_with(&prefix))
                    .filter_map(|id| label_of(id))
                    .collect();
            }
            for one in &mut row.types {
                fill(one, catalog, choosable, label_of);
            }
            // Shipped types first, then the rest, each by name.
            row.types.sort_by_cached_key(|one| {
                (
                    !Catalog::ships(&one.pattern),
                    one.label.as_deref().unwrap_or(&one.pattern).to_lowercase(),
                    one.pattern.clone(),
                )
            });
        }
        for row in self.data.iter_mut().chain(self.profile.iter_mut()) {
            fill(row, catalog, &choosable, &label_of);
        }
        for one in &mut self.held {
            one.label = registry_label(catalog, one.reach, &one.pattern).0;
        }
        self
    }
}

pub fn build(client: &Client, request: &Request<'_>) -> Offer {
    let (named, held) = (request.named, request.held);
    let mut data = Vec::new();
    let mut profile = Vec::new();
    let mut offers_edit = false;
    for ask in asks(named) {
        let Some(mut row) = row_for(&ask, held) else {
            continue;
        };
        if is_wide(&ask) {
            row.types = type_rows(&ask, request);
        }
        offers_edit |= matches!(ask.reach, Reach::Type | Reach::Content)
            && row
                .choices
                .iter()
                .any(|choice| choice.level == Level::Write);
        if ask.reach == Reach::Profile {
            profile.push(row);
        } else {
            data.push(row);
        }
    }
    let (held_things, held_powers) = held_shown(held);
    Offer {
        app: app_shown(client),
        asks_new: named
            .literals()
            .iter()
            .any(|literal| !carried(literal, held)),
        data,
        profile,
        admin: admin_offer(named, held),
        returning: held
            .literals()
            .iter()
            .any(|literal| literal.as_str() != OFFLINE_ACCESS),
        held: held_things,
        held_powers,
        mechanisms: named
            .literals()
            .iter()
            .filter(|literal| literal.as_str() == OFFLINE_ACCESS)
            .cloned()
            .collect(),
        confirm: needs_recent_sign_in(named, held),
        fingerprint: fingerprint(held),
        offers_edit,
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Post {
    /// The [`fingerprint`] the page was built on.
    pub held: String,
    pub scopes: Vec<String>,
    pub types: Vec<String>,
    pub admin: Option<String>,
    pub powers: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Decision {
    Approved(ScopeSet),
    Denied,
    /// Names what the request did not, so nothing from the post counts.
    Beyond,
    /// The page was built on access the app no longer holds as it did, so it must be shown again.
    Changed,
}

fn distinct(values: &[String]) -> Vec<&str> {
    let mut seen: Vec<&str> = Vec::new();
    for value in values {
        if !value.is_empty() && value != CHOOSE_TYPES && !seen.contains(&value.as_str()) {
            seen.push(value);
        }
    }
    seen
}

/// A page without scripts posts every row, so rows count only under Custom.
fn admin_chosen(post: &Post, named: &ScopeSet) -> Option<Vec<Permission>> {
    let Some(word) = post.admin.as_deref() else {
        return Some(Vec::new());
    };
    let level = AdminLevel::from_word(word)?;
    let asked = powers_named(named);
    if asked.is_empty() {
        return None;
    }
    powers_at(level, &asked, &post.powers)
}

/// A held scope comes from `held`, never the post. Scopes are compared by what they reach, never
/// merged as text.
pub fn read_decision(request: &Request<'_>, post: &Post) -> Decision {
    let (named, held) = (request.named, request.held);
    if post.held != fingerprint(held) {
        return Decision::Changed;
    }
    let choosing = post.scopes.iter().any(|value| value == CHOOSE_TYPES);
    let mut picked = distinct(&post.scopes);
    if picked.iter().any(|literal| {
        !named.contains(literal) || matches!(Scope::parse(literal), Some(Scope::Permission(_)))
    }) {
        return Decision::Beyond;
    }
    let Some(powers) = admin_chosen(post, named) else {
        return Decision::Beyond;
    };
    for power in powers {
        if !picked.contains(&power.word()) {
            picked.push(power.word());
        }
    }
    let chosen_types: Vec<&str> = if choosing {
        distinct(&post.types)
    } else {
        Vec::new()
    };
    let wide: ScopeSet = named
        .literals()
        .iter()
        .map(String::as_str)
        .filter(|literal| offers_types(literal))
        .collect();
    let offered = offered_types(request);
    let offered: Vec<&str> = offered.iter().map(String::as_str).collect();
    let type_set: ScopeSet = chosen_types.iter().copied().collect();
    if choosing && (wide.is_empty() || !chosen_within(named, &type_set, &offered)) {
        return Decision::Beyond;
    }

    let mut scopes: ScopeSet = picked.iter().copied().collect();
    for literal in &chosen_types {
        scopes.insert(literal);
    }
    for literal in named.literals() {
        if literal != OFFLINE_ACCESS && covers(held, literal) {
            scopes.insert(literal);
        }
    }
    let mut scopes = with_named_reads(&scopes, named);
    for literal in &chosen_types {
        if let Some(pattern) = literal.strip_suffix(":write") {
            let read = format!("{pattern}:read");
            if wide.literals().iter().any(|one| {
                one.ends_with(":read") && covers(&[one.as_str()].into_iter().collect(), &read)
            }) {
                scopes.insert(&read);
            }
        }
    }
    for literal in held.literals() {
        let under_wide = matches!(
            Scope::parse(literal),
            Some(Scope::Type { pattern, .. }) if request.choosable.contains(&pattern.as_str())
        ) && covers(&wide, literal);
        let reached = scopes
            .literals()
            .iter()
            .any(|other| covers(&[other.as_str()].into_iter().collect(), literal));
        if under_wide && !reached {
            scopes.insert(literal);
        }
    }

    let offers_choice = named
        .literals()
        .iter()
        .any(|literal| !carried(literal, held));
    let chose_something = picked
        .iter()
        .chain(&chosen_types)
        .any(|literal| !carried(literal, held));
    if if offers_choice {
        chose_something
    } else {
        !scopes.is_empty()
    } {
        Decision::Approved(in_request_order(&scopes, named, &offered))
    } else {
        Decision::Denied
    }
}

/// The request's order, then the types in the order the page lists them, each read before its write.
fn in_request_order(scopes: &ScopeSet, named: &ScopeSet, offered: &[&str]) -> ScopeSet {
    let mut extras: Vec<&String> = scopes
        .literals()
        .iter()
        .filter(|literal| !named.contains(literal))
        .collect();
    extras.sort_by_key(|literal| {
        let (pattern, verb) = literal.rsplit_once(':').unwrap_or((literal, ""));
        (
            offered.iter().position(|id| *id == pattern),
            verb != Verb::Read.word(),
        )
    });
    named
        .literals()
        .iter()
        .filter(|literal| scopes.contains(literal))
        .chain(extras)
        .map(String::as_str)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::client::{GrantType, Registration, ResponseType};
    use super::super::redirect::AppKind;
    use super::super::scope::{Narrowed, Registries, combined, first_uncovered, narrow};
    use super::*;

    const CHOOSABLE: [&str; 3] = ["core.bookmark", "core.note", "user.recipe"];

    fn set(text: &str) -> ScopeSet {
        ScopeSet::parse(text)
    }

    fn client(name: Option<&str>, redirects: &[&str], kind: AppKind) -> Client {
        Client {
            id: "client-1".to_string(),
            created_at: crate::app::clock::Stamp::from_ms(0).unwrap(),
            registration: Registration {
                application_type: kind,
                grant_types: vec![GrantType::AuthorizationCode],
                response_types: vec![ResponseType::Code],
                redirect_uris: redirects.iter().map(|uri| (*uri).to_string()).collect(),
                scope: ScopeSet::default(),
                client_name: name.map(str::to_string),
                client_uri: None,
                logo_uri: Some("https://tracker.example/logo.png".to_string()),
                tos_uri: None,
                policy_uri: None,
                contacts: Vec::new(),
                software_id: Some("core.note".to_string()),
                software_version: None,
            },
        }
    }

    fn native() -> Client {
        client(
            Some("Notes"),
            &["http://127.0.0.1:9/callback"],
            AppKind::Native,
        )
    }

    fn offer(named: &str, held: &str) -> Offer {
        build(
            &native(),
            &Request {
                named: &set(named),
                held: &set(held),
                choosable: &CHOOSABLE,
            },
        )
    }

    fn post(scopes: &[&str]) -> Post {
        Post {
            scopes: scopes.iter().map(|value| (*value).to_string()).collect(),
            ..Post::default()
        }
    }

    fn with_types(scopes: &[&str], types: &[&str]) -> Post {
        Post {
            types: types.iter().map(|value| (*value).to_string()).collect(),
            ..post(scopes)
        }
    }

    /// A post from a page built on what is held now.
    fn decide(named: &str, held: &str, post: &Post) -> Decision {
        decide_on(named, held, held, post)
    }

    fn decide_on(named: &str, shown: &str, held: &str, post: &Post) -> Decision {
        read_decision(
            &Request {
                named: &set(named),
                held: &set(held),
                choosable: &CHOOSABLE,
            },
            &Post {
                held: fingerprint(&set(shown)),
                ..post.clone()
            },
        )
    }

    /// What a browser posts from the page as drawn, with no choice changed.
    fn as_drawn(offered: &Offer) -> Post {
        let mut scopes: Vec<String> = offered.mechanisms.clone();
        scopes.extend(
            offered
                .data
                .iter()
                .chain(&offered.profile)
                .map(|row| row.selected.clone()),
        );
        Post {
            held: offered.fingerprint.clone(),
            scopes,
            types: offered
                .data
                .iter()
                .flat_map(|row| &row.types)
                .map(|row| row.selected.clone())
                .collect(),
            admin: offered
                .admin
                .as_ref()
                .and_then(|admin| admin.levels.first())
                .map(|level| level.word().to_string()),
            powers: offered
                .admin
                .iter()
                .flat_map(|admin| &admin.powers)
                .map(|power| power.word().to_string())
                .collect(),
        }
    }

    fn approved(text: &str) -> Decision {
        Decision::Approved(set(text))
    }

    fn values(row: &LevelRow) -> Vec<&str> {
        row.choices
            .iter()
            .map(|choice| choice.value.as_str())
            .collect()
    }

    #[test]
    fn one_type_read_and_write_is_one_control_at_the_most_it_offers() {
        let offered = offer("core.note:read core.note:write", "");
        assert_eq!(offered.data.len(), 1);
        let row = &offered.data[0];
        assert_eq!(values(row), ["", "core.note:read", "core.note:write"]);
        assert_eq!(row.selected, "core.note:write");
        assert!(offered.offers_edit);
        assert!(offered.asks_new);
    }

    #[test]
    fn a_level_is_never_above_the_request_or_below_what_is_held() {
        assert_eq!(
            values(&offer("core.note:read", "").data[0]),
            ["", "core.note:read"]
        );
        let kept = offer("core.note:read core.note:write", "core.note:read");
        assert_eq!(kept.data[0].held, Level::Read);
        assert_eq!(values(&kept.data[0]), ["", "core.note:write"]);
        assert!(offer("core.note:read", "core.note:write").data.is_empty());
    }

    #[test]
    fn a_held_scope_is_read_by_what_the_whole_set_reaches() {
        let held = "*:write core.*:read";
        let row = &offer("core.note:write", held).data[0];
        assert_eq!(row.held, Level::Read);
        assert_eq!(values(row), ["", "core.note:write"]);
    }

    #[test]
    fn all_data_offers_types_at_no_level_above_its_own() {
        let offered = offer("*:read", "");
        let row = &offered.data[0];
        assert!(row.open_ended);
        assert_eq!(row.types.len(), CHOOSABLE.len());
        assert_eq!(values(&row.types[0]), ["", "core.bookmark:read"]);
        assert!(!row.types[0].open_ended);
    }

    #[test]
    fn content_offers_types_at_no_level_above_its_own() {
        let offered = offer("content:read content:write edge.*:read", "");
        let row = &offered.data[0];
        assert_eq!(row.reach, Reach::Content);
        assert_eq!(row.types.len(), CHOOSABLE.len());
        assert_eq!(
            values(&row.types[0]),
            ["", "core.bookmark:read", "core.bookmark:write"]
        );
        assert!(offered.data[1].types.is_empty());
        let read_only = offer("content:read", "");
        assert_eq!(
            values(&read_only.data[0].types[0]),
            ["", "core.bookmark:read"]
        );
    }

    #[test]
    fn a_type_held_in_full_is_not_offered_in_place_of_all_data() {
        let offered = offer("*:read", "core.note:read");
        let ids: Vec<&str> = offered.data[0]
            .types
            .iter()
            .map(|row| row.pattern.as_str())
            .collect();
        assert_eq!(ids, ["core.bookmark", "user.recipe"]);
    }

    fn levels(offered: &Offer) -> Vec<AdminLevel> {
        offered
            .admin
            .as_ref()
            .map(|admin| admin.levels.clone())
            .unwrap_or_default()
    }

    fn admin_post(level: &str, powers: &[&str]) -> Post {
        Post {
            admin: Some(level.to_string()),
            powers: powers.iter().map(|value| (*value).to_string()).collect(),
            ..post(&["core.note:read"])
        }
    }

    const EVERY_POWER: &str = "keys.mint keys.manage grants.manage config.manage instance.read \
        instance.maintain schema.write blobs.manage webhooks.manage connectors.manage audit.read \
        items.purge backups.manage sign_ins.manage";

    #[test]
    fn admin_starts_at_full_access_and_lists_only_the_powers_asked() {
        let offered = offer("items.purge keys.mint", "");
        let admin = offered.admin.unwrap();
        assert_eq!(admin.powers, [Permission::ItemsPurge, Permission::KeysMint]);
        assert_eq!(
            admin.levels,
            [AdminLevel::Full, AdminLevel::None, AdminLevel::Custom]
        );
    }

    #[test]
    fn each_admin_level_grants_exactly_its_powers() {
        let named = format!("core.note:read {EVERY_POWER}");
        let grants = |level: &str, rows: &[&str]| decide(&named, "", &admin_post(level, rows));
        assert_eq!(grants("full", &[]), approved(&named));
        assert_eq!(
            grants("limited", &[]),
            approved("core.note:read instance.read blobs.manage audit.read")
        );
        assert_eq!(grants("none", &[]), approved("core.note:read"));
        let every: Vec<&str> = EVERY_POWER.split_whitespace().collect();
        assert_eq!(grants("custom", &every), approved(&named));
        assert_eq!(
            grants("custom", &["", "webhooks.manage", ""]),
            approved("core.note:read webhooks.manage")
        );
    }

    #[test]
    fn limited_is_offered_only_where_it_holds_some_powers_asked_but_not_all() {
        assert!(levels(&offer("instance.read keys.mint", "")).contains(&AdminLevel::Limited));
        assert!(!levels(&offer("keys.mint items.purge", "")).contains(&AdminLevel::Limited));
        assert!(!levels(&offer("instance.read audit.read", "")).contains(&AdminLevel::Limited));
        assert!(
            !levels(&offer("instance.read keys.mint", "keys.mint")).contains(&AdminLevel::Limited)
        );
        assert_eq!(
            levels(&offer("instance.read keys.mint", "")),
            [
                AdminLevel::Full,
                AdminLevel::Limited,
                AdminLevel::None,
                AdminLevel::Custom
            ]
        );
    }

    #[test]
    fn a_held_power_is_shown_and_never_offered() {
        let offered = offer("items.purge", "items.purge");
        assert!(offered.admin.is_none());
        assert!(offered.held.is_empty());
        assert_eq!(offered.held_powers, [Permission::ItemsPurge]);
        assert!(offered.returning);
        assert!(!offered.asks_new);
        let more = offer("items.purge keys.mint", "items.purge");
        assert_eq!(more.admin.unwrap().powers, [Permission::KeysMint]);
    }

    #[test]
    fn a_request_naming_no_new_power_offers_no_admin_level() {
        assert!(offer("core.note:read", "").admin.is_none());
        assert!(
            offer("core.note:read keys.mint", "keys.mint")
                .admin
                .is_none()
        );
        assert!(offer("keys.mint", "").admin.is_some());
    }

    #[test]
    fn asking_again_with_nothing_new_offers_no_choice_at_all() {
        let offered = offer(
            "core.note:read core.note:write profile:read keys.mint",
            "core.note:write profile:read keys.mint",
        );
        assert!(offered.data.is_empty());
        assert!(offered.profile.is_empty());
        assert!(offered.admin.is_none());
        assert!(!offered.asks_new);
        assert_eq!(offered.held.len(), 2);
        assert_eq!(offered.held_powers, [Permission::KeysMint]);
    }

    #[test]
    fn an_app_asking_for_more_starts_at_all_it_asked_from_what_it_holds() {
        let offered = offer(
            "core.note:read core.note:write instance.read keys.mint",
            "core.note:read instance.read",
        );
        assert_eq!(offered.data[0].held, Level::Read);
        assert_eq!(offered.data[0].selected, "core.note:write");
        let admin = offered.admin.unwrap();
        assert_eq!(admin.powers, [Permission::KeysMint]);
        assert_eq!(admin.levels.first(), Some(&AdminLevel::Full));
    }

    #[test]
    fn the_profile_alone_read_is_allow_or_not_and_its_write_is_levels() {
        assert!(offer("profile:read", "").profile[0].yes_or_no);
        assert!(offer("profile.email:read", "").profile[0].yes_or_no);
        assert!(!offer("profile:read profile:write", "").profile[0].yes_or_no);
        assert!(!offer("edge.*:read", "").data[0].yes_or_no);
    }

    #[test]
    fn full_access_level_grants_every_power_asked() {
        assert_eq!(
            decide(
                "core.note:read keys.mint items.purge",
                "",
                &admin_post("full", &[])
            ),
            approved("core.note:read keys.mint items.purge")
        );
    }

    #[test]
    fn limited_grants_only_the_asked_powers_within_it() {
        assert_eq!(
            decide(
                "core.note:read keys.mint instance.read audit.read webhooks.manage",
                "",
                &admin_post("limited", &[])
            ),
            approved("core.note:read instance.read audit.read")
        );
    }

    #[test]
    fn no_access_grants_no_power_and_keeps_the_held_ones() {
        assert_eq!(
            decide(
                "core.note:read keys.mint items.purge",
                "",
                &admin_post("none", &[])
            ),
            approved("core.note:read")
        );
        assert_eq!(
            decide(
                "core.note:read keys.mint items.purge",
                "keys.mint",
                &admin_post("none", &[])
            ),
            approved("core.note:read keys.mint")
        );
    }

    #[test]
    fn custom_grants_exactly_the_rows_allowed() {
        assert_eq!(
            decide(
                "core.note:read keys.mint items.purge audit.read",
                "",
                &admin_post("custom", &["audit.read", "", "keys.mint"])
            ),
            approved("core.note:read keys.mint audit.read")
        );
        assert_eq!(
            decide(
                "core.note:read keys.mint",
                "",
                &admin_post("custom", &["", ""])
            ),
            approved("core.note:read")
        );
    }

    #[test]
    fn rows_posted_beside_another_level_count_for_nothing() {
        let named = "core.note:read keys.mint items.purge audit.read";
        let stray = [
            "keys.mint",
            "items.purge",
            "audit.read",
            "webhooks.manage",
            "x",
        ];
        assert_eq!(
            decide(named, "", &admin_post("none", &stray)),
            approved("core.note:read")
        );
        assert_eq!(
            decide(named, "", &admin_post("limited", &stray)),
            approved("core.note:read audit.read")
        );
        assert_eq!(
            decide(named, "", &admin_post("full", &stray)),
            approved(named)
        );
        assert_eq!(
            decide(
                named,
                "",
                &Post {
                    powers: stray.iter().map(|one| (*one).to_string()).collect(),
                    ..post(&["core.note:read"])
                }
            ),
            approved("core.note:read")
        );
    }

    #[test]
    fn a_power_or_a_level_beyond_the_request_grants_nothing() {
        let named = "core.note:read keys.mint";
        assert_eq!(
            decide(named, "", &admin_post("custom", &["items.purge"])),
            Decision::Beyond
        );
        assert_eq!(
            decide(named, "", &admin_post("custom", &["core.note:read"])),
            Decision::Beyond
        );
        assert_eq!(
            decide(named, "", &admin_post("custom", &["connectors.host"])),
            Decision::Beyond
        );
        assert_eq!(
            decide(named, "", &admin_post("everything", &[])),
            Decision::Beyond
        );
        for level in ["full", "limited", "none", "custom"] {
            assert_eq!(
                decide("core.note:read", "", &admin_post(level, &[])),
                Decision::Beyond,
                "{level}"
            );
        }
    }

    #[test]
    fn a_permission_posted_as_a_scope_is_beyond() {
        let named = "core.note:read keys.mint";
        let mut taken = admin_post("none", &[]);
        taken.scopes.push("keys.mint".to_string());
        assert_eq!(decide(named, "", &taken), Decision::Beyond);
        assert_eq!(
            decide(named, "", &post(&["core.note:read", "keys.mint"])),
            Decision::Beyond
        );
        assert_eq!(
            decide(named, "", &admin_post("none", &[])),
            approved("core.note:read")
        );
    }

    #[test]
    fn a_page_built_on_other_held_access_grants_nothing() {
        let named = "core.note:read keys.mint items.purge";
        let shown = build(
            &native(),
            &Request {
                named: &set(named),
                held: &set("keys.mint"),
                choosable: &CHOOSABLE,
            },
        );
        for level in ["full", "limited"] {
            let mut taken = as_drawn(&shown);
            taken.admin = Some(level.to_string());
            let on = |held: &str| {
                read_decision(
                    &Request {
                        named: &set(named),
                        held: &set(held),
                        choosable: &CHOOSABLE,
                    },
                    &taken,
                )
            };
            assert_eq!(on(""), Decision::Changed, "{level}");
            assert_eq!(on("keys.mint items.purge"), Decision::Changed, "{level}");
            assert!(matches!(on("keys.mint"), Decision::Approved(_)), "{level}");
        }
        assert_eq!(
            decide_on(named, "", "keys.mint", &admin_post("none", &[])),
            Decision::Changed
        );
    }

    #[test]
    fn the_fingerprint_is_the_held_access_in_any_order_and_empty_for_none() {
        assert_eq!(fingerprint(&ScopeSet::default()), "");
        assert_eq!(
            fingerprint(&set("keys.mint core.note:read")),
            fingerprint(&set("core.note:read keys.mint"))
        );
        assert_ne!(
            fingerprint(&set("core.note:read keys.mint")),
            fingerprint(&set("core.note:read"))
        );
        assert_ne!(fingerprint(&set("core.note:read")), "");
    }

    #[test]
    fn a_level_that_adds_no_new_power_and_nothing_else_chosen_denies() {
        assert_eq!(
            decide(
                "keys.mint",
                "",
                &Post {
                    admin: Some("none".to_string()),
                    ..Post::default()
                }
            ),
            Decision::Denied
        );
        assert_eq!(
            decide(
                "keys.mint",
                "",
                &Post {
                    admin: Some("full".to_string()),
                    ..Post::default()
                }
            ),
            approved("keys.mint")
        );
    }

    #[test]
    fn what_is_held_shows_once_at_its_highest_level() {
        let offered = offer(
            "core.note:write core.task:read",
            "core.note:read core.note:write offline_access",
        );
        assert_eq!(offered.held.len(), 1);
        assert_eq!(offered.held[0].pattern, "core.note");
        assert_eq!(offered.held[0].level, Level::Write);
        assert!(offered.returning);
    }

    #[test]
    fn a_mechanism_rides_along_and_offers_no_choice() {
        let offered = offer("offline_access", "");
        assert_eq!(offered.mechanisms, ["offline_access"]);
        assert!(!offered.asks_new);
        assert!(!offered.returning);
    }

    #[test]
    fn writes_ask_for_the_dialog_and_reads_do_not() {
        assert!(offer("core.note:write", "").confirm);
        assert!(!offer("core.note:read", "").confirm);
        assert!(!offer("core.note:write", "core.note:write").confirm);
    }

    #[test]
    fn every_redirect_that_leaves_this_machine_is_named() {
        let shown = app_shown(&client(
            None,
            &[
                "https://Evil.example:8443/back",
                "https://evil.example/other",
                "com.example.app:/callback",
                "http://127.0.0.1:9/callback",
            ],
            AppKind::Native,
        ));
        assert_eq!(shown.destinations, ["evil.example", "com.example.app"]);
        assert!(shown.web_origins.is_empty());
    }

    #[test]
    fn a_name_that_would_not_print_falls_back_to_the_client_id() {
        assert_eq!(
            app_shown(&client(Some("\u{202e}\u{7}"), &[], AppKind::Native)).name,
            "client-1"
        );
        assert_eq!(
            app_shown(&client(Some("No\u{202e}tes"), &[], AppKind::Native)).name,
            "Notes"
        );
        assert_eq!(
            app_shown(&client(None, &[], AppKind::Native)).name,
            "client-1"
        );
    }

    #[test]
    fn a_document_host_comes_from_the_parsed_id() {
        let mut document = native();
        document.id = "https://APP.example/client.json".to_string();
        assert_eq!(
            app_shown(&document).document_host.as_deref(),
            Some("app.example")
        );
        assert_eq!(app_shown(&native()).document_host, None);
    }

    #[test]
    fn neither_the_logo_nor_the_software_id_reach_the_offer() {
        let offered = format!("{:?}", offer("core.note:read", ""));
        assert!(!offered.contains("tracker.example"));
        let bare = {
            let mut bare = native();
            bare.registration.software_id = None;
            bare.registration.logo_uri = None;
            build(
                &bare,
                &Request {
                    named: &set("core.note:read"),
                    held: &ScopeSet::default(),
                    choosable: &CHOOSABLE,
                },
            )
        };
        assert_eq!(offer("core.note:read", ""), bare);
    }

    #[test]
    fn the_page_as_drawn_grants_the_whole_request() {
        for (named, held) in [
            ("core.note:read core.note:write offline_access", ""),
            ("*:read *:write profile:read instance.read keys.mint", ""),
            ("content:read edge.*:read items.purge audit.read", ""),
            (
                "core.note:read core.note:write keys.mint items.purge",
                "core.note:read keys.mint",
            ),
            ("core.note:read keys.mint", "core.note:read keys.mint"),
        ] {
            let request = Request {
                named: &set(named),
                held: &set(held),
                choosable: &CHOOSABLE,
            };
            assert_eq!(
                read_decision(&request, &as_drawn(&build(&native(), &request))),
                approved(named),
                "{named}"
            );
        }
    }

    #[test]
    fn a_post_naming_what_the_request_did_not_grants_nothing() {
        assert_eq!(
            decide(
                "core.note:read",
                "",
                &post(&["core.note:read", "core.note:write"])
            ),
            Decision::Beyond
        );
    }

    #[test]
    fn approving_with_nothing_chosen_denies() {
        assert_eq!(decide("core.note:read", "", &post(&[])), Decision::Denied);
        assert_eq!(decide("core.note:read", "", &post(&[""])), Decision::Denied);
        assert_eq!(
            decide(
                "core.note:read offline_access",
                "",
                &post(&["offline_access"])
            ),
            Decision::Denied
        );
    }

    #[test]
    fn a_request_that_names_nothing_is_denied_and_never_read_as_every_scope() {
        assert_eq!(decide("", "core.note:read", &post(&[])), Decision::Denied);
        let full = Post {
            admin: Some("full".to_string()),
            ..Post::default()
        };
        assert_eq!(decide("", "", &full), Decision::Beyond);
    }

    #[test]
    fn what_was_ticked_is_what_is_approved_with_the_read_a_write_brings() {
        assert_eq!(
            decide(
                "core.note:read core.note:write core.bookmark:read",
                "",
                &post(&["core.note:write"])
            ),
            approved("core.note:read core.note:write")
        );
    }

    #[test]
    fn a_held_scope_comes_from_the_consent_and_only_while_held() {
        let named = "core.note:read core.bookmark:read";
        assert_eq!(
            decide(named, "core.note:read", &post(&["core.bookmark:read"])),
            approved(named)
        );
        assert_eq!(
            decide(named, "", &post(&["core.bookmark:read"])),
            approved("core.bookmark:read")
        );
    }

    #[test]
    fn confirming_only_what_is_held_is_a_yes() {
        assert_eq!(
            decide("core.note:read", "core.note:write", &post(&[])),
            approved("core.note:read")
        );
    }

    #[test]
    fn choosing_types_grants_them_and_not_all_data() {
        assert_eq!(
            decide(
                "*:read *:write",
                "",
                &with_types(&[CHOOSE_TYPES], &["core.note:write", "core.bookmark:read"])
            ),
            approved("core.bookmark:read core.note:read core.note:write")
        );
    }

    #[test]
    fn choosing_types_in_place_of_content_grants_them_and_not_content() {
        let named = "content:read content:write edge.*:read edge.*:write offline_access";
        assert_eq!(
            decide(
                named,
                "",
                &with_types(
                    &[CHOOSE_TYPES, "", "offline_access"],
                    &["core.note:read", "user.recipe:read", ""]
                )
            ),
            approved("offline_access core.note:read user.recipe:read")
        );
        assert_eq!(
            decide(
                named,
                "",
                &with_types(&[CHOOSE_TYPES], &["core.note:write"])
            ),
            approved("core.note:read core.note:write")
        );
    }

    #[test]
    fn a_type_beyond_the_content_level_or_the_page_grants_nothing() {
        let choose =
            |types: &[&str]| decide("content:read", "", &with_types(&[CHOOSE_TYPES], types));
        assert_eq!(choose(&["core.note:read"]), approved("core.note:read"));
        assert_eq!(choose(&["core.note:write"]), Decision::Beyond);
        assert_eq!(choose(&["system.key:read"]), Decision::Beyond);
        assert_eq!(choose(&["core.deleted:read"]), Decision::Beyond);
    }

    #[test]
    fn types_mean_nothing_while_all_data_is_kept() {
        assert_eq!(
            decide(
                "*:read",
                "",
                &with_types(&["*:read"], &["core.deleted:read"])
            ),
            approved("*:read")
        );
    }

    #[test]
    fn choosing_types_with_none_on_denies() {
        assert_eq!(
            decide("*:read", "", &with_types(&[CHOOSE_TYPES], &["", ""])),
            Decision::Denied
        );
    }

    #[test]
    fn a_type_beyond_the_levels_or_the_page_grants_nothing() {
        let choose = |types: &[&str]| decide("*:read", "", &with_types(&[CHOOSE_TYPES], types));
        assert_eq!(choose(&["core.note:write"]), Decision::Beyond);
        assert_eq!(choose(&["core.deleted:read"]), Decision::Beyond);
        assert_eq!(choose(&["core.*:read"]), Decision::Beyond);
        assert_eq!(
            decide(
                "core.note:read",
                "",
                &with_types(&[CHOOSE_TYPES], &["core.note:read"])
            ),
            Decision::Beyond
        );
        assert_eq!(
            decide(
                "*:read",
                "core.note:read",
                &with_types(&[CHOOSE_TYPES], &["core.note:read"])
            ),
            Decision::Beyond
        );
    }

    #[test]
    fn a_system_type_a_request_narrowed_away_does_not_pass_as_a_choice() {
        let registries = Registries::new(CHOOSABLE.into_iter().chain(["system.key"]), []);
        let Narrowed { kept, .. } = narrow(&set("*:read system.*:read"), &registries.allowed());
        assert!(!kept.contains("system.*:read"));
        let choosable = registries.choosable_types();
        let request = Request {
            named: &kept,
            held: &ScopeSet::default(),
            choosable: &choosable,
        };
        for value in ["system.*:read", "system.key:read"] {
            assert_eq!(
                read_decision(&request, &with_types(&[CHOOSE_TYPES], &[value])),
                Decision::Beyond,
                "{value}"
            );
        }
    }

    #[test]
    fn what_is_held_under_all_data_stays_whether_all_data_or_types_are_taken() {
        let held = "core.note:read";
        assert_eq!(
            decide(
                "*:read",
                held,
                &with_types(&[CHOOSE_TYPES], &["core.bookmark:read"])
            ),
            approved("core.note:read core.bookmark:read")
        );
        assert_eq!(
            decide("*:read", held, &post(&["*:read"])),
            approved("*:read")
        );
        assert_eq!(
            decide("*:write", "core.note:read", &post(&["*:write"])),
            approved("*:write")
        );
    }

    #[test]
    fn what_is_held_under_content_stays_when_types_are_taken() {
        assert_eq!(
            decide(
                "content:read",
                "core.note:read",
                &with_types(&[CHOOSE_TYPES], &["core.bookmark:read"])
            ),
            approved("core.note:read core.bookmark:read")
        );
    }

    #[test]
    fn a_narrower_approval_never_lowers_what_is_held() {
        let held = set("*:write");
        let Decision::Approved(approved) = decide(
            "core.*:read core.bookmark:read",
            "*:write",
            &post(&["core.bookmark:read"]),
        ) else {
            panic!("the approval was not read");
        };
        let standing = combined(&held, &approved);
        assert_eq!(first_uncovered(&standing, &held), None);
        assert!(covers(&standing, "core.note:write"));
    }

    #[test]
    fn the_order_of_a_post_changes_nothing() {
        let named = "core.note:read core.bookmark:read";
        assert_eq!(
            decide(named, "", &post(&["core.bookmark:read", "core.note:read"])),
            approved(named)
        );
    }

    #[test]
    fn the_narrowed_request_decides_what_a_page_can_show_of_a_dropped_scope() {
        let registries = Registries::new(CHOOSABLE, []);
        let kept = narrow(&set("core.note:read notes"), &registries.allowed()).kept;
        let shown = format!(
            "{:?}",
            build(
                &native(),
                &Request {
                    named: &kept,
                    held: &ScopeSet::default(),
                    choosable: &registries.choosable_types(),
                }
            )
        );
        assert!(!shown.contains("notes"));
    }
}

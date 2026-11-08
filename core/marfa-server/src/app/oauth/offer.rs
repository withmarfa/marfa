//! What the two approval pages offer, as a value a page draws, and what a
//! post from one means. A choice is the request narrowed: every value a
//! control posts is a literal the request named, except the types chosen in
//! place of all data, which that all-data literal covers.

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

/// What the all-data control posts for "choose types".
pub const CHOOSE_TYPES: &str = "choose-types";
/// What `access` holds for a person who took the whole request.
pub const FULL_ACCESS: &str = "full";

const CANNOT_BE_UNDONE: [Permission; 3] = [
    Permission::InstanceMaintain,
    Permission::SchemaWrite,
    Permission::ItemsPurge,
];

/// A request as the page and the post are both read against it.
#[derive(Clone, Copy, Debug)]
pub struct Request<'a> {
    /// What the request names, narrowed: what the app is allowed to ask for.
    pub named: &'a ScopeSet,
    /// What the app's standing consent covers now.
    pub held: &'a ScopeSet,
    /// Every type a person may choose in place of all data.
    pub choosable: &'a [&'a str],
}

/// What a level control is about.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reach {
    Type,
    Content,
    Edge,
    Metadata,
    Profile,
}

/// One level a control offers. `value` is what the control posts, which is
/// empty for the level the app holds already.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Choice {
    pub level: Level,
    pub value: String,
}

/// One thing a request asks for at up to two levels. A row of `Offer::data`
/// or `Offer::profile` posts as `scopes`; a row of `LevelRow::types` posts as
/// `types`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LevelRow {
    pub reach: Reach,
    /// The scope's text before its `:read` or `:write`.
    pub pattern: String,
    pub held: Level,
    /// Lowest first.
    pub choices: Vec<Choice>,
    /// The value the control starts at.
    pub selected: String,
    /// It reaches what is registered later, which a page must say.
    pub open_ended: bool,
    /// On the all-data row: the types to choose in its place, offered by a
    /// further choice whose value is [`CHOOSE_TYPES`].
    pub types: Vec<LevelRow>,
    /// What the registry calls an item type or a link type this row is for.
    pub label: Option<String>,
    /// What the registry says of a link type this row is for.
    pub description: Option<String>,
    /// For a pattern under a root, such as `user.*`: what it covers today,
    /// each by its label.
    pub covers: Vec<String>,
}

/// A permission the request names, offered off.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Power {
    pub literal: String,
    pub cannot_be_undone: bool,
}

/// What the app holds of one thing, at the level it holds it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Held {
    pub reach: Reach,
    pub pattern: String,
    pub level: Level,
    /// See [`LevelRow::label`].
    pub label: Option<String>,
}

/// Who is asking and where the answer goes, each read from a parsed value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppShown {
    /// Held to what a page may show, or the client ID.
    pub name: String,
    pub client_id: String,
    /// The host a metadata document was read from.
    pub document_host: Option<String>,
    /// The host of each redirect URI that leaves this machine, or the scheme
    /// of a private-use one.
    pub destinations: Vec<String>,
    pub web_origins: Vec<String>,
}

/// Everything an approval page shows.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Offer {
    pub app: AppShown,
    /// Offer Full access and Choose access, as a field named `access`.
    pub full_access_choice: bool,
    pub data: Vec<LevelRow>,
    pub profile: Vec<LevelRow>,
    pub powers: Vec<Power>,
    /// What the app holds, to show and not to change.
    pub held: Vec<Held>,
    pub held_powers: Vec<Power>,
    /// Literals the form carries as hidden `scopes` fields.
    pub mechanisms: Vec<String>,
    /// The page holds the "Confirm it's you" dialog.
    pub confirm: bool,
    /// A control offers editing items, which the page must say adds and
    /// deletes them.
    pub offers_edit: bool,
    pub returning: bool,
}

/// One thing asked for, gathered from its read and write literals.
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

/// The control for `ask`, or none where the app holds all of it. The lowest
/// choice posts nothing: a held read is added from the consent when the
/// approval commits, so a page left open never brings one back.
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
    })
}

fn is_all_data(literal: &str) -> bool {
    Scope::parse(literal).is_some_and(|scope| scope.is_all_data())
}

/// The rows for the types offered in place of the all-data `ask`.
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

/// The types the page offers in place of all data.
fn offered_types(request: &Request<'_>) -> Vec<String> {
    asks(request.named)
        .iter()
        .filter(|ask| ask.reach == Reach::Type && ask.pattern == "*")
        .filter(|ask| row_for(ask, request.held).is_some())
        .flat_map(|ask| type_rows(ask, request))
        .map(|row| row.pattern)
        .collect()
}

/// Whether the page carries `literal` without a choice: a mechanism, or
/// something the app already holds.
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

/// What `held` shows: each thing at the highest level the app holds it, and
/// each permission.
fn held_shown(held: &ScopeSet) -> (Vec<Held>, Vec<Power>) {
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
            powers.push(Power {
                literal: literal.clone(),
                cannot_be_undone: CANNOT_BE_UNDONE.contains(&permission),
            });
        }
    }
    (things, powers)
}

/// What the catalog calls the thing a pattern names, if it names one type or
/// one link type.
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
    /// The same offer with what the catalog calls things: the label of each
    /// type or link type, what a root such as `user.*` covers today, and the
    /// same for what is held.
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
            // What Marfa ships first, then the rest, each by name.
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

/// What the page offers `client` for `request`.
pub fn build(client: &Client, request: &Request<'_>) -> Offer {
    let (named, held) = (request.named, request.held);
    let mut data = Vec::new();
    let mut profile = Vec::new();
    let mut offers_edit = false;
    for ask in asks(named) {
        let Some(mut row) = row_for(&ask, held) else {
            continue;
        };
        if ask.reach == Reach::Type && ask.pattern == "*" {
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
    let powers = named
        .scopes()
        .filter_map(|scope| match scope {
            Scope::Permission(permission) if !covers(held, permission.word()) => Some(Power {
                literal: permission.word().to_string(),
                cannot_be_undone: CANNOT_BE_UNDONE.contains(&permission),
            }),
            _ => None,
        })
        .collect();
    let (held_things, held_powers) = held_shown(held);
    Offer {
        app: app_shown(client),
        full_access_choice: named
            .literals()
            .iter()
            .any(|literal| !carried(literal, held)),
        data,
        profile,
        powers,
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
        offers_edit,
    }
}

/// What a page posted.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Post {
    pub access: Option<String>,
    pub scopes: Vec<String>,
    pub types: Vec<String>,
}

/// What a post means.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Decision {
    /// The scopes a token is issued for, before what `grant` holds is added.
    Approved(ScopeSet),
    /// Nothing the person could choose was chosen.
    Denied,
    /// The post names what the request did not, so nothing from it counts.
    Beyond,
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

/// Reads a post against the request it answers and the consent the app holds
/// as the approval commits. A held scope comes from `held`, never the post,
/// so a page left open while the app was disconnected gives nothing back.
/// Scopes are compared by what they reach, never merged as text: `approved`
/// keeps the request's literals, and `grant` combines them with what is held.
pub fn read_decision(request: &Request<'_>, post: &Post) -> Decision {
    let (named, held) = (request.named, request.held);
    let full = post.access.as_deref() == Some(FULL_ACCESS);
    let submitted: &[String] = if full { named.literals() } else { &post.scopes };
    let choosing = !full && post.scopes.iter().any(|value| value == CHOOSE_TYPES);
    let picked = distinct(submitted);
    if picked.iter().any(|literal| !named.contains(literal)) {
        return Decision::Beyond;
    }
    let chosen_types: Vec<&str> = if choosing {
        distinct(&post.types)
    } else {
        Vec::new()
    };
    let all_data: ScopeSet = named
        .literals()
        .iter()
        .map(String::as_str)
        .filter(|literal| is_all_data(literal))
        .collect();
    let offered = offered_types(request);
    let offered: Vec<&str> = offered.iter().map(String::as_str).collect();
    let type_set: ScopeSet = chosen_types.iter().copied().collect();
    if choosing && (all_data.is_empty() || !chosen_within(named, &type_set, &offered)) {
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
            if all_data.literals().iter().any(|wide| {
                wide.ends_with(":read") && covers(&[wide.as_str()].into_iter().collect(), &read)
            }) {
                scopes.insert(&read);
            }
        }
    }
    for literal in held.literals() {
        let under_all_data = matches!(
            Scope::parse(literal),
            Some(Scope::Type { pattern, .. }) if request.choosable.contains(&pattern.as_str())
        ) && covers(&all_data, literal);
        let reached = scopes
            .literals()
            .iter()
            .any(|other| covers(&[other.as_str()].into_iter().collect(), literal));
        if under_all_data && !reached {
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

/// The request's order, whatever order the form arrived in, then the types in
/// the order the page lists them, each read before its write.
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
    use super::super::client::{AuthMethod, GrantType, Registration, ResponseType};
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
            created_at: 0,
            registration: Registration {
                application_type: kind,
                token_endpoint_auth_method: AuthMethod::None,
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
            access: None,
            scopes: scopes.iter().map(|value| (*value).to_string()).collect(),
            types: Vec::new(),
        }
    }

    fn with_types(scopes: &[&str], types: &[&str]) -> Post {
        Post {
            types: types.iter().map(|value| (*value).to_string()).collect(),
            ..post(scopes)
        }
    }

    fn decide(named: &str, held: &str, post: &Post) -> Decision {
        read_decision(
            &Request {
                named: &set(named),
                held: &set(held),
                choosable: &CHOOSABLE,
            },
            post,
        )
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
        assert!(offered.full_access_choice);
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
    fn a_type_held_in_full_is_not_offered_in_place_of_all_data() {
        let offered = offer("*:read", "core.note:read");
        let ids: Vec<&str> = offered.data[0]
            .types
            .iter()
            .map(|row| row.pattern.as_str())
            .collect();
        assert_eq!(ids, ["core.bookmark", "user.recipe"]);
    }

    #[test]
    fn a_power_starts_off_and_is_marked_where_it_cannot_be_undone() {
        let offered = offer("items.purge keys.mint", "");
        assert_eq!(
            offered.powers,
            [
                Power {
                    literal: "items.purge".to_string(),
                    cannot_be_undone: true,
                },
                Power {
                    literal: "keys.mint".to_string(),
                    cannot_be_undone: false,
                },
            ]
        );
    }

    #[test]
    fn a_held_power_is_shown_and_not_offered() {
        let offered = offer("items.purge", "items.purge");
        assert!(offered.powers.is_empty());
        assert!(offered.held.is_empty());
        assert_eq!(offered.held_powers.len(), 1);
        assert_eq!(offered.held_powers[0].literal, "items.purge");
        assert!(offered.held_powers[0].cannot_be_undone);
        assert!(offered.returning);
        assert!(!offered.full_access_choice);
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
        assert!(!offered.full_access_choice);
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
    fn full_access_is_the_request_whatever_the_form_carries() {
        let taken = Post {
            access: Some("full".to_string()),
            ..with_types(
                &["core.bookmark:read", "system.key:read"],
                &["system.key:read"],
            )
        };
        assert_eq!(
            decide("core.note:read offline_access", "", &taken),
            approved("core.note:read offline_access")
        );
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
            access: Some("full".to_string()),
            ..Post::default()
        };
        assert_eq!(decide("", "", &full), Decision::Denied);
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
        let kept = narrow(&set("core.note:read openid"), &registries.allowed()).kept;
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
        assert!(!shown.contains("openid"));
    }
}

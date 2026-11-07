//! The scope grammar, and what a set of scopes reaches.
//!
//! A literal that does not parse grants nothing. It is still kept where it
//! was stored, because a later build may read it, and dropping it would
//! narrow a grant by a change of grammar.

use std::collections::{BTreeSet, HashSet};

use marfa_rules::builtin;
use marfa_rules::grammar::{platform_root, type_pattern};
use serde_json::{Map as Entries, Value};

use crate::app::access::{Axis, Grants, Level, Map, Permission};
use crate::app::catalog::Catalog;

pub const OFFLINE_ACCESS: &str = "offline_access";

const ALL: &str = "*";
const CONTENT: &str = "content";
const EDGE: &str = "edge";
const METADATA: &str = "metadata";
const PROFILE: &str = "profile";
const MOST_NAME_BYTES: usize = 128;

/// The platform's own roots, which the content category never reaches.
const NOT_CONTENT: [&str; 2] = ["system", "marfa"];

/// The roots a permission lives under, and the one word no publisher may use.
/// Anything under one of these that is not a permission is no scope, so
/// `keys.note:read` can never come to mean a type.
const CLAIMED_ROOTS: [&str; 11] = [
    "audit",
    "blobs",
    "config",
    "connectors",
    "grants",
    "instance",
    "items",
    "keys",
    "schema",
    "space",
    "webhooks",
];

/// Roots an app may ask for whole whether or not a type sits under them yet.
const STANDING_ROOTS: [&str; 3] = ["app", "core", "user"];

/// The order the approval pages show permissions in.
const PERMISSIONS: [Permission; 12] = [
    Permission::WebhooksManage,
    Permission::SchemaWrite,
    Permission::ConfigManage,
    Permission::AuditRead,
    Permission::ItemsPurge,
    Permission::KeysMint,
    Permission::GrantsManage,
    Permission::InstanceRead,
    Permission::InstanceMaintain,
    Permission::ConnectorsManage,
    Permission::BlobsManage,
    Permission::KeysManage,
];

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Verb {
    Read,
    Write,
}

impl Verb {
    const BOTH: [Verb; 2] = [Verb::Read, Verb::Write];

    pub const fn word(self) -> &'static str {
        match self {
            Verb::Read => "read",
            Verb::Write => "write",
        }
    }

    fn from_word(word: &str) -> Option<Verb> {
        match word {
            "read" => Some(Verb::Read),
            "write" => Some(Verb::Write),
            _ => None,
        }
    }

    const fn level(self) -> Level {
        match self {
            Verb::Read => Level::Read,
            Verb::Write => Level::Write,
        }
    }
}

/// One part of the metadata layer a scope can name alone.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum MetadataPart {
    Types,
    EdgeTypes,
}

impl MetadataPart {
    const ALL: [MetadataPart; 2] = [MetadataPart::Types, MetadataPart::EdgeTypes];

    pub const fn word(self) -> &'static str {
        match self {
            MetadataPart::Types => "types",
            MetadataPart::EdgeTypes => "edge_types",
        }
    }

    fn from_word(word: &str) -> Option<MetadataPart> {
        Self::ALL.into_iter().find(|part| part.word() == word)
    }
}

/// One row of the owner's profile a scope can name alone.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ProfileRow {
    Name,
    Email,
    Avatar,
}

impl ProfileRow {
    const ALL: [ProfileRow; 3] = [ProfileRow::Name, ProfileRow::Email, ProfileRow::Avatar];

    pub const fn word(self) -> &'static str {
        match self {
            ProfileRow::Name => "name",
            ProfileRow::Email => "email",
            ProfileRow::Avatar => "avatar",
        }
    }

    fn from_word(word: &str) -> Option<ProfileRow> {
        Self::ALL.into_iter().find(|row| row.word() == word)
    }

    const fn takes(self, verb: Verb) -> bool {
        !matches!((self, verb), (ProfileRow::Email, Verb::Write))
    }
}

/// Every scope the grammar states. `pattern` is `*`, `<root>.*` or one id.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Scope {
    Type {
        pattern: String,
        verb: Verb,
    },
    Edge {
        pattern: String,
        verb: Verb,
    },
    Metadata {
        part: Option<MetadataPart>,
        verb: Verb,
    },
    Content(Verb),
    Profile {
        row: Option<ProfileRow>,
        verb: Verb,
    },
    Permission(Permission),
    OfflineAccess,
}

impl Scope {
    pub fn parse(literal: &str) -> Option<Scope> {
        if literal == OFFLINE_ACCESS {
            return Some(Scope::OfflineAccess);
        }
        if let Some(permission) = Permission::from_word(literal) {
            return Some(Scope::Permission(permission));
        }
        let (name, verb) = literal.rsplit_once(':')?;
        let verb = Verb::from_word(verb)?;
        let (root, rest) = match name.split_once('.') {
            Some((root, rest)) => (root, Some(rest)),
            None => (name, None),
        };
        match (root, rest) {
            (CONTENT, None) => Some(Scope::Content(verb)),
            (METADATA, None) => Some(Scope::Metadata { part: None, verb }),
            (METADATA, Some(part)) => Some(Scope::Metadata {
                part: Some(MetadataPart::from_word(part)?),
                verb,
            }),
            (PROFILE, None) => Some(Scope::Profile { row: None, verb }),
            (PROFILE, Some(row)) => {
                let row = ProfileRow::from_word(row)?;
                row.takes(verb).then_some(Scope::Profile {
                    row: Some(row),
                    verb,
                })
            }
            (EDGE, Some(pattern)) if edge_pattern(pattern) => Some(Scope::Edge {
                pattern: pattern.to_string(),
                verb,
            }),
            (CONTENT | EDGE, _) => None,
            (root, _) if CLAIMED_ROOTS.contains(&root) => None,
            (ALL, None) => Some(Scope::Type {
                pattern: ALL.to_string(),
                verb,
            }),
            _ => type_pattern(name).unwrap_or(false).then(|| Scope::Type {
                pattern: name.to_string(),
                verb,
            }),
        }
    }

    pub fn literal(&self) -> String {
        match self {
            Scope::Type { pattern, verb } => format!("{pattern}:{}", verb.word()),
            Scope::Edge { pattern, verb } => format!("{EDGE}.{pattern}:{}", verb.word()),
            Scope::Metadata { part: None, verb } => format!("{METADATA}:{}", verb.word()),
            Scope::Metadata {
                part: Some(part),
                verb,
            } => format!("{METADATA}.{}:{}", part.word(), verb.word()),
            Scope::Content(verb) => format!("{CONTENT}:{}", verb.word()),
            Scope::Profile { row: None, verb } => format!("{PROFILE}:{}", verb.word()),
            Scope::Profile {
                row: Some(row),
                verb,
            } => format!("{PROFILE}.{}:{}", row.word(), verb.word()),
            Scope::Permission(permission) => permission.word().to_string(),
            Scope::OfflineAccess => OFFLINE_ACCESS.to_string(),
        }
    }

    /// `*:read` or `*:write`.
    pub fn is_all_data(&self) -> bool {
        matches!(self, Scope::Type { pattern, .. } if pattern == ALL)
    }

    /// `keys-and-oauth/consent-older-reads`: what a sign-in of any age may
    /// approve.
    fn takes_an_older_sign_in(&self) -> bool {
        match self {
            Scope::Type { verb, .. }
            | Scope::Edge { verb, .. }
            | Scope::Metadata { verb, .. }
            | Scope::Content(verb)
            | Scope::Profile { verb, .. } => *verb == Verb::Read,
            Scope::OfflineAccess => true,
            Scope::Permission(_) => false,
        }
    }
}

fn edge_pattern(pattern: &str) -> bool {
    if pattern == ALL {
        return true;
    }
    if pattern.len() > MOST_NAME_BYTES {
        return false;
    }
    let id = pattern.strip_suffix(".*").unwrap_or(pattern);
    let tail = |part: &str| {
        !part.is_empty()
            && part.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_".contains(&byte)
            })
    };
    let mut parts = id.split('.');
    parts
        .next()
        .is_some_and(|first| first.starts_with(|c: char| c.is_ascii_lowercase()) && tail(first))
        && parts.all(tail)
}

/// Literals, each once, in the order first named.
#[derive(Clone, Debug, Default)]
pub struct ScopeSet {
    order: Vec<String>,
    seen: HashSet<String>,
}

impl PartialEq for ScopeSet {
    fn eq(&self, other: &ScopeSet) -> bool {
        self.order == other.order
    }
}

impl Eq for ScopeSet {}

impl ScopeSet {
    /// A `scope` parameter. Only a space separates (RFC 6749 section 3.3), so
    /// a tab or a newline stays inside a literal, which then parses to nothing.
    pub fn parse(text: &str) -> ScopeSet {
        text.split(' ').filter(|part| !part.is_empty()).collect()
    }

    pub fn literals(&self) -> &[String] {
        &self.order
    }

    pub fn contains(&self, literal: &str) -> bool {
        self.seen.contains(literal)
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    pub fn to_text(&self) -> String {
        self.order.join(" ")
    }

    pub fn insert(&mut self, literal: &str) {
        if self.seen.insert(literal.to_string()) {
            self.order.push(literal.to_string());
        }
    }

    pub fn without(&self, literal: &str) -> ScopeSet {
        self.order
            .iter()
            .map(String::as_str)
            .filter(|held| *held != literal)
            .collect()
    }

    pub fn scopes(&self) -> impl Iterator<Item = Scope> + '_ {
        self.order.iter().filter_map(|text| Scope::parse(text))
    }
}

impl<'a> FromIterator<&'a str> for ScopeSet {
    fn from_iter<I: IntoIterator<Item = &'a str>>(literals: I) -> ScopeSet {
        let mut set = ScopeSet::default();
        for literal in literals {
            set.insert(literal);
        }
        set
    }
}

/// The types and edge types an instance holds right now, so a type registered
/// while it runs is grantable with no restart.
#[derive(Clone, Debug, Default)]
pub struct Registries {
    types: BTreeSet<String>,
    edge_types: BTreeSet<String>,
}

impl Registries {
    pub fn new<'a>(
        types: impl IntoIterator<Item = &'a str>,
        edge_types: impl IntoIterator<Item = &'a str>,
    ) -> Registries {
        Registries {
            types: types.into_iter().map(str::to_string).collect(),
            edge_types: edge_types.into_iter().map(str::to_string).collect(),
        }
    }

    pub fn of(catalog: &Catalog) -> Registries {
        Registries::new(
            catalog.provenance.keys().map(String::as_str),
            catalog
                .edge_types
                .iter()
                .filter_map(|edge| edge.get("id").and_then(Value::as_str)),
        )
    }

    /// Everything a request may be granted on this instance.
    pub fn allowed(&self) -> ScopeSet {
        let mut allowed = ScopeSet::default();
        let mut add = |scope: Scope| allowed.insert(&scope.literal());
        for verb in Verb::BOTH {
            add(Scope::Metadata { part: None, verb });
            for part in MetadataPart::ALL {
                add(Scope::Metadata {
                    part: Some(part),
                    verb,
                });
            }
            add(Scope::Profile { row: None, verb });
            for row in ProfileRow::ALL.into_iter().filter(|row| row.takes(verb)) {
                add(Scope::Profile {
                    row: Some(row),
                    verb,
                });
            }
        }
        for permission in PERMISSIONS {
            add(Scope::Permission(permission));
        }
        for verb in Verb::BOTH {
            add(Scope::Content(verb));
            add(Scope::Type {
                pattern: ALL.to_string(),
                verb,
            });
            add(Scope::Edge {
                pattern: ALL.to_string(),
                verb,
            });
            for root in self.roots() {
                add(Scope::Type {
                    pattern: format!("{root}.*"),
                    verb,
                });
                add(Scope::Edge {
                    pattern: format!("{root}.*"),
                    verb,
                });
            }
            for id in &self.types {
                add(Scope::Type {
                    pattern: id.clone(),
                    verb,
                });
            }
            for id in &self.edge_types {
                add(Scope::Edge {
                    pattern: id.clone(),
                    verb,
                });
            }
        }
        add(Scope::OfflineAccess);
        allowed
    }

    /// What the instance tells every client it offers. Discovery takes no
    /// credential, so a type or a root the owner made here stays out of it,
    /// and is still in `allowed`.
    pub fn published(&self) -> ScopeSet {
        let shipped_edges: HashSet<&str> = builtin::shipped_edge_types()
            .unwrap_or_default()
            .iter()
            .filter_map(|edge| edge.get("id").and_then(Value::as_str))
            .collect();
        Registries::new(
            self.types
                .iter()
                .map(String::as_str)
                .filter(|id| builtin::ships(id).unwrap_or(false)),
            self.edge_types
                .iter()
                .map(String::as_str)
                .filter(|id| shipped_edges.contains(id)),
        )
        .allowed()
    }

    /// The controls `keys-and-oauth/approval-all-data-types` offers in place
    /// of all data. A type under `system` or `marfa` is never one.
    pub fn choosable_types(&self) -> Vec<&str> {
        self.types
            .iter()
            .map(String::as_str)
            .filter(|id| !platform_root(id).is_some_and(|root| NOT_CONTENT.contains(&root)))
            .collect()
    }

    fn roots(&self) -> BTreeSet<&str> {
        let publishers = self
            .types
            .iter()
            .filter(|id| platform_root(id).is_none())
            .filter_map(|id| id.split('.').next());
        STANDING_ROOTS.into_iter().chain(publishers).collect()
    }
}

/// What a request keeps once narrowed, and what it lost.
#[derive(Clone, Debug, PartialEq)]
pub struct Narrowed {
    pub kept: ScopeSet,
    pub dropped: Vec<String>,
}

/// `keys-and-oauth/authorize-narrowed`: drop what cannot be granted beside
/// what can. OpenID's `openid`, `profile` and `email` are not in `allowed`,
/// so they go here like any other unknown literal.
pub fn narrow(asked: &ScopeSet, allowed: &ScopeSet) -> Narrowed {
    let (kept, dropped): (Vec<&String>, Vec<&String>) = asked
        .literals()
        .iter()
        .partition(|literal| allowed.contains(literal));
    Narrowed {
        kept: kept.into_iter().map(String::as_str).collect(),
        dropped: dropped.into_iter().cloned().collect(),
    }
}

fn raise(entries: &mut Entries<String, Value>, name: &str, verb: Verb) {
    let wider = entries.get(name).and_then(Value::as_str) == Some(Verb::Write.word());
    if !wider {
        entries.insert(name.to_string(), Value::from(verb.word()));
    }
}

/// A granted set as what `access` judges, so an app's token is held to the
/// same code as a key.
///
/// The content category goes first and every other type scope over it: a
/// type named beside `content:read` reaches that type, and a `system` or
/// `marfa` type reached by nothing else stays out. So `*:read content:read` reaches less
/// than `*:read` alone.
pub fn to_grants(granted: &ScopeSet) -> Grants {
    let mut types = Entries::new();
    if let Some(verb) = granted
        .scopes()
        .filter_map(|scope| match scope {
            Scope::Content(verb) => Some(verb),
            _ => None,
        })
        .max()
    {
        types.insert(ALL.to_string(), Value::from(verb.word()));
        for root in NOT_CONTENT {
            types.insert(format!("{root}.*"), Value::from(Level::None.word()));
        }
    }
    let mut edges = Entries::new();
    let mut metadata = Entries::new();
    let mut profile = Entries::new();
    let mut permissions = Vec::new();
    for scope in granted.scopes() {
        match scope {
            Scope::Type { pattern, verb } => raise(&mut types, &pattern, verb),
            Scope::Edge { pattern, verb } => raise(&mut edges, &pattern, verb),
            Scope::Metadata { part, verb } => {
                raise(&mut metadata, part.map_or(ALL, MetadataPart::word), verb);
            }
            Scope::Profile { row, verb } => {
                raise(&mut profile, row.map_or(ALL, ProfileRow::word), verb);
            }
            Scope::Permission(permission) if !permissions.contains(&permission) => {
                permissions.push(permission);
            }
            Scope::Permission(_) | Scope::Content(_) | Scope::OfflineAccess => {}
        }
    }
    let mut grants = Grants {
        permissions,
        ..Grants::default()
    };
    for (axis, entries) in [
        (Axis::Type, types),
        (Axis::Edge, edges),
        (Axis::Metadata, metadata),
        (Axis::Profile, profile),
    ] {
        grants.maps[axis as usize] = Map::from_stored(entries);
    }
    grants
}

/// The first literal of `wanted` that `held` does not cover, or none.
///
/// Access is compared as it resolves, not by literal, because removing an
/// overriding entry can widen a wildcard (`keys-and-oauth/grant-narrow-ceiling`).
/// `offline_access` and a literal that does not parse carry no access to
/// compare, so only naming them covers them. A set need not cover itself:
/// `*:write core.*:read` leaves `core.note` at read, so `*:write` is uncovered.
pub fn first_uncovered(held: &ScopeSet, wanted: &ScopeSet) -> Option<String> {
    let ceiling = to_grants(held);
    wanted.literals().iter().find_map(|literal| {
        let covered = match Scope::parse(literal) {
            None | Some(Scope::OfflineAccess) => held.contains(literal),
            Some(_) => ceiling
                .first_beyond("", &to_grants(&[literal.as_str()].into_iter().collect()))
                .is_none(),
        };
        (!covered).then(|| literal.clone())
    })
}

/// Whether `held` reaches everything `required` reaches.
pub fn covers(held: &ScopeSet, required: &str) -> bool {
    first_uncovered(held, &[required].into_iter().collect()).is_none()
}

/// `keys-and-oauth/consent-older-reads`: whether approving `approved` needs a
/// recent sign-in, given what the app already holds.
pub fn needs_recent_sign_in(approved: &ScopeSet, held: &ScopeSet) -> bool {
    approved.literals().iter().any(|literal| {
        !Scope::parse(literal).is_some_and(|scope| scope.takes_an_older_sign_in())
            && !covers(held, literal)
    })
}

/// `keys-and-oauth/approval-types-beyond`: whether every literal of `chosen`
/// is one `named` wrote, or a type the page offered that a named all-data
/// scope covers.
pub fn chosen_within(named: &ScopeSet, chosen: &ScopeSet, offered: &[&str]) -> bool {
    let all_data: ScopeSet = named
        .literals()
        .iter()
        .map(String::as_str)
        .filter(|literal| Scope::parse(literal).is_some_and(|scope| scope.is_all_data()))
        .collect();
    chosen.literals().iter().all(|literal| {
        named.contains(literal)
            || matches!(
                Scope::parse(literal),
                Some(Scope::Type { pattern, .. })
                    if offered.contains(&pattern.as_str()) && covers(&all_data, literal)
            )
    })
}

/// `keys-and-oauth/approval-write-read`: `approved`, with the read of each
/// type it writes where the request named that read.
pub fn with_named_reads(approved: &ScopeSet, named: &ScopeSet) -> ScopeSet {
    let mut issued = approved.clone();
    for scope in approved.scopes() {
        if let Scope::Type {
            pattern,
            verb: Verb::Write,
        } = scope
        {
            let read = format!("{pattern}:{}", Verb::Read.word());
            if named.contains(&read) {
                issued.insert(&read);
            }
        }
    }
    issued
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn set(text: &str) -> ScopeSet {
        ScopeSet::parse(text)
    }

    fn registries() -> Registries {
        Registries::new(
            [
                "core.note",
                "core.media.photo",
                "system.folder",
                "marfa.job",
                "user.recipe",
                "acme.widget",
            ],
            ["links_to", "core.depends_on"],
        )
    }

    fn level(granted: &str, axis: Axis, name: &str) -> Level {
        axis.level(to_grants(&set(granted)).map(axis), name)
    }

    #[test]
    fn every_form_of_the_grammar_parses_and_reads_back() {
        for literal in [
            "*:read",
            "*:write",
            "core.*:read",
            "core.media.*:write",
            "core.note:read",
            "acme.widget:write",
            "app.acme.thing:read",
            "keysmith.note:read",
            "contented.note:read",
            "edge.*:read",
            "edge.core.*:write",
            "edge.links_to:read",
            "edge.a.b-c.d_e:write",
            "metadata:read",
            "metadata:write",
            "metadata.types:read",
            "metadata.edge_types:write",
            "content:read",
            "content:write",
            "profile:read",
            "profile:write",
            "profile.name:write",
            "profile.email:read",
            "profile.avatar:read",
            "offline_access",
        ] {
            let scope = Scope::parse(literal).unwrap_or_else(|| panic!("{literal} did not parse"));
            assert_eq!(scope.literal(), literal);
        }
        for permission in Permission::ALL {
            assert_eq!(
                Scope::parse(permission.word()),
                Some(Scope::Permission(permission))
            );
        }
    }

    #[test]
    fn the_order_of_the_permissions_lists_all_twelve() {
        let listed: HashSet<&str> = PERMISSIONS.iter().map(|p| p.word()).collect();
        let every: HashSet<&str> = Permission::ALL.iter().map(|p| p.word()).collect();
        assert_eq!(listed, every);
    }

    #[test]
    fn what_the_grammar_does_not_state_is_no_scope() {
        for literal in [
            "",
            ":",
            "read",
            "*",
            "*:",
            "*:delete",
            "*:none",
            "core.note",
            "core.note:",
            "core:read",
            "core.Note:read",
            "core.*.note:read",
            "core.**:read",
            "*.note:read",
            "app.two:read",
            "schema.*:read",
            "schema.write:read",
            "keys:read",
            "keys.note:read",
            "space.*:read",
            "space.note:write",
            "content.*:read",
            "content.note:read",
            "content:delete",
            "metadata.*:read",
            "metadata.other:read",
            "metadata.types.more:read",
            "profile.email:write",
            "profile.other:read",
            "profile.*:read",
            "edge:read",
            "edge.:read",
            "edge.*.note:read",
            "edge.a.*.b:read",
            "edge.A:read",
            "edge.1a:read",
            "edge.a..b:read",
            "openid",
            "profile",
            "email",
            "core.*:read core.*:write",
            "core.note:read\n",
            " core.note:read",
        ] {
            assert_eq!(Scope::parse(literal), None, "{literal:?}");
        }
    }

    #[test]
    fn a_list_keeps_each_literal_once_in_first_named_order() {
        let parsed = set("b:read  a.b:read b:read offline_access a.b:read nonsense");
        assert_eq!(
            parsed.literals(),
            ["b:read", "a.b:read", "offline_access", "nonsense"]
        );
        assert_eq!(parsed.to_text(), "b:read a.b:read offline_access nonsense");
        assert_eq!(set("core.note:read\tcore.note:write").literals().len(), 1);
    }

    #[test]
    fn allowed_follows_the_registries_and_published_leaves_out_what_the_owner_made() {
        let before = registries();
        assert!(!before.allowed().contains("user.fresh:read"));
        let after = Registries::new(
            before
                .types
                .iter()
                .map(String::as_str)
                .chain(["user.fresh", "ownroot.thing"]),
            ["fresh_edge"],
        );
        let allowed = after.allowed();
        for literal in [
            "user.fresh:read",
            "user.fresh:write",
            "ownroot.thing:write",
            "ownroot.*:read",
            "edge.ownroot.*:write",
            "edge.fresh_edge:read",
        ] {
            assert!(allowed.contains(literal), "{literal} is not allowed");
        }
        let published = after.published();
        assert!(!published.is_empty());
        for literal in [
            "user.fresh:read",
            "ownroot.thing:write",
            "ownroot.*:read",
            "edge.fresh_edge:read",
        ] {
            assert!(!published.contains(literal), "{literal} is published");
        }
        for literal in [
            "*:read",
            "core.*:read",
            "user.*:read",
            "content:write",
            "offline_access",
            "schema.write",
            "profile.email:read",
            "metadata.edge_types:write",
        ] {
            assert!(published.contains(literal), "{literal} is not published");
        }
    }

    #[test]
    fn a_shipped_type_is_published_and_every_published_literal_parses() {
        let shipped: Vec<String> = builtin::shipped_types()
            .expect("shipped types")
            .iter()
            .map(|row| row["id"].as_str().expect("id").to_string())
            .collect();
        let edges: Vec<String> = builtin::shipped_edge_types()
            .expect("shipped edge types")
            .iter()
            .map(|edge| edge["id"].as_str().expect("id").to_string())
            .collect();
        let live = Registries::new(
            shipped.iter().map(String::as_str),
            edges.iter().map(String::as_str),
        );
        let published = live.published();
        assert_eq!(published, live.allowed());
        assert!(published.contains(&format!("{}:read", shipped[0])));
        assert!(published.contains(&format!("edge.{}:write", edges[0])));
        for literal in published.literals() {
            let scope = Scope::parse(literal).unwrap_or_else(|| panic!("{literal} did not parse"));
            assert_eq!(&scope.literal(), literal);
        }
    }

    #[test]
    fn openid_literals_are_narrowed_away_beside_what_can_be_granted() {
        let narrowed = narrow(
            &set("openid profile email core.note:read no.such:read"),
            &registries().allowed(),
        );
        assert_eq!(narrowed.kept.literals(), ["core.note:read"]);
        assert_eq!(
            narrowed.dropped,
            ["openid", "profile", "email", "no.such:read"]
        );
        assert!(!registries().allowed().contains("openid"));
    }

    #[test]
    fn a_type_scope_is_judged_as_a_key_is() {
        assert_eq!(
            level("core.note:read", Axis::Type, "core.note"),
            Level::Read
        );
        assert_eq!(
            level("core.note:read", Axis::Type, "core.page"),
            Level::None
        );
        assert_eq!(level("core.*:write", Axis::Type, "core.note"), Level::Write);
        assert_eq!(
            level("core.note:read core.note:write", Axis::Type, "core.note"),
            Level::Write
        );
        assert_eq!(
            level("core.note:write core.note:read", Axis::Type, "core.note"),
            Level::Write
        );
        assert_eq!(
            level("edge.links_to:read", Axis::Edge, "links_to"),
            Level::Read
        );
        assert_eq!(level("metadata:read", Axis::Metadata, "types"), Level::Read);
        assert_eq!(
            level("metadata.types:write", Axis::Metadata, "types"),
            Level::Write
        );
        assert_eq!(
            level("metadata.types:write", Axis::Metadata, "edge_types"),
            Level::None
        );
        assert_eq!(level("profile:write", Axis::Profile, "email"), Level::Read);
        assert_eq!(level("profile:write", Axis::Profile, "name"), Level::Write);
        assert!(to_grants(&set("keys.mint offline_access")).holds(Permission::KeysMint));
    }

    #[test]
    fn the_content_category_reaches_no_system_type_unless_one_is_named() {
        for row in builtin::shipped_types().expect("shipped types") {
            let id = row["id"].as_str().expect("id");
            let expected = if id.starts_with("system.") {
                Level::None
            } else {
                Level::Read
            };
            assert_eq!(level("content:read", Axis::Type, id), expected, "{id}");
        }
        assert_eq!(
            level(
                "content:read system.folder:read",
                Axis::Type,
                "system.folder"
            ),
            Level::Read
        );
        assert_eq!(level("*:read", Axis::Type, "system.folder"), Level::Read);
        assert_eq!(
            level("*:read content:read", Axis::Type, "system.folder"),
            Level::None
        );
    }

    #[test]
    fn the_content_category_reaches_no_marfa_type_shipped_or_not() {
        for id in ["marfa.never-shipped", "marfa.other.deeper"] {
            assert!(!builtin::ships(id).unwrap_or(false), "{id}");
            assert_eq!(level("content:read", Axis::Type, id), Level::None, "{id}");
            assert_eq!(level("content:write", Axis::Type, id), Level::None, "{id}");
            assert_eq!(
                level(&format!("content:read {id}:read"), Axis::Type, id),
                Level::Read,
                "{id}"
            );
        }
        // The witness: what `content:read` denies, `*:read` reaches.
        assert_eq!(
            level("*:read", Axis::Type, "marfa.never-shipped"),
            Level::Read
        );
    }

    #[test]
    fn coverage_is_of_effective_access_and_not_of_literals() {
        for (held, required, covered) in [
            ("core.*:read", "core.note:read", true),
            ("core.note:read", "core.*:read", false),
            ("core.note:write", "core.note:read", true),
            ("core.note:read", "core.note:write", false),
            ("*:read", "core.*:read", true),
            ("*:read", "content:read", true),
            ("content:read", "*:read", false),
            ("content:read", "core.note:read", true),
            ("content:read", "system.folder:read", false),
            ("content:write", "content:read", true),
            ("content:read", "content:write", false),
            ("core.note:read core.page:read", "content:read", false),
            ("*:write core.*:read", "*:write", false),
            ("*:write core.*:read", "core.note:write", false),
            ("*:write", "*:write", true),
            ("metadata:read", "metadata.types:read", true),
            ("metadata.types:read", "metadata:read", false),
            ("profile:read", "profile.email:read", true),
            ("profile.name:read", "profile:read", false),
            (
                "profile.name:read profile.email:read profile.avatar:read",
                "profile:read",
                true,
            ),
            ("edge.*:read", "edge.links_to:read", true),
            ("edge.links_to:read", "edge.*:read", false),
            ("keys.mint", "keys.mint", true),
            ("keys.manage", "keys.mint", false),
            ("offline_access", "offline_access", true),
            ("*:write", "offline_access", false),
            ("mystery:thing", "mystery:thing", true),
            ("*:write", "mystery:thing", false),
        ] {
            assert_eq!(covers(&set(held), required), covered, "{held} / {required}");
        }
    }

    #[test]
    fn removing_an_overriding_entry_that_would_widen_a_wildcard_is_beyond_the_grant() {
        let held = set("*:read content:read");
        assert_eq!(
            first_uncovered(&held, &set("*:read")).as_deref(),
            Some("*:read")
        );
        assert_eq!(first_uncovered(&held, &set("content:read")), None);
        assert_eq!(
            first_uncovered(&set("core.*:read offline_access"), &set("core.note:read")),
            None
        );
        assert_eq!(
            first_uncovered(&set("core.*:read"), &set("core.note:read offline_access")).as_deref(),
            Some("offline_access")
        );
    }

    #[test]
    fn only_a_new_write_or_permission_needs_a_recent_sign_in() {
        let none = ScopeSet::default();
        for literal in [
            "core.note:read",
            "*:read",
            "edge.*:read",
            "metadata:read",
            "content:read",
            "profile:read",
            "offline_access",
        ] {
            assert!(!needs_recent_sign_in(&set(literal), &none), "{literal}");
        }
        for literal in [
            "core.note:write",
            "edge.*:write",
            "metadata:write",
            "content:write",
            "profile.name:write",
            "keys.mint",
            "mystery:thing",
        ] {
            assert!(needs_recent_sign_in(&set(literal), &none), "{literal}");
        }
        assert!(!needs_recent_sign_in(
            &set("core.note:write keys.mint"),
            &set("core.*:write keys.mint")
        ));
    }

    #[test]
    fn a_choice_stays_within_what_was_named_and_offered() {
        let offered = ["core.note", "core.page"];
        let named = set("*:read schema.write");
        assert!(chosen_within(&named, &set("core.note:read"), &offered));
        assert!(chosen_within(&named, &set("schema.write"), &offered));
        assert!(chosen_within(
            &set("*:write"),
            &set("core.note:write core.page:read"),
            &offered
        ));
        for beyond in [
            "core.note:write",
            "core.unheard:read",
            "core.*:read",
            "system.connection:read",
            "keys.mint",
        ] {
            assert!(!chosen_within(&named, &set(beyond), &offered), "{beyond}");
        }
        assert!(!chosen_within(
            &set("content:read"),
            &set("core.note:read"),
            &offered
        ));
    }

    #[test]
    fn a_write_brings_the_read_only_where_the_request_named_it() {
        assert_eq!(
            with_named_reads(
                &set("core.note:write"),
                &set("core.note:read core.note:write")
            ),
            set("core.note:write core.note:read")
        );
        assert_eq!(
            with_named_reads(&set("core.note:write"), &set("core.note:write")),
            set("core.note:write")
        );
    }

    #[test]
    fn the_choosable_types_leave_out_system_and_marfa() {
        assert_eq!(
            registries().choosable_types(),
            [
                "acme.widget",
                "core.media.photo",
                "core.note",
                "user.recipe"
            ]
        );
    }

    fn scopeish() -> impl Strategy<Value = String> {
        prop_oneof![
            any::<String>(),
            "[a-z.*:_-]{0,24}",
            "(core|edge|metadata|profile|content|keys|schema|space)(\\.[a-zA-Z*_]{0,8}){0,3}:(read|write|none)",
        ]
    }

    proptest! {
        #[test]
        fn nothing_panics_and_what_parses_reads_back_the_same(text in scopeish()) {
            if let Some(scope) = Scope::parse(&text) {
                prop_assert_eq!(scope.literal(), text.clone());
            }
            let list = ScopeSet::parse(&text);
            let _ = to_grants(&list);
            let _ = narrow(&list, &registries().allowed());
            let _ = needs_recent_sign_in(&list, &ScopeSet::default());
        }

        #[test]
        fn a_refused_literal_stays_refused_in_another_spelling(
            literal in prop_oneof![
                Just("content.*:read"),
                Just("schema.*:read"),
                Just("profile.email:write"),
                Just("openid"),
                Just("space.*:write"),
            ],
            spelling in 0usize..5,
        ) {
            let changed = match spelling {
                0 => literal.to_uppercase(),
                1 => format!("{literal}\u{0}"),
                2 => format!("{literal}%20"),
                3 => literal.replace(':', "%3A"),
                _ => format!("\t{literal}"),
            };
            prop_assert_eq!(Scope::parse(literal), None);
            prop_assert_eq!(Scope::parse(&changed), None);
        }

        #[test]
        fn narrowing_never_keeps_what_is_not_allowed_and_loses_nothing(text in scopeish()) {
            let asked = ScopeSet::parse(&text);
            let allowed = registries().allowed();
            let narrowed = narrow(&asked, &allowed);
            prop_assert!(narrowed.kept.literals().iter().all(|l| allowed.contains(l)));
            prop_assert_eq!(
                narrowed.kept.literals().len() + narrowed.dropped.len(),
                asked.literals().len()
            );
        }

        // The range stops short of the write wildcards, which a narrower read
        // beside them keeps from covering themselves.
        #[test]
        fn a_set_without_a_write_wildcard_covers_each_of_its_own_literals(
            picks in proptest::collection::vec(0usize..40, 1..6),
        ) {
            let allowed = registries().allowed();
            let literals = allowed.literals();
            let held: ScopeSet = picks
                .iter()
                .map(|pick| literals[pick % literals.len()].as_str())
                .filter(|literal| !literal.starts_with("content:"))
                .collect();
            prop_assert_eq!(first_uncovered(&held, &held), None);
        }
    }
}

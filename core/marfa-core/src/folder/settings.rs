use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::Result;
use crate::error::CoreError;
use crate::model::{Item, ItemState, SliceTier, Tier};
use marfa_rules::catalog::Catalog;

pub const FOLDER_TYPE: &str = "system.folder";

const DOCUMENT_TYPE: &str = "core.note";

/// An unknown setting is refused rather than ignored: a misspelt list or
/// threshold would leave the folder taking what the person meant it not to.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub query: Query,
    #[serde(default)]
    pub defaults: Defaults,
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub ignore: Vec<String>,
    #[serde(default)]
    pub first_placement: BTreeMap<String, String>,
    #[serde(default)]
    pub removal_threshold: RemovalThreshold,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_pass_interval_seconds: Option<u64>,
    #[serde(default)]
    pub addition_threshold: AdditionThreshold,
    #[serde(default, skip_serializing_if = "OutsideQuery::is_send")]
    pub outside_query: OutsideQuery,
}

/// What the folder does with a new file that the query would not hold once
/// it was an item. A file that already has an item is never a new file, so
/// this does not touch one that leaves the query.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutsideQuery {
    /// Sent and made an item, and kept in the folder flagged unmatched.
    #[default]
    Send,
    /// Left on disk, not sent, with no item, until it matches or this changes.
    Hold,
}

impl OutsideQuery {
    fn is_send(&self) -> bool {
        *self == OutsideQuery::Send
    }
}

const FULL_PASS_INTERVAL_DEFAULT: u64 = 600;

/// An unknown member is refused rather than ignored, which would answer the
/// query as though the condition were not there.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    #[serde(default)]
    pub types: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<SliceTier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beneath: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Defaults {
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<Tier>,
    #[serde(default)]
    pub properties: Map<String, Value>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub edges: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemovalThreshold {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fraction: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ceiling: Option<u64>,
}

impl RemovalThreshold {
    pub fn files(&self) -> u64 {
        self.files.unwrap_or(10)
    }

    pub fn fraction(&self) -> f64 {
        self.fraction.unwrap_or(0.25)
    }

    /// The most files one pass removes without asking, whatever their share.
    pub fn ceiling(&self) -> u64 {
        self.ceiling.unwrap_or(100)
    }

    pub fn exceeded(&self, count: usize, of: usize) -> bool {
        past(self.files(), self.fraction(), count, of) || count as u64 > self.ceiling()
    }
}

/// How many new files one drop may bring before the folder asks. It is
/// shaped as `RemovalThreshold` is, and its default is higher: a removal
/// loses things, and an addition only makes items.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdditionThreshold {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fraction: Option<f64>,
}

impl AdditionThreshold {
    pub fn files(&self) -> u64 {
        self.files.unwrap_or(50)
    }

    pub fn fraction(&self) -> f64 {
        self.fraction.unwrap_or(0.25)
    }

    /// Whether `count` new files wait for confirmation in a folder that holds
    /// `of` files. A folder with none has no fraction to compare, and the
    /// count alone decides.
    pub fn exceeded(&self, count: usize, of: usize) -> bool {
        past(self.files(), self.fraction(), count, of)
    }
}

/// More than `files` and more than `fraction` of `of`. Where `of` is 0 the
/// fraction is 0 and any count above `files` passes it.
fn past(files: u64, fraction: f64, count: usize, of: usize) -> bool {
    count as u64 > files && count as f64 > fraction * of as f64
}

impl Settings {
    /// How long a watch waits between passes that read every file.
    pub fn full_pass_interval(&self) -> Duration {
        Duration::from_secs(
            self.full_pass_interval_seconds
                .unwrap_or(FULL_PASS_INTERVAL_DEFAULT),
        )
    }

    pub fn of(item: &Item) -> Result<Settings> {
        Settings::read(
            &item.id,
            &item.r#type,
            item.state.as_str(),
            &item.properties,
        )
    }

    pub(crate) fn of_wire(item: &crate::wire::WireItem) -> Result<Settings> {
        Settings::read(&item.id, &item.r#type, &item.state, &item.properties)
    }

    pub(crate) fn read(
        id: &str,
        r#type: &str,
        state: &str,
        properties: &Map<String, Value>,
    ) -> Result<Settings> {
        Settings::refuse_unless_folder(id, r#type)?;
        if state == ItemState::Revoked.as_str() {
            return Err(CoreError::Invalid(format!(
                "the folder {id} is revoked, and a revoked folder has no settings to follow"
            )));
        }
        let settings = Settings::parse(id, r#type, properties)?;
        settings.check()?;
        Ok(settings)
    }

    fn refuse_unless_folder(id: &str, r#type: &str) -> Result<()> {
        if r#type != FOLDER_TYPE {
            return Err(CoreError::Invalid(format!(
                "{id} is a {type}, not a {FOLDER_TYPE}; `folders create` makes one",
                type = r#type
            )));
        }
        Ok(())
    }

    /// In any state, and unchecked: a revoked folder's settings still say
    /// what it held, and settings no folder follows are still the row's. The
    /// server's `revoked_at` beside them is not a setting.
    pub(crate) fn parse(
        id: &str,
        r#type: &str,
        properties: &Map<String, Value>,
    ) -> Result<Settings> {
        Settings::refuse_unless_folder(id, r#type)?;
        let mut properties = properties.clone();
        properties.remove("revoked_at");
        // Said by name, since the parse of a number names only its type.
        if let Some(value) = properties.get("full_pass_interval_seconds")
            && !value.is_null()
            && !value.is_u64()
        {
            let seconds = marfa_rules::folder::FULL_PASS_SECONDS;
            return Err(CoreError::Invalid(format!(
                "a folder's full_pass_interval_seconds is {value}, and a full pass runs every {} to {} whole seconds",
                seconds.start(),
                seconds.end()
            )));
        }
        let settings: Settings =
            serde_json::from_value(Value::Object(properties)).map_err(|error| {
                CoreError::Invalid(format!(
                    "the settings of folder {id} ask for something this folder does not do: {error}"
                ))
            })?;
        Ok(settings)
    }

    fn check(&self) -> Result<()> {
        let placements: Vec<(&str, &str)> = self
            .first_placement
            .iter()
            .map(|(r#type, dir)| (r#type.as_str(), dir.as_str()))
            .collect();
        let count = |threshold: Option<u64>| threshold.map(|files| files as f64);
        marfa_rules::folder::check(
            None,
            &marfa_rules::folder::Settings {
                types: &self.query.types,
                tier: self.query.tier.map(SliceTier::as_str),
                state: self.query.state.as_deref(),
                filter: self.query.filter.as_deref(),
                default_type: self.defaults.r#type.as_deref(),
                default_tier: self.defaults.tier.map(Tier::as_str),
                tags: &self.defaults.tags,
                properties: Some(&self.defaults.properties),
                include: &self.include,
                ignore: &self.ignore,
                first_placement: &placements,
                removal: marfa_rules::folder::Threshold {
                    files: count(self.removal_threshold.files),
                    fraction: self.removal_threshold.fraction,
                    ceiling: count(self.removal_threshold.ceiling),
                },
                addition: marfa_rules::folder::Threshold {
                    files: count(self.addition_threshold.files),
                    fraction: self.addition_threshold.fraction,
                    ceiling: None,
                },
                full_pass_interval_seconds: count(self.full_pass_interval_seconds),
            },
        )
        .map_err(|violation| {
            let message = if violation.message.starts_with("the folder's") {
                violation.message
            } else {
                format!(
                    "the folder's {} is refused: {}. Change it with `marfa folders change`",
                    violation.path,
                    violation.message.trim_end_matches('.')
                )
            };
            CoreError::from(marfa_rules::RuleError::new(violation.code, message))
        })
    }

    /// Whether the query holds the type new files become, which only the
    /// working copy's catalog can say.
    pub(crate) fn check_types(&self, catalog: &Catalog) -> Result<()> {
        marfa_rules::folder::check_default_type(
            catalog,
            &self.query.types,
            self.defaults.r#type.as_deref(),
        )
        .map_err(CoreError::Invalid)
    }

    /// Whether the query names no type or names `*`: every type but
    /// `system.*`. The one reading of the star, so a folder naming it holds,
    /// writes and reports exactly what a folder naming no type does.
    pub(crate) fn names_every_type(&self) -> bool {
        marfa_rules::folder::names_every_type(&self.query.types)
    }

    pub(crate) fn holds_type(&self, catalog: &Catalog, named: &str) -> bool {
        marfa_rules::folder::holds_type(catalog, &self.query.types, named)
    }

    /// What the query holds, as clauses on `items`: the one evaluation a
    /// folder's pass and a list or full-text search in a folder share, so the two
    /// cannot hold different items. `whole_edges` is the edge types the copy
    /// holds whole, which a view's `backref` term needs; a folder passes none,
    /// as `Settings::of` has refused its `backref`. `system.*` is never held.
    pub(crate) fn narrow(
        &self,
        catalog: &Catalog,
        whole_edges: &[String],
        clauses: &mut Vec<String>,
        values: &mut Vec<Value>,
    ) -> Result<()> {
        self.narrow_types(catalog, clauses, values)?;
        self.slice_query()
            .narrow(catalog, whole_edges, clauses, values)
    }

    /// The folder's types and tier, as clauses on `items`.
    pub(crate) fn narrow_types(
        &self,
        catalog: &Catalog,
        clauses: &mut Vec<String>,
        values: &mut Vec<Value>,
    ) -> Result<()> {
        if !self.names_every_type() {
            let mut alternatives = Vec::new();
            for named in &self.query.types {
                crate::query::narrow_by_type(
                    catalog,
                    Some(named.trim()),
                    &mut alternatives,
                    values,
                )?;
            }
            clauses.push(format!("({})", alternatives.join(" OR ")));
        }
        clauses.push("items.type NOT LIKE 'system.%'".into());
        if self.tier() != SliceTier::All {
            clauses.push("items.tier = ?".into());
            values.push(Value::String(self.tier().as_str().into()));
        }
        Ok(())
    }

    /// The query past its types and tier.
    pub(crate) fn slice_query(&self) -> crate::slice::SliceQuery {
        crate::slice::SliceQuery {
            states: self.query.state.clone(),
            filter: self.query.filter.clone(),
            beneath: self.query.beneath.clone(),
        }
    }

    /// What a copy of the folder holds past its types and tier
    /// (`folders/copy-holds-query`), `None` where that is all of them.
    pub(crate) fn copy_query(&self) -> Result<Option<crate::slice::SliceQuery>> {
        self.slice_query().for_copy()
    }

    /// Refuses where the copy's slice does not take every item the query
    /// can hold: answered from part of the folder, a list would read as the
    /// whole of it.
    pub(crate) fn refuse_unless_answerable(
        &self,
        conn: &rusqlite::Connection,
        catalog: &Catalog,
    ) -> Result<()> {
        let unanswerable = |why: String| {
            CoreError::Invalid(format!("this copy cannot answer the folder's query: {why}"))
        };
        let Some((types, tier)) = crate::store::slice(conn)?.filter(|(types, _)| !types.is_empty())
        else {
            return Err(unanswerable(
                "it holds no slice yet; hydrate it with the types the folder holds".into(),
            ));
        };
        if tier != SliceTier::All && tier != self.tier() {
            return Err(unanswerable(format!(
                "the folder holds the {} tier and this copy holds the {} tier",
                self.tier().as_str(),
                tier.as_str()
            )));
        }
        let untaken: Vec<&str> = catalog
            .declared()
            .map(|(id, _)| id)
            .filter(|id| {
                !crate::store::is_system(id)
                    && self.holds_type(catalog, id)
                    && !crate::store::slice_takes(
                        catalog,
                        &types,
                        tier,
                        id,
                        Some(self.tier().create_tier()),
                    )
            })
            .collect();
        // A subtype goes with its parent, so only the parent is named.
        let mut named: Vec<&str> = untaken
            .iter()
            .copied()
            .filter(|id| {
                !untaken
                    .iter()
                    .any(|other| other != id && catalog.matches(other, id))
            })
            .collect();
        if !named.is_empty() {
            named.sort_unstable();
            let named = named.join(", ");
            return Err(unanswerable(if self.names_every_type() {
                format!(
                    "the folder holds every type but `system.*`, and this copy's slice does not take {named}; hydrate with them, or with every type the key reads"
                )
            } else {
                format!(
                    "the folder holds {named}, and this copy's slice does not take them; hydrate with them"
                )
            }));
        }
        if let Some(held) = crate::store::slice_query(conn)?
            && !held.covers(&self.slice_query())?
        {
            return Err(unanswerable(
                "it holds only the items another folder's query shows; ask the server, or a copy that holds this query's items".into(),
            ));
        }
        if self.query.beneath.is_some()
            && !crate::store::whole_edge_types(conn)?
                .iter()
                .any(|held| held == crate::filter::PARENT_OF)
        {
            return Err(unanswerable(format!(
                "it searches beneath an item, which only a copy holding `{}` whole can walk; hydrate with it as an edge type held whole",
                crate::filter::PARENT_OF
            )));
        }
        Ok(())
    }

    pub fn lists(&self) -> Result<super::lists::Lists> {
        super::lists::Lists::new(&self.include, &self.ignore)
    }

    /// Each with its subtree; empty is every type the key reads.
    pub fn types(&self) -> &[String] {
        &self.query.types
    }

    /// The types a copy of the folder declares: `*` where the query names no
    /// type or names `*`, which `narrow` reads as every type, and the types
    /// otherwise.
    pub(crate) fn slice_types(&self) -> Vec<String> {
        marfa_rules::folder::slice_types(&self.query.types)
    }

    pub fn tier(&self) -> SliceTier {
        self.query.tier.unwrap_or(SliceTier::Library)
    }

    /// Unlike a list's default of active, a folder holds archived items too.
    pub fn holds_state(&self, state: ItemState) -> bool {
        match &self.query.state {
            None => matches!(state, ItemState::Active | ItemState::Archived),
            Some(states) => states.iter().any(|named| named == state.as_str()),
        }
    }

    /// Never a file type, whose items are bytes rather than documents.
    pub fn new_type(&self, catalog: &Catalog) -> String {
        self.defaults
            .r#type
            .clone()
            .or_else(|| {
                if self.names_every_type() {
                    return None;
                }
                self.query
                    .types
                    .iter()
                    .map(|declared| declared.trim())
                    .find(|declared| !catalog.matches(super::FILE_TYPE, declared))
                    .map(str::to_string)
            })
            .unwrap_or_else(|| DOCUMENT_TYPE.to_string())
    }

    pub fn new_tier(&self) -> Tier {
        self.defaults
            .tier
            .unwrap_or_else(|| self.tier().create_tier())
    }

    /// The most specific key naming the type or an ancestor of it.
    pub fn first_placement_for(&self, r#type: &str, catalog: &Catalog) -> Option<&str> {
        let naming: Vec<&String> = self
            .first_placement
            .keys()
            .filter(|key| catalog.matches(key, r#type))
            .collect();
        naming
            .iter()
            .find(|key| {
                !naming
                    .iter()
                    .any(|other| other != *key && catalog.matches(key, other))
            })
            .map(|key| self.first_placement[*key].as_str())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn read(properties: Value) -> Result<Settings> {
        let Value::Object(properties) = properties else {
            unreachable!()
        };
        Settings::read("f", FOLDER_TYPE, "active", &properties)
    }

    #[test]
    fn query_takes_both_tiers_and_names_refused_settings() {
        let both = read(json!({ "query": { "tier": "all" } })).unwrap();
        assert_eq!(both.new_tier(), Tier::Library);
        let feed = read(json!({
            "query": { "tier": "all" }, "defaults": { "tier": "feed" }
        }))
        .unwrap();
        assert_eq!(feed.new_tier(), Tier::Feed);
        let old = read(json!({ "search": {} })).unwrap_err().to_string();
        assert!(old.contains("unknown field `search`"), "{old}");
        let unknown = read(json!({ "query": { "tier": "unknown" } }))
            .unwrap_err()
            .to_string();
        assert!(unknown.contains("unknown variant `unknown`"), "{unknown}");
    }

    #[test]
    fn refuses_what_it_does_not_answer() {
        for query in [
            json!({ "filter": "backref[parent-of] exists" }),
            json!({ "filter": "title eq 1" }),
            json!({ "near": "x" }),
            json!({ "state": ["trashed"] }),
            json!({ "state": [] }),
        ] {
            assert!(read(json!({ "query": query })).is_err(), "{query}");
        }
        assert!(read(json!({ "defaults": { "colour": "red" } })).is_err());
        assert!(read(json!({ "ignore": ["a{b"] })).is_err());
        assert!(read(json!({ "removal_threshold": { "fraction": 1.5 } })).is_err());
        assert!(read(json!({ "removal_threshold": { "files": -1 } })).is_err());
        assert!(read(json!({ "removal_threshold": { "share": 1 } })).is_err());
        assert!(read(json!({ "addition_threshold": { "fraction": 1.5 } })).is_err());
        assert!(read(json!({ "addition_threshold": { "files": -1 } })).is_err());
        assert!(read(json!({ "addition_threshold": { "share": 1 } })).is_err());
        let misspelt = read(json!({ "ignores": ["drafts/"] })).unwrap_err();
        assert!(misspelt.to_string().contains("ignores"), "{misspelt}");
        let empty = Map::new();
        assert!(Settings::read("f", FOLDER_TYPE, "revoked", &empty).is_err());
        assert!(Settings::read("f", "core.note", "active", &empty).is_err());
    }

    #[test]
    fn a_setting_the_server_would_refuse_is_named_with_the_way_to_change_it() {
        let refused = |properties: Value| match read(properties) {
            Err(CoreError::Validation { code, message, .. }) => {
                assert!(
                    matches!(code.as_str(), "validation_error" | "invalid_properties"),
                    "{code}"
                );
                message
            }
            other => panic!("{other:?}"),
        };
        let filter = refused(json!({
            "query": { "filter": "properties.a eq \"x\" OR properties.b eq null" }
        }));
        assert!(filter.contains("query.filter"), "{filter}");
        assert!(
            filter.contains("Null is not a value to compare with"),
            "{filter}"
        );
        assert!(filter.contains("marfa folders change"), "{filter}");
        for (properties, setting) in [
            (json!({ "defaults": { "tags": [""] } }), "defaults.tags"),
            (
                json!({ "defaults": { "tags": ["a".repeat(129)] } }),
                "defaults.tags",
            ),
            (
                json!({ "defaults": { "properties": { "": 1 } } }),
                "defaults.properties",
            ),
            (
                json!({ "defaults": { "properties": { "id": 1_152_921_504_606_846_976_i64 } } }),
                "defaults.properties",
            ),
        ] {
            let message = refused(properties);
            assert!(message.contains(setting), "{message}");
            assert!(message.contains("marfa folders change"), "{message}");
        }
        // The witness: defaults at the bound are taken.
        assert!(
            read(json!({
                "defaults": { "tags": ["a".repeat(128)], "properties": { "named": 1 } }
            }))
            .is_ok()
        );
        assert!(
            read(json!({
                "defaults": { "properties": { "id": 1_152_921_504_606_847_000_i64 } }
            }))
            .is_ok()
        );
    }

    #[test]
    fn a_placement_the_server_refuses_is_refused_here() {
        for dir in [
            "Notes/../Tickets",
            "../out",
            "Notes/./../Tickets/./Open",
            "Notes/..",
            "/Notes",
            "C:/Notes",
            "Notes\\Open",
            "Notes\0",
        ] {
            let message = match read(json!({ "first_placement": { "core.note": dir } })) {
                Err(CoreError::Validation { code, message, .. }) => {
                    assert_eq!(code, "validation_error", "{dir:?}");
                    message
                }
                other => panic!("{dir:?}: {other:?}"),
            };
            assert!(message.contains("first_placement"), "{message}");
            assert!(message.contains("core.note"), "{message}");
        }
        // The witness: the same directories without the refused part are taken.
        for dir in ["Notes/Tickets", "Notes/./Tickets/Open", "Notes", "ab:c/d"] {
            assert!(
                read(json!({ "first_placement": { "core.note": dir } })).is_ok(),
                "{dir:?}"
            );
        }
    }

    #[test]
    fn the_full_pass_interval_defaults_to_ten_minutes_and_holds_its_limits() {
        assert_eq!(
            read(json!({})).unwrap().full_pass_interval(),
            Duration::from_secs(600),
            "unset"
        );
        let own = read(json!({ "full_pass_interval_seconds": 3600 })).unwrap();
        assert_eq!(own.full_pass_interval(), Duration::from_secs(3600));
        for ok in [60, 86_400] {
            assert!(
                read(json!({ "full_pass_interval_seconds": ok })).is_ok(),
                "{ok}"
            );
        }
        for refused in [
            json!(0),
            json!(59),
            json!(86_401),
            json!(-1),
            json!(60.5),
            json!("600"),
        ] {
            let error = read(json!({ "full_pass_interval_seconds": refused }));
            assert!(
                error.is_err_and(|error| error.to_string().contains("full_pass_interval_seconds")),
                "{refused}"
            );
        }
        let low = read(json!({ "full_pass_interval_seconds": 59 })).unwrap_err();
        assert!(
            low.to_string().contains("full_pass_interval_seconds"),
            "{low}"
        );
    }

    #[test]
    fn a_removal_waits_past_both_halves_of_its_threshold() {
        let default = RemovalThreshold::default();
        assert!(!default.exceeded(10, 12), "ten is not more than ten");
        assert!(default.exceeded(11, 12));
        assert!(
            !default.exceeded(11, 44),
            "eleven is not more than a quarter of 44"
        );
        assert!(default.exceeded(12, 44));
        let set = read(json!({ "removal_threshold": { "files": 1, "fraction": 0.5 } }))
            .unwrap()
            .removal_threshold;
        assert!(set.exceeded(3, 4));
        assert!(!set.exceeded(2, 4));
    }

    #[test]
    fn a_removal_past_its_ceiling_waits_whatever_its_share() {
        let default = RemovalThreshold::default();
        assert!(!default.exceeded(100, 1000), "a tenth, and not past 100");
        assert!(default.exceeded(101, 1000));
        let set = read(json!({ "removal_threshold": { "fraction": 1.0, "ceiling": 3 } }))
            .unwrap()
            .removal_threshold;
        assert!(!set.exceeded(3, 4));
        assert!(set.exceeded(4, 4));
        assert!(read(json!({ "removal_threshold": { "ceiling": -1 } })).is_err());
        assert!(read(json!({ "addition_threshold": { "ceiling": 1 } })).is_err());
    }

    #[test]
    fn an_addition_waits_past_both_halves_of_its_threshold() {
        let default = AdditionThreshold::default();
        assert!(!default.exceeded(50, 60), "fifty is not more than fifty");
        assert!(default.exceeded(51, 60));
        assert!(
            !default.exceeded(51, 204),
            "fifty-one is not more than a quarter of 204"
        );
        assert!(default.exceeded(52, 204));
        let set = read(json!({ "addition_threshold": { "files": 1, "fraction": 0.5 } }))
            .unwrap()
            .addition_threshold;
        assert!(set.exceeded(3, 4));
        assert!(!set.exceeded(2, 4));
    }

    #[test]
    fn an_addition_to_a_folder_with_no_files_is_judged_by_its_count_alone() {
        let default = AdditionThreshold::default();
        assert!(!default.exceeded(50, 0));
        assert!(default.exceeded(51, 0));
        let fraction_only = read(json!({ "addition_threshold": { "files": 0 } }))
            .unwrap()
            .addition_threshold;
        assert!(fraction_only.exceeded(1, 0));
        assert!(!fraction_only.exceeded(0, 0));
    }

    #[test]
    fn a_new_file_outside_the_query_is_sent_unless_the_folder_holds_it() {
        assert_eq!(read(json!({})).unwrap().outside_query, OutsideQuery::Send);
        let hold = read(json!({ "outside_query": "hold" })).unwrap();
        assert_eq!(hold.outside_query, OutsideQuery::Hold);
        assert_eq!(
            serde_json::to_value(&hold).unwrap()["outside_query"],
            "hold"
        );
        let sent = serde_json::to_value(read(json!({ "outside_query": "send" })).unwrap()).unwrap();
        assert!(sent.get("outside_query").is_none(), "{sent}");
        for refused in [
            json!("keep"),
            json!("Hold"),
            json!(true),
            json!(null),
            json!(1),
        ] {
            let error = read(json!({ "outside_query": refused }));
            assert!(error.is_err(), "{refused}");
        }
    }

    #[test]
    fn the_two_thresholds_have_their_own_defaults() {
        assert_eq!(RemovalThreshold::default().files(), 10);
        assert_eq!(AdditionThreshold::default().files(), 50);
        assert_eq!(AdditionThreshold::default().fraction(), 0.25);
        let settings = read(json!({ "addition_threshold": { "files": 7 } })).unwrap();
        assert_eq!(settings.removal_threshold, RemovalThreshold::default());
        assert_eq!(settings.addition_threshold.files(), 7);
    }

    #[test]
    fn a_new_file_takes_the_default_type_then_the_query_first_type() {
        let named = read(json!({
            "query": { "types": ["core.bookmark"] },
            "defaults": { "type": "core.note" },
        }))
        .unwrap();
        let catalog = crate::catalog::load(&crate::store::testing::conn()).unwrap();
        assert_eq!(named.new_type(&catalog), "core.note");
        let queried =
            read(json!({ "query": { "types": ["core.bookmark"], "tier": "feed" } })).unwrap();
        assert_eq!(queried.new_type(&catalog), "core.bookmark");
        assert_eq!(queried.new_tier(), Tier::Feed);
        assert_eq!(read(json!({})).unwrap().new_type(&catalog), "core.note");
        let files_first =
            read(json!({ "query": { "types": ["core.file", "core.note"] } })).unwrap();
        assert_eq!(files_first.new_type(&catalog), "core.note");
        assert!(read(json!({ "defaults": { "tier": "feed" } })).is_err());
        let unheld = read(
            json!({ "query": { "types": ["core.note"] }, "defaults": { "type": "core.bookmark" } }),
        )
        .unwrap();
        assert!(unheld.check_types(&catalog).is_err());
    }

    #[test]
    fn a_query_state_the_folder_cannot_hold_is_refused_naming_it() {
        let refused = |state: Value| read(json!({ "query": { "state": state } })).unwrap_err();
        let empty = refused(json!([])).to_string();
        assert!(empty.contains("no state"), "{empty}");
        assert!(!empty.contains(".."), "{empty}");
        let unknown = refused(json!(["trashed"])).to_string();
        assert!(unknown.contains("trashed"), "{unknown}");
        assert!(read(json!({ "query": { "state": ["archived"] } })).is_ok());
    }

    #[test]
    fn a_query_naming_the_star_is_read_as_a_query_naming_no_type() {
        let catalog = crate::catalog::load(&crate::store::testing::conn()).unwrap();
        let clauses = |settings: &Settings| {
            let (mut clauses, mut values) = (Vec::new(), Vec::new());
            settings
                .narrow(&catalog, &[], &mut clauses, &mut values)
                .unwrap();
            (clauses, values)
        };
        let none = read(json!({ "defaults": { "type": "core.bookmark" } })).unwrap();
        for types in [json!(["*"]), json!([" * "]), json!(["*", "core.note"])] {
            let starred = read(json!({
                "query": { "types": types },
                "defaults": { "type": "core.bookmark" },
            }))
            .unwrap();
            assert!(starred.holds_type(&catalog, "core.note"), "{types}");
            assert!(starred.holds_type(&catalog, "acme.thing"), "{types}");
            assert!(starred.check_types(&catalog).is_ok(), "{types}");
            assert_eq!(starred.slice_types(), none.slice_types(), "{types}");
            assert_eq!(clauses(&starred), clauses(&none), "{types}");
            assert_eq!(starred.new_type(&catalog), "core.bookmark", "{types}");
        }
        let starred = read(json!({ "query": { "types": ["*"] } })).unwrap();
        assert_eq!(starred.new_type(&catalog), "core.note");
        // The witness: a named type still holds only itself.
        let named = read(json!({ "query": { "types": ["core.bookmark"] } })).unwrap();
        assert!(!named.holds_type(&catalog, "core.note"));
    }

    #[test]
    fn a_first_placement_names_the_type_or_its_nearest_ancestor() {
        use crate::store::testing::wire_type;
        let conn = crate::store::testing::conn();
        crate::store::replace_types(
            &conn,
            &[
                wire_type("core.note", None, None),
                wire_type("user.recipe", Some("core.note"), None),
                wire_type("user.cake", Some("user.recipe"), None),
            ],
        )
        .unwrap();
        let catalog = crate::catalog::load(&conn).unwrap();
        let settings = read(json!({
            "first_placement": { "core.note": "Notes", "user.recipe": "Recipes" },
        }))
        .unwrap();
        let placed = |r#type: &str| settings.first_placement_for(r#type, &catalog);
        assert_eq!(placed("core.note"), Some("Notes"));
        assert_eq!(placed("user.cake"), Some("Recipes"));
        assert_eq!(placed("core.bookmark"), None);
    }
}

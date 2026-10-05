use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::Result;
use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::model::{Item, ItemState, Tier};

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
    pub search: Search,
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
}

/// An unknown member is refused rather than ignored, which would answer the
/// search as though the condition were not there.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Search {
    #[serde(default)]
    pub types: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<Tier>,
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
}

impl RemovalThreshold {
    pub fn files(&self) -> u64 {
        self.files.unwrap_or(10)
    }

    pub fn fraction(&self) -> f64 {
        self.fraction.unwrap_or(0.25)
    }

    pub fn exceeded(&self, count: usize, of: usize) -> bool {
        count as u64 > self.files() && count as f64 > self.fraction() * of as f64
    }
}

impl Settings {
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
        if r#type != FOLDER_TYPE {
            return Err(CoreError::Invalid(format!(
                "{id} is a {type}, not a {FOLDER_TYPE}; `folders create` makes one",
                type = r#type
            )));
        }
        if state == ItemState::Revoked.as_str() {
            return Err(CoreError::Invalid(format!(
                "the folder {id} is revoked, and a revoked folder has no settings to follow"
            )));
        }
        let settings: Settings = serde_json::from_value(Value::Object(properties.clone()))
            .map_err(|error| {
                CoreError::Invalid(format!(
                    "the settings of folder {id} ask for something this folder does not do: {error}"
                ))
            })?;
        settings.check()?;
        Ok(settings)
    }

    fn check(&self) -> Result<()> {
        if let Some(states) = &self.search.state {
            if states.is_empty() {
                return Err(CoreError::Invalid(
                    "a folder's search names no state, so it would hold nothing".into(),
                ));
            }
            for state in states {
                if !matches!(state.as_str(), "active" | "archived") {
                    return Err(CoreError::Invalid(format!(
                        "a folder holds active and archived items, and its search names {state:?}"
                    )));
                }
            }
        }
        if let Some(filter) = &self.search.filter {
            crate::filter::check(filter).map_err(|error| match error {
                CoreError::Validation { code, message } => CoreError::Validation {
                    code,
                    message: format!(
                        "the folder's search.filter is refused: {message}. Change the filter with `marfa folders change`"
                    ),
                },
                other => other,
            })?;
        }
        // The server holds the same defaults to the same bounds, so a new
        // file is never made with a tag or a property name it would refuse.
        let named = |setting: &str, refusal: Result<()>| {
            refusal.map_err(|error| match error {
                CoreError::Validation { code, message } => CoreError::Validation {
                    code,
                    message: format!(
                        "the folder's {setting} is refused: {message}. Change it with `marfa folders change`"
                    ),
                },
                other => other,
            })
        };
        named(
            "defaults.tags",
            crate::validation::tags(&self.defaults.tags),
        )?;
        named(
            "defaults.properties",
            crate::validation::property_names(&self.defaults.properties),
        )?;
        self.lists()?;
        if let Some(fraction) = self.removal_threshold.fraction
            && !(0.0..=1.0).contains(&fraction)
        {
            return Err(CoreError::Invalid(format!(
                "a folder's removal threshold names a fraction of {fraction}, and a fraction of the folder runs from 0 to 1"
            )));
        }
        if let Some(tier) = self.defaults.tier
            && tier != self.tier()
        {
            return Err(CoreError::Invalid(format!(
                "a new file would be made at the {} tier, and the search holds the {} tier",
                tier.as_str(),
                self.tier().as_str()
            )));
        }
        Ok(())
    }

    /// A default type the search does not hold would put every new file
    /// outside its own folder.
    pub(crate) fn check_types(&self, catalog: &Catalog) -> Result<()> {
        if let Some(named) = &self.defaults.r#type
            && !self.holds_type(catalog, named)
        {
            return Err(CoreError::Invalid(format!(
                "a new file would become a {named}, which the search does not hold"
            )));
        }
        Ok(())
    }

    pub(crate) fn holds_type(&self, catalog: &Catalog, named: &str) -> bool {
        self.search.types.is_empty()
            || self
                .search
                .types
                .iter()
                .any(|declared| catalog.matches(declared, named))
    }

    pub fn lists(&self) -> Result<super::lists::Lists> {
        super::lists::Lists::new(&self.include, &self.ignore)
    }

    /// Each with its subtree; empty is every type the key reads.
    pub fn types(&self) -> &[String] {
        &self.search.types
    }

    pub fn tier(&self) -> Tier {
        self.search.tier.unwrap_or(Tier::Library)
    }

    /// Unlike a list's default of active, a folder holds archived items too.
    pub fn holds_state(&self, state: ItemState) -> bool {
        match &self.search.state {
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
                self.search
                    .types
                    .iter()
                    .find(|declared| !catalog.matches(super::FILE_TYPE, declared))
                    .cloned()
            })
            .unwrap_or_else(|| DOCUMENT_TYPE.to_string())
    }

    pub fn new_tier(&self) -> Tier {
        self.defaults.tier.unwrap_or_else(|| self.tier())
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
    fn refuses_what_it_does_not_answer() {
        for search in [
            json!({ "filter": "backref[parent-of] exists" }),
            json!({ "filter": "title eq 1" }),
            json!({ "near": "x" }),
            json!({ "state": ["trashed"] }),
            json!({ "state": [] }),
        ] {
            assert!(read(json!({ "search": search })).is_err(), "{search}");
        }
        assert!(read(json!({ "defaults": { "colour": "red" } })).is_err());
        assert!(read(json!({ "ignore": ["a{b"] })).is_err());
        assert!(read(json!({ "removal_threshold": { "fraction": 1.5 } })).is_err());
        assert!(read(json!({ "removal_threshold": { "files": -1 } })).is_err());
        assert!(read(json!({ "removal_threshold": { "share": 1 } })).is_err());
        let misspelt = read(json!({ "ignores": ["drafts/"] })).unwrap_err();
        assert!(misspelt.to_string().contains("ignores"), "{misspelt}");
        let empty = Map::new();
        assert!(Settings::read("f", FOLDER_TYPE, "revoked", &empty).is_err());
        assert!(Settings::read("f", "core.note", "active", &empty).is_err());
    }

    #[test]
    fn a_setting_the_server_would_refuse_is_named_with_the_way_to_change_it() {
        let refused = |properties: Value| match read(properties) {
            Err(CoreError::Validation { code, message }) => {
                assert_eq!(code, "validation_error");
                message
            }
            other => panic!("{other:?}"),
        };
        let filter = refused(json!({
            "search": { "filter": "properties.a eq \"x\" OR properties.b eq null" }
        }));
        assert!(filter.contains("search.filter"), "{filter}");
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
    fn a_new_file_takes_the_defaults_type_then_the_searchs_first() {
        let named = read(json!({
            "search": { "types": ["core.bookmark"] },
            "defaults": { "type": "core.note" },
        }))
        .unwrap();
        let catalog = Catalog::load(&crate::store::testing::conn()).unwrap();
        assert_eq!(named.new_type(&catalog), "core.note");
        let searched =
            read(json!({ "search": { "types": ["core.bookmark"], "tier": "feed" } })).unwrap();
        assert_eq!(searched.new_type(&catalog), "core.bookmark");
        assert_eq!(searched.new_tier(), Tier::Feed);
        assert_eq!(read(json!({})).unwrap().new_type(&catalog), "core.note");
        let files_first =
            read(json!({ "search": { "types": ["core.file", "core.note"] } })).unwrap();
        assert_eq!(files_first.new_type(&catalog), "core.note");
        assert!(read(json!({ "defaults": { "tier": "feed" } })).is_err());
        let unheld = read(json!({ "search": { "types": ["core.note"] }, "defaults": { "type": "core.bookmark" } }))
            .unwrap();
        assert!(unheld.check_types(&catalog).is_err());
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
        let catalog = Catalog::load(&conn).unwrap();
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

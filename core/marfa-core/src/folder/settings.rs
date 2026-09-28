//! A folder's settings, read from the `system.folder` it is bound to
//! (`folders.md` 1).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::Result;
use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::model::{Item, ItemState, Tier};

/// The type a folder's settings are held as.
pub const FOLDER_TYPE: &str = "system.folder";

/// The type a new document becomes where neither the defaults nor the
/// search name one.
const DOCUMENT_TYPE: &str = "core.note";

/// What a `system.folder` holds, as far as this core reads it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
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

/// Which items the folder holds (`folders.md` 2). A member this core does
/// not know is refused rather than ignored, as a filter is (`device.md` 24).
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

/// What a new file takes where it leaves a blank (`folders.md` 3).
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

impl Settings {
    /// The settings a `system.folder` row holds, refused where the search
    /// asks for something this core does not answer.
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
            crate::filter::check(filter)?;
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

    /// Refuses a default type the search does not hold, which would make
    /// every new file fall outside its own folder.
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

    /// The types the search holds, each with its subtree; empty is every
    /// type the key reads.
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

    /// Edge types the copy holds whole so the search can be answered from
    /// it: `beneath` walks `parent-of` from rows the slice may not hold.
    pub fn whole_edge_types(&self) -> Vec<String> {
        match self.search.beneath {
            Some(_) => vec![crate::filter::PARENT_OF.to_string()],
            None => Vec::new(),
        }
    }

    /// The type a new document becomes: never a file type, whose items are
    /// bytes rather than documents.
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

    /// The tier a new file is created at.
    pub fn new_tier(&self) -> Tier {
        self.defaults.tier.unwrap_or_else(|| self.tier())
    }

    /// The directory a new item of this type from elsewhere first goes
    /// under: the most specific key naming the type or an ancestor of it.
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
    fn holds_active_and_archived_unless_the_search_narrows_state() {
        let open = read(json!({ "title": "t" })).unwrap();
        assert!(open.holds_state(ItemState::Active));
        assert!(open.holds_state(ItemState::Archived));
        assert!(!open.holds_state(ItemState::Trashed));
        let narrowed = read(json!({ "search": { "state": ["active"] } })).unwrap();
        assert!(!narrowed.holds_state(ItemState::Archived));
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
        let empty = Map::new();
        assert!(Settings::read("f", FOLDER_TYPE, "revoked", &empty).is_err());
        assert!(Settings::read("f", "core.note", "active", &empty).is_err());
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

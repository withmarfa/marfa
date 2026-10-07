//! A folder's settings as a working copy reads them, its search answered
//! from the copy, and its settings written through the folder operations. Unlike
//! `folders`, nothing here touches a directory, so it serves every platform.

use std::collections::HashMap;

use marfa_core::folder::settings::{
    Defaults, RemovalThreshold as CoreRemovalThreshold, Search, Settings,
};
use serde_json::{Map, Value};

use crate::{Core, Item, ItemState, MarfaError, SearchHit, Sort, Tier};

/// What a folder holds and what a new file in it takes: the settings a
/// `system.folder` carries.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FolderSettings {
    #[uniffi(default = None)]
    pub title: Option<String>,
    pub search: FolderSearch,
    pub defaults: FolderDefaults,
    /// Gitignore patterns for the paths a folder on disk takes; empty takes
    /// every path.
    #[uniffi(default = [])]
    pub include: Vec<String>,
    /// Gitignore patterns for the paths it leaves alone; they win over
    /// `include`.
    #[uniffi(default = [])]
    pub ignore: Vec<String>,
    /// Where an item of a type made elsewhere first appears, from type to
    /// directory.
    pub first_placement: HashMap<String, String>,
    pub removal_threshold: RemovalThreshold,
}

/// The search that decides which items a folder holds.
#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct FolderSearch {
    /// Each with its subtypes; empty holds every type but `system.*`.
    #[uniffi(default = [])]
    pub types: Vec<String>,
    /// `None` holds the library tier.
    #[uniffi(default = None)]
    pub tier: Option<Tier>,
    /// `None` holds active and archived items.
    #[uniffi(default = None)]
    pub states: Option<Vec<ItemState>>,
    /// An expression in the server's listing grammar.
    #[uniffi(default = None)]
    pub filter: Option<String>,
    /// An item id: that item and everything it reaches along `parent-of`.
    #[uniffi(default = None)]
    pub beneath: Option<String>,
}

/// What a new file takes where it leaves a blank.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FolderDefaults {
    #[uniffi(default = None)]
    pub r#type: Option<String>,
    #[uniffi(default = None)]
    pub tier: Option<Tier>,
    /// One JSON object.
    #[uniffi(default = "{}")]
    pub properties_json: String,
    #[uniffi(default = [])]
    pub tags: Vec<String>,
    /// From edge type to the ids of the items each new file is linked to.
    pub edges: HashMap<String, Vec<String>>,
}

/// How large a removal must be to wait for confirmation.
#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct RemovalThreshold {
    /// `None` is 10.
    #[uniffi(default = None)]
    pub files: Option<u64>,
    /// `None` is 0.25.
    #[uniffi(default = None)]
    pub fraction: Option<f64>,
}

/// Only the settings named are sent, each replacing the folder's whole.
#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct FolderSettingsChange {
    #[uniffi(default = None)]
    pub title: Option<String>,
    #[uniffi(default = None)]
    pub search: Option<FolderSearch>,
    #[uniffi(default = None)]
    pub defaults: Option<FolderDefaults>,
    #[uniffi(default = None)]
    pub include: Option<Vec<String>>,
    #[uniffi(default = None)]
    pub ignore: Option<Vec<String>>,
    #[uniffi(default = None)]
    pub first_placement: Option<HashMap<String, String>>,
    #[uniffi(default = None)]
    pub removal_threshold: Option<RemovalThreshold>,
}

/// A `system.folder` and the settings it carries.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FolderRow {
    pub id: String,
    pub version: i64,
    pub state: ItemState,
    pub settings: FolderSettings,
}

#[uniffi::export]
impl Core {
    /// `None` where the copy does not hold it. A row that is not a folder,
    /// or one naming a setting no folder follows, is `MarfaError.Invalid`.
    pub fn folder(&self, id: String) -> Result<Option<FolderRow>, MarfaError> {
        self.inner.folder(&id)?.map(row).transpose()
    }

    /// What the folder's search holds, as a folder on disk holds it. A
    /// search the copy cannot answer whole is `MarfaError.Invalid`, never
    /// answered in part; a folder the copy does not hold is
    /// `MarfaError.NotFound` with the code `not_held`.
    pub fn list_in_folder(
        &self,
        id: String,
        sort: Sort,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Vec<Item>, MarfaError> {
        let items = self.inner.list_in_folder(&id, sort.into(), limit, offset)?;
        Ok(items
            .into_iter()
            .map(|(found, shown)| crate::item(found, shown))
            .collect())
    }

    /// Refused as `list_in_folder` refuses.
    pub fn search_in_folder(
        &self,
        query: String,
        id: String,
        limit: u32,
    ) -> Result<Vec<SearchHit>, MarfaError> {
        let hits = self.inner.search_in_folder(&query, &id, limit as usize)?;
        Ok(hits
            .into_iter()
            .map(|(hit, shown)| SearchHit {
                item: crate::item(hit.item, shown),
                score: hit.score,
                snippet: hit.snippet,
            })
            .collect())
    }

    /// Sent to the folder door at once and never queued: with no server
    /// reachable it fails, and nothing waits to be sent. `settings.title` is
    /// required. A repeat under the same `idempotency_key` is answered with
    /// the first folder.
    pub fn create_folder(
        &self,
        settings: FolderSettings,
        idempotency_key: Option<String>,
    ) -> Result<FolderRow, MarfaError> {
        let settings = core_settings(settings)?;
        let body = object(serde_json::to_value(&settings).map_err(encoding)?);
        row(self
            .inner
            .create_folder(&body, idempotency_key.as_deref())?)
    }

    /// Sent as `create_folder` is, based on `version`. A setting changed
    /// since `version` is `MarfaError.Server` with status 409 and the code
    /// `version_conflict`; a revoked folder is `MarfaError.Validation` with
    /// the code `invalid_transition`.
    pub fn change_folder(
        &self,
        id: String,
        change: FolderSettingsChange,
        version: i64,
        idempotency_key: Option<String>,
    ) -> Result<FolderRow, MarfaError> {
        let body = change_body(change)?;
        row(self
            .inner
            .change_folder(&id, &body, version, idempotency_key.as_deref())?)
    }

    /// Final: a revoked folder changes no more, and a second revoke is
    /// `MarfaError.Validation` with the code `invalid_transition`.
    pub fn revoke_folder(
        &self,
        id: String,
        idempotency_key: Option<String>,
    ) -> Result<FolderRow, MarfaError> {
        row(self.inner.revoke_folder(&id, idempotency_key.as_deref())?)
    }
}

fn row(row: marfa_core::FolderRow) -> Result<FolderRow, MarfaError> {
    Ok(FolderRow {
        id: row.id,
        version: row.version,
        state: row.state.into(),
        settings: settings(row.settings)?,
    })
}

fn settings(settings: Settings) -> Result<FolderSettings, MarfaError> {
    let Settings {
        title,
        search,
        defaults,
        include,
        ignore,
        first_placement,
        removal_threshold,
    } = settings;
    Ok(FolderSettings {
        title,
        search: FolderSearch {
            types: search.types,
            tier: search.tier.map(Into::into),
            states: search
                .state
                .map(|states| {
                    states
                        .iter()
                        .map(|state| state.parse::<marfa_core::ItemState>().map(Into::into))
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?,
            filter: search.filter,
            beneath: search.beneath,
        },
        defaults: FolderDefaults {
            r#type: defaults.r#type,
            tier: defaults.tier.map(Into::into),
            properties_json: Value::Object(defaults.properties).to_string(),
            tags: defaults.tags,
            edges: defaults.edges.into_iter().collect(),
        },
        include,
        ignore,
        first_placement: first_placement.into_iter().collect(),
        removal_threshold: RemovalThreshold {
            files: removal_threshold.files,
            fraction: removal_threshold.fraction,
        },
    })
}

fn core_settings(settings: FolderSettings) -> Result<Settings, MarfaError> {
    Ok(Settings {
        title: settings.title,
        search: core_search(settings.search),
        defaults: core_defaults(settings.defaults)?,
        include: settings.include,
        ignore: settings.ignore,
        first_placement: settings.first_placement.into_iter().collect(),
        removal_threshold: core_threshold(settings.removal_threshold),
    })
}

fn core_search(search: FolderSearch) -> Search {
    Search {
        types: search.types,
        tier: search.tier.map(Into::into),
        state: search.states.map(|states| {
            states
                .into_iter()
                .map(|state| marfa_core::ItemState::from(state).as_str().to_string())
                .collect()
        }),
        filter: search.filter,
        beneath: search.beneath,
    }
}

fn core_defaults(defaults: FolderDefaults) -> Result<Defaults, MarfaError> {
    let properties = match serde_json::from_str::<Value>(&defaults.properties_json) {
        Ok(Value::Object(properties)) => properties,
        _ => {
            return Err(MarfaError::Invalid {
                message: "a folder's default properties are one JSON object".into(),
            });
        }
    };
    Ok(Defaults {
        r#type: defaults.r#type,
        tier: defaults.tier.map(Into::into),
        properties,
        tags: defaults.tags,
        edges: defaults.edges.into_iter().collect(),
    })
}

fn core_threshold(threshold: RemovalThreshold) -> CoreRemovalThreshold {
    CoreRemovalThreshold {
        files: threshold.files,
        fraction: threshold.fraction,
    }
}

fn change_body(change: FolderSettingsChange) -> Result<Map<String, Value>, MarfaError> {
    let mut body = Map::new();
    let mut put = |key: &str, value: Result<Value, serde_json::Error>| {
        value.map(|value| {
            body.insert(key.into(), value);
        })
    };
    if let Some(title) = change.title {
        put("title", Ok(Value::String(title))).map_err(encoding)?;
    }
    if let Some(search) = change.search {
        put("search", serde_json::to_value(core_search(search))).map_err(encoding)?;
    }
    if let Some(defaults) = change.defaults {
        put("defaults", serde_json::to_value(core_defaults(defaults)?)).map_err(encoding)?;
    }
    if let Some(include) = change.include {
        put("include", serde_json::to_value(include)).map_err(encoding)?;
    }
    if let Some(ignore) = change.ignore {
        put("ignore", serde_json::to_value(ignore)).map_err(encoding)?;
    }
    if let Some(first_placement) = change.first_placement {
        put("first_placement", serde_json::to_value(first_placement)).map_err(encoding)?;
    }
    if let Some(threshold) = change.removal_threshold {
        put(
            "removal_threshold",
            serde_json::to_value(core_threshold(threshold)),
        )
        .map_err(encoding)?;
    }
    Ok(body)
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn encoding(error: serde_json::Error) -> MarfaError {
    MarfaError::Decoding {
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_cross_the_binding_and_back_unchanged() {
        let properties = serde_json::json!({
            "title": "Recipes",
            "search": { "types": ["core.note"], "tier": "feed", "state": ["archived"], "filter": "tags contains \"x\"", "beneath": "p" },
            "defaults": { "type": "core.note", "tier": "feed", "properties": { "rating": 3 }, "tags": ["new"], "edges": { "about": ["a"] } },
            "include": ["*.md"],
            "ignore": ["drafts/"],
            "first_placement": { "core.note": "Notes" },
            "removal_threshold": { "files": 4, "fraction": 0.5 },
        });
        let core: Settings = serde_json::from_value(properties).unwrap();
        let crossed = settings(core.clone()).unwrap();
        assert_eq!(crossed.search.states, Some(vec![ItemState::Archived]));
        assert_eq!(crossed.search.tier, Some(Tier::Feed));
        assert_eq!(core_settings(crossed).unwrap(), core);
    }

    #[test]
    fn a_change_sends_only_the_settings_it_names() {
        let body = change_body(FolderSettingsChange {
            title: Some("Renamed".into()),
            include: Some(vec![]),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            Value::Object(body),
            serde_json::json!({ "title": "Renamed", "include": [] })
        );
        let refused = change_body(FolderSettingsChange {
            defaults: Some(FolderDefaults {
                r#type: None,
                tier: None,
                properties_json: "[]".into(),
                tags: vec![],
                edges: HashMap::new(),
            }),
            ..Default::default()
        });
        assert!(matches!(refused, Err(MarfaError::Invalid { .. })));
    }
}

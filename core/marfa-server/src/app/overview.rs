//! What an instance holds that one credential can reach.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use super::access::{Caller, Described, Level};
use super::catalog::Catalog;
use super::edge_types;
use super::instance;
use super::items::{self, is_system, reading};
use super::query::{self, Listed};
use super::refusal::Result;
use super::{App, access};

const TYPES: usize = 50;
const EDGE_TYPES: usize = 50;
const TAGS: usize = 30;
const VIEWS: usize = 30;
const FOLDERS: usize = 30;
const PATTERNS: usize = 30;
const TEXT: usize = 100;
const VIEW_TYPE: &str = "system.view";
const FOLDER_TYPE: &str = "system.folder";
const LEVELS: [&str; 3] = ["write", "read", "none"];

/// Text over the cap ends in an ellipsis that counts toward it.
fn clipped(text: &str) -> String {
    if text.chars().count() <= TEXT {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(TEXT - 1).collect();
    cut.push('\u{2026}');
    cut
}

/// The first `cap` of `entries`, with the length before the cut noted when it was cut.
fn capped<T>(
    mut entries: Vec<T>,
    cap: usize,
    name: &str,
    truncated: &mut Map<String, Value>,
) -> Vec<T> {
    if entries.len() > cap {
        truncated.insert(name.to_string(), entries.len().into());
        entries.truncate(cap);
    }
    entries
}

fn credential(described: Described, truncated: &mut Map<String, Value>) -> Value {
    let mut out = Map::new();
    out.insert(
        "kind".into(),
        if described.app { "app" } else { "key" }.into(),
    );
    if let Some(label) = described.label {
        out.insert("label".into(), label.into());
    }
    let mut levels = Map::new();
    for (level, patterns) in LEVELS.into_iter().zip(described.types) {
        if !patterns.is_empty() {
            let name = format!("credential.type_permissions.{level}");
            levels.insert(
                level.into(),
                capped(patterns, PATTERNS, &name, truncated).into(),
            );
        }
    }
    if !levels.is_empty() {
        out.insert("type_permissions".into(), levels.into());
    }
    if !described.permissions.is_empty() {
        let words: Vec<&str> = described
            .permissions
            .iter()
            .map(|held| held.word())
            .collect();
        out.insert("permissions".into(), words.into());
    }
    out.into()
}

fn described(catalog: &Catalog, id: &str) -> Option<String> {
    let text = catalog.types.get(id)?.get("description")?.as_str()?;
    (!text.is_empty()).then(|| clipped(text))
}

fn edge_types(
    catalog: &Catalog,
    caller: &Caller,
    truncated: &mut Map<String, Value>,
) -> Result<Vec<Value>> {
    let held = edge_types::all(catalog)?;
    let mut found: Vec<(&str, Option<String>, Level)> = held
        .iter()
        .filter_map(|edge| {
            let id = edge.get("id")?.as_str()?;
            let level = caller.edge_level(id);
            (level >= Level::Read).then(|| {
                let text = edge.get("description").and_then(Value::as_str);
                (id, text.filter(|text| !text.is_empty()).map(clipped), level)
            })
        })
        .collect();
    found.sort_by(|a, b| a.0.cmp(b.0));
    Ok(capped(found, EDGE_TYPES, "edge_types", truncated)
        .into_iter()
        .map(|(id, description, level)| {
            let mut entry = Map::new();
            entry.insert("id".into(), id.into());
            if let Some(description) = description {
                entry.insert("description".into(), description.into());
            }
            entry.insert("access".into(), level.word().into());
            entry.into()
        })
        .collect())
}

/// A credential only: the owner and the local command hold no type map, and are refused before this.
pub async fn read(app: &App, caller: &Caller) -> Result<Value> {
    let listed = [
        Listed {
            type_id: VIEW_TYPE,
            limit: VIEWS as i64,
        },
        Listed {
            type_id: FOLDER_TYPE,
            limit: FOLDERS as i64,
        },
    ];
    reading(app, caller, move |read| {
        let name =
            instance::stored_name(read.tx)?.unwrap_or_else(|| instance::DEFAULT_NAME.to_string());
        let held = query::held(read, &listed)?;
        let tags = items::readable_tags(read)?;
        let catalog = &read.catalog;
        let mut truncated = Map::new();
        let mut body = Map::new();
        body.insert(
            "instance".into(),
            json!({ "name": name, "version": instance::VERSION }),
        );
        let credential = read
            .caller
            .described()
            .map(|described| credential(described, &mut truncated))
            .ok_or_else(access::unauthorized)?;
        body.insert("credential".into(), credential);

        let mut counts: BTreeMap<&str, i64> = held
            .counts
            .iter()
            .map(|(id, count)| (id.as_str(), *count))
            .collect();
        for id in catalog.types.ids() {
            if !is_system(id) && read.caller.may_read_type(id) {
                counts.entry(id).or_insert(0);
            }
        }
        let mut types: Vec<(&str, i64)> = counts.into_iter().collect();
        types.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        let total: i64 = types.iter().map(|(_, count)| count).sum();
        let reads_types = !types.is_empty();
        let types: Vec<Value> = capped(types, TYPES, "types", &mut truncated)
            .into_iter()
            .map(|(id, count)| {
                let mut entry = Map::new();
                entry.insert("id".into(), id.into());
                if let Some(description) = described(catalog, id) {
                    entry.insert("description".into(), description.into());
                }
                entry.insert("count".into(), count.into());
                entry.into()
            })
            .collect();
        if reads_types {
            body.insert("types".into(), types.into());
            body.insert("total".into(), total.into());
            let edges = edge_types(catalog, &read.caller, &mut truncated)?;
            if !edges.is_empty() {
                body.insert("edge_types".into(), edges.into());
            }
        }
        let tags: Vec<Value> = capped(tags, TAGS, "tags", &mut truncated)
            .into_iter()
            .map(|(tag, count)| json!({ "tag": tag, "count": count }))
            .collect();
        if !tags.is_empty() {
            body.insert("tags".into(), tags.into());
        }
        for ((name, (total, titled)), cap) in ["views", "folders"]
            .into_iter()
            .zip(held.titled)
            .zip([VIEWS, FOLDERS])
        {
            if total as usize > cap {
                truncated.insert(name.into(), total.into());
            }
            if !titled.is_empty() {
                let entries: Vec<Value> = titled
                    .into_iter()
                    .map(|entry| json!({ "id": entry.id, "title": clipped(&entry.title) }))
                    .collect();
                body.insert(name.into(), entries.into());
            }
        }
        if !truncated.is_empty() {
            body.insert("truncated".into(), truncated.into());
        }
        Ok(Value::Object(body))
    })
    .await
}

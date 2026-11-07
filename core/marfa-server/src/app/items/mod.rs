//! Items: what they hold, how they are answered and how they are written.
//!
//! Every write goes through [`write::apply`], and only `rows` holds the SQL of
//! the item tables, so no other part of the crate can change an item without
//! the checks, the version step, the audit entry and the event.

mod read;
mod rows;
pub mod write;

use marfa_rules::catalog::Catalog as Rules;
use marfa_rules::conflict::ItemFields;
use marfa_rules::names;
use rusqlite::Transaction;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::access::Caller;
use super::refusal::{Refusal, Result};

pub use read::{
    Detail, Many, bulk_get, detail, extension, extensions, history, metadata, tag_counts, titles,
};

/// An item as stored. `properties` is the stored JSON as text, which goes out
/// as it stands.
#[derive(Clone, Debug)]
pub struct Item {
    seq: i64,
    pub id: String,
    pub type_id: String,
    pub state: String,
    pub tier: Option<String>,
    pub source: String,
    pub source_id: Option<String>,
    pub properties: String,
    pub version: i64,
    pub schema_version: i64,
    pub occurred_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub trashed_at: Option<String>,
    pub capture_latitude: Option<f64>,
    pub capture_longitude: Option<f64>,
}

/// Who wrote a version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Writer {
    pub kind: String,
    pub id: String,
    pub name: String,
}

/// An item as it stood at a version it left.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub id: String,
    pub item_id: String,
    pub version: i64,
    pub properties: String,
    pub type_id: String,
    pub tier: Option<String>,
    pub occurred_at: String,
    pub source_id: Option<String>,
    pub writer: Option<Writer>,
    pub created_at: String,
}

#[derive(Serialize)]
struct ItemHead<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    type_id: &'a str,
    state: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    tier: Option<&'a str>,
    created_at: &'a str,
    updated_at: &'a str,
    occurred_at: &'a str,
    source: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_id: Option<&'a str>,
    version: i64,
    schema_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    capture_latitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capture_longitude: Option<f64>,
    trashed_at: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    read_only: Option<bool>,
}

#[derive(Serialize)]
struct SnapshotHead<'a> {
    id: &'a str,
    item_id: &'a str,
    version: i64,
    #[serde(rename = "type")]
    type_id: &'a str,
    tier: Option<&'a str>,
    occurred_at: &'a str,
    source_id: Option<&'a str>,
    writer: Option<&'a Writer>,
    created_at: &'a str,
}

/// `head`, a JSON object, with `properties` added as text that is not parsed.
fn with_properties(head: &impl Serialize, properties: &str) -> Result<String> {
    let printed = marfa_rules::js::to_vec(head)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| Refusal::internal("an item did not print"))?;
    let open = printed
        .strip_suffix('}')
        .ok_or_else(|| Refusal::internal("an item did not print as an object"))?;
    Ok(format!("{open},\"properties\":{properties}}}"))
}

/// A stored JSON object, as a value to work on.
fn parsed(text: &str) -> Result<Map<String, Value>> {
    match serde_json::from_str(text) {
        Ok(Value::Object(object)) => Ok(object),
        _ => Err(Refusal::internal("stored properties do not read")),
    }
}

impl Item {
    fn head(&self, read_only: Option<bool>) -> ItemHead<'_> {
        ItemHead {
            id: &self.id,
            type_id: &self.type_id,
            state: &self.state,
            tier: self.tier.as_deref(),
            created_at: &self.created_at,
            updated_at: &self.updated_at,
            occurred_at: &self.occurred_at,
            source: &self.source,
            source_id: self.source_id.as_deref(),
            version: self.version,
            schema_version: self.schema_version,
            capture_latitude: self.capture_latitude,
            capture_longitude: self.capture_longitude,
            trashed_at: self.trashed_at.as_deref(),
            read_only,
        }
    }

    /// The item as an answer gives it.
    pub fn answered(&self, tx: &Transaction<'_>) -> Result<String> {
        let read_only = read_only(tx, &self.source, &self.type_id)?;
        with_properties(&self.head(Some(read_only)), &self.properties)
    }

    /// The item as the event log keeps it. A frame adds `read_only` when it
    /// is sent, as registrations stand then.
    fn logged(&self) -> Result<String> {
        with_properties(&self.head(None), &self.properties)
    }

    /// The item as a conflict answer names it.
    fn state_named(&self) -> Result<Value> {
        Ok(json!({
            "id": self.id,
            "version": self.version,
            "properties": Value::Object(parsed(&self.properties)?),
            "type": self.type_id,
            "tier": self.tier,
            "occurred_at": self.occurred_at,
            "source_id": self.source_id,
        }))
    }

    fn fields(&self) -> ItemFields {
        ItemFields {
            tier: self.tier.clone(),
            occurred_at: Some(self.occurred_at.clone()),
            source_id: self.source_id.clone(),
        }
    }
}

impl Snapshot {
    /// The snapshot as a history gives it.
    fn answered(&self) -> Result<String> {
        let head = SnapshotHead {
            id: &self.id,
            item_id: &self.item_id,
            version: self.version,
            type_id: &self.type_id,
            tier: self.tier.as_deref(),
            occurred_at: &self.occurred_at,
            source_id: self.source_id.as_deref(),
            writer: self.writer.as_ref(),
            created_at: &self.created_at,
        };
        with_properties(&head, &self.properties)
    }

    /// The snapshot as a conflict answer names it.
    fn state_named(&self) -> Result<Value> {
        Ok(json!({
            "id": self.item_id,
            "version": self.version,
            "properties": Value::Object(parsed(&self.properties)?),
            "type": self.type_id,
            "tier": self.tier,
            "occurred_at": self.occurred_at,
            "source_id": self.source_id,
        }))
    }

    fn fields(&self) -> ItemFields {
        ItemFields {
            tier: self.tier.clone(),
            occurred_at: Some(self.occurred_at.clone()),
            source_id: self.source_id.clone(),
        }
    }
}

/// The one answer to whether an item of `type_id` under `source` is read only.
/// A connector registration is what makes one so, and none can exist yet.
pub fn read_only(_tx: &Transaction<'_>, _source: &str, _type_id: &str) -> Result<bool> {
    Ok(false)
}

fn is_system(type_id: &str) -> bool {
    type_id.split('.').next() == Some("system")
}

/// What `properties` of `type_id` are found by under a title lookup.
fn title_key(rules: &Rules, type_id: &str, properties: &Map<String, Value>) -> Option<String> {
    if is_system(type_id) {
        return None;
    }
    properties
        .get(rules.title_property(type_id))
        .and_then(Value::as_str)
        .and_then(names::title_key)
}

/// The metadata of an item, as text, holding what `shown` lets through.
fn metadata_text(
    tx: &Transaction<'_>,
    item: &Item,
    shown: impl Fn(&str) -> bool,
) -> Result<String> {
    let tags = rows::tags(tx, item.seq)?;
    let head = marfa_rules::js::to_vec(&json!({ "item_id": item.id, "tags": tags }))
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| Refusal::internal("metadata did not print"))?;
    let open = head
        .strip_suffix('}')
        .ok_or_else(|| Refusal::internal("metadata did not print as an object"))?;
    Ok(format!(
        "{open},\"extensions\":{}}}",
        extensions_text(tx, item, shown)?
    ))
}

fn extensions_text(
    tx: &Transaction<'_>,
    item: &Item,
    shown: impl Fn(&str) -> bool,
) -> Result<String> {
    let entries: Vec<String> = rows::extensions(tx, item.seq)?
        .into_iter()
        .filter(|(namespace, _)| shown(namespace))
        .map(|(namespace, data)| format!("{}:{data}", Value::from(namespace)))
        .collect();
    Ok(format!("{{{}}}", entries.join(",")))
}

/// The metadata an answer to `caller` gives.
fn metadata_for(tx: &Transaction<'_>, item: &Item, caller: &Caller) -> Result<String> {
    metadata_text(tx, item, |namespace| caller.may_read_extension(namespace))
}

/// The type of the row `id`, wherever it stands.
pub fn type_of(tx: &Transaction<'_>, id: &str) -> Result<Option<String>> {
    Ok(rows::by_id(tx, id)?.map(|row| row.type_id))
}

/// How many items hold `type_id`, in any state.
pub fn count_of_type(tx: &Transaction<'_>, type_id: &str) -> Result<i64> {
    rows::count_of_type(tx, type_id)
}

/// Which of `names` a stored item of one of `types` holds.
pub fn held_names(tx: &Transaction<'_>, types: &[String], names: &[String]) -> Result<Vec<String>> {
    if types.is_empty() {
        return Ok(Vec::new());
    }
    rows::held_names(tx, types, names)
}

/// Makes the title keys of the items of `types` agree with `after`, for each
/// type it gives another title property than `before` did.
pub fn rekey_changed(
    tx: &Transaction<'_>,
    before: &Rules,
    after: &Rules,
    types: &[String],
) -> Result<()> {
    for type_id in types {
        if before.title_property(type_id) == after.title_property(type_id) {
            continue;
        }
        for (seq, properties) in rows::of_type(tx, type_id)? {
            let key = title_key(after, type_id, &parsed(&properties)?);
            rows::set_title_key(tx, seq, key.as_deref())?;
        }
    }
    Ok(())
}

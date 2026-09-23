use std::collections::HashMap;

use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

fn lenient_i64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    let number = f64::deserialize(deserializer)?;
    Ok(number as i64)
}

fn lenient_string<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text),
        Some(other) => Some(other.to_string()),
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireItem {
    pub id: String,
    pub r#type: String,
    #[serde(default)]
    pub properties: Map<String, Value>,
    pub state: String,
    #[serde(default)]
    pub tier: Option<String>,
    #[serde(deserialize_with = "lenient_i64")]
    pub version: i64,
    #[serde(deserialize_with = "lenient_i64")]
    pub schema_version: i64,
    pub source: String,
    #[serde(default)]
    pub source_id: Option<String>,
    pub occurred_at: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub edges: Option<HashMap<String, WireEdgeBlock>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireEdge {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub edge_type: String,
    #[serde(default)]
    pub properties: Map<String, Value>,
    #[serde(deserialize_with = "lenient_i64")]
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// The first page of one edge type's edges, inline on an item.
pub type WireEdgeBlock = WirePage<WireEdge>;

#[derive(Debug, Clone, Deserialize)]
pub struct WireMetadata {
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireItemWithMetadata {
    pub item: WireItem,
    pub metadata: WireMetadata,
}

/// One page of a list: `next_cursor` continues it and is `None` on the last.
/// A page can be short or empty with a cursor still to follow, so a walk
/// stops on `None` and never on a short page.
///
/// The key is required, `null` included: serde would otherwise read a page
/// that dropped it as the last one, and a walk would stop after its first
/// page without a word.
#[derive(Debug, Clone, Deserialize)]
pub struct WirePage<T> {
    pub data: Vec<T>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct WireDisplayHints {
    #[serde(default)]
    pub title_field: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireType {
    pub id: String,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub display_hints: Option<WireDisplayHints>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireErrorBody {
    pub code: String,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireErrorEnvelope {
    pub error: WireErrorBody,
}

/// One `data:` payload from `GET /events`, whatever frame it belongs to.
#[derive(Debug, Clone, Deserialize)]
pub struct EventPayload {
    pub r#type: String,
    #[serde(default)]
    pub item: Option<WireItem>,
    #[serde(default)]
    pub metadata: Option<WireMetadata>,
    #[serde(default)]
    pub edge: Option<WireEdge>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub cursor: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub min_retained_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// What the server resolved on a write that collided.
///
/// Present only where it resolved one, which is what tells `merged` from
/// `accepted`; `conflicted_copy_id` present is what tells `conflicted` from
/// `merged` (`queue-and-verdicts.md` 8).
#[derive(Debug, Clone, Deserialize)]
pub struct WireConflictResolution {
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub conflicted_copy_id: Option<String>,
}

/// The body a successful write answers with.
#[derive(Debug, Clone, Deserialize)]
pub struct WireWriteAnswer {
    pub item: WireItem,
    #[serde(default)]
    pub metadata: Option<WireMetadata>,
    #[serde(default)]
    pub conflict_resolution: Option<WireConflictResolution>,
    /// The server recognized the write as one it had already taken. It does
    /// not change the verdict — the row the server returned is the truth
    /// either way (`queue-and-verdicts.md` 9) — and it is read so that a
    /// device is not left comparing rows to find out.
    #[serde(default)]
    pub acknowledged: bool,
}

/// The body an edge write answers with.
#[derive(Debug, Clone, Deserialize)]
pub struct WireEdgeAnswer {
    pub edge: WireEdge,
}

#[cfg(test)]
mod tests {
    use super::WirePage;

    #[test]
    fn a_page_without_a_cursor_key_is_refused_and_a_null_one_is_the_last() {
        assert!(serde_json::from_str::<WirePage<u32>>(r#"{"data":[1]}"#).is_err());
        let last: WirePage<u32> =
            serde_json::from_str(r#"{"data":[1],"next_cursor":null}"#).unwrap();
        assert_eq!(last.next_cursor, None);
        let more: WirePage<u32> =
            serde_json::from_str(r#"{"data":[],"next_cursor":"c1"}"#).unwrap();
        assert_eq!(more.next_cursor.as_deref(), Some("c1"));
    }
}

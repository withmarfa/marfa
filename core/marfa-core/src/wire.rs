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
    #[serde(default)]
    pub device: Option<String>,
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

#[derive(Debug, Clone, Deserialize)]
pub struct WireEdgeBlock {
    #[serde(default)]
    pub edges: Vec<WireEdge>,
    #[serde(default)]
    pub has_more: bool,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

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

#[derive(Debug, Clone, Deserialize)]
pub struct WirePage<T> {
    pub data: Vec<T>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub has_more: bool,
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

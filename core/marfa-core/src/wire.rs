use std::collections::HashMap;

use serde::{Deserialize, Deserializer, Serialize};
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
    pub capture_latitude: Option<f64>,
    #[serde(default)]
    pub capture_longitude: Option<f64>,
    #[serde(default)]
    pub trashed_at: Option<String>,
    #[serde(default)]
    pub edges: Option<HashMap<String, WireEdgeBlock>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    #[serde(default)]
    pub listed: Option<bool>,
    pub item: WireItem,
    pub metadata: WireMetadata,
}

/// A page can be short or empty with a cursor still to follow, so a walk
/// stops on `None`, never on a short page. The key is required, `null`
/// included: serde would otherwise read a page that dropped it as the last.
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
    #[serde(default)]
    pub body_field: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
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

/// Every field the listing always sends is required, so a row missing one is
/// refused rather than held with a default that says something else. The two
/// labels are the exception: a catalog held or listed before every edge type
/// carried them has none, so [`WireEdgeType::label`] and
/// [`WireEdgeType::reverse_label`] fill them as the server does. So are
/// `acyclic` and `flat`, which such a catalog reads as `false`: the copy then
/// judges no cycle or nesting of its own and the server, which still does,
/// answers for them.
#[derive(Debug, Clone, Deserialize)]
pub struct WireEdgeType {
    pub id: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    reverse_label: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub cardinality: String,
    #[serde(default)]
    pub reverse_name: Option<String>,
    pub written_at: crate::catalog::WrittenAt,
    pub source_type_constraints: Vec<String>,
    pub target_type_constraints: Vec<String>,
    pub cascade_on_delete: String,
    pub property_schema: Map<String, Value>,
    pub shipped: bool,
    #[serde(default)]
    pub acyclic: bool,
    #[serde(default)]
    pub flat: bool,
}

impl WireEdgeType {
    /// The listed `label`, or the one the id makes where the row has none.
    pub fn label(&self) -> String {
        match self.label.as_deref() {
            Some(label) if !label.is_empty() => label.to_string(),
            _ => label_from_id(&self.id),
        }
    }

    /// The listed `reverse_label`, or the `label` where the row has none: the
    /// relation is two-way.
    pub fn reverse_label(&self) -> String {
        match self.reverse_label.as_deref() {
            Some(label) if !label.is_empty() => label.to_string(),
            _ => self.label(),
        }
    }
}

/// The label a type gets when it names none: the last segment of its id, with
/// each hyphen and underscore made a space and each word capitalized.
/// `labelFromId` in `@withmarfa/shared` is the same function; a test on each
/// side holds both to the same answers.
pub fn label_from_id(id: &str) -> String {
    label_from_name(id.rsplit('.').next().unwrap_or(id))
}

/// The label a field or a member of a list's entries gets when nothing names
/// one: each hyphen and underscore made a space and the first character at the
/// start or after a space capitalized, whatever its script, so `due_at`
/// becomes `Due At` and `résumé` becomes `Résumé`. `labelFromName` in
/// `@withmarfa/types` is the same function; a test on each side holds both to
/// the same answers.
pub fn label_from_name(name: &str) -> String {
    let mut label = String::with_capacity(name.len());
    let mut word_start = true;
    for ch in name.chars() {
        let ch = if ch == '-' || ch == '_' { ' ' } else { ch };
        if word_start {
            label.extend(ch.to_uppercase());
        } else {
            label.push(ch);
        }
        word_start = ch == ' ';
    }
    label
}

/// The plural a type gets when it names none, made from its label by the
/// regular English rule on lowercase letters: a consonant and `y` become
/// `ies`, an ending of `s`, `x`, `z`, `ch` or `sh` takes `es`, and any other
/// label takes `s`. `pluralFromLabel` in `@withmarfa/types` is the same
/// function; a test on each side holds both to the same answers.
pub fn plural_from_label(label: &str) -> String {
    let mut chars = label.chars().rev();
    let last = chars.next();
    let before = chars.next();
    let consonant = |ch: char| ch.is_ascii_lowercase() && !"aeiou".contains(ch);
    match (before, last) {
        (Some(before), Some('y')) if consonant(before) => {
            format!("{}ies", &label[..label.len() - 1])
        }
        _ if ["s", "x", "z", "ch", "sh"]
            .iter()
            .any(|ending| label.ends_with(ending)) =>
        {
            format!("{label}es")
        }
        _ => format!("{label}s"),
    }
}

/// Both catalogs, read together so a copy never holds one without the other.
#[derive(Debug, Clone)]
pub struct WireCatalog {
    pub types: Vec<WireType>,
    /// Each row as listed, checked to read as a `WireEdgeType`.
    pub edge_types: Vec<Value>,
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

#[derive(Debug, Clone, Deserialize)]
pub struct EventPayload {
    #[serde(default)]
    pub listed: Option<bool>,
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub reach: Option<String>,
    pub event_type: String,
    #[serde(default)]
    pub item: Option<WireItem>,
    #[serde(default)]
    pub metadata: Option<WireMetadata>,
    #[serde(default)]
    pub edge: Option<WireEdge>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub min_retained_id: Option<String>,
    /// The log's head, which a `cursor_ahead` frame names.
    #[serde(default, deserialize_with = "lenient_string")]
    pub head: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireConflictResolution {
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub conflicted_copy_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireWriteAnswer {
    pub item: WireItem,
    #[serde(default)]
    pub conflict_resolution: Option<WireConflictResolution>,
    #[serde(default)]
    pub acknowledged: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireEdgeAnswer {
    pub edge: WireEdge,
    #[serde(default)]
    pub acknowledged: bool,
}

#[cfg(test)]
mod tests {
    use super::{WireEdgeType, WirePage, label_from_id, label_from_name, plural_from_label};

    /// The same table as `type-label.test.ts` in `@withmarfa/shared`.
    pub const LABELS: [(&str, &str); 6] = [
        ("acme.list-member", "List Member"),
        ("parent-of", "Parent Of"),
        ("about", "About"),
        ("a.b.snake_case_name", "Snake Case Name"),
        ("acme.2nd-pass", "2nd Pass"),
        ("acme.v2--draft", "V2  Draft"),
    ];

    /// The same table as `NAMES` in `type-label.test.ts` in
    /// `@withmarfa/shared`.
    pub const NAMES: [(&str, &str); 6] = [
        ("résumé", "Résumé"),
        ("éclair", "Éclair"),
        ("straße_nummer", "Straße Nummer"),
        ("naïve-café", "Naïve Café"),
        ("due__at", "Due  At"),
        ("2nd-pass", "2nd Pass"),
    ];

    #[test]
    fn a_label_is_made_from_an_id_as_the_server_makes_it() {
        for (id, label) in LABELS {
            assert_eq!(label_from_id(id), label, "{id}");
        }
        assert_eq!(label_from_name("due_at"), "Due At");
        assert_eq!(label_from_name("phone-number"), "Phone Number");
        for (name, label) in NAMES {
            assert_eq!(label_from_name(name), label, "{name}");
        }
    }

    /// The same table as `PLURALS` in `type-label.test.ts` in
    /// `@withmarfa/shared`.
    pub const PLURALS: [(&str, &str); 10] = [
        ("Note", "Notes"),
        ("Story", "Stories"),
        ("Day", "Days"),
        ("Box", "Boxes"),
        ("Church", "Churches"),
        ("Wish", "Wishes"),
        ("Address", "Addresses"),
        ("Quiz", "Quizes"),
        ("URL", "URLs"),
        ("Contact Entry", "Contact Entries"),
    ];

    #[test]
    fn a_plural_is_made_from_a_label_as_the_server_makes_it() {
        for (label, plural) in PLURALS {
            assert_eq!(plural_from_label(label), plural, "{label}");
        }
    }

    #[test]
    fn an_edge_type_row_without_labels_reads_with_the_ones_the_server_makes() {
        let bare = |extra: &str| -> WireEdgeType {
            serde_json::from_str(&format!(
                r#"{{"id":"acme.list-member","cardinality":"many-to-many","source_type_constraints":["*"],"target_type_constraints":["*"],"cascade_on_delete":"orphan","property_schema":{{}},"written_at":"source","shipped":false{extra}}}"#
            ))
            .unwrap()
        };
        let none = bare("");
        assert_eq!(
            (none.label(), none.reverse_label()),
            ("List Member".into(), "List Member".into())
        );
        let named = bare(r#","label":"Members","reverse_label":"Member of""#);
        assert_eq!(
            (named.label(), named.reverse_label()),
            ("Members".into(), "Member of".into())
        );
        let one_way = bare(r#","label":"Members","reverse_label":"""#);
        assert_eq!(one_way.reverse_label(), "Members");
    }

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

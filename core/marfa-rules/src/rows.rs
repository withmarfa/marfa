//! Shared grammar and limits for table row batches.

use serde_json::{Map, Value};

/// The most operations a batch holds.
pub const MAX_OPERATIONS: usize = 1000;
/// The most bytes a row's values hold, written as JSON.
pub const MAX_ROW_BYTES: usize = 65_536;

const OP_MEMBERS: [&str; 3] = ["op", "id", "values"];

#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Put {
        id: Option<String>,
        values: Map<String, Value>,
    },
    Patch {
        id: String,
        values: Map<String, Value>,
    },
    Delete {
        id: String,
    },
}

/// A batch refusal has no operation index and names the `operations` path.
#[derive(Clone, Debug, PartialEq)]
pub struct Refused {
    pub operation: Option<usize>,
    pub path: String,
    pub message: String,
}

impl Refused {
    fn batch(message: impl Into<String>) -> Self {
        Refused {
            operation: None,
            path: "operations".into(),
            message: message.into(),
        }
    }

    /// `member` is the part of operation `index` at fault, or empty for the operation.
    pub fn at(index: usize, member: &str, message: impl Into<String>) -> Self {
        Refused {
            operation: Some(index),
            path: if member.is_empty() {
                format!("operations.{index}")
            } else {
                format!("operations.{index}.{member}")
            },
            message: message.into(),
        }
    }

    /// The message with the path it names, as a client reads it.
    pub fn sentence(&self) -> String {
        format!("{}: {}", self.path, self.message)
    }
}

fn row_id(index: usize, value: Option<&Value>, required: bool) -> Result<Option<String>, Refused> {
    match value {
        None if required => Err(Refused::at(
            index,
            "id",
            "This operation names the row by id.",
        )),
        None => Ok(None),
        Some(Value::String(id)) if crate::validation::id("id", id).is_ok() => Ok(Some(id.clone())),
        Some(_) => Err(Refused::at(
            index,
            "id",
            "A row id is a UUIDv7 in lowercase.",
        )),
    }
}

fn values_of(index: usize, value: Option<&Value>) -> Result<Map<String, Value>, Refused> {
    match value {
        Some(Value::Object(values)) => Ok(values.clone()),
        _ => Err(Refused::at(
            index,
            "values",
            "values is an object keyed by column.",
        )),
    }
}

/// A batch of at most `most` operations.
pub fn operations(sent: Option<&Value>, most: usize) -> Result<Vec<Op>, Refused> {
    let Some(Value::Array(sent)) = sent else {
        return Err(Refused::batch("operations is a list of operations."));
    };
    batch(sent, most)
}

/// `operations`, for a list already read.
pub fn batch(sent: &[Value], most: usize) -> Result<Vec<Op>, Refused> {
    if sent.is_empty() {
        return Err(Refused::batch("operations names at least one operation."));
    }
    if sent.len() > most {
        return Err(Refused::batch(format!(
            "A batch holds at most {most} operations; this holds {}.",
            sent.len()
        )));
    }
    sent.iter()
        .enumerate()
        .map(|(index, entry)| {
            let Value::Object(entry) = entry else {
                return Err(Refused::batch("Each operation is an object."));
            };
            if let Some(unknown) = entry.keys().find(|key| !OP_MEMBERS.contains(&key.as_str())) {
                return Err(Refused::at(
                    index,
                    unknown,
                    "An operation names op, id and values.",
                ));
            }
            match entry.get("op").and_then(Value::as_str) {
                Some("put") => Ok(Op::Put {
                    id: row_id(index, entry.get("id"), false)?,
                    values: values_of(index, entry.get("values"))?,
                }),
                Some("patch") => Ok(Op::Patch {
                    id: row_id(index, entry.get("id"), true)?.unwrap_or_default(),
                    values: values_of(index, entry.get("values"))?,
                }),
                Some("delete") if entry.contains_key("values") => {
                    Err(Refused::at(index, "values", "A delete sends no values."))
                }
                Some("delete") => Ok(Op::Delete {
                    id: row_id(index, entry.get("id"), true)?.unwrap_or_default(),
                }),
                _ => Err(Refused::at(index, "op", "op is put, patch or delete.")),
            }
        })
        .collect()
}

/// A row's size: its values written as compact JSON.
pub fn printed_len(values: &Map<String, Value>) -> usize {
    serde_json::to_string(values).map_or(0, |text| text.len())
}

pub fn refuse_wide(index: usize, values: &Map<String, Value>) -> Result<(), Refused> {
    let bytes = printed_len(values);
    if bytes > MAX_ROW_BYTES {
        return Err(Refused::at(
            index,
            "values",
            format!(
                "A row holds at most {MAX_ROW_BYTES} bytes of values as JSON; this operation leaves {bytes}."
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "01a1b75e-2d9d-775a-930a-6b3d1207edae";

    #[test]
    fn a_batch_is_read_into_its_three_operations_and_a_fault_names_where_it_is() {
        let sent = json!([
            { "op": "put", "values": { "a": 1 } },
            { "op": "patch", "id": ID, "values": {} },
            { "op": "delete", "id": ID },
        ]);
        let ops = operations(Some(&sent), MAX_OPERATIONS).unwrap();
        assert!(matches!(&ops[0], Op::Put { id: None, .. }));
        assert!(matches!(&ops[2], Op::Delete { .. }));
        let many = json!(vec![json!({ "op": "delete", "id": ID }); 3]);
        for (sent, path) in [
            (None, "operations"),
            (Some(json!([])), "operations"),
            (Some(many), "operations"),
            (Some(json!(["put"])), "operations"),
            (Some(json!([{ "op": "move" }])), "operations.0.op"),
            (
                Some(json!([{ "op": "patch", "values": {} }])),
                "operations.0.id",
            ),
            (
                Some(json!([{ "op": "put", "id": 7, "values": {} }])),
                "operations.0.id",
            ),
            (Some(json!([{ "op": "put" }])), "operations.0.values"),
            (
                Some(json!([{ "op": "put", "values": {}, "x": 1 }])),
                "operations.0.x",
            ),
            (
                Some(json!([{ "op": "delete", "id": ID, "values": {} }])),
                "operations.0.values",
            ),
        ] {
            let refused = operations(sent.as_ref(), 2).unwrap_err();
            assert_eq!(refused.path, path, "{refused:?}");
            assert_eq!(refused.operation.is_none(), path == "operations");
        }
    }

    #[test]
    fn a_row_is_wide_by_the_bytes_of_its_values_as_compact_json() {
        let mut values = Map::new();
        values.insert("a".into(), json!("x".repeat(MAX_ROW_BYTES - 8)));
        assert_eq!(printed_len(&values), MAX_ROW_BYTES);
        refuse_wide(3, &values).unwrap();
        values.insert("a".into(), json!("x".repeat(MAX_ROW_BYTES - 7)));
        let refused = refuse_wide(3, &values).unwrap_err();
        assert_eq!(refused.path, "operations.3.values");
        assert!(refused.message.contains("leaves 65537"), "{refused:?}");
    }
}

//! What a stream sends of a logged event, judged for the credential it holds.

use marfa_rules::catalog::Catalog as Rules;
use serde_json::{Map, Value};

use crate::app::access::Caller;
use crate::app::connectors::ReadOnly;
use crate::app::refusal::{Refusal, Result};

/// What the request asked for, which the stream keeps for its life.
#[derive(Clone, Debug, Default)]
pub struct Filter {
    /// Declared types and patterns; none selects every type.
    pub types: Vec<String>,
    pub edges: bool,
    /// A copy stream sends the frames of items the source filter leaves out, marked `listed: false`.
    pub copy: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Item,
    Edge,
}

/// The columns of a logged event, which decide whether its payload is read.
#[derive(Clone, Copy)]
pub struct Head<'a> {
    pub id: i64,
    pub event_type: &'a str,
    pub type_id: &'a str,
    pub source: &'a str,
}

pub(super) enum Verdict {
    Send(String),
    Withhold,
    Unreadable,
}

/// The payload as the credential may read it, after `event_type`.
pub enum Judged {
    Shown(Map<String, Value>),
    Withheld,
    Unreadable,
}

pub struct Judge<'a> {
    pub caller: &'a Caller,
    pub rules: &'a Rules,
    pub read_only: &'a ReadOnly,
    pub filter: &'a Filter,
}

impl Judge<'_> {
    /// Decides from the columns alone, so a payload a stream does not send is not read.
    pub fn wants(&self, entry: &Head<'_>) -> Option<Kind> {
        let kind = if entry.event_type.starts_with("edge.") {
            if !self.filter.edges {
                return None;
            }
            Kind::Edge
        } else {
            if !self.filter.types.is_empty()
                && !self
                    .filter
                    .types
                    .iter()
                    .any(|declared| self.rules.matches(declared, entry.type_id))
            {
                return None;
            }
            Kind::Item
        };
        (self.caller.may_read_type(entry.type_id) && (self.filter.copy || self.listed(entry)))
            .then_some(kind)
    }

    fn listed(&self, entry: &Head<'_>) -> bool {
        self.caller.lists(self.rules, entry.type_id, entry.source)
    }

    pub(super) fn render(&self, entry: &Head<'_>, kind: Kind, payload: &str) -> Result<Verdict> {
        Ok(match self.judged(entry, kind, payload)? {
            Judged::Shown(data) => match marfa_rules::number::to_vec(&Value::Object(data)) {
                Ok(json) => Verdict::Send(event_text(entry.id, entry.event_type, &json)),
                Err(_) => Verdict::Unreadable,
            },
            Judged::Withheld => Verdict::Withhold,
            Judged::Unreadable => Verdict::Unreadable,
        })
    }

    pub fn judged(&self, entry: &Head<'_>, kind: Kind, payload: &str) -> Result<Judged> {
        let Ok(Value::Object(mut body)) = serde_json::from_str(payload) else {
            return Ok(Judged::Unreadable);
        };
        let shown = match kind {
            Kind::Item => self.item(entry, &mut body)?,
            Kind::Edge => self.edge(entry, &body),
        };
        Ok(match shown {
            Some(true) => {
                let mut data = Map::new();
                data.insert("event_type".into(), entry.event_type.into());
                data.extend(body);
                Judged::Shown(data)
            }
            Some(false) => Judged::Withheld,
            None => Judged::Unreadable,
        })
    }

    fn edge(&self, entry: &Head<'_>, body: &Map<String, Value>) -> Option<bool> {
        let edge_type = body.get("edge")?.get("edge_type")?.as_str()?;
        body.get("source_type")?.as_str()?;
        Some(self.caller.may_read_edge(edge_type, entry.type_id))
    }

    fn item(&self, entry: &Head<'_>, body: &mut Map<String, Value>) -> Result<Option<bool>> {
        let Some(Value::Object(item)) = body.get_mut("item") else {
            return Ok(None);
        };
        if !item.get("type").is_some_and(Value::is_string) {
            return Ok(None);
        }
        let with_type = item.remove("trashed_with_type");
        self.named_to_readers(item, "trashed_with", with_type);
        let read_only = self.read_only.of(entry.source, entry.type_id);
        *item = before_properties(std::mem::take(item), read_only);
        let with_type = body.remove("restored_with_type");
        self.named_to_readers(body, "restored_with", with_type);
        if let Some(Value::Object(metadata)) = body.get_mut("metadata")
            && let Some(Value::Object(extensions)) = metadata.get_mut("extensions")
        {
            extensions.retain(|namespace, _| self.caller.may_read_extension(namespace));
        }
        if self.filter.copy {
            body.insert("listed".into(), self.listed(entry).into());
        }
        Ok(Some(true))
    }

    /// A mark names another row, so only a credential that reads that row's type sees its id.
    fn named_to_readers(
        &self,
        object: &mut Map<String, Value>,
        mark: &str,
        with_type: Option<Value>,
    ) {
        let readable = with_type
            .as_ref()
            .and_then(Value::as_str)
            .is_some_and(|type_id| self.caller.may_read_type(type_id));
        if !readable {
            object.remove(mark);
        }
    }
}

fn before_properties(item: Map<String, Value>, read_only: bool) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in item {
        if key == "properties" {
            out.insert("read_only".into(), read_only.into());
        }
        out.insert(key, value);
    }
    if !out.contains_key("read_only") {
        out.insert("read_only".into(), read_only.into());
    }
    out
}

fn event_text(id: i64, event_type: &str, json: &[u8]) -> String {
    format!(
        "id: {id}\nevent: {event_type}\ndata: {}\n\n",
        String::from_utf8_lossy(json)
    )
}

/// A frame that names where the stream stands and has no `id:`, so a client never resumes from it.
pub(super) fn marker(event_type: &str, fields: Vec<(&str, Value)>) -> Result<String> {
    let mut data = Map::new();
    data.insert("event_type".into(), event_type.into());
    for (name, value) in fields {
        data.insert(name.into(), value);
    }
    let json = marfa_rules::number::to_vec(&Value::Object(data))
        .map_err(|_| Refusal::internal("a stream frame did not print"))?;
    Ok(format!(
        "event: {event_type}\ndata: {}\n\n",
        String::from_utf8_lossy(&json)
    ))
}

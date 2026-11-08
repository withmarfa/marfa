use std::collections::BTreeSet;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{Arc, Mutex, PoisonError};

use marfa_rules::catalog::Catalog as Rules;
use serde_json::{Value, json};

use crate::app::refusal::{Code, Refusal, Result};

const LEVERS: [(&str, &[&str]); 3] = [
    ("strict_mode", &["types"]),
    ("source_allowlist", &["types", "sources"]),
    ("source_filter", &["types", "sources"]),
];

#[derive(Clone, Debug, PartialEq)]
pub struct Levers(serde_json::Map<String, Value>);

fn missing(path: String) -> Refusal {
    Refusal::new(Code::MissingRequiredField, format!("{path} is required"))
        .with_detail("field", path)
}

fn list_of_text(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

impl Levers {
    pub fn from_row(text: &str) -> Option<Levers> {
        let value: Value = serde_json::from_str(text).ok()?;
        Levers::from_body_at(&value, "enforcement").ok()
    }

    pub fn to_json(&self) -> Value {
        Value::Object(self.0.clone())
    }

    pub fn from_body(value: &Value) -> Result<Levers> {
        Levers::from_body_at(value, "enforcement_override")
    }

    pub fn from_body_at(value: &Value, at: &str) -> Result<Levers> {
        let refused = |path: &str| {
            let message = format!("{path} is not a valid lever setting.");
            Refusal::validation(message.clone())
                .with_detail("errors", json!([{ "path": path, "message": message }]))
        };
        let block = value.as_object().ok_or_else(|| refused(at))?;
        let mut levers = serde_json::Map::new();
        for (lever, members) in LEVERS {
            let Some(named) = block.get(lever) else {
                continue;
            };
            let path = format!("{at}.{lever}");
            let named = named.as_object().ok_or_else(|| refused(&path))?;
            let mut kept = serde_json::Map::new();
            for member in members {
                let path = format!("{path}.{member}");
                let list = named.get(*member).ok_or_else(|| missing(path.clone()))?;
                if !list_of_text(list) {
                    return Err(refused(&path));
                }
                kept.insert((*member).into(), list.clone());
            }
            levers.insert(lever.into(), Value::Object(kept));
        }
        Ok(Levers(levers))
    }

    pub fn unknown_names(value: &Value, at: &str) -> Vec<String> {
        let Some(block) = value.as_object() else {
            return Vec::new();
        };
        let mut unknown = Vec::new();
        for (name, named) in block {
            let Some((lever, members)) = LEVERS.iter().find(|(lever, _)| lever == name) else {
                unknown.push(format!("{at}.{name}"));
                continue;
            };
            for member in named.as_object().into_iter().flat_map(|named| named.keys()) {
                if !members.contains(&member.as_str()) {
                    unknown.push(format!("{at}.{lever}.{member}"));
                }
            }
        }
        unknown
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum OwnLevers {
    Unset,
    Set(Levers),
    /// Stored and not readable, so they hold the key closed. The text stays, so a write
    /// that does not name the levers leaves the row as it found it.
    Unread(String),
}

impl OwnLevers {
    pub fn from_row(text: Option<String>) -> OwnLevers {
        let Some(text) = text else {
            return OwnLevers::Unset;
        };
        match Levers::from_row(&text) {
            Some(levers) => OwnLevers::Set(levers),
            None => OwnLevers::Unread(text),
        }
    }

    pub fn readable(&self) -> Option<&Levers> {
        match self {
            OwnLevers::Set(levers) => Some(levers),
            OwnLevers::Unset | OwnLevers::Unread(_) => None,
        }
    }

    pub fn row_text(&self) -> Option<String> {
        match self {
            OwnLevers::Unset => None,
            OwnLevers::Set(levers) => Some(levers.to_json().to_string()),
            OwnLevers::Unread(text) => Some(text.clone()),
        }
    }

    pub fn already(&self, levers: Option<&Levers>) -> bool {
        match self {
            OwnLevers::Unread(_) => false,
            own => own.readable() == levers,
        }
    }
}

impl From<Option<Levers>> for OwnLevers {
    fn from(levers: Option<Levers>) -> OwnLevers {
        levers.map_or(OwnLevers::Unset, OwnLevers::Set)
    }
}

fn list(block: &Value, member: &str) -> Vec<String> {
    block
        .get(member)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.as_str().map(str::to_string))
        .collect()
}

#[derive(Debug)]
struct Scope {
    types: Vec<String>,
    sources: Vec<String>,
}

impl Scope {
    fn of(block: &Value) -> Scope {
        Scope {
            types: list(block, "types"),
            sources: list(block, "sources"),
        }
    }
}

#[derive(Debug)]
pub struct Holding {
    strict: Vec<String>,
    allowlist: Option<Scope>,
    filter: Option<Scope>,
    closed: bool,
}

impl Holding {
    pub const NOTHING: Holding = Holding {
        strict: Vec::new(),
        allowlist: None,
        filter: None,
        closed: false,
    };

    fn of(own: Option<&Levers>, instance: Option<&Levers>) -> Holding {
        let lever = |name| {
            own.and_then(|levers| levers.0.get(name))
                .or_else(|| instance.and_then(|levers| levers.0.get(name)))
        };
        Holding {
            strict: lever("strict_mode")
                .map(|block| list(block, "types"))
                .unwrap_or_default(),
            allowlist: lever("source_allowlist").map(Scope::of),
            filter: lever("source_filter").map(Scope::of),
            closed: false,
        }
    }

    pub fn filters_sources(&self) -> bool {
        self.closed || self.filter.is_some()
    }

    pub fn strict_on(&self, type_id: &str) -> bool {
        self.closed || self.strict.iter().any(|held| held == type_id)
    }

    pub fn allowed_sources(&self, type_id: &str) -> Option<&[String]> {
        if self.closed {
            return Some(&[]);
        }
        self.allowlist
            .as_ref()
            .filter(|scope| scope.types.iter().any(|held| held == type_id))
            .map(|scope| scope.sources.as_slice())
    }

    pub fn listed_sources(&self, rules: &Rules, type_id: &str) -> Option<&[String]> {
        if self.closed {
            return Some(&[]);
        }
        self.filter
            .as_ref()
            .filter(|scope| scope.types.iter().any(|held| rules.matches(held, type_id)))
            .map(|scope| scope.sources.as_slice())
    }
}

static REPORTED: Mutex<BTreeSet<u64>> = Mutex::new(BTreeSet::new());

fn first_report(holder: &str, text: &str) -> bool {
    let mut hasher = DefaultHasher::new();
    (holder, text).hash(&mut hasher);
    REPORTED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(hasher.finish())
}

pub fn report_unread(holder: &str, text: &str) {
    if first_report(holder, text) {
        tracing::error!(
            holder,
            "Stored enforcement levers do not read, so they hold everything"
        );
    }
}

/// Panics if asked before a transaction has read it: an empty answer would read as no lever at all.
#[derive(Clone, Debug, Default)]
pub struct Standing(Option<Arc<Holding>>);

impl Standing {
    pub fn of(own: Option<&Levers>, instance: Option<&Levers>) -> Standing {
        Standing(Some(Arc::new(Holding::of(own, instance))))
    }

    pub fn closed() -> Standing {
        Standing(Some(Arc::new(Holding {
            closed: true,
            ..Holding::NOTHING
        })))
    }

    pub fn holding(&self) -> &Holding {
        self.0
            .as_deref()
            .expect("a lever is asked of a caller no transaction has read")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn levers(body: Value) -> Levers {
        Levers::from_body_at(&body, "enforcement").unwrap()
    }

    #[test]
    fn a_key_s_lever_replaces_the_instance_s_whichever_way_it_moves() {
        let instance = levers(json!({ "strict_mode": { "types": ["a"] } }));
        let wider = levers(json!({ "strict_mode": { "types": [] } }));
        let narrower = levers(json!({ "strict_mode": { "types": ["a", "b"] } }));

        let loosened = Holding::of(Some(&wider), Some(&instance));
        assert!(!loosened.strict_on("a"));

        let tightened = Holding::of(Some(&narrower), Some(&instance));
        assert!(tightened.strict_on("b"));
    }

    #[test]
    fn a_lever_the_key_leaves_out_falls_to_the_instance_one_lever_at_a_time() {
        let instance = levers(json!({
            "strict_mode": { "types": ["a"] },
            "source_allowlist": { "types": ["a"], "sources": ["s"] },
        }));
        let own = levers(json!({ "strict_mode": { "types": [] } }));

        let holding = Holding::of(Some(&own), Some(&instance));
        assert!(!holding.strict_on("a"));
        assert_eq!(holding.allowed_sources("a"), Some(&["s".to_string()][..]));
    }

    #[test]
    fn with_no_lever_set_anywhere_nothing_is_held() {
        let holding = Holding::of(None, None);
        assert!(!holding.strict_on("a"));
        assert_eq!(holding.allowed_sources("a"), None);
    }

    #[test]
    fn the_allowlist_holds_only_the_types_it_names() {
        let instance = levers(json!({
            "source_allowlist": { "types": ["a"], "sources": [] },
        }));
        let holding = Holding::of(None, Some(&instance));
        assert_eq!(holding.allowed_sources("a"), Some(&[][..]));
        assert_eq!(holding.allowed_sources("b"), None);
    }

    #[test]
    fn a_listing_passes_over_rows_under_a_source_filter_or_closed_levers() {
        let strict = levers(json!({ "strict_mode": { "types": ["a"] } }));
        let filter = levers(json!({ "source_filter": { "types": ["a"], "sources": [] } }));

        assert!(!Holding::of(Some(&strict), None).filters_sources());
        assert!(Holding::of(None, Some(&filter)).filters_sources());
        assert!(Standing::closed().holding().filters_sources());
    }

    #[test]
    fn levers_that_do_not_read_hold_every_type_and_allow_no_source() {
        let closed = Standing::closed();
        assert!(closed.holding().strict_on("a"));
        assert_eq!(closed.holding().allowed_sources("a"), Some(&[][..]));
    }

    #[test]
    #[should_panic(expected = "no transaction has read")]
    fn a_standing_no_transaction_read_gives_no_answer() {
        Standing::default().holding();
    }

    #[test]
    fn a_stored_row_is_reported_once_and_a_different_one_again() {
        assert!(first_report("a", "reported once"));
        assert!(!first_report("a", "reported once"));
        assert!(first_report("a", "reported again"));
        assert!(first_report("b", "reported once"));
    }

    #[test]
    fn a_stored_row_reads_only_as_levers() {
        assert!(Levers::from_row("{ not json").is_none());
        assert!(Levers::from_row(r#"{"strict_mode":{}}"#).is_none());
        assert!(Levers::from_row(r#"{"strict_mode":{"types":["a"]}}"#).is_some());
    }
}

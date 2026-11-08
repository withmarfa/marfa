//! Written in the transaction of the write it records.

mod expiry;

use rusqlite::{Row, ToSql, Transaction, params, params_from_iter};
use serde_json::{Map, Value};

use super::access::Caller;
use super::refusal::{Refusal, Result};

pub use expiry::expire;

const HOUSEKEEPING: [&str; 12] = [
    "items.trash_purged",
    "items.feed_expired",
    "item.versions_thinned",
    "item.enrich",
    "auth.grants.purged",
    "auth.grant.retired",
    "auth.clients.purged",
    "keys.purged",
    "blob.purge",
    "blob.copy_struck",
    "blob.copy_dropped",
    "blob.copy_replicated",
];
const ACCESS_FAMILIES: [&str; 7] = [
    "auth", "owner", "key", "keys", "instance", "profile", "folder",
];
const SETTINGS_FAMILIES: [&str; 5] = [
    "config",
    "webhook",
    "connector",
    "connector_state",
    "inbound_endpoint",
];
const KINDS: [&str; 4] = ["access", "data", "settings", "housekeeping"];

const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 200;
const MAX_SEARCH_CHARS: usize = 200;

fn kind_of(action: &str) -> &'static str {
    let family = action.split('.').next().unwrap_or(action);
    if HOUSEKEEPING.contains(&action) {
        "housekeeping"
    } else if ACCESS_FAMILIES.contains(&family) {
        "access"
    } else if SETTINGS_FAMILIES.contains(&family) || action == "blob.stores_configured" {
        "settings"
    } else {
        "data"
    }
}

#[derive(Debug)]
pub struct Entry<'a> {
    pub action: &'a str,
    pub resource_type: &'a str,
    pub resource_id: Option<&'a str>,
    /// `None` is recorded as an empty object, which is what an entry with nothing more to say answers.
    pub details: Option<Value>,
}

pub fn record(tx: &Transaction<'_>, at: &str, caller: &Caller, entry: Entry<'_>) -> Result<()> {
    record_from(tx, at, Some(caller), None, entry)
}

pub fn record_from(
    tx: &Transaction<'_>,
    at: &str,
    caller: Option<&Caller>,
    client_ip: Option<&str>,
    entry: Entry<'_>,
) -> Result<()> {
    tx.execute(
        "INSERT INTO audit_log (id, created_at, key_id, actor, action, kind, resource_type, \
         resource_id, client_ip, details) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            uuid::Uuid::now_v7().to_string(),
            at,
            caller.map(Caller::audit_id),
            caller.map(|caller| caller.actor().to_string()),
            entry.action,
            kind_of(entry.action),
            entry.resource_type,
            entry.resource_id,
            client_ip,
            entry
                .details
                .unwrap_or_else(|| Value::Object(Map::new()))
                .to_string(),
        ],
    )?;
    Ok(())
}

#[derive(Debug, Default)]
pub struct Filter {
    action: Option<String>,
    resource_type: Option<String>,
    resource_id: Option<String>,
    kind: Option<String>,
    words: Vec<String>,
    created_after: Option<String>,
    created_before: Option<String>,
    after: Option<(String, String)>,
    limit: u32,
}

fn cursor_of(created_at: &str, id: &str) -> String {
    hex::encode(format!("{created_at}|{id}"))
}

fn from_cursor(cursor: &str) -> Option<(String, String)> {
    let text = String::from_utf8(hex::decode(cursor).ok()?).ok()?;
    let (created_at, id) = text.split_once('|')?;
    Some((created_at.to_string(), id.to_string()))
}

fn instant(value: &str, field: &str) -> Result<String> {
    marfa_rules::time::normalize_bound(value, field)
        .map_err(|_| Refusal::validation(format!("{field} is not a time.")))
}

impl Filter {
    pub fn from_query(pairs: &[(String, String)]) -> Result<Filter> {
        let mut filter = Filter {
            limit: DEFAULT_LIMIT,
            ..Filter::default()
        };
        for (name, value) in pairs {
            match name.as_str() {
                "action" => filter.action = Some(value.clone()),
                "resource_type" => filter.resource_type = Some(value.clone()),
                "resource_id" => filter.resource_id = Some(value.clone()),
                "kind" if KINDS.contains(&value.as_str()) => filter.kind = Some(value.clone()),
                "kind" => return Err(Refusal::validation("kind is not a kind of audit entry.")),
                "q" if value.chars().count() > MAX_SEARCH_CHARS => {
                    return Err(Refusal::validation("q is longer than 200 characters."));
                }
                "q" => {
                    filter.words = value
                        .split_whitespace()
                        .map(str::to_ascii_lowercase)
                        .collect();
                }
                "created_after" => filter.created_after = Some(instant(value, name)?),
                "created_before" => filter.created_before = Some(instant(value, name)?),
                "limit" => {
                    filter.limit = value
                        .parse()
                        .ok()
                        .filter(|limit| (1..=MAX_LIMIT).contains(limit))
                        .ok_or_else(|| {
                            Refusal::validation("limit must be a whole number from 1 to 200.")
                        })?;
                }
                "cursor" => {
                    filter.after = Some(
                        from_cursor(value)
                            .ok_or_else(|| Refusal::validation("cursor is not a cursor."))?,
                    );
                }
                _ => {}
            }
        }
        Ok(filter)
    }
}

fn entry_json(row: &Row<'_>) -> rusqlite::Result<(Value, String)> {
    let json_column = |column: &str| -> rusqlite::Result<Value> {
        let text: Option<String> = row.get(column)?;
        Ok(text
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null))
    };
    let id: String = row.get("id")?;
    let created_at: String = row.get("created_at")?;
    let cursor = cursor_of(&created_at, &id);
    let mut out = Map::new();
    out.insert("actor".into(), json_column("actor")?);
    out.insert("id".into(), id.into());
    out.insert("created_at".into(), created_at.into());
    out.insert(
        "key_id".into(),
        row.get::<_, Option<String>>("key_id")?.into(),
    );
    out.insert("action".into(), row.get::<_, String>("action")?.into());
    for column in ["resource_type", "resource_id", "client_ip"] {
        out.insert(column.into(), row.get::<_, Option<String>>(column)?.into());
    }
    out.insert("details".into(), json_column("details")?);
    Ok((Value::Object(out), cursor))
}

pub fn page(tx: &Transaction<'_>, filter: &Filter) -> Result<(Vec<Value>, Option<String>)> {
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<&dyn ToSql> = Vec::new();
    for (column, value) in [
        ("action", &filter.action),
        ("resource_type", &filter.resource_type),
        ("resource_id", &filter.resource_id),
        ("kind", &filter.kind),
    ] {
        if let Some(value) = value {
            values.push(value);
            clauses.push(format!("{column} = ?{}", values.len()));
        }
    }
    if let Some(value) = &filter.created_after {
        values.push(value);
        clauses.push(format!("created_at > ?{}", values.len()));
    }
    if let Some(value) = &filter.created_before {
        values.push(value);
        clauses.push(format!("created_at < ?{}", values.len()));
    }
    for word in &filter.words {
        values.push(word);
        let at = values.len();
        let held = [
            "action",
            "resource_type",
            "resource_id",
            "key_id",
            "client_ip",
            "details",
        ]
        .map(|column| format!("instr(lower(coalesce({column}, '')), ?{at}) > 0"))
        .join(" OR ");
        clauses.push(format!("({held})"));
    }
    if let Some((created_at, id)) = &filter.after {
        values.push(created_at);
        let first = values.len();
        values.push(id);
        clauses.push(format!("(created_at, id) < (?{first}, ?{})", first + 1));
    }
    let wanted = i64::from(filter.limit) + 1;
    values.push(&wanted);
    let limit_at = values.len();
    let condition = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let sql = format!(
        "SELECT * FROM audit_log {condition} ORDER BY created_at DESC, id DESC LIMIT ?{limit_at}"
    );
    let mut rows = tx
        .prepare(&sql)?
        .query_map(params_from_iter(values), entry_json)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let more = rows.len() > filter.limit as usize;
    rows.truncate(filter.limit as usize);
    let next = more
        .then(|| rows.last().map(|(_, cursor)| cursor.clone()))
        .flatten();
    Ok((rows.into_iter().map(|(entry, _)| entry).collect(), next))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_action_is_listed_under_its_kind() {
        for (action, kind) in [
            ("key.create", "access"),
            ("owner.claimed", "access"),
            ("keys.purged", "housekeeping"),
            ("config.update", "settings"),
            ("blob.stores_configured", "settings"),
            ("blob.purge", "housekeeping"),
            ("source.update", "data"),
            ("item.create", "data"),
        ] {
            assert_eq!(kind_of(action), kind, "{action}");
        }
    }

    #[test]
    fn a_cursor_reads_back_and_rubbish_is_not_one() {
        let cursor = cursor_of("2026-01-01T00:00:00.000Z", "abc");
        assert_eq!(
            from_cursor(&cursor),
            Some(("2026-01-01T00:00:00.000Z".to_string(), "abc".to_string()))
        );
        assert_eq!(from_cursor("not-a-cursor"), None);
        assert_eq!(from_cursor(&hex::encode("no bar")), None);
    }
}

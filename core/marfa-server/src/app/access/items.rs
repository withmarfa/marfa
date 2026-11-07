//! What a caller may do to items and what hangs from them.

use marfa_rules::catalog::Catalog as Rules;
use serde_json::{Value, json};

use super::{Axis, Caller, Level};
use crate::app::items::Writer;
use crate::app::refusal::{Code, Refusal, Result};

const MAX_WRITER_NAME: usize = 200;

/// A name held to what a history or a page may show: text a client chose
/// loses what would not print or would turn the line around it.
pub fn printable(name: &str) -> String {
    name.chars()
        .filter(|at| {
            !at.is_control() && !matches!(at, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(MAX_WRITER_NAME)
        .collect()
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

impl Caller {
    pub fn may_read_type(&self, name: &str) -> bool {
        self.level_on(Axis::Type, name) >= Level::Read
    }

    /// Who a version written by this caller names. The server's own work names
    /// no one, since no request asked for it.
    pub fn writer(&self) -> Option<Writer> {
        let writer = match self {
            Caller::Server => return None,
            Caller::Local => Writer {
                kind: "local".to_string(),
                id: "local".to_string(),
                name: "Local command".to_string(),
            },
            Caller::Key(key) => Writer {
                kind: "key".to_string(),
                id: key.id.clone(),
                name: printable(&key.label),
            },
            Caller::Owner(session) => Writer {
                kind: "browser".to_string(),
                id: session.id.clone(),
                name: printable(&session.name()),
            },
            Caller::App { key, grant } => Writer {
                kind: "app".to_string(),
                id: grant.grant_id.clone(),
                name: printable(&key.label),
            },
        };
        Some(writer)
    }

    /// What an `Idempotency-Key` is held under: tokens of one app and person
    /// are one credential.
    pub fn credential_handle(&self) -> String {
        match self {
            Caller::Local => "local".to_string(),
            Caller::Server => "server".to_string(),
            Caller::Key(key) if key.oauth_client_id.is_some() => key.source.clone(),
            Caller::Key(key) => key.id.clone(),
            Caller::App { key, .. } => key.source.clone(),
            Caller::Owner(session) => format!("owner:{}", session.id),
        }
    }

    /// Refuses a caller whose type map reaches no type, so that a read says
    /// nothing about what exists.
    pub fn require_reach(&self) -> Result<()> {
        match self {
            Caller::Key(key) | Caller::App { key, .. }
                if !key.grants.map(Axis::Type).grants_any() =>
            {
                Err(Refusal::new(
                    Code::TypeNotPermitted,
                    "This credential's type permissions reach no type, so there is nothing on \
                     the data plane it may read.",
                ))
            }
            _ => Ok(()),
        }
    }

    /// Refuses a caller whose type map does not reach `system.view` at write.
    pub fn require_view_write(&self) -> Result<()> {
        self.require_reach()?;
        self.require_type_map("system.view", Level::Write)
    }

    pub fn may_read_extension(&self, namespace: &str) -> bool {
        self.level_on(Axis::Extension, namespace) >= Level::Read
    }

    pub fn require_extension(&self, namespace: &str, level: Level) -> Result<()> {
        if self.level_on(Axis::Extension, namespace) >= level {
            return Ok(());
        }
        Err(Refusal::new(
            Code::Forbidden,
            format!(
                "No {} access to extension namespace \"{namespace}\"",
                level.word()
            ),
        )
        .with_detail(
            "grant",
            json!({ "kind": "extension", "name": namespace, "level": level.word() }),
        ))
    }

    /// The source a write that names none is stamped with.
    pub fn own_source(&self) -> &str {
        match self {
            Caller::Local | Caller::Owner(_) => "unknown",
            Caller::Server => "server",
            Caller::Key(key) | Caller::App { key, .. } => &key.source,
        }
    }

    pub fn default_tier(&self) -> Option<&str> {
        self.key().map(|key| key.default_tier.as_str())
    }

    fn lever(&self, lever: &str) -> Option<Value> {
        let levers = self.key()?.levers.as_ref()?.to_json();
        levers.get(lever).cloned()
    }

    /// Whether strict mode holds items of exactly `type_id` to what they
    /// declare.
    pub fn strict_on(&self, type_id: &str) -> bool {
        self.lever("strict_mode")
            .is_some_and(|block| list(&block, "types").iter().any(|held| held == type_id))
    }

    /// The sources a write of exactly `type_id` is held to, where a list is.
    pub fn allowed_sources(&self, type_id: &str) -> Option<Vec<String>> {
        let block = self.lever("source_allowlist")?;
        list(&block, "types")
            .iter()
            .any(|held| held == type_id)
            .then(|| list(&block, "sources"))
    }

    /// The sources a read that returns a set shows items of `type_id` under,
    /// where it is held to a list: a filter leaves out what its types cover
    /// and its sources do not name.
    pub fn listed_sources(&self, rules: &Rules, type_id: &str) -> Option<Vec<String>> {
        let block = self.lever("source_filter")?;
        list(&block, "types")
            .iter()
            .any(|held| rules.matches(held, type_id))
            .then(|| list(&block, "sources"))
    }

    /// Whether a read that returns a set shows an item of `type_id` under
    /// `source`.
    pub fn lists(&self, rules: &Rules, type_id: &str, source: &str) -> bool {
        self.listed_sources(rules, type_id)
            .is_none_or(|sources| sources.iter().any(|held| held == source))
    }
}

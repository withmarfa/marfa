use marfa_rules::catalog::Catalog as Rules;
use serde_json::json;

use super::levers::Holding;
use super::{Axis, Caller, Level};
use crate::app::items::Writer;
use crate::app::refusal::{Code, Refusal, Result};

const MAX_WRITER_NAME: usize = 200;

pub fn printable(name: &str) -> String {
    name.chars()
        .filter(|at| {
            !at.is_control() && !matches!(at, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(MAX_WRITER_NAME)
        .collect()
}

impl Caller {
    pub fn may_read_type(&self, name: &str) -> bool {
        self.level_on(Axis::Type, name) >= Level::Read
    }

    pub fn writer(&self) -> Option<Writer> {
        let writer = match self {
            Caller::Server => return None,
            Caller::Local(_) => Writer {
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

    /// Tokens of one app and person are one credential.
    pub fn credential_handle(&self) -> String {
        match self {
            Caller::Local(_) => "local".to_string(),
            Caller::Server => "server".to_string(),
            Caller::Key(key) if key.oauth_client_id.is_some() => key.source.clone(),
            Caller::Key(key) => key.id.clone(),
            Caller::App { key, .. } => key.source.clone(),
            Caller::Owner(session) => format!("owner:{}", session.id),
        }
    }

    /// Whether the type map grants `read` or `write` on at least one type.
    pub fn reaches_a_type(&self) -> bool {
        match self {
            Caller::Key(key) | Caller::App { key, .. } => key.grants.map(Axis::Type).grants_any(),
            _ => true,
        }
    }

    /// Whether the type map grants `write` on at least one type.
    pub fn writes_a_type(&self) -> bool {
        match self {
            Caller::Key(key) | Caller::App { key, .. } => key.grants.map(Axis::Type).grants_write(),
            _ => true,
        }
    }

    /// Refused so that a read says nothing about what exists.
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

    pub fn own_source(&self) -> &str {
        match self {
            Caller::Local(_) | Caller::Owner(_) => "unknown",
            Caller::Server => "server",
            Caller::Key(key) | Caller::App { key, .. } => &key.source,
        }
    }

    pub fn default_tier(&self) -> Option<&str> {
        self.key().map(|key| key.default_tier.as_str())
    }

    /// The server's own work answers to no lever: a job that could not see a row could never clear it.
    pub(super) fn holding(&self) -> &Holding {
        const NOTHING: &Holding = &Holding::NOTHING;
        match self {
            Caller::Local(standing) => standing.holding(),
            Caller::Owner(session) => session.standing.holding(),
            Caller::Key(key) | Caller::App { key, .. } => key.standing.holding(),
            Caller::Server => NOTHING,
        }
    }

    pub fn strict_on(&self, type_id: &str) -> bool {
        self.holding().strict_on(type_id)
    }

    pub fn allowed_sources(&self, type_id: &str) -> Option<Vec<String>> {
        self.holding()
            .allowed_sources(type_id)
            .map(<[String]>::to_vec)
    }

    pub fn listed_sources(&self, rules: &Rules, type_id: &str) -> Option<Vec<String>> {
        self.holding()
            .listed_sources(rules, type_id)
            .map(<[String]>::to_vec)
    }

    pub fn filters_sources(&self) -> bool {
        self.holding().filters_sources()
    }

    /// The source filter in one spelling for one effect, to tell whether it moved.
    pub fn source_filter_form(&self) -> serde_json::Value {
        self.holding().source_filter_form()
    }

    pub fn lists(&self, rules: &Rules, type_id: &str, source: &str) -> bool {
        self.holding()
            .listed_sources(rules, type_id)
            .is_none_or(|sources| sources.iter().any(|held| held == source))
    }
}

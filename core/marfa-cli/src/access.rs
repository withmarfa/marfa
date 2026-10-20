//! How access is read in the CLI's own words.
//!
//! The words are the ones every page of the server uses (`GLOSSARY.md`,
//! "Access words"); `ci/access-words.test.ts` holds these tables to it.

use serde_json::Value;

/// The word for each level.
pub const LEVELS: [(&str, &str); 3] = [
    ("none", "No access"),
    ("read", "Read only"),
    ("write", "Read and edit"),
];

/// The title of a row that is not one item type, by its pattern.
pub const ROWS: [(&str, &str); 11] = [
    ("*", "All your data"),
    ("content", "Your content"),
    ("user.*", "Your custom types"),
    ("edge.*", "Links between items"),
    ("profile", "Profile"),
    ("profile.name", "Name"),
    ("profile.email", "Email address"),
    ("profile.avatar", "Avatar"),
    ("metadata", "Definitions on your server"),
    ("metadata.types", "Custom data types"),
    ("metadata.edge_types", "Custom relationship types"),
];

/// The title of each named power, in the order a page lists them.
pub const POWERS: [(&str, &str); 12] = [
    ("keys.mint", "Make, see, edit and revoke keys"),
    ("keys.manage", "See, edit, narrow and revoke every key"),
    ("grants.manage", "See and disconnect other apps"),
    ("config.manage", "See and change Marfa's settings"),
    (
        "instance.read",
        "See health, metrics, storage and job status",
    ),
    (
        "instance.maintain",
        "Run housekeeping, reset platform types and cancel bulk jobs",
    ),
    ("schema.write", "Replace or remove type definitions"),
    (
        "blobs.manage",
        "Read and add any file, and manage file storage",
    ),
    (
        "webhooks.manage",
        "Manage webhooks that send events to other services",
    ),
    ("connectors.manage", "See, manage and remove all connectors"),
    ("audit.read", "Read the activity log"),
    ("items.purge", "Delete items in the trash for good"),
];

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Level {
    None,
    Read,
    Write,
}

impl Level {
    fn word(self) -> &'static str {
        let key = match self {
            Level::None => "none",
            Level::Read => "read",
            Level::Write => "write",
        };
        word(&LEVELS, key).unwrap_or(key)
    }

    fn parse(text: &str) -> Option<Level> {
        match text {
            "none" => Some(Level::None),
            "read" => Some(Level::Read),
            "write" => Some(Level::Write),
            _ => None,
        }
    }
}

fn word<'a>(table: &'a [(&str, &str)], key: &str) -> Option<&'a str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// What is held, row by row, in the order the pages list it: all data,
/// item types, links, definitions, the profile, then extension namespaces.
#[derive(Default)]
struct Held {
    rows: Vec<(u8, String, Level)>,
    powers: Vec<&'static str>,
}

impl Held {
    fn row(&mut self, group: u8, pattern: &str, level: Level) {
        match self.rows.iter_mut().find(|(_, held, _)| held == pattern) {
            Some((_, _, held)) => *held = (*held).max(level),
            None => self.rows.push((group, pattern.to_string(), level)),
        }
    }

    fn power(&mut self, name: &str) {
        if let Some((known, _)) = POWERS.iter().find(|(known, _)| *known == name)
            && !self.powers.contains(known)
        {
            self.powers.push(known);
        }
    }

    fn lines(mut self) -> Vec<String> {
        self.rows.sort_by_key(|(group, _, _)| *group);
        let rows: Vec<(String, &str)> = self
            .rows
            .iter()
            .map(|(_, pattern, level)| {
                let title = word(&ROWS, pattern).unwrap_or(pattern);
                (title.to_string(), level.word())
            })
            .collect();
        let width = rows.iter().map(|(title, _)| title.chars().count()).max();
        let mut lines: Vec<String> = rows
            .iter()
            .map(|(title, level)| {
                let pad = width.unwrap_or(0) - title.chars().count();
                format!("{title}{}  {level}", " ".repeat(pad))
            })
            .collect();
        let held: Vec<&str> = POWERS
            .iter()
            .filter(|(name, _)| self.powers.contains(name))
            .map(|(_, title)| *title)
            .collect();
        if !held.is_empty() {
            lines.push(format!("Powers: {}", held.join("; ")));
        }
        if lines.is_empty() {
            lines.push(word(&LEVELS, "none").unwrap_or("No access").to_string());
        }
        lines
    }
}

/// `first`, then each of `lines` beneath it indented two spaces.
pub fn indented(first: &str, lines: &[String]) -> String {
    let mut text = first.to_string();
    for line in lines {
        text.push_str("\n  ");
        text.push_str(line);
    }
    text
}

/// The group a pattern is listed in.
fn group_of(pattern: &str) -> u8 {
    if pattern == "*" || pattern == "content" {
        0
    } else if pattern.starts_with("edge.") {
        2
    } else if pattern == "metadata" || pattern.starts_with("metadata.") {
        3
    } else if pattern == "profile" || pattern.starts_with("profile.") {
        4
    } else {
        1
    }
}

/// Where a map's entry sits: its group and its pattern as the pages name it.
type PatternOf = fn(&str) -> (u8, String);

/// What a key holds, as the lines the CLI prints under it: `key` is the
/// record the server returns from `GET /keys` and `GET /keys/current`.
pub fn lines_for_key(key: &Value) -> Vec<String> {
    let mut held = Held::default();
    let maps: [(&str, PatternOf); 5] = [
        ("type_permissions", |name| {
            (group_of(name), name.to_string())
        }),
        ("edge_permissions", |name| (2, format!("edge.{name}"))),
        ("metadata_permissions", |name| {
            (
                3,
                if name == "*" {
                    "metadata".to_string()
                } else {
                    format!("metadata.{name}")
                },
            )
        }),
        ("profile_permissions", |name| {
            (
                4,
                if name == "*" {
                    "profile".to_string()
                } else {
                    format!("profile.{name}")
                },
            )
        }),
        ("extension_permissions", |name| (5, name.to_string())),
    ];
    for (field, pattern_of) in maps {
        let Some(map) = key.get(field).and_then(Value::as_object) else {
            continue;
        };
        for (name, level) in map {
            if let Some(level) = level.as_str().and_then(Level::parse) {
                let (group, pattern) = pattern_of(name);
                held.row(group, &pattern, level);
            }
        }
    }
    for name in key
        .get("permissions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        held.power(name);
    }
    held.lines()
}

/// What an OAuth scope string holds, as the lines the CLI prints under it.
/// A write literal is the level to edit, which includes reading; the
/// OpenID literals and `offline_access` are how the sign-in works and are
/// not access, so they are not printed.
pub fn lines_for_scope(scope: &str) -> Vec<String> {
    let mut held = Held::default();
    for literal in scope.split_whitespace() {
        match literal.rsplit_once(':') {
            Some((pattern, verb)) => {
                if let Some(level) = Level::parse(verb).filter(|l| *l != Level::None) {
                    held.row(group_of(pattern), pattern, level);
                }
            }
            None => held.power(literal),
        }
    }
    held.lines()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_key_with_mixed_scopes_reads_as_levels_and_powers() {
        let key = json!({
            "id": "k1",
            "permissions": ["audit.read", "keys.mint"],
            "type_permissions": {
                "core.note": "write",
                "core.task": "read",
                "core.event": "none",
            },
            "extension_permissions": { "app.cursor": "write" },
            "edge_permissions": { "parent-of": "read", "*": "write" },
            "metadata_permissions": { "types": "write" },
            "profile_permissions": { "name": "write", "email": "read" },
        });
        assert_eq!(
            lines_for_key(&key),
            [
                "core.note            Read and edit",
                "core.task            Read only",
                "core.event           No access",
                "edge.parent-of       Read only",
                "Links between items  Read and edit",
                "Custom data types    Read and edit",
                "Name                 Read and edit",
                "Email address        Read only",
                "app.cursor           Read and edit",
                "Powers: Make, see, edit and revoke keys; Read the activity log",
            ]
        );
    }

    #[test]
    fn all_data_comes_first_whatever_order_the_key_names_it() {
        let key = json!({
            "permissions": [],
            "type_permissions": { "core.note": "none", "*": "read" },
        });
        assert_eq!(
            lines_for_key(&key),
            ["All your data  Read only", "core.note      No access"]
        );
    }

    #[test]
    fn a_key_holding_nothing_has_no_access() {
        let key = json!({
            "permissions": [],
            "type_permissions": {},
            "extension_permissions": {},
            "edge_permissions": {},
            "metadata_permissions": {},
            "profile_permissions": {},
        });
        assert_eq!(lines_for_key(&key), ["No access"]);
    }

    #[test]
    fn an_app_scope_for_all_data_reads_as_one_row() {
        assert_eq!(
            lines_for_scope("openid offline_access *:read"),
            ["All your data  Read only"]
        );
    }

    #[test]
    fn an_app_scope_of_types_reads_as_a_row_for_each() {
        assert_eq!(
            lines_for_scope(
                "core.note:write core.task:read edge.parent-of:read profile.avatar:write keys.mint"
            ),
            [
                "core.note       Read and edit",
                "core.task       Read only",
                "edge.parent-of  Read only",
                "Avatar          Read and edit",
                "Powers: Make, see, edit and revoke keys",
            ]
        );
    }

    #[test]
    fn the_write_of_a_pattern_is_its_level_beside_its_read() {
        assert_eq!(
            lines_for_scope("core.note:read core.note:write"),
            ["core.note  Read and edit"]
        );
        assert_eq!(
            lines_for_scope("core.note:write core.note:read"),
            ["core.note  Read and edit"]
        );
    }

    #[test]
    fn mechanisms_alone_hold_no_access() {
        assert_eq!(
            lines_for_scope("openid profile email offline_access"),
            ["No access"]
        );
        assert_eq!(lines_for_scope(""), ["No access"]);
    }

    #[test]
    fn a_literal_the_words_do_not_know_is_named_as_it_is_written() {
        assert_eq!(
            lines_for_scope("metadata.widgets:read"),
            ["metadata.widgets  Read only"]
        );
    }
}

use serde_json::{Value, json};

use crate::app::refusal::{Refusal, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    None,
    Read,
    Write,
}

impl Level {
    /// Only `read` and `write` grant: any other stored level denies, ahead of a wider entry.
    fn stored(value: &Value) -> Level {
        match value.as_str() {
            Some("write") => Level::Write,
            Some("read") => Level::Read,
            _ => Level::None,
        }
    }

    pub const fn word(self) -> &'static str {
        match self {
            Level::None => "none",
            Level::Read => "read",
            Level::Write => "write",
        }
    }
}

const PROFILE_ROWS: [&str; 3] = ["name", "email", "avatar"];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Map(serde_json::Map<String, Value>);

impl Map {
    pub fn everything() -> Map {
        let mut entries = serde_json::Map::new();
        entries.insert("*".into(), Level::Write.word().into());
        Map(entries)
    }

    pub fn from_stored(entries: serde_json::Map<String, Value>) -> Map {
        Map(entries)
    }

    pub fn to_json(&self) -> Value {
        Value::Object(self.0.clone())
    }

    pub fn grants_any(&self) -> bool {
        self.0
            .values()
            .any(|level| Level::stored(level) > Level::None)
    }

    pub fn grants_write(&self) -> bool {
        self.0
            .values()
            .any(|level| Level::stored(level) == Level::Write)
    }

    fn exact(&self, name: &str) -> Option<Level> {
        self.0.get(name).map(Level::stored)
    }

    /// The exact entry, else the wildcard with the longest root, else `*`.
    /// `core.media.*` covers `core.media` itself.
    fn most_specific(&self, name: &str) -> Level {
        if let Some(level) = self.exact(name) {
            return level;
        }
        let mut root = name;
        loop {
            if let Some(level) = self.exact(&format!("{root}.*")) {
                return level;
            }
            match root.rfind('.') {
                Some(at) => root = &root[..at],
                None => return self.exact("*").unwrap_or(Level::None),
            }
        }
    }

    fn widest(&self, name: &str) -> Level {
        self.exact(name)
            .unwrap_or(Level::None)
            .max(self.exact("*").unwrap_or(Level::None))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    Type,
    Edge,
    Extension,
    Metadata,
    Profile,
}

impl Axis {
    pub const ALL: [Axis; 5] = [
        Axis::Type,
        Axis::Edge,
        Axis::Extension,
        Axis::Metadata,
        Axis::Profile,
    ];

    pub const fn field(self) -> &'static str {
        match self {
            Axis::Type => "type_permissions",
            Axis::Edge => "edge_permissions",
            Axis::Extension => "extension_permissions",
            Axis::Metadata => "metadata_permissions",
            Axis::Profile => "profile_permissions",
        }
    }

    pub fn level(self, map: &Map, name: &str) -> Level {
        match self {
            Axis::Type | Axis::Edge => map.most_specific(name),
            Axis::Extension => map
                .exact(name)
                .or_else(|| map.exact("*"))
                .unwrap_or(Level::None),
            Axis::Metadata => map.widest(name),
            Axis::Profile if name == "email" => map.widest(name).min(Level::Read),
            Axis::Profile if PROFILE_ROWS.contains(&name) => map.widest(name),
            Axis::Profile => Level::None,
        }
    }

    fn witnesses(self, held: &Map, wanted: &Map) -> Vec<String> {
        if self == Axis::Profile {
            return PROFILE_ROWS.map(str::to_string).to_vec();
        }
        let mut names = Vec::new();
        for name in wanted.0.keys().chain(held.0.keys()) {
            names.push(name.clone());
            if let Some(root) = name.strip_suffix(".*") {
                names.push(root.to_string());
            }
        }
        names
    }

    fn scope(self, name: &str, level: Level) -> String {
        let level = level.word();
        match self {
            Axis::Type | Axis::Extension => format!("{name}:{level}"),
            Axis::Edge => format!("edge.{name}:{level}"),
            Axis::Metadata if name == "*" => format!("metadata:{level}"),
            Axis::Metadata => format!("metadata.{name}:{level}"),
            Axis::Profile => format!("profile.{name}:{level}"),
        }
    }

    /// A denial in `held` beside its wildcard counts: `wanted` must carry it.
    pub fn first_beyond(self, held: &Map, wanted: &Map) -> Option<String> {
        self.witnesses(held, wanted).into_iter().find_map(|name| {
            let want = self.level(wanted, &name);
            (want > self.level(held, &name)).then(|| self.scope(&name, want))
        })
    }

    fn entry_problem(self, name: &str, level: &Value) -> Option<&'static str> {
        let word = level.as_str();
        match self {
            Axis::Type if !matches!(word, Some("read" | "write" | "none")) => {
                Some("The level must be read, write or none.")
            }
            Axis::Profile if name != "*" && !PROFILE_ROWS.contains(&name) => {
                Some("The name must be name, email, avatar or *.")
            }
            Axis::Profile if name == "email" && word != Some("read") => {
                Some("Only the owner can change email, so its level must be read.")
            }
            Axis::Edge | Axis::Extension | Axis::Metadata | Axis::Profile
                if !matches!(word, Some("read" | "write")) =>
            {
                Some("The level must be read or write.")
            }
            _ => None,
        }
    }

    pub fn from_body(self, value: &Value) -> Result<Map> {
        let field = self.field();
        let Value::Object(entries) = value else {
            return Err(entry_errors(vec![issue(
                field,
                "The field must be an object of names and levels.",
            )]));
        };
        let mut errors = Vec::new();
        for (name, level) in entries {
            if let Some(problem) = self.entry_problem(name, level) {
                errors.push(issue(&format!("{field}.{name}"), problem));
            }
        }
        if errors.is_empty() {
            Ok(Map(entries.clone()))
        } else {
            Err(entry_errors(errors))
        }
    }
}

fn issue(path: &str, message: &str) -> Value {
    json!({ "path": path, "message": message })
}

fn entry_errors(errors: Vec<Value>) -> Refusal {
    Refusal::validation("The permissions named are not valid.").with_detail("errors", errors)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(value: Value) -> Map {
        let Value::Object(entries) = value else {
            panic!("a test map is an object");
        };
        Map(entries)
    }

    #[test]
    fn a_type_is_decided_by_its_most_specific_entry() {
        let held = map(json!({
            "*": "read",
            "core.*": "write",
            "core.media.*": "none",
            "core.media.photo": "read",
            "core.note": "none",
            "user.odd": "admin",
        }));
        for (name, level) in [
            ("core.task", Level::Write),
            ("core", Level::Write),
            ("core.media", Level::None),
            ("core.media.video", Level::None),
            ("core.media.photo", Level::Read),
            ("core.media.photo.raw", Level::None),
            ("core.note", Level::None),
            ("core.notes", Level::Write),
            ("Core.task", Level::Read),
            ("system.folder", Level::Read),
            ("user.odd", Level::None),
            ("user.even", Level::Read),
        ] {
            assert_eq!(Axis::Type.level(&held, name), level, "{name}");
        }
    }

    #[test]
    fn a_wildcard_covers_names_and_not_a_shared_prefix() {
        let held = map(json!({ "core.media.*": "write" }));
        assert_eq!(Axis::Type.level(&held, "core.media"), Level::Write);
        assert_eq!(Axis::Type.level(&held, "core.media.a.b"), Level::Write);
        assert_eq!(Axis::Type.level(&held, "core.mediaset"), Level::None);
        assert_eq!(Axis::Type.level(&held, "core"), Level::None);
    }

    #[test]
    fn a_name_no_type_has_is_kept_and_covers_nothing() {
        let body = json!({
            "Core.Note": "read",
            "CORE.MEDIA.*": "none",
            "core.note?": "read",
            "core.media.*?": "read",
            "core.bookmark": "read",
        });
        let held = Axis::Type.from_body(&body).unwrap();
        for (name, level) in [
            ("core.bookmark", Level::Read),
            ("core.note", Level::None),
            ("core.media", Level::None),
            ("core.media.photo", Level::None),
        ] {
            assert_eq!(Axis::Type.level(&held, name), level, "{name}");
        }
        let withheld = json!({ "*": "read", "CORE.MEDIA.*": "none" });
        let held = Axis::Type.from_body(&withheld).unwrap();
        assert_eq!(Axis::Type.level(&held, "core.media.photo"), Level::Read);
    }

    #[test]
    fn an_extension_is_read_exactly_and_a_bad_level_denies_ahead_of_the_wildcard() {
        let held = map(json!({ "*": "write", "mine": "read", "bad": "admin", "a.*": "read" }));
        assert_eq!(Axis::Extension.level(&held, "mine"), Level::Read);
        assert_eq!(Axis::Extension.level(&held, "bad"), Level::None);
        assert_eq!(Axis::Extension.level(&held, "other"), Level::Write);
        let none = map(json!({ "a.*": "read" }));
        assert_eq!(Axis::Extension.level(&none, "a.b"), Level::None);
    }

    #[test]
    fn metadata_and_profile_take_the_wider_of_an_entry_and_the_wildcard() {
        let held = map(json!({ "*": "write", "types": "read" }));
        assert_eq!(Axis::Metadata.level(&held, "types"), Level::Write);
        assert_eq!(Axis::Profile.level(&held, "name"), Level::Write);
        assert_eq!(Axis::Profile.level(&held, "email"), Level::Read);
        assert_eq!(Axis::Profile.level(&held, "age"), Level::None);
    }

    #[test]
    fn the_first_grant_beyond_a_map_is_named() {
        for (axis, held, wanted, beyond) in [
            (
                Axis::Type,
                json!({"core.note":"read"}),
                json!({"*":"write"}),
                Some("*:write"),
            ),
            (
                Axis::Type,
                json!({"*":"read"}),
                json!({"core.note":"read"}),
                None,
            ),
            (
                Axis::Type,
                json!({"*":"read"}),
                json!({"core.note":"write"}),
                Some("core.note:write"),
            ),
            (
                Axis::Type,
                json!({"core.*":"write"}),
                json!({"core.note":"write","core.a.*":"read"}),
                None,
            ),
            (
                Axis::Type,
                json!({"*":"write","core.note":"none"}),
                json!({"*":"read"}),
                Some("core.note:read"),
            ),
            (
                Axis::Type,
                json!({"*":"write","core.note":"none"}),
                json!({"*":"read","core.note":"none"}),
                None,
            ),
            (
                Axis::Type,
                json!({"core.*":"read","core.media.*":"none"}),
                json!({"core.*":"read"}),
                Some("core.media.*:read"),
            ),
            (Axis::Type, json!({}), json!({"core.note":"none"}), None),
            (
                Axis::Type,
                json!({}),
                json!({"user.nothing-here":"read"}),
                Some("user.nothing-here:read"),
            ),
            (
                Axis::Edge,
                json!({"user.*":"read"}),
                json!({"user.blocks":"read"}),
                None,
            ),
            (
                Axis::Edge,
                json!({"about":"read"}),
                json!({"about":"write"}),
                Some("edge.about:write"),
            ),
            (
                Axis::Metadata,
                json!({"types":"write"}),
                json!({"*":"read"}),
                Some("metadata:read"),
            ),
            (
                Axis::Metadata,
                json!({"*":"write"}),
                json!({"types":"write"}),
                None,
            ),
            (
                Axis::Profile,
                json!({"name":"read"}),
                json!({"*":"read"}),
                Some("profile.email:read"),
            ),
            (
                Axis::Profile,
                json!({"*":"write"}),
                json!({"email":"read","avatar":"write"}),
                None,
            ),
            (
                Axis::Extension,
                json!({"mine":"read"}),
                json!({"theirs":"read"}),
                Some("theirs:read"),
            ),
        ] {
            assert_eq!(
                axis.first_beyond(&map(held.clone()), &map(wanted.clone()))
                    .as_deref(),
                beyond,
                "{held} against {wanted}"
            );
        }
    }

    #[test]
    fn a_map_in_a_body_is_judged_entry_by_entry() {
        let paths = |axis: Axis, value: Value| match axis.from_body(&value) {
            Ok(_) => Vec::new(),
            Err(refusal) => {
                let details = refusal.details.expect("details");
                details["errors"]
                    .as_array()
                    .expect("errors")
                    .iter()
                    .map(|issue| issue["path"].as_str().expect("path").to_string())
                    .collect()
            }
        };
        assert!(
            paths(
                Axis::Type,
                json!({"*":"none","core.*":"write","user.nothing-here":"read"})
            )
            .is_empty()
        );
        assert_eq!(
            paths(Axis::Type, json!({"core.note":"superadmin"})),
            ["type_permissions.core.note"]
        );
        assert!(paths(Axis::Type, json!({"Core.Note":"read","core.note?":"read"})).is_empty());
        assert_eq!(
            paths(Axis::Type, json!({"write":["*"]})),
            ["type_permissions.write"]
        );
        assert_eq!(paths(Axis::Type, json!(["*"])), ["type_permissions"]);
        assert_eq!(
            paths(Axis::Edge, json!({"about":"none"})),
            ["edge_permissions.about"]
        );
        assert_eq!(
            paths(Axis::Profile, json!({"email":"write"})),
            ["profile_permissions.email"]
        );
        assert_eq!(
            paths(Axis::Profile, json!({"age":"read"})),
            ["profile_permissions.age"]
        );
    }
}

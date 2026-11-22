//! The `connector` section of a plugin's bundle: the source its connector writes under, the
//! kinds it brings, the settings it reads, its sign-in and where it runs.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::schema::{Obj, Problem, icon_issue};

/// The longest source, as a key's own source is held.
pub const SOURCE_CAP: usize = 200;
/// The longest source name, setting label, kind name or setting name.
pub const LABEL_CAP: usize = 100;
pub const NAME_CAP: usize = 64;
/// What a source may not start with, ignoring case: the server keeps these for itself.
pub const RESERVED_SOURCE_PREFIXES: [&str; 3] = ["oauth:", "restored:", "connector-host:"];

const SECTION_KEYS: [&str; 7] = [
    "source",
    "source_name",
    "source_mark",
    "kinds",
    "settings",
    "sign_in",
    "runs",
];
const KIND_KEYS: [&str; 4] = ["name", "type", "direction", "default_mapping"];
const DIRECTIONS: [&str; 3] = ["in", "out", "both"];
const SETTING_KEYS: [&str; 7] = [
    "name", "label", "kind", "secret", "default", "required", "choices",
];
const SETTING_KINDS: [&str; 4] = ["text", "number", "boolean", "choice"];
const SIGN_IN_KEYS: [&str; 6] = [
    "kind",
    "provider",
    "scopes",
    "client_id_setting",
    "client_secret_setting",
    "token_setting",
];
const SIGN_IN_KINDS: [&str; 1] = ["oauth2"];
const PROVIDERS: [&str; 1] = ["google"];
const RUNS_KEYS: [&str; 1] = ["on"];
const RUNS_ON: [&str; 1] = ["host"];

fn fault(path: impl Into<String>, code: &'static str, message: impl Into<String>) -> Problem {
    Problem {
        path: path.into(),
        code,
        message: message.into(),
        hint: None,
    }
}

/// Whether `source` is one a key could hold as its own: no space at either end, 1 to 200
/// characters, no dot segment and no prefix the server keeps.
pub fn is_source(source: &str) -> bool {
    let lowered = source.to_ascii_lowercase();
    !source.is_empty()
        && source.trim() == source
        && source.chars().count() <= SOURCE_CAP
        && source != "."
        && source != ".."
        && !RESERVED_SOURCE_PREFIXES
            .iter()
            .any(|prefix| lowered.starts_with(prefix))
}

/// A setting's or a kind's name: lowercase letters, digits and underscores, starting with a letter.
pub fn is_identifier(name: &str) -> bool {
    name.len() <= NAME_CAP
        && name
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

struct Judge {
    faults: Vec<Problem>,
}

impl Judge {
    fn unknown_keys(&mut self, object: &Obj, path: &str, known: &[&str]) {
        for key in object.keys().filter(|key| !known.contains(&key.as_str())) {
            self.faults.push(fault(
                format!("{path}.{key}"),
                "validation_error",
                format!("A plugin's connector holds no {key} here"),
            ));
        }
    }

    fn missing(&mut self, path: String) {
        let named = path.rsplit('.').next().unwrap_or_default().to_string();
        self.faults.push(fault(
            path,
            "missing_required_field",
            format!("{named} is required"),
        ));
    }

    fn wrong(&mut self, path: String, message: impl Into<String>) {
        self.faults.push(fault(path, "validation_error", message));
    }

    fn text<'a>(&mut self, object: &'a Obj, path: &str, key: &str, cap: usize) -> Option<&'a str> {
        let at = format!("{path}.{key}");
        match object.get(key) {
            None => {
                self.missing(at);
                None
            }
            Some(Value::String(text)) if !text.trim().is_empty() && text.chars().count() <= cap => {
                Some(text)
            }
            Some(_) => {
                self.wrong(at, format!("{key} must be text of 1 to {cap} characters"));
                None
            }
        }
    }

    fn word<'a>(
        &mut self,
        object: &'a Obj,
        path: &str,
        key: &str,
        words: &[&str],
    ) -> Option<&'a str> {
        let at = format!("{path}.{key}");
        match object.get(key) {
            None => {
                self.missing(at);
                None
            }
            Some(Value::String(word)) if words.contains(&word.as_str()) => Some(word),
            Some(_) => {
                self.wrong(at, format!("{key} must be one of {}", words.join(", ")));
                None
            }
        }
    }

    fn identifier<'a>(&mut self, object: &'a Obj, path: &str, seen: &mut BTreeSet<&'a str>) {
        let at = format!("{path}.name");
        match object.get("name") {
            None => self.missing(at),
            Some(Value::String(name)) if is_identifier(name) => {
                if !seen.insert(name) {
                    self.wrong(at, format!("The connector names {name} more than once"));
                }
            }
            Some(_) => self.wrong(
                at,
                format!(
                    "name must be lowercase letters, digits and underscores, starting with a letter, at most {NAME_CAP} characters"
                ),
            ),
        }
    }

    fn flag(&mut self, object: &Obj, path: &str, key: &str, required: bool) -> bool {
        match object.get(key) {
            None if required => {
                self.missing(format!("{path}.{key}"));
                false
            }
            None => false,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => {
                self.wrong(
                    format!("{path}.{key}"),
                    format!("{key} must be true or false"),
                );
                false
            }
        }
    }

    fn list<'a>(
        &mut self,
        object: &'a Obj,
        path: &str,
        key: &str,
    ) -> Option<Vec<(String, &'a Obj)>> {
        let at = format!("{path}.{key}");
        let Some(Value::Array(entries)) = object.get(key) else {
            self.wrong(at, format!("{key} must be an array"));
            return None;
        };
        let mut held = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            let entry_path = format!("{at}.{index}");
            match entry.as_object() {
                Some(entry) => held.push((entry_path, entry)),
                None => self.wrong(entry_path, format!("Each entry of {key} must be an object")),
            }
        }
        Some(held)
    }

    fn kinds(&mut self, section: &Obj, types: Option<&BTreeSet<&str>>) {
        let path = "connector";
        if !section.contains_key("kinds") {
            self.missing(format!("{path}.kinds"));
            return;
        }
        let Some(kinds) = self.list(section, path, "kinds") else {
            return;
        };
        if kinds.is_empty() && section.get("kinds").is_some_and(Value::is_array) {
            self.wrong(format!("{path}.kinds"), "kinds must name at least one kind");
        }
        let mut seen = BTreeSet::new();
        for (at, kind) in kinds {
            self.unknown_keys(kind, &at, &KIND_KEYS);
            self.identifier(kind, &at, &mut seen);
            match kind.get("type") {
                None => self.missing(format!("{at}.type")),
                Some(Value::String(id)) => {
                    if types.is_some_and(|types| !types.contains(id.as_str())) {
                        self.wrong(
                            format!("{at}.type"),
                            format!("{id} is not one of the plugin's own types"),
                        );
                    }
                }
                Some(_) => self.wrong(format!("{at}.type"), "type must be a type identifier"),
            }
            self.word(kind, &at, "direction", &DIRECTIONS);
            if kind
                .get("default_mapping")
                .is_some_and(|held| !held.is_object())
            {
                self.wrong(
                    format!("{at}.default_mapping"),
                    "default_mapping must be an object",
                );
            }
        }
    }

    /// Each setting's name and whether it is secret, for the sign-in to name.
    fn settings<'a>(&mut self, section: &'a Obj) -> Vec<(&'a str, bool)> {
        let path = "connector";
        let mut declared = Vec::new();
        if !section.contains_key("settings") {
            return declared;
        }
        let Some(settings) = self.list(section, path, "settings") else {
            return declared;
        };
        let mut seen = BTreeSet::new();
        for (at, setting) in settings {
            self.unknown_keys(setting, &at, &SETTING_KEYS);
            self.identifier(setting, &at, &mut seen);
            self.text(setting, &at, "label", LABEL_CAP);
            let kind = self.word(setting, &at, "kind", &SETTING_KINDS);
            let secret = self.flag(setting, &at, "secret", false);
            self.flag(setting, &at, "required", true);
            let choices = self.choices(setting, &at, kind);
            if let Some(default) = setting.get("default") {
                let fits = match kind {
                    _ if secret => false,
                    Some("text") => default.is_string(),
                    Some("number") => default.is_number(),
                    Some("boolean") => default.is_boolean(),
                    Some("choice") => default.as_str().is_some_and(|word| choices.contains(&word)),
                    _ => true,
                };
                if !fits {
                    let said = if secret {
                        "A secret setting has no default: the owner sets it".to_string()
                    } else {
                        format!(
                            "default must be a {} the setting takes",
                            kind.unwrap_or("value")
                        )
                    };
                    self.wrong(format!("{at}.default"), said);
                }
            }
            if let Some(Value::String(name)) = setting.get("name") {
                declared.push((name.as_str(), secret));
            }
        }
        declared
    }

    fn choices<'a>(&mut self, setting: &'a Obj, at: &str, kind: Option<&str>) -> Vec<&'a str> {
        let path = format!("{at}.choices");
        match (kind, setting.get("choices")) {
            (Some("choice"), None) => {
                self.missing(path);
                Vec::new()
            }
            (Some("choice"), Some(Value::Array(choices))) => {
                let words: Vec<&str> = choices.iter().filter_map(Value::as_str).collect();
                let distinct: BTreeSet<&str> = words.iter().copied().collect();
                let good = !choices.is_empty()
                    && words.len() == choices.len()
                    && distinct.len() == words.len()
                    && words
                        .iter()
                        .all(|word| !word.trim().is_empty() && word.chars().count() <= LABEL_CAP);
                if !good {
                    self.wrong(
                        path,
                        format!("choices must list distinct text of 1 to {LABEL_CAP} characters"),
                    );
                }
                words
            }
            (Some("choice"), Some(_)) => {
                self.wrong(path, "choices must be an array");
                Vec::new()
            }
            (_, Some(_)) => {
                self.wrong(path, "Only a choice setting gives choices");
                Vec::new()
            }
            (_, None) => Vec::new(),
        }
    }

    fn sign_in(&mut self, section: &Obj, declared: &[(&str, bool)]) {
        let Some(held) = section.get("sign_in") else {
            return;
        };
        let at = "connector.sign_in".to_string();
        let Some(sign_in) = held.as_object() else {
            self.wrong(at, "sign_in must be an object");
            return;
        };
        self.unknown_keys(sign_in, &at, &SIGN_IN_KEYS);
        self.word(sign_in, &at, "kind", &SIGN_IN_KINDS);
        self.word(sign_in, &at, "provider", &PROVIDERS);
        match sign_in.get("scopes") {
            None => self.missing(format!("{at}.scopes")),
            Some(Value::Array(scopes))
                if scopes
                    .iter()
                    .all(|scope| scope.as_str().is_some_and(|text| !text.trim().is_empty())) => {}
            Some(_) => self.wrong(format!("{at}.scopes"), "scopes must list text"),
        }
        for (key, secret) in [
            ("client_id_setting", false),
            ("client_secret_setting", true),
            ("token_setting", true),
        ] {
            let path = format!("{at}.{key}");
            match sign_in.get(key) {
                None => self.missing(path),
                Some(Value::String(name)) => match declared.iter().find(|(held, _)| held == name) {
                    None => self.wrong(
                        path,
                        format!("{key} names {name}, which the connector does not declare"),
                    ),
                    Some((_, held_secret)) if secret && !held_secret => self.wrong(
                        path,
                        format!("{key} names {name}, which must be a secret setting"),
                    ),
                    Some(_) => {}
                },
                Some(_) => self.wrong(path, format!("{key} must name a setting")),
            }
        }
    }

    fn runs(&mut self, section: &Obj) {
        let at = "connector.runs".to_string();
        match section.get("runs") {
            None => self.missing(at),
            Some(Value::Object(runs)) => {
                self.unknown_keys(runs, &at, &RUNS_KEYS);
                self.word(runs, &at, "on", &RUNS_ON);
            }
            Some(_) => self.wrong(at, "runs must be an object"),
        }
    }
}

/// What is wrong with a `connector` section. `types` holds the bundle's own type ids, which a
/// kind must name; `None` leaves that unjudged, as for a source folder's `plugin.json`.
pub fn connector_faults(section: &Obj, types: Option<&BTreeSet<&str>>) -> Vec<Problem> {
    let mut judge = Judge { faults: Vec::new() };
    judge.unknown_keys(section, "connector", &SECTION_KEYS);
    match section.get("source") {
        None => judge.missing("connector.source".into()),
        Some(Value::String(source)) if is_source(source) => {}
        Some(_) => judge.wrong(
            "connector.source".into(),
            format!(
                "source must be 1 to {SOURCE_CAP} characters with no space at either end, not . or .., and not start with {}",
                RESERVED_SOURCE_PREFIXES.join(", ")
            ),
        ),
    }
    judge.text(section, "connector", "source_name", LABEL_CAP);
    if let Some(mark) = section.get("source_mark")
        && let Some(issue) = icon_issue(Some(mark), "source_mark")
    {
        judge.faults.push(fault(
            "connector.source_mark",
            "validation_error",
            issue.message(),
        ));
    }
    judge.kinds(section, types);
    let declared = judge.settings(section);
    judge.sign_in(section, &declared);
    judge.runs(section);
    judge.faults
}

/// The source a checked connector section writes under.
pub fn source(section: &Obj) -> Option<&str> {
    section.get("source").and_then(Value::as_str)
}

/// The type of each kind a checked connector section brings, each once.
pub fn kind_types(section: &Obj) -> Vec<&str> {
    let mut types: Vec<&str> = section
        .get("kinds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|kind| kind.get("type").and_then(Value::as_str))
        .collect();
    types.sort_unstable();
    types.dedup();
    types
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn section(value: Value) -> Obj {
        value.as_object().cloned().unwrap()
    }

    fn base() -> Value {
        json!({
            "source": "rss",
            "source_name": "RSS",
            "kinds": [{ "name": "entry", "type": "rss.entry", "direction": "in" }],
            "runs": { "on": "host" },
        })
    }

    fn paths(value: Value) -> Vec<String> {
        let types: BTreeSet<&str> = ["rss.entry"].into_iter().collect();
        connector_faults(&section(value), Some(&types))
            .into_iter()
            .map(|problem| problem.path)
            .collect()
    }

    #[test]
    fn a_well_formed_section_has_no_fault() {
        assert!(paths(base()).is_empty());
        let mut full = base();
        full["source_mark"] = json!("lucide:rss");
        full["settings"] = json!([
            { "name": "url", "label": "URL", "kind": "text", "required": true },
            { "name": "every", "label": "Every", "kind": "number", "default": 5, "required": false },
            { "name": "order", "label": "Order", "kind": "choice", "choices": ["a", "b"], "default": "a", "required": false },
            { "name": "id", "label": "ID", "kind": "text", "required": false },
            { "name": "secret", "label": "Secret", "kind": "text", "secret": true, "required": false },
            { "name": "token", "label": "Token", "kind": "text", "secret": true, "required": false },
        ]);
        full["sign_in"] = json!({
            "kind": "oauth2", "provider": "google", "scopes": ["a"],
            "client_id_setting": "id", "client_secret_setting": "secret", "token_setting": "token",
        });
        assert!(paths(full).is_empty());
    }

    #[test]
    fn each_fault_names_its_path() {
        let mut odd = base();
        odd["extra"] = json!(1);
        odd["runs"] = json!({ "on": "host", "where": "mac" });
        odd["kinds"] = json!([
            { "name": "entry", "type": "core.note", "direction": "in" },
            { "name": "entry", "type": "rss.entry", "direction": "up", "default_mapping": [] },
        ]);
        let found = paths(odd);
        for path in [
            "connector.extra",
            "connector.runs.where",
            "connector.kinds.0.type",
            "connector.kinds.1.name",
            "connector.kinds.1.direction",
            "connector.kinds.1.default_mapping",
        ] {
            assert!(found.iter().any(|held| held == path), "{path}: {found:?}");
        }
        let mut empty = base();
        empty["kinds"] = json!([]);
        assert_eq!(paths(empty), ["connector.kinds"]);
    }

    #[test]
    fn a_source_follows_a_keys_rules() {
        for (source, good) in [
            ("rss", true),
            ("Restored:x", false),
            ("OAUTH:x", false),
            ("connector-host:x", false),
            (" rss", false),
            ("", false),
            ("..", false),
        ] {
            let mut held = base();
            held["source"] = json!(source);
            assert_eq!(paths(held).is_empty(), good, "{source}");
        }
        assert!(is_source(&"s".repeat(SOURCE_CAP)));
        assert!(!is_source(&"s".repeat(SOURCE_CAP + 1)));
    }

    #[test]
    fn a_settings_default_fits_its_kind_and_a_secret_has_none() {
        for (setting, path) in [
            (
                json!({ "name": "a", "label": "A", "kind": "number", "default": "5", "required": false }),
                "connector.settings.0.default",
            ),
            (
                json!({ "name": "a", "label": "A", "kind": "text", "secret": true, "default": "x", "required": false }),
                "connector.settings.0.default",
            ),
            (
                json!({ "name": "a", "label": "A", "kind": "choice", "required": false }),
                "connector.settings.0.choices",
            ),
            (
                json!({ "name": "a", "label": "A", "kind": "text", "choices": ["x"], "required": false }),
                "connector.settings.0.choices",
            ),
            (
                json!({ "name": "A", "label": "A", "kind": "text", "required": false }),
                "connector.settings.0.name",
            ),
        ] {
            let mut held = base();
            held["settings"] = json!([setting]);
            assert_eq!(paths(held), [path]);
        }
    }

    #[test]
    fn a_sign_in_names_declared_settings_and_secrets() {
        let mut held = base();
        held["settings"] = json!([
            { "name": "id", "label": "ID", "kind": "text", "required": false },
            { "name": "token", "label": "Token", "kind": "text", "required": false },
        ]);
        held["sign_in"] = json!({
            "kind": "oauth2", "provider": "google", "scopes": [],
            "client_id_setting": "id", "client_secret_setting": "gone", "token_setting": "token",
        });
        assert_eq!(
            paths(held),
            [
                "connector.sign_in.client_secret_setting",
                "connector.sign_in.token_setting"
            ]
        );
    }

    #[test]
    fn a_folder_manifest_leaves_kind_types_unjudged() {
        let mut odd = base();
        odd["kinds"][0]["type"] = json!("elsewhere.entry");
        assert!(connector_faults(&section(odd), None).is_empty());
        assert_eq!(kind_types(&section(base())), ["rss.entry"]);
        assert_eq!(source(&section(base())), Some("rss"));
    }
}

use std::collections::HashSet;
use std::sync::OnceLock;

use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};

use super::App;
use super::access::Caller;
use super::items::reading;
use super::oauth::grants;
use super::query;
use super::refusal::{Code, Refusal, Result};

const MAX_LENGTH: usize = 200;
const RESTORED: &str = "restored:";
const ICON_SETS: [(&str, &str); 2] = [
    (
        "lucide",
        include_str!("../../../../packages/types/generated/icon-set-lucide.json"),
    ),
    (
        "simple-icons",
        include_str!("../../../../packages/types/generated/icon-set-simple-icons.json"),
    ),
];

pub const FIELDS: [&str; 2] = ["name", "mark"];

pub fn length(text: &str) -> usize {
    text.chars().count()
}

pub fn check_code(code: &str) -> Result<()> {
    let short = |text: &str| length(text) <= MAX_LENGTH;
    if !code.is_empty()
        && code.trim() == code
        && (short(code) || code.strip_prefix(RESTORED).is_some_and(short))
    {
        Ok(())
    } else {
        Err(Refusal::validation("source is not a source code."))
    }
}

pub(crate) fn hidden(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
        )
}

fn icons() -> &'static HashSet<String> {
    static ICONS: OnceLock<HashSet<String>> = OnceLock::new();
    ICONS.get_or_init(|| {
        let mut icons = HashSet::new();
        for (set, text) in ICON_SETS {
            let listed: Value = serde_json::from_str(text).unwrap_or_default();
            let names = listed["icons"].as_array().map_or(&[][..], Vec::as_slice);
            icons.extend(
                names
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|name| format!("{set}:{name}")),
            );
        }
        icons
    })
}

#[derive(Debug)]
pub struct Change {
    name: Option<Option<String>>,
    mark: Option<Option<String>>,
    fields: Vec<String>,
}

fn name(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        return Ok(None);
    }
    let refused = || Refusal::validation("name must be text of 1 to 200 characters to show.");
    let trimmed = value.as_str().ok_or_else(refused)?.trim();
    if trimmed.is_empty() || length(trimmed) > MAX_LENGTH || trimmed.chars().any(hidden) {
        return Err(refused());
    }
    Ok(Some(trimmed.to_string()))
}

fn mark(value: &Value) -> Result<Option<String>> {
    match value {
        Value::Null => Ok(None),
        Value::String(icon) if icons().contains(icon) => Ok(Some(icon.clone())),
        _ => Err(Refusal::new(
            Code::InvalidSchema,
            "mark must be an icon ID from the pinned sets.",
        )
        .with_detail(
            "errors",
            json!([{ "path": "mark", "message": "Not an icon ID from the pinned sets." }]),
        )),
    }
}

impl Change {
    pub fn from_body(body: &Map<String, Value>) -> Result<Change> {
        Ok(Change {
            name: body.get("name").map(name).transpose()?,
            mark: body.get("mark").map(mark).transpose()?,
            fields: body.keys().cloned().collect(),
        })
    }
}

type Set = (Option<String>, Option<String>);

fn set_on(tx: &Transaction<'_>, code: &str) -> Result<Set> {
    Ok(tx
        .query_row(
            "SELECT name, mark FROM source_names WHERE source = ?1",
            [code],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or_default())
}

fn describe(tx: &Transaction<'_>, code: &str, at: &str) -> Result<Value> {
    let (name, mark) = set_on(tx, code)?;
    let label: Option<String> = tx
        .query_row(
            "SELECT label FROM api_keys WHERE source = ?1 AND revoked_at IS NULL \
             AND (expires_at IS NULL OR expires_at > ?2)",
            [code, at],
            |row| row.get(0),
        )
        .optional()?;
    let (name, name_from) = match (name, grants::name_of_source(tx, code)?, label) {
        (Some(name), _, _) => (name, "set"),
        (None, Some(app), _) => (app, "app"),
        (None, None, Some(label)) => (label, "key"),
        (None, None, None) => (code.to_string(), "code"),
    };
    let mut out = Map::new();
    out.insert("source".into(), code.into());
    out.insert("name".into(), name.into());
    out.insert("name_from".into(), name_from.into());
    if let Some(mark) = mark {
        out.insert("mark".into(), mark.into());
    }
    Ok(Value::Object(out))
}

fn held(tx: &Transaction<'_>, at: &str) -> Result<Vec<String>> {
    let mut codes: Vec<String> = tx
        .prepare(
            "SELECT source FROM source_names \
             UNION SELECT source FROM api_keys \
             WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?1) \
             UNION SELECT s.source FROM api_key_sources s JOIN api_keys k ON k.id = s.key_id \
             WHERE k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?1)",
        )?
        .query_map([at], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let apps = grants::all_of_owner(tx)?;
    codes.extend(
        apps.iter()
            .map(|consent| grants::source_of(&consent.client_id, &consent.user_id)),
    );
    Ok(codes)
}

pub async fn list(app: &App, caller: &Caller) -> Result<Vec<Value>> {
    let at = app.clock.stamp();
    reading(app, caller, move |read| {
        let mut codes = query::carried(read)?;
        codes.extend(
            held(read.tx, &at)?
                .into_iter()
                .filter(|code| read.caller.sees_source(code)),
        );
        codes
            .iter()
            .map(|code| describe(read.tx, code, &at))
            .collect()
    })
    .await
}

pub async fn read(app: &App, caller: &Caller, code: String) -> Result<Value> {
    let at = app.clock.stamp();
    reading(app, caller, move |read| {
        if read.caller.sees_source(&code) || query::carries(read, &code)? {
            describe(read.tx, &code, &at)
        } else {
            Err(Refusal::new(
                Code::SourceNotFound,
                format!("No source {code} is visible to this credential."),
            ))
        }
    })
    .await
}

pub async fn update(app: &App, caller: &Caller, code: String, change: Change) -> Result<Value> {
    app.write(caller, "source.update", move |unit| {
        unit.caller.require_may_name(&code)?;
        let tx = unit.tx();
        let (name, mark) = set_on(tx, &code)?;
        let name = change.name.unwrap_or(name);
        let mark = change.mark.unwrap_or(mark);
        if name.is_none() && mark.is_none() {
            tx.execute("DELETE FROM source_names WHERE source = ?1", [&code])?;
        } else {
            tx.execute(
                "INSERT INTO source_names (source, name, mark, updated_at) \
                 VALUES (?1, ?2, ?3, ?4) ON CONFLICT (source) DO UPDATE SET \
                 name = excluded.name, mark = excluded.mark, updated_at = excluded.updated_at",
                params![code, name, mark, unit.at],
            )?;
        }
        unit.audit("source", &code, Some(json!({ "fields": change.fields })))?;
        describe(tx, &code, &unit.at)
    })
    .await
}

/// A source's name and mark, where either is set.
pub(crate) struct Named {
    pub source: String,
    pub name: Option<String>,
    pub mark: Option<String>,
}

/// Every source with a name or a mark set, by code.
pub(crate) fn named(tx: &Transaction<'_>) -> Result<Vec<Named>> {
    let mut statement =
        tx.prepare_cached("SELECT source, name, mark FROM source_names ORDER BY source")?;
    let rows = statement.query_map([], |row| {
        Ok(Named {
            source: row.get(0)?,
            name: row.get(1)?,
            mark: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A `source` line of an archive, under the code its rows are restored with.
#[derive(Clone, Debug)]
pub struct Archived {
    line: String,
    source: String,
    name: Option<String>,
    mark: Option<String>,
    unknown_mark: bool,
}

fn damaged(what: String) -> Refusal {
    Refusal::new(Code::InvalidSchema, format!("The archive carries {what}."))
}

/// Reads a `source` line, refusing one that is damaged; a mark outside the pinned sets is
/// kept to be skipped and counted.
pub fn archived(value: &Value, restored: impl Fn(&str) -> String) -> Result<Archived> {
    let line = value
        .as_object()
        .ok_or_else(|| damaged("a source line that is not an object".into()))?;
    let code = line
        .get("source")
        .and_then(Value::as_str)
        .ok_or_else(|| damaged("a source line with no source code".into()))?;
    let source = restored(code);
    if check_code(code).is_err() || check_code(&source).is_err() {
        return Err(damaged(format!("a source line with an invalid code: {code}")));
    }
    let name = match line.get("name") {
        None | Some(Value::Null) => None,
        Some(Value::String(held)) if name(&Value::from(held.as_str())).ok().flatten().as_deref() == Some(held) => {
            Some(held.clone())
        }
        Some(_) => return Err(damaged(format!("an invalid name for source {code}"))),
    };
    let (mark, unknown_mark) = match line.get("mark") {
        None | Some(Value::Null) => (None, false),
        Some(Value::String(held)) => (Some(held.clone()), !icons().contains(held)),
        Some(_) => return Err(damaged(format!("an invalid mark for source {code}"))),
    };
    if name.is_none() && mark.is_none() {
        return Err(damaged(format!("a source line for {code} with neither a name nor a mark")));
    }
    Ok(Archived {
        line: code.to_string(),
        source,
        name,
        mark,
        unknown_mark,
    })
}

/// What a restore did with the archive's source lines.
#[derive(Debug, Default)]
pub struct Restored {
    pub added: usize,
    pub skipped: usize,
    pub reasons: std::collections::BTreeMap<String, usize>,
}

impl Restored {
    fn skip(&mut self, reason: &str) {
        self.skipped += 1;
        *self.reasons.entry(reason.to_string()).or_default() += 1;
    }
}

/// Names each source the instance names nothing for. Where two lines land on one code, the
/// line that carries it wins; a repeated line refuses the archive.
pub fn restore(tx: &Transaction<'_>, at: &str, lines: &[Archived]) -> Result<Restored> {
    let mut restored = Restored::default();
    let mut read = HashSet::new();
    let mut chosen: Vec<&Archived> = Vec::new();
    for line in lines {
        if !read.insert(line.line.as_str()) {
            return Err(Refusal::validation(format!(
                "The archive carries more than one name for source {}.",
                line.line
            )));
        }
        match chosen.iter().position(|held| held.source == line.source) {
            None => chosen.push(line),
            Some(at) => {
                restored.skip("duplicate_code");
                if line.line == line.source {
                    chosen[at] = line;
                }
            }
        }
    }
    for line in chosen {
        if line.unknown_mark {
            restored.skip("unknown_mark");
            continue;
        }
        if set_on(tx, &line.source)? != (None, None) {
            restored.skip("already_set");
            continue;
        }
        tx.execute(
            "INSERT INTO source_names (source, name, mark, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![line.source, line.name, line.mark, at],
        )?;
        restored.added += 1;
    }
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_holds_what_the_instance_can() {
        for (code, ok) in [
            ("github", true),
            ("..", true),
            ("a/b?c#d", true),
            ("", false),
            (" padded", false),
            ("padded ", false),
        ] {
            assert_eq!(check_code(code).is_ok(), ok, "{code:?}");
        }
        assert!(check_code(&"x".repeat(200)).is_ok());
        assert!(check_code(&"x".repeat(201)).is_err());
        assert!(check_code(&format!("restored:{}", "x".repeat(200))).is_ok());
        assert!(check_code(&format!("restored:{}", "x".repeat(201))).is_err());
    }

    #[test]
    fn a_name_is_trimmed_and_holds_nothing_hidden() {
        assert_eq!(
            name(&json!("  GitHub ")).unwrap().as_deref(),
            Some("GitHub")
        );
        assert_eq!(name(&Value::Null).unwrap(), None);
        assert!(name(&json!(&"😀".repeat(200))).is_ok());
        for bad in [
            json!("   "),
            json!(5),
            json!("a\u{0007}b"),
            json!("a\u{007f}b"),
            json!("a\u{0085}b"),
            json!("a\u{202e}b"),
            json!("a\u{200f}b"),
            json!("a\u{061c}b"),
            json!("a\u{2068}b"),
            json!("😀".repeat(201)),
        ] {
            assert!(name(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_mark_comes_from_the_pinned_sets() {
        assert!(mark(&json!("simple-icons:github")).is_ok());
        assert!(mark(&json!("lucide:calendar")).is_ok());
        assert_eq!(mark(&Value::Null).unwrap(), None);
        for bad in [
            "calendar",
            "lucide:no-such-icon",
            "emoji:calendar",
            " lucide:calendar",
        ] {
            let refusal = mark(&json!(bad)).unwrap_err();
            assert_eq!(refusal.code, Code::InvalidSchema, "{bad}");
        }
    }
}

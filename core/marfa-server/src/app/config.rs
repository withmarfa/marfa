//! The instance's configuration: its display name, its enforcement levers and
//! every stored setting, read and written as one body.
//!
//! A field is a stored setting when the registry holds its key. `name` and
//! `enforcement` are the two the registry does not hold, and so are stored here.

use std::collections::BTreeMap;
use std::sync::Arc;

use rusqlite::Transaction;
use serde_json::{Map, Value, json};

use super::access::{Caller, Levers};
use super::addresses;
use super::consequences::{self, Consequence};
use super::refusal::{Code, Refusal, Result};
use super::sources;
use super::{App, instance, stored};
use crate::settings::Snapshot;
use crate::settings::registry::{ADDRESSES, ENTRIES, Entry, SIGN_IN_ADDRESS};
use crate::settings::together::{self, Breach};

const ENFORCEMENT_ROW: &str = "enforcement";
const MAX_NAME: usize = 200;
const CONFIRMATION: &str = "confirm_sign_in_address_change";

/// How a write treats what its body leaves out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The body is the whole configuration: what it leaves out is removed.
    Put,
    /// The body changes what it names, and a `null` removes.
    Patch,
}

#[derive(Debug)]
enum Ask<T> {
    Set(T),
    Clear,
}

/// The fields a `/config` body may name.
pub fn fields() -> Vec<&'static str> {
    let mut names = vec!["instance_id", "name", "enforcement", CONFIRMATION];
    names.extend(ENTRIES.iter().map(|entry| entry.key));
    names
}

/// The fields an address check may name.
pub const CHECK_FIELDS: [&str; 2] = ["sign_in_address", "addresses"];

/// What a body asks for, once its shape has been judged.
#[derive(Debug)]
pub struct Request {
    mode: Mode,
    instance_id: Option<String>,
    confirmed: bool,
    settings: Vec<(&'static Entry, Ask<String>)>,
    name: Option<Ask<String>>,
    enforcement: Option<Ask<Levers>>,
}

fn invalid(errors: Vec<(String, String)>) -> Refusal {
    let errors: Vec<_> = errors
        .into_iter()
        .map(|(path, message)| json!({ "path": path, "message": message }))
        .collect();
    Refusal::validation("The configuration is not valid.").with_detail("errors", errors)
}

fn unknown_fields(body: &Map<String, Value>, allowed: &[&str]) -> Result<()> {
    let mut unknown: Vec<String> = body
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .cloned()
        .collect();
    if allowed.contains(&"enforcement")
        && let Some(block) = body.get("enforcement")
    {
        unknown.extend(Levers::unknown_names(block, "enforcement"));
    }
    if unknown.is_empty() {
        return Ok(());
    }
    unknown.sort_unstable();
    Err(Refusal::validation(format!(
        "The body names fields this operation does not take: {}.",
        unknown.join(", ")
    ))
    .with_detail("unknown_body_fields", unknown))
}

fn checked_name(text: &str) -> std::result::Result<String, String> {
    let rule =
        "must be 1 to 200 characters, without control or bidirectional formatting characters";
    let trimmed = text.trim();
    if text.chars().any(sources::hidden) || trimmed.is_empty() || trimmed.chars().count() > MAX_NAME
    {
        return Err(rule.to_string());
    }
    Ok(trimmed.to_string())
}

/// A lever refusal carries its paths already; a missing member is answered
/// whole, by the path of the member.
fn lever_errors(refusal: Refusal) -> Result<Vec<(String, String)>> {
    if refusal.code == Code::MissingRequiredField {
        let field = refusal
            .details
            .as_ref()
            .and_then(|details| details.get("field"))
            .and_then(Value::as_str)
            .unwrap_or("enforcement")
            .to_string();
        return Err(
            Refusal::new(Code::MissingRequiredField, format!("{field} is required"))
                .with_detail("field", field),
        );
    }
    let listed = refusal
        .details
        .as_ref()
        .and_then(|details| details.get("errors"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            Some((
                entry.get("path")?.as_str()?.to_string(),
                entry.get("message")?.as_str()?.to_string(),
            ))
        })
        .collect();
    Ok(listed)
}

impl Request {
    /// Reads a body for `fields`, naming every field it cannot accept.
    /// Unknown names come first, then the shape of each field. A lever lacking
    /// a member is answered at once.
    pub fn from_body(mode: Mode, body: &Map<String, Value>, allowed: &[&str]) -> Result<Request> {
        unknown_fields(body, allowed)?;
        let mut errors = Vec::new();
        let mut request = Request {
            mode,
            instance_id: None,
            confirmed: false,
            settings: Vec::new(),
            name: None,
            enforcement: None,
        };
        let null_in_put = |path: &str| {
            (
                path.to_string(),
                "must not be null in a PUT; leave it out to remove it".to_string(),
            )
        };
        for (field, value) in body {
            let field = field.as_str();
            match field {
                "instance_id" => match value.as_str().filter(|id| !id.is_empty()) {
                    Some(id) => request.instance_id = Some(id.to_string()),
                    None => errors.push((field.to_string(), "must be the instance's id".into())),
                },
                CONFIRMATION => match value.as_bool() {
                    Some(flag) => request.confirmed = flag,
                    None => errors.push((field.to_string(), "must be true or false".into())),
                },
                "name" => match (value, mode) {
                    (Value::Null, Mode::Patch) => request.name = Some(Ask::Clear),
                    (Value::Null, Mode::Put) => errors.push(null_in_put(field)),
                    (Value::String(text), _) => match checked_name(text) {
                        Ok(name) => request.name = Some(Ask::Set(name)),
                        Err(rule) => errors.push((field.to_string(), rule)),
                    },
                    _ => errors.push((
                        field.to_string(),
                        "must be text of 1 to 200 characters".into(),
                    )),
                },
                "enforcement" => match (value, mode) {
                    (Value::Null, Mode::Patch) => request.enforcement = Some(Ask::Clear),
                    (Value::Null, Mode::Put) => errors.push(null_in_put(field)),
                    _ => match Levers::from_body_at(value, "enforcement") {
                        Ok(levers) => request.enforcement = Some(Ask::Set(levers)),
                        Err(refusal) => errors.extend(lever_errors(refusal)?),
                    },
                },
                key => {
                    let Some(entry) = ENTRIES.iter().find(|entry| entry.key == key) else {
                        continue;
                    };
                    match (value, mode) {
                        (Value::Null, Mode::Patch) => request.settings.push((entry, Ask::Clear)),
                        (Value::Null, Mode::Put) => errors.push(null_in_put(key)),
                        _ => match entry.row_text_of_json(value) {
                            Ok(text) if text.is_empty() => {
                                request.settings.push((entry, Ask::Clear));
                            }
                            Ok(text) => request.settings.push((entry, Ask::Set(text))),
                            Err(rule) => errors.push((key.to_string(), rule)),
                        },
                    }
                }
            }
        }
        if errors.is_empty() {
            errors.sort();
            Ok(request)
        } else {
            errors.sort();
            Err(invalid(errors))
        }
    }

    /// Refuses a body that names another instance than this one.
    pub fn check_identity(&self, app: &App) -> Result<()> {
        match &self.instance_id {
            Some(id) if *id != app.instance_id => Err(invalid(vec![(
                "instance_id".to_string(),
                format!("is not this instance's id, which is {}", app.instance_id),
            )])),
            _ => Ok(()),
        }
    }

    fn names(&self, key: &str) -> bool {
        self.settings.iter().any(|(entry, _)| entry.key == key)
    }

    fn field_names(&self) -> Vec<&'static str> {
        let mut named: Vec<_> = self.settings.iter().map(|(entry, _)| entry.key).collect();
        named.extend(self.name.as_ref().map(|_| "name"));
        named.extend(self.enforcement.as_ref().map(|_| "enforcement"));
        named.sort_unstable();
        named
    }
}

type Rows = BTreeMap<String, String>;

/// The change a request makes to the table, judged and not yet written.
struct Plan {
    /// Each setting's row to write: its text, or none to remove it.
    ops: Vec<(String, Option<String>)>,
    name: Option<Option<String>>,
    touched: Vec<&'static str>,
    before: Rows,
    after: Rows,
}

fn rows_of(rows: Vec<(String, String)>) -> Rows {
    rows.into_iter().collect()
}

fn pairs(rows: &Rows) -> Vec<(String, String)> {
    rows.iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

impl Plan {
    fn of(request: &Request, before: Rows) -> Plan {
        let mut ops: BTreeMap<String, Option<String>> = BTreeMap::new();
        let mut touched: Vec<&'static str> = Vec::new();
        if request.mode == Mode::Put {
            for entry in ENTRIES {
                ops.insert(entry.key.to_string(), None);
                touched.push(entry.key);
            }
            ops.insert(ENFORCEMENT_ROW.to_string(), None);
        }
        for (entry, ask) in &request.settings {
            let text = match ask {
                Ask::Set(text) => Some(text.clone()),
                Ask::Clear => None,
            };
            ops.insert(entry.key.to_string(), text);
            if !touched.contains(&entry.key) {
                touched.push(entry.key);
            }
        }
        // A sign-in address is always one of the addresses.
        if let Some((_, Ask::Set(sign_in))) = request
            .settings
            .iter()
            .find(|(entry, _)| entry.key == SIGN_IN_ADDRESS.entry.key)
            && !request.names(ADDRESSES.entry.key)
        {
            let mut list = match request.mode {
                Mode::Put => Vec::new(),
                Mode::Patch => before
                    .get(ADDRESSES.entry.key)
                    .and_then(|text| addresses::parse_list(text).ok())
                    .unwrap_or_default(),
            };
            if let Ok(address) = addresses::Address::parse(sign_in)
                && !list.contains(&address)
            {
                list.push(address);
            }
            let origins: Vec<_> = list.iter().map(addresses::Address::origin).collect();
            ops.insert(
                ADDRESSES.entry.key.to_string(),
                Some(Value::from(origins).to_string()),
            );
            if !touched.contains(&ADDRESSES.entry.key) {
                touched.push(ADDRESSES.entry.key);
            }
        }
        match &request.enforcement {
            Some(Ask::Set(levers)) => {
                ops.insert(
                    ENFORCEMENT_ROW.to_string(),
                    Some(levers.to_json().to_string()),
                );
            }
            Some(Ask::Clear) => {
                ops.insert(ENFORCEMENT_ROW.to_string(), None);
            }
            None => {}
        }
        let name = match &request.name {
            Some(Ask::Set(name)) => Some(Some(name.clone())),
            Some(Ask::Clear) => Some(None),
            None if request.mode == Mode::Put => Some(None),
            None => None,
        };
        let mut after = before.clone();
        for (key, text) in &ops {
            match text {
                Some(text) => after.insert(key.clone(), text.clone()),
                None => after.remove(key),
            };
        }
        Plan {
            ops: ops.into_iter().collect(),
            name,
            touched,
            before,
            after,
        }
    }

    /// Refuses a change that breaks a rule across settings.
    fn judge(&self, app: &App) -> Result<Snapshot> {
        let after = app.settings.candidate(&pairs(&self.after));
        let breaches = together::judge(&after, &self.touched, &app.settings.start);
        if breaches.is_empty() {
            return Ok(after);
        }
        Err(
            Refusal::validation("The settings cannot be used together").with_detail(
                "errors",
                breaches
                    .into_iter()
                    .map(|Breach { path, message }| json!({ "path": path, "message": message }))
                    .collect::<Vec<_>>(),
            ),
        )
    }

    /// What the change does to the addresses, and whether it needs a person to
    /// confirm it. This is the one place that decides.
    fn addresses_at(&self, app: &App, tx: &Transaction<'_>) -> Result<Moved> {
        let before = app.addresses_in(Arc::new(app.settings.candidate(&pairs(&self.before))));
        let after = app.addresses_in(Arc::new(app.settings.candidate(&pairs(&self.after))));
        let consequences = consequences::of_change(tx, &before, &after)?;
        let claimed = instance::is_claimed(tx)?;
        let had_one = self
            .before
            .get(SIGN_IN_ADDRESS.entry.key)
            .is_some_and(|text| !text.is_empty());
        // Provisional: a claimed instance that already holds a sign-in address
        // asks first. Change it here if the rule changes.
        let confirm = claimed && had_one && before.sign_in() != after.sign_in();
        Ok(Moved {
            consequences,
            confirm,
            sign_in: after.sign_in(),
            all: after.all(),
        })
    }
}

struct Moved {
    consequences: Vec<Consequence>,
    confirm: bool,
    sign_in: addresses::Address,
    all: Vec<addresses::Address>,
}

impl Moved {
    fn consequences_json(&self) -> Vec<Value> {
        self.consequences.iter().map(Consequence::to_json).collect()
    }
}

fn levers_of(rows: &Rows) -> Option<Levers> {
    let stored = rows.get(ENFORCEMENT_ROW)?;
    match serde_json::from_str::<Value>(stored) {
        Ok(Value::Object(map)) => Some(Levers::from_stored(map)),
        _ => None,
    }
}

/// The instance's enforcement levers, or none when none are set.
pub fn levers(tx: &Transaction<'_>) -> Result<Option<Levers>> {
    Ok(stored::get(tx, ENFORCEMENT_ROW)?.and_then(|text| {
        let rows = Rows::from([(ENFORCEMENT_ROW.to_string(), text)]);
        levers_of(&rows)
    }))
}

/// The configuration as `/config` answers it: each field that has been set.
fn document(app: &App, rows: &Rows, name: Option<String>) -> Value {
    let snapshot = app.settings.candidate(&pairs(rows));
    let mut body = Map::new();
    body.insert("instance_id".into(), app.instance_id.clone().into());
    if let Some(name) = name {
        body.insert("name".into(), name.into());
    }
    if let Some(levers) = levers_of(rows) {
        body.insert("enforcement".into(), levers.to_json());
    }
    for entry in ENTRIES {
        if let Some(value) = snapshot.stored(entry) {
            body.insert(entry.key.into(), value.to_json());
        }
    }
    Value::Object(body)
}

pub async fn read(app: &Arc<App>) -> Result<Value> {
    let (rows, name) = app
        .db
        .read(|tx| Ok((rows_of(stored::rows(tx)?), instance::stored_name(tx)?)))
        .await?;
    Ok(document(app, &rows, name))
}

fn confirmation_needed(moved: &Moved) -> Refusal {
    Refusal::new(
        Code::SignInAddressChangeUnconfirmed,
        "Changing the sign-in address needs your confirmation.",
    )
    .with_detail("consequences", moved.consequences_json())
}

/// Writes a configuration change, makes the settings live, and answers the
/// configuration it left.
pub async fn update(app: &Arc<App>, caller: &Caller, request: Request) -> Result<Value> {
    request.check_identity(app)?;
    let writing = app.clone();
    let working = app.clone();
    let caller = caller.clone();
    stored::committing(app, async move {
        working
            .write(&caller, "config.update", move |unit| {
                let tx = unit.tx();
                let before = rows_of(stored::rows(tx)?);
                let plan = Plan::of(&request, before);
                plan.judge(&writing)?;
                let moved = plan.addresses_at(&writing, tx)?;
                if moved.confirm && !request.confirmed {
                    return Err(confirmation_needed(&moved));
                }
                stored::write_rows(tx, &plan.ops)?;
                if let Some(name) = &plan.name {
                    instance::set_name(tx, name.as_deref())?;
                }
                unit.audit_set("config", Some(json!({ "fields": request.field_names() })))?;
                let staged = stored::stage(tx, &writing)?;
                let name = instance::stored_name(tx)?;
                Ok((document(&writing, &plan.after, name), Some(staged)))
            })
            .await
    })
    .await
}

/// What a change of address would do, written to nowhere.
pub async fn check(app: &Arc<App>, request: Request) -> Result<Value> {
    let checking = app.clone();
    app.db
        .read(move |tx| {
            let before = rows_of(stored::rows(tx)?);
            let plan = Plan::of(&request, before);
            plan.judge(&checking)?;
            let moved = plan.addresses_at(&checking, tx)?;
            Ok(json!({
                "sign_in_address": moved.sign_in.origin(),
                "addresses": moved.all.iter().map(addresses::Address::origin).collect::<Vec<_>>(),
                "requires_confirmation": moved.confirm,
                "consequences": moved.consequences_json(),
            }))
        })
        .await
}

/// Every stored setting with its value, default and rule, and every setting
/// only the environment sets.
pub async fn listing(app: &Arc<App>) -> Result<Value> {
    let rows = rows_of(app.db.read(stored::rows).await?);
    let live = app.settings.live();
    let defaults = Arc::new(app.settings.candidate(&[]));
    let (here, fallback) = (
        app.addresses_in(live.clone()),
        app.addresses_in(defaults.clone()),
    );
    let data: Vec<Value> = ENTRIES
        .iter()
        .map(|entry| {
            let (value, default) = match entry.key {
                key if key == SIGN_IN_ADDRESS.entry.key => (
                    Value::from(here.sign_in().origin()),
                    Value::from(fallback.sign_in().origin()),
                ),
                key if key == ADDRESSES.entry.key => {
                    (origins(&here.all()), origins(&fallback.all()))
                }
                _ => (live.value(entry).to_json(), defaults.value(entry).to_json()),
            };
            let unreadable = live.unreadable().contains(&entry.key);
            let stored = match (live.stored(entry), rows.get(entry.key)) {
                (Some(value), _) => value.to_json(),
                (None, Some(text)) if unreadable => Value::from(text.as_str()),
                _ => Value::Null,
            };
            let mut line = Map::new();
            line.insert("key".into(), entry.key.into());
            line.insert("description".into(), entry.description.into());
            line.insert("value".into(), value);
            line.insert("default".into(), default);
            line.insert("stored".into(), stored);
            line.insert("rule".into(), entry.words().into());
            if unreadable {
                line.insert("unreadable".into(), true.into());
            }
            let together: Vec<_> = together::rules_of(entry.key)
                .flat_map(|rule| rule.keys.iter().copied())
                .filter(|key| *key != entry.key)
                .collect();
            line.insert("together".into(), together.into());
            Value::Object(line)
        })
        .collect();
    let rules: Vec<_> = together::TOGETHER
        .iter()
        .map(
            |rule| json!({ "name": rule.name, "description": rule.description, "keys": rule.keys }),
        )
        .collect();
    let start_only: Vec<_> = app
        .settings
        .start_only()
        .iter()
        .map(|listed| {
            json!({
                "name": listed.declared.name,
                "description": listed.declared.description,
                "secret": listed.declared.secret,
                "set": listed.set,
            })
        })
        .collect();
    Ok(json!({ "data": data, "rules": rules, "start_only": start_only }))
}

fn origins(list: &[addresses::Address]) -> Value {
    Value::from(
        list.iter()
            .map(addresses::Address::origin)
            .collect::<Vec<_>>(),
    )
}

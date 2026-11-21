//! The instance's configuration as one body; only `name` and `enforcement` live outside the registry.

use std::collections::BTreeMap;
use std::sync::Arc;

use rusqlite::Transaction;
use serde_json::{Map, Value, json};

use super::access::{Caller, Levers, Permission, Standing, report_unread};
use super::addresses;
use super::auth::session;
use super::consequences::{self, Consequence};
use super::oauth;
use super::refusal::{Code, Refusal, Result};
use super::sign_in_check;
use super::sources;
use super::unit::Unit;
use super::{App, cloud, instance, stored};
use crate::settings::registry::{
    ADDRESSES, ALLOW_PRIVATE_ADDRESSES, BACKUP_PATH, ENTRIES, Entry, OBJECT_STORE_BUCKET,
    OBJECT_STORE_ENDPOINT, OBJECT_STORE_PATH_STYLE, OBJECT_STORE_PREFIX, OBJECT_STORE_REGION,
    OBJECT_STORE_SECRET_ACCESS_KEY, SIGN_IN_ADDRESS,
};
use crate::settings::sealed::Sealer;
use crate::settings::together::{self, Breach};

pub const ENFORCEMENT_ROW: &str = "enforcement";
const MAX_NAME: usize = 200;
const CONFIRMATION: &str = "confirm_sign_in_address_change";
const SKIP_CHECK: &str = "skip_sign_in_address_check";
/// Names the secrets that are set; a body may send it back, and it sets nothing.
const SECRETS_SET: &str = "secrets_set";
/// Where the instance's files and backups go.
const DESTINATION: [&Entry; 6] = [
    BACKUP_PATH.entry,
    OBJECT_STORE_BUCKET.entry,
    OBJECT_STORE_ENDPOINT.entry,
    OBJECT_STORE_REGION.entry,
    OBJECT_STORE_PATH_STYLE.entry,
    OBJECT_STORE_PREFIX.entry,
];
/// The settings a stored secret was given for.
const SIGNED_FOR: [&Entry; 2] = [OBJECT_STORE_ENDPOINT.entry, OBJECT_STORE_BUCKET.entry];

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
    let mut names = vec![
        "instance_id",
        "name",
        "enforcement",
        CONFIRMATION,
        SKIP_CHECK,
        SECRETS_SET,
    ];
    names.extend(ENTRIES.iter().map(|entry| entry.key));
    names
}

/// The fields an address check may name.
pub const CHECK_FIELDS: [&str; 2] = ["sign_in_address", "addresses"];

/// What a body asks for, once its shape has been judged. A secret it sets is sealed already.
#[derive(Debug)]
pub struct Request {
    mode: Mode,
    instance_id: Option<String>,
    confirmed: bool,
    skip_check: bool,
    settings: Vec<(&'static Entry, Ask<String>)>,
    name: Option<Ask<String>>,
    enforcement: Option<Ask<Levers>>,
    /// An address the write removes from `addresses`, which no body names.
    drops: Option<addresses::Address>,
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
        return Err(refusal);
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
    /// Names every field it cannot accept: unknown names first, then each field's shape. A
    /// refusal never repeats a secret's value.
    pub fn from_body(
        mode: Mode,
        body: &Map<String, Value>,
        allowed: &[&str],
        sealer: &Sealer,
    ) -> Result<Request> {
        unknown_fields(body, allowed)?;
        let mut errors = Vec::new();
        let mut request = Request {
            mode,
            instance_id: None,
            confirmed: false,
            skip_check: false,
            settings: Vec::new(),
            name: None,
            enforcement: None,
            drops: None,
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
                SECRETS_SET => {
                    let names = value
                        .as_array()
                        .filter(|names| names.iter().all(Value::is_string));
                    if names.is_none() {
                        errors.push((field.to_string(), "must be a list of setting keys".into()));
                    }
                }
                CONFIRMATION => match value.as_bool() {
                    Some(flag) => request.confirmed = flag,
                    None => errors.push((field.to_string(), "must be true or false".into())),
                },
                SKIP_CHECK => match value.as_bool() {
                    Some(flag) => request.skip_check = flag,
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
                        _ if entry.is_secret() => match entry.secret_text(value) {
                            Ok(None) => request.settings.push((entry, Ask::Clear)),
                            Ok(Some(secret)) => match sealer.seal(entry.key, &secret) {
                                Some(sealed) => request.settings.push((entry, Ask::Set(sealed))),
                                None => return Err(Refusal::internal("a secret did not seal")),
                            },
                            Err(rule) => errors.push((key.to_string(), rule)),
                        },
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

    /// Moves the sign-in address to `to`, or removes it, and removes `drops` from `addresses`.
    pub fn sign_in_move(
        to: Option<&addresses::Address>,
        confirmed: bool,
        drops: Option<addresses::Address>,
        sealer: &Sealer,
    ) -> Result<Request> {
        let mut body = Map::new();
        body.insert(
            SIGN_IN_ADDRESS.entry.key.into(),
            to.map_or(Value::Null, |address| address.origin().into()),
        );
        body.insert(CONFIRMATION.into(), confirmed.into());
        let mut request = Request::from_body(Mode::Patch, &body, &fields(), sealer)?;
        request.drops = drops;
        Ok(request)
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

    /// The backup folder the body sets.
    fn backup_path(&self) -> Option<&str> {
        self.settings.iter().find_map(|(entry, ask)| match ask {
            Ask::Set(text) if entry.key == BACKUP_PATH.entry.key => Some(text.as_str()),
            _ => None,
        })
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
    /// The body changes the row of `addresses` without naming it.
    rewrites_addresses: bool,
    /// The body removes the row of `enforcement` without naming it.
    drops_levers: bool,
    /// The store moves, so the secret given for the old one is removed.
    drops_secret: bool,
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
            // A secret is never read back, so a body cannot name one it leaves as it is.
            for entry in ENTRIES.iter().filter(|entry| !entry.is_secret()) {
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
        if let Some(dropped) = &request.drops {
            let text = match ops.get(ADDRESSES.entry.key) {
                Some(text) => text.clone(),
                None => before.get(ADDRESSES.entry.key).cloned(),
            };
            let list: Vec<_> = text
                .and_then(|text| addresses::parse_list(&text).ok())
                .unwrap_or_default()
                .into_iter()
                .filter(|address| address != dropped)
                .collect();
            let origins: Vec<_> = list.iter().map(addresses::Address::origin).collect();
            ops.insert(
                ADDRESSES.entry.key.to_string(),
                (!origins.is_empty()).then(|| Value::from(origins).to_string()),
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
        let rewrites_addresses =
            ops.contains_key(ADDRESSES.entry.key) && !request.names(ADDRESSES.entry.key);
        let drops_levers = request.mode == Mode::Put && request.enforcement.is_none();
        let mut after = before.clone();
        for (key, text) in &ops {
            match text {
                Some(text) => after.insert(key.clone(), text.clone()),
                None => after.remove(key),
            };
        }
        let secret = OBJECT_STORE_SECRET_ACCESS_KEY.entry.key;
        let drops_secret = !request.names(secret)
            && after.contains_key(secret)
            && SIGNED_FOR
                .iter()
                .any(|entry| before.get(entry.key) != after.get(entry.key));
        if drops_secret {
            ops.insert(secret.to_string(), None);
            after.remove(secret);
        }
        Plan {
            ops: ops.into_iter().collect(),
            name,
            touched,
            rewrites_addresses,
            drops_levers,
            drops_secret,
            before,
            after,
        }
    }

    /// A row that does not read reads as empty, so a change to it must name it.
    fn refuse_unread_rows(&self, app: &App) -> Result<()> {
        let addresses = ADDRESSES.entry.key;
        let before = app.settings.candidate(&pairs(&self.before));
        let mut unread = Vec::new();
        if self.rewrites_addresses && before.unreadable().contains(&addresses) {
            unread.push(addresses);
        }
        if self.drops_levers && unread_levers(&self.before).is_some() {
            unread.push(ENFORCEMENT_ROW);
        }
        if unread.is_empty() {
            return Ok(());
        }
        let rule = "no longer reads, so it must be set whole";
        Err(invalid(
            unread
                .into_iter()
                .map(|key| (key.to_string(), rule.to_string()))
                .collect(),
        ))
    }

    /// Refuses a change that breaks a rule across settings.
    fn judge(&self, app: &App) -> Result<()> {
        self.refuse_unread_rows(app)?;
        judge_together(
            app,
            &pairs(&self.before),
            &pairs(&self.after),
            &self.touched,
        )
    }

    /// A key that may change the configuration must not reach the owner's network.
    fn private_addresses_change(&self, app: &App) -> bool {
        let allowed = |rows: &Rows| {
            app.settings
                .candidate(&pairs(rows))
                .get(ALLOW_PRIVATE_ADDRESSES)
        };
        allowed(&self.before) != allowed(&self.after)
    }

    /// Judged on the stored rows, so fixing a row that does not read counts as a change.
    fn destination_change(&self) -> bool {
        DESTINATION
            .iter()
            .any(|entry| self.before.get(entry.key) != self.after.get(entry.key))
    }

    /// Whether the change needs a recent sign-in beyond moving the sign-in address.
    fn needs_step_up(&self, app: &App) -> bool {
        self.private_addresses_change(app) || self.destination_change()
    }

    /// The fields the write changes, for the audit record.
    fn audited(&self, request: &Request) -> Vec<&'static str> {
        let mut fields = request.field_names();
        if self.drops_secret {
            fields.push(OBJECT_STORE_SECRET_ACCESS_KEY.entry.key);
        }
        if request.drops.is_some() && !fields.contains(&ADDRESSES.entry.key) {
            fields.push(ADDRESSES.entry.key);
        }
        fields.sort_unstable();
        fields
    }

    fn sign_in_change(&self, app: &App, moved: &Moved) -> SignInChange {
        let before = Arc::new(app.settings.candidate(&pairs(&self.before)));
        SignInChange {
            before: app.addresses_in(before.clone()).sign_in(),
            after: moved.sign_in.clone(),
            stored_before: self
                .before
                .contains_key(SIGN_IN_ADDRESS.entry.key)
                .then(|| before.get(SIGN_IN_ADDRESS))
                .flatten(),
        }
    }

    /// What the change does to the addresses, and whether it needs a person to
    /// confirm it. This is the one place that decides.
    fn addresses_at(&self, app: &App, tx: &Transaction<'_>) -> Result<Moved> {
        let before = app.addresses_in(Arc::new(app.settings.candidate(&pairs(&self.before))));
        let after = app.addresses_in(Arc::new(app.settings.candidate(&pairs(&self.after))));
        let consequences = consequences::of_change(tx, &before, &after, app.clock.now_ms())?;
        let sign_in_moves = before.sign_in() != after.sign_in();
        Ok(Moved {
            consequences,
            sign_in_moves,
            confirm: sign_in_moves && instance::is_claimed(tx)?,
            sign_in: after.sign_in(),
            all: after.all(),
        })
    }
}

struct Moved {
    consequences: Vec<Consequence>,
    sign_in_moves: bool,
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
    Levers::from_row(rows.get(ENFORCEMENT_ROW)?)
}

/// The text of the instance's levers, where it does not read.
fn unread_levers(rows: &Rows) -> Option<&str> {
    rows.get(ENFORCEMENT_ROW)
        .map(String::as_str)
        .filter(|text| Levers::from_row(text).is_none())
}

/// Whether the instance's levers are stored and do not read. It asks the table
/// and not the live settings, as [`standing`] does.
pub fn levers_unreadable(tx: &Transaction<'_>) -> Result<bool> {
    let text = stored::get(tx, ENFORCEMENT_ROW)?;
    Ok(text.is_some_and(|text| Levers::from_row(&text).is_none()))
}

/// An unreadable row closes the levers it should have set and leaves `/config` open.
pub fn standing(tx: &Transaction<'_>, own: Option<&Levers>) -> Result<Standing> {
    let Some(text) = stored::get(tx, ENFORCEMENT_ROW)? else {
        return Ok(Standing::of(own, None));
    };
    Ok(match Levers::from_row(&text) {
        Some(instance) => Standing::of(own, Some(&instance)),
        None => {
            report_unread("instance", &text);
            Standing::closed()
        }
    })
}

/// Refuses settings `after` that break a rule across settings naming one of `touched`, judged
/// against the settings `before` they replace.
pub fn judge_together(
    app: &App,
    before: &[(String, String)],
    after: &[(String, String)],
    touched: &[&str],
) -> Result<()> {
    let before = app.settings.candidate(before);
    let after = Arc::new(app.settings.candidate(after));
    let sign_in = app.addresses_in(after.clone()).sign_in();
    let breaches = together::judge(&before, &after, touched, &app.settings.start, Some(sign_in));
    if breaches.is_empty() {
        return Ok(());
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
    let mut secrets = Vec::new();
    for entry in ENTRIES {
        match snapshot.stored(entry) {
            Some(_) if entry.is_secret() => secrets.push(entry.key),
            Some(value) => {
                body.insert(entry.key.into(), value.to_json());
            }
            None => {}
        }
    }
    if !secrets.is_empty() {
        body.insert(SECRETS_SET.into(), secrets.into());
    }
    Value::Object(body)
}

/// Refuses a backup folder inside the data directory or the blob folder, judged where links lead.
async fn check_backup_path(app: &App, request: &Request) -> Result<()> {
    let Some(text) = request.backup_path() else {
        return Ok(());
    };
    let (folder, kept) = (
        std::path::PathBuf::from(text),
        together::kept_folders(&app.settings.start),
    );
    let looked = tokio::task::spawn_blocking(move || {
        let kept: Vec<(&str, &std::path::Path)> = kept
            .iter()
            .map(|(what, path)| (*what, path.as_path()))
            .collect();
        super::blobs::folder::outside(&folder, &kept)
    });
    match tokio::time::timeout(std::time::Duration::from_secs(5), looked).await {
        Ok(Ok(Ok(()))) | Err(_) => Ok(()),
        Ok(Ok(Err(failure))) => Err(invalid(vec![(
            BACKUP_PATH.entry.key.to_string(),
            failure.message,
        )])),
        Ok(Err(_)) => Err(Refusal::internal("the backup folder could not be judged")),
    }
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

/// Who stands behind a change of the configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authority {
    /// The caller, who must hold what the change needs and confirm a move of the sign-in address.
    Caller,
    /// The server, carrying out a move a caller who could make it confirmed earlier.
    Confirmed,
    /// The server, putting back the sign-in address an address that no longer answers replaced.
    Restored,
}

/// What a write did to the sign-in address, for a part that keeps track of it.
pub struct SignInChange {
    pub before: addresses::Address,
    pub after: addresses::Address,
    /// The sign-in address stored before the write, if one was; never a default.
    pub stored_before: Option<addresses::Address>,
}

/// Refuses as the write would, then checks the backup folder and the new sign-in address.
async fn check_sign_in(
    app: &Arc<App>,
    caller: &Caller,
    request: Request,
    authority: Authority,
) -> Result<(Request, Option<addresses::Address>)> {
    if request.skip_check && !caller.is_local() {
        return Err(Refusal::new(
            Code::Forbidden,
            "Only the private local command can move the sign-in address without checking it.",
        ));
    }
    let reading = app.clone();
    let (request, step_up, moved) = app
        .db
        .read(move |tx| {
            let plan = Plan::of(&request, rows_of(stored::rows(tx)?));
            let step_up = plan.needs_step_up(&reading);
            let moved = plan
                .judge(&reading)
                .and_then(|()| plan.addresses_at(&reading, tx));
            Ok((request, step_up, moved))
        })
        .await?;
    let at = app.clock.stamp();
    if authority == Authority::Caller && step_up {
        caller.require_step_up(Permission::ConfigManage, &at)?;
    }
    let moved = moved?;
    if authority == Authority::Restored {
        return Ok((request, None));
    }
    if authority == Authority::Confirmed {
        if !moved.sign_in_moves {
            return Ok((request, None));
        }
        sign_in_check::check(app, &moved.sign_in)
            .await
            .map_err(sign_in_check::Failed::refusal)?;
        return Ok((request, Some(moved.sign_in)));
    }
    if moved.sign_in_moves {
        caller.require_step_up(Permission::ConfigManage, &at)?;
    }
    check_backup_path(app, &request).await?;
    if !moved.confirm {
        return Ok((request, None));
    }
    if !request.confirmed {
        return Err(confirmation_needed(&moved));
    }
    if request.skip_check {
        return Ok((request, None));
    }
    sign_in_check::check(app, &moved.sign_in)
        .await
        .map_err(sign_in_check::Failed::refusal)?;
    Ok((request, Some(moved.sign_in)))
}

pub async fn update(app: &Arc<App>, caller: &Caller, request: Request) -> Result<Value> {
    let (answer, ()) = update_with(app, caller, request, Authority::Caller, |_, _| Ok(())).await?;
    Ok(answer)
}

/// Writes the change as `update` does, with `also` in the same write.
pub async fn update_with<T, F>(
    app: &Arc<App>,
    caller: &Caller,
    request: Request,
    authority: Authority,
    also: F,
) -> Result<(Value, T)>
where
    T: Send + 'static,
    F: FnOnce(&Unit<'_, '_>, &SignInChange) -> Result<T> + Send + 'static,
{
    request.check_identity(app)?;
    let (request, answered) = check_sign_in(app, caller, request, authority).await?;
    let writing = app.clone();
    let working = app.clone();
    let caller = caller.clone();
    stored::committing(app, async move {
        working
            .write(&caller, "config.update", move |unit| {
                let asked = authority == Authority::Caller;
                unit.caller.require(Permission::ConfigManage)?;
                let tx = unit.tx();
                let before = rows_of(stored::rows(tx)?);
                let plan = Plan::of(&request, before);
                if asked && plan.needs_step_up(&writing) {
                    unit.caller
                        .require_step_up(Permission::ConfigManage, &unit.at)?;
                }
                plan.judge(&writing)?;
                let moved = plan.addresses_at(&writing, tx)?;
                if asked && moved.sign_in_moves {
                    unit.caller
                        .require_step_up(Permission::ConfigManage, &unit.at)?;
                }
                if asked && moved.confirm && !request.confirmed {
                    return Err(confirmation_needed(&moved));
                }
                let checked = match authority {
                    Authority::Caller => moved.confirm && !request.skip_check,
                    Authority::Confirmed => moved.sign_in_moves,
                    Authority::Restored => false,
                };
                if checked && answered.as_ref() != Some(&moved.sign_in) {
                    return Err(Refusal::new(
                        Code::Conflict,
                        "The configuration changed while the new sign-in address was checked. Try again.",
                    ));
                }
                let change = plan.sign_in_change(&writing, &moved);
                stored::write_rows(tx, &plan.ops)?;
                if moved.sign_in_moves {
                    session::end_every(tx, &unit.at, &unit.caller)?;
                    oauth::store::end_every_sign_in(tx, unit.instant)?;
                }
                if let Some(name) = &plan.name {
                    instance::set_name(tx, name.as_deref())?;
                }
                unit.audit_set("config", Some(json!({ "fields": plan.audited(&request) })))?;
                let kept = also(unit, &change)?;
                cloud::after_config(unit, &writing, &change)?;
                let staged = stored::stage(tx, &writing)?;
                let name = instance::stored_name(tx)?;
                let mut answer = document(&writing, &plan.after, name);
                if moved.sign_in_moves {
                    answer["sign_in_moved"] = json!({
                        "consequences": moved.consequences_json(),
                        "next_steps": consequences::next_steps(&moved.sign_in),
                    });
                }
                Ok(((answer, kept), Some(staged)))
            })
            .await
    })
    .await
}

/// What a start did with the sign-in address `MARFA_CLAIM_ADDRESS` declares.
#[derive(Debug, PartialEq, Eq)]
pub enum Adopted {
    Stored,
    AlreadyStored,
    /// An owner decides the address, so the setting is ignored.
    Owned,
}

/// Stores `address` as the sign-in address while the instance has no owner.
pub async fn adopt_sign_in_address(
    app: &Arc<App>,
    address: &addresses::Address,
) -> Result<Adopted> {
    let key = SIGN_IN_ADDRESS.entry.key;
    let mut body = Map::new();
    body.insert(key.into(), address.origin().into());
    let request = Request::from_body(Mode::Patch, &body, &fields(), app.settings.sealer())?;
    let row = SIGN_IN_ADDRESS
        .entry
        .row_text(address.origin())
        .map_err(|rule| Refusal::internal(&format!("{key} {rule}")))?;
    let writing = app.clone();
    let working = app.clone();
    stored::committing(app, async move {
        working
            .write(&Caller::Server, "config.update", move |unit| {
                let tx = unit.tx();
                let before = rows_of(stored::rows(tx)?);
                if before.get(key) == Some(&row) {
                    return Ok((Adopted::AlreadyStored, None));
                }
                if instance::is_claimed(tx)? {
                    return Ok((Adopted::Owned, None));
                }
                let plan = Plan::of(&request, before);
                plan.judge(&writing)?;
                let moved = plan.addresses_at(&writing, tx)?;
                let change = plan.sign_in_change(&writing, &moved);
                stored::write_rows(tx, &plan.ops)?;
                if moved.sign_in_moves {
                    session::end_every(tx, &unit.at, &unit.caller)?;
                }
                unit.audit_set("config", Some(json!({ "fields": request.field_names() })))?;
                cloud::after_config(unit, &writing, &change)?;
                Ok((Adopted::Stored, Some(stored::stage(tx, &writing)?)))
            })
            .await
    })
    .await
}

/// What a change of address would do, written to nowhere.
pub async fn check(app: &Arc<App>, caller: &Caller, request: Request) -> Result<Value> {
    let checking = app.clone();
    let moved = app
        .db
        .read(move |tx| {
            let before = rows_of(stored::rows(tx)?);
            let plan = Plan::of(&request, before);
            plan.judge(&checking)?;
            plan.addresses_at(&checking, tx)
        })
        .await?;
    let next_steps = if moved.sign_in_moves {
        consequences::next_steps(&moved.sign_in)
    } else {
        Vec::new()
    };
    let mut answer = json!({
        "sign_in_address": moved.sign_in.origin(),
        "addresses": moved.all.iter().map(addresses::Address::origin).collect::<Vec<_>>(),
        "requires_confirmation": moved.confirm,
        "consequences": moved.consequences_json(),
        "next_steps": next_steps,
    });
    if moved.confirm {
        let may_move = caller
            .require_step_up(Permission::ConfigManage, &app.clock.stamp())
            .is_ok();
        let checked = sign_in_check::check_for(app, &moved.sign_in, may_move).await;
        answer["sign_in_address_check"] = sign_in_check::to_json(checked);
    }
    Ok(answer)
}

pub async fn listing(app: &Arc<App>) -> Result<Value> {
    let rows = rows_of(app.db.read(stored::rows).await?);
    let live = app.settings.live();
    let defaults = Arc::new(app.settings.candidate(&[]));
    let (here, fallback) = (
        app.addresses_in(live.clone()),
        app.addresses_in(defaults.clone()),
    );
    let mut data: Vec<Value> = ENTRIES
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
                (None, Some(text)) if unreadable && !entry.is_secret() => {
                    Value::from(text.as_str())
                }
                _ => Value::Null,
            };
            let mut line = Map::new();
            line.insert("key".into(), entry.key.into());
            line.insert("description".into(), entry.description.into());
            line.insert("value".into(), value);
            line.insert("default".into(), default);
            line.insert("stored".into(), stored);
            line.insert("rule".into(), entry.words().into());
            line.insert("secret".into(), entry.is_secret().into());
            if entry.is_secret() {
                line.insert("set".into(), live.secret_set(entry).into());
            }
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
    if let Some(text) = unread_levers(&rows) {
        data.push(json!({
            "key": ENFORCEMENT_ROW,
            "description": "The enforcement levers. Until a write names them, every type is held and no source is allowed.",
            "value": null,
            "default": null,
            "stored": text,
            "rule": "An object of strict_mode, source_allowlist and source_filter",
            "unreadable": true,
            "together": [],
        }));
    }
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

use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde_json::{Map, Value, json};

use super::{Note, Visit, avatar, limits, note, password, session};
use crate::app::access::{Caller, Level};
use crate::app::clock::Stamp;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::{App, instance};

pub(super) const MAX_EMAIL_CHARS: usize = 254;
const MAX_NAME_CHARS: usize = 200;
pub const UPDATE_FIELDS: [&str; 3] = ["email", "name", "avatar"];

#[derive(Clone, Debug)]
pub struct Owner {
    pub id: String,
    pub email: String,
    pub name: String,
    pub created_at: Stamp,
    /// Whether the owner holds an avatar, which `GET /owner/avatar` serves.
    pub avatar: bool,
}

impl Owner {
    /// The owner as answered, with the instance's own `origin` to address the avatar by.
    pub fn to_json(&self, origin: &str) -> Value {
        json!({
            "id": self.id,
            "email": self.email,
            "name": self.name,
            "avatar": self.avatar.then(|| format!("{origin}/owner/avatar")),
            "created_at": self.created_at,
        })
    }
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<Owner> {
    Ok(Owner {
        id: row.get("id")?,
        email: row.get("email")?,
        name: row.get("name")?,
        created_at: row.get("created_at")?,
        avatar: false,
    })
}

pub fn read(tx: &Transaction<'_>) -> Result<Option<Owner>> {
    let Some(id) = instance::owner_id(tx)? else {
        return Ok(None);
    };
    let owner = tx
        .query_row(
            "SELECT id, email, name, created_at FROM owner WHERE id = ?1",
            [id],
            from_row,
        )
        .optional()?;
    owner
        .map(|owner| {
            Ok(Owner {
                avatar: avatar::exists(tx)?,
                ..owner
            })
        })
        .transpose()
}

pub fn not_found() -> Refusal {
    Refusal::new(Code::OwnerNotFound, "This instance has no owner.")
}

pub(super) fn stored_password(tx: &Transaction<'_>, owner_id: &str) -> Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT password FROM owner WHERE id = ?1",
            [owner_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// A new password, which leaves every device cookie set before it no cookie.
pub(super) fn set_password(
    tx: &Transaction<'_>,
    owner_id: &str,
    hash: &str,
    now: Stamp,
) -> Result<()> {
    rehash(tx, owner_id, hash, now)?;
    renew_credentials(tx, owner_id)
}

/// The same password under a newer hash.
pub(super) fn rehash(tx: &Transaction<'_>, owner_id: &str, hash: &str, now: Stamp) -> Result<()> {
    tx.execute(
        "UPDATE owner SET password = ?2, updated_at = ?3 WHERE id = ?1",
        params![owner_id, hash, now],
    )?;
    Ok(())
}

/// Leaves every device cookie set before now no cookie.
pub(super) fn renew_credentials(tx: &Transaction<'_>, owner_id: &str) -> Result<()> {
    tx.execute(
        "UPDATE owner SET credentials = credentials + 1 WHERE id = ?1",
        [owner_id],
    )?;
    Ok(())
}

/// What a device cookie is signed for: the owner's credentials as they stand.
pub(super) fn credentials(tx: &Transaction<'_>, owner_id: &str) -> Result<Option<i64>> {
    Ok(tx
        .query_row(
            "SELECT credentials FROM owner WHERE id = ?1",
            [owner_id],
            |row| row.get(0),
        )
        .optional()?)
}

#[derive(Clone, Debug)]
pub struct Details {
    pub email: String,
    pub name: String,
    pub password: String,
}

pub fn incomplete_claim() -> Refusal {
    Refusal::validation("Provide an email and password, and optionally a name")
}

fn invalid(path: &str, message: &str) -> Refusal {
    Refusal::validation("Invalid owner details.")
        .with_detail("errors", json!([{ "path": path, "message": message }]))
}

fn checked_email(text: &str) -> Result<String> {
    let email = text.trim().to_lowercase();
    if email.chars().count() > MAX_EMAIL_CHARS || !marfa_rules::validation::email(&email) {
        return Err(invalid("email", "Enter a valid email address."));
    }
    Ok(email)
}

pub(super) fn is_hidden(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{ad}' | '\u{61c}' | '\u{180e}' | '\u{feff}')
        || ('\u{200b}'..='\u{200f}').contains(&c)
        || ('\u{202a}'..='\u{202e}').contains(&c)
        || ('\u{2060}'..='\u{206f}').contains(&c)
}

fn name_problem(text: &str) -> std::result::Result<Option<String>, &'static str> {
    if text.chars().any(is_hidden) {
        return Err("Use letters, numbers and punctuation.");
    }
    let name = text.trim();
    if name.chars().count() > MAX_NAME_CHARS {
        return Err("Use at most 200 characters.");
    }
    Ok((!name.is_empty()).then(|| name.to_string()))
}

pub(super) fn checked_name(text: &str) -> Result<Option<String>> {
    name_problem(text).map_err(|message| invalid("name", message))
}

/// A name for a thing that has one field, refused with the field's own message.
pub(super) fn said_name(text: &str, empty: &'static str) -> Result<String> {
    name_problem(text)
        .map_err(Refusal::validation)?
        .ok_or_else(|| Refusal::validation(empty))
}

impl Details {
    pub fn new(email: &str, name: Option<&str>, password: String) -> Result<Details> {
        let email = checked_email(email)?;
        let name = name.map(checked_name).transpose()?.flatten();
        let name = name.unwrap_or_else(|| {
            email
                .split_once('@')
                .map_or(email.as_str(), |(local, _)| local)
                .to_string()
        });
        Ok(Details {
            email,
            name,
            password,
        })
    }
}

pub(super) fn create(
    tx: &Transaction<'_>,
    details: &Details,
    hash: &str,
    now: Stamp,
) -> Result<Owner> {
    let id = uuid::Uuid::now_v7().to_string();
    tx.execute(
        "INSERT INTO owner (id, name, email, password, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, details.name, details.email, hash, now],
    )?;
    Ok(Owner {
        id,
        email: details.email.clone(),
        name: details.name.clone(),
        created_at: now,
        avatar: false,
    })
}

pub async fn find(app: &App) -> Result<Option<Owner>> {
    app.db.read(read).await
}

#[derive(Debug)]
pub struct Update {
    email: Option<String>,
    name: Option<String>,
    clear_avatar: bool,
    fields: Vec<String>,
}

impl Update {
    pub fn from_body(body: &Map<String, Value>) -> Result<Update> {
        if body.is_empty() {
            return Err(Refusal::validation("Name at least one field to change."));
        }
        let text = |field: &str| match body.get(field) {
            None => Ok(None),
            Some(Value::String(text)) => Ok(Some(text.as_str())),
            Some(_) => Err(invalid(field, "Must be a string.")),
        };
        if body.get("avatar").is_some_and(|avatar| !avatar.is_null()) {
            return Err(invalid("avatar", "Only null clears the avatar here."));
        }
        let name = text("name")?
            .map(|name| checked_name(name)?.ok_or_else(|| invalid("name", "Enter a name.")))
            .transpose()?;
        Ok(Update {
            email: text("email")?.map(checked_email).transpose()?,
            name,
            clear_avatar: body.contains_key("avatar"),
            fields: body.keys().cloned().collect(),
        })
    }
}

pub async fn update(app: &App, caller: &Caller, update: Update, visit: Visit) -> Result<Owner> {
    app.write(caller, "owner.update", move |unit| {
        unit.caller.require_local()?;
        let mut owner = read(unit.tx())?.ok_or_else(not_found)?;
        if let Some(email) = update.email {
            owner.email = email;
        }
        if let Some(name) = update.name {
            owner.name = name;
        }
        if update.clear_avatar {
            avatar::remove(unit.tx())?;
            owner.avatar = false;
        }
        unit.tx().execute(
            "UPDATE owner SET email = ?2, name = ?3, updated_at = ?4 WHERE id = ?1",
            params![owner.id, owner.email, owner.name, unit.instant],
        )?;
        note(
            unit.tx(),
            &unit.at,
            Some(&unit.caller),
            &visit,
            Note {
                action: "owner.update",
                resource_type: "owner",
                resource_id: &owner.id,
                details: Some(json!({ "fields": update.fields })),
            },
        )?;
        Ok(owner)
    })
    .await
}

/// The owner's profile as far as `caller` may read it: a field it may not read is left out.
pub async fn read_profile(app: &App, caller: &Caller) -> Result<Value> {
    let owner = find(app).await?.ok_or_else(not_found)?;
    Ok(profile_of(
        &owner,
        app.addresses().sign_in().origin(),
        caller,
    ))
}

/// The owner's profile fields that `caller` may read.
pub fn profile_of(owner: &Owner, origin: &str, caller: &Caller) -> Value {
    let whole = owner.to_json(origin);
    let mut shown = Map::new();
    for field in ["name", "email", "avatar"] {
        if caller.reads_profile(field) {
            shown.insert(field.to_string(), whole[field].clone());
        }
    }
    Value::Object(shown)
}

#[derive(Debug)]
pub struct ProfileUpdate {
    name: Option<String>,
    clear_avatar: bool,
}

pub const PROFILE_FIELDS: [&str; 2] = ["name", "avatar"];

impl ProfileUpdate {
    pub fn from_body(body: &Map<String, Value>) -> Result<ProfileUpdate> {
        if body.is_empty() {
            return Err(Refusal::validation("Name at least one field to change."));
        }
        if body.get("avatar").is_some_and(|avatar| !avatar.is_null()) {
            return Err(invalid("avatar", "Only null clears the avatar here."));
        }
        let name = match body.get("name") {
            None => None,
            Some(Value::String(name)) => {
                Some(checked_name(name)?.ok_or_else(|| invalid("name", "Enter a name."))?)
            }
            Some(_) => return Err(invalid("name", "Must be a string.")),
        };
        Ok(ProfileUpdate {
            name,
            clear_avatar: body.contains_key("avatar"),
        })
    }

    fn fields(&self) -> Vec<&'static str> {
        let named = [(self.name.is_some(), "name"), (self.clear_avatar, "avatar")];
        named
            .into_iter()
            .filter_map(|(present, field)| present.then_some(field))
            .collect()
    }
}

pub async fn update_profile(
    app: &App,
    caller: &Caller,
    update: ProfileUpdate,
    visit: Visit,
) -> Result<Value> {
    let origin = app.addresses().sign_in().origin().to_string();
    app.write(caller, "profile.update", move |unit| {
        let fields = update.fields();
        for field in &fields {
            unit.caller.require_profile(field, Level::Write)?;
        }
        let owner = read(unit.tx())?.ok_or_else(not_found)?;
        if let Some(name) = &update.name {
            unit.tx().execute(
                "UPDATE owner SET name = ?2, updated_at = ?3 WHERE id = ?1",
                params![owner.id, name, unit.instant],
            )?;
        }
        if update.clear_avatar {
            avatar::remove(unit.tx())?;
        }
        note(
            unit.tx(),
            &unit.at,
            Some(&unit.caller),
            &visit,
            Note {
                action: "profile.update",
                resource_type: "owner",
                resource_id: &owner.id,
                details: Some(json!({ "fields": fields })),
            },
        )?;
        let changed = read(unit.tx())?.ok_or_else(not_found)?;
        Ok(profile_of(&changed, &origin, &unit.caller))
    })
    .await
}

pub const RECOVERED: &str = "owner.password.recovered";

/// What recovery does, by the private socket or by a recovery code: a new
/// password, and every browser session ended. Keys and apps keep working.
pub(super) fn recover_in(
    tx: &Transaction<'_>,
    at: &str,
    actor: &Caller,
    visit: &Visit,
    hash: &str,
) -> Result<Owner> {
    let owner = read(tx)?.ok_or_else(not_found)?;
    set_password(tx, &owner.id, hash, Stamp::read(at)?)?;
    session::end_all(tx, at, actor, visit, &owner.id, None)?;
    Ok(owner)
}

pub async fn recover(app: &App, new_password: String) -> Result<()> {
    password::check_new(&new_password, "password")?;
    if find(app).await?.is_none() {
        return Err(not_found());
    }
    let hash = app.passwords.hash(new_password).await?;
    app.write(&Caller::local(), RECOVERED, move |unit| {
        let owner = recover_in(unit.tx(), &unit.at, &unit.caller, &Visit::default(), &hash)?;
        unit.audit("owner", &owner.id, None)
    })
    .await?;
    limits::clear_for_recovery(&app.limiter);
    Ok(())
}

#[cfg(test)]
mod name_tests {
    use super::*;

    #[test]
    fn a_name_refused_for_one_field_says_why_at_the_top() {
        let hidden = "pass\u{200b}key";
        let long = "n".repeat(MAX_NAME_CHARS + 1);
        // The witness: an ordinary name is taken, and an empty one is the caller's own message.
        assert_eq!(said_name("  Laptop ", "Give it a name.").unwrap(), "Laptop");
        assert_eq!(
            said_name("   ", "Give it a name.").unwrap_err().message,
            "Give it a name."
        );
        assert_eq!(
            said_name(hidden, "x").unwrap_err().message,
            "Use letters, numbers and punctuation."
        );
        assert_eq!(
            said_name(&long, "x").unwrap_err().message,
            "Use at most 200 characters."
        );
        // The owner's own name keeps the path of the field in its details.
        assert_eq!(
            checked_name(&long).unwrap_err().message,
            "Invalid owner details."
        );
    }
}

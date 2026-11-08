//! The person who claimed this instance.

use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde_json::{Map, Value, json};

use super::{Note, Visit, limits, note, password, seconds_of, session, stamp_of};
use crate::app::access::Caller;
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
    pub created_at: i64,
}

impl Owner {
    /// The owner as every door answers them.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "email": self.email,
            "name": self.name,
            "avatar": null,
            "created_at": stamp_of(self.created_at),
        })
    }
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<Owner> {
    Ok(Owner {
        id: row.get("id")?,
        email: row.get("email")?,
        name: row.get("name")?,
        created_at: row.get("created_at")?,
    })
}

/// The owner's row, which fails to be there if it was removed behind the
/// claim's back.
pub fn read(tx: &Transaction<'_>) -> Result<Option<Owner>> {
    let Some(id) = instance::owner_id(tx)? else {
        return Ok(None);
    };
    Ok(tx
        .query_row(
            "SELECT id, email, name, created_at FROM auth_user WHERE id = ?1",
            [id],
            from_row,
        )
        .optional()?)
}

pub fn not_found() -> Refusal {
    Refusal::new(Code::OwnerNotFound, "This instance has no owner.")
}

/// The password held for the owner.
pub(super) fn stored_password(tx: &Transaction<'_>, owner_id: &str) -> Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT password FROM auth_account WHERE user_id = ?1",
            [owner_id],
            |row| row.get(0),
        )
        .optional()?)
}

pub(super) fn set_password(
    tx: &Transaction<'_>,
    owner_id: &str,
    hash: &str,
    now: i64,
) -> Result<()> {
    tx.execute(
        "UPDATE auth_account SET password = ?2, updated_at = ?3 WHERE user_id = ?1",
        params![owner_id, hash, now],
    )?;
    Ok(())
}

/// What makes someone the owner, once checked.
#[derive(Clone, Debug)]
pub struct Details {
    pub email: String,
    pub name: String,
    pub password: String,
}

/// The refusal of a claim's body that lacks what a claim takes.
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

/// A control character or an invisible formatting one.
pub(super) fn is_hidden(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{ad}' | '\u{61c}' | '\u{180e}' | '\u{feff}')
        || ('\u{200b}'..='\u{200f}').contains(&c)
        || ('\u{202a}'..='\u{202e}').contains(&c)
        || ('\u{2060}'..='\u{206f}').contains(&c)
}

/// A name a person can read, of at most 200 characters once trimmed. `None`
/// if nothing is left.
pub(super) fn checked_name(text: &str) -> Result<Option<String>> {
    if text.chars().any(is_hidden) {
        return Err(invalid("name", "Use letters, numbers and punctuation."));
    }
    let name = text.trim();
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(invalid("name", "Use at most 200 characters."));
    }
    Ok((!name.is_empty()).then(|| name.to_string()))
}

impl Details {
    /// Judges `email` and `name`. The password is judged later, once the
    /// caller's proof has been.
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

/// Creates the owner's rows. The claim records who that makes the owner.
pub(super) fn create(
    tx: &Transaction<'_>,
    details: &Details,
    hash: &str,
    now: i64,
) -> Result<Owner> {
    let id = uuid::Uuid::now_v7().to_string();
    tx.execute(
        "INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at) \
         VALUES (?1, ?2, ?3, 1, ?4, ?4)",
        params![id, details.name, details.email, now],
    )?;
    tx.execute(
        "INSERT INTO auth_account (id, user_id, password, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![uuid::Uuid::now_v7().to_string(), id, hash, now],
    )?;
    Ok(Owner {
        id,
        email: details.email.clone(),
        name: details.name.clone(),
        created_at: now,
    })
}

pub async fn find(app: &App) -> Result<Option<Owner>> {
    app.db.read(read).await
}

/// A change to the owner, as `PATCH /owner` names one.
#[derive(Debug)]
pub struct Update {
    email: Option<String>,
    name: Option<String>,
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
            return Err(invalid("avatar", "Only null clears the picture here."));
        }
        let name = text("name")?
            .map(|name| checked_name(name)?.ok_or_else(|| invalid("name", "Enter a name.")))
            .transpose()?;
        Ok(Update {
            email: text("email")?.map(checked_email).transpose()?,
            name,
            fields: body.keys().cloned().collect(),
        })
    }
}

/// Changes the owner. A browser needs a recent sign-in, and a key may not.
pub async fn update(app: &App, caller: &Caller, update: Update, visit: Visit) -> Result<Owner> {
    app.write(caller, "owner.update", move |unit| {
        unit.caller.require_direct()?;
        unit.caller.require_recent(&unit.at)?;
        let mut owner = read(unit.tx())?.ok_or_else(not_found)?;
        if let Some(email) = update.email {
            owner.email = email;
        }
        if let Some(name) = update.name {
            owner.name = name;
        }
        unit.tx().execute(
            "UPDATE auth_user SET email = ?2, name = ?3, updated_at = ?4, \
             email_verified = CASE WHEN email = ?2 THEN email_verified ELSE 0 END \
             WHERE id = ?1",
            params![owner.id, owner.email, owner.name, seconds_of(&unit.at)?],
        )?;
        note(
            unit.tx(),
            &unit.at,
            Some(&unit.caller),
            &visit,
            Note {
                action: "owner.update",
                resource_type: "auth_user",
                resource_id: &owner.id,
                details: Some(json!({ "fields": update.fields })),
            },
        )?;
        Ok(owner)
    })
    .await
}

/// Sets a new password from this machine, for an owner who lost theirs. Every
/// browser session ends and the account's sign-in lock opens.
pub async fn recover(app: &App, new_password: String) -> Result<()> {
    password::check_new(&new_password)?;
    if find(app).await?.is_none() {
        return Err(not_found());
    }
    let hash = app.passwords.hash(new_password).await?;
    app.write(&Caller::local(), "owner.password.recovered", move |unit| {
        let tx = unit.tx();
        let owner = read(tx)?.ok_or_else(not_found)?;
        set_password(tx, &owner.id, &hash, seconds_of(&unit.at)?)?;
        session::end_all(
            tx,
            &unit.at,
            &unit.caller,
            &Visit::default(),
            &owner.id,
            None,
        )?;
        limits::clear_account(tx, &owner.email)?;
        unit.audit("owner", &owner.id, None)
    })
    .await
}

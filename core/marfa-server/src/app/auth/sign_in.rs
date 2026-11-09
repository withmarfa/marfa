//! Everything that checks the owner's password. Each counts the attempt, checks the hash off the
//! writer, then acts in one transaction that finds the password as it was checked.

use rusqlite::Transaction;
use serde_json::{Value, json};

use super::limits::{self, too_many_passwords};
use super::owner::{self, Owner};
use super::password::{self, Checked};
use super::session::{self, New, Opened};
use super::{Note, Visit, note};
use crate::app::App;
use crate::app::access::{Caller, unauthorized};
use crate::app::clock::Stamp;
use crate::app::refusal::{Code, Refusal, Result};
use crate::db::Write;

pub(super) const SIGNED_IN: &str = "auth.sign_in.success";
pub(super) const SIGN_IN_FAILED: &str = "auth.sign_in.failed";
const CHANGED: &str = "owner.password.changed";
const CHANGE_FAILED: &str = "owner.password.change_failed";
const INVALID: &str = "invalid_credentials";
const TOO_MANY: &str = "too_many_attempts";

fn wrong_credentials() -> Refusal {
    Refusal::new(Code::Unauthorized, "Invalid email or password.")
}

async fn count(app: &App, email: &str, visit: &Visit) -> Result<Option<i64>> {
    let lanes = limits::password_lanes(email, visit.address);
    let clock = app.clock.clone();
    app.db
        .write(Write::own(), move |tx| {
            limits::admit(tx, clock.now_ms(), &lanes)
        })
        .await
}

struct Proven {
    owner: Owner,
    held: String,
    replacement: Option<String>,
}

async fn prove(app: &App, email: &str, password: String) -> Result<Option<Proven>> {
    let email = email.to_string();
    let found = app
        .db
        .read(move |tx| {
            let Some(owner) = owner::read(tx)?.filter(|owner| owner.email == email) else {
                return Ok(None);
            };
            let held = owner::stored_password(tx, &owner.id)?;
            Ok(held.map(|held| (owner, held)))
        })
        .await?;
    let stored = found.as_ref().map(|(_, held)| held.as_str());
    let checked = app.passwords.check(stored, password.clone()).await?;
    if checked == Checked::Wrong {
        return Ok(None);
    }
    let Some((owner, held)) = found else {
        return Ok(None);
    };
    let replacement = match checked {
        Checked::RightButDated => Some(app.passwords.hash(password).await?),
        _ => None,
    };
    Ok(Some(Proven {
        owner,
        held,
        replacement,
    }))
}

impl Proven {
    /// Closes the gap a change could slip through while the hash was being checked.
    fn stands(&self, tx: &Transaction<'_>, at: &str) -> Result<bool> {
        if owner::read(tx)?.is_none_or(|owner| owner.email != self.owner.email) {
            return Ok(false);
        }
        let held = owner::stored_password(tx, &self.owner.id)?;
        if held.as_deref() != Some(self.held.as_str()) {
            return Ok(false);
        }
        if let Some(hash) = &self.replacement {
            owner::set_password(tx, &self.owner.id, hash, Stamp::read(at)?)?;
        }
        Ok(true)
    }
}

async fn refused_sign_in(app: &App, email: &str, reason: &str, visit: &Visit) -> Result<()> {
    let clock = app.clock.clone();
    let email = email.to_string();
    let reason = reason.to_string();
    let visit = visit.clone();
    app.db
        .write(Write::caller(SIGN_IN_FAILED), move |tx| {
            note(
                tx,
                &clock.stamp(),
                None,
                &visit,
                Note {
                    action: SIGN_IN_FAILED,
                    resource_type: "auth_user",
                    resource_id: &email,
                    details: Some(json!({
                        "email": email,
                        "method": "password",
                        "reason": reason,
                    })),
                },
            )
        })
        .await
}

pub async fn with_password(
    app: &App,
    email: String,
    password: String,
    remembered: bool,
    visit: Visit,
) -> Result<Opened> {
    let email = limits::account_key(&email);
    if let Some(wait) = count(app, &email, &visit).await? {
        refused_sign_in(app, &email, TOO_MANY, &visit).await?;
        return Err(too_many_passwords(wait));
    }
    let proven = match prove(app, &email, password).await {
        Ok(Some(proven)) => proven,
        Ok(None) => {
            refused_sign_in(app, &email, INVALID, &visit).await?;
            return Err(wrong_credentials());
        }
        Err(refusal) if refusal.code == Code::RateLimited => {
            refused_sign_in(app, &email, TOO_MANY, &visit).await?;
            return Err(refusal);
        }
        Err(refusal) => return Err(refusal),
    };
    let clock = app.clock.clone();
    let salt = app.settings.start.key_salt.clone();
    let audited = visit.clone();
    let named = email.clone();
    let opened = app
        .db
        .write(Write::caller(SIGNED_IN), move |tx| {
            let at = clock.stamp();
            if !proven.stands(tx, &at)? {
                return Ok(None);
            }
            let opened = session::open(
                tx,
                Stamp::read(&at)?,
                New {
                    salt: &salt,
                    user_id: &proven.owner.id,
                    remembered,
                    visit: &audited,
                },
            )?;
            note(
                tx,
                &at,
                None,
                &audited,
                Note {
                    action: SIGNED_IN,
                    resource_type: "auth_user",
                    resource_id: &named,
                    details: Some(json!({ "email": named, "method": "password" })),
                },
            )?;
            Ok(Some(opened))
        })
        .await?;
    match opened {
        Some(opened) => Ok(opened),
        None => {
            refused_sign_in(app, &email, INVALID, &visit).await?;
            Err(wrong_credentials())
        }
    }
}

pub async fn confirm(app: &App, caller: &Caller, password: String, visit: Visit) -> Result<Opened> {
    let session = caller.session().ok_or_else(unauthorized)?.clone();
    let owner = owner::find(app).await?.ok_or_else(unauthorized)?;
    if let Some(wait) = count(app, &owner.email, &visit).await? {
        return Err(too_many_passwords(wait));
    }
    let proven = prove(app, &owner.email, password)
        .await?
        .ok_or_else(|| Refusal::new(Code::Unauthorized, "That password is not right."))?;
    let salt = app.settings.start.key_salt.clone();
    app.write(caller, SIGNED_IN, move |unit| {
        let tx = unit.tx();
        if !proven.stands(tx, &unit.at)? {
            return Err(Refusal::new(
                Code::Unauthorized,
                "That password is not right.",
            ));
        }
        let opened = session::open(
            tx,
            unit.instant,
            New {
                salt: &salt,
                user_id: &session.user_id,
                remembered: session.remembered,
                visit: &visit,
            },
        )?;
        session::end_replaced(tx, &unit.at, &unit.caller, &visit, &session)?;
        note(
            tx,
            &unit.at,
            Some(&unit.caller),
            &visit,
            Note {
                action: SIGNED_IN,
                resource_type: "auth_user",
                resource_id: &proven.owner.email,
                details: Some(json!({
                    "email": proven.owner.email,
                    "method": "password",
                    "confirmed_session": session.id,
                })),
            },
        )?;
        Ok(opened)
    })
    .await
}

async fn refused_change(
    app: &App,
    caller: &Caller,
    owner_id: &str,
    reason: &str,
    visit: &Visit,
) -> Result<()> {
    let owner_id = owner_id.to_string();
    let details: Value = json!({ "reason": reason });
    let visit = visit.clone();
    app.write(caller, CHANGE_FAILED, move |unit| {
        note(
            unit.tx(),
            &unit.at,
            Some(&unit.caller),
            &visit,
            Note {
                action: CHANGE_FAILED,
                resource_type: "owner",
                resource_id: &owner_id,
                details: Some(details),
            },
        )
    })
    .await
}

pub async fn change_password(
    app: &App,
    caller: &Caller,
    current: String,
    new: String,
    visit: Visit,
) -> Result<()> {
    let session = caller.session().ok_or_else(unauthorized)?.clone();
    let owner = owner::find(app).await?.ok_or_else(unauthorized)?;
    if let Some(wait) = count(app, &owner.email, &visit).await? {
        refused_change(app, caller, &owner.id, TOO_MANY, &visit).await?;
        return Err(too_many_passwords(wait));
    }
    password::check_new(&new)?;
    let Some(proven) = prove(app, &owner.email, current).await? else {
        refused_change(app, caller, &owner.id, INVALID, &visit).await?;
        return Err(Refusal::new(
            Code::Unauthorized,
            "The current password is not right.",
        ));
    };
    let hash = app.passwords.hash(new).await?;
    let audited = visit.clone();
    let changed = app
        .write(caller, CHANGED, move |unit| {
            let tx = unit.tx();
            if !proven.stands(tx, &unit.at)? {
                return Ok(false);
            }
            owner::set_password(tx, &proven.owner.id, &hash, unit.instant)?;
            session::end_all(
                tx,
                &unit.at,
                &unit.caller,
                &audited,
                &proven.owner.id,
                Some(&session.id),
            )?;
            limits::clear_account(tx, &proven.owner.email)?;
            note(
                tx,
                &unit.at,
                Some(&unit.caller),
                &audited,
                Note {
                    action: CHANGED,
                    resource_type: "owner",
                    resource_id: &proven.owner.id,
                    details: None,
                },
            )?;
            Ok(true)
        })
        .await?;
    if changed {
        return Ok(());
    }
    refused_change(app, caller, &owner.id, INVALID, &visit).await?;
    Err(Refusal::new(
        Code::Unauthorized,
        "The current password is not right.",
    ))
}

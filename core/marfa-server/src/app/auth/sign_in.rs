//! Everything that checks the owner's password. Each counts the attempt, checks the hash off the
//! writer, then acts in one transaction that finds the password as it was checked. Only a wrong
//! password stays counted.

use rusqlite::Transaction;
use serde_json::json;

use super::device::Known;
use super::limits::{self, too_many_passwords};
use super::owner::{self, Owner};
use super::password::Checked;
use super::session::{self, New, Opened};
use super::{Note, Visit, note};
use crate::app::App;
use crate::app::access::{Caller, unauthorized};
use crate::app::clock::Stamp;
use crate::app::refusal::{Code, Refusal, Result};
use crate::db::Write;

pub(super) const SIGNED_IN: &str = "auth.sign_in.success";
pub(super) const SIGN_IN_FAILED: &str = "auth.sign_in.failed";
const INVALID: &str = "invalid_credentials";
const TOO_MANY: &str = "too_many_attempts";

fn wrong_credentials() -> Refusal {
    Refusal::new(Code::Unauthorized, "Invalid email or password.")
}

/// Counts the attempt before `attempt` runs, and takes it back unless the password was wrong.
async fn counted<T>(
    app: &App,
    email: &str,
    owner: Option<&str>,
    device: Option<&Known>,
    visit: &Visit,
    attempt: impl Future<Output = Result<T>>,
) -> Result<std::result::Result<T, i64>> {
    let lanes = limits::password_lanes(email, owner, visit.address, device);
    let admitted_ms = app.clock.now_ms();
    if let Some(wait) = app.limiter.admit(admitted_ms, &lanes) {
        return Ok(Err(wait));
    }
    let outcome = attempt.await;
    if !matches!(&outcome, Err(refusal) if refusal.code == Code::Unauthorized) {
        limits::give_back(app, admitted_ms, &lanes);
    }
    outcome.map(Ok)
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
                    resource_type: "owner",
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
    device: Option<&Known>,
    visit: Visit,
) -> Result<Opened> {
    let email = limits::account_key(&email);
    let owner = owner::find(app).await?.map(|owner| owner.email);
    let attempt = open_with_password(app, &email, password, &visit);
    match counted(app, &email, owner.as_deref(), device, &visit, attempt).await? {
        Ok(opened) => Ok(opened),
        Err(wait) => {
            refused_sign_in(app, &email, TOO_MANY, &visit).await?;
            Err(too_many_passwords(wait))
        }
    }
}

async fn open_with_password(
    app: &App,
    email: &str,
    password: String,
    visit: &Visit,
) -> Result<Opened> {
    let proven = match prove(app, email, password).await {
        Ok(Some(proven)) => proven,
        Ok(None) => {
            refused_sign_in(app, email, INVALID, visit).await?;
            return Err(wrong_credentials());
        }
        Err(refusal) if refusal.code == Code::RateLimited => {
            refused_sign_in(app, email, TOO_MANY, visit).await?;
            return Err(refusal);
        }
        Err(refusal) => return Err(refusal),
    };
    let clock = app.clock.clone();
    let salt = app.settings.start.key_salt.clone();
    let audited = visit.clone();
    let named = email.to_string();
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
                    owner_id: &proven.owner.id,
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
                    resource_type: "owner",
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
            refused_sign_in(app, email, INVALID, visit).await?;
            Err(wrong_credentials())
        }
    }
}

pub async fn confirm(
    app: &App,
    caller: &Caller,
    password: String,
    device: Option<&Known>,
    visit: Visit,
) -> Result<Opened> {
    let session = caller.session().ok_or_else(unauthorized)?.clone();
    let owner = owner::find(app).await?.ok_or_else(unauthorized)?;
    let email = owner.email.clone();
    let attempt = reopen(app, caller, session, &email, password, visit.clone());
    match counted(app, &email, Some(&email), device, &visit, attempt).await? {
        Ok(opened) => Ok(opened),
        Err(wait) => Err(too_many_passwords(wait)),
    }
}

async fn reopen(
    app: &App,
    caller: &Caller,
    session: session::Session,
    email: &str,
    password: String,
    visit: Visit,
) -> Result<Opened> {
    let proven = prove(app, email, password)
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
                owner_id: &session.owner_id,
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
                resource_type: "owner",
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

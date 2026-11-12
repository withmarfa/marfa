//! Everything that checks the owner's password. Each counts the attempt, checks the hash off the
//! writer, then acts in one transaction that finds the password as it was checked. Only an
//! attempt whose password proved right is taken back.

use rusqlite::Transaction;
use serde_json::json;

use super::device::{Holder, Known};
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
const PASSWORD_CHANGED: &str = "owner.password.changed";
const INVALID: &str = "invalid_credentials";
const TOO_MANY: &str = "too_many_attempts";

fn wrong_credentials() -> Refusal {
    Refusal::new(Code::Unauthorized, "Invalid email or password.")
}

/// The outcome of a password check, and whether the password proved right on the way.
struct Tried<T> {
    proven: bool,
    outcome: Result<T>,
}

impl<T> Tried<T> {
    fn unproven(outcome: Result<T>) -> Tried<T> {
        Tried {
            proven: false,
            outcome,
        }
    }
}

/// Counts the attempt before `attempt` runs, and takes it back once its password proved right.
async fn counted<T>(
    app: &App,
    email: &str,
    owner: Option<&str>,
    device: Option<&Known>,
    visit: &Visit,
    attempt: impl Future<Output = Tried<T>>,
) -> Result<std::result::Result<T, i64>> {
    let lanes = limits::password_lanes(email, owner, visit.address, device);
    let admitted_ms = app.clock.now_ms();
    if let Some(wait) = app.limiter.admit(admitted_ms, &lanes) {
        return Ok(Err(wait));
    }
    let tried = attempt.await;
    if tried.proven {
        limits::give_back(app, admitted_ms, &lanes);
    }
    tried.outcome.map(Ok)
}

/// A sign-in that opened a session, and the device mark it leaves.
pub struct SignedIn {
    pub opened: Opened,
    pub device: String,
}

/// The owner as a device mark is signed for them now.
struct Current {
    owner: Owner,
    credentials: i64,
}

impl Current {
    fn holder(&self) -> Holder<'_> {
        Holder {
            owner_id: &self.owner.id,
            credentials: self.credentials,
        }
    }
}

async fn current(app: &App) -> Result<Option<Current>> {
    app.db
        .read(|tx| {
            let Some(owner) = owner::read(tx)? else {
                return Ok(None);
            };
            let credentials = owner::credentials(tx, &owner.id)?.ok_or_else(owner::not_found)?;
            Ok(Some(Current { owner, credentials }))
        })
        .await
}

/// The device `mark` names, if it was signed for the owner's credentials as they stand.
fn known(app: &App, current: Option<&Current>, mark: Option<&str>) -> Option<Known> {
    app.devices
        .read(current?.holder(), mark?, app.clock.now_ms())
}

/// Whose session opened, and the credentials as the transaction that opened it found them.
struct Opening {
    opened: Opened,
    owner_id: String,
    credentials: i64,
}

impl Opening {
    fn signed_in(self, app: &App, known: Option<&Known>) -> Result<SignedIn> {
        let holder = Holder {
            owner_id: &self.owner_id,
            credentials: self.credentials,
        };
        let device = app.devices.mark(holder, known, app.clock.now_ms())?;
        Ok(SignedIn {
            opened: self.opened,
            device,
        })
    }
}

struct Proven {
    owner: Owner,
    held: String,
    replacement: Option<String>,
}

/// `rehash` replaces a hash made under older settings once the password proves right.
async fn prove(app: &App, email: &str, password: String, rehash: bool) -> Result<Option<Proven>> {
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
        Checked::RightButDated if rehash => Some(app.passwords.hash(password).await?),
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
            owner::rehash(tx, &self.owner.id, hash, Stamp::read(at)?)?;
        }
        Ok(true)
    }

    fn credentials(&self, tx: &Transaction<'_>) -> Result<i64> {
        owner::credentials(tx, &self.owner.id)?.ok_or_else(owner::not_found)
    }
}

async fn refused_sign_in(
    app: &App,
    actor: Option<&Caller>,
    email: &str,
    reason: &str,
    visit: &Visit,
) -> Result<()> {
    let clock = app.clock.clone();
    let actor = actor.cloned();
    let email = email.to_string();
    let reason = reason.to_string();
    let visit = visit.clone();
    app.db
        .write(Write::caller(SIGN_IN_FAILED), move |tx| {
            note(
                tx,
                &clock.stamp(),
                actor.as_ref(),
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

/// Signs in with a password. `mark` is the device cookie the browser sent, if any.
pub async fn with_password(
    app: &App,
    email: String,
    password: String,
    mark: Option<&str>,
    visit: Visit,
) -> Result<SignedIn> {
    let email = limits::account_key(&email);
    let current = current(app).await?;
    let known = known(app, current.as_ref(), mark);
    let owner = current.as_ref().map(|current| current.owner.email.as_str());
    let attempt = open_with_password(app, &email, password, &visit);
    match counted(app, &email, owner, known.as_ref(), &visit, attempt).await? {
        Ok(opening) => opening.signed_in(app, known.as_ref()),
        Err(wait) => {
            refused_sign_in(app, None, &email, TOO_MANY, &visit).await?;
            Err(too_many_passwords(wait))
        }
    }
}

async fn refused<T>(
    app: &App,
    actor: Option<&Caller>,
    email: &str,
    reason: &str,
    visit: &Visit,
    refusal: Refusal,
) -> Result<T> {
    refused_sign_in(app, actor, email, reason, visit).await?;
    Err(refusal)
}

async fn open_with_password(
    app: &App,
    email: &str,
    password: String,
    visit: &Visit,
) -> Tried<Opening> {
    let proven = match prove(app, email, password, true).await {
        Ok(Some(proven)) => proven,
        Ok(None) => {
            return Tried::unproven(
                refused(app, None, email, INVALID, visit, wrong_credentials()).await,
            );
        }
        Err(refusal) if refusal.code == Code::RateLimited => {
            return Tried::unproven(refused(app, None, email, TOO_MANY, visit, refusal).await);
        }
        Err(refusal) => return Tried::unproven(Err(refusal)),
    };
    Tried {
        proven: true,
        outcome: open(app, email, proven, visit).await,
    }
}

async fn open(app: &App, email: &str, proven: Proven, visit: &Visit) -> Result<Opening> {
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
            let opening = Opening {
                opened,
                owner_id: proven.owner.id.clone(),
                credentials: proven.credentials(tx)?,
            };
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
            Ok(Some(opening))
        })
        .await?;
    match opened {
        Some(opening) => Ok(opening),
        None => refused(app, None, email, INVALID, visit, wrong_credentials()).await,
    }
}

/// Confirms the signed-in owner by their password. `mark` is the device cookie, if any.
pub async fn confirm(
    app: &App,
    caller: &Caller,
    password: String,
    mark: Option<&str>,
    visit: Visit,
) -> Result<SignedIn> {
    let session = caller.session().ok_or_else(unauthorized)?.clone();
    let current = current(app).await?.ok_or_else(unauthorized)?;
    let known = known(app, Some(&current), mark);
    let email = current.owner.email.clone();
    let attempt = reopen(app, caller, session, &email, password, visit.clone());
    match counted(app, &email, Some(&email), known.as_ref(), &visit, attempt).await? {
        Ok(opening) => opening.signed_in(app, known.as_ref()),
        Err(wait) => {
            refused_sign_in(app, Some(caller), &email, TOO_MANY, &visit).await?;
            Err(too_many_passwords(wait))
        }
    }
}

fn not_right() -> Refusal {
    Refusal::new(Code::Unauthorized, "That password is not right.")
}

async fn reopen(
    app: &App,
    caller: &Caller,
    session: session::Session,
    email: &str,
    password: String,
    visit: Visit,
) -> Tried<Opening> {
    let actor = Some(caller);
    match prove(app, email, password, true).await {
        Ok(Some(proven)) => {
            let outcome = match confirmed(app, caller, session, proven, visit.clone()).await {
                Ok(Some(opening)) => Ok(opening),
                Ok(None) => refused(app, actor, email, INVALID, &visit, not_right()).await,
                Err(refusal) => Err(refusal),
            };
            Tried {
                proven: true,
                outcome,
            }
        }
        Ok(None) => Tried::unproven(refused(app, actor, email, INVALID, &visit, not_right()).await),
        Err(refusal) if refusal.code == Code::RateLimited => {
            Tried::unproven(refused(app, actor, email, TOO_MANY, &visit, refusal).await)
        }
        Err(refusal) => Tried::unproven(Err(refusal)),
    }
}

async fn confirmed(
    app: &App,
    caller: &Caller,
    session: session::Session,
    proven: Proven,
    visit: Visit,
) -> Result<Option<Opening>> {
    let salt = app.settings.start.key_salt.clone();
    app.write(caller, SIGNED_IN, move |unit| {
        let tx = unit.tx();
        if !proven.stands(tx, &unit.at)? {
            return Ok(None);
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
        Ok(Some(Opening {
            opened,
            owner_id: proven.owner.id.clone(),
            credentials: proven.credentials(tx)?,
        }))
    })
    .await
}

/// Ends the owner's other browser sessions too, and answers this browser's new device mark.
pub async fn change_password(
    app: &App,
    caller: &Caller,
    current_password: String,
    new_password: String,
    mark: Option<&str>,
    visit: Visit,
) -> Result<String> {
    let session = caller.session().ok_or_else(unauthorized)?.clone();
    password::check_new(&new_password, "new_password")?;
    let current = current(app).await?.ok_or_else(unauthorized)?;
    let known = known(app, Some(&current), mark);
    let email = current.owner.email.clone();
    let attempt = replace(
        app,
        caller,
        session,
        &email,
        current_password,
        new_password,
        visit.clone(),
    );
    match counted(app, &email, Some(&email), known.as_ref(), &visit, attempt).await? {
        Ok((owner_id, credentials)) => {
            limits::clear_account(&app.limiter, &email);
            let holder = Holder {
                owner_id: &owner_id,
                credentials,
            };
            app.devices.mark(holder, known.as_ref(), app.clock.now_ms())
        }
        Err(wait) => {
            refused_sign_in(app, Some(caller), &email, TOO_MANY, &visit).await?;
            Err(too_many_passwords(wait))
        }
    }
}

fn current_not_right() -> Refusal {
    Refusal::new(Code::Unauthorized, "Your current password isn't right.")
}

async fn replace(
    app: &App,
    caller: &Caller,
    session: session::Session,
    email: &str,
    current_password: String,
    new_password: String,
    visit: Visit,
) -> Tried<(String, i64)> {
    let actor = Some(caller);
    match prove(app, email, current_password, false).await {
        Ok(Some(proven)) => {
            let changed = replaced(app, caller, session, proven, new_password, visit.clone());
            let outcome = match changed.await {
                Ok(Some(changed)) => Ok(changed),
                Ok(None) => refused(app, actor, email, INVALID, &visit, current_not_right()).await,
                Err(refusal) => Err(refusal),
            };
            Tried {
                proven: true,
                outcome,
            }
        }
        Ok(None) => {
            Tried::unproven(refused(app, actor, email, INVALID, &visit, current_not_right()).await)
        }
        Err(refusal) if refusal.code == Code::RateLimited => {
            Tried::unproven(refused(app, actor, email, TOO_MANY, &visit, refusal).await)
        }
        Err(refusal) => Tried::unproven(Err(refusal)),
    }
}

async fn replaced(
    app: &App,
    caller: &Caller,
    session: session::Session,
    proven: Proven,
    new_password: String,
    visit: Visit,
) -> Result<Option<(String, i64)>> {
    let hash = app.passwords.hash(new_password).await?;
    app.write(caller, PASSWORD_CHANGED, move |unit| {
        let tx = unit.tx();
        if !proven.stands(tx, &unit.at)? {
            return Ok(None);
        }
        let owner_id = &proven.owner.id;
        owner::set_password(tx, owner_id, &hash, unit.instant)?;
        session::end_all(
            tx,
            &unit.at,
            &unit.caller,
            &visit,
            owner_id,
            Some(&session.id),
        )?;
        note(
            tx,
            &unit.at,
            Some(&unit.caller),
            &visit,
            Note {
                action: PASSWORD_CHANGED,
                resource_type: "owner",
                resource_id: owner_id,
                details: None,
            },
        )?;
        Ok(Some((owner_id.clone(), proven.credentials(tx)?)))
    })
    .await
}

//! Everything that checks the owner's password. Each counts the attempt, checks the hash off the
//! writer, then acts in one transaction that finds the password as it was checked. Only an
//! attempt whose right password was let act is taken back.

use std::sync::Arc;

use rusqlite::Transaction;
use serde_json::json;

use super::allowance::{self, CHANGE_REFUSED, CONFIRM_REFUSED, Door, SIGN_IN_REFUSED};
use super::device::{Holder, Known};
use super::limits::{self, PasswordLanes, Sender, too_many_passwords};
use super::owner::{self, Owner};
use super::password::{self, Checked, Queue, Turn};
use super::session::{self, New, Opened};
use super::{Note, Visit, note};
use crate::app::App;
use crate::app::access::{Caller, unauthorized};
use crate::app::clock::Stamp;
use crate::app::limiter::Lane;
use crate::app::refusal::{Code, Refusal, Result};
use crate::db::Write;

pub(super) const SIGNED_IN: &str = "auth.sign_in.success";
pub(super) const SIGN_IN_FAILED: &str = "auth.sign_in.failed";
const PASSWORD_CHANGED: &str = "owner.password.changed";
const INVALID: &str = "invalid_credentials";
const TOO_MANY: &str = "too_many_attempts";

fn wrong_credentials() -> Refusal {
    Refusal::new(Code::Unauthorized, "Invalid username or password.")
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

/// Where an attempt stands once it is counted.
#[derive(Clone, Copy, Debug)]
struct Gate {
    /// The wait while every stranger's hour is spent; a judged attempt is still answered `429`.
    spent: Option<i64>,
    /// Whether the password is checked: only an attempt a right password could sign in is.
    judged: bool,
}

impl Gate {
    /// An attempt not checked waits where a checked one at its username would: in the open queue
    /// while every stranger's hour has room, and after that, in its username's own queue.
    fn turn(self, username: &str, queue: Queue) -> Turn<'_> {
        match (self.judged, self.spent) {
            (true, _) => Turn::Check(queue),
            (false, None) => Turn::StandIn(None),
            (false, Some(_)) => Turn::StandIn(Some(username)),
        }
    }
}

/// Counts the attempt before `attempt` runs, and takes it back once its right password acted.
async fn counted<T, F>(
    app: &App,
    lanes: &PasswordLanes,
    attempt: impl FnOnce(Gate) -> F,
) -> Result<std::result::Result<T, i64>>
where
    F: Future<Output = Tried<T>>,
{
    let admitted_ms = app.clock.now_ms();
    if let Some(wait) = app.limiter.admit(admitted_ms, &lanes.before) {
        let shared = app.limiter.spent(admitted_ms, lanes.shared.as_slice());
        return Ok(Err(shared.map_or(wait, |shared| shared.max(wait))));
    }
    let one = |lane: &Lane| app.limiter.admit(admitted_ms, std::slice::from_ref(lane));
    let spent = lanes.shared.as_ref().and_then(one);
    let owner = lanes.owner.as_ref().map(|lane| one(lane).is_none());
    let gate = Gate {
        spent,
        judged: owner.unwrap_or(spent.is_none()),
    };
    let tried = attempt(gate).await;
    if tried.proven {
        limits::give_back(app, admitted_ms, &lanes.all());
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
async fn prove(
    app: &App,
    username: &str,
    password: String,
    rehash: bool,
    turn: Turn<'_>,
) -> Result<Option<Proven>> {
    let named = username.to_string();
    let found = app
        .db
        .read(move |tx| {
            let Some(owner) = owner::read(tx)?.filter(|owner| owner.username == named) else {
                return Ok(None);
            };
            let held = owner::stored_password(tx, &owner.id)?;
            Ok(held.map(|held| (owner, held)))
        })
        .await?;
    let queue = match turn {
        Turn::Check(queue) => queue,
        Turn::StandIn(at) => {
            app.passwords.wait_as_a_check(at).await?;
            return Ok(None);
        }
    };
    let stored = found.as_ref().map(|(_, held)| held.as_str());
    let checked = app.passwords.check(stored, password.clone(), queue).await?;
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
        if owner::read(tx)?.is_none_or(|owner| owner.username != self.owner.username) {
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

/// The record of a refused password sign-in.
struct Refused {
    actor: Option<Caller>,
    username: String,
    reason: &'static str,
    visit: Visit,
    left_out: u64,
}

impl Refused {
    async fn write(&self, app: &App) -> Result<()> {
        let clock = app.clock.clone();
        let actor = self.actor.clone();
        let username = self.username.clone();
        let reason = self.reason;
        let visit = self.visit.clone();
        let left_out = self.left_out;
        app.db
            .write(Write::caller(SIGN_IN_FAILED), move |tx| {
                let details =
                    json!({ "username": username, "method": "password", "reason": reason });
                note(
                    tx,
                    &clock.instant().text(),
                    actor.as_ref(),
                    &visit,
                    Note {
                        action: SIGN_IN_FAILED,
                        resource_type: "owner",
                        resource_id: &username,
                        details: Some(allowance::with_unrecorded_before(details, left_out)),
                    },
                )
            })
            .await
    }
}

/// Signs in with a password. `mark` is the device cookie the browser sent, if any.
pub async fn with_password(
    app: &Arc<App>,
    username: String,
    password: String,
    mark: Option<&str>,
    visit: Visit,
) -> Result<SignedIn> {
    let username = limits::account_key(&username);
    let current = current(app).await?;
    let known = known(app, current.as_ref(), mark);
    let queue = if known.is_some() {
        Queue::Owner
    } else {
        Queue::Open
    };
    let sender = match &known {
        Some(known) => Sender::Known(known),
        None => Sender::Stranger {
            owners_username: current
                .as_ref()
                .is_some_and(|now| now.owner.username == username),
        },
    };
    let lanes = limits::password_lanes(&username, visit.address, sender);
    let attempt = |gate| open_with_password(app, &username, password, queue, &visit, gate);
    match counted(app, &lanes, attempt).await? {
        Ok(opening) => opening.signed_in(app, known.as_ref()),
        Err(wait) => {
            limited(
                app,
                None,
                &username,
                SIGN_IN_REFUSED,
                &visit,
                too_many_passwords(wait),
            )
            .await
        }
    }
}

async fn refused<T>(
    app: &App,
    actor: Option<&Caller>,
    username: &str,
    reason: &'static str,
    visit: &Visit,
    refusal: Refusal,
) -> Result<T> {
    let record = Refused {
        actor: actor.cloned(),
        username: username.to_string(),
        reason,
        visit: visit.clone(),
        left_out: 0,
    };
    record.write(app).await?;
    Err(refusal)
}

/// The task owns settlement because the caller can disconnect.
async fn limited<T>(
    app: &Arc<App>,
    actor: Option<&Caller>,
    username: &str,
    door: Door,
    visit: &Visit,
    refusal: Refusal,
) -> Result<T> {
    let Some(left_out) = app.refusal_records.begin(door, app.clock.now_ms()) else {
        return Err(refusal);
    };
    let record = Refused {
        actor: actor.cloned(),
        username: username.to_string(),
        reason: TOO_MANY,
        visit: visit.clone(),
        left_out,
    };
    let app = Arc::clone(app);
    tokio::spawn(async move {
        let written = record.write(&app).await;
        app.refusal_records
            .settle(door, record.left_out, &written, app.clock.now_ms());
        match written {
            Err(failed) if !failed.commit_failed => Err(failed),
            _ => Ok(()),
        }
    })
    .await
    .map_err(|_| Refusal::internal("a refusal's record was not settled"))??;
    Err(refusal)
}

async fn open_with_password(
    app: &Arc<App>,
    username: &str,
    password: String,
    queue: Queue,
    visit: &Visit,
    gate: Gate,
) -> Tried<Opening> {
    let proven = match prove(app, username, password, true, gate.turn(username, queue)).await {
        Ok(Some(proven)) => proven,
        Ok(None) => return Tried::unproven(answered_wrong(app, username, visit, gate).await),
        Err(refusal) if refusal.code == Code::RateLimited => {
            let refusal = gate.spent.map_or(refusal, too_many_passwords);
            return Tried::unproven(
                limited(app, None, username, SIGN_IN_REFUSED, visit, refusal).await,
            );
        }
        Err(refusal) => return Tried::unproven(Err(refusal)),
    };
    Tried {
        proven: true,
        outcome: open(app, username, proven, visit).await,
    }
}

async fn answered_wrong<T>(app: &Arc<App>, username: &str, visit: &Visit, gate: Gate) -> Result<T> {
    match gate.spent {
        Some(wait) => {
            limited(
                app,
                None,
                username,
                SIGN_IN_REFUSED,
                visit,
                too_many_passwords(wait),
            )
            .await
        }
        None => refused(app, None, username, INVALID, visit, wrong_credentials()).await,
    }
}

/// The lanes of a door only a caller holding the owner's credential reaches.
fn owner_lanes(current: &Current, known: Option<&Known>, visit: &Visit) -> PasswordLanes {
    let sender = match known {
        Some(known) => Sender::Known(known),
        None => Sender::Credential,
    };
    limits::password_lanes(&current.owner.username, visit.address, sender)
}

async fn open(app: &App, username: &str, proven: Proven, visit: &Visit) -> Result<Opening> {
    let clock = app.clock.clone();
    let salt = app.settings.start.key_salt.clone();
    let audited = visit.clone();
    let named = username.to_string();
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
                    details: Some(json!({ "username": named, "method": "password" })),
                },
            )?;
            Ok(Some(opening))
        })
        .await?;
    match opened {
        Some(opening) => Ok(opening),
        None => refused(app, None, username, INVALID, visit, wrong_credentials()).await,
    }
}

/// Confirms the signed-in owner by their password. `mark` is the device cookie, if any.
pub async fn confirm(
    app: &Arc<App>,
    caller: &Caller,
    password: String,
    mark: Option<&str>,
    visit: Visit,
) -> Result<SignedIn> {
    let session = caller.session().ok_or_else(unauthorized)?.clone();
    let current = current(app).await?.ok_or_else(unauthorized)?;
    let known = known(app, Some(&current), mark);
    let username = current.owner.username.clone();
    let lanes = owner_lanes(&current, known.as_ref(), &visit);
    let attempt = |_| reopen(app, caller, session, &username, password, visit.clone());
    match counted(app, &lanes, attempt).await? {
        Ok(opening) => opening.signed_in(app, known.as_ref()),
        Err(wait) => {
            let refusal = too_many_passwords(wait);
            limited(
                app,
                Some(caller),
                &username,
                CONFIRM_REFUSED,
                &visit,
                refusal,
            )
            .await
        }
    }
}

fn not_right() -> Refusal {
    Refusal::new(Code::Unauthorized, "That password is not right.")
}

async fn reopen(
    app: &Arc<App>,
    caller: &Caller,
    session: session::Session,
    username: &str,
    password: String,
    visit: Visit,
) -> Tried<Opening> {
    let actor = Some(caller);
    match prove(app, username, password, true, Turn::Check(Queue::Owner)).await {
        Ok(Some(proven)) => {
            let outcome = match confirmed(app, caller, session, proven, visit.clone()).await {
                Ok(Some(opening)) => Ok(opening),
                Ok(None) => refused(app, actor, username, INVALID, &visit, not_right()).await,
                Err(refusal) => Err(refusal),
            };
            Tried {
                proven: true,
                outcome,
            }
        }
        Ok(None) => {
            Tried::unproven(refused(app, actor, username, INVALID, &visit, not_right()).await)
        }
        Err(refusal) if refusal.code == Code::RateLimited => {
            Tried::unproven(limited(app, actor, username, CONFIRM_REFUSED, &visit, refusal).await)
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
        session::end_replaced(
            tx,
            &unit.at,
            &unit.caller,
            &visit,
            &session,
            &opened.session,
        )?;
        note(
            tx,
            &unit.at,
            Some(&unit.caller),
            &visit,
            Note {
                action: SIGNED_IN,
                resource_type: "owner",
                resource_id: &proven.owner.username,
                details: Some(json!({
                    "username": proven.owner.username,
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

/// What a password change leaves: the owner, and the credentials as the change committed them.
pub struct Changed {
    owner_id: String,
    credentials: i64,
    known: Option<Known>,
}

impl Changed {
    /// This browser's new device mark.
    pub fn device(&self, app: &App) -> Result<String> {
        let holder = Holder {
            owner_id: &self.owner_id,
            credentials: self.credentials,
        };
        app.devices
            .mark(holder, self.known.as_ref(), app.clock.now_ms())
    }
}

/// Ends every browser session but the caller's own, and every device cookie.
pub async fn change_password(
    app: &Arc<App>,
    caller: &Caller,
    current_password: String,
    new_password: String,
    mark: Option<&str>,
    visit: Visit,
) -> Result<Changed> {
    password::check_new(&new_password, "new_password")?;
    let current = current(app).await?.ok_or_else(unauthorized)?;
    let known = known(app, Some(&current), mark);
    let username = current.owner.username.clone();
    let lanes = owner_lanes(&current, known.as_ref(), &visit);
    let attempt = |_| {
        replace(
            app,
            caller,
            &username,
            current_password,
            new_password,
            visit.clone(),
        )
    };
    match counted(app, &lanes, attempt).await? {
        Ok((owner_id, credentials)) => {
            limits::clear_for_new_password(&app.limiter);
            Ok(Changed {
                owner_id,
                credentials,
                known,
            })
        }
        Err(wait) => {
            let refusal = too_many_passwords(wait);
            limited(
                app,
                Some(caller),
                &username,
                CHANGE_REFUSED,
                &visit,
                refusal,
            )
            .await
        }
    }
}

fn current_not_right() -> Refusal {
    Refusal::new(Code::Unauthorized, "Your current password isn't right.")
}

async fn replace(
    app: &Arc<App>,
    caller: &Caller,
    username: &str,
    current_password: String,
    new_password: String,
    visit: Visit,
) -> Tried<(String, i64)> {
    let actor = Some(caller);
    match prove(
        app,
        username,
        current_password,
        false,
        Turn::Check(Queue::Owner),
    )
    .await
    {
        Ok(Some(proven)) => {
            let changed = replaced(app, caller, proven, new_password, visit.clone());
            let outcome = match changed.await {
                Ok(Some(changed)) => Ok(changed),
                Ok(None) => {
                    refused(app, actor, username, INVALID, &visit, current_not_right()).await
                }
                Err(refusal) => Err(refusal),
            };
            Tried {
                proven: true,
                outcome,
            }
        }
        Ok(None) => Tried::unproven(
            refused(app, actor, username, INVALID, &visit, current_not_right()).await,
        ),
        Err(refusal) if refusal.code == Code::RateLimited => {
            Tried::unproven(limited(app, actor, username, CHANGE_REFUSED, &visit, refusal).await)
        }
        Err(refusal) => Tried::unproven(Err(refusal)),
    }
}

async fn replaced(
    app: &App,
    caller: &Caller,
    proven: Proven,
    new_password: String,
    visit: Visit,
) -> Result<Option<(String, i64)>> {
    let hash = app.passwords.hash(new_password).await?;
    let keeping = caller.session().map(|session| session.id.clone());
    app.write(caller, PASSWORD_CHANGED, move |unit| {
        unit.caller.require_passkeys()?;
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
            keeping.as_deref(),
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

#[cfg(test)]
mod tests {
    use std::net::IpAddr;
    use std::time::Duration;

    use tempfile::TempDir;

    use super::super::claim::{self, Proof};
    use super::super::owner::Details;
    use super::*;
    use crate::settings::{Environment, Settings};

    const USERNAME: &str = "owner";
    const PASSWORD: &str = "a good long password";

    async fn claimed() -> (TempDir, Arc<App>) {
        claimed_as(USERNAME).await
    }

    async fn claimed_as(username: &str) -> (TempDir, Arc<App>) {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let details = Details::new(username, None, None, PASSWORD.into()).unwrap();
        claim::claim(&app, details, Proof::Local, None, Visit::default())
            .await
            .unwrap();
        (dir, app)
    }

    fn from(n: u8) -> Visit {
        let address = Some(IpAddr::from([198, 51, n / 100, n % 100]));
        Visit {
            peer: address,
            address,
            user_agent: None,
        }
    }

    fn spend_the_shared_hour(app: &App) {
        let now = app.clock.now_ms();
        for n in 0..100u8 {
            let sender = Sender::Stranger {
                owners_username: false,
            };
            let lanes = limits::password_lanes(
                &format!("u{n}"),
                Some(IpAddr::from([203, 0, 113, n / 10])),
                sender,
            );
            let shared = lanes.shared.as_slice();
            if app.limiter.spent(now, shared).is_some() {
                return;
            }
            assert_eq!(app.limiter.admit(now, &lanes.all()), None);
        }
    }

    #[tokio::test]
    async fn strangers_past_the_shared_hour_leave_a_queue_place_for_the_owners_username() {
        let (_dir, app) = claimed().await;
        spend_the_shared_hour(&app);
        let places = app.passwords.open_places_left();
        let held = app.passwords.hold_the_open_lane().await;
        let mut strangers = tokio::task::JoinSet::new();
        for n in 0..4 * places {
            let app = app.clone();
            let n = u8::try_from(n).unwrap();
            strangers.spawn(async move {
                let username = format!("stranger-{n}");
                with_password(&app, username, "a guess".into(), None, from(n)).await
            });
        }
        let answered = async {
            while let Some(answer) = strangers.join_next().await {
                let refusal = answer.unwrap().err().unwrap();
                assert_eq!(refusal.code, Code::RateLimited);
            }
        };
        tokio::time::timeout(Duration::from_secs(30), answered)
            .await
            .expect("an attempt past the shared hour waited for the queue");
        assert_eq!(app.passwords.open_places_left(), places);
        drop(held);
        let owner = with_password(&app, USERNAME.into(), PASSWORD.into(), None, from(200)).await;
        assert!(owner.is_ok());
    }

    fn spend_the_owners_count(app: &App) {
        let now = app.clock.now_ms();
        let sender = Sender::Stranger {
            owners_username: true,
        };
        let lanes = limits::password_lanes(USERNAME, None, sender);
        let owner = lanes.owner.unwrap();
        let owner = [owner];
        while app.limiter.spent(now, &owner).is_none() {
            assert_eq!(app.limiter.admit(now, &owner), None);
        }
    }

    async fn failed_sign_ins(app: &App) -> Vec<serde_json::Value> {
        app.db
            .read(|tx| {
                let mut rows = tx.prepare(
                    "SELECT details FROM audit_log WHERE action = ?1 ORDER BY created_at, id",
                )?;
                let details = rows
                    .query_map([SIGN_IN_FAILED], |row| row.get::<_, String>(0))?
                    .map(|details| Ok(serde_json::from_str(&details?).unwrap()))
                    .collect::<Result<Vec<_>>>()?;
                Ok(details)
            })
            .await
            .unwrap()
    }

    fn counts(app: &App, username: &str, visit: &Visit) -> Vec<u64> {
        let sender = Sender::Stranger {
            owners_username: true,
        };
        let lanes = limits::password_lanes(username, visit.address, sender);
        let now = app.clock.now_ms();
        lanes
            .all()
            .iter()
            .map(|lane| app.limiter.counted(now, lane))
            .collect()
    }

    /// What one attempt at the owner's username does: its answer, the audit rows it writes, the
    /// counts it adds and the password checks it makes.
    async fn what_it_does(
        app: &Arc<App>,
        password: &str,
        visit: Visit,
    ) -> (Code, String, Vec<serde_json::Value>, Vec<i64>, u64) {
        what_it_does_at(app, USERNAME, password, visit).await
    }

    async fn what_it_does_at(
        app: &Arc<App>,
        username: &str,
        password: &str,
        visit: Visit,
    ) -> (Code, String, Vec<serde_json::Value>, Vec<i64>, u64) {
        let audit = failed_sign_ins(app).await.len();
        let counted = counts(app, username, &visit);
        let checks = app.passwords.checks_made();
        let refusal = with_password(app, username.into(), password.into(), None, visit.clone())
            .await
            .err()
            .unwrap();
        let written = failed_sign_ins(app).await.split_off(audit);
        let added = counts(app, username, &visit)
            .iter()
            .zip(counted)
            .map(|(after, before)| i64::try_from(*after).unwrap() - i64::try_from(before).unwrap())
            .collect();
        let checked = app.passwords.checks_made() - checks;
        (
            refusal.code,
            refusal.message.into(),
            written,
            added,
            checked,
        )
    }

    #[tokio::test]
    async fn a_password_past_the_owners_count_is_not_checked_and_is_answered_as_a_wrong_one() {
        let (_dir, app) = claimed().await;
        let room = what_it_does(&app, "a guess", from(1)).await;
        assert_eq!(room.0, Code::Unauthorized);
        assert_eq!(
            room.4, 1,
            "a wrong password with the owner's count open is checked"
        );
        spend_the_owners_count(&app);
        let right = what_it_does(&app, PASSWORD, from(2)).await;
        let wrong = what_it_does(&app, "a guess", from(3)).await;
        assert_eq!(right, wrong);
        assert_eq!(right.0, Code::Unauthorized);
        assert_eq!(right.2.len(), 1);
        assert_eq!(right.2[0]["reason"], INVALID);
        assert_eq!(right.4, 0);
        assert_eq!(right.2, room.2);
        assert_eq!(
            right.3,
            room.3[..2]
                .iter()
                .chain(&[1, 1])
                .copied()
                .collect::<Vec<_>>()
        );

        spend_the_shared_hour(&app);
        let right = what_it_does(&app, PASSWORD, from(4)).await;
        let wrong = what_it_does(&app, "a guess", from(5)).await;
        assert_eq!(
            (&right.0, &right.1, &right.3, right.4),
            (&wrong.0, &wrong.1, &wrong.3, wrong.4)
        );
        assert_eq!(right.0, Code::RateLimited);
        assert_eq!(right.4, 0);
    }

    #[tokio::test]
    async fn a_username_is_matched_trimmed_and_in_lowercase() {
        let (_dir, app) = claimed().await;
        for typed in ["owner", "  OWNER ", "Owner"] {
            let signed = with_password(&app, typed.into(), PASSWORD.into(), None, from(1)).await;
            assert!(signed.is_ok(), "{typed:?}");
        }
    }

    #[tokio::test]
    async fn a_username_that_cannot_be_one_is_answered_and_counted_as_a_wrong_one() {
        let (_dir, app) = claimed().await;
        let wrong = what_it_does_at(&app, "nobody", PASSWORD, from(1)).await;
        assert_eq!(wrong.0, Code::Unauthorized);
        assert_eq!(wrong.1, "Invalid username or password.");
        assert_eq!(wrong.2.len(), 1);
        assert_eq!(wrong.2[0]["reason"], INVALID);
        assert_eq!(wrong.4, 1);
        let long = "o".repeat(65);
        for typed in [
            "owner@example.test",
            "own\u{200b}er",
            "ow ner",
            "own\u{212a}er",
            "",
            long.as_str(),
        ] {
            let said = what_it_does_at(&app, typed, PASSWORD, from(2)).await;
            assert_eq!(said.0, wrong.0, "{typed:?}");
            assert_eq!(said.1, wrong.1, "{typed:?}");
            assert_eq!(said.2[0]["reason"], INVALID, "{typed:?}");
            assert_eq!(said.4, wrong.4, "{typed:?}: checked as a wrong name is");
            assert_eq!(said.3[..2], [1, 1], "{typed:?}: counted at its address");
        }
    }

    #[tokio::test]
    async fn a_name_one_past_the_longest_is_not_the_owner_whose_name_it_begins_with() {
        let longest = "o".repeat(64);
        let (_dir, app) = claimed_as(&longest).await;
        let signed = with_password(&app, longest.clone(), PASSWORD.into(), None, from(1)).await;
        assert!(signed.is_ok());
        let past = format!("{longest}x");
        let refused = with_password(&app, past, PASSWORD.into(), None, from(2)).await;
        assert_eq!(refused.err().unwrap().code, Code::Unauthorized);
    }

    /// Sends `n` attempts at `username` together and gives each one's answer and wait, in the order
    /// they were answered.
    async fn together(app: &Arc<App>, username: &str, n: u8, first: u8) -> Vec<(Code, Duration)> {
        let mut attempts = tokio::task::JoinSet::new();
        for k in 0..n {
            let app = app.clone();
            let username = username.to_string();
            attempts.spawn(async move {
                let started = std::time::Instant::now();
                let answer =
                    with_password(&app, username, "a guess".into(), None, from(first + k)).await;
                (answer.err().unwrap().code, started.elapsed())
            });
        }
        let mut answered = Vec::new();
        while let Some(answer) = attempts.join_next().await {
            answered.push(answer.unwrap());
        }
        answered.sort_by_key(|(_, waited)| *waited);
        answered
    }

    #[tokio::test]
    async fn attempts_together_past_the_shared_hour_wait_alike_at_the_owners_username_and_any_other()
     {
        let (_dir, app) = claimed().await;
        let warmed = with_password(&app, USERNAME.into(), "a guess".into(), None, from(199)).await;
        assert!(warmed.is_err());
        spend_the_shared_hour(&app);
        let places = app.passwords.open_places_left();
        let n = u8::try_from(places + 4).unwrap();
        let check = app.passwords.turn_budget();
        let owners = together(&app, USERNAME, n, 0).await;
        let others = together(&app, "someone", n, n).await;
        assert_eq!(app.passwords.stand_ins_held(), 0);
        for answered in [&owners, &others] {
            assert!(answered.iter().all(|(code, _)| *code == Code::RateLimited));
            let at_once = answered
                .iter()
                .filter(|(_, waited)| *waited < check / 2)
                .count();
            assert_eq!(at_once, usize::from(n) - places, "{answered:?}");
        }
        let longest = |answered: &[(Code, Duration)]| answered.last().unwrap().1.as_secs_f64();
        let ratio = longest(&owners) / longest(&others);
        assert!((0.5..2.0).contains(&ratio), "{owners:?} {others:?}");
    }

    #[tokio::test]
    async fn a_stand_in_queue_is_dropped_once_nothing_holds_it() {
        let (_dir, app) = claimed().await;
        spend_the_shared_hour(&app);
        let attempt = with_password(&app, "someone".into(), "a guess".into(), None, from(1));
        let mut attempt = Box::pin(attempt);
        let held = async {
            while app.passwords.stand_ins_held() == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        };
        tokio::select! {
            () = held => {}
            _ = &mut attempt => panic!("the attempt took no place"),
        }
        assert_eq!(app.passwords.stand_ins_held(), 1);
        drop(attempt);
        tokio::time::timeout(Duration::from_secs(30), async {
            while app.passwords.stand_ins_held() > 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
    }
}

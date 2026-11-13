//! The relying party is the sign-in address in the ceremony's transaction, never `Host`.

mod challenge;
mod store;

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rusqlite::Transaction;
use serde_json::{Value, json};
use webauthn_rs::prelude::{
    DiscoverableAuthentication, DiscoverableKey, PasskeyRegistration, PublicKeyCredential,
    RegisterPublicKeyCredential, Url, Uuid, Webauthn, WebauthnBuilder, WebauthnError,
};

use self::challenge::Purpose;
pub use self::challenge::{LIFE_MS as CHALLENGE_LIFE_MS, UNREAD as UNREAD_ANSWERED};
pub use self::store::Listed;
use super::limits::{hold_to, passkey_challenge_lanes};
use super::owner::{self, Owner, checked_name};
use super::session::{self, New, Opened};
use super::sign_in::{SIGN_IN_FAILED, SIGNED_IN};
use super::{Note, Visit, carries_sessions, note};
use crate::app::App;
use crate::app::access::{Caller, unauthorized};
use crate::app::addresses::Address;
use crate::app::clock::Stamp;
use crate::app::refusal::{Code, Refusal, Result};
use crate::db::Write;

const ADDED: &str = "owner.passkey.added";
const RENAMED: &str = "owner.passkey.renamed";
const REMOVED: &str = "owner.passkey.removed";
const RELYING_PARTY_NAME: &str = "Marfa";
const CEREMONY_TIMEOUT: Duration = Duration::from_millis(challenge::LIFE_MS.unsigned_abs());

fn challenge_spent() -> Refusal {
    Refusal::validation("This passkey request has ended. Start again.")
}

fn not_accepted() -> Refusal {
    Refusal::new(Code::Unauthorized, "This passkey was not accepted.")
}

fn not_verified() -> Refusal {
    Refusal::validation("This passkey could not be verified.")
}

fn already_registered() -> Refusal {
    Refusal::new(Code::Conflict, "This passkey is already registered.")
}

fn not_found() -> Refusal {
    Refusal::new(Code::PasskeyNotFound, "No passkey has this ID.")
}

fn no_secure_address() -> Refusal {
    Refusal::new(
        Code::Forbidden,
        "Passkeys need an HTTPS address, or localhost on this machine.",
    )
}

fn no_domain() -> Refusal {
    Refusal::new(
        Code::Forbidden,
        "Passkeys need a domain name, and browsers refuse them at an IP address. \
         Use localhost on this machine, or an HTTPS address with a domain name.",
    )
}

/// A browser refuses a passkey without a domain, and so does webauthn-rs, so an IP address has none to offer.
struct Party {
    webauthn: Webauthn,
    origin: String,
    host: String,
}

impl Party {
    fn at(address: &Address) -> Result<Party> {
        if !carries_sessions(address) {
            return Err(no_secure_address());
        }
        let origin = Url::parse(address.origin())
            .map_err(|_| Refusal::internal("the sign-in address did not read"))?;
        let webauthn = WebauthnBuilder::new(address.host(), &origin)
            .map_err(|_| no_domain())?
            .rp_name(RELYING_PARTY_NAME)
            .timeout(CEREMONY_TIMEOUT)
            .build()
            .map_err(|_| no_domain())?;
        Ok(Party {
            webauthn,
            origin: address.origin().to_string(),
            host: address.host().to_string(),
        })
    }

    fn now(app: &App) -> Result<Party> {
        Party::at(&app.addresses().sign_in())
    }
}

/// A refusal the transaction still commits, so the challenge it took stays taken.
enum Verdict<T> {
    Done(T),
    Refused(Refusal),
}

impl<T> Verdict<T> {
    fn settled(self) -> Result<T> {
        match self {
            Verdict::Done(value) => Ok(value),
            Verdict::Refused(refusal) => Err(refusal),
        }
    }
}

#[derive(Debug)]
pub struct Begun {
    pub options: Value,
    pub token: String,
}

fn options_of(public_key: &impl serde::Serialize) -> Result<Value> {
    serde_json::to_value(public_key).map_err(|_| Refusal::internal("passkey options did not write"))
}

fn user_handle(owner: &Owner) -> Result<Uuid> {
    Uuid::parse_str(&owner.id).map_err(|_| Refusal::internal("the owner's id is not a UUID"))
}

fn encoded(credential_id: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(credential_id)
}

/// webauthn-rs asks for a discardable key and misreports an excluded credential; both are fixed here.
fn ask_for_a_resident_key(options: &mut Value, excluded: Vec<String>) {
    options["authenticatorSelection"]["residentKey"] = json!("required");
    options["authenticatorSelection"]["requireResidentKey"] = json!(true);
    options["excludeCredentials"] = excluded
        .into_iter()
        .map(|id| json!({ "type": "public-key", "id": id }))
        .collect();
}

pub async fn begin_adding(app: Arc<App>, caller: &Caller) -> Result<Begun> {
    caller.require_owner()?;
    let caller = caller.clone();
    let now_app = app.clone();
    app.db
        .read(move |tx| {
            let now = now_app.clock.instant();
            let caller = caller.current(tx, &now.text())?;
            caller.require_recent(&now.text())?;
            let session = caller.session().ok_or_else(unauthorized)?;
            let party = Party::now(&now_app)?;
            let owner = owner::read(tx)?.ok_or_else(owner::not_found)?;
            let (creation, state) = party
                .webauthn
                .start_passkey_registration(user_handle(&owner)?, &owner.email, &owner.name, None)
                .map_err(|_| Refusal::internal("a passkey registration did not start"))?;
            let mut options = options_of(&creation.public_key)?;
            ask_for_a_resident_key(&mut options, store::credentials_of(tx, &party.host)?);
            let token = challenge::issue(
                &now_app.settings.start.auth_secret,
                now,
                challenge::New {
                    purpose: Purpose::Add,
                    origin: &party.origin,
                    session_id: Some(&session.id),
                    state: &state,
                },
            )?;
            Ok(Begun { options, token })
        })
        .await
}

fn passkey_name(text: &str) -> Result<String> {
    checked_name(text)?.ok_or_else(|| Refusal::validation("Give the passkey a name."))
}

pub struct Adding {
    pub token: Option<String>,
    pub name: Option<String>,
    pub response: Value,
}

pub async fn add(app: Arc<App>, caller: &Caller, adding: Adding) -> Result<Listed> {
    caller.require_owner()?;
    let name = adding.name.as_deref().map(passkey_name).transpose()?;
    let secret = app.settings.start.auth_secret.clone();
    let now_app = app.clone();
    app.write(caller, ADDED, move |unit| {
        unit.caller.require_recent(&unit.at)?;
        let session = unit.caller.session().ok_or_else(unauthorized)?;
        let tx = unit.tx();
        let party = Party::now(&now_app)?;
        let owner = owner::read(tx)?.ok_or_else(owner::not_found)?;
        let taken = challenge::take(
            tx,
            &secret,
            adding.token.as_deref(),
            Purpose::Add,
            now_app.clock.instant(),
        )?;
        let Some(taken) = taken else {
            return Ok(Verdict::Refused(challenge_spent()));
        };
        if taken.origin != party.origin || taken.session_id.as_deref() != Some(&session.id) {
            return Ok(Verdict::Refused(challenge_spent()));
        }
        let state: PasskeyRegistration = taken.state()?;
        let Ok(answer) = serde_json::from_value::<RegisterPublicKeyCredential>(adding.response)
        else {
            return Ok(Verdict::Refused(not_verified()));
        };
        let Ok(passkey) = party.webauthn.finish_passkey_registration(&answer, &state) else {
            return Ok(Verdict::Refused(not_verified()));
        };
        let id = Uuid::now_v7().to_string();
        let added = store::insert(
            tx,
            &store::New {
                id: &id,
                owner_id: &owner.id,
                credential_id: &encoded(passkey.cred_id()),
                host: &party.host,
                name: name.as_deref(),
                passkey: &passkey,
                at: &unit.at,
            },
        )?;
        let Some(added) = added else {
            return Ok(Verdict::Refused(already_registered()));
        };
        unit.audit("passkey", &id, Some(json!({ "name": added.name })))?;
        Ok(Verdict::Done(added))
    })
    .await?
    .settled()
}

pub async fn begin_proving(app: Arc<App>, visit: &Visit) -> Result<Begun> {
    hold_to(
        &app,
        passkey_challenge_lanes(visit.address),
        "Too many sign-in attempts. Try again later.",
    )?;
    let party = Party::now(&app)?;
    let (request, state) = party
        .webauthn
        .start_discoverable_authentication()
        .map_err(|_| Refusal::internal("a passkey sign-in did not start"))?;
    let options = options_of(&request.public_key)?;
    let token = challenge::issue(
        &app.settings.start.auth_secret,
        app.clock.instant(),
        challenge::New {
            purpose: Purpose::Prove,
            origin: &party.origin,
            session_id: None,
            state: &state,
        },
    )?;
    Ok(Begun { options, token })
}

pub struct Assertion {
    pub token: Option<String>,
    pub response: Value,
}

/// `passkey` is set only where the owner's credential was named, the case worth an audit entry.
struct Unproven {
    refusal: Refusal,
    passkey: Option<(String, &'static str)>,
}

impl Unproven {
    fn plainly(refusal: Refusal) -> Unproven {
        Unproven {
            refusal,
            passkey: None,
        }
    }

    fn of(id: &str, reason: &'static str) -> Unproven {
        Unproven {
            refusal: not_accepted(),
            passkey: Some((id.to_string(), reason)),
        }
    }

    fn noted(
        self,
        tx: &Transaction<'_>,
        at: &str,
        actor: Option<&Caller>,
        visit: &Visit,
    ) -> Result<Refusal> {
        if let Some((id, reason)) = &self.passkey {
            note(
                tx,
                at,
                actor,
                visit,
                Note {
                    action: SIGN_IN_FAILED,
                    resource_type: "passkey",
                    resource_id: id,
                    details: Some(json!({ "method": "passkey", "reason": reason })),
                },
            )?;
        }
        Ok(self.refusal)
    }
}

struct Proven {
    owner: Owner,
    passkey_id: String,
}

struct Judging<'a> {
    at: &'a str,
    now: Stamp,
    party: &'a Party,
    secret: &'a str,
    owner_id: Option<&'a str>,
}

/// Spends the challenge whatever the verdict, and looks only at the credential the assertion names.
fn prove(
    tx: &Transaction<'_>,
    judging: &Judging<'_>,
    assertion: Assertion,
) -> Result<std::result::Result<Proven, Unproven>> {
    let party = judging.party;
    let spent = || Ok(Err(Unproven::plainly(challenge_spent())));
    let taken = challenge::take(
        tx,
        judging.secret,
        assertion.token.as_deref(),
        Purpose::Prove,
        judging.now,
    )?;
    let Some(taken) = taken else {
        return spent();
    };
    if taken.origin != party.origin {
        return spent();
    }
    let state: DiscoverableAuthentication = taken.state()?;
    let Ok(answer) = serde_json::from_value::<PublicKeyCredential>(assertion.response) else {
        return Ok(Err(Unproven::plainly(not_verified())));
    };
    let unknown = || Ok(Err(Unproven::plainly(not_accepted())));
    let Some(mut held) = store::by_credential(tx, &encoded(answer.get_credential_id()))? else {
        return unknown();
    };
    let Some(owner) = owner::read(tx)?.filter(|owner| owner.id == held.owner_id) else {
        return unknown();
    };
    if judging.owner_id.is_some_and(|id| id != owner.id) {
        return unknown();
    }
    if held.host != party.host {
        return Ok(Err(Unproven::of(&held.id, "another_host")));
    }
    if let Some(handle) = answer.get_user_unique_id()
        && handle != user_handle(&owner)?.as_bytes()
    {
        return Ok(Err(Unproven::of(&held.id, "another_user")));
    }
    let key = DiscoverableKey::from(&held.passkey);
    let result = party
        .webauthn
        .finish_discoverable_authentication_v2(&answer, state, key);
    let result = match result {
        Ok(result) => result,
        Err(WebauthnError::CredentialPossibleCompromise) => {
            return Ok(Err(Unproven::of(&held.id, "counter_went_back")));
        }
        Err(_) => return Ok(Err(Unproven::of(&held.id, "not_verified"))),
    };
    held.passkey.update_credential(&result);
    store::record_use(tx, &held.id, &held.passkey, judging.at)?;
    Ok(Ok(Proven {
        owner,
        passkey_id: held.id,
    }))
}

pub async fn sign_in(app: Arc<App>, assertion: Assertion, visit: Visit) -> Result<Opened> {
    let salt = app.settings.start.key_salt.clone();
    let secret = app.settings.start.auth_secret.clone();
    let now_app = app.clone();
    app.db
        .write(Write::caller(SIGNED_IN), move |tx| {
            let at = now_app.clock.stamp();
            let party = Party::now(&now_app)?;
            let judging = Judging {
                at: &at,
                now: now_app.clock.instant(),
                party: &party,
                secret: &secret,
                owner_id: None,
            };
            let proven = match prove(tx, &judging, assertion)? {
                Ok(proven) => proven,
                Err(unproven) => {
                    return Ok(Verdict::Refused(unproven.noted(tx, &at, None, &visit)?));
                }
            };
            let opened = session::open(
                tx,
                Stamp::read(&at)?,
                New {
                    salt: &salt,
                    owner_id: &proven.owner.id,
                    visit: &visit,
                },
            )?;
            note(
                tx,
                &at,
                None,
                &visit,
                Note {
                    action: SIGNED_IN,
                    resource_type: "owner",
                    resource_id: &proven.owner.email,
                    details: Some(json!({
                        "email": proven.owner.email,
                        "method": "passkey",
                        "passkey_id": proven.passkey_id,
                    })),
                },
            )?;
            Ok(Verdict::Done(opened))
        })
        .await?
        .settled()
}

pub async fn confirm(
    app: Arc<App>,
    caller: &Caller,
    assertion: Assertion,
    visit: Visit,
) -> Result<Opened> {
    let session = caller.session().ok_or_else(unauthorized)?.clone();
    let salt = app.settings.start.key_salt.clone();
    let secret = app.settings.start.auth_secret.clone();
    let now_app = app.clone();
    app.write(caller, SIGNED_IN, move |unit| {
        let tx = unit.tx();
        let party = Party::now(&now_app)?;
        let judging = Judging {
            at: &unit.at,
            now: now_app.clock.instant(),
            party: &party,
            secret: &secret,
            owner_id: Some(&session.owner_id),
        };
        let proven = match prove(tx, &judging, assertion)? {
            Ok(proven) => proven,
            Err(unproven) => {
                let refusal = unproven.noted(tx, &unit.at, Some(&unit.caller), &visit)?;
                return Ok(Verdict::Refused(refusal));
            }
        };
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
                    "method": "passkey",
                    "passkey_id": proven.passkey_id,
                    "confirmed_session": session.id,
                })),
            },
        )?;
        Ok(Verdict::Done(opened))
    })
    .await?
    .settled()
}

pub async fn list(app: &App, caller: &Caller) -> Result<Vec<Listed>> {
    caller.require_owner()?;
    app.db.read(store::all).await
}

pub async fn rename(app: &App, caller: &Caller, id: String, name: &str) -> Result<Listed> {
    caller.require_owner()?;
    let name = passkey_name(name)?;
    app.write(caller, RENAMED, move |unit| {
        unit.caller.require_recent(&unit.at)?;
        let renamed = store::rename(unit.tx(), &id, &name)?.ok_or_else(not_found)?;
        unit.audit("passkey", &id, Some(json!({ "name": name })))?;
        Ok(renamed)
    })
    .await
}

pub async fn remove(app: &App, caller: &Caller, id: String) -> Result<()> {
    caller.require_owner()?;
    app.write(caller, REMOVED, move |unit| {
        unit.caller.require_recent(&unit.at)?;
        if !store::remove(unit.tx(), &id)? {
            return Err(not_found());
        }
        unit.audit("passkey", &id, None)
    })
    .await
}

pub fn stranded_by(tx: &Transaction<'_>, host: &str) -> Result<i64> {
    store::count_beyond(tx, host)
}

//! How an instance gets its owner: a setup code, a handoff link or a setup
//! session proves the caller may claim it, and the claim spends them all.

use std::net::IpAddr;

use rusqlite::{OptionalExtension, Transaction, params};
use subtle::ConstantTimeEq;

use super::limits::{self, spent};
use super::owner::{self, Details, Owner};
use super::{Note, Visit, note, password, seconds_of};
use crate::app::access::Caller;
use crate::app::keys::digest_of;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::{App, instance};
use crate::db::Write;
use crate::log;

const CODE: &str = "code";
const TICKET: &str = "ticket";
const SESSION: &str = "session";
const CODE_BYTES: usize = 16;
const TOKEN_BYTES: usize = 32;
const CODE_GROUP: usize = 5;
const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TICKET_MS: i64 = 5 * 60_000;
const SESSION_MS: i64 = 15 * 60_000;
const CLAIMED: &str = "owner.claimed";

fn invalid_proof() -> Refusal {
    Refusal::new(
        Code::SetupProofInvalid,
        "Setup proof is invalid, expired, or replaced. Obtain a new setup code or link.",
    )
}

pub fn already_claimed() -> Refusal {
    Refusal::new(Code::OwnerExists, "This instance has already been claimed.")
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|_| Refusal::internal("no randomness was available"))?;
    Ok(bytes)
}

fn new_code() -> Result<String> {
    let mut letters = Vec::new();
    let (mut held, mut bits) = (0u32, 0u32);
    for byte in random::<CODE_BYTES>()? {
        held = (held << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            letters.push(BASE32[((held >> bits) & 31) as usize]);
        }
        held &= (1 << bits) - 1;
    }
    if bits > 0 {
        letters.push(BASE32[((held << (5 - bits)) & 31) as usize]);
    }
    let groups: Vec<String> = letters
        .chunks(CODE_GROUP)
        .map(|group| String::from_utf8_lossy(group).into_owned())
        .collect();
    Ok(groups.join("-"))
}

fn normalized(code: &str) -> String {
    code.chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .flat_map(char::to_uppercase)
        .collect()
}

/// What the claim state says, for the private socket.
pub struct Status {
    pub claimed: bool,
    pub owner_id: Option<String>,
    pub generation: Option<String>,
}

fn generation(tx: &Transaction<'_>) -> Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT generation FROM setup_proof WHERE kind = ?1",
            [CODE],
            |row| row.get(0),
        )
        .optional()?)
}

pub async fn status(app: &App) -> Result<Status> {
    app.db
        .read(|tx| {
            Ok(Status {
                claimed: instance::is_claimed(tx)?,
                owner_id: instance::owner_id(tx)?,
                generation: generation(tx)?,
            })
        })
        .await
}

fn require_unclaimed(tx: &Transaction<'_>) -> Result<()> {
    if instance::is_claimed(tx)? {
        return Err(already_claimed());
    }
    Ok(())
}

/// Whether a live proof of `kind` has this digest, compared in constant time.
fn holds(tx: &Transaction<'_>, kind: &str, digest: &str, now_ms: i64) -> Result<bool> {
    let mut statement = tx.prepare(
        "SELECT digest FROM setup_proof \
         WHERE kind = ?1 AND (expires_at IS NULL OR expires_at > ?2)",
    )?;
    let digests = statement
        .query_map(params![kind, now_ms], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(digests.iter().fold(false, |found, held| {
        found | bool::from(held.as_bytes().ct_eq(digest.as_bytes()))
    }))
}

fn drop_expired(tx: &Transaction<'_>, now_ms: i64) -> Result<()> {
    tx.execute(
        "DELETE FROM setup_proof WHERE expires_at IS NOT NULL AND expires_at <= ?1",
        [now_ms],
    )?;
    Ok(())
}

fn add(
    tx: &Transaction<'_>,
    digest: &str,
    kind: &str,
    generation: &str,
    expires_at: Option<i64>,
) -> Result<()> {
    tx.execute(
        "INSERT INTO setup_proof (digest, kind, generation, expires_at) VALUES (?1, ?2, ?3, ?4)",
        params![digest, kind, generation, expires_at],
    )?;
    Ok(())
}

/// A fresh setup code, in place of every earlier code, link and setup session.
pub async fn issue_code(app: &App, caller: &Caller) -> Result<(String, String)> {
    let code = new_code()?;
    let digest = digest_of(&app.settings.start.api_key_salt, &normalized(&code))?;
    let generation = hex::encode(random::<16>()?);
    let instance_id = app.instance_id.clone();
    let issued = generation.clone();
    app.write(caller, "instance.setup_code.issued", move |unit| {
        unit.caller.require_direct()?;
        require_unclaimed(unit.tx())?;
        unit.tx().execute("DELETE FROM setup_proof", [])?;
        add(unit.tx(), &digest, CODE, &issued, None)?;
        unit.audit("instance", &instance_id, None)
    })
    .await?;
    Ok((code, generation))
}

/// Replaces the setup code when an unclaimed instance starts, and says it on
/// the server's own output and nowhere else.
pub async fn announce_at_start(app: &App) -> Result<()> {
    if status(app).await?.claimed {
        return Ok(());
    }
    let (code, _) = issue_code(app, &Caller::Local).await?;
    log::local_only(&format!(
        "Claim this Marfa at /setup with setup code: {code}"
    ));
    Ok(())
}

/// A handoff link's ticket and when it ends, in milliseconds.
pub async fn issue_ticket(app: &App, caller: &Caller) -> Result<(String, i64)> {
    let ticket = hex::encode(random::<TOKEN_BYTES>()?);
    let digest = digest_of(&app.settings.start.api_key_salt, &ticket)?;
    let instance_id = app.instance_id.clone();
    let clock = app.clock.clone();
    let expires_at = app
        .write(caller, "instance.setup_ticket.issued", move |unit| {
            unit.caller.require_direct()?;
            require_unclaimed(unit.tx())?;
            let now = clock.now_ms();
            drop_expired(unit.tx(), now)?;
            let held = generation(unit.tx())?.ok_or_else(invalid_proof)?;
            add(unit.tx(), &digest, TICKET, &held, Some(now + TICKET_MS))?;
            unit.audit("instance", &instance_id, None)?;
            Ok(now + TICKET_MS)
        })
        .await?;
    Ok((ticket, expires_at))
}

/// A setup session's token and when it ends, in milliseconds.
pub struct SetupSession {
    pub token: String,
    pub expires_at: i64,
}

fn add_session(tx: &Transaction<'_>, digest: &str, now_ms: i64) -> Result<i64> {
    let held = generation(tx)?.ok_or_else(invalid_proof)?;
    add(tx, digest, SESSION, &held, Some(now_ms + SESSION_MS))?;
    Ok(now_ms + SESSION_MS)
}

/// Counts one use of a setup code from `address`.
async fn count_code(app: &App, address: Option<IpAddr>) -> Result<()> {
    let lanes = limits::setup_code_lanes(address);
    let clock = app.clock.clone();
    let wait = app
        .db
        .write(Write::own(), move |tx| {
            limits::admit(tx, clock.now_ms(), &lanes)
        })
        .await?;
    match wait {
        Some(wait) => Err(spent(
            "Too many setup code attempts. Try again later.",
            wait,
        )),
        None => Ok(()),
    }
}

async fn exchange(
    app: &App,
    action: &'static str,
    kind: &'static str,
    digest: String,
    visit: Visit,
) -> Result<SetupSession> {
    let token = hex::encode(random::<TOKEN_BYTES>()?);
    let session_digest = digest_of(&app.settings.start.api_key_salt, &token)?;
    let instance_id = app.instance_id.clone();
    let clock = app.clock.clone();
    let expires_at = app
        .db
        .write(Write::caller(action), move |tx| {
            require_unclaimed(tx)?;
            let now = clock.now_ms();
            if !holds(tx, kind, &digest, now)? {
                return Err(invalid_proof());
            }
            if kind == TICKET {
                tx.execute("DELETE FROM setup_proof WHERE digest = ?1", [&digest])?;
            }
            drop_expired(tx, now)?;
            let expires_at = add_session(tx, &session_digest, now)?;
            note(
                tx,
                &clock.stamp(),
                None,
                &visit,
                Note {
                    action,
                    resource_type: "instance",
                    resource_id: &instance_id,
                    details: None,
                },
            )?;
            Ok(expires_at)
        })
        .await?;
    Ok(SetupSession { token, expires_at })
}

/// Spends a handoff ticket on a setup session.
pub async fn exchange_ticket(app: &App, ticket: &str, visit: Visit) -> Result<SetupSession> {
    let digest = digest_of(&app.settings.start.api_key_salt, ticket)?;
    exchange(
        app,
        "instance.setup_ticket.exchanged",
        TICKET,
        digest,
        visit,
    )
    .await
}

/// Trades a setup code for a setup session, and leaves the code good.
pub async fn exchange_code(app: &App, code: &str, visit: Visit) -> Result<SetupSession> {
    if is_claimed(app).await? {
        return Err(already_claimed());
    }
    count_code(app, visit.address).await?;
    let digest = digest_of(&app.settings.start.api_key_salt, &normalized(code))?;
    exchange(app, "instance.setup_code.exchanged", CODE, digest, visit).await
}

/// What lets a caller claim.
#[derive(Clone, Debug)]
pub enum Proof {
    Local,
    Code(String),
    Session(String),
}

/// `(kind, digest)` of the row a proof must find.
fn sought(app: &App, proof: &Proof) -> Result<Option<(&'static str, String)>> {
    let salt = &app.settings.start.api_key_salt;
    Ok(match proof {
        Proof::Local => None,
        Proof::Code(code) => Some((CODE, digest_of(salt, &normalized(code))?)),
        Proof::Session(token) => Some((SESSION, digest_of(salt, token)?)),
    })
}

fn proof_stands(
    tx: &Transaction<'_>,
    sought: Option<&(&'static str, String)>,
    now_ms: i64,
) -> Result<()> {
    require_unclaimed(tx)?;
    match sought {
        Some((kind, digest)) if !holds(tx, kind, digest, now_ms)? => Err(invalid_proof()),
        _ => Ok(()),
    }
}

pub async fn is_claimed(app: &App) -> Result<bool> {
    app.db.read(instance::is_claimed).await
}

/// Makes `details` the owner. The proof is judged before the password's hash
/// is paid for and again in the transaction, which is what lets one of two
/// claims at once through.
pub async fn claim(app: &App, details: Details, proof: Proof, visit: Visit) -> Result<Owner> {
    if is_claimed(app).await? {
        return Err(already_claimed());
    }
    if let Proof::Code(_) = proof {
        count_code(app, visit.address).await?;
    }
    let sought = sought(app, &proof)?;
    let clock = app.clock.clone();
    let judged = sought.clone();
    app.db
        .read(move |tx| proof_stands(tx, judged.as_ref(), clock.now_ms()))
        .await?;
    password::check_new(&details.password)?;
    let hash = app.passwords.hash(details.password.clone()).await?;
    let clock = app.clock.clone();
    app.db
        .write(Write::caller(CLAIMED), move |tx| {
            let at = clock.stamp();
            proof_stands(tx, sought.as_ref(), clock.now_ms())?;
            let owner = owner::create(tx, &details, &hash, seconds_of(&at)?)?;
            if !instance::mark_claimed(tx, &at, &owner.id)? {
                return Err(already_claimed());
            }
            tx.execute("DELETE FROM setup_proof", [])?;
            let local = Caller::Local;
            let actor = matches!(proof, Proof::Local).then_some(&local);
            note(
                tx,
                &at,
                actor,
                &visit,
                Note {
                    action: CLAIMED,
                    resource_type: "owner",
                    resource_id: &owner.id,
                    details: None,
                },
            )?;
            Ok(owner)
        })
        .await
}

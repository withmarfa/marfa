use std::net::IpAddr;
use std::sync::Arc;

use serde_json::{Value, json};

use super::client::GrantType;
use super::clients::{self, ceiling_lacks, destinations_digest, judge, registries_in};
use super::grant::{self, DEVICE_SOURCE, GRANT_CREATED, GRANT_WRITE};
use super::offer::{self, Decision, Offer, Post, Request};
use super::scope::{OFFLINE_ACCESS, Registries, ScopeSet, narrow, needs_recent_sign_in};
use super::store::{self, DeviceCode, DeviceStatus};
use super::token::{Form, credential_refused};
use super::tokens::{new_device_code, new_user_code, normalize_user_code};
use super::{Answered, DEVICE_CODE_SECONDS, DEVICE_INTERVAL_SECONDS, MS_PER_SECOND, Problem};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::audit::{self, Entry};
use crate::app::auth::Visit;
use crate::app::auth::limits::{
    admit, device_code_lanes, device_lookup_lanes, device_owner_lanes, hold_to,
};
use crate::app::catalog::{self, Snapshot};
use crate::app::clock::Stamp;
use crate::app::faults::DEVICE_OWNER_INSTANCE_LANE;
use crate::app::keys::digest_of;
use crate::app::refusal::{Code as RefusalCode, Refusal, Result};
use crate::db::Write;

const CODE_WRITE: &str = "auth.device_code.issued";

pub async fn request(app: &Arc<App>, form: &Form, visit: &Visit) -> Result<Answered<Value>> {
    hold_to(
        app,
        device_code_lanes(visit.address),
        "Too many device codes requested. Try again later.",
    )?;
    if let Some(problem) = credential_refused(form) {
        return Ok(Err(problem));
    }
    let Some(client_id) = form.get("client_id") else {
        return Ok(Err(Problem::new("invalid_request", "Name a client_id.")));
    };
    let client = match clients::resolve(app, client_id, visit).await? {
        Ok(client) => client,
        Err(problem) => return Ok(Err(problem)),
    };
    if !client.registration.names_grant(GrantType::DeviceCode) {
        return Ok(Err(Problem::new(
            "unauthorized_client",
            "This client is not registered for the device grant.",
        )));
    }
    let scopes = ScopeSet::parse(form.get("scope").unwrap_or_default());
    if scopes.is_empty() {
        return Ok(Err(Problem::new(
            "invalid_scope",
            "Name the scopes to request.",
        )));
    }
    if scopes.contains(OFFLINE_ACCESS) && !client.registration.can_refresh() {
        return Ok(Err(Problem::new(
            "invalid_scope",
            "offline_access needs a client registered for refresh_token.",
        )));
    }
    let registries = Registries::of(&app.catalog_handle().load());
    let judged = judge(&client.registration, &scopes, &registries);
    if let Some(literal) = judged.unknown.iter().chain(&judged.outside).next() {
        return Ok(Err(Problem::new(
            "invalid_scope",
            format!("This client cannot ask for {literal}."),
        )));
    }

    let device_code = new_device_code()?;
    let user_code = new_user_code()?;
    let salt = &app.settings.start.key_salt;
    let now = app.clock.instant();
    let row = DeviceCode {
        digest: digest_of(salt, &device_code)?,
        user_code_digest: digest_of(salt, &normalize_user_code(&user_code))?,
        client_id: client.id.clone(),
        scopes,
        destinations: destinations_digest(app, &client)?,
        status: DeviceStatus::Pending,
        owner_id: None,
        interval_seconds: DEVICE_INTERVAL_SECONDS,
        last_polled_at: None,
        expires_at: now.plus_ms(DEVICE_CODE_SECONDS * MS_PER_SECOND)?,
    };
    let at = now.text();
    let ip = visit.client_ip();
    app.db
        .write(Write::caller(CODE_WRITE), move |tx| {
            store::insert_device_code(tx, &row)?;
            audit::record_from(
                tx,
                &at,
                None,
                ip.as_deref(),
                Entry {
                    action: CODE_WRITE,
                    resource_type: "oauth_client",
                    resource_id: Some(&row.client_id),
                    details: Some(json!({ "client_id": row.client_id, "source": "device" })),
                },
            )
        })
        .await?;
    let origin = app.addresses().sign_in().origin().to_string();
    let encoded: String = url::form_urlencoded::byte_serialize(user_code.as_bytes()).collect();
    Ok(Ok(json!({
        "device_code": device_code,
        "user_code": user_code,
        "verification_uri": format!("{origin}/auth/device"),
        "verification_uri_complete": format!("{origin}/auth/device?user_code={encoded}"),
        "expires_in": DEVICE_CODE_SECONDS,
        "interval": DEVICE_INTERVAL_SECONDS,
    })))
}

/// A refused lookup still counts. A verified session spends from the owner's lanes, anyone
/// else from the address's.
pub fn admit_lookup(app: &App, address: Option<IpAddr>, owner: Option<&Caller>) -> Option<i64> {
    match owner.and_then(Caller::session) {
        Some(session) => admit(
            app,
            &device_owner_lanes(
                &session.owner_id,
                app.faults.limit(DEVICE_OWNER_INSTANCE_LANE),
            ),
        ),
        None => admit(app, &device_lookup_lanes(address)),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Lookup {
    Unknown,
    Expired,
    Resolved,
    Pending,
}

fn digest_of_typed(app: &App, typed: &str) -> Result<String> {
    digest_of(&app.settings.start.key_salt, &normalize_user_code(typed))
}

fn looked_up(found: Option<&DeviceCode>, now: Stamp) -> Lookup {
    match found {
        None => Lookup::Unknown,
        Some(code) if code.expires_at <= now => Lookup::Expired,
        Some(code) if code.status != DeviceStatus::Pending => Lookup::Resolved,
        Some(_) => Lookup::Pending,
    }
}

pub async fn look_up(app: &App, typed: &str) -> Result<Lookup> {
    let digest = digest_of_typed(app, typed)?;
    let now = app.clock.instant();
    app.db
        .read(move |tx| {
            let found = store::device_code_by_user_code(tx, &digest)?;
            Ok(looked_up(found.as_ref(), now))
        })
        .await
}

pub async fn screen(
    app: &Arc<App>,
    typed: &str,
    owner: &Caller,
) -> Result<std::result::Result<Box<Offer>, Blocked>> {
    let digest = digest_of_typed(app, typed)?;
    let owner_id = owner
        .session()
        .map(|session| session.owner_id.clone())
        .ok_or_else(|| Refusal::internal("an approval has no browser session"))?;
    let cache = app.catalog_handle();
    let now = app.clock.instant();
    app.db
        .write(Write::own(), move |tx| {
            let found = store::device_code_by_user_code(tx, &digest)?;
            let lookup = looked_up(found.as_ref(), now);
            let (Lookup::Pending, Some(code)) = (lookup, found) else {
                return Ok(Err(Blocked::Code(lookup)));
            };
            let Some(client) = store::client(tx, &code.client_id)? else {
                return Ok(Err(Blocked::ClientGone));
            };
            store::note_offered(tx, &client.id, now)?;
            let catalog = catalog::current(&cache, tx, Snapshot::Pending)?;
            let registries = Registries::of(&catalog);
            let named = narrow(&code.scopes, &registries.allowed()).kept;
            let held = store::held_scopes(tx, &client.id, &owner_id)?;
            let choosable = registries.choosable_types();
            let request = Request {
                named: &named,
                held: &held,
                choosable: &choosable,
            };
            Ok(Ok(Box::new(
                offer::build(&client, &request).named(&catalog),
            )))
        })
        .await
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Blocked {
    Code(Lookup),
    ClientGone,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Answer {
    Approved,
    Denied,
    Code(Lookup),
}

/// Reads again inside the write so an answer lands only on a pending code.
pub async fn answer(
    app: &Arc<App>,
    owner: &Caller,
    typed: &str,
    approve: bool,
    post: Post,
) -> Result<Answer> {
    let digest = digest_of_typed(app, typed)?;
    let cache = app.catalog_handle();
    let shared = app.clone();
    app.write(owner, GRANT_WRITE, move |unit| {
        let tx = unit.tx();
        let now = unit.instant;
        let found = store::device_code_by_user_code(tx, &digest)?;
        let lookup = looked_up(found.as_ref(), now);
        let (Lookup::Pending, Some(code)) = (lookup, found) else {
            return Ok(Answer::Code(lookup));
        };
        let owner_id = unit
            .caller
            .session()
            .map(|session| session.owner_id.clone())
            .ok_or_else(|| Refusal::internal("an approval has no browser session"))?;
        let deny = |scopes: &ScopeSet| {
            store::decide_device_code(tx, &code.digest, DeviceStatus::Denied, &owner_id, scopes)?;
            Ok(Answer::Denied)
        };
        if !approve {
            return deny(&code.scopes);
        }
        let client = store::client(tx, &code.client_id)?
            .ok_or_else(|| Refusal::new(RefusalCode::InvalidClient, "This app is gone."))?;
        let registries = registries_in(unit, &cache)?;
        let named = narrow(&code.scopes, &registries.allowed()).kept;
        let held = store::held_scopes(tx, &client.id, &owner_id)?;
        let choosable = registries.choosable_types();
        let request = Request {
            named: &named,
            held: &held,
            choosable: &choosable,
        };
        let approved = match offer::read_decision(&request, &post) {
            Decision::Approved(approved) => approved,
            Decision::Denied => return deny(&code.scopes),
            Decision::Beyond => {
                return Err(Refusal::validation(
                    "This post chooses what the request did not offer.",
                ));
            }
        };
        if destinations_digest(&shared, &client)? != code.destinations {
            return Ok(Answer::Code(Lookup::Expired));
        }
        if needs_recent_sign_in(&approved, &held) {
            unit.caller.require_recent(&unit.at)?;
        }
        let lacking = ceiling_lacks(&client, &approved, &registries)?;
        clients::catch_up(unit, &client, &lacking, "device")?;
        let stood = grant::stand(unit, &cache, &client, &owner_id, &approved, DEVICE_SOURCE)?;
        store::decide_device_code(
            tx,
            &code.digest,
            DeviceStatus::Approved,
            &owner_id,
            &approved,
        )?;
        unit.audit_also(
            GRANT_CREATED,
            "oauth_grant",
            &client.id,
            Some(json!({
                "client_id": client.id,
                "owner_id": owner_id,
                "scopes": code.scopes.literals(),
                "approved_scopes": approved.literals(),
                "resulting_scopes": stood.scopes.literals(),
                "grant_item_id": stood.grant_id,
                "source": "device",
                "created": stood.created,
            })),
        )?;
        Ok(Answer::Approved)
    })
    .await
}

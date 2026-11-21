//! The instance's link to Marfa Cloud: started, read and ended by the owner, and followed
//! by a worker that sends to Marfa Cloud only while a link is started.

mod client;
pub mod connector;
mod status;
mod store;
mod worker;

use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rusqlite::Transaction;
use serde_json::{Value, json};
use tokio::sync::{Mutex, Notify, watch};

use super::access::{Caller, Permission};
use super::addresses::Address;
use super::clock::Stamp;
use super::config::{self, Authority, Request, SignInChange};
use super::consequences::{self, Consequence};
use super::events::Event;
use super::refusal::{Code, Refusal, Result};
use super::unit::Unit;
use super::{App, instance, stored};
use crate::settings::sealed::{Sealer, Secret};
use status::Seen;
pub use status::Standing;
use store::{Link, Move, State, Unlink};

pub const CHANGED: &str = "cloud_link.changed";

const POLL_SECRET: &str = "cloud:poll_secret";
const TUNNEL_TOKEN: &str = "cloud:tunnel_token";
const LINK_CREDENTIAL: &str = "cloud:link_credential";
/// How long the server keeps trying to tell Marfa Cloud of an unlink.
const TELL_FOR_MS: i64 = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS: i64 = 1_000;
const MAX_INTERVAL_MS: i64 = 300_000;

pub struct Cloud {
    /// Starts and unlinks one at a time, so each judges the link the last one left.
    door: Mutex<()>,
    wake: Notify,
    stopping: AtomicBool,
    running: watch::Sender<bool>,
    connector: connector::Connector,
}

impl Cloud {
    pub fn new(started: Stamp) -> Cloud {
        Cloud {
            door: Mutex::new(()),
            wake: Notify::new(),
            stopping: AtomicBool::new(false),
            running: watch::Sender::new(false),
            connector: connector::Connector::new(started),
        }
    }

    fn wake(&self) {
        self.wake.notify_one();
    }

    pub fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        self.wake.notify_one();
    }

    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }

    pub async fn settle(&self, budget: Duration) {
        let mut running = self.running.subscribe();
        let idle = tokio::time::timeout(budget, running.wait_for(|running| !*running));
        if idle.await.is_err() {
            tracing::warn!(
                "The link to Marfa Cloud was still being followed when the stop's wait ended"
            );
        }
    }
}

pub fn follow(app: &Arc<App>) {
    worker::start(app);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignIn {
    Move,
    Keep,
}

impl SignIn {
    fn word(self) -> &'static str {
        match self {
            SignIn::Move => "move",
            SignIn::Keep => "keep",
        }
    }
}

/// Whether a listener bound to `ip` takes connections to 127.0.0.1, where Marfa Cloud's connector sends.
fn reachable_on_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_unspecified(),
        IpAddr::V6(v6) => {
            v6.is_unspecified() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    }
}

fn opens(sealer: &Sealer, setting: &str, sealed: Option<&String>) -> bool {
    sealed.is_none_or(|text| sealer.open(setting, text).is_some())
}

fn secrets_open(sealer: &Sealer, link: &Link) -> bool {
    opens(sealer, POLL_SECRET, link.poll_secret.as_ref())
        && opens(sealer, TUNNEL_TOKEN, link.tunnel_token.as_ref())
        && opens(sealer, LINK_CREDENTIAL, link.link_credential.as_ref())
}

fn sign_in_in(app: &App, tx: &Transaction<'_>) -> Result<Address> {
    let rows = stored::rows(tx)?;
    Ok(app
        .addresses_in(Arc::new(app.settings.candidate(&rows)))
        .sign_in())
}

fn seen<'a>(app: &'a App, link: Option<&'a Link>, sign_in: &'a Address) -> Seen<'a> {
    Seen {
        link,
        opens: link.is_none_or(|link| secrets_open(app.settings.sealer(), link)),
        sign_in,
        now_ms: app.clock.now_ms(),
        connector: &app.cloud.connector,
    }
}

fn status_in(app: &App, tx: &Transaction<'_>) -> Result<Value> {
    let link = store::read(tx)?;
    let sign_in = sign_in_in(app, tx)?;
    Ok(seen(app, link.as_ref(), &sign_in).to_json())
}

fn announce(unit: &Unit<'_, '_>, status: &Value) -> Result<()> {
    unit.announce(&Event {
        event_type: CHANGED,
        item_id: "",
        type_id: "",
        source: "",
        payload: json!({ "cloud_link": status }).to_string(),
    })
}

/// Announces the link if `write` changed how it reads.
fn changing<T>(
    unit: &Unit<'_, '_>,
    app: &App,
    write: impl FnOnce(&Unit<'_, '_>) -> Result<T>,
) -> Result<T> {
    let before = status_in(app, unit.tx())?;
    let done = write(unit)?;
    let after = status_in(app, unit.tx())?;
    if before != after {
        announce(unit, &after)?;
    }
    Ok(done)
}

pub async fn read(app: &Arc<App>) -> Result<Value> {
    let reading = app.clone();
    app.db.read(move |tx| status_in(&reading, tx)).await
}

fn refuse_existing(app: &App, tx: &Transaction<'_>) -> Result<()> {
    let link = store::read(tx)?;
    let sign_in = sign_in_in(app, tx)?;
    match seen(app, link.as_ref(), &sign_in).standing() {
        Standing::Linking | Standing::Linked => Err(Refusal::new(
            Code::CloudLinkExists,
            "This instance is already linking or linked to Marfa Cloud. Unlink it first.",
        )),
        Standing::NotLinked | Standing::Failed => Ok(()),
    }
}

fn unconfirmed(consequences: &[Consequence]) -> Refusal {
    Refusal::new(
        Code::SignInAddressChangeUnconfirmed,
        "Linking moves the sign-in address to the Marfa Cloud address, which needs your confirmation.",
    )
    .with_detail(
        "consequences",
        consequences
            .iter()
            .map(Consequence::to_json)
            .collect::<Vec<_>>(),
    )
}

/// What the link will do with the sign-in address, decided for `caller` on the state `tx` reads.
fn decide_move(
    tx: &Transaction<'_>,
    caller: &Caller,
    at: &str,
    now_ms: i64,
    asked: SignIn,
    confirmed: bool,
) -> Result<Move> {
    if asked == SignIn::Keep {
        return Ok(Move::Keep);
    }
    if caller
        .require_step_up(Permission::ConfigManage, at)
        .is_err()
    {
        return Ok(Move::Waiting);
    }
    if instance::is_claimed(tx)? && !confirmed {
        return Err(unconfirmed(&consequences::of_move_to_unknown_host(
            tx, now_ms,
        )?));
    }
    Ok(Move::Authorized)
}

fn unavailable(reason: &str) -> Refusal {
    Refusal::new(
        Code::CloudUnavailable,
        "Marfa Cloud could not start a link. Try again later.",
    )
    .with_detail("reason", reason)
}

/// What Marfa Cloud answered to a start.
struct Started {
    link_id: String,
    poll_secret: String,
    user_code: String,
    approval_url: String,
    expires_at: Stamp,
    interval_ms: i64,
}

fn text_at(body: &Value, field: &str) -> Option<String> {
    body.get(field)?
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn stamp_at(body: &Value, field: &str) -> Option<Stamp> {
    let ms = marfa_rules::time::read(body.get(field)?.as_str()?).ok()?;
    Stamp::from_ms(ms).ok()
}

fn interval_at(body: &Value) -> Option<i64> {
    let seconds = body.get("interval")?.as_i64()?;
    Some(
        seconds
            .saturating_mul(1_000)
            .clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS),
    )
}

fn started_of(body: &Value) -> Option<Started> {
    Some(Started {
        link_id: text_at(body, "link_id")?,
        poll_secret: text_at(body, "poll_secret")?,
        user_code: text_at(body, "user_code")?,
        approval_url: text_at(body, "approval_url")?,
        expires_at: stamp_at(body, "expires_at")?,
        interval_ms: interval_at(body)?,
    })
}

fn seal(sealer: &Sealer, setting: &str, secret: String) -> Result<String> {
    sealer
        .seal(setting, &Secret::new(secret))
        .ok_or_else(|| Refusal::internal("a secret of the link did not seal"))
}

pub async fn start(
    app: &Arc<App>,
    caller: &Caller,
    asked: SignIn,
    confirmed: bool,
) -> Result<Value> {
    let _door = app.cloud.door.lock().await;
    let Some(bound) = app.bound() else {
        return Err(Refusal::new(
            Code::NoPublicListener,
            "This server runs with no public listener, which Marfa Cloud would reach it through.",
        ));
    };
    if !reachable_on_loopback(bound.ip()) {
        return Err(Refusal::new(
            Code::NoPublicListener,
            "Marfa Cloud reaches this server at 127.0.0.1, where its public listener is not bound. \
             Set MARFA_LISTEN_HOST to 127.0.0.1 or 0.0.0.0.",
        ));
    }
    let port = bound.port();
    let reading = app.clone();
    let judged = caller.clone();
    let (name, decided) = app
        .db
        .read(move |tx| {
            refuse_existing(&reading, tx)?;
            let decided = decide_move(
                tx,
                &judged,
                &reading.clock.stamp(),
                reading.clock.now_ms(),
                asked,
                confirmed,
            )?;
            Ok((instance::stored_name(tx)?, decided))
        })
        .await?;
    let body = json!({
        "instance_id": app.instance_id,
        "instance_name": name,
        "origin_port": port,
    });
    let answer = client::send(app, client::Method::Post(body), "/link/start", None)
        .await
        .map_err(|failed| unavailable(failed.word()))?;
    if answer.status != 201 {
        return Err(unavailable("refused"));
    }
    let started = started_of(&answer.body).ok_or_else(|| unavailable("unreadable"))?;
    let poll_secret = seal(app.settings.sealer(), POLL_SECRET, started.poll_secret)?;
    let writing = app.clone();
    let answer = app
        .write(caller, "cloud.link_start", move |unit| {
            unit.caller.require(Permission::ConfigManage)?;
            let tx = unit.tx();
            refuse_existing(&writing, tx)?;
            let now = unit.instant;
            if decide_move(tx, &unit.caller, &unit.at, now.ms(), asked, confirmed)? != decided {
                return Err(Refusal::new(
                    Code::Conflict,
                    "The instance changed while the link started. Try again.",
                ));
            }
            let link = Link {
                link_id: started.link_id,
                state: State::Linking,
                user_code: started.user_code,
                approval_url: started.approval_url,
                expires_at: started.expires_at,
                interval_ms: started.interval_ms,
                started_at: now,
                poll_secret: Some(poll_secret),
                sign_in_move: decided,
                previous_sign_in_address: None,
                name: None,
                address: None,
                approved_at: None,
                linked_at: None,
                tunnel_token: None,
                link_credential: None,
                failure_reason: None,
                failure_message: None,
                ended_at: None,
            };
            store::put(tx, &link)?;
            unit.audit(
                "cloud_link",
                &link.link_id,
                Some(json!({ "sign_in_address": asked.word() })),
            )?;
            let status = status_in(&writing, tx)?;
            announce(unit, &status)?;
            Ok(status)
        })
        .await?;
    app.cloud.wake();
    Ok(answer)
}

/// Ends the link in the write `unit` holds, keeping what Marfa Cloud must still be told.
fn end_link(unit: &Unit<'_, '_>, app: &App, link_id: &str) -> Result<Option<Unlink>> {
    changing(unit, app, |unit| {
        let tx = unit.tx();
        let Some(link) = store::read(tx)?.filter(|link| link.link_id == link_id) else {
            return Err(Refusal::new(
                Code::Conflict,
                "The link changed while it was unlinked. Try again.",
            ));
        };
        let sealer = app.settings.sealer();
        let now = unit.instant;
        let credential = link
            .link_credential
            .clone()
            .filter(|sealed| sealer.open(LINK_CREDENTIAL, sealed).is_some());
        let poll_secret = link
            .poll_secret
            .clone()
            .filter(|sealed| sealer.open(POLL_SECRET, sealed).is_some())
            .filter(|_| link.state == State::Linking && !status::expired(&link, now.ms()));
        let told = match (link.state, credential, poll_secret) {
            (State::Failed | State::Ended, _, _) | (_, None, None) => None,
            (_, link_credential, poll_secret) => Some(Unlink {
                link_id: link.link_id.clone(),
                link_credential,
                poll_secret,
                expires_at: link.expires_at,
                interval_ms: link.interval_ms,
                until_at: now.plus_ms(TELL_FOR_MS)?,
            }),
        };
        store::remove(tx)?;
        if let Some(unlink) = &told {
            store::queue(tx, unlink)?;
        }
        unit.audit_also("cloud.unlink", "cloud_link", &link.link_id, None)?;
        Ok(told)
    })
}

pub async fn unlink(app: &Arc<App>, caller: &Caller, confirmed: bool) -> Result<Value> {
    let _door = app.cloud.door.lock().await;
    let reading = app.clone();
    let (link, sign_in) = app
        .db
        .read(move |tx| Ok((store::read(tx)?, sign_in_in(&reading, tx)?)))
        .await?;
    let Some(link) = link else {
        return Ok(json!({ "state": "not_linked" }));
    };
    let linked = link.state == State::Linked;
    let link_id = link.link_id.clone();
    let ending = app.clone();
    let queued = match status::cloud_address(&link).filter(|address| *address == sign_in) {
        Some(cloud) => {
            let previous = link
                .previous_sign_in_address
                .as_deref()
                .map(Address::parse)
                .transpose()
                .map_err(|_| {
                    Refusal::internal("the sign-in address the link moved does not read")
                })?;
            let request = Request::sign_in_move(
                previous.as_ref(),
                confirmed,
                Some(cloud),
                app.settings.sealer(),
            )?;
            config::update_with(app, caller, request, Authority::Caller, move |unit, _| {
                end_link(unit, &ending, &link_id)
            })
            .await?
            .1
        }
        None => {
            app.write(caller, "cloud.unlink", move |unit| {
                unit.caller.require(Permission::ConfigManage)?;
                end_link(unit, &ending, &link_id)
            })
            .await?
        }
    };
    let mut answer = json!({ "state": "not_linked" });
    if let Some(unlink) = queued {
        let told = unlink.link_credential.is_some() && worker::tell(app, &unlink).await;
        if !told {
            app.cloud.wake();
        }
        if linked {
            answer["service_told"] = told.into();
        }
    }
    Ok(answer)
}

/// Keeps the link in step with a write that may have moved the sign-in address.
pub fn after_config(unit: &Unit<'_, '_>, app: &App, change: &SignInChange) -> Result<()> {
    let tx = unit.tx();
    let Some(mut link) = store::read(tx)? else {
        return Ok(());
    };
    let before = seen(app, Some(&link), &change.before).to_json();
    let cloud = status::cloud_address(&link);
    let arrived = cloud
        .as_ref()
        .is_some_and(|cloud| *cloud == change.after && *cloud != change.before);
    if arrived && link.sign_in_move != Move::Done {
        link.sign_in_move = Move::Done;
        link.previous_sign_in_address = change
            .stored_before
            .as_ref()
            .map(|address| address.origin().to_string());
        store::put(tx, &link)?;
    }
    let after = seen(app, Some(&link), &change.after).to_json();
    if before != after {
        announce(unit, &after)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};

    use super::*;

    #[test]
    fn a_listener_is_reachable_on_loopback_only_where_127_0_0_1_reaches_it() {
        let reached: [(IpAddr, bool); 7] = [
            (Ipv4Addr::LOCALHOST.into(), true),
            (Ipv4Addr::new(127, 0, 0, 2).into(), true),
            (Ipv4Addr::UNSPECIFIED.into(), true),
            (Ipv6Addr::UNSPECIFIED.into(), true),
            (Ipv4Addr::new(192, 168, 1, 20).into(), false),
            (Ipv6Addr::LOCALHOST.into(), false),
            (Ipv4Addr::new(10, 0, 0, 1).to_ipv6_mapped().into(), false),
        ];
        for (ip, reachable) in reached {
            assert_eq!(reachable_on_loopback(ip), reachable, "{ip}");
        }
    }
}

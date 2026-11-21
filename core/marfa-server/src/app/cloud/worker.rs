//! Follows a started link: asks Marfa Cloud about it, carries out a confirmed move of the
//! sign-in address, and tells Marfa Cloud of unlinks. With no link it waits to be woken.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use super::client::{self, Answer, Method};
use super::status::{self, MOVE_WINDOW_MS};
use super::store::{self, Link, Move, State, Unlink};
use super::{
    LINK_CREDENTIAL, MAX_INTERVAL_MS, MIN_INTERVAL_MS, POLL_SECRET, TUNNEL_TOKEN, changing,
    interval_at, seal, secrets_open, sign_in_in, stamp_at, text_at,
};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::addresses::Address;
use crate::app::auth::carries_sessions;
use crate::app::config::{self, Authority, Request};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::unit::Unit;
use crate::settings::sealed::Secret;

const MOVE_FIRST_WAIT_MS: i64 = 5_000;
const TELL_FIRST_WAIT_MS: i64 = 5_000;
/// How often a linked link is checked, so an unlink on Marfa Cloud is noticed.
const CHECK_EVERY_MS: i64 = 15 * 60 * 1000;
const CHECK_FIRST_WAIT_MS: i64 = 5_000;
const UNLINKED_BY_SERVICE: &str = "unlinked_by_service";

/// When a task is next due, and the wait after a failure that doubles each time.
#[derive(Clone, Copy, Debug, Default)]
struct Due {
    at_ms: i64,
    failed_ms: Option<i64>,
}

impl Due {
    fn now(now_ms: i64) -> Due {
        Due {
            at_ms: now_ms,
            failed_ms: None,
        }
    }

    fn after(now_ms: i64, wait_ms: i64) -> Due {
        Due {
            at_ms: now_ms.saturating_add(wait_ms),
            failed_ms: None,
        }
    }

    fn failed(self, now_ms: i64, first_ms: i64) -> Due {
        let wait = self
            .failed_ms
            .map_or(first_ms, |last| last.saturating_mul(2))
            .clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS);
        Due {
            at_ms: now_ms.saturating_add(wait),
            failed_ms: Some(wait),
        }
    }
}

#[derive(Default)]
struct Plan {
    link: Option<(String, Due)>,
    moving: Option<(String, Due)>,
    checking: Option<(String, Due)>,
    unlinks: HashMap<String, Due>,
}

pub fn start(app: &Arc<App>) {
    let app = app.clone();
    tokio::spawn(async move {
        app.cloud.running.send_replace(true);
        let mut moves = app.clock.moves();
        let mut plan = Plan::default();
        while !app.cloud.stopping() {
            let wait = match step(&app, &mut plan).await {
                Ok(wait) => wait,
                Err(refusal) => {
                    tracing::error!(
                        code = refusal.code.wire(),
                        "The link to Marfa Cloud could not be followed"
                    );
                    Some(Duration::from_millis(MAX_INTERVAL_MS as u64))
                }
            };
            if app.cloud.stopping() {
                break;
            }
            let sleeping = async {
                match wait {
                    Some(wait) => tokio::time::sleep(wait).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                () = app.cloud.wake.notified() => {}
                _ = moves.changed() => {}
                () = sleeping => {}
            }
        }
        app.cloud.running.send_replace(false);
    });
}

/// Does what is due, and says how long until something else is.
async fn step(app: &Arc<App>, plan: &mut Plan) -> Result<Option<Duration>> {
    let (link, unlinks) = app
        .db
        .read(|tx| Ok((store::read(tx)?, store::unlinks(tx)?)))
        .await?;
    let mut next: Option<i64> = None;
    let mut due = |at_ms: i64| next = Some(next.map_or(at_ms, |next| next.min(at_ms)));
    match link {
        Some(link) if secrets_open(app.settings.sealer(), &link) => {
            if let Some(at_ms) = follow(app, plan, &link).await? {
                due(at_ms);
            }
        }
        _ => {
            plan.link = None;
            plan.moving = None;
            plan.checking = None;
        }
    }
    plan.unlinks
        .retain(|link_id, _| unlinks.iter().any(|unlink| unlink.link_id == *link_id));
    for unlink in &unlinks {
        if let Some(at_ms) = tell_due(app, plan, unlink).await? {
            due(at_ms);
        }
    }
    let now_ms = app.clock.now_ms();
    Ok(next.map(|at_ms| Duration::from_millis(u64::try_from(at_ms - now_ms).unwrap_or(0))))
}

/// Moves the link on where it is due, and says when it is next due.
async fn follow(app: &Arc<App>, plan: &mut Plan, link: &Link) -> Result<Option<i64>> {
    let now_ms = app.clock.now_ms();
    match link.state {
        State::Failed => {
            plan.link = None;
            plan.moving = None;
            plan.checking = None;
            Ok(None)
        }
        State::Linking => {
            plan.moving = None;
            plan.checking = None;
            if status::expired(link, now_ms) {
                fail(app, &link.link_id, "expired", None).await?;
                return Ok(Some(now_ms));
            }
            let mut due = match &plan.link {
                Some((link_id, due)) if *link_id == link.link_id => *due,
                _ => Due::after(link.started_at.ms().max(now_ms), link.interval_ms),
            };
            if due.at_ms <= now_ms {
                due = ask(app, link, due).await?;
            }
            plan.link = Some((link.link_id.clone(), due));
            Ok(Some(if link.link_credential.is_none() {
                due.at_ms.min(status::ceiling_ms(link.expires_at))
            } else {
                due.at_ms
            }))
        }
        State::Linked => {
            let just_linked = plan
                .link
                .take()
                .is_some_and(|(link_id, _)| link_id == link.link_id);
            let mut checking = match &plan.checking {
                Some((link_id, due)) if *link_id == link.link_id => *due,
                _ if just_linked => Due::after(now_ms, CHECK_EVERY_MS),
                _ => Due::now(now_ms),
            };
            if checking.at_ms <= now_ms {
                checking = match check(app, link).await? {
                    Checked::Linked => Due::after(now_ms, CHECK_EVERY_MS),
                    Checked::Ended => {
                        plan.checking = None;
                        plan.moving = None;
                        return Ok(Some(app.clock.now_ms()));
                    }
                    Checked::Failed => checking.failed(now_ms, CHECK_FIRST_WAIT_MS),
                };
            }
            plan.checking = Some((link.link_id.clone(), checking));
            if link.sign_in_move != Move::Authorized {
                plan.moving = None;
                return Ok(Some(checking.at_ms));
            }
            if status::move_lapsed(link, now_ms) {
                set_move(app, &link.link_id, Move::Waiting).await?;
                plan.moving = None;
                return Ok(Some(now_ms));
            }
            let mut due = match &plan.moving {
                Some((link_id, due)) if *link_id == link.link_id => *due,
                _ => Due::now(now_ms),
            };
            if due.at_ms <= now_ms {
                due = match carry_out_move(app, link).await {
                    Ok(()) => Due::now(now_ms),
                    Err(refusal) => {
                        tracing::info!(
                            code = refusal.code.wire(),
                            "The sign-in address waits to move to the Marfa Cloud address"
                        );
                        due.failed(now_ms, MOVE_FIRST_WAIT_MS)
                    }
                };
            }
            plan.moving = Some((link.link_id.clone(), due));
            let window = link.approved_at.map_or(now_ms, |approved| {
                approved.ms().saturating_add(MOVE_WINDOW_MS)
            });
            Ok(Some(
                due.at_ms.min(window.saturating_add(1)).min(checking.at_ms),
            ))
        }
        State::Ended => {
            plan.link = None;
            plan.checking = None;
            plan.moving = None;
            Ok(None)
        }
    }
}

enum Checked {
    Linked,
    /// Marfa Cloud no longer knows the credential, so the link was ended there.
    Ended,
    Failed,
}

/// Asks Marfa Cloud whether a linked link still stands, and ends it here if it does not.
async fn check(app: &Arc<App>, link: &Link) -> Result<Checked> {
    let Some(credential) = open(link.link_credential.as_ref(), LINK_CREDENTIAL, app) else {
        return Ok(Checked::Failed);
    };
    match client::send(app, Method::Get, "/link", Some(&credential)).await {
        Ok(answer) if answer.status == 200 => Ok(Checked::Linked),
        Ok(answer) if answer.status == 401 => {
            end_by_service(app, link).await?;
            Ok(Checked::Ended)
        }
        Ok(_) | Err(_) => Ok(Checked::Failed),
    }
}

/// Ends a link Marfa Cloud ended, putting back the sign-in address its name replaced.
async fn end_by_service(app: &Arc<App>, link: &Link) -> Result<()> {
    let reading = app.clone();
    let sign_in = app.db.read(move |tx| sign_in_in(&reading, tx)).await?;
    let link_id = link.link_id.clone();
    let ending = app.clone();
    let end = move |unit: &Unit<'_, '_>| -> Result<()> {
        changing(unit, &ending, |unit| {
            let tx = unit.tx();
            let Some(mut link) = store::read(tx)?
                .filter(|link| link.link_id == link_id && link.state == State::Linked)
            else {
                return Err(Refusal::new(
                    Code::Conflict,
                    "The link changed before it was ended.",
                ));
            };
            link.state = State::Ended;
            link.failure_reason = Some(UNLINKED_BY_SERVICE.to_string());
            link.failure_message = None;
            link.ended_at = Some(unit.instant);
            link.poll_secret = None;
            link.tunnel_token = None;
            link.link_credential = None;
            store::put(tx, &link)?;
            unit.audit_also(
                "cloud.unlink",
                "cloud_link",
                &link.link_id,
                Some(json!({ "reason": UNLINKED_BY_SERVICE })),
            )
        })
    };
    let Some(cloud) = status::cloud_address(link).filter(|cloud| *cloud == sign_in) else {
        return app.write(&Caller::Server, "cloud.unlink", end).await;
    };
    let previous = link
        .previous_sign_in_address
        .as_deref()
        .map(Address::parse)
        .transpose()
        .map_err(|_| Refusal::internal("the sign-in address the link moved does not read"))?;
    let request =
        Request::sign_in_move(previous.as_ref(), true, Some(cloud), app.settings.sealer())?;
    let link_id = link.link_id.clone();
    config::update_with(
        app,
        &Caller::Server,
        request,
        Authority::Restored,
        move |unit, _| {
            end(unit)?;
            unit.audit_also(
                "cloud.sign_in_address_move",
                "cloud_link",
                &link_id,
                Some(json!({ "reason": UNLINKED_BY_SERVICE })),
            )
        },
    )
    .await?;
    Ok(())
}

fn open(sealed: Option<&String>, setting: &str, app: &App) -> Option<Secret> {
    app.settings.sealer().open(setting, sealed?)
}

/// Asks Marfa Cloud about a link that is linking: confirms an approved one, or polls.
async fn ask(app: &Arc<App>, link: &Link, due: Due) -> Result<Due> {
    let now_ms = app.clock.now_ms();
    if let Some(credential) = open(link.link_credential.as_ref(), LINK_CREDENTIAL, app) {
        match client::send(app, Method::Get, "/link", Some(&credential)).await {
            Ok(answer) if answer.status == 200 => {
                return match confirmed(app, link, &answer.body).await? {
                    true => Ok(Due::now(now_ms)),
                    false => Ok(due.failed(now_ms, link.interval_ms)),
                };
            }
            Ok(answer) if answer.status == 401 => {}
            Ok(_) | Err(_) => return Ok(due.failed(now_ms, link.interval_ms)),
        }
    }
    let Some(secret) = open(link.poll_secret.as_ref(), POLL_SECRET, app) else {
        return Ok(due.failed(now_ms, link.interval_ms));
    };
    let polled = poll(app, &link.link_id, &secret).await;
    let now_ms = app.clock.now_ms();
    Ok(match polled {
        Polled::Waiting(interval_ms) => {
            if interval_ms != link.interval_ms {
                set_interval(app, &link.link_id, interval_ms).await?;
            }
            Due::after(now_ms, interval_ms)
        }
        Polled::Approved(approved) => {
            keep_approved(app, &link.link_id, approved).await?;
            Due::now(now_ms)
        }
        Polled::Ended(reason, message) => {
            fail(app, &link.link_id, reason, message).await?;
            Due::now(now_ms)
        }
        Polled::Unknown => {
            fail(app, &link.link_id, "unlinked", None).await?;
            Due::now(now_ms)
        }
        Polled::Later(wait_ms) => Due::after(now_ms, wait_ms.max(link.interval_ms)),
        Polled::Failed => due.failed(now_ms, link.interval_ms),
    })
}

struct Approved {
    name: String,
    address: Address,
    tunnel_token: String,
    link_credential: String,
}

enum Polled {
    /// Still waiting for approval; the next poll is no sooner than this.
    Waiting(i64),
    Approved(Approved),
    /// Denied, expired or refused, with Marfa Cloud's message for a refusal.
    Ended(&'static str, Option<String>),
    /// Marfa Cloud no longer knows the link and secret.
    Unknown,
    /// Too many requests: no sooner than this.
    Later(i64),
    Failed,
}

async fn poll(app: &App, link_id: &str, secret: &Secret) -> Polled {
    let body = json!({ "link_id": link_id, "poll_secret": secret.expose() });
    let answer = match client::send(app, Method::Post(body), "/link/poll", None).await {
        Ok(answer) => answer,
        Err(_) => return Polled::Failed,
    };
    match answer.status {
        200 => polled_of(&answer.body),
        404 => Polled::Unknown,
        429 => Polled::Later(retry_after_ms(&answer)),
        _ => Polled::Failed,
    }
}

fn retry_after_ms(answer: &Answer) -> i64 {
    answer.retry_after.map_or(MIN_INTERVAL_MS, |wait| {
        i64::try_from(wait.as_millis())
            .unwrap_or(MAX_INTERVAL_MS)
            .min(MAX_INTERVAL_MS)
    })
}

fn polled_of(body: &Value) -> Polled {
    match body.get("status").and_then(Value::as_str) {
        Some("pending" | "slow_down") => interval_at(body).map_or(Polled::Failed, Polled::Waiting),
        Some("approved") => approved_of(body).map_or(Polled::Failed, Polled::Approved),
        Some("denied") => Polled::Ended("denied", None),
        Some("expired") => Polled::Ended("expired", None),
        Some("refused") => Polled::Ended("refused", text_at(body, "message")),
        _ => Polled::Failed,
    }
}

fn approved_of(body: &Value) -> Option<Approved> {
    let address = Address::parse(&text_at(body, "address")?)
        .ok()
        .filter(carries_sessions)?;
    Some(Approved {
        name: text_at(body, "name")?,
        address,
        tunnel_token: text_at(body, "tunnel_token")?,
        link_credential: text_at(body, "link_credential")?,
    })
}

/// Writes to the link as the server, if it is still `link_id`; says whether it was.
async fn write_link(
    app: &Arc<App>,
    action: &'static str,
    link_id: &str,
    change: impl FnOnce(&Unit<'_, '_>, &mut Link) -> Result<()> + Send + 'static,
) -> Result<bool> {
    let writing = app.clone();
    let link_id = link_id.to_string();
    app.write(&Caller::Server, action, move |unit| {
        changing(unit, &writing, |unit| {
            let tx = unit.tx();
            let Some(mut link) = store::read(tx)?.filter(|link| link.link_id == link_id) else {
                return Ok(false);
            };
            change(unit, &mut link)?;
            store::put(tx, &link)?;
            Ok(true)
        })
    })
    .await
}

async fn set_interval(app: &Arc<App>, link_id: &str, interval_ms: i64) -> Result<bool> {
    write_link(app, "cloud.link_poll", link_id, move |_, link| {
        link.interval_ms = interval_ms;
        Ok(())
    })
    .await
}

async fn set_move(app: &Arc<App>, link_id: &str, to: Move) -> Result<bool> {
    write_link(app, "cloud.link_poll", link_id, move |_, link| {
        if link.sign_in_move == Move::Authorized {
            link.sign_in_move = to;
        }
        Ok(())
    })
    .await
}

/// Keeps the latest approved answer, whose credential replaces any before it.
async fn keep_approved(app: &Arc<App>, link_id: &str, approved: Approved) -> Result<bool> {
    let sealer = app.settings.sealer();
    let tunnel_token = seal(sealer, TUNNEL_TOKEN, approved.tunnel_token)?;
    let link_credential = seal(sealer, LINK_CREDENTIAL, approved.link_credential)?;
    write_link(app, "cloud.link_poll", link_id, move |unit, link| {
        if link.state != State::Linking {
            return Ok(());
        }
        link.name = Some(approved.name);
        link.address = Some(approved.address.origin().to_string());
        link.tunnel_token = Some(tunnel_token);
        link.link_credential = Some(link_credential);
        link.approved_at = Some(link.approved_at.unwrap_or(unit.instant));
        Ok(())
    })
    .await
}

/// Takes the link as linked once its credential works; says whether the answer read.
async fn confirmed(app: &Arc<App>, link: &Link, body: &Value) -> Result<bool> {
    let (Some(name), Some(address), Some(linked_at)) = (
        text_at(body, "name"),
        text_at(body, "address")
            .and_then(|text| Address::parse(&text).ok())
            .filter(carries_sessions),
        stamp_at(body, "linked_at"),
    ) else {
        return Ok(false);
    };
    write_link(app, "cloud.linked", &link.link_id, move |unit, link| {
        if link.state != State::Linking {
            return Ok(());
        }
        link.state = State::Linked;
        link.name = Some(name);
        link.address = Some(address.origin().to_string());
        link.linked_at = Some(linked_at);
        link.poll_secret = None;
        unit.audit("cloud_link", &link.link_id, None)
    })
    .await?;
    Ok(true)
}

async fn fail(
    app: &Arc<App>,
    link_id: &str,
    reason: &'static str,
    message: Option<String>,
) -> Result<bool> {
    write_link(app, "cloud.link_failed", link_id, move |unit, link| {
        if link.state != State::Linking {
            return Ok(());
        }
        link.state = State::Failed;
        link.failure_reason = Some(reason.to_string());
        link.failure_message = message;
        link.poll_secret = None;
        link.tunnel_token = None;
        link.link_credential = None;
        unit.audit(
            "cloud_link",
            &link.link_id,
            Some(json!({ "reason": reason })),
        )
    })
    .await
}

/// Moves the sign-in address to the link's address, as the start confirmed.
async fn carry_out_move(app: &Arc<App>, link: &Link) -> Result<()> {
    let address = status::cloud_address(link)
        .ok_or_else(|| Refusal::internal("the Marfa Cloud address does not read"))?;
    let request = Request::sign_in_move(Some(&address), true, None, app.settings.sealer())?;
    let link_id = link.link_id.clone();
    config::update_with(
        app,
        &Caller::Server,
        request,
        Authority::Confirmed,
        move |unit, _| {
            let current = store::read(unit.tx())?;
            let still = current.is_some_and(|link| {
                link.link_id == link_id
                    && link.state == State::Linked
                    && link.sign_in_move == Move::Authorized
            });
            if !still {
                return Err(Refusal::new(
                    Code::Conflict,
                    "The link changed before the sign-in address moved.",
                ));
            }
            unit.audit_also("cloud.sign_in_address_move", "cloud_link", &link_id, None)
        },
    )
    .await?;
    Ok(())
}

/// Tells Marfa Cloud of an unlink where it is due, and says when it is next due.
async fn tell_due(app: &Arc<App>, plan: &mut Plan, unlink: &Unlink) -> Result<Option<i64>> {
    let now_ms = app.clock.now_ms();
    let watching = unlink.link_credential.is_none();
    if now_ms >= unlink.until_at.ms()
        || (watching && now_ms >= status::ceiling_ms(unlink.expires_at))
    {
        forget(app, &unlink.link_id).await?;
        return Ok(None);
    }
    let mut due = plan
        .unlinks
        .get(&unlink.link_id)
        .copied()
        .unwrap_or_else(|| Due::now(now_ms));
    if due.at_ms <= now_ms {
        due = told(app, unlink, due).await?;
    }
    plan.unlinks.insert(unlink.link_id.clone(), due);
    Ok(Some(due.at_ms))
}

async fn told(app: &Arc<App>, unlink: &Unlink, due: Due) -> Result<Due> {
    let now_ms = app.clock.now_ms();
    if unlink.link_credential.is_some() {
        let Some(credential) = open(unlink.link_credential.as_ref(), LINK_CREDENTIAL, app) else {
            forget(app, &unlink.link_id).await?;
            return Ok(Due::now(now_ms));
        };
        return Ok(match send_unlink(app, &credential).await {
            Some(200) => {
                forget(app, &unlink.link_id).await?;
                Due::now(now_ms)
            }
            Some(401) if unlink.poll_secret.is_some() => {
                requeue(app, unlink, None).await?;
                Due::now(now_ms)
            }
            Some(401) => {
                forget(app, &unlink.link_id).await?;
                Due::now(now_ms)
            }
            Some(_) | None => due.failed(now_ms, TELL_FIRST_WAIT_MS),
        });
    }
    let Some(secret) = open(unlink.poll_secret.as_ref(), POLL_SECRET, app) else {
        forget(app, &unlink.link_id).await?;
        return Ok(Due::now(now_ms));
    };
    let polled = poll(app, &unlink.link_id, &secret).await;
    let now_ms = app.clock.now_ms();
    Ok(match polled {
        Polled::Waiting(interval_ms) => Due::after(now_ms, interval_ms),
        Polled::Approved(approved) => {
            let sealed = seal(
                app.settings.sealer(),
                LINK_CREDENTIAL,
                approved.link_credential,
            )?;
            requeue(app, unlink, Some(sealed)).await?;
            Due::now(now_ms)
        }
        Polled::Ended(..) | Polled::Unknown => {
            forget(app, &unlink.link_id).await?;
            Due::now(now_ms)
        }
        Polled::Later(wait_ms) => Due::after(now_ms, wait_ms.max(unlink.interval_ms)),
        Polled::Failed => due.failed(now_ms, unlink.interval_ms),
    })
}

async fn send_unlink(app: &App, credential: &Secret) -> Option<u16> {
    client::send(
        app,
        Method::Post(json!({})),
        "/link/unlink",
        Some(credential),
    )
    .await
    .ok()
    .map(|answer| answer.status)
}

/// Tells Marfa Cloud of an unlink now; says whether it was told.
pub async fn tell(app: &Arc<App>, unlink: &Unlink) -> bool {
    let Some(credential) = open(unlink.link_credential.as_ref(), LINK_CREDENTIAL, app) else {
        return false;
    };
    match send_unlink(app, &credential).await {
        Some(200) => forget(app, &unlink.link_id).await.is_ok(),
        _ => false,
    }
}

async fn forget(app: &Arc<App>, link_id: &str) -> Result<()> {
    let link_id = link_id.to_string();
    app.write(&Caller::Server, "cloud.unlink_told", move |unit| {
        store::forget(unit.tx(), &link_id)
    })
    .await
}

/// Keeps an unlink with a new credential, or with none, to poll for one.
async fn requeue(app: &Arc<App>, unlink: &Unlink, credential: Option<String>) -> Result<()> {
    let unlink = Unlink {
        link_credential: credential,
        ..unlink.clone()
    };
    app.write(&Caller::Server, "cloud.unlink_told", move |unit| {
        if store::unlinks(unit.tx())?
            .iter()
            .any(|kept| kept.link_id == unlink.link_id)
        {
            store::queue(unit.tx(), &unlink)?;
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_waits_twice_as_long_each_time_up_to_the_most() {
        let mut due = Due::now(0);
        let mut waits = Vec::new();
        for _ in 0..9 {
            due = due.failed(0, MOVE_FIRST_WAIT_MS);
            waits.push(due.at_ms);
        }
        assert_eq!(
            waits,
            [
                5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000
            ]
        );
        assert_eq!(Due::after(7, 1_000).failed(7, 1_000).at_ms, 1_007);
    }

    #[test]
    fn reads_each_poll_answer_and_refuses_an_untidy_one() {
        let read = |body: Value| match polled_of(&body) {
            Polled::Waiting(ms) => format!("waiting {ms}"),
            Polled::Approved(approved) => format!("approved {}", approved.address.origin()),
            Polled::Ended(reason, message) => format!("ended {reason} {message:?}"),
            Polled::Unknown => "unknown".into(),
            Polled::Later(ms) => format!("later {ms}"),
            Polled::Failed => "failed".into(),
        };
        let approved = json!({
            "status": "approved",
            "name": "river",
            "address": "https://river.example.com",
            "tunnel_token": "t",
            "link_credential": "c",
        });
        assert_eq!(
            read(json!({"status": "pending", "interval": 5})),
            "waiting 5000"
        );
        assert_eq!(
            read(json!({"status": "slow_down", "interval": 0})),
            "waiting 1000"
        );
        assert_eq!(
            read(json!({"status": "pending", "interval": 9999})),
            "waiting 300000"
        );
        assert_eq!(read(json!({"status": "pending"})), "failed");
        assert_eq!(read(approved.clone()), "approved https://river.example.com");
        let mut plain = approved.clone();
        plain["address"] = json!("http://river.example.com");
        assert_eq!(read(plain), "failed");
        let mut nameless = approved;
        nameless["name"] = json!("");
        assert_eq!(read(nameless), "failed");
        assert_eq!(read(json!({"status": "denied"})), "ended denied None");
        assert_eq!(
            read(json!({"status": "refused", "message": "One instance only."})),
            "ended refused Some(\"One instance only.\")"
        );
        assert_eq!(read(json!({"status": "linked"})), "failed");
        assert_eq!(read(json!("approved")), "failed");
    }
}

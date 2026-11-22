//! Follows a started link and the unlinks Marfa Cloud has not been told of; idle with neither.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use super::client::{self, Answer, Method};
use super::status::{self, MOVE_WINDOW_MS};
use super::store::{self, Link, Move, State, Unlink};
use super::{
    LINK_CREDENTIAL, MAX_INTERVAL_MS, MIN_INTERVAL_MS, POLL_SECRET, TUNNEL_TOKEN, changing,
    interval_at, put_back, refuse_moved, resync, seal, secrets_open, sign_in_in, stamp_at, text_at,
};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::addresses::Address;
use crate::app::auth::carries_sessions;
use crate::app::clock::Stamp;
use crate::app::config::{self, Authority, Request};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::unit::Unit;
use crate::settings::sealed::Secret;

const MOVE_FIRST_WAIT_MS: i64 = 5_000;
const TELL_FIRST_WAIT_MS: i64 = 5_000;
/// The longest wait between tries to tell Marfa Cloud of an unlink, which go on until it is told.
const TELL_MOST_WAIT_MS: i64 = 60 * 60 * 1000;
/// How often a linked link is checked, so an unlink on Marfa Cloud is noticed.
const CHECK_EVERY_MS: i64 = 15 * 60 * 1000;
const CHECK_FIRST_WAIT_MS: i64 = 5_000;
const UNLINKED_BY_SERVICE: &str = "unlinked_by_service";
/// How many put-backs fail before the next refused one ends a link Marfa Cloud ended without it.
const PUT_BACK_TRIES: u32 = 3;

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
        self.failed_up_to(now_ms, first_ms, MAX_INTERVAL_MS)
    }

    fn failed_up_to(self, now_ms: i64, first_ms: i64, most_ms: i64) -> Due {
        let wait = self
            .failed_ms
            .map_or(first_ms, |last| last.saturating_mul(2))
            .clamp(MIN_INTERVAL_MS, most_ms);
        Due {
            at_ms: now_ms.saturating_add(wait),
            failed_ms: Some(wait),
        }
    }
}

/// After a write of the server's own fails, such as one that met another, it is tried again soon.
fn retried(due: Due, now_ms: i64, task: &'static str, refusal: &Refusal) -> Due {
    tracing::warn!(
        code = refusal.code.wire(),
        task,
        "A step in following the link to Marfa Cloud failed, and is tried again"
    );
    due.failed(now_ms, MIN_INTERVAL_MS)
}

/// A linking link as it is followed: when it is next asked about, and whether that is a poll.
#[derive(Clone)]
struct Asking {
    link_id: String,
    due: Due,
    /// Marfa Cloud refused the credential, so a newer one is polled for.
    poll_next: bool,
    /// An answer whose write failed, written again before Marfa Cloud is asked again.
    unwritten: Option<(Answered, Due)>,
}

/// What Marfa Cloud answered about a linking link that the link must keep.
#[derive(Clone)]
enum Answered {
    Interval(i64),
    Approved(Approved),
    Linked(Linked),
    Failed(&'static str, Option<String>),
}

#[derive(Default)]
struct Plan {
    reading: Due,
    link: Option<Asking>,
    moving: Option<(String, Due)>,
    checking: Option<(String, Due)>,
    /// The put-backs that failed as a link Marfa Cloud ended was ended.
    put_back_failed: Option<(String, u32)>,
    unlinks: HashMap<String, Due>,
}

impl Plan {
    fn forget_link(&mut self) {
        self.link = None;
        self.moving = None;
        self.checking = None;
        self.put_back_failed = None;
    }
}

pub fn start(app: &Arc<App>) {
    let app = app.clone();
    tokio::spawn(async move {
        app.cloud.running.send_replace(true);
        let mut moves = app.clock.moves();
        let mut plan = Plan::default();
        while !app.cloud.stopping() {
            let wait = step(&app, &mut plan).await;
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

/// Does what is due, and says how long until something else is. Each task fails on its own.
async fn step(app: &Arc<App>, plan: &mut Plan) -> Option<Duration> {
    let now_ms = app.clock.now_ms();
    let read = match resync(app).await {
        Ok(()) => {
            app.db
                .read(|tx| Ok((store::read(tx)?, store::unlinks(tx)?)))
                .await
        }
        Err(refusal) => Err(refusal),
    };
    let (link, unlinks) = match read {
        Ok(read) => {
            plan.reading = Due::default();
            read
        }
        Err(refusal) => {
            plan.reading = retried(plan.reading, now_ms, "read", &refusal);
            return Some(wait_until(app, plan.reading.at_ms));
        }
    };
    let mut next: Option<i64> = None;
    let mut due = |at_ms: i64| next = Some(next.map_or(at_ms, |next| next.min(at_ms)));
    match link {
        Some(link) if secrets_open(app.settings.sealer(), &link) => {
            if let Some(at_ms) = follow(app, plan, &link).await {
                due(at_ms);
            }
        }
        _ => plan.forget_link(),
    }
    plan.unlinks
        .retain(|link_id, _| unlinks.iter().any(|unlink| unlink.link_id == *link_id));
    for unlink in &unlinks {
        if let Some(at_ms) = tell_due(app, plan, unlink).await {
            due(at_ms);
        }
    }
    next.map(|at_ms| wait_until(app, at_ms))
}

fn wait_until(app: &App, at_ms: i64) -> Duration {
    Duration::from_millis(u64::try_from(at_ms - app.clock.now_ms()).unwrap_or(0))
}

/// Moves the link on where it is due, and says when it is next due.
async fn follow(app: &Arc<App>, plan: &mut Plan, link: &Link) -> Option<i64> {
    let now_ms = app.clock.now_ms();
    match link.state {
        State::Failed | State::Ended => {
            plan.forget_link();
            None
        }
        State::Linking => {
            plan.moving = None;
            plan.checking = None;
            let mut asking = match &plan.link {
                Some(asking) if asking.link_id == link.link_id => asking.clone(),
                _ => Asking {
                    link_id: link.link_id.clone(),
                    due: Due::after(link.started_at.ms().max(now_ms), link.interval_ms),
                    poll_next: false,
                    unwritten: None,
                },
            };
            if status::expired(link, now_ms) {
                if let Err(refusal) = fail(app, &link.link_id, "expired", None).await {
                    asking.due = retried(asking.due, now_ms, "expire", &refusal);
                    let at_ms = asking.due.at_ms;
                    plan.link = Some(asking);
                    return Some(at_ms);
                }
                return Some(now_ms);
            }
            if asking.unwritten.is_none() && asking.due.at_ms <= now_ms {
                asking = ask(app, link, &asking).await;
            }
            if let Some((answered, due)) = asking.unwritten.take() {
                let now_ms = app.clock.now_ms();
                asking.unwritten = if due.at_ms > now_ms {
                    Some((answered, due))
                } else {
                    match keep(app, &link.link_id, answered.clone()).await {
                        Ok(_) => None,
                        Err(refusal) => Some((answered, retried(due, now_ms, "keep", &refusal))),
                    }
                };
            }
            let at_ms = asking
                .unwritten
                .as_ref()
                .map_or(asking.due.at_ms, |(_, due)| due.at_ms);
            plan.link = Some(asking);
            Some(if link.link_credential.is_none() {
                at_ms.min(status::ceiling_ms(link.expires_at))
            } else {
                at_ms
            })
        }
        State::Linked => {
            let just_linked = plan
                .link
                .take()
                .is_some_and(|asking| asking.link_id == link.link_id);
            let mut checking = match &plan.checking {
                Some((link_id, due)) if *link_id == link.link_id => *due,
                _ if just_linked => Due::after(now_ms, CHECK_EVERY_MS),
                _ => Due::now(now_ms),
            };
            if checking.at_ms <= now_ms {
                let tries = match &plan.put_back_failed {
                    Some((link_id, tries)) if *link_id == link.link_id => *tries,
                    _ => 0,
                };
                checking = match check(app, link, tries >= PUT_BACK_TRIES).await {
                    Ok(Checked::Linked) => {
                        plan.put_back_failed = None;
                        Due::after(now_ms, CHECK_EVERY_MS)
                    }
                    Ok(Checked::Ended) => {
                        plan.forget_link();
                        return Some(app.clock.now_ms());
                    }
                    Ok(Checked::Failed) => checking.failed(now_ms, CHECK_FIRST_WAIT_MS),
                    Err(refusal) => {
                        if !transient(&refusal) {
                            plan.put_back_failed = Some((link.link_id.clone(), tries + 1));
                        }
                        retried(checking, now_ms, "end", &refusal)
                    }
                };
            }
            plan.checking = Some((link.link_id.clone(), checking));
            if link.sign_in_move != Move::Authorized {
                plan.moving = None;
                return Some(checking.at_ms);
            }
            let mut due = match &plan.moving {
                Some((link_id, due)) if *link_id == link.link_id => *due,
                _ => Due::now(now_ms),
            };
            if status::move_lapsed(link, now_ms) {
                return Some(match set_move(app, &link.link_id, Move::Waiting).await {
                    Ok(_) => {
                        plan.moving = None;
                        now_ms
                    }
                    Err(refusal) => {
                        due = retried(due, now_ms, "lapse", &refusal);
                        plan.moving = Some((link.link_id.clone(), due));
                        due.at_ms.min(checking.at_ms)
                    }
                });
            }
            if due.at_ms <= now_ms {
                due = match carry_out_move(app, link).await {
                    Ok(()) => Due::now(now_ms),
                    Err(refusal) if transient(&refusal) => retried(due, now_ms, "move", &refusal),
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
            Some(due.at_ms.min(window.saturating_add(1)).min(checking.at_ms))
        }
    }
}

/// A refusal that says only that another write came first.
fn transient(refusal: &Refusal) -> bool {
    matches!(refusal.code, Code::Conflict | Code::WriteContention)
}

/// Marfa Cloud's own answer that it does not know a link credential.
pub(super) fn unauthorized(answer: &Answer) -> bool {
    answer.status == 401
        && answer.body.pointer("/error/code").and_then(Value::as_str) == Some("unauthorized")
}

enum Checked {
    Linked,
    /// Marfa Cloud no longer knows the credential, so the link was ended there.
    Ended,
    Failed,
}

/// Asks Marfa Cloud whether a linked link still stands, and ends it here if it does not.
async fn check(app: &Arc<App>, link: &Link, stranding: bool) -> Result<Checked> {
    let Some(credential) = open(link.link_credential.as_ref(), LINK_CREDENTIAL, app) else {
        return Ok(Checked::Failed);
    };
    match client::send(app, Method::Get, "/link", Some(&credential)).await {
        Ok(answer) if answer.status == 200 => Ok(Checked::Linked),
        Ok(answer) if unauthorized(&answer) => {
            end_by_service(app, link, stranding).await?;
            Ok(Checked::Ended)
        }
        Ok(_) | Err(_) => Ok(Checked::Failed),
    }
}

/// How an end by Marfa Cloud treats the sign-in address.
#[derive(Clone, Copy)]
enum Ending {
    /// It is not at the link's address.
    Leaves,
    /// It is at the link's address, and the same write puts it back.
    PutsBack,
    /// Putting it back failed with this code once too often, so it stays.
    Stranded(Code),
}

/// Ends a link Marfa Cloud ended, putting back the sign-in address its name replaced. With
/// `stranding`, the put-back failed too often, so a put-back refused again ends the link without.
pub(super) async fn end_by_service(app: &Arc<App>, link: &Link, stranding: bool) -> Result<()> {
    let reading = app.clone();
    let sign_in = app.db.read(move |tx| sign_in_in(&reading, tx)).await?;
    let link_id = link.link_id.clone();
    let ending = app.clone();
    let end = move |unit: &Unit<'_, '_>, sign_in: &Address, how: Ending| -> Result<()> {
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
            let mut details = json!({ "reason": UNLINKED_BY_SERVICE });
            match how {
                Ending::Leaves => refuse_moved(&link, sign_in, false)?,
                Ending::PutsBack => refuse_moved(&link, sign_in, true)?,
                Ending::Stranded(code) => {
                    if status::cloud_address(&link).is_some_and(|cloud| cloud == *sign_in) {
                        link.put_back_failure = Some(code.wire().to_string());
                        details["sign_in_address"] = "not_put_back".into();
                        details["put_back_failure"] = code.wire().into();
                    }
                }
            }
            link.state = State::Ended;
            link.failure_reason = Some(UNLINKED_BY_SERVICE.to_string());
            link.failure_message = None;
            link.ended_at = Some(unit.instant);
            link.poll_secret = None;
            link.tunnel_token = None;
            link.link_credential = None;
            store::put(tx, &link)?;
            unit.audit_also("cloud.unlink", "cloud_link", &link.link_id, Some(details))
        })
    };
    let cloud = status::cloud_address(link).filter(|cloud| *cloud == sign_in);
    let how = match cloud {
        None => Ending::Leaves,
        Some(cloud) => match put_back_and_end(app, link, cloud, end.clone()).await {
            Ok(()) => return Ok(()),
            Err(refusal) if !stranding || transient(&refusal) => return Err(refusal),
            Err(refusal) => {
                tracing::warn!(
                    code = refusal.code.wire(),
                    "Marfa Cloud ended the link, and the sign-in address could not be put back"
                );
                Ending::Stranded(refusal.code)
            }
        },
    };
    let reading = app.clone();
    app.write(&Caller::Server, "cloud.unlink", move |unit| {
        let sign_in = sign_in_in(&reading, unit.tx())?;
        end(unit, &sign_in, how)
    })
    .await
}

/// Moves the sign-in address back from `cloud` in the write that ends the link.
async fn put_back_and_end(
    app: &Arc<App>,
    link: &Link,
    cloud: Address,
    end: impl FnOnce(&Unit<'_, '_>, &Address, Ending) -> Result<()> + Send + 'static,
) -> Result<()> {
    let request = put_back(app, link, cloud, true)?;
    let link_id = link.link_id.clone();
    config::update_with(
        app,
        &Caller::Server,
        request,
        Authority::Restored,
        move |unit, change| {
            end(unit, &change.before, Ending::PutsBack)?;
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
async fn ask(app: &Arc<App>, link: &Link, asking: &Asking) -> Asking {
    let failed = |now_ms: i64| asking.due.failed(now_ms, link.interval_ms);
    let next = |due: Due, poll_next: bool, answered: Option<Answered>| Asking {
        link_id: link.link_id.clone(),
        due,
        poll_next,
        unwritten: answered.map(|answered| (answered, Due::now(app.clock.now_ms()))),
    };
    let credential = open(link.link_credential.as_ref(), LINK_CREDENTIAL, app);
    if let Some(credential) = credential.filter(|_| !asking.poll_next) {
        let answer = client::send(app, Method::Get, "/link", Some(&credential)).await;
        let now_ms = app.clock.now_ms();
        return match answer {
            Ok(answer) if answer.status == 200 => match linked_of(&answer.body) {
                Some(linked) => next(Due::now(now_ms), false, Some(Answered::Linked(linked))),
                None => next(failed(now_ms), false, None),
            },
            // A newer approval replaced the credential, so poll for it at the interval.
            Ok(answer) if unauthorized(&answer) => {
                next(Due::after(now_ms, link.interval_ms), true, None)
            }
            Ok(_) | Err(_) => next(failed(now_ms), false, None),
        };
    }
    let Some(secret) = open(link.poll_secret.as_ref(), POLL_SECRET, app) else {
        return next(failed(app.clock.now_ms()), asking.poll_next, None);
    };
    let polled = poll(app, &link.link_id, &secret).await;
    let now_ms = app.clock.now_ms();
    match polled {
        Polled::Waiting(interval_ms) => next(
            Due::after(now_ms, interval_ms),
            false,
            (interval_ms != link.interval_ms).then_some(Answered::Interval(interval_ms)),
        ),
        Polled::Approved(approved) => {
            next(Due::now(now_ms), false, Some(Answered::Approved(approved)))
        }
        Polled::Ended(reason, message) => next(
            Due::now(now_ms),
            false,
            Some(Answered::Failed(reason, message)),
        ),
        Polled::Unknown => next(
            Due::now(now_ms),
            false,
            Some(Answered::Failed("unlinked", None)),
        ),
        Polled::Later(wait_ms) => next(
            Due::after(now_ms, wait_ms.max(link.interval_ms)),
            asking.poll_next,
            None,
        ),
        Polled::Failed => next(failed(now_ms), asking.poll_next, None),
    }
}

/// Writes what Marfa Cloud answered to the link, if it is still `link_id`.
async fn keep(app: &Arc<App>, link_id: &str, answered: Answered) -> Result<bool> {
    match answered {
        Answered::Interval(interval_ms) => set_interval(app, link_id, interval_ms).await,
        Answered::Approved(approved) => keep_approved(app, link_id, approved).await,
        Answered::Linked(linked) => link_up(app, link_id, linked).await,
        Answered::Failed(reason, message) => fail(app, link_id, reason, message).await,
    }
}

#[derive(Clone)]
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
pub(super) async fn write_link(
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

/// What Marfa Cloud answers about a link whose credential works.
#[derive(Clone)]
struct Linked {
    name: String,
    address: Address,
    linked_at: Stamp,
}

fn linked_of(body: &Value) -> Option<Linked> {
    Some(Linked {
        name: text_at(body, "name")?,
        address: text_at(body, "address")
            .and_then(|text| Address::parse(&text).ok())
            .filter(carries_sessions)?,
        linked_at: stamp_at(body, "linked_at")?,
    })
}

/// Takes the link as linked once its credential works.
async fn link_up(app: &Arc<App>, link_id: &str, linked: Linked) -> Result<bool> {
    write_link(app, "cloud.linked", link_id, move |unit, link| {
        if link.state != State::Linking {
            return Ok(());
        }
        link.state = State::Linked;
        link.name = Some(linked.name);
        link.address = Some(linked.address.origin().to_string());
        link.linked_at = Some(linked.linked_at);
        link.poll_secret = None;
        unit.audit("cloud_link", &link.link_id, None)
    })
    .await
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

/// Whether `link` is still the link `link_id`, linked and with its move confirmed, at `now_ms`.
fn moves_still(link: &Link, link_id: &str, now_ms: i64) -> bool {
    link.link_id == link_id
        && link.state == State::Linked
        && link.sign_in_move == Move::Authorized
        && !status::move_lapsed(link, now_ms)
}

/// Moves the sign-in address to the link's address, as the start confirmed.
async fn carry_out_move(app: &Arc<App>, link: &Link) -> Result<()> {
    let address = status::cloud_address(link)
        .ok_or_else(|| Refusal::internal("the Marfa Cloud address does not read"))?;
    if found_moved(app, &link.link_id, &address).await? {
        return Ok(());
    }
    let request = Request::sign_in_move(&address, true, app.settings.sealer())?;
    let link_id = link.link_id.clone();
    config::update_with(
        app,
        &Caller::Server,
        request,
        Authority::Confirmed,
        move |unit, change| {
            let still = store::read(unit.tx())?
                .is_some_and(|link| moves_still(&link, &link_id, unit.instant.ms()));
            if !still {
                return Err(Refusal::new(
                    Code::Conflict,
                    "The link changed before the sign-in address moved.",
                ));
            }
            if change.before == address || change.after != address {
                return Err(Refusal::new(
                    Code::Conflict,
                    "The sign-in address changed before it moved.",
                ));
            }
            unit.audit_also("cloud.sign_in_address_move", "cloud_link", &link_id, None)
        },
    )
    .await?;
    Ok(())
}

/// Takes the move as done where the sign-in address is already `address`; says whether it was.
async fn found_moved(app: &Arc<App>, link_id: &str, address: &Address) -> Result<bool> {
    let reading = app.clone();
    let sign_in = app.db.read(move |tx| sign_in_in(&reading, tx)).await?;
    if sign_in != *address {
        return Ok(false);
    }
    let writing = app.clone();
    let link_id = link_id.to_string();
    let address = address.clone();
    app.write(&Caller::Server, "cloud.link_poll", move |unit| {
        changing(unit, &writing, |unit| {
            let tx = unit.tx();
            let Some(mut link) =
                store::read(tx)?.filter(|link| moves_still(link, &link_id, unit.instant.ms()))
            else {
                return Ok(false);
            };
            if sign_in_in(&writing, tx)? != address {
                return Ok(false);
            }
            link.sign_in_move = Move::Done;
            store::put(tx, &link)?;
            Ok(true)
        })
    })
    .await
}

/// Tells Marfa Cloud of an unlink where it is due, and says when it is next due.
async fn tell_due(app: &Arc<App>, plan: &mut Plan, unlink: &Unlink) -> Option<i64> {
    let now_ms = app.clock.now_ms();
    let mut due = plan
        .unlinks
        .get(&unlink.link_id)
        .copied()
        .unwrap_or_else(|| Due::now(now_ms));
    // Past this, Marfa Cloud approves the link no more, so there is nothing left to tell.
    let watching = unlink.link_credential.is_none();
    if watching && now_ms >= status::ceiling_ms(unlink.expires_at) {
        return match forget(app, &unlink.link_id).await {
            Ok(()) => None,
            Err(refusal) => {
                due = retried(due, now_ms, "forget", &refusal);
                plan.unlinks.insert(unlink.link_id.clone(), due);
                Some(due.at_ms)
            }
        };
    }
    if due.at_ms <= now_ms {
        due = match told(app, unlink, due).await {
            Ok(due) => due,
            Err(refusal) => retried(due, now_ms, "tell", &refusal),
        };
    }
    plan.unlinks.insert(unlink.link_id.clone(), due);
    Some(due.at_ms)
}

async fn told(app: &Arc<App>, unlink: &Unlink, due: Due) -> Result<Due> {
    let now_ms = app.clock.now_ms();
    let failed =
        |due: Due, now_ms: i64| due.failed_up_to(now_ms, TELL_FIRST_WAIT_MS, TELL_MOST_WAIT_MS);
    if unlink.link_credential.is_some() {
        let Some(credential) = open(unlink.link_credential.as_ref(), LINK_CREDENTIAL, app) else {
            tracing::warn!("A link credential kept to tell Marfa Cloud of an unlink does not open");
            return Ok(failed(due, now_ms));
        };
        let answer = send_unlink(app, &credential).await;
        let now_ms = app.clock.now_ms();
        return Ok(match answer {
            Some(answer) if answer.status == 200 => {
                forget(app, &unlink.link_id).await?;
                Due::now(now_ms)
            }
            // A newer approval replaced the credential, so poll for it at the interval.
            Some(answer) if unauthorized(&answer) && unlink.poll_secret.is_some() => {
                requeue(app, unlink, None).await?;
                Due::after(now_ms, unlink.interval_ms)
            }
            Some(answer) if unauthorized(&answer) => {
                forget(app, &unlink.link_id).await?;
                Due::now(now_ms)
            }
            Some(_) | None => failed(due, now_ms),
        });
    }
    let Some(secret) = open(unlink.poll_secret.as_ref(), POLL_SECRET, app) else {
        tracing::warn!("A poll secret kept to tell Marfa Cloud of an unlink does not open");
        return Ok(failed(due, now_ms));
    };
    if cancelled(app, &unlink.link_id, &secret).await {
        forget(app, &unlink.link_id).await?;
        return Ok(Due::now(app.clock.now_ms()));
    }
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

async fn send_unlink(app: &App, credential: &Secret) -> Option<Answer> {
    client::send(
        app,
        Method::Post(json!({})),
        "/link/unlink",
        Some(credential),
    )
    .await
    .ok()
}

/// Asks Marfa Cloud to cancel a link waiting for approval; says whether none waits now.
async fn cancelled(app: &App, link_id: &str, secret: &Secret) -> bool {
    let body = json!({ "link_id": link_id, "poll_secret": secret.expose() });
    client::send(app, Method::Post(body), "/link/cancel", None)
        .await
        .is_ok_and(|answer| matches!(answer.status, 200 | 404))
}

/// Tells Marfa Cloud of an unlink now; says whether it was told.
pub async fn tell(app: &Arc<App>, unlink: &Unlink) -> bool {
    let Some(credential) = open(unlink.link_credential.as_ref(), LINK_CREDENTIAL, app) else {
        return false;
    };
    let told = send_unlink(app, &credential).await.is_some_and(|answer| {
        answer.status == 200 || (unauthorized(&answer) && unlink.poll_secret.is_none())
    });
    told && forget(app, &unlink.link_id).await.is_ok()
}

/// Cancels a link that waits for approval now; says whether Marfa Cloud took it.
pub async fn cancel(app: &Arc<App>, unlink: &Unlink) -> bool {
    let Some(secret) = open(unlink.poll_secret.as_ref(), POLL_SECRET, app) else {
        return false;
    };
    cancelled(app, &unlink.link_id, &secret).await && forget(app, &unlink.link_id).await.is_ok()
}

async fn forget(app: &Arc<App>, link_id: &str) -> Result<()> {
    let link_id = link_id.to_string();
    let writing = app.clone();
    app.write(&Caller::Server, "cloud.unlink_told", move |unit| {
        changing(unit, &writing, |unit| store::forget(unit.tx(), &link_id))
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
        let mut due = Due::now(0);
        for _ in 0..20 {
            due = due.failed_up_to(0, TELL_FIRST_WAIT_MS, TELL_MOST_WAIT_MS);
        }
        assert_eq!(due.at_ms, TELL_MOST_WAIT_MS);
    }

    #[test]
    fn only_marfa_clouds_own_unauthorized_reads_as_an_unknown_credential() {
        let answer = |status: u16, body: Value| Answer {
            status,
            body,
            retry_after: None,
        };
        let code = |code: &str| json!({ "error": { "code": code, "message": "No." } });
        assert!(unauthorized(&answer(401, code("unauthorized"))));
        assert!(!unauthorized(&answer(401, code("proxy_auth_required"))));
        assert!(!unauthorized(&answer(401, json!("<html>Sign in</html>"))));
        assert!(!unauthorized(&answer(401, Value::Null)));
        assert!(!unauthorized(&answer(403, code("unauthorized"))));
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

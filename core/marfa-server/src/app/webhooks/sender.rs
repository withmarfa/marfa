//! Wakes on commits, clock changes and delivery deadlines.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::watch;
use tokio::task::{Id, JoinSet};

use super::schedule::{self, Context, Gap, Pass};
use super::{send, store};
use crate::app::App;
use crate::app::catalog;
use crate::app::faults::HOLD_WEBHOOK_SCHEDULE;
use crate::app::refusal::{Code, Result};
use crate::db::Write;
use crate::log;
use crate::settings::registry::ERROR_REPORTING_ENABLED;
use crate::telemetry::{Fault, Finished};

const AT_ONCE: usize = 4;
const METHOD: &str = "WEBHOOKS";
const PATH: &str = "schedule";
const CUT_BEFORE_END: Duration = Duration::from_secs(1);
/// Prevents a persistent internal fault from causing a busy loop.
const HELD_BACK: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub struct Webhooks {
    stopping: watch::Sender<bool>,
    cut: watch::Sender<bool>,
    running: watch::Sender<bool>,
}

impl Default for Webhooks {
    fn default() -> Webhooks {
        Webhooks {
            stopping: watch::Sender::new(false),
            cut: watch::Sender::new(false),
            running: watch::Sender::new(false),
        }
    }
}

impl Webhooks {
    pub fn stop(&self) {
        self.stopping.send_replace(true);
    }

    /// Cut attempts stay pending for the next start.
    pub async fn settle(&self, budget: Duration) {
        let mut running = self.running.subscribe();
        let patience = budget.saturating_sub(CUT_BEFORE_END);
        let idle = tokio::time::timeout(patience, running.wait_for(|running| !*running));
        if idle.await.is_err() {
            tracing::warn!("A webhook delivery outlived the stop's wait");
            self.cut.send_replace(true);
            let idle = running.wait_for(|running| !*running);
            let _ = tokio::time::timeout(CUT_BEFORE_END / 2, idle).await;
        }
    }
}

struct Running(watch::Sender<bool>);

impl Drop for Running {
    fn drop(&mut self) {
        self.0.send_replace(false);
    }
}

pub fn start(app: &Arc<App>) {
    app.webhooks.running.send_replace(true);
    let running = Running(app.webhooks.running.clone());
    let app = app.clone();
    tokio::spawn(async move {
        let _running = running;
        Sender::new(app).run().await;
    });
}

struct Sender {
    app: Arc<App>,
    stopping: watch::Receiver<bool>,
    commits: watch::Receiver<u64>,
    flying: JoinSet<Result<()>>,
    busy: HashMap<Id, i64>,
    held_back: HashMap<i64, Instant>,
    reported: Option<(Gap, Option<i64>)>,
}

impl Sender {
    fn new(app: Arc<App>) -> Sender {
        Sender {
            stopping: app.webhooks.stopping.subscribe(),
            commits: app.db.commits(),
            app,
            flying: JoinSet::new(),
            busy: HashMap::new(),
            held_back: HashMap::new(),
            reported: None,
        }
    }

    fn stopping(&self) -> bool {
        *self.stopping.borrow()
    }

    async fn run(mut self) {
        let mut moves = self.app.clock.moves();
        while !self.stopping() {
            self.commits.borrow_and_update();
            moves.borrow_and_update();
            tokio::select! {
                biased;
                () = stopped(&mut self.stopping) => break,
                () = self.app.faults.hold(HOLD_WEBHOOK_SCHEDULE, None) => {}
            }
            self.schedule().await;
            if self.stopping() {
                break;
            }
            let next = self.fill().await;
            let rest = self.rest(next);
            tokio::select! {
                () = stopped(&mut self.stopping) => break,
                Some(joined) = self.flying.join_next_with_id(), if !self.flying.is_empty() => {
                    self.landed(joined);
                }
                changed = self.commits.changed() => if changed.is_err() { break },
                changed = moves.changed() => if changed.is_err() { break },
                () = sleep(rest) => {}
            }
        }
        self.finish().await;
    }

    /// Queues what the log holds past the sender's place, a page a write.
    async fn schedule(&mut self) {
        while !self.stopping() {
            let faults = self.app.faults.clone();
            match self
                .app
                .db
                .read(move |tx| schedule::behind(tx, &faults))
                .await
            {
                Ok(true) => {}
                Ok(false) => {
                    self.reported = None;
                    return;
                }
                Err(refused) => {
                    tracing::warn!(error = %refused, "The webhook sender could not read its place");
                    return;
                }
            }
            // The pass sees every commit counted so far, and its own commit wakes nothing.
            let before = *self.commits.borrow_and_update();
            let app = self.app.clone();
            let passed = self
                .app
                .db
                .write(Write::own(), move |tx| {
                    let catalog =
                        catalog::current(&app.catalog_handle(), tx, catalog::Snapshot::Committed)?;
                    let pulse = app.db.pulse();
                    let at = app.clock.stamp();
                    schedule::pass(
                        tx,
                        &Context {
                            catalog: &catalog,
                            faults: &app.faults,
                            pulse: &pulse,
                            at: &at,
                            now_ms: app.clock.now_ms(),
                        },
                    )
                })
                .await;
            if *self.commits.borrow() == before.wrapping_add(1) {
                self.commits.borrow_and_update();
            }
            match passed {
                Ok(Pass::More) => {}
                Ok(Pass::Caught) => {
                    self.reported = None;
                    return;
                }
                Ok(Pass::Stuck { gap, at }) => {
                    if self.reported != Some((gap, at)) {
                        self.reported = Some((gap, at));
                        report(&self.app, gap);
                    }
                    return;
                }
                Err(refused) => {
                    tracing::warn!(error = %refused, "A webhook scheduling pass did not finish");
                    return;
                }
            }
        }
    }

    /// Starts what has fallen due, and answers when the next delivery not under way falls due.
    async fn fill(&mut self) -> Option<i64> {
        let now = Instant::now();
        self.held_back.retain(|_, until| *until > now);
        let free = AT_ONCE.saturating_sub(self.busy.len());
        let mut excluded: Vec<i64> = self
            .busy
            .values()
            .chain(self.held_back.keys())
            .copied()
            .collect();
        let now_ms = self.app.clock.now_ms();
        let read = self
            .app
            .db
            .read(move |tx| {
                let due = if free > 0 {
                    store::due(tx, now_ms, &excluded, free)?
                } else {
                    Vec::new()
                };
                excluded.extend(&due);
                Ok((due, store::next_due(tx, &excluded)?))
            })
            .await;
        let (due, next) = match read {
            Ok(read) => read,
            Err(refused) => {
                tracing::warn!(error = %refused, "The webhook sender could not read what is due");
                return None;
            }
        };
        for seq in due {
            let handle = self.flying.spawn(send::attempt(self.app.clone(), seq));
            self.busy.insert(handle.id(), seq);
        }
        next
    }

    fn landed(&mut self, joined: std::result::Result<(Id, Result<()>), tokio::task::JoinError>) {
        let (id, outcome) = match joined {
            Ok((id, outcome)) => (id, outcome.map_err(|refused| refused.to_string())),
            Err(error) => (error.id(), Err(error.to_string())),
        };
        let Some(seq) = self.busy.remove(&id) else {
            return;
        };
        if let Err(error) = outcome {
            tracing::warn!(%error, seq, "A webhook delivery's attempt did not finish");
            self.held_back.insert(seq, Instant::now() + HELD_BACK);
        }
    }

    /// A paused test clock wakes the sender directly instead of using a timer.
    fn rest(&self, next: Option<i64>) -> Option<Duration> {
        let held = self
            .held_back
            .values()
            .min()
            .map(|until| until.saturating_duration_since(Instant::now()));
        let due = next
            .filter(|_| self.busy.len() < AT_ONCE && !self.app.clock.is_paused())
            .map(|due| {
                let wait = due.saturating_sub(self.app.clock.now_ms()).max(0);
                Duration::from_millis(u64::try_from(wait).unwrap_or(u64::MAX))
            });
        match (held, due) {
            (Some(held), Some(due)) => Some(held.min(due)),
            (held, due) => held.or(due),
        }
    }

    /// Lets the attempts under way record what they met, unless the stop's wait runs out first.
    async fn finish(mut self) {
        let mut cut = self.app.webhooks.cut.subscribe();
        loop {
            tokio::select! {
                joined = self.flying.join_next_with_id() => match joined {
                    Some(joined) => self.landed(joined),
                    None => return,
                },
                () = stopped(&mut cut) => {
                    self.flying.abort_all();
                    while self.flying.join_next().await.is_some() {}
                    return;
                }
            }
        }
    }
}

async fn stopped(raised: &mut watch::Receiver<bool>) {
    let _ = raised.wait_for(|raised| *raised).await;
}

async fn sleep(rest: Option<Duration>) {
    match rest {
        Some(rest) => tokio::time::sleep(rest).await,
        None => std::future::pending().await,
    }
}

/// A gap is reported as an unhandled fault is: its log line, the error webhook and error tracking.
fn report(app: &App, gap: Gap) {
    let request_id = uuid::Uuid::now_v7().to_string();
    log::unhandled(&request_id, METHOD, PATH, None, gap.describe());
    let timestamp = app.clock.stamp();
    app.telemetry.finish(
        None,
        &Finished {
            request_id: &request_id,
            method: METHOD,
            path: PATH,
            route: None,
            transport: "internal",
            status: 500,
            error_code: Some(Code::InternalError.wire()),
            fault: Some(&Arc::new(Fault::internal(gap.describe()))),
            reporting: app.settings.live().get(ERROR_REPORTING_ENABLED),
            timestamp: &timestamp,
        },
    );
}

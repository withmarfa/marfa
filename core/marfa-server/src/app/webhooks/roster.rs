//! New attention entries sent from memory while the database fails, to the subscriptions the
//! last committed state let hear them. Nothing here is recorded, so nothing can be redelivered.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use arc_swap::ArcSwap;
use serde_json::{Map, Value};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use url::Url;

use super::send::{ATTEMPT_BOUND, signature};
use super::store;
use crate::app::App;
use crate::app::access::{Listener, attention_listeners};
use crate::app::attention::RAISED;
use crate::app::outbound::{self, Asker, Outcome, Outgoing, Reach};
use crate::settings::registry::ALLOW_PRIVATE_ADDRESSES;

/// Entries waiting to be sent; one past this is dropped.
const QUEUE: usize = 16;
/// The waits before each attempt after the first.
const WAITS: [Duration; 3] = [
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(40),
];

/// How long a send waits for the list to follow the last commit; a list that cannot be read
/// in that time is used as it last stood.
const CATCH_UP: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub struct Roster {
    listeners: ArcSwap<Vec<Listener>>,
    /// The commit count the list was read after.
    read_after: watch::Sender<u64>,
    queue: OnceLock<mpsc::Sender<Value>>,
}

impl Default for Roster {
    fn default() -> Roster {
        Roster {
            listeners: ArcSwap::default(),
            read_after: watch::Sender::new(0),
            queue: OnceLock::new(),
        }
    }
}

/// Follows the committed subscriptions, and sends what `tell` queues.
pub fn start(app: &Arc<App>) {
    let (queue, waiting) = mpsc::channel(QUEUE);
    if app.webhooks.roster.queue.set(queue).is_err() {
        return;
    }
    tokio::spawn(follow(app.clone()));
    tokio::spawn(send_queued(app.clone(), waiting));
}

/// Queues a new entry, its `attention` as an `attention.raised` event carries it.
pub fn tell(app: &App, attention: Value) {
    let Some(queue) = app.webhooks.roster.queue.get() else {
        return;
    };
    if queue.try_send(attention).is_err() {
        tracing::warn!("An attention entry was not sent from memory: too many were waiting");
    }
}

/// A list that cannot be read stays as it last stood, so a failing database does not empty it.
async fn follow(app: Arc<App>) {
    let mut commits = app.db.commits();
    let mut stopping = app.stopping();
    loop {
        let count = *commits.borrow_and_update();
        let at = app.clock.stamp();
        let read = app
            .db
            .read(move |tx| Ok(attention_listeners(tx, store::active(tx)?, &at)))
            .await;
        match read {
            Ok(listeners) => {
                app.webhooks.roster.listeners.store(Arc::new(listeners));
                app.webhooks.roster.read_after.send_replace(count);
            }
            Err(refused) => {
                tracing::warn!(error = %refused, "The webhooks for attention could not be read");
            }
        }
        tokio::select! {
            changed = commits.changed() => if changed.is_err() { return },
            () = stopped(&mut stopping) => return,
        }
    }
}

async fn stopped(stopping: &mut watch::Receiver<bool>) {
    let _ = stopping.wait_for(|stopping| *stopping).await;
}

async fn send_queued(app: Arc<App>, mut waiting: mpsc::Receiver<Value>) {
    let mut stopping = app.stopping();
    loop {
        let attention = tokio::select! {
            next = waiting.recv() => match next {
                Some(attention) => attention,
                None => return,
            },
            () = stopped(&mut stopping) => return,
        };
        let committed = *app.db.commits().borrow();
        let mut read_after = app.webhooks.roster.read_after.subscribe();
        let caught_up = read_after.wait_for(|count| *count >= committed);
        let _ = tokio::time::timeout(CATCH_UP, caught_up).await;
        let mut sending = JoinSet::new();
        for listener in app.webhooks.roster.listeners.load().iter() {
            sending.spawn(deliver(app.clone(), listener.clone(), attention.clone()));
        }
        let (mut delivered, mut undelivered) = (0u32, 0u32);
        while let Some(done) = sending.join_next().await {
            if matches!(done, Ok(true)) {
                delivered += 1;
            } else {
                undelivered += 1;
            }
        }
        let reference = attention["reference"].as_str().unwrap_or_default();
        tracing::info!(
            reference,
            delivered,
            undelivered,
            "An attention entry was sent from memory"
        );
    }
}

enum Tried {
    Delivered,
    Again,
    Given,
}

/// One delivery, under one id, over a few attempts.
async fn deliver(app: Arc<App>, listener: Listener, attention: Value) -> bool {
    let delivery_id = uuid::Uuid::now_v7().to_string();
    let mut stopping = app.stopping();
    for attempt in 0..=WAITS.len() {
        if let Some(wait) = attempt.checked_sub(1).and_then(|index| WAITS.get(index)) {
            tokio::select! {
                () = tokio::time::sleep(*wait) => {}
                () = stopped(&mut stopping) => return false,
            }
        }
        match once(&app, &listener, &attention, &delivery_id).await {
            Tried::Delivered => return true,
            Tried::Given => return false,
            Tried::Again => {}
        }
    }
    false
}

/// Whether the listener stands as it was when the attempt began: still in the list the last
/// committed state gave, with the same address and secret, and its key not past its expiry.
fn stands(app: &App, listener: &Listener) -> bool {
    let now_ms = app.clock.now_ms();
    listener.expires_at.is_none_or(|end| end.ms() > now_ms)
        && app
            .webhooks
            .roster
            .listeners
            .load()
            .iter()
            .any(|held| held == listener)
}

async fn once(app: &App, listener: &Listener, attention: &Value, delivery_id: &str) -> Tried {
    if !stands(app, listener) {
        return Tried::Given;
    }
    let Ok(url) = Url::parse(&listener.url) else {
        return Tried::Given;
    };
    let private_allowed = app.settings.live().get(ALLOW_PRIVATE_ADDRESSES);
    let maker = super::slot_key(&listener.maker);
    let targets = match outbound::reach(&app.faults, &url, private_allowed, Asker::Delivery(&maker))
        .await
    {
        Reach::Targets(targets) => targets,
        Reach::Unresolved | Reach::NoSlot => return Tried::Again,
        Reach::NotPublic => {
            tracing::warn!(
                "An attention entry was not sent from memory: the receiver's address is not public"
            );
            return Tried::Given;
        }
    };
    let mut body = Map::new();
    body.insert("event_type".into(), RAISED.into());
    body.insert("attention".into(), attention.clone());
    body.insert("delivery_id".into(), delivery_id.into());
    body.insert("delivered_at".into(), app.clock.stamp().into());
    let Ok(printed) = marfa_rules::number::to_vec(&Value::Object(body)) else {
        return Tried::Given;
    };
    let Ok(signed) = signature(
        &listener.secret,
        app.clock.now_ms().div_euclid(1_000),
        &printed,
    ) else {
        return Tried::Given;
    };
    let headers = [
        ("x-marfa-signature", signed),
        ("x-marfa-event-type", RAISED.to_string()),
    ];
    let outgoing = Outgoing {
        headers: &headers,
        body: String::from_utf8_lossy(&printed).into_owned(),
    };
    let check = || async move {
        if stands(app, listener) {
            Ok(())
        } else {
            Err(())
        }
    };
    match outbound::post(&url, &targets, outgoing, ATTEMPT_BOUND, check).await {
        Ok(Outcome::Answered { status, .. }) => match status {
            200..=299 => Tried::Delivered,
            408 | 429 | 500.. | 100..=199 => Tried::Again,
            _ => Tried::Given,
        },
        Ok(Outcome::Unreachable | Outcome::TimedOut) => Tried::Again,
        Err(()) => Tried::Given,
    }
}

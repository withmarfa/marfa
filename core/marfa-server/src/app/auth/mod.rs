pub mod claim;
pub mod limits;
pub mod names;
pub mod owner;
pub mod passkeys;
pub mod password;
pub mod return_to;
pub mod session;
pub mod sign_in;
pub mod sign_ins;

use std::net::IpAddr;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::Transaction;
use serde_json::Value;

use super::App;
use super::access::Caller;
use super::addresses::Address;
use super::audit::{self, Entry};
use super::refusal::{Code, Refusal, Result};
use crate::settings::Start;
use crate::settings::registry::{CORS_ORIGINS, SIGN_IN_ADDRESS};

#[derive(Clone, Debug, Default)]
pub struct Visit {
    pub address: Option<IpAddr>,
    pub user_agent: Option<String>,
}

impl Visit {
    pub(crate) fn client_ip(&self) -> Option<String> {
        self.address.map(|address| address.to_string())
    }
}

pub fn carries_sessions(address: &Address) -> bool {
    address.is_https() || matches!(address.host(), "localhost" | "127.0.0.1" | "[::1]")
}

/// Under test hooks a server is held to the loopback, so callers named behind it never left this machine.
fn takes_fixture_callers(start: &Start) -> bool {
    let held = |host: &str| host.parse().is_ok_and(|ip: IpAddr| ip.is_loopback());
    start.test_hooks && start.listen_host.as_deref().is_some_and(held)
}

/// Refuses a caller off this machine until the sign-in address is set. The fallback address
/// passes plain HTTP and says nothing of the interfaces the server is bound to. A connection
/// with no network address is on this machine.
pub fn require_set_address(app: &App, visit: &Visit) -> Result<()> {
    let here = visit
        .address
        .is_none_or(|address| address.to_canonical().is_loopback());
    if here
        || app.settings.live().get(SIGN_IN_ADDRESS).is_some()
        || takes_fixture_callers(&app.settings.start)
    {
        return Ok(());
    }
    Err(Refusal::new(
        Code::Forbidden,
        "Set this instance's sign-in address first: on its private socket, send PATCH /config \
         with sign_in_address, or run `marfa --socket <path> config update --body \
         '{\"sign_in_address\":\"https://<host>\"}'`.",
    ))
}

pub fn configured_origins(app: &App) -> Vec<String> {
    app.settings
        .live()
        .get(CORS_ORIGINS)
        .iter()
        .map(|address| address.origin().to_string())
        .collect()
}

pub fn own_origins(app: &App) -> Vec<String> {
    vec![app.addresses().sign_in().origin().to_string()]
}

pub fn form_origins(app: &App) -> Vec<String> {
    let mut origins = own_origins(app);
    origins.extend(configured_origins(app));
    origins
}

pub fn seconds_of(at: &str) -> Result<i64> {
    DateTime::parse_from_rfc3339(at)
        .map(|at| at.timestamp())
        .map_err(|_| Refusal::internal("an instant did not read"))
}

fn stamp_of(seconds: i64) -> String {
    DateTime::<Utc>::from_timestamp(seconds, 0)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

struct Note<'a> {
    action: &'a str,
    resource_type: &'a str,
    resource_id: &'a str,
    details: Option<Value>,
}

fn note(
    tx: &Transaction<'_>,
    at: &str,
    actor: Option<&Caller>,
    visit: &Visit,
    note: Note<'_>,
) -> Result<()> {
    audit::record_from(
        tx,
        at,
        actor,
        visit.client_ip().as_deref(),
        Entry {
            action: note.action,
            resource_type: note.resource_type,
            resource_id: Some(note.resource_id),
            details: note.details,
        },
    )
}

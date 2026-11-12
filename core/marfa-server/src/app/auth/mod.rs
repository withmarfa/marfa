pub mod claim;
pub mod device;
pub mod limits;
pub mod names;
pub mod owner;
pub mod passkeys;
pub mod password;
pub mod picture;
pub mod return_to;
pub mod session;
pub mod sign_in;
pub mod sign_ins;

use std::net::IpAddr;

use rusqlite::Transaction;
use serde_json::Value;

use super::App;
use super::access::Caller;
use super::addresses::Address;
use super::audit::{self, Entry};
use super::refusal::{Code, Refusal, Result};
use crate::settings::registry::{CORS_ORIGINS, SIGN_IN_ADDRESS};

#[derive(Clone, Debug, Default)]
pub struct Visit {
    /// The connection's own address; `None` on the private socket.
    pub peer: Option<IpAddr>,
    /// The caller's address as the listener believes it, which may come from a proxy's header.
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

/// A caller is local only by its own connection, and a forwarded address must be local too.
pub fn require_set_address(app: &App, visit: &Visit) -> Result<()> {
    let loopback = |address: Option<IpAddr>| {
        address.is_none_or(|address| address.to_canonical().is_loopback())
    };
    let here = loopback(visit.peer) && loopback(visit.address);
    if here || app.settings.live().get(SIGN_IN_ADDRESS).is_some() {
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

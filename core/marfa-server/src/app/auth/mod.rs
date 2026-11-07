//! Signing in: the owner, their password, the attempts it is held to, their
//! browser sessions and the claim that makes them the owner.

pub mod claim;
pub mod limits;
pub mod names;
pub mod owner;
pub mod password;
pub mod return_to;
pub mod session;
pub mod sign_in;

use std::net::IpAddr;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::Transaction;
use serde_json::Value;

use super::App;
use super::access::Caller;
use super::addresses::Address;
use super::audit::{self, Entry};
use super::refusal::{Refusal, Result};

/// Who is at the door, as far as a request can say.
#[derive(Clone, Debug, Default)]
pub struct Visit {
    pub address: Option<IpAddr>,
    pub user_agent: Option<String>,
}

impl Visit {
    fn client_ip(&self) -> Option<String> {
        self.address.map(|address| address.to_string())
    }
}

/// Whether a browser may hold an owner's session at this address: over HTTPS,
/// or on this machine.
pub fn carries_sessions(address: &Address) -> bool {
    address.is_https() || matches!(address.host(), "localhost" | "127.0.0.1" | "[::1]")
}

/// The origins a browser form may come from: the sign-in address's, and those
/// `CORS_ORIGINS` names, which no setting registers yet.
pub fn form_origins(app: &App) -> Vec<String> {
    vec![app.addresses().sign_in().origin().to_string()]
}

/// The whole second an instant falls in, which is how the sign-in tables hold
/// time.
fn seconds_of(at: &str) -> Result<i64> {
    DateTime::parse_from_rfc3339(at)
        .map(|at| at.timestamp())
        .map_err(|_| Refusal::internal("an instant did not read"))
}

fn stamp_of(seconds: i64) -> String {
    DateTime::<Utc>::from_timestamp(seconds, 0)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// One audit entry for what a visitor did, signed in or not.
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
            resource_id: note.resource_id,
            details: note.details,
        },
    )
}

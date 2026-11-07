//! The door every write a caller asks for goes through.

use rusqlite::Transaction;
use serde_json::Value;

use super::App;
use super::access::Caller;
use super::audit::{self, Entry};
use super::events::{self, Event};
use super::refusal::Result;
use crate::db::Write;

/// One write as it runs: its transaction, its caller as that transaction
/// holds it, and its instant. What a write records goes in here, so it
/// commits or rolls back with the write.
pub struct Unit<'t, 'c> {
    tx: &'t Transaction<'c>,
    action: &'static str,
    pub caller: Caller,
    pub at: String,
}

impl<'c> Unit<'_, 'c> {
    pub fn tx(&self) -> &Transaction<'c> {
        self.tx
    }

    /// Adds what this write announces to the event log.
    pub fn announce(&self, event: &Event<'_>) -> Result<()> {
        events::append(self.tx, &self.at, event)
    }

    /// Leaves the entry for the action this write is.
    pub fn audit(
        &self,
        resource_type: &str,
        resource_id: &str,
        details: Option<Value>,
    ) -> Result<()> {
        self.audit_also(self.action, resource_type, resource_id, details)
    }

    /// Leaves an entry for something else the write did.
    pub fn audit_also(
        &self,
        action: &str,
        resource_type: &str,
        resource_id: &str,
        details: Option<Value>,
    ) -> Result<()> {
        audit::record(
            self.tx,
            &self.at,
            &self.caller,
            Entry {
                action,
                resource_type,
                resource_id: Some(resource_id),
                details,
            },
        )
    }

    /// Leaves the entry for a write that names many rows and no one of them.
    pub fn audit_set(&self, resource_type: &str, details: Option<Value>) -> Result<()> {
        audit::record(
            self.tx,
            &self.at,
            &self.caller,
            Entry {
                action: self.action,
                resource_type,
                resource_id: None,
                details,
            },
        )
    }
}

impl App {
    /// Runs `job` as one write for `caller`. The caller is read again inside
    /// the transaction, so a key revoked or expired while the write waited
    /// is refused, and every check `job` makes sees what the write commits.
    pub async fn write<T, F>(&self, caller: &Caller, action: &'static str, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Unit<'_, '_>) -> Result<T> + Send + 'static,
    {
        let caller = caller.clone();
        let clock = self.clock.clone();
        self.db
            .write(Write::caller(action), move |tx| {
                let at = clock.stamp();
                let caller = caller.current(tx, &at)?;
                job(&Unit {
                    tx,
                    action,
                    caller,
                    at,
                })
            })
            .await
    }
}

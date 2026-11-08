use std::sync::Arc;

use arc_swap::ArcSwap;
use rusqlite::Transaction;
use serde_json::Value;

use super::App;
use super::access::Caller;
use super::audit::{self, Entry};
use super::catalog::Snapshot;
use super::connectors::{ReadOnly, Registry, read_only};
use super::events::{self, Event};
use super::refusal::Result;
use crate::db::Write;

/// What a write records goes in here, so it commits or rolls back with the write.
pub struct Unit<'t, 'c> {
    tx: &'t Transaction<'c>,
    action: &'static str,
    pub caller: Caller,
    pub at: String,
    read_only: Arc<ArcSwap<Registry>>,
}

impl<'c> Unit<'_, 'c> {
    pub fn tx(&self) -> &Transaction<'c> {
        self.tx
    }

    /// Which items connectors hold read only, as this write leaves them.
    pub fn read_only(&self) -> Result<ReadOnly> {
        read_only::current(&self.read_only, self.tx, &self.at, Snapshot::Pending)
    }

    pub fn under(&self, action: &'static str) -> Unit<'_, 'c> {
        Unit {
            tx: self.tx,
            action,
            caller: self.caller.clone(),
            at: self.at.clone(),
            read_only: self.read_only.clone(),
        }
    }

    pub fn announce(&self, event: &Event<'_>) -> Result<()> {
        events::append(self.tx, &self.at, event)
    }

    pub fn audit(
        &self,
        resource_type: &str,
        resource_id: &str,
        details: Option<Value>,
    ) -> Result<()> {
        self.audit_also(self.action, resource_type, resource_id, details)
    }

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
    /// The caller is read again inside the transaction, so a key revoked or expired while the
    /// write waited is refused, and every check `job` makes sees what the write commits.
    pub async fn write<T, F>(&self, caller: &Caller, action: &'static str, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Unit<'_, '_>) -> Result<T> + Send + 'static,
    {
        let caller = caller.clone();
        let clock = self.clock.clone();
        let read_only = self.read_only_handle();
        let write = if matches!(caller, Caller::Server) {
            Write::server(action)
        } else {
            Write::caller(action)
        };
        self.db
            .write(write, move |tx| {
                let at = clock.stamp();
                let caller = caller.current(tx, &at)?;
                job(&Unit {
                    tx,
                    action,
                    caller,
                    at,
                    read_only,
                })
            })
            .await
    }
}

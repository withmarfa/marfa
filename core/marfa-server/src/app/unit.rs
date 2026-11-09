use std::sync::Arc;

use arc_swap::ArcSwap;
use rusqlite::Transaction;
use serde_json::Value;

use super::App;
use super::access::Caller;
use super::audit::{self, Entry};
use super::catalog::Snapshot;
use super::clock::Stamp;
use super::connectors::{ReadOnly, Registry, read_only};
use super::events::{self, Event};
use super::provenance::{self, Origin};
use super::refusal::Result;
use crate::db::Write;

/// What a write records goes in here, so it commits or rolls back with the write.
pub struct Unit<'t, 'c> {
    tx: &'t Transaction<'c>,
    action: &'static str,
    pub caller: Caller,
    pub at: String,
    fanout: bool,
    /// The same instant as `at`.
    pub instant: Stamp,
    origin: Origin,
    read_only: Arc<ArcSwap<Registry>>,
    /// A job's chunk records one entry for its rows, as an atomic page does.
    summarised: bool,
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
            fanout: self.fanout,
            instant: self.instant,
            origin: self.origin.clone(),
            read_only: self.read_only.clone(),
            summarised: self.summarised,
        }
    }

    /// Summarized writes leave per-item auditing to the chunk's audit entry.
    pub fn for_holder(&self, caller: Caller, summarised: bool) -> Unit<'_, 'c> {
        Unit {
            caller,
            summarised,
            ..self.under(self.action)
        }
    }

    /// An inner write cannot re-enable fan-out disabled by its caller.
    pub fn fanning<T>(&self, fanout: bool, job: impl FnOnce(&Unit<'_, 'c>) -> T) -> T {
        if fanout || !self.fanout {
            return job(self);
        }
        job(&Unit {
            fanout: false,
            ..self.under(self.action)
        })
    }

    pub fn announce(&self, event: &Event<'_>) -> Result<()> {
        events::append(self.tx, &self.at, self.fanout, event)
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
        if self.summarised {
            return Ok(());
        }
        self.audit_summary(action, resource_type, resource_id, details)
    }

    pub fn audit_summary(
        &self,
        action: &str,
        resource_type: &str,
        resource_id: &str,
        details: Option<Value>,
    ) -> Result<()> {
        audit::record_from(
            self.tx,
            &self.at,
            Some(&self.caller),
            self.origin.client_ip.as_deref(),
            Entry {
                action,
                resource_type,
                resource_id: Some(resource_id),
                details: self.origin.mark(details),
            },
        )
    }

    pub fn audit_set(&self, resource_type: &str, details: Option<Value>) -> Result<()> {
        if self.summarised {
            return Ok(());
        }
        audit::record_from(
            self.tx,
            &self.at,
            Some(&self.caller),
            self.origin.client_ip.as_deref(),
            Entry {
                action: self.action,
                resource_type,
                resource_id: None,
                details: self.origin.mark(details),
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
        let origin = provenance::current();
        let read_only = self.read_only_handle();
        let write = if matches!(caller, Caller::Server) {
            Write::server(action)
        } else {
            Write::caller(action)
        };
        self.db
            .write(write, move |tx| {
                let instant = clock.instant();
                let at = instant.text();
                let caller = caller.current(tx, &at)?;
                job(&Unit {
                    tx,
                    action,
                    caller,
                    at,
                    fanout: true,
                    instant,
                    origin,
                    read_only,
                    summarised: false,
                })
            })
            .await
    }

    /// Records an attempt made with `caller`'s credential, whatever its authority is now. Writes only the audit entry.
    pub async fn audit_attempt(
        &self,
        caller: &Caller,
        action: &'static str,
        resource_type: &'static str,
        details: Value,
    ) -> Result<()> {
        let caller = caller.clone();
        let clock = self.clock.clone();
        let origin = provenance::current();
        self.db
            .write(Write::caller(action), move |tx| {
                let at = clock.stamp();
                audit::record_from(
                    tx,
                    &at,
                    Some(&caller),
                    origin.client_ip.as_deref(),
                    Entry {
                        action,
                        resource_type,
                        resource_id: None,
                        details: origin.mark(Some(details)),
                    },
                )
            })
            .await
    }
}

use std::sync::Arc;

use arc_swap::ArcSwap;
use chrono::SecondsFormat;
use rusqlite::Transaction;
use serde_json::Value;

use super::App;
use super::access::Caller;
use super::audit::{self, Entry};
use super::catalog::Snapshot;
use super::connectors::{ReadOnly, Registry, read_only};
use super::events::{self, Event};
use super::provenance::{self, Origin};
use super::refusal::Result;
use super::stored;
use crate::db::Write;
use crate::settings::Snapshot as Settled;
use crate::settings::registry::{Kind, Seeds, Setting};

/// What a write records goes in here, so it commits or rolls back with the write.
pub struct Unit<'t, 'c> {
    tx: &'t Transaction<'c>,
    action: &'static str,
    pub caller: Caller,
    pub at: String,
    fanout: bool,
    /// The same instant as `at`, in milliseconds.
    pub at_ms: i64,
    origin: Origin,
    read_only: Arc<ArcSwap<Registry>>,
    seeds: Arc<Seeds>,
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
            at_ms: self.at_ms,
            origin: self.origin.clone(),
            read_only: self.read_only.clone(),
            seeds: self.seeds.clone(),
        }
    }

    /// Read from this transaction's rows, so a change committed while the write waited is seen.
    pub fn setting<T: Kind>(&self, setting: Setting<T>) -> Result<T> {
        Ok(Settled::resolve(&self.seeds, &stored::rows(self.tx)?, 0).get(setting))
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
        let seeds = self.settings.seeds();
        let write = if matches!(caller, Caller::Server) {
            Write::server(action)
        } else {
            Write::caller(action)
        };
        self.db
            .write(write, move |tx| {
                let now = clock.now();
                let at = now.to_rfc3339_opts(SecondsFormat::Millis, true);
                let at_ms = now.timestamp_millis();
                let caller = caller.current(tx, &at)?;
                job(&Unit {
                    tx,
                    action,
                    caller,
                    at,
                    fanout: true,
                    at_ms,
                    origin,
                    read_only,
                    seeds,
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

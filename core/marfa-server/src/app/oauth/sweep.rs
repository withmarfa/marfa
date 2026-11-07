//! What ages out of the sign-in tables. Each function is one pass, safe to
//! run at any time and as often as a caller likes, and works in batches so no
//! write holds the others up for long.

use rusqlite::params;
use serde_json::json;

use super::grant;
use super::store::stamp_of;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::audit::{self, Entry};
use crate::app::refusal::Result;
use crate::app::unit::Unit;
use crate::db::Write;
use crate::settings::registry::{
    DCR_CLIENT_RETENTION_DAYS, GRANT_INACTIVITY_DAYS, REVOKED_GRANT_RETENTION_DAYS,
};

const BATCH: i64 = 200;
const MS_PER_DAY: i64 = 86_400_000;
const CLIENTS_PURGED: &str = "auth.clients.purged";
const GRANTS_PURGED: &str = "auth.grants.purged";
const GRANT_RETIRED: &str = "auth.grant.retired";

fn cutoff_of(app: &App, days: u64) -> Option<i64> {
    (days > 0).then(|| app.clock.now_ms() - i64::try_from(days).unwrap_or(0) * MS_PER_DAY)
}

fn last_batch(count: usize) -> bool {
    i64::try_from(count).unwrap_or(0) < BATCH
}

fn consents_in(unit: &Unit<'_, '_>, query: &str, cutoff: i64) -> Result<Vec<(String, String)>> {
    let mut found = unit.tx().prepare(query)?;
    Ok(found
        .query_map(params![cutoff, BATCH], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

fn note_set(
    tx: &rusqlite::Transaction<'_>,
    at: &str,
    action: &'static str,
    resource_type: &'static str,
    count: usize,
    cutoff: i64,
) -> Result<()> {
    audit::record_from(
        tx,
        at,
        None,
        None,
        Entry {
            action,
            resource_type,
            resource_id: None,
            details: Some(json!({ "count": count, "cutoff": stamp_of(cutoff) })),
        },
    )
}

/// `dcr-client-cleanup`: removes clients nobody approved, which nothing has
/// shown or used since the cutoff. Anything a client holds spares it.
pub async fn remove_idle_clients(app: &App) -> Result<usize> {
    let Some(cutoff) = cutoff_of(app, app.settings.live().get(DCR_CLIENT_RETENTION_DAYS)) else {
        return Ok(0);
    };
    let mut removed = 0;
    loop {
        let at = app.clock.stamp();
        let batch = app
            .db
            .write(Write::caller(CLIENTS_PURGED), move |tx| {
                let count = tx.execute(
                    "DELETE FROM auth_oauth_client WHERE client_id IN ( \
                     SELECT client_id FROM auth_oauth_client AS c \
                     WHERE created_at < ?1 AND COALESCE(offered_at, 0) < ?1 \
                     AND NOT EXISTS (SELECT 1 FROM auth_oauth_consent AS x \
                                     WHERE x.client_id = c.client_id) \
                     AND NOT EXISTS (SELECT 1 FROM auth_oauth_access_token AS x \
                                     WHERE x.client_id = c.client_id) \
                     AND NOT EXISTS (SELECT 1 FROM auth_oauth_refresh_token AS x \
                                     WHERE x.client_id = c.client_id) \
                     LIMIT ?2)",
                    params![cutoff, BATCH],
                )?;
                if count > 0 {
                    note_set(tx, &at, CLIENTS_PURGED, "oauth_client", count, cutoff)?;
                }
                Ok(count)
            })
            .await?;
        removed += batch;
        if last_batch(batch) {
            return Ok(removed);
        }
    }
}

/// Ends the grants no app has used since the cutoff, as a person's Disconnect
/// would.
pub async fn retire_idle_grants(app: &App) -> Result<usize> {
    let Some(cutoff) = cutoff_of(app, app.settings.live().get(GRANT_INACTIVITY_DAYS)) else {
        return Ok(0);
    };
    let mut retired = 0;
    loop {
        let cache = app.catalog_handle();
        let batch = app
            .write(&Caller::Local, GRANT_RETIRED, move |unit| {
                let idle = consents_in(
                    unit,
                    "SELECT client_id, user_id FROM auth_oauth_consent \
                     WHERE withdrawn_at IS NULL \
                     AND COALESCE(last_used_at, updated_at) < ?1 LIMIT ?2",
                    cutoff,
                )?;
                for (client_id, user_id) in &idle {
                    grant::end(unit, &cache, client_id, user_id)?;
                    audit::record_from(
                        unit.tx(),
                        &unit.at,
                        None,
                        None,
                        Entry {
                            action: GRANT_RETIRED,
                            resource_type: "oauth_grant",
                            resource_id: Some(client_id),
                            details: Some(json!({
                                "client_id": client_id,
                                "user_id": user_id,
                                "cutoff": stamp_of(cutoff),
                            })),
                        },
                    )?;
                }
                Ok(idle.len())
            })
            .await?;
        retired += batch;
        if last_batch(batch) {
            return Ok(retired);
        }
    }
}

/// Removes the grants withdrawn before the cutoff, so a client they alone
/// kept can go.
pub async fn purge_withdrawn_grants(app: &App) -> Result<usize> {
    let Some(cutoff) = cutoff_of(app, app.settings.live().get(REVOKED_GRANT_RETENTION_DAYS)) else {
        return Ok(0);
    };
    let mut purged = 0;
    loop {
        let cache = app.catalog_handle();
        let batch = app
            .write(&Caller::Local, GRANTS_PURGED, move |unit| {
                let withdrawn = consents_in(
                    unit,
                    "SELECT client_id, user_id FROM auth_oauth_consent \
                     WHERE withdrawn_at IS NOT NULL AND withdrawn_at < ?1 LIMIT ?2",
                    cutoff,
                )?;
                for (client_id, user_id) in &withdrawn {
                    grant::forget(unit, &cache, client_id, user_id)?;
                }
                if !withdrawn.is_empty() {
                    note_set(
                        unit.tx(),
                        &unit.at,
                        GRANTS_PURGED,
                        "oauth_grant",
                        withdrawn.len(),
                        cutoff,
                    )?;
                }
                Ok(withdrawn.len())
            })
            .await?;
        purged += batch;
        if last_batch(batch) {
            return Ok(purged);
        }
    }
}

/// Removes codes and tokens past their end. A rotated refresh token stays
/// until then, since a replay of it must still be recognized.
pub async fn sweep_expired(app: &App) -> Result<usize> {
    let now = app.clock.now_ms();
    let mut removed = 0;
    for (table, key) in [
        ("auth_oauth_code", "digest"),
        ("auth_oauth_device_code", "device_code"),
        ("auth_oauth_access_token", "id"),
        ("auth_oauth_refresh_token", "id"),
    ] {
        loop {
            let batch = app
                .db
                .write(Write::own(), move |tx| {
                    Ok(tx.execute(
                        &format!(
                            "DELETE FROM {table} WHERE {key} IN ( \
                             SELECT {key} FROM {table} WHERE expires_at <= ?1 LIMIT ?2)"
                        ),
                        params![now, BATCH],
                    )?)
                })
                .await?;
            removed += batch;
            if last_batch(batch) {
                break;
            }
        }
    }
    Ok(removed)
}

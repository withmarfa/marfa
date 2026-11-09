//! Bodies of the housekeeping jobs that remove aged-out sign-in rows. Each write is bounded and
//! each run stops between two of them when told to.

use std::sync::Arc;

use rusqlite::{Transaction, params};
use serde_json::json;

use super::grant;
use super::store::stamp_of;
use crate::app::access::Caller;
use crate::app::auth::session;
use crate::app::housekeeping::{Report, Run, drain};
use crate::app::refusal::Result;
use crate::app::{App, stored};
use crate::db::Write;
use crate::settings::registry::{
    DCR_CLIENT_RETENTION_DAYS, GRANT_INACTIVITY_DAYS, REVOKED_GRANT_RETENTION_DAYS, Setting,
};

const BATCH: i64 = 200;
pub(super) const MS_PER_DAY: i64 = 86_400_000;
const CLIENTS_PURGED: &str = "auth.clients.purged";
const GRANTS_PURGED: &str = "auth.grants.purged";
const GRANT_RETIRED: &str = "auth.grant.retired";
const IDLE_GRANTS: &str = "SELECT client_id, user_id FROM auth_oauth_consent \
                           WHERE withdrawn_at IS NULL \
                           AND COALESCE(last_used_at, updated_at) < ?1 LIMIT ?2";
const WITHDRAWN_GRANTS: &str = "SELECT client_id, user_id FROM auth_oauth_consent \
                                WHERE withdrawn_at IS NOT NULL AND withdrawn_at < ?1 LIMIT ?2";

/// Read from `tx`, since the live settings lag a change the writer has committed.
fn cutoff_of(tx: &Transaction<'_>, app: &App, retention: Setting<u64>) -> Result<Option<i64>> {
    let days = stored::setting(tx, &app.settings.seeds(), retention)?;
    Ok((days > 0).then(|| app.clock.now_ms() - i64::try_from(days).unwrap_or(0) * MS_PER_DAY))
}

fn consents_in(
    tx: &Transaction<'_>,
    query: &str,
    cutoff: i64,
    limit: i64,
) -> Result<Vec<(String, String)>> {
    let mut found = tx.prepare(query)?;
    Ok(found
        .query_map(params![cutoff, limit], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

/// So a run with nothing to do takes no write.
async fn any_consent(app: &Arc<App>, query: &'static str, retention: Setting<u64>) -> Result<bool> {
    let live = app.clone();
    app.db
        .read(move |tx| match cutoff_of(tx, &live, retention)? {
            Some(cutoff) => Ok(!consents_in(tx, query, cutoff, 1)?.is_empty()),
            None => Ok(false),
        })
        .await
}

async fn idle_clients(app: &Arc<App>) -> Result<i64> {
    let live = app.clone();
    app.write(&Caller::Server, CLIENTS_PURGED, move |unit| {
        let Some(cutoff) = cutoff_of(unit.tx(), &live, DCR_CLIENT_RETENTION_DAYS)? else {
            return Ok(0);
        };
        let count = unit.tx().execute(
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
            unit.audit_set(
                "oauth_client",
                Some(json!({ "count": count, "cutoff": stamp_of(cutoff) })),
            )?;
        }
        Ok(i64::try_from(count).unwrap_or(i64::MAX))
    })
    .await
}

/// Anything a client holds spares it.
pub async fn remove_idle_clients(app: Arc<App>, run: Run) -> Result<Report> {
    let (deleted, done) = drain(&run, BATCH, || idle_clients(&app)).await?;
    Ok(Report {
        result: json!({ "deleted": deleted }),
        again: !done,
    })
}

async fn retire_one(app: &Arc<App>) -> Result<i64> {
    if !any_consent(app, IDLE_GRANTS, GRANT_INACTIVITY_DAYS).await? {
        return Ok(0);
    }
    let (live, cache) = (app.clone(), app.catalog_handle());
    app.write(&Caller::Server, GRANT_RETIRED, move |unit| {
        let Some(cutoff) = cutoff_of(unit.tx(), &live, GRANT_INACTIVITY_DAYS)? else {
            return Ok(0);
        };
        let idle = consents_in(unit.tx(), IDLE_GRANTS, cutoff, 1)?;
        for (client_id, user_id) in &idle {
            grant::end(unit, &cache, client_id, user_id)?;
            unit.audit(
                "oauth_grant",
                client_id,
                Some(json!({
                    "client_id": client_id,
                    "user_id": user_id,
                    "cutoff": stamp_of(cutoff),
                })),
            )?;
        }
        Ok(i64::try_from(idle.len()).unwrap_or(i64::MAX))
    })
    .await
}

/// Each is a write of its own, since one ends every credential of the grant and rewrites its item.
pub async fn retire_idle_grants(app: Arc<App>, run: Run) -> Result<Report> {
    let (retired, done) = drain(&run, 1, || retire_one(&app)).await?;
    Ok(Report {
        result: json!({ "retired": retired }),
        again: !done,
    })
}

async fn withdrawn_grants(app: &Arc<App>) -> Result<i64> {
    if !any_consent(app, WITHDRAWN_GRANTS, REVOKED_GRANT_RETENTION_DAYS).await? {
        return Ok(0);
    }
    let (live, cache) = (app.clone(), app.catalog_handle());
    app.write(&Caller::Server, GRANTS_PURGED, move |unit| {
        let Some(cutoff) = cutoff_of(unit.tx(), &live, REVOKED_GRANT_RETENTION_DAYS)? else {
            return Ok(0);
        };
        let withdrawn = consents_in(unit.tx(), WITHDRAWN_GRANTS, cutoff, BATCH)?;
        for (client_id, user_id) in &withdrawn {
            grant::forget(unit, &cache, client_id, user_id)?;
        }
        if !withdrawn.is_empty() {
            unit.audit_set(
                "oauth_grant",
                Some(json!({ "count": withdrawn.len(), "cutoff": stamp_of(cutoff) })),
            )?;
        }
        Ok(i64::try_from(withdrawn.len()).unwrap_or(i64::MAX))
    })
    .await
}

/// So a client they alone kept can go.
pub async fn purge_withdrawn_grants(app: Arc<App>, run: Run) -> Result<Report> {
    let (deleted, done) = drain(&run, BATCH, || withdrawn_grants(&app)).await?;
    Ok(Report {
        result: json!({ "deleted": deleted }),
        again: !done,
    })
}

async fn expired_in(
    app: &Arc<App>,
    table: &'static str,
    key: &'static str,
    kept_ms: i64,
) -> Result<i64> {
    let cutoff = app.clock.now_ms() - kept_ms;
    app.db
        .write(Write::own(), move |tx| {
            let count = tx.execute(
                &format!(
                    "DELETE FROM {table} WHERE {key} IN ( \
                     SELECT {key} FROM {table} WHERE expires_at <= ?1 LIMIT ?2)"
                ),
                params![cutoff, BATCH],
            )?;
            Ok(i64::try_from(count).unwrap_or(i64::MAX))
        })
        .await
}

async fn expired_sessions(app: &Arc<App>) -> Result<i64> {
    let now_ms = app.clock.now_ms();
    app.db
        .write(Write::own(), move |tx| {
            session::remove_expired(tx, now_ms, BATCH)
        })
        .await
}

/// A rotated refresh token stays until then, since a replay of it must still be recognized. A
/// device code stays a day longer, so a device polling after it expired is told so; its poll
/// removes it sooner.
pub async fn sweep_expired(app: Arc<App>, run: Run) -> Result<Report> {
    let (mut deleted, mut done) = drain(&run, BATCH, || expired_sessions(&app)).await?;
    for (table, key, kept_ms) in [
        ("auth_oauth_code", "digest", 0),
        ("auth_oauth_device_code", "device_code", MS_PER_DAY),
        ("auth_oauth_access_token", "id", 0),
        ("auth_oauth_refresh_token", "id", 0),
        ("setup_proof", "digest", 0),
    ] {
        if !done {
            break;
        }
        let (taken, finished) =
            drain(&run, BATCH, || expired_in(&app, table, key, kept_ms)).await?;
        deleted += taken;
        done = finished;
    }
    Ok(Report {
        result: json!({ "deleted": deleted }),
        again: !done,
    })
}

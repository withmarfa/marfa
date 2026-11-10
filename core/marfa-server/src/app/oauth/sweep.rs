//! The stages of the credential clean-up that deal with sign-in rows. Each write is bounded and
//! each stage stops between two of them when told to.

use std::sync::Arc;

use rusqlite::{Transaction, params};
use serde_json::json;

use super::grant;
use crate::app::access::Caller;
use crate::app::auth::{passkeys, session};
use crate::app::clock::{Stamp, Unread, readable};
use crate::app::housekeeping::{Run, drain};
use crate::app::mcp::confirm;
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

fn idle_consents() -> String {
    let last = "COALESCE(last_used_at, updated_at)";
    format!(
        "SELECT client_id, user_id FROM auth_oauth_consent WHERE withdrawn_at IS NULL \
         AND {} AND {last} < ?1 LIMIT ?2",
        readable(last)
    )
}

fn withdrawn_consents() -> String {
    format!(
        "SELECT client_id, user_id FROM auth_oauth_consent \
         WHERE {} AND withdrawn_at < ?1 LIMIT ?2",
        readable("withdrawn_at")
    )
}

const IDLE_UNREAD: [Unread<'static>; 1] = [Unread {
    table: "auth_oauth_consent",
    time: "COALESCE(last_used_at, updated_at)",
    scope: "withdrawn_at IS NULL",
}];
const WITHDRAWN_UNREAD: [Unread<'static>; 1] = [Unread {
    table: "auth_oauth_consent",
    time: "withdrawn_at",
    scope: "1",
}];
const CLIENT_UNREAD: [Unread<'static>; 2] = [
    Unread {
        table: "auth_oauth_client",
        time: "created_at",
        scope: "1",
    },
    Unread {
        table: "auth_oauth_client",
        time: "offered_at",
        scope: "1",
    },
];
/// Swept only in passing by the writes that make them, so this stage reports them.
const SWEPT_IN_PASSING: [Unread<'static>; 2] = [passkeys::UNREAD_CHALLENGES, confirm::UNREAD];

/// Once a stage is done, what it kept past the cutoff is only what it could not judge.
async fn report_kept(
    app: &Arc<App>,
    run: &Run,
    cutoff: Cutoff,
    unread: impl IntoIterator<Item = Unread<'static>> + Send + 'static,
) -> Result<()> {
    let (live, job) = (app.clone(), run.job);
    let kept = app
        .db
        .read(move |tx| {
            let before = match cutoff {
                Cutoff::At(at) => Some(at),
                Cutoff::Kept(retention) => cutoff_of(tx, &live, retention)?,
            };
            match before {
                Some(_) => unread
                    .into_iter()
                    .map(|unread| unread.report(tx, job, []))
                    .sum(),
                None => Ok(0),
            }
        })
        .await?;
    run.kept_unread(kept);
    Ok(())
}

enum Cutoff {
    At(Stamp),
    Kept(Setting<u64>),
}

/// Read from `tx`, since the live settings lag a change the writer has committed.
fn cutoff_of(tx: &Transaction<'_>, app: &App, retention: Setting<u64>) -> Result<Option<Stamp>> {
    let days = stored::deciding(tx, &app.settings.seeds(), retention)?;
    if days == 0 {
        return Ok(None);
    }
    let kept = i64::try_from(days)
        .unwrap_or(i64::MAX)
        .saturating_mul(MS_PER_DAY);
    Ok(app.clock.instant().earlier_by(kept))
}

fn consents_in(
    tx: &Transaction<'_>,
    query: &str,
    cutoff: Stamp,
    limit: i64,
) -> Result<Vec<(String, String)>> {
    let mut found = tx.prepare(query)?;
    Ok(found
        .query_map(params![cutoff, limit], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

/// So a run with nothing to do takes no write.
async fn any_consent(
    app: &Arc<App>,
    query: fn() -> String,
    retention: Setting<u64>,
) -> Result<bool> {
    let live = app.clone();
    app.db
        .read(move |tx| match cutoff_of(tx, &live, retention)? {
            Some(cutoff) => Ok(!consents_in(tx, &query(), cutoff, 1)?.is_empty()),
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
        let offered = "COALESCE(offered_at, created_at)";
        let count = unit.tx().execute(
            &format!(
                "DELETE FROM auth_oauth_client WHERE client_id IN ( \
             SELECT client_id FROM auth_oauth_client AS c \
             WHERE {} AND created_at < ?1 AND {} AND {offered} < ?1 \
             AND NOT EXISTS (SELECT 1 FROM auth_oauth_consent AS x \
                             WHERE x.client_id = c.client_id) \
             AND NOT EXISTS (SELECT 1 FROM auth_oauth_access_token AS x \
                             WHERE x.client_id = c.client_id) \
             AND NOT EXISTS (SELECT 1 FROM auth_oauth_refresh_token AS x \
                             WHERE x.client_id = c.client_id) \
             LIMIT ?2)",
                readable("created_at"),
                readable(offered)
            ),
            params![cutoff, BATCH],
        )?;
        if count > 0 {
            unit.audit_set(
                "oauth_client",
                Some(json!({ "count": count, "cutoff": cutoff })),
            )?;
        }
        Ok(i64::try_from(count).unwrap_or(i64::MAX))
    })
    .await
}

/// Anything a client holds spares it.
pub async fn remove_idle_clients(app: &Arc<App>, run: &Run) -> Result<(i64, bool)> {
    let (taken, done) = drain(run, BATCH, || idle_clients(app)).await?;
    if done {
        let cutoff = Cutoff::Kept(DCR_CLIENT_RETENTION_DAYS);
        report_kept(app, run, cutoff, CLIENT_UNREAD).await?;
    }
    Ok((taken, done))
}

async fn retire_one(app: &Arc<App>) -> Result<i64> {
    if !any_consent(app, idle_consents, GRANT_INACTIVITY_DAYS).await? {
        return Ok(0);
    }
    let (live, cache) = (app.clone(), app.catalog_handle());
    app.write(&Caller::Server, GRANT_RETIRED, move |unit| {
        let Some(cutoff) = cutoff_of(unit.tx(), &live, GRANT_INACTIVITY_DAYS)? else {
            return Ok(0);
        };
        let idle = consents_in(unit.tx(), &idle_consents(), cutoff, 1)?;
        for (client_id, user_id) in &idle {
            grant::end(unit, &cache, client_id, user_id)?;
            unit.audit(
                "oauth_grant",
                client_id,
                Some(json!({
                    "client_id": client_id,
                    "user_id": user_id,
                    "cutoff": cutoff,
                })),
            )?;
        }
        Ok(i64::try_from(idle.len()).unwrap_or(i64::MAX))
    })
    .await
}

/// Each is a write of its own, since one ends every credential of the grant and rewrites its item.
pub async fn retire_idle_grants(app: &Arc<App>, run: &Run) -> Result<(i64, bool)> {
    let (taken, done) = drain(run, 1, || retire_one(app)).await?;
    if done {
        let cutoff = Cutoff::Kept(GRANT_INACTIVITY_DAYS);
        report_kept(app, run, cutoff, IDLE_UNREAD).await?;
    }
    Ok((taken, done))
}

async fn withdrawn_grants(app: &Arc<App>) -> Result<i64> {
    if !any_consent(app, withdrawn_consents, REVOKED_GRANT_RETENTION_DAYS).await? {
        return Ok(0);
    }
    let (live, cache) = (app.clone(), app.catalog_handle());
    app.write(&Caller::Server, GRANTS_PURGED, move |unit| {
        let Some(cutoff) = cutoff_of(unit.tx(), &live, REVOKED_GRANT_RETENTION_DAYS)? else {
            return Ok(0);
        };
        let withdrawn = consents_in(unit.tx(), &withdrawn_consents(), cutoff, BATCH)?;
        for (client_id, user_id) in &withdrawn {
            grant::forget(unit, &cache, client_id, user_id)?;
        }
        if !withdrawn.is_empty() {
            unit.audit_set(
                "oauth_grant",
                Some(json!({ "count": withdrawn.len(), "cutoff": cutoff })),
            )?;
        }
        Ok(i64::try_from(withdrawn.len()).unwrap_or(i64::MAX))
    })
    .await
}

/// So a client they alone kept can go.
pub async fn purge_withdrawn_grants(app: &Arc<App>, run: &Run) -> Result<(i64, bool)> {
    let (taken, done) = drain(run, BATCH, || withdrawn_grants(app)).await?;
    if done {
        let cutoff = Cutoff::Kept(REVOKED_GRANT_RETENTION_DAYS);
        report_kept(app, run, cutoff, WITHDRAWN_UNREAD).await?;
    }
    Ok((taken, done))
}

async fn expired_in(
    app: &Arc<App>,
    table: &'static str,
    key: &'static str,
    kept_ms: i64,
) -> Result<i64> {
    let Some(cutoff) = app.clock.instant().earlier_by(kept_ms) else {
        return Ok(0);
    };
    app.db
        .write(Write::own(), move |tx| {
            let count = tx.execute(
                &format!(
                    "DELETE FROM {table} WHERE {key} IN ( \
                     SELECT {key} FROM {table} WHERE {} AND expires_at <= ?1 LIMIT ?2)",
                    readable("expires_at")
                ),
                params![cutoff, BATCH],
            )?;
            Ok(i64::try_from(count).unwrap_or(i64::MAX))
        })
        .await
}

async fn expired_sessions(app: &Arc<App>) -> Result<i64> {
    let now = app.clock.instant();
    app.db
        .write(Write::own(), move |tx| {
            session::remove_expired(tx, now, BATCH)
        })
        .await
}

/// A rotated refresh token stays until then, so a replay of it is still recognized.
pub async fn sweep_expired(app: &Arc<App>, run: &Run) -> Result<(i64, bool)> {
    let (mut deleted, mut done) = drain(run, BATCH, || expired_sessions(app)).await?;
    if done {
        let now = Cutoff::At(app.clock.instant());
        let unread = [session::UNREAD].into_iter().chain(SWEPT_IN_PASSING);
        report_kept(app, run, now, unread).await?;
    }
    for (table, key, kept_ms) in [
        ("auth_oauth_code", "digest", 0),
        // A day longer, so a device polling after the code expired is told so.
        ("auth_oauth_device_code", "device_code", MS_PER_DAY),
        ("auth_oauth_access_token", "id", 0),
        ("auth_oauth_refresh_token", "id", 0),
        ("setup_proof", "digest", 0),
    ] {
        if !done {
            break;
        }
        let (taken, finished) = drain(run, BATCH, || expired_in(app, table, key, kept_ms)).await?;
        deleted += taken;
        done = finished;
        if let (true, Some(before)) = (done, app.clock.instant().earlier_by(kept_ms)) {
            let unread = Unread {
                table,
                time: "expires_at",
                scope: "1",
            };
            report_kept(app, run, Cutoff::At(before), [unread]).await?;
        }
    }
    Ok((deleted, done))
}

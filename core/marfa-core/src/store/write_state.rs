//! State kept by a queued write's id: its chosen tier, cleared time, the credential, source and versions it was sent with, learned source and unsent payload.

use super::Cached;
use super::meta::{meta_get, meta_set};
use crate::error::CoreError;
use crate::model::{Tier, WriteKind};
use rusqlite::{Connection, OptionalExtension, params};

pub(super) fn chosen_tier_key(id: &str) -> String {
    format!("chosen_tier/{id}")
}

/// Marks a create whose item's time the person cleared, which its answer
/// has to carry out (`device/edit-occurred-at-clear-unsent-landed`).
pub(crate) fn cleared_time_key(create: &str) -> String {
    format!("cleared_time/{create}")
}

/// Each key goes with its row, whichever way the row leaves the copy.
pub(super) const MADE: &str = "made/";

fn made_key(item_id: &str) -> String {
    format!("{MADE}{item_id}")
}

/// Records the version the server gave this copy's create of `item_id`. Kept
/// apart from the queue, which an app empties once it has read the answers,
/// while an app can still hold the item as read at version 0.
pub(crate) fn note_made(conn: &Connection, item_id: &str, version: i64) -> Result<(), CoreError> {
    meta_set(conn, &made_key(item_id), &version.to_string())
}

pub fn made_version(conn: &Connection, item_id: &str) -> Result<Option<i64>, CoreError> {
    Ok(meta_get(conn, &made_key(item_id))?.and_then(|version| version.parse().ok()))
}

pub(crate) fn forget_made(conn: &Connection, item_id: &str) -> Result<(), CoreError> {
    super::meta::meta_delete(conn, &made_key(item_id))
}

/// Forgets the clear of `item_id`'s time that the answer of any of its
/// creates still owes, whether or not that create has been answered.
pub(crate) fn forget_owed_time_clears(conn: &Connection, item_id: &str) -> Result<(), CoreError> {
    conn.execute_cached(
        "DELETE FROM main.meta
          WHERE key IN (SELECT 'cleared_time/' || id FROM queue
                         WHERE item_id = ?1 AND kind = ?2)",
        params![item_id, WriteKind::CreateItem.as_str()],
    )?;
    Ok(())
}

/// The tier a keyed create naming none was given by the copy's slice, which
/// the drain sends only where the server holds no row under its key.
pub fn choose_tier(conn: &Connection, id: &str, tier: Tier) -> Result<(), CoreError> {
    meta_set(conn, &chosen_tier_key(id), tier.as_str())
}

pub fn chosen_tier(conn: &Connection, id: &str) -> Result<Option<Tier>, CoreError> {
    meta_get(conn, &chosen_tier_key(id))?
        .map(|tier| tier.parse())
        .transpose()
}

const META_CREDENTIAL_SOURCE: &str = "credential_source";

/// The source the server stamps a write naming none with: the credential's
/// own (`items/source-own`), as `GET /keys/current` last answered it for the
/// credential `credential` names, a digest of it. `None` where that door
/// would not say, as for a signed-in app's token.
#[derive(serde::Serialize, serde::Deserialize)]
struct CredentialSource {
    credential: String,
    source: Option<String>,
}

pub fn learn_source(
    conn: &Connection,
    credential: &str,
    source: Option<&str>,
) -> Result<(), CoreError> {
    meta_set(
        conn,
        META_CREDENTIAL_SOURCE,
        &serde_json::to_string(&CredentialSource {
            credential: credential.into(),
            source: source.map(str::to_string),
        })?,
    )
}

/// What was learned for `credential`, and `None` where nothing was.
pub fn learned_source(
    conn: &Connection,
    credential: &str,
) -> Result<Option<Option<String>>, CoreError> {
    Ok(meta_get(conn, META_CREDENTIAL_SOURCE)?
        .map(|text| serde_json::from_str::<CredentialSource>(&text))
        .transpose()?
        .filter(|learned| learned.credential == credential)
        .map(|learned| learned.source))
}

pub(super) const SENT_AS: &str = "sent_as/";
pub(super) const SENT_SOURCE: &str = "sent_source/";

/// The credential, as `credential_digest` names it, that the write `id` was
/// last sent with. The server holds an idempotency key, and credits an
/// upload, to the credential that sent it (`items/idempotency-credential`).
pub fn record_sent_as(conn: &Connection, id: &str, credential: &str) -> Result<(), CoreError> {
    meta_set(conn, &format!("{SENT_AS}{id}"), credential)
}

/// `None` for a write never sent, or sent before the copy kept the record.
pub fn sent_as(conn: &Connection, id: &str) -> Result<Option<String>, CoreError> {
    meta_get(conn, &format!("{SENT_AS}{id}"))
}

/// A renewal replaces the bearer a credential sends, not the credential:
/// the server holds a key, and an upload, to the sign-in, which the new
/// token carries (`items/idempotency-signed-in`).
pub fn move_sent_as(conn: &Connection, from: &str, to: &str) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE meta SET value = ?2 WHERE key >= ?3 AND key < ?4 AND value = ?1",
        params![from, to, SENT_AS, super::meta::prefix_end(SENT_AS)],
    )?;
    Ok(())
}

/// The source the server stamped the keyed create `id` with when it named
/// none (`items/source-own`), as learned for the credential that sent it:
/// `None` where `GET /keys/current` would not say, as for an app's token.
pub fn record_sent_source(
    conn: &Connection,
    id: &str,
    source: Option<&str>,
) -> Result<(), CoreError> {
    meta_set(
        conn,
        &format!("{SENT_SOURCE}{id}"),
        &serde_json::to_string(&source)?,
    )
}

/// `None` where nothing was recorded for `id`.
pub fn sent_source(conn: &Connection, id: &str) -> Result<Option<Option<String>>, CoreError> {
    Ok(meta_get(conn, &format!("{SENT_SOURCE}{id}"))?
        .map(|text| serde_json::from_str(&text))
        .transpose()?)
}

pub(super) const SENT_AT_VERSION: &str = "sent_at_version/";
pub(super) const RESENT_AT_VERSION: &str = "resent_at_version/";

/// The version of its subject the copy held when the write `id` was first
/// sent, which a send under another credential names.
pub fn record_sent_at_version(conn: &Connection, id: &str, version: i64) -> Result<(), CoreError> {
    meta_set(
        conn,
        &format!("{SENT_AT_VERSION}{id}"),
        &version.to_string(),
    )
}

pub fn sent_at_version(conn: &Connection, id: &str) -> Result<Option<i64>, CoreError> {
    version_at(conn, &format!("{SENT_AT_VERSION}{id}"))
}

/// The version every send of `id` under its key names from now on: the
/// server fingerprints the query and body a key was first sent with.
pub fn record_resent_at_version(
    conn: &Connection,
    id: &str,
    version: i64,
) -> Result<(), CoreError> {
    meta_set(
        conn,
        &format!("{RESENT_AT_VERSION}{id}"),
        &version.to_string(),
    )
}

pub fn resent_at_version(conn: &Connection, id: &str) -> Result<Option<i64>, CoreError> {
    version_at(conn, &format!("{RESENT_AT_VERSION}{id}"))
}

/// A fresh key goes unconditionally, as the person released it, under this
/// credential and any later one.
pub(super) fn forget_versions_named(conn: &Connection, id: &str) -> Result<(), CoreError> {
    super::meta::meta_delete(conn, &format!("{SENT_AT_VERSION}{id}"))?;
    super::meta::meta_delete(conn, &format!("{RESENT_AT_VERSION}{id}"))
}

fn version_at(conn: &Connection, key: &str) -> Result<Option<i64>, CoreError> {
    meta_get(conn, key)?
        .map(|version| {
            version
                .parse()
                .map_err(|_| CoreError::Store(format!("{key} holds no version: {version}")))
        })
        .transpose()
}

/// Everything kept by the write `id`'s own id, for a write leaving the queue.
pub(super) fn forget_write_state(conn: &Connection, id: &str) -> Result<(), CoreError> {
    for key in [
        chosen_tier_key(id),
        cleared_time_key(id),
        format!("{SENT_AS}{id}"),
        format!("{SENT_SOURCE}{id}"),
        format!("{SENT_AT_VERSION}{id}"),
        format!("{RESENT_AT_VERSION}{id}"),
    ] {
        super::meta::meta_delete(conn, &key)?;
    }
    Ok(())
}

/// What a credential is known by in the copy: a digest of what it sends,
/// never the credential itself.
pub fn credential_digest(authorization: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(authorization.as_bytes()))
}

/// The source a write naming `named`, or none, falls under: `named`, or the
/// source learned for `credential`, a digest of the credential the copy
/// sends with. `None` where nothing was learned for that credential, or the
/// copy has no credential to send with, so a drain asks.
pub fn source_of(
    conn: &Connection,
    named: Option<&str>,
    credential: Option<&str>,
) -> Result<Option<String>, CoreError> {
    if let Some(named) = named {
        return Ok(Some(named.into()));
    }
    let Some(credential) = credential else {
        return Ok(None);
    };
    Ok(learned_source(conn, credential)?.flatten())
}

pub fn unsent(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn
        .query_row_cached("SELECT sent FROM queue WHERE id = ?1", [id], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?
        == Some(0))
}

/// Only before the write is first sent: the body sent is the one every
/// retry under its key sends again.
pub fn set_unsent_payload(conn: &Connection, id: &str, payload: &str) -> Result<(), CoreError> {
    conn.execute_cached(
        "UPDATE queue SET payload = ?2 WHERE id = ?1 AND sent = 0",
        params![id, payload],
    )?;
    Ok(())
}

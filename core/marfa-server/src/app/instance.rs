//! What an instance knows about itself.

use rusqlite::{OptionalExtension, Transaction, params};

use super::App;
use super::refusal::{Refusal, Result};
use crate::db::{Db, Write};

const ID: &str = "id";
const NAME: &str = "name";
const CLAIMED_AT: &str = "claimed_at";
const OWNER_ID: &str = "owner_id";
const DEFAULT_NAME: &str = "Marfa";

fn get(tx: &Transaction<'_>, key: &str) -> Result<Option<String>> {
    Ok(tx
        .query_row("SELECT value FROM instance WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

fn insert(tx: &Transaction<'_>, key: &str, value: &str) -> Result<bool> {
    let added = tx.execute(
        "INSERT INTO instance (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO NOTHING",
        params![key, value],
    )?;
    Ok(added > 0)
}

/// The instance's id, made the first time a database is started.
pub async fn identity(db: &Db) -> Result<String> {
    if let Some(id) = db.read(|tx| get(tx, ID)).await? {
        return Ok(id);
    }
    db.write(Write::own(), |tx| {
        insert(tx, ID, &uuid::Uuid::now_v7().to_string())?;
        get(tx, ID)?.ok_or_else(|| Refusal::internal("the instance id was not kept"))
    })
    .await
}

pub async fn name(app: &App) -> Result<String> {
    let name = app.db.read(|tx| get(tx, NAME)).await?;
    Ok(name.unwrap_or_else(|| DEFAULT_NAME.to_string()))
}

pub fn is_claimed(tx: &Transaction<'_>) -> Result<bool> {
    Ok(get(tx, CLAIMED_AT)?.is_some())
}

pub fn owner_id(tx: &Transaction<'_>) -> Result<Option<String>> {
    get(tx, OWNER_ID)
}

/// Marks the instance as claimed by `owner_id`, once. The mark outlasts the
/// owner's own rows, so losing them never reopens a claim.
pub fn mark_claimed(tx: &Transaction<'_>, at: &str, owner_id: &str) -> Result<bool> {
    if !insert(tx, CLAIMED_AT, at)? {
        return Ok(false);
    }
    insert(tx, OWNER_ID, owner_id)
}

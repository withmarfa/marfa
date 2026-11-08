use rusqlite::{OptionalExtension, Transaction, params};

use super::App;
use super::query::{SECRET_KEY, Secret};
use super::refusal::{Refusal, Result};
use crate::db::{Db, Write};

const ID: &str = "id";
const NAME: &str = "name";
const CLAIMED_AT: &str = "claimed_at";
const OWNER_ID: &str = "owner_id";
pub const DEFAULT_NAME: &str = "Marfa";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

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

/// Made the first time a database starts, and never answered.
pub async fn cursor_secret(db: &Db) -> Result<Secret> {
    let held = db.read(|tx| get(tx, SECRET_KEY)).await?;
    let text = match held {
        Some(text) => text,
        None => {
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes)
                .map_err(|_| Refusal::internal("no randomness was available"))?;
            let made = hex::encode(bytes);
            db.write(Write::own(), move |tx| {
                insert(tx, SECRET_KEY, &made)?;
                get(tx, SECRET_KEY)?
                    .ok_or_else(|| Refusal::internal("the cursor secret was not kept"))
            })
            .await?
        }
    };
    Ok(Secret(text.into_bytes()))
}

pub fn secret(tx: &Transaction<'_>) -> Result<Secret> {
    get(tx, SECRET_KEY)?
        .map(|text| Secret(text.into_bytes()))
        .ok_or_else(|| Refusal::internal("the cursor secret was not kept"))
}

pub async fn name(app: &App) -> Result<String> {
    let name = app.db.read(|tx| get(tx, NAME)).await?;
    Ok(name.unwrap_or_else(|| DEFAULT_NAME.to_string()))
}

pub fn stored_name(tx: &Transaction<'_>) -> Result<Option<String>> {
    get(tx, NAME)
}

pub fn set_name(tx: &Transaction<'_>, name: Option<&str>) -> Result<()> {
    match name {
        Some(name) => {
            tx.execute(
                "INSERT INTO instance (key, value) VALUES (?1, ?2) \
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![NAME, name],
            )?;
        }
        None => {
            tx.execute("DELETE FROM instance WHERE key = ?1", [NAME])?;
        }
    }
    Ok(())
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

//! What an instance knows about itself.

use rusqlite::{OptionalExtension, Transaction, params};

use super::App;
use super::access::Caller;
use super::refusal::{Code, Refusal, Result};
use crate::db::{Db, Write};

const ID: &str = "id";
const NAME: &str = "name";
const CLAIMED_AT: &str = "claimed_at";
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

pub async fn claimed(app: &App) -> Result<bool> {
    let claimed_at = app.db.read(|tx| get(tx, CLAIMED_AT)).await?;
    Ok(claimed_at.is_some())
}

/// Marks the instance as claimed, once.
pub async fn claim(app: &App, caller: &Caller) -> Result<()> {
    let instance = app.instance_id.clone();
    app.write(caller, "owner.claimed", move |unit| {
        unit.caller.require_direct()?;
        if !insert(unit.tx(), CLAIMED_AT, &unit.at)? {
            return Err(Refusal::new(
                Code::OwnerExists,
                "This instance has been claimed.",
            ));
        }
        unit.audit("instance", &instance, None)
    })
    .await
}

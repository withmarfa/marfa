use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde_json::{Value, json};
use webauthn_rs::prelude::Passkey;

use crate::app::refusal::{Refusal, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listed {
    pub id: String,
    pub name: Option<String>,
    pub host: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

impl Listed {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "created_at": self.created_at,
            "last_used_at": self.last_used_at,
        })
    }
}

pub struct Held {
    pub id: String,
    pub user_id: String,
    pub host: String,
    pub passkey: Passkey,
}

pub struct New<'a> {
    pub id: &'a str,
    pub user_id: &'a str,
    pub credential_id: &'a str,
    pub host: &'a str,
    pub name: Option<&'a str>,
    pub passkey: &'a Passkey,
    pub at: &'a str,
}

const LISTED: &str = "id, name, host, created_at, last_used_at";

fn listed(row: &Row<'_>) -> rusqlite::Result<Listed> {
    Ok(Listed {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        created_at: row.get(3)?,
        last_used_at: row.get(4)?,
    })
}

fn written(passkey: &Passkey) -> Result<String> {
    serde_json::to_string(passkey).map_err(|_| Refusal::internal("a passkey did not write"))
}

pub fn all(tx: &Transaction<'_>) -> Result<Vec<Listed>> {
    let mut statement = tx.prepare(&format!(
        "SELECT {LISTED} FROM auth_passkey ORDER BY created_at, id"
    ))?;
    let rows = statement.query_map([], listed)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn credentials_of(tx: &Transaction<'_>, host: &str) -> Result<Vec<String>> {
    let mut statement = tx.prepare("SELECT credential_id FROM auth_passkey WHERE host = ?1")?;
    let rows = statement.query_map(params![host], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn by_credential(tx: &Transaction<'_>, credential_id: &str) -> Result<Option<Held>> {
    let found: Option<(String, String, String, String)> = tx
        .query_row(
            "SELECT id, user_id, host, credential FROM auth_passkey WHERE credential_id = ?1",
            params![credential_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    found
        .map(|(id, user_id, host, credential)| {
            let passkey = serde_json::from_str(&credential)
                .map_err(|_| Refusal::internal("a stored passkey did not read"))?;
            Ok(Held {
                id,
                user_id,
                host,
                passkey,
            })
        })
        .transpose()
}

/// Records a passkey. Answers `None`, recording nothing, if its credential is
/// already registered. The unique column decides, so two at once cannot both
/// land.
pub fn insert(tx: &Transaction<'_>, new: &New<'_>) -> Result<Option<Listed>> {
    let inserted = tx.execute(
        "INSERT INTO auth_passkey (id, user_id, credential_id, host, name, credential, \
         created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (credential_id) DO NOTHING",
        params![
            new.id,
            new.user_id,
            new.credential_id,
            new.host,
            new.name,
            written(new.passkey)?,
            new.at,
        ],
    )?;
    Ok((inserted == 1).then(|| Listed {
        id: new.id.to_string(),
        name: new.name.map(str::to_string),
        host: new.host.to_string(),
        created_at: new.at.to_string(),
        last_used_at: None,
    }))
}

pub fn record_use(tx: &Transaction<'_>, id: &str, passkey: &Passkey, at: &str) -> Result<()> {
    tx.execute(
        "UPDATE auth_passkey SET credential = ?2, last_used_at = ?3 WHERE id = ?1",
        params![id, written(passkey)?, at],
    )?;
    Ok(())
}

pub fn rename(tx: &Transaction<'_>, id: &str, name: &str) -> Result<Option<Listed>> {
    Ok(tx
        .query_row(
            &format!("UPDATE auth_passkey SET name = ?2 WHERE id = ?1 RETURNING {LISTED}"),
            params![id, name],
            listed,
        )
        .optional()?)
}

pub fn remove(tx: &Transaction<'_>, id: &str) -> Result<bool> {
    Ok(tx.execute("DELETE FROM auth_passkey WHERE id = ?1", params![id])? == 1)
}

pub fn count_beyond(tx: &Transaction<'_>, host: &str) -> Result<i64> {
    Ok(tx.query_row(
        "SELECT count(*) FROM auth_passkey WHERE host <> ?1",
        params![host],
        |row| row.get(0),
    )?)
}

//! The owner's picture: bytes in the blob store, and the one row that names them.

mod kind;

use std::collections::BTreeMap;
use std::sync::Arc;

use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};

pub use kind::MAX_BYTES;

use super::owner::{self, Owner};
use super::{Note, Visit, note};
use crate::app::App;
use crate::app::access::{Caller, Level};
use crate::app::blobs::references::{self, Naming, Row as Referencing};
use crate::app::blobs::{Found, Hash};
use crate::app::refusal::{Refusal, Result};

/// The way a picture arrives, which decides who may send it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Door {
    Owner,
    Profile,
}

impl Door {
    fn admit(self, caller: &Caller, at: &str) -> Result<()> {
        match self {
            Door::Owner => {
                caller.require_direct()?;
                caller.require_recent(at)
            }
            Door::Profile => caller.require_profile("avatar", Level::Write),
        }
    }

    fn action(self) -> &'static str {
        match self {
            Door::Owner => "owner.update",
            Door::Profile => "profile.update",
        }
    }
}

#[derive(Debug)]
pub struct Picture {
    pub hash: Hash,
    pub mime_type: String,
}

fn unread() -> Refusal {
    Refusal::internal("the stored picture does not read")
}

fn stored(tx: &Transaction<'_>) -> Result<Option<Picture>> {
    let row = tx
        .query_row(
            "SELECT hash, mime_type FROM owner_picture WHERE id = 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    row.map(|(hash, mime_type)| {
        Ok(Picture {
            hash: Hash::parse(&hash).map_err(|_| unread())?,
            mime_type,
        })
    })
    .transpose()
}

pub(super) fn exists(tx: &Transaction<'_>) -> Result<bool> {
    Ok(
        tx.query_row("SELECT EXISTS (SELECT 1 FROM owner_picture)", [], |row| {
            row.get(0)
        })?,
    )
}

pub(super) fn remove(tx: &Transaction<'_>) -> Result<()> {
    tx.execute("DELETE FROM owner_picture", [])?;
    references::forget(tx, Referencing::Owner)
}

/// The index names the picture's bytes, so a purge never takes them, and lends them to no one.
fn set(
    tx: &Transaction<'_>,
    caller: &Caller,
    hash: &Hash,
    mime_type: &str,
    at: &str,
) -> Result<()> {
    let properties = Map::from_iter([("picture".to_string(), Value::from(hash.as_str()))]);
    let standing = BTreeMap::from([(hash.as_str().to_string(), false)]);
    let naming = Naming {
        inherited: Some(&standing),
        ..Naming::default()
    };
    references::decide(tx, caller, Some(Referencing::Owner), &properties, naming)?
        .apply(tx, Referencing::Owner)?;
    tx.execute(
        "INSERT INTO owner_picture (id, hash, mime_type, updated_at) VALUES (1, ?1, ?2, ?3) \
         ON CONFLICT (id) DO UPDATE SET hash = excluded.hash, \
         mime_type = excluded.mime_type, updated_at = excluded.updated_at",
        params![hash.as_str(), mime_type, at],
    )?;
    Ok(())
}

impl App {
    /// Refuses a caller the door does not admit, before a body is read for it.
    pub fn admit_picture(&self, caller: &Caller, door: Door) -> Result<()> {
        door.admit(caller, &self.clock.stamp())
    }

    pub async fn put_picture(
        self: &Arc<App>,
        caller: &Caller,
        door: Door,
        bytes: Vec<u8>,
        visit: Visit,
    ) -> Result<Owner> {
        let kind = kind::of(&bytes)?;
        if owner::find(self).await?.is_none() {
            return Err(owner::not_found());
        }
        let length = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        let mut intake = self
            .begin_upload(Some(length), kind.mime_type().to_string())
            .await?;
        if let Err(refused) = intake.push(bytes).await {
            intake.discard().await;
            return Err(refused);
        }
        self.keep_upload(caller, door.action(), intake, move |unit, recording| {
            door.admit(&unit.caller, &unit.at)?;
            let mut found = owner::read(unit.tx())?.ok_or_else(owner::not_found)?;
            let blob = recording.record(unit.tx(), None, &unit.at)?;
            set(
                unit.tx(),
                &unit.caller,
                &blob.hash,
                kind.mime_type(),
                &unit.at,
            )?;
            found.avatar = true;
            note(
                unit.tx(),
                &unit.at,
                Some(&unit.caller),
                &visit,
                Note {
                    action: door.action(),
                    resource_type: "auth_user",
                    resource_id: &found.id,
                    details: Some(json!({ "fields": ["avatar"] })),
                },
            )?;
            Ok(found)
        })
        .await
    }

    /// The owner's picture and the blob that holds it, read as one.
    pub async fn owner_picture(&self) -> Result<Option<(Picture, Found)>> {
        self.db
            .read(move |tx| {
                let Some(picture) = stored(tx)? else {
                    return Ok(None);
                };
                let found = App::found_in(tx, None, &picture.hash)?;
                Ok(Some((picture, found)))
            })
            .await
    }
}

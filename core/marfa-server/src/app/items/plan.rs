//! What a move to the bin or a purge touches. [`plan`] alone judges it, inside
//! the transaction that acts on the answer, so a preview and the write after
//! it cannot disagree about what moves, what stops it or what the digest is.

use rusqlite::Transaction;
use sha2::{Digest, Sha256};

use super::write::stale_bare;
use super::{Item, is_system, not_found, rows};
use crate::app::access::{Caller, Level, Permission};
use crate::app::idempotency::{Claim, Need};
use crate::app::refusal::{Code, Refusal, Result};

/// The checks a door's row goes through, each noted for a replay to ask again.
pub(super) struct Gate<'a, 'c> {
    pub tx: &'a Transaction<'c>,
    pub caller: &'a Caller,
    pub claim: Option<&'a Claim>,
    pub server_own: bool,
}

fn reserved(type_id: &str) -> Refusal {
    Refusal::new(
        Code::TypeNotPermitted,
        format!("Items of type \"{type_id}\" are not written through this door."),
    )
}

pub(super) fn invalid_transition(from: &str, to: &str) -> Refusal {
    Refusal::new(
        Code::InvalidTransition,
        format!("An item cannot move from {from} to {to}."),
    )
}

impl Gate<'_, '_> {
    pub fn note(&self, need: Need) {
        if let Some(claim) = self.claim {
            claim.note(need);
        }
    }

    /// Whether the caller may write items of `type_id` through an item door,
    /// which no caller may for a `system.*` type: only the server's own writes
    /// reach those.
    pub fn type_gate(&self, type_id: &str) -> Result<()> {
        self.type_map_gate(type_id)?;
        if is_system(type_id) && !self.server_own {
            return Err(reserved(type_id));
        }
        Ok(())
    }

    fn type_map_gate(&self, type_id: &str) -> Result<()> {
        self.note(Need::Reach);
        self.caller.require_reach()?;
        self.note(Need::Type {
            name: type_id.to_string(),
            write: true,
        });
        self.caller.require_type(type_id, Level::Write)
    }

    pub fn row_gate(&self, row: &Item) -> Result<()> {
        self.note_write(row);
        self.type_gate(&row.type_id)
    }

    fn note_write(&self, row: &Item) {
        self.note(Need::Item {
            id: row.id.clone(),
            type_id: row.type_id.clone(),
            write: true,
        });
    }

    /// The row a door names, in whatever state, which reads as missing where
    /// it is gone or unreadable.
    pub fn readable_row(&self, id: &str) -> Result<Item> {
        self.note(Need::Reach);
        self.caller.require_reach()?;
        rows::by_id(self.tx, id)?
            .filter(|row| self.caller.may_read_type(&row.type_id))
            .ok_or_else(not_found)
    }

    /// The row a door writes, which also reads as missing in the bin and says
    /// so to a caller who may read it there.
    pub fn writable_row(&self, id: &str) -> Result<Item> {
        let row = self.readable_row(id)?;
        if row.state == "trashed" {
            self.note(Need::Item {
                id: row.id.clone(),
                type_id: row.type_id.clone(),
                write: false,
            });
            return Err(not_found().with_detail("trashed", true));
        }
        self.row_gate(&row)?;
        Ok(row)
    }

    fn binnable(&self, asked: &Asked) -> Result<Item> {
        let row = self.writable_row(&asked.id)?;
        require_version(&row, asked.version)?;
        Ok(row)
    }

    /// A row in the bin answers only to the type map: the reserved namespaces
    /// fence what a door may change, and purging what is already binned
    /// changes nothing a person kept.
    fn purgeable(&self, asked: &Asked) -> Result<Item> {
        self.note(Need::Purge);
        self.caller.require(Permission::ItemsPurge)?;
        let row = self.readable_row(&asked.id)?;
        self.note_write(&row);
        self.type_map_gate(&row.type_id)?;
        if row.state != "trashed" && is_system(&row.type_id) {
            return Err(reserved(&row.type_id));
        }
        require_version(&row, asked.version)?;
        if row.state != "trashed" {
            return Err(invalid_transition(&row.state, "purged"));
        }
        Ok(row)
    }
}

/// Refuses a `named` version the row no longer holds.
pub(super) fn require_version(row: &Item, named: Option<i64>) -> Result<()> {
    match named {
        Some(named) if named != row.version => Err(stale_bare(row, named)?),
        _ => Ok(()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Act {
    Bin,
    Purge,
}

/// A row a plan is asked about, and the version the caller read, if it says.
pub(super) struct Asked {
    pub id: String,
    pub version: Option<i64>,
}

/// What an act touches, in the order the rows were named.
pub(super) struct Plan {
    pub items: Vec<Item>,
    pub digest: String,
}

fn digest_of(items: &[Item]) -> String {
    let mut counted: Vec<(&str, i64)> = items
        .iter()
        .map(|item| (item.id.as_str(), item.version))
        .collect();
    counted.sort_unstable();
    let mut digest = Sha256::new();
    for (id, version) in counted {
        digest.update(format!("{id}\0{version}\n").as_bytes());
    }
    hex::encode(digest.finalize())
}

/// Judges `act` on the rows `asked` names. A refusal means nothing moves.
pub(super) fn plan(gate: &Gate<'_, '_>, act: Act, asked: &[Asked]) -> Result<Plan> {
    let items = asked
        .iter()
        .map(|row| match act {
            Act::Bin => gate.binnable(row),
            Act::Purge => gate.purgeable(row),
        })
        .collect::<Result<Vec<Item>>>()?;
    Ok(Plan {
        digest: digest_of(&items),
        items,
    })
}

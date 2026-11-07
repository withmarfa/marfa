//! Edges: what they hold, how they are answered and how they are written.
//!
//! Every write goes through [`write::write`], and only `rows` holds the SQL of
//! the edges table, so no other part of the crate can make or move an edge
//! without the checks, the version step, the audit entry and the event.

pub mod bulk;
mod read;
mod rows;
pub mod write;

use marfa_rules::edges::OnDelete;
use rusqlite::Transaction;
use serde::Serialize;
use serde_json::Value;

use super::catalog::Catalog;
use super::items::with_properties;
use super::refusal::{Code, Refusal, Result};

pub(crate) use read::hydrate;
pub use read::{Blocks, ItemListing, Listing, Reach, get, list, of_item};
pub(crate) use rows::Store;

/// An edge as stored. `properties` is the stored JSON as text.
#[derive(Clone, Debug)]
pub struct Edge {
    seq: i64,
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub edge_type: String,
    pub properties: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
struct EdgeHead<'a> {
    id: &'a str,
    source_id: &'a str,
    target_id: &'a str,
    edge_type: &'a str,
    version: i64,
    created_at: &'a str,
    updated_at: &'a str,
}

impl Edge {
    /// The edge as an answer and an event give it.
    pub fn answered(&self) -> Result<String> {
        with_properties(
            &EdgeHead {
                id: &self.id,
                source_id: &self.source_id,
                target_id: &self.target_id,
                edge_type: &self.edge_type,
                version: self.version,
                created_at: &self.created_at,
                updated_at: &self.updated_at,
            },
            &self.properties,
        )
    }

    fn value(&self) -> Result<Value> {
        serde_json::from_str(&self.answered()?)
            .map_err(|_| Refusal::internal("an edge did not print"))
    }
}

fn not_found(id: &str) -> Refusal {
    Refusal::new(Code::EdgeNotFound, format!("Edge {id} not found"))
}

const EXCERPT_OF: &str = "excerpt-of";

/// The host an item with no title of its own is named after.
pub struct NamingHost {
    pub label: String,
    pub type_id: String,
    pub properties: String,
}

/// The item the oldest edge out of `id` that names a part reaches out of the
/// bin: an edge of a `with-hosts` type, or `excerpt-of`.
pub fn naming_host(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    id: &str,
) -> Result<Option<NamingHost>> {
    for (edge_type, type_id, properties) in rows::hosts_out_of_bin(tx, id)? {
        let Some(kind) = catalog.edge_kind(&edge_type) else {
            continue;
        };
        if edge_type == EXCERPT_OF
            || OnDelete::of(Some(&kind.cascade_on_delete)) == OnDelete::WithHosts
        {
            return Ok(Some(NamingHost {
                label: kind.label.clone(),
                type_id,
                properties,
            }));
        }
    }
    Ok(None)
}

/// The type of the row the edge `id` now starts from.
pub fn source_type(tx: &Transaction<'_>, id: &str) -> Result<Option<String>> {
    match rows::by_id(tx, id)? {
        Some(edge) => super::items::type_of(tx, &edge.source_id),
        None => Ok(None),
    }
}

/// How many stored edges hold `edge_type`.
pub fn count_of_type(tx: &Transaction<'_>, edge_type: &str) -> Result<i64> {
    rows::count_of_type(tx, edge_type)
}

/// Each type stored edges of `edge_type` have at their targets.
pub fn target_types(tx: &Transaction<'_>, edge_type: &str) -> Result<Vec<String>> {
    rows::target_types(tx, edge_type)
}

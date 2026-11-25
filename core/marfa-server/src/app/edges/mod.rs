//! Every write goes through [`write::write`]; only `rows` holds the SQL of the edges table.

pub mod bulk;
mod placed;
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

pub use placed::{Directory, Tree, directories, under_names};
pub(crate) use read::hydrate;
pub use read::{Blocks, ItemListing, Listing, Reach, get, list, of_item};
pub use rows::End;
pub(crate) use rows::Store;

#[derive(Clone, Debug)]
pub struct Edge {
    seq: i64,
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub edge_type: String,
    pub properties: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
struct EdgeHead<'a> {
    id: &'a str,
    from_id: &'a str,
    to_id: &'a str,
    edge_type: &'a str,
    version: i64,
    created_at: &'a str,
    updated_at: &'a str,
}

impl Edge {
    pub fn seq(&self) -> i64 {
        self.seq
    }

    pub fn answered(&self) -> Result<String> {
        with_properties(
            &EdgeHead {
                id: &self.id,
                from_id: &self.from_id,
                to_id: &self.to_id,
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

pub struct NamingHost {
    pub label: String,
    pub type_id: String,
    pub properties: String,
}

/// Finds the oldest host through a `with-hosts` or `excerpt-of` edge whose type `readable` admits.
pub fn naming_host(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    id: &str,
    readable: &dyn Fn(&str) -> bool,
) -> Result<Option<NamingHost>> {
    for (edge_type, type_id, properties) in rows::hosts_out_of_bin(tx, id)? {
        if !readable(&type_id) {
            continue;
        }
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

/// The type and source of the from item of the edge `id`.
pub fn from_type_and_source(tx: &Transaction<'_>, id: &str) -> Result<Option<(String, String)>> {
    match rows::by_id(tx, id)? {
        Some(edge) => super::items::type_and_source_of(tx, &edge.from_id),
        None => Ok(None),
    }
}

pub fn count_of_type(tx: &Transaction<'_>, edge_type: &str) -> Result<i64> {
    rows::count_of_type(tx, edge_type)
}

pub fn to_types(tx: &Transaction<'_>, edge_type: &str) -> Result<Vec<String>> {
    rows::to_types(tx, edge_type)
}

/// An edge, its two ends, and the digests it names that lend.
pub struct Ended {
    pub edge: Edge,
    pub from: End,
    pub to: End,
    pub lending: Vec<String>,
}

/// A page of edges after `after`, in `seq` order, each with its two ends.
pub fn with_ends(tx: &Transaction<'_>, after: i64, limit: i64) -> Result<Vec<Ended>> {
    rows::with_ends(tx, after, limit)?
        .into_iter()
        .map(|(edge, from, to)| {
            let lending =
                super::blobs::references::held(tx, super::blobs::references::Row::Edge(edge.seq))?
                    .into_iter()
                    .filter_map(|(hash, lends)| lends.then_some(hash))
                    .collect();
            Ok(Ended {
                edge,
                from,
                to,
                lending,
            })
        })
        .collect()
}

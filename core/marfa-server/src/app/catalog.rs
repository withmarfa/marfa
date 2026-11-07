//! The types and edge types the instance holds, read as one catalog.
//!
//! A catalog carries the generation of the database it was read from. The
//! generation is raised in the transaction that changes a type or an edge
//! type, so a transaction asks for the catalog of its own snapshot: the
//! shared one when the generations agree, one read from the transaction when
//! they do not. Only a catalog read from a committed snapshot is shared.

use std::collections::HashMap;
use std::sync::Arc;

use arc_swap::ArcSwap;
use marfa_rules::builtin;
use marfa_rules::schema::{Obj, Registry};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::App;
use super::refusal::{Refusal, Result};

const GENERATION: &str = "catalog_generation";

/// Where a stored type came from.
#[derive(Clone, Debug, PartialEq)]
pub struct Provenance {
    pub origin: &'static str,
    pub created_by: Option<Value>,
}

/// Which snapshot a caller asks the catalog of.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Snapshot {
    /// A read transaction: what it sees is committed, so it may be shared.
    Committed,
    /// A write transaction: what it sees may roll back, so it is never shared.
    Pending,
}

#[derive(Debug)]
pub struct Catalog {
    pub generation: i64,
    /// The types whose stored definition reads, with their owners' icons.
    pub types: Registry,
    pub provenance: HashMap<String, Provenance>,
    /// The ids whose stored definition does not read, sorted.
    pub unreadable: Vec<String>,
    /// The edge types registered here, by id.
    pub edge_types: Vec<Obj>,
}

impl Catalog {
    pub fn empty() -> Catalog {
        Catalog {
            generation: -1,
            types: Registry::default(),
            provenance: HashMap::new(),
            unreadable: Vec::new(),
            edge_types: Vec::new(),
        }
    }

    pub fn holds(&self, id: &str) -> bool {
        self.provenance.contains_key(id)
    }

    pub fn is_unreadable(&self, id: &str) -> bool {
        self.unreadable.iter().any(|held| held == id)
    }

    /// Whether Marfa ships `id`.
    pub fn ships(id: &str) -> bool {
        builtin::ships(id).unwrap_or(false)
    }

    /// The platform types stored here that this build no longer ships, sorted.
    pub fn retired(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self
            .provenance
            .iter()
            .filter(|(id, held)| held.origin == "platform" && !Catalog::ships(id))
            .map(|(id, _)| id.as_str())
            .collect();
        ids.sort_unstable();
        ids
    }

    pub fn edge_type(&self, id: &str) -> Option<&Obj> {
        self.edge_types
            .iter()
            .find(|held| held.get("id").and_then(Value::as_str) == Some(id))
    }
}

pub fn generation(tx: &Transaction<'_>) -> Result<i64> {
    let held: Option<String> = tx
        .query_row(
            "SELECT value FROM instance WHERE key = ?1",
            [GENERATION],
            |row| row.get(0),
        )
        .optional()?;
    Ok(held.and_then(|text| text.parse().ok()).unwrap_or(0))
}

/// Raises the generation, in the transaction that changes the catalog.
pub fn raise(tx: &Transaction<'_>) -> Result<()> {
    tx.execute(
        "INSERT INTO instance (key, value) VALUES (?1, '1') \
         ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
        [GENERATION],
    )?;
    Ok(())
}

fn readable(id: &str, definition: &str) -> Option<Obj> {
    let Ok(Value::Object(row)) = serde_json::from_str::<Value>(definition) else {
        return None;
    };
    let named = row.get("id").and_then(Value::as_str) == Some(id);
    let fields = row.get("fields").is_none_or(Value::is_object);
    (named && fields).then_some(row)
}

fn load(tx: &Transaction<'_>, generation: i64) -> Result<Catalog> {
    let mut rows = Vec::new();
    let mut icons = HashMap::new();
    let mut provenance = HashMap::new();
    let mut unreadable = Vec::new();
    let mut statement =
        tx.prepare("SELECT id, origin, created_by, owner_icon, definition FROM types ORDER BY id")?;
    let mut found = statement.query([])?;
    while let Some(row) = found.next()? {
        let id: String = row.get(0)?;
        let origin: String = row.get(1)?;
        let created_by: Option<String> = row.get(2)?;
        let icon: Option<String> = row.get(3)?;
        let definition: String = row.get(4)?;
        provenance.insert(
            id.clone(),
            Provenance {
                origin: if origin == "platform" {
                    "platform"
                } else {
                    "user"
                },
                created_by: created_by.and_then(|text| serde_json::from_str(&text).ok()),
            },
        );
        match readable(&id, &definition) {
            Some(definition) => {
                if let Some(icon) = icon {
                    icons.insert(id.clone(), icon);
                }
                rows.push(definition);
            }
            None => unreadable.push(id),
        }
    }
    let mut edge_types = Vec::new();
    let mut statement = tx.prepare("SELECT id, definition FROM edge_types ORDER BY id")?;
    let mut found = statement.query([])?;
    while let Some(row) = found.next()? {
        let id: String = row.get(0)?;
        let definition: String = row.get(1)?;
        match serde_json::from_str::<Value>(&definition) {
            Ok(Value::Object(definition)) => edge_types.push(definition),
            _ => tracing::error!(edge_type = %id, "A stored edge type does not read"),
        }
    }
    Ok(Catalog {
        generation,
        types: Registry::new(rows).with_icons(icons),
        provenance,
        unreadable,
        edge_types,
    })
}

/// The catalog `tx` sees. A shared catalog read from a newer snapshot is
/// never replaced by an older one.
pub fn current(
    cache: &ArcSwap<Catalog>,
    tx: &Transaction<'_>,
    snapshot: Snapshot,
) -> Result<Arc<Catalog>> {
    let held = cache.load_full();
    let generation = generation(tx)?;
    if held.generation == generation {
        return Ok(held);
    }
    let loaded = Arc::new(load(tx, generation)?);
    if snapshot == Snapshot::Committed {
        cache.rcu(|shared| {
            if shared.generation < generation {
                loaded.clone()
            } else {
                shared.clone()
            }
        });
    }
    Ok(loaded)
}

/// Brings the stored platform types to the set this build ships. A type this
/// build no longer ships stays, as a retired one, until it is removed.
pub fn reconcile(tx: &Transaction<'_>, at: &str) -> Result<()> {
    let shipped = builtin::shipped_types()
        .map_err(|error| Refusal::internal(&format!("the shipped types do not read: {error}")))?;
    let mut changed = false;
    for definition in shipped {
        let id = definition
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| Refusal::internal("a shipped type has no id"))?;
        let parent = definition.get("parent").and_then(Value::as_str);
        let text = Value::Object(definition.clone()).to_string();
        let held: Option<(String, String)> = tx
            .query_row(
                "SELECT definition, origin FROM types WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match held {
            Some((definition, origin)) if definition == text && origin == "platform" => {}
            Some(_) => {
                tx.execute(
                    "UPDATE types SET definition = ?2, parent = ?3, origin = 'platform', \
                     created_by = NULL, updated_at = ?4 WHERE id = ?1",
                    params![id, text, parent, at],
                )?;
                changed = true;
            }
            None => {
                tx.execute(
                    "INSERT INTO types (id, parent, origin, definition, created_at, updated_at) \
                     VALUES (?1, ?2, 'platform', ?3, ?4, ?4)",
                    params![id, parent, text, at],
                )?;
                changed = true;
            }
        }
    }
    if changed {
        raise(tx)?;
    }
    Ok(())
}

impl App {
    /// The catalog `tx` sees. See [`current`].
    pub fn catalog(&self, tx: &Transaction<'_>, snapshot: Snapshot) -> Result<Arc<Catalog>> {
        current(&self.catalog, tx, snapshot)
    }

    /// Shares the catalog of the newest committed snapshot, which a write
    /// that changed it calls once it has committed. A reader that finds the
    /// catalog behind publishes it itself, so a failure here costs nothing.
    pub async fn publish_catalog(&self) {
        let cache = self.catalog_handle();
        let published = self
            .db
            .read(move |tx| current(&cache, tx, Snapshot::Committed).map(|_| ()))
            .await;
        if let Err(refusal) = published {
            tracing::warn!(code = refusal.code.wire(), "The catalog was not published");
        }
    }
}

/// The shape a stored type's provenance is answered in.
pub fn provenance_json(held: Option<&Provenance>) -> Value {
    match held {
        Some(held) => json!({
            "origin": held.origin,
            "created_by": held.created_by.clone().unwrap_or(Value::Null),
        }),
        None => json!({ "origin": "unknown", "created_by": null }),
    }
}

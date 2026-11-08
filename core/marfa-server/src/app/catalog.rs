//! A catalog carries the database generation it was read at, raised in the
//! transaction that changes a type or edge type. A transaction uses the shared
//! catalog when generations agree, else reads its own; only a committed
//! snapshot is shared.

use std::collections::HashMap;
use std::sync::Arc;

use arc_swap::ArcSwap;
use marfa_rules::builtin;
use marfa_rules::catalog::{Catalog as Rules, CatalogEntry, EdgeType};
use marfa_rules::edges::OnDelete;
use marfa_rules::schema::{Obj, Registry};
use marfa_rules::wire::{WireEdgeType, WireType};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::App;
use super::refusal::{Refusal, Result};

const GENERATION: &str = "catalog_generation";

#[derive(Clone, Debug, PartialEq)]
pub struct Provenance {
    pub origin: &'static str,
    pub created_by: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Snapshot {
    Committed,
    Pending,
}

#[derive(Debug)]
pub struct Catalog {
    pub generation: i64,
    edge_kinds: HashMap<String, EdgeType>,
    pub types: Registry,
    pub provenance: HashMap<String, Provenance>,
    pub unreadable: Vec<String>,
    pub edge_types: Vec<Obj>,
    pub rules: Rules,
}

impl Catalog {
    pub fn empty() -> Catalog {
        Catalog {
            generation: -1,
            types: Registry::default(),
            provenance: HashMap::new(),
            unreadable: Vec::new(),
            edge_types: Vec::new(),
            edge_kinds: HashMap::new(),
            rules: Rules::empty(),
        }
    }

    pub fn holds(&self, id: &str) -> bool {
        self.provenance.contains_key(id)
    }

    pub fn is_unreadable(&self, id: &str) -> bool {
        self.unreadable.iter().any(|held| held == id)
    }

    /// A subtype inherits the field, never the link.
    pub fn link_field(&self, type_id: &str) -> Option<&str> {
        self.types.get(type_id)?.get("link_field")?.as_str()
    }

    pub fn ships(id: &str) -> bool {
        builtin::ships(id).unwrap_or(false)
    }

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

    pub fn edge_kind(&self, id: &str) -> Option<&EdgeType> {
        self.edge_kinds.get(id)
    }

    pub fn edge_kinds(&self) -> impl Iterator<Item = &EdgeType> {
        self.edge_kinds.values()
    }

    pub fn with_hosts_types(&self) -> Vec<&str> {
        self.edge_kinds
            .values()
            .filter(|kind| OnDelete::of(Some(&kind.cascade_on_delete)) == OnDelete::WithHosts)
            .map(|kind| kind.id.as_str())
            .collect()
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
    let rules = rules_of(&rows);
    let edge_kinds = edge_kinds_of(&edge_types)?;
    Ok(Catalog {
        generation,
        types: Registry::new(rows).with_icons(icons),
        provenance,
        unreadable,
        edge_types,
        edge_kinds,
        rules,
    })
}

fn edge_kinds_of(registered: &[Obj]) -> Result<HashMap<String, EdgeType>> {
    let shipped = builtin::shipped_edge_types()
        .map_err(|error| Refusal::internal(&format!("the shipped edge types: {error}")))?;
    let held = shipped
        .iter()
        .filter_map(Value::as_object)
        .chain(registered)
        .filter_map(|row| {
            let named = crate::app::edge_types::presented(row.clone());
            match serde_json::from_value::<WireEdgeType>(named) {
                Ok(wire) => EdgeType::from_wire(wire).ok(),
                Err(_) => None,
            }
            .or_else(|| {
                tracing::error!("A stored edge type does not read as an edge type");
                None
            })
        });
    Ok(held.map(|kind| (kind.id.clone(), kind)).collect())
}

fn rules_of(rows: &[Obj]) -> Rules {
    let entries = rows.iter().filter_map(|row| {
        let wire = serde_json::from_value::<WireType>(Value::Object(row.clone()));
        match wire {
            Ok(wire) => Some((wire.id.clone(), CatalogEntry::from_wire(&wire))),
            Err(_) => {
                tracing::error!("A stored type does not read as a type");
                None
            }
        }
    });
    Rules::new(entries.collect(), None)
}

/// A shared catalog read from a newer snapshot is never replaced by an older one.
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

/// A type this build no longer ships stays, as a retired one, until it is removed.
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
    pub fn catalog(&self, tx: &Transaction<'_>, snapshot: Snapshot) -> Result<Arc<Catalog>> {
        current(&self.catalog, tx, snapshot)
    }

    /// Called once a write that changed the catalog has committed. A reader that finds
    /// the shared catalog behind publishes it itself, so a failure here costs nothing.
    pub async fn publish_catalog(&self) {
        let cache = self.catalog_handle();
        let published = self
            .db
            .read(move |tx| current(&cache, tx, Snapshot::Committed).map(|_| ()))
            .await;
        if let Err(refusal) = published {
            tracing::warn!(code = refusal.code.wire(), "The catalog was not published");
        }
        self.reindexing.notify_one();
    }
}

pub fn provenance_json(held: Option<&Provenance>) -> Value {
    match held {
        Some(held) => json!({
            "origin": held.origin,
            "created_by": held.created_by.clone().unwrap_or(Value::Null),
        }),
        None => json!({ "origin": "unknown", "created_by": null }),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::app::access::Caller;
    use crate::app::types;
    use crate::settings::{Environment, Settings};

    async fn started() -> (TempDir, Arc<App>) {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("SQLITE_PATH", database.to_str().unwrap()),
            ("BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        (dir, App::start(settings).await.unwrap())
    }

    fn definition(id: &str, parent: Option<&str>) -> Obj {
        let mut body = json!({ "id": id, "fields": { "note": { "type": "string" } } });
        if let Some(parent) = parent {
            body["parent"] = json!(parent);
        }
        match body {
            Value::Object(body) => body,
            _ => unreachable!(),
        }
    }

    async fn register(app: &App, id: &str, parent: Option<&str>) {
        types::register(app, &Caller::local(), definition(id, parent))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_reader_in_an_old_snapshot_keeps_its_catalog_and_does_not_replace_the_newer_one() {
        let (_dir, app) = started().await;
        let cache = app.catalog_handle();
        let (started_tx, started_rx) = mpsc::channel();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let reader = {
            let cache = cache.clone();
            let app = app.clone();
            tokio::spawn(async move {
                app.db
                    .read(move |tx| {
                        let before = generation(tx)?;
                        started_tx.send(()).ok();
                        go_rx.recv().ok();
                        let seen = current(&cache, tx, Snapshot::Committed)?;
                        Ok((
                            before,
                            seen.generation,
                            seen.types.get("acme.alpha").is_some(),
                        ))
                    })
                    .await
            })
        };
        tokio::task::spawn_blocking(move || started_rx.recv())
            .await
            .unwrap()
            .unwrap();
        register(&app, "acme.alpha", None).await;
        let published = cache.load().generation;
        go_tx.send(()).unwrap();
        let (before, saw, has_alpha) = reader.await.unwrap().unwrap();

        assert_eq!(saw, before);
        assert!(!has_alpha);
        assert_eq!(published, before + 1);
        assert_eq!(cache.load().generation, published);
        assert!(cache.load().types.get("acme.alpha").is_some());
    }

    #[tokio::test]
    async fn two_types_registered_in_a_row_are_both_in_the_catalog() {
        let (_dir, app) = started().await;
        let start = app.catalog_handle().load().generation;
        register(&app, "acme.alpha", None).await;
        register(&app, "acme.beta", Some("acme.alpha")).await;
        let held = app.catalog_handle().load_full();

        assert_eq!(held.generation, start + 2);
        assert!(held.types.get("acme.alpha").is_some() && held.types.get("acme.beta").is_some());
    }

    #[tokio::test]
    async fn a_rolled_back_registration_leaves_the_shared_catalog_and_the_next_generation_right() {
        let (_dir, app) = started().await;
        register(&app, "acme.alpha", None).await;
        let cache = app.catalog_handle();
        let published = cache.load().generation;

        let inner = cache.clone();
        let seen_inside = app
            .write(&Caller::local(), "type.register", move |unit| {
                let at = unit.at.as_str();
                unit.tx().execute(
                    "INSERT INTO types (id, origin, definition, created_at, updated_at) \
                     VALUES ('acme.ghost', 'user', ?1, ?2, ?2)",
                    params![
                        Value::Object(definition("acme.ghost", None)).to_string(),
                        at
                    ],
                )?;
                raise(unit.tx())?;
                let pending = current(&inner, unit.tx(), Snapshot::Pending)?;
                assert!(pending.types.get("acme.ghost").is_some());
                Err::<(), _>(Refusal::validation("not this time"))
            })
            .await;
        assert!(seen_inside.is_err());
        assert_eq!(cache.load().generation, published);
        assert!(cache.load().types.get("acme.ghost").is_none());

        register(&app, "acme.beta", None).await;
        let held = cache.load_full();
        assert_eq!(held.generation, published + 1);
        assert!(held.types.get("acme.beta").is_some() && held.types.get("acme.ghost").is_none());
        assert!(matches!(
            types::get(&app, "acme.ghost".into()).await,
            Err(refusal) if refusal.code == crate::app::refusal::Code::TypeNotFound
        ));
    }
}

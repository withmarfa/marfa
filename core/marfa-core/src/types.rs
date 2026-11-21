//! The types a copy checks writes against: the app's own declarations and the
//! server's catalog.

use std::collections::HashSet;
use std::sync::atomic::AtomicBool;

use serde_json::{Map, Value};

use crate::catalog::CatalogExt;
use crate::{
    Core, CoreError, EdgeType, ItemDisplay, ItemType, Result, ServerCatalog, catalog, catch_up,
    http, store,
};

impl Core {
    /// Declares the types the app saves under, each as the JSON a server
    /// lists a type as: its `id`, its `fields`, and whatever else a type
    /// carries. The call is the app's whole set: it replaces every earlier
    /// declaration, so a type the app no longer declares is no longer held to
    /// or registered. A copy that has never reached a server checks what it
    /// queues against these and the types Marfa ships, and a hydration
    /// registers on the instance the ones it does not hold, and replaces each
    /// one it holds in another definition, where the key may. An app declares
    /// only types under `app.`: a set that names another is refused `Invalid`.
    /// On a copy that holds a server's catalog the set waits for the next
    /// hydration. A set that names one id twice, or a `status` field with no
    /// words anywhere in its chain, or a table a server would refuse, or a
    /// field a type gives another shape than a type above it does, or a status
    /// word a type above it gives already, or two thumbnails, is refused
    /// `Invalid`.
    pub fn declare_types(&self, types: &[Value]) -> Result<()> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        // The ids of the whole set are known to each other, so a parent may
        // come after its child.
        let declared: Vec<String> = types
            .iter()
            .filter_map(|definition| definition.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        let known = |id: &str| {
            declared.iter().any(|held| held == id)
                || marfa_rules::builtin::ships(id).unwrap_or(false)
        };
        let mut rows = Vec::new();
        let mut seen = HashSet::new();
        for definition in types {
            let row = marfa_rules::catalog::declaration(definition, &known)?;
            marfa_rules::catalog::app_declaration(&row.0)?;
            if !seen.insert(row.0.clone()) {
                return Err(CoreError::Invalid(format!(
                    "{} is declared twice; a set declares each type once",
                    row.0
                )));
            }
            rows.push(row);
        }
        marfa_rules::catalog::refuse_wordless_status(types)?;
        if let Err(found) = marfa_rules::schema::declared_tables(types, &known)
            && let Some((id, issue)) = found.into_iter().next()
        {
            return Err(CoreError::Invalid(format!(
                "{id} declares tables that do not hold: {}: {}",
                issue.field,
                issue.message()
            )));
        }
        if let Some((id, found)) = marfa_rules::schema::declared_conflicts(types)
            .into_iter()
            .next()
        {
            return Err(CoreError::Invalid(format!("{id} declares {found}")));
        }
        // The same set again writes nothing, so a declaration at each launch
        // is no change to the copy (`changes_since`).
        let mut sorted = rows.clone();
        sorted.sort();
        if store::declared_type_rows(&tx)? != sorted {
            store::clear_declared_types(&tx)?;
            for (id, json) in &rows {
                store::declare_type(&tx, id, json)?;
            }
        }
        if store::never_synced(&tx)? {
            store::hold_local_catalog(&tx)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The types the app declared, by id, with the empty `fields` and the
    /// `version` a registration needs filled in where the app left them out.
    pub fn declared_types(&self) -> Result<Vec<Value>> {
        let conn = self.conn()?;
        store::declared_type_rows(&conn)?
            .into_iter()
            .map(|(id, json)| {
                serde_json::from_str(&json).map_err(|error| {
                    CoreError::Store(format!("the declared type {id} cannot be read: {error}"))
                })
            })
            .collect()
    }

    /// Every item type the copy holds, by id, read from the copy alone.
    /// Refused `NoCatalog` where the copy has never held a catalog.
    pub fn item_types(&self) -> Result<Vec<ItemType>> {
        catalog::item_types(&*self.conn()?)
    }

    /// Refused `NotFound` where the catalog holds no such type.
    pub fn item_type(&self, id: &str) -> Result<ItemType> {
        catalog::item_type(&*self.conn()?, id)
    }

    /// Each item's name and preview, in the order given, from its type's
    /// display hints in the catalog the copy holds; read from the copy
    /// alone. A type the catalog does not hold has no hints, so its items
    /// are named by the fallback fields.
    pub fn item_displays(
        &self,
        items: &[(Option<&str>, &str, &Map<String, Value>)],
    ) -> Result<Vec<ItemDisplay>> {
        let conn = self.conn()?;
        let catalog = crate::catalog::load(&conn)?;
        items
            .iter()
            .map(|(id, item_type, properties)| match id {
                Some(id) => catalog.display_held(&conn, id, item_type, properties),
                None => Ok(catalog.display(item_type, properties)),
            })
            .collect()
    }

    /// Every edge type the copy holds, by id, read from the copy alone.
    pub fn edge_types(&self) -> Result<Vec<EdgeType>> {
        catalog::edge_types(&*self.conn()?)
    }

    /// Refused `NotFound` where the catalog holds no such edge type.
    pub fn edge_type(&self, id: &str) -> Result<EdgeType> {
        catalog::edge_type(&*self.conn()?, id)
    }

    /// The server's item types and edge types, read from it now, so a caller
    /// can choose a slice before a first hydration. Does not hydrate the
    /// copy. Refused `NoServer` for a copy with no server, and ended with
    /// `Canceled` as soon as `stop` is raised.
    pub fn server_catalog_until(&self, stop: &AtomicBool) -> Result<ServerCatalog> {
        let listed = catch_up::ask_unless_stopped(stop, self.http()?, http::Http::catalog)?;
        catalog::served(&listed)
    }
}

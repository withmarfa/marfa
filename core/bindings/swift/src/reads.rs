//! Reads of many rows in one call, and the rows changed since a cursor.

use std::collections::HashMap;

use crate::{BodyLinks, Core, Edge, Listing, MarfaError, edge, listing};

/// What changed in the copy since a cursor `changes_since` gave.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CopyChanges {
    /// Where the next call starts from.
    pub cursor: String,
    /// True where the changes cannot be named one by one, and the four lists
    /// are empty: read the whole copy again.
    pub everything: bool,
    /// Each changed item the copy holds, in the bin or out.
    pub items: Vec<String>,
    /// Each changed item the copy no longer holds.
    pub removed_items: Vec<String>,
    /// Each changed edge the copy holds.
    pub edges: Vec<String>,
    /// Each changed edge the copy no longer holds.
    pub removed_edges: Vec<String>,
}

impl From<marfa_core::CopyChanges> for CopyChanges {
    fn from(changes: marfa_core::CopyChanges) -> Self {
        CopyChanges {
            cursor: changes.cursor,
            everything: changes.everything,
            items: changes.items,
            removed_items: changes.removed_items,
            edges: changes.edges,
            removed_edges: changes.removed_edges,
        }
    }
}

#[uniffi::export]
impl Core {
    /// `get` for each id, under one snapshot: each item the copy holds, once
    /// each, in the order named. An id the copy does not hold is left out,
    /// and so is an item in the bin unless `include_bin`.
    pub fn get_items(&self, ids: Vec<String>, include_bin: bool) -> Result<Listing, MarfaError> {
        Ok(listing(self.inner.get_items_kept(&ids, include_bin)?))
    }

    /// The edge the copy holds by `id`, or `nil`.
    pub fn edge(&self, id: String) -> Result<Option<Edge>, MarfaError> {
        Ok(self
            .inner
            .get_edge_kept(&id)?
            .map(|(held, why)| edge(held, why)))
    }

    /// Each edge the copy holds of `ids`, once each, in the order named.
    pub fn get_edges(&self, ids: Vec<String>) -> Result<Vec<Edge>, MarfaError> {
        Ok(self
            .inner
            .get_edges_kept(&ids)?
            .into_iter()
            .map(|(held, why)| edge(held, why))
            .collect())
    }

    /// `body_links` for each item the copy holds outside the bin and can
    /// read, by id; any other id is left out.
    pub fn body_links_of(
        &self,
        ids: Vec<String>,
    ) -> Result<HashMap<String, BodyLinks>, MarfaError> {
        Ok(self
            .inner
            .body_links_of(&ids)?
            .into_iter()
            .map(|(id, links)| (id, links.into()))
            .collect())
    }

    /// The items and edges changed since `cursor`, or `everything` where
    /// they cannot be named one by one, such as with no cursor or more than
    /// `most` changed. Throws `HydrationIncomplete` where the copy is not
    /// whole, as every read of edges does. Take the cursor before reading
    /// what it covers, and keep the earlier cursor until that read succeeds.
    pub fn changes_since(
        &self,
        cursor: Option<String>,
        most: u32,
    ) -> Result<CopyChanges, MarfaError> {
        Ok(self.inner.changes_since(cursor.as_deref(), most)?.into())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::{BodyTarget, Completeness, Core, MarfaError};

    fn seeded() -> (tempfile::TempDir, Arc<Core>, rusqlite::Connection) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.sqlite").display().to_string();
        let core = Core::open(path.clone(), None, None, None).unwrap();
        let db = rusqlite::Connection::open(path).unwrap();
        for (key, value) in [
            ("event_cursor", "10"),
            ("instance_id", "test-instance"),
            ("reach", &"a".repeat(64)),
            ("slice_types", r#"["core.note"]"#),
            ("slice_tier", "all"),
        ] {
            db.execute("INSERT OR REPLACE INTO meta VALUES (?1,?2)", [key, value])
                .unwrap();
        }
        for (id, state, title, body) in [
            ("a", "active", "Note a", "about [[Note b]]"),
            ("b", "active", "Note b", ""),
            ("binned", "trashed", "Binned", ""),
        ] {
            db.execute(
                "INSERT INTO items (id,type,state,tier,version,schema_version,source,occurred_at,created_at,updated_at,properties) VALUES (?1,'core.note',?2,'library',1,1,'test',?3,?3,?3,?4)",
                rusqlite::params![
                    id,
                    state,
                    "2026-01-01T00:00:00Z",
                    serde_json::json!({ "title": title, "body": body }).to_string()
                ],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO edges (id,source_id,target_id,edge_type,properties,version,created_at,updated_at) VALUES ('ab','a','b','references','{}',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        (dir, core, db)
    }

    fn ids(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn the_batch_reads_cross_the_swift_boundary() {
        let (_dir, core, _db) = seeded();
        let listed = core
            .get_items(ids(&["b", "gone", "binned", "a"]), false)
            .unwrap();
        assert_eq!(listed.completeness, Completeness::Complete);
        let held: Vec<&str> = listed.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(held, ["b", "a"]);
        let with_bin = core.get_items(ids(&["binned"]), true).unwrap();
        assert_eq!(with_bin.items[0].id, "binned");

        assert_eq!(core.edge("ab".into()).unwrap().unwrap().target_id, "b");
        assert!(core.edge("gone".into()).unwrap().is_none());
        assert_eq!(core.get_edges(ids(&["gone", "ab"])).unwrap().len(), 1);

        let links = core.body_links_of(ids(&["a", "binned", "gone"])).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links["a"], core.body_links("a".into()).unwrap());
        assert_eq!(
            links["a"].links[0].target,
            BodyTarget::Item { id: "b".into() }
        );
    }

    #[test]
    fn changes_since_crosses_with_a_cursor_to_pass_back() {
        let (_dir, core, db) = seeded();
        let first = core.changes_since(None, 100).unwrap();
        assert!(first.everything);
        let quiet = core.changes_since(Some(first.cursor.clone()), 100).unwrap();
        assert!(!quiet.everything);
        assert!(quiet.items.is_empty());
        db.execute("UPDATE items SET version = 2 WHERE id = 'b'", [])
            .unwrap();
        db.execute("DELETE FROM edges WHERE id = 'ab'", []).unwrap();

        let changed = core.changes_since(Some(quiet.cursor), 100).unwrap();
        assert!(changed.items.contains(&"b".to_string()));
        assert_eq!(changed.removed_edges, ["ab"]);
        assert!(matches!(
            core.changes_since(Some("not a cursor".into()), 100),
            Err(MarfaError::Invalid { .. })
        ));
    }
}

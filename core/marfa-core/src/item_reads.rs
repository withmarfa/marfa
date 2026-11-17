//! Reads of items, edges and search results, in the copy or kept past a trim,
//! and the copy's state report.

use std::collections::HashMap;

use serde_json::Value;

use crate::catalog::CatalogExt;
use crate::edge_writes::conflicted_copies_in;
#[cfg(debug_assertions)]
use crate::fault;
use crate::{
    BinPage, BodyLinks, CONFLICTED_COPY_EDGE, CONFLICTED_COPY_TAG, Core, CoreError, Edge,
    Hydration, Item, LinkCandidates, ListFilters, Result, Rows, SearchFilters, SearchHit, Shown,
    Sort, Status, Thumbnail, body, query, search, store, telemetry,
};

impl Core {
    /// Moves each time another process saves to this store.
    pub fn data_version(&self) -> Result<i64> {
        #[cfg(debug_assertions)]
        if fault::fails(|| "data-version") {
            return Err(CoreError::Store("the data version cannot be read".into()));
        }
        store::data_version(&*self.conn()?)
    }

    /// Answered part way through a hydration from the rows that have arrived,
    /// marked `Partial`.
    ///
    /// Left unnamed, the order is the server's: newest created first, oldest
    /// changed first where `updated_after` is named, or newest binned first
    /// for the bin alone.
    pub fn list(&self, filters: &ListFilters, sort: impl Into<Option<Sort>>) -> Result<Rows<Item>> {
        let sort = sort.into();
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let catalog = crate::catalog::load(conn)?;
            Ok(Rows {
                rows: query::list(conn, &catalog, filters, sort.clone())?,
                completeness,
            })
        })
    }

    /// Every item the copy holds, listed by the server or not, as a pass
    /// over the copy reads them. Answered as `list` answers.
    pub(crate) fn held_items(&self) -> Result<Rows<Item>> {
        let filters = ListFilters {
            all_states: true,
            ..Default::default()
        };
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            Ok(Rows {
                rows: query::list_where(conn, &[], &[], Sort::unnamed(&filters), None, None)?,
                completeness,
            })
        })
    }

    /// `list`, each item with the title and body it shows (`Catalog::shown`),
    /// all read under one snapshot of the catalog.
    pub fn list_shown(
        &self,
        filters: &ListFilters,
        sort: impl Into<Option<Sort>>,
    ) -> Result<Rows<(Item, Shown)>> {
        self.list_shown_with(filters, sort.into(), &mut store::Unreadable::Refuse)
    }

    /// `list_shown`, but a row whose stored properties cannot be read stays
    /// in the answer with no properties, and its `Shown` says why.
    pub fn list_kept(
        &self,
        filters: &ListFilters,
        sort: impl Into<Option<Sort>>,
    ) -> Result<Rows<(Item, Shown)>> {
        self.list_shown_with(
            filters,
            sort.into(),
            &mut store::Unreadable::Keep(HashMap::new()),
        )
    }

    fn list_shown_with(
        &self,
        filters: &ListFilters,
        sort: Option<Sort>,
        unreadable: &mut store::Unreadable,
    ) -> Result<Rows<(Item, Shown)>> {
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let catalog = crate::catalog::load(conn)?;
            let items = query::list_with(conn, &catalog, filters, sort.clone(), unreadable)?;
            Ok(Rows {
                rows: items,
                completeness,
            }
            .map(|item| {
                let shown = catalog.shown_unreadable(&item, unreadable);
                (item, shown)
            }))
        })
    }

    /// `None` only where the copy is whole: part way through a hydration, a
    /// row that has not arrived is refused `HydrationIncomplete`.
    pub fn get(&self, id: &str) -> Result<Option<Item>> {
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            store::held_or_refused(store::item_by_id(conn, id)?, completeness)
        })
    }

    /// `get`, with the title and body the item shows.
    pub fn get_shown(&self, id: &str) -> Result<Option<(Item, Shown)>> {
        self.get_shown_with(id, &mut store::Unreadable::Refuse)
    }

    /// `get_shown`, but a row whose stored properties cannot be read is
    /// answered with no properties, and its `Shown` says why.
    pub fn get_kept(&self, id: &str) -> Result<Option<(Item, Shown)>> {
        self.get_shown_with(id, &mut store::Unreadable::Keep(HashMap::new()))
    }

    fn get_shown_with(
        &self,
        id: &str,
        unreadable: &mut store::Unreadable,
    ) -> Result<Option<(Item, Shown)>> {
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let found = store::item_by_id_with(conn, id, unreadable)?;
            let Some(item) = store::held_or_refused(found, completeness)? else {
                return Ok(None);
            };
            let catalog = crate::catalog::load(conn)?;
            let shown = catalog.shown_unreadable(&item, unreadable);
            Ok(Some((item, shown)))
        })
    }

    /// An item the copy does not hold is refused `NotFound`, never answered
    /// `None`, and refused `HydrationIncomplete` part way through a
    /// hydration. A held value that is not a data URI (one written before its
    /// type declared the property) is refused `Decoding`, naming the item.
    pub fn thumbnail(&self, id: &str) -> Result<Option<Thumbnail>> {
        let (item, catalog) = store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let found = store::item_by_id(conn, id)?;
            let Some(item) = store::held_or_refused(found, completeness)? else {
                return Err(CoreError::not_held(format!(
                    "{id} is not held in this working copy"
                )));
            };
            Ok((item, crate::catalog::load(conn)?))
        })?;
        let Some(field) = catalog.thumbnail_field(&item.r#type) else {
            return Ok(None);
        };
        match item.properties.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(uri)) => Thumbnail::from_data_uri(uri).map(Some).map_err(|error| {
                match CoreError::from(error) {
                    CoreError::Decoding(reason) => CoreError::Decoding(format!("{id}: {reason}")),
                    other => other,
                }
            }),
            Some(other) => {
                let held = match other {
                    Value::Bool(_) => "a boolean",
                    Value::Number(_) => "a number",
                    Value::Array(_) => "an array",
                    _ => "an object",
                };
                Err(CoreError::Decoding(format!(
                    "{id}: its {field} holds {held}, where a thumbnail is a data URI"
                )))
            }
        }
    }

    pub fn edges_from(&self, id: &str) -> Result<Vec<Edge>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        store::edges_from(&conn, id)
    }

    pub fn edges_to(&self, id: &str) -> Result<Vec<Edge>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        store::edges_to(&conn, id)
    }

    /// Answered or still queued, oldest first.
    pub fn edges_of_type(&self, edge_type: &str) -> Result<Vec<Edge>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        store::edges_of_type(&conn, edge_type)
    }

    /// `edges_from`, but an edge whose stored properties cannot be read stays
    /// in the answer with no properties, beside why.
    pub fn edges_from_kept(&self, id: &str) -> Result<Vec<(Edge, Option<String>)>> {
        self.edges_kept("from_id", id)
    }

    /// `edges_to`, keeping an edge whose stored properties cannot be read as
    /// `edges_from_kept` does.
    pub fn edges_to_kept(&self, id: &str) -> Result<Vec<(Edge, Option<String>)>> {
        self.edges_kept("to_id", id)
    }

    /// `edges_of_type`, keeping an edge whose stored properties cannot be
    /// read as `edges_from_kept` does.
    pub fn edges_of_type_kept(&self, edge_type: &str) -> Result<Vec<(Edge, Option<String>)>> {
        self.edges_kept("edge_type", edge_type)
    }

    fn edges_kept(&self, column: &'static str, value: &str) -> Result<Vec<(Edge, Option<String>)>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        let mut unreadable = store::Unreadable::Keep(HashMap::new());
        let edges = store::edges_at(&conn, column, value, &mut unreadable)?;
        Ok(edges
            .into_iter()
            .map(|edge| {
                let why = unreadable.why(&edge.id);
                (edge, why)
            })
            .collect())
    }

    /// The id of the item a conflicted copy was made from: the target of its
    /// `derived-from` edge, where `id` is a held row outside the bin tagged
    /// `conflicted-copy`. `None` for any other row, and for one the copy does
    /// not hold. The original itself may be a row the copy does not hold.
    pub fn original_of_conflicted_copy(&self, id: &str) -> Result<Option<String>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        let Some(copy) = store::item_by_id(&conn, id)? else {
            return Ok(None);
        };
        if !copy.tags.iter().any(|tag| tag == CONFLICTED_COPY_TAG) {
            return Ok(None);
        }
        Ok(store::edges_from(&conn, id)?
            .into_iter()
            .find(|edge| edge.edge_type == CONFLICTED_COPY_EDGE)
            .map(|edge| edge.to_id))
    }

    /// The held conflicted copies made from `id`, oldest link first: rows
    /// outside the bin tagged `conflicted-copy` whose `derived-from` edge
    /// names it. `id` need not be a row the copy holds.
    pub fn conflicted_copies_of(&self, id: &str) -> Result<Vec<Item>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        conflicted_copies_in(&conn, id, &mut store::Unreadable::Refuse)
    }

    /// `conflicted_copies_of`, each copy with the title and body it shows, and
    /// a copy whose stored properties cannot be read kept with no properties,
    /// its `Shown` saying why.
    pub fn conflicted_copies_kept(&self, id: &str) -> Result<Vec<(Item, Shown)>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        let mut unreadable = store::Unreadable::Keep(HashMap::new());
        let copies = conflicted_copies_in(&conn, id, &mut unreadable)?;
        let catalog = crate::catalog::load(&conn)?;
        Ok(copies
            .into_iter()
            .map(|item| {
                let shown = catalog.shown_unreadable(&item, &unreadable);
                (item, shown)
            })
            .collect())
    }

    /// Best match first. Answered part way through a hydration as `list` is.
    pub fn search(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
    ) -> Result<Rows<SearchHit>> {
        self.find(query, filters, limit, &mut store::Unreadable::Refuse)
            .map(|(_, hits)| hits)
    }

    /// The hits for `search` and the catalog they were found under.
    fn find(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
        unreadable: &mut store::Unreadable,
    ) -> Result<(marfa_rules::catalog::Catalog, Rows<SearchHit>)> {
        let op = telemetry::operation!("search", hits);
        let result = self.find_in_copy(query, filters, limit, unreadable);
        telemetry::ended!(op, result.as_ref(), |found| {
            outcome = "ok",
            hits = found.1.rows.len(),
        });
        result
    }

    fn find_in_copy(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
        unreadable: &mut store::Unreadable,
    ) -> Result<(marfa_rules::catalog::Catalog, Rows<SearchHit>)> {
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let catalog = crate::catalog::load(conn)?;
            let rows = search::search(conn, &catalog, query, filters, limit, unreadable)?;
            Ok((catalog, Rows { rows, completeness }))
        })
    }

    /// `search`, each hit's item with the title and body it shows, under one
    /// snapshot of the catalog.
    pub fn search_shown(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
    ) -> Result<Rows<(SearchHit, Shown)>> {
        self.search_shown_with(query, filters, limit, &mut store::Unreadable::Refuse)
    }

    /// `search_shown`, but a hit whose item's stored properties cannot be
    /// read stays in the answer with no properties, and its `Shown` says why.
    pub fn search_kept(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
    ) -> Result<Rows<(SearchHit, Shown)>> {
        self.search_shown_with(
            query,
            filters,
            limit,
            &mut store::Unreadable::Keep(HashMap::new()),
        )
    }

    fn search_shown_with(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
        unreadable: &mut store::Unreadable,
    ) -> Result<Rows<(SearchHit, Shown)>> {
        let (catalog, hits) = self.find(query, filters, limit, unreadable)?;
        Ok(hits.map(|hit| {
            let shown = catalog.shown_unreadable(&hit.item, unreadable);
            (hit, shown)
        }))
    }

    /// Each link and embed of a file in the item's body, with the item it
    /// names or why it names none, read from the copy alone.
    pub fn body_links(&self, id: &str) -> Result<BodyLinks> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        body::rule::read(&conn, id)
    }

    /// What each link target, the text between a link's brackets, could
    /// name, from the copy alone: in `item`'s body where one is given, as
    /// saving the link there would bind it.
    pub fn link_candidates(
        &self,
        item: Option<&str>,
        targets: &[String],
    ) -> Result<Vec<LinkCandidates>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        body::rule::candidates(&conn, item, targets)
    }

    /// The text that embeds the file item `file` in `host`'s body, which
    /// names that file alone; refused where none can.
    pub fn embed_text(&self, host: &str, file: &str) -> Result<String> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        body::rule::embed_text(&conn, host, file)
    }

    /// A page of the server's bin, newest binned first, read online and held
    /// nowhere in the copy (`device/bin-read`, `device/bin-unheld` and `device/bin-offline`). Refused with what was met
    /// where the server cannot be read, and `NoServer` for a copy with none.
    pub fn bin(&self, r#type: Option<&str>, cursor: Option<&str>, limit: u32) -> Result<BinPage> {
        let page = self
            .http()?
            .bin_page(r#type, None, cursor, limit.clamp(1, 100))?;
        let catalog = crate::catalog::load(&*self.conn()?)?;
        let mut items = Vec::with_capacity(page.data.len());
        for row in page.data {
            let item = Item::from_wire(row.item, row.metadata.tags)?;
            let shown = catalog.shown(&item);
            items.push((item, shown));
        }
        Ok(BinPage {
            items,
            next_cursor: page.next_cursor,
        })
    }

    pub fn status(&self) -> Result<Status> {
        // One snapshot: a hydration another handle completes between two
        // reads would pair `in_progress` with counts it has already cleared.
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let slice_types = match store::meta_get(&tx, store::META_SLICE_TYPES)? {
            Some(json) => serde_json::from_str(&json)?,
            None => Vec::new(),
        };
        let slice_tier = match store::meta_get(&tx, store::META_SLICE_TIER)? {
            Some(text) => Some(store::slice_tier(&text)?),
            None => None,
        };
        let event_cursor = store::meta_get(&tx, store::META_EVENT_CURSOR)?;
        let hydration = if store::refilling(&tx)? {
            Hydration::Stale
        } else if !store::hydration_complete(&tx)? {
            Hydration::InProgress
        } else if store::hydrated(&tx)? {
            Hydration::Complete
        } else if store::holds_slice(&tx)? {
            // A slice and no cursor, reach or instance, and no refill owed.
            Hydration::Expired
        } else {
            Hydration::Never
        };
        let filling = |key| -> Result<Option<u64>> {
            Ok(match hydration {
                // A stale copy holds these only while its refill runs or
                // was interrupted.
                Hydration::InProgress | Hydration::Stale => {
                    store::meta_get(&tx, key)?.and_then(|count| count.parse().ok())
                }
                _ => None,
            })
        };
        let status = Status {
            server_origin: store::meta_get(&tx, store::META_SERVER_ORIGIN)?,
            instance_id: store::meta_get(&tx, store::META_INSTANCE_ID)?,
            slice_types,
            slice_tier,
            slice_edge_types: store::whole_edge_types(&tx)?,
            slice_query: store::slice_query(&tx)?,
            pinned: store::pins(&tx)?,
            event_cursor,
            hydration,
            items: store::count(&tx, "items")?,
            items_expected: filling(store::META_ITEMS_EXPECTED)?,
            items_listed: filling(store::META_ITEMS_LISTED)?,
            edges: store::count(&tx, "edges")?,
            catalog_version: store::catalog_version(&tx)?,
            synced_at: store::meta_get(&tx, store::META_SYNCED_AT)?,
            file_cache: self.file_cache_with(&tx)?,
        };
        tx.commit()?;
        Ok(status)
    }
}

//! What a slice holds beyond its types and tier: the states, filter and
//! `beneath` of the query a folder shows, compiled once to SQL on `items`, so
//! that the rows a copy holds and the files a folder writes cannot drift
//! apart.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Result;
use crate::error::CoreError;
use crate::model::ItemState;
use marfa_rules::catalog::Catalog;
use marfa_rules::query::{StateFault, check_states};

/// A slice with a query also takes the conflicted copies of the types and
/// tier it takes, whatever the filter says, so a conflict made by a write
/// to a member stays in reach of the copy that made it.
pub(crate) const CONFLICTED_COPY_LISTING: &str = "tags=conflicted-copy";

/// The events that move a row between states and change nothing else of
/// it a query reads but its state, `updated_at` and `version`.
const MOVES: [&str; 3] = ["item.deleted", "item.restored", "item.state_changed"];

/// The member states of a query that names none.
const DEFAULT_STATES: [ItemState; 2] = [ItemState::Active, ItemState::Archived];

/// The order states are kept and sent in, so two queries naming the same
/// states compare equal.
const STATE_ORDER: [ItemState; 3] = [ItemState::Active, ItemState::Archived, ItemState::Trashed];

/// A narrowing of a slice past its types and tier. A slice with none holds
/// every row of its types and tier, in every state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SliceQuery {
    /// The member states: `active`, `archived` or both. `None` is both.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub states: Option<Vec<String>>,
    /// The listing grammar's filter expression.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    /// An item id whose `parent-of` descendants, and itself, are the members.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beneath: Option<String>,
}

/// The keys a server listing narrowed by a query sends.
#[derive(Clone)]
pub(crate) struct Listing {
    /// Comma-separated, as `GET /items` takes it.
    pub state: String,
    pub filter: Option<String>,
    pub beneath: Option<String>,
    pub tags: Option<&'static str>,
}

impl SliceQuery {
    pub fn check(&self) -> Result<()> {
        if let Some(states) = &self.states {
            check_states(states).map_err(|fault| match fault {
                StateFault::Empty => CoreError::Invalid(
                    "a slice's query names no state, so it would hold nothing".into(),
                ),
                StateFault::Unknown(index) => CoreError::Invalid(format!(
                    "a slice's query holds active and archived items, and names {:?}",
                    states[index]
                )),
            })?;
        }
        if let Some(filter) = &self.filter {
            crate::filter::check(filter)?;
        }
        if self.beneath.as_deref().is_some_and(str::is_empty) {
            return Err(CoreError::Invalid(
                "a slice's query searches beneath an empty id".into(),
            ));
        }
        Ok(())
    }

    fn member_states(&self) -> Vec<&'static str> {
        STATE_ORDER
            .into_iter()
            .filter(|state| match &self.states {
                None => DEFAULT_STATES.contains(state),
                Some(named) => named.iter().any(|named| named == state.as_str()),
            })
            .map(ItemState::as_str)
            .collect()
    }

    /// The member states and the bin: a member trashed stays in the copy, so
    /// its file's departure and its restore are told as they are today.
    fn listed_states(&self) -> Vec<&'static str> {
        let mut states = self.member_states();
        states.push(ItemState::Trashed.as_str());
        states
    }

    /// Whether a filter term needs edges or another row, which a copy is
    /// not narrowed by: a row's place under `beneath` follows `parent-of`
    /// alone, which the copy holds whole, but an `edge`, `backref` or `part`
    /// term reads edges and rows it may not hold.
    pub(crate) fn relational(&self) -> Result<bool> {
        Ok(match &self.filter {
            Some(filter) => crate::filter::reads(filter)?.relational,
            None => false,
        })
    }

    pub(crate) fn reads_status(&self) -> Result<bool> {
        Ok(match &self.filter {
            Some(filter) => crate::filter::reads(filter)?.status,
            None => false,
        })
    }

    /// Whether an event of `kind` that leaves a row in `state` can bring
    /// into a copy narrowed by this query a row the copy did not hold, where
    /// the copy held every row it took before the event. A move between
    /// states leaves the row's properties and tags as they were, so it can
    /// only where the row is now in a state the copy holds and either the
    /// copy leaves out a state the row may have moved from or the filter
    /// reads what a move writes. Any other event can.
    pub(crate) fn move_may_take(&self, kind: &str, state: &str) -> Result<bool> {
        if !MOVES.contains(&kind) {
            return Ok(true);
        }
        let listed = self.listed_states();
        if !listed.contains(&state) {
            return Ok(false);
        }
        let every = STATE_ORDER
            .iter()
            .all(|held| listed.contains(&held.as_str()));
        Ok(!every
            || match &self.filter {
                Some(filter) => crate::filter::reads(filter)?.moved,
                None => false,
            })
    }

    /// The narrowing a copy holds for this query: its states always named,
    /// in one order, its `beneath`, and its filter only where it needs no
    /// edges or another row, since a copy cannot yet be narrowed by them.
    /// `None` where that narrows nothing, so a copy of the query holds what
    /// a copy of its types and tier always has.
    pub(crate) fn for_copy(&self) -> Result<Option<SliceQuery>> {
        let member = self.member_states();
        let filter = if self.relational()? {
            None
        } else {
            self.filter.clone()
        };
        if filter.is_none()
            && self.beneath.is_none()
            && member == DEFAULT_STATES.map(ItemState::as_str)
        {
            return Ok(None);
        }
        Ok(Some(SliceQuery {
            states: Some(member.into_iter().map(str::to_string).collect()),
            filter,
            beneath: self.beneath.clone(),
        }))
    }

    /// What the query shows, as clauses on `items`: its member states,
    /// filter and `beneath`.
    pub(crate) fn narrow(
        &self,
        catalog: &Catalog,
        whole: &[String],
        clauses: &mut Vec<String>,
        values: &mut Vec<Value>,
    ) -> Result<()> {
        push_states(&self.member_states(), clauses, values);
        crate::filter::narrow(
            self.filter.as_deref(),
            self.beneath.as_deref(),
            whole,
            catalog,
            clauses,
            values,
        )
    }

    /// What a copy narrowed by this query takes of the rows its types and
    /// tier take, as clauses on `items`: a member, in the bin or not, and a
    /// conflicted copy in one of those states.
    ///
    /// The query's `beneath` is answered by the reach the last settle wrote
    /// (`beneath_reach`), not by the edges held now, so a row is held by the
    /// same answer from one settle to the next whatever order the edges
    /// between them arrive in.
    pub(crate) fn takes(
        &self,
        catalog: &Catalog,
        whole: &[String],
        clauses: &mut Vec<String>,
        values: &mut Vec<Value>,
    ) -> Result<()> {
        push_states(&self.listed_states(), clauses, values);
        let mut narrowing = Vec::new();
        crate::filter::narrow(
            self.filter.as_deref(),
            None,
            whole,
            catalog,
            &mut narrowing,
            values,
        )?;
        if self.beneath.is_some() {
            narrowing.push("items.id IN (SELECT id FROM beneath_reach)".into());
        }
        if !narrowing.is_empty() {
            values.push(Value::String(crate::CONFLICTED_COPY_TAG.into()));
            clauses.push(format!(
                "(({}) OR EXISTS (SELECT 1 FROM tags WHERE tags.item_id = items.id AND +tags.tag = ?))",
                narrowing.join(" AND ")
            ));
        }
        Ok(())
    }

    /// Whether a copy narrowed by this query holds every member of `asked`:
    /// where it narrows by states alone and holds each state `asked` names,
    /// or where it holds the narrowing a copy of `asked` would.
    pub(crate) fn covers(&self, asked: &SliceQuery) -> Result<bool> {
        if self.filter.is_none() && self.beneath.is_none() {
            let held = self.member_states();
            return Ok(asked
                .member_states()
                .iter()
                .all(|state| held.contains(state)));
        }
        Ok(asked.for_copy()?.as_ref() == Some(self))
    }

    /// Whether the copy lists its conflicted copies apart: only a filter or
    /// `beneath` leaves them out of the main listing.
    pub(crate) fn lists_conflicted_apart(&self) -> bool {
        self.filter.is_some() || self.beneath.is_some()
    }

    pub(crate) fn listing(&self, conflicted: bool) -> Listing {
        Listing {
            state: self.listed_states().join(","),
            filter: (!conflicted).then(|| self.filter.clone()).flatten(),
            beneath: (!conflicted).then(|| self.beneath.clone()).flatten(),
            tags: conflicted.then_some(crate::CONFLICTED_COPY_TAG),
        }
    }
}

fn push_states(states: &[&str], clauses: &mut Vec<String>, values: &mut Vec<Value>) {
    clauses.push(format!(
        "items.state IN ({})",
        vec!["?"; states.len()].join(", ")
    ));
    values.extend(states.iter().map(|state| Value::String((*state).into())));
}

/// How a query is read of one row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reading {
    /// Whether the folder shows the row (`SliceQuery::narrow`).
    Shows,
    /// Whether a copy narrowed by the query holds the row
    /// (`SliceQuery::takes`).
    Holds,
}

/// Clauses on `items` and the values they bind, judged before the query:
/// a folder's types and tier, or nothing where the slice judges them.
pub(crate) type Scope = (Vec<String>, Vec<Value>);

/// Whether the row held under `id` meets `scope` and `query`, read as
/// `reading`. `false` where the copy holds no such row. Edge terms are
/// answered on the edge types the copy holds whole, as every other read of
/// the copy answers them.
pub(crate) fn judge_held(
    conn: &rusqlite::Connection,
    catalog: &Catalog,
    query: &SliceQuery,
    reading: Reading,
    scope: Scope,
    id: &str,
) -> Result<bool> {
    let (mut clauses, mut values) = scope;
    clauses.push("items.id = ?".into());
    values.push(Value::String(id.into()));
    let whole = crate::store::whole_edge_types(conn)?;
    match reading {
        Reading::Shows => query.narrow(catalog, &whole, &mut clauses, &mut values)?,
        Reading::Holds => query.takes(catalog, &whole, &mut clauses, &mut values)?,
    }
    let sql = format!(
        "SELECT EXISTS (SELECT 1 FROM items WHERE {})",
        clauses.join(" AND ")
    );
    let bound: Vec<rusqlite::types::Value> = values.iter().map(crate::store::sql_value).collect();
    Ok(conn.query_row(&sql, rusqlite::params_from_iter(bound), |row| row.get(0))?)
}

/// `judge_held` on the row `stage` writes, in a transaction that is rolled
/// back whatever happens, so the copy is as it was. `stage` answers the id
/// of the row it wrote; `None` where it wrote none, and nothing is judged.
/// `conn` must not be in a transaction.
pub(crate) fn judge_staged(
    conn: &rusqlite::Connection,
    catalog: &Catalog,
    query: &SliceQuery,
    reading: Reading,
    scope: Scope,
    stage: impl FnOnce(&rusqlite::Connection) -> Result<Option<String>>,
) -> Result<Option<bool>> {
    let trial = conn.unchecked_transaction()?;
    let Some(id) = stage(&trial)? else {
        return Ok(None);
    };
    let judged = judge_held(&trial, catalog, query, reading, scope, &id)?;
    trial.rollback()?;
    Ok(Some(judged))
}

/// The ids a settle of `beneath` reaches under `root` by the edges held now
/// (`store::beneath_edges`): `root` and every id under it, held as a row or
/// not. `UNION` ends the walk on a cycle, as `filter::beneath_walk` does.
pub(crate) fn beneath_ids(
    conn: &rusqlite::Connection,
    root: &str,
) -> Result<std::collections::HashSet<String>> {
    let mut statement = conn.prepare_cached(&format!(
        "WITH RECURSIVE down(id) AS (
           SELECT ?1
           UNION
           SELECT edges.target_id FROM edges JOIN down ON edges.source_id = down.id
           WHERE edges.edge_type = '{}' AND {}
         ) SELECT id FROM down",
        crate::filter::PARENT_OF,
        crate::store::beneath_edges(conn)?,
    ))?;
    let ids = statement
        .query_map([root], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::store;

    fn query(states: Option<&[&str]>, filter: Option<&str>) -> SliceQuery {
        SliceQuery {
            states: states.map(|states| states.iter().map(|s| s.to_string()).collect()),
            filter: filter.map(str::to_string),
            beneath: None,
        }
    }

    impl SliceQuery {
        fn with_states(self, states: Option<&[&str]>) -> SliceQuery {
            SliceQuery {
                states: states.map(|states| states.iter().map(|s| s.to_string()).collect()),
                ..self
            }
        }
    }

    fn held(conn: &rusqlite::Connection, id: &str, state: &str, tags: &[&str], props: Value) {
        let item = store::testing::wire_item(id, "core.note", state, "2026-01-01T00:00:00Z", props);
        let tags: Vec<String> = tags.iter().map(|tag| tag.to_string()).collect();
        let catalog = crate::catalog::load(conn).unwrap();
        store::put_server_item(conn, &item, Some(&tags), &catalog).unwrap();
    }

    fn takes(conn: &rusqlite::Connection, query: &SliceQuery, id: &str) -> bool {
        let catalog = crate::catalog::load(conn).unwrap();
        judge_held(conn, &catalog, query, Reading::Holds, Scope::default(), id).unwrap()
    }

    #[test]
    fn states_take_members_and_the_bin_and_leave_the_rest() {
        let conn = store::open_in_memory().unwrap();
        held(&conn, "a", "active", &[], json!({}));
        held(&conn, "b", "archived", &[], json!({}));
        held(&conn, "t", "trashed", &[], json!({}));
        held(&conn, "r", "revoked", &[], json!({}));
        let active = query(Some(&["active"]), None);
        assert!(takes(&conn, &active, "a"));
        assert!(!takes(&conn, &active, "b"));
        assert!(takes(&conn, &active, "t"));
        assert!(!takes(&conn, &active, "r"));
        let default = query(None, None);
        assert!(takes(&conn, &default, "b"));
        assert!(!takes(&conn, &default, "r"));
        assert!(!takes(&conn, &default, "missing"));
    }

    #[test]
    fn a_tag_filter_takes_tagged_rows_and_conflicted_copies() {
        let conn = store::open_in_memory().unwrap();
        held(&conn, "work", "active", &["work"], json!({}));
        held(&conn, "home", "active", &["home"], json!({}));
        held(
            &conn,
            "copy",
            "active",
            &[crate::CONFLICTED_COPY_TAG],
            json!({}),
        );
        held(&conn, "binned", "trashed", &["work"], json!({}));
        held(
            &conn,
            "gone",
            "revoked",
            &[crate::CONFLICTED_COPY_TAG],
            json!({}),
        );
        let work = query(None, Some("tags contains \"work\""));
        assert!(takes(&conn, &work, "work"));
        assert!(!takes(&conn, &work, "home"));
        assert!(takes(&conn, &work, "copy"));
        assert!(takes(&conn, &work, "binned"));
        assert!(!takes(&conn, &work, "gone"));
    }

    #[test]
    fn a_property_filter_reads_the_held_properties() {
        let conn = store::open_in_memory().unwrap();
        held(&conn, "done", "active", &[], json!({"done": true}));
        held(&conn, "open", "active", &[], json!({"done": false}));
        let done = query(None, Some("properties.done eq true"));
        assert!(takes(&conn, &done, "done"));
        assert!(!takes(&conn, &done, "open"));
    }

    #[test]
    fn a_relational_query_keeps_only_its_states_for_the_copy() {
        let edge = query(Some(&["archived", "active"]), Some("edge[cites] exists"));
        assert!(edge.relational().unwrap());
        assert_eq!(edge.for_copy().unwrap(), None);
        let archived = query(Some(&["archived"]), Some("edge[cites] exists"));
        assert_eq!(
            archived.for_copy().unwrap(),
            Some(query(Some(&["archived"]), None))
        );
        assert_eq!(query(None, None).for_copy().unwrap(), None);
        let tags = query(None, Some("tags contains \"work\""));
        assert!(!tags.relational().unwrap());
        assert_eq!(
            tags.for_copy().unwrap(),
            Some(query(
                Some(&["active", "archived"]),
                Some("tags contains \"work\"")
            ))
        );
    }

    #[test]
    fn a_copy_keeps_beneath_with_its_filter_and_without_a_relational_one() {
        let under = |filter: Option<&str>| SliceQuery {
            beneath: Some("root".into()),
            ..query(None, filter)
        };
        let both = Some(&["active", "archived"][..]);
        assert!(!under(None).relational().unwrap());
        assert_eq!(
            under(None).for_copy().unwrap(),
            Some(SliceQuery {
                beneath: Some("root".into()),
                ..query(both, None)
            })
        );
        assert_eq!(
            under(Some("tags contains \"work\"")).for_copy().unwrap(),
            Some(under(Some("tags contains \"work\"")).with_states(both))
        );
        assert_eq!(
            under(Some("edge[cites] exists")).for_copy().unwrap(),
            Some(under(None).with_states(both)),
            "an edge term is dropped, the subtree is kept"
        );
    }

    #[test]
    fn the_listing_sends_beneath_but_not_beside_the_conflicted_copies() {
        let under = SliceQuery {
            beneath: Some("root".into()),
            ..query(None, None)
        };
        assert_eq!(under.listing(false).beneath.as_deref(), Some("root"));
        assert_eq!(under.listing(true).beneath, None);
        assert!(under.lists_conflicted_apart());
    }

    #[test]
    fn the_listing_sends_the_states_with_the_bin_and_the_filter() {
        let work = query(Some(&["active"]), Some("tags contains \"work\""));
        let main = work.listing(false);
        assert_eq!(main.state, "active,trashed");
        assert_eq!(main.filter.as_deref(), Some("tags contains \"work\""));
        assert_eq!(main.tags, None);
        let conflicted = work.listing(true);
        assert_eq!(conflicted.state, "active,trashed");
        assert_eq!(conflicted.filter, None);
        assert_eq!(conflicted.tags, Some(crate::CONFLICTED_COPY_TAG));
        assert!(work.lists_conflicted_apart());
        assert!(!query(None, None).lists_conflicted_apart());
    }

    #[test]
    fn a_copy_covers_queries_it_holds_every_member_of() {
        let wide = query(Some(&["active", "archived"]), None);
        let active = query(Some(&["active"]), None);
        let work = query(None, Some("tags contains \"work\""));
        assert!(wide.covers(&active).unwrap());
        assert!(wide.covers(&work).unwrap());
        assert!(!active.covers(&wide).unwrap());
        let held = work.for_copy().unwrap().unwrap();
        assert!(held.covers(&work).unwrap());
        assert!(
            !held
                .covers(&query(None, Some("tags contains \"home\"")))
                .unwrap()
        );
        assert!(!held.covers(&wide).unwrap());
        let edge = query(None, Some("edge[cites] exists"));
        assert!(wide.covers(&edge).unwrap());
    }

    #[test]
    fn a_move_takes_a_row_only_where_the_copy_may_not_have_held_it() {
        let every = query(None, Some("tags contains \"x\""));
        assert!(every.move_may_take("item.updated", "active").unwrap());
        assert!(!every.move_may_take("item.deleted", "trashed").unwrap());
        assert!(
            !every
                .move_may_take("item.state_changed", "archived")
                .unwrap()
        );
        assert!(
            !every
                .move_may_take("item.state_changed", "revoked")
                .unwrap()
        );
        let active = query(Some(&["active"]), Some("tags contains \"x\""));
        assert!(active.move_may_take("item.restored", "active").unwrap());
        assert!(
            !active
                .move_may_take("item.state_changed", "archived")
                .unwrap()
        );
        let by_state = query(None, Some("state eq \"active\""));
        assert!(
            by_state
                .move_may_take("item.state_changed", "active")
                .unwrap()
        );
    }

    #[test]
    fn a_staged_row_is_judged_and_rolled_back() {
        let conn = store::open_in_memory().unwrap();
        let catalog = crate::catalog::load(&conn).unwrap();
        let stage = |state: &'static str| {
            move |tx: &rusqlite::Connection| {
                held(tx, "s", state, &[], json!({}));
                Ok(Some("s".to_string()))
            }
        };
        let active = query(Some(&["active"]), None);
        let judge = |reading, state| {
            judge_staged(
                &conn,
                &catalog,
                &active,
                reading,
                Scope::default(),
                stage(state),
            )
            .unwrap()
        };
        assert_eq!(judge(Reading::Shows, "active"), Some(true));
        assert_eq!(judge(Reading::Shows, "trashed"), Some(false));
        assert_eq!(judge(Reading::Holds, "trashed"), Some(true));
        assert_eq!(judge(Reading::Holds, "archived"), Some(false));
        assert!(!store::item_held(&conn, "s").unwrap());
        let none = judge_staged(
            &conn,
            &catalog,
            &active,
            Reading::Holds,
            Scope::default(),
            |_| Ok(None),
        )
        .unwrap();
        assert_eq!(none, None);
    }

    #[test]
    fn a_query_naming_another_state_is_refused() {
        assert!(query(Some(&["trashed"]), None).check().is_err());
        assert!(query(Some(&[]), None).check().is_err());
        assert!(query(None, Some("tags contains")).check().is_err());
        query(Some(&["active"]), Some("tags contains \"x\""))
            .check()
            .unwrap();
    }
}

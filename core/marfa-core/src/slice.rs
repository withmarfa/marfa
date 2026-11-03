//! What a slice holds beyond its types and tier: the states, filter and
//! `beneath` of the query a folder shows, compiled once to SQL on `items`, so
//! that the rows a copy holds and the files a folder writes cannot drift
//! apart.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Result;
use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::model::ItemState;

/// A slice with a query also takes the conflicted copies of the types and
/// tier it takes, whatever the filter says, so a conflict made by a write
/// to a member stays in reach of the copy that made it.
pub(crate) const CONFLICTED_COPY_LISTING: &str = "tags=conflicted-copy";

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
    pub tags: Option<&'static str>,
}

impl SliceQuery {
    pub fn check(&self) -> Result<()> {
        if let Some(states) = &self.states {
            if states.is_empty() {
                return Err(CoreError::Invalid(
                    "a slice's query names no state, so it would hold nothing".into(),
                ));
            }
            for state in states {
                if !matches!(state.as_str(), "active" | "archived") {
                    return Err(CoreError::Invalid(format!(
                        "a slice's query holds active and archived items, and names {state:?}"
                    )));
                }
            }
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

    /// Whether a term needs edges or another row, which a server listing
    /// does not narrow by and an event does not carry.
    pub(crate) fn relational(&self) -> Result<bool> {
        Ok(self.beneath.is_some()
            || match &self.filter {
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

    /// The narrowing a copy holds for this query: its states always named,
    /// in one order, and its filter only where it needs no edges or another
    /// row, since a copy cannot yet be narrowed by them; `beneath` always
    /// needs edges. `None` where that narrows nothing, so a copy of the
    /// query holds what a copy of its types and tier always has.
    pub(crate) fn for_copy(&self) -> Result<Option<SliceQuery>> {
        let member = self.member_states();
        let filter = if self.relational()? {
            None
        } else {
            self.filter.clone()
        };
        if filter.is_none() && member == DEFAULT_STATES.map(ItemState::as_str) {
            return Ok(None);
        }
        Ok(Some(SliceQuery {
            states: Some(member.into_iter().map(str::to_string).collect()),
            filter,
            beneath: None,
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
            self.beneath.as_deref(),
            whole,
            catalog,
            &mut narrowing,
            values,
        )?;
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

/// Whether the query takes the row the copy holds under `id`. `false` where
/// it holds none.
pub(crate) fn takes_held(
    conn: &rusqlite::Connection,
    catalog: &Catalog,
    query: &SliceQuery,
    whole: &[String],
    id: &str,
) -> Result<bool> {
    let mut clauses = vec!["items.id = ?".to_string()];
    let mut values = vec![Value::String(id.into())];
    query.takes(catalog, whole, &mut clauses, &mut values)?;
    let sql = format!(
        "SELECT EXISTS (SELECT 1 FROM items WHERE {})",
        clauses.join(" AND ")
    );
    let bound: Vec<rusqlite::types::Value> = values.iter().map(crate::store::sql_value).collect();
    Ok(conn.query_row(&sql, rusqlite::params_from_iter(bound), |row| row.get(0))?)
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

    fn held(conn: &rusqlite::Connection, id: &str, state: &str, tags: &[&str], props: Value) {
        let item = store::testing::wire_item(id, "core.note", state, "2026-01-01T00:00:00Z", props);
        let tags: Vec<String> = tags.iter().map(|tag| tag.to_string()).collect();
        let catalog = Catalog::load(conn).unwrap();
        store::put_server_item(conn, &item, Some(&tags), &catalog).unwrap();
    }

    fn takes(conn: &rusqlite::Connection, query: &SliceQuery, id: &str) -> bool {
        takes_held(conn, &Catalog::load(conn).unwrap(), query, &[], id).unwrap()
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
        held(&conn, "copy", "active", &[crate::CONFLICTED_COPY_TAG], json!({}));
        held(&conn, "binned", "trashed", &["work"], json!({}));
        held(&conn, "gone", "revoked", &[crate::CONFLICTED_COPY_TAG], json!({}));
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
        let beneath = SliceQuery {
            beneath: Some("root".into()),
            ..query(None, Some("tags contains \"work\""))
        };
        assert_eq!(beneath.for_copy().unwrap(), None);
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
        assert!(!held.covers(&query(None, Some("tags contains \"home\""))).unwrap());
        assert!(!held.covers(&wide).unwrap());
        let edge = query(None, Some("edge[cites] exists"));
        assert!(wide.covers(&edge).unwrap());
    }

    #[test]
    fn a_query_naming_another_state_is_refused() {
        assert!(query(Some(&["trashed"]), None).check().is_err());
        assert!(query(Some(&[]), None).check().is_err());
        assert!(query(None, Some("tags contains")).check().is_err());
        query(Some(&["active"]), Some("tags contains \"x\"")).check().unwrap();
    }
}

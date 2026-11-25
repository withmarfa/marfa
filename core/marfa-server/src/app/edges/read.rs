//! An edge opens by its from item and its edge type alone, judged before the limit, so a page
//! comes back short only at its end and a cursor covers nothing hidden.

use rusqlite::Transaction;
use serde_json::Value;

use super::rows::{self, Page, Position};
use super::{Edge, not_found};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::catalog::Catalog;
use crate::app::items::{self, Reader, reading};
use crate::app::query::{self, Secret};
use crate::app::refusal::{Code, Refusal, Result};

const BLOCK_CAP: i64 = 50;
const BY_CREATION: &str = "edges";
const BY_CHANGE: &str = "edges-changed";
const OUTBOUND: &str = "item-edges";
const INBOUND: &str = "item-backrefs";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    Outbound,
    Inbound,
}

#[derive(Debug, Default)]
pub struct Listing {
    pub edge_types: Vec<String>,
    pub updated_after: Option<String>,
    pub updated_before: Option<String>,
    pub cursor: Option<String>,
    pub limit: i64,
}

#[derive(Debug, Default)]
pub struct ItemListing {
    pub edge_types: Vec<String>,
    pub cursor: Option<String>,
    pub limit: i64,
}

/// The edge types a page asks its query for, so an edge the caller may not read is never decoded.
#[derive(Debug, PartialEq, Eq)]
enum Kinds {
    Every,
    Named(Vec<String>),
    Read {
        read: Vec<String>,
        catalog: Vec<String>,
    },
}

fn kinds_read(catalog: &Catalog, asked: &[String], reads: impl Fn(&str) -> bool) -> Kinds {
    if !asked.is_empty() {
        return Kinds::Named(asked.iter().filter(|kind| reads(kind)).cloned().collect());
    }
    let mut every: Vec<String> = catalog.edge_kinds().map(|kind| kind.id.clone()).collect();
    every.sort();
    let read: Vec<String> = every.iter().filter(|kind| reads(kind)).cloned().collect();
    if read.len() == every.len() {
        return Kinds::Every;
    }
    Kinds::Read {
        read,
        catalog: every,
    }
}

fn readable(tx: &Transaction<'_>, caller: &Caller, edge: &Edge) -> Result<bool> {
    Ok(
        items::type_and_source_of(tx, &edge.from_id)?.is_some_and(|(type_id, source)| {
            caller.may_read_edge_from(&edge.edge_type, &type_id, &source)
        }),
    )
}

/// The from items an edge page may open by, or `None` where every item is in reach.
pub(super) fn from_reach(
    tx: &Transaction<'_>,
    caller: &Caller,
    catalog: &Catalog,
) -> Result<Option<query::Reach>> {
    let reach = query::Reach::within_own(tx, caller, catalog)?;
    Ok((!reach.is_whole()).then_some(reach))
}

fn page_of(
    read: &Reader<'_, '_>,
    asked: &Page<'_>,
    scope: &str,
) -> Result<(Vec<String>, Option<String>)> {
    let (tx, caller) = (read.tx, &read.caller);
    let (kinds, catalog) = match kinds_read(&read.catalog, asked.edge_types, |edge_type| {
        caller.may_read_edge_type(edge_type)
    }) {
        Kinds::Every => (Vec::new(), Vec::new()),
        Kinds::Named(kinds) if kinds.is_empty() => return Ok((Vec::new(), None)),
        Kinds::Named(kinds) => (kinds, Vec::new()),
        Kinds::Read { read, catalog } => (read, catalog),
    };
    let wider = Page {
        edge_types: &kinds,
        catalog_types: &catalog,
        limit: asked.limit + 1,
        ..*asked
    };
    let from = from_reach(tx, caller, &read.catalog)?;
    let mut found = rows::page(tx, &wider, from.as_ref(), |edge_type| {
        caller.may_read_edge_type(edge_type)
    })?;
    let more = found.len() as i64 > asked.limit;
    found.truncate(asked.limit as usize);
    let cursor = match found.last().filter(|_| more) {
        Some(edge) => {
            let at = if asked.by_change {
                &edge.updated_at
            } else {
                &edge.created_at
            };
            Some(read.cursors.issue_at(scope, at, &edge.id)?)
        }
        None => None,
    };
    read.hydrating();
    let printed = found
        .iter()
        .map(Edge::answered)
        .collect::<Result<Vec<_>>>()?;
    Ok((printed, cursor))
}

fn page_text(data: &[String], cursor: Option<String>) -> String {
    format!(
        "{{\"data\":[{}],\"next_cursor\":{}}}",
        data.join(","),
        cursor.map_or(Value::Null, Value::from)
    )
}

pub async fn get(app: &App, caller: &Caller, id: String) -> Result<String> {
    reading(app, caller, move |read: &Reader<'_, '_>| {
        read.caller.require_reach()?;
        let edge = rows::by_id(read.tx, &id)?.ok_or_else(|| not_found(&id))?;
        if !readable(read.tx, &read.caller, &edge)? {
            return Err(not_found(&id));
        }
        Ok(format!("{{\"edge\":{}}}", edge.answered()?))
    })
    .await
}

pub async fn list(app: &App, caller: &Caller, listing: Listing) -> Result<String> {
    reading(app, caller, move |read: &Reader<'_, '_>| {
        read.caller.require_reach()?;
        let by_change = listing.updated_after.is_some();
        let scope = if by_change { BY_CHANGE } else { BY_CREATION };
        let after: Option<Position> = listing
            .cursor
            .as_deref()
            .map(|cursor| read.cursors.open_at(scope, cursor))
            .transpose()?;
        let (data, cursor) = page_of(
            read,
            &Page {
                from: None,
                to: None,
                edge_types: &listing.edge_types,
                catalog_types: &[],
                updated_after: listing.updated_after.as_deref(),
                updated_before: listing.updated_before.as_deref(),
                after: after.as_ref(),
                by_change,
                limit: listing.limit,
            },
            scope,
        )?;
        Ok(page_text(&data, cursor))
    })
    .await
}

fn scope_of(reach: Reach) -> &'static str {
    match reach {
        Reach::Outbound => OUTBOUND,
        Reach::Inbound => INBOUND,
    }
}

fn ends(reach: Reach, id: &str) -> (Option<&str>, Option<&str>) {
    match reach {
        Reach::Outbound => (Some(id), None),
        Reach::Inbound => (None, Some(id)),
    }
}

pub async fn of_item(
    app: &App,
    caller: &Caller,
    id: String,
    reach: Reach,
    listing: ItemListing,
) -> Result<String> {
    reading(app, caller, move |read: &Reader<'_, '_>| {
        read.caller.require_reach()?;
        let row = items::row(read.tx, &id)?
            .filter(|row| read.caller.may_read_item(&row.type_id, &row.source))
            .ok_or_else(|| Refusal::new(Code::ItemNotFound, format!("Item {id} not found")))?;
        let after: Option<Position> = listing
            .cursor
            .as_deref()
            .map(|cursor| read.cursors.open_at(scope_of(reach), cursor))
            .transpose()?;
        let (from, to) = ends(reach, &row.id);
        let (data, cursor) = page_of(
            read,
            &Page {
                from,
                to,
                edge_types: &listing.edge_types,
                catalog_types: &[],
                updated_after: None,
                updated_before: None,
                after: after.as_ref(),
                by_change: false,
                limit: listing.limit,
            },
            scope_of(reach),
        )?;
        Ok(page_text(&data, cursor))
    })
    .await
}

/// A block left empty says only that something hidden exists, so it goes.
pub struct Blocks {
    pub text: String,
    pub far_ends: Vec<String>,
}

pub(crate) fn hydrate(
    tx: &Transaction<'_>,
    caller: &Caller,
    catalog: &Catalog,
    secret: &Secret,
    id: &str,
    reach: Reach,
) -> Result<Blocks> {
    let (from, to) = ends(reach, id);
    let mut blocks = Vec::new();
    let mut far_ends = Vec::new();
    let kinds = rows::kinds_at(tx, from, to)?;
    if kinds.is_empty() {
        return Ok(Blocks {
            text: "{}".to_string(),
            far_ends,
        });
    }
    let (held, reached) = match reach {
        Reach::Outbound => (items::type_and_source_of(tx, id)?, None),
        Reach::Inbound => (None, from_reach(tx, caller, catalog)?),
    };
    let levers = caller.levers()?;
    let opens = |edge_type: &str| match (reach, &held) {
        (Reach::Inbound, _) => caller.may_read_edge_type(edge_type),
        (Reach::Outbound, Some((type_id, source))) => {
            caller.may_read_edge_from(edge_type, type_id, source)
                && levers.lists(&catalog.rules, type_id, source)
        }
        (Reach::Outbound, None) => false,
    };
    for edge_type in kinds {
        if !opens(&edge_type) {
            continue;
        }
        let only = [edge_type];
        let wider = Page {
            from,
            to,
            edge_types: &only,
            catalog_types: &[],
            updated_after: None,
            updated_before: None,
            after: None,
            by_change: false,
            limit: BLOCK_CAP + 1,
        };
        let mut found = rows::page(tx, &wider, reached.as_ref(), |_| true)?;
        let more = found.len() as i64 > BLOCK_CAP;
        found.truncate(BLOCK_CAP as usize);
        if found.is_empty() {
            continue;
        }
        let cursor = match found.last().filter(|_| more) {
            Some(edge) => Some(secret.issue_at(scope_of(reach), &edge.created_at, &edge.id)?),
            None => None,
        };
        let mut data = Vec::with_capacity(found.len());
        for edge in &found {
            data.push(edge.answered()?);
            let far = match reach {
                Reach::Outbound => &edge.to_id,
                Reach::Inbound => &edge.from_id,
            };
            if !far_ends.contains(far) {
                far_ends.push(far.clone());
            }
        }
        let [edge_type] = only;
        blocks.push(format!(
            "{}:{}",
            Value::from(edge_type),
            page_text(&data, cursor)
        ));
    }
    Ok(Blocks {
        text: format!("{{{}}}", blocks.join(",")),
        far_ends,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn a_page_asks_its_query_for_the_edge_types_its_caller_reads() {
        let catalog = Catalog::shipped();
        let shipped = catalog.edge_kinds().count();
        assert!(shipped > 2, "{shipped} shipped edge types");
        let mut every: Vec<String> = catalog.edge_kinds().map(|kind| kind.id.clone()).collect();
        every.sort();
        assert_eq!(kinds_read(&catalog, &[], |_| true), Kinds::Every);
        assert_eq!(
            kinds_read(&catalog, &[], |edge_type| edge_type == "references"),
            Kinds::Read {
                read: names(&["references"]),
                catalog: every.clone()
            }
        );
        assert_eq!(
            kinds_read(&catalog, &[], |_| false),
            Kinds::Read {
                read: Vec::new(),
                catalog: every
            }
        );
        let asked = names(&["references", "attached-to", "mock.unknown"]);
        assert_eq!(
            kinds_read(&catalog, &asked, |edge_type| edge_type != "attached-to"),
            Kinds::Named(names(&["references", "mock.unknown"]))
        );
        assert_eq!(
            kinds_read(&catalog, &asked, |_| false),
            Kinds::Named(Vec::new())
        );
    }
}

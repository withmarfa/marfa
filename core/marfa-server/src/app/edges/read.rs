//! A source filter cuts in the query, before the limit, so paging stays whole; what the key may
//! not read is left out after the cut, so a page can come back short with a cursor still to follow.

use rusqlite::Transaction;
use serde_json::Value;

use super::rows::{self, Page, Position};
use super::{Edge, not_found};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::catalog::Catalog;
use crate::app::items::{self, Reader, reading};
use crate::app::query::Secret;
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

fn readable(tx: &Transaction<'_>, caller: &Caller, edge: &Edge) -> Result<bool> {
    Ok(items::type_of(tx, &edge.source_id)?
        .is_some_and(|source| caller.may_read_edge(&edge.edge_type, &source)))
}

fn page_of(
    read: &Reader<'_, '_>,
    asked: &Page<'_>,
    scope: &str,
) -> Result<(Vec<String>, Option<String>)> {
    let (tx, caller, catalog) = (read.tx, &read.caller, &read.catalog);
    let wider = Page {
        limit: asked.limit + 1,
        ..*asked
    };
    let mut found = rows::page(tx, &wider, |type_id, source| {
        caller.lists(&catalog.rules, type_id, source)
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
    let mut printed = Vec::with_capacity(found.len());
    for edge in &found {
        if readable(tx, caller, edge)? {
            printed.push(edge.answered()?);
        }
    }
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
            .filter(|row| read.caller.may_read_type(&row.type_id))
            .ok_or_else(|| Refusal::new(Code::ItemNotFound, format!("Item {id} not found")))?;
        read.hydrating();
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
    for edge_type in rows::kinds_at(tx, from, to)? {
        let only = [edge_type];
        let wider = Page {
            from,
            to,
            edge_types: &only,
            updated_after: None,
            updated_before: None,
            after: None,
            by_change: false,
            limit: BLOCK_CAP + 1,
        };
        let mut found = rows::page(tx, &wider, |type_id, source| {
            caller.lists(&catalog.rules, type_id, source)
        })?;
        let more = found.len() as i64 > BLOCK_CAP;
        found.truncate(BLOCK_CAP as usize);
        let cursor = match found.last().filter(|_| more) {
            Some(edge) => Some(secret.issue_at(scope_of(reach), &edge.created_at, &edge.id)?),
            None => None,
        };
        let mut data = Vec::with_capacity(found.len());
        for edge in &found {
            if readable(tx, caller, edge)? {
                data.push(edge.answered()?);
                let far = match reach {
                    Reach::Outbound => &edge.target_id,
                    Reach::Inbound => &edge.source_id,
                };
                if !far_ends.contains(far) {
                    far_ends.push(far.clone());
                }
            }
        }
        if !data.is_empty() {
            let [edge_type] = only;
            blocks.push(format!(
                "{}:{}",
                Value::from(edge_type),
                page_text(&data, cursor)
            ));
        }
    }
    Ok(Blocks {
        text: format!("{{{}}}", blocks.join(",")),
        far_ends,
    })
}

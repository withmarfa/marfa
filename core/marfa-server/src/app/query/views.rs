//! `GET /views/{id}/items`: what a saved view lists, for whoever reads it.

use marfa_rules::filter;
use serde_json::{Map, Value as Json, json};

use super::compile::{Ask, Filter, Sql, States, judge_terms, selection};
use super::cursor::Position;
use super::listing::{answered, found, page_sql};
use super::order::{Key, Order, property_key};
use super::reach::Reach;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::catalog::Catalog;
use crate::app::items::{self, Many, Reader, reading};
use crate::app::refusal::{Code, Refusal, Result};

pub const VIEW_TYPE: &str = "system.view";

/// A page of a view.
#[derive(Clone, Debug)]
pub struct ViewPage {
    pub id: String,
    pub limit: i64,
    pub cursor: Option<String>,
}

fn unlistable(id: &str) -> Refusal {
    Refusal::validation(format!("View {id} holds a setting that can't be listed"))
}

fn strings(value: Option<&Json>) -> Vec<String> {
    value
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.as_str().map(str::to_string))
        .collect()
}

/// What a stored view's `query` asks. A type deleted since it was saved stays
/// named, and selects what rows of it are left.
fn ask_of(id: &str, settings: &Map<String, Json>) -> Result<Ask> {
    let query = settings.get("query").and_then(Json::as_object);
    let member = |name: &str| query.and_then(|query| query.get(name));
    let text = |name: &str| member(name).and_then(Json::as_str).map(str::to_string);
    let states = strings(member("state"));
    let filter = text("filter")
        .map(|text| {
            let expression = filter::parse(&text).map_err(|_| unlistable(id))?;
            Ok::<_, Refusal>(Filter { text, expression })
        })
        .transpose()?;
    Ok(Ask {
        types: strings(member("types")),
        states: States::Named(if states.is_empty() {
            vec!["active".to_string(), "archived".to_string()]
        } else {
            states
        }),
        tier: text("tier").filter(|tier| tier != "all"),
        filter,
        beneath: text("beneath"),
        ..Ask::default()
    })
}

/// An item's title: what its type's title field holds, or `title`.
fn title_key(catalog: &Catalog) -> Sql {
    let rules = &catalog.rules;
    let mut by_field: Vec<(String, Vec<&str>)> = Vec::new();
    for (type_id, _) in rules.declared() {
        let field = rules.title_property(type_id);
        if field == "title" {
            continue;
        }
        match by_field.iter_mut().find(|(held, _)| held == field) {
            Some((_, types)) => types.push(type_id),
            None => by_field.push((field.to_string(), vec![type_id])),
        }
    }
    if by_field.is_empty() {
        return property_key("title");
    }
    let mut sql = Sql::new("CASE");
    for (field, types) in &by_field {
        sql.push(" WHEN i.type IN (");
        sql.list(types);
        sql.push(") THEN ");
        sql.append(&property_key(field));
    }
    sql.push(" ELSE ");
    sql.append(&property_key("title"));
    sql.push(" END");
    sql
}

fn key_of(by: &str, descending: bool, catalog: &Catalog) -> Option<Key> {
    let (expression, nullable) = match by {
        "created_at" | "updated_at" | "occurred_at" | "type" | "state" => {
            (Sql::new(&format!("i.{by}")), false)
        }
        "tier" => (Sql::new("i.tier"), true),
        "title" => (title_key(catalog), true),
        "tags" => (
            Sql::new("(SELECT min(t.tag) FROM item_tags t WHERE t.item_seq = i.seq)"),
            true,
        ),
        _ => (property_key(by.strip_prefix("properties.")?), true),
    };
    Some(Key {
        expression,
        descending,
        nullable,
    })
}

/// The newest `occurred_at` first where a view names no key. A tie breaks by
/// id ascending, or in the key's direction where one time is the only key.
fn order_of(id: &str, settings: &Map<String, Json>, catalog: &Catalog) -> Result<Order> {
    let named = settings
        .get("sort")
        .and_then(Json::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if named.is_empty() {
        let keys = key_of("occurred_at", true, catalog).into_iter().collect();
        return Ok(Order::view(keys, true));
    }
    let keys = named
        .iter()
        .map(|key| {
            let by = key.get("by").and_then(Json::as_str)?;
            let descending = key.get("direction").and_then(Json::as_str) == Some("desc");
            key_of(by, descending, catalog)
        })
        .collect::<Option<Vec<Key>>>()
        .ok_or_else(|| unlistable(id))?;
    let tie_descending = match (keys.as_slice(), named) {
        ([only], [key]) => {
            only.descending
                && matches!(
                    key.get("by").and_then(Json::as_str),
                    Some("created_at" | "updated_at" | "occurred_at")
                )
        }
        _ => false,
    };
    Ok(Order::view(keys, tie_descending))
}

fn page(read: &Reader<'_, '_>, secret: &super::Secret, view: &ViewPage) -> Result<String> {
    let reach = Reach::of(read)?;
    let row = items::row(read.tx, &view.id)?
        .filter(|row| {
            row.type_id == VIEW_TYPE
                && row.state != "trashed"
                && read.caller.may_read_type(&row.type_id)
        })
        .ok_or_else(|| Refusal::new(Code::ItemNotFound, format!("View {} not found", view.id)))?;
    if row.state == "revoked" {
        return Err(Refusal::new(
            Code::InvalidTransition,
            format!(
                "View {} is revoked, and a revoked view lists nothing",
                view.id
            ),
        ));
    }
    let settings = items::parsed(&row.properties)?;
    let ask = ask_of(&view.id, &settings)?;
    judge_terms(read, &ask)?;
    let order = order_of(&view.id, &settings, &read.catalog)?;
    let scope = json!([
        "view",
        read.caller.credential_handle(),
        view.id,
        row.version
    ])
    .to_string();
    let position = view
        .cursor
        .as_deref()
        .map(|cursor| {
            let payload = secret.open(&scope, cursor)?;
            Position::from_payload(&payload, order.width())
        })
        .transpose()?;
    let selected = selection(&reach, &ask, &read.catalog, order.walked())?;
    let sql = page_sql(&selected, &ask, &order, position.as_ref(), view.limit);
    let rows = found(read, &sql, order.width())?;
    answered(
        read,
        rows,
        view.limit,
        |last| secret.issue(&scope, &last.payload()),
        |seqs| items::listed(read, seqs, &Many::default()),
    )
}

pub async fn view_items(app: &App, caller: &Caller, view: ViewPage) -> Result<String> {
    let secret = app.cursor_secret.clone();
    reading(app, caller, move |read| page(read, &secret, &view)).await
}

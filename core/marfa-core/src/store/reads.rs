//! Reading the items and edges the copy holds.

use super::Cached;
use crate::error::CoreError;
use crate::model::{Edge, Item, ItemState, Tier};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

const ITEM_COLUMNS: &str = "id, type, state, tier, version, schema_version, source, source_id, occurred_at, created_at, updated_at, properties, capture_latitude, capture_longitude, trashed_at, read_only";

const EDGE_COLUMNS: &str =
    "id, from_id, to_id, edge_type, properties, version, created_at, updated_at";

/// Nothing for a trashed row, as the server answers a read by id.
pub fn item_by_id(conn: &Connection, id: &str) -> Result<Option<Item>, CoreError> {
    item_by_id_with(conn, id, &mut Unreadable::Refuse)
}

/// Whether the copy holds `id` in the bin. False for an id it does not hold.
pub(crate) fn in_bin(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn
        .prepare_cached("SELECT 1 FROM items WHERE id = ?1 AND state = 'trashed'")?
        .exists([id])?)
}

pub fn item_by_id_with(
    conn: &Connection,
    id: &str,
    unreadable: &mut Unreadable,
) -> Result<Option<Item>, CoreError> {
    let mut items = items_by_ids_with(conn, std::slice::from_ref(&id.to_string()), unreadable)?;
    Ok(items.pop().filter(|item| item.state != ItemState::Trashed))
}

/// `ids` without repeats, each where it was first named.
pub(crate) fn unique(ids: &[String]) -> Vec<&str> {
    let mut seen = HashSet::with_capacity(ids.len());
    ids.iter()
        .map(String::as_str)
        .filter(|id| seen.insert(*id))
        .collect()
}

/// The counts an `IN` list is padded to, so the statement cache holds a few
/// shapes of each query rather than one for every count of ids.
const IN_LIST_SIZES: [usize; 4] = [1, 16, 128, 500];

/// `ids` in chunks for `IN (...)`, each beside its placeholders and padded
/// with its last id to one of `IN_LIST_SIZES`. A repeat in an `IN` list
/// matches its row once.
pub(crate) fn in_lists<'a>(
    ids: &'a [&'a str],
) -> impl Iterator<Item = (String, Vec<&'a str>)> + 'a {
    ids.chunks(IN_LIST_SIZES[IN_LIST_SIZES.len() - 1])
        .map(|chunk| {
            let size = IN_LIST_SIZES
                .into_iter()
                .find(|size| *size >= chunk.len())
                .unwrap_or(chunk.len());
            let mut padded = chunk.to_vec();
            padded.resize(size, chunk[chunk.len() - 1]);
            (vec!["?"; size].join(", "), padded)
        })
}

/// Items for `ids`, in the order given, skipping ids not held.
pub fn items_by_ids(conn: &Connection, ids: &[String]) -> Result<Vec<Item>, CoreError> {
    items_by_ids_with(conn, ids, &mut Unreadable::Refuse)
}

/// `items_by_ids`, with `unreadable` deciding what a row whose stored
/// properties cannot be read does.
pub fn items_by_ids_with(
    conn: &Connection,
    ids: &[String],
    unreadable: &mut Unreadable,
) -> Result<Vec<Item>, CoreError> {
    let ids = unique(ids);
    let mut by_id: HashMap<String, Item> = HashMap::new();
    for (placeholders, chunk) in in_lists(&ids) {
        let sql = format!("SELECT {ITEM_COLUMNS} FROM items WHERE id IN ({placeholders})");
        let mut statement = conn.prepare_cached(&sql)?;
        let rows = statement.query_map(params_from_iter(chunk), read_item)?;
        for row in rows {
            let (item, why) = row?;
            if let Some(why) = why {
                unreadable.note("item", &item.id, why)?;
            }
            by_id.insert(item.id.clone(), item);
        }
    }
    let tags = tags_for(conn, &ids)?;
    Ok(ids
        .iter()
        .filter_map(|id| by_id.remove(*id))
        .map(|mut item| {
            item.tags = tags.get(&item.id).cloned().unwrap_or_default();
            item
        })
        .collect())
}

/// Items matching `where_sql`, with `unreadable` deciding what a row whose
/// stored properties cannot be read does.
pub fn items_where(
    conn: &Connection,
    where_sql: &str,
    order_sql: &str,
    limit_sql: &str,
    values: &[Value],
    unreadable: &mut Unreadable,
) -> Result<Vec<Item>, CoreError> {
    let sql = format!("SELECT {ITEM_COLUMNS} FROM items WHERE {where_sql} {order_sql} {limit_sql}");
    let mut statement = conn.prepare(&sql)?;
    let params = values.iter().map(sql_value).collect::<Vec<_>>();
    let rows = statement.query_map(params_from_iter(params.iter()), read_item)?;
    let mut items = Vec::new();
    for row in rows {
        let (item, why) = row?;
        if let Some(why) = why {
            unreadable.note("item", &item.id, why)?;
        }
        items.push(item);
    }
    let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
    let tags = tags_for(conn, &ids)?;
    for item in &mut items {
        item.tags = tags.get(&item.id).cloned().unwrap_or_default();
    }
    Ok(items)
}

pub fn edges_from(conn: &Connection, from_id: &str) -> Result<Vec<Edge>, CoreError> {
    edges_at(conn, "from_id", from_id, &mut Unreadable::Refuse)
}

pub fn edges_to(conn: &Connection, to_id: &str) -> Result<Vec<Edge>, CoreError> {
    edges_at(conn, "to_id", to_id, &mut Unreadable::Refuse)
}

/// The items at the other end of each edge of `id` that is not of type
/// `except`, read from the ends alone so an edge whose properties cannot be
/// read still names them.
pub(crate) fn edge_neighbors(
    conn: &Connection,
    id: &str,
    except: &str,
) -> Result<Vec<(String, String)>, CoreError> {
    let mut statement = conn.prepare_cached(
        "SELECT from_id, to_id FROM edges
          WHERE (from_id = ?1 OR to_id = ?1) AND edge_type != ?2",
    )?;
    let ends = statement
        .query_map(params![id, except], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ends)
}

pub fn edges_of_type(conn: &Connection, edge_type: &str) -> Result<Vec<Edge>, CoreError> {
    edges_at(conn, "edge_type", edge_type, &mut Unreadable::Refuse)
}

/// `column` is spliced into the query, so it is a literal, never a caller's text.
pub fn edges_at(
    conn: &Connection,
    column: &'static str,
    value: &str,
    unreadable: &mut Unreadable,
) -> Result<Vec<Edge>, CoreError> {
    let sql =
        format!("SELECT {EDGE_COLUMNS} FROM edges WHERE {column} = ?1 ORDER BY created_at, id");
    let mut statement = conn.prepare_cached(&sql)?;
    let rows = statement.query_map([value], read_edge)?;
    let mut edges = Vec::new();
    for row in rows {
        let (edge, why) = row?;
        if let Some(why) = why {
            unreadable.note("edge", &edge.id, why)?;
        }
        edges.push(edge);
    }
    Ok(edges)
}

pub fn count(conn: &Connection, table: &str) -> Result<u64, CoreError> {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    Ok(conn.query_row(&sql, [], |row| row.get::<_, i64>(0))? as u64)
}

pub(crate) fn sql_value(value: &Value) -> rusqlite::types::Value {
    match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(flag) => rusqlite::types::Value::Integer(i64::from(*flag)),
        Value::Number(number) => match number.as_i64() {
            Some(integer) => rusqlite::types::Value::Integer(integer),
            None => rusqlite::types::Value::Real(number.as_f64().unwrap_or(0.0)),
        },
        Value::String(text) => rusqlite::types::Value::Text(text.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}

/// The index reads tags in byte order, whatever order the server keeps them in.
pub(super) fn tags_for_index(conn: &Connection, id: &str) -> Result<Vec<String>, CoreError> {
    let mut statement =
        conn.prepare_cached("SELECT tag FROM tags WHERE item_id = ?1 ORDER BY tag")?;
    let rows = statement.query_map([id], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<String>, _>>()?)
}

/// `ids` holds no repeat.
pub(super) fn tags_for(
    conn: &Connection,
    ids: &[&str],
) -> Result<HashMap<String, Vec<String>>, CoreError> {
    let mut tags: HashMap<String, Vec<String>> = HashMap::new();
    // Reading a tag in turn costs about a quarter of looking up a row's tags
    // by id, so where the copy holds at most four tags for each row asked,
    // as for a listing of most of it, every tag is read once instead.
    if ids.len() > 1000
        && conn.query_row_cached("SELECT count(*) FROM tags", [], |row| row.get::<_, i64>(0))?
            <= i64::try_from(ids.len())
                .unwrap_or(i64::MAX)
                .saturating_mul(4)
    {
        let wanted: HashSet<&str> = ids.iter().copied().collect();
        let mut statement =
            conn.prepare_cached("SELECT item_id, tag FROM tags ORDER BY item_id, position")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (item_id, tag) = row?;
            if wanted.contains(item_id.as_str()) {
                tags.entry(item_id).or_default().push(tag);
            }
        }
        return Ok(tags);
    }
    for (placeholders, chunk) in in_lists(ids) {
        let sql = format!(
            "SELECT item_id, tag FROM tags WHERE item_id IN ({placeholders}) ORDER BY item_id, position"
        );
        let mut statement = conn.prepare_cached(&sql)?;
        let rows = statement.query_map(params_from_iter(chunk), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (item_id, tag) = row?;
            tags.entry(item_id).or_default().push(tag);
        }
    }
    Ok(tags)
}

/// A row of `items`, with why its properties are empty where the stored text
/// could not be read.
fn read_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<(Item, Option<String>)> {
    let state: String = row.get(2)?;
    let tier: Option<String> = row.get(3)?;
    let properties: String = row.get(11)?;
    let (properties, why) = split_properties(&properties);
    let item = Item {
        id: row.get(0)?,
        r#type: row.get(1)?,
        state: state.parse().map_err(|_| invalid_row(2, &state))?,
        tier: match tier.as_deref() {
            None => None,
            Some(text) => Some(text.parse().map_err(|_| invalid_row(3, text))?),
        },
        version: row.get(4)?,
        schema_version: row.get(5)?,
        source: row.get(6)?,
        source_id: row.get(7)?,
        occurred_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        properties,
        capture_latitude: row.get(12)?,
        capture_longitude: row.get(13)?,
        trashed_at: row.get(14)?,
        read_only: row.get(15)?,
        tags: Vec::new(),
    };
    Ok((item, why))
}

fn read_edge(row: &rusqlite::Row<'_>) -> rusqlite::Result<(Edge, Option<String>)> {
    let properties: String = row.get(4)?;
    let (properties, why) = split_properties(&properties);
    let edge = Edge {
        id: row.get(0)?,
        from_id: row.get(1)?,
        to_id: row.get(2)?,
        edge_type: row.get(3)?,
        properties,
        version: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    };
    Ok((edge, why))
}

const UNREADABLE_PROPERTIES: &str = "the properties of ";

/// Whether a refusing read failed on a row whose stored properties are not
/// one JSON object, rather than on the store.
pub(crate) fn unreadable(error: &CoreError) -> bool {
    matches!(error, CoreError::Store(message) if message.starts_with(UNREADABLE_PROPERTIES))
}

/// What a read does with a row whose stored properties are not one JSON
/// object. The text is not echoed: it is the person's content.
pub enum Unreadable {
    /// The read fails.
    Refuse,
    /// The row stays, with no properties, and its id is noted with the reason.
    Keep(HashMap<String, String>),
}

impl Unreadable {
    pub fn why(&self, id: &str) -> Option<String> {
        match self {
            Unreadable::Refuse => None,
            Unreadable::Keep(kept) => kept.get(id).cloned(),
        }
    }

    fn note(&mut self, kind: &str, id: &str, why: String) -> Result<(), CoreError> {
        match self {
            Unreadable::Refuse => Err(CoreError::Store(format!(
                "{UNREADABLE_PROPERTIES}{kind} {id} cannot be read: {why}"
            ))),
            Unreadable::Keep(kept) => {
                kept.insert(id.to_string(), why);
                Ok(())
            }
        }
    }
}

/// The stored properties, or none and why they could not be read. Properties
/// nested deeper than `MAX_JSON_DEPTH` are unreadable, so that no reader of
/// what the core answers, such as a binding's packed listing, meets them.
pub(super) fn split_properties(text: &str) -> (Map<String, Value>, Option<String>) {
    match serde_json::from_str::<Value>(text) {
        Ok(value) if deeper_than(&value, crate::MAX_JSON_DEPTH) => (
            Map::new(),
            Some(format!(
                "the stored text nests deeper than {} levels",
                crate::MAX_JSON_DEPTH
            )),
        ),
        Ok(Value::Object(map)) => (map, None),
        Ok(_) => (
            Map::new(),
            Some("the stored text is not a JSON object".into()),
        ),
        Err(error) => (
            Map::new(),
            Some(format!("the stored text is not JSON ({error})")),
        ),
    }
}

/// Whether `value` nests arrays and objects more than `levels` deep, counting
/// its own level. The parse refuses nesting past its own limit, so the
/// recursion is bounded.
fn deeper_than(value: &Value, levels: usize) -> bool {
    match value {
        Value::Array(values) => levels == 0 || values.iter().any(|v| deeper_than(v, levels - 1)),
        Value::Object(map) => levels == 0 || map.values().any(|v| deeper_than(v, levels - 1)),
        _ => false,
    }
}

fn invalid_row(column: usize, text: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("unreadable value {text:?}"),
        )),
    )
}

impl ItemState {
    pub(super) fn from_str_checked(text: &str) -> Result<ItemState, CoreError> {
        text.parse()
    }
}

impl Tier {
    pub(crate) fn parse_wire(text: Option<&str>) -> Result<Option<Tier>, CoreError> {
        match text {
            None => Ok(None),
            Some(text) => text.parse().map(Some),
        }
    }
}

pub fn edge_by_id(conn: &Connection, id: &str) -> Result<Option<Edge>, CoreError> {
    edge_by_id_with(conn, id, &mut Unreadable::Refuse)
}

/// The edge for a reader that needs only its ends and type, such as one
/// asking whether the copy holds it: where its stored properties cannot be
/// read, they are empty. A reader that writes from the properties calls
/// `edge_by_id`, which refuses.
pub fn edge_ends(conn: &Connection, id: &str) -> Result<Option<Edge>, CoreError> {
    edge_by_id_with(conn, id, &mut Unreadable::Keep(HashMap::new()))
}

/// Edges for `ids`, in the order given, once each, skipping ids not held.
pub fn edges_by_ids_with(
    conn: &Connection,
    ids: &[String],
    unreadable: &mut Unreadable,
) -> Result<Vec<Edge>, CoreError> {
    let ids = unique(ids);
    let mut by_id: HashMap<String, Edge> = HashMap::new();
    for (placeholders, chunk) in in_lists(&ids) {
        let sql = format!("SELECT {EDGE_COLUMNS} FROM edges WHERE id IN ({placeholders})");
        let mut statement = conn.prepare_cached(&sql)?;
        let rows = statement.query_map(params_from_iter(chunk), read_edge)?;
        for row in rows {
            let (edge, why) = row?;
            if let Some(why) = why {
                unreadable.note("edge", &edge.id, why)?;
            }
            by_id.insert(edge.id.clone(), edge);
        }
    }
    Ok(ids.iter().filter_map(|id| by_id.remove(*id)).collect())
}

pub fn edge_by_id_with(
    conn: &Connection,
    id: &str,
    unreadable: &mut Unreadable,
) -> Result<Option<Edge>, CoreError> {
    let read = conn
        .query_row_cached(
            "SELECT id, from_id, to_id, edge_type, properties, version, created_at, updated_at
               FROM edges WHERE id = ?1",
            [id],
            read_edge,
        )
        .optional()?;
    let Some((edge, why)) = read else {
        return Ok(None);
    };
    if let Some(why) = why {
        unreadable.note("edge", &edge.id, why)?;
    }
    Ok(Some(edge))
}

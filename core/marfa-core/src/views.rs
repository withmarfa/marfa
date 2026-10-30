//! Evaluates saved views in the same snapshot that proves their query complete.

use std::collections::HashMap;

use chrono::{Datelike, NaiveDate};
use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::catalog::Catalog;
use crate::folder::Settings;
use crate::model::{Completeness, Item, ItemState, Rows, SearchHit, Shown, SliceTier, Sort};
use crate::store::Unreadable;
use crate::{Core, CoreError, Result, search, store};

pub const VIEW_TYPE: &str = "system.view";

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ViewRow {
    pub id: String,
    pub version: i64,
    pub state: ItemState,
    pub settings: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ViewGroup {
    pub key: Value,
    pub count: u64,
}

impl ViewRow {
    fn of(item: Item) -> Result<Self> {
        if item.r#type != VIEW_TYPE {
            return Err(CoreError::Invalid(format!(
                "{} is a {}, not a {VIEW_TYPE}",
                item.id, item.r#type
            )));
        }
        Ok(Self {
            id: item.id,
            version: item.version,
            state: item.state,
            settings: item.properties,
        })
    }
}

impl Core {
    pub fn view(&self, id: &str) -> Result<Option<ViewRow>> {
        self.get(id)?.map(ViewRow::of).transpose()
    }

    pub fn list_views(&self) -> Result<Rows<ViewRow>> {
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let rows = crate::query::list_where(
                conn,
                &["items.type = 'system.view'".into()],
                &[],
                Sort::default(),
                None,
                None,
            )?
            .into_iter()
            .map(ViewRow::of)
            .collect::<Result<_>>()?;
            Ok(Rows { rows, completeness })
        })
    }

    pub fn list_in_view(
        &self,
        id: &str,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Rows<(Item, Shown)>> {
        self.list_in_view_with(id, limit, offset, &mut Unreadable::Refuse)
    }

    pub fn list_in_view_kept(
        &self,
        id: &str,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Rows<(Item, Shown)>> {
        self.list_in_view_with(id, limit, offset, &mut Unreadable::Keep(HashMap::new()))
    }

    fn list_in_view_with(
        &self,
        id: &str,
        limit: Option<u32>,
        offset: Option<u32>,
        unreadable: &mut Unreadable,
    ) -> Result<Rows<(Item, Shown)>> {
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let scope = scope(conn, id, completeness)?;
            let order = sort_sql(&scope.view.settings, &scope.catalog)?;
            let limit = match (limit, offset) {
                (None, None) => String::new(),
                (limit, offset) => format!(
                    "LIMIT {} OFFSET {}",
                    limit.map(i64::from).unwrap_or(-1),
                    offset.unwrap_or(0)
                ),
            };
            let rows = store::items_where(
                conn,
                &scope.clauses.join(" AND "),
                &order,
                &limit,
                &scope.values,
                unreadable,
            )?;
            Ok(Rows { rows, completeness }.map(|item| {
                let shown = scope.catalog.shown_unreadable(&item, unreadable);
                (item, shown)
            }))
        })
    }

    pub fn search_in_view(
        &self,
        text: &str,
        id: &str,
        limit: usize,
    ) -> Result<Rows<(SearchHit, Shown)>> {
        self.search_in_view_with(text, id, limit, &mut Unreadable::Refuse)
    }

    pub fn search_in_view_kept(
        &self,
        text: &str,
        id: &str,
        limit: usize,
    ) -> Result<Rows<(SearchHit, Shown)>> {
        self.search_in_view_with(text, id, limit, &mut Unreadable::Keep(HashMap::new()))
    }

    fn search_in_view_with(
        &self,
        text: &str,
        id: &str,
        limit: usize,
        unreadable: &mut Unreadable,
    ) -> Result<Rows<(SearchHit, Shown)>> {
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let scope = scope(conn, id, completeness)?;
            let rows =
                search::search_where(conn, text, &scope.clauses, scope.values, limit, unreadable)?;
            Ok(Rows { rows, completeness }.map(|hit| {
                let shown = scope.catalog.shown_unreadable(&hit.item, unreadable);
                (hit, shown)
            }))
        })
    }

    /// A missing zone uses the device's current local zone. An explicit IANA
    /// name lets an app keep the same buckets while presenting another zone.
    pub fn view_groups(&self, id: &str, time_zone: Option<&str>) -> Result<Rows<ViewGroup>> {
        let zone = time_zone
            .map(|name| {
                name.parse::<chrono_tz::Tz>()
                    .map_err(|_| invalid(&format!("unknown time zone {name:?}")))
            })
            .transpose()?;
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let scope = scope(conn, id, completeness)?;
            let group = scope.view.settings.get("group");
            let by = group.and_then(|g| g.get("by")).and_then(Value::as_str);
            let bucket = group.and_then(|g| g.get("bucket")).and_then(Value::as_str);
            if let Some(bucket) = bucket {
                if !matches!(bucket, "day" | "week" | "month" | "year") {
                    return Err(invalid("unknown date bucket"));
                }
                if !by.is_some_and(|field| {
                    matches!(field, "created_at" | "updated_at" | "occurred_at")
                        || field.starts_with("properties.")
                }) {
                    return Err(invalid("a date bucket requires a date field"));
                }
            }
            let (key_sql, join) = match by {
                None => ("'null'".into(), String::new()),
                Some("tags") => (
                    "json_quote(view_tags.tag)".into(),
                    "LEFT JOIN tags view_tags ON view_tags.item_id = items.id".into(),
                ),
                Some(field) if edge_ref(field).is_some() => {
                    let (backref, edge_type) = edge_ref(field).expect("matched edge field");
                    if !store::whole_edge_types(conn)?
                        .iter()
                        .any(|held| held == edge_type)
                    {
                        return Err(invalid(&format!(
                            "this copy cannot group by {field}: edge type {edge_type:?} is not held whole"
                        )));
                    }
                    let (own, other) = if backref {
                        ("target_id", "source_id")
                    } else {
                        ("source_id", "target_id")
                    };
                    (
                        format!("json_quote(view_edges.{other})"),
                        format!(
                            "LEFT JOIN (SELECT DISTINCT source_id,target_id FROM edges WHERE edge_type = {}) view_edges ON view_edges.{own} = items.id",
                            quoted(edge_type)
                        ),
                    )
                }
                Some(field) => (field_sql(field, &scope.catalog, true)?, String::new()),
            };
            let reads_properties =
                by.is_some_and(|field| field == "title" || field.starts_with("properties."));
            let readable = if reads_properties {
                "CASE WHEN json_valid(items.properties) THEN json_type(items.properties) = 'object' ELSE 0 END"
            } else {
                "1"
            };
            let sql = format!(
                "SELECT {key_sql}, {readable}, items.id FROM items {join} WHERE {}",
                scope.clauses.join(" AND ")
            );
            let mut statement = conn.prepare(&sql)?;
            let params = scope
                .values
                .iter()
                .map(store::sql_value)
                .collect::<Vec<_>>();
            let mut rows = statement.query(rusqlite::params_from_iter(params.iter()))?;
            let mut groups: HashMap<String, ViewGroup> = HashMap::new();
            while let Some(row) = rows.next()? {
                if !row.get::<_, bool>(1)? {
                    let item_id: String = row.get(2)?;
                    return Err(invalid(&format!(
                        "this copy cannot group the view: item {item_id} has unreadable properties"
                    )));
                }
                let raw: String = row.get(0)?;
                let mut key: Value = serde_json::from_str(&raw).map_err(|error| {
                    CoreError::Store(format!("cannot read view group: {error}"))
                })?;
                if let Some(bucket) = bucket {
                    key = date_bucket(&key, bucket, zone);
                }
                let entry = groups
                    .entry(group_identity(&key))
                    .or_insert_with(|| ViewGroup { key, count: 0 });
                entry.count = entry
                    .count
                    .checked_add(1)
                    .ok_or_else(|| invalid("view group count exceeds its range"))?;
            }
            let hidden: std::collections::HashSet<String> = group
                .and_then(|g| g.get("hidden"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(group_identity)
                .collect();
            let mut order = HashMap::new();
            for (index, key) in group
                .and_then(|g| g.get("order"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
            {
                order.entry(group_identity(key)).or_insert(index);
            }
            let mut rows: Vec<ViewGroup> = groups
                .into_values()
                .filter(|g| !hidden.contains(&group_identity(&g.key)))
                .collect();
            rows.sort_by(|a, b| {
                let rank = |key: &Value| {
                    order
                        .get(&group_identity(key))
                        .copied()
                        .unwrap_or(usize::MAX)
                };
                rank(&a.key)
                    .cmp(&rank(&b.key))
                    .then_with(|| compare_keys(&a.key, &b.key))
            });
            Ok(Rows { rows, completeness })
        })
    }
}

struct Scope {
    view: ViewRow,
    catalog: Catalog,
    clauses: Vec<String>,
    values: Vec<Value>,
}

fn scope(conn: &Connection, id: &str, completeness: Completeness) -> Result<Scope> {
    if completeness != Completeness::Complete {
        return Err(CoreError::HydrationIncomplete);
    }
    let item = store::item_by_id(conn, id)?.ok_or_else(|| CoreError::NotFound {
        code: "not_held".into(),
        message: format!(
            "view {id} is not held in this working copy: pin it or hydrate with {VIEW_TYPE}"
        ),
    })?;
    let view = ViewRow::of(item)?;
    if view.state != ItemState::Active {
        return Err(invalid("a revoked view cannot be evaluated"));
    }
    let mut settings = Settings::default();
    if let Some(query) = view.settings.get("query") {
        settings.query = serde_json::from_value(query.clone())
            .map_err(|error| invalid(&format!("the view's query is not supported: {error}")))?;
    }
    settings.query.tier.get_or_insert(SliceTier::All);
    if let Some(states) = &settings.query.state
        && (states.is_empty()
            || states
                .iter()
                .any(|s| !matches!(s.as_str(), "active" | "archived")))
    {
        return Err(invalid("a view query names active or archived states"));
    }
    let catalog = Catalog::load(conn)?;
    settings
        .refuse_unless_answerable(conn, &catalog)
        .map_err(view_error)?;
    let (mut clauses, mut values) = (Vec::new(), Vec::new());
    settings
        .narrow(
            &catalog,
            &store::whole_edge_types(conn)?,
            &mut clauses,
            &mut values,
        )
        .map_err(view_error)?;
    Ok(Scope {
        view,
        catalog,
        clauses,
        values,
    })
}

fn view_error(error: CoreError) -> CoreError {
    match error {
        CoreError::Invalid(message) => invalid(&message.replace("folder", "view")),
        other => other,
    }
}
fn invalid(message: &str) -> CoreError {
    CoreError::Invalid(message.into())
}
fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn property_name(field: &str) -> Result<&str> {
    let name = field
        .strip_prefix("properties.")
        .ok_or_else(|| invalid("a property field starts with properties."))?;
    let mut bytes = name.bytes();
    if !bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        || !bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(invalid(&format!("invalid property field {field:?}")));
    }
    Ok(name)
}

fn property_sql(name: &str, json: bool) -> String {
    let path = quoted(&format!("$.{}", Value::String(name.into())));
    let extract = format!("json_extract(items.properties,{path})");
    let scalar = if json {
        format!(
            "CASE json_type(items.properties,{path}) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE json_quote({extract}) END"
        )
    } else {
        format!(
            "CASE WHEN json_type(items.properties,{path}) IN ('integer','real') THEN CAST({extract} AS REAL) ELSE {extract} END"
        )
    };
    format!(
        "CASE WHEN json_valid(items.properties) THEN CASE WHEN json_type(items.properties,{path}) IN ('integer','real','text','true','false') THEN {scalar} ELSE {} END ELSE {} END",
        if json { "'null'" } else { "NULL" },
        if json { "'null'" } else { "NULL" }
    )
}

fn field_sql(field: &str, catalog: &Catalog, json: bool) -> Result<String> {
    if field.starts_with("properties.") {
        return Ok(property_sql(property_name(field)?, json));
    }
    let column = match field {
        "created_at" | "updated_at" | "occurred_at" | "type" | "state" | "tier" => {
            format!("items.{field}")
        }
        "title" => {
            let mut cases = Vec::new();
            for (id, _) in catalog.declared() {
                let name = catalog.title_property(id);
                if name != "title" {
                    cases.push(format!(
                        "WHEN {} THEN {}",
                        quoted(id),
                        property_sql(name, json)
                    ));
                }
            }
            return Ok(if cases.is_empty() {
                property_sql("title", json)
            } else {
                format!(
                    "CASE items.type {} ELSE {} END",
                    cases.join(" "),
                    property_sql("title", json)
                )
            });
        }
        "tags" => "(SELECT min(tag) FROM tags WHERE tags.item_id = items.id)".into(),
        _ => return Err(invalid(&format!("unsupported view field {field:?}"))),
    };
    Ok(if json {
        format!("json_quote({column})")
    } else {
        column
    })
}

fn sort_sql(settings: &Map<String, Value>, catalog: &Catalog) -> Result<String> {
    let Some(keys) = settings.get("sort") else {
        return Ok("ORDER BY items.occurred_at DESC, items.id DESC".into());
    };
    let keys = keys
        .as_array()
        .ok_or_else(|| invalid("a view sort must be a list"))?;
    if keys.len() > 10 {
        return Err(invalid("a view accepts at most 10 sort keys"));
    }
    if keys.is_empty() {
        return Ok("ORDER BY items.occurred_at DESC, items.id DESC".into());
    }
    let mut order = Vec::new();
    let mut timestamp_tie = None;
    for key in keys {
        let by = key
            .get("by")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("a sort key requires by"))?;
        let direction = match key.get("direction").and_then(Value::as_str) {
            Some("asc") => "ASC",
            Some("desc") => "DESC",
            _ => return Err(invalid("a sort direction is asc or desc")),
        };
        let expression = field_sql(by, catalog, false)?;
        order.push(format!("({expression}) IS NULL ASC"));
        order.push(format!("{expression} {direction}"));
        if keys.len() == 1 && matches!(by, "occurred_at" | "created_at" | "updated_at") {
            timestamp_tie = Some(direction);
        }
    }
    order.push(format!("items.id {}", timestamp_tie.unwrap_or("ASC")));
    Ok(format!("ORDER BY {}", order.join(", ")))
}

fn edge_ref(field: &str) -> Option<(bool, &str)> {
    let (backref, rest) = if let Some(rest) = field.strip_prefix("edge[") {
        (false, rest)
    } else {
        (true, field.strip_prefix("backref[")?)
    };
    let name = rest.strip_suffix(']')?;
    (!name.is_empty() && !name.contains([']', '[']) && !name.chars().any(char::is_whitespace))
        .then_some((backref, name))
}

fn group_identity(value: &Value) -> String {
    match value {
        Value::Number(number) if number.is_f64() => {
            let number = number.as_f64().expect("floating-point number");
            format!("number:{}", if number == 0.0 { 0.0 } else { number })
        }
        Value::Number(number) => format!("number:{number}"),
        _ => value.to_string(),
    }
}

fn compare_keys(a: &Value, b: &Value) -> std::cmp::Ordering {
    let rank = |v: &Value| match v {
        Value::Bool(_) | Value::Number(_) => 0,
        Value::String(_) => 1,
        _ => 2,
    };
    let number = |v: &Value| {
        v.as_f64()
            .unwrap_or_else(|| if v == &Value::Bool(true) { 1.0 } else { 0.0 })
    };
    rank(a).cmp(&rank(b)).then_with(|| match (a, b) {
        (Value::String(a), Value::String(b)) => a.cmp(b),
        _ => number(a)
            .total_cmp(&number(b))
            .then_with(|| a.to_string().cmp(&b.to_string())),
    })
}

fn date_bucket(value: &Value, bucket: &str, zone: Option<chrono_tz::Tz>) -> Value {
    let Some(text) = value.as_str() else {
        return Value::Null;
    };
    let date = if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        date
    } else {
        let Ok(normalized) = crate::time::normalize(text, "view date") else {
            return Value::Null;
        };
        let Ok(instant) = chrono::DateTime::parse_from_rfc3339(&normalized) else {
            return Value::Null;
        };
        match zone {
            Some(zone) => instant.with_timezone(&zone).date_naive(),
            None => instant.with_timezone(&chrono::Local).date_naive(),
        }
    };
    let date = match bucket {
        "week" => date.checked_sub_signed(chrono::TimeDelta::days(i64::from(
            date.weekday().num_days_from_monday(),
        ))),
        "month" => date.with_day(1),
        "year" => date.with_month(1).and_then(|d| d.with_day(1)),
        _ => Some(date),
    };
    date.map(|date| Value::String(date.format("%Y-%m-%d").to_string()))
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use crate::store::testing::{wire_item, wire_type};
    use crate::{Core, catalog, store};
    use serde_json::{Value, json};

    fn copy() -> Core {
        let core = Core::open_in_memory(None).unwrap();
        {
            let conn = core.conn().unwrap();
            store::replace_types(
                &conn,
                &[
                    wire_type("core.note", None, Some("title")),
                    wire_type("system.view", None, None),
                ],
            )
            .unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(
                &conn,
                store::META_SLICE_TYPES,
                r#"["core.note","system.view"]"#,
            )
            .unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "all").unwrap();
        }
        core
    }

    fn put(core: &Core, id: &str, properties: Value, tags: &[&str]) {
        let conn = core.conn().unwrap();
        let row = wire_item(
            id,
            "core.note",
            "active",
            "2026-01-01T00:00:00Z",
            properties,
        );
        store::put_server_item(
            &conn,
            &row,
            Some(&tags.iter().map(|s| s.to_string()).collect::<Vec<_>>()),
            &catalog::Catalog::load(&conn).unwrap(),
        )
        .unwrap();
    }

    fn view(core: &Core, settings: Value) {
        let conn = core.conn().unwrap();
        let row = wire_item(
            "view",
            "system.view",
            "active",
            "2026-01-01T00:00:00Z",
            json!({"title":"Notes","query":{"types":["core.note"]}})
                .as_object()
                .unwrap()
                .iter()
                .chain(settings.as_object().unwrap())
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<serde_json::Map<_, _>>()
                .into(),
        );
        store::put_server_item(
            &conn,
            &row,
            Some(&[]),
            &catalog::Catalog::load(&conn).unwrap(),
        )
        .unwrap();
    }

    fn ids(core: &Core) -> Vec<String> {
        core.list_in_view("view", None, None)
            .unwrap()
            .rows
            .into_iter()
            .map(|(item, _)| item.id)
            .collect()
    }

    #[test]
    fn property_sort_uses_server_scalar_order_and_keeps_nulls_last() {
        let core = copy();
        for (id, value) in [
            ("a", json!(false)),
            ("b", json!(0)),
            ("c", json!(2)),
            ("d", json!("2")),
            ("e", json!("")),
            ("f", json!(null)),
            ("g", json!([])),
            ("h", json!({})),
        ] {
            put(&core, id, json!({"rank":value}), &[]);
        }
        put(&core, "i", json!({}), &[]);
        view(
            &core,
            json!({"sort":[{"by":"properties.rank","direction":"asc"}]}),
        );
        assert_eq!(ids(&core), ["a", "b", "c", "e", "d", "f", "g", "h", "i"]);
        view(
            &core,
            json!({"sort":[{"by":"properties.rank","direction":"desc"}]}),
        );
        assert_eq!(ids(&core), ["d", "e", "c", "a", "b", "f", "g", "h", "i"]);
    }

    #[test]
    fn tag_groups_count_each_item_once() {
        let core = copy();
        put(&core, "a", json!({"amount":5}), &["x", "y"]);
        put(&core, "b", json!({"amount":"9"}), &["x"]);
        put(&core, "c", json!({}), &[]);
        view(&core, json!({"group":{"by":"tags","order":["y"]}}));
        let groups = core
            .view_groups("view", Some("Europe/London"))
            .unwrap()
            .rows;
        assert_eq!(
            groups.iter().map(|g| (&g.key, g.count)).collect::<Vec<_>>(),
            vec![(&json!("y"), 1), (&json!("x"), 2), (&Value::Null, 1)]
        );
    }

    #[test]
    fn several_sort_keys_unknown_fields_and_page_bounds_are_stable() {
        let core = copy();
        for (id, rank, title) in [("a", 1, "Z"), ("b", 1, "A"), ("c", 2, "B")] {
            put(&core, id, json!({"rank":rank,"title":title}), &[]);
        }
        view(
            &core,
            json!({"sort":[{"by":"properties.rank","direction":"asc"},{"by":"title","direction":"desc"}]}),
        );
        assert_eq!(ids(&core), ["a", "b", "c"]);
        assert_eq!(
            core.list_in_view("view", Some(1), Some(1)).unwrap().rows[0]
                .0
                .id,
            "b"
        );
        assert!(
            core.list_in_view("view", Some(0), None)
                .unwrap()
                .rows
                .is_empty()
        );
        assert!(
            core.list_in_view("view", Some(u32::MAX), Some(u32::MAX))
                .unwrap()
                .rows
                .is_empty()
        );
        view(
            &core,
            json!({"sort":[{"by":"properties.unknown","direction":"desc"}],"group":{"by":"properties.unknown"}}),
        );
        assert_eq!(ids(&core), ["a", "b", "c"]);
        let groups = core.view_groups("view", None).unwrap().rows;
        assert_eq!((groups[0].key.clone(), groups[0].count), (Value::Null, 3));
    }

    #[test]
    fn timestamp_ties_follow_the_server_direction() {
        let core = copy();
        put(&core, "a", json!({}), &[]);
        put(&core, "b", json!({}), &[]);
        for field in ["created_at", "updated_at", "occurred_at"] {
            view(&core, json!({"sort":[{"by":field,"direction":"desc"}]}));
            assert_eq!(ids(&core), ["b", "a"]);
            view(&core, json!({"sort":[{"by":field,"direction":"asc"}]}));
            assert_eq!(ids(&core), ["a", "b"]);
        }
    }

    #[test]
    fn calendar_buckets_use_local_dates_across_both_dst_changes() {
        let core = copy();
        for (id, date) in [
            ("a", "2026-03-29T00:30:00Z"),
            ("b", "2026-03-29T23:30:00Z"),
            ("c", "2026-10-25T00:30:00Z"),
            ("d", "2026-10-25T01:30:00Z"),
        ] {
            put(&core, id, json!({"date":date}), &[]);
        }
        put(&core, "e", json!({"date":"not a date"}), &[]);
        for (bucket, expected) in [
            (
                "day",
                vec![
                    (json!("2026-03-29"), 1),
                    (json!("2026-03-30"), 1),
                    (json!("2026-10-25"), 2),
                    (Value::Null, 1),
                ],
            ),
            (
                "week",
                vec![
                    (json!("2026-03-23"), 1),
                    (json!("2026-03-30"), 1),
                    (json!("2026-10-19"), 2),
                    (Value::Null, 1),
                ],
            ),
            (
                "month",
                vec![
                    (json!("2026-03-01"), 2),
                    (json!("2026-10-01"), 2),
                    (Value::Null, 1),
                ],
            ),
            ("year", vec![(json!("2026-01-01"), 4), (Value::Null, 1)]),
        ] {
            view(
                &core,
                json!({"group":{"by":"properties.date","bucket":bucket}}),
            );
            assert_eq!(
                core.view_groups("view", Some("Europe/London"))
                    .unwrap()
                    .rows
                    .into_iter()
                    .map(|g| (g.key, g.count))
                    .collect::<Vec<_>>(),
                expected
            );
        }
        assert!(
            core.view_groups("view", Some("Unknown/Zone"))
                .unwrap_err()
                .to_string()
                .contains("time zone")
        );
    }

    #[test]
    fn edge_groups_require_whole_edges_and_count_unlinked_items() {
        let core = copy();
        put(&core, "a", json!({}), &[]);
        put(&core, "b", json!({}), &[]);
        put(&core, "c", json!({}), &[]);
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_SLICE_EDGE_TYPES, r#"["parent-of"]"#).unwrap();
            for (id, source, target) in [("one", "a", "b"), ("two", "a", "c")] {
                store::upsert_edge(
                    &conn,
                    &crate::wire::WireEdge {
                        id: id.into(),
                        source_id: source.into(),
                        target_id: target.into(),
                        edge_type: "parent-of".into(),
                        properties: Default::default(),
                        version: 1,
                        created_at: "2026-01-01T00:00:00Z".into(),
                        updated_at: "2026-01-01T00:00:00Z".into(),
                    },
                )
                .unwrap();
            }
        }
        view(&core, json!({"group":{"by":"edge[parent-of]"}}));
        let groups = core.view_groups("view", None).unwrap().rows;
        assert_eq!(
            groups
                .iter()
                .map(|g| (g.key.clone(), g.count))
                .collect::<Vec<_>>(),
            [(json!("b"), 1), (json!("c"), 1), (Value::Null, 2)]
        );
        view(&core, json!({"group":{"by":"backref[parent-of]"}}));
        let groups = core.view_groups("view", None).unwrap().rows;
        assert_eq!(
            groups
                .iter()
                .map(|g| (g.key.clone(), g.count))
                .collect::<Vec<_>>(),
            [(json!("a"), 2), (Value::Null, 1)]
        );
        store::meta_set(&core.conn().unwrap(), store::META_SLICE_EDGE_TYPES, "[]").unwrap();
        assert!(
            core.view_groups("view", None)
                .unwrap_err()
                .to_string()
                .contains("not held whole")
        );
    }

    fn link(core: &Core, id: &str, source: &str, target: &str, edge_type: &str) {
        store::upsert_edge(
            &core.conn().unwrap(),
            &crate::wire::WireEdge {
                id: id.into(),
                source_id: source.into(),
                target_id: target.into(),
                edge_type: edge_type.into(),
                properties: Default::default(),
                version: 1,
                created_at: "2026-01-01T00:00:00Z".into(),
                updated_at: "2026-01-01T00:00:00Z".into(),
            },
        )
        .unwrap();
    }

    fn filtered(core: &Core, filter: &str) {
        view(
            core,
            json!({"query":{"types":["core.note"],"filter":filter}}),
        );
    }

    #[test]
    fn a_view_of_one_folders_items_follows_the_edge_and_leaves_the_rest() {
        let core = copy();
        for id in ["a", "b", "c", "d"] {
            put(&core, id, json!({}), &[]);
        }
        link(&core, "e1", "a", "folder-1", "in-folder");
        link(&core, "e2", "b", "folder-1", "in-folder");
        link(&core, "e3", "c", "folder-2", "in-folder");
        filtered(&core, r#"edge[in-folder] eq "folder-1""#);
        assert_eq!(ids(&core), ["b", "a"]);
        filtered(&core, "edge[in-folder] not_exists");
        assert_eq!(ids(&core), ["d"]);
    }

    #[test]
    fn a_view_by_source_lists_only_items_from_that_source() {
        let core = copy();
        put(&core, "a", json!({}), &[]);
        put(&core, "b", json!({}), &[]);
        core.conn()
            .unwrap()
            .execute("UPDATE items SET source = 'feed-reader' WHERE id = 'b'", [])
            .unwrap();
        filtered(&core, r#"source eq "feed-reader""#);
        assert_eq!(ids(&core), ["b"]);
        filtered(&core, r#"source neq "feed-reader""#);
        assert_eq!(ids(&core), ["a"]);
    }

    #[test]
    fn a_view_by_backref_is_answered_where_the_edge_type_is_held_whole_and_refused_otherwise() {
        let core = copy();
        for id in ["a", "b", "c"] {
            put(&core, id, json!({}), &[]);
        }
        link(&core, "e1", "a", "b", "parent-of");
        link(&core, "e2", "a", "c", "parent-of");
        filtered(&core, r#"backref[parent-of] eq "a""#);
        let refusal = core.list_in_view("view", None, None).unwrap_err();
        assert!(
            matches!(refusal, crate::CoreError::Invalid(_))
                && refusal.to_string().contains("backref"),
            "{refusal}"
        );
        store::meta_set(
            &core.conn().unwrap(),
            store::META_SLICE_EDGE_TYPES,
            r#"["parent-of"]"#,
        )
        .unwrap();
        assert_eq!(ids(&core), ["c", "b"]);
        filtered(&core, "backref[parent-of] not_exists");
        assert_eq!(ids(&core), ["a"]);
        filtered(&core, "backref[references] exists");
        assert!(
            core.view_groups("view", None)
                .unwrap_err()
                .to_string()
                .contains("backref")
        );
    }

    #[test]
    fn a_view_by_status_group_reads_the_types_words() {
        let core = copy();
        {
            let conn = core.conn().unwrap();
            let mut note = wire_type("core.note", None, Some("title"));
            note.rest.insert(
                "fields".into(),
                json!({ "status": { "type": "status", "status_values": [
                    { "value": "todo", "group": "not_started" },
                    { "value": "done", "group": "completed" }
                ] } }),
            );
            store::replace_types(&conn, &[note, wire_type("system.view", None, None)]).unwrap();
        }
        for (id, status) in [("a", "todo"), ("b", "done"), ("c", "pending")] {
            put(&core, id, json!({ "status": status }), &[]);
        }
        put(&core, "d", json!({}), &[]);
        filtered(&core, r#"status_group eq "completed""#);
        assert_eq!(ids(&core), ["b"]);
        filtered(&core, r#"status_group neq "completed""#);
        assert_eq!(ids(&core), ["a"]);
        filtered(&core, "status_group not_exists");
        assert_eq!(ids(&core), ["d", "c"]);
        filtered(&core, r#"status_group eq "done""#);
        assert!(
            core.list_in_view("view", None, None)
                .unwrap_err()
                .to_string()
                .contains("Unknown status group")
        );
    }

    #[test]
    fn grouping_honors_hidden_values() {
        let core = copy();
        put(&core, "a", json!({}), &["x"]);
        put(&core, "b", json!({}), &["y"]);
        view(&core, json!({"group":{"by":"tags"}}));
        assert_eq!(core.view_groups("view", None).unwrap().rows.len(), 2);
        view(&core, json!({"group":{"by":"tags","hidden":["x"]}}));
        let groups = core.view_groups("view", None).unwrap().rows;
        assert_eq!((groups.len(), groups[0].key.clone()), (1, json!("y")));
    }

    #[test]
    fn evaluation_refuses_partial_hydration_or_a_slice_missing_a_tier() {
        let core = copy();
        put(&core, "a", json!({"title":"pasta"}), &[]);
        view(&core, json!({}));
        assert_eq!(ids(&core), ["a"]);
        assert_eq!(
            core.search_in_view("pasta", "view", 10).unwrap().rows.len(),
            1
        );
        assert_eq!(
            core.list_views().unwrap().rows[0].settings["query"]["types"][0],
            "core.note"
        );
        store::meta_set(&core.conn().unwrap(), store::META_SLICE_TIER, "library").unwrap();
        assert!(
            core.list_in_view("view", None, None)
                .unwrap_err()
                .to_string()
                .contains("all tier")
        );
        assert!(
            core.search_in_view("pasta", "view", 10)
                .unwrap_err()
                .to_string()
                .contains("all tier")
        );
        assert!(
            core.view_groups("view", None)
                .unwrap_err()
                .to_string()
                .contains("all tier")
        );
        store::meta_set(&core.conn().unwrap(), store::META_SLICE_TIER, "all").unwrap();
        store::meta_set(
            &core.conn().unwrap(),
            store::META_HYDRATE_STATE,
            store::HYDRATE_IN_PROGRESS,
        )
        .unwrap();
        assert!(matches!(
            core.list_in_view("view", None, None),
            Err(crate::CoreError::HydrationIncomplete)
        ));
        assert!(matches!(
            core.view_groups("view", None),
            Err(crate::CoreError::HydrationIncomplete)
        ));
        assert!(matches!(
            core.search_in_view("pasta", "view", 10),
            Err(crate::CoreError::HydrationIncomplete)
        ));
        assert!(core.view("view").unwrap().is_some());
        assert_eq!(
            core.list_views().unwrap().completeness,
            crate::Completeness::Partial
        );

        // A copy whose cursor aged out answers its rows as stale, and a view
        // over them is refused all the same.
        {
            let conn = core.conn().unwrap();
            conn.execute(
                "DELETE FROM meta WHERE key IN (?1, ?2)",
                [store::META_HYDRATE_STATE, store::META_EVENT_CURSOR],
            )
            .unwrap();
            store::meta_set(&conn, store::META_REFILL, "{}").unwrap();
        }
        assert_eq!(
            core.list_views().unwrap().completeness,
            crate::Completeness::Stale
        );
        assert!(matches!(
            core.list_in_view("view", None, None),
            Err(crate::CoreError::HydrationIncomplete)
        ));
        assert!(matches!(
            core.view_groups("view", None),
            Err(crate::CoreError::HydrationIncomplete)
        ));
        assert!(matches!(
            core.search_in_view("pasta", "view", 10),
            Err(crate::CoreError::HydrationIncomplete)
        ));
    }
    #[test]
    fn tags_sort_by_the_first_lexical_tag_with_untagged_items_last() {
        let core = copy();
        put(&core, "a", json!({}), &["z", "c"]);
        put(&core, "b", json!({}), &["a", "y"]);
        put(&core, "c", json!({}), &["b"]);
        put(&core, "d", json!({}), &[]);
        view(&core, json!({"sort":[{"by":"tags","direction":"asc"}]}));
        assert_eq!(ids(&core), ["b", "c", "a", "d"]);
        view(&core, json!({"sort":[{"by":"tags","direction":"desc"}]}));
        assert_eq!(ids(&core), ["a", "c", "b", "d"]);
    }

    #[test]
    fn numeric_group_keys_match_equal_integer_and_real_values_but_not_booleans() {
        let core = copy();
        put(&core, "a", json!({"rank":1}), &[]);
        put(&core, "b", json!({"rank":1.0}), &[]);
        put(&core, "c", json!({"rank":true}), &[]);
        view(
            &core,
            json!({"group":{"by":"properties.rank","order":[1.0]}}),
        );
        let groups = core.view_groups("view", None).unwrap().rows;
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].count, 2);
        assert_eq!(groups[1].key, json!(true));
        view(
            &core,
            json!({"group":{"by":"properties.rank","hidden":[1.0]}}),
        );
        let groups = core.view_groups("view", None).unwrap().rows;
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].key, json!(true));
    }

    #[test]
    fn numeric_sort_uses_the_servers_double_precision_for_large_stored_integers() {
        let core = copy();
        put(&core, "a", json!({"rank":9007199254740993u64}), &[]);
        put(&core, "b", json!({"rank":9007199254740992u64}), &[]);
        view(
            &core,
            json!({"sort":[{"by":"properties.rank","direction":"asc"}]}),
        );
        assert_eq!(ids(&core), ["a", "b"]);
    }
    #[test]
    fn an_ungrouped_view_returns_one_count_and_stored_layouts_are_ignored() {
        let core = copy();
        put(&core, "a", json!({"amount":2}), &[]);
        put(&core, "b", json!({"amount":"3"}), &[]);
        put(&core, "c", json!({}), &[]);
        view(
            &core,
            json!({"layouts":[{"id":"list","kind":"chart","group":{"by":"tags"},"sort":[{"by":"title","direction":"asc"}]}]}),
        );
        let groups = core.view_groups("view", None).unwrap().rows;
        assert_eq!(
            groups,
            vec![super::ViewGroup {
                key: Value::Null,
                count: 3
            }]
        );
        assert_eq!(ids(&core), ["c", "b", "a"]);
        core.conn()
            .unwrap()
            .execute("DELETE FROM items WHERE type = 'core.note'", [])
            .unwrap();
        assert!(core.view_groups("view", None).unwrap().rows.is_empty());
    }

    #[test]
    fn title_sort_and_groups_use_literal_inherited_display_hint_fields() {
        let core = copy();
        {
            let conn = core.conn().unwrap();
            let mut child = wire_type("user.memo", Some("core.note"), None);
            child.display_hints = None;
            store::replace_types(
                &conn,
                &[
                    wire_type("core.note", None, Some("display.name")),
                    child,
                    wire_type("system.view", None, None),
                ],
            )
            .unwrap();
            let catalog = catalog::Catalog::load(&conn).unwrap();
            for (id, name) in [("a", "Z"), ("b", "A")] {
                let row = wire_item(
                    id,
                    "user.memo",
                    "active",
                    "2026-01-01T00:00:00Z",
                    json!({"display.name":name,"title":"ignored"}),
                );
                store::put_server_item(&conn, &row, Some(&[]), &catalog).unwrap();
            }
        }
        view(
            &core,
            json!({"sort":[{"by":"title","direction":"asc"}],"group":{"by":"title"}}),
        );
        assert_eq!(ids(&core), ["b", "a"]);
        assert_eq!(
            core.view_groups("view", None)
                .unwrap()
                .rows
                .into_iter()
                .map(|g| g.key)
                .collect::<Vec<_>>(),
            [json!("A"), json!("Z")]
        );
    }
    #[test]
    fn unreadable_properties_refuse_dependent_groups_instead_of_counting_them_missing() {
        let core = copy();
        put(&core, "a", json!({"title":"A","rank":1}), &["x"]);
        for by in ["title", "properties.rank", "properties.unknown"] {
            view(&core, json!({"group":{"by":by}}));
            for raw in ["{broken", "[]", "null", "true"] {
                core.conn()
                    .unwrap()
                    .execute(
                        "UPDATE items SET properties = ? WHERE id = 'a'",
                        [r#"{"title":"A","rank":1}"#],
                    )
                    .unwrap();
                assert_eq!(core.view_groups("view", None).unwrap().rows[0].count, 1);
                core.conn()
                    .unwrap()
                    .execute("UPDATE items SET properties = ? WHERE id = 'a'", [raw])
                    .unwrap();
                assert!(core.view_groups("view", None).is_err(), "{by}: {raw}");
            }
        }
        view(&core, json!({"group":{"by":"tags"}}));
        assert_eq!(
            core.view_groups("view", None).unwrap().rows[0].key,
            json!("x")
        );
    }
}

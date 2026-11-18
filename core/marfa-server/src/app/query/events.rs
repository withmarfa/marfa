//! The events a window reads, and the `parent-of` edges that bind a moved occurrence to its series.

use rusqlite::types::Value as Cell;
use serde_json::Value;

use super::compile::{Ask, Sql, States, judge_type, selection};
use super::reach::Reach;
use crate::app::items::Reader;
use crate::app::refusal::Result;

const EVENT_TYPE: &str = "core.event";
const PARENT_OF: &str = "parent-of";
const EDGE_BATCH: usize = 500;

const UNIX_EPOCH_DAY: f64 = 2_440_587.5;
const DAY_MS: f64 = 86_400_000.0;
/// An event no longer than this, by its start and end alone, can overlap a window only if it starts within this many days before it.
const SHORT_DAYS: f64 = 31.0;
/// A whole-day event is placed by its zone's midnights, which lie up to this many days from the instants its text names.
const ZONE_DAYS: f64 = 5.0;

/// Each expression and condition here is the one its partial index holds, or the planner cannot use the index.
const STARTS: &str = "json_extract(properties, '$.starts_at')";
const ENDS: &str = "json_extract(properties, '$.ends_at')";
const HAS_START: &str = "json_type(properties, '$.starts_at') = 'text'";
const IS_SERIES: &str = "json_type(properties, '$.recurrence') IN ('array', 'object', 'text', 'integer', 'real', 'true', 'false')";

/// The condition of `items_event_always`: a series, an event whose start or end no date function reads, and an event longer than [`SHORT_DAYS`].
fn always() -> String {
    format!(
        "{IS_SERIES} OR ({HAS_START} AND (julianday({STARTS}) IS NULL \
         OR (json_type(properties, '$.ends_at') = 'text' AND julianday({ENDS}) IS NULL) \
         OR COALESCE(CASE WHEN json_type(properties, '$.ends_at') = 'text' THEN julianday({ENDS}) END, \
                     julianday({STARTS}) + json_extract(properties, '$.duration') / 86400.0) \
            - julianday({STARTS}) > {SHORT_DAYS:?}))"
    )
}

/// The events a window can hold: those starting near it, every series, long or undatable event, and every exception of a series read.
fn candidates(from_ms: i64, to_ms: i64) -> Sql {
    let day = |ms: i64| ms as f64 / DAY_MS + UNIX_EPOCH_DAY;
    let (from, to) = (day(from_ms), day(to_ms));
    let mut sql = Sql::new(&format!(
        "SELECT seq FROM items INDEXED BY items_event_start WHERE {HAS_START} \
           AND julianday({STARTS}) BETWEEN "
    ));
    sql.bind(Cell::Real(from - SHORT_DAYS - ZONE_DAYS));
    sql.push(" AND ");
    sql.bind(Cell::Real(to + ZONE_DAYS));
    sql.push(&format!(
        " UNION SELECT seq FROM items INDEXED BY items_event_always WHERE {} \
         UNION SELECT x.seq FROM (SELECT id FROM items INDEXED BY items_event_always WHERE {}) s \
           CROSS JOIN edges e INDEXED BY edges_from ON e.from_id = s.id AND e.edge_type = '{PARENT_OF}' \
           CROSS JOIN items x ON x.id = e.to_id \
         WHERE json_type(x.properties, '$.original_starts_at') = 'text'",
        always(),
        always()
    ));
    sql
}

/// How an event states its `recurrence`.
#[derive(Debug)]
pub enum Recurrence {
    Absent,
    Entries(Vec<Value>),
    NotAList,
}

#[derive(Debug)]
pub struct Event {
    pub seq: i64,
    pub id: String,
    pub type_id: String,
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
    pub duration: Option<f64>,
    pub all_day: bool,
    pub timezone: Option<String>,
    pub recurrence: Recurrence,
    pub original_starts_at: Option<String>,
}

fn text(path: &str) -> String {
    format!(
        "CASE WHEN json_type(i.properties, '{path}') = 'text' THEN json_extract(i.properties, '{path}') END"
    )
}

/// The active events the caller reads that a window can hold: a `type` filter narrows the answer, not the matching.
pub(crate) fn events(
    read: &Reader<'_, '_>,
    named: Option<&str>,
    (from_ms, to_ms): (i64, i64),
) -> Result<Vec<Event>> {
    let reach = Reach::of(read)?;
    if let Some(named) = named {
        judge_type(read, named)?;
    }
    let ask = Ask {
        types: vec![EVENT_TYPE.to_string()],
        states: States::Named(vec!["active".to_string()]),
        ..Ask::default()
    };
    let mut sql = Sql::new(&format!(
        "SELECT i.seq, i.id, i.type, {}, {}, \
         CASE WHEN json_type(i.properties, '$.duration') IN ('integer', 'real') \
              THEN json_extract(i.properties, '$.duration') END, \
         COALESCE(json_type(i.properties, '$.all_day') = 'true', 0), {}, \
         json_type(i.properties, '$.recurrence'), json_extract(i.properties, '$.recurrence'), {} \
         FROM (",
        text("$.starts_at"),
        text("$.ends_at"),
        text("$.timezone"),
        text("$.original_starts_at"),
    ));
    sql.append(&candidates(from_ms, to_ms));
    sql.push(") c CROSS JOIN items i ON i.seq = c.seq WHERE ");
    sql.append(&selection(&reach, &ask, &read.catalog, false)?);
    sql.push(" ORDER BY i.seq");
    let mut statement = read.tx.prepare_cached(&sql.text)?;
    let rows = statement.query_map(rusqlite::params_from_iter(&sql.values), |row| {
        let kind: Option<String> = row.get(8)?;
        let recurrence = match (kind.as_deref(), row.get::<_, Cell>(9)?) {
            (None | Some("null"), _) => Recurrence::Absent,
            (Some("array"), Cell::Text(entries)) => match serde_json::from_str(&entries) {
                Ok(Value::Array(entries)) => Recurrence::Entries(entries),
                _ => Recurrence::NotAList,
            },
            _ => Recurrence::NotAList,
        };
        Ok(Event {
            seq: row.get(0)?,
            id: row.get(1)?,
            type_id: row.get(2)?,
            starts_at: row.get(3)?,
            ends_at: row.get(4)?,
            duration: row.get(5)?,
            all_day: row.get(6)?,
            timezone: row.get(7)?,
            recurrence,
            original_starts_at: row.get(10)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The `(from, to)` of every `parent-of` edge into one of `targets`, oldest edge first.
pub(crate) fn parents(read: &Reader<'_, '_>, targets: &[&str]) -> Result<Vec<(String, String)>> {
    let mut found: Vec<(i64, String, String)> = Vec::new();
    for batch in targets.chunks(EDGE_BATCH) {
        let mut sql =
            Sql::new("SELECT e.seq, e.from_id, e.to_id FROM edges e WHERE e.edge_type = ");
        sql.bind(PARENT_OF.to_string());
        sql.push(" AND e.to_id IN (");
        sql.list(batch);
        sql.push(")");
        let mut statement = read.tx.prepare_cached(&sql.text)?;
        let rows = statement.query_map(rusqlite::params_from_iter(&sql.values), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        for row in rows {
            found.push(row?);
        }
    }
    found.sort_by_key(|(seq, _, _)| *seq);
    Ok(found
        .into_iter()
        .map(|(_, source, target)| (source, target))
        .collect())
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};
    use serde_json::{Value as Json, json};

    use super::*;

    fn held() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../../db/migrations/0001_baseline.sql"))
            .unwrap();
        db
    }

    fn put(db: &Connection, seq: i64, properties: &Json) {
        db.execute(
            "INSERT INTO items (seq, id, type, state, tier, source, version, schema_version, \
             occurred_at, created_at, updated_at, last_activity_at, properties) \
             VALUES (?1, ?2, 'core.event', 'active', 'library', 'test', 1, 1, \
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', \
             '2026-01-01T00:00:00Z', jsonb(?3))",
            params![seq, format!("event-{seq}"), properties.to_string()],
        )
        .unwrap();
    }

    const HOUR: i64 = 3_600_000;
    const DAY: i64 = 24 * HOUR;

    fn day(offset: i64) -> i64 {
        instant("2028-01-01T00:00:00Z") + offset * DAY
    }

    fn read(db: &Connection, from: i64, to: i64) -> Vec<i64> {
        let sql = candidates(from, to);
        let mut statement = db
            .prepare(&format!("SELECT seq FROM ({}) ORDER BY seq", sql.text))
            .unwrap();
        statement
            .query_map(rusqlite::params_from_iter(&sql.values), |row| row.get(0))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap()
    }

    fn instant(text: &str) -> i64 {
        marfa_rules::time::epoch_ms(text).unwrap()
    }

    /// A one-off event that overlaps the window, by its stated start and end or its duration.
    fn overlaps(event: &Json, from: i64, to: i64) -> bool {
        let start = instant(event["starts_at"].as_str().unwrap());
        let end = match (event["ends_at"].as_str(), event["duration"].as_f64()) {
            (Some(end), _) => instant(end),
            (None, Some(seconds)) => start + (seconds * 1000.0) as i64,
            (None, None) => start,
        };
        if end > start {
            start < to && end > from
        } else {
            start >= from && start < to
        }
    }

    #[test]
    fn a_window_reads_the_events_near_it_by_index_and_none_of_the_rest() {
        let db = held();
        for at in 0..3_000_i64 {
            let start = day(at - 1_500);
            put(
                &db,
                at + 1,
                &json!({
                    "starts_at": marfa_rules::time::written(start),
                    "ends_at": marfa_rules::time::written(start + HOUR),
                }),
            );
        }
        let sql = candidates(day(0), day(1));
        let mut statement = db
            .prepare(&format!("EXPLAIN QUERY PLAN {}", sql.text))
            .unwrap();
        let plan: Vec<String> = statement
            .query_map(rusqlite::params_from_iter(&sql.values), |row| row.get(3))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        let plan = plan.join("\n");
        assert!(
            plan.contains("SEARCH items USING INDEX items_event_start"),
            "{plan}"
        );
        assert!(
            plan.contains("USING INDEX items_event_always")
                && plan.contains("SEARCH e USING INDEX edges_from")
                && plan.contains("SEARCH x USING"),
            "{plan}"
        );
        assert!(
            !plan.contains("SCAN items\n") && !plan.ends_with("SCAN items"),
            "{plan}"
        );

        let near = read(&db, day(0), day(1));
        assert!(
            (1..=60).contains(&near.len()),
            "{} of 3000 events read for a one-day window",
            near.len()
        );
        // Witness: a window of the whole range reads them all, so the narrow read left events out on purpose.
        assert_eq!(read(&db, day(-1_600), day(1_600)).len(), 3_000);
    }

    #[test]
    fn every_event_that_overlaps_a_window_is_read() {
        let db = held();
        let mut events = vec![
            json!({"starts_at": "2028-02-01T00:00:00Z", "ends_at": "2028-03-01T00:00:00Z"}),
            json!({"starts_at": "2028-03-01T00:00:00Z", "ends_at": "2028-03-01T01:00:00Z"}),
            json!({"starts_at": "2028-03-02T00:00:00Z"}),
            json!({"starts_at": "2028-02-29T23:00:00Z", "ends_at": "2028-03-01T00:00:00Z"}),
            json!({"starts_at": "2028-03-01T23:00:00-12:00", "ends_at": "2028-03-02T00:00:00-12:00"}),
            json!({"starts_at": "2028-03-01T12:00:00+14:00", "duration": 3600}),
            json!({"starts_at": "2020-01-01T00:00:00Z", "ends_at": "2030-01-01T00:00:00Z"}),
            json!({"starts_at": "2020-01-01T00:00:00Z", "duration": 3_000_000_000.0}),
            json!({"starts_at": "2028-02-10", "ends_at": "2028-04-01", "all_day": true}),
            json!({"starts_at": "2028-03-01", "all_day": true, "timezone": "Pacific/Kiritimati"}),
            json!({"starts_at": "2028-03-01", "all_day": true, "timezone": "Pacific/Pago_Pago"}),
            json!({"starts_at": "2028-02-28", "ends_at": "2028-03-01", "all_day": true}),
            json!({"starts_at": "not a time", "ends_at": "2028-03-01T00:00:00Z"}),
            json!({"starts_at": "2028-03-01T00:00:00Z", "ends_at": "not a time"}),
            json!({"starts_at": "2027-12-25T00:00:00Z", "ends_at": "2028-03-01T00:00:00.001Z"}),
        ];
        for at in -40..=40 {
            events.push(json!({
                "starts_at": marfa_rules::time::written(day(60) + at * 7 * HOUR),
                "duration": f64::from(((at * 37).rem_euclid(5_000_000)) as i32),
            }));
        }
        for (at, event) in events.iter().enumerate() {
            put(&db, at as i64 + 1, event);
        }
        let windows = [
            (day(60), day(61)),
            (day(60) + HOUR, day(60) + 2 * HOUR),
            (
                instant("2028-03-01T00:00:00Z"),
                instant("2028-03-02T00:00:00Z"),
            ),
            (
                instant("2028-03-01T01:00:00Z"),
                instant("2028-03-01T02:00:00Z"),
            ),
            (
                instant("2028-03-02T00:00:00Z"),
                instant("2028-03-03T00:00:00Z"),
            ),
            (
                instant("2028-03-01T00:00:00Z"),
                instant("2028-03-01T00:00:00.001Z"),
            ),
            (
                instant("2028-02-01T00:00:00Z"),
                instant("2028-05-01T00:00:00Z"),
            ),
        ];
        for (from, to) in windows {
            let read = read(&db, from, to);
            for (at, event) in events.iter().enumerate() {
                let dated = event["starts_at"]
                    .as_str()
                    .is_some_and(|text| marfa_rules::time::epoch_ms(text).is_some())
                    && event["ends_at"]
                        .as_str()
                        .is_none_or(|text| marfa_rules::time::epoch_ms(text).is_some());
                if !dated {
                    assert!(
                        read.contains(&(at as i64 + 1)),
                        "an event no date function reads is always read: {event} in {from} to {to}"
                    );
                } else if overlaps(event, from, to) {
                    assert!(
                        read.contains(&(at as i64 + 1)),
                        "{event} overlaps {from} to {to} and was not read"
                    );
                }
            }
        }
    }

    fn bind(db: &Connection, seq: i64, series: i64, exception: i64) {
        db.execute(
            "INSERT INTO edges (seq, id, from_id, to_id, edge_type, properties, version, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 'parent-of', jsonb('{}'), 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            params![
                seq,
                format!("edge-{seq}"),
                format!("event-{series}"),
                format!("event-{exception}")
            ],
        )
        .unwrap();
    }

    #[test]
    fn a_series_and_every_exception_bound_to_it_are_read() {
        let db = held();
        put(
            &db,
            1,
            &json!({"starts_at": "2020-01-01T10:00:00Z", "recurrence": ["RRULE:FREQ=DAILY"]}),
        );
        put(
            &db,
            2,
            &json!({"starts_at": "2020-01-02T12:00:00Z", "original_starts_at": "2028-05-02T10:00:00Z"}),
        );
        put(&db, 3, &json!({"starts_at": "2019-01-01T00:00:00Z"}));
        // An event naming a slot but bound to no series is read only by its own start.
        put(
            &db,
            4,
            &json!({"starts_at": "2019-01-02T12:00:00Z", "original_starts_at": "2028-05-02T10:00:00Z"}),
        );
        // A child that is no exception is not read for being a child.
        put(&db, 5, &json!({"starts_at": "2019-01-03T00:00:00Z"}));
        bind(&db, 1, 1, 2);
        bind(&db, 2, 1, 5);
        for window in [
            ("2028-05-01T00:00:00Z", "2028-05-04T00:00:00Z"),
            ("2028-06-01T00:00:00Z", "2028-06-04T00:00:00Z"),
        ] {
            assert_eq!(
                read(&db, instant(window.0), instant(window.1)),
                vec![1, 2],
                "{window:?}"
            );
        }
    }

    #[test]
    fn an_exception_is_read_for_a_slot_long_before_a_window_the_occurrence_still_overlaps() {
        let db = held();
        // A monthly series of 20-day occurrences: the slot of 2028-05-02 overlaps a window of 2028-05-15.
        put(
            &db,
            1,
            &json!({
                "starts_at": "2028-05-02T10:00:00Z",
                "duration": 20 * 86_400,
                "recurrence": ["RRULE:FREQ=MONTHLY"],
            }),
        );
        put(
            &db,
            2,
            &json!({"starts_at": "2030-08-01T00:00:00Z", "original_starts_at": "2028-05-02T10:00:00Z"}),
        );
        bind(&db, 1, 1, 2);
        let (from, to) = (
            instant("2028-05-15T00:00:00Z"),
            instant("2028-05-16T00:00:00Z"),
        );
        assert!(
            instant("2028-05-02T10:00:00Z") < from - 10 * DAY,
            "the slot lies more than 10 days before the window"
        );
        assert_eq!(read(&db, from, to), vec![1, 2]);
    }
}

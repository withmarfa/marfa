//! The SQL that keys a value for ordering, shared by the server and a working copy: a table's `order` column, a datetime and a text that reads as one.

/// Milliseconds since the epoch of `local`, a date and time read as UTC.
const LOCAL_MS: &str = "CAST(round((julianday(local) - 2440587.5) * 86400000.0) AS INTEGER)";

const DATE_SHAPE: &str = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]";

/// Whether `column` may be written into [`order_value_key_sql`]'s SQL.
pub fn order_column_inlinable(column: &str) -> bool {
    column
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// The key of the `column` value in the JSON `body` expression: a datetime as UTC milliseconds, a date as itself, a number or a string as it is, and NULL for no value or a value of another kind.
///
/// `column` is inlined in the SQL, so it must pass [`order_column_inlinable`].
pub fn order_value_key_sql(kind: &str, column: &str, body: &str) -> String {
    let path = format!("'$.{column}'");
    let value = format!("json_extract({body}, {path})");
    let typed = |test: &str| format!("json_type({body}, {path}) {test}");
    match kind {
        "number" | "integer" => format!(
            "CASE WHEN {} THEN {value} END",
            typed("IN ('integer', 'real')")
        ),
        "string" => format!("CASE WHEN {} THEN {value} END", typed("= 'text'")),
        "date" => format!(
            "(SELECT CASE WHEN v GLOB '{DATE_SHAPE}' AND date(v) IS v THEN v END \
             FROM (SELECT {value} AS v WHERE {}))",
            typed("= 'text'")
        ),
        _ => format!(
            "(SELECT {} FROM (SELECT {value} AS v WHERE {}))",
            instant_ms(),
            typed("= 'text'")
        ),
    }
}

/// NULL for an `item` column, whose values sort as none whoever reads them.
pub fn column_key_sql(kind: &str, column: &str, body: &str) -> String {
    if kind == super::ITEM_KIND || !order_column_inlinable(column) {
        return "NULL".to_string();
    }
    if super::KEYED_KINDS.contains(&kind) {
        return order_value_key_sql(kind, column, body);
    }
    crate::query::column_sort_expression(body, &format!("'$.{column}'"))
}

/// `v` as UTC milliseconds; the offset is applied here so every offset the time rule takes counts.
fn instant_ms() -> String {
    let at = |local: &str| LOCAL_MS.replace("local", local);
    let offset_ms = "(CASE substr(v, -6, 1) WHEN '-' THEN -60000 ELSE 60000 END) \
         * (CAST(substr(v, -5, 2) AS INTEGER) * 60 + CAST(substr(v, -2) AS INTEGER))";
    format!(
        "CASE \
         WHEN date(substr(v, 1, 10)) IS NOT substr(v, 1, 10) THEN NULL \
         WHEN length(v) = 10 THEN {date} \
         WHEN substr(v, 11, 1) <> 'T' THEN NULL \
         WHEN v GLOB '*Z' THEN {utc} \
         WHEN v GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr(v, -5, 2) AS INTEGER) < 24 \
         AND CAST(substr(v, -2) AS INTEGER) < 60 THEN {zoned} - {offset_ms} \
         END",
        date = at("v"),
        utc = at("substr(v, 1, length(v) - 1)"),
        zoned = at("substr(v, 1, length(v) - 6)"),
    )
}

/// The last instant SQLite writes as a date, 9999-12-31T23:59:59.999Z, in milliseconds since the epoch.
const LAST_MS: i64 = 253_402_300_799_999;

/// The key of a text that may read as a datetime: its UTC instant to the millisecond as `YYYY-MM-DDTHH:MM:SS.sssZ`, else the text itself.
/// An instant before the year 0000 keys as `-001-...`; one after `9999-12-31T23:59:59.999Z` keys as that text, `+` and the milliseconds beyond it. `value` is evaluated once.
pub fn text_key_sql(value: &str) -> String {
    format!("{}{value}{TEXT_KEY_CLOSE}", text_key_open())
}

/// The SQL before the value [`text_key_sql`] keys, for a caller that writes the value itself.
pub fn text_key_open() -> String {
    let ms = instant_ms();
    format!(
        "(SELECT CASE WHEN v GLOB '{DATE_SHAPE}*' THEN COALESCE(\
         strftime('%Y-%m-%dT%H:%M:%fZ', ({ms}) / 1000.0, 'unixepoch'), \
         CASE WHEN ({ms}) IS NOT NULL THEN '9999-12-31T23:59:59.999Z+' || printf('%09d', ({ms}) - {LAST_MS}) END, \
         v) ELSE v END \
         FROM (SELECT "
    )
}

/// The SQL after the value [`text_key_sql`] keys.
pub const TEXT_KEY_CLOSE: &str = " AS v))";

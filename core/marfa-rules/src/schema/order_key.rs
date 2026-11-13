//! The SQL expression that keys a row for its table's `order` column, shared by the server and a working copy.

/// Milliseconds since the epoch of `local`, a date and time read as UTC.
const LOCAL_MS: &str = "CAST(round((julianday(local) - 2440587.5) * 86400000.0) AS INTEGER)";

/// Whether `column` may be written into [`order_value_key_sql`]'s SQL.
pub fn order_column_inlinable(column: &str) -> bool {
    column
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// The key of the `column` value in the JSON `body` expression: a datetime as UTC milliseconds, a number or a string as it is, and NULL for no value or a value of another kind.
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
        _ => format!(
            "(SELECT {} FROM (SELECT {value} AS v WHERE {}))",
            instant_ms(),
            typed("= 'text'")
        ),
    }
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

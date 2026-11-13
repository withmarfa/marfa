//! The key a table keeps its rows in order by, as one SQL expression for writes, rebuilds and reads.

/// The column a table names as its `order`, and that column's kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Order {
    pub column: String,
    pub kind: String,
}

impl Order {
    pub(crate) fn of(table: &serde_json::Map<String, serde_json::Value>) -> Option<Order> {
        let (column, kind) = marfa_rules::schema::order_of(table)?;
        marfa_rules::schema::order_column_inlinable(&column).then_some(Order { column, kind })
    }

    /// What a table summary records once every row's key is this order's.
    pub(crate) fn signature(&self) -> String {
        format!("{}:{}", self.kind, self.column)
    }

    pub(crate) fn from_signature(signature: &str) -> Option<Order> {
        let (kind, column) = signature.split_once(':')?;
        Some(Order {
            column: column.to_string(),
            kind: kind.to_string(),
        })
    }

    fn path(&self) -> String {
        format!("'$.{}'", self.column)
    }

    /// The key of the value in `body`: a datetime as UTC milliseconds, NULL for none or another kind.
    pub(crate) fn value_key_sql(&self, body: &str) -> String {
        marfa_rules::schema::order_value_key_sql(&self.kind, &self.column, body)
    }

    /// As [`Order::value_key_sql`], and NULL for a value `refs` holds as an item's id.
    pub(crate) fn key_sql(&self, body: &str, refs: &str) -> String {
        format!(
            "CASE WHEN json_extract({refs}, {}) IS NULL THEN {} END",
            self.path(),
            self.value_key_sql(body)
        )
    }

    /// As [`Order::key_sql`], with [`NO_KEY`] for NULL, so the index holds every row of the table.
    pub(crate) fn stored_key_sql(&self, body: &str, refs: &str) -> String {
        format!("COALESCE({}, {NO_KEY})", self.key_sql(body, refs))
    }
}

/// The stored key of a row with no key, after every number and text in SQLite's order.
pub(crate) const NO_KEY: &str = "X''";

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use rusqlite::types::Value as Bound;
    use serde_json::json;

    use super::Order;

    fn key(kind: &str, value: serde_json::Value, refs: Option<serde_json::Value>) -> Bound {
        let order = Order {
            column: "at".into(),
            kind: kind.into(),
        };
        let body = json!({ "at": value }).to_string();
        let refs = refs.map(|refs| refs.to_string());
        let db = Connection::open_in_memory().unwrap();
        db.query_row(
            &format!("SELECT {}", order.key_sql("jsonb(?1)", "jsonb(?2)")),
            rusqlite::params![body, refs],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn a_datetime_keys_as_its_instant_whatever_its_offset() {
        for written in [
            "2026-11-10T09:30:00Z",
            "2026-11-10T10:30:00+01:00",
            "2026-11-10T09:30:00.000Z",
            "2026-11-09T21:30-12:00",
            "2026-11-10T09:30:00.123Z",
            "2026-11-10T23:29:00.123+13:59",
            "0000-01-01T00:00:00Z",
            "0000-01-01T05:00:00+04:00",
            "9999-12-31T23:59:59.999Z",
            "2026-11-10",
        ] {
            let expected = marfa_rules::time::epoch_ms(written)
                .or_else(|| marfa_rules::time::epoch_ms(&format!("{written}T00:00:00Z")));
            assert_eq!(
                key("datetime", json!(written), None),
                Bound::Integer(expected.unwrap()),
                "{written}"
            );
        }
        assert_eq!(
            key("datetime", json!("2026-11-10T09:30:00Z"), None),
            key("datetime", json!("2026-11-10T19:29:00+09:59"), None),
        );
        let beyond = key("datetime", json!("9999-12-31T23:59:59.999-23:59"), None);
        let last = key("datetime", json!("9999-12-31T23:59:59.999Z"), None);
        assert!(matches!((beyond, last), (Bound::Integer(b), Bound::Integer(l)) if b > l));
    }

    #[test]
    fn a_value_of_another_kind_or_written_as_an_item_s_id_has_no_key() {
        for odd in [
            json!("now"),
            json!("2026-02-30"),
            json!("2026-11-10 09:30Z"),
            json!("2026-11-10T09:30+99:00"),
            json!(3),
            json!(true),
        ] {
            assert_eq!(key("datetime", odd.clone(), None), Bound::Null, "{odd}");
        }
        assert_eq!(key("number", json!("3"), None), Bound::Null);
        assert_eq!(key("number", json!(2.5), None), Bound::Real(2.5));
        assert_eq!(key("integer", json!(7), None), Bound::Integer(7));
        assert_eq!(key("string", json!(7), None), Bound::Null);
        assert_eq!(key("string", json!("b"), None), Bound::Text("b".into()));
        assert_eq!(
            key("string", json!("b"), Some(json!({ "at": "b" }))),
            Bound::Null
        );
        assert_eq!(
            key("string", json!("b"), Some(json!({ "other": "c" }))),
            Bound::Text("b".into())
        );
    }
}

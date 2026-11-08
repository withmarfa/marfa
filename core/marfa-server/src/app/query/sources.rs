use std::collections::BTreeSet;

use super::compile::Sql;
use super::reach::Reach;
use crate::app::items::Reader;
use crate::app::refusal::Result;

const PRESENT_SOURCES: &str = "WITH RECURSIVE present(name) AS (
        SELECT MIN(source) FROM items
        UNION ALL
        SELECT (SELECT MIN(source) FROM items WHERE source > present.name)
        FROM present WHERE present.name IS NOT NULL
    ) SELECT name FROM present WHERE name IS NOT NULL";

fn any_row(read: &Reader<'_, '_>, reach: &Reach, source: &str) -> Result<bool> {
    let mut sql = Sql::new("SELECT EXISTS (SELECT 1 FROM items i WHERE i.source = ");
    sql.bind(source.to_string());
    sql.push(" AND ");
    reach.clause(&mut sql, "i", false);
    sql.push(")");
    let mut statement = read.tx.prepare_cached(&sql.text)?;
    Ok(statement.query_row(rusqlite::params_from_iter(&sql.values), |row| row.get(0))?)
}

pub(crate) fn carries(read: &Reader<'_, '_>, source: &str) -> Result<bool> {
    any_row(read, &Reach::held(read)?, source)
}

pub(crate) fn carried(read: &Reader<'_, '_>) -> Result<BTreeSet<String>> {
    let reach = Reach::held(read)?;
    let every = read.caller.manages_keys();
    let present: Vec<String> = read
        .tx
        .prepare_cached(PRESENT_SOURCES)?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut kept = BTreeSet::new();
    for source in present {
        if every || any_row(read, &reach, &source)? {
            kept.insert(source);
        }
    }
    Ok(kept)
}

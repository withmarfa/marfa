use super::compile::{Ask, Sql, judge, selection};
use super::reach::Reach;
use crate::app::items::Reader;
use crate::app::refusal::Result;

/// The rows an export of `ask` selects after `after`, in `seq` order, as the caller reads them.
pub(crate) fn selected(read: &Reader<'_, '_>, ask: &Ask, after: i64, limit: i64) -> Result<Vec<i64>> {
    let reach = Reach::of(read)?;
    judge(read, ask)?;
    let mut sql = Sql::new("SELECT i.seq FROM items i WHERE ");
    sql.append(&selection(&reach, ask, &read.catalog, true)?);
    sql.push(" AND i.seq > ");
    sql.bind(after);
    sql.push(" ORDER BY i.seq LIMIT ");
    sql.bind(limit);
    let mut statement = read.tx.prepare_cached(&sql.text)?;
    let found = statement.query_map(rusqlite::params_from_iter(&sql.values), |row| row.get(0))?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

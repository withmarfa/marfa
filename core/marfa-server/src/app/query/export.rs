use super::compile::{Ask, Sql, judge, selection};
use super::reach::Reach;
use crate::app::items::Reader;
use crate::app::refusal::Result;

/// A row an export selects, and the bytes its properties and extensions take in the store.
pub(crate) struct Chosen {
    pub seq: i64,
    pub stored: usize,
}

/// The rows an export of `ask` selects after `after`, in `seq` order, as the caller reads them.
pub(crate) fn selected(
    read: &Reader<'_, '_>,
    ask: &Ask,
    after: i64,
    limit: i64,
) -> Result<Vec<Chosen>> {
    let reach = Reach::of(read)?;
    judge(read, ask)?;
    let mut sql = Sql::new(
        "SELECT i.seq, length(i.properties) + coalesce((SELECT sum(length(e.data)) \
         FROM item_extensions e WHERE e.item_seq = i.seq), 0) FROM items i WHERE ",
    );
    sql.append(&selection(&reach, ask, &read.catalog, true)?);
    sql.push(" AND i.seq > ");
    sql.bind(after);
    sql.push(" ORDER BY i.seq LIMIT ");
    sql.bind(limit);
    let mut statement = read.tx.prepare_cached(&sql.text)?;
    let found = statement.query_map(rusqlite::params_from_iter(&sql.values), |row| {
        Ok(Chosen {
            seq: row.get(0)?,
            stored: row.get::<_, i64>(1)?.max(0) as usize,
        })
    })?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

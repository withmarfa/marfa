use rusqlite::params_from_iter;

use super::compile::Sql;
use super::reach::Reach;
use crate::app::items::{Reader, is_system};
use crate::app::refusal::{Refusal, Result};

pub struct Titled {
    pub id: String,
    pub title: String,
}

/// A kind of item the overview lists by title, with the most it lists.
pub struct Listed {
    pub type_id: &'static str,
    pub limit: i64,
}

pub struct Held {
    /// Active items the caller may read, by type, in the namespaces but `system`.
    pub counts: Vec<(String, i64)>,
    /// For each `Listed`, how many the caller may read and the first by title.
    pub titled: Vec<(i64, Vec<Titled>)>,
}

pub(crate) fn held(read: &Reader<'_, '_>, listed: &[Listed]) -> Result<Held> {
    let reach = Reach::held(read)?;
    let titled = listed
        .iter()
        .map(|kind| titles(read, &reach, kind))
        .collect::<Result<_>>()?;
    Ok(Held {
        counts: counts(read, &reach)?,
        titled,
    })
}

fn counts(read: &Reader<'_, '_>, reach: &Reach) -> Result<Vec<(String, i64)>> {
    let reach = reach.narrowed(|type_id| !is_system(type_id));
    if reach.is_empty() {
        return Ok(Vec::new());
    }
    let mut sql = Sql::new("SELECT i.type, COUNT(*) FROM items i WHERE i.state = 'active' AND ");
    reach.clause(&mut sql, "i", false);
    sql.push(" GROUP BY i.type");
    let mut statement = read.tx.prepare_cached(&sql.text)?;
    let found = statement.query_map(params_from_iter(&sql.values), |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

fn titles(read: &Reader<'_, '_>, reach: &Reach, kind: &Listed) -> Result<(i64, Vec<Titled>)> {
    let reach = reach.narrowed(|held| held == kind.type_id);
    if reach.is_empty() {
        return Ok((0, Vec::new()));
    }
    let mut selected = Sql::new("FROM items i WHERE i.state = 'active' AND ");
    reach.clause(&mut selected, "i", false);
    let mut count = Sql::new("SELECT COUNT(*) ");
    count.append(&selected);
    let total: i64 = read
        .tx
        .prepare_cached(&count.text)?
        .query_row(params_from_iter(&count.values), |row| row.get(0))?;
    let mut page = Sql::new("SELECT i.id, i.properties ->> '$.title' ");
    page.append(&selected);
    page.push(" ORDER BY 2, 1 LIMIT ");
    page.bind(kind.limit);
    let mut statement = read.tx.prepare_cached(&page.text)?;
    let rows = statement.query_map(params_from_iter(&page.values), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    let mut titled = Vec::new();
    for row in rows {
        let (id, title) = row?;
        let title = title
            .ok_or_else(|| Refusal::internal(&format!("{} {id} has no title", kind.type_id)))?;
        titled.push(Titled { id, title });
    }
    Ok((total, titled))
}

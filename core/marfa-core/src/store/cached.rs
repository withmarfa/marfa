use rusqlite::{Connection, Params, Result, Row};

/// `execute` and `query_row` that keep the prepared statement, where rusqlite's own prepare it again on every call.
pub(crate) trait Cached {
    fn execute_cached(&self, sql: &str, params: impl Params) -> Result<usize>;

    fn query_row_cached<T>(
        &self,
        sql: &str,
        params: impl Params,
        map: impl FnOnce(&Row<'_>) -> Result<T>,
    ) -> Result<T>;
}

impl Cached for Connection {
    fn execute_cached(&self, sql: &str, params: impl Params) -> Result<usize> {
        self.prepare_cached(sql)?.execute(params)
    }

    fn query_row_cached<T>(
        &self,
        sql: &str,
        params: impl Params,
        map: impl FnOnce(&Row<'_>) -> Result<T>,
    ) -> Result<T> {
        self.prepare_cached(sql)?.query_row(params, map)
    }
}

//! A local, read-only working copy of a declared slice of one Marfa server:
//! hydrated over HTTP, kept current from the event log, queried locally.

mod catalog;
mod catch_up;
mod error;
mod http;
mod hydrate;
mod model;
mod query;
mod search;
mod sse;
mod store;
mod wire;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;

pub use error::CoreError;
pub use model::{
    CatchUpReport, Edge, HydrateReport, Hydration, Item, ItemState, ListFilters, SearchHit, Sort,
    SortDirection, SortField, Status, Tier,
};

pub type Result<T> = std::result::Result<T, CoreError>;

/// Where the slice comes from. The key is held in memory and never written.
#[derive(Debug, Clone)]
pub struct Server {
    pub url: String,
    pub key: String,
}

pub struct Core {
    conn: Mutex<Connection>,
    http: Option<http::Http>,
    catch_up_idle: Duration,
}

const DEFAULT_CATCH_UP_IDLE: Duration = Duration::from_secs(3);

impl Core {
    /// Opens the file at `path`, creating it and its schema when absent. A
    /// file bound to a different server than `server` is refused.
    pub fn open(path: impl AsRef<Path>, server: Option<Server>) -> Result<Core> {
        Self::from_connection(store::open(path.as_ref())?, server)
    }

    pub fn open_in_memory(server: Option<Server>) -> Result<Core> {
        Self::from_connection(store::open_in_memory()?, server)
    }

    /// How long a silent event stream is read before catch-up decides it has
    /// nothing more to replay.
    pub fn with_catch_up_idle(mut self, idle: Duration) -> Core {
        self.catch_up_idle = idle;
        self
    }

    fn from_connection(conn: Connection, server: Option<Server>) -> Result<Core> {
        let http = match server {
            Some(server) => Some(http::Http::new(&server.url, &server.key)?),
            None => None,
        };
        if let Some(http) = &http
            && let Some(expected) = store::meta_get(&conn, store::META_SERVER_ORIGIN)?
            && expected != http.origin()
        {
            return Err(CoreError::WrongServer {
                expected,
                got: http.origin(),
            });
        }
        Ok(Core {
            conn: Mutex::new(conn),
            http,
            catch_up_idle: DEFAULT_CATCH_UP_IDLE,
        })
    }

    /// Replaces the local copy with every item of the declared `types` at
    /// `tier`, with their tags and outbound edges, and stores the event
    /// cursor to catch up from.
    pub fn hydrate(&self, types: &[String], tier: Tier) -> Result<HydrateReport> {
        hydrate::hydrate(self, self.http()?, types, tier)
    }

    /// Applies every event since the stored cursor and advances it.
    pub fn catch_up(&self) -> Result<CatchUpReport> {
        catch_up::catch_up(self, self.http()?, self.catch_up_idle)
    }

    pub fn list(&self, filters: &ListFilters, sort: Sort) -> Result<Vec<Item>> {
        let conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        let catalog = catalog::Catalog::load(&conn)?;
        query::list(&conn, &catalog, filters, sort)
    }

    pub fn get(&self, id: &str) -> Result<Option<Item>> {
        let conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        store::item_by_id(&conn, id)
    }

    pub fn edges_from(&self, id: &str) -> Result<Vec<Edge>> {
        let conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        store::edges_from(&conn, id)
    }

    /// Full-text search over titles, bodies and tags, best match first.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let conn = self.conn()?;
        store::refuse_unless_hydrated(&conn)?;
        search::search(&conn, query, limit)
    }

    pub fn status(&self) -> Result<Status> {
        let conn = self.conn()?;
        let slice_types = match store::meta_get(&conn, store::META_SLICE_TYPES)? {
            Some(json) => serde_json::from_str(&json)?,
            None => Vec::new(),
        };
        let slice_tier = match store::meta_get(&conn, store::META_SLICE_TIER)? {
            Some(text) => Some(text.parse()?),
            None => None,
        };
        let event_cursor = store::meta_get(&conn, store::META_EVENT_CURSOR)?;
        let hydration = if !store::hydration_complete(&conn)? {
            Hydration::InProgress
        } else if event_cursor.is_some() && !slice_types.is_empty() {
            Hydration::Complete
        } else {
            Hydration::Never
        };
        Ok(Status {
            server_origin: store::meta_get(&conn, store::META_SERVER_ORIGIN)?,
            slice_types,
            slice_tier,
            event_cursor,
            hydration,
            items: store::count(&conn, "items")?,
            edges: store::count(&conn, "edges")?,
        })
    }

    fn http(&self) -> Result<&http::Http> {
        self.http.as_ref().ok_or(CoreError::NoServer)
    }

    pub(crate) fn conn(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| CoreError::Store("the connection was poisoned by an earlier panic".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unreachable_server(url: &str) -> Option<Server> {
        Some(Server {
            url: url.into(),
            key: "marfa_k1_test".into(),
        })
    }

    #[test]
    fn reads_refuse_while_a_hydration_is_in_progress() {
        let core = Core::open_in_memory(None).unwrap();
        assert!(
            core.list(&ListFilters::default(), Sort::default())
                .unwrap()
                .is_empty()
        );
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_HYDRATE_STATE, store::HYDRATE_IN_PROGRESS).unwrap();
        }
        assert_eq!(
            core.list(&ListFilters::default(), Sort::default()),
            Err(CoreError::HydrationIncomplete)
        );
        assert_eq!(core.search("x", 5), Err(CoreError::HydrationIncomplete));
        assert_eq!(core.status().unwrap().hydration, Hydration::InProgress);
        {
            let conn = core.conn().unwrap();
            store::meta_delete(&conn, store::META_HYDRATE_STATE).unwrap();
        }
        assert_eq!(core.status().unwrap().hydration, Hydration::Never);
    }

    #[test]
    fn server_calls_need_a_server_and_catch_up_needs_a_cursor() {
        let offline = Core::open_in_memory(None).unwrap();
        assert_eq!(
            offline.hydrate(&["core.note".into()], Tier::Library),
            Err(CoreError::NoServer)
        );
        assert_eq!(offline.catch_up(), Err(CoreError::NoServer));
        let fresh = Core::open_in_memory(unreachable_server("http://127.0.0.1:9")).unwrap();
        assert_eq!(fresh.catch_up(), Err(CoreError::NoCursor));
        assert!(matches!(
            fresh.hydrate(&[], Tier::Library),
            Err(CoreError::Invalid(_))
        ));
        assert!(matches!(
            fresh.hydrate(&["*".into()], Tier::Library),
            Err(CoreError::Invalid(_))
        ));
    }

    #[test]
    fn a_file_bound_to_one_server_refuses_another() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        {
            let core = Core::open(&path, unreachable_server("http://one.test:8600/")).unwrap();
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_SERVER_ORIGIN, "http://one.test:8600").unwrap();
        }
        assert!(Core::open(&path, unreachable_server("HTTP://ONE.test:8600")).is_ok());
        assert!(Core::open(&path, None).is_ok());
        assert_eq!(
            Core::open(&path, unreachable_server("http://two.test:8600")).err(),
            Some(CoreError::WrongServer {
                expected: "http://one.test:8600".into(),
                got: "http://two.test:8600".into()
            })
        );
    }
}

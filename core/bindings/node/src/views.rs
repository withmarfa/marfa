//! Local view reads and writes through the server's view door.

use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{
    Completeness, Found, ItemState, Listing, MarfaCore, SearchHit, count, failure, item, record,
    rethrown,
};

#[napi(object)]
pub struct ViewRow {
    pub id: String,
    pub version: i64,
    pub state: ItemState,
    #[napi(ts_type = "Record<string, unknown>")]
    pub settings: serde_json::Value,
}

#[napi(object)]
pub struct Views {
    pub views: Vec<ViewRow>,
    pub completeness: Completeness,
}

#[napi(object)]
pub struct ViewGroup {
    #[napi(ts_type = "string | number | boolean | null")]
    pub key: serde_json::Value,
    pub count: i64,
    pub sum: Option<f64>,
}

#[napi(object)]
pub struct ViewGroups {
    pub groups: Vec<ViewGroup>,
    pub completeness: Completeness,
}

fn row(value: marfa_core::ViewRow) -> ViewRow {
    ViewRow {
        id: value.id,
        version: value.version,
        state: value.state.into(),
        settings: value.settings.into(),
    }
}

enum ViewWrite {
    Create,
    Change { id: String, version: i64 },
}

pub struct WriteView {
    core: Arc<marfa_core::Core>,
    write: ViewWrite,
    settings: serde_json::Map<String, serde_json::Value>,
    idempotency_key: Option<String>,
    failed: Option<marfa_core::CoreError>,
}

#[napi]
impl Task for WriteView {
    type Output = marfa_core::ViewRow;
    type JsValue = ViewRow;

    fn compute(&mut self) -> Result<Self::Output> {
        match &self.write {
            ViewWrite::Create => self
                .core
                .create_view(&self.settings, self.idempotency_key.as_deref()),
            ViewWrite::Change { id, version } => self.core.change_view(
                id,
                &self.settings,
                *version,
                self.idempotency_key.as_deref(),
            ),
        }
        .map_err(|error| record(&mut self.failed, error))
    }

    fn resolve(&mut self, _: Env, value: Self::Output) -> Result<Self::JsValue> {
        Ok(row(value))
    }

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }
}

pub struct DeleteView {
    core: Arc<marfa_core::Core>,
    id: String,
    idempotency_key: Option<String>,
    failed: Option<marfa_core::CoreError>,
}

#[napi]
impl Task for DeleteView {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .delete_view(&self.id, self.idempotency_key.as_deref())
            .map_err(|error| record(&mut self.failed, error))
    }

    fn resolve(&mut self, _: Env, _: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }
}

fn settings_object(
    env: Env,
    value: serde_json::Value,
) -> Result<serde_json::Map<String, serde_json::Value>> {
    match value {
        serde_json::Value::Object(settings) => Ok(settings),
        _ => Err(failure(
            env,
            marfa_core::CoreError::Invalid("view settings must be an object".into()),
        )),
    }
}

#[napi]
impl MarfaCore {
    #[napi]
    pub fn create_view(
        &self,
        env: Env,
        #[napi(ts_arg_type = "Record<string, unknown>")] settings: serde_json::Value,
        idempotency_key: Option<String>,
    ) -> Result<AsyncTask<WriteView>> {
        Ok(AsyncTask::new(WriteView {
            core: Arc::clone(&self.inner),
            write: ViewWrite::Create,
            settings: settings_object(env, settings)?,
            idempotency_key,
            failed: None,
        }))
    }

    #[napi]
    pub fn change_view(
        &self,
        env: Env,
        id: String,
        #[napi(ts_arg_type = "Record<string, unknown>")] changes: serde_json::Value,
        version: i64,
        idempotency_key: Option<String>,
    ) -> Result<AsyncTask<WriteView>> {
        Ok(AsyncTask::new(WriteView {
            core: Arc::clone(&self.inner),
            write: ViewWrite::Change { id, version },
            settings: settings_object(env, changes)?,
            idempotency_key,
            failed: None,
        }))
    }

    #[napi]
    pub fn delete_view(
        &self,
        id: String,
        idempotency_key: Option<String>,
    ) -> AsyncTask<DeleteView> {
        AsyncTask::new(DeleteView {
            core: Arc::clone(&self.inner),
            id,
            idempotency_key,
            failed: None,
        })
    }

    #[napi]
    pub fn list_views(&self, env: Env) -> Result<Views> {
        let rows = self
            .inner
            .list_views()
            .map_err(|error| failure(env, error))?;
        Ok(Views {
            views: rows.rows.into_iter().map(row).collect(),
            completeness: rows.completeness.into(),
        })
    }

    #[napi]
    pub fn view(&self, env: Env, id: String) -> Result<Option<ViewRow>> {
        Ok(self
            .inner
            .view(&id)
            .map_err(|error| failure(env, error))?
            .map(row))
    }

    #[napi]
    pub fn list_in_view(
        &self,
        env: Env,
        id: String,
        layout: Option<String>,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Listing> {
        let rows = self
            .inner
            .list_in_view(&id, layout.as_deref(), limit, offset)
            .map_err(|error| failure(env, error))?;
        Ok(Listing {
            items: rows
                .rows
                .into_iter()
                .map(|(value, _)| item(value))
                .collect(),
            completeness: rows.completeness.into(),
        })
    }

    #[napi]
    pub fn search_in_view(
        &self,
        env: Env,
        query: String,
        id: String,
        limit: Option<u32>,
    ) -> Result<Found> {
        let rows = self
            .inner
            .search_in_view(&query, &id, limit.unwrap_or(20) as usize)
            .map_err(|error| failure(env, error))?;
        Ok(Found {
            hits: rows
                .rows
                .into_iter()
                .map(|(hit, _)| SearchHit {
                    item: item(hit.item),
                    score: hit.score,
                    snippet: hit.snippet,
                })
                .collect(),
            completeness: rows.completeness.into(),
        })
    }

    #[napi]
    pub fn view_groups(
        &self,
        env: Env,
        id: String,
        layout: String,
        time_zone: Option<String>,
    ) -> Result<ViewGroups> {
        let rows = self
            .inner
            .view_groups(&id, &layout, time_zone.as_deref())
            .map_err(|error| failure(env, error))?;
        Ok(ViewGroups {
            groups: rows
                .rows
                .into_iter()
                .map(|group| ViewGroup {
                    key: group.key,
                    count: count(group.count),
                    sum: group.sum,
                })
                .collect(),
            completeness: rows.completeness.into(),
        })
    }
}

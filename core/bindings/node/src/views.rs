//! Views read from the working copy without contacting the server.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{Completeness, Found, ItemState, Listing, MarfaCore, SearchHit, count, failure, item};

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

#[napi]
impl MarfaCore {
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

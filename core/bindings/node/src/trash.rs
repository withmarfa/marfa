//! Previewing and trashing several items at once.

use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{MarfaCore, count, record, rethrown};

/// What trashing items would take, as the server read it.
#[napi(object)]
pub struct TrashPreview {
    /// Each named item once, in the order named.
    pub items: Vec<TrashPreviewItem>,
    /// Every item the key may read that the trash would take, each once.
    pub count: i64,
    /// Passed back unchanged to `trashItems` so the trash covers only this.
    pub digest: String,
}

#[napi(object)]
pub struct TrashPreviewItem {
    pub id: String,
    #[napi(js_name = "type")]
    pub type_: String,
    pub version: i64,
    /// What the trash takes with this item, leaves first, at most 100.
    pub takes: Vec<TrashTaken>,
    pub count: i64,
    /// `takes` was cut at its limit.
    pub truncated: bool,
}

#[napi(object)]
pub struct TrashTaken {
    pub id: String,
    #[napi(js_name = "type")]
    pub type_: String,
    pub version: i64,
}

fn taken(taken: marfa_core::TrashTaken) -> TrashTaken {
    TrashTaken {
        id: taken.id,
        type_: taken.r#type,
        version: taken.version,
    }
}

fn preview(preview: marfa_core::TrashPreview) -> TrashPreview {
    TrashPreview {
        items: preview
            .items
            .into_iter()
            .map(|item| TrashPreviewItem {
                id: item.id,
                type_: item.r#type,
                version: item.version,
                takes: item.takes.into_iter().map(taken).collect(),
                count: count(item.count),
                truncated: item.truncated,
            })
            .collect(),
        count: count(preview.count),
        digest: preview.digest,
    }
}

/// The count is not sent with a trash, so one a caller made negative changes nothing.
fn core_preview(preview: TrashPreview) -> marfa_core::TrashPreview {
    marfa_core::TrashPreview {
        items: preview
            .items
            .into_iter()
            .map(|item| marfa_core::TrashPreviewItem {
                id: item.id,
                r#type: item.type_,
                version: item.version,
                takes: item
                    .takes
                    .into_iter()
                    .map(|taken| marfa_core::TrashTaken {
                        id: taken.id,
                        r#type: taken.type_,
                        version: taken.version,
                    })
                    .collect(),
                count: u64::try_from(item.count).unwrap_or(0),
                truncated: item.truncated,
            })
            .collect(),
        count: u64::try_from(preview.count).unwrap_or(0),
        digest: preview.digest,
    }
}

pub struct PreviewTrash {
    core: Arc<marfa_core::Core>,
    ids: Vec<String>,
    failed: Option<marfa_core::CoreError>,
}

#[napi]
impl Task for PreviewTrash {
    type Output = marfa_core::TrashPreview;
    type JsValue = TrashPreview;

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .preview_trash(&self.ids)
            .map_err(|error| record(&mut self.failed, error))
    }

    fn resolve(&mut self, _: Env, read: Self::Output) -> Result<Self::JsValue> {
        Ok(preview(read))
    }

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }
}

pub struct TrashItems {
    core: Arc<marfa_core::Core>,
    preview: marfa_core::TrashPreview,
    failed: Option<marfa_core::CoreError>,
}

#[napi]
impl Task for TrashItems {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .trash_items(&self.preview)
            .map_err(|error| record(&mut self.failed, error))
    }

    fn resolve(&mut self, _: Env, _: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }
}

#[napi]
impl MarfaCore {
    /// What trashing `ids` would take, read from the server and held nowhere
    /// in the copy. An id named twice counts once. Rejects `validation` for
    /// no id or more than 20 distinct ones, `no_server` for a copy with none,
    /// and `network` offline. Any other copy than the one the server holds
    /// rejects `copy_expired`.
    #[napi]
    pub fn preview_trash(&self, ids: Vec<String>) -> AsyncTask<PreviewTrash> {
        AsyncTask::new(PreviewTrash {
            core: Arc::clone(&self.inner),
            ids,
            failed: None,
        })
    }

    /// Moves what `preview` names, and what it says the trash takes, to the
    /// bin on the server at once, all or none, never queued. Rejects
    /// `invalid`, naming how to clear each write, before anything is sent,
    /// while a write waits for a named item or one the preview lists under
    /// `takes` (for a truncated preview, for any item); `copy_expired` for
    /// another instance at the origin; and the server's refusal, with the
    /// copy and the queue as they were. `network` after the request went out
    /// may follow a trash the server made, which the item events then show.
    /// Once it resolves, every item the copy holds among them is in the bin
    /// in the copy.
    #[napi]
    pub fn trash_items(&self, preview: TrashPreview) -> AsyncTask<TrashItems> {
        AsyncTask::new(TrashItems {
            core: Arc::clone(&self.inner),
            preview: core_preview(preview),
            failed: None,
        })
    }
}

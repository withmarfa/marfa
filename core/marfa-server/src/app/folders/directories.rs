//! The directories of a folder's placed files, counted for one request.

use serde_json::{Value, json};

use super::FOLDER_TYPE;
use crate::app::access::{Caller, Level};
use crate::app::edges;
use crate::app::items::{readable_of, reading};
use crate::app::refusal::Result;

const PLACEMENT: &str = "in-folder";

/// Read as `GET /folders/{id}/status` is, and then only the placements the caller may read.
pub async fn read(
    app: &crate::app::App,
    caller: &Caller,
    folder_id: String,
    under: Vec<String>,
) -> Result<String> {
    reading(app, caller, move |read| {
        read.caller.require_reach()?;
        readable_of(read.tx, &read.caller, &folder_id, FOLDER_TYPE)?;
        read.caller.require_edge(PLACEMENT, Level::Read)?;
        let tree = edges::directories(read.tx, &read.caller, &read.catalog, &folder_id, &under)?;
        let directories: Vec<Value> = tree
            .directories
            .iter()
            .map(|directory| {
                json!({
                    "path": directory.path,
                    "direct_files": directory.direct_files,
                    "all_files": directory.all_files,
                    "has_directories": directory.has_directories,
                })
            })
            .collect();
        Ok(json!({
            "folder_id": folder_id,
            "under": under.join("/"),
            "direct_files": tree.direct_files,
            "total_files": tree.total_files,
            "directories": directories,
        })
        .to_string())
    })
    .await
}

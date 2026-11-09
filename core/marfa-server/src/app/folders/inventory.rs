//! The active folders, newest first, without their settings.

use serde_json::{Value, json};

use super::FOLDER_TYPE;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::{newest_of, parsed, reading};
use crate::app::refusal::Result;

const UNTITLED: &str = "Untitled folder";
const SCOPE: &str = "folders";

pub struct Page {
    pub limit: i64,
    pub cursor: Option<String>,
}

/// The title with its whitespace trimmed and each run of it collapsed to one space.
pub(super) fn shown(title: Option<&str>) -> String {
    let words: Vec<&str> = title.unwrap_or_default().split_whitespace().collect();
    if words.is_empty() {
        UNTITLED.to_string()
    } else {
        words.join(" ")
    }
}

pub async fn list(app: &App, caller: &Caller, page: Page) -> Result<String> {
    reading(app, caller, move |read| {
        let after = page
            .cursor
            .as_deref()
            .map(|cursor| read.cursors.open_at(SCOPE, cursor))
            .transpose()?;
        let rows = newest_of(
            read.tx,
            FOLDER_TYPE,
            "active",
            after
                .as_ref()
                .map(|(created, id)| (created.as_str(), id.as_str())),
            page.limit + 1,
        )?;
        let more = rows.len() as i64 > page.limit;
        let rows = &rows[..rows.len().min(page.limit as usize)];
        let mut data = Vec::with_capacity(rows.len());
        for row in rows {
            let properties = parsed(&row.properties)?;
            data.push(json!({
                "id": row.id,
                "title": shown(properties.get("title").and_then(Value::as_str)),
                "created_at": row.created_at,
            }));
        }
        let next_cursor = match rows.last().filter(|_| more) {
            Some(last) => Value::from(read.cursors.issue_at(SCOPE, &last.created_at, &last.id)?),
            None => Value::Null,
        };
        Ok(json!({ "data": data, "next_cursor": next_cursor }).to_string())
    })
    .await
}

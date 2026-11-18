//! Previewing and trashing several items at once.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::model::{QueuedWrite, Verdict};
use crate::{Core, CoreError, Result, catch_up, drain, store};

/// The most items one preview or trash names.
pub const TRASH_MOST: usize = 20;

/// A server preview whose digest binds the trash to the previewed state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrashPreview {
    /// Each named item once, in the order named.
    pub items: Vec<TrashPreviewItem>,
    /// The number of distinct readable items the trash would take.
    pub count: u64,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrashPreviewItem {
    pub id: String,
    pub r#type: String,
    pub version: i64,
    /// What the trash takes with this item, leaves first, at most 100.
    pub takes: Vec<TrashTaken>,
    pub count: u64,
    /// `takes` was cut at its limit.
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrashTaken {
    pub id: String,
    pub r#type: String,
    pub version: i64,
}

fn refused(message: String) -> CoreError {
    CoreError::Validation {
        server: None,
        code: "validation_error".into(),
        message,
        details: None,
    }
}

fn waits(write: &QueuedWrite) -> bool {
    matches!(write.verdict, None | Some(Verdict::Blocked | Verdict::Dead))
}

impl Core {
    /// Requires a server; duplicate IDs count once toward the 20-item limit.
    pub fn preview_trash(&self, ids: &[String]) -> Result<TrashPreview> {
        let ids = distinct_ids(ids)?;
        let http = self.http()?;
        catch_up::refuse_another_instance(self, http)?;
        catch_up::write_naming_instance(self, http, |http| http.preview_item_trash(&ids))
    }

    /// Never queued: the digest binds the request to the previewed state.
    pub fn trash_items(&self, preview: &TrashPreview) -> Result<()> {
        self.lock.refuse_unless_writer()?;
        let named: Vec<String> = preview.items.iter().map(|item| item.id.clone()).collect();
        let named = distinct_ids(&named)?;
        let mut every = named.clone();
        let mut seen: HashSet<&str> = named.iter().map(String::as_str).collect();
        for taken in preview.items.iter().flat_map(|item| &item.takes) {
            if seen.insert(&taken.id) {
                every.push(taken.id.clone());
            }
        }
        let truncated = preview.items.iter().any(|item| item.truncated);
        let held = {
            let conn = self.conn()?;
            store::refuse_unless_usable(&conn)?;
            let mut waiting: Vec<QueuedWrite> = Vec::new();
            if truncated {
                waiting.extend(
                    store::queued_writes(&conn)?
                        .into_iter()
                        .filter(|write| write.item_id.is_some() && waits(write)),
                );
            } else {
                for id in &every {
                    waiting.extend(store::waiting_writes_for_item(&conn, id)?);
                }
            }
            drop(conn);
            if !waiting.is_empty() {
                let why = if truncated {
                    "the preview lists only part of what the trash takes, so no waiting write can be ruled out"
                } else {
                    "they would go to rows that are in the bin"
                };
                return Err(CoreError::Invalid(format!(
                    "{} write(s) still waiting to be sent for these items would be left behind ({why}); clear each before trashing, by the command named for it: {}",
                    waiting.len(),
                    self.exits_of(&waiting)?
                )));
            }
            store::items_by_ids(&*self.conn()?, &every)?
        };
        let http = self.http()?;
        catch_up::refuse_another_instance(self, http)?;
        let key = uuid::Uuid::now_v7().to_string();
        catch_up::write_naming_instance(self, http, |http| {
            http.trash_items(&named, &preview.digest, &key)
        })?;
        self.lay_trashed(held.iter().map(|item| item.id.as_str()));
        Ok(())
    }

    /// A failed read does not undo the accepted trash.
    fn lay_trashed<'a>(&self, ids: impl Iterator<Item = &'a str>) {
        let reads: Vec<drain::ReadBack> = ids
            .filter_map(|id| drain::read_back_trashed(self, id).ok())
            .collect();
        let laid = self.conn().and_then(|mut conn| {
            let tx = conn.transaction()?;
            for read in &reads {
                drain::apply_read_back(&tx, read)?;
            }
            tx.commit()?;
            Ok(())
        });
        drop(laid);
    }
}

fn distinct_ids(ids: &[String]) -> Result<Vec<String>> {
    let mut seen = HashSet::new();
    let ids: Vec<String> = ids
        .iter()
        .filter(|id| seen.insert(id.as_str()))
        .cloned()
        .collect();
    if ids.is_empty() || ids.len() > TRASH_MOST {
        return Err(refused(format!(
            "ids: name from 1 to {TRASH_MOST} distinct items, not {}",
            ids.len()
        )));
    }
    Ok(ids)
}

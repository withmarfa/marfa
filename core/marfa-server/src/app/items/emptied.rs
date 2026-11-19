//! Emptying the bin, a page of rows at a time.

use std::collections::HashSet;

use serde_json::{Value, json};

use super::{Listing, bin_selection, write};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::refusal::{Code, Refusal, Result};

/// How many rows a page of the bin holds.
pub const PAGE: i64 = 200;

pub struct Emptied {
    pub purged: usize,
    pub failures: Vec<Value>,
    pub next_cursor: Option<String>,
}

impl Emptied {
    pub fn to_json(&self) -> Value {
        json!({
            "purged": self.purged,
            "failures": self.failures,
            "next_cursor": self.next_cursor,
        })
    }
}

/// What the owner may be told of a change that did not happen: nothing the
/// row's fields, a type or a key could have put in a message.
pub fn safe(refusal: Refusal) -> Refusal {
    if refusal.commit_failed {
        if refusal.code == Code::InsufficientStorage {
            return refusal;
        }
        return Refusal::new(
            Code::InternalError,
            "The change may have completed, but its result could not be confirmed. Read the \
             item again before trying again.",
        )
        .with_detail("write_outcome", "unknown");
    }
    let message = match refusal.code {
        Code::InvalidTransition => "This item is no longer in the required state. Read it again.",
        Code::EdgeConstraintViolation => {
            "Another item prevents this item from moving to the trash."
        }
        Code::ItemNotFound => "This item is no longer available.",
        _ => "The change could not be completed. Read the item again before trying again.",
    };
    Refusal::new(refusal.code, message)
}

pub fn page_of(cursor: Option<String>) -> Listing {
    Listing {
        type_id: None,
        q: String::new(),
        limit: PAGE,
        cursor,
    }
}

/// Each row is purged at the version the page read, in a write of its own so that other
/// requests pass between pages. A row already gone is not a failure.
pub async fn empty_page(app: &App, caller: &Caller, cursor: Option<String>) -> Result<Emptied> {
    caller.require(Permission::ItemsPurge)?;
    let (selected, mut next_cursor) = bin_selection(app, caller, page_of(cursor)).await?;
    let mut purged = 0;
    let mut taken: HashSet<String> = HashSet::new();
    let mut failures = Vec::new();
    for (id, version) in selected {
        if taken.contains(&id) {
            continue;
        }
        match write::purge_owned(app, caller, id.clone(), version).await {
            Ok((done, removed)) if done.status == 200 => {
                purged += removed.len();
                taken.extend(removed);
            }
            Ok(_) => failures.push(json!({
                "id": id,
                "code": Code::VersionConflict.wire(),
                "message": "This item changed and was kept.",
            })),
            Err(refusal) if refusal.code == Code::ItemNotFound && !refusal.commit_failed => {}
            Err(refusal) => {
                let safe = safe(refusal);
                let unknown = safe.details.is_some();
                let mut failure = json!({
                    "id": id,
                    "code": safe.code.wire(),
                    "message": safe.message,
                });
                if let Some(details) = safe.details {
                    failure["details"] = Value::Object(*details);
                }
                failures.push(failure);
                if unknown {
                    next_cursor = None;
                    break;
                }
            }
        }
    }
    Ok(Emptied {
        purged,
        failures,
        next_cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unconfirmed(code: Code) -> Refusal {
        Refusal {
            commit_failed: true,
            ..Refusal::new(code, "text from below")
        }
        .with_detail("write_outcome", "unknown")
    }

    #[test]
    fn a_commit_a_full_volume_turned_away_stays_a_507_with_its_outcome() {
        let told = safe(unconfirmed(Code::InsufficientStorage));
        assert_eq!(told.code, Code::InsufficientStorage);
        assert_eq!(told.code.status(), 507);
        assert_eq!(told.details.unwrap()["write_outcome"], "unknown");
    }

    #[test]
    fn any_other_failed_commit_is_a_500_with_its_outcome_and_no_text_from_below() {
        let told = safe(unconfirmed(Code::InternalError));
        assert_eq!(told.code, Code::InternalError);
        assert!(!told.message.contains("text from below"));
        assert_eq!(told.details.unwrap()["write_outcome"], "unknown");
    }
}

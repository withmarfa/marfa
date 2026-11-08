//! Platform types this build no longer ships stay registered until the owner removes them.

use serde_json::{Value, json};

use super::write::subtypes_of;
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::catalog::{self, Catalog, Snapshot};
use crate::app::items;
use crate::app::refusal::{Code, Refusal, Result};

fn dependents_of(catalog: &Catalog, id: &str) -> Vec<String> {
    let mut found: Vec<String> = catalog
        .types
        .rows()
        .iter()
        .filter(|(held, row)| {
            held.as_str() != id && super::names(row.get("compatible_with")).contains(&id)
        })
        .map(|(held, _)| held.clone())
        .collect();
    found.sort();
    found
}

pub async fn retired(app: &App, caller: &Caller) -> Result<Vec<Value>> {
    caller.require(Permission::InstanceRead)?;
    let cache = app.catalog_handle();
    app.db
        .read(move |tx| {
            let catalog = catalog::current(&cache, tx, Snapshot::Committed)?;
            catalog
                .retired()
                .into_iter()
                .map(|id| {
                    let children = subtypes_of(tx, id)?;
                    let item_count = items::count_of_type(tx, id)?;
                    let removable = item_count == 0
                        && children.is_empty()
                        && dependents_of(&catalog, id).is_empty();
                    Ok(json!({
                        "id": id,
                        "item_count": item_count,
                        "child_types": children,
                        "removable": removable,
                    }))
                })
                .collect()
        })
        .await
}

pub async fn remove_retired(app: &App, caller: &Caller, id: String) -> Result<Value> {
    let cache = app.catalog_handle();
    let removed = app
        .write(caller, "platform_type.removed", move |unit| {
            unit.caller.require(Permission::InstanceMaintain)?;
            let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
            if !catalog.retired().contains(&id.as_str()) {
                return Err(if catalog.holds(&id) {
                    Refusal::new(
                        Code::Conflict,
                        format!(
                            "\"{id}\" is not a type this build has stopped shipping, so it cannot be removed here"
                        ),
                    )
                } else {
                    Refusal::new(Code::TypeNotFound, format!("No platform row carries \"{id}\""))
                }
                .with_detail("type", id.as_str()));
            }
            let held = items::count_of_type(unit.tx(), &id)?;
            if held > 0 {
                return Err(Refusal::new(
                    Code::Conflict,
                    format!("{held} item(s) of \"{id}\" still exist; move or delete them first"),
                )
                .with_detail("type", id.as_str())
                .with_detail("item_count", held));
            }
            let children = subtypes_of(unit.tx(), &id)?;
            if !children.is_empty() {
                return Err(Refusal::new(
                    Code::Conflict,
                    format!(
                        "{} type(s) inherit from \"{id}\": {}. Removing it would leave them resolving without the fields they inherit.",
                        children.len(),
                        children.join(", ")
                    ),
                )
                .with_detail("type", id.as_str())
                .with_detail("child_types", children));
            }
            let dependents = dependents_of(&catalog, &id);
            if !dependents.is_empty() {
                return Err(Refusal::new(
                    Code::Conflict,
                    format!(
                        "Types still declare compatibility with \"{id}\": {}",
                        dependents.join(", ")
                    ),
                )
                .with_detail("type", id.as_str())
                .with_detail("dependent_type_ids", dependents));
            }
            let gone = unit.tx().execute(
                "DELETE FROM types WHERE id = ?1 AND origin = 'platform'",
                [&id],
            )?;
            if gone == 0 {
                return Err(Refusal::new(Code::NotFound, format!("No platform row for \"{id}\""))
                    .with_detail("type", id.as_str()));
            }
            catalog::raise(unit.tx())?;
            unit.audit("type", &id, Some(json!({ "type": id })))?;
            Ok(json!({ "removed": true, "id": id }))
        })
        .await?;
    app.publish_catalog().await;
    Ok(removed)
}

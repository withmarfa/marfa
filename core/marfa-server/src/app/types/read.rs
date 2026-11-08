use marfa_rules::schema::{
    ChainFault, Obj, canonical, parent_chain_fault, resolve, roles_of, stored_shape_conflicts,
    validate_type,
};
use serde_json::{Value, json};

use super::{chain_refusal, check_id, presented, schema_refusal};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::catalog::{self, Catalog, Snapshot, provenance_json};
use crate::app::items::reading;
use crate::app::refusal::{Code, Refusal, Result};

pub async fn list(app: &App, caller: &Caller) -> Result<Vec<Value>> {
    reading(app, caller, |read| {
        Ok(read
            .catalog
            .types
            .ids()
            .into_iter()
            .filter_map(|id| listed(&read.catalog, id))
            .collect())
    })
    .await
}

fn listed(catalog: &Catalog, id: &str) -> Option<Value> {
    let mut schema = catalog.types.owned(id)?;
    let mut own: Vec<&str> = schema
        .get("roles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    own.sort_unstable();
    let own = json!(own);
    let plural = schema.remove("plural");
    if let Some(plural) =
        plural.filter(|plural| plural.as_str().is_some_and(|text| !text.is_empty()))
    {
        schema.insert("plural".into(), plural);
    }
    if let Ok(Some(roles)) = roles_of(&catalog.types, id) {
        schema.insert("roles".into(), json!(roles));
    }
    let conflicts: Vec<Value> = stored_shape_conflicts(&schema, &catalog.types)
        .into_iter()
        .map(|conflict| {
            json!({
                "field": conflict.field,
                "attribute": conflict.attribute,
                "inherited": conflict.inherited,
                "declared": conflict.declared,
                "inherited_from": conflict.owner,
            })
        })
        .collect();
    if !conflicts.is_empty() {
        schema.insert("conflicts".into(), Value::Array(conflicts));
    }
    schema.insert("own_roles".into(), own);
    schema.insert(
        "provenance".into(),
        provenance_json(catalog.provenance.get(id)),
    );
    Some(Value::Object(schema))
}

pub async fn get(app: &App, id: String) -> Result<Value> {
    let cache = app.catalog_handle();
    app.db
        .read(move |tx| {
            let catalog = catalog::current(&cache, tx, Snapshot::Committed)?;
            if catalog.is_unreadable(&id) {
                return Err(chain_refusal(&ChainFault {
                    type_id: id.clone(),
                    at: id.clone(),
                }));
            }
            match resolve(&catalog.types, &id, false) {
                Ok(Some(schema)) => Ok(presented(schema, catalog.provenance.get(&id))),
                Ok(None) => Err(Refusal::new(
                    Code::TypeNotFound,
                    format!("Type \"{id}\" not found"),
                )),
                Err(fault) => Err(chain_refusal(&fault)),
            }
        })
        .await
}

pub async fn normalize(app: &App, body: Obj) -> Result<Value> {
    if let Some(id) = body.get("id").and_then(Value::as_str) {
        check_id(id, "id")?;
    }
    let cache = app.catalog_handle();
    app.db
        .read(move |tx| {
            let catalog = catalog::current(&cache, tx, Snapshot::Committed)?;
            let schema =
                validate_type(&Value::Object(body), &catalog.types).map_err(schema_refusal)?;
            let id = schema
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| Refusal::internal("a judged type has no id"))?
                .to_string();
            if let Some(parent) = schema.get("parent").and_then(Value::as_str)
                && let Some(fault) = parent_chain_fault(&catalog.types, &id, parent, 0)
            {
                return Err(Refusal::validation(fault));
            }
            let registered = catalog.types.get(&id).cloned().map(canonical);
            let resolved = resolve(&catalog.types.without_icons(), &id, true)
                .map_err(|fault| chain_refusal(&fault))?
                .map(canonical);
            Ok(json!({
                "type": canonical(schema),
                "registered_type": registered,
                "resolved_type": resolved,
            }))
        })
        .await
}

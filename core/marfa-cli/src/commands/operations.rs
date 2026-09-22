//! Every published operation, and the command that reaches it.
//!
//! One table, read by two things: `marfa operations`, which prints it for
//! any reader of the binary; and the crate's own test, which holds it
//! against `openapi.json` so a published operation without a command is
//! red before anything is pushed, and a command for one the document no
//! longer publishes is red too.

use serde_json::json;

use crate::error::CliError;
use crate::output::Printer;

/// An operation id from `openapi.json` and the command line that reaches
/// it, without the arguments a call needs.
pub struct Operation {
    pub id: &'static str,
    pub command: &'static str,
}

const fn reached(id: &'static str, command: &'static str) -> Operation {
    Operation { id, command }
}

pub const OPERATIONS: &[Operation] = &[
    reached("createItem", "items create"),
    reached("listItems", "items list"),
    reached("getItemStats", "items stats"),
    reached("getItem", "items get"),
    reached("updateItem", "items update"),
    reached("deleteItem", "items delete"),
    reached("restoreItem", "items restore"),
    reached("transitionItem", "items transition"),
    reached("listItemVersions", "items versions"),
    reached("getItemMetadata", "metadata get"),
    reached("replaceItemMetadata", "metadata replace"),
    reached("mergeItemMetadata", "metadata merge"),
    reached("addItemTags", "items tag"),
    reached("purgeItem", "items purge"),
    reached("removeItemTag", "items untag"),
    reached("bulkUpsertItems", "items bulk"),
    reached("applyBulkAction", "items bulk-action"),
    reached("getBulkActionJob", "items bulk-action job"),
    reached("cancelBulkActionJob", "items bulk-action cancel"),
    reached("bulkGetItems", "items bulk-get"),
    reached("listItemExtensions", "extensions list"),
    reached("getItemExtension", "extensions get"),
    reached("replaceItemExtension", "extensions write"),
    reached("deleteItemExtension", "extensions delete"),
    reached("listItemEdges", "items edges"),
    reached("listItemBackrefs", "items backrefs"),
    reached("listEdges", "edges list"),
    reached("createEdge", "edges create"),
    reached("getEdge", "edges get"),
    reached("updateEdge", "edges update"),
    reached("deleteEdge", "edges delete"),
    reached("bulkUpsertEdges", "edges bulk"),
    reached("createEdgeType", "edge-types register"),
    reached("listEdgeTypes", "edge-types list"),
    reached("deleteEdgeType", "edge-types delete"),
    reached("listTypes", "types list"),
    reached("registerType", "types register"),
    reached("getType", "types get"),
    reached("updateType", "types update"),
    reached("deleteType", "types delete"),
    reached("searchItems", "search"),
    reached("listOccurrences", "items occurrences"),
    reached("listTags", "metadata tags"),
    reached("uploadBlob", "blobs upload"),
    reached("downloadBlob", "blobs download"),
    reached("getBlobUrl", "blobs url"),
    reached("createKey", "keys create"),
    reached("listKeys", "keys list"),
    reached("revokeKey", "keys revoke"),
    reached("updateKey", "keys update"),
    reached("getConfig", "config get"),
    reached("replaceConfig", "config replace"),
    reached("adminListPlatformTypeDrift", "types drift"),
    reached("adminRemovePlatformType", "types prune"),
    reached("exportData", "export"),
    reached("adminRestoreArchive", "restore"),
    reached("createWebhook", "webhooks create"),
    reached("listWebhooks", "webhooks list"),
    reached("getWebhook", "webhooks get"),
    reached("updateWebhook", "webhooks update"),
    reached("deleteWebhook", "webhooks delete"),
    reached("listWebhookDeliveries", "webhooks deliveries"),
    reached("listAuditLog", "audit"),
    reached("streamEvents", "events"),
    reached("listBlobStores", "blobs stores"),
    reached("listBlobLocations", "blobs locations"),
    reached("dropBlobLocation", "blobs drop"),
    reached("listBlobOrphans", "blobs orphans"),
    reached("listHousekeeping", "housekeeping list"),
    reached("runHousekeeping", "housekeeping run"),
    reached("registerConnector", "connectors register"),
    reached("listConnectors", "connectors list"),
    reached("getConnector", "connectors get"),
    reached("deleteConnector", "connectors delete"),
    reached("heartbeatConnector", "connectors heartbeat"),
    reached("reportConnectorRun", "connectors report"),
    reached("listConnectorRuns", "connectors runs"),
    reached("registerOAuthClient", "login"),
    reached("getOwner", "owner show"),
    reached("createOwner", "owner create"),
];

pub fn run(out: &Printer) -> Result<(), CliError> {
    let rows: Vec<serde_json::Value> = OPERATIONS
        .iter()
        .map(|operation| json!({ "operation_id": operation.id, "command": operation.command }))
        .collect();
    out.report(&json!(rows), || {
        OPERATIONS
            .iter()
            .map(|operation| format!("{:32} marfa {}", operation.id, operation.command))
            .collect::<Vec<_>>()
            .join("\n")
    })
}

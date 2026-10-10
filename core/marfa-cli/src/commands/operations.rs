use serde_json::json;

use crate::error::CliError;
use crate::output::Printer;

pub struct Operation {
    pub id: &'static str,
    pub command: &'static str,
}

const fn reached(id: &'static str, command: &'static str) -> Operation {
    Operation { id, command }
}

pub const OPERATIONS: &[Operation] = &[
    reached("getInstance", "status"),
    reached("getServerMetrics", "metrics"),
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
    reached("updateItemMetadata", "metadata update"),
    reached("addItemTags", "items tag"),
    reached("purgeItem", "items purge"),
    reached("removeItemTag", "items untag"),
    reached("bulkUpsertItems", "items bulk"),
    reached("applyBulkAction", "items bulk-action"),
    reached("getBulkActionJob", "items bulk-action job"),
    reached("cancelBulkActionJob", "items bulk-action cancel"),
    reached("bulkGetItems", "items bulk-get"),
    reached("lookupItems", "items lookup"),
    reached("settleTombstones", "items tombstones"),
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
    reached("registerEdgeType", "edge-types register"),
    reached("listEdgeTypes", "edge-types list"),
    reached("deleteEdgeType", "edge-types delete"),
    reached("listTypes", "types list"),
    reached("registerType", "types register"),
    reached("getType", "types get"),
    reached("replaceType", "types replace"),
    reached("deleteType", "types delete"),
    reached("searchItems", "search"),
    reached("listOccurrences", "items occurrences"),
    reached("listTags", "metadata tags"),
    reached("uploadBlob", "blobs upload"),
    reached("downloadBlob", "blobs download"),
    reached("getBlobUrl", "blobs url"),
    reached("createKey", "keys create"),
    reached("listKeys", "keys list"),
    reached("getCurrentKey", "keys current"),
    reached("revokeKey", "keys revoke"),
    reached("updateKey", "keys update"),
    reached("getConfig", "config get"),
    reached("replaceConfig", "config replace"),
    reached("listPlatformTypeDrift", "types drift"),
    reached("deletePlatformType", "types prune"),
    reached("exportData", "export"),
    reached("restoreArchive", "restore"),
    reached("createWebhook", "webhooks create"),
    reached("listWebhooks", "webhooks list"),
    reached("getWebhook", "webhooks get"),
    reached("updateWebhook", "webhooks update"),
    reached("deleteWebhook", "webhooks delete"),
    reached("listWebhookDeliveries", "webhooks deliveries"),
    reached("redeliverWebhookDelivery", "webhooks redeliver"),
    reached("listAuditLog", "audit"),
    reached("streamEvents", "events"),
    reached("listBlobStores", "blobs stores"),
    reached("listBlobLocations", "blobs locations"),
    reached("deleteBlobLocation", "blobs delete-location"),
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
    reached("createInboundEndpoint", "connectors endpoints create"),
    reached("listInboundEndpoints", "connectors endpoints list"),
    reached("retireInboundEndpoint", "connectors endpoints retire"),
    reached("listInboundDeliveries", "connectors deliveries list"),
    reached("getInboundDeliveryBody", "connectors deliveries body"),
    reached(
        "markInboundDeliveriesHandled",
        "connectors deliveries handle",
    ),
    reached("holdConnector", "connectors hold"),
    reached("releaseConnectorHold", "connectors release"),
    reached("getConnectorState", "connectors state get"),
    reached("replaceConnectorState", "connectors state put"),
    reached("deleteConnectorState", "connectors state delete"),
    reached("writeConnectorAgreements", "connectors agreements write"),
    reached("lookupConnectorAgreements", "connectors agreements lookup"),
    reached("listConnectorAgreements", "connectors agreements list"),
    reached("createFolder", "folders create"),
    reached("updateFolder", "folders change"),
    reached("revokeFolder", "folders revoke"),
    reached("registerOAuthClient", "login"),
    reached("getOwner", "owner show"),
    reached("listSignIns", "sign-ins list"),
    reached("updateSignIn", "sign-ins rename"),
    reached("endSignIn", "sign-ins end"),
    reached("createOwner", "setup claim"),
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

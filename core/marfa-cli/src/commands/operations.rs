//! Every published operation, and the command that reaches it.
//!
//! One table, read by three things: `marfa operations`, which prints it; the
//! crate's own test, which holds it against `openapi.json` so a published
//! operation without a command is red before anything is pushed; and the
//! scenario suite, which reads the printed form so it never holds a copy.
//!
//! An operation may be pending instead of mapped, with the reason and the
//! pull request that closes it. Pending is a state the test checks both
//! ways: an entry that is no longer published, or that has gained a command,
//! is red, so the list cannot go stale.

use serde_json::json;

use crate::error::CliError;
use crate::output::Printer;

/// How an operation is reached: by a command line, or not yet.
pub enum Reach {
    /// The command line that reaches it, without the arguments a call needs.
    Command(&'static str),
    /// Not reachable yet, and why: the pull request or the question it waits on.
    Pending(&'static str),
}

/// An operation id from `openapi.json` and how the binary reaches it.
pub struct Operation {
    pub id: &'static str,
    pub reach: Reach,
}

const fn reached(id: &'static str, command: &'static str) -> Operation {
    Operation {
        id,
        reach: Reach::Command(command),
    }
}

const fn pending(id: &'static str, reason: &'static str) -> Operation {
    Operation {
        id,
        reach: Reach::Pending(reason),
    }
}

pub const OPERATIONS: &[Operation] = &[
    reached("createItem", "items create"),
    reached("listItems", "items list"),
    reached("promoteItem", "items promote"),
    reached("reconcileItem", "items reconcile"),
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
    pending(
        "registerOAuthClient",
        "signing in: `marfa login` registers the binary as a client",
    ),
    pending("getOwner", "signing in: `marfa owner show`"),
    pending("createOwner", "signing in: `marfa owner create`"),
];

pub fn run(out: &Printer) -> Result<(), CliError> {
    let rows: Vec<serde_json::Value> = OPERATIONS
        .iter()
        .map(|operation| match operation.reach {
            Reach::Command(command) => {
                json!({ "operation_id": operation.id, "command": command, "pending": null })
            }
            Reach::Pending(reason) => {
                json!({ "operation_id": operation.id, "command": null, "pending": reason })
            }
        })
        .collect();
    out.report(&json!(rows), || {
        OPERATIONS
            .iter()
            .map(|operation| match operation.reach {
                Reach::Command(command) => format!("{:32} marfa {}", operation.id, command),
                Reach::Pending(reason) => format!("{:32} pending: {}", operation.id, reason),
            })
            .collect::<Vec<_>>()
            .join("\n")
    })
}

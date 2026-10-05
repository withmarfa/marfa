import { runAuditedTransaction } from "../storage/audited-transaction.js";
/**
 * Extension routes — namespaced metadata on items.
 *
 * Every door first asks the key's type map for the item's type, at `read` or
 * `write` as the item doors do, answering an item it may not read as a
 * missing one, and nothing about the namespace skips it.
 *
 * The namespace is the second gate. A key's label names a namespace it holds
 * write on (a key labeled "noter" writes "noter"), because the label is the
 * namespace's identity; `extension_permissions` grants any other.
 *
 * **Reserved namespaces (core, marfa, system) are closed to every
 * credential.** What writes them is the platform's own machinery, through
 * the storage layer, which is also what writes a `system.*` row.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { extensionLabelOf } from "../auth/extension-label.js";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import { readableExtensions } from "./_extension-reach.js";

const RESERVED_NAMESPACES = new Set(["core", "marfa", "system"]);

import type { AppEnv } from "../middleware/auth.js";
import {
  checkExtensionPermission,
  requireAuth,
  requireReadableRow,
  requireWritableRow,
  requireTypeAccess,
  readsSomeType,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { publish } from "../pubsub.js";
import { itemAfterMetadataWrite } from "./_metadata-publish.js";
import {
  ITEM_NOT_FOUND_ON_READ,
  ITEM_NOT_FOUND_ON_WRITE,
  READ_REFUSED,
  WRITE_REFUSED,
} from "./_item-refusals.js";
import { requestBlobProof } from "./_blob-reach.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ExtensionsResponseSchema = z
  .object({
    extensions: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .openapi("ExtensionsResponse");

const SingleExtensionResponseSchema = z.object({
  namespace: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listExtensionsRoute = createRoute({
  operationId: "listItemExtensions",
  method: "get",
  path: "/{id}/extensions",
  tags: ["Extensions"],
  summary: "List extension namespaces",
  description:
    "Returns the extension namespaces on the item that you can read, each with its data.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: z.object({
      id: z.string().describe("The ID of the item."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ExtensionsResponseSchema,
        },
      },
      description:
        "Returns the namespaces you can read, keyed by name. Namespaces you can't read are left out.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "- `invalid_id`: the ID is not a valid item ID.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_permitted"]),
        },
      },
      description: READ_REFUSED,
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: ITEM_NOT_FOUND_ON_READ,
    },
  },
});

const getExtensionRoute = createRoute({
  operationId: "getItemExtension",
  method: "get",
  path: "/{id}/extensions/{namespace}",
  tags: ["Extensions"],
  summary: "Get an extension namespace",
  description:
    "Returns the data in one extension namespace on the item, or `data: null` if the item has none there.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: z.object({
      id: z.string().describe("The ID of the item."),
      namespace: z.string().describe("The extension namespace to read."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: SingleExtensionResponseSchema,
        },
      },
      description: "Returns the namespace and its data.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "- `invalid_id`: the ID is not a valid item ID.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden", "type_not_permitted"]),
        },
      },
      description: `${READ_REFUSED}\n- \`forbidden\`: you don't have read on the namespace.`,
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: ITEM_NOT_FOUND_ON_READ,
    },
  },
});

const setExtensionRoute = createRoute({
  operationId: "replaceItemExtension",
  method: "put",
  path: "/{id}/extensions/{namespace}",
  tags: ["Extensions"],
  summary: "Replace an extension namespace",
  description:
    "Replaces the data in one extension namespace on the item, and returns the namespaces you can read. Marfa announces `metadata.changed`.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: z.object({
      id: z.string().describe("The ID of the item."),
      namespace: z.string().describe("The extension namespace to replace."),
    }),
    body: {
      content: {
        "application/json": {
          schema: z
            .record(z.string(), z.unknown())
            .describe("The namespace's new data, as a JSON object."),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ExtensionsResponseSchema,
        },
      },
      description: "Returns the namespaces on the item that you can read.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "invalid_id",
          ]),
        },
      },
      description:
        "- `validation_error`: the body is not a JSON object, or its JSON is longer than 102,400 characters.\n- `invalid_id`: the ID is not a valid item ID.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden", "type_not_permitted"]),
        },
      },
      description: `${WRITE_REFUSED}\n- \`forbidden\`: you don't have write on the namespace, or it is reserved (\`core\`, \`marfa\` or \`system\`).`,
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: ITEM_NOT_FOUND_ON_WRITE,
    },
  },
});

const deleteExtensionRoute = createRoute({
  operationId: "deleteItemExtension",
  method: "delete",
  path: "/{id}/extensions/{namespace}",
  tags: ["Extensions"],
  summary: "Delete an extension namespace",
  description:
    "Removes one extension namespace from the item, and returns the namespaces left that you can read. Deleting a namespace that isn't there still succeeds and announces `metadata.changed`.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: z.object({
      id: z.string().describe("The ID of the item."),
      namespace: z.string().describe("The extension namespace to delete."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ExtensionsResponseSchema,
        },
      },
      description: "Returns the namespaces left on the item that you can read.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "- `invalid_id`: the ID is not a valid item ID.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden", "type_not_permitted"]),
        },
      },
      description: `${WRITE_REFUSED}\n- \`forbidden\`: you don't have write on the namespace, or it is reserved (\`core\`, \`marfa\` or \`system\`).`,
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: ITEM_NOT_FOUND_ON_WRITE,
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function extensionRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listExtensionsRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    requireReadableRow(
      c,
      await storage.items.get(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found"),
    );

    const extensions = await storage.metadata.getExtensions(id);
    return c.json({ extensions: readableExtensions(extensions, apiKey) }, 200);
  });

  router.openapi(getExtensionRoute, async (c) => {
    requireAuth(c);
    const { id, namespace } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    requireReadableRow(
      c,
      await storage.items.get(id),
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found"),
    );

    checkExtensionPermission(apiKey, namespace, "read");

    const extensions = await storage.metadata.getExtensions(id);
    const data = extensions[namespace] ?? null;

    return c.json({ namespace, data }, 200);
  });

  router.openapi(setExtensionRoute, async (c) => {
    requireAuth(c);
    const { id, namespace } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const body = c.req.valid("json");
    // The row is read, gated and written in one transaction, so a
    // change to it landing in between cannot slip past the gate.
    const { extensions } = await runAuditedTransaction(
      storage,
      async () => {
        const item = requireWritableRow(
          c,
          await storage.items.getIncludingTrashed(id),
          () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found"),
        );
        // An extension is part of the item's row, so the item's type gate runs
        // first, as it does on the tag doors, whatever the namespace grants.
        requireTypeAccess(c, item.type, "write");

        if (RESERVED_NAMESPACES.has(namespace)) {
          throw new MarfaError(
            ErrorCode.FORBIDDEN,
            `Namespace "${namespace}" is reserved`,
          );
        }

        checkExtensionPermission(apiKey, namespace, "write");

        const serialized = JSON.stringify(body);
        if (serialized.length > 102_400) {
          throw new MarfaError(
            ErrorCode.VALIDATION_ERROR,
            "Extension data exceeds maximum size of 100KB",
          );
        }

        const written = await storage.metadata.setExtension(
          id,
          namespace,
          body,
          requestBlobProof(c, storage),
        );

        // The extensions map and the tags are one metadata row, and the four
        // doors that write the other half of it publish. A subscriber cannot
        // tell which door wrote the row, so emitting for one and not the other
        // makes propagation depend on which the writer happened to use — and an
        // app storing sidecar state here changed a record no second device was
        // ever told about.
        //
        // Read the row back rather than composing the event from the extensions
        // this call returned: the payload carries the whole metadata, and half
        // of it is the half this door did not touch.
        await publish({
          type: "metadata_changed",
          item: await itemAfterMetadataWrite(storage, item),
          metadata: await storage.metadata.get(id),
        });
        return { extensions: written };
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "extension.set",
        resource_type: "item",
        resource_id: id,
        details: { namespace },
      },
    );

    return c.json({ extensions: readableExtensions(extensions, apiKey) }, 200);
  });

  router.openapi(deleteExtensionRoute, async (c) => {
    requireAuth(c);
    const { id, namespace } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    // The row is read, gated and written in one transaction, so a
    // change to it landing in between cannot slip past the gate.
    const { extensions } = await runAuditedTransaction(
      storage,
      async () => {
        const item = requireWritableRow(
          c,
          await storage.items.getIncludingTrashed(id),
          () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found"),
        );
        // An extension is part of the item's row, so the item's type gate runs
        // first, as it does on the tag doors, whatever the namespace grants.
        requireTypeAccess(c, item.type, "write");

        if (RESERVED_NAMESPACES.has(namespace)) {
          throw new MarfaError(
            ErrorCode.FORBIDDEN,
            `Namespace "${namespace}" is reserved`,
          );
        } else {
          const isOwner = extensionLabelOf(apiKey) === namespace;
          if (!isOwner) {
            checkExtensionPermission(apiKey, namespace, "write");
          }
        }

        const written = await storage.metadata.deleteExtension(id, namespace);

        // A removal is as observable as a write, and for the same reason as
        // the replace door above: the namespace's absence from the payload is
        // how a subscriber learns to drop its own copy.
        await publish({
          type: "metadata_changed",
          item: await itemAfterMetadataWrite(storage, item),
          metadata: await storage.metadata.get(id),
        });
        return { extensions: written };
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "extension.delete",
        resource_type: "item",
        resource_id: id,
        details: { namespace },
      },
    );

    return c.json({ extensions: readableExtensions(extensions, apiKey) }, 200);
  });

  return router;
}

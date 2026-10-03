import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { Edge, Item } from "@withmarfa/shared";
import type { Context } from "hono";
import type { AppEnv } from "./auth.js";
import {
  checkEdgePermission,
  checkExtensionPermission,
  checkTypeAccess,
  checkTypePermission,
  getTypeFilter,
  itemProvenanceSource,
  requireAuth,
  mayReadType,
  requireMetadataPermission,
  requirePermission,
  requireReadableRow,
} from "./auth.js";
import type { Storage } from "../storage/interface.js";
import { edgeKindReadable } from "../routes/_edge-visibility.js";
import {
  rememberEdgeSubject,
  rememberItemSubject,
  rememberReplayRequirement,
  recordedEdgeSourceType,
  recordedItemType,
} from "./replay-requirements.js";
import type { ReplayRequirement } from "./replay-requirements.js";

const itemNotFound = (id: string) =>
  new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
const edgeNotFound = (id: string) =>
  new MarfaError(ErrorCode.EDGE_NOT_FOUND, `Edge ${id} not found`);

/** Retained envelopes can disclose snapshots and related rows beyond the write's own subject. */
export async function rememberResponseDisclosures(
  storage: Storage,
  body: string,
): Promise<void> {
  const parsed: unknown = JSON.parse(body);
  async function visit(value: unknown): Promise<void> {
    if (Array.isArray(value)) {
      for (const child of value) await visit(child);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (
      typeof row.id === "string" &&
      typeof row.type === "string" &&
      "properties" in row
    ) {
      rememberItemSubject({ id: row.id, type: row.type }, "read");
    }
    if (
      typeof row.id === "string" &&
      typeof row.edge_type === "string" &&
      typeof row.source_id === "string" &&
      typeof row.target_id === "string"
    ) {
      rememberEdgeSubject(
        row as unknown as Edge,
        "read",
        recordedEdgeSourceType(row.id),
      );
    }
    for (const [field, child] of Object.entries(row)) {
      if (field === "properties" || field === "input") continue;
      if (field === "extensions") {
        if (
          child !== null &&
          typeof child === "object" &&
          !Array.isArray(child)
        ) {
          for (const namespace of Object.keys(child))
            rememberReplayRequirement({
              kind: "extension",
              namespace,
              level: "read",
            });
        }
        continue;
      }
      if (
        ["item_id", "existing_id", "root_item_id", "trashed_with"].includes(
          field,
        ) &&
        typeof child === "string"
      ) {
        const recordedType = recordedItemType(child);
        if (recordedType !== undefined) {
          rememberItemSubject({ id: child, type: recordedType }, "read");
          continue;
        }
        try {
          const item = await storage.items.getIncludingTrashed(child);
          if (item) rememberItemSubject(item, "read");
          else rememberReplayRequirement({ kind: "item_reference", id: child });
        } catch {
          // The original response is owed even if a disclosure lookup fails after its write committed.
          rememberReplayRequirement({ kind: "item_reference", id: child });
        }
      }
      await visit(child);
    }
  }
  await visit(parsed);
}

/** Reauthorization is read-only: version and lifecycle conditions belonged to the original write. */
export async function authorizeReplay(
  c: Context<AppEnv>,
  storage: Storage,
  requirements: readonly ReplayRequirement[],
): Promise<void> {
  const key = requireAuth(c);
  const currentEdges = new Map<string, Edge | null>();
  const itemIds = new Set<string>();
  for (const requirement of requirements) {
    if (requirement.kind === "item" || requirement.kind === "item_reference")
      itemIds.add(requirement.id);
    if (requirement.kind !== "edge") continue;
    itemIds.add(requirement.edge.source_id);
    if (!currentEdges.has(requirement.edge.id))
      currentEdges.set(
        requirement.edge.id,
        await storage.edges.get(requirement.edge.id),
      );
    const current = currentEdges.get(requirement.edge.id);
    if (current) itemIds.add(current.source_id);
  }
  const currentItems = new Map<string, Item>();
  const ids = [...itemIds];
  // A bulk receipt can name more subjects than one SQLite statement accepts.
  for (let offset = 0; offset < ids.length; offset += 500) {
    const rows = await storage.items.getMany(ids.slice(offset, offset + 500), {
      includeTrashed: true,
    });
    for (const [id, row] of rows) currentItems.set(id, row);
  }
  for (const requirement of requirements) {
    switch (requirement.kind) {
      case "reach":
        getTypeFilter(c);
        break;
      case "item_reference": {
        requireReadableRow(c, currentItems.get(requirement.id), () =>
          itemNotFound(requirement.id),
        );
        break;
      }
      case "type":
        (requirement.permissionOnly ? checkTypePermission : checkTypeAccess)(
          key,
          requirement.type,
          requirement.level,
        );
        break;
      case "item": {
        const notFound = () => itemNotFound(requirement.id);
        requireReadableRow(c, requirement, notFound);
        const current = currentItems.get(requirement.id);
        if (current) requireReadableRow(c, current, notFound);
        if (requirement.level !== "write") break;
        const check = requirement.permissionOnly
          ? checkTypePermission
          : checkTypeAccess;
        check(key, requirement.type, "write");
        if (current) check(key, current.type, "write");
        break;
      }
      case "edge": {
        getTypeFilter(c);
        const current = currentEdges.get(requirement.edge.id) ?? null;
        const facts = current
          ? [requirement.edge, current]
          : [requirement.edge];
        for (const edge of facts) {
          const source = currentItems.get(edge.source_id);
          const type = source?.type ?? requirement.sourceType;
          if (
            !edgeKindReadable(key, edge as Edge) ||
            (type !== undefined && !mayReadType(key, type))
          )
            throw edgeNotFound(requirement.edge.id);
        }
        if (
          requirement.sourceType !== undefined &&
          !mayReadType(key, requirement.sourceType)
        )
          throw edgeNotFound(requirement.edge.id);
        if (requirement.level === "write") {
          for (const edge of facts) {
            checkEdgePermission(key, edge.edge_type, "write");
            const source = currentItems.get(edge.source_id);
            const type = source?.type ?? requirement.sourceType;
            if (type !== undefined) checkTypeAccess(key, type, "write");
          }
          if (requirement.sourceType !== undefined)
            checkTypeAccess(key, requirement.sourceType, "write");
        }
        break;
      }
      case "edge_type":
        checkEdgePermission(key, requirement.edgeType, requirement.level);
        break;
      case "permission":
        requirePermission(c, requirement.permission);
        break;
      case "extension":
        checkExtensionPermission(key, requirement.namespace, requirement.level);
        break;
      case "metadata":
        requireMetadataPermission(
          c,
          requirement.subresource,
          requirement.level,
        );
        break;
      case "source":
        itemProvenanceSource(key, requirement.source);
        break;
    }
  }
}

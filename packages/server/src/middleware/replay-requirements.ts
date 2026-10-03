import { AsyncLocalStorage } from "node:async_hooks";
import type { Edge, Permission } from "@withmarfa/shared";

export type ReplayRequirement =
  | { kind: "reach" }
  | { kind: "item_reference"; id: string }
  | {
      kind: "type";
      type: string;
      level: "read" | "write";
      permissionOnly: boolean;
    }
  | {
      kind: "item";
      id: string;
      type: string;
      level: "read" | "write";
      permissionOnly: boolean;
    }
  | {
      kind: "edge";
      edge: Pick<Edge, "id" | "source_id" | "target_id" | "edge_type">;
      sourceType?: string;
      level: "read" | "write";
    }
  | { kind: "edge_type"; edgeType: string; level: "read" | "write" }
  | { kind: "permission"; permission: Permission }
  | { kind: "extension"; namespace: string; level: "read" | "write" }
  | { kind: "metadata"; subresource: string; level: "read" | "write" }
  | { kind: "source"; source: string };

/** Each request collects only the authorization facts its own handler used. */
const captures = new AsyncLocalStorage<Map<string, ReplayRequirement>>();

export function rememberReplayRequirement(
  requirement: ReplayRequirement,
): void {
  captures.getStore()?.set(JSON.stringify(requirement), requirement);
}

export function rememberItemSubject(
  row: { id: string; type: string },
  level: "read" | "write",
  permissionOnly = false,
): void {
  rememberReplayRequirement({
    kind: "item",
    id: row.id,
    type: row.type,
    level,
    permissionOnly,
  });
}

export function rememberEdgeSubject(
  edge: Edge,
  level: "read" | "write",
  sourceType?: string,
): void {
  rememberReplayRequirement({
    kind: "edge",
    edge: {
      id: edge.id,
      source_id: edge.source_id,
      target_id: edge.target_id,
      edge_type: edge.edge_type,
    },
    sourceType,
    level,
  });
}

export async function captureReplayRequirements<T>(
  run: () => Promise<T>,
): Promise<{ value: T; requirements: ReplayRequirement[] }> {
  const requirements = new Map<string, ReplayRequirement>();
  const value = await captures.run(requirements, run);
  return { value, requirements: [...requirements.values()] };
}

export function recordedEdgeSourceType(id: string): string | undefined {
  for (const requirement of captures.getStore()?.values() ?? []) {
    if (
      requirement.kind === "edge" &&
      requirement.edge.id === id &&
      requirement.sourceType !== undefined
    )
      return requirement.sourceType;
  }
  return undefined;
}

export function recordedItemType(id: string): string | undefined {
  for (const requirement of captures.getStore()?.values() ?? []) {
    if (requirement.kind === "item" && requirement.id === id)
      return requirement.type;
  }
  return undefined;
}

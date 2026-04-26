/**
 * Typed payload structs for the mutation queue. Each `MutationKind`
 * pairs with a payload shape; the queue persists the JSON-encoded
 * payload alongside the kind discriminator.
 *
 * The shapes mirror `@mymehq/sdk` request bodies so the drain loop can
 * call the SDK directly without translation.
 */

import type { CreateItemInput, ItemState, CreateEdgeInput } from "@mymehq/shared";

export type MutationKind =
  | "createItem"
  | "updateItem"
  | "deleteItem"
  | "restoreItem"
  | "transitionItem"
  | "purgeItem"
  | "createEdge"
  | "updateEdge"
  | "deleteEdge"
  | "setMetadata"
  | "mergeMetadata"
  | "addTags"
  | "removeTag"
  | "setExtension"
  | "deleteExtension";

export interface CreateItemPayload {
  input: CreateItemInput & { edges?: Record<string, string[]> };
}

export interface UpdateItemPayload {
  id: string;
  properties: Record<string, unknown>;
  expectedVersion?: number;
  library?: boolean;
  type?: string;
}

export interface IdPayload {
  id: string;
}

export interface TransitionItemPayload {
  id: string;
  state: ItemState;
}

export interface CreateEdgePayload {
  input: CreateEdgeInput;
}

export interface UpdateEdgePayload {
  id: string;
  properties: Record<string, unknown>;
}

export interface SetMetadataPayload {
  itemId: string;
  tags?: string[];
}

export interface MergeMetadataPayload {
  itemId: string;
  tags?: string[];
}

export interface TagPayload {
  itemId: string;
  tags: string[];
}

export interface RemoveTagPayload {
  itemId: string;
  tag: string;
}

export interface SetExtensionPayload {
  itemId: string;
  namespace: string;
  data: Record<string, unknown>;
}

export interface DeleteExtensionPayload {
  itemId: string;
  namespace: string;
}

/**
 * Discriminated union of the typed payloads. The queue persists this
 * as JSON keyed by `kind`; `serialize` and `deserialize` validate the
 * round trip.
 */
export type MutationPayload =
  | { kind: "createItem"; payload: CreateItemPayload }
  | { kind: "updateItem"; payload: UpdateItemPayload }
  | { kind: "deleteItem"; payload: IdPayload }
  | { kind: "restoreItem"; payload: IdPayload }
  | { kind: "transitionItem"; payload: TransitionItemPayload }
  | { kind: "purgeItem"; payload: IdPayload }
  | { kind: "createEdge"; payload: CreateEdgePayload }
  | { kind: "updateEdge"; payload: UpdateEdgePayload }
  | { kind: "deleteEdge"; payload: IdPayload }
  | { kind: "setMetadata"; payload: SetMetadataPayload }
  | { kind: "mergeMetadata"; payload: MergeMetadataPayload }
  | { kind: "addTags"; payload: TagPayload }
  | { kind: "removeTag"; payload: RemoveTagPayload }
  | { kind: "setExtension"; payload: SetExtensionPayload }
  | { kind: "deleteExtension"; payload: DeleteExtensionPayload };

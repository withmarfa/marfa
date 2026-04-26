/**
 * React bindings for `@mymehq/sync-client`.
 *
 *   import { MymeSyncProvider, useItems, useItem, useEdges,
 *            useMutation, useSyncState, usePendingMutations,
 *            useSyncEvents, useMymeSyncClient } from '@mymehq/sync-client/react';
 *
 * The hooks are intentionally thin: reads are PGlite live queries
 * (incremental update on row changes), writes go through the client's
 * mutation namespaces, sync state and events surface via the typed
 * emitter. No external state-management library is required.
 */

export { MymeSyncProvider, useMymeSyncClient } from "./provider.js";
export { useItems, useItem } from "./use-items.js";
export { useEdges } from "./use-edges.js";
export { useMutation } from "./use-mutation.js";
export { useSyncState } from "./use-sync-state.js";
export { usePendingMutations } from "./use-pending-mutations.js";
export { useSyncEvents } from "./use-sync-events.js";

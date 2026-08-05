/**
 * The local replica: a TanStack DB collection fed by the Marfa API and
 * its change stream.
 *
 * Its own subpath because `@tanstack/db` is an optional peer. A consumer
 * using only the client — the CLI, the MCP server, the sync agent —
 * should not be made to install a store it never touches.
 */
export { createReplicaCollection } from "./collection.js";
export type { ReplicaOptions, ReplicaUtils } from "./collection.js";

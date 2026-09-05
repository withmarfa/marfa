import {
  hydrateTypeRegistry,
  type TypeRegistryHydration,
} from "@withmarfa/shared";
import type { MarfaClient } from "../client.js";
import type { LocalStore } from "./store/index.js";
import { registryScope } from "./validate.js";

/**
 * The type graph, held locally.
 *
 * Rule 13. Platform types ship with `@withmarfa/shared` and are compiled
 * in, so they need nothing from here; custom types are read from
 * `GET /types` whenever the server is reachable and written to the store,
 * and registered into the shared registry on open so a write made with no
 * network is validated by the same rules the server applies.
 *
 * The registry this hydrates into is process-global and space-scoped. That
 * is not this module's choice — it is where `validateProperties` looks —
 * but it does mean two stores for two different spaces in one process
 * hydrate into two buckets, which is why the space is taken from the
 * store's own identity rather than passed in.
 */
export interface LocalTypeGraph {
  /**
   * Register what the store already holds.
   *
   * Reads nothing over the network, so a store opened with no connection
   * validates against whatever it wrote down last time. Answers how many
   * types were registered.
   */
  load(): Promise<number>;
  /**
   * Read the server's whole vocabulary, cache it, and register it.
   *
   * The whole listing rather than a slice: `hydrateTypeRegistry` states
   * why, and the short version is that registering an ancestor without its
   * descendants leaves those descendants compiled against the narrower
   * field set with nothing to evict them.
   */
  refresh(): Promise<TypeRegistryHydration>;
  /** What the last `refresh` reported, or undefined before one has run.
   *  `unresolvedParents` is the entry that matters: a break there means
   *  local validation is looser than the server's and will accept writes
   *  the server refuses. */
  readonly lastHydration: TypeRegistryHydration | undefined;
}

export interface TypeGraphOptions {
  store: LocalStore;
  client: MarfaClient;
  now?: () => string;
}

export function createTypeGraph(options: TypeGraphOptions): LocalTypeGraph {
  const { store, client } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const scope = registryScope(store.identity.spaceId);
  let lastHydration: TypeRegistryHydration | undefined;

  return {
    load: async () => {
      const held = await store.cachedTypes.list();
      if (held.length === 0) return 0;
      lastHydration = hydrateTypeRegistry(held, { spaceId: scope });
      return lastHydration.registered.length;
    },

    refresh: async () => {
      const listing = await client.types.list();
      // Registered before the write, and the write is not conditional on
      // it: a payload that registers is a payload worth keeping, and a
      // payload that throws while registering — a chain closed on itself,
      // a depth past the resolver's bound — is one the server holds and
      // this build cannot use, which is not a reason to throw away the
      // cache that is working.
      lastHydration = hydrateTypeRegistry(listing, { spaceId: scope });
      // Only what the platform registry does not already ship. A shipped
      // id written into the overlay is unreachable rather than
      // authoritative, so caching it would grow the table on every refresh
      // and change nothing about what validates.
      const shipped = new Set(lastHydration.skippedPlatform);
      await store.cachedTypes.replace(
        listing.filter((schema) => !shipped.has(schema.id)),
        now(),
      );
      return lastHydration;
    },

    get lastHydration() {
      return lastHydration;
    },
  };
}

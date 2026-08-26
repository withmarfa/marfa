/**
 * Whether an item's provenance still names something that exists.
 *
 * Removing a connection revokes every credential and stops the flow, and it
 * deliberately leaves the items that connection mirrored exactly where they
 * are: one click must not be able to destroy years of history, and data
 * nobody maintains is recoverable where deleted data is not. The half that
 * was missing is that those items then look identical to live ones, so
 * nothing tells a reader the thing keeping them current is gone.
 *
 * **This is derived per read, not stored on the row, and it is not a fourth
 * `ItemState`.** Three reasons, in the order they bite.
 *
 * `ItemState` is single-valued and mutually exclusive — `validateTransition`
 * enforces it — but an item can legitimately be both archived and orphaned:
 * somebody archives something, and later the connection that wrote it is
 * removed. A fourth state makes one of those two facts overwrite the other.
 * Orphaned is a second axis, not a fourth value on the first one.
 *
 * Provenance keys on the integration and the space, never on the connection.
 * `runtimeCredentialItemSource` stamps `integration:<manifest name>` for
 * exactly that reason, so an uninstall followed by a reinstall lands on the
 * items already there rather than forking the corpus. Orphan status is
 * therefore precisely a function of `(space, manifest name)`: is there still
 * a live integration connection in this space resolving that name. Derived,
 * that answer repairs itself the moment somebody reinstalls. Stored, the
 * reinstall path has to remember to clear the flag, and a flag nobody clears
 * is a flag that lies — silently, and in the direction that makes live data
 * look dead.
 *
 * An additive optional field also reaches no client. A new `ItemState`
 * member would have to be added to the hand-duplicated enums in the MCP
 * tool surface, the SDK's hardcoded union, the Swift SDK's hand-maintained
 * wire types, and the on-device store schema a shipped iOS app carries on
 * its own release cadence. An unknown field is ignored by all four.
 *
 * **Where it sits on the wire.** Top level on the item, beside `source`,
 * because it is a fact about the row's provenance rather than about its
 * content. `properties` is the integration's own copy of the upstream
 * record, so a key added there would be indistinguishable from something
 * the upstream sent and could collide with one outright. `metadata` is the
 * layer a person put over the item — tags and extensions somebody chose.
 * Neither describes this.
 *
 * **The connection walk answers to no read permission, deliberately.** It
 * reads `system.connection` rows through storage rather than through the
 * type gate, and hands back one boolean per item rather than anything off
 * those rows. A caller who can already see `source: "integration:<name>"`
 * on an item knows the integration wrote it; what this adds is whether it
 * is still installed here, which is the fact the item is being read for.
 * The lookup stays space-fenced, so it can say nothing about a space the
 * caller could not already read.
 *
 * **Absent is not false.** The field is present only on an item an
 * integration wrote. For everything else the question does not arise: a
 * hand-written note has no upstream to be cut off from and can never
 * acquire one, so `false` would assert an answer to a question nobody
 * asked. Present-and-false says the integration named in `source` is still
 * installed here; present-and-true says it is not.
 */
import type { Item } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { runtimeCredentialItemSource } from "../connections/lifecycle-lock.js";
import { manifestOfCatalogRow } from "../connections/upgrade-pipeline.js";
import { INTEGRATION_SOURCE_PREFIX } from "../middleware/auth.js";

/** Page size for the connection walk, matching `auto-upgrade.ts` — the same
 *  rows, read for a different question. */
const CONNECTION_SCAN_PAGE = 200;

/**
 * The answer for one batch of items, resolved once per request rather than
 * once per item. A page of a thousand mirrored rows asks the same question a
 * thousand times and it has the same answer every time; asking storage each
 * time would put a fan-out on the hottest read path in the product.
 */
export interface OrphanScope {
  /**
   * Every `integration:<name>` source with a live connection in the space.
   * Built through `runtimeCredentialItemSource`, the same function that
   * stamps the source onto the row at write time, so the reader and the
   * writer cannot drift on how the string is spelled.
   */
  readonly live: ReadonlySet<string>;
  /**
   * False when the batch this was resolved from held no integration-written
   * row at all, so the walk below was skipped and `live` is empty by
   * omission rather than by fact.
   *
   * Carried rather than inferred because the two empties mean opposite
   * things. Applied to an integration-written item, an unresolved scope
   * leaves it unmarked — a scope resolved from one batch and applied to
   * another then says nothing, where an empty `live` set would have said
   * "orphaned" about every row in the space.
   */
  readonly resolved: boolean;
}

const UNRESOLVED: OrphanScope = { live: new Set(), resolved: false };

function isIntegrationSourced(item: Pick<Item, "source">): boolean {
  return item.source.startsWith(INTEGRATION_SOURCE_PREFIX);
}

/**
 * Resolve the orphan answer for `items`, in the caller's space scope.
 *
 * Costs nothing when the batch holds no integration-written row, which is
 * the ordinary case for a space with no integrations installed and for most
 * pages in a space that has some. When it does cost something, it is one
 * connection listing plus one catalog lookup per *distinct* integration in
 * the space — bounded by how many things a space has installed, never by
 * how many items were read.
 *
 * Pair it with `withOrphanState` over the same batch.
 */
export async function resolveOrphanScope(
  storage: Storage,
  spaceId: string | undefined,
  items: readonly Pick<Item, "source">[],
): Promise<OrphanScope> {
  if (!items.some(isIntegrationSourced)) return UNRESOLVED;

  const live = new Set<string>();
  // A connection resolves its manifest through `integration_ref`, and
  // several connections in a space routinely point at the same catalog row.
  // Resolving each ref once is what keeps the cost per *integration* rather
  // than per connection.
  const seenRefs = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: { data: Item[]; cursor: string | null } =
      await storage.items.list({
        type: "system.connection",
        // The lifecycle axis, deliberately, and not `runtime_status`. Pause
        // is expressed on `runtime_status` precisely because it is
        // reversible and the connection is still installed, so a paused
        // integration's items are not orphaned — nobody removed anything.
        // An uninstall is what writes `revoked` here.
        state: "active",
        spaceId,
        limit: CONNECTION_SCAN_PAGE,
        ...(cursor === null ? {} : { cursor }),
      });
    for (const connection of page.data) {
      if (connection.properties.kind !== "integration") continue;
      const ref = connection.properties.integration_ref;
      if (typeof ref !== "string" || seenRefs.has(ref)) continue;
      seenRefs.add(ref);
      const source = runtimeCredentialItemSource(
        await manifestOfCatalogRow(storage, ref, spaceId),
      );
      // Null when the ref resolves to nothing usable. A connection whose
      // manifest cannot be resolved grants no provenance identity either
      // (see `runtimeCredentialItemSource`), so it can have written no rows
      // and there is nothing for it to keep alive.
      if (source !== null) live.add(source);
    }
    cursor = page.cursor;
  } while (cursor !== null);

  return { live, resolved: true };
}

/**
 * Add the derived answer to one serialized item, or leave it alone when
 * there is no answer to give.
 */
export function withOrphanState<T extends Pick<Item, "source">>(
  item: T,
  scope: OrphanScope,
): T & { orphaned?: boolean } {
  if (!scope.resolved || !isIntegrationSourced(item)) return item;
  return { ...item, orphaned: !scope.live.has(item.source) };
}

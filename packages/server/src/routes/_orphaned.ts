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
 * a live integration connection in that space resolving that name. Derived,
 * that answer repairs itself the moment somebody reinstalls. Stored, the
 * reinstall path has to remember to clear the flag, and a flag nobody clears
 * is a flag that lies — silently, and in the direction that makes live data
 * look dead.
 *
 * An additive optional field also costs no client a migration. A new
 * `ItemState` member would have to be added to the hand-duplicated enums in
 * the MCP tool surface, the SDK's union, the Swift SDK's hand-maintained
 * wire types, and the on-device store schema a shipped iOS app carries on
 * its own release cadence. An optional field is declared once, on `Item` in
 * `@withmarfa/shared`, which the TypeScript SDK re-exports — so a typed
 * client reads it without a cast — and is ignored by every client that has
 * not been rebuilt.
 *
 * **The space comes from the item, never from the caller.** This is the
 * whole reason the resolver is shaped the way it is. `ItemFilters.spaceId`
 * reads an absent value as *no fence* rather than as the space-less bucket
 * (`storage/space-condition.ts` says so, and settled it deliberately), and
 * a platform-admin bearer legitimately carries no `space_id` while reading
 * items from every space at once. Keyed on the caller, one tenant's live
 * `acme/calendar` connection answered for another tenant's orphaned
 * `acme/calendar` rows, which serialized them `orphaned: false` — dead data
 * reading live, on the exact surface an operator would use to investigate
 * it, and flipping back to healthy whenever any unrelated tenant installed
 * the same integration. Every item carries `space_id` on every read path, so
 * the batch is grouped by the rows' own spaces and each row is judged
 * against its own.
 *
 * **The connection walk answers to no read permission, deliberately.** It
 * reads `system.connection` rows through storage rather than through the
 * type gate, and hands back one boolean per item rather than anything off
 * those rows. A caller who can already see `source: "integration:<name>"`
 * on an item knows the integration wrote it; what this adds is whether it is
 * still installed there, which is the fact the item is being read for.
 *
 * **Where it sits on the wire.** Top level on the item, beside `source`,
 * because it is a fact about the row's provenance rather than about its
 * content. `properties` is the integration's own copy of the upstream
 * record, so a key added there would be indistinguishable from something
 * the upstream sent and could collide with one outright. `metadata` is the
 * layer a person put over the item — tags and extensions somebody chose.
 * Neither describes this.
 *
 * **Absent is not false, and that contract binds every emitter.** The field
 * is present only on an item an integration wrote. For everything else the
 * question does not arise: a hand-written note has no upstream to be cut off
 * from and can never acquire one, so `false` would assert an answer to a
 * question nobody asked. Present-and-false says the integration named in
 * `source` is still installed there; present-and-true says it is not.
 *
 * That reading only holds if *everything* handing an item to a client
 * decorates it. A `PATCH` response that omitted the field told a client
 * following this contract that no integration wrote the row — the opposite
 * of the truth — and a client applying SSE updates over a `GET /items` page
 * watched `orphaned: true` vanish on the first unrelated edit. So the read
 * routes, the write routes that echo the item back, and the event stream all
 * go through `withOrphanState`; `routes/items.ts` and `routes/events.ts` are
 * where that is easiest to break.
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
 * How a space is keyed here. `null` is the space-less bucket, which is every
 * row on a self-host and the platform-scoped catalog rows on a hosted
 * instance. `Item.space_id` is optional on the type but set on every row
 * both dialects return, so the normalization is a formality rather than a
 * guess.
 */
type SpaceKey = string | null;

function spaceKeyOf(item: Pick<Item, "space_id">): SpaceKey {
  return item.space_id ?? null;
}

/**
 * The answer for one batch of items: per space, the `integration:<name>`
 * sources that still have a live connection there.
 *
 * A space absent from the map was not resolved, and an item in it is left
 * unmarked rather than called orphaned. The two empties mean opposite
 * things — "this space has no live integrations" is a fact, "nobody asked
 * about this space" is not — and conflating them would have every row in an
 * unasked space serialize `orphaned: true`.
 */
export interface OrphanScope {
  readonly live: ReadonlyMap<SpaceKey, ReadonlySet<string>>;
}

/** Nothing in the batch was integration-written, so nothing was asked. */
const EMPTY_SCOPE: OrphanScope = { live: new Map() };

/**
 * The `typeof` guard is not belt-and-braces on a field the type says is a
 * string. This runs on the event fan-out, where the item comes off a
 * published envelope rather than out of a fresh read, and on the replay
 * path, where it comes out of `JSON.parse` over a payload stored days ago.
 * A throw there does not drop a field, it rejects the pump's promise and
 * disconnects the viewer — so an item that cannot answer the question gets
 * no answer, which is the failure direction this whole field is built
 * around.
 */
function isIntegrationSourced(item: Pick<Item, "source">): boolean {
  return (
    typeof item.source === "string" &&
    item.source.startsWith(INTEGRATION_SOURCE_PREFIX)
  );
}

export interface OrphanResolverOptions {
  /**
   * How long a resolved space may be reused before it is walked again.
   *
   * Omit it for anything request-shaped: the resolver outlives the request
   * by nothing, so a memo for its own lifetime is exactly one walk per space
   * and cannot go stale. The event stream is the caller that needs a bound,
   * because it lives for hours and would otherwise report an integration
   * installed for as long as the client stayed connected.
   */
  ttlMs?: number;
}

/**
 * A resolver that remembers the spaces it has already walked.
 *
 * Long-lived readers — the export stream, the event stream — hold one of
 * these for their whole run so a space is walked once rather than once per
 * page or once per event. One-shot handlers take {@link resolveOrphanScope}
 * instead, which is this with a resolver that lives for one call.
 */
export interface OrphanResolver {
  resolve(
    items: readonly Pick<Item, "source" | "space_id">[],
  ): Promise<OrphanScope>;
}

export function createOrphanResolver(
  storage: Storage,
  options: OrphanResolverOptions = {},
): OrphanResolver {
  const memo = new Map<SpaceKey, { live: ReadonlySet<string>; at: number }>();
  const ttlMs = options.ttlMs;

  const fresh = (entry: { at: number }): boolean =>
    ttlMs === undefined || Date.now() - entry.at < ttlMs;

  return {
    async resolve(items) {
      // The ordinary page holds no integration-written row, and this is the
      // branch that keeps the walk off the hottest read path in the product.
      const wanted = new Set<SpaceKey>();
      for (const item of items) {
        if (isIntegrationSourced(item)) wanted.add(spaceKeyOf(item));
      }
      if (wanted.size === 0) return EMPTY_SCOPE;

      // Spaces are independent, and a batch spans more than one only on an
      // unfenced platform-admin read — where walking them in sequence would
      // add a round trip per space to a query that already spans the
      // instance.
      const resolved = await Promise.all(
        [...wanted].map(
          async (key): Promise<[SpaceKey, ReadonlySet<string>]> => {
            const cached = memo.get(key);
            if (cached && fresh(cached)) return [key, cached.live];
            const walked = await liveIntegrationSources(storage, key);
            memo.set(key, { live: walked, at: Date.now() });
            return [key, walked];
          },
        ),
      );
      return { live: new Map(resolved) };
    },
  };
}

/** One batch, one resolver. See {@link createOrphanResolver} for the shape
 *  a stream wants instead. */
export function resolveOrphanScope(
  storage: Storage,
  items: readonly Pick<Item, "source" | "space_id">[],
): Promise<OrphanScope> {
  return createOrphanResolver(storage).resolve(items);
}

/** Every `integration:<name>` with a live connection in one space. */
async function liveIntegrationSources(
  storage: Storage,
  spaceKey: SpaceKey,
): Promise<ReadonlySet<string>> {
  // Every ref is collected before any of them is fetched, and the fetches
  // then go out together. Several connections in a space routinely resolve
  // the same catalog row, so the set is smaller than the connection count,
  // and resolving it inside the page loop would have been one awaited round
  // trip per connection.
  const refs = new Set<string>();
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
        // `kind` is narrowed in SQL rather than by discarding rows after
        // they arrive: a space's app-kind connections are its OAuth grants,
        // and on a busy account they outnumber its integrations enough to
        // turn one page into several.
        filter: 'properties.kind eq "integration"',
        // `undefined` is the only shape `ItemFilters` can express for the
        // space-less bucket and it means *no fence*, so the bucket is
        // narrowed below instead of here. On a self-host the two coincide,
        // because every row in the database is in that bucket.
        ...(spaceKey === null ? {} : { spaceId: spaceKey }),
        limit: CONNECTION_SCAN_PAGE,
        ...(cursor === null ? {} : { cursor }),
      });
    for (const connection of page.data) {
      // The belt on the fence above, and the one line that closes the
      // cross-space hole for good: a row is only allowed to answer for the
      // space it is actually in, whatever the query returned.
      if (spaceKeyOf(connection) !== spaceKey) continue;
      const ref = connection.properties.integration_ref;
      if (typeof ref === "string") refs.add(ref);
    }
    cursor = page.cursor;
  } while (cursor !== null);

  if (refs.size === 0) return new Set();

  const manifests = await Promise.all(
    [...refs].map((ref) =>
      manifestOfCatalogRow(
        storage,
        ref,
        // Catalog rows carry no space, and `manifestOfCatalogRow` widens to
        // reach them. A space-less key has nothing to widen from.
        spaceKey ?? undefined,
      ),
    ),
  );

  const live = new Set<string>();
  for (const manifest of manifests) {
    const source = runtimeCredentialItemSource(manifest);
    // Null when the ref resolves to nothing usable. A connection whose
    // manifest cannot be resolved grants no provenance identity either (see
    // `runtimeCredentialItemSource`), so it can have written no rows and
    // there is nothing for it to keep alive.
    if (source !== null) live.add(source);
  }
  return live;
}

/**
 * Add the derived answer to one serialized item, or leave it alone when
 * there is no answer to give.
 */
export function withOrphanState<T extends Pick<Item, "source" | "space_id">>(
  item: T,
  scope: OrphanScope,
): T & { orphaned?: boolean } {
  if (!isIntegrationSourced(item)) return item;
  const live = scope.live.get(spaceKeyOf(item));
  if (!live) return item;
  return { ...item, orphaned: !live.has(item.source) };
}

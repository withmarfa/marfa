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
 * items already there rather than forking the corpus. Derived rather than
 * stored, the answer repairs itself; stored, the reinstall path has to
 * remember to clear the flag, and a flag nobody clears is a flag that lies —
 * silently, and in the direction that makes live data look dead.
 *
 * **Orphan status was a function of `(space, manifest name)` and is not any
 * more (D63).** That answer could not see the case it most needed to: two
 * connections of one integration produce one provenance string, so removing
 * one left every row it wrote reading `orphaned: false` on the strength of
 * its sibling. The field's stated contract was answered correctly — the
 * integration named in `source` is still installed — while the question a
 * reader actually asks, whether anything will ever refresh this again, was
 * not. The row's recorded writer is what closes that, and a row that carries
 * none still gets the `(space, manifest name)` answer, which is every row
 * written before the column existed.
 *
 * **One D34-era guarantee is narrowed deliberately.** Orphan status used to
 * repair itself at the moment of reinstall; it now repairs on the first
 * re-sync after it, because that is when the adopting write re-stamps the
 * row. That is the more honest answer — a reinstall pointed at a different
 * upstream scope adopts nothing, and the old rule called those rows healthy.
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
 * **Absent is not false, and that contract binds every REST response that
 * carries an item** — the reads, and the writes that echo the row back. The
 * field is present only on an item an integration wrote. For everything else the
 * question does not arise: a hand-written note has no upstream to be cut off
 * from and can never acquire one, so `false` would assert an answer to a
 * question nobody asked. Present-and-false says the integration named in
 * `source` is still installed there; present-and-true says it is not.
 *
 * That reading only holds where something answers, so the read routes and
 * the write routes that echo the row back all go through `withOrphanState`.
 * A `PATCH` that omitted the field told a client following this contract
 * that no integration wrote the row, which is the opposite of the truth.
 *
 * Two exceptions to "every response", neither of which a client can trip
 * over. The connection and integration routes hand back `system.connection`
 * rows undecorated, and those can never be integration-sourced — their
 * provenance is the credential that installed them. And absence carries a
 * second, internal meaning inside this module: a space nobody resolved. It
 * has never reached the wire, because every call site resolves precisely
 * the batch it decorates, and a call site that stopped doing that would be
 * the bug rather than the contract changing.
 *
 * **The event stream is the one surface that does not carry it, and that is
 * a decision rather than an omission.** The stream cannot deliver the fact
 * this field exists to report: uninstalling a connection publishes no item
 * events, so the transition from live to orphaned never arrives on it under
 * any implementation. Decorating it only made *unrelated* events carry an
 * incidentally-current value, and it cost four defects in the pump, three of
 * them silent — a replayed payload predating the space fix resolved against
 * the wrong space and asserted `orphaned: true` about a healthy integration
 * for the whole retention window; a storage failure mid-drain discarded the
 * rest of the buffer while the cursor advanced past the gap; the awaits made
 * a previously atomic drain interleave with the live pump and deliver frames
 * out of order; and an unguarded reject closed the viewer's stream.
 *
 * So: **`orphaned` is a read-time derivation. It is present on read
 * responses, absent from every event frame, and a client merging stream
 * frames over a read must not treat its absence there as a value.** Carry
 * the value from the read and re-read to refresh it. Anyone tempted to add
 * it to `routes/events.ts` should start with the paragraph above.
 */
import type { ApiKey, Item } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { runtimeCredentialItemSource } from "../connections/lifecycle-lock.js";
import { manifestOfCatalogRow } from "../connections/upgrade-pipeline.js";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
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
  /**
   * The items judged orphaned, by id (D63).
   *
   * The verdict is computed in the resolver rather than in
   * {@link withOrphanState}, because the fact it turns on — which connection
   * wrote the row — is deliberately not on `Item` and so is not in the
   * serializer's hand. Computing it here also keeps one rule in one place
   * rather than at each of the fifteen call sites.
   *
   * Only ever consulted for a space present in `live`, so an item in an
   * unasked space is still left unmarked rather than called orphaned.
   */
  readonly orphanedIds: ReadonlySet<string>;
}

/** One space's live installs: the provenance strings and the connection ids
 *  behind them, from one walk so the two cannot disagree. */
interface LiveScope {
  readonly sources: ReadonlySet<string>;
  readonly connections: ReadonlySet<string>;
}

/** Nothing in the batch was integration-written, so nothing was asked. */
const EMPTY_SCOPE: OrphanScope = {
  live: new Map(),
  orphanedIds: new Set(),
};

function isIntegrationSourced(item: Pick<Item, "source">): boolean {
  return item.source.startsWith(INTEGRATION_SOURCE_PREFIX);
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
    items: readonly Pick<Item, "id" | "source" | "space_id">[],
  ): Promise<OrphanScope>;
}

export function createOrphanResolver(
  storage: Storage,
  options: OrphanResolverOptions = {},
): OrphanResolver {
  const memo = new Map<SpaceKey, { scope: LiveScope; at: number }>();
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
        [...wanted].map(async (key): Promise<[SpaceKey, LiveScope]> => {
          const cached = memo.get(key);
          if (cached && fresh(cached)) return [key, cached.scope];
          const walked = await liveIntegrationScope(storage, key);
          memo.set(key, { scope: walked, at: Date.now() });
          return [key, walked];
        }),
      );
      const scopes = new Map(resolved);

      // Deliberately outside the memo. The walk describes a space and is
      // safe to reuse for a resolver's lifetime; this describes the rows in
      // *this* batch and is not. A long-lived reader — the export stream,
      // the event stream — holds one resolver for hours, and a memoized
      // writer map would answer every later page from the first one's rows.
      const writers = await storage.items.writersOf(
        items.filter(isIntegrationSourced).map((item) => item.id),
      );

      const orphanedIds = new Set<string>();
      for (const item of items) {
        if (!isIntegrationSourced(item)) continue;
        const scope = scopes.get(spaceKeyOf(item));
        if (!scope) continue;
        const writer = writers.get(item.id) ?? null;
        // Null is not "unknown" and not "orphaned": it is the pre-column
        // state, where the finest answer available is the manifest's, so
        // the manifest's answer is given. Every such row gains a writer on
        // its next integration write.
        const orphaned =
          writer === null
            ? !scope.sources.has(item.source)
            : !scope.connections.has(writer);
        if (orphaned) orphanedIds.add(item.id);
      }

      return {
        live: new Map([...scopes].map(([key, scope]) => [key, scope.sources])),
        orphanedIds,
      };
    },
  };
}

/** One batch, one resolver. See {@link createOrphanResolver} for the shape
 *  a stream wants instead. */
export function resolveOrphanScope(
  storage: Storage,
  items: readonly Pick<Item, "id" | "source" | "space_id">[],
): Promise<OrphanScope> {
  return createOrphanResolver(storage).resolve(items);
}

/**
 * Whether the caller may write a row it has resolved, and what that means
 * for the row's recorded writer (D63).
 *
 * `source` is `integration:<manifest name>` for every connection of one
 * integration in a space, deliberately, so that reinstalling adopts the
 * corpus it created (D34). The cost is that two live connections share one
 * natural-key namespace, and `permitsMirrorWrite` — which compares that same
 * shared string — treats them as one writer by construction. Nothing in
 * `(source, source_id)` can tell them apart, so the row's recorded writer
 * is what does.
 *
 * **The refusal is on liveness, not on difference, and that qualifier is
 * the whole design.** Refusing whenever the writer differs would wedge every
 * corpus at its first reinstall: a new connection meets rows owned by the
 * old one and is refused on all of them, permanently, which is worse than
 * the duplication D34 exists to prevent. A writer that is gone, or was never
 * recorded, is adopted and re-stamped — which is exactly what a reinstall
 * did before this column existed, and `reinstall-adoption.test.ts` is the
 * file that falsifies this if the qualifier is ever dropped.
 *
 * Returns `"own"` when nothing need change and `"adopt"` when the caller
 * should stamp itself as the writer. Throws only when a *live* sibling owns
 * the row.
 */
export function checkOwningConnection(
  key: ApiKey | undefined,
  row: Pick<Item, "id" | "source">,
  writer: string | null,
  isWriterLive: (connectionId: string) => boolean,
): "own" | "adopt" {
  if (!isIntegrationSourced(row)) return "own";
  const mine = key?.is_runtime_credential === true ? key.connection_id : null;
  // Not a runtime credential: this is a person or an app touching an
  // integration's row, which `requireMirrorProtection` already rules on.
  // Adding a second opinion here would refuse the promote path.
  if (mine === null || mine === undefined) return "own";
  // **Only a sibling of the same integration.** A row a *different*
  // integration wrote is `requireMirrorProtection`'s to refuse, and it
  // already does, with a message and a remedy that fit — promote it to edit
  // your own copy. Answering `provenance_collision` there would tell the
  // caller to scope a `source_id` it does not own, and it would take a
  // refusal away from the gate that a test names as its owner.
  if (key?.item_source !== row.source) return "own";
  if (writer === null) return "adopt";
  if (writer === mine) return "own";
  if (!isWriterLive(writer)) return "adopt";
  throw new MarfaError(
    ErrorCode.PROVENANCE_COLLISION,
    `source_id "${row.source}" resolves an item written by connection ${writer}, which is still installed. Two connections of one integration are two corpora; this write is refused rather than overwriting. Scope this record's source_id to the upstream source it came from.`,
    {
      item_id: row.id,
      source: row.source,
      owning_connection_id: writer,
      writing_connection_id: mine,
    },
  );
}

/**
 * {@link checkOwningConnection} for a single row, doing its own reads.
 *
 * Two of them, and only the first always runs: one indexed by-id column read
 * for the writer, and — only when the writer is somebody else — the space's
 * connection walk to ask whether that somebody is still installed. The
 * expensive half is therefore paid on the adoption sweep after a reinstall,
 * once per row and once ever, rather than on every write.
 */
export function createOwnershipGuard(
  storage: Storage,
): (
  key: ApiKey | undefined,
  row: Pick<Item, "id" | "source" | "space_id">,
) => Promise<"own" | "adopt"> {
  // Memoized for the guard's lifetime, which is one request. Without it a
  // door that guards a batch pays one connection walk PER ROW, and that is
  // not the rare path it looks like: after a reinstall every row in the
  // corpus takes the writer-is-somebody-else branch, because adoption over
  // a dead writer needs the same liveness answer the refusal does. A
  // re-sync of five thousand records would have run five thousand walks.
  const live = new Map<SpaceKey, ReadonlySet<string>>();
  return async (key, row) => {
    if (!isIntegrationSourced(row)) return "own";
    const mine = key?.is_runtime_credential === true ? key.connection_id : null;
    if (mine === null || mine === undefined) return "own";
    // Same narrowing as `checkOwningConnection`, applied before the read so
    // a cross-integration write costs no query at all.
    if (key?.item_source !== row.source) return "own";
    const writers = await storage.items.writersOf([row.id]);
    const writer = writers.get(row.id) ?? null;
    if (writer === null || writer === mine) {
      return writer === null ? "adopt" : "own";
    }
    const spaceKey = spaceKeyOf(row);
    let known = live.get(spaceKey);
    if (!known) {
      known = (await liveIntegrationScope(storage, spaceKey)).connections;
      live.set(spaceKey, known);
    }
    const resolved = known;
    return checkOwningConnection(key, row, writer, (id) => resolved.has(id));
  };
}

/**
 * {@link createOwnershipGuard} for a door that guards exactly one row.
 *
 * Two reads, and only the first always runs: one indexed by-id column read
 * for the writer, and — only when the writer is somebody else — the space's
 * connection walk to ask whether that somebody is still installed.
 */
export async function requireOwningConnection(
  storage: Storage,
  key: ApiKey | undefined,
  row: Pick<Item, "id" | "source" | "space_id">,
): Promise<"own" | "adopt"> {
  return createOwnershipGuard(storage)(key, row);
}

/** The live connection ids in one space, for a door that guards a batch and
 *  wants one walk rather than one per row. */
export async function liveConnectionIds(
  storage: Storage,
  spaceKey: SpaceKey,
): Promise<ReadonlySet<string>> {
  return (await liveIntegrationScope(storage, spaceKey)).connections;
}

/**
 * One space's live integration installs, both ways of naming them.
 *
 * `sources` is every `integration:<name>` with a live connection, which is
 * the pre-D63 answer and is still what a row with no recorded writer is
 * judged against. `connections` is the ids of those same connections, which
 * is what a row that does carry a writer is judged against.
 *
 * Both come off one walk. The loop was already reading the connection rows
 * and already had their ids in hand, so the second set costs nothing beyond
 * holding it — and two walks could disagree.
 */
async function liveIntegrationScope(
  storage: Storage,
  spaceKey: SpaceKey,
): Promise<LiveScope> {
  // Every ref is collected before any of them is fetched, and the fetches
  // then go out together. Several connections in a space routinely resolve
  // the same catalog row, so the set is smaller than the connection count,
  // and resolving it inside the page loop would have been one awaited round
  // trip per connection.
  const refs = new Set<string>();
  // ref -> the connections resolving it, so a connection joins the live set
  // only if its own ref resolved. Several connections routinely share a ref.
  const byRef = new Map<string, string[]>();
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
      // Held rather than added, because both sets have to answer to the
      // same condition. A connection whose ref resolves to nothing usable
      // keeps no provenance string alive — the loop below says why — and
      // it must not keep its own id alive either. Adding it here
      // unconditionally made a connection that cannot be resolved read as
      // live on the connection axis while reading as dead on the source
      // axis, so its rows flipped to `orphaned: false` and a sibling
      // re-syncing one of them was refused against a writer that can never
      // write again.
      if (typeof ref === "string") {
        refs.add(ref);
        byRef.set(ref, [...(byRef.get(ref) ?? []), connection.id]);
      }
    }
    cursor = page.cursor;
  } while (cursor !== null);

  if (refs.size === 0) return { sources: new Set(), connections: new Set() };

  const ordered = [...refs];
  const manifests = await Promise.all(
    ordered.map((ref) =>
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
  const connections = new Set<string>();
  for (const [ref, manifest] of ordered.map(
    (r, i) => [r, manifests[i]] as const,
  )) {
    const source = runtimeCredentialItemSource(manifest);
    // Null when the ref resolves to nothing usable. A connection whose
    // manifest cannot be resolved grants no provenance identity either (see
    // `runtimeCredentialItemSource`), so it can have written no rows and
    // there is nothing for it to keep alive — on either axis.
    if (source === null) continue;
    live.add(source);
    for (const id of byRef.get(ref) ?? []) connections.add(id);
  }
  return { sources: live, connections };
}

/**
 * Add the derived answer to one serialized item, or leave it alone when
 * there is no answer to give.
 */
export function withOrphanState<
  T extends Pick<Item, "id" | "source" | "space_id">,
>(item: T, scope: OrphanScope): T & { orphaned?: boolean } {
  if (!isIntegrationSourced(item)) return item;
  // Presence in `live` is what says the space was asked about; the verdict
  // itself comes from `orphanedIds`, which the resolver computed with the
  // row's writer in hand. Keeping the two apart is what stops "this space
  // has no live integrations" and "nobody asked" collapsing into one answer.
  if (!scope.live.has(spaceKeyOf(item))) return item;
  return { ...item, orphaned: scope.orphanedIds.has(item.id) };
}

/**
 * The scope for a response echoing back a row the calling credential itself
 * wrote — answered from the credential, with no query.
 *
 * **Gated on `is_runtime_credential`, not on the shape of the source
 * string.** Only `createRuntimeCredential` sets that flag; `keys.create`
 * cannot. The string is not safe to reason from: two of the three mint
 * routes refuse a caller-supplied `integration:` source, and the third —
 * the console's self-serve form — writes the caller's `label` straight into
 * `source` with no such check. A space owner could mint one labelled
 * `integration:acme/calendar`, and since it carries no `item_source`,
 * `itemProvenanceSource` would hand back the forged value. Reading the flag
 * instead makes that unreachable rather than merely unlikely.
 *
 * With the flag established, the credential answers the question: uninstall
 * revokes every runtime credential bound to a connection before it revokes
 * the connection, so one that just authenticated belongs to a connection
 * that is still installed. Provenance keys on `(space, manifest name)`
 * rather than on the connection, and the two remaining equalities pin both
 * halves — `item_source` against the row's source for the name, `space_id`
 * against the row's for the space. Without the space equality the match
 * would be safe only by the accident that no route hands this a row from
 * outside the caller's fence.
 *
 * **Decided from the data, not from the call site.** Any row in the batch
 * that fails those equalities drops the whole call back to the real
 * resolution rather than going unanswered. That is what the fallback is
 * for, and it runs in both directions: an integration touching a row a
 * *removed* integration wrote must not be told `false`, and one touching a
 * row a *live* integration wrote must not be told `true`. Two integrations
 * declaring the same type in `target_types` makes both reachable, because
 * lifecycle gestures are exempt from mirror protection.
 *
 * Worth roughly one listing plus one catalog get per distinct integration in
 * the space, on every integration-sourced single-item write that misses.
 */
export async function resolveOrphanScopeForOwnWrite(
  storage: Storage,
  items: readonly Pick<Item, "id" | "source" | "space_id">[],
  key: ApiKey | undefined,
): Promise<OrphanScope> {
  const ownSource =
    key?.is_runtime_credential === true ? key.item_source : null;
  if (ownSource === null || ownSource === undefined) {
    return resolveOrphanScope(storage, items);
  }
  const ownConnection = key?.connection_id ?? null;
  const callerSpace: SpaceKey = key?.space_id ?? null;
  const live = new Map<SpaceKey, ReadonlySet<string>>();
  const integrationSourced: Pick<Item, "id" | "source" | "space_id">[] = [];
  for (const item of items) {
    if (!isIntegrationSourced(item)) continue;
    if (item.source !== ownSource || spaceKeyOf(item) !== callerSpace) {
      return resolveOrphanScope(storage, items);
    }
    integrationSourced.push(item);
    live.set(spaceKeyOf(item), new Set([ownSource]));
  }
  if (integrationSourced.length === 0) return { live, orphanedIds: new Set() };

  // The equalities above no longer settle it (D63). They pin the manifest
  // and the space, and a *sibling* connection's row satisfies both — so
  // answering "live" from them would tell an integration that a row a
  // removed twin wrote is still maintained.
  //
  // On the write doors the guard has already run, so the row's writer is
  // this connection by construction — either it already was, or the adopt
  // arm just stamped it. The doors that can legitimately reach a twin's row
  // are the lifecycle gestures, which are exempt from the guard, so one
  // by-id column read replaces a listing plus a catalog get per integration
  // and falls back whenever it finds a writer that is not this one.
  const writers = await storage.items.writersOf(
    integrationSourced.map((item) => item.id),
  );
  for (const item of integrationSourced) {
    const writer = writers.get(item.id) ?? null;
    // A null writer is the pre-column state and the source equality above
    // is the best answer available for it, which is exactly what this
    // shortcut already gave. A writer that is somebody else is decided from
    // the data rather than from the call site.
    if (writer !== null && writer !== ownConnection) {
      return resolveOrphanScope(storage, items);
    }
  }
  return { live, orphanedIds: new Set() };
}

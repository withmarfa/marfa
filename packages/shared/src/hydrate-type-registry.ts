import type { TypeSchema } from "@withmarfa/types";
import { ErrorCode, MarfaError } from "./errors.js";
import {
  MAX_RESOLUTION_DEPTH,
  TYPE_REGISTRY,
  classifyNamespace,
  getTypeSchema,
  listTypes,
  registerTypeSchema,
  unregisterTypeSchema,
} from "./type-registry.js";

/**
 * The tiers the platform owns outright — exactly the three `POST /types`
 * refuses for every credential, platform included. An id under one of them
 * can only have arrived by being seeded, never by being registered, which is
 * what lets this helper classify one by name.
 */
const PLATFORM_TIERS: ReadonlySet<string> = new Set([
  "core",
  "system",
  "marfa",
]);

/** Options for {@link hydrateTypeRegistry}. */
export interface HydrateTypeRegistryOptions {
  /**
   * Owning space for the registrations. Omit for the null-space bucket
   * (single-space self-hosts, platform-registered types) — the same
   * convention `registerTypeSchema` follows.
   */
  spaceId?: string | null;
}

/** What a hydration registered, and what a caller has to know about it. */
export interface TypeRegistryHydration {
  /** Ids registered, in the order they were registered. */
  registered: string[];
  /**
   * Payload entries the platform registry already ships. They are left
   * alone because `listTypes` concatenates the platform registry with the
   * space's own map and deduplicates neither, so a shipped type written
   * into the overlay is listed twice — once from each side. Lookups are
   * unaffected: `resolveSchema` reads the platform registry first and
   * returns, so an overlay entry under a shipped id is unreachable rather
   * than authoritative.
   */
  skippedPlatform: string[];
  /**
   * Registered ids whose declared parent resolves nowhere — not in the
   * payload, not in the platform registry, not already in this space.
   *
   * The one entry a caller must act on. Field resolution stops at the
   * break, so the type validates against a narrower field set than the
   * server holds, and a required field declared by the missing ancestor is
   * not enforced at all: local validation then *accepts* a write the server
   * refuses. Refetching with a credential that can read the ancestor is the
   * repair; ignoring it queues writes that come back refused.
   */
  unresolvedParents: string[];
  /**
   * Ids evicted from this space's overlay because the listing no longer
   * carries them, in the order the registry held them.
   *
   * A deleted type stops appearing in the listing rather than arriving as a
   * tombstone, so nothing but absence says it is gone. Hydration that only
   * ever added kept it valid locally for ever, and the client went on
   * accepting writes against a type the server had forgotten — refused on
   * arrival, and a refusal for an unknown type reads as permanent rather
   * than retryable.
   *
   * Scoped to the bucket `spaceId` names and to types this build does not
   * ship. Nothing global is touched: the platform map is shared by every
   * space, so one space's listing may not evict from it.
   */
  removed: string[];
  /**
   * Registered ids under a tier the platform owns (`core.*`, `system.*`,
   * `marfa.*`) that this build does not ship. Every id here is also in
   * `registered`.
   *
   * An instance's shipped vocabulary is seeded data, so a listing can carry
   * platform types a client's own build never compiled in. They register into
   * the overlay because that is the only map a client may write — the
   * platform map is global, and a space-scoped listing may not reach it — and
   * the lifecycle rules read the identifier rather than the map, so the type
   * still gets the lifecycle its family has.
   *
   * Reported because the overlay is not where the server keeps them, and a
   * caller comparing its vocabulary against the server's should be able to
   * see the gap rather than infer it. A non-empty entry means the build is
   * behind the instance it is talking to.
   */
  unshippedPlatform: string[];
  /**
   * Registered ids whose declared parent chain closes on itself.
   *
   * Registered rather than skipped, because the server holds the same rows
   * and answers the same way: resolving such a chain raises
   * `type_chain_unresolvable` on either side. Skipping would make the client
   * report an unknown type for a type the server knows, which is a
   * disagreement where there was none.
   */
  cycles: string[];
}

/**
 * Registers a `GET /types` payload's custom types into the local registry, so
 * a client validates a write by the rules the server applies without asking
 * the server.
 *
 * Not a second registration entry point. It filters the payload down to the
 * types this build does not already ship, works out an order, calls
 * `registerTypeSchema` — the one that already exists — for each, and then
 * drops whatever the space still held that the listing did not carry.
 *
 * **A hydration converges on the payload rather than accumulating.** The
 * listing is the whole of what the space may see, so a type missing from it
 * has been deleted, and the client's copy is only useful while it says the
 * same thing. Adding alone left a deleted type valid locally for ever, which
 * is the expensive direction: local validation accepted a write the server
 * then refused, and an unknown-type refusal reads as permanent rather than
 * retryable, so a queue built on this helper dead-letters it.
 *
 * **Order is for the report, not for the registry.** Field resolution is
 * lazy: `getResolvedFields` walks the parent chain when a schema is compiled,
 * and each registration evicts its own compiled schema, so registering a
 * child before its parent produces exactly the same registry as the reverse.
 * The graph walk is here because a cycle and an unresolvable parent cannot be
 * reported without one, and parents-first falls out of that walk for free.
 * Anyone tempted to drop the ordering should know it costs the diagnostics
 * rather than correctness — and anyone tempted to rely on it should know the
 * map does not.
 *
 * **Pass the whole listing, not a slice of one.** This was advisory while the
 * helper only added; convergence makes it the contract, because a slice now
 * says that everything outside it has been deleted and this deletes it.
 *
 * It stays a precondition rather than a parameter, and the reason is that
 * there is no second answer to give. `GET /types` takes no filter and returns
 * the whole vocabulary, so a partial payload is something a caller has to
 * build deliberately — and a partial payload was already unsafe before any
 * of this: registering an ancestor that has become visible, while a
 * descendant of it sits outside the payload and already has a compiled
 * schema, leaves that descendant validating against the narrower field set
 * with nothing to evict it. A mode admitting a slice would therefore be a
 * supported spelling of the defect this helper exists to prevent, so the
 * signature would be documenting a choice that has only one correct value.
 *
 * What replaces the parameter is the report. `removed` names every eviction,
 * so a caller that passes a slice sees the whole of the damage in the return
 * value at the moment it happens, rather than meeting it later as a type
 * that has quietly stopped resolving. Should `GET /types` ever grow a filter,
 * that entry is what will make the need for a parameter obvious.
 *
 * **The payload is not re-validated.** These schemas are what the server
 * accepted at registration, and a client running an older `@withmarfa/shared`
 * than the server would refuse types the server holds — then refuse the
 * writes against them, which is worse than not caching at all. The report
 * carries what a caller needs to know; nothing here overrules the server.
 */
export function hydrateTypeRegistry(
  types: readonly TypeSchema[],
  options?: HydrateTypeRegistryOptions,
): TypeRegistryHydration {
  const spaceId = options?.spaceId;
  const skippedPlatform: string[] = [];
  const unshippedPlatform: string[] = [];
  // Insertion order is the payload's order, which is what makes the walk
  // below deterministic for a payload that admits more than one valid order.
  const custom = new Map<string, TypeSchema>();
  for (const schema of types) {
    // The live platform map rather than a namespace test: an instance's
    // shipped vocabulary is seeded data, so it can hold a type this build
    // never compiled in, and membership here is exactly the question of
    // whether the type is already resolvable without a space.
    if (TYPE_REGISTRY.has(schema.id)) {
      skippedPlatform.push(schema.id);
      continue;
    }
    // Whether the type is already resolvable and whose vocabulary it belongs
    // to are two questions, and only the second can be answered by name. The
    // skip above asks the first and must keep asking the map; this asks the
    // second, and asks it of the name because a reserved-tier id can only
    // have been seeded — registration under one is refused for every
    // credential. Registered like any other payload entry, and named here so
    // a caller can see its build is behind the instance.
    if (PLATFORM_TIERS.has(classifyNamespace(schema.id))) {
      unshippedPlatform.push(schema.id);
    }
    custom.set(schema.id, schema);
  }

  const order: TypeSchema[] = [];
  const cycles = new Set<string>();
  const placed = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const visit = (id: string): void => {
    if (placed.has(id)) return;
    // Bounded like every other chain walk in this package, and against the
    // same constant. Two failures, one guard. A chain past this bound is one
    // `getResolvedFields` already refuses, so admitting it here would hand
    // back a registry whose every write fails and say nothing at the point a
    // caller could act. And the walk takes one frame per ancestor, so a
    // chain far past the bound exhausts the stack instead — a named error
    // rather than a RangeError with no type in it.
    if (stack.length >= MAX_RESOLUTION_DEPTH) {
      throw new MarfaError(
        ErrorCode.TYPE_CHAIN_UNRESOLVABLE,
        `Inheritance chain deeper than ${String(MAX_RESOLUTION_DEPTH)} while ordering type "${id}" for hydration`,
        { type_id: id },
      );
    }
    if (onStack.has(id)) {
      // A back edge to something still open: every id from there to the top
      // of the stack sits on the closed chain.
      for (let i = stack.indexOf(id); i < stack.length; i += 1) {
        const member = stack[i];
        if (member !== undefined) cycles.add(member);
      }
      return;
    }
    const schema = custom.get(id);
    // A parent outside the payload orders nothing — it is either already
    // resolvable or it is a break, and the pass below is what decides which.
    if (!schema) return;
    stack.push(id);
    onStack.add(id);
    if (schema.parent) visit(schema.parent);
    stack.pop();
    onStack.delete(id);
    placed.add(id);
    order.push(schema);
  };

  for (const id of custom.keys()) visit(id);

  for (const schema of order) registerTypeSchema(schema, spaceId);

  // Convergence, and it runs after the registrations rather than before them
  // so that a payload the ordering walk refuses leaves the space exactly as
  // it found it. Nothing is half-applied: the walk throws before the first
  // registration, and this loop is downstream of both.
  //
  // Overlay ids are read as what `listTypes` returns minus what the platform
  // map holds, which is the same subtraction `skippedPlatform` describes from
  // the other side. An overlay entry shadowing a shipped id survives it and
  // is meant to: `resolveSchema` reads the platform map first, so such an
  // entry is unreachable rather than authoritative, and hydration leaves the
  // shipped vocabulary alone in both directions rather than only in the one
  // it adds.
  const listed = new Set(types.map((schema) => schema.id));
  const removed: string[] = [];
  for (const schema of listTypes(spaceId)) {
    if (TYPE_REGISTRY.has(schema.id)) continue;
    if (listed.has(schema.id)) continue;
    removed.push(schema.id);
  }
  // `unregisterTypeSchema` evicts the compiled schema of every declared
  // descendant as well as its own, which is what stops a kept child going on
  // validating against fields its removed ancestor contributed.
  for (const id of removed) unregisterTypeSchema(id, spaceId);

  // Asked after every registration AND after the removals, and of the
  // registry rather than of the payload, so a parent this space already held
  // counts as resolved and a parent the payload supplied is not reported
  // against its own child. Asking before the removals would miss the case
  // convergence introduces: a listing carrying a child whose parent it has
  // dropped leaves that child's chain broken, and the break is the entry this
  // report tells callers to act on. The id reported is the one whose chain
  // actually breaks, not every descendant that inherits the break.
  const unresolvedParents: string[] = [];
  for (const schema of order) {
    // Truthy rather than a test against `undefined`, matching every other
    // parent test in this package. A payload is JSON somebody else produced,
    // and a `parent: null` in one resolves as a root everywhere else while an
    // `undefined` test would name it here — sending a caller to refetch
    // for ever over a break that does not exist. This field is the one the
    // report tells callers to act on, so a false entry in it is expensive.
    if (!schema.parent) continue;
    if (getTypeSchema(schema.parent, spaceId) === undefined) {
      unresolvedParents.push(schema.id);
    }
  }

  return {
    registered: order.map((schema) => schema.id),
    skippedPlatform,
    removed,
    unshippedPlatform,
    unresolvedParents,
    cycles: order.map((schema) => schema.id).filter((id) => cycles.has(id)),
  };
}

import type { TypeSchema } from "@withmarfa/types";
import { ErrorCode, MarfaError, malformedTypeIdentifier } from "./errors.js";
import {
  MAX_RESOLUTION_DEPTH,
  PLATFORM_TIERS,
  TYPE_REGISTRY,
  classifyNamespace,
  getTypeSchema,
  listTypes,
  registerTypeSchema,
  unregisterTypeSchema,
} from "./type-registry.js";

/** What a hydration registered, and what a caller has to know about it. */
export interface TypeRegistryHydration {
  /** Ids registered, in the order they were registered. */
  registered: string[];
  /**
   * Payload entries the platform registry already ships. They are left
   * alone because `listTypes` concatenates the platform registry with the
   * custom map and deduplicates neither, so a shipped type written into
   * the custom map is listed twice — once from each side. Lookups are
   * unaffected: `resolveSchema` reads the platform registry first and
   * returns, so a custom entry under a shipped id is unreachable rather
   * than authoritative.
   */
  skippedPlatform: string[];
  /**
   * Registered ids whose declared parent resolves nowhere — not in the
   * payload, not in the platform registry, not already registered.
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
   * Ids evicted from the custom map because the listing no longer carries
   * them, in the order the registry held them.
   *
   * A deleted type stops appearing in the listing rather than arriving as a
   * tombstone, so nothing but absence says it is gone. Hydration that only
   * ever added kept it valid locally forever, and the client went on
   * accepting writes against a type the server had forgotten — refused on
   * arrival, and a refusal for an unknown type reads as permanent rather
   * than retryable.
   *
   * Scoped to types this build does not ship. Nothing global is touched:
   * a listing may not evict from the platform map.
   */
  removed: string[];
  /**
   * Registered ids under a tier the platform owns (`core.*`, `system.*`,
   * `marfa.*`) that this build does not ship.
   *
   * Every id here is also in `registered`, once in each: both are keyed by
   * the working map rather than accumulated per payload entry, so a listing
   * repeating an id doubles neither.
   *
   * An instance's shipped vocabulary is seeded data, so a listing can carry
   * platform types a client's own build never compiled in. They register into
   * the custom map because that is the only map a client may write — the
   * platform map is what the build ships, and a listing may not reach it — and
   * the lifecycle rules read the identifier rather than the map, so the type
   * still gets the lifecycle its family has.
   *
   * Reported because the custom map is not where the server keeps them, and a
   * caller comparing its vocabulary against the server's should be able to
   * see the gap rather than infer it. A non-empty entry means the build is
   * behind the instance it is talking to.
   */
  unshippedPlatform: string[];
  /**
   * Ids the platform registry ships that the listing does not carry.
   *
   * The mirror of `unshippedPlatform`, and the permissive half of the same
   * platform drift: there the instance names a type this build lacks, here
   * this build ships one the instance does not name. A non-empty entry means
   * the build is ahead of the instance it is talking to. The server computes
   * the first direction against its own rows; this is the second, and it is
   * the one no server can compute, because a client's build is not something
   * the server holds.
   *
   * Reported and not repaired, because nothing here can repair it. The
   * platform map is what the build ships, so a listing may not evict from it
   * and `removed` never reaches one of these: the type goes on resolving
   * locally, a write against it validates, and the server refuses the create
   * as an unknown type — the refusal that reads as permanent rather than
   * retryable, which is what a queue dead-letters. Refetching does not help,
   * because the payload is not what is wrong; two builds that agree is.
   *
   * A caller passing a slice of a listing rather than the whole of one sees
   * the shipped half of that mistake here, the way `removed` shows the
   * custom half.
   */
  unlistedPlatform: string[];
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
 * drops whatever the registry still held that the listing did not carry.
 *
 * **A hydration converges on the payload rather than accumulating.** The
 * listing is the whole of what the instance holds, so a type missing from it
 * has been deleted, and the client's copy is only useful while it says the
 * same thing. Adding alone left a deleted type valid locally forever, which
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
): TypeRegistryHydration {
  // Sets rather than arrays, because the listing repeats ids and a report
  // that counts is a report about the payload's shape rather than about the
  // instance. `GET /types` concatenates the platform map with the custom
  // map and deduplicates neither, so a custom entry shadowing a shipped id
  // genuinely arrives twice. `custom` is keyed by id and could
  // never double, which left these two as the only arrays in the report
  // whose contents depended on how many times the listing said something —
  // and made "every `unshippedPlatform` id is also in `registered`" true of
  // the sets and false of the counts. Insertion order is payload order
  // either way.
  const skippedPlatform = new Set<string>();
  const unshippedPlatform = new Set<string>();
  // Insertion order is the payload's order, which is what makes the walk
  // below deterministic for a payload that admits more than one valid order.
  const custom = new Map<string, TypeSchema>();
  for (const schema of types) {
    // A payload is JSON somebody else produced, so an entry whose `id` is not
    // a string is a shape this loop meets rather than one the signature makes
    // impossible. Classifying one raised a bare `TypeError` that names no
    // type and carries no code — the same failure the depth guard below
    // exists to replace, arriving through a different door. Raised here,
    // ahead of every registration and every removal, so a refusal leaves the
    // registry exactly as it found it.
    const id: unknown = schema.id;
    if (typeof id !== "string") {
      throw malformedTypeIdentifier(
        "schema.id",
        `Hydration payload carried a type identifier of type ${typeof id} where a string was required`,
        { type_id: id },
      );
    }
    // The live platform map rather than a namespace test: an instance's
    // shipped vocabulary is seeded data, so it can hold a type this build
    // never compiled in, and membership here is exactly the question of
    // whether the type is already resolvable as shipped.
    if (TYPE_REGISTRY.has(id)) {
      skippedPlatform.add(id);
      continue;
    }
    // Whether the type is already resolvable and whose vocabulary it belongs
    // to are two questions, and only the second can be answered by name. The
    // skip above asks the first and must keep asking the map; this asks the
    // second, and asks it of the name because a reserved-tier id can only
    // have been seeded — registration under one is refused for every
    // credential. Registered like any other payload entry, and named here so
    // a caller can see its build is behind the instance.
    if (PLATFORM_TIERS.has(classifyNamespace(id))) {
      unshippedPlatform.add(id);
    }
    custom.set(id, schema);
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

  for (const schema of order) registerTypeSchema(schema);

  // Convergence, and it runs after the registrations rather than before them
  // so that a payload the ordering walk refuses leaves the registry exactly
  // as it found it. Nothing is half-applied: the walk throws before the first
  // registration, and this loop is downstream of both.
  //
  // Custom ids are read as what `listTypes` returns minus what the platform
  // map holds, which is the same subtraction `skippedPlatform` describes from
  // the other side. A custom entry shadowing a shipped id survives it and
  // is meant to: `resolveSchema` reads the platform map first, so such an
  // entry is unreachable rather than authoritative, and hydration leaves the
  // shipped vocabulary alone in both directions rather than only in the one
  // it adds.
  const listed = new Set(types.map((schema) => schema.id));
  const removed: string[] = [];
  for (const schema of listTypes()) {
    if (TYPE_REGISTRY.has(schema.id)) continue;
    if (listed.has(schema.id)) continue;
    removed.push(schema.id);
  }
  // What this loop is load-bearing for is the removed types themselves:
  // dropping each custom entry and evicting its own compiled schema, which
  // is what stops a deleted type going on validating writes with nothing
  // left in the registry to answer for it.
  //
  // Not the descendant cascade `unregisterTypeSchema` also runs. A kept
  // custom entry is by construction a payload entry this build does not
  // ship, so every one of them was re-registered in the pass above, and
  // `registerTypeSchema` evicts a registration's own compiled schema
  // unconditionally. A kept child of a removed ancestor has therefore
  // already lost its compiled schema before this line, and the cascade
  // reaches nothing hydration has not already reached. It stays because it
  // is that function's own property, correct for its other callers and held
  // by its own test; hydration does not depend on it.
  for (const id of removed) unregisterTypeSchema(id);

  // The mirror of `unshippedPlatform`, and the direction convergence cannot
  // reach: the platform map is what the build ships, so a listing may not
  // evict from it. A type this build ships that the instance does not name
  // goes on resolving locally whatever this helper does, so the entry is the
  // whole of the answer rather than a note beside a repair.
  const unlistedPlatform: string[] = [];
  for (const id of TYPE_REGISTRY.keys()) {
    if (!listed.has(id)) unlistedPlatform.push(id);
  }

  // Asked after every registration AND after the removals, and of the
  // registry rather than of the payload, so a parent already registered
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
    // forever over a break that does not exist. This field is the one the
    // report tells callers to act on, so a false entry in it is expensive.
    if (!schema.parent) continue;
    if (getTypeSchema(schema.parent) === undefined) {
      unresolvedParents.push(schema.id);
    }
  }

  return {
    registered: order.map((schema) => schema.id),
    skippedPlatform: [...skippedPlatform],
    removed,
    unshippedPlatform: [...unshippedPlatform],
    unlistedPlatform,
    unresolvedParents,
    cycles: order.map((schema) => schema.id).filter((id) => cycles.has(id)),
  };
}

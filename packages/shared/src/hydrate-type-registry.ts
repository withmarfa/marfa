import type { TypeSchema } from "@withmarfa/types";
import { ErrorCode, MarfaError } from "./errors.js";
import {
  MAX_RESOLUTION_DEPTH,
  TYPE_REGISTRY,
  getTypeSchema,
  registerTypeSchema,
} from "./type-registry.js";

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
 * types this build does not already ship, works out an order, and calls
 * `registerTypeSchema` — the one that already exists — for each.
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
 * **Pass the whole listing, not a slice of one.** Within a single call every
 * type is re-registered after its ancestors, and each registration drops its
 * own compiled schema, so a full payload leaves nothing stale. A subset does
 * not: registering an ancestor that has become visible, while a descendant of
 * it sits outside the payload and already has a compiled schema, leaves that
 * descendant validating against the narrower field set with nothing to evict
 * it. The shortfall is silent and it is the one this helper exists to prevent
 * — a requirement the ancestor declares goes unenforced, so the client accepts
 * a write the server refuses. `GET /types` returns the whole vocabulary, which
 * is why this is a precondition rather than a parameter.
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

  // Asked after every registration, and of the registry rather than of the
  // payload, so a parent this space already held counts as resolved and a
  // parent the payload supplied is not reported against its own child. The
  // id reported is the one whose chain actually breaks, not every descendant
  // that inherits the break.
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
    unresolvedParents,
    cycles: order.map((schema) => schema.id).filter((id) => cycles.has(id)),
  };
}

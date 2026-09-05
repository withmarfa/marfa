import { validateProperties } from "@withmarfa/shared";
import { SINGLE_SPACE } from "./types.js";

/**
 * A write this client refused against its own copy of the type graph.
 *
 * Thrown from the mutation layer before anything is queued, so the write
 * never becomes a row that has to be dead-lettered later. That is the
 * whole point of rule 13: a person is told at the moment they made the
 * edit, with the edit still in front of them, rather than an hour later
 * when a queue finally reached a server that said no.
 *
 * `code` is the specific code the server answers on every door but one —
 * see `SCHEMA_REFUSAL_CODES` in `classify.ts` for the exception and why it
 * exists — so an app can classify a local refusal and a remote one the
 * same way.
 */
export class LocalSchemaRefusal extends Error {
  readonly code = "invalid_properties";
  readonly type: string;
  readonly errors: { field: string; message: string }[];

  constructor(type: string, errors: { field: string; message: string }[]) {
    const detail = errors
      .map((error) => `${error.field}: ${error.message}`)
      .join("; ");
    super(
      `@withmarfa/sdk/local: ${type} does not allow this write, so it was refused rather than queued — ${detail}`,
    );
    this.name = "LocalSchemaRefusal";
    this.type = type;
    this.errors = errors;
  }
}

/** The space to validate under. The store's sentinel for a single-space
 *  server is the empty string; the registry's is null. */
export function registryScope(spaceId: string): string | null {
  return spaceId === SINGLE_SPACE ? null : spaceId;
}

/**
 * Refuse a write the type forbids, by the rules the server applies.
 *
 * Not strict, matching the create path in the server's item store: unknown
 * properties pass through there, so refusing them here would refuse writes
 * the server accepts — and a client that is stricter than the server is a
 * client that loses work for no reason a person can act on.
 *
 * **A type this client has never heard of is not refused.** `validateProperties`
 * reports an unknown type as a failure, and taking that at face value would
 * mean a store whose type cache is cold — a fresh install opened offline, a
 * space whose custom types have not been read yet — could not write anything
 * at all. The server is the authority on what types exist; this only ever
 * answers the narrower question of whether known properties fit a known
 * type. An unknown type reaches the server and is refused there, which is
 * the existing path and stays the existing path.
 */
export function refuseIfTypeForbids(
  type: string,
  properties: Record<string, unknown>,
  spaceId: string,
): void {
  const scope = registryScope(spaceId);
  const result = validateProperties(type, properties, { spaceId: scope });
  if (result.success) return;
  // The one failure that is not a refusal. `_type` is the field
  // `validateProperties` reports an unresolvable type under, and it is
  // reported alone.
  if (result.errors.some((error) => error.field === "_type")) return;
  throw new LocalSchemaRefusal(type, result.errors);
}

/**
 * Whether the local graph now refuses a write, without throwing.
 *
 * The revalidation half of rule 5's "one registry refresh and
 * revalidation": after a schema refusal has been answered with a fresh
 * `GET /types`, the drain asks this before spending another request. A
 * write the refreshed graph still refuses is refused for good, and there
 * is nothing to learn from sending it again.
 */
export function localRefusalFor(
  type: string,
  properties: Record<string, unknown>,
  spaceId: string,
): LocalSchemaRefusal | undefined {
  try {
    refuseIfTypeForbids(type, properties, spaceId);
    return undefined;
  } catch (error) {
    return error instanceof LocalSchemaRefusal ? error : undefined;
  }
}

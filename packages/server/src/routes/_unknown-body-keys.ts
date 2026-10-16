/**
 * Refusing a request field the door does not declare, and the one shape of
 * that refusal.
 *
 * The request validator strips keys it does not declare rather than
 * rejecting them, so a caller who misspells a field gets a successful
 * response as if the field had never been sent. There is no status, no
 * warning and no field in the response that separates that from a field
 * left at its default.
 *
 * ## One refusal, one field, one rule
 *
 * Every door answers it as `400 validation_error` with the fields named in
 * `details.unknown_body_fields`, and every key counts, one starting with an
 * underscore included. A door whose body schema is strict reaches it through
 * `createOpenAPIRouter`'s validation hook; a door that has to judge the
 * caller's authority before the shape of the body (the connector doors, and
 * `POST /items/bulk-actions`) calls {@link refuseUnknownBodyKeys} itself
 * after that judgment. Both build the error with
 * {@link undeclaredBodyFieldsRefusal}, so the shape cannot differ.
 *
 * The query string reserves the `_` prefix for the client, because a
 * client appending a cache-buster to a URL has no other place to put it. A
 * body has no such need: its client writes every key, and what it keeps for
 * itself has a declared home (`properties`, `metadata`, an extension). An
 * escape hatch there would only be a second way for a dropped field to look
 * like a success.
 *
 * ## Why this door-by-door check exists at all
 *
 * On `POST /items/bulk-actions` the filter *is* the match set, so a dropped
 * key turns `{action: "purge", filter: {occurred_before: "..."}}` into a
 * purge with an empty filter, every item. The same door's *envelope* is
 * worse: `dry_run` is taken as `body.dry_run ?? false`, so a misspelling is
 * stripped and the action runs for real against whatever the filter
 * matched.
 *
 * The query string has the same rule on every door, installed once by
 * `createOpenAPIRouter`; see `middleware/undeclared-query-keys.ts`.
 *
 * ## Why the declared set is derived rather than listed
 *
 * A hand-written allow-list beside a schema is two declarations of one
 * thing, which is the defect this codebase keeps finding: the schema
 * gains a parameter, the list does not, and a valid parameter starts
 * answering 400. Reading the shape off the schema cannot drift.
 */
import type { z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode } from "@withmarfa/shared";

/**
 * What these refusals need from a schema: the names it declares.
 *
 * Structural rather than `z.ZodObject<z.ZodRawShape>` because a Zod object
 * is invariant in its own shape generic, so a route's concrete schema is
 * not assignable to the general one and every call site would need a cast.
 * A cast written to satisfy a parameter that only ever reads key names is
 * a claim about the value that nothing here relies on.
 */
export interface DeclaresKeys {
  readonly shape: Readonly<Record<string, unknown>>;
}

/** The parameter names a schema declares. */
function declaredKeys(schema: DeclaresKeys): string[] {
  return Object.keys(schema.shape);
}

/** The most fields the message names; `details` names them all. */
const MESSAGE_NAMES = 20;

/** The fields an object of a body takes, and where in the body it sits. */
export interface AcceptedFields {
  /** The path of the object from the root of the body, empty for the root. */
  at: string;
  fields: readonly string[];
}

/**
 * The refusal of fields a body carries and its door does not declare.
 *
 * `undeclared` are the paths of the keys from the root of the body: a
 * top-level key is its name, and a key inside a declared object is dotted
 * from it, as `filter.occurred_before`. They are answered sorted, so the order
 * does not depend on which door found them. `accepted`, where the caller can
 * read it off a schema, lists what each object that carried an undeclared key
 * takes.
 */
export function undeclaredBodyFieldsRefusal(
  undeclared: readonly string[],
  accepted: readonly AcceptedFields[] = [],
): MarfaError {
  const fields = [...new Set(undeclared)].sort();
  const shown = fields.slice(0, MESSAGE_NAMES);
  const names =
    shown.map((k) => `"${k}"`).join(", ") +
    (fields.length > shown.length
      ? ` and ${String(fields.length - shown.length)} more`
      : "");
  const noun = fields.length === 1 ? "field" : "fields";
  const accepts = accepted
    .map(
      ({ at, fields: takes }) =>
        ` ${at === "" ? "This endpoint" : `"${at}"`} accepts: ${[...takes].sort().join(", ")}.`,
    )
    .join("");
  return new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `Unknown request ${noun} ${names}.${accepts} A field this endpoint doesn't declare is refused rather than ignored, because an ignored field is a request only half performed.`,
    { unknown_body_fields: fields },
  );
}

/**
 * The keys `value` carries that `schema` does not declare, as paths.
 *
 * A non-object is left alone: the schema is what has an opinion about the
 * shape, and answering "unknown fields" for an array would be answering a
 * different question than the one the caller got wrong. `at` is the path of
 * `value` in the body, empty for the body itself.
 */
export function undeclaredKeysOf(
  value: unknown,
  schema: DeclaresKeys,
  at = "",
): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const allowed = new Set(declaredKeys(schema));
  return Object.keys(value)
    .filter((k) => !allowed.has(k))
    .map((k) => (at === "" ? k : `${at}.${k}`));
}

/**
 * Refuse any key the request body itself does not declare.
 *
 * For a door that judges the caller's authority before the shape of the
 * body, and so cannot leave this to the validator, which runs ahead of its
 * handler. Call it from the handler at the point the contract puts the
 * shape, and mark the schema with {@link CLOSED_BY_HANDLER} so the document
 * says what the handler does.
 *
 * `schema` is the variant the request's `action` selected rather than the
 * whole union, where there is one, so a field belonging to a different
 * action is refused too: a caller who sends `state` alongside `update_tags`
 * believes they asked for two things and is getting one. `inside` names the
 * declared objects whose own keys are judged in the same refusal, such as
 * the filter, where a dropped key is not a narrower match set but every
 * item.
 */
export function refuseUnknownBodyKeys(
  body: unknown,
  schema: DeclaresKeys,
  inside: Readonly<Record<string, DeclaresKeys>> = {},
): void {
  const unknown: string[] = [];
  const accepted: AcceptedFields[] = [];
  const judge = (value: unknown, declares: DeclaresKeys, at: string) => {
    const found = undeclaredKeysOf(value, declares, at);
    if (found.length === 0) return;
    unknown.push(...found);
    accepted.push({ at, fields: declaredKeys(declares) });
  };
  judge(body, schema, "");
  if (typeof body === "object" && body !== null) {
    for (const [name, nested] of Object.entries(inside)) {
      judge((body as Record<string, unknown>)[name], nested, name);
    }
  }
  if (unknown.length === 0) return;
  throw undeclaredBodyFieldsRefusal(unknown, accepted);
}

/**
 * What marks a body schema as one whose handler refuses an undeclared key
 * itself, as `.meta(CLOSED_BY_HANDLER)`.
 *
 * A strict schema (`z.strictObject`) is refused by the validator and the
 * document says so. A schema whose door refuses the key later, in the
 * handler, has to say the same in the document without the validator
 * acting on it, or the validator would answer ahead of the authority checks
 * the door puts first. This changes the generated document and nothing the
 * validator does.
 */
export const CLOSED_BY_HANDLER = { additionalProperties: false } as const;

/**
 * Refuse the keys a bulk entry sent that its schema does not declare.
 *
 * Judged by the door rather than by the request validator, so the refusal
 * is an entry's and `atomic` decides what it does to the page. Parsed
 * against a strict copy of the entry's schema, so the keys are the ones the
 * validator would have named.
 */
export function undeclaredEntryKeyRefusal(
  entry: unknown,
  strictEntrySchema: z.ZodType,
): MarfaError | null {
  const parsed = strictEntrySchema.safeParse(entry);
  if (parsed.success) return null;
  const fields = undeclaredKeyPaths(parsed.error.issues);
  return fields.length === 0 ? null : undeclaredBodyFieldsRefusal(fields);
}

/**
 * The paths of the keys the unrecognized-key issues of a failed parse name,
 * from the root of what was parsed.
 */
export function undeclaredKeyPaths(
  issues: readonly z.core.$ZodIssue[],
): string[] {
  const paths: string[] = [];
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys") continue;
    const at = issue.path.map(String).join(".");
    const named: unknown = Reflect.get(issue, "keys");
    if (!Array.isArray(named)) continue;
    for (const key of named as string[]) {
      paths.push(at === "" ? key : `${at}.${key}`);
    }
  }
  return paths;
}

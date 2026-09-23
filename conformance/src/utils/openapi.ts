import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { requireApiUrl } from "./setup.js";

/**
 * The served OpenAPI document and a validator for what the server answers,
 * so a body that contradicts the server's own declaration fails the fixture
 * that observed it rather than passing on a status code alone.
 *
 * The document is read exactly as written. Nothing here normalizes it: a
 * position the server means to be nullable has to say so in the dialect the
 * document declares, or the body that carries `null` there fails.
 *
 * Validation is closed: see {@link closed}. An open validator passes a body
 * carrying a field the document never declared.
 */

export interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
  components?: Record<string, unknown>;
}

type JsonSchema = Record<string, unknown>;

/**
 * What a local reference names. An unresolvable reference throws: read as
 * an empty schema it would make the body pass whatever it carried.
 */
function resolveRef(ref: string, document: OpenApiDocument): unknown {
  const target = ref
    .replace(/^#\//, "")
    .split("/")
    .reduce<unknown>(
      (at, segment) =>
        at === null || typeof at !== "object"
          ? undefined
          : (at as Record<string, unknown>)[
              segment.replace(/~1/g, "/").replace(/~0/g, "~")
            ],
      document,
    );
  if (target === undefined) {
    throw new Error(`the document has no ${ref} to resolve`);
  }
  return target;
}

/**
 * Refuse a reference that reaches itself. `refs` holds the references being
 * expanded on the way down rather than every one seen, because the same
 * component named twice side by side is not a cycle.
 */
function enter(ref: string, refs: ReadonlySet<string>): Set<string> {
  if (refs.has(ref)) {
    throw new Error(`the document's ${ref} refers back to itself`);
  }
  return new Set([...refs, ref]);
}

/**
 * The schema with every reference replaced by what it names. A reference
 * with sibling keywords is both at once, as the dialect reads it, so it
 * becomes an `allOf` of the two rather than losing the siblings.
 */
export function inline(
  node: unknown,
  document: OpenApiDocument,
  refs: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => inline(item, document, refs));
  }
  if (node === null || typeof node !== "object") return node;

  const { $ref: ref, ...rest } = node as JsonSchema;
  if (typeof ref === "string") {
    const target = inline(
      resolveRef(ref, document),
      document,
      enter(ref, refs),
    );
    return Object.keys(rest).length === 0
      ? target
      : { allOf: [target, inline(rest, document, refs)] };
  }

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    out[key] = inline(value, document, refs);
  }
  return out;
}

/**
 * Refuse a property the schema does not declare.
 *
 * Left open: a property bag (no `properties`) and a declared record (its own
 * `additionalProperties`), both of which are shapes the type's schema governs
 * rather than the door's. The immediate branches of an `allOf` each describe
 * part of one object, so closing any one would refuse the others' fields;
 * the `allOf` itself is closed instead, with `unevaluatedProperties`, which
 * sees every property a branch declared.
 */
export function closed(node: unknown, isAllOfBranch = false): unknown {
  if (Array.isArray(node)) return node.map((item) => closed(item));
  if (node === null || typeof node !== "object") return node;

  const record = node as JsonSchema;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] =
      key === "allOf" && Array.isArray(value)
        ? value.map((branch) => closed(branch, true))
        : closed(value);
  }
  if (isAllOfBranch || out.additionalProperties !== undefined) return out;
  if (Array.isArray(out.allOf)) {
    out.unevaluatedProperties ??= false;
  } else if (typeof out.properties === "object") {
    out.additionalProperties = false;
  }
  return out;
}

interface Operation {
  operationId?: string;
  parameters?: { name?: string; in?: string }[];
  responses?: Record<
    string,
    { content?: Record<string, { schema?: unknown }> }
  >;
}

let cached: Promise<OpenApiDocument> | undefined;
const compiled = new Map<string, ValidateFunction>();
const ajv = new Ajv2020({ strict: false, allErrors: true });

/** A closed validator for one schema read out of `document`. */
export function validatorFor(
  schema: unknown,
  document: OpenApiDocument,
): ValidateFunction {
  return ajv.compile(
    closed(inline(schema, document)) as Record<string, unknown>,
  );
}

function fetchOpenApi(): Promise<OpenApiDocument> {
  cached ??= (async () => {
    const response = await fetch(`${requireApiUrl()}/openapi.json`);
    if (!response.ok) {
      throw new Error(
        `GET /openapi.json answered ${String(response.status)}; the served document is required`,
      );
    }
    return (await response.json()) as OpenApiDocument;
  })();
  return cached;
}

/** The served document, read once per run. */
export function servedDocument(): Promise<OpenApiDocument> {
  return fetchOpenApi();
}

/**
 * The top-level properties of each object a schema may answer, one set per
 * alternative. Every keyword at one level applies at once, so a `$ref`, its
 * siblings and each `allOf` branch add to the same object, while each
 * `oneOf` or `anyOf` branch is an object of its own. Nothing below the top
 * level is read: a page is a page by its own keys.
 */
function alternatives(
  node: unknown,
  document: OpenApiDocument,
  refs: ReadonlySet<string> = new Set(),
): Set<string>[] {
  if (node === null || typeof node !== "object") return [new Set()];
  const record = node as JsonSchema;
  const parts: Set<string>[][] = [
    [new Set(Object.keys((record.properties as object | undefined) ?? {}))],
  ];
  if (typeof record.$ref === "string") {
    parts.push(
      alternatives(
        resolveRef(record.$ref, document),
        document,
        enter(record.$ref, refs),
      ),
    );
  }
  if (Array.isArray(record.allOf)) {
    for (const branch of record.allOf) {
      parts.push(alternatives(branch, document, refs));
    }
  }
  for (const union of [record.oneOf, record.anyOf]) {
    if (Array.isArray(union)) {
      parts.push(
        union.flatMap((branch) => alternatives(branch, document, refs)),
      );
    }
  }
  return parts.reduce<Set<string>[]>(
    (sofar, part) =>
      sofar.flatMap((left) =>
        part.map((right) => new Set([...left, ...right])),
      ),
    [new Set()],
  );
}

const isPage = (properties: Set<string>) =>
  properties.has("data") && properties.has("next_cursor");

/**
 * Every operation, as `METHOD /template`, that answers a success with a
 * JSON page: an object that declares both `data` and `next_cursor`,
 * whether by reference, inline or across an `allOf`. A door answering
 * `data` alone, such as an extension read, is not one.
 *
 * Each status and media type is judged on its own, so keys two different
 * answers declare are never added together into a page neither is.
 *
 * **A union counts only when every branch is a page, and one whose branches
 * disagree throws, naming the door.** Such a door answers a page on some
 * calls and not others, which is neither a page door nor safely left out of
 * the list: left out, the only sign would be a count one short, with
 * nothing saying which door fell away.
 */
export function pageDoors(document: OpenApiDocument): string[] {
  const out: string[] = [];
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const door = `${method.toUpperCase()} ${path}`;
      let answersPage = false;
      for (const [status, response] of Object.entries(
        operation.responses ?? {},
      )) {
        if (!/^2(?:\d\d|XX)$/.test(status)) continue;
        for (const [mediaType, media] of Object.entries(
          response.content ?? {},
        )) {
          if (!/\bjson\b/.test(mediaType)) continue;
          const shapes = alternatives(media.schema, document);
          const pages = shapes.filter(isPage).length;
          if (pages > 0 && pages < shapes.length) {
            throw new Error(
              `${door} answers ${status} ${mediaType} with a union of which ${String(pages)} of ${String(shapes.length)} branches are a page`,
            );
          }
          if (pages > 0) answersPage = true;
        }
      }
      if (answersPage) out.push(door);
    }
  }
  return out;
}

export interface PublishedOperation {
  method: string;
  path: string;
  operationId: string | undefined;
  /** The statuses the document declares for the operation. */
  statuses: number[];
}

/** Every published method and path in the served document. */
export async function publishedOperations(): Promise<PublishedOperation[]> {
  const doc = await fetchOpenApi();
  const out: PublishedOperation[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      out.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId,
        statuses: Object.keys(op.responses ?? {}).map(Number),
      });
    }
  }
  return out;
}

/**
 * Assert that `body` matches the schema the served document declares for
 * this operation and status. The path is the document's template, for
 * example `/items/{id}`. A status the document does not declare, or one it
 * declares with no content, is itself a failure: the server answered with
 * something its document does not describe.
 */
export async function expectMatchesSchema(
  method: string,
  path: string,
  status: number,
  body: unknown,
): Promise<void> {
  const doc = await fetchOpenApi();
  const op = doc.paths[path]?.[method.toLowerCase()];
  if (!op) {
    throw new Error(`the served document publishes no ${method} ${path}`);
  }
  const response = op.responses?.[String(status)];
  if (!response) {
    throw new Error(
      `the served document declares no ${String(status)} for ${method} ${path}`,
    );
  }
  const contentType = Object.keys(response.content ?? {})[0];
  if (contentType === undefined) {
    throw new Error(
      `the served document declares ${String(status)} for ${method} ${path} with no content schema`,
    );
  }
  const schema = response.content?.[contentType]?.schema;
  if (schema === undefined || Object.keys(schema as object).length === 0) {
    throw new Error(
      `the served document declares ${String(status)} for ${method} ${path} with a schema that constrains nothing, so no body could fail it`,
    );
  }
  const key = `${method} ${path} ${String(status)}`;
  let validate = compiled.get(key);
  if (!validate) {
    validate = validatorFor(schema, doc);
    compiled.set(key, validate);
  }
  if (!validate(body)) {
    throw new Error(
      `${method} ${path} answered ${String(status)} with a body its document does not describe:\n` +
        ajv.errorsText(validate.errors, { separator: "\n" }) +
        `\nbody: ${JSON.stringify(body).slice(0, 2000)}`,
    );
  }
}

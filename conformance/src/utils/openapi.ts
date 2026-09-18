import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { requireApiUrl } from "./setup.js";

/**
 * The served OpenAPI document and a validator for what the server answers,
 * so a body that contradicts the server's own declaration fails the fixture
 * that observed it rather than passing on a status code alone.
 *
 * `nullable: true` is a 3.0 keyword the server emits inside a 3.1 document,
 * where it means nothing; it is widened here to the null-admitting type it
 * intends. That single normalization is the one place the validator reads the
 * document more charitably than a strict 3.1 reader would, and it is recorded
 * as a finding in `spec/findings.md`.
 */

interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
  components?: Record<string, unknown>;
}

interface Operation {
  operationId?: string;
  responses?: Record<
    string,
    { content?: Record<string, { schema?: unknown }> }
  >;
}

let cached: Promise<OpenApiDocument> | undefined;
const compiled = new Map<string, ValidateFunction>();
const ajv = new Ajv2020({ strict: false, allErrors: true });

function fetchOpenApi(): Promise<OpenApiDocument> {
  cached ??= (async () => {
    const response = await fetch(`${requireApiUrl()}/openapi.json`);
    if (!response.ok) {
      throw new Error(
        `GET /openapi.json answered ${String(response.status)}; the served document is required`,
      );
    }
    const doc = (await response.json()) as OpenApiDocument;
    widenNullable(doc);
    ajv.addSchema(doc as unknown as object, "openapi");
    return doc;
  })();
  return cached;
}

function widenNullable(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) widenNullable(child);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.nullable === true) {
    if (typeof record.type === "string") record.type = [record.type, "null"];
    delete record.nullable;
  }
  for (const value of Object.values(record)) widenNullable(value);
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

function pointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
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
    validate = ajv.compile({
      $ref: `openapi#/paths/${pointer(path)}/${method.toLowerCase()}/responses/${String(status)}/content/${pointer(contentType)}/schema`,
    });
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

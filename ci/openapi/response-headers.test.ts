/**
 * The response headers the document declares.
 *
 * Every one is set by middleware or by the error handler, so no route
 * declares them and the document's general sections do. This holds the
 * declarations to each other: the always-on headers on every response,
 * `X-Error-Code` on refusals,
 * `Retry-After` on `429`, copy proof on the supported reads and
 * `Idempotency-Replayed` on the writes that take an `Idempotency-Key`. What a
 * server sends is held by the contract's fixtures.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { document } from "./document.js";

type Operation = Record<string, unknown>;
interface SpecResponse {
  headers?: Record<string, unknown>;
}

const UNIVERSAL = ["X-Marfa-Contract", "X-Request-ID"];

/**
 * Operations that bypass the general request limiter. Claim has its own
 * guessing allowance.
 */
const AHEAD_OF_THE_LIMITER = new Set(["GET /", "GET /health", "POST /owner"]);

/**
 * The body cap's refusal, answered before the limiter and the idempotency
 * claim see the request, so it carries neither's headers.
 */
const ANSWERED_AHEAD = "413";

/** Statuses an idempotency claim gives back rather than records. */
const RELEASED = new Set([401, 403]);

const METHODS = new Set(["get", "put", "post", "patch", "delete"]);

describe("the document declares the headers the server sets", () => {
  const spec = document;
  /** `POST /items` -> { "200": { … }, … } */
  const operations = new Map<string, Record<string, SpecResponse>>();
  /** The writes that take an `Idempotency-Key`. */
  const keyed = new Set<string>();

  beforeAll(() => {
    const paths = (spec.paths ?? {}) as Record<
      string,
      Record<string, Operation>
    >;
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!METHODS.has(method)) continue;
        const key = `${method.toUpperCase()} ${path}`;
        operations.set(
          key,
          (operation.responses ?? {}) as Record<string, SpecResponse>,
        );
        const parameters = (operation.parameters ?? []) as { name?: string }[];
        if (parameters.some((p) => p.name === "Idempotency-Key")) {
          keyed.add(key);
        }
      }
    }
    expect(operations.size).toBeGreaterThan(0);
  });

  it("names every header it references, with a meaning", () => {
    const components = (spec.components ?? {}) as Record<string, unknown>;
    const headers = (components.headers ?? {}) as Record<string, unknown>;
    expect(Object.keys(headers).length).toBeGreaterThan(0);

    // A `$ref` into a component that does not exist renders as nothing and
    // fails no schema check, so the reference is only worth as much as the
    // resolution — and a header with no description names itself and says
    // nothing, which is the state this whole file exists to leave behind.
    const undescribed = Object.entries(headers)
      .filter(([, value]) => {
        const description = (value as { description?: unknown }).description;
        return typeof description !== "string" || description.length === 0;
      })
      .map(([name]) => name);
    expect(undescribed).toEqual([]);

    const unresolved: string[] = [];
    for (const [key, responses] of operations) {
      for (const [status, response] of Object.entries(responses)) {
        for (const [name, value] of Object.entries(response.headers ?? {})) {
          const ref = (value as { $ref?: unknown }).$ref;
          if (typeof ref !== "string") continue;
          const target = ref.replace("#/components/headers/", "");
          if (!(target in headers)) {
            unresolved.push(`${key} ${status} -> ${ref}`);
          }
          expect(target, `${key} ${status} header key`).toBe(name);
        }
      }
    }
    expect(unresolved.sort()).toEqual([]);
  });

  it("declares the always-on headers on every response", () => {
    const missing: string[] = [];
    for (const [key, responses] of operations) {
      for (const [status, response] of Object.entries(responses)) {
        for (const name of UNIVERSAL) {
          if (!(name in (response.headers ?? {}))) {
            missing.push(`${key} ${status} ${name}`);
          }
        }
      }
    }
    expect(missing.sort()).toEqual([]);
  });

  it("declares no 413 on a GET or HEAD, which carries no body to count", () => {
    const declaring = [...operations]
      .filter(
        ([key, responses]) =>
          /^(GET|HEAD) /.test(key) && ANSWERED_AHEAD in responses,
      )
      .map(([key]) => key);
    // Witness: the cap is declared somewhere, so the filter above reads
    // real declarations rather than none.
    expect(
      [...operations.values()].some((responses) => ANSWERED_AHEAD in responses),
    ).toBe(true);
    expect(declaring).toEqual([]);
  });

  it("declares X-Error-Code on error responses and not on success", () => {
    // Every error response declares the header and every success response
    // does not, but registration's `401` and `415`, which the sign-in
    // library answers in its own shape. The item and edge conflicts return
    // rather than throw, and stamp the header themselves.
    const KNOWN_UNSTAMPED = new Set<string>([
      "POST /auth/oauth2/register 401",
      "POST /auth/oauth2/register 415",
    ]);
    const wrong: string[] = [];
    for (const [key, responses] of operations) {
      for (const [status, response] of Object.entries(responses)) {
        const declared = "X-Error-Code" in (response.headers ?? {});
        const isError =
          Number.parseInt(status, 10) >= 400 &&
          !KNOWN_UNSTAMPED.has(`${key} ${status}`);
        if (declared !== isError) {
          wrong.push(`${key} ${status} declared=${String(declared)}`);
        }
      }
    }
    expect(wrong.sort()).toEqual([]);
  });

  it("declares Retry-After on the rate limiter's refusal, and only there", () => {
    const wrong: string[] = [];
    let refusals = 0;
    for (const [key, responses] of operations) {
      for (const [status, response] of Object.entries(responses)) {
        const declared = "Retry-After" in (response.headers ?? {});
        if (status === "429") refusals += 1;
        if (declared !== (status === "429")) {
          wrong.push(`${key} ${status} declared=${String(declared)}`);
        }
      }
    }
    // Claim also answers 429 through its own code-guessing allowance.
    expect(operations.get("POST /owner")).toHaveProperty("429");
    expect(refusals).toBe(operations.size - AHEAD_OF_THE_LIMITER.size + 1);
    expect(wrong.sort()).toEqual([]);
  });

  it("declares copy proof only on supported read outcomes", () => {
    const reads = new Set([
      "GET /items",
      "GET /items/{id}",
      "GET /items/{id}/edges",
      "GET /items/{id}/tables",
      "GET /items/{id}/tables/{table}/rows",
      "GET /edges",
      "GET /edges/{id}",
      "GET /types",
      "GET /edge-types",
      "GET /keys/current",
      "POST /items/bulk-get",
    ]);
    const declared = new Set<string>();
    for (const [key, responses] of operations) {
      for (const [status, response] of Object.entries(responses)) {
        const code = Number(status);
        const supported =
          reads.has(key) &&
          ((code >= 200 && code < 300) || code === 403 || code === 404);
        expect(
          "X-Marfa-Reach" in (response.headers ?? {}),
          `${key} ${status}`,
        ).toBe(supported);
        if (supported) declared.add(key);
      }
    }
    expect([...declared].sort()).toEqual([...reads].sort());
    const paths = spec.paths as Record<string, Record<string, Operation>>;
    for (const key of [...reads, "GET /events"]) {
      const [method, path] = key.split(" ") as [string, string];
      const operation = paths[path]![method.toLowerCase()]!;
      const parameters = operation.parameters as { name: string; in: string }[];
      expect(
        parameters.filter(
          (p) => p.name === "X-Marfa-Reach" && p.in === "header",
        ),
      ).toHaveLength(1);
      expect(operations.get(key)).toHaveProperty("409");
    }
  });

  it("declares Idempotency-Replayed on exactly the write doors", () => {
    // The doors are the operations that take an `Idempotency-Key`, so a
    // door added or removed moves this expectation with it.
    expect(keyed.size).toBeGreaterThan(10);
    const declaring = new Set<string>();
    for (const [key, responses] of operations) {
      for (const response of Object.values(responses)) {
        if ("Idempotency-Replayed" in (response.headers ?? {})) {
          declaring.add(key);
        }
      }
    }
    expect([...declaring].sort()).toEqual([...keyed].sort());

    // On every response, not only the success one: a replay reproduces
    // whatever the first attempt answered, so a recorded conflict replays
    // as a conflict and carries the header with it.
    for (const key of keyed) {
      const responses = operations.get(key);
      expect(responses, `${key} is missing from the spec`).toBeDefined();
      for (const [status, response] of Object.entries(responses ?? {})) {
        // 401 and 403 release the claim rather than recording it, and the
        // body cap refuses before the claim is made, so none of them can
        // ever be replayed and none carries the marker.
        const released =
          RELEASED.has(Number.parseInt(status, 10)) ||
          status === ANSWERED_AHEAD;
        expect(
          "Idempotency-Replayed" in (response.headers ?? {}),
          `${key} ${status}`,
        ).toBe(!released);
      }
    }
  });
});

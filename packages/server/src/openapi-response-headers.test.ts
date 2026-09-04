/**
 * The response headers the server sets are declared, and the declaration
 * is true.
 *
 * Two halves, deliberately, because either alone is worth little. The spec
 * half asserts the published document declares each header on the
 * responses that carry it — that is the thing a client reads. The wire
 * half asserts the server actually sends what the document promises, and
 * it is the half that matters: a declaration nothing checks against the
 * running server is a comment that renders. `X-Request-ID` was declared
 * "on every response" while the one response that dropped it was the
 * idempotency replay, and only a wire assertion finds that.
 *
 * None of these headers can be reflected from a route definition. Every
 * one is set by middleware or by the error handler, so `createRoute` sees
 * none of them and `openapi-finalize.ts` is where they are declared.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildPublishedOpenAPISpec } from "./openapi-published.js";
import { IDEMPOTENT_WRITE_DOORS } from "./middleware/idempotency.js";
import { createTestContext, request } from "./test-utils.js";
import type { TestContext } from "./test-utils.js";

type Operation = Record<string, unknown>;
interface SpecResponse {
  headers?: Record<string, unknown>;
}

/** `POST /items` — the door table as the spec keys an operation. */
const DOOR_KEYS = new Set(
  IDEMPOTENT_WRITE_DOORS.map((door) => {
    const [method, path] = door.split(" ");
    return `${method ?? ""} ${(path ?? "").replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`;
  }),
);

const UNIVERSAL = [
  "X-Request-ID",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
];

describe("the published spec declares the headers the server sets", () => {
  let spec: Record<string, unknown>;
  /** `POST /items` -> { "200": { … }, … } */
  let operations: Map<string, Record<string, SpecResponse>>;

  beforeAll(async () => {
    spec = await buildPublishedOpenAPISpec();
    operations = new Map();
    const paths = (spec.paths ?? {}) as Record<
      string,
      Record<string, Operation>
    >;
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        operations.set(
          `${method.toUpperCase()} ${path}`,
          (operation.responses ?? {}) as Record<string, SpecResponse>,
        );
      }
    }
    expect(operations.size).toBeGreaterThan(0);
  }, 120_000);

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

  it("declares X-Error-Code on error responses and not on success", () => {
    const wrong: string[] = [];
    for (const [key, responses] of operations) {
      for (const [status, response] of Object.entries(responses)) {
        const declared = "X-Error-Code" in (response.headers ?? {});
        const isError = Number.parseInt(status, 10) >= 400;
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
    // Every operation is behind the limiter, so every operation answers
    // 429 — a count of zero would mean the refusal stopped being declared
    // and every assertion above passed by having nothing to check.
    expect(refusals).toBe(operations.size);
    expect(wrong.sort()).toEqual([]);
  });

  it("declares Idempotency-Replayed on exactly the write doors", () => {
    // Derived from `IDEMPOTENT_WRITE_DOORS` rather than a list written
    // here, so a door added or removed moves this expectation with it.
    const declaring = new Set<string>();
    for (const [key, responses] of operations) {
      for (const response of Object.values(responses)) {
        if ("Idempotency-Replayed" in (response.headers ?? {})) {
          declaring.add(key);
        }
      }
    }
    expect([...declaring].sort()).toEqual([...DOOR_KEYS].sort());

    // On every response, not only the success one: a replay reproduces
    // whatever the first attempt answered, so a recorded conflict replays
    // as a conflict and carries the header with it.
    for (const key of DOOR_KEYS) {
      const responses = operations.get(key);
      expect(responses, `${key} is missing from the spec`).toBeDefined();
      for (const [status, response] of Object.entries(responses ?? {})) {
        expect(
          "Idempotency-Replayed" in (response.headers ?? {}),
          `${key} ${status}`,
        ).toBe(true);
      }
    }
  });
});

describe("the server sends the headers the spec declares", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // Rate limiting off by default in the harness, and the trio is only
    // set when it is on — a context without it would read three absent
    // headers as a contract violation rather than as configuration.
    ctx = await createTestContext({
      rateLimitEnabled: true,
      rateLimitDefaultLimit: 500,
      rateLimitWindowMs: 60_000,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  function assertUniversal(response: Response, label: string): void {
    for (const name of UNIVERSAL) {
      expect(response.headers.get(name), `${label}: ${name}`).not.toBeNull();
    }
  }

  it("sends the always-on headers on an ordinary read", async () => {
    const response = await request(ctx.app, "GET", "/items", {
      key: ctx.adminKey,
    });
    expect(response.status).toBe(200);
    assertUniversal(response, "GET /items");
    expect(response.headers.get("X-Error-Code")).toBeNull();
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
  });

  it("sends X-Error-Code on an error, matching the body", async () => {
    const response = await request(ctx.app, "GET", "/items", {});
    expect(response.status).toBe(401);
    assertUniversal(response, "unauthenticated GET /items");
    const body = (await response.json()) as { error?: { code?: string } };
    expect(response.headers.get("X-Error-Code")).toBe(body.error?.code);
  });

  it("marks a replayed write and leaves the first one unmarked", async () => {
    const key = `header-probe-${Date.now().toString(36)}`;
    const body = { type: "core.note", properties: { body: "replay probe" } };

    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": key },
      body,
    });
    expect(first.status).toBe(201);
    // The absent arm carries the weight. A header sent on every response
    // would satisfy an assertion that only looks at the replay, and would
    // tell a client nothing.
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();

    const replay = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": key },
      body,
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");

    // The replay is a fresh Response built from the stored row, so it
    // starts with none of the headers the middleware chain prepared. It
    // shipped with exactly that gap: no request id to quote and no view
    // of the rate-limit budget the retry had just spent.
    assertUniversal(replay, "replayed POST /items");
  });

  it("sends the same body on a replay as on the first attempt", async () => {
    const key = `header-body-${Date.now().toString(36)}`;
    const body = { type: "core.note", properties: { body: "same bytes" } };
    const opts = {
      key: ctx.adminKey,
      headers: { "Idempotency-Key": key },
      body,
    };

    const first = await request(ctx.app, "POST", "/items", opts);
    const replay = await request(ctx.app, "POST", "/items", opts);
    // Rebuilding the Response to add headers must not disturb what it
    // carries: the stored body is the contract, byte for byte.
    expect(await replay.text()).toBe(await first.text());
  });
});

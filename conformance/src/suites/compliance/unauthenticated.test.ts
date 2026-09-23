import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { TestContext } from "../../client/types.js";
import { createTestContext, cleanup } from "../../utils/setup.js";
import { publishedOperations } from "../../utils/openapi.js";

let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, apiUrl } = await createTestContext("compliance", "unauthenticated"));
});

afterAll(async () => {
  await cleanup(ctx);
});

/**
 * Two doors are open by design. Dynamic client registration, because RFC
 * 7591 lets a client register before it holds anything; and the root,
 * because a client reads the contract there before it holds a credential to
 * send. Every other published door must turn a bare request away.
 */
const OPEN_DOORS = new Set(["POST /auth/oauth2/register", "GET /"]);

/**
 * Nothing about these requests is well formed, which is the point. The
 * credential check runs ahead of the body check and the row lookup, so a
 * bare request gets one answer whatever else is wrong with it: an id nothing
 * carries, a query key no door knows, and a body no parser accepts.
 */
const UNKNOWN_ID = "019537a0-7b80-7000-8000-000000000000";
const UNKNOWN_QUERY = "?definitely-not-a-filter=1";
const UNPARSEABLE_BODY = "{ not json";

function concretePath(template: string): string {
  return template
    .replace("{hash}", "not-a-blob-hash")
    .replace(/\{[^}]+\}/g, UNKNOWN_ID);
}

describe("every published door but the open ones refuses a request with no credential", () => {
  it("answers 401 unauthorized on each of them", async () => {
    const doors = (await publishedOperations()).filter(
      (op) => !OPEN_DOORS.has(`${op.method} ${op.path}`),
    );
    expect(doors.length).toBeGreaterThan(50);

    const wrong: string[] = [];
    for (const op of doors) {
      const response = await fetch(
        `${apiUrl}${concretePath(op.path)}${UNKNOWN_QUERY}`,
        {
          method: op.method,
          headers: { "Content-Type": "application/json" },
          body: op.method === "GET" ? undefined : UNPARSEABLE_BODY,
        },
      );
      const text = await response.text();
      let code: unknown;
      try {
        code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
      } catch {
        code = undefined;
      }
      if (response.status !== 401 || code !== "unauthorized") {
        wrong.push(
          `${op.method} ${op.path} answered ${String(response.status)} ${text.slice(0, 120)}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("the open doors", () => {
  it("are published, and answer a request with no credential", async () => {
    const published = new Set(
      (await publishedOperations()).map((op) => `${op.method} ${op.path}`),
    );
    for (const door of OPEN_DOORS) {
      expect(published, door).toContain(door);
      const [method, path] = door.split(" ") as [string, string];
      const response = await fetch(`${apiUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" ? undefined : UNPARSEABLE_BODY,
      });
      await response.body?.cancel();
      expect(response.status, door).not.toBe(401);
      // The root answers outright; registration refuses the malformed body
      // on its merits, which is still not a credential refusal.
      if (door === "GET /") expect(response.status, door).toBe(200);
    }
  });
});

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
 * Dynamic client registration is an open door by design: RFC 7591 lets a
 * client register before it holds anything. Every other published door must
 * turn a bare request away.
 */
const OPEN_DOORS = new Set(["POST /auth/oauth2/register"]);

/**
 * Nothing about these requests is well formed, which is the point. The
 * credential check runs ahead of the body check and the row lookup, so a
 * bare request gets one answer whatever else is wrong with it: an id nothing
 * carries, a query key no door knows, and a body no parser accepts. A sweep
 * sending a real row and a well-formed body would pass a door that never
 * looked for a credential, since its `400` or `404` would be read as "not
 * a 200".
 */
const UNKNOWN_ID = "019537a0-7b80-7000-8000-000000000000";
const UNKNOWN_QUERY = "?definitely-not-a-filter=1";
const UNPARSEABLE_BODY = "{ not json";

function concretePath(template: string): string {
  return template
    .replace("{hash}", "not-a-blob-hash")
    .replace(/\{[^}]+\}/g, UNKNOWN_ID);
}

describe("every published door refuses a request with no credential", () => {
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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackWebhook,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { publishedOperations } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let itemId: string;
let itemVersion: number;
let edgeId: string;
let edgeVersion: number;
let webhookId: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "unauthenticated",
  ));
  const a = await client.createItem(createNote({ source: ctx.source }));
  expect(a.ok).toBe(true);
  trackItem(ctx, a.data.item.id);
  itemId = a.data.item.id;
  itemVersion = a.data.item.version;
  const b = await client.createItem(createNote({ source: ctx.source }));
  expect(b.ok).toBe(true);
  trackItem(ctx, b.data.item.id);
  const edge = await client.createEdge({
    source_id: itemId,
    target_id: b.data.item.id,
    edge_type: "about",
  });
  expect(edge.ok).toBe(true);
  trackEdge(ctx, edge.data.edge.id);
  edgeId = edge.data.edge.id;
  edgeVersion = edge.data.edge.version;
  const hook = await client.createWebhook({
    url: "http://127.0.0.1:9/never-called",
    events: ["item.created"],
  });
  expect(hook.status).toBe(201);
  trackWebhook(ctx, hook.data.id, client);
  webhookId = hook.data.id;
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
 * Real identifiers and well-formed bodies, because on some routes the body
 * check or the row lookup runs before the credential check: a bare request
 * with a malformed body answers 400 there, and one naming an unknown row
 * answers 404, which would let the sweep pass on a door that never looked
 * for a credential. Recorded in spec/findings.md.
 */
function concretePath(template: string): string {
  return template
    .replace("/items/{id}", `/items/${itemId}`)
    .replace("/edges/{id}", `/edges/${edgeId}`)
    .replace("/webhooks/{id}", `/webhooks/${webhookId}`)
    .replace("/keys/{id}", `/keys/${ctx.trackedKeys[0]}`)
    .replace("/types/{id}", "/types/core.note")
    .replace("/edge-types/{id}", "/edge-types/about")
    .replace("/platform-types/{id}", "/platform-types/core.note")
    .replace("/jobs/{id}", "/jobs/baj-none")
    .replace("{hash}", `sha256:${"0".repeat(64)}`)
    .replace("{tag}", "x")
    .replace("{namespace}", "x");
}

/**
 * Built after `beforeAll` rather than at module scope, because two of these
 * bodies have to name a version the run has actually read: the update doors
 * refuse a request naming none with `400 missing_required_field` before they
 * look for a credential, and a sweep sending one would report those two doors
 * as refusing a bare request when what it measured was its own malformed body.
 */
function bodies(): Record<string, unknown> {
  return {
    "PATCH /items/{id}": { properties: { body: "x" }, version: itemVersion },
    "POST /items/{id}/transition": { state: "archived" },
    "POST /items/{id}/tags": { tags: ["x"] },
    "POST /items/bulk": {
      items: [{ type: "core.note", properties: { body: "x" } }],
    },
    "POST /items/bulk-actions": {
      action: "transition",
      state: "archived",
      filter: { tags: ["x"] },
    },
    "POST /items/bulk-get": { ids: [] },
    "PATCH /edges/{id}": { properties: {}, version: edgeVersion },
    "POST /edges/bulk": { edges: [] },
    "POST /edge-types": { id: "mock.sweep", cardinality: "many-to-many" },
    "POST /edges": { source_id: "x", target_id: "x", edge_type: "about" },
    "POST /items": { type: "core.note", properties: { body: "x" } },
    "POST /webhooks": { url: "http://127.0.0.1:9/x", events: ["*"] },
    "POST /keys": { label: "x", source: "x" },
    "POST /types": { id: "user.sweep", fields: {} },
  };
}

const QUERIES: Record<string, string> = {
  "GET /search": "?q=x",
  "GET /occurrences": "?from=2030-01-01T00:00:00Z&to=2030-01-02T00:00:00Z",
};

describe("every published door refuses a request with no credential", () => {
  it("answers 401 unauthorized on each of them", async () => {
    const doors = (await publishedOperations()).filter(
      (op) => !OPEN_DOORS.has(`${op.method} ${op.path}`),
    );
    expect(doors.length).toBeGreaterThan(50);

    const allBodies = bodies();
    const wrong: string[] = [];
    for (const op of doors) {
      const key = `${op.method} ${op.path}`;
      const body = allBodies[key] ?? {};
      const query = QUERIES[key] ?? "";
      const response = await fetch(
        `${apiUrl}${concretePath(op.path)}${query}`,
        {
          method: op.method,
          headers: { "Content-Type": "application/json" },
          body: op.method === "GET" ? undefined : JSON.stringify(body),
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
          `${key} answered ${String(response.status)} ${text.slice(0, 120)}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });
});

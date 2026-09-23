/**
 * The document and the route table, held to each other in both directions.
 *
 * The conformance suite has the forward direction: a door the document
 * declares and the server does not serve answers 404 rather than 401. Only
 * this side can ask the reverse, because nothing queries a door it has not
 * been told about.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  finalizeOpenAPISpec,
  OPENAPI_DOCUMENT_INFO,
  INTERNAL_OPERATION_IDS,
} from "./openapi-finalize.js";
import { createTestContext } from "./test-utils.js";
import type { TestContext } from "./test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Every door the router would dispatch to, as `METHOD /path`.
 *
 * Middleware shares the table, so a pattern carrying `*` is dropped:
 * `app.use("*", …)` is not a door, and the one real catch-all, Better
 * Auth's `/auth/*`, is accounted for below.
 */
function servedDoors(
  routes: readonly { method: string; path: string }[] = ctx.app.routes,
): Set<string> {
  const out = new Set<string>();
  for (const route of routes) {
    if (!HTTP_METHODS.includes(route.method)) continue;
    if (route.path.includes("*")) continue;
    out.add(`${route.method} ${route.path}`);
  }
  return out;
}

function publishedOperations(): Set<string> {
  const document = finalizeOpenAPISpec(
    ctx.app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: OPENAPI_DOCUMENT_INFO,
    }),
  );
  return operationsIn(document.paths ?? {});
}

function operationsIn(paths: object): Set<string> {
  const out = new Set<string>();
  for (const [path, item] of Object.entries(paths)) {
    for (const method of Object.keys(item as Record<string, unknown>)) {
      if (!HTTP_METHODS.includes(method.toUpperCase())) continue;
      out.add(`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`);
    }
  }
  return out;
}

/**
 * Doors the server serves and the document deliberately does not carry, each
 * with why. A door in neither this record nor the document fails the walk
 * below. Kept as data in document spelling because `check:statuses` reads
 * the same list for the routes a run reaches outside the document.
 */
const UNPUBLISHED: Record<string, string> = Object.fromEntries(
  Object.entries(
    JSON.parse(
      readFileSync(
        new URL("../unpublished-routes.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, string>,
  ).map(([door, why]) => [door.replace(/\{([^}]+)\}/g, ":$1"), why]),
);

/** Published operations with no route of their own, and what serves them. */
const SERVED_BY_A_CATCH_ALL: Record<string, string> = {
  "POST /auth/oauth2/register":
    "RFC 7591 registration, served by the Better Auth `/auth/*` mount",
};

function undocumented(served: Set<string>, published: Set<string>): string[] {
  return [...served]
    .filter((door) => !published.has(door))
    .filter((door) => !(door in UNPUBLISHED))
    .sort();
}

function unserved(served: Set<string>, published: Set<string>): string[] {
  return [...published]
    .filter((operation) => !served.has(operation))
    .filter((operation) => !(operation in SERVED_BY_A_CATCH_ALL))
    .sort();
}

describe("the document and the routes", () => {
  it("publishes every door the server serves, or names it as unpublished", () => {
    const served = servedDoors();
    expect(served.size).toBeGreaterThan(80);
    expect(undocumented(served, publishedOperations())).toEqual([]);
  });

  it("serves every door the document publishes", () => {
    const published = publishedOperations();
    expect(published.size).toBeGreaterThan(75);
    expect(unserved(servedDoors(), published)).toEqual([]);
  });

  // The witnesses. Both walks above assert an absence, and an absence over
  // two sets built from one app passes just as well when the walk is looking
  // at nothing.
  it("sees a door the server grew and the document does not carry", () => {
    const served = new Set([...servedDoors(), "POST /items/reindex"]);
    expect(undocumented(served, publishedOperations())).toEqual([
      "POST /items/reindex",
    ]);
  });

  it("sees a HEAD door registered on its own", () => {
    // Hono answers HEAD from the GET handler, so no such door exists today;
    // one registered explicitly is a door the document has to carry.
    const served = servedDoors([
      ...ctx.app.routes,
      { method: "HEAD", path: "/items/:id" },
    ]);
    expect(undocumented(served, publishedOperations())).toEqual([
      "HEAD /items/:id",
    ]);
  });

  it("sees a door stripped from the document", () => {
    const published = publishedOperations();
    published.delete("GET /items/:id");
    expect(published.has("GET /items/:id")).toBe(false);
    expect(undocumented(servedDoors(), published)).toEqual(["GET /items/:id"]);
  });

  it("sees a document entry nothing serves", () => {
    const published = new Set([
      ...publishedOperations(),
      "GET /items/{id}/history".replace(/\{([^}]+)\}/g, ":$1"),
    ]);
    expect(unserved(servedDoors(), published)).toEqual([
      "GET /items/:id/history",
    ]);
  });

  it("holds every exception to a door that still exists", () => {
    const served = servedDoors();
    const published = publishedOperations();
    for (const door of Object.keys(UNPUBLISHED)) {
      expect(served.has(door), `stale: ${door} is not served`).toBe(true);
      expect(published.has(door), `${door} is published after all`).toBe(false);
    }
    for (const operation of Object.keys(SERVED_BY_A_CATCH_ALL)) {
      expect(
        published.has(operation),
        `stale: ${operation} is not published`,
      ).toBe(true);
    }
  });

  it("strips exactly the operations named internal", () => {
    expect(INTERNAL_OPERATION_IDS.size).toBeGreaterThan(0);
    const registry = ctx.app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "registry", version: "0" },
    });
    const stripped: string[] = [];
    for (const [path, item] of Object.entries(registry.paths ?? {})) {
      for (const [method, operation] of Object.entries(
        item as Record<string, { operationId?: string }>,
      )) {
        if (!HTTP_METHODS.includes(method.toUpperCase())) continue;
        const id = operation.operationId;
        if (id !== undefined && INTERNAL_OPERATION_IDS.has(id)) {
          stripped.push(
            `${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`,
          );
        }
      }
    }
    expect(stripped.length).toBe(INTERNAL_OPERATION_IDS.size);
    const published = publishedOperations();
    for (const door of stripped) {
      expect(published.has(door), `${door} was not stripped`).toBe(false);
      expect(door in UNPUBLISHED, `${door} is not named unpublished`).toBe(
        true,
      );
    }
  });
});

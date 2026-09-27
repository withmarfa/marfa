/**
 * Every way an item or an edge is written is either a door that honors an
 * `Idempotency-Key` or a caller that states why it cannot carry one.
 *
 * **Enumerated at the layer writes happen, not by walking routes.** The
 * property is about a write, and walking `/items` and `/edges` for
 * POST/PATCH/DELETE finds only the sites that happen to have a URL. Most
 * of the writers here do not: the sign-up provisioner, the four connection
 * lifecycle pipelines, the connector supervisor, the enrichment sweeper,
 * the bulk-action worker and the archive restore all reach the same store
 * methods with no request behind them at all. A route walk cannot show
 * that those are excluded on purpose rather than missed, and "a caller
 * with no route" is exactly the shape that has been missed here before.
 *
 * So the enumeration is a grep over the storage-layer write calls —
 * `items.{create,update,delete,purge,restore,transition,bulkPurge}` and
 * `edges.{createRaw,updateProperties,delete,deleteBySource*,
 * deleteByTarget*}` — and every file it names is classified below. The
 * test re-runs that grep, so a new writer added anywhere in the server
 * lands here rather than being found by the next reviewer.
 *
 * The route walk is kept as the second half, because the two answer
 * different questions: the grep says every writer is accounted for, and
 * the walk says every mounted write door under `/items` and `/edges` is.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IDEMPOTENT_WRITE_DOORS } from "../middleware/idempotency.js";
import { buildPublishedOpenAPISpec } from "../openapi-published.js";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The store methods that write an item or an edge.
 *
 * Read off `ItemStore` and `EdgeStore` in `storage/interface.ts` rather
 * than off the routes. A method added to either interface and not listed
 * here is invisible to this file, which is the one gap left — and it is a
 * narrower one than the route walk's, because an interface is a single
 * file somebody is already editing.
 */
const WRITE_METHODS: readonly string[] = [
  "items.create",
  "items.update",
  "items.delete",
  "items.purge",
  "items.bulkPurge",
  "items.restore",
  "items.transition",
  "edges.createRaw",
  "edges.updateProperties",
  "edges.delete",
  "edges.deleteBySource",
  "edges.deleteBySourceBatch",
  "edges.deleteByTarget",
  "edges.deleteByTargetBatch",
];

/**
 * Files holding a write, mapped to what carries the key for it.
 *
 * A value is either the door table above (the write is behind one of
 * those routes) or the reason the write cannot carry a key.
 */
const WRITERS: Record<string, string> = {
  // --- Behind an idempotent door ---
  "routes/items.ts":
    "POST /items, PATCH /items/{id}, DELETE /items/{id} and DELETE /items/{id}/purge, all in IDEMPOTENT_WRITE_DOORS",
  "routes/items-lifecycle.ts":
    "POST /items/{id}/restore and POST /items/{id}/transition, both in IDEMPOTENT_WRITE_DOORS",
  "routes/edges.ts":
    "POST /edges, PATCH /edges/{id} and DELETE /edges/{id}, all in IDEMPOTENT_WRITE_DOORS",
  "routes/folders.ts":
    "POST /folders, PATCH /folders/{id} and POST /folders/{id}/revoke, all in IDEMPOTENT_WRITE_DOORS",
  "routes/_edges-inline.ts":
    "the shared inline-edge reconciler, reached only from POST /items, PATCH /items/{id} and the bulk doors — it is never a door itself",

  // --- A door, deliberately not idempotent through this mechanism ---
  "routes/bulk.ts":
    "POST /items/bulk resolves an existing row by id or natural key and updates it, so a retry converges rather than colliding — the collision this mechanism removes is not reachable there. POST /items/bulk-actions already reads Idempotency-Key and stores its outcome in the job row the outcome IS; a second mechanism over the same header on the same door is the thing this change exists to avoid",
  "routes/edges-bulk.ts":
    "POST /edges/bulk upserts on the (source, target, type) triple, so a retry converges. A batch response is also megabytes, and storing one per key trades an unbounded table for a property the door already has",
  "routes/admin-archive.ts":
    "archive restore is idempotent by construction — an existing row is reported skipped — and it is an operator-key operation over a file rather than a write a client retries",

  // --- Writes with no request behind them, so no header to carry ---
  "enrichment/sweeper.ts": "background extraction sweep, no request",
  "bulk-actions/runner.ts":
    "the async bulk-action worker; the job row it runs from is what the door's own Idempotency-Key already deduplicates",

  // --- Routes writing a system item through a surface of their own ---
  "routes/auth-consent.ts":
    "projects an OAuth grant onto a system.connection; the consent decision is already serialized by withConsentLock and is a browser form rather than a retried API write",
  "routes/auth-pages.ts": "the device-flow and grant surfaces, as above",
  "auth/grant-lifecycle.ts":
    "the revoke cascade's projection flip, moved out of auth-pages so the grant routes and the client-revoke hook share one writer; a convergent write (status revoked, revoked_at restamped) reached from a browser form, an admin route or the plugin's revoke endpoint rather than from a retried API write, and taken under the consent lock whenever both ids are known",
};

/** Every file under `src/` that is not a test. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    acc.push(full);
  }
  return acc;
}

/**
 * Files calling a store write method, excluding the store implementations
 * themselves and the interface that declares them.
 */
function writerFiles(): Set<string> {
  const found = new Set<string>();
  for (const full of sourceFiles(SERVER_SRC)) {
    const relative = full.slice(SERVER_SRC.length + 1);
    if (relative.startsWith("storage/")) continue;
    if (relative === "test-utils.ts") continue;
    const text = readFileSync(full, "utf-8");
    for (const method of WRITE_METHODS) {
      // The call, not the mention: a comment naming a method would
      // otherwise classify a file that writes nothing.
      if (text.includes(`${method}(`)) {
        found.add(relative);
        break;
      }
    }
  }
  return found;
}

describe("every writer is accounted for", () => {
  it("names a door or states why it carries no key", () => {
    const unclassified = [...writerFiles()].filter((f) => !(f in WRITERS));
    // A new writer lands here. Put it behind one of the doors above, or
    // give it a row saying why a retried request cannot reach it —
    // deciding which is the point.
    expect(unclassified.sort()).toEqual([]);
  });

  it("holds every row to a file that still writes", () => {
    // A row left behind after its file stopped writing stops excluding
    // anything, and the next writer to take that path inherits the excuse.
    const writers = writerFiles();
    const stale = Object.keys(WRITERS).filter((f) => !writers.has(f));
    expect(stale.sort()).toEqual([]);
  });

  it("finds the writers it is looking for", () => {
    // The control. A grep that matched nothing would make both assertions
    // above pass having measured nothing, which is exactly the shape a
    // renamed store method or a moved directory produces.
    const writers = writerFiles();
    expect(writers.size).toBeGreaterThan(10);
    expect(writers.has("routes/items.ts")).toBe(true);
    expect(writers.has("routes/edges.ts")).toBe(true);
    expect(writers.has("enrichment/sweeper.ts")).toBe(true);
  });
});

describe("every door is a route the app really serves", () => {
  it("is served by a handler, not merely by its own middleware registration", async () => {
    // **Asked of the app rather than of `app.routes`.** Mounting the
    // middleware is itself a route registration, so every door is in that
    // table because the mount loop ran — an assertion over it is true of a
    // door naming a path nothing serves, which is the typo it would exist
    // to catch. Reading the table cannot separate the two.
    //
    // A request can. An unserved path falls through to Hono's bare 404,
    // while a real door is reached and refuses the credential it was not
    // given. Which refusal it is does not matter and is deliberately not
    // asserted: the property is that something served the path, and only a
    // 404 says nothing did. Neither answer depends on the middleware having
    // been mounted.
    for (const door of IDEMPOTENT_WRITE_DOORS) {
      const [method, path] = door.split(" ");
      if (method === undefined || path === undefined) continue;
      const res = await ctx.app.request(
        path.replace(/:(\w+)/g, "does-not-exist"),
        {
          method,
          headers: { "Content-Type": "application/json" },
          body: method === "DELETE" ? undefined : "{}",
        },
      );
      expect(res.status, `${door} is not served by anything`).not.toBe(404);
    }
  });

  it("covers every write verb mounted under /items and /edges", () => {
    const registered = new Set(
      ctx.app.routes.map((r) => `${r.method} ${r.path}`),
    );
    const covered = new Set(IDEMPOTENT_WRITE_DOORS);
    const unclassified: string[] = [];
    for (const route of registered) {
      const [method, path] = route.split(" ");
      if (path === undefined || method === undefined) continue;
      if (!path.startsWith("/items") && !path.startsWith("/edges")) continue;
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) continue;
      if (covered.has(route)) continue;
      if (route in NOT_AN_IDEMPOTENT_DOOR) continue;
      unclassified.push(route);
    }
    expect(unclassified.sort()).toEqual([]);
  });

  it("holds every exclusion to a route that still exists", () => {
    const registered = new Set(
      ctx.app.routes.map((r) => `${r.method} ${r.path}`),
    );
    for (const route of Object.keys(NOT_AN_IDEMPOTENT_DOOR)) {
      expect(registered.has(route), `stale exclusion: ${route}`).toBe(true);
    }
  });
});

/**
 * Write verbs under `/items` and `/edges` that do not honor a key, each
 * with the reason. Listed rather than omitted: the walk above fails on
 * anything in neither table.
 */
const NOT_AN_IDEMPOTENT_DOOR: Record<string, string> = {
  "POST /items/bulk":
    "resolves an existing row by id or natural key and updates it, so a retry converges rather than colliding",
  "POST /items/bulk-get": "read-only batch fetch",
  "POST /items/bulk-actions":
    "already reads Idempotency-Key and stores its outcome in the job row that outcome IS; a second mechanism over the same header on the same door is what this change exists to avoid",
  "DELETE /items/bulk-actions/jobs/:id":
    "requests cancellation of a job, and asking twice is already a no-op on a terminal job",
  "POST /edges/bulk": "upserts on the triple, so a retry converges",
  "POST /items/:id/tags":
    "metadata layer; a tag set is written whole, so a repeat is already a no-op",
  "DELETE /items/:id/tags/:tag":
    "metadata layer; removing an absent tag is already a no-op",
  "PUT /items/:id/metadata":
    "metadata layer; a replace is already a no-op on repeat",
  "PATCH /items/:id/metadata":
    "metadata layer; a merge of the same map is already a no-op",
  "PUT /items/:id/extensions/:namespace":
    "extension layer; a replace is already a no-op on repeat",
  "DELETE /items/:id/extensions/:namespace":
    "extension layer; removing an absent namespace is already a no-op",
};

describe("the reference says which doors honor the header", () => {
  it("carries Idempotency-Key on exactly the doors, and nowhere else", async () => {
    // The reference is what an app developer reads, and a header that
    // works and is undocumented is the same to them as one that does not
    // work. Asserted in both directions because the injection is derived
    // from the door table: a path-syntax mistake would document nothing
    // and still pass a one-sided check.
    const spec = (await buildPublishedOpenAPISpec()) as {
      paths: Record<
        string,
        Record<string, { parameters?: { name?: string; in?: string }[] }>
      >;
    };
    const documented = new Set<string>();
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const carries = (op.parameters ?? []).some(
          (p) => p.in === "header" && p.name === "Idempotency-Key",
        );
        if (carries) documented.add(`${method.toUpperCase()} ${path}`);
      }
    }
    const expected = new Set(
      IDEMPOTENT_WRITE_DOORS.map((door) =>
        door.replace(/:([A-Za-z0-9_]+)/g, "{$1}"),
      ),
    );
    expect([...documented].sort()).toEqual([...expected].sort());
  });
});

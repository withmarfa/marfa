/**
 * Every door that honors an `Idempotency-Key` honors it through the one
 * mechanism, `idempotencyMiddleware` over `IDEMPOTENT_WRITE_DOORS`.
 *
 * **A census, because a second reading of the header looks covered from
 * outside.** A door that reads the key itself and keeps its own record of
 * it answers a repeat as a replay would, and nothing a per-door test asks
 * tells the two apart until two credentials share a key, or one sends a
 * different request under it. So the app's own route table is walked: the
 * middleware has to be mounted on exactly the door table, and no handler on
 * any route may read the header itself. The route table sees only what a
 * handler does inline, so the source half below holds every file to the
 * same rule, a helper a handler calls included.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import ts from "typescript";
import {
  IDEMPOTENT_WRITE_DOORS,
  credentialIdempotencyKey,
  idempotencyMiddleware,
} from "../middleware/idempotency.js";
import { createErrorHandler } from "../middleware/error-handler.js";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
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
 * Whether source text holds the header's name as a string of its own, in
 * any case and any of the three quotes. Read off the syntax tree rather than
 * the text, so a description or a comment that mentions the header in
 * prose is not a reading of it, and a template literal is.
 */
function namesTheHeader(source: string): boolean {
  const file = ts.createSourceFile(
    "probe.ts",
    // A handler's source is a bare function expression; parenthesized it is
    // a statement the parser takes whole.
    `(${source})`,
    ts.ScriptTarget.Latest,
    true,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text.toLowerCase() === "idempotency-key"
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Whether source text calls the key-within-its-credential helper. */
function derivesFromTheKey(source: string): boolean {
  return /\bcredentialIdempotencyKey\b/.test(source);
}

/** The middleware's own handler, recognized by its source. */
const MIDDLEWARE_SOURCE = idempotencyMiddleware({
  storage: {} as Storage,
  errorHandler: createErrorHandler({ errorWebhookUrl: "" }),
}).toString();

interface RouteEntry {
  method: string;
  path: string;
  handler: { toString(): string };
}

function routesReadingTheHeader(routes: readonly RouteEntry[]): string[] {
  return [
    ...new Set(
      routes
        .filter((r) => r.handler.toString() !== MIDDLEWARE_SOURCE)
        .filter((r) => namesTheHeader(r.handler.toString()))
        .map((r) => `${r.method} ${r.path}`),
    ),
  ].sort();
}

/**
 * Routes outside the door table whose handler derives a value from the key.
 * Off the table no claim is taken, so a value derived from the key there
 * meets no record and no fingerprint.
 */
function routesDerivingOffTheTable(routes: readonly RouteEntry[]): string[] {
  const doors = new Set(IDEMPOTENT_WRITE_DOORS);
  return [
    ...new Set(
      routes
        .filter((r) => !doors.has(`${r.method} ${r.path}`))
        .filter((r) => derivesFromTheKey(r.handler.toString()))
        .map((r) => `${r.method} ${r.path}`),
    ),
  ].sort();
}

describe("the route table", () => {
  it("mounts the shared mechanism on exactly the door table", () => {
    const mounted = new Set(
      ctx.app.routes
        .filter((r) => r.handler.toString() === MIDDLEWARE_SOURCE)
        .map((r) => `${r.method} ${r.path}`),
    );
    expect([...mounted].sort()).toEqual([...IDEMPOTENT_WRITE_DOORS].sort());
  });

  it("has no handler that reads the header itself", () => {
    expect(routesReadingTheHeader(ctx.app.routes)).toEqual([]);
  });

  it("would see a handler that did, in any quote", () => {
    // The control: a detector that matched nothing would pass the case
    // above having measured nothing.
    const app = new Hono();
    app.post("/own-key", (c) => c.text(c.req.header("Idempotency-Key") ?? ""));
    app.post("/templated", (c) =>
      c.text(c.req.header(`idempotency-key`) ?? ""),
    );
    app.post("/prose", (c) =>
      c.text("send an `Idempotency-Key` to make this safe to retry"),
    );
    expect(routesReadingTheHeader(app.routes)).toEqual([
      "POST /own-key",
      "POST /templated",
    ]);
  });

  it("derives from the key only on a door in the table", () => {
    expect(routesDerivingOffTheTable(ctx.app.routes)).toEqual([]);
  });

  it("would see a handler off the table that derived from it", () => {
    // The control, and the witness that a door on the table does derive.
    const app = new Hono<AppEnv>();
    app.post("/off-table", (c) => c.text(credentialIdempotencyKey(c) ?? ""));
    expect(routesDerivingOffTheTable(app.routes)).toEqual(["POST /off-table"]);
    expect(
      ctx.app.routes.some(
        (r) =>
          r.method === "PATCH" &&
          r.path === "/items/:id" &&
          derivesFromTheKey(r.handler.toString()),
      ),
    ).toBe(true);
  });
});

/**
 * Files that may name the header: the mechanism itself, and the reference,
 * which documents it on the door table and nowhere else.
 */
const MAY_NAME_THE_HEADER: Record<string, string> = {
  "middleware/idempotency.ts": "the mechanism",
  "openapi-finalize.ts":
    "declares the header on the doors IDEMPOTENT_WRITE_DOORS names",
};

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    acc.push(full);
  }
  return acc;
}

describe("the source", () => {
  it("names the header only where the mechanism and its reference live", () => {
    const naming = sourceFiles(SERVER_SRC)
      .filter((full) => namesTheHeader(readFileSync(full, "utf-8")))
      .map((full) => full.slice(SERVER_SRC.length + 1));
    expect(naming.sort()).toEqual(Object.keys(MAY_NAME_THE_HEADER).sort());
  });
});

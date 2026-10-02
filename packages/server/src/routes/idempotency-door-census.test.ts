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
import {
  IDEMPOTENT_WRITE_DOORS,
  idempotencyMiddleware,
} from "../middleware/idempotency.js";
import { createErrorHandler } from "../middleware/error-handler.js";
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

/** The header, in any case, written as a string a handler could read. */
const NAMES_THE_HEADER = /["']idempotency-key["']/i;

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
        .filter((r) => NAMES_THE_HEADER.test(r.handler.toString()))
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

  it("would see a handler that did", () => {
    // The control: a detector that matched nothing would pass the case
    // above having measured nothing.
    const app = new Hono();
    app.post("/own-key", (c) => c.text(c.req.header("Idempotency-Key") ?? ""));
    expect(routesReadingTheHeader(app.routes)).toEqual(["POST /own-key"]);
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
      .filter((full) => NAMES_THE_HEADER.test(readFileSync(full, "utf-8")))
      .map((full) => full.slice(SERVER_SRC.length + 1));
    expect(naming.sort()).toEqual(Object.keys(MAY_NAME_THE_HEADER).sort());
  });
});

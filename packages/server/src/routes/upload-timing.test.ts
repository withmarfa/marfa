import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { startControlSocket } from "../control/socket.js";
import { reservePublicListener } from "../public-listener.js";
import { ensureInstanceId } from "../storage/instance-id.js";
import {
  cleanupTestContext,
  createTestContext,
  type TestContext,
} from "../test-utils.js";

/** What a restore or an upload may take to arrive whole, for these tests. */
const DEADLINE_MS = 500;
/** How long they may receive nothing before the server ends them. */
const IDLE_MS = 900;
/** Between pieces: far under the idle limit, and in all well past the deadline. */
const GAP_MS = 200;

let ctx: TestContext;
let archive: Uint8Array;
let scratch: string | undefined;
let publicServer: Server | undefined;
let publicPort: number;
let controlServer: Server | undefined;
let controlPath: string;

beforeAll(async () => {
  ctx = await createTestContext({ uploadIdleTimeoutMs: IDLE_MS });
  const written = await ctx.app.request("/items", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.workingKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "core.note",
      properties: { body: "uploaded slowly" },
    }),
  });
  expect(written.status).toBe(201);
  const exported = await ctx.ownerRequest("/export?format=archive");
  archive = new Uint8Array(await exported.arrayBuffer());

  const config = {
    ...ctx.config,
    port: 0,
    listenHost: "127.0.0.1",
  } as AppConfig;
  const listener = await reservePublicListener(config, DEADLINE_MS);
  listener.activate(ctx.app.fetch);
  publicServer = listener.server;
  publicPort = config.port;

  scratch = realpathSync(mkdtempSync(join(tmpdir(), "mu-")));
  controlPath = join(scratch, "private", "c.sock");
  const localApp = createApp(
    ctx.storage,
    ctx.blobs,
    ctx.housekeeping,
    ctx.config,
    await ensureInstanceId(ctx.storage.settings),
    { localAuthority: true },
  );
  controlServer = await startControlSocket(
    controlPath,
    localApp.fetch,
    DEADLINE_MS,
  );
});

afterAll(async () => {
  for (const server of [publicServer, controlServer]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
  await cleanupTestContext(ctx);
});

interface Door {
  name: string;
  /** Where to connect. */
  target: { port: number } | { socketPath: string };
  /** The credentials this door's caller sends. */
  headers: Record<string, string>;
}

function door(name: string): Door {
  const known: Door[] = [
    {
      name: "public listener",
      target: { port: publicPort },
      headers: {
        cookie: ctx.owner.cookie,
        origin: new URL(ctx.config.authBaseUrl).origin,
        authorization: `Bearer ${ctx.workingKey}`,
      },
    },
    {
      name: "control socket",
      target: { socketPath: controlPath },
      headers: {},
    },
  ];
  return known.find((candidate) => candidate.name === name)!;
}

interface Outcome {
  status: number | string;
  text: string;
  ms: number;
}

/**
 * Send `body` in `pieces` parts, `gapMs` apart, and end it when `finish` is
 * set; otherwise leave the request open after the last part.
 */
function send(
  door: Door,
  path: string,
  body: Uint8Array,
  options: {
    pieces: number;
    gapMs: number;
    finish: boolean;
    contentType: string;
    only?: string[];
  },
): Promise<Outcome> {
  return new Promise((resolve) => {
    const started = performance.now();
    const settle = (status: number | string, text: string) => {
      resolve({ status, text, ms: performance.now() - started });
    };
    const headers: Record<string, string> = {
      ...door.headers,
      "content-type": options.contentType,
      "transfer-encoding": "chunked",
    };
    // A restore takes the owner; an upload and an ordinary write take the key.
    if (path === "/restore") delete headers.authorization;
    else delete headers.cookie;
    const req = request(
      {
        ...door.target,
        host: "127.0.0.1",
        path,
        method: "POST",
        headers,
        agent: false,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString()));
        res.on("end", () => {
          settle(res.statusCode ?? 0, text);
        });
        res.on("error", () => {
          settle("reset", text);
        });
      },
    );
    req.on("error", (error: NodeJS.ErrnoException) => {
      settle(error.code ?? "error", "");
    });
    const size = Math.ceil(body.length / options.pieces);
    let sent = 0;
    const tick = () => {
      if (req.destroyed) return;
      if (sent >= options.pieces) {
        if (options.finish) req.end();
        return;
      }
      req.write(body.slice(sent * size, (sent + 1) * size));
      sent += 1;
      setTimeout(tick, options.gapMs);
    };
    tick();
  });
}

async function spooled(): Promise<string[]> {
  return readdir(ctx.blobs.disk.spoolDir);
}

/**
 * Whether the spool held a file at any moment before `outcome` settled. It
 * polls until it sees one or the request is over, never for a fixed number of
 * tries, because the server ends a stalled upload on its own clock and a
 * slow runner can leave the check fewer turns than any fixed count.
 */
async function spoolHeldBefore(outcome: Promise<Outcome>): Promise<boolean> {
  const request = { over: false };
  void outcome.then(() => {
    request.over = true;
  });
  for (;;) {
    if ((await spooled()).length > 0) return true;
    if (request.over) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function blobCount(): Promise<number> {
  const rows = await (
    ctx.storage as typeof ctx.storage & {
      __sqliteAll: (query: string) => Promise<{ n: number }[]>;
    }
  ).__sqliteAll("SELECT COUNT(*) AS n FROM blobs");
  return Number(rows[0]?.n);
}

function blobBytes(seed: string): { bytes: Buffer; hash: string } {
  const bytes = Buffer.alloc(40_000, seed);
  return {
    bytes,
    hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

describe.each(["public listener", "control socket"])(
  "a slow upload to the %s",
  (name) => {
    it("restores an archive whose body takes longer than the request deadline", async () => {
      const outcome = await send(door(name), "/restore", archive, {
        pieces: 8,
        gapMs: GAP_MS,
        finish: true,
        contentType: "application/gzip",
      });
      expect(outcome.status, outcome.text).toBe(200);
      expect(outcome.text).toContain("imported");
      expect(outcome.ms).toBeGreaterThan(DEADLINE_MS * 2);
    });

    it("stores a blob whose body takes longer than the request deadline", async () => {
      const { bytes, hash } = blobBytes(`stored on the ${name} `);
      const outcome = await send(door(name), "/blobs", bytes, {
        pieces: 8,
        gapMs: GAP_MS,
        finish: true,
        contentType: "application/octet-stream",
      });
      expect(outcome.status, outcome.text).toBe(201);
      expect(JSON.parse(outcome.text)).toMatchObject({ hash });
      expect(outcome.ms).toBeGreaterThan(DEADLINE_MS * 2);
    });

    it("ends a restore that stops arriving with 408 request_timeout and removes what it spooled", async () => {
      expect(await spooled()).toEqual([]);
      const pending = send(door(name), "/restore", archive, {
        pieces: 2,
        gapMs: GAP_MS,
        finish: false,
        contentType: "application/gzip",
      });
      // The witness for the absence below: the spool held the part that arrived.
      expect(await spoolHeldBefore(pending)).toBe(true);
      const outcome = await pending;
      expect(outcome.status, outcome.text).toBe(408);
      expect(JSON.parse(outcome.text).error.code).toBe("request_timeout");
      expect(outcome.ms).toBeGreaterThanOrEqual(IDLE_MS);
      expect(await spooled()).toEqual([]);
    });

    it("ends a blob upload that stops arriving with 408 request_timeout, removes its spool and registers nothing", async () => {
      const { bytes } = blobBytes(`stalled on the ${name} `);
      const before = await blobCount();
      const pending = send(door(name), "/blobs", bytes, {
        pieces: 4,
        gapMs: GAP_MS,
        finish: false,
        contentType: "application/octet-stream",
      });
      expect(await spoolHeldBefore(pending)).toBe(true);
      const outcome = await pending;
      expect(outcome.status, outcome.text).toBe(408);
      expect(JSON.parse(outcome.text).error.code).toBe("request_timeout");
      expect(await spooled()).toEqual([]);
      expect(await blobCount()).toBe(before);
    });

    it("still cuts an ordinary write that does not arrive within the request deadline", async () => {
      const body = new TextEncoder().encode(
        JSON.stringify({
          type: "core.note",
          properties: { body: "x".repeat(400) },
        }),
      );
      const outcome = await send(door(name), "/items", body, {
        pieces: 8,
        gapMs: GAP_MS,
        finish: true,
        contentType: "application/json",
      });
      expect(outcome.status).not.toBe(201);
      expect(outcome.ms).toBeGreaterThanOrEqual(DEADLINE_MS);
    });
  },
);

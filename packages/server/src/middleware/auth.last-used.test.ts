import { AsyncLocalStorage } from "node:async_hooks";
import {
  withRequestAuthority,
  validateRequestAuthority,
} from "../auth/request-authority.js";
import {
  TransactionControl,
  transactionControl,
} from "../storage/sqlite/transaction-control.js";
import { drainKeyUsage } from "../storage/key-usage.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as clock from "../clock.js";
import type { Storage } from "../storage/interface.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { itemWrites } from "../storage/item-writes.js";
import type { AppEnv } from "./auth.js";
import {
  _clearOAuthLastUsedCacheForTesting,
  authMiddleware,
  hashApiKey,
  stampOAuthGrantLastUsedByGrantKey,
} from "./auth.js";

const WINDOW = 3_600_000;
const GRANT = { clientId: "app", authUserId: "owner" };

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function credentialApp(
  updateLastUsed = vi
    .fn<Storage["keys"]["updateLastUsed"]>()
    .mockResolvedValue(undefined),
) {
  const updateLastUsedAt = vi.fn().mockResolvedValue(undefined);
  const findGrantItemId = vi.fn().mockResolvedValue("connection");
  const validate = vi.fn<Storage["keys"]["validate"]>().mockResolvedValue({
    id: "key",
    label: "test",
    source: "test",
    sources: [],
    permissions: [],
    profile_permissions: {},
    expires_at: null,
    default_tier: "library",
    type_permissions: {},
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    created_at: "2026-01-01T00:00:00Z",
    last_used_at: null,
    key_hash: "hash",
    revoked_at: null,
  });
  const storage = {
    keys: {
      validate,
      updateLastUsed,
    },
    oauthProvider: {
      findGrantItemId,
      updateLastUsedAt,
      validateAccessToken: vi.fn().mockResolvedValue({
        id: "token",
        userId: GRANT.authUserId,
        clientId: GRANT.clientId,
        scopes: [],
        createdAtMs: 1,
        expiresAtMs: null,
      }),
    },
  } as unknown as Storage;
  const app = new Hono<AppEnv>();
  app.use("*", authMiddleware(storage, "test-salt"));
  const accepted = vi.fn();
  app.get("/", (c) => {
    accepted();
    return c.json({ authenticated: !!c.get("apiKey") });
  });
  app.onError((_error, c) => c.json({ error: "stamp failed" }, 500));
  const request = (token = "marfa_k1_test") =>
    app.request("/", {
      headers: { Authorization: `Bearer ${token}` },
    });
  return {
    storage,
    drain: () => drainKeyUsage(storage),
    validate,
    accepted,
    request,
    updateLastUsed,
    updateLastUsedAt,
    findGrantItemId,
  };
}

describe("in-process last-used windows", () => {
  let elapsed: number;
  let wall: number;

  beforeEach(() => {
    elapsed = 0;
    wall = Date.parse("2026-01-01T00:00:00Z");
    vi.spyOn(clock, "monotonicMs").mockImplementation(() => elapsed);
    vi.spyOn(clock, "nowMs").mockImplementation(() => wall);
    vi.spyOn(clock, "now").mockImplementation(() => new Date(wall));
    _clearOAuthLastUsedCacheForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _clearOAuthLastUsedCacheForTesting();
  });

  it("stamps an API key at monotonic zero and waits until after the elapsed boundary", async () => {
    const c = credentialApp();
    expect((await c.request()).status).toBe(200);
    await c.drain();
    expect(c.updateLastUsed).toHaveBeenCalledExactlyOnceWith(
      "key",
      new Date(wall).toISOString(),
    );
    wall += WINDOW * 100;
    elapsed = WINDOW - 1;
    await c.request();
    await c.drain();
    expect(c.updateLastUsed).toHaveBeenCalledTimes(1);
    elapsed = WINDOW;
    await c.request();
    await c.drain();
    expect(c.updateLastUsed).toHaveBeenCalledTimes(1);
    elapsed += 1;
    await c.request();
    await c.drain();
    expect(c.updateLastUsed).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"] as const)(
    "answers every API-key caller before the shared usage write's %s",
    async (outcome) => {
      const pending = deferred();
      const update = vi
        .fn<Storage["keys"]["updateLastUsed"]>()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(undefined);
      const c = credentialApp(update);
      try {
        expect((await c.request()).status).toBe(200);
        await vi.waitFor(() => {
          expect(update).toHaveBeenCalledTimes(1);
        });
        expect((await c.request()).status).toBe(200);
        expect(c.accepted).toHaveBeenCalledTimes(2);
        expect(update).toHaveBeenCalledTimes(1);
      } finally {
        if (outcome === "success") pending.resolve();
        else pending.reject(new Error("unavailable"));
        await c.drain();
      }
      expect((await c.request()).status).toBe(200);
      await c.drain();
      expect(update).toHaveBeenCalledTimes(1);
      elapsed = 1001;
      expect((await c.request()).status).toBe(200);
      await c.drain();
      expect(update).toHaveBeenCalledTimes(outcome === "success" ? 1 : 2);
    },
  );

  it("bounds queued usage across keys while all requests continue", async () => {
    const pending = deferred();
    const update = vi
      .fn<Storage["keys"]["updateLastUsed"]>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(undefined);
    const c = credentialApp(update);
    const original = (await c.validate("hash"))!;
    try {
      expect((await c.request()).status).toBe(200);
      await vi.waitFor(() => {
        expect(update).toHaveBeenCalledTimes(1);
      });
      for (let i = 1; i <= 130; i++) {
        c.validate.mockResolvedValue({ ...original, id: `key-${String(i)}` });
        expect((await c.request()).status).toBe(200);
      }
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve();
      await c.drain();
    }
    expect(update).toHaveBeenCalledTimes(128);
    expect((await c.request()).status).toBe(200);
    await c.drain();
    expect(update).toHaveBeenCalledTimes(129);
    expect(update.mock.calls.at(-1)?.[0]).toBe("key-130");
  });

  it("does not share a usage cache between stores or advance time while queued", async () => {
    const first = credentialApp();
    const second = credentialApp();
    expect((await first.request()).status).toBe(200);
    const observed = new Date(wall).toISOString();
    wall += WINDOW;
    expect((await second.request()).status).toBe(200);
    await first.drain();
    await second.drain();
    expect(first.updateLastUsed).toHaveBeenCalledExactlyOnceWith(
      "key",
      observed,
    );
    expect(second.updateLastUsed).toHaveBeenCalledExactlyOnceWith(
      "key",
      new Date(wall).toISOString(),
    );
  });

  it("runs usage without request authority or a retained transaction and drains before closing", async () => {
    const requestScope = new AsyncLocalStorage<string>();
    const control = new TransactionControl();
    control.invalidate(new Error("closed writer"), "ended", "committed");
    const observed: unknown[] = [];
    let completed = false;
    const update = vi
      .fn<Storage["keys"]["updateLastUsed"]>()
      .mockImplementation(async () => {
        observed.push([requestScope.getStore(), transactionControl.getStore()]);
        await validateRequestAuthority();
        completed = true;
      });
    const c = credentialApp(update);
    await requestScope.run("caller", () =>
      transactionControl.run(control, () =>
        withRequestAuthority(
          () => Promise.reject(new Error("revoked caller")),
          async () => {
            await expect(validateRequestAuthority()).rejects.toThrow(
              "revoked caller",
            );
            expect(transactionControl.getStore()).toBe(control);
            expect((await c.request()).status).toBe(200);
          },
        ),
      ),
    );
    await drainKeyUsage(c.storage, true);
    expect(observed).toEqual([[undefined, undefined]]);
    expect(completed).toBe(true);
    elapsed = WINDOW + 1;
    expect((await c.request()).status).toBe(200);
    await c.drain();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it.each(["grant key", "bearer"] as const)(
    "stamps OAuth by %s at zero and keeps its window independent of wall time",
    async (path) => {
      const c = credentialApp();
      const stamp = async () => {
        if (path === "grant key")
          await stampOAuthGrantLastUsedByGrantKey(c.storage, GRANT);
        else expect((await c.request("marfa_at_test")).status).toBe(200);
      };
      await stamp();
      expect(c.updateLastUsedAt).toHaveBeenCalledExactlyOnceWith(
        "connection",
        WINDOW,
      );
      wall += WINDOW * 100;
      elapsed = WINDOW - 1;
      await stamp();
      expect(c.updateLastUsedAt).toHaveBeenCalledTimes(1);
      elapsed = WINDOW;
      await stamp();
      expect(c.updateLastUsedAt).toHaveBeenCalledTimes(1);
      elapsed += 1;
      await stamp();
      expect(c.updateLastUsedAt).toHaveBeenCalledTimes(2);
      expect(c.findGrantItemId).toHaveBeenCalledTimes(2);
    },
  );

  it("contains pending and failed OAuth writes by grant key without repeated attempts inside the window", async () => {
    const c = credentialApp();
    const pending = deferred();
    c.updateLastUsedAt.mockReturnValueOnce(pending.promise);
    const stamp = () => stampOAuthGrantLastUsedByGrantKey(c.storage, GRANT);
    const first = stamp();
    await vi.waitFor(() => {
      expect(c.updateLastUsedAt).toHaveBeenCalledTimes(1);
    });
    await stamp();
    expect(c.updateLastUsedAt).toHaveBeenCalledTimes(1);
    pending.reject(new Error("offline"));
    await expect(first).resolves.toBeUndefined();
    await stamp();
    expect(c.updateLastUsedAt).toHaveBeenCalledTimes(1);
    elapsed = WINDOW;
    await stamp();
    expect(c.updateLastUsedAt).toHaveBeenCalledTimes(1);
    elapsed += 1;
    await stamp();
    expect(c.updateLastUsedAt).toHaveBeenCalledTimes(2);
  });

  it("contains a missing or failed grant lookup until its elapsed window expires", async () => {
    const c = credentialApp();
    c.findGrantItemId
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"));
    await stampOAuthGrantLastUsedByGrantKey(c.storage, GRANT);
    await stampOAuthGrantLastUsedByGrantKey(c.storage, GRANT);
    expect(c.findGrantItemId).toHaveBeenCalledTimes(1);
    expect(c.updateLastUsedAt).not.toHaveBeenCalled();
    elapsed = WINDOW + 1;
    await expect(
      stampOAuthGrantLastUsedByGrantKey(c.storage, GRANT),
    ).resolves.toBeUndefined();
    await stampOAuthGrantLastUsedByGrantKey(c.storage, GRANT);
    expect(c.findGrantItemId).toHaveBeenCalledTimes(2);
    elapsed += WINDOW + 1;
    await stampOAuthGrantLastUsedByGrantKey(c.storage, GRANT);
    expect(c.updateLastUsedAt).toHaveBeenCalledExactlyOnceWith(
      "connection",
      WINDOW,
    );
  });

  it.each(["API key", "OAuth grant key"] as const)(
    "keeps %s stamps aligned with the real SQLite floor at the exact hour and one millisecond later",
    async (path) => {
      const directory = await mkdtemp(join(tmpdir(), "marfa-last-used-"));
      const storage = await createSqliteStorage(join(directory, "test.db"));
      try {
        const start = wall;
        let stamp: () => Promise<unknown>;
        let recorded: () => Promise<string | null | undefined>;
        if (path === "API key") {
          const raw = "marfa_k1_sqlite_boundary";
          const key = await storage.keys.create(
            { label: "boundary", source: "test" },
            hashApiKey(raw, "test-salt"),
          );
          const app = new Hono<AppEnv>();
          app.use("*", authMiddleware(storage, "test-salt"));
          app.get("/", (c) => c.json({ ok: true }));
          stamp = async () => {
            const response = await app.request("/", {
              headers: { Authorization: `Bearer ${raw}` },
            });
            expect(response.status).toBe(200);
            await drainKeyUsage(storage);
          };
          recorded = async () => (await storage.keys.get(key.id))?.last_used_at;
        } else {
          const item = await itemWrites(storage).create({
            writer: null,
            type: "system.connection",
            tier: "library",
            properties: {
              kind: "app",
              status: "active",
              granted_at: new Date(wall).toISOString(),
              client_id: GRANT.clientId,
            },
          });
          await storage.__sqliteRun(
            "UPDATE items SET properties = jsonb_set(properties, '$.user_id', ?) WHERE id = ?",
            [GRANT.authUserId, item.id],
          );
          expect(await storage.oauthProvider!.findGrantItemId(GRANT)).toBe(
            item.id,
          );
          stamp = () => stampOAuthGrantLastUsedByGrantKey(storage, GRANT);
          recorded = async () =>
            (await storage.items.get(item.id))?.properties.last_used_at as
              string | undefined;
        }
        const times = [0, WINDOW, WINDOW + 1, WINDOW * 2 - 1, WINDOW * 2];
        const stamps: (string | null | undefined)[] = [];
        for (const time of times) {
          elapsed = time;
          wall = start + time;
          await stamp();
          stamps.push(await recorded());
        }
        expect(stamps).toEqual(
          [0, 0, WINDOW + 1, WINDOW + 1, WINDOW + 1].map((time) =>
            new Date(start + time).toISOString(),
          ),
        );
        elapsed = WINDOW * 2 + 2;
        wall = start + elapsed;
        await stamp();
        expect(await recorded()).toBe(new Date(wall).toISOString());
      } finally {
        await storage.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

it("answers a cold-key read promptly while a real writer is held", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marfa-cold-key-writer-"));
  const storage = await createSqliteStorage(join(directory, "test.db"));
  const entered = deferred();
  const release = deferred();
  let writer: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading: Promise<Response> | undefined;
  try {
    const raw = "marfa_k1_cold_writer";
    const key = await storage.keys.create(
      { label: "cold", source: "cold" },
      hashApiKey(raw, "test-salt"),
    );
    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(storage, "test-salt"));
    app.get("/", (c) => c.json({ authenticated: !!c.get("apiKey") }));
    writer = storage.runInTransaction(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    reading = Promise.resolve(
      app.request("/", { headers: { authorization: `Bearer ${raw}` } }),
    );
    const response = await Promise.race([
      reading,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("cold-key read waited for usage bookkeeping"));
        }, 1000);
        timer.unref();
      }),
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true });
    await drainKeyUsage(storage);
    expect((await storage.keys.get(key.id))?.last_used_at).toBeNull();
  } finally {
    clearTimeout(timer);
    release.resolve();
    await writer;
    await reading;
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

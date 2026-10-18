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
  stampOAuthGrantLastUsed,
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
    expect(c.updateLastUsed).toHaveBeenCalledExactlyOnceWith("key");
    wall += WINDOW * 100;
    elapsed = WINDOW - 1;
    await c.request();
    expect(c.updateLastUsed).toHaveBeenCalledTimes(1);
    elapsed = WINDOW;
    await c.request();
    expect(c.updateLastUsed).toHaveBeenCalledTimes(1);
    elapsed += 1;
    await c.request();
    expect(c.updateLastUsed).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"] as const)(
    "makes all pending API-key callers await the same %s before answering",
    async (outcome) => {
      const pending = deferred();
      const update = vi
        .fn<Storage["keys"]["updateLastUsed"]>()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(undefined);
      const c = credentialApp(update);
      const first = c.request();
      await vi.waitFor(() => {
        expect(update).toHaveBeenCalledTimes(1);
      });
      const second = c.request();
      await vi.waitFor(() => {
        expect(c.validate).toHaveBeenCalledTimes(2);
      });
      const earlyAnswers = c.accepted.mock.calls.length;
      if (outcome === "success") pending.resolve();
      else pending.reject(new Error("unavailable"));
      const responses = await Promise.all([first, second]);
      expect(earlyAnswers).toBe(0);
      expect(responses.map((response) => response.status)).toEqual(
        outcome === "success" ? [200, 200] : [500, 500],
      );
      expect(update).toHaveBeenCalledTimes(1);
      expect((await c.request()).status).toBe(200);
      expect(update).toHaveBeenCalledTimes(outcome === "success" ? 1 : 2);
      expect(c.accepted).toHaveBeenCalledTimes(outcome === "success" ? 3 : 1);
    },
  );

  it("shares an expired pending API-key stamp while other keys continue independently", async () => {
    const pending = deferred();
    const update = vi
      .fn<Storage["keys"]["updateLastUsed"]>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(undefined);
    const c = credentialApp(update);
    const originalKey = (await c.validate("hash"))!;
    c.validate.mockClear();
    const first = c.request();
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1);
    });
    elapsed = WINDOW + 1;
    const second = c.request();
    await vi.waitFor(() => {
      expect(c.validate).toHaveBeenCalledTimes(2);
    });
    c.validate.mockResolvedValue({ ...originalKey, id: "other-key" });
    const other = await c.request("marfa_k1_other");
    const earlyAnswers = c.accepted.mock.calls.length;
    const pendingCalls = update.mock.calls.map((args) => args[0]);
    pending.resolve();
    const responses = await Promise.all([first, second]);
    expect(other.status).toBe(200);
    expect(earlyAnswers).toBe(1);
    expect(pendingCalls).toEqual(["key", "other-key"]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    c.validate.mockResolvedValue(originalKey);
    expect((await c.request()).status).toBe(200);
    expect(update).toHaveBeenCalledTimes(3);
  });

  it.each(["id", "grant key", "bearer"] as const)(
    "stamps OAuth by %s at zero and keeps its window independent of wall time",
    async (path) => {
      const c = credentialApp();
      const stamp = async () => {
        if (path === "id")
          await stampOAuthGrantLastUsed(c.storage, "connection");
        else if (path === "grant key")
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
      if (path !== "id") expect(c.findGrantItemId).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["id", "grant key"] as const)(
    "contains pending and failed OAuth writes by %s without repeated attempts inside the window",
    async (path) => {
      const c = credentialApp();
      const pending = deferred();
      c.updateLastUsedAt.mockReturnValueOnce(pending.promise);
      const stamp = () =>
        path === "id"
          ? stampOAuthGrantLastUsed(c.storage, "connection")
          : stampOAuthGrantLastUsedByGrantKey(c.storage, GRANT);
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
    },
  );

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

  it.each(["API key", "OAuth ID", "OAuth grant key"] as const)(
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
          stamp = () =>
            path === "OAuth ID"
              ? stampOAuthGrantLastUsed(storage, item.id)
              : stampOAuthGrantLastUsedByGrantKey(storage, GRANT);
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

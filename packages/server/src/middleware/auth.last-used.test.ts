import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as clock from "../clock.js";
import type { Storage } from "../storage/interface.js";
import type { AppEnv } from "./auth.js";
import {
  _clearOAuthLastUsedCacheForTesting,
  authMiddleware,
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

function credentialApp(updateLastUsed = vi.fn().mockResolvedValue(undefined)) {
  const updateLastUsedAt = vi.fn().mockResolvedValue(undefined);
  const findGrantItemId = vi.fn().mockResolvedValue("connection");
  const storage = {
    keys: {
      validate: vi.fn().mockResolvedValue({
        id: "key",
        label: "test",
        source: "test",
        default_tier: "library",
        type_permissions: {},
        extension_permissions: {},
        edge_permissions: {},
        metadata_permissions: {},
        created_at: "2026-01-01T00:00:00Z",
        last_used_at: null,
        key_hash: "hash",
        revoked_at: null,
      }),
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
  app.get("/", (c) => c.json({ authenticated: !!c.get("apiKey") }));
  app.onError((_error, c) => c.json({ error: "stamp failed" }, 500));
  const request = (token = "marfa_k1_test") =>
    app.request("/", {
      headers: { Authorization: `Bearer ${token}` },
    });
  return {
    storage,
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
    _clearOAuthLastUsedCacheForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _clearOAuthLastUsedCacheForTesting();
  });

  it("stamps an API key at monotonic zero and expires only at the elapsed boundary", async () => {
    const c = credentialApp();
    expect((await c.request()).status).toBe(200);
    expect(c.updateLastUsed).toHaveBeenCalledExactlyOnceWith("key");
    wall += WINDOW * 100;
    elapsed = WINDOW - 1;
    await c.request();
    expect(c.updateLastUsed).toHaveBeenCalledTimes(1);
    elapsed = WINDOW;
    await c.request();
    expect(c.updateLastUsed).toHaveBeenCalledTimes(2);
  });

  it("suppresses another API-key stamp while a write is pending and retries a failure", async () => {
    const pending = deferred();
    const update = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(undefined);
    const c = credentialApp(update);
    const first = c.request();
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1);
    });
    expect((await c.request()).status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    pending.reject(new Error("unavailable"));
    expect((await first).status).toBe(500);
    expect((await c.request()).status).toBe(200);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("does not clear a newer API-key window when an older pending write fails", async () => {
    const pending = deferred();
    const update = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(undefined);
    const c = credentialApp(update);
    const first = c.request();
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1);
    });
    elapsed = WINDOW;
    await c.request();
    expect(update).toHaveBeenCalledTimes(2);
    pending.reject(new Error("old attempt failed"));
    expect((await first).status).toBe(500);
    await c.request();
    expect(update).toHaveBeenCalledTimes(2);
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
    elapsed = WINDOW;
    await expect(
      stampOAuthGrantLastUsedByGrantKey(c.storage, GRANT),
    ).resolves.toBeUndefined();
    await stampOAuthGrantLastUsedByGrantKey(c.storage, GRANT);
    expect(c.findGrantItemId).toHaveBeenCalledTimes(2);
    elapsed += WINDOW;
    await stampOAuthGrantLastUsedByGrantKey(c.storage, GRANT);
    expect(c.updateLastUsedAt).toHaveBeenCalledExactlyOnceWith(
      "connection",
      WINDOW,
    );
  });
});

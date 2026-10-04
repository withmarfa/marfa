import { afterEach, describe, expect, it } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * `/health` as the app mounts it: the real probes against a real database,
 * and the credential resolved from the request.
 */

const contexts: TestContext[] = [];

async function newContext(): Promise<TestContext> {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop();
    if (ctx) await ctx.cleanup();
  }
});

interface Answer {
  status: string;
  components: Record<string, { status: string; error?: string }>;
}

describe("GET /health in the app", () => {
  it("commits a write and names four components, with no credential", async () => {
    const ctx = await newContext();

    const res = await request(ctx.app, "GET", "/health");
    const body = (await res.json()) as Answer;

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(Object.keys(body.components).sort()).toEqual([
      "blob_storage",
      "database",
      "database_write",
      "disk",
    ]);
    // The write the probe made is in the database, which is what separates
    // a probe that wrote from one that reported a write.
    expect(await ctx.storage.settings.get("health_probe")).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it("answers 503 with the database down, and tells only the operator key why", async () => {
    const ctx = await newContext();
    // Reads refuse; the key table, which resolving a caller reads, still
    // answers, as a database that fails on one table would.
    ctx.storage.keys.count = () =>
      Promise.reject(new Error("disk I/O error in /data/marfa.db"));

    const anonymous = await request(ctx.app, "GET", "/health");
    const asOperator = await request(ctx.app, "GET", "/health", {
      key: ctx.operatorKey,
    });
    const asWorking = await request(ctx.app, "GET", "/health", {
      key: ctx.workingKey,
    });
    const asNobody = await request(ctx.app, "GET", "/health", {
      key: "marfa_not-a-key-this-instance-holds",
    });

    for (const res of [anonymous, asOperator, asWorking, asNobody]) {
      expect(res.status).toBe(503);
    }
    const operatorSees = (await asOperator.json()) as Answer;
    expect(operatorSees.status).toBe("down");
    expect(operatorSees.components.database?.error).toContain("/data/marfa.db");
    for (const res of [anonymous, asWorking, asNobody]) {
      const body = (await res.json()) as Answer;
      expect(body.components.database?.status).toBe("down");
      expect(JSON.stringify(body)).not.toContain("marfa.db");
      expect(body.components.database).not.toHaveProperty("error");
    }
  });

  it("answers 503 when the key table cannot be read either, even to a request that names a key", async () => {
    const ctx = await newContext();
    ctx.storage.keys.count = () => Promise.reject(new Error("unreadable"));
    ctx.storage.keys.validate = () => Promise.reject(new Error("unreadable"));

    const res = await request(ctx.app, "GET", "/health", {
      key: ctx.operatorKey,
    });

    expect(res.status).toBe(503);
    expect(((await res.json()) as Answer).status).toBe("down");
  });

  it("tells the operator key why while every write is failing, as it is on a full disk", async () => {
    const ctx = await newContext();
    const full = () => Promise.reject(new Error("database or disk is full"));
    ctx.storage.settings.set = full;
    ctx.storage.keys.updateLastUsed = full;

    const res = await request(ctx.app, "GET", "/health", {
      key: ctx.operatorKey,
    });
    const body = (await res.json()) as Answer;

    expect(res.status).toBe(503);
    expect(body.components.database_write?.status).toBe("down");
    expect(body.components.database_write?.error).toContain("is full");
  });
});

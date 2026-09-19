/**
 * The operator surface for shipped types the build no longer carries.
 *
 * Drift is derived at boot, so these tests set it directly rather than
 * booting an instance against a doctored database. What that leaves
 * uncovered is one line at each dialect's warmup; the derivation itself is
 * tested against real storage in `storage/platform-drift.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { setPlatformDrift } from "../storage/platform-drift.js";

const contexts: TestContext[] = [];

async function newContext(): Promise<TestContext> {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}

afterEach(async () => {
  // Module state, so a test that leaves drift set would decide the next
  // one's answer.
  setPlatformDrift([]);
  while (contexts.length > 0) {
    const ctx = contexts.pop();
    if (ctx) await ctx.cleanup();
  }
});

/** Registers a platform row the build does not ship, and reports it drifted. */
async function seedDriftedType(ctx: TestContext): Promise<string> {
  const id = `core.retired_${Math.random().toString(36).slice(2, 8)}`;
  await ctx.storage.types.create(
    {
      id,
      version: 1,
      fields: { name: { type: "string", required: true } },
    },
    { origin: "platform", family: "core" },
  );
  setPlatformDrift([id]);
  return id;
}

describe("GET /admin/platform-types/drift", () => {
  it("refuses an unauthenticated caller", async () => {
    const ctx = await newContext();
    const res = await request(ctx.app, "GET", "/admin/platform-types/drift");
    expect(res.status).toBe(401);
  });

  it("lists the drifted rows with their live item counts", async () => {
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);

    const res = await request(ctx.app, "GET", "/admin/platform-types/drift", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      types: {
        id: string;
        item_count: number;
        child_types: string[];
        removable: boolean;
      }[];
    };
    expect(body.types).toEqual([
      { id, item_count: 0, child_types: [], removable: true },
    ]);
  });

  it("reports a row as not removable while items carry it", async () => {
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);
    await ctx.storage.items.create({
      type: id,
      properties: { name: "still here" },
      source: "test",
      source_id: "drift-1",
    });

    const res = await request(ctx.app, "GET", "/admin/platform-types/drift", {
      key: ctx.operatorKey,
    });
    const body = (await res.json()) as {
      types: { item_count: number; removable: boolean }[];
    };
    expect(body.types[0]?.item_count).toBe(1);
    expect(body.types[0]?.removable).toBe(false);
  });
});

describe("DELETE /admin/platform-types/{id}", () => {
  it("refuses an unauthenticated caller", async () => {
    const ctx = await newContext();
    const res = await request(
      ctx.app,
      "DELETE",
      "/admin/platform-types/core.anything",
    );
    expect(res.status).toBe(401);
  });

  it("binds `drift` as an identifier rather than reaching the listing", async () => {
    // The two doors share a prefix now that this one names no verb of its
    // own, so the listing's own path is a well-formed `{id}` under DELETE.
    // It binds the literal, and `drift` is not an identifier the build has
    // stopped shipping, so it is refused like any other — the sibling
    // cannot be addressed as something to remove. The listing keeps
    // answering its own verb.
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);

    const res = await request(
      ctx.app,
      "DELETE",
      "/admin/platform-types/drift",
      { key: ctx.operatorKey },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");

    const listed = await request(
      ctx.app,
      "GET",
      "/admin/platform-types/drift",
      {
        key: ctx.operatorKey,
      },
    );
    expect(listed.status).toBe(200);
    // The seeded row is the witness. An empty listing would satisfy the
    // status on its own, so the assertion below is what shows the GET was
    // still reaching its own handler rather than answering vacuously.
    const seen = (await listed.json()) as { types: { id: string }[] };
    expect(seen.types.map((t) => t.id)).toEqual([id]);
  });

  it("removes a drifted row", async () => {
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);

    const res = await request(
      ctx.app,
      "DELETE",
      `/admin/platform-types/${id}`,
      { key: ctx.operatorKey },
    );
    expect(res.status).toBe(200);

    const rows = await ctx.storage.types.loadAll();
    expect(rows.map((r) => r.schema.id)).not.toContain(id);
  });

  it("stops the type resolving on this process, not at the next boot", async () => {
    // The row is half of what makes a type resolve; the in-process registry
    // is the other half, and `deletePlatformType` used to leave it. So a
    // successful removal changed nothing a caller could see: `GET /types`
    // kept listing the identifier, `GET /types/{id}` kept answering 200, and
    // the operator was told the row was gone. The route's description
    // claimed the immediacy this asserts, and the storage layer did not
    // provide it.
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);

    // The control: it resolves before the removal, so the assertions after
    // it are about the removal rather than about a type that never listed.
    const before = await request(ctx.app, "GET", `/types/${id}`, {
      key: ctx.operatorKey,
    });
    expect(before.status).toBe(200);

    const removed = await request(
      ctx.app,
      "DELETE",
      `/admin/platform-types/${id}`,
      { key: ctx.operatorKey },
    );
    expect(removed.status).toBe(200);

    const after = await request(ctx.app, "GET", `/types/${id}`, {
      key: ctx.operatorKey,
    });
    expect(after.status).toBe(404);

    const listed = await request(ctx.app, "GET", "/types", {
      key: ctx.operatorKey,
    });
    expect(listed.status).toBe(200);
    const ids = ((await listed.json()) as { id: string }[]).map((t) => t.id);
    expect(ids).not.toContain(id);
  });

  it("refuses a type the build still ships", async () => {
    // The guard that matters most: a row exists for every shipped type
    // too, so testing existence alone would make this able to remove a
    // live one.
    const ctx = await newContext();
    setPlatformDrift([]);

    const res = await request(
      ctx.app,
      "DELETE",
      "/admin/platform-types/core.note",
      { key: ctx.operatorKey },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");

    // And it is still there.
    const rows = await ctx.storage.types.loadAll();
    expect(rows.map((r) => r.schema.id)).toContain("core.note");
  });

  it("declines while another type inherits from it", async () => {
    // The guard the item count cannot stand in for. An abstract parent
    // carries no items of its own, so it is the type most certain to
    // report zero and the one whose removal costs the most: every child
    // would resolve without the fields it inherits, silently, because
    // ancestor collection degrades to a partial view rather than failing.
    const ctx = await newContext();
    const parent = await seedDriftedType(ctx);
    const child = `${parent}.child`;
    await ctx.storage.types.create(
      {
        id: child,
        parent,
        version: 1,
        fields: { extra: { type: "string" } },
      },
      { origin: "platform", family: "core" },
    );

    const res = await request(
      ctx.app,
      "DELETE",
      `/admin/platform-types/${parent}`,
      { key: ctx.operatorKey },
    );
    expect(res.status).toBe(409);

    const rows = await ctx.storage.types.loadAll();
    expect(rows.map((r) => r.schema.id)).toContain(parent);
  });

  it("reports a parent as not removable in the listing", async () => {
    const ctx = await newContext();
    const parent = await seedDriftedType(ctx);
    const child = `${parent}.child`;
    await ctx.storage.types.create(
      {
        id: child,
        parent,
        version: 1,
        fields: { extra: { type: "string" } },
      },
      { origin: "platform", family: "core" },
    );

    const res = await request(ctx.app, "GET", "/admin/platform-types/drift", {
      key: ctx.operatorKey,
    });
    const body = (await res.json()) as {
      types: { id: string; child_types: string[]; removable: boolean }[];
    };
    const row = body.types.find((t) => t.id === parent);
    expect(row?.child_types).toEqual([child]);
    expect(row?.removable).toBe(false);
  });

  it("declines while items still carry the identifier", async () => {
    // Orphaning readable data to tidy a registry is the wrong trade: the
    // row is what makes those items resolve.
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);
    await ctx.storage.items.create({
      type: id,
      properties: { name: "still here" },
      source: "test",
      source_id: "drift-2",
    });

    const res = await request(
      ctx.app,
      "DELETE",
      `/admin/platform-types/${id}`,
      { key: ctx.operatorKey },
    );
    expect(res.status).toBe(409);

    const rows = await ctx.storage.types.loadAll();
    expect(rows.map((r) => r.schema.id)).toContain(id);
  });
});

describe("/health reports drift and does not degrade on it", () => {
  it("reports the count while the overall status stays ok", async () => {
    const ctx = await newContext();
    setPlatformDrift(["core.retired_health", "core.retired_second"]);

    const res = await request(ctx.app, "GET", "/health");
    const body = (await res.json()) as {
      status: string;
      components: Record<string, { status: string; count?: number }>;
      platform_types: { drifted: number };
    };

    // Asserted before the status claim, so a fixture that stopped
    // producing drift fails here rather than passing vacuously: an `ok`
    // status on an instance carrying no drift proves nothing.
    expect(body.platform_types).toEqual({ drifted: 2 });

    expect(body.status).toBe("ok");
    // Not a component. A status is the thing this removed, so the entry
    // has to be absent rather than reporting a constant `ok` that a
    // consumer could still key on.
    expect(body.components.platform_types).toBeUndefined();
    // The identifiers are not here: this endpoint is unauthenticated.
    expect(JSON.stringify(body)).not.toContain("core.retired_health");
    expect(JSON.stringify(body)).not.toContain("core.retired_second");
  });

  it("reports zero when there is no drift", async () => {
    const ctx = await newContext();
    setPlatformDrift([]);
    const res = await request(ctx.app, "GET", "/health");
    const body = (await res.json()) as {
      status: string;
      components: Record<string, { status: string; count?: number }>;
      platform_types: { drifted: number };
    };
    expect(body.platform_types).toEqual({ drifted: 0 });
    expect(body.components.platform_types).toBeUndefined();
    expect(body.status).toBe("ok");
  });
});

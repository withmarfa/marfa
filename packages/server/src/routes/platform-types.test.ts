/**
 * The operator surface for shipped types the build no longer carries.
 *
 * Drift is derived at boot, so these tests set it directly rather than
 * booting an instance against a doctored database. What that leaves
 * uncovered is one line at warmup; the derivation itself is
 * tested against real storage in `storage/platform-drift.test.ts`.
 */
import { itemWrites } from "../storage/item-writes.js";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { setPlatformDrift } from "../storage/platform-drift.js";
import { sqliteRequestContext } from "../storage/sqlite/request-context.js";

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
    { origin: "platform" },
  );
  setPlatformDrift([id]);
  return id;
}

describe("GET /platform-types/drift", () => {
  it("refuses an unauthenticated caller", async () => {
    const ctx = await newContext();
    const res = await request(ctx.app, "GET", "/platform-types/drift");
    expect(res.status).toBe(401);
  });

  it("lists the drifted rows with their live item counts", async () => {
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);

    const res = await request(ctx.app, "GET", "/platform-types/drift", {
      key: ctx.managementKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        id: string;
        item_count: number;
        child_types: string[];
        removable: boolean;
      }[];
    };
    expect(body.data).toEqual([
      { id, item_count: 0, child_types: [], removable: true },
    ]);
  });

  it("reports a row as not removable while items carry it", async () => {
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);
    await itemWrites(ctx.storage).create({
      type: id,
      properties: { name: "still here" },
      source: "test",
      source_id: "drift-1",
    });

    const res = await request(ctx.app, "GET", "/platform-types/drift", {
      key: ctx.managementKey,
    });
    const body = (await res.json()) as {
      data: { item_count: number; removable: boolean }[];
    };
    expect(body.data[0]?.item_count).toBe(1);
    expect(body.data[0]?.removable).toBe(false);
  });
});

describe("DELETE /platform-types/{id}", () => {
  it("refuses an unauthenticated caller", async () => {
    const ctx = await newContext();
    const res = await request(
      ctx.app,
      "DELETE",
      "/platform-types/core.anything",
    );
    expect(res.status).toBe(401);
  });

  it("binds `drift` as an identifier rather than reaching the listing", async () => {
    // The two doors share a prefix and this one names no verb of its own,
    // so the listing's own path is a well-formed `{id}` under DELETE.
    // It binds the literal, and no platform row carries `drift`, so it is
    // refused as an identifier that is not there — the sibling cannot be
    // addressed as something to remove. The listing keeps answering its
    // own verb.
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);

    const res = await request(ctx.app, "DELETE", "/platform-types/drift", {
      key: ctx.managementKey,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("type_not_found");

    const listed = await request(ctx.app, "GET", "/platform-types/drift", {
      key: ctx.managementKey,
    });
    expect(listed.status).toBe(200);
    // The seeded row is the witness. An empty listing would satisfy the
    // status on its own, so the assertion below is what shows the GET was
    // still reaching its own handler rather than answering vacuously.
    const seen = (await listed.json()) as { data: { id: string }[] };
    expect(seen.data.map((t) => t.id)).toEqual([id]);
  });

  it("removes a drifted row", async () => {
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);

    const res = await request(ctx.app, "DELETE", `/platform-types/${id}`, {
      key: ctx.managementKey,
    });
    expect(res.status).toBe(200);

    const rows = await ctx.storage.types.loadAll();
    expect(rows.map((r) => r.schema.id)).not.toContain(id);
  });

  it("stops the type resolving on this process, not at the next boot", async () => {
    // The row is half of what makes a type resolve; the in-process registry
    // is the other half. A removal that left the registry would change
    // nothing a caller could see: `GET /types` would keep listing the
    // identifier, `GET /types/{id}` would keep answering 200, and the
    // operator would be told the row was gone. The route's description
    // claims the immediacy this asserts.
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);

    // The control: it resolves before the removal, so the assertions after
    // it are about the removal rather than about a type that never listed.
    const before = await request(ctx.app, "GET", `/types/${id}`, {
      key: ctx.managementKey,
    });
    expect(before.status).toBe(200);

    const removed = await request(ctx.app, "DELETE", `/platform-types/${id}`, {
      key: ctx.managementKey,
    });
    expect(removed.status).toBe(200);

    const after = await request(ctx.app, "GET", `/types/${id}`, {
      key: ctx.managementKey,
    });
    expect(after.status).toBe(404);

    const listed = await request(ctx.app, "GET", "/types", {
      key: ctx.managementKey,
    });
    expect(listed.status).toBe(200);
    const ids = ((await listed.json()) as { data: { id: string }[] }).data.map(
      (t) => t.id,
    );
    expect(ids).not.toContain(id);
  });

  it("drops the removed type from the drift list and refuses a second removal", async () => {
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);
    const other = `${id}_kept`;
    await ctx.storage.types.create(
      { id: other, version: 1, fields: { name: { type: "string" } } },
      { origin: "platform" },
    );
    setPlatformDrift([id, other]);

    const listedIds = async (): Promise<string[]> => {
      const res = await request(ctx.app, "GET", "/platform-types/drift", {
        key: ctx.managementKey,
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { id: string }[] }).data.map(
        (t) => t.id,
      );
    };
    // The witness: both are listed before the removal, so the absence
    // after it is the removal's doing.
    expect(await listedIds()).toEqual([id, other].sort());

    const removed = await request(ctx.app, "DELETE", `/platform-types/${id}`, {
      key: ctx.managementKey,
    });
    expect(removed.status).toBe(200);

    expect(await listedIds()).toEqual([other]);

    const again = await request(ctx.app, "DELETE", `/platform-types/${id}`, {
      key: ctx.managementKey,
    });
    expect(again.status).toBe(404);
    const body = (await again.json()) as { error: { code: string } };
    expect(body.error.code).toBe("type_not_found");
  });

  it("keeps a type listed when its removal is refused", async () => {
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);
    await itemWrites(ctx.storage).create({
      type: id,
      properties: { name: "still here" },
      source: "test",
      source_id: "drift-refused",
    });

    const res = await request(ctx.app, "DELETE", `/platform-types/${id}`, {
      key: ctx.managementKey,
    });
    expect(res.status).toBe(409);

    const listed = await request(ctx.app, "GET", "/platform-types/drift", {
      key: ctx.managementKey,
    });
    const seen = (await listed.json()) as { data: { id: string }[] };
    expect(seen.data.map((t) => t.id)).toEqual([id]);
  });

  it("refuses a type the build still ships", async () => {
    // The guard that matters most: a row exists for every shipped type
    // too, so testing existence alone would make this able to remove a
    // live one.
    const ctx = await newContext();
    setPlatformDrift([]);

    const res = await request(ctx.app, "DELETE", "/platform-types/core.note", {
      key: ctx.managementKey,
    });
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
      { origin: "platform" },
    );

    const res = await request(ctx.app, "DELETE", `/platform-types/${parent}`, {
      key: ctx.managementKey,
    });
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
      { origin: "platform" },
    );

    const res = await request(ctx.app, "GET", "/platform-types/drift", {
      key: ctx.managementKey,
    });
    const body = (await res.json()) as {
      data: { id: string; child_types: string[]; removable: boolean }[];
    };
    const row = body.data.find((t) => t.id === parent);
    expect(row?.child_types).toEqual([child]);
    expect(row?.removable).toBe(false);
  });

  it("declines while items still carry the identifier", async () => {
    // Orphaning readable data to tidy a registry is the wrong trade: the
    // row is what makes those items resolve.
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);
    await itemWrites(ctx.storage).create({
      type: id,
      properties: { name: "still here" },
      source: "test",
      source_id: "drift-2",
    });

    const res = await request(ctx.app, "DELETE", `/platform-types/${id}`, {
      key: ctx.managementKey,
    });
    expect(res.status).toBe(409);

    const rows = await ctx.storage.types.loadAll();
    expect(rows.map((r) => r.schema.id)).toContain(id);
  });
});

describe("DELETE /platform-types/{id} decides in one transaction", () => {
  it("never leaves an item written during the removal without its type", async () => {
    // An item of the type written after the count and before the delete
    // must either be counted, so the removal is refused, or be refused
    // itself once the type is gone. Never both written.
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);
    const items = itemWrites(ctx.storage);
    const count = items.countByType.bind(items);
    let creating: Promise<unknown> | undefined;
    items.countByType = async (type: string) => {
      const counted = await count(type);
      // As another request: outside this one's transaction.
      creating ??= sqliteRequestContext
        .exit(() =>
          items.create({
            type: id,
            properties: { name: "written mid-removal" },
            source: "test",
            source_id: "drift-race",
          }),
        )
        .then(
          () => "created",
          (err: unknown) => err,
        );
      // Long enough for the write to land when nothing holds it back.
      await Promise.race([
        creating,
        new Promise((resolve) => setTimeout(resolve, 200)),
      ]);
      return counted;
    };

    const res = await request(ctx.app, "DELETE", `/platform-types/${id}`, {
      key: ctx.managementKey,
    });
    const created = await creating;
    items.countByType = count;

    const rows = await ctx.storage.types.loadAll();
    const registered = rows.some((row) => row.schema.id === id);
    const carried = await count(id);
    if (res.status === 200) {
      expect(created).not.toBe("created");
      expect(registered).toBe(false);
      expect(carried).toBe(0);
    } else {
      expect(res.status).toBe(409);
      expect(created).toBe("created");
      expect(registered).toBe(true);
    }
  });

  it("names the key that removed the type in its audit row", async () => {
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);
    const res = await request(ctx.app, "DELETE", `/platform-types/${id}`, {
      key: ctx.managementKey,
    });
    expect(res.status).toBe(200);
    const manager = (await ctx.storage.keys.list()).find((key) =>
      key.permissions.includes("instance.maintain"),
    );
    expect(manager).toBeDefined();
    const audit = await ctx.storage.audit.list({
      action: "platform_type.removed",
      resource_id: id,
    });
    expect(audit.data).toHaveLength(1);
    expect(audit.data[0]?.key_id).toBe(manager?.id);
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
    // Not a component. Drift carries no status, so the entry has to be
    // absent rather than reporting a constant `ok` that a consumer could
    // key on.
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

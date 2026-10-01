import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, request, settle } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const RUN = Math.random().toString(36).slice(2, 8);

type Method = (...args: unknown[]) => Promise<unknown>;

/**
 * Holds one call of a store method, before it runs or once it has answered,
 * so a second request can be sent while the first stands at that point.
 * `reached` settles when the call gets there; `release` lets it go on.
 */
function holdCall(
  target: object,
  method: string,
  when: "before" | "after",
): { reached: Promise<void>; release: () => void } {
  let arrive = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const methods = target as Record<string, Method>;
  const original = methods[method];
  if (!original) throw new Error(`no method ${method}`);
  methods[method] = async (...args: unknown[]) => {
    methods[method] = original;
    if (when === "before") {
      arrive();
      await gate;
      return await original.apply(target, args);
    }
    const answer = await original.apply(target, args);
    arrive();
    await gate;
    return answer;
  };
  return { reached, release };
}

async function registerType(id: string, parent?: string): Promise<void> {
  const res = await request(ctx.app, "POST", "/types", {
    key: ctx.workingKey,
    body: {
      id,
      version: 1,
      ...(parent !== undefined && { parent }),
      fields: { name: { type: "string" } },
    },
  });
  expect(res.status, await res.clone().text()).toBe(201);
}

async function readType(
  id: string,
): Promise<{ status: number; parent?: string }> {
  const res = await request(ctx.app, "GET", `/types/${id}`, {
    key: ctx.workingKey,
  });
  if (res.status !== 200) return { status: res.status };
  const body = (await res.json()) as { parent?: string };
  return { status: 200, parent: body.parent };
}

async function aNote(): Promise<{ id: string; version: number }> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { title: "t", body: "b" } },
  });
  expect(res.status).toBe(201);
  const { item } = (await res.json()) as {
    item: { id: string; version: number };
  };
  return item;
}

async function typeOf(id: string): Promise<string> {
  const res = await request(ctx.app, "GET", `/items/${id}`, {
    key: ctx.workingKey,
  });
  return ((await res.json()) as { item: { type: string } }).item.type;
}

describe("PATCH /items/{id} — a retype enters only a registered type", () => {
  it("refuses a destination nothing registered, as a create does, and moves nothing", async () => {
    const note = await aNote();
    const res = await request(ctx.app, "PATCH", `/items/${note.id}`, {
      key: ctx.workingKey,
      body: {
        retype: true,
        type: `acme.never_registered_${RUN}`,
        version: note.version,
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { type?: string } };
    };
    expect(body.error.code).toBe("unknown_type");
    expect(body.error.details?.type).toBe(`acme.never_registered_${RUN}`);
    expect(await typeOf(note.id)).toBe("core.note");
  });

  it("refuses a destination deleted while the move waited for the lock", async () => {
    const destination = `acme.retype_dest_${RUN}`;
    await registerType(destination);
    const note = await aNote();

    const hold = holdCall(ctx.storage.items, "list", "after");
    const deleting = request(ctx.app, "DELETE", `/types/${destination}`, {
      key: ctx.workingKey,
    });
    await hold.reached;
    const moving = request(ctx.app, "PATCH", `/items/${note.id}`, {
      key: ctx.workingKey,
      body: { retype: true, type: destination, version: note.version },
    });
    await settle(100);
    hold.release();

    const [deleted, moved] = await Promise.all([deleting, moving]);
    expect(deleted.status).toBe(200);
    expect(moved.status).toBe(400);
    expect(
      ((await moved.json()) as { error: { code: string } }).error.code,
    ).toBe("unknown_type");
    expect(await typeOf(note.id)).toBe("core.note");
  });
});

describe("POST /types and PUT /types/{id} — a parent is checked where the type is written", () => {
  it("refuses a child whose parent is deleted while the registration waits", async () => {
    const parent = `acme.ref_parent_a_${RUN}`;
    const child = `acme.ref_child_a_${RUN}`;
    await registerType(parent);

    const hold = holdCall(ctx.storage.items, "list", "after");
    const deleting = request(ctx.app, "DELETE", `/types/${parent}`, {
      key: ctx.workingKey,
    });
    await hold.reached;
    const registering = request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: { id: child, version: 1, parent, fields: {} },
    });
    await settle(100);
    hold.release();

    const [deleted, registered] = await Promise.all([deleting, registering]);
    expect(deleted.status).toBe(200);
    expect(registered.status).toBe(400);
    expect((await readType(child)).status).toBe(404);
  });

  it("refuses the parent's delete when the child's registration has checked and not yet written", async () => {
    const parent = `acme.ref_parent_b_${RUN}`;
    const child = `acme.ref_child_b_${RUN}`;
    await registerType(parent);

    const hold = holdCall(ctx.storage.types, "create", "before");
    const registering = request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: { id: child, version: 1, parent, fields: {} },
    });
    await hold.reached;
    const deleting = request(ctx.app, "DELETE", `/types/${parent}`, {
      key: ctx.workingKey,
    });
    await settle(100);
    hold.release();

    const [registered, deleted] = await Promise.all([registering, deleting]);
    expect(registered.status).toBe(201);
    expect(deleted.status).toBe(409);
    expect(
      ((await deleted.json()) as { error: { code: string } }).error.code,
    ).toBe("type_has_subtypes");
    expect((await readType(parent)).status).toBe(200);
  });

  it("refuses a re-parent onto a type deleted while the update waits", async () => {
    const parent = `acme.ref_parent_c_${RUN}`;
    const child = `acme.ref_child_c_${RUN}`;
    await registerType(parent);
    await registerType(child);

    const hold = holdCall(ctx.storage.items, "list", "after");
    const deleting = request(ctx.app, "DELETE", `/types/${parent}`, {
      key: ctx.workingKey,
    });
    await hold.reached;
    const reparenting = request(ctx.app, "PUT", `/types/${child}`, {
      key: ctx.workingKey,
      body: { version: 1, parent, fields: { name: { type: "string" } } },
    });
    await settle(100);
    hold.release();

    const [deleted, reparented] = await Promise.all([deleting, reparenting]);
    expect(deleted.status).toBe(200);
    expect(reparented.status).toBe(400);
    expect((await readType(child)).parent).toBeUndefined();
  });

  it("lets only one of two re-parents in flight close a loop", async () => {
    const a = `acme.ref_loop_a_${RUN}`;
    const b = `acme.ref_loop_b_${RUN}`;
    await registerType(a);
    await registerType(b);

    const hold = holdCall(ctx.storage.types, "update", "before");
    const first = request(ctx.app, "PUT", `/types/${a}`, {
      key: ctx.workingKey,
      body: { version: 1, parent: b, fields: {} },
    });
    await hold.reached;
    const second = request(ctx.app, "PUT", `/types/${b}`, {
      key: ctx.workingKey,
      body: { version: 1, parent: a, fields: {} },
    });
    await settle(100);
    hold.release();

    const statuses = (await Promise.all([first, second]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([200, 400]);
  });
});

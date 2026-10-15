/**
 * Every door that creates an item refuses a body key it does not declare,
 * for a key and for an app the owner signed in alike, and creates nothing.
 *
 * A misnamed field stripped in silence is a request half performed and
 * answered as success: `data` sent where the door takes `properties` creates
 * an empty item. Keys inside `properties` are the type's, not the door's, so
 * a property no schema names still lands.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, request, seedOauthBearer } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let appToken = "";

beforeAll(async () => {
  ctx = await createTestContext();
  ({ token: appToken } = await seedOauthBearer(ctx, [
    "core.note:write",
    "core.bookmark:write",
  ]));
});

afterAll(async () => {
  await ctx.cleanup();
});

type Caller = "key" | "app";

function send(caller: Caller, path: string, body: unknown): Promise<Response> {
  return request(ctx.app, "POST", path, {
    key: caller === "key" ? ctx.workingKey : appToken,
    body,
  });
}

/** The ids of the items carrying `tag`, read as the working key. */
async function tagged(tag: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", `/items?tags=${tag}&state=any`, {
    key: ctx.workingKey,
  });
  expect(res.status, "the listing that proves what was created failed").toBe(
    200,
  );
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((row) => row.id);
}

let n = 0;
function marker(): string {
  n += 1;
  return `undeclared${Math.random().toString(36).slice(2, 8)}${String(n)}`;
}

interface Refusal {
  error: {
    code: string;
    details?: { errors?: { path: string; message: string }[] };
  };
}

/** The refusal names each key, so a caller can see which field it got wrong. */
async function expectRefusedNaming(
  res: Response,
  keys: string[],
  path = "",
): Promise<void> {
  const body = (await res.json()) as Refusal;
  expect(res.status, JSON.stringify(body)).toBe(400);
  expect(body.error.code).toBe("validation_error");
  const at = body.error.details?.errors?.find((e) => e.path === path);
  expect(at, JSON.stringify(body)).toBeDefined();
  for (const key of keys) expect(at?.message).toContain(`"${key}"`);
}

describe.each<Caller>(["key", "app"])("as the %s", (caller) => {
  it("POST /items refuses `data` and creates nothing, where `properties` creates the item", async () => {
    const tag = marker();
    const refused = await send(caller, "/items", {
      type: "core.bookmark",
      data: { title: "Marfa", url: "https://example.com/" },
      tags: [tag],
    });
    await expectRefusedNaming(refused, ["data"]);
    expect(await tagged(tag)).toEqual([]);

    // The witness: the same body with the field the door declares is
    // created and listed, so the empty listing above is the refusal.
    const created = await send(caller, "/items", {
      type: "core.bookmark",
      properties: { title: "Marfa", url: "https://example.com/" },
      tags: [tag],
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { item } = (await created.json()) as {
      item: { id: string; properties: Record<string, unknown> };
    };
    expect(item.properties).toMatchObject({ title: "Marfa" });
    expect(await tagged(tag)).toEqual([item.id]);
  });

  it("POST /items names every undeclared key in one refusal, and not a declared one", async () => {
    const tag = marker();
    const refused = await send(caller, "/items", {
      type: "core.note",
      properties: { body: "two wrong keys" },
      data: {},
      device: "laptop",
      tags: [tag],
    });
    const body = (await refused.clone().json()) as Refusal;
    await expectRefusedNaming(refused, ["data", "device"]);
    expect(JSON.stringify(body.error.details)).not.toContain('"tags"');
    expect(await tagged(tag)).toEqual([]);
  });

  it("POST /items/bulk under `atomic` rolls the page back on an entry's undeclared key", async () => {
    const tag = marker();
    const refused = await send(caller, "/items/bulk", {
      items: [
        { type: "core.note", properties: { body: "fine" }, tags: [tag] },
        {
          type: "core.note",
          properties: { body: "misnamed" },
          data: { body: "misnamed" },
          tags: [tag],
        },
      ],
    });
    const body = (await refused.json()) as {
      error: {
        code: string;
        details: {
          index: number;
          code: string;
          details: { errors: { path: string; message: string }[] };
        };
      };
    };
    expect(refused.status, JSON.stringify(body)).toBe(400);
    expect(body.error.code).toBe("bulk_atomic_rollback");
    expect(body.error.details.index).toBe(1);
    expect(body.error.details.code).toBe("validation_error");
    expect(body.error.details.details.errors[0]?.message).toContain('"data"');
    expect(await tagged(tag)).toEqual([]);
  });

  it("POST /items/bulk without `atomic` errors the entry with an undeclared key and writes the others", async () => {
    const tag = marker();
    const answered = await send(caller, "/items/bulk", {
      atomic: false,
      items: [
        { type: "core.note", properties: { body: "fine" }, tags: [tag] },
        {
          type: "core.note",
          properties: { body: "misnamed" },
          capture_latitude: 1,
          device: "laptop",
          tags: [tag],
        },
      ],
    });
    const body = (await answered.json()) as {
      results: {
        outcome: string;
        id?: string;
        error?: {
          code: string;
          details: { errors: { path: string; message: string }[] };
        };
      }[];
    };
    expect(answered.status, JSON.stringify(body)).toBe(200);
    const [kept, refused] = body.results;
    expect(kept?.outcome).toBe("created");
    expect(refused?.outcome).toBe("errored");
    expect(refused?.error?.code).toBe("validation_error");
    const message = refused?.error?.details.errors[0]?.message;
    expect(message).toContain('"capture_latitude"');
    expect(message).toContain('"device"');
    expect(await tagged(tag)).toEqual([kept?.id]);
  });

  it("POST /items/bulk refuses an undeclared envelope key and writes nothing", async () => {
    const tag = marker();
    const refused = await send(caller, "/items/bulk", {
      atomc: false,
      items: [{ type: "core.note", properties: { body: "x" }, tags: [tag] }],
    });
    await expectRefusedNaming(refused, ["atomc"]);
    expect(await tagged(tag)).toEqual([]);
  });
});

it("keys inside `properties` are the type's, not the door's", async () => {
  const tag = marker();
  const created = await send("key", "/items", {
    type: "core.note",
    properties: { body: "kept", data: "a property no schema names" },
    tags: [tag],
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const { item } = (await created.json()) as {
    item: { properties: Record<string, unknown> };
  };
  expect(item.properties.data).toBe("a property no schema names");
});

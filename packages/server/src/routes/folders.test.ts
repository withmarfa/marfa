import type { Item, TypePermission } from "@withmarfa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import {
  collectItemEvents,
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
  settle,
} from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface ErrorBody {
  error: { code: string; details?: { errors?: { path: string }[] } };
  conflicting_fields?: string[];
}

async function body<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function create(
  settings: Record<string, unknown>,
  key = ctx.workingKey,
): Promise<Response> {
  return await request(ctx.app, "POST", "/folders", { key, body: settings });
}

async function createFolder(settings: Record<string, unknown>): Promise<Item> {
  const res = await create(settings);
  expect(res.status).toBe(201);
  return (await body<{ item: Item }>(res)).item;
}

describe("POST /folders", () => {
  it("creates a system.folder and publishes it", async () => {
    const abort = new AbortController();
    const seen = collectItemEvents(abort.signal);
    await settle();
    const folder = await createFolder({
      title: "Project",
      search: { types: ["core.note"], state: ["active"] },
      include: ["*.md"],
    });
    await settle();
    abort.abort();
    await seen.done;
    expect(folder).toMatchObject({
      type: "system.folder",
      state: "active",
      version: 1,
      properties: {
        title: "Project",
        search: { types: ["core.note"], state: ["active"] },
        include: ["*.md"],
      },
    });
    expect(
      seen.events.some((e) => e.type === "created" && e.item.id === folder.id),
    ).toBe(true);
  });

  it("gates on write to system.folder in the type map", async () => {
    const settings = { title: "Gated" };
    const exact = await mintWorkingKey(ctx, {
      type_permissions: { "system.folder": "write" },
    });
    expect((await create(settings, exact)).status).toBe(201);
    const refused: Record<string, TypePermission>[] = [
      { "core.note": "write" },
      { "system.folder": "read" },
      { "*": "write", "system.folder": "read" },
    ];
    for (const type_permissions of refused) {
      const key = await mintWorkingKey(ctx, { type_permissions });
      const res = await create(settings, key);
      expect(res.status, JSON.stringify(type_permissions)).toBe(403);
      expect((await body<ErrorBody>(res)).error.code).toBe(
        "type_not_permitted",
      );
    }
    expect((await create(settings, ctx.managementKey)).status).toBe(403);
  });

  it.each([
    [{ search: { types: ["core.nope"] } }, "unknown_type", "search.types.0"],
    [{ search: { types: ["Bad Type"] } }, "validation_error", "search.types.0"],
    [{ search: { filter: "tags eq" } }, "validation_error", "search.filter"],
    [
      { search: { beneath: "not an id" } },
      "validation_error",
      "search.beneath",
    ],
    [{ search: { state: ["trashed"] } }, "validation_error", "search.state.0"],
    [{ search: { owner: "x" } }, "validation_error", "search"],
    [{ defaults: { type: "core.nope" } }, "unknown_type", "defaults.type"],
    [
      { defaults: { edges: { "no-such-edge": [] } } },
      "validation_error",
      "defaults.edges.no-such-edge",
    ],
    [
      { defaults: { edges: { "parent-of": ["x y"] } } },
      "validation_error",
      "defaults.edges.parent-of",
    ],
    [{ include: [7] }, "validation_error", "include.0"],
    [{ ignore: [""] }, "validation_error", "ignore.0"],
    [
      { first_placement: { "core.note": "../out" } },
      "validation_error",
      "first_placement.core.note",
    ],
    [
      { first_placement: { "core.note": "/abs" } },
      "validation_error",
      "first_placement.core.note",
    ],
    [
      { first_placement: { "core.note": "C:/out" } },
      "validation_error",
      "first_placement.core.note",
    ],
    [
      { first_placement: { "core.note": "Notes\\..\\..\\out" } },
      "validation_error",
      "first_placement.core.note",
    ],
    [
      { first_placement: { "core.note": "Notes\0" } },
      "validation_error",
      "first_placement.core.note",
    ],
    [
      { search: { types: ["system.folder"] } },
      "validation_error",
      "search.types.0",
    ],
    [
      { defaults: { type: "system.folder" } },
      "validation_error",
      "defaults.type",
    ],
    [
      { first_placement: { "system.folder": "Folders" } },
      "validation_error",
      "first_placement.system.folder",
    ],
    [
      { defaults: { edges: { "in-folder": [] } } },
      "validation_error",
      "defaults.edges.in-folder",
    ],

    [
      { first_placement: { "core.nope": "Notes" } },
      "unknown_type",
      "first_placement.core.nope",
    ],
    [
      { removal_threshold: { fraction: 2 } },
      "validation_error",
      "removal_threshold.fraction",
    ],
  ])(
    "refuses %j with %s naming %s, on a create and on a change",
    async (settings, code, path) => {
      const folder = await createFolder({ title: "Target" });
      for (const res of [
        await create({ title: "Bad", ...settings }),
        await request(ctx.app, "PATCH", `/folders/${folder.id}`, {
          key: ctx.workingKey,
          body: { version: 1, ...settings },
        }),
      ]) {
        expect(res.status).toBe(400);
        const refusal = await body<ErrorBody>(res);
        expect(refusal.error.code).toBe(code);
        expect(refusal.error.details?.errors?.[0]?.path).toBe(path);
      }
    },
  );

  it("caps defaults.edges at 100 edge types and 100 targets each, on a create and on a change", async () => {
    const target = "01920000-0000-7000-8000-000000000000";
    const folder = await createFolder({ title: "Capped" });
    const cases: [Record<string, string[]>, string][] = [
      [
        Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [`edge-${String(i)}`, []]),
        ),
        "defaults.edges",
      ],
      [
        { "parent-of": Array.from({ length: 101 }, () => target) },
        "defaults.edges.parent-of",
      ],
    ];
    for (const [edges, path] of cases) {
      for (const res of [
        await create({ title: "Bad", defaults: { edges } }),
        await request(ctx.app, "PATCH", `/folders/${folder.id}`, {
          key: ctx.workingKey,
          body: { version: 1, defaults: { edges } },
        }),
      ]) {
        expect(res.status).toBe(400);
        const refusal = await body<ErrorBody>(res);
        expect(refusal.error.code).toBe("validation_error");
        expect(refusal.error.details?.errors?.[0]?.path).toBe(path);
      }
    }
  });

  it("takes a placement that climbs and comes back inside, on a create and on a change", async () => {
    const settings = {
      first_placement: { "core.note": "Notes/../Tickets/./Open" },
      search: {
        types: ["core.note"],
        filter: 'tags contains "project"',
        beneath: "01920000-0000-7000-8000-000000000000",
      },
      defaults: {
        type: "core.note",
        edges: {
          "parent-of": Array.from(
            { length: 100 },
            () => "01920000-0000-7000-8000-000000000000",
          ),
        },
      },
    };
    const folder = await createFolder({ title: "Placement", ...settings });
    const changed = await request(ctx.app, "PATCH", `/folders/${folder.id}`, {
      key: ctx.workingKey,
      body: { version: 1, ...settings },
    });
    expect(changed.status).toBe(200);
  });
});

describe("PATCH /folders/{id}", () => {
  it("changes at the current version, merges a stale change to another setting, and refuses one to the same", async () => {
    const folder = await createFolder({ title: "Versions", include: ["a"] });
    const first = await request(ctx.app, "PATCH", `/folders/${folder.id}`, {
      key: ctx.workingKey,
      body: { version: 1, include: ["b"] },
    });
    expect(first.status).toBe(200);
    expect((await body<{ item: Item }>(first)).item.version).toBe(2);

    const merged = await request(ctx.app, "PATCH", `/folders/${folder.id}`, {
      key: ctx.workingKey,
      body: { version: 1, ignore: ["c"] },
    });
    expect(merged.status).toBe(200);
    expect((await body<{ item: Item }>(merged)).item.properties).toMatchObject({
      include: ["b"],
      ignore: ["c"],
    });

    const stale = await request(ctx.app, "PATCH", `/folders/${folder.id}`, {
      key: ctx.workingKey,
      body: { version: 1, include: ["d"] },
    });
    expect(stale.status).toBe(409);
    const conflict = await body<ErrorBody>(stale);
    expect(conflict.error.code).toBe("version_conflict");
    expect(conflict.conflicting_fields).toEqual(["include"]);
  });

  it("refuses a null for a setting, which is reset by its empty value", async () => {
    const folder = await createFolder({ title: "Reset", ignore: ["x"] });
    const nulled = await request(ctx.app, "PATCH", `/folders/${folder.id}`, {
      key: ctx.workingKey,
      body: { version: 1, ignore: null },
    });
    expect(nulled.status).toBe(400);
    const res = await request(ctx.app, "PATCH", `/folders/${folder.id}`, {
      key: ctx.workingKey,
      body: { version: 1, ignore: [] },
    });
    expect(res.status).toBe(200);
    expect((await body<{ item: Item }>(res)).item.properties.ignore).toEqual(
      [],
    );
  });

  it("requires a version and at least one setting", async () => {
    const folder = await createFolder({ title: "Required" });
    const noVersion = await request(ctx.app, "PATCH", `/folders/${folder.id}`, {
      key: ctx.workingKey,
      body: { title: "x" },
    });
    expect(noVersion.status).toBe(400);
    expect((await body<ErrorBody>(noVersion)).error.code).toBe(
      "missing_required_field",
    );
    const nothing = await request(ctx.app, "PATCH", `/folders/${folder.id}`, {
      key: ctx.workingKey,
      body: { version: 1 },
    });
    expect(nothing.status).toBe(400);
  });

  it("answers 404 for an id that is not a folder", async () => {
    const note = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "not a folder" } },
    });
    const noteId = (await body<{ item: Item }>(note)).item.id;
    const res = await request(ctx.app, "PATCH", `/folders/${noteId}`, {
      key: ctx.workingKey,
      body: { version: 1, title: "x" },
    });
    expect(res.status).toBe(404);
    expect((await body<ErrorBody>(res)).error.code).toBe("item_not_found");
  });
});

describe("POST /folders/{id}/revoke", () => {
  it("revokes once, stamps revoked_at, and freezes the settings", async () => {
    const folder = await createFolder({ title: "Retired" });
    const res = await request(ctx.app, "POST", `/folders/${folder.id}/revoke`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const revoked = (await body<{ item: Item }>(res)).item;
    expect(revoked.state).toBe("revoked");
    expect(typeof revoked.properties.revoked_at).toBe("string");

    const again = await request(
      ctx.app,
      "POST",
      `/folders/${folder.id}/revoke`,
      { key: ctx.workingKey },
    );
    expect(again.status).toBe(400);
    expect((await body<ErrorBody>(again)).error.code).toBe(
      "invalid_transition",
    );
    const change = await request(ctx.app, "PATCH", `/folders/${folder.id}`, {
      key: ctx.workingKey,
      body: { version: revoked.version, title: "back" },
    });
    expect(change.status).toBe(400);
    expect((await body<ErrorBody>(change)).error.code).toBe(
      "invalid_transition",
    );
  });
});

describe("the item doors", () => {
  it("refuse a system.folder write from a key the folder door admits", async () => {
    const folder = await createFolder({ title: "Item doors" });
    const doors: [string, string, Record<string, unknown> | undefined][] = [
      ["POST", "/items", { type: "system.folder", properties: { title: "x" } }],
      [
        "PATCH",
        `/items/${folder.id}`,
        { version: 1, properties: { title: "x" } },
      ],
      ["DELETE", `/items/${folder.id}`, undefined],
    ];
    for (const [method, path, payload] of doors) {
      const res = await request(ctx.app, method, path, {
        key: ctx.workingKey,
        ...(payload === undefined ? {} : { body: payload }),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await body<ErrorBody>(res)).error.code).toBe(
        "type_not_permitted",
      );
    }
  });
});

describe("minting a folder's key", () => {
  it("gives a key exactly write on system.folder, from a key and from a session granted it", async () => {
    const fromKey = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: "folder key",
        source: "folder-key-from-key",
        type_permissions: { "system.folder": "write" },
      },
    });
    expect(fromKey.status).toBe(201);
    const minted = await body<{ key: string }>(fromKey);
    expect((await create({ title: "Minted" }, minted.key)).status).toBe(201);

    const session = await seedOauthBearer(ctx, [
      "keys.mint",
      "system.folder:write",
    ]);
    const fromSession = await request(ctx.app, "POST", "/keys", {
      key: session.token,
      body: {
        label: "folder key",
        source: "folder-key-from-session",
        type_permissions: { "system.folder": "write" },
      },
    });
    expect(fromSession.status).toBe(201);
  });
});

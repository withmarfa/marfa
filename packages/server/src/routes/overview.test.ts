import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { registerTypeSchema, unregisterTypeSchema } from "@withmarfa/shared";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { OVERVIEW_CAPS, OVERVIEW_TEXT_CAP } from "./overview.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Overview {
  instance: { name: string; build: string; release?: string };
  credential: {
    kind: string;
    label?: string;
    type_permissions?: Record<string, string[]>;
    permissions?: string[];
  };
  types?: { id: string; description?: string; count: number }[];
  edge_types?: { id: string; description?: string; access: string }[];
  tags?: { tag: string; count: number }[];
  views?: { id: string; title: string }[];
  folders?: { id: string; title: string }[];
  truncated?: Record<string, number>;
}

async function overview(key: string): Promise<Overview> {
  const res = await request(ctx.app, "GET", "/overview", { key });
  expect(res.status).toBe(200);
  return (await res.json()) as Overview;
}

async function addNote(body: string, tags: string[] = []): Promise<void> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body }, tags },
  });
  expect(res.status).toBe(201);
}

function typeBody(id: string, description?: string) {
  return {
    id,
    label: id,
    version: 1,
    ...(description !== undefined && { description }),
    fields: { name: { type: "string" } },
  };
}

describe("GET /overview", () => {
  it("refuses a request with no credential", async () => {
    const res = await request(ctx.app, "GET", "/overview");
    expect(res.status).toBe(401);
  });

  it("refuses the owner's browser session, which is no credential for the data plane", async () => {
    const res = await ctx.ownerRequest("/overview");
    expect(res.status).toBe(401);
    expect(
      (await request(ctx.app, "GET", "/overview", { key: ctx.workingKey }))
        .status,
    ).toBe(200);
  });

  it("answers the instance, the credential, and counts sorted by size", async () => {
    await addNote("one", ["alpha"]);
    await addNote("two", ["alpha", "beta"]);
    await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.bookmark",
        properties: { url: "https://example.test/" },
      },
    });
    const view = await request(ctx.app, "POST", "/views", {
      key: ctx.workingKey,
      body: { title: "  Reading   list " },
    });
    expect(view.status).toBe(201);
    const folder = await request(ctx.app, "POST", "/folders", {
      key: ctx.workingKey,
      body: { title: "Project", query: { types: ["core.note"] } },
    });
    expect(folder.status).toBe(201);

    const answer = await overview(ctx.workingKey);

    expect(answer.instance.name).toBe("Marfa");
    expect(answer.credential.kind).toBe("key");
    expect(typeof answer.credential.label).toBe("string");
    expect(answer.credential.type_permissions).toEqual({ write: ["*"] });
    expect(answer.credential.permissions).toContain("audit.read");
    const types = answer.types ?? [];
    const notes = types.find((t) => t.id === "core.note");
    const bookmark = types.find((t) => t.id === "core.bookmark");
    expect(notes?.count).toBeGreaterThanOrEqual(2);
    expect(bookmark?.count).toBeGreaterThanOrEqual(1);
    expect(types.map((t) => t.count)).toEqual(
      [...types.map((t) => t.count)].sort((a, b) => b - a),
    );
    // A witness for the absence below: the namespace holds rows the
    // credential reads, and they appear as views and folders.
    expect(types.some((t) => t.id.startsWith("system."))).toBe(false);
    expect(answer.views).toEqual([
      { id: expect.any(String), title: "Reading list" },
    ]);
    expect(answer.folders).toEqual([
      { id: expect.any(String), title: "Project" },
    ]);
    expect(answer.tags?.[0]).toMatchObject({ tag: "alpha" });
    expect(answer.edge_types?.length).toBeGreaterThan(0);
    expect(answer.truncated).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain("null");
  });

  it("leaves out a type the credential cannot read, and everything counted from it", async () => {
    await addNote("kept", ["only-note"]);
    await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.bookmark",
        properties: { url: "https://example.test/hidden" },
        tags: ["only-bookmark"],
      },
    });
    const narrow = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "read" },
      permissions: [],
      edge_permissions: {},
    });

    const answer = await overview(narrow);

    expect(answer.types?.map((t) => t.id)).toEqual(["core.note"]);
    expect(answer.tags?.some((t) => t.tag === "only-note")).toBe(true);
    expect(answer.tags?.some((t) => t.tag === "only-bookmark")).toBe(false);
    expect(answer.views).toBeUndefined();
    expect(answer.folders).toBeUndefined();
    expect(answer.edge_types).toBeUndefined();
    expect(answer.credential.permissions).toBeUndefined();
    expect(answer.credential.type_permissions).toEqual({
      read: ["core.note"],
    });
    const witness = await overview(ctx.workingKey);
    expect(witness.types?.some((t) => t.id === "core.bookmark")).toBe(true);
  });

  it("answers a credential that reaches no type with the instance and itself only", async () => {
    const none = await mintWorkingKey(ctx, {
      type_permissions: {},
      permissions: [],
      edge_permissions: {},
    });
    const answer = await overview(none);
    expect(Object.keys(answer).sort()).toEqual(["credential", "instance"]);
    expect(answer.credential.kind).toBe("key");
  });

  it("reads a signed-in app's grant as the app, not as a key", async () => {
    const { token } = await seedOauthBearer(ctx, [
      "core.note:read",
      "audit.read",
    ]);
    const answer = await overview(token);
    expect(answer.credential.kind).toBe("app");
    expect(answer.credential.label).toBeUndefined();
    expect(answer.credential.permissions).toEqual(["audit.read"]);
    expect(answer.credential.type_permissions).toEqual({
      read: ["core.note"],
    });
    expect(answer.types?.map((t) => t.id)).toEqual(["core.note"]);
  });

  it("lists a type registered while the server runs, and survives its deletion between reads", async () => {
    const id = "demo.overview_runtime";
    const registered = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: typeBody(id, "Registered at runtime."),
    });
    expect(registered.status).toBe(201);
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: id, properties: { name: "x" } },
    });
    expect(created.status).toBe(201);

    const first = await overview(ctx.workingKey);
    expect(first.types?.find((t) => t.id === id)).toEqual({
      id,
      description: "Registered at runtime.",
      count: 1,
    });

    const snapshot = ctx.storage.runInReadSnapshot.bind(ctx.storage);
    vi.spyOn(ctx.storage, "runInReadSnapshot").mockImplementation(
      (work, options) => {
        unregisterTypeSchema(id);
        return snapshot(work, options);
      },
    );
    const during = await overview(ctx.workingKey);
    // Deleted after the registry was copied and before the counts were read.
    expect(during.types?.find((t) => t.id === id)).toEqual({
      id,
      description: "Registered at runtime.",
      count: 1,
    });
    vi.restoreAllMocks();
    const after = await overview(ctx.workingKey);
    expect(after.types?.find((t) => t.id === id)).toEqual({ id, count: 1 });
  });

  it("holds every list to its cap and the answer to a small size with hundreds of types, tags and patterns", async () => {
    const long = "d".repeat(2000);
    for (let i = 0; i < 300; i++) {
      registerTypeSchema({
        id: `demo.many_${String(i).padStart(3, "0")}`,
        label: `Many ${String(i)}`,
        version: 1,
        description: long,
        fields: { name: { type: "string" } },
      });
    }
    for (let i = 0; i < 60; i++) {
      await addNote(
        `tagged ${String(i)}`,
        [0, 1, 2, 3].map((n) => `bulk-tag-${String(i * 4 + n)}`),
      );
    }
    const patterns = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `demo.many_${String(i).padStart(3, "0")}`,
        i % 2 === 0 ? "read" : "write",
      ]),
    );
    const key = await mintWorkingKey(ctx, {
      type_permissions: { ...patterns, "core.note": "read" },
    });

    const res = await request(ctx.app, "GET", "/overview", { key });
    expect(res.status).toBe(200);
    const text = await res.text();
    const answer = JSON.parse(text) as Overview;

    expect(answer.types).toHaveLength(OVERVIEW_CAPS.types);
    expect(answer.truncated?.types).toBeGreaterThanOrEqual(101);
    expect(answer.tags).toHaveLength(OVERVIEW_CAPS.tags);
    expect(answer.truncated?.tags).toBeGreaterThanOrEqual(240);
    expect(answer.credential.type_permissions?.read).toHaveLength(
      OVERVIEW_CAPS.type_permissions,
    );
    expect(answer.truncated?.["credential.type_permissions.read"]).toBe(51);
    for (const entry of answer.types ?? []) {
      expect((entry.description ?? "").length).toBeLessThanOrEqual(
        OVERVIEW_TEXT_CAP,
      );
    }
    expect(text.length).toBeLessThan(20_000);
    for (let i = 0; i < 300; i++) {
      unregisterTypeSchema(`demo.many_${String(i).padStart(3, "0")}`);
    }
  });
});

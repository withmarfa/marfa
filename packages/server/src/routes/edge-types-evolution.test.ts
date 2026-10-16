import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createTestContext,
  request,
  raceTheNextTransaction,
  type TestContext,
} from "../test-utils.js";

let ctx: TestContext;
const prefix = `test.evolve-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.cleanup();
});

const base = (id: string) => ({
  id,
  label: "In repository",
  cardinality: "many-to-many",
  source_type_constraints: ["core.note"],
  target_type_constraints: ["core.note"],
});

async function register(body: Record<string, unknown>, key = ctx.workingKey) {
  return request(ctx.app, "POST", "/edge-types", { key, body });
}

describe("explicit connection constraint evolution", () => {
  it("widens a held definition without rewriting its existing edges", async () => {
    const definition = base(`${prefix}.kept`);
    expect((await register(definition)).status).toBe(201);
    const note = async () => {
      const answer = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body: "Kept" } },
      });
      expect(answer.status).toBe(201);
      return ((await answer.json()) as { item: { id: string } }).item.id;
    };
    const source = await note();
    const target = await note();
    const created = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: {
        source_id: source,
        target_id: target,
        edge_type: definition.id,
        properties: { note: "Kept" },
      },
    });
    expect(created.status).toBe(201);
    const edge = ((await created.json()) as { edge: { id: string } }).edge;
    const before = await ctx.storage.edges.get(edge.id);
    const response = await register({
      ...definition,
      source_type_constraints: ["core.note", "core.task"],
      evolve_constraints: true,
    });
    expect(response.status).toBe(200);
    expect(await ctx.storage.edges.get(edge.id)).toEqual(before);
    const served = await ctx.storage.edgeTypes.get(definition.id);
    expect(served?.source_type_constraints).toEqual(["core.note", "core.task"]);
    expect(served).not.toHaveProperty("evolve_constraints");
  });
});

it("keeps duplicate registration explicit and refuses evolution of missing or shipped types", async () => {
  const definition = base(`${prefix}.duplicate`);
  expect((await register(definition)).status).toBe(201);
  expect((await register(definition)).status).toBe(409);
  expect(
    (await register({ ...definition, evolve_constraints: false })).status,
  ).toBe(409);
  expect(
    (await register({ ...base(`${prefix}.missing`), evolve_constraints: true }))
      .status,
  ).toBe(404);
  expect(
    (await register({ ...base("about"), evolve_constraints: true })).status,
  ).toBe(409);
  expect(await ctx.storage.edgeTypes.get(definition.id)).toMatchObject(
    definition,
  );
});

it.each([
  ["source narrowing", { source_type_constraints: ["core.task"] }],
  ["target narrowing", { target_type_constraints: ["core.task"] }],
  ["cardinality", { cardinality: "many-to-one" }],
  ["cascade", { cascade_on_delete: "block" }],
  ["label", { label: "Changed" }],
  ["description", { description: "Changed" }],
  ["properties", { property_schema: { note: { type: "string" } } }],
  ["reverse name", { reverse_name: `${prefix}.reverse` }],
  [
    "written end",
    { reverse_name: `${prefix}.written-reverse`, written_at: "target" },
  ],
])("refuses %s without changing the definition", async (name, change) => {
  const definition = base(`${prefix}.refused-${name.replaceAll(" ", "-")}`);
  expect((await register(definition)).status).toBe(201);
  const before = await ctx.storage.edgeTypes.get(definition.id);
  const response = await register({
    ...definition,
    ...change,
    evolve_constraints: true,
  });
  expect(response.status).toBe(409);
  expect(await ctx.storage.edgeTypes.get(definition.id)).toEqual(before);
});

it.each([{ all: [] }, { all: ["*"] }])(
  "keeps unrestricted constraints unrestricted (%j)",
  async ({ all }) => {
    const definition = {
      ...base(`${prefix}.all-${String(all.length)}`),
      source_type_constraints: all,
    };
    expect((await register(definition)).status).toBe(201);
    expect(
      (
        await register({
          ...definition,
          source_type_constraints: ["core.note"],
          evolve_constraints: true,
        })
      ).status,
    ).toBe(409);
    const response = await register({
      ...definition,
      source_type_constraints: all.length === 0 ? ["*"] : [],
      evolve_constraints: true,
    });
    expect(response.status).toBe(200);
  },
);

it("allows a constrained end to become unrestricted and retains unknown tokens conservatively", async () => {
  const definition = {
    ...base(`${prefix}.future`),
    source_type_constraints: ["future.unregistered"],
  };
  expect((await register(definition)).status).toBe(201);
  expect(
    (
      await register({
        ...definition,
        source_type_constraints: ["core.note"],
        evolve_constraints: true,
      })
    ).status,
  ).toBe(409);
  const added = {
    ...definition,
    source_type_constraints: ["future.unregistered", "core.note"],
    evolve_constraints: true,
  };
  expect((await register(added)).status).toBe(200);
  expect((await register(added)).status).toBe(200);
  expect(
    (
      await register({
        ...definition,
        source_type_constraints: [],
        evolve_constraints: true,
      })
    ).status,
  ).toBe(200);
});

it.each([{ value: null }, { value: "*" }, { value: [null] }])(
  "refuses malformed constraint values %j",
  async ({ value }) => {
    const definition = base(
      `${prefix}.malformed-${String(Math.random()).slice(2)}`,
    );
    expect((await register(definition)).status).toBe(201);
    const before = await ctx.storage.edgeTypes.get(definition.id);
    expect(
      (
        await register({
          ...definition,
          source_type_constraints: value,
          evolve_constraints: true,
        })
      ).status,
    ).toBe(400);
    expect(await ctx.storage.edgeTypes.get(definition.id)).toEqual(before);
  },
);

async function key(
  edgePermissions: Record<string, "read" | "write">,
  metadata: boolean,
) {
  const response = await request(ctx.app, "POST", "/keys", {
    key: ctx.workingKey,
    body: {
      label: "Constraint evolution",
      source: `${prefix}.key-${String(Math.random()).slice(2)}`,
      permissions: [],
      type_permissions: { "*": "write" },
      edge_permissions: edgePermissions,
      metadata_permissions: metadata ? { edge_types: "write" } : {},
    },
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { key: string }).key;
}

it("requires metadata write and write on the held forward and reverse names", async () => {
  const definition = {
    ...base(`${prefix}.reach`),
    reverse_name: `${prefix}.reach-reverse`,
  };
  expect((await register(definition)).status).toBe(201);
  const next = {
    ...definition,
    source_type_constraints: ["core.note", "core.task"],
    evolve_constraints: true,
  };
  const noMetadata = await key({ "*": "write" }, false);
  expect((await register(next, noMetadata)).status).toBe(403);
  const noForward = await key({ [definition.reverse_name]: "write" }, true);
  expect((await register(next, noForward)).status).toBe(403);
  const noReverse = await key({ [definition.id]: "write" }, true);
  expect((await register(next, noReverse)).status).toBe(403);
  const both = await key(
    { [definition.id]: "write", [definition.reverse_name]: "write" },
    true,
  );
  expect((await register(next, both)).status).toBe(200);
});

it("checks the definition inside the writer transaction and preserves concurrent additions", async () => {
  const definition = base(`${prefix}.race`);
  expect((await register(definition)).status).toBe(201);
  const next = {
    ...definition,
    source_type_constraints: ["core.note", "core.task"],
    evolve_constraints: true,
  };
  const race = raceTheNextTransaction(ctx.storage, async () => {
    const held = await ctx.storage.edgeTypes.get(definition.id);
    if (held === undefined) throw new Error("No held definition");
    await ctx.storage.edgeTypes.replace({
      ...held,
      source_type_constraints: ["core.note", "core.message"],
    });
  });
  try {
    expect((await register(next)).status).toBe(409);
    expect(race.fired()).toBe(true);
  } finally {
    race.restore();
  }
  expect(
    (await ctx.storage.edgeTypes.get(definition.id))?.source_type_constraints,
  ).toEqual(["core.note", "core.message"]);
  expect(
    (
      await register({
        ...next,
        source_type_constraints: ["core.note", "core.message", "core.task"],
      })
    ).status,
  ).toBe(200);
});

it("retains subtype and role coverage without inferring replacement tokens", async () => {
  for (const { suffix, source } of [
    { suffix: "parent", source: "core.note" },
    { suffix: "role", source: "role:container" },
  ]) {
    const definition = {
      ...base(`${prefix}.${suffix}`),
      source_type_constraints: [source],
    };
    expect((await register(definition)).status).toBe(201);
    const retained = {
      ...definition,
      source_type_constraints: [source, "core.task"],
      evolve_constraints: true,
    };
    expect((await register(retained)).status).toBe(200);
    expect(
      (await register({ ...retained, source_type_constraints: ["core.task"] }))
        .status,
    ).toBe(409);
  }
});

it.each([{ value: null }, { value: "true" }, { value: 1 }])(
  "refuses a nonboolean evolution flag %j",
  async ({ value }) => {
    const definition = base(`${prefix}.flag-${String(Math.random()).slice(2)}`);
    expect((await register(definition)).status).toBe(201);
    expect(
      (await register({ ...definition, evolve_constraints: value })).status,
    ).toBe(400);
    expect(await ctx.storage.edgeTypes.get(definition.id)).toMatchObject(
      definition,
    );
  },
);

it("preserves descendants registered after the evolution", async () => {
  const definition = base(`${prefix}.descendants`);
  expect((await register(definition)).status).toBe(201);
  const next = {
    ...definition,
    source_type_constraints: ["core.note", "core.task"],
    evolve_constraints: true,
  };
  expect((await register(next)).status).toBe(200);
  const child = `test.evolved_child_${Math.random().toString(36).slice(2, 8)}`;
  const type = await request(ctx.app, "POST", "/types", {
    key: ctx.workingKey,
    body: { id: child, label: "Child note", parent: "core.note", fields: {} },
  });
  expect(type.status).toBe(201);
  const item = async (type: string) => {
    const made = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type, properties: { body: "Kept" } },
    });
    expect(made.status).toBe(201);
    return ((await made.json()) as { item: { id: string } }).item.id;
  };
  const edge = await request(ctx.app, "POST", "/edges", {
    key: ctx.workingKey,
    body: {
      source_id: await item(child),
      target_id: await item("core.note"),
      edge_type: definition.id,
    },
  });
  expect(edge.status).toBe(201);
  const childOnly = {
    ...definition,
    id: `${prefix}.child-only`,
    source_type_constraints: [child],
  };
  expect((await register(childOnly)).status).toBe(201);
  expect(
    (
      await register({
        ...childOnly,
        source_type_constraints: ["core.note"],
        evolve_constraints: true,
      })
    ).status,
  ).toBe(409);
});

it("rolls back the stored definition and registry publication if auditing fails", async () => {
  const definition = base(`${prefix}.rollback`);
  expect((await register(definition)).status).toBe(201);
  const before = await ctx.storage.edgeTypes.get(definition.id);
  const audit = vi
    .spyOn(ctx.storage.audit, "log")
    .mockRejectedValueOnce(new Error("Audit unavailable"));
  try {
    const next = {
      ...definition,
      source_type_constraints: ["core.note", "core.task"],
      evolve_constraints: true,
    };
    expect((await register(next)).status).toBe(500);
  } finally {
    audit.mockRestore();
  }
  expect(await ctx.storage.edgeTypes.get(definition.id)).toEqual(before);
  const listed = await request(ctx.app, "GET", "/edge-types", {
    key: ctx.workingKey,
  });
  const served = (
    (await listed.json()) as { data: { id: string }[] }
  ).data.find((one) => one.id === definition.id);
  expect(served).toMatchObject(before ?? {});
});

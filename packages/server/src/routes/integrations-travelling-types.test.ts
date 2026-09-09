/**
 * Types that travel with a manifest, and the target type that resolves
 * nowhere.
 *
 * Both halves are refusals a person only meets if something checks at
 * registration. Before this, a manifest could name a target type nothing
 * had registered, install cleanly, mint a credential granting write on a
 * type that did not exist, and fail on its first item write with an error
 * naming the type rather than the manifest that declared it.
 *
 * The ownership half matters more. An integration declaring its own schemas
 * is a package registering types, and a package able to declare outside the
 * namespace its identifier names would walk straight around the rule that
 * stops one package registering into another's namespace. The gate reads
 * that first segment, not the `publisher` field, which answers a different
 * question and routinely differs.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { MAX_REGISTRATION_CHAIN_DEPTH } from "./_parent-chain.js";
import { createTestContext, request, type TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function manifest(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "acme/travelling",
    version: "1.0.0",
    publisher: "acme",
    description: "Ships its own types",
    direction: "read",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    manifest_schema_version: "2.0.0",
    ...overrides,
  };
}

function schema(id: string): Record<string, unknown> {
  return {
    id,
    label: "Travelling type",
    description: "Declared by the manifest that needs it.",
    version: 1,
    fields: { title: { type: "string", description: "A title." } },
  };
}

/** A declared schema that inherits, for the parent-chain cases below. */
function child(id: string, parent: string): Record<string, unknown> {
  return { ...schema(id), parent };
}

/** `count` schemas forming one chain, root first. */
function chain(prefix: string, count: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [schema(`${prefix}0`)];
  for (let i = 1; i < count; i += 1) {
    out.push(child(`${prefix}${String(i)}`, `${prefix}${String(i - 1)}`));
  }
  return out;
}

/** Whether a catalog row exists for a `(name, version)` pair. */
async function isRegistered(name: string, version: string): Promise<boolean> {
  const res = await request(
    ctx.app,
    "GET",
    `/items?type=system.integration&filter=${encodeURIComponent(
      `properties.manifest_name eq "${name}" AND properties.manifest_version eq "${version}"`,
    )}`,
    { key: ctx.spaceKey },
  );
  const body = (await res.json()) as { data?: unknown[] };
  return (body.data ?? []).length > 0;
}

async function register(body: Record<string, unknown>): Promise<Response> {
  return request(ctx.app, "POST", "/integrations", {
    key: ctx.operatorKey,
    body: { manifest: body },
  });
}

describe("a manifest declaring its own type schemas", () => {
  it("registers a type inside its identifier's namespace", async () => {
    const res = await register(
      manifest({
        name: "acme/travelling",
        version: "1.0.0",
        type_schemas: [schema("acme.travelling_note")],
        target_types: ["acme.travelling_note"],
      }),
    );
    expect(res.status).toBe(201);

    // The type is registered and resolvable, not merely recorded on the row.
    const typeRes = await request(
      ctx.app,
      "GET",
      "/types/acme.travelling_note",
      {
        key: ctx.spaceKey,
      },
    );
    expect(typeRes.status).toBe(200);
  });

  it("refuses a type outside its identifier's namespace", async () => {
    const res = await register(
      manifest({
        name: "acme/outsider",
        version: "1.0.0",
        type_schemas: [schema("notacme.smuggled")],
        target_types: ["core.note"],
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("acme.*");
    expect(body.error.message).toContain("notacme.smuggled");
  });

  it("refuses a reserved root, which is seeded rather than registered", async () => {
    const res = await register(
      manifest({
        name: "core/impostor",
        version: "1.0.0",
        type_schemas: [schema("core.smuggled")],
        target_types: ["core.note"],
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("platform-shipped");
  });
});

describe("a target type that resolves nowhere", () => {
  it("is refused at registration, naming the entry", async () => {
    const res = await register(
      manifest({
        name: "acme/unresolvable",
        version: "1.0.0",
        target_types: ["acme.type_nobody_registered"],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; details?: { unresolvable?: string[] } };
    };
    expect(body.error.message).toContain("acme.type_nobody_registered");
  });

  it("counts a type the same manifest declares as resolvable", async () => {
    const res = await register(
      manifest({
        name: "acme/self-satisfying",
        version: "1.0.0",
        type_schemas: [schema("acme.self_declared")],
        target_types: ["acme.self_declared"],
      }),
    );
    expect(res.status).toBe(201);
  });

  it("still accepts a target type the platform ships", async () => {
    const res = await register(
      manifest({ name: "acme/plain", version: "1.0.0" }),
    );
    expect(res.status).toBe(201);
  });
});

/**
 * A manifest was the third path into the registry and the only one that
 * checked nothing about `parent`. A declared cycle registered cleanly and
 * then threw a bare error on the next read of either type, which surfaced
 * as a 500; the same input through `POST /types` was always a 400.
 *
 * Nothing in the tree declares a `parent` in a manifest, so these are the
 * only exercise this door gets.
 */
describe("a manifest declaring a parent chain", () => {
  // Deliberately an order no single pass can satisfy in either direction, so
  // this fails if the fixed point is reduced to one sweep. A parent-then-child
  // pair would not: one sweep in the right direction happens to place it, and
  // the test would pass while proving nothing.
  it("registers a chain listed in an order no single pass satisfies", async () => {
    const res = await register(
      manifest({
        name: "acme/out-of-order",
        version: "1.0.0",
        type_schemas: [
          child("acme.ordered_middle", "acme.ordered_root"),
          child("acme.ordered_leaf", "acme.ordered_middle"),
          schema("acme.ordered_root"),
        ],
        target_types: ["acme.ordered_leaf"],
      }),
    );
    expect(res.status).toBe(201);

    // Registered and resolvable, not merely recorded on the catalog row.
    const typeRes = await request(ctx.app, "GET", "/types/acme.ordered_leaf", {
      key: ctx.spaceKey,
    });
    expect(typeRes.status).toBe(200);
    const body = (await typeRes.json()) as { parent?: string };
    expect(body.parent).toBe("acme.ordered_middle");
  });

  it("registers a child of a type the platform already ships", async () => {
    const res = await register(
      manifest({
        name: "acme/inherits-core",
        version: "1.0.0",
        type_schemas: [child("acme.note_subtype", "core.note")],
        target_types: ["acme.note_subtype"],
      }),
    );
    expect(res.status).toBe(201);
  });

  // Each of these asserts the OTHER cause is absent as well as its own being
  // present. Without that, one refusal naming every cause at once would pass
  // both while discriminating nothing, which is the property being tested.
  it("refuses a parent that resolves to no registered type", async () => {
    const res = await register(
      manifest({
        name: "acme/dangling",
        version: "1.0.0",
        type_schemas: [child("acme.orphan", "acme.no_such_parent")],
        target_types: ["acme.orphan"],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("acme.orphan");
    expect(body.error.message).toContain("acme.no_such_parent");
    expect(body.error.message).not.toContain("circular");
    expect(await isRegistered("acme/dangling", "1.0.0")).toBe(false);
  });

  it("refuses a cycle as a cycle, not as a missing parent", async () => {
    const res = await register(
      manifest({
        name: "acme/cyclic",
        version: "1.0.0",
        type_schemas: [
          child("acme.cyc_a", "acme.cyc_b"),
          child("acme.cyc_b", "acme.cyc_a"),
        ],
        target_types: ["acme.cyc_a"],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("circular");
    expect(body.error.message).toContain("acme.cyc_a");
    expect(body.error.message).toContain("acme.cyc_b");
    expect(body.error.message).not.toContain("resolves to no registered type");
    expect(await isRegistered("acme/cyclic", "1.0.0")).toBe(false);
  });

  // Being blocked by a cycle is not being in one. `tail` is queued behind the
  // loop and nothing more, so a refusal that names it as circular is telling
  // its author to look for a loop it is not part of.
  it("names only the schemas actually on the loop", async () => {
    const res = await register(
      manifest({
        name: "acme/tail-into-cycle",
        version: "1.0.0",
        type_schemas: [
          child("acme.tail", "acme.loop_a"),
          child("acme.loop_a", "acme.loop_b"),
          child("acme.loop_b", "acme.loop_a"),
        ],
        target_types: ["acme.tail"],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("circular");
    expect(body.error.message).toContain("acme.loop_a");
    expect(body.error.message).toContain("acme.loop_b");
    expect(body.error.message).not.toContain("acme.tail");
    expect(await isRegistered("acme/tail-into-cycle", "1.0.0")).toBe(false);
  });

  // Two independent faults in one manifest. Reporting the first and stopping
  // makes fixing it a round trip per fault.
  it("reports both causes when a batch has both", async () => {
    const res = await register(
      manifest({
        name: "acme/both-causes",
        version: "1.0.0",
        type_schemas: [
          child("acme.both_orphan", "acme.both_missing"),
          child("acme.both_x", "acme.both_y"),
          child("acme.both_y", "acme.both_x"),
        ],
        target_types: ["acme.both_orphan"],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("acme.both_missing");
    expect(body.error.message).toContain("circular");
    expect(body.error.message).toContain("acme.both_x");
    expect(body.error.message).toContain("acme.both_y");
    expect(await isRegistered("acme/both-causes", "1.0.0")).toBe(false);
  });

  // A registered type is left as it stands, so the process cannot end up
  // serving a shape the stored row does not carry. The replay path depends on
  // the same skip, which is why both are pinned together.
  it("leaves an already-registered type alone across manifest versions", async () => {
    const first = await register(
      manifest({
        name: "acme/settled",
        version: "1.0.0",
        type_schemas: [schema("acme.settled_type")],
        target_types: ["acme.settled_type"],
      }),
    );
    expect(first.status).toBe(201);

    const moved = {
      ...schema("acme.settled_type"),
      description: "A different description entirely.",
    };
    const second = await register(
      manifest({
        name: "acme/settled",
        version: "2.0.0",
        type_schemas: [moved],
        target_types: ["acme.settled_type"],
      }),
    );
    expect(second.status).toBe(201);

    const typeRes = await request(ctx.app, "GET", "/types/acme.settled_type", {
      key: ctx.spaceKey,
    });
    const body = (await typeRes.json()) as { description?: string };
    expect(body.description).toBe("Declared by the manifest that needs it.");
  });

  it("registers a chain that sits exactly on the cap", async () => {
    const res = await register(
      manifest({
        name: "acme/at-the-cap",
        version: "1.0.0",
        type_schemas: chain("acme.atcap_", MAX_REGISTRATION_CHAIN_DEPTH + 1),
        target_types: ["acme.atcap_0"],
      }),
    );
    expect(res.status).toBe(201);
  });

  it("refuses the chain one link past the cap", async () => {
    const res = await register(
      manifest({
        name: "acme/past-the-cap",
        version: "1.0.0",
        type_schemas: chain("acme.overcap_", MAX_REGISTRATION_CHAIN_DEPTH + 2),
        target_types: ["acme.overcap_0"],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain(
      `deeper than ${String(MAX_REGISTRATION_CHAIN_DEPTH)}`,
    );
    expect(await isRegistered("acme/past-the-cap", "1.0.0")).toBe(false);
  });
});

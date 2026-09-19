/**
 * `in-collection` admits any type declaring the `container` role.
 *
 * The edge used to name three permitted targets, all of them platform types,
 * so a connector writing its own vocabulary had nothing it was allowed to
 * point at: a publisher could have a container and members and no supported
 * way to say one held the other. Naming the vendor type in the core edge would
 * have fixed one publisher and left every later one — including publishers who
 * cannot edit a core edge at all — in the same position, so the constraint
 * moved off identity and onto a property the target declares about itself.
 *
 * Two things have to hold together for that to be worth anything. A type
 * declaring the role must be admitted, and a type not declaring it must still
 * be refused, or the constraint is decoration.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

/**
 * The credential a shipped connector actually holds. `marfa.*` is a
 * reserved namespace, so an ordinary key cannot write a podcast row or an
 * edge whose source is one; a connector credential naming those literals can,
 * which is the only shape the cases below can be driven through.
 */

// A publisher who is not us, registering the pair a connector would ship.
const suffix = Math.random().toString(36).slice(2, 8);
const PUBLISHER_CONTAINER = `acme${suffix}.library`;
const PUBLISHER_SUBTYPE = `acme${suffix}.library.curated`;
const PUBLISHER_MEMBER = `acme${suffix}.track`;
const PUBLISHER_PLAIN = `acme${suffix}.shelf`;

interface ItemResponse {
  item: { id: string };
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: {
      constraint?: string;
      errors?: { field: string; message: string }[];
    };
  };
}

async function registerType(body: Record<string, unknown>): Promise<Response> {
  return await request(ctx.app, "POST", "/types", {
    key: ctx.workingKey,
    body,
  });
}

async function registerTypeOk(body: Record<string, unknown>): Promise<void> {
  const res = await registerType(body);
  // The registry is a process-level singleton, so a sibling suite that got
  // there first is not a failure here.
  if (res.status === 201) return;
  const data = (await res.clone().json()) as ErrorResponse;
  expect(
    data.error.code,
    `POST /types ${String(body.id)} -> ${String(res.status)}: ${await res.text()}`,
  ).toBe("type_already_exists");
}

async function createItem(
  type: string,
  properties: Record<string, unknown>,
  key: string = ctx.workingKey,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: { type, properties },
  });
  expect(
    res.status,
    `POST /items ${type} -> ${String(res.status)}: ${await res.clone().text()}`,
  ).toBe(201);
  const data = (await res.json()) as ItemResponse;
  return data.item.id;
}

async function join(
  sourceId: string,
  targetId: string,
  key: string = ctx.workingKey,
): Promise<Response> {
  return await request(ctx.app, "POST", "/edges", {
    key,
    body: {
      source_id: sourceId,
      target_id: targetId,
      edge_type: "in-collection",
    },
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  await registerTypeOk({
    id: PUBLISHER_CONTAINER,
    label: "Library",
    description: "A publisher's own container type.",
    version: 1,
    roles: ["container"],
    fields: {
      name: { type: "string", required: true, description: "Display name." },
    },
  });
  await registerTypeOk({
    id: PUBLISHER_SUBTYPE,
    label: "Curated library",
    description: "A subtype of a container, declaring no role of its own.",
    parent: PUBLISHER_CONTAINER,
    version: 1,
    fields: {
      name: { type: "string", required: true, description: "Display name." },
    },
  });
  await registerTypeOk({
    id: PUBLISHER_MEMBER,
    label: "Track",
    description: "A publisher's own member type.",
    version: 1,
    fields: {
      name: { type: "string", required: true, description: "Display name." },
    },
  });
  await registerTypeOk({
    id: PUBLISHER_PLAIN,
    label: "Shelf",
    description: "Sounds like a container and does not declare itself one.",
    version: 1,
    fields: {
      name: { type: "string", required: true, description: "Display name." },
    },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("a publisher's own container", () => {
  it("admits a member with no core type anywhere in the relation", async () => {
    const library = await createItem(PUBLISHER_CONTAINER, { name: "Archive" });
    const track = await createItem(PUBLISHER_MEMBER, { name: "Undertow" });
    const res = await join(track, library);
    expect(
      res.status,
      `POST /edges -> ${String(res.status)}: ${await res.clone().text()}`,
    ).toBe(201);
  });

  it("carries the role down to a subtype that declares none", async () => {
    // Roles resolve through the parent chain for the same reason a name
    // constraint does. A type registered under a container parent never
    // passes through the build-time codegen, so a role flattened at build
    // time would be a role only in-tree types could have.
    const curated = await createItem(PUBLISHER_SUBTYPE, { name: "Curated" });
    const track = await createItem(PUBLISHER_MEMBER, { name: "Low Tide" });
    expect((await join(track, curated)).status).toBe(201);
  });

  it("refuses the subtype as a member too", async () => {
    const curated = await createItem(PUBLISHER_SUBTYPE, { name: "Inner" });
    const library = await createItem(PUBLISHER_CONTAINER, { name: "Outer" });
    const res = await join(curated, library);
    expect(res.status).toBe(400);
    const data = (await res.json()) as ErrorResponse;
    expect(data.error.details?.constraint).toBe("nesting");
  });
});

describe("a type that does not declare the role", () => {
  it("is refused as a target", async () => {
    // Without this the constraint would mean nothing: `in-collection` would
    // have become `["*"]` with extra words.
    const shelf = await createItem(PUBLISHER_PLAIN, { name: "Shelf" });
    const track = await createItem(PUBLISHER_MEMBER, { name: "Orphan" });
    const res = await join(track, shelf);
    expect(res.status).toBe(400);
    const data = (await res.json()) as ErrorResponse;
    expect(data.error.code).toBe("edge_constraint_violation");
    // The declarative target constraint catches this, not the nesting rule.
    expect(data.error.details?.constraint).toBeUndefined();
  });

  it("is refused even when it is a core media type", async () => {
    const episode = await createItem("core.media.episode", {
      title: "Not a container",
    });
    const song = await createItem("core.media.song", { title: "Member" });
    const res = await join(song, episode);
    expect(res.status).toBe(400);
    const data = (await res.json()) as ErrorResponse;
    expect(data.error.code).toBe("edge_constraint_violation");
  });

  it("may still be a member itself", async () => {
    const shelf = await createItem(PUBLISHER_PLAIN, { name: "Member shelf" });
    const library = await createItem(PUBLISHER_CONTAINER, { name: "Holder" });
    expect((await join(shelf, library)).status).toBe(201);
  });
});

describe("the role vocabulary is closed", () => {
  it("refuses a type declaring a role nobody defines", async () => {
    const res = await registerType({
      id: `acme${suffix}.bogus`,
      label: "Bogus",
      description: "Declares a role that does not exist.",
      version: 1,
      roles: ["warehouse"],
      fields: {
        name: { type: "string", required: true, description: "Display name." },
      },
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as ErrorResponse;
    expect(data.error.code).toBe("invalid_schema");
    expect(data.error.details?.errors?.map((e) => e.field)).toContain("roles");
  });

  it("refuses an edge type constraining on a role nobody defines", async () => {
    // An unknown role matches no type, so the edge would refuse every
    // endpoint while reading as though it admitted a family of them.
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: ctx.workingKey,
      body: {
        id: `user.shelved-in-${suffix}`,
        cardinality: "many-to-many",
        source_type_constraints: ["*"],
        target_type_constraints: ["role:warehouse"],
        cascade_on_delete: "orphan",
      },
    });
    expect(res.status).toBe(400);
  });
});

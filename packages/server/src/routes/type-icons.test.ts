import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  cleanupTestContext,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await cleanupTestContext(ctx);
});

interface TypeBody {
  id: string;
  display_hints?: { title_field?: string; body_field?: string; icon?: string };
}

let minted = 0;
function name(): string {
  minted += 1;
  return `icons${String(minted)}`;
}

async function ownerSetIcon(id: string, icon: string): Promise<Response> {
  return ctx.ownerRequest(`/types/${id}/icon`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ icon }),
  });
}

async function ownerClearIcon(id: string): Promise<Response> {
  return ctx.ownerRequest(`/types/${id}/icon`, { method: "DELETE" });
}

async function readType(id: string): Promise<TypeBody> {
  const res = await request(ctx.app, "GET", `/types/${id}`, {
    key: ctx.workingKey,
  });
  expect(res.status, id).toBe(200);
  return (await res.json()) as TypeBody;
}

async function listedType(id: string): Promise<TypeBody | undefined> {
  const res = await request(ctx.app, "GET", "/types", {
    key: ctx.workingKey,
  });
  const { data } = (await res.json()) as { data: TypeBody[] };
  return data.find((type) => type.id === id);
}

async function register(
  id: string,
  body: Record<string, unknown> = {},
  key = ctx.workingKey,
): Promise<Response> {
  return request(ctx.app, "POST", "/types", {
    key,
    body: { id, fields: { title: { type: "string" } }, ...body },
  });
}

async function replace(
  id: string,
  body: Record<string, unknown>,
  key = ctx.workingKey,
): Promise<Response> {
  return request(ctx.app, "PUT", `/types/${id}`, {
    key,
    body: { fields: { title: { type: "string" } }, ...body },
  });
}

/**
 * Values no door takes as an icon: bare names, a set Marfa does not accept,
 * a name outside its set, an alias (`lucide:home` is one of `lucide:house`),
 * and malformed IDs.
 */
const REFUSED = [
  "calendar-days",
  "github",
  "mdi:calendar",
  "lucide:github",
  "simple-icons:calendar",
  "lucide:home",
  "lucide:Calendar",
  "lucide:calendar_days",
  "lucide:",
  ":calendar",
  " lucide:calendar",
  "",
];

async function errorOf(
  res: Response,
): Promise<{ code: string; details?: { errors?: { field: string }[] } }> {
  return ((await res.json()) as { error: never }).error;
}

describe("display_hints.icon on a type's definition", () => {
  it("is taken, read back and refused when it is not an icon ID from a pinned set", async () => {
    const id = `acme.${name()}`;
    expect(
      (await register(id, { display_hints: { icon: "lucide:calendar-days" } }))
        .status,
    ).toBe(201);
    expect((await readType(id)).display_hints).toEqual({
      icon: "lucide:calendar-days",
    });

    const brand = `acme.${name()}`;
    expect(
      (
        await register(brand, {
          display_hints: { icon: "simple-icons:github" },
        })
      ).status,
    ).toBe(201);
    expect((await readType(brand)).display_hints?.icon).toBe(
      "simple-icons:github",
    );

    for (const icon of [...REFUSED, 3]) {
      const posted = await register(`acme.${name()}`, {
        display_hints: { icon },
      });
      expect(posted.status, String(icon)).toBe(400);
      const error = await errorOf(posted);
      expect(error.code).toBe("invalid_schema");
      expect(error.details?.errors?.map((e) => e.field)).toContain(
        "display_hints.icon",
      );

      const put = await replace(id, { display_hints: { icon } });
      expect(put.status, String(icon)).toBe(400);
      expect((await errorOf(put)).code).toBe("invalid_schema");

      const normalized = await request(ctx.app, "POST", "/types/normalize", {
        key: ctx.workingKey,
        body: { id, fields: {}, display_hints: { icon } },
      });
      expect(normalized.status, String(icon)).toBe(400);
      expect((await errorOf(normalized)).code).toBe("invalid_schema");
    }
    expect((await readType(id)).display_hints?.icon).toBe(
      "lucide:calendar-days",
    );
  });
});

describe("display_hints per hint", () => {
  it("shows a parent's title with the child's own icon", async () => {
    const parent = `acme.${name()}`;
    const child = `${parent}.kid`;
    await register(parent, { display_hints: { title_field: "title" } });
    await register(child, {
      parent,
      fields: {},
      display_hints: { icon: "lucide:star" },
    });
    expect((await readType(child)).display_hints).toEqual({
      title_field: "title",
      icon: "lucide:star",
    });
  });
});

describe("PUT and DELETE /types/{id}/icon", () => {
  it("answers the owner's icon in place of the author's, and the author's again once cleared", async () => {
    const before = await readType("core.note");
    expect(before.display_hints?.icon).toBe("lucide:sticky-note");

    const set = await ownerSetIcon("core.note", "lucide:notebook-pen");
    expect(set.status).toBe(200);
    expect(
      ((await set.json()) as { type: TypeBody }).type.display_hints?.icon,
    ).toBe("lucide:notebook-pen");
    expect((await readType("core.note")).display_hints?.icon).toBe(
      "lucide:notebook-pen",
    );
    expect((await listedType("core.note"))?.display_hints?.icon).toBe(
      "lucide:notebook-pen",
    );

    const cleared = await ownerClearIcon("core.note");
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as { type: TypeBody }).type.display_hints?.icon,
    ).toBe("lucide:sticky-note");
    expect((await readType("core.note")).display_hints?.icon).toBe(
      "lucide:sticky-note",
    );
    // Clearing again changes nothing.
    expect((await ownerClearIcon("core.note")).status).toBe(200);
  });

  it("refuses an icon outside the pinned sets, and keeps the earlier choice", async () => {
    const id = `acme.${name()}`;
    await register(id);
    expect((await ownerSetIcon(id, "simple-icons:github")).status).toBe(200);
    expect((await readType(id)).display_hints?.icon).toBe(
      "simple-icons:github",
    );
    expect((await ownerSetIcon(id, "lucide:map-pin")).status).toBe(200);
    for (const icon of REFUSED) {
      const res = await ownerSetIcon(id, icon);
      expect(res.status, icon).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe("invalid_schema");
      expect(error.details?.errors?.map((e) => e.field)).toEqual(["icon"]);
    }
    const noBody = await ctx.ownerRequest(`/types/${id}/icon`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon: 7 }),
    });
    expect(noBody.status).toBe(400);
    expect((await readType(id)).display_hints?.icon).toBe("lucide:map-pin");
  });

  it("refuses a type that doesn't exist", async () => {
    const res = await ownerSetIcon("acme.nothing_here", "lucide:box");
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("type_not_found");
    expect((await ownerClearIcon("acme.nothing_here")).status).toBe(404);
  });

  it("survives the author replacing the type, and the replacement does not copy it into the author's icon", async () => {
    const id = `acme.${name()}`;
    await register(id, { display_hints: { icon: "lucide:box" } });
    await ownerSetIcon(id, "lucide:package");

    const replaced = await replace(id, {
      label: "Replaced",
      display_hints: { icon: "lucide:archive" },
    });
    expect(replaced.status).toBe(200);
    // The answer to the replacement already shows the owner's choice.
    expect(
      ((await replaced.json()) as { type: TypeBody }).type.display_hints?.icon,
    ).toBe("lucide:package");
    expect((await readType(id)).display_hints?.icon).toBe("lucide:package");

    await ownerClearIcon(id);
    // What the author wrote last is what shows again.
    expect((await readType(id)).display_hints?.icon).toBe("lucide:archive");
  });

  it("does not bake the owner's icon into the definition when a read is written back unchanged", async () => {
    const id = `acme.${name()}`;
    await register(id, { display_hints: { icon: "lucide:box" } });
    await ownerSetIcon(id, "lucide:package");

    const read = (await (
      await request(ctx.app, "GET", `/types/${id}`, { key: ctx.workingKey })
    ).json()) as Record<string, unknown>;
    expect((read.display_hints as { icon: string }).icon).toBe(
      "lucide:package",
    );
    const written = await request(ctx.app, "PUT", `/types/${id}`, {
      key: ctx.workingKey,
      body: read,
    });
    expect(written.status).toBe(200);

    await ownerClearIcon(id);
    expect((await readType(id)).display_hints?.icon).toBe("lucide:box");
  });

  it("keeps no icon in the definition when a read of a type that had none is written back", async () => {
    const id = `acme.${name()}`;
    await register(id);
    await ownerSetIcon(id, "lucide:package");
    const read = (await (
      await request(ctx.app, "GET", `/types/${id}`, { key: ctx.workingKey })
    ).json()) as Record<string, unknown>;
    expect(
      (
        await request(ctx.app, "PUT", `/types/${id}`, {
          key: ctx.workingKey,
          body: read,
        })
      ).status,
    ).toBe(200);
    await ownerClearIcon(id);
    expect((await readType(id)).display_hints?.icon).toBeUndefined();
  });

  it("does not freeze a hint a subtype inherits when its read is written back", async () => {
    const parent = `acme.${name()}`;
    const fields = { heading: { type: "string" }, text: { type: "string" } };
    await register(parent, {
      fields,
      display_hints: { title_field: "heading", icon: "lucide:folder" },
    });
    const child = `${parent}.kid`;
    await register(child, { parent, fields: {} });
    await ownerSetIcon(parent, "lucide:package");

    const read = (await (
      await request(ctx.app, "GET", `/types/${child}`, {
        key: ctx.workingKey,
      })
    ).json()) as Record<string, unknown>;
    expect(read.display_hints).toEqual({
      title_field: "heading",
      icon: "lucide:package",
    });
    const written = await request(ctx.app, "PUT", `/types/${child}`, {
      key: ctx.workingKey,
      body: read,
    });
    expect(written.status, JSON.stringify(await written.clone().json())).toBe(
      200,
    );

    // The child still follows its parent: the owner's icon clears, and the
    // author changes the title.
    await ownerClearIcon(parent);
    const changed = await replace(parent, {
      fields,
      display_hints: { title_field: "text", icon: "lucide:folder" },
    });
    expect(changed.status).toBe(200);
    expect((await readType(child)).display_hints).toEqual({
      title_field: "text",
      icon: "lucide:folder",
    });
  });

  it("keeps a hint a subtype sets differently from its parent when its read is written back", async () => {
    const parent = `acme.${name()}`;
    const fields = { heading: { type: "string" }, text: { type: "string" } };
    await register(parent, {
      fields,
      display_hints: { title_field: "heading", icon: "lucide:folder" },
    });
    const child = `${parent}.own`;
    await register(child, {
      parent,
      fields: {},
      display_hints: { title_field: "text", icon: "lucide:star" },
    });
    await ownerSetIcon(parent, "lucide:package");

    const read = (await (
      await request(ctx.app, "GET", `/types/${child}`, {
        key: ctx.workingKey,
      })
    ).json()) as Record<string, unknown>;
    expect(
      (
        await request(ctx.app, "PUT", `/types/${child}`, {
          key: ctx.workingKey,
          body: read,
        })
      ).status,
    ).toBe(200);
    await ownerClearIcon(parent);
    expect((await readType(child)).display_hints).toEqual({
      title_field: "text",
      icon: "lucide:star",
    });
    const listed = await listedType(child);
    expect(listed?.display_hints).toEqual({
      title_field: "text",
      icon: "lucide:star",
    });
  });

  it("normalizes on the author's side: resolved_type carries the author's icon, not the owner's", async () => {
    const id = `acme.${name()}`;
    await register(id, { display_hints: { icon: "lucide:box" } });
    await ownerSetIcon(id, "lucide:package");
    const res = await request(ctx.app, "POST", "/types/normalize", {
      key: ctx.workingKey,
      body: { id, fields: { title: { type: "string" } } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      registered_type: TypeBody;
      resolved_type: TypeBody;
    };
    expect(body.registered_type.display_hints?.icon).toBe("lucide:box");
    expect(body.resolved_type.display_hints?.icon).toBe("lucide:box");
  });

  it("inherits to a subtype with no icon of its own, and yields to one with its own", async () => {
    const parent = `acme.${name()}`;
    await register(parent, { display_hints: { icon: "lucide:folder" } });
    await register(`${parent}.plain`, { parent, fields: {} });
    await register(`${parent}.own`, {
      parent,
      fields: {},
      display_hints: { icon: "lucide:star" },
    });
    await ownerSetIcon(parent, "lucide:archive");

    expect((await readType(`${parent}.plain`)).display_hints?.icon).toBe(
      "lucide:archive",
    );
    expect((await readType(`${parent}.own`)).display_hints?.icon).toBe(
      "lucide:star",
    );
    // A list shows each type as it is set; the reader resolves the rest.
    expect((await listedType(parent))?.display_hints?.icon).toBe(
      "lucide:archive",
    );
    expect(
      (await listedType(`${parent}.plain`))?.display_hints?.icon,
    ).toBeUndefined();

    // The owner's choice for the subtype itself beats the parent's.
    await ownerSetIcon(`${parent}.plain`, "lucide:book");
    expect((await readType(`${parent}.plain`)).display_hints?.icon).toBe(
      "lucide:book",
    );
  });

  it("goes with the type when the type is deleted, and doesn't block the delete", async () => {
    const id = `acme.${name()}`;
    await register(id, { display_hints: { icon: "lucide:box" } });
    await ownerSetIcon(id, "lucide:package");
    const deleted = await request(ctx.app, "DELETE", `/types/${id}`, {
      key: ctx.workingKey,
    });
    expect(deleted.status).toBe(200);
    await register(id, { display_hints: { icon: "lucide:archive" } });
    expect((await readType(id)).display_hints?.icon).toBe("lucide:archive");
  });

  it("is open to a key with schema.write and write on the type, and to no other", async () => {
    const id = `acme.${name()}`;
    await register(id);
    const call = (key: string, method: "PUT" | "DELETE") =>
      request(ctx.app, method, `/types/${id}/icon`, {
        key,
        ...(method === "PUT" ? { body: { icon: "lucide:box" } } : {}),
      });

    const writer = await mintWorkingKey(ctx, {
      permissions: ["schema.write"],
      type_permissions: { "acme.*": "write" },
    });
    expect((await call(writer, "PUT")).status).toBe(200);
    expect((await readType(id)).display_hints?.icon).toBe("lucide:box");
    expect((await call(writer, "DELETE")).status).toBe(200);

    const noPermission = await mintWorkingKey(ctx, {
      permissions: [],
      metadata_permissions: { types: "write" },
      type_permissions: { "acme.*": "write" },
    });
    const forbidden = await call(noPermission, "PUT");
    expect(forbidden.status).toBe(403);
    expect((await errorOf(forbidden)).code).toBe("forbidden");

    const outsideMap = await mintWorkingKey(ctx, {
      permissions: ["schema.write"],
      type_permissions: { "mine.*": "write" },
    });
    const refused = await call(outsideMap, "PUT");
    expect(refused.status).toBe(403);
    expect((await errorOf(refused)).code).toBe("type_not_permitted");
    expect((await readType(id)).display_hints?.icon).toBeUndefined();
  });

  it("is open to a connector's key holding schema.write on the type, as to any other key", async () => {
    const id = `acme.${name()}`;
    await register(id);
    const connectorKey = await mintWorkingKey(ctx, {
      permissions: ["schema.write"],
      type_permissions: { "acme.*": "write" },
    });
    const registered = await request(ctx.app, "POST", "/connectors", {
      key: connectorKey,
      body: { name: "Icon test connector" },
    });
    expect(registered.status).toBe(201);

    const set = await request(ctx.app, "PUT", `/types/${id}/icon`, {
      key: connectorKey,
      body: { icon: "lucide:box" },
    });
    expect(set.status).toBe(200);
    expect((await readType(id)).display_hints?.icon).toBe("lucide:box");
    const cleared = await request(ctx.app, "DELETE", `/types/${id}/icon`, {
      key: connectorKey,
    });
    expect(cleared.status).toBe(200);
    expect((await readType(id)).display_hints?.icon).toBeUndefined();

    // A connector key without schema.write is refused like any other key.
    const bare = await mintWorkingKey(ctx, {
      permissions: [],
      metadata_permissions: { types: "write" },
      type_permissions: { "acme.*": "write" },
    });
    await request(ctx.app, "POST", "/connectors", {
      key: bare,
      body: { name: "Bare connector" },
    });
    const refused = await request(ctx.app, "PUT", `/types/${id}/icon`, {
      key: bare,
      body: { icon: "lucide:box" },
    });
    expect(refused.status).toBe(403);
  });
});

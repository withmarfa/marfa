import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
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

async function errorOf(
  res: Response,
): Promise<{ code: string; details?: { errors?: { field: string }[] } }> {
  return ((await res.json()) as { error: never }).error;
}

describe("display_hints.icon on a type's definition", () => {
  it("is taken, read back and refused when it is not a Lucide name", async () => {
    const id = `acme.${name()}`;
    expect(
      (await register(id, { display_hints: { icon: "calendar-days" } })).status,
    ).toBe(201);
    expect((await readType(id)).display_hints).toEqual({
      icon: "calendar-days",
    });

    for (const icon of ["Calendar", "github", "calendar_days", "", 3]) {
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
    expect((await readType(id)).display_hints?.icon).toBe("calendar-days");
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
      display_hints: { icon: "star" },
    });
    expect((await readType(child)).display_hints).toEqual({
      title_field: "title",
      icon: "star",
    });
  });
});

describe("PUT and DELETE /types/{id}/icon", () => {
  it("answers the owner's icon in place of the author's, and the author's again once cleared", async () => {
    const before = await readType("core.note");
    expect(before.display_hints?.icon).toBe("sticky-note");

    const set = await ownerSetIcon("core.note", "notebook-pen");
    expect(set.status).toBe(200);
    expect(
      ((await set.json()) as { type: TypeBody }).type.display_hints?.icon,
    ).toBe("notebook-pen");
    expect((await readType("core.note")).display_hints?.icon).toBe(
      "notebook-pen",
    );
    expect((await listedType("core.note"))?.display_hints?.icon).toBe(
      "notebook-pen",
    );

    const cleared = await ownerClearIcon("core.note");
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as { type: TypeBody }).type.display_hints?.icon,
    ).toBe("sticky-note");
    expect((await readType("core.note")).display_hints?.icon).toBe(
      "sticky-note",
    );
    // Clearing again changes nothing.
    expect((await ownerClearIcon("core.note")).status).toBe(200);
  });

  it("refuses a name that is not in the pinned release, and keeps the earlier choice", async () => {
    const id = `acme.${name()}`;
    await register(id);
    expect((await ownerSetIcon(id, "map-pin")).status).toBe(200);
    for (const icon of ["MapPin", "github", "home-ish", " map-pin", ""]) {
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
    expect((await readType(id)).display_hints?.icon).toBe("map-pin");
  });

  it("refuses a type that doesn't exist", async () => {
    const res = await ownerSetIcon("acme.nothing_here", "box");
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("type_not_found");
    expect((await ownerClearIcon("acme.nothing_here")).status).toBe(404);
  });

  it("survives the author replacing the type, and the replacement does not copy it into the author's icon", async () => {
    const id = `acme.${name()}`;
    await register(id, { display_hints: { icon: "box" } });
    await ownerSetIcon(id, "package");

    const replaced = await replace(id, {
      label: "Replaced",
      display_hints: { icon: "archive" },
    });
    expect(replaced.status).toBe(200);
    // The answer to the replacement already shows the owner's choice.
    expect(
      ((await replaced.json()) as { type: TypeBody }).type.display_hints?.icon,
    ).toBe("package");
    expect((await readType(id)).display_hints?.icon).toBe("package");

    await ownerClearIcon(id);
    // What the author wrote last is what shows again.
    expect((await readType(id)).display_hints?.icon).toBe("archive");
  });

  it("inherits to a subtype with no icon of its own, and yields to one with its own", async () => {
    const parent = `acme.${name()}`;
    await register(parent, { display_hints: { icon: "folder" } });
    await register(`${parent}.plain`, { parent, fields: {} });
    await register(`${parent}.own`, {
      parent,
      fields: {},
      display_hints: { icon: "star" },
    });
    await ownerSetIcon(parent, "archive");

    expect((await readType(`${parent}.plain`)).display_hints?.icon).toBe(
      "archive",
    );
    expect((await readType(`${parent}.own`)).display_hints?.icon).toBe("star");
    // A list shows each type as it is set; the reader resolves the rest.
    expect((await listedType(parent))?.display_hints?.icon).toBe("archive");
    expect(
      (await listedType(`${parent}.plain`))?.display_hints?.icon,
    ).toBeUndefined();

    // The owner's choice for the subtype itself beats the parent's.
    await ownerSetIcon(`${parent}.plain`, "book");
    expect((await readType(`${parent}.plain`)).display_hints?.icon).toBe(
      "book",
    );
  });

  it("goes with the type when the type is deleted, and doesn't block the delete", async () => {
    const id = `acme.${name()}`;
    await register(id, { display_hints: { icon: "box" } });
    await ownerSetIcon(id, "package");
    const deleted = await request(ctx.app, "DELETE", `/types/${id}`, {
      key: ctx.workingKey,
    });
    expect(deleted.status).toBe(200);
    await register(id, { display_hints: { icon: "archive" } });
    expect((await readType(id)).display_hints?.icon).toBe("archive");
  });

  it("is open to a key with schema.write and write on the type, and to no other", async () => {
    const id = `acme.${name()}`;
    await register(id);
    const call = (key: string, method: "PUT" | "DELETE") =>
      request(ctx.app, method, `/types/${id}/icon`, {
        key,
        ...(method === "PUT" ? { body: { icon: "box" } } : {}),
      });

    const writer = await mintWorkingKey(ctx, {
      permissions: ["schema.write"],
      type_permissions: { "acme.*": "write" },
    });
    expect((await call(writer, "PUT")).status).toBe(200);
    expect((await readType(id)).display_hints?.icon).toBe("box");
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

  it("is refused to a connector's key, even one holding schema.write", async () => {
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

    for (const method of ["PUT", "DELETE"] as const) {
      const res = await request(ctx.app, method, `/types/${id}/icon`, {
        key: connectorKey,
        ...(method === "PUT" ? { body: { icon: "box" } } : {}),
      });
      expect(res.status, method).toBe(403);
      expect((await errorOf(res)).code).toBe("forbidden");
    }
    expect((await readType(id)).display_hints?.icon).toBeUndefined();

    // The connector still replaces its own type, and the owner's choice holds.
    await ownerSetIcon(id, "package");
    expect((await replace(id, { label: "Again" }, connectorKey)).status).toBe(
      200,
    );
    expect((await readType(id)).display_hints?.icon).toBe("package");
  });
});

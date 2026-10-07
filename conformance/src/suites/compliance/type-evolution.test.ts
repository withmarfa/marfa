import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { ApiResponse, TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  trackType,
  cleanup,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "type-evolution",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

type Definition = Record<string, unknown>;

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** A publisher namespace no other run holds. */
function namespace(label: string): string {
  return `evolve-${label}-${unique()}`;
}

async function keyFor(
  label: string,
  grants: {
    permissions?: string[];
    metadata?: boolean;
    types: Record<string, "read" | "write">;
  },
): Promise<MarfaClient> {
  const made = await client.createKey({
    label: `type-evolution-${label}`,
    source: `${ctx.source}-type-evolution-${label}-${unique()}`,
    permissions: grants.permissions ?? [],
    metadata_permissions: grants.metadata === false ? {} : { types: "write" },
    type_permissions: grants.types,
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackKey(ctx, made.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: made.data.key });
}

/** A key shaped like a connector's: `metadata.types:write`, a type map
 *  reaching its own namespace, and no permission. */
function connector(ns: string): Promise<MarfaClient> {
  return keyFor(`connector-${ns}`, { types: { [`${ns}.*`]: "write" } });
}

/** The same reach with `schema.write` beside it. */
function curator(ns: string): Promise<MarfaClient> {
  return keyFor(`curator-${ns}`, {
    permissions: ["schema.write"],
    types: { [`${ns}.*`]: "write" },
  });
}

/** Register through `as`, and leave removal to the shared cleanup, which
 *  deletes children before their parents. */
async function register(as: MarfaClient, body: Definition): Promise<void> {
  const res = await as.registerType(body as never);
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  trackType(ctx, body.id as string, client, body.parent as string | undefined);
}

function issue(id: string): Definition {
  return {
    id,
    version: 1,
    parent: "core.task",
    label: "Issue",
    description: "An issue at the vendor.",
    fields: {
      issue_id: { type: "string" },
      vendor_state: { type: "string" },
      legacy: { type: "string" },
      rank: { type: "integer" },
    },
    display_hints: { title_field: "issue_id" },
    link_field: "issue_id",
    version_policy: { max_versions: 50 },
    merge_policy: { fields: { vendor_state: "last_writer_wins" } },
    roles: ["container"],
  };
}

function replaced(id: string, change: Definition): Definition {
  const { id: _id, ...rest } = issue(id);
  return { ...rest, ...change };
}

function fieldsOf(id: string): Promise<string[]> {
  return client
    .getType(id)
    .then((r) => Object.keys(r.data.fields as Record<string, unknown>));
}

function refusal(res: ApiResponse<unknown>) {
  return res.error?.error;
}

describe("a key whose type map reaches a type evolves it", () => {
  it("adds an optional field and changes the label, description and display hints, with metadata.types:write alone", async () => {
    const ns = namespace("evolve");
    const id = `${ns}.issue`;
    const own = await connector(ns);
    await register(own, issue(id));
    const fields = issue(id).fields as Definition;

    const added = await own.replaceType(
      id,
      replaced(id, {
        fields: { ...fields, labels: { type: "array", items_type: "string" } },
      }),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(200);
    await expectMatchesSchema("PUT", "/types/{id}", 200, added.data);
    expect(await fieldsOf(id)).toContain("labels");

    const presentational = await own.replaceType(
      id,
      replaced(id, {
        label: "Vendor issue",
        description: "An issue, as the vendor reports it.",
        display_hints: { title_field: "vendor_state" },
        fields: { ...fields, labels: { type: "array", items_type: "string" } },
      }),
    );
    expect(presentational.status, JSON.stringify(presentational.error)).toBe(
      200,
    );
    const after = await client.getType(id);
    expect(after.data.label).toBe("Vendor issue");
    expect(after.data.display_hints).toEqual({ title_field: "vendor_state" });
  });

  const NEEDS_SCHEMA_WRITE: [string, (id: string) => Definition, string][] = [
    [
      "a link_field",
      (id) =>
        replaced(id, {
          fields: {
            ...(issue(id).fields as Definition),
            external_id: { type: "string" },
          },
          link_field: "external_id",
        }),
      "link_field",
    ],
    [
      "a version_policy",
      (id) => replaced(id, { version_policy: { max_versions: 1 } }),
      "version_policy",
    ],
    [
      "a merge_policy",
      (id) =>
        replaced(id, {
          merge_policy: { fields: { vendor_state: "keep_both_copies" } },
        }),
      "merge_policy",
    ],
    ["the roles", (id) => replaced(id, { roles: [] }), "roles"],
    ["the parent", (id) => replaced(id, { parent: "core.note" }), "parent"],
    [
      "removing a field it declares",
      (id) => {
        const { legacy: _legacy, ...kept } = issue(id).fields as Definition;
        return replaced(id, { fields: kept });
      },
      "fields.legacy",
    ],
    [
      "adding a required field",
      (id) =>
        replaced(id, {
          fields: {
            ...(issue(id).fields as Definition),
            severity: { type: "string", required: true },
          },
        }),
      "fields.severity",
    ],
    [
      "the shape of a field it keeps",
      (id) =>
        replaced(id, {
          fields: {
            ...(issue(id).fields as Definition),
            rank: { type: "string" },
          },
        }),
      "fields.rank",
    ],
  ];

  it.each(NEEDS_SCHEMA_WRITE)(
    "refuses %s to a key without schema.write, naming it, and lands it for a key with schema.write",
    async (_what, build, named) => {
      const ns = namespace("refuse");
      const id = `${ns}.issue`;
      const own = await connector(ns);
      await register(own, issue(id));
      const before = (await client.getType(id)).data;

      const refused = await own.replaceType(id, build(id));
      expect(refused.status).toBe(403);
      expect(refusal(refused)?.code).toBe("forbidden");
      expect(refusal(refused)?.details?.required_scope).toBe("schema.write");
      expect(refusal(refused)?.details?.changes).toContain(named);
      await expectMatchesSchema("PUT", "/types/{id}", 403, refused.error);
      expect((await client.getType(id)).data).toEqual(before);

      // The witness: the replacement is one the door takes.
      const landed = await (await curator(ns)).replaceType(id, build(id));
      expect(landed.status, JSON.stringify(landed.error)).toBe(200);
      expect((await client.getType(id)).data).not.toEqual(before);
    },
  );

  /** A type whose kept fields each carry something a replacement can
   *  change: a requirement, a bound, a set of values, an element type. */
  function shaped(id: string): Definition {
    return {
      id,
      version: 1,
      fields: {
        body: { type: "string", required: true },
        flag: { type: "string", required: true },
        title: { type: "string" },
        notes: { type: "string", maxLength: 100 },
        status: { type: "enum", enum_values: ["open", "closed"] },
        tags: { type: "array", items_type: "string", maxItems: 5 },
        locale: { type: "string" },
        hidden: { type: "string", searchable: false },
        visible: { type: "string" },
      },
    };
  }

  /** The replacement of `shaped` with one kept field's definition swapped,
   *  or a member of the type changed. */
  function reshaped(
    id: string,
    change: { field?: [string, Definition]; member?: Definition },
  ): Definition {
    const { id: _id, ...rest } = shaped(id);
    const fields = { ...(rest.fields as Definition) };
    if (change.field) fields[change.field[0]] = change.field[1];
    return { ...rest, fields, ...change.member };
  }

  const KEPT_SHAPE_CHANGES: {
    what: string;
    change: Parameters<typeof reshaped>[1];
    named: string;
  }[] = [
    {
      what: "compatible_with",
      change: { member: { compatible_with: "core.note" } },
      named: "compatible_with",
    },
    {
      what: "a maxLength",
      change: { field: ["notes", { type: "string", maxLength: 50 }] },
      named: "fields.notes",
    },
    {
      what: "the enum_values",
      change: {
        field: ["status", { type: "enum", enum_values: ["open", "done"] }],
      },
      named: "fields.status",
    },
    {
      what: "a maxItems",
      change: {
        field: ["tags", { type: "array", items_type: "string", maxItems: 6 }],
      },
      named: "fields.tags",
    },
    {
      what: "the items_type",
      change: {
        field: ["tags", { type: "array", items_type: "number", maxItems: 5 }],
      },
      named: "fields.tags",
    },
    {
      what: "a format",
      change: { field: ["locale", { type: "string", format: "bcp47" }] },
      named: "fields.locale",
    },
    {
      what: "a field no longer required",
      change: { field: ["flag", { type: "string" }] },
      named: "fields.flag",
    },
    {
      what: "a field made required",
      change: { field: ["title", { type: "string", required: true }] },
      named: "fields.title",
    },
    {
      what: "a field made searchable",
      change: { field: ["hidden", { type: "string", searchable: true }] },
      named: "fields.hidden",
    },
    {
      what: "a field made unsearchable",
      change: { field: ["visible", { type: "string", searchable: false }] },
      named: "fields.visible",
    },
  ];

  it.each(KEPT_SHAPE_CHANGES)(
    "refuses a change to compatible_with, a kept field's constraint, required or searchable to a key without schema.write, and lands it with it",
    async ({ what, change, named }) => {
      const ns = namespace("shape");
      const id = `${ns}.shaped`;
      const own = await connector(ns);
      await register(own, shaped(id));
      const before = (await client.getType(id)).data;

      const refused = await own.replaceType(id, reshaped(id, change));
      expect(refused.status, what).toBe(403);
      expect(refusal(refused)?.code, what).toBe("forbidden");
      expect(refusal(refused)?.details?.required_scope, what).toBe(
        "schema.write",
      );
      expect(refusal(refused)?.details?.changes, what).toEqual([named]);
      expect((await client.getType(id)).data, what).toEqual(before);

      // The witness: the replacement is one the door takes.
      const landed = await (
        await curator(ns)
      ).replaceType(id, reshaped(id, change));
      expect(landed.status, `${what}: ${JSON.stringify(landed.error)}`).toBe(
        200,
      );
      expect((await client.getType(id)).data, what).not.toEqual(before);
    },
  );

  it("admits a change to the version and to a kept field's description on metadata.types:write alone", async () => {
    const ns = namespace("free");
    const id = `${ns}.issue`;
    const own = await connector(ns);
    await register(own, issue(id));

    const versioned = await own.replaceType(id, replaced(id, { version: 2 }));
    expect(versioned.status, JSON.stringify(versioned.error)).toBe(200);
    expect((await client.getType(id)).data.version).toBe(2);

    const fields = issue(id).fields as Definition;
    const described = await own.replaceType(
      id,
      replaced(id, {
        version: 2,
        fields: {
          ...fields,
          rank: { type: "integer", description: "Where it sits in the queue." },
        },
      }),
    );
    expect(described.status, JSON.stringify(described.error)).toBe(200);
    expect((await client.getType(id)).data.fields.rank).toEqual({
      type: "integer",
      description: "Where it sits in the queue.",
    });
  });

  it("lists every change that needs schema.write, sorted", async () => {
    const ns = namespace("sorted");
    const id = `${ns}.issue`;
    const own = await connector(ns);
    await register(own, issue(id));
    const { legacy: _legacy, ...kept } = issue(id).fields as Definition;

    const refused = await own.replaceType(
      id,
      replaced(id, {
        fields: kept,
        merge_policy: { fields: { vendor_state: "keep_both_copies" } },
      }),
    );
    expect(refused.status).toBe(403);
    expect(refusal(refused)?.code).toBe("forbidden");
    expect(refusal(refused)?.details?.changes).toEqual(
      ["merge_policy", "fields.legacy"].sort(),
    );
    expect(await fieldsOf(id)).toContain("legacy");

    // The witness: each change on its own is named alone.
    const removal = await own.replaceType(id, replaced(id, { fields: kept }));
    expect(refusal(removal)?.details?.changes).toEqual(["fields.legacy"]);
  });

  it("refuses a field whose name a stored row holds, in any lifecycle state, and lands it for a key with schema.write", async () => {
    const ns = namespace("held");
    const id = `${ns}.entry`;
    const own = await connector(ns);
    await register(own, { id, fields: { title: { type: "string" } } });
    const states = [undefined, "archived", "trashed"] as const;
    for (const [index, state] of states.entries()) {
      const made = await client.createItem({
        type: id,
        properties: { title: "t", [`held_${String(index)}`]: "x" },
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      trackItem(ctx, made.data.item.id);
      if (state !== undefined) {
        const moved =
          state === "trashed"
            ? await client.deleteItem(made.data.item.id)
            : await client.transitionItem(made.data.item.id, state);
        expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
      }
    }
    const withFields = (name: string) => ({
      fields: { title: { type: "string" }, [name]: { type: "string" } },
    });

    for (const name of ["held_0", "held_1", "held_2"]) {
      const refused = await own.replaceType(id, withFields(name));
      expect(refused.status, name).toBe(403);
      expect(refusal(refused)?.code).toBe("forbidden");
      expect(refusal(refused)?.details?.required_scope).toBe("schema.write");
      expect(refusal(refused)?.details?.changes).toEqual([`fields.${name}`]);
    }
    expect(await fieldsOf(id)).not.toContain("held_0");

    // The witnesses: a name no row holds lands, and a held one lands for a key
    // with schema.write.
    expect((await own.replaceType(id, withFields("fresh"))).status).toBe(200);
    const landed = await (
      await curator(ns)
    ).replaceType(id, {
      fields: { title: { type: "string" }, held_0: { type: "string" } },
    });
    expect(landed.status, JSON.stringify(landed.error)).toBe(200);
  });

  it("refuses a field whose name only a row of a subtype holds", async () => {
    const ns = namespace("subtype");
    const base = `${ns}.base`;
    const leaf = `${ns}.leaf`;
    const own = await connector(ns);
    await register(own, { id: base, fields: { title: { type: "string" } } });
    await register(own, {
      id: leaf,
      parent: base,
      fields: { size: { type: "integer" } },
    });
    const made = await client.createItem({
      type: leaf,
      properties: { title: "t", inherited: "x" },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);

    const refused = await own.replaceType(base, {
      fields: { title: { type: "string" }, inherited: { type: "string" } },
    });
    expect(refused.status).toBe(403);
    expect(refusal(refused)?.code).toBe("forbidden");
    expect(refusal(refused)?.details?.changes).toEqual(["fields.inherited"]);

    // The witness: a name no row of either type holds lands.
    const landed = await own.replaceType(base, {
      fields: { title: { type: "string" }, fresh: { type: "string" } },
    });
    expect(landed.status, JSON.stringify(landed.error)).toBe(200);
  });

  it("refuses bringing a removed field back, which would reshape the values rows still hold", async () => {
    const ns = namespace("readd");
    const id = `${ns}.entry`;
    const own = await connector(ns);
    const shapes = {
      title: { type: "string" },
      secret: { type: "string", searchable: false },
    };
    await register(own, { id, fields: shapes });
    const made = await client.createItem({
      type: id,
      properties: { title: "t", secret: "hidden" },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);

    const withoutSecret = { fields: { title: { type: "string" } } };
    const removing = await own.replaceType(id, withoutSecret);
    expect(removing.status).toBe(403);
    expect(refusal(removing)?.details?.changes).toEqual(["fields.secret"]);

    expect(
      (await (await curator(ns)).replaceType(id, withoutSecret)).status,
    ).toBe(200);
    const bringingBack = await own.replaceType(id, {
      fields: { title: { type: "string" }, secret: { type: "string" } },
    });
    expect(bringingBack.status).toBe(403);
    expect(refusal(bringingBack)?.details?.changes).toEqual(["fields.secret"]);
    expect(await fieldsOf(id)).not.toContain("secret");
  });

  it("leaves a removed field's values readable and the row writable", async () => {
    const ns = namespace("kept");
    const id = `${ns}.entry`;
    const curated = await curator(ns);
    await register(curated, {
      id,
      fields: { title: { type: "string" }, rank: { type: "integer" } },
    });
    const made = await client.createItem({
      type: id,
      properties: { title: "t", rank: 5 },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);
    expect(
      (await curated.replaceType(id, { fields: { title: { type: "string" } } }))
        .status,
    ).toBe(200);

    const read = await client.getItem(made.data.item.id);
    expect(read.data.item.properties).toEqual({ title: "t", rank: 5 });
    const patched = await client.updateItem(made.data.item.id, {
      version: read.data.item.version,
      properties: { title: "u" },
    });
    expect(patched.status, JSON.stringify(patched.error)).toBe(200);
    expect(patched.data.item.properties).toEqual({ title: "u", rank: 5 });
  });

  it("refuses the delete to a key without schema.write, force included", async () => {
    const ns = namespace("delete");
    const id = `${ns}.issue`;
    const own = await connector(ns);
    await register(own, issue(id));
    for (const force of [false, true]) {
      const refused = await own.deleteType(id, force);
      expect(refused.status, `force=${String(force)}`).toBe(403);
      expect(refusal(refused)?.code).toBe("forbidden");
      expect(refusal(refused)?.details?.required_scope).toBe("schema.write");
      expect((await client.getType(id)).status).toBe(200);
    }
    // The witness: a key with the permission deletes it.
    expect((await (await curator(ns)).deleteType(id)).status).toBe(200);
  });

  it("holds a key with metadata.types:write alone to the type map, and a key with neither permission out", async () => {
    const ns = namespace("reach");
    const other = namespace("elsewhere");
    const id = `${ns}.issue`;
    await register(await curator(ns), issue(id));

    const refused = await (
      await connector(other)
    ).replaceType(id, replaced(id, {}));
    expect(refused.status).toBe(403);
    expect(refusal(refused)?.code).toBe("type_not_permitted");
    expect(refusal(refused)?.message).toContain(id);

    const bare = await keyFor(`bare-${ns}`, {
      metadata: false,
      types: { [`${ns}.*`]: "write" },
    });
    const noPermission = await bare.replaceType(id, replaced(id, {}));
    expect(noPermission.status).toBe(403);
    expect(refusal(noPermission)?.code).toBe("forbidden");
    expect(refusal(noPermission)?.details?.required_scope).toBe("schema.write");

    // The witness: the same replacement lands for the key that owns the type.
    expect(
      (await (await connector(ns)).replaceType(id, replaced(id, {}))).ok,
    ).toBe(true);
  });
});

describe("a change to a parent is judged against the subtypes it has", () => {
  it("takes fields named like an object's built-in members", async () => {
    const ns = namespace("builtin");
    const curated = await curator(ns);
    await register(curated, {
      id: `${ns}.base`,
      fields: { title: { type: "string" } },
    });
    await register(curated, {
      id: `${ns}.leaf`,
      parent: `${ns}.base`,
      fields: { extra: { type: "string" } },
    });
    const grown = await curated.replaceType(`${ns}.base`, {
      fields: {
        title: { type: "string" },
        constructor: { type: "string" },
        toString: { type: "string" },
      },
    });
    expect(grown.status, JSON.stringify(grown.error)).toBe(200);
  });

  it("refuses removing a field a subtype's display hints or merge policy name, naming both", async () => {
    const ns = namespace("hints");
    const curated = await curator(ns);
    const base = `${ns}.base`;
    const leaf = `${ns}.leaf`;
    await register(curated, {
      id: base,
      fields: { title: { type: "string" }, flag: { type: "string" } },
    });
    await register(curated, {
      id: leaf,
      parent: base,
      fields: { extra: { type: "string" } },
      display_hints: { title_field: "flag" },
      merge_policy: { fields: { flag: "keep_both_copies" } },
    });
    const refused = await curated.replaceType(base, {
      fields: { title: { type: "string" } },
    });
    expect(refused.status).toBe(400);
    expect(refusal(refused)?.code).toBe("invalid_schema");
    const text = JSON.stringify(refused.error);
    expect(text).toContain(leaf);
    expect(text).toContain("display_hints.title_field");
    expect(text).toContain("merge_policy.fields");
    await expectMatchesSchema("PUT", "/types/{id}", 400, refused.error);
    expect(await fieldsOf(base)).toContain("flag");

    // The witness: once the subtype stops naming it, the field goes.
    expect(
      (
        await curated.replaceType(leaf, {
          parent: base,
          fields: { extra: { type: "string" } },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await curated.replaceType(base, {
          fields: { title: { type: "string" } },
        })
      ).ok,
    ).toBe(true);
  });
});

describe("a parent is named only within the key's reach", () => {
  it("refuses a registration naming a parent the key may not write, and takes it once the map reaches the parent", async () => {
    const owner = namespace("owner");
    const other = namespace("other");
    const parent = `${owner}.base`;
    await register(await connector(owner), {
      id: parent,
      fields: { name: { type: "string" } },
    });

    const child = `${other}.child`;
    const body = { id: child, parent, fields: { size: { type: "integer" } } };
    const own = await connector(other);
    const refused = await own.registerType(body as never);
    expect(refused.status).toBe(403);
    expect(refusal(refused)?.code).toBe("type_not_permitted");
    expect(refusal(refused)?.message).toContain(parent);
    expect(refusal(refused)?.details?.grant).toEqual({
      kind: "type",
      name: parent,
      level: "write",
    });
    await expectMatchesSchema("POST", "/types", 403, refused.error);
    expect((await client.getType(child)).status).toBe(404);

    // Read on the parent is not enough.
    const readOnly = await keyFor(`read-${other}`, {
      types: { [`${other}.*`]: "write", [parent]: "read" },
    });
    expect((await readOnly.registerType(body as never)).status).toBe(403);

    // The witness: the same body registers for a key reaching both.
    const both = await keyFor(`both-${other}`, {
      types: { [`${other}.*`]: "write", [parent]: "write" },
    });
    await register(both, body);

    // What the refusal protects: the owner's parent is not pinned by a type
    // the owner's reach does not include, so it stays deletable once its
    // subtypes go.
    const blocked = await (await curator(owner)).deleteType(parent);
    expect(refusal(blocked)?.code).toBe("type_has_subtypes");
  });

  it("exempts platform-shipped parents", async () => {
    const ns = namespace("platform");
    const own = await connector(ns);
    for (const parent of ["core.task", "core.entity.person", "system.folder"]) {
      await register(own, {
        id: `${ns}.${parent.replaceAll(".", "-")}`,
        parent,
        fields: { size: { type: "integer" } },
      });
    }
  });

  it("asks write on a parent nothing registered, before saying it is unknown", async () => {
    const ns = namespace("ghost");
    const elsewhere = namespace("nowhere");
    const parent = `${elsewhere}.missing`;
    const body = {
      id: `${ns}.child`,
      parent,
      fields: { size: { type: "integer" } },
    };
    expect((await client.getType(parent)).status).toBe(404);

    const refused = await (await connector(ns)).registerType(body as never);
    expect(refused.status).toBe(403);
    expect(refusal(refused)?.code).toBe("type_not_permitted");
    expect(refusal(refused)?.message).toContain(parent);
    expect(refusal(refused)?.details?.grant).toEqual({
      kind: "type",
      name: parent,
      level: "write",
    });
    expect((await client.getType(body.id)).status).toBe(404);

    // The witness: a key whose map reaches the parent is told it is unknown.
    const reaching = await keyFor(`ghost-reach-${ns}`, {
      types: { [`${ns}.*`]: "write", [parent]: "write" },
    });
    const unknown = await reaching.registerType(body as never);
    expect(unknown.status).toBe(400);
    expect(refusal(unknown)?.code).toBe("validation_error");
  });

  it("asks write on a core parent the server does not ship", async () => {
    const ns = namespace("core");
    const parent = `core.nothing-${unique()}`;
    const body = {
      id: `${ns}.child`,
      parent,
      fields: { size: { type: "integer" } },
    };

    const refused = await (await connector(ns)).registerType(body as never);
    expect(refused.status).toBe(403);
    expect(refusal(refused)?.code).toBe("type_not_permitted");
    expect(refusal(refused)?.message).toContain(parent);
    expect((await client.getType(body.id)).status).toBe(404);

    // The witness: a parent the server ships is not asked for, and a key
    // whose map reaches this one is told it is unknown.
    await register(await connector(ns), {
      id: `${ns}.shipped`,
      parent: "core.task",
      fields: { size: { type: "integer" } },
    });
    const reaching = await keyFor(`core-reach-${ns}`, {
      types: { [`${ns}.*`]: "write", [parent]: "write" },
    });
    const unknown = await reaching.registerType(body as never);
    expect(unknown.status).toBe(400);
    expect(refusal(unknown)?.code).toBe("validation_error");
  });

  it("holds a replacement that changes the parent to the key's reach, and leaves one that keeps its parent", async () => {
    const owner = namespace("owner");
    const mine = namespace("mine");
    const foreign = `${owner}.base`;
    await register(await curator(owner), {
      id: foreign,
      fields: { name: { type: "string" } },
    });
    // Registered before the reach was asked of a parent, by a key reaching
    // both.
    const wide = await keyFor(`wide-${mine}`, {
      permissions: ["schema.write"],
      types: { [`${mine}.*`]: "write", [foreign]: "write" },
    });
    const id = `${mine}.child`;
    await register(wide, {
      id,
      parent: foreign,
      fields: { size: { type: "integer" } },
    });

    // The type's own key keeps editing it while it keeps its parent.
    const own = await connector(mine);
    const kept = await own.replaceType(id, {
      parent: foreign,
      fields: { size: { type: "integer" }, more: { type: "string" } },
    });
    expect(kept.status, JSON.stringify(kept.error)).toBe(200);

    // A key holding schema.write whose map stops short of a new parent is
    // refused, naming it.
    const target = `${mine}.base`;
    const curated = await keyFor(`curator-${mine}`, {
      permissions: ["schema.write"],
      types: { [`${mine}.*`]: "write" },
    });
    await register(curated, {
      id: target,
      fields: { name: { type: "string" } },
    });
    const elsewhere = `${owner}.second`;
    await register(await curator(owner), {
      id: elsewhere,
      fields: { name: { type: "string" } },
    });
    const refused = await curated.replaceType(id, {
      parent: elsewhere,
      fields: { size: { type: "integer" } },
    });
    expect(refused.status).toBe(403);
    expect(refusal(refused)?.code).toBe("type_not_permitted");
    expect(refusal(refused)?.message).toContain(elsewhere);
    await expectMatchesSchema("PUT", "/types/{id}", 403, refused.error);
    expect((await client.getType(id)).data.parent).toBe(foreign);

    // Moving it to a parent the map reaches lands.
    const moved = await curated.replaceType(id, {
      parent: target,
      fields: { size: { type: "integer" } },
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expect((await client.getType(id)).data.parent).toBe(target);
  });

  it("refuses a key on metadata.types:write alone a change of parent as a schema change", async () => {
    const owner = namespace("owner");
    const mine = namespace("mine");
    const foreign = `${owner}.base`;
    await register(await curator(owner), {
      id: foreign,
      fields: { name: { type: "string" } },
    });
    const id = `${mine}.child`;
    await register(await curator(mine), {
      id,
      parent: "core.task",
      fields: { size: { type: "integer" } },
    });
    const change = { parent: foreign, fields: { size: { type: "integer" } } };

    const own = await connector(mine);
    const refused = await own.replaceType(id, change);
    expect(refused.status).toBe(403);
    expect(refusal(refused)?.code).toBe("forbidden");
    expect(refusal(refused)?.details?.required_scope).toBe("schema.write");
    expect(refusal(refused)?.details?.changes).toEqual(["parent"]);
    expect((await client.getType(id)).data.parent).toBe("core.task");

    // The witness: a key holding schema.write whose map stops short of the
    // parent is asked for write on it, and a key whose map reaches it lands
    // the change.
    const short = await curator(mine);
    const unreached = await short.replaceType(id, change);
    expect(refusal(unreached)?.code).toBe("type_not_permitted");
    const reaching = await keyFor(`reaching-${mine}`, {
      permissions: ["schema.write"],
      types: { [`${mine}.*`]: "write", [foreign]: "write" },
    });
    const landed = await reaching.replaceType(id, change);
    expect(landed.status, JSON.stringify(landed.error)).toBe(200);
    expect((await client.getType(id)).data.parent).toBe(foreign);

    // Back under a shipped parent, so teardown can delete the owner's type.
    const restored = await reaching.replaceType(id, {
      parent: "core.task",
      fields: { size: { type: "integer" } },
    });
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
  });
});

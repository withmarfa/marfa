/**
 * What a key that registers a type may do to it afterwards, and which parents
 * a registration or a replacement may name.
 *
 * A connector's key holds `metadata.types:write` and a type map reaching its
 * own namespace, and deliberately not `schema.write`. These tests drive that
 * shape through the real app: every change `PUT /types/{id}` admits it for,
 * every change it refuses, and a witness that `schema.write` still does each
 * refused one, so a refusal is never a request the door would have refused
 * anyway.
 */
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

const RUN = Math.random().toString(36).slice(2, 8);
let counter = 0;

/** A namespace no other test in the run holds. */
function namespace(label: string): string {
  counter += 1;
  return `${label}${RUN}${String(counter)}`;
}

type Definition = Record<string, unknown>;

interface Refusal {
  status: number;
  code: string | undefined;
  message: string;
  details: Record<string, unknown> | undefined;
}

async function refusal(res: Response): Promise<Refusal> {
  const body = (await res.json()) as {
    error?: {
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    };
  };
  return {
    status: res.status,
    code: body.error?.code,
    message: body.error?.message ?? "",
    details: body.error?.details,
  };
}

/** A key shaped like a connector's: it registers and evolves types in its
 *  own namespace, and holds no permission. */
function connectorKey(ns: string): Promise<string> {
  return mintWorkingKey(ctx, {
    permissions: [],
    metadata_permissions: { types: "write" },
    type_permissions: { [`${ns}.*`]: "write" },
  });
}

/** A key that holds `schema.write` beside the same reach. */
function schemaKey(ns: string): Promise<string> {
  return mintWorkingKey(ctx, {
    permissions: ["schema.write"],
    metadata_permissions: { types: "write" },
    type_permissions: { [`${ns}.*`]: "write" },
  });
}

async function register(key: string, body: Definition): Promise<Response> {
  return request(ctx.app, "POST", "/types", { key, body });
}

async function replace(
  key: string,
  id: string,
  body: Definition,
): Promise<Response> {
  return request(ctx.app, "PUT", `/types/${id}`, { key, body });
}

async function stored(id: string): Promise<Definition> {
  const res = await request(ctx.app, "GET", `/types/${id}`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Definition;
}

/** The definition a connector registers: a parent, a link, a policy of each
 *  kind, and every presentational member. */
function issueDefinition(id: string): Definition {
  return {
    id,
    version: 1,
    parent: "core.task",
    label: "Issue",
    description: "An issue at the vendor.",
    fields: {
      issue_id: { type: "string" },
      vendor_state: { type: "string", description: "The vendor's word." },
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

/** `value` without `key`. */
function without(value: Definition, key: string): Definition {
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
}

/** The same definition with `change` applied, as a full replacement. */
function replacement(id: string, change: Definition): Definition {
  return { ...without(issueDefinition(id), "id"), ...change };
}

describe("a key holding metadata.types:write evolves the types it registered", () => {
  it("registers a type under a platform parent, then adds a field, removes its own and relabels", async () => {
    const ns = namespace("evo");
    const key = await connectorKey(ns);
    const id = `${ns}.issue`;
    const created = await register(key, issueDefinition(id));
    expect(created.status, await created.clone().text()).toBe(201);

    const base = replacement(id, {});
    const fields = base.fields as Record<string, unknown>;

    // Adds a field, required or not.
    const added = await replace(
      key,
      id,
      replacement(id, {
        fields: {
          ...fields,
          labels: { type: "array", items_type: "string" },
          severity: { type: "string", required: true },
        },
      }),
    );
    expect(added.status, await added.clone().text()).toBe(200);
    expect(Object.keys((await stored(id)).fields as object)).toContain(
      "severity",
    );

    // Removes a field the type itself declares.
    const kept = without(fields, "legacy");
    const removed = await replace(
      key,
      id,
      replacement(id, {
        fields: {
          ...kept,
          labels: { type: "array", items_type: "string" },
          severity: { type: "string", required: true },
        },
      }),
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(Object.keys((await stored(id)).fields as object)).not.toContain(
      "legacy",
    );

    // Changes the label, the description, a field's description, the display
    // hints and the version, which change no row and no policy.
    const presentational = await replace(
      key,
      id,
      replacement(id, {
        label: "Vendor issue",
        description: "An issue, as the vendor reports it.",
        version: 2,
        display_hints: { title_field: "vendor_state" },
        fields: {
          ...kept,
          vendor_state: { type: "string", description: "Reworded." },
          labels: { type: "array", items_type: "string" },
          severity: { type: "string", required: true },
        },
      }),
    );
    expect(presentational.status, await presentational.clone().text()).toBe(
      200,
    );
    const after = await stored(id);
    expect(after.label).toBe("Vendor issue");
    expect(after.version).toBe(2);
    expect(after.display_hints).toEqual({ title_field: "vendor_state" });
  });

  it("takes a resubmission with no change", async () => {
    const ns = namespace("same");
    const key = await connectorKey(ns);
    const id = `${ns}.issue`;
    expect((await register(key, issueDefinition(id))).status).toBe(201);
    const res = await replace(key, id, replacement(id, {}));
    expect(res.status, await res.clone().text()).toBe(200);
  });

  /**
   * Each change is a replacement the door refuses a key without
   * `schema.write`, and the same replacement a key with it lands. The
   * witness is the point: without it a refusal could be the validator's.
   */
  const SCHEMA_WRITE_ONLY: [string, (id: string) => Definition, string][] = [
    [
      "naming another link_field",
      (id) =>
        replacement(id, {
          fields: {
            ...(issueDefinition(id).fields as object),
            external_id: { type: "string" },
          },
          link_field: "external_id",
        }),
      "link_field",
    ],
    [
      "withdrawing the link_field",
      (id) => without(replacement(id, {}), "link_field"),
      "link_field",
    ],
    [
      "changing the version_policy",
      (id) => replacement(id, { version_policy: { max_versions: 1 } }),
      "version_policy",
    ],
    [
      "withdrawing the version_policy",
      (id) => without(replacement(id, {}), "version_policy"),
      "version_policy",
    ],
    [
      "changing the merge_policy",
      (id) =>
        replacement(id, {
          merge_policy: { fields: { vendor_state: "keep_both_copies" } },
        }),
      "merge_policy",
    ],
    ["withdrawing the roles", (id) => replacement(id, { roles: [] }), "roles"],
    [
      "changing the parent",
      (id) => replacement(id, { parent: "core.note" }),
      "parent",
    ],
    [
      "withdrawing the parent",
      (id) => without(replacement(id, {}), "parent"),
      "parent",
    ],
    [
      "claiming compatible_with",
      (id) => replacement(id, { compatible_with: ["core.task"] }),
      "compatible_with",
    ],
    [
      "changing the shape of a field it declares",
      (id) =>
        replacement(id, {
          fields: {
            ...(issueDefinition(id).fields as object),
            rank: { type: "string" },
          },
        }),
      "fields.rank",
    ],
    [
      "making a field it declares required",
      (id) =>
        replacement(id, {
          fields: {
            ...(issueDefinition(id).fields as object),
            rank: { type: "integer", required: true },
          },
        }),
      "fields.rank",
    ],
    [
      "taking a field out of search",
      (id) =>
        replacement(id, {
          fields: {
            ...(issueDefinition(id).fields as object),
            vendor_state: { type: "string", searchable: false },
          },
        }),
      "fields.vendor_state",
    ],
  ];

  it.each(SCHEMA_WRITE_ONLY)(
    "refuses a key without schema.write %s, and a key with it lands the same replacement",
    async (_what, build, named) => {
      const ns = namespace("refuse");
      const key = await connectorKey(ns);
      const id = `${ns}.issue`;
      expect((await register(key, issueDefinition(id))).status).toBe(201);
      const before = await stored(id);

      const refused = await refusal(await replace(key, id, build(id)));
      expect(refused.status).toBe(403);
      expect(refused.code).toBe("forbidden");
      expect(refused.details?.required_scope).toBe("schema.write");
      expect(refused.details?.changes).toContain(named);
      expect(refused.message).toContain("schema.write");
      expect(refused.message).toContain(named);
      expect(await stored(id)).toEqual(before);

      const landed = await replace(await schemaKey(ns), id, build(id));
      expect(landed.status, await landed.clone().text()).toBe(200);
      expect(await stored(id)).not.toEqual(before);
    },
  );

  it("names every change that needs schema.write when one replacement makes several", async () => {
    const ns = namespace("several");
    const key = await connectorKey(ns);
    const id = `${ns}.issue`;
    expect((await register(key, issueDefinition(id))).status).toBe(201);
    const refused = await refusal(
      await replace(
        key,
        id,
        replacement(id, {
          label: "Renamed",
          version_policy: { max_versions: 1 },
          roles: [],
        }),
      ),
    );
    expect(refused.status).toBe(403);
    expect(refused.details?.changes).toEqual(["roles", "version_policy"]);
  });

  it("refuses the delete to a key without schema.write, force included, and a key with it deletes", async () => {
    const ns = namespace("del");
    const key = await connectorKey(ns);
    const id = `${ns}.issue`;
    expect((await register(key, issueDefinition(id))).status).toBe(201);
    for (const query of ["", "?force=true"]) {
      const refused = await refusal(
        await request(ctx.app, "DELETE", `/types/${id}${query}`, { key }),
      );
      expect(refused.status, query).toBe(403);
      expect(refused.code).toBe("forbidden");
      expect(refused.details?.required_scope).toBe("schema.write");
      expect((await stored(id)).id).toBe(id);
    }
    const ok = await request(ctx.app, "DELETE", `/types/${id}`, {
      key: await schemaKey(ns),
    });
    expect(ok.status).toBe(200);
  });

  it("still holds a key without metadata.types:write and without schema.write out", async () => {
    const ns = namespace("none");
    const id = `${ns}.issue`;
    expect(
      (await register(await schemaKey(ns), issueDefinition(id))).status,
    ).toBe(201);
    const bare = await mintWorkingKey(ctx, {
      permissions: [],
      metadata_permissions: {},
      type_permissions: { [`${ns}.*`]: "write" },
    });
    const refused = await refusal(await replace(bare, id, replacement(id, {})));
    expect(refused.status).toBe(403);
    expect(refused.code).toBe("forbidden");
    expect(refused.details?.required_scope).toBe("schema.write");
  });

  it("holds the type map first: another namespace's type is out of reach whatever the permission", async () => {
    const mine = namespace("mine");
    const theirs = namespace("theirs");
    const id = `${theirs}.issue`;
    expect(
      (await register(await schemaKey(theirs), issueDefinition(id))).status,
    ).toBe(201);
    const refused = await refusal(
      await replace(
        await connectorKey(mine),
        id,
        replacement(id, {
          fields: {
            ...(issueDefinition(id).fields as object),
            extra: { type: "string" },
          },
        }),
      ),
    );
    expect(refused.status).toBe(403);
    expect(refused.code).toBe("type_not_permitted");
    expect(refused.message).toContain(id);
  });

  it("answers an unregistered identifier 404 to a key with metadata.types:write alone", async () => {
    const ns = namespace("gone");
    const res = await replace(
      await connectorKey(ns),
      `${ns}.nothing`,
      replacement(`${ns}.nothing`, {}),
    );
    expect(res.status).toBe(404);
  });

  it("refuses a platform-shipped type to a key with metadata.types:write alone", async () => {
    const key = await mintWorkingKey(ctx, {
      permissions: [],
      metadata_permissions: { types: "write" },
      type_permissions: { "*": "write" },
    });
    const refused = await refusal(
      await replace(key, "core.note", {
        fields: { title: { type: "string" } },
      }),
    );
    expect(refused.status).toBe(403);
    expect(refused.code).toBe("core_type_immutable");
  });
});

describe("a parent is named only within the key's reach", () => {
  it("refuses a registration naming a parent the key may not write, and takes the same one from a key that may", async () => {
    const owner = namespace("owner");
    const other = namespace("other");
    const parent = `${owner}.base`;
    expect(
      (
        await register(await connectorKey(owner), {
          id: parent,
          fields: { name: { type: "string" } },
        })
      ).status,
    ).toBe(201);

    const child = `${other}.child`;
    const otherKey = await connectorKey(other);
    const refused = await refusal(
      await register(otherKey, {
        id: child,
        parent,
        fields: { size: { type: "integer" } },
      }),
    );
    expect(refused.status).toBe(403);
    expect(refused.code).toBe("type_not_permitted");
    expect(refused.message).toContain(parent);
    expect(refused.details?.grant).toEqual({
      kind: "type",
      name: parent,
      level: "write",
    });
    const gone = await request(ctx.app, "GET", `/types/${child}`, {
      key: ctx.workingKey,
    });
    expect(gone.status).toBe(404);

    // Read on the parent is not enough: a subtype stops the parent being
    // deleted, which is a change to what its owner can do.
    const readOnly = await mintWorkingKey(ctx, {
      permissions: [],
      metadata_permissions: { types: "write" },
      type_permissions: { [`${other}.*`]: "write", [parent]: "read" },
    });
    const stillRefused = await refusal(
      await register(readOnly, {
        id: child,
        parent,
        fields: { size: { type: "integer" } },
      }),
    );
    expect(stillRefused.status).toBe(403);
    expect(stillRefused.code).toBe("type_not_permitted");

    // The witness: the identical body registers for a key that reaches both.
    const both = await mintWorkingKey(ctx, {
      permissions: [],
      metadata_permissions: { types: "write" },
      type_permissions: { [`${other}.*`]: "write", [parent]: "write" },
    });
    const ok = await register(both, {
      id: child,
      parent,
      fields: { size: { type: "integer" } },
    });
    expect(ok.status, await ok.clone().text()).toBe(201);

    // And what the refusal protects: the owner still deletes the parent once
    // the child is out of the way, which a pinned parent could not.
    const blocked = await refusal(
      await request(ctx.app, "DELETE", `/types/${parent}`, {
        key: await schemaKey(owner),
      }),
    );
    expect(blocked.code).toBe("type_has_subtypes");
  });

  it("answers the same for a parent nothing registers", async () => {
    const ns = namespace("ghost");
    const refused = await refusal(
      await register(await connectorKey(ns), {
        id: `${ns}.child`,
        parent: `${namespace("nobody")}.base`,
        fields: { size: { type: "integer" } },
      }),
    );
    expect(refused.status).toBe(403);
    expect(refused.code).toBe("type_not_permitted");
  });

  it("exempts the platform-shipped types, core.* and system.* alike", async () => {
    const ns = namespace("plat");
    const key = await connectorKey(ns);
    for (const parent of ["core.task", "core.entity.person", "system.folder"]) {
      const res = await register(key, {
        id: `${ns}.${parent.replaceAll(".", "-")}`,
        parent,
        fields: { size: { type: "integer" } },
      });
      expect(res.status, `${parent}: ${await res.clone().text()}`).toBe(201);
    }
  });

  it("holds a replacement that changes the parent to the key's reach, and leaves one that keeps it", async () => {
    const owner = namespace("owner");
    const mine = namespace("mine");
    const foreign = `${owner}.base`;
    const own = `${mine}.base`;
    expect(
      (
        await register(await schemaKey(owner), {
          id: foreign,
          fields: { name: { type: "string" } },
        })
      ).status,
    ).toBe(201);
    const key = await schemaKey(mine);
    expect(
      (
        await register(key, {
          id: own,
          fields: { name: { type: "string" } },
        })
      ).status,
    ).toBe(201);
    const id = `${mine}.child`;
    const body = (parent: string | undefined, extra: Definition = {}) => ({
      ...(parent !== undefined && { parent }),
      fields: { size: { type: "integer" }, ...extra },
    });
    expect((await register(key, { id, ...body(own) })).status).toBe(201);

    // A re-parent onto a type outside the map is refused and changes nothing.
    const refused = await refusal(await replace(key, id, body(foreign)));
    expect(refused.status).toBe(403);
    expect(refused.code).toBe("type_not_permitted");
    expect(refused.message).toContain(foreign);
    expect((await stored(id)).parent).toBe(own);

    // The same re-parent lands for a key whose map reaches the new parent.
    const wide = await mintWorkingKey(ctx, {
      permissions: ["schema.write"],
      metadata_permissions: { types: "write" },
      type_permissions: { [`${mine}.*`]: "write", [foreign]: "write" },
    });
    expect((await replace(wide, id, body(foreign))).status).toBe(200);
    expect((await stored(id)).parent).toBe(foreign);

    // A type that already names a parent outside the map stays editable by
    // the key that owns it, while it keeps that parent.
    const kept = await replace(
      key,
      id,
      body(foreign, { more: { type: "string" } }),
    );
    expect(kept.status, await kept.clone().text()).toBe(200);
    expect((await stored(id)).parent).toBe(foreign);

    // Moving it off the foreign parent needs no reach on the foreign parent,
    // and onto a platform type needs none either.
    expect((await replace(key, id, body("core.task"))).status).toBe(200);
    expect((await replace(key, id, body(undefined))).status).toBe(200);
  });

  it("lets a connector key keep editing a type registered earlier under a foreign parent", async () => {
    const owner = namespace("owner");
    const mine = namespace("mine");
    const foreign = `${owner}.base`;
    expect(
      (
        await register(ctx.workingKey, {
          id: foreign,
          fields: { name: { type: "string" } },
        })
      ).status,
    ).toBe(201);
    const id = `${mine}.child`;
    // Registered by a key whose reach is wide, as every such type was before
    // the reach was asked.
    expect(
      (
        await register(ctx.workingKey, {
          id,
          parent: foreign,
          fields: { size: { type: "integer" } },
        })
      ).status,
    ).toBe(201);
    const key = await connectorKey(mine);
    const res = await replace(key, id, {
      parent: foreign,
      fields: { size: { type: "integer" }, extra: { type: "string" } },
    });
    expect(res.status, await res.clone().text()).toBe(200);
  });
});

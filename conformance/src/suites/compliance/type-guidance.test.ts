import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { ApiResponse, TestContext } from "../../client/types.js";
import {
  createTestContext,
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
    "type-guidance",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

type Definition = Record<string, unknown>;

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** A string of exactly `count` Unicode code points, made of `unit` repeated. */
function points(count: number, unit: string): string {
  return Array.from(
    { length: count },
    (_, i) => [...unit][i % [...unit].length],
  ).join("");
}

/** What counts as a character: ASCII, an emoji and a letter with a combining mark. */
const UNITS = ["a", "😀", "é"];

const FIELDS = { title: { type: "string" } };

function errorPaths(res: ApiResponse<unknown>): string[] {
  const errors = res.error?.error.details?.errors as
    { field?: string; path?: string }[] | undefined;
  return (errors ?? []).map((e) => e.field ?? e.path ?? "");
}

async function refused(
  res: ApiResponse<unknown>,
  path: string,
  why: string,
): Promise<void> {
  expect(res.status, `${why}: ${JSON.stringify(res.error)}`).toBe(400);
  expect(res.error?.error.code, why).toBe("invalid_schema");
  expect(errorPaths(res), why).toContain(path);
  await expectMatchesSchema("POST", "/types", 400, res.error);
}

/** Register through `as`, leaving removal to the shared cleanup. */
async function register(
  as: MarfaClient,
  body: Definition,
): Promise<ApiResponse<unknown>> {
  const res = await as.registerType(body as never);
  if (res.status === 201) {
    trackType(
      ctx,
      body.id as string,
      client,
      body.parent as string | undefined,
    );
  }
  return res;
}

function normalize(body: Definition): Promise<ApiResponse<unknown>> {
  return client.rawRequest("/types/normalize", { method: "POST", body });
}

async function keyFor(
  label: string,
  permissions: string[],
): Promise<MarfaClient> {
  const made = await client.createKey({
    label: `type-guidance-${label}`,
    source: `${ctx.source}-type-guidance-${label}-${unique()}`,
    permissions,
    metadata_permissions: { types: "write" },
    type_permissions: { "*": "write" },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackKey(ctx, made.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: made.data.key });
}

describe("a type's description and guidance", () => {
  it("takes a type description at its limit and refuses one over it, counted in code points", async () => {
    for (const unit of UNITS) {
      const at = await register(client, {
        id: `user.desc-at-${unique()}`,
        description: points(200, unit),
        fields: FIELDS,
      });
      expect(at.status, JSON.stringify(at.error)).toBe(201);
      const over = {
        id: `user.desc-over-${unique()}`,
        description: points(201, unit),
        fields: FIELDS,
      };
      await refused(
        await register(client, over),
        "description",
        `register ${unit}`,
      );
      await refused(await normalize(over), "description", `normalize ${unit}`);
      const held = `user.desc-held-${unique()}`;
      expect(
        (await register(client, { id: held, fields: FIELDS })).status,
      ).toBe(201);
      await refused(
        await client.replaceType(held, { ...over, id: held }),
        "description",
        `replace ${unit}`,
      );
      // The witness: the same text at the limit is taken on every door.
      const fits = { ...over, description: points(200, unit) };
      expect((await normalize(fits)).status, unit).toBe(200);
      expect(
        (await client.replaceType(held, { ...fits, id: held })).status,
        unit,
      ).toBe(200);
    }
  });

  it("takes a field or member description at its limit and refuses one over it, counted in code points", async () => {
    for (const unit of UNITS) {
      const build = (count: number): Definition => ({
        id: `user.field-desc-${unique()}`,
        fields: {
          title: { type: "string", description: points(count, unit) },
          rows: {
            type: "array",
            items_type: "object",
            items_fields: {
              value: { type: "string", description: points(count, unit) },
            },
          },
        },
      });
      const at = await register(client, build(300));
      expect(at.status, `${unit}: ${JSON.stringify(at.error)}`).toBe(201);
      const over = build(301);
      const res = await register(client, over);
      await refused(res, "fields.title.description", unit);
      expect(errorPaths(res)).toContain(
        "fields.rows.items_fields.value.description",
      );
      await refused(
        await normalize(over),
        "fields.title.description",
        `normalize ${unit}`,
      );
    }
  });

  it("keeps a status word's description and reads it on the type and on a child that inherits the word", async () => {
    const parent = `user.word-parent-${unique()}`;
    const child = `user.word-child-${unique()}`;
    const made = await register(client, {
      id: parent,
      fields: {
        stage: {
          type: "status",
          status_values: [
            {
              value: "open",
              group: "not_started",
              description: "Nobody has looked yet.",
            },
            { value: "done", group: "completed" },
          ],
        },
      },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const words = (
      r: ApiResponse<{ fields: Record<string, { status_values?: object[] }> }>,
    ) => r.data.fields.stage.status_values;
    const expected = [
      {
        value: "open",
        group: "not_started",
        description: "Nobody has looked yet.",
      },
      { value: "done", group: "completed" },
    ];
    expect(words((await client.getType(parent)) as never)).toEqual(expected);
    const listed = (await client.listTypes()).data.data.find(
      (t) => t.id === parent,
    );
    expect(listed?.fields.stage.status_values).toEqual(expected);

    const sub = await register(client, {
      id: child,
      parent,
      fields: {
        stage: {
          type: "status",
          status_values: [
            {
              value: "blocked",
              group: "in_progress",
              description: "Waiting on someone.",
            },
          ],
        },
      },
    });
    expect(sub.status, JSON.stringify(sub.error)).toBe(201);
    expect(words((await client.getType(child)) as never)).toEqual([
      ...expected,
      {
        value: "blocked",
        group: "in_progress",
        description: "Waiting on someone.",
      },
    ]);
  });

  it("takes a status word description at its limit and refuses one over it or not text", async () => {
    for (const unit of UNITS) {
      const build = (description: unknown): Definition => ({
        id: `user.word-limit-${unique()}`,
        fields: {
          stage: {
            type: "status",
            status_values: [
              { value: "open", group: "not_started", description },
            ],
          },
        },
      });
      const at = await register(client, build(points(120, unit)));
      expect(at.status, `${unit}: ${JSON.stringify(at.error)}`).toBe(201);
      await refused(
        await register(client, build(points(121, unit))),
        "fields.stage.status_values.0.description",
        unit,
      );
      await refused(
        await normalize(build(points(121, unit))),
        "fields.stage.status_values.0.description",
        `normalize ${unit}`,
      );
    }
    await refused(
      await register(client, {
        id: `user.word-text-${unique()}`,
        fields: {
          stage: {
            type: "status",
            status_values: [
              { value: "open", group: "not_started", description: 7 },
            ],
          },
        },
      }),
      "fields.stage.status_values.0.description",
      "not text",
    );
  });

  it("lets a key with metadata.types:write alone change a status word's description and a guided type's description", async () => {
    const id = `user.free-${unique()}`;
    const own = await keyFor("free", []);
    const body = (word: string, description: string): Definition => ({
      id,
      description,
      guidance: "Use it for the shop.",
      fields: {
        stage: {
          type: "status",
          status_values: [
            { value: "open", group: "not_started", description: word },
          ],
        },
      },
    });
    expect((await register(client, body("First.", "A thing."))).status).toBe(
      201,
    );

    const word = await own.replaceType(id, body("Second.", "A thing."));
    expect(word.status, JSON.stringify(word.error)).toBe(200);
    const text = await own.replaceType(
      id,
      body("Second.", "A thing, said better."),
    );
    expect(text.status, JSON.stringify(text.error)).toBe(200);
    const read = (await client.getType(id)).data;
    expect(read.fields.stage.status_values?.[0].description).toBe("Second.");
    expect(read.description).toBe("A thing, said better.");
    expect(read.guidance).toBe("Use it for the shop.");

    // The witness: renaming the word is a change this key may not make.
    const renamed = await own.replaceType(id, {
      ...body("Second.", "A thing, said better."),
      fields: {
        stage: {
          type: "status",
          status_values: [{ value: "begun", group: "not_started" }],
        },
      },
    });
    expect(renamed.status).toBe(403);
  });

  it("keeps a type's guidance and reads it back on the type and in the list", async () => {
    const id = `user.guided-${unique()}`;
    const guidance =
      "Use for a shop's orders.\n\n## Not for\n\nQuotes: use `core.note`.";
    const made = await register(client, { id, guidance, fields: FIELDS });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    expect((made.data as { guidance?: string }).guidance).toBe(guidance);
    await expectMatchesSchema("POST", "/types", 201, made.data);
    const read = await client.getType(id);
    expect(read.data.guidance).toBe(guidance);
    await expectMatchesSchema("GET", "/types/{id}", 200, read.data);
    const listed = (await client.listTypes()).data.data.find(
      (t) => t.id === id,
    );
    expect(listed?.guidance).toBe(guidance);
    // The witness: a type that carries none reads with no member.
    const bare = `user.unguided-${unique()}`;
    expect((await register(client, { id: bare, fields: FIELDS })).status).toBe(
      201,
    );
    expect((await client.getType(bare)).data).not.toHaveProperty("guidance");
  });

  it("takes guidance at its limit and refuses it over the limit, counted in code points, or not text", async () => {
    for (const unit of UNITS) {
      const at = await register(client, {
        id: `user.guide-at-${unique()}`,
        guidance: points(1000, unit),
        fields: FIELDS,
      });
      expect(at.status, `${unit}: ${JSON.stringify(at.error)}`).toBe(201);
      const over = {
        id: `user.guide-over-${unique()}`,
        guidance: points(1001, unit),
        fields: FIELDS,
      };
      await refused(await register(client, over), "guidance", unit);
      await refused(await normalize(over), "guidance", `normalize ${unit}`);
    }
    for (const bad of [7, null, ["a"], { text: "a" }]) {
      await refused(
        await register(client, {
          id: `user.guide-text-${unique()}`,
          guidance: bad,
          fields: FIELDS,
        }),
        "guidance",
        JSON.stringify(bad),
      );
    }
  });

  it("refuses guidance on an app type and takes the same guidance on a user type", async () => {
    const name = unique();
    const refusedApp = await register(client, {
      id: `app.guide${name}.note`,
      guidance: "Use it.",
      fields: FIELDS,
    });
    await refused(refusedApp, "guidance", "app type");
    await refused(
      await normalize({
        id: `app.guide${name}.note`,
        guidance: "Use it.",
        fields: FIELDS,
      }),
      "guidance",
      "normalize app type",
    );
    const user = await register(client, {
      id: `user.guide-user-${name}`,
      guidance: "Use it.",
      fields: FIELDS,
    });
    expect(user.status, JSON.stringify(user.error)).toBe(201);
    // The same app type with no guidance registers, so the refusal is the guidance.
    const plain = await register(client, {
      id: `app.guide${name}.note`,
      fields: FIELDS,
    });
    expect(plain.status, JSON.stringify(plain.error)).toBe(201);
  });

  it("treats guidance that is an empty string as none", async () => {
    const id = `user.guide-empty-${unique()}`;
    const made = await register(client, { id, guidance: "", fields: FIELDS });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    expect((await client.getType(id)).data).not.toHaveProperty("guidance");
    // The witness: text is kept, and an empty string then removes it.
    const guided = `user.guide-emptied-${unique()}`;
    expect(
      (
        await register(client, {
          id: guided,
          guidance: "Use it.",
          fields: FIELDS,
        })
      ).status,
    ).toBe(201);
    expect((await client.getType(guided)).data.guidance).toBe("Use it.");
    const emptied = await client.replaceType(guided, {
      guidance: "",
      fields: FIELDS,
    });
    expect(emptied.status, JSON.stringify(emptied.error)).toBe(200);
    expect((await client.getType(guided)).data).not.toHaveProperty("guidance");
    // A key without schema.write registers an empty string: it adds nothing.
    const own = await keyFor("empty", []);
    const quiet = await register(own, {
      id: `user.guide-empty-key-${unique()}`,
      guidance: "",
      fields: FIELDS,
    });
    expect(quiet.status, JSON.stringify(quiet.error)).toBe(201);
  });

  it("answers 403 forbidden naming schema.write and guidance to a key with metadata.types:write alone that registers a type with guidance", async () => {
    const own = await keyFor("register", []);
    const res = await register(own, {
      id: `user.guide-register-${unique()}`,
      guidance: "Use it.",
      fields: FIELDS,
    });
    expect(res.status).toBe(403);
    expect(res.error?.error.code).toBe("forbidden");
    expect(res.error?.error.details?.required_scope).toBe("schema.write");
    expect(res.error?.error.details?.changes).toEqual(["guidance"]);
    await expectMatchesSchema("POST", "/types", 403, res.error);
  });

  it("registers no type for a key with metadata.types:write alone that names guidance, though the same type registers without it and with schema.write", async () => {
    const own = await keyFor("register-nothing", []);
    const id = `user.guide-register-nothing-${unique()}`;
    const res = await register(own, {
      id,
      guidance: "Use it.",
      fields: FIELDS,
    });
    expect(res.status).toBe(403);
    expect((await client.getType(id)).status).toBe(404);
    // The witness: the same type with no guidance registers for this key, and with it for a key that holds schema.write.
    expect((await register(own, { id, fields: FIELDS })).status).toBe(201);
    const writer = await keyFor("register-writer", ["schema.write"]);
    const guided = `user.guide-register-writer-${unique()}`;
    const ok = await register(writer, {
      id: guided,
      guidance: "Use it.",
      fields: FIELDS,
    });
    expect(ok.status, JSON.stringify(ok.error)).toBe(201);
    expect((await client.getType(guided)).data.guidance).toBe("Use it.");
  });

  /** A plain type and a guided one, for the replacements below. */
  async function replaceCases(): Promise<[string, string, Definition][]> {
    const plain = `user.guide-add-${unique()}`;
    const guided = `user.guide-change-${unique()}`;
    expect((await register(client, { id: plain, fields: FIELDS })).status).toBe(
      201,
    );
    expect(
      (
        await register(client, {
          id: guided,
          guidance: "First.",
          fields: FIELDS,
        })
      ).status,
    ).toBe(201);
    return [
      ["adds", plain, { guidance: "Use it.", fields: FIELDS }],
      ["changes", guided, { guidance: "Second.", fields: FIELDS }],
      ["removes", guided, { fields: FIELDS }],
    ];
  }

  it("answers 403 forbidden naming schema.write and guidance to a key with metadata.types:write alone whose replacement adds, changes or removes guidance", async () => {
    const own = await keyFor("replace", []);
    for (const [what, id, body] of await replaceCases()) {
      const res = await own.replaceType(id, body);
      expect(res.status, what).toBe(403);
      expect(res.error?.error.code, what).toBe("forbidden");
      expect(res.error?.error.details?.required_scope, what).toBe(
        "schema.write",
      );
      expect(res.error?.error.details?.changes, what).toEqual(["guidance"]);
      await expectMatchesSchema("PUT", "/types/{id}", 403, res.error);
    }
  });

  it("leaves a type as stored when a key with metadata.types:write alone replaces its guidance, though schema.write lands each replacement", async () => {
    const own = await keyFor("replace-nothing", []);
    const writer = await keyFor("replace-writer", ["schema.write"]);
    for (const [what, id, body] of await replaceCases()) {
      const before = (await client.getType(id)).data;
      expect((await own.replaceType(id, body)).status, what).toBe(403);
      expect((await client.getType(id)).data, what).toEqual(before);
      const landed = await writer.replaceType(id, body);
      expect(landed.status, `${what}: ${JSON.stringify(landed.error)}`).toBe(
        200,
      );
      expect((await client.getType(id)).data.guidance, what).toBe(
        (body as { guidance?: string }).guidance,
      );
      // Put it back for the next case, which expects the first text.
      if (id.includes("-change-")) {
        await writer.replaceType(id, { guidance: "First.", fields: FIELDS });
      }
    }
  });

  it("lets a key with metadata.types:write alone replace a guided type when its guidance stays as it is", async () => {
    const own = await keyFor("unchanged", []);
    const id = `user.guide-unchanged-${unique()}`;
    expect(
      (
        await register(client, {
          id,
          guidance: "Use it.",
          description: "One.",
          fields: FIELDS,
        })
      ).status,
    ).toBe(201);
    const res = await own.replaceType(id, {
      guidance: "Use it.",
      description: "Two.",
      fields: { ...FIELDS, extra: { type: "string" } },
    });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    const read = (await client.getType(id)).data;
    expect(read.guidance).toBe("Use it.");
    expect(read.description).toBe("Two.");
    expect(Object.keys(read.fields)).toContain("extra");
  });

  it("reads the guidance of the types above, nearest first, leaving out one that carries none", async () => {
    const root = `user.chain-root-${unique()}`;
    const middle = `user.chain-middle-${unique()}`;
    const top = `user.chain-top-${unique()}`;
    const leaf = `user.chain-leaf-${unique()}`;
    for (const [id, parent, guidance] of [
      [root, undefined, "Root rules."],
      [middle, root, undefined],
      [top, middle, "Top rules."],
      [leaf, top, "Leaf rules."],
    ] as const) {
      const res = await register(client, {
        id,
        parent,
        guidance,
        fields: parent ? {} : FIELDS,
      });
      expect(res.status, JSON.stringify(res.error)).toBe(201);
    }
    const read = await client.getType(leaf);
    expect(read.data.guidance).toBe("Leaf rules.");
    expect(read.data.ancestor_guidance).toEqual([
      { type: top, guidance: "Top rules." },
      { type: root, guidance: "Root rules." },
    ]);
    await expectMatchesSchema("GET", "/types/{id}", 200, read.data);
    // The witness: a type with no ancestor that carries guidance has no member.
    expect((await client.getType(root)).data).not.toHaveProperty(
      "ancestor_guidance",
    );
    const bareChild = `user.chain-bare-${unique()}`;
    const plain = `user.chain-plain-${unique()}`;
    expect((await register(client, { id: plain, fields: FIELDS })).status).toBe(
      201,
    );
    expect(
      (await register(client, { id: bareChild, parent: plain, fields: {} }))
        .status,
    ).toBe(201);
    expect((await client.getType(bareChild)).data).not.toHaveProperty(
      "ancestor_guidance",
    );
  });

  it("reads an ancestor's guidance as it is now, after the child was registered", async () => {
    const parent = `user.current-parent-${unique()}`;
    const child = `user.current-child-${unique()}`;
    expect(
      (
        await register(client, {
          id: parent,
          guidance: "Before.",
          fields: FIELDS,
        })
      ).status,
    ).toBe(201);
    expect(
      (await register(client, { id: child, parent, fields: {} })).status,
    ).toBe(201);
    expect((await client.getType(child)).data.ancestor_guidance).toEqual([
      { type: parent, guidance: "Before." },
    ]);
    const changed = await client.replaceType(parent, {
      guidance: "After.",
      fields: FIELDS,
    });
    expect(changed.status, JSON.stringify(changed.error)).toBe(200);
    expect((await client.getType(child)).data.ancestor_guidance).toEqual([
      { type: parent, guidance: "After." },
    ]);
    await client.replaceType(parent, { fields: FIELDS });
    expect((await client.getType(child)).data).not.toHaveProperty(
      "ancestor_guidance",
    );
  });

  it("takes a read of a type written back, without storing its ancestors' guidance", async () => {
    const parent = `user.back-parent-${unique()}`;
    const child = `user.back-child-${unique()}`;
    expect(
      (
        await register(client, {
          id: parent,
          guidance: "Parent rules.",
          fields: FIELDS,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await register(client, {
          id: child,
          parent,
          guidance: "Child rules.",
          fields: {},
        })
      ).status,
    ).toBe(201);
    const { provenance: _provenance, ...read } = (await client.getType(child))
      .data;
    expect(read.ancestor_guidance).toHaveLength(1);
    const written = await client.replaceType(child, read);
    expect(written.status, JSON.stringify(written.error)).toBe(200);
    const after = (await client.getType(child)).data;
    expect(after.guidance).toBe("Child rules.");
    expect(after.ancestor_guidance).toEqual([
      { type: parent, guidance: "Parent rules." },
    ]);
    // The witness: a member the schema does not define is refused.
    const stray = await client.replaceType(child, {
      ...read,
      revision: written.data.revision,
      ancestor_rules: [],
    });
    expect(stray.status).toBe(400);
  });

  it("ships every type, field and status word within the description limits", async () => {
    const shipped = (await client.listTypes()).data.data.filter(
      (t) => t.provenance?.origin === "platform",
    );
    expect(shipped.length).toBeGreaterThan(0);
    const long = (text: unknown, max: number) =>
      typeof text === "string" && [...text].length > max;
    for (const type of shipped) {
      expect(long(type.description, 200), type.id).toBe(false);
      for (const [name, field] of Object.entries(type.fields)) {
        expect(long(field.description, 300), `${type.id}.${name}`).toBe(false);
        for (const word of field.status_values ?? []) {
          expect(
            long(word.description, 120),
            `${type.id}.${name}.${word.value}`,
          ).toBe(false);
        }
      }
    }
    // The witness: the check can fail, since a description is read at all.
    expect(shipped.some((t) => typeof t.description === "string")).toBe(true);
  });
});

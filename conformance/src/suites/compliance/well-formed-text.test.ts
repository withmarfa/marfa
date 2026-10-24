/**
 * A request whose JSON holds text that is not well-formed UTF-16 is refused
 * at every door that stores text. Each door is asked twice: with a lone
 * surrogate, which is refused naming where it sits, and with a surrogate
 * pair, which is the witness that the door takes the same body otherwise.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  blobHash,
  itemsArchive,
  readTarGzEntry,
  tarGz,
} from "../../utils/archive.js";
import {
  cleanup,
  createTestContext,
  getOwnerClient,
  trackEdge,
  trackEdgeType,
  trackFolder,
  trackItem,
  trackType,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { servedDocument } from "../../utils/openapi.js";

let ctx: TestContext;
let client: MarfaClient;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "well-formed-text",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** A high surrogate with no low one after it. */
const LONE = "\ud83d";
/** The same high surrogate followed by its low one, a grinning face. */
const PAIR = "😀";

interface Answer {
  status: number;
  code?: string;
  errors?: { path: string; message: string }[];
  data: Record<string, unknown>;
}

async function send(
  method: string,
  path: string,
  body: string,
  credential = true,
  contentType = "application/json",
): Promise<Answer> {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      "Content-Type": contentType,
      ...(credential ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body,
  });
  const data = (await res.json()) as {
    error?: {
      code?: string;
      details?: { errors?: { path: string; message: string }[] };
    };
  } & Record<string, unknown>;
  return {
    status: res.status,
    code: data.error?.code,
    errors: data.error?.details?.errors,
    data,
  };
}

async function note(): Promise<{ id: string; version: number }> {
  const r = await client.createItem(createNote({ source: ctx.source }));
  expect(r.status).toBe(201);
  trackItem(ctx, r.data.item.id);
  return { id: r.data.item.id, version: r.data.item.version };
}

interface Door {
  name: string;
  method: string;
  path: (prepared: Prepared) => string;
  /** The status the same body is answered when its text is well-formed. */
  ok: number;
  /** Where the refusal names the first fault, with U+FFFD for a lone surrogate. */
  at: string;
  body: (text: string, prepared: Prepared) => unknown;
  prepare?: () => Promise<Partial<Prepared>>;
  track?: (data: Record<string, unknown>) => void;
}

interface Prepared {
  itemId: string;
  version: number;
  newId: string;
  source: string;
  target: string;
  edgeId: string;
  edgeType: string;
  suffix: string;
}

const REPLACEMENT = "\ufffd";

const doors: Door[] = [
  {
    name: "an item property",
    method: "POST",
    path: () => "/items",
    ok: 201,
    at: "/properties/body",
    body: (text, p) => ({
      id: p.newId,
      type: "core.note",
      source: ctx.source,
      properties: { body: `a ${text}` },
    }),
    track: (data) => trackItem(ctx, (data.item as { id: string }).id),
  },
  {
    name: "a property nested in arrays and objects",
    method: "POST",
    path: () => "/items",
    ok: 201,
    at: "/properties/deep/list/1/note",
    body: (text, p) => ({
      id: p.newId,
      type: "core.note",
      source: ctx.source,
      properties: {
        body: "nested",
        deep: { list: ["fine", { note: text }] },
      },
    }),
    track: (data) => trackItem(ctx, (data.item as { id: string }).id),
  },
  {
    name: "a property name",
    method: "POST",
    path: () => "/items",
    ok: 201,
    at: `/properties/name${REPLACEMENT}`,
    body: (text, p) => ({
      id: p.newId,
      type: "core.note",
      source: ctx.source,
      properties: { body: "named", [`name${text}`]: 1 },
    }),
    track: (data) => trackItem(ctx, (data.item as { id: string }).id),
  },
  {
    name: "a tag on a create",
    method: "POST",
    path: () => "/items",
    ok: 201,
    at: "/tags/0",
    body: (text, p) => ({
      id: p.newId,
      type: "core.note",
      source: ctx.source,
      properties: { body: "tagged" },
      tags: [`t${text}`],
    }),
    track: (data) => trackItem(ctx, (data.item as { id: string }).id),
  },
  {
    name: "a property on an update",
    method: "PATCH",
    path: (p) => `/items/${p.itemId}`,
    ok: 200,
    at: "/properties/body",
    prepare: async () => {
      const made = await note();
      return { itemId: made.id, version: made.version };
    },
    body: (text, p) => ({ version: p.version, properties: { body: text } }),
  },
  {
    name: "a property on a bulk create",
    method: "POST",
    path: () => "/items/bulk",
    ok: 200,
    at: "/items/1/properties/body",
    body: (text, p) => ({
      items: [
        {
          id: uuidv7(),
          type: "core.note",
          source: ctx.source,
          properties: { body: "fine" },
        },
        {
          id: p.newId,
          type: "core.note",
          source: ctx.source,
          properties: { body: text },
        },
      ],
    }),
    track: (data) => {
      for (const entry of (data.results ?? []) as { id?: string }[]) {
        if (entry.id) trackItem(ctx, entry.id);
      }
    },
  },
  {
    name: "a patch in a bulk action",
    method: "POST",
    path: () => "/items/bulk-actions",
    ok: 202,
    at: "/patch/note",
    body: (text, p) => ({
      action: "update_properties",
      patch: { note: text },
      filter: { tags: [`matches-nothing-${p.suffix}`] },
    }),
  },
  {
    name: "a folder setting",
    method: "POST",
    path: () => "/folders",
    ok: 201,
    at: "/title",
    body: (text) => ({ title: `folder ${text}` }),
    track: (data) => trackFolder(ctx, (data.item as { id: string }).id),
  },
  {
    name: "a tag added to an item",
    method: "POST",
    path: (p) => `/items/${p.itemId}/tags`,
    ok: 200,
    at: "/tags/0",
    prepare: async () => ({ itemId: (await note()).id }),
    body: (text) => ({ tags: [`t${text}`] }),
  },
  {
    name: "a tag in an item's metadata",
    method: "PUT",
    path: (p) => `/items/${p.itemId}/metadata`,
    ok: 200,
    at: "/tags/1",
    prepare: async () => ({ itemId: (await note()).id }),
    body: (text) => ({ tags: ["fine", `t${text}`] }),
  },
  {
    name: "an extension value",
    method: "PUT",
    path: (p) => `/items/${p.itemId}/extensions/wellformed`,
    ok: 200,
    at: "/label",
    prepare: async () => ({ itemId: (await note()).id }),
    body: (text) => ({ label: text }),
  },
  {
    name: "an extension key",
    method: "PUT",
    path: (p) => `/items/${p.itemId}/extensions/wellformed`,
    ok: 200,
    at: `/key${REPLACEMENT}`,
    prepare: async () => ({ itemId: (await note()).id }),
    body: (text) => ({ [`key${text}`]: 1 }),
  },
  {
    name: "an edge property",
    method: "POST",
    path: () => "/edges",
    ok: 201,
    at: "/properties/label",
    prepare: edgeWorld,
    body: (text, p) => ({
      id: p.edgeId,
      source_id: p.source,
      target_id: p.target,
      edge_type: p.edgeType,
      properties: { label: text },
    }),
    track: (data) => trackEdge(ctx, (data.edge as { id: string }).id),
  },
  {
    name: "an edge property on an update",
    method: "PATCH",
    path: (p) => `/edges/${p.edgeId}`,
    ok: 200,
    at: "/properties/label",
    prepare: async () => {
      const world = await edgeWorld();
      const made = await client.createEdge({
        id: world.edgeId!,
        source_id: world.source!,
        target_id: world.target!,
        edge_type: world.edgeType!,
        properties: { label: "first" },
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      trackEdge(ctx, world.edgeId!);
      return world;
    },
    body: (text) => ({ version: 1, properties: { label: text } }),
  },
  {
    name: "an edge property in a bulk write",
    method: "POST",
    path: () => "/edges/bulk",
    ok: 200,
    at: "/edges/0/properties/label",
    prepare: edgeWorld,
    body: (text, p) => ({
      edges: [
        {
          id: p.edgeId,
          source_id: p.source,
          target_id: p.target,
          edge_type: p.edgeType,
          properties: { label: text },
        },
      ],
    }),
    track: (data) => {
      for (const entry of (data.results ?? []) as { id?: string }[]) {
        if (entry.id) trackEdge(ctx, entry.id);
      }
    },
  },
  {
    name: "a type registration's label",
    method: "POST",
    path: () => "/types",
    ok: 201,
    at: "/label",
    body: (text, p) => ({
      id: `user.wellformed${p.suffix}`,
      label: `Label ${text}`,
      fields: {},
    }),
    track: (data) => trackType(ctx, (data.type as { id: string }).id, client),
  },
  {
    name: "a type registration's field name",
    method: "POST",
    path: () => "/types",
    ok: 201,
    at: `/fields/title${REPLACEMENT}`,
    body: (text, p) => ({
      id: `user.wellformed${p.suffix}`,
      fields: { [`title${text}`]: { type: "string" } },
    }),
    track: (data) => trackType(ctx, (data.type as { id: string }).id, client),
  },
  {
    name: "an edge type registration",
    method: "POST",
    path: () => "/edge-types",
    ok: 201,
    at: "/description",
    body: (text, p) => ({
      id: `wellformed.link${p.suffix}`,
      label: "Test edge type",
      cardinality: "many-to-many",
      description: `Links ${text}`,
    }),
    track: (data) => trackEdgeType(ctx, (data.edge_type as { id: string }).id),
  },
];

/** Two notes and an edge type that declares the one property a door names. */
async function edgeWorld(): Promise<Partial<Prepared>> {
  const edgeType = `wellformed.edge${randomUUID().replaceAll("-", "")}`;
  const registered = await client.registerEdgeType({
    label: "Test edge type",
    id: edgeType,
    cardinality: "many-to-many",
    property_schema: { label: { type: "string" } },
  });
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  trackEdgeType(ctx, edgeType);
  return {
    source: (await note()).id,
    target: (await note()).id,
    edgeType,
    edgeId: uuidv7(),
  };
}

async function prepared(door: Door): Promise<Prepared> {
  return {
    itemId: "",
    version: 1,
    newId: uuidv7(),
    source: "",
    target: "",
    edgeId: uuidv7(),
    edgeType: "",
    suffix: randomUUID().replaceAll("-", ""),
    ...(await door.prepare?.()),
  };
}

describe("text that is not well-formed UTF-16", () => {
  it.each(doors)(
    "refuses $name, naming where, and takes a surrogate pair there",
    async (door) => {
      const p = await prepared(door);
      const refused = await send(
        door.method,
        door.path(p),
        JSON.stringify(door.body(LONE, p)),
      );
      expect(refused.status, JSON.stringify(refused.data)).toBe(400);
      expect(refused.code).toBe("validation_error");
      expect(refused.errors).toHaveLength(1);
      expect(refused.errors?.[0]?.path).toBe(door.at);
      expect(refused.errors?.[0]?.message).toMatch(/UTF-16/);
      // What the refusal says goes back out as JSON a strict decoder takes.
      expect(JSON.stringify(refused.data)).not.toMatch(/\\ud[89a-f]/i);

      const accepted = await send(
        door.method,
        door.path(p),
        JSON.stringify(door.body(PAIR, p)),
      );
      expect(accepted.status, JSON.stringify(accepted.data)).toBe(door.ok);
      door.track?.(accepted.data);
    },
  );

  it("writes nothing when it refuses a create", async () => {
    const id = uuidv7();
    const refused = await send(
      "POST",
      "/items",
      JSON.stringify({
        id,
        type: "core.note",
        source: ctx.source,
        properties: { body: LONE },
      }),
    );
    expect(refused.status).toBe(400);
    expect((await client.getItem(id)).status).toBe(404);

    const accepted = await send(
      "POST",
      "/items",
      JSON.stringify({
        id,
        type: "core.note",
        source: ctx.source,
        properties: { body: PAIR },
      }),
    );
    expect(accepted.status).toBe(201);
    trackItem(ctx, id);
    expect(
      (
        (await client.getItem(id)).data.item.properties as {
          body: string;
        }
      ).body,
    ).toBe(PAIR);
  });

  it("refuses a lone low surrogate and a reversed pair, in either letter case of the escape", async () => {
    const body = (text: string) =>
      `{"type":"core.note","source":"${ctx.source}","properties":{"body":"${text}"}}`;
    for (const [text, why] of [
      ["\\ude00", "a lone low surrogate"],
      ["\\uDE00", "a lone low surrogate in capitals"],
      ["\\uD83D", "a lone high surrogate in capitals"],
      ["\\ude00\\ud83d", "a reversed pair"],
      ["\\ud83d\\ud83d\\ude00", "a high surrogate before a pair"],
    ] as const) {
      const refused = await send("POST", "/items", body(text));
      expect(refused.status, why).toBe(400);
      expect(refused.errors?.[0]?.path, why).toBe("/properties/body");
    }
    for (const text of ["\\ud83d\\ude00", "\\uD83D\\uDE00", "\\\\ud83d"]) {
      const accepted = await send("POST", "/items", body(text));
      expect(accepted.status, text).toBe(201);
      trackItem(ctx, (accepted.data.item as { id: string }).id);
    }
  });

  it("escapes a slash and a tilde in the pointer it names", async () => {
    const refused = await send(
      "PUT",
      `/items/${(await note()).id}/extensions/wellformed`,
      JSON.stringify({ "a/b": { "c~d": LONE } }),
    );
    expect(refused.status).toBe(400);
    expect(refused.errors?.[0]?.path).toBe("/a~1b/c~0d");
  });

  it("writes U+FFFD in the pointer for each lone surrogate in a key", async () => {
    const refused = await send(
      "PUT",
      `/items/${(await note()).id}/extensions/wellformed`,
      JSON.stringify({ outer: { [`x${LONE}y\ude00`]: 1 } }),
    );
    expect(refused.status).toBe(400);
    expect(refused.errors?.[0]?.path).toBe(
      `/outer/x${REPLACEMENT}y${REPLACEMENT}`,
    );
  });

  it("answers it before a missing credential, as it answers a body nested too deep", async () => {
    const body = JSON.stringify({
      type: "core.note",
      properties: { body: LONE },
    });
    const refused = await send("POST", "/items", body, false);
    expect(refused.status).toBe(400);
    expect(refused.code).toBe("validation_error");

    // The witness: the same body with a pair is met by the missing credential.
    const witness = await send(
      "POST",
      "/items",
      JSON.stringify({ type: "core.note", properties: { body: PAIR } }),
      false,
    );
    expect(witness.status).toBe(401);
  });

  it("names the nesting before the text when a body is both too deep and not well-formed", async () => {
    const deep = '{"a":'.repeat(70) + `"${"\\ud83d"}"` + "}".repeat(70);
    const refused = await send("POST", "/items", deep);
    expect(refused.status).toBe(400);
    expect(refused.errors).toBeUndefined();
    expect(JSON.stringify(refused.data)).toMatch(/nests deeper/);
  });

  it("refuses it on every published operation that takes a JSON body, before any credential", async () => {
    const document = await servedDocument();
    const unreached: string[] = [];
    const witnessed: string[] = [];
    let doors = 0;
    for (const [template, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!operation.requestBody?.content?.["application/json"]) continue;
        doors++;
        const path = template.replace(/\{[^}]+\}/g, uuidv7());
        const refused = await send(
          method.toUpperCase(),
          path,
          JSON.stringify({ k: LONE }),
          false,
        );
        if (
          refused.status !== 400 ||
          refused.errors?.[0]?.path !== "/k" ||
          !/UTF-16/.test(refused.errors[0].message)
        ) {
          unreached.push(`${method.toUpperCase()} ${template}`);
        }
        const witness = await send(
          method.toUpperCase(),
          path,
          JSON.stringify({ k: PAIR }),
          false,
        );
        if (witness.errors?.some((e) => /UTF-16/.test(e.message))) {
          witnessed.push(`${method.toUpperCase()} ${template}`);
        }
      }
    }
    expect(doors).toBeGreaterThan(30);
    expect(unreached).toEqual([]);
    expect(witnessed).toEqual([]);
  });
});

describe("a restore", () => {
  /**
   * An archive of two notes, an edge between them and a type, with `text`
   * placed in the one place `where` names.
   */
  function archive(where: string, text: string, ids: Ids): Uint8Array {
    const item = (id: string, body: string) => ({
      id,
      type: "core.note",
      source: ctx.source,
      properties: { body } as Record<string, unknown>,
      version: 1,
    });
    const first = item(ids.first, "first");
    const second = item(ids.second, "second");
    let metadata: Record<string, unknown> = { tags: [], extensions: {} };
    const edge: Record<string, unknown> = {
      id: ids.edge,
      source_id: ids.first,
      target_id: ids.second,
      edge_type: "references",
      properties: {},
      version: 1,
    };
    const type: Record<string, unknown> = {
      id: ids.type,
      label: "Well-formed text",
      version: 1,
      fields: {},
    };
    if (where === "item property") first.properties.body = `a ${text}`;
    if (where === "item property name") first.properties[`name${text}`] = 1;
    if (where === "tag") metadata = { tags: [`t${text}`], extensions: {} };
    if (where === "extension")
      metadata = { tags: [], extensions: { wellformed: { label: text } } };
    if (where === "edge property") edge.properties = { label: text };
    if (where === "type") type.label = `Label ${text}`;
    const edgeLine: Record<string, unknown> = { edge };
    if (where === "edge lending list")
      edgeLine.lending_blobs = [`sha256:${text}`];
    const blob = new Uint8Array(randomBytes(16));
    const hash = blobHash(blob);
    const base = itemsArchive([first, second], [], [type]);
    const manifest = readTarGzEntry(base, "manifest.json");
    if (manifest === null) throw new Error("the archive has no manifest");
    return tarGz([
      {
        name: "manifest.json",
        body: JSON.stringify({
          ...JSON.parse(manifest),
          edge_count: 1,
          ...(where === "manifest"
            ? {
                blobs: {
                  [hash]: {
                    mime_type: `text/${text}`,
                    size_bytes: blob.length,
                  },
                },
              }
            : {}),
        }),
      },
      ...(where === "manifest" ? [{ name: `blobs/${hash}`, body: blob }] : []),
      { name: "types.ndjson", body: `${JSON.stringify({ type })}\n` },
      {
        name: "items.ndjson",
        body:
          [first, second]
            .map((row) =>
              JSON.stringify({
                item: row,
                metadata:
                  row === first ? metadata : { tags: [], extensions: {} },
              }),
            )
            .join("\n") + "\n",
      },
      { name: "edges.ndjson", body: `${JSON.stringify(edgeLine)}\n` },
    ]);
  }

  interface Ids {
    first: string;
    second: string;
    edge: string;
    type: string;
  }

  it.each([
    ["item property", "/item/properties/body", "first"],
    ["item property name", `/item/properties/name${REPLACEMENT}`, "first"],
    ["tag", "/metadata/tags/0", "first"],
    ["extension", "/metadata/extensions/wellformed/label", "first"],
    ["edge property", "/edge/properties/label", "edge"],
    ["edge lending list", "/lending_blobs/0", "edge"],
    ["type", "/type/label", "type"],
    ["manifest", "/blobs/", "manifest.json"],
  ] as const)(
    "refuses a %s that is not well-formed UTF-16, naming the row and where, and takes a pair there",
    async (where, pointer, row) => {
      const owner = getOwnerClient();
      const hex = randomUUID().replaceAll("-", "");
      const ids: Ids = {
        first: uuidv7(),
        second: uuidv7(),
        edge: uuidv7(),
        type: `user.wellformed${hex}`,
      };
      trackItem(ctx, ids.first);
      trackItem(ctx, ids.second);
      trackEdge(ctx, ids.edge);
      trackType(ctx, ids.type);

      const refused = await owner.restoreArchive(archive(where, LONE, ids));
      expect(refused.status, JSON.stringify(refused.error)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      const named =
        row === "first" ? ids.first : row === "manifest.json" ? row : ids[row];
      expect(refused.error?.error.message).toContain(named);
      expect(refused.error?.error.message).toContain(pointer);
      expect(JSON.stringify(refused.error)).not.toMatch(/\\ud[89a-f]/i);
      expect((await client.getItem(ids.first)).status).toBe(404);
      expect((await client.getItem(ids.second)).status).toBe(404);
      expect((await client.getEdge(ids.edge)).status).toBe(404);
      expect((await client.getType(ids.type)).status).toBe(404);

      const accepted = await owner.restoreArchive(archive(where, PAIR, ids));
      expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
      expect(accepted.data).toMatchObject({
        imported: 2,
        edges_imported: 1,
        types_registered: 1,
      });
    },
  );
});

describe("a body whatever its content type states", () => {
  const types = [
    "application/jsonx",
    "application/json5",
    "application/vnd.api+json",
    "application/x-www-form-urlencoded",
    "text/plain",
    "application/json; x=application/jsonx",
  ];
  const doors = [
    { path: "/items", credential: true },
    { path: "/auth/oauth2/register", credential: false },
    { path: "/setup/claim", credential: false },
  ];

  it("is refused for text that is not well-formed UTF-16, before any credential", async () => {
    for (const contentType of types) {
      for (const door of doors) {
        const where = `${door.path} as ${contentType}`;
        const refused = await send(
          "POST",
          door.path,
          JSON.stringify({ k: LONE }),
          door.credential,
          contentType,
        );
        expect(refused.status, where).toBe(400);
        expect(refused.errors?.[0]?.path, where).toBe("/k");

        // The witness: the same body with a pair meets the door itself.
        const witness = await send(
          "POST",
          door.path,
          JSON.stringify({ k: PAIR }),
          door.credential,
          contentType,
        );
        expect(
          witness.errors?.some((e) => /surrogate/.test(e.message)),
          where,
        ).toBeFalsy();
      }
    }
  });

  it("is refused when it nests too deep, before any credential", async () => {
    const deep = '{"a":'.repeat(70) + "1" + "}".repeat(70);
    for (const contentType of types) {
      for (const door of doors) {
        const refused = await send(
          "POST",
          door.path,
          deep,
          door.credential,
          contentType,
        );
        expect(refused.status, `${door.path} as ${contentType}`).toBe(400);
        expect(JSON.stringify(refused.data)).toMatch(/nests deeper/);
      }
    }
  });
});

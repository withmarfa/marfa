/**
 * Every door that can answer an item's extension data, and the credential it
 * answers.
 *
 * **A census rather than a test per door, because the rule lives in one
 * serializer and a door that skips it looks covered from everywhere else.**
 * The doors are found in the app's own OpenAPI document: an operation whose
 * success answer can carry a `metadata` or `extensions` field, or whose
 * answer is a stream the document cannot see into. Each has to be classified
 * below before this file goes green, and each is then driven twice: with a
 * key whose extension map reaches every namespace, the witness that the
 * namespace it should not see is there to be leaked, and with a key that does
 * not reach the unseen namespace, which must be answered without it.
 *
 * The census stops at the document: doors listed in `unpublished-routes.json`
 * are not walked, and a field typed as an open record could carry extension
 * data without being found here.
 */
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  finalizeOpenAPISpec,
  OPENAPI_DOCUMENT_INFO,
} from "../openapi-finalize.js";
import { initEventLog } from "../pubsub.js";
import {
  createTestContext,
  inlineOpenApiRefs,
  mintWorkingKey,
  readSseWriting,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
/** Reaches the seen namespace and a scratch one, and not the unseen one. */
let narrowKey: string;

const SEEN = "census-seen";
const UNSEEN = "census-unseen";
const SEEN_MARK = "seen-namespace-value";
const UNSEEN_MARK = "unseen-namespace-value";
/** Another namespace the narrow key may write, for the delete door. */
const SCRATCH = "census-scratch";
const SEARCH_WORD = "extensioncensusword";

beforeAll(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
  narrowKey = await mintWorkingKey(ctx, {
    extension_permissions: { [SEEN]: "write", [SCRATCH]: "write" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

/** Bodies the document cannot describe, so cannot rule extension data out of. */
const OPAQUE = /^(?!application\/json$)/;

/**
 * Whether a success answer of this operation can carry extension data: its
 * schema reaches a field named `metadata` or `extensions`, or its body is a
 * stream or bytes the schema does not describe.
 */
function mayCarryExtensions(operation: Record<string, unknown>): boolean {
  const responses = (operation.responses ?? {}) as Record<
    string,
    { content?: Record<string, { schema?: unknown }> }
  >;
  for (const [status, response] of Object.entries(responses)) {
    if (!status.startsWith("2")) continue;
    for (const [contentType, body] of Object.entries(response.content ?? {})) {
      if (OPAQUE.test(contentType)) return true;
      if (namesExtensionField(body.schema)) return true;
    }
  }
  return false;
}

function namesExtensionField(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(namesExtensionField);
  if (node === null || typeof node !== "object") return false;
  const record = node as Record<string, unknown>;
  const properties = record.properties as Record<string, unknown> | undefined;
  if (
    properties !== undefined &&
    ("metadata" in properties || "extensions" in properties)
  ) {
    return true;
  }
  return Object.values(record).some(namesExtensionField);
}

function extensionDoors(): string[] {
  const document = finalizeOpenAPISpec(
    ctx.app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: OPENAPI_DOCUMENT_INFO,
    }),
  ) as unknown as Record<string, unknown>;
  const paths = inlineOpenApiRefs(document.paths, document) as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  const out: string[] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      if (mayCarryExtensions(operation)) {
        out.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return out.sort();
}

/** A note carrying both namespaces, written by the full key. */
async function seedNote(
  extra: Record<string, unknown> = {},
  key = ctx.workingKey,
): Promise<{ id: string; version: number }> {
  const created = await request(ctx.app, "POST", "/items", {
    key,
    body: {
      type: "core.note",
      properties: { title: "census", body: `a ${SEARCH_WORD} note` },
      tags: ["census"],
      ...extra,
    },
  });
  expect(created.status).toBe(201);
  const { item } = (await created.json()) as {
    item: { id: string; version: number };
  };
  await stampBothNamespaces(item.id);
  return item;
}

async function stampBothNamespaces(id: string): Promise<void> {
  await ctx.storage.metadata.setExtension(id, SEEN, { value: SEEN_MARK }, null);
  await ctx.storage.metadata.setExtension(
    id,
    UNSEEN,
    { value: UNSEEN_MARK },
    null,
  );
}

async function versionOf(id: string): Promise<number> {
  const res = await request(ctx.app, "GET", `/items/${id}`, {
    key: ctx.workingKey,
  });
  return ((await res.json()) as { item: { version: number } }).item.version;
}

/** What a door answered, as text a namespace's value can be looked for in. */
interface Answer {
  status: number;
  text: string;
}

async function answer(res: Response): Promise<Answer> {
  const type = res.headers.get("Content-Type") ?? "";
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    text: type.includes("gzip")
      ? gunzipSync(bytes).toString("utf8")
      : bytes.toString("utf8"),
  };
}

type Driver = (key: string) => Promise<Answer>;

/** Doors answering extension data, each with how to make it answer some. */
const CARRYING: Record<string, Driver> = {
  "POST /items": async (key) => {
    // The upsert: a natural key resolving a row this key wrote answers that
    // row with its metadata.
    const sourceId = `census-${Math.random().toString(36).slice(2)}`;
    const body = {
      type: "core.note",
      source_id: sourceId,
      properties: { title: "upserted", body: "upserted" },
    };
    const first = await request(ctx.app, "POST", "/items", { key, body });
    expect(first.status).toBe(201);
    const { item } = (await first.json()) as { item: { id: string } };
    await stampBothNamespaces(item.id);
    return answer(await request(ctx.app, "POST", "/items", { key, body }));
  },
  "GET /items": async (key) => {
    await seedNote();
    return answer(
      await request(ctx.app, "GET", "/items?include=metadata,extensions", {
        key,
      }),
    );
  },
  "GET /items/{id}": async (key) => {
    const { id } = await seedNote();
    return answer(await request(ctx.app, "GET", `/items/${id}`, { key }));
  },
  "PATCH /items/{id}": async (key) => {
    const { id, version } = await seedNote();
    return answer(
      await request(ctx.app, "PATCH", `/items/${id}`, {
        key,
        body: { properties: { title: "patched" }, version },
      }),
    );
  },
  "POST /items/{id}/restore": async (key) => {
    const { id } = await seedNote();
    const trashed = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: ctx.workingKey,
    });
    expect(trashed.status).toBe(200);
    return answer(
      await request(ctx.app, "POST", `/items/${id}/restore`, { key }),
    );
  },
  "POST /items/{id}/transition": async (key) => {
    const { id } = await seedNote();
    return answer(
      await request(ctx.app, "POST", `/items/${id}/transition`, {
        key,
        body: { state: "archived" },
      }),
    );
  },
  "GET /items/{id}/metadata": async (key) => {
    const { id } = await seedNote();
    return answer(
      await request(ctx.app, "GET", `/items/${id}/metadata`, { key }),
    );
  },
  "PUT /items/{id}/metadata": async (key) => {
    const { id } = await seedNote();
    return answer(
      await request(ctx.app, "PUT", `/items/${id}/metadata`, {
        key,
        body: { tags: ["replaced"] },
      }),
    );
  },
  "PATCH /items/{id}/metadata": async (key) => {
    const { id } = await seedNote();
    return answer(
      await request(ctx.app, "PATCH", `/items/${id}/metadata`, {
        key,
        body: { tags: ["merged"] },
      }),
    );
  },
  "POST /items/{id}/tags": async (key) => {
    const { id } = await seedNote();
    return answer(
      await request(ctx.app, "POST", `/items/${id}/tags`, {
        key,
        body: { tags: ["added"] },
      }),
    );
  },
  "DELETE /items/{id}/tags/{tag}": async (key) => {
    const { id } = await seedNote();
    return answer(
      await request(ctx.app, "DELETE", `/items/${id}/tags/census`, { key }),
    );
  },
  "POST /items/bulk-get": async (key) => {
    const { id } = await seedNote();
    return answer(
      await request(ctx.app, "POST", "/items/bulk-get", {
        key,
        body: { ids: [id], include: ["metadata", "extensions"] },
      }),
    );
  },
  "GET /items/{id}/extensions": async (key) => {
    const { id } = await seedNote();
    return answer(
      await request(ctx.app, "GET", `/items/${id}/extensions`, { key }),
    );
  },
  "PUT /items/{id}/extensions/{namespace}": async (key) => {
    const { id } = await seedNote();
    return answer(
      await request(ctx.app, "PUT", `/items/${id}/extensions/${SEEN}`, {
        key,
        body: { value: SEEN_MARK },
      }),
    );
  },
  "DELETE /items/{id}/extensions/{namespace}": async (key) => {
    const { id } = await seedNote();
    // A namespace other than the seen one, so the answer still carries it.
    return answer(
      await request(ctx.app, "DELETE", `/items/${id}/extensions/${SCRATCH}`, {
        key,
      }),
    );
  },
  "GET /search": async (key) => {
    await seedNote();
    return answer(
      await request(ctx.app, "GET", `/search?q=${SEARCH_WORD}`, { key }),
    );
  },
  "PATCH /folders/{id}": async (key) => {
    const id = await seedFolder();
    return answer(
      await request(ctx.app, "PATCH", `/folders/${id}`, {
        key,
        body: { version: await versionOf(id), title: "renamed" },
      }),
    );
  },
  "POST /folders/{id}/revoke": async (key) => {
    const id = await seedFolder();
    return answer(
      await request(ctx.app, "POST", `/folders/${id}/revoke`, { key }),
    );
  },
  "GET /export": async (key) => {
    await seedNote();
    return answer(await request(ctx.app, "GET", "/export", { key }));
  },
  "GET /events": async (key) => {
    const { id } = await seedNote();
    const stream = await request(ctx.app, "GET", "/events", { key });
    expect(stream.status).toBe(200);
    const { text } = await readSseWriting(
      stream,
      ":",
      async () => {
        const res = await request(ctx.app, "POST", `/items/${id}/tags`, {
          key: ctx.workingKey,
          body: { tags: ["announced"] },
        });
        expect(res.status).toBe(200);
      },
      (seen) => seen.includes("metadata.changed"),
    );
    return { status: stream.status, text };
  },
};

async function seedFolder(): Promise<string> {
  const created = await request(ctx.app, "POST", "/folders", {
    key: ctx.workingKey,
    body: { title: "census folder" },
  });
  expect(created.status).toBe(201);
  const { item } = (await created.json()) as { item: { id: string } };
  await stampBothNamespaces(item.id);
  return item.id;
}

/**
 * The same door driven a second way: `format=archive` writes what the
 * NDJSON format streams, through a separate path.
 */
const VARIANTS: Record<string, Driver> = {
  "POST /items, a repeat of a create under its id": async (key) => {
    const id = `${randomUUID().slice(0, 14)}7${randomUUID().slice(15)}`;
    const body = {
      id,
      type: "core.note",
      properties: { title: "repeated", body: "repeated" },
    };
    const first = await request(ctx.app, "POST", "/items", { key, body });
    expect(first.status).toBe(201);
    await stampBothNamespaces(id);
    const repeat = await request(ctx.app, "POST", "/items", { key, body });
    expect(await repeat.clone().json()).toMatchObject({ acknowledged: true });
    return answer(repeat);
  },
  "GET /items/{id}?include=neighbors": async (key) => {
    const target = await seedNote();
    // The row read carries no namespace, so what is found is the neighbor's.
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { title: "source", body: "source" },
        edges: { references: [target.id] },
      },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };
    return answer(
      await request(ctx.app, "GET", `/items/${item.id}?include=neighbors`, {
        key,
      }),
    );
  },
  "GET /export?format=archive": async (key) => {
    await seedNote();
    return answer(
      await request(ctx.app, "GET", "/export?format=archive", { key }),
    );
  },
};

/**
 * Doors the document says could carry extension data and that answer none,
 * each with why. Driven as well, so one that starts carrying some fails here
 * until it is moved into `CARRYING`.
 */
const CARRYING_NONE: Record<string, { why: string; drive: Driver }> = {
  "POST /items/lookup": {
    why: "answers rows without hydrating their metadata",
    drive: async (key) => {
      const { id } = await seedNote();
      return answer(
        await request(ctx.app, "POST", "/items/lookup", {
          key,
          body: { type: "core.note", ids: [id] },
        }),
      );
    },
  },
  "GET /occurrences": {
    why: "answers occurrences of events, whose rows it does not hydrate with metadata",
    drive: async (key) => {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.event",
          properties: {
            title: "census event",
            starts_at: "2026-05-05T09:00:00.000Z",
            ends_at: "2026-05-05T09:30:00.000Z",
          },
        },
      });
      expect(res.status).toBe(201);
      const { item } = (await res.json()) as { item: { id: string } };
      await stampBothNamespaces(item.id);
      return answer(
        await request(
          ctx.app,
          "GET",
          "/occurrences?from=2026-05-01T00:00:00Z&to=2026-05-10T00:00:00Z",
          { key },
        ),
      );
    },
  },
  "POST /folders": {
    why: "answers the folder it has just created, which holds no namespace yet",
    drive: async (key) =>
      answer(
        await request(ctx.app, "POST", "/folders", {
          key,
          body: { title: "census folder" },
        }),
      ),
  },
};

/** Opaque bodies that are not an item's data at all, each with what they are. */
const NOT_ITEM_DATA: Record<string, string> = {
  "GET /blobs/{hash}": "a blob's bytes",
  "GET /connectors/{id}/deliveries/{delivery_id}/body":
    "the body a connector's sender posted",
};

describe("every door answering extension data is held to the extension map", () => {
  it("classifies every door the document says can carry extension data", () => {
    const doors = extensionDoors();
    expect(doors.length).toBeGreaterThan(15);
    expect(doors).toEqual(
      [
        ...Object.keys(CARRYING),
        ...Object.keys(CARRYING_NONE),
        ...Object.keys(NOT_ITEM_DATA),
      ].sort(),
    );
  });

  for (const [door, drive] of Object.entries({ ...CARRYING, ...VARIANTS })) {
    it(`answers ${door} only the namespaces the key may read`, async () => {
      // The witness: the namespace the narrow key does not hold is there,
      // on this door, for a key that may read it.
      const witness = await drive(ctx.workingKey);
      expect(witness.status, "the full key").toBeLessThan(300);
      expect(witness.text, "the full key").toContain(UNSEEN_MARK);

      const narrowed = await drive(narrowKey);
      expect(narrowed.status, "the narrow key").toBeLessThan(300);
      expect(narrowed.text, "the narrow key").toContain(SEEN_MARK);
      expect(narrowed.text, "the narrow key").not.toContain(UNSEEN_MARK);
      expect(narrowed.text, "the narrow key").not.toContain(UNSEEN);
    });
  }

  for (const [door, { why, drive }] of Object.entries(CARRYING_NONE)) {
    it(`answers ${door} no namespace at all: ${why}`, async () => {
      const witness = await drive(ctx.workingKey);
      expect(witness.status).toBeLessThan(300);
      expect(witness.text).not.toContain(SEEN_MARK);
      expect(witness.text).not.toContain(UNSEEN_MARK);
    });
  }

  it("refuses the single-namespace read of a namespace the key does not hold", async () => {
    const { id } = await seedNote();
    const witness = await answer(
      await request(ctx.app, "GET", `/items/${id}/extensions/${UNSEEN}`, {
        key: ctx.workingKey,
      }),
    );
    expect(witness.text).toContain(UNSEEN_MARK);
    const narrowed = await answer(
      await request(ctx.app, "GET", `/items/${id}/extensions/${UNSEEN}`, {
        key: narrowKey,
      }),
    );
    expect(narrowed.status).toBe(403);
    expect(narrowed.text).not.toContain(UNSEEN_MARK);
  });
});

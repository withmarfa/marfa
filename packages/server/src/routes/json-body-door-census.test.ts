/**
 * Every door that takes a JSON body refuses a body that is not sent as JSON.
 *
 * **A census rather than a test per door, because the gap is in how the
 * library validates a body and a door added later falls into it unseen.** The
 * doors are found in the app's own OpenAPI document: an operation with a
 * request body. Each is classified below before this file goes green, and
 * every JSON door is then driven with a body that is missing, empty or sent
 * as another type, which has to answer `400 validation_error` and reach no
 * handler.
 *
 * Below the census, the three doors the gap lost data on are driven with a
 * valid body, first as JSON to show the write is producible, then without the
 * header to show it changes nothing.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  finalizeOpenAPISpec,
  OPENAPI_DOCUMENT_INFO,
} from "../openapi-finalize.js";
import {
  createTestContext,
  inlineOpenApiRefs,
  mintWorkingKey,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

/** A registered type, which the type doors look up before they read a body. */
const TYPE = "census.door";

beforeAll(async () => {
  ctx = await createTestContext();
  const registered = await request(ctx.app, "POST", "/types", {
    key: ctx.workingKey,
    body: {
      id: TYPE,
      version: 1,
      fields: { name: { type: "string", required: true } },
    },
  });
  expect(registered.status).toBe(201);
});

afterAll(async () => {
  await ctx.cleanup();
});

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

/** Doors in the document whose body is not JSON, each with why. */
const NOT_JSON: Record<string, string> = {
  "POST /blobs": "the bytes of a blob, under their own Content-Type",
  "POST /restore": "a gzip archive streamed to disk",
};

/** Doors in the document that take JSON and another handler answers. */
const SERVED_ELSEWHERE: Record<string, string> = {
  "POST /auth/oauth2/register":
    "RFC 7591 registration, served by the Better Auth mount, which refuses a body of another type itself",
};

/**
 * Doors the server serves and the document does not carry, which take a
 * body that is not this contract's JSON.
 */
const UNPUBLISHED_WRITES: Record<string, string> = {
  "POST /inbound/{token}": "a sender's delivery, whatever bytes it sent",
  "POST /auth/sign-in": "a form post",
  "POST /auth/authorize/decision": "a form post",
  "POST /auth/device": "a form post",
  "POST /auth/device/consent": "a form post",
};

interface Operation {
  requestBody?: {
    required?: boolean;
    content?: Record<string, unknown>;
  };
}

function operations(): Record<string, Operation> {
  const document = finalizeOpenAPISpec(
    ctx.app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: OPENAPI_DOCUMENT_INFO,
    }),
  ) as unknown as Record<string, unknown>;
  const paths = inlineOpenApiRefs(document.paths, document) as Record<
    string,
    Record<string, Operation>
  >;
  const out: Record<string, Operation> = {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      out[`${method.toUpperCase()} ${path}`] = operation;
    }
  }
  return out;
}

function withBody(): [string, Operation][] {
  return Object.entries(operations()).filter(
    ([, operation]) => operation.requestBody !== undefined,
  );
}

function takesJson(operation: Operation): boolean {
  return Object.keys(operation.requestBody?.content ?? {}).some((type) =>
    /^application\/([a-z-.]+\+)?json/i.test(type),
  );
}

function jsonDoors(): string[] {
  return withBody()
    .filter(
      ([door, operation]) =>
        takesJson(operation) && !(door in SERVED_ELSEWHERE),
    )
    .map(([door]) => door)
    .sort();
}

describe("the doors that take a body", () => {
  it("are all classified", () => {
    const unclassified = withBody()
      .filter(
        ([door, operation]) => !takesJson(operation) && !(door in NOT_JSON),
      )
      .map(([door]) => door);
    expect(unclassified).toEqual([]);
    for (const door of Object.keys(NOT_JSON)) {
      const operation = operations()[door];
      expect(operation, `stale: ${door} is not a door`).toBeDefined();
      expect(takesJson(operation!), `${door} takes JSON`).toBe(false);
    }
    for (const door of Object.keys(SERVED_ELSEWHERE)) {
      expect(operations()[door], `stale: ${door} is not a door`).toBeDefined();
    }
  });

  it("find the JSON doors, among them the three the gap lost data on", () => {
    const doors = jsonDoors();
    expect(doors.length).toBeGreaterThan(30);
    expect(doors).toEqual(
      expect.arrayContaining([
        "PUT /items/{id}/metadata",
        "POST /items/{id}/tags",
        "PUT /items/{id}/extensions/{namespace}",
      ]),
    );
  });

  it("name every unpublished write door", () => {
    const unpublished = Object.keys(
      JSON.parse(
        readFileSync(
          new URL("../../unpublished-routes.json", import.meta.url),
          "utf8",
        ),
      ) as Record<string, string>,
    ).filter((door) => /^(POST|PUT|PATCH) /.test(door));
    expect(unpublished.sort()).toEqual(Object.keys(UNPUBLISHED_WRITES).sort());
  });

  it("declare the body required, which is what the document tells a client", () => {
    const optional = withBody()
      .filter(
        ([door, operation]) =>
          takesJson(operation) &&
          !(door in SERVED_ELSEWHERE) &&
          operation.requestBody?.required !== true,
      )
      .map(([door]) => door);
    expect(optional).toEqual([]);
  });
});

/** One way of sending a body that is not sent as JSON. */
interface Way {
  name: string;
  headers: Record<string, string>;
  /** The body to send for a payload, as JSON text. */
  body?: (payload: string) => string | Uint8Array | FormData;
}

const WAYS: Way[] = [
  { name: "no body and no Content-Type", headers: {} },
  {
    // A string body would make the runtime add `text/plain` itself.
    name: "a body and no Content-Type",
    headers: {},
    body: (payload) => new TextEncoder().encode(payload),
  },
  {
    name: "no body under text/plain",
    headers: { "Content-Type": "text/plain" },
  },
  {
    name: "a body under text/plain",
    headers: { "Content-Type": "text/plain" },
    body: (payload) => payload,
  },
  {
    name: "a body under application/x-www-form-urlencoded",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: (payload) => payload,
  },
  {
    // The runtime adds the multipart type and its boundary.
    name: "a body under multipart/form-data",
    headers: {},
    body: (payload) => {
      const form = new FormData();
      form.set("payload", payload);
      return form;
    },
  },
  {
    name: "a body under application/octet-stream",
    headers: { "Content-Type": "application/octet-stream" },
    body: (payload) => new TextEncoder().encode(payload),
  },
  {
    name: "a body under a type that only starts like JSON",
    headers: { "Content-Type": "application/jsonp" },
    body: (payload) => new TextEncoder().encode(payload),
  },
];

async function send(
  door: string,
  way: Way,
  key: string,
  options: { path?: string; payload?: unknown } = {},
): Promise<Response> {
  const [method, template] = door.split(" ") as [string, string];
  // A type is named by an identifier, not an ID.
  const url =
    options.path ??
    template.replace(/\{[^}]+\}/g, () =>
      template.startsWith("/types/") ? TYPE : randomUUID(),
    );
  return ctx.app.request(url, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...way.headers },
    ...(way.body === undefined
      ? {}
      : { body: way.body(JSON.stringify(options.payload ?? {})) }),
  });
}

interface Refusal {
  error: { code: string; message: string };
}

/**
 * What the door answers a credential that reaches it. An instance door
 * refuses the working key, so it is tried with the operator key after.
 */
async function reached(door: string, way: Way): Promise<Response> {
  const working = await send(door, way, ctx.workingKey);
  if (working.status !== 403) return working;
  return send(door, way, ctx.operatorKey);
}

describe("a JSON door sent a body that is not JSON", () => {
  for (const way of WAYS) {
    it(`refuses ${way.name} with 400 on every door`, async () => {
      const wrong: string[] = [];
      for (const door of jsonDoors()) {
        const res = await reached(door, way);
        const text = await res.text();
        const body = ((): Partial<Refusal> => {
          try {
            return JSON.parse(text) as Refusal;
          } catch {
            return {};
          }
        })();
        if (
          res.status !== 400 ||
          body.error?.code !== "validation_error" ||
          !body.error.message.includes("application/json") ||
          res.headers.get("X-Error-Code") !== "validation_error"
        ) {
          wrong.push(`${door}: ${String(res.status)} ${text.slice(0, 120)}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }

  it("still asks for the credential first", async () => {
    const res = await ctx.app.request(`/items/${randomUUID()}/tags`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("still asks for the permission before the body", async () => {
    const unreachingKey = await mintWorkingKey(ctx, {
      type_permissions: {},
    });
    const res = await send(
      "POST /items/{id}/tags",
      {
        name: "text",
        headers: { "Content-Type": "text/plain" },
        body: (payload) => payload,
      },
      unreachingKey,
    );
    expect(res.status).toBe(403);
  });
});

describe("a JSON door sent a body as JSON", () => {
  const JSON_FORMS = [
    "application/json",
    "application/json; charset=utf-8",
    "APPLICATION/JSON",
    "application/vnd.marfa+json",
  ];

  for (const type of JSON_FORMS) {
    it(`reads a body under ${type}`, async () => {
      const id = await newItem();
      const res = await ctx.app.request(`/items/${id}/tags`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.workingKey}`,
          "Content-Type": type,
        },
        body: JSON.stringify({ tags: ["read"] }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await tagsOf(id)).toEqual(["read"]);
    });
  }

  it("still refuses an empty body under a JSON type", async () => {
    const id = await newItem();
    const res = await ctx.app.request(`/items/${id}/tags`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/json",
      },
    });
    expect(res.status).toBe(400);
  });
});

async function newItem(): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "json body census" } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function metadataOf(id: string): Promise<{
  tags: string[];
  extensions: Record<string, unknown>;
}> {
  const res = await request(ctx.app, "GET", `/items/${id}/metadata`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  const { metadata } = (await res.json()) as {
    metadata: { tags: string[]; extensions: Record<string, unknown> };
  };
  return { tags: metadata.tags, extensions: metadata.extensions };
}

async function tagsOf(id: string): Promise<string[]> {
  return (await metadataOf(id)).tags;
}

describe("the three doors that lost or broke data", () => {
  const EXTENSION = "kept";
  const STORED = { value: "survives" };

  /** A note with a tag and an extension, written the ordinary way. */
  async function seeded(): Promise<string> {
    const id = await newItem();
    const tagged = await request(ctx.app, "PUT", `/items/${id}/metadata`, {
      key: ctx.workingKey,
      body: { tags: ["keep"] },
    });
    expect(tagged.status).toBe(200);
    const stored = await request(
      ctx.app,
      "PUT",
      `/items/${id}/extensions/${EXTENSION}`,
      { key: ctx.workingKey, body: STORED },
    );
    expect(stored.status).toBe(200);
    return id;
  }

  const doors = [
    {
      door: "PUT /items/{id}/metadata",
      path: (id: string) => `/items/${id}/metadata`,
      body: { tags: ["replaced"] },
      after: { tags: ["replaced"], extensions: { [EXTENSION]: STORED } },
    },
    {
      door: "POST /items/{id}/tags",
      path: (id: string) => `/items/${id}/tags`,
      body: { tags: ["added"] },
      after: { tags: ["added", "keep"], extensions: { [EXTENSION]: STORED } },
    },
    {
      door: "PATCH /items/{id}/metadata",
      path: (id: string) => `/items/${id}/metadata`,
      body: { tags: ["merged"] },
      after: { tags: ["keep", "merged"], extensions: { [EXTENSION]: STORED } },
    },
    {
      door: "PUT /items/{id}/extensions/{namespace}",
      path: (id: string) => `/items/${id}/extensions/${EXTENSION}`,
      body: { value: "replaced" },
      after: {
        tags: ["keep"],
        extensions: { [EXTENSION]: { value: "replaced" } },
      },
    },
  ];
  for (const { door, path, body, after } of doors) {
    it(`${door} changes the item as JSON, so the refusals below are of a producible write`, async () => {
      const id = await seeded();
      const res = await request(ctx.app, door.split(" ")[0]!, path(id), {
        key: ctx.workingKey,
        body,
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const now = await metadataOf(id);
      expect([...now.tags].sort()).toEqual([...after.tags].sort());
      expect(now.extensions).toEqual(after.extensions);
    });

    for (const way of WAYS) {
      it(`${door} changes nothing when sent ${way.name}`, async () => {
        const id = await seeded();
        const before = await metadataOf(id);
        expect(before).toEqual({
          tags: ["keep"],
          extensions: { [EXTENSION]: STORED },
        });
        const res = await send(door, way, ctx.workingKey, {
          path: path(id),
          payload: body,
        });
        expect(res.status, await res.clone().text()).toBe(400);
        expect(await metadataOf(id)).toEqual(before);
      });
    }
  }
});

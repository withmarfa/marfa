import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackType,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { servedDocument } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "json-body-doors",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** Published doors whose body is not JSON, each with why. */
const NOT_JSON: Record<string, string> = {
  "POST /blobs": "the bytes of a blob",
  "POST /admin/restore-archive": "a gzip archive",
};

/** A published door that takes JSON, answered by the sign-in library. */
const SIGN_IN_LIBRARY = "POST /auth/oauth2/register";

/** One way of sending a body that is not sent as JSON. */
const WAYS: {
  name: string;
  headers: Record<string, string>;
  body?: (payload: string) => string | Blob | FormData;
}[] = [
  { name: "no body and no Content-Type", headers: {} },
  {
    // A string body would make `fetch` add `text/plain` itself; a Blob with
    // no type adds nothing.
    name: "a body and no Content-Type",
    headers: {},
    body: (payload) => new Blob([payload]),
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
    name: "a body under multipart/form-data",
    headers: {},
    body: (payload) => {
      const form = new FormData();
      form.set("payload", payload);
      return form;
    },
  },
];

async function jsonDoors(): Promise<string[]> {
  const doors: string[] = [];
  const unclassified: string[] = [];
  const document = await servedDocument();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      const body = (
        operation as { requestBody?: { content?: Record<string, unknown> } }
      ).requestBody;
      if (body === undefined) continue;
      const door = `${method.toUpperCase()} ${path}`;
      const types = Object.keys(body.content ?? {});
      if (types.some((type) => /^application\/([a-z-.]+\+)?json/i.test(type))) {
        if (door !== SIGN_IN_LIBRARY) doors.push(door);
      } else if (!(door in NOT_JSON)) {
        unclassified.push(door);
      }
    }
  }
  expect(unclassified, "a body that is neither JSON nor classified").toEqual(
    [],
  );
  return doors.sort();
}

async function itemTags(id: string): Promise<unknown> {
  const res = await fetch(`${apiUrl}/items/${id}/metadata`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  expect(res.status).toBe(200);
  const { metadata } = (await res.json()) as {
    metadata: { tags: string[]; extensions: Record<string, unknown> };
  };
  return { tags: metadata.tags, extensions: metadata.extensions };
}

async function send(
  door: string,
  way: (typeof WAYS)[number],
  key: string,
  options: { path?: string; payload?: unknown } = {},
): Promise<Response> {
  const [method, template] = door.split(" ") as [string, string];
  const path =
    options.path ?? template.replace(/\{[^}]+\}/g, () => randomUUID());
  return fetch(`${apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...way.headers },
    ...(way.body === undefined
      ? {}
      : { body: way.body(JSON.stringify(options.payload ?? {})) }),
  });
}

describe("a door that takes a JSON body", () => {
  // A type door reads the type before the body, so it is asked about one the
  // key owns.
  const type = () => `user.json_body_${ctx.runId.replaceAll("-", "_")}`;

  beforeAll(async () => {
    const registered = await client.registerType({
      id: type(),
      label: "JSON body",
      version: 0,
      fields: {},
    });
    expect(registered.ok).toBe(true);
    trackType(ctx, type(), client);
  });

  it("is found for the three doors the gap lost data on, among the rest", async () => {
    const doors = await jsonDoors();
    expect(doors.length).toBeGreaterThan(30);
    expect(doors).toEqual(
      expect.arrayContaining([
        "PUT /items/{id}/metadata",
        "POST /items/{id}/tags",
        "PUT /items/{id}/extensions/{namespace}",
      ]),
    );
  });

  it("refuses a body that is missing or not sent as JSON with 400 validation_error on every such door", async () => {
    const operatorKey = process.env.MARFA_OPERATOR_KEY;
    expect(operatorKey, "MARFA_OPERATOR_KEY is required").toBeTruthy();

    const unrefused: string[] = [];
    for (const door of await jsonDoors()) {
      const options = door.startsWith("PUT /types/")
        ? { path: `/types/${type()}` }
        : {};
      for (const way of WAYS) {
        let res = await send(door, way, apiKey, options);
        if (res.status === 403) {
          res = await send(door, way, operatorKey ?? "", options);
        }
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        if (res.status !== 400 || body.error?.code !== "validation_error") {
          unrefused.push(`${door} (${way.name}): ${String(res.status)}`);
        }
      }
    }
    expect(unrefused).toEqual([]);
  }, 120_000);

  it("still reads a body sent as JSON, whatever the case or parameters of its type", async () => {
    const created = await client.createItem(createNote({ source: ctx.source }));
    expect(created.ok).toBe(true);
    const id = created.data.item.id;
    trackItem(ctx, id);
    for (const type of [
      "application/json",
      "application/json; charset=utf-8",
      "APPLICATION/JSON",
    ]) {
      const res = await fetch(`${apiUrl}/items/${id}/tags`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": type },
        body: JSON.stringify({ tags: [type.length.toString()] }),
      });
      expect(res.status, type).toBe(200);
    }
  });
});

describe("the doors that lost or broke data without a JSON Content-Type", () => {
  const NAMESPACE = "json-body";
  const STORED = { value: "survives" };

  async function seeded(): Promise<string> {
    const created = await client.createItem(
      createNote({ source: ctx.source, tags: ["keep"] }),
    );
    expect(created.ok).toBe(true);
    const id = created.data.item.id;
    trackItem(ctx, id);
    const stored = await client.setItemExtension(id, NAMESPACE, STORED);
    expect(stored.ok).toBe(true);
    return id;
  }

  const DOORS = [
    {
      door: "PUT /items/{id}/metadata",
      path: (id: string) => `/items/${id}/metadata`,
      body: { tags: ["replaced"] },
      after: { tags: ["replaced"], extensions: { [NAMESPACE]: STORED } },
    },
    {
      door: "POST /items/{id}/tags",
      path: (id: string) => `/items/${id}/tags`,
      body: { tags: ["added"] },
      after: { tags: ["added", "keep"], extensions: { [NAMESPACE]: STORED } },
    },
    {
      door: "PATCH /items/{id}/metadata",
      path: (id: string) => `/items/${id}/metadata`,
      body: { tags: ["merged"] },
      after: { tags: ["keep", "merged"], extensions: { [NAMESPACE]: STORED } },
    },
    {
      door: "PUT /items/{id}/extensions/{namespace}",
      path: (id: string) => `/items/${id}/extensions/${NAMESPACE}`,
      body: { value: "replaced" },
      after: {
        tags: ["keep"],
        extensions: { [NAMESPACE]: { value: "replaced" } },
      },
    },
  ];

  it("writes each of these doors when the body is sent as JSON", async () => {
    for (const { door, path, body, after } of DOORS) {
      const id = await seeded();
      const [method] = door.split(" ") as [string];
      const res = await fetch(`${apiUrl}${path(id)}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(res.status, door).toBe(200);
      const now = (await itemTags(id)) as { tags: string[] };
      expect({ ...now, tags: [...now.tags].sort() }, door).toEqual({
        ...after,
        tags: [...after.tags].sort(),
      });
    }
  });

  it("changes nothing on these doors when the body is not sent as JSON", async () => {
    for (const { door, path, body } of DOORS) {
      const id = await seeded();
      const before = await itemTags(id);
      expect(before).toEqual({
        tags: ["keep"],
        extensions: { [NAMESPACE]: STORED },
      });
      for (const way of WAYS) {
        const res = await send(door, way, apiKey, {
          path: path(id),
          payload: body,
        });
        expect(res.status, `${door} ${way.name}`).toBe(400);
        expect(await itemTags(id), `${door} ${way.name}`).toEqual(before);
      }
    }
  });
});

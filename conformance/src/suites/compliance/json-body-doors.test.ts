import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { itemsArchive } from "../../utils/archive.js";
import {
  createSecondClient,
  getOwnerClient,
  createTestContext,
  trackItem,
  trackKey,
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
  "POST /restore": "a gzip archive",
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
    const managementKey = process.env.MARFA_MANAGEMENT_KEY;
    expect(managementKey, "MARFA_MANAGEMENT_KEY is required").toBeTruthy();

    const unrefused: string[] = [];
    for (const door of await jsonDoors()) {
      const options = door.startsWith("PUT /types/")
        ? { path: `/types/${type()}` }
        : {};
      for (const way of WAYS) {
        let res = await send(door, way, apiKey, options);
        if (res.status === 403) {
          res = await send(door, way, managementKey ?? "", options);
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

/** What a JSON door answers a body not sent as JSON (`errors/json-content-type`). */
async function expectRefusedAsNotJson(): Promise<void> {
  const res = await fetch(`${apiUrl}/items`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "text/plain",
    },
    body: JSON.stringify({ type: "core.note", properties: { body: "x" } }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
    "validation_error",
  );
}

describe("a door that does not take its body as JSON", () => {
  it("takes the bytes of a blob sent under text/plain, which a JSON door refuses when sent that way", async () => {
    await expectRefusedAsNotJson();

    const bytes = `blob bytes ${ctx.runId}`;
    const res = await fetch(`${apiUrl}/blobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "text/plain",
      },
      body: bytes,
    });
    expect(res.status).toBe(201);
    const stored = (await res.json()) as {
      hash: string;
      mime_type: string;
      size_bytes: number;
    };
    expect(stored.mime_type).toBe("text/plain");
    expect(stored.size_bytes).toBe(Buffer.byteLength(bytes));
  });

  it("takes an archive sent under text/plain, which a JSON door refuses when sent that way", async () => {
    await expectRefusedAsNotJson();
    const managementKey = process.env.MARFA_MANAGEMENT_KEY;
    expect(managementKey, "MARFA_MANAGEMENT_KEY is required").toBeTruthy();

    const id = uuidv7();
    const archive = itemsArchive([
      {
        id,
        type: "core.note",
        source: ctx.source,
        source_id: `restore-text-plain-${ctx.runId}`,
        properties: { body: "restored under text/plain" },
      },
    ]);
    const res = await getOwnerClient().rawRequest<{ imported: number }>(
      "/restore",
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: Buffer.from(archive),
      },
    );
    trackItem(ctx, id);
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    expect(res.data.imported).toBe(1);
  });

  it("takes a delivery to an inbound address sent under text/plain, which a JSON door refuses when sent that way", async () => {
    await expectRefusedAsNotJson();

    const owner = await createSecondClient(ctx, "inbound-owner");
    const registered = await owner.registerConnector({
      name: `${ctx.runId} inbound`,
    });
    expect(registered.status).toBe(201);
    const endpoint = await owner.createInboundEndpoint(registered.data.id, {});
    expect(endpoint.status).toBe(201);

    const res = await fetch(`${apiUrl}${endpoint.data.path}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "a sender's delivery, not JSON",
    });
    expect(res.status).toBe(202);
  });

  it("leaves a registration that is not sent as JSON to the sign-in library, which answers 415 in its own shape", async () => {
    const registration = {
      redirect_uris: ["https://example.com/callback"],
      client_name: `${ctx.source}-not-json-registration`,
    };
    // The witness: the same registration sent as JSON is made.
    const made = await fetch(`${apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    });
    expect(made.status).toBe(201);

    for (const headers of [
      { "Content-Type": "text/plain" },
      {} as Record<string, string>,
    ]) {
      const res = await fetch(`${apiUrl}/auth/oauth2/register`, {
        method: "POST",
        headers,
        body: new Blob([JSON.stringify(registration)], {
          type: headers["Content-Type"] ?? "",
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status, JSON.stringify(headers)).toBe(415);
      expect(body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
      expect(body).not.toHaveProperty("error");
    }
  });
});

const NOT_JSON_WAY = WAYS.find((way) => way.name === "a body under text/plain");

function plainTextWay(): (typeof WAYS)[number] {
  if (NOT_JSON_WAY === undefined) throw new Error("no text/plain way");
  return NOT_JSON_WAY;
}

describe("a request the door would refuse before it reads the body", () => {
  const type = () => `user.json_order_${ctx.runId.replaceAll("-", "_")}`;

  beforeAll(async () => {
    const registered = await client.registerType({
      id: type(),
      label: "JSON order",
      version: 0,
      fields: {},
    });
    expect(registered.ok).toBe(true);
    trackType(ctx, type(), client);
  });

  async function mintKey(
    label: string,
    permissions: string[],
  ): Promise<string> {
    const minted = await client.createKey({
      label: `${ctx.source}-${label}`,
      source: `${ctx.source}-${label}`,
      permissions,
      type_permissions: { "*": "write" },
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    trackKey(ctx, minted.data.id);
    return minted.data.key;
  }

  it("answers 401 on every JSON door to a request with no credential, whatever body it sent, where a credential reaches the body's refusal", async () => {
    const managementKey = process.env.MARFA_MANAGEMENT_KEY;
    expect(managementKey, "MARFA_MANAGEMENT_KEY is required").toBeTruthy();
    const way = plainTextWay();

    const wrong: string[] = [];
    const doors = (await jsonDoors()).filter((door) => door !== "POST /owner");
    expect(doors.length).toBeGreaterThan(30);
    for (const door of doors) {
      const options = door.startsWith("PUT /types/")
        ? { path: `/types/${type()}` }
        : {};
      const [method, template] = door.split(" ") as [string, string];
      const path =
        options.path ?? template.replace(/\{[^}]+\}/g, () => randomUUID());

      const anonymous = await fetch(`${apiUrl}${path}`, {
        method,
        headers: way.headers,
        body: way.body?.("{}"),
      });
      const refusal = (await anonymous.json()) as { error?: { code?: string } };
      if (anonymous.status !== 401 || refusal.error?.code !== "unauthorized") {
        wrong.push(`${door} with no credential: ${String(anonymous.status)}`);
      }

      // The witness: a credential that reaches the door is answered for the
      // body, so the 401 above was the credential's absence and nothing else.
      let reached = await send(door, way, apiKey, options);
      if (reached.status === 403) {
        reached = await send(door, way, managementKey ?? "", options);
      }
      if (reached.status !== 400) {
        wrong.push(`${door} with a credential: ${String(reached.status)}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it("answers 403 forbidden to a key lacking the standing permission a door checks, where a key holding it is answered 400 for the same body", async () => {
    const doors: { door: string; permission: string }[] = [
      { door: "POST /webhooks", permission: "webhooks.manage" },
      { door: "PUT /config", permission: "config.manage" },
      { door: "POST /keys", permission: "keys.mint" },
    ];
    const way = plainTextWay();
    const without = await mintKey("without-permission", []);

    for (const { door, permission } of doors) {
      const refused = await send(door, way, without);
      const refusal = (await refused.json()) as {
        error: { code: string; details?: { required_scope?: string } };
      };
      expect(refused.status, door).toBe(403);
      expect(refusal.error.code, door).toBe("forbidden");
      expect(refusal.error.details?.required_scope, door).toBe(permission);

      const holder = await mintKey(`holds-${permission}`, [permission]);
      const answered = await send(door, way, holder);
      expect(answered.status, door).toBe(400);
      expect(
        ((await answered.json()) as { error: { code: string } }).error.code,
        door,
      ).toBe("validation_error");
    }
  });

  it("checks a public claim body's format without treating a key as setup proof", async () => {
    const way = plainTextWay();
    for (const key of [apiKey, process.env.MARFA_MANAGEMENT_KEY ?? ""]) {
      const response = await send("POST /owner", way, key);
      expect(response.status).toBe(400);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code,
      ).toBe("validation_error");
    }
  });

  it("answers 400 to a key that holds no grant on an item's type, since that grant is checked after the body, and 403 once the body is JSON", async () => {
    const created = await client.createItem(createNote({ source: ctx.source }));
    expect(created.ok).toBe(true);
    const id = created.data.item.id;
    trackItem(ctx, id);
    const minted = await client.createKey({
      label: `${ctx.source}-reads-notes`,
      source: `${ctx.source}-reads-notes`,
      type_permissions: { "core.note": "read" },
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    trackKey(ctx, minted.data.id);

    // The witness: the grant is what the door will want, so a body sent as
    // JSON is refused for the missing grant.
    const asJson = await fetch(`${apiUrl}/items/${id}/tags`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${minted.data.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags: ["x"] }),
    });
    expect(asJson.status).toBe(403);
    expect(
      ((await asJson.json()) as { error: { code: string } }).error.code,
    ).toBe("type_not_permitted");

    const asText = await send(
      "POST /items/{id}/tags",
      plainTextWay(),
      minted.data.key,
      {
        path: `/items/${id}/tags`,
      },
    );
    expect(asText.status).toBe(400);
    expect(
      ((await asText.json()) as { error: { code: string } }).error.code,
    ).toBe("validation_error");
  });
});

describe("an Idempotency-Key reused with a body sent under another Content-Type", () => {
  function post(
    key: string,
    contentType: string | undefined,
  ): Promise<Response> {
    const body = JSON.stringify({
      type: "core.note",
      source: ctx.source,
      properties: { body: key },
    });
    return fetch(`${apiUrl}/items`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Idempotency-Key": key,
        ...(contentType === undefined ? {} : { "Content-Type": contentType }),
      },
      body: contentType === undefined ? new Blob([body]) : body,
    });
  }

  /** How many notes this file's key holds whose body is the key written. */
  async function written(key: string): Promise<number> {
    const listed = await client.listItems({
      source: ctx.source,
      type: "core.note",
      limit: 200,
    });
    expect(listed.ok).toBe(true);
    return listed.data.data.filter((item) => item.properties.body === key)
      .length;
  }

  it("answers 422 idempotency_key_reused to a retry sent as JSON after a first request that was not, and writes nothing", async () => {
    for (const notJson of ["text/plain", undefined]) {
      const key = `not-json-first-${ctx.runId}-${String(notJson)}`;

      const first = await post(key, notJson);
      expect(first.status, String(notJson)).toBe(400);
      expect(await written(key)).toBe(0);

      const retry = await post(key, "application/json");
      expect(retry.status, String(notJson)).toBe(422);
      expect(retry.headers.get("X-Error-Code")).toBe("idempotency_key_reused");
      expect(retry.headers.get("Idempotency-Replayed")).toBeNull();
      expect(await written(key)).toBe(0);
    }
  });

  it("answers 422 idempotency_key_reused to a retry not sent as JSON after a first request that was, and replays nothing", async () => {
    const key = `json-first-${ctx.runId}`;

    const first = await post(key, "application/json");
    expect(first.status).toBe(201);
    const created = (await first.json()) as { item: { id: string } };
    trackItem(ctx, created.item.id);
    expect(await written(key)).toBe(1);

    const retry = await post(key, "text/plain");
    expect(retry.status).toBe(422);
    expect(retry.headers.get("X-Error-Code")).toBe("idempotency_key_reused");
    expect(retry.headers.get("Idempotency-Replayed")).toBeNull();
    expect(await written(key)).toBe(1);

    // The witness: the key holds the first answer, which the same request
    // replays.
    const replay = await post(key, "application/json");
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(((await replay.json()) as { item: { id: string } }).item.id).toBe(
      created.item.id,
    );
  });

  it("replays to a retry that spells the JSON type another way", async () => {
    const key = `spelling-${ctx.runId}`;
    const first = await post(key, "application/json; charset=utf-8");
    expect(first.status).toBe(201);
    const created = (await first.json()) as { item: { id: string } };
    trackItem(ctx, created.item.id);

    for (const spelling of ["application/json", "APPLICATION/JSON"]) {
      const retry = await post(key, spelling);
      expect(retry.status, spelling).toBe(201);
      expect(retry.headers.get("Idempotency-Replayed"), spelling).toBe("true");
      expect(
        ((await retry.json()) as { item: { id: string } }).item.id,
        spelling,
      ).toBe(created.item.id);
    }
    expect(await written(key)).toBe(1);
  });
});

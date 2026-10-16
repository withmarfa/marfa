import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createSecondClient,
  createTestContext,
  trackItem,
} from "../../utils/setup.js";
import { publishedOperations } from "../../utils/openapi.js";

const HEADER = "X-Marfa-Instance-Id";
/** Well formed, and the id of no instance: `instance/id-per-instance`. */
const OTHER = "019537a0-7b80-7000-8000-0000000000ff";

let ctx: TestContext;
let client: MarfaClient;
let apiUrl: string;
let apiKey: string;
let own: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "instance-header",
  ));
  const root = await fetch(`${apiUrl}/`, {
    headers: { Accept: "application/json" },
  });
  own = ((await root.json()) as { instance_id: string }).instance_id;
  expect(own).not.toBe(OTHER);
});

afterAll(async () => {
  await cleanup(ctx);
});

function send(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    credential?: boolean;
  } = {},
): Promise<Response> {
  return fetch(`${apiUrl}${path}`, {
    method: init.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      ...(init.credential === false
        ? {}
        : { Authorization: `Bearer ${apiKey}` }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.clone().json()) as { error?: { code?: string } }).error
    ?.code;
}

function note(body: string) {
  return { type: "core.note", source: ctx.source, properties: { body } };
}

/** The notes this file's source holds with `body`, read back by search. */
async function held(body: string): Promise<number> {
  const listed = await client.listItems({
    type: "core.note",
    source: ctx.source,
    limit: 200,
  });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  return listed.data.data.filter(
    (row) => (row.properties as { body?: string }).body === body,
  ).length;
}

async function created(res: Response): Promise<string> {
  expect(res.status).toBe(201);
  const id = ((await res.clone().json()) as { item: { id: string } }).item.id;
  trackItem(ctx, id);
  return id;
}

describe("a write that names an instance", () => {
  it("takes a write naming this instance, and refuses one naming another 409 instance_changed without writing it", async () => {
    const body = `named ${ctx.runId}`;
    await created(
      await send("/items", { body: note(body), headers: { [HEADER]: own } }),
    );
    expect(await held(body)).toBe(1);

    const elsewhere = `elsewhere ${ctx.runId}`;
    const refused = await send("/items", {
      body: note(elsewhere),
      headers: { [HEADER]: OTHER },
    });
    expect(refused.status).toBe(409);
    expect(await codeOf(refused)).toBe("instance_changed");
    expect(refused.headers.get("X-Error-Code")).toBe("instance_changed");
    expect(await held(elsewhere), "a refused write was written").toBe(0);

    // The witness: the same write naming no instance is taken.
    await created(await send("/items", { body: note(elsewhere) }));
    expect(await held(elsewhere)).toBe(1);
  });

  it("refuses an empty, repeated, uppercase or malformed instance id 400 validation_error", async () => {
    for (const value of [
      "",
      "not-an-instance",
      own.toUpperCase(),
      randomUUID(),
      `${own}, ${own}`,
    ]) {
      const res = await send("/items", {
        body: note(`malformed ${ctx.runId}`),
        headers: { [HEADER]: value },
      });
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(await codeOf(res), value).toBe("validation_error");
    }
    expect(await held(`malformed ${ctx.runId}`)).toBe(0);
  });

  it("answers 401 before it judges the header, and judges it before the write's own refusals", async () => {
    for (const value of [OTHER, "not-an-instance"]) {
      const res = await send("/items", {
        body: note("no credential"),
        headers: { [HEADER]: value },
        credential: false,
      });
      expect(res.status, value).toBe(401);
      expect(await codeOf(res), value).toBe("unauthorized");
    }

    // A body with no type, and an update of a row that does not exist.
    const shapeless = await send("/items", {
      body: { properties: { body: "no type" } },
      headers: { [HEADER]: OTHER },
    });
    expect(await codeOf(shapeless)).toBe("instance_changed");
    const missing = await send(`/items/${uuidv7()}`, {
      method: "PATCH",
      body: { properties: { body: "nowhere" }, version: 1 },
      headers: { [HEADER]: OTHER },
    });
    expect(await codeOf(missing)).toBe("instance_changed");
    const malformed = await send("/items", {
      body: { properties: { body: "no type" } },
      headers: { [HEADER]: "not-an-instance" },
    });
    expect(malformed.status).toBe(400);
    expect(await codeOf(malformed)).toBe("validation_error");

    // The witnesses: without the header each is refused for itself.
    expect(
      (await send("/items", { body: { properties: { body: "no type" } } }))
        .status,
    ).toBe(400);
    const plainMissing = await send(`/items/${uuidv7()}`, {
      method: "PATCH",
      body: { properties: { body: "nowhere" }, version: 1 },
    });
    expect(plainMissing.status).toBe(404);
  });

  it("keeps no refusal under an Idempotency-Key, and replays the first answer whatever instance the repeat names", async () => {
    const key = `instance-header-${randomUUID()}`;
    const body = note(`keyed ${key}`);
    const refused = await send("/items", {
      body,
      headers: { "Idempotency-Key": key, [HEADER]: OTHER },
    });
    expect(refused.status).toBe(409);
    expect(await codeOf(refused)).toBe("instance_changed");

    const first = await send("/items", {
      body,
      headers: { "Idempotency-Key": key, [HEADER]: own },
    });
    await created(first);
    expect(
      first.headers.get("Idempotency-Replayed"),
      "the refusal was kept under the key",
    ).toBeNull();
    const written = await first.json();

    const again = await send("/items", {
      body,
      headers: { "Idempotency-Key": key },
    });
    expect(again.status).toBe(201);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await again.json()).toEqual(written);

    const elsewhere = await send("/items", {
      body,
      headers: { "Idempotency-Key": key, [HEADER]: OTHER },
    });
    expect(elsewhere.status, "the recorded answer was replayed").toBe(409);
    expect(await codeOf(elsewhere)).toBe("instance_changed");
    expect(elsewhere.headers.get("Idempotency-Replayed")).toBeNull();
    expect(await held(`keyed ${key}`)).toBe(1);
  });

  it("refuses another instance on POST /items/bulk-get and POST /items/lookup", async () => {
    const bulkGet = await send("/items/bulk-get", {
      body: { ids: [uuidv7()] },
      headers: { [HEADER]: OTHER },
    });
    expect(bulkGet.status).toBe(409);
    expect(await codeOf(bulkGet)).toBe("instance_changed");
    const lookup = await send("/items/lookup", {
      body: { type: "core.note", ids: [uuidv7()] },
      headers: { [HEADER]: OTHER },
    });
    expect(lookup.status).toBe(409);
    expect(await codeOf(lookup)).toBe("instance_changed");

    // The witnesses: the same reads naming this instance are answered.
    for (const [path, read] of [
      ["/items/bulk-get", { ids: [uuidv7()] }],
      ["/items/lookup", { type: "core.note", ids: [uuidv7()] }],
    ] as const) {
      const res = await send(path, { body: read, headers: { [HEADER]: own } });
      expect(res.status, path).toBe(200);
    }
  });

  it("refuses another instance on every write operation the document publishes outside /auth", async () => {
    const writes = (await publishedOperations()).filter(
      (op) => op.method !== "GET" && !/^\/auth(\/|$)/.test(op.path),
    );
    // The positive control: an empty walk would pass the loop below.
    expect(writes.length).toBeGreaterThan(50);
    const missed: string[] = [];
    for (const op of writes) {
      const path = op.path.replace(/\{[^}]+\}/g, uuidv7());
      const res = await send(path, {
        method: op.method,
        body: {},
        headers: { [HEADER]: OTHER },
      });
      if (res.status !== 409 || (await codeOf(res)) !== "instance_changed")
        missed.push(`${op.method} ${op.path} answered ${String(res.status)}`);
    }
    expect(missed).toEqual([]);
  });

  it("answers a GET, a request under /auth and an inbound delivery as it answers one without the header", async () => {
    for (const value of [OTHER, "not-an-instance"]) {
      const read = await fetch(
        `${apiUrl}/items?type=core.note&source=${encodeURIComponent(ctx.source)}`,
        { headers: { Authorization: `Bearer ${apiKey}`, [HEADER]: value } },
      );
      expect(read.status, value).toBe(200);
    }

    const register = (headers: Record<string, string>) =>
      fetch(`${apiUrl}/auth/oauth2/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ redirect_uris: ["not a uri"] }),
      });
    const plain = await register({});
    const named = await register({ [HEADER]: OTHER });
    expect(named.status).toBe(plain.status);
    expect(named.headers.get("X-Error-Code")).not.toBe("instance_changed");

    const sender = await createSecondClient(ctx, "inbound");
    const registered = await sender.registerConnector({
      name: `${ctx.runId} instance header`,
    });
    expect(registered.status).toBe(201);
    const endpoint = await sender.createInboundEndpoint(registered.data.id, {});
    expect(endpoint.status).toBe(201);
    const delivered = await deliver(endpoint.data.path, [HEADER, OTHER]);
    expect(delivered, "an inbound delivery naming another instance").toBe(202);
    // The witness: the same address takes a delivery naming nothing.
    expect(await deliver(endpoint.data.path, [])).toBe(202);
  });
});

/** A sender's post, which holds no credential and knows no instance. */
function deliver(path: string, headers: string[]): Promise<number> {
  const url = new URL(path, apiUrl);
  const bytes = Buffer.from(JSON.stringify({ event: "ping" }));
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: [
          "Host",
          url.host,
          "Content-Type",
          "application/json",
          ...headers,
          "Content-Length",
          String(bytes.length),
        ],
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(bytes);
  });
}

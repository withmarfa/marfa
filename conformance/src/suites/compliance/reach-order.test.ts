import { TEST_OWNER } from "../../utils/target.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  cleanup,
  newRunId,
  trackItem,
  trackKey,
  trackType,
} from "../../utils/setup.js";
import { collectUntil, withStream } from "../../utils/stream.js";

const COPY_QUERY: Array<[string, string]> = [
  ["edges", "all"],
  ["copy", "1"],
];
const FRAME_BUDGET_MS = 15_000;
/** Well formed, and not the reach of any credential. */
const STALE = "0".repeat(64);
const CHANGED = {
  error: {
    code: "reach_changed",
    message: "The reach changed. Rebuild the working copy.",
  },
};

let server: FreshServer;
let client: MarfaClient;
let management: MarfaClient;
let nowhere: string;
let ctx: TestContext;

beforeAll(async () => {
  server = await bootFreshServer("reach-order");
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  management = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
  ctx = {
    runId: newRunId(),
    source: "reach-order",
    trackedItems: [],
    trackedKeys: [],
    trackedEdges: [],
    trackedEdgeTypes: [],
    trackedFolders: [],
    trackedViews: [],
    trackedWebhooks: [],
    trackedTypes: [],
    client,
    provisioningClient: management,
  };
  const minted = await management.createKey({
    label: "reach-order-nowhere",
    source: `${ctx.source}-nowhere-${ctx.runId}`,
    permissions: [],
    type_permissions: { "*": "none" },
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  nowhere = minted.data.key;
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  try {
    if (ctx) await cleanup(ctx);
  } finally {
    await server?.stop();
  }
}, FRESH_SERVER_TIMEOUT_MS);

function request(
  path: string,
  init: {
    proof?: string;
    key?: string | null;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
) {
  const key = init.key === undefined ? server.workingKey : init.key;
  return fetch(`${server.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(key === null ? {} : { Authorization: `Bearer ${key}` }),
      ...(init.proof === undefined ? {} : { "X-Marfa-Reach": init.proof }),
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

async function expectRefused(
  response: Response,
  status: number,
  code: string,
  label = "",
) {
  expect(response.status, label).toBe(status);
  expect(await codeOf(response), label).toBe(code);
  expect(response.headers.get("X-Marfa-Reach"), label).toBeNull();
}

async function changed(response: Response, label = "") {
  expect(response.status, label).toBe(409);
  expect(await response.json(), label).toEqual(CHANGED);
  expect(response.headers.get("X-Error-Code"), label).toBe("reach_changed");
  expect(response.headers.get("X-Marfa-Reach"), label).toBeNull();
}

async function seed(body: string) {
  const result = await client.createItem({
    type: "core.note",
    properties: { body },
  });
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  trackItem(ctx, result.data.item.id);
  return result.data.item;
}

interface Proof {
  cursor: string;
  reach: string;
}

/** The credential's reach and a cursor, from a copy stream's live marker. */
async function bootstrap(key = server.workingKey): Promise<Proof> {
  return withStream(
    server.apiUrl,
    key,
    { query: COPY_QUERY },
    async (stream) => {
      expect(stream.response.status).toBe(200);
      const { events } = await collectUntil(
        stream,
        (frames) => frames.some((frame) => frame.event === "stream_live"),
        "the copy stream's live marker",
        AbortSignal.timeout(FRAME_BUDGET_MS),
      );
      const live = events.find((frame) => frame.event === "stream_live");
      return live!.data as Proof;
    },
  );
}

/** The reach a credential's matching proof is certified under, or not. */
async function holds(proof: Proof, key = server.workingKey, label = "") {
  const answer = await request("/items?include=metadata&limit=1", {
    proof: proof.reach,
    key,
  });
  expect(answer.status, label).toBe(200);
  expect(answer.headers.get("X-Marfa-Reach"), label).toBe(proof.reach);
  await answer.body?.cancel();
  expect((await bootstrap(key)).reach, label).toBe(proof.reach);
}

async function moves(proof: Proof, key = server.workingKey, label = "") {
  await changed(
    await request("/items?include=metadata&limit=1", {
      proof: proof.reach,
      key,
    }),
    label,
  );
  const next = await bootstrap(key);
  expect(next.reach, label).not.toBe(proof.reach);
  return next;
}

/** The copy stream's answer for a request, read as a status and a refusal. */
async function copyStream(
  key: string | null,
  options: {
    query?: Array<[string, string]>;
    headers?: Record<string, string>;
  },
) {
  const query = new URLSearchParams(options.query ?? COPY_QUERY).toString();
  const controller = new AbortController();
  const response = await fetch(`${server.apiUrl}/events?${query}`, {
    signal: controller.signal,
    headers: {
      ...(key === null ? {} : { Authorization: `Bearer ${key}` }),
      ...options.headers,
    },
  });
  // A started stream never ends on its own; a refusal is read to its end.
  if (response.status === 200) controller.abort();
  return response;
}

describe("the reach header on a write", () => {
  it("answers a write carrying a stale, a malformed or a matching reach as it answers one without the header", async () => {
    const proof = await bootstrap();
    const row = await seed("a row for the writes");
    const headers = [
      ["stale", STALE],
      ["matching", proof.reach],
      ["malformed", "not-a-reach"],
      ["uppercase", proof.reach.toUpperCase()],
    ];
    // The witness: the doors are conditional reads for a GET, so the same
    // stale value answers 409 on one.
    await changed(await request("/items?include=metadata", { proof: STALE }));

    for (const [name, value] of headers) {
      const created = await request("/items", {
        method: "POST",
        proof: value,
        body: {
          type: "core.note",
          source: ctx.source,
          properties: { body: `created under a ${name} reach` },
        },
      });
      expect(created.status, name).toBe(201);
      expect(created.headers.get("X-Marfa-Reach"), name).toBeNull();
      const made = (await created.json()) as { item: { id: string } };
      trackItem(ctx, made.item.id);

      const updated = await request(`/items/${row.id}`, {
        method: "PATCH",
        proof: value,
        body: { properties: { body: `updated under a ${name} reach` } },
      });
      expect(updated.status, `${name} without a version`).toBe(400);
      expect(await codeOf(updated), name).toBe("missing_required_field");
    }

    let version = row.version;
    for (const [name, value] of headers) {
      const updated = await request(`/items/${row.id}`, {
        method: "PATCH",
        proof: value,
        body: {
          properties: { body: `updated under a ${name} reach` },
          version,
        },
      });
      expect(updated.status, name).toBe(200);
      expect(updated.headers.get("X-Marfa-Reach"), name).toBeNull();
      version += 1;
      const read = await client.getItem(row.id);
      expect(read.data.item.version, name).toBe(version);
      expect(read.data.item.properties.body).toBe(
        `updated under a ${name} reach`,
      );
    }

    const id = uuidv7();
    const bulk = await request("/items/bulk", {
      method: "POST",
      proof: STALE,
      body: {
        atomic: false,
        items: [
          {
            id,
            type: "core.note",
            source: ctx.source,
            properties: { body: "bulk under a stale reach" },
          },
        ],
      },
    });
    expect(bulk.status).toBe(200);
    trackItem(ctx, id);
    const results = (await bulk.json()) as {
      results: Array<{ outcome: string }>;
    };
    expect(
      results.results.map((r) => r.outcome),
      JSON.stringify(results),
    ).toEqual(["created"]);
  });

  it("replays a write under one Idempotency-Key whatever reach header it carries, and still refuses the key for another body", async () => {
    const key = `order-${randomUUID()}`;
    const body = {
      type: "core.note",
      source: ctx.source,
      properties: { body: `idempotent ${ctx.runId}` },
    };
    const send = (headers: Record<string, string>, payload = body) =>
      request("/items", {
        method: "POST",
        headers: { "Idempotency-Key": key, ...headers },
        body: payload,
      });

    const first = await send({ "X-Marfa-Reach": STALE });
    expect(first.status).toBe(201);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();
    const written = (await first.json()) as { item: { id: string } };
    trackItem(ctx, written.item.id);

    const repeats: Array<Record<string, string>> = [
      { "X-Marfa-Reach": "f".repeat(64) },
      { "X-Marfa-Reach": "not-a-reach" },
      {},
    ];
    for (const headers of repeats) {
      const again = await send(headers);
      const label = JSON.stringify(headers);
      expect(again.status, label).toBe(201);
      expect(again.headers.get("Idempotency-Replayed"), label).toBe("true");
      expect(again.headers.get("X-Marfa-Reach"), label).toBeNull();
      expect(await again.json(), label).toEqual(written);
    }

    // The witness: the fingerprint is live, so another body under the key
    // is refused, whatever header it carries.
    const reused = await send(
      { "X-Marfa-Reach": STALE },
      { ...body, properties: { body: "another body" } },
    );
    await expectRefused(reused, 422, "idempotency_key_reused");
  });
});

describe("the order POST /items/bulk-get asks its refusals in", () => {
  it("answers 401, then 400 to a malformed reach, then 409 to a stale one before it checks the ids or asks whether the key reaches any type", async () => {
    const row = await seed("bulk-get order");
    const proof = await bootstrap();
    const bulkGet = (
      body: unknown,
      reach?: string,
      key?: string | null,
    ): Promise<Response> =>
      request("/items/bulk-get", {
        method: "POST",
        body,
        ...(reach === undefined ? {} : { proof: reach }),
        ...(key === undefined ? {} : { key }),
      });

    // The witness: the door is a conditional read, so the matching reach is
    // certified on it.
    const witness = await bulkGet({ ids: [row.id] }, proof.reach);
    expect(witness.status).toBe(200);
    expect(witness.headers.get("X-Marfa-Reach")).toBe(proof.reach);
    await witness.body?.cancel();

    for (const key of [null, "invalid"]) {
      for (const reach of [STALE, "not-a-reach"]) {
        const anonymous = await bulkGet({ ids: "not-a-list" }, reach, key);
        expect(anonymous.status, `${String(key)} ${reach}`).toBe(401);
        expect(anonymous.headers.get("X-Marfa-Reach")).toBeNull();
        await anonymous.body?.cancel();
      }
    }

    for (const [name, malformed] of [
      ["uppercase", proof.reach.toUpperCase()],
      ["short", proof.reach.slice(1)],
      ["not hexadecimal", `g${proof.reach.slice(1)}`],
      ["empty", ""],
      ["listed twice", `${proof.reach}, ${proof.reach}`],
    ] as const) {
      await expectRefused(
        await bulkGet({ ids: [row.id] }, malformed),
        400,
        "validation_error",
        name,
      );
    }

    const bodies: Array<[string, unknown, string]> = [
      ["ids not a list", { ids: "not-a-list" }, "validation_error"],
      ["no ids", {}, "missing_required_field"],
      [
        "over the cap",
        { ids: Array.from({ length: 101 }, () => uuidv7()) },
        "validation_error",
      ],
      ["a malformed id", { ids: ["not-an-id"] }, "invalid_id"],
    ];
    for (const [name, body, code] of bodies) {
      // The witness: under the matching reach the body is refused, and the
      // refusal is not certified.
      await expectRefused(await bulkGet(body, proof.reach), 400, code, name);
      await changed(await bulkGet(body, STALE), name);
    }

    const capped = await bulkGet(
      { ids: Array.from({ length: 101 }, () => uuidv7()) },
      proof.reach,
    );
    expect(capped.status).toBe(400);
    expect(
      ((await capped.json()) as { error: { details?: { cap?: number } } }).error
        .details?.cap,
    ).toBe(100);

    // The witness: without the header, the key that reaches no type is
    // refused 403.
    await expectRefused(
      await bulkGet({ ids: [row.id] }, undefined, nowhere),
      403,
      "type_not_permitted",
    );
    await changed(await bulkGet({ ids: [row.id] }, STALE, nowhere));
  });
});

describe("the order a conditional GET asks its refusals in", () => {
  it("answers 400 to a malformed copy of a stale reach, and 409 to the stale reach itself", async () => {
    const row = await seed("a row to retype");
    const proof = await bootstrap();
    const door = "/items?include=metadata";
    const witness = await request(door, { proof: proof.reach });
    expect(witness.status).toBe(200);
    expect(witness.headers.get("X-Marfa-Reach")).toBe(proof.reach);

    const retyped = await client.updateItem(row.id, {
      version: row.version,
      type: "core.bookmark",
      retype: true,
      properties: { url: "https://example.com/reach-order" },
    });
    expect(retyped.ok, JSON.stringify(retyped.error)).toBe(true);

    // The proof is now the old one, exactly as the server issued it.
    await changed(await request(door, { proof: proof.reach }));
    for (const [name, malformed] of [
      ["uppercase", proof.reach.toUpperCase()],
      ["short", proof.reach.slice(1)],
      ["long", `${proof.reach}0`],
      ["not hexadecimal", `g${proof.reach.slice(1)}`],
      ["empty", ""],
      ["listed twice", `${proof.reach}, ${proof.reach}`],
    ] as const) {
      await expectRefused(
        await request(door, { proof: malformed }),
        400,
        "validation_error",
        name,
      );
    }
    const repeated = await fetch(`${server.apiUrl}${door}`, {
      headers: [
        ["Authorization", `Bearer ${server.workingKey}`],
        ["X-Marfa-Reach", proof.reach],
        ["X-Marfa-Reach", proof.reach],
      ],
    });
    await expectRefused(repeated, 400, "validation_error", "sent twice");
  });

  it("answers 400 to an item page that asks for no metadata, though its reach is stale", async () => {
    // The witness: a stale reach on a page that asks for metadata is 409.
    await changed(
      await request("/items?include=metadata", { proof: STALE }),
      "metadata",
    );
    for (const query of [
      "/items",
      "/items?include=edges",
      "/items?include=",
      "/items?include=Metadata",
      "/items?include=metadatas",
    ]) {
      await expectRefused(
        await request(query, { proof: STALE }),
        400,
        "validation_error",
        query,
      );
    }
    // And the page with no header is an ordinary read.
    const plain = await request("/items?limit=1");
    expect(plain.status).toBe(200);
    expect(plain.headers.get("X-Marfa-Reach")).toBeNull();
    await plain.body?.cancel();
  });
});

describe("the order a copy stream asks its refusals in", () => {
  it("answers 401 to a request with no credential before it asks the reach", async () => {
    const proof = await bootstrap();
    const headers = {
      "Last-Event-ID": proof.cursor,
      "X-Marfa-Reach": STALE,
    };
    // The witness: with a credential the same request is a stale reach.
    await changed(await copyStream(server.workingKey, { headers }));

    for (const key of [null, "mrf_not_a_credential"]) {
      await expectRefused(
        await copyStream(key, { headers }),
        401,
        "unauthorized",
        String(key),
      );
    }
  });

  it("answers 400 to a request that is not well formed before it asks the reach", async () => {
    const proof = await bootstrap();
    const headers = {
      "Last-Event-ID": proof.cursor,
      "X-Marfa-Reach": STALE,
    };
    // The witness: the same headers on a well-formed request are stale.
    await changed(await copyStream(server.workingKey, { headers }));

    const refused: Array<[string, Parameters<typeof copyStream>[1]]> = [
      ["a stray query key", { query: [...COPY_QUERY, ["x", "1"]], headers }],
      [
        "a cursor that is not canonical",
        { headers: { ...headers, "Last-Event-ID": "01" } },
      ],
      [
        "a cursor with no reach",
        { headers: { "Last-Event-ID": proof.cursor } },
      ],
      ["a reach with no cursor", { headers: { "X-Marfa-Reach": STALE } }],
    ];
    for (const [name, options] of refused) {
      await expectRefused(
        await copyStream(server.workingKey, options),
        400,
        "validation_error",
        name,
      );
    }
  });

  it("answers 409 to a stale reach before it asks whether the key reaches any type, and 403 to the same key without one", async () => {
    const proof = await bootstrap();
    const headers = {
      "Last-Event-ID": proof.cursor,
      "X-Marfa-Reach": STALE,
    };
    // The witness: a request with no reach to hold is the key's own 403.
    await expectRefused(
      await copyStream(nowhere, {}),
      403,
      "type_not_permitted",
    );

    await changed(await copyStream(nowhere, { headers }));

    // A request refused for its grammar learns nothing of its reach, and
    // a key reaching no type is told so first.
    await expectRefused(
      await copyStream(nowhere, {
        query: [...COPY_QUERY, ["x", "1"]],
        headers,
      }),
      403,
      "type_not_permitted",
      "a stray query key",
    );
  });
});

describe("what a move to another type does to the reach", () => {
  it("answers link_taken to a move onto a link another item holds and leaves the reach as it was, and changes it for a move onto a free link", async () => {
    const [from, to] = [
      `user.reach-from-${ctx.runId}`,
      `user.reach-to-${ctx.runId}`,
    ];
    for (const id of [from, to]) {
      const registered = await client.registerType({
        id,
        fields: { vendor_id: { type: "string" }, title: { type: "string" } },
        link_field: "vendor_id",
      });
      expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
      trackType(ctx, id, client);
    }
    const create = async (type: string, vendor: string) => {
      const created = await client.createItem({
        type,
        source: ctx.source,
        properties: { vendor_id: vendor, title: vendor },
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      trackItem(ctx, created.data.item.id);
      return created.data.item;
    };
    const mover = await create(from, `mover-${ctx.runId}`);
    const holder = await create(to, `taken-${ctx.runId}`);
    const proof = await bootstrap();
    await holds(proof);

    const move = (vendor: string) =>
      client.updateItem(mover.id, {
        version: mover.version,
        type: to,
        retype: true,
        properties: { vendor_id: vendor },
      });
    const refused = await move(`taken-${ctx.runId}`);
    expect(refused.status, JSON.stringify(refused.error)).toBe(409);
    expect(refused.error?.error.code).toBe("link_taken");
    expect(refused.error?.error.details?.existing_id).toBe(holder.id);
    expect((await client.getItem(mover.id)).data.item.type).toBe(from);
    await holds(proof, server.workingKey, "after the refused move");

    const moved = await move(`free-${ctx.runId}`);
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    expect(moved.data.item.type).toBe(to);
    await moves(proof, server.workingKey, "after the move");
  });

  it("changes the reach for a PATCH that moves the item to another type and writes properties, and keeps it for one that writes properties alone", async () => {
    const row = await seed("a row to move with properties");
    const proof = await bootstrap();
    const written = await client.updateItem(row.id, {
      version: row.version,
      properties: { body: "written in place" },
    });
    expect(written.ok, JSON.stringify(written.error)).toBe(true);
    await holds(proof, server.workingKey, "after the write in place");

    const moved = await client.updateItem(row.id, {
      version: written.data.item.version,
      type: "core.bookmark",
      retype: true,
      properties: { url: "https://example.com/reach-order-move" },
    });
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    expect(moved.data.item.type).toBe("core.bookmark");
    expect(moved.data.item.properties.url).toBe(
      "https://example.com/reach-order-move",
    );
    await moves(proof, server.workingKey, "after the move");
  });
});

describe("the reach header on an answer that is not certified", () => {
  it("carries none on a 400 or a 409 to a conditional read, and carries one on the same door when the read succeeds", async () => {
    const row = await seed("a row for the doors");
    const proof = await bootstrap();
    const doors: Array<[string, string, string]> = [
      [
        "/items?include=metadata&limit=0",
        "/items?include=metadata&limit=1",
        "validation_error",
      ],
      [
        "/items?include=metadata&cursor=not-a-cursor",
        "/items?include=metadata",
        "validation_error",
      ],
      ["/items/not-an-id", `/items/${row.id}`, "invalid_id"],
      ["/edges?limit=0", "/edges?limit=1", "validation_error"],
      ["/items/not-an-id/edges", `/items/${row.id}/edges`, "invalid_id"],
    ];
    for (const [bad, good, code] of doors) {
      // The witness: the door certifies a read it can answer.
      const ok = await request(good, { proof: proof.reach });
      expect(ok.status, good).toBe(200);
      expect(ok.headers.get("X-Marfa-Reach"), good).toBe(proof.reach);
      await ok.body?.cancel();

      await expectRefused(
        await request(bad, { proof: proof.reach }),
        400,
        code,
        `${bad} under the matching reach`,
      );
      // A stale reach is the 409, and it names the reach of nobody.
      await changed(await request(bad, { proof: STALE }), `${bad} stale`);
    }
  });
});

describe("a conditional item page that names no include", () => {
  it("is refused as one whose include lacks metadata is, under a reach that matches", async () => {
    const proof = await bootstrap();
    // The witness: the same reach on a page that asks for metadata.
    const ok = await request("/items?include=metadata&limit=1", {
      proof: proof.reach,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("X-Marfa-Reach")).toBe(proof.reach);
    await ok.body?.cancel();

    const lacking = await request("/items?include=edges", {
      proof: proof.reach,
    });
    expect(lacking.status).toBe(400);
    expect(lacking.headers.get("X-Marfa-Reach")).toBeNull();
    const expected = await lacking.json();

    for (const path of ["/items", "/items?limit=1", "/items?include="]) {
      const bare = await request(path, { proof: proof.reach });
      expect(bare.status, path).toBe(400);
      expect(bare.headers.get("X-Marfa-Reach"), path).toBeNull();
      expect(await bare.json(), path).toEqual(expected);
    }
  });
});

describe("the reach of an approved app", () => {
  const OWNER = TEST_OWNER;
  const CALLBACK = "http://127.0.0.1:9/callback";
  const SCOPE = "core.note:read offline_access";
  let origin = "";
  let cookie = "";

  interface Tokens {
    access_token: string;
    refresh_token: string;
  }

  async function signIn(): Promise<void> {
    if (cookie !== "") return;
    const discovery = await fetch(
      `${server.apiUrl}/.well-known/oauth-authorization-server/auth`,
    );
    origin = new URL(((await discovery.json()) as { issuer: string }).issuer)
      .origin;
    const response = await fetch(`${server.apiUrl}/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(OWNER),
    });
    expect(response.status).toBe(200);
    const session = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
      response.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(session, "sign-in set no session cookie").toBeTruthy();
    cookie = session!;
  }

  async function register(name: string): Promise<string> {
    const registration = await fetch(`${server.apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: name,
        application_type: "native",
        redirect_uris: [CALLBACK],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
      }),
    });
    expect(registration.status).toBe(201);
    return ((await registration.json()) as { client_id: string }).client_id;
  }

  async function tokenFor(
    clientId: string,
    form: Record<string, string>,
  ): Promise<Tokens> {
    const response = await fetch(`${server.apiUrl}/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams({ client_id: clientId, ...form }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Tokens;
  }

  function location(response: Response): URL {
    return new URL(response.headers.get("location") ?? "", origin);
  }

  /** The person approves the app at its registered scope; the app gets tokens. */
  async function approve(clientId: string): Promise<Tokens> {
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: "reach-order",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: SCOPE,
    });
    const authorize = await fetch(
      `${server.apiUrl}/auth/oauth2/authorize?${params.toString()}`,
      { redirect: "manual", headers: { cookie } },
    );
    let consent: URL;
    if (authorize.status === 302) consent = location(authorize);
    else {
      expect(authorize.status).toBe(200);
      const body = (await authorize.json()) as {
        redirect?: boolean;
        url?: string;
      };
      expect(body.redirect).toBe(true);
      consent = new URL(body.url ?? "", origin);
    }
    expect(consent.pathname).toBe("/auth/authorize");
    const form = new URLSearchParams({
      accept: "true",
      oauth_query: consent.search.slice(1),
    });
    for (const scope of SCOPE.split(" ")) form.append("scopes", scope);
    const decision = await fetch(`${server.apiUrl}/auth/authorize/decision`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    expect(decision.status).toBe(302);
    const code = location(decision).searchParams.get("code");
    expect(code).toBeTruthy();
    return tokenFor(clientId, {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    });
  }

  it("is the same for the access tokens an app holds before and after a refresh, and differs for another app", async () => {
    await signIn();
    const app = await register("reach-order-app");
    const first = await approve(app);
    const before = await bootstrap(first.access_token);
    await holds(before, first.access_token, "the first token");

    const refreshed = await tokenFor(app, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
    });
    expect(refreshed.access_token).not.toBe(first.access_token);
    const after = await bootstrap(refreshed.access_token);
    expect(after.reach).toBe(before.reach);
    await holds(before, refreshed.access_token, "the refreshed token");

    // The witness: the reach is the app's and not any token's, so
    // another app of the same person holds a reach of its own.
    const other = await approve(await register("reach-order-other-app"));
    const own = await bootstrap(other.access_token);
    expect(own.reach).not.toBe(before.reach);
    await changed(
      await request("/items?include=metadata&limit=1", {
        proof: before.reach,
        key: other.access_token,
      }),
      "another app under this app's reach",
    );
  });
});

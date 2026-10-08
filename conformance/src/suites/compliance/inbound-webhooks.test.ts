import { createHash, createHmac, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type {
  InboundDeliveryRow,
  InboundEndpointRow,
  TestContext,
} from "../../client/types.js";
import {
  createTestContext,
  createSecondClient,
  cleanup,
  getManagementClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { createNote } from "../../generators/items.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let ctx: TestContext;
let client: MarfaClient;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "inbound-webhooks",
  ));
});

afterAll(async () => {
  // Removing the registrations removes their endpoints and deliveries.
  await cleanup(ctx);
});

/** The default a body is held to, as the chapter names it. */
const MAX_BYTES = 25 * 1024 * 1024;

interface Connector {
  client: MarfaClient;
  id: string;
}

/** A registration of its own: one per key, so one key per connector. */
async function connector(label: string): Promise<Connector> {
  const own = await createSecondClient(ctx, label);
  const registered = await own.registerConnector({
    name: `${ctx.runId} ${label}`,
  });
  expect(registered.status).toBe(201);
  return { client: own, id: registered.data.id };
}

async function endpoint(
  owner: Connector,
  input: { label?: string; duplicate_header?: string } = {},
): Promise<InboundEndpointRow> {
  const made = await owner.client.createInboundEndpoint(owner.id, input);
  expect(made.status).toBe(201);
  return made.data;
}

interface RawAnswer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * A sender's request, written by hand: the headers go out in the order and
 * case given, repeats kept, and no credential is added. Fetch would fold a
 * repeated header and normalize its case before the server saw it.
 */
function send(
  base: string,
  path: string,
  body: Buffer | string,
  headers: string[] = [],
): Promise<RawAnswer> {
  const url = new URL(path, base);
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        // Raw headers are written as given, so the host is named here.
        headers: [
          "Host",
          url.host,
          ...headers,
          "Content-Length",
          String(bytes.length),
        ],
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(bytes);
  });
}

function codeOf(answer: RawAnswer): string | undefined {
  return (JSON.parse(answer.body) as { error?: { code?: string } }).error?.code;
}

/** A `Retry-After` in whole seconds, and not zero. */
function expectRetryAfter(answer: RawAnswer, what: string): void {
  expect(answer.headers["retry-after"], what).toMatch(/^[1-9]\d*$/);
}

function idOf(answer: RawAnswer): string {
  expect(answer.status).toBe(202);
  return (JSON.parse(answer.body) as { id: string }).id;
}

async function pending(owner: Connector): Promise<InboundDeliveryRow[]> {
  const listed = await owner.client.listInboundDeliveries(owner.id);
  expect(listed.status).toBe(200);
  return listed.data.data;
}

describe("endpoints", () => {
  it("makes an endpoint for the connector's own key and the manager, answering its address once", async () => {
    const owner = await connector("endpoint-maker");
    const made = await owner.client.createInboundEndpoint(owner.id, {
      label: "github",
      duplicate_header: "X-GitHub-Delivery",
    });
    expect(made.status).toBe(201);
    await expectMatchesSchema(
      "POST",
      "/connectors/{id}/endpoints",
      201,
      made.data,
    );
    expect(made.data.connector_id).toBe(owner.id);
    expect(made.data.label).toBe("github");
    expect(made.data.duplicate_header).toBe("x-github-delivery");
    expect(made.data.path).toMatch(/^\/inbound\/[A-Za-z0-9_-]{43}$/);
    expect(made.data.retired_at).toBeNull();

    const byOperator = await getManagementClient().createInboundEndpoint(
      owner.id,
    );
    expect(byOperator.status).toBe(201);

    for (const reader of [owner.client, getManagementClient()]) {
      const listed = await reader.listInboundEndpoints(owner.id);
      expect(listed.status).toBe(200);
      await expectMatchesSchema(
        "GET",
        "/connectors/{id}/endpoints",
        200,
        listed.data,
      );
      const ids = listed.data.data.map((row) => row.id);
      expect(ids).toEqual([byOperator.data.id, made.data.id]);
      const again = listed.data.data.find((row) => row.id === made.data.id);
      expect(again?.path).toBe(`/inbound/****${made.data.path.slice(-4)}`);
    }
  });

  it("refuses another key, an unknown registration and a header that is no header name", async () => {
    const owner = await connector("endpoint-refusals");
    const other = await createSecondClient(ctx, "endpoint-stranger");
    const made = await endpoint(owner);

    const refused = await other.createInboundEndpoint(owner.id);
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("forbidden");
    expect((await other.listInboundEndpoints(owner.id)).status).toBe(403);
    expect((await other.retireInboundEndpoint(owner.id, made.id)).status).toBe(
      403,
    );

    const unknown = await owner.client.createInboundEndpoint(
      "00000000-0000-7000-8000-000000000000",
    );
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("connector_not_found");
    const unknownList = await owner.client.listInboundEndpoints(
      "00000000-0000-7000-8000-000000000000",
    );
    expect(unknownList.status).toBe(404);
    expect(unknownList.error?.error.code).toBe("connector_not_found");

    for (const input of [
      { duplicate_header: "not a header" },
      { duplicate_header: "" },
      { duplicate_header: "h".repeat(101) },
      { label: "" },
      { label: "x".repeat(201) },
    ]) {
      const invalid = await owner.client.createInboundEndpoint(owner.id, input);
      expect(invalid.status, JSON.stringify(input).slice(0, 40)).toBe(400);
      expect(invalid.error?.error.code).toBe("validation_error");
    }
    const listed = await owner.client.listInboundEndpoints(owner.id);
    expect(listed.data.data.map((row) => row.id)).toEqual([made.id]);

    // The ends of the header name's length, and of the label's, are taken.
    for (const input of [
      { duplicate_header: "H" },
      { duplicate_header: "H".repeat(100) },
      { label: "x", duplicate_header: "X-GitHub-Delivery" },
      { label: "x".repeat(200) },
    ]) {
      const taken = await owner.client.createInboundEndpoint(owner.id, input);
      expect(taken.status, JSON.stringify(input).slice(0, 40)).toBe(201);
      expect(taken.data.duplicate_header).toBe(
        input.duplicate_header?.toLowerCase() ?? null,
      );
    }
  });

  it("holds a registration to ten live endpoints, and a retired one frees a place", async () => {
    const owner = await connector("endpoint-limit");
    const made: InboundEndpointRow[] = [];
    for (let i = 0; i < 10; i++) made.push(await endpoint(owner));
    const eleventh = await owner.client.createInboundEndpoint(owner.id);
    expect(eleventh.status).toBe(409);
    expect(eleventh.error?.error.code).toBe("conflict");

    const first = made[0];
    if (first === undefined) throw new Error("no endpoint was made");
    expect(
      (await owner.client.retireInboundEndpoint(owner.id, first.id)).status,
    ).toBe(200);
    expect((await owner.client.createInboundEndpoint(owner.id)).status).toBe(
      201,
    );
  });

  it("retires an endpoint, after which its address is not served", async () => {
    const owner = await connector("endpoint-retire");
    const made = await endpoint(owner);
    const before = idOf(await send(apiUrl, made.path, "before"));

    const retired = await getManagementClient().retireInboundEndpoint(
      owner.id,
      made.id,
    );
    expect(retired.status).toBe(200);
    await expectMatchesSchema(
      "DELETE",
      "/connectors/{id}/endpoints/{endpoint_id}",
      200,
      retired.data,
    );
    expect(retired.data.retired_at).not.toBeNull();
    // The witness that the address was given in full when it was made.
    expect(made.path).toMatch(/^\/inbound\/[A-Za-z0-9_-]{43}$/);
    const redacted = `/inbound/****${made.path.slice(-4)}`;
    expect(retired.data.path).toBe(redacted);
    const again = await owner.client.retireInboundEndpoint(owner.id, made.id);
    expect(again.status).toBe(200);
    expect(again.data.retired_at).toBe(retired.data.retired_at);
    expect(again.data.path).toBe(redacted);
    const listed = await owner.client.listInboundEndpoints(owner.id);
    expect(listed.data.data.map((row) => row.retired_at)).toEqual([
      retired.data.retired_at,
    ]);

    const after = await send(apiUrl, made.path, "after");
    expect(after.status).toBe(404);
    expect(codeOf(after)).toBe("not_found");
    expect((await pending(owner)).map((d) => d.id)).toEqual([before]);

    const unknown = await owner.client.retireInboundEndpoint(
      owner.id,
      "00000000-0000-7000-8000-000000000000",
    );
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("endpoint_not_found");
  });

  it("stops answering once the registration's key is revoked", async () => {
    const owner = await connector("endpoint-revoked");
    const made = await endpoint(owner);
    expect((await send(apiUrl, made.path, "live")).status).toBe(202);
    const current = await owner.client.getCurrentKey();
    expect((await client.revokeKey(current.data.id)).status).toBe(200);
    const answer = await send(apiUrl, made.path, "revoked");
    expect(answer.status).toBe(404);
    expect(codeOf(answer)).toBe("not_found");
  });

  it("goes with its registration, and its deliveries with it", async () => {
    const owner = await connector("endpoint-removed");
    const made = await endpoint(owner);
    idOf(await send(apiUrl, made.path, "doomed"));
    expect((await owner.client.deleteConnector(owner.id)).status).toBe(200);
    const answer = await send(apiUrl, made.path, "gone");
    expect(answer.status).toBe(404);
    const listed = await owner.client.listInboundDeliveries(owner.id);
    expect(listed.status).toBe(404);
    expect(listed.error?.error.code).toBe("connector_not_found");
  });

  it("lists none of a removed registration's deliveries under the next one its key makes", async () => {
    const owner = await connector("deliveries-removed");
    const made = await endpoint(owner);
    const before = idOf(await send(apiUrl, made.path, "kept until removal"));
    // The witness: the delivery is listed while the registration stands.
    const listed = await owner.client.listInboundDeliveries(owner.id);
    expect(listed.data.data.map((d) => d.id)).toEqual([before]);
    expect((await owner.client.deleteConnector(owner.id)).status).toBe(200);

    const again = await owner.client.registerConnector({
      name: `${ctx.runId} deliveries-removed again`,
    });
    expect(again.status).toBe(201);
    expect(again.data.id).not.toBe(owner.id);
    const fresh = await owner.client.listInboundDeliveries(again.data.id);
    expect(fresh.status).toBe(200);
    expect(fresh.data.data).toEqual([]);
  });

  it("audits a creation and a retirement once each, and neither a receipt nor a handled mark", async () => {
    const owner = await connector("endpoint-audit");
    const made = await endpoint(owner);
    const delivery = idOf(await send(apiUrl, made.path, "audited?"));
    expect(
      (
        await owner.client.markInboundDeliveriesHandled(owner.id, {
          ids: [delivery],
          outcome: "processed",
        })
      ).status,
    ).toBe(200);
    for (let i = 0; i < 2; i++) {
      await owner.client.retireInboundEndpoint(owner.id, made.id);
    }
    let actions: string[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      const rows = await client.listAudit({ resource_id: made.id });
      actions = rows.data.data.map((row) => row.action).sort();
      if (actions.length >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // A second retirement's row, had it been written, lands beside the
    // first, so a settled count of two is its absence.
    await new Promise((r) => setTimeout(r, 300));
    actions = (await client.listAudit({ resource_id: made.id })).data.data
      .map((row) => row.action)
      .sort();
    expect(actions).toEqual([
      "inbound_endpoint.create",
      "inbound_endpoint.retire",
    ]);
    for (const resource of [delivery, owner.id]) {
      const rows = await client.listAudit({ resource_id: resource });
      expect(
        rows.data.data.map((row) => row.action),
        resource,
      ).not.toContainEqual(expect.stringMatching(/^inbound/));
    }
  });
});

describe("the receiving door", () => {
  it("stores the body byte for byte, the headers as they arrived and the query as sent", async () => {
    const owner = await connector("door-bytes");
    const made = await endpoint(owner);
    const body = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x00, 0x0d, 0x0a]),
      Buffer.from('{"a":  1}\r\n'),
      Buffer.from([0xc3, 0x28]),
      randomBytes(64),
    ]);
    const answer = await send(apiUrl, `${made.path}?b=2&a=%20one&b=3`, body, [
      "Content-Type",
      "application/json",
      "X-Repeat",
      "one",
      "x-repeat",
      "two",
      "X-Mixed-CASE",
      "Value",
    ]);
    const id = idOf(answer);

    const listed = await owner.client.listInboundDeliveries(owner.id);
    await expectMatchesSchema(
      "GET",
      "/connectors/{id}/deliveries",
      200,
      listed.data,
    );
    const [stored] = listed.data.data;
    expect(stored?.id).toBe(id);
    expect(stored?.endpoint_id).toBe(made.id);
    expect(stored?.method).toBe("POST");
    expect(stored?.query).toBe("b=2&a=%20one&b=3");
    expect(stored?.size).toBe(body.length);
    expect(stored?.sha256).toBe(
      createHash("sha256").update(body).digest("hex"),
    );
    const sent = [
      ["Content-Type", "application/json"],
      ["X-Repeat", "one"],
      ["x-repeat", "two"],
      ["X-Mixed-CASE", "Value"],
    ];
    const names = stored?.headers.map(([name]) => name) ?? [];
    expect(
      stored?.headers.filter(([name]) =>
        sent.some(([sentName]) => sentName === name),
      ),
    ).toEqual(sent);
    expect(names.indexOf("X-Repeat")).toBeLessThan(names.indexOf("x-repeat"));
    expect(stored?.handled_at).toBeNull();
    expect(stored?.outcome).toBeNull();
    expect(stored?.duplicate_of).toBeNull();

    const read = await owner.client.getInboundDeliveryBody(owner.id, id);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("application/octet-stream");
    expect(Buffer.from(await read.arrayBuffer()).equals(body)).toBe(true);

    const missing = await owner.client.getInboundDeliveryBody(
      owner.id,
      "00000000-0000-7000-8000-000000000000",
    );
    expect(missing.status).toBe(404);
    expect(
      ((await missing.json()) as { error: { code: string } }).error.code,
    ).toBe("delivery_not_found");
  });

  it("stores a signed delivery whose signature verifies over the stored bytes", async () => {
    const owner = await connector("door-signed");
    const made = await endpoint(owner, {
      duplicate_header: "X-GitHub-Delivery",
    });
    const secret = randomBytes(20).toString("hex");
    const payload = Buffer.from(
      JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 }),
    );
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    const id = idOf(
      await send(apiUrl, made.path, payload, [
        "X-GitHub-Event",
        "ping",
        "X-GitHub-Delivery",
        "00000000-1111-2222-3333-444444444444",
        "X-Hub-Signature-256",
        signature,
        "Content-Type",
        "application/json",
      ]),
    );
    const [stored] = await pending(owner);
    const header = stored?.headers.find(
      ([name]) => name.toLowerCase() === "x-hub-signature-256",
    )?.[1];
    expect(header).toBe(signature);
    const read = await owner.client.getInboundDeliveryBody(owner.id, id);
    const bytes = Buffer.from(await read.arrayBuffer());
    const recomputed = `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;
    expect(recomputed).toBe(header);
  });

  it("reads no key on a receipt, never stamping one used, and stores the header like any other", async () => {
    const owner = await connector("door-keyed");
    const made = await endpoint(owner);
    const minted = await client.createKey({
      label: "door-keyed-unused",
      source: `${ctx.source}-door-keyed-unused`,
      type_permissions: { "core.note": "read" },
    });
    expect(minted.status).toBe(201);
    trackKey(ctx, minted.data.id);
    const lastUsed = async (): Promise<string | null | undefined> =>
      (await client.listKeys()).data.data.find(
        (row) => row.id === minted.data.id,
      )?.last_used_at;

    const bearer = `Bearer ${minted.data.key}`;
    idOf(await send(apiUrl, made.path, "keyed", ["Authorization", bearer]));
    const [stored] = await pending(owner);
    expect(stored?.headers).toContainEqual(["Authorization", bearer]);
    expect(await lastUsed()).toBeFalsy();

    // Witness: the same key at a door that reads it is stamped.
    const reader = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    expect((await reader.getCurrentKey()).status).toBe(200);
    expect(await lastUsed()).toBeTruthy();
  });

  it("answers an address no endpoint holds as a path the server does not serve", async () => {
    const owner = await connector("door-unknown");
    const unknown = await send(
      apiUrl,
      `/inbound/${randomBytes(32).toString("base64url")}`,
      "hello",
    );
    const unserved = await send(apiUrl, "/no-such-door-at-all", "hello");
    expect(unserved.status).toBe(404);
    expect(unknown.status).toBe(unserved.status);
    expect(JSON.parse(unknown.body)).toEqual(JSON.parse(unserved.body));
    expect(unknown.headers["x-error-code"]).toBe("not_found");
    // Witness: a made address answers, so the refusal is about the address.
    const made = await endpoint(owner);
    idOf(await send(apiUrl, made.path, "hello"));
    expect(await pending(owner)).toHaveLength(1);
  });

  it("refuses a body over the limit, and stores one at it", async () => {
    const owner = await connector("door-size");
    const made = await endpoint(owner);
    const atLimit = Buffer.alloc(MAX_BYTES, 0x61);
    idOf(await send(apiUrl, made.path, atLimit));
    const over = await send(apiUrl, made.path, Buffer.alloc(MAX_BYTES + 1));
    expect(over.status).toBe(413);
    expect(codeOf(over)).toBe("request_too_large");
    const stored = await pending(owner);
    expect(stored.map((d) => d.size)).toEqual([MAX_BYTES]);
  });

  it("announces nothing on the event stream", async ({ signal }) => {
    const owner = await connector("door-quiet");
    const made = await endpoint(owner);
    await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));
      idOf(await send(apiUrl, made.path, "quiet"));
      const sentinel = await client.createItem(
        createNote({ source: ctx.source, properties: { body: "sentinel" } }),
      );
      expect(sentinel.ok).toBe(true);
      trackItem(ctx, sentinel.data.item.id);
      const { events } = await collectUntil(
        stream,
        (evts) =>
          evts.some(
            (e) =>
              (e.data as { item?: { id?: string } } | undefined)?.item?.id ===
              sentinel.data.item.id,
          ),
        "the sentinel note",
        signal,
      );
      const written = events.filter((e) => !e.event.startsWith("stream_"));
      expect(written.map((e) => e.event)).toEqual(["item.created"]);
    });
  });
});

describe("the receiving door on an instance that names its limits", () => {
  let server: FreshServer | undefined;

  beforeAll(async () => {
    server = await bootFreshServer("inbound-limits", {
      RATE_LIMIT_ENABLED: "true",
      RATE_LIMIT_INBOUND_REQUESTS: "3",
      MARFA_INBOUND_BACKLOG_DELIVERIES: "5",
      MARFA_INBOUND_BACKLOG_BYTES: "6",
      MARFA_INBOUND_MAX_BYTES: "64",
      MARFA_INBOUND_IN_FLIGHT_BYTES: "8",
      MARFA_INBOUND_READ_TIMEOUT_MS: "1000",
    });
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  async function freshConnector(
    label: string,
    target = server,
  ): Promise<Connector> {
    if (target === undefined) throw new Error("no server");
    const minter = new MarfaClient({
      baseUrl: target.apiUrl,
      apiKey: target.workingKey,
    });
    const minted = await minter.createKey({
      label,
      source: `inbound-limits-${label}`,
      default_tier: "library",
    });
    expect(minted.status).toBe(201);
    const own = new MarfaClient({
      baseUrl: target.apiUrl,
      apiKey: minted.data.key,
    });
    const registered = await own.registerConnector({ name: label });
    expect(registered.status).toBe(201);
    return { client: own, id: registered.data.id };
  }

  it("holds each endpoint to its own rate window", async () => {
    const owner = await freshConnector("rate");
    const first = await endpoint(owner);
    const second = await endpoint(owner);
    for (let i = 0; i < 3; i++) {
      idOf(await send(server!.apiUrl, first.path, String(i)));
    }
    const refused = await send(server!.apiUrl, first.path, "3");
    expect(refused.status).toBe(429);
    expect(codeOf(refused)).toBe("rate_limited");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    idOf(await send(server!.apiUrl, second.path, "0"));
  });

  it("refuses while the backlog is full, and takes again once it drains", async () => {
    const owner = await freshConnector("backlog");
    const first = await endpoint(owner);
    const second = await endpoint(owner);
    for (const path of [
      first.path,
      first.path,
      first.path,
      second.path,
      second.path,
    ]) {
      idOf(await send(server!.apiUrl, path, "x"));
    }
    const full = await send(server!.apiUrl, second.path, "x");
    expect(full.status).toBe(503);
    expect(codeOf(full)).toBe("inbound_unavailable");
    expect(Number(full.headers["retry-after"])).toBeGreaterThan(0);

    const waiting = await pending(owner);
    const marked = await owner.client.markInboundDeliveriesHandled(owner.id, {
      ids: waiting.slice(0, 1).map((d) => d.id),
      outcome: "processed",
    });
    expect(marked.status).toBe(200);
    const third = await endpoint(owner);
    idOf(await send(server!.apiUrl, third.path, "x"));
  });

  it("counts the unhandled deliveries a retired endpoint stored toward the backlog, until they are handled", async () => {
    const owner = await freshConnector("backlog-retired");
    const retiring = await endpoint(owner);
    const live = await endpoint(owner);
    const stored: string[] = [];
    for (let i = 0; i < 3; i++) {
      stored.push(idOf(await send(server!.apiUrl, retiring.path, "x")));
    }
    expect(
      (await owner.client.retireInboundEndpoint(owner.id, retiring.id)).status,
    ).toBe(200);

    // Two on the live endpoint make five, the backlog's whole room, with
    // three of them held by an address that no longer answers.
    for (let i = 0; i < 2; i++) {
      idOf(await send(server!.apiUrl, live.path, "x"));
    }
    const full = await send(server!.apiUrl, live.path, "x");
    expect(full.status).toBe(503);
    expect(codeOf(full)).toBe("inbound_unavailable");

    // The witness: handled, the retired endpoint's deliveries stop counting,
    // so it was they that filled the room.
    const marked = await owner.client.markInboundDeliveriesHandled(owner.id, {
      ids: stored,
      outcome: "processed",
    });
    expect(marked.status).toBe(200);
    idOf(await send(server!.apiUrl, (await endpoint(owner)).path, "x"));
  });

  it("refuses while the backlog's bytes are full", async () => {
    const owner = await freshConnector("backlog-bytes");
    const made = await endpoint(owner);
    idOf(await send(server!.apiUrl, made.path, "x".repeat(6)));
    const full = await send(server!.apiUrl, made.path, "y");
    expect(full.status).toBe(503);
    expect(codeOf(full)).toBe("inbound_unavailable");
    expectRetryAfter(full, "backlog bytes");
    const filling = await pending(owner);
    expect(filling.map((d) => d.size)).toEqual([6]);

    // The witness that it is the bytes and not the count that refused: one
    // delivery is far under the count's room, and marking it handled frees
    // room for a body of the whole byte cap again.
    const marked = await owner.client.markInboundDeliveriesHandled(owner.id, {
      ids: filling.map((d) => d.id),
      outcome: "processed",
    });
    expect(marked.status).toBe(200);
    idOf(await send(server!.apiUrl, made.path, "z".repeat(6)));
    expect((await pending(owner)).map((d) => d.size)).toEqual([6]);
  });

  it("checks prospective bytes and accepts a zero body at exactly full pending bytes", async () => {
    const owner = await freshConnector("prospective-bytes");
    const made = await endpoint(owner);
    const over = await send(server!.apiUrl, made.path, "x".repeat(7));
    expect(over.status).toBe(503);
    expect(codeOf(over)).toBe("inbound_unavailable");
    expectRetryAfter(over, "prospective backlog bytes");
    idOf(await send(server!.apiUrl, made.path, "x".repeat(6)));
    idOf(await send(server!.apiUrl, made.path, ""));
    expect((await pending(owner)).map((d) => d.size)).toEqual([6, 0]);
  });

  it("answers request_timeout to a body that does not arrive in time, and stores nothing", async () => {
    const owner = await freshConnector("stalled");
    const made = await endpoint(owner);
    const url = new URL(made.path, server!.apiUrl);
    const answer = await new Promise<RawAnswer>((resolve, reject) => {
      const req = httpRequest(
        {
          method: "POST",
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          headers: ["Host", url.host, "Content-Length", "10"],
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            req.destroy();
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      // Three of the ten bytes it declared, and then nothing.
      req.write("abc");
    });
    expect(answer.status).toBe(408);
    expect(codeOf(answer)).toBe("request_timeout");
    expect(await pending(owner)).toEqual([]);
    // Witness: a body that arrives whole is taken at the same address.
    idOf(await send(server!.apiUrl, made.path, "whole"));
  });

  it(
    "refuses a body that would pass the bytes the instance holds in flight",
    async () => {
      const flight = await bootFreshServer("inbound-in-flight", {
        RATE_LIMIT_ENABLED: "false",
        MARFA_INBOUND_BACKLOG_BYTES: "64",
        MARFA_INBOUND_MAX_BYTES: "64",
        MARFA_INBOUND_IN_FLIGHT_BYTES: "8",
      });
      try {
        const owner = await freshConnector("in-flight", flight);
        const made = await endpoint(owner);
        const held = await send(flight.apiUrl, made.path, "x".repeat(9));
        expect(held.status).toBe(503);
        expect(codeOf(held)).toBe("inbound_unavailable");
        expectRetryAfter(held, "bytes in flight");
        expect(await pending(owner)).toEqual([]);
        idOf(await send(flight.apiUrl, made.path, "x".repeat(8)));
        expect((await pending(owner)).map((d) => d.size)).toEqual([8]);
      } finally {
        await flight.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("reading and handling", () => {
  it("lists oldest first by cursor, narrowed by state and endpoint", async () => {
    const owner = await connector("read-list");
    const first = await endpoint(owner);
    const second = await endpoint(owner);
    const ids: string[] = [];
    for (const [path, body] of [
      [first.path, "1"],
      [second.path, "2"],
      [first.path, "3"],
    ] as const) {
      ids.push(idOf(await send(apiUrl, path, body)));
    }

    const page = await owner.client.listInboundDeliveries(owner.id, {
      limit: 2,
    });
    expect(page.data.data.map((d) => d.id)).toEqual(ids.slice(0, 2));
    expect(page.data.next_cursor).not.toBeNull();
    const rest = await owner.client.listInboundDeliveries(owner.id, {
      limit: 2,
      cursor: page.data.next_cursor ?? undefined,
    });
    expect(rest.data.data.map((d) => d.id)).toEqual(ids.slice(2));
    expect(rest.data.next_cursor).toBeNull();

    const onFirst = await owner.client.listInboundDeliveries(owner.id, {
      endpoint_id: first.id,
    });
    expect(onFirst.data.data.map((d) => d.id)).toEqual([ids[0], ids[2]]);

    const handled = ids[1];
    if (handled === undefined) throw new Error("no delivery");
    await owner.client.markInboundDeliveriesHandled(owner.id, {
      ids: [handled],
      outcome: "rejected",
    });
    expect((await pending(owner)).map((d) => d.id)).toEqual([ids[0], ids[2]]);
    const done = await owner.client.listInboundDeliveries(owner.id, {
      state: "handled",
    });
    expect(done.data.data.map((d) => d.id)).toEqual([handled]);
    const every = await owner.client.listInboundDeliveries(owner.id, {
      state: "any",
    });
    expect(every.data.data.map((d) => d.id)).toEqual(ids);

    for (const limit of [0, 201]) {
      const invalid = await owner.client.listInboundDeliveries(owner.id, {
        limit,
      });
      expect(invalid.status, String(limit)).toBe(400);
    }
  });

  it("refuses a query key the listing does not declare, rather than answering unfiltered", async () => {
    const owner = await connector("read-unknown-key");
    const made = await endpoint(owner);
    idOf(await send(apiUrl, made.path, "waiting"));
    const refused = await owner.client.rawRequest<unknown>(
      `/connectors/${owner.id}/deliveries?status=handled`,
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.details?.["unknown_parameters"]).toEqual([
      "status",
    ]);
    // Witness: the declared key narrows, so the refusal is the typo's.
    const handled = await owner.client.listInboundDeliveries(owner.id, {
      state: "handled",
    });
    expect(handled.data.data).toEqual([]);
    expect(await pending(owner)).toHaveLength(1);
  });

  it("reads and marks to the connector's own key alone", async () => {
    const owner = await connector("read-own");
    const other = await createSecondClient(ctx, "read-stranger");
    const made = await endpoint(owner);
    const id = idOf(await send(apiUrl, made.path, "mine"));
    for (const reader of [other, getManagementClient()]) {
      expect((await reader.listInboundDeliveries(owner.id)).status).toBe(403);
      const marked = await reader.markInboundDeliveriesHandled(owner.id, {
        ids: [id],
        outcome: "processed",
      });
      expect(marked.status).toBe(403);
      expect(marked.error?.error.code).toBe("forbidden");
      const read = await reader.getInboundDeliveryBody(owner.id, id);
      expect(read.status).toBe(403);
    }
    // Another connector naming this one's delivery under its own
    // registration reaches nothing.
    const theirs = await connector("read-theirs");
    expect(
      (await theirs.client.getInboundDeliveryBody(theirs.id, id)).status,
    ).toBe(404);
    const crossed = await theirs.client.markInboundDeliveriesHandled(
      theirs.id,
      { ids: [id], outcome: "processed" },
    );
    expect(crossed.status).toBe(404);
    expect(
      (
        await theirs.client.listInboundDeliveries(theirs.id, {
          endpoint_id: made.id,
          state: "any",
        })
      ).data.data,
    ).toEqual([]);
    const [stored] = await pending(owner);
    expect(stored?.handled_at).toBeNull();
    const own = await owner.client.getInboundDeliveryBody(owner.id, id);
    expect(own.status).toBe(200);
  });

  it("keeps the first mark, and marks nothing when an id is not the connector's", async () => {
    const owner = await connector("read-mark");
    const made = await endpoint(owner);
    const id = idOf(await send(apiUrl, made.path, "once"));

    const first = await owner.client.markInboundDeliveriesHandled(owner.id, {
      ids: [id],
      outcome: "processed",
    });
    expect(first.status).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/connectors/{id}/deliveries/handled",
      200,
      first.data,
    );
    const [marked] = first.data.data;
    expect(marked?.outcome).toBe("processed");
    expect(marked?.handled_at).not.toBeNull();

    const second = await owner.client.markInboundDeliveriesHandled(owner.id, {
      ids: [id],
      outcome: "rejected",
    });
    const [again] = second.data.data;
    expect(again?.outcome).toBe("processed");
    expect(again?.handled_at).toBe(marked?.handled_at);

    const fresh = idOf(await send(apiUrl, made.path, "fresh"));
    const foreign = await owner.client.markInboundDeliveriesHandled(owner.id, {
      ids: [fresh, "00000000-0000-7000-8000-000000000000"],
      outcome: "processed",
    });
    expect(foreign.status).toBe(404);
    expect(foreign.error?.error.code).toBe("delivery_not_found");
    expect((await pending(owner)).map((d) => d.id)).toEqual([fresh]);

    const invalid = await owner.client.markInboundDeliveriesHandled(owner.id, {
      ids: [fresh],
      outcome: "done" as "processed",
    });
    expect(invalid.status).toBe(400);
  });

  it("marks a repeat of the duplicate header with the first delivery and how it was handled", async () => {
    const owner = await connector("read-duplicate");
    const keyed = await endpoint(owner, {
      duplicate_header: "X-GitHub-Delivery",
    });
    const plain = await endpoint(owner);
    const deliver = async (path: string, value: string) =>
      idOf(await send(apiUrl, path, "{}", ["X-GitHub-Delivery", value]));
    const original = await deliver(keyed.path, "guid-1");
    const other = await deliver(keyed.path, "guid-2");
    const repeat = await deliver(keyed.path, "guid-1");
    const unkeyed = await deliver(plain.path, "guid-1");

    const byId = new Map((await pending(owner)).map((d) => [d.id, d]));
    expect(byId.size).toBe(4);
    expect(byId.get(original)?.duplicate_of).toBeNull();
    expect(byId.get(other)?.duplicate_of).toBeNull();
    expect(byId.get(unkeyed)?.duplicate_of).toBeNull();
    expect(byId.get(repeat)?.duplicate_of).toEqual({
      id: original,
      outcome: null,
    });

    await owner.client.markInboundDeliveriesHandled(owner.id, {
      ids: [original],
      outcome: "processed",
    });
    const after = (await pending(owner)).find((d) => d.id === repeat);
    expect(after?.duplicate_of).toEqual({ id: original, outcome: "processed" });
  });

  it("refuses a state it does not know, rather than answering the unhandled deliveries", async () => {
    const owner = await connector("read-state-invalid");
    const made = await endpoint(owner);
    const handled = idOf(await send(apiUrl, made.path, "handled"));
    const waiting = idOf(await send(apiUrl, made.path, "waiting"));
    expect(
      (
        await owner.client.markInboundDeliveriesHandled(owner.id, {
          ids: [handled],
          outcome: "processed",
        })
      ).status,
    ).toBe(200);

    for (const [state, ids] of [
      ["pending", [waiting]],
      ["handled", [handled]],
      ["any", [handled, waiting]],
    ] as const) {
      const listed = await owner.client.listInboundDeliveries(owner.id, {
        state,
      });
      expect(listed.status, state).toBe(200);
      expect(listed.data.data.map((d) => d.id).sort(), state).toEqual(
        [...ids].sort(),
      );
    }
    for (const state of ["done", "Handled", "all", ""]) {
      const refused = await owner.client.rawRequest<unknown>(
        `/connectors/${owner.id}/deliveries?state=${state}`,
      );
      expect(refused.status, state).toBe(400);
      expect(refused.error?.error.code, state).toBe("validation_error");
    }
  });

  it("gives no duplicate_of to a delivery that arrives without its endpoint's duplicate header", async () => {
    const owner = await connector("read-duplicate-absent");
    const keyed = await endpoint(owner, {
      duplicate_header: "X-GitHub-Delivery",
    });
    const bare = [
      idOf(await send(apiUrl, keyed.path, "{}")),
      idOf(await send(apiUrl, keyed.path, "{}")),
    ];
    // The witnesses: the endpoint does mark a repeat of a value it was sent.
    const original = idOf(
      await send(apiUrl, keyed.path, "{}", ["X-GitHub-Delivery", "guid-1"]),
    );
    const repeat = idOf(
      await send(apiUrl, keyed.path, "{}", ["X-GitHub-Delivery", "guid-1"]),
    );
    const another = idOf(await send(apiUrl, keyed.path, "{}"));

    const byId = new Map((await pending(owner)).map((d) => [d.id, d]));
    expect(byId.size).toBe(5);
    expect(byId.get(repeat)?.duplicate_of).toEqual({
      id: original,
      outcome: null,
    });
    for (const id of [...bare, original, another]) {
      expect(byId.get(id)?.duplicate_of, id).toBeNull();
    }
  });

  it("gives no duplicate_of to a delivery whose value only another endpoint of the registration carried", async () => {
    const owner = await connector("read-duplicate-other");
    const header = { duplicate_header: "X-GitHub-Delivery" };
    const first = await endpoint(owner, header);
    const second = await endpoint(owner, header);
    const deliver = async (path: string, value: string) =>
      idOf(await send(apiUrl, path, "{}", ["X-GitHub-Delivery", value]));
    const onFirst = await deliver(first.path, "guid-1");
    const onSecond = await deliver(second.path, "guid-1");
    // The witnesses: each endpoint marks a repeat of what it carried itself.
    const repeatOnFirst = await deliver(first.path, "guid-1");
    const repeatOnSecond = await deliver(second.path, "guid-1");

    const byId = new Map((await pending(owner)).map((d) => [d.id, d]));
    expect(byId.get(onFirst)?.duplicate_of).toBeNull();
    expect(byId.get(onSecond)?.duplicate_of).toBeNull();
    expect(byId.get(repeatOnFirst)?.duplicate_of).toEqual({
      id: onFirst,
      outcome: null,
    });
    expect(byId.get(repeatOnSecond)?.duplicate_of).toEqual({
      id: onSecond,
      outcome: null,
    });
  });

  it("answers each id of a handled mark once, in the order first named", async () => {
    const owner = await connector("read-mark-order");
    const made = await endpoint(owner);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(idOf(await send(apiUrl, made.path, String(i))));
    }
    const [d0, d1, d2, d3, d4] = ids as [
      string,
      string,
      string,
      string,
      string,
    ];

    const earlier = await owner.client.markInboundDeliveriesHandled(owner.id, {
      ids: [d1],
      outcome: "rejected",
    });
    expect(earlier.status).toBe(200);
    const earlierAt = earlier.data.data[0]?.handled_at;

    // A repeated id is answered once, where it was first named, and a
    // delivery marked before keeps the mark it had.
    const marked = await owner.client.markInboundDeliveriesHandled(owner.id, {
      ids: [d3, d1, d3, d0, d1],
      outcome: "processed",
    });
    expect(marked.status).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/connectors/{id}/deliveries/handled",
      200,
      marked.data,
    );
    expect(marked.data.data.map((row) => row.id)).toEqual([d3, d1, d0]);
    expect(marked.data.data.map((row) => row.outcome)).toEqual([
      "processed",
      "rejected",
      "processed",
    ]);
    expect(marked.data.data[1]?.handled_at).toBe(earlierAt);
    for (const row of marked.data.data) expect(row.handled_at).not.toBeNull();

    // The order named is the order answered, not the order of arrival.
    const last = await owner.client.markInboundDeliveriesHandled(owner.id, {
      ids: [d4, d2],
      outcome: "duplicate",
    });
    expect(last.data.data.map((row) => [row.id, row.outcome])).toEqual([
      [d4, "duplicate"],
      [d2, "duplicate"],
    ]);

    const handled = await owner.client.listInboundDeliveries(owner.id, {
      state: "handled",
    });
    expect(handled.data.data.map((row) => row.id)).toEqual(ids);
  });

  it("takes 200 ids in a handled mark, and refuses 201, none and a body that names too little", async () => {
    const owner = await connector("read-mark-bounds");
    const made = await endpoint(owner);
    const id = idOf(await send(apiUrl, made.path, "bounded"));

    const refusals: [string, Record<string, unknown>, string, string?][] = [
      [
        "201 ids",
        { ids: Array.from({ length: 201 }, () => id), outcome: "processed" },
        "validation_error",
      ],
      ["no ids", { ids: [], outcome: "processed" }, "validation_error"],
      [
        "an unknown outcome",
        { ids: [id], outcome: "done" },
        "validation_error",
      ],
      ["no outcome", { ids: [id] }, "missing_required_field", "outcome"],
      [
        "no ids named",
        { outcome: "processed" },
        "missing_required_field",
        "ids",
      ],
    ];
    for (const [what, body, code, field] of refusals) {
      const refused = await owner.client.rawRequest<unknown>(
        `/connectors/${owner.id}/deliveries/handled`,
        { method: "POST", body },
      );
      expect(refused.status, what).toBe(400);
      expect(refused.error?.error.code, what).toBe(code);
      if (field !== undefined) {
        expect(refused.error?.error.details?.["field"], what).toBe(field);
      }
    }
    expect((await pending(owner)).map((d) => d.id)).toEqual([id]);

    // Two hundred names, of one delivery, are two hundred ids and one answer.
    const taken = await owner.client.markInboundDeliveriesHandled(owner.id, {
      ids: Array.from({ length: 200 }, () => id),
      outcome: "processed",
    });
    expect(taken.status).toBe(200);
    expect(taken.data.data.map((row) => row.id)).toEqual([id]);
    expect(await pending(owner)).toEqual([]);
  });
});

describe("an address whose key has expired", () => {
  let server: FreshServer | undefined;
  beforeAll(async () => {
    server = await bootFreshServer("inbound-key-expired", {
      RATE_LIMIT_ENABLED: "false",
    });
  }, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(async () => {
    await server?.stop();
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  it("answers 404 at an address whose key has expired, as at a revoked key's", async () => {
    const minter = new MarfaClient({
      baseUrl: server!.apiUrl,
      apiKey: server!.workingKey,
    });
    const registered: { keyId: string; path: string }[] = [];
    for (const label of ["expiring", "revoked"]) {
      const minted = await minter.createKey({
        label,
        source: `inbound-key-${label}`,
        default_tier: "library",
      });
      expect(minted.status).toBe(201);
      const own = new MarfaClient({
        baseUrl: server!.apiUrl,
        apiKey: minted.data.key,
      });
      const connection = await own.registerConnector({ name: label });
      expect(connection.status).toBe(201);
      const made = await own.createInboundEndpoint(connection.data.id);
      expect(made.status).toBe(201);
      // The witness that each address answers while its key is good.
      idOf(await send(server!.apiUrl, made.data.path, "live"));
      registered.push({ keyId: minted.data.id, path: made.data.path });
    }
    const [expiring, revoked] = registered;
    if (expiring === undefined || revoked === undefined) {
      throw new Error("no key was minted");
    }
    expect((await minter.revokeKey(revoked.keyId)).status).toBe(200);

    await server!.restart({
      whileStopped: () => {
        const db = new DatabaseSync(server!.sqlitePath);
        try {
          const past = new Date(Date.now() - 60_000).toISOString();
          const changed = db
            .prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?")
            .run(past, expiring.keyId);
          expect(changed.changes).toBe(1);
        } finally {
          db.close();
        }
      },
    });

    const revokedAnswer = await send(server!.apiUrl, revoked.path, "after");
    expect(revokedAnswer.status).toBe(404);
    expect(codeOf(revokedAnswer)).toBe("not_found");
    const expiredAnswer = await send(server!.apiUrl, expiring.path, "after");
    expect(expiredAnswer.status).toBe(404);
    expect(codeOf(expiredAnswer)).toBe("not_found");
    expect(expiredAnswer.body).toBe(revokedAnswer.body);
  });
});

describe("retained inbound capacity", () => {
  let server: FreshServer | undefined;
  let minter: MarfaClient;
  beforeAll(async () => {
    server = await bootFreshServer("inbound-retained", {
      RATE_LIMIT_ENABLED: "false",
      MARFA_INBOUND_RETAINED_DELIVERIES: "3",
      MARFA_INBOUND_RETAINED_BYTES: "4096",
      MARFA_INBOUND_HANDLED_RETENTION_DAYS: "0",
      MARFA_INBOUND_PENDING_RETENTION_DAYS: "0",
    });
    minter = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.workingKey,
    });
  }, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(async () => {
    await server?.stop();
  }, 2 * FRESH_SERVER_TIMEOUT_MS);
  async function own(label: string): Promise<Connector> {
    const key = await minter.createKey({
      label,
      source: label,
      default_tier: "library",
    });
    expect(key.status).toBe(201);
    const client = new MarfaClient({
      baseUrl: server!.apiUrl,
      apiKey: key.data.key,
    });
    const registration = await client.registerConnector({ name: label });
    expect(registration.status).toBe(201);
    return { client, id: registration.data.id };
  }
  it("bounds handled zero-body receipts across live and retired endpoints of a registration", async () => {
    const owner = await own("retained-rows");
    const first = await endpoint(owner);
    const second = await endpoint(owner);
    for (const path of [first.path, first.path, second.path]) {
      const id = idOf(await send(server!.apiUrl, path, ""));
      expect(
        (
          await owner.client.markInboundDeliveriesHandled(owner.id, {
            ids: [id],
            outcome: "processed",
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (await owner.client.retireInboundEndpoint(owner.id, first.id)).status,
    ).toBe(200);
    const refused = await send(server!.apiUrl, second.path, "");
    expect(refused.status).toBe(503);
    expect(codeOf(refused)).toBe("inbound_unavailable");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    const rows = await owner.client.listInboundDeliveries(owner.id, {
      state: "any",
    });
    expect(rows.status).toBe(200);
    expect(rows.data.data).toHaveLength(3);
    expect(
      rows.data.data.every(
        (row) =>
          row.size === 0 &&
          row.outcome === "processed" &&
          !("stored_bytes" in row),
      ),
    ).toBe(true);
    const other = await own("retained-independent");
    idOf(await send(server!.apiUrl, (await endpoint(other)).path, ""));
  });
  it("counts query metadata when every retained body has zero bytes", async () => {
    const owner = await own("retained-metadata");
    const made = await endpoint(owner);
    idOf(
      await send(
        server!.apiUrl,
        made.path + "?metadata=" + "x".repeat(3500),
        "",
      ),
    );
    const refused = await send(server!.apiUrl, made.path, "");
    expect(refused.status).toBe(503);
    expect(codeOf(refused)).toBe("inbound_unavailable");
    expectRetryAfter(refused, "retained bytes");
    expect((await pending(owner)).map((row) => row.size)).toEqual([0]);
  });
  it("round trips retention overrides and refuses invalid values", async () => {
    const before = await minter.getConfig();
    expect(before.status).toBe(200);
    const changed = await minter.updateConfig({
      ...(before.data as Record<string, unknown>),
      inbound_handled_retention_days: 0,
      inbound_pending_retention_days: 2,
    });
    expect(changed.status).toBe(200);
    expect(changed.data).toMatchObject({
      inbound_handled_retention_days: 0,
      inbound_pending_retention_days: 2,
    });
    for (const value of [-1, 1.5])
      expect(
        (await minter.updateConfig({ inbound_pending_retention_days: value }))
          .status,
      ).toBe(400);
    expect((await minter.updateConfig({})).status).toBe(200);
    const cleared = await minter.getConfig();
    expect(cleared.data).not.toHaveProperty("inbound_handled_retention_days");
    expect(cleared.data).not.toHaveProperty("inbound_pending_retention_days");
  });
});

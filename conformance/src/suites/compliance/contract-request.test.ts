import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { controlRequest } from "../../utils/control-request.js";
import { send as sendRaw } from "../../utils/inbound-sender.js";
import { publishedOperations } from "../../utils/openapi.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";

/**
 * A request names the contract it was built for in `X-Marfa-Contract`, and a
 * server refuses one that names another (`instance/contract-request-other`).
 */
const HEADER = "X-Marfa-Contract";
const OTHER_INSTANCE = "019537a0-7b80-7000-8000-0000000000ff";

let ctx: TestContext;
let client: MarfaClient;
let apiUrl: string;
let apiKey: string;
/** The number the root answers as `contract`, read at the start. */
let own: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "contract-request",
  ));
  const root = await fetch(`${apiUrl}/`, {
    headers: { Accept: "application/json" },
  });
  own = String(((await root.json()) as { contract: number }).contract);
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
    method: init.method ?? "GET",
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

async function created(res: Response): Promise<void> {
  expect(res.status).toBe(201);
  const id = ((await res.clone().json()) as { item: { id: string } }).item.id;
  trackItem(ctx, id);
}

/** A request that names `X-Marfa-Contract` once for each value, as separate lines. */
function lines(values: string[]): Promise<number> {
  const url = new URL("/health", apiUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: values.flatMap((value) => [HEADER, value]),
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("a request that names a contract", () => {
  it("serves a request naming no contract, and one naming this contract, as it serves each other", async () => {
    const read = async (headers: Record<string, string>) =>
      send(`/items?type=core.note&source=${encodeURIComponent(ctx.source)}`, {
        headers,
      });
    expect((await read({})).status).toBe(200);
    expect((await read({ [HEADER]: own })).status).toBe(200);

    const plain = `no contract ${ctx.runId}`;
    await created(await send("/items", { method: "POST", body: note(plain) }));
    const named = `own contract ${ctx.runId}`;
    await created(
      await send("/items", {
        method: "POST",
        body: note(named),
        headers: { [HEADER]: own },
      }),
    );
    expect(await held(plain)).toBe(1);
    expect(await held(named)).toBe(1);

    for (const path of ["/", "/health"]) {
      const res = await send(path, {
        credential: false,
        headers: { [HEADER]: own },
      });
      expect(res.status, path).toBe(200);
    }

    // A sender and an app's token request are built for no contract.
    const endpoint = await client.createInboundEndpoint(
      (await client.registerConnector({ name: `${ctx.runId} no contract` }))
        .data.id,
    );
    expect(endpoint.status).toBe(201);
    expect(
      (await sendRaw(apiUrl, endpoint.data.path, "hello")).status,
      "an inbound endpoint",
    ).toBe(202);
    const token = await fetch(`${apiUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code",
    });
    expect(token.status, "the OAuth token door").toBe(400);
    await token.body?.cancel();
  });

  it("refuses a request naming another contract, or a value that is not the digits of this one, 412 contract_mismatch", async () => {
    const number = BigInt(own);
    const values = [
      String(number + 1n),
      String(number + 2n),
      "",
      "abc",
      `-${own}`,
      `+${own}`,
      `0${own}`,
      `${own}.0`,
      `${own}e0`,
      `${own}, ${own}`,
      "99999999999999999999999999",
    ];
    for (const value of values) {
      const res = await send("/items?limit=1", {
        headers: { [HEADER]: value },
      });
      expect(res.status, JSON.stringify(value)).toBe(412);
      expect(await codeOf(res), JSON.stringify(value)).toBe(
        "contract_mismatch",
      );
      expect(res.headers.get("X-Error-Code")).toBe("contract_mismatch");
      expect(res.headers.get(HEADER), "the answer names the server's own").toBe(
        own,
      );
    }
    // The witness: the same read naming this contract is served.
    expect(
      (await send("/items?limit=1", { headers: { [HEADER]: own } })).status,
    ).toBe(200);
  });

  it("refuses a request that names its contract on two header lines, though both name this one", async () => {
    // The witness: one line naming this contract is served.
    expect(await lines([own])).toBe(200);
    expect(await lines([own, own])).toBe(412);
    expect(await lines([own, String(BigInt(own) + 1n)])).toBe(412);
  });

  it("refuses a write naming another contract without writing it", async () => {
    const refused = `refused ${ctx.runId}`;
    const res = await send("/items", {
      method: "POST",
      body: note(refused),
      headers: { [HEADER]: String(BigInt(own) + 1n) },
    });
    expect(res.status).toBe(412);
    expect(await codeOf(res)).toBe("contract_mismatch");
    expect(await held(refused), "a refused write was written").toBe(0);

    // The witness: the same write naming this contract is written.
    await created(
      await send("/items", {
        method: "POST",
        body: note(refused),
        headers: { [HEADER]: own },
      }),
    );
    expect(await held(refused)).toBe(1);
  });

  it("refuses another contract on every operation the document publishes, and on a path no operation serves", async () => {
    const operations = await publishedOperations();
    // The positive control: an empty walk would pass the loop below.
    expect(operations.length).toBeGreaterThan(100);
    const other = String(BigInt(own) + 1n);
    const missed: string[] = [];
    for (const operation of operations) {
      const path = operation.path.replace(/\{[^}]+\}/g, uuidv7());
      for (const credential of [true, false]) {
        const res = await send(path, {
          method: operation.method,
          body:
            operation.method === "GET" || operation.method === "HEAD"
              ? undefined
              : {},
          headers: { [HEADER]: other },
          credential,
        });
        if (res.status !== 412 || (await codeOf(res)) !== "contract_mismatch") {
          missed.push(
            `${operation.method} ${operation.path} ${credential ? "with" : "without"} a credential answered ${String(res.status)}`,
          );
        }
      }
    }
    expect(missed).toEqual([]);

    const nowhere = `/no-door-${randomUUID()}`;
    expect((await send(nowhere)).status, "the witness").toBe(404);
    const refused = await send(nowhere, { headers: { [HEADER]: other } });
    expect(refused.status).toBe(412);
    expect(await codeOf(refused)).toBe("contract_mismatch");
  });

  it("refuses another contract on HEAD and OPTIONS, the MCP door, the OAuth token door, the device code door, an inbound endpoint, a well-known document and a route over the private socket", async () => {
    const other = String(BigInt(own) + 1n);
    const form = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    const doors: {
      name: string;
      method: string;
      path: string;
      body?: string;
      headers?: Record<string, string>;
      credential?: boolean;
    }[] = [
      { name: "HEAD of an operation", method: "HEAD", path: "/items" },
      { name: "OPTIONS of an operation", method: "OPTIONS", path: "/items" },
      {
        name: "HEAD of the root",
        method: "HEAD",
        path: "/",
        credential: false,
      },
      {
        name: "OPTIONS of a path no operation serves",
        method: "OPTIONS",
        path: `/no-door-${randomUUID()}`,
      },
      {
        name: "the MCP door",
        method: "POST",
        path: "/mcp",
        body: "{}",
      },
      {
        name: "the OAuth token door",
        method: "POST",
        path: "/oauth/token",
        body: "grant_type=authorization_code",
        headers: form,
        credential: false,
      },
      {
        name: "the OAuth revocation door",
        method: "POST",
        path: "/oauth/revoke",
        body: "token=none&client_id=none",
        headers: form,
        credential: false,
      },
      {
        name: "the OAuth authorization door",
        method: "GET",
        path: "/oauth/authorize?client_id=none",
        credential: false,
      },
      {
        name: "the device code door",
        method: "POST",
        path: "/oauth/device-authorization",
        body: "client_id=none",
        headers: form,
        credential: false,
      },
      {
        name: "a well-known document",
        method: "GET",
        path: "/.well-known/oauth-protected-resource",
        credential: false,
      },
      {
        name: "an authorization server document",
        method: "GET",
        path: "/.well-known/oauth-authorization-server",
        credential: false,
      },
    ];
    for (const door of doors) {
      const plain = await fetch(`${apiUrl}${door.path}`, {
        method: door.method,
        headers: {
          ...(door.credential === false
            ? {}
            : { Authorization: `Bearer ${apiKey}` }),
          ...door.headers,
        },
        body: door.body,
      });
      // The witness: the same request naming no contract is judged by the
      // door itself.
      expect(plain.status, `${door.name} without the header`).not.toBe(412);
      await plain.body?.cancel();
      const res = await fetch(`${apiUrl}${door.path}`, {
        method: door.method,
        headers: {
          ...(door.credential === false
            ? {}
            : { Authorization: `Bearer ${apiKey}` }),
          ...door.headers,
          [HEADER]: other,
        },
        body: door.body,
      });
      expect(res.status, door.name).toBe(412);
      expect(res.headers.get("X-Error-Code"), door.name).toBe(
        "contract_mismatch",
      );
      expect(res.headers.get(HEADER), door.name).toBe(own);
      if (door.method !== "HEAD") {
        expect(await codeOf(res), door.name).toBe("contract_mismatch");
      }
      await res.body?.cancel();
    }

    const endpoint = await client.createInboundEndpoint(
      (await client.registerConnector({ name: `${ctx.runId} contract door` }))
        .data.id,
    );
    expect(endpoint.status).toBe(201);
    const sent = await sendRaw(apiUrl, endpoint.data.path, "hello", [
      HEADER,
      other,
    ]);
    expect(sent.status, "an inbound endpoint").toBe(412);
    expect(JSON.parse(sent.body).error.code).toBe("contract_mismatch");
    // The witness: the same sender naming this contract is received.
    expect(
      (await sendRaw(apiUrl, endpoint.data.path, "hello", [HEADER, own]))
        .status,
    ).toBe(202);

    const socket = process.env.MARFA_CONTROL_SOCKET;
    if (!socket) throw new Error("MARFA_CONTROL_SOCKET is required");
    const refused = await controlRequest(socket, "/", {
      headers: { [HEADER]: other },
    });
    expect(refused.status, "a route over the private socket").toBe(412);
    expect((refused.body.error as { code: string }).code).toBe(
      "contract_mismatch",
    );
    expect(
      (
        await controlRequest(socket, "/", {
          headers: { [HEADER]: own },
        })
      ).status,
    ).toBe(200);
  });

  it("answers 412 before it judges the credential, the instance and the body", async () => {
    const other = String(BigInt(own) + 1n);

    // No credential: 401 without the header, 412 with it.
    expect((await send("/items", { credential: false })).status).toBe(401);
    const unnamed = await send("/items", {
      credential: false,
      headers: { [HEADER]: other },
    });
    expect(unnamed.status).toBe(412);
    expect(await codeOf(unnamed)).toBe("contract_mismatch");

    // Another instance: 409 without the header, 412 with it.
    const elsewhere = await send("/items", {
      method: "POST",
      body: note("elsewhere"),
      headers: { "X-Marfa-Instance-Id": OTHER_INSTANCE },
    });
    expect(elsewhere.status).toBe(409);
    expect(await codeOf(elsewhere)).toBe("instance_changed");
    const both = await send("/items", {
      method: "POST",
      body: note("elsewhere"),
      headers: { "X-Marfa-Instance-Id": OTHER_INSTANCE, [HEADER]: other },
    });
    expect(both.status).toBe(412);
    expect(await codeOf(both)).toBe("contract_mismatch");

    // A body that is not JSON: 400 without the header, 412 with it.
    const text = (headers: Record<string, string>) =>
      fetch(`${apiUrl}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "text/plain",
          ...headers,
        },
        body: "not json",
      });
    expect((await text({})).status).toBe(400);
    const named = await text({ [HEADER]: other });
    expect(named.status).toBe(412);
    expect(await codeOf(named)).toBe("contract_mismatch");
  });

  it("keeps no refusal under an Idempotency-Key", async () => {
    const key = `contract-request-${randomUUID()}`;
    const body = note(`keyed ${key}`);
    const refused = await send("/items", {
      method: "POST",
      body,
      headers: {
        "Idempotency-Key": key,
        [HEADER]: String(BigInt(own) + 1n),
      },
    });
    expect(refused.status).toBe(412);
    expect(await codeOf(refused)).toBe("contract_mismatch");

    const first = await send("/items", {
      method: "POST",
      body,
      headers: { "Idempotency-Key": key, [HEADER]: own },
    });
    await created(first);
    expect(
      first.headers.get("Idempotency-Replayed"),
      "the refusal was kept under the key",
    ).toBeNull();
    const written = await first.json();

    // The witness: the key holds what the write answered.
    const again = await send("/items", {
      method: "POST",
      body,
      headers: { "Idempotency-Key": key },
    });
    expect(again.status).toBe(201);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await again.json()).toEqual(written);
    expect(await held(`keyed ${key}`)).toBe(1);
  });
});

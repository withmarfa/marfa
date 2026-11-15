import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
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
          body: operation.method === "GET" ? undefined : {},
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

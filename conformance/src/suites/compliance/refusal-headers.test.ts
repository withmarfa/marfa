import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { servedDocument } from "../../utils/openapi.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackKey,
  trackType,
} from "../../utils/setup.js";

/**
 * The headers a refusal carries, and the one every answer carries.
 *
 * `X-Error-Code` repeats the body's `error.code`, so a client or a proxy can
 * read the refusal without parsing the body. `X-Request-ID` names the request
 * in the server's log, and it is the caller's own when the caller sent one
 * the server accepts.
 */
let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
/** A server booted to answer 429 and 503, which the run's server does not. */
let limited: FreshServer | undefined;

/** The registration the sign-in library answers. */
const REGISTRATION = "/auth/oauth2/register";

/** Low enough to reach in a few requests. */
const KEYS_LIMIT = 3;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "refusal-headers",
  ));
  limited = await bootFreshServer("refusal-headers", {
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_KEYS_REQUESTS: String(KEYS_LIMIT),
    MARFA_SSE_MAX_VIEWERS: "1",
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await stopFreshServers();
  await cleanup(ctx);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** What a refusal's body names, and what its header says. */
async function refusal(
  res: Response,
): Promise<{ code: string | undefined; header: string | null }> {
  const body = (await res.json()) as { error?: { code?: string } };
  return { code: body.error?.code, header: res.headers.get("X-Error-Code") };
}

/** A refusal of `status` whose `X-Error-Code` is the code its body names. */
async function expectCodeHeader(
  res: Response,
  status: number,
  code: string,
): Promise<void> {
  const seen = await refusal(res);
  expect(res.status, JSON.stringify(seen)).toBe(status);
  expect(seen.code).toBe(code);
  expect(seen.header).toBe(code);
}

/**
 * A request sent on a connection of its own, which the server closes after
 * it. A body the server refuses unread, as the cap does, leaves a pooled
 * connection unusable for the request after.
 */
function sentAlone(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        method: "POST",
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        agent: false,
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
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
    // The server may answer and close before it has read the body.
    req.on("error", reject);
    req.end(body);
  });
}

describe("X-Error-Code", () => {
  it("repeats the body's code on a refusal of each status 400, 401, 403, 404, 409, 413 and 422", async () => {
    await expectCodeHeader(
      await fetch(`${apiUrl}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ properties: {} }),
      }),
      400,
      "missing_required_field",
    );

    await expectCodeHeader(await fetch(`${apiUrl}/items`), 401, "unauthorized");

    const reader = await client.createKey({
      label: `${ctx.source}-reader`,
      source: `${ctx.source}-reader`,
      type_permissions: { "core.note": "read" },
    });
    expect(reader.status, JSON.stringify(reader.error)).toBe(201);
    trackKey(ctx, reader.data.id);
    await expectCodeHeader(
      await fetch(`${apiUrl}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${reader.data.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "core.note",
          properties: { body: "refused" },
        }),
      }),
      403,
      "type_not_permitted",
    );

    await expectCodeHeader(
      await fetch(`${apiUrl}/items/${uuidv7()}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
      404,
      "item_not_found",
    );

    const type = `user.error_header_${ctx.runId.replaceAll("-", "_")}`;
    const registered = await client.registerType({
      id: type,
      label: "Error header",
      version: 0,
      fields: {},
    });
    expect(registered.status).toBe(201);
    trackType(ctx, type, client);
    await expectCodeHeader(
      await fetch(`${apiUrl}/types`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: type,
          label: "Error header",
          version: 0,
          fields: {},
        }),
      }),
      409,
      "type_already_exists",
    );

    const big = await sentAlone(
      `${apiUrl}/items`,
      {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({
        type: "core.note",
        properties: { body: "x".repeat(1_100_000) },
      }),
    );
    expect(big.status).toBe(413);
    expect(big.headers["x-error-code"]).toBe("request_too_large");
    expect(
      (JSON.parse(big.body) as { error: { code: string } }).error.code,
    ).toBe("request_too_large");

    const key = `error-header-${ctx.runId}`;
    const send = (text: string) =>
      fetch(`${apiUrl}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          type: "core.note",
          source: ctx.source,
          properties: { body: text },
        }),
      });
    const first = await send("first");
    expect(first.status).toBe(201);
    trackItem(ctx, ((await first.json()) as { item: { id: string } }).item.id);
    await expectCodeHeader(
      await send("a different request"),
      422,
      "idempotency_key_reused",
    );
  });

  it("repeats the body's code on a 429 and on a 503, which a server booted for them answers", async () => {
    const minter = new MarfaClient({
      baseUrl: limited!.apiUrl,
      apiKey: limited!.workingKey,
    });
    const minted = await minter.createKey({
      label: "refusal-headers-limited",
      source: "refusal-headers-limited",
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    const caller = `Bearer ${minted.data.key}`;

    // The witness: the window admits the number the instance set.
    for (let admitted = 0; admitted < KEYS_LIMIT; admitted += 1) {
      const answered = await fetch(`${limited!.apiUrl}/keys/current`, {
        headers: { Authorization: caller },
      });
      expect(answered.status, `request ${String(admitted + 1)}`).toBe(200);
      await answered.arrayBuffer();
    }
    await expectCodeHeader(
      await fetch(`${limited!.apiUrl}/keys/current`, {
        headers: { Authorization: caller },
      }),
      429,
      "rate_limited",
    );

    const held = new AbortController();
    try {
      const open = (signal?: AbortSignal) =>
        fetch(`${limited!.apiUrl}/events`, {
          headers: {
            Authorization: `Bearer ${limited!.workingKey}`,
            Accept: "text/event-stream",
          },
          signal,
        });
      expect((await open(held.signal)).status).toBe(200);
      await expectCodeHeader(await open(), 503, "stream_capacity_exhausted");
    } finally {
      held.abort();
    }
  });

  it("rides a page a browser is sent in place of the body, for a request that prefers HTML", async () => {
    const res = await fetch(`${apiUrl}/items`, {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("X-Error-Code")).toBe("unauthorized");
  });
});

describe("X-Request-ID", () => {
  /** The published doors that answer once and close. */
  async function doors(): Promise<{ method: string; path: string }[]> {
    const found: { method: string; path: string }[] = [];
    const document = await servedDocument();
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) {
          continue;
        }
        if (JSON.stringify(operation).includes("text/event-stream")) continue;
        found.push({ method: method.toUpperCase(), path });
      }
    }
    return found;
  }

  it("is on the answer to every published door, served or refused, to a caller with a credential and to one without", async () => {
    const all = await doors();
    expect(all.length).toBeGreaterThan(50);

    const missing: string[] = [];
    let served = 0;
    let refused = 0;
    const note = (label: string, res: Response) => {
      if (res.status < 400) served += 1;
      else refused += 1;
      if (!res.headers.get("X-Request-ID")) {
        missing.push(`${label} (${String(res.status)})`);
      }
    };
    for (const { method, path } of all) {
      const url = path.replace(/\{[^}]+\}/g, () => uuidv7());
      const writes = ["POST", "PUT", "PATCH"].includes(method);
      if (path === REGISTRATION) {
        // The library serves it, so it is asked what it accepts and what it
        // refuses: a registration it takes, the same sent with a bearer it
        // does not accept, and a body that is no registration.
        const registration = JSON.stringify({
          redirect_uris: ["https://example.com/callback"],
          client_name: `${ctx.source}-census`,
        });
        for (const [label, headers, body, status] of [
          ["no credential", {}, registration, 201],
          [
            "a bearer",
            { Authorization: `Bearer ${apiKey}` },
            registration,
            401,
          ],
          ["a body that is not JSON", {}, "[", undefined],
        ] as const) {
          const res = await fetch(`${apiUrl}${url}`, {
            method,
            headers: { ...headers, "Content-Type": "application/json" },
            body,
          });
          await res.body?.cancel();
          if (status !== undefined) {
            expect(res.status, `${method} ${path} (${label})`).toBe(status);
          }
          note(`${method} ${path} (${label})`, res);
        }
        continue;
      }
      for (const credential of [undefined, apiKey]) {
        // A read's proof is asked for on a read, so a read is sent with and
        // without one.
        for (const readView of method === "GET" ? [false, true] : [false]) {
          const res = await fetch(`${apiUrl}${url}`, {
            method,
            headers: {
              ...(credential === undefined
                ? {}
                : { Authorization: `Bearer ${credential}` }),
              ...(readView ? { "X-Marfa-Read-View": "not-a-proof" } : {}),
              "Content-Type": "application/json",
            },
            // Not a body any door takes, so a write door refuses it and none
            // writes.
            body: writes ? "[" : undefined,
            redirect: "manual",
          });
          // The headers are the answer here; an export need not be read to its end.
          await res.body?.cancel();
          note(
            `${method} ${path}${readView ? " (with a read view)" : ""}`,
            res,
          );
        }
      }
    }
    expect(missing).toEqual([]);
    // The two kinds the title names were both asked.
    expect(served).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  }, 120_000);

  it("is the caller's own, on a served answer and on a refusal, when the caller sent one of 1 to 128 letters, digits, underscores and hyphens", async () => {
    const sent = "caller_id-1";
    const served = await fetch(`${apiUrl}/items`, {
      headers: { Authorization: `Bearer ${apiKey}`, "X-Request-ID": sent },
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("X-Request-ID")).toBe(sent);

    for (const [path, status] of [
      [`/items/${uuidv7()}`, 404],
      ["/no-such-door", 404],
    ] as const) {
      const res = await fetch(`${apiUrl}${path}`, {
        headers: { Authorization: `Bearer ${apiKey}`, "X-Request-ID": sent },
      });
      expect(res.status, path).toBe(status);
      expect(res.headers.get("X-Request-ID"), path).toBe(sent);
    }

    const longest = "a".repeat(128);
    const edge = await fetch(`${apiUrl}/items`, {
      headers: { Authorization: `Bearer ${apiKey}`, "X-Request-ID": longest },
    });
    expect(edge.headers.get("X-Request-ID")).toBe(longest);
  });

  it("is one of the server's own, not the caller's, when the caller sent more than 128 characters or one outside letters, digits, underscore and hyphen", async () => {
    for (const sent of ["a".repeat(129), "has a space", "dotted.id", "ünï"]) {
      const res = await fetch(`${apiUrl}/items`, {
        headers: { Authorization: `Bearer ${apiKey}`, "X-Request-ID": sent },
      });
      expect(res.status, sent).toBe(200);
      const answered = res.headers.get("X-Request-ID");
      expect(answered, sent).not.toBeNull();
      expect(answered, sent).not.toBe(sent);
      expect(answered, sent).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    }
  });

  it("is a different one of the server's own for each request that sent none", async () => {
    const seen = new Set<string>();
    for (let n = 0; n < 5; n += 1) {
      const res = await fetch(`${apiUrl}/items`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const id = res.headers.get("X-Request-ID");
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      seen.add(id ?? "");
    }
    expect(seen.size).toBe(5);
  });

  it("is the retry's own on an answer replayed for an Idempotency-Key", async () => {
    const key = `request-id-replay-${ctx.runId}`;
    const send = (requestId: string) =>
      fetch(`${apiUrl}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
          "X-Request-ID": requestId,
        },
        body: JSON.stringify({
          type: "core.note",
          source: ctx.source,
          properties: { body: key },
        }),
      });
    const first = await send("first-attempt");
    expect(first.status).toBe(201);
    trackItem(ctx, ((await first.json()) as { item: { id: string } }).item.id);
    expect(first.headers.get("X-Request-ID")).toBe("first-attempt");

    const replay = await send("second-attempt");
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.headers.get("X-Request-ID")).toBe("second-attempt");
  });
});

describe("the registration the sign-in library answers", () => {
  it("answers a body that is not JSON with a 415 that carries X-Request-ID and no X-Error-Code, where Marfa's own doors carry both", async () => {
    // The witness: a refusal of Marfa's own carries both.
    const own = await fetch(`${apiUrl}/items`, {
      headers: { "X-Request-ID": "witness-1" },
    });
    expect(own.status).toBe(401);
    expect(own.headers.get("X-Error-Code")).toBe("unauthorized");
    expect(own.headers.get("X-Request-ID")).toBe("witness-1");

    const res = await fetch(`${apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Request-ID": "witness-2" },
      body: "{}",
    });
    expect(res.status).toBe(415);
    expect(res.headers.get("X-Error-Code")).toBeNull();
    expect(res.headers.get("X-Request-ID")).toBe("witness-2");
  });
});

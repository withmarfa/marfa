import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest, localFetch } from "../../utils/control-request.js";
import { HOUR_MS, movedClock, operatorOf } from "../../utils/moved-clock.js";
import { declareOversizeBody } from "../../utils/oversize.js";
import { DISK_ONLY } from "../../utils/own-blob-server.js";
import { png } from "../../utils/pictures.js";
import { issuerOrigin, signIn } from "../../utils/signed-in.js";
import {
  heldRequest,
  inParts,
  pause,
  slowPost,
} from "../../utils/slow-body.js";
import { tuning } from "../../utils/tuning.js";

// Shorten both limits so a progressing upload can outlast the body deadline.
const DEADLINE_MS = 3000;
const BULK_CAP = 16 * 1024 * 1024;
const JSON_HEADERS = { "content-type": "application/json" };

let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("public-body", {
    ...DISK_ONLY,
    ...tuning(`body_deadline_ms=${String(DEADLINE_MS)}`, "upload_idle_ms=2000"),
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

/** A declared body of the bulk cap, of which nothing is sent. */
function heldBulk(headers: Record<string, string>) {
  return declareOversizeBody(`${server.apiUrl}/items/bulk`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...headers },
    bytes: BULK_CAP,
  });
}

describe("a body the public listener reads whole", () => {
  it("is answered 408 request_timeout with the connection closed when it has not arrived by the deadline, and is taken when it arrives in time", async () => {
    const note = Buffer.from(
      JSON.stringify({ type: "core.note", properties: { body: "late" } }),
    );
    const [first, rest] = inParts(note, 2);
    const headers = { ...JSON_HEADERS, ...bearer(server.workingKey) };

    const late = slowPost({ apiUrl: server.apiUrl }, "/items", headers);
    const started = Date.now();
    await late.write(first!);
    const answered = await late.answered;
    expect(Date.now() - started).toBeGreaterThanOrEqual(DEADLINE_MS - 100);
    expect(answered.status, answered.body).toBe(408);
    expect(JSON.parse(answered.body).error.code).toBe("request_timeout");
    expect(answered.headers.connection).toBe("close");

    // The witness: the same body, slow but whole within the deadline.
    const slow = slowPost({ apiUrl: server.apiUrl }, "/items", headers);
    await slow.write(first!);
    await pause(DEADLINE_MS / 3);
    await slow.write(rest!);
    slow.end();
    const taken = await slow.answered;
    expect(taken.status, taken.body).toBe(201);
  }, 30_000);

  it("leaves a blob upload whose parts keep arriving to its own idle limit, past the deadline", async () => {
    const bytes = Buffer.from(
      "a blob that outlasts the deadline ".repeat(2000),
    );
    const upload = slowPost({ apiUrl: server.apiUrl }, "/blobs", {
      "content-type": "application/octet-stream",
      ...bearer(server.workingKey),
    });
    const started = Date.now();
    for (const part of inParts(bytes, 6)) {
      await upload.write(part);
      await pause(1000);
    }
    upload.end();
    const answered = await upload.answered;
    expect(Date.now() - started).toBeGreaterThan(DEADLINE_MS);
    expect(answered.status, answered.body).toBe(201);
  }, 30_000);
});

describe("an operation that needs a credential", () => {
  it("answers 401 unauthorized to a declared body before any of it is sent, when no credential comes with it", async () => {
    const started = Date.now();
    const refused = await heldBulk({});
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS);
    expect(refused.status, refused.body).toBe(401);
    expect(JSON.parse(refused.body).error.code).toBe("unauthorized");

    // The witness: with a key, the server waits for the body until its deadline.
    const read = await heldBulk(bearer(server.workingKey));
    expect(Date.now() - started).toBeGreaterThanOrEqual(DEADLINE_MS - 100);
    expect(read.status, read.body).toBe(408);
  }, 30_000);

  it("answers 401 naming the expiry to a key past its expires_at before any of the body is sent", async () => {
    const minted = await operatorOf(server).createKey({
      label: "brief",
      source: "brief",
      expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    await movedClock(server).advance(2 * HOUR_MS);

    const started = Date.now();
    const refused = await heldBulk(bearer(minted.data.key));
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS);
    expect(refused.status, refused.body).toBe(401);
    expect(JSON.parse(refused.body).error.details).toEqual({
      expired_at: minted.data.expires_at,
    });
  }, 30_000);
});

interface Answered {
  status: number;
  body: string;
}

function codeOf(answered: Answered): string | undefined {
  return (JSON.parse(answered.body) as { error?: { code?: string } }).error
    ?.code;
}

async function sentWhole(
  on: FreshServer,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | Uint8Array,
): Promise<Answered> {
  const response = await fetch(`${on.apiUrl}${path}`, {
    method,
    headers,
    body: typeof body === "string" ? body : new Uint8Array(body),
  });
  return { status: response.status, body: await response.text() };
}

/** The handshake places the authority change after admission and before the body. */
async function heldAcross(
  on: FreshServer,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string,
  change: () => Promise<void>,
): Promise<{ held: Answered; after: Answered }> {
  const held = heldRequest(on.apiUrl, method, path, headers, body);
  expect(
    await held.asked,
    "the server answered before it asked for the body",
  ).toBe(true);
  await change();
  held.send();
  const answered = await held.answered;
  return {
    held: answered,
    after: await sentWhole(on, method, path, headers, body),
  };
}

async function keyHolding(
  on: FreshServer,
  label: string,
  permissions: string[],
): Promise<{ id: string; key: string }> {
  const minted = await operatorOf(on).createKey({
    label,
    source: `public-body-${label}`,
    permissions,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return minted.data;
}

async function revokedWhileHeld(on: FreshServer, label: string): Promise<void> {
  const key = await keyHolding(on, label, ["config.manage"]);
  const headers = { ...JSON_HEADERS, ...bearer(key.key) };
  // The witness: the same request is answered 200 while the key is live.
  const live = await sentWhole(
    on,
    "POST",
    "/config/address-check",
    headers,
    check(on),
  );
  expect(live.status, live.body).toBe(200);

  const { held, after } = await heldAcross(
    on,
    "POST",
    "/config/address-check",
    headers,
    check(on),
    async () => {
      const revoked = await operatorOf(on).revokeKey(key.id);
      expect(revoked.status, JSON.stringify(revoked.error)).toBe(200);
    },
  );
  expect(held.status, held.body).toBe(401);
  expect(codeOf(held)).toBe("unauthorized");
  expect([after.status, codeOf(after)]).toEqual([held.status, codeOf(held)]);
}

describe("a credential whose authority changes while its body arrives", () => {
  it("is answered 401 once the body is whole when its key was revoked meanwhile", async () => {
    await revokedWhileHeld(server, "held-revoked");
  }, 30_000);

  it("is answered as a fresh request is once the body is whole when its key lost the permission meanwhile", async () => {
    const key = await keyHolding(server, "held-narrowed", ["config.manage"]);
    const headers = { ...JSON_HEADERS, ...bearer(key.key) };
    const live = await sentWhole(
      server,
      "POST",
      "/config/address-check",
      headers,
      check(server),
    );
    expect(live.status, live.body).toBe(200);

    const { held, after } = await heldAcross(
      server,
      "POST",
      "/config/address-check",
      headers,
      check(server),
      async () => {
        const narrowed = await operatorOf(server).updateKey(key.id, {
          permissions: [],
        });
        expect(narrowed.status, JSON.stringify(narrowed.error)).toBe(200);
      },
    );
    expect(held.status, held.body).toBe(403);
    expect([after.status, codeOf(after)]).toEqual([held.status, codeOf(held)]);
  }, 30_000);

  it("is answered 401 once the body is whole when the app's grant was revoked meanwhile", async () => {
    const app = await approvedApp(server);
    const headers = {
      ...JSON_HEADERS,
      ...bearer(app.token),
      accept: "application/json, text/event-stream",
    };
    const tools = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const live = await sentWhole(server, "POST", "/mcp", headers, tools);
    expect(live.status, live.body).toBe(200);

    const { held, after } = await heldAcross(
      server,
      "POST",
      "/mcp",
      headers,
      tools,
      async () => {
        const listed = await fetch(`${server.apiUrl}/auth/grants`, {
          headers: bearer(server.managementKey),
        });
        const grants = (
          (await listed.json()) as { data: { id: string; client_id: string }[] }
        ).data;
        const grant = grants.find((each) => each.client_id === app.clientId);
        expect(grant, "the approved app has no grant").toBeDefined();
        const revoked = await fetch(
          `${server.apiUrl}/auth/grants/${grant!.id}`,
          {
            method: "DELETE",
            headers: bearer(server.managementKey),
          },
        );
        expect(revoked.ok, String(revoked.status)).toBe(true);
      },
    );
    expect(held.status).toBe(401);
    expect(codeOf(held)).toBe("unauthorized");
    expect([after.status, codeOf(after)]).toEqual([held.status, codeOf(held)]);
  }, 30_000);

  it("is answered 401 once the body is whole when the owner's browser session was signed out meanwhile", async () => {
    const origin = await issuerOrigin(server);
    const signedIn = async () => ({
      ...JSON_HEADERS,
      origin,
      cookie: await signIn(server, origin),
    });
    // The witness: a live session's sign-out is answered 200.
    const live = await sentWhole(
      server,
      "POST",
      "/auth/sign-out",
      await signedIn(),
      "{}",
    );
    expect(live.status, live.body).toBe(200);

    const headers = await signedIn();
    const { held, after } = await heldAcross(
      server,
      "POST",
      "/auth/sign-out",
      headers,
      "{}",
      async () => {
        const out = await sentWhole(
          server,
          "POST",
          "/auth/sign-out",
          headers,
          "{}",
        );
        expect(out.status, out.body).toBe(200);
      },
    );
    expect(held.status, held.body).toBe(401);
    expect(codeOf(held)).toBe("unauthorized");
    expect([after.status, codeOf(after)]).toEqual([held.status, codeOf(held)]);
  }, 30_000);
});

describe("a credential revoked while an upload streams in", () => {
  it("is refused 401 and stores no picture when the key was revoked while a profile picture streamed in", async () => {
    const minted = await controlRequest(server.controlSocket, "/keys", {
      method: "POST",
      body: {
        label: "held-picture",
        source: "public-body-held-picture",
        profile_permissions: { avatar: "write" },
      },
    });
    expect(minted.status).toBe(201);
    const [id, key] = [minted.body.id as string, minted.body.key as string];
    const headers = bearer(key);
    const file = png(10, 10, 0x40);
    const stored = () =>
      localFetch(server.controlSocket, `${server.apiUrl}/owner/picture`);

    const held = heldRequest(
      server.apiUrl,
      "PUT",
      "/profile/picture",
      headers,
      file,
    );
    expect(
      await held.asked,
      "the server answered before it asked for the body",
    ).toBe(true);
    const revoked = await operatorOf(server).revokeKey(id);
    expect(revoked.status, JSON.stringify(revoked.error)).toBe(200);
    held.send();
    const answered = await held.answered;
    expect(answered.status, answered.body).toBe(401);
    expect(codeOf(answered)).toBe("unauthorized");
    expect((await stored()).status).toBe(404);

    // The witness: the same bytes from a live key are stored.
    const live = await sentWhole(
      server,
      "PUT",
      "/profile/picture",
      bearer(server.workingKey),
      file,
    );
    expect(live.status, live.body).toBe(200);
    expect((await stored()).status).toBe(200);
  }, 30_000);

  it("is refused 401 when the key was revoked while a blob streamed in", async () => {
    const key = await keyHolding(server, "held-blob", ["blobs.manage"]);
    const headers = {
      "content-type": "application/octet-stream",
      ...bearer(key.key),
    };
    const bytes = Buffer.from("a blob whose key is revoked while it arrives");
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

    const held = heldRequest(server.apiUrl, "POST", "/blobs", headers, bytes);
    expect(
      await held.asked,
      "the server answered before it asked for the body",
    ).toBe(true);
    const revoked = await operatorOf(server).revokeKey(key.id);
    expect(revoked.status, JSON.stringify(revoked.error)).toBe(200);
    held.send();
    const answered = await held.answered;
    expect(answered.status, answered.body).toBe(401);
    expect(codeOf(answered)).toBe("unauthorized");
    expect((await operatorOf(server).headBlob(hash)).status).toBe(404);

    // The witness: the same bytes from a live key are taken.
    const live = await sentWhole(
      server,
      "POST",
      "/blobs",
      {
        "content-type": "application/octet-stream",
        ...bearer(server.workingKey),
      },
      bytes,
    );
    expect(live.status, live.body).toBe(201);
  }, 30_000);
});

describe("a body on a request no operation reads one for", () => {
  it("is not waited for on a GET, HEAD, DELETE or OPTIONS request, which is answered as it is with no body", async () => {
    const key = await keyHolding(server, "bodiless", [
      "config.manage",
      "keys.manage",
    ]);
    const cases: [string, string, Record<string, string>][] = [
      ["GET", "/config", bearer(key.key)],
      ["HEAD", "/config", bearer(key.key)],
      ["HEAD", "/config", {}],
      ["DELETE", `/keys/${key.id}`, {}],
      ["OPTIONS", "/config", bearer(key.key)],
    ];
    for (const [method, path, headers] of cases) {
      const bare = await fetch(`${server.apiUrl}${path}`, { method, headers });
      const held = heldRequest(
        server.apiUrl,
        method,
        path,
        { ...JSON_HEADERS, ...headers },
        "{}",
      );
      expect(await held.asked, `${method} ${path} waited for its body`).toBe(
        false,
      );
      const answered = await held.answered;
      expect(answered.status, `${method} ${path}`).toBe(bare.status);
    }
    // The witness: a POST at a door that reads its body waits for it.
    const reading = heldRequest(
      server.apiUrl,
      "POST",
      "/config/address-check",
      {
        ...JSON_HEADERS,
        ...bearer(key.key),
      },
      check(server),
    );
    expect(await reading.asked).toBe(true);
    reading.send();
    expect((await reading.answered).status).toBe(200);
  }, 30_000);

  it("is answered 404 not_found before the body when no operation at the path takes the method", async () => {
    const held = heldRequest(
      server.apiUrl,
      "PUT",
      "/items/bulk",
      JSON_HEADERS,
      "{}",
    );
    expect(await held.asked, "the server waited for the body").toBe(false);
    const answered = await held.answered;
    expect(answered.status, answered.body).toBe(404);
    expect(codeOf(answered)).toBe("not_found");
    // The witness: the method the path takes waits for its body with a key.
    const taken = heldRequest(
      server.apiUrl,
      "POST",
      "/items/bulk",
      {
        ...JSON_HEADERS,
        ...bearer(server.workingKey),
      },
      "{}",
    );
    expect(await taken.asked).toBe(true);
    taken.send();
    await taken.answered;
  }, 30_000);
});

describe("a credential the rate limiter has already read", () => {
  let limited: FreshServer;

  beforeAll(async () => {
    limited = await bootFreshServer("public-body-limited", {
      MARFA_RATE_LIMIT_ENABLED: "true",
    });
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await limited.stop();
  }, FRESH_SERVER_TIMEOUT_MS);

  it("is answered 401 once the body is whole when its key was revoked meanwhile, with the rate limiter on", async () => {
    await revokedWhileHeld(limited, "held-limited");
  }, 30_000);
});

function check(on: FreshServer): string {
  return JSON.stringify({ sign_in_address: new URL(on.apiUrl).origin });
}

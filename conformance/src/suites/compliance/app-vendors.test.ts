import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MarfaClient } from "../../client/api.js";
import {
  archiveLines,
  emptyManifest,
  lineFile,
  ndjson,
  tar,
} from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  connect,
  issuerOrigin,
  registerApp,
  signIn,
  type App,
} from "../../utils/signed-in.js";
import { callTool, connectMcp, toolResult } from "../../utils/mcp.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { collectUntil, withStream } from "../../utils/stream.js";

/**
 * An `app.<vendor>` namespace belongs to the app that registered the first
 * type under it: that app and the owner reach its items, and another app only
 * through a grant that names the vendor. Apps are signed in by a person, and
 * the owner's view is the whole instance, so this file boots a server of its
 * own.
 */
let server: FreshServer;
let origin: string;
let cookie: string;
let local: MarfaClient;

const FRAME_BUDGET_MS = 15_000;
const COPY_QUERY: Array<[string, string]> = [
  ["edges", "all"],
  ["copy", "true"],
];
const REGISTERS = "content:write metadata.types:write";

beforeAll(async () => {
  server = await bootFreshServer("app-vendors");
  origin = await issuerOrigin(server);
  cookie = await signIn(server, origin);
  local = new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Signed {
  app: App;
  token: string;
}

async function signedIn(scope: string): Promise<Signed> {
  const app = await registerApp(server, scope);
  const answer = await connect(server, origin, cookie, app, scope);
  return { app, token: answer.access_token! };
}

function call(
  credential: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${credential}`,
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function answer(
  credential: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await call(credential, path, init);
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function registerType(credential: string, id: string): Promise<number> {
  return (
    await answer(credential, "/types", {
      method: "POST",
      body: { id, version: 1, fields: { title: { type: "string" } } },
    })
  ).status;
}

async function createItem(
  credential: string,
  type: string,
  title: string,
): Promise<string> {
  const made = await answer(credential, "/items", {
    method: "POST",
    body: { type, properties: { title } },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return (made.body.item as { id: string }).id;
}

async function reads(credential: string, id: string): Promise<boolean> {
  const response = await call(credential, `/items/${id}`);
  await response.body?.cancel();
  return response.status === 200;
}

async function listed(
  credential: string,
  type: string,
  id: string,
): Promise<boolean> {
  const got = await answer(
    credential,
    `/items?type=${encodeURIComponent(type)}&limit=100`,
  );
  const data = (got.body.data ?? []) as Array<{
    id?: string;
    item?: { id: string };
  }>;
  return data.some((entry) => (entry.id ?? entry.item?.id) === id);
}

async function found(
  credential: string,
  word: string,
  id: string,
): Promise<boolean> {
  const got = await answer(credential, `/search?q=${word}&limit=100`);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  const data = (got.body.data ?? []) as Array<{
    id?: string;
    item?: { id: string };
  }>;
  return data.some((hit) => (hit.id ?? hit.item?.id) === id);
}

/**
 * Whether a copy stream `credential` holds carries an item of `type` the
 * maker writes once the stream is live, settled by a note written after it,
 * which every credential here reads.
 */
async function streamed(
  credential: string,
  maker: string,
  type: string,
): Promise<boolean> {
  return withStream(
    server.apiUrl,
    credential,
    { query: COPY_QUERY },
    async (stream) => {
      expect(stream.response.status).toBe(200);
      await collectUntil(
        stream,
        (frames) => frames.some((frame) => frame.event === "stream_live"),
        "the copy stream's live marker",
        AbortSignal.timeout(FRAME_BUDGET_MS),
      );
      const written = await createItem(maker, type, "written while streaming");
      const sentinel = await createItem(maker, "core.note", "the sentinel");
      const { events } = await collectUntil(
        stream,
        (frames) =>
          frames.some((frame) => JSON.stringify(frame.data).includes(sentinel)),
        "the sentinel note's frame",
        AbortSignal.timeout(FRAME_BUDGET_MS),
      );
      return events.some((frame) =>
        JSON.stringify(frame.data).includes(written),
      );
    },
  );
}

async function grantFor(app: App): Promise<{ id: string; scopes: string[] }> {
  const grants = await answer(server.managementKey, "/grants");
  expect(grants.status).toBe(200);
  const data = grants.body.data as Array<{
    id: string;
    client_id: string;
    scopes: string[];
  }>;
  const grant = data.find((one) => one.client_id === app.clientId);
  expect(grant, app.clientId).toBeDefined();
  return grant!;
}

async function grantOf(app: App): Promise<string> {
  return (await grantFor(app)).id;
}

/** The client ID holding `vendor`, `null` while the owner holds it, or `undefined` if no one does. */
async function holder(vendor: string): Promise<string | null | undefined> {
  const page = await answer(server.managementKey, "/app-vendors");
  expect(page.status, JSON.stringify(page.body)).toBe(200);
  await expectMatchesSchema("GET", "/app-vendors", 200, page.body);
  const data = page.body.data as Array<{
    vendor: string;
    client_id: string | null;
  }>;
  return data.find((one) => one.vendor === vendor)?.client_id;
}

/** A key the app holding `token` mints, holding `types` and `permissions`. */
async function appKey(
  token: string,
  types: Record<string, string>,
  permissions: string[] = [],
): Promise<string> {
  const minted = await answer(token, "/keys", {
    method: "POST",
    body: {
      label: "app-made",
      source: `app-made-${randomUUID().slice(0, 8)}`,
      type_permissions: types,
      permissions,
    },
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  return minted.body.key as string;
}

function forbidden(got: { status: number; body: Record<string, unknown> }) {
  expect(got.status, JSON.stringify(got.body)).toBe(403);
  return got.body.error as { code: string; details?: Record<string, unknown> };
}

/** Version 1 names a registered type's origin `user`, and version 2 `registered`. */
function vendorArchive(
  version: number,
  lines: Array<Record<string, unknown>>,
): Uint8Array {
  const manifest = emptyManifest({
    version,
    type_count: lines.filter((line) => "type" in line).length,
    ...(version === 1
      ? {}
      : {
          plugin_count: 0,
          app_vendor_count: lines.filter((line) => "app_vendor" in line).length,
        }),
  });
  if (version !== 1) {
    lines = lines.map((line) =>
      "provenance" in line
        ? {
            ...line,
            provenance: {
              ...(line.provenance as Record<string, unknown>),
              origin: "registered",
            },
          }
        : line,
    );
  }
  return tar([
    { name: "manifest.json", body: JSON.stringify(manifest) },
    lineFile("files", ""),
    lineFile("instance", ndjson(lines)),
    lineFile("items", ""),
    lineFile("versions", ""),
    lineFile("edges", ""),
    lineFile("rows", ""),
  ]);
}

/** A vendor no earlier attempt of a test used, so a retry starts from no holder. */
function freshVendor(): string {
  const tag = Array.from({ length: 8 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join("");
  return `app.vendor${tag}`;
}

function typeLine(id: string, createdBy: unknown): Record<string, unknown> {
  return {
    type: { id, version: 1, fields: { title: { type: "string" } } },
    provenance: { origin: "user", created_by: createdBy },
  };
}

describe("an app's own types", () => {
  const vendor = freshVendor();
  const type = `${vendor}.setting`;
  const word = `vendorword${randomUUID().slice(0, 8)}`;
  let maker: Signed;
  let reader: Signed;
  let item: string;

  beforeAll(async () => {
    maker = await signedIn(REGISTERS);
    reader = await signedIn("content:read");
    expect(await registerType(maker.token, type)).toBe(201);
    item = await createItem(maker.token, type, `a setting ${word}`);
  }, FRESH_SERVER_TIMEOUT_MS);

  it("gives the vendor to the app that registered the first type under it", async () => {
    expect(await holder(vendor)).toBe(maker.app.clientId);
  });

  it("lets the app that registered them read, list, search and copy their items without a scope that names them", async () => {
    expect(await reads(maker.token, item)).toBe(true);
    expect(await listed(maker.token, type, item)).toBe(true);
    expect(await found(maker.token, word, item)).toBe(true);
    expect(await streamed(maker.token, maker.token, type)).toBe(true);
  });

  it("lets a key no app made read, list, search and copy their items as its map says", async () => {
    expect(await reads(server.workingKey, item)).toBe(true);
    expect(await listed(server.workingKey, type, item)).toBe(true);
    expect(await found(server.workingKey, word, item)).toBe(true);
    expect(await streamed(server.workingKey, maker.token, type)).toBe(true);
  });

  it("keeps their items from another app's content grant in a read, a listing, a search and a copy stream", async () => {
    // The witness: the same reads find a note the other app may read.
    const note = await createItem(maker.token, "core.note", `a note ${word}`);
    expect(await reads(reader.token, note)).toBe(true);
    expect(await found(reader.token, word, note)).toBe(true);
    expect(await streamed(reader.token, maker.token, "core.note")).toBe(true);

    expect(await reads(reader.token, item)).toBe(false);
    expect(await listed(reader.token, type, item)).toBe(false);
    expect(await found(reader.token, word, item)).toBe(false);
    expect(await streamed(reader.token, maker.token, type)).toBe(false);
  });

  it("refuses another app a type under the vendor with 403 forbidden naming the namespace", async () => {
    const vB = freshVendor();
    const writer = await signedIn(REGISTERS);
    // The witness: the same app registers under a vendor no app holds.
    expect(await registerType(writer.token, `${vB}.setting`)).toBe(201);

    const refused = await answer(writer.token, "/types", {
      method: "POST",
      body: {
        id: `${vendor}.other`,
        version: 1,
        fields: { title: { type: "string" } },
      },
    });
    expect(refused.status).toBe(403);
    const error = refused.body.error as {
      code: string;
      details: Record<string, unknown>;
    };
    expect(error.code).toBe("forbidden");
    expect(error.details.namespace).toBe(vendor);
    expect(
      (await answer(server.workingKey, `/types/${vendor}.other`)).status,
    ).toBe(404);
  });

  it("lets another app reach their items through a grant that names the vendor", async () => {
    const named = await signedIn(`content:read ${vendor}.*:read`);
    expect(await reads(named.token, item)).toBe(true);
    expect(await listed(named.token, type, item)).toBe(true);
    expect(await found(named.token, word, item)).toBe(true);
    expect(await streamed(named.token, maker.token, type)).toBe(true);
    const write = await answer(named.token, "/items", {
      method: "POST",
      body: { type, properties: { title: "not mine" } },
    });
    expect(write.status).toBe(403);
  });
});

describe("giving a vendor to another app", () => {
  /** Two apps and a vendor the first holds, new for each attempt of a test. */
  async function held(): Promise<{
    vendor: string;
    first: Signed;
    second: Signed;
    item: string;
  }> {
    const vendor = freshVendor();
    const first = await signedIn(REGISTERS);
    const second = await signedIn(REGISTERS);
    expect(await registerType(first.token, `${vendor}.setting`)).toBe(201);
    const item = await createItem(
      first.token,
      `${vendor}.setting`,
      "kept for the app",
    );
    return { vendor, first, second, item };
  }

  it("moves the vendor to the app named, which then reaches its items in place of the app that held it", async () => {
    const { vendor, first, second, item } = await held();
    expect(await reads(first.token, item)).toBe(true);
    expect(await reads(second.token, item)).toBe(false);

    const given = await answer(server.managementKey, `/app-vendors/${vendor}`, {
      method: "PUT",
      body: { client_id: second.app.clientId },
    });
    expect(given.status, JSON.stringify(given.body)).toBe(200);
    await expectMatchesSchema("PUT", "/app-vendors/{vendor}", 200, given.body);
    expect(given.body.vendor).toBe(vendor);
    expect(given.body.client_id).toBe(second.app.clientId);
    expect(await holder(vendor)).toBe(second.app.clientId);

    expect(await reads(second.token, item)).toBe(true);
    expect(await reads(first.token, item)).toBe(false);
    expect(await registerType(second.token, `${vendor}.more`)).toBe(201);
    expect(await registerType(first.token, `${vendor}.again`)).toBe(403);
  });

  it("refuses a credential without grants.manage with 403 forbidden naming it", async () => {
    const { vendor, first } = await held();
    const refused = await answer(first.token, `/app-vendors/${vendor}`, {
      method: "PUT",
      body: { client_id: first.app.clientId },
    });
    expect(refused.status).toBe(403);
    const error = refused.body.error as {
      code: string;
      details: Record<string, unknown>;
    };
    expect(error.code).toBe("forbidden");
    expect(error.details.required_scope).toBe("grants.manage");
    expect((await answer(first.token, "/app-vendors")).status).toBe(403);
  });

  it("refuses a client no app registered with 404 not_found, a name that is no vendor and a missing client_id with 400", async () => {
    const { vendor, first, second } = await held();
    const unknown = await answer(
      server.managementKey,
      `/app-vendors/${vendor}`,
      {
        method: "PUT",
        body: { client_id: randomUUID() },
      },
    );
    expect(unknown.status).toBe(404);
    expect((unknown.body.error as { code: string }).code).toBe("not_found");

    for (const name of ["core.note", "app", `${vendor}.setting`]) {
      const refused = await answer(
        server.managementKey,
        `/app-vendors/${name}`,
        {
          method: "PUT",
          body: { client_id: second.app.clientId },
        },
      );
      expect(refused.status, name).toBe(400);
      expect((refused.body.error as { code: string }).code, name).toBe(
        "validation_error",
      );
    }
    const missing = await answer(
      server.managementKey,
      `/app-vendors/${vendor}`,
      {
        method: "PUT",
        body: {},
      },
    );
    expect(missing.status).toBe(400);
    expect((missing.body.error as { code: string }).code).toBe(
      "missing_required_field",
    );
    expect(await holder(vendor)).toBe(first.app.clientId);
  });
});

describe("what a key an app made reaches", () => {
  it("keeps a key an app made from other apps' data once the app's grant no longer names it, and leaves it its own vendor", async () => {
    const vG = freshVendor();
    const vH = freshVendor();
    const maker = await signedIn(`${REGISTERS} keys.mint app.*:read`);
    const other = await signedIn(REGISTERS);
    expect(await registerType(maker.token, `${vG}.setting`)).toBe(201);
    const own = await createItem(maker.token, `${vG}.setting`, "mine");
    expect(await registerType(other.token, `${vH}.setting`)).toBe(201);
    const theirs = await createItem(other.token, `${vH}.setting`, "theirs");
    const key = await appKey(maker.token, {
      "core.note": "read",
      "app.*": "read",
    });
    // The witness: while the grant names app.*, the key reads both.
    expect(await reads(key, theirs)).toBe(true);
    expect(await reads(key, own)).toBe(true);

    const ended = await answer(
      server.managementKey,
      `/grants/${await grantOf(maker.app)}`,
      { method: "DELETE" },
    );
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(await reads(key, theirs)).toBe(false);
    expect(await reads(key, own)).toBe(true);
  });

  it("keeps a key an app made, narrowed to what the app's narrowed grant reaches, when the owner narrows the grant", async () => {
    const vM = freshVendor();
    const maker = await signedIn(`${REGISTERS} keys.mint app.*:read`);
    const other = await signedIn(REGISTERS);
    expect(await registerType(other.token, `${vM}.setting`)).toBe(201);
    const theirs = await createItem(other.token, `${vM}.setting`, "theirs");
    const note = await createItem(other.token, "core.note", "a note");
    const key = await appKey(maker.token, {
      "core.note": "read",
      "app.*": "read",
    });
    expect(await reads(key, theirs)).toBe(true);

    const grant = await grantFor(maker.app);
    const narrowed = await answer(server.managementKey, `/grants/${grant.id}`, {
      method: "PATCH",
      body: {
        expected_scopes: grant.scopes,
        scopes: grant.scopes.filter((scope) => scope !== "app.*:read"),
      },
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    expect(narrowed.body.revoked_keys).toBe(0);
    expect(await reads(key, note)).toBe(true);
    expect(await reads(key, theirs)).toBe(false);
  });

  it("lets an app approved for every app's data register its first type and reach its items", async () => {
    const vI = freshVendor();
    const app = await signedIn("app.*:write metadata.types:write");
    expect(await registerType(app.token, `${vI}.setting`)).toBe(201);
    const item = await createItem(app.token, `${vI}.setting`, "kept");
    expect(await reads(app.token, item)).toBe(true);
  });

  it("judges a key an app made by what it reaches when used, listing and revoking it only within that reach", async () => {
    const vR = freshVendor();
    const maker = await signedIn(`${REGISTERS} keys.mint app.*:read`);
    const other = await signedIn(REGISTERS);
    expect(await registerType(other.token, `${vR}.setting`)).toBe(201);
    const theirs = await createItem(other.token, `${vR}.setting`, "theirs");
    const minted = await answer(maker.token, "/keys", {
      method: "POST",
      body: {
        label: "reach",
        source: `reach-${randomUUID().slice(0, 8)}`,
        type_permissions: { "core.note": "read", "app.*": "read" },
      },
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const bound = {
      id: minted.body.id as string,
      key: minted.body.key as string,
    };
    const made = await local.createKey({
      label: "narrow minter",
      source: `reach-${randomUUID().slice(0, 8)}`,
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "read" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const minter = made.data!.key;
    const listed = async () => {
      const page = await answer(minter, "/keys");
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      return (page.body.data as Array<{ id: string }>).map((one) => one.id);
    };
    // The witness: while the grant names app.*, the key reads the other app's item.
    expect(await reads(bound.key, theirs)).toBe(true);
    expect(await listed()).not.toContain(bound.id);
    const changed = await answer(minter, `/keys/${bound.id}`, {
      method: "PATCH",
      body: { label: "renamed" },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(404);
    expect((changed.body.error as { code: string }).code).toBe("key_not_found");
    const kept = await answer(minter, `/keys/${bound.id}`, {
      method: "DELETE",
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(404);

    const grant = await grantFor(maker.app);
    const narrowed = await answer(server.managementKey, `/grants/${grant.id}`, {
      method: "PATCH",
      body: {
        expected_scopes: grant.scopes,
        scopes: grant.scopes.filter((scope) => scope !== "app.*:read"),
      },
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    expect(await reads(bound.key, theirs)).toBe(false);
    expect(await listed()).toContain(bound.id);
    const revoked = await answer(minter, `/keys/${bound.id}`, {
      method: "DELETE",
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  });

  it("leaves a kept key an app made its own vendor as its map names it there once the grant ends, and nothing of other apps", async () => {
    const vendor = freshVendor();
    const vOther = freshVendor();
    const app = await signedIn(`${REGISTERS} keys.mint app.*:write`);
    const other = await signedIn(REGISTERS);
    expect(await registerType(app.token, `${vendor}.setting`)).toBe(201);
    expect(await registerType(other.token, `${vOther}.setting`)).toBe(201);
    const theirs = await createItem(other.token, `${vOther}.setting`, "theirs");
    const key = await appKey(app.token, {
      "core.note": "read",
      "app.*": "write",
    });
    // The witness: while the grant names app.*, the key reads the other app's item.
    expect(await reads(key, theirs)).toBe(true);

    const ended = await answer(
      server.managementKey,
      `/grants/${await grantOf(app.app)}`,
      { method: "DELETE" },
    );
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(await reads(key, theirs)).toBe(false);
    const written = await createItem(key, `${vendor}.setting`, "by the key");
    expect(await reads(key, written)).toBe(true);
  });

  it("keeps the own-vendor wildcard a key an app made asks for", async () => {
    const vJ = freshVendor();
    const app = await signedIn(`${REGISTERS} keys.mint`);
    expect(await registerType(app.token, `${vJ}.setting`)).toBe(201);
    const key = await appKey(app.token, { [`${vJ}.*`]: "write" });
    const item = await createItem(key, `${vJ}.setting`, "by the key");
    expect(await reads(key, item)).toBe(true);
  });

  it("reaches nothing of its own vendor through a key whose map names nothing under app.*", async () => {
    const vK = freshVendor();
    const app = await signedIn(`${REGISTERS} keys.mint`);
    expect(await registerType(app.token, `${vK}.setting`)).toBe(201);
    const own = await createItem(app.token, `${vK}.setting`, "the app's own");
    const named = await appKey(app.token, { [`${vK}.*`]: "write" });
    // The witness: a key naming the vendor reads the app's item.
    expect(await reads(named, own)).toBe(true);
    const types = { "core.note": "write" };
    const minted = await answer(app.token, "/keys", {
      method: "POST",
      body: {
        label: "unnamed",
        source: `unnamed-${randomUUID().slice(0, 8)}`,
        type_permissions: types,
      },
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const key = minted.body.key as string;
    expect(await reads(key, own)).toBe(false);
    const refused = await answer(key, "/items", {
      method: "POST",
      body: { type: `${vK}.setting`, properties: { title: "unnamed" } },
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    const current = await answer(key, "/keys/current");
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect(current.body.type_permissions).toEqual(types);
    const page = await answer(server.managementKey, "/keys");
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    const shown = (
      page.body.data as Array<{ id: string; type_permissions: unknown }>
    ).find((one) => one.id === minted.body.id);
    expect(shown?.type_permissions).toEqual(types);
  });

  it("mints a key naming no family with the app's grant map, and no entry for the app's own vendor", async () => {
    const vD = freshVendor();
    const app = await signedIn(`${REGISTERS} keys.mint`);
    expect(await registerType(app.token, `${vD}.setting`)).toBe(201);
    const own = await createItem(app.token, `${vD}.setting`, "the app's own");
    // The witness: the app's sign-in reaches its own vendor without naming it.
    expect(await reads(app.token, own)).toBe(true);
    const minted = await answer(app.token, "/keys", {
      method: "POST",
      body: { label: "default", source: `default-${randomUUID().slice(0, 8)}` },
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const shown = JSON.stringify(minted.body.type_permissions);
    expect(shown).not.toContain(vD);
    const key = minted.body.key as string;
    expect(await reads(key, own)).toBe(false);
    const current = await answer(key, "/keys/current");
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect(current.body.type_permissions).toEqual(minted.body.type_permissions);
  });

  it("shows a credential's stored type map in the overview, over the API and MCP, with no derived entry", async () => {
    const vO = freshVendor();
    const app = await signedIn(`${REGISTERS} keys.mint`);
    expect(await registerType(app.token, `${vO}.setting`)).toBe(201);
    const own = await createItem(app.token, `${vO}.setting`, "the app's own");
    expect(await reads(app.token, own)).toBe(true);
    const types = { "core.note": "write" };
    const key = await appKey(app.token, types);
    for (const credential of [app.token, key]) {
      const overview = await answer(credential, "/overview");
      expect(overview.status, JSON.stringify(overview.body)).toBe(200);
      const shown = JSON.stringify(
        (overview.body.credential as Record<string, unknown>).type_permissions,
      );
      expect(shown).not.toContain(vO);
      const mcp = await connectMcp(server.apiUrl, credential);
      try {
        const tool = toolResult(await callTool(mcp, "marfa_overview", {}));
        const said = JSON.stringify(
          (tool.credential as Record<string, unknown>).type_permissions,
        );
        expect(said).toEqual(shown);
      } finally {
        await mcp.close();
      }
    }
    const overview = await answer(key, "/overview");
    expect(
      (overview.body.credential as Record<string, unknown>).type_permissions,
    ).toEqual({ write: ["core.note"] });
  });

  it("refuses a parent holding only exact types under a vendor a child holding the vendor's wildcard", async () => {
    const vE = freshVendor();
    const app = await signedIn(`${REGISTERS} keys.mint`);
    expect(await registerType(app.token, `${vE}.a`)).toBe(201);
    expect(await registerType(app.token, `${vE}.b`)).toBe(201);
    const parent = await appKey(
      app.token,
      { [`${vE}.a`]: "write", [`${vE}.b`]: "write" },
      ["keys.mint"],
    );
    const mint = (types: Record<string, string>) =>
      answer(parent, "/keys", {
        method: "POST",
        body: {
          label: "child",
          source: `child-${randomUUID().slice(0, 8)}`,
          type_permissions: types,
        },
      });
    // The witness: a child naming the parent's exact types is minted.
    const exact = await mint({ [`${vE}.a`]: "write" });
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    for (const level of ["read", "write"]) {
      const refused = forbidden(await mint({ [`${vE}.*`]: level }));
      expect(refused.details?.required_scope).toEqual(
        expect.stringContaining(`${vE}.*`),
      );
    }
  });

  it("refuses a key an app made a mint or an update naming app data its own map does not grant", async () => {
    const vT = freshVendor();
    const app = await signedIn(`${REGISTERS} keys.mint`);
    const other = await signedIn(REGISTERS);
    expect(await registerType(other.token, `${vT}.setting`)).toBe(201);
    const parent = await appKey(app.token, { "core.note": "read" }, [
      "keys.mint",
    ]);
    const mint = (types: Record<string, string>) =>
      answer(parent, "/keys", {
        method: "POST",
        body: {
          label: "child",
          source: `child-${randomUUID().slice(0, 8)}`,
          type_permissions: types,
        },
      });
    // The witness: a child within the parent's own map is minted.
    const child = await mint({ "core.note": "read" });
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    const refused = forbidden(
      await mint({ "core.note": "read", [`${vT}.*`]: "read" }),
    );
    expect(refused.details?.required_scope).toEqual(
      expect.stringContaining(vT),
    );
    const widened = forbidden(
      await answer(parent, `/keys/${child.body.id as string}`, {
        method: "PATCH",
        body: {
          type_permissions: { "core.note": "read", [`${vT}.*`]: "read" },
        },
      }),
    );
    expect(widened.details?.required_scope).toEqual(
      expect.stringContaining(vT),
    );
  });
});

describe("vendors only the owner gives", () => {
  it("refuses to give a vendor to an app's sign-in or a key an app made, whatever it holds", async () => {
    const vN = freshVendor();
    const app = await signedIn("grants.manage keys.mint");
    const key = await appKey(app.token, {}, ["grants.manage"]);
    for (const credential of [app.token, key]) {
      // The witness: the credential holds grants.manage, so it lists vendors.
      expect((await answer(credential, "/app-vendors")).status).toBe(200);
      const error = forbidden(
        await answer(credential, `/app-vendors/${vN}`, {
          method: "PUT",
          body: { client_id: app.app.clientId },
        }),
      );
      expect(error.code).toBe("forbidden");
    }
    expect(await holder(vN)).toBeUndefined();
  });

  it("holds a vendor two apps made types under for the owner, refuses it to either app, and gives it to the app the owner names", async () => {
    const vK = freshVendor();
    const first = await signedIn(REGISTERS);
    const second = await signedIn(REGISTERS);
    const made = (id: string, app: App, grant: string) =>
      typeLine(id, { kind: "app", id: grant, name: app.clientId });
    const restored = await local.restoreArchive(
      vendorArchive(1, [
        made(`${vK}.setting`, first.app, await grantOf(first.app)),
        made(`${vK}.other`, second.app, await grantOf(second.app)),
      ]),
    );
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(await holder(vK)).toBeNull();
    for (const app of [first, second]) {
      const error = forbidden(
        await answer(app.token, "/types", {
          method: "POST",
          body: {
            id: `${vK}.more`,
            version: 1,
            fields: { title: { type: "string" } },
          },
        }),
      );
      expect(error.details?.namespace).toBe(vK);
    }

    const given = await answer(server.managementKey, `/app-vendors/${vK}`, {
      method: "PUT",
      body: { client_id: first.app.clientId },
    });
    expect(given.status, JSON.stringify(given.body)).toBe(200);
    expect(await registerType(first.token, `${vK}.more`)).toBe(201);
  });
});

describe("vendors in an archive", () => {
  it("carries each vendor binding to a credential that reads the vendor, and none to one that does not", async () => {
    const vD = freshVendor();
    const maker = await signedIn(REGISTERS);
    const other = await signedIn(REGISTERS);
    expect(await registerType(maker.token, `${vD}.setting`)).toBe(201);

    const exported = async (credential: string) => {
      const response = await call(credential, "/export?format=archive");
      expect(response.status).toBe(200);
      const archive = new Uint8Array(await response.arrayBuffer());
      return archiveLines<{
        app_vendor?: { vendor: string; client_id: string };
      }>(archive, "instance")
        .flatMap((line) => (line.app_vendor ? [line.app_vendor] : []))
        .filter((line) => line.vendor === vD);
    };
    expect(await exported(server.workingKey)).toEqual([
      expect.objectContaining({
        vendor: vD,
        client_id: maker.app.clientId,
      }),
    ]);
    expect(await exported(maker.token)).toHaveLength(1);
    expect(await exported(other.token)).toEqual([]);
    const named = await signedIn(`core.note:read ${vD}.setting:read`);
    expect(await exported(named.token)).toHaveLength(1);
  });

  it("restores a binding for a vendor no app holds, and skips one for a vendor an app holds", async () => {
    const vE = freshVendor();
    const holderApp = await signedIn(REGISTERS);
    const archive = vendorArchive(2, [
      typeLine(`${vE}.setting`, null),
      {
        app_vendor: {
          vendor: vE,
          client_id: holderApp.app.clientId,
          claimed_at: "2026-11-01T00:00:00.000Z",
        },
      },
    ]);
    const restored = await local.restoreArchive(archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.app_vendors_added).toBe(1);
    expect(restored.data.app_vendors_skipped).toBe(0);
    expect(await holder(vE)).toBe(holderApp.app.clientId);
    const item = await createItem(holderApp.token, `${vE}.setting`, "restored");
    expect(await reads(holderApp.token, item)).toBe(true);

    const again = await local.restoreArchive(
      vendorArchive(2, [
        {
          app_vendor: {
            vendor: vE,
            client_id: randomUUID(),
            claimed_at: "2026-11-02T00:00:00.000Z",
          },
        },
      ]),
    );
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data.app_vendors_added).toBe(0);
    expect(again.data.app_vendors_skipped).toBe(1);
    expect(await holder(vE)).toBe(holderApp.app.clientId);
  });

  it("refuses a version 2 manifest that mistypes app_vendor_count or miscounts the app_vendor lines, and restores one that leaves the count out", async () => {
    const counted = (vendor: string, count: unknown) => {
      const manifest = emptyManifest({
        version: 2,
        plugin_count: 0,
        app_vendor_count: count,
      });
      if (count === undefined) delete manifest.app_vendor_count;
      const line = {
        app_vendor: {
          vendor,
          client_id: null,
          claimed_at: "2026-11-01T00:00:00.000Z",
        },
      };
      return tar([
        { name: "manifest.json", body: JSON.stringify(manifest) },
        lineFile("files", ""),
        lineFile("instance", ndjson([line])),
        lineFile("items", ""),
        lineFile("versions", ""),
        lineFile("edges", ""),
        lineFile("rows", ""),
      ]);
    };
    const vC = freshVendor();
    const mistyped = await local.restoreArchive(counted(vC, "1"));
    expect(mistyped.status, JSON.stringify(mistyped.error)).toBe(400);
    expect(mistyped.error?.error.code).toBe("validation_error");
    expect(mistyped.error?.error.details?.errors).toEqual([
      expect.objectContaining({ path: "app_vendor_count" }),
    ]);
    const miscounted = await local.restoreArchive(counted(vC, 2));
    expect(miscounted.status, JSON.stringify(miscounted.error)).toBe(400);
    expect(miscounted.error?.error.code).toBe("validation_error");
    expect(miscounted.error?.error.details?.field).toBe("app_vendor_count");
    expect(await holder(vC)).toBeUndefined();

    // The witness: the same archive counting its one line restores it.
    const restored = await local.restoreArchive(counted(vC, 1));
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.app_vendors_added).toBe(1);
    expect(await holder(vC)).toBeNull();

    // Marfa 0.0.90 wrote version 2 with no app_vendor_count.
    const vU = freshVendor();
    const uncounted = await local.restoreArchive(counted(vU, undefined));
    expect(uncounted.status, JSON.stringify(uncounted.error)).toBe(200);
    expect(uncounted.data.app_vendors_added).toBe(1);
    expect(await holder(vU)).toBeNull();
  });

  it("refuses an app_vendor line whose client_id is empty or whose claimed_at is no instant", async () => {
    const vO = freshVendor();
    for (const binding of [
      { client_id: "", claimed_at: "2026-11-01T00:00:00.000Z" },
      { client_id: randomUUID(), claimed_at: "yesterday" },
      { client_id: 7, claimed_at: "2026-11-01T00:00:00.000Z" },
    ]) {
      const refused = await local.restoreArchive(
        vendorArchive(2, [{ app_vendor: { vendor: vO, ...binding } }]),
      );
      expect(refused.status, JSON.stringify(binding)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
    expect(await holder(vO)).toBeUndefined();
  });

  it("writes no vendor binding from a restore an app sends, and holds the vendors of its types for the owner", async () => {
    const vL = freshVendor();
    const app = await signedIn(`${REGISTERS} backups.manage`);
    const restorer = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: app.token,
    });
    const restored = await restorer.restoreArchive(
      vendorArchive(2, [
        typeLine(`${vL}.setting`, {
          kind: "app",
          id: await grantOf(app.app),
          name: "signed-in fixture",
        }),
        {
          app_vendor: {
            vendor: vL,
            client_id: app.app.clientId,
            claimed_at: "2026-11-01T00:00:00.000Z",
          },
        },
      ]),
    );
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.types_registered).toBe(1);
    expect(restored.data.app_vendors_added).toBe(0);
    expect(restored.data.app_vendors_skipped).toBe(1);
    expect(await holder(vL)).toBeNull();
  });

  it("restores a version 1 archive, giving a vendor no one holds to the one app that made its types", async () => {
    const vF = freshVendor();
    const maker = await signedIn(REGISTERS);
    const grant = await grantOf(maker.app);
    const restored = await local.restoreArchive(
      vendorArchive(1, [
        typeLine(`${vF}.setting`, {
          kind: "app",
          id: grant,
          name: "signed-in fixture",
        }),
      ]),
    );
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.types_registered).toBe(1);
    expect(await holder(vF)).toBe(maker.app.clientId);
    const item = await createItem(maker.token, `${vF}.setting`, "restored");
    expect(await reads(maker.token, item)).toBe(true);
  });
});

/** An owner's key the app holding `token` mints, holding `types` and `permissions`. */
async function ownerKeyBy(
  token: string,
  types: Record<string, string>,
  permissions: string[] = [],
): Promise<string> {
  const minted = await answer(token, "/keys", {
    method: "POST",
    body: {
      label: "owner's key from an app",
      source: `owner-from-app-${randomUUID().slice(0, 8)}`,
      type_permissions: types,
      permissions,
      owner_key: true,
    },
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  expect(minted.body).not.toHaveProperty("oauth_client_id");
  return minted.body.key as string;
}

/** The vendor bindings an archive export `credential` takes carries for `vendor`. */
async function exportedBindings(
  credential: string,
  vendor: string,
): Promise<Array<{ vendor: string; client_id: string | null }>> {
  const response = await call(credential, "/export?format=archive");
  expect(response.status).toBe(200);
  const archive = new Uint8Array(await response.arrayBuffer());
  return archiveLines<{
    app_vendor?: { vendor: string; client_id: string | null };
  }>(archive, "instance")
    .flatMap((line) => (line.app_vendor ? [line.app_vendor] : []))
    .filter((line) => line.vendor === vendor);
}

async function ownersKey(types: Record<string, string>): Promise<string> {
  const made = await local.createKey({
    label: "owner's reader",
    source: `owner-reader-${randomUUID().slice(0, 8)}`,
    permissions: [],
    type_permissions: types,
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  return made.data!.key;
}

describe("vendors whose types only the owner made", () => {
  const byLocal = { kind: "local", id: "local", name: "Local command" };

  it("holds for the owner a vendor whose types only the owner made, from an archive of either version, and refuses it to an app", async () => {
    const vS = freshVendor();
    const vT = freshVendor();
    for (const [version, vendor] of [
      [1, vS],
      [2, vT],
    ] as const) {
      const restored = await local.restoreArchive(
        vendorArchive(version, [typeLine(`${vendor}.setting`, byLocal)]),
      );
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      expect(restored.data.types_registered).toBe(1);
      expect(await holder(vendor), vendor).toBeNull();
    }
    const app = await signedIn(REGISTERS);
    const error = forbidden(
      await answer(app.token, "/types", {
        method: "POST",
        body: {
          id: `${vS}.more`,
          version: 1,
          fields: { title: { type: "string" } },
        },
      }),
    );
    expect(error.details?.namespace).toBe(vS);
  });

  it("holds for the owner a vendor whose first type a key no app made registers, and refuses it to an app", async () => {
    const claimed = freshVendor();
    const owned = freshVendor();
    // The witness: an app's first type under a vendor no one holds claims it.
    const app = await signedIn(REGISTERS);
    expect(await registerType(app.token, `${claimed}.setting`)).toBe(201);
    expect(await holder(claimed)).toBe(app.app.clientId);

    expect(await registerType(server.workingKey, `${owned}.setting`)).toBe(201);
    expect(await holder(owned)).toBeNull();
    const error = forbidden(
      await answer(app.token, "/types", {
        method: "POST",
        body: {
          id: `${owned}.more`,
          version: 1,
          fields: { title: { type: "string" } },
        },
      }),
    );
    expect(error.details?.namespace).toBe(owned);
  });

  it("refuses an app's restore a type under a vendor the owner or another app holds", async () => {
    const vU = freshVendor();
    const vW = freshVendor();
    const vV = freshVendor();
    const holderApp = await signedIn(REGISTERS);
    expect(await registerType(holderApp.token, `${vU}.setting`)).toBe(201);
    const app = await signedIn(`${REGISTERS} backups.manage`);
    const restorer = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: app.token,
    });
    const made = { kind: "app", id: await grantOf(app.app), name: "fixture" };
    const refusedUnder = async (vendor: string) => {
      const refused = await restorer.restoreArchive(
        vendorArchive(2, [typeLine(`${vendor}.other`, made)]),
      );
      expect(refused.status, JSON.stringify(refused.error)).toBe(403);
      expect(refused.error?.error.code).toBe("forbidden");
      expect(refused.error?.error.details?.namespace).toBe(vendor);
    };
    // The witness: a type under a vendor no one holds restores.
    const open = await restorer.restoreArchive(
      vendorArchive(2, [typeLine(`${vW}.setting`, made)]),
    );
    expect(open.status, JSON.stringify(open.error)).toBe(200);
    expect(open.data.types_registered).toBe(1);
    await refusedUnder(vU);
    expect(await holder(vU)).toBe(holderApp.app.clientId);

    const held = await local.restoreArchive(
      vendorArchive(1, [typeLine(`${vV}.setting`, byLocal)]),
    );
    expect(held.status, JSON.stringify(held.error)).toBe(200);
    expect(await holder(vV)).toBeNull();
    await refusedUnder(vV);
    expect(await holder(vV)).toBeNull();
    expect(await registerType(holderApp.token, `${vU}.other`)).toBe(201);
  });
});

describe("an owner's key an app made", () => {
  it("treats an owner's key minted through an app as the app's: refused a vendor move, and kept from other apps' data the app's grant no longer names", async () => {
    const vX = freshVendor();
    const maker = await signedIn(
      `${REGISTERS} keys.mint keys.manage grants.manage app.*:read`,
    );
    const other = await signedIn(REGISTERS);
    expect(await registerType(other.token, `${vX}.setting`)).toBe(201);
    const theirs = await createItem(other.token, `${vX}.setting`, "theirs");
    const key = await ownerKeyBy(
      maker.token,
      { "core.note": "read", "app.*": "read" },
      ["grants.manage"],
    );
    // The witness: while the grant names app.*, the key reads the other app's item.
    expect(await reads(key, theirs)).toBe(true);
    const error = forbidden(
      await answer(key, `/app-vendors/${vX}`, {
        method: "PUT",
        body: { client_id: maker.app.clientId },
      }),
    );
    expect(error.code).toBe("forbidden");
    expect(await holder(vX)).toBe(other.app.clientId);

    const grant = await grantFor(maker.app);
    const narrowed = await answer(server.managementKey, `/grants/${grant.id}`, {
      method: "PATCH",
      body: {
        expected_scopes: grant.scopes,
        scopes: grant.scopes.filter((scope) => scope !== "app.*:read"),
      },
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    expect(await reads(key, theirs)).toBe(false);
  });

  it("holds an owner's key an app made to what the app may do with its own vendor now", async () => {
    const vY = freshVendor();
    const maker = await signedIn(`${REGISTERS} keys.mint keys.manage`);
    expect(await registerType(maker.token, `${vY}.setting`)).toBe(201);
    const key = await ownerKeyBy(maker.token, { [`${vY}.*`]: "write" });
    // The witness: while the app writes, so does the key.
    const written = await createItem(key, `${vY}.setting`, "by the key");

    const grant = await grantFor(maker.app);
    const narrowed = await answer(server.managementKey, `/grants/${grant.id}`, {
      method: "PATCH",
      body: {
        expected_scopes: grant.scopes,
        scopes: grant.scopes.map((scope) =>
          scope === "content:write" ? "content:read" : scope,
        ),
      },
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    expect(await reads(key, written)).toBe(true);
    const refused = await answer(key, "/items", {
      method: "POST",
      body: { type: `${vY}.setting`, properties: { title: "again" } },
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
  });

  it("lets an owner's key an app made mint an owner's key by default and on request without keys.manage, each still the app's for vendors", async () => {
    const vendor = freshVendor();
    const maker = await signedIn(
      `${REGISTERS} keys.mint keys.manage grants.manage`,
    );
    expect(await registerType(maker.token, `${vendor}.setting`)).toBe(201);
    const parent = await ownerKeyBy(maker.token, {}, [
      "keys.mint",
      "grants.manage",
    ]);
    for (const ownerKey of [undefined, true]) {
      const minted = await answer(parent, "/keys", {
        method: "POST",
        body: {
          label: "child",
          source: `child-${randomUUID().slice(0, 8)}`,
          permissions: ["grants.manage"],
          ...(ownerKey === undefined ? {} : { owner_key: ownerKey }),
        },
      });
      expect(minted.status, JSON.stringify(minted.body)).toBe(201);
      expect(minted.body).not.toHaveProperty("oauth_client_id");
      const child = minted.body.key as string;
      // The witness: the child holds grants.manage, so it lists vendors.
      expect((await answer(child, "/app-vendors")).status).toBe(200);
      forbidden(
        await answer(child, `/app-vendors/${vendor}`, {
          method: "PUT",
          body: { client_id: maker.app.clientId },
        }),
      );
    }
    expect(await holder(vendor)).toBe(maker.app.clientId);
  });
});

describe("vendors from the owner's browser", () => {
  it("lists and moves vendors for the owner's browser session", async () => {
    const vZ = freshVendor();
    const first = await signedIn(REGISTERS);
    const second = await signedIn(REGISTERS);
    expect(await registerType(first.token, `${vZ}.setting`)).toBe(201);
    const listedByCookie = await fetch(`${server.apiUrl}/app-vendors`, {
      headers: { cookie },
    });
    const page = (await listedByCookie.json()) as {
      data: Array<{ vendor: string; client_id: string | null }>;
    };
    expect(listedByCookie.status, JSON.stringify(page)).toBe(200);
    expect(page.data).toContainEqual(
      expect.objectContaining({
        vendor: vZ,
        client_id: first.app.clientId,
      }),
    );
    const moved = await fetch(`${server.apiUrl}/app-vendors/${vZ}`, {
      method: "PUT",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ client_id: second.app.clientId }),
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await holder(vZ)).toBe(second.app.clientId);
  });
});

describe("vendor bindings an export judges", () => {
  it("decides a binding on the vendor's wildcard, never on an entry for the bare namespace", async () => {
    const vQ = freshVendor();
    const vP = freshVendor();
    const app = await signedIn(REGISTERS);
    expect(await registerType(app.token, `${vQ}.setting`)).toBe(201);
    const held = await local.restoreArchive(
      vendorArchive(2, [
        {
          app_vendor: {
            vendor: vP,
            client_id: null,
            claimed_at: "2026-11-01T00:00:00.000Z",
          },
        },
      ]),
    );
    expect(held.status, JSON.stringify(held.error)).toBe(200);
    // The witness: an entry for a type under the vendor carries its binding.
    const typed = await ownersKey({ [`${vQ}.setting`]: "read" });
    expect(await exportedBindings(typed, vQ)).toHaveLength(1);
    const bare = await ownersKey({
      "core.note": "read",
      [vQ]: "read",
    });
    expect(await exportedBindings(bare, vQ)).toEqual([]);
    const wildcard = await ownersKey({
      [`${vP}.*`]: "read",
      [vP]: "none",
    });
    expect(await exportedBindings(wildcard, vP)).toEqual([
      expect.objectContaining({ vendor: vP, client_id: null }),
    ]);
  });

  it(
    "ends an export whose credential reads no type under a vendor by the time it sends the vendor's binding",
    { retry: 0 },
    async () => {
      // retry: 0 because the test removes the type it relies on.
      const vBB = freshVendor();
      const app = await signedIn(REGISTERS);
      expect(await registerType(app.token, `${vBB}.setting`)).toBe(201);
      const key = await ownersKey({
        "core.note": "read",
        [`${vBB}.setting`]: "read",
      });
      expect(await exportedBindings(key, vBB)).toHaveLength(1);

      await server.setFault("hold:export-check=1");
      let reading: Promise<boolean> | undefined;
      try {
        const response = await call(key, "/export?format=archive");
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        reading = (async () => {
          try {
            for (;;) {
              const { done } = await reader.read();
              if (done) return false;
            }
          } catch {
            return true;
          }
        })();
        await server.waitForHold("hold:export-check");
        const removed = await local.deleteType(`${vBB}.setting`);
        expect(removed.ok, JSON.stringify(removed.error)).toBe(true);
      } finally {
        await server.clearFault("hold:export-check");
      }
      expect(await reading).toBe(true);
    },
  );
});

describe("archive times", () => {
  it("restores a claimed_at in any RFC 3339 form and keeps it as the instant", async () => {
    const vTA = freshVendor();
    const vTB = freshVendor();
    const vTC = freshVendor();
    const forms = [
      [vTA, "2026-11-01T00:00:00Z"],
      [vTB, "2026-11-01T01:00:00+01:00"],
      [vTC, "2026-11-01T00:00:00.000000Z"],
    ] as const;
    for (const [vendor, claimed_at] of forms) {
      const restored = await local.restoreArchive(
        vendorArchive(2, [
          { app_vendor: { vendor, client_id: null, claimed_at } },
        ]),
      );
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      expect(restored.data.app_vendors_added).toBe(1);
    }
    const page = await answer(server.managementKey, "/app-vendors");
    const data = page.body.data as Array<{
      vendor: string;
      claimed_at: string;
    }>;
    for (const [vendor] of forms) {
      expect(data.find((one) => one.vendor === vendor)?.claimed_at).toBe(
        "2026-11-01T00:00:00.000Z",
      );
    }
  });

  it("refuses a claimed_at inside a leap second with 400 naming the field", async () => {
    const vendor = freshVendor();
    // The witness: the second before the leap second restores.
    const before = await local.restoreArchive(
      vendorArchive(2, [
        {
          app_vendor: {
            vendor: freshVendor(),
            client_id: null,
            claimed_at: "1990-12-31T23:59:59Z",
          },
        },
      ]),
    );
    expect(before.status, JSON.stringify(before.error)).toBe(200);
    const refused = await local.restoreArchive(
      vendorArchive(2, [
        {
          app_vendor: {
            vendor,
            client_id: null,
            claimed_at: "1990-12-31T23:59:60Z",
          },
        },
      ]),
    );
    expect(refused.status, JSON.stringify(refused.error)).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.details?.field).toBe("claimed_at");
    expect(await holder(vendor)).toBeUndefined();
  });
});

// Last in the file: moving the clock ends every sign-in the tests above hold.
describe("an expired key at the vendor doors", () => {
  it("names when the key expired at both vendor doors, as GET /keys/current does", async () => {
    const hour = 60 * 60 * 1000;
    const made = await local.createKey({
      label: "expiring vendor manager",
      source: `expiring-${randomUUID().slice(0, 8)}`,
      permissions: ["grants.manage"],
      type_permissions: {},
      expires_at: new Date(
        Date.now() + server.clockOffsetMs + hour,
      ).toISOString(),
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const key = made.data!.key;
    const vendor = freshVendor();
    // The witness: before it expires, the key lists vendors.
    expect((await answer(key, "/app-vendors")).status).toBe(200);

    await server.advanceClock(2 * hour);
    const expired = { expired_at: made.data!.expires_at };
    const current = await answer(key, "/keys/current");
    expect(current.status).toBe(401);
    expect((current.body.error as { details?: unknown }).details).toEqual(
      expired,
    );
    for (const [path, init] of [
      ["/app-vendors", {}],
      [`/app-vendors/${vendor}`, { method: "PUT", body: { client_id: "x" } }],
    ] as const) {
      const got = await answer(key, path, init);
      expect(got.status, path).toBe(401);
      expect(
        (got.body.error as { code: string; details?: unknown }).code,
        path,
      ).toBe("unauthorized");
      expect((got.body.error as { details?: unknown }).details, path).toEqual(
        expired,
      );
    }
  });
});

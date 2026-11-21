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

function vendorArchive(
  version: number,
  lines: Array<Record<string, unknown>>,
): Uint8Array {
  const manifest = emptyManifest({
    version,
    type_count: lines.filter((line) => "type" in line).length,
    app_vendor_count: lines.filter((line) => "app_vendor" in line).length,
  });
  if (version === 1) delete manifest.app_vendor_count;
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

function typeLine(id: string, createdBy: unknown): Record<string, unknown> {
  return {
    type: { id, version: 1, fields: { title: { type: "string" } } },
    provenance: { origin: "user", created_by: createdBy },
  };
}

describe("an app's own types", () => {
  const vendor = "app.vendora";
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
    const writer = await signedIn(REGISTERS);
    // The witness: the same app registers under a vendor no app holds.
    expect(await registerType(writer.token, "app.vendorb.setting")).toBe(201);

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
  const vendor = "app.vendorc";
  const type = `${vendor}.setting`;
  let first: Signed;
  let second: Signed;
  let item: string;

  beforeAll(async () => {
    first = await signedIn(REGISTERS);
    second = await signedIn(REGISTERS);
    expect(await registerType(first.token, type)).toBe(201);
    item = await createItem(first.token, type, "kept for the app");
  }, FRESH_SERVER_TIMEOUT_MS);

  it("moves the vendor to the app named, which then reaches its items in place of the app that held it", async () => {
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

    for (const name of ["core.note", "app", "app.vendorc.setting"]) {
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
    expect(await holder(vendor)).toBe(second.app.clientId);
  });
});

describe("what a key an app made reaches", () => {
  it("keeps a key an app made from other apps' data once the app's grant no longer names it, and leaves it its own vendor", async () => {
    const maker = await signedIn(`${REGISTERS} keys.mint app.*:read`);
    const other = await signedIn(REGISTERS);
    expect(await registerType(maker.token, "app.vendorg.setting")).toBe(201);
    const own = await createItem(maker.token, "app.vendorg.setting", "mine");
    expect(await registerType(other.token, "app.vendorh.setting")).toBe(201);
    const theirs = await createItem(
      other.token,
      "app.vendorh.setting",
      "theirs",
    );
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
    const maker = await signedIn(`${REGISTERS} keys.mint app.*:read`);
    const other = await signedIn(REGISTERS);
    expect(await registerType(other.token, "app.vendorm.setting")).toBe(201);
    const theirs = await createItem(
      other.token,
      "app.vendorm.setting",
      "theirs",
    );
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
    const app = await signedIn("app.*:write metadata.types:write");
    expect(await registerType(app.token, "app.vendori.setting")).toBe(201);
    const item = await createItem(app.token, "app.vendori.setting", "kept");
    expect(await reads(app.token, item)).toBe(true);
  });

  it("judges a key an app made by what it reaches when used, listing and revoking it only within that reach", async () => {
    const holderApp = await signedIn(`${REGISTERS} keys.mint`);
    const plainApp = await signedIn("content:read keys.mint");
    expect(await registerType(holderApp.token, "app.vendorr.setting")).toBe(
      201,
    );
    const own = await createItem(
      holderApp.token,
      "app.vendorr.setting",
      "the app's own",
    );
    const mint = async (
      credential: string,
      types: Record<string, string>,
      permissions: string[] = [],
    ) => {
      const minted = await answer(credential, "/keys", {
        method: "POST",
        body: {
          label: "reach",
          source: `reach-${randomUUID().slice(0, 8)}`,
          type_permissions: types,
          permissions,
        },
      });
      expect(minted.status, JSON.stringify(minted.body)).toBe(201);
      return { id: minted.body.id as string, key: minted.body.key as string };
    };
    const bound = await mint(holderApp.token, { "core.note": "read" });
    const plain = await mint(plainApp.token, { "core.note": "read" });
    const made = await local.createKey({
      label: "narrow minter",
      source: `reach-${randomUUID().slice(0, 8)}`,
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "read" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const minter = { id: made.data!.id, key: made.data!.key };
    // Both app keys store the same map, but only the first reaches its app's own vendor.
    expect(await reads(bound.key, own)).toBe(true);
    expect(await reads(plain.key, own)).toBe(false);

    const page = await answer(minter.key, "/keys");
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    const ids = (page.body.data as Array<{ id: string }>).map((one) => one.id);
    expect(ids).toContain(plain.id);
    expect(ids).not.toContain(bound.id);
    const changed = await answer(minter.key, `/keys/${bound.id}`, {
      method: "PATCH",
      body: { label: "renamed" },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(404);
    expect((changed.body.error as { code: string }).code).toBe("key_not_found");
    const revoked = await answer(minter.key, `/keys/${bound.id}`, {
      method: "DELETE",
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(404);
    expect(await reads(bound.key, own)).toBe(true);
    const peer = await answer(minter.key, `/keys/${plain.id}`, {
      method: "DELETE",
    });
    expect(peer.status, JSON.stringify(peer.body)).toBe(200);
  });

  it("keeps the own-vendor wildcard a key an app made asks for", async () => {
    const app = await signedIn(`${REGISTERS} keys.mint`);
    expect(await registerType(app.token, "app.vendorj.setting")).toBe(201);
    const key = await appKey(app.token, { "app.vendorj.*": "write" });
    const item = await createItem(key, "app.vendorj.setting", "by the key");
    expect(await reads(key, item)).toBe(true);
  });
});

describe("vendors only the owner gives", () => {
  it("refuses to give a vendor to an app's sign-in or a key an app made, whatever it holds", async () => {
    const app = await signedIn("grants.manage keys.mint");
    const key = await appKey(app.token, {}, ["grants.manage"]);
    for (const credential of [app.token, key]) {
      // The witness: the credential holds grants.manage, so it lists vendors.
      expect((await answer(credential, "/app-vendors")).status).toBe(200);
      const error = forbidden(
        await answer(credential, "/app-vendors/app.vendorn", {
          method: "PUT",
          body: { client_id: app.app.clientId },
        }),
      );
      expect(error.code).toBe("forbidden");
    }
    expect(await holder("app.vendorn")).toBeUndefined();
  });

  it("holds a vendor two apps made types under for the owner, refuses it to either app, and gives it to the app the owner names", async () => {
    const first = await signedIn(REGISTERS);
    const second = await signedIn(REGISTERS);
    const made = (id: string, app: App, grant: string) =>
      typeLine(id, { kind: "app", id: grant, name: app.clientId });
    const restored = await local.restoreArchive(
      vendorArchive(1, [
        made("app.vendork.setting", first.app, await grantOf(first.app)),
        made("app.vendork.other", second.app, await grantOf(second.app)),
      ]),
    );
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(await holder("app.vendork")).toBeNull();
    for (const app of [first, second]) {
      const error = forbidden(
        await answer(app.token, "/types", {
          method: "POST",
          body: {
            id: "app.vendork.more",
            version: 1,
            fields: { title: { type: "string" } },
          },
        }),
      );
      expect(error.details?.namespace).toBe("app.vendork");
    }

    const given = await answer(
      server.managementKey,
      "/app-vendors/app.vendork",
      {
        method: "PUT",
        body: { client_id: first.app.clientId },
      },
    );
    expect(given.status, JSON.stringify(given.body)).toBe(200);
    expect(await registerType(first.token, "app.vendork.more")).toBe(201);
  });
});

describe("vendors in an archive", () => {
  it("carries each vendor binding to a credential that reads the vendor, and none to one that does not", async () => {
    const maker = await signedIn(REGISTERS);
    const other = await signedIn(REGISTERS);
    expect(await registerType(maker.token, "app.vendord.setting")).toBe(201);

    const exported = async (credential: string) => {
      const response = await call(credential, "/export?format=archive");
      expect(response.status).toBe(200);
      const archive = new Uint8Array(await response.arrayBuffer());
      return archiveLines<{
        app_vendor?: { vendor: string; client_id: string };
      }>(archive, "instance")
        .flatMap((line) => (line.app_vendor ? [line.app_vendor] : []))
        .filter((line) => line.vendor === "app.vendord");
    };
    expect(await exported(server.workingKey)).toEqual([
      expect.objectContaining({
        vendor: "app.vendord",
        client_id: maker.app.clientId,
      }),
    ]);
    expect(await exported(maker.token)).toHaveLength(1);
    expect(await exported(other.token)).toEqual([]);
    const named = await signedIn("core.note:read app.vendord.setting:read");
    expect(await exported(named.token)).toHaveLength(1);
  });

  it("restores a binding for a vendor no app holds, and skips one for a vendor an app holds", async () => {
    const holderApp = await signedIn(REGISTERS);
    const archive = vendorArchive(2, [
      typeLine("app.vendore.setting", null),
      {
        app_vendor: {
          vendor: "app.vendore",
          client_id: holderApp.app.clientId,
          claimed_at: "2026-11-01T00:00:00.000Z",
        },
      },
    ]);
    const restored = await local.restoreArchive(archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.app_vendors_added).toBe(1);
    expect(restored.data.app_vendors_skipped).toBe(0);
    expect(await holder("app.vendore")).toBe(holderApp.app.clientId);
    const item = await createItem(
      holderApp.token,
      "app.vendore.setting",
      "restored",
    );
    expect(await reads(holderApp.token, item)).toBe(true);

    const again = await local.restoreArchive(
      vendorArchive(2, [
        {
          app_vendor: {
            vendor: "app.vendore",
            client_id: randomUUID(),
            claimed_at: "2026-11-02T00:00:00.000Z",
          },
        },
      ]),
    );
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data.app_vendors_added).toBe(0);
    expect(again.data.app_vendors_skipped).toBe(1);
    expect(await holder("app.vendore")).toBe(holderApp.app.clientId);
  });

  it("refuses an app_vendor line whose client_id is empty or whose claimed_at is no instant", async () => {
    for (const binding of [
      { client_id: "", claimed_at: "2026-11-01T00:00:00.000Z" },
      { client_id: randomUUID(), claimed_at: "yesterday" },
      { client_id: 7, claimed_at: "2026-11-01T00:00:00.000Z" },
    ]) {
      const refused = await local.restoreArchive(
        vendorArchive(2, [
          { app_vendor: { vendor: "app.vendoro", ...binding } },
        ]),
      );
      expect(refused.status, JSON.stringify(binding)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
    expect(await holder("app.vendoro")).toBeUndefined();
  });

  it("writes no vendor binding from a restore an app sends, and holds the vendors of its types for the owner", async () => {
    const app = await signedIn(`${REGISTERS} backups.manage`);
    const restorer = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: app.token,
    });
    const restored = await restorer.restoreArchive(
      vendorArchive(2, [
        typeLine("app.vendorl.setting", {
          kind: "app",
          id: await grantOf(app.app),
          name: "signed-in fixture",
        }),
        {
          app_vendor: {
            vendor: "app.vendorl",
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
    expect(await holder("app.vendorl")).toBeNull();
  });

  it("restores a version 1 archive, giving a vendor no one holds to the one app that made its types", async () => {
    const maker = await signedIn(REGISTERS);
    const grant = await grantOf(maker.app);
    const restored = await local.restoreArchive(
      vendorArchive(1, [
        typeLine("app.vendorf.setting", {
          kind: "app",
          id: grant,
          name: "signed-in fixture",
        }),
      ]),
    );
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.types_registered).toBe(1);
    expect(await holder("app.vendorf")).toBe(maker.app.clientId);
    const item = await createItem(
      maker.token,
      "app.vendorf.setting",
      "restored",
    );
    expect(await reads(maker.token, item)).toBe(true);
  });
});

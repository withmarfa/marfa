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
  const data = (got.body.data ?? []) as Array<{ id?: string; item?: { id: string } }>;
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

async function grantOf(app: App): Promise<string> {
  const grants = await answer(server.managementKey, "/grants");
  expect(grants.status).toBe(200);
  const data = grants.body.data as Array<{ id: string; client_id: string }>;
  const grant = data.find((one) => one.client_id === app.clientId);
  expect(grant, app.clientId).toBeDefined();
  return grant!.id;
}

async function holder(vendor: string): Promise<string | undefined> {
  const page = await answer(server.managementKey, "/app-vendors");
  expect(page.status, JSON.stringify(page.body)).toBe(200);
  const data = page.body.data as Array<{ vendor: string; client_id: string }>;
  return data.find((one) => one.vendor === vendor)?.client_id;
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
    expect((await answer(server.workingKey, `/types/${vendor}.other`)).status).toBe(404);
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
    const unknown = await answer(server.managementKey, `/app-vendors/${vendor}`, {
      method: "PUT",
      body: { client_id: randomUUID() },
    });
    expect(unknown.status).toBe(404);
    expect((unknown.body.error as { code: string }).code).toBe("not_found");

    for (const name of ["core.note", "app", "app.vendorc.setting"]) {
      const refused = await answer(server.managementKey, `/app-vendors/${name}`, {
        method: "PUT",
        body: { client_id: second.app.clientId },
      });
      expect(refused.status, name).toBe(400);
      expect((refused.body.error as { code: string }).code, name).toBe(
        "validation_error",
      );
    }
    const missing = await answer(server.managementKey, `/app-vendors/${vendor}`, {
      method: "PUT",
      body: {},
    });
    expect(missing.status).toBe(400);
    expect((missing.body.error as { code: string }).code).toBe(
      "missing_required_field",
    );
    expect(await holder(vendor)).toBe(second.app.clientId);
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
      return archiveLines<{ app_vendor?: { vendor: string; client_id: string } }>(
        archive,
        "instance",
      )
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
    const item = await createItem(holderApp.token, "app.vendore.setting", "restored");
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

  it("restores a version 1 archive, giving each vendor no app holds to the app that made its first type", async () => {
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
    const item = await createItem(maker.token, "app.vendorf.setting", "restored");
    expect(await reads(maker.token, item)).toBe(true);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  getOperatorClient,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { expectMatchesSchema, servedDocument } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let ownKeyId: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "key-management",
  ));
  // The context tracks the file's own key first, and that row is the creator
  // every mint in this file inherits from.
  ownKeyId = ctx.trackedKeys[0]!;
});

afterAll(async () => {
  await cleanup(ctx);
});

/**
 * Create a key holding no permissions and return a client using it.
 */
async function createClientWithoutPermissions(
  label: string,
  typePermissions: Record<string, string> = { "*": "write" },
): Promise<{ client: MarfaClient; keyId: string; key: string }> {
  const keyResp = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions: typePermissions,
    permissions: [],
  });
  expect(keyResp.ok).toBe(true);
  trackKey(ctx, keyResp.data.id);

  return {
    client: new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    }),
    keyId: keyResp.data.id,
    key: keyResp.data.key,
  };
}

/**
 * The status `GET /events` answers, without reading its body.
 *
 * A stream that opens stays open, so a caller that awaits the body of a
 * successful subscription waits for ever. Abort once the headers are in.
 */
async function openStreamStatus(bearer: string): Promise<number> {
  const control = new AbortController();
  try {
    const res = await fetch(`${apiUrl}/events`, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "text/event-stream",
      },
      signal: control.signal,
    });
    return res.status;
  } finally {
    control.abort();
  }
}

describe("key management", () => {
  it("lists keys and includes a newly created key", async () => {
    const label = `km-list-${ctx.runId}`;
    const keyResp = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      type_permissions: { "*": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    await expectMatchesSchema("POST", "/keys", 201, keyResp.data);

    const list = await client.listKeys();
    expect(list.ok).toBe(true);
    await expectMatchesSchema("GET", "/keys", 200, list.data);

    const found = list.data.data.find((k) => k.id === keyResp.data.id);
    expect(found).toBeDefined();
    expect(found!.label).toBe(label);
  });

  it("list keys requires keys.mint", async () => {
    const { client: memberClient } =
      await createClientWithoutPermissions("km-list-nonadmin");

    const list = await memberClient.listKeys();
    expect(list.status).toBe(403);
    expect(list.error?.error.code).toBe("forbidden");
    expect(list.error?.error.details?.required_scope).toBe("keys.mint");
  });

  it("revoke key: create, use, revoke, retry fails with 401", async () => {
    const keyResp = await client.createKey({
      label: "km-revoke-test",
      source: `${ctx.source}-${"km-revoke-test"}`,
      type_permissions: { "*": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const before = await scopedClient.listItems({ limit: 1 });
    expect(before.ok).toBe(true);

    const revoke = await client.revokeKey(keyResp.data.id);
    expect(revoke.ok).toBe(true);
    await expectMatchesSchema("DELETE", "/keys/{id}", 200, revoke.data);

    const after = await scopedClient.listItems({ limit: 1 });
    expect(after.status).toBe(401);
    expect(after.error?.error.code).toBe("unauthorized");
  });

  it("revoke key requires keys.mint", async () => {
    const targetKey = await client.createKey({
      label: "km-revoke-target",
      source: `${ctx.source}-${"km-revoke-target"}`,
      type_permissions: { "*": "read" },
    });
    expect(targetKey.ok).toBe(true);
    trackKey(ctx, targetKey.data.id);

    const { client: memberClient } =
      await createClientWithoutPermissions("km-revoke-nonadmin");

    const revoke = await memberClient.revokeKey(targetKey.data.id);
    expect(revoke.status).toBe(403);
    expect(revoke.error?.error.code).toBe("forbidden");
    expect(revoke.error?.error.details?.required_scope).toBe("keys.mint");
  });

  it("key creation response includes expected fields", async () => {
    const keyResp = await client.createKey({
      label: "km-shape-test",
      source: `${ctx.source}-${"km-shape-test"}`,
      type_permissions: { "core.note": "write", "core.bookmark": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const data = keyResp.data;
    expect(typeof data.id).toBe("string");
    expect(typeof data.key).toBe("string");
    expect(data.key.length).toBeGreaterThan(0);
    expect(data.label).toBe("km-shape-test");
    expect(Array.isArray(data.permissions)).toBe(true);
    expect(typeof data.created_at).toBe("string");
    expect(data.type_permissions["core.note"]).toBe("write");
    expect(data.type_permissions["core.bookmark"]).toBe("read");
  });

  it("key secret is not included in list response", async () => {
    const keyResp = await client.createKey({
      label: "km-secret-hidden",
      source: `${ctx.source}-${"km-secret-hidden"}`,
      type_permissions: { "*": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    expect(keyResp.data.key).toBeDefined();

    const list = await client.listKeys();
    expect(list.ok).toBe(true);

    const found = list.data.data.find((k) => k.id === keyResp.data.id);
    expect(found).toBeDefined();
    expect(found!.key).toBeUndefined();
  });

  it("minting requires keys.mint", async () => {
    const { client: memberClient } =
      await createClientWithoutPermissions("km-mint-nonadmin");

    const label = `km-mint-denied-${ctx.runId}`;
    const minted = await memberClient.createKey({
      label,
      source: `${ctx.source}-${label}`,
    });
    expect(minted.ok).toBe(false);
    expect(minted.status).toBe(403);
    expect(minted.error?.error.code).toBe("forbidden");
    expect(minted.error?.error.details?.required_scope).toBe("keys.mint");
  });

  it("a mint naming no permissions, maps or claims takes the creator's whole set", async () => {
    const label = `km-inherit-${ctx.runId}`;
    const minted = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);

    const list = await client.listKeys();
    expect(list.ok).toBe(true);
    const rows = list.data.data;

    const creator = rows.find((k) => k.id === ownKeyId);
    expect(creator).toBeDefined();
    const child = rows.find((k) => k.id === minted.data.id);
    expect(child).toBeDefined();

    // Two absent maps compare equal, so the creator's are pinned as populated
    // before the child is compared to them.
    expect(creator!.permissions?.length).toBeGreaterThan(0);
    for (const map of [
      creator!.type_permissions,
      creator!.edge_permissions,
      creator!.extension_permissions,
      creator!.metadata_permissions,
      creator!.profile_permissions,
    ]) {
      expect(Object.keys(map ?? {}).length).toBeGreaterThan(0);
    }

    expect([...(child!.permissions ?? [])].sort()).toEqual(
      [...(creator!.permissions ?? [])].sort(),
    );
    expect(child!.type_permissions).toEqual(creator!.type_permissions);
    expect(child!.edge_permissions).toEqual(creator!.edge_permissions);
    expect(child!.extension_permissions).toEqual(
      creator!.extension_permissions,
    );
    expect(child!.metadata_permissions).toEqual(creator!.metadata_permissions);
    expect(child!.profile_permissions).toEqual(creator!.profile_permissions);
  });

  it("a key holding no permission reads itself, and no other key", async () => {
    const label = `km-self-${ctx.runId}`;
    const minted = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      type_permissions: { "core.note": "write" },
      permissions: [],
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    const self = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });

    const current = await self.getCurrentKey();
    expect(current.ok).toBe(true);
    await expectMatchesSchema("GET", "/keys/current", 200, current.data);
    expect(current.data.id).toBe(minted.data.id);
    expect(current.data.source).toBe(`${ctx.source}-${label}`);
    expect(current.data.permissions).toEqual([]);
    expect(current.data.type_permissions).toEqual({ "core.note": "write" });
    expect(current.data).not.toHaveProperty("key");

    // The witness that it reads itself by this door alone.
    const listed = await self.listKeys();
    expect(listed.status).toBe(403);

    const bare = await fetch(`${apiUrl}/keys/current`);
    expect(bare.status).toBe(401);
  });

  it("every key answer carries its permissions and its maps, empty where it holds nothing", async () => {
    // The fields every key answer sends, held where nothing is held: the key
    // below holds no permission, claims no source and names no map but its
    // type map, so each of these is empty, which is the answer a client could
    // otherwise mistake for an absent field.
    const filled = [
      "sources",
      "permissions",
      "extension_permissions",
      "edge_permissions",
      "metadata_permissions",
      "profile_permissions",
    ];
    const label = `km-filled-${ctx.runId}`;
    const minted = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      type_permissions: { "core.note": "read" },
      permissions: [],
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    const self = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });

    const listed = await client.listKeys();
    expect(listed.ok).toBe(true);
    const row = listed.data.data.find((k) => k.id === minted.data.id);
    expect(row).toBeDefined();
    const current = await self.getCurrentKey();
    expect(current.ok).toBe(true);
    const updated = await client.updateKey(minted.data.id, {
      label: `${label}-renamed`,
    });
    expect(updated.ok).toBe(true);

    const answers: [string, Record<string, unknown>][] = [
      ["POST /keys", minted.data as unknown as Record<string, unknown>],
      ["GET /keys", row as unknown as Record<string, unknown>],
      ["GET /keys/current", current.data as unknown as Record<string, unknown>],
      ["PATCH /keys/{id}", updated.data as unknown as Record<string, unknown>],
    ];
    for (const [door, body] of answers) {
      for (const field of filled) {
        expect(body, `${door} left out \`${field}\``).toHaveProperty(field);
      }
      expect(body.permissions, door).toEqual([]);
      expect(body.sources, door).toEqual([]);
      expect(body.edge_permissions, door).toEqual({});
    }
    // A stored key is answered with its expiry, null on every key a door
    // mints; the mint itself declares none.
    for (const [door, body] of answers.slice(1)) {
      expect(body, `${door} left out \`expires_at\``).toHaveProperty(
        "expires_at",
      );
      expect(body.expires_at, door).toBeNull();
    }

    // The document says so too, so a generated client types none of these
    // as one that may be missing.
    const schemas = (await servedDocument()).components?.schemas as
      Record<string, { required?: string[] }> | undefined;
    expect(schemas?.KeyResponse?.required).toEqual(
      expect.arrayContaining(filled),
    );
    expect(schemas?.ApiKey?.required).toEqual(
      expect.arrayContaining([...filled, "expires_at"]),
    );
  });

  it("a mint naming a map holds no permission it did not name", async () => {
    // The witness is the case above: the same creator's mint naming nothing
    // takes every permission it holds, so an empty list here is the map
    // narrowing the key rather than a creator holding none.
    const label = `km-mapped-${ctx.runId}`;
    const minted = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      type_permissions: { "core.note": "write" },
      metadata_permissions: { types: "write" },
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);

    const list = await client.listKeys();
    expect(list.ok).toBe(true);
    const creator = list.data.data.find((k) => k.id === ownKeyId);
    expect(creator!.permissions?.length).toBeGreaterThan(0);
    const child = list.data.data.find((k) => k.id === minted.data.id);
    expect(child!.type_permissions).toEqual({ "core.note": "write" });
    expect(child!.metadata_permissions).toEqual({ types: "write" });
    expect(
      child!.permissions ?? [],
      "a key minted for one type took its creator's permissions, keys.mint and items.purge among them",
    ).toEqual([]);
  });

  it("a mint naming only permissions holds those permissions and no reach", async () => {
    const label = `km-perms-only-${ctx.runId}`;
    const witness = await client.createItem({
      type: "core.note",
      properties: { title: "permissions-only witness", body: "a" },
    });
    expect(witness.ok).toBe(true);
    trackItem(ctx, witness.data.item.id);

    // The witness is the creator, which holds every permission and every map,
    // so a key that copied from it would not be empty.
    const creator = (await client.listKeys()).data.data.find(
      (k) => k.id === ownKeyId,
    );
    expect(creator!.permissions).toContain("audit.read");
    expect(Object.keys(creator!.type_permissions ?? {}).length).toBeGreaterThan(
      0,
    );

    for (const [who, tag, minter] of [
      ["a working key", "working", client],
      ["the operator key", "operator", getOperatorClient()],
    ] as const) {
      const minted = await minter.createKey({
        label: `${label}-${tag}`,
        source: `${ctx.source}-${label}-${tag}`,
        permissions: ["audit.read"],
      });
      expect(minted.ok, who).toBe(true);
      trackKey(ctx, minted.data.id);
      expect(minted.data.permissions, who).toEqual(["audit.read"]);
      expect(minted.data.sources, who).toEqual([]);
      for (const map of [
        minted.data.type_permissions,
        minted.data.edge_permissions,
        minted.data.extension_permissions,
        minted.data.metadata_permissions,
        minted.data.profile_permissions,
      ]) {
        expect(map, who).toEqual({});
      }

      const holder = new MarfaClient({
        baseUrl: apiUrl,
        apiKey: minted.data.key,
      });
      const audit = await holder.listAudit({ limit: 1 });
      expect(audit.status, `${who}: the permission it named`).toBe(200);

      const write = await holder.createItem({
        type: "core.note",
        properties: { title: "refused", body: "a" },
      });
      expect(write.status, `${who}: an item write`).toBe(403);
      const read = await holder.getItem(witness.data.item.id);
      expect(read.status, `${who}: an item read`).toBe(403);
      const register = await holder.registerType({
        id: `user.km-perms-only-${ctx.runId}`,
        fields: { title: { type: "string", required: true } },
      });
      expect(register.status, `${who}: a type registration`).toBe(403);
    }

    // The same writes by a key that holds the reach, so the refusals above
    // are the lack of it and not a door that refuses everyone.
    const registered = await client.registerType({
      id: `user.km-perms-only-${ctx.runId}`,
      fields: { title: { type: "string", required: true } },
    });
    expect(registered.ok).toBe(true);
  });

  it("a mint naming permissions and one map holds exactly those", async () => {
    const label = `km-perms-map-${ctx.runId}`;
    const minted = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      permissions: ["audit.read"],
      type_permissions: { "core.note": "read" },
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    expect(minted.data.permissions).toEqual(["audit.read"]);
    expect(minted.data.type_permissions).toEqual({ "core.note": "read" });
    expect(minted.data.edge_permissions).toEqual({});
    expect(minted.data.extension_permissions).toEqual({});
    expect(minted.data.metadata_permissions).toEqual({});
    expect(minted.data.profile_permissions).toEqual({});
    expect(minted.data.sources).toEqual([]);
  });

  it("refuses a mint reaching past what the caller holds", async () => {
    const label = `km-narrow-caller-${ctx.runId}`;
    const callerKey = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      permissions: ["keys.mint"],
      type_permissions: { "core.bookmark": "read" },
    });
    expect(callerKey.ok).toBe(true);
    trackKey(ctx, callerKey.data.id);
    const caller = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: callerKey.data.key,
    });

    const widerTypes = await caller.createKey({
      label: `${label}-wider-types`,
      source: `${ctx.source}-${label}-wider-types`,
      type_permissions: { "*": "write" },
    });
    expect(widerTypes.ok).toBe(false);
    expect(widerTypes.status).toBe(403);
    expect(widerTypes.error?.error.code).toBe("forbidden");
    expect(widerTypes.error?.error.details?.required_scope).toBe("*:write");

    const widerPermission = await caller.createKey({
      label: `${label}-wider-permission`,
      source: `${ctx.source}-${label}-wider-permission`,
      permissions: ["schema.write"],
    });
    expect(widerPermission.ok).toBe(false);
    expect(widerPermission.status).toBe(403);
    expect(widerPermission.error?.error.code).toBe("forbidden");
    expect(widerPermission.error?.error.details?.required_scope).toBe(
      "schema.write",
    );
  });

  it("refuses a second key naming as its own a source already in use", async () => {
    const label = `km-source-taken-${ctx.runId}`;
    const source = `${ctx.source}-${label}`;
    const first = await client.createKey({ label, source });
    expect(first.ok).toBe(true);
    trackKey(ctx, first.data.id);

    const second = await client.createKey({ label: `${label}-2`, source });
    expect(second.ok).toBe(false);
    expect(second.status).toBe(409);
    expect(second.error?.error.code).toBe("conflict");
    expect(second.error?.error.details?.source).toBe(source);
  });

  it("answers mints racing for one source with one 201 and 409 conflict for the rest", async () => {
    const label = `km-source-race-${ctx.runId}`;
    const source = `${ctx.source}-${label}`;
    const answers = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        client.createKey({ label: `${label}-${String(i)}`, source }),
      ),
    );
    for (const answer of answers) {
      if (answer.ok) trackKey(ctx, answer.data.id);
    }
    expect(answers.map((a) => a.status).sort()).toEqual([201, 409, 409, 409]);
    for (const refused of answers.filter((a) => !a.ok)) {
      expect(refused.error?.error.code).toBe("conflict");
      expect(refused.error?.error.details?.source).toBe(source);
    }
  });

  it("refuses a key that may not use a door 403 before it reads the request", async () => {
    const { key } = await createClientWithoutPermissions(
      `km-standing-${ctx.runId}`,
    );
    // Each door asks the same of every caller: the operator key, or one
    // permission. The request is one no validator would take, so a 400
    // would be the body being read first.
    const doors: [string, string][] = [
      ["POST", "/owner"],
      ["GET", "/metrics"],
      ["GET", "/background-jobs"],
      ["POST", "/restore"],
      ["DELETE", "/platform-types/not%20a%20type"],
      ["DELETE", "/blobs/not-a-hash/locations/not-a-store"],
      ["POST", "/webhooks"],
      ["PATCH", "/webhooks/not%20an%20id"],
      ["PUT", "/config"],
      ["GET", "/audit?limit=not-a-number"],
      ["POST", "/keys"],
      ["PATCH", "/keys/not%20an%20id"],
      ["POST", "/items/not%20an%20id/purge?version=not-a-number"],
      ["POST", "/types"],
      ["PUT", "/types/not%20a%20type"],
      ["DELETE", "/types/not%20a%20type"],
      ["POST", "/edge-types"],
      ["DELETE", "/edge-types/not%20an%20edge%20type"],
    ];
    // Registering a connector takes a working key of its own, so the
    // operator key is the credential that door refuses.
    const operatorKey = process.env.MARFA_OPERATOR_KEY;
    expect(operatorKey).toBeTruthy();
    const refusing = (path: string) =>
      path === "/connectors" ? operatorKey! : key;
    doors.push(["POST", "/connectors"]);
    const wrong: string[] = [];
    for (const [method, path] of doors) {
      const response = await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${refusing(path)}`,
          "Content-Type": "application/json",
        },
        body:
          method === "GET" || method === "DELETE" ? undefined : "{ not json",
      });
      const body = (await response.json()) as { error?: { code?: string } };
      if (response.status !== 403 || body.error?.code !== "forbidden") {
        wrong.push(`${method} ${path} answered ${String(response.status)}`);
      }
    }
    expect(wrong).toEqual([]);

    // A key reaching no type is refused the data plane, the folder writes and
    // the blob doors before its request is read, as a key without a
    // permission is refused the doors above.
    const { key: reachesNothing } = await createClientWithoutPermissions(
      `km-standing-none-${ctx.runId}`,
      {},
    );
    const typeDoors: [string, string][] = [
      ["GET", "/items?limit=not-a-number"],
      ["POST", "/items"],
      ["GET", "/search"],
      ["POST", "/edges/bulk"],
      ["POST", "/folders"],
      ["GET", "/blobs/not-a-hash"],
      ["POST", "/blobs"],
    ];
    const notRefused: string[] = [];
    for (const [method, path] of typeDoors) {
      const response = await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${reachesNothing}`,
          "Content-Type": "application/json",
        },
        body: method === "GET" ? undefined : "{ not json",
      });
      const body = (await response.json()) as { error?: { code?: string } };
      if (
        response.status !== 403 ||
        body.error?.code !== "type_not_permitted"
      ) {
        notRefused.push(
          `${method} ${path} answered ${String(response.status)}`,
        );
      }
    }
    expect(notRefused).toEqual([]);
  });

  it("the operator key is refused the data plane, reading as well as writing", async () => {
    const operator = getOperatorClient();

    // A row the file's own key can see, so `POST /items/bulk-get` names
    // something real: an empty answer there has to be the refusal and not
    // an id that resolves nothing.
    const seeded = await client.createItem({
      type: "core.note",
      properties: { title: "operator-canary", body: "operator canary" },
    });
    expect(seeded.ok).toBe(true);
    trackItem(ctx, seeded.data.item.id);
    const seededId = seeded.data.item.id;

    // An empty `200` on a listing would say "there is nothing here", and
    // there is a great deal here; what is true is that this credential may
    // not see it. The single-row doors refuse `type_not_permitted` through
    // the same map, so the listings refuse it too, and one question gets one
    // answer however many rows were asked for.
    const refused = [
      ["GET /items", await operator.listItems({ limit: 5 })],
      ["GET /items/stats", await operator.itemStats()],
      ["GET /search", await operator.search("a")],
      ["GET /metadata/tags", await operator.listTags()],
      ["GET /export", await operator.exportItems({ type: "core.note" })],
      [
        "GET /occurrences",
        await operator.listOccurrences({
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-12-31T00:00:00.000Z",
        }),
      ],
      [
        "GET /events",
        await operator.rawRequest("/events", {
          headers: { Accept: "text/event-stream" },
        }),
      ],
      ["GET /edges", await operator.rawRequest("/edges?limit=5")],
      [
        "POST /items/bulk-get",
        await operator.rawRequest("/items/bulk-get", {
          method: "POST",
          body: JSON.stringify({ ids: [seededId] }),
          headers: { "Content-Type": "application/json" },
        }),
      ],
    ] as const;
    for (const [door, answer] of refused) {
      expect(answer.ok, `${door} was not refused`).toBe(false);
      expect(answer.status, `${door} answered ${String(answer.status)}`).toBe(
        403,
      );
      expect(answer.error?.error.code).toBe("type_not_permitted");
    }

    const written = await operator.createItem({
      type: "core.note",
      properties: { title: "operator", body: "operator body" },
    });
    expect(written.ok).toBe(false);
    expect(written.status).toBe(403);
    expect(written.error?.error.code).toBe("type_not_permitted");

    // The witness. A key that reaches one type reads every one of those
    // doors, so what closed is this credential's reach and not the doors.
    const { client: reader, key: readerKey } =
      await createClientWithoutPermissions(`km-operator-witness-${ctx.runId}`, {
        "core.note": "read",
      });
    const served = [
      ["GET /items", await reader.listItems({ limit: 5 })],
      ["GET /items/stats", await reader.itemStats()],
      ["GET /search", await reader.search("a")],
      ["GET /metadata/tags", await reader.listTags()],
      ["GET /export", await reader.exportItems({ type: "core.note" })],
      [
        "GET /occurrences",
        await reader.listOccurrences({
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-12-31T00:00:00.000Z",
        }),
      ],
      ["GET /edges", await reader.rawRequest("/edges?limit=5")],
      [
        "POST /items/bulk-get",
        await reader.rawRequest("/items/bulk-get", {
          method: "POST",
          body: JSON.stringify({ ids: [seededId] }),
          headers: { "Content-Type": "application/json" },
        }),
      ],
    ] as const;
    for (const [door, answer] of served) {
      expect(answer.ok, `${door} was refused a key that reaches a type`).toBe(
        true,
      );
      expect(answer.status).toBe(200);
    }

    // `GET /events` by hand, because a stream that opens stays open and
    // awaiting its body would never return. The status off the headers is
    // the whole question a permission fixture asks of this door: whether
    // the refusal above was this credential's reach or the door closing
    // for everyone.
    expect(
      await openStreamStatus(readerKey),
      "GET /events refused a key that reaches a type",
    ).toBe(200);
  });

  it("refuses a bulk action to a key reaching no type, and narrows one for a key writing none", async () => {
    // A key reaching no type at all, the operator key among them, is refused
    // the bulk action as it is every other door of the data plane: a dry run
    // answering it `200` with nothing matched said "there is nothing here",
    // which is not what happened.
    const operator = getOperatorClient();
    const dryRunBody = JSON.stringify({
      action: "transition",
      filter: { type: "core.note" },
      state: "archived",
      dry_run: true,
    });
    const refused = await operator.rawRequest<{ matched: number }>(
      "/items/bulk-actions",
      {
        method: "POST",
        body: dryRunBody,
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(refused.status).toBe(403);

    // A key that reads every type and writes none still has the action
    // narrowed to what it may write, which is nothing, rather than refused.
    const { client: reader } = await createClientWithoutPermissions(
      `km-bulk-reader-${ctx.runId}`,
      { "*": "read" },
    );
    const narrowed = await reader.rawRequest<{ matched: number }>(
      "/items/bulk-actions",
      {
        method: "POST",
        body: dryRunBody,
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(narrowed.status).toBe(200);
    expect(narrowed.data.matched).toBe(0);
  });

  it("the operator key mints past its own reach, which is how a run is provisioned", async () => {
    const operator = getOperatorClient();
    const label = `km-operator-mint-${ctx.runId}`;

    const minted = await operator.createKey({
      label,
      source: `${ctx.source}-${label}`,
    });
    expect(minted.ok).toBe(true);
    try {
      // The widening rule holds for a working key and not for this one: the
      // operator holds no content families and no permissions, and the
      // key it mints naming nothing holds every one of them.
      expect(minted.data.is_operator).toBe(false);
      expect(minted.data.type_permissions).toEqual({ "*": "write" });
      expect(minted.data.edge_permissions).toEqual({ "*": "write" });
      expect(minted.data.extension_permissions).toEqual({ "*": "write" });
      expect(minted.data.metadata_permissions).toEqual({ "*": "write" });
      expect(minted.data.permissions?.length).toBeGreaterThan(0);

      const rows = await operator.listKeys();
      expect(rows.ok).toBe(true);
      const own = rows.data.data.find((k) => k.is_operator === true);
      expect(own).toBeDefined();
      expect(own!.type_permissions).toEqual({});
      expect(own!.edge_permissions).toEqual({});
      expect(own!.permissions).toEqual([]);
    } finally {
      const revoked = await operator.revokeKey(minted.data.id);
      expect(revoked.ok).toBe(true);
    }
  });
});

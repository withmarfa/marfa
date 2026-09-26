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
import { expectMatchesSchema } from "../../utils/openapi.js";

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

  it("a mint naming no maps takes the creator's whole set", async () => {
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
  });

  it("a key holding nothing reads itself, and no other key", async () => {
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
    expect(current.data.permissions ?? []).toEqual([]);
    expect(current.data.type_permissions).toEqual({ "core.note": "write" });
    expect(current.data).not.toHaveProperty("key");

    // The witness that it reads itself by this door alone.
    const listed = await self.listKeys();
    expect(listed.status).toBe(403);

    const bare = await fetch(`${apiUrl}/keys/current`);
    expect(bare.status).toBe(401);
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

  it("narrows a bulk action to nothing rather than refusing it, where a read is refused", async () => {
    // `POST /items/bulk-actions` asks the same filter at `"write"` level,
    // and the refusal is deliberately read-level only: this door narrows a
    // match set rather than refusing a row, so a credential that can write
    // nothing matches nothing and does nothing. Held here because nothing
    // else holds it, and a later simplification of the level check would
    // otherwise turn every narrow key's bulk action into a hard refusal
    // with no test to notice.
    const operator = getOperatorClient();
    const dryRun = await operator.rawRequest<{ matched: number }>(
      "/items/bulk-actions",
      {
        method: "POST",
        body: JSON.stringify({
          action: "transition",
          filter: { type: "core.note" },
          state: "archived",
          dry_run: true,
        }),
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(dryRun.ok).toBe(true);
    expect(dryRun.status).toBe(200);

    // The witness. The same credential reading the same filter is refused,
    // so the `200` above is the write level answering its own way and not
    // the refusal having gone.
    const read = await operator.listItems({ type: "core.note", limit: 1 });
    expect(read.ok).toBe(false);
    expect(read.status).toBe(403);
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
      // key it mints naming no maps holds every one of them.
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

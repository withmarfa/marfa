import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { ApiKeyRequest, TestContext } from "../../client/types.js";
import {
  createTestContext,
  getOperatorClient,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
} from "../../utils/fresh-server.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "key-reach",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** Well-formed, so the door reaches its row lookup rather than refusing the id. */
const UNKNOWN_ID = "019537a0-7b80-7000-8000-000000000000";

/** Mint with the file's own key, which holds everything a working key can. */
async function mint(
  label: string,
  body: Partial<ApiKeyRequest> = {},
  by: MarfaClient = client,
): Promise<{ id: string; key: string; client: MarfaClient }> {
  const r = await by.createKey({
    label,
    source: `${ctx.source}-${label}`,
    ...body,
  });
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  trackKey(ctx, r.data.id);
  return {
    id: r.data.id,
    key: r.data.key,
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: r.data.key }),
  };
}

/** A key that may mint and reads notes, and nothing else. */
function narrowMinter(label: string) {
  return mint(label, {
    permissions: ["keys.mint"],
    type_permissions: { "core.note": "read" },
  });
}

/** What an id no row holds answers, with the id spelled out of the message. */
async function unknownAnswer(by: MarfaClient, method: "revoke" | "update") {
  const r =
    method === "revoke"
      ? await by.revokeKey(UNKNOWN_ID)
      : await by.updateKey(UNKNOWN_ID, { label: "nobody" });
  return {
    status: r.status,
    code: r.error?.error.code,
    message: r.error?.error.message.replace(UNKNOWN_ID, "<id>"),
  };
}

describe("a key reaches only the keys it could have minted", () => {
  it("cannot revoke a key beyond its reach, and is answered as for no key", async () => {
    const minter = await narrowMinter("kr-revoke-minter");
    const full = await mint("kr-revoke-full");

    // The witness that the full key works before the attempt, so its working
    // after it says the revoke did nothing.
    expect((await full.client.listItems({ limit: 1 })).ok).toBe(true);

    const r = await minter.client.revokeKey(full.id);
    expect(r.status).toBe(404);
    expect(r.error?.error.code).toBe("api_key_not_found");
    expect({
      status: r.status,
      code: r.error?.error.code,
      message: r.error?.error.message.replace(full.id, "<id>"),
    }).toEqual(await unknownAnswer(minter.client, "revoke"));

    expect((await full.client.listItems({ limit: 1 })).ok).toBe(true);
  });

  it("cannot change a key beyond its reach, and is answered as for no key", async () => {
    const minter = await narrowMinter("kr-update-minter");
    const full = await mint("kr-update-full");

    const r = await minter.client.updateKey(full.id, {
      type_permissions: { "core.note": "read" },
    });
    expect(r.status).toBe(404);
    expect(r.error?.error.code).toBe("api_key_not_found");
    expect({
      status: r.status,
      code: r.error?.error.code,
      message: r.error?.error.message.replace(full.id, "<id>"),
    }).toEqual(await unknownAnswer(minter.client, "update"));

    const listed = await client.listKeys();
    expect(listed.ok).toBe(true);
    const row = listed.data.data.find((k) => k.id === full.id);
    expect(row?.type_permissions).toEqual({ "*": "write" });
  });

  it("lists only the keys within its reach, itself included", async () => {
    const minter = await narrowMinter("kr-list-minter");
    const full = await mint("kr-list-full");
    const narrower = await mint(
      "kr-list-narrower",
      { type_permissions: { "core.note": "read" }, permissions: [] },
      minter.client,
    );

    // The witness: the full key and the operator key are there to be listed,
    // to a credential that reaches them.
    const everything = await getOperatorClient().listKeys();
    expect(everything.ok).toBe(true);
    const all = everything.data.data.map((k) => k.id);
    expect(all).toContain(full.id);
    expect(everything.data.data.some((k) => k.is_operator)).toBe(true);

    const listed = await minter.client.listKeys();
    expect(listed.ok).toBe(true);
    const ids = listed.data.data.map((k) => k.id);
    expect(ids).toContain(minter.id);
    expect(ids).toContain(narrower.id);
    expect(ids).not.toContain(full.id);
    expect(listed.data.data.some((k) => k.is_operator)).toBe(false);
  });

  it("revokes and changes keys within its reach, a peer included, and revokes itself", async () => {
    const minter = await narrowMinter("kr-within-minter");
    const narrower = await mint(
      "kr-within-narrower",
      { type_permissions: { "core.note": "read" }, permissions: [] },
      minter.client,
    );
    // A peer holding exactly what the minter holds, minted by someone else:
    // the minter could have minted it, so it reaches it.
    const peer = await narrowMinter("kr-within-peer");

    const renamed = await minter.client.updateKey(narrower.id, {
      label: "kr-within-renamed",
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.data.label).toBe("kr-within-renamed");

    expect((await minter.client.revokeKey(narrower.id)).ok).toBe(true);
    expect((await narrower.client.getCurrentKey()).status).toBe(401);

    expect((await minter.client.revokeKey(peer.id)).ok).toBe(true);
    expect((await peer.client.getCurrentKey()).status).toBe(401);

    expect((await minter.client.revokeKey(minter.id)).ok).toBe(true);
    expect((await minter.client.getCurrentKey()).status).toBe(401);
  });

  it("does not reach a key holding a permission it lacks", async () => {
    const minter = await narrowMinter("kr-perm-minter");
    const auditor = await mint("kr-perm-auditor", {
      type_permissions: { "core.note": "read" },
      permissions: ["audit.read"],
    });

    expect((await minter.client.revokeKey(auditor.id)).status).toBe(404);
    expect(
      (await minter.client.updateKey(auditor.id, { label: "x" })).status,
    ).toBe(404);
    // The control: the same key is within reach of one that holds the
    // permission, so the refusal above is about the permission alone.
    const renamed = await client.updateKey(auditor.id, { label: "kr-perm-ok" });
    expect(renamed.ok).toBe(true);
  });

  it("does not reach a key claiming a source it could not grant", async () => {
    const minter = await narrowMinter("kr-claim-minter");
    const claimant = await mint("kr-claim-claimant", {
      type_permissions: { "core.note": "read" },
      permissions: [],
      sources: [ctx.source],
    });

    expect((await minter.client.revokeKey(claimant.id)).status).toBe(404);
    const listed = await minter.client.listKeys();
    expect(listed.ok).toBe(true);
    expect(listed.data.data.map((k) => k.id)).not.toContain(claimant.id);
    // The control: the file's key owns that source, so it reaches the key.
    const mine = await client.listKeys();
    expect(mine.data.data.map((k) => k.id)).toContain(claimant.id);
  });

  it("does not reach a key holding an extension namespace it lacks", async () => {
    const minter = await narrowMinter("kr-ext-minter");
    const holder = await mint("kr-ext-holder", {
      type_permissions: { "core.note": "read" },
      extension_permissions: { acme: "read" },
      permissions: [],
    });
    expect((await minter.client.revokeKey(holder.id)).status).toBe(404);

    // The control: a minter holding the namespace reaches the same key.
    const extended = await mint("kr-ext-extended", {
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "read" },
      extension_permissions: { acme: "write" },
    });
    expect((await extended.client.revokeKey(holder.id)).ok).toBe(true);
  });

  it("no working key reaches an operator key, and the operator key reaches every key", async () => {
    const operator = getOperatorClient();
    const spare = await operator.createKey({
      label: `kr-spare-operator-${ctx.runId}`,
      source: `${ctx.source}-kr-spare-operator`,
      is_operator: true,
    });
    expect(spare.ok, JSON.stringify(spare.error)).toBe(true);
    try {
      // The file's key holds every permission and every family at `*: write`,
      // and still does not reach a key that holds nothing at all.
      const revoke = await client.revokeKey(spare.data.id);
      expect(revoke.status).toBe(404);
      expect(revoke.error?.error.code).toBe("api_key_not_found");
      const update = await client.updateKey(spare.data.id, { label: "x" });
      expect(update.status).toBe(404);
      const listed = await client.listKeys();
      expect(listed.ok).toBe(true);
      expect(listed.data.data.some((k) => k.is_operator)).toBe(false);

      const full = await mint("kr-operator-target");
      const renamed = await operator.updateKey(full.id, {
        label: "kr-operator-renamed",
      });
      expect(renamed.ok).toBe(true);
      expect((await operator.revokeKey(full.id)).ok).toBe(true);
      const all = await operator.listKeys();
      expect(all.data.data.map((k) => k.id)).toContain(spare.data.id);
    } finally {
      const revoked = await operator.revokeKey(spare.data.id);
      expect(revoked.ok).toBe(true);
    }
  });

  it(
    "a signed-in app reaches the key it mints naming no reach, and no wider key",
    async () => {
      // On a server of its own, because an app's token needs an owner to
      // approve it and an instance has one.
      const server = await bootFreshServer("key-reach-app");
      try {
        const token = await approvedAppToken(server, [
          "content:read",
          "keys.mint",
        ]);
        const app = new MarfaClient({ baseUrl: server.apiUrl, apiKey: token });
        const working = new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: server.workingKey,
        });

        // A key like the app: it copies the maps the grant projects, denials
        // included.
        const own = await app.createKey({
          label: "app-own",
          source: "app-own",
        });
        expect(own.ok, JSON.stringify(own.error)).toBe(true);
        const wider = await working.createKey({
          label: "app-wider",
          source: "app-wider",
          type_permissions: { "*": "write" },
          permissions: [],
        });
        expect(wider.ok).toBe(true);

        const listed = await app.listKeys();
        expect(listed.ok).toBe(true);
        const ids = listed.data.data.map((k) => k.id);
        expect(ids).toContain(own.data.id);
        expect(ids).not.toContain(wider.data.id);

        expect((await app.revokeKey(wider.data.id)).status).toBe(404);
        expect((await app.revokeKey(own.data.id)).ok).toBe(true);
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS + 120_000,
  );
});

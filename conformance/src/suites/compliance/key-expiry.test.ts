import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

/**
 * A key past its `expires_at`. No operation stamps an expiry on a key, so
 * the fixture stamps one in the database of a server of its own and asks
 * over HTTP.
 */
let server: FreshServer;
let management: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("key-expiry");
  management = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function mint(label: string): Promise<{ id: string; key: string }> {
  const minted = await management.createKey({
    label,
    source: label,
    permissions: ["audit.read"],
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return { id: minted.data.id, key: minted.data.key };
}

describe("a key past its expires_at", () => {
  it("is refused 401, left out of the listing, and answered 404 api_key_not_found to an update or a revoke", async () => {
    const expiring = await mint("expiring");
    const lasting = await mint("lasting");
    const bearer = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: expiring.key,
    });
    // The witness: before its expiry the key works and is listed.
    expect((await bearer.getCurrentKey()).status).toBe(200);
    expect(
      (await management.listKeys()).data.data.map((k) => k.id),
    ).toContain(expiring.id);

    withInstanceDatabase(server.sqlitePath, (db) => {
      const stamped = db
        .prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?")
        .run("2001-01-01T00:00:00.000Z", expiring.id);
      expect(stamped.changes).toBe(1);
    });

    const refused = await bearer.getCurrentKey();
    expect(refused.status).toBe(401);
    expect(refused.error?.error.code).toBe("unauthorized");
    const listed = (await management.listKeys()).data.data.map((k) => k.id);
    expect(listed).not.toContain(expiring.id);
    expect(listed).toContain(lasting.id);

    const updated = await management.updateKey(expiring.id, { label: "x" });
    expect(updated.status).toBe(404);
    expect(updated.error?.error.code).toBe("api_key_not_found");
    const revoked = await management.revokeKey(expiring.id);
    expect(revoked.status).toBe(404);
    expect(revoked.error?.error.code).toBe("api_key_not_found");
    const unchanged = withInstanceDatabase(server.sqlitePath, (db) =>
      db
        .prepare("SELECT label, revoked_at FROM api_keys WHERE id = ?")
        .get(expiring.id),
    ) as { label: string; revoked_at: string | null };
    expect(unchanged).toEqual({ label: "expiring", revoked_at: null });

    // The witness that the refusals are the expiry's: the other key changes.
    expect(
      (await management.updateKey(lasting.id, { label: "lasting-renamed" }))
        .status,
    ).toBe(200);
  });
});

import { afterEach, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { itemsArchive } from "../../utils/archive.js";
import { bootFreshServer, type FreshServer } from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { TEST_OWNER } from "../../utils/target.js";

let server: FreshServer | undefined;
afterEach(async () => {
  await server?.stop();
});

it("reauthenticates an old startup cookie before the first owner restore", async () => {
  server = await bootFreshServer("old-owner-client");
  withInstanceDatabase(server.sqlitePath, (db) => {
    db.exec("UPDATE auth_session SET created_at = created_at - 1200");
  });
  const cookieOnly = new MarfaClient({
    baseUrl: server.apiUrl,
    ownerCookie: server.ownerCookie,
  });
  const stale = await cookieOnly.restoreArchive(itemsArchive([]));
  expect(stale.status).toBe(403);
  const client = new MarfaClient({
    baseUrl: server.apiUrl,
    ownerCookie: server.ownerCookie,
    ownerCredentials: TEST_OWNER,
  });
  const restored = await client.restoreArchive(itemsArchive([]));
  expect(restored.status, JSON.stringify(restored.error)).toBe(200);
});

it("reauthenticates a revoked startup cookie before concurrent owner actions", async () => {
  server = await bootFreshServer("revoked-owner-client");
  const signedOut = await fetch(`${server.apiUrl}/auth/sign-out`, {
    method: "POST",
    headers: {
      cookie: server.ownerCookie,
      origin: server.apiUrl,
      "content-type": "application/json",
    },
    body: "{}",
  });
  expect(signedOut.status).toBe(200);
  const cookieOnly = new MarfaClient({
    baseUrl: server.apiUrl,
    ownerCookie: server.ownerCookie,
  });
  expect((await cookieOnly.restoreArchive(itemsArchive([]))).status).toBe(401);
  const client = new MarfaClient({
    baseUrl: server.apiUrl,
    ownerCookie: server.ownerCookie,
    ownerCredentials: TEST_OWNER,
  });
  const restored = await Promise.all([
    client.restoreArchive(itemsArchive([])),
    client.restoreArchive(itemsArchive([])),
  ]);
  expect(restored.map((result) => result.status)).toEqual([200, 200]);
  const sessions = withInstanceDatabase(server.sqlitePath, (db) =>
    db.prepare("SELECT COUNT(*) AS count FROM auth_session").get(),
  );
  expect(sessions?.count).toBe(1);
});

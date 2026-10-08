import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
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
    ownerSessionFile: `${server.stateDir}/owner-session.json`,
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
    ownerSessionFile: `${server.stateDir}/owner-session.json`,
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

it("shares a fresh owner session across twelve independent clients", async () => {
  server = await bootFreshServer("shared-owner-client");
  withInstanceDatabase(server.sqlitePath, (db) => {
    db.exec("UPDATE auth_session SET created_at = created_at - 1200");
  });
  const options = {
    baseUrl: server.apiUrl,
    ownerCookie: server.ownerCookie,
    ownerCredentials: TEST_OWNER,
    ownerSessionFile: `${server.stateDir}/owner-session.json`,
  };
  for (let index = 0; index < 12; index++) {
    const result = await new MarfaClient(options).restoreArchive(
      itemsArchive([]),
    );
    expect(result.status).toBe(200);
  }
  const sessions = withInstanceDatabase(server.sqlitePath, (db) =>
    db.prepare("SELECT COUNT(*) AS count FROM auth_session").get(),
  );
  expect(sessions?.count).toBe(2);
  expect(statSync(options.ownerSessionFile).mode & 0o777).toBe(0o600);

  withInstanceDatabase(server.sqlitePath, (db) => {
    db.exec("UPDATE auth_session SET created_at = created_at - 1200");
  });
  const script = `
    import { MarfaClient } from ${JSON.stringify(new URL("../../client/api.ts", import.meta.url).href)};
    const response = await new MarfaClient(JSON.parse(process.env.MARFA_OWNER_CLIENT_OPTIONS)).rawRequest("/keys", {
      method: "POST", body: { label: "parallel-owner", source: "parallel-owner-" + process.pid }
    });
    if (response.status !== 201) throw new Error("Owner key creation answered " + response.status);
  `;
  await Promise.all(
    Array.from({ length: 3 }, () =>
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "--input-type", "module", "-e", script],
        {
          env: {
            ...process.env,
            MARFA_OWNER_CLIENT_OPTIONS: JSON.stringify(options),
          },
        },
      ),
    ),
  );
  const afterProcesses = withInstanceDatabase(server.sqlitePath, (db) =>
    db.prepare("SELECT COUNT(*) AS count FROM auth_session").get(),
  );
  expect(afterProcesses?.count).toBe(3);
});

it("reuses the authenticated session across fixture server restarts", async () => {
  server = await bootFreshServer("restarted-owner-client");
  const originalCookie = server.ownerCookie;
  for (let restart = 0; restart < 3; restart++) {
    await server.restart();
    expect(server.ownerCookie).toBe(originalCookie);
    const session = await fetch(`${server.apiUrl}/auth/get-session`, {
      headers: { cookie: originalCookie },
    });
    expect(session.status).toBe(200);
    expect(
      ((await session.json()) as { session?: unknown }).session,
    ).toBeTruthy();
  }
  const sessions = withInstanceDatabase(server.sqlitePath, (db) =>
    db.prepare("SELECT COUNT(*) AS count FROM auth_session").get(),
  );
  expect(sessions?.count).toBe(1);
});

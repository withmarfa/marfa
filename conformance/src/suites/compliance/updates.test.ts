import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { QUIET_SCHEDULE } from "../../utils/moved-clock.js";

/**
 * The release check and the update operations. The check asks a stand-in for
 * GitHub that the fixture serves, which a `release-feed` fault names: a server
 * with test hooks asks nobody else. No fixture can make a server that is a
 * service with programs it may replace, so the swap itself is not asserted here.
 */

let server: FreshServer;
let operator: MarfaClient;
let reader: MarfaClient;
let maintainer: MarfaClient;
let working: MarfaClient;
let feed: Server;
let asked = 0;
let reply = { status: 200, body: "" };

/** The latest-release answer GitHub gives, for a release this server runs or one past it. */
function release(version: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    published_at: "2026-11-16T09:30:00Z",
    assets: [
      {
        name: `marfa-${version}-linux-x86_64.tar.gz`,
        browser_download_url: "http://127.0.0.1:9/archive",
        size: 10,
      },
      {
        name: `marfa-${version}-darwin-arm64.tar.gz`,
        browser_download_url: "http://127.0.0.1:9/archive",
        size: 10,
      },
      {
        name: `marfa-${version}-linux-aarch64.tar.gz`,
        browser_download_url: "http://127.0.0.1:9/archive",
        size: 10,
      },
      {
        name: `marfa-${version}-checksums.txt`,
        browser_download_url: "http://127.0.0.1:9/sums",
        size: 10,
      },
    ],
    ...extra,
  });
}

/** The version after this server's own, which any check finds newer. */
async function newer(): Promise<string> {
  const [major, minor, patch] = (await operator.getUpdate()).data.release
    .split(".")
    .map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

async function key(permissions: string[]): Promise<MarfaClient> {
  const owner = new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
  const minted = await owner.createKey({
    label: permissions.join("-") || "none",
    source: `updates-${permissions.join("-") || "none"}`,
    permissions,
    type_permissions: {},
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    profile_permissions: {},
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: minted.data.key });
}

async function check(): Promise<void> {
  const run = await operator.runHousekeeping("release-check");
  expect(run.status, JSON.stringify(run.error)).toBe(200);
  expect(run.data.outcome, JSON.stringify(run.data)).toBe("succeeded");
}

beforeAll(async () => {
  feed = createServer((_request, response) => {
    asked += 1;
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(reply.body);
  });
  await new Promise<void>((resolve) => feed.listen(0, "127.0.0.1", resolve));
  server = await bootFreshServer("updates", QUIET_SCHEDULE);
  operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  reader = await key(["instance.read"]);
  maintainer = await key(["instance.maintain"]);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
  await new Promise((resolve) => feed?.close(resolve));
}, FRESH_SERVER_TIMEOUT_MS);

async function pointAtFeed(): Promise<void> {
  const { port } = feed.address() as AddressInfo;
  await server.setFault(`release-feed=http://127.0.0.1:${port}/latest`);
}

it(
  "asks nobody for a release until a fault names an address, and reads no release before a check has found one",
  async () => {
    // A server of its own, since the answer is the instance's whole history of checks.
    const fresh = await bootFreshServer("updates-silent", QUIET_SCHEDULE);
    try {
      const own = new MarfaClient({
        baseUrl: fresh.apiUrl,
        apiKey: fresh.managementKey,
      });
      const before = asked;
      const run = await own.runHousekeeping("release-check");
      expect(run.data.outcome, JSON.stringify(run.data)).toBe("succeeded");
      expect(asked).toBe(before);
      const read = await own.getUpdate();
      expect(read.status, JSON.stringify(read.error)).toBe(200);
      expect(read.data).toMatchObject({
        check_enabled: true,
        checked_at: null,
        latest: null,
        available: false,
      });

      // The witness: the same job asks once the fault names the stand-in.
      const [major, minor, patch] = read.data.release.split(".").map(Number);
      reply = { status: 200, body: release(`${major}.${minor}.${patch + 1}`) };
      const { port } = feed.address() as AddressInfo;
      await fresh.setFault(`release-feed=http://127.0.0.1:${port}/latest`);
      expect((await own.runHousekeeping("release-check")).data.outcome).toBe(
        "succeeded",
      );
      expect(asked).toBe(before + 1);
    } finally {
      await fresh.stop();
    }
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it("reads the running release, the newest published release a check found and whether it is newer, to a caller holding instance.read", async () => {
  const version = await newer();
  reply = { status: 200, body: release(version) };
  await pointAtFeed();
  await check();
  const read = await reader.getUpdate();
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  await expectMatchesSchema("GET", "/update", 200, read.data);
  expect(read.data.latest).toEqual({
    release: version,
    published_at: "2026-11-16T09:30:00.000Z",
  });
  expect(read.data.available).toBe(true);
  expect(Date.parse(read.data.checked_at ?? "")).not.toBeNaN();
  expect(read.data.check_error).toBeNull();
  expect(read.data.progress).toEqual({ state: "idle", release: null });
  expect(read.data.last).toBeNull();
});

it("refuses the read to a caller without instance.read and the start to one without instance.maintain", async () => {
  expect((await reader.getUpdate()).status).toBe(200);
  expect((await maintainer.getUpdate()).status).toBe(403);
  expect((await working.getUpdate()).status).toBe(403);
  const refused = await reader.startUpdate();
  expect(refused.status).toBe(403);
  expect(refused.error?.error.code).toBe("forbidden");
  expect((await working.startUpdate()).status).toBe(403);
});

it("reads no release as newer when the newest published release is the one running", async () => {
  const running = (await operator.getUpdate()).data.release;
  reply = { status: 200, body: release(running) };
  await pointAtFeed();
  await check();
  const read = await operator.getUpdate();
  expect(read.data.latest?.release).toBe(running);
  expect(read.data.available).toBe(false);
  expect(read.data.step).toBeNull();
  const started = await operator.startUpdate();
  expect(started.status).toBe(409);
  expect(started.error?.error.code).toBe("update_not_ready");
});

it("keeps the last release found when a check fails, says why, and ends the run as succeeded", async () => {
  const found = await newer();
  reply = { status: 200, body: release(found) };
  await pointAtFeed();
  await check();
  const checkedAt = (await operator.getUpdate()).data.checked_at;
  const draft = release(await newer(), { draft: true });
  const prerelease = release(await newer(), { prerelease: true });
  for (const failure of [
    { status: 500, body: "unavailable" },
    { status: 403, body: "rate limited" },
    { status: 200, body: "<html>not a release</html>" },
    { status: 200, body: draft },
    { status: 200, body: prerelease },
  ]) {
    reply = failure;
    await check();
    const read = await operator.getUpdate();
    expect(read.data.latest?.release, JSON.stringify(failure)).toBe(found);
    expect(read.data.checked_at).toBe(checkedAt);
    expect(read.data.available).toBe(true);
    expect(read.data.check_error?.message).toEqual(expect.any(String));
    await expectMatchesSchema("GET", "/update", 200, read.data);
  }
  reply = { status: 200, body: release(found) };
  await check();
  expect((await operator.getUpdate()).data.check_error).toBeNull();
});

it("refuses an update on a server that cannot update itself with the step to take on its host, and changes nothing", async () => {
  const version = await newer();
  reply = { status: 200, body: release(version) };
  await pointAtFeed();
  await check();
  const read = await operator.getUpdate();
  expect(read.data.method).toBe("manual");
  expect(read.data.step).toContain(version);
  // The start answers with the body the read gives; no fixture can make a server that accepts one.
  await expectMatchesSchema("POST", "/update", 202, read.data);

  const refused = await operator.startUpdate();
  expect(refused.status).toBe(409);
  expect(refused.error?.error.code).toBe("update_unavailable");
  expect(refused.error?.error.details?.step).toBe(read.data.step);
  const after = await operator.getUpdate();
  expect(after.data.progress).toEqual({ state: "idle", release: null });
  expect(after.data.last).toBeNull();
  expect(after.data.release).toBe(read.data.release);
});

it("makes no request for a release while update_check_enabled is false, and lists no release-check job", async () => {
  const on = (await operator.getConfig()).data as Record<string, unknown>;
  await operator.updateConfig({ ...on, update_check_enabled: true });
  const version = await newer();
  reply = { status: 200, body: release(version) };
  await pointAtFeed();
  await check();
  const before = asked;
  expect(before).toBeGreaterThan(0);

  const config = (await operator.getConfig()).data as Record<string, unknown>;
  const off = await operator.updateConfig({
    ...config,
    update_check_enabled: false,
  });
  expect(off.status, JSON.stringify(off.error)).toBe(200);
  const run = await operator.runHousekeeping("release-check");
  expect(run.status).toBe(404);
  const jobs = await operator.listHousekeeping();
  expect(jobs.data.data.map((job) => job.name)).not.toContain("release-check");
  const read = await operator.getUpdate();
  expect(read.data).toMatchObject({
    check_enabled: false,
    latest: null,
    available: false,
  });
  expect((await operator.startUpdate()).error?.error.code).toBe(
    "update_not_ready",
  );
  expect(asked).toBe(before);

  const back = await operator.updateConfig({
    ...config,
    update_check_enabled: true,
  });
  expect(back.status, JSON.stringify(back.error)).toBe(200);
  await check();
  expect(asked).toBe(before + 1);
});

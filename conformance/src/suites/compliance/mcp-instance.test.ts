import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  callTool,
  connectMcp,
  toolError,
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";
import { DAY_MS, QUIET_SCHEDULE } from "../../utils/moved-clock.js";

/**
 * Updating the server and confirming its clock through `/mcp/admin`. The
 * release check asks a stand-in for GitHub that a `release-feed` fault names.
 * An update that starts needs a server installed as a service with programs
 * it may replace, which `updates-swap.test.ts` makes, so the two statements
 * about a started update are asserted there.
 */

let server: FreshServer;
let feed: Server;
let reply = { status: 404, body: "" };
let maintainer: string;
let connection: McpConnection;
const connections: McpConnection[] = [];
let minted = 0;

/** Far enough ahead of the trusted time that clean-up holds. */
const AHEAD = 31 * DAY_MS;

beforeAll(async () => {
  feed = createServer((_, response) => {
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(reply.body);
  });
  await new Promise<void>((resolve) => feed.listen(0, "127.0.0.1", resolve));
  server = await bootFreshServer("mcp-instance", QUIET_SCHEDULE);
  maintainer = await mint(["instance.maintain"]);
  connection = await admin(maintainer);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  for (const open of connections) await open.close();
  await server?.stop();
  await new Promise((resolve) => feed?.close(resolve));
}, FRESH_SERVER_TIMEOUT_MS);

async function mint(permissions: string[]): Promise<string> {
  minted += 1;
  const answer = await controlRequest(server.controlSocket, "/keys", {
    method: "POST",
    body: {
      label: `mcp instance ${String(minted)}`,
      source: `mcp-instance-${String(minted)}`,
      permissions,
    },
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.key as string;
}

async function admin(credential: string): Promise<McpConnection> {
  const opened = await connectMcp(
    server.apiUrl,
    credential,
    "2026-07-28",
    "/mcp/admin",
  );
  connections.push(opened);
  return opened;
}

async function api(
  credential: string,
  method: string,
  path: string,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${credential}` },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === "" ? {} : JSON.parse(text)) as Record<string, any>,
  };
}

/** Sets the server's wall clock by `ms`, as an owner or a host would. */
async function jump(ms: number): Promise<void> {
  const moved = await controlRequest(
    server.controlSocket,
    "/_control/test/clock",
    { method: "POST", body: { jump_ms: ms } },
  );
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
}

async function held(): Promise<unknown> {
  const health = await api(server.managementKey, "GET", "/health");
  expect(health.status).toBe(200);
  return health.body.housekeeping.held;
}

async function audited(action: string): Promise<Record<string, any>[]> {
  const read = await api(
    server.managementKey,
    "GET",
    `/audit?${new URLSearchParams({ action, limit: "200" })}`,
  );
  expect(read.status).toBe(200);
  return read.body.data as Record<string, any>[];
}

function clock(args: Record<string, unknown> = {}) {
  return callTool(connection, "marfa_maintain", {
    action: "confirm_clock",
    ...args,
  });
}

describe("confirming the clock", () => {
  it("previews the server time, the trusted time, the gap, the jobs that would run and when the hold ends, and confirms the clock on the confirmation", async () => {
    // The witness: with nothing held the preview offers nothing to confirm.
    const calm = toolResult(await clock());
    expect(calm.held).toBe(false);
    expect(calm).not.toHaveProperty("confirm");

    await jump(AHEAD);
    const preview = toolResult(await clock());
    expect(preview.held).toBe(true);
    const shown = (await held()) as Record<string, string>;
    const near = (one: unknown, other: string) =>
      Math.abs(Date.parse(one as string) - Date.parse(other));
    expect(near(preview.server_time, shown.clock_at)).toBeLessThan(5_000);
    expect(preview.trusted_time).toBe(shown.trusted_at);
    expect(near(preview.hold_ends_at, shown.ends_at)).toBeLessThan(5_000);
    expect(preview.gap_seconds).toBe(
      Math.floor(
        (Date.parse(preview.server_time as string) -
          Date.parse(preview.trusted_time as string)) /
          1000,
      ),
    );
    expect(preview.gap_seconds as number).toBeGreaterThanOrEqual(AHEAD / 1000);
    expect(preview.held_jobs).toEqual(expect.arrayContaining(["trash-purge"]));
    expect(String(preview.next)).toContain("Ask the person");
    // A preview confirms nothing.
    expect(await held()).not.toBeNull();

    const confirmed = toolResult(
      await clock({ confirm: preview.confirm as string }),
    );
    expect(Date.parse(confirmed.confirmed_at as string)).toBeGreaterThanOrEqual(
      Date.parse(preview.server_time as string),
    );
    expect(await held()).toBeNull();
    const again = toolResult(
      await clock({ confirm: preview.confirm as string }),
    );
    expect(again.already_done).toBe(true);
  });

  it("refuses a confirmation once the clock jumped since the preview, answering a new preview and confirming nothing", async () => {
    await jump(AHEAD);
    const first = toolResult(await clock());
    expect(first.held).toBe(true);
    // Set back a day, still far ahead: a jump forward would also outlast the token.
    await jump(-DAY_MS);
    const refused = toolError(
      await clock({ confirm: first.confirm as string }),
    );
    expect(refused.code).toBe("confirmation_stale");
    expect(refused.held).toBe(true);
    expect(refused.confirm).not.toBe(first.confirm);
    expect(refused.server_time).not.toBe(first.server_time);
    expect(await held()).not.toBeNull();
    // The witness: the new preview's confirmation confirms the clock.
    toolResult(await clock({ confirm: refused.confirm as string }));
    expect(await held()).toBeNull();
  });

  it("refuses a confirmation once nothing is held, and confirms nothing", async () => {
    await jump(AHEAD);
    const preview = toolResult(await clock());
    expect(preview.held).toBe(true);
    const ended = await api(maintainer, "POST", "/clock/confirm");
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    const before = await audited("instance.clock.confirmed");
    const refused = toolError(
      await clock({ confirm: preview.confirm as string }),
    );
    expect(refused.code).toBe("confirmation_stale");
    expect(refused.held).toBe(false);
    expect(refused).not.toHaveProperty("confirm");
    expect(await audited("instance.clock.confirmed")).toEqual(before);
  });

  it("records instance.clock.confirmed for a confirmation through the tool and through POST /clock/confirm, with the key that confirmed it", async () => {
    await jump(AHEAD);
    const preview = toolResult(await clock());
    toolResult(await clock({ confirm: preview.confirm as string }));
    const [throughTool] = await audited("instance.clock.confirmed");
    expect(throughTool).toMatchObject({
      action: "instance.clock.confirmed",
      resource_type: "instance",
      details: { held: true, via: "mcp" },
    });
    expect(throughTool!.key_id).toBeTruthy();

    await jump(AHEAD);
    const ended = await api(maintainer, "POST", "/clock/confirm");
    expect(ended.status).toBe(200);
    const [throughApi] = await audited("instance.clock.confirmed");
    expect(throughApi!.id).not.toBe(throughTool!.id);
    expect(throughApi).toMatchObject({
      key_id: throughTool!.key_id,
      details: { held: true, confirmed_at: ended.body.confirmed_at },
    });
    expect(throughApi!.details).not.toHaveProperty("via");
  });
});

describe("updating the server", () => {
  function newer(version: string): string {
    const [major, minor, patch] = version.split(".").map(Number);
    return `${major}.${minor}.${patch + 1}`;
  }

  function release(version: string): string {
    const { port } = feed.address() as AddressInfo;
    const at = (name: string) =>
      `http://127.0.0.1:${port}/withmarfa/marfa/releases/download/v${version}/${name}`;
    const names = [
      `marfa-${version}-linux-x86_64.tar.gz`,
      `marfa-${version}-darwin-arm64.tar.gz`,
      `marfa-${version}-linux-aarch64.tar.gz`,
      `marfa-${version}-checksums.txt`,
    ];
    return JSON.stringify({
      tag_name: `v${version}`,
      draft: false,
      prerelease: false,
      published_at: "2026-11-16T09:30:00Z",
      assets: names.map((name) => ({
        name,
        browser_download_url: at(name),
        size: 10,
      })),
    });
  }

  async function check(): Promise<void> {
    const run = await api(
      server.managementKey,
      "POST",
      "/housekeeping/release-check/run",
    );
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body.outcome).toBe("succeeded");
  }

  it("refuses an update with no newer release found, and one on a server that cannot update itself with the step to take on its host, as POST /update does", async () => {
    const running = (await api(server.managementKey, "GET", "/update")).body
      .release as string;
    const none = toolError(
      await callTool(connection, "marfa_update_server", {}),
    );
    const noneApi = await api(maintainer, "POST", "/update");
    expect(noneApi.status).toBe(409);
    expect(none.code).toBe(noneApi.body.error.code);
    expect(none.code).toBe("update_not_ready");

    reply = { status: 200, body: release(newer(running)) };
    const { port } = feed.address() as AddressInfo;
    await server.setFault(`release-feed=http://127.0.0.1:${port}/latest`);
    await check();
    const refused = toolError(
      await callTool(connection, "marfa_update_server", {}),
    );
    const refusedApi = await api(maintainer, "POST", "/update");
    expect(refusedApi.status).toBe(409);
    expect(refused.code).toBe("update_unavailable");
    expect(refused.code).toBe(refusedApi.body.error.code);
    expect((refused.details as Record<string, unknown>).step).toBe(
      refusedApi.body.error.details.step,
    );
    expect(String((refused.details as Record<string, unknown>).step)).toContain(
      newer(running),
    );
    expect(await audited("instance.update.started")).toEqual([]);
  });

  it("refuses a confirmation that is not one, and starts nothing", async () => {
    const refused = toolError(
      await callTool(connection, "marfa_update_server", {
        confirm: "not-a-confirmation",
      }),
    );
    expect(refused.code).toBe("confirmation_stale");
    const read = await api(server.managementKey, "GET", "/update");
    expect(read.body.progress).toEqual({ state: "idle", release: null });
  });
});

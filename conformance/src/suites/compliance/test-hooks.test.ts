import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { signInOwnerWithPassword } from "../../client/owner-session.js";
import { afterAll, describe, expect, it } from "vitest";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { listened, settingLines } from "../../utils/refused-boot.js";
import { operatorOf, QUIET_SCHEDULE, runJob } from "../../utils/moved-clock.js";
import { connectMcp, type McpConnection } from "../../utils/mcp.js";
import { TEST_OWNER } from "../../utils/target.js";

/**
 * The test hooks: the routes on the private control socket that move the
 * server's clock and set a fault. They are the harness's, so what is held
 * here is that they are served nowhere an instance with data could be
 * reached, and that what they promise holds.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

const HOUR_MS = 3_600_000;

/** Every route the hooks serve, with a body where one is read. */
const ROUTES: [string, string, unknown?][] = [
  ["GET", "/_control/test/clock"],
  ["POST", "/_control/test/clock", { advance_ms: 1 }],
  ["GET", "/_control/test/faults"],
  ["PUT", "/_control/test/faults", { name: "hold:version-thinning:item" }],
  ["DELETE", "/_control/test/faults"],
  ["GET", "/_control/test/blob-stores"],
];

async function overHttp(
  server: FreshServer,
  method: string,
  path: string,
  body?: unknown,
): Promise<number> {
  const response = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${server.managementKey}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.status;
}

describe("the test hooks", () => {
  it(
    "serves no test hook on any listener while MARFA_TEST_HOOKS is not true",
    async () => {
      const off = await bootFreshServer("test-hooks-off", {
        MARFA_TEST_HOOKS: "false",
      });
      const on = await bootFreshServer("test-hooks-witness");
      try {
        for (const [method, path, body] of ROUTES) {
          const where = `${method} ${path}`;
          expect(
            (await controlRequest(off.controlSocket, path, { method, body }))
              .status,
            `${where} on the private socket`,
          ).toBe(404);
          expect(await overHttp(off, method, path, body), where).toBe(404);
        }
        // The witness: the private socket of a server started with the hooks
        // answers the routes the other refused.
        for (const [method, path, body] of ROUTES) {
          expect(
            (await controlRequest(on.controlSocket, path, { method, body }))
              .status,
            `${method} ${path} with the hooks on`,
          ).toBe(200);
        }
      } finally {
        await Promise.all([off.stop(), on.stop()]);
      }
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "serves no test hook on the HTTP listener, even with MARFA_TEST_HOOKS true",
    async () => {
      const server = await bootFreshServer("test-hooks-http");
      try {
        // The witness: the hooks are on, and the private socket serves them.
        const clock = await controlRequest(
          server.controlSocket,
          "/_control/test/clock",
        );
        expect(clock.status).toBe(200);
        for (const [method, path, body] of ROUTES) {
          expect(
            await overHttp(server, method, path, body),
            `${method} ${path}`,
          ).toBe(404);
        }
        // Nor does it serve them to a caller holding no key.
        const bare = await fetch(`${server.apiUrl}/_control/test/clock`);
        expect(bare.status).toBe(404);
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a clock offset without MARFA_TEST_HOOKS, naming the setting",
    async () => {
      const refused = await bootRefused("test-hooks-offset", {
        extraEnv: {
          MARFA_TEST_HOOKS: "false",
          MARFA_TEST_CLOCK_OFFSET_MS: String(HOUR_MS),
        },
      });
      try {
        expect(refused).toMatchObject({ code: 1, signal: null });
        expect(listened(refused)).toBe(false);
        expect(settingLines(refused)).toEqual([
          `MARFA_TEST_CLOCK_OFFSET_MS needs MARFA_TEST_HOOKS to be true (got "${String(HOUR_MS)}")`,
        ]);
      } finally {
        await refused.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "reads the time as MARFA_TEST_CLOCK_OFFSET_MS later than the system clock",
    async () => {
      const ahead = await bootFreshServer("test-hooks-ahead", {
        MARFA_TEST_CLOCK_OFFSET_MS: String(24 * HOUR_MS),
      });
      const level = await bootFreshServer("test-hooks-level");
      try {
        const read = async (server: FreshServer) =>
          Date.parse((await runJob(server, "audit-cleanup")).started_at);
        // The witness: the same read on a server with no offset is the
        // system clock's.
        expect(Math.abs((await read(level)) - Date.now())).toBeLessThan(10_000);
        expect(
          Math.abs((await read(ahead)) - (Date.now() + 24 * HOUR_MS)),
        ).toBeLessThan(10_000);
      } finally {
        await Promise.all([ahead.stop(), level.stop()]);
      }
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "stamps a sign-in with the time the server reads",
    async () => {
      const ahead = await bootFreshServer("test-hooks-sign-in-ahead", {
        MARFA_TEST_CLOCK_OFFSET_MS: String(24 * HOUR_MS),
      });
      const level = await bootFreshServer("test-hooks-sign-in-level");
      try {
        const createdAt = async (server: FreshServer): Promise<number> => {
          const origin = new URL(server.apiUrl).origin;
          await signInOwnerWithPassword(server.apiUrl, origin, TEST_OWNER);
          const listed = await controlRequest(
            server.controlSocket,
            "/owner/sign-ins",
          );
          expect(listed.status).toBe(200);
          const browsers = (
            listed.body.data as { kind: string; created_at: string }[]
          ).filter((row) => row.kind === "browser");
          return Math.max(...browsers.map((row) => Date.parse(row.created_at)));
        };
        // The witness: with no offset the sign-in's time is the system's.
        expect(Math.abs((await createdAt(level)) - Date.now())).toBeLessThan(
          10_000,
        );
        expect(
          Math.abs((await createdAt(ahead)) - (Date.now() + 24 * HOUR_MS)),
        ).toBeLessThan(10_000);
      } finally {
        await Promise.all([ahead.stop(), level.stop()]);
      }
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses to move the clock back, and keeps the time it reads",
    async () => {
      const server = await bootFreshServer("test-hooks-forward");
      try {
        const clock = (body: unknown) =>
          controlRequest(server.controlSocket, "/_control/test/clock", {
            method: "POST",
            body,
          });
        const offset = async () =>
          (await controlRequest(server.controlSocket, "/_control/test/clock"))
            .body.offset_ms;
        // The witness: a step forward is taken.
        expect((await clock({ advance_ms: HOUR_MS })).status).toBe(200);
        expect(await offset()).toBe(HOUR_MS);

        for (const body of [
          { advance_ms: -1 },
          { advance_ms: -HOUR_MS },
          { advance_ms: 1.5 },
          { advance_ms: "60000" },
          {},
        ]) {
          const refused = await clock(body);
          expect(refused.status, JSON.stringify(body)).toBe(400);
          expect(await offset(), JSON.stringify(body)).toBe(HOUR_MS);
        }
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a contract version without MARFA_TEST_HOOKS, naming the setting",
    async () => {
      const refused = await bootRefused("test-hooks-contract", {
        extraEnv: {
          MARFA_TEST_HOOKS: "false",
          MARFA_TEST_CONTRACT_VERSION: "1",
        },
      });
      try {
        expect(refused).toMatchObject({ code: 1, signal: null });
        expect(listened(refused)).toBe(false);
        expect(settingLines(refused)).toEqual([
          'MARFA_TEST_CONTRACT_VERSION needs MARFA_TEST_HOOKS to be true (got "1")',
        ]);
      } finally {
        await refused.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a release without MARFA_TEST_HOOKS, naming the setting",
    async () => {
      const refused = await bootRefused("test-hooks-release", {
        extraEnv: {
          MARFA_TEST_HOOKS: "false",
          MARFA_TEST_RELEASE: "1.4.0",
        },
      });
      try {
        expect(refused).toMatchObject({ code: 1, signal: null });
        expect(listened(refused)).toBe(false);
        expect(settingLines(refused)).toEqual([
          'MARFA_TEST_RELEASE needs MARFA_TEST_HOOKS to be true (got "1.4.0")',
        ]);
      } finally {
        await refused.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a release that does not read as one, naming the setting",
    async () => {
      const refused = await bootRefused("test-hooks-release-form", {
        extraEnv: {
          MARFA_TEST_HOOKS: "true",
          MARFA_TEST_RELEASE: "1.4",
        },
      });
      try {
        expect(refused).toMatchObject({ code: 1, signal: null });
        expect(listened(refused)).toBe(false);
        expect(settingLines(refused)).toEqual([
          'MARFA_TEST_RELEASE must be a release such as 1.4.0 (got "1.4")',
        ]);
      } finally {
        await refused.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "names MARFA_TEST_RELEASE as the version everywhere the server names its release, and judges updates against it",
    async () => {
      let latest = "1.3.0";
      const feed = createServer((_request, response) => {
        const version = latest;
        const base = `http://127.0.0.1:${(feed.address() as AddressInfo).port}`;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            tag_name: `v${version}`,
            draft: false,
            prerelease: false,
            published_at: "2026-11-16T09:30:00Z",
            assets: [
              `marfa-${version}-linux-x86_64.tar.gz`,
              `marfa-${version}-darwin-arm64.tar.gz`,
              `marfa-${version}-linux-aarch64.tar.gz`,
              `marfa-${version}-checksums.txt`,
            ].map((name) => ({
              name,
              browser_download_url: `${base}/withmarfa/marfa/releases/download/v${version}/${name}`,
              size: 10,
            })),
          }),
        );
      });
      await new Promise<void>((resolve) =>
        feed.listen(0, "127.0.0.1", resolve),
      );
      const named = await bootFreshServer("test-hooks-release-named", {
        ...QUIET_SCHEDULE,
        MARFA_TEST_RELEASE: "1.4.0",
      });
      const own = await bootFreshServer(
        "test-hooks-release-own",
        QUIET_SCHEDULE,
      );
      const open: McpConnection[] = [];
      try {
        const read = async (server: FreshServer) => {
          const get = async (path: string, key: string) => {
            const response = await fetch(`${server.apiUrl}${path}`, {
              headers: {
                Accept: "application/json",
                Authorization: `Bearer ${key}`,
              },
            });
            expect(response.status, path).toBe(200);
            return (await response.json()) as Record<string, any>;
          };
          const mcp = await connectMcp(server.apiUrl, server.workingKey);
          open.push(mcp);
          return {
            root: (await get("/", server.managementKey)).version,
            overview: (await get("/overview", server.workingKey)).instance
              .version,
            metrics: (await get("/metrics", server.managementKey)).process
              .version,
            update: (await get("/update", server.managementKey)).release,
            mcp: mcp.client.getServerVersion()?.version,
          };
        };
        const everywhere = (version: string | undefined) => ({
          root: version,
          overview: version,
          metrics: version,
          update: version,
          mcp: version,
        });
        // The witness: a server with no setting names its own build in each.
        const plain = await read(own);
        expect(plain.root).toBe("0.0.0");
        expect(plain.mcp).not.toBe("1.4.0");
        expect(plain).toEqual(everywhere(plain.root));
        expect(await read(named)).toEqual(everywhere("1.4.0"));

        // A release is newer only past the one named: 1.3.0 is older than 1.4.0
        // and newer than the witness's build, and 1.5.0 is newer than both.
        const available = async (server: FreshServer) => {
          await server.setFault(
            `release-feed=http://127.0.0.1:${(feed.address() as AddressInfo).port}/latest`,
          );
          const operator = operatorOf(server);
          const run = await operator.runHousekeeping("release-check");
          expect(run.data.outcome, JSON.stringify(run.data)).toBe("succeeded");
          const { data } = await operator.getUpdate();
          return { release: data.latest?.release, available: data.available };
        };
        latest = "1.3.0";
        expect(await available(own)).toEqual({
          release: "1.3.0",
          available: true,
        });
        expect(await available(named)).toEqual({
          release: "1.3.0",
          available: false,
        });
        latest = "1.5.0";
        expect(await available(own)).toEqual({
          release: "1.5.0",
          available: true,
        });
        expect(await available(named)).toEqual({
          release: "1.5.0",
          available: true,
        });
      } finally {
        await Promise.all(open.map((mcp) => mcp.close()));
        await Promise.all([named.stop(), own.stop()]);
        await new Promise((resolve) => feed.close(resolve));
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "names MARFA_TEST_CONTRACT_VERSION as the contract in the root, the header and the document",
    async () => {
      const second = await bootFreshServer("test-hooks-contract-second", {
        MARFA_TEST_CONTRACT_VERSION: "2",
      });
      const own = await bootFreshServer("test-hooks-contract-own");
      try {
        const named = async (server: FreshServer) => {
          const root = await fetch(`${server.apiUrl}/`, {
            headers: { Accept: "application/json" },
          });
          const document = await fetch(`${server.apiUrl}/openapi.json`);
          return {
            root: ((await root.json()) as { contract: number }).contract,
            header: root.headers.get("X-Marfa-Contract"),
            document: ((await document.json()) as { info: { version: string } })
              .info.version,
          };
        };
        // The witness: a server with no setting names its own version, which
        // is not 2.
        const built = await named(own);
        expect(built.root).not.toBe(2);
        expect(built).toEqual({
          root: built.root,
          header: String(built.root),
          document: String(built.root),
        });
        expect(await named(second)).toEqual({
          root: 2,
          header: "2",
          document: "2",
        });
      } finally {
        await Promise.all([second.stop(), own.stop()]);
      }
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "holds no fault after a restart",
    async () => {
      const server = await bootFreshServer("test-hooks-faults");
      try {
        await server.setFault("hold:version-thinning:item");
        await server.setFault("deadline:trash-purge=250");
        await server.setFault("fail:commit-full=item.create");
        // The witness: all three are held before the restart, and the failure
        // is aimed at a write the server would otherwise answer.
        expect((await server.faults()).map((fault) => fault.name)).toEqual([
          "hold:version-thinning:item",
          "deadline:trash-purge",
          "fail:commit-full",
        ]);
        const note = (apiUrl: string, key: string) =>
          fetch(`${apiUrl}/items`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              type: "core.note",
              properties: { body: "a fault that does not outlive a restart" },
            }),
          });
        expect((await note(server.apiUrl, server.workingKey)).status).toBe(507);
        await server.setFault("fail:commit-full=item.create");
        await server.restart({ signal: "SIGKILL" });
        expect(await server.faults()).toEqual([]);
        // The write the failure was aimed at lands: the restart cleared it.
        expect((await note(server.apiUrl, server.workingKey)).status).toBe(201);
        await server.setFault("hold:version-thinning:item");
        await server.restart();
        expect(await server.faults()).toEqual([]);
      } finally {
        await server.stop();
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );
});

import { randomBytes } from "node:crypto";
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
import { runJob } from "../../utils/moved-clock.js";

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
    "refuses to start in production with MARFA_TEST_HOOKS true, naming the setting",
    async () => {
      const strong = () => randomBytes(32).toString("hex");
      const production = {
        API_KEY_SALT: strong(),
        MARFA_AUTH_SECRET: strong(),
        MARFA_AUTH_BASE_URL: "https://marfa.example",
        MARFA_TEST_HOOKS: "true",
      };
      const refused = await bootRefused("test-hooks-production", {
        nodeEnv: "production",
        extraEnv: production,
      });
      try {
        expect(refused).toMatchObject({ code: 1, signal: null });
        expect(listened(refused)).toBe(false);
        const lines = settingLines(refused);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(
          /^MARFA_TEST_HOOKS must not be true in production/,
        );
        expect(refused.after).toEqual({
          db: "absent",
          wal: "absent",
          shm: "absent",
        });
      } finally {
        await refused.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
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
          Date.parse((await runJob(server, "rate-limit-cleanup")).started_at);
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
    "holds no fault after a restart",
    async () => {
      const server = await bootFreshServer("test-hooks-faults");
      try {
        await server.setFault("hold:version-thinning:item");
        await server.setFault("deadline:trash-purge=250");
        // The witness: both are held before the restart.
        expect((await server.faults()).map((fault) => fault.name)).toEqual([
          "hold:version-thinning:item",
          "deadline:trash-purge",
        ]);
        await server.restart({ signal: "SIGKILL" });
        expect(await server.faults()).toEqual([]);
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

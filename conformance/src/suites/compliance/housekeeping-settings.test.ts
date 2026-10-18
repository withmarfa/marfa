import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
} from "../../utils/fresh-server.js";
import { jobs, operatorOf, runJob } from "../../utils/moved-clock.js";
import { listened, settingLines } from "../../utils/refused-boot.js";

/**
 * The settings that set how long the server keeps a kind of record: the one
 * rule each has for its value, at boot, and the cleanup job that reads it
 * running at the largest value it accepts.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

/** Counted in days, 0 through 36500. */
const DAYS = [
  "AUDIT_RETENTION_DAYS",
  "TRASH_RETENTION_DAYS",
  "MARFA_INBOUND_HANDLED_RETENTION_DAYS",
  "MARFA_INBOUND_PENDING_RETENTION_DAYS",
  "MARFA_REVOKED_GRANT_RETENTION_DAYS",
  "MARFA_GRANT_INACTIVITY_DAYS",
  "MARFA_DCR_CLIENT_RETENTION_DAYS",
] as const;
const HOURS = "MARFA_EVENT_LOG_RETENTION_HOURS";
const MS = "MARFA_BULK_ACTION_JOB_RETENTION_MS";

const MAX_DAYS = 36_500;
const MAX_HOURS = 876_000;
const MAX_MS = 3_153_600_000_000;

const ALL = [...DAYS, HOURS, MS];

/** The largest value each setting accepts. */
const WIDEST: Record<string, string> = {
  ...Object.fromEntries(DAYS.map((name) => [name, String(MAX_DAYS)])),
  [HOURS]: String(MAX_HOURS),
  [MS]: String(MAX_MS),
};

/** Each setting's way outside its range: past the largest value, below 0,
 *  not whole, and not a number. */
const OUTSIDE = (max: number): string[] => [
  String(max + 1),
  "-1",
  "1.5",
  "soon",
];

const RANGE: Record<string, string> = {
  ...Object.fromEntries(DAYS.map((name) => [name, "from 0 to 36500"])),
  [HOURS]: "from 0 to 876000",
  [MS]: "from 0 to 3153600000000",
};

/** The largest value of each setting, to put one step past. */
const LARGEST = (name: string): number =>
  name === HOURS ? MAX_HOURS : name === MS ? MAX_MS : MAX_DAYS;

/**
 * Four boots, each with every one of the nine settings outside its range at
 * once, the way outside rotating from one boot to the next so that each
 * setting is refused for each way. A refusal names every setting that is
 * outside its rule, so one boot answers for all nine.
 */
const refusals = new Map<string, string[]>();

beforeAll(async () => {
  for (let round = 0; round < 4; round += 1) {
    const env = Object.fromEntries(
      ALL.map((name, index) => [
        name,
        OUTSIDE(LARGEST(name))[(index + round) % 4]!,
      ]),
    );
    const refused = await bootRefused("retention-settings", { extraEnv: env });
    try {
      expect(refused).toMatchObject({ code: 1, signal: null });
      expect(listened(refused)).toBe(false);
      refusals.set(JSON.stringify(env), settingLines(refused));
    } finally {
      await refused.stop();
    }
  }
}, 8 * FRESH_SERVER_TIMEOUT_MS);

/** Asserts every boot refused each of `names` for the value it was given. */
function expectRefused(names: readonly string[]): void {
  expect(refusals.size).toBe(4);
  for (const [given, lines] of refusals) {
    const env = JSON.parse(given) as Record<string, string>;
    for (const name of names) {
      const line = lines.find((l) => l.startsWith(`${name} `));
      expect(line, `${name} = ${env[name]}`).toBe(
        `${name} must be a whole number, ${RANGE[name]} (got "${env[name]}")`,
      );
    }
    // Nothing else was named.
    expect(lines.map((l) => l.split(" ")[0]).sort()).toEqual([...ALL].sort());
  }
}

describe("a retention setting outside its range", () => {
  it("refuses a value of the day settings that is not a whole number from 0 through 36500, and names the setting", () => {
    expectRefused(DAYS);
  });

  it("refuses MARFA_EVENT_LOG_RETENTION_HOURS outside 0 through 876000, and names the setting", () => {
    expectRefused([HOURS]);
  });

  it("refuses MARFA_BULK_ACTION_JOB_RETENTION_MS outside 0 through 3153600000000, and names the setting", () => {
    expectRefused([MS]);
  });
});

describe("a retention setting inside its range", () => {
  it(
    "starts with each setting empty, and with each at its smallest",
    async () => {
      // The witness for the refusals above: the settings are read, and the
      // ends of their ranges are not what is refused.
      for (const value of ["", "0"]) {
        const server = await bootFreshServer(
          "retention-settings-inside",
          Object.fromEntries(ALL.map((name) => [name, value])),
        );
        try {
          const listed = await operatorOf(server).listHousekeeping();
          expect(listed.status).toBe(200);
        } finally {
          await server.stop();
        }
      }
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "finishes each cleanup job that reads a retention setting at the largest value with last_outcome ok",
    async () => {
      const server = await bootFreshServer("retention-settings-widest", WIDEST);
      try {
        const readers = [
          "audit-cleanup",
          "trash-purge",
          "event-log-cleanup",
          "inbound-delivery-cleanup",
          "revoked-grant-purge",
          "grant-inactivity-retirement",
          "dcr-client-cleanup",
          "bulk-action-gc",
        ];
        // Listed, so each can be run.
        const listed = await jobs(server);
        for (const name of readers) {
          expect(Object.keys(listed), name).toContain(name);
        }
        for (const name of readers) {
          const run = await runJob(server, name);
          expect(run.outcome, `${name}: ${String(run.error)}`).toBe("ok");
        }
        const after = await jobs(server);
        for (const name of readers) {
          expect(after[name]?.last_outcome, name).toBe("ok");
        }
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});

import { afterAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { storeSettingRow } from "../../utils/instance-database.js";
import { listened, settingLines } from "../../utils/refused-boot.js";

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Entry {
  key: string;
  value: unknown;
  default: unknown;
}

async function entryOf(server: FreshServer, key: string): Promise<Entry> {
  const listed = await fetch(`${server.apiUrl}/config/settings`, {
    headers: { Authorization: `Bearer ${server.managementKey}` },
  });
  expect(listed.status).toBe(200);
  const found = ((await listed.json()) as { data: Entry[] }).data.find(
    (entry) => entry.key === key,
  );
  expect(found, key).toBeDefined();
  return found!;
}

async function patch(server: FreshServer, body: unknown): Promise<number> {
  const answer = await fetch(`${server.apiUrl}/config`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${server.managementKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return answer.status;
}

describe("a stored setting named in the environment", () => {
  it("starts at the value the environment gives, and a value stored for it stays in force over the variable", async () => {
    // The witness: without the variable the setting starts at its default.
    const plain = await bootFreshServer("settings-seed-plain");
    expect(await entryOf(plain, "trash_retention_days")).toMatchObject({
      value: 60,
      default: 60,
    });

    const seeded = await bootFreshServer("settings-seed", {
      MARFA_TRASH_RETENTION_DAYS: "5",
    });
    expect(await entryOf(seeded, "trash_retention_days")).toMatchObject({
      value: 5,
      default: 5,
    });

    expect(await patch(seeded, { trash_retention_days: 9 })).toBe(200);
    expect(await entryOf(seeded, "trash_retention_days")).toMatchObject({
      value: 9,
      default: 5,
    });
    // The variable is still set on the next start, and the stored value wins.
    await seeded.restart();
    expect(await entryOf(seeded, "trash_retention_days")).toMatchObject({
      value: 9,
      default: 5,
    });

    // Clearing the stored value returns to what the variable gives.
    expect(await patch(seeded, { trash_retention_days: null })).toBe(200);
    expect(await entryOf(seeded, "trash_retention_days")).toMatchObject({
      value: 5,
      default: 5,
    });
  });
});

describe("the tuning of a server with test hooks", () => {
  it("lists a job at the interval the tuning gives it, and another at its own", async () => {
    const tuned = await bootFreshServer("settings-tuning", {
      MARFA_TEST_TUNING: "interval.credential-cleanup=61000",
    });
    const listed = await fetch(`${tuned.apiUrl}/housekeeping`, {
      headers: { Authorization: `Bearer ${tuned.managementKey}` },
    });
    expect(listed.status).toBe(200);
    const jobs = (
      (await listed.json()) as {
        data: { name: string; interval_ms: number }[];
      }
    ).data;
    const interval = (name: string) =>
      jobs.find((job) => job.name === name)?.interval_ms;
    expect(interval("credential-cleanup")).toBe(61_000);
    expect(interval("audit-cleanup")).toBe(86_400_000);
  });

  it("refuses a tuning without MARFA_TEST_HOOKS, naming the setting", async () => {
    const refused = await bootRefused("settings-tuning-no-hooks", {
      extraEnv: {
        MARFA_TEST_HOOKS: "false",
        MARFA_TEST_TUNING: "interval.audit-cleanup=5",
      },
    });
    try {
      expect(refused).toMatchObject({ code: 1, signal: null });
      expect(listened(refused)).toBe(false);
      const lines = settingLines(refused);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        /^MARFA_TEST_TUNING needs MARFA_TEST_HOOKS to be true \(got ".*interval\.audit-cleanup=5"\)$/,
      );
    } finally {
      await refused.stop();
    }
  });

  it("refuses a tuning that names a timing the server does not have", async () => {
    const refused = await bootRefused("settings-tuning-unknown", {
      extraEnv: { MARFA_TEST_TUNING: "interval.no-such-job=5" },
    });
    try {
      expect(refused).toMatchObject({ code: 1, signal: null });
      expect(listened(refused)).toBe(false);
      const lines = settingLines(refused);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^MARFA_TEST_TUNING /);
    } finally {
      await refused.stop();
    }
  });
});

describe("a setting the server does not have", () => {
  it("starts with a row the server has no setting for, leaves it out of the configuration, and refuses it in a write", async () => {
    const own = await bootFreshServer("settings-unknown-row");
    const old = "audit_cleanup_interval_ms";
    await own.restart(() => {
      storeSettingRow(own.sqlitePath, old, "3600000");
    });

    const headers = { Authorization: `Bearer ${own.managementKey}` };
    expect((await fetch(`${own.apiUrl}/health`)).status).toBe(200);
    const listed = await fetch(`${own.apiUrl}/config/settings`, { headers });
    expect(listed.status).toBe(200);
    const keys = ((await listed.json()) as { data: Entry[] }).data.map(
      (entry) => entry.key,
    );
    expect(keys).toContain("trash_retention_days");
    expect(keys).not.toContain(old);
    const config = await fetch(`${own.apiUrl}/config`, { headers });
    expect(await config.json()).not.toHaveProperty(old);

    const refused = await fetch(`${own.apiUrl}/config`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ [old]: 20, trash_retention_days: 11 }),
    });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as {
      error: { code: string; details: { unknown_body_fields: string[] } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details.unknown_body_fields).toEqual([old]);
    expect(await entryOf(own, "trash_retention_days")).toMatchObject({
      stored: null,
    });
  });
});

describe("a duration an owner sets, in seconds", () => {
  it("is taken at each bound through /config and refused one past it", async () => {
    const own = await bootFreshServer("settings-seconds-bounds");
    const bounds: [string, number, number][] = [
      ["rate_limit_window_seconds", 1, 86_400],
      ["mcp_fetch_timeout_seconds", 1, 3_600],
      ["backup_interval_seconds", 0, 31_536_000],
      ["blob_cleanup_grace_seconds", 0, 31_536_000],
    ];
    for (const [key, least, most] of bounds) {
      for (const value of [least, most]) {
        expect(
          await patch(own, { [key]: value }),
          `${key} ${String(value)}`,
        ).toBe(200);
        expect(await entryOf(own, key)).toMatchObject({ value });
      }
      expect(await patch(own, { [key]: most + 1 }), key).toBe(400);
      if (least > 0)
        expect(await patch(own, { [key]: least - 1 }), key).toBe(400);
      expect(await entryOf(own, key)).toMatchObject({ value: most });
    }
  });

  it("refuses a seed below the minimum its rule takes, naming the setting", async () => {
    const refused = await bootRefused("settings-seed-below-minimum", {
      extraEnv: { MARFA_RATE_LIMIT_WINDOW_SECONDS: "0" },
    });
    try {
      expect(refused).toMatchObject({ code: 1, signal: null });
      expect(settingLines(refused)).toEqual([
        'MARFA_RATE_LIMIT_WINDOW_SECONDS must be a whole number, from 1 to 86400 (got "0")',
      ]);
    } finally {
      await refused.stop();
    }
  });
});

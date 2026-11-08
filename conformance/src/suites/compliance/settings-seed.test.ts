import { afterAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A stored setting's default taken from the environment while the test hooks
 * are on (the instance chapter's `instance/settings-seed`).
 */

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

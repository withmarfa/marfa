import { expect } from "vitest";
import type { MarfaClient } from "../client/api.js";
import type { FreshServer } from "./fresh-server.js";
import { runJob } from "./moved-clock.js";

/**
 * What a fixture of the `version-thinning` job shares: a type that declares a
 * version policy, an item with a history, and the versions an item still
 * holds after a run.
 */

let sequence = 0;

/** Registers a type, with the version policy when one is given, and answers its id. */
export async function register(
  client: MarfaClient,
  version_policy?: object,
): Promise<string> {
  sequence += 1;
  const id = `user.thinning-${String(Date.now())}-${String(sequence)}`;
  const registered = await client.registerType({
    id,
    fields: { title: { type: "string" } },
    ...(version_policy !== undefined && { version_policy }),
  } as Parameters<MarfaClient["registerType"]>[0]);
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  return id;
}

/** Creates an item of the type at the server's time now, which is its first snapshot. */
export async function item(client: MarfaClient, type: string): Promise<string> {
  const created = await client.createItem({
    type,
    properties: { title: "v1" },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.item.id;
}

/** Writes `count` updates at the server's time now, each leaving a snapshot. */
export async function update(
  client: MarfaClient,
  id: string,
  count: number,
): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    const current = await client.getItem(id);
    const updated = await client.updateItem(id, {
      properties: { title: `v${String(current.data.item.version + 1)}` },
      version: current.data.item.version,
    });
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
  }
}

/** The versions of an item's snapshots, oldest first. */
export async function history(
  client: MarfaClient,
  id: string,
): Promise<number[]> {
  const versions = await client.getVersions(id);
  expect(versions.status, JSON.stringify(versions.error)).toBe(200);
  return versions.data.data.map((v) => v.version);
}

/** Runs the `version-thinning` job and expects it to end well. */
export async function thin(server: FreshServer): Promise<void> {
  const run = await runJob(server, "version-thinning");
  expect(run.outcome, String(run.error)).toBe("ok");
}

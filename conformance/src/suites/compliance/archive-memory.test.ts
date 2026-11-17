import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { archiveLines } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { clientsFor } from "../../utils/own-blob-server.js";
import { readServerMemory } from "../../utils/scale/memory.js";

/**
 * What an archive export of large items holds in the server's memory, on a
 * server of the fixture's own. A backup reads its items the same way. The
 * bound is in bytes, so neither the number nor the size of the items, nor how
 * many versions one keeps, moves it.
 */
const NOTES = 96;
/** Near the longest a note body may be. */
const BIG_BYTES = 990_000;
const VERSIONS = 40;
/** Well under what a page of 500 items, or every version of one, held. */
const BOUND_MIB = 48;
const SAMPLE_MS = 20;

let server: FreshServer | undefined;
let working: MarfaClient;
const notes: string[] = [];
let versioned = "";

const residentMiB = () =>
  readServerMemory(
    Number(readFileSync(join(server!.stateDir, "server.pid"), "utf8").trim()),
  ).rssMb;

function body(label: string): string {
  return `${label} `.padEnd(BIG_BYTES, "lorem ipsum ");
}

beforeAll(async () => {
  server = await bootFreshServer("archive-memory");
  ({ working } = clientsFor(server));
  for (let at = 0; at < NOTES; at += 1) {
    const made = await working.createItem({
      type: "core.note",
      properties: { title: `large ${at}`, body: body(`large ${at}`) },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    notes.push(made.data.item.id);
  }
  const made = await working.createItem({
    type: "core.note",
    properties: { title: "versioned", body: body("version 1") },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  versioned = made.data.item.id;
  let version = made.data.item.version;
  for (let at = 2; at <= VERSIONS; at += 1) {
    const patched = await working.updateItem(versioned, {
      properties: { body: body(`version ${at}`) },
      version,
    });
    expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
    version = patched.data.item.version;
  }
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

describe("what an archive export of large items holds in memory", () => {
  it("holds a bounded amount while it reads near-limit items and many large versions, and carries each whole", async () => {
    const before = residentMiB();
    let peak = before;
    const sampling = setInterval(() => {
      peak = Math.max(peak, residentMiB());
    }, SAMPLE_MS);
    let archive: Uint8Array;
    try {
      const response = await fetch(`${server!.apiUrl}/export?format=archive`, {
        headers: { Authorization: `Bearer ${server!.workingKey}` },
      });
      expect(response.status).toBe(200);
      archive = new Uint8Array(await response.arrayBuffer());
    } finally {
      clearInterval(sampling);
    }
    console.info(
      `archive memory: ${before.toFixed(1)} MiB before, ${peak.toFixed(1)} MiB at the peak`,
    );
    expect(peak - before).toBeLessThan(BOUND_MIB);

    const items = archiveLines<{
      item: { id: string; properties: { body: string } };
    }>(archive, "items");
    expect(items.map((line) => line.item.id)).toEqual([...notes, versioned]);
    for (const line of items) {
      expect(line.item.properties.body).toHaveLength(BIG_BYTES);
    }
    const versions = archiveLines<{
      item_id: string;
      version: number;
      properties: { body: string };
    }>(archive, "versions");
    expect(versions.map((line) => line.item_id)).toEqual(
      Array(VERSIONS - 1).fill(versioned),
    );
    expect(versions.map((line) => line.properties.body.length)).toEqual(
      Array(VERSIONS - 1).fill(BIG_BYTES),
    );
  });
});

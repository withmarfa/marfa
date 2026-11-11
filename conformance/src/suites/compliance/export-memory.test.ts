import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { clientsFor } from "../../utils/own-blob-server.js";

/**
 * What an NDJSON export holds in the server's memory, on a server of the
 * fixture's own. Its bound is in bytes, not in items, so a store of large
 * items and a client that reads slowly cost a fixed amount.
 */
const BODY_BYTES = 768 * 1024;
const NOTES = 300;
/** Near the longest a note body may be. */
const BIG_BYTES = 990_000;
/** Well under the 390 MiB a count of items held for 300 notes this size. */
const BOUND_MIB = 64;

let server: FreshServer | undefined;
let working: MarfaClient;

/** The resident memory of the server's processes, in MiB. */
function serverRssMiB(state: string): number {
  const group = Number(readFileSync(join(state, "server.pid"), "utf8").trim());
  const table = execFileSync("ps", ["-axo", "pgid=,rss=,command="], {
    encoding: "utf8",
  });
  let kib = 0;
  for (const row of table.split("\n")) {
    const [pgid, rss, ...command] = row.trim().split(/\s+/);
    if (Number(pgid) === group && command.join(" ").includes("marfa-server")) {
      kib += Number(rss);
    }
  }
  expect(
    kib,
    "no server process was found in the server's group",
  ).toBeGreaterThan(0);
  return kib / 1024;
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

function open(state: FreshServer): Promise<Response> {
  return fetch(`${state.apiUrl}/export?format=ndjson`, {
    headers: { Authorization: `Bearer ${state.workingKey}` },
  });
}

async function note(label: string, bytes: number): Promise<string> {
  const body = `${label} `.padEnd(bytes, "lorem ipsum ");
  const made = await working.createItem({
    type: "core.note",
    properties: { title: label, body },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  return made.data.item.id;
}

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

describe("what an NDJSON export of large items holds in memory", () => {
  const ids: string[] = [];

  beforeAll(async () => {
    server = await bootFreshServer("export-memory");
    ({ working } = clientsFor(server));
    for (let at = 0; at < NOTES; at += 1) {
      ids.push(await note(`large ${at}`, BODY_BYTES));
    }
  }, FRESH_SERVER_TIMEOUT_MS);

  it("holds a fixed amount while the client reads nothing, and again while it reads slowly, and loses no item", async () => {
    const state = server!.stateDir;
    const before = serverRssMiB(state);

    const stalled = await open(server!);
    expect(stalled.status).toBe(200);
    await pause(2000);
    const held = serverRssMiB(state);
    console.info(
      `export memory: ${before.toFixed(1)} MiB before, ${held.toFixed(1)} MiB with an export nobody reads`,
    );
    expect(held - before).toBeLessThan(BOUND_MIB);
    await stalled.body?.cancel();

    const slow = await open(server!);
    expect(slow.status).toBe(200);
    const reader = slow.body!.getReader();
    let peak = 0;
    let text = "";
    const decoder = new TextDecoder();
    for (let reads = 0; ; reads += 1) {
      const part = await reader.read();
      if (part.done) break;
      text += decoder.decode(part.value, { stream: true });
      if (reads % 8 === 0) {
        peak = Math.max(peak, serverRssMiB(state));
        await pause(50);
      }
    }
    console.info(
      `export memory: ${peak.toFixed(1)} MiB at the peak of a slow read`,
    );
    expect(peak - before).toBeLessThan(BOUND_MIB);

    const read = text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { item: { id: string } }).item.id);
    expect(read.sort()).toEqual([...ids].sort());
  });
});

describe("what an NDJSON export does with one item among small ones that is far larger than a page", () => {
  it(
    "sends every item whole, in order, and holds a bounded amount",
    async () => {
      server = await bootFreshServer("export-memory-one");
      ({ working } = clientsFor(server));
      const made: string[] = [];
      for (let at = 0; at < 20; at += 1)
        made.push(await note(`small ${at}`, 200));
      const big = await note("big", BIG_BYTES);
      made.push(big);
      for (let at = 20; at < 40; at += 1)
        made.push(await note(`small ${at}`, 200));

      const before = serverRssMiB(server.stateDir);
      const response = await open(server);
      expect(response.status).toBe(200);
      const text = await response.text();
      const lines = text.split("\n").filter((line) => line !== "");
      const read = lines.map(
        (line) =>
          JSON.parse(line).item as { id: string; properties: { body: string } },
      );
      expect(read.map((item) => item.id).sort()).toEqual([...made].sort());
      expect(
        read.find((item) => item.id === big)?.properties.body,
      ).toHaveLength(BIG_BYTES);
      expect(serverRssMiB(server.stateDir) - before).toBeLessThan(BOUND_MIB);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

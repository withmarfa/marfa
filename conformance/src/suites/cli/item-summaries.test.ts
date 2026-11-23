import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  instanceIdOf,
  itemLinks,
  unsetSignInOrigin,
} from "../../utils/item-links.js";
import { MarfaClient } from "../../client/api.js";
import { Cli, releaseHeld, requireBinary } from "./harness.js";
let server: FreshServer;
let cli: Cli;
beforeAll(async () => {
  server = await bootFreshServer("cli-item-summaries");
  cli = new Cli(requireBinary(), server.apiUrl, server.workingKey);
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  releaseHeld();
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

it("lists and searches names through local authority without item content", async () => {
  for (const title of ["Chosen first", "Other", "Chosen last"]) {
    await cli.json([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title, body: "private-body-witness Chosen" }),
    ]);
  }
  const local = cli.viaSocket(server.controlSocket);
  const first = await local.json<{
    data: { id: string; name: string; web_url: string; app_url: string }[];
    next_cursor: string;
  }>([
    "items",
    "summaries",
    "--type",
    "core.note",
    "--query",
    "chosen",
    "--limit",
    "1",
  ]);
  expect(first.data.map((row) => row.name)).toEqual(["Chosen last"]);
  expect(first.next_cursor).toBeTypeOf("string");
  expect(first.next_cursor.length).toBeLessThanOrEqual(100);
  const next = await local.json<{
    data: { name: string }[];
    next_cursor: null;
  }>([
    "items",
    "summaries",
    "--type",
    "core.note",
    "--query",
    "chosen",
    "--limit",
    "1",
    "--cursor",
    first.next_cursor,
  ]);
  expect(next.data.map((row) => row.name)).toEqual(["Chosen first"]);
  expect(next.next_cursor).toBeNull();
  expect(JSON.stringify([first, next])).not.toContain("private-body-witness");
  const row = first.data[0]!;
  expect(Object.keys(row).sort()).toEqual([
    "app_url",
    "created_at",
    "id",
    "name",
    "source",
    "type",
    "version",
    "web_url",
  ]);
  const instance = await instanceIdOf(server.apiUrl, server.workingKey);
  expect({ web_url: row.web_url, app_url: row.app_url }).toEqual(
    itemLinks(unsetSignInOrigin(server.apiUrl), instance, row.id),
  );
});

it("manages trash through local authority with summary responses", async () => {
  const created = await cli.json<{ item: { id: string; version: number } }>([
    "items",
    "create",
    "--type",
    "core.note",
    "--properties",
    JSON.stringify({ title: "CLI trash witness", body: "private-trash-body" }),
  ]);
  const local = cli.viaSocket(server.controlSocket);
  const id = created.item.id;
  const version = String(created.item.version);
  for (const action of ["trash", "restore", "trash"]) {
    const result = await local.json([
      "items",
      action,
      id,
      "--version",
      version,
    ]);
    expect(JSON.stringify(result)).not.toContain("private-trash-body");
  }
  const page = await local.json<{
    data: { id: string; trashed_by: { kind: string } }[];
  }>(["items", "bin", "list"]);
  expect(page.data.find((row) => row.id === id)?.trashed_by.kind).toBe("local");
  await local.json(["items", "purge", id, "--version", version]);
  const result = await local.json<{ purged: number; failures: unknown[] }>([
    "items",
    "bin",
    "empty",
    "--confirm",
    "PURGE",
  ]);
  expect(result.failures).toEqual([]);
});

it("stops an uncertain bin emptying and exposes its outcome through the real socket CLI", async () => {
  const local = cli.viaSocket(server.controlSocket);
  const ids: string[] = [];
  for (const title of ["Before uncertainty", "Uncertain item"]) {
    const created = await cli.json<{ item: { id: string } }>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title, body: "private-body-witness" }),
    ]);
    ids.push(created.item.id);
    await local.json(["items", "trash", created.item.id, "--version", "1"]);
  }
  await server.setFault("fail:commit=item.purge");
  try {
    const stopped = await local.run([
      "--json",
      "items",
      "bin",
      "empty",
      "--confirm",
      "PURGE",
    ]);
    expect(stopped.code).not.toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({
      purged: 0,
      failures: [{ details: { write_outcome: "unknown" } }],
    });
    expect((await server.faults()).some((fault) => fault.fired > 0)).toBe(true);
  } finally {
    await server.clearFault();
  }
  const page = await local.json<{
    data: { id: string; eligible_for_deletion_at: string }[];
  }>(["items", "bin", "list"]);
  expect(page.data.filter((row) => ids.includes(row.id))).toHaveLength(2);
  expect(page.data[0]!.eligible_for_deletion_at).toMatch(/^\d{4}-/);
  const shown = await local.run(["items", "bin", "list"]);
  expect(shown.code).toBe(0);
  expect(shown.stdout).toContain("eligible from");
  await server.setFault("fail:commit=item.purge");
  try {
    const shown = await local.run([
      "items",
      "bin",
      "empty",
      "--confirm",
      "PURGE",
    ]);
    expect(shown.code).not.toBe(0);
    expect(shown.stderr).toContain("deletion could not be confirmed");
    expect(shown.stdout).not.toContain("more: --cursor");
  } finally {
    await server.clearFault();
  }
  await server.setFault("fail:commit=item.purge");
  try {
    const single = await local.run([
      "items",
      "purge",
      ids[0]!,
      "--version",
      "1",
    ]);
    expect(single.code).not.toBe(0);
    expect(single.stderr).toContain("could not be confirmed");
  } finally {
    await server.clearFault();
  }
});

async function fillBinThroughClient(count: number): Promise<number> {
  const client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  const made = await client.bulkItems(
    Array.from({ length: count }, (_, at) => ({
      type: "core.note",
      properties: { title: `Bin witness ${String(at)}` },
    })),
  );
  expect(made.status, JSON.stringify(made.error)).toBe(200);
  const ids = made.data.results.map((row) => row.id!);
  for (let at = 0; at < ids.length; at += 20) {
    const moved = await client.trashItems(ids.slice(at, at + 20));
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
  }
  const listed = await cli
    .viaSocket(server.controlSocket)
    .json<{ data: { id: string }[]; next_cursor: null }>([
      "items",
      "bin",
      "list",
      "--all",
      "--limit",
      "50",
    ]);
  expect(listed.next_cursor).toBeNull();
  expect(new Set(listed.data.map((row) => row.id)).size).toBe(
    listed.data.length,
  );
  expect(listed.data.length).toBeGreaterThanOrEqual(count);
  return listed.data.length;
}

const emptyBin = () =>
  cli
    .viaSocket(server.controlSocket)
    .run(["items", "bin", "empty", "--confirm", "PURGE"]);

it("sends each batch's cursor back until the server names none, so a bin of more than 200 empties in one command", async () => {
  await fillBinThroughClient(230);
  const emptied = await emptyBin();
  expect(emptied.code, emptied.stderr).toBe(0);
  const after = await cli
    .viaSocket(server.controlSocket)
    .json<{ data: unknown[] }>(["items", "bin", "list"]);
  expect(after.data).toEqual([]);
});

it("prints how many items have been deleted so far after each batch that has another to follow, and the total at the end", async () => {
  const held = await fillBinThroughClient(230);
  const emptied = await emptyBin();
  expect(emptied.code, emptied.stderr).toBe(0);
  const said = emptied.stdout.trim().split("\n");
  expect(said).toEqual([
    "200 items deleted so far",
    `${String(held)} items deleted from the bin`,
  ]);
});

it("exits 0 when no deletion was left unconfirmed", async () => {
  await fillBinThroughClient(3);
  const emptied = await emptyBin();
  expect(emptied.code, emptied.stderr).toBe(0);
  const again = await emptyBin();
  expect(again.code, again.stderr).toBe(0);
});

it("prints one JSON object of purged, stayed and failures under --json, with no line for a batch", async () => {
  const held = await fillBinThroughClient(230);
  const emptied = await cli
    .viaSocket(server.controlSocket)
    .json<{ purged: number; stayed: number; failures: unknown[] }>([
      "items",
      "bin",
      "empty",
      "--confirm",
      "PURGE",
    ]);
  expect(emptied).toEqual({ purged: held, stayed: 0, failures: [] });
  const again = await cli
    .viaSocket(server.controlSocket)
    .json<{ purged: number; stayed: number; failures: unknown[] }>([
      "items",
      "bin",
      "empty",
      "--confirm",
      "PURGE",
    ]);
  expect(again).toEqual({ purged: 0, stayed: 0, failures: [] });
});

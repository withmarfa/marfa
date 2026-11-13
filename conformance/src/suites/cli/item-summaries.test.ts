import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
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
    data: { name: string }[];
    next_cursor: string;
  }>([
    "items",
    "summaries",
    "--type",
    "core.note",
    "--q",
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
    "--q",
    "chosen",
    "--limit",
    "1",
    "--cursor",
    first.next_cursor,
  ]);
  expect(next.data.map((row) => row.name)).toEqual(["Chosen first"]);
  expect(next.next_cursor).toBeNull();
  expect(JSON.stringify([first, next])).not.toContain("private-body-witness");
  expect(Object.keys(first.data[0]!).sort()).toEqual([
    "created_at",
    "id",
    "name",
    "source",
    "type",
    "version",
  ]);
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
  for (const action of ["move", "restore", "move"]) {
    const result = await local.json([
      "items",
      "bin",
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
  await local.json(["items", "bin", "purge", id, "--version", version]);
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
    await local.json([
      "items",
      "bin",
      "move",
      created.item.id,
      "--version",
      "1",
    ]);
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
      "bin",
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

it("pages the bin and empties it by itself, saying how many have gone", async () => {
  const client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  const made = await client.bulkItems(
    Array.from({ length: 230 }, (_, at) => ({
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
  const local = cli.viaSocket(server.controlSocket);

  const listed = await local.json<{
    data: { id: string }[];
    next_cursor: null;
  }>(["items", "bin", "list", "--all", "--limit", "50"]);
  const held = listed.data.length;
  expect(held).toBeGreaterThanOrEqual(230);
  expect(listed.next_cursor).toBeNull();
  expect(new Set(listed.data.map((row) => row.id)).size).toBe(held);

  const emptied = await local.run([
    "items",
    "bin",
    "empty",
    "--confirm",
    "PURGE",
  ]);
  expect(emptied.code, emptied.stderr).toBe(0);
  const said = emptied.stdout.trim().split("\n");
  expect(said[0]).toBe("200 items deleted so far");
  expect(said.at(-1)).toBe(`${String(held)} items deleted from the bin`);
  const after = await local.json<{ data: unknown[] }>(["items", "bin", "list"]);
  expect(after.data).toEqual([]);

  const again = await local.json<{ purged: number; failures: unknown[] }>([
    "items",
    "bin",
    "empty",
    "--confirm",
    "PURGE",
  ]);
  expect(again).toEqual({ purged: 0, failures: [] });
});

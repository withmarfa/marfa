import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
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
      "trash",
      action,
      id,
      "--version",
      version,
    ]);
    expect(JSON.stringify(result)).not.toContain("private-trash-body");
  }
  const page = await local.json<{
    data: { id: string; trashed_by: { kind: string } }[];
  }>(["items", "trash", "list"]);
  expect(page.data.find((row) => row.id === id)?.trashed_by.kind).toBe("local");
  await local.json(["items", "trash", "purge", id, "--version", version]);
  const result = await local.json<{ purged: number; failures: unknown[] }>([
    "items",
    "trash",
    "empty",
    "--confirm",
    "PURGE",
  ]);
  expect(result.failures).toEqual([]);
});

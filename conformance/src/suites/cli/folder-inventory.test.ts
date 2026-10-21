import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { Cli, requireBinary } from "./harness.js";
let server: FreshServer;
let local: Cli, key: Cli;
beforeAll(async () => {
  server = await bootFreshServer("cli-folder-inventory");
  const binary = requireBinary();
  local = new Cli(binary, server.apiUrl, undefined, server.controlSocket);
  key = new Cli(binary, server.apiUrl, server.workingKey);
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);
it("pages the server inventory through the private socket without reading the local registry", async () => {
  await key.json(["folders", "create", "--title", "First"]);
  await key.json(["folders", "create", "--title", "Second"]);
  const first = await local.json<{
    data: { id: string; title: string }[];
    next_cursor: string;
  }>(["folders", "inventory", "--limit", "1"]);
  expect(first.data).toHaveLength(1);
  expect(first.next_cursor).toBeTruthy();
  const second = await local.json<typeof first>([
    "folders",
    "inventory",
    "--limit",
    "1",
    "--cursor",
    first.next_cursor,
  ]);
  expect(second.data).toHaveLength(1);
  expect(second.data[0]?.id).not.toBe(first.data[0]?.id);
  expect(second.next_cursor).toBeNull();
  const refused = await key.refused(["folders", "inventory"]);
  expect(refused.envelope.error.code).toBe("forbidden");
});

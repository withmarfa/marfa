import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { Cli, requireBinary } from "./harness.js";

let server: FreshServer;
let cli: Cli;
const dir = tempFolder("marfa-cli-refusals-");

beforeAll(async () => {
  server = await bootFreshServer("cli-refusals");
  cli = new Cli(requireBinary(), server.apiUrl, server.workingKey);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

it("ends a stale-version refusal the same way from a command that goes through the device core as from a direct one", async () => {
  const created = await cli.json<{ item: { id: string; version: number } }>([
    "folders",
    "create",
    "--title",
    "Refusals",
    "--query",
    JSON.stringify({ types: ["core.note"] }),
  ]);
  const id = created.item.id;
  const stale = ["--version", "9", "--title", "Changed"];
  const store = join(dir, "copy");
  await cli.json([
    "device",
    "--db",
    store,
    "hydrate",
    "--type",
    "system.folder",
    "--tier",
    "library",
  ]);

  const direct = await cli.refused(["folders", "update", id, ...stale]);
  const throughCore = await cli.refused([
    "device",
    "--db",
    store,
    "folders",
    "update",
    id,
    ...stale,
  ]);
  expect(direct.code).toBe(1);
  expect(direct.envelope.error.code).toBe("conflict");
  expect(direct.envelope.error.server?.status).toBe(409);
  expect(throughCore.code).toBe(direct.code);
  expect(throughCore.envelope.exit).toBe(direct.envelope.exit);
  expect(throughCore.envelope.error.code).toBe(direct.envelope.error.code);
  expect(throughCore.envelope.error.server?.status).toBe(409);
  expect(throughCore.envelope.error.server?.code).toBe(
    direct.envelope.error.server?.code,
  );
  expect(throughCore.envelope.error.server?.code).toBeTruthy();

  const text = async (args: string[]) => (await cli.run(args)).code;
  expect(
    await text(["device", "--db", store, "folders", "update", id, ...stale]),
  ).toBe(await text(["folders", "update", id, ...stale]));
  expect(await text(["folders", "update", id, ...stale])).toBe(1);
});

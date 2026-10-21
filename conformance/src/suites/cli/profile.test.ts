import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { Cli, requireBinary } from "./harness.js";
let server: FreshServer;
let local: Cli, delegated: Cli;
beforeAll(async () => {
  server = await bootFreshServer("cli-profile");
  const binary = requireBinary();
  local = new Cli(binary, server.apiUrl, undefined, server.controlSocket);
  delegated = new Cli(binary, server.apiUrl, server.workingKey);
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);
it("changes owner through the private socket and profile through its credential", async () => {
  const previous = await local.json<{
    id: string;
    email: string;
    name: string;
  }>(["owner", "show"]);
  const changed = await local.json<{ id: string; email: string; name: string }>(
    [
      "owner",
      "update",
      "--email",
      "Updated@Example.test",
      "--name",
      "CLI owner",
    ],
  );
  expect(changed).toMatchObject({
    id: previous.id,
    email: "updated@example.test",
    name: "CLI owner",
  });
  const pictured = await local.json<{ avatar: string | null }>([
    "owner",
    "update",
    "--avatar",
    "https://example.test/owner.png",
  ]);
  expect(pictured.avatar).toBe("https://example.test/owner.png");
  expect(
    (await local.json<{ avatar: string | null }>(["owner", "show"])).avatar,
  ).toBe("https://example.test/owner.png");
  const cleared = await local.json<{ avatar: string | null }>([
    "owner",
    "update",
    "--clear-avatar",
  ]);
  expect(cleared.avatar).toBeNull();
  const refused = await delegated
    .as(undefined)
    .refused(["owner", "update", "--name", "No"]);
  expect(refused.envelope.error.message).toContain("--socket PATH");
  expect(
    await delegated.json([
      "profile",
      "update",
      "--name",
      "CLI profile",
      "--avatar",
      "https://example.test/picture.png",
    ]),
  ).toEqual({ ok: true });
  expect((await local.json<{ name: string }>(["owner", "show"])).name).toBe(
    "CLI profile",
  );
  expect(await delegated.json(["profile", "update", "--clear-avatar"])).toEqual(
    { ok: true },
  );
});

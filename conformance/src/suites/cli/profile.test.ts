import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { gif, png } from "../../utils/pictures.js";
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
  const refused = await delegated
    .as(undefined)
    .refused(["owner", "update", "--name", "No"]);
  expect(refused.envelope.error.message).toContain("--socket PATH");
  expect(
    await delegated.json(["profile", "update", "--name", "CLI profile"]),
  ).toEqual({ ok: true });
  expect((await local.json<{ name: string }>(["owner", "show"])).name).toBe(
    "CLI profile",
  );
});

it("uploads, fetches and removes the owner's picture from a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marfa-cli-picture-"));
  try {
    const sent = png(16, 16);
    const file = join(dir, "me.png");
    await writeFile(file, sent);
    const owner = () =>
      local.json<{ avatar: string | null }>(["owner", "show"]);
    expect((await owner()).avatar).toBeNull();

    // The witness for the refusals below: this file is taken.
    const pictured = await local.json<{ avatar: string | null }>([
      "owner",
      "update",
      "--avatar",
      file,
    ]);
    expect(pictured.avatar).toMatch(/\/owner\/picture$/);
    expect((await owner()).avatar).toBe(pictured.avatar);
    const fetched = join(dir, "fetched.png");
    await local.json(["owner", "picture", "--output", fetched]);
    expect((await readFile(fetched)).equals(sent)).toBe(true);

    // The name says PNG and the bytes say GIF: the server's word is shown.
    const lie = join(dir, "lie.png");
    await writeFile(lie, gif());
    const refusedKind = await local.refused([
      "owner",
      "update",
      "--avatar",
      lie,
    ]);
    expect(refusedKind.envelope.error.message).toContain(
      "Use a PNG, JPEG or WebP picture.",
    );

    // A file that cannot be read is refused before anything is sent, so the
    // name beside it is not changed either.
    const before = await local.json<{ name: string }>(["owner", "show"]);
    const unreadable = await local.refused([
      "owner",
      "update",
      "--name",
      "Never sent",
      "--avatar",
      join(dir, "missing.png"),
    ]);
    expect(unreadable.envelope.error.message).toContain("cannot read");
    expect((await local.json<{ name: string }>(["owner", "show"])).name).toBe(
      before.name,
    );
    const stillThere = join(dir, "still.png");
    await local.json(["owner", "picture", "--output", stillThere]);
    expect((await readFile(stillThere)).equals(sent)).toBe(true);

    const replaced = png(8, 8, 0x20);
    const second = join(dir, "second.png");
    await writeFile(second, replaced);
    expect(
      await delegated.json(["profile", "update", "--avatar", second]),
    ).toEqual({ ok: true });
    const swapped = join(dir, "swapped.png");
    await local.json(["owner", "picture", "--output", swapped]);
    expect((await readFile(swapped)).equals(replaced)).toBe(true);

    expect(
      await delegated.json(["profile", "update", "--clear-avatar"]),
    ).toEqual({ ok: true });
    expect((await owner()).avatar).toBeNull();
    const gone = await local.refused([
      "owner",
      "picture",
      "--output",
      join(dir, "gone.png"),
    ]);
    expect(gone.envelope.error.server?.status).toBe(404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

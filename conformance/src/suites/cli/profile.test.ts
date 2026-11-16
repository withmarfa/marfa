import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { gif, png } from "../../utils/avatars.js";
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
it("changes the owner through the private socket and through a credential", async () => {
  const changed = await local.json<{ email: string; name: string }>([
    "profile",
    "update",
    "--email",
    "Updated@Example.test",
    "--name",
    "CLI owner",
  ]);
  expect(changed).toMatchObject({
    email: "updated@example.test",
    name: "CLI owner",
  });
  const refused = await delegated
    .as(undefined)
    .refused(["profile", "update", "--name", "No"]);
  expect(refused.code).toBe(5);
  expect(
    await delegated.json(["profile", "update", "--name", "CLI delegate"]),
  ).toMatchObject({ name: "CLI delegate" });
  expect(
    await delegated.json(["profile", "update", "--name", "CLI profile"]),
  ).toMatchObject({ name: "CLI profile" });
  expect((await local.json<{ name: string }>(["profile", "show"])).name).toBe(
    "CLI profile",
  );
});

it("uploads, fetches and removes the owner's avatar from a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marfa-cli-avatar-"));
  try {
    const sent = png(16, 16);
    const file = join(dir, "me.png");
    await writeFile(file, sent);
    const owner = () =>
      local.json<{ avatar: string | null }>(["profile", "show"]);
    expect((await owner()).avatar).toBeNull();

    // The witness for the refusals below: this file is taken.
    const updated = await local.json<{ avatar: string | null }>([
      "profile",
      "update",
      "--avatar",
      file,
    ]);
    expect(updated.avatar).toMatch(/\/profile\/avatar$/);
    expect((await owner()).avatar).toBe(updated.avatar);
    const fetched = join(dir, "fetched.png");
    await local.json(["profile", "avatar", "--output", fetched]);
    expect((await readFile(fetched)).equals(sent)).toBe(true);

    // The name says PNG and the bytes say GIF: the server's word is shown.
    const lie = join(dir, "lie.png");
    await writeFile(lie, gif());
    const refusedKind = await local.refused([
      "profile",
      "update",
      "--avatar",
      lie,
    ]);
    expect(refusedKind.envelope.error.message).toContain(
      "Use a PNG, JPEG or WebP avatar.",
    );

    // A file that cannot be read is refused before anything is sent, so the
    // name beside it is not changed either.
    const before = await local.json<{ name: string }>(["profile", "show"]);
    const unreadable = await local.refused([
      "profile",
      "update",
      "--name",
      "Never sent",
      "--avatar",
      join(dir, "missing.png"),
    ]);
    expect(unreadable.envelope.error.message).toContain("cannot read");
    expect((await local.json<{ name: string }>(["profile", "show"])).name).toBe(
      before.name,
    );
    const stillThere = join(dir, "still.png");
    await local.json(["profile", "avatar", "--output", stillThere]);
    expect((await readFile(stillThere)).equals(sent)).toBe(true);

    const replaced = png(8, 8, 0x20);
    const second = join(dir, "second.png");
    await writeFile(second, replaced);
    expect(
      await delegated.json(["profile", "update", "--avatar", second]),
    ).toMatchObject({ avatar: expect.any(String) });
    const swapped = join(dir, "swapped.png");
    await local.json(["profile", "avatar", "--output", swapped]);
    expect((await readFile(swapped)).equals(replaced)).toBe(true);

    expect(
      await delegated.json(["profile", "update", "--clear-avatar"]),
    ).toMatchObject({ avatar: null });
    expect((await owner()).avatar).toBeNull();
    const gone = await local.refused([
      "profile",
      "avatar",
      "--output",
      join(dir, "gone.png"),
    ]);
    expect(gone.envelope.error.server?.status).toBe(404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { png } from "../../utils/pictures.js";
import { Cli, requireBinary } from "./harness.js";

let server: FreshServer;
let local: Cli, keyed: Cli;
beforeAll(async () => {
  server = await bootFreshServer("cli-owner-commands");
  const binary = requireBinary();
  local = new Cli(binary, server.apiUrl, undefined, server.controlSocket);
  keyed = new Cli(binary, server.apiUrl, server.managementKey);
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

it("ends every browser sign-in at once, sparing a named one and leaving apps and keys alone", async () => {
  interface SignIn {
    id: string;
    kind: string;
  }
  const kinds = async () =>
    (await local.json<{ data: SignIn[] }>(["sign-ins", "list"])).data;
  const browsers = (await kinds()).filter((row) => row.kind === "browser");
  expect(browsers.length).toBeGreaterThan(0);
  const others = (await kinds()).filter((row) => row.kind !== "browser");
  expect(others.length).toBeGreaterThan(0);

  // A misspelled --keep ends nothing; the same call with the right id ends the others.
  const misspelled = await local.refused([
    "sign-ins",
    "end-all",
    "--keep",
    `${browsers[0]!.id}-nosuch`,
  ]);
  expect(misspelled.code).toBe(1);
  expect(misspelled.envelope.error.server?.code).toBe("validation_error");
  expect(misspelled.envelope.error.message).toContain(
    `${browsers[0]!.id}-nosuch`,
  );
  expect((await kinds()).filter((row) => row.kind === "browser")).toHaveLength(
    browsers.length,
  );

  const kept = await local.json<{ ended: number }>([
    "sign-ins",
    "end-all",
    ...browsers.flatMap((row) => ["--keep", row.id]),
  ]);
  expect(kept.ended).toBe(0);
  expect((await kinds()).filter((row) => row.kind === "browser")).toHaveLength(
    browsers.length,
  );

  const ended = await local.json<{ ended: number; failed: unknown[] }>([
    "sign-ins",
    "end-all",
  ]);
  expect(ended).toMatchObject({ ended: browsers.length, failed: [] });
  const after = await kinds();
  expect(after.filter((row) => row.kind === "browser")).toEqual([]);
  expect(after.map((row) => row.id).sort()).toEqual(
    others.map((row) => row.id).sort(),
  );
  expect(
    (await keyed.json<{ id: string }>(["keys", "current"])).id,
  ).toBeTruthy();
  const plain = await local.run(["sign-ins", "end-all"]);
  expect(plain.stdout.trim()).toBe("ended 0 sign-ins");

  const ordinary = await keyed.refused(["sign-ins", "end-all"]);
  expect(ordinary.envelope.error.server?.status).toBeGreaterThanOrEqual(400);
});

it("clears the owner's picture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marfa-cli-owner-picture-"));
  try {
    const file = join(dir, "me.png");
    await writeFile(file, png(16, 16));
    const owner = () =>
      local.json<{ avatar: string | null }>(["owner", "show"]);
    const pictured = await local.json<{ avatar: string | null }>([
      "owner",
      "update",
      "--avatar",
      file,
    ]);
    expect(pictured.avatar).toMatch(/\/owner\/picture$/);
    expect((await owner()).avatar).toBe(pictured.avatar);

    const cleared = await local.json<{ avatar: string | null }>([
      "owner",
      "update",
      "--clear-avatar",
    ]);
    expect(cleared.avatar).toBeNull();
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

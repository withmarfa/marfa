import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { png } from "../../utils/avatars.js";
import { issuerOrigin } from "../../utils/signed-in.js";
import { TEST_OWNER } from "../../utils/target.js";
import { Cli, requireBinary } from "./harness.js";
import { tempFolder } from "../../utils/temp-folder.js";

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

  // A key that holds sign_ins.manage ends them too; none is left to end.
  expect(await keyed.json(["sign-ins", "end-all"])).toMatchObject({
    ended: 0,
    failed: [],
  });
});

it("clears the owner's avatar", async () => {
  const dir = tempFolder("marfa-cli-owner-avatar-");
  try {
    const file = join(dir, "me.png");
    await writeFile(file, png(16, 16));
    const owner = () =>
      local.json<{ avatar: string | null }>(["profile", "show"]);
    const updated = await local.json<{ avatar: string | null }>([
      "profile",
      "update",
      "--avatar",
      file,
    ]);
    expect(updated.avatar).toMatch(/\/profile\/avatar$/);
    expect((await owner()).avatar).toBe(updated.avatar);

    const cleared = await local.json<{ avatar: string | null }>([
      "profile",
      "update",
      "--clear-avatar",
    ]);
    expect(cleared.avatar).toBeNull();
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

it("holds a sign-in address change until its flag confirms it, and tells a key a person is the way", async () => {
  const address = "https://moved.example";
  const body = JSON.stringify({ sign_in_address: address });
  const keyedTry = await keyed.run(["config", "update", "--body", body]);
  expect(keyedTry.code).toBe(1);
  expect(keyedTry.stderr).toContain("a person does it from an app");
  expect(keyedTry.stderr).toContain("private local command");
  const keyedJson = await keyed.refused(["config", "update", "--body", body]);
  expect(keyedJson.envelope.error.server?.code).toBe("app_sign_in_required");
  // A refusal's details reach the envelope as the server sent them.
  const malformed = JSON.stringify({
    sign_in_address: "https://a.example/path",
  });
  const sent = await fetch(`${server.apiUrl}/config`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${server.managementKey}`,
      "content-type": "application/json",
    },
    body: malformed,
  });
  const direct = (await sent.json()) as { error: { details?: unknown } };
  expect(direct.error.details).toBeDefined();
  const detailed = await keyed.refused([
    "config",
    "update",
    "--body",
    malformed,
  ]);
  expect(detailed.envelope.error.server?.details).toEqual(direct.error.details);

  const held = await local.run(["config", "update", "--body", body]);
  expect(held.code).toBe(1);
  expect(held.stderr).toContain("sign_in_address_change_unconfirmed");
  expect(held.stderr).toContain("--confirm-address-change");
  const stored = await local.json<{ sign_in_address?: string }>([
    "config",
    "get",
  ]);
  expect(stored.sign_in_address).toBeUndefined();

  // The address answers nothing, so the server's check refuses the move.
  const unchecked = await local.run([
    "config",
    "update",
    "--body",
    body,
    "--confirm-address-change",
  ]);
  expect(unchecked.code).toBe(1);
  expect(unchecked.stderr).toContain("sign_in_address_check_failed");
  expect(unchecked.stderr).toContain("--skip-sign-in-address-check");
  expect(
    (await local.json<{ sign_in_address?: string }>(["config", "get"]))
      .sign_in_address,
  ).toBeUndefined();

  const moved = await local.json<{ sign_in_address?: string }>([
    "config",
    "update",
    "--body",
    body,
    "--confirm-address-change",
    "--skip-sign-in-address-check",
  ]);
  expect(moved.sign_in_address).toBe(address);
});

/** Whether `password` signs the owner in at the sign-in page now. */
async function signsIn(password: string): Promise<boolean> {
  const response = await fetch(`${server.apiUrl}/auth/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: await issuerOrigin(server),
    },
    body: JSON.stringify({ email: TEST_OWNER.email, password }),
  });
  await response.body?.cancel();
  expect([200, 401]).toContain(response.status);
  return response.status === 200;
}

/** How many requests to `path` the server has logged so far. */
async function logged(path: string): Promise<number> {
  const log = await readFile(join(server.stateDir, "server.log"), "utf8");
  return log
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .filter((line) => (JSON.parse(line) as { path?: string }).path === path)
    .length;
}

interface Setting {
  key: string;
  value: unknown;
  stored: unknown;
  secret: boolean;
  set?: boolean;
}

async function setting(name: string): Promise<Setting> {
  const listed = await keyed.json<{ data: Setting[] }>(["config", "settings"]);
  const found = listed.data.find((row) => row.key === name);
  expect(found, `${name} is listed`).toBeDefined();
  return found!;
}

it("replaces the owner's password with a key and with the private socket, asking for no password as an argument", async () => {
  const forward = JSON.stringify({
    current_password: TEST_OWNER.password,
    new_password: "a different long password",
  });
  const back = JSON.stringify({
    current_password: "a different long password",
    new_password: TEST_OWNER.password,
  });

  // A password on the command line is refused whole, and changes nothing.
  for (const argv of [
    ["owner", "password", "a different long password"],
    ["owner", "password", "--new-password", "a different long password"],
  ]) {
    const refused = await keyed.refused(argv);
    expect(refused.code).toBe(2);
    expect(refused.envelope.error.code).toBe("usage");
  }
  expect(await signsIn(TEST_OWNER.password)).toBe(true);

  // The witness: a key's `owner passkeys list` is a request the log holds,
  // and so is the one `owner password` makes before it asks for anything.
  const seen = await logged("/owner/passkeys");
  await keyed.json(["owner", "passkeys", "list"]);
  expect(await logged("/owner/passkeys")).toBe(seen + 1);

  // Without a terminal and without --stdin, the command asks for nothing
  // and the server sees nothing.
  const none = await keyed.refused(["owner", "password"]);
  expect(none.code).toBe(2);
  expect(none.envelope.error.message).toContain("--stdin");
  expect(await logged("/owner/passkeys")).toBe(seen + 1);

  const changed = await keyed.json(["owner", "password", "--stdin"], {
    stdin: forward,
  });
  expect(changed).toEqual({ ok: true });
  expect(await signsIn(TEST_OWNER.password)).toBe(false);
  expect(await signsIn("a different long password")).toBe(true);

  // The witness: the socket is held to the current password too, and the
  // refusal it gets is the password's, not a missing key.
  const wrong = await local.refused(["owner", "password", "--stdin"], {
    stdin: forward,
  });
  expect(wrong.envelope.error.server?.code).toBe("unauthorized");
  expect(wrong.envelope.error.message).not.toContain("needs a key");
  expect(wrong.code).toBe(1);

  // A key that just worked is not signed out by a wrong password either.
  const mistyped = await keyed.refused(["owner", "password", "--stdin"], {
    stdin: JSON.stringify({
      current_password: "not the owner's password",
      new_password: "a different long password",
    }),
  });
  expect(mistyped.envelope.error.server?.code).toBe("unauthorized");
  expect(mistyped.code).toBe(1);
  expect(await signsIn("a different long password")).toBe(true);

  const restored = await local.json(["owner", "password", "--stdin"], {
    stdin: back,
  });
  expect(restored).toEqual({ ok: true });
  expect(await signsIn(TEST_OWNER.password)).toBe(true);

  // A key that cannot manage sign-ins is refused before anything is read:
  // the input here is not JSON, and the refusal is still the server's.
  const minted = await local.json<{ key: string }>([
    "keys",
    "create",
    "--label",
    "cannot manage sign-ins",
    "--source",
    "cli-owner-password-narrow",
    "--permission",
    "audit.read",
  ]);
  const narrow = await keyed
    .as(minted.key)
    .refused(["owner", "password", "--stdin"], { stdin: "not json" });
  expect(narrow.envelope.error.server?.code).toBe("forbidden");
});

it("sets one setting by name as the kind it holds, and removes it", async () => {
  const before = await setting("trash_retention_days");
  expect(typeof before.value).toBe("number");

  expect(
    await keyed.json(["config", "set", "trash_retention_days", "45"]),
  ).toMatchObject({});
  expect((await setting("trash_retention_days")).stored).toBe(45);

  await keyed.json(["config", "set", "enrichment_ocr_enabled", "false"]);
  expect((await setting("enrichment_ocr_enabled")).stored).toBe(false);

  await keyed.json(["config", "set", "object_store_region", "eu-west-2"]);
  expect((await setting("object_store_region")).stored).toBe("eu-west-2");

  // A value of another kind, and a name nobody lists, send nothing.
  for (const [name, value] of [
    ["trash_retention_days", "many"],
    ["trash_retention_days", "-1"],
    ["enrichment_ocr_enabled", "yes"],
    ["no_such_setting", "1"],
  ] as const) {
    const refused = await keyed.refused(["config", "set", name, value]);
    expect(refused.code, `${name} ${value}`).toBe(2);
    expect(refused.envelope.error.code).toBe("usage");
  }
  expect((await setting("trash_retention_days")).stored).toBe(45);

  await keyed.json(["config", "unset", "trash_retention_days"]);
  const after = await setting("trash_retention_days");
  expect(after.stored).toBeNull();
  expect(after.value).toBe(before.value);
  await keyed.json(["config", "unset", "enrichment_ocr_enabled"]);
  await keyed.json(["config", "unset", "object_store_region"]);
});

it("reads a secret setting from standard input and refuses it as an argument", async () => {
  const name = "error_webhook_url";
  expect((await setting(name)).secret).toBe(true);
  const given = await keyed.refused([
    "config",
    "set",
    name,
    "https://hooks.example/received",
  ]);
  expect(given.code).toBe(2);
  expect(given.envelope.error.code).toBe("usage");
  expect(given.envelope.error.message).not.toContain("hooks.example");
  expect((await setting(name)).set).toBeFalsy();

  await keyed.json(["config", "set", name], {
    stdin: "https://hooks.example/received\n",
  });
  const stored = await setting(name);
  expect(stored.set).toBe(true);
  expect(stored.value).toBeNull();

  // Nothing on standard input is no value, not an empty one.
  const empty = await keyed.refused(["config", "set", name], { stdin: "" });
  expect(empty.code).toBe(2);
  expect((await setting(name)).set).toBe(true);

  await keyed.json(["config", "unset", name]);
  expect((await setting(name)).set).toBeFalsy();
});

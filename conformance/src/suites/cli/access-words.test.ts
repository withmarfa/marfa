import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, trackKey } from "../../utils/setup.js";
import { cliContext, releaseHeld, unique } from "./harness.js";
import type { CliContext } from "./harness.js";

/**
 * What the terminal says of the access a key holds: the levels and powers in
 * the words the approval pages use, and none of the key's raw maps.
 */

let c: CliContext;

beforeAll(async () => {
  c = await cliContext("access-words");
});

afterAll(async () => {
  releaseHeld();
  await cleanup(c.ctx);
});

describe("the access a key holds, as the terminal prints it", () => {
  it("prints what a key holds in the words the approval pages use", async () => {
    const minted = await c.cli.json<{ id: string; key: string }>([
      "keys",
      "create",
      "--label",
      "access words",
      "--source",
      unique("cli-access"),
      "--type-permission",
      "core.note=write",
      "--type-permission",
      "core.task=read",
      "--edge-permission",
      "references=read",
      "--permission",
      "keys.mint",
      "--permission",
      "items.purge",
    ]);
    trackKey(c.ctx, minted.id);

    const outcome = await c.cli.as(minted.key).run(["keys", "current"]);
    expect(outcome.code, outcome.stderr).toBe(0);
    const lines = outcome.stdout.split("\n").map((line) => line.trim());
    const row = (title: string, level: string) =>
      lines.some((line) => line.replace(/\s+/g, " ") === `${title} ${level}`);
    expect(row("core.note", "Read and edit"), outcome.stdout).toBe(true);
    expect(row("core.task", "Read only"), outcome.stdout).toBe(true);
    expect(row("edge.references", "Read only"), outcome.stdout).toBe(true);
    expect(lines).toContain(
      "Powers: Make, see, edit and revoke keys; Delete items in the trash for good",
    );
    // The raw maps are for a script, which asks for them with --json.
    expect(outcome.stdout).not.toMatch(/type_permissions|"write"/);
    const json = await c.cli
      .as(minted.key)
      .json<{ type_permissions: Record<string, string> }>(["keys", "current"]);
    expect(json.type_permissions).toEqual({
      "core.note": "write",
      "core.task": "read",
    });
  });

  it("prints a key that holds nothing as holding no access", async () => {
    const minted = await c.cli.json<{ id: string; key: string }>([
      "keys",
      "create",
      "--label",
      "inert",
      "--source",
      unique("cli-access-none"),
      "--no-permissions",
    ]);
    trackKey(c.ctx, minted.id);
    const outcome = await c.cli.as(minted.key).run(["keys", "current"]);
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain("No access");
  });
});

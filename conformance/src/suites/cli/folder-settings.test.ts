import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup, trackFolder, trackKey } from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { CliContext } from "./harness.js";

/**
 * A folder's settings from the terminal: `folders create`, `change` and
 * `revoke` drive the folder door, and the local folder commands stay local.
 */

let c: CliContext;

beforeAll(async () => {
  c = await cliContext("folder-settings");
});

afterAll(async () => {
  await cleanup(c.ctx);
});

interface Folder {
  item: {
    id: string;
    type: string;
    state: string;
    version: number;
    properties: Record<string, unknown>;
  };
}

describe("a folder's settings from the terminal", () => {
  it("creates from flags and a JSON document on stdin, changes at a version, and revokes", async () => {
    const title = unique("cli-folder");
    const created = await c.cli.json<Folder>(
      [
        "folders",
        "create",
        "--file",
        "-",
        "--title",
        title,
        "--include",
        "*.md",
        "--first-placement",
        "core.note=Notes",
      ],
      { stdin: JSON.stringify({ search: { types: ["core.note"] } }) },
    );
    trackFolder(c.ctx, created.item.id);
    expect(created.item.type).toBe("system.folder");
    expect(created.item.version).toBe(1);
    expect(created.item.properties).toEqual({
      title,
      search: { types: ["core.note"] },
      include: ["*.md"],
      first_placement: { "core.note": "Notes" },
    });

    const changed = await c.cli.json<Folder>([
      "folders",
      "change",
      created.item.id,
      "--version",
      "1",
      "--ignore",
      "drafts/",
    ]);
    expect(changed.item.version).toBe(2);
    expect(changed.item.properties.ignore).toEqual(["drafts/"]);

    const stale = await c.cli.refused([
      "folders",
      "change",
      created.item.id,
      "--version",
      "1",
      "--ignore",
      "other/",
    ]);
    expect(stale.envelope.error.server?.status).toBe(409);
    expect(stale.envelope.error.server?.code).toBe("version_conflict");

    const revoked = await c.cli.json<Folder>([
      "folders",
      "revoke",
      created.item.id,
    ]);
    expect(revoked.item.state).toBe("revoked");
    const again = await c.cli.refused(["folders", "revoke", created.item.id]);
    expect(again.envelope.error.server?.code).toBe("invalid_transition");
  });

  it("is refused to a key without write on system.folder, and names a malformed setting", async () => {
    const minted = await c.cli.json<{ id: string; key: string }>([
      "keys",
      "create",
      "--label",
      "note-writer",
      "--source",
      unique("cli-folder-note-writer"),
      "--type-permission",
      "core.note=write",
    ]);
    trackKey(c.ctx, minted.id);
    const refused = await c.cli
      .as(minted.key)
      .refused(["folders", "create", "--title", "refused"]);
    expect(refused.code).toBe(1);
    expect(refused.envelope.error.server?.status).toBe(403);
    expect(refused.envelope.error.server?.code).toBe("type_not_permitted");

    const malformed = await c.cli.refused([
      "folders",
      "create",
      "--title",
      "malformed",
      "--first-placement",
      "core.note=../out",
    ]);
    expect(malformed.envelope.error.server?.status).toBe(400);
    expect(malformed.envelope.error.server?.code).toBe("validation_error");
  });

  it("refuses a setting given both in the JSON and as a flag, before sending", async () => {
    const both = await c.cli.refused([
      "folders",
      "create",
      "--body",
      JSON.stringify({ title: "a" }),
      "--title",
      "b",
    ]);
    expect(both.envelope.error.server).toBeNull();
    expect(both.envelope.error.message).toContain(
      "given both in the JSON and as a flag",
    );
  });
});

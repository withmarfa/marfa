import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { DISK_ONLY } from "../../utils/own-blob-server.js";
import { Cli, requireBinary } from "./harness.js";

let server: FreshServer | undefined;
let dir: string;

beforeAll(async () => {
  server = await bootFreshServer("folder-settings-upgrade", DISK_ONLY);
  dir = mkdtempSync(
    join(realpathSync(tmpdir()), "marfa-folder-settings-upgrade-"),
  );
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

interface Folder {
  item: {
    id: string;
    version: number;
    properties: Record<string, unknown>;
  };
}

describe("folder settings written before the current type", () => {
  it.each(["--file", "--body"])(
    "repairs stored undeclared settings through %s and opens the folder",
    async (input) => {
      let cli = new Cli(requireBinary(), server!.apiUrl, server!.workingKey);
      const settings = {
        title: "Notes",
        defaults: { type: "core.note" },
        include: ["*.md"],
        ignore: ["drafts/"],
        first_placement: {},
        removal_threshold: { files: 10, fraction: 0.25 },
      };
      const created = await cli.json<Folder>([
        "folders",
        "create",
        "--body",
        JSON.stringify(settings),
      ]);
      const id = created.item.id;
      const stored = {
        ...settings,
        search: { types: ["core.note"] },
        obsolete: true,
      };
      // Current write doors cannot produce the row an older server left behind.
      await server!.restart(() => {
        const db = new DatabaseSync(server!.sqlitePath);
        try {
          db.prepare("UPDATE items SET properties = jsonb(?) WHERE id = ?").run(
            JSON.stringify(stored),
            id,
          );
        } finally {
          db.close();
        }
      });
      cli = new Cli(requireBinary(), server!.apiUrl, server!.workingKey);
      expect(
        (await cli.json<Folder>(["items", "get", id])).item.properties,
      ).toEqual(stored);
      const folder = join(dir, input.slice(2));
      const refused = await cli.refused([
        "folders",
        "add",
        folder,
        "--folder",
        id,
        "--yes",
      ]);
      expect(refused.envelope.error.message).toContain("unknown field");

      const query = { types: ["core.note"], tier: "all" };
      const changes = input === "--file" ? { ...settings, query } : { query };
      const json = JSON.stringify(changes);
      const file = join(dir, "settings.json");
      writeFileSync(file, json);
      const changed = await cli.json<Folder>([
        "folders",
        "change",
        id,
        "--version",
        "1",
        input,
        input === "--file" ? file : json,
      ]);
      expect(changed.item.version).toBe(2);
      expect(changed.item.properties).toEqual({ ...settings, query });
      expect(
        (await cli.json<Folder>(["items", "get", id])).item.properties,
      ).toEqual({ ...settings, query });
      await cli.json(["folders", "add", folder, "--folder", id, "--yes"]);
      await cli.json(["folders", "push", folder]);
      await cli.json(["folders", "remove", folder]);
    },
  );
});

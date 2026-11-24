import { beforeAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { bootFreshServer, type FreshServer } from "../../utils/fresh-server.js";
import { DISK_ONLY, everythingClient } from "../../utils/own-blob-server.js";
import { Cli, requireBinary } from "./harness.js";
import type { ItemEnvelope } from "./harness.js";
import { tempFolder } from "../../utils/temp-folder.js";

/**
 * A directory that synced with a server that was then lost, and a backup of
 * it restored into a new instance at the same address, added back in place.
 */

let root: string;

beforeAll(() => {
  root = tempFolder("marfa-cli-folder-instance-");
});

interface Listed {
  data: Array<{
    id: string;
    type: string;
    version: number;
    properties: { title?: string; body?: string };
  }>;
}

interface Foreseen {
  path: string;
  outcome: string;
  held: number | null;
  sent: number | null;
}

interface Added {
  restore: { record: string; reason?: string; files: Foreseen[] };
}

interface Record {
  files: Array<{ path: string; version: number; hash: string | null }>;
}

const record = (dir: string): Record =>
  JSON.parse(
    readFileSync(join(dir, ".marfa", "removed.json"), "utf8"),
  ) as Record;

const note = (title: string, body: string): string =>
  `---\ntitle: ${title}\n---\n${body}\n`;

/** Pushes after each edit, so each one is a version of its own. */
async function edits(
  cli: Cli,
  dir: string,
  name: string,
  bodies: string[],
): Promise<void> {
  for (const body of bodies) {
    const path = join(dir, name);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(/\n[^\n]*\n$/, `\n${body}\n`),
    );
    const pushed = await cli.run(["folders", "push", dir]);
    expect(pushed.code, pushed.stderr).toBe(0);
  }
}

/** A folder on `origin`, a backup of it, `after` run, then `origin` lost and the backup restored into a new instance at its address. */
async function restoredAfter(
  name: string,
  types: string[],
  before: (cli: Cli, dir: string) => Promise<void>,
  after: (cli: Cli, dir: string) => Promise<void>,
  down?: (cli: Cli, dir: string) => Promise<void>,
): Promise<{
  target: FreshServer;
  cli: Cli;
  dir: string;
  folder: string;
}> {
  const binary = requireBinary();
  const registry = join(root, `registry-${name}`, "folders.json");
  const dir = join(root, name);
  const origin = await bootFreshServer(`cli-${name}-origin`, DISK_ONLY);
  const first = new Cli(binary, origin.apiUrl, origin.workingKey).withEnv({
    MARFA_FOLDER_REGISTRY: registry,
  });
  let port: string;
  let folder: string;
  const archive = join(root, `${name}.tar`);
  try {
    const made = await first.json<ItemEnvelope>([
      "folders",
      "create",
      "--title",
      name,
      "--query",
      JSON.stringify({ types, state: ["active"] }),
    ]);
    folder = made.item.id;
    await first.json(["folders", "add", dir, "--folder", folder, "--yes"]);
    await before(first, dir);
    const backup = await (await everythingClient(origin)).exportArchive();
    expect(backup.status).toBe(200);
    writeFileSync(archive, backup.data);
    await after(first, dir);
    port = new URL(origin.apiUrl).port;
  } finally {
    await origin.stop();
  }
  await down?.(first, dir);
  const target = await bootFreshServer(`cli-${name}-target`, {
    ...DISK_ONLY,
    MARFA_PORT: port,
  });
  const restored = await new Cli(binary, target.apiUrl, undefined)
    .viaSocket(target.controlSocket)
    .run(["restore", archive]);
  expect(restored.code, restored.stderr).toBe(0);
  const cli = new Cli(binary, target.apiUrl, target.workingKey).withEnv({
    MARFA_FOLDER_REGISTRY: registry,
  });
  return { target, cli, dir, folder };
}

async function notes(cli: Cli): Promise<Listed["data"]> {
  return (
    await cli.json<Listed>([
      "items",
      "list",
      "--type",
      "core.note",
      "--limit",
      "100",
    ])
  ).data;
}

describe("a directory added back in place after its server was restored into another instance", () => {
  it("sends no file the directory synced before to the instance a backup was restored into, keeps both where they differ, and keeps the record until every file is settled", async () => {
    const { target, cli, dir, folder } = await restoredAfter(
      "Home",
      ["core.note", "core.file"],
      async (first, dir) => {
        for (const title of ["Clash", "Late", "Tagged", "Outside", "Same"]) {
          writeFileSync(join(dir, `${title}.md`), note(title, "in the backup"));
        }
        writeFileSync(join(dir, "Broken.md"), note("Broken", "readable"));
        expect((await first.run(["folders", "push", dir])).code).toBe(0);
      },
      async (first, dir) => {
        // Sent after the backup was made, so the restore lacks them.
        await edits(first, dir, "Clash.md", ["origin 2"]);
        await edits(first, dir, "Late.md", ["late 2", "late 3"]);
        writeFileSync(join(dir, "Fresh.md"), note("Fresh", "after the backup"));
        writeFileSync(join(dir, "new.bin"), Buffer.from([0, 1, 2, 3]));
        // Not UTF-8, so the folder holds it and never sends it.
        writeFileSync(
          join(dir, "Broken.md"),
          Buffer.concat([
            Buffer.from("---\ntitle: Broken\n---\n"),
            Buffer.from([0xff, 0xfe, 0x0a]),
          ]),
        );
        expect((await first.run(["folders", "push", dir])).code).toBe(0);
      },
    );
    try {
      const byTitle = async (title: string) =>
        (await notes(cli)).find((item) => item.properties.title === title)!;
      const got = async (id: string) => {
        const read = await cli.json<ItemEnvelope>(["items", "get", id]);
        return {
          ...read.item,
          body: (read.item.properties.body as string | undefined)?.trim(),
          tags: read.metadata?.tags ?? [],
        };
      };
      // #3542: the instance's own version 2 of Clash, beside the folder's.
      const clash = await byTitle("Clash");
      await cli.json([
        "items",
        "update",
        clash.id,
        "--version",
        "1",
        "--prop",
        "body=edited on the instance",
      ]);
      const tagged = await byTitle("Tagged");
      await cli.json(["items", "tags", "add", tagged.id, "starred"]);
      const outside = await byTitle("Outside");
      await cli.json([
        "items",
        "transition",
        outside.id,
        "--state",
        "archived",
      ]);
      expect(readFileSync(join(dir, "Clash.md"), "utf8")).toContain(
        "marfa_version: 2",
      );

      const removed = await cli.run(["folders", "remove", dir]);
      expect(removed.code, removed.stderr).toBe(0);
      expect(removed.stdout).toContain(
        `marfa folders add ${dir} --folder ${folder}`,
      );
      expect(removed.stdout).toContain("on this same directory");
      // No push since the restore: the removal asked the server itself.
      expect(removed.stdout).toContain(
        "another Marfa instance answers at the folder's server",
      );
      const files = record(dir).files;
      expect(files.find((file) => file.path === "Late.md")!.version).toBe(3);
      // The witness: an agreed file records its hash; a held one does not.
      expect(files.find((file) => file.path === "Same.md")!.hash).toEqual(
        expect.any(String),
      );
      expect(files.find((file) => file.path === "Broken.md")!.hash).toBeNull();

      // Added, then removed before its first sync: the record stays.
      const planned = await cli.json<Added>([
        "folders",
        "add",
        dir,
        "--folder",
        folder,
      ]);
      expect(planned.restore.record).toBe("other_instance");
      expect((await cli.run(["folders", "remove", dir])).code).toBe(0);
      expect(existsSync(join(dir, ".marfa", "removed.json"))).toBe(true);

      const added = await cli.json<Added>([
        "folders",
        "add",
        dir,
        "--folder",
        folder,
      ]);
      expect(added.restore.record).toBe("other_instance");
      const outcome = (path: string) =>
        added.restore.files.find((file) => file.path === path);
      expect(outcome("Clash.md")).toMatchObject({
        outcome: "both",
        held: 2,
        sent: 2,
      });
      expect(outcome("Late.md")).toMatchObject({
        outcome: "both",
        held: 1,
        sent: 3,
      });
      expect(outcome("Tagged.md")).toMatchObject({ outcome: "both" });
      expect(outcome("Outside.md")).toMatchObject({ outcome: "absent" });
      expect(outcome("Fresh.md")).toMatchObject({ outcome: "absent" });
      expect(outcome("new.bin")).toMatchObject({ outcome: "absent" });
      expect(outcome("Broken.md")).toMatchObject({ outcome: "unknown" });
      expect(outcome("Same.md")).toMatchObject({ outcome: "in_step" });
      expect((await cli.run(["folders", "confirm", dir])).code).toBe(0);
      const pushed = await cli.run(["folders", "push", dir]);
      expect(pushed.code, pushed.stderr).toBe(0);
      expect(pushed.stdout).toContain(
        "Clash.md shows the instance's version; this directory's version is kept in Clash (2).md",
      );
      expect(pushed.stdout).toContain("Fresh.md waits:");
      expect(pushed.stdout).not.toContain("Same.md waits");

      expect((await got(clash.id)).body).toBe("edited on the instance");
      expect((await got((await byTitle("Late")).id)).version).toBe(1);
      expect((await got(tagged.id)).tags).toContain("starred");
      const kept = await got(outside.id);
      expect([kept.state, kept.version]).toEqual(["archived", 1]);
      const titles = (await notes(cli)).map((item) => item.properties.title);
      expect(titles.filter((title) => title === "Clash")).toEqual(["Clash"]);
      expect(titles).not.toContain("Fresh");
      const fileItems = await cli.json<Listed>([
        "items",
        "list",
        "--type",
        "core.file",
        "--limit",
        "100",
      ]);
      expect(fileItems.data).toEqual([]);
      // Both kept on disk: the instance's version at the item's path, and
      // the folder's bytes as they were beside it.
      expect(readFileSync(join(dir, "Clash.md"), "utf8")).toContain(
        "edited on the instance",
      );
      expect(readFileSync(join(dir, "Clash (2).md"), "utf8")).toContain(
        "origin 2",
      );
      expect(readFileSync(join(dir, "Tagged.md"), "utf8")).toContain("starred");
      expect(existsSync(join(dir, ".marfa", "removed.json"))).toBe(true);

      // Removed again while files wait: their entries stay.
      expect((await cli.run(["folders", "remove", dir])).code).toBe(0);
      const listed = record(dir).files.map((file) => file.path);
      expect(listed).toEqual(
        expect.arrayContaining(["Fresh.md", "new.bin", "Clash (2).md"]),
      );
      await cli.json(["folders", "add", dir, "--folder", folder, "--yes"]);
      const readded = await cli.run(["folders", "push", dir]);
      expect(readded.code, readded.stderr).toBe(0);
      expect(readded.stdout).toContain("Clash (2).md waits:");
      const after = (await notes(cli)).map((item) => item.properties.title);
      expect(after).not.toContain("Fresh");
      expect(after.filter((title) => title === "Clash")).toEqual(["Clash"]);
      expect(readFileSync(join(dir, "Clash (2).md"), "utf8")).toContain(
        "origin 2",
      );

      // The witness: with its marfa_id line taken out, the file is sent as
      // a new item.
      const fresh = join(dir, "Fresh.md");
      writeFileSync(
        fresh,
        readFileSync(fresh, "utf8").replace(/^marfa_(id|version):.*\n/gm, ""),
      );
      const sent = await cli.run(["folders", "push", dir]);
      expect(sent.code, sent.stderr).toBe(0);
      expect((await notes(cli)).map((item) => item.properties.title)).toContain(
        "Fresh",
      );
    } finally {
      await target.stop();
    }
  });

  it("sends a directory's edits by their version lines when it is added back on the instance it was removed from, and keeps both where its record cannot be read", async () => {
    const binary = requireBinary();
    const registry = join(root, "registry-same", "folders.json");
    const dir = join(root, "Same");
    const server = await bootFreshServer("cli-folder-same-instance", DISK_ONLY);
    try {
      const cli = new Cli(binary, server.apiUrl, server.workingKey).withEnv({
        MARFA_FOLDER_REGISTRY: registry,
      });
      const made = await cli.json<ItemEnvelope>([
        "folders",
        "create",
        "--title",
        "Same",
        "--query",
        JSON.stringify({ types: ["core.note"] }),
      ]);
      const folder = made.item.id;
      await cli.json(["folders", "add", dir, "--folder", folder, "--yes"]);
      const path = join(dir, "Kept.md");
      writeFileSync(path, note("Kept", "first"));
      expect((await cli.run(["folders", "push", dir])).code).toBe(0);
      const body = async () =>
        (await notes(cli))
          .find((item) => item.properties.title === "Kept")
          ?.properties.body?.trim();
      // A record that cannot be written refuses the removal, which then
      // clears nothing.
      const staged = join(dir, ".marfa", "removed.json.tmp");
      mkdirSync(join(staged, "inside"), { recursive: true });
      const unwritable = await cli.run(["folders", "remove", dir]);
      rmSync(staged, { recursive: true });
      expect(unwritable.code).not.toBe(0);
      expect(unwritable.stderr).toContain("cannot write the removal record");
      expect(existsSync(join(dir, ".marfa", "core.sqlite"))).toBe(true);
      // Nor is one read that is no regular file.
      const blocker = join(dir, ".marfa", "removed.json");
      mkdirSync(join(blocker, "inside"), { recursive: true });
      const refused = await cli.run(["folders", "remove", dir]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("removal record");
      expect(existsSync(join(dir, ".marfa", "core.sqlite"))).toBe(true);
      rmSync(blocker, { recursive: true });

      // The witness: on the same instance, an edit made while removed is
      // sent by its version line, and the record goes once the sync is done.
      expect((await cli.run(["folders", "remove", dir])).code).toBe(0);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace("first", "second"),
      );
      const added = await cli.json<Added>([
        "folders",
        "add",
        dir,
        "--folder",
        folder,
        "--yes",
      ]);
      expect(added.restore).toEqual({ record: "same_instance", files: [] });
      const pushed = await cli.run(["folders", "push", dir]);
      expect(pushed.code, pushed.stderr).toBe(0);
      expect(await body()).toBe("second");
      expect(existsSync(blocker)).toBe(false);

      // A record that cannot be read: an edit is kept, not sent.
      expect((await cli.run(["folders", "remove", dir])).code).toBe(0);
      writeFileSync(blocker, "{ not a record");
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace("second", "third"),
      );
      const garbled = await cli.run([
        "folders",
        "add",
        dir,
        "--folder",
        folder,
        "--yes",
      ]);
      expect(garbled.code, garbled.stderr).toBe(0);
      expect(garbled.stdout).toContain("nothing is known of what");
      const kept = await cli.run(["folders", "push", dir]);
      expect(kept.code, kept.stderr).toBe(0);
      expect(kept.stdout).toContain("Kept (2).md waits:");
      expect(await body()).toBe("second");
      expect(readFileSync(path, "utf8")).toContain("second");
      expect(readFileSync(join(dir, "Kept (2).md"), "utf8")).toContain("third");
    } finally {
      await server.stop();
    }
  });
});

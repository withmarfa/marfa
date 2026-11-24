import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
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
  held?: number;
  sent?: number;
  shared?: number;
}

interface Added {
  restore: { record: string; reason?: string; files: Foreseen[] };
}

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
      JSON.stringify({ types }),
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
  it("sends a directory's unsent changes to the instance a backup was restored into, with marfa commands alone and no item twice", async () => {
    const { target, cli, dir, folder } = await restoredAfter(
      "Home",
      ["core.note"],
      async (first, dir) => {
        writeFileSync(
          join(dir, "Packing list.md"),
          note("Packing list", "socks"),
        );
        writeFileSync(
          join(dir, "Unchanged.md"),
          note("Unchanged", "as it was"),
        );
        writeFileSync(join(dir, "Dropped.md"), note("Dropped", "not wanted"));
        writeFileSync(join(dir, "Late.md"), note("Late", "in the backup"));
        expect((await first.run(["folders", "push", dir])).code).toBe(0);
      },
      async (first, dir) => {
        // Sent after the backup was made, so no queue holds them.
        await edits(first, dir, "Late.md", ["second", "third", "fourth"]);
      },
      async (first, dir) => {
        // Changed while no server answers, so they wait in the queue.
        const packing = join(dir, "Packing list.md");
        writeFileSync(
          packing,
          readFileSync(packing, "utf8").replace("socks", "socks\nboots"),
        );
        writeFileSync(join(dir, "New idea.md"), note("New idea", "brand new"));
        rmSync(join(dir, "Dropped.md"));
        const unsent = await first.run(["folders", "push", dir]);
        expect(unsent.code, unsent.stderr).toBe(3);
      },
    );
    try {
      const stopped = await cli.refused(["folders", "push", dir]);
      expect(JSON.stringify(stopped.envelope)).toContain("instance_changed");

      const removed = await cli.run(["folders", "remove", dir]);
      expect(removed.code, removed.stderr).toBe(0);
      const lines = removed.stdout.split("\n");
      for (const line of [
        "  deleted  Dropped.md",
        "  new      New idea.md",
        "  changed  Packing list.md",
      ]) {
        expect(lines, removed.stdout).toContain(line);
      }
      expect(removed.stdout).toContain(
        `marfa folders add ${dir} --folder ${folder}`,
      );
      expect(removed.stdout).toContain("on this same directory");
      expect(existsSync(join(dir, ".marfa", "core.sqlite"))).toBe(false);
      const record = JSON.parse(
        readFileSync(join(dir, ".marfa", "removed.json"), "utf8"),
      ) as {
        files: Array<{ path: string; version: number; hash: string | null }>;
      };
      const late = record.files.find((file) => file.path === "Late.md")!;
      expect(late.version).toBe(4);
      // An edit the server never acknowledged is not recorded as agreed.
      expect(
        record.files.find((file) => file.path === "Packing list.md")!.hash,
      ).toBeNull();

      const added = await cli.json<Added>([
        "folders",
        "add",
        dir,
        "--folder",
        folder,
        "--yes",
      ]);
      expect(added.restore.record).toBe("other_instance");
      expect(added.restore.files).toContainEqual({
        path: "Late.md",
        outcome: "send",
        held: 1,
        sent: 4,
      });
      const pushed = await cli.run(["folders", "push", dir]);
      expect(pushed.code, pushed.stderr).toBe(0);
      expect(pushed.stdout).toContain(
        "Late.md is sent as an edit of version 1, which the instance holds as the restore left it",
      );
      // The witness: the backup brings back the file deleted while the
      // server was down, which is why the removal names it.
      expect(existsSync(join(dir, "Dropped.md"))).toBe(true);
      rmSync(join(dir, "Dropped.md"));
      await vi.waitFor(
        async () => {
          const again = await cli.run(["folders", "push", dir]);
          expect(again.code, again.stderr).toBe(0);
          const status = await cli.run(["folders", "status", dir]);
          expect(status.stdout).not.toContain("waiting");
        },
        { timeout: 30_000, interval: 1_000 },
      );

      const items = await notes(cli);
      expect(items.map((item) => item.properties.title).sort()).toEqual([
        "Late",
        "New idea",
        "Packing list",
        "Unchanged",
      ]);
      const body = (title: string): string | undefined =>
        items
          .find((item) => item.properties.title === title)
          ?.properties.body?.trim();
      expect(body("Late")).toBe("fourth");
      expect(body("Packing list")).toContain("boots");
      expect(body("New idea")).toContain("brand new");
      expect(existsSync(join(dir, ".marfa", "removed.json"))).toBe(false);
    } finally {
      await target.stop();
    }
  });

  it("keeps both where the instance changed a file's item since the restore, and sends nothing over a change made after the add", async () => {
    const script = "#!/bin/sh\nmarfa_version: 1\necho first\n";
    const changedScript = "#!/bin/sh\nmarfa_version: 1\necho changed\n";
    const { target, cli, dir, folder } = await restoredAfter(
      "Clash",
      ["core.note", "core.file"],
      async (first, dir) => {
        for (const title of ["Clash", "Equal", "Raced"]) {
          writeFileSync(join(dir, `${title}.md`), note(title, "in the backup"));
        }
        writeFileSync(join(dir, "tool.sh"), script);
        chmodSync(join(dir, "tool.sh"), 0o755);
        expect((await first.run(["folders", "push", dir])).code).toBe(0);
      },
      async (first, dir) => {
        await edits(first, dir, "Clash.md", [
          "origin 2",
          "origin 3",
          "origin 4",
        ]);
        await edits(first, dir, "Equal.md", ["origin 2"]);
        await edits(first, dir, "Raced.md", ["origin 2"]);
        writeFileSync(join(dir, "tool.sh"), changedScript);
        expect((await first.run(["folders", "push", dir])).code).toBe(0);
      },
    );
    try {
      const id = async (title: string): Promise<string> =>
        (await notes(cli)).find((item) => item.properties.title === title)!.id;
      // Each is version 2 on the new instance, with a body of its own: the
      // folder's files name version 4 and version 2.
      for (const title of ["Clash", "Equal"]) {
        await cli.json([
          "items",
          "update",
          await id(title),
          "--version",
          "1",
          "--prop",
          "body=edited on the instance",
        ]);
      }
      expect(readFileSync(join(dir, "Equal.md"), "utf8")).toContain(
        "marfa_version: 2",
      );
      expect((await cli.run(["folders", "remove", dir])).code).toBe(0);

      const added = await cli.json<Added>([
        "folders",
        "add",
        dir,
        "--folder",
        folder,
      ]);
      expect(added.restore.files).toContainEqual({
        path: "Clash.md",
        outcome: "both",
        held: 2,
        shared: 1,
      });
      expect(added.restore.files).toContainEqual({
        path: "Equal.md",
        outcome: "both",
        held: 2,
        shared: 1,
      });
      // The witness: held as the backup left it, so the folder's version
      // would be sent.
      expect(added.restore.files).toContainEqual({
        path: "Raced.md",
        outcome: "send",
        held: 1,
        sent: 2,
      });
      // Changed between the add and the push.
      await cli.json([
        "items",
        "update",
        await id("Raced"),
        "--version",
        "1",
        "--prop",
        "body=edited after the add",
      ]);
      expect((await cli.run(["folders", "confirm", dir])).code).toBe(0);
      await cli.run(["folders", "push", dir]);
      await cli.run(["folders", "push", dir]);

      const items = await notes(cli);
      const titled = (title: string) =>
        items.filter((item) => item.properties.title === title);
      expect(
        titled("Raced").map((item) => item.properties.body?.trim()),
      ).toEqual(["edited after the add"]);
      for (const [title, mine] of [
        ["Clash", "origin 4"],
        ["Equal", "origin 2"],
      ] as const) {
        const bodies = titled(title)
          .map((item) => item.properties.body?.trim())
          .sort();
        // Nothing overwritten: the instance's edit stays on the item, and
        // the folder's is kept in a copy.
        expect(bodies, title).toEqual(["edited on the instance", mine].sort());
      }
      // A file item is claimed only by its bytes, so the instance's older
      // bytes are written beside the file, which keeps every byte and its mode.
      const scripts = readdirSync(dir).filter((name) => name.endsWith(".sh"));
      expect(scripts.sort()).toEqual(["tool (2).sh", "tool.sh"]);
      const mine = scripts.find(
        (name) => readFileSync(join(dir, name), "utf8") === changedScript,
      );
      expect(mine).toBeDefined();
      expect(statSync(join(dir, mine!)).mode & 0o777).toBe(0o755);
      expect(
        scripts.map((name) => readFileSync(join(dir, name), "utf8")).sort(),
      ).toEqual([changedScript, script].sort());
    } finally {
      await target.stop();
    }
  });

  it("flags nothing in a directory added back on the instance it was removed from, and says nothing is known of a record it cannot read", async () => {
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
      writeFileSync(join(dir, "Kept.md"), note("Kept", "first"));
      expect((await cli.run(["folders", "push", dir])).code).toBe(0);
      expect((await cli.run(["folders", "remove", dir])).code).toBe(0);
      // Edited while no directory follows the folder: sent as an edit of
      // the version its line names, as any re-add sends it.
      const path = join(dir, "Kept.md");
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
      expect(pushed.stdout).not.toContain("waits");
      expect(
        (await notes(cli))
          .find((item) => item.properties.title === "Kept")
          ?.properties.body?.trim(),
      ).toBe("second");

      expect((await cli.run(["folders", "remove", dir])).code).toBe(0);
      const record = join(dir, ".marfa", "removed.json");
      const real = join(root, "elsewhere.json");
      writeFileSync(real, readFileSync(record));
      rmSync(record);
      symlinkSync(real, record);
      const linked = await cli.json<Added>([
        "folders",
        "add",
        dir,
        "--folder",
        folder,
        "--yes",
      ]);
      expect(linked.restore.record).toBe("unknown");
      expect(linked.restore.reason).toContain("cannot be read");

      expect((await cli.run(["folders", "remove", dir])).code).toBe(0);
      writeFileSync(record, "{ not a record");
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
      expect(readdirSync(join(dir, ".marfa"))).toContain("core.sqlite");
    } finally {
      await server.stop();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
 * A directory holding changes its server never received, after that server
 * was lost and a backup of it was restored into a new instance at the same
 * address.
 */

let origin: FreshServer | undefined;
let target: FreshServer | undefined;
let root: string;

beforeAll(async () => {
  origin = await bootFreshServer("cli-folder-instance-origin", DISK_ONLY);
  root = tempFolder("marfa-cli-folder-instance-");
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await origin?.stop();
  await target?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

interface Listed {
  data: Array<{
    id: string;
    type: string;
    properties: { title?: string; body?: string };
  }>;
}

interface Added {
  from: {
    older: Array<{ path: string; sent: number; held: number; changed: boolean }>;
    absent: string[];
    gone: string[];
    unknown?: string;
  };
}

const note = (title: string, body: string): string =>
  `---\ntitle: ${title}\n---\n${body}\n`;

describe("a directory whose server is now another instance", () => {
  it("sends a directory's unsent changes to the instance a backup was restored into, with marfa commands alone and no item twice", async () => {
    const registry = join(root, "registry", "folders.json");
    const dir = join(root, "Home");
    const aside = join(root, "Home.before-restore");
    const binary = requireBinary();
    const first = new Cli(binary, origin!.apiUrl, origin!.workingKey).withEnv({
      MARFA_FOLDER_REGISTRY: registry,
    });

    const made = await first.json<ItemEnvelope>([
      "folders",
      "create",
      "--title",
      "Home",
      "--query",
      JSON.stringify({ types: ["core.note"] }),
    ]);
    const folder = made.item.id;
    await first.json(["folders", "add", dir, "--folder", folder, "--yes"]);
    writeFileSync(join(dir, "Packing list.md"), note("Packing list", "socks"));
    writeFileSync(join(dir, "Plan.md"), note("Plan", "first"));
    writeFileSync(join(dir, "Unchanged.md"), note("Unchanged", "as it was"));
    writeFileSync(join(dir, "Dropped.md"), note("Dropped", "not wanted"));
    writeFileSync(join(dir, "Late.md"), note("Late", "in the backup"));
    expect((await first.run(["folders", "push", dir])).code).toBe(0);
    const backup = await (await everythingClient(origin!)).exportArchive();
    expect(backup.status).toBe(200);
    const archive = join(root, "backup.tar");
    writeFileSync(archive, backup.data);
    // Sent after the backup was made, so the new instance lacks it, and no
    // queue holds it.
    writeFileSync(join(dir, "Late.md"), note("Late", "sent after the backup"));
    expect((await first.run(["folders", "push", dir])).code).toBe(0);

    // The server is lost before it hears of these changes.
    const port = new URL(origin!.apiUrl).port;
    await origin!.stop();
    origin = undefined;
    const packing = readFileSync(join(dir, "Packing list.md"), "utf8").replace(
      "socks",
      "socks\nboots",
    );
    writeFileSync(join(dir, "Packing list.md"), packing);
    writeFileSync(join(dir, "Plan.md"), "first\nand second\n");
    writeFileSync(join(dir, "New idea.md"), note("New idea", "brand new"));
    rmSync(join(dir, "Dropped.md"));
    const unsent = await first.run(["folders", "push", dir]);
    expect(unsent.code, unsent.stderr).toBe(3);

    target = await bootFreshServer("cli-folder-instance-target", {
      ...DISK_ONLY,
      MARFA_PORT: port,
    });
    expect(target.apiUrl).toBe(first.url);
    const restored = await new Cli(binary, target.apiUrl, undefined)
      .viaSocket(target.controlSocket)
      .run(["restore", archive]);
    expect(restored.code, restored.stderr).toBe(0);
    const cli = new Cli(binary, target.apiUrl, target.workingKey).withEnv({
      MARFA_FOLDER_REGISTRY: registry,
    });

    const stopped = await cli.refused(["folders", "push", dir]);
    expect(JSON.stringify(stopped.envelope)).toContain("instance_changed");
    const files = (): Record<string, string> =>
      Object.fromEntries(
        readdirSync(dir)
          .filter((name) => name !== ".marfa")
          .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
      );
    const before = files();
    // The witness: the edits the server never received are in the files.
    expect(before["Packing list.md"]).toContain("boots");
    expect(before["Plan.md"]).toContain("and second");
    expect(before["New idea.md"]).toContain("brand new");

    const removed = await cli.run(["folders", "remove", dir]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stdout).toMatch(/[1-9]\d* write\(s\) could not be sent/);
    const lines = removed.stdout.split("\n");
    for (const line of [
      "  deleted  Dropped.md",
      "  new      New idea.md",
      "  changed  Packing list.md",
      "  changed  Plan.md",
    ]) {
      expect(lines, removed.stdout).toContain(line);
    }
    expect(removed.stdout).not.toContain("Unchanged.md");
    expect(removed.stdout).not.toContain("Late.md");
    expect(removed.stdout).toContain(`--from ${aside}`);
    expect(removed.stdout).toContain(`marfa folders push ${dir} --send-newer`);
    expect(removed.stdout).toContain(
      `until \`marfa folders status ${dir}\` shows nothing waiting`,
    );
    expect(removed.stdout).toContain(
      `The changes to changed, new and moved files stay in the files in ${dir}`,
    );
    const command = `marfa folders add ${dir} --folder ${folder} --from ${aside}`;
    expect(removed.stdout).toContain(command);
    expect(existsSync(join(dir, ".marfa", "core.sqlite"))).toBe(false);
    expect(files()).toEqual(before);

    // The route the removal names.
    renameSync(dir, aside);
    // Changed after the removal: the file as it is now is what is sent.
    writeFileSync(
      join(aside, "Late.md"),
      readFileSync(join(aside, "Late.md"), "utf8").replace(
        "sent after the backup",
        "changed after the removal",
      ),
    );
    const added = await cli.json<Added>([
      "folders",
      "add",
      dir,
      "--folder",
      folder,
      "--from",
      aside,
      "--yes",
    ]);
    // Sent after the backup was made: the only file the instance holds at
    // an older version than the folder last sent.
    expect(added.from.older.map((file) => file.path)).toEqual(["Late.md"]);
    expect(added.from.older[0]!.held).toBeLessThan(added.from.older[0]!.sent);
    expect(added.from.older[0]!.changed).toBe(true);
    const written = await cli.run(["folders", "push", dir]);
    expect(written.code, written.stderr).toBe(0);
    // The witness: the backup brings back the file deleted while the server
    // was down, which is why the removal names it.
    expect(existsSync(join(dir, "Dropped.md"))).toBe(true);
    rmSync(join(dir, "Dropped.md"));
    const named = ["Packing list.md", "Plan.md", "New idea.md"];
    for (const name of named) {
      cpSync(join(aside, name), join(dir, name));
    }
    // The witness: the instance's copy of the late file lacks the edit.
    expect(readFileSync(join(dir, "Late.md"), "utf8")).toContain(
      "in the backup",
    );
    // Step 4. The witness: one push leaves the deletion waiting out the
    // folder's grace for a rename.
    const sent = await cli.run(["folders", "push", dir, "--send-newer"]);
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout).toContain(
      "Late.md: the moved directory's version is sent",
    );
    const waiting = await cli.run(["folders", "status", dir]);
    expect(waiting.stdout).toContain("Dropped.md: waiting");
    await vi.waitFor(
      async () => {
        const pushed = await cli.run(["folders", "push", dir]);
        expect(pushed.code, pushed.stderr).toBe(0);
        const status = await cli.run(["folders", "status", dir]);
        expect(status.stdout).not.toContain("waiting");
      },
      { timeout: 30_000, interval: 1_000 },
    );

    const items = await cli.json<Listed>([
      "items",
      "list",
      "--type",
      "core.note",
      "--limit",
      "100",
    ]);
    const titles = items.data.map((item) => item.properties.title).sort();
    expect(titles).toEqual([
      "Late",
      "New idea",
      "Packing list",
      "Plan",
      "Unchanged",
    ]);
    const body = (title: string): string | undefined =>
      items.data.find((item) => item.properties.title === title)?.properties
        .body;
    expect(body("Packing list")).toContain("boots");
    expect(body("Plan")).toContain("and second");
    expect(body("New idea")).toContain("brand new");
    expect(body("Late")).toContain("changed after the removal");
    expect(
      readdirSync(dir)
        .filter((name) => name !== ".marfa")
        .sort(),
    ).toEqual([
      "Late.md",
      "New idea.md",
      "Packing list.md",
      "Plan.md",
      "Unchanged.md",
    ]);
    const status = await cli.run(["folders", "status", dir]);
    expect(status.stdout).toContain("5 file(s) in step");
  });

  it("sends no file whose item the instance changed after the add or holds at the same or a newer version, and names one it lacks or that is gone", async () => {
    const binary = requireBinary();
    const registry = join(root, "registry-guards", "folders.json");
    const dir = join(root, "Guards");
    const aside = join(root, "Guards.before-restore");
    const lost = await bootFreshServer("cli-folder-guards-origin", DISK_ONLY);
    let found: FreshServer | undefined;
    try {
      const first = new Cli(binary, lost.apiUrl, lost.workingKey).withEnv({
        MARFA_FOLDER_REGISTRY: registry,
      });
      const made = await first.json<ItemEnvelope>([
        "folders",
        "create",
        "--title",
        "Guards",
        "--query",
        JSON.stringify({ types: ["core.note"] }),
      ]);
      const folder = made.item.id;
      await first.json(["folders", "add", dir, "--folder", folder, "--yes"]);
      for (const title of ["Raced", "Same", "Dropped"]) {
        writeFileSync(join(dir, `${title}.md`), note(title, "in the backup"));
      }
      expect((await first.run(["folders", "push", dir])).code).toBe(0);
      const backup = await (await everythingClient(lost)).exportArchive();
      expect(backup.status).toBe(200);
      const archive = join(root, "guards.tar");
      writeFileSync(archive, backup.data);
      for (const title of ["Raced", "Dropped", "Fresh"]) {
        writeFileSync(join(dir, `${title}.md`), note(title, "sent after"));
      }
      expect((await first.run(["folders", "push", dir])).code).toBe(0);
      const port = new URL(lost.apiUrl).port;
      await lost.stop();

      found = await bootFreshServer("cli-folder-guards-target", {
        ...DISK_ONLY,
        MARFA_PORT: port,
      });
      const restored = await new Cli(binary, found.apiUrl, undefined)
        .viaSocket(found.controlSocket)
        .run(["restore", archive]);
      expect(restored.code, restored.stderr).toBe(0);
      const cli = new Cli(binary, found.apiUrl, found.workingKey).withEnv({
        MARFA_FOLDER_REGISTRY: registry,
      });
      const notes = async (): Promise<Listed["data"]> =>
        (
          await cli.json<Listed>([
            "items",
            "list",
            "--type",
            "core.note",
            "--limit",
            "100",
          ])
        ).data;
      const id = async (title: string): Promise<string> =>
        (await notes()).find((item) => item.properties.title === title)!.id;
      const body = async (title: string): Promise<string | undefined> =>
        (await notes()).find((item) => item.properties.title === title)
          ?.properties.body;
      // Edited on the new instance after the restore, so it holds a version
      // as new as the one the folder sent.
      await cli.json([
        "items",
        "update",
        await id("Same"),
        "--version",
        "1",
        "--prop",
        "body=edited after the restore",
      ]);
      const stopped = await cli.refused(["folders", "push", dir]);
      expect(JSON.stringify(stopped.envelope)).toContain("instance_changed");
      const removed = await cli.run(["folders", "remove", dir]);
      expect(removed.code, removed.stderr).toBe(0);
      expect(removed.stdout).not.toContain("could not be sent");
      expect(removed.stdout).toContain(`marfa folders push ${dir} --send-newer`);
      rmSync(join(dir, "Dropped.md"));
      renameSync(dir, aside);

      const added = await cli.json<Added>([
        "folders",
        "add",
        dir,
        "--folder",
        folder,
        "--from",
        aside,
        "--yes",
      ]);
      // The witness: a file sent after the backup is named.
      expect(added.from.older.map((file) => file.path)).toEqual(["Raced.md"]);
      expect(added.from.absent).toEqual(["Fresh.md"]);
      expect(added.from.gone).toEqual(["Dropped.md"]);
      expect((await cli.run(["folders", "push", dir])).code).toBe(0);
      await cli.json([
        "items",
        "update",
        await id("Raced"),
        "--version",
        "1",
        "--prop",
        "body=edited after the add",
      ]);
      const sent = await cli.run(["folders", "push", dir, "--send-newer"]);
      expect(sent.code, sent.stderr).toBe(0);
      expect(sent.stdout).toContain(
        "Raced.md: not sent, because the instance changed its item after the add read it",
      );
      expect(await body("Raced")).toBe("edited after the add");
      expect(await body("Same")).toBe("edited after the restore");
      expect(await body("Fresh")).toBeUndefined();
      expect(readFileSync(join(dir, "Raced.md"), "utf8")).toContain(
        "edited after the add",
      );
    } finally {
      await lost.stop();
      await found?.stop();
    }
  });

  it("names no file a folder added back on the instance it was removed from sent, and says nothing is known of a directory with no record or one it cannot read", async () => {
    const binary = requireBinary();
    const registry = join(root, "registry-same", "folders.json");
    const dir = join(root, "Same");
    const aside = join(root, "Same.before");
    const plain = join(root, "Plain");
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
      writeFileSync(join(dir, "Kept.md"), note("Kept", "second"));
      expect((await cli.run(["folders", "push", dir])).code).toBe(0);
      expect((await cli.run(["folders", "remove", dir])).code).toBe(0);

      const inPlace = await cli.run([
        "folders",
        "add",
        dir,
        "--folder",
        folder,
        "--from",
        dir,
      ]);
      expect(inPlace.code).toBe(2);
      expect(existsSync(join(dir, ".marfa", "core.sqlite"))).toBe(false);

      renameSync(dir, aside);
      const added = await cli.json<Added>([
        "folders",
        "add",
        dir,
        "--folder",
        folder,
        "--from",
        aside,
        "--yes",
      ]);
      expect(added.from.unknown).toBeUndefined();
      expect(added.from).toMatchObject({ older: [], absent: [], gone: [] });

      mkdirSync(plain);
      writeFileSync(join(plain, "Plain.md"), note("Plain", "no folder"));
      const other = join(root, "Other");
      const unknown = await cli.json<Added>([
        "folders",
        "add",
        other,
        "--folder",
        folder,
        "--from",
        plain,
        "--yes",
      ]);
      expect(unknown.from.unknown).toContain("holds no record");
      expect(existsSync(join(other, ".marfa", "core.sqlite"))).toBe(true);

      mkdirSync(join(plain, ".marfa"));
      writeFileSync(join(plain, ".marfa", "removed.json"), "{ not a record");
      const third = join(root, "Third");
      const unreadable = await cli.json<Added>([
        "folders",
        "add",
        third,
        "--folder",
        folder,
        "--from",
        plain,
        "--yes",
      ]);
      expect(unreadable.from.unknown).toContain("cannot be read");
      expect(existsSync(join(third, ".marfa", "core.sqlite"))).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

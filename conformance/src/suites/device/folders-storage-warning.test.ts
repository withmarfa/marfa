import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CliFolder,
  type FolderSettings,
  type HeldCommand,
} from "../../device/cli-adapter.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import {
  KEY,
  requireBinary,
  scriptFolderRow,
  scriptHydration,
} from "./harness.js";

/**
 * Where a folder's directory sits: iCloud Drive, a cloud service's synced
 * location, a network file system. Each case builds a home of its own in a
 * temporary directory and runs the binary with `HOME` set to it, so the
 * synced locations are made there and the person's real home is never read
 * or written.
 */

const WAIT = { timeout: 30_000, interval: 100 };
const SETTINGS: FolderSettings = { search: { types: ["core.note"] } };

const ICLOUD = "Library/Mobile Documents/com~apple~CloudDocs/notes";
const CLOUD = "Library/CloudStorage/Dropbox/notes";
const ELSEWHERE = "Documents/notes";

const WARNING = "marfa: warning: ";

const stops: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

interface Machine {
  home: string;
  registry: string;
  server: ScriptedServer;
  /** A folder at `below` in the home, bound to a `system.folder` of its own. */
  folder: (below: string) => Placed;
}

interface Placed {
  dir: string;
  folder: CliFolder;
  id: string;
  /** `folders add`, run under the machine's home. */
  add: (flags?: string[]) => Promise<Ran>;
  /** A command on the folder under the machine's home, left running. */
  hold: (args: string[]) => HeldCommand;
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function machine(label: string): Promise<Machine> {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), `marfa-storage-${label}-`),
  );
  stops.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, "home");
  mkdirSync(home);
  const registry = join(root, "registry", "folders.json");
  const server = await ScriptedServer.start();
  stops.push(async () => {
    const unscripted = [...server.unmatchedRequests];
    await server.stop();
    if (unscripted.length > 0) {
      throw new Error(
        `the folder went to a door no answer was scripted for: ${unscripted.join(", ")}`,
      );
    }
  });
  scriptHydration(server, { head: "1", edges: {} });
  return {
    home,
    registry,
    server,
    folder: (below) => {
      const dir = join(home, below);
      mkdirSync(dir, { recursive: true });
      const row = scriptFolderRow(server, SETTINGS);
      const folder = new CliFolder(dir, {
        binary: requireBinary(),
        url: server.url,
        key: KEY,
        registry,
      });
      const hold = (args: string[]): HeldCommand => {
        const held = folder.device().hold(args, "root", { HOME: home });
        stops.push(() => held.stop());
        return held;
      };
      return {
        dir,
        folder,
        id: row.id,
        hold,
        add: async (flags = []) => {
          const added = hold([
            "folders",
            "add",
            dir,
            "--folder",
            row.id,
            "--yes",
            ...flags,
          ]);
          await added.exited();
          return {
            code: added.exitCode(),
            stdout: added.stdout,
            stderr: added.stderr,
          };
        },
      };
    },
  };
}

/** The warnings in what a command printed to standard error. */
function warnings(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line.startsWith(WARNING));
}

/** What a watch has printed, one JSON value a line. */
function linesOf(watch: HeldCommand): Array<Record<string, unknown>> {
  return watch.stdout
    .split("\n")
    .slice(0, -1)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error(`a watch printed a line that is not JSON: ${line}`);
      }
    });
}

function watching(watch: HeldCommand, dir: string): number {
  return linesOf(watch).filter(
    (line) => line.dir === dir && line.watching === true,
  ).length;
}

/** `folders add` of a folder at `below`: the one warning, the add done. */
async function addWarns(below: string, says: string): Promise<void> {
  const machined = await machine("add");
  const placed = machined.folder(below);
  const added = await placed.add();
  expect(added.code, added.stderr).toBe(0);
  const said = warnings(added.stderr);
  expect(said, added.stderr).toHaveLength(1);
  expect(said[0]).toContain(placed.dir);
  expect(said[0]).toContain(says);
  // Nothing else on standard error, and standard output is the one JSON
  // document of the add.
  expect(added.stderr.trim().split("\n")).toEqual(said);
  expect(JSON.parse(added.stdout)).toMatchObject({
    dir: placed.dir,
    folder: placed.id,
  });
  const listed = await placed.folder.list();
  expect(listed.ok && listed.value.map((entry) => entry.dir)).toEqual([
    placed.dir,
  ]);
}

/** `folders watch` of a folder at `below`: the one warning, first, and the watch running. */
async function watchWarns(below: string, says: string): Promise<void> {
  const machined = await machine("watch");
  const placed = machined.folder(below);
  expect((await placed.add()).code).toBe(0);
  expect((await placed.folder.hydrate()).ok).toBe(true);
  const watch = placed.hold(["folders", "watch", placed.dir]);
  await vi.waitFor(() => expect(watch.stderr).toContain("watching "), WAIT);
  const said = warnings(watch.stderr);
  expect(said, watch.stderr).toHaveLength(1);
  expect(said[0]).toContain(placed.dir);
  expect(said[0]).toContain(says);
  expect(
    watch.stderr.indexOf(WARNING),
    "the warning came after the watch had started",
  ).toBeLessThan(watch.stderr.indexOf("watching "));
  expect(watch.running(), watch.stderr).toBe(true);
  // Under --json, standard output stays one JSON value a line.
  linesOf(watch);
}

describe("a folder in cloud-synced storage", () => {
  it("warns once on standard error when it is added to iCloud Drive, and adds it all the same", async () => {
    await addWarns(ICLOUD, "iCloud Drive");
  });

  it("warns once on standard error when a watch starts on a folder in iCloud Drive, and watches all the same", async () => {
    await watchWarns(ICLOUD, "iCloud Drive");
  });

  it("warns once on standard error when it is added to a cloud service's synced location, and adds it all the same", async () => {
    await addWarns(CLOUD, "cloud service");
  });

  it("warns once on standard error when a watch starts on a folder in a cloud service's synced location, and watches all the same", async () => {
    await watchWarns(CLOUD, "cloud service");
  });

  it("keeps standard output to its JSON document under --json, with the warning a plain line on standard error", async () => {
    const machined = await machine("json");
    const placed = machined.folder(ICLOUD);
    const added = await placed.add();
    expect(added.code, added.stderr).toBe(0);
    expect(warnings(added.stderr)).toHaveLength(1);
    expect(added.stdout).not.toContain(WARNING);
    expect(() => JSON.parse(added.stdout)).not.toThrow();
    // The witness: the same command without --json says it as text, so the
    // JSON above is a choice the flag made and not an accident of the add.
    const other = machined.folder("Library/CloudStorage/Box/notes");
    const text = other.hold([
      "folders",
      "add",
      other.dir,
      "--folder",
      other.id,
      "--yes",
    ]);
    await text.exited();
    expect(text.exitCode(), text.stderr).toBe(0);
    expect(warnings(text.stderr)).toHaveLength(1);
  });
});

describe("a folder anywhere else", () => {
  it("prints no warning when it is added or watched, where the same home warns of a synced one", async () => {
    const machined = await machine("elsewhere");
    const synced = machined.folder(ICLOUD);
    const plain = machined.folder(ELSEWHERE);
    // The witness: the same home, the same command and the same server warn
    // of the synced folder.
    const warned = await synced.add();
    expect(warnings(warned.stderr), warned.stderr).toHaveLength(1);

    const added = await plain.add();
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toBe("");
    expect((await plain.folder.hydrate()).ok).toBe(true);
    const watch = plain.hold(["folders", "watch", plain.dir]);
    await vi.waitFor(() => expect(watch.stderr).toContain("watching "), WAIT);
    expect(watch.stderr).not.toContain(WARNING);
    expect(watch.running(), watch.stderr).toBe(true);
  });

  it("is not taken for a synced one by a name that only begins like a synced location", async () => {
    const machined = await machine("lookalike");
    const lookalike = machined.folder("Library/Mobile Documents2/notes");
    const added = await lookalike.add();
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toBe("");
  });
});

describe("a watch of every folder", () => {
  it("warns once per synced folder, and not again when a folder is taken off the list and put back", async () => {
    const machined = await machine("every");
    const icloud = machined.folder(ICLOUD);
    const cloud = machined.folder(CLOUD);
    const plain = machined.folder(ELSEWHERE);
    for (const placed of [icloud, cloud, plain]) {
      expect((await placed.add()).code).toBe(0);
      expect((await placed.folder.hydrate()).ok).toBe(true);
    }

    const watch = icloud.hold(["folders", "watch"]);
    await vi.waitFor(() => {
      for (const placed of [icloud, cloud, plain]) {
        expect(watching(watch, placed.dir), watch.stdout).toBe(1);
      }
    }, WAIT);
    const warned = (dir: string): string[] =>
      warnings(watch.stderr).filter((line) => line.includes(dir));
    expect(warned(icloud.dir), watch.stderr).toHaveLength(1);
    expect(warned(cloud.dir), watch.stderr).toHaveLength(1);
    expect(warned(plain.dir), watch.stderr).toHaveLength(0);
    expect(warnings(watch.stderr)).toHaveLength(2);

    // The watch of the iCloud folder ends and starts again in the same run.
    // Its directory is taken away first, since a watch holds a folder and
    // only an unlisted one is let go.
    renameSync(icloud.dir, `${icloud.dir}-away`);
    const removed = await icloud.folder.remove();
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    await vi.waitFor(
      () =>
        expect(
          linesOf(watch).filter(
            (line) => line.dir === icloud.dir && line.listed === false,
          ),
          watch.stdout,
        ).toHaveLength(1),
      WAIT,
    );
    renameSync(`${icloud.dir}-away`, icloud.dir);
    const again = await icloud.add();
    expect(again.code, again.stderr).toBe(0);
    expect((await icloud.folder.hydrate()).ok).toBe(true);
    await vi.waitFor(
      () => expect(watching(watch, icloud.dir), watch.stdout).toBe(2),
      WAIT,
    );
    expect(
      warned(icloud.dir),
      `a watch that started again warned again: ${watch.stderr}`,
    ).toHaveLength(1);
    expect(warnings(watch.stderr)).toHaveLength(2);
    expect(watch.running(), watch.stderr).toBe(true);
  });
});

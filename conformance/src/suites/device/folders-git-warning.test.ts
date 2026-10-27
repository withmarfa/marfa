import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliFolder, type FolderSettings } from "../../device/cli-adapter.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import {
  KEY,
  requireBinary,
  scriptFolderRow,
  scriptHydration,
} from "./harness.js";

/**
 * A folder whose directory git tracks: `folders add` warns and adds it all the
 * same. Each case makes its repository in a temporary directory, so the
 * person's own repositories are never read, and runs git with a home of its
 * own so no global setting of the machine reaches it.
 */

const SETTINGS: FolderSettings = { query: { types: ["core.note"] } };
const WARNING = "marfa: warning: ";

const stops: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Placed {
  dir: string;
  id: string;
  folder: CliFolder;
  add: (env?: NodeJS.ProcessEnv, text?: boolean) => Promise<Ran>;
}

interface Machine {
  root: string;
  /** Runs git in `dir`. */
  git: (dir: string, ...args: string[]) => void;
  /** A directory at `below` the machine's root, made if it is not there. */
  place: (below: string) => Promise<Placed>;
}

async function machine(): Promise<Machine> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "marfa-git-"));
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
    root,
    git: (dir, ...args) => {
      execFileSync(
        "git",
        [
          "-C",
          dir,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          ...args,
        ],
        {
          env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
          stdio: "pipe",
        },
      );
    },
    place: async (below) => {
      const dir = join(root, below);
      mkdirSync(dir, { recursive: true });
      const row = scriptFolderRow(server, SETTINGS);
      const folder = new CliFolder(dir, {
        binary: requireBinary(),
        url: server.url,
        key: KEY,
        registry,
      });
      return {
        dir,
        id: row.id,
        folder,
        add: async (env = {}, text = false) => {
          const held = folder
            .device()
            .hold(
              ["folders", "add", dir, "--folder", row.id, "--yes"],
              text ? "text" : "root",
              { HOME: home, ...env },
            );
          stops.push(() => held.stop());
          await held.exited();
          return {
            code: held.exitCode(),
            stdout: held.stdout,
            stderr: held.stderr,
          };
        },
      };
    },
  };
}

function warnings(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line.startsWith(WARNING));
}

/** A repository at `repo` with a tracked `code/` and an ignored `marfa/`. */
function repository(machined: Machine, repo: string): void {
  mkdirSync(repo, { recursive: true });
  machined.git(repo, "init", "-q");
  writeFileSync(join(repo, ".gitignore"), "marfa/\n");
  mkdirSync(join(repo, "code"));
  writeFileSync(join(repo, "code", "a.md"), "tracked\n");
  machined.git(repo, "add", ".gitignore", "code");
  machined.git(repo, "commit", "-q", "-m", "first");
}

async function added(placed: Placed): Promise<Ran> {
  const ran = await placed.add();
  expect(ran.code, ran.stderr).toBe(0);
  const listed = await placed.folder.list();
  expect(listed.ok && listed.value.map((entry) => entry.dir)).toEqual([
    placed.dir,
  ]);
  return ran;
}

describe("a folder in a directory git tracks", () => {
  it("warns on standard error when git tracks the directory, and adds it all the same", async () => {
    const machined = await machine();
    const repo = join(machined.root, "repo");
    repository(machined, repo);
    const placed = await machined.place("repo/code");
    const ran = await added(placed);
    const said = warnings(ran.stderr);
    expect(said, ran.stderr).toHaveLength(1);
    expect(said[0]).toContain("git tracks");
    expect(said[0]).toContain(placed.dir);
    expect(said[0]).toContain("git ignores");
    expect(ran.stderr.trim().split("\n")).toEqual(said);
  });

  it("keeps standard output to its JSON document under --json", async () => {
    const machined = await machine();
    repository(machined, join(machined.root, "repo"));
    const placed = await machined.place("repo/code");
    const ran = await added(placed);
    expect(warnings(ran.stderr)).toHaveLength(1);
    expect(ran.stdout).not.toContain(WARNING);
    expect(JSON.parse(ran.stdout)).toMatchObject({
      dir: placed.dir,
      folder: placed.id,
    });
    // The witness: without --json the add prints text, and the warning is on
    // standard error either way.
    const other = await machined.place("repo/more");
    writeFileSync(join(other.dir, "b.md"), "tracked\n");
    machined.git(other.dir, "add", "b.md");
    const text = await other.add({}, true);
    expect(text.code, text.stderr).toBe(0);
    expect(warnings(text.stderr)).toHaveLength(1);
    expect(text.stdout).not.toContain(WARNING);
    expect(() => JSON.parse(text.stdout)).toThrow();
  });

  it("warns of a directory in a linked work tree, where .git is a file", async () => {
    const machined = await machine();
    const repo = join(machined.root, "repo");
    repository(machined, repo);
    const linked = join(machined.root, "linked");
    machined.git(repo, "worktree", "add", "-q", linked);
    const placed = await machined.place("linked/code");
    const ran = await added(placed);
    expect(warnings(ran.stderr), ran.stderr).toHaveLength(1);
  });
});

describe("a folder in a directory git does not track", () => {
  it("prints no warning for a directory that is ignored, untracked, or outside a repository", async () => {
    const machined = await machine();
    const repo = join(machined.root, "repo");
    repository(machined, repo);
    // The witness: the same repository warns of its tracked directory.
    const tracked = await machined.place("repo/code");
    expect(
      warnings((await added(tracked)).stderr),
      "the tracked directory warned",
    ).toHaveLength(1);

    const ignored = await machined.place("repo/marfa");
    writeFileSync(join(ignored.dir, "c.md"), "ignored\n");
    const untracked = await machined.place("repo/fresh");
    writeFileSync(join(untracked.dir, "d.md"), "untracked\n");
    const outside = await machined.place("outside/notes");
    for (const placed of [ignored, untracked, outside]) {
      const ran = await placed.add();
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stderr, placed.dir).toBe("");
    }
  });

  it("prints no warning, and adds the folder, when git cannot be run", async () => {
    const machined = await machine();
    repository(machined, join(machined.root, "repo"));
    const placed = await machined.place("repo/code");
    // The witness is the first case: the same directory warns with git on the
    // path.
    const empty = join(machined.root, "no-bin");
    mkdirSync(empty);
    const ran = await placed.add({ PATH: empty });
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).toBe("");
    const listed = await placed.folder.list();
    expect(listed.ok && listed.value.map((entry) => entry.dir)).toEqual([
      placed.dir,
    ]);
  });
});

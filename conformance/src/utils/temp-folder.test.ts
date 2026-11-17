import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ON_MACOS } from "./platform.js";
import {
  detachImage,
  detachImageAtCleanup,
  isRunning,
  onCleanup,
  removeTempFolder,
  removeTempFolders,
  RUN_LIST_VARIABLE,
  stopChildAtCleanup,
  tempFolder,
  unlockAndRemove,
} from "./temp-folder.js";
import listRunFolders from "./temp-folder-run.js";

const here = dirname(fileURLToPath(import.meta.url));
const helper = resolve(here, "temp-folder.ts");

/** A folder this test owns outright, outside the helper under test. */
function bare(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "marfa-temp-folder-test-")));
}

/** What a fixture leaves that a plain `rm -rf` cannot take. */
function locked(root: string): void {
  const shut = join(root, "shut");
  mkdirSync(shut);
  writeFileSync(join(shut, "inside"), "x");
  chmodSync(shut, 0o000);
  if (process.platform !== "darwin") return;
  const held = join(root, "held");
  writeFileSync(held, "x");
  execFileSync("chflags", ["uchg", held]);
  const guarded = join(root, "guarded");
  mkdirSync(guarded);
  execFileSync("chmod", ["+a", "everyone deny delete", guarded]);
}

describe("removing what a run made", () => {
  it("cannot be done by a plain removal when a fixture locked what it made", () => {
    // The witness: the same tree resists `rmSync`, so the next test proves
    // the unlocking and not an easy case.
    const root = bare();
    try {
      locked(root);
      // Permissions do not bind a superuser, so there is nothing to resist.
      if (process.getuid?.() !== 0) {
        expect(() => rmSync(root, { recursive: true })).toThrow();
      }
    } finally {
      unlockAndRemove(root);
    }
    expect(existsSync(root)).toBe(false);
  });

  it("removes a folder holding a file with no access, an immutable file and a deny-delete rule", () => {
    const root = bare();
    locked(root);
    unlockAndRemove(root);
    expect(existsSync(root)).toBe(false);
  });

  it("removes the folders a process made, after undoing what it registered, last first", () => {
    const first = tempFolder("marfa-temp-folder-test-");
    const second = tempFolder("marfa-temp-folder-test-");
    locked(second);
    const seen: string[] = [];
    onCleanup(() => {
      seen.push(`first ${String(existsSync(first))}`);
    });
    onCleanup(() => {
      seen.push(`second ${String(existsSync(second))}`);
      throw new Error("an action that fails");
    });
    expect(() => {
      removeTempFolders();
    }).toThrow("an action that fails");
    expect(seen).toEqual(["second true", "first true"]);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it("refuses a path it did not make", () => {
    const outside = bare();
    try {
      expect(() => {
        removeTempFolder(outside);
      }).toThrow("was not made by tempFolder");
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stops a child process the fixture started and has not seen end", () => {
    const child = spawn("sleep", ["300"], { stdio: "ignore" });
    stopChildAtCleanup(child);
    expect(child.pid !== undefined && isRunning(child.pid)).toBe(true);
    removeTempFolders();
    expect(child.pid !== undefined && isRunning(child.pid)).toBe(false);
  });

  it(
    "detaches a disk image its fixture attached, and nothing else",
    ON_MACOS,
    () => {
      const root = tempFolder("marfa-temp-folder-image-");
      const mount = join(root, "volume");
      mkdirSync(mount);
      const image = join(root, "case.sparseimage");
      execFileSync("hdiutil", [
        "create",
        "-size",
        "16m",
        "-type",
        "SPARSE",
        "-fs",
        "APFS",
        "-volname",
        "conformance",
        image,
      ]);
      execFileSync("hdiutil", [
        "attach",
        image,
        "-mountpoint",
        mount,
        "-nobrowse",
        "-noautoopen",
      ]);
      detachImageAtCleanup(mount);
      const attached = () =>
        spawnSync("hdiutil", ["info"], { encoding: "utf8" }).stdout.includes(
          image,
        );
      expect(attached()).toBe(true);
      removeTempFolders();
      expect(attached()).toBe(false);
      expect(existsSync(root)).toBe(false);
      // Nothing mounted there: nothing to do.
      detachImage(mount);
    },
  );
});

/**
 * Runs `body` in a process that has made a folder, and resolves with that
 * folder's name once the process is gone. With `signal`, sends it once the
 * body says `ready`.
 */
function run(body: string, signal?: NodeJS.Signals): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { tempFolder } from ${JSON.stringify(helper)};
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
const folder = tempFolder("marfa-temp-folder-child-");
process.stdout.write(folder + "\\n");
${body}`,
      ],
      { cwd: resolve(here, "../.."), stdio: ["ignore", "pipe", "inherit"] },
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (signal !== undefined && output.includes("ready")) child.kill(signal);
    });
    child.once("error", fail);
    child.once("close", () => {
      done(output.split("\n")[0]!);
    });
  });
}

describe("a process that ends before its tests do", () => {
  it("removes its folders when it exits", async () => {
    const folder = await run("");
    expect(folder).toContain("marfa-r-");
    expect(existsSync(folder)).toBe(false);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "removes its folders, locked ones too, when it gets %s part-way",
    async (signal) => {
      const folder = await run(
        `mkdirSync(folder + "/shut");
writeFileSync(folder + "/shut/inside", "x");
chmodSync(folder + "/shut", 0);
process.stdout.write("ready\\n");
setInterval(() => undefined, 1000);`,
        signal,
      );
      expect(existsSync(folder)).toBe(false);
    },
    30_000,
  );
});

describe("the run's check that nothing is left", () => {
  /** Runs the run's setup and teardown as the runner does, apart from this run's own. */
  function runOnce(leave: boolean): () => void {
    const own = process.env[RUN_LIST_VARIABLE];
    const teardown = listRunFolders();
    const list = process.env[RUN_LIST_VARIABLE]!;
    let left: string | undefined;
    if (leave) {
      left = bare();
      writeFileSync(list, `${left}\n`);
    }
    return () => {
      try {
        teardown();
      } finally {
        if (own === undefined) delete process.env[RUN_LIST_VARIABLE];
        else process.env[RUN_LIST_VARIABLE] = own;
        if (left !== undefined) {
          expect(existsSync(left)).toBe(false);
        }
        expect(existsSync(list)).toBe(false);
      }
    };
  }

  it("passes a run whose processes removed every folder they listed", () => {
    const finish = runOnce(false);
    expect(finish).not.toThrow();
  });

  it("fails a run that left a folder behind, and removes it", () => {
    const finish = runOnce(true);
    expect(finish).toThrow("left behind");
  });

  it("lists the run folder a process makes in the file the run named", async () => {
    const own = process.env[RUN_LIST_VARIABLE];
    const teardown = listRunFolders();
    try {
      const list = process.env[RUN_LIST_VARIABLE]!;
      expect(readFileSync(list, "utf8")).toBe("");
      const folder = await run("");
      expect(readFileSync(list, "utf8").trim()).toBe(dirname(folder));
    } finally {
      teardown();
      if (own === undefined) delete process.env[RUN_LIST_VARIABLE];
      else process.env[RUN_LIST_VARIABLE] = own;
    }
  });
});

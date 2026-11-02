import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CliFolder } from "../../device/cli-adapter.js";
import type { HeldCommand } from "../../device/cli-adapter.js";
import { KEY, folderHarness, requireBinary } from "./harness.js";
import type { FolderHarness } from "./harness.js";
import { put, scriptFolderWrites, sentTitles } from "./folders.shared.js";

/**
 * A watch noticing that a new build of marfa is installed at the path it was
 * started by, as an upgrade does: a link moved to another build, or a file
 * replaced. The new build here is a script that says another version, so no
 * second build of marfa is needed; the watch only asks it its version.
 */

const WAIT = { timeout: 30_000, interval: 100 };
/** How often the watch looks at its path, in place of ten seconds. */
const LOOK = { MARFA_TEST_NEW_BUILD_CHECK_MS: "200" };
const NEXT = "9.9.9";

const made: FolderHarness[] = [];
const held: HeldCommand[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const command of held.splice(0)) await command.stop();
  for (const harness of made.splice(0).reverse()) await harness.stop();
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = mkdtempSync(
    join(realpathSync(tmpdir()), `marfa-new-build-${label}-`),
  );
  scratch.push(dir);
  return dir;
}

/** The version the binary under test says it is. */
function running(): string {
  return execFileSync(requireBinary(), ["--version"], { encoding: "utf8" })
    .trim()
    .replace(/^marfa /, "");
}

/** A program that answers `--version` as `body` says, made executable. */
function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const says = (version: string) =>
  `if [ "$1" = "--version" ]; then echo "marfa ${version}"; exit 0; fi\nexit 64`;

/** Moves `link` to lead to `target` in one step, as a package manager does. */
function retarget(link: string, target: string): void {
  const next = `${link}.next`;
  symlinkSync(target, next);
  renameSync(next, link);
}

/** The folder, run through `binary` in place of the binary under test. */
function through(harness: FolderHarness, binary: string): CliFolder {
  return new CliFolder(harness.dir, {
    binary,
    url: harness.server.url,
    key: KEY,
    registry: harness.registry,
  });
}

function hold(command: HeldCommand): HeldCommand {
  held.push(command);
  return command;
}

interface Said {
  new_build: string | null;
  running?: string;
  restarting?: boolean;
  binary?: string;
  usable?: boolean;
  reason?: string;
}

/** What the watch said of the path it was started by, in order. */
function said(watch: HeldCommand): Said[] {
  return watch.stdout
    .split("\n")
    .filter((line) => line.includes('"new_build"'))
    .map((line) => JSON.parse(line) as Said);
}

interface Entry {
  pid: number;
  marfa_version?: string;
  heartbeat_at: string;
  ended_at: string | null;
  folders: Array<{ dir: string; watching: boolean; reason: string | null }>;
}

function recordPath(harness: FolderHarness): string {
  return join(dirname(harness.registry), "folder-watch.json");
}

function entryOf(harness: FolderHarness, pid: number): Entry | undefined {
  const path = recordPath(harness);
  if (!existsSync(path)) return undefined;
  return (
    JSON.parse(readFileSync(path, "utf8")) as { processes: Entry[] }
  ).processes.find((entry) => entry.pid === pid);
}

async function watching(
  harness: FolderHarness,
  watch: HeldCommand,
): Promise<void> {
  await vi.waitFor(() => {
    expect(
      entryOf(harness, watch.pid())?.folders.find(
        (folder) => folder.dir === harness.dir,
      )?.watching,
      watch.stderr,
    ).toBe(true);
  }, WAIT);
}

describe("a watch and a new build at the path it was started by", () => {
  it("ends with exit status 3 once a link it was started through moves to a new build, naming both versions, and the next watch sends what it had not", async () => {
    const harness = await folderHarness("new-build-link");
    made.push(harness);
    scriptFolderWrites(harness);
    const dir = scratchDir("link");
    const link = join(dir, "marfa");
    symlinkSync(requireBinary(), link);
    const next = script(dir, "marfa-next", says(NEXT));
    const folder = through(harness, link);

    const watch = hold(
      folder.hold(
        ["folders", "watch", harness.dir, "--exit-on-new-build"],
        LOOK,
      ),
    );
    await watching(harness, watch);
    expect(entryOf(harness, watch.pid())?.marfa_version).toBe(running());
    put(harness, "Sent before.md", "---\ntitle: Sent before\n---\nfirst\n");
    await vi.waitFor(
      () => expect(sentTitles(harness)).toContain("Sent before"),
      WAIT,
    );
    // The witness: some looks find nothing new, and the watch goes on.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(watch.running()).toBe(true);
    expect(said(watch)).toEqual([]);

    // An edit made just before the upgrade, which this watch may not reach.
    put(
      harness,
      "Edited at the swap.md",
      "---\ntitle: Edited at the swap\n---\nsecond\n",
    );
    retarget(link, next);
    await watch.exited();
    expect(watch.exitCode(), watch.stderr).toBe(3);
    expect(said(watch)).toEqual([
      { new_build: NEXT, running: running(), restarting: true },
    ]);
    expect(entryOf(harness, watch.pid())?.ended_at).not.toBeNull();

    // The service manager starts what the link leads to: here, the build
    // under test again, standing in for the new one.
    retarget(link, requireBinary());
    const after = hold(
      folder.hold(
        ["folders", "watch", harness.dir, "--exit-on-new-build"],
        LOOK,
      ),
    );
    await vi.waitFor(
      () =>
        expect(sentTitles(harness).sort()).toEqual([
          "Edited at the swap",
          "Sent before",
        ]),
      WAIT,
    );
    expect(after.running()).toBe(true);
  });

  it("ends for a file replaced in place by a new build, as an install that writes the file does", async () => {
    const harness = await folderHarness("new-build-file");
    made.push(harness);
    scriptFolderWrites(harness);
    const dir = scratchDir("file");
    const binary = join(dir, "marfa");
    copyFileSync(requireBinary(), binary);
    const watch = hold(
      through(harness, binary).hold(
        ["folders", "watch", harness.dir, "--exit-on-new-build"],
        LOOK,
      ),
    );
    await watching(harness, watch);
    // A new file renamed over the path; writing into the running file
    // itself is refused on Linux and breaks the running process on macOS.
    const next = script(dir, "marfa.partial", says(NEXT));
    renameSync(next, binary);
    await watch.exited();
    expect(watch.exitCode(), watch.stderr).toBe(3);
    expect(said(watch)).toEqual([
      { new_build: NEXT, running: running(), restarting: true },
    ]);
  });

  it("says once that the path leads to no build, or to a file that is not one, and goes on syncing, and ends for a copy of its build but not for the build itself put back", async () => {
    const harness = await folderHarness("new-build-gone");
    made.push(harness);
    scriptFolderWrites(harness);
    const dir = scratchDir("gone");
    const link = join(dir, "marfa");
    symlinkSync(requireBinary(), link);
    const watch = hold(
      through(harness, link).hold(
        ["folders", "watch", harness.dir, "--exit-on-new-build"],
        LOOK,
      ),
    );
    await watching(harness, watch);

    // Uninstalled: said once, over several looks, and the watch goes on.
    unlinkSync(link);
    await vi.waitFor(() => expect(said(watch)).toHaveLength(1), WAIT);
    expect(said(watch)[0]).toMatchObject({
      new_build: null,
      binary: link,
      usable: false,
    });
    put(harness, "While gone.md", "---\ntitle: While gone\n---\none\n");
    await vi.waitFor(
      () => expect(sentTitles(harness)).toContain("While gone"),
      WAIT,
    );
    expect(said(watch)).toHaveLength(1);
    expect(watch.running()).toBe(true);

    // A file that says no version, such as a half-written install.
    retarget(link, script(dir, "broken", "exit 1"));
    await vi.waitFor(() => expect(said(watch)).toHaveLength(2), WAIT);
    expect(said(watch)[1]).toMatchObject({
      new_build: null,
      binary: link,
      usable: false,
    });
    put(harness, "While broken.md", "---\ntitle: While broken\n---\ntwo\n");
    await vi.waitFor(
      () => expect(sentTitles(harness)).toContain("While broken"),
      WAIT,
    );
    expect(said(watch)).toHaveLength(2);
    expect(watch.running()).toBe(true);

    // The very build it runs, back at the path, is no new build.
    retarget(link, requireBinary());
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(said(watch)).toHaveLength(2);
    expect(watch.running()).toBe(true);

    // A copy of it is: the watch cannot tell a build of the same version
    // from the one it runs.
    const copy = join(dir, "marfa-copy");
    copyFileSync(requireBinary(), copy);
    retarget(link, copy);
    await watch.exited();
    expect(watch.exitCode(), watch.stderr).toBe(3);
    expect(said(watch)[2]).toEqual({
      new_build: running(),
      running: running(),
      restarting: true,
    });
  });

  it("says once that a new build is installed to a watch run by hand, and goes on syncing", async () => {
    const harness = await folderHarness("new-build-hand");
    made.push(harness);
    scriptFolderWrites(harness);
    const dir = scratchDir("hand");
    const link = join(dir, "marfa");
    symlinkSync(requireBinary(), link);
    const watch = hold(
      through(harness, link).hold(["folders", "watch", harness.dir], LOOK),
    );
    await watching(harness, watch);
    retarget(link, script(dir, "marfa-next", says(NEXT)));
    await vi.waitFor(() => expect(said(watch)).toHaveLength(1), WAIT);
    expect(said(watch)).toEqual([
      { new_build: NEXT, running: running(), restarting: false },
    ]);
    put(harness, "After.md", "---\ntitle: After\n---\nstill synced\n");
    await vi.waitFor(
      () => expect(sentTitles(harness)).toContain("After"),
      WAIT,
    );
    // Several looks later, still said once.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(said(watch)).toHaveLength(1);
    expect(watch.running()).toBe(true);
  });

  it("ends with exit status 0 for SIGTERM, though it ends with 3 for a new build", async () => {
    const harness = await folderHarness("new-build-term");
    made.push(harness);
    const dir = scratchDir("term");
    const link = join(dir, "marfa");
    symlinkSync(requireBinary(), link);
    const watch = hold(
      through(harness, link).hold(
        ["folders", "watch", harness.dir, "--exit-on-new-build"],
        LOOK,
      ),
    );
    await watching(harness, watch);
    process.kill(watch.pid(), "SIGTERM");
    await watch.exited();
    expect(watch.exitCode(), watch.stderr).toBe(0);
  });

  it("says in the folder's status that its watch runs another build", async () => {
    const harness = await folderHarness("new-build-status");
    made.push(harness);
    const entry = (version: string | undefined) => ({
      version: 1,
      processes: [
        {
          pid: process.pid,
          ...(version === undefined ? {} : { marfa_version: version }),
          started_at: new Date().toISOString(),
          heartbeat_at: new Date().toISOString(),
          heartbeat_interval_seconds: 5,
          ended_at: null,
          folders: [
            {
              dir: harness.dir,
              folder: harness.settings.id,
              watching: true,
              reason: null,
              last_success_at: null,
              first_sync_waiting: null,
              problems: null,
              pending_uploads: null,
              pending_downloads: null,
              paused_removals: null,
            },
          ],
        },
      ],
    });
    const status = async () => {
      const report = await harness.folder.device().root<{
        watch_other_build: {
          pid: number;
          marfa_version: string | null;
          this_version: string;
        } | null;
      }>(["folders", "status", harness.dir]);
      expect(report.ok, JSON.stringify(report)).toBe(true);
      if (!report.ok) throw new Error("no status");
      return report.value.watch_other_build;
    };
    const text = async () => {
      const said = await harness.folder
        .device()
        .rootText(["folders", "status", harness.dir]);
      expect(said.ok, JSON.stringify(said)).toBe(true);
      return said.ok ? said.value : "";
    };
    mkdirSync(dirname(recordPath(harness)), { recursive: true });

    writeFileSync(recordPath(harness), JSON.stringify(entry("0.0.1")));
    expect(await status()).toEqual({
      pid: process.pid,
      marfa_version: "0.0.1",
      this_version: running(),
    });
    expect(await text()).toContain(
      `the watch of this folder (process ${process.pid}) runs marfa 0.0.1, and this command is marfa ${running()}`,
    );

    // An entry from a build too early to write its version.
    writeFileSync(recordPath(harness), JSON.stringify(entry(undefined)));
    expect(await status()).toMatchObject({ marfa_version: null });
    expect(await text()).toContain("runs an earlier build of marfa");

    // The witness above shows what a watch on this build would hide.
    writeFileSync(recordPath(harness), JSON.stringify(entry(running())));
    expect(await status()).toBeNull();
    expect(await text()).not.toContain("the watch of this folder");
  });
});

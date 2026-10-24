import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { answers } from "../../device/marfa-answers.js";
import { KEY, folderHarness, scriptFolderRow } from "./harness.js";
import type { HeldCommand } from "../../device/cli-adapter.js";
import type { FolderHarness, FolderRow } from "./harness.js";
import type { ScriptedServer } from "../../device/scripted-server.js";
import type { FolderSettings } from "../../device/cli-adapter.js";
import {
  EdgeDoor,
  put,
  scriptFolderWrites,
  sentTitles,
} from "./folders.shared.js";

/**
 * The record a watch keeps beside the machine's folder registry, which any
 * program on the machine reads.
 */

interface Entry {
  dir: string;
  folder: string;
  watching: boolean;
  reason: string | null;
  last_success_at: string | null;
  first_sync_waiting: boolean | null;
  problems: Array<{ code: string; count: number }> | null;
  pending_uploads: number | null;
  pending_downloads: number | null;
  paused_removals: number | null;
}

interface Process {
  pid: number;
  started_at: string;
  heartbeat_at: string;
  heartbeat_interval_seconds: number;
  ended_at: string | null;
  folders: Entry[];
}

interface WatchRecord {
  version: number;
  processes: Process[];
}

interface Report {
  last_success_at: string | null;
  first_sync_waiting: boolean;
  problems: Array<{ code: string; count: number }>;
  pending_uploads: number;
  pending_downloads: number;
  paused_removals: number;
}

const made: FolderHarness[] = [];
const held: HeldCommand[] = [];

afterEach(async () => {
  for (const command of held.splice(0)) await command.stop();
  for (const harness of made.splice(0).reverse()) await harness.stop();
});

const WAIT = { timeout: 30_000, interval: 100 };

function hold(command: HeldCommand): HeldCommand {
  held.push(command);
  return command;
}

function tagged(tag: string): FolderSettings {
  return {
    query: { types: ["core.note"], filter: `tags contains "${tag}"` },
    defaults: { tags: [tag] },
  };
}

/** Two folders on one machine and one server. */
async function twoFolders(
  label: string,
  options: {
    /** Answers that come before the folder doors', so the first write meets them. */
    before?: (server: ScriptedServer) => void;
    /** More folders' settings the server holds, for folders the fixture adds. */
    others?: FolderSettings[];
  } = {},
): Promise<{
  a: FolderHarness;
  b: FolderHarness;
  edges: EdgeDoor;
  others: FolderRow[];
}> {
  const edges = new EdgeDoor();
  const a = await folderHarness(`${label}-a`, {
    settings: tagged("a"),
    events: [edges.stream()],
  });
  made.push(a);
  // Before the item doors, whose read would answer for any id.
  const row = scriptFolderRow(a.server, tagged("b"));
  const others = (options.others ?? []).map((settings) =>
    scriptFolderRow(a.server, settings),
  );
  options.before?.(a.server);
  scriptFolderWrites(a, { edges });
  const b = await folderHarness(`${label}-b`, {
    sharing: { server: a.server, key: KEY },
    folder: row,
    registry: a.registry,
  });
  made.push(b);
  return { a, b, edges, others };
}

function recordPath(harness: FolderHarness): string {
  return join(dirname(harness.registry), "folder-watch.json");
}

/** The record as it is now, or undefined where there is none. */
function record(harness: FolderHarness): WatchRecord | undefined {
  const path = recordPath(harness);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as WatchRecord;
}

function processOf(harness: FolderHarness, pid: number): Process | undefined {
  return record(harness)?.processes.find((process) => process.pid === pid);
}

function entryOf(
  harness: FolderHarness,
  pid: number,
  dir: string,
): Entry | undefined {
  return processOf(harness, pid)?.folders.find((entry) => entry.dir === dir);
}

/** How a program reading the record decides that an entry is current. */
function current(process: Process, now = Date.now()): boolean {
  const age = now - Date.parse(process.heartbeat_at);
  return (
    process.ended_at === null &&
    age >= 0 &&
    age < 3 * process.heartbeat_interval_seconds * 1000
  );
}

/** Another process, holding the lock on the record's lock file. */
async function lockHeld(harness: FolderHarness): Promise<ChildProcess> {
  mkdirSync(dirname(recordPath(harness)), { recursive: true });
  const holder = spawn(
    "python3",
    [
      "-c",
      "import fcntl,sys,time\nf=open(sys.argv[1],'a')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('held',flush=True)\ntime.sleep(600)",
      join(dirname(recordPath(harness)), "folder-watch.lock"),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((resolve, reject) => {
    holder.stdout?.once("data", () => resolve());
    holder.once("error", reject);
    holder.once("close", () =>
      reject(new Error("the lock holder ended before it held the lock")),
    );
  });
  return holder;
}

function reports(harness: FolderHarness): Report[] {
  return harness.server.requests
    .filter(
      (request) =>
        request.method === "PUT" &&
        request.pathname === `/folders/${harness.settings.id}/status`,
    )
    .map((request) => JSON.parse(request.body) as Report);
}

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

describe("the record of folder watches", () => {
  it("lists each folder a watch holds with what a report to the server says of it, and nothing from inside the folder", async () => {
    const { a, b } = await twoFolders("record-folders");
    expect(existsSync(recordPath(a)), "a record before any watch").toBe(false);
    put(a, "Secret Name.md", "---\ntitle: Secret Title\n---\nsecret body\n");
    const watch = hold(a.folder.watchEvery());
    const pid = watch.pid();
    await vi.waitFor(() => {
      for (const harness of [a, b]) {
        const entry = entryOf(harness, pid, harness.dir);
        expect(entry, `${watch.stdout}${watch.stderr}`).toBeDefined();
        expect(entry?.watching).toBe(true);
        expect(entry?.reason).toBeNull();
        expect(entry?.folder).toBe(harness.settings.id);
      }
    }, WAIT);
    await vi.waitFor(
      () => expect(sentTitles(a), watch.stdout).toEqual(["Secret Title"]),
      WAIT,
    );
    // What the record says of a folder is what the report to the server
    // says of it, as it stands once the pass is over.
    await vi.waitFor(() => {
      const sent = reports(a).at(-1);
      expect(sent, "no report reached the server").toBeDefined();
      const entry = entryOf(a, pid, a.dir);
      expect(entry?.last_success_at).toBe(sent?.last_success_at);
      expect(entry?.first_sync_waiting).toBe(sent?.first_sync_waiting);
      expect(entry?.problems).toEqual(sent?.problems);
      expect(entry?.pending_uploads).toBe(sent?.pending_uploads);
      expect(entry?.pending_downloads).toBe(sent?.pending_downloads);
      expect(entry?.paused_removals).toBe(sent?.paused_removals);
    }, WAIT);
    // The witness: a pass was reported, so this was not two empty lists.
    expect(reports(a).length).toBeGreaterThan(0);

    const text = readFileSync(recordPath(a), "utf8");
    for (const inside of ["Secret Name", "Secret Title", "secret body", KEY]) {
      expect(text, `the record holds ${inside}`).not.toContain(inside);
    }
    expect(JSON.parse(text).version).toBe(1);
  });

  it("lists a folder it cannot watch as not watched, with the code of the reason, and the other watch beside it", async () => {
    const { a, b, others } = await twoFolders("record-unwatched", {
      others: [tagged("w")],
    });
    const waiting = await folderHarness("record-unwatched-waiting", {
      sharing: { server: a.server, key: KEY },
      folder: others[0],
      registry: a.registry,
      confirm: false,
      hydrate: false,
      files: { "Before.md": "---\ntitle: Before\n---\nhere before the add\n" },
    });
    made.push(waiting);
    // Another process holds b, a watch of it alone.
    const alone = hold(b.folder.watch());
    await vi.waitFor(() => expect(alone.stderr).toContain("watching"), WAIT);
    const every = hold(a.folder.watchEvery());
    await vi.waitFor(() => {
      const mine = entryOf(a, every.pid(), a.dir);
      expect(mine?.watching, every.stdout).toBe(true);
      const held = entryOf(a, every.pid(), b.dir);
      expect(held?.watching, every.stdout).toBe(false);
      expect(held?.reason).toBeTruthy();
      // This process never read a report for it: nothing is claimed.
      expect(
        [
          held?.last_success_at,
          held?.first_sync_waiting,
          held?.problems,
          held?.pending_uploads,
          held?.pending_downloads,
          held?.paused_removals,
        ],
        JSON.stringify(held),
      ).toEqual([null, null, null, null, null, null]);
      const first = entryOf(a, every.pid(), waiting.dir);
      expect(first?.watching).toBe(false);
      expect(first?.reason).toBe("first_sync_waiting");
      expect(first?.first_sync_waiting).toBe(true);
    }, WAIT);
    // Two processes, each with its own entry; neither replaced the other's.
    const file = record(a);
    expect(file?.processes.map((process) => process.pid).sort()).toEqual(
      [alone.pid(), every.pid()].sort(),
    );
    // The watch of one folder writes its entry before it holds the folder,
    // and writes again no sooner than a quarter second after a change.
    await vi.waitFor(() => {
      expect(entryOf(a, alone.pid(), b.dir)?.watching).toBe(true);
    }, WAIT);
    expect(entryOf(a, every.pid(), b.dir)?.watching).toBe(false);
  });

  it("lists the folder whose credential the server refused as not watched, with the problem the report carries", async () => {
    const { a } = await twoFolders("record-refused", {
      before: (server) => {
        server.answer("POST", "/items", answers.unauthorized());
      },
    });
    put(a, "Refused.md", "---\ntitle: Refused\n---\nmeets the refusal\n");
    const watch = hold(a.folder.watchEvery());
    await vi.waitFor(() => {
      const entry = entryOf(a, watch.pid(), a.dir);
      expect(entry?.watching, watch.stdout).toBe(false);
      expect(entry?.reason).toBe("unauthorized");
      expect(entry?.problems?.map((problem) => problem.code)).toContain(
        "credential_refused",
      );
    }, WAIT);
  });

  it("refreshes a running watch's heartbeat, and marks its folders not watched when it is stopped", async () => {
    const { a, b } = await twoFolders("record-heartbeat");
    const watch = hold(a.folder.watchEvery());
    const pid = watch.pid();
    await vi.waitFor(
      () => expect(entryOf(a, pid, b.dir)?.watching, watch.stdout).toBe(true),
      WAIT,
    );
    const first = processOf(a, pid) as Process;
    expect(first.ended_at).toBeNull();
    expect(first.heartbeat_interval_seconds).toBeGreaterThan(0);
    expect(current(first)).toBe(true);
    // Nothing changes, and the heartbeat moves on; it is never older than
    // the interval a reader allows.
    await vi.waitFor(
      () => {
        const now = processOf(a, pid) as Process;
        expect(now.heartbeat_at).not.toBe(first.heartbeat_at);
        expect(current(now)).toBe(true);
      },
      { timeout: 4 * first.heartbeat_interval_seconds * 1000, interval: 100 },
    );
    // Whatever else is written, no heartbeat comes later than its interval
    // after the one before it.
    const beats: string[] = [];
    const until = Date.now() + 3.4 * first.heartbeat_interval_seconds * 1000;
    while (Date.now() < until) {
      const beat = (processOf(a, pid) as Process).heartbeat_at;
      if (beats.at(-1) !== beat) beats.push(beat);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const gaps = beats
      .slice(1)
      .map((beat, n) => Date.parse(beat) - Date.parse(beats[n]));
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    for (const gap of gaps) {
      expect(gap, `heartbeat gaps ${gaps}`).toBeLessThanOrEqual(
        first.heartbeat_interval_seconds * 1000,
      );
    }
    expect(
      record(a)?.processes.filter((process) => process.pid === pid),
    ).toHaveLength(1);
    watch.interrupt();
    await watch.exited();
    const ended = processOf(a, pid) as Process;
    expect(ended.ended_at).not.toBeNull();
    expect(ended.folders.map((entry) => entry.watching)).toEqual([
      false,
      false,
    ]);
    expect(current(ended)).toBe(false);
    // The witness that the interrupt was what ended it: the watch was
    // running, and listing both folders, before.
    expect(first.folders).toHaveLength(2);
  });

  it("keeps the record of a watch of one folder, and marks the folder not watched when it is stopped", async () => {
    const { a, b } = await twoFolders("record-one");
    const watch = hold(a.folder.watch());
    const pid = watch.pid();
    await vi.waitFor(() => {
      expect(entryOf(a, pid, a.dir)?.watching, watch.stderr).toBe(true);
    }, WAIT);
    expect(entryOf(a, pid, a.dir)?.folder).toBe(a.settings.id);
    // Only the folder it holds.
    expect(processOf(a, pid)?.folders.map((entry) => entry.dir)).toEqual([
      a.dir,
    ]);
    watch.interrupt();
    await watch.exited();
    expect(entryOf(a, pid, a.dir)?.watching).toBe(false);
    expect(processOf(a, pid)?.ended_at).not.toBeNull();
    expect(b.dir).not.toBe(a.dir);
  });

  it("leaves a killed watch's entry as it was, so that its heartbeat shows it ended", async () => {
    const { a, b } = await twoFolders("record-killed");
    const doomed = hold(a.folder.watch());
    const pid = doomed.pid();
    await vi.waitFor(
      () => expect(entryOf(a, pid, a.dir)?.watching, doomed.stderr).toBe(true),
      WAIT,
    );
    // Another watch, of the other folder, goes on beside it, writing the
    // file as it does.
    const alone = hold(b.folder.watch());
    await vi.waitFor(
      () => expect(processOf(a, alone.pid()), alone.stderr).toBeDefined(),
      WAIT,
    );
    await doomed.stop();
    expect(gone(pid)).toBe(true);
    const killed = processOf(a, pid) as Process;
    // Nothing was written at the kill: it says it still watches.
    expect(killed.ended_at).toBeNull();
    expect(killed.folders.some((entry) => entry.watching)).toBe(true);
    const interval = killed.heartbeat_interval_seconds * 1000;
    // Past two more heartbeats of the other watch: the killed entry is
    // kept as it was, its heartbeat where it stopped.
    const other = processOf(a, alone.pid())?.heartbeat_at;
    await vi.waitFor(
      () => expect(processOf(a, alone.pid())?.heartbeat_at).not.toBe(other),
      { timeout: 3 * interval, interval: 100 },
    );
    expect(processOf(a, pid)?.heartbeat_at).toBe(killed.heartbeat_at);
    expect(processOf(a, pid)?.folders).toEqual(killed.folders);
    // Judged by the heartbeat alone, it is current while that is young, and
    // ended once it has gone three intervals unrefreshed.
    expect(current(killed, Date.parse(killed.heartbeat_at) + interval)).toBe(
      true,
    );
    await vi.waitFor(
      () => expect(current(processOf(a, pid) as Process)).toBe(false),
      {
        timeout: 4 * interval,
        interval: 200,
      },
    );
    // The watch that is still running is still current.
    expect(current(processOf(a, alone.pid()) as Process)).toBe(true);
  });

  it("drops the entries nothing has written to for an hour and any that is still to come, and keeps a recent one", async () => {
    const { a } = await twoFolders("record-pruned");
    const entry = (pid: number, beat: number): Process => ({
      pid,
      started_at: new Date(beat).toISOString(),
      heartbeat_at: new Date(beat).toISOString(),
      heartbeat_interval_seconds: 5,
      ended_at: null,
      folders: [],
    });
    const now = Date.now();
    const seeded: WatchRecord = {
      version: 1,
      processes: [
        entry(2_000_001, now - 61 * 60_000),
        entry(2_000_002, now - 10_000),
        entry(2_000_003, now + 60 * 60_000),
      ],
    };
    mkdirSync(dirname(recordPath(a)), { recursive: true });
    writeFileSync(recordPath(a), JSON.stringify(seeded));
    const watch = hold(a.folder.watchEvery());
    await vi.waitFor(
      () => expect(processOf(a, watch.pid()), watch.stdout).toBeDefined(),
      WAIT,
    );
    const pids = (record(a) as WatchRecord).processes.map(
      (process) => process.pid,
    );
    // The recent one is kept, which is the witness that the others were
    // dropped and not the whole file replaced.
    expect(pids.sort()).toEqual([2_000_002, watch.pid()].sort());
  });

  it("goes on syncing and ends on an interrupt while another process holds the record's lock", async () => {
    const { a } = await twoFolders("record-locked");
    const first = await lockHeld(a);
    const second: ChildProcess[] = [];
    try {
      put(a, "Locked.md", "---\ntitle: Locked\n---\nsynced under the lock\n");
      const watch = hold(a.folder.watchEvery());
      await vi.waitFor(
        () => expect(sentTitles(a), watch.stdout).toEqual(["Locked"]),
        WAIT,
      );
      expect(existsSync(recordPath(a)), "written under a held lock").toBe(
        false,
      );
      // The witness that the record is kept when the lock is free: the same
      // watch writes it once the lock is let go.
      first.kill("SIGKILL");
      await vi.waitFor(
        () => expect(processOf(a, watch.pid()), watch.stdout).toBeDefined(),
        WAIT,
      );
      second.push(await lockHeld(a));
      const interrupted = Date.now();
      watch.interrupt();
      await watch.exited();
      expect(Date.now() - interrupted).toBeLessThan(3_000);
      expect(watch.exitCode(), watch.stderr).toBe(130);
    } finally {
      first.kill("SIGKILL");
      for (const holder of second) holder.kill("SIGKILL");
    }
  });

  it("says once that another process has held the record's lock for long", async () => {
    const { a } = await twoFolders("record-locked-long");
    const holder = await lockHeld(a);
    try {
      const watch = hold(a.folder.watchEvery());
      const said = (): unknown[] =>
        watch.stdout
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as { record?: string })
          .filter((line) => line.record !== undefined);
      // Three intervals of 5 seconds, and a moment.
      await vi.waitFor(() => expect(said(), watch.stderr).toHaveLength(1), {
        timeout: 30_000,
        interval: 200,
      });
      expect(JSON.stringify(said()[0])).toContain("lock");
      await new Promise((resolve) => setTimeout(resolve, 7_000));
      expect(said(), "said again unchanged").toHaveLength(1);
      expect(watch.running(), watch.stderr).toBe(true);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("is never read half written, while two watches write it", async () => {
    const { a, b } = await twoFolders("record-whole");
    const every = hold(a.folder.watchEvery());
    const alone = hold(b.folder.watch());
    await vi.waitFor(() => {
      const file = record(a);
      expect(file?.processes, `${every.stdout}${alone.stderr}`).toHaveLength(2);
    }, WAIT);
    let reads = 0;
    const seen = new Set<string>();
    const until = Date.now() + 12_000;
    let n = 0;
    while (Date.now() < until) {
      // Edits make both watches write the record besides their heartbeat.
      if (n++ % 400 === 0)
        put(a, `Churn ${n}.md`, `---\ntitle: Churn ${n}\n---\nx\n`);
      const text = readFileSync(recordPath(a), "utf8");
      const file = JSON.parse(text) as WatchRecord;
      expect(file.version).toBe(1);
      expect(file.processes).toHaveLength(2);
      seen.add(file.processes.map((process) => process.heartbeat_at).join());
      reads += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(reads).toBeGreaterThan(500);
    // The witness that the record was being written throughout.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("says once that the record cannot be written, and the watch goes on and writes it once it can", async () => {
    const { a, b } = await twoFolders("record-unwritable");
    // A directory where the file belongs: no write can land there.
    const blocked = recordPath(a);
    mkdirSync(blocked);
    put(a, "Goes on.md", "---\ntitle: Goes on\n---\nwithout the record\n");
    const every = hold(a.folder.watchEvery());
    const said = (): unknown[] =>
      every.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { record?: string })
        .filter((line) => line.record !== undefined);
    await vi.waitFor(() => expect(said(), every.stderr).toHaveLength(1), WAIT);
    expect(said()[0]).toMatchObject({ written: false });
    expect(JSON.stringify(said()[0])).toContain("folder-watch.json");
    await vi.waitFor(
      () => expect(sentTitles(a), every.stdout).toEqual(["Goes on"]),
      WAIT,
    );
    expect(every.running(), every.stderr).toBe(true);
    // Past a heartbeat: not said again.
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    expect(said()).toHaveLength(1);
    rmSync(blocked, { recursive: true });
    await vi.waitFor(
      () =>
        expect(entryOf(a, every.pid(), b.dir)?.watching, every.stdout).toBe(
          true,
        ),
      WAIT,
    );
    every.interrupt();
    await every.exited();

    // A watch of one folder says it for a person, once.
    rmSync(blocked, { force: true });
    mkdirSync(blocked);
    const alone = hold(a.folder.watchText());
    await vi.waitFor(() => expect(alone.stderr).toContain("watching"), WAIT);
    await vi.waitFor(
      () => expect(alone.stderr).toContain("folder-watch.json"),
      WAIT,
    );
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    expect(alone.stderr.split("folder-watch.json").length - 1).toBe(1);
    expect(alone.running(), alone.stderr).toBe(true);
  });
});

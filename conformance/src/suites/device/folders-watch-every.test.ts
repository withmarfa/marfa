import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  copyItemEvent,
  refusal,
  answers,
  wireItem,
} from "../../device/marfa-answers.js";
import {
  KEY,
  folderHarness,
  requireBinary,
  scriptFolderRow,
} from "./harness.js";
import { CliFolder, type HeldCommand } from "../../device/cli-adapter.js";
import type { FolderHarness, FolderRow } from "./harness.js";
import type { FolderSettings } from "../../device/cli-adapter.js";
import type { ScriptedServer } from "../../device/scripted-server.js";
import type { WireItemOptions } from "../../device/marfa-answers.js";
import {
  EdgeDoor,
  edit,
  put,
  read,
  scriptFolderWrites,
  sentTitles,
  sentUpdates,
} from "./folders.shared.js";

/**
 * `folders watch` with no directory: one process keeping every folder the
 * machine's registry lists in step.
 */

const made: FolderHarness[] = [];
const held: HeldCommand[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const command of held.splice(0)) await command.stop();
  for (const harness of made.splice(0).reverse()) await harness.stop();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Two folders on one machine and one server, each holding the notes tagged
 *  with its own tag; `events` are the server's changes since both hydrated. */
async function twoFolders(
  label: string,
  options: {
    events?: (edges: EdgeDoor) => void;
    /** Answers that come before the folder doors', so the first write meets them. */
    before?: (server: ScriptedServer) => void;
    /** More folders' settings the server holds, for folders the fixture adds. */
    others?: FolderSettings[];
    /** Notes the server holds for the first folder when it hydrates. */
    rows?: Record<string, Array<{ item: WireItemOptions; tags?: string[] }>>;
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
    ...(options.rows === undefined ? {} : { rows: options.rows }),
    events: [edges.stream()],
  });
  made.push(a);
  // Before the item doors, whose read would answer for any id.
  const otherRow = scriptFolderRow(a.server, tagged("b"));
  const others = (options.others ?? []).map((settings) =>
    scriptFolderRow(a.server, settings),
  );
  options.before?.(a.server);
  scriptFolderWrites(a, { edges });
  const b = await folderHarness(`${label}-b`, {
    sharing: { server: a.server, key: KEY },
    folder: otherRow,
    registry: a.registry,
  });
  made.push(b);
  options.events?.(edges);
  return { a, b, edges, others };
}

function tagged(tag: string): FolderSettings {
  return {
    query: { types: ["core.note"], filter: `tags contains "${tag}"` },
    defaults: { tags: [tag] },
  };
}

/** A note the server took since the folders hydrated, as its event. */
function created(
  edges: EdgeDoor,
  id: string,
  title: string,
  tag: string,
): void {
  edges.events.push(
    copyItemEvent(
      String(edges.events.length + 2),
      "item.created",
      wireItem({ id, properties: { title, body: `${title} body\n` } }),
      { tags: [tag] },
    ),
  );
}

/** What a watch has printed, one JSON value a line. */
function linesOf(watch: HeldCommand): Array<Record<string, unknown>> {
  // The last line may still be arriving.
  return watch.stdout
    .split("\n")
    .slice(0, -1)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error(
          `a watch of every folder printed a line that is not one JSON value: ${line}`,
        );
      }
    });
}

function linesFor(
  watch: HeldCommand,
  dir: string,
): Array<Record<string, unknown>> {
  return linesOf(watch).filter((line) => line.dir === dir);
}

function watching(watch: HeldCommand, dir: string): boolean {
  return linesFor(watch, dir).some((line) => line.watching === true);
}

function hold(command: HeldCommand): HeldCommand {
  held.push(command);
  return command;
}

const WAIT = { timeout: 30_000, interval: 100 };

describe("a watch of every folder", () => {
  it("keeps every listed folder in step in one process, naming the folder on every line", async () => {
    const { a, b } = await twoFolders("every-both", {
      events: (edges) => {
        created(edges, "01a00000-0000-7000-8000-00000000e1a1", "Server A", "a");
        created(edges, "01a00000-0000-7000-8000-00000000e1b1", "Server B", "b");
      },
    });
    put(a, "Disk A.md", "---\ntitle: Disk A\n---\nwritten in a\n");
    put(b, "Disk B.md", "---\ntitle: Disk B\n---\nwritten in b\n");
    const watch = hold(a.folder.watchEvery());
    await vi.waitFor(() => {
      expect(
        existsSync(join(a.dir, "Server A.md")) &&
          existsSync(join(b.dir, "Server B.md")),
        `a server change did not reach each folder: ${watch.stdout}${watch.stderr}`,
      ).toBe(true);
      expect(sentTitles(a).sort()).toEqual(["Disk A", "Disk B"]);
      // The pass that sent each is told once it ends.
      for (const harness of [a, b]) {
        expect(
          linesFor(watch, harness.dir).filter(
            (line) => line.drain !== undefined,
          ).length,
          watch.stdout,
        ).toBeGreaterThan(0);
      }
    }, WAIT);
    expect(watch.running(), watch.stderr).toBe(true);
    expect(read(a, "Server A.md")).toContain("Server A body");
    // Each folder holds only what its query names.
    expect(existsSync(join(a.dir, "Server B.md"))).toBe(false);
    const lines = linesOf(watch);
    expect(
      lines.filter((line) => line.dir === undefined),
      "a line about one folder did not name it",
    ).toEqual([]);
    for (const harness of [a, b]) {
      expect(watching(watch, harness.dir), watch.stdout).toBe(true);
    }
  });

  it("watches every folder whose store lacks a table this build makes, adding the table", async () => {
    const { a, b } = await twoFolders("every-lacking");
    const stores = [a, b].map((harness) =>
      join(harness.dir, ".marfa", "core.sqlite"),
    );
    const holds = (store: string): boolean => {
      const db = new DatabaseSync(store, { readOnly: true });
      try {
        return (
          db
            .prepare("SELECT 1 FROM sqlite_master WHERE name = 'copy_changes'")
            .get() !== undefined
        );
      } finally {
        db.close();
      }
    };
    for (const store of stores) {
      const db = new DatabaseSync(store);
      try {
        const triggers = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%copy_changes%'",
          )
          .all() as Array<{ name: string }>;
        for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
        db.exec("DROP TABLE copy_changes");
      } finally {
        db.close();
      }
    }
    expect(stores.map(holds)).toEqual([false, false]);

    put(a, "Disk A.md", "---\ntitle: Disk A\n---\nwritten in a\n");
    put(b, "Disk B.md", "---\ntitle: Disk B\n---\nwritten in b\n");
    const watch = hold(a.folder.watchEvery());
    await vi.waitFor(() => {
      for (const harness of [a, b]) {
        expect(
          watching(watch, harness.dir),
          `${watch.stdout}${watch.stderr}`,
        ).toBe(true);
      }
      expect(sentTitles(a).sort()).toEqual(["Disk A", "Disk B"]);
    }, WAIT);
    expect(stores.map(holds)).toEqual([true, true]);
  });

  it("says once why a listed folder cannot be watched, goes on with the others, and takes it up once it can be", async () => {
    const { a, b, others } = await twoFolders("every-unwatched", {
      others: [tagged("w"), tagged("g")],
    });
    const waiting = await folderHarness("every-unwatched-waiting", {
      sharing: { server: a.server, key: KEY },
      folder: others[0],
      registry: a.registry,
      confirm: false,
      hydrate: false,
      files: { "Before.md": "---\ntitle: Before\n---\nhere before the add\n" },
    });
    made.push(waiting);
    const gone = await folderHarness("every-unwatched-gone", {
      sharing: { server: a.server, key: KEY },
      folder: others[1],
      registry: a.registry,
    });
    made.push(gone);
    // Another process holds b, a watch of it alone.
    const alone = hold(b.folder.watch());
    await vi.waitFor(() => expect(alone.stderr).toContain("watching"), WAIT);
    renameSync(gone.dir, `${gone.dir}-away`);

    const watch = hold(a.folder.watchEveryText());
    const notWatched = (dir: string): string[] =>
      watch.stdout
        .split("\n")
        .filter((line) => line.startsWith(`${dir}: not watched`));
    // A folder whose directory cannot be found is told with every other
    // such folder, in one line.
    const missingLines = (): string[] =>
      watch.stdout
        .split("\n")
        .filter((line) => / listed folder\(s\) cannot be found/.test(line));
    await vi.waitFor(() => {
      for (const dir of [b.dir, waiting.dir]) {
        expect(notWatched(dir), watch.stdout).toHaveLength(1);
      }
      expect(missingLines(), watch.stdout).toHaveLength(1);
    }, WAIT);
    expect(notWatched(b.dir)[0]).toContain("another process");
    expect(notWatched(waiting.dir)[0]).toContain("first sync");
    expect(missingLines()[0]).toMatch(/^1 listed folder\(s\) cannot be found/);
    expect(missingLines()[0]).toContain(gone.dir);
    expect(notWatched(gone.dir)).toEqual([]);
    put(a, "Goes on.md", "---\ntitle: Goes on\n---\nthe others go on\n");
    await vi.waitFor(() => expect(sentTitles(a)).toContain("Goes on"), WAIT);
    // Past two more tries of each: still said once.
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    for (const dir of [b.dir, waiting.dir]) {
      expect(
        notWatched(dir),
        `why a folder is not watched was said again unchanged: ${watch.stdout}`,
      ).toHaveLength(1);
    }
    expect(missingLines()).toHaveLength(1);
    expect(watch.running(), watch.stderr).toBe(true);
    expect(
      watch.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .filter((line) => !missingLines().includes(line))
        .filter(
          (line) =>
            ![a.dir, b.dir, waiting.dir, gone.dir].some((dir) =>
              line.startsWith(`${dir}: `),
            ),
        ),
      "a line about one folder did not name it",
    ).toEqual([]);

    // Each is taken up once what kept it out is gone.
    alone.interrupt();
    await alone.exited();
    expect((await waiting.folder.confirm()).ok).toBe(true);
    renameSync(`${gone.dir}-away`, gone.dir);
    // A directory that cannot be found is looked at less often the longer it
    // stays away: 5, 10 and then 20 seconds after the last look by now.
    await vi.waitFor(
      () => {
        for (const dir of [b.dir, waiting.dir, gone.dir]) {
          expect(watch.stdout, dir).toContain(`${dir}: watching`);
        }
      },
      { ...WAIT, timeout: 60_000 },
    );
    await vi.waitFor(() => expect(sentTitles(a)).toContain("Before"), WAIT);
  });

  it("says in one line which listed folders cannot be found, keeps them listed, and keeps the others in step", async () => {
    const a = await folderHarness("every-missing", { settings: tagged("a") });
    made.push(a);
    scriptFolderWrites(a);
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "marfa-every-missing-"),
    );
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    // Folders deleted long ago, as test runs leave behind.
    const gone = Array.from({ length: 40 }, (_, n) =>
      join(root, `run-${n}`, "notes"),
    );
    const listed = JSON.parse(readFileSync(a.registry, "utf8")) as {
      folders: Array<Record<string, unknown>>;
    };
    listed.folders.push(...gone.map((dir) => ({ dir, folder: randomUUID() })));
    writeFileSync(a.registry, JSON.stringify(listed));

    const watch = hold(a.folder.watchEveryText());
    const missingLines = (): string[] =>
      watch.stdout
        .split("\n")
        .filter((line) => / listed folder\(s\) cannot be found/.test(line));
    await vi.waitFor(() => {
      expect(watch.stdout).toContain(`${a.dir}: watching`);
      expect(missingLines(), watch.stdout).toHaveLength(1);
    }, WAIT);
    expect(missingLines()[0]).toMatch(/^40 listed folder\(s\) cannot be found/);
    for (const dir of gone) expect(missingLines()[0]).toContain(dir);
    put(a, "Goes on.md", "---\ntitle: Goes on\n---\nbeside forty gone\n");
    await vi.waitFor(() => expect(sentTitles(a)).toContain("Goes on"), WAIT);
    // Past several looks at each: still one line, and none of its own.
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    expect(missingLines()).toHaveLength(1);
    expect(
      watch.stdout
        .split("\n")
        .filter((line) => gone.some((dir) => line.startsWith(`${dir}: `))),
    ).toEqual([]);
    // Kept listed, since a volume that is away cannot be told from a
    // directory deleted.
    const after = JSON.parse(readFileSync(a.registry, "utf8")) as {
      folders: Array<{ dir: string }>;
    };
    expect(after.folders.map((entry) => entry.dir)).toEqual(
      expect.arrayContaining([a.dir, ...gone]),
    );
    const record = JSON.parse(
      readFileSync(join(a.registry, "..", "folder-watch.json"), "utf8"),
    ) as {
      processes: Array<{
        pid: number;
        folders: Array<{
          dir: string;
          watching: boolean;
          reason: string | null;
        }>;
      }>;
    };
    const entries = record.processes.find(
      (process) => process.pid === watch.pid(),
    )!.folders;
    expect(entries.find((entry) => entry.dir === gone[0])).toMatchObject({
      watching: false,
      reason: "missing",
    });
    expect(watch.running(), watch.stderr).toBe(true);
  });

  it("takes a folder up again once the directory it was added at returns after an empty one stood in its place", async () => {
    const seed = "01a00000-0000-7000-8000-00000000e2a1";
    const { a, b } = await twoFolders("every-root-returns", {
      rows: {
        "core.note": [
          {
            item: { id: seed, properties: { title: "Seed", body: "seed\n" } },
            tags: ["a"],
          },
        ],
      },
    });
    const watch = hold(a.folder.watchEvery());
    await vi.waitFor(() => {
      expect(watching(watch, a.dir), watch.stdout + watch.stderr).toBe(true);
      expect(existsSync(join(a.dir, "Seed.md"))).toBe(true);
    }, WAIT);

    // An empty directory stands where the folder was, and the folder is
    // elsewhere.
    const away = `${realpathSync(a.dir)}-away`;
    const told = linesFor(watch, a.dir).length;
    renameSync(a.dir, away);
    mkdirSync(a.dir);
    await vi.waitFor(
      () =>
        expect(linesFor(watch, a.dir).length, watch.stdout).toBeGreaterThan(
          told,
        ),
      WAIT,
    );
    const during = await b.folder.list();
    expect(during.ok, JSON.stringify(during)).toBe(true);
    expect(
      during.ok && during.value.map((entry) => entry.folder).sort(),
      "the empty directory took the folder off the list",
    ).toEqual([a.settings.id, b.settings.id].sort());
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // The original returns, and its edit reaches the server with nothing
    // added again.
    rmSync(a.dir, { recursive: true });
    renameSync(away, a.dir);
    edit(a, "Seed.md", "\nseed\n", "\nedited after the folder returned\n");
    await vi.waitFor(
      () =>
        expect(
          sentUpdates(a).map((sent) => sent.id),
          `the folder did not sync again once its directory returned: ${watch.stdout}${watch.stderr}`,
        ).toEqual([seed]),
      { ...WAIT, timeout: 90_000 },
    );
    expect(watch.running(), watch.stderr).toBe(true);
  });

  it("ends only the watch of a folder whose credential the server refuses", async () => {
    const { a, b } = await twoFolders("every-refused", {
      before: (server) => {
        server.answer("POST", "/items", answers.unauthorized());
      },
    });
    put(a, "Refused.md", "---\ntitle: Refused\n---\nmeets the refusal\n");
    const watch = hold(a.folder.watchEvery());
    await vi.waitFor(() => {
      const refused = linesFor(watch, a.dir).filter(
        (line) => line.watching === false,
      );
      expect(refused, watch.stdout).toHaveLength(1);
      expect(refused[0].code).toBe("unauthorized");
    }, WAIT);
    // The witness: it was the create that met the refusal.
    expect(sentTitles(a)).toEqual(["Refused"]);
    put(b, "Kept.md", "---\ntitle: Kept\n---\nthe other folder goes on\n");
    await vi.waitFor(
      () => expect(sentTitles(a)).toEqual(["Refused", "Kept"]),
      WAIT,
    );
    expect(
      watch.running(),
      `a refused credential for one folder ended the watch: ${watch.stderr}`,
    ).toBe(true);
    expect(watching(watch, b.dir)).toBe(true);
  });

  it("waits while no folder is listed, takes up a folder added, and lets go of one removed", async () => {
    const { a, others } = await twoFolders("every-joins-server", {
      others: [tagged("c"), tagged("d")],
    });
    const root = mkdtempSync(join(realpathSync(tmpdir()), "marfa-every-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const registry = join(root, "registry", "folders.json");
    const watch = hold(
      new CliFolder(join(root, "none"), {
        binary: requireBinary(),
        url: a.server.url,
        key: KEY,
        registry,
      }).watchEvery(),
    );
    const none = (): unknown[] =>
      linesOf(watch).filter((line) => line.folders === 0);
    await vi.waitFor(() => expect(none(), watch.stderr).toHaveLength(1), WAIT);
    // Past a few reads of the registry: still running, and said once.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(watch.running(), watch.stderr).toBe(true);
    expect(none()).toHaveLength(1);

    const joined = await folderHarness("every-joins-c", {
      sharing: { server: a.server, key: KEY },
      folder: others[0],
      registry,
    });
    made.push(joined);
    const leaving = await folderHarness("every-joins-d", {
      sharing: { server: a.server, key: KEY },
      folder: others[1],
      registry,
    });
    made.push(leaving);
    await vi.waitFor(() => {
      expect(watching(watch, joined.dir), watch.stdout).toBe(true);
      expect(watching(watch, leaving.dir), watch.stdout).toBe(true);
    }, WAIT);
    put(joined, "Joined.md", "---\ntitle: Joined\n---\njoined the watch\n");
    await vi.waitFor(() => expect(sentTitles(a)).toContain("Joined"), WAIT);

    // Its directory taken away, the folder can be removed, by its listing.
    renameSync(leaving.dir, `${leaving.dir}-away`);
    const removed = await leaving.folder.remove();
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    await vi.waitFor(() => {
      expect(
        linesFor(watch, leaving.dir).filter((line) => line.listed === false),
        watch.stdout,
      ).toHaveLength(1);
    }, WAIT);
    // The witness that the watch let go of it: back in place, another
    // process can work it.
    renameSync(`${leaving.dir}-away`, leaving.dir);
    const pushed = await leaving.folder.push();
    expect(
      pushed.ok,
      `the watch still held a folder no longer listed: ${JSON.stringify(pushed)}`,
    ).toBe(true);
    put(joined, "Still.md", "---\ntitle: Still\n---\nthe others go on\n");
    await vi.waitFor(() => expect(sentTitles(a)).toContain("Still"), WAIT);
    expect(watch.running(), watch.stderr).toBe(true);
    expect(
      none(),
      "a registry listing folders was said to list none",
    ).toHaveLength(1);
  });

  it("goes on with the folders it watches while the registry cannot be read", async () => {
    const { a, b } = await twoFolders("every-unread");
    const watch = hold(a.folder.watchEvery());
    await vi.waitFor(() => {
      expect(
        watching(watch, a.dir) && watching(watch, b.dir),
        watch.stdout,
      ).toBe(true);
    }, WAIT);
    const kept = readFileSync(a.registry);
    writeFileSync(a.registry, "not a registry");
    const readable = (value: boolean): unknown[] =>
      linesOf(watch).filter((line) => line.readable === value);
    await vi.waitFor(() => expect(readable(false)).toHaveLength(1), WAIT);
    put(b, "Unread.md", "---\ntitle: Unread\n---\nwhile the registry is not\n");
    await vi.waitFor(() => expect(sentTitles(a)).toContain("Unread"), WAIT);
    expect(
      linesOf(watch).filter((line) => line.listed === false),
      "an unreadable registry ended a folder's watch",
    ).toEqual([]);
    writeFileSync(a.registry, kept);
    await vi.waitFor(() => expect(readable(true)).toHaveLength(1), WAIT);
    expect(watch.running(), watch.stderr).toBe(true);
  });

  it("ends soon after an interrupt while a pass waits on the server, keeping the edit it was sending", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { a, b } = await twoFolders("every-interrupt", {
      before: (server) => {
        server.answer("POST", "/items", {
          kind: "gated",
          until: gate,
          then: refusal(503, "unavailable", "the server is at rest"),
        });
      },
    });
    put(a, "Mid pass.md", "---\ntitle: Mid pass\n---\nsent as Ctrl-C comes\n");
    const watch = hold(a.folder.watchEvery());
    await vi.waitFor(
      () => expect(sentTitles(a), watch.stdout).toEqual(["Mid pass"]),
      WAIT,
    );
    await vi.waitFor(() => expect(watching(watch, b.dir)).toBe(true), WAIT);
    const interrupted = Date.now();
    watch.interrupt();
    await watch.exited();
    const took = Date.now() - interrupted;
    release();
    expect(took, `the watch took ${took} ms to end`).toBeLessThan(3_000);
    expect(watch.exitCode(), watch.stderr).toBe(130);
    // Each store is whole, and the edit waits for the next sync.
    for (const harness of [a, b]) {
      const status = await harness.folder.status();
      expect(status.ok, JSON.stringify(status)).toBe(true);
    }
    const status = await a.folder.status();
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "Mid pass.md")?.status,
    ).toBe("waiting");
    const pushed = await a.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(sentTitles(a)).toEqual(["Mid pass", "Mid pass"]);
    const after = await a.folder.status();
    expect(
      after.ok &&
        after.value.files.find((file) => file.path === "Mid pass.md")?.status,
    ).not.toBe("waiting");
  });

  describe.runIf(process.platform === "darwin")(
    "folders on two servers",
    () => {
      it("keeps each folder with its own server and credential, and one server down stops only its folder", async () => {
        const a = await folderHarness("every-servers-a", {
          settings: tagged("a"),
        });
        made.push(a);
        scriptFolderWrites(a);
        const b = await folderHarness("every-servers-b", {
          settings: tagged("b"),
          registry: a.registry,
        });
        made.push(b);
        scriptFolderWrites(b);
        expect(b.server.url).not.toBe(a.server.url);
        const keychain = ownKeychain();
        cleanups.push(keychain.remove);
        const kept = "device-fixture-key-kept-for-b";
        keepKey(keychain.path, b.server.url, kept);
        const from = b.server.requests.length;
        const watch = hold(
          a.folder.watchEvery({ MARFA_KEYCHAIN: keychain.path }),
        );
        put(a, "On A.md", "---\ntitle: On A\n---\nfor the named server\n");
        put(b, "On B.md", "---\ntitle: On B\n---\nfor its own server\n");
        await vi.waitFor(() => {
          expect(sentTitles(a), watch.stdout).toEqual(["On A"]);
          expect(sentTitles(b), watch.stdout).toEqual(["On B"]);
        }, WAIT);
        // A server's root is read with no credential at all.
        const sentToB = b.server.requests
          .slice(from)
          .map((request) => request.headers.authorization)
          .filter((sent) => sent !== undefined);
        expect(sentToB).toContain(`Bearer ${kept}`);
        expect(
          sentToB.filter((sent) => sent !== `Bearer ${kept}`),
          "a folder's server was sent another credential than the one kept for it",
        ).toEqual([]);

        await b.server.offline();
        await vi.waitFor(() => {
          expect(
            linesFor(watch, b.dir).filter((line) => line.reachable === false),
            watch.stdout,
          ).toHaveLength(1);
        }, WAIT);
        put(
          a,
          "While B is down.md",
          "---\ntitle: While B is down\n---\na goes on\n",
        );
        put(b, "Waits.md", "---\ntitle: Waits\n---\nfor its server\n");
        await vi.waitFor(
          () => expect(sentTitles(a)).toContain("While B is down"),
          WAIT,
        );
        expect(
          linesFor(watch, a.dir).filter((line) => line.reachable === false),
          "a folder on a server that answers was said to be cut off",
        ).toEqual([]);
        await b.server.online();
        await vi.waitFor(() => expect(sentTitles(b)).toContain("Waits"), WAIT);
        expect(watch.running(), watch.stderr).toBe(true);
      });
    },
  );
});

/**
 * A keychain file of the test's own, so the run's shared one is left as it
 * is. The binary reads an item `security` made only where the item lets any
 * application read it, which is set as the item is made, never changed later.
 */
function ownKeychain(): { path: string; remove: () => void } {
  const folder = mkdtempSync(join(tmpdir(), "marfa-every-keychain-"));
  const path = join(folder, "credentials.keychain-db");
  const password = randomUUID();
  execFileSync("security", ["create-keychain", "-p", password, path]);
  execFileSync("security", ["unlock-keychain", "-p", password, path]);
  execFileSync("security", ["set-keychain-settings", path]);
  return {
    path,
    remove: () => {
      try {
        execFileSync("security", ["delete-keychain", path]);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  };
}

/** Keeps `key` for `origin`, as `keys keep` would. */
function keepKey(keychain: string, origin: string, key: string): void {
  execFileSync("security", [
    "add-generic-password",
    "-A",
    "-s",
    "marfa",
    "-a",
    origin,
    "-w",
    JSON.stringify({ kind: "key", key }),
    keychain,
  ]);
}

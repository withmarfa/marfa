import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { KEY, folderHarness, scriptFolderRow } from "./harness.js";
import type { FolderHarness } from "./harness.js";
import type { HeldCommand, FolderSettings } from "../../device/cli-adapter.js";
import type { Answer, RecordedRequest } from "../../device/scripted-server.js";
import {
  put,
  scriptFolderWrites,
  sentTitles,
  withFault,
} from "./folders.shared.js";

/**
 * A command that works a folder asks a running `folders watch` for it, and
 * the watch lets it go and takes it back.
 */

const made: FolderHarness[] = [];
const held: HeldCommand[] = [];

afterEach(async () => {
  for (const command of held.splice(0)) {
    // Resumed first, so a suspended process is never left behind stopped.
    try {
      process.kill(command.pid(), "SIGCONT");
    } catch {
      // It has exited.
    }
    await command.stop();
  }
  for (const harness of made.splice(0).reverse()) await harness.stop();
});

const WAIT = { timeout: 30_000, interval: 100 };

function hold(command: HeldCommand): HeldCommand {
  held.push(command);
  return command;
}

function tagged(
  tag: string,
  extra: Partial<FolderSettings> = {},
): FolderSettings {
  return {
    search: { types: ["core.note"], filter: `tags contains "${tag}"` },
    defaults: { tags: [tag] },
    ...extra,
  };
}

/** A folder of its own, its writes answered by the item doors. */
async function oneFolder(
  label: string,
  creating?: (answer: Answer, request: RecordedRequest) => Answer,
): Promise<FolderHarness> {
  const harness = await folderHarness(label);
  made.push(harness);
  scriptFolderWrites(harness, { creating });
  return harness;
}

/** Two folders on one machine and one server; `a` pauses a removal of more
 *  than two files. */
async function twoFolders(label: string): Promise<{
  a: FolderHarness;
  b: FolderHarness;
  idOf: (title: string) => string | undefined;
}> {
  const a = await folderHarness(`${label}-a`, {
    settings: tagged("a", {
      removal_threshold: { files: 2, fraction: 0.25 },
    }),
  });
  made.push(a);
  const otherRow = scriptFolderRow(a.server, tagged("b"));
  const rows = scriptFolderWrites(a);
  const b = await folderHarness(`${label}-b`, {
    sharing: { server: a.server, key: KEY },
    folder: otherRow,
    registry: a.registry,
  });
  made.push(b);
  const idOf = (title: string): string | undefined =>
    [...rows.entries()].find(([, row]) => row.properties.title === title)?.[0];
  return { a, b, idOf };
}

/** The lines a watch printed as one JSON value each, for one folder where a
 *  watch of every folder names it. A watch of one folder prints each pass's
 *  report over several lines, which this passes over. */
function lines(
  watch: HeldCommand,
  dir?: string,
): Array<Record<string, unknown>> {
  return watch.stdout
    .split("\n")
    .slice(0, -1)
    .filter((line) => line.startsWith('{"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => dir === undefined || line.dir === dir);
}

function handedOver(line: Record<string, unknown>): boolean {
  return line.watching === false && line.code === "handed_over";
}

function takenBack(line: Record<string, unknown>): boolean {
  return line.watching === true && line.taken_back === true;
}

/** What the watch said of letting go and taking back, in order. */
function handovers(watch: HeldCommand, dir?: string): string[] {
  return lines(watch, dir).flatMap((line) =>
    handedOver(line) ? ["let go"] : takenBack(line) ? ["taken back"] : [],
  );
}

/** What the record of folder watches says of the folder at `dir`, in the
 *  entry of the process `pid`. */
function recorded(
  harness: FolderHarness,
  pid: number,
  dir: string,
): { watching: boolean; reason: string | null } | undefined {
  const path = join(dirname(harness.registry), "folder-watch.json");
  if (!existsSync(path)) return undefined;
  const record = JSON.parse(readFileSync(path, "utf8")) as {
    processes: Array<{
      pid: number;
      folders: Array<{ dir: string; watching: boolean; reason: string | null }>;
    }>;
  };
  return record.processes
    .find((process) => process.pid === pid)
    ?.folders.find((folder) => folder.dir === dir);
}

function deletesOf(harness: FolderHarness, id: string): number {
  return harness.server.requests.filter(
    (request) =>
      request.method === "DELETE" && request.pathname === `/items/${id}`,
  ).length;
}

function note(title: string): string {
  return `---\ntitle: ${title}\n---\n${title} body\n`;
}

describe("handing a folder to a command", () => {
  it("hands a folder the watch of every folder holds to folders confirm, keeps the other in step, and takes it back", async () => {
    const { a, b, idOf } = await twoFolders("handover-confirm");
    for (const n of [1, 2, 3, 4])
      put(a, `Note ${String(n)}.md`, note(`Note ${String(n)}`));
    expect((await a.folder.push()).ok).toBe(true);
    const gone = [1, 2, 3].map((n) => idOf(`Note ${String(n)}`) ?? "");
    expect(
      gone.every((id) => id !== ""),
      "a note was not created",
    ).toBe(true);

    const watch = hold(a.folder.watchEvery());
    await vi.waitFor(() => {
      for (const dir of [a.dir, b.dir]) {
        expect(
          lines(watch, dir).some((line) => line.watching === true),
          watch.stdout + watch.stderr,
        ).toBe(true);
      }
    }, WAIT);
    for (const n of [1, 2, 3]) rmSync(join(a.dir, `Note ${String(n)}.md`));
    await vi.waitFor(() => {
      expect(
        lines(watch, a.dir).some(
          (line) =>
            (line.scan as { paused?: number } | undefined)?.paused === 3,
        ),
        watch.stdout,
      ).toBe(true);
    }, WAIT);
    // The witness that the pause holds the deletes until the confirm.
    expect(gone.map((id) => deletesOf(a, id))).toEqual([0, 0, 0]);

    const confirmed = await a.folder.confirm();
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.deleted).toBe(3);
    // Taken back, the watch sends the deletes the confirm queued.
    await vi.waitFor(() => {
      expect(gone.map((id) => deletesOf(a, id))).toEqual([1, 1, 1]);
      expect(handovers(watch, a.dir), watch.stdout).toEqual([
        "let go",
        "taken back",
      ]);
    }, WAIT);
    const said = lines(watch, a.dir).find(handedOver);
    expect(said?.reason, JSON.stringify(said)).toEqual(expect.any(String));

    // A command that holds the folder a while: the other folder is kept in
    // step meanwhile.
    let pushed = false;
    const pushing = withFault("hold-handed-folder=4000", () =>
      a.folder.push(),
    ).then((outcome) => {
      pushed = true;
      return outcome;
    });
    await vi.waitFor(() => {
      expect(handovers(watch, a.dir)).toHaveLength(3);
    }, WAIT);
    // The record other programs read shows why the folder is not watched.
    await vi.waitFor(() => {
      expect(recorded(a, watch.pid(), a.dir)).toEqual(
        expect.objectContaining({ watching: false, reason: "handed_over" }),
      );
    }, WAIT);
    put(b, "While a is held.md", note("While a is held"));
    await vi.waitFor(() => {
      expect(sentTitles(b)).toContain("While a is held");
    }, WAIT);
    expect(pushed, "the other folder synced only once the command ended").toBe(
      false,
    );
    const outcome = await pushing;
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    await vi.waitFor(() => {
      expect(handovers(watch, a.dir)).toEqual([
        "let go",
        "taken back",
        "let go",
        "taken back",
      ]);
    }, WAIT);
    // The other folder was never let go.
    expect(handovers(watch, b.dir)).toEqual([]);
    await vi.waitFor(() => {
      expect(recorded(a, watch.pid(), a.dir)).toEqual(
        expect.objectContaining({ watching: true, reason: null }),
      );
    }, WAIT);
    expect(watch.running(), watch.stderr).toBe(true);
  });

  it("hands a folder its own watch holds to each command in turn, and the watch ends once the folder is removed", async () => {
    const harness = await oneFolder("handover-one");
    const watch = hold(harness.folder.watch());
    await vi.waitFor(() => expect(watch.stderr).toContain("watching"), WAIT);
    for (const [name, run] of [
      ["pull", () => harness.folder.pull()],
      ["scan", () => harness.folder.scan()],
      ["push", () => harness.folder.push()],
      ["confirm", () => harness.folder.confirm()],
    ] as const) {
      const worked = await run();
      expect(worked.ok, `${name}: ${JSON.stringify(worked)}`).toBe(true);
      await vi.waitFor(() => {
        expect(handovers(watch).at(-1), watch.stdout).toBe("taken back");
      }, WAIT);
    }
    const said = handovers(watch);
    expect(said.length).toBeGreaterThanOrEqual(2);
    expect(
      said.every(
        (line, at) => line === (at % 2 === 0 ? "let go" : "taken back"),
      ),
      `letting go or taking back was said twice in a row: ${said.join(", ")}`,
    ).toBe(true);
    // Taken back, it keeps the folder in step.
    put(harness, "After.md", note("After"));
    await vi.waitFor(
      () => expect(sentTitles(harness)).toContain("After"),
      WAIT,
    );

    // A watch does not ask: a second one is refused at once.
    const another = hold(harness.folder.watch());
    await another.exited();
    expect(another.exitCode()).toBe(4);
    expect(another.stderr).toContain("reading_handle");
    // Status reads the store, so it answers beside the watch.
    expect((await harness.folder.status()).ok).toBe(true);

    const removed = await harness.folder.remove();
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    await watch.exited();
    expect(watch.exitCode(), watch.stderr).toBe(0);
    expect(lines(watch).at(-1)).toEqual({ watching: false, listed: false });
    expect(existsSync(join(harness.dir, ".marfa", "core.sqlite"))).toBe(false);
  });

  it("refuses a command once a suspended watch has not let the folder go in 10 seconds, and both go on once it resumes", async () => {
    const harness = await oneFolder("handover-suspended");
    const watch = hold(harness.folder.watch());
    await vi.waitFor(() => expect(watch.stderr).toContain("watching"), WAIT);
    process.kill(watch.pid(), "SIGSTOP");
    put(harness, "Waiting.md", note("Waiting"));
    const before = await harness.folder.status();
    expect(before.ok).toBe(true);
    const started = Date.now();
    const refused = await harness.folder.scan();
    const waited = Date.now() - started;
    // Read while the watch is still suspended, so only the command could
    // have changed the store.
    const after = await harness.folder.status();
    process.kill(watch.pid(), "SIGCONT");
    expect(
      refused.ok,
      "a command worked a folder a suspended watch holds",
    ).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe("reading_handle");
    expect(refused.refusal.raw).toContain(
      "did not let it go within 10 seconds",
    );
    expect(waited).toBeGreaterThanOrEqual(10_000);
    expect(waited).toBeLessThan(20_000);
    // Refused before it changed anything: the store reads as it did.
    expect(after).toEqual(before);
    expect(handovers(watch)).toEqual([]);

    // Resumed, the watch goes on, and lets the folder go when asked again.
    await vi.waitFor(
      () => expect(sentTitles(harness)).toContain("Waiting"),
      WAIT,
    );
    const scanned = await harness.folder.scan();
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    await vi.waitFor(() => {
      expect(handovers(watch)).toEqual(["let go", "taken back"]);
    }, WAIT);
  }, 60_000);

  it("goes on syncing a folder whose asking command was killed before the watch let it go", async () => {
    const harness = await oneFolder("handover-killed");
    const watch = hold(harness.folder.watch());
    await vi.waitFor(() => expect(watch.stderr).toContain("watching"), WAIT);

    process.kill(watch.pid(), "SIGSTOP");
    const asking = hold(harness.folder.hold(["folders", "scan", harness.dir]));
    // Long enough to have asked, well inside its wait.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(asking.running(), asking.stderr).toBe(true);
    process.kill(asking.pid(), "SIGKILL");
    await asking.exited();
    process.kill(watch.pid(), "SIGCONT");

    put(harness, "After the kill.md", note("After the kill"));
    await vi.waitFor(
      () => expect(sentTitles(harness)).toContain("After the kill"),
      WAIT,
    );
    // Past a few looks for a request: none stands.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(
      handovers(watch),
      "the watch let the folder go to a command that had ended",
    ).toEqual([]);
    // The witness: a command that is there to take it is handed it.
    expect((await harness.folder.scan()).ok).toBe(true);
    await vi.waitFor(() => {
      expect(handovers(watch)).toEqual(["let go", "taken back"]);
    }, WAIT);
  });

  it("lets a folder go only once the write its pass is sending is answered", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await oneFolder(
      "handover-mid-pass",
      (answer: Answer, request) =>
        (JSON.parse(request.body) as { properties?: { title?: string } })
          .properties?.title === "Slow"
          ? { kind: "gated", until: gate, then: answer }
          : answer,
    );
    const watch = hold(harness.folder.watch());
    await vi.waitFor(() => expect(watch.stderr).toContain("watching"), WAIT);
    put(harness, "Slow.md", note("Slow"));
    await vi.waitFor(() => expect(sentTitles(harness)).toContain("Slow"), WAIT);

    let scannedAt: number | undefined;
    const scanning = harness.folder.scan().then((outcome) => {
      scannedAt = Date.now();
      return outcome;
    });
    // The watch has been asked, and still waits on the answer.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(
      scannedAt,
      "the folder was let go while its pass waited on a write's answer",
    ).toBeUndefined();
    const releasedAt = Date.now();
    release();
    const scanned = await scanning;
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    expect(scannedAt).toBeGreaterThanOrEqual(releasedAt);
    // The write went once, and its answer was taken in: the command found
    // nothing to queue for the file.
    expect(
      sentTitles(harness).filter((title) => title === "Slow"),
    ).toHaveLength(1);
    if (scanned.ok) expect(scanned.value.created).toBe(0);
    const status = await harness.folder.status();
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "Slow.md")?.status,
    ).toBe("in_step");
    await vi.waitFor(() => {
      expect(handovers(watch)).toEqual(["let go", "taken back"]);
    }, WAIT);
  });
});

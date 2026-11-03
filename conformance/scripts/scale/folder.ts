/**
 * A first sync of a notes folder into the full instance: what a person meets
 * bringing an existing folder of linked notes into Marfa.
 *
 * The folder holds 10,000 generated notes, `MARFA_SCALE_NOTES` overriding it
 * for a local run (100 or more). It is bound to a `system.folder` of its own
 * whose query is the notes this folder's key writes, and the key's source is
 * the folder's own, so the notes it makes are found again by that query.
 *
 * The first sync is timed in the three steps `folders push` takes: the
 * hydration, the scan (which resolves every link), and the push (which sends
 * the notes and writes their ids back). The whole is limited to 20 minutes;
 * past that the commands are stopped, the figures so far are kept and the
 * night fails on the step.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { scalar } from "../../src/utils/scale/figures.js";
import { folderNote } from "../../src/utils/scale/folder-generator.js";
import { judgeItemTotal } from "../../src/utils/scale/judging.js";
import { api, log, ok, Recorder, stateDir } from "./context.js";
import { cliEnv, runBounded, type Ran } from "./processes.js";

export const DEFAULT_NOTES = 10_000;
/** The whole first sync, past which it is an error. */
const FIRST_SYNC_LIMIT_MS = 20 * 60_000;
export const FOLDER_SOURCE = "scale-folder";

export function targetNotes(): number {
  const raw = process.env.MARFA_SCALE_NOTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_NOTES;
  const notes = Number(raw);
  if (!Number.isSafeInteger(notes) || notes < 100) {
    throw new Error(
      `MARFA_SCALE_NOTES is ${raw}; it needs a whole number of at least 100`,
    );
  }
  return notes;
}

/** What the later steps need to find the folder again. */
export interface FolderBench {
  folderId: string;
  key: string;
  dir: string;
  registry: string;
  notes: number;
}

export function benchFile(): string {
  return resolve(stateDir(), "folder-bench.json");
}

export function readBench(): FolderBench {
  try {
    return JSON.parse(readFileSync(benchFile(), "utf8")) as FolderBench;
  } catch {
    throw new Error("the folder step left no folder; it did not finish");
  }
}

function note(ran: Ran, what: string): string {
  return ran.timedOut
    ? `${what} did not finish in time`
    : `${what} exited with ${ran.exit}: ${ran.stderr.slice(-300)}`;
}

/** Writes the notes; the same files every night. */
function writeNotes(dir: string, notes: number): void {
  rmSync(dir, { recursive: true, force: true });
  for (let n = 1; n <= notes; n++) {
    const { path, text } = folderNote(n);
    const file = resolve(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

export async function folder(): Promise<void> {
  const recorder = new Recorder("folder");
  const notes = targetNotes();
  const root = resolve(stateDir(), "folder-bench");
  const dir = resolve(root, "notes");
  const registry = resolve(root, "folders.json");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeNotes(dir, notes);
  log(`wrote ${notes.toLocaleString()} notes`);

  const minted = await api("POST", "/keys", {
    label: "scale-folder",
    source: FOLDER_SOURCE,
  });
  if (!ok(minted)) {
    throw new Error(
      `the folder's key was refused with ${minted.status}: ${minted.text.slice(0, 300)}`,
    );
  }
  const key = (minted.json() as { key: string }).key;
  const ownerEnv = cliEnv({ registry });
  const created = await runBounded(
    [
      "--json",
      "folders",
      "create",
      "--body",
      JSON.stringify({
        title: "Scale folder",
        query: {
          types: ["core.note"],
          filter: `source eq "${FOLDER_SOURCE}"`,
        },
        defaults: { type: "core.note" },
      }),
    ],
    ownerEnv,
    60_000,
  );
  if (created.exit !== 0) throw new Error(note(created, "folders create"));
  const folderId = (JSON.parse(created.stdout) as { item: { id: string } }).item
    .id;
  const env = cliEnv({ key, registry });
  const bench: FolderBench = { folderId, key, dir, registry, notes };
  writeFileSync(benchFile(), JSON.stringify(bench));

  const added = await runBounded(
    ["--json", "folders", "add", dir, "--folder", folderId, "--yes"],
    env,
    120_000,
  );
  if (added.exit !== 0) throw new Error(note(added, "folders add"));

  const started = performance.now();
  const left = () =>
    Math.max(1_000, FIRST_SYNC_LIMIT_MS - (performance.now() - started));
  let failed: string | null = null;

  const hydrate = await runBounded(["folders", "hydrate", dir], env, left());
  if (hydrate.exit !== 0) failed = note(hydrate, "the hydration");
  recorder.add(
    scalar("folder_hydrate", "s", hydrate.ms / 1000, {
      errors: hydrate.exit === 0 ? 0 : 1,
      ...(hydrate.exit === 0 ? {} : { note: failed ?? "" }),
    }),
  );

  let scan: Ran | null = null;
  if (failed === null) {
    scan = await runBounded(["--json", "folders", "scan", dir], env, left());
    if (scan.exit !== 0) failed = note(scan, "the scan");
    recorder.add(
      scalar("folder_scan", "s", scan.ms / 1000, {
        errors: scan.exit === 0 ? 0 : 1,
        ...(scan.exit === 0 ? {} : { note: failed ?? "" }),
      }),
    );
  }

  let push: Ran | null = null;
  if (failed === null) {
    push = await runBounded(["folders", "push", dir], env, left());
    if (push.exit !== 0) failed = note(push, "the push");
    recorder.add(
      scalar("folder_push", "s", push.ms / 1000, {
        errors: push.exit === 0 ? 0 : 1,
        ...(push.exit === 0 ? {} : { note: failed ?? "" }),
      }),
    );
  }

  // Counted on the server, not taken from the commands' own reports.
  const stats = await api(
    "GET",
    `/items/stats?source=${encodeURIComponent(FOLDER_SOURCE)}`,
  );
  const held = judgeItemTotal(stats.status, stats.text, notes);
  recorder.add(
    scalar("folder_notes_synced", "count", held.value, {
      errors: held.errors,
      ...(held.note === null ? {} : { note: held.note }),
    }),
  );

  const wholeMs = (hydrate.ms + (scan?.ms ?? 0) + (push?.ms ?? 0)) / 1000;
  recorder.add(
    scalar("folder_first_sync", "s", wholeMs, {
      errors: failed === null && held.errors === 0 ? 0 : 1,
      ...(failed === null ? {} : { note: failed }),
    }),
  );
  recorder.learnedItems(0);
  recorder.finish();
}

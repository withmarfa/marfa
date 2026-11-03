/**
 * A device that copies the instance, then follows it.
 *
 * Hydrating the copy is timed by the release `marfa device hydrate`, which
 * pulls every type at both tiers with the edge types a person's app holds
 * whole. The copy's size on disk is recorded. Then `device follow` is held
 * open and notes are written through the API, and the time from the write to
 * the line the device prints for that item is the figure: when a change is in
 * the copy, which is when an app following it can show it.
 *
 * Either command is limited in time. Past its limit it is stopped by its
 * process ID, what was measured stays, and the step ends with the failure
 * counted.
 */
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  matchArrivals,
  type Reading,
  type Written,
} from "../../src/utils/scale/arrivals.js";
import { distribution, scalar } from "../../src/utils/scale/figures.js";
import { api, log, ok, Recorder, sleep, stateDir } from "./context.js";
import { cliEnv, HeldProcess, runBounded, waitUntil } from "./processes.js";

const HYDRATE_LIMIT_MS = 20 * 60_000;
const SAMPLES = 40;
/** How long after the last write a change may take to arrive before it is missing. */
const ARRIVAL_LIMIT_MS = 30_000;
const SPACING_MS = 500;

const megabytes = (file: string) =>
  existsSync(file) ? statSync(file).size / 1_048_576 : 0;

export async function device(): Promise<void> {
  const recorder = new Recorder("device");
  const dir = resolve(stateDir(), "device");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const db = resolve(dir, "copy.sqlite");
  const env = cliEnv();

  const hydrated = await runBounded(
    [
      "device",
      "--db",
      db,
      "--json",
      "hydrate",
      "--types",
      "*",
      "--tier",
      "all",
      "--edge-type",
      "parent-of",
      "--edge-type",
      "about",
    ],
    env,
    HYDRATE_LIMIT_MS,
  );
  const hydrateFailed = hydrated.exit !== 0;
  recorder.add(
    scalar("device_hydrate", "s", hydrated.ms / 1000, {
      errors: hydrateFailed ? 1 : 0,
      ...(hydrateFailed
        ? {
            note: hydrated.timedOut
              ? "the hydration did not finish in time"
              : `the hydration exited with ${hydrated.exit}: ${hydrated.stderr.slice(-300)}`,
          }
        : {}),
    }),
  );
  recorder.add(
    scalar("device_copy_size", "MB", megabytes(db) + megabytes(`${db}-wal`)),
  );
  if (hydrateFailed) {
    recorder.finish();
    return;
  }

  const readings: Reading[] = [];
  const held = HeldProcess.start(
    ["device", "--db", db, "--json", "follow"],
    env,
    (line) => readings.push({ text: line, seenAt: performance.now() }),
  );
  const written: Written[] = [];
  let errors = 0;
  let note: string | null = null;
  try {
    // The stream is open once the process has run a moment without ending.
    await sleep(3_000);
    if (!held.running) {
      throw new Error(`the follow ended at once: ${held.stderr.slice(-300)}`);
    }
    for (let n = 0; n < SAMPLES; n++) {
      const wroteAt = performance.now();
      const answer = await api("POST", "/items", {
        type: "core.note",
        properties: {
          title: `scale follow ${n}`,
          body: "written to be followed",
        },
      });
      const id = ok(answer)
        ? (answer.json() as { item?: { id?: string } }).item?.id
        : undefined;
      if (id === undefined) {
        errors++;
        note = `a write answered ${answer.status}`;
      } else {
        written.push({ marker: id, wroteAt });
      }
      await sleep(SPACING_MS);
    }
    const last = written.length;
    await waitUntil(
      () =>
        matchArrivals(written, readings).latenciesMs.length >= last ||
        !held.running,
      ARRIVAL_LIMIT_MS,
    );
  } catch (error) {
    errors++;
    note = String(error instanceof Error ? error.message : error);
  } finally {
    await held.stop();
  }

  const matched = matchArrivals(written, readings);
  if (matched.missing.length > 0) {
    errors += matched.missing.length;
    note = `${matched.missing.length} changes never reached the copy`;
  }
  log(`follow: ${matched.latenciesMs.length} of ${SAMPLES} arrived`);
  recorder.add(
    distribution("device_follow_change", "ms", matched.latenciesMs, {
      errors,
      ...(note === null ? {} : { note }),
    }),
  );
  recorder.finish();
}

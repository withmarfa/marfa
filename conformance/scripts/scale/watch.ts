/**
 * The folder's watch: how long an edit takes to reach the server, and what a
 * watch costs while nothing changes.
 *
 * The watch is the release `marfa folders watch`, started on the folder the
 * folder step synced and held. A first edit that is not counted tells when it
 * is working, since the watch prints nothing that says so. Then at least 30
 * notes spread across the folder are each edited with a line carrying a marker
 * of its own, and the time from the file write to the first reading of the
 * server that holds the marker is the figure. The server is read with the key
 * the folder uses, every 250 ms, and a change is found by its marker, never
 * by its place in a reply. An edit that has not arrived `ARRIVAL_LIMIT_MS`
 * after the last one was written counts as an error.
 *
 * Then the edits stop and the watch is left alone for `MARFA_SCALE_QUIET_MINUTES`
 * (10 by default). Its CPU, and that of every process below it, is read every
 * 5 seconds from `/proc` (from `ps` on a Mac), and the figure is the CPU
 * seconds used per minute. Resident memory is recorded with no ceiling.
 *
 * On Linux the watch is inotify; on a Mac it is FSEvents. The figures are
 * those of the machine they ran on, and the nightly job runs on Linux.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  matchArrivals,
  type Reading,
  type Written,
} from "../../src/utils/scale/arrivals.js";
import { cpuSecondsPerMinute, CpuMeter } from "../../src/utils/scale/cpu.js";
import { distribution, scalar } from "../../src/utils/scale/figures.js";
import { folderNote } from "../../src/utils/scale/folder-generator.js";
import { connect, log, ok, Recorder, api, sleep } from "./context.js";
import { cliEnv, HeldProcess, readTree } from "./processes.js";
import { FOLDER_SOURCE, readBench } from "./folder.js";

const EDITS = 30;
const SPACING_MS = 4_000;
const POLL_MS = 250;
const READY_LIMIT_MS = 90_000;
const ARRIVAL_LIMIT_MS = 60_000;
const CPU_SAMPLE_MS = 5_000;
const SETTLE_MS = 20_000;
const MARKER = /edit\d+z[0-9a-f]+/g;

export function quietMinutes(): number {
  const raw = process.env.MARFA_SCALE_QUIET_MINUTES;
  if (raw === undefined || raw.trim() === "") return 10;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`MARFA_SCALE_QUIET_MINUTES is ${raw}; it needs minutes`);
  }
  return minutes;
}

export async function watch(): Promise<void> {
  const recorder = new Recorder("watch");
  const bench = readBench();
  const env = cliEnv({ key: bench.key, registry: bench.registry });
  const connection = { ...connect(), key: bench.key };
  const since = new Date(Date.now() - 60_000).toISOString();

  const readings: Reading[] = [];
  let polling = true;
  let pollFailures = 0;
  const poller = (async () => {
    while (polling) {
      const answer = await api(
        "GET",
        `/items?source=${encodeURIComponent(FOLDER_SOURCE)}&updated_after=${encodeURIComponent(since)}&limit=500`,
        undefined,
        connection,
      );
      const seenAt = performance.now();
      if (ok(answer)) {
        const found = answer.text.match(MARKER);
        if (found !== null) {
          readings.push({ text: [...new Set(found)].join(" "), seenAt });
        }
      } else {
        pollFailures++;
      }
      await sleep(POLL_MS);
    }
  })();

  const held = HeldProcess.start(
    ["folders", "watch", bench.dir],
    env,
    () => undefined,
  );
  const written: Written[] = [];
  let errors = 0;
  let note: string | null = null;
  let counter = 0;
  const edit = (position: number): Written => {
    const marker = `edit${counter++}z${Math.random().toString(16).slice(2, 8)}`;
    appendFileSync(
      resolve(bench.dir, folderNote(position).path),
      `\nEdited ${marker}.\n`,
    );
    return { marker, wroteAt: performance.now() };
  };
  const stillWatching = () => {
    if (!held.running) {
      throw new Error(
        `the watch ended with ${held.exitCode}: ${held.stderr.slice(-300)}`,
      );
    }
  };

  try {
    // Not counted: it says when the watch is working.
    const warm = edit(1);
    const first = performance.now();
    while (
      matchArrivals([warm], readings).latenciesMs.length === 0 &&
      performance.now() - first < READY_LIMIT_MS
    ) {
      stillWatching();
      await sleep(POLL_MS);
    }
    if (matchArrivals([warm], readings).latenciesMs.length === 0) {
      throw new Error("the watch sent no edit within its start-up limit");
    }
    log(
      `the watch is working after ${((performance.now() - first) / 1000).toFixed(1)} s`,
    );

    // Spread across the folder, by a step coprime with its size.
    const stride = Math.max(1, Math.floor(bench.notes / EDITS) | 1);
    for (let n = 0; n < EDITS; n++) {
      stillWatching();
      written.push(edit(2 + ((n * stride) % (bench.notes - 1))));
      await sleep(SPACING_MS);
    }
    const lastWrite = performance.now();
    while (
      matchArrivals(written, readings).latenciesMs.length < written.length &&
      performance.now() - lastWrite < ARRIVAL_LIMIT_MS
    ) {
      stillWatching();
      await sleep(POLL_MS);
    }
    const matched = matchArrivals(written, readings);
    errors += matched.missing.length + (pollFailures > 5 ? 1 : 0);
    if (matched.missing.length > 0) {
      note = `${matched.missing.length} of ${written.length} edits never reached the server`;
    }
    recorder.add(
      distribution("folder_edit_to_server", "ms", matched.latenciesMs, {
        errors,
        ...(note === null ? {} : { note }),
      }),
    );
  } catch (error) {
    recorder.add(
      distribution("folder_edit_to_server", "ms", [], {
        errors: 1,
        note: String(error instanceof Error ? error.message : error),
      }),
    );
    polling = false;
    await poller;
    await held.stop();
    recorder.finish();
    throw error;
  }
  polling = false;
  await poller;

  // Quiet: the watch settles after the last edit, then is only watched.
  const quietMs = quietMinutes() * 60_000;
  try {
    await sleep(SETTLE_MS);
    stillWatching();
    const meter = new CpuMeter();
    let peakMb = 0;
    const sample = () => {
      const tree = readTree(held.pid);
      meter.read(new Map(tree.map((p) => [p.pid, p.cpuSeconds])));
      const mb = tree.reduce((sum, p) => sum + (p.rssMb ?? 0), 0);
      peakMb = Math.max(peakMb, mb);
    };
    const begun = performance.now();
    sample();
    while (performance.now() - begun < quietMs) {
      await sleep(CPU_SAMPLE_MS);
      stillWatching();
      sample();
    }
    const windowMs = performance.now() - begun;
    recorder.add(
      scalar(
        "folder_watch_cpu",
        "cpu_s_per_min",
        cpuSecondsPerMinute(meter.usedSinceFirstRead(), windowMs),
        {
          note: `${(windowMs / 60_000).toFixed(1)} minutes with no edits, on ${process.platform}`,
        },
      ),
    );
    recorder.add(scalar("folder_watch_rss", "MB", peakMb));
  } catch (error) {
    recorder.add(
      scalar("folder_watch_cpu", "cpu_s_per_min", 0, {
        errors: 1,
        note: String(error instanceof Error ? error.message : error),
      }),
    );
  } finally {
    await held.stop();
  }
  recorder.finish();
}

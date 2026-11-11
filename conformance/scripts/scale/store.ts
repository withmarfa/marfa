/**
 * Memory at rest on a server with an object store attached.
 *
 * Boots a server of its own on an empty instance with the `S3_*` settings in
 * the environment (`pnpm garage:up` writes them), checks that the instance
 * lists the store, lets it settle and reads its memory. It stops only the
 * server it started.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scalar } from "../../src/utils/scale/figures.js";
import { readServerMemory } from "../../src/utils/scale/memory.js";
import { StartedServers } from "../../src/utils/scale/servers.js";
import { bootServer, stopServer } from "../marfa-server.js";
import { log, Recorder, sleep } from "./context.js";
import { connectionOf, send, supervisor } from "./standalone.js";

const SETTLE_MS = Number(process.env.MARFA_SCALE_SETTLE_MS ?? "30000");

export async function store(): Promise<void> {
  const recorder = new Recorder("store");
  if (!process.env.S3_ENDPOINT) {
    throw new Error("S3_ENDPOINT is not set; run `pnpm garage:up` first");
  }
  const work = mkdtempSync(join(tmpdir(), "marfa-scale-store-"));
  const state = join(work, "a");
  const started = new StartedServers();
  try {
    started.starting(state);
    await bootServer({ state });
    const stores = await send(
      "GET",
      "/blobs/stores",
      undefined,
      connectionOf(state, "MARFA_MANAGEMENT_KEY"),
    );
    const listed = (stores.json() as { data?: unknown[] }).data?.length ?? 0;
    log(`the instance lists ${listed} object store(s)`);
    await sleep(SETTLE_MS);
    const memory = readServerMemory(supervisor(state));
    recorder.add(
      scalar("rss_at_rest_with_store", "MB", memory.rssMb, {
        errors: listed >= 2 ? 0 : 1,
        note:
          listed >= 2
            ? "an empty instance with the folder and an object store"
            : "the object store did not show in the instance's stores",
      }),
    );
  } finally {
    for (const failure of await started.stopAll((dir) =>
      stopServer({ state: dir }),
    )) {
      log(`could not stop a server: ${failure}`);
    }
    rmSync(work, { recursive: true, force: true });
  }
  recorder.finish();
}

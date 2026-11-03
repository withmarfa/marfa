import { afterAll, beforeAll, expect, it } from "vitest";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { Cli, releaseHeld, requireBinary } from "./harness.js";

/**
 * An archive export whose server holds the first byte for longer than the
 * CLI's usual answer budget of 90 seconds, as a large instance does while
 * the server checks its whole selection.
 *
 * **Why a server of its own.** The hold is a fault, and a fault on the shared
 * server would stop every other file's exports.
 */
const USUAL_ANSWER_BUDGET_MS = 90_000;
let server: FreshServer | undefined;
let dir: string;

beforeAll(async () => {
  server = await bootFreshServer("cli-archive-wait");
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-archive-wait-"));
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  releaseHeld();
  rmSync(dir, { recursive: true, force: true });
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

it("waits for an archive whose first byte comes after the usual answer budget, says it is working, and writes the path once the archive ends whole", async () => {
  const source = server!;
  const cli = new Cli(requireBinary(), source.apiUrl, source.workingKey);
  const path = join(dir, "nightly.tar.gz");
  writeFileSync(path, "an earlier backup");

  await source.setFault("hold:export-validation");
  let ended = false;
  const pending = cli
    .run(["export", "--format", "archive", "--output", path])
    .finally(() => {
      ended = true;
    });
  try {
    await source.waitForHold("hold:export-validation");
    await new Promise((resolve) =>
      setTimeout(resolve, USUAL_ANSWER_BUDGET_MS + 5_000),
    );
    // The witness: the budget that ended this export before has passed.
    expect(ended).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("an earlier backup");
  } finally {
    await source.clearFault();
  }

  const outcome = await pending;
  expect(outcome.code, outcome.stderr).toBe(0);
  expect(outcome.stderr).toContain("still preparing the archive");
  expect(gunzipSync(readFileSync(path)).toString("latin1")).toContain(
    '"missing_blobs":{}',
  );
  expect(readdirSync(dir)).toEqual(["nightly.tar.gz"]);
}, 180_000);

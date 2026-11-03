/**
 * The archive export of the whole instance, with the release `marfa` binary
 * a person would run.
 *
 * The first byte is seen from outside by watching the output folder: the
 * command writes to a file of its own, and the time its folder first holds a
 * byte is when the server started answering. It is polled, so it is rounded
 * up to the poll.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { scalar } from "../../src/utils/scale/figures.js";
import { connect, log, Recorder, sleep, stateDir } from "./context.js";

const POLL_MS = 250;
/** Past this the export is stopped and counted as not completing. */
const GIVE_UP_MS = 15 * 60_000;

function bytesIn(directory: string): number {
  try {
    return readdirSync(directory).reduce((sum, name) => {
      try {
        return sum + statSync(resolve(directory, name)).size;
      } catch {
        return sum;
      }
    }, 0);
  } catch {
    return 0;
  }
}

export async function exportArchive(): Promise<void> {
  const recorder = new Recorder("export");
  const binary = process.env.MARFA_DEVICE_BIN;
  if (binary === undefined || binary === "") {
    throw new Error("MARFA_DEVICE_BIN names the release marfa binary");
  }
  const { url, key } = connect();
  const directory = resolve(stateDir(), "archive-export");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });

  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(OTEL_|MARFA_OTEL_|MARFA_POSTHOG_)/.test(name)) delete env[name];
  }
  Object.assign(env, {
    MARFA_API_URL: url,
    MARFA_API_KEY: key,
    MARFA_NO_KEYCHAIN: "1",
    OTEL_SDK_DISABLED: "true",
  });

  const started = performance.now();
  const child = spawn(
    binary,
    [
      "export",
      "--format",
      "archive",
      "--output",
      resolve(directory, "instance.archive"),
    ],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2_000);
  });
  let exit: number | null | undefined;
  child.once("close", (code) => {
    exit = code;
  });

  let firstByteMs: number | null = null;
  let timedOut = false;
  while (exit === undefined) {
    await sleep(POLL_MS);
    if (firstByteMs === null && bytesIn(directory) > 0) {
      firstByteMs = performance.now() - started;
    }
    if (performance.now() - started > GIVE_UP_MS) {
      timedOut = true;
      child.kill("SIGTERM");
      await sleep(2_000);
      if (exit === undefined) child.kill("SIGKILL");
      break;
    }
  }
  const totalMs = performance.now() - started;
  const bytes = bytesIn(directory);
  rmSync(directory, { recursive: true, force: true });

  const completed = exit === 0 && !timedOut;
  if (!completed)
    log(
      `the export ${timedOut ? "did not finish" : `exited with ${exit}`}: ${stderr}`,
    );
  recorder.add(
    scalar("archive_export", "s", totalMs / 1000, {
      errors: completed ? 0 : 1,
      note: completed
        ? `${(bytes / 1_048_576).toFixed(0)} MB written`
        : `the export ${timedOut ? "did not finish" : `exited with ${exit}`}`,
    }),
  );
  if (firstByteMs !== null) {
    recorder.add(scalar("archive_export_first_byte", "s", firstByteMs / 1000));
  }
  recorder.finish();
}

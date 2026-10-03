/**
 * What the container's entrypoint does with the way the server stops.
 *
 * The server and Litestream are stand-in executables at the front of the
 * path, so the script runs as the image runs it and the only thing under
 * test is what it does with a status. A server that refuses a database
 * another build wrote must not be started again by whatever restarts the
 * container, and one that crashed must.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = join(ROOT, "deploy/entrypoint.sh");
const REFUSED = 78;

const dirs: string[] = [];
const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Run {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
  dir: string;
}

/**
 * Starts the entrypoint with `node` (and, with a bucket, `litestream`)
 * replaced by `body`, a shell script that stands for whichever one the
 * entrypoint runs last.
 */
function start(options: { body: string; bucket?: boolean }): Run {
  const dir = mkdtempSync(join(tmpdir(), "marfa-entrypoint-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  writeFileSync(
    join(dir, "stand-in.sh"),
    `#!/bin/sh\nmarker="${dir}"\n${options.body}\n`,
  );
  chmodSync(join(dir, "stand-in.sh"), 0o755);
  // `node`, run by the entrypoint or by Litestream's `-exec`, is the stand-in
  // too; `litestream restore` does nothing.
  const wrapper = (name: string, script: string) => {
    writeFileSync(join(dir, name), script);
    chmodSync(join(dir, name), 0o755);
  };
  mkdirSync(bin);
  wrapper("bin/node", `#!/bin/sh\nexec "${join(dir, "stand-in.sh")}" "$@"\n`);
  wrapper(
    "bin/litestream",
    `#!/bin/sh\ncase "$1" in restore) exit 0 ;; esac\nexec "${join(dir, "stand-in.sh")}" "$@"\n`,
  );

  const child = spawn("/bin/sh", [ENTRYPOINT], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      SQLITE_PATH: join(dir, "data/marfa.db"),
      BLOB_PATH: join(dir, "data/blobs"),
      ...(options.bucket ? { S3_BUCKET: "a-bucket" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own group, so a test that leaves it running takes the sleeps and
    // stand-ins it started with it.
    detached: true,
  });
  running.push(child);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (output += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (output += c));
  const exited = new Promise<number | null>((resolveExit) => {
    child.once("close", (code) => {
      resolveExit(code);
    });
  });
  return { child, output: () => output, exited, dir };
}

const pause = (ms: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function stillRunningAfter(run: Run, ms: number): Promise<boolean> {
  const winner = await Promise.race([
    run.exited.then(() => "exited"),
    pause(ms).then(() => "running"),
  ]);
  return winner === "running";
}

describe("deploy/entrypoint.sh", () => {
  it("names the status it treats as a refused database the same as the server's own", () => {
    const entrypoint = readFileSync(ENTRYPOINT, "utf8");
    const server = readFileSync(
      join(ROOT, "packages/server/src/storage/sqlite/refused-database.ts"),
      "utf8",
    );
    const inScript = /^REFUSED_DATABASE=(\d+)$/m.exec(entrypoint)?.[1];
    const inServer = /REFUSED_DATABASE_EXIT_CODE = (\d+);/.exec(server)?.[1];

    expect(inScript).toBeDefined();
    expect(inScript).toBe(inServer);
    expect(Number(inScript)).toBe(REFUSED);
  });

  it("ends with the server's own status when the server stops for any reason but a refused database", async () => {
    // The witness for the case below: a stop the entrypoint passes on.
    for (const status of [0, 1, 2, 77, 79, 137]) {
      const run = start({ body: `exit ${String(status)}` });
      expect(await run.exited).toBe(status);
    }
  });

  it("stays up, unhealthy, with the message, when the server refuses a database another build wrote", async () => {
    const run = start({
      body: `echo "the schema is not this build's" >&2\nexit ${String(REFUSED)}`,
    });

    expect(await stillRunningAfter(run, 1_500)).toBe(true);
    expect(run.output()).toContain("the schema is not this build's");
    expect(run.output()).toContain("will not start on it");
    expect(run.output()).toContain("stays up");
  });

  it("stays up the same way under Litestream, which passes on the status of the server it runs", async () => {
    const run = start({ bucket: true, body: `exit ${String(REFUSED)}` });

    expect(await stillRunningAfter(run, 1_500)).toBe(true);
    expect(run.output()).toContain("will not start on it");
  });

  it("ends 0 on the signal that stops the container, once it has stayed up", async () => {
    const run = start({ body: `exit ${String(REFUSED)}` });
    expect(await stillRunningAfter(run, 1_000)).toBe(true);

    run.child.kill("SIGTERM");

    expect(await run.exited).toBe(0);
  });

  it("hands the server the signal that stops the container, and ends with the server's status", async () => {
    const run = start({
      body: [
        `trap 'echo stopped > "$marker/stopped"; exit 3' TERM`,
        `echo ready > "$marker/ready"`,
        "while :; do sleep 0.1; done",
      ].join("\n"),
    });
    for (let i = 0; i < 100 && !existsSync(join(run.dir, "ready")); i += 1) {
      await pause(50);
    }
    expect(existsSync(join(run.dir, "ready"))).toBe(true);

    run.child.kill("SIGTERM");

    expect(await run.exited).toBe(3);
    expect(readFileSync(join(run.dir, "stopped"), "utf8")).toBe("stopped\n");
  });
});

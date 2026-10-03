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
  // Litestream's `replicate -exec` runs the command, forwards the signals
  // that stop it, and ends 1 whatever status the command ended with
  // (verified against 0.5.17): so a status cannot travel through it.
  wrapper(
    "bin/litestream",
    [
      "#!/bin/sh",
      'case "$1" in restore) exit 0 ;; esac',
      'while [ $# -gt 0 ]; do if [ "$1" = -exec ]; then command=$2; break; fi; shift; done',
      "signalled=0",
      `trap 'signalled=1; kill -TERM "$child" 2>/dev/null' TERM INT`,
      'sh -c "exec $command" &',
      "child=$!",
      'wait "$child"; status=$?',
      'if [ "$signalled" = 1 ]; then wait "$child"; status=$?; fi',
      'if [ "$status" -eq 0 ]; then exit 0; fi',
      "exit 1",
      "",
    ].join("\n"),
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

  it("stays up the same way under Litestream, which ends 1 whatever status the server ended with", async () => {
    const run = start({ bucket: true, body: `exit ${String(REFUSED)}` });

    expect(await stillRunningAfter(run, 1_500)).toBe(true);
    expect(run.output()).toContain("will not start on it");
  });

  it("ends 1, and does not stay up, when the server under Litestream stops for another reason", async () => {
    // The witness for the case above: the same Litestream, the same status
    // for the container to read, and no refusal to stay up for.
    for (const status of [1, 2, 77, 79]) {
      const run = start({ bucket: true, body: `exit ${String(status)}` });
      expect(await run.exited).toBe(1);
    }
  });

  it("hands the stop signal through Litestream and the entrypoint's own server layer to the server, which ends the container 0", async () => {
    const run = start({
      bucket: true,
      body: [
        `trap 'exit 0' TERM`,
        `echo ready > "$marker/ready"`,
        "while :; do sleep 0.1; done",
      ].join("\n"),
    });
    for (let i = 0; i < 100 && !existsSync(join(run.dir, "ready")); i += 1) {
      await pause(50);
    }
    expect(existsSync(join(run.dir, "ready"))).toBe(true);

    run.child.kill("SIGTERM");

    expect(await run.exited).toBe(0);
  });

  it("ends 0 under Litestream when the server stops cleanly", async () => {
    const run = start({ bucket: true, body: "exit 0" });
    expect(await run.exited).toBe(0);
  });

  it("ends 0 on the signal that stops the container, once it has stayed up", async () => {
    const run = start({ body: `exit ${String(REFUSED)}` });
    expect(await stillRunningAfter(run, 1_000)).toBe(true);

    run.child.kill("SIGTERM");

    expect(await run.exited).toBe(0);
  });

  // A server that stops at once on the signal has ended by the time the
  // entrypoint's wait notices the signal, which reports 143 for itself and
  // not the server's status.
  it("ends 0 when the server stops cleanly the moment it is signalled", async () => {
    const run = start({
      body: [
        `trap 'exit 0' TERM`,
        `echo ready > "$marker/ready"`,
        "while :; do sleep 0.1; done",
      ].join("\n"),
    });
    for (let i = 0; i < 100 && !existsSync(join(run.dir, "ready")); i += 1) {
      await pause(50);
    }
    expect(existsSync(join(run.dir, "ready"))).toBe(true);

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

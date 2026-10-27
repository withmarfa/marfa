/**
 * What the container's entrypoint does with the way the server stops.
 *
 * The server and Litestream are stand-in executables at the front of the
 * path, so the script runs as the image runs it and the only thing under
 * test is what it does with a status. A server that refuses its database
 * must not be started again by whatever restarts the
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
import { loadConfig } from "../packages/server/src/config.js";
import { replicaMarker } from "../packages/server/src/storage/sqlite/replica-position.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = join(ROOT, "deploy/entrypoint.sh");
const REFUSED = 78;
/** Litestream's record beside `data/marfa.db`, relative to a run's folder. */
const RECORD = "data/.marfa.db-litestream";
/** The file naming the replica that record is of, relative to a run's folder. */
const MARKER = "data/marfa.db-replica";
/** A marker the tests' start does not write. */
const OTHER_MARKER = replicaMarker({
  endpoint: "",
  bucket: "a-bucket",
  prefix: "elsewhere",
});

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

/** What `litestream ltx -json` lists for a replica of one snapshot. */
const LISTING =
  '[{"level":9,"min_txid":"0000000000000001","max_txid":"0000000000000007","size":4096,"timestamp":"2026-01-01T00:00:00Z"}]';

/**
 * Starts the entrypoint with `node` (and, with a bucket, `litestream`)
 * replaced by `body`, a shell script that stands for whichever one the
 * entrypoint runs last. `node dist/replica-check.js` runs `check` instead,
 * which by default writes down its arguments and input and passes;
 * `litestream ltx` prints `listing`, or fails when it is `null`. With
 * `database`, the volume holds a database before the entrypoint starts;
 * with `restored`, `litestream restore` writes one; with `record`, the
 * volume holds Litestream's record beside it, and with `marker`, the file
 * naming the replica that record is of.
 */
function start(options: {
  body: string;
  bucket?: boolean;
  database?: boolean;
  restored?: boolean;
  record?: boolean;
  marker?: string;
  check?: string;
  listing?: string | null;
  env?: Record<string, string>;
}): Run {
  const dir = mkdtempSync(join(tmpdir(), "marfa-entrypoint-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  writeFileSync(
    join(dir, "stand-in.sh"),
    `#!/bin/sh\nmarker="${dir}"\n${options.body}\n`,
  );
  chmodSync(join(dir, "stand-in.sh"), 0o755);
  writeFileSync(
    join(dir, "check.sh"),
    `#!/bin/sh\nmarker="${dir}"\n${
      options.check ??
      'printf "%s\\n" "$@" > "$marker/check-args"\ncat > "$marker/check-input"'
    }\n`,
  );
  chmodSync(join(dir, "check.sh"), 0o755);
  mkdirSync(join(dir, "data"));
  if (options.database) writeFileSync(join(dir, "data/marfa.db"), "");
  if (options.record) {
    mkdirSync(join(dir, RECORD, "ltx/0"), { recursive: true });
    writeFileSync(
      join(dir, RECORD, "ltx/0/0000000000000007-0000000000000007.ltx"),
      "",
    );
  }
  if (options.marker !== undefined) {
    writeFileSync(join(dir, MARKER), options.marker);
  }
  // `node`, run by the entrypoint or by Litestream's `-exec`, is the stand-in
  // too; `litestream restore` does nothing.
  const wrapper = (name: string, script: string) => {
    writeFileSync(join(dir, name), script);
    chmodSync(join(dir, name), 0o755);
  };
  mkdirSync(bin);
  wrapper(
    "bin/node",
    [
      "#!/bin/sh",
      `if [ "$1" = dist/replica-check.js ]; then shift; exec "${join(dir, "check.sh")}" "$@"; fi`,
      `exec "${join(dir, "stand-in.sh")}" "$@"`,
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "listing"), options.listing ?? "");
  // Litestream's `replicate -exec` runs the command, forwards the signals
  // that stop it, and ends 1 whatever status the command ended with
  // (verified against 0.5.17): so a status cannot travel through it.
  wrapper(
    "bin/litestream",
    [
      "#!/bin/sh",
      `echo "$1" >> "${join(dir, "litestream-commands")}"`,
      `case "$1" in restore) ${
        options.restored ? `: > "${join(dir, "data/marfa.db")}"; ` : ""
      }exit 0 ;; esac`,
      `case "$1" in ltx) ${
        options.listing === null
          ? 'echo "cannot reach the bucket" >&2; exit 1'
          : `cat "${join(dir, "listing")}"; exit 0`
      } ;; esac`,
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
      ...options.env,
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

/** What the server reads `S3_PREFIX` as, or `null` when it refuses it. */
function serverPrefix(raw: string | undefined): string | null {
  try {
    return (
      loadConfig(raw === undefined ? {} : { S3_PREFIX: raw }).s3Prefix ?? null
    );
  } catch {
    return null;
  }
}

/** What the entrypoint hands the server as `S3_PREFIX`, and so builds the
 *  replica path from, or `null` when it ends without starting the server. */
async function entrypointPrefix(
  raw: string | undefined,
): Promise<string | null> {
  const run = start({
    bucket: true,
    env: raw === undefined ? {} : { S3_PREFIX: raw },
    body: 'printf "%s" "$S3_PREFIX" > "$marker/prefix"',
  });
  const status = await run.exited;
  const written = join(run.dir, "prefix");
  if (!existsSync(written)) {
    expect(status).not.toBe(0);
    expect(run.output()).toContain("S3_PREFIX must be");
    return null;
  }
  return readFileSync(written, "utf8");
}

describe("deploy/entrypoint.sh", () => {
  // The replica is `<prefix>/db` (`deploy/litestream.yml`), so a reading the
  // server does not share would put the database where the server's blobs
  // are not, or beside another instance's.
  it("reads S3_PREFIX as the server does, and hands the server that reading", async () => {
    const cases: [string | undefined, string | null][] = [
      [undefined, "blobs"],
      ["", "blobs"],
      ["  ", "blobs"],
      ["blobs", "blobs"],
      ["rehearsal/blobs", "rehearsal/blobs"],
      ["rehearsal/blobs/", "rehearsal/blobs"],
      ["/rehearsal/blobs", "rehearsal/blobs"],
      ["//rehearsal/blobs//", "rehearsal/blobs"],
      [" trial/ ", "trial"],
      ["a.b_c-9", "a.b_c-9"],
      ["/", null],
      ["rehearsal//blobs", null],
      ["rehearsal/./blobs", null],
      ["rehearsal/../blobs", null],
      ["..", null],
      ["two words", null],
      ["blobs$", null],
      ["blöbs", null],
    ];
    for (const [raw, expected] of cases) {
      expect(serverPrefix(raw), JSON.stringify(raw)).toBe(expected);
      expect(await entrypointPrefix(raw), JSON.stringify(raw)).toBe(expected);
    }
  });

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

  it("stays up, unhealthy, with the message, when the server refuses its database", async () => {
    const run = start({
      body: `echo "the schema is not this build's" >&2\nexit ${String(REFUSED)}`,
    });

    await expect.poll(run.output, { timeout: 10_000 }).toContain("stays up");
    expect(await stillRunningAfter(run, 1_500)).toBe(true);
    expect(run.output()).toContain("the schema is not this build's");
    expect(run.output()).toContain("will not start on the database");
    expect(run.output()).toContain("stays up");
  });

  it("stays up the same way under Litestream, which ends 1 whatever status the server ended with", async () => {
    const run = start({
      bucket: true,
      body: `sleep 2\nexit ${String(REFUSED)}`,
    });

    await expect.poll(run.output, { timeout: 10_000 }).toContain("stays up");
    expect(await stillRunningAfter(run, 1_500)).toBe(true);
    expect(run.output()).toContain("will not start on the database");
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
    await expect.poll(run.output, { timeout: 10_000 }).toContain("stays up");
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

describe("deploy/entrypoint.sh, before replication starts", () => {
  const SERVER_STARTED = 'echo started > "$marker/started"';
  const commands = (run: Run): string[] => {
    const path = join(run.dir, "litestream-commands");
    return existsSync(path)
      ? readFileSync(path, "utf8").trim().split("\n")
      : [];
  };

  it("checks a database that was on the volume against the replica's listing, and starts when the check passes", async () => {
    const run = start({
      bucket: true,
      database: true,
      listing: LISTING,
      env: { S3_PREFIX: "trial/blobs", S3_ENDPOINT: "http://127.0.0.1:3900" },
      body: SERVER_STARTED,
    });

    expect(await run.exited).toBe(0);
    expect(readFileSync(join(run.dir, "check-args"), "utf8")).toBe(
      `${join(run.dir, "data/marfa.db")}\na-bucket\ntrial/blobs\nhttp://127.0.0.1:3900\n`,
    );
    expect(readFileSync(join(run.dir, "check-input"), "utf8")).toBe(LISTING);
    expect(commands(run)).toEqual(["restore", "ltx", "replicate"]);
    expect(existsSync(join(run.dir, "started"))).toBe(true);
  });

  it("does not check a database the restore wrote, which is the replica's newest state", async () => {
    const run = start({
      bucket: true,
      restored: true,
      listing: LISTING,
      body: SERVER_STARTED,
    });

    expect(await run.exited).toBe(0);
    expect(existsSync(join(run.dir, "check-args"))).toBe(false);
    expect(commands(run)).toEqual(["restore", "replicate"]);
    expect(existsSync(join(run.dir, "started"))).toBe(true);
  });

  it("ends 1 without replicating or starting the server when the check refuses", async () => {
    const run = start({
      bucket: true,
      database: true,
      listing: LISTING,
      check: 'echo "The database is older than the replica." >&2\nexit 1',
      body: SERVER_STARTED,
    });

    expect(await run.exited).toBe(1);
    expect(run.output()).toContain("The database is older than the replica.");
    expect(commands(run)).toEqual(["restore", "ltx"]);
    expect(existsSync(join(run.dir, "started"))).toBe(false);
  });

  it("ends 1 without replicating or starting the server when the bucket cannot be listed, and names the override", async () => {
    const run = start({
      bucket: true,
      database: true,
      listing: null,
      body: SERVER_STARTED,
    });

    expect(await run.exited).toBe(1);
    expect(run.output()).toContain("Could not list the replica at blobs/db");
    expect(run.output()).toContain("MARFA_REPLACE_NEWER_REPLICA=true");
    expect(existsSync(join(run.dir, "check-args"))).toBe(false);
    expect(commands(run)).toEqual(["restore", "ltx"]);
    expect(existsSync(join(run.dir, "started"))).toBe(false);
  });

  it("starts without the check when MARFA_REPLACE_NEWER_REPLICA is a true word, and says so", async () => {
    for (const value of [
      "true",
      "TRUE",
      "1",
      "yes",
      "On",
      " true ",
      "\tON\n",
    ]) {
      const run = start({
        bucket: true,
        database: true,
        listing: null,
        check: "exit 1",
        env: { MARFA_REPLACE_NEWER_REPLICA: value },
        body: SERVER_STARTED,
      });

      expect(await run.exited, value).toBe(0);
      expect(run.output(), value).toContain(
        "MARFA_REPLACE_NEWER_REPLICA is set",
      );
      expect(commands(run), value).toEqual(["restore", "replicate"]);
      expect(existsSync(join(run.dir, "started")), value).toBe(true);
    }
  });

  it("checks as usual when MARFA_REPLACE_NEWER_REPLICA is a false word or empty", async () => {
    for (const value of ["false", "0", "no", "OFF", "", " no\t", "  "]) {
      const run = start({
        bucket: true,
        database: true,
        listing: LISTING,
        check: "exit 1",
        env: { MARFA_REPLACE_NEWER_REPLICA: value },
        body: SERVER_STARTED,
      });

      expect(await run.exited, value).toBe(1);
      expect(run.output(), value).not.toContain(
        "MARFA_REPLACE_NEWER_REPLICA is set",
      );
      expect(commands(run), value).toEqual(["restore", "ltx"]);
    }
  });

  it("removes Litestream's record before replicating when the check finds the replica empty", async () => {
    const run = start({
      bucket: true,
      database: true,
      record: true,
      listing: "[]",
      check: "cat > /dev/null\necho empty",
      body: SERVER_STARTED,
    });

    expect(await run.exited).toBe(0);
    expect(existsSync(join(run.dir, RECORD))).toBe(false);
    expect(run.output()).toContain("Removing Litestream's record");
    expect(commands(run)).toEqual(["restore", "ltx", "replicate"]);
    expect(existsSync(join(run.dir, "started"))).toBe(true);
  });

  it("keeps Litestream's record when the check passes on a replica that holds transactions", async () => {
    const run = start({
      bucket: true,
      database: true,
      record: true,
      listing: LISTING,
      body: SERVER_STARTED,
    });

    expect(await run.exited).toBe(0);
    expect(existsSync(join(run.dir, RECORD))).toBe(true);
    expect(run.output()).not.toContain("Removing Litestream's record");
    expect(commands(run)).toEqual(["restore", "ltx", "replicate"]);
  });

  it("keeps Litestream's record when the check refuses", async () => {
    const run = start({
      bucket: true,
      database: true,
      record: true,
      listing: "[]",
      check: "echo empty\nexit 1",
      body: SERVER_STARTED,
    });

    expect(await run.exited).toBe(1);
    expect(existsSync(join(run.dir, RECORD))).toBe(true);
    expect(commands(run)).toEqual(["restore", "ltx"]);
  });

  it("removes Litestream's record under MARFA_REPLACE_NEWER_REPLICA", async () => {
    const run = start({
      bucket: true,
      database: true,
      record: true,
      listing: null,
      env: { MARFA_REPLACE_NEWER_REPLICA: "true" },
      body: SERVER_STARTED,
    });

    expect(await run.exited).toBe(0);
    expect(existsSync(join(run.dir, RECORD))).toBe(false);
    expect(commands(run)).toEqual(["restore", "replicate"]);
  });

  it("removes Litestream's record when the volume holds no database and the restore finds no replica", async () => {
    const run = start({ bucket: true, record: true, body: SERVER_STARTED });

    expect(await run.exited).toBe(0);
    expect(existsSync(join(run.dir, RECORD))).toBe(false);
    expect(commands(run)).toEqual(["restore", "replicate"]);
  });

  it("removes Litestream's record when the restore writes the database, which the record does not describe", async () => {
    const run = start({
      bucket: true,
      record: true,
      marker: OTHER_MARKER,
      restored: true,
      body: SERVER_STARTED,
    });

    expect(await run.exited).toBe(0);
    expect(existsSync(join(run.dir, "data/marfa.db"))).toBe(true);
    expect(existsSync(join(run.dir, RECORD))).toBe(false);
    expect(run.output()).toContain("Removing Litestream's record");
    expect(readFileSync(join(run.dir, MARKER), "utf8")).toBe(
      replicaMarker({ endpoint: "", bucket: "a-bucket", prefix: "blobs" }),
    );
    expect(commands(run)).toEqual(["restore", "replicate"]);
  });

  it("writes the marker naming the replica, as the check reads it, before replicating", async () => {
    const run = start({
      bucket: true,
      database: true,
      record: true,
      listing: LISTING,
      env: { S3_PREFIX: "/trial/blobs/", S3_ENDPOINT: "http://127.0.0.1:3900" },
      body: `test -e "$marker/${MARKER}" && : > "$marker/marked"\n${SERVER_STARTED}`,
    });

    expect(await run.exited).toBe(0);
    expect(existsSync(join(run.dir, "marked"))).toBe(true);
    expect(readFileSync(join(run.dir, MARKER), "utf8")).toBe(
      replicaMarker({
        endpoint: "http://127.0.0.1:3900",
        bucket: "a-bucket",
        prefix: "trial/blobs",
      }),
    );
    expect(existsSync(join(run.dir, RECORD))).toBe(true);
  });

  it("writes the endpoint and bucket into the marker and the check as the server reads them, without the space around them", async () => {
    const run = start({
      database: true,
      record: true,
      listing: LISTING,
      env: {
        S3_BUCKET: " a-bucket\n",
        S3_ENDPOINT: "http://127.0.0.1:3900\n",
      },
      body: SERVER_STARTED,
    });

    expect(await run.exited).toBe(0);
    expect(readFileSync(join(run.dir, "check-args"), "utf8")).toBe(
      `${join(run.dir, "data/marfa.db")}\na-bucket\nblobs\nhttp://127.0.0.1:3900\n`,
    );
    expect(readFileSync(join(run.dir, MARKER), "utf8")).toBe(
      replicaMarker({
        endpoint: "http://127.0.0.1:3900",
        bucket: "a-bucket",
        prefix: "blobs",
      }),
    );
  });

  it("replaces a marker that names another replica when the check finds the replica empty and the record is removed", async () => {
    const run = start({
      bucket: true,
      database: true,
      record: true,
      marker: OTHER_MARKER,
      listing: "[]",
      check: "cat > /dev/null\necho empty",
      body: SERVER_STARTED,
    });

    expect(await run.exited).toBe(0);
    expect(existsSync(join(run.dir, RECORD))).toBe(false);
    expect(readFileSync(join(run.dir, MARKER), "utf8")).toBe(
      replicaMarker({ endpoint: "", bucket: "a-bucket", prefix: "blobs" }),
    );
  });

  it("leaves the marker and the record as they were when the check refuses", async () => {
    const run = start({
      bucket: true,
      database: true,
      record: true,
      marker: OTHER_MARKER,
      listing: LISTING,
      check: "cat > /dev/null\nexit 1",
      body: SERVER_STARTED,
    });

    expect(await run.exited).toBe(1);
    expect(existsSync(join(run.dir, RECORD))).toBe(true);
    expect(readFileSync(join(run.dir, MARKER), "utf8")).toBe(OTHER_MARKER);
  });

  it("writes no marker without a bucket", async () => {
    const run = start({ database: true, body: SERVER_STARTED });

    expect(await run.exited).toBe(0);
    expect(existsSync(join(run.dir, "started"))).toBe(true);
    expect(existsSync(join(run.dir, MARKER))).toBe(false);
  });

  it("refuses a MARFA_REPLACE_NEWER_REPLICA that is not a flag word, before anything runs", async () => {
    const run = start({
      bucket: true,
      database: true,
      listing: LISTING,
      env: { MARFA_REPLACE_NEWER_REPLICA: "please" },
      body: SERVER_STARTED,
    });

    expect(await run.exited).toBe(1);
    expect(run.output()).toContain(
      "MARFA_REPLACE_NEWER_REPLICA must be true or false",
    );
    expect(commands(run)).toEqual([]);
  });
});

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { QUIET_SCHEDULE } from "../../utils/moved-clock.js";
import { tempFolder } from "../../utils/temp-folder.js";

/**
 * The swap of a server installed as a service. Each case boots a copy of the
 * run's server from a folder of its own, beside a stand-in `marfa`, with the
 * environment `marfa server run` gives a service. A stand-in for GitHub, which a
 * `release-feed` fault names, serves the release answer, an archive of
 * stand-in programs and the checksum file, so nothing is fetched from the
 * network. The settle and the put-back belong to `marfa server run`, which no
 * case here starts, so they are not asserted here.
 */

const RELEASE = "9.9.9";
const OLD_VERSION = "0.0.0";
const PROGRAMS = ["marfa-server", "marfa"] as const;
const LOCK = ".marfa-update.lock";

type Program = (typeof PROGRAMS)[number];

/** What a stand-in release does when the server asks it a question. */
interface Behavior {
  /** What `marfa-server --version` and `marfa --version` print after the name. */
  serverReports: string;
  marfaReports: string;
  /** Whether the new `marfa` accepts `server run --dir <dir> --check`. */
  marfaChecks: boolean;
  /** What `marfa-server --can-open` does. */
  canOpen: "accepts" | "refuses";
}

const GOOD: Behavior = {
  serverReports: RELEASE,
  marfaReports: RELEASE,
  marfaChecks: true,
  canOpen: "accepts",
};

function platformName(): string {
  const names: Record<string, string> = {
    "darwin-arm64": "darwin-arm64",
    "linux-x64": "linux-x86_64",
    "linux-arm64": "linux-aarch64",
  };
  const name = names[`${process.platform}-${process.arch}`];
  if (name === undefined) {
    throw new Error(
      `a server swaps its programs on no ${process.platform} ${process.arch} machine`,
    );
  }
  return name;
}

/** A stand-in program, a shell script that records how it was run in `log`. */
function script(name: Program, behavior: Behavior, log: string): string {
  const reports =
    name === "marfa" ? behavior.marfaReports : behavior.serverReports;
  const lines = [
    "#!/bin/sh",
    `echo "${name} $*" >> '${log}'`,
    'case "$1" in',
    `--version) echo '${name} ${reports}'; exit 0;;`,
  ];
  if (name === "marfa-server") {
    lines.push(
      behavior.canOpen === "accepts"
        ? `--can-open) echo '{"schema":1,"standing":"current"}'; exit 0;;`
        : `--can-open) echo 'this release will not open the database' >&2; exit 78;;`,
    );
  } else {
    lines.push(
      behavior.marfaChecks
        ? "server) exit 0;;"
        : "server) echo 'this marfa will not run the install' >&2; exit 1;;",
    );
  }
  lines.push("*) exit 64;;", "esac", "");
  return lines.join("\n");
}

interface Made {
  archive: Buffer;
  checksums: string;
  /** What the new programs hold, by name. */
  programs: Record<Program, Buffer>;
}

/** The archive and checksum file of a release, as GitHub would serve them. */
function makeRelease(behavior: Behavior, log: string): Made {
  const source = tempFolder("marfa-release-");
  const programs = {} as Record<Program, Buffer>;
  for (const name of PROGRAMS) {
    const text = script(name, behavior, log);
    writeFileSync(join(source, name), text, { mode: 0o755 });
    programs[name] = Buffer.from(text);
  }
  const archivePath = join(source, "release.tar.gz");
  const packed = spawnSync(
    "tar",
    ["-czf", archivePath, "-C", source, ...PROGRAMS],
    { encoding: "utf8" },
  );
  expect(packed.status, packed.stderr).toBe(0);
  const archive = readFileSync(archivePath);
  const hash = createHash("sha256").update(archive).digest("hex");
  return {
    archive,
    checksums: `${hash}  marfa-${RELEASE}-${platformName()}.tar.gz\n`,
    programs,
  };
}

/** What the stand-in for GitHub serves, and how. */
interface Plan {
  made: Made;
  /** The checksum file's text, which a case may spoil. */
  checksums: string;
  /** The size the release answer gives the archive. */
  declared: number;
  archiveStatus: number;
  /** Answers the archive's request with a redirect to this path or address. */
  archiveRedirect?: string;
  /** Holds the archive's answer until this settles. */
  hold?: Promise<void>;
}

let feed: Server;
let plan: Plan;
/** Every request the stand-in has had, in order, with the path asked. */
let paths: string[] = [];
let archiveSeen: (() => void) | undefined;

function origin(): string {
  const { port } = feed.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const DOWNLOADS = `/withmarfa/marfa/releases/download/v${RELEASE}`;

function archiveName(platform = platformName()): string {
  return `marfa-${RELEASE}-${platform}.tar.gz`;
}

function latest(): string {
  const platforms = ["linux-x86_64", "darwin-arm64", "linux-aarch64"];
  return JSON.stringify({
    tag_name: `v${RELEASE}`,
    draft: false,
    prerelease: false,
    published_at: "2026-11-16T09:30:00Z",
    assets: [
      ...platforms.map((platform) => ({
        name: archiveName(platform),
        browser_download_url: `${origin()}${DOWNLOADS}/${archiveName(platform)}`,
        size: plan.declared,
      })),
      {
        name: `marfa-${RELEASE}-checksums.txt`,
        browser_download_url: `${origin()}${DOWNLOADS}/marfa-${RELEASE}-checksums.txt`,
        size: plan.checksums.length,
      },
    ],
  });
}

async function answer(
  path: string,
  response: import("node:http").ServerResponse,
): Promise<void> {
  const send = (status: number, body: string | Buffer, type: string) => {
    response.writeHead(status, { "content-type": type });
    response.end(body);
  };
  if (path === "/latest") {
    send(200, latest(), "application/json");
  } else if (path === `${DOWNLOADS}/marfa-${RELEASE}-checksums.txt`) {
    send(200, plan.checksums, "text/plain");
  } else if (path === `${DOWNLOADS}/${archiveName()}`) {
    archiveSeen?.();
    await plan.hold;
    if (plan.archiveRedirect !== undefined) {
      response.writeHead(302, { location: plan.archiveRedirect });
      response.end();
    } else if (plan.archiveStatus !== 200) {
      send(plan.archiveStatus, "", "text/plain");
    } else {
      send(200, plan.made.archive, "application/octet-stream");
    }
  } else if (path === "/moved/archive") {
    send(200, plan.made.archive, "application/octet-stream");
  } else {
    send(404, "", "text/plain");
  }
}

beforeAll(async () => {
  feed = createServer((request, response) => {
    const path = request.url ?? "";
    paths.push(path);
    void answer(path, response);
  });
  await new Promise<void>((resolve) => feed.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise((resolve) => feed?.close(resolve));
});

/** The server program of this run, which each case copies. */
function runsServer(): string {
  const program = process.env.MARFA_SERVER_BIN;
  if (program === undefined || program === "") {
    throw new Error("MARFA_SERVER_BIN names no server");
  }
  const path = resolve(program);
  expect(statSync(path).isFile(), `${path} is not a file`).toBe(true);
  return path;
}

interface Installed {
  server: FreshServer;
  operator: MarfaClient;
  /** The folder holding the programs. */
  programs: string;
  installDir: string;
  /** What the programs held before any update. */
  before: Record<Program, Buffer>;
  /** Where each stand-in program records how it was run. */
  log: string;
  /** How each stand-in program was run, one line per run. */
  runs(): string[];
}

const stopped: FreshServer[] = [];

afterAll(async () => {
  await Promise.all(stopped.map((server) => server.stop()));
}, FRESH_SERVER_TIMEOUT_MS);

/** A server run from a copy of this run's own, as a service `marfa server run` supervises. */
async function installed(label: string): Promise<Installed> {
  const programs = tempFolder("marfa-programs-");
  const installDir = tempFolder("marfa-install-");
  const log = join(tempFolder("marfa-runs-"), "runs.log");
  writeFileSync(log, "");
  const copy = join(programs, "marfa-server");
  copyFileSync(runsServer(), copy);
  chmodSync(copy, 0o755);
  const old: Behavior = {
    ...GOOD,
    serverReports: OLD_VERSION,
    marfaReports: OLD_VERSION,
  };
  const marfa = script("marfa", old, log);
  writeFileSync(join(programs, "marfa"), marfa, { mode: 0o755 });
  const server = await bootFreshServer(
    label,
    {
      ...QUIET_SCHEDULE,
      MARFA_SERVICE: "launchd",
      MARFA_INSTALL_DIR: installDir,
    },
    copy,
  );
  stopped.push(server);
  const operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
  const { port } = feed.address() as AddressInfo;
  await server.setFault(`release-feed=http://127.0.0.1:${port}/latest`);
  return {
    server,
    operator,
    programs,
    installDir,
    before: {
      "marfa-server": readFileSync(copy),
      marfa: Buffer.from(marfa),
    },
    log,
    runs: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== ""),
  };
}

/** Serves `behavior`'s release and has the server find it. */
async function offer(
  install: Installed,
  behavior: Behavior = GOOD,
  change: Partial<Plan> = {},
): Promise<void> {
  const made = makeRelease(behavior, install.log);
  plan = {
    made,
    checksums: made.checksums,
    declared: made.archive.length,
    archiveStatus: 200,
    ...change,
  };
  const run = await install.operator.runHousekeeping("release-check");
  expect(run.status, JSON.stringify(run.error)).toBe(200);
  const read = await install.operator.getUpdate();
  expect(read.data.latest?.release, JSON.stringify(read.data)).toBe(RELEASE);
  expect(read.data.available).toBe(true);
  expect(read.data.method).toBe("server");
}

/** The checksum file naming a hash that is not the archive's. */
function spoiled(made: Made): string {
  return `${"0".repeat(64)}  ${archiveName()}\n${made.checksums.slice(64)}`.replace(
    `${"0".repeat(64)}  ${archiveName()}\n  ${archiveName()}\n`,
    `${"0".repeat(64)}  ${archiveName()}\n`,
  );
}

function read(path: string): Buffer {
  return readFileSync(path);
}

/** The programs folder holds the two programs as they were and nothing the update left. */
function expectUnchanged(install: Installed, what: string): void {
  const names = readdirSync(install.programs)
    .filter((name) => name !== LOCK)
    .sort();
  expect(names, what).toEqual(["marfa", "marfa-server"]);
  for (const name of PROGRAMS) {
    expect(
      read(join(install.programs, name)).equals(install.before[name]),
      `${name}: ${what}`,
    ).toBe(true);
  }
}

/** Starts the update and waits for it to end, which only a failed one does while the server runs. */
async function endsFailed(install: Installed): Promise<{
  outcome: string;
  release: string;
  reason: string | null;
  finished_at: string;
}> {
  const previous =
    (await install.operator.getUpdate()).data.last?.finished_at ?? null;
  const started = await install.operator.startUpdate();
  expect(started.status, JSON.stringify(started.error)).toBe(202);
  await expect
    .poll(
      async () => {
        const { progress, last } = (await install.operator.getUpdate()).data;
        return progress.state === "idle" && last?.finished_at !== previous
          ? last
          : null;
      },
      { timeout: 60_000, interval: 100 },
    )
    .not.toBeNull();
  const { last } = (await install.operator.getUpdate()).data;
  expect(last, "the update ended").not.toBeNull();
  expect(last!.outcome, JSON.stringify(last)).toBe("failed");
  expect(last!.release).toBe(RELEASE);
  return last!;
}

/** Holds the archive's answer until `release` is called, and says when it was asked for. */
function holdArchive(): { release: () => void; asked: Promise<void> } {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const asked = new Promise<void>((resolve) => {
    archiveSeen = resolve;
  });
  plan.hold = hold;
  return { release, asked };
}

function archiveRequests(): number {
  return paths.filter((path) => path === `${DOWNLOADS}/${archiveName()}`)
    .length;
}

async function started(operator: MarfaClient): Promise<number> {
  const listed = await operator.listAudit({
    action: "instance.update.started",
  });
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return listed.data.data.length;
}

let shared: Promise<Installed> | undefined;
/** The server the cases that leave the programs as they were share. */
function failing(): Promise<Installed> {
  shared ??= installed("updates-swap-failing");
  return shared;
}

it(
  "swaps in a release that passes every check, keeping the old server and staging the new marfa, and ends to start it",
  async () => {
    const install = await installed("updates-swap");
    paths = [];
    await offer(install);
    const running = (await install.operator.getUpdate()).data.release;
    const held = holdArchive();
    const before = await started(install.operator);

    const begun = await install.operator.startUpdate();
    expect(begun.status, JSON.stringify(begun.error)).toBe(202);
    await held.asked;
    const during = await install.operator.getUpdate();
    expect(during.data.progress).toEqual({
      state: "fetching",
      release: RELEASE,
    });
    const entries = await install.operator.listAudit({
      action: "instance.update.started",
    });
    expect(entries.data.data.length).toBe(before + 1);
    expect(entries.data.data[0]?.details).toMatchObject({
      from: running,
      to: RELEASE,
    });
    held.release();

    const exit = await install.server.exit();
    expect(exit.code).toBe(75);

    const made = plan.made;
    const holds = (name: string, bytes: Buffer): boolean =>
      read(join(install.programs, name)).equals(bytes);
    expect(holds("marfa-server", made.programs["marfa-server"])).toBe(true);
    expect(
      holds(".marfa-server.previous", install.before["marfa-server"]),
    ).toBe(true);
    expect(holds(".marfa.next", made.programs.marfa)).toBe(true);
    expect(holds("marfa", install.before.marfa)).toBe(true);
    expect(
      readdirSync(install.programs).filter((name) =>
        name.startsWith(".marfa-update-"),
      ),
    ).toEqual([]);

    // Each check ran on the new programs.
    const runs = install.runs();
    expect(runs).toContain(`marfa-server --version`);
    expect(runs).toContain(`marfa --version`);
    expect(runs).toContain(
      `marfa server run --dir ${install.installDir} --check`,
    );
    expect(runs).toContain(
      `marfa-server --can-open ${install.server.sqlitePath}`,
    );

    // Only the release's own two files were asked for.
    expect(paths.filter((path) => path !== "/latest")).toEqual([
      `${DOWNLOADS}/marfa-${RELEASE}-checksums.txt`,
      `${DOWNLOADS}/${archiveName()}`,
    ]);
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "leaves the programs as they were when the download does not match the release's checksum",
  async () => {
    const install = await failing();
    await offer(install);
    plan.checksums = spoiled(plan.made);
    const last = await endsFailed(install);
    expect(last.reason).toMatch(/does not match the release's checksum/);
    expectUnchanged(install, "a wrong checksum");
    expect(install.runs(), "nothing downloaded was run").toEqual([]);
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "leaves the programs as they were when a new program reports another release",
  async () => {
    const install = await failing();
    const reporting: [Partial<Behavior>, RegExp][] = [
      [
        { serverReports: "9.9.8" },
        /marfa-server reports 'marfa-server 9\.9\.8'/,
      ],
      [{ marfaReports: "9.9.8" }, /marfa reports 'marfa 9\.9\.8'/],
    ];
    for (const [other, reason] of reporting) {
      await offer(install, { ...GOOD, ...other });
      const last = await endsFailed(install);
      expect(last.reason, JSON.stringify(other)).toMatch(reason);
      expectUnchanged(install, JSON.stringify(other));
    }
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "leaves the programs as they were when the new server refuses the database",
  async () => {
    const install = await failing();
    await offer(install, { ...GOOD, canOpen: "refuses" });
    const last = await endsFailed(install);
    expect(last.reason).toMatch(/will not run on this server's settings/);
    expect(last.reason).toMatch(/will not open the database/);
    expectUnchanged(install, "a refused database");
    expect(install.runs()).toContain(
      `marfa-server --can-open ${install.server.sqlitePath}`,
    );
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "leaves the programs as they were when the new marfa will not run the install",
  async () => {
    const install = await failing();
    await offer(install, { ...GOOD, marfaChecks: false });
    const last = await endsFailed(install);
    expect(last.reason).toMatch(/will not run this install/);
    expectUnchanged(install, "a marfa that refuses the install");
    expect(install.runs()).toContain(
      `marfa server run --dir ${install.installDir} --check`,
    );
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "leaves the programs as they were when the download fails or the disk has too little room",
  async () => {
    const install = await failing();
    await offer(install, GOOD, { archiveStatus: 404 });
    const missing = await endsFailed(install);
    expect(missing.reason).toMatch(/could not be downloaded/);
    expectUnchanged(install, "a download that failed");

    paths = [];
    await offer(install, GOOD, { declared: 2 ** 50 });
    const room = await endsFailed(install);
    expect(room.reason).toMatch(/not enough room/);
    expectUnchanged(install, "too little room");
    expect(archiveRequests(), "nothing was fetched").toBe(0);

    // The witness: the same release, sized as it is, is fetched.
    await offer(install, GOOD, { archiveStatus: 404 });
    await endsFailed(install);
    expect(archiveRequests()).toBe(1);
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "follows a redirect of a release's file only on the address it asks, and asks no other host",
  async () => {
    const install = await failing();
    const { port } = feed.address() as AddressInfo;
    paths = [];
    await offer(install);
    plan.archiveRedirect = `http://localhost:${port}/moved/archive`;
    const refused = await endsFailed(install);
    expect(refused.reason).toMatch(/redirected/);
    expect(paths).not.toContain("/moved/archive");
    expectUnchanged(install, "a redirect to another host");

    // The witness: the same redirect on the address asked is followed, and the
    // archive it leads to is read, as the checksum it fails shows.
    paths = [];
    await offer(install);
    plan.checksums = spoiled(plan.made);
    plan.archiveRedirect = `${origin()}/moved/archive`;
    const followed = await endsFailed(install);
    expect(paths).toContain("/moved/archive");
    expect(followed.reason).toMatch(/does not match the release's checksum/);
    expectUnchanged(install, "a redirect on the address asked");
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "removes the folders an earlier update left beside the programs when an update starts, and leaves a link or a file under such a name",
  async () => {
    const install = await failing();
    const left = join(install.programs, ".marfa-update-0.0.1");
    mkdirSync(left);
    writeFileSync(join(left, "marfa-server"), "half unpacked");
    const elsewhere = tempFolder("marfa-linked-");
    writeFileSync(join(elsewhere, "kept"), "kept");
    symlinkSync(elsewhere, join(install.programs, ".marfa-update-link"));
    writeFileSync(join(install.programs, ".marfa-update-file"), "kept");
    expect(existsSync(left)).toBe(true);

    await offer(install);
    plan.checksums = spoiled(plan.made);
    await endsFailed(install);

    expect(existsSync(left)).toBe(false);
    expect(
      readdirSync(install.programs)
        .filter((name) => name !== LOCK)
        .sort(),
    ).toEqual([
      ".marfa-update-file",
      ".marfa-update-link",
      "marfa",
      "marfa-server",
    ]);
    expect(read(join(elsewhere, "kept")).toString()).toBe("kept");
    expect(read(join(install.programs, ".marfa-update-file")).toString()).toBe(
      "kept",
    );
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "reports the outcome of the later update to a release, not the earlier one's",
  async () => {
    const install = await failing();
    await offer(install);
    plan.checksums = spoiled(plan.made);
    const first = await endsFailed(install);
    expect(first.reason).toMatch(/does not match the release's checksum/);

    await offer(install, { ...GOOD, canOpen: "refuses" });
    const second = await endsFailed(install);
    expect(second.release).toBe(first.release);
    expect(second.reason).toMatch(/will not run on this server's settings/);
    expect(second.reason).not.toBe(first.reason);
    expect(Date.parse(second.finished_at)).toBeGreaterThanOrEqual(
      Date.parse(first.finished_at),
    );
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "answers a second start while an update runs with the update that runs, and starts no second one",
  async () => {
    const install = await failing();
    paths = [];
    await offer(install);
    plan.checksums = spoiled(plan.made);
    const held = holdArchive();
    const before = await started(install.operator);
    const previous =
      (await install.operator.getUpdate()).data.last?.finished_at ?? null;

    const first = await install.operator.startUpdate();
    expect(first.status, JSON.stringify(first.error)).toBe(202);
    await held.asked;
    for (let again = 0; again < 2; again += 1) {
      const second = await install.operator.startUpdate();
      expect(second.status, JSON.stringify(second.error)).toBe(202);
      expect(second.data.progress).toEqual({
        state: "fetching",
        release: RELEASE,
      });
    }
    expect(await started(install.operator)).toBe(before + 1);
    held.release();
    await expect
      .poll(
        async () => {
          const { progress, last } = (await install.operator.getUpdate()).data;
          return progress.state === "idle" && last?.finished_at !== previous;
        },
        { timeout: 60_000, interval: 100 },
      )
      .toBe(true);
    expect(archiveRequests(), "one download for three starts").toBe(1);
    expect(await started(install.operator)).toBe(before + 1);

    // The witness: once it has ended, a start begins an update of its own.
    plan.hold = undefined;
    await endsFailed(install);
    expect(archiveRequests()).toBe(2);
    expect(await started(install.operator)).toBe(before + 2);
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "leaves the programs alone while an earlier update of them has not settled, and says why",
  async () => {
    const install = await installed("updates-swap-unsettled");
    paths = [];
    await offer(install);
    const next = join(install.programs, ".marfa.next");
    writeFileSync(next, "the earlier update's marfa");
    const refused = await endsFailed(install);
    expect(refused.reason).toMatch(/has not settled/);
    expect(read(next).toString()).toBe("the earlier update's marfa");
    expect(paths.filter((path) => path !== "/latest")).toEqual([]);
    for (const name of PROGRAMS) {
      expect(
        read(join(install.programs, name)).equals(install.before[name]),
      ).toBe(true);
    }
    expect(existsSync(join(install.programs, ".marfa-server.previous"))).toBe(
      false,
    );

    // The witness: with the earlier update gone, the same update swaps.
    rmSync(next);
    const begun = await install.operator.startUpdate();
    expect(begun.status, JSON.stringify(begun.error)).toBe(202);
    expect((await install.server.exit()).code).toBe(75);
    expect(
      read(join(install.programs, "marfa-server")).equals(
        plan.made.programs["marfa-server"],
      ),
    ).toBe(true);
  },
  FRESH_SERVER_TIMEOUT_MS,
);

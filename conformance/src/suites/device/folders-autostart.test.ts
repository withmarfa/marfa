import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { keychainEnv } from "../../utils/keychain.js";
import { folderHarness, requireBinary } from "./harness.js";
import type { FolderHarness } from "./harness.js";
import type { HeldCommand } from "../../device/cli-adapter.js";
import { put, scriptFolderWrites, sentTitles } from "./folders.shared.js";

/**
 * Folder syncing from login. No fixture installs a real login agent or
 * touches the person's launchd or systemd: `MARFA_AUTOSTART_ROOT` names a
 * directory that stands in for the home directory, and the `launchctl` or
 * `systemctl` in its `bin` is a fake that keeps its state in a file there,
 * and starts the watch the agent describes as the real one would, so the
 * agent the command writes is run for real.
 */

const LABEL = "so.marfa.folder-watch";
const UNIT = "marfa-folder-watch.service";
const MEBIBYTE = 1024 * 1024;
const WAIT = { timeout: 30_000, interval: 100 };

const roots: string[] = [];
const made: FolderHarness[] = [];
const held: HeldCommand[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const command of held.splice(0)) await command.stop();
  for (const root of roots.splice(0)) {
    const pid = managerState(root).pid;
    if (pid !== null && alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
  for (const harness of made.splice(0).reverse()) await harness.stop();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * Stands in for `launchctl` and `systemctl --user`. It answers the verbs
 * the command uses as the real tools do, including their refusals of a load
 * twice and an unload of nothing, and starts the watch with the agent's own
 * arguments and environment, adding only what a login session gives every
 * process: `HOME`, `PATH`, `TMPDIR`, and the run's keychain file in place of
 * the person's keychain. CommonJS, which every Node runs from a file with no
 * extension.
 *
 * A file named `broken` in the stand-in home makes every call fail, as with
 * no user bus; one named `fail-once` makes the next call of the verb it
 * holds fail, once.
 */
const FAKE_MANAGER = String.raw`#!/usr/bin/env node
const { readFileSync, writeFileSync, existsSync, openSync, closeSync } = require("node:fs");
const { spawn, execFileSync } = require("node:child_process");
const { basename, dirname, join } = require("node:path");

const root = dirname(dirname(process.argv[1]));
const tool = basename(process.argv[1]);
const statePath = join(root, "manager.json");
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { loaded: false, pid: null, enabled: false, calls: [] };
let args = process.argv.slice(2);
state.calls.push(args.join(" "));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const fail = (code, message) => { save(); process.stderr.write(message + "\n"); process.exit(code); };
if (existsSync(join(root, "broken"))) fail(1, "Failed to connect to bus: No medium found");
const failOnce = (verb) => {
  const knob = join(root, "fail-once");
  if (existsSync(knob) && readFileSync(knob, "utf8").trim() === verb) {
    require("node:fs").rmSync(knob);
    fail(1, verb + " failed, as the fixture asked");
  }
};
// launchd opens the files a job names for its output as the job starts, and
// fails the job where it cannot. A file that is not there is made.
const start = (argv, env, output) => {
  const out = output ? [openSync(output.stdout, "a"), openSync(output.stderr, "a")] : ["ignore", "ignore"];
  const session = { HOME: root, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? "/tmp" };
  if (process.env.MARFA_KEYCHAIN) session.MARFA_KEYCHAIN = process.env.MARFA_KEYCHAIN;
  const child = spawn(argv[0], argv.slice(1), {
    detached: true,
    stdio: ["ignore", ...out],
    env: { ...session, ...env },
  });
  for (const fd of out) if (typeof fd === "number") closeSync(fd);
  child.unref();
  state.pid = child.pid;
  state.started = argv;
  state.environment = env;
};
const stop = () => {
  if (alive(state.pid)) {
    process.kill(state.pid, "SIGTERM");
    for (let i = 0; i < 100 && alive(state.pid); i++) sleep(50);
  }
  state.pid = null;
};

if (tool === "launchctl") {
  const [verb, target, path] = args;
  failOnce(verb);
  if (verb === "print") {
    if (!state.loaded) fail(113, 'Could not find service "' + target + '" in domain for user gui');
    const running = alive(state.pid);
    process.stdout.write(target + " = {\n\tstate = " + (running ? "running" : "not running") + "\n" +
      (running ? "\tpid = " + state.pid + "\n" : "") + "}\n");
  } else if (verb === "enable") {
    state.enabled = true;
  } else if (verb === "bootstrap") {
    if (state.loaded) fail(5, "Bootstrap failed: 5: Input/output error");
    const agent = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }));
    state.loaded = true;
    if (agent.RunAtLoad) start(agent.ProgramArguments, agent.EnvironmentVariables ?? {}, agent.StandardOutPath ? { stdout: agent.StandardOutPath, stderr: agent.StandardErrorPath } : undefined);
  } else if (verb === "bootout") {
    if (!state.loaded) fail(3, "Boot-out failed: 3: No such process");
    stop();
    state.loaded = false;
  } else {
    fail(64, "the fake launchctl does not answer " + args.join(" "));
  }
} else {
  if (args[0] !== "--user") fail(1, "the fake systemctl answers only --user");
  args = args.slice(1);
  const unitPath = join(root, ".config", "systemd", "user", "${UNIT}");
  const words = (line) => {
    const out = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === " ") { i++; continue; }
      if (line[i] !== '"') fail(1, "unquoted word in " + line);
      i++;
      let word = "";
      for (;;) {
        const c = line[i++];
        if (c === undefined) fail(1, "unterminated word in " + line);
        if (c === '"') break;
        if (c === "\\") { word += line[i++]; continue; }
        if ((c === "%" || c === "$") && line[i] === c) { word += c; i++; continue; }
        word += c;
      }
      out.push(word);
    }
    return out;
  };
  // systemd runs the unit as it read it at the last daemon-reload.
  const definition = () => {
    const text = state.unit ?? readFileSync(unitPath, "utf8");
    const exec = words(text.match(/^ExecStart=(.*)$/m)[1]);
    const env = Object.fromEntries(
      words(text.match(/^Environment=(.*)$/m)[1]).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
    );
    return { exec, env };
  };
  const startUnit = () => { const unit = definition(); start(unit.exec, unit.env); };
  const now = args.includes("--now");
  const [verb] = args.filter((arg) => arg !== "--now");
  failOnce(verb);
  if (verb === "daemon-reload") {
    state.loaded = existsSync(unitPath);
    state.unit = state.loaded ? readFileSync(unitPath, "utf8") : null;
  } else if (verb === "enable") {
    if (!existsSync(unitPath)) fail(1, "Failed to enable unit: Unit file ${UNIT} does not exist.");
    state.enabled = true;
    if (now && !alive(state.pid)) startUnit();
  } else if (verb === "disable") {
    state.enabled = false;
    if (now) stop();
  } else if (verb === "start") {
    if (!alive(state.pid)) startUnit();
  } else if (verb === "restart") {
    stop();
    startUnit();
  } else if (verb === "stop") {
    stop();
  } else if (verb === "show") {
    const running = alive(state.pid);
    process.stdout.write(
      "LoadState=" + (existsSync(unitPath) ? "loaded" : "not-found") + "\n" +
      "ActiveState=" + (running ? "active" : "inactive") + "\n" +
      "SubState=" + (running ? "running" : "dead") + "\n" +
      "MainPID=" + (running ? state.pid : 0) + "\n" +
      "ExecMainStatus=0\n" +
      "NeedDaemonReload=" + (existsSync(unitPath) && state.unit != null && state.unit !== readFileSync(unitPath, "utf8") ? "yes" : "no") + "\n" +
      "UnitFileState=" + (state.enabled ? "enabled" : "disabled") + "\n");
  } else {
    fail(64, "the fake systemctl does not answer " + args.join(" "));
  }
}
save();
`;

interface ManagerState {
  loaded: boolean;
  pid: number | null;
  enabled: boolean;
  calls: string[];
  started?: string[];
  environment?: Record<string, string>;
}

/** A stand-in home with its fake service manager. */
function standIn(label: string): string {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), `marfa-autostart-${label}-`),
  );
  roots.push(root);
  mkdirSync(join(root, "bin"));
  for (const tool of ["launchctl", "systemctl"]) {
    writeFileSync(join(root, "bin", tool), FAKE_MANAGER);
    chmodSync(join(root, "bin", tool), 0o755);
  }
  return root;
}

function managerState(root: string): ManagerState {
  const path = join(root, "manager.json");
  if (!existsSync(path)) {
    return { loaded: false, pid: null, enabled: false, calls: [] };
  }
  return JSON.parse(readFileSync(path, "utf8")) as ManagerState;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const macOS = process.platform === "darwin";

/** Where the command writes the agent below a stand-in home. */
function agentFile(root: string): string {
  return macOS
    ? join(root, "Library", "LaunchAgents", `${LABEL}.plist`)
    : join(root, ".config", "systemd", "user", UNIT);
}

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** `folders autostart <verb>` against a stand-in home. */
function autostart(
  root: string,
  verb: "on" | "off" | "status",
  options: {
    registry: string;
    binary?: string;
    env?: NodeJS.ProcessEnv;
    json?: boolean;
    args?: string[];
  },
): Ran {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...keychainEnv(),
    MARFA_AUTOSTART_ROOT: root,
    MARFA_FOLDER_REGISTRY: options.registry,
  };
  delete env.MARFA_API_URL;
  delete env.MARFA_API_KEY;
  Object.assign(env, options.env ?? {});
  const ran = spawnSync(
    options.binary ?? requireBinary(),
    [
      ...(options.json === false ? [] : ["--json"]),
      "folders",
      "autostart",
      verb,
      ...(options.args ?? []),
    ],
    { env, encoding: "utf8", timeout: 60_000 },
  );
  if (ran.error !== undefined) throw ran.error;
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

function parsed<T>(ran: Ran): T {
  expect(ran.status, ran.stderr).toBe(0);
  return JSON.parse(ran.stdout) as T;
}

interface Switched {
  autostart: "on" | "off";
  changed: boolean;
  manager: "launchd" | "systemd";
  name: string;
  file: string;
  binary?: string;
  log?: string;
  registry?: string;
  key_file?: string;
  running?: boolean | null;
}

interface Status {
  installed: boolean;
  manager: string;
  name: string;
  file: string;
  loaded?: boolean;
  running?: boolean;
  pid?: number | null;
  manager_error?: string;
  outdated: boolean;
  binary: { path: string; exists: boolean; this_binary: boolean } | null;
  log: string | null;
  launchd_log: string | null;
  registry: string | null;
  key_file: string | null;
  record: {
    path: string;
    current: boolean;
    folders: Array<{ dir: string; watching: boolean; reason: string | null }>;
  } | null;
  credential: string[];
}

/** What the agent runs, read from the file as its service manager reads it. */
function agentRuns(root: string): {
  argv: string[];
  env: Record<string, string>;
} {
  const file = agentFile(root);
  if (macOS) {
    const agent = JSON.parse(
      execFileSync("plutil", ["-convert", "json", "-o", "-", file], {
        encoding: "utf8",
      }),
    ) as {
      ProgramArguments: string[];
      EnvironmentVariables: Record<string, string>;
    };
    return { argv: agent.ProgramArguments, env: agent.EnvironmentVariables };
  }
  // The fake reads the unit as systemd does and records what it started.
  const state = managerState(root);
  return { argv: state.started ?? [], env: state.environment ?? {} };
}

function registryOf(root: string): string {
  return join(root, "data", "folders.json");
}

describe("folder syncing from login", () => {
  it("writes an agent in the person's account that runs the watch of every folder by this binary's path, holding no credential, and starts it", async () => {
    const root = standIn("on");
    const registry = registryOf(root);
    const binary = requireBinary();
    const secret = `device-fixture-secret-${randomUUID()}`;
    const ran = autostart(root, "on", {
      registry,
      env: {
        MARFA_API_KEY: secret,
        MARFA_API_URL: "http://127.0.0.1:9/never",
      },
    });
    const report = parsed<Switched>(ran);
    const log = join(dirname(registry), "folder-watch.log");
    const launchdLog = join(dirname(registry), "folder-watch.launchd.log");
    expect(report).toMatchObject({
      autostart: "on",
      changed: true,
      manager: macOS ? "launchd" : "systemd",
      name: macOS ? LABEL : UNIT,
      file: agentFile(root),
      binary,
      log,
      registry,
    });
    expect(report.launchd_log).toBe(macOS ? launchdLog : undefined);
    expect(existsSync(agentFile(root))).toBe(true);
    // Written only below the stand-in home, never writable by others.
    expect(statSync(agentFile(root)).mode & 0o022).toBe(0);

    const written = readFileSync(agentFile(root), "utf8");
    if (macOS) {
      execFileSync("plutil", ["-lint", agentFile(root)]);
      const agent = JSON.parse(
        execFileSync(
          "plutil",
          ["-convert", "json", "-o", "-", agentFile(root)],
          {
            encoding: "utf8",
          },
        ),
      ) as Record<string, unknown>;
      expect(agent).toEqual({
        Label: LABEL,
        ProgramArguments: [binary, "folders", "watch", "--log", log],
        EnvironmentVariables: { MARFA_FOLDER_REGISTRY: registry },
        RunAtLoad: true,
        KeepAlive: { SuccessfulExit: false },
        ThrottleInterval: 30,
        Nice: 10,
        LowPriorityIO: true,
        StandardOutPath: launchdLog,
        StandardErrorPath: launchdLog,
      });
      // Made by the command, for its owner alone, before launchd could make it.
      expect(statSync(launchdLog).mode & 0o077).toBe(0);
      expect(
        managerState(root).calls.filter((call) => !call.startsWith("print")),
      ).toEqual([
        `enable gui/${process.getuid?.()}/${LABEL}`,
        `bootstrap gui/${process.getuid?.()} ${agentFile(root)}`,
      ]);
    } else {
      expect(written).toContain("\nRestart=on-failure\n");
      expect(written).toContain("\nRestartSec=30\n");
      expect(written).toContain("\nNice=10\n");
      expect(written).toContain("\nIOSchedulingClass=best-effort\n");
      expect(written).toContain("\nIOSchedulingPriority=7\n");
      expect(written).toContain("\n[Install]\nWantedBy=default.target\n");
      // The journal keeps a user unit's standard output and error, so the
      // unit names no file for them.
      expect(written).not.toContain("StandardOutput");
      expect(written).not.toContain("StandardError");
      expect(existsSync(launchdLog)).toBe(false);
      expect(
        managerState(root).calls.filter(
          (call) => !call.startsWith("--user show"),
        ),
      ).toEqual([
        "--user daemon-reload",
        `--user enable ${UNIT}`,
        `--user restart ${UNIT}`,
      ]);
    }
    const runs = agentRuns(root);
    expect(runs.argv).toEqual([binary, "folders", "watch", "--log", log]);
    expect(runs.env).toEqual({ MARFA_FOLDER_REGISTRY: registry });
    // The command's own credential and server were set, and none reached the file.
    for (const carried of [
      secret,
      "MARFA_API_KEY",
      "MARFA_API_URL",
      "MARFA_KEYCHAIN",
      "127.0.0.1:9",
      "--url",
      "--key",
    ]) {
      expect(written, carried).not.toContain(carried);
    }
    // The witness: what the command resolved does reach the file.
    expect(written).toContain(registry);

    // The agent's watch runs, and writes its output to the log.
    const pid = managerState(root).pid;
    expect(pid).not.toBeNull();
    await vi.waitFor(() => {
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toContain(
        "watching every folder",
      );
    }, WAIT);
    expect(alive(pid!)).toBe(true);
    expect(report.running).toBe(true);
  });

  it.runIf(process.platform === "darwin")(
    "keeps an error the watch makes before it opens its log in the file launchd was given beside the log",
    async () => {
      const root = standIn("launchd-output");
      const registry = registryOf(root);
      const log = join(dirname(registry), "folder-watch.log");
      const launchdLog = join(dirname(registry), "folder-watch.launchd.log");
      // A directory where the log should be: the watch cannot open it.
      mkdirSync(log, { recursive: true });
      parsed<Switched>(autostart(root, "on", { registry }));
      expect(statSync(launchdLog).mode & 0o077).toBe(0);
      await vi.waitFor(() => {
        expect(readLog(launchdLog)).toMatch(/directory/i);
      }, WAIT);
      // The witness: with the log a file, the same agent writes there instead.
      rmSync(log, { recursive: true });
      const size = statSync(launchdLog).size;
      stopAgent(root);
      parsed<Switched>(autostart(root, "off", { registry }));
      parsed<Switched>(autostart(root, "on", { registry }));
      await vi.waitFor(() => {
        expect(readLog(log)).toContain("watching every folder");
      }, WAIT);
      expect(statSync(launchdLog).size).toBe(size);
    },
  );

  it("changes nothing when turned on again, and off removes the agent and stops its watch, twice over", async () => {
    const root = standIn("twice");
    const registry = registryOf(root);
    expect(parsed<Switched>(autostart(root, "on", { registry })).changed).toBe(
      true,
    );
    const before = readFileSync(agentFile(root), "utf8");
    const modified = statSync(agentFile(root)).mtimeMs;
    const pid = managerState(root).pid!;
    const callsBefore = managerState(root).calls.length;

    const again = parsed<Switched>(autostart(root, "on", { registry }));
    expect(again).toMatchObject({
      autostart: "on",
      changed: false,
      running: true,
    });
    expect(readFileSync(agentFile(root), "utf8")).toBe(before);
    expect(statSync(agentFile(root)).mtimeMs).toBe(modified);
    expect(managerState(root).pid).toBe(pid);
    const loads = managerState(root)
      .calls.slice(callsBefore)
      .filter((call) => /bootstrap|bootout|daemon-reload|restart/.test(call));
    expect(loads, "a second on loaded the agent again").toEqual([]);

    const off = parsed<Switched>(autostart(root, "off", { registry }));
    expect(off).toMatchObject({
      autostart: "off",
      changed: true,
      file: agentFile(root),
    });
    expect(existsSync(agentFile(root))).toBe(false);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), WAIT);

    const callsAfterOff = managerState(root).calls.length;
    const offAgain = parsed<Switched>(autostart(root, "off", { registry }));
    expect(offAgain).toMatchObject({ autostart: "off", changed: false });
    expect(
      managerState(root)
        .calls.slice(callsAfterOff)
        .filter((call) => /bootout|disable|stop/.test(call)),
      "a second off unloaded something",
    ).toEqual([]);

    const status = parsed<Status>(autostart(root, "status", { registry }));
    expect(status).toMatchObject({
      installed: false,
      running: false,
      binary: null,
      record: null,
    });
  });

  it("says when the agent was written by an earlier marfa, and on replaces it", () => {
    const root = standIn("earlier");
    const registry = registryOf(root);
    autostart(root, "on", { registry });
    const current = readFileSync(agentFile(root), "utf8");
    expect(
      parsed<Status>(autostart(root, "status", { registry })).outdated,
    ).toBe(false);
    expect(
      autostart(root, "status", { registry, json: false }).stdout,
    ).not.toContain("earlier marfa");

    const earlier = macOS
      ? current.replace(
          "\t<key>Nice</key>\n\t<integer>10</integer>\n\t<key>LowPriorityIO</key>\n\t<true/>\n",
          "\t<key>ProcessType</key>\n\t<string>Background</string>\n",
        )
      : current.replace(
          "Nice=10\nIOSchedulingClass=best-effort\nIOSchedulingPriority=7\n",
          "",
        );
    expect(earlier).not.toBe(current);
    writeFileSync(agentFile(root), earlier);

    const status = parsed<Status>(autostart(root, "status", { registry }));
    expect(status).toMatchObject({ installed: true, outdated: true });
    // Still read as the agent it is, not as a file marfa did not write.
    expect(status.binary).toMatchObject({ path: requireBinary() });
    expect(status.log).toBe(join(dirname(registry), "folder-watch.log"));
    const said = autostart(root, "status", { registry, json: false }).stdout;
    expect(said).toContain(
      "was written by an earlier marfa and differs from what `marfa folders autostart on` writes now; run `marfa folders autostart on` again with the same options to replace it",
    );

    expect(parsed<Switched>(autostart(root, "on", { registry })).changed).toBe(
      true,
    );
    expect(readFileSync(agentFile(root), "utf8")).toBe(current);
    expect(
      parsed<Status>(autostart(root, "status", { registry })).outdated,
    ).toBe(false);
  });

  it("refuses --url, --key and --profile, and writes nothing", () => {
    const root = standIn("flags");
    const registry = registryOf(root);
    for (const flags of [
      ["--url", "http://127.0.0.1:9"],
      ["--key", "device-fixture-key"],
      ["--profile", "demo"],
    ]) {
      const ran = spawnSync(
        requireBinary(),
        ["--json", ...flags, "folders", "autostart", "on"],
        {
          env: {
            ...process.env,
            ...keychainEnv(),
            MARFA_AUTOSTART_ROOT: root,
            MARFA_FOLDER_REGISTRY: registry,
          },
          encoding: "utf8",
        },
      );
      expect(ran.status, ran.stderr).toBe(2);
      expect(JSON.parse(ran.stderr).error.code).toBe("usage");
    }
    expect(existsSync(agentFile(root))).toBe(false);
    expect(managerState(root).calls).toEqual([]);
    // The witness: the same command with none of the flags writes the agent.
    expect(autostart(root, "on", { registry }).status).toBe(0);
    expect(existsSync(agentFile(root))).toBe(true);
  });

  it("says when the binary the agent runs is not this one or is gone, and on replaces the agent with this binary", async () => {
    const root = standIn("binary");
    const registry = registryOf(root);
    const other = join(root, "elsewhere", "marfa");
    mkdirSync(dirname(other));
    copyFileSync(requireBinary(), other);
    chmodSync(other, 0o755);
    expect(
      parsed<Switched>(autostart(root, "on", { registry, binary: other }))
        .binary,
    ).toBe(other);
    const firstPid = managerState(root).pid!;

    const differs = parsed<Status>(autostart(root, "status", { registry }));
    expect(differs.binary).toEqual({
      path: other,
      exists: true,
      this_binary: false,
    });
    const sameStatus = parsed<Status>(
      autostart(root, "status", { registry, binary: other }),
    );
    expect(sameStatus.binary?.this_binary).toBe(true);
    const text = autostart(root, "status", { registry, json: false });
    expect(text.stdout).toContain(`it runs ${other}, which is not this marfa`);

    // A binary removed, as an upgrade that moved it does.
    stopAgent(root);
    rmSync(other);
    const gone = parsed<Status>(autostart(root, "status", { registry }));
    expect(gone.binary).toEqual({
      path: other,
      exists: false,
      this_binary: false,
    });
    expect(
      autostart(root, "status", { registry, json: false }).stdout,
    ).toContain(`it runs ${other}, which no longer exists`);

    const callsBefore = managerState(root).calls.length;
    const replaced = parsed<Switched>(autostart(root, "on", { registry }));
    expect(replaced).toMatchObject({ changed: true, binary: requireBinary() });
    expect(agentRuns(root).argv[0]).toBe(requireBinary());
    const calls = managerState(root).calls.slice(callsBefore);
    expect(
      calls
        .filter((call) => /bootout|bootstrap|daemon-reload|restart/.test(call))
        .map((call) => call.split(" ")[macOS ? 0 : 1]),
    ).toEqual(macOS ? ["bootout", "bootstrap"] : ["daemon-reload", "restart"]);
    expect(managerState(root).pid).not.toBe(firstPid);
    const now = parsed<Status>(autostart(root, "status", { registry }));
    expect(now.binary).toEqual({
      path: requireBinary(),
      exists: true,
      this_binary: true,
    });
  });

  it("starts the agent it wrote after a swap that failed, rather than saying it is unchanged", async () => {
    const root = standIn("swap");
    const registry = registryOf(root);
    const other = join(root, "elsewhere", "marfa");
    mkdirSync(dirname(other));
    copyFileSync(requireBinary(), other);
    chmodSync(other, 0o755);
    parsed<Switched>(autostart(root, "on", { registry, binary: other }));
    expect(managerState(root).started?.[0]).toBe(other);
    // The old agent cannot be let go of, so the new one is not loaded.
    writeFileSync(join(root, "fail-once"), macOS ? "bootout" : "daemon-reload");
    const failed = autostart(root, "on", { registry });
    expect(failed.status, failed.stdout).not.toBe(0);
    expect(managerState(root).started?.[0]).toBe(other);

    const again = parsed<Switched>(autostart(root, "on", { registry }));
    expect(again.changed).toBe(true);
    expect(managerState(root).started?.[0]).toBe(requireBinary());
    expect(alive(managerState(root).pid!)).toBe(true);
  });

  it("records the binary by the path it was run as, through a link", () => {
    const root = standIn("link");
    const registry = registryOf(root);
    const link = join(root, "links", "marfa");
    mkdirSync(dirname(link));
    symlinkSync(requireBinary(), link);
    const on = parsed<Switched>(
      autostart(root, "on", { registry, binary: link }),
    );
    expect(on.binary).toBe(link);
    expect(agentRuns(root).argv[0]).toBe(link);
    // The witness: the link leads to the binary, which status takes as this one.
    const status = parsed<Status>(autostart(root, "status", { registry }));
    expect(status.binary).toEqual({
      path: link,
      exists: true,
      this_binary: true,
    });
  });

  it("removes the agent it wrote though the service manager cannot be asked, and says what it could not do", () => {
    const root = standIn("broken");
    const registry = registryOf(root);
    parsed<Switched>(autostart(root, "on", { registry }));
    expect(existsSync(agentFile(root))).toBe(true);
    writeFileSync(join(root, "broken"), "");
    const off = autostart(root, "off", { registry, json: false });
    expect(off.status).toBe(3);
    expect(off.stderr).toContain(`removed ${agentFile(root)}`);
    expect(off.stderr).toContain("could not stop");
    expect(existsSync(agentFile(root))).toBe(false);
  });

  it("says whether the watch runs, where it logs, and from the record which folders it has no credential for, with no server or credential of its own", async () => {
    const harness = await folderHarness("autostart-status");
    made.push(harness);
    const root = standIn("status");
    const registry = harness.registry;
    // The login session's keychain is one the watch cannot read: a file that
    // is not there, in a directory the credential locks beside it can use.
    const NO_KEYCHAIN = join(root, "none.keychain-db");
    // Folders deleted long ago, still listed.
    const gone = [1, 2, 3].map((n) => join(root, `run-${n}`, "notes"));
    const listing = JSON.parse(readFileSync(registry, "utf8")) as {
      folders: Array<Record<string, unknown>>;
    };
    listing.folders.push(...gone.map((dir) => ({ dir, folder: randomUUID() })));
    writeFileSync(registry, JSON.stringify(listing));
    const on = parsed<Switched>(
      autostart(root, "on", { registry, env: { MARFA_KEYCHAIN: NO_KEYCHAIN } }),
    );
    expect(on.running).toBe(true);
    const pid = managerState(root).pid!;

    let status: Status | undefined;
    await vi.waitFor(() => {
      status = parsed<Status>(
        autostart(root, "status", {
          registry,
          env: { MARFA_KEYCHAIN: NO_KEYCHAIN },
        }),
      );
      expect(status.record?.current).toBe(true);
      // A keychain file that is not there holds no credential; a platform
      // with no keychain files has no keychain.
      expect(["no_credential", "no_keychain"]).toContain(
        status.record?.folders.find((folder) => folder.dir === harness.dir)
          ?.reason,
      );
    }, WAIT);
    expect(status).toMatchObject({
      installed: true,
      file: agentFile(root),
      loaded: true,
      running: true,
      pid,
      log: join(dirname(registry), "folder-watch.log"),
      launchd_log: macOS
        ? join(dirname(registry), "folder-watch.launchd.log")
        : null,
      registry,
      credential: [harness.dir],
    });
    expect(status!.record?.path).toBe(
      join(dirname(registry), "folder-watch.json"),
    );
    expect(status!.binary).toEqual({
      path: requireBinary(),
      exists: true,
      this_binary: true,
    });

    const text = autostart(root, "status", {
      registry,
      json: false,
      env: { MARFA_KEYCHAIN: NO_KEYCHAIN },
    });
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain(`the watch is running, as process ${pid}`);
    expect(text.stdout).toContain(
      `it logs to ${join(dirname(registry), "folder-watch.log")}`,
    );
    // The line is launchd's alone: a systemd unit's journal keeps that output.
    expect(text.stdout.includes("before it opens that log")).toBe(macOS);
    if (macOS) {
      expect(text.stdout).toContain(
        `what it prints before it opens that log goes to ${join(dirname(registry), "folder-watch.launchd.log")}`,
      );
    }
    const reason = status!.record!.folders.find(
      (folder) => folder.dir === harness.dir,
    )!.reason;
    expect(text.stdout).toContain(
      `${harness.dir}: not watched (${reason}): the watch has no credential it can use for this folder's server`,
    );
    // The folders that cannot be found are said in one line, with what to do.
    for (const dir of gone) {
      expect(
        status!.record?.folders.find((folder) => folder.dir === dir)?.reason,
      ).toBe("missing");
      expect(text.stdout).not.toContain(`${dir}: not watched`);
    }
    expect(
      text.stdout
        .split("\n")
        .filter((line) => line.includes("cannot be found")),
    ).toEqual([
      "3 listed folder(s) cannot be found, so they are not watched; `marfa folders list` shows them, and `marfa folders remove DIR` takes one off the list",
    ]);
    // The log says the same as the record.
    expect(
      readFileSync(join(dirname(registry), "folder-watch.log"), "utf8"),
    ).toContain(harness.dir);
  });

  /** A key file below the stand-in home, readable by its owner alone. */
  function keyFile(root: string, url: string, key: string, mode = 0o600) {
    const path = join(root, "keys", "watch.env");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `MARFA_API_URL=${url}\nMARFA_API_KEY=${key}\n`);
    chmodSync(path, mode);
    return path;
  }

  it("writes the path of a key file into the agent and nothing from it, and says so in the status", () => {
    const root = standIn("keyfile");
    const registry = registryOf(root);
    const binary = requireBinary();
    const secret = `device-fixture-secret-${randomUUID()}`;
    const path = keyFile(root, "http://127.0.0.1:9/never", secret);
    const report = parsed<Switched>(
      autostart(root, "on", { registry, args: ["--key-file", path] }),
    );
    expect(report.key_file).toBe(path);
    const log = join(dirname(registry), "folder-watch.log");
    expect(agentRuns(root).argv).toEqual([
      binary,
      "folders",
      "watch",
      "--key-file",
      path,
      "--log",
      log,
    ]);
    const written = readFileSync(agentFile(root), "utf8");
    for (const carried of [
      secret,
      "MARFA_API_KEY",
      "MARFA_API_URL",
      "127.0.0.1:9",
    ]) {
      expect(written, carried).not.toContain(carried);
    }
    // The witness: the path does reach the file.
    expect(written).toContain(path);
    const status = parsed<Status>(autostart(root, "status", { registry }));
    expect(status.key_file).toBe(path);
    // Turned on again as it was, nothing changes; without the option, the
    // keychain is used again and the agent is replaced.
    expect(
      parsed<Switched>(
        autostart(root, "on", { registry, args: ["--key-file", path] }),
      ).changed,
    ).toBe(false);
    const back = parsed<Switched>(autostart(root, "on", { registry }));
    expect(back.changed).toBe(true);
    expect(back.key_file).toBeUndefined();
    expect(agentRuns(root).argv).not.toContain("--key-file");
    expect(
      parsed<Status>(autostart(root, "status", { registry })).key_file,
    ).toBe(null);
  });

  it("refuses a key file that others can read, a link, one that lacks a name and one inside a folder, naming the reason and writing nothing", () => {
    const root = standIn("keyfile-refused");
    const registry = registryOf(root);
    const secret = `device-fixture-secret-${randomUUID()}`;
    const refused = (path: string, reason: string) => {
      const ran = autostart(root, "on", {
        registry,
        args: ["--key-file", path],
      });
      expect(ran.status, ran.stdout).toBe(1);
      expect(ran.stdout).toBe("");
      const envelope = JSON.parse(ran.stderr) as {
        error: { code: string; message: string };
      };
      expect(envelope.error.code).toBe("invalid");
      expect(envelope.error.message).toContain(reason);
      expect(ran.stderr).not.toContain(secret);
      expect(existsSync(agentFile(root))).toBe(false);
    };
    const open = keyFile(root, "http://127.0.0.1:9", secret, 0o644);
    refused(open, "can be read by others");
    chmodSync(open, 0o600);
    const link = join(root, "keys", "link.env");
    symlinkSync(open, link);
    refused(link, "is a link");
    refused(join(root, "keys", "absent.env"), "does not exist");
    const bare = join(root, "keys", "bare.env");
    writeFileSync(bare, "MARFA_API_URL=http://127.0.0.1:9\n");
    chmodSync(bare, 0o600);
    refused(bare, "has no MARFA_API_KEY line");
    // A key file inside a listed folder would be sent to the server.
    const folder = join(root, "notes");
    mkdirSync(folder, { recursive: true });
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(
      registry,
      JSON.stringify({ folders: [{ dir: folder, folder: randomUUID() }] }),
    );
    const inside = join(folder, "watch.env");
    writeFileSync(
      inside,
      `MARFA_API_URL=http://127.0.0.1:9\nMARFA_API_KEY=${secret}\n`,
    );
    chmodSync(inside, 0o600);
    refused(inside, "lies inside the folder");
    // `folders watch --key-file` refuses the same files, and ends.
    const watched = spawnSync(
      requireBinary(),
      ["--json", "folders", "watch", "--key-file", open, "--for", "1"],
      {
        env: {
          ...process.env,
          ...keychainEnv(),
          MARFA_FOLDER_REGISTRY: registry,
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(watched.status, watched.stderr).toBe(0);
    chmodSync(open, 0o644);
    const loose = spawnSync(
      requireBinary(),
      ["--json", "folders", "watch", "--key-file", open, "--for", "1"],
      {
        env: {
          ...process.env,
          ...keychainEnv(),
          MARFA_FOLDER_REGISTRY: registry,
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(loose.status, loose.stderr).toBe(1);
    expect(JSON.parse(loose.stderr).error.code).toBe("invalid");
    expect(loose.stderr).not.toContain(secret);
    chmodSync(open, 0o600);
    // The witness: a file that is fine is taken.
    const fine = parsed<Switched>(
      autostart(root, "on", { registry, args: ["--key-file", open] }),
    );
    expect(fine.key_file).toBe(open);
  });

  it("keeps a folder in step from the agent with the key file", async () => {
    const harness = await folderHarness("autostart-keyfile");
    made.push(harness);
    scriptFolderWrites(harness);
    const root = standIn("keyfile-sync");
    const kept = "device-fixture-key-from-a-file";
    const path = keyFile(root, harness.server.url, kept);
    const from = harness.server.requests.length;
    parsed<Switched>(
      autostart(root, "on", {
        registry: harness.registry,
        // A keychain that holds nothing and cannot be asked: the watch gets
        // its key from the file or has none.
        env: { MARFA_KEYCHAIN: join(root, "none.keychain-db") },
        args: ["--key-file", path],
      }),
    );
    put(
      harness,
      "From a file.md",
      "---\ntitle: From a file\n---\nno keychain asked\n",
    );
    await vi.waitFor(
      () => expect(sentTitles(harness)).toEqual(["From a file"]),
      WAIT,
    );
    const sent = harness.server.requests
      .slice(from)
      .map((request) => request.headers.authorization)
      .filter((header) => header !== undefined);
    expect(sent).toContain(`Bearer ${kept}`);
    expect(sent.filter((header) => header !== `Bearer ${kept}`)).toEqual([]);
  });

  it("reads the key file again when it opens a folder, and holds a folder back while the file is unsafe", async () => {
    const harness = await folderHarness("autostart-keyfile-reread");
    made.push(harness);
    scriptFolderWrites(harness);
    const root = standIn("keyfile-reread");
    const first = "device-fixture-key-before-rotation";
    const second = "device-fixture-key-after-rotation";
    const path = keyFile(root, harness.server.url, first);
    // The folder's directory is away when the watch starts, so it is opened
    // later, after the file has changed.
    renameSync(harness.dir, `${harness.dir}-away`);
    const from = harness.server.requests.length;
    parsed<Switched>(
      autostart(root, "on", {
        registry: harness.registry,
        env: { MARFA_KEYCHAIN: join(root, "none.keychain-db") },
        args: ["--key-file", path],
      }),
    );
    const reason = () =>
      parsed<Status>(
        autostart(root, "status", { registry: harness.registry }),
      ).record?.folders.find((folder) => folder.dir === harness.dir)?.reason;
    await vi.waitFor(() => expect(reason()).toBe("missing"), WAIT);
    // Rotated, and unsafe: the folder is held back with the reason.
    keyFile(root, harness.server.url, second, 0o644);
    renameSync(`${harness.dir}-away`, harness.dir);
    await vi.waitFor(() => expect(reason()).toBe("invalid"), {
      ...WAIT,
      timeout: 90_000,
    });
    // Safe again: the folder is taken up with the rotated key.
    chmodSync(path, 0o600);
    await vi.waitFor(
      () => {
        const folder = parsed<Status>(
          autostart(root, "status", { registry: harness.registry }),
        ).record?.folders.find((entry) => entry.dir === harness.dir);
        expect(folder?.watching).toBe(true);
      },
      { ...WAIT, timeout: 90_000 },
    );
    put(
      harness,
      "Rotated.md",
      "---\ntitle: Rotated\n---\nthe new key is used\n",
    );
    await vi.waitFor(
      () => expect(sentTitles(harness)).toEqual(["Rotated"]),
      WAIT,
    );
    const sent = harness.server.requests
      .slice(from)
      .map((request) => request.headers.authorization)
      .filter((header) => header !== undefined);
    expect(sent).toContain(`Bearer ${second}`);
    expect(sent).not.toContain(`Bearer ${first}`);
  }, 240_000);

  it("does not send a key file's key to a folder of another server", async () => {
    const harness = await folderHarness("autostart-keyfile-other");
    made.push(harness);
    scriptFolderWrites(harness);
    const root = standIn("keyfile-other");
    const kept = "device-fixture-key-for-another-server";
    const path = keyFile(root, "http://127.0.0.1:9", kept);
    const from = harness.server.requests.length;
    parsed<Switched>(
      autostart(root, "on", {
        registry: harness.registry,
        env: { MARFA_KEYCHAIN: join(root, "none.keychain-db") },
        args: ["--key-file", path],
      }),
    );
    await vi.waitFor(() => {
      const status = parsed<Status>(
        autostart(root, "status", { registry: harness.registry }),
      );
      expect(status.record?.current).toBe(true);
      expect(["no_credential", "no_keychain"]).toContain(
        status.record?.folders.find((folder) => folder.dir === harness.dir)
          ?.reason,
      );
    }, WAIT);
    const sent = harness.server.requests
      .slice(from)
      .map((request) => request.headers.authorization)
      .filter((header) => header !== undefined);
    expect(sent).not.toContain(`Bearer ${kept}`);
  });

  describe.runIf(process.platform === "darwin")(
    "a credential the keychain keeps",
    () => {
      it("reads the keychain for no folder with a key file, though it keeps a credential for the folder's server", async () => {
        const harness = await folderHarness("autostart-keyfile-keychain");
        made.push(harness);
        scriptFolderWrites(harness);
        const keychain = ownKeychain();
        cleanups.push(keychain.remove);
        const inKeychain = "device-fixture-key-in-the-keychain";
        keepKey(keychain.path, harness.server.url, inKeychain);
        const root = standIn("keyfile-keychain");
        // The key file names another server, so the folder's own server is
        // found only in the keychain, which the watch must not read.
        const path = keyFile(root, "http://127.0.0.1:9", "unused-key");
        const from = harness.server.requests.length;
        parsed<Switched>(
          autostart(root, "on", {
            registry: harness.registry,
            env: { MARFA_KEYCHAIN: keychain.path },
            args: ["--key-file", path],
          }),
        );
        await vi.waitFor(() => {
          const status = parsed<Status>(
            autostart(root, "status", {
              registry: harness.registry,
              env: { MARFA_KEYCHAIN: keychain.path },
            }),
          );
          expect(status.record?.current).toBe(true);
          expect(["no_credential", "no_keychain"]).toContain(
            status.record?.folders.find((folder) => folder.dir === harness.dir)
              ?.reason,
          );
        }, WAIT);
        const sent = harness.server.requests
          .slice(from)
          .map((request) => request.headers.authorization)
          .filter((header) => header !== undefined);
        expect(sent).not.toContain(`Bearer ${inKeychain}`);
        // The witness: without the key file, the same keychain is read.
        parsed<Switched>(
          autostart(root, "on", {
            registry: harness.registry,
            env: { MARFA_KEYCHAIN: keychain.path },
          }),
        );
        put(
          harness,
          "Keychain.md",
          "---\ntitle: Keychain\n---\nthe keychain is read\n",
        );
        await vi.waitFor(
          () => expect(sentTitles(harness)).toEqual(["Keychain"]),
          WAIT,
        );
      });

      it("keeps a folder in step from the agent, with the credential the keychain keeps for the folder's server", async () => {
        const harness = await folderHarness("autostart-keychain");
        made.push(harness);
        scriptFolderWrites(harness);
        const keychain = ownKeychain();
        cleanups.push(keychain.remove);
        const kept = "device-fixture-key-kept-for-login";
        keepKey(keychain.path, harness.server.url, kept);
        const root = standIn("keychain");
        const from = harness.server.requests.length;
        parsed<Switched>(
          autostart(root, "on", {
            registry: harness.registry,
            env: { MARFA_KEYCHAIN: keychain.path },
          }),
        );
        put(
          harness,
          "At login.md",
          "---\ntitle: At login\n---\nno terminal open\n",
        );
        await vi.waitFor(
          () => expect(sentTitles(harness)).toEqual(["At login"]),
          WAIT,
        );
        const sent = harness.server.requests
          .slice(from)
          .map((request) => request.headers.authorization)
          .filter((header) => header !== undefined);
        expect(sent).toContain(`Bearer ${kept}`);
        expect(sent.filter((header) => header !== `Bearer ${kept}`)).toEqual(
          [],
        );
      });
    },
  );
});

describe("the watch run by a service manager", () => {
  it("ends on SIGTERM within three seconds with exit status 0, and marks its folders not watched", async () => {
    const harness = await folderHarness("autostart-term");
    made.push(harness);
    const watch = harness.folder.watchEvery();
    held.push(watch);
    const recordPath = join(dirname(harness.registry), "folder-watch.json");
    const entry = () =>
      existsSync(recordPath)
        ? (
            JSON.parse(readFileSync(recordPath, "utf8")) as {
              processes: Array<{
                pid: number;
                ended_at: string | null;
                folders: Array<{ dir: string; watching: boolean }>;
              }>;
            }
          ).processes.find((process) => process.pid === watch.pid())
        : undefined;
    await vi.waitFor(() => {
      expect(
        entry()?.folders.find((folder) => folder.dir === harness.dir)?.watching,
      ).toBe(true);
    }, WAIT);
    const sent = Date.now();
    process.kill(watch.pid(), "SIGTERM");
    await watch.exited();
    expect(Date.now() - sent).toBeLessThan(3_000);
    expect(watch.exitCode(), watch.stderr).toBe(0);
    expect(entry()?.ended_at).not.toBeNull();
    expect(entry()?.folders.every((folder) => !folder.watching)).toBe(true);
  });

  // The scheduler gives utility quality of service a priority of 20 and the
  // default class 31, which `ps -M` lists for each thread. The command's own
  // threads beside the watch, three as the binary is built now, stay at the
  // default.
  it.runIf(process.platform === "darwin")(
    "runs the threads of a folder watch, and the threads they start, at utility quality of service",
    async () => {
      const harness = await folderHarness("autostart-utility");
      made.push(harness);
      const watch = harness.folder.watchEvery();
      held.push(watch);
      await vi.waitFor(
        () => expect(watch.stderr).toContain("watching every folder"),
        WAIT,
      );
      const priorities = () =>
        execFileSync("ps", ["-M", "-p", String(watch.pid()), "-o", "pri"], {
          encoding: "utf8",
        })
          .split("\n")
          .flatMap((line) => line.match(/(\d+)T\s*$/)?.[1] ?? []);
      await vi.waitFor(() => {
        const found = priorities();
        // The witness: ps tells the default class from the utility one, and
        // the threads the process starts for itself stay at the default.
        expect(found).toContain("31");
        expect(
          found.filter((priority) => priority === "20").length,
        ).toBeGreaterThanOrEqual(8);
        expect(
          found.filter((priority) => priority === "31").length,
        ).toBeLessThanOrEqual(3);
        expect(
          found.filter((priority) => priority !== "31" && priority !== "20"),
        ).toEqual([]);
      }, WAIT);
      process.kill(watch.pid(), "SIGTERM");
      await watch.exited();
    },
  );

  it("ends on SIGTERM with exit status 0 while it sends telemetry, too", async () => {
    const harness = await folderHarness("autostart-term-telemetry");
    made.push(harness);
    // A collector nothing answers at: the trace is tried and given up.
    const watch = harness.folder.watchEvery({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
      OTEL_SDK_DISABLED: "false",
    });
    held.push(watch);
    await vi.waitFor(
      () => expect(watch.stderr).toContain("watching every folder"),
      WAIT,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const sent = Date.now();
    process.kill(watch.pid(), "SIGTERM");
    await watch.exited();
    expect(Date.now() - sent).toBeLessThan(5_000);
    expect(watch.exitCode(), watch.stderr).toBe(0);
  });

  describe.each([
    { signal: "SIGTERM", status: 0 },
    { signal: "SIGINT", status: 130 },
  ] as const)("stopped by $signal", ({ signal, status }) => {
    it("writes the signal, its sender and the time as the last line of its log", async () => {
      const harness = await folderHarness(`autostart-stop-${signal}`);
      made.push(harness);
      const log = logIn("stop-line");
      const watch = harness.folder
        .device()
        .hold(["folders", "watch", "--log", log], "root");
      held.push(watch);
      await vi.waitFor(() => {
        expect(readLog(log)).toContain("watching every folder");
      }, WAIT);
      const before = Date.now();
      process.kill(watch.pid(), signal);
      await watch.exited();
      const after = Date.now();
      expect(watch.exitCode(), readLog(log)).toBe(status);
      const text = readLog(log);
      expect(text).toMatch(/folders watch started, process \d+\n/);
      const stopped = lastLine(text);
      expect(stopped).toMatch(
        new RegExp(
          `^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ folders watch stopped by ${signal}, sent by process ${process.pid}$`,
        ),
      );
      // To the second the line is written in, which is the clock's and not a
      // guess: the second it was sent in, or the next.
      const at = Date.parse(stopped.split(" ")[0]!);
      expect(at).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
      expect(at).toBeLessThanOrEqual(after);
      // The witness: the line is the stop's, and the start's line is not it.
      expect(
        text.split("\n").filter((line) => line.includes("stopped by")),
      ).toHaveLength(1);
    });
  });

  it("writes the stop line to the fresh log after the file reached 1 MiB while the watch ran", async () => {
    const harness = await folderHarness("autostart-stop-rotated");
    made.push(harness);
    const log = logIn("stop-rotated");
    const watch = harness.folder
      .device()
      .hold(["folders", "watch", "--log", log], "root");
    held.push(watch);
    await vi.waitFor(() => {
      expect(readLog(log)).toContain("watching every folder");
    }, WAIT);
    appendFileSync(log, "y".repeat(MEBIBYTE));
    await vi.waitFor(() => {
      expect(existsSync(`${log}.1`)).toBe(true);
    }, WAIT);
    process.kill(watch.pid(), "SIGTERM");
    await watch.exited();
    expect(watch.exitCode()).toBe(0);
    expect(lastLine(readLog(log))).toMatch(
      /folders watch stopped by SIGTERM, sent by process \d+$/,
    );
    expect(readLog(`${log}.1`)).not.toContain("stopped by");
  });

  it("writes the stop line, and ends within three seconds with exit status 0, when SIGTERM comes during a pass that waits on the server", async () => {
    const harness = await folderHarness("autostart-stop-in-pass");
    made.push(harness);
    // The server takes the create and never answers, so the pass stays under way.
    scriptFolderWrites(harness, { creating: () => ({ kind: "stall" }) });
    const log = logIn("stop-in-pass");
    const watch = harness.folder
      .device()
      .hold(["folders", "watch", harness.dir, "--log", log], "root");
    held.push(watch);
    await vi.waitFor(() => {
      expect(readLog(log)).toContain("watching");
    }, WAIT);
    put(
      harness,
      "Waiting.md",
      "---\ntitle: Waiting\n---\nsent, never answered\n",
    );
    await vi.waitFor(() => {
      expect(
        harness.server.requests.filter(
          (request) =>
            request.method === "POST" && request.pathname === "/items",
        ),
      ).not.toHaveLength(0);
    }, WAIT);
    const sent = Date.now();
    process.kill(watch.pid(), "SIGTERM");
    await watch.exited();
    expect(Date.now() - sent).toBeLessThan(3_000);
    expect(watch.exitCode(), readLog(log)).toBe(0);
    expect(lastLine(readLog(log))).toMatch(
      new RegExp(
        `folders watch stopped by SIGTERM, sent by process ${process.pid}$`,
      ),
    );
  });

  it("moves the file launchd gave the watch aside as the watch starts when it holds 1 MiB or more", async () => {
    const harness = await folderHarness("autostart-launchd-full");
    made.push(harness);
    const log = logIn("launchd-full");
    const launchd = join(dirname(log), "folder-watch.launchd.log");
    writeFileSync(launchd, "x".repeat(MEBIBYTE));
    const watch = harness.folder
      .device()
      .hold(["folders", "watch", "--log", log], "root");
    held.push(watch);
    await vi.waitFor(() => {
      expect(readLog(log)).toContain("watching every folder");
    }, WAIT);
    expect(statSync(`${launchd}.1`).size).toBe(MEBIBYTE);
    expect(existsSync(launchd)).toBe(false);
  });

  it("moves a log of 1 MiB or more aside as the watch starts, and writes to a fresh one", async () => {
    const harness = await folderHarness("autostart-log-start");
    made.push(harness);
    const dir = mkdtempSync(
      join(realpathSync(tmpdir()), "marfa-autostart-log-"),
    );
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, "logs", "folder-watch.log");
    mkdirSync(dirname(log));
    const full = "x".repeat(MEBIBYTE);
    writeFileSync(log, full);
    writeFileSync(`${log}.1`, "the oldest");
    const watch = harness.folder
      .device()
      .hold(["folders", "watch", "--log", log], "root");
    held.push(watch);
    await vi.waitFor(() => {
      expect(readFileSync(log, "utf8")).toContain("watching every folder");
    }, WAIT);
    expect(readFileSync(`${log}.1`, "utf8")).toBe(full);
    expect(readFileSync(log, "utf8")).not.toContain("x".repeat(64));
    expect(statSync(log).mode & 0o077).toBe(0);
    // The watch prints nowhere else.
    expect(watch.stdout).toBe("");
    expect(watch.stderr).toBe("");
  });

  it("moves the log aside once it reaches 1 MiB while the watch runs", async () => {
    const harness = await folderHarness("autostart-log-running");
    made.push(harness);
    const dir = mkdtempSync(
      join(realpathSync(tmpdir()), "marfa-autostart-log-"),
    );
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, "folder-watch.log");
    const watch = harness.folder
      .device()
      .hold(["folders", "watch", "--log", log], "root");
    held.push(watch);
    await vi.waitFor(() => {
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toContain(
        "watching every folder",
      );
    }, WAIT);
    // A file of 1 MiB below the limit is no reason to move it.
    expect(existsSync(`${log}.1`)).toBe(false);
    appendFileSync(log, "y".repeat(MEBIBYTE));
    await vi.waitFor(() => {
      expect(existsSync(`${log}.1`)).toBe(true);
      expect(existsSync(log)).toBe(true);
    }, WAIT);
    expect(statSync(`${log}.1`).size).toBeGreaterThanOrEqual(MEBIBYTE);
    expect(statSync(log).size).toBeLessThan(MEBIBYTE);
    expect(watch.running()).toBe(true);
  });
});

/** A log path in a directory of the test's own. */
function logIn(label: string): string {
  const dir = mkdtempSync(
    join(realpathSync(tmpdir()), `marfa-autostart-${label}-`),
  );
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "folder-watch.log");
}

function readLog(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** The last line of `text`, which is not the empty one a final newline leaves. */
function lastLine(text: string): string {
  return text.trimEnd().split("\n").at(-1) ?? "";
}

/** Ends the agent's watch as a crash would, leaving the agent installed. */
function stopAgent(root: string): void {
  const pid = managerState(root).pid;
  if (pid !== null && alive(pid)) process.kill(pid, "SIGKILL");
}

/**
 * A keychain file of the test's own, so the run's shared one is left as it
 * is. The binary reads an item `security` made only where the item lets any
 * application read it, which is set as the item is made, never changed later.
 */
function ownKeychain(): { path: string; remove: () => void } {
  const folder = mkdtempSync(join(tmpdir(), "marfa-autostart-keychain-"));
  const path = join(folder, "credentials.keychain-db");
  const password = randomUUID();
  execFileSync("security", ["create-keychain", "-p", password, path]);
  execFileSync("security", ["unlock-keychain", "-p", password, path]);
  execFileSync("security", ["set-keychain-settings", path]);
  return {
    path,
    remove: () => {
      try {
        execFileSync("security", ["delete-keychain", path]);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  };
}

/** Keeps `key` for `origin`, as `keys keep` would. */
function keepKey(keychain: string, origin: string, key: string): void {
  execFileSync("security", [
    "add-generic-password",
    "-A",
    "-s",
    "marfa",
    "-a",
    origin,
    "-w",
    JSON.stringify({ kind: "key", key }),
    keychain,
  ]);
}

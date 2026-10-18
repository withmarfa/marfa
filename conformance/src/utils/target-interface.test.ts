import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "./fresh-server.js";
import { readRequestLog } from "./status-declarations.js";

/**
 * The target interface as the harness uses it (`conformance/README.md`): a
 * restart that keeps the data and the clock, a clock that only moves
 * forward, faults that last no longer than the process, and a log that holds
 * the server's JSON lines and nothing else. Each case runs the adapter
 * command a fixture runs, against a server of its own.
 */

const HOUR_MS = 3_600_000;

let scratch: string;
let server: FreshServer;
/** Preloaded into the server: a Node warning and a line on stderr, and on
 *  stdout too when `PROBE_STDOUT` is set. */
let preload: string;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "marfa-target-interface-"));
  preload = join(scratch, "probe.cjs");
  writeFileSync(
    preload,
    [
      'process.emitWarning("probe warning");',
      'console.error("probe stderr line");',
      'if (process.env.PROBE_STDOUT) console.log("probe stdout line");',
    ].join("\n"),
  );
  server = await bootFreshServer("target-interface", {
    NODE_OPTIONS: `--require ${preload}`,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** When the server says a run of a housekeeping job started: its clock. */
async function serverNow(): Promise<number> {
  const run = await fetch(
    `${server.apiUrl}/housekeeping/rate-limit-cleanup/run`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${server.managementKey}` },
    },
  );
  expect(run.status).toBe(200);
  return Date.parse(((await run.json()) as { started_at: string }).started_at);
}

describe("the clock", () => {
  it("moves forward, refuses a step back, and survives a restart", async () => {
    // The witness: the server reads the system clock until it is moved.
    expect(Math.abs((await serverNow()) - Date.now())).toBeLessThan(10_000);

    await server.advanceClock(HOUR_MS);
    expect((await serverNow()) - Date.now()).toBeGreaterThan(HOUR_MS - 10_000);

    await expect(server.advanceClock(-1)).rejects.toThrow(/forward/);
    await expect(server.advanceClock(1.5)).rejects.toThrow(/whole number/);
    expect((await serverNow()) - Date.now()).toBeLessThan(HOUR_MS + 10_000);

    // A move past the largest offset a restart accepts is refused, and the
    // clock stays where it was.
    await expect(server.advanceClock(3_153_600_000_000)).rejects.toThrow(
      /ahead/,
    );
    expect((await serverNow()) - Date.now()).toBeLessThan(HOUR_MS + 10_000);

    await server.restart();
    const after = (await serverNow()) - Date.now();
    expect(after).toBeGreaterThan(HOUR_MS - 10_000);
    // The offset is carried, not added again.
    expect(after).toBeLessThan(HOUR_MS + 10_000);

    await server.advanceClock(HOUR_MS);
    await server.restart({ signal: "SIGKILL" });
    expect((await serverNow()) - Date.now()).toBeGreaterThan(
      2 * HOUR_MS - 10_000,
    );
  });
});

describe("a fault", () => {
  it("is named by where it acts, counts who waits at it, and is refused when it names no point", async () => {
    await server.setFault("hold:version-thinning:item");
    await server.setFault("deadline:trash-purge=250");
    expect(await server.faults()).toEqual([
      { name: "hold:version-thinning:item", arg: null, waiting: 0, fired: 0 },
      { name: "deadline:trash-purge", arg: "250", waiting: 0, fired: 0 },
    ]);
    await expect(server.setFault("hold:nowhere")).rejects.toThrow(
      /no hold point/,
    );
    await expect(server.setFault("fail:nowhere")).rejects.toThrow(
      /no fail point/,
    );
    await expect(server.setFault("fail:lock=0")).rejects.toThrow(/from 1/);
    await expect(server.setFault("fail:commit=items.bulk@0")).rejects.toThrow(
      /<action>@<n>/,
    );
    await expect(
      server.setFault("fail:housekeeping:no-such-job"),
    ).rejects.toThrow(/no housekeeping job/);
    await server.setFault("fail:commit=items.bulk@2");
    expect(await server.faults()).toContainEqual({
      name: "fail:commit",
      arg: "items.bulk@2",
      waiting: 0,
      fired: 0,
    });
    await server.clearFault("fail:commit");
    await expect(server.setFault("deadline:trash-purge")).rejects.toThrow(
      /milliseconds/,
    );
    await expect(
      server.setFault("hold:housekeeping:no-such-job"),
    ).rejects.toThrow(/no housekeeping job/);
    await expect(server.setFault("deadline:no-such-job=250")).rejects.toThrow(
      /no housekeeping job/,
    );
    await server.clearFault("deadline:trash-purge");
    expect((await server.faults()).map((fault) => fault.name)).toEqual([
      "hold:version-thinning:item",
    ]);
  });

  it("is gone after a restart, and a held run is waited for until it is cleared", async () => {
    // The witness: the fault is armed before the restart.
    expect(await server.faults()).not.toEqual([]);
    await server.restart();
    expect(await server.faults()).toEqual([]);

    await server.setFault("hold:housekeeping:rate-limit-cleanup");
    const held = fetch(`${server.apiUrl}/housekeeping/rate-limit-cleanup/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.managementKey}` },
    });
    await server.waitForHold("hold:housekeeping:rate-limit-cleanup");
    await server.clearFault();
    expect((await held).status).toBe(200);
    expect(await server.faults()).toEqual([]);
  });

  it("is cleared by stop, before the server is told to end", async () => {
    const kept = mkdtempSync(join(tmpdir(), "marfa-target-interface-logs-"));
    const own = await bootFreshServer("target-interface-stop");
    const before = process.env.MARFA_STATUS_LOGS;
    process.env.MARFA_STATUS_LOGS = kept;
    try {
      await own.setFault("hold:version-thinning:item");
      await own.stop();
      const logs = readFileSync(
        join(kept, `${own.stateDir.split("/").at(-1)}.log`),
        "utf8",
      );
      expect(logs).toContain('"path":"/_control/test/faults"');
      expect(logs).toContain('"method":"DELETE"');
    } finally {
      if (before === undefined) delete process.env.MARFA_STATUS_LOGS;
      else process.env.MARFA_STATUS_LOGS = before;
      rmSync(kept, { recursive: true, force: true });
    }
  });
});

describe("the hooks", () => {
  it(
    "are absent on a server booted without them",
    async () => {
      const plain = await bootFreshServer("target-interface-off", {
        MARFA_TEST_HOOKS: "false",
      });
      try {
        await expect(plain.advanceClock(1_000)).rejects.toThrow(/404/);
        await expect(
          plain.setFault("hold:version-thinning:item"),
        ).rejects.toThrow(/404/);
      } finally {
        await plain.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("the server log", () => {
  const stateLog = (name: string) =>
    readFileSync(join(server.stateDir, name), "utf8");

  it("holds JSON lines only, and what else the process prints goes to its own file", async () => {
    const log = readRequestLog(stateLog("server.log"));
    // The witness: the log holds requests the gate reads, and the probe ran.
    expect(log.lines.length).toBeGreaterThan(0);
    expect(stateLog("server.stderr")).toContain("probe warning");
    expect(stateLog("server.stderr")).toContain("probe stderr line");
    expect(log.unreadable).toEqual([]);
  });

  it("shows a line the server printed to stdout as one the gate cannot read", async () => {
    await server.restart({ env: { PROBE_STDOUT: "1" } });
    const log = readRequestLog(stateLog("server.log"));
    expect(log.unreadable.map((line) => line.text)).toContain(
      "probe stdout line",
    );
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cli } from "../cli/harness.js";
import { newStore } from "../../device/cli-adapter.js";
import { startFaultSinks, type FaultSinks } from "../../utils/fault-sinks.js";
import { KEY, requireBinary } from "./harness.js";

let sinks: FaultSinks;
beforeEach(async () => {
  sinks = await startFaultSinks();
});
afterEach(async () => {
  await sinks.close();
});

/** The error tracking settings of the receiver, and nothing of OTLP. */
function trackingOnly(): Record<string, string> {
  const { MARFA_POSTHOG_HOST, MARFA_POSTHOG_PROJECT_TOKEN } = sinks.env();
  return {
    MARFA_POSTHOG_HOST: MARFA_POSTHOG_HOST!,
    MARFA_POSTHOG_PROJECT_TOKEN: MARFA_POSTHOG_PROJECT_TOKEN!,
  };
}

function cli(env: Record<string, string>): Cli {
  return new Cli(requireBinary(), "http://127.0.0.1:1", KEY).withEnv(env);
}

/** A working copy that exists and was never hydrated. */
async function store(): Promise<string> {
  const path = newStore("cli-exception");
  const made = await cli({}).run(["--json", "device", "--db", path, "status"]);
  expect(made.code, made.stderr).toBe(0);
  return path;
}

/** The command that fails, with a local error and no server. */
const failing = (path: string) => [
  "--json",
  "device",
  "--db",
  path,
  "catch-up",
];
const succeeding = (path: string) => [
  "--json",
  "device",
  "--db",
  path,
  "search",
  "x",
];

describe("the command line reports a failed command to error tracking", () => {
  it("sends one exception and no trace when only the error tracking settings are set", async () => {
    const path = await store();
    const ran = await cli(trackingOnly()).run(failing(path));
    expect(ran.code, ran.stderr).toBe(4);
    const sent = sinks.sentExceptions();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.properties).toMatchObject({
      command: "device catch-up",
      exit_code: 4,
      error_code: "no_cursor",
    });
    expect(sinks.traces).toEqual([]);

    // The witness: with an endpoint named as well, the same run sends both.
    const both = await cli(sinks.env()).run(failing(path));
    expect(both.code, both.stderr).toBe(4);
    expect(sinks.sentExceptions()).toHaveLength(2);
    expect(sinks.traces).toHaveLength(1);
  });

  it("still sends the exception when the OTLP endpoint is not an address", async () => {
    const path = await store();
    const ran = await cli({
      ...trackingOnly(),
      OTEL_EXPORTER_OTLP_ENDPOINT: "not a url",
    }).run(failing(path));
    expect(ran.code, ran.stderr).toBe(4);
    expect(sinks.sentExceptions()).toHaveLength(1);
    expect(sinks.traces).toEqual([]);
  });

  it("sends nothing when the SDK is disabled, with an endpoint or without", async () => {
    const path = await store();
    for (const env of [
      { ...sinks.env(), OTEL_SDK_DISABLED: "true" },
      { ...trackingOnly(), OTEL_SDK_DISABLED: "true" },
    ]) {
      const ran = await cli(env).run(failing(path));
      expect(ran.code, ran.stderr).toBe(4);
    }
    expect(sinks.sentExceptions()).toEqual([]);
    expect(sinks.traces).toEqual([]);

    // The witness: the same run without the switch is reported.
    await cli(sinks.env()).run(failing(path));
    expect(sinks.sentExceptions()).toHaveLength(1);
  });

  it("sends no exception when the command succeeds", async () => {
    const path = await store();
    const ran = await cli(trackingOnly()).run(succeeding(path));
    expect(ran.code, ran.stderr).toBe(0);
    expect(sinks.sentExceptions()).toEqual([]);
    expect(sinks.traces).toEqual([]);

    // The witness: the failing run beside it is reported.
    await cli(trackingOnly()).run(failing(path));
    expect(sinks.sentExceptions()).toHaveLength(1);
  });
});

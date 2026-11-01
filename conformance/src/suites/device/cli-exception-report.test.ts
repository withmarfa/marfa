import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cli } from "../cli/harness.js";
import { newStore } from "../../device/cli-adapter.js";
import { refusal } from "../../device/marfa-answers.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import { startFaultSinks, type FaultSinks } from "../../utils/fault-sinks.js";
import { KEY, requireBinary } from "./harness.js";

let sinks: FaultSinks;
let server: ScriptedServer;
beforeEach(async () => {
  sinks = await startFaultSinks();
  server = await ScriptedServer.start();
});
afterEach(async () => {
  await sinks.close();
  await server.stop();
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
  return new Cli(requireBinary(), server.url, KEY).withEnv(env);
}

/** A working copy that exists and was never hydrated. */
async function store(): Promise<string> {
  const path = newStore("cli-exception");
  const made = await cli({}).run(["--json", "device", "--db", path, "status"]);
  expect(made.code, made.stderr).toBe(0);
  return path;
}

/** A command the server fails: it answers 500, which is a fault. */
const failing = () => {
  server.answer("GET", "/items/broken", refusal(500, "internal", "broken"));
  return ["--json", "items", "get", "broken"];
};

/** A command the server refuses, by design: a 404 is an answer, not a fault. */
const refused = () => {
  server.answer("GET", "/items/gone", refusal(404, "not_found", "none"));
  return ["--json", "items", "get", "gone"];
};
const succeeding = (path: string) => [
  "--json",
  "device",
  "--db",
  path,
  "search",
  "x",
];

describe("the command line reports a fault to error tracking", () => {
  it("sends one exception and no trace when only the error tracking settings are set", async () => {
    const ran = await cli(trackingOnly()).run(failing());
    expect(ran.code, ran.stderr).toBe(3);
    const sent = sinks.sentExceptions();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.properties).toMatchObject({
      command: "items get",
      exit_code: 3,
      error_code: "server",
    });
    expect(sinks.traces).toEqual([]);

    // The witness: with an endpoint named as well, the same run sends both.
    const both = await cli(sinks.env()).run(failing());
    expect(both.code, both.stderr).toBe(3);
    expect(sinks.sentExceptions()).toHaveLength(2);
    expect(sinks.traces).toHaveLength(1);
  });

  it("still sends the exception when the OTLP endpoint is not an address", async () => {
    const ran = await cli({
      ...trackingOnly(),
      OTEL_EXPORTER_OTLP_ENDPOINT: "not a url",
    }).run(failing());
    expect(ran.code, ran.stderr).toBe(3);
    expect(sinks.sentExceptions()).toHaveLength(1);
    expect(sinks.traces).toEqual([]);
  });

  it("sends nothing when the SDK is disabled, with an endpoint or without", async () => {
    for (const env of [
      { ...sinks.env(), OTEL_SDK_DISABLED: "true" },
      { ...trackingOnly(), OTEL_SDK_DISABLED: "true" },
    ]) {
      const ran = await cli(env).run(failing());
      expect(ran.code, ran.stderr).toBe(3);
    }
    expect(sinks.sentExceptions()).toEqual([]);
    expect(sinks.traces).toEqual([]);

    // The witness: the same run without the switch is reported.
    await cli(sinks.env()).run(failing());
    expect(sinks.sentExceptions()).toHaveLength(1);
  });

  it("sends no exception when the command ends in a refusal by design", async () => {
    const ran = await cli(trackingOnly()).run(refused());
    expect(ran.code, ran.stderr).toBe(1);
    expect(ran.stderr).toContain('"not_found"');
    expect(sinks.sentExceptions()).toEqual([]);

    // The witness: the same run, with the server failing, is reported.
    const failed = await cli(trackingOnly()).run(failing());
    expect(failed.code, failed.stderr).toBe(3);
    expect(sinks.sentExceptions()).toHaveLength(1);
  });

  it("sends no exception when the command succeeds", async () => {
    const path = await store();
    const ran = await cli(trackingOnly()).run(succeeding(path));
    expect(ran.code, ran.stderr).toBe(0);
    expect(sinks.sentExceptions()).toEqual([]);
    expect(sinks.traces).toEqual([]);

    // The witness: the failing run beside it is reported.
    await cli(trackingOnly()).run(failing());
    expect(sinks.sentExceptions()).toHaveLength(1);
  });
});

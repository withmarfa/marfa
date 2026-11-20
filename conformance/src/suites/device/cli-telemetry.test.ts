import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cli } from "../cli/harness.js";
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

/** The settings that name the receiver as an OTLP collector and nothing else. */
function otlpOnly(): Record<string, string> {
  const { OTEL_SDK_DISABLED, OTEL_EXPORTER_OTLP_ENDPOINT } = sinks.env();
  return {
    OTEL_SDK_DISABLED: OTEL_SDK_DISABLED!,
    OTEL_EXPORTER_OTLP_ENDPOINT: OTEL_EXPORTER_OTLP_ENDPOINT!,
  };
}

/** The settings that name the receiver as a PostHog project and nothing else. */
function postHogOnly(): Record<string, string> {
  const { OTEL_SDK_DISABLED, MARFA_POSTHOG_HOST, MARFA_POSTHOG_PROJECT_TOKEN } =
    sinks.env();
  return {
    OTEL_SDK_DISABLED: OTEL_SDK_DISABLED!,
    MARFA_POSTHOG_HOST: MARFA_POSTHOG_HOST!,
    MARFA_POSTHOG_PROJECT_TOKEN: MARFA_POSTHOG_PROJECT_TOKEN!,
  };
}

function cli(env: Record<string, string>): Cli {
  return new Cli(requireBinary(), server.url, KEY).withEnv(env);
}

/** A command that fails: a 404 for an item the server does not hold. */
const failing = () => {
  server.answer("GET", "/items/gone", refusal(404, "not_found", "none"));
  return ["--json", "items", "get", "gone"];
};

/** Everything the receiver was sent, whatever it was sent as. */
function received(): number {
  return (
    sinks.traces.length +
    sinks.logRecords.length +
    sinks.trackedErrors.length +
    sinks.elsewhere.length
  );
}

describe("the command line reports a run as a trace over OTLP and in no other way", () => {
  it("sends no trace when no OTLP endpoint is set, and one when it is", async () => {
    const ran = await cli({ OTEL_SDK_DISABLED: "false" }).run(failing());
    expect(ran.code, ran.stderr).toBe(1);
    expect(sinks.traces).toEqual([]);

    // The witness: the same run with the receiver named as the endpoint sends a trace.
    const sent = await cli(otlpOnly()).run(failing());
    expect(sent.code, sent.stderr).toBe(1);
    expect(sinks.traces).toHaveLength(1);
  });

  it("sends a failed command's report to the OTLP endpoint alone, whatever PostHog settings are set", async () => {
    const ran = await cli(postHogOnly()).run(failing());
    expect(ran.code, ran.stderr).toBe(1);
    expect(ran.stderr).not.toContain("POSTHOG");
    expect(received()).toBe(0);

    // The witness: with the OTLP endpoint named as well, the same run sends
    // its trace to the receiver, and still no exception.
    const both = await cli(sinks.env()).run(failing());
    expect(both.code, both.stderr).toBe(1);
    expect(sinks.traces).toHaveLength(1);
    expect(sinks.sentExceptions()).toEqual([]);
    expect(sinks.trackedErrors).toEqual([]);
  });

  it("sends nothing when the SDK is disabled, with an endpoint or without", async () => {
    for (const env of [
      { ...sinks.env(), OTEL_SDK_DISABLED: "true" },
      { ...otlpOnly(), OTEL_SDK_DISABLED: "true" },
      { ...postHogOnly(), OTEL_SDK_DISABLED: "true" },
    ]) {
      const ran = await cli(env).run(failing());
      expect(ran.code, ran.stderr).toBe(1);
    }
    expect(received()).toBe(0);

    // The witness: the same run without the switch is reported.
    await cli(sinks.env()).run(failing());
    expect(sinks.traces).toHaveLength(1);
  });
});

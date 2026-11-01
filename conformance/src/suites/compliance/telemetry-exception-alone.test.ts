import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
  serverOutput,
} from "../../utils/fresh-server.js";
import { startFaultSinks, type FaultSinks } from "../../utils/fault-sinks.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

/**
 * What turns the server's exception reports on and off. They are a pipeline
 * of their own: the PostHog host and project token alone send them,
 * `OTEL_SDK_DISABLED=true` stops them with the traces and logs, and a host the
 * token may not travel to stops only them.
 *
 * **A server of its own for each case, with a receiver the fixture runs.** The
 * receiver is the OTLP collector and the PostHog host at once. A fault is made
 * as `fault-reports.test.ts` makes one, by renaming a table the write reaches
 * in the stored file, and a stop flushes what the server holds, so each case
 * reads what arrived once the server has stopped.
 */
let sinks: FaultSinks | undefined;
let server: FreshServer | undefined;

afterEach(async () => {
  await server?.stop();
  await sinks?.close();
  server = undefined;
  sinks = undefined;
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/**
 * Boots a server with the receiver's PostHog host and token, and whatever the
 * case adds or changes, given the receiver's own settings to draw on.
 */
async function boot(
  settings: (
    receiver: Record<string, string>,
  ) => Record<string, string> = () => ({}),
): Promise<FreshServer> {
  sinks = await startFaultSinks();
  const receiver = sinks.env();
  server = await bootFreshServer("telemetry-exception-alone", {
    OTEL_SDK_DISABLED: "false",
    MARFA_OTEL_SAMPLE_RATIO: "1",
    MARFA_POSTHOG_HOST: receiver.MARFA_POSTHOG_HOST!,
    MARFA_POSTHOG_PROJECT_TOKEN: receiver.MARFA_POSTHOG_PROJECT_TOKEN!,
    ...settings(receiver),
  });
  return server;
}

/**
 * One request that ends in an unhandled fault, then a stop, which flushes.
 * Resolves with the server's log, read before the stop takes its directory.
 */
async function faultAndStop(booted: FreshServer): Promise<string> {
  withInstanceDatabase(booted.sqlitePath, (db) => {
    db.exec("ALTER TABLE event_log RENAME TO event_log_gone");
  });
  const refused = await fetch(`${booted.apiUrl}/items`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${booted.workingKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "core.note", properties: { body: "x" } }),
  });
  expect(refused.status).toBe(500);
  const log = serverOutput(dirname(booted.sqlitePath));
  await booted.stop();
  return log;
}

const BUDGET = 3 * FRESH_SERVER_TIMEOUT_MS;

describe("the server's exception reports", () => {
  it(
    "are sent with the PostHog host and project token alone, and no trace or log record",
    async () => {
      await faultAndStop(await boot());
      expect(sinks!.sentExceptions()).toHaveLength(1);
      expect(sinks!.traces).toEqual([]);
      expect(sinks!.logRecords).toEqual([]);
    },
    BUDGET,
  );

  it(
    "are not sent, nor is anything else, when OTEL_SDK_DISABLED is true",
    async () => {
      await faultAndStop(
        await boot((receiver) => ({
          OTEL_SDK_DISABLED: "true",
          OTEL_EXPORTER_OTLP_ENDPOINT: receiver.OTEL_EXPORTER_OTLP_ENDPOINT!,
        })),
      );
      expect(sinks!.sentExceptions()).toEqual([]);
      expect(sinks!.traces).toEqual([]);
      expect(sinks!.logRecords).toEqual([]);
    },
    BUDGET,
  );

  it(
    "are all that a host the token may not travel to stops: traces and logs still go",
    async () => {
      const log = await faultAndStop(
        await boot((receiver) => ({
          OTEL_EXPORTER_OTLP_ENDPOINT: receiver.OTEL_EXPORTER_OTLP_ENDPOINT!,
          MARFA_POSTHOG_HOST: "http://posthog.example",
        })),
      );
      expect(sinks!.sentExceptions()).toEqual([]);
      expect(log).toContain("MARFA_POSTHOG_HOST is not an https address");
      expect(log).not.toContain("posthog.example");
      // The witness: the same run still exports to the collector.
      expect(sinks!.traces.length).toBeGreaterThan(0);
      expect(sinks!.logRecords.length).toBeGreaterThan(0);
    },
    BUDGET,
  );
});

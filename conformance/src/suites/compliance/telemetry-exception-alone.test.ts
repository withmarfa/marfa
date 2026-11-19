import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { startFaultSinks, type FaultSinks } from "../../utils/fault-sinks.js";

/**
 * What turns the server's exception reports on and off, and what they are
 * sent as. They are a pipeline of their own: the stored PostHog host and
 * project token alone send them, from the next fault once both are written,
 * and `OTEL_SDK_DISABLED=true` stops them with the traces and logs. A host the
 * token may not travel to, or one setting without the other, is refused.
 *
 * **A server of its own for each case, with a receiver the fixture runs.** The
 * receiver is the OTLP collector and the PostHog host at once. A fault is made
 * as `fault-reports.test.ts` makes one, by failing the audit entry of a
 * write, and a stop flushes what the server holds, so each case reads what
 * arrived once the server has stopped.
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

/** One request under `requestId` that ends in an unhandled fault. */
async function fault(booted: FreshServer, requestId: string): Promise<void> {
  await booted.setFault("fail:audit=item.create");
  const refused = await fetch(`${booted.apiUrl}/items`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${booted.workingKey}`,
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
    },
    body: JSON.stringify({ type: "core.note", properties: { body: "x" } }),
  });
  await booted.clearFault();
  expect(refused.status).toBe(500);
}

/**
 * One request that ends in an unhandled fault, then a stop, which flushes.
 * Resolves with the server's log, read before the stop takes its directory.
 */
async function faultAndStop(booted: FreshServer): Promise<string> {
  await fault(booted, `exception-alone-${randomUUID()}`);
  const log = await booted.output();
  await booted.stop();
  return log;
}

/** A write to `/config` through a key holding `config.manage`. */
async function configure(
  booted: FreshServer,
  changes: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const answer = await fetch(`${booted.apiUrl}/config`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${booted.managementKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(changes),
  });
  return {
    status: answer.status,
    body: (await answer.json()) as Record<string, unknown>,
  };
}

/** The secrets `/config` says are set. */
async function secretsSet(booted: FreshServer): Promise<string[]> {
  const answer = await fetch(`${booted.apiUrl}/config`, {
    headers: { Authorization: `Bearer ${booted.managementKey}` },
  });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { secrets_set: string[] }).secrets_set;
}

const TOKEN = "phc_conformance_fixture";

const BUDGET = 3 * FRESH_SERVER_TIMEOUT_MS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
    "are still sent, with traces and logs, when OTEL_SDK_DISABLED is any value but true, 1 included",
    async () => {
      await faultAndStop(
        await boot((receiver) => ({
          OTEL_SDK_DISABLED: "1",
          OTEL_EXPORTER_OTLP_ENDPOINT: receiver.OTEL_EXPORTER_OTLP_ENDPOINT!,
        })),
      );
      expect(sinks!.sentExceptions()).toHaveLength(1);
      expect(sinks!.traces.length).toBeGreaterThan(0);
      expect(sinks!.logRecords.length).toBeGreaterThan(0);
    },
    BUDGET,
  );

  it(
    "still post an error notification when OTEL_SDK_DISABLED is true in any case",
    async () => {
      await faultAndStop(
        await boot((receiver) => ({
          OTEL_SDK_DISABLED: "TRUE",
          MARFA_ERROR_WEBHOOK_URL: receiver.MARFA_ERROR_WEBHOOK_URL!,
        })),
      );
      expect(sinks!.sentExceptions()).toEqual([]);
      expect(sinks!.notifications.length).toBeGreaterThan(0);
    },
    BUDGET,
  );

  it(
    "are not sent when MARFA_ERROR_REPORTING_ENABLED is false",
    async () => {
      await faultAndStop(
        await boot((receiver) => ({
          OTEL_EXPORTER_OTLP_ENDPOINT: receiver.OTEL_EXPORTER_OTLP_ENDPOINT!,
          MARFA_ERROR_REPORTING_ENABLED: "false",
        })),
      );
      expect(sinks!.trackedErrors).toEqual([]);
      expect(sinks!.sentExceptions()).toEqual([]);
    },
    BUDGET,
  );

  it(
    "are sent from the next fault once the PostHog settings are written, as PostHog's capture v1 takes them",
    async () => {
      const booted = await boot((receiver) => ({
        MARFA_POSTHOG_HOST: "",
        MARFA_POSTHOG_PROJECT_TOKEN: "",
        OTEL_EXPORTER_OTLP_ENDPOINT: receiver.OTEL_EXPORTER_OTLP_ENDPOINT!,
      }));
      const before = `exception-before-${randomUUID()}`;
      await fault(booted, before);
      const set = await configure(booted, {
        posthog_host: sinks!.env().MARFA_POSTHOG_HOST,
        posthog_project_token: TOKEN,
      });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      // The witness: the same fault, once the settings are written, is sent.
      const after = `exception-after-${randomUUID()}`;
      await fault(booted, after);
      await booted.stop();

      const sent = sinks!.sentExceptions();
      expect(sent.map((event) => event.properties.request_id)).toEqual([after]);
      expect(sinks!.trackedHeaders).toHaveLength(1);
      const headers = sinks!.trackedHeaders[0]!;
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers["content-type"]).toBe("application/json");
      expect(headers["user-agent"]).toMatch(/^marfa-server\//);
      expect(headers["posthog-sdk-info"]).toMatch(/^marfa-server\//);
      expect(headers["posthog-attempt"]).toBe("1");
      expect(headers["posthog-request-id"]).toMatch(UUID);
      expect(
        Number.isNaN(Date.parse(String(headers["posthog-request-timestamp"]))),
      ).toBe(false);

      const body = sinks!.trackedErrors[0]!;
      expect(body).not.toHaveProperty("api_key");
      expect(Number.isNaN(Date.parse(String(body.created_at)))).toBe(false);
      expect(JSON.stringify(body)).not.toContain(TOKEN);
      const event = sent[0]!;
      expect(event.uuid).toMatch(UUID);
      expect(typeof event.distinct_id).toBe("string");
      expect(typeof event.timestamp).toBe("string");
      expect(event.options).toEqual({ process_person_profile: false });
    },
    BUDGET,
  );

  it(
    "name the trace and the span of the request that failed, where traces are exported",
    async () => {
      await faultAndStop(
        await boot((receiver) => ({
          OTEL_EXPORTER_OTLP_ENDPOINT: receiver.OTEL_EXPORTER_OTLP_ENDPOINT!,
        })),
      );
      const [event] = sinks!.sentExceptions();
      expect(event).toBeDefined();
      const traceId = event!.properties.$trace_id;
      const spanId = event!.properties.$span_id;
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(spanId).toMatch(/^[0-9a-f]{16}$/);
      type Batch = {
        resourceSpans: {
          scopeSpans: { spans: { traceId: string; spanId: string }[] }[];
        }[];
      };
      const spans = (sinks!.traces as unknown as Batch[]).flatMap((batch) =>
        batch.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) => scope.spans),
        ),
      );
      expect(spans).toContainEqual(
        expect.objectContaining({ traceId, spanId }),
      );
    },
    BUDGET,
  );
});

describe("the PostHog settings", () => {
  it(
    "refuse a posthog_host the token may not travel to, without repeating it",
    async () => {
      const booted = await bootFreshServer("posthog-host-refused");
      server = booted;
      for (const host of [
        "http://posthog.example.test",
        "http://user:hush@127.0.0.1:9",
        "https://user:hush@posthog.example.test",
        "https://user@posthog.example.test",
        "ftp://posthog.example.test",
        "posthog.example.test",
      ]) {
        const refused = await configure(booted, {
          posthog_host: host,
          posthog_project_token: TOKEN,
        });
        expect(refused.status, host).toBe(400);
        const said = JSON.stringify(refused.body);
        expect(said, host).toContain("validation_error");
        expect(said, host).toContain("posthog_host");
        expect(said, host).not.toContain("hush");
        expect(said, host).not.toContain("posthog.example");
      }
      const padded = await configure(booted, {
        posthog_host: "https://posthog.example.test",
        posthog_project_token: ` ${TOKEN} `,
      });
      expect(padded.status).toBe(400);
      expect(JSON.stringify(padded.body)).toContain("posthog_project_token");
      expect(JSON.stringify(padded.body)).not.toContain(TOKEN);
      expect(await secretsSet(booted)).not.toContain("posthog_host");

      // The witness: an https host with no login, and one on this machine,
      // are each taken with the same token.
      for (const host of [
        "https://posthog.example.test",
        "http://127.0.0.1:9",
      ]) {
        const taken = await configure(booted, {
          posthog_host: host,
          posthog_project_token: TOKEN,
        });
        expect(taken.status, JSON.stringify(taken.body)).toBe(200);
      }
      expect(await secretsSet(booted)).toEqual(
        expect.arrayContaining(["posthog_host", "posthog_project_token"]),
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuse one PostHog setting without the other, and take and remove both in one write",
    async () => {
      const booted = await bootFreshServer("posthog-pair");
      server = booted;
      const host = "https://posthog.example.test";
      for (const [alone, other] of [
        [{ posthog_host: host }, "posthog_project_token"],
        [{ posthog_project_token: TOKEN }, "posthog_host"],
      ] as const) {
        const refused = await configure(booted, alone);
        expect(refused.status).toBe(400);
        const said = JSON.stringify(refused.body);
        expect(said).toContain(other);
        expect(said).not.toContain("posthog.example");
        expect(said).not.toContain(TOKEN);
      }
      const posthog = ["posthog_host", "posthog_project_token"];
      for (const key of posthog) {
        expect(await secretsSet(booted)).not.toContain(key);
      }

      const both = await configure(booted, {
        posthog_host: host,
        posthog_project_token: TOKEN,
      });
      expect(both.status, JSON.stringify(both.body)).toBe(200);
      expect(await secretsSet(booted)).toEqual(expect.arrayContaining(posthog));
      for (const key of posthog) {
        const removed = await configure(booted, { [key]: null });
        expect(removed.status, key).toBe(400);
        expect(await secretsSet(booted)).toEqual(
          expect.arrayContaining(posthog),
        );
      }
      const cleared = await configure(booted, {
        posthog_host: null,
        posthog_project_token: null,
      });
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      for (const key of posthog) {
        expect(await secretsSet(booted)).not.toContain(key);
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

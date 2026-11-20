import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ownerOf } from "../../utils/backups.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { startFaultSinks, type FaultSinks } from "../../utils/fault-sinks.js";
import { clientsFor, everythingClient } from "../../utils/own-blob-server.js";

/**
 * Traces and log records are set by stored settings, which a write to
 * `/config` changes with no restart: the endpoints, the headers and the
 * switch `telemetry_enabled`. The server reads no `OTEL_*` variable, so a
 * platform's variable never overrides them. A restore carries no secret
 * value, so it leaves telemetry off and says so.
 *
 * **A server of its own for each case, with a receiver the fixture runs.** A
 * stop sends what the server holds under settings that did not change, so
 * each case reads what arrived once the server has stopped. A change drops
 * what was queued before it, so a case notes the moment its change was
 * answered and counts only what reached the receiver after. A post already
 * past the exporter's check may still arrive after that moment, and the
 * statement allows it.
 */
const started: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  for (const one of started.splice(0).reverse()) await one.stop();
}, 3 * FRESH_SERVER_TIMEOUT_MS);

const BUDGET = 3 * FRESH_SERVER_TIMEOUT_MS;

async function receiver(): Promise<FaultSinks> {
  const sinks = await startFaultSinks();
  started.push({ stop: () => sinks.close() });
  return sinks;
}

async function boot(
  name: string,
  env: Record<string, string> = {},
): Promise<FreshServer> {
  // Every trace, so a request that succeeds is exported too.
  const server = await bootFreshServer(name, {
    MARFA_OTEL_SAMPLE_RATIO: "1",
    ...env,
  });
  started.push(server);
  return server;
}

/** A write to `/config` through a key holding `config.manage`. */
async function configure(
  server: FreshServer,
  changes: Record<string, unknown>,
): Promise<{ status: number; text: string }> {
  const answer = await fetch(`${server.apiUrl}/config`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${server.managementKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(changes),
  });
  return { status: answer.status, text: await answer.text() };
}

async function configured(
  server: FreshServer,
  changes: Record<string, unknown>,
): Promise<void> {
  const answer = await configure(server, changes);
  expect(answer.status, answer.text).toBe(200);
}

/** A write under `requestId` that lands. */
async function write(server: FreshServer, requestId: string): Promise<void> {
  const answer = await fetch(`${server.apiUrl}/items`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${server.workingKey}`,
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
    },
    body: JSON.stringify({ type: "core.note", properties: { body: "x" } }),
  });
  expect(answer.status).toBe(201);
}

/** A write under `requestId` that ends in an unhandled fault. */
async function fault(server: FreshServer, requestId: string): Promise<void> {
  await server.setFault("fail:audit=item.create");
  const answer = await fetch(`${server.apiUrl}/items`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${server.workingKey}`,
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
    },
    body: JSON.stringify({ type: "core.note", properties: { body: "x" } }),
  });
  await server.clearFault();
  expect(answer.status).toBe(500);
}

/**
 * The value of header `name` on each OTLP post of `signal` that names
 * `requestId`, that reached the receiver after `after`.
 */
function carried(
  sinks: FaultSinks,
  signal: "traces" | "logs",
  requestId: string,
  name: string,
  after = -Infinity,
): (string | undefined)[] {
  return sinks.exports
    .filter(
      (post) =>
        post.arrivedAt > after &&
        post.signal === signal &&
        JSON.stringify(post.body).includes(`"${requestId}"`),
    )
    .map((post) => {
      const value = post.headers[name];
      return Array.isArray(value) ? value.join(",") : value;
    });
}

/** Whether a batch that reached the receiver after `after` reported `requestId`. */
function exceptionOf(
  sinks: FaultSinks,
  requestId: string,
  after = -Infinity,
): boolean {
  type Batch = { batch: { properties?: { request_id?: unknown } }[] };
  return (sinks.trackedErrors as Batch[])
    .filter((_, at) => sinks.trackedArrivals[at]! > after)
    .flatMap((post) => post.batch)
    .some((event) => event.properties?.request_id === requestId);
}

describe("the telemetry settings", () => {
  it(
    "send the next trace and log record with the endpoint and headers a write to /config just set, with no restart, and drop those queued before it",
    async () => {
      const sinks = await receiver();
      const origin = sinks.serverEnv().MARFA_OTEL_EXPORTER_OTLP_ENDPOINT!;
      const server = await boot("telemetry-settings-follow");
      const unset = `unset-${randomUUID()}`;
      await write(server, unset);
      await configured(server, {
        otel_exporter_otlp_endpoint: origin,
        otel_exporter_otlp_headers: "authorization=Bearer%20one,x-team=core",
        otel_exporter_otlp_logs_headers: "x-team=logs",
      });
      const first = `first-${randomUUID()}`;
      await write(server, first);
      await configured(server, {
        otel_exporter_otlp_headers: "authorization=Bearer%20two,x-team=core",
      });
      // Taken once the change is answered: a batch may leave on its own
      // before it.
      const changed = performance.now();
      const second = `second-${randomUUID()}`;
      await write(server, second);
      await server.stop();

      // The witness: the write after the change, held until the stop, arrives.
      for (const signal of ["traces", "logs"] as const) {
        expect(carried(sinks, signal, second, "authorization")).toEqual([
          "Bearer two",
        ]);
      }
      expect(carried(sinks, "traces", second, "x-team")).toEqual(["core"]);
      expect(carried(sinks, "logs", second, "x-team")).toEqual(["logs"]);
      for (const signal of ["traces", "logs"] as const) {
        expect(carried(sinks, signal, unset, "authorization")).toEqual([]);
        // Queued under the headers the change replaced, the first write is
        // dropped: whatever of it arrived went before the change.
        expect(carried(sinks, signal, first, "authorization", changed)).toEqual(
          [],
        );
        for (const value of carried(sinks, signal, first, "authorization")) {
          expect(value).toBe("Bearer one");
        }
      }
    },
    BUDGET,
  );

  it(
    "send nothing while telemetry_enabled is false, drop what was queued before it went off, and send again once it is true, with no setting written again",
    async () => {
      const sinks = await receiver();
      const server = await boot("telemetry-settings-switch", sinks.serverEnv());
      const queued = `queued-${randomUUID()}`;
      await fault(server, queued);
      await configured(server, { telemetry_enabled: false });
      const switched = performance.now();
      const off = `switched-off-${randomUUID()}`;
      await fault(server, off);
      await configured(server, { telemetry_enabled: true });
      const on = `switched-on-${randomUUID()}`;
      await fault(server, on);
      await server.stop();

      // The witness: the same fault, once the switch is on, sends all three.
      expect(carried(sinks, "traces", on, "content-type")).not.toEqual([]);
      expect(carried(sinks, "logs", on, "content-type")).not.toEqual([]);
      expect(exceptionOf(sinks, on)).toBe(true);
      expect(carried(sinks, "traces", off, "content-type")).toEqual([]);
      expect(carried(sinks, "logs", off, "content-type")).toEqual([]);
      expect(exceptionOf(sinks, off)).toBe(false);
      // Queued before the switch went off, the first fault is dropped:
      // whatever of it arrived went before the switch.
      for (const signal of ["traces", "logs"] as const) {
        expect(
          carried(sinks, signal, queued, "content-type", switched),
        ).toEqual([]);
      }
      expect(exceptionOf(sinks, queued, switched)).toBe(false);
    },
    BUDGET,
  );

  it(
    "send as the stored settings say whatever OTEL_* variables the environment sets, and warn of each by name",
    async () => {
      const sinks = await receiver();
      const planted = await receiver();
      const plantedOrigin =
        planted.serverEnv().MARFA_OTEL_EXPORTER_OTLP_ENDPOINT!;
      const plantedValue = `planted-${randomUUID()}`;
      const variables: Record<string, string> = {
        OTEL_SDK_DISABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: plantedOrigin,
        OTEL_EXPORTER_OTLP_HEADERS: `authorization=${plantedValue},content-type=application/x-planted`,
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: `x-planted=${plantedValue},content-type=application/x-planted`,
        OTEL_TRACES_SAMPLER: "always_off",
        OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT: "0",
        OTEL_SERVICE_NAME: plantedValue,
        OTEL_RESOURCE_ATTRIBUTES: `team=${plantedValue}`,
      };
      const server = await boot("telemetry-settings-environment", {
        ...sinks.serverEnv(),
        MARFA_OTEL_EXPORTER_OTLP_HEADERS: "authorization=stored",
        ...variables,
      });
      const requestId = `planted-around-${randomUUID()}`;
      await fault(server, requestId);
      const log = await server.output();
      await server.stop();

      // The witness: the stored settings send all three, so a planted one
      // that took their place would show.
      for (const signal of ["traces", "logs"] as const) {
        expect(carried(sinks, signal, requestId, "authorization")).toEqual([
          "stored",
        ]);
        expect(carried(sinks, signal, requestId, "x-planted")).toEqual([
          undefined,
        ]);
        expect(carried(sinks, signal, requestId, "content-type")).toEqual([
          "application/json",
        ]);
      }
      expect(exceptionOf(sinks, requestId)).toBe(true);
      const exported = JSON.stringify(sinks.exports.map((post) => post.body));
      expect(exported).toContain("marfa.request_id");
      expect(exported).not.toContain(plantedValue);
      expect(JSON.stringify(sinks.sentExceptions())).not.toContain(
        plantedValue,
      );
      expect(planted.exports).toEqual([]);
      expect(planted.trackedErrors).toEqual([]);

      const warned = log
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.level === "warn");
      for (const name of Object.keys(variables)) {
        expect(
          warned.filter((line) => line.setting === name),
          name,
        ).toHaveLength(1);
      }
      expect(log).not.toContain(plantedValue);
    },
    BUDGET,
  );

  it(
    "refuse a signal endpoint without the base, and a value outside its rule, without repeating a secret",
    async () => {
      const server = await boot("telemetry-settings-refused");
      const alone = await configure(server, {
        otel_exporter_otlp_traces_endpoint: "https://hush.example.test/in",
      });
      expect(alone.status).toBe(400);
      expect(alone.text).toContain("validation_error");
      expect(alone.text).toContain("otel_exporter_otlp_traces_endpoint");
      expect(alone.text).not.toContain("hush");

      for (const [key, value] of [
        ["otel_exporter_otlp_endpoint", "ftp://hush.example.test"],
        ["otel_exporter_otlp_endpoint", "hush.example.test:4318"],
        ["otel_exporter_otlp_logs_endpoint", "not a url hush"],
        ["otel_exporter_otlp_headers", "authorization=hush%zz"],
        ["otel_exporter_otlp_traces_headers", "hush"],
        ["otel_exporter_otlp_logs_headers", " authorization=hush"],
        ["otel_resource_attributes", "team"],
        ["otel_sample_ratio", 1.0001],
        ["otel_sample_ratio", -0.5],
        ["otel_sample_ratio", "0.5"],
      ] as const) {
        const refused = await configure(server, { [key]: value });
        expect(refused.status, `${key} ${String(value)}`).toBe(400);
        expect(refused.text).toContain("validation_error");
        expect(refused.text).toContain(key);
        expect(refused.text).not.toContain("hush");
      }

      // The witness: the same settings, inside their rules and with the base,
      // are taken, and the signal's endpoint cannot outlive the base.
      await configured(server, {
        otel_exporter_otlp_endpoint: "https://collector.example.test/?t=hush",
        otel_exporter_otlp_traces_endpoint: "https://hush.example.test/in",
        otel_exporter_otlp_headers: "authorization=Bearer%20hush",
        otel_resource_attributes: "team=a%20b",
        otel_sample_ratio: 0.25,
      });
      const orphaned = await configure(server, {
        otel_exporter_otlp_endpoint: null,
      });
      expect(orphaned.status).toBe(400);
      expect(orphaned.text).toContain("otel_exporter_otlp_endpoint");
      expect(orphaned.text).not.toContain("hush");
      await configured(server, {
        otel_exporter_otlp_endpoint: null,
        otel_exporter_otlp_traces_endpoint: null,
      });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "restore with telemetry off and say so, and send again once the settings are set again, with no restart",
    async () => {
      const sinks = await receiver();
      const origin = sinks.serverEnv().MARFA_OTEL_EXPORTER_OTLP_ENDPOINT!;
      const from = await boot("telemetry-settings-restore-origin");
      await configured(from, {
        otel_exporter_otlp_endpoint: origin,
        otel_exporter_otlp_headers: "authorization=Bearer%20archived",
      });
      const archive = await (
        await everythingClient(from)
      ).exportArchive({ state: "any", files: "false" });
      expect(archive.status).toBe(200);
      await from.stop();

      const target = await boot("telemetry-settings-restore-target");
      const restored = await ownerOf(target).restoreArchive(
        new Uint8Array(archive.data),
      );
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      const keys = [
        "otel_exporter_otlp_endpoint",
        "otel_exporter_otlp_headers",
      ];
      expect(restored.data.secrets_to_set).toEqual(keys);
      const note = restored.data.not_restored.at(-1);
      expect(note?.kind).toBe("telemetry");
      for (const key of keys) expect(note?.message).toContain(key);
      const unsent = `restored-${randomUUID()}`;
      await write(target, unsent);

      const set = await clientsFor(target).operator.patchConfig({
        otel_exporter_otlp_endpoint: origin,
        otel_exporter_otlp_headers: "authorization=Bearer%20again",
      });
      expect(set.status, JSON.stringify(set.error)).toBe(200);
      const sent = `set-again-${randomUUID()}`;
      await write(target, sent);
      await target.stop();

      // The witness: the write once the settings are set again arrives.
      expect(carried(sinks, "traces", sent, "authorization")).toEqual([
        "Bearer again",
      ]);
      expect(carried(sinks, "traces", unsent, "authorization")).toEqual([]);
      expect(carried(sinks, "logs", unsent, "authorization")).toEqual([]);
    },
    BUDGET,
  );
});

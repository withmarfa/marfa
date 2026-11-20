import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  startFaultSinks,
  until,
  type FaultSinks,
} from "../../utils/fault-sinks.js";

/**
 * Metrics are set by the same stored settings as traces and log records. A
 * server collects them once a minute, which no fixture waits for: a stop
 * sends one last collection, so each case reads what arrived once the server
 * has stopped.
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
  const server = await bootFreshServer(name, env);
  started.push(server);
  return server;
}

async function configured(
  server: FreshServer,
  changes: Record<string, unknown>,
): Promise<void> {
  const answer = await fetch(`${server.apiUrl}/config`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${server.managementKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(changes),
  });
  expect(answer.status, await answer.text()).toBe(200);
}

type Value = { stringValue?: string; intValue?: number | string };
type Attributes = { key: string; value: Value }[];
type Point = {
  attributes?: Attributes;
  count?: number | string;
  explicitBounds?: number[];
  asInt?: number | string;
};
type Metric = {
  name: string;
  unit?: string;
  histogram?: { dataPoints: Point[]; aggregationTemporality: number };
  sum?: {
    dataPoints: Point[];
    aggregationTemporality: number;
    isMonotonic?: boolean;
  };
};
type Batch = {
  resourceMetrics: {
    resource: { attributes: Attributes };
    scopeMetrics: { metrics: Metric[] }[];
  }[];
};

/** What the receiver was sent as metrics. */
function metricsOf(sinks: FaultSinks): {
  resource: Record<string, string>;
  metric: Metric;
}[] {
  return (sinks.metrics as unknown as Batch[]).flatMap((batch) =>
    batch.resourceMetrics.flatMap((resource) =>
      resource.scopeMetrics.flatMap((scope) =>
        scope.metrics.map((metric) => ({
          resource: plain(resource.resource.attributes),
          metric,
        })),
      ),
    ),
  );
}

function plain(attributes: Attributes | undefined): Record<string, string> {
  return Object.fromEntries(
    (attributes ?? []).map(({ key, value }) => [
      key,
      String(value.stringValue ?? value.intValue),
    ]),
  );
}

/** The header `name` of each metrics post. */
function carried(sinks: FaultSinks, name: string): (string | undefined)[] {
  return sinks.exports
    .filter((post) => post.signal === "metrics")
    .map((post) => {
      const value = post.headers[name];
      return Array.isArray(value) ? value.join(",") : value;
    });
}

/** An id of the shape the server takes, which names no item. */
function missingId(): string {
  const time = Date.now().toString(16).padStart(12, "0");
  const random = randomBytes(10).toString("hex");
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(3, 6)}-${random.slice(6, 18)}`;
}

async function describedBy(
  server: FreshServer,
): Promise<{ instance_id: string; version: string }> {
  const response = await fetch(`${server.apiUrl}/`, {
    headers: { Accept: "application/json" },
  });
  return (await response.json()) as { instance_id: string; version: string };
}

/** A request with a method `fetch` does not take, answered whatever it is. */
function ask(server: FreshServer, method: string, path: string): Promise<void> {
  const url = new URL(path, server.apiUrl);
  return new Promise((resolve, reject) => {
    const sent = httpRequest(url, { method }, (answer: IncomingMessage) => {
      answer.resume();
      answer.on("end", resolve);
    });
    sent.on("error", reject);
    sent.end();
  });
}

describe("the metrics", () => {
  it(
    "export the request duration and the process memory to the base endpoint when the server stops, with the unit, attributes and resource of each",
    async () => {
      const sinks = await receiver();
      const server = await boot("telemetry-metrics-export", {
        ...sinks.serverEnv(),
        // No trace is kept, and every request is still counted.
        MARFA_OTEL_SAMPLE_RATIO: "0",
        MARFA_OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=test,team=a",
      });
      const { instance_id: instanceId, version } = await describedBy(server);
      const auth = { Authorization: `Bearer ${server.workingKey}` };
      for (let each = 0; each < 3; each += 1) {
        const missing = await fetch(`${server.apiUrl}/items/${missingId()}`, {
          headers: auth,
        });
        expect(missing.status).toBe(404);
      }
      for (let each = 0; each < 2; each += 1) {
        expect((await fetch(`${server.apiUrl}/health`)).status).toBe(200);
      }
      const unrouted = await fetch(
        `${server.apiUrl}/no/such/place/${randomUUID()}`,
      );
      expect(unrouted.status).toBe(404);
      await ask(server, "PURGE", "/health");
      // A request that fails before it streams is recorded, and the stream
      // that follows is not.
      const refused = await fetch(`${server.apiUrl}/events`);
      expect(refused.status).toBe(401);
      const stream = await fetch(`${server.apiUrl}/events`, { headers: auth });
      expect(stream.status).toBe(200);
      const reader = stream.body!.getReader();
      await reader.read();
      await reader.cancel();
      // Nothing has been sent before the stop, which is the first collection.
      expect(sinks.metrics).toEqual([]);
      await server.stop();

      const sent = metricsOf(sinks);
      const named = (name: string) =>
        sent.filter(({ metric }) => metric.name === name);
      const duration = named("http.server.request.duration");
      expect(duration).not.toEqual([]);
      for (const { resource } of sent) {
        expect(resource["service.name"]).toBe("marfa-server");
        expect(resource["service.instance.id"]).toBe(instanceId);
        expect(resource["service.version"]).toBe(version);
        expect(resource.team).toBe("a");
      }

      const points = duration.flatMap(({ metric }) => {
        expect(metric.unit).toBe("s");
        const histogram = metric.histogram!;
        // 2 is cumulative.
        expect(histogram.aggregationTemporality).toBe(2);
        return histogram.dataPoints;
      });
      for (const point of points) {
        expect(point.explicitBounds).toEqual([
          0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5,
          10,
        ]);
        const keys = (point.attributes ?? []).map(({ key }) => key).sort();
        expect(
          keys.every((key) =>
            [
              "http.request.method",
              "http.response.status_code",
              "http.route",
            ].includes(key),
          ),
          keys.join(),
        ).toBe(true);
      }
      const series = points.map((point) => ({
        labels: plain(point.attributes),
        count: Number(point.count),
      }));
      const of = (match: Record<string, string>) =>
        series.filter((one) =>
          Object.entries(match).every(
            ([key, value]) => one.labels[key] === value,
          ),
        );
      const counted = (match: Record<string, string>) =>
        of(match).reduce((total, one) => total + one.count, 0);

      // The witness: the same requests are all there, so a missing one is
      // left out and not lost.
      expect(
        counted({
          "http.request.method": "GET",
          "http.route": "/items/{id}",
          "http.response.status_code": "404",
        }),
      ).toBe(3);
      expect(
        counted({ "http.route": "/health", "http.request.method": "GET" }),
      ).toBeGreaterThanOrEqual(2);
      expect(
        series.some((one) =>
          /[0-9a-f]{8}-[0-9a-f]{4}/.test(JSON.stringify(one.labels)),
        ),
      ).toBe(false);
      const unmatched = series.filter(
        (one) =>
          one.labels["http.route"] === undefined &&
          one.labels["http.request.method"] === "GET" &&
          one.labels["http.response.status_code"] === "404",
      );
      expect(unmatched.reduce((total, one) => total + one.count, 0)).toBe(1);
      expect(of({ "http.request.method": "_OTHER" })).not.toEqual([]);
      expect(
        series.some((one) => one.labels["http.request.method"] === "PURGE"),
      ).toBe(false);
      const events = of({ "http.route": "/events" });
      expect(
        events.map((one) => one.labels["http.response.status_code"]),
      ).toEqual(["401"]);

      const memory = named("process.memory.usage");
      expect(memory).not.toEqual([]);
      for (const { metric } of memory) {
        expect(metric.unit).toBe("By");
        expect(metric.sum!.aggregationTemporality).toBe(2);
        for (const point of metric.sum!.dataPoints) {
          expect(Number(point.asInt)).toBeGreaterThan(1_000_000);
        }
      }
    },
    BUDGET,
  );

  it(
    "export no metric while the base endpoint is unset or telemetry_enabled is false",
    async () => {
      const sinks = await receiver();
      const touch = async (server: FreshServer) => {
        const answer = await fetch(`${server.apiUrl}/health`);
        expect(answer.status).toBe(200);
      };

      const off = await boot("telemetry-metrics-off", sinks.serverEnv());
      await configured(off, { telemetry_enabled: false });
      await touch(off);
      await off.stop();
      expect(sinks.metrics).toEqual([]);

      // A stored value removed falls back to a seed, so the endpoint is stored.
      const unset = await boot("telemetry-metrics-unset");
      await configured(unset, {
        otel_exporter_otlp_endpoint:
          sinks.serverEnv().MARFA_OTEL_EXPORTER_OTLP_ENDPOINT,
      });
      await configured(unset, { otel_exporter_otlp_endpoint: null });
      await touch(unset);
      await unset.stop();
      expect(sinks.metrics).toEqual([]);

      // The witness: with the endpoint and the switch left as they were, the
      // same request is exported at the stop.
      const on = await boot("telemetry-metrics-on", sinks.serverEnv());
      await touch(on);
      await on.stop();
      expect(sinks.metrics).not.toEqual([]);
    },
    BUDGET,
  );

  it(
    "use the metrics endpoint and headers a write to /config sets, and send what follows a change as the settings then say",
    async () => {
      const base = await receiver();
      const own = await receiver();
      const server = await boot("telemetry-metrics-settings");
      await configured(server, {
        otel_exporter_otlp_endpoint:
          base.serverEnv().MARFA_OTEL_EXPORTER_OTLP_ENDPOINT,
        otel_exporter_otlp_headers:
          "authorization=Bearer%20general,x-team=core",
        otel_exporter_otlp_metrics_endpoint: `${own.serverEnv().MARFA_OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`,
        otel_exporter_otlp_metrics_headers: "x-team=one",
      });
      await fetch(`${server.apiUrl}/health`);
      await configured(server, {
        otel_exporter_otlp_metrics_headers: "x-team=two",
      });
      await fetch(`${server.apiUrl}/health`);
      await server.stop();

      // The witness: the metrics arrive at the endpoint of their own.
      expect(carried(own, "x-team")).not.toEqual([]);
      for (const value of carried(own, "x-team")) expect(value).toBe("two");
      for (const value of carried(own, "authorization")) {
        expect(value).toBe("Bearer general");
      }
      expect(base.metrics).toEqual([]);
    },
    BUDGET,
  );

  it(
    "send metrics as the stored settings say whatever OTEL_* variables the environment sets",
    async () => {
      const sinks = await receiver();
      const planted = await receiver();
      const plantedOrigin =
        planted.serverEnv().MARFA_OTEL_EXPORTER_OTLP_ENDPOINT!;
      const plantedValue = `planted-${randomUUID()}`;
      const server = await boot("telemetry-metrics-environment", {
        ...sinks.serverEnv(),
        MARFA_OTEL_EXPORTER_OTLP_HEADERS: "authorization=stored",
        OTEL_METRIC_EXPORT_INTERVAL: "100",
        OTEL_METRIC_EXPORT_TIMEOUT: "100",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${plantedOrigin}/v1/metrics`,
        OTEL_EXPORTER_OTLP_METRICS_HEADERS: `authorization=${plantedValue},x-planted=${plantedValue}`,
        OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta",
        OTEL_METRICS_EXEMPLAR_FILTER: "always_on",
      });
      const missing = await fetch(`${server.apiUrl}/items/${missingId()}`, {
        headers: { Authorization: `Bearer ${server.workingKey}` },
      });
      expect(missing.status).toBe(404);
      // A log record of a failed read leaves a second after its request, far past
      // the planted interval of a tenth of a second.
      await until("the log record", () =>
        sinks.logRecords.length > 0 ? true : undefined,
      );
      expect(sinks.metrics).toEqual([]);
      await server.stop();

      // The witness: the stop sends them, as the stored settings say.
      expect(carried(sinks, "authorization")).toEqual(["stored"]);
      expect(carried(sinks, "x-planted")).toEqual([undefined]);
      for (const { metric } of metricsOf(sinks)) {
        const aggregated = metric.histogram ?? metric.sum!;
        expect(aggregated.aggregationTemporality).toBe(2);
      }
      expect(JSON.stringify(sinks.metrics)).not.toContain(plantedValue);
      expect(planted.exports).toEqual([]);
    },
    BUDGET,
  );
});

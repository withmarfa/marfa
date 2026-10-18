import { createServer } from "node:http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { expect, it } from "vitest";
import * as clock from "../clock.js";
import { realTimeExporter } from "./real-time-exporter.js";

it.each([
  ["logs", OTLPLogExporter],
  ["traces", OTLPTraceExporter],
] as const)(
  "honors a real collector's HTTP retry date for %s",
  async (_kind, Exporter) => {
    const realNow = Date.now.bind(Date);
    let retryAt = 0;
    const arrivals: number[] = [];
    const collector = createServer((request, response) => {
      request.resume();
      arrivals.push(realNow());
      if (arrivals.length === 1) {
        retryAt = Math.floor((realNow() + 2500) / 1000) * 1000;
        response.writeHead(503, {
          "retry-after": new Date(retryAt).toUTCString(),
        });
      } else {
        response.writeHead(200, { "content-type": "application/json" });
      }
      response.end("{}");
    });
    await new Promise<void>((resolve) =>
      collector.listen(0, "127.0.0.1", resolve),
    );
    const address = collector.address();
    if (!address || typeof address === "string")
      throw new Error("No collector port");
    const exporter = realTimeExporter(
      new Exporter({
        url: `http://127.0.0.1:${String(address.port)}/export`,
        timeoutMillis: 10_000,
      }),
    );
    try {
      clock.installDateShim();
      clock.advanceClock(86_400_000);
      const result = await new Promise<{ code: number }>((resolve) => {
        exporter.export([], resolve);
      });
      expect(result.code).toBe(0);
      expect(arrivals).toHaveLength(2);
      expect(arrivals[1]).toBeGreaterThanOrEqual(retryAt - 50);
    } finally {
      await exporter.shutdown();
      clock.resetClockForTests();
      await new Promise<void>((resolve, reject) =>
        collector.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  },
);

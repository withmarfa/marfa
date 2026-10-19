import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import * as clock from "../clock.js";

interface Exporter<T> {
  export(items: T[], callback: Parameters<SpanExporter["export"]>[1]): void;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}

export function realTimeExporter<T>(exporter: Exporter<T>): Exporter<T> {
  return {
    export: (items, callback) => {
      clock.withRealTime(() => {
        exporter.export(items, callback);
      });
    },
    shutdown: () => clock.withRealTime(() => exporter.shutdown()),
    forceFlush: () => clock.withRealTime(() => exporter.forceFlush()),
  };
}

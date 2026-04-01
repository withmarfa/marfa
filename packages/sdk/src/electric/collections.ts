import { ShapeStream } from "@electric-sql/client";
import type { Row } from "@electric-sql/client";

export interface ElectricConfig {
  url: string;
}

export interface ShapeStreams {
  items: ShapeStream;
  metadata: ShapeStream;
  threads: ShapeStream;
}

/** Create ShapeStream instances for each synced table. */
export function createShapeStreams(config: ElectricConfig): ShapeStreams {
  const baseUrl = `${config.url}/v1/shape`;

  return {
    items: new ShapeStream({
      url: baseUrl,
      params: { table: "items", replica: "full" },
    }),
    metadata: new ShapeStream({
      url: baseUrl,
      params: { table: "metadata", replica: "full" },
    }),
    threads: new ShapeStream({
      url: baseUrl,
      params: { table: "threads", replica: "full" },
    }),
  };
}

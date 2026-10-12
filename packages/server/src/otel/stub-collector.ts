import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

/** One value as OTLP/JSON writes it. */
interface OtlpValue {
  stringValue?: string;
  intValue?: string | number;
  boolValue?: boolean;
}

interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

export interface ReceivedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  status?: { code?: number };
  attributes: Record<string, string>;
  events: { name: string; attributes: Record<string, string> }[];
}

export interface ReceivedLogRecord {
  body: string;
  traceId?: string;
  spanId?: string;
  attributes: Record<string, string>;
}

export interface StubCollector {
  /** The base URL, which a test gives as the OTLP endpoint. */
  url: string;
  /** Each post as it arrived, in order. */
  posts: { path: string; text: string }[];
  spans: () => ReceivedSpan[];
  logRecords: () => ReceivedLogRecord[];
  close: () => Promise<void>;
}

function attributes(list: OtlpAttribute[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of list ?? []) {
    out[key] = String(
      value.stringValue ?? value.intValue ?? value.boolValue ?? "",
    );
  }
  return out;
}

/**
 * A local HTTP server that accepts OTLP/HTTP posts, as a collector does, and
 * keeps them for a test to read.
 */
export async function startStubCollector(): Promise<StubCollector> {
  const posts: { path: string; text: string }[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);
      posts.push({
        path: req.url ?? "",
        text:
          req.headers["content-encoding"] === "gzip"
            ? gunzipSync(raw).toString("utf8")
            : raw.toString("utf8"),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const bodies = (suffix: string): unknown[] =>
    posts
      .filter((post) => post.path.endsWith(suffix))
      .map((post) => JSON.parse(post.text) as unknown);

  return {
    url: `http://127.0.0.1:${String(port)}`,
    posts,
    spans: () =>
      bodies("/v1/traces").flatMap(
        (body) =>
          (
            body as {
              resourceSpans?: {
                scopeSpans?: {
                  spans?: (Omit<ReceivedSpan, "attributes" | "events"> & {
                    attributes?: OtlpAttribute[];
                    events?: { name: string; attributes?: OtlpAttribute[] }[];
                  })[];
                }[];
              }[];
            }
          ).resourceSpans?.flatMap((resource) =>
            (resource.scopeSpans ?? []).flatMap((scope) =>
              (scope.spans ?? []).map((span) => ({
                ...span,
                attributes: attributes(span.attributes),
                events: (span.events ?? []).map((event) => ({
                  name: event.name,
                  attributes: attributes(event.attributes),
                })),
              })),
            ),
          ) ?? [],
      ),
    logRecords: () =>
      bodies("/v1/logs").flatMap(
        (body) =>
          (
            body as {
              resourceLogs?: {
                scopeLogs?: {
                  logRecords?: {
                    body?: OtlpValue;
                    traceId?: string;
                    spanId?: string;
                    attributes?: OtlpAttribute[];
                  }[];
                }[];
              }[];
            }
          ).resourceLogs?.flatMap((resource) =>
            (resource.scopeLogs ?? []).flatMap((scope) =>
              (scope.logRecords ?? []).map((record) => ({
                body: record.body?.stringValue ?? "",
                traceId: record.traceId,
                spanId: record.spanId,
                attributes: attributes(record.attributes),
              })),
            ),
          ) ?? [],
      ),
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

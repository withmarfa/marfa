import { SpanKind, trace } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { guardStoreWithReadContext } from "../storage/sqlite/request-context.js";
import { createTestContext, request, type TestContext } from "../test-utils.js";
import { PiiRedactionSpanProcessor } from "./redaction.js";

const CANARY = "canary-content-6b3f0d92";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  // The same order the server registers them in: redact, then export.
  spanProcessors: [
    new PiiRedactionSpanProcessor(),
    new SimpleSpanProcessor(exporter),
  ],
});
provider.register();

afterEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

function inRequest<T>(run: () => Promise<T>): Promise<T> {
  return trace
    .getTracer("storage-span-test")
    .startActiveSpan("request", { kind: SpanKind.SERVER }, async (span) => {
      try {
        return await run();
      } finally {
        span.end();
      }
    });
}

const storageSpans = (): ReadableSpan[] =>
  exporter
    .getFinishedSpans()
    .filter((span) => span.attributes["marfa.storage.store"] !== undefined);

describe("a storage call's span", () => {
  const store = guardStoreWithReadContext(
    {
      async read(secret: string) {
        return await Promise.resolve(secret.length);
      },
      readNow(secret: string) {
        return secret.length * 2;
      },
      async refuse(secret: string) {
        await Promise.resolve();
        throw new MarfaError(ErrorCode.NOT_FOUND, `missing ${secret}`);
      },
      async fail(secret: string) {
        await Promise.resolve();
        throw new Error(
          `Failed query: insert into items (body) values (?)\nparams: ${secret}`,
        );
      },
    },
    "fixture",
  );

  it("is a child of the request's span, named for the store and the method", async () => {
    await inRequest(async () => {
      expect(await store.read(CANARY)).toBe(CANARY.length);
      expect(store.readNow(CANARY)).toBe(CANARY.length * 2);
    });
    const spans = exporter.getFinishedSpans();
    const root = spans.find((span) => span.name === "request");
    const calls = storageSpans();
    expect(calls.map((span) => span.name).sort()).toEqual([
      "fixture.read",
      "fixture.readNow",
    ]);
    for (const span of calls) {
      expect(span.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
      expect(span.attributes).toEqual({
        "db.system.name": "sqlite",
        "marfa.storage.store": "fixture",
        "marfa.storage.operation": span.name.split(".")[1],
      });
    }
  });

  it("carries no argument, and no text of a failure", async () => {
    await inRequest(async () => {
      await store.read(CANARY);
      await store.refuse(CANARY).catch(() => undefined);
      await store.fail(CANARY).catch(() => undefined);
    });
    // The witness: the failure the store raised does carry the value.
    await expect(store.fail(CANARY)).rejects.toThrow(CANARY);
    const text = JSON.stringify(
      exporter.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    );
    expect(storageSpans().length).toBeGreaterThan(0);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("Failed query");
  });

  it("marks a failure as an error, and a refusal the code chose as no error", async () => {
    await inRequest(async () => {
      await store.refuse(CANARY).catch(() => undefined);
      await store.fail(CANARY).catch(() => undefined);
    });
    const refused = storageSpans().find(
      (span) => span.name === "fixture.refuse",
    );
    const failed = storageSpans().find((span) => span.name === "fixture.fail");
    expect(refused?.status.code).toBe(SpanStatusCode.UNSET);
    expect(refused?.attributes["error.code"]).toBe(ErrorCode.NOT_FOUND);
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed?.attributes["error.type"]).toBe("Error");
  });

  it("makes no span outside a request", async () => {
    // The witness: the same call inside one makes a span.
    await inRequest(() => store.read(CANARY));
    expect(storageSpans()).toHaveLength(1);
    exporter.reset();

    await store.read(CANARY);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});

describe("the SQLite storage", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("gives a request that writes and reads an item spans for the transaction and its calls, and none of the item's content", async () => {
    await inRequest(async () => {
      const created = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.note",
          properties: { body: CANARY },
          tags: [CANARY],
        },
      });
      expect(created.status).toBe(201);
      const { item } = (await created.json()) as { item: { id: string } };
      const read = await request(ctx.app, "GET", `/items/${item.id}`, {
        key: ctx.workingKey,
      });
      expect(read.status).toBe(200);
    });

    const names = new Set(storageSpans().map((span) => span.name));
    expect(names).toContain("storage.runInTransaction");
    expect([...names].some((name) => name.startsWith("items."))).toBe(true);
    // Every one was redacted and exported with the request, and none says
    // what was stored.
    const text = JSON.stringify(
      exporter.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
      })),
    );
    expect(text).not.toContain(CANARY);
  });

  it("does not mark a transaction or a read snapshot as an error for what the route's callback throws", async () => {
    class RolledBack extends Error {}
    await inRequest(async () => {
      await ctx.storage
        .runInTransaction(() => {
          throw new RolledBack("a signal the route chose");
        })
        .catch(() => undefined);
      await ctx.storage
        .runInReadSnapshot(() => {
          throw new RolledBack("a signal the route chose");
        })
        .catch(() => undefined);
    });
    const spans = storageSpans().filter((span) =>
      span.name.startsWith("storage."),
    );
    expect(spans.map((span) => span.name).sort()).toEqual([
      "storage.runInReadSnapshot",
      "storage.runInTransaction",
    ]);
    for (const span of spans) {
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    }
  });

  it("still marks a store call that fails inside a transaction as the error, and not the transaction", async () => {
    await refuseInserts(ctx);
    try {
      await inRequest(async () => {
        await request(ctx.app, "POST", "/items", {
          key: ctx.workingKey,
          body: { type: "core.note", properties: { body: "plain" } },
        });
      });
    } finally {
      await allowInserts(ctx);
    }
    const spans = storageSpans();
    expect(
      spans.some(
        (span) =>
          span.name.startsWith("items.") &&
          span.status.code === SpanStatusCode.ERROR,
      ),
    ).toBe(true);
    expect(
      spans
        .filter((span) => span.name === "storage.runInTransaction")
        .every((span) => span.status.code === SpanStatusCode.UNSET),
    ).toBe(true);
  });
});

async function refuseInserts(ctx: TestContext): Promise<void> {
  await (
    ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    }
  ).__sqliteRun(
    "CREATE TRIGGER refuse_inserts BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT, 'refused by the fixture'); END",
    [],
  );
}

async function allowInserts(ctx: TestContext): Promise<void> {
  await (
    ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    }
  ).__sqliteRun("DROP TRIGGER refuse_inserts", []);
}

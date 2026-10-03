/**
 * Every way a webhook delivery leaves the server, and the two rules it obeys.
 *
 * **A census rather than a test per path, because a second path would pass
 * every test written for the first.** A delivery carries only what the
 * subscription's credential may read (`reach.ts`) and reaches only a public
 * address (`outbound-http.ts`). Both are kept by `deliverWebhookAttempt`,
 * which narrows before it posts and posts only through the checked client.
 * So the census reads the source: every module that opens an outbound
 * connection is named below with why, the checked client is posted to from
 * that one function and after the narrowing, and a delivery is queued only
 * where the narrowing is asked first. Then the whole path is driven against
 * a loopback receiver, which is what reading the source cannot prove.
 */
import { createServer, type Server } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
import { WebhookPoller } from "./delivery.js";
import { DELIVERY_FAILURE, createWebhookHttpClient } from "./outbound-http.js";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Modules that open outbound connections, each with why it may. */
const OUTBOUND: Record<string, string> = {
  "webhooks/outbound-http.ts":
    "the delivery client: the one way a webhook delivery reaches the network",
  "heartbeat.ts":
    "pings the liveness URL the operator configures; no credential names it",
  "middleware/error-notifier.ts":
    "posts 500 alerts to the URL the operator configures; no credential names it",
};

const OUTBOUND_PRIMITIVE =
  /\bfetch\(|globalThis\.fetch|^import (?!type)[^;]*from "(node:)?(http|https|http2|net|tls|undici)";/m;

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) return [];
    return [relative(SRC, path)];
  });
}

const read = (file: string): string => readFileSync(join(SRC, file), "utf8");

/** The text of the function `name` declares in `source`. */
function functionBody(source: string, name: string): string {
  const start = source.search(
    new RegExp(`(async )?function ${name}\\b|(?:private )?async ${name}\\(`),
  );
  expect(start, `function ${name}`).toBeGreaterThanOrEqual(0);
  const next = source
    .slice(start + 1)
    .search(/\n(export |async function |function | {2}private | {2}async |\})/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

describe("the outbound census", () => {
  it("names every module that opens an outbound connection", () => {
    const found = sourceFiles()
      .filter((file) => OUTBOUND_PRIMITIVE.test(read(file)))
      .sort();
    // The witness: the pattern finds the client itself.
    expect(found).toContain("webhooks/outbound-http.ts");
    expect(found).toEqual(Object.keys(OUTBOUND).sort());
  });

  it("posts a delivery from one function, after narrowing it to the credential", () => {
    const posts = sourceFiles().flatMap((file) =>
      [...read(file).matchAll(/\bhttp\.post\(/g)].map(() => file),
    );
    expect(posts).toEqual(["webhooks/delivery.ts"]);
    const attempt = functionBody(
      read("webhooks/delivery.ts"),
      "deliverWebhookAttempt",
    );
    const narrowed = attempt.indexOf("deliveryInReach(");
    const posted = attempt.indexOf("http.post(");
    expect(narrowed).toBeGreaterThan(0);
    expect(posted).toBeGreaterThan(narrowed);
    expect(
      functionBody(read("webhooks/delivery.ts"), "deliveryInReach"),
    ).toContain("frameInReach(");
  });

  it("queues a delivery only where the credential is asked first", () => {
    const queued = sourceFiles().flatMap((file) =>
      [...read(file).matchAll(/outboundWebhookDeliveries\.schedule\(/g)].map(
        () => file,
      ),
    );
    expect(queued).toEqual(["webhooks/delivery.ts"]);
    const dispatch = functionBody(read("webhooks/delivery.ts"), "runOnce");
    expect(dispatch.indexOf("frameInReach(")).toBeGreaterThan(0);
    expect(dispatch.indexOf("frameInReach(")).toBeLessThan(
      dispatch.indexOf("outboundWebhookDeliveries.schedule("),
    );
  });

  it("builds every client from the operator's setting", () => {
    const built = sourceFiles().flatMap((file) =>
      [...read(file).matchAll(/createWebhookHttpClient\(\{([^}]*)\}/g)].map(
        (m) => [file, (m[1] ?? "").trim()] as const,
      ),
    );
    expect(built.map(([file]) => file).sort()).toEqual([
      "housekeeping/registrations.ts",
    ]);
    for (const [, options] of built) {
      expect(options).toBe(
        "allowPrivateAddresses: config.webhookAllowPrivateAddresses ?? false,",
      );
    }
  });
});

describe("a delivery driven end to end", () => {
  let ctx: TestContext;
  let server: Server;
  let hits = 0;
  let port = 0;

  beforeAll(async () => {
    // Private addresses allowed at the door, so the subscription can name the
    // loopback receiver; the clients below decide what reaches it.
    ctx = await createTestContext({ webhookAllowPrivateAddresses: true });
    server = createServer((req, res) => {
      hits += 1;
      req.resume();
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        resolve();
      }),
    );
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("the receiver did not bind");
    }
    port = address.port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    await ctx.cleanup();
  });

  async function queued(url: string): Promise<{ webhookId: string }> {
    const res = await request(ctx.app, "POST", "/webhooks", {
      key: ctx.workingKey,
      body: { url, events: ["item.created"] },
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    await ctx.storage.outboundWebhookDeliveries.schedule({
      eventId: 1n,
      webhookId: id,
      eventType: "item.created",
      payload: JSON.stringify({
        type: "item.created",
        item: { id: "01HCENSUSCENSUSCENSUSCEN0", type: "core.note" },
      }),
      webhookUrl: url,
      nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
    });
    return { webhookId: id };
  }

  it("reaches a loopback receiver only through a client allowed to", async () => {
    const url = `http://127.0.0.1:${String(port)}/hook`;

    const refused = await queued(url);
    await new WebhookPoller({
      storage: ctx.storage,
      http: createWebhookHttpClient({ allowPrivateAddresses: false }),
    }).runOnce();
    expect(hits).toBe(0);
    const log = await ctx.storage.outboundWebhookDeliveries.list(
      refused.webhookId,
      { limit: 5 },
    );
    expect(log.data[0]).toMatchObject({
      succeeded: false,
      error: DELIVERY_FAILURE.notPublic,
    });

    // The witness: the same path reaches the receiver when allowed.
    await ctx.storage.outboundWebhooks.delete(refused.webhookId);
    const allowed = await queued(url);
    await new WebhookPoller({
      storage: ctx.storage,
      http: createWebhookHttpClient({ allowPrivateAddresses: true }),
    }).runOnce();
    expect(hits).toBe(1);
    const delivered = await ctx.storage.outboundWebhookDeliveries.list(
      allowed.webhookId,
      { limit: 5 },
    );
    expect(delivered.data[0]).toMatchObject({ succeeded: true });
  });
});

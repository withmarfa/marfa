import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStreamAtCursor } from "../../utils/stream.js";
import { waitFor } from "../../utils/wait.js";

/**
 * Each new entry in what needs the owner's attention is an event, on
 * `GET /events` and to webhooks, sent once. An entry here is a key that
 * expires within seven days, which the fixture can make at will. The list
 * is the instance's own, so the file boots a server of its own.
 */
let server: FreshServer;
let writer: string;

beforeAll(async () => {
  server = await bootFreshServer("attention-events");
  writer = (await mint({ type_permissions: { "core.note": "write" } })).key;
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function mint(
  body: Record<string, unknown>,
): Promise<{ id: string; key: string }> {
  const answer = await controlRequest(server.controlSocket, "/keys", {
    method: "POST",
    body: { label: "attention", source: `attention-${randomUUID()}`, ...body },
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body as unknown as { id: string; key: string };
}

/** A key that ends within the week, which the key check names. */
function ending(): Promise<{ id: string; key: string }> {
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
  return mint({
    type_permissions: { "core.note": "read" },
    expires_at: soon,
  });
}

async function check(): Promise<void> {
  const listed = await controlRequest(server.controlSocket, "/attention");
  expect(listed.status).toBe(200);
}

/** An item written after the thing under test, whose frame settles what came before it. */
async function sentinel(): Promise<string> {
  const response = await fetch(`${server.apiUrl}/items`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${writer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "core.note",
      properties: { title: `sentinel ${randomUUID()}` },
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { item: { id: string } }).item.id;
}

const attentionTo = (events: SseEvent[], reference: string) =>
  events.filter(
    (event) =>
      event.event === "attention.raised" &&
      (event.data as { attention?: { reference?: string } }).attention
        ?.reference === reference,
  );

const created = (events: SseEvent[], id: string) =>
  events.some(
    (event) =>
      event.event === "item.created" &&
      (event.data as { item?: { id?: string } }).item?.id === id,
  );

it("sends a new attention entry once on the stream of a credential holding instance.read, and to no other", async ({
  signal,
}) => {
  const reader = await mint({
    permissions: ["instance.read"],
    type_permissions: { "core.note": "read" },
  });
  const lacking = await mint({ type_permissions: { "core.note": "read" } });
  await withStreamAtCursor(
    server.apiUrl,
    reader.key,
    { signal },
    async (held) =>
      withStreamAtCursor(
        server.apiUrl,
        lacking.key,
        { signal },
        async (without) => {
          const first = await ending();
          await check();
          // A second check finds the same entry, which is not sent again.
          await check();
          const second = await ending();
          await check();
          const last = await sentinel();
          const seen = await collectUntil(
            held,
            (events) => created(events, last),
            "the sentinel note",
            signal,
          );
          const firstFrames = attentionTo(seen.events, first.id);
          expect(firstFrames).toHaveLength(1);
          expect(attentionTo(seen.events, second.id)).toHaveLength(1);
          expect(firstFrames[0]!.data).toMatchObject({
            event_type: "attention.raised",
            attention: { kind: "key", reference: first.id },
          });
          expect(
            Object.keys(
              (firstFrames[0]!.data as { attention: object }).attention,
            ).sort(),
          ).toEqual(["description", "kind", "reference", "title"]);
          const elsewhere = await collectUntil(
            without,
            (events) => created(events, last),
            "the sentinel note",
            signal,
          );
          expect(
            elsewhere.events.filter(
              (event) => event.event === "attention.raised",
            ),
          ).toEqual([]);
        },
      ),
  );
});

it("sends no attention entry on a stream that names a type", async ({
  signal,
}) => {
  const reader = await mint({
    permissions: ["instance.read"],
    type_permissions: { "core.note": "read" },
  });
  await withStreamAtCursor(
    server.apiUrl,
    reader.key,
    { signal, query: [["type", "core.note"]] },
    async (filtered) =>
      withStreamAtCursor(
        server.apiUrl,
        reader.key,
        { signal },
        async (whole) => {
          const key = await ending();
          await check();
          const last = await sentinel();
          // The witness: the same credential's unfiltered stream gets it.
          const seen = await collectUntil(
            whole,
            (events) => created(events, last),
            "the sentinel note",
            signal,
          );
          expect(attentionTo(seen.events, key.id)).toHaveLength(1);
          const narrowed = await collectUntil(
            filtered,
            (events) => created(events, last),
            "the sentinel note",
            signal,
          );
          expect(attentionTo(narrowed.events, key.id)).toEqual([]);
        },
      ),
  );
});

it("announces an entry from the attention-check job when nobody reads the list", async ({
  signal,
}) => {
  const reader = await mint({
    permissions: ["instance.read"],
    type_permissions: { "core.note": "read" },
  });
  await withStreamAtCursor(
    server.apiUrl,
    reader.key,
    { signal },
    async (stream) => {
      const key = await ending();
      const ran = await controlRequest(
        server.controlSocket,
        "/housekeeping/attention-check/run",
        { method: "POST" },
      );
      expect(ran.status, JSON.stringify(ran.body)).toBe(200);
      expect(ran.body).toMatchObject({
        outcome: "succeeded",
        result: { raised: 1 },
      });
      const last = await sentinel();
      const seen = await collectUntil(
        stream,
        (events) => created(events, last),
        "the sentinel note",
        signal,
      );
      expect(attentionTo(seen.events, key.id)).toHaveLength(1);
    },
  );
});

it("delivers a new attention entry to a webhook subscribed to attention.raised", async () => {
  const bodies: unknown[] = [];
  const receiver: Server = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (part: string) => (text += part));
    req.on("end", () => {
      bodies.push(JSON.parse(text));
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const maker = await mint({
      permissions: ["instance.read", "webhooks.manage"],
      type_permissions: { "core.note": "read" },
    });
    const made = await fetch(`${server.apiUrl}/webhooks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${maker.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: `http://127.0.0.1:${String(address.port)}/hook`,
        events: ["attention.raised"],
      }),
    });
    expect(made.status, await made.clone().text()).toBe(201);
    const key = await ending();
    await check();
    const delivered = await waitFor(
      "the webhook delivery of the new entry",
      async () =>
        bodies.find(
          (body) =>
            (body as { attention?: { reference?: string } }).attention
              ?.reference === key.id,
        ),
    );
    expect(delivered).toMatchObject({
      event_type: "attention.raised",
      attention: { kind: "key", reference: key.id },
    });
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
});

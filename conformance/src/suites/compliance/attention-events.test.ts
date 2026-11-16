import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * expires within seven days, which the fixture can make at will, or the
 * backup folder moved away, whose entry names its path. The list is the
 * instance's own, so the file boots a server of its own.
 */
let server: FreshServer;
let writer: string;
const backups = mkdtempSync(join(tmpdir(), "marfa-attention-events-"));

beforeAll(async () => {
  server = await bootFreshServer("attention-events", {
    MARFA_OBJECT_STORE_BUCKET: "",
    MARFA_BACKUP_PATH: backups,
  });
  writer = (await mint({ type_permissions: { "core.note": "write" } })).key;
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
  rmSync(backups, { recursive: true, force: true });
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
          ).toEqual(["description", "kind", "reference"]);
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

/** Runs `use` with a webhook subscribed to `attention.raised`, and the bodies it receives. */
async function withAttentionHook(
  use: (bodies: unknown[]) => Promise<void>,
): Promise<void> {
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
    await use(bodies);
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
}

const deliveredTo = (bodies: unknown[], reference: string) =>
  waitFor("the webhook delivery of the new entry", async () =>
    bodies.find(
      (body) =>
        (body as { attention?: { reference?: string } }).attention
          ?.reference === reference,
    ),
  );

it("delivers a new attention entry to a webhook subscribed to attention.raised", async () => {
  await withAttentionHook(async (bodies) => {
    const key = await ending();
    await check();
    expect(await deliveredTo(bodies, key.id)).toMatchObject({
      event_type: "attention.raised",
      attention: { kind: "key", reference: key.id },
    });
  });
});

it("sends an entry's kind, reference and a fixed description, never the path the list names", async ({
  signal,
}) => {
  const reader = await mint({
    permissions: ["instance.read"],
    type_permissions: { "core.note": "read" },
  });
  await withAttentionHook(async (bodies) =>
    withStreamAtCursor(
      server.apiUrl,
      reader.key,
      { signal },
      async (stream) => {
        const away = `${backups}-away`;
        renameSync(backups, away);
        try {
          // The witness: the list names the folder's path.
          const listed = await controlRequest(
            server.controlSocket,
            "/attention",
          );
          expect(listed.status).toBe(200);
          const store = (
            listed.body.data as {
              kind: string;
              reference: string;
              description: string;
            }[]
          ).find(
            (entry) => entry.kind === "backup" && entry.reference === "store",
          );
          expect(store?.description).toContain(backups);
          const last = await sentinel();
          const seen = await collectUntil(
            stream,
            (events) => created(events, last),
            "the sentinel note",
            signal,
          );
          const frames = attentionTo(seen.events, "store");
          expect(frames).toHaveLength(1);
          const sent = (
            frames[0]!.data as { attention: Record<string, string> }
          ).attention;
          expect(Object.keys(sent).sort()).toEqual([
            "description",
            "kind",
            "reference",
          ]);
          expect(sent.kind).toBe("backup");
          expect(sent.description).not.toBe(store?.description);
          expect(JSON.stringify(frames[0]!.data)).not.toContain(backups);
          const delivered = await deliveredTo(bodies, "store");
          expect(delivered).toMatchObject({ attention: sent });
          expect(JSON.stringify(delivered)).not.toContain(backups);
        } finally {
          renameSync(away, backups);
        }
      },
    ),
  );
});

it(
  "announces nothing from a check older than one that has since looked",
  { retry: 0 },
  async ({ signal }) => {
    // retry: 0 because a failed try leaves the hold set.
    const reader = await mint({
      permissions: ["instance.read"],
      type_permissions: { "core.note": "read" },
    });
    /** A check held at its write, and the answer it gives once let go. */
    const heldCheck = async () => {
      await server.setFault("hold:write=attention.check@1");
      const answer = controlRequest(server.controlSocket, "/attention");
      await server.waitForHold("hold:write");
      return { answer };
    };
    await withStreamAtCursor(
      server.apiUrl,
      reader.key,
      { signal },
      async (stream) => {
        // The witness: a check held at its write and let go announces its entry.
        const kept = await ending();
        const alone = await heldCheck();
        await server.clearFault("hold:write");
        expect((await alone.answer).status).toBe(200);

        const gone = await ending();
        const older = await heldCheck();
        const revoked = await controlRequest(
          server.controlSocket,
          `/keys/${gone.id}`,
          { method: "DELETE" },
        );
        expect(revoked.status).toBe(200);
        // A newer check looks while the older one waits, and no longer finds the key.
        await check();
        await server.clearFault("hold:write");
        expect((await older.answer).status).toBe(200);

        const last = await sentinel();
        const seen = await collectUntil(
          stream,
          (events) => created(events, last),
          "the sentinel note",
          signal,
        );
        expect(attentionTo(seen.events, kept.id)).toHaveLength(1);
        expect(attentionTo(seen.events, gone.id)).toEqual([]);
      },
    );
  },
);

it(
  "announces no failed backup job while the health check cannot answer",
  { retry: 0 },
  async ({ signal }) => {
    // retry: 0 because a failed try leaves the fault set and the folder moved.
    const reader = await mint({
      permissions: ["instance.read"],
      type_permissions: { "core.note": "read" },
    });
    await withStreamAtCursor(
      server.apiUrl,
      reader.key,
      { signal },
      async (stream) => {
        const away = `${backups}-away`;
        renameSync(backups, away);
        try {
          // A change since the last backup, so the job puts one rather than finding nothing new.
          await sentinel();
          const ran = await controlRequest(
            server.controlSocket,
            "/housekeeping/backup/run",
            { method: "POST" },
          );
          expect(ran.body).toMatchObject({ outcome: "failed" });
          await server.setFault("fail:attention=health");
          const listed = await controlRequest(
            server.controlSocket,
            "/attention",
          );
          expect(listed.status).toBe(200);
          const entries = listed.body.data as {
            kind: string;
            reference: string;
          }[];
          // The witness: the list holds the failed job and the health check that did not answer.
          expect(entries).toContainEqual(
            expect.objectContaining({ kind: "job", reference: "backup" }),
          );
          expect(entries).toContainEqual(
            expect.objectContaining({
              kind: "unavailable",
              reference: "Health",
            }),
          );
          const last = await sentinel();
          const seen = await collectUntil(
            stream,
            (events) => created(events, last),
            "the sentinel note",
            signal,
          );
          expect(attentionTo(seen.events, "Health")).toHaveLength(1);
          expect(
            attentionTo(seen.events, "backup").filter(
              (event) =>
                (event.data as { attention: { kind: string } }).attention
                  .kind === "job",
            ),
          ).toEqual([]);
        } finally {
          await server.clearFault("fail:attention");
          renameSync(away, backups);
        }
      },
    );
  },
);

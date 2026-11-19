import { afterAll, beforeAll, expect, it } from "vitest";
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
import {
  expectSignedBy,
  startReceiver,
  type Received,
  type Receiver,
} from "../../utils/webhook-receiver.js";

/**
 * A fault the server meets is an entry in what needs the owner's attention,
 * announced as it happens. While the database fails a write, the entry goes
 * from memory to the webhooks that may hear it. The fixture makes each fault
 * with a target fault (`conformance/TARGET-INTERFACE.md`, "Faults"): a
 * `fail:audit` that fails one write, or `refuse:write` that fails every write
 * until it is cleared. The list is the instance's own and a fault fails
 * writes for everyone, so the file boots a server of its own.
 */
let server: FreshServer;
let writer: string;
let note: string;

const DESCRIPTION =
  "The server met a fault it did not expect, and the request or job it was doing failed. If this keeps happening, report it to the Marfa project with the server's log from that time.";
const SENT_FROM_MEMORY = "An attention entry was sent from memory";
const DAY_MS = 86_400_000;

beforeAll(async () => {
  server = await bootFreshServer("attention-faults");
  writer = (await mint({ type_permissions: { "core.note": "write" } })).key;
  note = (await writeNote()).id;
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function mint(
  body: Record<string, unknown>,
): Promise<{ id: string; key: string }> {
  const answer = await controlRequest(server.controlSocket, "/keys", {
    method: "POST",
    body: { label: "faults", source: `faults-${randomUUID()}`, ...body },
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body as unknown as { id: string; key: string };
}

async function writeNote(): Promise<{ id: string; status: number }> {
  const response = await fetch(`${server.apiUrl}/items`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${writer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "core.note",
      properties: { title: `note ${randomUUID()}` },
    }),
  });
  const status = response.status;
  if (status !== 201) return { id: "", status };
  const { item } = (await response.json()) as { item: { id: string } };
  return { id: item.id, status };
}

interface Concern {
  kind: string;
  reference: string;
  title: string;
  description: string;
}

async function faults(): Promise<Concern[]> {
  const listed = await controlRequest(server.controlSocket, "/attention");
  expect(listed.status).toBe(200);
  return (listed.body as unknown as { data: Concern[] }).data.filter(
    (entry) => entry.kind === "fault",
  );
}

/** A note that fails as its audit entry is written: a fault at `POST /items`. */
async function failNote(): Promise<void> {
  await server.setFault("fail:audit=item.create");
  try {
    expect((await writeNote()).status).toBe(500);
  } finally {
    await server.clearFault("fail:audit");
  }
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

it("lists a fault once for where it happened, with a fixed description, counting each time it happens", async ({
  signal,
}) => {
  const reader = await mint({
    permissions: ["instance.read"],
    type_permissions: { "core.note": "read" },
  });
  const reference = "database:POST /items";
  await withStreamAtCursor(
    server.apiUrl,
    reader.key,
    { signal },
    async (held) => {
      await failNote();
      // Announced with no check of the list in between.
      const first = await collectUntil(
        held,
        (events) => attentionTo(events, reference).length > 0,
        "the fault's attention.raised",
        signal,
      );
      expect(attentionTo(first.events, reference)[0]!.data).toEqual({
        event_type: "attention.raised",
        attention: { kind: "fault", reference, description: DESCRIPTION },
      });

      await failNote();
      expect(await faults()).toEqual([
        {
          kind: "fault",
          reference,
          title: "A database failure in POST /items, 2 times",
          description: DESCRIPTION,
        },
      ]);
      const sentinel = (await writeNote()).id;
      const rest = await collectUntil(
        held,
        (events) => created(events, sentinel),
        "the sentinel note",
        signal,
      );
      expect(attentionTo(rest.events, reference)).toEqual([]);
    },
  );
});

/** A webhook subscribed to `attention.raised`, made by a key holding `permissions`. */
async function subscribe(
  receiver: Receiver,
  label: string,
  permissions: string[],
  extra: Record<string, unknown> = {},
): Promise<{ key: { id: string; key: string }; id: string; secret: string }> {
  const key = await mint({
    permissions,
    type_permissions: { "core.note": "read" },
    ...extra,
  });
  const made = await fetch(`${server.apiUrl}/webhooks`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key.key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      url: receiver.hookUrl(label),
      events: ["attention.raised"],
    }),
  });
  expect(made.status, await made.clone().text()).toBe(201);
  const { id, secret } = (await made.json()) as { id: string; secret: string };
  return { key, id, secret };
}

function bodyOf(received: Received): Record<string, unknown> {
  return JSON.parse(received.body) as Record<string, unknown>;
}

const about = (reference: string, label: string) => (received: Received) =>
  received.path.endsWith(`/${label}`) &&
  (bodyOf(received).attention as { reference?: string } | undefined)
    ?.reference === reference;

/** The server's log line for an entry sent from memory. */
async function sentFromMemory(
  reference: string,
): Promise<Record<string, unknown>> {
  return waitFor(
    `the log line for ${reference} sent from memory`,
    async () =>
      (await server.output())
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find(
          (line) =>
            line.message === SENT_FROM_MEMORY && line.reference === reference,
        ),
    60_000,
  );
}

const ENTRY = ["event_type", "attention", "delivery_id", "delivered_at"];

let receiver: Receiver;
let good: Awaited<ReturnType<typeof subscribe>>;

it(
  "sends a fault from memory while writes fail, signed, to each webhook that may read it and no other, and not again once writes land",
  // The faults it makes stay listed, so a second run would find none new.
  { retry: 0 },
  async () => {
    receiver = await startReceiver();
    good = await subscribe(receiver, "good", [
      "instance.read",
      "webhooks.manage",
    ]);
    await subscribe(receiver, "unread", ["webhooks.manage"]);
    const revoked = await subscribe(receiver, "revoked", [
      "instance.read",
      "webhooks.manage",
    ]);
    const serverNow = Date.now() + server.clockOffsetMs;
    await subscribe(
      receiver,
      "expiring",
      ["instance.read", "webhooks.manage"],
      { expires_at: new Date(serverNow + 3_600_000).toISOString() },
    );

    // The witness: with the database working, the fault reaches each webhook
    // whose maker reads attention, from the log.
    const witnessed = "database:PATCH /keys/{id}";
    await server.setFault("fail:audit=key.update");
    try {
      const failed = await controlRequest(
        server.controlSocket,
        `/keys/${revoked.key.id}`,
        { method: "PATCH", body: { label: "renamed" } },
      );
      expect(failed.status).toBe(500);
    } finally {
      await server.clearFault("fail:audit");
    }
    for (const label of ["good", "revoked", "expiring"]) {
      const logged = await receiver.waitFor(about(witnessed, label));
      expect(bodyOf(logged).event_id).toEqual(expect.any(String));
    }

    const gone = await controlRequest(
      server.controlSocket,
      `/keys/${revoked.key.id}`,
      { method: "DELETE" },
    );
    expect(gone.status).toBe(200);
    await server.advanceClock(2 * 3_600_000);

    const fromMemory = "database:PATCH /items/{id}";
    await server.setFault("refuse:write");
    try {
      const refused = await fetch(`${server.apiUrl}/items/${note}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${writer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ properties: { title: "refused" } }),
      });
      expect(refused.status).toBe(500);

      expect((await faults()).map((entry) => entry.reference)).toContain(
        fromMemory,
      );
      const delivered = await receiver.waitFor(about(fromMemory, "good"));
      expectSignedBy(delivered, good.secret);
      expect(delivered.headers["x-marfa-event-type"]).toBe("attention.raised");
      const body = bodyOf(delivered);
      expect(Object.keys(body).sort()).toEqual([...ENTRY].sort());
      expect(body).toMatchObject({
        event_type: "attention.raised",
        attention: {
          kind: "fault",
          reference: fromMemory,
          description: DESCRIPTION,
        },
      });
      const line = await sentFromMemory(fromMemory);
      expect(line.delivered).toBe(1);
    } finally {
      await server.clearFault("refuse:write");
    }

    // The log line came once every webhook was tried.
    for (const label of ["unread", "revoked", "expiring"]) {
      expect(receiver.received.filter(about(fromMemory, label)), label).toEqual(
        [],
      );
    }

    // Writes land again: a later check records the entry and announces nothing.
    await faults();
    const sentinel = "database:POST /items/bulk";
    await server.setFault("fail:audit=items.bulk");
    try {
      const failed = await fetch(`${server.apiUrl}/items/bulk`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${writer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          mode: "upsert",
          atomic: true,
          items: [
            {
              type: "core.note",
              source_id: randomUUID(),
              properties: { title: "bulk" },
            },
          ],
        }),
      });
      expect(failed.status).toBe(500);
    } finally {
      await server.clearFault("fail:audit");
    }
    await receiver.waitFor(about(sentinel, "good"));
    const told = receiver.received.filter(about(fromMemory, "good"));
    expect(told).toHaveLength(1);

    const listed = await fetch(
      `${server.apiUrl}/webhooks/${good.id}/deliveries`,
      { headers: { authorization: `Bearer ${good.key.key}` } },
    );
    expect(listed.status).toBe(200);
    const deliveries = ((await listed.json()) as { data: { id: string }[] })
      .data;
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.map((delivery) => delivery.id)).not.toContain(
      bodyOf(told[0]!).delivery_id,
    );
  },
);

it(
  "sends nothing from memory to a receiver whose address is not public",
  // A failed try leaves its fault listed, so a second run would find none new.
  { retry: 0 },
  async () => {
    const off = await controlRequest(server.controlSocket, "/config", {
      method: "PATCH",
      body: { allow_private_addresses: false },
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const thrown = await mint({ type_permissions: { "core.note": "read" } });
    const reference = "database:DELETE /keys/{id}";
    try {
      await server.setFault("refuse:write");
      try {
        const refused = await controlRequest(
          server.controlSocket,
          `/keys/${thrown.id}`,
          { method: "DELETE" },
        );
        expect(refused.status).toBe(500);
        const line = await sentFromMemory(reference);
        expect(line.delivered).toBe(0);
      } finally {
        await server.clearFault("refuse:write");
      }
      expect(receiver.received.filter(about(reference, "good"))).toEqual([]);
    } finally {
      const on = await controlRequest(server.controlSocket, "/config", {
        method: "PATCH",
        body: { allow_private_addresses: true },
      });
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      await receiver.close();
    }
  },
);

it(
  "forgets a fault 24 hours after it last happened, and announces it again when it comes back",
  // It moves the clock, which a second run would start from.
  { retry: 0 },
  async ({ signal }) => {
    const reference = "database:POST /items";
    await failNote();
    expect((await faults()).map((entry) => entry.reference)).toContain(
      reference,
    );
    await server.advanceClock(DAY_MS + 60_000);
    expect((await faults()).map((entry) => entry.reference)).not.toContain(
      reference,
    );

    const reader = await mint({
      permissions: ["instance.read"],
      type_permissions: { "core.note": "read" },
    });
    await withStreamAtCursor(
      server.apiUrl,
      reader.key,
      { signal },
      async (held) => {
        await failNote();
        await collectUntil(
          held,
          (events) => attentionTo(events, reference).length > 0,
          "the fault's attention.raised once it came back",
          signal,
        );
      },
    );
    const back = (await faults()).find(
      (entry) => entry.reference === reference,
    );
    expect(back?.title).toBe("A database failure in POST /items, once");
  },
);

it("lists no fault after a restart", async () => {
  await failNote();
  expect((await faults()).length).toBeGreaterThan(0);
  await server.restart();
  expect(await faults()).toEqual([]);
});

import { afterAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { idOf, send } from "../../utils/inbound-sender.js";
import {
  DAY_MS,
  jobs,
  movedClock,
  operatorOf,
  QUIET_SCHEDULE,
  quiet,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";

/**
 * What the retention jobs expire, and what they leave when the retention is
 * 0. The age of a record is a clock a fixture cannot wait out, so each case
 * writes its records, moves the server's clock forward through the target
 * interface, and runs the jobs with the operator's key.
 *
 * Four kinds of record answer to a retention: audit entries, the trash, the
 * event log, and inbound deliveries.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

const SWEEPS = [
  "audit-cleanup",
  "trash-purge",
  "event-log-cleanup",
  "inbound-delivery-cleanup",
] as const;

/** Written to a server, with the handles to find each kind of record again. */
interface Records {
  server: FreshServer;
  /** The id of the key whose creation the audit log records. */
  auditedKey: string;
  /** A note put in the bin. */
  binned: string;
  /** The notes whose creation the event log records, oldest first. */
  notes: string[];
  /** The events' ids, as the stream announces them. */
  eventIds: bigint[];
  /** The connector whose inbound deliveries are kept, and the two it holds. */
  connector: string;
  /** The connector's own client, which lists what its endpoint received. */
  senderKey: string;
  deliveries: { handled: string; pending: string };
}

const itemOf = (e: SseEvent): string | undefined =>
  (e.data as { item?: { id?: string } }).item?.id;

/** The log's events from `cursor`, up to the one for `last`, or the refusal. */
async function eventsFrom(
  { server, notes }: Records,
  cursor: string,
  signal: AbortSignal,
): Promise<SseEvent[]> {
  return withStream(
    server.apiUrl,
    server.workingKey,
    { lastEventId: cursor },
    async (stream) =>
      (
        await collectUntil(
          stream,
          (seen) =>
            seen.some(
              (e) =>
                e.event === "catchup_too_old" || itemOf(e) === notes.at(-1),
            ),
          `the events from ${cursor}`,
          signal,
        )
      ).events,
  );
}

/**
 * A server of its own, every retention set to `days` (and the event log's to
 * `hours`), and one record of each kind written under it.
 */
async function written(
  label: string,
  days: number,
  hours: number,
  signal: AbortSignal,
): Promise<Records> {
  const server = await bootFreshServer(label, QUIET_SCHEDULE);
  await quiet(server, SWEEPS);
  const writer = writerOf(server);
  const config = (await writer.getConfig()).data as Record<string, unknown>;
  const set = await writer.updateConfig({
    ...config,
    audit_retention_days: days,
    trash_retention_days: days,
    inbound_handled_retention_days: days,
    inbound_pending_retention_days: days,
    event_log_retention_hours: hours,
  });
  expect(set.status, JSON.stringify(set.error)).toBe(200);

  const key = await writer.createKey({
    label: `${label}-audited`,
    source: `${label}-audited`,
  });
  expect(key.status, JSON.stringify(key.error)).toBe(201);

  const notes: string[] = [];
  for (let n = 1; n <= 3; n += 1) {
    const created = await writer.createItem({
      type: "core.note",
      properties: { body: `${label}-${String(n)}` },
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    notes.push(created.data.item.id);
  }
  const binned = await writer.createItem({
    type: "core.note",
    properties: { body: `${label}-binned` },
  });
  expect(binned.ok, JSON.stringify(binned.error)).toBe(true);
  expect((await writer.deleteItem(binned.data.item.id)).ok).toBe(true);

  const minted = await writer.createKey({
    label: `${label}-sender`,
    source: `${label}-sender`,
    default_tier: "library",
  });
  expect(minted.status).toBe(201);
  const connectorClient = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: minted.data.key,
  });
  const registered = await connectorClient.registerConnector({ name: label });
  expect(registered.status).toBe(201);
  const endpoint = await connectorClient.createInboundEndpoint(
    registered.data.id,
  );
  expect(endpoint.status).toBe(201);
  const handled = idOf(
    await send(server.apiUrl, endpoint.data.path, "handled"),
  );
  const pending = idOf(
    await send(server.apiUrl, endpoint.data.path, "pending"),
  );
  const marked = await connectorClient.markInboundDeliveriesHandled(
    registered.data.id,
    { ids: [handled], outcome: "processed" },
  );
  expect(marked.status).toBe(200);

  const records: Records = {
    server,
    auditedKey: key.data.id,
    binned: binned.data.item.id,
    notes,
    eventIds: [],
    connector: registered.data.id,
    senderKey: minted.data.key,
    deliveries: { handled, pending },
  };
  const all = await eventsFrom(records, "0", signal);
  records.eventIds = notes.map((note) => {
    const frame = all.find((e) => itemOf(e) === note);
    expect(frame?.id, `no event for ${note}`).toBeDefined();
    return BigInt(frame!.id!);
  });
  return records;
}

/** What each kind of record is, as the API shows it now. */
async function kept(
  records: Records,
  signal: AbortSignal,
): Promise<{
  audit: boolean;
  trash: boolean;
  events: "all" | "too old";
  deliveries: string[];
}> {
  const { server } = records;
  const audit = await operatorOf(server).listAudit({
    resource_id: records.auditedKey,
  });
  expect(audit.status, JSON.stringify(audit.error)).toBe(200);
  const bin = await writerOf(server).listItems({ state: "trashed" });
  expect(bin.ok, JSON.stringify(bin.error)).toBe(true);
  const events = await eventsFrom(records, String(records.eventIds[0]), signal);
  const deliveries = await listDeliveries(records);
  return {
    audit: audit.data.data.some((entry) => entry.action === "key.create"),
    trash: bin.data.data.some((item) => item.id === records.binned),
    events: events.some((e) => e.event === "catchup_too_old")
      ? "too old"
      : "all",
    deliveries,
  };
}

async function listDeliveries(records: Records): Promise<string[]> {
  const { server } = records;
  // The connector's own key lists its deliveries.
  const client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: records.senderKey,
  });
  const listed = await client.listInboundDeliveries(records.connector, {
    state: "any",
  });
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return listed.data.data.map((row) => row.id).sort();
}

describe("a retention of 0", () => {
  it(
    "keeps every record of each kind, however far the clock moves",
    async ({ signal }) => {
      const records = await written("retention-zero", 0, 0, signal);
      const clock = movedClock(records.server);
      const both = [
        records.deliveries.handled,
        records.deliveries.pending,
      ].sort();

      // The witness: before the clock moves, every record is there to be kept.
      expect(await kept(records, signal)).toEqual({
        audit: true,
        trash: true,
        events: "all",
        deliveries: both,
      });

      // Ten years, and then the jobs.
      await clock.advance(3650 * DAY_MS);
      for (const name of SWEEPS) {
        const run = await runJob(records.server, name);
        expect(run.outcome, `${name}: ${String(run.error)}`).toBe("ok");
      }

      expect(await kept(records, signal)).toEqual({
        audit: true,
        trash: true,
        events: "all",
        deliveries: both,
      });
      const listed = await jobs(records.server);
      for (const name of SWEEPS) {
        expect(listed[name]?.last_outcome, name).toBe("ok");
      }
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("a positive retention", () => {
  it(
    "expires the records of each kind older than it, and keeps the newer",
    async ({ signal }) => {
      const records = await written("retention-positive", 1, 24, signal);
      const clock = movedClock(records.server);
      const both = [
        records.deliveries.handled,
        records.deliveries.pending,
      ].sort();

      // The witness: the same records are all there until the clock moves.
      expect(await kept(records, signal)).toEqual({
        audit: true,
        trash: true,
        events: "all",
        deliveries: both,
      });

      // Two days on, past a retention of a day and of twenty-four hours.
      await clock.advance(2 * DAY_MS);
      // Newer than the retention: written after the clock moved.
      const writer = writerOf(records.server);
      const newerKey = await writer.createKey({
        label: "retention-newer",
        source: "retention-newer",
      });
      expect(newerKey.status).toBe(201);
      const newerNote = await writer.createItem({
        type: "core.note",
        properties: { body: "newer" },
      });
      expect(newerNote.ok).toBe(true);
      const newerBin = await writer.createItem({
        type: "core.note",
        properties: { body: "newer-binned" },
      });
      expect(newerBin.ok).toBe(true);
      expect((await writer.deleteItem(newerBin.data.item.id)).ok).toBe(true);

      for (const name of SWEEPS) {
        const run = await runJob(records.server, name);
        expect(run.outcome, `${name}: ${String(run.error)}`).toBe("ok");
      }

      expect(await kept(records, signal)).toEqual({
        audit: false,
        trash: false,
        events: "too old",
        deliveries: [],
      });
      // What was written after the clock moved is inside every window.
      const newerAudit = await operatorOf(records.server).listAudit({
        resource_id: newerKey.data.id,
      });
      expect(newerAudit.data.data.map((entry) => entry.action)).toContain(
        "key.create",
      );
      const bin = await writer.listItems({ state: "trashed" });
      expect(bin.data.data.map((item) => item.id)).toEqual([
        newerBin.data.item.id,
      ]);
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );
});

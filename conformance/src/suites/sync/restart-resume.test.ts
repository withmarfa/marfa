import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
  type StopSignal,
} from "../../utils/fresh-server.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";

/**
 * What the log keeps across a restart, and what a reader that resumes after
 * one is sent.
 *
 * A device resumes from the last id it received, and the instance restarts
 * under it: for a deploy, and for a crash. That cursor is only a sound
 * position if the same event keeps the same id on the far side of the
 * restart and the next event is numbered after the last, so these are asserted
 * on a server of the file's own, which each test stops and starts. A
 * `SIGKILL` is the crash: nothing runs on the way down, so what survives is
 * what the answer to each write promised.
 */

let server: FreshServer | undefined;

beforeAll(async () => {
  server = await bootFreshServer("restart-resume");
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

/** Bound to the server's current address, which a restart moves. */
function client(): MarfaClient {
  return new MarfaClient({
    baseUrl: server!.apiUrl,
    apiKey: server!.workingKey,
  });
}

async function note(body: string): Promise<string> {
  const created = await client().createItem({
    type: "core.note",
    properties: { body },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.data.item.id;
}

const itemOf = (e: SseEvent): string | undefined =>
  (e.data as { item?: { id?: string } })?.item?.id;

/** The frames with an id from `cursor` up to and including the one for
 *  `last`, in the order they were sent. */
async function readTo(
  cursor: string,
  last: string,
  signal: AbortSignal,
): Promise<SseEvent[]> {
  return withStream(
    server!.apiUrl,
    server!.workingKey,
    { lastEventId: cursor },
    async (stream) => {
      const { events } = await collectUntil(
        stream,
        (seen) => seen.some((e) => itemOf(e) === last),
        `the event for ${last}`,
        signal,
      );
      return events.filter((e) => e.id !== undefined);
    },
  );
}

function idOfItem(events: SseEvent[], item: string): bigint {
  const frame = events.find((e) => itemOf(e) === item);
  expect(frame?.id, `no event with an id for ${item}`).toBeDefined();
  return BigInt(frame!.id!);
}

async function restartOn(signal: StopSignal): Promise<void> {
  await server!.restart({ signal });
}

describe.each(["SIGTERM", "SIGKILL"] as const)(
  "an instance restarted after %s",
  (signal) => {
    it(
      "keeps the id of every event it announced, and numbers the next write after the last",
      async ({ signal: aborted }) => {
        const before = [
          await note(`kept-before-1-${signal}`),
          await note(`kept-before-2-${signal}`),
          await note(`kept-before-3-${signal}`),
        ];
        const first = await readTo("0", before[2]!, aborted);
        const idsBefore = before.map((item) => idOfItem(first, item));
        // The witness: three distinct, increasing ids to compare across the
        // restart, so equality is a statement about these events.
        expect(idsBefore[0]! < idsBefore[1]!).toBe(true);
        expect(idsBefore[1]! < idsBefore[2]!).toBe(true);

        await restartOn(signal);

        const afterItem = await note(`kept-after-${signal}`);
        const second = await readTo("0", afterItem, aborted);
        expect(before.map((item) => idOfItem(second, item))).toEqual(idsBefore);
        expect(
          idOfItem(second, afterItem) > idsBefore[2]!,
          "the write after the restart was numbered at or below an event announced before it",
        ).toBe(true);
        // Once each: a replay that repeated an event after the restart would
        // hand a resuming reader the same id twice.
        const ids = second.map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
      },
      2 * FRESH_SERVER_TIMEOUT_MS,
    );

    it(
      "delivers nothing twice to a stream that resumes from the last id it received before the restart",
      async ({ signal: aborted }) => {
        const received = await note(`resumed-received-${signal}`);
        const lastReceived = await withStream(
          server!.apiUrl,
          server!.workingKey,
          {},
          async (stream) => {
            await new Promise((r) => setTimeout(r, 250));
            const live = await note(`resumed-live-${signal}`);
            const { events } = await collectUntil(
              stream,
              (seen) => seen.some((e) => itemOf(e) === live),
              `the live event for ${live}`,
              aborted,
            );
            const frame = events.find((e) => itemOf(e) === live);
            return { id: frame!.id!, item: live };
          },
        );
        // The witness that the live frame is past the one received first,
        // so the resume has something it must not repeat.
        expect(
          BigInt(lastReceived.id) >
            idOfItem(await readTo("0", received, aborted), received),
        ).toBe(true);

        await restartOn(signal);

        const later = [
          await note(`resumed-later-1-${signal}`),
          await note(`resumed-later-2-${signal}`),
        ];
        const resumed = await readTo(lastReceived.id, later[1]!, aborted);

        const ids = resumed.map((e) => BigInt(e.id!));
        for (const id of ids) {
          expect(
            id > BigInt(lastReceived.id),
            `the resume from ${lastReceived.id} sent the event ${String(id)}`,
          ).toBe(true);
        }
        expect(new Set(ids).size, "an event was sent twice").toBe(ids.length);
        for (const item of later) {
          expect(
            resumed.filter((e) => itemOf(e) === item).length,
            `the event for ${item} was not sent exactly once`,
          ).toBe(1);
        }
        for (const item of [received, lastReceived.item]) {
          expect(
            resumed.some((e) => itemOf(e) === item),
            `the resume sent ${item}, which the stream had received already`,
          ).toBe(false);
        }
      },
      2 * FRESH_SERVER_TIMEOUT_MS,
    );
  },
);

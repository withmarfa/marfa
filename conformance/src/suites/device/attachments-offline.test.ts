import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { CliDevice } from "../../device/cli-adapter.js";
import {
  catchupTooOld,
  connected,
  copyHeadRead,
  copyItemEvent,
  copyReplay,
  copyStreamCursor,
  edgeEvent,
  refusal,
  wireEdge,
  wireItem,
  writeAnswers,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import type { Answer, RecordedRequest } from "../../device/scripted-server.js";
import type { Attachments, FileCache, Status } from "../../device/protocol.js";
import {
  fileOf,
  hashOf,
  hydratedHarness,
  scriptBlob,
  scriptHydration,
  startHarness,
  type Harness,
} from "./harness.js";

/**
 * "Files attached to an item a device holds stay on the device."
 *
 * A file item that is the source of an `attached-to` edge whose target the
 * copy holds is an attachment. Its bytes are fetched when a caller asks for
 * the attachments, never trimmed while it stays one, and not counted against
 * the file budget.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  delete process.env.MARFA_TEST_FAULT;
});

const TB = 1_000_000_000_000;
const MIB = 1024 * 1024;

/** Bytes that differ from every other seed's. */
function bytesOf(seed: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let at = 0; at < size; at += 1) {
    bytes[at] = (at * 7 + (at >> 8) * 13 + seed * 31) % 251;
  }
  return bytes;
}

async function withFault<T>(fault: string, call: () => Promise<T>): Promise<T> {
  process.env.MARFA_TEST_FAULT = fault;
  try {
    return await call();
  } finally {
    delete process.env.MARFA_TEST_FAULT;
  }
}

function note(id: string): { item: WireItemOptions } {
  return { item: { id, type: "core.note", properties: { title: id } } };
}

function attachedEdge(file: string, target: string): Record<string, unknown> {
  return wireEdge({
    id: `${file}-on-${target}`,
    source_id: file,
    target_id: target,
    edge_type: "attached-to",
  });
}

/** A file item naming `bytes`, attached to each of `to`. */
function file(
  id: string,
  bytes: Buffer,
  to: string[] = [],
): { item: WireItemOptions } {
  return {
    item: {
      id,
      type: "core.file",
      properties: {
        title: `${id}.bin`,
        blob_ref: hashOf(bytes),
        mime_type: "application/octet-stream",
        size_bytes: bytes.length,
      },
      edges: {
        "attached-to": {
          data: to.map((target) => attachedEdge(id, target)),
          next_cursor: null,
        },
      },
    },
  };
}

/** A device hydrated with the notes and files of `rows`, whose bytes the server serves. */
async function hydratedWith(
  label: string,
  notes: string[],
  files: Array<{ item: WireItemOptions }>,
  served: Buffer[],
  /** What catch-ups after the hydration are answered, in order. */
  events: Answer[] = [],
): Promise<Harness> {
  const made = await startHarness(label);
  scriptHydration(made.server, {
    head: "10",
    rows: { "core.note": notes.map(note), "core.file": files },
  });
  // Queued before the hydration, which takes the answers ahead of these.
  if (events.length > 0) made.server.copyAnswer("GET", "/events", ...events);
  for (const bytes of served) scriptBlob(made.server, bytes);
  const hydrated = await made.device.hydrate(
    ["core.note", "core.file"],
    "library",
  );
  expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
  return made;
}

function heldAt(device: CliDevice, bytes: Buffer): string {
  return `${device.store}.blobs/${hashOf(bytes).slice("sha256:".length)}`;
}

async function cacheOf(device: CliDevice): Promise<FileCache> {
  const status = await device.status();
  if (!status.ok) throw new Error(`no status: ${JSON.stringify(status)}`);
  return (status.value as Status).file_cache;
}

async function attachmentsOf(device: CliDevice): Promise<Attachments> {
  const attachments = (await cacheOf(device)).attachments;
  if (attachments === null) throw new Error("the attachments are unknown");
  return attachments;
}

/**
 * The bytes' first link stops after 3,000 bytes, and every later link serves
 * the range asked for. Answers the `Range` header of each ask of a link.
 */
function cutOnce(
  { server }: Harness,
  bytes: Buffer,
): Array<string | undefined> {
  const hash = hashOf(bytes);
  const hex = hash.slice("sha256:".length);
  const asked: Array<string | undefined> = [];
  let given = 0;
  server.copyAnswer("GET", `/blobs/${hash}/url`, () => {
    given += 1;
    return writeAnswers.link(`${server.url}/links/${hex}/${String(given)}`);
  });
  server.copyAnswer(
    "GET",
    new RegExp(`^/links/${hex}/\\d+$`),
    (request: RecordedRequest): Answer => {
      asked.push(request.headers.range);
      if (request.pathname.endsWith("/1"))
        return { kind: "bytes", status: 200, body: bytes, cut: 3000 };
      const from = Number(
        /^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1] ?? 0,
      );
      return {
        kind: "bytes",
        status: 206,
        body: bytes.subarray(from),
        headers: {
          "content-range": `bytes ${String(from)}-${String(bytes.length - 1)}/${String(bytes.length)}`,
        },
      };
    },
  );
  return asked;
}

/** The asks of the link door for the bytes. */
function linkAsks({ server }: Harness, bytes: Buffer): number {
  const door = `/blobs/${hashOf(bytes)}/url`;
  return server.requests.filter((request) => request.pathname === door).length;
}

async function budget(device: CliDevice, value: string): Promise<number> {
  const set = await device.fileBudget(value);
  expect(set.ok, JSON.stringify(set)).toBe(true);
  return set.ok ? (set.value.trimmed_bytes ?? Number.NaN) : Number.NaN;
}

async function fetchKept(
  device: CliDevice,
): Promise<{ fetched: number; fetched_bytes: number }> {
  const fetched = await device.fetchKept();
  expect(fetched.ok, JSON.stringify(fetched)).toBe(true);
  if (!fetched.ok) throw new Error("the fetch of attachments was refused");
  return fetched.value;
}

describe("an attachment of an item the copy holds", () => {
  it("is fetched when asked and kept through a trim to a budget of nothing, outside the budget", async () => {
    const photo = bytesOf(1, 300);
    const loose = bytesOf(2, 200);
    harness = await hydratedWith(
      "kept-through-trim",
      ["note"],
      [file("photo", photo, ["note"]), file("loose", loose)],
      [photo, loose],
    );
    const { device } = harness;
    expect(await attachmentsOf(device)).toMatchObject({
      held: 0,
      not_held: 1,
      not_held_bytes: 300,
      not_held_by_reason: [
        { reason: "not_fetched", attachments: 1, bytes: 300, unstated: 0 },
      ],
    });

    expect(await fetchKept(device)).toEqual({
      fetched: 1,
      fetched_bytes: 300,
      attachments: expect.objectContaining({ held: 1, not_held: 0 }),
    });
    expect(readFileSync(heldAt(device, photo))).toEqual(photo);
    expect(existsSync(heldAt(device, loose))).toBe(false);
    expect((await device.blob(hashOf(loose))).ok).toBe(true);

    // A trim hands back the loose file's 200 bytes and none of the
    // attachment's, so only those count as free for the default budget.
    const nearlyFull = await withFault(
      `volume=${String(TB)}:${String(TB / 20 + 300 * MIB)}`,
      () => cacheOf(device),
    );
    expect(nearlyFull.setting).toBe("default");
    expect(nearlyFull.budget).toBe(300 * MIB + 200);

    // 500 bytes are held and only the loose file's 200 count, which fit 250.
    expect(await budget(device, "250")).toBe(0);
    expect(existsSync(heldAt(device, loose))).toBe(true);
    const cache = await cacheOf(device);
    expect(cache.held).toBe(500);
    expect(cache.attachments).toMatchObject({ held: 1, held_bytes: 300 });

    // The witness: under a budget of nothing the loose file goes, and the
    // attachment stays.
    expect(await budget(device, "0")).toBe(200);
    expect(existsSync(heldAt(device, loose))).toBe(false);
    expect(readFileSync(heldAt(device, photo))).toEqual(photo);

    // Held whole, so asked again it fetches nothing.
    expect(await fetchKept(device)).toMatchObject({ fetched: 0 });
    expect(linkAsks(harness, photo)).toBe(1);
  });

  it("is kept while one of the items it is attached to is held, and a file attached to none the copy holds is not", async () => {
    const both = bytesOf(3, 120);
    const away = bytesOf(4, 80);
    harness = await hydratedWith(
      "kept-one-held",
      ["note"],
      [
        file("both", both, ["note", "elsewhere"]),
        file("away", away, ["elsewhere"]),
      ],
      [both, away],
    );
    const { device } = harness;
    expect(await fetchKept(device)).toMatchObject({
      fetched: 1,
      fetched_bytes: 120,
    });
    expect(linkAsks(harness, away)).toBe(0);
    expect(await attachmentsOf(device)).toMatchObject({
      held: 1,
      not_held: 0,
    });

    // Fetched when read, the file attached to nothing the copy holds is
    // cached as any other, and a budget of nothing takes it.
    expect((await device.blob(hashOf(away))).ok).toBe(true);
    expect(await budget(device, "0")).toBe(80);
    expect(existsSync(heldAt(device, away))).toBe(false);
    expect(readFileSync(heldAt(device, both))).toEqual(both);
  });

  it("becomes ordinary cached bytes when its edge goes or its item goes to the bin", async () => {
    const first = bytesOf(5, 100);
    const second = bytesOf(6, 60);
    harness = await hydratedWith(
      "released",
      ["one", "two"],
      [file("first", first, ["one"]), file("second", second, ["two"])],
      [first, second],
      [
        copyReplay("12", [
          edgeEvent("11", "edge.deleted", attachedEdge("first", "one")),
          copyItemEvent(
            "12",
            "item.deleted",
            wireItem({ id: "two", type: "core.note", state: "trashed" }),
          ),
        ]),
      ],
    );
    const { device } = harness;
    expect(await fetchKept(device)).toMatchObject({ fetched: 2 });
    // The witness: while both are attachments, nothing is taken.
    expect(await budget(device, "0")).toBe(0);
    expect(await attachmentsOf(device)).toMatchObject({ held: 2 });

    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    expect(await attachmentsOf(device)).toMatchObject({
      held: 0,
      not_held: 0,
    });
    expect(await budget(device, "0")).toBe(160);
    expect(existsSync(heldAt(device, first))).toBe(false);
    expect(existsSync(heldAt(device, second))).toBe(false);
  });
});

describe("a fetch of the attachments", () => {
  it("stops at the first the disk has no room for, keeps what it holds and says why the rest are not held", async () => {
    const small = bytesOf(7, 10);
    const middle = bytesOf(8, 3000);
    const large = bytesOf(9, 4000);
    harness = await hydratedWith(
      "no-room",
      ["note"],
      [
        file("large", large, ["note"]),
        file("small", small, ["note"]),
        file("middle", middle, ["note"]),
      ],
      [small, middle, large],
    );
    const { device } = harness;
    const fetched = await withFault(`volume=${String(TB)}:1000`, () =>
      fetchKept(device),
    );
    expect(fetched).toMatchObject({ fetched: 1, fetched_bytes: 10 });
    expect(readFileSync(heldAt(device, small))).toEqual(small);
    expect(existsSync(heldAt(device, middle))).toBe(false);
    // Smallest first, and nothing after the one that did not fit.
    expect(linkAsks(harness, middle)).toBe(1);
    expect(linkAsks(harness, large)).toBe(0);
    expect(await attachmentsOf(device)).toMatchObject({
      held: 1,
      held_bytes: 10,
      not_held: 2,
      not_held_bytes: 7000,
      not_held_by_reason: [
        { reason: "no_room", attachments: 2, bytes: 7000, unstated: 0 },
      ],
    });

    // The witness: with room, the same fetch takes the rest.
    expect(await fetchKept(device)).toMatchObject({
      fetched: 2,
      fetched_bytes: 7000,
    });
    expect(await attachmentsOf(device)).toMatchObject({
      held: 3,
      not_held: 0,
      not_held_by_reason: [],
    });
  });

  it("goes on past bytes the server holds none of, and stops once the server cannot be reached", async () => {
    const [absent, served, failing, after] = [
      bytesOf(10, 10),
      bytesOf(11, 20),
      bytesOf(12, 30),
      bytesOf(13, 40),
    ];
    harness = await startHarness("absent-unreachable");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [note("note")],
        "core.file": [
          file("absent", absent, ["note"]),
          file("served", served, ["note"]),
          file("failing", failing, ["note"]),
          file("after", after, ["note"]),
        ],
      },
    });
    server.copyAnswer(
      "GET",
      `/blobs/${hashOf(absent)}/url`,
      refusal(404, "blob_not_found", "Blob not found"),
    );
    scriptBlob(server, served);
    server.copyAnswer(
      "GET",
      `/blobs/${hashOf(failing)}/url`,
      refusal(503, "service_unavailable", "later"),
    );
    expect(
      (await device.hydrate(["core.note", "core.file"], "library")).ok,
    ).toBe(true);

    expect(await fetchKept(device)).toMatchObject({
      fetched: 1,
      fetched_bytes: 20,
    });
    expect(linkAsks(harness, after)).toBe(0);
    expect(await attachmentsOf(device)).toMatchObject({
      held: 1,
      not_held: 3,
      not_held_bytes: 80,
      not_held_by_reason: [
        { reason: "unreachable", attachments: 2, bytes: 70, unstated: 0 },
        { reason: "absent", attachments: 1, bytes: 10, unstated: 0 },
      ],
    });
  });

  it("resumes an attachment whose fetch stopped part way, and a trim keeps the part held", async () => {
    const bytes = bytesOf(14, 5000);
    harness = await startHarness("resume");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [note("note")],
        "core.file": [file("video", bytes, ["note"])],
      },
    });
    const asked = cutOnce(harness, bytes);
    expect(
      (await device.hydrate(["core.note", "core.file"], "library")).ok,
    ).toBe(true);

    expect(await fetchKept(device)).toMatchObject({ fetched: 0 });
    expect(await attachmentsOf(device)).toMatchObject({
      held: 0,
      partial_bytes: 3000,
      not_held_by_reason: [{ reason: "unreachable", attachments: 1 }],
    });
    expect(await budget(device, "0")).toBe(0);
    expect((await cacheOf(device)).held).toBe(3000);

    expect(await fetchKept(device)).toMatchObject({
      fetched: 1,
      fetched_bytes: 5000,
    });
    expect(asked).toEqual([undefined, "bytes=3000-"]);
    expect(readFileSync(heldAt(device, bytes))).toEqual(bytes);
    expect(await attachmentsOf(device)).toMatchObject({
      held: 1,
      partial_bytes: 0,
      not_held: 0,
    });
  });

  it("leaves the part of an attachment held when another fetch has no room, and takes the part of another file", async () => {
    const video = bytesOf(18, 5000);
    const clip = bytesOf(19, 5000);
    const next = bytesOf(20, 5000);
    harness = await startHarness("no-room-partials");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [note("note")],
        "core.file": [
          file("video", video, ["note"]),
          file("clip", clip),
          file("next", next),
        ],
      },
    });
    cutOnce(harness, video);
    cutOnce(harness, clip);
    scriptBlob(server, next);
    expect(
      (await device.hydrate(["core.note", "core.file"], "library")).ok,
    ).toBe(true);
    expect(await fetchKept(device)).toMatchObject({ fetched: 0 });
    expect((await device.blob(hashOf(clip))).ok).toBe(false);
    expect((await cacheOf(device)).held).toBe(6000);

    const refused = await withFault(`volume=${String(TB)}:1000`, () =>
      device.blob(hashOf(next)),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("no_room");
    expect((await cacheOf(device)).held).toBe(3000);
    expect(await attachmentsOf(device)).toMatchObject({ partial_bytes: 3000 });
  });

  it("fetches nothing for a queued upload that is an attachment, which stays", async () => {
    harness = await hydratedHarness("queued-upload", {
      rows: { "core.note": [note("note")] },
    });
    const { server, device } = harness;
    const bytes = bytesOf(15, 50);
    const attached = await device.attach("note", fileOf("photo.bin", bytes));
    expect(attached.ok, JSON.stringify(attached)).toBe(true);
    expect(await attachmentsOf(device)).toMatchObject({
      held: 1,
      held_bytes: 50,
      not_held: 0,
    });
    expect(await fetchKept(device)).toMatchObject({ fetched: 0 });
    expect(
      server.requests.filter((request) =>
        request.pathname.startsWith("/blobs"),
      ),
    ).toEqual([]);
    expect(await budget(device, "0")).toBe(0);
    expect(readFileSync(heldAt(device, bytes))).toEqual(bytes);
  });
});

describe("the attachments of a copy", () => {
  it("are unknown while a hydration fills the copy, which trims nothing, and kept again once it is whole or expired", async () => {
    const photo = bytesOf(16, 90);
    const loose = bytesOf(17, 40);
    let cut = false;
    harness = await startHarness("hydrating");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      pageSize: 1,
      drop: () => cut,
      rows: {
        "core.note": [note("note"), note("other"), note("third")],
        "core.file": [file("photo", photo, ["note"]), file("loose", loose)],
      },
    });
    // Queued behind the hydration's own answers, this one answers every read
    // of the log after them: the head, an empty replay, and once `aged`, a
    // log aged past the copy's cursor.
    let aged = false;
    server.copyAnswer("GET", "/events", (request) => {
      if (aged)
        return {
          kind: "sse",
          frames: [
            connected,
            copyStreamCursor("900"),
            catchupTooOld("500", "10"),
          ],
        };
      return request.headers["last-event-id"] === undefined
        ? copyHeadRead("10")
        : copyReplay("10", []);
    });
    scriptBlob(server, photo);
    scriptBlob(server, loose);
    const types = ["core.note", "core.file"];
    expect((await device.hydrate(types, "library")).ok).toBe(true);
    expect(await fetchKept(device)).toMatchObject({ fetched: 1 });
    expect((await device.blob(hashOf(loose))).ok).toBe(true);

    cut = true;
    expect((await device.hydrate(types, "library")).ok).toBe(false);
    const filling = await device.status();
    expect(filling.ok && filling.value.hydration).toBe("in_progress");
    expect(filling.ok && filling.value.file_cache.attachments).toBeNull();
    expect(await budget(device, "0")).toBe(0);
    expect(existsSync(heldAt(device, photo))).toBe(true);
    expect(existsSync(heldAt(device, loose))).toBe(true);

    // The witness: whole again, a trim takes the loose file and keeps the
    // attachment.
    cut = false;
    expect((await device.hydrate(types, "library")).ok).toBe(true);
    expect(await budget(device, "0")).toBe(40);
    expect(readFileSync(heldAt(device, photo))).toEqual(photo);

    // An expired copy still holds its rows, so its attachments stay.
    aged = true;
    expect((await device.catchUp()).ok).toBe(false);
    const expired = await device.status();
    expect(expired.ok && expired.value.hydration).toBe("expired");
    expect(await attachmentsOf(device)).toMatchObject({ held: 1 });
    expect(await budget(device, "0")).toBe(0);
    expect(readFileSync(heldAt(device, photo))).toEqual(photo);
  });

  it("counts an edge held whole whose file the slice does not hold as not in the copy", async () => {
    harness = await startHarness("not-in-copy");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [note("note")] },
      edges: {
        "attached-to": [
          { id: "outside-on-note", source_id: "outside", target_id: "note" },
        ],
      },
    });
    const hydrated = await device.hydrate(["core.note"], "library", {
      edgeTypes: ["attached-to"],
    });
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
    expect(await attachmentsOf(device)).toMatchObject({
      held: 0,
      not_held: 1,
      not_held_bytes: 0,
      not_held_by_reason: [
        { reason: "not_in_copy", attachments: 1, bytes: 0, unstated: 1 },
      ],
    });
    expect(await fetchKept(device)).toMatchObject({ fetched: 0 });
  });
});

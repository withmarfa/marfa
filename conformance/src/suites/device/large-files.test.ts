import { existsSync, readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Answer, RecordedRequest } from "../../device/scripted-server.js";
import { writeAnswers } from "../../device/marfa-answers.js";
import type { CliDevice } from "../../device/cli-adapter.js";
import type { Status } from "../../device/protocol.js";
import {
  hashOf,
  scriptHydration,
  startHarness,
  type Harness,
} from "./harness.js";

/**
 * "A device fetches a file larger than its file budget."
 *
 * A budget of 1,000 bytes stands for a budget a long video is over, and a file
 * of 5,000 bytes for the video: the rules are about a file larger than the
 * budget, and no fixture can fetch gigabytes to see them.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  delete process.env.MARFA_TEST_FAULT;
});

const SIZE = 5000;
const BUDGET = "1000";
const TB = 1_000_000_000_000;

/** Bytes that differ from every other seed's and never repeat within a file. */
function bytesOf(seed: number, size = SIZE): Buffer {
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

function volume(free: number): string {
  return `volume=${String(TB)}:${String(free)}`;
}

/** What the cache's folder holds, by name; none where it is not made yet. */
function inCache(device: CliDevice): string[] {
  const folder = `${device.store}.blobs`;
  return existsSync(folder) ? readdirSync(folder).sort() : [];
}

function heldAt(device: CliDevice, hash: string): string {
  return `${device.store}.blobs/${hash.slice("sha256:".length)}`;
}

/** The bytes the device says its file cache holds. */
async function heldBytes(device: CliDevice): Promise<number | null> {
  const status = await device.status();
  if (!status.ok) throw new Error(`no status: ${JSON.stringify(status)}`);
  return (status.value as Status).file_cache.held;
}

/**
 * A device whose copy holds a file item that states `stated` bytes for `hash`,
 * and a note for each of `notes`, which states its own size for the bytes it
 * names.
 */
async function hydratedWith(
  label: string,
  files: Array<{ hash: string; stated?: number }>,
  notes: Array<{ hash: string; stated: number }> = [],
): Promise<Harness> {
  const made = await startHarness(label);
  scriptHydration(made.server, {
    head: "10",
    rows: {
      "core.note": notes.map(({ hash, stated }, index) => ({
        item: {
          id: `note-row-${String(index)}`,
          type: "core.note",
          properties: {
            title: `note-${String(index)}`,
            blob_ref: hash,
            size_bytes: stated,
          },
        },
      })),
      "core.file": files.map(({ hash, stated }, index) => ({
        item: {
          id: `file-row-${String(index)}`,
          type: "core.file",
          properties: {
            title: `file-${String(index)}.bin`,
            blob_ref: hash,
            mime_type: "application/octet-stream",
            ...(stated === undefined ? {} : { size_bytes: stated }),
          },
        },
      })),
    },
  });
  const hydrated = await made.device.hydrate(
    notes.length === 0 ? ["core.file"] : ["core.file", "core.note"],
    "library",
  );
  expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
  return made;
}

/** What a link is asked for, and how it answers. */
interface Links {
  /** The `Range` header of each ask of a link, `undefined` where it had none. */
  asked: Array<string | undefined>;
  /** The path of each link the server gave. */
  given: string[];
}

/**
 * The blob's link door gives a new link each time, and each link answers as
 * `serve` says for the attempt and the first byte asked for.
 */
function scriptLinks(
  { server }: Harness,
  hash: string,
  serve: (attempt: number, from: number) => Answer,
): Links {
  const hex = hash.slice("sha256:".length);
  const links: Links = { asked: [], given: [] };
  server.copyAnswer("GET", `/blobs/${hash}/url`, () => {
    const path = `/links/${hex}/${String(links.given.length + 1)}`;
    links.given.push(path);
    return writeAnswers.link(`${server.url}${path}`);
  });
  server.copyAnswer(
    "GET",
    new RegExp(`^/links/${hex}/\\d+$`),
    (request: RecordedRequest) => {
      const range = request.headers.range;
      links.asked.push(range);
      const from = /^bytes=(\d+)-$/.exec(range ?? "");
      return serve(
        Number(request.pathname.split("/").pop()),
        from === null ? 0 : Number(from[1]),
      );
    },
  );
  return links;
}

function whole(bytes: Buffer, extra: Partial<Answer> = {}): Answer {
  return { kind: "bytes", status: 200, body: bytes, ...extra } as Answer;
}

/** What a server that honours ranges answers `from` with. */
function ranged(bytes: Buffer, from: number): Answer {
  if (from === 0) return whole(bytes);
  return {
    kind: "bytes",
    status: 206,
    body: bytes.subarray(from),
    headers: {
      "content-range": `bytes ${String(from)}-${String(bytes.length - 1)}/${String(bytes.length)}`,
    },
  };
}

describe("a file larger than the file budget", () => {
  it("is fetched and read, whatever the budget", async () => {
    const bytes = bytesOf(1);
    const hash = hashOf(bytes);
    harness = await hydratedWith("large-read", [{ hash, stated: SIZE }]);
    const { device } = harness;
    scriptLinks(harness, hash, () => whole(bytes));
    expect((await device.fileBudget(BUDGET)).ok).toBe(true);

    const got = await device.blob(hash);
    expect(got.ok, JSON.stringify(got)).toBe(true);
    if (!got.ok) return;
    expect(readFileSync(got.value.path)).toEqual(bytes);
    expect(inCache(device)).toEqual([hash.slice("sha256:".length)]);
  });

  it("is fetched with no stated size, bounded by the link's length", async () => {
    const bytes = bytesOf(2);
    const hash = hashOf(bytes);
    // The copy holds no item that names the bytes, so it states no size.
    harness = await startHarness("large-unstated");
    const { device } = harness;
    expect((await device.status()).ok).toBe(true);
    scriptLinks(harness, hash, () => whole(bytes));
    expect((await device.fileBudget(BUDGET)).ok).toBe(true);

    const got = await device.blob(hash);
    expect(got.ok, JSON.stringify(got)).toBe(true);
    if (got.ok) expect(readFileSync(got.value.path)).toEqual(bytes);
  });

  it("is bounded by the link where only a note states a smaller size for the same bytes", async () => {
    const bytes = bytesOf(28);
    const hash = hashOf(bytes);
    harness = await hydratedWith(
      "large-note-size",
      [{ hash }],
      [{ hash, stated: 100 }],
    );
    const { device } = harness;
    scriptLinks(harness, hash, () => whole(bytes));
    const fetched = await device.blob(hash);
    expect(fetched.ok, JSON.stringify(fetched)).toBe(true);
    expect(readFileSync(heldAt(device, hash))).toEqual(bytes);
  });

  it("is refused where the link states no length and the copy states no size", async () => {
    const bytes = bytesOf(3);
    const hash = hashOf(bytes);
    harness = await startHarness("large-unsized");
    const { device } = harness;
    expect((await device.status()).ok).toBe(true);
    scriptLinks(harness, hash, () => whole(bytes, { unsized: true }));

    const refused = await device.blob(hash);
    expect(refused.ok, "a fetch with no bound at all was taken").toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("bytes_absent");
    expect(inCache(device)).toEqual([]);

    // The witness: the same link, with the size stated, is taken.
    const stated = await hydratedWith("large-unsized-stated", [
      { hash, stated: SIZE },
    ]);
    await harness.stop();
    harness = stated;
    scriptLinks(stated, hash, () => whole(bytes, { unsized: true }));
    const taken = await stated.device.blob(hash);
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
  });

  it("is refused when the link sends more than the size the copy states, leaving nothing", async () => {
    const bytes = bytesOf(4);
    const hash = hashOf(bytes);
    harness = await hydratedWith("large-overlong", [{ hash, stated: 3000 }]);
    const { device } = harness;
    // Once with a length the link states, once with none: the body is longer
    // than the bound either way.
    const links = scriptLinks(harness, hash, (attempt) =>
      whole(bytes, { unsized: attempt === 2 }),
    );

    for (const attempt of [1, 2]) {
      const refused = await device.blob(hash);
      expect(
        refused.ok,
        `attempt ${String(attempt)} kept a body past the size the copy states`,
      ).toBe(false);
      if (!refused.ok) expect(refused.refusal.code).toBe("bytes_absent");
      expect(inCache(device), `attempt ${String(attempt)}`).toEqual([]);
    }
    expect(links.given).toHaveLength(2);
  });

  it("is taken first when a trim fits the budget, whenever it was read", async () => {
    const small = bytesOf(5, 10);
    const big = bytesOf(6);
    const [smallHash, bigHash] = [hashOf(small), hashOf(big)];
    harness = await hydratedWith("large-trim-first", [
      { hash: smallHash, stated: 10 },
      { hash: bigHash, stated: SIZE },
    ]);
    const { device } = harness;
    scriptLinks(harness, smallHash, () => whole(small));
    scriptLinks(harness, bigHash, () => whole(big));
    expect((await device.fileBudget("keep-all")).ok).toBe(true);
    expect((await device.blob(smallHash)).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await device.blob(bigHash)).ok).toBe(true);
    expect(inCache(device)).toHaveLength(2);

    // The small file was read longest ago, so a trim that went by reading
    // alone would take it first and then the big one as well. Taking the big
    // file first leaves the small one, which fits.
    const set = await device.fileBudget(BUDGET);
    expect(set.ok, JSON.stringify(set)).toBe(true);
    if (set.ok) expect(set.value.trimmed_bytes).toBe(SIZE);
    expect(existsSync(heldAt(device, bigHash))).toBe(false);
    expect(readFileSync(heldAt(device, smallHash))).toEqual(small);
  });
});

describe("the file cache after a file larger than the budget is fetched", () => {
  it("keeps the other files the budget holds, and takes the large one first at the next trim", async () => {
    const [a, b, big] = [bytesOf(20, 10), bytesOf(21, 10), bytesOf(22)];
    const [aHash, bHash, bigHash] = [hashOf(a), hashOf(b), hashOf(big)];
    harness = await hydratedWith("large-keeps-others", [
      { hash: aHash, stated: 10 },
      { hash: bHash, stated: 10 },
      { hash: bigHash, stated: SIZE },
    ]);
    const { device } = harness;
    for (const [hash, bytes] of [
      [aHash, a],
      [bHash, b],
      [bigHash, big],
    ] as const) {
      scriptLinks(harness, hash, () => whole(bytes));
    }
    expect((await device.fileBudget(BUDGET)).ok).toBe(true);
    expect((await device.blob(aHash)).ok).toBe(true);
    expect((await device.blob(bHash)).ok).toBe(true);

    // The budget is 1,000 bytes and the file 5,000: the trim after the fetch
    // cannot take the file being read, and must not take the rest for it.
    const fetched = await device.blob(bigHash);
    expect(fetched.ok, JSON.stringify(fetched)).toBe(true);
    expect(readFileSync(heldAt(device, aHash))).toEqual(a);
    expect(readFileSync(heldAt(device, bHash))).toEqual(b);
    expect(readFileSync(heldAt(device, bigHash))).toEqual(big);

    // Nothing reads it now, so the next trim takes it first, and only it.
    const trimmed = await device.fileBudget(BUDGET);
    expect(trimmed.ok, JSON.stringify(trimmed)).toBe(true);
    if (trimmed.ok) expect(trimmed.value.trimmed_bytes).toBe(SIZE);
    expect(existsSync(heldAt(device, bigHash))).toBe(false);
    expect(readFileSync(heldAt(device, aHash))).toEqual(a);
    expect(readFileSync(heldAt(device, bHash))).toEqual(b);
  });
});

describe("a partial file", () => {
  it("counts in the bytes held, and a trim takes it where no fetch holds it", async () => {
    const bytes = bytesOf(23);
    const small = bytesOf(24, 10);
    const [hash, smallHash] = [hashOf(bytes), hashOf(small)];
    harness = await hydratedWith("partial-trimmed", [
      { hash, stated: SIZE },
      { hash: smallHash, stated: 10 },
    ]);
    const { device } = harness;
    scriptLinks(harness, hash, () => whole(bytes, { cut: 3000 }));
    scriptLinks(harness, smallHash, () => whole(small));
    expect((await device.fileBudget("keep-all")).ok).toBe(true);
    expect((await device.blob(hash)).ok).toBe(false);
    expect((await device.blob(smallHash)).ok).toBe(true);
    expect(inCache(device)).toHaveLength(2);
    expect(await heldBytes(device)).toBe(3010);

    const trimmed = await device.fileBudget(BUDGET);
    expect(trimmed.ok, JSON.stringify(trimmed)).toBe(true);
    if (trimmed.ok) expect(trimmed.value.trimmed_bytes).toBe(3000);
    expect(inCache(device)).toEqual([smallHash.slice("sha256:".length)]);
    expect(await heldBytes(device)).toBe(10);
  });

  it("is taken by a fetch the volume has no room for, before the ask is refused", async () => {
    const bytes = bytesOf(25);
    const other = bytesOf(26);
    const [hash, otherHash] = [hashOf(bytes), hashOf(other)];
    harness = await hydratedWith("partial-no-room", [
      { hash, stated: SIZE },
      { hash: otherHash, stated: SIZE },
    ]);
    const { device } = harness;
    scriptLinks(harness, hash, () => whole(bytes, { cut: 3000 }));
    scriptLinks(harness, otherHash, () => whole(other));
    expect((await device.blob(hash)).ok).toBe(false);
    expect(inCache(device)).toHaveLength(1);

    const refused = await withFault(volume(1000), () => device.blob(otherHash));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("no_room");
    expect(
      inCache(device),
      "the space held by another partial was kept",
    ).toEqual([]);
  });
});

describe("a fetch the volume has no room for", () => {
  it("is refused before it starts, naming the size and the space free, leaving nothing", async () => {
    const bytes = bytesOf(7);
    const hash = hashOf(bytes);
    harness = await hydratedWith("no-room", [{ hash, stated: SIZE }]);
    const { device } = harness;
    const links = scriptLinks(harness, hash, () => whole(bytes));

    const refused = await withFault(volume(SIZE - 1), () => device.blob(hash));
    expect(refused.ok, "a file that does not fit was fetched").toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe("no_room");
    expect(refused.refusal.raw).toContain(String(SIZE));
    expect(refused.refusal.raw).toContain(String(SIZE - 1));
    expect(inCache(device)).toEqual([]);
    expect(links.asked).toHaveLength(1);

    // The witness: the same fetch with exactly the room it needs is taken.
    const taken = await withFault(volume(SIZE), () => device.blob(hash));
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
    expect(readFileSync(heldAt(device, hash))).toEqual(bytes);
  });

  it("is refused for the bytes still to come when part of the file is held, and drops what was held", async () => {
    const bytes = bytesOf(8);
    const hash = hashOf(bytes);
    harness = await hydratedWith("no-room-resume", [{ hash, stated: SIZE }]);
    const { device } = harness;
    scriptLinks(harness, hash, (attempt, from) =>
      attempt === 1 ? whole(bytes, { cut: 3000 }) : ranged(bytes, from),
    );

    const broken = await device.blob(hash);
    expect(broken.ok).toBe(false);
    expect(inCache(device)).toHaveLength(1);

    // 2,000 bytes are still to come: 1,999 free is too few, and 2,000 is
    // enough, which a check against the whole 5,000 would refuse.
    const refused = await withFault(volume(1999), () => device.blob(hash));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("no_room");
    expect(inCache(device)).toEqual([]);
  });

  it("is taken where the bytes still to come fit, though the whole file would not", async () => {
    const bytes = bytesOf(9);
    const hash = hashOf(bytes);
    harness = await hydratedWith("room-resume", [{ hash, stated: SIZE }]);
    const { device } = harness;
    const links = scriptLinks(harness, hash, (attempt, from) =>
      attempt === 1 ? whole(bytes, { cut: 3000 }) : ranged(bytes, from),
    );
    expect((await device.blob(hash)).ok).toBe(false);

    const taken = await withFault(volume(2000), () => device.blob(hash));
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
    expect(readFileSync(heldAt(device, hash))).toEqual(bytes);
    expect(links.asked.at(-1)).toBe("bytes=3000-");
  });
});

describe("a fetch that stops part way", () => {
  it("resumes with a range request against a server that honours ranges, on a new link", async () => {
    const bytes = bytesOf(10);
    const hash = hashOf(bytes);
    harness = await hydratedWith("resume-ranges", [{ hash, stated: SIZE }]);
    const { device } = harness;
    const links = scriptLinks(harness, hash, (attempt, from) =>
      attempt === 1 ? whole(bytes, { cut: 3000 }) : ranged(bytes, from),
    );
    expect((await device.fileBudget(BUDGET)).ok).toBe(true);

    const broken = await device.blob(hash);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.refusal.code).toBe("bytes_absent");
    // The bytes that arrived are kept, named by the hash, and are not the blob.
    const hex = hash.slice("sha256:".length);
    const kept = inCache(device).filter((name) => name.includes(hex));
    expect(kept).toHaveLength(1);
    expect(kept[0]).not.toBe(hex);
    expect(readFileSync(`${device.store}.blobs/${kept[0] ?? ""}`)).toEqual(
      bytes.subarray(0, 3000),
    );
    expect((await device.fileBudget()).ok).toBe(true);

    const resumed = await device.blob(hash);
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    expect(readFileSync(heldAt(device, hash))).toEqual(bytes);
    expect(links.asked).toEqual([undefined, "bytes=3000-"]);
    expect(links.given).toHaveLength(2);
    expect(inCache(device)).toEqual([hex]);
  });

  it("starts again from nothing against a server that answers a range request with 200", async () => {
    const bytes = bytesOf(11);
    const hash = hashOf(bytes);
    harness = await hydratedWith("resume-200", [{ hash, stated: SIZE }]);
    const { device } = harness;
    const links = scriptLinks(harness, hash, (attempt) =>
      whole(bytes, attempt === 1 ? { cut: 3000 } : {}),
    );
    expect((await device.blob(hash)).ok).toBe(false);

    const again = await device.blob(hash);
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(readFileSync(heldAt(device, hash))).toEqual(bytes);
    expect(links.asked).toEqual([undefined, "bytes=3000-"]);
    expect(inCache(device)).toEqual([hash.slice("sha256:".length)]);
  });

  it("fails on any other answer to a range request, and on a range that does not begin where the bytes held end", async () => {
    const bytes = bytesOf(12);
    const hash = hashOf(bytes);
    harness = await hydratedWith("resume-other", [{ hash, stated: SIZE }]);
    const { device } = harness;
    scriptLinks(harness, hash, (attempt, from) => {
      if (attempt === 1) return whole(bytes, { cut: 3000 });
      if (attempt === 2) return { ...whole(Buffer.alloc(0)), status: 500 };
      if (attempt === 3) {
        // A range from the wrong place.
        return {
          kind: "bytes",
          status: 206,
          body: bytes.subarray(2000),
          headers: { "content-range": `bytes 2000-4999/${String(SIZE)}` },
        };
      }
      return ranged(bytes, from);
    });
    expect((await device.blob(hash)).ok).toBe(false);

    const refused = await device.blob(hash);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("bytes_absent");
    // A link that failed says nothing against the bytes held.
    expect(inCache(device)).toHaveLength(1);

    const wrong = await device.blob(hash);
    expect(wrong.ok, "a range from the wrong place was appended").toBe(false);
    if (!wrong.ok) expect(wrong.refusal.code).toBe("bytes_absent");
    // The bytes held cannot be told to be a start of this file, so they go.
    expect(inCache(device)).toEqual([]);

    const fresh = await device.blob(hash);
    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    expect(readFileSync(heldAt(device, hash))).toEqual(bytes);
  });

  it("fails on a range whose last byte overflows or lies past the whole", async () => {
    const bytes = bytesOf(27);
    const hash = hashOf(bytes);
    harness = await hydratedWith("resume-overflow", [{ hash, stated: SIZE }]);
    const { device } = harness;
    const ranges = [
      "bytes 3000-18446744073709551615/5000",
      "bytes 3000-18446744073709551615/18446744073709551615",
      "bytes 3000-5000/5000",
    ];
    let lying = "";
    scriptLinks(harness, hash, (_, from) =>
      from === 0
        ? whole(bytes, { cut: 3000 })
        : {
            kind: "bytes",
            status: 206,
            body: bytes.subarray(from),
            headers: { "content-range": lying },
          },
    );
    for (const range of ranges) {
      // Each attempt starts from a partial file of 3,000 bytes.
      lying = "";
      expect((await device.blob(hash)).ok).toBe(false);
      expect(inCache(device)).toHaveLength(1);
      lying = range;
      const refused = await device.blob(hash);
      expect(refused.ok, `${range} was appended`).toBe(false);
      if (!refused.ok) expect(refused.refusal.code, range).toBe("bytes_absent");
      expect(inCache(device), range).toEqual([]);
    }
  });

  it("keeps nothing of a resumed fetch whose whole does not hash to the blob's name", async () => {
    const bytes = bytesOf(13);
    const hash = hashOf(bytes);
    const other = bytesOf(14);
    harness = await hydratedWith("resume-mismatch", [{ hash, stated: SIZE }]);
    const { device } = harness;
    const links = scriptLinks(harness, hash, (attempt, from) =>
      attempt === 1
        ? whole(bytes, { cut: 3000 })
        : attempt === 2
          ? // The tail of another file of the same length.
            ranged(
              Buffer.concat([bytes.subarray(0, from), other.subarray(from)]),
              from,
            )
          : ranged(bytes, from),
    );
    expect((await device.blob(hash)).ok).toBe(false);

    const altered = await device.blob(hash);
    expect(altered.ok, "bytes that do not hash to the name were kept").toBe(
      false,
    );
    if (!altered.ok) expect(altered.refusal.code).toBe("decoding");
    expect(links.asked.at(-1)).toBe("bytes=3000-");
    expect(inCache(device)).toEqual([]);

    // The witness: the same fetch with the true tail is taken.
    expect((await device.blob(hash)).ok).toBe(true);
    expect(readFileSync(heldAt(device, hash))).toEqual(bytes);
  });

  it("is taken when the link goes quiet part way, as a link that stops", async () => {
    // A link that sends its length and then fewer bytes, then closes: the
    // bytes that came are the start of the file, not a file.
    const bytes = bytesOf(15);
    const hash = hashOf(bytes);
    harness = await hydratedWith("resume-short", [{ hash, stated: SIZE }]);
    const { device } = harness;
    scriptLinks(harness, hash, (attempt, from) =>
      attempt === 1 ? whole(bytes, { cut: 1 }) : ranged(bytes, from),
    );
    expect((await device.blob(hash)).ok).toBe(false);
    expect((await device.blob(hash)).ok).toBe(true);
    expect(readFileSync(heldAt(device, hash))).toEqual(bytes);
  });

  it("drops the bytes held when the disk fills part way, so the space is given back", async () => {
    const bytes = bytesOf(16);
    const hash = hashOf(bytes);
    harness = await hydratedWith("disk-full", [{ hash, stated: SIZE }]);
    const { device } = harness;
    scriptLinks(harness, hash, (_, from) => ranged(bytes, from));

    const full = await withFault("fetch-disk-full=2000", () =>
      device.blob(hash),
    );
    expect(full.ok, "a fetch that could not write was taken").toBe(false);
    if (!full.ok) expect(full.refusal.code).toBe("storage_full");
    // A full disk is the one failure that keeps nothing: what was kept would
    // hold the space the person needs back.
    expect(inCache(device)).toEqual([]);

    // The witness: the same fetch, with the disk not full, is taken.
    expect((await device.blob(hash)).ok).toBe(true);
    expect(readFileSync(heldAt(device, hash))).toEqual(bytes);
  });
});

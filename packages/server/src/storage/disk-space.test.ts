import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import {
  DiskReserve,
  type Admission,
  RESERVE_CHECK_EVERY_BYTES,
  diskFull,
} from "./disk-space.js";

const MIB = 1024 * 1024;

/** A volume whose free space is whatever the test says it is now. */
function volume(initial: number) {
  const state = { free: initial, looks: 0 };
  return {
    state,
    available: () => {
      state.looks++;
      return Promise.resolve(state.free);
    },
  };
}

function chunks(count: number, size = MIB): Readable {
  return Readable.from(
    (function* () {
      for (let i = 0; i < count; i++) yield Buffer.alloc(size);
    })(),
  );
}

async function sink(source: Readable, place: Admission): Promise<number> {
  let bytes = 0;
  await pipeline(source, place.guard(), async function (stream) {
    for await (const chunk of stream) bytes += (chunk as Buffer).length;
  });
  return bytes;
}

describe("DiskReserve.admit", () => {
  it("admits a body that leaves exactly the reserve beside its own slack, and refuses one byte more", async () => {
    const disk = volume(100 * MIB);
    const reserve = new DiskReserve("/data", 40 * MIB, disk.available);
    // The body itself may be one look's worth ahead of the volume's figure.
    const fits = 60 * MIB - RESERVE_CHECK_EVERY_BYTES;
    (await reserve.admit(fits)).close();
    const refusal = await reserve.admit(fits + 1).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(MarfaError);
    expect((refusal as MarfaError).code).toBe(ErrorCode.INSUFFICIENT_STORAGE);
    expect((refusal as MarfaError).status).toBe(507);
    expect((refusal as MarfaError).details).toEqual({
      reserve_bytes: 40 * MIB,
      available_bytes: 100 * MIB,
    });
  });

  it("refuses a volume already inside the reserve when nothing is declared", async () => {
    const reserve = new DiskReserve("/data", 40, volume(39).available);
    await expect(reserve.admit()).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_STORAGE,
    });
  });

  it("holds nothing back at a reserve of zero, and does not look at the volume", async () => {
    const disk = volume(0);
    const reserve = new DiskReserve("/data", 0, disk.available);
    const place = await reserve.admit(10 * MIB);
    await sink(chunks(8), place);
    place.close();
    expect(disk.state.looks).toBe(0);
  });

  it("counts what bodies already admitted have yet to write, so bodies that arrive together cannot each take the same room", async () => {
    const disk = volume(1000 * MIB);
    const reserve = new DiskReserve("/data", 100 * MIB, disk.available);
    // Each alone fits in the 900 MiB above the reserve; together they do not.
    const first = await reserve.admit(500 * MIB);
    const second = await reserve.admit(300 * MIB);
    await expect(reserve.admit(300 * MIB)).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_STORAGE,
    });
    // The witness: the same body is taken once an earlier one is done.
    first.close();
    (await reserve.admit(300 * MIB)).close();
    second.close();
  });

  it("takes bodies that arrive together one at a time, so each finds what the others left", async () => {
    const disk = volume(100 * MIB + 10 * MIB);
    const reserve = new DiskReserve("/data", 100 * MIB, disk.available);
    const answers = await Promise.allSettled(
      Array.from({ length: 5 }, () => reserve.admit(3 * MIB)),
    );
    expect(answers.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(answers.filter((a) => a.status === "rejected")).toHaveLength(4);
  });

  it("counts a body in flight at the slack it may be ahead of its last look, even when it declared nothing", async () => {
    const disk = volume(100 * MIB + 3 * RESERVE_CHECK_EVERY_BYTES);
    const reserve = new DiskReserve("/data", 100 * MIB, disk.available);
    const held = [];
    for (let i = 0; i < 3; i++) held.push(await reserve.admit());
    await expect(reserve.admit()).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_STORAGE,
    });
    for (const place of held) place.close();
    (await reserve.admit()).close();
  });
});

describe("Admission.guard", () => {
  it("passes every byte while the volume keeps its reserve", async () => {
    const disk = volume(1000 * MIB);
    const reserve = new DiskReserve("/data", 100 * MIB, disk.available);
    const place = await reserve.admit();
    expect(await sink(chunks(20), place)).toBe(20 * MIB);
    place.close();
    // One look to admit, then one for each stretch of the stream.
    expect(disk.state.looks).toBe(
      1 + Math.floor((20 * MIB) / RESERVE_CHECK_EVERY_BYTES),
    );
  });

  it("stops a stream as the volume falls inside the reserve, not before", async () => {
    const disk = volume(1000 * MIB);
    const reserve = new DiskReserve("/data", 100 * MIB, disk.available);
    const place = await reserve.admit();
    let seen = 0;
    const source = Readable.from(
      (function* () {
        for (let i = 0; i < 64; i++) {
          seen++;
          // What the stream has written so far is what the volume has lost.
          disk.state.free = 1000 * MIB - i * MIB * 16;
          yield Buffer.alloc(MIB);
        }
      })(),
    );
    const outcome = await sink(source, place).catch((e: unknown) => e);
    place.close();
    expect(outcome).toBeInstanceOf(MarfaError);
    expect((outcome as MarfaError).code).toBe(ErrorCode.INSUFFICIENT_STORAGE);
    expect(seen).toBeLessThan(64);
    expect(seen).toBeGreaterThan(RESERVE_CHECK_EVERY_BYTES / MIB);
  });

  it("looks as often as a small reserve needs, not as seldom as a large one", async () => {
    const disk = volume(1000 * MIB);
    const reserve = new DiskReserve("/data", 1 * MIB, disk.available);
    const place = await reserve.admit();
    await sink(chunks(8), place);
    place.close();
    expect(disk.state.looks).toBeGreaterThan(4);
  });
});

describe("diskFull", () => {
  it("types the real SQLITE_FULL the database driver raises, through the wrapper the query layer adds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marfa-full-"));
    const client = createClient({ url: `file:${join(dir, "full.db")}` });
    try {
      await client.execute("CREATE TABLE t (b BLOB)");
      await client.execute("PRAGMA max_page_count = 16");
      let raised: unknown;
      for (let i = 0; i < 64 && raised === undefined; i++) {
        raised = await client
          .execute({
            sql: "INSERT INTO t VALUES (?)",
            args: [Buffer.alloc(64 * 1024)],
          })
          .then(
            () => undefined,
            (e: unknown) => e,
          );
      }
      expect(raised).toBeDefined();
      expect((raised as { code?: string }).code).toMatch(/^SQLITE_FULL/);

      const wrapped = new Error("Failed query: insert into t", {
        cause: raised,
      });
      const typed = diskFull(wrapped);
      expect(typed?.code).toBe(ErrorCode.INSUFFICIENT_STORAGE);
      expect(typed?.status).toBe(507);
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(existsSync("/dev/full"))(
    "types the real ENOSPC the operating system raises on a write",
    async () => {
      const raised = await pipeline(
        Readable.from([Buffer.alloc(1024)]),
        createWriteStream("/dev/full"),
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect((raised as { code?: string }).code).toBe("ENOSPC");
      expect(diskFull(raised)?.code).toBe(ErrorCode.INSUFFICIENT_STORAGE);
    },
  );

  it("leaves any other fault, a typed refusal and a cycle alone", () => {
    expect(diskFull(new Error("boom"))).toBeUndefined();
    expect(diskFull(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(
      undefined,
    );
    expect(diskFull("ENOSPC")).toBeUndefined();
    expect(
      diskFull(new MarfaError(ErrorCode.VALIDATION_ERROR, "no")),
    ).toBeUndefined();
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(diskFull(loop)).toBeUndefined();
  });
});

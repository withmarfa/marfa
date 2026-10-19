import { existsSync, statSync, symlinkSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { DiskReserve, type Admission, diskFull } from "./disk-space.js";

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
  const dir = mkdtempSync(join(tmpdir(), "marfa-admission-"));
  const path = join(dir, "body");
  try {
    await pipeline(source, place.writer(path));
    return statSync(path).size;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the process-wide volume ledger", () => {
  it.each([0, 1])(
    "fails a body of %i chunks whose file cannot be opened, and pays back its admission",
    async (count) => {
      const dir = mkdtempSync(join(tmpdir(), "marfa-admission-"));
      try {
        const reserve = new DiskReserve(dir, MIB, volume(4 * MIB).available);
        const place = await reserve.admit(MIB);
        await expect(
          pipeline(
            chunks(count, 1024),
            place.writer(join(dir, "gone", "body")),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
        place.close();
        (await reserve.admit(3 * MIB)).close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("admits exactly the available capacity and refuses one byte more with 507", async () => {
    const disk = volume(100 * MIB);
    const reserve = new DiskReserve("/data", 40 * MIB, disk.available);
    (await reserve.admit(60 * MIB)).close();
    await expect(reserve.admit(60 * MIB + 1)).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_STORAGE,
      status: 507,
      details: { reserve_bytes: 40 * MIB, available_bytes: 100 * MIB },
    });
  });

  it("refuses a volume already inside the reserve even without a declared length", async () => {
    await expect(
      new DiskReserve("/data", 40, volume(39).available).admit(),
    ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_STORAGE });
  });

  it("holds nothing back or probes the volume at a reserve of zero", async () => {
    const disk = volume(0);
    const place = await new DiskReserve("/data", 0, disk.available).admit(
      10 * MIB,
    );
    try {
      expect(await sink(chunks(8), place)).toBe(8 * MIB);
    } finally {
      place.close();
    }
    expect(disk.state.looks).toBe(0);
  });

  it("serializes simultaneous admissions from different users of the same device", async () => {
    const disk = volume(110 * MIB);
    const users = Array.from(
      { length: 5 },
      (_, i) =>
        new DiskReserve(`/data/${String(i)}`, 100 * MIB, disk.available),
    );
    const answers = await Promise.allSettled(
      users.map((reserve) => reserve.admit(3 * MIB)),
    );
    try {
      expect(
        answers.filter((answer) => answer.status === "fulfilled"),
      ).toHaveLength(3);
      expect(
        answers.filter((answer) => answer.status === "rejected"),
      ).toHaveLength(2);
    } finally {
      for (const answer of answers)
        if (answer.status === "fulfilled") answer.value.close();
    }
    (await users[0]!.admit(10 * MIB)).close();
  });

  it("finds a shared volume through distinct directories and a symlink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marfa-volume-"));
    const disk = volume(102 * MIB);
    symlinkSync(dir, join(dir, "alias"));
    const database = new DiskReserve(
      join(dir, "database"),
      100 * MIB,
      disk.available,
      "database",
    );
    const blobs = new DiskReserve(
      join(dir, "alias", "blobs"),
      100 * MIB,
      disk.available,
    );
    const held = await database.admit(2 * MIB);
    try {
      await expect(blobs.admit(1)).rejects.toMatchObject({
        code: "insufficient_storage",
      });
    } finally {
      held.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pays down a declared body after each completed write while keeping its unwritten bytes reserved", async () => {
    const disk = volume(110 * MIB);
    const reserve = new DiskReserve("/data", 100 * MIB, disk.available);
    const place = await reserve.admit(8 * MIB);
    try {
      await place.write(4 * MIB, () => {
        disk.state.free -= 4 * MIB;
        return Promise.resolve();
      });
      const concurrent = await reserve.admit(2 * MIB);
      try {
        await expect(reserve.admit(1)).rejects.toMatchObject({
          code: "insufficient_storage",
        });
      } finally {
        concurrent.close();
      }
    } finally {
      place.close();
    }
    (await reserve.admit(6 * MIB)).close();
  });

  it("keeps an unwritten chunk reserved until its write acknowledges completion", async () => {
    const disk = volume(102 * MIB);
    const reserve = new DiskReserve("/data", 100 * MIB, disk.available);
    const place = await reserve.admit();
    let complete!: () => void;
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const first = place.write(2 * MIB, async () => {
      entered();
      await finished;
      disk.state.free -= 2 * MIB;
    });
    await writing;
    const next = reserve.admit(1).catch((error: unknown) => error);
    complete();
    try {
      await first;
      expect(await next).toMatchObject({ code: "insufficient_storage" });
    } finally {
      place.close();
    }
  });
});

describe("admitted file writes", () => {
  it("passes every byte while space remains", async () => {
    const place = await new DiskReserve(
      "/data",
      100 * MIB,
      volume(1000 * MIB).available,
    ).admit();
    try {
      expect(await sink(chunks(20), place)).toBe(20 * MIB);
    } finally {
      place.close();
    }
  });

  it("refuses a single oversized chunk before writing it, including undeclared growth", async () => {
    const place = await new DiskReserve(
      "/data",
      MIB,
      volume(2 * MIB).available,
    ).admit();
    try {
      await expect(sink(chunks(1, 2 * MIB), place)).rejects.toMatchObject({
        code: "insufficient_storage",
      });
    } finally {
      place.close();
    }
  });

  it("contains a lying declared length by admitting growth before writing it", async () => {
    const disk = volume(3 * MIB);
    const place = await new DiskReserve("/data", MIB, disk.available).admit(1);
    try {
      await expect(sink(chunks(1, 3 * MIB), place)).rejects.toMatchObject({
        code: "insufficient_storage",
      });
    } finally {
      place.close();
    }
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

it.runIf(
  existsSync("/dev/shm") && statSync("/dev/shm").dev !== statSync(tmpdir()).dev,
)("keeps reservations on distinct devices independent", async () => {
  const first = mkdtempSync(join(tmpdir(), "marfa-device-first-"));
  const second = mkdtempSync("/dev/shm/marfa-device-second-");
  const disk = volume(2 * MIB);
  const place = await new DiskReserve(first, MIB, disk.available).admit(MIB);
  try {
    (await new DiskReserve(second, MIB, disk.available).admit(MIB)).close();
  } finally {
    place.close();
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

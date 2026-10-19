import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { ScratchDatabase } from "./scratch-database.js";
import { DiskReserve, diskFull } from "../disk-space.js";

let client: Client | undefined;
let directory: string;
afterEach(() => {
  client?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it("caps native statement growth before it can consume the reserve, including FTS pages", async () => {
  directory = mkdtempSync(join(tmpdir(), "marfa-scratch-budget-"));
  const path = join(directory, "scratch.db");
  const reserve = 1024 * 1024;
  let capacity = 512 * 1024;
  client = new ScratchDatabase(path, () =>
    new DiskReserve(
      path,
      reserve,
      async () => reserve + capacity - statSync(path).size,
    ).scratch(),
  ).client(pathToFileURL(path).href);
  await client.execute("CREATE VIRTUAL TABLE words USING fts5(body)");
  await client.execute({
    sql: "INSERT INTO words(body) VALUES (?)",
    args: ["small witness"],
  });
  expect((await client.execute("SELECT body FROM words")).rows).toHaveLength(1);
  const huge = "unbounded ".repeat(256 * 1024);
  let refusal: unknown;
  try {
    await client.execute({
      sql: "INSERT INTO words(body) VALUES (?)",
      args: [huge],
    });
  } catch (error) {
    refusal = error;
  }
  expect(diskFull(refusal)?.code).toBe("insufficient_storage");
  expect(statSync(path).size).toBeLessThanOrEqual(capacity);
  expect(readdirSync(directory)).toEqual(["scratch.db"]);
  expect((await client.execute("SELECT body FROM words")).rows).toHaveLength(1);
  capacity = 16 * 1024 * 1024;
  await client.execute({
    sql: "INSERT INTO words(body) VALUES (?)",
    args: [huge],
  });
  expect((await client.execute("SELECT body FROM words")).rows).toHaveLength(2);
});

it("rechecks free space on later statements and still permits rollback", async () => {
  directory = mkdtempSync(join(tmpdir(), "marfa-scratch-shrinking-"));
  const path = join(directory, "scratch.db");
  let free = 1024 * 1024;
  client = new ScratchDatabase(path, () =>
    new DiskReserve(path, 64 * 1024, async () => free).scratch(),
  ).client(pathToFileURL(path).href);
  await client.execute("CREATE TABLE data (value TEXT)");
  await client.execute("BEGIN IMMEDIATE");
  await client.execute("INSERT INTO data VALUES ('witness')");
  free = 64 * 1024;
  await expect(
    client.execute("INSERT INTO data VALUES ('refused')"),
  ).rejects.toMatchObject({ code: "insufficient_storage" });
  await client.execute("ROLLBACK");
  free = 1024 * 1024;
  expect((await client.execute("SELECT * FROM data")).rows).toEqual([]);
});

it("closing one scratch connection does not release or close another connection's budget", async () => {
  directory = mkdtempSync(join(tmpdir(), "marfa-scratch-connections-"));
  const path = join(directory, "scratch.db");
  const reserve = new DiskReserve(path, 1024 * 1024);
  const scratch = new ScratchDatabase(path, () => reserve.scratch());
  client = scratch.client(pathToFileURL(path).href);
  const other = scratch.client(pathToFileURL(path).href);
  await client.execute("CREATE TABLE data (value TEXT)");
  await other.execute("SELECT * FROM data");
  other.close();
  await client.execute("INSERT INTO data VALUES ('still open')");
  expect((await client.execute("SELECT * FROM data")).rows).toHaveLength(1);
});

it("keeps sparse cache-spill pages reserved when an upload competes before commit", async () => {
  directory = mkdtempSync(join(tmpdir(), "marfa-scratch-spill-"));
  const path = join(directory, "scratch.db");
  const uploadPath = join(directory, "upload");
  const floor = 1024 * 1024;
  let capacity = 16 * 1024 * 1024;
  const allocated = () =>
    readdirSync(directory).reduce(
      (total, file) => total + statSync(join(directory, file)).blocks * 512,
      0,
    );
  const free = () => capacity - allocated();
  const reserve = new DiskReserve(directory, floor, async () => free());
  client = new ScratchDatabase(path, () => reserve.scratch()).client(
    pathToFileURL(path).href,
  );
  await client.execute("PRAGMA cache_size = 4");
  await client.execute(
    "CREATE TABLE data (id INTEGER PRIMARY KEY, value BLOB)",
  );
  await client.execute("BEGIN");
  // Native cache eviction leaves a dirty page below the physical file's end.
  for (let i = 0; i < 32; i++) {
    await client.execute("INSERT INTO data VALUES (NULL, zeroblob(100000))");
    const file = statSync(path);
    if (file.size > file.blocks * 512) break;
  }
  const spilled = statSync(path);
  const hole = spilled.size - spilled.blocks * 512;
  expect(hole).toBeGreaterThan(0);
  const page = Number(
    (await client.execute("PRAGMA page_size")).rows[0]!.page_size,
  );
  const pages = Number(
    (await client.execute("PRAGMA page_count")).rows[0]!.page_count,
  );
  const pendingByLength = pages * page - spilled.size;
  const uploadBytes = 128 * 1024;
  capacity = allocated() + floor + pendingByLength + uploadBytes;
  const upload = async () => {
    const place = await reserve.admit(uploadBytes);
    try {
      await place.write(uploadBytes, () =>
        writeFile(uploadPath, Buffer.alloc(uploadBytes)),
      );
    } finally {
      place.close();
    }
  };
  try {
    await upload();
  } catch (error) {
    expect(error).toMatchObject({ code: "insufficient_storage" });
    // The same upload succeeds once the outstanding sparse page also fits.
    capacity += hole;
    await upload();
  }
  expect(statSync(uploadPath).size).toBe(uploadBytes);
  await client.execute("COMMIT");
  expect(free()).toBeGreaterThanOrEqual(floor);
});

it("releases an initialization lease when the first statement is refused", async () => {
  directory = mkdtempSync(join(tmpdir(), "marfa-scratch-initial-refusal-"));
  const path = join(directory, "scratch.db");
  let free = 1024 * 1024;
  const reserve = new DiskReserve(directory, free, async () => free);
  client = new ScratchDatabase(path, () => reserve.scratch()).client(
    pathToFileURL(path).href,
  );
  await expect(
    client.execute("CREATE TABLE data (value TEXT)"),
  ).rejects.toMatchObject({ code: "insufficient_storage" });
  free += 64 * 1024;
  const admitted = await reserve.admit(4096);
  admitted.close();
  await client.execute("CREATE TABLE data (value TEXT)");
}, 1000);

it("closes the client and releases the lease when allocation bookkeeping fails", async () => {
  directory = mkdtempSync(join(tmpdir(), "marfa-scratch-bookkeeping-"));
  const path = join(directory, "scratch.db");
  const reserve = new DiskReserve(directory, 1024 * 1024);
  client = new ScratchDatabase(path, () => {
    const budget = reserve.scratch();
    return {
      ...budget,
      async acquire() {
        const room = await budget.acquire();
        expect(readdirSync(directory)).toEqual(["scratch.db"]);
        rmSync(path);
        return room;
      },
    };
  }).client(pathToFileURL(path).href);
  await expect(
    client.execute("CREATE TABLE data (value TEXT)"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(client.closed).toBe(true);
  const admitted = await reserve.admit(4096);
  admitted.close();
}, 1000);

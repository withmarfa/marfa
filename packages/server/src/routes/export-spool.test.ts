import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskReserve } from "../storage/disk-space.js";
import { ExportSpool } from "./export-spool.js";

// A folder whose name a URL would read as something else.
let dir: string;
let spool: ExportSpool;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marfa spool #1? 100%25-"));
  let n = 0;
  spool = new ExportSpool(() => join(dir, `file-${String(n++)}`));
});
afterEach(async () => {
  await spool.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("an export's spool", () => {
  it("keeps text, counts its bytes and reads it back", async () => {
    const file = await spool.text();
    await file.append("héllo\n");
    await file.append("");
    await file.append("world\n");
    await file.seal();
    expect(file.bytes).toBe(Buffer.byteLength("héllo\nworld\n"));
    expect(await text(file.read())).toBe("héllo\nworld\n");
  });

  it("keeps sets of strings and answers which it holds", async () => {
    const { itemIds, blobHashes } = await spool.sets();
    await itemIds.add(["b", "a", "c", "a"]);
    await blobHashes.add(["z"]);
    expect(await itemIds.held(["a", "d", "c", "c"])).toEqual(
      new Set(["a", "c"]),
    );
    expect(await blobHashes.held(["a"])).toEqual(new Set());
  });

  it("holds more strings than one statement binds", async () => {
    const { itemIds } = await spool.sets();
    const many = Array.from({ length: 1_300 }, (_, i) =>
      String(i).padStart(5, "0"),
    );
    await itemIds.add(many);
    expect(await itemIds.held(many)).toEqual(new Set(many));
  });

  it("leaves nothing behind when disposed, once or twice", async () => {
    const file = await spool.text();
    await file.append("x");
    const { itemIds } = await spool.sets();
    await itemIds.add(["a"]);
    // The witness: there was something to remove, and no file beside it.
    expect(readdirSync(dir)).toHaveLength(2);
    await spool.dispose();
    await spool.dispose();
    expect(readdirSync(dir)).toEqual([]);
  });
});

it("appends within an allocated block when the remaining free space is exactly the reserve", async () => {
  const path = join(dir, "bounded");
  const block = statfsSync(dir).bsize;
  const reserve = new DiskReserve(dir, 1024 * 1024, () => {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      /* Not created yet. */
    }
    return Promise.resolve(
      1024 * 1024 + block - Math.ceil(size / block) * block,
    );
  });
  spool = new ExportSpool(() => path, reserve);
  const file = await spool.text();
  await file.append("x");
  await file.append("y");
  await file.seal();
  expect(await text(file.read())).toBe("xy");
});

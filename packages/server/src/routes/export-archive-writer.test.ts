import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import * as tar from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  vi.restoreAllMocks();
  __resetEventLogForTests();
  await ctx.cleanup();
});

async function mint(label: string): Promise<{ id: string; key: string }> {
  const minted = await ctx.ownerRequest("/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label,
      source: `export-writer-${label.replace(/\W+/g, "-")}`,
      type_permissions: { "core.note": "write" },
    }),
  });
  expect(minted.status, await minted.clone().text()).toBe(201);
  return (await minted.json()) as { id: string; key: string };
}

async function itemLines(archive: Buffer): Promise<Record<string, unknown>[]> {
  const extract = tar.extract();
  let text = "";
  extract.on("entry", (header, stream, next) => {
    const parts: Buffer[] = [];
    stream.on("data", (part: Buffer) => parts.push(part));
    stream.on("end", () => {
      if (header.name === "items.ndjson")
        text = Buffer.concat(parts).toString();
      next();
    });
  });
  await new Promise<void>((resolve, reject) => {
    extract.on("finish", resolve);
    extract.on("error", reject);
    Readable.from(archive).pipe(createGunzip()).pipe(extract);
  });
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the writer an archive line names", () => {
  it("is the writer of the version the line carries, though a write lands after the row was read", async () => {
    const first = await mint("first writer");
    const second = await mint("second writer");
    const created = await request(ctx.app, "POST", "/items", {
      key: first.key,
      body: { type: "core.note", properties: { body: "one" } },
    });
    const id = ((await created.json()) as { item: { id: string } }).item.id;
    const changed = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: first.key,
      body: { version: 1, properties: { body: "two" } },
    });
    expect(changed.status).toBe(200);

    const list = ctx.storage.items.list.bind(ctx.storage.items);
    let wrote = false;
    vi.spyOn(ctx.storage.items, "list").mockImplementation(async (filters) => {
      const page = await list(filters);
      if (!wrote) {
        wrote = true;
        // Lands between the read of the row and anything read beside it.
        const late = await request(ctx.app, "PATCH", `/items/${id}`, {
          key: second.key,
          body: { version: 2, properties: { body: "three" } },
        });
        expect(late.status, await late.clone().text()).toBe(200);
      }
      return page;
    });

    const res = await request(ctx.app, "GET", "/export?format=archive", {
      key: ctx.workingKey,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const line = (await itemLines(Buffer.from(await res.arrayBuffer()))).find(
      (row) => (row.item as { id: string }).id === id,
    );
    // The witness: the line carries the row as it was read, at version 2.
    expect((line!.item as { version: number }).version).toBe(2);
    expect(line!.writer).toEqual({
      kind: "key",
      id: first.id,
      name: "first writer",
    });
  });
});

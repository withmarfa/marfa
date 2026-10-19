import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import * as tar from "tar-stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Edge, Item, Metadata } from "@withmarfa/shared";
import { activeFaults, clearFaults, setFault } from "../control/faults.js";
import {
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
} from "../test-utils.js";

let ctx: TestContext;
let reader: string;
beforeEach(async () => {
  ctx = await createTestContext();
  reader = await mintWorkingKey(ctx, {
    type_permissions: { "core.note": "read" },
    edge_permissions: { references: "read" },
  });
  const registered = await request(ctx.app, "POST", "/types", {
    key: ctx.workingKey,
    body: { id: "fixture.private", version: 1, fields: {} },
  });
  expect(registered.status).toBe(201);
});
afterEach(async () => {
  clearFaults();
  await ctx.cleanup();
});

interface RecordLine {
  item?: Item;
  metadata?: Metadata;
  edge?: Edge;
}
async function records(
  response: Response,
  format: "ndjson" | "archive",
): Promise<RecordLine[]> {
  expect(response.status).toBe(200);
  if (format === "ndjson")
    return (await response.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RecordLine);
  const lines: RecordLine[] = [];
  const extract = tar.extract();
  const gunzip = createGunzip();
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => {
        if (!Buffer.isBuffer(chunk)) throw new Error("Expected archive bytes");
        chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => {
        if (["items.ndjson", "edges.ndjson"].includes(header.name))
          lines.push(
            ...Buffer.concat(chunks)
              .toString()
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as RecordLine),
          );
        next();
      });
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
    gunzip.on("error", reject);
    Readable.fromWeb(response.body!).pipe(gunzip).pipe(extract);
  });
  return lines;
}

it.each(["ndjson", "archive"] as const)(
  "keeps %s metadata and later edges inside their authorized state",
  async (format) => {
    const create = async (body: string) => {
      const response = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body }, tags: ["public"] },
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { item: Item }).item;
    };
    const target = await create("target");
    const source = await create("source");
    const url = `/export?format=${format}`;
    const control = await records(
      await request(ctx.app, "GET", url, { key: reader }),
      format,
    );
    expect(
      control.find((line) => line.item?.id === source.id)?.metadata?.tags,
    ).toEqual(["public"]);

    setFault("hold:read-hydration", null);
    const pending = request(ctx.app, "GET", url, { key: reader }).then(
      (response) => records(response, format),
    );
    let edgeId: string;
    try {
      await vi.waitFor(() => {
        expect(
          activeFaults().find((fault) => fault.name === "hold:read-hydration")
            ?.waiting,
        ).toBe(1);
      });
      const moved = await request(ctx.app, "PATCH", `/items/${source.id}`, {
        key: ctx.workingKey,
        body: {
          version: source.version,
          type: "fixture.private",
          retype: true,
          properties: { body: "private" },
        },
      });
      expect(moved.status).toBe(200);
      const tagged = await request(
        ctx.app,
        "PUT",
        `/items/${source.id}/metadata`,
        {
          key: ctx.workingKey,
          body: { tags: ["private-tag"] },
        },
      );
      expect(tagged.status).toBe(200);
      const edge = await request(ctx.app, "POST", "/edges", {
        key: ctx.workingKey,
        body: {
          source_id: source.id,
          target_id: target.id,
          edge_type: "references",
        },
      });
      expect(edge.status).toBe(201);
      edgeId = ((await edge.json()) as { edge: Edge }).edge.id;
    } finally {
      clearFaults();
    }
    const exported = await pending;
    expect(
      exported.find((line) => line.item?.id === source.id)?.item?.type,
    ).toBe("core.note");
    expect
      .soft(
        exported.find((line) => line.item?.id === source.id)?.metadata?.tags,
      )
      .toEqual(["public"]);
    expect.soft(exported.some((line) => line.edge?.id === edgeId)).toBe(false);

    const witness = await records(
      await request(ctx.app, "GET", url, { key: ctx.workingKey }),
      format,
    );
    expect(
      witness.find((line) => line.item?.id === source.id)?.metadata?.tags,
    ).toEqual(["private-tag"]);
    expect(witness.some((line) => line.edge?.id === edgeId)).toBe(true);
    const later = await records(
      await request(ctx.app, "GET", url, { key: reader }),
      format,
    );
    expect(
      later.some(
        (line) => line.item?.id === source.id || line.edge?.id === edgeId,
      ),
    ).toBe(false);
  },
);

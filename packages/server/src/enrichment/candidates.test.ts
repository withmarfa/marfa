import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
});

const SIGNATURE = JSON.stringify({ max_blob_bytes: 1, ocr: false });
const fields = {
  blob_ref: { type: "string", required: true },
  mime_type: { type: "string", required: true },
};

async function candidates(): Promise<string[]> {
  const rows = await ctx.storage.enrichment.listCandidates(
    1,
    3,
    200,
    SIGNATURE,
  );
  return rows.map((row) => row.item_id);
}

async function register(
  method: "POST" | "PUT",
  id: string,
  version: number,
  parent?: string,
): Promise<void> {
  const res = await request(
    ctx.app,
    method,
    method === "POST" ? "/types" : `/types/${id}`,
    {
      key: ctx.workingKey,
      body: {
        ...(method === "POST" && { id }),
        version,
        fields,
        ...(parent !== undefined && { parent }),
      },
    },
  );
  expect(res.status, await res.text()).toBe(method === "POST" ? 201 : 200);
}

async function file(type: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type,
      properties: {
        blob_ref: `sha256:${"0".repeat(64)}`,
        mime_type: "image/png",
      },
    },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

describe("enrichment candidates", () => {
  it("include a file type two declared steps below core.file.image", async () => {
    await register("POST", "acme.photo", 1, "core.file.image");
    await register("POST", "acme.superphoto", 1, "acme.photo");
    const id = await file("acme.superphoto");
    expect(await candidates()).toContain(id);
  });

  it("include rows written before their type became a file", async () => {
    await register("POST", "acme.scan", 1);
    const id = await file("acme.scan");
    expect(await candidates()).not.toContain(id);
    await register("PUT", "acme.scan", 2, "core.file");
    expect(await candidates()).toContain(id);
  });
});

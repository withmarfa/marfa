/**
 * The tag listing applies the `source_filter` lever, as the listing it is a
 * facet of does: a tag carried only by rows the lever hides is not listed,
 * and one carried by both kinds counts the approved rows alone.
 */
import { PERMISSIONS } from "@withmarfa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeInstanceConfig } from "../storage/instance-config.js";
import type { TestContext } from "../test-utils.js";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";

let ctx: TestContext;
let trustedKey: string;
let untrustedKey: string;
const run = Math.random().toString(36).slice(2, 8);
const hidden = `hidden-${run}`;
const shared = `shared-${run}`;
const open = `open-${run}`;

async function mintSourceKey(source: string): Promise<string> {
  const raw = await mintWorkingKey(ctx, {
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    profile_permissions: {},
    label: `tags-source-filter-${source}`,
    source,
    permissions: [...PERMISSIONS],
    type_permissions: { "*": "write" },
    default_tier: "library",
  });
  return raw;
}

async function write(key: string, type: string, tags: string[]) {
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: {
      type,
      properties: type === "core.note" ? { body: "x" } : { title: "x" },
      tags,
    },
  });
  expect(res.status).toBe(201);
}

async function tagCounts(): Promise<Record<string, number>> {
  const res = await request(ctx.app, "GET", "/metadata/tags", {
    key: trustedKey,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { tag: string; count: number }[];
  };
  return Object.fromEntries(body.data.map((t) => [t.tag, t.count]));
}

beforeAll(async () => {
  ctx = await createTestContext({});
  trustedKey = await mintSourceKey("trusted");
  untrustedKey = await mintSourceKey("untrusted");
  await write(trustedKey, "core.note", [shared]);
  await write(untrustedKey, "core.note", [shared, hidden]);
  await write(untrustedKey, "core.bookmark", [open]);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /metadata/tags with a source_filter", () => {
  it("lists a tag of a hidden row without the lever, and not with it", async () => {
    const before = await tagCounts();
    expect(before[hidden]).toBe(1);
    expect(before[shared]).toBe(2);

    await writeInstanceConfig(ctx.storage.settings, {
      enforcement: {
        source_filter: { types: ["core.note"], sources: ["trusted"] },
      },
    });

    const after = await tagCounts();
    expect(after[hidden]).toBeUndefined();
    expect(after[shared]).toBe(1);
    // The lever is per type: a row of a type it does not list stays counted.
    expect(after[open]).toBe(1);
  });
});

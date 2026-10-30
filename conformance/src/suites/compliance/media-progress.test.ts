import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "media-progress"));
});

afterAll(async () => {
  await cleanup(ctx);
});

const MEDIA_TYPES = [
  "core.media",
  "core.media.album",
  "core.media.article",
  "core.media.book",
  "core.media.episode",
  "core.media.film",
  "core.media.series",
  "core.media.song",
] as const;

const WORDS = [
  { value: "planned", group: "not_started" },
  { value: "started", group: "in_progress" },
  { value: "finished", group: "completed" },
  { value: "abandoned", group: "canceled" },
];

async function create(type: string, properties: Record<string, unknown>) {
  const created = await client.createItem({
    type,
    source: ctx.source,
    properties,
    tags: [`media-progress-${ctx.runId}`],
  });
  if (created.ok) trackItem(ctx, created.data.item.id);
  return created;
}

describe("the progress of a media item", () => {
  it.each(MEDIA_TYPES)("is an optional status field on %s", async (id) => {
    const read = await client.getType(id);
    expect(read.status).toBe(200);
    expect(read.data.fields.progress).toMatchObject({
      type: "status",
      status_values: WORDS,
    });
    expect(read.data.fields.progress?.required).toBeUndefined();
  });

  it("sits beside a series' own status enum", async () => {
    const read = await client.getType("core.media.series");
    expect(read.data.fields.status).toMatchObject({
      type: "enum",
      enum_values: ["ongoing", "ended", "canceled"],
    });
    const series = await create("core.media.series", {
      title: "A show",
      status: "ongoing",
      progress: "started",
    });
    expect(series.status, JSON.stringify(series.error)).toBe(201);
    expect(series.data.item.properties).toMatchObject({
      status: "ongoing",
      progress: "started",
    });
  });

  it("takes a book started and puts it in the in_progress group", async () => {
    const book = await create("core.media.book", {
      title: "A long book",
      progress: "started",
    });
    expect(book.status, JSON.stringify(book.error)).toBe(201);
    expect(book.data.item.properties.progress).toBe("started");

    const listed = await client.listItems({
      tags: [`media-progress-${ctx.runId}`],
      filter: 'status_group eq "in_progress"',
    });
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    expect(listed.data.data.map((item) => item.id)).toContain(
      book.data.item.id,
    );
  });

  it("refuses a word the type does not declare, naming progress", async () => {
    const refused = await create("core.media.book", {
      title: "A book",
      progress: "reading",
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(JSON.stringify(refused.error)).toContain("progress");
  });

  it("finds a finished film by its group, and leaves a planned one out", async () => {
    const finished = await create("core.media.film", {
      title: "Seen",
      progress: "finished",
    });
    const planned = await create("core.media.film", {
      title: "Next",
      progress: "planned",
    });
    expect(finished.status, JSON.stringify(finished.error)).toBe(201);
    expect(planned.status, JSON.stringify(planned.error)).toBe(201);
    const listed = await client.listItems({
      tags: [`media-progress-${ctx.runId}`],
      filter: 'status_group eq "completed"',
    });
    const ids = listed.data.data.map((item) => item.id);
    expect(ids).toContain(finished.data.item.id);
    expect(ids).not.toContain(planned.data.item.id);
  });
});

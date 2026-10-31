/**
 * Source names and marks travel with an archive: an export writes one line
 * for each, a restore adds the ones the target names nothing for and replaces
 * nothing, and a damaged line refuses the archive before anything is written.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  exportArchive,
  extractArchive,
  repack,
  restore,
} from "./archive-test-helpers.js";
import type { TestContext } from "../test-utils.js";
import {
  closeTestContexts,
  createTestContext,
  mintWorkingKey,
  request,
} from "../test-utils.js";

const contexts: TestContext[] = [];
async function newContext(): Promise<TestContext> {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}

afterAll(async () => {
  await closeTestContexts(contexts);
});

function ownerPatch(ctx: TestContext, source: string, body: unknown) {
  return ctx.ownerRequest(`/source?source=${encodeURIComponent(source)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function ownerExport(ctx: TestContext): Promise<Buffer> {
  const res = await ctx.ownerRequest("/export?format=archive");
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

interface SourceLine {
  source: { source: string; name: string | null; mark: string | null };
}

function sourceLines(entries: Map<string, Buffer>) {
  return entries
    .get("types.ndjson")!
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Partial<SourceLine>)
    .flatMap((line) => (line.source === undefined ? [] : [line.source]));
}

/** An instance with one named source an item carries, one named source no
 *  item carries, and an app's source. */
async function namedInstance() {
  const ctx = await newContext();
  const carried = "archive-carried";
  const writer = await mintWorkingKey(ctx, {
    label: "Writer",
    source: carried,
  });
  const created = await request(ctx.app, "POST", "/items", {
    key: writer,
    body: { type: "core.note", properties: { body: "a note" } },
  });
  expect(created.status).toBe(201);
  expect(
    (
      await ownerPatch(ctx, carried, {
        name: "Carried",
        mark: "simple-icons:github",
      })
    ).status,
  ).toBe(200);
  expect((await ownerPatch(ctx, "archive-idle", { name: "Idle" })).status).toBe(
    200,
  );
  expect(
    (await ownerPatch(ctx, "oauth:client:user", { mark: "lucide:box" })).status,
  ).toBe(200);
  return ctx;
}

describe("source names in an archive", () => {
  it("writes every source line for the owner, and counts them in the manifest", async () => {
    const ctx = await namedInstance();
    const entries = await extractArchive(await ownerExport(ctx));
    expect(sourceLines(entries)).toEqual([
      {
        source: "archive-carried",
        name: "Carried",
        mark: "simple-icons:github",
      },
      { source: "archive-idle", name: "Idle", mark: null },
      { source: "oauth:client:user", name: null, mark: "lucide:box" },
    ]);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString()) as {
      source_count: number;
    };
    expect(manifest.source_count).toBe(3);
  });

  it("writes for a key only the sources of the items it carries", async () => {
    const ctx = await namedInstance();
    const entries = await extractArchive(await exportArchive(ctx));
    expect(sourceLines(entries).map((line) => line.source)).toEqual([
      "archive-carried",
    ]);
  });

  it("round-trips names and marks, under the restored code for an app's source, and replaces none the target has", async () => {
    const archive = await ownerExport(await namedInstance());
    const target = await newContext();
    expect(
      (await ownerPatch(target, "archive-idle", { name: "Target's own" }))
        .status,
    ).toBe(200);

    const restored = await restore(target, archive);
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(await restored.json()).toMatchObject({
      sources_added: 2,
      sources_skipped: 1,
      sources_skipped_reasons: { already_set: 1 },
    });
    expect(await target.storage.sources.get("archive-carried")).toEqual({
      source: "archive-carried",
      name: "Carried",
      mark: "simple-icons:github",
    });
    expect((await target.storage.sources.get("archive-idle"))?.name).toBe(
      "Target's own",
    );
    expect(await target.storage.sources.get("oauth:client:user")).toBeNull();
    expect(
      await target.storage.sources.get("restored:oauth:client:user"),
    ).toEqual({
      source: "restored:oauth:client:user",
      name: null,
      mark: "lucide:box",
    });

    const again = await restore(target, archive);
    expect(await again.json()).toMatchObject({
      sources_added: 0,
      sources_skipped: 3,
    });
  });

  it("skips and counts a mark outside the pinned sets", async () => {
    const archive = await ownerExport(await namedInstance());
    const entries = await extractArchive(archive);
    const bad = await repack(entries, {
      "types.ndjson":
        entries.get("types.ndjson")!.toString() +
        `${JSON.stringify({ source: { source: "odd", name: "Odd", mark: "star" } })}\n`,
    });
    const target = await newContext();
    const restored = await restore(target, bad);
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(await restored.json()).toMatchObject({
      sources_added: 3,
      sources_skipped: 1,
      sources_skipped_reasons: { unknown_mark: 1 },
    });
    expect(await target.storage.sources.get("odd")).toBeNull();
  });

  it("refuses a damaged source line, and writes nothing", async () => {
    const archive = await ownerExport(await namedInstance());
    const entries = await extractArchive(archive);
    const lines = entries.get("types.ndjson")!.toString();
    for (const line of [
      { source: { name: "No code" } },
      { source: { source: " padded ", name: "Padded" } },
      { source: { source: "empty" } },
      { source: { source: "bad-name", name: "a‮b" } },
      { source: { source: "bad-mark", mark: 7 } },
      { source: "not an object" },
      { source: { source: "twice", name: "One" } },
    ]) {
      const extra =
        line.source instanceof Object && line.source.source === "twice"
          ? `${JSON.stringify(line)}\n${JSON.stringify(line)}\n`
          : `${JSON.stringify(line)}\n`;
      const bad = await repack(entries, { "types.ndjson": lines + extra });
      const target = await newContext();
      const refused = await restore(target, bad);
      expect(refused.status, JSON.stringify(line)).toBe(400);
      const code = ((await refused.json()) as { error: { code: string } }).error
        .code;
      expect(code, JSON.stringify(line)).toBe(
        line.source instanceof Object && line.source.source === "twice"
          ? "validation_error"
          : "invalid_schema",
      );
      expect(await target.storage.sources.list()).toEqual([]);
    }
  });
});

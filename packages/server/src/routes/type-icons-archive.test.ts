/**
 * The owner's icons travel with an archive: an export writes one line for
 * each, a restore adds the ones the target has none for and replaces nothing,
 * and a line that names no Lucide icon or no type refuses the archive before
 * anything is written.
 */
import { unregisterTypeSchema } from "@withmarfa/shared";
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

let counter = 0;
function customId(): string {
  counter += 1;
  return `user.archive_icon_${String(counter)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ownerSetIcon(ctx: TestContext, id: string, icon: string) {
  return ctx.ownerRequest(`/types/${id}/icon`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ icon }),
  });
}

async function iconOn(
  ctx: TestContext,
  id: string,
): Promise<string | undefined> {
  const res = await request(ctx.app, "GET", `/types/${id}`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { display_hints?: { icon?: string } })
    .display_hints?.icon;
}

/** A source with a custom type and a shipped type, each given an owner icon. */
async function iconedSource(): Promise<{
  source: TestContext;
  custom: string;
  archive: Buffer;
}> {
  const source = await newContext();
  const custom = customId();
  const registered = await request(source.app, "POST", "/types", {
    key: source.workingKey,
    body: {
      id: custom,
      fields: { title: { type: "string" } },
      display_hints: { icon: "star" },
    },
  });
  expect(registered.status, await registered.clone().text()).toBe(201);
  expect((await ownerSetIcon(source, custom, "box")).status).toBe(200);
  expect((await ownerSetIcon(source, "core.note", "notebook-pen")).status).toBe(
    200,
  );
  return { source, custom, archive: await exportArchive(source) };
}

interface IconLine {
  type_icon: { type_id: string; icon: string };
}

describe("the owner's icons in an archive", () => {
  it("writes one line for each owner icon and counts them in the manifest", async () => {
    const { custom, archive } = await iconedSource();
    const entries = await extractArchive(archive);
    const lines = entries
      .get("types.ndjson")!
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Partial<IconLine>)
      .filter((line) => line.type_icon !== undefined)
      .map((line) => line.type_icon);
    expect(lines).toEqual(
      expect.arrayContaining([
        { type_id: custom, icon: "box" },
        { type_id: "core.note", icon: "notebook-pen" },
      ]),
    );
    expect(lines).toHaveLength(2);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString()) as {
      type_icon_count: number;
    };
    expect(manifest.type_icon_count).toBe(2);
  });

  it("adds the icons the target has none for, and replaces none it has", async () => {
    const { custom, archive } = await iconedSource();
    unregisterTypeSchema(custom);
    const target = await newContext();
    expect((await ownerSetIcon(target, "core.note", "heart")).status).toBe(200);

    const restored = await restore(target, archive);
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(await restored.json()).toMatchObject({
      type_icons_added: 1,
      type_icons_skipped: 1,
    });
    expect(await iconOn(target, custom)).toBe("box");
    expect(await iconOn(target, "core.note")).toBe("heart");

    // Restoring the same archive again changes nothing.
    const again = await restore(target, archive);
    expect(await again.json()).toMatchObject({
      type_icons_added: 0,
      type_icons_skipped: 2,
    });
  });

  it("refuses an archive naming an icon outside the pinned Lucide release, and writes nothing", async () => {
    const { custom, archive } = await iconedSource();
    const entries = await extractArchive(archive);
    const lines = entries.get("types.ndjson")!.toString();
    const bad = await repack(entries, {
      "types.ndjson":
        lines +
        `${JSON.stringify({ type_icon: { type_id: "core.task", icon: "Not-An-Icon" } })}\n`,
    });
    unregisterTypeSchema(custom);
    const target = await newContext();
    const refused = await restore(target, bad);
    expect(refused.status).toBe(400);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_schema");
    expect(await iconOn(target, "core.note")).toBe("sticky-note");
    expect((await target.storage.types.icons()).size).toBe(0);
  });

  it("refuses an icon for a type neither the archive nor the target holds", async () => {
    const { custom, archive } = await iconedSource();
    const entries = await extractArchive(archive);
    const bad = await repack(entries, {
      "types.ndjson":
        entries.get("types.ndjson")!.toString() +
        `${JSON.stringify({ type_icon: { type_id: "user.nothing_here", icon: "box" } })}\n`,
    });
    unregisterTypeSchema(custom);
    const target = await newContext();
    const refused = await restore(target, bad);
    expect(refused.status).toBe(400);
    expect((await target.storage.types.icons()).size).toBe(0);
  });
});

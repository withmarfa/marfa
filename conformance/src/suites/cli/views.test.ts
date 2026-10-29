import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup, trackItem, trackView } from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { CliContext, ItemEnvelope } from "./harness.js";

/** A saved view, made and read from the terminal. */

let c: CliContext;

beforeAll(async () => {
  c = await cliContext("views");
});

afterAll(async () => {
  await cleanup(c.ctx);
});

async function note(title: string): Promise<string> {
  const created = await c.cli.json<ItemEnvelope>([
    "items",
    "create",
    "--type",
    "core.note",
    "--properties",
    JSON.stringify({ title, body: "b" }),
  ]);
  trackItem(c.ctx, created.item.id);
  return created.item.id;
}

describe("views from the terminal", () => {
  it("lists the items a view lists, in its order, a page at a time", async () => {
    const mark = unique("cli-view");
    const second = await note(`${mark}-b`);
    const first = await note(`${mark}-a`);
    const third = await note(`${mark}-c`);
    const made = await c.cli.json<{ item: { id: string } }>([
      "views",
      "create",
      "--title",
      "Terminal view",
      "--query",
      JSON.stringify({ filter: `source eq "${c.ctx.source}"` }),
      "--sort",
      JSON.stringify([{ by: "title", direction: "asc" }]),
    ]);
    const id = made.item.id;
    trackView(c.ctx, id);

    const firstPage = await c.cli.json<{
      data: { id: string }[];
      next_cursor: string | null;
    }>(["views", "items", id, "--limit", "2"]);
    expect(firstPage.data.map((row) => row.id)).toEqual(
      [first, second, third].slice(0, 2),
    );
    expect(firstPage.next_cursor).not.toBeNull();

    const lastPage = await c.cli.json<{
      data: { id: string }[];
      next_cursor: string | null;
    }>(["views", "items", id, "--cursor", firstPage.next_cursor!]);
    expect(lastPage.data.map((row) => row.id)).toContain(third);
    expect(lastPage.next_cursor).toBeNull();
  });
});

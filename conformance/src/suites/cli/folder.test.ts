import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup, trackItem } from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { CliContext, ItemEnvelope } from "./harness.js";

/**
 * The folder round trip, from the terminal: a note dropped in a folder
 * lands in Marfa, an agent with a key changes it from anywhere, and the
 * change comes back to the folder.
 */

let c: CliContext;
let dir: string;

beforeAll(async () => {
  c = await cliContext("folder");
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-folder-"));
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await cleanup(c.ctx);
});

interface PushReport {
  scan: {
    created: number;
    updated: number;
    renamed: number;
    unchanged: number;
  };
  drain: { sent: number; held: number };
  pull: { written: number; rewritten: number; unchanged: number };
}

describe("a folder round trip", () => {
  it("pushes a dropped note, takes an agent's change back into the file, and keeps the item's id", async () => {
    // A seed, so the folder hydrates something and the log is not empty.
    const seed = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title: unique("cli-folder-seed"), body: "seed" }),
    ]);
    trackItem(c.ctx, seed.item.id);

    await c.cli.json([
      "folders",
      "add",
      dir,
      "--types",
      "core.note",
      "--default-type",
      "core.note",
    ]);
    const hydrated = await c.cli.json<{ items: number }>([
      "folders",
      "hydrate",
      dir,
    ]);
    expect(hydrated.items).toBeGreaterThanOrEqual(1);
    // The folder's working copy answers locally once hydrated: the seed is
    // in it. This is the success the exit-code scenario's unhydrated
    // refusal is held against.
    const store = join(dir, ".marfa", "core.sqlite");
    const local = await c.cli.json<Array<{ id: string }>>([
      "device",
      "--db",
      store,
      "items",
      "list",
      "--type",
      "core.note",
    ]);
    expect(local.map((row) => row.id)).toContain(seed.item.id);

    const title = unique("cli-folder-note");
    writeFileSync(
      join(dir, "dropped.md"),
      `---\ntitle: ${title}\nstatus: dropped in a folder\n---\nA note dropped in a folder.\n`,
    );
    const pushed = await c.cli.json<PushReport>(["folders", "push", dir]);
    expect(pushed.scan.created).toBe(1);
    expect(pushed.drain.sent).toBe(1);

    // It is in Marfa under the id the folder minted, with no natural key.
    const queued = await c.cli.json<
      Array<{ kind: string; item_id: string | null }>
    >(["device", "--db", store, "queue"]);
    const minted = queued.find((row) => row.kind === "create_item")?.item_id;
    expect(minted, "the folder queued no create for the note").toBeTruthy();
    const landed = (
      await c.cli.json<{
        item: {
          id: string;
          source_id?: string | null;
          version: number;
          properties: Record<string, unknown>;
        };
      }>(["items", "get", String(minted)])
    ).item;
    trackItem(c.ctx, landed.id);
    expect(landed.source_id ?? null).toBeNull();
    expect(landed.properties.title).toBe(title);
    expect(landed.properties.status).toBe("dropped in a folder");
    // The id is written into the file and never sent as a property of the
    // item.
    expect(landed.properties.marfa_id).toBeUndefined();

    // An agent with its own key changes it from anywhere.
    const changed = await c.cli.json<ItemEnvelope>([
      "items",
      "update",
      landed.id,
      "--version",
      String(landed.version),
      "--prop",
      "status=changed elsewhere",
      "--prop",
      "body=Changed by an agent with its own key.\n",
    ]);
    expect(changed.item.version).toBe(landed.version + 1);

    // The change comes back to the folder: the working copy catches up,
    // then the pull writes the file.
    const caughtUp = await c.cli.json<{
      applied: number;
      reached_head: boolean;
    }>(["device", "--db", store, "catch-up"]);
    expect(caughtUp.applied).toBeGreaterThanOrEqual(1);
    const pulled = await c.cli.json<{ rewritten: number }>([
      "folders",
      "pull",
      dir,
    ]);
    expect(pulled.rewritten).toBe(1);
    const file = readFileSync(join(dir, "dropped.md"), "utf8");
    expect(file).toContain("status: changed elsewhere");
    expect(file).toContain("Changed by an agent with its own key.");
    expect(file).toContain(`marfa_id: ${landed.id}`);
    // A person's own fields keep the order they wrote them in.
    expect(file.indexOf("title:")).toBeLessThan(file.indexOf("status:"));

    // The queue says what became of the write, in the six-word vocabulary.
    const queue = await c.cli.json<
      Array<{ kind: string; verdict: string | null }>
    >(["device", "--db", store, "queue"]);
    const create = queue.find((row) => row.kind === "create_item");
    expect(create?.verdict).toBe("accepted");
  });
});

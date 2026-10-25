import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliFolder, type HeldCommand } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackFolder,
  trackItem,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * A folder's store that another build of the core made, as a store from
 * before a column was added to a table: the folder's own commands replace it
 * where it holds nothing unsent, and leave it, and the folder's files, where
 * it does.
 */

const WAIT = { timeout: 30_000, interval: 100 };
const REPLACED = "replaced the store of";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
const bases: string[] = [];
const held: HeldCommand[] = [];

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "folders-refused-store",
  ));
});
afterEach(async () => {
  for (const command of held.splice(0)) await command.stop();
  for (const base of bases.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

/** A directory for the test's folders and the registry of their machine. */
function machine(label: string): { base: string; registry: string } {
  const base = mkdtempSync(join(realpathSync(tmpdir()), `marfa-${label}-`));
  bases.push(base);
  return { base, registry: join(base, "folders.json") };
}

/** A folder added to a new `system.folder` and hydrated, holding `files`. */
async function added(
  at: { base: string; registry: string },
  name: string,
  query: Record<string, unknown>,
  files: Record<string, string>,
  defaults?: Record<string, unknown>,
): Promise<CliFolder> {
  const dir = join(at.base, name);
  mkdirSync(dir);
  const folder = new CliFolder(dir, {
    binary: requireBinary(),
    url: apiUrl,
    key: apiKey,
    registry: at.registry,
  });
  const settings = await client.createFolder({
    title: `Refused store ${name} ${ctx.runId}`,
    query,
    ...(defaults === undefined ? {} : { defaults }),
  });
  expect(settings.ok, JSON.stringify(settings.error)).toBe(true);
  trackFolder(ctx, settings.data.item.id);
  value(await folder.add(settings.data.item.id));
  value(await folder.hydrate());
  for (const [path, text] of Object.entries(files)) {
    writeFileSync(join(dir, path), text);
  }
  return folder;
}

const ownNotes = () => ({
  types: ["core.note"],
  filter: `source eq "${ctx.source}"`,
});

function note(title: string, body: string): string {
  return `---\ntitle: ${title}\n---\n${body}\n`;
}

/** The notes this run's key wrote, tracked for clean-up. */
async function serverNotes(): Promise<
  Array<{ id: string; properties: Record<string, unknown> }>
> {
  const listed = await client.listItems({
    type: "core.note",
    filter: `source eq "${ctx.source}"`,
    limit: 100,
  });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  for (const row of listed.data.data) trackItem(ctx, row.id);
  return listed.data.data;
}

/** The one note the server holds with `title`, never two. */
async function serverNote(
  title: string,
): Promise<{ id: string; properties: Record<string, unknown> } | undefined> {
  const found = (await serverNotes()).filter(
    (row) => row.properties.title === title,
  );
  expect(found.length, JSON.stringify(found)).toBeLessThan(2);
  return found[0];
}

/** Gives the note at `path` a new body, keeping its frontmatter and so the
 *  ID line Marfa wrote there, as an editor does. */
function rewrite(path: string, body: string): void {
  const text = readFileSync(path, "utf8");
  const end = text.indexOf("\n---\n", 4);
  expect(end, text).toBeGreaterThan(0);
  writeFileSync(path, `${text.slice(0, end + 5)}${body}\n`);
}

/** The writes the store holds that the server has not taken. */
function untaken(store: string): number {
  const db = new DatabaseSync(store, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM queue WHERE verdict IS NULL OR verdict NOT IN ('accepted', 'merged', 'conflicted')",
      )
      .get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

/** Gives the folder's store a column this build does not make, as a store
 *  another build of the core made. */
function misshape(folder: CliFolder): void {
  const db = new DatabaseSync(folder.store);
  try {
    db.exec("ALTER TABLE items ADD COLUMN stray TEXT");
  } finally {
    db.close();
  }
}

/** Every file in the folder outside `.marfa`, with its bytes. */
function filesOf(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (prefix === "" && entry.name === ".marfa") continue;
      const path = join(at, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path, name);
      else found[name] = readFileSync(path).toString("base64");
    }
  };
  walk(dir, "");
  return found;
}

/** The bytes of the folder's store file. */
function storeBytes(folder: CliFolder): string {
  return readFileSync(folder.store).toString("base64");
}

async function exited(command: HeldCommand): Promise<HeldCommand> {
  await command.exited();
  return command;
}

it("replaces a folder's store another build made that holds nothing unsent, and sends what was edited while it was refused", async () => {
  const at = machine("refused-store");
  const titles = {
    edited: `Edited ${ctx.runId}`,
    kept: `Kept ${ctx.runId}`,
    added: `Added ${ctx.runId}`,
  };
  const folder = await added(at, "notes", ownNotes(), {
    "Edited.md": note(titles.edited, "before"),
    "Kept.md": note(titles.kept, "left alone"),
  });
  value(await folder.push());
  expect(untaken(folder.store)).toBe(0);
  const before = await serverNotes();
  const kept = readFileSync(join(folder.dir, "Kept.md"));

  misshape(folder);
  // The witness: this build refuses the store, and `folders status`, which
  // only reads, goes on refusing it.
  const refused = await folder.status();
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.refusal.code, refused.refusal.raw).toBe("wrong_schema");
  expect(refused.refusal.raw).toContain("replaces it");

  rewrite(join(folder.dir, "Edited.md"), `after ${ctx.runId}`);
  writeFileSync(join(folder.dir, "Added.md"), note(titles.added, "new"));

  const push = await exited(folder.hold(["folders", "push", folder.dir]));
  expect(push.exitCode(), push.stderr).toBe(0);
  expect(push.stderr).toContain(REPLACED);
  expect(push.stderr).toContain(folder.dir);

  const edited = await serverNote(titles.edited);
  expect(JSON.stringify(edited?.properties)).toContain(`after ${ctx.runId}`);
  expect(await serverNote(titles.added)).toBeDefined();
  // Matched again, not sent again: the notes that were there are the same
  // items, and nothing was made twice.
  const after = await serverNotes();
  expect(after.map((row) => row.id).sort()).toEqual(
    [
      ...before.map((row) => row.id),
      (await serverNote(titles.added))!.id,
    ].sort(),
  );
  expect(Object.keys(filesOf(folder.dir)).sort()).toEqual(
    ["Added.md", "Edited.md", "Kept.md"].sort(),
  );
  expect(readFileSync(join(folder.dir, "Kept.md")).equals(kept)).toBe(true);
  expect(
    readdirSync(join(folder.dir, ".marfa")).filter((name) =>
      name.startsWith("core.sqlite.replacing"),
    ),
  ).toEqual([]);

  // The new store opens, and is never replaced again.
  value(await folder.status());
  const again = await exited(folder.hold(["folders", "push", folder.dir]));
  expect(again.exitCode(), again.stderr).toBe(0);
  expect(again.stderr).not.toContain(REPLACED);
});

it("leaves a folder's store another build made, and the folder's files, while it holds writes the server has not taken", async () => {
  const at = machine("refused-store-unsent");
  const title = `Unsent ${ctx.runId}`;
  const folder = await added(at, "notes", ownNotes(), {
    "Unsent.md": note(title, "sent"),
  });
  value(await folder.push());
  rewrite(join(folder.dir, "Unsent.md"), "not sent");
  writeFileSync(
    join(folder.dir, "Queued.md"),
    note(`Queued ${ctx.runId}`, "new"),
  );
  value(await folder.scan());
  const unsent = untaken(folder.store);
  expect(unsent).toBeGreaterThan(0);
  misshape(folder);
  const files = filesOf(folder.dir);
  const state = storeBytes(folder);

  for (const args of [
    ["folders", "push", folder.dir],
    ["folders", "pull", folder.dir],
    ["folders", "scan", folder.dir],
  ]) {
    const refused = await exited(folder.hold(args));
    expect(refused.exitCode(), refused.stderr).toBe(4);
    expect(refused.stderr).toContain("wrong_schema");
    expect(refused.stderr).toContain(
      `It holds ${unsent} ${unsent === 1 ? "write" : "writes"} the server has not taken`,
    );
    expect(refused.stderr).toContain("marfa folders push");
    expect(refused.stderr).not.toContain(REPLACED);
  }
  expect(filesOf(folder.dir)).toEqual(files);
  expect(storeBytes(folder)).toBe(state);
  expect(untaken(folder.store)).toBe(unsent);
  expect(await serverNote(`Queued ${ctx.runId}`)).toBeUndefined();
  expect(JSON.stringify((await serverNote(title))?.properties)).toContain(
    "sent",
  );
});

it("replaces a folder's refused store for a watch of the folder, and sends an edit", async () => {
  const at = machine("refused-store-watch");
  const title = `Watched ${ctx.runId}`;
  const folder = await added(at, "notes", ownNotes(), {
    "Watched.md": note(title, "before"),
  });
  value(await folder.push());
  misshape(folder);
  expect((await folder.status()).ok).toBe(false);

  const watch = folder.watch();
  held.push(watch);
  await vi.waitFor(() => expect(watch.stderr).toContain(REPLACED), WAIT);
  rewrite(join(folder.dir, "Watched.md"), `watched ${ctx.runId}`);
  await vi.waitFor(async () => {
    expect(JSON.stringify((await serverNote(title))?.properties)).toContain(
      `watched ${ctx.runId}`,
    );
  }, WAIT);
  expect(watch.running(), watch.stderr).toBe(true);
});

it("watches every folder: replaces a refused store that holds nothing unsent, and leaves one that does", async () => {
  const at = machine("refused-store-every");
  const title = `Every ${ctx.runId}`;
  const ready = await added(at, "ready", ownNotes(), {
    "Every.md": note(title, "before"),
  });
  value(await ready.push());
  const tag = `held-${ctx.runId}`;
  const holding = await added(
    at,
    "holding",
    { types: ["core.note"], filter: `tags contains "${tag}"` },
    { "Held.md": note(`Held ${ctx.runId}`, "never sent") },
    { tags: [tag] },
  );
  value(await holding.scan());
  const unsent = untaken(holding.store);
  expect(unsent).toBeGreaterThan(0);
  misshape(ready);
  misshape(holding);
  const holdingFiles = filesOf(holding.dir);
  const holdingState = storeBytes(holding);

  const watch = ready.watchEveryText();
  held.push(watch);
  await vi.waitFor(() => {
    expect(watch.stdout, watch.stderr).toContain(`${ready.dir}: watching`);
    expect(watch.stdout, watch.stderr).toContain(`${holding.dir}: not watched`);
  }, WAIT);
  expect(watch.stderr).toContain(REPLACED);
  const said = watch.stdout
    .split("\n")
    .find((line) => line.startsWith(`${holding.dir}: not watched`))!;
  expect(said).toContain(`${unsent} ${unsent === 1 ? "write" : "writes"}`);

  rewrite(join(ready.dir, "Every.md"), `every ${ctx.runId}`);
  await vi.waitFor(async () => {
    expect(JSON.stringify((await serverNote(title))?.properties)).toContain(
      `every ${ctx.runId}`,
    );
  }, WAIT);
  expect(filesOf(holding.dir)).toEqual(holdingFiles);
  expect(storeBytes(holding)).toBe(holdingState);
  expect(existsSync(join(holding.dir, ".marfa", "core.sqlite"))).toBe(true);
});

it("replaces a refused store a running watch hands to a push, and the watch takes the new store back and sends an edit", async () => {
  const at = machine("refused-store-handover");
  const title = `Handed ${ctx.runId}`;
  const folder = await added(at, "notes", ownNotes(), {
    "Handed.md": note(title, "before"),
  });
  value(await folder.push());
  const watch = folder.watch();
  held.push(watch);
  await vi.waitFor(() => expect(watch.stderr).toContain("watching"), WAIT);
  // Another build's store, under a watch that keeps it open, as a watch the
  // build that made the store started.
  misshape(folder);
  rewrite(join(folder.dir, "Handed.md"), `pushed ${ctx.runId}`);

  const push = await exited(folder.hold(["folders", "push", folder.dir]));
  expect(push.exitCode(), push.stderr).toBe(0);
  expect(push.stderr).toContain(REPLACED);
  expect(JSON.stringify((await serverNote(title))?.properties)).toContain(
    `pushed ${ctx.runId}`,
  );

  rewrite(join(folder.dir, "Handed.md"), `watched ${ctx.runId}`);
  await vi.waitFor(async () => {
    expect(JSON.stringify((await serverNote(title))?.properties)).toContain(
      `watched ${ctx.runId}`,
    );
  }, WAIT);
  expect(watch.running(), watch.stderr).toBe(true);
  expect(watch.stderr).not.toContain(REPLACED);
});

it("leaves a folder's store another build made whose unsent writes cannot be counted", async () => {
  const at = machine("refused-store-uncounted");
  const folder = await added(at, "notes", ownNotes(), {
    "Uncounted.md": note(`Uncounted ${ctx.runId}`, "sent"),
  });
  value(await folder.push());
  misshape(folder);
  const db = new DatabaseSync(folder.store);
  try {
    db.exec("ALTER TABLE queue RENAME COLUMN verdict TO answer_kind");
  } finally {
    db.close();
  }
  const files = filesOf(folder.dir);
  const state = storeBytes(folder);

  const refused = await exited(folder.hold(["folders", "push", folder.dir]));
  expect(refused.exitCode(), refused.stderr).toBe(4);
  expect(refused.stderr).toContain("wrong_schema");
  expect(refused.stderr).toContain("cannot be read");
  expect(refused.stderr).not.toContain(REPLACED);
  expect(filesOf(folder.dir)).toEqual(files);
  expect(storeBytes(folder)).toBe(state);
});

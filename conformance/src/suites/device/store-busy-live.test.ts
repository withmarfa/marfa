import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  CliDevice,
  CliFolder,
  newStore,
  type HeldCommand,
} from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackFolder,
  trackItem,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

// The gate places the competing commit after the transaction's first read.

const WAIT = { timeout: 30_000, interval: 50 };
/** More reaches of a gate than any bounded retry makes. */
const REACHES_MOST = 40;
const ALL = 1_000_000;
const BUSY_NOTICE = "another program kept writing to the folder's store";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
const bases: string[] = [];
const held: HeldCommand[] = [];

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "store-busy",
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

function scratch(label: string): string {
  const base = mkdtempSync(join(realpathSync(tmpdir()), `marfa-${label}-`));
  bases.push(base);
  return base;
}

/** A gate a debug build waits at, named by `fault` in `MARFA_TEST_FAULT`. */
class Gate {
  readonly path: string;

  constructor(
    base: string,
    readonly fault: string,
  ) {
    this.path = join(base, fault);
  }

  get env(): NodeJS.ProcessEnv {
    return { MARFA_TEST_FAULT: `${this.fault}=${this.path}` };
  }

  /** How many times the device has reached the gate. */
  reached(): number {
    try {
      return Number(readFileSync(`${this.path}.ready`, "utf8").trim()) || 0;
    } catch {
      return 0;
    }
  }

  /** Lets every reach up to `through` go on. */
  release(through: number): void {
    const next = `${this.path}.release.next`;
    writeFileSync(next, String(through));
    renameSync(next, `${this.path}.release`);
  }

  async contend(store: string, enough: () => boolean): Promise<number> {
    let reach = 0;
    while (!enough()) {
      expect(reach, "the device kept trying past any bound").toBeLessThan(
        REACHES_MOST,
      );
      await vi.waitFor(() => {
        expect(enough() || this.reached() > reach).toBe(true);
      }, WAIT);
      if (enough()) break;
      reach = this.reached();
      outsideWrite(store, reach);
      this.release(reach);
    }
    this.release(ALL);
    return reach;
  }
}

/** Another program's commit to the store, as a tool a person saves with. */
function outsideWrite(store: string, reach: number): void {
  const db = new DatabaseSync(store, { timeout: 10_000 });
  try {
    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('another-program', ?)",
    ).run(String(reach));
  } finally {
    db.close();
  }
}

function outsideValue(store: string): string | undefined {
  const db = new DatabaseSync(store, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'another-program'")
      .get() as { value: string } | undefined;
    return row?.value;
  } finally {
    db.close();
  }
}

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

async function serverNote(title: string): Promise<{
  id: string;
  version: number;
  properties: Record<string, unknown>;
}> {
  const listed = await client.listItems({
    type: "core.note",
    filter: `source eq "${ctx.source}"`,
    limit: 100,
  });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  for (const row of listed.data.data) trackItem(ctx, row.id);
  const found = listed.data.data.filter(
    (row) => row.properties.title === title,
  );
  expect(found.length, JSON.stringify(found)).toBe(1);
  return found[0];
}

async function serverCreate(title: string, body: string): Promise<string> {
  const created = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier: "library",
    properties: { title, body },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  trackItem(ctx, created.data.item.id);
  return created.data.item.id;
}

/** A hydrated working copy of this run's notes. */
async function hydratedDevice(label: string): Promise<CliDevice> {
  const store = newStore(label);
  bases.push(dirname(store));
  const device = new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: apiKey,
  });
  value(await device.hydrate(["core.note"], "library"));
  return device;
}

/** A folder of this run's notes, hydrated, holding one pushed note. */
async function pushedFolder(label: string, title: string): Promise<CliFolder> {
  const base = scratch(label);
  const dir = join(base, "notes");
  mkdirSync(dir);
  const folder = new CliFolder(dir, {
    binary: requireBinary(),
    url: apiUrl,
    key: apiKey,
    registry: join(base, "folders.json"),
  });
  const settings = await client.createFolder({
    title: `Store busy ${label} ${ctx.runId}`,
    query: { types: ["core.note"], filter: `source eq "${ctx.source}"` },
  });
  expect(settings.ok, JSON.stringify(settings.error)).toBe(true);
  trackFolder(ctx, settings.data.item.id);
  value(await folder.add(settings.data.item.id));
  value(await folder.hydrate());
  writeFileSync(join(dir, "Note.md"), `---\ntitle: ${title}\n---\nbefore\n`);
  value(await folder.push());
  return folder;
}

/** Gives the note at `path` a new body, keeping its frontmatter. */
function rewrite(path: string, body: string): void {
  const text = readFileSync(path, "utf8");
  const end = text.indexOf("\n---\n", 4);
  expect(end, text).toBeGreaterThan(0);
  writeFileSync(path, `${text.slice(0, end + 5)}${body}\n`);
}

it("makes a held stream's write again from fresh reads when another program wrote to the store after it read, and goes on following", async () => {
  const device = await hydratedDevice("busy-once");
  const gate = new Gate(dirname(device.store), "gate-catalog-adopt");
  const following = device.hold(["follow"], "device", gate.env);
  held.push(following);
  await vi.waitFor(() => expect(gate.reached()).toBe(1), WAIT);
  outsideWrite(device.store, 1);
  gate.release(ALL);
  // The write is made again from its first read, which reaches the gate.
  await vi.waitFor(
    () => expect(gate.reached()).toBeGreaterThanOrEqual(2),
    WAIT,
  );

  const id = await serverCreate(`Followed ${ctx.runId}`, "after the write");
  await vi.waitFor(() => expect(following.stdout).toContain(id), WAIT);
  expect(following.running(), following.stderr).toBe(true);
  expect(following.stderr).not.toContain("store_busy");
  expect(outsideValue(device.store)).toBe("1");
});

it("ends a held stream store_busy when another program writes to the store at every attempt", async () => {
  const device = await hydratedDevice("busy-always");
  const gate = new Gate(dirname(device.store), "gate-catalog-adopt");
  const following = device.hold(["follow"], "device", gate.env);
  held.push(following);
  const reaches = await gate.contend(device.store, () => !following.running());
  await following.exited();
  expect(reaches).toBeGreaterThan(1);
  expect(following.exitCode(), following.stderr).toBe(3);
  expect(JSON.parse(following.stderr).error.code).toBe("store_busy");
  expect(outsideValue(device.store)).toBe(String(reaches));
});

it("says once that another program kept the watch's follow from writing to the folder's store, goes on watching and takes the server's next change", async () => {
  const title = `Watched follow ${ctx.runId}`;
  const folder = await pushedFolder("busy-follow", title);
  const gate = new Gate(dirname(folder.dir), "gate-catalog-adopt");
  const watch = folder.hold(["folders", "watch", folder.dir], gate.env);
  held.push(watch);
  await gate.contend(folder.store, () => watch.stderr.includes(BUSY_NOTICE));
  expect(watch.running(), watch.stderr).toBe(true);

  const note = await serverNote(title);
  const changed = await client.updateItem(note.id, {
    version: note.version,
    properties: { body: `from the server ${ctx.runId}` },
  });
  expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
  await vi.waitFor(() => {
    expect(readFileSync(join(folder.dir, "Note.md"), "utf8")).toContain(
      `from the server ${ctx.runId}`,
    );
  }, WAIT);
  expect(watch.running(), watch.stderr).toBe(true);
  expect(count(watch.stderr, BUSY_NOTICE), watch.stderr).toBe(1);
});

it("says once that another program kept a watch's pass from writing to the folder's store, goes on watching and sends the edit", async () => {
  const title = `Watched pass ${ctx.runId}`;
  const folder = await pushedFolder("busy-pass", title);
  const gate = new Gate(dirname(folder.dir), "gate-local-update");
  const watch = folder.hold(["folders", "watch", folder.dir], gate.env);
  held.push(watch);
  rewrite(join(folder.dir, "Note.md"), `edited ${ctx.runId}`);
  await gate.contend(folder.store, () => watch.stderr.includes(BUSY_NOTICE));
  expect(watch.running(), watch.stderr).toBe(true);

  await vi.waitFor(async () => {
    expect((await serverNote(title)).properties.body).toContain(
      `edited ${ctx.runId}`,
    );
  }, WAIT);
  expect(watch.running(), watch.stderr).toBe(true);
  expect(count(watch.stderr, BUSY_NOTICE), watch.stderr).toBe(1);
});

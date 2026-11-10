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
  withoutWriteLine,
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

  /** When each reach was let go, by reach. */
  readonly releasedAt = new Map<number, number>();
  /** When `contend` saw each reach, by reach. */
  readonly seenAt = new Map<number, number>();

  /** Lets every reach up to `through` go on. */
  release(through: number): void {
    this.releasedAt.set(through, Date.now());
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
      this.seenAt.set(reach, Date.now());
      if (enough()) break;
      outsideWrite(store, reach);
      this.release(reach);
    }
    this.release(ALL);
    return reach;
  }

  /**
   * The waits of a second or more between letting a reach go and seeing the
   * next: each one a new attempt after the attempts before it ran out.
   */
  restarts(): number[] {
    const waits: number[] = [];
    for (const [reach, seen] of this.seenAt) {
      const released = this.releasedAt.get(reach - 1);
      if (released !== undefined && seen - released >= 1_000) {
        waits.push(seen - released);
      }
    }
    return waits;
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
  // Two follows refused at each of their attempts, and a third let through.
  await gate.contend(folder.store, () => gate.restarts().length >= 2);
  expect(watch.running(), watch.stderr).toBe(true);
  const [first, second] = gate.restarts();
  expect(
    second,
    `waits ${String(first)} then ${String(second)}`,
  ).toBeGreaterThanOrEqual(2_000);

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

/** A device holding one note it made and has not sent. */
async function queuedNote(
  label: string,
  title: string,
): Promise<{ device: CliDevice; write: string }> {
  const device = await hydratedDevice(label);
  const queued = value(
    await device.create({
      type: "core.note",
      source: ctx.source,
      properties: { title, body: "made on the device" },
    }),
  );
  return { device, write: queued.id };
}

async function queued(device: CliDevice, write: string) {
  const row = value(await device.queue()).find((entry) => entry.id === write);
  expect(row, "the write left the queue").toBeDefined();
  return row;
}

it("records the server's answer to a write again when another program wrote to the store as the device recorded it", async () => {
  const title = `Recorded ${ctx.runId}`;
  const { device, write } = await queuedNote("busy-receipt", title);
  const gate = new Gate(dirname(device.store), "gate-drain-receipt");
  const draining = device.hold(["drain"], "device", gate.env);
  held.push(draining);
  await vi.waitFor(() => expect(gate.reached()).toBe(1), WAIT);
  outsideWrite(device.store, 1);
  gate.release(ALL);
  await draining.exited();
  expect(draining.exitCode(), draining.stderr).toBe(0);
  // The record is made again from its first read, which reaches the gate.
  expect(gate.reached()).toBeGreaterThanOrEqual(2);
  const report = JSON.parse(draining.stdout) as {
    verdicts: Array<{ id: string; verdict: string | null; refusals: number }>;
  };
  expect(
    report.verdicts.map((entry) => [entry.id, entry.verdict, entry.refusals]),
  ).toEqual([[write, "accepted", 0]]);
  const row = await queued(device, write);
  expect([row?.verdict, row?.refusals]).toEqual(["accepted", 0]);
  await serverNote(title);
  expect(outsideValue(device.store)).toBe("1");
});

it("ends the drain store_busy when another program writes to the store at every attempt to record an answer, counting nothing, and accepts the write on the next drain", async () => {
  const title = `Unrecorded ${ctx.runId}`;
  const { device, write } = await queuedNote("busy-receipt-always", title);
  const gate = new Gate(dirname(device.store), "gate-drain-receipt");
  const draining = device.hold(["drain"], "device", gate.env);
  held.push(draining);
  const reaches = await gate.contend(device.store, () => !draining.running());
  await draining.exited();
  expect(reaches).toBeGreaterThan(1);
  expect(draining.exitCode(), draining.stderr).toBe(3);
  expect(JSON.parse(withoutWriteLine(draining.stderr)).error.code).toBe(
    "store_busy",
  );
  const row = await queued(device, write);
  expect(
    [row?.verdict, row?.refusals],
    "contention spent the write's count, or gave it a verdict",
  ).toEqual([null, 0]);
  // The server took the write the first time; the next drain sends it again
  // under its key and is answered with that write.
  await serverNote(title);
  const again = value(await device.drain());
  expect(again.verdicts.map((entry) => entry.verdict)).toEqual(["accepted"]);
  await serverNote(title);
  expect(outsideValue(device.store)).toBe(String(reaches));
});

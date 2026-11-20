import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliFolder } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackFolder,
  trackItem,
} from "../../utils/setup.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { requireBinary } from "./harness.js";

/**
 * A folder whose query narrows beneath a project that is a file of the folder
 * (`folder-setup/beneath-file-one-pass`), against the real server and the
 * real binary.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
const bases: string[] = [];

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "folders-beneath-file",
  ));
});
afterEach(() => {
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

/** A directory for a machine's folders, and the registry it keeps. */
function machine(): { base: string; registry: string } {
  const base = tempFolder("marfa-beneath-file-");
  bases.push(base);
  return { base, registry: join(base, "folders.json") };
}

function folderAt(
  at: { base: string; registry: string },
  name: string,
  files: Record<string, string> = {},
): CliFolder {
  const dir = join(at.base, name);
  mkdirSync(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return new CliFolder(dir, {
    binary: requireBinary(),
    url: apiUrl,
    key: apiKey,
    registry: at.registry,
  });
}

/** The query of a folder of this run's notes, beneath `beneath` where named. */
function query(beneath?: string): Record<string, unknown> {
  return {
    types: ["core.note"],
    filter: `source eq "${ctx.source}"`,
    ...(beneath === undefined ? {} : { beneath }),
  };
}

async function serverFolder(beneath?: string): Promise<string> {
  const made = await client.createFolder({
    title: `Beneath a file ${ctx.runId} ${bases.length}`,
    query: query(beneath),
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackFolder(ctx, made.data.item.id);
  return made.data.item.id;
}

async function serverNote(title: string): Promise<string> {
  const made = await client.createItem({
    type: "core.note",
    properties: { title, body: `${title}\n` },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

async function beneathOf(parent: string, child: string): Promise<void> {
  const made = await client.createEdge({
    from_id: parent,
    to_id: child,
    edge_type: "parent-of",
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
}

/** What the folder's query names for `beneath` on the server. */
async function namedBeneath(folder: string): Promise<unknown> {
  const read = await client.getItem(folder);
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  return (read.data.item.properties.query as Record<string, unknown>).beneath;
}

/** The text of every file of the folder outside `.marfa`, by path. */
function filesOf(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (prefix === "" && entry.name === ".marfa") continue;
      const path = join(at, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path, name);
      else found[name] = readFileSync(path, "utf8");
    }
  };
  walk(dir, "");
  return found;
}

const project = (title: string, id?: string): string =>
  `---\n${id === undefined ? "" : `marfa_id: ${id}\n`}title: ${title}\n---\n${title}\n`;

it("sets up a folder beneath a project its own file names in one pass, and writes nothing from outside the project", async () => {
  const stamp = ctx.runId;
  const root = await serverNote(`Project ${stamp}`);
  const first = await serverNote(`Inside one ${stamp}`);
  const second = await serverNote(`Inside two ${stamp}`);
  await serverNote(`Outside ${stamp}`);
  await beneathOf(root, first);
  await beneathOf(root, second);
  const at = machine();

  // The witness: the same folder with no narrowing writes the outside note.
  const control = folderAt(machine(), "control");
  value(await control.add(await serverFolder()));
  value(await control.push());
  expect(Object.values(filesOf(control.dir)).join("\n")).toContain(
    `Outside ${stamp}`,
  );

  const folder = folderAt(at, "beneath", {
    "Projects/project.md": project(`Project ${stamp}`, root),
  });
  const id = await serverFolder("Projects/project.md");
  value(await folder.add(id));
  value(await folder.push());

  expect(await namedBeneath(id)).toBe(root);
  const written = Object.values(filesOf(folder.dir)).join("\n");
  for (const title of [
    `Project ${stamp}`,
    `Inside one ${stamp}`,
    `Inside two ${stamp}`,
  ]) {
    expect(written, title).toContain(title);
  }
  expect(written).not.toContain(`Outside ${stamp}`);

  // A second machine that adds the folder once it names the project's id
  // has no file to name and holds the same items.
  const other = folderAt(machine(), "other");
  value(await other.add(id));
  value(await other.push());
  const there = Object.values(filesOf(other.dir)).join("\n");
  expect(there).toContain(`Inside two ${stamp}`);
  expect(there).not.toContain(`Outside ${stamp}`);
});

it("sends a project file that has no item yet and names its item, holding nothing from outside until then", async () => {
  const stamp = ctx.runId;
  await serverNote(`Elsewhere ${stamp}`);
  const folder = folderAt(machine(), "fresh", {
    "Projects/fresh.md": project(`Fresh ${stamp}`),
  });
  const id = await serverFolder("Projects/fresh.md");
  value(await folder.add(id));
  value(await folder.push());

  const named = await namedBeneath(id);
  expect(named).toMatch(/^[0-9a-f-]{36}$/);
  const idLine = /^marfa_id: (\S+)$/m.exec(
    readFileSync(join(folder.dir, "Projects/fresh.md"), "utf8"),
  );
  expect(named).toBe(idLine?.[1]);
  expect(Object.values(filesOf(folder.dir)).join("\n")).not.toContain(
    `Elsewhere ${stamp}`,
  );

  // Something made beneath the project afterwards comes in at the next push.
  const child = await serverNote(`Later ${stamp}`);
  await beneathOf(named as string, child);
  value(await folder.push());
  expect(Object.values(filesOf(folder.dir)).join("\n")).toContain(
    `Later ${stamp}`,
  );
});

it("refuses to set up a folder beneath a file that is not there, naming it, and changes nothing", async () => {
  const stamp = ctx.runId;
  await serverNote(`Anywhere ${stamp}`);
  const folder = folderAt(machine(), "missing");
  const id = await serverFolder("Projects/missing.md");
  value(await folder.add(id));
  const pushed = await folder.push();
  expect(pushed.ok, JSON.stringify(pushed)).toBe(false);
  if (!pushed.ok) expect(pushed.refusal.raw).toContain("Projects/missing.md");
  expect(await namedBeneath(id)).toBe("Projects/missing.md");
  expect(filesOf(folder.dir)).toEqual({});
  expect(existsSync(join(folder.dir, "Projects"))).toBe(false);
});

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
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
 * A file's form, the keys of its frontmatter in order, which are empty and
 * each value's style, travels on its placement, so a directory that never had
 * the file writes it as the directory that made it did
 * (`folder-files/form-written`), against the real server and the real binary.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
const bases: string[] = [];
const closers: (() => void)[] = [];
const folders: string[] = [];
let named = 0;

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "folders-form",
  ));
});
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const base of bases.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});
afterAll(async () => {
  // The directories made these items, so the context tracked none of them.
  for (const folder of folders) {
    const edges = await client.listItemBackrefs(folder, {
      edge_type: "in-folder",
      limit: 200,
    });
    if (edges.ok)
      for (const edge of edges.data.data) trackItem(ctx, edge.from_id);
  }
  if (ctx) await cleanup(ctx);
});

function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

/** A directory of its own for one folder, and the registry it keeps. */
function directory(
  files: Record<string, string> = {},
  url: string = apiUrl,
): CliFolder {
  const base = tempFolder("marfa-form-");
  bases.push(base);
  const dir = join(base, "folder");
  mkdirSync(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return new CliFolder(dir, {
    binary: requireBinary(),
    url,
    key: apiKey,
    registry: join(base, "folders.json"),
  });
}

async function serverFolder(): Promise<string> {
  const made = await client.createFolder({
    title: `Forms ${ctx.runId} ${folders.length}`,
    query: { types: ["core.note"], filter: `source eq "${ctx.source}"` },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackFolder(ctx, made.data.item.id);
  folders.push(made.data.item.id);
  return made.data.item.id;
}

/** A directory of `folder` that took in `files` and sent them. */
async function made(
  folder: string,
  files: Record<string, string>,
): Promise<CliFolder> {
  const first = directory(files);
  value(await first.add(folder));
  value(await first.push());
  value(await first.push());
  return first;
}

/** A directory of `folder` that never had its files, filled by a pull. */
async function followed(folder: string, url?: string): Promise<CliFolder> {
  const next = directory({}, url);
  value(await next.add(folder));
  value(await next.push());
  return next;
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

interface Placement {
  id: string;
  from_id: string;
  version: number;
  properties: Record<string, unknown>;
}

/** The placement in `folder` whose path is `path`, as the server holds it. */
async function placed(folder: string, path: string): Promise<Placement> {
  const edges = await client.listItemBackrefs(folder, {
    edge_type: "in-folder",
    limit: 200,
  });
  expect(edges.ok, JSON.stringify(edges.error)).toBe(true);
  const edge = edges.data.data.find((held) => held.properties?.path === path);
  expect(edge, `${folder} places nothing at ${path}`).toBeDefined();
  return edge as unknown as Placement;
}

/** The style the form gives `key`, or undefined where it names none. */
function styleOf(form: unknown, key: string): unknown {
  const keys = (form as { keys?: { key: string; style: string }[] }).keys;
  return keys?.find((held) => held.key === key)?.style;
}

/**
 * A title no other test's item holds: every folder here shows every note of
 * this file's source, and a link must name one item.
 */
function title(base: string): string {
  named += 1;
  return `${base} ${ctx.runId} ${named}`;
}

/** A decision with no line naming another item. */
const plain = (title: string): string =>
  `---\ntitle: ${title}\noccurred_at: 2026-10-11\n---\nWhy it was decided.\n`;

/** A project, a decision and a session that name each other, by file. */
function linked(): {
  top: string;
  decision: string;
  session: string;
  files: Record<string, string>;
} {
  const top = title("Top");
  const decision = title("A decision");
  const session = title("A session");
  return {
    top: `${top}.md`,
    decision: `${decision}.md`,
    session: `${session}.md`,
    files: {
      [`${top}.md`]: `---\ntitle: ${top}\n---\nThe top project.\n`,
      [`${decision}.md`]: `---\ntitle: ${decision}\noccurred_at: 2026-10-11\nchild-of: "[[${top}]]"\nabout: ["[[${top}]]", "[[${session}]]"]\n---\nWhy it was decided.\n`,
      [`${session}.md`]: `---\ntitle: ${session}\nlanguage: "en"\nstarts_at:\nends_at:\nchild-of: "[[${top}]]"\nabout: ["[[${top}]]"]\ntier: library\n---\n## Brief\n\nDo the thing.\n`,
    },
  };
}

it("writes each file new to a second directory as the directory that made it wrote it", async () => {
  const folder = await serverFolder();

  // The witness: a note made elsewhere at midnight, whose placement holds no
  // form, is written with its full time.
  const elsewhere = await client.createItem({
    type: "core.note",
    tier: "library",
    occurred_at: "2026-10-11T00:00:00Z",
    properties: { title: `Elsewhere ${ctx.runId}`, body: "Made elsewhere.\n" },
  });
  expect(elsewhere.ok, JSON.stringify(elsewhere.error)).toBe(true);
  trackItem(ctx, elsewhere.data.item.id);

  const notes = linked();
  const first = await made(folder, notes.files);
  const second = await followed(folder);

  const there = filesOf(second.dir);
  expect(there[`Elsewhere ${ctx.runId}.md`]).toContain(
    'occurred_at: "2026-10-11T00:00:00.000Z"\n',
  );
  const here = filesOf(first.dir);
  for (const [name, text] of Object.entries(notes.files)) {
    expect(here[name], name).toContain(text.split("\n---\n")[0]);
    expect(here[name], name).toMatch(/\nmarfa_id: /);
    expect(there[name], name).toBe(here[name]);
  }
  expect(there[notes.session]).toContain("\nstarts_at:\nends_at:\n");
});

it("sends a file's form on its placement, holding each key's style and no value or comment", async () => {
  const folder = await serverFolder();
  const styles = title("Styles");
  const text = `---\n# Kept for the team.\ntitle: ${styles}\nlanguage: 'en'\nnotes: |\n  First line.\n  Second line.\nstarts_at:\noccurred_at: 2026-10-11\n---\nThe body.\n`;
  await made(folder, { [`${styles}.md`]: text });
  const edge = await placed(folder, `${styles}.md`);
  const form = edge.properties.form;
  expect(form).toBeDefined();
  expect(
    (form as { keys: { key: string }[] }).keys.map((held) => held.key),
  ).toEqual(["title", "language", "notes", "starts_at", "occurred_at"]);
  expect(styleOf(form, "language")).toBe("single");
  expect(styleOf(form, "notes")).toBe("literal");
  expect(styleOf(form, "starts_at")).toBe("empty");
  expect(styleOf(form, "occurred_at")).toBe("day");
  const sent = JSON.stringify(form);
  for (const held of [styles, "en", "First line", "2026-10-11", "Kept for"]) {
    expect(sent, held).not.toContain(held);
  }
});

it("leaves a key whose change was refused out of a file's form", async () => {
  const folder = await serverFolder();
  const name = title("Refused");
  const path = `${name}.md`;
  const first = await made(folder, { [path]: plain(name) });
  const file = join(first.dir, path);
  const refusedLine = "notes: 12\n";
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      `title: ${name}\n`,
      `title: ${name}\n${refusedLine}`,
    ),
  );
  await first.push();
  await first.push();
  const item = (await placed(folder, path)).from_id;
  const held = await client.getItem(item);
  expect(held.ok, JSON.stringify(held.error)).toBe(true);
  expect(held.data.item.properties).not.toHaveProperty("notes");
  const refused = await placed(folder, path);
  expect(styleOf(refused.properties.form, "title")).toBe("plain");
  expect(styleOf(refused.properties.form, "notes")).toBeUndefined();
  expect(JSON.stringify(refused.properties)).not.toContain("notes");

  // The witness: once the key holds a value the server takes, the form
  // names it.
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(refusedLine, "notes: 'Taken.'\n"),
  );
  value(await first.push());
  value(await first.push());
  const taken = await placed(folder, path);
  expect(styleOf(taken.properties.form, "notes")).toBe("single");
});

it("writes a day only for a time that is midnight in UTC, and the full time otherwise", async () => {
  const folder = await serverFolder();
  const dated = title("Dated");
  await made(folder, { [`${dated}.md`]: plain(dated) });
  const item = (await placed(folder, `${dated}.md`)).from_id;
  const at = await followed(folder);
  expect(filesOf(at.dir)[`${dated}.md`]).toContain("occurred_at: 2026-10-11\n");

  const read = await client.getItem(item);
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  const moved = await client.updateItem(item, {
    version: read.data.item.version,
    occurred_at: "2026-10-11T09:30:00Z",
  });
  expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
  const later = await followed(folder);
  const written = filesOf(later.dir)[`${dated}.md`] ?? "";
  expect(written).toContain('occurred_at: "2026-10-11T09:30:00.000Z"\n');
  expect(written).not.toContain("occurred_at: 2026-10-11\n");
});

it("sends a changed form from the directory where the file changed, and rewrites no file elsewhere for it", async () => {
  const folder = await serverFolder();
  const notes = linked();
  const first = await made(folder, notes.files);
  const second = await followed(folder);
  const before = filesOf(second.dir);
  const was = await placed(folder, notes.decision);
  expect(styleOf(was.properties.form, "about")).toBe("flow");

  const path = join(first.dir, notes.decision);
  const top = notes.top.replace(/\.md$/, "");
  const session = notes.session.replace(/\.md$/, "");
  const flow = `about: ["[[${top}]]", "[[${session}]]"]\n`;
  const text = readFileSync(path, "utf8");
  expect(text).toContain(flow);
  writeFileSync(
    path,
    text.replace(flow, `about:\n  - "[[${top}]]"\n  - "[[${session}]]"\n`),
  );
  value(await first.push());
  const now = await placed(folder, notes.decision);
  expect(now.id).toBe(was.id);
  expect(styleOf(now.properties.form, "about")).toBe("block");

  value(await second.push());
  expect(filesOf(second.dir)).toEqual(before);

  // The witness: a directory that never had the file writes the new form.
  const third = await followed(folder);
  expect(filesOf(third.dir)[notes.decision]).toBe(
    filesOf(first.dir)[notes.decision],
  );
  expect(filesOf(third.dir)[notes.decision]).not.toBe(before[notes.decision]);
});

it("fills the form of a placement that holds none once, from a directory where a person wrote the file", async () => {
  const folder = await serverFolder();
  // A note made elsewhere, which a directory writes as it writes any item it
  // never had, fills no form.
  const elsewhere = title("Elsewhere");
  const note = await client.createItem({
    type: "core.note",
    tier: "library",
    properties: { title: elsewhere, body: "No form yet.\n" },
  });
  expect(note.ok, JSON.stringify(note.error)).toBe(true);
  trackItem(ctx, note.data.item.id);
  const at = await followed(folder);
  value(await at.push());
  value(await at.push());
  expect(filesOf(at.dir)[`${elsewhere}.md`]).toBeDefined();
  expect((await placed(folder, `${elsewhere}.md`)).properties).toEqual({
    path: `${elsewhere}.md`,
  });

  // The witness: a file a person wrote, placed through a server that took no
  // form, fills its form once the server takes one.
  const name = title("Unformed");
  const path = `${name}.md`;
  const base = tempFolder("marfa-form-");
  bases.push(base);
  const dir = join(base, "folder");
  mkdirSync(dir);
  writeFileSync(join(dir, path), plain(name));
  const options = {
    binary: requireBinary(),
    key: apiKey,
    registry: join(base, "folders.json"),
  };
  const older = new CliFolder(dir, { ...options, url: await withoutForm() });
  value(await older.add(folder));
  value(await older.push());
  value(await older.push());
  expect((await placed(folder, path)).properties).toEqual({ path });

  // The first push reads the server's edge types again, and the next fills.
  const now = new CliFolder(dir, { ...options, url: apiUrl });
  value(await now.push());
  value(await now.push());
  const filled = await placed(folder, path);
  expect(styleOf(filled.properties.form, "occurred_at")).toBe("day");
  value(await now.push());
  value(await now.push());
  expect((await placed(folder, path)).version).toBe(filled.version);
});

/**
 * A proxy in front of the server whose `in-folder` edge type declares no
 * `form`, as a server from before it did.
 */
async function withoutForm(): Promise<string> {
  const proxy: Server = createServer(async (request, response) => {
    try {
      const bytes: Buffer[] = [];
      for await (const chunk of request) bytes.push(Buffer.from(chunk));
      const body = Buffer.concat(bytes);
      const headers = new Headers();
      for (const [name, header] of Object.entries(request.headers)) {
        if (
          header !== undefined &&
          ![
            "host",
            "connection",
            "transfer-encoding",
            "content-length",
          ].includes(name)
        )
          headers.set(name, Array.isArray(header) ? header.join(", ") : header);
      }
      const upstream = await fetch(
        `${apiUrl.replace(/\/$/, "")}${request.url}`,
        {
          method: request.method,
          headers,
          ...(body.length ? { body } : {}),
        },
      );
      const returned = Object.fromEntries(upstream.headers);
      delete returned["content-length"];
      delete returned["content-encoding"];
      response.writeHead(upstream.status, returned);
      if (request.url?.split("?")[0] !== "/edge-types" || !upstream.ok) {
        // Event streams stay open, so everything but the edge types is
        // passed on as it arrives.
        if (upstream.body) {
          for await (const chunk of upstream.body) response.write(chunk);
        }
        response.end();
        return;
      }
      const page = (await upstream.json()) as {
        data: { id: string; property_schema?: Record<string, unknown> }[];
      };
      for (const type of page.data) {
        if (type.id === "in-folder") delete type.property_schema?.form;
      }
      response.end(JSON.stringify(page));
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    proxy.closeAllConnections();
    proxy.close();
  });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("no proxy port");
  return `http://127.0.0.1:${address.port}`;
}

it("sends no form to a server whose in-folder edge type declares none", async () => {
  const folder = await serverFolder();
  // The witness: through the server itself, the same file's placement
  // carries a form.
  const direct = `${title("Direct")}.md`;
  await made(folder, { [direct]: plain(direct.replace(/\.md$/, "")) });
  const formed = await placed(folder, direct);
  expect(formed.properties.form).toBeDefined();

  const url = await withoutForm();
  const older = `${title("Older")}.md`;
  const at = directory({ [older]: plain(older.replace(/\.md$/, "")) }, url);
  value(await at.add(folder));
  value(await at.push());
  value(await at.push());
  const edge = await placed(folder, older);
  expect(edge.properties).toEqual({ path: older });
});

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { Cli, requireBinary } from "./harness.js";

/**
 * A file within a body field's length that encodes past what the real server
 * takes in one request. The server closes the connection on such a body with
 * the rest unread, so whether a client hears its `413` depends on timing. The
 * root names the limit, so a device holds the file itself, and only a real
 * server shows that nothing past the limit is ever sent.
 */

const DEFAULT_LIMIT = 1_048_576;

let server: FreshServer | undefined;
let cli: Cli;
let client: MarfaClient;
const dir = mkdtempSync(join(realpathSync(tmpdir()), "marfa-request-size-"));

beforeAll(async () => {
  server = await bootFreshServer("cli-request-size");
  cli = new Cli(requireBinary(), server.apiUrl, server.workingKey).withEnv({
    MARFA_FOLDER_REGISTRY: join(dir, "folders.json"),
  });
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
}, FRESH_SERVER_TIMEOUT_MS);

type Report = {
  drain: {
    undelivered: number;
    verdicts: { kind: string; verdict: string | null }[];
  };
};

/** A folder of its own: each case's notes share the server, not a query. */
async function folderNamed(name: string): Promise<string> {
  const type = `user.size_${name}`;
  const declared = await client.registerType({
    id: type,
    version: 1,
    parent: "core.note",
    fields: {},
  } as Parameters<MarfaClient["registerType"]>[0]);
  expect(declared.status, JSON.stringify(declared.error)).toBe(201);
  const { item } = await cli.json<{ item: { id: string } }>([
    "folders",
    "create",
    "--title",
    `Request size ${name}`,
    "--query",
    JSON.stringify({ types: [type] }),
    "--defaults",
    JSON.stringify({ type }),
  ]);
  const files = join(dir, name);
  mkdirSync(files);
  await cli.json(["folders", "add", "--folder", item.id, "--yes", files]);
  return files;
}

const note = (title: string, body: string) =>
  `---\ntitle: ${title}\n---\n${body}\n`;

/** The file with `body` under the front matter a pull wrote, which it keeps. */
function edit(path: string, body: string): void {
  const text = readFileSync(path, "utf8");
  writeFileSync(path, text.slice(0, text.indexOf("\n---\n", 4) + 5) + body);
}

async function push(files: string): Promise<Report> {
  const pushed = await cli.run(["--json", "folders", "push", files]);
  expect(pushed.code, pushed.stderr).toBe(0);
  return JSON.parse(pushed.stdout) as Report;
}

async function titlesOf(files: string): Promise<string[]> {
  const type = `user.size_${files.slice(files.lastIndexOf("/") + 1)}`;
  const listed = await client.listItems({ type, limit: 100 });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  return listed.ok
    ? listed.data.data.map((row) => String(row.properties.title)).sort()
    : [];
}

it(
  "holds a file past the limit, sends none of it and delivers what is beside it",
  async () => {
    const files = await folderNamed("held");
    // Each encodes past 1 MiB: two bytes a character, a quote's two for its
    // escape, and one just past the limit.
    const large = new Map([
      ["Large accents", "\u00e9".repeat(999_990)],
      ["Large quotes", '"'.repeat(999_990)],
      ["Large just past", "\u00e9".repeat(530_000)],
    ]);
    for (const [title, body] of large)
      writeFileSync(join(files, `${title}.md`), note(title, body));
    const small = ["First", "Second", "Earlier"].map((name) => `A ${name}`);
    for (const title of small)
      writeFileSync(join(files, `${title}.md`), note(title, "A small file."));

    for (let pushes = 0; pushes < 3; pushes += 1) {
      const { drain } = await push(files);
      expect(drain.undelivered).toBe(0);
      expect(await titlesOf(files)).toEqual([...small].sort());
    }

    const said = await cli.run(["folders", "push", files]);
    expect(said.code, said.stderr).toBe(0);
    const status = await cli.run(["folders", "status", files]);
    for (const told of [said.stdout, status.stdout]) {
      expect(told).toContain("Large accents.md");
      expect(told).toContain("bytes as a request");
      expect(told).toContain(
        `this server takes ${DEFAULT_LIMIT.toLocaleString("en-US")}`,
      );
      expect(told).not.toContain("request_too_large");
    }
    for (const [title, body] of large)
      expect(readFileSync(join(files, `${title}.md`), "utf8")).toBe(
        note(title, body),
      );
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "sends a file at the limit and holds one a byte past it",
  async () => {
    const files = await folderNamed("boundary");
    // Two bytes each for the bulk, within the field's length, and one byte
    // each after it, so the size can land on any number.
    const write = (ones: number) =>
      writeFileSync(
        join(files, "Edge.md"),
        note("Edge", "\u00e9".repeat(520_000) + "x".repeat(ones)),
      );
    const past = 20_000;
    write(past);
    await push(files);
    const said = await cli.run(["folders", "status", files]);
    const size = Number(
      /is ([\d,]+) bytes as a request/
        .exec(said.stdout)?.[1]
        ?.replaceAll(",", ""),
    );
    const at = past - (size - DEFAULT_LIMIT);

    write(at + 1);
    await push(files);
    expect(await titlesOf(files)).toEqual([]);

    write(at);
    await push(files);
    expect(await titlesOf(files)).toEqual(["Edge"]);
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "sends a held file once it fits, whether it was a create or an edit",
  async () => {
    const files = await folderNamed("shrunk");
    const tooLong = "\u00e9".repeat(999_990);
    const created = join(files, "Created.md");
    const edited = join(files, "Edited.md");
    writeFileSync(created, note("Created", tooLong));
    writeFileSync(edited, note("Edited", "A small file."));
    await push(files);
    expect(await titlesOf(files)).toEqual(["Edited"]);

    edit(edited, tooLong);
    await push(files);

    writeFileSync(created, note("Created", "Shorter now."));
    edit(edited, "Shorter now.");
    await push(files);

    const type = "user.size_shrunk";
    const listed = await client.listItems({ type, limit: 100 });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    if (!listed.ok) return;
    expect(
      listed.data.data
        .map((row) => [row.properties.title, row.properties.body])
        .sort(),
    ).toEqual([
      ["Created", "Shorter now.\n"],
      ["Edited", "Shorter now."],
    ]);
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "keeps an edit made elsewhere while an edit of the file was held",
  async () => {
    const files = await folderNamed("elsewhere");
    const path = join(files, "Shared.md");
    writeFileSync(path, note("Shared", "A small file."));
    await push(files);
    await push(files);
    const type = "user.size_elsewhere";
    const listed = await client.listItems({ type, limit: 10 });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    if (!listed.ok) return;
    const row = listed.data.data[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    edit(path, "\u00e9".repeat(999_990));
    await push(files);

    const moved = await fetch(`${server?.apiUrl}/items/${row.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${server?.workingKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        properties: { body: "Written elsewhere." },
        version: row.version,
      }),
    });
    expect(moved.status).toBe(200);
    await push(files);

    edit(path, "Shorter here.");
    const { drain } = await push(files);
    expect(
      drain.verdicts.find((entry) => entry.kind === "update_item")?.verdict,
    ).toBe("conflicted");

    const bodies = await client.listItems({ type, limit: 10 });
    expect(bodies.ok, JSON.stringify(bodies.error)).toBe(true);
    if (!bodies.ok) return;
    expect(
      bodies.data.data.map((held) => String(held.properties.body)).sort(),
    ).toEqual(["Shorter here.", "Written elsewhere."]);
  },
  FRESH_SERVER_TIMEOUT_MS,
);

// Last: it restarts the server every case here shares.
it(
  "lets a held file go once the server takes it, with no edit",
  async () => {
    const files = await folderNamed("raised");
    const path = join(files, "Large.md");
    const large = note("Large", "\u00e9".repeat(999_990));
    writeFileSync(path, large);
    await push(files);
    await push(files);
    expect(await titlesOf(files)).toEqual([]);

    // The same port: the folder's copy belongs to this address.
    await server?.restart({
      env: {
        PORT: new URL(server.apiUrl).port,
        MARFA_MAX_REQUEST_BYTES: String(8 * DEFAULT_LIMIT),
      },
    });
    await push(files);
    expect(await titlesOf(files)).toEqual(["Large"]);
  },
  2 * FRESH_SERVER_TIMEOUT_MS,
);

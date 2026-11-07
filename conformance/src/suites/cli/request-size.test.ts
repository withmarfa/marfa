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
 * takes in one request. The server closes the connection on it with the rest
 * unread, so whether a device hears its `413` on a given send depends on
 * timing, which only a real server and a real socket show. A send that hears
 * nothing ends the pass and goes again on the next push.
 */

// Far more than the sends it takes to hear each `413`, which is one or two.
const PUSHES = 20;

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

it(
  "holds a file past the request size with its reason and sends the files beside it",
  async () => {
    const files = join(dir, "notes");
    const { item } = await cli.json<{ item: { id: string } }>([
      "folders",
      "create",
      "--title",
      "Request size",
      "--query",
      JSON.stringify({ types: ["core.note"] }),
      "--defaults",
      JSON.stringify({ type: "core.note" }),
    ]);
    mkdirSync(files);
    await cli.json(["folders", "add", "--folder", item.id, "--yes", files]);

    const note = (title: string, body: string) =>
      `---\ntitle: ${title}\n---\n${body}\n`;
    // Each encodes past 1 MiB: two bytes a character, a quote's two for its
    // escape, and one just past the limit, whose answer arrives while the
    // system still holds what was sent.
    const large = new Map([
      ["Accents", "\u00e9".repeat(999_990)],
      ["Quotes", '"'.repeat(999_990)],
      ["Just past", "\u00e9".repeat(530_000)],
    ]);
    for (const [title, body] of large)
      writeFileSync(join(files, `${title}.md`), note(title, body));
    const small = ["First", "Second", "Third"];
    for (const title of small)
      writeFileSync(join(files, `${title}.md`), note(title, "A small file."));

    type Report = {
      drain: {
        undelivered: number;
        verdicts: {
          kind: string;
          verdict: string | null;
          reason?: string | null;
        }[];
      };
    };
    const refused: (string | null | undefined)[] = [];
    let waiting = Number.POSITIVE_INFINITY;
    for (let push = 0; push < PUSHES && waiting > 0; push += 1) {
      const pushed = await cli.run(["--json", "folders", "push", files]);
      const { drain } = JSON.parse(pushed.stdout) as Report;
      refused.push(
        ...drain.verdicts
          .filter(
            (entry) =>
              entry.kind === "create_item" && entry.verdict === "refused",
          )
          .map((entry) => entry.reason),
      );
      waiting = drain.undelivered;
      expect(pushed.code, pushed.stderr).toBe(waiting > 0 ? 3 : 0);
    }

    expect(waiting).toBe(0);
    expect(refused).toEqual([...large.keys()].map(() => "request_too_large"));

    const listed = await client.listItems({ type: "core.note", limit: 100 });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    if (!listed.ok) return;
    expect(
      listed.data.data.map((row) => String(row.properties.title)).sort(),
    ).toEqual([...small].sort());

    for (const [title, body] of large)
      expect(readFileSync(join(files, `${title}.md`), "utf8")).toBe(
        note(title, body),
      );

    // Put right, the file goes.
    writeFileSync(join(files, "Quotes.md"), note("Quotes", "Now short."));
    await cli.run(["--json", "folders", "push", files]);
    const after = await client.listItems({ type: "core.note", limit: 100 });
    expect(after.ok).toBe(true);
    if (after.ok)
      expect(
        after.data.data.map((row) => String(row.properties.title)),
      ).toContain("Quotes");
  },
  FRESH_SERVER_TIMEOUT_MS,
);

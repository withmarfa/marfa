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

const PUSHES = 3;

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
  "takes no file past the request size and claims no refusal it did not hear",
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
      ["Large accents", "\u00e9".repeat(999_990)],
      ["Large quotes", '"'.repeat(999_990)],
      ["Large just past", "\u00e9".repeat(530_000)],
    ]);
    for (const [title, body] of large)
      writeFileSync(join(files, `${title}.md`), note(title, body));
    // Ahead of the large files in the queue: a large file that hears nothing
    // ends the pass, and holds back what is queued behind it.
    const small = ["First", "Second", "Earlier"].map((name) => `A ${name}`);
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
    // Whether a send hears the `413` depends on timing, so each push is held
    // only to what is true either way.
    const refused: (string | null | undefined)[] = [];
    for (let push = 0; push < PUSHES; push += 1) {
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
      expect(refused.length + drain.undelivered).toBe(large.size);
      expect(pushed.code, pushed.stderr).toBe(drain.undelivered > 0 ? 3 : 0);
    }
    for (const reason of refused) expect(reason).toBe("request_too_large");

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
  },
  FRESH_SERVER_TIMEOUT_MS,
);

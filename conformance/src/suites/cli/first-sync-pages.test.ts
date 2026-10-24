import { afterAll, beforeAll, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
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
 * A first sync of a folder against a server that limits requests
 * (`queue-and-verdicts/create-pages`). Sent one at a time, each file costs
 * four requests, its item and its placement each written and read back, so
 * a limit of 150 a minute would stop this push long before its 600 writes
 * end.
 */

const NOTES = 300;
let server: FreshServer | undefined;
let cli: Cli;
const dir = mkdtempSync(join(realpathSync(tmpdir()), "marfa-first-sync-"));
let apiUrl = "";
let workingKey = "";

beforeAll(async () => {
  server = await bootFreshServer("cli-first-sync-pages", {
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_REQUESTS: "150",
  });
  ({ apiUrl, workingKey } = server);
  cli = new Cli(requireBinary(), apiUrl, workingKey).withEnv({
    MARFA_FOLDER_REGISTRY: join(dir, "folders.json"),
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
}, FRESH_SERVER_TIMEOUT_MS);

it(
  "pushes a first sync of hundreds of files in one push, within the request limit",
  async () => {
    const files = join(dir, "notes");
    const { item } = await cli.json<{ item: { id: string } }>([
      "folders",
      "create",
      "--title",
      "First sync",
      "--query",
      JSON.stringify({ types: ["core.note"] }),
      "--defaults",
      JSON.stringify({ type: "core.note" }),
    ]);
    mkdirSync(files);
    for (let at = 0; at < NOTES; at += 1) {
      writeFileSync(
        join(files, `note-${String(at)}.md`),
        `---\ntitle: Note ${String(at)}\n---\nBody of note ${String(at)}.\n`,
      );
    }
    await cli.json(["folders", "add", "--folder", item.id, "--yes", files]);

    const pushed = await cli.run(["--json", "folders", "push", files]);

    expect(pushed.code, pushed.stderr).toBe(0);
    const report = JSON.parse(pushed.stdout) as {
      drain: {
        answered: number;
        undelivered: number;
        verdicts: { verdict: string | null }[];
      };
    };
    expect(report.drain.undelivered).toBe(0);
    expect(report.drain.answered).toBe(NOTES * 2);
    expect(
      report.drain.verdicts.filter((entry) => entry.verdict !== "accepted"),
    ).toEqual([]);
    const client = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: workingKey,
    });
    const titles = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listItems({
        type: "core.note",
        limit: 100,
        cursor,
      });
      expect(page.ok, JSON.stringify(page.error)).toBe(true);
      if (!page.ok) return;
      for (const note of page.data.data)
        titles.add(String(note.properties.title));
      cursor = page.data.next_cursor ?? undefined;
    } while (cursor !== undefined);
    expect(titles.size).toBe(NOTES);
    expect(titles.has(`Note ${String(NOTES - 1)}`)).toBe(true);
  },
  FRESH_SERVER_TIMEOUT_MS,
);

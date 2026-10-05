import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, trackFolder, trackItem } from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { CliContext, ItemEnvelope } from "./harness.js";

/**
 * The folder round trip, from the terminal: a note dropped in a folder
 * lands in Marfa, an agent with a key changes it from anywhere, and the
 * change comes back to the folder.
 */

let c: CliContext;
let dir: string;

beforeEach(async () => {
  c = await cliContext("folder");
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-folder-"));
});

afterEach(async () => {
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
  drain: { answered: number; held: number };
  pull: { written: number; rewritten: number; unchanged: number };
}

interface StatusReport {
  files: Array<{ path: string; status: string; waits?: string[] }>;
}

describe("a folder round trip", () => {
  it.each([
    "unindented sequence",
    "first property before a blank line",
    "refused rendering",
  ])(
    "preserves %s edits and continues pulling another document",
    async (mode) => {
      const folder = join(dir, "preserved");
      mkdirSync(folder);
      const settings = await c.cli.json<ItemEnvelope>([
        "folders",
        "create",
        "--title",
        unique("preserved"),
        "--search",
        JSON.stringify({ types: ["core.note"] }),
      ]);
      trackFolder(c.ctx, settings.item.id);
      await c.cli.json([
        "folders",
        "add",
        folder,
        "--folder",
        settings.item.id,
        "--yes",
      ]);
      await c.cli.json(["folders", "hydrate", folder]);
      const path = join(folder, "authored.md");
      const title = unique("preserved");
      writeFileSync(
        path,
        `---\nremove: old\nkeep: 'é' # keep\nitems: ['one', 'two']\ntitle: '${title}'\n---\nBody\n`,
      );
      await c.cli.json(["folders", "push", folder]);
      const first = readFileSync(path, "utf8");
      const id = /^marfa_id: (.+)$/m.exec(first)![1]!.trim();
      trackItem(c.ctx, id);
      const authored =
        mode === "unindented sequence"
          ? first.replace(
              "items: ['one', 'two']",
              "items:\n- 'one' # first\n- 'two' # second",
            )
          : mode === "refused rendering"
            ? first
            : first.replace("remove: old\n", "remove: old\n\n");
      writeFileSync(path, authored);
      const scan = await c.cli.json<{ updated: number }>([
        "folders",
        "scan",
        folder,
      ]);
      expect(scan.updated).toBe(0);
      const independent = await c.cli.json<ItemEnvelope>([
        "items",
        "create",
        "--type",
        "core.note",
        "--properties",
        JSON.stringify({
          title: unique("independent"),
          body: "Continuation\n",
        }),
      ]);
      trackItem(c.ctx, independent.item.id);
      await c.cli.json([
        "items",
        "update",
        id,
        "--version",
        "1",
        "--replace",
        "--properties",
        JSON.stringify({
          title,
          body: "Changed body\n",
          keep: "é",
          items: mode === "unindented sequence" ? [] : ["one", "two"],
          ...(mode === "unindented sequence" ? { remove: "old" } : {}),
        }),
      ]);
      const store = join(folder, ".marfa", "core.sqlite");
      const binding = () => {
        const db = new DatabaseSync(store, { readOnly: true });
        try {
          return db
            .prepare(
              "SELECT path, item_id, identity, content_hash, written_hash, links, edge_lines, edit_line, held, own, writes, presentation FROM folder_files WHERE item_id = ?",
            )
            .get(id);
        } finally {
          db.close();
        }
      };
      const before = binding();
      expect(before).toBeDefined();
      await c.cli.json(["device", "--db", store, "catch-up"]);
      const pullOnce = () =>
        c.cli.json<{
          rewritten: number;
          written: number;
          unwritten: number;
          flagged: Array<{
            path: string;
            flag: string;
            reason: string;
            item?: string;
          }>;
        }>(["folders", "pull", folder]);
      if (mode === "refused rendering")
        process.env.MARFA_TEST_FAULT = "render-frontmatter=authored.md";
      let pull;
      try {
        pull = await pullOnce();
      } finally {
        delete process.env.MARFA_TEST_FAULT;
      }
      expect(pull.unwritten).toBe(mode === "refused rendering" ? 1 : 0);
      if (mode !== "refused rendering")
        expect(pull.rewritten).toBeGreaterThanOrEqual(1);
      expect(pull.written).toBeGreaterThanOrEqual(1);
      expect(
        readFileSync(
          join(folder, `${independent.item.properties.title}.md`),
          "utf8",
        ),
      ).toContain("Continuation\n");
      if (mode === "refused rendering") {
        expect(readFileSync(path, "utf8")).toBe(authored);
        expect(binding()).toEqual(before);
        await c.cli.json([
          "items",
          "update",
          independent.item.id,
          "--version",
          "1",
          "--properties",
          JSON.stringify({ body: "Continuation again\n" }),
        ]);
        await c.cli.json(["device", "--db", store, "catch-up"]);
        process.env.MARFA_TEST_FAULT = "render-frontmatter=authored.md";
        let repeated;
        try {
          repeated = await pullOnce();
        } finally {
          delete process.env.MARFA_TEST_FAULT;
        }
        expect(repeated.unwritten).toBe(1);
        expect(repeated.flagged).toContainEqual({
          path: "authored.md",
          flag: "unwritten",
          reason: expect.stringContaining("injected rendering failure"),
          item: id,
        });
        expect(binding()).toEqual(before);
        expect(readFileSync(path, "utf8")).toBe(authored);
        expect(
          readFileSync(
            join(folder, `${independent.item.properties.title}.md`),
            "utf8",
          ),
        ).toContain("Continuation again\n");
        const unchanged = await c.cli.json<{ updated: number }>([
          "folders",
          "scan",
          folder,
        ]);
        expect(unchanged.updated).toBe(0);
        writeFileSync(path, first);
        await c.cli.json(["folders", "scan", folder]);
        await c.cli.json(["folders", "pull", folder]);
      }
      const expected = (
        mode === "unindented sequence"
          ? authored.replace("- 'one' # first\n- 'two' # second", "  []")
          : mode === "refused rendering"
            ? first.replace("remove: old\n", "")
            : authored.replace("remove: old\n\n", "")
      )
        .replace("marfa_version: 1", "marfa_version: 2")
        .replace("---\nBody\n", "---\nChanged body\n");
      expect(readFileSync(path, "utf8")).toBe(expected);
      await c.cli.json(["folders", "pull", folder]);
      expect(readFileSync(path, "utf8")).toBe(expected);
      const settled = await c.cli.json<{ updated: number }>([
        "folders",
        "scan",
        folder,
      ]);
      expect(settled.updated).toBe(0);
      writeFileSync(path, expected.replace("Changed body\n", "User body\n"));
      const edited = await c.cli.json<PushReport>(["folders", "push", folder]);
      expect(edited.scan.updated).toBe(1);
      const remote = await c.cli.json<ItemEnvelope>(["items", "get", id]);
      expect(remote.item.properties.body).toBe("User body\n");
      expect(remote.item.properties.keep).toBe("é");
    },
  );

  it("keeps authored YAML bytes while first push adds metadata and a remote edit changes one value", async () => {
    const folder = join(dir, "styled");
    mkdirSync(folder);
    const settings = await c.cli.json<ItemEnvelope>([
      "folders",
      "create",
      "--title",
      unique("styled-folder"),
      "--search",
      JSON.stringify({ types: ["core.note"] }),
    ]);
    trackFolder(c.ctx, settings.item.id);
    await c.cli.json([
      "folders",
      "add",
      folder,
      "--folder",
      settings.item.id,
      "--yes",
    ]);
    await c.cli.json(["folders", "hydrate", folder]);
    const path = join(folder, "authored.md");
    const title = unique("authored-yaml");
    const prefix = `---\r\n# Authored café\r\nnumber: 1.10 # precision\r\ninteger: 1.00\r\ntitle: '${title}'\r\nlist: [one, 'two']\r\nnested: {keep: 'é', change: old}\r\nflow: {a: 1}\r\nmoved:\r\n  - 'one' # first\r\n  - 'two' # second\r\ntags: beta, alpha\r\nstate: null\r\nblock: |\r\n  text\r\n`;
    writeFileSync(path, `${prefix}---\r\nBody\r\n`);
    const pushed = await c.cli.json<PushReport>(["folders", "push", folder]);
    expect(pushed.scan.created).toBe(1);
    const first = readFileSync(path, "utf8");
    const id = /^marfa_id: (.+)\r?$/m.exec(first)?.[1]?.trim();
    expect(id).toBeTruthy();
    trackItem(c.ctx, id!);
    expect(first.slice(0, prefix.length)).toBe(prefix);
    expect(first).toContain("marfa_version: 1\r\n");
    const remote = await c.cli.json<ItemEnvelope>(["items", "get", id!]);
    expect(remote.item.properties.number).toBe(1.1);
    await c.cli.json([
      "items",
      "update",
      id!,
      "--version",
      String(remote.item.version),
      "--properties",
      JSON.stringify({ nested: { keep: "é", change: "new" } }),
    ]);
    const store = join(folder, ".marfa", "core.sqlite");
    await c.cli.json(["device", "--db", store, "catch-up"]);
    const pull = await c.cli.json<{ rewritten: number }>([
      "folders",
      "pull",
      folder,
    ]);
    expect(pull.rewritten).toBeGreaterThanOrEqual(1);
    const changed = first
      .replace("change: old", "change: new")
      .replace("marfa_version: 1", "marfa_version: 2");
    expect(readFileSync(path, "utf8")).toBe(changed);
    const styled = changed
      .replace("number: 1.10 # precision", "number: 1.100 # my precision")
      .replace("tags: beta, alpha", "tags: ['alpha', beta]")
      .replace("state: null", "state: active")
      .replace("marfa_version: 2", 'marfa_version: "2"');
    writeFileSync(path, styled);
    const again = await c.cli.json<PushReport>(["folders", "push", folder]);
    expect(again.scan.updated).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(styled);
    const settled = await c.cli.json<{ updated: number }>([
      "folders",
      "scan",
      folder,
    ]);
    expect(settled.updated).toBe(0);
    await c.cli.json([
      "items",
      "update",
      id!,
      "--version",
      "2",
      "--properties",
      JSON.stringify({ flow: { b: 2 }, moved: ["two", "one"] }),
    ]);
    await c.cli.json(["device", "--db", store, "catch-up"]);
    await c.cli.json(["folders", "pull", folder]);
    const rearranged = styled
      .replace("flow: {a: 1}", "flow: {b: 2}")
      .replace(
        "  - 'one' # first\r\n  - 'two' # second\r\n",
        "  - 'two' # second\r\n  - 'one' # first\r\n",
      )
      .replace('marfa_version: "2"', "marfa_version: 3");
    expect(readFileSync(path, "utf8")).toBe(rearranged);
    const afterCollections = await c.cli.json<{ updated: number }>([
      "folders",
      "scan",
      folder,
    ]);
    expect(afterCollections.updated).toBe(0);
  });

  it("is in step after the one push that writes its files", async () => {
    const titles = [1, 2, 3].map((n) => unique(`in-step-${String(n)}`));
    for (const title of titles) {
      const made = await c.cli.json<ItemEnvelope>([
        "items",
        "create",
        "--type",
        "core.note",
        "--properties",
        JSON.stringify({ title, body: "made elsewhere\n" }),
      ]);
      trackItem(c.ctx, made.item.id);
    }
    const settings = await c.cli.json<ItemEnvelope>([
      "folders",
      "create",
      "--title",
      unique("in-step"),
      "--search",
      JSON.stringify({ types: ["core.note"] }),
    ]);
    trackFolder(c.ctx, settings.item.id);
    await c.cli.json([
      "folders",
      "add",
      dir,
      "--folder",
      settings.item.id,
      "--yes",
    ]);
    const pushed = await c.cli.json<PushReport>(["folders", "push", dir]);
    expect(pushed.pull.written).toBeGreaterThanOrEqual(titles.length);
    for (const title of titles) {
      expect(readFileSync(join(dir, `${title}.md`), "utf8")).toContain(title);
    }
    // The placement of each file written is sent by the push that wrote it,
    // and the report counts it.
    expect(pushed.drain.answered).toBe(pushed.pull.written);
    const status = await c.cli.json<StatusReport>(["folders", "status", dir]);
    expect(status.files.length).toBeGreaterThanOrEqual(titles.length);
    expect(
      status.files.filter((file) => file.status !== "in_step"),
      "files a push left waiting",
    ).toEqual([]);
    const again = await c.cli.json<PushReport>(["folders", "push", dir]);
    expect(again.drain.answered).toBe(0);
    expect(again.pull.written).toBe(0);
  });

  it("is in step after the push that runs a confirmed first sync", async () => {
    const title = unique("in-step-confirmed");
    const made = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title, body: "made elsewhere\n" }),
    ]);
    trackItem(c.ctx, made.item.id);
    const settings = await c.cli.json<ItemEnvelope>([
      "folders",
      "create",
      "--title",
      unique("in-step-confirmed"),
      "--search",
      JSON.stringify({ types: ["core.note"] }),
    ]);
    trackFolder(c.ctx, settings.item.id);
    await c.cli.json(["folders", "add", dir, "--folder", settings.item.id]);
    writeFileSync(
      join(dir, "dropped.md"),
      `---\ntitle: ${unique("in-step-dropped")}\n---\nDropped here.\n`,
    );
    const waiting = await c.cli.json<{ first_sync: { waiting: boolean } }>([
      "folders",
      "push",
      dir,
    ]);
    expect(waiting.first_sync.waiting).toBe(true);
    // Reading the folder sends nothing and writes nothing.
    expect(existsSync(join(dir, `${title}.md`))).toBe(false);
    await c.cli.json(["folders", "confirm", dir]);
    const pushed = await c.cli.json<PushReport>(["folders", "push", dir]);
    expect(existsSync(join(dir, `${title}.md`))).toBe(true);
    // The dropped file's create and placement, queued when the first sync
    // was read, and the placement of each file the pull wrote.
    expect(pushed.drain.answered).toBe(2 + pushed.pull.written);
    const status = await c.cli.json<StatusReport>(["folders", "status", dir]);
    expect(
      status.files.filter((file) => file.status !== "in_step"),
      "files a push left waiting",
    ).toEqual([]);
    const minted = /marfa_id: (\S+)/.exec(
      readFileSync(join(dir, "dropped.md"), "utf8"),
    )![1]!;
    trackItem(c.ctx, minted);
  });

  it("names a conflicted edit and the file its text went to, in words", async () => {
    const settings = await c.cli.json<ItemEnvelope>([
      "folders",
      "create",
      "--title",
      unique("conflicted"),
      "--search",
      JSON.stringify({ types: ["core.note"] }),
    ]);
    trackFolder(c.ctx, settings.item.id);
    await c.cli.json([
      "folders",
      "add",
      dir,
      "--folder",
      settings.item.id,
      "--yes",
    ]);
    const title = unique("conflicted-note");
    const path = join(dir, `${title}.md`);
    writeFileSync(path, `---\ntitle: ${title}\n---\nOriginal body\n`);
    await c.cli.json(["folders", "push", dir]);
    const id = /marfa_id: (\S+)/.exec(readFileSync(path, "utf8"))![1]!;
    trackItem(c.ctx, id);
    await c.cli.json([
      "items",
      "update",
      id,
      "--version",
      "1",
      "--properties",
      JSON.stringify({ body: "Changed elsewhere\n" }),
    ]);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("Original body", "Edited here"),
    );
    const pushed = await c.cli.run(["folders", "push", dir]);
    expect(pushed.code, pushed.stderr).toBe(0);
    // The server kept its own text on the row, and the edit's text is in a
    // sibling the pull wrote as a file.
    expect(readFileSync(path, "utf8")).toContain("Changed elsewhere");
    const copy = join(dir, `${title} (2).md`);
    expect(readFileSync(copy, "utf8")).toContain("Edited here");
    const copyId = /marfa_id: (\S+)/.exec(readFileSync(copy, "utf8"))![1]!;
    trackItem(c.ctx, copyId);
    expect(
      pushed.stdout
        .split("\n")
        .filter((line) => line.startsWith("conflicted ")),
    ).toEqual([
      expect.stringMatching(
        new RegExp(
          `^conflicted update_item ${title}\\.md conflicted copy ${title} \\(2\\)\\.md`,
        ),
      ),
    ]);
    // Said once: the next push sends nothing and has nothing to say of it.
    const next = await c.cli.run(["folders", "push", dir]);
    expect(next.stdout).not.toContain("conflicted");
  });

  it("says a conflicted edit while watching, and where its text went", async () => {
    const settings = await c.cli.json<ItemEnvelope>([
      "folders",
      "create",
      "--title",
      unique("conflicted-watch"),
      "--search",
      JSON.stringify({ types: ["core.note"] }),
    ]);
    trackFolder(c.ctx, settings.item.id);
    await c.cli.json([
      "folders",
      "add",
      dir,
      "--folder",
      settings.item.id,
      "--yes",
    ]);
    const title = unique("conflicted-watched");
    const path = join(dir, `${title}.md`);
    writeFileSync(path, `---\ntitle: ${title}\n---\nOriginal body\n`);
    await c.cli.json(["folders", "push", dir]);
    const id = /marfa_id: (\S+)/.exec(readFileSync(path, "utf8"))![1]!;
    trackItem(c.ctx, id);
    await c.cli.json([
      "items",
      "update",
      id,
      "--version",
      "1",
      "--properties",
      JSON.stringify({ body: "Changed elsewhere\n" }),
    ]);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("Original body", "Edited here"),
    );
    // The edit is sent as read at the version its file names, whether or
    // not the watch has caught up with the change made elsewhere by then.
    const watched = await c.cli.run(["folders", "watch", dir, "--for", "8"]);
    expect(watched.code, watched.stderr).toBe(0);
    const copy = join(dir, `${title} (2).md`);
    expect(readFileSync(copy, "utf8")).toContain("Edited here");
    trackItem(c.ctx, /marfa_id: (\S+)/.exec(readFileSync(copy, "utf8"))![1]!);
    const said = watched.stdout
      .split("\n")
      .filter((line) => line.includes("conflicted"));
    expect(said[0]).toMatch(
      new RegExp(`^conflicted update_item ${title}\\.md conflicted copy `),
    );
    // The copy reaches the watch with a change after the answer, so its file
    // is named in that line or, once it is a file, in one of its own.
    expect(said.join("\n")).toContain(`${title} (2).md`);
    expect(
      said.length,
      `a watch said the conflict at every pass: ${watched.stdout}`,
    ).toBeLessThanOrEqual(2);
  });

  it("waits at a first sync until it is confirmed, then sends the dropped note", async () => {
    const folder = join(dir, "asks-first");
    mkdirSync(folder);
    const settings = await c.cli.json<ItemEnvelope>([
      "folders",
      "create",
      "--title",
      unique("asks-first"),
      "--search",
      JSON.stringify({ types: ["core.note"] }),
    ]);
    trackFolder(c.ctx, settings.item.id);
    const path = join(folder, "dropped.md");
    writeFileSync(path, `---\ntitle: '${unique("asks-first")}'\n---\nBody\n`);
    const added = await c.cli.json<{
      first_sync: { waiting: boolean; send: number };
    }>(["folders", "add", folder, "--folder", settings.item.id]);
    expect(added.first_sync).toMatchObject({ waiting: true, send: 1 });
    const waiting = await c.cli.json<{ first_sync: { waiting: boolean } }>([
      "folders",
      "push",
      folder,
    ]);
    expect(waiting.first_sync.waiting).toBe(true);
    // Nothing was sent: a sent file is given its id.
    expect(readFileSync(path, "utf8")).not.toContain("marfa_id");

    const confirmed = await c.cli.json<{ first_sync: boolean }>([
      "folders",
      "confirm",
      folder,
    ]);
    expect(confirmed.first_sync).toBe(true);
    const pushed = await c.cli.json<PushReport>(["folders", "push", folder]);
    expect(pushed.drain.answered).toBeGreaterThan(0);
    expect(readFileSync(path, "utf8")).toContain("marfa_id");
  });

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

    // The settings are a `system.folder` on the server; this machine keeps
    // only which one the directory follows.
    const settings = await c.cli.json<ItemEnvelope>([
      "folders",
      "create",
      "--title",
      unique("cli-folder"),
      "--search",
      JSON.stringify({ types: ["core.note"] }),
    ]);
    trackFolder(c.ctx, settings.item.id);
    await c.cli.json([
      "folders",
      "add",
      dir,
      "--folder",
      settings.item.id,
      "--yes",
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
    // The create and its placement, and the placement of each file the pull
    // wrote.
    expect(pushed.drain.answered).toBe(2 + pushed.pull.written);

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
    // Where the file sits is its placement: an edge to the folder's
    // settings carrying its path.
    const placement = async () =>
      (
        await c.cli.json<{
          data: Array<{
            target_id: string;
            edge_type: string;
            properties: Record<string, unknown>;
          }>;
        }>(["items", "edges", landed.id])
      ).data.filter((edge) => edge.edge_type === "in-folder");
    expect(await placement()).toMatchObject([
      { target_id: settings.item.id, properties: { path: "dropped.md" } },
    ]);

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

    // A change to the settings from anywhere reaches the folder's copy
    // through its stream, and the next new file takes it.
    await c.cli.json([
      "folders",
      "change",
      settings.item.id,
      "--version",
      String(settings.item.version),
      "--defaults",
      JSON.stringify({ tags: ["from-elsewhere"] }),
    ]);
    await c.cli.json(["folders", "push", dir]);
    const held = await c.cli.json<{ properties: Record<string, unknown> }>([
      "device",
      "--db",
      store,
      "items",
      "get",
      settings.item.id,
    ]);
    expect(held.properties.defaults).toEqual({ tags: ["from-elsewhere"] });
    writeFileSync(
      join(dir, "second.md"),
      `---\ntitle: ${unique("cli-folder-second")}\n---\nA second note.\n`,
    );
    await c.cli.json(["folders", "push", dir]);
    const after = await c.cli.json<
      Array<{ kind: string; tag: string | null; item_id: string | null }>
    >(["device", "--db", store, "queue"]);
    const second = after.find(
      (row) => row.kind === "create_item" && row.item_id !== minted,
    )?.item_id;
    if (second) trackItem(c.ctx, second);
    expect(
      after.filter((row) => row.kind === "add_tag").map((row) => row.tag),
    ).toEqual(["from-elsewhere"]);

    // And the other way: an edit of the settings file goes through the
    // folder door and is the folder's settings on the server.
    const settingsFile = join(dir, ".marfa", "folder.yaml");
    writeFileSync(
      settingsFile,
      readFileSync(settingsFile, "utf8").replace(
        "- from-elsewhere",
        "- from-the-file",
      ),
    );
    const edited = await c.cli.json<{ settings: { sent: boolean } }>([
      "folders",
      "push",
      dir,
    ]);
    expect(edited.settings.sent).toBe(true);
    const onServer = await c.cli.json<ItemEnvelope>([
      "items",
      "get",
      settings.item.id,
    ]);
    expect(onServer.item.properties.defaults).toEqual({
      tags: ["from-the-file"],
    });

    // A move inside the folder sends its placement and no edit of the item.
    const before = await c.cli.json<ItemEnvelope>(["items", "get", landed.id]);
    mkdirSync(join(dir, "moved"));
    renameSync(join(dir, "dropped.md"), join(dir, "moved", "dropped.md"));
    await c.cli.json(["folders", "push", dir]);
    expect(await placement()).toMatchObject([
      { properties: { path: "moved/dropped.md" } },
    ]);
    const moved = await c.cli.json<ItemEnvelope>(["items", "get", landed.id]);
    expect(moved.item.version).toBe(before.item.version);
  });
});

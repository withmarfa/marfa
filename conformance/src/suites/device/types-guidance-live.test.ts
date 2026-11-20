import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import { cleanup, createTestContext, trackType } from "../../utils/setup.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { marfa, NO_KEYCHAIN, refusal } from "./types-scaffold.shared.js";

/**
 * "A type's guidance, kept in a Markdown file beside its definition."
 *
 * The real binary against a real server: the file beside `PATH.json` reaches
 * the server as the type's `guidance`.
 */

let client: MarfaClient;
let ctx: TestContext;
let env: Record<string, string>;
let folder: string;
let heard: ScriptedServer;
let quietEnv: Record<string, string>;

beforeAll(async () => {
  let apiUrl: string;
  let apiKey: string;
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "types-guidance",
  ));
  env = { ...NO_KEYCHAIN, MARFA_API_URL: apiUrl, MARFA_API_KEY: apiKey };
  folder = tempFolder("marfa-guidance-");
  heard = await ScriptedServer.start();
  quietEnv = { ...NO_KEYCHAIN, MARFA_API_URL: heard.url, MARFA_API_KEY: "k" };
});
afterAll(async () => {
  await heard?.stop();
  if (ctx) await cleanup(ctx);
});

const idOf = (name: string) =>
  `user.${name}_${ctx.runId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;

/** Writes `<name>.json`, and `<name>.md` where `markdown` is given, and returns the JSON path. */
function write(
  name: string,
  definition: object,
  markdown?: string | Uint8Array,
): string {
  const json = join(folder, `${name}.json`);
  writeFileSync(json, JSON.stringify(definition));
  if (markdown !== undefined)
    writeFileSync(join(folder, `${name}.md`), markdown);
  return json;
}

const FIELDS = { title: { type: "string" } };

async function registered(id: string) {
  return (await client.getType(id)).status === 200;
}

describe("a type's guidance beside its definition", () => {
  it("sends the Markdown file beside the definition as its guidance on register, replace and normalize", async () => {
    const id = idOf("guided");
    const text = "Use for a shop's orders.\n\n## Not for\n\nQuotes, é 😀.";
    const path = write(id, { id, fields: FIELDS }, `${text}\n\n`);

    const normalized = await marfa(
      ["--json", "types", "normalize", "--file", path],
      env,
    );
    expect(normalized.code, normalized.stderr).toBe(0);
    expect(JSON.parse(normalized.stdout).type.guidance).toBe(text);
    expect(await registered(id)).toBe(false);

    const made = await marfa(
      ["--json", "types", "register", "--file", path],
      env,
    );
    expect(made.code, made.stderr).toBe(0);
    trackType(ctx, id, client);
    expect((await client.getType(id)).data.guidance).toBe(text);

    const next = "Second text.";
    writeFileSync(join(folder, `${id}.md`), next);
    const replaced = await marfa(
      ["--json", "types", "replace", id, "--file", path],
      env,
    );
    expect(replaced.code, replaced.stderr).toBe(0);
    expect((await client.getType(id)).data.guidance).toBe(next);
  });

  it("sends a definition as it is when no Markdown file sits beside it, on register and replace, from a file, --body and --file -", async () => {
    const id = idOf("unbesides");
    const path = write(id, { id, fields: FIELDS });
    const made = await marfa(
      ["--json", "types", "register", "--file", path],
      env,
    );
    expect(made.code, made.stderr).toBe(0);
    trackType(ctx, id, client);
    expect((await client.getType(id)).data).not.toHaveProperty("guidance");

    // Inline and stdin input name no file, even when a matching file exists.
    writeFileSync(join(folder, "-.md"), "Not sent.");
    const sources: [
      string[],
      (text: string) => { args: string[]; input?: string },
    ][] = [
      [["--body"], (text) => ({ args: [text] })],
      [["--file", "-"], (text) => ({ args: [], input: text })],
    ];
    for (const [flags, give] of sources) {
      const label = flags.join(" ");
      const name = idOf(`registered_${flags.length}`);
      write(name, { id: name, fields: FIELDS }, "Not sent.");
      const { args, input } = give(
        JSON.stringify({ id: name, fields: FIELDS }),
      );
      const ran = await marfa(
        ["--json", "types", "register", ...flags, ...args],
        env,
        { cwd: folder, input },
      );
      expect(ran.code, `${label}: ${ran.stderr}`).toBe(0);
      trackType(ctx, name, client);
      expect((await client.getType(name)).data, label).not.toHaveProperty(
        "guidance",
      );
    }

    // A replacement from each source holds no guidance, so it removes what was stored.
    const replacements: [
      string[],
      (text: string) => { args: string[]; input?: string },
    ][] = [
      ...sources,
      [
        ["--file"],
        (text) => ({ args: [write(idOf("replacement"), JSON.parse(text))] }),
      ],
    ];
    for (const [index, [flags, give]] of replacements.entries()) {
      const label = flags.join(" ");
      const name = idOf(`replaced_${index}`);
      if (index < sources.length) {
        write(name, { id: name, fields: FIELDS }, "Not sent.");
      }
      const guided = await client.registerType({
        id: name,
        guidance: "Stored.",
        fields: FIELDS,
      } as never);
      expect(guided.status, JSON.stringify(guided.error)).toBe(201);
      trackType(ctx, name, client);
      const { args, input } = give(JSON.stringify({ fields: FIELDS }));
      const ran = await marfa(
        ["--json", "types", "replace", name, ...flags, ...args],
        env,
        { cwd: folder, input },
      );
      expect(ran.code, `${label}: ${ran.stderr}`).toBe(0);
      expect((await client.getType(name)).data, label).not.toHaveProperty(
        "guidance",
      );
    }

    // The witness: a Markdown file beside a JSON file is sent.
    const beside = idOf("beside");
    const withFile = await marfa(
      [
        "--json",
        "types",
        "register",
        "--file",
        write(beside, { id: beside, fields: FIELDS }, "Sent."),
      ],
      env,
    );
    expect(withFile.code, withFile.stderr).toBe(0);
    trackType(ctx, beside, client);
    expect((await client.getType(beside)).data.guidance).toBe("Sent.");
  });

  it("sends no guidance for a Markdown file that holds only whitespace", async () => {
    const id = idOf("blank");
    const path = write(id, { id, fields: FIELDS }, "\n  \n");
    const made = await marfa(
      ["--json", "types", "register", "--file", path],
      env,
    );
    expect(made.code, made.stderr).toBe(0);
    trackType(ctx, id, client);
    expect((await client.getType(id)).data).not.toHaveProperty("guidance");
  });

  /** Runs register, replace and normalize on `path`. */
  async function onEach(path: string, id: string, via: Record<string, string>) {
    return [
      await marfa(["--json", "types", "register", "--file", path], via),
      await marfa(["--json", "types", "replace", id, "--file", path], via),
      await marfa(["--json", "types", "normalize", "--file", path], via),
    ];
  }

  it("exits 1 with invalid for a definition that names guidance beside a Markdown file, on register, replace and normalize", async () => {
    const id = idOf("twice");
    const path = write(
      id,
      { id, fields: FIELDS, guidance: "In the JSON." },
      "In the file.",
    );
    for (const ran of await onEach(path, id, env)) {
      expect(ran.code, ran.stdout).toBe(1);
      expect(refusal(ran).error.code).toBe("invalid");
    }
    // The witness: without the file the same definition registers.
    const alone = idOf("twice_alone");
    const ok = await marfa(
      [
        "--json",
        "types",
        "register",
        "--file",
        write(alone, { id: alone, fields: FIELDS, guidance: "In the JSON." }),
      ],
      env,
    );
    expect(ok.code, ok.stderr).toBe(0);
    trackType(ctx, alone, client);
    expect((await client.getType(alone)).data.guidance).toBe("In the JSON.");
  });

  it("sends no request for a definition that names guidance beside a Markdown file, though the same definition without the file sends one", async () => {
    const id = idOf("twice_quiet");
    const path = write(
      id,
      { id, fields: FIELDS, guidance: "In the JSON." },
      "In the file.",
    );
    const before = heard.requests.length;
    await onEach(path, id, quietEnv);
    expect(heard.requests.length).toBe(before);
    const alone = idOf("twice_quiet_alone");
    await marfa(
      [
        "--json",
        "types",
        "register",
        "--file",
        write(alone, { id: alone, fields: FIELDS, guidance: "In the JSON." }),
      ],
      quietEnv,
    );
    expect(heard.requests.length).toBeGreaterThan(before);
  });

  const UNREADABLE = [
    ["bom", Buffer.from("﻿Use it.", "utf8")],
    ["latin", Buffer.from([0x55, 0x73, 0x65, 0x20, 0xe9, 0x20, 0x69, 0x74])],
  ] as const;

  it("exits 1 with invalid for a Markdown file that is not UTF-8 or starts with a byte-order mark, on register, replace and normalize", async () => {
    for (const [name, bytes] of UNREADABLE) {
      const id = idOf(`bad_${name}`);
      const path = write(id, { id, fields: FIELDS }, bytes);
      for (const ran of await onEach(path, id, env)) {
        expect(ran.code, `${name}: ${ran.stdout}`).toBe(1);
        expect(refusal(ran).error.code, name).toBe("invalid");
      }
    }
    // The witness: text that is UTF-8 with no mark is sent.
    const id = idOf("good_utf8");
    const ok = await marfa(
      [
        "--json",
        "types",
        "register",
        "--file",
        write(id, { id, fields: FIELDS }, "Use it, é 😀."),
      ],
      env,
    );
    expect(ok.code, ok.stderr).toBe(0);
    trackType(ctx, id, client);
  });

  it("sends no request for a Markdown file that is not UTF-8 or starts with a byte-order mark, though a readable one sends one", async () => {
    const before = heard.requests.length;
    for (const [name, bytes] of UNREADABLE) {
      const id = idOf(`bad_quiet_${name}`);
      await onEach(write(id, { id, fields: FIELDS }, bytes), id, quietEnv);
    }
    expect(heard.requests.length).toBe(before);
    const id = idOf("good_quiet");
    await marfa(
      [
        "--json",
        "types",
        "register",
        "--file",
        write(id, { id, fields: FIELDS }, "Use it."),
      ],
      quietEnv,
    );
    expect(heard.requests.length).toBeGreaterThan(before);
  });

  it("prints a type's guidance and its ancestors' as members under --json and as text otherwise", async () => {
    const parent = idOf("print_parent");
    const child = idOf("print_child");
    const rules = "Parent rules.\n\nSecond paragraph.";
    expect(
      (
        await client.registerType({
          id: parent,
          guidance: rules,
          fields: FIELDS,
        } as never)
      ).status,
    ).toBe(201);
    trackType(ctx, parent, client);
    expect(
      (
        await client.registerType({
          id: child,
          parent,
          guidance: "Child rules.",
          fields: {},
        } as never)
      ).status,
    ).toBe(201);
    trackType(ctx, child, client, parent);

    const json = await marfa(["--json", "types", "get", child], env);
    expect(json.code, json.stderr).toBe(0);
    const read = JSON.parse(json.stdout);
    expect(read.guidance).toBe("Child rules.");
    expect(read.ancestor_guidance).toEqual([{ type: parent, guidance: rules }]);

    const text = await marfa(["types", "get", child], env);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain("guidance:\nChild rules.");
    expect(text.stdout).toContain(
      `guidance of ${parent}:\nParent rules.\n\nSecond paragraph.`,
    );
    // A type with no guidance prints none.
    const none = await marfa(["types", "get", "core.note"], env);
    expect(none.code, none.stderr).toBe(0);
    expect(none.stdout).not.toContain("guidance");
  });
});

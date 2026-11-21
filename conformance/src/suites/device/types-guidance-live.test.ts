import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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

/** The commands that send a definition, each with the request it makes of the scripted server. */
const COMMANDS = [
  {
    verb: "register",
    args: () => ["types", "register"],
    method: "POST",
    path: () => "/types",
  },
  {
    verb: "replace",
    args: (id: string) => ["types", "replace", id],
    method: "PUT",
    path: (id: string) => `/types/${id}`,
  },
  {
    verb: "normalize",
    args: () => ["types", "normalize"],
    method: "POST",
    path: () => "/types/normalize",
  },
];

/** How many requests that change something the scripted server has seen. */
const writes = () =>
  heard.requests.filter((request) => request.method !== "GET").length;

/** The body of the request `command` sends for `rest`, read off the scripted server. */
async function bodySent(
  command: (typeof COMMANDS)[number],
  id: string,
  rest: string[],
  options?: { cwd?: string; input?: string },
): Promise<Record<string, unknown>> {
  const before = heard.requests.length;
  await marfa(["--json", ...command.args(id), ...rest], quietEnv, options);
  const made = heard.requests
    .slice(before)
    .filter(
      (request) =>
        request.method === command.method &&
        request.pathname === command.path(id),
    );
  expect(made, `${command.verb} ${rest.join(" ")}`).toHaveLength(1);
  return JSON.parse(made[0].body) as Record<string, unknown>;
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
    const sending = COMMANDS.filter((command) => command.verb !== "normalize");
    // The witness: with a Markdown file beside it, each command sends guidance.
    for (const command of sending) {
      const named = idOf(`witness_${command.verb}`);
      const path = write(named, { id: named, fields: FIELDS }, "Sent.");
      const body = await bodySent(command, named, ["--file", path]);
      expect(body.guidance, command.verb).toBe("Sent.");
    }
    // No such file, or a file that inline and stdin input never read: the request carries
    // the definition and no `guidance`.
    writeFileSync(join(folder, "-.md"), "Not sent.");
    for (const command of sending) {
      const named = idOf(`quiet_${command.verb}`);
      const definition = { id: named, fields: FIELDS };
      const text = JSON.stringify(definition);
      write(named, definition, "Not sent.");
      const alone = idOf(`quiet_alone_${command.verb}`);
      const cases: [string, string[], { cwd?: string; input?: string }?][] = [
        ["--body", ["--body", text], { cwd: folder }],
        ["--file -", ["--file", "-"], { cwd: folder, input: text }],
        [
          "a file",
          ["--file", write(alone, { id: alone, fields: FIELDS })],
          undefined,
        ],
      ];
      for (const [label, rest, options] of cases) {
        const body = await bodySent(command, named, rest, options);
        expect(body, `${command.verb} ${label}`).not.toHaveProperty("guidance");
        expect(body.fields, `${command.verb} ${label}`).toEqual(FIELDS);
      }
    }

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
    // The witness: the same definition without the file is sent by each command.
    const alone = idOf("twice_quiet_alone");
    const held = writes();
    await onEach(
      write(alone, { id: alone, fields: FIELDS, guidance: "In the JSON." }),
      alone,
      quietEnv,
    );
    expect(writes() - held).toBe(COMMANDS.length);

    const before = heard.requests.length;
    await onEach(path, id, quietEnv);
    expect(heard.requests.length).toBe(before);
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
    // The witness: a readable file is sent by each command.
    const good = idOf("good_quiet");
    const held = writes();
    await onEach(
      write(good, { id: good, fields: FIELDS }, "Use it."),
      good,
      quietEnv,
    );
    expect(writes() - held).toBe(COMMANDS.length);

    const before = heard.requests.length;
    for (const [name, bytes] of UNREADABLE) {
      const id = idOf(`bad_quiet_${name}`);
      await onEach(write(id, { id, fields: FIELDS }, bytes), id, quietEnv);
    }
    expect(heard.requests.length).toBe(before);
  });

  it("reads only the entry named exactly PATH.md as guidance, and follows a link", async () => {
    // A name that differs in the case of its extension is not the guidance file, on any file system.
    const other = idOf("upper");
    const sent = await bodySent(COMMANDS[0], other, [
      "--file",
      write(other, { id: other, fields: FIELDS }),
    ]);
    expect(sent).not.toHaveProperty("guidance");
    const upper = idOf("upper_md");
    const upperPath = write(upper, { id: upper, fields: FIELDS });
    writeFileSync(join(folder, `${upper}.MD`), "Not sent.");
    for (const command of COMMANDS) {
      const body = await bodySent(command, upper, ["--file", upperPath]);
      expect(body, command.verb).not.toHaveProperty("guidance");
    }

    // The witness: a link is followed to the file it names, so its text is sent.
    const linked = idOf("linked");
    const linkedPath = write(linked, { id: linked, fields: FIELDS });
    writeFileSync(join(folder, `${linked}.txt`), "Linked text.");
    symlinkSync(join(folder, `${linked}.txt`), join(folder, `${linked}.md`));
    for (const command of COMMANDS) {
      const body = await bodySent(command, linked, ["--file", linkedPath]);
      expect(body.guidance, command.verb).toBe("Linked text.");
    }
  });

  it("refuses a Markdown name that is a folder or a link to nothing, sending no request", async () => {
    // The witness: a readable file under the same kind of name is sent by each command.
    const good = idOf("kind_good");
    const held = writes();
    await onEach(
      write(good, { id: good, fields: FIELDS }, "Use it."),
      good,
      quietEnv,
    );
    expect(writes() - held).toBe(COMMANDS.length);

    const before = heard.requests.length;
    const directory = idOf("kind_folder");
    const directoryPath = write(directory, { id: directory, fields: FIELDS });
    mkdirSync(join(folder, `${directory}.md`));
    const dangling = idOf("kind_dangling");
    const danglingPath = write(dangling, { id: dangling, fields: FIELDS });
    symlinkSync(
      join(folder, `${dangling}.missing`),
      join(folder, `${dangling}.md`),
    );
    for (const [id, path] of [
      [directory, directoryPath],
      [dangling, danglingPath],
    ]) {
      for (const ran of await onEach(path, id, quietEnv)) {
        expect(ran.code, ran.stdout).toBe(1);
        const said = refusal(ran).error;
        expect(said.code).toBe("invalid");
        expect(said.message).toContain("guidance_file_unreadable");
      }
    }
    expect(heard.requests.length).toBe(before);
  });

  it("refuses a Markdown file that cannot be read, sending no request, and reads one in a folder that cannot be listed", async () => {
    const shut = join(folder, "unlisted");
    mkdirSync(shut, { recursive: true });
    const listed = idOf("unlisted_guided");
    const listedPath = join(shut, `${listed}.json`);
    writeFileSync(listedPath, JSON.stringify({ id: listed, fields: FIELDS }));
    writeFileSync(join(shut, `${listed}.md`), "Use it.");
    const closed = idOf("closed_file");
    const closedPath = write(closed, { id: closed, fields: FIELDS }, "Use it.");
    chmodSync(join(folder, `${closed}.md`), 0o000);
    chmodSync(shut, 0o300);
    try {
      // The witness: a folder that cannot be listed still gives its file to each command.
      for (const command of COMMANDS) {
        const body = await bodySent(command, listed, ["--file", listedPath]);
        expect(body.guidance, command.verb).toBe("Use it.");
      }
      const before = heard.requests.length;
      for (const ran of await onEach(closedPath, closed, quietEnv)) {
        expect(ran.code, ran.stdout).toBe(1);
        const said = refusal(ran).error;
        expect(said.code).toBe("invalid");
        expect(said.message).toContain("guidance_file_unreadable");
      }
      expect(heard.requests.length).toBe(before);
    } finally {
      chmodSync(shut, 0o700);
      chmodSync(join(folder, `${closed}.md`), 0o600);
    }
  });

  it("judges an unreadable Markdown file before the definition's own guidance, and a readable empty one beside it as named twice", async () => {
    const inline = { fields: FIELDS, guidance: "In the JSON." };
    const cases: [string, string | Buffer, string][] = [
      ["bom", Buffer.from([0xef, 0xbb, 0xbf]), "guidance_file_unreadable"],
      ["latin", Buffer.from([0xe9]), "guidance_file_unreadable"],
      ["empty", "", "guidance_named_twice"],
      ["blank", " \n", "guidance_named_twice"],
      ["text", "In the file.", "guidance_named_twice"],
    ];
    for (const [name, content, code] of cases) {
      const id = idOf(`order_${name}`);
      const path = write(id, { id, ...inline }, content);
      for (const ran of await onEach(path, id, quietEnv)) {
        expect(ran.code, `${name}: ${ran.stdout}`).toBe(1);
        const said = refusal(ran).error;
        expect(said.code, name).toBe("invalid");
        expect(said.message, name).toContain(code);
      }
    }
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

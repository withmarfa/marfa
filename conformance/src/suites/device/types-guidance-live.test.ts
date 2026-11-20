import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
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

beforeAll(async () => {
  let apiUrl: string;
  let apiKey: string;
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "types-guidance",
  ));
  env = { ...NO_KEYCHAIN, MARFA_API_URL: apiUrl, MARFA_API_KEY: apiKey };
  folder = tempFolder("marfa-guidance-");
});
afterAll(async () => {
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

  it("sends a definition as it is when no Markdown file sits beside it", async () => {
    const id = idOf("unbesides");
    const path = write(id, { id, fields: FIELDS });
    const made = await marfa(
      ["--json", "types", "register", "--file", path],
      env,
    );
    expect(made.code, made.stderr).toBe(0);
    trackType(ctx, id, client);
    expect((await client.getType(id)).data).not.toHaveProperty("guidance");

    // The witness: the same definition read from --body ignores a file of the same name.
    const body = idOf("inline");
    write(body, { id: body, fields: FIELDS }, "Not sent.");
    const inline = await marfa(
      [
        "--json",
        "types",
        "register",
        "--body",
        JSON.stringify({ id: body, fields: FIELDS }),
      ],
      env,
    );
    expect(inline.code, inline.stderr).toBe(0);
    trackType(ctx, body, client);
    expect((await client.getType(body)).data).not.toHaveProperty("guidance");
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

  it("refuses a definition that names guidance beside a Markdown file, sending nothing", async () => {
    const id = idOf("twice");
    const path = write(
      id,
      { id, fields: FIELDS, guidance: "In the JSON." },
      "In the file.",
    );
    const ran = await marfa(
      ["--json", "types", "register", "--file", path],
      env,
    );
    expect(ran.code, ran.stdout).toBe(1);
    expect(refusal(ran).error.code).toBe("invalid");
    expect(await registered(id)).toBe(false);
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

  it("refuses a Markdown file that is not UTF-8 or starts with a byte-order mark, sending nothing", async () => {
    for (const [name, bytes] of [
      ["bom", Buffer.from("﻿Use it.", "utf8")],
      ["latin", Buffer.from([0x55, 0x73, 0x65, 0x20, 0xe9, 0x20, 0x69, 0x74])],
    ] as const) {
      const id = idOf(`bad_${name}`);
      const ran = await marfa(
        [
          "--json",
          "types",
          "register",
          "--file",
          write(id, { id, fields: FIELDS }, bytes),
        ],
        env,
      );
      expect(ran.code, `${name}: ${ran.stdout}`).toBe(1);
      expect(refusal(ran).error.code, name).toBe("invalid");
      expect(await registered(id), name).toBe(false);
    }
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

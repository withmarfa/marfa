import { afterEach, describe, expect, it } from "vitest";
import { typeCatalog } from "../../device/marfa-answers.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import { keychainEnv } from "../../utils/keychain.js";
import { KEY, requireBinary } from "./harness.js";
import { NO_KEYCHAIN, marfa, refusal } from "./types-scaffold.shared.js";

/**
 * "A starting definition for a type, printed offline."
 *
 * The binary against a scripted server that records every request, so that
 * "it sent nothing" is read off a server that is known to hear what is sent.
 */

let server: ScriptedServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const scaffold = (args: string[], env: Record<string, string> = NO_KEYCHAIN) =>
  marfa(["--json", "types", "scaffold", ...args], env);

/** A refusal the command made, with nothing printed to standard output. */
async function refused(args: string[], code: string, exit: number) {
  const ran = await scaffold(args);
  expect(ran.code, ran.stderr).toBe(exit);
  expect(ran.stdout).toBe("");
  const envelope = refusal(ran);
  expect(envelope.error.code).toBe(code);
  expect(envelope.exit).toBe(exit);
  return envelope.error.message;
}

describe("a starting definition for a type", () => {
  it("prints the id, the fields in the order given, the parent and the description", async () => {
    const ran = await scaffold([
      "app.notes.entry",
      "--parent",
      "core.note",
      "--description",
      "An entry",
      "--field",
      "body:string",
      "--field",
      "pages:integer",
      "--field",
      "effort:enum:easy,hard",
      "--field",
      "sources:array:url",
      "--field",
      "cover:thumbnail",
      "--required",
      "body",
    ]);
    expect(ran.code, ran.stderr).toBe(0);
    const definition = JSON.parse(ran.stdout) as {
      fields: Record<string, unknown>;
    };
    expect(definition).toEqual({
      id: "app.notes.entry",
      description: "An entry",
      parent: "core.note",
      fields: {
        body: { type: "string", required: true },
        pages: { type: "integer" },
        effort: { type: "enum", enum_values: ["easy", "hard"] },
        sources: { type: "array", items_type: "url" },
        cover: { type: "thumbnail" },
      },
    });
    expect(Object.keys(definition.fields)).toEqual([
      "body",
      "pages",
      "effort",
      "sources",
      "cover",
    ]);
    const bare = await scaffold(["user.recipe"]);
    expect(JSON.parse(bare.stdout)).toEqual({ id: "user.recipe", fields: {} });
  });

  it("needs no server, working copy or key, and sends nothing where a server is named", async () => {
    // Without anything named, and with a keychain that does not exist.
    const alone = await scaffold(["user.recipe", "--field", "title:string"]);
    expect(alone.code, alone.stderr).toBe(0);

    server = await ScriptedServer.start();
    server.answer("GET", "/types", typeCatalog());
    const named = {
      ...keychainEnv(),
      MARFA_API_URL: server.url,
      MARFA_API_KEY: KEY,
    };
    // Witness: with this server and key, a command that sends reaches the
    // server.
    const listed = await marfa(["--json", "types", "list"], named);
    expect(listed.code, listed.stderr).toBe(0);
    expect(server.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual([
      "GET /types",
    ]);

    // The same definition, and the refusals, send nothing more.
    const printed = await scaffold(
      ["user.recipe", "--field", "title:string"],
      named,
    );
    expect(printed.code, printed.stderr).toBe(0);
    for (const args of [
      ["core.recipe"],
      ["Recipe"],
      ["user.recipe", "--field", "state:string"],
      ["user.recipe", "--field", "title"],
    ]) {
      expect((await scaffold(args, named)).code).not.toBe(0);
    }
    expect(server.requests).toHaveLength(1);
    expect(server.unmatchedRequests).toEqual([]);
  });

  it("refuses --url, --key, --profile and --socket with usage, sending nothing", async () => {
    server = await ScriptedServer.start();
    for (const option of [
      ["--url", server.url],
      ["--key", KEY],
      ["--profile", "demo"],
      ["--socket", "/marfa-test-no-socket"],
    ]) {
      const ran = await marfa(
        [...option, "--json", "types", "scaffold", "user.recipe"],
        NO_KEYCHAIN,
      );
      expect(ran.code, `${option.join(" ")}: ${ran.stderr}`).toBe(2);
      expect(ran.stdout).toBe("");
      expect(refusal(ran).error.code).toBe("usage");
    }
    expect(server.requests).toEqual([]);
  });

  it("refuses an id the grammar or a reserved root refuses, naming the reason", async () => {
    for (const [id, reason] of [
      ["recipe", "lowercase dotted segments"],
      ["User.recipe", "lowercase dotted segments"],
      ["user..recipe", "lowercase dotted segments"],
      ["app.recipe", "exactly three under `app.`"],
      ["keys.recipe", "none under a root Marfa reserves"],
      ["schema.recipe", "none under a root Marfa reserves"],
      ["core.recipe", "Marfa's"],
      ["system.recipe", "Marfa's"],
      ["marfa.recipe", "Marfa's"],
      [`user.${"a".repeat(124)}`, "at most 128 characters"],
    ] as const) {
      const message = await refused([id], "invalid", 1);
      expect(message, id).toContain(reason);
    }
    // Witness: the edges of those rules are taken.
    for (const id of [
      "user.recipe",
      "app.notes.entry",
      "keys-pub.recipe",
      `user.${"a".repeat(123)}`,
    ]) {
      const ran = await scaffold([id]);
      expect(ran.code, `${id}: ${ran.stderr}`).toBe(0);
    }
  });

  it("refuses a field name an item has and a name given twice", async () => {
    for (const name of [
      "id",
      "type",
      "state",
      "tier",
      "properties",
      "created_at",
      "updated_at",
      "occurred_at",
      "source",
      "source_id",
      "version",
      "schema_version",
      "capture_latitude",
      "capture_longitude",
      "trashed_by_cascade",
      "trashed_with",
    ]) {
      const message = await refused(
        ["user.recipe", "--field", `${name}:string`],
        "invalid",
        1,
      );
      expect(message, name).toContain("every item has");
    }
    expect(
      await refused(
        ["user.recipe", "--field", "a:string", "--field", "a:number"],
        "invalid",
        1,
      ),
    ).toContain("given twice");
    // Witness: names that only resemble them are taken, and so is any name
    // the registry takes, however it is spelled.
    const ran = await scaffold([
      "user.recipe",
      ...["state_text", "types", "Title", "1st", "toString", "a-b.c"].flatMap(
        (name) => ["--field", `${name}:string`],
      ),
    ]);
    expect(ran.code, ran.stderr).toBe(0);
  });

  it("refuses a field type outside the grammar, an enum with no values, and an array with no element type or of thumbnails", async () => {
    expect(
      await refused(["user.recipe", "--field", "a:blob"], "invalid", 1),
    ).toContain("not a field type");
    expect(
      await refused(["user.recipe", "--field", "a:enum"], "invalid", 1),
    ).toContain("allowed values");
    expect(
      await refused(["user.recipe", "--field", "a:array"], "invalid", 1),
    ).toContain("type of its elements");
    expect(
      await refused(
        ["user.recipe", "--field", "a:array:thumbnail"],
        "invalid",
        1,
      ),
    ).toContain("array of thumbnails");
    // Witness: the server registers each of these, so the command takes them.
    for (const spec of [
      "a:enum:x,x",
      "a:enum:x,,y",
      "a:enum:",
      "a:array:array",
      "a:array:enum",
      "a:array:nothing",
    ]) {
      const taken = await scaffold(["user.recipe", "--field", spec]);
      expect(taken.code, `${spec}: ${taken.stderr}`).toBe(0);
    }
    // Witness: every field type the grammar names is taken with what it needs.
    const ran = await scaffold([
      "user.recipe",
      ...[
        "a:string",
        "b:number",
        "c:integer",
        "d:boolean",
        "e:url",
        "f:email",
        "g:datetime",
        "h:date",
        "i:enum:x,y",
        "j:array:object",
        "k:object",
        "l:thumbnail",
      ].flatMap((spec) => ["--field", spec]),
    ]);
    expect(ran.code, ran.stderr).toBe(0);
  });

  it("refuses a second thumbnail and a thumbnail named for a field search reads", async () => {
    expect(
      await refused(
        ["user.recipe", "--field", "a:thumbnail", "--field", "b:thumbnail"],
        "invalid",
        1,
      ),
    ).toContain("at most one");
    for (const name of ["title", "body", "description", "name"]) {
      expect(
        await refused(
          ["user.recipe", "--field", `${name}:thumbnail`],
          "invalid",
          1,
        ),
        name,
      ).toContain("search reads");
    }
    const ran = await scaffold(["user.recipe", "--field", "cover:thumbnail"]);
    expect(ran.code, ran.stderr).toBe(0);
  });

  it("refuses a parent that breaks the grammar or is the type itself", async () => {
    for (const parent of ["note", "Core.note", "core.*", "keys.entry"]) {
      expect(
        await refused(["user.recipe", "--parent", parent], "invalid", 1),
        parent,
      ).toContain("not a parent");
    }
    expect(
      await refused(["user.recipe", "--parent", "user.recipe"], "invalid", 1),
    ).toContain("its own parent");
    // Witness: a parent the grammar takes is, shipped or not.
    for (const parent of ["core.note", "user.base"]) {
      const ran = await scaffold(["user.recipe", "--parent", parent]);
      expect(ran.code, `${parent}: ${ran.stderr}`).toBe(0);
    }
  });

  it("refuses a field a shipped parent holds to another shape, or to be required", async () => {
    expect(
      await refused(
        ["user.recipe", "--parent", "core.message", "--field", "from:string"],
        "invalid",
        1,
      ),
    ).toContain("cannot make optional");
    expect(
      await refused(
        [
          "user.recipe",
          "--parent",
          "core.note",
          "--field",
          "body:integer",
          "--required",
          "body",
        ],
        "invalid",
        1,
      ),
    ).toContain("different type");
    expect(
      await refused(
        ["user.recipe", "--parent", "core.note", "--field", "language:string"],
        "invalid",
        1,
      ),
    ).toContain("different format");
    expect(
      await refused(
        [
          "user.recipe",
          "--parent",
          "core.task",
          "--field",
          "priority:enum:low,high",
        ],
        "invalid",
        1,
      ),
    ).toContain("different enum_values");
    expect(
      await refused(
        ["user.recipe", "--parent", "core.message", "--field", "to:array:url"],
        "invalid",
        1,
      ),
    ).toContain("different items_type");
    // Witness: restated as the parent has it, or left out, it is taken; and a
    // parent that is not shipped is not judged.
    for (const args of [
      ["--parent", "core.note", "--field", "body:string", "--required", "body"],
      ["--parent", "core.note", "--field", "body:string"],
      [
        "--parent",
        "core.message",
        "--field",
        "from:string",
        "--required",
        "from",
      ],
      ["--parent", "core.note", "--field", "title:string"],
      [
        "--parent",
        "core.task",
        "--field",
        "priority:enum:low,medium,high,urgent",
      ],
      ["--parent", "core.message", "--field", "to:array:string"],
      ["--parent", "user.base", "--field", "body:integer"],
    ]) {
      const ran = await scaffold(["user.recipe", ...args]);
      expect(ran.code, `${args.join(" ")}: ${ran.stderr}`).toBe(0);
    }
  });

  it("refuses an option it cannot read with usage", async () => {
    expect(
      await refused(["user.recipe", "--field", "title"], "usage", 2),
    ).toContain("NAME:TYPE");
    expect(
      await refused(["user.recipe", "--field", "title:"], "usage", 2),
    ).toContain("NAME:TYPE");
    expect(
      await refused(["user.recipe", "--field", "title:string:x"], "usage", 2),
    ).toContain("third part");
    expect(
      await refused(["user.recipe", "--required", "title"], "usage", 2),
    ).toContain("names no field");
    expect(
      await refused(
        ["user.recipe", "--field", "title:string", "--required", "other"],
        "usage",
        2,
      ),
    ).toContain("names no field");
  });

  it("declares what it printed on a working copy, unchanged", async () => {
    const printed = await scaffold([
      "user.recipe",
      "--field",
      "title:string",
      "--field",
      "effort:enum:easy,hard",
      "--field",
      "sources:array:url",
      "--required",
      "title",
    ]);
    expect(printed.code, printed.stderr).toBe(0);
    const definition = JSON.parse(printed.stdout) as Record<string, unknown>;
    const device = new CliDevice({
      binary: requireBinary(),
      store: newStore("scaffold-declare"),
    });
    const made = await device.status();
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const declared = await device.declareTypes([definition]);
    expect(declared.ok, JSON.stringify(declared)).toBe(true);
    const held = await device.declaredTypes();
    expect(held.ok && held.value[0]).toMatchObject(definition);
    // Witness: the copy refuses a definition the command would not print.
    const refusedDeclaration = await device.declareTypes([
      { id: "core.recipe", fields: {} },
    ]);
    expect(refusedDeclaration.ok).toBe(false);
  });
});

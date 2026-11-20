import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { typeCatalog } from "../../device/marfa-answers.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import { keychainEnv } from "../../utils/keychain.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { KEY } from "./harness.js";
import { NO_KEYCHAIN, marfa, refusal } from "./types-scaffold.shared.js";

/**
 * "A folder of type definitions, checked offline."
 *
 * The binary against folders it makes, with a scripted server that records
 * every request, so that "it sent nothing" is read off a server that is known
 * to hear what is sent.
 */

let server: ScriptedServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

type Definition = Record<string, unknown>;

interface Verdict {
  ok: boolean;
  checked: number;
  refused: number;
  files: {
    file: string;
    id: string | null;
    ok: boolean;
    problems: { path: string; code: string; message: string; hint?: string }[];
  }[];
}

/** A folder holding each definition as `<id>.json`, or under the name given. */
function folderOf(
  definitions: Definition[],
  names: Record<string, string> = {},
): string {
  const folder = tempFolder("marfa-types-check-");
  for (const definition of definitions) {
    const id = definition.id as string;
    writeFileSync(
      join(folder, names[id] ?? `${id}.json`),
      JSON.stringify(definition),
    );
  }
  return folder;
}

const check = (
  folder: string,
  env: Record<string, string> = NO_KEYCHAIN,
  options: string[] = [],
) => marfa([...options, "--json", "types", "check", folder], env);

async function verdictOf(folder: string, exit: number): Promise<Verdict> {
  const ran = await check(folder);
  expect(ran.code, ran.stderr).toBe(exit);
  return JSON.parse(ran.stdout) as Verdict;
}

const problemsOf = (verdict: Verdict, file: string) =>
  verdict.files.find((entry) => entry.file === file)?.problems ?? [];

const note = { type: "string" };

describe("a folder of type definitions, checked offline", () => {
  it("passes a folder whose types name a shipped parent and each other", async () => {
    const folder = folderOf([
      {
        id: "acme.sprint-task",
        parent: "core.task",
        fields: { sprint: { type: "integer" } },
      },
      {
        id: "acme.bug",
        parent: "acme.sprint-task",
        fields: { severity: note },
      },
    ]);
    const verdict = await verdictOf(folder, 0);
    expect(verdict).toMatchObject({ ok: true, checked: 2, refused: 0 });
    expect(problemsOf(verdict, "acme.bug.json")).toEqual([]);
  });

  it("refuses each definition a registration refuses, naming the file, the path, the code and the message", async () => {
    const cases: [string, Definition, Definition, string, string, string][] = [
      [
        "a redefined inherited field",
        {
          id: "acme.t",
          parent: "core.task",
          fields: { title: { type: "string", required: true } },
        },
        {
          id: "acme.t",
          parent: "core.task",
          fields: { title: { type: "integer", required: true } },
        },
        "fields.title.type",
        "inheritance_violation",
        'inherited from "core.task"',
      ],
      [
        "a status word in a group that does not exist",
        {
          id: "acme.t",
          fields: {
            s: {
              type: "status",
              status_values: [{ value: "open", group: "not_started" }],
            },
          },
        },
        {
          id: "acme.t",
          fields: {
            s: {
              type: "status",
              status_values: [{ value: "open", group: "underway" }],
            },
          },
        },
        "fields.s.status_values.0.group",
        "invalid_schema",
        "underway",
      ],
      [
        "two thumbnail fields",
        { id: "acme.t", fields: { a: { type: "thumbnail" }, b: note } },
        {
          id: "acme.t",
          fields: { a: { type: "thumbnail" }, b: { type: "thumbnail" } },
        },
        "fields.b",
        "invalid_schema",
        "at most one thumbnail",
      ],
      [
        "an unknown field type",
        { id: "acme.t", fields: { x: note } },
        { id: "acme.t", fields: { x: { type: "colour" } } },
        "fields.x.type",
        "invalid_schema",
        "colour",
      ],
      [
        "an enum with no values",
        { id: "acme.t", fields: { x: { type: "enum", enum_values: ["a"] } } },
        { id: "acme.t", fields: { x: { type: "enum" } } },
        "fields.x.enum_values",
        "invalid_schema",
        "enum_values",
      ],
      [
        "an unknown key",
        { id: "acme.t", description: "What it is", fields: { x: note } },
        { id: "acme.t", colour: "red", fields: { x: note } },
        "colour",
        "invalid_schema",
        "colour",
      ],
      [
        "a missing fields key",
        { id: "acme.t", fields: {} },
        { id: "acme.t" },
        "fields",
        "missing_required_field",
        "fields is required",
      ],
    ];
    for (const [what, valid, broken, path, code, said] of cases) {
      const passed = await verdictOf(folderOf([valid]), 0);
      expect(passed.ok, `${what}: the valid version`).toBe(true);

      const verdict = await verdictOf(folderOf([broken]), 1);
      const found = problemsOf(verdict, "acme.t.json").find(
        (problem) => problem.path === path,
      );
      expect(found, what).toBeDefined();
      expect(found?.code, what).toBe(code);
      expect(found?.message, what).toContain(said);
    }
  });

  it("refuses a loosened minimum and a reserved root", async () => {
    const floor = {
      id: "acme.floor",
      fields: { n: { type: "integer", minimum: 5 } },
    };
    const lower = (minimum: number) => ({
      id: "acme.lower",
      parent: "acme.floor",
      fields: { n: { type: "integer", minimum } },
    });
    expect((await verdictOf(folderOf([floor, lower(7)]), 0)).ok).toBe(true);
    const verdict = await verdictOf(folderOf([floor, lower(1)]), 1);
    expect(problemsOf(verdict, "acme.lower.json")[0]).toMatchObject({
      path: "fields.n.minimum",
      code: "inheritance_violation",
    });
    expect(problemsOf(verdict, "acme.floor.json")).toEqual([]);

    const reserved = await verdictOf(
      folderOf([{ id: "core.x", fields: { x: note } }]),
      1,
    );
    expect(problemsOf(reserved, "core.x.json")).toMatchObject([
      { path: "id", code: "forbidden" },
    ]);
  });

  it("names a missing parent, a parent loop and a refused parent as the one reason", async () => {
    const under = (id: string, parent: string) => ({
      id,
      parent,
      fields: { x: note },
    });
    const missing = await verdictOf(
      folderOf([under("acme.orphan", "acme.gone")]),
      1,
    );
    expect(problemsOf(missing, "acme.orphan.json")).toMatchObject([
      {
        path: "parent",
        code: "validation_error",
        message: 'Parent type "acme.gone" not found',
      },
    ]);

    const looped = await verdictOf(
      folderOf([
        under("acme.a", "acme.b"),
        under("acme.b", "acme.a"),
        under("acme.c", "acme.a"),
      ]),
      1,
    );
    for (const file of ["acme.a.json", "acme.b.json"]) {
      expect(problemsOf(looped, file)).toMatchObject([
        { message: "Circular inheritance detected" },
      ]);
    }
    expect(problemsOf(looped, "acme.c.json")).toMatchObject([
      { code: "parent_refused" },
    ]);

    const refusedParent = await verdictOf(
      folderOf([
        { id: "acme.p", fields: { x: { type: "colour" } } },
        under("acme.q", "acme.p"),
      ]),
      1,
    );
    expect(problemsOf(refusedParent, "acme.q.json")).toMatchObject([
      { code: "parent_refused" },
    ]);
  });

  it("refuses a file name that differs from the id, including by case", async () => {
    const definition = { id: "acme.recipe", fields: { x: note } };
    expect((await verdictOf(folderOf([definition]), 0)).ok).toBe(true);
    for (const name of [
      "recipe.json",
      "Acme.recipe.json",
      "acme.recipe.JSON",
    ]) {
      const verdict = await verdictOf(
        folderOf([definition], { "acme.recipe": name }),
        1,
      );
      expect(problemsOf(verdict, name), name).toMatchObject([
        { code: "file_name_mismatch", path: "id" },
      ]);
    }
  });

  it("reports unreadable and malformed files and still checks the others", async () => {
    const folder = folderOf([{ id: "acme.fine", fields: { x: note } }]);
    const target = join(folder, "target");
    writeFileSync(target, JSON.stringify({ id: "acme.link", fields: {} }));
    symlinkSync(target, join(folder, "acme.link.json"));
    expect((await verdictOf(folder, 0)).checked).toBe(2);
    unlinkSync(target);
    writeFileSync(join(folder, "acme.broken.json"), '{ "id": ');
    writeFileSync(join(folder, "acme.list.json"), "[]");
    writeFileSync(join(folder, "acme.latin.json"), Buffer.from([0x7b, 0xe9]));
    writeFileSync(
      join(folder, "acme.marked.json"),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('{"id":"acme.marked","fields":{}}'),
      ]),
    );
    const verdict = await verdictOf(folder, 1);
    expect(verdict).toMatchObject({ checked: 6, refused: 5 });
    expect(problemsOf(verdict, "acme.fine.json")).toEqual([]);
    expect(problemsOf(verdict, "acme.link.json")).toMatchObject([
      { code: "file_unreadable" },
    ]);
    expect(problemsOf(verdict, "acme.broken.json")[0]?.message).toContain(
      "line 1 column",
    );
    expect(problemsOf(verdict, "acme.list.json")[0]?.message).toBe(
      "The body must be a JSON object.",
    );
    expect(problemsOf(verdict, "acme.latin.json")[0]?.hint).toContain("UTF-8");
    expect(problemsOf(verdict, "acme.marked.json")[0]?.hint).toContain(
      "byte-order mark",
    );
  });

  it("refuses a folder that does not exist, is a file or holds no json files", async () => {
    const folder = tempFolder("marfa-types-check-");
    for (const path of [join(folder, "nothing-here"), join(folder, "a.json")]) {
      writeFileSync(join(folder, "a.json"), "{}");
      const ran = await check(path);
      expect(ran.code, ran.stderr).toBe(2);
      expect(ran.stdout).toBe("");
      expect(refusal(ran).error.code).toBe("usage");
    }
    const empty = tempFolder("marfa-types-check-");
    writeFileSync(join(empty, "README.md"), "text");
    mkdirSync(join(empty, "sub"));
    writeFileSync(join(empty, "sub", "acme.x.json"), "{}");
    const ran = await check(empty);
    expect(ran.code, ran.stderr).toBe(1);
    expect(refusal(ran).error.code).toBe("invalid");
    expect(refusal(ran).error.message).toContain("no *.json files found");
  });

  it("needs no server, key or keychain, and sends nothing where a server is named", async () => {
    const folder = folderOf([{ id: "acme.recipe", fields: { x: note } }]);
    const alone = await check(folder);
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

    expect((await check(folder, named)).code).toBe(0);
    expect((await check(join(folder, "nothing-here"), named)).code).toBe(2);
    expect(server.requests).toHaveLength(1);
    expect(server.unmatchedRequests).toEqual([]);
  });

  it("refuses --url, --key, --profile and --socket with usage, sending nothing", async () => {
    server = await ScriptedServer.start();
    const folder = folderOf([{ id: "acme.recipe", fields: { x: note } }]);
    for (const option of [
      ["--url", server.url],
      ["--key", KEY],
      ["--profile", "demo"],
      ["--socket", "/marfa-test-no-socket"],
    ]) {
      const ran = await check(folder, NO_KEYCHAIN, option);
      expect(ran.code, `${option.join(" ")}: ${ran.stderr}`).toBe(2);
      expect(ran.stdout).toBe("");
      expect(refusal(ran).error.code).toBe("usage");
    }
    expect(server.requests).toEqual([]);
  });
});

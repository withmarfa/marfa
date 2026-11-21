import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempFolder } from "../../utils/temp-folder.js";
import { NO_KEYCHAIN, marfa } from "./types-scaffold.shared.js";

/**
 * "The guidance a folder of type definitions keeps in Markdown files."
 *
 * The binary against folders it makes: each `<id>.json` with an `<id>.md`
 * beside it, as `types register --file` reads the pair.
 */

interface Verdict {
  ok: boolean;
  checked: number;
  refused: number;
  files: {
    file: string;
    id: string | null;
    ok: boolean;
    problems: { path: string; code: string; message: string; hint?: string }[];
    context?: string;
  }[];
}

const note = { type: "string" };

function folderOf(files: Record<string, string | Buffer>): string {
  const folder = tempFolder("marfa-types-check-guidance-");
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(folder, name), content);
  }
  return folder;
}

const definition = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, fields: { x: note }, ...extra });

async function verdictOf(folder: string, exit: number): Promise<Verdict> {
  const ran = await marfa(["--json", "types", "check", folder], NO_KEYCHAIN);
  expect(ran.code, ran.stderr).toBe(exit);
  return JSON.parse(ran.stdout) as Verdict;
}

const problemsOf = (verdict: Verdict, file: string) =>
  verdict.files.find((entry) => entry.file === file)?.problems ?? [];

describe("the guidance a folder of type definitions keeps in Markdown files", () => {
  it("judges a definition with the Markdown file beside it as its guidance, trimmed as a registration trims it", async () => {
    // The limit counts characters, not bytes: 1,000 emoji are 4,000 bytes.
    const atLimit = "\u{1F600}".repeat(1000);
    const passed = await verdictOf(
      folderOf({
        "acme.recipe.json": definition("acme.recipe"),
        "acme.recipe.md": `${atLimit}\n\n  \n`,
      }),
      0,
    );
    expect(passed).toMatchObject({ ok: true, checked: 1, refused: 0 });

    // Witness: one character more is refused, so the text was read and judged.
    const over = await verdictOf(
      folderOf({
        "acme.recipe.json": definition("acme.recipe"),
        "acme.recipe.md": `${atLimit}x`,
      }),
      1,
    );
    expect(problemsOf(over, "acme.recipe.json")).toMatchObject([
      { path: "guidance" },
    ]);
  });

  it("refuses guidance over the limit and guidance on an app type, with the server's code and message", async () => {
    const witness = await verdictOf(
      folderOf({
        "acme.recipe.json": definition("acme.recipe"),
        "acme.recipe.md": "Use it.",
        "app.acme.note.json": definition("app.acme.note"),
      }),
      0,
    );
    expect(witness.refused).toBe(0);

    const verdict = await verdictOf(
      folderOf({
        "acme.recipe.json": definition("acme.recipe"),
        "acme.recipe.md": "a".repeat(1001),
        "app.acme.note.json": definition("app.acme.note"),
        "app.acme.note.md": "Use it.",
      }),
      1,
    );
    expect(problemsOf(verdict, "acme.recipe.json")).toMatchObject([
      {
        path: "guidance",
        code: "invalid_schema",
        message: expect.stringContaining("at most 1000 characters"),
      },
    ]);
    expect(problemsOf(verdict, "app.acme.note.json")).toMatchObject([
      {
        path: "guidance",
        code: "invalid_schema",
        message: expect.stringContaining("no guidance on a type an app owns"),
      },
    ]);
  });

  it("judges a Markdown file that holds only whitespace as no guidance", async () => {
    // Witness: the same app type with text beside it is refused.
    const witness = await verdictOf(
      folderOf({
        "app.acme.note.json": definition("app.acme.note"),
        "app.acme.note.md": "Use it.",
      }),
      1,
    );
    expect(problemsOf(witness, "app.acme.note.json")).toHaveLength(1);

    const verdict = await verdictOf(
      folderOf({
        "app.acme.note.json": definition("app.acme.note"),
        "app.acme.note.md": " \n\t\n",
      }),
      0,
    );
    expect(verdict).toMatchObject({ ok: true, checked: 1, refused: 0 });
  });

  it("refuses a definition that names guidance beside a Markdown file", async () => {
    // Witness: the definition's own guidance passes where no file is beside it.
    await verdictOf(
      folderOf({
        "acme.recipe.json": definition("acme.recipe", { guidance: "Use it." }),
      }),
      0,
    );

    for (const text of ["Use it too.", "", " \n\t\n"]) {
      const verdict = await verdictOf(
        folderOf({
          "acme.recipe.json": definition("acme.recipe", {
            guidance: "Use it.",
          }),
          "acme.recipe.md": text,
        }),
        1,
      );
      expect(problemsOf(verdict, "acme.recipe.json")).toMatchObject([
        { path: "guidance", code: "guidance_named_twice" },
      ]);
    }
  });

  it("refuses a Markdown file that cannot be read, is not UTF-8 or starts with a byte-order mark, and still checks the others", async () => {
    const folder = folderOf({
      "acme.fine.json": definition("acme.fine"),
      "acme.fine.md": "Use it.",
      "acme.latin.json": definition("acme.latin"),
      "acme.latin.md": Buffer.from([0x55, 0xe9]),
      "acme.marked.json": definition("acme.marked"),
      "acme.marked.md": Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("Use it."),
      ]),
      "acme.link.json": definition("acme.link"),
      "acme.folder.json": definition("acme.folder"),
      "acme.both.json": definition("acme.both", { guidance: "Use it." }),
      "acme.both.md": Buffer.from([0xef, 0xbb, 0xbf]),
    });
    mkdirSync(join(folder, "acme.folder.md"));
    // Witness: the link's target exists, so the file reads.
    const target = join(folder, "target");
    writeFileSync(target, "Use it.");
    symlinkSync(target, join(folder, "acme.link.md"));
    const readable = await verdictOf(
      folderOf({
        "acme.fine.json": definition("acme.fine"),
        "acme.fine.md": "Use it.",
      }),
      0,
    );
    expect(readable.refused).toBe(0);
    unlinkSync(target);

    const verdict = await verdictOf(folder, 1);
    expect(verdict).toMatchObject({ checked: 6, refused: 5 });
    expect(problemsOf(verdict, "acme.fine.json")).toEqual([]);
    for (const [file, said] of [
      ["acme.latin.json", "not UTF-8"],
      ["acme.marked.json", "byte-order mark"],
      ["acme.link.json", "Cannot read"],
      ["acme.folder.json", "not a regular file"],
      ["acme.both.json", "byte-order mark"],
    ] as const) {
      expect(problemsOf(verdict, file), file).toMatchObject([
        {
          path: "guidance",
          code: "guidance_file_unreadable",
          message: expect.stringContaining(said),
        },
      ]);
    }
  });

  it("refuses a Markdown file named for a type that has no definition beside it", async () => {
    // Witness: with its definition beside it the same file passes.
    await verdictOf(
      folderOf({
        "acme.recipe.json": definition("acme.recipe"),
        "acme.recipe.md": "Use it.",
      }),
      0,
    );

    const verdict = await verdictOf(
      folderOf({
        "acme.recipe.json": definition("acme.recipe"),
        "acme.recipe.md": "Use it.",
        "acme.recipes.md": "Use them.",
      }),
      1,
    );
    expect(problemsOf(verdict, "acme.recipe.json")).toEqual([]);
    expect(problemsOf(verdict, "acme.recipes.md")).toMatchObject([
      { code: "guidance_file_without_definition" },
    ]);

    // A folder of guidance with no definition at all is refused too.
    const alone = await verdictOf(folderOf({ "acme.recipe.md": "x" }), 1);
    expect(problemsOf(alone, "acme.recipe.md")).toMatchObject([
      { code: "guidance_file_without_definition" },
    ]);
  });

  it("reads only the entry named exactly after the definition as its guidance, and follows a link", async () => {
    const over = "a".repeat(1001);
    // A name that differs in the case of its extension is not the guidance file, on any file
    // system, and is not an orphan either.
    const other = await verdictOf(
      folderOf({
        "acme.recipe.json": definition("acme.recipe"),
        "acme.recipe.MD": over,
        "acme.other.MD": "Use it.",
      }),
      0,
    );
    expect(other).toMatchObject({ ok: true, checked: 1, refused: 0 });

    // Witness: the same text under the exact name is judged.
    const exact = await verdictOf(
      folderOf({
        "acme.recipe.json": definition("acme.recipe"),
        "acme.recipe.md": over,
      }),
      1,
    );
    expect(problemsOf(exact, "acme.recipe.json")).toMatchObject([
      { path: "guidance" },
    ]);

    // A link is followed to the file it names.
    const folder = folderOf({
      "acme.recipe.json": definition("acme.recipe"),
      "acme.target.txt": over,
    });
    symlinkSync(
      join(folder, "acme.target.txt"),
      join(folder, "acme.recipe.md"),
    );
    const linked = await verdictOf(folder, 1);
    expect(problemsOf(linked, "acme.recipe.json")).toMatchObject([
      { path: "guidance", code: "invalid_schema" },
    ]);
  });

  it("reports a Markdown file beside a refused definition as paired with it, not as without a definition", async () => {
    // Witness: with no definition at all, the same file is refused as without one.
    const orphan = await verdictOf(
      folderOf({ "acme.broken.md": "Use it." }),
      1,
    );
    expect(problemsOf(orphan, "acme.broken.md")).toMatchObject([
      { code: "guidance_file_without_definition" },
    ]);

    const verdict = await verdictOf(
      folderOf({
        "acme.fine.json": definition("acme.fine"),
        "acme.broken.json": "{ not json",
        "acme.broken.md": "Use it.",
      }),
      1,
    );
    expect(verdict.files.map((entry) => entry.file)).toEqual([
      "acme.broken.json",
      "acme.fine.json",
    ]);
    const broken = verdict.files[0];
    expect(broken.context).toContain("acme.broken.md");
    expect(broken.problems).toMatchObject([{ code: "validation_error" }]);
  });

  it("tells a type whose parent was refused for its guidance file that the parent was refused in the folder", async () => {
    const child = definition("acme.leaf", { parent: "acme.base" });
    // Witness: with no parent in the folder, the child is told it is absent.
    const absent = await verdictOf(folderOf({ "acme.leaf.json": child }), 1);
    const absentContext = absent.files[0].context ?? "";
    expect(absentContext).toContain("is not shipped or in this folder");

    const verdict = await verdictOf(
      folderOf({
        "acme.base.json": definition("acme.base"),
        "acme.base.md": Buffer.from([0x55, 0xe9]),
        "acme.leaf.json": child,
      }),
      1,
    );
    expect(problemsOf(verdict, "acme.base.json")).toMatchObject([
      { code: "guidance_file_unreadable" },
    ]);
    const context = verdict.files.find(
      (entry) => entry.file === "acme.leaf.json",
    )?.context;
    expect(context).toContain("was refused in this folder");
    expect(context).not.toContain("is not shipped or in this folder");
  });

  it("says no definitions were found for a folder that holds only Markdown files, and reports them", async () => {
    // Witness: an empty folder is refused with the same message.
    const empty = await marfa(["types", "check", folderOf({})], NO_KEYCHAIN);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("no *.json files found");

    const folder = folderOf({
      "acme.recipe.md": "Use it.",
      "README.md": "About.",
    });
    const ran = await marfa(["--json", "types", "check", folder], NO_KEYCHAIN);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("no *.json files found");
    const verdict = JSON.parse(ran.stdout) as Verdict;
    expect(problemsOf(verdict, "acme.recipe.md")).toMatchObject([
      { code: "guidance_file_without_definition" },
    ]);
  });

  it("leaves a Markdown file that is not named for a type alone", async () => {
    const verdict = await verdictOf(
      folderOf({
        "acme.recipe.json": definition("acme.recipe"),
        "README.md": "About these types.",
        "notes.md": "x",
        ".acme.hidden.md": "x",
      }),
      0,
    );
    expect(verdict).toMatchObject({ ok: true, checked: 1, refused: 0 });
  });
});

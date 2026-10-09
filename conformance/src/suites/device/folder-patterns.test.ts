import { afterEach, expect, it } from "vitest";
import type { FolderSettings } from "../../device/cli-adapter.js";
import { folderHarness, type FolderHarness } from "./harness.js";

const harnesses: FolderHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.stop();
});

async function scanned(names: string[], settings: FolderSettings = {}) {
  const harness = await folderHarness("patterns", {
    settings: { search: { types: ["core.note"] }, ...settings },
    files: Object.fromEntries(names.map((name) => [name, "a note\n"])),
  });
  harnesses.push(harness);
  const scan = await harness.folder.scan();
  expect(scan.ok, JSON.stringify(scan)).toBe(true);
  const status = await harness.folder.status();
  expect(status.ok, JSON.stringify(status)).toBe(true);
  if (!scan.ok || !status.ok)
    throw new Error("the folder could not be scanned");
  const paths = status.value.files.map((file) => file.path).sort();
  expect(scan.value.created).toBe(paths.length);
  const queue = await harness.folder.device().queue();
  expect(queue.ok, JSON.stringify(queue)).toBe(true);
  expect(
    queue.ok && queue.value.filter((write) => write.kind === "create_item"),
  ).toHaveLength(paths.length);
  return paths;
}

async function witness(names: string[]) {
  const directories = names.flatMap((name) =>
    name.split("/").filter((part) => part.startsWith(".")),
  );
  expect(
    await scanned(names, {
      include: ["*", ...directories.map((name) => `${name}/`)],
    }),
  ).toEqual([...names].sort());
}

it.each(["[A-z]", "[Z-a]"])(
  "keeps the members of the %s range in include patterns",
  async (range) => {
    const names = ["_note.md", "5-note.md"];
    await witness(names);
    expect(await scanned(names, { include: [`${range}*.md`] })).toEqual([
      "_note.md",
    ]);
  },
);

it.each(["[A-z]", "[Z-a]"])(
  "keeps the members of the %s range in ignore patterns",
  async (range) => {
    const names = ["_note.md", "5-note.md"];
    await witness(names);
    expect(await scanned(names, { ignore: [`${range}*.md`] })).toEqual([
      "5-note.md",
    ]);
  },
);

it.each(["[A-z]", "[Z-a]"])(
  "keeps the members of the %s range when entering dot directories",
  async (range) => {
    const names = [".`notes/inside.md", ".5-notes/outside.md", "witness.md"];
    await witness(names);
    expect(
      await scanned(names, { include: ["witness.md", `.${range}notes/**`] }),
    ).toEqual([".`notes/inside.md", "witness.md"]);
  },
);

it.each(["include", "ignore", "dot directory"])(
  "preserves wildcard matches alongside Unicode equivalence in %s patterns",
  async (kind) => {
    const names =
      kind === "dot directory"
        ? [".İ/inside.md", ".other/outside.md", "witness.md"]
        : ["İ.md", "other.md", "witness.md"];
    await witness(names);
    const settings =
      kind === "include"
        ? { include: ["??.md", "witness.md"] }
        : kind === "ignore"
          ? { ignore: ["??.md"] }
          : { include: [".??/**", "witness.md"] };
    expect(await scanned(names, settings)).toEqual(
      kind === "ignore"
        ? ["other.md", "witness.md"]
        : kind === "include"
          ? ["witness.md", "İ.md"]
          : [".İ/inside.md", "witness.md"],
    );
  },
);

it.each(["include", "ignore"] as const)(
  "resolves %s negations in line order across original and equivalent names",
  async (kind) => {
    const names = ["İ.md", "witness.md"];
    await witness(names);
    const extra = kind === "include" ? ["witness.md"] : [];
    const lastNegative = ["??.md", "!i\u0307.md", ...extra];
    const lastPositive = ["!i\u0307.md", "??.md", ...extra];
    expect(await scanned(names, { [kind]: lastNegative })).toEqual(
      kind === "include" ? ["witness.md"] : ["witness.md", "İ.md"],
    );
    expect(await scanned(names, { [kind]: lastPositive })).toEqual(
      kind === "include" ? ["witness.md", "İ.md"] : ["witness.md"],
    );
  },
);

it("resolves an equivalent file pattern before a matching parent pattern", async () => {
  const names = ["İ/keep.md", "İ/other.md", "witness.md"];
  await witness(names);
  expect(
    await scanned(names, {
      include: ["!i\u0307/keep.md", "??/", "witness.md"],
    }),
  ).toEqual(["witness.md", "İ/other.md"]);
  expect(
    await scanned(names, {
      include: ["i\u0307/keep.md", "!??/", "witness.md"],
    }),
  ).toEqual(["witness.md", "İ/keep.md"]);
  expect(await scanned(names, { ignore: ["i\u0307/keep.md", "!??/"] })).toEqual(
    ["witness.md", "İ/other.md"],
  );
});

it("matches escaped brackets and Unicode literals without turning them into classes", async () => {
  const names = ["[Cafe\u0301].md", "C.md", "witness.md"];
  await witness(names);
  expect(
    await scanned(names, { include: ["\\[CAFÉ\\].md", "witness.md"] }),
  ).toEqual(["[Cafe\u0301].md", "witness.md"]);
  expect(await scanned(names, { ignore: ["\\[CAFÉ\\].md"] })).toEqual([
    "C.md",
    "witness.md",
  ]);
});

it.each([
  { position: "letter", pattern: "\\J\u030c" },
  { position: "combining mark", pattern: "J\\\u030c" },
])(
  "folds Unicode literals with an escape on the $position",
  async ({ pattern }) => {
    const names = ["ǰ.md", "witness.md"];
    await witness(names);
    expect(
      await scanned(names, { include: [`${pattern}.md`, "witness.md"] }),
    ).toEqual(["witness.md", "ǰ.md"]);
    expect(await scanned(names, { ignore: [`${pattern}.md`] })).toEqual([
      "witness.md",
    ]);
    const dotted = [".ǰ/inside.md", ".other/outside.md", "witness.md"];
    await witness(dotted);
    expect(
      await scanned(dotted, { include: [`.${pattern}/**`, "witness.md"] }),
    ).toEqual([".ǰ/inside.md", "witness.md"]);
  },
);

it.each(["include", "ignore"] as const)(
  "matches a class or a ? against one character outside ASCII in %s patterns",
  async (kind) => {
    const names = [
      "caf\u00e9.md",
      "cafe\u0301 2.md",
      "caf\u00e8.md",
      "cafe.md",
      "witness.md",
    ];
    await witness(names);
    const listed = (pattern: string) =>
      scanned(names, {
        [kind]: kind === "include" ? [pattern, "witness.md"] : [pattern],
      });
    const named = (members: string[]) =>
      kind === "include"
        ? [...members, "witness.md"].sort()
        : names.filter((name) => !members.includes(name)).sort();
    expect(await listed("caf[\u00e9\u00e8]*.md")).toEqual(
      named(["caf\u00e9.md", "cafe\u0301 2.md", "caf\u00e8.md"]),
    );
    expect(await listed("caf[\u00e0-\u00ea].md")).toEqual(
      named(["caf\u00e9.md", "caf\u00e8.md"]),
    );
    expect(await listed("CAF[\u00c9]*.md")).toEqual(
      named(["caf\u00e9.md", "cafe\u0301 2.md"]),
    );
    expect(await listed("caf[!\u00e9].md")).toEqual(
      named(["caf\u00e8.md", "cafe.md"]),
    );
    expect(await listed("caf?.md")).toEqual(
      named(["caf\u00e9.md", "caf\u00e8.md", "cafe.md"]),
    );
  },
);

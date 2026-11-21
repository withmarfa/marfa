import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempFolder } from "../../utils/temp-folder.js";
import { NO_KEYCHAIN, marfa } from "./types-scaffold.shared.js";

/**
 * A plugin's source folder judged, built into a bundle and listed in an
 * index, by the binary with no server.
 */

interface Verdict {
  ok: boolean;
  problems: { path: string; code: string; message: string }[];
  types: {
    file: string;
    id: string | null;
    ok: boolean;
    problems: { path: string; code: string; message: string }[];
  }[];
}

const manifest = {
  name: "tickets",
  title: "Tickets",
  description: "Tickets for tracking work.",
  mark: "lucide:ticket",
  maker: "Marfa",
  marfa: "0.0.1",
};

const definition = (id: string) =>
  JSON.stringify({
    id,
    parent: "core.task",
    description: "A piece of work someone asked for.",
    fields: { reporter: { type: "string" } },
  });

/** A source folder with `plugin.json` and each of `types` in `types/`. */
function source(types: Record<string, string>, extra: object = {}): string {
  const folder = tempFolder("marfa-plugin-check-");
  mkdirSync(join(folder, "types"));
  mkdirSync(join(folder, "edge-types"));
  writeFileSync(
    join(folder, "plugin.json"),
    JSON.stringify({ ...manifest, ...extra }),
  );
  for (const [name, content] of Object.entries(types)) {
    writeFileSync(join(folder, "types", name), content);
  }
  writeFileSync(
    join(folder, "edge-types", "blocks.json"),
    JSON.stringify({ id: "blocks", cardinality: "many-to-many" }),
  );
  return folder;
}

describe("a plugin's source folder from the terminal", () => {
  it("judges a source folder as installing would: takes common.ticket and refuses user.ticket, which types check takes", async () => {
    const common = source({
      "common.ticket.json": definition("common.ticket"),
    });
    const passed = await marfa(
      ["--json", "plugins", "check", common],
      NO_KEYCHAIN,
    );
    expect(passed.code, passed.stderr).toBe(0);
    const verdict = JSON.parse(passed.stdout) as Verdict;
    expect(verdict).toMatchObject({ ok: true, problems: [] });
    expect(verdict.types).toEqual([
      expect.objectContaining({ file: "types/common.ticket.json", ok: true }),
    ]);

    const owned = source({ "user.ticket.json": definition("user.ticket") });
    const refused = await marfa(
      ["--json", "plugins", "check", owned],
      NO_KEYCHAIN,
    );
    expect(refused.code).toBe(1);
    const said = JSON.parse(refused.stdout) as Verdict;
    expect(said.types[0]?.problems).toEqual([
      expect.objectContaining({ path: "id", code: "forbidden" }),
    ]);
    // The witness: `types check` judges the same definition as `POST /types` does, and takes it.
    const asRegistered = await marfa(
      ["--json", "types", "check", join(owned, "types")],
      NO_KEYCHAIN,
    );
    expect(asRegistered.code, asRegistered.stdout).toBe(0);
  });

  it("refuses an edge type that redefines a shipped one, or names a shipped edge as its reverse, as installing does", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["about", { id: "about", cardinality: "many-to-many" }, "conflict"],
      [
        "cites",
        { id: "cites", cardinality: "many-to-many", reverse_name: "about" },
        "conflict",
      ],
      [
        "Bad_Name",
        { id: "Bad_Name", cardinality: "many-to-many" },
        "validation_error",
      ],
    ];
    for (const [id, edge, code] of cases) {
      const folder = source({
        "common.ticket.json": definition("common.ticket"),
      });
      writeFileSync(
        join(folder, "edge-types", `${id}.json`),
        JSON.stringify(edge),
      );
      const refused = await marfa(
        ["--json", "plugins", "check", folder],
        NO_KEYCHAIN,
      );
      expect(refused.code, id).toBe(1);
      const verdict = JSON.parse(refused.stdout) as Verdict;
      expect(verdict.problems, id).toEqual([expect.objectContaining({ code })]);
    }
  });

  it("refuses a plugin.json that names a version, which a release stamps from its tag", async () => {
    const folder = source(
      { "common.ticket.json": definition("common.ticket") },
      { version: "1.0.0" },
    );
    const refused = await marfa(
      ["--json", "plugins", "check", folder],
      NO_KEYCHAIN,
    );
    expect(refused.code).toBe(1);
    const verdict = JSON.parse(refused.stdout) as Verdict;
    expect(verdict.problems).toEqual([
      expect.objectContaining({ path: "plugin.json: version" }),
    ]);
  });

  it("builds a source folder into a bundle stamped with its version, and writes an index naming its SHA-256", async () => {
    const folder = source({
      "common.ticket.json": definition("common.ticket"),
      "common.ticket.md": "File one per request.\n",
    });
    const out = tempFolder("marfa-plugin-bundle-");
    const built = await marfa(
      [
        "--json",
        "plugins",
        "bundle",
        folder,
        "--version",
        "1.4.0",
        "--output",
        out,
      ],
      NO_KEYCHAIN,
    );
    expect(built.code, built.stderr).toBe(0);
    const bytes = readFileSync(join(out, "tickets.plugin.json"));
    const bundle = JSON.parse(bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(bundle).toMatchObject({
      format: 1,
      name: "tickets",
      version: "1.4.0",
      types: [
        expect.objectContaining({
          id: "common.ticket",
          guidance: "File one per request.",
        }),
      ],
      edge_types: [{ id: "blocks", cardinality: "many-to-many" }],
    });
    const indexed = await marfa(
      ["--json", "plugins", "index", out],
      NO_KEYCHAIN,
    );
    expect(indexed.code, indexed.stderr).toBe(0);
    const index = JSON.parse(
      readFileSync(join(out, "plugins.json"), "utf8"),
    ) as { format: number; plugins: Record<string, unknown>[] };
    expect(index).toEqual({
      format: 1,
      plugins: [
        {
          ...manifest,
          version: "1.4.0",
          has_connector: false,
          bundle: "tickets.plugin.json",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    });
  });
});

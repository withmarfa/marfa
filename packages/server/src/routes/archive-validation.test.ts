import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiskReserve } from "../storage/disk-space.js";
import {
  runArchiveValidation,
  SelectionRefusal,
} from "./archive-validation.js";
import { ExportSpool } from "./export-spool.js";

let dir: string;
let spool: ExportSpool;
let reserve: DiskReserve;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marfa-archive-validation-"));
  reserve = new DiskReserve(dir, 0);
  spool = new ExportSpool(() => join(dir, randomUUID()), reserve);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await spool.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const idAt = (n: number) =>
  `01912345-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const edgeIdAt = (n: number) =>
  `01912347-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

/** Line files for `items` notes and the given edges, in that order. */
function selection(
  items: number,
  edges: Iterable<[source: number, target: number, type: string]>,
) {
  const itemLines: string[] = [];
  for (let n = 1; n <= items; n++)
    itemLines.push(
      JSON.stringify({
        item: {
          id: idAt(n),
          type: "core.note",
          properties: { body: `note ${String(n)}` },
        },
      }),
    );
  const edgeLines: string[] = [];
  let at = 0;
  for (const [source, target, type] of edges)
    edgeLines.push(
      JSON.stringify({
        edge: {
          id: edgeIdAt(++at),
          source_id: idAt(source),
          target_id: idAt(target),
          edge_type: type,
        },
      }),
    );
  const write = (name: string, lines: string[]) => {
    const path = join(dir, name);
    writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
    return path;
  };
  return {
    "items.ndjson": write("items.ndjson", itemLines),
    "edges.ndjson": write("edges.ndjson", edgeLines),
    "types.ndjson": write("types.ndjson", []),
  };
}

async function validate(lineFiles: ReturnType<typeof selection>) {
  await runArchiveValidation(
    {
      lineFiles,
      maxRowBytes: 16 * 1024 * 1024,
      database: await spool.database(),
    },
    reserve,
    new AbortController().signal,
  );
}

it("takes a parent with more children than a call's arguments can carry", async () => {
  const children = 130_000;
  await validate(
    selection(
      children + 2,
      (function* () {
        for (let n = 3; n <= children + 2; n++)
          yield [1, n, "parent-of"] as [number, number, string];
        // The edge into the parent is what reaches all its children at once.
        yield [2, 1, "parent-of"] as [number, number, string];
      })(),
    ),
  );
}, 120_000);

it("checks a supersedes chain written in creation order in linear work", async () => {
  const versions = 4_000;
  const look = vi.spyOn(reserve, "look");
  await validate(
    selection(
      versions,
      (function* () {
        for (let n = 1; n < versions; n++)
          yield [n + 1, n, "supersedes"] as [number, number, string];
      })(),
    ),
  );
  // One turn per 100 lines read, and a few for the cycle check: a walk down
  // the chain for each edge takes a turn per 100 steps, 80,000 here.
  expect(look.mock.calls.length).toBeLessThan(200);
}, 120_000);

it("refuses a cycle as restore skips it, naming the edge that closes it", async () => {
  const refused = await validate(
    selection(5, [
      [2, 1, "supersedes"],
      [4, 3, "parent-of"],
      [3, 2, "supersedes"],
      [1, 3, "supersedes"],
      [5, 4, "supersedes"],
    ]),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(SelectionRefusal);
  expect((refused as SelectionRefusal).row).toEqual({
    kind: "edge",
    id: edgeIdAt(4),
    type: "supersedes",
    field: null,
    code: "edge_cycle",
    message: 'Edge "supersedes" would close a cycle',
  });
});

it("names the item a restore refuses, with its type, field and code", async () => {
  const lineFiles = selection(3, []);
  writeFileSync(
    lineFiles["items.ndjson"],
    `${JSON.stringify({ item: { id: idAt(1), type: "core.note", properties: { body: "one" } } })}\n${JSON.stringify({ item: { id: idAt(2), type: "core.note", properties: {} } })}\n`,
  );
  const refused = await validate(lineFiles).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(SelectionRefusal);
  expect((refused as SelectionRefusal).row).toMatchObject({
    kind: "item",
    id: idAt(2),
    type: "core.note",
    field: "properties.body",
    code: "invalid_properties",
  });
});

it("keeps what it has judged in the scratch database, not in memory", async () => {
  await validate(
    selection(300, [
      [1, 2, "references"],
      [2, 3, "parent-of"],
    ]),
  );
  const database = await spool.database();
  const counted = async (table: string) =>
    Number(
      (await database.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n,
    );
  expect(await counted("check_items")).toBe(300);
  expect(await counted("check_edges")).toBe(2);
});

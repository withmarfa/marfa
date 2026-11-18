import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCRIPTED_INSTANCE,
  answers,
  wireItem,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import type { Outcome } from "../../device/protocol.js";
import { BUILT_FOR } from "../../device/scripted-server.js";
import {
  folderHarness,
  scriptHydration,
  startHarness,
  type FolderHarness,
  type Harness,
} from "./harness.js";
import {
  EdgeDoor,
  scriptFolderWrites,
  sentEdgeWrites,
} from "./folders.shared.js";

const REPLACED = "00000000-0000-7000-8000-0000000000ff";
const ITEM = "01a00000-0000-7000-8000-00000000000a";
const LINKED = "01a00000-0000-7000-8000-00000000e106";
const OTHER_LINKED = "01a00000-0000-7000-8000-00000000e107";

let harness: Harness | undefined;
let folder: FolderHarness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  await folder?.stop();
  folder = undefined;
});

function value<T>(outcome: Outcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(outcome.refusal.raw);
  return outcome.value;
}

const ROWS: [string[], unknown] = [
  ["list", ITEM, "steps"],
  { data: [], next_cursor: null },
];
const ROW: [string[], unknown] = [
  ["get", ITEM, "steps", "r1"],
  { id: "r1", values: {}, updated_at: "2026-01-01T00:00:00.000Z" },
];
const TOTALS: [string[], unknown] = [
  ["totals", ITEM, "steps"],
  { row_count: 0, totals: {} },
];

async function refusesAnotherInstance([args, body]: [string[], unknown]) {
  harness = await startHarness("server-reads-table");
  const { server, device } = harness;
  let instance = SCRIPTED_INSTANCE;
  server.copyAnswer("GET", "/", () =>
    answers.root(Number(BUILT_FOR), instance),
  );
  scriptHydration(server, {
    head: "10",
    items: {
      "core.note": [
        { item: { id: ITEM, properties: { title: "held", body: "held" } } },
      ],
    },
    instance: () => instance,
  });
  server.copyAnswer("GET", new RegExp(`^/items/${ITEM}/tables/steps/`), {
    kind: "json",
    status: 200,
    body: body as Record<string, unknown>,
  });
  value(await device.hydrate(["core.note"], "library"));
  const reached = () =>
    server.requests.filter((request) =>
      request.pathname.startsWith(`/items/${ITEM}/tables/`),
    ).length;

  const read = value(await device.tableRead<object>(args));
  expect(read).toMatchObject({ held: false });
  expect(reached()).toBe(1);

  instance = REPLACED;
  const refused = await device.tableRead<object>(args);
  expect(
    refused.ok,
    "a read sent an item id to another instance at the same address",
  ).toBe(false);
  if (!refused.ok) {
    expect(refused.refusal.code).toBe("copy_expired");
    expect(refused.refusal.raw).toContain(REPLACED);
  }
  expect(reached(), "an item id reached the other instance").toBe(1);
  const status = await device.status();
  expect(status.ok ? status.value.hydration : status).toBe("expired");
}

describe("a table read from the server", () => {
  it("sends no item id to another instance its root names at the copy's own address, and expires the copy: rows", () =>
    refusesAnotherInstance(ROWS));
  it("sends no item id to another instance its root names at the copy's own address, and expires the copy: a row", () =>
    refusesAnotherInstance(ROW));
  it("sends no item id to another instance its root names at the copy's own address, and expires the copy: totals", () =>
    refusesAnotherInstance(TOTALS));
});

describe("a link by id looked up on the server", () => {
  it("sends no item id to another instance its root names at the copy's own address", async () => {
    const titled = (id: string, title: string): WireItemOptions => ({
      id,
      properties: { title, body: `${title}\n` },
    });
    let instance = SCRIPTED_INSTANCE;
    folder = await folderHarness("server-reads-link", {
      items: {
        "core.note": [
          { item: titled("01a00000-0000-7000-8000-00000000e104", "Alpha") },
        ],
      },
      edges: { "parent-of": [], "attached-to": [] },
    });
    const { server, dir } = folder;
    server.copyAnswer("GET", "/", () =>
      answers.root(Number(BUILT_FOR), instance),
    );
    for (const id of [LINKED, OTHER_LINKED])
      server.copyAnswer("GET", `/items/${id}`, () =>
        answers.updated(wireItem({ id, type: "core.bookmark" })),
      );
    scriptFolderWrites(folder, { edges: new EdgeDoor() });
    const put = (name: string, text: string) => {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), text);
    };
    const asked = (id: string) =>
      server.requests.filter((request) => request.pathname === `/items/${id}`)
        .length;

    put("One.md", `---\nabout: "[[${LINKED}]]"\n---\none\n`);
    value(await folder.folder.push());
    expect(asked(LINKED)).toBe(1);
    expect(sentEdgeWrites(folder).length).toBe(1);

    instance = REPLACED;
    put("Two.md", `---\nabout: "[[${OTHER_LINKED}]]"\n---\ntwo\n`);
    const refused = await folder.folder.push();
    expect(refused.ok, "a link was looked up at another instance").toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("copy_expired");
    expect(asked(OTHER_LINKED), "an item id reached the other instance").toBe(
      0,
    );
  });
});

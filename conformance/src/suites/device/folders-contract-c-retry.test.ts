import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  writeAnswers,
  refusal,
  copyItemEvent,
  copyReplay,
  edgeEvent,
  wireEdge,
  wireItem,
  type WireItemOptions,
  type WireEdgeOptions,
} from "../../device/marfa-answers.js";
import { ScriptedServer, type SseFrame } from "../../device/scripted-server.js";
import {
  folderHarness,
  folderItem,
  KEY,
  scriptFolderRow,
  scriptHydration,
  type FolderHarness,
} from "./harness.js";

const item = (n: number): WireItemOptions => ({
  id: `01a00000-0000-7000-8000-${String(n).padStart(12, "0")}`,
  properties: { title: `Note${String(n)}`, body: "original\n" },
});
const folders: FolderHarness[] = [];
let server: ScriptedServer | undefined;
afterEach(async () => {
  delete process.env.MARFA_TEST_FAULT;
  try {
    for (const folder of folders.splice(0)) await folder.stop();
  } finally {
    await server?.stop();
    server = undefined;
  }
});

async function setup(items: WireItemOptions[]) {
  server = await ScriptedServer.start();
  const settings = scriptFolderRow(server, {
    search: { types: ["core.note"] },
  });
  const edges: WireEdgeOptions[] = items.map((row, index) => ({
    id: `01a00000-0000-7000-8000-${String(100 + index).padStart(12, "0")}`,
    source_id: row.id,
    target_id: settings.id,
    edge_type: "in-folder",
    properties: { path: `Note${String(index + 1)}.md` },
  }));
  const frames: SseFrame[] = [];
  scriptHydration(server, {
    head: "1",
    rows: { "core.note": items.map((item) => ({ item })) },
    edges: { "in-folder": edges },
  });
  const folder = await folderHarness("contract-c-effects", {
    sharing: { server, key: KEY },
    folder: settings,
    events: [
      (request) =>
        copyReplay(
          String(frames.length + 1),
          frames.filter(
            (frame) =>
              Number(frame.id) > Number(request.headers["last-event-id"] ?? 0),
          ),
        ),
    ],
  });
  folders.push(folder);
  server.answer("POST", "/edges", (request) => {
    const edge = {
      ...(JSON.parse(request.body) as WireEdgeOptions),
      version: 1,
    };
    const index = items.findIndex((item) => item.id === edge.source_id);
    if (index >= 0) edges[index] = { ...edges[index], ...edge };
    return writeAnswers.edge(edge, 201);
  });
  server.copyAnswer("GET", /^\/edges\/[^/]+$/, (request) => {
    const edge = edges.find((edge) => request.pathname === `/edges/${edge.id}`);
    return edge
      ? writeAnswers.edge(edge)
      : refusal(404, "edge_not_found", "Edge not found");
  });
  const initial = await folder.folder.pull();
  expect(initial.ok && initial.value.written).toBe(items.length);
  const drained = await folder.folder.device().drain();
  expect(drained.ok, JSON.stringify(drained)).toBe(true);
  expect(
    drained.ok && drained.value.verdicts.map((row) => row.verdict),
  ).toEqual(items.map(() => "accepted"));
  return { folder, edges, frames, settings };
}

async function retried(folder: FolderHarness) {
  process.env.MARFA_TEST_FAULT = "copy-changes-after-pull-effects";
  try {
    const result = await folder.folder.pull();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(result.refusal.raw);
    return result.value;
  } finally {
    delete process.env.MARFA_TEST_FAULT;
  }
}

describe("completed effects of a restarted folder pull", () => {
  it("retains rewrite and move counts across a restart", async () => {
    const row = item(1);
    const { folder, edges, frames } = await setup([row]);
    frames.push(
      copyItemEvent(
        "2",
        "item.updated",
        wireItem({
          ...row,
          version: 2,
          properties: { ...row.properties, body: "changed\n" },
        }),
      ),
      edgeEvent(
        "3",
        "edge.updated",
        wireEdge({
          ...edges[0],
          version: 2,
          properties: { path: "Moved.md" },
        }),
      ),
    );
    expect((await folder.folder.device().catchUp()).ok).toBe(true);
    const report = await retried(folder);
    expect([report.rewritten, report.moved, report.unchanged]).toEqual([
      1, 1, 1,
    ]);
    expect(readFileSync(join(folder.dir, "Moved.md"), "utf8")).toContain(
      "changed",
    );
    expect(existsSync(join(folder.dir, "Note1.md"))).toBe(false);
  });

  it("retains revival counts across a restart", async () => {
    const row = item(1);
    const { folder, frames } = await setup([row]);
    rmSync(join(folder.dir, "Note1.md"));
    const scan = await folder.folder.scan();
    expect(scan.ok && scan.value.missing).toBe(1);
    frames.push(
      copyItemEvent(
        "2",
        "item.updated",
        wireItem({
          ...row,
          version: 2,
          properties: { ...row.properties, body: "restored\n" },
        }),
      ),
    );
    expect((await folder.folder.device().catchUp()).ok).toBe(true);
    const report = await retried(folder);
    expect([report.revived, report.rewritten, report.unchanged]).toEqual([
      1, 1, 1,
    ]);
    expect(readFileSync(join(folder.dir, "Note1.md"), "utf8")).toContain(
      "restored",
    );
  });

  it("retains removal, purge and placement-end counts across a restart", async () => {
    const [trashed, purged, kept] = [item(1), item(2), item(3)];
    const { folder, frames } = await setup([trashed, purged, kept]);
    frames.push(
      copyItemEvent(
        "2",
        "item.deleted",
        wireItem({ ...trashed, state: "trashed", version: 2 }),
      ),
      copyItemEvent(
        "3",
        "item.purged",
        wireItem({ ...purged, state: "trashed" }),
      ),
    );
    expect((await folder.folder.device().catchUp()).ok).toBe(true);
    const report = await retried(folder);
    expect([
      report.removed,
      report.purged,
      report.ended,
      report.unchanged,
    ]).toEqual([2, 1, 1, 1]);
    expect(existsSync(join(folder.dir, "Note1.md"))).toBe(false);
    expect(existsSync(join(folder.dir, "Note2.md"))).toBe(false);
    expect(readFileSync(join(folder.dir, "Note3.md"), "utf8")).toContain(
      "original",
    );
    const queue = await folder.folder.device().queue();
    expect(
      queue.ok && queue.value.filter((write) => write.kind === "delete_edge"),
    ).toHaveLength(1);
  });

  it.each(["out", "in"] as const)(
    "retains transfer-%s counts across a restart",
    async (direction) => {
      const row = item(1);
      const { folder, frames, settings } = await setup([row]);
      const otherSettings = scriptFolderRow(server!, {
        search: { types: ["core.note"] },
      });
      const other = await folderHarness("contract-c-transfer", {
        sharing: { server: server!, key: KEY },
        folder: otherSettings,
        registry: folder.registry,
      });
      folders.push(other);
      if (direction === "out")
        expect((await other.folder.pull()).ok).toBe(true);
      settings.settings.search = {
        types: ["core.note"],
        filter: 'tags contains "a"',
      };
      settings.version = 2;
      frames.push(copyItemEvent("2", "item.updated", folderItem(settings)));
      expect((await folder.folder.device().catchUp()).ok).toBe(true);
      if (direction === "out") {
        const left = await retried(folder);
        expect([left.let_go, left.ended], JSON.stringify(left)).toEqual([1, 1]);
      } else {
        const arrived = await retried(other);
        expect(
          [arrived.taken, arrived.unchanged],
          JSON.stringify(arrived),
        ).toEqual([1, 1]);
      }
      expect(readFileSync(join(other.dir, "Note1.md"), "utf8")).toContain(
        "original",
      );
      expect(existsSync(join(folder.dir, "Note1.md"))).toBe(false);
    },
  );

  it("ends the placement of a missing file already trashed on another device", async () => {
    const row = item(1);
    const { folder, frames } = await setup([row]);
    rmSync(join(folder.dir, "Note1.md"));
    expect((await folder.folder.scan()).ok).toBe(true);
    frames.push(
      copyItemEvent(
        "2",
        "item.deleted",
        wireItem({ ...row, state: "trashed", version: 2 }),
      ),
    );
    expect((await folder.folder.device().catchUp()).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 6000));
    expect((await folder.folder.scan()).ok).toBe(true);
    const queue = await folder.folder.device().queue();
    expect(
      queue.ok &&
        queue.value
          .filter((write) => write.kind === "delete_edge")
          .map((write) => write.target_id),
    ).toEqual([folder.settings.id]);
    expect(
      queue.ok && queue.value.filter((write) => write.kind === "delete_item"),
    ).toEqual([]);
    const status = await folder.folder.status();
    expect(status.ok && status.value.files).toEqual([]);
  });
});

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  answers,
  copyLiveReplay,
  edgeEvent,
  edgesPage,
  refusal,
  edgeType,
  edgeTypeCatalog,
  wireEdge,
} from "../../device/marfa-answers.js";
import type { Answer, Responder } from "../../device/scripted-server.js";
import type { WireItemOptions } from "../../device/marfa-answers.js";
import { folderHarness } from "./harness.js";
import {
  bindingFolderHarness,
  openBindingFolder,
  folderTold,
  type BindingFolderHarness,
} from "./binding-folders.shared.js";
import { untilHeld } from "./binding.shared.js";
import {
  EdgeDoor,
  put,
  scriptFolderChanges,
  scriptFolderWrites,
  settingsFile,
} from "./folders.shared.js";

let harness: BindingFolderHarness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** The folder's receive is armed after its preceding pass has left the hold. */
async function advanceWatch(
  own: BindingFolderHarness,
  elapsed: number,
): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(
        (await own.device.clock.waits()).some((wait) => wait.askedMs === 1_000),
        "the folder has not armed its next receive",
      ).toBe(true);
    },
    { timeout: 10_000, interval: 20 },
  );
  await own.device.clock.advance(elapsed);
  await untilHeld(own.device, "folder-pass-ended");
}

/** A separate turn hold prevents the prior pass's waiter satisfying the next pass. */
async function nextPass(
  own: BindingFolderHarness,
  elapsed: number,
): Promise<void> {
  await own.device.hooks.hold("folder-watch-turn");
  await own.device.hooks.release("folder-pass-ended");
  await untilHeld(own.device, "folder-watch-turn");
  await own.device.hooks.hold("folder-pass-ended");
  await own.device.hooks.release("folder-watch-turn");
  await advanceWatch(own, elapsed);
}

async function startPasses(own: BindingFolderHarness): Promise<void> {
  await own.device.hooks.hold("folder-watch-turn");
  await own.device.hooks.hold("folder-pass-ended");
  const watch = await own.bound.watch();
  await folderTold(watch, "watching");
  await untilHeld(own.device, "folder-watch-turn");
  await own.device.hooks.release("folder-watch-turn");
  await advanceWatch(own, 5_000);
}

describe("folder settings and retained directory identity", () => {
  it("refuses a settings-file submission while first sync waits, then submits the same edit once confirmed", async () => {
    harness = await bindingFolderHarness("binding-folder-first-settings", {
      confirm: false,
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-000000001603",
              properties: { title: "Pending", body: "words\n" },
            },
          },
        ],
      },
    });
    const sent = scriptFolderChanges(harness);
    writeFileSync(
      settingsFile(harness),
      "title: folder\nsearch:\n  types:\n    - core.note\ninclude:\n  - '*.md'\n",
    );
    expect((await harness.bound.testOpen()).ok).toBe(true);
    const refused = await harness.bound.testSubmitSettingsFile();
    expect(refused.ok, JSON.stringify(refused)).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("first_sync_waiting");
    expect(sent).toEqual([]);
    expect((await harness.bound.testClose()).ok).toBe(true);
    expect((await harness.bound.confirmFirstSync()).ok).toBe(true);
    expect((await harness.bound.testOpen()).ok).toBe(true);
    const submitted = await harness.bound.testSubmitSettingsFile();
    expect(
      submitted.ok && submitted.value.sent,
      JSON.stringify(submitted),
    ).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("reports root_gone when a retained folder's directory is replaced before its pull", async () => {
    harness = await bindingFolderHarness("binding-folder-root-gone");
    expect((await harness.bound.testOpen()).ok).toBe(true);
    const before = await harness.bound.testPull();
    expect(
      before.ok && before.value.rootGone,
      JSON.stringify(before),
    ).toBeUndefined();
    renameSync(harness.dir, `${harness.dir}-moved`);
    mkdirSync(harness.dir);
    put(harness, "untouched.md", "replacement directory\n");
    const pulled = await harness.bound.testPull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (pulled.ok) expect(pulled.value.rootGone).toEqual(expect.any(String));
  });
});

describe("placement retries on the folder clock", () => {
  it.each([false, true])(
    "suppresses a refused placement's key reread before sixty seconds and reads again afterwards, including failed reads (%s)",
    async (failed) => {
      let key: Answer = answers.currentKey("fixture-key", { "*": "write" });
      const edges = new EdgeDoor();
      edges.placing = (edge) =>
        edge.edge_type === "in-folder"
          ? refusal(403, "edge_permission_denied", "Write access denied")
          : undefined;
      harness = await bindingFolderHarness("binding-folder-key-clock", {
        key: [() => key],
        events: [copyLiveReplay("1", [])],
      });
      scriptFolderWrites(harness, { edges });
      key = answers.currentKey("fixture-key", { references: "write" });
      put(harness, "one.md", "---\ntitle: One\n---\nwords\n");
      const reads = () =>
        harness!.server.requests.filter(
          (request) =>
            request.method === "GET" && request.pathname === "/keys/current",
        ).length;
      const before = reads();
      await startPasses(harness);
      expect(reads()).toBeGreaterThan(before);
      const first = reads();
      if (failed) key = refusal(503, "unavailable", "Try again");
      await nextPass(harness, 59_999);
      expect(reads(), "a key was read before the minute ended").toBe(first);
      await nextPass(harness, 5_000);
      expect(reads(), "the key was not read after the minute ended").toBe(
        first + 1,
      );
      if (failed) {
        await nextPass(harness, 59_999);
        expect(
          reads(),
          "a failed key read was retried before the minute ended",
        ).toBe(first + 1);
        await nextPass(harness, 5_000);
        expect(reads()).toBe(first + 2);
      }
    },
  );
});

/** A pending local move based on an edge another device has since moved. */
async function movedApart(
  label: string,
  remote = true,
): Promise<{ own: BindingFolderHarness; edges: EdgeDoor; id: string }> {
  const id = "01a00000-0000-7000-8000-000000001601";
  const edgeId = "01a00000-0000-7000-8000-000000001602";
  const edges = new EdgeDoor();
  const item: WireItemOptions = {
    id,
    type: "core.note",
    properties: { title: "Plan", body: "Plan\n" },
  };
  const made = await folderHarness(label, {
    rows: { "core.note": [{ item }] },
    hydrate: false,
    events: [edges.stream()],
  });
  try {
    edges.hold({
      id: edgeId,
      source_id: id,
      target_id: made.settings.id,
      edge_type: "in-folder",
      properties: { path: "Plan.md" },
    });
    item.edges = {
      "in-folder": {
        data: [wireEdge(edges.edges.get(edgeId)!)],
        next_cursor: null,
      },
    };
    scriptFolderWrites(made, { edges });
    expect((await made.folder.hydrate()).ok).toBe(true);
    expect((await made.folder.pull()).ok).toBe(true);
    mkdirSync(join(made.dir, "Local"));
    renameSync(join(made.dir, "Plan.md"), join(made.dir, "Local", "Plan.md"));
    expect((await made.folder.scan()).ok).toBe(true);
    if (remote) {
      edges.relocate(id, made.settings.id, "Remote/Plan.md");
      expect((await made.folder.device().catchUp()).ok).toBe(true);
    }
    const own = await openBindingFolder(made);
    return { own, edges, id };
  } catch (error) {
    await made.stop();
    throw error;
  }
}

describe("give-way reads on the folder clock", () => {
  it("suppresses a failed give-way reread before sixty seconds and reads again afterwards", async () => {
    const moved = await movedApart("binding-folder-give-way-clock");
    harness = moved.own;
    moved.edges.listing = (source) =>
      source === moved.id
        ? refusal(404, "item_not_found", "Refused")
        : undefined;
    const reads = () =>
      harness!.server.requests.filter(
        (request) =>
          request.method === "GET" &&
          request.pathname === `/items/${moved.id}/edges`,
      ).length;
    const before = reads();
    await startPasses(harness);
    expect(reads()).toBe(before + 1);
    const first = reads();
    await nextPass(harness, 59_999);
    expect(reads(), "a give-way read was repeated before a minute").toBe(first);
    await nextPass(harness, 5_000);
    expect(
      reads(),
      "the give-way read was not repeated after sixty seconds",
    ).toBe(first + 1);
  });
});

describe("folder status during catalog replacement", () => {
  it("uses the item and edge catalogs from one revision while a refresh commits between their reads", async () => {
    let changed = false;
    const edgeTypes: Responder = () =>
      edgeTypeCatalog(changed ? [edgeType("custom-links")] : []);
    harness = await bindingFolderHarness("binding-folder-status-catalog", {
      edgeTypes,
      events: [copyLiveReplay("1", [])],
    });
    put(harness, "Note.md", "new note\n");
    const before = await harness.bound.status();
    expect(before.ok, JSON.stringify(before)).toBe(true);
    await harness.device.hooks.hold("folder-status-catalog");
    const reading = harness.bound.status();
    await untilHeld(harness.device, "folder-status-catalog");
    changed = true;
    const refreshed = await harness.folder.device().catchUp();
    expect(refreshed.ok, JSON.stringify(refreshed)).toBe(true);
    await harness.device.hooks.release("folder-status-catalog");
    expect(await reading).toEqual(before);
    expect(
      await harness.device.hooks.reached("folder-status-edge:custom-links"),
      "the status mixed in the new edge catalog",
    ).toBe(0);
    const after = await harness.bound.status();
    expect(after.ok, JSON.stringify(after)).toBe(true);
    expect(
      await harness.device.hooks.reached("folder-status-edge:custom-links"),
      "a subsequent status did not read the new edge catalog",
    ).toBe(1);
  });
});

describe("give-way snapshots", () => {
  it("exposes the accepted placement and withdrawal together while a reader observes the transaction", async () => {
    const moved = await movedApart("binding-folder-give-way-atomic");
    harness = moved.own;
    moved.edges.relocate(moved.id, harness.settings.id, "Accepted/Plan.md");
    expect((await harness.bound.testOpen()).ok).toBe(true);
    await harness.device.hooks.hold("folder-give-way-withdrawn");
    const draining = harness.bound.testDrain();
    await untilHeld(harness.device, "folder-give-way-withdrawn");
    const queued = await harness.folder.device().queue();
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    const pending =
      queued.ok &&
      queued.value.some(
        (row) => row.kind === "update_edge" && row.verdict === "blocked",
      );
    const during = await harness.folder.device().edgesFrom(moved.id);
    expect(
      during.ok && during.value.map((edge) => edge.properties.path),
      "withdrawing the local move exposed a placement older than the accepted read",
    ).toEqual([pending ? "Local/Plan.md" : "Accepted/Plan.md"]);
    await harness.device.hooks.release("folder-give-way-withdrawn");
    expect((await draining).ok).toBe(true);
    const after = await harness.folder.device().edgesFrom(moved.id);
    expect(
      after.ok && after.value.map((edge) => edge.properties.path),
      JSON.stringify(after),
    ).toEqual(["Accepted/Plan.md"]);
    const settled = await harness.folder.device().queue();
    expect(
      settled.ok && settled.value.some((row) => row.kind === "update_edge"),
    ).toBe(false);
  });

  it.each([false, true])(
    "forgets a missing placement only if the copy has not changed since the read began (%s)",
    async (changed) => {
      const moved = await movedApart("binding-folder-give-way-forget");
      harness = moved.own;
      expect((await harness.bound.testOpen()).ok).toBe(true);
      await harness.device.hooks.hold("folder-give-way-read");
      const draining = harness.bound.testDrain();
      await untilHeld(harness.device, "folder-give-way-read");
      const old = [...moved.edges.edges.values()][0]!;
      moved.edges.edges.delete(old.id);
      moved.edges.listing = () => edgesPage([]);
      if (changed) {
        const newer = {
          ...old,
          version: old.version + 1,
          properties: { path: "Newer/Plan.md" },
        };
        moved.edges.events.push(
          edgeEvent(
            String(moved.edges.events.length + 2),
            "edge.updated",
            wireEdge(newer),
          ),
        );
        const caught = await harness.bound.testCatchUp();
        expect(caught.ok, JSON.stringify(caught)).toBe(true);
      }
      await harness.device.hooks.release("folder-give-way-read");
      expect((await draining).ok).toBe(true);
      const held = await harness.folder.device().edgesFrom(moved.id);
      expect(
        held.ok &&
          held.value.map((edge) => [edge.version, edge.properties.path]),
        JSON.stringify(held),
      ).toEqual(changed ? [[old.version + 1, "Newer/Plan.md"]] : []);
    },
  );
});

describe("placement identity across a rename", () => {
  it("keeps the existing placement edge when its file moves, and ends it only when the file is deleted", async () => {
    const moved = await movedApart("binding-folder-placement-lifetime", false);
    harness = moved.own;
    const original = [...moved.edges.edges.values()][0]!;
    expect((await harness.bound.testOpen()).ok).toBe(true);
    const sent = await harness.bound.testDrain();
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    const placed = [...moved.edges.edges.values()].filter(
      (edge) =>
        edge.source_id === moved.id && edge.target_id === harness!.settings.id,
    );
    expect(placed.map((edge) => [edge.id, edge.properties?.path])).toEqual([
      [original.id, "Local/Plan.md"],
    ]);
    expect(
      harness.server.requests.filter(
        (request) =>
          request.method === "DELETE" &&
          request.pathname === `/edges/${original.id}`,
      ),
    ).toEqual([]);
    rmSync(join(harness.dir, "Local", "Plan.md"));
    expect((await harness.bound.testScan()).ok).toBe(true);
    await harness.device.clock.advance(5_000);
    expect((await harness.bound.testScan()).ok).toBe(true);
    expect((await harness.bound.testDrain()).ok).toBe(true);
    expect(
      moved.edges.edges.has(original.id),
      "the final file deletion did not end its placement",
    ).toBe(false);
    expect(
      harness.server.requests.some(
        (request) =>
          request.method === "DELETE" &&
          request.pathname === `/edges/${original.id}`,
      ),
    ).toBe(true);
  });
});

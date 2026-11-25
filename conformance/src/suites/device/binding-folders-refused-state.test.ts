import { renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  copyHeldLog,
  copyItemEvent,
  wireItem,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import type { SseFrame } from "../../device/scripted-server.js";
import {
  bindingFolderHarness,
  type BindingFolderHarness,
} from "./binding-folders.shared.js";
import { untilHeld } from "./binding.shared.js";
import {
  put,
  read,
  scriptFolderWrites,
  sentCreates,
} from "./folders.shared.js";

let harness: BindingFolderHarness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function open(label: string, seed?: WireItemOptions) {
  const events: SseFrame[] = [];
  const own = await bindingFolderHarness(label, {
    items: { "core.note": seed ? [{ item: seed }] : [] },
    events: [copyHeldLog(events)],
  });
  harness = own;
  scriptFolderWrites(own);
  expect(await own.bound.testOpen()).toMatchObject({ ok: true });
  return { own, events };
}

async function scanAcrossTrash(
  own: BindingFolderHarness,
  events: SseFrame[],
  point: string,
  item: () => Promise<WireItemOptions>,
) {
  await own.device.hooks.hold(point);
  const scan = own.bound.testScan();
  try {
    await untilHeld(own.device, point);
    const held = await item();
    events.push(
      copyItemEvent(
        "2",
        "item.trashed",
        wireItem({ ...held, state: "trashed" }),
      ),
    );
    expect(await own.bound.testCatchUp()).toMatchObject({
      ok: true,
      value: { caughtUp: { applied: 1 } },
    });
  } finally {
    await own.device.hooks.release(point);
  }
  return scan;
}

async function expectRefused(
  own: BindingFolderHarness,
  path: string,
  id: string,
) {
  expect(await own.bound.status()).toMatchObject({
    ok: true,
    value: {
      files: [
        {
          path,
          itemId: id,
          flag: "refused",
          reason: expect.stringContaining("state_conflict"),
        },
      ],
    },
  });
}

it("keeps a renamed and edited file bound to the item whose state change was refused", async () => {
  const seed = {
    id: "01a00000-0000-7000-8000-00000000e701",
    state: "archived" as const,
    properties: { title: "Note", body: "my words\n" },
  };
  const { own, events } = await open("refused-state-rename", seed);
  expect(await own.bound.testPull()).toMatchObject({
    ok: true,
    value: { written: 1 },
  });
  const original = read(own, "Note.md");
  expect(original).toContain("state: archived\n");
  const changed = original.replace("state: archived\n", "state: active\n");
  put(own, "Note.md", changed);
  expect(
    await scanAcrossTrash(
      own,
      events,
      `folder-state-decided:${seed.id}`,
      async () => seed,
    ),
  ).toMatchObject({ ok: true });
  await expectRefused(own, "Note.md", seed.id);
  renameSync(join(own.dir, "Note.md"), join(own.dir, "Renamed.md"));
  expect(await own.bound.testScan()).toMatchObject({
    ok: true,
    value: { created: 0 },
  });
  await expectRefused(own, "Renamed.md", seed.id);
  put(own, "Renamed.md", original);
  expect(await own.bound.testScan()).toMatchObject({
    ok: true,
    value: { created: 0 },
  });
  expect(await own.bound.testPull()).toMatchObject({ ok: true });
  await expectRefused(own, "Renamed.md", seed.id);
  expect(read(own, "Renamed.md")).toBe(original);
  unlinkSync(join(own.dir, "Renamed.md"));
  expect(await own.bound.testScan()).toMatchObject({ ok: true });
  const status = await own.bound.status();
  expect(
    status.ok && status.value.files.filter((f) => f.flag === "refused"),
  ).toEqual([]);
});

it("binds a new file whose initial archive is refused and creates its item only once", async () => {
  const { own, events } = await open("refused-initial-archive");
  const text = "---\nstate: archived\n---\nmy words\n";
  put(own, "New.md", text);
  const scanned = await scanAcrossTrash(
    own,
    events,
    "folder-initial-archive:New.md",
    async () => {
      expect(await own.bound.testDrain()).toMatchObject({ ok: true });
      const creates = sentCreates(own);
      expect(creates).toHaveLength(1);
      return {
        id: String(creates[0]!.id),
        properties: { title: "New", body: "my words\n" },
      };
    },
  );
  expect(scanned).toMatchObject({ ok: true, value: { created: 1 } });
  const id = String(sentCreates(own)[0]!.id);
  await expectRefused(own, "New.md", id);
  expect(await own.bound.testScan()).toMatchObject({
    ok: true,
    value: { created: 0 },
  });
  expect(await own.bound.testDrain()).toMatchObject({ ok: true });
  expect(sentCreates(own)).toHaveLength(1);
  await expectRefused(own, "New.md", id);
  expect(read(own, "New.md")).toBe(text);
});

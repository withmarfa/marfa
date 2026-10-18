import { describe, it, expect, afterEach } from "vitest";
import {
  copyReplay,
  typeCatalog,
  wireType,
} from "../../device/marfa-answers.js";
import type { BindingDevice } from "../../device/binding-adapter.js";
import type { BindingHarness } from "./harness.js";
import { bindingHarness, untilHeld } from "./binding.shared.js";

/**
 * A read of the catalog while a refresh replaces it. The refresh is held
 * inside its transaction by the engine's own hold point, and the catalog is
 * read by a reading handle in a process of its own, as an app's helper reads
 * the store its app writes. The command cannot hold the writer there, so it
 * cannot read at that moment.
 */

let harness: BindingHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** The ids of the item types a handle reads, and the catalog version it reads them at. */
async function catalogOf(
  device: BindingDevice,
): Promise<{ types: string[]; version: number | undefined }> {
  const types = await device.itemTypes();
  const status = await device.status();
  expect(types.ok && status.ok, JSON.stringify([types, status])).toBe(true);
  return {
    types: types.ok ? types.value.map((type) => type.id) : [],
    version: status.ok ? status.value.catalogVersion : undefined,
  };
}

describe("reading the catalog while a refresh replaces it", () => {
  it("answers from the catalog before the refresh while it is held inside its transaction, and from the catalog after it once it ends, never from a mixture", async () => {
    let registered = false;
    const own = await bindingHarness("binding-catalog-consistent", {
      setup: ({ server }) => {
        // The hydration reads it once; every read after reads what the
        // fixture has registered by then.
        server.copyAnswer("GET", "/types", () =>
          typeCatalog(
            registered
              ? [wireType("acme.late-note", { parent: "core.note" })]
              : [],
          ),
        );
      },
    });
    harness = own;
    const { device, events } = own;
    const reader = await own.reader();
    const before = await catalogOf(reader);
    expect(before.types).not.toContain("acme.late-note");
    expect(before.version).toBeDefined();

    registered = true;
    events.set(copyReplay("10", []));
    await device.hooks.hold("catalog-replacing");
    const refreshing = device.catchUp();
    await untilHeld(device, "catalog-replacing");

    // The refresh has written the types it holds and not the rest.
    const during = await catalogOf(reader);
    expect(
      during,
      "a read during the refresh answered from a catalog that was neither the one before nor the one after",
    ).toEqual(before);

    await device.hooks.release("catalog-replacing");
    const done = await refreshing;
    expect(
      done.ok && done.value.catalogChanged,
      `the refresh did not change the catalog, so the read above is about nothing: ${JSON.stringify(done)}`,
    ).toBe(true);
    const after = await catalogOf(reader);
    expect(after.types).toContain("acme.late-note");
    expect(after.version).toBe((before.version ?? 0) + 1);
  });
});

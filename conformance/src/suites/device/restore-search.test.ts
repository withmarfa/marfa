import { afterEach, describe, expect, it } from "vitest";
import { hydratedHarness, type Harness } from "./harness.js";

/**
 * A row that leaves the bin is found by a local search again
 * (`device/index-fields`, `device/search-no-bin`): the copy takes it out of its
 * index when a delete or a transition puts it in the bin, and the same row
 * outside the bin matches on its title, body and tags.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const ZEBRA = "01900000-0000-7000-8000-0000000000b1";

async function started(label: string): Promise<Harness> {
  return hydratedHarness(label, {
    head: "10",
    rows: {
      "core.note": [
        {
          item: {
            id: ZEBRA,
            type: "core.note",
            properties: { title: "Zebra", body: "striped quagga" },
          },
          tags: ["savannah"],
        },
      ],
    },
  });
}

/** The ids a local search answers, whatever the state. */
async function found(h: Harness, query: string): Promise<string[]> {
  const hits = await h.device.search(query, { allStates: true });
  expect(hits.ok, JSON.stringify(hits)).toBe(true);
  return hits.ok ? hits.value.map((hit) => hit.item.id) : [];
}

const MATCHES = ["zebra", "quagga", "savannah"];

describe("a row that leaves the bin is found again", () => {
  it("finds a restored row by its title, body and tags", async () => {
    harness = await started("restore-search");
    // The witness: the row is found before it goes to the bin.
    for (const query of MATCHES)
      expect(await found(harness, query)).toContain(ZEBRA);

    const deleted = await harness.device.deleteItem(ZEBRA);
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
    for (const query of MATCHES) {
      expect(
        await found(harness, query),
        "a row in the bin was found",
      ).not.toContain(ZEBRA);
    }

    const restored = await harness.device.restoreItem(ZEBRA);
    expect(restored.ok, JSON.stringify(restored)).toBe(true);
    for (const query of MATCHES) {
      expect(
        await found(harness, query),
        `a restored row was not found by ${query}`,
      ).toContain(ZEBRA);
    }
    const plain = await harness.device.search("zebra");
    expect(plain.ok && plain.value.map((hit) => hit.item.id)).toContain(ZEBRA);
  });

  it("finds a row moved from the bin to the archive", async () => {
    harness = await started("transition-search");
    expect((await harness.device.deleteItem(ZEBRA)).ok).toBe(true);
    expect(await found(harness, "zebra")).not.toContain(ZEBRA);

    const moved = await harness.device.transitionItem(ZEBRA, "archived");
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    const hits = await harness.device.search("zebra", { state: "archived" });
    expect(hits.ok, JSON.stringify(hits)).toBe(true);
    expect(
      hits.ok && hits.value.map((hit) => hit.item.id),
      "a row moved from the bin to the archive was not found",
    ).toContain(ZEBRA);
  });

  it("finds a row moved from the bin to active", async () => {
    harness = await started("transition-active-search");
    expect((await harness.device.deleteItem(ZEBRA)).ok).toBe(true);
    const moved = await harness.device.transitionItem(ZEBRA, "active");
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    expect(await found(harness, "zebra")).toContain(ZEBRA);
  });
});

describe("the index follows a tag the copy changes", () => {
  it("finds a row by a tag added here and not by one removed here", async () => {
    harness = await started("tag-search");
    expect((await harness.device.addTag(ZEBRA, "stripes")).ok).toBe(true);
    expect(
      await found(harness, "stripes"),
      "a tag added here was not matched",
    ).toContain(ZEBRA);
    expect((await harness.device.removeTag(ZEBRA, "savannah")).ok).toBe(true);
    expect(
      await found(harness, "savannah"),
      "a tag removed here was still matched",
    ).not.toContain(ZEBRA);
  });
});

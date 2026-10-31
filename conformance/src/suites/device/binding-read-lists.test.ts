import { describe, it, expect, afterEach } from "vitest";
import type { BindingItem } from "../../device/binding-adapter.js";
import { bindingHarness, type Followed } from "./binding.shared.js";

/**
 * A type or state list holding no entry, through the binding. The command
 * line cannot send one: a flag repeated no times is a filter left unset, so
 * only an app's own call reaches this rule.
 */

let harness: Followed | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("a local read naming an empty list", () => {
  it("refuses an empty type or state list rather than reading the default", async () => {
    harness = await bindingHarness("binding-read-lists-empty", {
      rows: { "core.note": [{ item: { id: "n1" } }] },
    });
    const { device } = harness;
    // The witness: the same calls with the key left out answer the row, so
    // the refusals below are the empty lists and not a door that refuses.
    const listed = await device.call<{ items: BindingItem[] }>("list", {});
    expect(
      listed.ok && listed.value.items.map((item) => item.id),
      JSON.stringify(listed),
    ).toEqual(["n1"]);
    const found = await device.call<{ hits: unknown[] }>("search", "n1", {});
    expect(found.ok && found.value.hits.length, JSON.stringify(found)).toBe(1);

    for (const filters of [{ types: [] }, { states: [] }]) {
      for (const [door, outcome] of [
        ["list", await device.call("list", filters)],
        ["search", await device.call("search", "n1", filters)],
      ] as const) {
        expect(
          outcome.ok,
          `a ${door} naming ${JSON.stringify(filters)} was answered, so a list built from nothing reads as the default`,
        ).toBe(false);
        if (!outcome.ok) {
          expect(outcome.refusal.code).toBe("validation");
          expect(outcome.refusal.raw).toContain("validation_error");
        }
      }
    }
  });
});

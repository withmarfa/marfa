import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Every method that locks a `metadata` row claims that item's row first.
 *
 * `writeSidecar` writes `items` on any write a client can learn about, so a
 * method holding `metadata` is about to want `items` too. Every other writer
 * in the store takes them in that order — `removeTag` reads, writes `items`,
 * then writes `metadata` — so a method taking the sidecar alone inverts it,
 * and one `POST /items/{id}/tags` against one `DELETE /items/{id}/tags/{tag}`
 * on the same row is an ABBA cycle. Nothing in this package retries a
 * deadlock, so it surfaces as an intermittent 500 on a write that is fine.
 *
 * **Read structurally rather than driven, because the driven version cannot
 * see it.** A deadlock needs two transactions interleaved at the right
 * instant; a test that races them passes whenever the timing misses, which is
 * most runs. The ordering is a property of the source, and the source is
 * where it can be asserted every time. It is also Postgres-only by nature:
 * SQLite takes no row locks and admits one writer, so the whole class is
 * unreachable there and the dialect's suite is structurally blind to it.
 *
 * This was not hypothetical. A change adding the `metadata` lock to the two
 * tag writers quoted `mutateExtension`'s reasoning for having one and did not
 * copy the item-row claim four lines below it, which built exactly this cycle.
 */

const source = readFileSync(
  fileURLToPath(new URL("./metadata-store.ts", import.meta.url)),
  "utf8",
);

/** Method bodies, split on the class's own method declarations. */
function methods(text: string): { name: string; body: string }[] {
  const starts: { name: string; at: number }[] = [];
  const declaration = /^ {2}(?:private )?(?:async )?([a-zA-Z]\w*)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = declaration.exec(text)) !== null) {
    starts.push({ name: m[1] ?? "", at: m.index });
  }
  return starts.map((s, i) => ({
    name: s.name,
    body: text.slice(s.at, starts[i + 1]?.at ?? text.length),
  }));
}

const LOCKS_METADATA = /\.from\(metadata\)[\s\S]{0,200}?\.for\("update"\)/;
const LOCKS_ITEMS = /\.from\(items\)[\s\S]{0,200}?\.for\("update"\)/;

describe("the metadata store's lock order", () => {
  const all = methods(source);

  it("finds the methods it is supposed to be reading", () => {
    // Without this the whole file passes vacuously the moment the class is
    // reformatted past the declaration pattern above.
    const names = all.map((m) => m.name);
    expect(names).toContain("merge");
    expect(names).toContain("addTags");
    expect(names).toContain("mutateExtension");
    expect(names).toContain("removeTag");
  });

  it("locks at least one metadata row somewhere, so this is not vacuous", () => {
    expect(
      all.filter((m) => LOCKS_METADATA.test(m.body)).length,
    ).toBeGreaterThan(2);
  });

  it("claims the item row before the metadata row, in every method that locks one", () => {
    for (const method of all) {
      if (!LOCKS_METADATA.test(method.body)) continue;
      const metadataAt = method.body.search(LOCKS_METADATA);
      const itemsAt = method.body.search(LOCKS_ITEMS);
      expect(
        itemsAt,
        `${method.name} locks a metadata row and never claims the item row. ` +
          `writeSidecar writes items next, so this inverts the order every ` +
          `other writer holds and closes a deadlock cycle with removeTag.`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        itemsAt,
        `${method.name} claims the item row after locking metadata. The ` +
          `order is what matters, not the presence of both.`,
      ).toBeLessThan(metadataAt);
    }
  });
});

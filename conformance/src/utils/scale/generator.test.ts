import { describe, expect, it } from "vitest";
import { edgePlan, scaleItem, sourceIdOf } from "./generator.js";

const SAMPLE = 10_000;
const items = Array.from({ length: SAMPLE }, (_, i) => scaleItem(i + 1));

describe("the generator", () => {
  it("makes the same item every time", () => {
    expect(scaleItem(77)).toEqual(scaleItem(77));
    expect(scaleItem(77)).not.toEqual(scaleItem(78));
  });

  it("keys each item by a source id its position names", () => {
    expect(scaleItem(5).source_id).toBe(sourceIdOf(5));
    expect(new Set(items.map((i) => i.source_id)).size).toBe(SAMPLE);
  });

  it("keeps the type mix: 60% notes, 25% tasks, 15% bookmarks", () => {
    const share = (type: string) =>
      items.filter((i) => i.type === type).length / SAMPLE;
    expect(share("core.note")).toBeCloseTo(0.6, 1);
    expect(share("core.task")).toBeCloseTo(0.25, 1);
    expect(share("core.bookmark")).toBeCloseTo(0.15, 1);
  });

  it("tags about 40% with one to three tags and puts 10% in the feed", () => {
    const tagged = items.filter((i) => (i.tags?.length ?? 0) > 0);
    expect(tagged.length / SAMPLE).toBeCloseTo(0.4, 1);
    for (const item of tagged) {
      expect(item.tags?.length).toBeGreaterThanOrEqual(1);
      expect(item.tags?.length).toBeLessThanOrEqual(3);
    }
    expect(items.filter((i) => i.tier === "feed").length / SAMPLE).toBeCloseTo(
      0.1,
      1,
    );
  });

  it("writes notes with a title and a Markdown body with headings, links, task lists and code", () => {
    const notes = items.filter((i) => i.type === "core.note");
    const bodies = notes.map((n) => String(n.properties?.body));
    for (const note of notes.slice(0, 50)) {
      expect(typeof note.properties?.title).toBe("string");
    }
    expect(bodies.every((b) => b.startsWith("# "))).toBe(true);
    expect(bodies.some((b) => /\[\[[^\]]+\]\]/.test(b))).toBe(true);
    expect(bodies.some((b) => b.includes("- [ ] "))).toBe(true);
    expect(bodies.some((b) => b.includes("```"))).toBe(true);
  });

  it("gives some tasks a due date and a priority, and every bookmark a url", () => {
    const tasks = items.filter((i) => i.type === "core.task");
    expect(tasks.some((t) => typeof t.properties?.due_at === "string")).toBe(
      true,
    );
    expect(tasks.some((t) => typeof t.properties?.priority === "string")).toBe(
      true,
    );
    expect(tasks.some((t) => t.properties?.due_at === undefined)).toBe(true);
    const bookmarks = items.filter((i) => i.type === "core.bookmark");
    expect(
      bookmarks.every((b) => String(b.properties?.url).startsWith("https://")),
    ).toBe(true);
  });

  it("holds a rare word in a few items and a common word in many", () => {
    const text = (i: (typeof items)[number]) => JSON.stringify(i.properties);
    const rare = items.filter((i) => text(i).includes("quokka")).length;
    const common = items.filter((i) => text(i).includes("garden")).length;
    expect(rare).toBeGreaterThan(0);
    expect(rare).toBeLessThan(SAMPLE / 500);
    expect(common).toBeGreaterThan(SAMPLE / 10);
  });
});

describe("the edge plan", () => {
  it("is the same every time", () => {
    expect(edgePlan(500)).toEqual(edgePlan(500));
  });

  it("points a parent at an earlier item inside a window, so the edges form trees", () => {
    for (let n = 2; n < 3000; n++) {
      const { parent, about } = edgePlan(n);
      if (parent !== null) {
        expect(parent).toBeGreaterThanOrEqual(Math.max(1, n - 200));
        expect(parent).toBeLessThan(n);
      }
      if (about !== null) {
        expect(about).toBeGreaterThanOrEqual(1);
        expect(about).toBeLessThan(n);
      }
    }
  });

  it("gives a share of items a parent that reaches 100,000 edges at 250,000 items", () => {
    let parents = 0;
    let abouts = 0;
    for (let n = 1; n <= SAMPLE; n++) {
      const plan = edgePlan(n);
      if (plan.parent !== null) parents++;
      if (plan.about !== null) abouts++;
    }
    expect((parents / SAMPLE) * 250_000).toBeGreaterThanOrEqual(100_000);
    expect(abouts).toBeGreaterThan(0);
  });

  it("gives the first item no edges, since nothing is before it", () => {
    expect(edgePlan(1)).toEqual({ parent: null, about: null });
  });
});

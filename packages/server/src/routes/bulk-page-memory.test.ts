import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

// Resident memory, not the heap: V8 keeps the pages a page of writes grew into
// until it is asked to give them back, and the resident figure is what a host
// with little memory sees. The ceiling is the issue's: within 100 MB of where
// the server rested.
const CEILING_MB = 100;
const PAGE_ENTRIES = 5_000;
// A page of this size takes a few seconds to write. The release waits for the
// server to be quiet first, then for the poll below to see it.
const SETTLE_MS = 5_000;

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
});

const residentMb = () => process.memoryUsage.rss() / (1024 * 1024);

function body(entry: number): string {
  return `# Note ${String(entry)}\n\n${"A paragraph of ordinary prose about a note. ".repeat(40)}\n`;
}

async function writePage(atomic: boolean): Promise<void> {
  const response = await ctx.app.request("/items/bulk", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.workingKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode: "upsert",
      atomic,
      items: Array.from({ length: PAGE_ENTRIES }, (_, i) => ({
        type: "core.note",
        source_id: `memory-${String(i)}`,
        properties: { title: `Note ${String(i)}`, body: body(i) },
      })),
    }),
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    counts: { created: number; errored: number };
  };
  expect(result.counts).toMatchObject({ created: PAGE_ENTRIES, errored: 0 });
}

describe("a large bulk page gives its memory back", () => {
  it.each([true, false])(
    "returns resident memory to near its rest figure (atomic=%s)",
    async (atomic) => {
      // Settle the start-up garbage first, so the rest figure is the lowest the
      // process holds and the page is the only thing the comparison measures.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const rest = residentMb();

      await writePage(atomic);
      const peak = residentMb();

      const deadline = Date.now() + SETTLE_MS;
      let later = residentMb();
      while (later > rest + CEILING_MB && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        later = residentMb();
      }

      // Witness: the page did take the process past the ceiling, so staying
      // under it afterwards is the release at work and not a page too small
      // to matter.
      expect(peak).toBeGreaterThan(rest + CEILING_MB);
      expect(later).toBeLessThanOrEqual(rest + CEILING_MB);
    },
    120_000,
  );
});

import { describe, it, expect, beforeAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
} from "../../utils/fresh-server.js";

/**
 * How deep a search reads its ranking. The rows are many enough that the
 * ranking could go on past the depth, which is what a search on the run's
 * shared server cannot hold: every file's rows would match too. So the
 * server is the file's own, and the rows are its whole content.
 */

const DEPTH = 10_000;
const BULK_PAGE = 500;
const LIST_PAGE = 200;
const SEARCH_PAGE = 100;

let client: MarfaClient;
const token = "depthprobe";

beforeAll(async () => {
  const server = await bootFreshServer("search-depth");
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  for (let written = 0; written <= DEPTH; written += BULK_PAGE) {
    const count = Math.min(BULK_PAGE, DEPTH + 1 - written);
    const page = await client.bulkItems({
      items: Array.from({ length: count }, (_, i) => ({
        type: "core.note",
        properties: { body: `${token} ${String(written + i)}` },
      })),
      mode: "create_only",
    });
    expect(page.status, JSON.stringify(page.error)).toBe(200);
  }
}, FRESH_SERVER_TIMEOUT_MS + 300_000);

describe("search depth", () => {
  it("stops paging a search at its 10,000th row", async () => {
    // The witness: the instance holds a row past the depth, so a cursor of
    // `null` at the 10,000th row is the depth's doing and not the ranking's
    // end.
    let held = 0;
    let listing: string | undefined;
    do {
      const page = await client.listItems({
        type: "core.note",
        limit: LIST_PAGE,
        ...(listing !== undefined && { cursor: listing }),
      });
      expect(page.status, JSON.stringify(page.error)).toBe(200);
      held += page.data.data.length;
      listing = page.data.next_cursor ?? undefined;
    } while (listing !== undefined);
    expect(held).toBe(DEPTH + 1);

    // A page size that divides the depth ends on a full page; one that does
    // not ends on a page the depth cut short. Both end at the depth.
    for (const limit of [SEARCH_PAGE, 70]) {
      const reached: string[] = [];
      let pages = 0;
      let cursor: string | undefined;
      for (;;) {
        const page = await client.search(token, {
          limit,
          ...(cursor !== undefined && { cursor }),
        });
        expect(page.status, JSON.stringify(page.error)).toBe(200);
        pages += 1;
        reached.push(...page.data.data.map((hit) => hit.item.id));
        if (page.data.next_cursor === null) break;
        expect(
          reached.length,
          `a cursor was answered at or past the depth at limit ${String(limit)}`,
        ).toBeLessThan(DEPTH);
        cursor = page.data.next_cursor;
      }

      expect(reached, `limit ${String(limit)}`).toHaveLength(DEPTH);
      expect(new Set(reached).size).toBe(DEPTH);
      expect(pages).toBe(Math.ceil(DEPTH / limit));
    }
  }, 600_000);
});

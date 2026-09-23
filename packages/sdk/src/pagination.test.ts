/**
 * The pagination helper, driven against stub pages rather than a server.
 *
 * Every property here is about the walk itself — where it stops, what it
 * holds, what it does when asked for more than it was allowed. A real server
 * would add latency and prove none of them any better; `client.test.ts`
 * already covers that the underlying list endpoints page correctly.
 */
import { describe, expect, it, vi } from "vitest";
import type { PaginatedResult } from "@withmarfa/shared";

import {
  paginate,
  collect,
  PageLimitExceededError,
  type PageFetcher,
} from "./pagination.js";

/** A fetcher serving `pages` in order, recording the cursors it was given. */
function stubPages<T>(
  pages: PaginatedResult<T>[],
): PageFetcher<T> & { calls: (string | undefined)[] } {
  const calls: (string | undefined)[] = [];
  const fetcher = (cursor: string | undefined): Promise<PaginatedResult<T>> => {
    calls.push(cursor);
    const page = pages[calls.length - 1];
    if (!page) throw new Error("fetched past the end of the stub");
    return Promise.resolve(page);
  };
  return Object.assign(fetcher, { calls });
}

function page<T>(data: T[], next_cursor: string | null): PaginatedResult<T> {
  return { data, next_cursor };
}

async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const row of source) out.push(row);
  return out;
}

describe("paginate", () => {
  it("yields every row across pages, in order", async () => {
    const fetcher = stubPages([
      page(["a", "b"], "c1"),
      page(["c", "d"], "c2"),
      page(["e"], null),
    ]);

    expect(await drain(paginate(fetcher))).toEqual(["a", "b", "c", "d", "e"]);
    // The first call carries no cursor; each later one carries what the
    // previous page returned. Getting this wrong re-serves page one forever.
    expect(fetcher.calls).toEqual([undefined, "c1", "c2"]);
  });

  it("refuses a cursor answered back unchanged", async () => {
    const fetcher = stubPages([page(["a"], "c1"), page(["b"], "c1")]);
    await expect(drain(paginate(fetcher))).rejects.toThrow(/would not end/);
  });

  it("walks past an empty page that still carries a cursor", async () => {
    // A page thinned by what the credential may read can come back empty
    // with more to follow; stopping there would truncate the walk.
    const fetcher = stubPages([page([], "c1"), page(["b"], null)]);

    expect(await drain(paginate(fetcher))).toEqual(["b"]);
    expect(fetcher.calls).toEqual([undefined, "c1"]);
  });

  it("makes one request for a single-page result", async () => {
    const fetcher = stubPages([page(["only"], null)]);
    expect(await drain(paginate(fetcher))).toEqual(["only"]);
    expect(fetcher.calls).toHaveLength(1);
  });

  it("yields nothing, and fetches once, for an empty result", async () => {
    const fetcher = stubPages([page([], null)]);
    expect(await drain(paginate(fetcher))).toEqual([]);
    expect(fetcher.calls).toHaveLength(1);
  });

  it("does not fetch the next page when the consumer stops early", async () => {
    // The whole reason the streaming shape exists: a caller looking for one
    // row should not pay for the rest of the set.
    const fetcher = vi.fn(
      (cursor: string | undefined): Promise<PaginatedResult<string>> =>
        Promise.resolve(
          cursor === undefined ? page(["a", "b"], "c1") : page(["c"], null),
        ),
    );

    const seen: string[] = [];
    for await (const row of paginate(fetcher)) {
      seen.push(row);
      if (seen.length === 2) break;
    }

    expect(seen).toEqual(["a", "b"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not fetch at all until the first row is asked for", async () => {
    const fetcher = vi.fn(() => Promise.resolve(page(["a"], null)));
    const walk = paginate(fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    await drain(walk);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("propagates a failure from the underlying fetch", async () => {
    const boom = new Error("upstream refused");
    await expect(
      drain(paginate(() => Promise.reject<PaginatedResult<string>>(boom))),
    ).rejects.toBe(boom);
  });
});

describe("collect", () => {
  it("returns every row when the walk fits inside the ceiling", async () => {
    const fetcher = stubPages([page([1, 2], "c1"), page([3], null)]);
    expect(await collect(paginate(fetcher), { maxItems: 10 })).toEqual([
      1, 2, 3,
    ]);
  });

  it("accepts a walk that lands exactly on the ceiling", async () => {
    const fetcher = stubPages([page([1, 2, 3], null)]);
    expect(await collect(paginate(fetcher), { maxItems: 3 })).toEqual([
      1, 2, 3,
    ]);
  });

  it("throws rather than returning a truncated set", async () => {
    // The failure this helper exists to stop repeating: a walk that quietly
    // returns the first N rows of a larger set is indistinguishable from a
    // complete one at the call site, so the caller reports a wrong total and
    // nothing anywhere says so.
    const fetcher = stubPages([page([1, 2], "c1"), page([3, 4], null)]);

    await expect(
      collect(paginate(fetcher), { maxItems: 3 }),
    ).rejects.toBeInstanceOf(PageLimitExceededError);
  });

  it("names the ceiling it hit and how to proceed", async () => {
    const walk = (): AsyncIterable<number> =>
      paginate(stubPages([page([1, 2], null)]));

    await expect(collect(walk(), { maxItems: 1 })).rejects.toMatchObject({
      maxItems: 1,
    });
    // The message has to carry the way out, or the caller's only options are
    // to guess a bigger number or give up.
    await expect(collect(walk(), { maxItems: 1 })).rejects.toThrow(
      /paginate\(\)/,
    );
  });

  it("refuses a ceiling that is not a positive integer", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(
        collect(paginate(stubPages([page([1], null)])), {
          maxItems: bad,
        }),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });
});

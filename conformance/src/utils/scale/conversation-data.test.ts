import { describe, expect, it } from "vitest";
import {
  ActivityLog,
  judgeBlob,
  judgeListing,
  ListingWalk,
  messageNumber,
  messageOf,
  MessageWalk,
  scrambled,
  tieGroup,
} from "./conversation-data.js";

const files = ["file-a", "file-b", "file-c"];

describe("generated messages", () => {
  it("name the number they were made from, and nothing for altered values", () => {
    expect(messageNumber(messageOf(41, files), files)).toBe(41);
    expect(messageNumber(messageOf(-3, files), files)).toBe(-3);
    expect(messageNumber(messageOf(40, files), files)).toBe(40);
    expect(
      messageNumber({ ...messageOf(41, files), author: "mallory" }, files),
    ).toBeNull();
    expect(
      messageNumber(
        { ...messageOf(41, files), sent_at: "2026-01-01T00:00:00.000Z" },
        files,
      ),
    ).toBeNull();
    expect(
      messageNumber({ ...messageOf(40, files), attachment: "file-z" }, files),
    ).toBeNull();
    expect(
      messageNumber({ ...messageOf(41, files), attachment: "file-a" }, files),
    ).toBeNull();
    const lost: Record<string, unknown> = messageOf(40, files);
    delete lost.attachment;
    expect(messageNumber(lost, files)).toBeNull();
    expect(messageNumber(null, files)).toBeNull();
  });

  it("send later messages later and name a file in every tenth", () => {
    const sent = (n: number) =>
      Date.parse(messageOf(n, files).sent_at as string);
    expect(sent(4) - sent(0)).toBe(1000);
    expect(sent(-1)).toBeLessThan(sent(0));
    expect([0, 10, 20, 30].map((n) => messageOf(n, files).attachment)).toEqual([
      "file-a",
      "file-b",
      "file-c",
      "file-a",
    ]);
    expect(messageOf(5, files)).not.toHaveProperty("attachment");
    expect(messageOf(0, [])).not.toHaveProperty("attachment");
  });

  it("share a sent_at within a group of four, and differ between groups", () => {
    const sent = (n: number) => messageOf(n, files).sent_at;
    expect(sent(0)).toBe(sent(3));
    expect(sent(4)).toBe(sent(7));
    expect(sent(3)).not.toBe(sent(4));
    expect(sent(-1)).toBe(sent(-4));
    expect(sent(-4)).not.toBe(sent(-5));
    expect(tieGroup(-1)).toBe(-1);
    expect(tieGroup(4)).toBe(1);
  });

  it("read back at another instant for the same moment", () => {
    const values = {
      ...messageOf(7, files),
      sent_at: "2026-01-01T00:00:01+00:00",
    };
    expect(messageNumber(values, files)).toBe(7);
  });
});

describe("MessageWalk", () => {
  // Ids rise with the number unless a test names another rank.
  const rows = (numbers: number[], rank = (n: number) => n) =>
    numbers.map((n) => ({
      id: `id-${String(rank(n) + 1000).padStart(5, "0")}`,
      values: messageOf(n, files),
    }));
  const plan = (
    first: number,
    direction: "asc" | "desc",
    total: number,
    limit: number,
    held?: number,
  ) => new MessageWalk({ files, first, direction, total, held, limit });

  it("accepts the latest messages newest first, a late arrival after them", () => {
    const walk = plan(9, "desc", 12, 4);
    walk.page({ data: rows([8, 9, 4, 5]), next_cursor: "a" }, null);
    walk.page({ data: rows([6, 7, 0, 1]), next_cursor: "b" }, "a");
    walk.page({ data: rows([2, 3, -2, -1]), next_cursor: null }, "b");
    walk.finish();
    expect(walk.problems).toEqual([]);
    expect(walk.rowsRead).toBe(12);
  });

  it("breaks a tie in sent_at by id ascending, in either direction", () => {
    const rank = (n: number) => -n;
    const ascending = plan(0, "asc", 4, 10);
    ascending.page({ data: rows([3, 2, 1, 0], rank), next_cursor: null }, null);
    ascending.finish();
    expect(ascending.problems).toEqual([]);
    const descending = plan(7, "desc", 8, 10);
    descending.page(
      { data: rows([4, 5, 6, 7, 0, 1, 2, 3]), next_cursor: null },
      null,
    );
    descending.finish();
    expect(descending.problems).toEqual([]);
  });

  it("names a tie broken by id descending, and a message of another group in a group's place", () => {
    const wrongTie = plan(0, "asc", 4, 10);
    wrongTie.page({ data: rows([0, 1, 3, 2]), next_cursor: null }, null);
    expect(wrongTie.problems.join("\n")).toMatch(/a tie goes by id ascending/);
    const wrongGroup = plan(0, "asc", 8, 10);
    wrongGroup.page(
      { data: rows([0, 1, 2, 4, 3, 5, 6, 7]), next_cursor: null },
      null,
    );
    expect(wrongGroup.problems.join("\n")).toMatch(
      /is message 4, not one sent with message 3/,
    );
  });

  it("names a page out of order, a message that was never written and a repeated row", () => {
    const walk = plan(7, "desc", 8, 10);
    walk.page(
      {
        data: [
          ...rows([7, 3]),
          { id: "x", values: { text: "hello" } },
          ...rows([3]),
        ],
        next_cursor: null,
      },
      null,
    );
    walk.finish();
    const text = walk.problems.join("\n");
    expect(text).toMatch(/is message 3, not one sent with message 6/);
    expect(text).toMatch(/never written/);
    expect(text).toMatch(/came twice/);
  });

  it("names a walk that stops short, a stuck cursor and an answer with no rows", () => {
    const walk = plan(0, "asc", 4, 2);
    walk.page({ data: rows([0, 1]), next_cursor: "a" }, null);
    expect(walk.cursorStuck).toBe(false);
    walk.page({ data: rows([2, 3]), next_cursor: "a" }, "a");
    expect(walk.cursorStuck).toBe(true);
    walk.page({ error: "no" }, "a");
    walk.finish();
    const text = walk.problems.join("\n");
    expect(text).toMatch(/cursor did not move on/);
    expect(text).toMatch(/no data array/);
    const short = plan(0, "asc", 4, 2);
    short.page({ data: rows([0, 1]), next_cursor: null }, null);
    short.finish();
    expect(short.problems.join("\n")).toMatch(/read 2 messages, not the 4/);
  });

  it("names a missing cursor while messages remain, and accepts none at the end", () => {
    const first = plan(9, "desc", 4, 2, 10);
    first.page({ data: rows([8, 9]), next_cursor: null }, null);
    expect(first.problems.join("\n")).toMatch(
      /no next_cursor after 2 messages of 10/,
    );
    const whole = plan(0, "asc", 4, 2);
    whole.page({ data: rows([0, 1]), next_cursor: "a" }, null);
    whole.page({ data: rows([2, 3]), next_cursor: null }, "a");
    whole.finish();
    expect(whole.problems).toEqual([]);
    const witness = plan(9, "desc", 4, 2, 10);
    witness.page({ data: rows([8, 9]), next_cursor: "a" }, null);
    expect(witness.problems).toEqual([]);
  });

  it("hashes the ids in the order read", () => {
    const walk = (numbers: number[]) => {
      const w = plan(numbers[0] as number, "asc", numbers.length, 10);
      w.page({ data: rows(numbers), next_cursor: null }, null);
      return w.digest();
    };
    expect(walk([0, 1, 2])).toBe(walk([0, 1, 2]));
    expect(walk([0, 1, 2])).not.toBe(walk([0, 1, 3]));
  });
});

describe("scrambled", () => {
  it("is every number once, in an order that is not their own", () => {
    for (const count of [1, 2, 999, 1000, 7919, 8000]) {
      const order = scrambled(count);
      expect([...order].sort((a, b) => a - b)).toEqual(
        Array.from({ length: count }, (_, i) => i),
      );
    }
    expect(scrambled(999)).not.toEqual(
      Array.from({ length: 999 }, (_, i) => i),
    );
  });
});

describe("judgeListing", () => {
  const expected = new Map([
    ["a", "2026-03-01T09:00:03.000Z"],
    ["b", "2026-03-01T09:00:02.000Z"],
    ["c", "2026-03-01T09:00:02.000Z"],
  ]);
  const item = (id: string, at = expected.get(id) as string) => ({
    id,
    last_activity_at: at,
  });

  it("accepts latest first, either order of a tie", () => {
    expect(
      judgeListing([item("a"), item("b"), item("c")], expected),
    ).toBeNull();
    expect(
      judgeListing([item("a"), item("c"), item("b")], expected),
    ).toBeNull();
  });

  it("names a wrong order, a wrong time, a missing, repeated or unknown conversation", () => {
    expect(judgeListing([item("b"), item("a"), item("c")], expected)).toMatch(
      /later than the one before/,
    );
    expect(
      judgeListing(
        [item("a"), item("b", "2026-03-01T09:00:01.000Z"), item("c")],
        expected,
      ),
    ).toMatch(/last append was answered/);
    expect(judgeListing([item("a"), item("b")], expected)).toMatch(
      /2 conversations/,
    );
    expect(judgeListing([item("a"), item("b"), item("b")], expected)).toMatch(
      /twice/,
    );
    expect(judgeListing([item("a"), item("b"), item("z")], expected)).toMatch(
      /not one made/,
    );
  });
});

describe("ActivityLog", () => {
  it("accepts an activity that moves on across writes made in distinct milliseconds", () => {
    const log = new ActivityLog();
    expect(log.record("a", 1000, 1001, "2026-03-01T09:00:00.100Z")).toBeNull();
    expect(log.record("a", 1010, 1011, "2026-03-01T09:00:00.111Z")).toBeNull();
    expect(log.advances).toBe(1);
    expect(log.latest.get("a")).toBe("2026-03-01T09:00:00.111Z");
  });

  it("names an activity that stays still across writes made in distinct milliseconds", () => {
    const log = new ActivityLog();
    log.record("a", 1000, 1001, "2026-03-01T09:00:00.100Z");
    expect(log.record("a", 1010, 1011, "2026-03-01T09:00:00.100Z")).toMatch(
      /stayed 2026-03-01T09:00:00.100Z across writes 9 ms apart/,
    );
    expect(log.advances).toBe(0);
  });

  it("lets writes in the same millisecond share a time, and names one that goes back", () => {
    const log = new ActivityLog();
    log.record("a", 1000, 1001, "2026-03-01T09:00:00.100Z");
    expect(log.record("a", 1002, 1003, "2026-03-01T09:00:00.100Z")).toBeNull();
    expect(log.advances).toBe(0);
    expect(log.record("a", 1004, 1005, "2026-03-01T09:00:00.099Z")).toMatch(
      /went back/,
    );
  });

  it("keeps each conversation apart, and names a time that is not one", () => {
    const log = new ActivityLog();
    log.record("a", 1000, 1001, "2026-03-01T09:00:00.100Z");
    expect(log.record("b", 1100, 1101, "2026-03-01T09:00:00.100Z")).toBeNull();
    expect(log.record("a", 1200, 1201, "soon")).toMatch(/not a time/);
  });
});

describe("ListingWalk", () => {
  const body = (ids: string[], next: string | null) => ({
    data: ids.map((id) => ({ id, last_activity_at: "2026-03-01T09:00:00Z" })),
    next_cursor: next,
  });

  it("follows cursors to the end and keeps the items", () => {
    const walk = new ListingWalk(3, 2);
    expect(walk.page(body(["a", "b"], "x"), null)).toEqual({
      next: "x",
      problem: null,
    });
    expect(walk.page(body(["c"], null), "x")).toEqual({
      next: null,
      problem: null,
    });
    expect(walk.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("stops at once on a cursor that comes again", () => {
    const same = new ListingWalk(10, 2);
    same.page(body(["a", "b"], "x"), null);
    expect(same.page(body(["c", "d"], "x"), "x").problem).toMatch(
      /did not move on/,
    );
    const loop = new ListingWalk(10, 2);
    loop.page(body(["a", "b"], "x"), null);
    loop.page(body(["c", "d"], "y"), "x");
    expect(loop.page(body(["e", "f"], "x"), "y").problem).toMatch(
      /did not move on/,
    );
  });

  it("stops a walk that passes the known count or its pages, however the cursors differ", () => {
    const over = new ListingWalk(3, 2);
    over.page(body(["a", "b"], "x"), null);
    expect(over.page(body(["c", "d"], "y"), "x").problem).toMatch(
      /more than the 3 conversations/,
    );
    const empty = new ListingWalk(2, 2);
    const steps = ["p1", "p2", "p3", "p4"].map((cursor, i, all) =>
      empty.page(body([], cursor), all[i - 1] ?? null),
    );
    expect(steps.map((step) => step.problem === null)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(steps[2]?.problem).toMatch(/still paging after 3 pages/);
  });

  it("names an answer with no data and a cursor that is not text", () => {
    expect(new ListingWalk(1, 1).page({ error: "no" }, null).problem).toMatch(
      /no data array/,
    );
    expect(
      new ListingWalk(5, 1).page({ data: [], next_cursor: 7 }, null).problem,
    ).toMatch(/next_cursor is 7/);
  });
});

describe("judgeBlob", () => {
  it("accepts the bytes uploaded under a successful status", () => {
    expect(judgeBlob({ status: 200, text: "Minutes" }, "Minutes")).toBeNull();
  });

  it("names a failed status that carries the bytes, and wrong bytes under a good one", () => {
    expect(judgeBlob({ status: 503, text: "Minutes" }, "Minutes")).toMatch(
      /answered 503/,
    );
    expect(judgeBlob({ status: 0, text: "Minutes" }, "Minutes")).toMatch(
      /answered 0/,
    );
    expect(judgeBlob({ status: 200, text: "Other" }, "Minutes")).toMatch(
      /holds "Other"/,
    );
  });
});

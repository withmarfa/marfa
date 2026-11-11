import { describe, expect, it } from "vitest";
import {
  judgeListing,
  messageNumber,
  messageOf,
  MessageWalk,
  scrambled,
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
    expect(sent(1) - sent(0)).toBe(1000);
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

  it("read back at another instant for the same moment", () => {
    const values = {
      ...messageOf(7, files),
      sent_at: "2026-01-01T00:00:07+00:00",
    };
    expect(messageNumber(values, files)).toBe(7);
  });
});

describe("MessageWalk", () => {
  const rows = (numbers: number[]) =>
    numbers.map((n) => ({ id: `id-${n}`, values: messageOf(n, files) }));

  it("accepts the latest messages newest first, a late arrival after them", () => {
    const walk = new MessageWalk({
      files,
      first: 4,
      direction: "desc",
      total: 7,
      limit: 4,
    });
    walk.page({ data: rows([4, 3, 2, 1]), next_cursor: "a" }, null);
    walk.page({ data: rows([0, -1, -2]), next_cursor: null }, "a");
    walk.finish();
    expect(walk.problems).toEqual([]);
    expect(walk.rowsRead).toBe(7);
  });

  it("names a page out of order, a message that was never written and a repeated row", () => {
    const walk = new MessageWalk({
      files,
      first: 3,
      direction: "desc",
      total: 4,
      limit: 4,
    });
    walk.page(
      {
        data: [
          ...rows([3, 1]),
          { id: "x", values: { text: "hello" } },
          ...rows([1]),
        ],
        next_cursor: null,
      },
      null,
    );
    walk.finish();
    expect(walk.problems.join("\n")).toMatch(/is message 1, not message 2/);
    expect(walk.problems.join("\n")).toMatch(/never written/);
    expect(walk.problems.join("\n")).toMatch(/came twice/);
  });

  it("names a walk that stops short, a stuck cursor and an answer with no rows", () => {
    const walk = new MessageWalk({
      files,
      first: 0,
      direction: "asc",
      total: 4,
      limit: 2,
    });
    walk.page({ data: rows([0, 1]), next_cursor: "a" }, null);
    walk.page({ data: rows([2, 3]), next_cursor: "a" }, "a");
    walk.page({ error: "no" }, "a");
    walk.finish();
    const text = walk.problems.join("\n");
    expect(text).toMatch(/cursor did not move on/);
    expect(text).toMatch(/no data array/);
    const short = new MessageWalk({
      files,
      first: 0,
      direction: "asc",
      total: 4,
      limit: 2,
    });
    short.page({ data: rows([0, 1]), next_cursor: null }, null);
    short.finish();
    expect(short.problems.join("\n")).toMatch(/read 2 messages, not the 4/);
  });

  it("hashes the ids in the order read", () => {
    const walk = (numbers: number[]) => {
      const w = new MessageWalk({
        files,
        first: numbers[0] as number,
        direction: "asc",
        total: numbers.length,
        limit: 10,
      });
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

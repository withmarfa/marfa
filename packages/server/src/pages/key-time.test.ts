import { describe, expect, it } from "vitest";
import {
  createdWords,
  dateWords,
  endingTitle,
  endsSoon,
  endsWords,
  lastUsedValue,
  usedWords,
} from "./key-time.js";

const NOW = Date.UTC(2026, 9, 20, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("when a key ends", () => {
  it("says never, today, tomorrow, a count of days, then the date", () => {
    expect(endsWords(null, NOW)).toBe("Never ends");
    expect(endsWords(NOW + 5 * HOUR, NOW)).toBe("Ends today");
    expect(endsWords(NOW + 30 * HOUR, NOW)).toBe("Ends tomorrow");
    expect(endsWords(NOW + 3 * DAY + HOUR, NOW)).toBe("Ends in 3 days");
    expect(endsWords(NOW + 13 * DAY + HOUR, NOW)).toBe("Ends in 13 days");
    expect(endsWords(NOW + 20 * DAY, NOW)).toBe("Ends November 9");
  });

  it("says ended for a time that has passed", () => {
    expect(endsWords(NOW - 1, NOW)).toBe("Ended");
  });

  it("includes the next seven days and excludes expired or later keys", () => {
    expect(endsSoon(NOW + 1, NOW)).toBe(true);
    expect(endsSoon(Date.UTC(2026, 9, 26, 23, 59, 59), NOW)).toBe(true);
    expect(endsSoon(NOW + 7 * DAY, NOW)).toBe(true);
    expect(endsSoon(NOW + 7 * DAY + 1, NOW)).toBe(false);
    expect(endsSoon(NOW, NOW)).toBe(false);
    expect(endsSoon(NOW - DAY, NOW)).toBe(false);
    expect(endsSoon(null, NOW)).toBe(false);
  });

  it("names the key in what Home says needs a look", () => {
    expect(endingTitle("backup", NOW + 5 * HOUR, NOW)).toBe(
      "Key backup ends today",
    );
    expect(endingTitle("backup", NOW + 30 * HOUR, NOW)).toBe(
      "Key backup ends tomorrow",
    );
    expect(endingTitle("backup", NOW + 3 * DAY + HOUR, NOW)).toBe(
      "Key backup ends in 3 days",
    );
  });
});

describe("across midnight", () => {
  const LATE = Date.UTC(2026, 9, 20, 23, 50);
  const EARLY = Date.UTC(2026, 9, 20, 0, 10);

  it("counts a key ending after midnight as ending tomorrow, however few minutes away", () => {
    const after = Date.UTC(2026, 9, 21, 0, 10);
    expect(after - LATE).toBeLessThan(HOUR);
    expect(endsWords(after, LATE)).toBe("Ends tomorrow");
    expect(endingTitle("backup", after, LATE)).toBe("Key backup ends tomorrow");
  });

  it("counts a key ending before the day is out as ending today, however many hours away", () => {
    const before = Date.UTC(2026, 9, 20, 23, 59);
    expect(before - EARLY).toBeGreaterThan(23 * HOUR);
    expect(endsWords(before, EARLY)).toBe("Ends today");
    expect(endingTitle("backup", before, EARLY)).toBe("Key backup ends today");
  });

  it("counts a key ending the day after tomorrow in days, though less than 48 hours away", () => {
    const later = Date.UTC(2026, 9, 22, 0, 10);
    expect(later - LATE).toBeLessThan(2 * DAY);
    expect(endsWords(later, LATE)).toBe("Ends in 2 days");
    expect(endingTitle("backup", later, LATE)).toBe(
      "Key backup ends in 2 days",
    );
  });

  it("uses elapsed time for the seven-day warning across midnight", () => {
    expect(endsSoon(Date.UTC(2026, 9, 26, 23, 59), EARLY)).toBe(true);
    expect(endsSoon(Date.UTC(2026, 9, 27, 0, 10), LATE)).toBe(true);
    expect(
      endsSoon(Date.UTC(2026, 9, 27, 0, 10), Date.UTC(2026, 9, 20, 0, 5)),
    ).toBe(false);
  });

  it("counts a last use by the calendar too", () => {
    expect(
      usedWords(Date.UTC(2026, 9, 19, 23, 50), Date.UTC(2026, 9, 20, 0, 10)),
    ).toBe("Used 20 minutes ago");
    expect(
      usedWords(Date.UTC(2026, 9, 19, 0, 10), Date.UTC(2026, 9, 20, 23, 50)),
    ).toBe("Used yesterday");
    expect(
      usedWords(Date.UTC(2026, 9, 18, 23, 50), Date.UTC(2026, 9, 20, 0, 10)),
    ).toBe("Used 2 days ago");
  });
});

describe("dates", () => {
  it("are written in UTC and carry the year only when far away", () => {
    expect(dateWords(Date.UTC(2026, 9, 24, 23, 59), NOW)).toBe("October 24");
    expect(dateWords(Date.UTC(2027, 9, 20), NOW)).toBe("October 20, 2027");
    expect(dateWords(Date.UTC(2025, 9, 1), NOW)).toBe("October 1, 2025");
  });
});

describe("when a key was last used", () => {
  it("steps from just now through minutes, hours and days to a date", () => {
    expect(usedWords(null, NOW)).toBe("Never used");
    expect(usedWords(NOW - 20_000, NOW)).toBe("Used just now");
    expect(usedWords(NOW - MINUTE, NOW)).toBe("Used 1 minute ago");
    expect(usedWords(NOW - 59 * MINUTE - 59_000, NOW)).toBe(
      "Used 59 minutes ago",
    );
    expect(usedWords(NOW - 3 * HOUR, NOW)).toBe("Used 3 hours ago");
    expect(usedWords(NOW - 30 * HOUR, NOW)).toBe("Used yesterday");
    expect(usedWords(NOW - 5 * DAY, NOW)).toBe("Used 5 days ago");
    expect(usedWords(Date.UTC(2026, 7, 2), NOW)).toBe("Used on August 2");
  });

  it("reads the same on a key's own page without the leading word", () => {
    expect(lastUsedValue(null, NOW)).toBe("Never");
    expect(lastUsedValue(NOW - 3 * HOUR, NOW)).toBe("3 hours ago");
    expect(lastUsedValue(NOW - 20_000, NOW)).toBe("Just now");
    expect(lastUsedValue(NOW - 30 * HOUR, NOW)).toBe("Yesterday");
  });
});

describe("when a key was made", () => {
  it("is just now within the minute and the date after", () => {
    expect(createdWords(NOW - 30_000, NOW)).toBe("Just now");
    expect(createdWords(NOW - 2 * DAY, NOW)).toBe("October 18");
  });
});

/**
 * RFC 5545 recurrence: reading a series' rule lines and unfolding them into
 * start instants, with every step of the walk counted.
 *
 * The walk happens in the series' own wall clock, because "weekly at 09:00"
 * means 09:00 as the series' zone reads it on both sides of a clock change.
 * Each candidate reading is anchored to an instant only once it is known to
 * matter, and every value that names an instant of its own (an `UNTIL` in
 * UTC, an `EXDATE` in another zone) is compared as that instant.
 *
 * Every candidate the walk considers is charged to a `RecurrenceMeter`, and a
 * meter that runs out stops the walk at that candidate. No single step does
 * more than a bounded amount of work before it charges, so a rule that never
 * produces an occurrence costs at most the meter's limit, however it is
 * written. Reading the lines is bounded as well, before any of them is
 * parsed: a series carries at most one RRULE and a capped number of
 * characters in all, its added and removed dates are capped in number, and
 * every rule part is kept once.
 * Web-safe: no Node API is used.
 */
import {
  dateInZoneToInstant,
  instantToWallClock,
  wallClockToInstant,
  zoneOffsetMinutes,
} from "./time-zones.js";

/** A rule line that cannot be read, or asks for something not applied. */
export class RecurrenceRuleError extends Error {}

/** The walk was stopped by its meter before it finished. */
export class RecurrenceBoundError extends Error {}

/** More occurrences fall in the window than the caller allowed. */
export class RecurrenceCapError extends Error {}

/**
 * Candidates one expansion may consider. A candidate is a day of a yearly,
 * monthly, weekly or daily rule, a period of an hourly, minutely or secondly
 * one, or each further time of day a matching day carries. A daily rule
 * spends one a day, so this is centuries of a daily rule and about ten weeks
 * of a per-minute one.
 */
export const RECURRENCE_WORK_LIMIT = 100_000;

/**
 * Wall-clock time one expansion may take before it is stopped, a backstop
 * to the candidate count rather than the bound anything ordinary meets.
 */
export const RECURRENCE_TIME_LIMIT_MS = 1_000;

/** Most characters a series' `recurrence` may hold in all, so reading it is
 *  bounded before any line is parsed. Room for one rule and the most dates
 *  a series may add and remove. */
export const MAX_RECURRENCE_CHARS = 40_000;

/** Most added and removed dates, together, one series may carry. */
export const MAX_RECURRENCE_DATES = 1_000;

/** Longest an event may last, in seconds: a century. */
export const MAX_EVENT_DURATION_SECONDS = 100 * 366 * 86_400;

/** Whether `duration` is a length an occurrence can have. */
export function isEventDuration(duration: number): boolean {
  return (
    Number.isFinite(duration) &&
    duration >= 0 &&
    duration <= MAX_EVENT_DURATION_SECONDS
  );
}

/** Counts the candidates one walk considers and stops it at its limits. */
export class RecurrenceMeter {
  spent = 0;
  private readonly deadline: number;

  constructor(
    readonly limit: number = RECURRENCE_WORK_LIMIT,
    timeLimitMs: number = RECURRENCE_TIME_LIMIT_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.deadline = now() + timeLimitMs;
  }

  charge(units = 1): void {
    this.spent += units;
    if (this.spent > this.limit) {
      throw new RecurrenceBoundError(
        `the rule considers more than ${String(this.limit)} candidates`,
      );
    }
    if ((this.spent & 1023) === 0 && this.now() > this.deadline) {
      throw new RecurrenceBoundError("the rule takes too long to unfold");
    }
  }
}

/** `list[i]`, for an index the caller has already kept in range. */
function nth(list: readonly number[], i: number): number {
  const value = list[i];
  if (value === undefined) throw new RangeError(`no entry at ${String(i)}`);
  return value;
}

// ---------------------------------------------------------------------------
// Calendar arithmetic on whole days counted from 1970-01-01
// ---------------------------------------------------------------------------

const DAY_SECONDS = 86_400;
const LAST_YEAR = 9999;

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719_468;
  const era = Math.floor(zz / 146_097);
  const doe = zz - era * 146_097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36_524) -
      Math.floor(doe / 146_096)) /
      365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [m <= 2 ? era * 400 + yoe + 1 : era * 400 + yoe, m, d];
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  return m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** 0 for Monday through 6 for Sunday, RFC 5545's MO..SU order. */
function weekday(day: number): number {
  return (((day + 3) % 7) + 7) % 7;
}

function weekStart(day: number, wkst: number): number {
  return day - ((weekday(day) - wkst + 7) % 7);
}

/** The week number RFC 5545 gives `day` under `wkst`, and the count of weeks
 *  in that week's year, which may be the calendar year either side. */
function weekNumber(day: number, wkst: number): [number, number] {
  const ws = weekStart(day, wkst);
  const [weekYear] = civilFromDays(ws + 3);
  const first = weekStart(daysFromCivil(weekYear, 1, 4), wkst);
  const next = weekStart(daysFromCivil(weekYear + 1, 1, 4), wkst);
  return [(ws - first) / 7 + 1, (next - first) / 7];
}

// ---------------------------------------------------------------------------
// Reading the lines
// ---------------------------------------------------------------------------

const FREQS = [
  "SECONDLY",
  "MINUTELY",
  "HOURLY",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
] as const;
type Freq = (typeof FREQS)[number];
const SECONDLY = 0;
const MINUTELY = 1;
const HOURLY = 2;
const DAILY = 3;
const WEEKLY = 4;
const MONTHLY = 5;
const YEARLY = 6;

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** A value as a rule line states it. */
type DateValue =
  | { kind: "date"; day: number }
  | { kind: "floating"; wall: number }
  | { kind: "instant"; ms: number };

interface Rule {
  freq: number;
  interval: number;
  count?: number;
  until?: DateValue;
  bysecond?: number[];
  byminute?: number[];
  byhour?: number[];
  byweekday?: Set<number>;
  bynweekday?: { wd: number; n: number }[];
  bymonthday?: number[];
  byyearday?: number[];
  byweekno?: number[];
  bymonth?: number[];
  bysetpos?: number[];
  wkst: number;
}

function fail(message: string): never {
  throw new RecurrenceRuleError(message);
}

function readInt(raw: string, part: string, min: number, max: number): number {
  if (!/^[+-]?\d{1,6}$/.test(raw))
    fail(`${part} has an unreadable value: ${raw}`);
  const n = Number(raw);
  if (n < min || n > max) fail(`${part} value ${raw} is out of range`);
  return n;
}

function readList(
  raw: string,
  part: string,
  min: number,
  max: number,
  signed: boolean,
): number[] {
  const values = raw.split(",").map((v) => {
    const n = signed ? readInt(v, part, -max, max) : readInt(v, part, min, max);
    if (signed && n === 0) fail(`${part} may not be 0`);
    if (!signed && n < min) fail(`${part} value ${v} is out of range`);
    return n;
  });
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Splits `NAME;PARAM=V;PARAM="V":VALUE`, honoring quoted parameter values. */
function splitLine(line: string): {
  name: string;
  params: Map<string, string>;
  value: string;
} {
  let i = 0;
  let quoted = false;
  let colon = -1;
  for (; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) fail(`not a property line: ${line}`);
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1).trim();
  const [rawName = "", ...rawParams] = head.split(";");
  const params = new Map<string, string>();
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq < 0) fail(`unreadable parameter: ${p}`);
    params.set(
      p.slice(0, eq).trim().toUpperCase(),
      p
        .slice(eq + 1)
        .trim()
        .replace(/^"(.*)"$/, "$1"),
    );
  }
  return { name: rawName.trim().toUpperCase(), params, value };
}

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

function readDay(y: string, m: string, d: string, raw: string): number {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (yy < 1 || mm < 1 || mm > 12 || dd < 1 || dd > daysInMonth(yy, mm)) {
    fail(`not a calendar date: ${raw}`);
  }
  return daysFromCivil(yy, mm, dd);
}

function zoneResolves(zone: string): boolean {
  try {
    zoneOffsetMinutes(new Date(0), zone);
    return true;
  } catch {
    return false;
  }
}

/** Reads one date or date-time value, anchoring a `TZID` value at once. */
function readDateValue(raw: string, params: Map<string, string>): DateValue {
  const type = params.get("VALUE");
  const value = raw.trim().toUpperCase();
  const date = DATE_RE.exec(value);
  if (date) {
    if (type !== undefined && type !== "DATE") fail(`${raw} is not a ${type}`);
    const [, y = "", m = "", d = ""] = date;
    return { kind: "date", day: readDay(y, m, d, raw) };
  }
  const dt = DATE_TIME_RE.exec(value);
  if (!dt) fail(`not a date or date-time: ${raw}`);
  if (type !== undefined && type !== "DATE-TIME")
    fail(`${raw} is not a ${type}`);
  const [hh, mi, ss] = [Number(dt[4]), Number(dt[5]), Number(dt[6])];
  if (hh > 23 || mi > 59 || ss > 59) fail(`not a time of day: ${raw}`);
  const wall =
    readDay(dt[1] ?? "", dt[2] ?? "", dt[3] ?? "", raw) * DAY_SECONDS +
    hh * 3600 +
    mi * 60 +
    ss;
  if (dt[7] === "Z") return { kind: "instant", ms: wall * 1000 };
  const tzid = params.get("TZID");
  if (tzid !== undefined) {
    if (!zoneResolves(tzid)) fail(`TZID does not name a time zone: ${tzid}`);
    return {
      kind: "instant",
      ms: wallClockToInstant(new Date(wall * 1000), tzid).getTime(),
    };
  }
  return { kind: "floating", wall };
}

function readRule(value: string): Rule {
  const parts = new Map<string, string>();
  for (const piece of value.split(";")) {
    if (piece.trim() === "") continue;
    const eq = piece.indexOf("=");
    if (eq < 0) fail(`unreadable rule part: ${piece}`);
    const key = piece.slice(0, eq).trim().toUpperCase();
    if (parts.has(key)) fail(`${key} appears twice`);
    parts.set(
      key,
      piece
        .slice(eq + 1)
        .trim()
        .toUpperCase(),
    );
  }
  const freqName = parts.get("FREQ");
  if (freqName === undefined) fail("the rule names no FREQ");
  const freq = FREQS.indexOf(freqName as Freq);
  if (freq < 0) fail(`unknown FREQ: ${freqName}`);
  const rule: Rule = { freq, interval: 1, wkst: 0 };

  for (const [key, raw] of parts) {
    switch (key) {
      case "FREQ":
        break;
      case "INTERVAL":
        rule.interval = readInt(raw, key, 1, 1_000_000);
        break;
      case "COUNT":
        rule.count = readInt(raw, key, 1, 1_000_000);
        break;
      case "UNTIL":
        rule.until = readDateValue(raw, new Map());
        break;
      case "BYSECOND":
        rule.bysecond = readList(raw, key, 0, 60, false);
        break;
      case "BYMINUTE":
        rule.byminute = readList(raw, key, 0, 59, false);
        break;
      case "BYHOUR":
        rule.byhour = readList(raw, key, 0, 23, false);
        break;
      case "BYMONTHDAY":
        rule.bymonthday = readList(raw, key, 1, 31, true);
        break;
      case "BYYEARDAY":
        rule.byyearday = readList(raw, key, 1, 366, true);
        break;
      case "BYWEEKNO":
        rule.byweekno = readList(raw, key, 1, 53, true);
        break;
      case "BYMONTH":
        rule.bymonth = readList(raw, key, 1, 12, false);
        break;
      case "BYSETPOS":
        rule.bysetpos = readList(raw, key, 1, 366, true);
        break;
      case "WKST": {
        const wd = WEEKDAYS.indexOf(raw);
        if (wd < 0) fail(`unknown WKST: ${raw}`);
        rule.wkst = wd;
        break;
      }
      case "BYDAY": {
        const seen = new Set<string>();
        for (const entry of raw.split(",")) {
          const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(
            entry.trim(),
          );
          if (!m) fail(`unreadable BYDAY entry: ${entry}`);
          const wd = WEEKDAYS.indexOf(m[2] ?? "");
          if (m[1] === undefined) {
            (rule.byweekday ??= new Set()).add(wd);
          } else {
            const n = readInt(m[1], key, -53, 53);
            if (n === 0) fail("BYDAY may not number a weekday 0");
            const slot = `${String(n)}:${String(wd)}`;
            if (!seen.has(slot)) {
              seen.add(slot);
              (rule.bynweekday ??= []).push({ wd, n });
            }
          }
        }
        break;
      }
      default:
        fail(`unknown rule part: ${key}`);
    }
  }

  if (rule.count !== undefined && rule.until !== undefined) {
    fail("COUNT and UNTIL may not both be given");
  }
  if (rule.bynweekday && rule.freq !== MONTHLY && rule.freq !== YEARLY) {
    fail("a numbered BYDAY needs FREQ=MONTHLY or FREQ=YEARLY");
  }
  if (rule.bynweekday && rule.freq === YEARLY && rule.byweekno) {
    fail("a numbered BYDAY may not be combined with BYWEEKNO");
  }
  if (rule.bymonthday && rule.freq === WEEKLY) {
    fail("BYMONTHDAY does not apply to FREQ=WEEKLY");
  }
  if (
    rule.byyearday &&
    (rule.freq === DAILY || rule.freq === WEEKLY || rule.freq === MONTHLY)
  ) {
    fail(`BYYEARDAY does not apply to FREQ=${FREQS[rule.freq]}`);
  }
  if (rule.byweekno && rule.freq !== YEARLY) {
    fail("BYWEEKNO needs FREQ=YEARLY");
  }
  if (
    rule.bysetpos &&
    !(
      rule.bysecond ||
      rule.byminute ||
      rule.byhour ||
      rule.byweekday ||
      rule.bynweekday ||
      rule.bymonthday ||
      rule.byyearday ||
      rule.byweekno ||
      rule.bymonth
    )
  ) {
    fail("BYSETPOS needs another BY rule part to select from");
  }
  return rule;
}

// ---------------------------------------------------------------------------
// A series, compiled
// ---------------------------------------------------------------------------

/** What a series states about when it happens. */
export interface RecurrenceSchedule {
  /** The first occurrence: an instant, or a bare date for a whole day. */
  starts_at: string;
  ends_at?: string;
  /** Length in seconds, read when there is no `ends_at`. */
  duration?: number;
  all_day?: boolean;
  /** IANA zone the schedule keeps its wall clock in; absent means UTC. */
  timezone?: string;
  /** RFC 5545 RRULE, RDATE and EXDATE property lines. */
  recurrence: readonly string[];
}

/** A schedule read once, ready to be unfolded over any window. */
export interface CompiledSchedule {
  readonly zone: string | undefined;
  readonly allDay: boolean;
  /** The first occurrence as an instant, in milliseconds. */
  readonly startMs: number;
  /** The first occurrence's reading in the zone, in seconds; for a whole
   *  day, its midnight. */
  readonly startWall: number;
  readonly rules: readonly Rule[];
  /** Added occurrences, as instants in milliseconds. */
  readonly rdates: readonly number[];
  readonly exInstants: ReadonlySet<number>;
  /** Removed whole days, matched against an occurrence's date in the zone. */
  readonly exDays: ReadonlySet<number>;
  /** How long each occurrence lasts: elapsed milliseconds, or whole days. */
  readonly length: { ms: number } | { days: number };
}

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayOfIso(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return daysFromCivil(y, m, d);
}

function isoOfDay(day: number): string {
  const [y, m, d] = civilFromDays(day);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The date `instant` falls on in `zone`, as a day number. */
function dayInZone(ms: number, zone: string | undefined): number {
  return Math.floor(
    instantToWallClock(new Date(ms), zone).getTime() / 86_400_000,
  );
}

/** The day `value` names, read as a day number in `zone`. */
function dayOfValue(value: string, zone: string | undefined): number {
  return BARE_DATE.test(value)
    ? dayOfIso(value)
    : dayInZone(Date.parse(value), zone);
}

/** Midnight of `day` in `zone`, as an instant in milliseconds. */
function midnightMs(day: number, zone: string | undefined): number {
  return Date.parse(dateInZoneToInstant(isoOfDay(day), zone) ?? "");
}

/**
 * Read a schedule's lines against its start, refusing anything that cannot
 * be read or would not be applied as written.
 */
export function compileSchedule(
  schedule: RecurrenceSchedule,
): CompiledSchedule {
  const zone = schedule.timezone === "" ? undefined : schedule.timezone;
  if (zone !== undefined && !zoneResolves(zone)) {
    fail(`the timezone does not resolve: ${zone}`);
  }
  const allDay = schedule.all_day === true;
  const parsedStart = Date.parse(schedule.starts_at);
  if (Number.isNaN(parsedStart)) fail("starts_at cannot be read");

  let startMs: number;
  let startWall: number;
  if (allDay) {
    const day = dayOfValue(schedule.starts_at, zone);
    startWall = day * DAY_SECONDS;
    startMs = midnightMs(day, zone);
  } else {
    startMs = Math.floor(parsedStart / 1000) * 1000;
    startWall = Math.floor(
      instantToWallClock(new Date(startMs), zone).getTime() / 1000,
    );
  }

  const rules: Rule[] = [];
  const rdates: number[] = [];
  const exInstants = new Set<number>();
  const exDays = new Set<number>();
  const startTime = ((startWall % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  const anchor = (value: DateValue): number => {
    if (value.kind === "instant") return value.ms;
    if (value.kind === "date") {
      return allDay
        ? midnightMs(value.day, zone)
        : wallMs(value.day * DAY_SECONDS + startTime, zone);
    }
    return allDay
      ? midnightMs(Math.floor(value.wall / DAY_SECONDS), zone)
      : wallMs(value.wall, zone);
  };

  if (
    typeof schedule.duration === "number" &&
    !isEventDuration(schedule.duration)
  ) {
    fail(
      `duration must be between 0 and ${String(MAX_EVENT_DURATION_SECONDS)} seconds`,
    );
  }
  let dates = 0;
  const countDates = (values: string[]): string[] => {
    dates += values.length;
    if (dates > MAX_RECURRENCE_DATES) {
      fail(
        `a series may add and remove at most ${String(MAX_RECURRENCE_DATES)} dates`,
      );
    }
    return values;
  };

  let chars = 0;
  let rrules = 0;
  for (const rawLine of schedule.recurrence) {
    chars += rawLine.length;
    if (chars > MAX_RECURRENCE_CHARS) {
      fail(
        `a recurrence may hold at most ${String(MAX_RECURRENCE_CHARS)} characters in all`,
      );
    }
    if (/^\s*RRULE[;:]/i.test(rawLine)) rrules += 1;
  }
  // RFC 5545 gives a series one RRULE.
  if (rrules > 1) fail("a series carries at most one RRULE");

  for (const rawLine of schedule.recurrence) {
    const line = rawLine.trim();
    if (line === "") continue;
    const { name, params, value } = splitLine(line);
    switch (name) {
      case "RRULE": {
        const rule = readRule(value);
        if (
          allDay &&
          (rule.freq < DAILY || rule.byhour || rule.byminute || rule.bysecond)
        ) {
          fail(
            "a whole-day series repeats by days, not by hours, minutes or seconds",
          );
        }
        rules.push(rule);
        break;
      }
      case "RDATE":
        if (params.get("VALUE") === "PERIOD") {
          fail(
            "RDATE periods are not applied; give each added start as a date or date-time",
          );
        }
        for (const v of countDates(value.split(",")))
          rdates.push(anchor(readDateValue(v, params)));
        break;
      case "EXDATE":
        for (const v of countDates(value.split(","))) {
          const parsed = readDateValue(v, params);
          if (parsed.kind === "date") exDays.add(parsed.day);
          else if (allDay) {
            exDays.add(
              parsed.kind === "floating"
                ? Math.floor(parsed.wall / DAY_SECONDS)
                : dayInZone(parsed.ms, zone),
            );
          } else exInstants.add(anchor(parsed));
        }
        break;
      case "EXRULE":
        fail("EXRULE is not applied; express exclusions as EXDATE lines");
        break;
      default:
        fail(
          `${name} is not a recurrence property; use RRULE, RDATE or EXDATE`,
        );
    }
  }

  let length: CompiledSchedule["length"];
  if (allDay) {
    const endDay =
      schedule.ends_at !== undefined &&
      !Number.isNaN(Date.parse(schedule.ends_at))
        ? dayOfValue(schedule.ends_at, zone)
        : undefined;
    const days =
      endDay !== undefined
        ? endDay - startWall / DAY_SECONDS
        : typeof schedule.duration === "number"
          ? Math.ceil(schedule.duration / DAY_SECONDS)
          : 1;
    length = { days: Math.max(1, days) };
  } else {
    const end =
      schedule.ends_at !== undefined
        ? Date.parse(schedule.ends_at)
        : Number.NaN;
    const ms = !Number.isNaN(end)
      ? end - parsedStart
      : typeof schedule.duration === "number" &&
          Number.isFinite(schedule.duration)
        ? schedule.duration * 1000
        : 0;
    length = { ms: Math.max(0, ms) };
  }

  return {
    zone,
    allDay,
    startMs,
    startWall,
    rules,
    rdates,
    exInstants,
    exDays,
    length,
  };
}

function wallMs(wall: number, zone: string | undefined): number {
  return wallClockToInstant(new Date(wall * 1000), zone).getTime();
}

/** When an occurrence starting at `startMs` ends, in milliseconds. */
export function occurrenceEndMs(
  schedule: CompiledSchedule,
  startMs: number,
): number {
  if ("ms" in schedule.length) return startMs + schedule.length.ms;
  return midnightMs(
    dayInZone(startMs, schedule.zone) + schedule.length.days,
    schedule.zone,
  );
}

/**
 * The span a whole-day event occupies, single or repeating: from midnight of
 * the day it starts on to midnight of the day it ends on, in `timezone`, or
 * in UTC when it names none. It is the first occurrence of the schedule
 * `compileSchedule` reads for a whole-day series, so the two cannot place the
 * same day differently.
 */
export function wholeDaySpan(
  event: Pick<
    RecurrenceSchedule,
    "starts_at" | "ends_at" | "duration" | "timezone"
  >,
): { startMs: number; endMs: number } {
  const compiled = compileSchedule({
    ...event,
    all_day: true,
    recurrence: [],
  });
  return {
    startMs: compiled.startMs,
    endMs: occurrenceEndMs(compiled, compiled.startMs),
  };
}

/** The longest an occurrence can last, for looking back past a window. */
function maxLengthMs(schedule: CompiledSchedule): number {
  return "ms" in schedule.length
    ? schedule.length.ms
    : schedule.length.days * 86_400_000 + 3_600_000;
}

// ---------------------------------------------------------------------------
// Walking one rule
// ---------------------------------------------------------------------------

interface Walk {
  rule: Rule;
  hours: number[];
  minutes: number[];
  seconds: number[];
}

function prepare(rule: Rule, startWall: number): Walk {
  const startDay = Math.floor(startWall / DAY_SECONDS);
  const [, month, monthDay] = civilFromDays(startDay);
  const tod = startWall - startDay * DAY_SECONDS;
  const r: Rule = { ...rule };
  if (!(
    r.byweekno ||
    r.byyearday ||
    r.bymonthday ||
    r.byweekday ||
    r.bynweekday
  )) {
    if (r.freq === YEARLY) {
      r.bymonth ??= [month];
      r.bymonthday = [monthDay];
    } else if (r.freq === MONTHLY) {
      r.bymonthday = [monthDay];
    } else if (r.freq === WEEKLY) {
      r.byweekday = new Set([weekday(startDay)]);
    }
  }
  return {
    rule: r,
    hours:
      r.freq > HOURLY
        ? (r.byhour ?? [Math.floor(tod / 3600)])
        : (r.byhour ?? []),
    minutes:
      r.freq > MINUTELY
        ? (r.byminute ?? [Math.floor((tod % 3600) / 60)])
        : (r.byminute ?? []),
    // A leap second names a reading no clock here shows, so it is never one.
    seconds: (r.freq > SECONDLY
      ? (r.bysecond ?? [tod % 60])
      : (r.bysecond ?? [])
    ).filter((s) => s < 60),
  };
}

/** Whether `day` passes the day-level parts of `rule`. `marked` holds the
 *  days a numbered BYDAY selected in the current period. */
function dayMatches(
  rule: Rule,
  day: number,
  marked: Set<number> | undefined,
): boolean {
  const [y, m, d] = civilFromDays(day);
  if (rule.bymonth && !rule.bymonth.includes(m)) return false;
  if (rule.byweekno) {
    const [n, weeks] = weekNumber(day, rule.wkst);
    if (!rule.byweekno.includes(n) && !rule.byweekno.includes(n - weeks - 1)) {
      return false;
    }
  }
  if (rule.byyearday) {
    const yd = day - daysFromCivil(y, 1, 1) + 1;
    const len = isLeap(y) ? 366 : 365;
    if (
      !rule.byyearday.includes(yd) &&
      !rule.byyearday.includes(yd - len - 1)
    ) {
      return false;
    }
  }
  if (rule.bymonthday) {
    const dim = daysInMonth(y, m);
    if (
      !rule.bymonthday.includes(d) &&
      !rule.bymonthday.includes(d - dim - 1)
    ) {
      return false;
    }
  }
  if (rule.byweekday || rule.bynweekday) {
    const plain = rule.byweekday?.has(weekday(day)) === true;
    if (!plain && marked?.has(day) !== true) return false;
  }
  return true;
}

/** The days a numbered BYDAY picks out of each range of a period. */
function markNumbered(
  rule: Rule,
  ranges: [number, number][],
): Set<number> | undefined {
  if (!rule.bynweekday) return undefined;
  const marked = new Set<number>();
  for (const [first, last] of ranges) {
    for (const { wd, n } of rule.bynweekday) {
      const day =
        n > 0
          ? first + ((wd - weekday(first) + 7) % 7) + (n - 1) * 7
          : last - ((weekday(last) - wd + 7) % 7) + (n + 1) * 7;
      if (day >= first && day <= last) marked.add(day);
    }
  }
  return marked;
}

/** The selected members of a period's sorted candidates, `size` long, read
 *  through `at`. BYSETPOS indexes into the whole set; without it, all. */
function* selectPositions(
  bysetpos: number[] | undefined,
  size: number,
  at: (index: number) => number,
): Generator<number> {
  if (!bysetpos) {
    for (let i = 0; i < size; i += 1) yield at(i);
    return;
  }
  const picked = new Set<number>();
  for (const pos of bysetpos) {
    const i = pos > 0 ? pos - 1 : size + pos;
    if (i >= 0 && i < size) picked.add(i);
  }
  for (const i of [...picked].sort((a, b) => a - b)) yield at(i);
}

/**
 * Every reading `rule` produces at or after `startWall`, ascending, in
 * wall-clock seconds, until one passes `stopWall` or the calendar ends.
 * Each candidate considered is charged to `meter` before anything else is
 * done with it.
 */
function* walkRule(
  walk: Walk,
  startWall: number,
  stopWall: number,
  meter: RecurrenceMeter,
): Generator<number> {
  const { rule, hours, minutes, seconds } = walk;
  const startDay = Math.floor(startWall / DAY_SECONDS);
  const lastDay = daysFromCivil(LAST_YEAR, 12, 31);
  const stopDay = Math.min(Math.floor(stopWall / DAY_SECONDS), lastDay);

  if (rule.freq >= DAILY) {
    const times = hours.length * minutes.length * seconds.length;
    const timeAt = (i: number): number => {
      const ms = minutes.length * seconds.length;
      return (
        nth(hours, Math.floor(i / ms)) * 3600 +
        nth(minutes, Math.floor((i % ms) / seconds.length)) * 60 +
        nth(seconds, i % seconds.length)
      );
    };
    const [startYear, startMonth] = civilFromDays(startDay);
    const startWeek = weekStart(startDay, rule.wkst);
    for (let k = 0; ; k += 1) {
      // The period's days, and the ranges a numbered BYDAY counts within.
      let first: number;
      let last: number;
      let ranges: [number, number][] = [];
      let months: number[] | undefined;
      if (rule.freq === YEARLY) {
        const y = startYear + k * rule.interval;
        if (y > LAST_YEAR) return;
        first = daysFromCivil(y, 1, 1);
        last = daysFromCivil(y, 12, 31);
        months = rule.bymonth;
        ranges =
          rule.bymonth && rule.bynweekday
            ? rule.bymonth.map((m) => [
                daysFromCivil(y, m, 1),
                daysFromCivil(y, m, daysInMonth(y, m)),
              ])
            : [[first, last]];
      } else if (rule.freq === MONTHLY) {
        const index = startYear * 12 + (startMonth - 1) + k * rule.interval;
        const y = Math.floor(index / 12);
        const m = (index % 12) + 1;
        if (y > LAST_YEAR) return;
        first = daysFromCivil(y, m, 1);
        last = daysFromCivil(y, m, daysInMonth(y, m));
        ranges = [[first, last]];
      } else if (rule.freq === WEEKLY) {
        first = startWeek + k * rule.interval * 7;
        last = first + 6;
      } else {
        first = startDay + k * rule.interval;
        last = first;
      }
      if (first > stopDay) return;

      const marked = markNumbered(rule, ranges);
      const days: number[] = [];
      const scan = (from: number, to: number): void => {
        // From the period's own first day, not the series' start: BYSETPOS
        // counts positions over the whole period.
        for (let day = from; day <= to; day += 1) {
          meter.charge();
          if (dayMatches(rule, day, marked)) days.push(day);
        }
      };
      if (months) {
        const [y] = civilFromDays(first);
        for (const m of months) {
          scan(daysFromCivil(y, m, 1), daysFromCivil(y, m, daysInMonth(y, m)));
        }
      } else {
        scan(first, last);
      }

      let previous = -1;
      for (const wall of selectPositions(
        rule.bysetpos,
        days.length * times,
        (i) => {
          return (
            nth(days, Math.floor(i / times)) * DAY_SECONDS + timeAt(i % times)
          );
        },
      )) {
        // The first time of a matching day was paid for by the day itself.
        if (Math.floor(wall / DAY_SECONDS) === previous) meter.charge();
        previous = Math.floor(wall / DAY_SECONDS);
        if (wall < startWall) continue;
        if (wall > stopWall) return;
        yield wall;
      }
    }
  }

  // Hourly, minutely and secondly: one period per step, skipping a whole
  // day, hour or minute at once when the parts above the period rule it out.
  const unit = rule.freq === HOURLY ? 3600 : rule.freq === MINUTELY ? 60 : 1;
  const step = unit * rule.interval;
  const base = startWall - (startWall % unit);
  const stop = Math.min(stopWall, (lastDay + 1) * DAY_SECONDS - 1);
  let k = 0;
  const skipTo = (wall: number): void => {
    k = Math.max(k + 1, Math.ceil((wall - base) / step));
  };
  const inner =
    rule.freq === HOURLY
      ? minutes.length * seconds.length
      : rule.freq === MINUTELY
        ? seconds.length
        : 1;
  for (;;) {
    const t = base + k * step;
    if (t > stop) return;
    meter.charge();
    const day = Math.floor(t / DAY_SECONDS);
    const tod = t - day * DAY_SECONDS;
    if (!dayMatches(rule, day, undefined)) {
      skipTo((day + 1) * DAY_SECONDS);
      continue;
    }
    const hour = Math.floor(tod / 3600);
    if (rule.byhour && !rule.byhour.includes(hour)) {
      skipTo(day * DAY_SECONDS + (hour + 1) * 3600);
      continue;
    }
    const minute = Math.floor((tod % 3600) / 60);
    if (
      rule.freq <= MINUTELY &&
      rule.byminute &&
      !rule.byminute.includes(minute)
    ) {
      skipTo(day * DAY_SECONDS + hour * 3600 + (minute + 1) * 60);
      continue;
    }
    if (
      rule.freq === SECONDLY &&
      rule.bysecond &&
      !rule.bysecond.includes(tod % 60)
    ) {
      k += 1;
      continue;
    }
    const at = (i: number): number =>
      rule.freq === HOURLY
        ? t +
          nth(minutes, Math.floor(i / seconds.length)) * 60 +
          nth(seconds, i % seconds.length)
        : rule.freq === MINUTELY
          ? t + nth(seconds, i)
          : t;
    let firstInPeriod = true;
    for (const wall of selectPositions(rule.bysetpos, inner, at)) {
      if (!firstInPeriod) meter.charge();
      firstInPeriod = false;
      if (wall < startWall) continue;
      if (wall > stopWall) return;
      yield wall;
    }
    k += 1;
  }
}

// ---------------------------------------------------------------------------
// Unfolding a schedule
// ---------------------------------------------------------------------------

/** Whether `wall` lies past a rule's UNTIL, compared in the UNTIL's own terms. */
function pastUntil(
  until: DateValue,
  wall: number,
  schedule: CompiledSchedule,
): boolean {
  if (until.kind === "date") return Math.floor(wall / DAY_SECONDS) > until.day;
  if (until.kind === "floating") return wall > until.wall;
  const untilWall = Math.floor(
    instantToWallClock(new Date(until.ms), schedule.zone).getTime() / 1000,
  );
  if (wall < untilWall - DAY_SECONDS) return false;
  if (wall > untilWall + DAY_SECONDS) return true;
  return anchorWall(schedule, wall) > until.ms;
}

/** The furthest reading an UNTIL can still admit, for ending a walk. */
function untilStopWall(
  until: DateValue | undefined,
  schedule: CompiledSchedule,
): number {
  if (until === undefined) return Number.POSITIVE_INFINITY;
  if (until.kind === "date") return (until.day + 1) * DAY_SECONDS - 1;
  if (until.kind === "floating") return until.wall;
  return (
    Math.floor(
      instantToWallClock(new Date(until.ms), schedule.zone).getTime() / 1000,
    ) + DAY_SECONDS
  );
}

function anchorWall(schedule: CompiledSchedule, wall: number): number {
  return schedule.allDay
    ? midnightMs(Math.floor(wall / DAY_SECONDS), schedule.zone)
    : wallMs(wall, schedule.zone);
}

/**
 * Every occurrence of `schedule` that overlaps `[fromMs, toMs)`, as start
 * instants in ascending order with removed dates taken out. An occurrence of
 * no length overlaps when it starts inside the window. The first occurrence is
 * always the series' own start, as RFC 5545 counts it. More than `cap` raises
 * `RecurrenceCapError` at the one past it.
 */
export function occurrenceStarts(
  schedule: CompiledSchedule,
  fromMs: number,
  toMs: number,
  meter: RecurrenceMeter,
  cap: number = Number.POSITIVE_INFINITY,
): number[] {
  const lookback = maxLengthMs(schedule);
  const lo = fromMs - lookback;
  const loWall =
    Math.floor(
      instantToWallClock(new Date(lo), schedule.zone).getTime() / 1000,
    ) - DAY_SECONDS;
  const hiWall =
    Math.floor(
      instantToWallClock(new Date(toMs), schedule.zone).getTime() / 1000,
    ) + DAY_SECONDS;
  const found = new Set<number>();
  const consider = (ms: number): void => {
    if (ms >= toMs || ms < lo) return;
    const end = occurrenceEndMs(schedule, ms);
    if (!(end > fromMs || (end === ms && ms >= fromMs))) return;
    if (schedule.exInstants.has(ms)) return;
    if (
      schedule.exDays.size > 0 &&
      schedule.exDays.has(dayInZone(ms, schedule.zone))
    ) {
      return;
    }
    found.add(ms);
    if (found.size > cap) {
      throw new RecurrenceCapError(
        `more than ${String(cap)} occurrences fall in this window`,
      );
    }
  };

  consider(schedule.startMs);
  for (const rule of schedule.rules) {
    const walk = prepare(rule, schedule.startWall);
    let produced = 1;
    const stopWall = Math.min(hiWall, untilStopWall(rule.until, schedule));
    for (const wall of walkRule(walk, schedule.startWall, stopWall, meter)) {
      if (wall === schedule.startWall) continue;
      if (rule.count !== undefined && produced >= rule.count) break;
      if (rule.until !== undefined && pastUntil(rule.until, wall, schedule))
        break;
      produced += 1;
      if (wall < loWall) continue;
      consider(anchorWall(schedule, wall));
    }
  }
  for (const ms of schedule.rdates) consider(ms);

  return [...found].sort((a, b) => a - b);
}

/**
 * Why a schedule's rule could not be unfolded at read time, or `undefined`
 * when every rule either produces an occurrence after the start within the
 * meter or ends by its own COUNT or UNTIL.
 *
 * A rule that walks to the end of the calendar or exhausts the meter without
 * producing anything never repeats the event, and one that would only do so
 * past the meter is one no read can unfold: both are refused when written.
 */
export function scheduleProblem(
  schedule: CompiledSchedule,
  meter: RecurrenceMeter = new RecurrenceMeter(),
): string | undefined {
  for (const rule of schedule.rules) {
    if (rule.count === 1) continue;
    if (namesNoDay(rule)) {
      return "the rule never produces an occurrence after the start: no month it names has a day it names";
    }
    const walk = prepare(rule, schedule.startWall);
    let found = false;
    try {
      for (const wall of walkRule(
        walk,
        schedule.startWall,
        untilStopWall(rule.until, schedule),
        meter,
      )) {
        if (wall === schedule.startWall) continue;
        found = true;
        break;
      }
    } catch (err) {
      if (!(err instanceof RecurrenceBoundError)) throw err;
      return `the rule produces no occurrence after the start within ${String(meter.limit)} candidates, so it cannot be unfolded`;
    }
    if (!found && rule.until === undefined) {
      return "the rule never produces an occurrence after the start: no date it names exists";
    }
  }
  return undefined;
}

/** Whether no month a rule can reach has any day of the month it names. */
function namesNoDay(rule: Rule): boolean {
  const monthDays = rule.bymonthday;
  if (!monthDays) return false;
  const longest = (m: number): number =>
    m === 2 ? 29 : [4, 6, 9, 11].includes(m) ? 30 : 31;
  const months = rule.bymonth ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  return !months.some((m) => monthDays.some((d) => Math.abs(d) <= longest(m)));
}

/** The issues the schedule fields of an event raise, each naming its field. */
export function eventScheduleIssues(
  properties: Record<string, unknown>,
): { field: string; message: string }[] {
  const issues: { field: string; message: string }[] = [];
  if (
    typeof properties.duration === "number" &&
    !isEventDuration(properties.duration)
  ) {
    issues.push({
      field: "duration",
      message: `Expected a length in seconds from 0 to ${String(MAX_EVENT_DURATION_SECONDS)}`,
    });
  }
  for (const field of ["timezone", "end_timezone"]) {
    const zone = properties[field];
    if (zone === undefined || zone === null) continue;
    if (typeof zone !== "string" || !isEventTimeZone(zone)) {
      issues.push({
        field,
        message:
          "Expected an IANA time zone name the zone database resolves, e.g. Europe/Berlin",
      });
    }
  }
  const recurrence = properties.recurrence;
  if (recurrence === undefined || recurrence === null) return issues;
  if (!Array.isArray(recurrence)) return issues;
  if (recurrence.length === 0) return issues;
  if (!recurrence.every((line) => typeof line === "string")) {
    issues.push({
      field: "recurrence",
      message: "Expected every entry to be an RFC 5545 property line",
    });
    return issues;
  }
  // A schedule the zone or the length already fails is not read further:
  // the rule would be refused for the same reason under its own name.
  if (issues.some((i) => i.field === "timezone" || i.field === "duration")) {
    return issues;
  }
  const startsAt = properties.starts_at;
  if (typeof startsAt !== "string") {
    issues.push({
      field: "recurrence",
      message: "A recurrence rule needs starts_at to unfold from",
    });
    return issues;
  }
  try {
    const compiled = compileSchedule({
      starts_at: startsAt,
      ...(typeof properties.ends_at === "string"
        ? { ends_at: properties.ends_at }
        : {}),
      ...(typeof properties.duration === "number"
        ? { duration: properties.duration }
        : {}),
      all_day: properties.all_day === true,
      ...(typeof properties.timezone === "string"
        ? { timezone: properties.timezone }
        : {}),
      recurrence,
    });
    const problem = scheduleProblem(compiled);
    if (problem !== undefined)
      issues.push({ field: "recurrence", message: capitalize(problem) });
  } catch (err) {
    if (!(err instanceof RecurrenceRuleError)) throw err;
    issues.push({ field: "recurrence", message: capitalize(err.message) });
  }
  return issues;
}

/**
 * Whether `zone` is a zone name the zone database resolves. A numeric offset
 * such as `+01:00` resolves too, but names no zone and keeps no wall clock
 * across a change, so it is not one.
 */
export function isEventTimeZone(zone: string): boolean {
  return /^[A-Za-z]/.test(zone) && zoneResolves(zone);
}

function capitalize(message: string): string {
  return message.charAt(0).toUpperCase() + message.slice(1);
}

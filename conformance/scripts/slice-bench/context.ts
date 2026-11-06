import type { Recorder } from "./figures.js";

/** What every step of one run shares. */
export interface Context {
  state: string;
  items: number;
  /** Timed requests per read measurement. */
  repeats: number;
  /** Items written one `POST /items` at a time. */
  singles: number;
  /** Restarts and fresh boots timed for the start-time figures. */
  starts: number;
  /** How long the server is left alone before a resting memory reading. */
  settleMs: number;
  /** How long after the bulk load the last resting reading is taken. */
  restMs: number;
  record: Recorder;
  /** Ids of the N loaded items, in position order. */
  ids: string[];
  /** Ids of the items the single creates wrote, which the delete step uses. */
  singleIds: string[];
}

export const WARM_UP = 20;

/** `id` of an item answer, flat or wrapped with its metadata. */
export function idOf(body: unknown): string | undefined {
  const record = body as { id?: unknown; item?: { id?: unknown } } | undefined;
  const id = record?.id ?? record?.item?.id;
  return typeof id === "string" ? id : undefined;
}

export function versionOf(body: unknown): number | undefined {
  const record = body as
    { version?: unknown; item?: { version?: unknown } } | undefined;
  const version = record?.version ?? record?.item?.version;
  return typeof version === "number" ? version : undefined;
}

/** `count` indexes spread evenly over a list of `length`. */
export function spread(i: number, count: number, length: number): number {
  return Math.floor(((i % count) * length) / count) % length;
}

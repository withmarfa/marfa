/**
 * What a fixture asks a device to do, and what it answers.
 *
 * The device under test is a separate program, so everything here is an
 * operation a program can be asked to perform and an answer it can report.
 * A refusal arrives as data on `ok`, the way `MarfaClient` reports one, so a
 * fixture asserts a refusal the same way it asserts a success — the device
 * chapters are mostly refusals, and a thrown refusal would have to be caught
 * before it could be read.
 */

export type Tier = "library" | "feed";

export interface Refusal {
  /** The adapter's reading of the device's refusal. `unclassified` when it could not read one. */
  code: string;
  /** Everything the device said, kept so a failing assertion can print it. */
  raw: string;
}

export type Outcome<T> =
  { ok: true; value: T } | { ok: false; refusal: Refusal };

export interface Item {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  state: string;
  tier?: Tier | null;
  version: number;
  source: string;
  source_id?: string | null;
  timestamp: string;
  created_at: string;
  updated_at: string;
  tags: string[];
}

export interface HydrateReport {
  types: string[];
  tier: Tier;
  items: number;
  edges: number;
  pages: number;
  cursor: string;
}

export interface CatchUpReport {
  applied: number;
  skipped: number;
  cursor: string;
  reached_head: boolean;
}

export interface Status {
  server_origin?: string | null;
  slice_types: string[];
  slice_tier?: Tier | null;
  event_cursor?: string | null;
  hydration: "never" | "in_progress" | "complete";
  items: number;
  edges: number;
}

export interface SearchHit {
  item: Item;
  score: number;
  snippet: string;
}

export interface ListFilters {
  type?: string;
  state?: string;
  includeTrashed?: boolean;
  tier?: Tier;
  tags?: string[];
  limit?: number;
  /** A filter the device is not expected to implement, so a fixture can check it is refused. */
  unsupported?: [string, string];
}

/**
 * A device, as the fixtures drive it.
 *
 * The read half only. The write half is the milestone's, and the operations
 * it needs are added here as the binary grows the commands behind them; until
 * then a fixture that needs one is pending against the statement it will
 * assert (`pending.ts`).
 */
export interface DeviceUnderTest {
  /** The store this device reads and writes. One device, one store. */
  readonly store: string;

  hydrate(types: string[], tier: Tier): Promise<Outcome<HydrateReport>>;
  catchUp(): Promise<Outcome<CatchUpReport>>;
  list(filters?: ListFilters): Promise<Outcome<Item[]>>;
  get(id: string): Promise<Outcome<Item>>;
  search(query: string, limit?: number): Promise<Outcome<SearchHit[]>>;
  status(): Promise<Outcome<Status>>;

  /** A second device over the same store, for the one-writer rule. */
  reopen(options?: { url?: string; key?: string }): DeviceUnderTest;
}

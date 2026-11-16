import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  answers,
  edgesPage,
  refusal,
  typeCatalog,
  wireEdge,
  wireItem,
  wireType,
  writeAnswers,
  type WireEdgeOptions,
} from "../../device/marfa-answers.js";
import type {
  DrainReport,
  Outcome,
  QueuedWrite,
} from "../../device/protocol.js";
import {
  CONTRACT_HEADER,
  type Answer,
  type RecordedRequest,
} from "../../device/scripted-server.js";
import {
  folderHarness,
  hydratedHarness,
  type FolderHarness,
  type Harness,
} from "./harness.js";
import {
  EdgeDoor,
  put,
  scriptFolderWrites,
  sentTitles,
} from "./folders.shared.js";

/**
 * "A device sends the creates that wait in pages."
 *
 * A first sync of a folder, or an import, queues thousands of creates. Sent
 * one at a time, each costs its write and its read-back, and a server that
 * limits requests stops the sync long before it ends. Each fixture here
 * scripts a server that holds what it is sent, as the real one does, so a
 * create sent twice, once in a page and once on its own door, is answered
 * as the repeat it is.
 */

let harness: Harness | undefined;
let folder: FolderHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  await folder?.stop();
  harness = undefined;
  folder = undefined;
});

/** An item the server holds before the fixture starts, the target of every
 *  edge the fixtures create. */
const HELD = "01a00000-0000-7000-8000-0000000000aa";

interface ItemEntry {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
  tier?: string;
  tags?: string[];
}

interface PageResult {
  index: number;
  outcome: "created" | "updated" | "skipped" | "errored";
  id?: string;
  reason?: string;
  error?: { code: string; message: string };
}

/**
 * The item and edge doors, holding what they write. A create naming an id
 * the door holds is a repeat, acknowledged with the item as it stands
 * (`items/create-repeat` and `edges/id-repeat`); a page entry naming one is
 * skipped as `duplicate_id` (`items/bulk-create-only-id`).
 */
class Door {
  readonly items = new Map<string, Record<string, unknown>>();
  readonly edges = new Map<string, WireEdgeOptions>();
  readonly tags = new Map<string, string[]>();
  /** The items a delete of an item takes into the bin with it, through a
   *  cascading edge (`items/trash-cascade`). */
  readonly cascades = new Map<string, string[]>();
  /** An answer standing in for a whole page's, where it gives one. */
  page?: (request: RecordedRequest) => Answer | undefined;
  /** A result standing in for one page entry's, where it gives one. */
  entry?: (entry: ItemEntry, index: number) => PageResult | undefined;
  /** An answer standing in for a single create's, where it gives one. */
  single?: (entry: ItemEntry) => Answer | undefined;
  /** An answer standing in for a read by id's, where it gives one. */
  reading?: (id: string) => Answer | undefined;
  /** An answer standing in for a read of an edge by id's, where it gives one. */
  edgeReading?: (id: string) => Answer | undefined;
  /** Edges a read of their source leaves out of its first page, as one
   *  past the first page of its type is. */
  readonly unlisted = new Set<string>();
  /** The edges of one type a read of their source holds in its first page,
   *  with a cursor to the rest (`edges/hydrate-cap`); all of them where not
   *  set. */
  hydrateCap?: number;
  /** A result standing in for one edge page entry's, where it gives one. */
  edgeEntry?: (edge: WireEdgeOptions, index: number) => PageResult | undefined;
  /** An answer standing in for a single edge create's, where it gives one. */
  edgeSingle?: (edge: WireEdgeOptions) => Answer | undefined;

  constructor(
    private readonly harness: Harness,
    others: string[] = [],
  ) {
    for (const id of [HELD, ...others]) this.items.set(id, wireItem({ id }));
    const { server } = harness;
    server.answer("POST", "/items", (request) => {
      const entry = JSON.parse(request.body) as ItemEntry;
      const standIn = this.single?.(entry);
      if (standIn !== undefined) return standIn;
      const held = this.items.get(entry.id);
      if (held !== undefined) {
        return {
          kind: "json",
          status: 200,
          body: { ...answersBody(held), acknowledged: true },
        };
      }
      return answers.created(this.hold(entry));
    });
    server.answer("POST", "/items/bulk", (request) => {
      const standIn = this.page?.(request);
      if (standIn !== undefined) return standIn;
      const { items } = JSON.parse(request.body) as { items: ItemEntry[] };
      return pageAnswer(
        items.map((entry, index): PageResult => {
          const scripted = this.entry?.(entry, index);
          if (scripted !== undefined) return scripted;
          if (this.items.has(entry.id)) {
            return {
              index,
              outcome: "skipped",
              id: entry.id,
              reason: "duplicate_id",
            };
          }
          this.hold(entry);
          return { index, outcome: "created", id: entry.id };
        }),
      );
    });
    server.answer("POST", /^\/items\/[^/]+\/tags$/, (request) => {
      const id = request.pathname.split("/").at(-2) ?? "";
      const { tags } = JSON.parse(request.body) as { tags: string[] };
      const held = this.tags.get(id) ?? [];
      this.tags.set(id, [...new Set([...held, ...tags])]);
      return writeAnswers.tags(this.tags.get(id));
    });
    server.answer("DELETE", /^\/items\/[^/]+$/, (request) => {
      const id = request.pathname.split("/").at(-1) ?? "";
      for (const gone of [id, ...(this.cascades.get(id) ?? [])])
        this.items.delete(gone);
      return writeAnswers.ok();
    });
    server.answer("POST", "/edges", (request) => {
      const edge = JSON.parse(request.body) as WireEdgeOptions;
      const standIn = this.edgeSingle?.(edge);
      if (standIn !== undefined) return standIn;
      const held = this.edges.get(edge.id);
      if (held !== undefined) return writeAnswers.edgeRepeated(held);
      if (this.endMissing(edge)) {
        return refusal(404, "item_not_found", "No such item");
      }
      this.edges.set(edge.id, { ...edge, version: 1 });
      return writeAnswers.edge(edge, 201);
    });
    server.answer("POST", "/edges/bulk", (request) => {
      const standIn = this.page?.(request);
      if (standIn !== undefined) return standIn;
      const { edges } = JSON.parse(request.body) as {
        edges: WireEdgeOptions[];
      };
      return pageAnswer(
        edges.map((edge, index): PageResult => {
          const scripted = this.edgeEntry?.(edge, index);
          if (scripted !== undefined) return scripted;
          if (this.endMissing(edge)) {
            return {
              index,
              outcome: "errored",
              error: { code: "item_not_found", message: "No such item" },
            };
          }
          this.edges.set(edge.id, { ...edge, version: 1 });
          return { index, outcome: "created", id: edge.id };
        }),
      );
    });
    // A bulk read by id is answered from these reads, one for each id
    // (`items/bulk-get`).
    server.copyAnswer("GET", /^\/items\/[^/]+$/, (request) => {
      const id = request.pathname.split("/").at(-1) ?? "";
      const standIn = this.reading?.(id);
      if (standIn !== undefined) return standIn;
      const item = this.items.get(id);
      if (item === undefined) return answers.itemNotFound();
      return answers.updated(
        { ...item, edges: this.edgesFrom(id) },
        this.tags.get(id) ?? [],
      );
    });
    server.copyAnswer("GET", /^\/items\/[^/]+\/edges$/, (request) => {
      const source = request.pathname.split("/").at(-2) ?? "";
      const type = request.query.get("edge_type");
      const from = Number(request.query.get("cursor") ?? "0");
      const rest = this.listed(source).filter(
        (edge) => type === null || (edge.edge_type ?? "references") === type,
      );
      return edgesPage(rest.slice(from, from + 500).map(wireEdge), {
        ...(from + 500 < rest.length ? { nextCursor: String(from + 500) } : {}),
      });
    });
    server.copyAnswer("GET", /^\/edges\/[^/]+$/, (request) => {
      const id = request.pathname.split("/").at(-1) ?? "";
      const standIn = this.edgeReading?.(id);
      if (standIn !== undefined) return standIn;
      const edge = this.edges.get(id);
      return edge === undefined
        ? refusal(404, "edge_not_found", "No such edge")
        : writeAnswers.edge(edge, 200);
    });
  }

  /** The requests to a door, in the order sent. */
  requests(method: string, pathname: string): RecordedRequest[] {
    return this.harness.server.requests.filter(
      (request) => request.method === method && request.pathname === pathname,
    );
  }

  hold(entry: ItemEntry): Record<string, unknown> {
    const item = wireItem({
      id: entry.id,
      type: entry.type,
      properties: entry.properties ?? {},
      tier: entry.tier,
    });
    this.items.set(entry.id, item);
    if (entry.tags !== undefined) this.tags.set(entry.id, [...entry.tags]);
    return item;
  }

  /** Whether an end of `edge` is gone, as a delete leaves it: a create
   *  naming it is refused (`edges/create-end-in-bin`). */
  private endMissing(edge: WireEdgeOptions): boolean {
    return !this.items.has(edge.from_id) || !this.items.has(edge.to_id);
  }

  /** The edges the door lists from `source`, those a read of it can reach. */
  private listed(source: string): WireEdgeOptions[] {
    return [...this.edges.values()].filter(
      (edge) => edge.from_id === source && !this.unlisted.has(edge.id),
    );
  }

  /** The edges a read of `source` hydrates, the first page of each type. */
  private edgesFrom(source: string): Record<string, unknown> {
    const byType: Record<string, WireEdgeOptions[]> = {};
    for (const edge of this.listed(source)) {
      const type = edge.edge_type ?? "references";
      (byType[type] ??= []).push(edge);
    }
    const cap = this.hydrateCap ?? Number.POSITIVE_INFINITY;
    return Object.fromEntries(
      Object.entries(byType).map(([type, all]) => [
        type,
        {
          data: all.slice(0, cap).map(wireEdge),
          next_cursor: all.length > cap ? String(cap) : null,
        },
      ]),
    );
  }
}

function answersBody(item: Record<string, unknown>): Record<string, unknown> {
  const answer = answers.updated(item);
  return answer.kind === "json" ? (answer.body as Record<string, unknown>) : {};
}

function pageAnswer(results: PageResult[]): Answer {
  const counts = { created: 0, updated: 0, skipped: 0, errored: 0 };
  for (const result of results) counts[result.outcome] += 1;
  return { kind: "json", status: 200, body: { counts, results } };
}

function value<T>(outcome: Outcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(outcome.refusal.raw);
  return outcome.value;
}

/** Queues `count` creates of notes titled `Note 0` on, and, where `edges`,
 *  an edge from each to the held item. */
async function queue(
  harness: Harness,
  count: number,
  options: {
    edges?: boolean;
    tags?: string[];
    /** Notes created in a state, which a page entry cannot carry, so they
     *  go on their own doors. */
    alone?: (at: number) => boolean;
  } = {},
): Promise<{ notes: QueuedWrite[]; edges: QueuedWrite[] }> {
  const notes: QueuedWrite[] = [];
  const edges: QueuedWrite[] = [];
  for (let at = 0; at < count; at += 1) {
    const note = value(
      await harness.device.create({
        type: "core.note",
        properties: { title: `Note ${String(at)}`, body: "text" },
        ...(options.tags === undefined ? {} : { tags: options.tags }),
        ...(options.alone?.(at) === true ? { state: "archived" as const } : {}),
      }),
    );
    notes.push(note);
    if (options.edges === true) {
      edges.push(
        value(
          await harness.device.createEdge({
            source: note.item_id ?? "",
            target: HELD,
            type: "references",
          }),
        ),
      );
    }
  }
  return { notes, edges };
}

async function drain(harness: Harness): Promise<DrainReport> {
  return value(await harness.device.drain());
}

/** The ids a bulk read named, one list for each request. */
function bulkReads(door: Door): string[][] {
  return door
    .requests("POST", "/items/bulk-get")
    .map((request) => (JSON.parse(request.body) as { ids: string[] }).ids);
}

async function start(
  label: string,
  others: string[] = [],
): Promise<{ harness: Harness; door: Door }> {
  const made = await hydratedHarness(label, {
    items: {
      "core.note": [HELD, ...others].map((id) => ({ item: { id } })),
    },
  });
  return { harness: made, door: new Door(made, others) };
}

describe("creates in pages", () => {
  it("sends the creates that wait in pages, edges after both their ends, and reads them back a hundred at a time", async () => {
    const made = await start("pages-sent");
    harness = made.harness;
    const { door } = made;
    const { notes, edges } = await queue(harness, 110, { edges: true });

    const drained = await drain(harness);

    expect(drained.answered, JSON.stringify(drained)).toBe(220);
    expect(drained.undelivered).toBe(0);
    expect(new Set(drained.verdicts.map((entry) => entry.verdict))).toEqual(
      new Set(["accepted"]),
    );
    const itemPages = door.requests("POST", "/items/bulk");
    const edgePages = door.requests("POST", "/edges/bulk");
    expect(itemPages).toHaveLength(1);
    expect(edgePages).toHaveLength(1);
    const itemPage = JSON.parse(itemPages[0]?.body ?? "{}") as {
      items: ItemEntry[];
      mode: string;
      atomic: boolean;
      enable_fanout: boolean;
    };
    expect(itemPage.items.map((entry) => entry.id)).toEqual(
      notes.map((note) => note.item_id),
    );
    expect({
      mode: itemPage.mode,
      atomic: itemPage.atomic,
      enable_fanout: itemPage.enable_fanout,
    }).toEqual({ mode: "create_only", atomic: false, enable_fanout: true });
    // A bulk door takes no key (`items/idempotency-operations`).
    expect(itemPages[0]?.headers["idempotency-key"]).toBeUndefined();
    const edgePage = JSON.parse(edgePages[0]?.body ?? "{}") as {
      edges: WireEdgeOptions[];
    };
    expect(edgePage.edges.map((edge) => edge.id)).toEqual(
      edges.map((edge) => edge.edge_id),
    );
    // Every note was read back before the page of edges from them went.
    const lastItemRead = door
      .requests("POST", "/items/bulk-get")
      .filter((request) => request.seq < (edgePages[0]?.seq ?? 0));
    expect(
      new Set(
        lastItemRead.flatMap(
          (request) => (JSON.parse(request.body) as { ids: string[] }).ids,
        ),
      ),
    ).toEqual(new Set(notes.map((note) => note.item_id)));
    const reads = bulkReads(door);
    expect(reads.map((ids) => ids.length)).toEqual([100, 10, 100, 10]);
    // Nothing went on a single door: no create and no read by id.
    expect(door.requests("POST", "/items")).toHaveLength(0);
    expect(door.requests("POST", "/edges")).toHaveLength(0);
    expect(
      harness.server.requests.filter(
        (request) =>
          request.method === "GET" &&
          request.pathname !== "/items/stats" &&
          /^\/(items|edges)\/[^/]+$/.test(request.pathname),
      ),
    ).toHaveLength(0);
    const queued = value(await harness.device.queue());
    expect(queued.every((row) => row.verdict === "accepted")).toBe(true);
    const held = value(await harness.device.get(notes[0]?.item_id ?? ""));
    expect(held.properties.title).toBe("Note 0");
  });

  it("sends fewer than fifty creates of a kind on their own doors", async () => {
    const made = await start("pages-floor");
    harness = made.harness;
    const { door } = made;
    await queue(harness, 49);

    const drained = await drain(harness);

    expect(drained.answered, JSON.stringify(drained)).toBe(49);
    expect(door.requests("POST", "/items")).toHaveLength(49);
    expect(door.requests("POST", "/items/bulk")).toHaveLength(0);
  });

  it("leaves every write of a page the server limits unanswered, unsent and uncounted", async () => {
    const made = await start("pages-limited");
    harness = made.harness;
    const { door } = made;
    const { notes } = await queue(harness, 50);
    let limited = false;
    door.page = () => {
      if (limited) return undefined;
      limited = true;
      return answers.rateLimited();
    };

    const first = await drain(harness);

    expect(limited).toBe(true);
    expect(first.answered, JSON.stringify(first)).toBe(0);
    expect(first.undelivered).toBe(50);
    expect(first.retry_after_seconds).toBe(2);
    expect(first.unavailable).toMatch(
      /the server is limiting requests \(429\) and asked for a wait of 2s/,
    );
    const waiting = value(await harness.device.queue());
    for (const row of waiting) {
      expect(row.verdict, JSON.stringify(row)).toBeNull();
      expect(row.refusals).toBe(0);
      expect(row.environmental_streak).toBe(0);
    }
    expect(door.requests("POST", "/items")).toHaveLength(0);
    expect(door.items.size).toBe(1);

    const second = await drain(harness);

    // Each went in a page again: a write the server may have taken would
    // have gone on its own door, under its key.
    const pages = door.requests("POST", "/items/bulk");
    expect(pages).toHaveLength(2);
    expect(
      (JSON.parse(pages[1]?.body ?? "{}") as { items: ItemEntry[] }).items.map(
        (entry) => entry.id,
      ),
    ).toEqual(notes.map((note) => note.item_id));
    expect(second.answered, JSON.stringify(second)).toBe(50);
    expect(door.requests("POST", "/items")).toHaveLength(0);
  });

  it("sends an entry the page does not create under its own id on its own door, under its key, in the same drain", async () => {
    const made = await start("pages-entry-alone");
    harness = made.harness;
    const { door } = made;
    const { notes } = await queue(harness, 52);
    const [repeated, refused] = notes as [QueuedWrite, QueuedWrite];
    // An earlier page the device never heard the answer to took this one.
    door.items.set(
      repeated.item_id ?? "",
      wireItem({ id: repeated.item_id ?? "" }),
    );
    door.entry = (entry, index) =>
      entry.id === refused.item_id
        ? {
            index,
            outcome: "errored",
            error: { code: "validation_error", message: "Not allowed" },
          }
        : undefined;
    door.single = (entry) =>
      entry.id === refused.item_id
        ? refusal(400, "validation_error", "Not allowed")
        : undefined;

    const drained = await drain(harness);

    const singles = door.requests("POST", "/items");
    expect(
      singles.map((request) => (JSON.parse(request.body) as ItemEntry).id),
    ).toEqual([repeated.item_id, refused.item_id]);
    expect(
      singles.map((request) => request.headers["idempotency-key"]),
    ).toEqual([repeated.idempotency_key, refused.idempotency_key]);
    expect(drained.answered, JSON.stringify(drained)).toBe(52);
    const verdicts = new Map(
      drained.verdicts.map((entry) => [entry.id, entry]),
    );
    expect(verdicts.get(repeated.id)?.verdict).toBe("accepted");
    expect(verdicts.get(repeated.id)?.replayed).toBe(true);
    expect(verdicts.get(refused.id)?.verdict).toBe("refused");
    expect(verdicts.get(refused.id)?.refusal?.code).toBe("validation_error");
    expect(
      notes
        .slice(2)
        .every((note) => verdicts.get(note.id)?.verdict === "accepted"),
    ).toBe(true);
  });

  it("sends the tags queued with a create in its page entry, not on their own doors", async () => {
    const made = await start("pages-tags");
    harness = made.harness;
    const { door } = made;
    const { notes } = await queue(harness, 60, { tags: ["alpha", "beta"] });

    const drained = await drain(harness);

    // Each note is its create and its two tags.
    expect(drained.answered, JSON.stringify(drained)).toBe(180);
    expect(drained.undelivered).toBe(0);
    const pages = door.requests("POST", "/items/bulk");
    expect(pages).toHaveLength(1);
    const page = JSON.parse(pages[0]?.body ?? "{}") as { items: ItemEntry[] };
    expect(page.items.map((entry) => entry.tags)).toEqual(
      notes.map(() => ["alpha", "beta"]),
    );
    expect(
      harness.server.requests.filter((request) =>
        /^\/items\/[^/]+\/tags$/.test(request.pathname),
      ),
    ).toHaveLength(0);
    expect(door.requests("POST", "/items")).toHaveLength(0);
    const queued = value(await harness.device.queue());
    expect(queued.map((row) => [row.kind, row.verdict])).toEqual(
      notes.flatMap(() => [
        ["create_item", "accepted"],
        ["add_tag", "accepted"],
        ["add_tag", "accepted"],
      ]),
    );
    const held = value(await harness.device.get(notes[0]?.item_id ?? ""));
    expect([...held.tags].sort()).toEqual(["alpha", "beta"]);
  });

  it("sends the tags of an entry the page does not create on their own doors, after its create", async () => {
    const made = await start("pages-tags-entry-alone");
    harness = made.harness;
    const { door } = made;
    const { notes } = await queue(harness, 52, { tags: ["alpha"] });
    const [alone] = notes as [QueuedWrite];
    door.entry = (entry, index) =>
      entry.id === alone.item_id
        ? {
            index,
            outcome: "errored",
            error: { code: "internal_error", message: "Not written" },
          }
        : undefined;

    const drained = await drain(harness);

    expect(drained.answered, JSON.stringify(drained)).toBe(104);
    const tag = value(await harness.device.queue()).find(
      (row) => row.kind === "add_tag" && row.item_id === alone.item_id,
    );
    const tagged = harness.server.requests.filter((request) =>
      /^\/items\/[^/]+\/tags$/.test(request.pathname),
    );
    expect(tagged.map((request) => request.pathname)).toEqual([
      `/items/${alone.item_id ?? ""}/tags`,
    ]);
    expect(tagged[0]?.headers["idempotency-key"]).toBe(tag?.idempotency_key);
    const [create] = door.requests("POST", "/items");
    expect(create?.seq ?? Infinity).toBeLessThan(tagged[0]?.seq ?? 0);
    expect(tag?.verdict).toBe("accepted");
    expect(door.tags.get(alone.item_id ?? "")).toEqual(["alpha"]);
  });

  it("ends the drain where the read of a page meets a changed reach, with no write answered", async () => {
    const made = await start("pages-reach-changed");
    harness = made.harness;
    const { door } = made;
    const { notes } = await queue(harness, 50);
    let changed = false;
    door.reading = () => {
      if (changed) return undefined;
      changed = true;
      return refusal(409, "reach_changed", "The reach has changed");
    };

    const drained = await harness.device.drain();

    expect(changed).toBe(true);
    expect(drained.ok, JSON.stringify(drained)).toBe(false);
    if (drained.ok) return;
    expect(drained.refusal.raw).toMatch(/reach_changed/);
    expect(door.requests("POST", "/items/bulk")).toHaveLength(1);
    expect(door.items.size).toBe(51);
    expect(notes).toHaveLength(50);
  });
  it("sends a page whose answer was lost again one write at a time, under each write's key", async () => {
    const made = await start("pages-answer-lost");
    harness = made.harness;
    const { door } = made;
    const { notes } = await queue(harness, 50);
    let lost = false;
    door.page = (request) => {
      if (lost) return undefined;
      lost = true;
      // The server took the page and the answer never came back.
      for (const entry of (JSON.parse(request.body) as { items: ItemEntry[] })
        .items)
        door.hold(entry);
      return { kind: "drop" };
    };

    const first = await drain(harness);

    expect(lost).toBe(true);
    expect(first.answered, JSON.stringify(first)).toBe(0);
    expect(first.undelivered).toBe(50);

    const second = await drain(harness);

    expect(door.requests("POST", "/items/bulk")).toHaveLength(1);
    const singles = door.requests("POST", "/items");
    expect(
      singles.map((request) => request.headers["idempotency-key"]),
    ).toEqual(notes.map((note) => note.idempotency_key));
    expect(second.answered, JSON.stringify(second)).toBe(50);
    expect(second.verdicts.every((entry) => entry.verdict === "accepted")).toBe(
      true,
    );
    expect(second.verdicts.every((entry) => entry.replayed)).toBe(true);
    expect(door.items.size).toBe(51);
  });

  it("sends creates in a page past a write queued before them that is not a create", async () => {
    const target = "01a00000-0000-7000-8000-0000000000bb";
    const gone = "01a00000-0000-7000-8000-0000000000cc";
    const sources = Array.from(
      { length: 50 },
      (_, at) => `01a00000-0000-7000-8000-${String(at).padStart(12, "0")}`,
    );
    const made = await start("pages-behind-a-delete", [
      target,
      gone,
      ...sources,
    ]);
    harness = made.harness;
    const { door } = made;
    const removed = value(await harness.device.deleteItem(gone));
    for (const source of sources)
      value(
        await harness.device.createEdge({
          source,
          target,
          type: "references",
        }),
      );

    const drained = await drain(harness);

    const deletes = harness.server.requests.filter(
      (request) =>
        request.method === "DELETE" && request.pathname === `/items/${gone}`,
    );
    expect(deletes, JSON.stringify(drained)).toHaveLength(1);
    const deleted = deletes[0]?.seq ?? Infinity;
    const pages = door.requests("POST", "/edges/bulk");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.seq).toBeLessThan(deleted);
    expect(door.requests("POST", "/edges")).toHaveLength(0);
    expect(removed.kind).toBe("delete_item");
  });

  it("pages no edge whose end the page it went in did not create", async () => {
    const made = await start("pages-end-not-created");
    harness = made.harness;
    const { door } = made;
    const { notes, edges } = await queue(harness, 52, { edges: true });
    const [skipped, errored] = notes as [QueuedWrite, QueuedWrite];
    // An earlier page the device never heard the answer to took this one,
    // so this page skips it.
    door.items.set(
      skipped.item_id ?? "",
      wireItem({ id: skipped.item_id ?? "" }),
    );
    door.entry = (entry, index) =>
      entry.id === errored.item_id
        ? {
            index,
            outcome: "errored",
            error: { code: "validation_error", message: "Not allowed" },
          }
        : undefined;
    door.single = (entry) =>
      entry.id === errored.item_id
        ? refusal(400, "validation_error", "Not allowed")
        : undefined;

    const drained = await drain(harness);

    const edgePages = door.requests("POST", "/edges/bulk");
    expect(edgePages, JSON.stringify(drained)).toHaveLength(1);
    expect(
      (
        JSON.parse(edgePages[0]?.body ?? "{}") as { edges: WireEdgeOptions[] }
      ).edges.map((edge) => edge.id),
    ).toEqual(edges.slice(2).map((edge) => edge.edge_id));
    // The edge from the skipped note went on its own door once the walk
    // answered the note; the one from the refused note went nowhere.
    expect(
      door
        .requests("POST", "/edges")
        .map((request) => (JSON.parse(request.body) as WireEdgeOptions).id),
    ).toEqual([edges[0]?.edge_id]);
    const verdicts = new Map(
      drained.verdicts.map((entry) => [entry.id, entry.verdict]),
    );
    expect(verdicts.get(edges[0]?.id ?? "")).toBe("accepted");
    expect(verdicts.get(edges[1]?.id ?? "")).toBe("refused");
  });

  it("sends an edge the read of its from item does not hold on its own door, under its key, answered as a repeat", async () => {
    const made = await start("pages-edge-unread");
    harness = made.harness;
    const { door } = made;
    const { edges } = await queue(harness, 50, { edges: true });
    const [unread] = edges as [QueuedWrite];
    door.unlisted.add(unread.edge_id ?? "");

    const drained = await drain(harness);

    expect(door.requests("POST", "/edges/bulk")).toHaveLength(1);
    const singles = door.requests("POST", "/edges");
    expect(
      singles.map((request) => [
        (JSON.parse(request.body) as WireEdgeOptions).id,
        request.headers["idempotency-key"],
      ]),
      JSON.stringify(drained),
    ).toEqual([[unread.edge_id, unread.idempotency_key]]);
    expect(drained.answered).toBe(100);
    const verdict = drained.verdicts.find((entry) => entry.id === unread.id);
    expect(verdict?.verdict).toBe("accepted");
    expect(verdict?.replayed).toBe(true);
    expect(door.edges.size).toBe(50);
  });

  it("sends the edges of creates it sent on their own doors in pages, once those creates are answered, in the same drain", async () => {
    const made = await start("pages-edges-after-own-doors");
    harness = made.harness;
    const { door } = made;
    const { edges } = await queue(harness, 110, {
      edges: true,
      alone: (at) => at % 2 === 1,
    });

    const drained = await drain(harness);

    expect(drained.answered, JSON.stringify(drained)).toBe(220);
    expect(drained.undelivered).toBe(0);
    expect(new Set(drained.verdicts.map((entry) => entry.verdict))).toEqual(
      new Set(["accepted"]),
    );
    // The witness: half the notes went on their own doors.
    expect(door.requests("POST", "/items/bulk")).toHaveLength(1);
    const alone = door.requests("POST", "/items");
    expect(alone).toHaveLength(55);
    const edgePages = door.requests("POST", "/edges/bulk");
    expect(edgePages).toHaveLength(2);
    const sent = edgePages.map((request) =>
      (JSON.parse(request.body) as { edges: WireEdgeOptions[] }).edges.map(
        (edge) => edge.id,
      ),
    );
    expect(sent[0]).toEqual(
      edges.filter((_, at) => at % 2 === 0).map((edge) => edge.edge_id),
    );
    expect(sent[1]).toEqual(
      edges.filter((_, at) => at % 2 === 1).map((edge) => edge.edge_id),
    );
    // No edge went before a create it waits on was answered.
    const last = Math.max(...alone.map((request) => request.seq));
    expect(edgePages[1]?.seq).toBeGreaterThan(last);
    expect(door.requests("POST", "/edges")).toHaveLength(0);
    expect(
      harness.server.requests.filter(
        (request) =>
          request.method === "GET" && /^\/edges\/[^/]+$/.test(request.pathname),
      ),
    ).toHaveLength(0);
    expect(door.edges.size).toBe(110);
  });

  it("sends an edge with an edit queued behind it on its own door, ahead of the edit, and pages the rest", async () => {
    const made = await start("pages-edges-edited");
    harness = made.harness;
    const { door } = made;
    const { edges } = await queue(harness, 110, {
      edges: true,
      alone: (at) => at % 2 === 1,
    });
    const [, edited] = edges as [QueuedWrite, QueuedWrite];
    const edit = value(
      await harness.device.updateEdge(edited.edge_id ?? "", {
        properties: { note: "edited" },
        version: 0,
      }),
    );
    const patches: number[] = [];
    harness.server.answer(
      "PATCH",
      `/edges/${edited.edge_id ?? ""}`,
      (request) => {
        const sent = JSON.parse(request.body) as {
          version: number;
          properties: Record<string, unknown>;
        };
        patches.push(request.seq);
        const held = door.edges.get(edited.edge_id ?? "");
        if (held === undefined) {
          return refusal(404, "edge_not_found", "No edge");
        }
        const now = {
          ...held,
          properties: sent.properties,
          version: (held.version ?? 1) + 1,
        };
        door.edges.set(edited.edge_id ?? "", now);
        return writeAnswers.edge(now, 200);
      },
    );

    const drained = await drain(harness);

    expect(drained.undelivered, JSON.stringify(drained)).toBe(0);
    const singles = door.requests("POST", "/edges");
    expect(
      singles.map(
        (request) => (JSON.parse(request.body) as WireEdgeOptions).id,
      ),
    ).toEqual([edited.edge_id]);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toBeGreaterThan(singles[0]?.seq ?? Infinity);
    const pages = door.requests("POST", "/edges/bulk");
    expect(pages).toHaveLength(2);
    expect(
      pages.reduce(
        (total, request) =>
          total +
          (JSON.parse(request.body) as { edges: unknown[] }).edges.length,
        0,
      ),
    ).toBe(109);
    const queued = value(await harness.device.queue());
    expect(queued.every((row) => row.verdict === "accepted")).toBe(true);
    expect(queued.find((row) => row.id === edit?.id)?.verdict).toBe("accepted");
  });

  it("reads an edge past the first page of its source's edges from the rest of the listing, and sends none on its own door", async () => {
    const made = await start("pages-edges-past-first-page");
    harness = made.harness;
    const { door } = made;
    door.hydrateCap = 50;
    const { notes } = await queue(harness, 61);
    const host = notes[0]?.item_id ?? "";
    for (const note of notes.slice(1)) {
      value(
        await harness.device.createEdge({
          source: host,
          target: note.item_id ?? "",
          type: "references",
        }),
      );
    }

    const drained = await drain(harness);

    expect(drained.answered, JSON.stringify(drained)).toBe(121);
    expect(drained.undelivered).toBe(0);
    expect(door.requests("POST", "/edges/bulk")).toHaveLength(1);
    expect(door.requests("POST", "/edges")).toHaveLength(0);
    expect(
      harness.server.requests.filter(
        (request) =>
          request.method === "GET" && /^\/edges\/[^/]+$/.test(request.pathname),
      ),
    ).toHaveLength(0);
    // The witness: the first page held 50 of the 60, and one read of the
    // rest, from the cursor it named, brought the others.
    const listings = door.requests("GET", `/items/${host}/edges`);
    expect(listings.map((request) => request.query.get("cursor"))).toEqual([
      "50",
    ]);
    expect(drained.verdicts.filter((entry) => entry.replayed)).toHaveLength(0);
    expect(door.edges.size).toBe(60);
  });

  it("sends an edge entry the page does not create on its own door, under its key, and settles the rest of the page", async () => {
    const made = await start("pages-edge-entry-alone");
    harness = made.harness;
    const { door } = made;
    const { edges } = await queue(harness, 52, { edges: true });
    const [missing] = edges as [QueuedWrite];
    door.edgeEntry = (edge, index) =>
      edge.id === missing.edge_id
        ? {
            index,
            outcome: "errored",
            error: { code: "item_not_found", message: "No such item" },
          }
        : undefined;
    door.edgeSingle = (edge) =>
      edge.id === missing.edge_id
        ? refusal(404, "item_not_found", "No such item")
        : undefined;

    const drained = await drain(harness);

    expect(door.requests("POST", "/edges/bulk")).toHaveLength(1);
    const singles = door.requests("POST", "/edges");
    expect(
      singles.map((request) => [
        (JSON.parse(request.body) as WireEdgeOptions).id,
        request.headers["idempotency-key"],
      ]),
      JSON.stringify(drained),
    ).toEqual([[missing.edge_id, missing.idempotency_key]]);
    const verdicts = new Map(
      drained.verdicts.map((entry) => [entry.id, entry]),
    );
    expect(verdicts.get(missing.id)?.verdict).toBe("refused");
    expect(verdicts.get(missing.id)?.refusal?.code).toBe("item_not_found");
    expect(
      edges
        .slice(1)
        .every((edge) => verdicts.get(edge.id)?.verdict === "accepted"),
    ).toBe(true);
    expect(door.edges.size).toBe(51);
  });

  it("sends the delete of an edge removed before the drain after the page that creates it, and pages the rest", async () => {
    const made = await start("pages-edge-removed");
    harness = made.harness;
    const { door } = made;
    const { edges } = await queue(harness, 52, { edges: true });
    const [removed] = edges as [QueuedWrite];
    const removal = value(
      await harness.device.deleteEdge(removed.edge_id ?? ""),
    );
    const deletes: number[] = [];
    harness.server.answer(
      "DELETE",
      `/edges/${removed.edge_id ?? ""}`,
      (request) => {
        deletes.push(request.seq);
        door.edges.delete(removed.edge_id ?? "");
        return writeAnswers.ok();
      },
    );

    const drained = await drain(harness);

    expect(drained.undelivered, JSON.stringify(drained)).toBe(0);
    const pages = door.requests("POST", "/edges/bulk");
    expect(pages).toHaveLength(1);
    const sent = (
      JSON.parse(pages[0]?.body ?? "{}") as { edges: WireEdgeOptions[] }
    ).edges.map((edge) => edge.id);
    expect(sent).toEqual(edges.map((edge) => edge.edge_id));
    expect(door.requests("POST", "/edges")).toHaveLength(0);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toBeGreaterThan(pages[0]?.seq ?? Infinity);
    expect(door.edges.has(removed.edge_id ?? "")).toBe(false);
    const queued = value(await harness.device.queue());
    expect(queued.find((row) => row.id === removal.id)?.verdict).toBe(
      "accepted",
    );
  });

  it("sends the delete of an end queued after its links after those links, and creates every link", async () => {
    const made = await start("pages-edges-before-a-delete");
    harness = made.harness;
    const { door } = made;
    const { edges } = await queue(harness, 110, {
      edges: true,
      alone: (at) => at % 2 === 1,
    });
    const removal = value(await harness.device.deleteItem(HELD));
    const drained = await drain(harness);

    expect(drained.undelivered, JSON.stringify(drained)).toBe(0);
    // The witness: a link sent after the delete is refused, so a link
    // created at all was sent before it.
    const deletes = door.requests("DELETE", `/items/${HELD}`);
    expect(deletes).toHaveLength(1);
    const edgeRequests = [
      ...door.requests("POST", "/edges"),
      ...door.requests("POST", "/edges/bulk"),
    ];
    expect(edgeRequests.length).toBeGreaterThan(0);
    for (const request of edgeRequests) {
      expect(request.seq).toBeLessThan(deletes[0]?.seq ?? 0);
    }
    expect(door.edges.size).toBe(110);
    const verdicts = new Map(
      drained.verdicts.map((entry) => [entry.id, entry.verdict]),
    );
    expect(edges.every((edge) => verdicts.get(edge.id) === "accepted")).toBe(
      true,
    );
    expect(verdicts.get(removal.id)).toBe("accepted");
  });

  it("sends the delete of an item no link names after every link, as the delete takes an end into the bin with it", async () => {
    const parent = "01a00000-0000-7000-8000-0000000000bb";
    const made = await start("pages-edges-before-a-cascading-delete", [parent]);
    harness = made.harness;
    const { door } = made;
    door.cascades.set(parent, [HELD]);
    const { edges } = await queue(harness, 110, {
      edges: true,
      alone: (at) => at % 2 === 1,
    });
    const removal = value(await harness.device.deleteItem(parent));
    const drained = await drain(harness);

    expect(drained.undelivered, JSON.stringify(drained)).toBe(0);
    // The witness: a link sent after the delete is refused, as the end is
    // in the bin by then, so a link created at all was sent before it.
    const deletes = door.requests("DELETE", `/items/${parent}`);
    expect(deletes).toHaveLength(1);
    const edgeRequests = [
      ...door.requests("POST", "/edges"),
      ...door.requests("POST", "/edges/bulk"),
    ];
    expect(edgeRequests.length).toBeGreaterThan(0);
    for (const request of edgeRequests) {
      expect(request.seq).toBeLessThan(deletes[0]?.seq ?? 0);
    }
    expect(door.edges.size).toBe(110);
    const verdicts = new Map(
      drained.verdicts.map((entry) => [entry.id, entry.verdict]),
    );
    expect(edges.every((edge) => verdicts.get(edge.id) === "accepted")).toBe(
      true,
    );
    expect(verdicts.get(removal.id)).toBe("accepted");
  });

  it("sends the edges of a deferred page whose answer was lost again one at a time, under each write's key, and writes none twice", async () => {
    const made = await start("pages-edges-deferred-lost");
    harness = made.harness;
    const { door } = made;
    const { edges } = await queue(harness, 110, {
      edges: true,
      alone: (at) => at % 2 === 1,
    });
    let pages = 0;
    door.page = (request) => {
      if (request.pathname !== "/edges/bulk") return undefined;
      pages += 1;
      if (pages !== 2) return undefined;
      // The server took the page and the answer never came back.
      for (const edge of (
        JSON.parse(request.body) as { edges: WireEdgeOptions[] }
      ).edges)
        door.edges.set(edge.id, { ...edge, version: 1 });
      return { kind: "drop" };
    };

    const first = await drain(harness);

    expect(pages).toBe(2);
    expect(first.undelivered, JSON.stringify(first)).toBe(55);

    const second = await drain(harness);

    expect(door.requests("POST", "/edges/bulk")).toHaveLength(2);
    const lateKeys = edges
      .filter((_, at) => at % 2 === 1)
      .map((edge) => edge.idempotency_key);
    expect(
      door
        .requests("POST", "/edges")
        .map((request) => request.headers["idempotency-key"]),
    ).toEqual(lateKeys);
    expect(second.answered, JSON.stringify(second)).toBe(55);
    expect(second.verdicts.every((entry) => entry.replayed)).toBe(true);
    expect(door.edges.size).toBe(110);
  });

  it("keeps the verdicts of a page whose read-back the server limits, and sends none of its writes again", async () => {
    const made = await start("pages-read-limited");
    harness = made.harness;
    const { door } = made;
    const { notes } = await queue(harness, 50);
    let limited = false;
    door.reading = () => {
      if (limited) return undefined;
      limited = true;
      return answers.rateLimited();
    };

    const first = await drain(harness);

    expect(limited).toBe(true);
    expect(first.unavailable, JSON.stringify(first)).toMatch(
      /the server is limiting requests/,
    );
    expect(first.retry_after_seconds).toBe(2);
    expect(first.answered).toBe(50);
    expect(first.verdicts.map((entry) => entry.verdict)).toEqual(
      notes.map(() => "accepted"),
    );

    const second = await drain(harness);

    expect(second.unavailable, JSON.stringify(second)).toBeNull();
    expect(door.requests("POST", "/items/bulk")).toHaveLength(1);
    expect(door.requests("POST", "/items")).toHaveLength(0);
    // The read the first drain owed, made in bulk.
    expect(bulkReads(door).at(-1)).toEqual(notes.map((note) => note.item_id));
    const queued = value(await harness.device.queue());
    expect(queued.map((row) => row.verdict)).toEqual(
      notes.map(() => "accepted"),
    );
    const held = value(await harness.device.get(notes[0]?.item_id ?? ""));
    expect(held.version).toBe(1);
  });

  it("leaves every write of a page the server refuses the credential for unsent, so it goes in a page again", async () => {
    const made = await start("pages-credential");
    harness = made.harness;
    const { door } = made;
    const { notes } = await queue(harness, 51);
    let refused = false;
    door.page = () => {
      if (refused) return undefined;
      refused = true;
      return answers.unauthorized();
    };

    const first = await drain(harness);

    expect(refused).toBe(true);
    expect(first.stopped, JSON.stringify(first)).not.toBeNull();
    expect(first.answered).toBe(0);
    // A write sent on its own door would meet the same refusal under a key
    // the server never saw, and could go in no page after.
    expect(door.requests("POST", "/items")).toHaveLength(0);
    expect(door.items.size).toBe(1);

    const second = await drain(harness);

    const pages = door.requests("POST", "/items/bulk");
    expect(pages, JSON.stringify(second)).toHaveLength(2);
    expect(
      (JSON.parse(pages[1]?.body ?? "{}") as { items: ItemEntry[] }).items.map(
        (entry) => entry.id,
      ),
    ).toEqual(notes.map((note) => note.item_id));
    expect(door.requests("POST", "/items")).toHaveLength(0);
    expect(second.answered).toBe(51);
    expect(door.items.size).toBe(52);
  });

  it("keeps the read of a page's writes owed where the server refuses it, and sends the rest of the queue", async () => {
    const made = await start("pages-owed-refused");
    harness = made.harness;
    const { door } = made;
    const { notes } = await queue(harness, 50);
    const paged = new Set(notes.map((note) => note.item_id));
    let reads = 0;
    door.reading = (id) => {
      if (!paged.has(id)) return undefined;
      reads += 1;
      return reads === 1
        ? answers.rateLimited()
        : answers.validation("validation_error", "The read was refused");
    };
    const first = await drain(harness);
    expect(first.unavailable, JSON.stringify(first)).toMatch(
      /the server is limiting requests/,
    );
    const late = value(
      await harness.device.create({
        type: "core.note",
        properties: { title: "Late", body: "text" },
      }),
    );

    const second = await drain(harness);

    // The witness: the owed read was made, and refused.
    expect(reads).toBeGreaterThan(50);
    expect(bulkReads(door)).toHaveLength(2);
    expect(second.unavailable, JSON.stringify(second)).toBeNull();
    expect(second.stopped).toBeNull();
    expect(
      door
        .requests("POST", "/items")
        .map((request) => (JSON.parse(request.body) as ItemEntry).id),
    ).toEqual([late.item_id]);

    door.reading = undefined;
    const third = await drain(harness);

    expect(third.unavailable, JSON.stringify(third)).toBeNull();
    // Still owed after the refusal, so this drain made it.
    expect(bulkReads(door).at(2)).toEqual(notes.map((note) => note.item_id));
    expect(door.requests("POST", "/items/bulk")).toHaveLength(1);
    const queued = value(await harness.device.queue());
    expect(queued.map((row) => row.verdict)).toEqual([
      ...notes.map(() => "accepted"),
      "accepted",
    ]);
  });

  it("settles an edge the owed read of its from item leaves out by a read of the edge, and sends it no more", async () => {
    const made = await start("pages-owed-edge");
    harness = made.harness;
    const { door } = made;
    const { edges } = await queue(harness, 50, { edges: true });
    const [unread] = edges as [QueuedWrite];
    const edgeId = unread.edge_id ?? "";
    const edited = value(
      await harness.device.updateEdge(edgeId, {
        properties: { note: "edited" },
        version: 0,
      }),
    );
    let paged = false;
    let limited = false;
    door.page = (request) => {
      if (request.pathname === "/edges/bulk") paged = true;
      return undefined;
    };
    door.reading = () => {
      if (!paged || limited) return undefined;
      limited = true;
      return answers.rateLimited();
    };
    const patches: number[] = [];
    const readsBefore: number[] = [];
    harness.server.answer("PATCH", `/edges/${edgeId}`, (request) => {
      const sent = JSON.parse(request.body) as {
        version: number;
        properties: Record<string, unknown>;
      };
      patches.push(sent.version);
      readsBefore.push(door.requests("GET", `/edges/${edgeId}`).length);
      const held = door.edges.get(edgeId);
      if (held === undefined) return refusal(404, "edge_not_found", "No edge");
      const now = {
        ...held,
        properties: sent.properties,
        version: (held.version ?? 1) + 1,
      };
      door.edges.set(edgeId, now);
      return writeAnswers.edge(now, 200);
    });

    const first = await drain(harness);

    expect(limited).toBe(true);
    expect(first.unavailable, JSON.stringify(first)).toMatch(
      /the server is limiting requests/,
    );
    expect(door.requests("POST", "/edges/bulk")).toHaveLength(1);
    expect(patches).toEqual([]);
    door.unlisted.add(edgeId);

    const second = await drain(harness);

    expect(second.unavailable, JSON.stringify(second)).toBeNull();
    // The witness: the source was read, and the edge was not in it.
    expect(bulkReads(door).at(-1)).toContain(unread.item_id ?? "");
    expect(readsBefore).toEqual([1]);
    expect(door.requests("POST", "/edges")).toHaveLength(0);
    // Settled on the version the page made, so the edit behind it is sent
    // on that version.
    expect(patches).toEqual([1]);
    const queued = value(await harness.device.queue());
    expect(queued.find((row) => row.id === unread.id)?.verdict).toBe(
      "accepted",
    );
    expect(queued.find((row) => row.id === edited?.id)?.verdict).toBe(
      "accepted",
    );
  });

  it("keeps the read of an edge owed where the server refuses it, and sends the rest of the queue", async () => {
    const made = await start("pages-owed-edge-refused");
    harness = made.harness;
    const { door } = made;
    const { edges } = await queue(harness, 50, { edges: true });
    const [unread] = edges as [QueuedWrite];
    const edgeId = unread.edge_id ?? "";
    let paged = false;
    let limited = false;
    door.page = (request) => {
      if (request.pathname === "/edges/bulk") paged = true;
      return undefined;
    };
    door.reading = () => {
      if (!paged || limited) return undefined;
      limited = true;
      return answers.rateLimited();
    };
    let refusing = false;
    let refusals = 0;
    door.edgeReading = (id) => {
      if (id !== edgeId || !refusing) return undefined;
      refusals += 1;
      return answers.validation("validation_error", "The read was refused");
    };

    const first = await drain(harness);

    expect(limited).toBe(true);
    expect(first.unavailable, JSON.stringify(first)).toMatch(
      /the server is limiting requests/,
    );
    door.unlisted.add(edgeId);
    refusing = true;
    const late = value(
      await harness.device.create({
        type: "core.note",
        properties: { title: "Late", body: "text" },
      }),
    );

    const second = await drain(harness);

    // The witness: the source was read without the edge, and the read of the
    // edge itself was refused.
    expect(bulkReads(door).at(-1)).toContain(unread.item_id ?? "");
    expect(refusals).toBeGreaterThan(0);
    expect(second.unavailable, JSON.stringify(second)).toBeNull();
    expect(second.stopped).toBeNull();
    expect(
      door
        .requests("POST", "/items")
        .map((request) => (JSON.parse(request.body) as ItemEntry).id),
    ).toEqual([late.item_id]);
    expect(door.requests("POST", "/edges")).toHaveLength(0);
    const kept = value(await harness.device.queue());
    expect(kept.find((row) => row.id === unread.id)?.verdict).toBe("accepted");

    refusing = false;
    const refused = refusals;
    const readsBefore = door.requests("GET", `/edges/${edgeId}`).length;

    const third = await drain(harness);

    expect(third.unavailable, JSON.stringify(third)).toBeNull();
    // Still owed after the refusal, so this drain made the read again, and
    // the server answered it.
    expect(refusals).toBe(refused);
    expect(door.requests("GET", `/edges/${edgeId}`).length).toBeGreaterThan(
      readsBefore,
    );
    expect(door.requests("POST", "/edges")).toHaveLength(0);
    const queued = value(await harness.device.queue());
    expect(queued.find((row) => row.id === unread.id)?.verdict).toBe(
      "accepted",
    );

    const readsAfter = door.requests("GET", `/edges/${edgeId}`).length;

    const fourth = await drain(harness);

    // Settled by that read: nothing is owed to be read a fourth time.
    expect(fourth.unavailable, JSON.stringify(fourth)).toBeNull();
    expect(door.requests("GET", `/edges/${edgeId}`).length).toBe(readsAfter);
  });

  it("sends an edit queued behind a page's create on the version the page made, so another device's edit since meets a conflict", async () => {
    const made = await start("pages-owed-edit");
    harness = made.harness;
    const { door } = made;
    const { notes } = await queue(harness, 50);
    const [mine] = notes as [QueuedWrite];
    const id = mine.item_id ?? "";
    const edit = value(
      await harness.device.update(id, {
        properties: { title: "Mine" },
        version: 0,
      }),
    );
    let limited = false;
    door.reading = () => {
      if (limited) return undefined;
      limited = true;
      return answers.rateLimited();
    };
    const patches: number[] = [];
    harness.server.answer("PATCH", `/items/${id}`, (request) => {
      const sent = JSON.parse(request.body) as { version: number };
      patches.push(sent.version);
      const held = door.items.get(id) ?? {};
      const current = {
        id,
        version: held.version as number,
        properties: held.properties as Record<string, unknown>,
        tier: "library" as const,
        occurred_at: held.occurred_at as string,
        source_id: null,
        type: "core.note",
      };
      if (sent.version !== current.version) {
        return answers.versionConflict(
          current,
          { ...current, version: sent.version },
          ["title"],
          { fields: {}, default: "last_writer_wins" },
        );
      }
      return answers.updated(held);
    });

    const first = await drain(harness);

    expect(first.unavailable, JSON.stringify(first)).toMatch(
      /the server is limiting requests/,
    );
    expect(patches).toEqual([]);
    // Another device edits the item between the page and its owed read.
    const created = door.items.get(id) ?? {};
    door.items.set(id, {
      ...created,
      version: 2,
      properties: { title: "Theirs", body: "text" },
    });

    const second = await drain(harness);

    expect(patches, JSON.stringify(second)).toEqual([1]);
    const verdict = value(await harness.device.queue()).find(
      (row) => row.id === edit.id,
    );
    expect(verdict?.verdict).not.toBe("accepted");
    expect(
      (door.items.get(id)?.properties as Record<string, unknown>).title,
    ).toBe("Theirs");
  });
});

describe("a folder's first sync", () => {
  it("sends its files and their placements in pages, in one push", async () => {
    folder = await folderHarness("pages-folder");
    const edges = new EdgeDoor();
    const rows = scriptFolderWrites(folder, { edges });
    const titles = Array.from({ length: 60 }, (_, at) => `Note ${String(at)}`);
    for (const title of titles)
      put(folder, `${title}.md`, `---\ntitle: ${title}\n---\ntext\n`);

    const pushed = await folder.folder.push();

    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.drain.undelivered).toBe(0);
    expect(
      pushed.value.drain.verdicts.filter(
        (entry) => entry.verdict !== "accepted",
      ),
    ).toEqual([]);
    const sent = (pathname: string) =>
      folder?.server.requests.filter(
        (request) => request.method === "POST" && request.pathname === pathname,
      ) ?? [];
    expect(sent("/items/bulk")).toHaveLength(1);
    expect(sent("/items")).toHaveLength(0);
    expect(sentTitles(folder).sort()).toEqual([...titles].sort());
    expect(sent("/edges/bulk")).toHaveLength(1);
    expect(rows.size).toBe(60);
    expect(
      [...edges.edges.values()].filter(
        (edge) =>
          edge.edge_type === "in-folder" && edge.to_id === folder?.settings.id,
      ),
    ).toHaveLength(60);
  });

  it("sends a file larger than a single request may carry on its own door, and the rest in pages", async () => {
    const large = "user.large_text";
    folder = await folderHarness("pages-folder-large", {
      settings: { query: { types: ["core.note", large] } },
      catalog: typeCatalog([
        wireType(large, {
          bodyField: "body",
          fields: {
            title: { type: "string" },
            body: { type: "string", max_length: 1_000_000 },
          },
        }),
      ]),
    });
    // A server taking larger requests than a page's 1 MiB, so the large file
    // is not held.
    const held = folder;
    held.server.copyAnswer("GET", "/", () =>
      answers.root(held.server.contract, undefined, 4 * 1_048_576),
    );
    const edges = new EdgeDoor();
    scriptFolderWrites(folder, { edges });
    const titles = Array.from({ length: 50 }, (_, at) => `Note ${String(at)}`);
    for (const title of titles)
      put(folder, `${title}.md`, `---\ntitle: ${title}\n---\ntext\n`);
    // Each quote doubles as it is encoded: 600,000 characters, within the
    // type's limit, send as 1.2 MB, over the 1 MiB a single request may carry.
    put(
      folder,
      "Large.md",
      `---\ntype: ${large}\ntitle: Large\n---\n${'"'.repeat(600_000)}\n`,
    );

    const pushed = await folder.folder.push();

    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const sent = (pathname: string) =>
      folder?.server.requests.filter(
        (request) => request.method === "POST" && request.pathname === pathname,
      ) ?? [];
    const pages = sent("/items/bulk");
    expect(pages).toHaveLength(1);
    expect(
      (
        JSON.parse(pages[0]?.body ?? "{}") as {
          items: Array<{ properties: { title: string } }>;
        }
      ).items
        .map((entry) => entry.properties.title)
        .sort(),
    ).toEqual([...titles].sort());
    expect(
      sent("/items").map(
        (request) =>
          (JSON.parse(request.body) as { properties: { title: string } })
            .properties.title,
      ),
    ).toEqual(["Large"]);
  });

  describe("a body past the request limit", () => {
    const large = "user.large_text";
    const titled = (request: RecordedRequest, title: string) =>
      request.method === "POST" &&
      request.pathname === "/items" &&
      (JSON.parse(request.body) as { properties: { title?: string } })
        .properties.title === title;

    /** A folder of notes and long texts, its creates answered by `creating`. */
    async function sized(
      name: string,
      creating?: (answer: Answer, request: RecordedRequest) => Answer,
    ) {
      folder = await folderHarness(name, {
        settings: { query: { types: ["core.note", large] } },
        catalog: typeCatalog([
          wireType(large, {
            bodyField: "body",
            fields: { title: { type: "string" }, body: { type: "string" } },
          }),
        ]),
      });
      scriptFolderWrites(folder, { creating });
      return folder;
    }

    /** Has the root name what `limit` says, or nothing where it says none. */
    function naming(held: FolderHarness, limit: () => number | undefined) {
      held.server.copyAnswer("GET", "/", () =>
        answers.root(held.server.contract, undefined, limit() ?? null),
      );
    }

    const creates = (held: FolderHarness, title: string) =>
      held.server.requests.filter((request) => titled(request, title));

    const note = (title: string, length: number) =>
      `---\ntitle: ${title}\n---\n${"\u00e9".repeat(length)}\n`;

    async function refusedCreate(held: FolderHarness) {
      const pushed = await held.folder.push();
      expect(pushed.ok, JSON.stringify(pushed).slice(0, 400)).toBe(true);
      return pushed.ok
        ? pushed.value.drain.verdicts.find(
            (entry) => entry.kind === "create_item",
          )
        : undefined;
    }

    it("refuses unsent a write one byte past the limit, and sends one at it", async () => {
      const probe = await sized("request-limit-probe");
      naming(probe, () => 100);
      put(probe, "Probe.md", note("Probe", 2_000));
      const told = await refusedCreate(probe);

      expect(told?.verdict).toBe("refused");
      expect(creates(probe, "Probe")).toHaveLength(0);
      expect(told?.reason).not.toContain("request_too_large");
      expect(told?.reason).toContain("this server takes 100.");
      const size = Number(
        /is ([\d,]+) bytes as a request/
          .exec(told?.reason ?? "")?.[1]
          ?.replaceAll(",", ""),
      );
      // Two bytes a character: the bytes sent are counted, not the characters.
      expect(size).toBeGreaterThan(4_000);

      const over = await sized("request-limit-over");
      naming(over, () => size - 1);
      put(over, "Probe.md", note("Probe", 2_000));
      expect((await refusedCreate(over))?.verdict).toBe("refused");
      expect(creates(over, "Probe")).toHaveLength(0);

      const at = await sized("request-limit-at");
      naming(at, () => size);
      put(at, "Probe.md", note("Probe", 2_000));
      expect((await refusedCreate(at))?.verdict).toBe("accepted");
      expect(creates(at, "Probe")).toHaveLength(1);
    });

    it("follows the limit the root names at each drain, raised or lowered", async () => {
      const held = await sized("request-limit-follows");
      let limit = 100;
      naming(held, () => limit);
      put(held, "First.md", note("First", 2_000));
      expect((await held.folder.push()).ok).toBe(true);
      expect(creates(held, "First")).toHaveLength(0);

      limit = 1_000_000;
      // Held for what the root said: nothing changes but what it says now.
      expect((await held.folder.push()).ok).toBe(true);
      expect(creates(held, "First")).toHaveLength(1);

      limit = 100;
      put(held, "Second.md", note("Second", 2_000));
      expect((await held.folder.push()).ok).toBe(true);
      expect(creates(held, "Second")).toHaveLength(0);
    });

    it("sends a large write to a server that names no limit", async () => {
      const held = await sized("request-limit-unnamed");
      naming(held, () => undefined);
      put(held, "Large.md", note("Large", 600_000));
      expect((await refusedCreate(held))?.verdict).toBe("accepted");
      expect(creates(held, "Large")).toHaveLength(1);
    });

    it("sends again under its key a write sent before the limit fell", async () => {
      let dropped = false;
      const held = await sized("request-limit-fell", (answer, request) => {
        if (dropped || !titled(request, "Large")) return answer;
        dropped = true;
        return { kind: "drop" };
      });
      let limit = 1_000_000;
      naming(held, () => limit);
      put(held, "Large.md", note("Large", 2_000));
      await held.folder.push();
      expect(creates(held, "Large")).toHaveLength(1);

      limit = 100;
      await held.folder.push();
      const sent = creates(held, "Large");
      expect(sent).toHaveLength(2);
      expect(sent[1]?.headers["idempotency-key"]).toBe(
        sent[0]?.headers["idempotency-key"],
      );
    });

    it("keeps out of a page a create past the limit, and pages the rest", async () => {
      const held = await sized("request-limit-page");
      naming(held, () => 1_000);
      const titles = Array.from({ length: 50 }, (_, at) => `Small ${at}`);
      for (const title of titles) put(held, `${title}.md`, note(title, 1));
      put(held, "Large.md", note("Large", 2_000));

      expect((await held.folder.push()).ok).toBe(true);

      const pages = held.server.requests.filter(
        (request) =>
          request.method === "POST" && request.pathname === "/items/bulk",
      );
      expect(pages).toHaveLength(1);
      const paged = (
        JSON.parse(pages[0]?.body ?? "{}") as {
          items: Array<{ properties: { title: string } }>;
        }
      ).items.map((entry) => entry.properties.title);
      expect(paged.sort()).toEqual([...titles].sort());
      expect(creates(held, "Large")).toHaveLength(0);
    });

    it("sends no page where a create past the limit leaves fewer than 50", async () => {
      const held = await sized("request-limit-floor");
      naming(held, () => 1_000);
      const titles = Array.from({ length: 49 }, (_, at) => `Small ${at}`);
      for (const title of titles) put(held, `${title}.md`, note(title, 1));
      put(held, "Large.md", note("Large", 2_000));

      expect((await held.folder.push()).ok).toBe(true);

      expect(
        held.server.requests.filter(
          (request) =>
            request.method === "POST" && request.pathname === "/items/bulk",
        ),
      ).toHaveLength(0);
      for (const title of titles) expect(creates(held, title)).toHaveLength(1);
      expect(creates(held, "Large")).toHaveLength(0);
    });

    /** The file with `length` characters under the lines a pull wrote. */
    function saved(held: FolderHarness, name: string, length: number) {
      const text = readFileSync(join(held.dir, name), "utf8");
      put(
        held,
        name,
        `${text.slice(0, text.indexOf("\n---\n", 4) + 5)}${"\u00e9".repeat(length)}\n`,
      );
    }

    async function statusOf(held: FolderHarness, path: string) {
      const told = await held.folder.status();
      expect(told.ok).toBe(true);
      return told.ok
        ? told.value.files.find((file) => file.path === path)
        : undefined;
    }

    const edits = (held: FolderHarness) =>
      held.server.requests.filter((request) => request.method === "PATCH");

    it("ends a hold for size once a later save of the file is answered", async () => {
      const held = await sized("request-limit-later-save");
      let limit = 1_000_000;
      naming(held, () => limit);
      put(held, "Note.md", note("Note", 1));
      expect((await held.folder.push()).ok).toBe(true);
      expect((await held.folder.pull()).ok).toBe(true);

      saved(held, "Note.md", 2_000);
      expect((await held.folder.scan()).ok).toBe(true);
      saved(held, "Note.md", 3);
      expect((await held.folder.scan()).ok).toBe(true);
      limit = 1_000;

      const pushed = await held.folder.push();
      expect(pushed.ok, JSON.stringify(pushed).slice(0, 400)).toBe(true);
      expect(
        pushed.ok &&
          pushed.value.drain.verdicts
            .filter((entry) => entry.kind === "update_item")
            .map((entry) => entry.verdict),
      ).toEqual(["refused", "accepted"]);
      expect(edits(held)).toHaveLength(1);
      const status = await statusOf(held, "Note.md");
      expect(status?.flag, JSON.stringify(status)).toBeUndefined();
      expect(status?.status).toBe("in_step");
    });

    it("keeps a hold for size where an earlier save is what was answered", async () => {
      const held = await sized("request-limit-earlier-save");
      naming(held, () => 1_000);
      put(held, "Note.md", note("Note", 1));
      expect((await held.folder.push()).ok).toBe(true);
      expect((await held.folder.pull()).ok).toBe(true);

      saved(held, "Note.md", 3);
      expect((await held.folder.scan()).ok).toBe(true);
      saved(held, "Note.md", 2_000);
      expect((await held.folder.scan()).ok).toBe(true);

      expect((await held.folder.push()).ok).toBe(true);
      expect(edits(held)).toHaveLength(1);
      const status = await statusOf(held, "Note.md");
      expect(status?.status).toBe("held");
      expect(status?.reason).toContain("this server takes 1,000.");
      expect((await held.folder.pull()).ok).toBe(true);
      expect(readFileSync(join(held.dir, "Note.md"), "utf8")).toContain(
        "\u00e9".repeat(2_000),
      );
    });

    it("warns of a text near a limit the root names, not the default", async () => {
      const held = await sized("request-limit-warning");
      naming(held, () => 10_000);
      put(held, "First.md", note("First", 1));
      expect((await held.folder.push()).ok).toBe(true);

      put(held, "Near.md", note("Near", 4_600));
      put(held, "Under.md", note("Under", 4_000));
      const scanned = await held.folder.scan();
      expect(scanned.ok).toBe(true);
      if (!scanned.ok) return;
      expect(scanned.value.warnings.map((file) => file.path)).toEqual([
        "Near.md",
      ]);
      expect(scanned.value.warnings[0]?.flag).toBe("size");
      expect(scanned.value.warnings[0]?.reason).toContain(
        "of the 10000 a request may carry; a file past that stays here and is not sent",
      );
    });

    it("takes a 413 whose body cannot be read as the refusal it is", async () => {
      const held = await sized("request-limit-unread", (answer, request) =>
        titled(request, "Large")
          ? {
              kind: "bytes",
              status: 413,
              body: Buffer.from('{"error":{"code":"request_too_large"}}'),
              cut: 3,
              headers: { [CONTRACT_HEADER]: String(held.server.contract) },
            }
          : answer,
      );
      naming(held, () => undefined);
      put(
        held,
        "Large.md",
        `---\ntype: ${large}\ntitle: Large\n---\n${'"'.repeat(600_000)}\n`,
      );

      const pushed = await held.folder.push();

      expect(pushed.ok, JSON.stringify(pushed).slice(0, 400)).toBe(true);
      expect(
        pushed.ok &&
          pushed.value.drain.verdicts
            .filter((entry) => entry.kind === "create_item")
            .map((entry) => [entry.verdict, entry.reason]),
      ).toEqual([["refused", "request_too_large"]]);
      expect(
        held.server.requests.filter((request) => titled(request, "Large")),
      ).toHaveLength(1);
    });
  });
});

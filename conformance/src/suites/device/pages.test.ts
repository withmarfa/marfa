import { afterEach, describe, expect, it } from "vitest";
import {
  answers,
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
import type { Answer, RecordedRequest } from "../../device/scripted-server.js";
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

/** A row the server holds before the fixture starts, the target of every
 *  edge the fixtures create. */
const HELD = "01a00000-0000-7000-8000-0000000000aa";

interface ItemEntry {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
  tier?: string;
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
 * the door holds is a repeat, acknowledged with the row as it stands
 * (`items/create-repeat` and `edges/id-repeat`); a page entry naming one is
 * skipped as `duplicate_id` (`items/bulk-create-only-id`).
 */
class Door {
  readonly items = new Map<string, Record<string, unknown>>();
  readonly edges = new Map<string, WireEdgeOptions>();
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
    server.answer("DELETE", /^\/items\/[^/]+$/, (request) => {
      this.items.delete(request.pathname.split("/").at(-1) ?? "");
      return writeAnswers.ok();
    });
    server.answer("POST", "/edges", (request) => {
      const edge = JSON.parse(request.body) as WireEdgeOptions;
      const held = this.edges.get(edge.id);
      if (held !== undefined) return writeAnswers.edgeRepeated(held);
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
      if (item === undefined) return answers.itemNotFound(id);
      return answers.updated({ ...item, edges: this.edgesFrom(id) });
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
    return item;
  }

  /** The edges a read of `source` hydrates, the first page of each type. */
  private edgesFrom(source: string): Record<string, unknown> {
    const byType: Record<string, unknown[]> = {};
    for (const edge of this.edges.values()) {
      if (edge.source_id !== source || this.unlisted.has(edge.id)) continue;
      const type = edge.edge_type ?? "references";
      (byType[type] ??= []).push(wireEdge(edge));
    }
    return Object.fromEntries(
      Object.entries(byType).map(([type, data]) => [
        type,
        { data, next_cursor: null },
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
 *  an edge from each to the held row. */
async function queue(
  harness: Harness,
  count: number,
  options: { edges?: boolean } = {},
): Promise<{ notes: QueuedWrite[]; edges: QueuedWrite[] }> {
  const notes: QueuedWrite[] = [];
  const edges: QueuedWrite[] = [];
  for (let at = 0; at < count; at += 1) {
    const note = value(
      await harness.device.create({
        type: "core.note",
        properties: { title: `Note ${String(at)}`, body: "text" },
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
    rows: {
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
    expect(first.unavailable).toMatch(/429/);
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

  it("ends the drain where the read of a page meets a changed read view, with no write answered", async () => {
    const made = await start("pages-view-changed");
    harness = made.harness;
    const { door } = made;
    const { notes } = await queue(harness, 50);
    let changed = false;
    door.reading = () => {
      if (changed) return undefined;
      changed = true;
      return refusal(409, "read_view_changed", "The read view has changed");
    };

    const drained = await harness.device.drain();

    expect(changed).toBe(true);
    expect(drained.ok, JSON.stringify(drained)).toBe(false);
    if (drained.ok) return;
    expect(drained.refusal.raw).toMatch(/read_view_changed/);
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

  it("sends no create in a page ahead of a write queued before it that is not a create", async () => {
    const target = "01a00000-0000-7000-8000-0000000000bb";
    const sources = Array.from(
      { length: 50 },
      (_, at) => `01a00000-0000-7000-8000-${String(at).padStart(12, "0")}`,
    );
    const made = await start("pages-behind-a-delete", [target, ...sources]);
    harness = made.harness;
    const { door } = made;
    const removed = value(await harness.device.deleteItem(target));
    const edges: QueuedWrite[] = [];
    for (const source of sources)
      edges.push(
        value(
          await harness.device.createEdge({
            source,
            target,
            type: "references",
          }),
        ),
      );

    const drained = await drain(harness);

    const deletes = harness.server.requests.filter(
      (request) =>
        request.method === "DELETE" && request.pathname === `/items/${target}`,
    );
    expect(deletes, JSON.stringify(drained)).toHaveLength(1);
    const deleted = deletes[0]?.seq ?? Infinity;
    // Every edge write went after the delete queued ahead of it, and none
    // in a page sent before the walk reached the delete.
    const edgeWrites = harness.server.requests.filter(
      (request) =>
        request.method === "POST" &&
        (request.pathname === "/edges" || request.pathname === "/edges/bulk"),
    );
    expect(edgeWrites.length).toBeGreaterThan(0);
    expect(edgeWrites.filter((request) => request.seq < deleted)).toEqual([]);
    expect(door.requests("POST", "/edges/bulk")).toHaveLength(0);
    expect(
      door
        .requests("POST", "/edges")
        .map((request) => (JSON.parse(request.body) as WireEdgeOptions).id),
    ).toEqual(edges.map((edge) => edge.edge_id));
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

  it("sends an edge the read of its source does not hold on its own door, under its key, answered as a repeat", async () => {
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
    expect(first.unavailable, JSON.stringify(first)).toMatch(/rate limited/);
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
    expect(first.unavailable, JSON.stringify(first)).toMatch(/rate limited/);
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

  it("settles an edge the owed read of its source leaves out by a read of the edge, and sends it no more", async () => {
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
    expect(first.unavailable, JSON.stringify(first)).toMatch(/rate limited/);
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
    expect(first.unavailable, JSON.stringify(first)).toMatch(/rate limited/);
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

    expect(first.unavailable, JSON.stringify(first)).toMatch(/rate limited/);
    expect(patches).toEqual([]);
    // Another device edits the row between the page and its owed read.
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
          edge.edge_type === "in-folder" &&
          edge.target_id === folder?.settings.id,
      ),
    ).toHaveLength(60);
  });

  it("sends a file larger than a single request may carry on its own door, and the rest in pages", async () => {
    const large = "user.large_text";
    folder = await folderHarness("pages-folder-large", {
      settings: { search: { types: ["core.note", large] } },
      catalog: typeCatalog([
        wireType(large, {
          bodyField: "body",
          fields: {
            title: { type: "string" },
            body: { type: "string", maxLength: 1_000_000 },
          },
        }),
      ]),
    });
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
});

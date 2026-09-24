import { v7 as uuidv7 } from "uuid";
import {
  answers,
  refusal,
  wireItem,
  type ConflictSnapshotBody,
} from "./marfa-answers.js";
import type { Answer } from "./scripted-server.js";

/** `core.note`'s policy, which the server answers a collision with
 *  (`versions.md` 12). The door's rows are notes and files, and a file's
 *  properties collide under the same default. */
const NOTE_MERGE_POLICY = {
  fields: { body: "keep_both_copies", notes: "keep_both_copies" },
  default: "last_writer_wins",
};

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A row the scripted door holds, as the real server would keep it. */
export interface DoorRow {
  properties: Record<string, unknown>;
  source?: string;
  source_id: string | null;
  type?: string;
  version: number;
}

/** A create's body, as far as the door reads it. */
export interface DoorCreate {
  id?: string;
  type?: string;
  properties: Record<string, unknown>;
  source?: string;
  source_id?: string;
  version?: number;
}

/** What the door decided, beside the answer it gives. */
export interface DoorDecision {
  answer: Answer;
  /** The row the create made, where it made one. */
  minted?: string;
}

/**
 * The item doors a folder's drain reaches, deciding as the real server does
 * (`items.md` 4, 5; `versions.md` 10, 18).
 *
 * A folder fixture scripts its server with this rather than with fixed
 * answers, because what a folder does depends on what the server decides:
 * whether a create lands on a row or makes one, is refused for an id or a
 * version, or is refused a source the key does not claim. `fidelity.test.ts`
 * holds each decision here to the real server's for the same request, so a
 * fixture passing against this door is passing against the server's rules and
 * not against this file's.
 */
export class FolderDoor {
  /** Every row the door holds by id, including the ones it was seeded with. */
  readonly rows = new Map<string, DoorRow>();

  /** The properties each row held at each version it has moved past: the
   *  snapshots the server keeps and merges a stale write against. */
  private readonly snapshots = new Map<string, Map<number, DoorRow>>();

  constructor(
    seeded: Iterable<[string, DoorRow]> = [],
    /** Whether the credential's key claims a source other than its own. */
    readonly claims: (source: string) => boolean = () => true,
    /** Whether the credential may read a type, which decides what a
     *  natural key resolving a row of it may learn (`items.md` 5). */
    readonly reads: (type: string) => boolean = () => true,
  ) {
    for (const [id, row] of seeded) this.rows.set(id, row);
  }

  /** The row a natural key names, if the door holds one. */
  keyed(source: string | undefined, sourceId: string): string | undefined {
    return [...this.rows].find(
      ([, row]) => row.source === source && row.source_id === sourceId,
    )?.[0];
  }

  create(sent: DoorCreate): DoorDecision {
    if (sent.source !== undefined && !this.claims(sent.source)) {
      return {
        answer: refusal(
          403,
          "forbidden",
          `This credential may not write under the source "${sent.source}". A write names its own credential's source or one that credential claims.`,
          { source: sent.source },
        ),
      };
    }
    const incumbent =
      sent.source_id === undefined
        ? undefined
        : this.keyed(sent.source, sent.source_id);
    if (incumbent !== undefined) {
      const held = this.rows.get(incumbent)!;
      // Asked before anything else about the row, and answered without
      // naming it: the key learns its key is taken and nothing more.
      if (!this.reads(held.type ?? "core.note")) {
        return {
          answer: refusal(
            403,
            "type_not_permitted",
            "The natural key resolves a row of a type this credential may not reach",
          ),
        };
      }
      if (sent.id !== undefined && sent.id !== incumbent) {
        return {
          answer: answers.idNotTheKeys(
            sent.id,
            incumbent,
            sent.source ?? "",
            sent.source_id ?? "",
          ),
        };
      }
      // A version makes the upsert conditional. A version the row has moved
      // past is merged against its snapshot, and one no snapshot covers is
      // refused: zero, which the server never mints, among them
      // (`versions.md` 9, 10, 18).
      const ancestor =
        sent.version === undefined
          ? undefined
          : this.snapshots.get(incumbent)?.get(sent.version);
      if (ancestor !== undefined) {
        const colliding = Object.keys(sent.properties)
          .filter(
            (field) =>
              !same(sent.properties[field], ancestor.properties[field]) &&
              !same(held.properties[field], ancestor.properties[field]) &&
              !same(held.properties[field], sent.properties[field]),
          )
          .sort();
        // A stale create whose changes collide with nothing is merged by the
        // server; no folder fixture sends one, so the door does not model
        // the merge, and says so rather than answering something else.
        if (colliding.length === 0) {
          return {
            answer: refusal(
              501,
              "not_scripted",
              "the scripted folder door does not merge a stale create",
            ),
          };
        }
        return {
          answer: answers.versionConflict(
            this.snapshot(incumbent, held),
            this.snapshot(incumbent, ancestor),
            colliding,
            NOTE_MERGE_POLICY,
          ),
        };
      }
      if (sent.version !== undefined && sent.version !== held.version) {
        return {
          answer: answers.ancestorUnavailable(
            this.snapshot(incumbent, held),
            sent.version,
          ),
        };
      }
      const now: DoorRow = {
        ...held,
        properties: { ...held.properties, ...sent.properties },
        version: held.version + 1,
      };
      this.remember(incumbent, held);
      this.rows.set(incumbent, now);
      return { answer: answers.upserted(this.wire(incumbent)) };
    }
    const id = sent.id ?? uuidv7();
    this.rows.set(id, {
      properties: sent.properties,
      source: sent.source,
      source_id: sent.source_id ?? null,
      type: sent.type,
      version: 1,
    });
    return { answer: answers.created(this.wire(id)), minted: id };
  }

  /** An update, which moves none of type, source or key unless it names the key. */
  update(
    id: string,
    sent: {
      properties?: Record<string, unknown>;
      source_id?: string;
      version: number;
    },
  ): Answer {
    const before = this.rows.get(id);
    if (before !== undefined) this.remember(id, before);
    this.rows.set(id, {
      properties: { ...before?.properties, ...sent.properties },
      source: before?.source,
      source_id: sent.source_id ?? before?.source_id ?? null,
      type: before?.type,
      version: sent.version + 1,
    });
    return answers.updated(this.wire(id));
  }

  /** A read by id, which a device makes to hold a row a refusal named. */
  read(id: string): Answer {
    return this.rows.has(id)
      ? answers.updated(this.wire(id))
      : refusal(404, "item_not_found", "Item not found");
  }

  private remember(id: string, row: DoorRow): void {
    const kept = this.snapshots.get(id) ?? new Map<number, DoorRow>();
    kept.set(row.version, row);
    this.snapshots.set(id, kept);
  }

  private snapshot(id: string, row: DoorRow): ConflictSnapshotBody {
    return {
      id,
      version: row.version,
      properties: row.properties,
      tier: "library",
      occurred_at: "2026-01-01T00:00:00.000Z",
      source_id: row.source_id,
    };
  }

  /** A row as the server answers it. */
  wire(id: string): Record<string, unknown> {
    const row = this.rows.get(id)!;
    return wireItem({
      id,
      version: row.version,
      type: row.type,
      properties: row.properties,
      ...(row.source === undefined ? {} : { source: row.source }),
      source_id: row.source_id,
    });
  }
}

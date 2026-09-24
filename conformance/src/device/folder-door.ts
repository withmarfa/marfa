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
  /** A row somebody trashed, which a natural key still resolves. */
  trashed?: boolean;
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
 * version, or is refused a source the key does not claim; whether an update
 * lands, names a row that is not there or one in the bin; whether a read finds
 * the row. `fidelity.test.ts` holds each of those decisions to the real
 * server's for the same request, so a fixture passing against this door is
 * passing against the server's rules and not against this file's.
 *
 * What the door does not compute it does not answer: a stale version on an
 * update, or a stale create whose changes collide with nothing, is answered
 * `501` rather than with a merge the door never performed, so a fixture that
 * reaches one fails at the harness rather than passing on an invented answer.
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
      // A row in the bin is acknowledged and not written, whatever version
      // the create carries (`versions.md` 10).
      if (held.trashed === true) {
        // The stored row, which carries no hydrated edges: nothing was
        // written, so nothing was read back with them.
        const { edges: _edges, ...stored } = this.wire(incumbent);
        const body = answers.upserted(stored);
        return {
          answer:
            body.kind === "json"
              ? {
                  ...body,
                  body: {
                    ...(body.body as Record<string, unknown>),
                    acknowledged: true,
                  },
                }
              : body,
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
              !same(held.properties[field], ancestor.properties[field]),
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

  /**
   * An update, which moves none of type, source or key unless it names the
   * key. On the version the row is at it lands. On one the row has moved
   * past it is merged against that version's snapshot as the server merges
   * it (`versions.md` 8, 11, 13): a field only it changed is applied, a field
   * both changed collides, and a collision is resolved last writer wins where
   * the caller asked the server to resolve and refused where it did not. A
   * collision on a keep-both property, which the server answers by writing a
   * sibling, is not modeled and answers `501`.
   */
  update(
    id: string,
    sent: {
      properties?: Record<string, unknown>;
      source_id?: string;
      version: number;
    },
    options: { resolve?: boolean } = {},
  ): Answer {
    // A row in the bin is not there to an update, as it is not to a read.
    const before = this.rows.get(id);
    if (before === undefined || before.trashed === true) {
      return refusal(404, "item_not_found", `Item ${id} not found`);
    }
    const sentProperties = sent.properties ?? {};
    let applied: Record<string, unknown> = sentProperties;
    let sourceId = sent.source_id ?? before.source_id;
    let resolution: Record<string, string> | undefined;
    if (sent.version !== before.version) {
      const ancestor = this.snapshots.get(id)?.get(sent.version);
      if (ancestor === undefined) {
        return answers.ancestorUnavailable(
          this.snapshot(id, before),
          sent.version,
        );
      }
      const sides = Object.keys(sentProperties).map((field) => ({
        field,
        mine: sentProperties[field],
        base: ancestor.properties[field],
        theirs: before.properties[field],
      }));
      if (sent.source_id !== undefined) {
        sides.push({
          field: "source_id",
          mine: sent.source_id,
          base: ancestor.source_id,
          theirs: before.source_id,
        });
      }
      const changed = sides.filter((side) => !same(side.mine, side.base));
      // Both changed it, whether or not to the same value: the server calls
      // that a collision too, and resolves it to the value both wrote.
      const colliding = changed.filter((side) => !same(side.theirs, side.base));
      const keepBoth = Object.keys(NOTE_MERGE_POLICY.fields);
      if (colliding.some((side) => keepBoth.includes(side.field))) {
        return refusal(
          501,
          "not_scripted",
          "the scripted folder door does not write a conflicted copy",
        );
      }
      if (colliding.length > 0 && options.resolve !== true) {
        return answers.versionConflict(
          this.snapshot(id, before),
          this.snapshot(id, ancestor),
          colliding.map((side) => side.field).sort(),
          NOTE_MERGE_POLICY,
        );
      }
      applied = Object.fromEntries(
        changed
          .filter((side) => side.field !== "source_id")
          .map((side) => [side.field, side.mine]),
      );
      sourceId = changed.some((side) => side.field === "source_id")
        ? (sent.source_id ?? before.source_id)
        : before.source_id;
      if (colliding.length > 0) {
        resolution = Object.fromEntries(
          colliding.map((side) => [side.field, "last_writer_wins"]),
        );
      }
    }
    this.remember(id, before);
    this.rows.set(id, {
      ...before,
      properties: { ...before.properties, ...applied },
      source_id: sourceId,
      version: before.version + 1,
    });
    return resolution === undefined
      ? answers.updated(this.wire(id))
      : answers.resolved(this.wire(id), resolution);
  }

  /** A read by id, which a device makes to hold a row a refusal named. A row
   *  in the bin reads as absent, as it does on the server. */
  read(id: string): Answer {
    const row = this.rows.get(id);
    return row !== undefined && row.trashed !== true
      ? answers.updated(this.wire(id))
      : refusal(404, "item_not_found", `Item ${id} not found`);
  }

  /** Moves a row to the bin, as another device's delete would. */
  trash(id: string): void {
    const row = this.rows.get(id);
    if (row !== undefined) this.rows.set(id, { ...row, trashed: true });
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
      ...(row.trashed === true ? { state: "trashed" } : {}),
    });
  }
}

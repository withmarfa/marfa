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
  /** The row's tags, which a read answers in its metadata. */
  tags?: string[];
  tier?: "library" | "feed";
  /** `archived`, where a transition moved it there. */
  state?: string;
}

/** The tag the server gives the sibling a keep-both resolution writes. */
export const CONFLICTED_COPY_TAG = "conflicted-copy";

/** A create's body, as far as the door reads it. */
export interface DoorCreate {
  id?: string;
  type?: string;
  properties: Record<string, unknown>;
  source?: string;
  source_id?: string;
  tier?: "library" | "feed";
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
 * the row. The queue's fixtures for an edit behind an edit use it for the same
 * reason: what the second edit meets depends on what the server made of the
 * first. `fidelity.test.ts` holds each of those decisions to the real
 * server's for the same request, so a fixture passing against this door is
 * passing against the server's rules and not against this file's.
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
    /** Whether the refusal for such a row names its id and type, which the
     *  real server never does. A fixture asserting a folder learns nothing
     *  of the row sets this for its control, to show that what the refusal
     *  carries does reach what it asserts on. */
    readonly names: boolean = false,
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
    // An id the door already holds, where no natural key resolves a row, is a
    // repeat of a create it performed: acknowledged with the row as it
    // stands, and nothing written (`items.md` 3). A repeat naming a row of
    // another type is refused `id_reused`, which the door does not model.
    const repeated = sent.id === undefined ? undefined : this.rows.get(sent.id);
    if (
      incumbent === undefined &&
      sent.id !== undefined &&
      repeated !== undefined
    ) {
      if ((repeated.type ?? "core.note") !== (sent.type ?? "core.note")) {
        return {
          answer: refusal(
            501,
            "not_scripted",
            "the scripted folder door does not refuse an id reused for another type",
          ),
        };
      }
      return { answer: this.acknowledged(sent.id) };
    }
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
            this.names
              ? { id: incumbent, type: held.type ?? "core.note" }
              : undefined,
          ),
        };
      }
      // A row in the bin is acknowledged and not written, whatever version
      // the create carries (`versions.md` 10).
      if (held.trashed === true) {
        return { answer: this.acknowledged(incumbent) };
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
        // A stale create whose changes collide with nothing is merged over
        // the row as it stands: only what it changed since the version it
        // names is applied, and the answer is the upsert's.
        if (colliding.length === 0) {
          const changed = Object.fromEntries(
            Object.entries(sent.properties).filter(
              ([field, value]) => !same(value, ancestor.properties[field]),
            ),
          );
          this.remember(incumbent, held);
          this.rows.set(incumbent, {
            ...held,
            properties: { ...held.properties, ...changed },
            version: held.version + 1,
          });
          return { answer: answers.upserted(this.wire(incumbent)) };
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
      ...(sent.tier === undefined ? {} : { tier: sent.tier }),
      version: 1,
    });
    return { answer: answers.created(this.wire(id)), minted: id };
  }

  /**
   * An update, which moves none of type, source or key unless it names the
   * key. On the version the row is at it lands. On one the row has moved
   * past it is merged against that version's snapshot as the server merges
   * it (`versions.md` 8, 11, 13): a property, or the natural key, that only
   * it changed is applied, one both changed collides, and a collision is
   * refused where the caller did not ask the server to resolve. Where it did,
   * a last-writer property and the natural key take this write's value, and a
   * keep-both property keeps the row's while this write's goes to a sibling:
   * the row's properties with the losing values laid over, under the row's
   * type and source and no natural key, tagged as a conflicted copy.
   */
  update(
    id: string,
    sent: {
      properties?: Record<string, unknown>;
      properties_mode?: "merge" | "replace";
      source_id?: string;
      type?: string;
      retype?: boolean;
      tier?: "library" | "feed";
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
    // Under replace the body is the row's whole properties, so a field it
    // leaves out is one it clears (`items.md` 22).
    const replace = sent.properties_mode === "replace";
    const moves = {
      ...(sent.retype === true && sent.type !== undefined
        ? { type: sent.type }
        : {}),
      ...(sent.tier === undefined ? {} : { tier: sent.tier }),
    };
    let applied: Record<string, unknown> = sentProperties;
    let cleared: string[] = replace
      ? Object.keys(before.properties).filter(
          (field) => !(field in sentProperties),
        )
      : [];
    let sourceId = sent.source_id ?? before.source_id;
    let resolution: Record<string, string> | undefined;
    let sibling: string | undefined;
    if (sent.version !== before.version) {
      const ancestor = this.snapshots.get(id)?.get(sent.version);
      if (ancestor === undefined) {
        return answers.ancestorUnavailable(
          this.snapshot(id, before),
          sent.version,
        );
      }
      const fields = replace
        ? [
            ...new Set([
              ...Object.keys(sentProperties),
              ...Object.keys(ancestor.properties),
            ]),
          ]
        : Object.keys(sentProperties);
      const sides = fields.map((field) => ({
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
      if (colliding.length > 0 && options.resolve !== true) {
        return answers.versionConflict(
          this.snapshot(id, before),
          this.snapshot(id, ancestor),
          colliding.map((side) => side.field).sort(),
          NOTE_MERGE_POLICY,
        );
      }
      const keepBoth = Object.keys(NOTE_MERGE_POLICY.fields);
      const kept = colliding.filter((side) => keepBoth.includes(side.field));
      const taken = changed.filter(
        (side) => side.field !== "source_id" && !kept.includes(side),
      );
      applied = Object.fromEntries(
        taken
          .filter((side) => side.mine !== undefined)
          .map((side) => [side.field, side.mine]),
      );
      cleared = taken
        .filter((side) => side.mine === undefined)
        .map((side) => side.field);
      sourceId = changed.some((side) => side.field === "source_id")
        ? (sent.source_id ?? before.source_id)
        : before.source_id;
      if (colliding.length > 0) {
        resolution = Object.fromEntries(
          colliding.map((side) => [
            side.field,
            kept.includes(side) ? "keep_both_copies" : "last_writer_wins",
          ]),
        );
      }
      if (kept.length > 0) {
        sibling = uuidv7();
        this.rows.set(sibling, {
          properties: {
            ...before.properties,
            ...Object.fromEntries(kept.map((side) => [side.field, side.mine])),
          },
          source: before.source,
          source_id: null,
          type: before.type,
          version: 1,
          tags: [...new Set([...(before.tags ?? []), CONFLICTED_COPY_TAG])],
        });
      }
    }
    this.remember(id, before);
    const properties = { ...before.properties, ...applied };
    for (const field of cleared) delete properties[field];
    this.rows.set(id, {
      ...before,
      ...moves,
      properties,
      source_id: sourceId,
      version: before.version + 1,
    });
    return resolution === undefined
      ? answers.updated(this.wire(id))
      : answers.resolved(this.wire(id), resolution, sibling);
  }

  /** A create the door answers without writing: the stored row, which
   *  carries no hydrated edges because nothing was read back with them. */
  private acknowledged(id: string): Answer {
    const { edges: _edges, ...stored } = this.wire(id);
    const body = answers.upserted(stored);
    return body.kind === "json"
      ? {
          ...body,
          body: {
            ...(body.body as Record<string, unknown>),
            acknowledged: true,
          },
        }
      : body;
  }

  /** The conflicted copies a keep-both resolution wrote, by id. */
  conflictedCopies(): Array<[string, DoorRow]> {
    return [...this.rows].filter(([, row]) =>
      (row.tags ?? []).includes(CONFLICTED_COPY_TAG),
    );
  }

  /** A read by id, which a device makes to hold a row a refusal named. A row
   *  in the bin reads as absent, as it does on the server. */
  read(id: string): Answer {
    const row = this.rows.get(id);
    return row !== undefined && row.trashed !== true
      ? answers.updated(this.wire(id), row.tags ?? [])
      : refusal(404, "item_not_found", `Item ${id} not found`);
  }

  /** A move to another lifecycle state, which takes no version step. */
  transition(id: string, state: string): Answer {
    const row = this.rows.get(id);
    if (row === undefined || row.trashed === true) {
      return refusal(404, "item_not_found", `Item ${id} not found`);
    }
    this.rows.set(id, { ...row, state });
    // The stored row, as the transition door answers it: no hydrated edges.
    const { edges: _edges, ...stored } = this.wire(id);
    return answers.updated(stored, row.tags ?? []);
  }

  /** Drops the snapshot of one version, as the server's version thinning
   *  does: a write naming it is then refused `ancestor_unavailable`. */
  thin(id: string, version: number): void {
    this.snapshots.get(id)?.delete(version);
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
      tier: row.tier ?? "library",
      occurred_at: "2026-01-01T00:00:00.000Z",
      source_id: row.source_id,
      type: row.type ?? "core.note",
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
      ...(row.tier === undefined ? {} : { tier: row.tier }),
      source_id: row.source_id,
      ...(row.state === undefined ? {} : { state: row.state }),
      ...(row.trashed === true ? { state: "trashed" } : {}),
    });
  }
}

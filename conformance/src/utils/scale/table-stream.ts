import { rowNumber } from "./table-data.js";

interface Frame {
  item?: { id?: unknown };
  table?: unknown;
  batch?: unknown;
  values_included?: unknown;
  rows?: unknown;
}

const KEPT_PROBLEMS = 10;

/**
 * Matches the batches a writer was told were written against the `rows.changed`
 * frames a stream received, exactly: each batch once, with the rows the writer
 * created and, where the frame carries values, the values that were written.
 */
export class BatchLedger {
  readonly lags: number[] = [];
  readonly problems: string[] = [];
  problemCount = 0;
  private readonly writes = new Map<string, { ids: string[]; at: number }>();
  private readonly frames = new Map<string, { ids: string[]; at: number }>();
  private readonly matched = new Set<string>();

  constructor(
    private readonly itemId: string,
    private readonly table: string,
    private readonly buckets: number,
  ) {}

  private fail(message: string): void {
    this.problemCount++;
    if (this.problems.length < KEPT_PROBLEMS) this.problems.push(message);
  }

  /** How many written batches have no frame yet. */
  get waiting(): number {
    return this.writes.size;
  }

  get batches(): number {
    return this.matched.size;
  }

  /** The writer's answer for a batch: the ids of the rows it created. */
  written(batch: string, ids: string[], at: number): void {
    if (this.matched.has(batch) || this.writes.has(batch)) {
      this.fail(`batch ${batch} was answered twice`);
      return;
    }
    this.writes.set(batch, { ids, at });
    this.meet(batch);
  }

  /** A frame the stream received; frames of other items are not this table's. */
  frame(data: unknown, at: number): void {
    const frame = data as Frame | null;
    if (typeof frame?.item?.id !== "string") {
      this.fail("a rows.changed frame names no item");
      return;
    }
    if (frame.item.id !== this.itemId) return;
    if (typeof frame.batch !== "string") {
      this.fail("a rows.changed frame names no batch");
      return;
    }
    const { batch } = frame;
    if (frame.table !== this.table) {
      this.fail(`batch ${batch} names table ${JSON.stringify(frame.table)}`);
    }
    if (!Array.isArray(frame.rows)) {
      this.fail(`batch ${batch} holds no rows array`);
      return;
    }
    const withValues = frame.values_included !== false;
    const ids: string[] = [];
    for (const row of frame.rows as {
      id?: unknown;
      values?: unknown;
      deleted?: unknown;
    }[]) {
      if (typeof row?.id !== "string") {
        this.fail(`batch ${batch} holds a row with no id`);
        continue;
      }
      ids.push(row.id);
      if (row.deleted !== undefined) {
        this.fail(`batch ${batch} says row ${row.id} was deleted`);
      } else if (withValues && rowNumber(row.values, this.buckets) === null) {
        this.fail(
          `batch ${batch} holds values for row ${row.id} never written`,
        );
      }
    }
    if (this.matched.has(batch) || this.frames.has(batch)) {
      this.fail(`batch ${batch} came in more than one frame`);
      return;
    }
    this.frames.set(batch, { ids, at });
    this.meet(batch);
  }

  private meet(batch: string): void {
    const write = this.writes.get(batch);
    const frame = this.frames.get(batch);
    if (write === undefined || frame === undefined) return;
    this.writes.delete(batch);
    this.frames.delete(batch);
    this.matched.add(batch);
    this.lags.push(Math.max(0, frame.at - write.at));
    const held = new Set(frame.ids);
    if (
      held.size !== frame.ids.length ||
      frame.ids.length !== write.ids.length ||
      write.ids.some((id) => !held.has(id))
    ) {
      this.fail(
        `batch ${batch} frame holds ${frame.ids.length} rows, the write created ${write.ids.length}, and they differ`,
      );
    }
  }

  /** Calls out every batch the two sides did not both see; call once, last. */
  finish(): void {
    for (const batch of this.writes.keys()) {
      this.fail(`batch ${batch} was written and no frame reached the stream`);
    }
    for (const batch of this.frames.keys()) {
      this.fail(`batch ${batch} reached the stream and no write made it`);
    }
  }
}

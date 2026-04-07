import { eq, asc } from "drizzle-orm";
import type { LocalDb } from "../local/connection.js";
import { mutationQueue } from "../local/schema.js";
import type { MymeClient } from "@mymehq/sdk";

export type MutationOperation =
  | "create"
  | "update"
  | "delete"
  | "restore"
  | "transition"
  | "tag"
  | "untag"
  | "meta";

export interface QueuedMutation {
  id: number;
  operation: MutationOperation;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
}

const MAX_RETRIES = 10;

export class MutationQueue {
  private processing = false;

  constructor(
    private db: LocalDb,
    private client: MymeClient,
  ) {}

  /** Enqueue a mutation for eventual delivery. */
  enqueue(
    operation: MutationOperation,
    entityType: string,
    entityId: string,
    payload: Record<string, unknown>,
  ): void {
    const now = new Date().toISOString();
    this.db
      .insert(mutationQueue)
      .values({
        operation,
        entity_type: entityType,
        entity_id: entityId,
        payload: JSON.stringify(payload),
        status: "pending",
        attempts: 0,
        created_at: now,
        updated_at: now,
      })
      .run();
  }

  /** Replay pending mutations in order. Stops on first network error. */
  async flush(): Promise<{ replayed: number; failed: number }> {
    if (this.processing) return { replayed: 0, failed: 0 };
    this.processing = true;

    let replayed = 0;
    let failed = 0;

    try {
      const pending = this.db
        .select()
        .from(mutationQueue)
        .where(eq(mutationQueue.status, "pending"))
        .orderBy(asc(mutationQueue.created_at))
        .all();

      for (const row of pending) {
        const mutation: QueuedMutation = {
          id: row.id,
          operation: row.operation as MutationOperation,
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
          status: row.status,
          attempts: row.attempts,
        };

        try {
          await this.executeMutation(mutation);
          this.removeMutation(mutation.id);
          replayed++;
        } catch (err: unknown) {
          if (isNetworkError(err)) {
            // Stop processing — will retry later
            this.incrementAttempts(mutation.id);
            break;
          }
          if (isDuplicateError(err)) {
            // Server already has it — treat as success
            this.removeMutation(mutation.id);
            replayed++;
            continue;
          }
          // Business logic error — mark as failed
          if (mutation.attempts + 1 >= MAX_RETRIES) {
            this.markFailed(mutation.id);
            failed++;
          } else {
            this.incrementAttempts(mutation.id);
            failed++;
          }
        }
      }
    } finally {
      this.processing = false;
    }

    return { replayed, failed };
  }

  /** Number of pending mutations. */
  pendingCount(): number {
    const rows = this.db
      .select()
      .from(mutationQueue)
      .where(eq(mutationQueue.status, "pending"))
      .all();
    return rows.length;
  }

  private async executeMutation(mutation: QueuedMutation): Promise<void> {
    switch (mutation.operation) {
      case "create":
        await this.client.items.create(
          mutation.payload as unknown as Parameters<
            typeof this.client.items.create
          >[0],
        );
        break;
      case "update":
        await this.client.items.update(
          mutation.entity_id,
          mutation.payload.properties as Record<string, unknown>,
          { version: mutation.payload.version as number },
        );
        break;
      case "delete":
        await this.client.items.delete(mutation.entity_id);
        break;
      case "restore":
        await this.client.items.restore(mutation.entity_id);
        break;
      case "transition":
        await this.client.items.transition(
          mutation.entity_id,
          mutation.payload.state as string,
        );
        break;
      case "tag":
        await this.client.metadata.addTags(
          mutation.entity_id,
          mutation.payload.tags as string[],
        );
        break;
      case "untag":
        await this.client.metadata.removeTag(
          mutation.entity_id,
          mutation.payload.tag as string,
        );
        break;
      case "meta":
        await this.client.metadata.set(
          mutation.entity_id,
          mutation.payload as { tags?: string[]; about?: string[] },
        );
        break;
    }
  }

  private removeMutation(id: number): void {
    this.db.delete(mutationQueue).where(eq(mutationQueue.id, id)).run();
  }

  private incrementAttempts(id: number): void {
    const now = new Date().toISOString();
    this.db
      .update(mutationQueue)
      .set({
        attempts:
          (this.db
            .select()
            .from(mutationQueue)
            .where(eq(mutationQueue.id, id))
            .get()?.attempts ?? 0) + 1,
        updated_at: now,
      })
      .where(eq(mutationQueue.id, id))
      .run();
  }

  private markFailed(id: number): void {
    this.db
      .update(mutationQueue)
      .set({ status: "failed", updated_at: new Date().toISOString() })
      .where(eq(mutationQueue.id, id))
      .run();
  }
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    err.name === "AbortError" ||
    msg.includes("fetch") ||
    msg.includes("network") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("timeout")
  );
}

function isDuplicateError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("duplicate_source");
}

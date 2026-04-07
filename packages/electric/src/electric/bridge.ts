import type { Message, Row } from "@electric-sql/client";
import type { Item, Metadata, Thread } from "@mymehq/shared";
import type { LocalStorage } from "../local/storage.js";
import type { ShapeStreams } from "./collections.js";
import type { ConnectionStateManager } from "./connection-state.js";
import { parseJson } from "../local/helpers.js";

/** Subscribes to Electric ShapeStreams and persists changes to local SQLite. */
export class ElectricBridge {
  private unsubscribers: (() => void)[] = [];

  constructor(
    private streams: ShapeStreams,
    private storage: LocalStorage,
    private connectionState: ConnectionStateManager,
  ) {}

  start(): void {
    this.connectionState.transition("connecting");

    // Subscribe to threads first (items may reference threads)
    this.unsubscribers.push(
      this.streams.threads.subscribe(
        (messages) => {
          this.handleMessages("threads", messages);
        },
        (err) => {
          this.handleError(err);
        },
      ),
    );

    this.unsubscribers.push(
      this.streams.items.subscribe(
        (messages) => {
          this.handleMessages("items", messages);
        },
        (err) => {
          this.handleError(err);
        },
      ),
    );

    this.unsubscribers.push(
      this.streams.metadata.subscribe(
        (messages) => {
          this.handleMessages("metadata", messages);
        },
        (err) => {
          this.handleError(err);
        },
      ),
    );

    this.connectionState.transition("syncing");
  }

  stop(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.connectionState.transition("disconnected");
  }

  private handleMessages(table: string, messages: Message[]): void {
    for (const msg of messages) {
      if ("headers" in msg && "control" in msg.headers) {
        if (msg.headers.control === "up-to-date") {
          this.connectionState.transition("connected");
        }
        continue;
      }

      if ("headers" in msg && "operation" in msg.headers) {
        const changeMsg = msg as {
          key: string;
          value: Row;
          headers: { operation: string };
        };
        try {
          this.applyChange(
            table,
            changeMsg.headers.operation,
            changeMsg.value,
            changeMsg.key,
          );
        } catch (err) {
          console.error(`ElectricBridge: error applying ${table} change`, err);
        }
      }
    }
  }

  private applyChange(
    table: string,
    operation: string,
    value: Row,
    key: string,
  ): void {
    switch (table) {
      case "items":
        if (operation === "delete") {
          this.storage.items.remove(key);
        } else {
          this.storage.items.upsert(coerceItem(value));
        }
        break;

      case "metadata":
        if (operation === "delete") {
          this.storage.metadata.remove(key);
        } else {
          this.storage.metadata.upsert(coerceMetadata(value));
        }
        break;

      case "threads":
        if (operation === "delete") {
          this.storage.threads.remove(key);
        } else {
          this.storage.threads.upsert(coerceThread(value));
        }
        break;
    }
  }

  private handleError(err: Error): void {
    console.error("ElectricBridge: stream error", err);
    this.connectionState.transition("error", err);
  }
}

// ---------------------------------------------------------------------------
// Data coercion (Electric sends all values as strings)
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  if (v == null) return "";
  return String(v as string | number | boolean);
}

function optStr(v: unknown): string | undefined {
  if (v == null) return undefined;
  return String(v as string | number | boolean);
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

function optNum(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

function coerceItem(row: Row): Item {
  return {
    id: str(row.id),
    type: str(row.type),
    state: str(row.state) as Item["state"],
    properties:
      typeof row.properties === "string"
        ? parseJson(row.properties, {})
        : (row.properties as Record<string, unknown>),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    timestamp: str(row.timestamp),
    source: optStr(row.source),
    source_id: optStr(row.source_id),
    origin: optStr(row.origin),
    version: num(row.version, 1),
    schema_version: optNum(row.schema_version),
    device_id: optStr(row.device_id),
    parent_id: optStr(row.parent_id) ?? null,
    thread_id: optStr(row.thread_id) ?? null,
    capture_latitude: optNum(row.capture_latitude),
    capture_longitude: optNum(row.capture_longitude),
  };
}

function coerceMetadata(row: Row): Metadata {
  const tags =
    typeof row.tags === "string"
      ? parseJson(row.tags, [])
      : Array.isArray(row.tags)
        ? (row.tags as string[])
        : [];

  const about =
    typeof row.about === "string"
      ? parseJson(row.about, [])
      : Array.isArray(row.about)
        ? (row.about as string[])
        : [];

  const extensions =
    typeof row.extensions === "string"
      ? parseJson(row.extensions, {})
      : (row.extensions as Record<string, Record<string, unknown>>);

  return {
    item_id: str(row.item_id),
    tags,
    about,
    extensions,
  };
}

function coerceThread(row: Row): Thread {
  return {
    id: str(row.id),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

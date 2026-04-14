/**
 * App-layer backfill script that translates legacy relationship state into
 * first-class edges:
 *
 *   items.parent_id          -> parent-of edges
 *     (source = parent, target = child)
 *   items.thread_id          -> in-thread edges (with `position`)
 *     (source = member, target = thread)
 *   metadata.about[]         -> about edges
 *     (source = item, target = listed id)
 *
 * Idempotent — uses edgeStore.existsExact so re-runs are safe. Direction is
 * spec-exact per V0 Relationships: parent is source of parent-of, member is
 * source of in-thread, item is source of about. Do not swap.
 *
 * Intended to be invoked after Drizzle migration 0009 (the sentinel marker).
 * The CLI entrypoint at src/storage/migrate.ts calls this automatically after
 * running migrations.
 *
 * Usage directly: STORAGE_DIALECT=pg DATABASE_URL=... tsx scripts/backfill-edges.ts
 */

import { generateId } from "@mymehq/shared";
import type { Storage } from "../src/storage/interface.js";

interface BackfillCounts {
  parentOf: number;
  inThread: number;
  about: number;
  skipped: number;
}

export interface LegacyRelationshipData {
  withParent: {
    id: string;
    tenant_id: string | null;
    parent_id: string;
    created_at: string;
  }[];
  withThread: {
    id: string;
    tenant_id: string | null;
    thread_id: string;
    created_at: string;
  }[];
  metadataAbout: Map<string, { about: string[]; tenant_id: string | null }>;
}

export async function backfillEdges(
  storage: Storage,
  preloaded?: LegacyRelationshipData,
): Promise<BackfillCounts> {
  const counts: BackfillCounts = {
    parentOf: 0,
    inThread: 0,
    about: 0,
    skipped: 0,
  };

  await storage.runInTransaction(async () => {
    // Helper for idempotency: skip if an equivalent edge already exists.
    const createIfMissing = async (
      sourceId: string,
      targetId: string,
      edgeType: string,
      tenantId: string | undefined,
      properties?: Record<string, unknown>,
    ): Promise<boolean> => {
      const exists = await storage.edges.existsExact(
        sourceId,
        targetId,
        edgeType,
      );
      if (exists) {
        counts.skipped++;
        return false;
      }
      await storage.edges.createRaw(
        {
          id: generateId(),
          source_id: sourceId,
          target_id: targetId,
          edge_type: edgeType,
          properties,
        },
        tenantId,
      );
      return true;
    };

    // ---- 1. parent_id → parent-of (source=parent, target=child) ----
    // Use preloaded snapshot when provided (migrator took one pre-migration
    // because 0010 drops these columns). Fall back to live DB reads for
    // direct-invocation on a not-yet-migrated DB.
    const allItems =
      preloaded ?? (await collectAllItemsWithParentOrThread(storage));

    for (const item of allItems.withParent) {
      const created = await createIfMissing(
        item.parent_id, // parent is SOURCE
        item.id, // child is TARGET
        "parent-of",
        item.tenant_id ?? undefined,
      );
      if (created) counts.parentOf++;
    }

    // ---- 2. thread_id → in-thread with position ----
    // Group by thread_id, sort by (created_at, id) for deterministic ordering.
    const byThread = new Map<
      string,
      { id: string; tenant_id: string | null; created_at: string }[]
    >();
    for (const item of allItems.withThread) {
      const list = byThread.get(item.thread_id) ?? [];
      list.push({
        id: item.id,
        tenant_id: item.tenant_id,
        created_at: item.created_at,
      });
      byThread.set(item.thread_id, list);
    }
    for (const [threadId, members] of byThread) {
      members.sort((a, b) => {
        const byCreated = a.created_at.localeCompare(b.created_at);
        if (byCreated !== 0) return byCreated;
        return a.id.localeCompare(b.id);
      });
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (!m) continue;
        const created = await createIfMissing(
          m.id, // member is SOURCE
          threadId, // thread is TARGET
          "in-thread",
          m.tenant_id ?? undefined,
          { position: i + 1 },
        );
        if (created) counts.inThread++;
      }
    }

    // ---- 3. metadata.about[] → about edges ----
    for (const [itemId, info] of allItems.metadataAbout) {
      for (const targetId of info.about) {
        const created = await createIfMissing(
          itemId, // item is SOURCE
          targetId, // listed id is TARGET
          "about",
          info.tenant_id ?? undefined,
        );
        if (created) counts.about++;
      }
    }
  });

  return counts;
}

/**
 * One-shot helper that reads every item + metadata row we care about and
 * returns them grouped. Runs three raw SQL queries via the Storage's
 * runInTransaction-free path since we're already inside the caller's
 * transaction.
 *
 * Both dialects accept the same raw SQL here — the queries touch only
 * standard columns (id, tenant_id, parent_id, thread_id, created_at) and
 * metadata (item_id, about).
 */
async function collectAllItemsWithParentOrThread(storage: Storage): Promise<{
  withParent: {
    id: string;
    tenant_id: string | null;
    parent_id: string;
    created_at: string;
  }[];
  withThread: {
    id: string;
    tenant_id: string | null;
    thread_id: string;
    created_at: string;
  }[];
  metadataAbout: Map<string, { about: string[]; tenant_id: string | null }>;
}> {
  // Reach through to the underlying raw driver using a tiny
  // capability-probe shim. Every dialect-specific storage factory exposes a
  // `_rawAll` / client handle; keep the probe tolerant — fall back to an
  // item-store list() walk when raw isn't available.
  interface RawProbe {
    __pgClient?: (query: string) => Promise<unknown[]>;
    __sqliteAll?: (query: string) => unknown[];
  }
  const probe = storage as unknown as RawProbe;

  if (probe.__pgClient) {
    const parentRows = (await probe.__pgClient(
      "SELECT id, tenant_id, parent_id, created_at FROM items WHERE parent_id IS NOT NULL",
    )) as {
      id: string;
      tenant_id: string | null;
      parent_id: string;
      created_at: string;
    }[];
    const threadRows = (await probe.__pgClient(
      "SELECT id, tenant_id, thread_id, created_at FROM items WHERE thread_id IS NOT NULL",
    )) as {
      id: string;
      tenant_id: string | null;
      thread_id: string;
      created_at: string;
    }[];
    const metaRows = (await probe.__pgClient(
      "SELECT m.item_id, m.about, i.tenant_id FROM metadata m JOIN items i ON m.item_id = i.id WHERE m.about IS NOT NULL AND m.about != '[]'",
    )) as {
      item_id: string;
      about: string;
      tenant_id: string | null;
    }[];
    return toGrouped(parentRows, threadRows, metaRows);
  }

  if (probe.__sqliteAll) {
    const parentRows = probe.__sqliteAll(
      "SELECT id, tenant_id, parent_id, created_at FROM items WHERE parent_id IS NOT NULL",
    ) as {
      id: string;
      tenant_id: string | null;
      parent_id: string;
      created_at: string;
    }[];
    const threadRows = probe.__sqliteAll(
      "SELECT id, tenant_id, thread_id, created_at FROM items WHERE thread_id IS NOT NULL",
    ) as {
      id: string;
      tenant_id: string | null;
      thread_id: string;
      created_at: string;
    }[];
    const metaRows = probe.__sqliteAll(
      "SELECT m.item_id, m.about, i.tenant_id FROM metadata m JOIN items i ON m.item_id = i.id WHERE m.about IS NOT NULL AND m.about != '[]'",
    ) as {
      item_id: string;
      about: string;
      tenant_id: string | null;
    }[];
    return toGrouped(parentRows, threadRows, metaRows);
  }

  throw new Error(
    "backfill-edges: storage does not expose a raw query escape hatch (__pgClient or __sqliteAll)",
  );
}

function toGrouped(
  parentRows: {
    id: string;
    tenant_id: string | null;
    parent_id: string;
    created_at: string;
  }[],
  threadRows: {
    id: string;
    tenant_id: string | null;
    thread_id: string;
    created_at: string;
  }[],
  metaRows: {
    item_id: string;
    about: string;
    tenant_id: string | null;
  }[],
): {
  withParent: {
    id: string;
    tenant_id: string | null;
    parent_id: string;
    created_at: string;
  }[];
  withThread: {
    id: string;
    tenant_id: string | null;
    thread_id: string;
    created_at: string;
  }[];
  metadataAbout: Map<string, { about: string[]; tenant_id: string | null }>;
} {
  const metadataAbout = new Map<
    string,
    { about: string[]; tenant_id: string | null }
  >();
  for (const row of metaRows) {
    let about: string[] = [];
    try {
      const parsed = JSON.parse(row.about) as unknown;
      if (Array.isArray(parsed)) {
        about = parsed.filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        );
      }
    } catch {
      // corrupt row — skip
    }
    if (about.length > 0) {
      metadataAbout.set(row.item_id, { about, tenant_id: row.tenant_id });
    }
  }
  return { withParent: parentRows, withThread: threadRows, metadataAbout };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function mainCli(): Promise<void> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  let storage: Storage;
  if (dialect === "pg") {
    const { createPgStorage } = await import("../src/storage/pg/index.js");
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error("DATABASE_URL required for pg backfill");
      process.exit(1);
    }
    storage = await createPgStorage(url);
  } else {
    const { createSqliteStorage } =
      await import("../src/storage/sqlite/index.js");
    const path = process.env.SQLITE_PATH ?? "./data/myme.db";
    storage = createSqliteStorage(path);
  }
  const counts = await backfillEdges(storage);
  console.log(
    `backfill-edges: parent-of=${String(counts.parentOf)}  in-thread=${String(counts.inThread)}  about=${String(counts.about)}  skipped=${String(counts.skipped)}`,
  );
  await storage.close();
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("backfill-edges.ts") ||
    process.argv[1].endsWith("backfill-edges.js"))
) {
  mainCli().catch((err: unknown) => {
    console.error("backfill-edges failed:", err);
    process.exit(1);
  });
}

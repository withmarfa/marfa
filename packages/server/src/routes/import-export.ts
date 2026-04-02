import { Hono } from "hono";
import {
  ProtocolError,
  ErrorCode,
  isValidTypeIdentifier,
  ITEM_STATES,
} from "@myme/shared";
import type { ItemState } from "@myme/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin, requireAuth, getTypeFilter } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

const MAX_IMPORT_ITEMS = 5000;

export function importRoutes(storage: Storage): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post("/", async (c) => {
    requireAdmin(c);

    const body = await c.req.json();
    const items = body.items as unknown[] | undefined;
    if (!Array.isArray(items)) {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "items must be an array",
      );
    }
    if (items.length > MAX_IMPORT_ITEMS) {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_IMPORT_ITEMS)} items per import`,
      );
    }
    if (items.length === 0) {
      return c.json({ imported: 0, duplicates: 0 });
    }

    // Validate type identifiers
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Record<string, unknown>;
      if (!item.type || !isValidTypeIdentifier(item.type as string)) {
        throw new ProtocolError(
          ErrorCode.VALIDATION_ERROR,
          `Item at index ${String(i)}: invalid or missing type`,
        );
      }
    }

    let imported = 0;
    let duplicates = 0;

    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      try {
        await storage.items.create(
          {
            type: item.type as string,
            properties: (item.properties ?? {}) as Record<string, unknown>,
            source: item.source as string | undefined,
            source_id: item.source_id as string | undefined,
            tags: item.tags as string[] | undefined,
            about: item.about as string[] | undefined,
          },
          c.get("apiKey")?.tenant_id,
        );
        imported++;
      } catch (err) {
        if (
          err instanceof ProtocolError &&
          err.code === ErrorCode.DUPLICATE_SOURCE
        ) {
          duplicates++;
        } else {
          throw err;
        }
      }
    }

    return c.json({ imported, duplicates });
  });

  return router;
}

export function exportRoutes(storage: Storage): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get("/", async (c) => {
    requireAuth(c);

    const type = c.req.query("type");
    if (type && !isValidTypeIdentifier(type)) {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    const state = c.req.query("state") as ItemState | undefined;
    if (state && !(ITEM_STATES as readonly string[]).includes(state)) {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid state: ${state}`,
      );
    }

    // Export as NDJSON — one {item, metadata} per line, paginating internally
    const lines: string[] = [];
    let cursor: string | undefined;

    do {
      const result = await storage.items.list({
        tenantId: c.get("apiKey")?.tenant_id,
        type,
        state,
        allowed_types: getTypeFilter(c),
        limit: 200,
        cursor,
      });

      for (const item of result.data) {
        const metadata = await storage.metadata.get(item.id);
        lines.push(JSON.stringify({ item, metadata }));
      }

      cursor = result.has_more
        ? (result.cursor as string | undefined)
        : undefined;
    } while (cursor);

    return c.text(lines.join("\n") + "\n", 200, {
      "Content-Type": "application/x-ndjson",
    });
  });

  return router;
}

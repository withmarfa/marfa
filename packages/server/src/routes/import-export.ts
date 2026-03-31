import { Hono } from "hono";
import {
  ProtocolError,
  ErrorCode,
  isValidTypeIdentifier,
  validateProperties,
  ITEM_STATES,
} from "@myme/shared";
import type { CreateItemInput, ItemState } from "@myme/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { parseIntParam } from "./util.js";

const MAX_IMPORT_ITEMS = 5000;

export function importRoutes(storage: Storage): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post("/", async (c) => {
    requireAdmin(c);

    const body = (await c.req.json());
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

    // Validate all items before storing any
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Record<string, unknown>;
      if (!item.type || !isValidTypeIdentifier(item.type as string)) {
        throw new ProtocolError(
          ErrorCode.VALIDATION_ERROR,
          `Item at index ${String(i)}: invalid or missing type`,
        );
      }
      if (!item.properties || typeof item.properties !== "object") {
        throw new ProtocolError(
          ErrorCode.VALIDATION_ERROR,
          `Item at index ${String(i)}: properties is required`,
        );
      }
      const validation = validateProperties(
        item.type as string,
        item.properties as Record<string, unknown>,
      );
      if (!validation.success) {
        throw new ProtocolError(
          ErrorCode.VALIDATION_ERROR,
          `Item at index ${String(i)}: invalid properties`,
          { errors: validation.errors },
        );
      }
    }

    let imported = 0;
    let duplicates = 0;

    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      try {
        storage.items.create(item as unknown as CreateItemInput);
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

  router.get("/", (c) => {
    requireAdmin(c);

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

    const limit = parseIntParam(c.req.query("limit"), 100, 1, 5000);
    const cursor = c.req.query("cursor");

    const result = storage.items.list({
      type,
      state,
      limit,
      cursor,
    });

    // Enrich with metadata
    const data = result.data.map((item) => ({
      item,
      metadata: storage.metadata.get(item.id),
    }));

    return c.json({
      data,
      cursor: result.cursor,
      has_more: result.has_more,
    });
  });

  return router;
}

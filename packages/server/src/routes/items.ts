import { Hono } from "hono";
import {
  ProtocolError,
  ErrorCode,
  isValidId,
  isValidTimestamp,
  isValidTypeIdentifier,
  validateProperties,
  ITEM_STATES,
} from "@myme/shared";
import type { ItemState } from "@myme/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, requireTypeAccess, getTypeFilter } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { parseIntParam } from "./util.js";

export function itemRoutes(storage: Storage): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // POST /items — create
  router.post("/", async (c) => {
    const body = await c.req.json();

    const type = body.type as string | undefined;
    if (!type || !isValidTypeIdentifier(type)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Valid type identifier is required");
    }

    const properties = body.properties as Record<string, unknown> | undefined;
    if (!properties || typeof properties !== "object") {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "properties is required and must be an object",
      );
    }

    if (body.id && !isValidId(body.id as string)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }
    if (body.timestamp && !isValidTimestamp(body.timestamp as string)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid timestamp");
    }
    if (body.parent_id && !isValidId(body.parent_id as string)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid parent_id");
    }
    if (body.thread_id && !isValidId(body.thread_id as string)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid thread_id");
    }
    if (body.state && !(ITEM_STATES as readonly string[]).includes(body.state as string)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, `Invalid state: ${body.state as string}`);
    }

    requireTypeAccess(c, type, "write");

    const item = storage.items.create({
      type,
      properties,
      id: body.id as string | undefined,
      state: body.state as ItemState | undefined,
      timestamp: body.timestamp as string | undefined,
      source: body.source as string | undefined,
      source_id: body.source_id as string | undefined,
      origin: body.origin as string | undefined,
      device_id: body.device_id as string | undefined,
      parent_id: body.parent_id as string | undefined,
      thread_id: body.thread_id as string | undefined,
      capture_latitude: body.capture_latitude as number | undefined,
      capture_longitude: body.capture_longitude as number | undefined,
      tags: body.tags as string[] | undefined,
      about: body.about as string[] | undefined,
    });

    const metadata = storage.metadata.get(item.id);
    return c.json({ item, metadata }, 201);
  });

  // GET /items — list
  router.get("/", (c) => {
    requireAuth(c);

    const type = c.req.query("type");
    if (type && !isValidTypeIdentifier(type) && !type.endsWith(".*")) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid type identifier");
    }
    if (type) requireTypeAccess(c, type.replace(".*", ""), "read");

    const state = c.req.query("state") as ItemState | undefined;
    if (state && !(ITEM_STATES as readonly string[]).includes(state)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, `Invalid state: ${state}`);
    }

    // Fix 6: tags query param
    const tagsParam = c.req.query("tags");
    const tags = tagsParam ? tagsParam.split(",").map((t) => t.trim()) : undefined;

    const result = storage.items.list({
      type,
      state,
      source: c.req.query("source"),
      parent_id: c.req.query("parent_id"),
      thread_id: c.req.query("thread_id"),
      tags,
      allowed_types: getTypeFilter(c),
      sort:
        (c.req.query("sort") as "created_at" | "updated_at" | "timestamp" | undefined) ??
        undefined,
      direction: (c.req.query("direction") as "asc" | "desc" | undefined) ?? undefined,
      limit: parseIntParam(c.req.query("limit"), 50, 1, 200),
      cursor: c.req.query("cursor"),
    });

    return c.json(result);
  });

  // GET /items/:id — get single
  router.get("/:id", (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    const item = storage.items.get(id);
    if (!item) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "read");
    const metadata = storage.metadata.get(id);
    return c.json({ item, metadata });
  });

  // PATCH /items/:id — update with conflict detection
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    const body = await c.req.json();
    if (!body.properties || typeof body.properties !== "object") {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "properties is required and must be an object",
      );
    }
    // Fix 5: accept version >= 0 (0 means "never seen", still a conflict scenario)
    if (typeof body.version !== "number" || !Number.isInteger(body.version) || body.version < 0) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "version must be a non-negative integer");
    }

    const item = storage.items.get(id);
    if (!item) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

    const merged = { ...item.properties, ...(body.properties as Record<string, unknown>) };
    const validation = validateProperties(item.type, merged);
    if (!validation.success) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid properties", {
        errors: validation.errors,
      });
    }

    const result = storage.items.update(id, {
      properties: body.properties as Record<string, unknown>,
      version: body.version as number,
    });

    // Fix 1: wrap in { item, metadata }
    if ("error" in result) {
      return c.json(result, 409);
    }

    const metadata = storage.metadata.get(id);
    return c.json({ item: result, metadata });
  });

  // DELETE /items/:id — soft delete
  // Fix 1: return 200 { ok: true } instead of 204
  router.delete("/:id", (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    // Use list with state filter to find trashed items too
    // delete() uses getRaw internally
    requireAuth(c);
    storage.items.delete(id);
    return c.json({ ok: true });
  });

  // POST /items/:id/restore — Fix 1: wrap in { item, metadata }
  router.post("/:id/restore", (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    requireAuth(c);
    const restored = storage.items.restore(id);
    requireTypeAccess(c, restored.type, "write");
    const metadata = storage.metadata.get(id);
    return c.json({ item: restored, metadata });
  });

  // POST /items/:id/transition — Fix 1: wrap in { item, metadata }
  router.post("/:id/transition", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    const body = await c.req.json();
    const state = body.state as string | undefined;
    if (!state || !(ITEM_STATES as readonly string[]).includes(state)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, `Invalid state: ${String(state)}`);
    }

    requireAuth(c);
    const updated = storage.items.transition(id, state as ItemState);
    requireTypeAccess(c, updated.type, "write");
    const metadata = storage.metadata.get(id);
    return c.json({ item: updated, metadata });
  });

  // GET /items/:id/versions — Fix 1: wrap in { versions: [...] }
  router.get("/:id/versions", (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    const item = storage.items.get(id);
    if (!item) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "read");
    const versions = storage.versions.list(id);
    return c.json({ versions });
  });

  // --- Metadata sub-routes ---

  // GET /items/:id/metadata — Fix 1: wrap in { metadata: {...} }
  router.get("/:id/metadata", (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    const item = storage.items.get(id);
    if (!item) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "read");
    return c.json({ metadata: storage.metadata.get(id) });
  });

  // PUT /items/:id/metadata — full replacement. Fix 1: wrap in { metadata: {...} }
  router.put("/:id/metadata", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    const item = storage.items.get(id);
    if (!item) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

    const body = await c.req.json();
    const tags = (body.tags as string[] | undefined) ?? [];
    const about = (body.about as string[] | undefined) ?? [];

    const metadata = storage.metadata.set(id, tags, about);
    return c.json({ metadata });
  });

  // PATCH /items/:id/metadata — Fix 2: set-union merge
  router.patch("/:id/metadata", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    const item = storage.items.get(id);
    if (!item) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

    const body = await c.req.json();
    const tags = body.tags as string[] | undefined;
    const about = body.about as string[] | undefined;

    const metadata = storage.metadata.merge(id, tags, about);
    return c.json({ metadata });
  });

  // POST /items/:id/tags
  router.post("/:id/tags", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    const item = storage.items.get(id);
    if (!item) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

    const body = await c.req.json();
    const tags = body.tags as string[] | undefined;
    if (!Array.isArray(tags) || tags.length === 0) {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "tags must be a non-empty array of strings",
      );
    }

    const metadata = storage.metadata.addTags(id, tags);
    return c.json({ metadata });
  });

  // DELETE /items/:id/tags/:tag
  router.delete("/:id/tags/:tag", (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    const item = storage.items.get(id);
    if (!item) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");
    const tag = decodeURIComponent(c.req.param("tag"));
    const metadata = storage.metadata.removeTag(id, tag);
    return c.json({ metadata });
  });

  return router;
}
